/**
 * Read-a-Laud — Side Panel (v2, premium white redesign)
 *
 * Architecture unchanged: the panel owns NO playback state. It reflects whatever
 * PlayerState the service worker broadcasts and sends intents back.
 *
 * New in v2:
 *  - Inline settings drawer (no separate tab)
 *  - Curated voice picker dropdown (grouped by region)
 *  - Page-changed detection banner with one-click refresh
 *  - Refresh button in topbar to force re-detection
 *  - Sub-sentence highlighting: sentenceText is forwarded via Msg.HIGHLIGHT
 */

import { Msg, Status, BlockKind, PRICE_PER_MB, CURATED_VOICES } from '../lib/protocol.js';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ elements */

const el = {
  /* topbar */
  refresh: $('btnRefresh'),
  settingsBtn: $('btnSettings'),
  /* page banner */
  pageBanner: $('pageBanner'),
  bannerRefresh: $('btnBannerRefresh'),
  /* doc info */
  docHeader: $('docHeader'),
  title: $('docTitle'),
  site: $('docSite'),
  time: $('docTime'),
  /* stage */
  stage: $('stage'),
  cardEmpty: $('cardEmpty'),
  cardSetup: $('cardSetup'),
  cardError: $('cardError'),
  cardLoading: $('cardLoading'),
  errorTitle: $('errorTitle'),
  errorReason: $('errorReason'),
  errorHint: $('errorHint'),
  loadingMsg: $('loadingMsg'),
  /* transcript */
  transcript: $('transcript'),
  follow: $('btnFollow'),
  /* transport */
  status: $('status'),
  progress: $('progress'),
  progressFill: $('progressFill'),
  play: $('btnPlay'),
  playIcon: $('playIcon'),
  prev: $('btnPrev'),
  next: $('btnNext'),
  stop: $('btnStop'),
  slower: $('btnSlower'),
  faster: $('btnFaster'),
  speedVal: $('speedVal'),
  voiceQuick: $('btnVoiceQuick'),
  usage: $('usage'),
  /* stage buttons */
  read: $('btnRead'),
  readSelection: $('btnReadSelection'),
  setup: $('btnSetup'),
  retry: $('btnRetry'),
  /* settings drawer */
  drawerBackdrop: $('drawerBackdrop'),
  settingsDrawer: $('settingsDrawer'),
  closeSettings: $('btnCloseSettings'),
  voicePickerContainer: $('voicePickerContainer'),
  voicePickerTrigger: $('voicePickerTrigger'),
  voicePickerValue: $('voicePickerValue'),
  voicePickerDropdown: $('voicePickerDropdown'),
  drawerSpeed: $('drawerSpeed'),
  drawerSpeedOut: $('drawerSpeedOut'),
  drawerHighlight: $('drawerHighlight'),
  drawerAutoScroll: $('drawerAutoScroll'),
  drawerSkipCode: $('drawerSkipCode'),
  drawerSkipTables: $('drawerSkipTables'),
  modelFree: $('modelFree'),
  modelPro: $('modelPro'),
  drawerApiKey: $('drawerApiKey'),
  drawerKeyToggle: $('drawerKeyToggle'),
  drawerTestKey: $('drawerTestKey'),
  drawerKeyStatus: $('drawerKeyStatus'),
  drawerCustomVoice: $('drawerCustomVoice'),
  drawerClearCache: $('drawerClearCache'),
  drawerCacheStatus: $('drawerCacheStatus'),
  drawerSaveNote: $('drawerSaveNote'),
};

/* ------------------------------------------------------------------ state */

/** Discrete speed ladder — keeps increments perceptually even. */
const SPEEDS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

let playerState = { status: Status.IDLE, index: 0, total: 0, bytesBilled: 0, cacheHits: 0 };
let settings = {};
let utterances = [];
let lines = [];
let focusIndex = 0;
let following = true;
let selfScrolling = 0;
let drawerOpen = false;
let saveDebounce = null;

/* ------------------------------------------------------------------ messaging */

