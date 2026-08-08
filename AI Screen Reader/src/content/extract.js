/**
 * Content extraction: layered strategies, one Block[] contract.
 *
 * Pipeline, first match wins, recorded in Extraction.strategy:
 *   1. selection   — an explicit user selection beats every heuristic
 *   2. adapter:<n> — site-specific extractors from adapters.js
 *   3. readability — Mozilla Readability, the default for articles
 *   4. density     — density.js, for everything Readability cannot see
 *
 * The hard part is not getting text out, it is getting text out *and* keeping a
 * handle on the live DOM node it came from, so the player can highlight the
 * sentence it is speaking. That round trip works like this:
 *
 *   a. Walk the LIVE document and stamp every candidate element with a unique
 *      data-ral-uid, recording uid -> live Element in RAL.uidMap.
 *   b. Clone the document. Readability MUTATES whatever you hand it, so it only
 *      ever sees the clone. Attributes survive cloneNode and serialization, so
 *      the uids ride along for free.
 *   c. Readability hands back .content as an HTML *string*. Parse it, read
 *      data-ral-uid off each element, and look the live node back up.
 *
 * Classic content script: no import/export, everything hangs off window.RAL.
 * Injection order is Readability.js, density.js, adapters.js, extract.js,
 * content.js, so anything defined later is only ever touched at call time.
 */

