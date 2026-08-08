/**
 * Read-a-Laud coordinator.
 *
 * This worker owns STATE and ROUTING, and deliberately owns no audio. An MV3
 * service worker has no Audio constructor and no URL.createObjectURL, and it is
 * killed after ~30s idle, so playback lives in an offscreen document instead.
 * Blobs also cannot cross chrome.runtime.sendMessage (structured clone to JSON),
 * which is why the offscreen document does its own fetching and caching rather
 * than receiving audio from here. See src/offscreen/offscreen.js.
 *
 * Flow: side panel -> EXTRACT -> inject content scripts -> DO_EXTRACT ->
 * speechify() -> OFF_PLAY to offscreen -> progress reports back -> STATE
 * broadcast to the panel + HIGHLIGHT to the content script.
 */

import {
  Msg,
  Status,
  DEFAULT_SETTINGS,
  OFFSCREEN_PATH,
  PRICE_PER_MB,
} from '../lib/protocol.js';
import { speechify } from '../lib/speechify.js';
import { FishClient } from '../lib/fish.js';
import { AudioCache } from '../lib/cache.js';
import { getEmbeddedKey } from '../lib/keys.js';

const CONTENT_FILES = [
  'src/vendor/Readability.js',
  'src/content/density.js',
  'src/content/adapters.js',
  'src/content/extract.js',
  'src/content/content.js',
];

/** Single source of truth for what the UI shows. */
let state = {
  status: Status.IDLE,
  tabId: null,
  title: '',
  index: 0,
  total: 0,
  uid: null,
  error: null,
  bytesBilled: 0,
  cacheHits: 0,
};

/** Current document, kept out of `state` because it is large. */
let doc = { title: '', utterances: [] };

function setState(patch) {
  state = { ...state, ...patch };
  broadcast(Msg.STATE, state);
}

/**
 * Fire-and-forget broadcast. The side panel is frequently closed, and an
 * unanswered sendMessage rejects, so swallowing here keeps one missing
 * listener from surfacing as an unhandled rejection on every state change.
 */
function broadcast(type, payload) {
  chrome.runtime.sendMessage({ type, payload }).catch(() => {});
}

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function client() {
  const s = await getSettings();
  // Use the user's own key if set; fall back to the embedded key.
  const apiKey = s.apiKey || getEmbeddedKey();
  if (!apiKey) throw new Error('NO_API_KEY');
  return new FishClient({ apiKey, model: s.model });
}

/* ---------------------------------------------------------------- offscreen */

let offscreenReady = null;

/**
 * Create the offscreen document once. Concurrent callers share one promise:
 * createDocument throws if a document already exists, and two near-simultaneous
 * play requests would otherwise race into that error.
 */
async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existing.length) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play synthesized speech for the page being read aloud.',
    });
  })().catch((err) => {
    offscreenReady = null;
    throw err;
  });
  return offscreenReady;
}

async function toOffscreen(type, payload) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ type, payload, target: 'offscreen' }).catch(() => null);
}

/* ----------------------------------------------------------------- content */

/**
 * Inject the extraction bundle. Classic scripts in order, since they share a
 * window.RAL global rather than importing each other. Injection is idempotent:
 * content.js bails if it has already installed itself, so re-injecting on a
 * second read of the same tab is harmless and cheaper than tracking per-tab
 * state that goes stale on navigation.
 */
async function injectContent(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['src/content/highlight.css'],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_FILES,
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/** Pages where content scripts cannot run at all — worth a clear message. */
function blockedUrl(url = '') {
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('https://chromewebstore.google.com') ||
    url.startsWith('https://chrome.google.com/webstore') ||
    url.startsWith('https://microsoftedge.microsoft.com/addons')
  );
}

/* ----------------------------------------------------------------- extract */