async function send(type, payload) {
  try {
    return await chrome.runtime.sendMessage({ type, payload });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ voice picker */

/**
 * Populate the voice <select> from CURATED_VOICES.
 * Groups are rendered as <optgroup> elements for native accessibility.
 */
function buildVoicePicker() {
  const container = el.voicePickerDropdown;
  CURATED_VOICES.forEach((group) => {
    const grp = document.createElement('div');
    grp.className = 'custom-optgroup';
    grp.textContent = group.region;
    container.appendChild(grp);
    
    group.voices.forEach((v) => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'custom-option';
      opt.dataset.value = v.id;
      opt.setAttribute('role', 'option');
      opt.innerHTML = `<img src="${v.flag}" alt="" class="flag-icon"> <span>${v.name} - ${v.country}</span>`;
      container.appendChild(opt);
      
      opt.addEventListener('click', () => {
        el.voicePickerValue.innerHTML = opt.innerHTML;
        container.hidden = true;
        el.voicePickerTrigger.setAttribute('aria-expanded', 'false');
        
        container.querySelectorAll('.custom-option').forEach(o => o.setAttribute('aria-selected', 'false'));
        opt.setAttribute('aria-selected', 'true');
        
        saveSetting({ voiceId: v.id });
      });
    });
  });
  
  el.voicePickerTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const expanded = el.voicePickerTrigger.getAttribute('aria-expanded') === 'true';
    el.voicePickerTrigger.setAttribute('aria-expanded', !expanded);
    container.hidden = expanded;
  });
  
  document.addEventListener('click', (e) => {
    if (el.voicePickerContainer && !el.voicePickerContainer.contains(e.target)) {
      el.voicePickerTrigger.setAttribute('aria-expanded', 'false');
      container.hidden = true;
    }
  });
}

/* ------------------------------------------------------------------ settings drawer */

function openSettings() {
  drawerOpen = true;
  el.settingsDrawer.hidden = false;
  el.drawerBackdrop.classList.add('is-open');
  el.settingsDrawer.classList.remove('is-closing');
  // Sync UI controls to current settings
  syncDrawerToSettings();
  // Trap focus inside drawer
  el.closeSettings.focus();
}

function closeSettings() {
  drawerOpen = false;
  el.settingsDrawer.classList.add('is-closing');
  el.drawerBackdrop.classList.remove('is-open');
  setTimeout(() => {
    el.settingsDrawer.hidden = true;
    el.settingsDrawer.classList.remove('is-closing');
  }, 200);
}

function syncDrawerToSettings() {
  // Voice picker: prefer customVoice override, else voiceId
  const voiceId = settings.customVoice || settings.voiceId || '';
  const options = Array.from(el.voicePickerDropdown.querySelectorAll('.custom-option'));
  options.forEach(o => o.setAttribute('aria-selected', 'false'));
  const match = options.find(o => o.dataset.value === voiceId) || options[0];
  if (match) {
    match.setAttribute('aria-selected', 'true');
    el.voicePickerValue.innerHTML = match.innerHTML;
  }
  el.drawerCustomVoice.value = settings.customVoice || '';

  // Speed slider
  const spd = Number(settings.speed) || 1;
  el.drawerSpeed.value = spd;
  el.drawerSpeedOut.textContent = speedLabel(spd);

  // Toggles
  el.drawerHighlight.checked = !!settings.highlight;
  el.drawerAutoScroll.checked = !!settings.autoScroll;
  el.drawerSkipCode.checked = !!settings.skipCode;
  el.drawerSkipTables.checked = !!settings.skipTables;

  // Model chips
  const m = settings.model || 's2.1-pro-free';
  el.modelFree.checked = m === 's2.1-pro-free';
  el.modelPro.checked = m === 's2.1-pro';

  // API key
  el.drawerApiKey.value = settings.apiKey || '';
  el.drawerKeyStatus.textContent = '';
  el.drawerCacheStatus.textContent = '';
  el.drawerSaveNote.textContent = '';
}

