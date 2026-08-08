/**
 * Look-ahead synthesis pipeline: utterance text in, MP3 Blobs out, kept a
 * couple of chunks ahead of the play head so playback never waits on the
 * network mid-sentence.
 *
 * This runs in the offscreen document rather than the service worker because
 * a Blob cannot survive chrome.runtime.sendMessage (structured clone to JSON),
 * so whoever fetches the audio must also be the one that plays it.
 *
 * Money matters here: Fish Audio bills per UTF-8 byte of input text, so a
 * duplicated request is a duplicated charge. Two rules follow from that — every
 * index has at most one in-flight request no matter how many callers want it,
 * and `bytesBilled` counts cache misses only.
 */

import { cacheKey } from '../lib/cache.js';
import { utf8Bytes } from '../lib/protocol.js';

/** Blobs held in memory around the play head. The rest re-serve from IndexedDB. */
const MAX_BLOBS = 6;
const DEFAULT_AHEAD = 2;

function isAbortError(err) {
  return !!err && (err.name === 'AbortError' || err.code === 20);
}

export class SynthesisPipeline {
  /** @param {{client:import('../lib/fish.js').FishClient, cache:import('../lib/cache.js').AudioCache, settings:object, onError?:(err:Error, index:number)=>void}} opts */
  constructor({ client, cache, settings, onError }) {
    this.client = client;
    this.cache = cache;
    this.settings = settings || {};
    this.onError = onError || (() => {});

    const ahead = Number(this.settings.prefetchAhead);
    this.ahead = Number.isFinite(ahead) ? Math.max(0, Math.min(ahead, 8)) : DEFAULT_AHEAD;

    /** @type {import('../lib/protocol.js').Utterance[]} */
    this.utterances = [];
    this.head = 0;
    this.bytesBilled = 0;
    this.cacheHits = 0;
    this.closed = false;

    /** index -> {promise, controller}. The memo that stops duplicate charges. */
    this.inflight = new Map();
    /** index -> Blob, bounded by MAX_BLOBS. */
    this.blobs = new Map();
    /** Indices that failed permanently; playback skips these instead of wedging. */
    this.failed = new Set();
    /**
     * A bad key or an empty account fails identically for every utterance, so
     * remember it and stop firing hundreds of certain-to-fail requests.
     */
    this.fatal = null;
  }

  get stats() {
    return { bytesBilled: this.bytesBilled, cacheHits: this.cacheHits };
  }

  /**
   * Identity of a queue+voice combination. Used by the caller to decide whether
   * a new play is a continuation of the same reading (carry the cost meter
   * forward) or a genuinely new one (start it at zero).
   */
  static signature(utterances, settings = {}) {
    const bytes = utterances.reduce((n, u) => n + (u.bytes || 0), 0);
    return `${utterances.length}:${bytes}:${settings.voiceId || ''}:${settings.model || ''}`;
  }

  /** Set the queue and reset per-queue bookkeeping. Counters are left alone. */
  load(utterances) {
    this.#abortAll();
    this.#releaseBlobs();
    this.failed.clear();
    this.fatal = null;
    this.utterances = Array.isArray(utterances) ? utterances : [];
    this.head = 0;
    this.closed = false;
  }