async function runExtract({ selectionOnly = false } = {}) {
  const tab = await activeTab();
  if (!tab) return fail('No active tab.');
  if (blockedUrl(tab.url)) {
    return fail('Your browser blocks extensions on this page. Try a normal web page.');
  }

  setState({ status: Status.EXTRACTING, tabId: tab.id, error: null, index: 0, uid: null });

  let extraction;
  try {
    const cleanUrl = tab.url.split('#')[0].split('?')[0].toLowerCase();
    if (cleanUrl.endsWith('.pdf')) {
      // Fetch the PDF binary in the background to bypass offscreen CORS/file:// restrictions
      const res = await fetch(tab.url);
      if (!res.ok) throw new Error(`Failed to fetch PDF: ${res.statusText}`);
      const buffer = await res.arrayBuffer();
      
      // Convert ArrayBuffer to Base64 (using chunks to avoid call stack size limits)
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      const base64 = btoa(binary);

      // Route PDF extraction to the offscreen document
      extraction = await toOffscreen(Msg.OFF_EXTRACT_PDF, { url: tab.url, base64 });
    } else {
      // Normal HTML extraction via content script
      await injectContent(tab.id);
      extraction = await chrome.tabs.sendMessage(tab.id, {
        type: Msg.DO_EXTRACT,
        payload: { selectionOnly },
      });
    }
  } catch (err) {
    return fail(`Could not read this page: ${err.message}`);
  }

  if (!extraction || !extraction.ok) {
    return fail(extraction?.reason || 'Nothing readable found on this page.');
  }

  const settings = await getSettings();
  const { utterances, stats } = speechify(extraction, settings);
  if (!utterances.length) return fail('Nothing speakable found on this page.');

  doc = { title: extraction.title, utterances };
  broadcast(Msg.DOC, { ...doc, stats, strategy: extraction.strategy });
  setState({
    status: Status.IDLE,
    title: extraction.title,
    total: utterances.length,
    index: 0,
    bytesBilled: 0,
    cacheHits: 0,
  });
  return { ok: true, stats, strategy: extraction.strategy };
}

function fail(reason) {
  setState({ status: Status.ERROR, error: reason });
  return { ok: false, reason };
}

/* ---------------------------------------------------------------- playback */

async function startPlayback(startIndex = 0) {
  if (!doc.utterances.length) {
    const res = await runExtract();
    if (!res.ok) return res;
  }
  const settings = await getSettings();
  // Resolve the key: user override first, then embedded fallback.
  const apiKey = settings.apiKey || getEmbeddedKey();
  if (!apiKey) return fail('Add your Fish Audio API key in Settings to start listening.');

  setState({ status: Status.BUFFERING, index: startIndex, error: null });
  await toOffscreen(Msg.OFF_PLAY, {
    utterances: doc.utterances,
    settings: { ...settings, apiKey },  // always pass a resolved key
    startIndex,
  });
  return { ok: true };
}

async function stopPlayback() {
  await toOffscreen(Msg.OFF_STOP, {});
  clearHighlight();
  setState({ status: Status.IDLE, index: 0, uid: null });
}

function clearHighlight() {
  if (state.tabId == null) return;
  chrome.tabs.sendMessage(state.tabId, { type: Msg.CLEAR_HIGHLIGHT }).catch(() => {});
}

/**
 * Progress from the offscreen player: move the in-page highlight and mirror
 * position into state. Errors are ignored because the tab may have navigated
 * away mid-playback, which is normal rather than exceptional.
 */
async function onProgress(p) {
  const settings = await getSettings();
  setState({
    status: p.status || state.status,
    index: p.index ?? state.index,
    uid: p.uid ?? null,
    bytesBilled: p.bytesBilled ?? state.bytesBilled,
    cacheHits: p.cacheHits ?? state.cacheHits,
  });
  if (settings.highlight && state.tabId != null && p.uid) {
    // Pass the current utterance's speech text so the content script can
    // highlight the exact sentence being spoken within the active block.
    const currentUtterance = doc.utterances[p.index ?? state.index];
    const sentenceText = currentUtterance?.text || null;
    chrome.tabs
      .sendMessage(state.tabId, {
        type: Msg.HIGHLIGHT,
        payload: { uid: p.uid, autoScroll: settings.autoScroll, sentenceText },
      })
      .catch(() => {});
  }
}


/* ----------------------------------------------------------------- routing */

