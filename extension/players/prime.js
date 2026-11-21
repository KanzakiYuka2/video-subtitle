/**
 * Player Adapter: Amazon Prime Video (primevideo.com / amazon.co.jp)
 */
(function (global) {
  const registry = global.SubtitlePlayerRegistry;
  if (!registry) return;

  function extractMetadata() {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() || '';
    const title = text('.atvwebplayersdk-title-text') || text('[data-testid="title"]');
    const subtitle = text('.atvwebplayersdk-subtitle-text');
    const normalized = subtitle.replace(/[０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0)
    );
    const episode = normalized.match(/(?:第\s*(\d+)\s*話|(?:Episode|Ep\.?|E)\s*(\d+)\b)/i);
    return {
      partId: global.location.pathname + global.location.search,
      workTitle: title,
      cleanTitle: title,
      partDispNumber: episode ? episode[1] || episode[2] : '',
      partTitle: subtitle,
      episodeNumber: episode ? Number(episode[1] || episode[2]) : null,
    };
  }

  registry.register({
    id: 'prime',
    name: 'Amazon Prime Video',
    defaultSearchKind: 'drama',
    autoSearchOnLoad: false,
    resetOnNavigation: true,
    pollMetadata: true,
    alwaysResolveVideo: true,
    uiClass: 'dsub-prime',
    extractMetadata,

    matches(loc) {
      return /(^|\.)(primevideo\.com|amazon\.co\.jp)$/.test(loc.hostname);
    },

    getVideo() {
      const videos = Array.from(document.querySelectorAll('video'));
      const visible = videos.filter((video) => {
        const rect = video.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(video).visibility !== 'hidden';
      });
      // Prime retains hidden preview players; pick the largest visible player.
      return (
        visible.sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return br.width * br.height - ar.width * ar.height;
        })[0] || null
      );
    },

    async detectWorkInfo() {
      return extractMetadata();
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
