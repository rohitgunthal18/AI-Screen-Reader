/**
 * Fish Audio client.
 *
 * Built against the documented POST /v1/tts contract: the synthesis engine is
 * chosen with a `model` HTTP *header* (not a body field), and billing is by
 * UTF-8 bytes of input text, so every avoided request is money saved. No
 * chrome.* use in here — this module is imported by the offscreen document and
 * kept free of extension APIs so it stays testable.
 */

import { PRICE_PER_MB } from './protocol.js';

const TTS_URL = 'https://api.fish.audio/v1/tts';
const MODEL_URL = 'https://api.fish.audio/model';

/** Valid `model` header values. Anything else server-side falls back to s2.1-pro. */
const VALID_MODELS = new Set(['s1', 's2-pro', 's2.1-pro', 's2.1-pro-free']);

export class FishError extends Error {
  constructor(status, message, hint) {
    super(message);
    this.name = 'FishError';
    this.status = status;
    this.hint = hint;
    // Only rate-limiting and server faults are worth a second attempt; 400/401/
    // 402 are decisions the server will make identically every time.
    this.retryable = status === 429 || (status >= 500 && status < 600);
  }
}

const HINTS = {
  400: 'The request was rejected. The selected voice ID may be invalid.',
  401: 'Invalid or missing API key. Check it in Read-a-Laud settings.',
  402: 'Your Fish Audio account is out of credits. Add funds at fish.audio.',
  429: 'Too many requests in parallel. Read-a-Laud will retry automatically.',
};

/**
 * Concurrency limiter. Defaults to 4: the starter account tier allows 5
 * concurrent requests, and leaving one slot free means this extension never
 * fully saturates the account and starves anything else using the same key.
 */
export class Semaphore {
  constructor(limit = 4) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
  }

  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Full jitter backoff — spreads retries so parallel failures don't resync. */
function backoffDelay(attempt, retryAfter) {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, 15000);
  }
  const base = Math.min(500 * 2 ** attempt, 8000);
  return Math.random() * base;
}

function isAbort(err) {
  return err && (err.name === 'AbortError' || err.code === 20);
}

export class FishClient {
  /** @param {{apiKey:string, model?:string, semaphore?:Semaphore}} opts */
  constructor({ apiKey, model = 's2.1-pro-free', semaphore } = {}) {
    this.apiKey = apiKey;
    this.model = VALID_MODELS.has(model) ? model : 's2.1-pro-free';
    this.semaphore = semaphore || new Semaphore(4);
  }

