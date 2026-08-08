# Read-a-Laud

A Chrome extension that reads web pages and study notes aloud, using [Fish Audio](https://fish.audio) for speech.

Built for two people: the student who wants to *listen* to their notes instead of re-reading them, and the reader who'd rather hear a long article than scroll it.

---

## The hard part isn't the speech. It's the scraping.

Text-to-speech is a solved API call. The thing that makes a page reader good or unbearable is **what text you feed it**. Every page is a different layout, and the naive approaches all fail in the same predictable ways:

| Naive approach | What it sounds like |
|---|---|
| `document.body.innerText` | Nav menus, cookie banners, "Subscribe to our newsletter", footer link soup — several minutes before the article even starts |
| `document.querySelector('article')` | Works on maybe 40% of sites, silently returns nothing on the rest |
| Strip all tags, read the text | Code blocks read character-by-character. Tables read as a stream of orphaned numbers. `[1]` footnote markers read aloud as "one" mid-sentence |

So the extraction pipeline is the actual product. Here's how it works.

### Layer 1 — Selection (highest priority)

If you've highlighted text, that's unambiguously what you want read. No heuristic beats an explicit signal. This is also the primary flow for students: highlight one paragraph of notes, hit `Alt+Shift+S`.

### Layer 2 — Site adapters

Hand-written handlers for sites whose structure is known and whose generic extraction is poor:

- **Wikipedia** — drops infoboxes, navboxes, `[edit]` markers, coordinates, and everything after *References* / *External links* (pure link soup in audio)
- **Google Docs** — reads `.kix-*` spans; **detects canvas-rendered docs**, where there is genuinely no text in the DOM, and says so instead of failing silently
- **Notion**, **GitHub** (README vs. code blob), **StackOverflow** (question + answers, labelled, comments skipped), **arXiv**, **Medium/Substack**
- **PDF detector** — Chrome's built-in PDF viewer exposes *no* text to extensions. Rather than produce silence, it explains why

### Layer 3 — Mozilla Readability

The same engine behind Firefox Reader Mode ([vendored, v0.5.0](src/vendor/Readability.js), Apache 2.0). It's the best general-purpose article extractor available and handles the long tail of blogs and news sites.

Two non-obvious things about using it correctly:

1. **It mutates the document you hand it.** You must pass `document.cloneNode(true)`, or you destroy the live page.
2. It returns HTML as a *string*, which severs any connection to the live DOM — a problem, because we need that connection for highlighting (see below).

### Layer 4 — Text-density fallback

When Readability returns nothing or under ~250 characters, candidate containers are scored on text-to-markup density: link density, paragraph count, comma count, and negative weights for class/id patterns (`nav`, `sidebar`, `comment`, `footer`, `promo`, `cookie`, `banner`, `modal`, `ad`). The highest-scoring container wins.

### The uid round-trip — how highlighting survives extraction

To highlight the sentence currently being spoken, each extracted block must point back to a **live DOM node**. Readability's string output destroys that link. The fix:

1. Walk the **live** document, stamping every candidate block with `data-ral-uid="u1"`, `u2`, … and keeping a `uid → Element` map
2. **Then** clone, and run Readability on the clone — attributes survive both cloning and serialization, so the uids ride along
3. Parse Readability's output HTML and read the uids back out to recover which live node each block came from

One trap worth naming: `getComputedStyle` on a cloned document is meaningless, because the clone was never rendered. Visibility filtering has to happen against the live nodes.

---

## Text → speech-ready, which is its own problem

Clean text still isn't speakable text. `speechify.js` handles:

**Bracket safety (the subtle one).** Fish's S2 models read `[word]` as emotion/style markup. Real pages are full of `[1]`, `[citation needed]`, `[edit]`. Passed through untouched, these get swallowed or voiced as stage directions — and the cause is nearly impossible to guess from the garbled audio. So all page brackets are stripped *before* any of our own markup goes in. After that point, every remaining bracket in the string is ours.

**Structure-aware reading**, rather than flattening everything to prose:

- **Tables** are linearized row-wise, each cell paired with its column header — `"Row 1: City, Delhi; Population, 32 million"`. Read left-to-right without headers, a table is just numbers with no referent
- **Code blocks** are summarized (`"Code block, 12 lines, skipped"`) by default, because reading code aloud is dominated by punctuation and indentation is invisible in audio
- **Figures** read their caption, but captions under 3 words or generic junk (`"image"`, `"photo"`) are dropped
- **Headings** get `[long-break]` before top-level sections and `[break]` after — most of what conveys document structure in audio
- **Quotes** are bracketed with *"Quote, … End quote."*

**Normalization**: `e.g.` → "for example", `₹500` → "500 rupees", `5km` → "5 kilometers", `12%` → "12 percent". URLs collapse to spoken domains (`arxiv.org/abs/2301.00001` → "arxiv dot org") — reading a full URL aloud is unbearable.

**Sentence segmentation** uses `Intl.Segmenter`, which is locale-aware and handles Devanagari danda (।) and CJK punctuation for free. But it implements UAX #29, which has **no abbreviation exception list** — it genuinely splits "Dr. Bose" into two sentences. Its output is repaired by re-joining segments ending in a known abbreviation, initial, or dotted acronym. ([Caught by a test](test/speechify.test.mjs), not by reading the spec.)

---

## Architecture

```
side panel (UI)  ──┐
                   ├──►  service worker  ──►  content scripts (extract + highlight)
options page  ─────┘      (coordinator)   ──►  offscreen document (fetch + cache + play)
```

**Why an offscreen document?** An MV3 service worker cannot play audio — no `Audio` constructor, no `URL.createObjectURL`, and it's killed after ~30s idle. And `chrome.runtime.sendMessage` structured-clones to JSON, so a `Blob` **cannot** be passed between contexts. That single constraint forces the design: the offscreen document owns the *entire* audio path — network, cache, decode, playback. The worker only ever sends text and settings.

**Prefetch pipeline.** Utterances are synthesized 2 ahead of the play head, memoized by index so no text is ever paid for twice, and aborted on seek so abandoned work stops competing for request slots. Two `<audio>` elements ping-pong so the next chunk starts the instant the current one ends.

Sequential blob playback is deliberate rather than `MediaSource`: separately-encoded MP3s each carry encoder delay and padding, so appending them to one `SourceBuffer` produces audible artifacts. Back-to-back elements give a small, consistent gap that is far less objectionable for speech.

**Caching.** Fish bills per UTF-8 byte of *input*, so re-reading a page you've already heard should cost nothing. Audio is cached in IndexedDB keyed on SHA-256 of `(text, voice, model, speed, volume)` with LRU eviction at 250 MB. The cache degrades to a permanent miss if IndexedDB is unavailable — a broken cache must slow the reader down, never break it.

**Speed** is applied as `playbackRate` (with `preservesPitch`), not `prosody.speed`. Instant, free, and cache-preserving; the alternative would re-bill the whole article every time you nudge the slider.

---

## Fish Audio integration

| | |
|---|---|
| Endpoint | `POST https://api.fish.audio/v1/tts` |
| Model | Selected via the `model` **HTTP header**, not a body field |
| Valid models | `s1`, `s2-pro`, `s2.1-pro`, `s2.1-pro-free` |
| Default here | **`s2.1-pro-free`** — $0.00/M bytes |
| Paid | `s2.1-pro` — $15.00 per 1M UTF-8 input bytes |
| Concurrency | 5 (starter) / 15 ($100+) / 50 ($1000+). No documented RPM limit |

Requests are capped at **4 concurrent**, one below the starter tier, so the extension never fully saturates an account it might be sharing.

Cost in practice: a 5,000-character article is ~5,000 bytes ≈ **$0.075** on the paid model, or free on `s2.1-pro-free`. Cached re-reads are always free.

### On Indian voices — an honest caveat

**Fish's officially documented language list (13 languages) does not include Hindi**, or any other Indian language. What that means in practice:

- **Indian-accented English voices** — reliable. English is fully supported; the accent comes from the voice model
- **Hindi, Tamil, Telugu, Marathi, Bengali output** — depends on community-trained voice models. These exist and many work, but quality varies and none of it is officially supported

Because the API also doesn't document which `language` codes it accepts, the voice list is **discovered empirically** rather than hardcoded: `discoverIndianVoices()` probes `hi`, `hi-IN`, `en-IN`, `mr`, `ta`, `te`, `bn`, `gu`, `kn`, `ml`, `pa`, `ur` plus title searches, tolerates per-probe failures, and merges what comes back. **Audition a voice before committing to it.**

---

## Install

```bash
git clone <this repo>
```

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this directory
3. Get a key at [fish.audio/app/api-keys](https://fish.audio/app/api-keys)
4. Open the extension options, paste the key, hit **Test key**, pick a voice

Click the toolbar icon on any page to open the side panel.

| Shortcut | Action |
|---|---|
| `Alt+Shift+P` | Play / pause |
| `Alt+Shift+S` | Read selection |

Your API key is stored in `chrome.storage.local` and is only ever sent to `api.fish.audio`.

## Tests

```bash
npm test
```

Covers the pure logic — bracket safety, abbreviation and unit expansion, URL collapsing, sentence segmentation, and the full block→utterance pipeline.

## Layout

```
manifest.json
src/
  lib/          protocol.js (shared contract) · fish.js · cache.js
                segmenter.js · speechify.js
  background/   service-worker.js      coordinator, owns state, no audio
  content/      extract.js · adapters.js · density.js · content.js
  offscreen/    pipeline.js · offscreen.js    fetch + cache + playback
  sidepanel/    player UI, transcript, transport
  options/      key, model, voice, reading preferences
  vendor/       Readability.js (Mozilla, Apache 2.0)
```

## License

Readability.js is Apache 2.0, © Arc90 / Mozilla.
