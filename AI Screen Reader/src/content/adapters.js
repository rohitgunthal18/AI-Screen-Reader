/**
 * Site-specific content adapters — layer 1 of extraction.
 *
 * Hand-tuned readers for sites where the generic Readability pass produces
 * the wrong thing: navboxes narrated as link soup, a source file read as
 * prose, an answer thread with vote counts spliced between sentences.
 * Everything here degrades on purpose. An adapter that cannot find what it
 * expects returns null, and the pipeline falls through to Readability and
 * then to the density heuristic.
 *
 * Loaded as a CLASSIC content script (no modules), in this order:
 *   Readability.js -> density.js -> adapters.js -> extract.js -> content.js
 * so window.RAL.blocksFrom() does not exist yet while this file evaluates.
 * Every call to it is therefore made lazily, inside extract().
 *
 * adapterNote convention
 * ----------------------
 * extract() may only answer Block[] or null, which makes "there is genuinely
 * no text on this page" indistinguishable from "my selectors went stale" —
 * either way the user gets silence. So when an adapter knows *why* a page is
 * unreadable (a canvas-rendered Google Doc, Chrome's PDF plugin), it writes a
 * plain sentence to window.RAL.adapterNote and returns null. The caller
 * surfaces that as Extraction.reason. Adapters clear the note whenever they
 * succeed, so an explanation never outlives the page it describes.
 */
