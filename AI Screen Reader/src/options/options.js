/**
 * Read-a-Laud settings page.
 *
 * Owns no state of its own beyond a render cache: chrome.storage.local is the
 * single source of truth, reached only through the service worker's message
 * contract ({type, payload}). Every control reads its initial value from
 * Msg.GET_SETTINGS and writes back a partial patch via Msg.SET_SETTINGS, which
 * replies with the merged result.
 */

import { Msg, Models, PRICE_PER_MB, DEFAULT_SETTINGS } from '../lib/protocol.js';

const $ = (id) => document.getElementById(id);

/** The worked cost example in the Model section: a ~5,000-character article. */
const EXAMPLE_BYTES = 5000;

/** Local mirror of persisted settings, refreshed from every worker reply. */
let settings = { ...DEFAULT_SETTINGS };

/* --------------------------------------------------------------- messaging */

/**
 * One envelope shape for the whole page. The worker replies {ok:false, reason,
 * hint} on failure rather than rejecting, so callers must check `ok` — but a
 * dead worker or a closed channel still rejects, and that is normalized into
 * the same shape here so no call site needs a try/catch.
 */
async function send(type, payload = {}) {
  try {
    const res = await chrome.runtime.sendMessage({ type, payload });
    if (res === undefined) {
      return { ok: false, reason: 'No response from the extension background.' };
    }
    return res;
  } catch (err) {
    return { ok: false, reason: err?.message || 'The extension background is not reachable.' };
  }
}

/** Extract a human-readable failure string from any worker reply. */
function reasonOf(res, fallback) {
  return res?.hint || res?.reason || res?.message || fallback;
}

/* ------------------------------------------------------------------ status */

let savedTimer;

/** Subtle, non-blocking save confirmation. */
function flashSaved() {
  const el = $('saved');
  el.textContent = 'Saved';
  el.classList.add('is-visible');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('is-visible'), 1600);
}

/** @param {'ok'|'error'|'muted'} tone */
function setStatus(el, message, tone = 'muted') {
  el.textContent = message;
  el.classList.toggle('is-ok', tone === 'ok');
  el.classList.toggle('is-error', tone === 'error');
}

/* ---------------------------------------------------------------- persisting */

/**
 * Persist a partial patch. The worker merges and returns the full settings
 * object, which becomes the new local mirror — so the page can never drift
 * from what is actually stored.
 */
async function save(patch) {
  const res = await send(Msg.SET_SETTINGS, patch);
  if (res && res.ok === false) {
    setStatus($('saved'), reasonOf(res, 'Could not save.'), 'error');
    $('saved').classList.add('is-visible');
    return false;
  }
  if (res && typeof res === 'object') settings = { ...settings, ...res };
  flashSaved();
  return true;
}

/**
 * Coalescing debounce for rapid input — a slider drag would otherwise write on
 * every pixel. Patches MERGE rather than replace: one shared timer serves every
 * field on the page, so a plain trailing debounce would let a later field's
 * patch silently cancel an earlier one that had not been flushed yet.
 */
let pendingPatch = null;
let pendingTimer;

function saveDebounced(patch, ms = 300) {
  pendingPatch = { ...(pendingPatch || {}), ...patch };
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    const batch = pendingPatch;
    pendingPatch = null;
    save(batch);
  }, ms);
}

/** Flush before the page goes away, so an in-flight edit is never lost. */
function flushPending() {
  if (!pendingPatch) return;
  clearTimeout(pendingTimer);
  const batch = pendingPatch;
  pendingPatch = null;
  save(batch);
}

/* ------------------------------------------------------------------ bindings */

/** Checkbox <-> boolean setting. Saves immediately; toggles are deliberate acts. */
function bindToggle(id, key) {
  const el = $(id);
  el.checked = Boolean(settings[key]);
  el.addEventListener('change', () => save({ [key]: el.checked }));
}

/**
 * Range <-> numeric setting. The readout updates on every input event so the
 * control feels live, while the write is debounced.
 */
function bindRange(id, key, format, outId) {
  const el = $(id);
  const out = $(outId);
  el.value = String(settings[key]);
  out.textContent = format(Number(el.value));
  el.addEventListener('input', () => {
    const value = Number(el.value);
    out.textContent = format(value);
    saveDebounced({ [key]: value });
  });
}

/** Text input <-> string setting, debounced so typing does not thrash storage. */
function bindText(id, buildPatch) {
  const el = $(id);
  el.addEventListener('input', () => saveDebounced(buildPatch(el.value.trim())));
  return el;
}

/* ------------------------------------------------------------------- model */

