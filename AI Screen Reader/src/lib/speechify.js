/**
 * Turn extracted Blocks into speech-ready Utterances.
 *
 * Extraction decides *what* gets read; this module decides whether it sounds
 * like a person or like a screen reader from 2003. Most of the work is
 * removing things that look fine on screen and terrible in audio: citation
 * markers, raw URLs, code blocks, tables.
 */

import { BlockKind, utf8Bytes } from './protocol.js';
import { segmentSentences, mergeShort, hardWrap } from './segmenter.js';

/* ------------------------------------------------------------- transforms */

/**
 * Strip square brackets — the single most important transform here.
 *
 * Fish's S2 models read `[word]` as emotion/style markup, and real page text
 * is full of `[1]`, `[citation needed]`, `[edit]`. Left alone, those get
 * swallowed or voiced as stage directions, and the cause is nearly impossible
 * to guess from the garbled audio. So brackets are cleared from page text
 * BEFORE any of our own markup goes in — after this point, every remaining
 * bracket in the string is ours.
 */
export function stripBrackets(text) {
  return text
    // Wikipedia-style refs and editorial marks.
    .replace(/\[\s*(?:\d+|[a-z]|citation needed|edit|sic|note \d+|\.\.\.|…)\s*\]/gi, '')
    // Anything else in brackets: keep the words, drop the delimiters.
    .replace(/\[([^\]]{0,80})\]/g, (_, inner) => (inner.trim() ? ` ${inner.trim()} ` : ' '))
    .replace(/[[\]]/g, '');
}

const ABBREVIATIONS = [
  [/\be\.\s?g\.\s*/gi, 'for example, '],
  [/\bi\.\s?e\.\s*/gi, 'that is, '],
  [/\betc\.(?=\s|$)/gi, 'et cetera'],
  [/\bvs\.?(?=\s)/gi, 'versus'],
  [/\bcf\.(?=\s)/gi, 'compare'],
  [/\bviz\.(?=\s)/gi, 'namely'],
  [/\bapprox\.(?=\s)/gi, 'approximately'],
  [/\bFig\.\s*(?=\d)/g, 'Figure '],
  [/\bEq\.\s*(?=\d)/g, 'Equation '],
  [/\bVol\.\s*(?=\d)/g, 'Volume '],
  [/\bNo\.\s*(?=\d)/g, 'Number '],
  [/\bDr\.\s+/g, 'Doctor '],
  [/\bProf\.\s+/g, 'Professor '],
  [/\bMr\.\s+/g, 'Mister '],
  [/\bMrs\.\s+/g, 'Missus '],
  [/\bMs\.\s+/g, 'Miss '],
  [/\bSt\.\s+/g, 'Saint '],
  [/\bet\s+al\./gi, 'and others'],
];

const CURRENCY = [
  [/\$\s?(\d[\d,]*(?:\.\d+)?)/g, '$1 dollars'],
  [/₹\s?(\d[\d,]*(?:\.\d+)?)/g, '$1 rupees'],
  [/€\s?(\d[\d,]*(?:\.\d+)?)/g, '$1 euros'],
  [/£\s?(\d[\d,]*(?:\.\d+)?)/g, '$1 pounds'],
];

/** Only expanded when directly suffixing a number, so "Min" survives intact. */
const UNITS = [
  [/(\d)\s?km\b/g, '$1 kilometers'], [/(\d)\s?kg\b/g, '$1 kilograms'],
  [/(\d)\s?cm\b/g, '$1 centimeters'], [/(\d)\s?mm\b/g, '$1 millimeters'],
  [/(\d)\s?ft\b/g, '$1 feet'], [/(\d)\s?GHz\b/g, '$1 gigahertz'],
  [/(\d)\s?Hz\b/g, '$1 hertz'], [/(\d)\s?TB\b/g, '$1 terabytes'],
  [/(\d)\s?GB\b/g, '$1 gigabytes'], [/(\d)\s?MB\b/g, '$1 megabytes'],
  [/(\d)\s?KB\b/g, '$1 kilobytes'],
];

