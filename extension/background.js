/**
 * Background Service Worker for d-anime Subtitle Assistant
 * Handles cross-origin API requests to:
 *  - Jimaku.cc API (search entries, list episode files, download subtitle file)
 *  - AniList GraphQL API (Japanese/partial title -> anilist_id + romaji/english/native lookup)
 *  - Local AI Whisper Server (http://127.0.0.1:8765)
 */

const JIMAKU_BASE = 'https://jimaku.cc/api';
const ANILIST_URL = 'https://graphql.anilist.co';
const DEFAULT_AI_SERVER = 'http://127.0.0.1:8765';

const DEFAULT_PREFERRED_SOURCE =
  'ABEMA,DMMTV,U-NEXT,UNEXT,Amazon,AMZN,Prime,Netflix,NF,NanakoRaws,NanokoRaws,shincaps,WebRip,BD';

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      {
        jimakuApiKey: '',
        aiServerUrl: DEFAULT_AI_SERVER,
        fontScale: 3.2, // Relative to video/viewport height (%)
        bottomPosition: 10,
        bgOpacity: 0.0,
        textColor: '#ffffff',
        autoSearchApply: true,
        preferredFormat: 'ass,srt,vtt',
        preferredSource: DEFAULT_PREFERRED_SOURCE,
      },
      (items) => resolve(items)
    );
  });
}

const KANJI_NUMS = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
const ROMAN_NUMS = {
  ii: 2, iii: 3, iv: 4, v: 5, vi: 6, 'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5,
};

/**
 * Normalize full-width digits/alphabets to half-width
 */
function toHalfWidth(str) {
  if (!str) return '';
  return str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) =>
    String.fromCharCode(s.charCodeAt(0) - 0xfee0)
  );
}

/**
 * Clean d-anime specific suffixes/decorations from work title
 * e.g. "生徒会にも穴はある！ 【規制解除版】" -> "生徒会にも穴はある！"
 */
function normalizeAnimeTitle(rawTitle) {
  if (!rawTitle) return '';
  return rawTitle
    .replace(/【.*?】|\[.*?\]|（.*?版.*?）|\(.*?版.*?\)|＜.*?版.*?＞/g, ' ')
    .replace(/（吹替）|（字幕）|（テレビ放送版）|（オンエア版）|（完全版）/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract explicit season number from an anime title if present:
 * e.g. "佐々木とピーちゃん シーズン2" -> 2
 *      "佐々木とピーちゃんSeason2" -> 2
 *      "推しの子 第2期" -> 2
 *      "オーバーロードIV" -> 4
 *      "生徒会にも穴はある！" -> 1 (default)
 */
function detectSeasonNumber(title) {
  if (!title) return 1;
  const hw = toHalfWidth(title);

  // 1. Season X / シーズン X / 第X期 / X期 / S2 / 2nd Season
  const m1 = hw.match(
    /(?:Season|シーズン|第)\s*(\d+)\s*期?|(\d+)\s*(?:期|nd\s*Season|rd\s*Season|th\s*Season)|\bS(\d+)\b/i
  );
  if (m1) {
    return parseInt(m1[1] || m1[2] || m1[3], 10);
  }

  // 2. Kanji season: 第二期 / 第2シーズン
  const m2 = hw.match(/第([一二三四五六七八九十])(?:期|シーズン)/);
  if (m2 && KANJI_NUMS[m2[1]]) {
    return KANJI_NUMS[m2[1]];
  }

  // 3. Roman numerals at the end of title: II, III, IV, Ⅱ, Ⅲ
  const m3 = hw.match(/(?:\s+|[^\w])(II|III|IV|V|VI|Ⅱ|Ⅲ|Ⅳ|Ⅴ)\s*$/i);
  if (m3) {
    const key = m3[1].toLowerCase();
    if (ROMAN_NUMS[key] || ROMAN_NUMS[m3[1]]) {
      return ROMAN_NUMS[key] || ROMAN_NUMS[m3[1]];
    }
  }

  // 4. Trailing standalone number like "タイトル 2"
  const m4 = hw.match(/\s+(\d)\s*$/);
  if (m4) {
    return parseInt(m4[1], 10);
  }

  return 1;
}

/**
 * Extract base title without season suffix for broader AniList / Jimaku matching
 * e.g. "佐々木とピーちゃんSeason2" -> "佐々木とピーちゃん"
 */
function stripSeasonSuffix(title) {
  if (!title) return '';
  const hw = toHalfWidth(title);
  return hw
    .replace(
      /\s*(?:第[0-9一二三四五六七八九十]+(?:期|シーズン)|(?:Season|シーズン)\s*\d+|\d+\s*期|\bS\d+\b|\d+(?:nd|rd|th)\s*Season|(?:II|III|IV|Ⅱ|Ⅲ|Ⅳ))\s*$/i,
      ''
    )
    .replace(/[！!？?〜～\-－:：]+$/g, '')
    .trim();
}

async function searchAniList(searchQuery) {
  const query = `
    query ($search: String) {
      Page(page: 1, perPage: 10) {
        media(search: $search, type: ANIME, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
          id
          format
          title {
            native
            romaji
            english
          }
          synonyms
          seasonYear
          episodes
        }
      }
    }
  `;
  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables: { search: searchQuery } }),
  });
  if (!res.ok) return [];
  const json = await res.json();
  const list = json?.data?.Page?.media || [];
  const mainList = list.filter(
    (m) => m.format !== 'MUSIC' && !/\bPV\b|\bCM\b/i.test(m.title?.romaji || '')
  );
  return mainList.length > 0 ? mainList : list;
}

