// Offline regressions for the search imported from kysing02/dev (e11e4e6).
(async () => {
  const assert = (condition, label) => { if (!condition) throw Error(label); };
  try {
    assert(cleanTitleVariants('【推しの子】 【放送版】').cleanTitle === '【推しの子】', 'preserve bracketed anime titles');
    assert(detectExplicitSeason('Example Season 2 Part 2').seasonNumber === 2, 'distinguish seasons from cours');
    const first = {id: 1, type: 'ANIME', format: 'TV', episodes: 12, title: {native: 'Example'}, startDate: {year: 2024}};
    const second = {id: 2, type: 'ANIME', format: 'TV', episodes: 12, title: {native: 'Example Season 2'}, startDate: {year: 2025}};
    first.relations = {edges: [{relationType: 'SEQUEL', node: second}]};
    let requests = 0;
    window.fetch = async (url) => {
      requests++;
      if (String(url).includes('anilist.co')) return {ok: true, json: async () => ({data: {Page: {media: [first, second]}}})};
      if (String(url).includes('/files')) return {ok: true, json: async () => [{name: 'Example S02E01 [Amazon].ass'}, {name: 'Example S01E01.ass'}]};
      return {ok: true, json: async () => [{id: 10, anilist_id: 1, name: 'Example'}, {id: 20, anilist_id: 2, name: 'Example Season 2'}]};
    };
    const result = await jimakuSearch('Example Season 2', 'test-key', 'anime', 1);
    assert(result.entries[0].id === 20, 'rank target season first');
    assert(result.resolvedMeta.cumEp === 13 && result.resolvedMeta.seasonEp === 1, 'map cumulative and season episodes');
    const settings = {preferredFormat: 'ass,srt,vtt', preferredSource: 'Amazon,Netflix'};
    const meta = {...result.resolvedMeta, entryAnilistId: 2, entryName: 'Example Season 2'};
    const files = await jimakuGetFiles(20, 1, 'test-key', settings, meta);
    assert(files.length === 1 && files[0].name.includes('S02E01') && files[0]._exactEpisode, 'exclude wrong-season files');
    const before = requests;
    await jimakuSearch('Example Season 2', 'test-key', 'anime', 1);
    await jimakuGetFiles(20, 1, 'test-key', settings, meta);
    assert(requests === before, 'reuse search and full file list caches');
    document.querySelector('#result').textContent = 'PASS: title normalization, season mapping, entry ranking, file matching, search/file caches';
  } catch (error) { document.querySelector('#result').textContent = 'FAIL: ' + error.stack; }
})();
