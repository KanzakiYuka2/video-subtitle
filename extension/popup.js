const SOURCE_PRIORITY_PRESETS = {
  platinum_other: 'ABEMA,DMMTV,U-NEXT,Amazon,Other,Netflix,NanokoRaws,shincaps',
  standard_tiers: 'ABEMA,DMMTV,U-NEXT,Amazon,Netflix,NanokoRaws,shincaps,Other',
};

document.addEventListener('DOMContentLoaded', () => {
  const apiKeyEl = document.getElementById('apiKey');
  const sourceModeEl = document.getElementById('sourcePriorityMode');
  const nfOffsetEl = document.getElementById('netflixDefaultOffsetSec');
  const aiServerEl = document.getElementById('aiServerUrl');
  const saveBtn = document.getElementById('saveBtn');
  const toggleBtn = document.getElementById('togglePanelBtn');

  chrome.storage.local.get(
    {
      jimakuApiKey: '',
      aiServerUrl: 'http://127.0.0.1:8765',
      sourcePriorityMode: 'platinum_other',
      preferredSource: SOURCE_PRIORITY_PRESETS.platinum_other,
      netflixDefaultOffsetSec: -1.0,
      netflixOffsetMigratedV1: false,
    },
    (items) => {
      if (!items.netflixOffsetMigratedV1) {
        if (Number(items.netflixDefaultOffsetSec) === 0) {
          items.netflixDefaultOffsetSec = -1.0;
        }
        chrome.storage.local.set({
          netflixDefaultOffsetSec: items.netflixDefaultOffsetSec,
          netflixOffsetMigratedV1: true,
        });
      }
      apiKeyEl.value = items.jimakuApiKey || '';
      sourceModeEl.value = items.sourcePriorityMode || 'platinum_other';
      nfOffsetEl.value = Number(items.netflixDefaultOffsetSec ?? -1.0).toFixed(1);
      aiServerEl.value = items.aiServerUrl || 'http://127.0.0.1:8765';
    }
  );

  saveBtn.addEventListener('click', () => {
    const mode = sourceModeEl.value;
    const nfOff = parseFloat(nfOffsetEl.value);
    const payload = {
      jimakuApiKey: apiKeyEl.value.trim(),
      aiServerUrl: aiServerEl.value.trim() || 'http://127.0.0.1:8765',
      sourcePriorityMode: mode,
      netflixDefaultOffsetSec: Number.isFinite(nfOff) ? Math.round(nfOff * 10) / 10 : -1.0,
      netflixOffsetMigratedV1: true,
    };
    if (SOURCE_PRIORITY_PRESETS[mode]) {
      payload.preferredSource = SOURCE_PRIORITY_PRESETS[mode];
    }

    chrome.storage.local.set(payload, () => {
      saveBtn.textContent = '✓ 保存しました';
      setTimeout(() => {
        saveBtn.textContent = '設定を保存';
      }, 1200);
    });
  });

  toggleBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_PANEL' });
        window.close();
      }
    });
  });
});