/**
 * Check if an entry or AniList media object matches the target season number
 */
function scoreSeasonMatch(titlesArray, targetSeason) {
  const combined = titlesArray.filter(Boolean).join(' ');
  const detected = detectSeasonNumber(combined);
  if (targetSeason > 1) {
    // User explicitly wants Season 2+ -> strongly reward matching season, penalize Season 1!
    return detected === targetSeason ? 500 : -300;
  } else {
    // User wants Season 1 -> reward Season 1, penalize Season 2+
    return detected === 1 ? 200 : -200;
  }
}

/**
 * Multi-stage Season-Aware fuzzy search on Jimaku.cc:
 * 1. Detect targetSeason (e.g. Season 2 vs Season 1) and baseTitle ("佐々木とピーちゃん")
 * 2. Search AniList by baseTitle AND cleanTitle so we get all seasons (S1, S2, etc.), then sort by season match!
 * 3. Search Jimaku by `anilist_id` AND by `query` (cleanTitle + baseTitle), then rank entries by season match!
 */
async function jimakuSearch(rawTitle, apiKey) {
  if (!apiKey) {
    throw new Error('Jimaku APIキーが設定されていません。パネルの「⚙ 設定」から登録してください。');
  }
  const headers = {
    Authorization: apiKey.trim(),
    Accept: 'application/json',
  };

  const cleanTitle = normalizeAnimeTitle(rawTitle);
  const targetSeason = detectSeasonNumber(cleanTitle);
  const baseTitle = stripSeasonSuffix(cleanTitle) || cleanTitle;

  const collectedEntries = [];
  const seenIds = new Set();

  const addEntries = (arr, matchSource) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (item && item.id && !seenIds.has(item.id)) {
        seenIds.add(item.id);
        const entrySeasonScore = scoreSeasonMatch(
          [item.japanese_name, item.name, item.english_name],
          targetSeason
        );
        collectedEntries.push({
          ...item,
          _matchSource: matchSource,
          _seasonScore: entrySeasonScore,
        });
      }
    }
  };

  // Query AniList (using baseTitle so full franchise/seasons are returned!) and Jimaku in parallel
  const queriesToRun = [
    searchAniList(baseTitle).catch(() => []),
    fetch(`${JIMAKU_BASE}/entries/search?query=${encodeURIComponent(cleanTitle)}`, { headers }).catch(() => null),
  ];
  if (baseTitle !== cleanTitle) {
    queriesToRun.push(
      fetch(`${JIMAKU_BASE}/entries/search?query=${encodeURIComponent(baseTitle)}`, { headers }).catch(() => null)
    );
  }

  const [anilistMedia, directRes, baseRes] = await Promise.all(queriesToRun);

  if (directRes) {
    if (directRes.status === 401 || directRes.status === 403) {
      throw new Error('Jimaku APIキーが無効です（401 Unauthorized）。設定を確認してください。');
    }
    if (directRes.ok) {
      addEntries(await directRes.json(), 'direct');
    }
  }
  if (baseRes && baseRes.ok) {
    addEntries(await baseRes.json(), 'base_query');
  }

  // Sort AniList media candidates so the matching season (e.g. Season 2) is queried FIRST
  let mediaList = Array.isArray(anilistMedia) ? [...anilistMedia] : [];
  if (mediaList.length === 0 && baseTitle !== cleanTitle) {
    mediaList = await searchAniList(cleanTitle).catch(() => []);
  }

  if (mediaList.length > 0) {
    mediaList.sort((a, b) => {
      const scoreA = scoreSeasonMatch(
        [a.title?.native, a.title?.romaji, a.title?.english, ...(a.synonyms || [])],
        targetSeason
      );
      const scoreB = scoreSeasonMatch(
        [b.title?.native, b.title?.romaji, b.title?.english, ...(b.synonyms || [])],
        targetSeason
      );
      return scoreB - scoreA;
    });

    const idPromises = mediaList.slice(0, 4).map((m) =>
      fetch(`${JIMAKU_BASE}/entries/search?anilist_id=${m.id}`, { headers })
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])
    );
    const idResults = await Promise.all(idPromises);
    for (const resArr of idResults) {
      addEntries(resArr, 'anilist_id');
    }
  }

  // Fallback: if still empty, try first keyword chunk or romaji/english title from AniList
  if (collectedEntries.length === 0) {
    const fallbackQueries = new Set();
    const firstPart = baseTitle.split(/[\s　！!？?〜～\-－:：・]/)[0];
    if (firstPart && firstPart.length >= 2 && firstPart !== cleanTitle) {
      fallbackQueries.add(firstPart);
    }
    if (mediaList && mediaList[0]) {
      if (mediaList[0].title?.romaji) fallbackQueries.add(mediaList[0].title.romaji);
      if (mediaList[0].title?.english) fallbackQueries.add(mediaList[0].title.english);
    }

    for (const q of Array.from(fallbackQueries).slice(0, 3)) {
      const r = await fetch(`${JIMAKU_BASE}/entries/search?query=${encodeURIComponent(q)}`, { headers }).catch(
        () => null
      );
      if (r && r.ok) {
        addEntries(await r.json(), 'fallback_query');
        if (collectedEntries.length > 0) break;
      }
    }
  }

  // Sort collected entries so the exact targetSeason match is ALWAYS #1
  collectedEntries.sort((a, b) => b._seasonScore - a._seasonScore);
  return collectedEntries;
}

