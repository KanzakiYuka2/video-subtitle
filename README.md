<div align="center">

![Multi-Platform Video Subtitle Overlay Banner](docs/images/banner.svg)

# Subtitle Overlay Assistant

**A Chrome MV3 extension that brings external subtitles (`.ass`, `.srt`, `.ssa`, `.vtt`) to streaming video players — featuring smart Jimaku.cc + AniList matching, interactive Click-to-Sync, and a plug-and-play Player Adapter architecture.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](extension/manifest.json)
[![Languages](https://img.shields.io/badge/i18n-EN%20%7C%20日本語%20%7C%20简体中文-eb5528)](extension/i18n.js)
[![Players](https://img.shields.io/badge/Players-d--anime%20Store%20%7C%20Prime%20Video-00a8e1)](extension/players/registry.js)

**English** | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

</div>

---

## Visual Showcase

![Feature Showcase](docs/images/demo-showcase.svg)

---

## Why This Extension?

Japanese language learners, deaf/hard-of-hearing viewers, and multi-platform VOD subscribers often run into streaming services that lack selectable subtitles or accurate closed captions.

**Subtitle Overlay Assistant** renders crisp, customizable external subtitles directly on top of your video player (including fullscreen mode), works out of the box on both **d-anime Store** and **Amazon Prime Video**, and separates site-specific player code into clean adapters so anyone can extend it to additional platforms in minutes.

---

## Supported Platforms

| Platform | Adapter | Detection & Search Behavior |
| :--- | :--- | :--- |
| **d-anime Store** (`animestore.docomo.ne.jp`) | [`extension/players/danime.js`](extension/players/danime.js) | Extracts title, episode number, and episode subtitle (`partTitle`) via `WS010105` API & DOM; supports automatic search & apply on load. |
| **Amazon Prime Video** (`primevideo.com`, `amazon.co.jp`) | [`extension/players/prime.js`](extension/players/prime.js) | Picks the largest active `<video>`, reads `atvwebplayersdk` title/subtitle DOM, defaults search category to **Drama / Live-Action** or **Anime**, and resets subtitles automatically on SPA episode changes. |
| **Your Favorite VOD Site** | Modular Adapter API | Drop in a single file under `extension/players/` — see [Adding a New Player Adapter](#contributor-guide-adding-a-new-player-adapter). |

---

## Key Features

- **Smart Multi-Stage Search (`Jimaku.cc` + `AniList`)**
  - Resolves sequels, split-cours, and cumulative vs. per-season episode numbering automatically via AniList GraphQL franchise chains.
  - Preserves legitimate bracketed titles (e.g., `【Oshi no Ko】`) while stripping broadcast/edition noise tags.
  - Matches episode titles (`partTitle`) for ambiguous compilations or OVAs and supports direct live-action / drama search on Jimaku.cc.
  - Multi-entry fallback automatically checks alternative Jimaku folders if the top result has no matching episode file, and remembers your preferred entry per series/season.
- **Expandable & Draggable Source Priority + Default Offset Dictionary**
  - Clean 1-to-1 ordered list combining **Source Priority** and **Per-Source Default Offset** (for example, `Netflix` defaults to `-1.0s` out of the box).
  - Collapsed by default so you can adjust priorities and offsets on the fly without cluttering your screen while watching.
  - Drag rows (`⋮⋮`) to reorder priority at any time, add custom sources, or edit default offsets inline.
  - `Other` serves as the catch-all fallback: it can be reordered by dragging, while its default offset remains locked at `0.0s` and it cannot be deleted.
- **Per-Title & Per-Source Memory**
  - Resolution order when loading subtitles: `Saved Title × Source Offset` → `Saved Title Offset` → `Configured Source Default` → `0.0s`.
- **Interactive Click-to-Sync Transcript Drawer**
  - Click any displayed subtitle (or press Enter/Space on it) to open the scrollable transcript drawer (`#danime-sub-lyrics`).
  - Click the line currently spoken to immediately align the entire subtitle track (**Sync this line to now**), or switch to **Seek mode** to jump the video to any line.
- **Local File Support & SRT Export**
  - Supports `.ass`, `.ssa`, `.srt`, and `.vtt` (automatically skipping non-Japanese/CJK style tags in dual-language ASS files).
  - Drag & drop subtitle files anywhere on the player page, and export timing-ready `.srt` files in one click.
- **Responsive Styling & Keyboard Ergonomics**
  - Clean defaults out of the box: **4.5%** responsive font scale relative to video height, **5%** bottom offset, and **0% (transparent)** background with black text outline for crisp legibility.
  - Full keyboard isolation prevents host player hotkeys (`Space`, `Arrow` keys, `F`, `M`, `Enter`) from hijacking panel inputs.
  - Masked API key inputs suppress intrusive browser *"Save password?"* prompts.
- **Full Localization (`English`, `日本語`, `简体中文`)**
  - Built-in `_locales` manifest localization and instant in-app language switcher synced across the control panel and toolbar popup.

---

## Installation

1. Clone or download this repository:
   ```bash
   git clone https://github.com/kysing02/video-subtitle.git
   ```
2. Open Google Chrome (or Edge / Chromium-based browser) and navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the [`extension/`](extension/) folder inside the cloned repository.
5. *(Optional for auto-search)* Get a free API Key from [jimaku.cc/account](https://jimaku.cc/account), click the extension icon in your toolbar (or open Settings inside the player panel), and paste your API key.

---

## Keyboard Shortcuts & Controls

| Action | Shortcut / Interaction |
| :--- | :--- |
| Toggle subtitles ON / OFF | `Alt + S` |
| Adjust timing by `-0.5s` / `+0.5s` | `[` / `]` |
| Open interactive transcript drawer (Click-to-Sync / Seek) | Click the displayed subtitle text |
| Move subtitle vertical position | Drag the displayed subtitle text up / down |
| Fine sync controls (`-5s` to `+5s`) | Footer bar inside the `💬 Subtitles` panel |

---

## Contributor Guide: Adding a New Player Adapter

![Modular Player Adapter Architecture](docs/images/architecture.svg)

Site-specific player integrations live independently under [`extension/players/`](extension/players/). Core overlay rendering, subtitle parsing, transcript sync, localization, and search live outside the adapters.

### 1. Create `extension/players/<site>.js`

Implement and register an adapter object via `window.SubtitlePlayerRegistry.register(...)`:

```js
/**
 * Example Player Adapter for MyVOD
 */
(function (root) {
  'use strict';

  const registry = root.SubtitlePlayerRegistry;
  if (!registry) return;

  registry.register({
    id: 'myvod',
    name: 'MyVOD',
    matches: (loc) => /(^|\.)myvod\.example$/.test(loc.hostname),

    // Behavior flags consumed by content.js
    defaultSearchKind: 'anime', // 'anime' | 'drama'
    autoSearchOnLoad: true,     // true = auto-search & apply when metadata changes
    resetOnNavigation: true,    // true = clear loaded cues on SPA URL change
    pollMetadata: true,         // true = re-check work/episode DOM periodically
    alwaysResolveVideo: false,  // true = re-query active <video> on every render tick
    uiClass: '',                // Optional CSS class added to #danime-sub-fab & #danime-sub-panel

    // Return the active HTMLVideoElement
    getVideo() {
      return document.querySelector('video');
    },

    // Extract { partId, workTitle, cleanTitle, partDispNumber, partTitle, episodeNumber }
    async detectWorkInfo({ cleanWorkTitle, parseEpisodeNumber }) {
      const rawTitle = document.querySelector('.player-title')?.textContent?.trim() || '';
      const rawEp = document.querySelector('.player-episode')?.textContent?.trim() || '';
      if (!rawTitle) return null;
      return {
        partId: location.pathname,
        workTitle: rawTitle,
        cleanTitle: cleanWorkTitle(rawTitle),
        partDispNumber: rawEp,
        partTitle: '',
        episodeNumber: parseEpisodeNumber(rawEp),
      };
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
```

### 2. Register permissions & script order in `extension/manifest.json`

1. Add your site's origin pattern to `host_permissions` and `content_scripts[0].matches`.
2. Add `"players/<site>.js"` to `content_scripts[0].js` right after `"players/registry.js"` and before `"content.js"`.

### 3. Run Local Browser & Syntax Checks

```bash
# Validate JS syntax & JSON manifests
node -c extension/players/<site>.js extension/content.js extension/background.js
python3 -c "import json; json.load(open('extension/manifest.json'))"

# Build isolated offline browser fixtures and run headless Chrome verification
python3 tests/build-browser-fixture.py
python3 tests/build-browser-fixture.py --search
google-chrome --headless --disable-gpu --no-sandbox --dump-dom "file:///tmp/prime-subtitle-test.html" | grep 'id="result"'
google-chrome --headless --disable-gpu --no-sandbox --dump-dom "file:///tmp/subtitle-search-test.html" | grep 'id="result"'
```

---

## Project Structure & Branches

```text
.
├── extension/
│   ├── _locales/              # Chrome MV3 extension metadata (en, ja, zh_CN)
│   ├── players/
│   │   ├── registry.js        # Player adapter registry & backwards-compatible facade
│   │   ├── danime.js          # d-anime Store adapter
│   │   └── prime.js           # Amazon Prime Video adapter
│   ├── background.js          # Service worker: AniList + Jimaku API & ranking
│   ├── content.js             # Core UI, overlay sync, shortcuts, storage sync
│   ├── i18n.js                # Runtime EN / JA / ZH-CN UI catalog
│   ├── parser.js              # .ass / .ssa / .srt / .vtt parser & SRT exporter
│   ├── source_profiles.js     # Expandable draggable source priority & offset editor
│   ├── popup.html / popup.js  # Toolbar popup UI
│   ├── styles.css             # Overlay, transcript drawer & panel styling
│   └── manifest.json          # Chrome Manifest V3 configuration
├── docs/images/               # Showcase & architecture SVGs
└── tests/                     # Offline browser fixtures & regression tests
```

- `main`: Stable production release branch.
- `dev`: Integration branch for upcoming stable releases.
- `feat/ai-realtime`: Experimental real-time AI speech-to-text transcription branch (kept separate from `main` / `dev` while under active development).

---

## License

Released under the [MIT License](LICENSE).