/**
 * Save a partial settings patch to chrome.storage via the service worker.
 * Debounced so slider drags don't spam the bus.
 */
function saveSetting(patch) {
  settings = { ...settings, ...patch };
  clearTimeout(saveDebounce);
  saveDebounce = setTimeout(async () => {
    await send(Msg.SET_SETTINGS, patch);
    flashSaveNote('Saved ✓');
  }, 400);
}

function flashSaveNote(msg) {
  el.drawerSaveNote.textContent = msg;
  setTimeout(() => { el.drawerSaveNote.textContent = ''; }, 2000);
}

/* ------------------------------------------------------------------ speed */

function speedLabel(v) {
  return `${v % 1 === 0 ? v.toFixed(1) : String(v)}×`;
}

function nudgeSpeed(dir) {
  const current = Number(settings.speed) || 1;
  let i = SPEEDS.findIndex((s) => Math.abs(s - current) < 0.001);
  if (i < 0) i = SPEEDS.findIndex((s) => s >= current);
  if (i < 0) i = SPEEDS.length - 1;
  const next = SPEEDS[Math.max(0, Math.min(i + dir, SPEEDS.length - 1))];
  if (next === current) return;
  saveSetting({ speed: next });
  render();
}

/* ------------------------------------------------------------------ render */

function lineClass(kind) {
  switch (kind) {
    case BlockKind.HEADING: return 'line line--heading';
    case BlockKind.QUOTE: return 'line line--quote';
    case BlockKind.LIST_ITEM: return 'line line--item';
    case BlockKind.CODE:
    case BlockKind.TABLE: return 'line line--skipped';
    default: return 'line';
  }
}

function displayText(text) {
  return text.replace(/\[(?:long-)?break\]/g, '').replace(/\s+/g, ' ').trim();
}

function renderTranscript() {
  el.transcript.textContent = '';
  lines = [];
  if (!utterances.length) {
    el.transcript.hidden = true;
    return;
  }
  const frag = document.createDocumentFragment();
  utterances.forEach((u, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = lineClass(u.kind);
    b.textContent = displayText(u.text);
    b.dataset.index = String(i);
    b.tabIndex = i === 0 ? 0 : -1;
    frag.append(b);
    lines.push(b);
  });
  el.transcript.append(frag);
  el.transcript.hidden = false;
  focusIndex = 0;
}

function paintPosition() {
  lines.forEach((line, i) => {
    line.classList.toggle('line--current', i === playerState.index);
    line.classList.toggle('line--past', i < playerState.index);
  });
  const total = playerState.total || utterances.length;
  el.progress.setAttribute('aria-valuemax', String(total));
  el.progress.setAttribute('aria-valuenow', String(Math.min(playerState.index + 1, total)));
  el.progressFill.style.width = total ? `${((playerState.index + 1) / total) * 100}%` : '0';
  if (following) scrollToCurrent();
  else updateFollowPill();
}

function scrollToCurrent() {
  const line = lines[playerState.index];
  if (!line) return;
  selfScrolling++;
  line.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  setTimeout(() => { selfScrolling = Math.max(0, selfScrolling - 1); }, 420);
}

function isCurrentVisible() {
  const line = lines[playerState.index];
  if (!line) return true;
  const view = el.transcript.getBoundingClientRect();
  const box = line.getBoundingClientRect();
  return box.bottom > view.top && box.top < view.bottom;
}

function updateFollowPill() {
  const reading = playerState.status === Status.PLAYING || playerState.status === Status.BUFFERING;
  el.follow.hidden = following || !reading || !lines.length || isCurrentVisible();
}

function showStage(which) {
  el.cardEmpty.hidden = which !== 'empty';
  el.cardSetup.hidden = which !== 'setup';
  el.cardError.hidden = which !== 'error';
  el.cardLoading.hidden = which !== 'loading';
  el.stage.hidden = !which;
  el.stage.classList.toggle('hidden', !which);
}