/**
 * Extract episode number from a subtitle filename carefully
 */
function extractEpisodeFromFilename(filename) {
  if (!filename) return [];
  const cleaned = filename
    .replace(/\.(srt|ass|ssa|vtt)$/i, '')
    .replace(/\b(1080p|720p|480p|2160p|4K|10bit|8bit|x264|x265|h264|h265|hevc|aac|flac|ac3|eac3|assx2|mp4|mkv|mpeg2|at-x)\b/gi, '')
    .replace(/\b\d{3,4}x\d{3,4}\b/gi, '') // e.g. 1440x1080
    .replace(/\[\s*[0-9A-Fa-f]{8}\s*\]/g, '');

  const found = [];

  // 1. S01E02 or 01x02 pattern
  const seMatches = [...cleaned.matchAll(/\bS\d+\s*E(\d{1,3})\b/gi)];
  if (seMatches.length > 0) {
    return seMatches.map((m) => parseInt(m[1], 10));
  }

  // 2. 第02話 or 02話
  const jaMatches = [...cleaned.matchAll(/第?\s*(\d{1,3})\s*話/g)];
  if (jaMatches.length > 0) {
    return jaMatches.map((m) => parseInt(m[1], 10));
  }

  // 3. E02 / EP02 / Episode 02
  const epMatches = [...cleaned.matchAll(/(?:^|[\s._\-[])(?:EP?|Episode)\s*(\d{1,3})(?:$|[\s._\-\]v])/gi)];
  if (epMatches.length > 0) {
    return epMatches.map((m) => parseInt(m[1], 10));
  }

  // 4. " - 02 " or " - 02v2"
  const dashMatches = [...cleaned.matchAll(/\s-\s*(\d{1,3})(?:v\d+)?(?:$|[\s._\-[(\]])/g)];
  if (dashMatches.length > 0) {
    return dashMatches.map((m) => parseInt(m[1], 10));
  }

  // 5. Standalone [02] or .02. or _02_
  const bracketMatches = [...cleaned.matchAll(/(?:[._\-[])\s*(\d{1,3})(?:v\d+)?\s*(?:[._\-]|\])/g)];
  for (const m of bracketMatches) {
    const n = parseInt(m[1], 10);
    if (n > 0 && n < 1900) found.push(n);
  }

  return found;
}

/**
 * Score & sort subtitle files:
 *  1. Named Streaming Service / Source Priority (Netflix, ABEMA, DMMTV, Prime, U-NEXT...) takes PRIMARY precedence
 *     when matched! (Generic tags like WebRip/BD act as secondary tie-breakers)
 *  2. Format Priority (ASS vs SRT)
 *  3. Pure Japanese track bonus (penalize bilingual [CHS, JPN] / [CHT, JPN] so dual-language Chinese+Japanese subs don't beat pure JPN subs!)
 */
function filterAndRankFiles(files, targetEpisode, preferredFormatStr, preferredSourceStr) {
  const validFiles = (files || []).filter((f) => /\.(srt|ass|ssa|vtt)$/i.test(f.name || ''));
  if (validFiles.length === 0) return [];

  const formatOrder = (preferredFormatStr || 'ass,srt,vtt')
    .toLowerCase()
    .split(/[,、\s]+/)
    .map((s) => s.replace(/^\./, '').trim())
    .filter(Boolean);

  const sourceOrder = (preferredSourceStr || DEFAULT_PREFERRED_SOURCE)
    .toLowerCase()
    .split(/[,、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Built-in tier aliases so e.g. "Amazon" also matches "AMZN"/"Prime", "NanokoRaws" also matches "NanakoRaws", "U-NEXT" matches "UNEXT"
  const KEYWORD_ALIASES = {
    amazon: ['amazon', 'amzn', 'prime'],
    'u-next': ['u-next', 'unext'],
    netflix: ['netflix', '.nf.', '[nf]'],
    nanokoraws: ['nanokoraws', 'nanakoraws'],
    nanakoraws: ['nanakoraws', 'nanokoraws'],
    dmmtv: ['dmmtv', 'dmm'],
    abema: ['abema'],
    shincaps: ['shincaps'],
  };

  const genericTags = new Set(['webrip', 'web-dl', 'web', 'bd', 'bdrip', 'bluray', 'tv', 'at-x']);

  // Check if we have exact episode matches
  let candidateFiles = validFiles;
  let hasExactEpisodeMatch = false;

  if (targetEpisode != null && targetEpisode > 0) {
    const epMatches = validFiles.filter((f) => {
      const eps = extractEpisodeFromFilename(f.name || '');
      return eps.includes(Number(targetEpisode));
    });
    if (epMatches.length > 0) {
      candidateFiles = epMatches;
      hasExactEpisodeMatch = true;
    }
  }

  const scored = candidateFiles.map((file) => {
    const name = file.name || '';
    const lower = name.toLowerCase();
    const extMatch = lower.match(/\.(srt|ass|ssa|vtt)$/i);
    let ext = extMatch ? extMatch[1].toLowerCase() : '';
    if (ext === 'ssa') ext = 'ass';

    // 1. Source keyword score:
    // Named streaming platforms / release groups (Platinum: ABEMA, DMMTV, U-NEXT, Amazon -> Gold: Netflix -> Silver: NanokoRaws -> Bronze: shincaps)
    // get primary weight (1000+) in exact user-specified order.
    let sourceScore = 0;
    for (let i = 0; i < sourceOrder.length; i++) {
      const kw = sourceOrder[i];
      if (!kw) continue;
      const patterns = KEYWORD_ALIASES[kw] || [kw];
      const matched = patterns.some((p) => lower.includes(p));
      if (matched) {
        const rankWeight = sourceOrder.length - i;
        if (!genericTags.has(kw)) {
          sourceScore = 1000 + rankWeight * 80;
          break;
        } else if (sourceScore === 0) {
          sourceScore = rankWeight * 5;
        }
      }
    }

    // 2. Format score (ASS vs SRT)
    let formatRank = formatOrder.indexOf(ext);
    if (formatRank === -1) formatRank = formatOrder.length;
    const formatScore = (formatOrder.length - formatRank) * 100;

    // 3. Language purity score:
    // Penalize dual-language Chinese+Japanese files like "[CHS, JPN]" or "CHS_JPN"
    // so pure Japanese files ("[JPN]", ".ja[cc]", ".ja.") always rank higher!
    let langScore = 0;
    if (/\b(chs|cht|sc|tc|zh|chi)\b/i.test(lower)) {
      langScore = -150;
    } else if (/\.ja\b|\[jpn\]|\[ja\]/i.test(lower)) {
      langScore = 30;
    }

    const totalScore = sourceScore + formatScore + langScore;
    return {
      ...file,
      _score: totalScore,
      _exactEpisode: hasExactEpisodeMatch,
    };
  });

  scored.sort((a, b) => b._score - a._score || (a.name || '').localeCompare(b.name || ''));
  return scored;
}

async function jimakuGetFiles(entryId, episodeNumber, apiKey, settings) {
  if (!apiKey) {
    throw new Error('Jimaku APIキーが設定されていません。');
  }
  const headers = {
    Authorization: apiKey.trim(),
    Accept: 'application/json',
  };

  let files = [];
  if (episodeNumber != null && episodeNumber > 0) {
    const epUrl = `${JIMAKU_BASE}/entries/${entryId}/files?episode=${encodeURIComponent(episodeNumber)}`;
    const epRes = await fetch(epUrl, { headers });
    if (epRes.ok) {
      files = await epRes.json();
    }
  }

  // Fallback to all files in the entry if episode filter returned nothing
  if (!Array.isArray(files) || files.length === 0) {
    const allUrl = `${JIMAKU_BASE}/entries/${entryId}/files`;
    const allRes = await fetch(allUrl, { headers });
    if (!allRes.ok) {
      throw new Error(`ファイル一覧の取得に失敗しました (${allRes.status})`);
    }
    files = await allRes.json();
  }

  return filterAndRankFiles(
    files,
    episodeNumber,
    settings.preferredFormat,
    settings.preferredSource
  );
}

async function downloadSubtitleText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`字幕ファイルのダウンロードに失敗しました (${res.status})`);
  }
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let encoding = 'utf-8';
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  }
  const decoder = new TextDecoder(encoding);
  return decoder.decode(buffer);
}

