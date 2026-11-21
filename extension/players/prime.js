/**
 * Player Adapter: Amazon Prime Video (primevideo.com / amazon.co.jp)
 */
(function (global) {
  const registry = global.SubtitlePlayerRegistry;
  if (!registry) return;

  const PRIME_EXACT_GENRE_SELECTOR =
    '#main > div.DVWebNode-detail-atf-wrapper > div > div > div > div.InqnnM > div.De8854.av-dp-container.f2OgXy > div:nth-child(2) > div.eu9sed > div.prVTDY > div > div > div.dv-node-dp-genres.jRnQrN > span:nth-child(1) > a';

  const PRIME_GENRE_SELECTORS = [
    PRIME_EXACT_GENRE_SELECTOR,
    '.dv-node-dp-genres a',
    '.dv-node-dp-genres span',
    '[data-testid*="genre"] a',
    '[data-testid*="genre"] span',
    '[data-automation-id*="genre"] a',
    '[data-automation-id*="genre"] span',
  ];

  const ANIME_GENRE_RE = /アニメ|anime|animation|アニメーション/i;

  function detectSearchKind() {
    const texts = [];
    for (const selector of PRIME_GENRE_SELECTORS) {
      try {
        document.querySelectorAll(selector).forEach((el) => {
          const val = el?.textContent?.trim();
          if (val) texts.push(val);
        });
      } catch (_) {}
    }
    if (texts.length === 0) return null;
    return texts.some((txt) => ANIME_GENRE_RE.test(txt)) ? 'anime' : 'drama';
  }

  function extractMetadata(helpers = {}) {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() || '';
    const rawTitle = text('.atvwebplayersdk-title-text') || text('[data-testid="title"]');
    const cleanTitle =
      typeof helpers.cleanWorkTitle === 'function' ? helpers.cleanWorkTitle(rawTitle) : rawTitle;
    const subtitle = text('.atvwebplayersdk-subtitle-text');
    const normalized = subtitle.replace(/[０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0)
    );
    const episode = normalized.match(
      /(?:第\s*(\d+)\s*話|エピソード\s*(\d+)|(?:Episode|Ep\.?|E)\s*(\d+)\b|(\d+)\s*話)/i
    );
    const epStr = episode ? episode[1] || episode[2] || episode[3] || episode[4] : '';
    return {
      partId: global.location.pathname + global.location.search,
      workTitle: rawTitle,
      cleanTitle,
      partDispNumber: epStr,
      partTitle: subtitle,
      episodeNumber: epStr ? Number(epStr) : null,
      searchKind: detectSearchKind(),
    };
  }

  registry.register({
    id: 'prime',
    name: 'Amazon Prime Video',
    defaultSearchKind: 'drama',
    autoSearchOnLoad: true,
    resetOnNavigation: true,
    pollMetadata: true,
    alwaysResolveVideo: true,
    uiClass: 'dsub-prime',
    extractMetadata,
    detectSearchKind,

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

    async detectWorkInfo(helpers) {
      return extractMetadata(helpers);
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