function pickStage() {
  if (playerState.status === Status.EXTRACTING) return 'loading';
  if (playerState.status === Status.ERROR) return 'error';
  if (utterances.length) return null;
  // Extension now uses embedded key as fallback — show empty (not setup) unless
  // we explicitly know there's no key at all
  return 'empty';
}

function costLine() {
  const perMb = PRICE_PER_MB[settings.model] ?? 0;
  const billed = playerState.bytesBilled || 0;
  const parts = [];
  if (perMb === 0) {
    parts.push(`${billed.toLocaleString()} bytes · free model`);
  } else {
    const usd = (billed / 1e6) * perMb;
    parts.push(usd > 0 && usd < 0.01
      ? `${billed.toLocaleString()} bytes · under a cent`
      : `${billed.toLocaleString()} bytes · $${usd.toFixed(3)}`);
  }
  if (playerState.cacheHits) parts.push(`${playerState.cacheHits} reused`);
  return parts.join(' · ');
}

function statusLine() {
  const total = playerState.total || utterances.length;
  switch (playerState.status) {
    case Status.EXTRACTING: return '';
    case Status.BUFFERING: return 'Buffering audio…';
    case Status.PLAYING: return `Sentence ${playerState.index + 1} of ${total}`;
    case Status.PAUSED: return `Paused · ${playerState.index + 1} of ${total}`;
    case Status.ERROR: return '';
    default: return total ? `${total} sentences ready` : '';
  }
}

function render() {
  const stage = pickStage();
  showStage(stage);

  if (stage === 'error') {
    el.errorReason.textContent = playerState.error || 'Something went wrong.';
    const isExplained = /pdf|canvas|blocks extensions/i.test(playerState.error || '');
    el.errorTitle.textContent = isExplained ? "Can't read this one" : "That didn't work";
    el.retry.hidden = isExplained;
  }

  const busy = playerState.status === Status.BUFFERING || playerState.status === Status.EXTRACTING;
  const playing = playerState.status === Status.PLAYING;
  const hasDoc = utterances.length > 0;

  // Show/hide doc header
  el.docHeader.hidden = !hasDoc;

  el.play.disabled = playerState.status === Status.EXTRACTING;
  el.play.classList.toggle('is-busy', playerState.status === Status.BUFFERING);
  el.playIcon.setAttribute('href', playing ? '#i-pause' : busy ? '#i-spinner' : '#i-play');
  el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');

  el.prev.disabled = !hasDoc || playerState.index <= 0;
  el.next.disabled = !hasDoc || playerState.index >= (playerState.total || utterances.length) - 1;
  el.stop.disabled = !playing && playerState.status !== Status.PAUSED && playerState.status !== Status.BUFFERING;

  const speed = Number(settings.speed) || 1;
  el.speedVal.textContent = speedLabel(speed);
  el.slower.disabled = speed <= SPEEDS[0];
  el.faster.disabled = speed >= SPEEDS[SPEEDS.length - 1];

  el.status.textContent = statusLine();
  el.status.classList.toggle('status-line--warn', playerState.status === Status.ERROR);
  el.usage.textContent = hasDoc && (playerState.bytesBilled || playerState.cacheHits) ? costLine() : '';

  paintPosition();
}

/* ------------------------------------------------------------------ actions */

async function onPlayPause() {
  if (playerState.status === Status.PLAYING) return void send(Msg.PAUSE);
  if (playerState.status === Status.PAUSED) return void send(Msg.RESUME);
  following = true;
  await send(Msg.PLAY, { index: utterances.length ? playerState.index : 0 });
}

async function extract(selectionOnly) {
  el.pageBanner.hidden = true;
  showStage('loading');
  el.loadingMsg.textContent = selectionOnly ? 'Reading your selection' : 'Reading the page';
  const res = await send(Msg.EXTRACT, { selectionOnly });
  if (!res) {
    playerState = { ...playerState, status: Status.ERROR, error: 'The extension worker did not respond. Try again.' };
    render();
  }
}

function doRefresh() {
  // Spin the icon briefly for feedback
  el.refresh.classList.add('icon-btn--spinning');
  setTimeout(() => el.refresh.classList.remove('icon-btn--spinning'), 650);
  extract(false);
}

