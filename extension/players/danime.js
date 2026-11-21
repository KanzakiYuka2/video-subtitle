/**
 * Player Adapter: d-anime Store (animestore.docomo.ne.jp)
 */
(function (global) {
  const registry = global.SubtitlePlayerRegistry;
  if (!registry) return;

  registry.register({
    id: 'danime',
    name: 'd-anime Store',
    defaultSearchKind: 'anime',
    autoSearchOnLoad: true,
    resetOnNavigation: false,
    pollMetadata: false,
    alwaysResolveVideo: false,
    uiClass: '',

    matches(loc) {
      return /(^|\.)animestore\.docomo\.ne\.jp$/.test(loc.hostname);
    },

    getVideo() {
      return document.querySelector('video');
    },

    async detectWorkInfo({ cleanWorkTitle, parseEpisodeNumber }) {
      const params = new URLSearchParams(global.location.search);
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
              return {
                partId,
                workTitle: data.workTitle || '',
                cleanTitle: cleanWorkTitle(data.workTitle || ''),
                partDispNumber: data.partDispNumber || '',
                partTitle: data.partTitle || '',
                episodeNumber: parseEpisodeNumber(data.partDispNumber),
              };
            }
          }
        } catch (_) {
          // Fallback to DOM selectors below
        }
      }

      const t1 = document.querySelector('.backInfoTxt1')?.textContent?.trim() || '';
      const t2 = document.querySelector('.backInfoTxt2')?.textContent?.trim() || '';
      const t3 = document.querySelector('.backInfoTxt3')?.textContent?.trim() || '';
      if (!t1) return null;

      return {
        partId: partId || `${t1}_${t2}`,
        workTitle: t1,
        cleanTitle: cleanWorkTitle(t1),
        partDispNumber: t2,
        partTitle: t3,
        episodeNumber: parseEpisodeNumber(t2),
      };
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