  get headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      model: this.model,
    };
  }

  /**
   * Synthesize one utterance to an MP3 Blob.
   *
   * `latency: "balanced"` is deliberate. This is a page reader, so time to
   * first audio matters more than the last few percent of fidelity — but
   * "low" trades away more quality than it buys back in a context where we
   * are already prefetching ahead of the play head.
   *
   * @param {string} text
   * @param {{voiceId?:string, volume?:number, speed?:number, signal?:AbortSignal}} opts
   * @returns {Promise<Blob>} audio/mpeg
   */
  async synthesize(text, opts = {}) {
    const { voiceId, volume = 0, speed, signal } = opts;

    const body = {
      text,
      format: 'mp3',
      mp3_bitrate: 128,
      sample_rate: 44100,
      latency: 'balanced',
      // Lets the server read numbers, dates and units correctly.
      normalize: true,
      // Keeps timbre stable across the many chunks of one article.
      condition_on_previous_chunks: true,
    };
    if (voiceId) body.reference_id = voiceId;

    // Playback speed is applied client-side via HTMLAudioElement.playbackRate,
    // which is instant and free. Sending prosody.speed here would make every
    // speed change a re-synthesis — re-billed and cache-invalidating — so it is
    // only sent when a caller explicitly asks for it.
    const prosody = {};
    if (typeof speed === 'number') prosody.speed = clamp(speed, 0.5, 2);
    if (volume) prosody.volume = clamp(volume, -20, 20);
    if (Object.keys(prosody).length) body.prosody = prosody;

    return this.semaphore.run(() => this.#post(TTS_URL, body, signal));
  }

  async #post(url, body, signal, attempt = 0) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (isAbort(err)) throw err; // a cancelled request must never be retried
      if (attempt < 2) {
        await sleep(backoffDelay(attempt));
        return this.#post(url, body, signal, attempt + 1);
      }
      throw new FishError(0, `Network error: ${err.message}`, 'Check your connection.');
    }

    if (res.ok) {
      const buf = await res.arrayBuffer();
      if (!buf.byteLength) throw new FishError(0, 'Empty audio response.', 'Try again.');
      return new Blob([buf], { type: 'audio/mpeg' });
    }

    const err = await toError(res);
    if (err.retryable && attempt < 2) {
      await sleep(backoffDelay(attempt, res.headers.get('Retry-After')));
      return this.#post(url, body, signal, attempt + 1);
    }
    throw err;
  }

  async #get(params = {}, signal) {
    const url = new URL(MODEL_URL);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
      else url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal,
    });
    if (!res.ok) throw await toError(res);
    return res.json();
  }

  /**
   * List public TTS voices. Filtered to trained TTS models so the picker never
   * offers something that cannot actually synthesize.
   */
  async listVoices({ language, title, tag, pageSize = 40, sortBy = 'score', page = 1 } = {}) {
    const data = await this.#get({
      page_size: Math.min(Math.max(pageSize, 1), 100),
      page_number: page,
      sort_by: sortBy,
      language,
      title,
      tag,
    });
    return (data.items || [])
      .filter((m) => m.type === 'tts' && m.state === 'trained')
      .map(normalizeVoice);
  }

  /**
   * Find voices usable for Indian audiences.
   *
   * Two things make this messy, and both are why discovery is empirical rather
   * than a hardcoded catalogue. First, the API does not document which
   * `language` codes it accepts, so unsupported codes may simply 400. Second,
   * Fish's officially supported language list (13 languages) does NOT include
   * Hindi or any other Indian language — so Indian-accented ENGLISH voices are
   * the reliable case, while Hindi/Tamil/Telugu output depends on
   * community-trained models and quality varies a lot. Audition before relying
   * on one. Probes run through the shared semaphore so discovery cannot eat
   * the account's concurrency budget.
   */
  async discoverIndianVoices() {
    const langs = ['hi', 'hi-IN', 'en-IN', 'mr', 'ta', 'te', 'bn', 'gu', 'kn', 'ml', 'pa', 'ur'];
    const terms = ['hindi', 'indian', 'india', 'bollywood', 'desi', 'urdu', 'tamil', 'telugu', 'marathi', 'bengali', 'punjabi'];

    const probes = [
      ...langs.map((l) => ({ label: `language:${l}`, params: { language: l } })),
      ...terms.map((t) => ({ label: `title:${t}`, params: { title: t } })),
    ];

    const found = new Map();
    await Promise.all(
      probes.map((probe) =>
        // Per-probe failures are expected (undocumented codes may 400), so one
        // bad probe must not sink the whole discovery run.
        this.semaphore
          .run(() => this.listVoices({ ...probe.params, pageSize: 30 }))
          .then((voices) => {
            for (const v of voices) {
              const prev = found.get(v.id);
              if (prev) prev.matchedBy.push(probe.label);
              else found.set(v.id, { ...v, matchedBy: [probe.label] });
            }
          })
          .catch(() => {}),
      ),
    );

    return [...found.values()].sort((a, b) => b.likes - a.likes);
  }

  /**
   * Validate the key with the cheapest authenticated call available.
   * Deliberately a model list and not a synthesis — validating a key should
   * never spend the user's credits.
   */
  async testKey() {
    if (!this.apiKey) return { ok: false, message: 'No API key set.' };
    try {
      await this.#get({ page_size: 1 });
      return { ok: true, message: 'Key is valid.' };
    } catch (err) {
      return { ok: false, message: err.hint || err.message };
    }
  }

  /** @returns {number} estimated USD for `bytes` of input text. */
  estimateCost(bytes, model = this.model) {
    return (bytes / 1_000_000) * (PRICE_PER_MB[model] ?? 0);
  }
}

async function toError(res) {
  let message = `Request failed with status ${res.status}`;
  try {
    const body = await res.json();
    if (body && body.message) message = body.message;
  } catch {
    /* non-JSON error body; the status alone is the signal */
  }
  return new FishError(res.status, message, HINTS[res.status]);
}

function normalizeVoice(m) {
  return {
    id: m._id,
    title: m.title || 'Untitled voice',
    languages: m.languages || [],
    tags: m.tags || [],
    likes: m.like_count || 0,
    tasks: m.task_count || 0,
    author: m.author?.nickname || '',
    description: m.description || '',
    sampleUrl: m.samples?.[0]?.audio || null,
  };
}

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
