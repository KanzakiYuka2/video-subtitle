document.addEventListener('DOMContentLoaded', () => {
  const I18N = window.DSubI18n;
  const SP = window.DSubSourceProfiles;

  const titleEl = document.getElementById('popupTitle');
  const langSelectEl = document.getElementById('languageSelect');
  const apiKeyLabelEl = document.getElementById('apiKeyLabel');
  const apiKeyEl = document.getElementById('apiKey');
  const sourceMountEl = document.getElementById('popup-source-mount');
  const saveBtn = document.getElementById('saveBtn');
  const toggleBtn = document.getElementById('togglePanelBtn');
  const hintEl = document.getElementById('popupHint');

  let currentLang = I18N.detectDefaultLanguage();
  let currentProfiles = SP.cloneDefaultProfiles();
  let sourceEditor = null;
  let saveFlashTimer = null;

  function applyLanguage() {
    document.documentElement.lang = currentLang === 'zh_CN' ? 'zh-CN' : currentLang;
    document.title = I18N.t('appTitle', null, currentLang);
    titleEl.textContent = I18N.t('popupTitle', null, currentLang);
    langSelectEl.value = currentLang;
    langSelectEl.setAttribute('aria-label', I18N.t('languageLabel', null, currentLang));

    const labelText = I18N.t('apiKeyLabelPrefix', null, currentLang);
    const getFreeText = I18N.t('apiKeyGetFree', null, currentLang);
    apiKeyLabelEl.innerHTML = `${labelText} (<a href="https://jimaku.cc/account" target="_blank" rel="noopener">${getFreeText}</a>)`;
    apiKeyEl.placeholder = I18N.t('apiKeyPlaceholder', null, currentLang);

    if (!saveFlashTimer) {
      saveBtn.textContent = I18N.t('saveSettingsBtn', null, currentLang);
    }
    toggleBtn.textContent = I18N.t('popupToggleBtn', null, currentLang);
    hintEl.innerHTML = I18N.t('popupHintHtml', null, currentLang);

    if (sourceEditor) {
      sourceEditor.refreshLabels();
    }
  }

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
    onChange: persistProfiles,
    getLabels: () => I18N.getSourceDictionaryLabels(currentLang),
    startOpen: false,
  });

  applyLanguage();

  chrome.storage.local.get(
    {
      language: '',
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
      currentLang = items.language
        ? I18N.normalizeLanguage(items.language)
        : I18N.detectDefaultLanguage();
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
      applyLanguage();
      sourceEditor.render();
    }
  );

  langSelectEl.addEventListener('change', () => {
    currentLang = I18N.normalizeLanguage(langSelectEl.value);
    applyLanguage();
    chrome.storage.local.set({ language: currentLang });
  });

  saveBtn.addEventListener('click', () => {
    const normalized = SP.normalizeSourceProfiles(currentProfiles);
    const nfProfile = normalized.find((p) => p.id === 'netflix');
    chrome.storage.local.set(
      {
        language: currentLang,
        jimakuApiKey: apiKeyEl.value.trim(),
        sourceProfiles: normalized,
        preferredSource: normalized.map((p) => p.name).join(','),
        netflixDefaultOffsetSec: nfProfile ? nfProfile.offset : -1.0,
        netflixOffsetMigratedV1: true,
      },
      () => {
        if (saveFlashTimer) clearTimeout(saveFlashTimer);
        saveBtn.textContent = I18N.t('savedSettingsBtn', null, currentLang);
        saveFlashTimer = setTimeout(() => {
          saveFlashTimer = null;
          saveBtn.textContent = I18N.t('saveSettingsBtn', null, currentLang);
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