export function expandAbbreviations(text) {
  let out = text;
  for (const [re, to] of [...ABBREVIATIONS, ...CURRENCY, ...UNITS]) out = out.replace(re, to);
  return out
    .replace(/\s&\s/g, ' and ')
    .replace(/(\d)\s?%/g, '$1 percent')
    .replace(/#(?=\d)/g, 'number ')
    .replace(/\band\/or\b/gi, 'and or')
    .replace(/\s\+\s/g, ' plus ')
    .replace(/\s=\s/g, ' equals ')
    .replace(/(\S)@(\S)/g, '$1 at $2');
}

/**
 * Collapse URLs and emails. A full URL read character by character is
 * unlistenable, and the domain carries essentially all the useful meaning.
 */
export function collapseUrls(text) {
  return text
    .replace(/\b[\w.+-]+@([\w-]+)\.[\w.]+/g, (_, host) => `email at ${host}`)
    .replace(/\bhttps?:\/\/(?:www\.)?([^\s/]+)\S*/gi, (_, host) => host.replace(/\./g, ' dot '))
    .replace(/\bwww\.([^\s/]+)\S*/gi, (_, host) => host.replace(/\./g, ' dot '));
}

/** Invisible and look-alike characters that confuse the model or add nothing. */
export function tidy(text) {
  return text
    .replace(/[​-‍﻿­]/g, '')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—−]/g, ' - ')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Full prose pipeline. Bracket stripping must stay first. */
export function normalizeProse(text) {
  return tidy(expandAbbreviations(collapseUrls(stripBrackets(text))));
}

/** Anything with no letters or digits is unspeakable — bullets, rules, "***". */
export function isSpeakable(text) {
  return /[\p{L}\p{N}]/u.test(text);
}

/* ------------------------------------------------------------ kind handling */

/**
 * Pause markup. `[break]` / `[long-break]` is S2-family bracket syntax, which
 * ties this to the s2.1-pro and s2.1-pro-free models the extension defaults
 * to. The legacy s1 model uses parentheses instead, so switching to it would
 * mean these markers get read aloud as literal words.
 */
const BREAK = ' [break]';
const LONG_BREAK = ' [long-break]';

/** Captions this short or this generic carry no information worth hearing. */
const JUNK_CAPTION = /^(image|photo|picture|figure|graphic|icon|logo|screenshot|advertisement)\.?$/i;

/**
 * Linearize a table row-wise, pairing each cell with its column header.
 * Reading a table left-to-right without headers produces a stream of numbers
 * with no referent; pairing is the only way the audio stays meaningful.
 */
export function linearizeTable(text, meta = {}) {
  const rows = meta.cells;
  if (!Array.isArray(rows) || rows.length < 2) {
    return `Table. ${text}`;
  }
  const [headers, ...body] = rows;
  const parts = body.map((row, i) => {
    const pairs = row
      .map((cell, j) => {
        const head = headers[j];
        const value = String(cell || '').trim();
        if (!value) return null;
        return head ? `${String(head).trim()}, ${value}` : value;
      })
      .filter(Boolean);
    return `Row ${i + 1}: ${pairs.join('; ')}.`;
  });
  return `Table with ${body.length} rows. ${parts.join(' ')}`;
}

/**
 * Make code marginally listenable. Reading code verbatim is rarely useful —
 * punctuation dominates and indentation is invisible in audio — which is why
 * skipCode defaults to true and this is only the opt-in path.
 */