function renderModelCost() {
  const perMillion = PRICE_PER_MB[settings.model] ?? 0;
  // Worked from the price table rather than a hardcoded figure, so the example
  // stays honest if pricing ever changes.
  const cost = (EXAMPLE_BYTES / 1_000_000) * perMillion;
  $('modelCost').textContent =
    perMillion === 0
      ? 'Selected: free tier. A 5,000-byte article costs $0.00.'
      : `Selected: paid tier. A 5,000-byte article costs about $${cost.toFixed(3)}.`;
}

function bindModel() {
  const inputs = [$('model-free'), $('model-pro')];
  // Settings may hold a legacy model id (s1, s2-pro) that has no radio here;
  // show the free tier rather than leaving the group with nothing checked.
  const current = settings.model === Models.PRO ? Models.PRO : Models.FREE;
  for (const input of inputs) {
    input.checked = input.value === current;
    input.addEventListener('change', async () => {
      if (!input.checked) return;
      await save({ model: input.value });
      renderModelCost();
    });
  }
  renderModelCost();
}

/* ----------------------------------------------------------------- API key */

function bindApiKey() {
  const input = $('apiKey');
  const toggle = $('keyToggle');
  const status = $('keyStatus');

  input.value = settings.apiKey || '';

  // Never logged, never rendered in plaintext by default — the field starts as
  // type="password" and only the user's explicit action reveals it.
  input.addEventListener('input', () => {
    saveDebounced({ apiKey: input.value.trim() });
    setStatus(status, '');
  });

  toggle.addEventListener('click', () => {
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    toggle.textContent = shown ? 'Show' : 'Hide';
    toggle.setAttribute('aria-pressed', String(!shown));
  });

  $('testKey').addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) {
      setStatus(status, 'Enter a key first.', 'error');
      return;
    }
    const btn = $('testKey');
    btn.disabled = true;
    setStatus(status, 'Checking...');
    // Test the typed key directly, so it can be verified before the debounced
    // save has landed.
    const res = await send(Msg.TEST_KEY, { apiKey: key });
    btn.disabled = false;
    if (res?.ok) setStatus(status, res.message || 'Key is valid.', 'ok');
    else setStatus(status, reasonOf(res, 'Key check failed.'), 'error');
  });
}

/* ------------------------------------------------------------------- voice */

function renderCurrentVoice() {
  const el = $('currentVoice');
  el.textContent = '';
  if (!settings.voiceId) {
    el.textContent = 'No voice selected — Fish will use its default voice.';
    return;
  }
  el.append('Current voice: ');
  const name = document.createElement('strong');
  // SECURITY: voiceName originates from the remote Fish API. textContent, never
  // innerHTML — an innerHTML sink on a privileged extension page would let a
  // hostile voice title run script with extension origin and privileges.
  name.textContent = settings.voiceName || settings.voiceId;
  el.append(name);
}

/**
 * Render voice results.
 *
 * SECURITY: every field below (title, author, tags, languages) is attacker-
 * controllable text from a public, user-submitted voice catalogue. All of it is
 * written with textContent / createElement — there is no innerHTML anywhere in
 * this file, and there must never be. sampleUrl is assigned to audio.src and is
 * scheme-checked before use for the same reason.
 */
function renderVoices(voices) {
  const list = $('voiceList');
  list.textContent = '';
  $('voiceEmpty').hidden = voices.length > 0;

  /** Row updaters, so selecting a voice restyles in place. A full re-render
   *  would rebuild the <audio> elements and cut off a preview mid-sentence. */
  const rows = [];

  for (const voice of voices) {
    const li = document.createElement('li');
    li.className = 'voice';

    const main = document.createElement('div');
    main.className = 'voice-main';

    const title = document.createElement('span');
    title.className = 'voice-title';
    title.textContent = voice.title || 'Untitled voice';
    main.append(title);

    const bits = [];
    if (Array.isArray(voice.languages) && voice.languages.length) {
      bits.push(voice.languages.join(', '));
    }
    if (voice.author) bits.push(`by ${voice.author}`);
    bits.push(`${voice.likes || 0} likes`);
    if (voice.tasks) bits.push(`${voice.tasks} uses`);

    const meta = document.createElement('span');
    meta.className = 'voice-meta';
    meta.textContent = bits.join(' · ');
    main.append(meta);
    li.append(main);

    // Auditioning is the whole point for community voices of uneven quality.
    if (voice.sampleUrl && isSafeAudioUrl(voice.sampleUrl)) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = voice.sampleUrl;
      const label = voice.title ? `Preview ${voice.title}` : 'Preview voice';
      audio.setAttribute('aria-label', label);
      li.append(audio);
    }

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.addEventListener('click', async () => {
      const ok = await save({ voiceId: voice.id, voiceName: voice.title || '' });
      if (!ok) return;
      $('voiceId').value = voice.id;
      renderCurrentVoice();
      rows.forEach((sync) => sync());
    });
    li.append(pick);

    const sync = () => {
      const selected = voice.id === settings.voiceId;
      li.classList.toggle('is-selected', selected);
      pick.className = selected ? 'btn btn-quiet' : 'btn';
      pick.textContent = selected ? 'Selected' : 'Use voice';
      pick.setAttribute('aria-pressed', String(selected));
    };
    sync();
    rows.push(sync);

    list.append(li);
  }
}

