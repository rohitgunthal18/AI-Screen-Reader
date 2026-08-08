/**
 * IndexedDB audio cache.
 *
 * Fish Audio bills per UTF-8 byte of input, so re-reading a page you already
 * listened to should cost nothing. Every method degrades to a permanent cache
 * miss rather than throwing: a broken or full cache must slow the reader down,
 * never break it.
 */

const DB_NAME = 'read-a-laud';
const DB_VERSION = 1;
const STORE = 'audio';
const DEFAULT_BUDGET = 250 * 1024 * 1024;

/**
 * Content-addressed key for one synthesized utterance.
 *
 * Every input that changes the returned audio must appear here, or a user who
 * switches voice keeps hearing the old one. `speed` is included even though
 * this extension currently applies speed via playbackRate (so it does not
 * affect the bytes) — if that ever moves to prosody.speed, omitting it here
 * would silently serve audio at the wrong rate.
 */
export async function cacheKey({ text, voiceId = '', model = '', speed = 1, volume = 0 }) {
  const material = JSON.stringify([text, voiceId, model, speed, volume]);
  const bytes = new TextEncoder().encode(material);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Promisify one IDBRequest. */
function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class AudioCache {
  constructor({ budget = DEFAULT_BUDGET } = {}) {
    this.db = null;
    this.budget = budget;
    this.disabled = false;
    this.pendingWrites = 0;
    this.warned = false;
  }

  /** Log a degradation reason once; repeated cache failures are not news. */
  #degrade(reason, err) {
    if (!this.warned) {
      console.warn(`[read-a-laud] audio cache unavailable (${reason}):`, err?.message || err);
      this.warned = true;
    }
    this.disabled = true;
  }

  async open() {
    if (this.db || this.disabled) return this.db;
    try {
      this.db = await new Promise((resolve, reject) => {
        const open = indexedDB.open(DB_NAME, DB_VERSION);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const store = db.createObjectStore(STORE, { keyPath: 'key' });
            store.createIndex('lastUsed', 'lastUsed');
            store.createIndex('bytes', 'bytes');
          }
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
        // Another context holds an older version open. Rather than hang
        // forever waiting for it, give up and run cacheless.
        open.onblocked = () => reject(new Error('blocked by another context'));
      });

      // If a future version upgrades the schema elsewhere, close here so that
      // upgrade is not blocked by this long-lived offscreen document.
      this.db.onversionchange = () => {
        this.db.close();
        this.db = null;
      };
      return this.db;
    } catch (err) {
      this.#degrade('open failed', err);
      return null;
    }
  }

  #tx(mode) {
    if (!this.db) return null;
    try {
      return this.db.transaction(STORE, mode).objectStore(STORE);
    } catch (err) {
      this.#degrade('transaction failed', err);
      return null;
    }
  }

  /** @returns {Promise<Blob|null>} */
  async get(key) {
    if (this.disabled) return null;
    await this.open();
    const store = this.#tx('readwrite');
    if (!store) return null;
    try {
      const row = await req(store.get(key));
      if (!row) return null;
      // Touch for LRU. Fire-and-forget: a failed touch only costs accuracy in
      // eviction ordering, and must not delay playback.
      try {
        store.put({ ...row, lastUsed: Date.now() });
      } catch {
        /* ignore */
      }
      return row.blob;
    } catch (err) {
      this.#degrade('read failed', err);
      return null;
    }
  }

  async has(key) {
    if (this.disabled) return false;
    await this.open();
    const store = this.#tx('readonly');
    if (!store) return false;
    try {
      return (await req(store.count(key))) > 0;
    } catch {
      return false;
    }
  }

  async put(key, blob, meta = {}) {
    if (this.disabled) return;
    await this.open();
    const store = this.#tx('readwrite');
    if (!store) return;
    const now = Date.now();
    try {
      await req(
        store.put({
          key,
          blob,
          bytes: blob.size,
          createdAt: now,
          lastUsed: now,
          model: meta.model || '',
          voiceId: meta.voiceId || '',
        }),
      );
    } catch (err) {
      // QuotaExceededError is the common case here. Try to make room once
      // before concluding the cache is unusable.
      if (err?.name === 'QuotaExceededError') {
        await this.evictTo(this.budget / 2);
        return;
      }
      this.#degrade('write failed', err);
      return;
    }

    // Eviction is opportunistic — checking the budget on every read would add
    // a full store scan to the hot path.
    this.pendingWrites++;
    if (this.pendingWrites >= 25) {
      this.pendingWrites = 0;
      this.evictTo(this.budget).catch(() => {});
    }
  }

  /** @returns {Promise<{bytes:number, count:number}>} */
  async size() {
    if (this.disabled) return { bytes: 0, count: 0 };
    await this.open();
    const store = this.#tx('readonly');
    if (!store) return { bytes: 0, count: 0 };
    try {
      const rows = await req(store.getAll());
      return {
        bytes: rows.reduce((sum, r) => sum + (r.bytes || 0), 0),
        count: rows.length,
      };
    } catch {
      return { bytes: 0, count: 0 };
    }
  }

  /** Delete least-recently-used entries until total size is under maxBytes. */
  async evictTo(maxBytes = this.budget) {
    if (this.disabled) return;
    await this.open();
    const store = this.#tx('readwrite');
    if (!store) return;
    try {
      const rows = await req(store.getAll());
      let total = rows.reduce((sum, r) => sum + (r.bytes || 0), 0);
      if (total <= maxBytes) return;
      rows.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
      for (const row of rows) {
        if (total <= maxBytes) break;
        store.delete(row.key);
        total -= row.bytes || 0;
      }
    } catch (err) {
      this.#degrade('eviction failed', err);
    }
  }

  async clear() {
    if (this.disabled) return;
    await this.open();
    const store = this.#tx('readwrite');
    if (!store) return;
    try {
      await req(store.clear());
    } catch (err) {
      this.#degrade('clear failed', err);
    }
  }
}