export function speakableCode(code) {
  return code
    .replace(/=>/g, ' arrow ')
    .replace(/===|==/g, ' equals ')
    .replace(/!==|!=/g, ' not equals ')
    .replace(/&&/g, ' and ')
    .replace(/\|\|/g, ' or ')
    .replace(/[{}()[\];]/g, ' ')
    .replace(/_/g, ' underscore ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------- main */

/**
 * @param {import('./protocol.js').Extraction} extraction
 * @param {object} settings
 * @returns {{utterances: import('./protocol.js').Utterance[], stats: object}}
 */
export function speechify(extraction, settings = {}) {
  const cfg = {
    readHeadings: true, readFigures: true, skipCode: true, skipTables: false,
    maxChunkChars: 420, firstChunkChars: 180, speed: 1, ...settings,
  };

  /**
   * Cap for the next chunk. Only the document's opening chunk gets the small
   * one — every later paragraph is prefetched behind playback, so there is no
   * latency to hide and full-size chunks read better.
   */
  const capFor = () => (utterances.length === 0 ? cfg.firstChunkChars : cfg.maxChunkChars);
  const lang = extraction.lang || 'en';
  const utterances = [];
  const skipped = { code: 0, tables: 0, figures: 0, math: 0 };
  let n = 0;

  /** An utterance never spans two blocks — highlight granularity depends on it. */
  const push = (block, text) => {
    const clean = tidy(text);
    if (!clean || !isSpeakable(clean)) return;
    for (const piece of hardWrap(clean, 1800)) {
      utterances.push({
        id: `u${n++}`,
        blockId: block.id,
        uid: block.uid || null,
        kind: block.kind,
        text: piece,
        bytes: utf8Bytes(piece),
      });
    }
  };

  for (const block of extraction.blocks || []) {
    const raw = block.text || '';

    switch (block.kind) {
      case BlockKind.HEADING: {
        if (!cfg.readHeadings) break;
        const text = normalizeProse(raw);
        if (!text) break;
        // A top-level section deserves a longer beat before it than a
        // subsection, which is most of what conveys structure in audio.
        const lead = (block.level || 2) <= 2 ? LONG_BREAK : '';
        push(block, `${lead} ${text}.${BREAK}`);
        break;
      }

      case BlockKind.PARAGRAPH: {
        const text = normalizeProse(raw);
        if (!text) break;
        for (const chunk of mergeShort(segmentSentences(text, lang), cfg.maxChunkChars, capFor())) {
          push(block, chunk);
        }
        break;
      }

      case BlockKind.QUOTE: {
        const text = normalizeProse(raw);
        if (!text) break;
        const chunks = mergeShort(segmentSentences(text, lang), cfg.maxChunkChars, capFor());
        chunks.forEach((chunk, i) => {
          const first = i === 0 ? 'Quote, ' : '';
          const last = i === chunks.length - 1 ? ' End quote.' : '';
          push(block, `${first}${chunk}${last}`);
        });
        break;
      }

      case BlockKind.LIST_ITEM: {
        const text = normalizeProse(raw);
        if (!text) break;
        // No "item one" announcements — the pause between items is enough,
        // and numbering that is already in the text is preserved as written.
        push(block, `${text}${BREAK}`);
        break;
      }

      case BlockKind.CODE: {
        const lines = block.meta?.lines || raw.split('\n').length;
        if (cfg.skipCode) {
          skipped.code++;
          push(block, `Code block, ${lines} ${lines === 1 ? 'line' : 'lines'}, skipped.${BREAK}`);
        } else {
          push(block, `Code block. ${speakableCode(stripBrackets(raw))}${BREAK}`);
        }
        break;
      }

      case BlockKind.TABLE: {
        const rows = block.meta?.rows || 0;
        const cols = block.meta?.cols || 0;
        if (cfg.skipTables) {
          skipped.tables++;
          push(block, `Table with ${rows} rows and ${cols} columns, skipped.${BREAK}`);
        } else {
          push(block, `${linearizeTable(normalizeProse(raw), block.meta)}${BREAK}`);
        }
        break;
      }

      case BlockKind.FIGURE: {
        const caption = normalizeProse(raw);
        const words = caption.split(/\s+/).filter(Boolean).length;
        if (!cfg.readFigures || words < 3 || JUNK_CAPTION.test(caption)) {
          skipped.figures++;
          break;
        }
        push(block, `Figure: ${caption}${BREAK}`);
        break;
      }

      case BlockKind.MATH: {
        const alt = normalizeProse(raw);
        if (alt) push(block, `${alt}${BREAK}`);
        else { skipped.math++; push(block, `Equation, skipped.${BREAK}`); }
        break;
      }

      default: {
        const text = normalizeProse(raw);
        if (text) push(block, text);
      }
    }
  }

  const totalBytes = utterances.reduce((sum, u) => sum + u.bytes, 0);
  const words = utterances.reduce((sum, u) => sum + u.text.split(/\s+/).length, 0);

  return {
    utterances,
    stats: {
      utterances: utterances.length,
      totalBytes,
      // Rough estimate only: ~155 wpm is typical for synthesized narration,
      // and playbackRate scales it linearly.
      estSeconds: Math.round((words / 155) * 60 / (cfg.speed || 1)),
      skipped,
    },
  };
}