(function () {
  'use strict';

  window.RAL = window.RAL || {};
  if (window.RAL.adapterNote === undefined) window.RAL.adapterNote = null;

  /**
   * Mirrors BlockKind in src/lib/protocol.js. Duplicated rather than imported
   * because content scripts here are classic scripts; keep the two in sync.
   */
  var K = {
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

  // ---------------------------------------------------------------- helpers

  /** True when hostname is `domain` or any subdomain of it. */
  function hostMatches(url, domains) {
    var h = ((url && url.hostname) || '').toLowerCase().replace(/^www\./, '');
    if (!h) return false;
    for (var i = 0; i < domains.length; i++) {
      if (h === domains[i] || h.endsWith('.' + domains[i])) return true;
    }
    return false;
  }

  function collapse(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  /** Code keeps its line structure; only trailing junk goes. */
  function codeText(el) {
    var raw = el && el.value != null ? el.value : (el && el.textContent) || '';
    return raw.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function uidOf(el) {
    return (el && el.getAttribute && el.getAttribute(UID_ATTR)) || null;
  }

  /** First element matching any selector in order; selectors may be junk. */
  function firstEl(root, selectors) {
    if (!root) return null;
    for (var i = 0; i < selectors.length; i++) {
      try {
        var el = root.querySelector(selectors[i]);
        if (el) return el;
      } catch (e) {
        /* invalid selector on this Chrome build; try the next */
      }
    }
    return null;
  }

  function queryAll(root, selector) {
    if (!root) return [];
    try {
      return Array.prototype.slice.call(root.querySelectorAll(selector));
    } catch (e) {
      return [];
    }
  }

  /**
   * Layout-based visibility test. Cheaper than getComputedStyle in a loop and
   * it also catches ancestors hidden with display:none. Only meaningful for
   * nodes in the live document — a detached clone has no rects at all.
   */
  function isHidden(el) {
    if (!el || el.hidden) return true;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    return typeof el.getClientRects === 'function' && el.getClientRects().length === 0;
  }

  function containedBy(list, el) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] !== el && list[i].contains(el)) return true;
    }
    return false;
  }

  function mkBlock(kind, text, level, uid, meta) {
    return {
      id: '',
      kind: kind,
      level: level == null ? null : level,
      text: text,
      uid: uid || null,
      meta: meta || null,
    };
  }

  /** Sequential ids, applied once per adapter so numbering never repeats. */
  function reindex(blocks) {
    for (var i = 0; i < blocks.length; i++) blocks[i].id = 'b' + i;
    return blocks;
  }

  function note(msg) {
    window.RAL.adapterNote = msg;
  }

  /**
   * Success path for every adapter: drop the empties, clear any stale note,
   * and collapse "matched but found nothing" into null so extract.js keeps
   * looking instead of playing an empty document.
   */
  function ok(blocks) {
    var out = [];
    for (var i = 0; i < (blocks || []).length; i++) {
      var b = blocks[i];
      if (!b || !b.text) continue;
      if (b.kind !== K.CODE && collapse(b.text).length < 2) continue;
      out.push(b);
    }
    if (!out.length) return null;
    window.RAL.adapterNote = null;
    return reindex(out);
  }
  // ------------------------------------------------------- DOM -> Block[]

  var WALK_SEL =
    'h1,h2,h3,h4,h5,h6,p,li,dt,dd,blockquote,pre,figcaption,.thumbcaption,' +
    'table,math,.mwe-math-element';

  function blockFor(el) {
    var tag = el.tagName.toLowerCase();
    var uid = uidOf(el);

    if (tag === 'pre') {
      var code = codeText(el);
      return code ? mkBlock(K.CODE, code, null, uid, { lines: code.split('\n').length }) : null;
    }
    if (/^h[1-6]$/.test(tag)) {
      var head = collapse(el.textContent);
      return head ? mkBlock(K.HEADING, head, Number(tag.charAt(1)), uid) : null;
    }

    var text = collapse(el.textContent);
    if (text.length < 2) return null;

    if (tag === 'blockquote') return mkBlock(K.QUOTE, text, null, uid);
    if (tag === 'li' || tag === 'dt' || tag === 'dd') return mkBlock(K.LIST_ITEM, text, null, uid);
    if (tag === 'figcaption' || hasClass(el, 'thumbcaption')) {
      return mkBlock(K.FIGURE, text, null, uid);
    }
    if (tag === 'table') return mkBlock(K.TABLE, text, null, uid);
    if (tag === 'math' || hasClass(el, 'mwe-math-element')) {
      return mkBlock(K.MATH, text, null, uid);
    }
    return mkBlock(K.PARAGRAPH, text, null, uid);
  }

  function hasClass(el, name) {
    return !!(el && el.classList && el.classList.contains(name));
  }

  /**
   * Local stand-in for window.RAL.blocksFrom, used only when the shared
   * helper is missing or throws. Walks in document order and skips any node
   * already covered by an emitted ancestor, so a <p> inside a <blockquote>
   * (or a nested <li>) is never spoken twice.
   */
  function localBlocks(root, opts) {
    var skip = (opts.skip || []).join(',');
    var live = root.isConnected !== false;
    var nodes = queryAll(root, WALK_SEL);
    var out = [];
    var emitted = [];

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (skip) {
        try {
          if (el.closest(skip)) continue;
        } catch (e) {
          /* unusable skip list; keep the node */
        }
      }
      if (containedBy(emitted, el)) continue;
      if (live && isHidden(el)) continue;
      var b = blockFor(el);
      if (!b) continue;
      out.push(b);
      emitted.push(el);
    }

    // Leaf roots (a Notion text block, one Docs paragraph) match nothing above.
    if (!out.length) {
      var t = collapse(root.textContent);
      if (t.length > 1) out.push(mkBlock(K.PARAGRAPH, t, null, uidOf(root)));
    }
    return out;
  }

  /**
   * Preferred conversion path. blocksFrom() is defined by extract.js, which
   * loads after this file, so it is resolved here at call time rather than
   * captured at load time.
   */
  function toBlocks(node, opts) {
    if (!node) return [];
    opts = opts || {};
    var shared = window.RAL && window.RAL.blocksFrom;
    if (typeof shared === 'function') {
      try {
        var out = shared(node, opts);
        if (out && out.length) return out;
      } catch (e) {
        /* shared helper unhappy with this subtree; fall back */
      }
    }
    return localBlocks(node, opts);
  }

  /** Same, across a list of sibling roots, in the order given. */
  function toBlocksAll(nodes, opts) {
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var part = toBlocks(nodes[i], opts);
      for (var j = 0; j < part.length; j++) out.push(part[j]);
    }
    return out;
  }

  /**
   * Image captions are the one thing worth keeping from a figure, and markup
   * for them varies (real <figcaption> in newer Wikipedia output, a plain
   * div.thumbcaption in older). blocksFrom() may not treat the div form as a
   * caption, so backfill anything its output missed.
   */
  function ensureCaptions(node, blocks) {
    var caps = queryAll(node, 'figcaption, .thumbcaption');
    for (var i = 0; i < caps.length; i++) {
      var text = collapse(caps[i].textContent);
      if (text.length < 3) continue;
      var seen = false;
      for (var j = 0; j < blocks.length; j++) {
        if (blocks[j].text.indexOf(text) !== -1) { seen = true; break; }
      }
      if (!seen) blocks.push(mkBlock(K.FIGURE, text, null, uidOf(caps[i])));
    }
    return blocks;
  }

  /**
   * Reader-furniture text that survives selector-level pruning: standalone
   * buttons and link labels. Only applied to short blocks, so a sentence that
   * happens to begin with "Share" is left alone.
   */
  var CTA_RE = new RegExp(
    '^(sign up|sign in|log ?in|subscribe|subscribed|subscribe now|share|share this( post)?|' +
      'listen|listen now|save|follow|following|upgrade to paid|leave a comment|comment|comments|' +
      'give a gift subscription|pledge your support|get started|read more|more from medium|' +
      'recommended from medium|written by|edit|reply|like|likes|claps?|[0-9,.k]+ ?(claps?|likes?)|' +
      'copy link|email|notes|restack|previous|next|home|archive|about)[.!:]?$',
    'i'
  );

  function dropCta(blocks) {
    var out = [];
    for (var i = 0; i < blocks.length; i++) {
      var t = collapse(blocks[i].text);
      if (t.length <= 40 && CTA_RE.test(t)) continue;
      out.push(blocks[i]);
    }
    return out;
  }
  // ------------------------------------------------------------- Wikipedia

  /**
   * Chrome removed all of this by selector. Infoboxes and navboxes read as
   * long comma-runs of place names; .reflist is bare citations; sister-project
   * boxes and .hatnote are navigation aimed at eyes, not ears.
   */
  var WIKI_SKIP = [
    '.infobox', '.infobox_v2', '.infobox-full-data', '.sidebar', '.vertical-navbox',
    '.navbox', '.navbox-inner', '.navbox-styles', '.nomobile',
    '.reflist', '.references', '.reference', '.refbegin', '.mw-references-wrap',
    '.mw-editsection', '.mw-jump-link', '.mw-empty-elt', '.mw-cite-backlink',
    '#coordinates', '.geo-inline', '.hatnote', '.dablink', '.rellink',
    '#toc', '.toc', '.toclimit-2', '.toclimit-3', '.sidebar-toc', '.vector-toc',
    '#catlinks', '.catlinks', '.printfooter',
    '.sistersitebox', '.side-box', '.metadata', '.ambox', '.mbox-small', '.plainlinks',
    '.noprint', '.shortdescription', '.mw-kartographer-maplink',
    '.gallery', '.thumb .magnify', '.mw-halign-right',
    '.portalbox', '.portal', '.stub', '.asbox', '.succession-box',
    '.mw-collapsible.mw-collapsed', '.NavFrame', '.mw-authority-control',
    'table.wikitable + .reflist', 'style', 'script', 'sup.reference',
    // Wiktionary: quotation and translation tables are dense link/gloss lists.
    '.nyms', '.citation-whole', '.NavContent .translations', '.ib-content',
  ];

  /**
   * Everything from the first appendix heading onward is dropped. Those
   * sections are pure link soup once the markup is gone — a References list
   * reads as a minutes-long stream of author names, and See also / External
   * links are bare titles with no sentence around them. Matching is on the
   * heading's id/text because the sections are siblings in .mw-parser-output
   * rather than nested, so there is no container to exclude.
   */
  var WIKI_STOP = [
    'references', 'reference', 'notes', 'notes_and_references',
    'footnotes', 'citations', 'sources', 'bibliography', 'works_cited',
    'external_links', 'see_also', 'further_reading', 'related_pages',
    'further_information', 'literature',
    // Wiktionary appendices.
    'anagrams', 'references_2', 'further_reading_2',
  ];

  function wikiStopText(s) {
    var t = collapse(s).toLowerCase().replace(/\[\s*edit\s*\]/g, '').replace(/[^a-z ]/g, '').trim();
    return WIKI_STOP.indexOf(t.replace(/ /g, '_')) !== -1;
  }

  /**
   * True once we reach an appendix heading. Prefers ids, which MediaWiki
   * derives from the title and keeps stable across skins ("External_links"),
   * and falls back to the heading's own visible text. Both the heading
   * element and a nested .mw-headline are checked, because the id moved from
   * the span to the h2 itself in the 2023 parser output.
   */
  function isWikiStopHeading(el) {
    var headline = el.querySelector('.mw-headline');
    var ids = [el.id, headline && headline.id];
    for (var i = 0; i < ids.length; i++) {
      var id = (ids[i] || '').toLowerCase();
      if (id && WIKI_STOP.indexOf(id) !== -1) return true;
    }
    // Always the heading's full text, never a nested node's.
    return wikiStopText(el.textContent);
  }

  var wikipedia = {
    name: 'wikipedia',

    match: function (url) {
      return hostMatches(url, [
        'wikipedia.org', 'wiktionary.org', 'wikimedia.org',
        'wikisource.org', 'wikibooks.org', 'wikiquote.org', 'wikivoyage.org',
      ]);
    },

    extract: function (doc) {
      try {
        var body = firstEl(doc, [
          '#mw-content-text .mw-parser-output',
          '.mw-parser-output',
          '#mw-content-text',
          '#bodyContent',
        ]);
        if (!body) return null;

        // Work on a clone: pruning must not disturb the live page, which the
        // highlighter still reads. uids were stamped before this ran, so they
        // survive the clone and keep pointing at the live nodes.
        var root = body.cloneNode(true);
        for (var i = 0; i < WIKI_SKIP.length; i++) {
          var junk = queryAll(root, WIKI_SKIP[i]);
          for (var j = 0; j < junk.length; j++) {
            if (junk[j].parentNode) junk[j].parentNode.removeChild(junk[j]);
          }
        }

        // Truncate at the first appendix heading. Section wrappers appear in
        // newer parser output, so check both the wrapper and a bare heading.
        var kids = Array.prototype.slice.call(root.children);
        var cut = -1;
        for (var k = 0; k < kids.length; k++) {
          var el = kids[k];
          var heading = /^h[1-6]$/i.test(el.tagName)
            ? el
            : el.querySelector(':scope > h1, :scope > h2, :scope > h3');
          if (heading && isWikiStopHeading(heading)) { cut = k; break; }
        }
        if (cut === 0) return null;                 // nothing but appendices
        if (cut > 0) {
          for (var d = kids.length - 1; d >= cut; d--) {
            if (kids[d].parentNode) kids[d].parentNode.removeChild(kids[d]);
          }
        }

        var blocks = toBlocks(root, { skip: WIKI_SKIP });
        blocks = ensureCaptions(root, blocks);

        // "[edit]" survives when a theme renders it outside .mw-editsection.
        for (var b = 0; b < blocks.length; b++) {
          blocks[b].text = blocks[b].text.replace(/\[\s*edit\s*\]/gi, '').trim();
        }
        return ok(blocks);
      } catch (e) {
        return null;
      }
    },
  };
  // ----------------------------------------------------------- Google Docs

  var DOCS_CANVAS = '.kix-canvastile, .kix-canvas-tile-content, canvas.kix-canvas-tile-content';
  var DOCS_TEXT = '.kix-paragraphrenderer, .kix-lineview, .kix-wordhtmlgenerator-word-node';

  var CANVAS_NOTE =
    "This Google Doc renders to canvas, so its text isn't reachable. " +
    'Try File > Print or paste the notes into a plain page.';

  var googleDocs = {
    name: 'google-docs',

    match: function (url) {
      return hostMatches(url, ['docs.google.com']);
    },

    extract: function (doc) {
      try {
        // Published and print views ("/pub", "/preview") are ordinary HTML and
        // the most reliable thing on this domain when they exist.
        var published = firstEl(doc, ['.doc-content', '#contents .doc-content', '#contents']);
        if (published && collapse(published.textContent).length > 40) {
          return ok(toBlocks(published, {}));
        }

        var nodes = queryAll(doc, DOCS_TEXT);
        var readable = [];
        for (var i = 0; i < nodes.length; i++) {
          if (collapse(nodes[i].textContent).length > 1) readable.push(nodes[i]);
        }

        /**
         * The canvas case. Since 2021 the editor paints glyphs into <canvas>
         * and keeps no text nodes at all, so there is nothing any content
         * script can read — not a stale selector, an absent DOM. Leave the
         * reason in adapterNote (see the header) and fall through, so the user
         * gets an explanation instead of silence.
         */
        if (!readable.length) {
          if (doc.querySelector(DOCS_CANVAS)) note(CANVAS_NOTE);
          return null;
        }

        // Prefer whole paragraphs; drop lines already covered by one.
        var blocks = [];
        var emitted = [];
        for (var n = 0; n < readable.length; n++) {
          var el = readable[n];
          if (containedBy(emitted, el)) continue;
          var text = collapse(el.textContent);
          if (text.length < 2) continue;
          // Headings carry no semantic markup here (font size is inline
          // style only), so everything stays prose and the list marker is the
          // one structural signal worth reading.
          var isList = !!el.querySelector('[class*="kix-bullet"], .kix-lineview-bullet');
          blocks.push(mkBlock(isList ? K.LIST_ITEM : K.PARAGRAPH, text, null, uidOf(el)));
          emitted.push(el);
        }
        return ok(blocks);
      } catch (e) {
        return null;
      }
    },
  };

  // ----------------------------------------------------------------- Notion

  /** class fragment -> [kind, level]. Checked longest-first, see notionKind. */
  var NOTION_KINDS = [
    ['notion-sub_sub_header-block', K.HEADING, 3],
    ['notion-sub_header-block', K.HEADING, 2],
    ['notion-header-block', K.HEADING, 1],
    ['notion-quote-block', K.QUOTE, null],
    ['notion-code-block', K.CODE, null],
    ['notion-bulleted_list-block', K.LIST_ITEM, null],
    ['notion-numbered_list-block', K.LIST_ITEM, null],
    ['notion-to_do-block', K.LIST_ITEM, null],
    ['notion-toggle-block', K.LIST_ITEM, null],
    ['notion-table_row-block', K.TABLE, null],
    ['notion-equation-block', K.MATH, null],
    ['notion-callout-block', K.PARAGRAPH, null],
    ['notion-text-block', K.PARAGRAPH, null],
    ['notion-page-block', K.PARAGRAPH, null],
  ];

  /** Navigation and embeds: no prose, and databases are pure link lists. */
  var NOTION_SKIP_KINDS = [
    'notion-divider-block', 'notion-table_of_contents-block', 'notion-breadcrumb-block',
    'notion-bookmark-block', 'notion-collection_view-block', 'notion-collection_view_page-block',
    'notion-image-block', 'notion-video-block', 'notion-audio-block', 'notion-file-block',
    'notion-embed-block', 'notion-link_to_page-block', 'notion-column_list-block',
  ];

  function notionClassList(el) {
    return ' ' + ((el.className && String(el.className)) || '') + ' ';
  }

  function isNotionBlock(el) {
    var c = notionClassList(el);
    return c.indexOf('notion-') !== -1 && c.indexOf('-block') !== -1;
  }

  function notionKind(el) {
    var c = notionClassList(el);
    for (var i = 0; i < NOTION_SKIP_KINDS.length; i++) {
      if (c.indexOf(NOTION_SKIP_KINDS[i]) !== -1) return null;
    }
    for (var j = 0; j < NOTION_KINDS.length; j++) {
      if (c.indexOf(NOTION_KINDS[j][0]) !== -1) return NOTION_KINDS[j];
    }
    return null;
  }

  /**
   * A Notion block owns only the first editable that no *nested* block sits
   * between — children live inside the same subtree, so reading textContent
   * directly would repeat every descendant inside its ancestor.
   */
  function notionOwnText(el) {
    var eds = queryAll(el, '[contenteditable], .notion-enable-hover');
    for (var i = 0; i < eds.length; i++) {
      var stop = false;
      for (var p = eds[i].parentElement; p && p !== el; p = p.parentElement) {
        if (isNotionBlock(p)) { stop = true; break; }
      }
      if (!stop) {
        var t = collapse(eds[i].textContent);
        if (t) return t;
      }
    }
    return '';
  }
  var notion = {
    name: 'notion',

    match: function (url) {
      return hostMatches(url, ['notion.so', 'notion.site', 'notion.com']);
    },

    extract: function (doc) {
      try {
        var root = firstEl(doc, [
          '.notion-page-content',
          'main .notion-page-content',
          '.notion-frame .notion-scroller',
          '[role="main"]',
        ]);
        if (!root) return null;

        var blocks = [];

        // Page title sits outside .notion-page-content in most layouts.
        var title = firstEl(doc, [
          '.notion-page-block [placeholder="Untitled"]',
          '[placeholder="Untitled"]',
          '.notion-title',
          'h1.notion-page-title-text',
          '.notion-record-icon + div [contenteditable]',
        ]);
        var titleText = title ? collapse(title.textContent) : '';
        if (titleText) blocks.push(mkBlock(K.HEADING, titleText, 1, uidOf(title)));

        var nodes = queryAll(root, '[class*="notion-"][class*="-block"]');
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i];
          var spec = notionKind(el);
          if (!spec) continue;
          var text = spec[1] === K.CODE ? codeText(el) : notionOwnText(el);
          if (!text || collapse(text).length < 2) continue;
          if (text === titleText) continue;
          var meta = spec[1] === K.CODE ? { lines: text.split('\n').length } : null;
          blocks.push(mkBlock(spec[1], text, spec[2], uidOf(el), meta));
        }

        // Logged-out or still-hydrating pages render the shell with no blocks;
        // null sends this to Readability rather than reading the chrome.
        return ok(blocks);
      } catch (e) {
        return null;
      }
    },
  };

  // ----------------------------------------------------------------- GitHub

  var MARKDOWN_EXT = /\.(md|markdown|mdx|mdown|rst|txt|adoc|asciidoc)$/i;

  var github = {
    name: 'github',

    match: function (url) {
      return hostMatches(url, ['github.com']);
    },

    extract: function (doc, url) {
      try {
        var path = (url && url.pathname) || location.pathname || '';
        var isBlob = /\/(blob|blame)\//.test(path);

        // Rendered markdown — on a repo landing page (README) or a .md blob
        // shown in the rendered tab. Real prose either way.
        var rendered = firstEl(doc, [
          'article.markdown-body',
          '#readme article',
          '[data-testid="readme"] article',
          '.Box-body article.markdown-body',
          '.markdown-body',
        ]);
        if (rendered && (!isBlob || MARKDOWN_EXT.test(path))) {
          var prose = toBlocks(rendered, { skip: ['.anchor', '.octicon', 'summary .octicon'] });
          if (prose.length) {
            var head = [];
            if (isBlob) {
              var name = path.split('/').pop();
              if (name) head.push(mkBlock(K.HEADING, name, 1, null));
            }
            return ok(head.concat(prose));
          }
        }

        if (!isBlob) return null;

        /**
         * Source view. The React viewer keeps the whole file in a hidden
         * textarea (#read-only-cursor-text-area) — the only place the text is
         * intact, since .react-file-line is virtualised and drops offscreen
         * lines. Legacy table.highlight rows are the pre-React fallback.
         */
        var area = doc.querySelector('#read-only-cursor-text-area, textarea.react-blob-textarea');
        var source = area ? codeText(area) : '';

        if (!source) {
          var lines = queryAll(doc, '.react-code-lines .react-file-line');
          if (!lines.length) lines = queryAll(doc, 'table.highlight td.blob-code, .blob-wrapper .blob-code');
          var buf = [];
          for (var i = 0; i < lines.length; i++) {
            buf.push((lines[i].textContent || '').replace(/\s+$/, ''));
          }
          source = buf.join('\n').trim();
        }
        if (!source) return null;

        var file = path.split('/').pop() || 'file';
        var out = [mkBlock(K.HEADING, file, 1, null)];
        // A CODE block, not prose: the pipeline can then honour skipCode
        // instead of narrating punctuation for several minutes.
        out.push(mkBlock(K.CODE, source, null, null, { lines: source.split('\n').length, file: file }));
        return ok(out);
      } catch (e) {
        return null;
      }
    },
  };
  // -------------------------------------------------------- Stack Exchange

  /** Comments, vote widgets and user cards: metadata, never prose. */
  var SE_SKIP = [
    '.comments', '.comments-list', '.js-comments-container', '.comment',
    '.js-voting-container', '.votecell', '.vote', '.js-vote-count',
    '.user-info', '.user-details', '.post-signature', '.signature',
    '.post-menu', '.js-post-menu', '.d-none', '.js-share-link',
    '.post-taglist', '.js-post-tag-list-wrapper', '.tags',
    '.bounty-notification', '.question-status', '.js-saves-btn',
    '.mt24.mb12', '.js-add-link', '.reduce-and-enhance', '.wmd-preview',
  ];

  var stackExchange = {
    name: 'stack-exchange',

    match: function (url) {
      return hostMatches(url, [
        'stackoverflow.com', 'stackexchange.com', 'superuser.com',
        'serverfault.com', 'askubuntu.com', 'mathoverflow.net',
        'stackapps.com', 'answers.microsoft.com',
      ]);
    },

    extract: function (doc, url) {
      try {
        var path = (url && url.pathname) || location.pathname || '';
        // Only question pages have this shape; /questions lists and /users do not.
        if (path.indexOf('/questions/') === -1 && path.indexOf('/q/') !== 0) {
          if (!doc.querySelector('#question, .question')) return null;
        }

        var blocks = [];

        var title = firstEl(doc, [
          '#question-header h1 a', '#question-header h1',
          'h1[itemprop="name"] a', '.question-hyperlink', 'h1',
        ]);
        if (title) {
          var t = collapse(title.textContent);
          if (t) blocks.push(mkBlock(K.HEADING, t, 1, uidOf(title)));
        }

        var question = firstEl(doc, [
          '#question .s-prose', '#question .post-text',
          '.question .s-prose', '.question .postcell .s-prose',
        ]);
        if (!question) return null;

        blocks.push(mkBlock(K.HEADING, 'Question', 2, null));
        var qBody = toBlocks(question, { skip: SE_SKIP });
        for (var q = 0; q < qBody.length; q++) blocks.push(qBody[q]);

        /**
         * Answers, accepted first — that is the one people actually want, and
         * the DOM order is by score/date. .accepted-answer is the marker class
         * on the wrapper .answer div.
         */
        var answers = queryAll(doc, '.answer, [id^="answer-"]');
        var ordered = [];
        for (var a = 0; a < answers.length; a++) {
          var el = answers[a];
          if (containedBy(answers, el)) continue;
          var accepted =
            hasClass(el, 'accepted-answer') ||
            !!el.querySelector('.js-accepted-answer-indicator:not(.d-none), .vote-accepted-on');
          ordered.push({ el: el, accepted: accepted });
        }
        ordered.sort(function (x, y) {
          return (y.accepted ? 1 : 0) - (x.accepted ? 1 : 0);
        });

        var n = 0;
        for (var i = 0; i < ordered.length; i++) {
          var body = firstEl(ordered[i].el, ['.s-prose', '.post-text', '.answercell .s-prose']);
          if (!body) continue;
          var part = toBlocks(body, { skip: SE_SKIP });
          if (!part.length) continue;
          n++;
          var label = ordered[i].accepted ? 'Accepted answer' : 'Answer ' + n;
          blocks.push(mkBlock(K.HEADING, label, 2, uidOf(ordered[i].el)));
          for (var p = 0; p < part.length; p++) blocks.push(part[p]);
        }
        return ok(blocks);
      } catch (e) {
        return null;
      }
    },
  };

  // ------------------------------------------------------------------ arXiv

  var arxiv = {
    name: 'arxiv',

    match: function (url) {
      if (!hostMatches(url, ['arxiv.org'])) return false;
      // Abstract pages only. /pdf/, /list/ and /find/ have no abstract markup.
      return ((url && url.pathname) || '').indexOf('/abs/') !== -1;
    },

    extract: function (doc) {
      try {
        var title = firstEl(doc, ['h1.title', '.title.mathjax', 'h1.title.mathjax']);
        var authors = firstEl(doc, ['.authors', 'div.authors']);
        var abstract = firstEl(doc, ['blockquote.abstract', '.abstract.mathjax', 'blockquote']);
        if (!abstract) return null;

        var blocks = [];

        // The labels are inline <descriptor> spans inside each field, so strip
        // them from the text rather than reading them out.
        if (title) {
          var tt = collapse(title.textContent).replace(/^title:\s*/i, '');
          if (tt) blocks.push(mkBlock(K.HEADING, tt, 1, uidOf(title)));
        }
        if (authors) {
          var at = collapse(authors.textContent).replace(/^authors?:\s*/i, '');
          if (at) blocks.push(mkBlock(K.PARAGRAPH, 'Authors: ' + at, null, uidOf(authors)));
        }

        var abs = collapse(abstract.textContent).replace(/^abstract:\s*/i, '');
        if (!abs) return null;
        blocks.push(mkBlock(K.HEADING, 'Abstract', 2, null));
        blocks.push(mkBlock(K.PARAGRAPH, abs, null, uidOf(abstract)));

        // .submission-history, .extra-services, comments/subjects tables and
        // the citation block are all bibliographic metadata — skipped by
        // never being read, rather than by pruning.
        return ok(blocks);
      } catch (e) {
        return null;
      }
    },
  };
  // -------------------------------------------------- Medium and Substack

  /**
   * Reader furniture. The paywall and subscribe widgets are interleaved with
   * the prose rather than appended, so they have to go by selector before the
   * walk, not by trimming the tail.
   */
  var BLOG_SKIP = [
    // Medium
    '.pw-multi-vote-count', '.pw-multi-vote-icon', '.js-postMetaLockup',
    '[data-testid="audioPlayButton"]', '[data-testid="headerClapButton"]',
    '[data-testid="headerSocialShareButton"]', '[data-testid="headerBookmarkButton"]',
    '[data-testid="storyFooter"]', '[data-testid="authorFooter"]',
    '[data-testid="post-sidebar"]', '.postArticle-readMore', '.js-postShareWidget',
    '.meteredContent + div', '.overlay', '.speechify-ignore',
    // Substack
    '.subscription-widget', '.subscription-widget-wrap', '.subscribe-widget',
    '.subscribe-footer', '.paywall', '.paywall-cta', '.paywall-jump',
    '.post-ufi', '.post-footer', '.comments-section', '.button-wrapper',
    '.share-dialog', '.podcast-player', '.captioned-button-wrap',
    '.footer-buttons', '.publication-footer', '.recommendations',
    '.email-input-wrap', '.sideBySideWrap', '.digest-cta', '.embedded-post',
    // Shared
    'nav', 'footer', 'aside', 'form', 'button', '[role="dialog"]',
    '[aria-label="responses"]', 'script', 'style',
  ];

  var blog = {
    name: 'medium-substack',

    match: function (url) {
      return hostMatches(url, ['medium.com', 'substack.com', 'towardsdatascience.com']);
    },

    extract: function (doc) {
      try {
        var root = firstEl(doc, [
          // Medium
          'article section .pw-post-body-paragraph',
          'article > div > section',
          'article section',
          '.postArticle-content',
          // Substack
          '.available-content .body.markup',
          '.post .body.markup',
          '.available-content',
          '.single-post .body',
          'article',
        ]);
        // The first Medium selector resolves to a paragraph, not the body;
        // climb to the section that holds all of them.
        if (root && hasClass(root, 'pw-post-body-paragraph')) {
          root = root.closest('section') || root.parentElement;
        }
        if (!root) return null;

        var blocks = [];

        var title = firstEl(doc, [
          'h1[data-testid="storyTitle"]', '.post-title', 'h1.post-title', 'article h1', 'h1',
        ]);
        var titleText = title ? collapse(title.textContent) : '';
        if (titleText) blocks.push(mkBlock(K.HEADING, titleText, 1, uidOf(title)));

        var body = toBlocks(root, { skip: BLOG_SKIP });
        for (var i = 0; i < body.length; i++) {
          if (body[i].text === titleText) continue;   // title repeated inside <article>
          blocks.push(body[i]);
        }

        blocks = dropCta(blocks);

        /**
         * Recommendation footers survive selector pruning when Substack ships
         * new class names, so cut everything from a known footer heading on.
         */
        var FOOTER_RE = /^(more from|recommended from medium|related|share this post|discussion about this|comments?|subscribe to|previously|read more from)\b/i;
        for (var f = 0; f < blocks.length; f++) {
          if (blocks[f].kind === K.HEADING && FOOTER_RE.test(collapse(blocks[f].text))) {
            blocks = blocks.slice(0, f);
            break;
          }
        }
        return ok(blocks);
      } catch (e) {
        return null;
      }
    },
  };

  // ----------------------------------------------------------- PDF viewer

  var PDF_NOTE =
    'PDF text is not reachable from the page DOM. Open the PDF in a reader ' +
    'that shows selectable text, or use a PDF-to-text service.';

  var pdf = {
    name: 'pdf',

    match: function (url, doc) {
      var p = ((url && url.pathname) || '').toLowerCase();
      if (/\.pdf$/.test(p)) return true;
      var d = doc || document;
      if (d.contentType === 'application/pdf') return true;
      return !!firstEl(d, [
        'embed[type="application/pdf"]',
        'embed[type="application/x-google-chrome-pdf"]',
        'object[type="application/pdf"]',
        '#plugin', 'pdf-viewer',
      ]);
    },

    /**
     * Always null. Chrome's PDF viewer is a closed plugin — its text lives in
     * an inaccessible internal document, so there is nothing to read at any
     * selector. The note is the whole point of this adapter: without it the
     * user just gets silence and no idea why.
     */
    extract: function () {
      note(PDF_NOTE);
      return null;
    },
  };

  // --------------------------------------------------------------- registry

  /**
   * Order matters: extract.js takes the first adapter whose match() is true
   * and whose extract() returns a non-empty array. PDF is first because a
   * .pdf URL can be served from any of the hosts below.
   */
  window.RAL.adapters = [
    pdf,
    wikipedia,
    googleDocs,
    notion,
    github,
    stackExchange,
    arxiv,
    blog,
  ];
})();
