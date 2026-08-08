/**
 * Read-a-Laud audio player.
 *
 * WHY THIS FILE EXISTS AT ALL — the single most important design fact in this
 * codebase. An MV3 service worker cannot play audio: there is no `Audio`
 * constructor and no `URL.createObjectURL` in a worker, and the worker is torn
 * down after roughly 30s of idle, which is shorter than one paragraph of speech.
 * On top of that, `chrome.runtime.sendMessage` structured-clones its payload to
 * JSON, so a Blob or an ArrayBuffer CANNOT be handed from the worker to another
 * context — it would arrive as `{}`.
 *
 * Those two facts together mean the audio cannot be split across contexts: the
 * side that fetches the bytes must also be the side that plays them. So this
 * offscreen document owns the ENTIRE audio path — network fetch, IndexedDB
 * cache, decode and playback. The service worker only ships text plus settings
 * in, and receives progress events back out. It never sees a byte of audio.
 *
 * Message contract, all over the shared runtime bus:
 *   in  (target:'offscreen')  OFF_PLAY {utterances, settings, startIndex}
 *                             OFF_PAUSE / OFF_RESUME / OFF_STOP / OFF_RATE {speed}
 *   out (no target)           OFF_ENDED {index, uid, status, bytesBilled, cacheHits}
 *                             OFF_ERROR {message, hint}
 */

import { Msg, Status, DEFAULT_SETTINGS } from '../lib/protocol.js';
import { FishClient, Semaphore } from '../lib/fish.js';
import { AudioCache } from '../lib/cache.js';
import { SynthesisPipeline } from './pipeline.js';

const cache = new AudioCache();

/**
 * One limiter for the lifetime of the document, handed to every FishClient we
 * build. Clients are rebuilt when the key or model changes, and a fresh
 * Semaphore per client would let a burst of session churn push more concurrent
 * requests at the account than the tier allows.
 */
const requests = new Semaphore(4);

let clientCache = { apiKey: null, model: null, client: null };

function clientFor(settings) {
  if (clientCache.client && clientCache.apiKey === settings.apiKey && clientCache.model === settings.model) {
    return clientCache.client;
  }
  const client = new FishClient({ apiKey: settings.apiKey, model: settings.model, semaphore: requests });
  clientCache = { apiKey: settings.apiKey, model: settings.model, client };
  return client;
}

/* -------------------------------------------------------------- reporting */

/**
 * Every outbound message is wrapped. The worker may have been torn down, the
 * side panel is usually closed, and `sendMessage` with no listener REJECTS —
 * an unhandled rejection here would kill playback for a message nobody needed.
 */
function send(type, payload) {
  try {
    chrome.runtime.sendMessage({ type, payload }).catch(() => {});
  } catch {
    /* context already gone */
  }
}

/**
 * Progress for one chunk. The message type is OFF_ENDED for historical reasons;
 * the worker treats it as a generic progress event and reads position, status
 * and cost off it, so it is sent when a chunk STARTS as well as at completion.
 */
function report(index, status, uid = session.utterances[index]?.uid ?? null) {
  send(Msg.OFF_ENDED, {
    index,
    uid,
    status,
    bytesBilled: session.billed.bytesBilled + (session.pipeline?.bytesBilled || 0),
    cacheHits: session.billed.cacheHits + (session.pipeline?.cacheHits || 0),
  });
}

function reportError(err) {
  send(Msg.OFF_ERROR, {
    message: err?.message || String(err),
    hint: err?.hint || null,
  });
}

/* ------------------------------------------------------------------ state */

/**
 * Playback is a ping-pong between two Audio elements: while one plays, the
 * other already has the next chunk's blob URL attached and buffered, so the
 * handoff at `ended` is a single .play() call rather than a network round trip.
 *
 * This is deliberately sequential blob playback and not MediaSource. The chunks
 * come back as separately-encoded MP3s, and every MP3 carries encoder delay and
 * end padding; appending them into one SourceBuffer splices those artifacts
 * mid-stream and you hear clicks and swallowed syllables at every join. Two
 * elements instead give a small, consistent gap between chunks — which, for
 * speech split on sentence boundaries, reads as natural punctuation and is far
 * less objectionable than a click in the middle of a word.
 */