/* ------------------------------------------------------------------ doc stats */

function applyDocStats(payload) {
  const stats = payload?.stats;
  const strategy = payload?.strategy || '';
  const adapter = strategy.startsWith('adapter:') ? strategy.slice(8) : '';
  el.site.textContent = strategy === 'selection' ? 'Your selection' : adapter;
  const secs = stats?.estSeconds || 0;
  if (!secs) { el.time.textContent = ''; return; }
  const mins = Math.round(secs / 60);
  el.time.textContent = mins < 1 ? 'under a minute' : `${mins} min listen`;
}

/* ------------------------------------------------------------------ keyboard */

function setRovingFocus(i, moveFocus = true) {
  if (!lines.length) return;
  const next = Math.max(0, Math.min(i, lines.length - 1));
  if (lines[focusIndex]) lines[focusIndex].tabIndex = -1;
  focusIndex = next;
  lines[focusIndex].tabIndex = 0;
  if (moveFocus) lines[focusIndex].focus();
}

/* ================================================================ Event wiring */

/* Transport */
el.play.addEventListener('click', onPlayPause);
el.prev.addEventListener('click', () => send(Msg.PREV));
el.next.addEventListener('click', () => send(Msg.NEXT));
el.stop.addEventListener('click', () => send(Msg.STOP));
el.slower.addEventListener('click', () => nudgeSpeed(-1));
el.faster.addEventListener('click', () => nudgeSpeed(1));

/* Extraction */
el.read.addEventListener('click', () => extract(false));
el.readSelection.addEventListener('click', () => extract(true));
el.retry.addEventListener('click', () => extract(false));

/* Page refresh */
el.refresh.addEventListener('click', doRefresh);
el.bannerRefresh.addEventListener('click', doRefresh);

/* Settings drawer */
el.settingsBtn.addEventListener('click', openSettings);
el.setup.addEventListener('click', openSettings);
el.closeSettings.addEventListener('click', closeSettings);
el.drawerBackdrop.addEventListener('click', closeSettings);

/* Voice Quick-Select */
el.voiceQuick.addEventListener('click', () => {
  openSettings();
  setTimeout(() => el.voicePickerTrigger.focus(), 50); // delay to let drawer display
});

/* Escape key closes drawer */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawerOpen) { closeSettings(); return; }
  if (e.key !== ' ' && e.code !== 'Space') return;
  const tag = document.activeElement?.tagName;
  if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  e.preventDefault();
  onPlayPause();
});

/* ---- Drawer inputs ---- */

el.drawerSpeed.addEventListener('input', () => {
  const v = Number(el.drawerSpeed.value);
  el.drawerSpeedOut.textContent = speedLabel(v);
});
el.drawerSpeed.addEventListener('change', () => {
  const v = Number(el.drawerSpeed.value);
  saveSetting({ speed: v });
  render();
});

el.drawerHighlight.addEventListener('change', () => saveSetting({ highlight: el.drawerHighlight.checked }));
el.drawerAutoScroll.addEventListener('change', () => saveSetting({ autoScroll: el.drawerAutoScroll.checked }));
el.drawerSkipCode.addEventListener('change', () => saveSetting({ skipCode: el.drawerSkipCode.checked }));
el.drawerSkipTables.addEventListener('change', () => saveSetting({ skipTables: el.drawerSkipTables.checked }));

/* Model chips */
[el.modelFree, el.modelPro].forEach((radio) => {
  radio.addEventListener('change', () => {
    if (radio.checked) saveSetting({ model: radio.value });
  });
});

/* API key */
el.drawerKeyToggle.addEventListener('click', () => {
  const hidden = el.drawerApiKey.type === 'password';
  el.drawerApiKey.type = hidden ? 'text' : 'password';
  el.drawerKeyToggle.textContent = hidden ? 'Hide' : 'Show';
});
el.drawerApiKey.addEventListener('change', () => {
  saveSetting({ apiKey: el.drawerApiKey.value.trim() });
});