  /**
   * Audio for one index, from cache when possible.
   *
   * Never rejects. It resolves to a Blob, or to null meaning "there is nothing
   * playable here, move on" — a permanent synthesis failure, an aborted seek, or
   * an index past the end. An unhandled rejection in a long-lived document takes
   * the player down with it, and a single bad utterance must not do that.
   *
   * @returns {Promise<Blob|null>}
   */
  async audioFor(index) {
    if (this.closed || !this.utterances[index]) return null;
    if (this.failed.has(index)) return null;

    const held = this.blobs.get(index);
    if (held) {
      // Re-insert so the bounded map's ordering reflects use, not arrival.
      this.blobs.delete(index);
      this.blobs.set(index, held);
      return held;
    }

    // One retry, and only for the abort case: a seek that raced past us can
    // cancel a request the caller still turns out to need.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.#request(index);
      } catch (err) {
        if (isAbortError(err) && !this.closed && this.#inWindow(index)) continue;
        if (isAbortError(err)) return null;
        this.#markFailed(index, err);
        return null;
      }
    }
    return null;
  }

  /**
   * Move the window to `i`: abort what fell outside it, drop distant blobs, and
   * start the new look-ahead requests.
   */
  setIndex(i) {
    if (this.closed) return;
    this.head = Math.max(0, i);
    this.#abortOutsideWindow();
    this.#trimBlobs();
    this.prefetch();
  }

  /**
   * Fill the window.
   *
   * There is deliberately no semaphore here. FishClient.synthesize already runs
   * inside its own Semaphore(4), and adding a second gate around it makes things
   * worse in two distinct ways. Reusing `client.semaphore` deadlocks outright:
   * it is not reentrant, so a permit held out here can never be released by a
   * synthesize() that is queued waiting for the same permit. A separate limiter
   * avoids the deadlock but causes priority inversion instead — a queued acquire
   * cannot be aborted, so stale prefetches that a seek already abandoned keep
   * their place in line ahead of the chunk the user is actually waiting for.
   *
   * The window itself is the limiter: at most `ahead + 1` requests exist at
   * once (3 by default, under the client's 4), and setIndex aborts anything that
   * leaves the window so its slot frees up for the new play head immediately.
   */
  prefetch() {
    if (this.closed) return;
    const last = Math.min(this.head + this.ahead, this.utterances.length - 1);
    for (let i = this.head; i <= last; i++) {
      if (this.blobs.has(i) || this.failed.has(i) || this.inflight.has(i)) continue;
      // audioFor does not reject, but this is fire-and-forget in a document that
      // stays alive for hours; the guard costs nothing.
      this.audioFor(i).catch(() => {});
    }
  }

  /** Abort everything and drop all audio. The pipeline is unusable afterwards. */
  dispose() {
    this.closed = true;
    this.#abortAll();
    this.#releaseBlobs();
  }

  /* ------------------------------------------------------------- internals */

  #inWindow(index) {
    return index >= this.head && index <= this.head + this.ahead;
  }

  /** Memoized by index, so two callers awaiting the same chunk share one request. */
  #request(index) {
    const existing = this.inflight.get(index);
    if (existing) return existing.promise;

    const controller = new AbortController();
    const entry = { controller };
    entry.promise = this.#fetchOne(index, controller.signal)
      .then((blob) => {
        if (blob && !this.closed) this.#hold(index, blob);
        return blob;
      })
      .finally(() => {
        if (this.inflight.get(index) === entry) this.inflight.delete(index);
      });

    this.inflight.set(index, entry);
    return entry.promise;
  }

  async #fetchOne(index, signal) {
    const u = this.utterances[index];
    const { voiceId = '', model = '', volume = 0 } = this.settings;

    /**
     * The key must describe the bytes we asked Fish for. Playback speed is
     * applied with HTMLAudioElement.playbackRate and never sent as
     * prosody.speed, so it does not change the audio — keying on it would
     * invalidate the entire cache every time the user nudged the speed slider.
     * Volume does go to the server as prosody.volume, so it belongs here.
     */
    const key = await cacheKey({ text: u.text, voiceId, model, speed: 1, volume });

    const hit = await this.cache.get(key);
    if (hit) {
      this.cacheHits++;
      return hit;
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (this.fatal) throw this.fatal;

    // No retry/backoff here: FishClient owns that, and a second layer of it
    // would multiply attempts rather than add resilience.
    const blob = await this.client.synthesize(u.text, { voiceId, volume, signal });

    // Billed on the miss only. Counting hits here would make the cost meter lie
    // about a re-read that actually cost nothing.
    this.bytesBilled += u.bytes ?? utf8Bytes(u.text);
    this.cache.put(key, blob, { model, voiceId }).catch(() => {});
    return blob;
  }

  #markFailed(index, err) {
    // Callers share one memoized promise, so a single failure lands in several
    // catch blocks. The queue should hear about it once.
    if (this.failed.has(index)) return;
    this.failed.add(index);
    // 401/402 are account-level verdicts, not hiccups: an invalid key or an
    // empty balance fails the next four hundred utterances identically, so stop
    // paying for the round trips. A fresh load() clears this.
    if (err && (err.status === 401 || err.status === 402)) this.fatal = err;
    try {
      this.onError(err, index);
    } catch {
      /* a broken error handler must not become the error */
    }
  }

  #hold(index, blob) {
    this.blobs.set(index, blob);
    this.#trimBlobs();
  }

  /** Keep MAX_BLOBS, discarding whichever is furthest from the play head. */
  #trimBlobs() {
    while (this.blobs.size > MAX_BLOBS) {
      let worst = null;
      let worstDistance = -1;
      for (const i of this.blobs.keys()) {
        const distance = Math.abs(i - this.head);
        if (distance > worstDistance) {
          worstDistance = distance;
          worst = i;
        }
      }
      if (worst === null) return;
      this.blobs.delete(worst);
    }
  }

  #releaseBlobs() {
    this.blobs.clear();
  }

  #abortOutsideWindow() {
    for (const [index, entry] of [...this.inflight]) {
      if (this.#inWindow(index)) continue;
      this.inflight.delete(index);
      entry.controller.abort();
    }
  }

  #abortAll() {
    for (const [, entry] of [...this.inflight]) entry.controller.abort();
    this.inflight.clear();
  }
}

