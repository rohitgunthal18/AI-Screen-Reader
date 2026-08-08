/**
 * Content script entry point.
 *
 * Owns the message channel to the service worker and the in-page highlight.
 * All of the extraction logic lives in extract.js / density.js / adapters.js;
 * this file is the thin edge that turns messages into calls and results into
 * replies, and it never throws — a rejected extraction has to come back as a
 * readable sentence, not as "Could not establish connection".
 *
 * Classic content script, injected last, so window.RAL is already populated.
 */

(function () {
  'use strict';

  // The worker re-injects on every read because that is cheaper than tracking
  // per-tab state that goes stale on navigation. Re-running the other files is
  // harmless (they only reassign functions), but a second onMessage listener
  // would answer every request twice, so installation happens exactly once.
  if (window.RAL && window.RAL.installed) return;

  var RAL = (window.RAL = window.RAL || {});

  /** Mirrored from src/lib/protocol.js — see the note in extract.js. */
  var Msg = {
    DO_EXTRACT: 'do-extract',
    HIGHLIGHT: 'highlight',
    CLEAR_HIGHLIGHT: 'clear-highlight',
  };
  var HIGHLIGHT_CLASS = 'ral-active';

  /* ---------------------------------------------------------------- metadata */

  /** documentElement.lang, then the meta fallback, then give up and say English. */
  function detectLang(langHint) {
    var html = (document.documentElement.getAttribute('lang') || '').trim();
    if (html) return html.split(',')[0].trim();

    var meta = document.querySelector('meta[http-equiv="content-language"]');
    var content = meta ? (meta.getAttribute('content') || '').trim() : '';
    if (content) return content.split(',')[0].trim();

    if (langHint) return langHint.split(',')[0].trim();
    return 'en';
  }

  /**
   * Word count for the "about N minutes" estimate. Splitting on whitespace is
   * meaningless for Chinese, Japanese and Thai, which do not use it, so CJK
   * characters are counted individually and treated as words of their own.
   */
  function wordCount(blocks) {
    var total = 0;
    for (var i = 0; i < blocks.length; i++) {
      var text = blocks[i].text || '';
      var cjk = text.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿฀-๿]/g);
      var cjkCount = cjk ? cjk.length : 0;
      var rest = cjkCount ? text.replace(/[぀-ヿ㐀-䶿一-鿿豈-﫿฀-๿]/g, ' ') : text;
      var words = rest.trim() ? rest.trim().split(/\s+/).length : 0;
      total += words + cjkCount;
    }
    return total;
  }

  /* --------------------------------------------------------------- highlight */

  var current = null;
  var sentenceSpan = null;

  function clearSentenceHighlight() {
    if (sentenceSpan && sentenceSpan.parentNode) {
      // Unwrap: replace <span.ral-sentence>text</span> with just the text node
      var parent = sentenceSpan.parentNode;
      while (sentenceSpan.firstChild) parent.insertBefore(sentenceSpan.firstChild, sentenceSpan);
      parent.removeChild(sentenceSpan);
      parent.normalize();
    }
    sentenceSpan = null;
  }

  function clearHighlight() {
    clearSentenceHighlight();
    if (current) {
      current.classList.remove(HIGHLIGHT_CLASS);
      current = null;
    }
    var stragglers = document.getElementsByClassName(HIGHLIGHT_CLASS);
    while (stragglers.length) stragglers[0].classList.remove(HIGHLIGHT_CLASS);
    // Clean up any orphaned sentence spans
    var orphans = document.getElementsByClassName('ral-sentence');
    while (orphans.length) {
      var span = orphans[0];
      var p = span.parentNode;
      while (span.firstChild) p.insertBefore(span.firstChild, span);
      p.removeChild(span);
      if (p) p.normalize();
    }
  }

  /**
   * True when enough of the element is already on screen to leave the page
   * alone. Scrolling on every sentence is nauseating; scrolling only when the
   * reader has fallen off the screen feels like the page is following along.
   */
  function inViewport(el) {
    var rect = el.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!rect.height && !rect.width) return true; // nothing to scroll to
    var pad = Math.min(80, vh * 0.1);
    var fullyInside = rect.top >= -pad && rect.bottom <= vh + pad;
    // A block taller than the window is "in view" while it straddles the middle.
    var straddlesMiddle = rect.top <= vh / 2 && rect.bottom >= vh / 2;
    return fullyInside || straddlesMiddle;
  }

  /**
   * Highlight a sentence within the active block element.
   * Wraps the first text occurrence of sentenceText in a <span class="ral-sentence">.
   * This allows users to read along visually with the audio.
   *
   * @param {Element} el  - The active block element (from uid lookup)
   * @param {string} sentenceText - The sentence text to highlight (stripped of Fish markup)
   */
  function highlightSentence(el, sentenceText) {
    clearSentenceHighlight();
    if (!sentenceText || !el) return;

    // Strip Fish markup from sentence text for matching against plain DOM text
    var clean = sentenceText.replace(/\[(?:long-)?break\]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length < 4) return;

    // Use TreeWalker to find the text node containing our sentence
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    var node;
    // Build a combined text to find offset, then locate the exact node
    var combinedText = '';
    var nodes = [];
    while ((node = walker.nextNode())) {
      nodes.push({ node: node, start: combinedText.length });
      combinedText += node.nodeValue;
    }

    // Use first 40 chars of clean text for matching (avoids false positives)
    var matchStr = clean.slice(0, Math.min(40, clean.length));
    var idx = combinedText.indexOf(matchStr);
    if (idx < 0) return;

    // Find which text node contains the start of our sentence
    var targetEntry = null;
    for (var i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].start <= idx) {
        targetEntry = nodes[i];
        break;
      }
    }
    if (!targetEntry) return;

    var textNode = targetEntry.node;
    var localIdx = idx - targetEntry.start;
    if (localIdx < 0 || localIdx >= textNode.nodeValue.length) return;

    try {
      var range = document.createRange();
      range.setStart(textNode, localIdx);
      var endOffset = Math.min(localIdx + clean.length, textNode.nodeValue.length);
      range.setEnd(textNode, endOffset);

      var span = document.createElement('span');
      span.className = 'ral-sentence';
      range.surroundContents(span);
      sentenceSpan = span;
    } catch (e) {
      // surroundContents can throw if the range crosses element boundaries
      // Silently ignore — the block-level highlight is still active
    }
  }

  function highlight(uid, autoScroll, sentenceText) {
    clearHighlight();
    if (!uid || !RAL.uidMap) return false;

    var el = RAL.uidMap.get(uid);
    // The node can be gone: single-page apps re-render, and the uid then points
    // at an element that is no longer in the document.
    if (!el || !el.isConnected) return false;

    el.classList.add(HIGHLIGHT_CLASS);
    current = el;

    // Apply sentence-level highlight within the block if text is provided
    if (sentenceText) highlightSentence(el, sentenceText);

    if (autoScroll && !inViewport(el)) {
      try {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (e) {
        el.scrollIntoView(true); // older engines reject the options object
      }
    }
    return true;
  }

  /* ----------------------------------------------------------------- extract */

  function runExtract(payload) {
    // Stamping rewrites every uid, so an old highlight would survive pointing at
    // an element that is no longer the one being read.
    clearHighlight();

    var result = RAL.extract(payload || {});
    var blocks = result.blocks || [];

    return {
      ok: result.ok,
      title: result.title || document.title || location.hostname,
      byline: result.byline || null,
      siteName: result.siteName || null,
      lang: detectLang(result.langHint),
      url: location.href,
      strategy: result.strategy,
      blocks: blocks,
      wordCount: wordCount(blocks),
      reason: result.reason || null,
    };
  }

  function failure(reason) {
    return {
      ok: false,
      title: document.title || location.hostname,
      byline: null,
      siteName: location.hostname,
      lang: detectLang(null),
      url: location.href,
      strategy: 'none',
      blocks: [],
      wordCount: 0,
      reason: reason,
    };
  }

  /* ----------------------------------------------------------------- routing */

  chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
    if (!msg || typeof msg.type !== 'string') return false;

    if (msg.type === Msg.DO_EXTRACT) {
      // Deferred so a slow extraction runs outside the dispatch frame; the
      // channel stays open because the listener returns true below.
      setTimeout(function () {
        var result;
        try {
          result = runExtract(msg.payload);
        } catch (err) {
          result = failure('Could not read this page: ' + ((err && err.message) || 'unexpected error'));
        }
        try {
          reply(result);
        } catch (e) {
          // The worker was torn down while we were extracting. Nothing to do.
        }
      }, 0);
      return true;
    }

    if (msg.type === Msg.HIGHLIGHT) {
      var payload = msg.payload || {};
      var applied = false;
      try {
        applied = highlight(payload.uid, !!payload.autoScroll, payload.sentenceText || null);
      } catch (e) {
        applied = false;
      }
      reply({ ok: applied });
      return false;
    }

    if (msg.type === Msg.CLEAR_HIGHLIGHT) {
      try { clearHighlight(); } catch (e) { /* nothing sensible to recover */ }
      reply({ ok: true });
      return false;
    }

    return false;
  });

  /** Leaving a highlight behind after the tab navigates would look like a bug. */
  window.addEventListener('pagehide', clearHighlight);

  RAL.installed = true;
})();