el.drawerTestKey.addEventListener('click', async () => {
  el.drawerKeyStatus.textContent = 'Testing…';
  const key = el.drawerApiKey.value.trim();
  if (!key) { el.drawerKeyStatus.textContent = 'Using embedded key (no override set)'; return; }
  try {
    const res = await fetch('https://api.fish.audio/v1/voices?page_size=1', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) {
      el.drawerKeyStatus.textContent = '✓ Key is valid';
      el.drawerKeyStatus.style.color = '#16a34a';
    } else {
      el.drawerKeyStatus.textContent = `✗ Error ${res.status}`;
      el.drawerKeyStatus.style.color = '#dc2626';
    }
  } catch {
    el.drawerKeyStatus.textContent = '✗ Could not reach Fish Audio';
    el.drawerKeyStatus.style.color = '#dc2626';
  }
  setTimeout(() => {
    el.drawerKeyStatus.textContent = '';
    el.drawerKeyStatus.style.color = '';
  }, 4000);
});

el.drawerCustomVoice.addEventListener('change', () => {
  saveSetting({ customVoice: el.drawerCustomVoice.value.trim() });
});

el.drawerClearCache.addEventListener('click', async () => {
  el.drawerCacheStatus.textContent = 'Clearing…';
  await send(Msg.CLEAR_CACHE);
  el.drawerCacheStatus.textContent = '✓ Cache cleared';
  setTimeout(() => { el.drawerCacheStatus.textContent = ''; }, 3000);
});

/* ---- Follow pill ---- */

el.follow.addEventListener('click', () => {
  following = true;
  el.follow.hidden = true;
  scrollToCurrent();
});

/* ---- Transcript click / keyboard / scroll ---- */

el.transcript.addEventListener('click', (e) => {
  const line = e.target.closest('.line');
  if (!line || line.classList.contains('line--skipped')) return;
  const index = Number(line.dataset.index);
  if (!Number.isInteger(index)) return;
  following = true;
  setRovingFocus(index, false);
  send(Msg.SEEK, { index });
});

el.transcript.addEventListener('keydown', (e) => {
  const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[e.key];
  if (step) {
    e.preventDefault();
    setRovingFocus(focusIndex + step);
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    setRovingFocus(e.key === 'Home' ? 0 : lines.length - 1);
  }
});

el.transcript.addEventListener('scroll', () => {
  if (selfScrolling > 0) return;
  if (following && !isCurrentVisible()) following = false;
  updateFollowPill();
}, { passive: true });

/* ================================================================ Message handling */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target === 'offscreen') return;

  if (msg?.type === Msg.STATE) {
    playerState = { ...playerState, ...msg.payload };
    render();

  } else if (msg?.type === Msg.DOC) {
    utterances = msg.payload?.utterances || [];
    el.title.textContent = msg.payload?.title || '';
    applyDocStats(msg.payload);
    renderTranscript();
    render();
    // Hide the page-changed banner once a doc loads
    el.pageBanner.hidden = true;

  } else if (msg?.type === Msg.PAGE_CHANGED) {
    // Navigation happened — prompt the user to re-read the new page.
    // Only show if we previously had a document loaded.
    if (utterances.length > 0 || playerState.status !== Status.IDLE) {
      utterances = [];
      el.pageBanner.hidden = false;
      el.docHeader.hidden = true;
      renderTranscript();
      playerState = { ...playerState, status: Status.IDLE, index: 0, total: 0 };
      render();
    }
  }
});

/* ================================================================ Boot */

(async function init() {
  buildVoicePicker();

  const [s, st, d] = await Promise.all([
    send(Msg.GET_SETTINGS),
    send(Msg.GET_STATE),
    send(Msg.GET_DOC),
  ]);
  if (s && s.ok !== false) settings = s;
  if (st && st.status) playerState = { ...playerState, ...st };
  if (d?.utterances?.length) {
    utterances = d.utterances;
    el.title.textContent = d.title || '';
    applyDocStats(d);
    renderTranscript();
  }
  render();
})();