async function checkAiServer(serverUrl) {
  const base = (serverUrl || DEFAULT_AI_SERVER).replace(/\/+$/, '');
  const res = await fetch(`${base}/health`, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function transcribeChunk(base64Wav, serverUrl, language = 'ja', prompt = '') {
  const base = (serverUrl || DEFAULT_AI_SERVER).replace(/\/+$/, '');
  const res = await fetch(`${base}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio_base64: base64Wav,
      language,
      initial_prompt: prompt,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`AI Server Error (${res.status}): ${errText}`);
  }
  return await res.json();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      const settings = await getSettings();

      switch (message.type) {
        case 'JIMAKU_SEARCH': {
          const apiKey = message.apiKey || settings.jimakuApiKey;
          const entries = await jimakuSearch(message.title, apiKey);
          sendResponse({ ok: true, entries });
          break;
        }

        case 'JIMAKU_FILES': {
          const apiKey = message.apiKey || settings.jimakuApiKey;
          const files = await jimakuGetFiles(
            message.entryId,
            message.episode,
            apiKey,
            {
              preferredFormat: message.preferredFormat ?? settings.preferredFormat,
              preferredSource: message.preferredSource ?? settings.preferredSource,
            }
          );
          sendResponse({ ok: true, files });
          break;
        }

        case 'JIMAKU_DOWNLOAD': {
          const text = await downloadSubtitleText(message.url);
          sendResponse({ ok: true, text });
          break;
        }

        case 'AI_HEALTH': {
          const serverUrl = message.serverUrl || settings.aiServerUrl;
          const info = await checkAiServer(serverUrl);
          sendResponse({ ok: true, info });
          break;
        }

        case 'AI_TRANSCRIBE': {
          const serverUrl = message.serverUrl || settings.aiServerUrl;
          const result = await transcribeChunk(
            message.audioBase64,
            serverUrl,
            message.language || 'ja',
            message.prompt || ''
          );
          sendResponse({ ok: true, result });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      sendResponse({
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  })();
  return true;
});
