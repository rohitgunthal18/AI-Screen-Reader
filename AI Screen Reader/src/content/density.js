/**
 * Text-density fallback extraction.
 *
 * Readability is excellent on articles and useless on everything else: docs
 * sites, forum threads, changelogs, wikis with heavy chrome, single-page apps
 * that render prose into a soup of unsemantic divs. This module is the safety
 * net for those pages. It scores every plausible container by how much of it is
 * *prose* rather than *markup*, picks the winner, and hands it to
 * RAL.blocksFrom() so the output is identical in shape to every other layer.
 *
 * Loaded as a CLASSIC content script before extract.js, so everything it needs
 * from extract.js (RAL.blocksFrom) is resolved lazily at call time, never at
 * load time.
 */

(function () {
  'use strict';

  var RAL = (window.RAL = window.RAL || {});

  /** Mirrors extract.js. Marks subtree roots that were invisible on the live page. */
  var HIDDEN_ATTR = 'data-ral-hidden';

  /**
   * Containers worth scoring. Semantic landmarks first, then the usual class and
   * id conventions, then bare divs and sections because plenty of real pages
   * have no semantics at all.
   */
  var CANDIDATE_SELECTOR = [
    'main', 'article', '[role="main"]', '[itemprop="articleBody"]',
    '.content', '#content', '.post', '.entry', '.entry-content', '.post-content',
    '.article-body', '.articleBody', '.markdown-body', '.prose', '.story',
    'section', 'div',
  ].join(',');

  /** Elements that carry actual prose, used for the paragraph-count signal. */
  var PROSE_SELECTOR = 'p,li,blockquote,pre,h1,h2,h3,h4,h5,h6,dd,figcaption';

  /**
   * Unbounded like Readability's own positive list: partial matches such as
   * "articleBody" or "post-content" are exactly what we want to catch.
   */
  var POSITIVE = /article|blog|body|chapter|content|docs|entry|hentry|h-entry|main|markdown|page|post|prose|readme|story|text/i;

  /**
   * Delimiter-bounded on purpose. An unbounded /ad/ matches "read", "shadow",
   * "gradient", "download" and "header" matches "sub-header" on the article
   * itself, so every one of these is anchored to a word boundary in a
   * class/id string. Getting this wrong silently deletes the article.
   */
  var NEGATIVE = new RegExp(
    '(^|[-_ ])(' + [
      'nav', 'navbar', 'navigation', 'menu', 'sidebar', 'side', 'aside', 'rail',
      'comment', 'comments', 'disqus', 'respond', 'reply',
      'footer', 'foot', 'masthead', 'header', 'topbar', 'breadcrumb', 'breadcrumbs',
      'promo', 'promotion', 'cookie', 'cookies', 'consent', 'gdpr', 'banner',
      'share', 'sharing', 'social', 'follow', 'subscribe', 'newsletter', 'signup',
      'related', 'recommended', 'recirc', 'more', 'popular', 'trending',
      'popup', 'modal', 'overlay', 'drawer', 'dialog', 'toolbar', 'pager',
      'pagination', 'paywall', 'advert', 'advertisement', 'ads', 'ad',
      'sponsor', 'sponsored', 'widget', 'byline', 'tags', 'toc', 'skip',
    ].join('|') + ')([-_ ]|$)',
    'i'
  );

  /** Strong, explicit "this is the article" markers. */
  var STRONG_POSITIVE = /articlebody|article-body|article__body|entry-content|post-content|post-body|story-body|markdown-body|rich-text/i;

  /* ------------------------------------------------------------------ utils */

  function classId(el) {
    // SVG elements expose className as an SVGAnimatedString, not a string.
    var cls = typeof el.className === 'string' ? el.className : '';
    return (cls + ' ' + (el.id || '')).toLowerCase();
  }

  /**
   * Text length with invisible subtrees removed. extract.js marks each hidden
   * subtree ROOT with data-ral-hidden and never descends into it, so the marks
   * are disjoint and a single subtraction pass is exact — far cheaper than
   * calling getComputedStyle per descendant while scoring hundreds of nodes.
   */
  function visibleTextLength(el) {
    var len = el.textContent.length;
    var hidden = el.querySelectorAll('[' + HIDDEN_ATTR + ']');
    for (var i = 0; i < hidden.length; i++) len -= hidden[i].textContent.length;
    return len > 0 ? len : 0;
  }

  /** Fraction of the text that lives inside links. Menus approach 1.0. */
  function linkDensity(el, textLen) {
    if (!textLen) return 0;
    var links = el.querySelectorAll('a[href]');
    var linked = 0;
    for (var i = 0; i < links.length; i++) linked += links[i].textContent.length;
    return Math.min(1, linked / textLen);
  }

  function countProse(el) {
    var nodes = el.querySelectorAll(PROSE_SELECTOR);
    var n = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].textContent.trim().length >= 25) n++;
    }
    return n;
  }

  function countCommas(text) {
    // Includes the CJK and Arabic comma; comma count is a language-agnostic
    // proxy for "someone wrote sentences here".
    var m = text.match(/[,，、؛]/g);
    return m ? m.length : 0;
  }

  function classWeight(el) {
    var s = classId(el);
    var w = 0;
    if (NEGATIVE.test(s)) w -= 45;
    if (POSITIVE.test(s)) w += 25;
    if (STRONG_POSITIVE.test(s)) w += 45;
    if (el.getAttribute && el.getAttribute('itemprop') === 'articleBody') w += 45;
    return w;
  }

  function tagBonus(el) {
    var tag = el.tagName;
    if (tag === 'MAIN' || tag === 'ARTICLE') return 35;
    if (el.getAttribute && el.getAttribute('role') === 'main') return 35;
    if (tag === 'SECTION') return 8;
    return 0;
  }

  /* ---------------------------------------------------------------- scoring */

  /**
   * Weights, and why:
   *   prose blocks  x12  the single most reliable signal — chrome has almost none
   *   commas        x3   sentences over labels, capped so comment threads
   *                      cannot out-vote the article on volume alone
   *   raw volume    /100 capped at 60, otherwise <body> always wins by inches
   *   text/element  x1   the actual "density": prose has few tags per character,
   *                      nav and card grids have many
   *   link density  x    multiplicative, because a 95%-links container is chrome
   *                      no matter how many characters it holds
   */
  function score(el) {
    var textLen = visibleTextLength(el);
    if (textLen < 140) return -1;

    var text = el.textContent;
    var prose = countProse(el);
    var elements = el.getElementsByTagName('*').length;
    var ld = linkDensity(el, textLen);

    var s = 0;
    s += prose * 12;
    s += Math.min(countCommas(text), 60) * 3;
    s += Math.min(textLen / 100, 60);
    s += Math.min(textLen / (elements + 1), 40);
    s += classWeight(el);
    s += tagBonus(el);

    // A container with text but no prose elements at all is usually a card
    // grid or a table of contents rendered as spans.
    if (prose === 0) s -= 25;
    if (ld > 0.5) s -= 40;

    s *= 1 - Math.min(ld, 0.95);
    return s;
  }

  /**
   * Walk down from the winner while a single child still holds essentially all
   * the text. Scoring often lands on a wrapper (body > #page > article); this
   * trims the wrapper off so the sibling chrome that shares it is excluded.
   */
  function tighten(el) {
    var guard = 0;
    while (guard++ < 8) {
      var kids = el.children;
      var best = null;
      var bestLen = 0;
      var total = visibleTextLength(el);
      if (total < 140) break;
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].hasAttribute(HIDDEN_ATTR)) continue;
        var len = visibleTextLength(kids[i]);
        if (len > bestLen) { bestLen = len; best = kids[i]; }
      }
      // 92%: the wrapper adds nothing but a tag. Below that it holds real
      // sibling content we would be throwing away.
      if (!best || bestLen / total < 0.92) break;
      if (best.tagName === 'P' || best.tagName === 'PRE' || best.tagName === 'TABLE') break;
      el = best;
    }
    return el;
  }

  /* ------------------------------------------------------------------- main */

  /**
   * @param {Document|Element} doc
   * @returns {object[]} Blocks in reading order, or [] when nothing scores.
   */
  RAL.densityExtract = function (doc) {
    var d = doc || document;
    var root = d.nodeType === 9 ? (d.body || d.documentElement) : d;
    if (!root || root.nodeType !== 1) return [];

    var all;
    try {
      all = root.querySelectorAll(CANDIDATE_SELECTOR);
    } catch (e) {
      return [];
    }

    // Prefilter before scoring: querySelectorAll on a big page returns
    // thousands of divs, and scoring each one walks its whole subtree.
    var candidates = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.hasAttribute(HIDDEN_ATTR)) continue;
      if (el.textContent.length < 140) continue;
      candidates.push(el);
    }
    if (root.textContent.length >= 140 && candidates.indexOf(root) === -1) {
      candidates.push(root); // a body with bare text and no wrapper at all
    }
    if (!candidates.length) return [];

    if (candidates.length > 300) {
      candidates.sort(function (a, b) { return b.textContent.length - a.textContent.length; });
      candidates = candidates.slice(0, 300);
    }

    var winner = null;
    var winningScore = 0;
    for (var j = 0; j < candidates.length; j++) {
      var s = score(candidates[j]);
      if (s > winningScore) { winningScore = s; winner = candidates[j]; }
    }
    if (!winner) return [];

    winner = tighten(winner);

    if (typeof RAL.blocksFrom !== 'function') return [];
    return RAL.blocksFrom(winner, { container: winner });
  };

  /** Exposed for debugging from the console; the pipeline uses densityExtract. */
  RAL.densityScore = score;
})();
