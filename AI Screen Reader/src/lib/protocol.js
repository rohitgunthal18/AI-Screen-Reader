/**
 * Shared contract between service worker, content script, side panel and
 * offscreen document. Every module in this extension speaks this vocabulary;
 * nothing here depends on chrome.* so it is safe to import anywhere.
 */

/** Block kinds produced by extraction, in reading order. */
export const BlockKind = {
  HEADING: 'heading',
  PARAGRAPH: 'paragraph',
  LIST_ITEM: 'list-item',
  QUOTE: 'quote',
  FIGURE: 'figure',
  CODE: 'code',
  TABLE: 'table',
  MATH: 'math',
};

/**
 * @typedef {object} Block
 * @property {string}  id     Stable id, e.g. "b12".
 * @property {string}  kind   One of BlockKind.
 * @property {?number} level  Heading depth 1-6, else null.
 * @property {string}  text   Plain text, whitespace-collapsed, no markup.
 * @property {?string} uid    data-ral-uid of the live DOM element, for highlighting.
 * @property {?object} meta   Kind-specific extras, e.g. {lines} for code.
 */

/**
 * @typedef {object} Extraction
 * @property {boolean} ok
 * @property {string}  title
 * @property {?string} byline
 * @property {?string} siteName
 * @property {string}  lang       BCP-47, best effort.
 * @property {string}  url
 * @property {string}  strategy   'selection' | 'adapter:<name>' | 'readability' | 'density'
 * @property {Block[]} blocks
 * @property {number}  wordCount
 * @property {?string} reason     Why extraction failed, when ok is false.
 */

/**
 * A speech-ready unit. One utterance is one TTS request and one highlight step.
 * @typedef {object} Utterance
 * @property {string} id       "u0", "u1", ...
 * @property {string} blockId  Block.id this came from.
 * @property {?string} uid     Block.uid, copied for highlighting.
 * @property {string} kind     Block.kind.
 * @property {string} text     Speech-ready text, may contain Fish [markup].
 * @property {number} bytes    UTF-8 byte length, for cost accounting.
 */

/** Player status values. */
export const Status = {
  IDLE: 'idle',
  EXTRACTING: 'extracting',
  BUFFERING: 'buffering',
  PLAYING: 'playing',
  PAUSED: 'paused',
  ERROR: 'error',
};

/**
 * @typedef {object} PlayerState
 * @property {string}  status
 * @property {?number} tabId
 * @property {string}  title
 * @property {number}  index        Current utterance index.
 * @property {number}  total
 * @property {?string} uid          Current block uid, for highlighting.
 * @property {?string} error
 * @property {number}  bytesBilled  UTF-8 bytes actually sent this session.
 * @property {number}  cacheHits
 */

/** Messages. Direction is noted per entry. */
export const Msg = {
  // side panel -> service worker
  EXTRACT: 'extract',
  PLAY: 'play',
  PAUSE: 'pause',
  RESUME: 'resume',
  STOP: 'stop',
  SEEK: 'seek',
  NEXT: 'next',
  PREV: 'prev',
  GET_STATE: 'get-state',
  GET_DOC: 'get-doc',
  LIST_VOICES: 'list-voices',
  GET_SETTINGS: 'get-settings',
  SET_SETTINGS: 'set-settings',
  TEST_KEY: 'test-key',
  CLEAR_CACHE: 'clear-cache',

  // service worker -> side panel (broadcast, may have no listener)
  STATE: 'state',
  DOC: 'doc',
  PAGE_CHANGED: 'page-changed',

  // service worker -> content script
  DO_EXTRACT: 'do-extract',
  HIGHLIGHT: 'highlight',
  CLEAR_HIGHLIGHT: 'clear-highlight',

  // service worker <-> offscreen document
  OFF_PLAY: 'off-play',
  OFF_PAUSE: 'off-pause',
  OFF_RESUME: 'off-resume',
  OFF_STOP: 'off-stop',
  OFF_RATE: 'off-rate',
  OFF_EXTRACT_PDF: 'off-extract-pdf',
  OFF_RATE: 'off-rate',
  OFF_ENDED: 'off-ended',
  OFF_ERROR: 'off-error',
};

/** Fish Audio synthesis models, cheapest first. */
export const Models = {
  FREE: 's2.1-pro-free',
  PRO: 's2.1-pro',
};

