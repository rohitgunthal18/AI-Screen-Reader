/**
 * Sentence segmentation.
 *
 * Sentence boundaries decide three things at once: how fast the first audio
 * arrives, how granular the in-page highlight is, and how natural the prosody
 * sounds. Getting them wrong is audible.
 */

/**
 * Split text into sentences.
 *
 * Intl.Segmenter is the right base: it ships in Chrome, is locale-aware, and
 * handles Devanagari danda (।) and CJK punctuation without special-casing.
 *
 * But it implements UAX #29, which has NO abbreviation exception list — so it
 * genuinely breaks "Dr. Bose" and "Fig. 3" into two sentences. Left alone that
 * produces choppy prosody and a wasted micro-request per fragment, so the
 * output is repaired by `rejoinAbbreviations` below.
 *
 * @param {string} text
 * @param {string} lang BCP-47
 * @returns {string[]}
 */
export function segmentSentences(text, lang = 'en') {
  const clean = (text || '').trim();
  if (!clean) return [];

  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const seg = new Intl.Segmenter(lang, { granularity: 'sentence' });
      const out = [];
      for (const { segment } of seg.segment(clean)) {
        const s = segment.trim();
        if (s) out.push(s);
      }
      if (out.length) return rejoinAbbreviations(out);
    } catch {
      // Bad locale tag; fall through to the regex splitter.
    }
  }
  return regexSplit(clean);
}

/** Tokens that end in "." but do not end a sentence. */
const ABBR = [
  'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Sr', 'Jr', 'St', 'Mt', 'Rev', 'Hon',
  'e\\.g', 'i\\.e', 'etc', 'cf', 'vs', 'viz', 'al', 'Fig', 'Eq', 'No', 'Vol',
  'approx', 'est', 'dept', 'Inc', 'Ltd', 'Co',
];

/**
 * True when a segment ends in something that is not really a sentence end:
 * a known abbreviation, a single initial ("A."), a dotted acronym ("U.S."),
 * or a dangling number ("1.").
 */
const DANGLING = new RegExp(
  `(?:\\b(?:${ABBR.join('|')})\\.|\\b[A-Z]\\.|\\b(?:[A-Za-z]\\.){2,}|\\b\\d+\\.)$`,
);

/**
 * Repair over-eager UAX #29 splits by gluing a segment back onto the next one
 * when it ends mid-abbreviation. Runs to a fixed point so "Ph.D. vs. M.Sc."
 * collapses correctly rather than only healing one join.
 */
export function rejoinAbbreviations(segments) {
  const out = [];
  for (const seg of segments) {
    if (out.length && DANGLING.test(out[out.length - 1])) {
      out[out.length - 1] += ` ${seg}`;
    } else {
      out.push(seg);
    }
  }
  return out;
}

/**
 * Fallback splitter. Protects abbreviations, single initials, decimals,
 * ellipses and numbered-list prefixes by masking their periods before the
 * split and restoring them after — far simpler than one heroic lookbehind.
 */
function regexSplit(text) {
  const DOT = '';
  let masked = text;

  masked = masked.replace(new RegExp(`\\b(${ABBR.join('|')})\\.`, 'g'), (_, w) => `${w}${DOT}`);
  masked = masked.replace(/\b([A-Z])\./g, `$1${DOT}`);          // initials: A. B.
  masked = masked.replace(/(\d)\.(\d)/g, `$1${DOT}$2`);          // decimals: 3.14
  masked = masked.replace(/\.\.\./g, `${DOT}${DOT}${DOT}`);      // ellipsis
  masked = masked.replace(/^(\s*\d+)\.(\s)/gm, `$1${DOT}$2`);    // "1. item"

  return masked
    .split(/(?<=[.!?。！？।])\s+/)
    .map((s) => s.split(DOT).join('.').trim())
    .filter(Boolean);
}

/**
 * Greedily merge adjacent sentences up to maxChars.
 *
 * One request per short sentence is the worst of both worlds: it wastes a
 * round-trip each time and makes prosody choppy, because the model gets no
 * run-up. Overlong requests are the opposite failure — slow first audio and
 * coarse highlighting.
 *
 * `firstMax` exists because those two failures are not symmetric in time.
 * Measured against Fish s2.1-pro-free, synthesis latency runs roughly linear at
 * ~23ms per character: an 816-character chunk took 19s to come back. That is
 * fine for chunk five, which is prefetched while chunk four plays, and awful
 * for chunk one, which is nineteen seconds of silence after the user hits play.
 * So the opening chunk is deliberately small and the rest are full size.
 *
 * @param {string[]} sentences
 * @param {number} maxChars
 * @param {number} [firstMax] Cap for the first chunk only; defaults to maxChars.
 * @returns {string[]}
 */
export function mergeShort(sentences, maxChars = 420, firstMax = maxChars) {
  const out = [];
  let buf = '';
  for (const s of sentences) {
    const cap = out.length === 0 ? firstMax : maxChars;
    if (!buf) {
      buf = s;
    } else if (buf.length + 1 + s.length <= cap) {
      buf += ` ${s}`;
    } else {
      out.push(buf);
      buf = s;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Hard-split anything still longer than maxChars, preferring clause
 * boundaries. A single unpunctuated wall of text would otherwise become one
 * enormous request that stalls playback.
 */
export function hardWrap(text, maxChars = 1800) {
  if (text.length <= maxChars) return [text];
  const out = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const cut = Math.max(
      window.lastIndexOf('; '), window.lastIndexOf(', '),
      window.lastIndexOf(' — '), window.lastIndexOf(' '),
    );
    const at = cut > maxChars * 0.5 ? cut : maxChars;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}
