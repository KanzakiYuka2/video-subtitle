/**
 * Content Script for dアニメ字幕アシスタント
 * - Stops keyboard event propagation when panel inputs are focused or panel is hovered/active
 *   so d-anime player shortcuts (Space, Arrow keys, F, M, Enter, etc.) never hijack typing!
 * - Detects d-anime work title (auto-cleans 【規制解除版】 etc.) & episode number via WS010105 API & DOM
 * - Automatically searches & applies best matching subtitle on page entry / episode change
 * - Supports format priority (ASS vs SRT) & release source priority (Netflix, ABEMA, WebRip, BD...)
 * - Supports 100% transparent subtitle background with crisp outline
 */

(function () {
  if (window.__DANIME_SUB_ASSISTANT_LOADED__) return;
  window.__DANIME_SUB_ASSISTANT_LOADED__ = true;

  // State
  const state = {
    enabled: true,
    cues: [], // Array<{ start: number, end: number, text: string }>
    offsetSec: 0.0,
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
      aiServerUrl: 'http://127.0.0.1:8765',
      fontScale: 3.2, // Relative to video/viewport height (%)
      bottomPosition: 10,
      bgOpacity: 0.0, // Default to transparent background as requested
      textColor: '#ffffff',
      autoSearchApply: true,
      preferredFormat: 'ass,srt,vtt',
      preferredSource: 'ABEMA,DMMTV,U-NEXT,Amazon,Netflix,NanokoRaws,shincaps,WebRip,BD',
    },
    ai: {
      active: false,
      mode: 'whisper',
      chunkSec: 3.5,
      timerId: null,
      busy: false,
      recognition: null,
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
   * Strip d-anime store tags like 【規制解除版】, （吹替版）, etc.
   */
  function cleanWorkTitle(rawTitle) {
    if (!rawTitle) return '';
    return rawTitle
      .replace(/【.*?】|\[.*?\]|（.*?版.*?）|\(.*?版.*?\)|＜.*?版.*?＞/g, ' ')
      .replace(/（吹替）|（字幕）|（テレビ放送版）|（オンエア版）|（完全版）/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const LEGACY_DEFAULT_SOURCES = new Set([
    'Netflix,ABEMA,WebRip,BD',
    'Netflix,ABEMA,DMMTV,Prime,U-NEXT,WebRip,BD',
  ]);
  const NEW_DEFAULT_SOURCE =
    'ABEMA,DMMTV,U-NEXT,Amazon,Netflix,NanokoRaws,shincaps,WebRip,BD';

  // Load saved settings
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(state.settings, (items) => {
        // Migrate legacy default source list to the new Platinum/Gold/Silver/Bronze order
        if (!items.preferredSource || LEGACY_DEFAULT_SOURCES.has(items.preferredSource)) {
          items.preferredSource = NEW_DEFAULT_SOURCE;
          chrome.storage.local.set({ preferredSource: NEW_DEFAULT_SOURCE });
        }
        Object.assign(state.settings, items);
        syncSettingsToUI();
        applyOverlayStyles();
        resolve(state.settings);
      });
    });
  }

  function saveSettings(partial) {
    Object.assign(state.settings, partial);
    chrome.storage.local.set(state.settings);
    applyOverlayStyles();
  }

  function sendBgMessage(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
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

  // Fetch d-anime metadata from official internal REST endpoint or DOM
  async function detectWorkInfo() {
    const params = new URLSearchParams(window.location.search);
    const partId = params.get('partId') || '';

    if (partId) {
      try {
        const apiParams = new URLSearchParams({
          defaultPlay: '5',
          partId,
          viewType: '5',
        });
        const res = await fetch(
          `https://animestore.docomo.ne.jp/animestore/rest/WS010105?${apiParams}`,
          { cache: 'no-cache' }
        );
        if (res.ok) {
          const json = await res.json();
          const data = json?.data;
          if (data && data.workTitle) {
            state.workInfo = {
              partId,
              workTitle: data.workTitle || '',
              cleanTitle: cleanWorkTitle(data.workTitle || ''),
              partDispNumber: data.partDispNumber || '',
              partTitle: data.partTitle || '',
              episodeNumber: parseEpisodeNumber(data.partDispNumber),
            };
            updateMetadataUI();
            await maybeAutoSearchAndApply();
            return state.workInfo;
          }
        }
      } catch (_) {
        // Fallback to DOM
      }
    }

    // Fallback to DOM selectors (.backInfoTxt1, .backInfoTxt2, .backInfoTxt3)
    const t1 = document.querySelector('.backInfoTxt1')?.textContent?.trim() || '';
    const t2 = document.querySelector('.backInfoTxt2')?.textContent?.trim() || '';
    const t3 = document.querySelector('.backInfoTxt3')?.textContent?.trim() || '';
    if (t1) {
      state.workInfo = {
        partId: partId || t1 + '_' + t2,
        workTitle: t1,
        cleanTitle: cleanWorkTitle(t1),
        partDispNumber: t2,
        partTitle: t3,
        episodeNumber: parseEpisodeNumber(t2),
      };
      updateMetadataUI();
      await maybeAutoSearchAndApply();
    }
    return state.workInfo;
  }

  async function maybeAutoSearchAndApply() {
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
    fabEl = document.createElement('button');
    fabEl.id = 'danime-sub-fab';
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
    // Make panel focusable so clicking anywhere inside keeps focus inside the panel
    panelEl.tabIndex = -1;
    panelEl.innerHTML = `
      <div class="dsub-header">
        <div class="dsub-title">🎬 dアニメ字幕アシスタント</div>
        <button class="dsub-close" id="dsub-close-btn" title="閉じる">×</button>
      </div>

      <div class="dsub-tabs">
        <button class="dsub-tab active" data-tab="jimaku">🔍 自動検索</button>
        <button class="dsub-tab" data-tab="local">📂 ファイル</button>
        <button class="dsub-tab" data-tab="ai">🎙️ AIリアルタイム</button>
        <button class="dsub-tab" data-tab="settings">⚙ 設定</button>
      </div>

      <div class="dsub-body">
        <!-- Tab 1: Jimaku.cc Search -->
        <div class="dsub-section active" id="dsub-tab-jimaku">
          <div class="dsub-row">
            <input type="text" class="dsub-input" id="dsub-search-title" placeholder="アニメタイトル (日本語・英語・略称OK)" />
            <input type="number" class="dsub-input" id="dsub-search-ep" placeholder="話数" style="width: 68px;" min="0" />
          </div>
          <div class="dsub-row">
            <button class="dsub-btn dsub-btn-primary" id="dsub-jimaku-search-btn" style="width: 100%;">
              Jimaku.cc から検索＆最適字幕を適用
            </button>
          </div>
          <div class="dsub-status" id="dsub-jimaku-status">
            再生中の作品タイトルから自動で日本語字幕(.ass/.srt)を検索・適用します。
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

        <!-- Tab 3: AI Real-Time Whisper -->
        <div class="dsub-section" id="dsub-tab-ai">
          <div class="dsub-status" id="dsub-ai-status">
            字幕ファイルが存在しない作品を、再生中の音声からリアルタイムにAI文字起こしします。
          </div>
          <div class="dsub-row">
            <span class="dsub-label">AIエンジン</span>
            <select class="dsub-select" id="dsub-ai-mode" style="width: 210px;">
              <option value="whisper">ローカルGPU Whisper (推奨・高精度)</option>
              <option value="webspeech">ブラウザ音声認識 (サーバー不要)</option>
            </select>
          </div>
          <div class="dsub-row">
            <button class="dsub-btn dsub-btn-primary" id="dsub-ai-toggle-btn" style="width: 100%;">
              🎙️ AIリアルタイム字幕を開始
            </button>
          </div>
          <div class="dsub-hint">
            ※ローカルGPUサーバー起動コマンド:<br/>
            <code>./start_server.sh</code> (RTX GPUで高速動作)
          </div>
        </div>

        <!-- Tab 4: Settings -->
        <div class="dsub-section" id="dsub-tab-settings">
          <div class="dsub-row">
            <label class="dsub-label" style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input type="checkbox" id="dsub-set-autoapply" checked />
              動画を開いた時に自動で字幕を検索・適用する
            </label>
          </div>
          <div class="dsub-row">
            <span class="dsub-label">優先フォーマット</span>
            <select class="dsub-select" id="dsub-set-format" style="width: 185px;">
              <option value="ass,srt,vtt">ASS 優先 (.ass → .srt)</option>
              <option value="srt,ass,vtt">SRT 優先 (.srt → .ass)</option>
            </select>
          </div>
          <div>
            <div class="dsub-label" style="margin-bottom: 4px;">優先ソース順 (Platinum: ABEMA/DMM/U-NEXT/Amazon → Gold: Netflix → Silver: NanokoRaws → Bronze: shincaps)</div>
            <input type="text" class="dsub-input" id="dsub-set-source" placeholder="ABEMA,DMMTV,U-NEXT,Amazon,Netflix,NanokoRaws,shincaps,WebRip,BD" />
          </div>
          <div>
            <div class="dsub-label" style="margin-bottom: 4px;">Jimaku.cc APIキー (<a href="https://jimaku.cc/account" target="_blank" rel="noopener" style="color:#ff7849;">無料取得</a>)</div>
            <input type="password" class="dsub-input" id="dsub-set-apikey" placeholder="Jimaku API Key を貼り付け" />
          </div>
          <div class="dsub-row">
            <span class="dsub-label">文字サイズ比率 (<span id="dsub-val-fontsize">3.2</span>%)</span>
            <input type="range" id="dsub-set-fontsize" min="1.5" max="6.5" step="0.1" value="3.2" style="width: 150px;" />
          </div>
          <div class="dsub-row">
            <span class="dsub-label">下からの位置 (<span id="dsub-val-bottom">10</span>%)</span>
            <input type="range" id="dsub-set-bottom" min="2" max="85" value="10" style="width: 150px;" />
          </div>
          <div class="dsub-row">
            <span class="dsub-label">背景の不透明度 (<span id="dsub-val-opacity">0% 透明</span>)</span>
            <div style="display:flex;align-items:center;gap:6px;">
              <input type="range" id="dsub-set-opacity" min="0" max="100" value="0" style="width: 110px;" />
              <button class="dsub-btn" id="dsub-transparent-btn" style="padding:3px 6px;font-size:11px;" title="背景を完全透明にする">透明</button>
            </div>
          </div>
          <div>
            <div class="dsub-label" style="margin-bottom: 4px;">ローカルAIサーバーURL</div>
            <input type="text" class="dsub-input" id="dsub-set-aiurl" placeholder="http://127.0.0.1:8765" />
          </div>
          <button class="dsub-btn dsub-btn-primary" id="dsub-save-settings-btn">設定を保存</button>
        </div>
      </div>

      <!-- Footer: Always-accessible sync offset & visibility toggle -->
      <div class="dsub-footer">
        <div class="dsub-row">
          <span class="dsub-label">タイミング調整: <b id="dsub-offset-val">0.0s</b></span>
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
      const video = document.querySelector('video');
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
    const scale = Number(state.settings.fontScale) || 3.2;
    const v = currentVideo || document.querySelector('video');
    let baseHeight = window.innerHeight;
    if (v) {
      const rect = v.getBoundingClientRect();
      if (rect && rect.height > 100) {
        baseHeight = rect.height;
      }
    }
    return Math.max(12, Math.round((baseHeight * scale) / 100 * 10) / 10);
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
    const aiUrlInput = panelEl.querySelector('#dsub-set-aiurl');
    const fontSizeInput = panelEl.querySelector('#dsub-set-fontsize');
    const bottomInput = panelEl.querySelector('#dsub-set-bottom');
    const opacityInput = panelEl.querySelector('#dsub-set-opacity');
    const autoApplyInput = panelEl.querySelector('#dsub-set-autoapply');
    const formatInput = panelEl.querySelector('#dsub-set-format');
    const sourceInput = panelEl.querySelector('#dsub-set-source');

    const scale = Number(state.settings.fontScale) || 3.2;
    if (apiKeyInput) apiKeyInput.value = state.settings.jimakuApiKey || '';
    if (aiUrlInput) aiUrlInput.value = state.settings.aiServerUrl || 'http://127.0.0.1:8765';
    if (fontSizeInput) fontSizeInput.value = scale;
    if (bottomInput) bottomInput.value = state.settings.bottomPosition;

    const opPct = Math.round((state.settings.bgOpacity ?? 0) * 100);
    if (opacityInput) opacityInput.value = opPct;
    if (autoApplyInput) autoApplyInput.checked = Boolean(state.settings.autoSearchApply);
    if (formatInput) formatInput.value = state.settings.preferredFormat || 'ass,srt,vtt';
    if (sourceInput) sourceInput.value = state.settings.preferredSource || NEW_DEFAULT_SOURCE;

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
   * Fix Issue #1: Prevent d-anime player from hijacking keyboard events (Arrow keys, Space, F, M, Enter, etc.)
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

      // Allow Alt+S global toggle even inside panel
      if (e.altKey && (e.key === 's' || e.key === 'S')) return;

      // If Enter is pressed inside the search title or episode input, trigger Jimaku search!
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

      // Stop propagation in capture phase so d-anime's document/window listeners never see the key!
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    // Register in capture phase (true) on window & document so we run before d-anime's listeners
    window.addEventListener('keydown', stopPlayerKeys, true);
    window.addEventListener('keyup', stopPlayerKeys, true);
    window.addEventListener('keypress', stopPlayerKeys, true);
  }

  function bindPanelEvents() {
    // Close button
    panelEl.querySelector('#dsub-close-btn').addEventListener('click', () => {
      panelEl.classList.remove('open');
      fabEl.classList.remove('active');
    });

    // Tabs
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

    // Track manual edits on title/episode inputs
    const titleInput = panelEl.querySelector('#dsub-search-title');
    const epInput = panelEl.querySelector('#dsub-search-ep');
    titleInput.addEventListener('input', () => {
      titleInput.dataset.userEdited = '1';
    });
    epInput.addEventListener('input', () => {
      epInput.dataset.userEdited = '1';
    });

    // Jimaku Search Button
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

    // Also allow dropping subtitle files anywhere on the page
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

    // AI Toggle Button
    panelEl.querySelector('#dsub-ai-toggle-btn').addEventListener('click', () => {
      if (state.ai.active) {
        stopAiTranscription();
      } else {
        startAiTranscription();
      }
    });

    // Settings inputs
    const apiKeyInput = panelEl.querySelector('#dsub-set-apikey');
    const aiUrlInput = panelEl.querySelector('#dsub-set-aiurl');
    const fontSizeInput = panelEl.querySelector('#dsub-set-fontsize');
    const bottomInput = panelEl.querySelector('#dsub-set-bottom');
    const opacityInput = panelEl.querySelector('#dsub-set-opacity');
    const transparentBtn = panelEl.querySelector('#dsub-transparent-btn');
    const autoApplyInput = panelEl.querySelector('#dsub-set-autoapply');
    const formatInput = panelEl.querySelector('#dsub-set-format');
    const sourceInput = panelEl.querySelector('#dsub-set-source');

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
      saveSettings({
        jimakuApiKey: apiKeyInput.value.trim(),
        aiServerUrl: aiUrlInput.value.trim() || 'http://127.0.0.1:8765',
        autoSearchApply: autoApplyInput.checked,
        preferredFormat: formatInput.value,
        preferredSource: sourceInput.value.trim() || NEW_DEFAULT_SOURCE,
      });
      const btn = panelEl.querySelector('#dsub-save-settings-btn');
      btn.textContent = '✓ 保存しました';
      setTimeout(() => {
        btn.textContent = '設定を保存';
      }, 1500);
    });

    // Offset buttons
    panelEl.querySelectorAll('[data-offset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const raw = btn.getAttribute('data-offset');
        if (raw === '0') {
          state.offsetSec = 0;
        } else {
          state.offsetSec = Math.round((state.offsetSec + parseFloat(raw)) * 10) / 10;
        }
        updateOffsetUI();
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
    if (el) {
      const sign = state.offsetSec > 0 ? '+' : '';
      el.textContent = `${sign}${state.offsetSec.toFixed(1)}s`;
    }
  }

  function loadSubtitleFileObject(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result || '');
      const cues = window.SubtitleParser.parseSubtitles(content, file.name);
      setCues(cues, file.name.slice(0, 14));
    };
    reader.readAsText(file);
  }

  // Jimaku.cc Search & Auto-load Flow
  async function handleJimakuSearch(options = { autoApplyBest: true }) {
    const statusEl = panelEl.querySelector('#dsub-jimaku-status');
    const listEl = panelEl.querySelector('#dsub-jimaku-results');
    const rawInputTitle = panelEl.querySelector('#dsub-search-title').value.trim();
    const title = rawInputTitle || state.workInfo.cleanTitle || state.workInfo.workTitle;
    const epVal = panelEl.querySelector('#dsub-search-ep').value.trim();
    const episode = epVal ? parseInt(epVal, 10) : state.workInfo.episodeNumber;

    if (!title) {
      statusEl.textContent = '⚠️ アニメのタイトルを入力してください。';
      return;
    }

    statusEl.textContent = `🔎 「${title}」を AniList + Jimaku.cc で検索中...`;
    listEl.style.display = 'none';
    listEl.innerHTML = '';

    const res = await sendBgMessage({
      type: 'JIMAKU_SEARCH',
      title,
      apiKey: state.settings.jimakuApiKey,
    });

    if (!res.ok) {
      statusEl.textContent = `❌ ${res.error}`;
      return;
    }

    const entries = res.entries || [];
    if (entries.length === 0) {
      statusEl.innerHTML =
        '⚠️ Jimaku.cc に該当作品の字幕が見つかりませんでした。<br/>「🎙️ AIリアルタイム」タブからAI自動字幕をお試しください！';
      return;
    }

    // Load files for the top matching entry automatically
    if (entries.length === 1 || options.autoApplyBest) {
      await loadJimakuEntryFiles(entries[0], episode, options.autoApplyBest, entries);
      return;
    }

    renderEntryList(entries, episode);
  }

  function renderEntryList(entries, episode) {
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
      item.addEventListener('click', () => loadJimakuEntryFiles(entry, episode, true, entries));
      listEl.appendChild(item);
    });
  }

  async function loadJimakuEntryFiles(entry, episode, autoApplyBest = true, allEntries = []) {
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
    });

    if (!res.ok) {
      statusEl.textContent = `❌ ${res.error}`;
      return;
    }

    const files = res.files || [];
    if (files.length === 0) {
      statusEl.textContent = '⚠️ 対象話数の字幕ファイルが見つかりませんでした。';
      if (allEntries.length > 1) {
        renderEntryList(allEntries, episode);
      }
      return;
    }

    // Show ranked file list in UI so user can also switch with 1 click if desired
    listEl.style.display = 'flex';
    files.forEach((file, idx) => {
      const item = document.createElement('div');
      item.className = 'dsub-list-item';
      if (idx === 0 && autoApplyBest) {
        item.style.background = 'rgba(235, 85, 40, 0.22)';
        item.style.borderLeft = '3px solid #ff7849';
      }
      item.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;" title="${file.name}">${
        idx === 0 ? '★ ' : ''
      }${file.name}</span><span style="color:#ff7849;font-size:11px;white-space:nowrap;">読込</span>`;
      item.addEventListener('click', () => {
        listEl.querySelectorAll('.dsub-list-item').forEach((el) => {
          el.style.background = '';
          el.style.borderLeft = '';
        });
        item.style.background = 'rgba(235, 85, 40, 0.22)';
        item.style.borderLeft = '3px solid #ff7849';
        downloadAndApplyJimakuFile(file);
      });
      listEl.appendChild(item);
    });

    // Automatically download and apply the #1 highest-ranked file!
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

    const cues = window.SubtitleParser.parseSubtitles(res.text, file.name);
    setCues(cues, 'Jimaku');
    statusEl.textContent = `✅ 適用完了: ${file.name} (${cues.length}行)`;
  }

  // Real-Time AI Transcription (Local GPU Faster-Whisper Server or WebSpeech)
  async function startAiTranscription() {
    const mode = panelEl.querySelector('#dsub-ai-mode').value;
    const statusEl = panelEl.querySelector('#dsub-ai-status');
    const toggleBtn = panelEl.querySelector('#dsub-ai-toggle-btn');

    const video = document.querySelector('video');
    if (!video) {
      statusEl.textContent = '❌ 再生中の動画(<video>)が見つかりません。';
      return;
    }

    state.ai.mode = mode;

    if (mode === 'whisper') {
      statusEl.textContent = '🔌 ローカルAIサーバー (127.0.0.1:8765) の接続を確認中...';
      const health = await sendBgMessage({
        type: 'AI_HEALTH',
        serverUrl: state.settings.aiServerUrl,
      });

      if (!health.ok) {
        statusEl.innerHTML =
          '❌ ローカルAIサーバーに接続できません。<br/>ターミナルで <code>./start_server.sh</code> を起動してください。';
        return;
      }

      try {
        await startVideoAudioCapture(video, statusEl);
      } catch (err) {
        statusEl.textContent = `❌ 音声キャプチャエラー: ${err.message || err}`;
        return;
      }
    } else {
      startWebSpeechFallback(statusEl);
    }

    state.ai.active = true;
    toggleBtn.textContent = '⏹ AIリアルタイム字幕を停止';
    toggleBtn.classList.add('dsub-btn-danger');
    updateBadge('AI字幕稼働中');
  }

  function stopAiTranscription() {
    const statusEl = panelEl?.querySelector('#dsub-ai-status');
    const toggleBtn = panelEl?.querySelector('#dsub-ai-toggle-btn');

    state.ai.active = false;
    if (state.ai.timerId) {
      clearInterval(state.ai.timerId);
      state.ai.timerId = null;
    }
    if (state.ai.recognition) {
      try {
        state.ai.recognition.stop();
      } catch (_) {}
      state.ai.recognition = null;
    }

    if (toggleBtn) {
      toggleBtn.textContent = '🎙️ AIリアルタイム字幕を開始';
      toggleBtn.classList.remove('dsub-btn-danger');
    }
    if (statusEl) {
      statusEl.textContent = '⏹ AIリアルタイム字幕を停止しました。';
    }
    updateBadge(state.cues.length ? `AI (${state.cues.length}行)` : '未読込');
  }

  async function startVideoAudioCapture(video, statusEl) {
    statusEl.textContent =
      '🟢 ローカルGPU Whisper でリアルタイム文字起こし中... (システム音声モニター同期)';

    const promptTitle = state.workInfo.cleanTitle
      ? `アニメ「${state.workInfo.cleanTitle}」の日本語セリフ。`
      : 'アニメの日本語のセリフ。';

    state.ai.timerId = setInterval(async () => {
      if (!state.ai.active || state.ai.busy || video.paused) return;
      state.ai.busy = true;
      const chunkEndVideoTime = video.currentTime;
      const chunkDuration = state.ai.chunkSec;
      const chunkStartVideoTime = Math.max(0, chunkEndVideoTime - chunkDuration);

      try {
        const res = await sendBgMessage({
          type: 'AI_TRANSCRIBE',
          audioBase64: null,
          language: 'ja',
          prompt: promptTitle,
          serverUrl: state.settings.aiServerUrl,
        });

        if (res.ok && res.result && res.result.text) {
          const text = res.result.text.trim();
          if (text) {
            const cue = {
              start: chunkStartVideoTime,
              end: chunkEndVideoTime + 2.2,
              text,
            };
            state.cues.push(cue);
            subBoxEl.textContent = text;
            statusEl.textContent = `🟢 認識: 「${text}」`;
          }
        }
      } catch (_) {
        // Ignore transient errors
      } finally {
        state.ai.busy = false;
      }
    }, 2200);
  }

  function startWebSpeechFallback(statusEl) {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      statusEl.textContent = '❌ このブラウザはWeb Speech APIに対応していません。';
      return;
    }
    const rec = new SpeechRecognition();
    rec.lang = 'ja-JP';
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (event) => {
      let text = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
      }
      if (text.trim()) {
        subBoxEl.textContent = text.trim();
      }
    };
    rec.onerror = () => {};
    rec.onend = () => {
      if (state.ai.active && state.ai.mode === 'webspeech') {
        try {
          rec.start();
        } catch (_) {}
      }
    };
    rec.start();
    state.ai.recognition = rec;
    statusEl.textContent = '🟢 ブラウザ音声認識でリアルタイム字幕表示中...';
  }

  // Render active subtitle cue for current video time
  function renderCurrentSubtitle() {
    if (!subBoxEl || !state.enabled) return;
    if (!currentVideo || !document.body.contains(currentVideo)) {
      currentVideo = document.querySelector('video');
    }
    if (!currentVideo || state.cues.length === 0) {
      if (!state.ai.active) subBoxEl.textContent = '';
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
        updateOffsetUI();
        renderCurrentSubtitle();
      } else if (e.key === ']') {
        state.offsetSec = Math.round((state.offsetSec + 0.5) * 10) / 10;
        updateOffsetUI();
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

  // Main initialization loop
  async function init() {
    ensureUI();
    setupKeyboardIsolation();
    await loadSettings();
    setupShortcuts();
    setupFullscreenHandler();
    await detectWorkInfo();

    // High-frequency sync loop (every 100ms + video timeupdate)
    setInterval(() => {
      const v = document.querySelector('video');
      if (v && v !== currentVideo) {
        currentVideo = v;
        v.addEventListener('timeupdate', renderCurrentSubtitle);
        v.addEventListener('seeked', renderCurrentSubtitle);
        detectWorkInfo();
      }
      renderCurrentSubtitle();
    }, 100);

    // Watch for episode / URL changes (partId change)
    let lastHref = window.location.href;
    setInterval(() => {
      if (window.location.href !== lastHref) {
        lastHref = window.location.href;
        const titleInput = panelEl?.querySelector('#dsub-search-title');
        const epInput = panelEl?.querySelector('#dsub-search-ep');
        if (titleInput) delete titleInput.dataset.userEdited;
        if (epInput) delete epInput.dataset.userEdited;
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
