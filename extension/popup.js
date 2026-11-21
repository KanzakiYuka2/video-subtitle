document.addEventListener('DOMContentLoaded', () => {
  const SP = window.DSubSourceProfiles;
  const apiKeyEl = document.getElementById('apiKey');
  const sourceMountEl = document.getElementById('popup-source-mount');
  const saveBtn = document.getElementById('saveBtn');
  const toggleBtn = document.getElementById('togglePanelBtn');

  let currentProfiles = SP.cloneDefaultProfiles();
  let sourceEditor = null;

  function persistProfiles(profiles) {
    currentProfiles = SP.normalizeSourceProfiles(profiles);
    const nfProfile = currentProfiles.find((p) => p.id === 'netflix');
    chrome.storage.local.set({
      sourceProfiles: currentProfiles,
      preferredSource: currentProfiles.map((p) => p.name).join(','),
      netflixDefaultOffsetSec: nfProfile ? nfProfile.offset : -1.0,
      netflixOffsetMigratedV1: true,
    });
  }

  sourceEditor = SP.mountSourceDictionary({
    container: sourceMountEl,
    getProfiles: () => currentProfiles,
    onChange: (next) => {
      persistProfiles(next);
    },
    startOpen: false,
  });

  chrome.storage.local.get(
    {
      jimakuApiKey: '',
      sourceProfiles: null,
      preferredSource: SP.DEFAULT_PREFERRED_SOURCE,
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
      currentProfiles = SP.normalizeSourceProfiles(
        items.sourceProfiles,
        items.preferredSource,
        items.netflixDefaultOffsetSec
      );
      if (!Array.isArray(items.sourceProfiles) || items.sourceProfiles.length === 0) {
        chrome.storage.local.set({
          sourceProfiles: currentProfiles,
          preferredSource: currentProfiles.map((p) => p.name).join(','),
        });
      }
      sourceEditor.render();
    }
  );

  saveBtn.addEventListener('click', () => {
    const normalized = SP.normalizeSourceProfiles(currentProfiles);
    const nfProfile = normalized.find((p) => p.id === 'netflix');
    chrome.storage.local.set(
      {
        jimakuApiKey: apiKeyEl.value.trim(),
        sourceProfiles: normalized,
        preferredSource: normalized.map((p) => p.name).join(','),
        netflixDefaultOffsetSec: nfProfile ? nfProfile.offset : -1.0,
        netflixOffsetMigratedV1: true,
      },
      () => {
        saveBtn.textContent = '✓ 保存しました';
        setTimeout(() => {
          saveBtn.textContent = '設定を保存';
        }, 1200);
      }
    );
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
