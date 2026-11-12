(async () => {
  const assert = (condition, label) => { if (!condition) throw Error(label); };
  try {
    const a = window.testAPI;
    const video = document.querySelector('#main-video');
    assert(SubtitlePlayer.getVideo() === video, 'select main player, not hidden preview');
    document.querySelector('.atvwebplayersdk-subtitle-text').textContent = 'シーズン2 第１２話';
    assert(SubtitlePlayer.primeInfo().episodeNumber === 12, 'Japanese episode, not season');
    document.querySelector('.atvwebplayersdk-subtitle-text').textContent = 'S2 E4 — Test';
    assert(SubtitlePlayer.primeInfo().episodeNumber === 4, 'English episode');
    Object.defineProperty(video, 'currentTime', { value: 20, writable: true });
    Object.defineProperty(video, 'duration', { value: 100 });
    a.ensureUI();
    await a.detectWorkInfo();
    const titleInput = document.querySelector('#dsub-search-title');
    titleInput.value = 'Visible title';
    const titleStyle = getComputedStyle(titleInput);
    assert(titleStyle.color === 'rgb(255, 255, 255)', 'input value color survives host CSS');
    assert(titleStyle.webkitTextFillColor === 'rgb(255, 255, 255)', 'input text fill survives host CSS');
    assert(titleStyle.opacity === '1', 'input opacity survives host CSS');
    assert(a.state.workInfo.episodeNumber === 4, 'Prime metadata used');
    assert(document.querySelector('#dsub-search-kind').value === 'drama', 'Prime defaults to drama');
    a.setCues([{start:10,end:12,text:'First'},{start:20,end:22,text:'Second'}], 'test');
    a.toggleLyrics(true);
    document.querySelector('[data-cue="0"]').click();
    assert(a.state.offsetSec === 10 && video.currentTime === 20, 'sync without seeking');
    a.toggleLyrics(true);
    document.querySelector('#danime-sub-lyrics select').value = 'seek';
    document.querySelector('[data-cue="1"]').click();
    assert(video.currentTime === 30, 'seek includes offset');
    video.currentTime = 90;
    a.renderCurrentSubtitle();
    assert(document.querySelector('.danime-sub-box').textContent === '', 'no gap placeholder');
    document.querySelector('.atvwebplayersdk-subtitle-text').textContent = 'S2 E5';
    await a.detectWorkInfo();
    assert(!a.state.cues.length && a.state.offsetSec === 0, 'episode transition resets subtitles');
    const calls = [];
    window.fetch = async (url) => {
      calls.push(String(url));
      return {ok:true, json:async()=>[{id:1,name:'Drama'}]};
    };
    const result = await jimakuSearch('Drama', 'test-key', 'drama');
    assert(result.length === 1 && calls.length === 1 && calls[0].includes('anime=false'), 'drama search skips AniList');
    document.querySelector('#result').textContent = 'PASS: Prime player, metadata, sync, seek, gaps, episode reset, drama search';
  } catch (error) { document.querySelector('#result').textContent = 'FAIL: ' + error.stack; }
})();
