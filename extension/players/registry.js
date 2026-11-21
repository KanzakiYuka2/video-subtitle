/**
 * Player Adapter Registry
 * Provides a clean extension point so contributors can support new streaming sites
 * by registering an adapter in `extension/players/<site>.js` without editing core code.
 */
(function (global) {
  const adapters = [];

  const genericAdapter = {
    id: 'generic',
    name: 'HTML5 Video',
    defaultSearchKind: 'anime',
    autoSearchOnLoad: false,
    resetOnNavigation: true,
    pollMetadata: false,
    alwaysResolveVideo: false,
    uiClass: '',
    matches: () => true,
    getVideo() {
      const videos = Array.from(document.querySelectorAll('video'));
      const visible = videos.filter((video) => {
        const rect = video.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(video).visibility !== 'hidden';
      });
      return visible[0] || videos[0] || null;
    },
    async detectWorkInfo({ cleanWorkTitle }) {
      const title = cleanWorkTitle ? cleanWorkTitle(document.title) : document.title;
      return {
        partId: location.pathname + location.search,
        workTitle: document.title,
        cleanTitle: title,
        partDispNumber: '',
        partTitle: '',
        episodeNumber: null,
      };
    },
  };

  function register(adapter) {
    if (!adapter || !adapter.id || typeof adapter.matches !== 'function') {
      throw new Error('Player adapter must provide `id` and `matches(loc)`.');
    }
    const existingIdx = adapters.findIndex((a) => a.id === adapter.id);
    if (existingIdx !== -1) {
      adapters[existingIdx] = adapter;
    } else {
      adapters.push(adapter);
    }
  }

  function getAdapters() {
    return [...adapters];
  }

  function getActiveAdapter(loc = global.location) {
    return adapters.find((adapter) => {
      try {
        return Boolean(adapter.matches(loc));
      } catch (_) {
        return false;
      }
    }) || genericAdapter;
  }

  global.SubtitlePlayerRegistry = {
    register,
    getAdapters,
    getActiveAdapter,
    genericAdapter,
  };

  // Backwards-compatible facade used by content.js and browser test suites
  global.SubtitlePlayer = {
    get activeAdapter() {
      return getActiveAdapter();
    },
    get isPrime() {
      return getActiveAdapter().id === 'prime';
    },
    getVideo() {
      return getActiveAdapter().getVideo();
    },
    primeInfo() {
      const prime = adapters.find((a) => a.id === 'prime');
      return prime && typeof prime.extractMetadata === 'function' ? prime.extractMetadata() : {};
    },
    detectWorkInfo(helpers) {
      return getActiveAdapter().detectWorkInfo(helpers);
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