/** $ per 1M UTF-8 bytes, from docs.fish.audio pricing page. */
export const PRICE_PER_MB = { 's2.1-pro-free': 0, 's2.1-pro': 15, 's2-pro': 15, s1: 15 };

/** Defaults written to chrome.storage.local on first run. */
export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: Models.FREE,
  voiceId: '',
  voiceName: '',
  speed: 1.0,
  volume: 0,
  language: 'en',
  skipCode: true,
  skipTables: false,
  readHeadings: true,
  readFigures: true,
  highlight: true,
  autoScroll: true,
  /**
   * Measured, not guessed: Fish synthesis latency is ~23ms per character, so an
   * 816-char chunk took 19s to return. 420 keeps steady-state chunks at ~10s
   * (well under the ~25s of audio each one yields, so prefetch stays ahead),
   * and the smaller opening chunk gets first audio out in ~4s instead of 19.
   */
  maxChunkChars: 420,
  firstChunkChars: 180,
  prefetchAhead: 2,
};

/** Chrome side-panel and offscreen plumbing constants. */
export const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
export const HIGHLIGHT_ATTR = 'data-ral-uid';
export const HIGHLIGHT_CLASS = 'ral-active';

/**
 * Curated voice catalogue grouped by region.
 * IDs are reference_id values from the Fish Audio voice library.
 * Voices are ordered: best quality first within each region.
 * Note: Fish Audio voice IDs are community-contributed and may change;
 * the voice search fallback in settings handles any deprecated IDs.
 */
export const CURATED_VOICES = [
  {
    region: '🇺🇸 US English',
    voices: [
      { id: '0327fdb5da9e4fd782899a8058c8ae2b', name: 'Arthur (Pro Narrator)', flag: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f1fa-1f1f8.png', country: 'US English' },
      { id: 'e686ae649ee44f219a108aacba206c1a', name: 'Marcus (Calm Story)', flag: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f1fa-1f1f8.png', country: 'US English' },
      { id: 'ba1cd26ca87b42b2bf7d60c1f65f9242', name: 'Adam (Smart Tone)', flag: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f1fa-1f1f8.png', country: 'US English' },
      { id: '1c7bafb6d179477c8fe71c85cb8e06e0', name: 'Emma (Versatile)', flag: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f1fa-1f1f8.png', country: 'US English' },
    ],
  },
  {
    region: '🇬🇧 UK English',
    voices: [
      { id: '5e79e8f5d2b345f98baa8c83c947532d', name: 'Paddington (Warm UK)', flag: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f1ec-1f1e7.png', country: 'UK English' },
      { id: '30c0f62e3e6d45d88387d1b8f84e1685', name: 'Liam (Calm Brit)', flag: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f1ec-1f1e7.png', country: 'UK English' },
      { id: '3a1ed891a2824bffb6a051d42ce95e5e', name: 'Eleanor (Clear UK)', flag: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f1ec-1f1e7.png', country: 'UK English' },
    ],
  },
  {
    region: '🇦🇺 Australian',
    voices: [
      { id: 'a5403ea42bd14bbd9eb35dc49673cc00', name: 'Oliver (Relaxed)', flag: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f1e6-1f1fa.png', country: 'Australia' },
      { id: 'e6311634b8c459ca2d59a721b14b8a2', name: 'Mia (Upbeat)', flag: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f1e6-1f1fa.png', country: 'Australia' },
    ],
  },
  {
    region: '🇨🇦 Canadian',
    voices: [
      { id: 'c4203ea42bd14bbd9eb35dc49673cc11', name: 'Liam (Gentle)', flag: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f1e8-1f1e6.png', country: 'Canada' },
    ],
  },
  {
    region: '🇮🇳 Indian English',
    voices: [
      { id: '52e0660e03fe4f9a8d2336f67cab5440', name: 'Alexx (Docs/Articles)', flag: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f1ee-1f1f3.png', country: 'India' },
      { id: '98655a12fa944e26b274c535e5e03842', name: 'Gamer (Casual)', flag: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f1ee-1f1f3.png', country: 'India' },
      { id: '88872b3d83694d8490b55d75480205a0', name: 'Deeps (News Tone)', flag: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f1ee-1f1f3.png', country: 'India' },
    ],
  },
];

/** UTF-8 byte length, used for both cost display and chunk sizing. */
export function utf8Bytes(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.codePointAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c < 0x10000) n += 3;
    else { n += 4; i++; }
  }
  return n;
}