const slots = [makeSlot(), makeSlot()];

const session = {
  /** Bumped by every teardown. Async work compares against it and gives up. */
  token: 0,
  utterances: [],
  settings: { ...DEFAULT_SETTINGS },
  pipeline: null,
  current: null,
  /** Cost carried over from earlier plays of the same queue, so seeking back does not make the meter fall. */
  billed: { bytesBilled: 0, cacheHits: 0 },
  signature: '',
  errored: false,
};

function makeSlot() {
  const el = new Audio();
  el.preload = 'auto';
  el.autoplay = false;
  // NOT settings.volume: that is Fish's prosody volume in dB (-20..20) and is
  // applied server-side at synthesis. Feeding it to an element whose volume is
  // a 0..1 gain would mute playback outright at the default of 0.
  el.volume = 1;
  return { el, index: -1, url: null, state: 'empty', ready: Promise.resolve(), settled: true, stop: null, fail: null };
}

/**
 * Speed is a playbackRate change: instant, free, and applied to audio we have
 * already paid for. Sending it as Fish's `prosody.speed` instead would make
 * every nudge of the slider a full re-synthesis — re-billed, and a different
 * cache key for every chunk. preservesPitch keeps the voice from turning
 * chipmunky, and is re-applied on every src change because it does not reliably
 * survive one.
 */
function applyRate(el) {
  const speed = Number(session.settings.speed);
  el.playbackRate = Number.isFinite(speed) ? Math.min(Math.max(speed, 0.5), 4) : 1;
  el.preservesPitch = true;
}

/**
 * Detach and free a slot. Revoking matters: a blob URL pins its Blob in memory
 * until revoked, and an hour-long article is hundreds of MP3s. Leaking them in a
 * document that lives as long as this one does is a real, growing memory cost.
 */
function release(slot) {
  try {
    slot.el.pause();
  } catch {
    /* already detached */
  }
  // Detach before revoking, or the element sits on a dangling URL and fires a
  // spurious error event the next time it touches its source.
  slot.el.removeAttribute('src');
  try {
    slot.el.load();
  } catch {
    /* ignore */
  }
  if (slot.url) {
    URL.revokeObjectURL(slot.url);
    slot.url = null;
  }
  slot.state = 'empty';
  slot.index = -1;
}

/** Load one utterance into a slot. Resolves `slot.ready`; never throws. */
function prepare(slot, index, token) {
  release(slot);
  slot.index = index;
  slot.settled = false;
  slot.ready = (async () => {
    if (index >= session.utterances.length) {
      slot.state = 'end';
      return;
    }
    const blob = await session.pipeline.audioFor(index);
    // A seek or a stop may have landed while we were waiting.
    if (token !== session.token || slot.index !== index) return;
    if (!blob) {
      slot.state = 'skip';
      return;
    }
    slot.url = URL.createObjectURL(blob);
    slot.el.src = slot.url;
    applyRate(slot.el);
    slot.el.load();
    slot.state = 'ready';
  })()
    .catch((err) => {
      console.warn(`[read-a-laud] could not prepare utterance ${index}:`, err?.message || err);
      slot.state = 'skip';
    })
    .finally(() => {
      slot.settled = true;
    });
  return slot.ready;
}

/**
 * Resolves with why this chunk stopped: 'ended' (natural), 'error' (media or
 * play() failure, skip it) or 'stopped' (session torn down). Listeners are
 * always removed, so elements can be reused across sessions indefinitely.
 */
function waitForEnd(slot) {
  return new Promise((resolve) => {
    const onEnded = () => finish('ended');
    const onError = () => finish('error');
    function finish(why) {
      slot.el.removeEventListener('ended', onEnded);
      slot.el.removeEventListener('error', onError);
      slot.stop = null;
      slot.fail = null;
      resolve(why);
    }
    slot.el.addEventListener('ended', onEnded);
    slot.el.addEventListener('error', onError);
    slot.stop = () => finish('stopped');
    slot.fail = () => finish('error');
  });
}

