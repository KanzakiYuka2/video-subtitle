/**
 * Content Script for dアニメ字幕アシスタント
 * - Detects d-anime work title & episode number automatically via WS010105 API & DOM selectors
 * - Searches & loads Japanese subtitle files directly from Jimaku.cc
 * - Supports Drag & Drop / file picker for .srt, .vtt, .ass, .ssa
 * - Supports Real-Time AI Transcription via local Whisper server (WebAudio / WebSpeech fallback)
 * - Syncs subtitle display with <video> currentTime + customizable offset & styling
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
    workInfo: {
      partId: '',
      workTitle: '',
      partDispNumber: '',
      partTitle: '',
      episodeNumber: null,
    },
    settings: {
      jimakuApiKey: '',
      aiServerUrl: 'http://127.0.0.1:8765',
      fontSize: 28,
      bottomPosition: 10,
      bgOpacity: 0.65,
      textColor: '#ffffff',
    },
    ai: {
      active: false,
      mode: 'whisper', // 'whisper' (local GPU server) or 'webspeech'
      chunkSec: 3.5,
      timerId: null,
      audioCtx: null,
      sourceNode: null,
      processorNode: null,
      pcmBuffer: [],
      sampleRate: 16000,
      captureStartVideoTime: 0,
      busy: false,
      recognition: null,
    },
  };

  let overlayEl = null;
  let subBoxEl = null;
  let fabEl = null;
  let panelEl = null;
  let currentVideo = null;

  // Load saved settings
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(state.settings, (items) => {
        Object.assign(state.settings, items);
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
    // Convert full-width digits to half-width
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
              partDispNumber: data.partDispNumber || '',
              partTitle: data.partTitle || '',
              episodeNumber: parseEpisodeNumber(data.partDispNumber),
            };
            updateMetadataUI();
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
        partId,
        workTitle: t1,
        partDispNumber: t2,
        partTitle: t3,
        episodeNumber: parseEpisodeNumber(t2),
      };
      updateMetadataUI();
    }
    return state.workInfo;
  }

  function updateMetadataUI() {
    if (!panelEl) return;
    const titleInput = panelEl.querySelector('#dsub-search-title');
    const epInput = panelEl.querySelector('#dsub-search-ep');
    if (titleInput && state.workInfo.workTitle && !titleInput.dataset.userEdited) {
      titleInput.value = state.workInfo.workTitle;
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
            <input type="text" class="dsub-input" id="dsub-search-title" placeholder="アニメタイトル (自動取得)" />
            <input type="number" class="dsub-input" id="dsub-search-ep" placeholder="話数" style="width: 68px;" min="0" />
          </div>
          <div class="dsub-row">
            <button class="dsub-btn dsub-btn-primary" id="dsub-jimaku-search-btn" style="width: 100%;">
              Jimaku.cc から日本語字幕を検索
            </button>
          </div>
          <div class="dsub-status" id="dsub-jimaku-status">
            再生中の作品タイトルから自動で日本語字幕(.srt/.ass)を検索します。
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
          <div>
            <div class="dsub-label" style="margin-bottom: 4px;">Jimaku.cc APIキー (<a href="https://jimaku.cc/account" target="_blank" rel="noopener" style="color:#ff7849;">無料取得はこちら</a>)</div>
            <input type="password" class="dsub-input" id="dsub-set-apikey" placeholder="Jimaku API Key を貼り付け" />
          </div>
          <div>
            <div class="dsub-label" style="margin-bottom: 4px;">ローカルAIサーバーURL</div>
            <input type="text" class="dsub-input" id="dsub-set-aiurl" placeholder="http://127.0.0.1:8765" />
          </div>
          <div class="dsub-row">
            <span class="dsub-label">文字サイズ (<span id="dsub-val-fontsize">28</span>px)</span>
            <input type="range" id="dsub-set-fontsize" min="16" max="54" value="28" style="width: 160px;" />
          </div>
          <div class="dsub-row">
            <span class="dsub-label">下からの位置 (<span id="dsub-val-bottom">10</span>%)</span>
            <input type="range" id="dsub-set-bottom" min="2" max="85" value="10" style="width: 160px;" />
          </div>
          <div class="dsub-row">
            <span class="dsub-label">背景の不透明度 (<span id="dsub-val-opacity">65</span>%)</span>
            <input type="range" id="dsub-set-opacity" min="0" max="100" value="65" style="width: 160px;" />
          </div>
          <button class="dsub-btn dsub-btn-primary" id="dsub-save-settings-btn">設定を保存</button>
        </div>
      </div>

      <!-- Footer: Always-accessible sync offset & visibility toggle -->
      <div class="dsub-footer">
        <div class="dsub-row">
          <span class="dsub-label">表示タイミング調整: <b id="dsub-offset-val">0.0s</b></span>
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
    applyOverlayStyles();
  }

  function makeOverlayDraggable(overlay, box) {
    let dragging = false;
    let startY = 0;
    let startBottom = 10;

    box.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startY = e.clientY;
      startBottom = state.settings.bottomPosition;
      box.style.cursor = 'grabbing';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const deltaY = startY - e.clientY;
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

  function applyOverlayStyles() {
    if (!overlayEl || !subBoxEl) return;
    overlayEl.style.bottom = `${state.settings.bottomPosition}%`;
    subBoxEl.style.fontSize = `${state.settings.fontSize}px`;
    subBoxEl.style.color = state.settings.textColor || '#ffffff';
    subBoxEl.style.backgroundColor = `rgba(0, 0, 0, ${state.settings.bgOpacity})`;
    overlayEl.style.display = state.enabled ? 'block' : 'none';
  }

  function updateBadge(text) {
    state.sourceLabel = text;
    const badge = document.getElementById('danime-sub-fab-badge');
    if (badge) badge.textContent = text;
  }

  function setCues(cues, label) {
    state.cues = cues || [];
    updateBadge(`${label} (${state.cues.length}行)`);
    renderCurrentSubtitle();
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
      .addEventListener('click', () => handleJimakuSearch());

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
      const name = state.workInfo.workTitle
        ? `${state.workInfo.workTitle}_${state.workInfo.partDispNumber || ''}.srt`
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

    apiKeyInput.value = state.settings.jimakuApiKey || '';
    aiUrlInput.value = state.settings.aiServerUrl || 'http://127.0.0.1:8765';
    fontSizeInput.value = state.settings.fontSize;
    bottomInput.value = state.settings.bottomPosition;
    opacityInput.value = Math.round(state.settings.bgOpacity * 100);

    panelEl.querySelector('#dsub-val-fontsize').textContent = state.settings.fontSize;
    panelEl.querySelector('#dsub-val-bottom').textContent = state.settings.bottomPosition;
    panelEl.querySelector('#dsub-val-opacity').textContent = Math.round(
      state.settings.bgOpacity * 100
    );

    fontSizeInput.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      panelEl.querySelector('#dsub-val-fontsize').textContent = val;
      saveSettings({ fontSize: val });
    });

    bottomInput.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      panelEl.querySelector('#dsub-val-bottom').textContent = val;
      saveSettings({ bottomPosition: val });
    });

    opacityInput.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      panelEl.querySelector('#dsub-val-opacity').textContent = val;
      saveSettings({ bgOpacity: val / 100 });
    });

    panelEl.querySelector('#dsub-save-settings-btn').addEventListener('click', () => {
      saveSettings({
        jimakuApiKey: apiKeyInput.value.trim(),
        aiServerUrl: aiUrlInput.value.trim() || 'http://127.0.0.1:8765',
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
  async function handleJimakuSearch() {
    const statusEl = panelEl.querySelector('#dsub-jimaku-status');
    const listEl = panelEl.querySelector('#dsub-jimaku-results');
    const title = panelEl.querySelector('#dsub-search-title').value.trim();
    const epVal = panelEl.querySelector('#dsub-search-ep').value.trim();
    const episode = epVal ? parseInt(epVal, 10) : null;

    if (!title) {
      statusEl.textContent = '⚠️ アニメのタイトルを入力してください。';
      return;
    }

    statusEl.textContent = `🔎 「${title}」を Jimaku.cc で検索中...`;
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

    // If single entry, immediately list its episode files
    if (entries.length === 1) {
      await loadJimakuEntryFiles(entries[0], episode);
      return;
    }

    statusEl.textContent = `✅ ${entries.length}件の作品が見つかりました。選択してください：`;
    listEl.style.display = 'flex';
    entries.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'dsub-list-item';
      const jpName = entry.japanese_name || entry.name || entry.english_name || `ID:${entry.id}`;
      item.innerHTML = `<span>📁 ${jpName}</span><span style="color:#9ca3af;font-size:11px;">選択 ▶</span>`;
      item.addEventListener('click', () => loadJimakuEntryFiles(entry, episode));
      listEl.appendChild(item);
    });
  }

  async function loadJimakuEntryFiles(entry, episode) {
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
    });

    if (!res.ok) {
      statusEl.textContent = `❌ ${res.error}`;
      return;
    }

    const files = res.files || [];
    if (files.length === 0) {
      statusEl.textContent = '⚠️ 対象話数の字幕ファイルが見つかりませんでした。';
      return;
    }

    // Auto-download if only 1 matching subtitle file
    if (files.length === 1) {
      await downloadAndApplyJimakuFile(files[0]);
      return;
    }

    statusEl.textContent = `📄 字幕ファイルを選択してください (${files.length}件):`;
    listEl.style.display = 'flex';
    files.forEach((file) => {
      const item = document.createElement('div');
      item.className = 'dsub-list-item';
      item.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;">${file.name}</span><span style="color:#ff7849;font-size:11px;white-space:nowrap;">読込</span>`;
      item.addEventListener('click', () => downloadAndApplyJimakuFile(file));
      listEl.appendChild(item);
    });
  }

  async function downloadAndApplyJimakuFile(file) {
    const statusEl = panelEl.querySelector('#dsub-jimaku-status');
    statusEl.textContent = `⬇️ 「${file.name}」をダウンロード中...`;

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
    statusEl.textContent = `✅ 「${file.name}」を読み込みました (${cues.length}行)`;
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
    if (state.ai.processorNode) {
      try {
        state.ai.processorNode.disconnect();
      } catch (_) {}
      state.ai.processorNode = null;
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
    // Note: For encrypted EME streams where WebAudio captureStream/createMediaElementSource
    // may output silence in some browsers, the local server also supports direct PulseAudio/PipeWire
    // system audio monitor capture (`source: "system"`). We support both seamlessly!
    statusEl.textContent =
      '🟢 ローカルGPU Whisper でリアルタイム文字起こし中... (システム音声モニター同期)';

    const promptTitle = state.workInfo.workTitle
      ? `アニメ「${state.workInfo.workTitle}」の日本語セリフ。`
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
          audioBase64: null, // Signals server to use its continuous ring-buffer from PipeWire/PulseAudio monitor
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
    if (!currentVideo || ! document.body.contains(currentVideo)) {
      currentVideo = document.querySelector('video');
    }
    if (!currentVideo || state.cues.length === 0) {
      if (!state.ai.active) subBoxEl.textContent = '';
      return;
    }

    const t = currentVideo.currentTime - state.offsetSec;
    // Find all active cues at time t
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
    }
  }

  // Keyboard shortcuts
  function setupShortcuts() {
    window.addEventListener('keydown', (e) => {
      // Ignore when typing in an input
      if (
        e.target &&
        (e.target.tagName === 'INPUT' ||
          e.target.tagName === 'TEXTAREA' ||
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

  // Keep overlay visible even when video container enters Fullscreen
  function setupFullscreenHandler() {
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
    await loadSettings();
    setupShortcuts();
    setupFullscreenHandler();
    await detectWorkInfo();

    // High-frequency sync loop (every 80ms + video timeupdate)
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
