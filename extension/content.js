/**
 * Content Script for Multi-Platform Video Subtitle Overlay Assistant
 * - Delegates site detection, video resolution, and metadata extraction to registered player adapters
 * - Stops keyboard event propagation when panel inputs are focused or panel is open
 *   so player shortcuts (Space, Arrow keys, F, M, Enter, etc.) never hijack typing
 * - Automatically searches & applies best matching subtitles on supported platforms
 *   with multi-entry fallback and AniList franchise/split-cour episode resolution
 * - Supports a 1-to-1 ordered source priority & default offset dictionary (`Other` locked to 0.0s)
 * - Supports per-title (& per-title x source) offset memory and saved subtitle entry memory
 * - Supports responsive font scaling relative to video/viewport height & transparent subtitle background
 */

(function () {
  if (window.__DANIME_SUB_ASSISTANT_LOADED__) return;
  window.__DANIME_SUB_ASSISTANT_LOADED__ = true;

  const player = window.SubtitlePlayer || {
    activeAdapter: null,
    isPrime: false,
    getVideo: () => document.querySelector('video'),
    primeInfo: () => ({}),
    detectWorkInfo: async () => null,
  };
  const getAdapter = () =>
    (window.SubtitlePlayerRegistry && window.SubtitlePlayerRegistry.getActiveAdapter()) ||
    player.activeAdapter || {
      id: player.isPrime ? 'prime' : 'generic',
      name: player.isPrime ? 'Amazon Prime Video' : 'HTML5 Video',
      defaultSearchKind: player.isPrime ? 'drama' : 'anime',
      autoSearchOnLoad: !player.isPrime,
      resetOnNavigation: Boolean(player.isPrime),
      pollMetadata: Boolean(player.isPrime),
      alwaysResolveVideo: Boolean(player.isPrime),
      uiClass: player.isPrime ? 'dsub-prime' : '',
      getVideo: () => player.getVideo(),
      detectWorkInfo: (helpers) => player.detectWorkInfo(helpers),
    };
  let mediaGeneration = 0;

  const SP = window.DSubSourceProfiles;
  let sourceEditor = null;

  const LEGACY_DEFAULT_SOURCES = new Set([
    'Netflix,ABEMA,WebRip,BD',
    'Netflix,ABEMA,DMMTV,Prime,U-NEXT,WebRip,BD',
    'ABEMA,DMMTV,U-NEXT,Amazon,Netflix,NanokoRaws,shincaps,WebRip,BD',
  ]);

  // State
  const state = {
    enabled: true,
    cues: [], // Array<{ start: number, end: number, text: string }>
    offsetSec: 0.0,
    offsetRuleLabel: '',
    currentSourceCategory: '',
    sourceLabel: '未読込',
    lastAutoSearchedPartId: '',
    workInfo: {
      partId: '',
      workTitle: '',
      cleanTitle: '',
      partDispNumber: '',
      partTitle: '',
      episodeNumber: null,
    },
    settings: {
      jimakuApiKey: '',
      fontScale: 4.5,
      bottomPosition: 5,
      bgOpacity: 0.0,
      textColor: '#ffffff',
      autoSearchApply: true,
      preferredFormat: 'ass,srt,vtt',
      sourceProfiles: SP.cloneDefaultProfiles(),
      preferredSource: SP.DEFAULT_PREFERRED_SOURCE,
      netflixDefaultOffsetSec: -1.0,
      workOffsets: {}, // { [workKey]: number, [`${workKey}::${sourceCat}`]: number }
      workEntries: {}, // { [`${workKey}::s${season}`]: entryId }
    },
  };

  let overlayEl = null;
  let subBoxEl = null;
  let fabEl = null;
  let panelEl = null;
  let currentVideo = null;
  let lyricsEl = null;
  let lyricsListEl = null;
  let lyricsCues = null;
  let lyricsCount = -1;
  let lyricsIndex = -1;
  let suppressSubtitleClick = false;

  /**
   * Clean d-anime edition/broadcast tag brackets while preserving title brackets like 【推しの子】.
   * Also unwraps `テレビアニメ「Title」ArcName`.
   */
  function cleanWorkTitle(rawTitle) {
    if (!rawTitle) return '';
    let s = rawTitle
      .replace(/【[^】]*(?:版|放送|配信|ver|限定|特典|吹替|字幕|年齢|R\d+|禁|Web)[^】]*】/gi, ' ')
      .replace(/\[[^\]]*(?:版|放送|配信|ver|限定|特典|吹替|字幕|年齢|R\d+|禁|Web)[^\]]*\]/gi, ' ')
      .replace(/[（(＜<][^）)＞>]*(?:版|吹替|字幕|放送|オンエア)[^）)＞>]*[）)＞>]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const tvMatch = s.match(/^(?:テレビアニメ|TVアニメ)\s*「([^」]+)」\s*(.*)$/i);
    if (tvMatch) {
      const core = tvMatch[1].trim();
      const arc = tvMatch[2].trim();
      s = !arc || /竈門炭治郎\s*立志編/.test(arc) ? core : `${core} ${arc}`.trim();
    }

    return s
      .replace(
        /[（(]\s*(第[0-9０-９一二三四五六七八九十]+(?:期|シーズン)|Season\s*\d+|\d+(?:nd|rd|th)\s*Season)\s*[）)]/gi,
        ' $1'
      )
      .replace(/\s+/g, ' ')
      .trim();
  }

  function detectSourceCategoryFromName(filename) {
    return SP.detectSourceCategory(filename, state.settings.sourceProfiles);
  }

  function getWorkStorageKey() {
    return (
      state.workInfo.cleanTitle ||
      cleanWorkTitle(state.workInfo.workTitle) ||
      state.workInfo.workTitle ||
      ''
    );
  }

  // Load saved settings
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        {
          ...state.settings,
          sourceProfiles: null,
          netflixOffsetMigratedV1: false,
          styleDefaultsMigratedV2: false,
        },
        (items) => {
          const updates = {};
          if (!items.preferredSource || LEGACY_DEFAULT_SOURCES.has(items.preferredSource)) {
            items.preferredSource = SP.DEFAULT_PREFERRED_SOURCE;
            updates.preferredSource = items.preferredSource;
          }
          if (!items.netflixOffsetMigratedV1) {
            if (Number(items.netflixDefaultOffsetSec) === 0) {
              items.netflixDefaultOffsetSec = -1.0;
            }
            updates.netflixDefaultOffsetSec = items.netflixDefaultOffsetSec;
            updates.netflixOffsetMigratedV1 = true;
          }
          if (!items.styleDefaultsMigratedV2) {
            if (Number(items.fontScale) === 3.2) items.fontScale = 4.5;
            if (Number(items.bottomPosition) === 10) items.bottomPosition = 5;
            updates.fontScale = items.fontScale;
            updates.bottomPosition = items.bottomPosition;
            updates.bgOpacity = items.bgOpacity ?? 0.0;
            updates.styleDefaultsMigratedV2 = true;
          }
          const hadProfiles = Array.isArray(items.sourceProfiles) && items.sourceProfiles.length > 0;
          items.sourceProfiles = SP.normalizeSourceProfiles(
            items.sourceProfiles,
            items.preferredSource,
            items.netflixDefaultOffsetSec
          );
          items.preferredSource = items.sourceProfiles.map((p) => p.name).join(',');
          const nfProfile = items.sourceProfiles.find((p) => p.id === 'netflix');
          items.netflixDefaultOffsetSec = nfProfile ? nfProfile.offset : -1.0;
          if (!hadProfiles) {
            updates.sourceProfiles = items.sourceProfiles;
            updates.preferredSource = items.preferredSource;
          }
          if (Object.keys(updates).length > 0) {
            chrome.storage.local.set(updates);
          }

          delete items.netflixOffsetMigratedV1;
          delete items.styleDefaultsMigratedV2;
          items.workOffsets = items.workOffsets && typeof items.workOffsets === 'object' ? items.workOffsets : {};
          items.workEntries = items.workEntries && typeof items.workEntries === 'object' ? items.workEntries : {};
          Object.assign(state.settings, items);
          syncSettingsToUI();
          applyOverlayStyles();
          resolve(state.settings);
        }
      );
    });
  }

  function saveSettings(partial) {
    Object.assign(state.settings, partial);
    chrome.storage.local.set(state.settings);
    applyOverlayStyles();
  }

  function sendBgMessage(payload) {
    const generation = mediaGeneration;
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (generation !== mediaGeneration) {
          resolve({ ok: false, error: '動画が切り替わりました。再検索してください。' });
        } else if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false, error: 'No response' });
        }
      });
    });
  }

  // Parse Japanese episode string like "第12話", "12話", "#03", "Episode 5" -> integer
  function parseEpisodeNumber(dispStr) {
    if (!dispStr) return null;
    const normalized = dispStr.replace(/[０-９]/g, (s) =>
      String.fromCharCode(s.charCodeAt(0) - 0xfee0)
    );
    const match = normalized.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  // Detect current work & episode metadata via the active player adapter
  async function detectWorkInfo() {
    const adapter = getAdapter();
    const info = await adapter.detectWorkInfo({
      cleanWorkTitle,
      parseEpisodeNumber,
    });
    if (!info) return state.workInfo;

    if (adapter.resetOnNavigation) {
      const previous = state.workInfo;
      if (
        previous.workTitle &&
        info.workTitle &&
        (previous.workTitle !== info.workTitle ||
          (previous.episodeNumber != null &&
            info.episodeNumber != null &&
            previous.episodeNumber !== info.episodeNumber))
      ) {
        resetPrimeEpisode();
      }
      // Retain known metadata while transient player overlays hide
      if (info.workTitle) {
        if (info.workTitle === state.workInfo.workTitle && info.episodeNumber == null) {
          info.episodeNumber = state.workInfo.episodeNumber;
          info.partDispNumber = state.workInfo.partDispNumber;
        }
        state.workInfo = info;
        updateMetadataUI();
      }
      return state.workInfo;
    }

    state.workInfo = info;
    updateMetadataUI();
    await maybeAutoSearchAndApply();
    return state.workInfo;
  }

  async function maybeAutoSearchAndApply() {
    const adapter = getAdapter();
    if (!adapter.autoSearchOnLoad) return;
    if (!state.settings.autoSearchApply) return;
    if (!state.settings.jimakuApiKey) return;
    const key = `${state.workInfo.partId}_${state.workInfo.cleanTitle}_${state.workInfo.episodeNumber}`;
    if (!state.workInfo.cleanTitle || key === state.lastAutoSearchedPartId) return;
    state.lastAutoSearchedPartId = key;
    await handleJimakuSearch({ autoApplyBest: true });
  }

  function updateMetadataUI() {
    if (!panelEl) return;
    const titleInput = panelEl.querySelector('#dsub-search-title');
    const epInput = panelEl.querySelector('#dsub-search-ep');
    if (titleInput && state.workInfo.cleanTitle && !titleInput.dataset.userEdited) {
      titleInput.value = state.workInfo.cleanTitle;
    }
    if (epInput && state.workInfo.episodeNumber != null && !epInput.dataset.userEdited) {
      epInput.value = state.workInfo.episodeNumber;
    }
  }

  /**
   * Resolve initial offset for the currently loaded subtitle file:
   * 1. Saved per-anime x source offset (workOffsets["Title::netflix"])
   * 2. Saved per-anime offset (workOffsets["Title"])
   * 3. Global Netflix default offset if sourceCategory === 'netflix' and non-zero
   * 4. 0.0s
   */
  function applySavedOffsetForSource(sourceCategory) {
    state.currentSourceCategory = sourceCategory || '';
    const workKey = getWorkStorageKey();
    const offsets = state.settings.workOffsets || {};

    let nextOffset = 0.0;
    let ruleLabel = '';

    if (workKey && sourceCategory && Object.prototype.hasOwnProperty.call(offsets, `${workKey}::${sourceCategory}`)) {
      nextOffset = Number(offsets[`${workKey}::${sourceCategory}`]) || 0.0;
      ruleLabel = `作品×${sourceCategory.toUpperCase()}記憶`;
    } else if (workKey && Object.prototype.hasOwnProperty.call(offsets, workKey)) {
      nextOffset = Number(offsets[workKey]) || 0.0;
      ruleLabel = '作品記憶';
    } else if (sourceCategory && sourceCategory !== 'other') {
      const profiles = SP.normalizeSourceProfiles(state.settings.sourceProfiles);
      const matchedProfile = profiles.find((p) => p.id === sourceCategory);
      if (matchedProfile && !matchedProfile.locked && Number(matchedProfile.offset) !== 0) {
        nextOffset = Number(matchedProfile.offset) || 0.0;
        ruleLabel = `${matchedProfile.name}標準`;
      }
    }

    state.offsetSec = Math.round(nextOffset * 10) / 10;
    state.offsetRuleLabel = ruleLabel;
    updateOffsetUI();
  }

  /**
   * Persist manual offset changes per anime (and per anime x source).
   */
  function saveCurrentWorkOffset() {
    const workKey = getWorkStorageKey();
    if (!workKey) return;
    const nextMap = { ...(state.settings.workOffsets || {}) };
    nextMap[workKey] = state.offsetSec;
    if (state.currentSourceCategory) {
      nextMap[`${workKey}::${state.currentSourceCategory}`] = state.offsetSec;
      state.offsetRuleLabel = `作品×${state.currentSourceCategory.toUpperCase()}記憶`;
    } else {
      state.offsetRuleLabel = '作品記憶';
    }
    saveSettings({ workOffsets: nextMap });
    updateOffsetUI();
  }

  // Create UI Elements
  function ensureUI() {
    if (document.getElementById('danime-sub-overlay')) return;

    // 1. Subtitle Overlay
    overlayEl = document.createElement('div');
    overlayEl.id = 'danime-sub-overlay';
    subBoxEl = document.createElement('div');
    subBoxEl.className = 'danime-sub-box';
    overlayEl.appendChild(subBoxEl);
    document.body.appendChild(overlayEl);

    subBoxEl.tabIndex = 0;
    subBoxEl.setAttribute('role', 'button');
    subBoxEl.setAttribute('aria-expanded', 'false');
    subBoxEl.title = 'クリックで字幕一覧・タイミング調整 / ドラッグで移動';
    subBoxEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!suppressSubtitleClick) toggleLyrics();
    });
    subBoxEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        toggleLyrics();
      }
    });
    createLyricsPad();

    // Make subtitle overlay vertically draggable
    makeOverlayDraggable(overlayEl, subBoxEl);

    // 2. Floating Action Button (FAB)
    const adapter = getAdapter();
    fabEl = document.createElement('button');
    fabEl.id = 'danime-sub-fab';
    if (adapter.uiClass) fabEl.classList.add(adapter.uiClass);
    fabEl.title = '字幕アシスタントを開く (Alt+S: 字幕ON/OFF)';
    fabEl.innerHTML = `<span>💬 字幕</span><span class="danime-sub-badge" id="danime-sub-fab-badge">未読込</span>`;
    fabEl.addEventListener('click', () => {
      panelEl.classList.toggle('open');
      fabEl.classList.toggle('active', panelEl.classList.contains('open'));
      if (panelEl.classList.contains('open')) {
        detectWorkInfo();
      }
    });
    document.body.appendChild(fabEl);

    // 3. Control Panel
    panelEl = document.createElement('div');
    panelEl.id = 'danime-sub-panel';
    if (adapter.uiClass) panelEl.classList.add(adapter.uiClass);
    // Make panel focusable so clicking anywhere inside keeps focus inside the panel
    panelEl.tabIndex = -1;
    panelEl.innerHTML = `
      <div class="dsub-header">
        <div class="dsub-title">🎬 字幕アシスタント</div>
        <button class="dsub-close" id="dsub-close-btn" title="閉じる">×</button>
      </div>

      <div class="dsub-tabs">
        <button class="dsub-tab active" data-tab="jimaku">🔍 自動検索</button>
        <button class="dsub-tab" data-tab="local">📂 ファイル</button>
        <button class="dsub-tab" data-tab="settings">⚙ 設定</button>
      </div>

      <div class="dsub-body">
        <!-- Tab 1: Jimaku.cc Search -->
        <div class="dsub-section active" id="dsub-tab-jimaku">
          <label class="dsub-row">検索対象
            <select class="dsub-select" id="dsub-search-kind" style="width:180px">
              <option value="anime" ${adapter.defaultSearchKind === 'anime' ? 'selected' : ''}>アニメ</option>
              <option value="drama" ${adapter.defaultSearchKind === 'drama' ? 'selected' : ''}>ドラマ・実写</option>
            </select>
          </label>
          <div class="dsub-row">
            <input type="text" class="dsub-input" id="dsub-search-title" placeholder="作品タイトル (日本語・英語・略称OK)" />
            <input type="number" class="dsub-input dsub-no-spin" id="dsub-search-ep" placeholder="話数" style="width: 68px;" min="0" />
          </div>
          <div class="dsub-row">
            <button class="dsub-btn dsub-btn-primary" id="dsub-jimaku-search-btn" style="width: 100%;">
              ${adapter.autoSearchOnLoad ? 'Jimaku.cc から検索＆最適字幕を適用' : 'Jimaku.cc から字幕を検索'}
            </button>
          </div>
          <div class="dsub-status" id="dsub-jimaku-status">
            ${adapter.autoSearchOnLoad ? '再生中の作品タイトルから自動で日本語字幕(.ass/.srt)を検索・適用します。' : `${adapter.name}: 作品名・話数を確認して検索してください。検出できない場合は手入力できます。`}
          </div>
          <div class="dsub-list" id="dsub-jimaku-results" style="display: none;"></div>
        </div>

        <!-- Tab 2: Local File -->
        <div class="dsub-section" id="dsub-tab-local">
          <div class="dsub-dropzone" id="dsub-dropzone">
            ここに <b>.srt / .ass / .ssa / .vtt</b> ファイルを<br/>ドラッグ＆ドロップ、またはクリックして選択
            <input type="file" id="dsub-file-input" accept=".srt,.ass,.ssa,.vtt" style="display: none;" />
          </div>
          <div class="dsub-row" style="justify-content: space-between;">
            <span class="dsub-hint">画面上どこでも字幕ファイルをドロップ可能です</span>
            <button class="dsub-btn" id="dsub-export-srt-btn" title="現在の字幕をSRT形式で保存">📥 SRT保存</button>
          </div>
        </div>

        <!-- Tab 3: Settings -->
        <div class="dsub-section" id="dsub-tab-settings">
          <div class="dsub-row">
            <label class="dsub-label" style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input type="checkbox" id="dsub-set-autoapply" checked />
              dアニメで動画を開いた時に自動で字幕を検索・適用する
            </label>
          </div>
          <div id="dsub-source-accordion-mount"></div>
          <div class="dsub-row">
            <span class="dsub-label">優先フォーマット</span>
            <select class="dsub-select" id="dsub-set-format" style="width: 185px;">
              <option value="ass,srt,vtt">ASS 優先 (.ass → .srt)</option>
              <option value="srt,ass,vtt">SRT 優先 (.srt → .ass)</option>
            </select>
          </div>
          <div>
            <div class="dsub-label" style="margin-bottom: 4px;">Jimaku.cc APIキー (<a href="https://jimaku.cc/account" target="_blank" rel="noopener" style="color:#ff7849;">無料取得</a>)</div>
            <input type="text" autocomplete="off" spellcheck="false" style="-webkit-text-security: disc;" class="dsub-input" id="dsub-set-apikey" placeholder="Jimaku API Key を貼り付け" />
          </div>
          <div class="dsub-row">
            <span class="dsub-label">文字サイズ比率 (<span id="dsub-val-fontsize">4.5</span>%)</span>
            <input type="range" id="dsub-set-fontsize" min="1.5" max="6.5" step="0.1" value="4.5" style="width: 150px;" />
          </div>
          <div class="dsub-row">
            <span class="dsub-label">下からの位置 (<span id="dsub-val-bottom">5</span>%)</span>
            <input type="range" id="dsub-set-bottom" min="2" max="85" value="5" style="width: 150px;" />
          </div>
          <div class="dsub-row">
            <span class="dsub-label">背景の不透明度 (<span id="dsub-val-opacity">0% 透明</span>)</span>
            <div style="display:flex;align-items:center;gap:6px;">
              <input type="range" id="dsub-set-opacity" min="0" max="100" value="0" style="width: 110px;" />
              <button class="dsub-btn" id="dsub-transparent-btn" style="padding:3px 6px;font-size:11px;" title="背景を完全透明にする">透明</button>
            </div>
          </div>
          <button class="dsub-btn dsub-btn-primary" id="dsub-save-settings-btn">設定を保存</button>
        </div>
      </div>

      <!-- Footer: Always-accessible sync offset & visibility toggle -->
      <div class="dsub-footer">
        <div class="dsub-row">
          <span class="dsub-label">タイミング: <b id="dsub-offset-val">0.0s</b> <small id="dsub-offset-rule" style="color:#ff7849;font-size:10px;"></small></span>
          <div class="dsub-offset-controls">
            <button class="dsub-btn" data-offset="-5" title="OP/提供スキップ調整 (-5秒)">-5s</button>
            <button class="dsub-btn" data-offset="-0.5">-0.5s</button>
            <button class="dsub-btn" data-offset="-0.1">-0.1s</button>
            <button class="dsub-btn" data-offset="0">0</button>
            <button class="dsub-btn" data-offset="+0.1">+0.1s</button>
            <button class="dsub-btn" data-offset="+0.5">+0.5s</button>
            <button class="dsub-btn" data-offset="+5">+5s</button>
          </div>
        </div>
        <div class="dsub-row" style="justify-content: space-between;">
          <span class="dsub-hint">ショートカット: <b>[</b> / <b>]</b> 0.5秒調整, <b>Alt+S</b> 表示切替</span>
          <button class="dsub-btn" id="dsub-clear-btn" style="padding: 3px 8px; font-size: 11px;">クリア</button>
        </div>
      </div>
    `;
    document.body.appendChild(panelEl);

    bindPanelEvents();
    syncSettingsToUI();
    applyOverlayStyles();
  }

  function createLyricsPad() {
    lyricsEl = document.createElement('section');
    lyricsEl.id = 'danime-sub-lyrics';
    lyricsEl.hidden = true;
    lyricsEl.setAttribute('aria-label', '字幕タイミング調整');
    lyricsEl.innerHTML = `
      <div class="dsub-lyrics-toolbar">
        <select aria-label="字幕クリック時の動作">
          <option value="sync">この台詞を今に合わせる</option>
          <option value="seek">この台詞へ動画を移動</option>
        </select>
        <button type="button" data-reset>調整リセット</button>
        <button type="button" data-close aria-label="字幕一覧を閉じる">×</button>
      </div>
      <div class="dsub-lyrics-help">前後にスクロールして台詞をクリック。字幕全体のタイミングを調整します。</div>
      <div class="dsub-lyrics-list" tabindex="0" aria-label="字幕一覧"></div>`;
    overlayEl.appendChild(lyricsEl);
    lyricsListEl = lyricsEl.querySelector('.dsub-lyrics-list');
    lyricsEl.querySelector('[data-close]').onclick = () => toggleLyrics(false);
    lyricsEl.querySelector('[data-reset]').onclick = () => {
      state.offsetSec = 0;
      updateOffsetUI();
      renderCurrentSubtitle();
    };
    lyricsEl.querySelector('select').onchange = (e) => {
      lyricsEl.querySelector('.dsub-lyrics-help').textContent = e.target.value === 'sync'
        ? '前後にスクロールして台詞をクリック。字幕全体のタイミングを調整します。'
        : '台詞をクリックすると、調整済みの開始時刻へ動画を移動します。';
    };
    ['click', 'dblclick', 'mousedown', 'pointerdown', 'wheel', 'keydown', 'keyup'].forEach((type) => {
      lyricsEl.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === 'keydown' && e.key === 'Escape') toggleLyrics(false);
      });
    });
    lyricsListEl.addEventListener('click', (e) => {
      const row = e.target.closest('[data-cue]');
      const video = player.getVideo();
      const cue = row && state.cues[Number(row.dataset.cue)];
      if (!cue || !video || !Number.isFinite(video.currentTime)) return;
      currentVideo = video;
      if (lyricsEl.querySelector('select').value === 'sync') {
        state.offsetSec = video.currentTime - cue.start;
        updateOffsetUI();
      } else {
        const target = Math.max(0, cue.start + state.offsetSec);
        video.currentTime = Number.isFinite(video.duration) ? Math.min(target, video.duration) : target;
      }
      renderCurrentSubtitle();
      toggleLyrics(false);
    });
  }

  function toggleLyrics(open = lyricsEl.hidden) {
    if (open && !state.cues.length) return;
    lyricsEl.hidden = !open;
    overlayEl.classList.toggle('lyrics-open', open);
    subBoxEl.setAttribute('aria-expanded', String(open));
    if (open) {
      renderCurrentSubtitle();
      const row = lyricsListEl.children[Math.max(0, lyricsIndex)];
      if (row) lyricsListEl.scrollTop = row.offsetTop - lyricsListEl.clientHeight / 2 + row.offsetHeight / 2;
      lyricsListEl.focus();
    } else {
      subBoxEl.focus({ preventScroll: true });
    }
  }

  function updateLyrics(t) {
    if (lyricsEl.hidden) return;
    if (lyricsCues !== state.cues || lyricsCount !== state.cues.length) {
      lyricsCues = state.cues;
      lyricsCount = state.cues.length;
      lyricsListEl.replaceChildren();
      state.cues.forEach((cue, index) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.dataset.cue = index;
        const minutes = Math.floor(cue.start / 60);
        const seconds = (cue.start % 60).toFixed(1).padStart(4, '0');
        row.textContent = `${minutes}:${seconds}  ${cue.text.replace(/<[^>]*>/g, '')}`;
        lyricsListEl.appendChild(row);
      });
    }
    lyricsIndex = state.cues.findIndex((cue) => t >= cue.start && t < cue.end);
    if (lyricsIndex < 0) {
      lyricsIndex = state.cues.findIndex((cue) => cue.start > t);
      if (lyricsIndex < 0) lyricsIndex = state.cues.length - 1;
    }
    Array.from(lyricsListEl.children).forEach((row, index) => {
      row.classList.toggle('active', index === lyricsIndex);
      row.setAttribute('aria-current', String(index === lyricsIndex));
    });
  }

  function makeOverlayDraggable(overlay, box) {
    let dragging = false;
    let startY = 0;
    let startBottom = 10;
    let moved = false;

    box.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      suppressSubtitleClick = false;
      startY = e.clientY;
      startBottom = state.settings.bottomPosition;
      box.style.cursor = 'grabbing';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const deltaY = startY - e.clientY;
      if (Math.abs(deltaY) < 5 && !moved) return;
      moved = true;
      suppressSubtitleClick = true;
      const deltaPct = (deltaY / window.innerHeight) * 100;
      const nextBottom = Math.min(90, Math.max(2, Math.round(startBottom + deltaPct)));
      saveSettings({ bottomPosition: nextBottom });
      const slider = panelEl?.querySelector('#dsub-set-bottom');
      const label = panelEl?.querySelector('#dsub-val-bottom');
      if (slider) slider.value = nextBottom;
      if (label) label.textContent = nextBottom;
    });

    window.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        box.style.cursor = 'grab';
      }
    });
  }

  function computeResponsiveFontSizePx() {
    const scale = Number(state.settings.fontScale) || 4.5;
    const v = currentVideo || player.getVideo();
    let baseHeight = window.innerHeight;
    if (v) {
      const rect = v.getBoundingClientRect();
      if (rect && rect.height > 100) {
        baseHeight = rect.height;
      }
    }
    return Math.max(12, Math.round(((baseHeight * scale) / 100) * 10) / 10);
  }

  function applyOverlayStyles() {
    if (!overlayEl || !subBoxEl) return;
    overlayEl.style.bottom = `${state.settings.bottomPosition}%`;
    const fontPx = computeResponsiveFontSizePx();
    subBoxEl.style.fontSize = `${fontPx}px`;
    subBoxEl.style.color = state.settings.textColor || '#ffffff';
    const op = Number(state.settings.bgOpacity ?? 0);
    if (op <= 0.01) {
      subBoxEl.style.backgroundColor = 'transparent';
    } else {
      subBoxEl.style.backgroundColor = `rgba(0, 0, 0, ${op})`;
    }
    overlayEl.style.display = state.enabled ? 'block' : 'none';
  }

  function syncSettingsToUI() {
    if (!panelEl) return;
    const apiKeyInput = panelEl.querySelector('#dsub-set-apikey');
    const fontSizeInput = panelEl.querySelector('#dsub-set-fontsize');
    const bottomInput = panelEl.querySelector('#dsub-set-bottom');
    const opacityInput = panelEl.querySelector('#dsub-set-opacity');
    const autoApplyInput = panelEl.querySelector('#dsub-set-autoapply');
    const formatInput = panelEl.querySelector('#dsub-set-format');

    const scale = Number(state.settings.fontScale) || 4.5;
    if (apiKeyInput) apiKeyInput.value = state.settings.jimakuApiKey || '';
    if (fontSizeInput) fontSizeInput.value = scale;
    if (bottomInput) bottomInput.value = state.settings.bottomPosition;

    const opPct = Math.round((state.settings.bgOpacity ?? 0) * 100);
    if (opacityInput) opacityInput.value = opPct;
    if (autoApplyInput) autoApplyInput.checked = Boolean(state.settings.autoSearchApply);
    if (formatInput) formatInput.value = state.settings.preferredFormat || 'ass,srt,vtt';
    if (sourceEditor) sourceEditor.render();

    const fsLabel = panelEl.querySelector('#dsub-val-fontsize');
    const btLabel = panelEl.querySelector('#dsub-val-bottom');
    const opLabel = panelEl.querySelector('#dsub-val-opacity');
    if (fsLabel) fsLabel.textContent = scale.toFixed(1);
    if (btLabel) btLabel.textContent = state.settings.bottomPosition;
    if (opLabel) opLabel.textContent = opPct === 0 ? '0% 透明' : `${opPct}%`;
  }

  function updateBadge(text) {
    state.sourceLabel = text;
    const badge = document.getElementById('danime-sub-fab-badge');
    if (badge) badge.textContent = text;
  }

  function setCues(cues, label) {
    state.cues = cues || [];
    if (!state.cues.length && lyricsEl && !lyricsEl.hidden) toggleLyrics(false);
    updateBadge(`${label} (${state.cues.length}行)`);
    renderCurrentSubtitle();
  }

  /**
   * Prevent d-anime player from hijacking keyboard events (Arrow keys, Space, F, M, Enter, etc.)
   * when the user is typing in or interacting with the subtitle panel.
   */
  function setupKeyboardIsolation() {
    const isInsidePanel = (target) => {
      if (!panelEl || !panelEl.classList.contains('open')) return false;
      if (target && panelEl.contains(target)) return true;
      if (document.activeElement && panelEl.contains(document.activeElement)) return true;
      return false;
    };

    const stopPlayerKeys = (e) => {
      if (!isInsidePanel(e.target)) return;

      if (e.altKey && (e.key === 's' || e.key === 'S')) return;

      if (
        e.type === 'keydown' &&
        e.key === 'Enter' &&
        e.target &&
        (e.target.id === 'dsub-search-title' || e.target.id === 'dsub-search-ep')
      ) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        handleJimakuSearch({ autoApplyBest: true });
        return;
      }

      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    window.addEventListener('keydown', stopPlayerKeys, true);
    window.addEventListener('keyup', stopPlayerKeys, true);
    window.addEventListener('keypress', stopPlayerKeys, true);
  }

  function bindPanelEvents() {
    panelEl.querySelector('#dsub-close-btn').addEventListener('click', () => {
      panelEl.classList.remove('open');
      fabEl.classList.remove('active');
    });

    const tabs = panelEl.querySelectorAll('.dsub-tab');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.remove('active'));
        panelEl.querySelectorAll('.dsub-section').forEach((s) => s.classList.remove('active'));
        tab.classList.add('active');
        const target = panelEl.querySelector(`#dsub-tab-${tab.dataset.tab}`);
        if (target) target.classList.add('active');
      });
    });

    const titleInput = panelEl.querySelector('#dsub-search-title');
    const epInput = panelEl.querySelector('#dsub-search-ep');
    titleInput.addEventListener('input', () => {
      titleInput.dataset.userEdited = '1';
    });
    epInput.addEventListener('input', () => {
      epInput.dataset.userEdited = '1';
    });

    panelEl
      .querySelector('#dsub-jimaku-search-btn')
      .addEventListener('click', () => handleJimakuSearch({ autoApplyBest: true }));

    // Local File Dropzone & Input
    const dropzone = panelEl.querySelector('#dsub-dropzone');
    const fileInput = panelEl.querySelector('#dsub-file-input');
    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        loadSubtitleFileObject(e.target.files[0]);
      }
    });

    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    window.addEventListener('dragleave', () => {
      dropzone.classList.remove('dragover');
    });
    window.addEventListener('drop', (e) => {
      dropzone.classList.remove('dragover');
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const file = files[0];
        if (/\.(srt|ass|ssa|vtt)$/i.test(file.name)) {
          e.preventDefault();
          loadSubtitleFileObject(file);
        }
      }
    });

    // Export SRT button
    panelEl.querySelector('#dsub-export-srt-btn').addEventListener('click', () => {
      if (!state.cues.length) {
        alert('保存する字幕データがありません。');
        return;
      }
      const srtText = window.SubtitleParser.toSRT(state.cues);
      const blob = new Blob([srtText], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const name = state.workInfo.cleanTitle
        ? `${state.workInfo.cleanTitle}_${state.workInfo.partDispNumber || ''}.srt`
        : 'subtitles.srt';
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    });

    // Settings inputs
    const apiKeyInput = panelEl.querySelector('#dsub-set-apikey');
    const fontSizeInput = panelEl.querySelector('#dsub-set-fontsize');
    const bottomInput = panelEl.querySelector('#dsub-set-bottom');
    const opacityInput = panelEl.querySelector('#dsub-set-opacity');
    const transparentBtn = panelEl.querySelector('#dsub-transparent-btn');
    const autoApplyInput = panelEl.querySelector('#dsub-set-autoapply');
    const formatInput = panelEl.querySelector('#dsub-set-format');
    const sourceMountEl = panelEl.querySelector('#dsub-source-accordion-mount');

    function persistSourceProfiles(profiles) {
      const normalized = SP.normalizeSourceProfiles(profiles);
      const nf = normalized.find((p) => p.id === 'netflix');
      saveSettings({
        sourceProfiles: normalized,
        preferredSource: normalized.map((p) => p.name).join(','),
        netflixDefaultOffsetSec: nf ? nf.offset : -1.0,
      });
    }

    sourceEditor = SP.mountSourceDictionary({
      container: sourceMountEl,
      getProfiles: () => state.settings.sourceProfiles,
      onChange: (nextProfiles) => {
        persistSourceProfiles(nextProfiles);
      },
      startOpen: false,
    });

    fontSizeInput.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      panelEl.querySelector('#dsub-val-fontsize').textContent = val.toFixed(1);
      saveSettings({ fontScale: val });
    });

    bottomInput.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      panelEl.querySelector('#dsub-val-bottom').textContent = val;
      saveSettings({ bottomPosition: val });
    });

    opacityInput.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      panelEl.querySelector('#dsub-val-opacity').textContent =
        val === 0 ? '0% 透明' : `${val}%`;
      saveSettings({ bgOpacity: val / 100 });
    });

    transparentBtn.addEventListener('click', () => {
      opacityInput.value = 0;
      panelEl.querySelector('#dsub-val-opacity').textContent = '0% 透明';
      saveSettings({ bgOpacity: 0.0 });
    });

    autoApplyInput.addEventListener('change', (e) => {
      saveSettings({ autoSearchApply: e.target.checked });
    });

    formatInput.addEventListener('change', (e) => {
      saveSettings({ preferredFormat: e.target.value });
    });

    panelEl.querySelector('#dsub-save-settings-btn').addEventListener('click', () => {
      const normalized = SP.normalizeSourceProfiles(state.settings.sourceProfiles);
      const nf = normalized.find((p) => p.id === 'netflix');
      saveSettings({
        jimakuApiKey: apiKeyInput.value.trim(),
        autoSearchApply: autoApplyInput.checked,
        preferredFormat: formatInput.value,
        sourceProfiles: normalized,
        preferredSource: normalized.map((p) => p.name).join(','),
        netflixDefaultOffsetSec: nf ? nf.offset : -1.0,
      });
      const btn = panelEl.querySelector('#dsub-save-settings-btn');
      btn.textContent = '✓ 保存しました';
      setTimeout(() => {
        btn.textContent = '設定を保存';
      }, 1500);
    });

    // Offset buttons -> also persist per anime (& per anime x source)
    panelEl.querySelectorAll('[data-offset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const raw = btn.getAttribute('data-offset');
        if (raw === '0') {
          state.offsetSec = 0;
        } else {
          state.offsetSec = Math.round((state.offsetSec + parseFloat(raw)) * 10) / 10;
        }
        saveCurrentWorkOffset();
        renderCurrentSubtitle();
      });
    });

    // Clear button
    panelEl.querySelector('#dsub-clear-btn').addEventListener('click', () => {
      state.cues = [];
      subBoxEl.textContent = '';
      toggleLyrics(false);
      updateBadge('未読込');
    });
  }

  function updateOffsetUI() {
    const el = panelEl?.querySelector('#dsub-offset-val');
    const ruleEl = panelEl?.querySelector('#dsub-offset-rule');
    if (el) {
      const sign = state.offsetSec > 0 ? '+' : '';
      el.textContent = `${sign}${state.offsetSec.toFixed(1)}s`;
    }
    if (ruleEl) {
      ruleEl.textContent = state.offsetRuleLabel ? `[${state.offsetRuleLabel}]` : '';
    }
  }

  function loadSubtitleFileObject(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result || '');
      const cues = window.SubtitleParser.parseSubtitles(content, file.name);
      const sourceCat = detectSourceCategoryFromName(file.name);
      applySavedOffsetForSource(sourceCat);
      setCues(cues, file.name.slice(0, 14));
    };
    reader.readAsText(file);
  }

  function getEntryStorageKey(resolvedMeta) {
    const workKey = getWorkStorageKey();
    if (!workKey) return '';
    const season = resolvedMeta?.season || 1;
    return `${workKey}::s${season}`;
  }

  function saveSelectedEntry(entry, resolvedMeta) {
    const key = getEntryStorageKey(resolvedMeta);
    if (!key || !entry?.id) return;
    const nextEntries = { ...(state.settings.workEntries || {}), [key]: entry.id };
    saveSettings({ workEntries: nextEntries });
  }

  // Jimaku.cc Search & Multi-Entry Auto-load Flow
  async function handleJimakuSearch(options = { autoApplyBest: true }) {
    if (!getAdapter().autoSearchOnLoad) options = { ...options, autoApplyBest: false };
    const statusEl = panelEl.querySelector('#dsub-jimaku-status');
    const listEl = panelEl.querySelector('#dsub-jimaku-results');
    const rawInputTitle = panelEl.querySelector('#dsub-search-title').value.trim();
    const title = rawInputTitle || state.workInfo.cleanTitle || state.workInfo.workTitle;
    const epVal = panelEl.querySelector('#dsub-search-ep').value.trim();
    const episode = epVal ? parseInt(epVal, 10) : state.workInfo.episodeNumber;

    if (!title) {
      statusEl.textContent = '⚠️ 作品のタイトルを入力してください。';
      return;
    }

    const kind = panelEl.querySelector('#dsub-search-kind').value;
    statusEl.textContent = `🔎 「${title}」を ${kind === 'drama' ? 'Jimaku.cc (実写)' : 'AniList + Jimaku.cc'} で検索中...`;
    listEl.style.display = 'none';
    listEl.innerHTML = '';

    const res = await sendBgMessage({
      type: 'JIMAKU_SEARCH',
      kind,
      title,
      episode,
      apiKey: state.settings.jimakuApiKey,
    });

    if (!res.ok) {
      statusEl.textContent = `❌ ${res.error}`;
      return;
    }

    const entries = res.entries || [];
    const resolvedMeta = res.resolvedMeta || {};

    if (entries.length === 0) {
      statusEl.textContent = '⚠️ Jimaku.cc に該当作品の字幕が見つかりませんでした。';
      return;
    }

    // Prioritize user's previously chosen Jimaku entry for this anime & season (if not an ambiguous boundary extra)
    if (kind !== 'drama') {
      const entryKey = getEntryStorageKey(resolvedMeta);
      const savedEntryId = entryKey ? (state.settings.workEntries || {})[entryKey] : null;
      if (savedEntryId && !resolvedMeta.isBoundaryExtra) {
        const idx = entries.findIndex((e) => e.id === savedEntryId);
        if (idx > 0) {
          const [saved] = entries.splice(idx, 1);
          entries.unshift(saved);
        }
      }
    }

    if (options.autoApplyBest) {
      await autoPickBestAcrossEntries(entries, episode, resolvedMeta);
    } else if (entries.length === 1) {
      await loadJimakuEntryFiles(entries[0], episode, false, entries, resolvedMeta);
    } else {
      renderEntryList(entries, episode, resolvedMeta);
    }
  }

  /**
   * Check candidate entries in order. If entry[0] has no exact episode match (e.g. Ep 25 on Season 1
   * when Ep 25 is actually Season 2 Ep 1 in entry[1]), automatically try the next entry!
   */
  async function autoPickBestAcrossEntries(entries, episode, resolvedMeta) {
    const statusEl = panelEl.querySelector('#dsub-jimaku-status');
    const listEl = panelEl.querySelector('#dsub-jimaku-results');
    const maxToTry = Math.min(entries.length, 4);
    let firstNonEmpty = null;

    for (let i = 0; i < maxToTry; i++) {
      const entry = entries[i];
      const jpName = entry.japanese_name || entry.name || '';
      statusEl.textContent = `📂 「${jpName}」の字幕ファイルを確認中...`;

      const res = await sendBgMessage({
        type: 'JIMAKU_FILES',
        entryId: entry.id,
        episode,
        apiKey: state.settings.jimakuApiKey,
        preferredFormat: state.settings.preferredFormat,
        preferredSource: state.settings.preferredSource,
        sourceProfiles: state.settings.sourceProfiles,
        extraMeta: {
          ...resolvedMeta,
          entryAnilistId: entry.anilist_id || null,
          entryName: jpName,
          partTitle: state.workInfo.partTitle || '',
          cleanWorkTitle: state.workInfo.cleanTitle || '',
        },
      });

      if (!res.ok) continue;
      const files = res.files || [];
      if (files.length === 0) continue;

      if (!firstNonEmpty) {
        firstNonEmpty = { entry, files };
      }

      if (files[0]._exactEpisode !== false || episode == null) {
        renderRankedFilesUI(files, entry, episode, resolvedMeta, entries);
        await downloadAndApplyJimakuFile(files[0]);
        return;
      }
    }

    // No exact episode match found across candidates
    if (firstNonEmpty && entries.length === 1) {
      renderRankedFilesUI(firstNonEmpty.files, firstNonEmpty.entry, episode, resolvedMeta, entries);
      await downloadAndApplyJimakuFile(firstNonEmpty.files[0]);
      return;
    }

    if (entries.length > 1) {
      renderEntryList(entries, episode, resolvedMeta);
      statusEl.textContent = `⚠️ 第${episode ?? '?'}話に完全一致するファイルが自動特定できませんでした。フォルダを選択してください：`;
    } else {
      listEl.style.display = 'none';
      statusEl.textContent = '⚠️ 対象話数の字幕ファイルが見つかりませんでした。';
    }
  }
  function renderEntryList(entries, episode, resolvedMeta = {}) {
    const statusEl = panelEl.querySelector('#dsub-jimaku-status');
    const listEl = panelEl.querySelector('#dsub-jimaku-results');
    statusEl.textContent = `✅ ${entries.length}件の作品が見つかりました。選択してください：`;
    listEl.style.display = 'flex';
    listEl.innerHTML = '';
    entries.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'dsub-list-item';
      const jpName = entry.japanese_name || entry.name || entry.english_name || `ID:${entry.id}`;
      const subName = entry.english_name || entry.name || '';
      const display =
        subName && subName !== jpName ? `${jpName} <small style="color:#9ca3af">(${subName})</small>` : jpName;
      item.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;">📁 ${display}</span><span style="color:#9ca3af;font-size:11px;white-space:nowrap;">選択 ▶</span>`;
      item.addEventListener('click', () => {
        saveSelectedEntry(entry, resolvedMeta);
        loadJimakuEntryFiles(entry, episode, getAdapter().autoSearchOnLoad, entries, resolvedMeta);
      });
      listEl.appendChild(item);
    });
  }

  function renderRankedFilesUI(files, entry, episode, resolvedMeta, allEntries = []) {
    const listEl = panelEl.querySelector('#dsub-jimaku-results');
    listEl.innerHTML = '';
    listEl.style.display = 'flex';

    if (allEntries.length > 1) {
      const switchBar = document.createElement('div');
      switchBar.className = 'dsub-list-item';
      switchBar.style.color = '#9ca3af';
      switchBar.style.fontSize = '11px';
      switchBar.innerHTML = `<span>📁 ${entry.japanese_name || entry.name}</span><span style="color:#ff7849;">別候補(${allEntries.length})へ ↩</span>`;
      switchBar.addEventListener('click', () => renderEntryList(allEntries, episode, resolvedMeta));
      listEl.appendChild(switchBar);
    }

    files.forEach((file, idx) => {
      const item = document.createElement('div');
      item.className = 'dsub-list-item';
      if (idx === 0) {
        item.style.background = 'rgba(235, 85, 40, 0.22)';
        item.style.borderLeft = '3px solid #ff7849';
      }
      const badgeTag = file._partTitleMatched ? '🎯 ' : idx === 0 ? '★ ' : '';
      item.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;" title="${file.name}">${badgeTag}${file.name}</span><span style="color:#ff7849;font-size:11px;white-space:nowrap;">読込</span>`;
      item.addEventListener('click', () => {
        listEl.querySelectorAll('.dsub-list-item').forEach((el) => {
          el.style.background = '';
          el.style.borderLeft = '';
        });
        item.style.background = 'rgba(235, 85, 40, 0.22)';
        item.style.borderLeft = '3px solid #ff7849';
        saveSelectedEntry(entry, resolvedMeta);
        downloadAndApplyJimakuFile(file);
      });
      listEl.appendChild(item);
    });
  }

  async function loadJimakuEntryFiles(
    entry,
    episode,
    autoApplyBest = true,
    allEntries = [],
    resolvedMeta = {}
  ) {
    const statusEl = panelEl.querySelector('#dsub-jimaku-status');
    const listEl = panelEl.querySelector('#dsub-jimaku-results');
    const jpName = entry.japanese_name || entry.name || '';

    statusEl.textContent = `📂 「${jpName}」の字幕ファイル一覧を取得中...`;
    listEl.innerHTML = '';
    listEl.style.display = 'none';

    const res = await sendBgMessage({
      type: 'JIMAKU_FILES',
      entryId: entry.id,
      episode,
      apiKey: state.settings.jimakuApiKey,
      preferredFormat: state.settings.preferredFormat,
      preferredSource: state.settings.preferredSource,
      sourceProfiles: state.settings.sourceProfiles,
      extraMeta: {
        ...resolvedMeta,
        entryAnilistId: entry.anilist_id || null,
        entryName: jpName,
        partTitle: state.workInfo.partTitle || '',
        cleanWorkTitle: state.workInfo.cleanTitle || '',
      },
    });

    if (!res.ok) {
      statusEl.textContent = `❌ ${res.error}`;
      return;
    }

    const files = res.files || [];
    if (files.length === 0) {
      statusEl.textContent = '⚠️ 対象話数の字幕ファイルが見つかりませんでした。';
      if (allEntries.length > 1) {
        renderEntryList(allEntries, episode, resolvedMeta);
      }
      return;
    }

    renderRankedFilesUI(files, entry, episode, resolvedMeta, allEntries);

    if (autoApplyBest && files.length > 0) {
      await downloadAndApplyJimakuFile(files[0]);
    } else {
      statusEl.textContent = `📄 字幕ファイルを選択してください (${files.length}件):`;
    }
  }

  async function downloadAndApplyJimakuFile(file) {
    const statusEl = panelEl.querySelector('#dsub-jimaku-status');
    statusEl.textContent = `⬇️ 「${file.name}」を自動適用中...`;

    const res = await sendBgMessage({
      type: 'JIMAKU_DOWNLOAD',
      url: file.url,
    });

    if (!res.ok) {
      statusEl.textContent = `❌ ${res.error}`;
      return;
    }

    const sourceCat = file._sourceCategory || detectSourceCategoryFromName(file.name);
    applySavedOffsetForSource(sourceCat);

    const cues = window.SubtitleParser.parseSubtitles(res.text, file.name);
    setCues(cues, 'Jimaku');
    statusEl.textContent = `✅ 適用完了: ${file.name} (${cues.length}行)`;
  }

  // Render active subtitle cue for current video time
  function renderCurrentSubtitle() {
    if (!subBoxEl || !state.enabled) return;
    const adapter = getAdapter();
    if (adapter.alwaysResolveVideo || !currentVideo || !document.body.contains(currentVideo)) {
      currentVideo = adapter.getVideo();
    }
    if (!currentVideo || state.cues.length === 0) {
      subBoxEl.textContent = '';
      return;
    }

    const t = currentVideo.currentTime - state.offsetSec;
    updateLyrics(t);
    const activeTexts = [];
    for (let i = 0; i < state.cues.length; i++) {
      const c = state.cues[i];
      if (t >= c.start && t <= c.end) {
        activeTexts.push(c.text);
      }
    }

    const combined = activeTexts.join('\n');
    if (subBoxEl.textContent !== combined) {
      subBoxEl.textContent = combined;
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        subBoxEl.animate([
          { opacity: 0.3, transform: 'translateY(6px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ], { duration: 180, easing: 'ease-out' });
      }
    }
  }

  // Global keyboard shortcuts (when NOT typing in an input)
  function setupShortcuts() {
    window.addEventListener('keydown', (e) => {
      if (
        e.target &&
        (e.target.tagName === 'INPUT' ||
          e.target.tagName === 'TEXTAREA' ||
          e.target.tagName === 'SELECT' ||
          e.target.isContentEditable)
      ) {
        return;
      }

      if (e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        state.enabled = !state.enabled;
        applyOverlayStyles();
      } else if (e.key === '[') {
        state.offsetSec = Math.round((state.offsetSec - 0.5) * 10) / 10;
        saveCurrentWorkOffset();
        renderCurrentSubtitle();
      } else if (e.key === ']') {
        state.offsetSec = Math.round((state.offsetSec + 0.5) * 10) / 10;
        saveCurrentWorkOffset();
        renderCurrentSubtitle();
      }
    });
  }

  // Keep overlay visible even when video container enters Fullscreen, and recalculate responsive font size on resize
  function setupFullscreenHandler() {
    window.addEventListener('resize', () => {
      applyOverlayStyles();
    });

    document.addEventListener('fullscreenchange', () => {
      const fsEl = document.fullscreenElement || document.body;
      if (overlayEl && overlayEl.parentElement !== fsEl) {
        fsEl.appendChild(overlayEl);
      }
      if (fabEl && fabEl.parentElement !== fsEl) {
        fsEl.appendChild(fabEl);
      }
      if (panelEl && panelEl.parentElement !== fsEl) {
        fsEl.appendChild(panelEl);
      }
      applyOverlayStyles();
      setTimeout(applyOverlayStyles, 150);
    });
  }

  // Listen for messages from extension popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'TOGGLE_PANEL') {
      ensureUI();
      panelEl.classList.toggle('open');
      fabEl.classList.toggle('active', panelEl.classList.contains('open'));
      detectWorkInfo();
      sendResponse({ ok: true });
    }
  });

  if (chrome?.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      let dirty = false;
      const syncKeys = [
        'jimakuApiKey',
        'fontScale',
        'bottomPosition',
        'bgOpacity',
        'autoSearchApply',
        'preferredFormat',
        'preferredSource',
        'netflixDefaultOffsetSec',
      ];
      for (const k of syncKeys) {
        if (Object.prototype.hasOwnProperty.call(changes, k)) {
          state.settings[k] = changes[k].newValue;
          dirty = true;
        }
      }
      if (Object.prototype.hasOwnProperty.call(changes, 'sourceProfiles')) {
        state.settings.sourceProfiles = SP.normalizeSourceProfiles(changes.sourceProfiles.newValue);
        dirty = true;
      }
      if (dirty) {
        syncSettingsToUI();
        applyOverlayStyles();
      }
    });
  }

  function resetPrimeEpisode() {
    mediaGeneration++;
    setCues([], '未読込');
    state.offsetSec = 0;
    state.offsetRuleLabel = '';
    state.currentSourceCategory = '';
    updateOffsetUI();
    state.workInfo = { partId: '', workTitle: '', cleanTitle: '', partDispNumber: '', partTitle: '', episodeNumber: null };
    for (const id of ['#dsub-search-title', '#dsub-search-ep']) {
      const input = panelEl.querySelector(id);
      input.value = '';
      delete input.dataset.userEdited;
    }
    panelEl.querySelector('#dsub-jimaku-results').replaceChildren();
  }

  // Main initialization loop
  async function init() {
    ensureUI();
    setupKeyboardIsolation();
    await loadSettings();
    setupShortcuts();
    setupFullscreenHandler();
    await detectWorkInfo();

    setInterval(() => {
      const v = getAdapter().getVideo();
      if (v && v !== currentVideo) {
        currentVideo = v;
        v.addEventListener('timeupdate', renderCurrentSubtitle);
        v.addEventListener('seeked', renderCurrentSubtitle);
        detectWorkInfo();
      }
      renderCurrentSubtitle();
    }, 100);

    // Watch for episode / URL changes
    let lastHref = window.location.href;
    setInterval(() => {
      const adapter = getAdapter();
      if (window.location.href !== lastHref) {
        lastHref = window.location.href;
        if (adapter.resetOnNavigation) resetPrimeEpisode();
        const titleInput = panelEl?.querySelector('#dsub-search-title');
        const epInput = panelEl?.querySelector('#dsub-search-ep');
        if (titleInput) delete titleInput.dataset.userEdited;
        if (epInput) delete epInput.dataset.userEdited;
        detectWorkInfo();
      } else if (adapter.pollMetadata) {
        detectWorkInfo();
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