/* ----------------------------------------------------------------- driver */

async function run(startIndex, token) {
  let index = Math.max(0, Math.min(startIndex, session.utterances.length - 1));
  let current = slots[0];
  let next = slots[1];

  session.pipeline.setIndex(index);
  prepare(current, index, token);

  while (token === session.token && index < session.utterances.length) {
    // Only claim BUFFERING if the audio is not already sitting in hand.
    if (!current.settled) report(index, Status.BUFFERING);
    await current.ready;
    if (token !== session.token) return;

    if (current.state === 'skip') {
      // A permanently failed utterance must not wedge the queue. The pipeline
      // has already reported why, so this only needs to move on.
      console.warn(`[read-a-laud] no audio for utterance ${index}, skipping`);
      index++;
      session.pipeline.setIndex(index);
      prepare(current, index, token);
      continue;
    }
    if (current.state !== 'ready') break; // ran off the end of the queue

    session.current = current;
    const ending = waitForEnd(current);
    applyRate(current.el);

    // Not awaited: the next chunk should start loading now, not after this one
    // has actually begun sounding.
    current.el.play().then(
      () => {
        if (token === session.token && current.index === index) report(index, Status.PLAYING);
      },
      (err) => {
        // Nothing will start this element now; treat it as a dead chunk so the
        // loop's error path skips it rather than waiting for an 'ended' that
        // will never come.
        noteError(err, `could not start playback of utterance ${index}`);
        current.fail?.();
      },
    );
    prepare(next, index + 1, token);

    const why = await ending;
    if (token !== session.token) return;
    if (why === 'stopped') return;
    if (why === 'error') {
      const media = current.el.error;
      noteError(
        new Error(media?.message || `Audio decode failed (code ${media?.code ?? '?'})`),
        `playback error at utterance ${index}`,
      );
    }

    release(current);
    index++;
    session.pipeline.setIndex(index);
    [current, next] = [next, current];
  }

  if (token !== session.token) return;
  // End of queue: report the final position with no uid so the panel stops
  // showing a highlighted line, then release everything.
  report(Math.max(0, session.utterances.length - 1), Status.IDLE, null);
  teardown();
}

/* -------------------------------------------------------------- lifecycle */

/**
 * Invalidate the session and free every resource it holds. Synchronous on
 * purpose: a new OFF_PLAY must be able to start from a clean slate immediately,
 * and anything still in flight notices the bumped token and drops its result.
 * The pipeline is disposed but kept referenced, because its counters are what
 * the next play of the same queue carries forward.
 */
function teardown() {
  session.token++;
  session.current = null;
  for (const slot of slots) {
    slot.stop?.();
    release(slot);
  }
  session.pipeline?.dispose();
}

/**
 * One error report per session. A bad key or a dead account fails every
 * utterance identically; the first report is the signal and the other four
 * hundred are noise that would only overwrite it with the same string. Playback
 * keeps going either way — reporting is not stopping.
 */
function noteError(err, where) {
  console.warn(`[read-a-laud] ${where}:`, err?.message || err);
  if (session.errored) return;
  session.errored = true;
  reportError(err);
}

function onPipelineError(err, index) {
  noteError(err, `synthesis failed at utterance ${index}`);
}