const handlers = {
  [Msg.EXTRACT]: (p) => runExtract(p || {}),
  [Msg.PLAY]: (p) => startPlayback(p?.index ?? 0),
  [Msg.PAUSE]: async () => { await toOffscreen(Msg.OFF_PAUSE, {}); setState({ status: Status.PAUSED }); },
  [Msg.RESUME]: async () => { await toOffscreen(Msg.OFF_RESUME, {}); setState({ status: Status.PLAYING }); },
  [Msg.STOP]: () => stopPlayback(),
  [Msg.SEEK]: (p) => startPlayback(Math.max(0, Math.min(p.index, doc.utterances.length - 1))),
  [Msg.NEXT]: () => startPlayback(Math.min(state.index + 1, doc.utterances.length - 1)),
  [Msg.PREV]: () => startPlayback(Math.max(state.index - 1, 0)),
  [Msg.GET_STATE]: () => state,
  [Msg.GET_DOC]: () => doc,
  [Msg.GET_SETTINGS]: () => getSettings(),

  [Msg.SET_SETTINGS]: async (p) => {
    const prev = await getSettings();
    const next = await setSettings(p);
    
    // If the voice or model changed while we are reading, restart playback
    // from the current sentence so it takes effect instantly.
    const voiceChanged = prev.voiceId !== next.voiceId || prev.model !== next.model || prev.customVoice !== next.customVoice;
    
    if (voiceChanged && (state.status === Status.PLAYING || state.status === Status.PAUSED || state.status === Status.BUFFERING)) {
      await startPlayback(state.index);
    } else {
      // Speed can apply to the existing pipeline without teardown
      await toOffscreen(Msg.OFF_RATE, { speed: next.speed });
    }
    return next;
  },

  [Msg.LIST_VOICES]: async (p) => {
    const c = await client();
    return p?.indian ? c.discoverIndianVoices() : c.listVoices(p || {});
  },

  [Msg.TEST_KEY]: async (p) => {
    const c = p?.apiKey
      ? new FishClient({ apiKey: p.apiKey, model: (await getSettings()).model })
      : await client();
    return c.testKey();
  },

  [Msg.CLEAR_CACHE]: async () => {
    const cache = new AudioCache();
    await cache.open();
    await cache.clear();
    return { ok: true };
  },

  [Msg.OFF_ENDED]: (p) => onProgress(p),

  [Msg.OFF_ERROR]: async (p) => {
    setState({ status: Status.ERROR, error: p?.hint || p?.message || 'Playback failed.' });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Offscreen-addressed traffic passes through this same bus; ignore it here
  // so the worker does not answer its own player's messages.
  if (msg?.target === 'offscreen') return false;
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg.payload))
    .then((result) => reply(result ?? { ok: true }))
    .catch((err) => {
      const reason = err.message === 'NO_API_KEY'
        ? 'Add your Fish Audio API key in settings.'
        : err.message;
      reply({ ok: false, reason, hint: err.hint });
    });
  return true; // keep the channel open for the async reply
});

/* ------------------------------------------------------------- entrypoints */

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  chrome.contextMenus.create({
    id: 'ral-read-selection',
    title: 'Read selection aloud',
    contexts: ['selection'],
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'ral-read-selection') return;
  await chrome.sidePanel.open({ tabId: tab.id });
  const res = await runExtract({ selectionOnly: true });
  if (res.ok) await startPlayback(0);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-play') {
    if (state.status === Status.PLAYING) await handlers[Msg.PAUSE]();
    else if (state.status === Status.PAUSED) await handlers[Msg.RESUME]();
    else await startPlayback(state.index);
  } else if (command === 'read-selection') {
    const res = await runExtract({ selectionOnly: true });
    if (res.ok) await startPlayback(0);
  }
});

/** Reading follows the tab it started on; navigating away invalidates it. */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.tabId) { stopPlayback(); doc = { title: '', utterances: [] }; }
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === state.tabId && info.status === 'loading') {
    stopPlayback();
    doc = { title: '', utterances: [] };
    broadcast(Msg.DOC, doc);
    broadcast(Msg.PAGE_CHANGED, { tabId });
  }
});

export { PRICE_PER_MB };