(function () {
  'use strict';

  var RAL = (window.RAL = window.RAL || {});

  /**
   * Mirrored from src/lib/protocol.js. That file is an ES module and this is a
   * classic script, so the values are duplicated rather than imported — keep
   * them in sync with BlockKind / HIGHLIGHT_ATTR there.
   */
  var BlockKind = {
    HEADING: 'heading',
    PARAGRAPH: 'paragraph',
    LIST_ITEM: 'list-item',
    QUOTE: 'quote',
    FIGURE: 'figure',
    CODE: 'code',
    TABLE: 'table',
    MATH: 'math',
  };

  var UID_ATTR = 'data-ral-uid';
  var HIDDEN_ATTR = 'data-ral-hidden';

  /** Below this many characters a strategy is treated as having failed. */
  var MIN_CHARS = 250;
  /** Shortest text we will accept from an unsemantic container. */
  var MIN_LOOSE_TEXT = 12;
  /** Selection shorter than this is almost always an accidental drag. */
  var MIN_SELECTION = 20;
  /** Pathological pages (editors, dashboards) can have 100k+ elements. */
  var MAX_STAMPS = 20000;

  RAL.BlockKind = BlockKind;
  RAL.UID_ATTR = UID_ATTR;
  RAL.HIDDEN_ATTR = HIDDEN_ATTR;
  /** uid -> live Element. Read by content.js to place the highlight. */
  RAL.uidMap = RAL.uidMap || new Map();

  var uidSeq = 0;

  /* ------------------------------------------------------------------ utils */

  function collapse(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  /**
   * Code keeps its line structure — indentation is meaning, and the speech
   * layer decides separately whether to read it at all. Only trailing spaces
   * and runs of blank lines go.
   */
  function cleanCode(text) {
    var lines = text.replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var blanks = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/[ \t]+$/, '');
      if (!line.trim()) {
        if (++blanks > 1 || !out.length) continue;
        out.push('');
      } else {
        blanks = 0;
        out.push(line);
      }
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join('\n');
  }

  function attr(el, name) {
    return (el.getAttribute && el.getAttribute(name)) || '';
  }

  function tagOf(el) {
    return el.tagName ? el.tagName.toUpperCase() : '';
  }

  /**
   * Document-order depth-first walk with subtree pruning. visit() returning
   * false skips the whole subtree, which is what makes "stop at hidden" and
   * "stop at an emitted block" cheap.
   */
  function walk(root, visit) {
    var stack = [root];
    while (stack.length) {
      var el = stack.pop();
      if (visit(el) === false) continue;
      var kids = el.children;
      // Reversed so pop() yields document order.
      for (var i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }

  /* --------------------------------------------------- the computed-style trap */

  /**
   * Only the LIVE document has styles. A cloned document is never rendered, so
   * getComputedStyle on it returns nothing useful and every display:none menu
   * would sail straight through into the audio. Readability does not save us
   * either: its own visibility check reads inline style attributes only, so
   * class-driven `display:none` survives it.
   *
   * The fix is to decide visibility here, on the live nodes, and then persist
   * the verdict as an ATTRIBUTE so it survives cloneNode + serialize + reparse:
   *   - visible candidates get data-ral-uid (and land in RAL.uidMap)
   *   - hidden subtree ROOTS get data-ral-hidden and are never descended into
   * Downstream code on the clone reads attributes and never asks for styles.
   */
  function isHiddenLive(el, cs) {
    if (attr(el, 'aria-hidden') === 'true') return true;
    if (el.hasAttribute('hidden')) return true;
    if (!cs) return false;
    if (cs.display === 'none') return true;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
    // The two standard screen-reader-only recipes. Deliberately NOT testing
    // opacity: fade-in-on-scroll starts every paragraph of a modern article at
    // opacity 0, and treating that as hidden empties the page.
    if (cs.position === 'absolute' || cs.position === 'fixed') {
      if (cs.clip === 'rect(0px, 0px, 0px, 0px)') return true;
      if (cs.clipPath === 'inset(50%)' || cs.clipPath === 'inset(100%)') return true;
    }
    return false;
  }

  /** Elements worth a uid: every plausible block, plus containers as anchors. */
  var STAMP_TAGS = {
    P: 1, LI: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    BLOCKQUOTE: 1, PRE: 1, CODE: 1, FIGURE: 1, FIGCAPTION: 1, TABLE: 1,
    DL: 1, DD: 1, DT: 1, UL: 1, OL: 1, MATH: 1, IMG: 1,
    DIV: 1, SECTION: 1, ARTICLE: 1, MAIN: 1, ASIDE: 1, NAV: 1,
    HEADER: 1, FOOTER: 1, DETAILS: 1, SUMMARY: 1, ADDRESS: 1,
  };

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, IFRAME: 1,
    CANVAS: 1, VIDEO: 1, AUDIO: 1, OBJECT: 1, EMBED: 1, MAP: 1, AREA: 1,
    BUTTON: 1, SELECT: 1, TEXTAREA: 1, INPUT: 1, OPTION: 1, DATALIST: 1,
    LINK: 1, META: 1, HEAD: 1,
  };

  function looksMathy(el) {
    var cls = typeof el.className === 'string' ? el.className : '';
    return /(^|\s)(katex|katex-display|MathJax|MathJax_Display|mjx-container|math-inline|math-display)(\s|$)/i.test(cls);
  }

  /** Strip every mark from a previous run so uids never collide across extractions. */
  RAL.resetUids = function () {
    var stale = document.querySelectorAll('[' + UID_ATTR + '],[' + HIDDEN_ATTR + ']');
    for (var i = 0; i < stale.length; i++) {
      stale[i].removeAttribute(UID_ATTR);
      stale[i].removeAttribute(HIDDEN_ATTR);
    }
    RAL.uidMap = new Map();
    uidSeq = 0;
  };

  /**
   * Stamp the live document. Split into a read pass and a write pass on
   * purpose: getComputedStyle flushes pending layout, so interleaving it with
   * setAttribute risks a reflow per element on pages whose CSS happens to key
   * off data attributes. Reads first, writes second, one layout at most.
   *
   * @returns {number} how many elements were stamped.
   */
  RAL.stampDocument = function () {
    var root = document.body || document.documentElement;
    if (!root) return 0;

    var view = document.defaultView || window;
    var toStamp = [];
    var toHide = [];

    walk(root, function (el) {
      var tag = tagOf(el);
      if (SKIP_TAGS[tag]) return false;
      var cs = null;
      try { cs = view.getComputedStyle(el); } catch (e) { cs = null; }
      if (isHiddenLive(el, cs)) {
        toHide.push(el);
        return false; // never descend into hidden content
      }
      if (STAMP_TAGS[tag] || looksMathy(el)) {
        if (tag !== 'IMG' || attr(el, 'alt').trim().length >= 3) {
          if (toStamp.length < MAX_STAMPS) toStamp.push(el);
        }
      }
      return true;
    });

    for (var h = 0; h < toHide.length; h++) toHide[h].setAttribute(HIDDEN_ATTR, '1');
    for (var i = 0; i < toStamp.length; i++) {
      var uid = 'u' + ++uidSeq;
      toStamp[i].setAttribute(UID_ATTR, uid);
      RAL.uidMap.set(uid, toStamp[i]);
    }
    return toStamp.length;
  };

  /** Stamp one live element that the sweep missed (adapters can reach anywhere). */
  function stampOne(el) {
    if (!el || el.nodeType !== 1) return null;
    var existing = attr(el, UID_ATTR);
    if (existing && RAL.uidMap.has(existing)) return existing;
    if (RAL.uidMap.size >= MAX_STAMPS) return null;
    var uid = 'u' + ++uidSeq;
    el.setAttribute(UID_ATTR, uid);
    RAL.uidMap.set(uid, el);
    return uid;
  }

  /* ------------------------------------------------------------------- text */

  /**
   * Skip selectors currently in force, set by blocksFrom for the duration of one
   * walk. Text collection has to honour them too, not just block selection:
   * adapters aim entries like `.mw-editsection` and `sup.reference` at inline
   * nodes INSIDE a heading or paragraph, and those blocks are emitted whole, so
   * filtering only at block level would still read "[edit]" out loud.
   */
  var activeSkip = '';

  function skippableForText(el) {
    if (SKIP_TAGS[tagOf(el)]) return true;
    if (el.hasAttribute(HIDDEN_ATTR)) return true;
    if (el.hasAttribute('hidden')) return true;
    if (activeSkip) {
      try {
        if (el.matches(activeSkip)) return true;
      } catch (e) {
        /* unusable selector list; keep the node */
      }
    }
    // KaTeX and MathJax mark their visual rendering aria-hidden and keep an
    // accessible MathML twin; honouring the flag is what stops formulas from
    // being read twice.
    if (attr(el, 'aria-hidden') === 'true') return true;
    var style = attr(el, 'style');
    if (style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
    return false;
  }

  var INLINE_TAGS = {
    A: 1, ABBR: 1, B: 1, BDI: 1, BDO: 1, CITE: 1, CODE: 1, DATA: 1, DEL: 1,
    DFN: 1, EM: 1, I: 1, INS: 1, KBD: 1, MARK: 1, Q: 1, RUBY: 1, RT: 1, RP: 1,
    S: 1, SAMP: 1, SMALL: 1, SPAN: 1, STRONG: 1, SUB: 1, SUP: 1, TIME: 1,
    U: 1, VAR: 1, WBR: 1, FONT: 1, NOBR: 1, BIG: 1, TT: 1,
  };

  function collectText(node, out) {
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3) { out.push(n.nodeValue); continue; }
      if (n.nodeType !== 1) continue;
      if (skippableForText(n)) continue;
      var tag = tagOf(n);
      if (tag === 'BR') { out.push('\n'); continue; }
      // Block-level children need a separator or "</div><div>" fuses two words.
      // Inline elements must NOT get one: "<b>anti</b>pattern" is one word.
      var block = !INLINE_TAGS[tag];
      if (block) out.push('\n');
      collectText(n, out);
      if (block) out.push('\n');
    }
  }

  /**
   * Plain text for one element. Square brackets and abbreviations are left
   * exactly as written — the speech normalizer in lib/speechify.js owns those,
   * and doing it twice mangles real prose.
   */
  RAL.textOf = function (el, preserveNewlines) {
    if (!el) return '';
    var out = [];
    collectText(el, out);
    var raw = out.join('');
    return preserveNewlines ? cleanCode(raw) : collapse(raw);
  };

  /* --------------------------------------------------------- classification */

  var HEADINGS = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };

  /** Emitted as one unit; we never descend past these. */
  var TERMINAL_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,code,figure,figcaption,table,dd,dt,math,img[alt]';

  /**
   * Unsemantic containers that may still hold bare text of their own. Inline
   * elements are deliberately absent: treating a <span> as a container splits
   * "Text <span>more</span>" into fragments mid-sentence.
   */
  var LOOSE_CONTAINERS = {
    DIV: 1, SECTION: 1, ARTICLE: 1, MAIN: 1, ASIDE: 1, HEADER: 1, FOOTER: 1,
    NAV: 1, TD: 1, TH: 1, DETAILS: 1, SUMMARY: 1, ADDRESS: 1, CENTER: 1,
  };

  var LOOSE_SELECTOR = 'div,section,article,main,aside,header,footer,nav,td,th,details,summary,address,center';

  /**
   * Does anything further down hold text of its own? App-shaped pages nest
   * paragraph-per-div several levels deep, and emitting at the first container
   * without a <p> in it would fuse the entire article into one block. Emit at
   * the INNERMOST container instead.
   */
  function hasTextBearingContainer(el) {
    var kids = el.querySelectorAll(LOOSE_SELECTOR);
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].hasAttribute(HIDDEN_ATTR)) continue;
      var t = kids[i].textContent;
      if (t && collapse(t).length >= MIN_LOOSE_TEXT) return true;
    }
    return false;
  }

  /** Page furniture. Skipped unless the element IS the container we chose. */
  var CHROME_TAGS = { NAV: 1, HEADER: 1, FOOTER: 1, ASIDE: 1 };
  var CHROME_ROLES = {
    navigation: 1, banner: 1, contentinfo: 1, complementary: 1, search: 1,
  };

  function isChrome(el) {
    if (CHROME_TAGS[tagOf(el)]) return true;
    var role = attr(el, 'role').toLowerCase();
    return !!CHROME_ROLES[role];
  }

  /** True when el sits inside page furniture that is not the chosen container. */
  function insideChrome(el, container) {
    var node = el;
    while (node && node !== container) {
      if (isChrome(node)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function mathText(el) {
    // Preference order: TeX annotation, alttext, MathML twin, rendered glyphs.
    var ann = el.querySelector('annotation, annotation-xml');
    if (ann) {
      var t = collapse(ann.textContent);
      if (t) return t;
    }
    var alt = attr(el, 'alttext') || attr(el, 'aria-label') || attr(el, 'title');
    if (collapse(alt)) return collapse(alt);
    var mml = el.querySelector('.katex-mathml, mjx-assistive-mml, math');
    if (mml) {
      var m = collapse(mml.textContent);
      if (m) return m;
    }
    return RAL.textOf(el, false);
  }

  function figureText(el) {
    var cap = el.querySelector && el.querySelector('figcaption');
    if (cap) {
      var t = RAL.textOf(cap, false);
      if (t) return t;
    }
    var img = tagOf(el) === 'IMG' ? el : (el.querySelector && el.querySelector('img[alt]'));
    if (img) {
      var alt = collapse(attr(img, 'alt'));
      if (alt.length >= 3) return alt;
    }
    return RAL.textOf(el, false);
  }

  function tableParts(el) {
    var rows = el.querySelectorAll ? el.querySelectorAll('tr') : [];
    var lines = [];
    var cols = 0;
    for (var r = 0; r < rows.length; r++) {
      if (skippableForText(rows[r])) continue;
      var cells = rows[r].querySelectorAll('th,td');
      var texts = [];
      for (var c = 0; c < cells.length; c++) {
        if (skippableForText(cells[c])) continue;
        var t = RAL.textOf(cells[c], false);
        if (t) texts.push(t);
      }
      if (cells.length > cols) cols = cells.length;
      if (texts.length) lines.push(texts.join(', '));
    }
    return { text: lines.join('. '), rows: lines.length, cols: cols };
  }

  /**
   * @returns {?object} {kind, level, text, meta} or null when el is not a block.
   */
  function describe(el) {
    var tag = tagOf(el);

    if (tag === 'MATH' || looksMathy(el)) {
      return { kind: BlockKind.MATH, level: null, text: mathText(el), meta: null };
    }

    if (HEADINGS[tag]) {
      return {
        kind: BlockKind.HEADING,
        level: HEADINGS[tag],
        text: RAL.textOf(el, false),
        meta: null,
      };
    }

    if (attr(el, 'role') === 'heading') {
      var lvl = parseInt(attr(el, 'aria-level'), 10);
      return {
        kind: BlockKind.HEADING,
        level: lvl >= 1 && lvl <= 6 ? lvl : 2,
        text: RAL.textOf(el, false),
        meta: null,
      };
    }

    if (tag === 'PRE' || tag === 'CODE') {
      var code = RAL.textOf(el, true);
      return {
        kind: BlockKind.CODE,
        level: null,
        text: code,
        meta: { lines: code ? code.split('\n').length : 0 },
      };
    }

    if (tag === 'TABLE') {
      var t = tableParts(el);
      return {
        kind: BlockKind.TABLE,
        level: null,
        text: t.text,
        meta: { rows: t.rows, cols: t.cols },
      };
    }

    if (tag === 'FIGURE' || tag === 'FIGCAPTION' || tag === 'IMG') {
      return { kind: BlockKind.FIGURE, level: null, text: figureText(el), meta: null };
    }

    if (tag === 'BLOCKQUOTE') {
      return { kind: BlockKind.QUOTE, level: null, text: RAL.textOf(el, false), meta: null };
    }

    if (tag === 'LI' || tag === 'DD' || tag === 'DT') {
      return { kind: BlockKind.LIST_ITEM, level: null, text: RAL.textOf(el, false), meta: null };
    }

    if (tag === 'P') {
      return { kind: BlockKind.PARAGRAPH, level: null, text: RAL.textOf(el, false), meta: null };
    }

    return null;
  }

  /* ------------------------------------------------------------ blocksFrom */

  /**
   * Resolve the live-DOM anchor for an element in the extracted tree.
   *
   * Readability's _simplifyNestedElements copies a wrapper's attributes onto its
   * only child, so one uid can legitimately appear on two nested elements. The
   * first block to claim a uid keeps it; a later block resolving to the same uid
   * gets null rather than making two different sentences highlight the same
   * node. `anchored` reports whether any uid was found at all, which is how the
   * caller tells "Readability synthesized this" apart from "this came out of a
   * hidden subtree that was never stamped".
   */
  function resolveUid(el, live, claimed) {
    var node = el;
    var depth = 0;
    var anchored = false;
    while (node && node.nodeType === 1 && depth++ < 8) {
      var uid = attr(node, UID_ATTR);
      if (uid) {
        anchored = true;
        if (RAL.uidMap.has(uid)) {
          if (claimed[uid]) return { uid: null, anchored: true };
          claimed[uid] = 1;
          return { uid: uid, anchored: true };
        }
      }
      node = node.parentElement;
    }
    if (live && el.isConnected) {
      var fresh = stampOne(el);
      if (fresh) { claimed[fresh] = 1; return { uid: fresh, anchored: true }; }
    }
    return { uid: null, anchored: anchored };
  }

  /**
   * Turn a subtree into Blocks. Shared by every strategy, including adapters, so
   * that adapter output obeys exactly the same skip, dedupe and whitespace rules
   * as everything else.
   *
   * @param {Element|Document|DocumentFragment} root
   * @param {object} [opts]
   * @param {Element} [opts.container]     Root that is allowed to be nav/header/footer/aside.
   * @param {boolean} [opts.live]          Force live/clone mode; inferred otherwise.
   * @param {boolean} [opts.requireAnchor] Drop blocks with no uid ancestor (Readability path).
   * @param {string[]} [opts.skip]         CSS selectors; an element matching one, or
   *                                       descending from one, is dropped. Adapters use
   *                                       this for per-site furniture (edit links, vote
   *                                       counts, share widgets).
   * @returns {object[]} Blocks, ids assigned from b0.
   */
  RAL.blocksFrom = function (root, opts) {
    opts = opts || {};
    if (!root) return [];

    if (root.nodeType === 9) root = root.body || root.documentElement;
    if (root && root.nodeType === 11) {
      var host = document.createElement('div');
      host.appendChild(root);
      root = host;
    }
    if (!root || root.nodeType !== 1) return [];

    var live = typeof opts.live === 'boolean'
      ? opts.live
      : root.ownerDocument === document && root.isConnected;
    var container = opts.container || root;

    // Only enforce the anchor rule if the uid round trip actually worked. If
    // Readability handed back a tree with no uids at all, reading it without
    // highlighting beats reading nothing.
    var requireAnchor = !!opts.requireAnchor && !!root.querySelector('[' + UID_ATTR + ']');

    var skipSelector = opts.skip && opts.skip.length ? opts.skip.join(',') : '';

    /**
     * A match ABOVE the container is ignored on purpose: the caller picked this
     * root deliberately, and honouring an ancestor match there would empty the
     * result instead of trimming furniture out of it.
     */
    function skipped(el) {
      if (!skipSelector) return false;
      try {
        var hit = el.closest(skipSelector);
        return !!hit && (hit === el || container.contains(hit));
      } catch (e) {
        return false; // unusable selector list; keep the node
      }
    }

    var blocks = [];
    var claimed = {};

    function push(desc, el) {
      var text = desc.kind === BlockKind.CODE ? desc.text : collapse(desc.text || '');
      if (!text || !text.trim()) return;

      var anchor = resolveUid(el, live, claimed);
      // A block with no uid anywhere above it, on a page where the round trip
      // otherwise worked, came from a subtree the live walk marked hidden.
      if (requireAnchor && !anchor.anchored) return;

      var level = desc.level == null ? null : desc.level;
      // Readability rewrites every in-article <h1> to <h2> (Readability.js:712)
      // on the assumption the h1 is chrome shown elsewhere. That flattens the
      // outline and mislabels the real headline, so when the uid round trip gave
      // us the live element, its tag — not the clone's — is the authority.
      if (desc.kind === BlockKind.HEADING && anchor.uid) {
        var liveEl = RAL.uidMap.get(anchor.uid);
        var liveLevel = liveEl ? HEADINGS[tagOf(liveEl)] : 0;
        if (liveLevel) level = liveLevel;
      }

      var block = {
        id: 'b' + blocks.length,
        kind: desc.kind,
        level: level,
        text: text,
        uid: anchor.uid,
        meta: desc.meta || null,
      };

      // Nested containers routinely restate their child's text. Keep the longer
      // of the two rather than reading the same sentence twice.
      var prev = blocks.length ? blocks[blocks.length - 1] : null;
      if (prev) {
        if (prev.text.indexOf(text) !== -1) return;
        if (text.indexOf(prev.text) !== -1) {
          block.id = prev.id;
          blocks[blocks.length - 1] = block;
          return;
        }
      }
      blocks.push(block);
    }

    function visit(el) {
      var tag = tagOf(el);
      if (SKIP_TAGS[tag]) return false;
      if (el.hasAttribute(HIDDEN_ATTR)) return false;
      if (attr(el, 'aria-hidden') === 'true') return false;
      if (el.hasAttribute('hidden')) return false;
      var style = attr(el, 'style');
      if (style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return false;
      if (el !== container && insideChrome(el, container)) return false;
      if (el !== container && skipped(el)) return false;

      var desc = describe(el);
      if (desc) {
        // A single-cell table is layout, not data — read its contents normally.
        if (desc.kind === BlockKind.TABLE && desc.meta.rows <= 1 && desc.meta.cols <= 1) return true;
        if (tag === 'IMG' && collapse(attr(el, 'alt')).length < 3) return false;
        push(desc, el);
        return false; // a block is one unit; do not also emit its children
      }

      // Bare text in an unsemantic container: extremely common in app-rendered
      // pages and in the density fallback. Only fires at the innermost such
      // container, so a wrapper does not swallow the whole article into one
      // block and nothing gets emitted twice.
      if (LOOSE_CONTAINERS[tag] &&
          !el.querySelector(TERMINAL_SELECTOR) &&
          !hasTextBearingContainer(el)) {
        var loose = RAL.textOf(el, false);
        if (loose.length >= MIN_LOOSE_TEXT && loose.split(/\s+/).length >= 2) {
          push({ kind: BlockKind.PARAGRAPH, level: null, text: loose, meta: null }, el);
          return false;
        }
      }
      return true;
    }

    var previousSkip = activeSkip;
    activeSkip = skipSelector;
    try {
      walk(root, visit);
    } finally {
      activeSkip = previousSkip;
    }
    return blocks;
  };

  /** Renumber ids so concatenated sources stay unique and sequential. */
  function renumber(blocks) {
    for (var i = 0; i < blocks.length; i++) blocks[i].id = 'b' + i;
    return blocks;
  }

  /**
   * Defensive normalization for blocks that did not come from blocksFrom —
   * adapters.js is written by another module and may hand back partial shapes.
   */
  function normalize(blocks) {
    var out = [];
    if (!blocks || !blocks.length) return out;
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (!b || typeof b.text !== 'string') continue;
      var kind = b.kind;
      var known = false;
      for (var k in BlockKind) if (BlockKind[k] === kind) known = true;
      if (!known) kind = BlockKind.PARAGRAPH;
      var text = kind === BlockKind.CODE ? cleanCode(b.text) : collapse(b.text);
      if (!text) continue;
      var prev = out.length ? out[out.length - 1] : null;
      if (prev) {
        if (prev.text.indexOf(text) !== -1) continue;
        if (text.indexOf(prev.text) !== -1) out.pop();
      }
      out.push({
        id: 'b' + out.length,
        kind: kind,
        level: typeof b.level === 'number' ? b.level : null,
        text: text,
        uid: typeof b.uid === 'string' && RAL.uidMap.has(b.uid) ? b.uid : null,
        meta: b.meta && typeof b.meta === 'object' ? b.meta : null,
      });
    }
    return renumber(out);
  }

  function charCount(blocks) {
    var n = 0;
    for (var i = 0; i < blocks.length; i++) n += blocks[i].text.length;
    return n;
  }

  /* ------------------------------------------------------- readerable check */

  var UNLIKELY = /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i;
  var MAYBE = /and|article|body|column|content|main|shadow/i;

  /**
   * Readability-readerable.js was not vendored, so this is our own version of
   * the same idea: sum sqrt(textLength - 140) over plausible prose nodes and see
   * whether the page clears a threshold. Used only to skip the expensive
   * document clone on pages that obviously are not articles — the density
   * fallback still runs, so a false negative costs quality, never content.
   *
   * @param {Document} doc
   * @returns {boolean}
   */
  RAL.isProbablyReaderable = function (doc) {
    var d = doc || document;
    var nodes;
    try {
      nodes = d.querySelectorAll('p, pre, article, div > br');
    } catch (e) {
      return true; // cannot tell; let Readability decide
    }

    var score = 0;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.tagName === 'BR') node = node.parentNode;
      if (!node || node.nodeType !== 1) continue;
      if (node.hasAttribute(HIDDEN_ATTR)) continue;
      if (attr(node, 'aria-hidden') === 'true') continue;

      var matchString = (typeof node.className === 'string' ? node.className : '') + ' ' + (node.id || '');
      if (UNLIKELY.test(matchString) && !MAYBE.test(matchString)) continue;
      if (node.matches && node.matches('li p')) continue;

      var len = node.textContent.trim().length;
      if (len < 140) continue;

      score += Math.sqrt(len - 140);
      if (score > 20) return true;
    }
    return false;
  };

  /* ------------------------------------------------------------- strategies */

  function metaContent(selector) {
    var el = document.querySelector(selector);
    return el ? collapse(attr(el, 'content')) : '';
  }

  function pageTitle() {
    return (
      metaContent('meta[property="og:title"]') ||
      metaContent('meta[name="twitter:title"]') ||
      collapse(document.title) ||
      (function () {
        var h1 = document.querySelector('h1');
        return h1 ? RAL.textOf(h1, false) : '';
      })() ||
      location.hostname
    );
  }

  function pageByline() {
    return (
      metaContent('meta[name="author"]') ||
      metaContent('meta[property="article:author"]') ||
      (function () {
        var el = document.querySelector('[rel="author"], .byline, .author-name, [itemprop="author"]');
        var t = el ? RAL.textOf(el, false) : '';
        return t.length <= 120 ? t : '';
      })() ||
      null
    );
  }

  function pageSiteName() {
    return metaContent('meta[property="og:site_name"]') || location.hostname || null;
  }

  /** 1. An explicit selection is an explicit instruction; no heuristic beats it. */
  function fromSelection() {
    var sel;
    try { sel = window.getSelection(); } catch (e) { return null; }
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    var raw = sel.toString();
    if (collapse(raw).length <= MIN_SELECTION) return null;

    var range = sel.getRangeAt(0);
    var host = document.createElement('div');
    try {
      // cloneContents keeps attributes, so uids stamped moments ago come along
      // and a selection spanning whole paragraphs still highlights per block.
      host.appendChild(range.cloneContents());
    } catch (e) {
      host = null;
    }

    var blocks = host ? RAL.blocksFrom(host, { live: false, container: host }) : [];

    if (!blocks.length) {
      // Selection inside a single paragraph: cloneContents yields bare text
      // nodes, so fall back to the flat string anchored at the common ancestor.
      var anchorEl = range.commonAncestorContainer;
      if (anchorEl && anchorEl.nodeType !== 1) anchorEl = anchorEl.parentElement;
      var uid = null;
      while (anchorEl && anchorEl.nodeType === 1) {
        var candidate = attr(anchorEl, UID_ATTR);
        if (candidate && RAL.uidMap.has(candidate)) { uid = candidate; break; }
        anchorEl = anchorEl.parentElement;
      }
      blocks = [{
        id: 'b0',
        kind: BlockKind.PARAGRAPH,
        level: null,
        text: collapse(raw),
        uid: uid,
        meta: null,
      }];
    }

    return {
      strategy: 'selection',
      blocks: renumber(blocks),
      title: pageTitle(),
      byline: pageByline(),
      siteName: pageSiteName(),
      langHint: null,
    };
  }

  /**
   * 2. Site adapters. A null return falls through to the next adapter.
   *
   * The url argument is a URL OBJECT, not a string: every adapter reaches for
   * url.hostname / url.pathname, so a bare href would make every match() return
   * false and silently disable the whole layer. `location` is the fallback
   * because it exposes the same two properties.
   */
  function fromAdapters() {
    var list = RAL.adapters;
    if (!list || typeof list.length !== 'number' || !list.length) return null;

    var url;
    try { url = new URL(location.href); } catch (e) { url = location; }

    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a || typeof a.match !== 'function' || typeof a.extract !== 'function') continue;

      var matched = false;
      try { matched = !!a.match(url, document); } catch (e) { matched = false; }
      if (!matched) continue;

      var blocks = null;
      try { blocks = a.extract(document, url); } catch (e) { blocks = null; }
      blocks = normalize(blocks);
      if (!blocks.length) continue;

      return {
        strategy: 'adapter:' + (a.name || 'unnamed'),
        blocks: blocks,
        title: pageTitle(),
        byline: pageByline(),
        siteName: pageSiteName(),
        langHint: null,
      };
    }
    return null;
  }

  /** 3. Readability, on a clone, with the uid round trip. */
  function fromReadability() {
    if (typeof window.Readability !== 'function') return null;
    if (!RAL.isProbablyReaderable(document)) return null;

    var clone;
    try {
      // Readability mutates the document it is given — it strips nodes, rewrites
      // tags and deletes attributes. Handing it the live page would gut it.
      clone = document.cloneNode(true);
    } catch (e) {
      return null;
    }
    if (!clone || !clone.documentElement || !clone.firstChild) return null;

    var article = null;
    try {
      article = new window.Readability(clone, {
        charThreshold: MIN_CHARS,
        // Classes must survive: .katex / .MathJax / mjx-container are how MATH
        // blocks are recognised, and Readability strips class by default.
        keepClasses: true,
      }).parse();
    } catch (e) {
      article = null;
    }
    if (!article || !article.content) return null;

    var parsed;
    try {
      parsed = new DOMParser().parseFromString(article.content, 'text/html');
    } catch (e) {
      return null;
    }
    if (!parsed || !parsed.body) return null;

    var blocks = RAL.blocksFrom(parsed.body, {
      live: false,
      container: parsed.body,
      requireAnchor: true,
    });
    if (!blocks.length) return null;

    return {
      strategy: 'readability',
      blocks: renumber(blocks),
      title: collapse(article.title || '') || pageTitle(),
      byline: collapse(article.byline || '') || pageByline(),
      siteName: collapse(article.siteName || '') || pageSiteName(),
      langHint: collapse(article.lang || '') || null,
    };
  }

  /** 4. Density fallback, straight off the live document. */
  function fromDensity() {
    if (typeof RAL.densityExtract !== 'function') return null;
    var blocks;
    try {
      blocks = RAL.densityExtract(document);
    } catch (e) {
      blocks = null;
    }
    blocks = normalize(blocks);
    if (!blocks.length) return null;

    return {
      strategy: 'density',
      blocks: blocks,
      title: pageTitle(),
      byline: pageByline(),
      siteName: pageSiteName(),
      langHint: null,
    };
  }

  /* --------------------------------------------------------------- pipeline */

  /**
   * Run the pipeline.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.selectionOnly] Read the selection or fail; no fallback.
   * @returns {object} Partial Extraction: content.js adds lang, url and wordCount.
   */
  RAL.extract = function (opts) {
    opts = opts || {};

    if (!document.body) {
      return fail('This page has no content to read yet. Try again once it finishes loading.');
    }

    // Fresh uids every run: stale attributes from a previous extraction would
    // let an old uid resolve to a node that is no longer part of the article.
    RAL.resetUids();
    RAL.stampDocument();
    RAL.adapterNote = null;

    var selection = fromSelection();
    if (selection) return ok(selection);
    if (opts.selectionOnly) {
      return fail('Select the text you want read first, then try again.');
    }

    var adapted = fromAdapters();
    if (adapted) return ok(adapted);

    var readability = fromReadability();
    if (readability && charCount(readability.blocks) >= MIN_CHARS) return ok(readability);

    var density = fromDensity();
    if (density && charCount(density.blocks) >= MIN_CHARS) return ok(density);

    // Both layers came up short. Read whichever found more rather than nothing:
    // short pages (a changelog entry, a single note) are legitimately this small.
    var best = null;
    if (readability && density) {
      best = charCount(readability.blocks) >= charCount(density.blocks) ? readability : density;
    } else {
      best = readability || density;
    }
    if (best && best.blocks.length) return ok(best);

    // An adapter that matched but could not reach the text knows exactly why —
    // canvas-rendered docs, the built-in PDF viewer — so prefer its explanation.
    return fail(
      collapse(RAL.adapterNote || '') ||
      'Nothing readable found on this page. Try selecting the text you want read.'
    );
  };

  function ok(result) {
    return {
      ok: true,
      title: result.title || location.hostname,
      byline: result.byline || null,
      siteName: result.siteName || null,
      strategy: result.strategy,
      blocks: result.blocks,
      langHint: result.langHint || null,
      reason: null,
    };
  }

  function fail(reason) {
    return {
      ok: false,
      title: (document.title && collapse(document.title)) || location.hostname,
      byline: null,
      siteName: location.hostname,
      strategy: 'none',
      blocks: [],
      langHint: null,
      reason: reason,
    };
  }
})();
