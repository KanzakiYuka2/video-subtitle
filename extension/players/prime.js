/**
 * Player Adapter: Amazon Prime Video (primevideo.com / amazon.co.jp)
 */
(function (global) {
  const registry = global.SubtitlePlayerRegistry;
  if (!registry) return;

  const SESSION_STORAGE_KEY = '__dsub_prime_last_episode__';
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

  let lastClickedEpisode = null;

  function parsePrimeEpisode(str) {
    if (!str) return null;
    const normalized = String(str).replace(/[０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0)
    );
    const explicit = normalized.match(
      /(?:第\s*(\d+)\s*[話回]|エピソード\s*(\d+)|(?:Episode|Ep\.?|E)\s*(\d+)\b|(\d+)\s*[話回])/i
    );
    if (explicit) {
      return explicit[1] || explicit[2] || explicit[3] || explicit[4];
    }
    const hashNum = normalized.match(/(?:^|\s)#\s*(\d{1,3})\b/);
    if (hashNum) return hashNum[1];
    const ordinal = normalized.match(/^\s*(\d{1,3})\s*[.．:：]\s*\S/);
    return ordinal ? ordinal[1] : null;
  }

  function cleanEpisodeHeading(str) {
    if (!str) return '';
    return String(str)
      .replace(/^\s*\d{1,3}\s*[.．:：]\s*/, '')
      .replace(/^#\s*\d{1,3}\s+/, '')
      .trim();
  }

  function extractDetailId(rawUrl) {
    const match = String(rawUrl || '').match(/\/detail\/([A-Z0-9]+)/i);
    return match ? match[1] : '';
  }

  function readCachedEpisode() {
    try {
      const raw = global.sessionStorage && global.sessionStorage.getItem(SESSION_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function writeCachedEpisode(payload) {
    try {
      if (global.sessionStorage) {
        global.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
      }
    } catch (_) {}
  }

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

  function extractTitleRaw() {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() || '';
    const direct = (
      text('.atvwebplayersdk-title-text') ||
      text('[data-automation-id="title"]') ||
      text('[data-testid="title"]')
    )
      .replace(/\s*を観る\s*\|\s*Prime\s+Video\s*$/i, '')
      .trim();
    if (direct) return direct;

    const docTitle = (document.title || '')
      .replace(/^(?:Amazon\s+)?Prime\s+Video\s*[:：\-]\s*/i, '')
      .replace(/\s*を観る\s*\|\s*Prime\s+Video\s*$/i, '')
      .trim();
    return docTitle && !/^(?:Amazon\s+)?Prime\s+Video$/i.test(docTitle) ? docTitle : '';
  }

  function extractEpisodeFromCard(card) {
    if (!card) return null;
    const headingEl = card.querySelector('h3 span, h3, [data-testid*="episode-title"]');
    const heading = headingEl?.textContent?.trim() || '';
    const link = card.querySelector(
      'a[data-testid="episodes-playbutton"], a[href*="/detail/"], [aria-label*="エピソード"], [aria-label*="Episode"]'
    );
    const aria = link?.getAttribute('aria-label') || '';
    let epStr = parsePrimeEpisode(heading) || parsePrimeEpisode(aria);
    if (!epStr && card.id) {
      const idxMatch = card.id.match(/^av-ep-episode-(\d+)$/);
      if (idxMatch) epStr = String(Number(idxMatch[1]) + 1);
    }
    if (!epStr) return null;
    return {
      episodeNumber: Number(epStr),
      partDispNumber: epStr,
      partTitle: cleanEpisodeHeading(heading) || aria || '',
      detailId: extractDetailId(link?.getAttribute('href') || ''),
    };
  }

  function findEpisodeCardByDetailId(detailId) {
    if (!detailId) return null;
    const links = document.querySelectorAll(
      `[id^="av-ep-episode-"] a[href*="/detail/${detailId}"], [data-testid="episode-list-item"] a[href*="/detail/${detailId}"]`
    );
    for (const a of links) {
      const card = a.closest('[id^="av-ep-episode-"], [data-testid="episode-list-item"]');
      if (card) return extractEpisodeFromCard(card);
    }
    return null;
  }

  function extractEpisodeFromPageDom(currentDetailId) {
    if (currentDetailId) {
      const byCurrentUrl = findEpisodeCardByDetailId(currentDetailId);
      if (byCurrentUrl) return byCurrentUrl;
    }

    const topPlayBtn = document.querySelector('[data-testid="dp-atf-play-button"]');
    if (topPlayBtn) {
      const topDetailId = extractDetailId(topPlayBtn.getAttribute('href') || '');
      const cardFromTop = findEpisodeCardByDetailId(topDetailId);
      if (cardFromTop) return cardFromTop;
      const btnText = `${topPlayBtn.getAttribute('aria-label') || ''} ${topPlayBtn.textContent || ''}`.trim();
      const epStr = parsePrimeEpisode(btnText);
      if (epStr) {
        return {
          episodeNumber: Number(epStr),
          partDispNumber: epStr,
          partTitle: '',
          detailId: topDetailId,
        };
      }
    }

    const activePlayLink = document.querySelector(
      '[id^="av-ep-episode-"] a[data-testid="episodes-playbutton"], [data-testid="episode-list-item"] a[data-testid="episodes-playbutton"]'
    );
    if (activePlayLink) {
      const card = activePlayLink.closest('[id^="av-ep-episode-"], [data-testid="episode-list-item"]');
      const cardInfo = extractEpisodeFromCard(card);
      if (cardInfo) return cardInfo;
    }

    const firstCard = document.querySelector('#av-ep-episode-0, [data-testid="episode-list-item"]');
    if (firstCard) {
      return extractEpisodeFromCard(firstCard);
    }
    return null;
  }

  function setupEpisodeClickTracker() {
    if (typeof document === 'undefined' || global.__dsubPrimeClickBound) return;
    global.__dsubPrimeClickBound = true;

    document.addEventListener(
      'click',
      (e) => {
        const target = e.target;
        if (!target || typeof target.closest !== 'function') return;
        if (target.closest('#danime-sub-overlay, #danime-sub-fab, #danime-sub-panel')) return;

        let clickedInfo = null;
        const card = target.closest('[id^="av-ep-episode-"], [data-testid="episode-list-item"]');
        if (card) {
          clickedInfo = extractEpisodeFromCard(card);
        } else {
          const playTrigger = target.closest(
            '[data-testid="dp-atf-play-button"], [data-testid*="playbutton"], .fbl-play-btn'
          );
          if (playTrigger) {
            const hrefDetailId = extractDetailId(playTrigger.getAttribute('href') || '');
            clickedInfo = findEpisodeCardByDetailId(hrefDetailId);
            if (!clickedInfo) {
              const btnText = `${playTrigger.getAttribute('aria-label') || ''} ${playTrigger.textContent || ''}`.trim();
              const epStr = parsePrimeEpisode(btnText);
              if (epStr) {
                clickedInfo = {
                  episodeNumber: Number(epStr),
                  partDispNumber: epStr,
                  partTitle: '',
                  detailId: hrefDetailId,
                };
              }
            }
          }
        }

        if (!clickedInfo || clickedInfo.episodeNumber == null) return;

        const record = {
          ...clickedInfo,
          workTitle: extractTitleRaw(),
          searchKind: detectSearchKind(),
          path: global.location.pathname,
          ts: Date.now(),
        };
        lastClickedEpisode = record;
        writeCachedEpisode(record);
        try {
          global.dispatchEvent(new CustomEvent('dsub:prime-episode-click', { detail: record }));
        } catch (_) {}
      },
      true
    );
  }

  setupEpisodeClickTracker();

  function extractMetadata(helpers = {}) {
    const rawTitle = extractTitleRaw();
    const cleanTitle =
      typeof helpers.cleanWorkTitle === 'function' ? helpers.cleanWorkTitle(rawTitle) : rawTitle;
    const subtitle = document.querySelector('.atvwebplayersdk-subtitle-text')?.textContent?.trim() || '';
    const subtitleEp = parsePrimeEpisode(subtitle);
    const currentDetailId = extractDetailId(global.location.pathname);
    const domSearchKind = detectSearchKind();

    let epStr = subtitleEp || '';
    let partTitle = subtitle;
    let resolvedSearchKind = domSearchKind;

    if (subtitleEp) {
      // Keep click tracker aligned if Prime's HUD advances to the next episode automatically.
      lastClickedEpisode = {
        episodeNumber: Number(subtitleEp),
        partDispNumber: subtitleEp,
        partTitle: subtitle,
        workTitle: rawTitle,
        searchKind: domSearchKind,
        detailId: currentDetailId,
        path: global.location.pathname,
        ts: Date.now(),
      };
    } else {
      const cached =
        lastClickedEpisode ||
        readCachedEpisode();
      const now = Date.now();
      const cacheValid =
        cached &&
        cached.episodeNumber != null &&
        now - (cached.ts || 0) < 30 * 60 * 1000 &&
        ((currentDetailId && cached.detailId === currentDetailId) ||
          (cached.path === global.location.pathname && cached.workTitle === rawTitle) ||
          (rawTitle && cached.workTitle === rawTitle && now - (cached.ts || 0) < 15 * 1000));

      if (cacheValid) {
        epStr = String(cached.episodeNumber);
        partTitle = partTitle || cached.partTitle || '';
        resolvedSearchKind = resolvedSearchKind || cached.searchKind || null;
      } else {
        const fromDom = extractEpisodeFromPageDom(currentDetailId);
        if (fromDom && fromDom.episodeNumber != null) {
          epStr = String(fromDom.episodeNumber);
          partTitle = partTitle || fromDom.partTitle || '';
        }
      }
    }

    return {
      partId: global.location.pathname + global.location.search,
      workTitle: rawTitle,
      cleanTitle,
      partDispNumber: epStr,
      partTitle,
      episodeNumber: epStr ? Number(epStr) : null,
      searchKind: resolvedSearchKind,
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
    parsePrimeEpisode,

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