/** Only http(s) sample URLs are ever handed to an <audio> element. */
function isSafeAudioUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

async function loadVoices(payload, busyLabel) {
  const status = $('voiceStatus');
  const buttons = [$('voiceSearchBtn'), $('popularBtn'), $('indianBtn')];
  buttons.forEach((b) => (b.disabled = true));
  setStatus(status, busyLabel);

  const res = await send(Msg.LIST_VOICES, payload);
  buttons.forEach((b) => (b.disabled = false));

  // A successful LIST_VOICES resolves to an array; failures come back as the
  // {ok:false, reason, hint} envelope.
  if (!Array.isArray(res)) {
    setStatus(status, reasonOf(res, 'Could not load voices.'), 'error');
    return;
  }
  renderVoices(res);
  if (!res.length) setStatus(status, 'No voices matched.', 'muted');
  else setStatus(status, `${res.length} voice${res.length === 1 ? '' : 's'} found.`, 'ok');
}

function bindVoice() {
  const idField = bindText('voiceId', (value) => {
    // A hand-pasted ID carries no title, so clear any stale name in the same
    // patch — two separate debounced calls would collapse into one.
    settings = { ...settings, voiceId: value, voiceName: '' };
    renderCurrentVoice();
    return { voiceId: value, voiceName: '' };
  });
  idField.value = settings.voiceId || '';

  const search = $('voiceSearch');
  const runSearch = () => {
    const title = search.value.trim();
    loadVoices(
      title ? { title, pageSize: 30 } : { pageSize: 30, sortBy: 'score' },
      'Searching...',
    );
  };

  $('voiceSearchBtn').addEventListener('click', runSearch);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  });

  $('popularBtn').addEventListener('click', () =>
    loadVoices({ pageSize: 30, sortBy: 'score' }, 'Loading popular voices...'),
  );

  $('indianBtn').addEventListener('click', () =>
    loadVoices({ indian: true }, 'Probing for Indian voices, this takes a moment...'),
  );

  renderCurrentVoice();
}

/* ------------------------------------------------------------------- cache */

function bindCache() {
  const btn = $('clearCache');
  const status = $('cacheStatus');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    setStatus(status, 'Clearing...');
    const res = await send(Msg.CLEAR_CACHE);
    btn.disabled = false;
    if (res?.ok) setStatus(status, 'Cache cleared.', 'ok');
    else setStatus(status, reasonOf(res, 'Could not clear the cache.'), 'error');
  });
}

/* -------------------------------------------------------------------- boot */

function chunkLabel(chars) {
  if (chars <= 400) return `${chars} chars · starts fast, choppier`;
  if (chars >= 1400) return `${chars} chars · smoothest, slower start`;
  return `${chars} chars · balanced`;
}

async function init() {
  const res = await send(Msg.GET_SETTINGS);
  // Defaults keep the page fully usable even if the worker is momentarily down.
  if (res && res.ok !== false) settings = { ...DEFAULT_SETTINGS, ...res };
  else setStatus($('saved'), reasonOf(res, 'Could not load settings.'), 'error');

  bindApiKey();
  bindModel();
  bindVoice();

  bindToggle('readHeadings', 'readHeadings');
  bindToggle('readFigures', 'readFigures');
  bindToggle('skipCode', 'skipCode');
  bindToggle('skipTables', 'skipTables');
  bindToggle('highlight', 'highlight');
  bindToggle('autoScroll', 'autoScroll');

  bindRange('speed', 'speed', (v) => `${v.toFixed(2)}×`, 'speedOut');
  bindRange('volume', 'volume', (v) => `${v > 0 ? '+' : ''}${v} dB`, 'volumeOut');
  bindRange('maxChunkChars', 'maxChunkChars', chunkLabel, 'chunkOut');

  bindCache();

  window.addEventListener('pagehide', flushPending);
}

init();
