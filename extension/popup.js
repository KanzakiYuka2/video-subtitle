document.addEventListener('DOMContentLoaded', () => {
  const apiKeyEl = document.getElementById('apiKey');
  const aiServerEl = document.getElementById('aiServerUrl');
  const saveBtn = document.getElementById('saveBtn');
  const toggleBtn = document.getElementById('togglePanelBtn');

  chrome.storage.local.get(
    {
      jimakuApiKey: '',
      aiServerUrl: 'http://127.0.0.1:8765',
    },
    (items) => {
      apiKeyEl.value = items.jimakuApiKey || '';
      aiServerEl.value = items.aiServerUrl || 'http://127.0.0.1:8765';
    }
  );

  saveBtn.addEventListener('click', () => {
    chrome.storage.local.set(
      {
        jimakuApiKey: apiKeyEl.value.trim(),
        aiServerUrl: aiServerEl.value.trim() || 'http://127.0.0.1:8765',
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
