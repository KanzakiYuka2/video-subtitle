/* Site-specific player selection and best-effort Prime metadata. */
(function () {
  const isPrime = /(^|\.)(primevideo\.com|amazon\.co\.jp)$/.test(location.hostname);

  function getVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    const visible = videos.filter((video) => {
      const rect = video.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(video).visibility !== 'hidden';
    });
    // Prime can retain hidden preview players. Prefer the largest visible player.
    return visible.sort((a, b) => {
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    })[0] || (isPrime ? null : videos[0]) || null;
  }

  function primeInfo() {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() || '';
    const title = text('.atvwebplayersdk-title-text') || text('[data-testid="title"]');
    const subtitle = text('.atvwebplayersdk-subtitle-text');
    const normalized = subtitle.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const episode = normalized.match(/(?:第\s*(\d+)\s*話|(?:Episode|Ep\.?|E)\s*(\d+)\b)/i);
    return {
      partId: location.pathname + location.search,
      workTitle: title,
      cleanTitle: title,
      partDispNumber: episode ? (episode[1] || episode[2]) : '',
      partTitle: subtitle,
      episodeNumber: episode ? Number(episode[1] || episode[2]) : null,
    };
  }
  window.SubtitlePlayer = { isPrime, getVideo, primeInfo };
})();
