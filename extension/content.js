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

  const I18N = window.DSubI18n;
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
    offsetRuleMeta: null, // { type: 'work_source'|'work'|'source_default', name?: string }
    currentSourceCategory: '',
    sourceLabel: I18N.t('unloadedBadge'),
    badgeMeta: { type: 'unloaded', label: '', count: 0 },
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
      language: I18N.detectDefaultLanguage(),
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

  function t(key, vars) {
    return I18N.t(key, vars, state.settings.language);
  }

  function formatBgError(res) {
    if (!res) return t('errNoResponse');
    switch (res.errorCode) {
      case 'API_KEY_MISSING':
        return t('bgErrApiKeyMissing');
      case 'UNAUTHORIZED':
        return t('bgErrUnauthorized');
      case 'SEARCH_HTTP_ERROR':
        return t('bgErrSearchHttp', { status: res.errorStatus || '?' });
      case 'FILES_HTTP_ERROR':
        return t('bgErrFilesHttp', { status: res.errorStatus || '?' });
      case 'DOWNLOAD_HTTP_ERROR':
        return t('bgErrDownloadHttp', { status: res.errorStatus || '?' });
      default:
        return res.error || t('errNoResponse');
    }
  }

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
          language: '',
          sourceProfiles: null,
          netflixOffsetMigratedV1: false,
          styleDefaultsMigratedV2: false,
        },
        (items) => {
          const updates = {};
          items.language = items.language
            ? I18N.normalizeLanguage(items.language)
            : I18N.detectDefaultLanguage();
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
          applyLocalizationToUI();
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
          resolve({ ok: false, error: t('errVideoSwitched') });
        } else if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false, error: t('errNoResponse') });
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

  function computeOffsetRuleLabel() {
    const meta = state.offsetRuleMeta;
    if (!meta) return '';
    if (meta.type === 'work_source') {
      return t('ruleWorkSourceMemory', { source: String(meta.source || '').toUpperCase() });
    }
    if (meta.type === 'work') {
      return t('ruleWorkMemory');
    }
    if (meta.type === 'source_default') {
      return t('ruleSourceDefault', { source: meta.name || '' });
    }
    return '';
  }

  /**
   * Resolve initial offset for the currently loaded subtitle file:
   * 1. Saved per-title x source offset (workOffsets["Title::netflix"])
   * 2. Saved per-title offset (workOffsets["Title"])
   * 3. Configured source default offset from `sourceProfiles` (except `Other`)
   * 4. 0.0s
   */
  function applySavedOffsetForSource(sourceCategory) {
    state.currentSourceCategory = sourceCategory || '';
    const workKey = getWorkStorageKey();
    const offsets = state.settings.workOffsets || {};

    let nextOffset = 0.0;
    let ruleMeta = null;

    if (workKey && sourceCategory && Object.prototype.hasOwnProperty.call(offsets, `${workKey}::${sourceCategory}`)) {
      nextOffset = Number(offsets[`${workKey}::${sourceCategory}`]) || 0.0;
      ruleMeta = { type: 'work_source', source: sourceCategory };
    } else if (workKey && Object.prototype.hasOwnProperty.call(offsets, workKey)) {
      nextOffset = Number(offsets[workKey]) || 0.0;
      ruleMeta = { type: 'work' };
    } else if (sourceCategory && sourceCategory !== 'other') {
      const profiles = SP.normalizeSourceProfiles(state.settings.sourceProfiles);
      const matchedProfile = profiles.find((p) => p.id === sourceCategory);
      if (matchedProfile && !matchedProfile.locked && Number(matchedProfile.offset) !== 0) {
        nextOffset = Number(matchedProfile.offset) || 0.0;
        ruleMeta = { type: 'source_default', name: matchedProfile.name };
      }
    }

    state.offsetSec = Math.round(nextOffset * 10) / 10;
    state.offsetRuleMeta = ruleMeta;
    state.offsetRuleLabel = computeOffsetRuleLabel();
    updateOffsetUI();
  }

  /**
   * Persist manual offset changes per title (and per title x source).
   */
  function saveCurrentWorkOffset() {
    const workKey = getWorkStorageKey();
    if (!workKey) return;
    const nextMap = { ...(state.settings.workOffsets || {}) };
    nextMap[workKey] = state.offsetSec;
    if (state.currentSourceCategory) {
      nextMap[`${workKey}::${state.currentSourceCategory}`] = state.offsetSec;
      state.offsetRuleMeta = { type: 'work_source', source: state.currentSourceCategory };
    } else {
      state.offsetRuleMeta = { type: 'work' };
    }
    state.offsetRuleLabel = computeOffsetRuleLabel();
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
    subBoxEl.title = t('overlayTooltip');
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
    fabEl.title = t('fabTitle');
    fabEl.innerHTML = `<span class="dsub-fab-label">${t('fabLabel')}</span><span class="danime-sub-badge" id="danime-sub-fab-badge">${t('unloadedBadge')}</span>`;
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
    // Keep focus inside the panel when clicking panel controls
    panelEl.tabIndex = -1;
    panelEl.innerHTML = `
      <div class="dsub-header">
        <div class="dsub-title">🎬 <span data-i18n="appTitle"></span></div>
        <button class="dsub-close" id="dsub-close-btn" data-i18n-title="closeBtnTitle">×</button>
      </div>

      <div class="dsub-tabs">
        <button class="dsub-tab active" data-tab="jimaku" data-i18n="tabSearch"></button>
        <button class="dsub-tab" data-tab="local" data-i18n="tabLocal"></button>
        <button class="dsub-tab" data-tab="settings" data-i18n="tabSettings"></button>
      </div>

      <div class="dsub-body">
        <!-- Tab 1: Jimaku.cc Search -->
        <div class="dsub-section active" id="dsub-tab-jimaku">
          <label class="dsub-row"><span data-i18n="searchKindLabel"></span>
            <select class="dsub-select" id="dsub-search-kind" style="width:180px">
              <option value="anime" data-i18n="kindAnime" ${adapter.defaultSearchKind === 'anime' ? 'selected' : ''}></option>
              <option value="drama" data-i18n="kindDrama" ${adapter.defaultSearchKind === 'drama' ? 'selected' : ''}></option>
            </select>
          </label>
          <div class="dsub-row">
            <input type="text" class="dsub-input" id="dsub-search-title" data-i18n-placeholder="searchTitlePlaceholder" />
            <input type="number" class="dsub-input dsub-no-spin" id="dsub-search-ep" data-i18n-placeholder="searchEpPlaceholder" style="width: 68px;" min="0" />
          </div>
          <div class="dsub-row">
            <button class="dsub-btn dsub-btn-primary" id="dsub-jimaku-search-btn" style="width: 100%;"></button>
          </div>
          <div class="dsub-status" id="dsub-jimaku-status" data-default-idle="1"></div>
          <div class="dsub-list" id="dsub-jimaku-results" style="display: none;"></div>
        </div>

        <!-- Tab 2: Local File -->
        <div class="dsub-section" id="dsub-tab-local">
          <div class="dsub-dropzone" id="dsub-dropzone">
            <span data-i18n-html="dropzoneHtml"></span>
            <input type="file" id="dsub-file-input" accept=".srt,.ass,.ssa,.vtt" style="display: none;" />
          </div>
          <div class="dsub-row" style="justify-content: space-between;">
            <span class="dsub-hint" data-i18n="dropzoneHint"></span>
            <button class="dsub-btn" id="dsub-export-srt-btn" data-i18n="exportSrtBtn" data-i18n-title="exportSrtTitle"></button>
          </div>
        </div>

        <!-- Tab 3: Settings -->
        <div class="dsub-section" id="dsub-tab-settings">
          <div class="dsub-row">
            <span class="dsub-label" data-i18n="languageLabel"></span>
            <select class="dsub-select" id="dsub-set-lang" style="width: 165px;">
              <option value="en">English</option>
              <option value="ja">日本語</option>
              <option value="zh_CN">简体中文</option>
            </select>
          </div>
          <div class="dsub-row">
            <label class="dsub-label" style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input type="checkbox" id="dsub-set-autoapply" checked />
              <span data-i18n="autoSearchLabel"></span>
            </label>
          </div>
          <div id="dsub-source-accordion-mount"></div>
          <div class="dsub-row">
            <span class="dsub-label" data-i18n="preferredFormatLabel"></span>
            <select class="dsub-select" id="dsub-set-format" style="width: 185px;">
              <option value="ass,srt,vtt" data-i18n="formatAssFirst"></option>
              <option value="srt,ass,vtt" data-i18n="formatSrtFirst"></option>
            </select>
          </div>
          <div>
            <div class="dsub-label" id="dsub-set-apikey-label" style="margin-bottom: 4px;"></div>
            <input type="text" autocomplete="off" spellcheck="false" style="-webkit-text-security: disc;" class="dsub-input" id="dsub-set-apikey" data-i18n-placeholder="apiKeyPlaceholder" />
          </div>
          <div class="dsub-row">
            <span class="dsub-label"><span data-i18n="fontSizeLabel"></span> (<span id="dsub-val-fontsize">4.5</span>%)</span>
            <input type="range" id="dsub-set-fontsize" min="1.5" max="6.5" step="0.1" value="4.5" style="width: 150px;" />
          </div>
          <div class="dsub-row">
            <span class="dsub-label"><span data-i18n="bottomPosLabel"></span> (<span id="dsub-val-bottom">5</span>%)</span>
            <input type="range" id="dsub-set-bottom" min="2" max="85" value="5" style="width: 150px;" />
          </div>
          <div class="dsub-row">
            <span class="dsub-label"><span data-i18n="bgOpacityLabel"></span> (<span id="dsub-val-opacity"></span>)</span>
            <div style="display:flex;align-items:center;gap:6px;">
              <input type="range" id="dsub-set-opacity" min="0" max="100" value="0" style="width: 110px;" />
              <button class="dsub-btn" id="dsub-transparent-btn" style="padding:3px 6px;font-size:11px;" data-i18n="transparentBtn" data-i18n-title="transparentBtnTitle"></button>
            </div>
          </div>
          <button class="dsub-btn dsub-btn-primary" id="dsub-save-settings-btn" data-i18n="saveSettingsBtn"></button>
        </div>
      </div>

      <!-- Footer: Always-accessible sync offset & visibility toggle -->
      <div class="dsub-footer">
        <div class="dsub-row">
          <span class="dsub-label"><span data-i18n="offsetLabel"></span>: <b id="dsub-offset-val">0.0s</b> <small id="dsub-offset-rule" style="color:#ff7849;font-size:10px;"></small></span>
          <div class="dsub-offset-controls">
            <button class="dsub-btn" data-offset="-5" data-i18n-title="offsetSkipTitle">-5s</button>
            <button class="dsub-btn" data-offset="-0.5">-0.5s</button>
            <button class="dsub-btn" data-offset="-0.1">-0.1s</button>
            <button class="dsub-btn" data-offset="0">0</button>
            <button class="dsub-btn" data-offset="+0.1">+0.1s</button>
            <button class="dsub-btn" data-offset="+0.5">+0.5s</button>
            <button class="dsub-btn" data-offset="+5">+5s</button>
          </div>
        </div>
        <div class="dsub-row" style="justify-content: space-between;">
          <span class="dsub-hint" data-i18n-html="shortcutHint"></span>
          <button class="dsub-btn" id="dsub-clear-btn" style="padding: 3px 8px; font-size: 11px;" data-i18n="clearBtn"></button>
        </div>
      </div>
    `;
    document.body.appendChild(panelEl);

    bindPanelEvents();
    syncSettingsToUI();
    applyLocalizationToUI();
    applyOverlayStyles();
  }

  function applyLocalizationToUI() {
    const adapter = getAdapter();
    if (subBoxEl) {
      subBoxEl.title = t('overlayTooltip');
    }
    if (fabEl) {
      fabEl.title = t('fabTitle');
      const labelSpan = fabEl.querySelector('.dsub-fab-label');
      if (labelSpan) labelSpan.textContent = t('fabLabel');
      updateBadgeText();
    }
    if (panelEl) {
      panelEl.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = t(el.dataset.i18n);
      });
      panelEl.querySelectorAll('[data-i18n-html]').forEach((el) => {
        el.innerHTML = t(el.dataset.i18nHtml);
      });
      panelEl.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        el.placeholder = t(el.dataset.i18nPlaceholder);
      });
      panelEl.querySelectorAll('[data-i18n-title]').forEach((el) => {
        el.title = t(el.dataset.i18nTitle);
      });

      const searchBtn = panelEl.querySelector('#dsub-jimaku-search-btn');
      if (searchBtn) {
        searchBtn.textContent = adapter.autoSearchOnLoad ? t('searchBtnAuto') : t('searchBtnManual');
      }
      const statusEl = panelEl.querySelector('#dsub-jimaku-status');
      if (statusEl && statusEl.dataset.defaultIdle === '1') {
        statusEl.textContent = adapter.autoSearchOnLoad
          ? t('searchHintAuto')
          : t('searchHintManual', { platform: adapter.name });
      }
      const apiKeyLabel = panelEl.querySelector('#dsub-set-apikey-label');
      if (apiKeyLabel) {
        apiKeyLabel.innerHTML = `${t('apiKeyLabelPrefix')} (<a href="https://jimaku.cc/account" target="_blank" rel="noopener" style="color:#ff7849;">${t('apiKeyGetFree')}</a>)`;
      }
      const langSelect = panelEl.querySelector('#dsub-set-lang');
      if (langSelect) {
        langSelect.value = I18N.normalizeLanguage(state.settings.language);
      }
      const opLabel = panelEl.querySelector('#dsub-val-opacity');
      if (opLabel) {
        const opPct = Math.round((state.settings.bgOpacity ?? 0) * 100);
        opLabel.textContent = opPct === 0 ? t('opacityTransparent') : `${opPct}%`;
      }
      if (sourceEditor) sourceEditor.refreshLabels();
      state.offsetRuleLabel = computeOffsetRuleLabel();
      updateOffsetUI();
    }
    if (lyricsEl) {
      lyricsEl.setAttribute('aria-label', t('lyricsAriaLabel'));
      const sel = lyricsEl.querySelector('select');
      if (sel) {
        sel.setAttribute('aria-label', t('lyricsModeAria'));
        const optSync = sel.querySelector('option[value="sync"]');
        const optSeek = sel.querySelector('option[value="seek"]');
        if (optSync) optSync.textContent = t('lyricsModeSync');
        if (optSeek) optSeek.textContent = t('lyricsModeSeek');
        const helpEl = lyricsEl.querySelector('.dsub-lyrics-help');
        if (helpEl) {
          helpEl.textContent = sel.value === 'sync' ? t('lyricsHelpSync') : t('lyricsHelpSeek');
        }
      }
      const resetBtn = lyricsEl.querySelector('[data-reset]');
      if (resetBtn) resetBtn.textContent = t('lyricsResetBtn');
      const closeBtn = lyricsEl.querySelector('[data-close]');
      if (closeBtn) closeBtn.setAttribute('aria-label', t('lyricsCloseAria'));
      if (lyricsListEl) lyricsListEl.setAttribute('aria-label', t('lyricsListAria'));
    }
  }

  function createLyricsPad() {
    lyricsEl = document.createElement('section');
    lyricsEl.id = 'danime-sub-lyrics';
    lyricsEl.hidden = true;
    lyricsEl.setAttribute('aria-label', t('lyricsAriaLabel'));
    lyricsEl.innerHTML = `
      <div class="dsub-lyrics-toolbar">
        <select aria-label="${t('lyricsModeAria')}">
          <option value="sync">${t('lyricsModeSync')}</option>
          <option value="seek">${t('lyricsModeSeek')}</option>
        </select>
        <button type="button" data-reset>${t('lyricsResetBtn')}</button>
        <button type="button" data-close aria-label="${t('lyricsCloseAria')}">×</button>
      </div>
      <div class="dsub-lyrics-help">${t('lyricsHelpSync')}</div>
      <div class="dsub-lyrics-list" tabindex="0" aria-label="${t('lyricsListAria')}"></div>`;
    overlayEl.appendChild(lyricsEl);
    lyricsListEl = lyricsEl.querySelector('.dsub-lyrics-list');
    lyricsEl.querySelector('[data-close]').onclick = () => toggleLyrics(false);
    lyricsEl.querySelector('[data-reset]').onclick = () => {
      state.offsetSec = 0;
      state.offsetRuleMeta = null;
      state.offsetRuleLabel = '';
      updateOffsetUI();
      renderCurrentSubtitle();
    };
    lyricsEl.querySelector('select').onchange = (e) => {
      lyricsEl.querySelector('.dsub-lyrics-help').textContent = e.target.value === 'sync'
        ? t('lyricsHelpSync')
        : t('lyricsHelpSeek');
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
    const langInput = panelEl.querySelector('#dsub-set-lang');
    if (langInput) langInput.value = I18N.normalizeLanguage(state.settings.language);
    if (sourceEditor) sourceEditor.render();

    const fsLabel = panelEl.querySelector('#dsub-val-fontsize');
    const btLabel = panelEl.querySelector('#dsub-val-bottom');
    const opLabel = panelEl.querySelector('#dsub-val-opacity');
    if (fsLabel) fsLabel.textContent = scale.toFixed(1);
    if (btLabel) btLabel.textContent = state.settings.bottomPosition;
    if (opLabel) opLabel.textContent = opPct === 0 ? t('opacityTransparent') : `${opPct}%`;
  }

  function updateBadge(text) {
    state.sourceLabel = text;
    const badge = document.getElementById('danime-sub-fab-badge');
    if (badge) badge.textContent = text;
  }

  function updateBadgeText() {
    if (state.badgeMeta && state.badgeMeta.type === 'loaded' && state.badgeMeta.label) {
      updateBadge(
        t('loadedBadgeCount', {
          label: state.badgeMeta.label,
          count: state.badgeMeta.count,
        })
      );
    } else {
      updateBadge(t('unloadedBadge'));
    }
  }

  function setCues(cues, label) {
    state.cues = cues || [];
    if (!state.cues.length && lyricsEl && !lyricsEl.hidden) toggleLyrics(false);
    if (label && state.cues.length > 0) {
      state.badgeMeta = { type: 'loaded', label, count: state.cues.length };
    } else if (label && label !== '未読込' && label !== t('unloadedBadge')) {
      state.badgeMeta = { type: 'loaded', label, count: state.cues.length };
    } else {
      state.badgeMeta = { type: 'unloaded', label: '', count: 0 };
    }
    updateBadgeText();
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
        alert(t('alertNoCuesToExport'));
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
    const langInput = panelEl.querySelector('#dsub-set-lang');
    const apiKeyInput = panelEl.querySelector('#dsub-set-apikey');
    const fontSizeInput = panelEl.querySelector('#dsub-set-fontsize');
    const bottomInput = panelEl.querySelector('#dsub-set-bottom');
    const opacityInput = panelEl.querySelector('#dsub-set-opacity');
    const transparentBtn = panelEl.querySelector('#dsub-transparent-btn');
    const autoApplyInput = panelEl.querySelector('#dsub-set-autoapply');
    const formatInput = panelEl.querySelector('#dsub-set-format');
    const sourceMountEl = panelEl.querySelector('#dsub-source-accordion-mount');

    if (langInput) {
      langInput.addEventListener('change', (e) => {
        const nextLang = I18N.normalizeLanguage(e.target.value);
        saveSettings({ language: nextLang });
        applyLocalizationToUI();
      });
    }

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
      getLabels: () => I18N.getSourceDictionaryLabels(state.settings.language),
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
        val === 0 ? t('opacityTransparent') : `${val}%`;
      saveSettings({ bgOpacity: val / 100 });
    });

    transparentBtn.addEventListener('click', () => {
      opacityInput.value = 0;
      panelEl.querySelector('#dsub-val-opacity').textContent = t('opacityTransparent');
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
        language: I18N.normalizeLanguage(langInput ? langInput.value : state.settings.language),
        jimakuApiKey: apiKeyInput.value.trim(),
        autoSearchApply: autoApplyInput.checked,
        preferredFormat: formatInput.value,
        sourceProfiles: normalized,
        preferredSource: normalized.map((p) => p.name).join(','),
        netflixDefaultOffsetSec: nf ? nf.offset : -1.0,
      });
      const btn = panelEl.querySelector('#dsub-save-settings-btn');
      btn.textContent = t('savedSettingsBtn');
      setTimeout(() => {
        btn.textContent = t('saveSettingsBtn');
      }, 1500);
    });

    // Offset buttons -> persist per title (& per title x source)
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
      state.badgeMeta = { type: 'unloaded', label: '', count: 0 };
      subBoxEl.textContent = '';
      toggleLyrics(false);
      updateBadgeText();
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

  function setSearchStatus(text, isIdle = false) {
    const statusEl = panelEl?.querySelector('#dsub-jimaku-status');
    if (!statusEl) return;
    statusEl.dataset.defaultIdle = isIdle ? '1' : '0';
    statusEl.textContent = text;
  }

  // Jimaku.cc Search & Multi-Entry Auto-load Flow
  async function handleJimakuSearch(options = { autoApplyBest: true }) {
    if (!getAdapter().autoSearchOnLoad) options = { ...options, autoApplyBest: false };
    const listEl = panelEl.querySelector('#dsub-jimaku-results');
    const rawInputTitle = panelEl.querySelector('#dsub-search-title').value.trim();
    const title = rawInputTitle || state.workInfo.cleanTitle || state.workInfo.workTitle;
    const epVal = panelEl.querySelector('#dsub-search-ep').value.trim();
    const episode = epVal ? parseInt(epVal, 10) : state.workInfo.episodeNumber;

    if (!title) {
      setSearchStatus(t('errEnterTitle'));
      return;
    }

    const kind = panelEl.querySelector('#dsub-search-kind').value;
    const engine = kind === 'drama' ? t('engineDrama') : t('engineAnime');
    setSearchStatus(t('statusSearching', { title, engine }));
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
      setSearchStatus(`❌ ${formatBgError(res)}`);
      return;
    }

    const entries = res.entries || [];
    const resolvedMeta = res.resolvedMeta || {};

    if (entries.length === 0) {
      setSearchStatus(t('errNoEntriesFound'));
      return;
    }

    // Prioritize user's previously chosen Jimaku entry for this title & season (if not an ambiguous boundary extra)
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
   * when Ep 25 is actually Season 2 Ep 1 in entry[1]), automatically try the next entry.
   */
  async function autoPickBestAcrossEntries(entries, episode, resolvedMeta) {
    const listEl = panelEl.querySelector('#dsub-jimaku-results');
    const maxToTry = Math.min(entries.length, 4);
    let firstNonEmpty = null;

    for (let i = 0; i < maxToTry; i++) {
      const entry = entries[i];
      const jpName = entry.japanese_name || entry.name || '';
      setSearchStatus(t('statusCheckingEntry', { name: jpName }));

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
      setSearchStatus(t('errNoExactEpPickEntry', { ep: episode ?? '?' }));
    } else {
      listEl.style.display = 'none';
      setSearchStatus(t('errNoEpFilesFound'));
    }
  }
  function renderEntryList(entries, episode, resolvedMeta = {}) {
    const listEl = panelEl.querySelector('#dsub-jimaku-results');
    setSearchStatus(t('statusEntriesFound', { count: entries.length }));
    listEl.style.display = 'flex';
    listEl.innerHTML = '';
    entries.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'dsub-list-item';
      const jpName = entry.japanese_name || entry.name || entry.english_name || `ID:${entry.id}`;
      const subName = entry.english_name || entry.name || '';
      const display =
        subName && subName !== jpName ? `${jpName} <small style="color:#9ca3af">(${subName})</small>` : jpName;
      item.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;">📁 ${display}</span><span style="color:#9ca3af;font-size:11px;white-space:nowrap;">${t('entrySelectBtn')}</span>`;
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
      switchBar.innerHTML = `<span>📁 ${entry.japanese_name || entry.name}</span><span style="color:#ff7849;">${t('switchCandidateBtn', { count: allEntries.length })}</span>`;
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
      item.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;" title="${file.name}">${badgeTag}${file.name}</span><span style="color:#ff7849;font-size:11px;white-space:nowrap;">${t('fileLoadBtn')}</span>`;
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
    const listEl = panelEl.querySelector('#dsub-jimaku-results');
    const jpName = entry.japanese_name || entry.name || '';

    setSearchStatus(t('statusFetchingFiles', { name: jpName }));
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
      setSearchStatus(`❌ ${formatBgError(res)}`);
      return;
    }

    const files = res.files || [];
    if (files.length === 0) {
      setSearchStatus(t('errNoEpFilesFound'));
      if (allEntries.length > 1) {
        renderEntryList(allEntries, episode, resolvedMeta);
      }
      return;
    }

    renderRankedFilesUI(files, entry, episode, resolvedMeta, allEntries);

    if (autoApplyBest && files.length > 0) {
      await downloadAndApplyJimakuFile(files[0]);
    } else {
      setSearchStatus(t('statusChooseFile', { count: files.length }));
    }
  }

  async function downloadAndApplyJimakuFile(file) {
    setSearchStatus(t('statusDownloading', { name: file.name }));

    const res = await sendBgMessage({
      type: 'JIMAKU_DOWNLOAD',
      url: file.url,
    });

    if (!res.ok) {
      setSearchStatus(`❌ ${formatBgError(res)}`);
      return;
    }

    const sourceCat = file._sourceCategory || detectSourceCategoryFromName(file.name);
    applySavedOffsetForSource(sourceCat);

    const cues = window.SubtitleParser.parseSubtitles(res.text, file.name);
    setCues(cues, 'Jimaku');
    setSearchStatus(t('statusApplied', { name: file.name, count: cues.length }));
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
      if (Object.prototype.hasOwnProperty.call(changes, 'language')) {
        state.settings.language = changes.language.newValue
          ? I18N.normalizeLanguage(changes.language.newValue)
          : I18N.detectDefaultLanguage();
        dirty = true;
      }
      if (Object.prototype.hasOwnProperty.call(changes, 'sourceProfiles')) {
        state.settings.sourceProfiles = SP.normalizeSourceProfiles(changes.sourceProfiles.newValue);
        dirty = true;
      }
      if (dirty) {
        syncSettingsToUI();
        applyLocalizationToUI();
        applyOverlayStyles();
      }
    });
  }

  function resetPrimeEpisode() {
    mediaGeneration++;
    setCues([], null);
    state.offsetSec = 0;
    state.offsetRuleMeta = null;
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
    const adapter = getAdapter();
    setSearchStatus(
      adapter.autoSearchOnLoad
        ? t('searchHintAuto')
        : t('searchHintManual', { platform: adapter.name }),
      true
    );
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