function startPlay(payload) {
  const utterances = Array.isArray(payload?.utterances) ? payload.utterances : [];
  const settings = { ...DEFAULT_SETTINGS, ...(payload?.settings || {}) };
  const startIndex = Number(payload?.startIndex) || 0;

  // Same queue and voice as last time (a seek, a next/prev) means the cost so
  // far still applies. A different document restarts the meter at zero.
  const signature = SynthesisPipeline.signature(utterances, settings);
  const carry =
    signature === session.signature
      ? {
          bytesBilled: session.billed.bytesBilled + (session.pipeline?.bytesBilled || 0),
          cacheHits: session.billed.cacheHits + (session.pipeline?.cacheHits || 0),
        }
      : { bytesBilled: 0, cacheHits: 0 };

  // Every OFF_PLAY is a hard restart: the previous session is fully torn down
  // before the new one exists, so two overlapping plays can never share slots.
  teardown();

  if (!utterances.length) {
    reportError(new Error('Nothing to read.'));
    return;
  }
  if (!settings.apiKey) {
    reportError(
      Object.assign(new Error('No API key.'), {
        hint: 'Add your Fish Audio API key in Read-a-Laud settings.',
      }),
    );
    return;
  }

  session.utterances = utterances;
  session.settings = settings;
  session.signature = signature;
  session.billed = carry;
  session.errored = false;
  session.pipeline = new SynthesisPipeline({
    client: clientFor(settings),
    cache,
    settings,
    onError: onPipelineError,
  });
  session.pipeline.load(utterances);

  // Detached: the worker is awaiting the reply to this message, and playback
  // takes minutes.
  run(startIndex, session.token).catch((err) => {
    console.error('[read-a-laud] player crashed:', err);
    reportError(err);
  });
}

/* ------------------------------------------------------------ message bus */

const handlers = {
  [Msg.OFF_PLAY]: (p) => {
    startPlay(p);
    return { ok: true };
  },

  [Msg.OFF_PAUSE]: () => {
    session.current?.el.pause();
    return { ok: true };
  },

  [Msg.OFF_RESUME]: () => {
    session.current?.el.play().catch((err) => {
      console.warn('[read-a-laud] resume failed:', err?.message || err);
    });
    return { ok: true };
  },

  [Msg.OFF_STOP]: () => {
    teardown();
    return { ok: true };
  },

  [Msg.OFF_RATE]: (p) => {
    const speed = Number(p?.speed);
    if (Number.isFinite(speed)) {
      session.settings = { ...session.settings, speed };
      for (const slot of slots) applyRate(slot.el);
    }
    return { ok: true };
  },

  [Msg.OFF_EXTRACT_PDF]: async (p) => {
    try {
      if (!window.pdfjsLib) {
        throw new Error("PDF.js library not loaded in offscreen document.");
      }
      pdfjsLib.GlobalWorkerOptions.workerSrc = '../lib/pdf.worker.min.js';
      
      let loadingTask;
      if (p.base64) {
        const binaryStr = atob(p.base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        loadingTask = pdfjsLib.getDocument({ data: bytes });
      } else {
        loadingTask = pdfjsLib.getDocument(p.url);
      }
      
      const pdf = await loadingTask.promise;
      
      const utterances = [];
      let totalWords = 0;
      
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const strings = content.items.map(item => item.str);
        const text = strings.join(' ').replace(/\s+/g, ' ').trim();
        
        if (text) {
          totalWords += text.split(/\s+/).length;
          utterances.push({ text: text, kind: 'paragraph' });
        }
      }
      
      const filename = p.url.split('/').pop().split('?')[0] || 'PDF Document';
      return { 
        ok: true, 
        title: decodeURIComponent(filename), 
        strategy: 'pdfjs',
        lang: 'en',
        blocks: utterances,
        wordCount: totalWords
      };
    } catch (err) {
      console.error('[read-a-laud] PDF extraction failed:', err);
      return { ok: false, reason: err.message || String(err) };
    }
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // CRITICAL: the worker, the side panel and this document share one bus, and
  // the worker itself listens for OFF_ENDED. Answering anything not addressed
  // here turns progress reports into loops and swallows replies meant for
  // someone else.
  if (msg?.target !== 'offscreen') return false;

  const handler = handlers[msg.type];
  if (!handler) return false;

  const safeReply = (value) => {
    try {
      reply(value);
    } catch {
      /* the sender went away mid-flight */
    }
  };

  Promise.resolve()
    .then(() => handler(msg.payload || {}))
    .then((result) => safeReply(result ?? { ok: true }))
    .catch((err) => {
      console.error('[read-a-laud] offscreen handler failed:', err);
      safeReply({ ok: false, reason: err?.message || String(err) });
    });

  return true; // reply happens on a later tick
});

// Warm the cache connection now rather than on the first chunk, where the open
// would sit directly in front of time-to-first-audio.
cache.open().catch(() => {});

