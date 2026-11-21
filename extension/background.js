/**
 * Background Service Worker for Multi-Platform Video Subtitle Assistant
 * Handles cross-origin API requests to:
 *  - AniList GraphQL API (franchise chain resolution, season & split-cour episode mapping)
 *  - Jimaku.cc API (multi-entry search, full file list caching, episode/subtitle matching, source tier ranking)
 */

const JIMAKU_BASE = 'https://jimaku.cc/api';
const ANILIST_URL = 'https://graphql.anilist.co';

function createCodedError(errorCode, message, errorStatus = null) {
  const err = new Error(message);
  err.errorCode = errorCode;
  if (errorStatus != null) err.errorStatus = errorStatus;
  return err;
}

const DEFAULT_SOURCE_PROFILES = [
  { id: 'abema', name: 'ABEMA', offset: 0.0, locked: false },
  { id: 'dmmtv', name: 'DMMTV', offset: 0.0, locked: false },
  { id: 'u-next', name: 'U-NEXT', offset: 0.0, locked: false },
  { id: 'amazon', name: 'Amazon', offset: 0.0, locked: false },
  { id: 'other', name: 'Other', offset: 0.0, locked: true },
  { id: 'netflix', name: 'Netflix', offset: -1.0, locked: false },
  { id: 'nanokoraws', name: 'NanokoRaws', offset: 0.0, locked: false },
  { id: 'shincaps', name: 'shincaps', offset: 0.0, locked: false },
];

const DEFAULT_PREFERRED_SOURCE = DEFAULT_SOURCE_PROFILES.map((p) => p.name).join(',');

function normalizeSourceProfiles(profiles, legacyPreferredSource, legacyNetflixOffset) {
  const nfDefault = Number.isFinite(Number(legacyNetflixOffset)) ? Number(legacyNetflixOffset) : -1.0;

  let list = [];
  if (Array.isArray(profiles) && profiles.length > 0) {
    list = profiles
      .filter((p) => p && (p.id || p.name))
      .map((p) => {
        const rawId = String(p.id || p.name).trim().toLowerCase();
        const isOther = rawId === 'other' || rawId === 'その他';
        const id = isOther ? 'other' : rawId;
        const name = isOther ? 'Other' : String(p.name || p.id).trim();
        const off = isOther ? 0.0 : (Number.isFinite(Number(p.offset)) ? Math.round(Number(p.offset) * 10) / 10 : 0.0);
        return { id, name, offset: off, locked: isOther };
      });
  } else if (typeof legacyPreferredSource === 'string' && legacyPreferredSource.trim()) {
    const tokens = legacyPreferredSource
      .split(/[,、\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const seen = new Set();
    for (const tok of tokens) {
      const lower = tok.toLowerCase();
      const id = lower === 'その他' ? 'other' : lower;
      if (seen.has(id)) continue;
      seen.add(id);
      const isOther = id === 'other';
      const defaultMatch = DEFAULT_SOURCE_PROFILES.find((d) => d.id === id);
      list.push({
        id,
        name: isOther ? 'Other' : (defaultMatch ? defaultMatch.name : tok),
        offset: isOther ? 0.0 : (id === 'netflix' ? nfDefault : 0.0),
        locked: isOther,
      });
    }
  } else {
    list = DEFAULT_SOURCE_PROFILES.map((p) => ({
      ...p,
      offset: p.id === 'netflix' ? nfDefault : p.offset,
    }));
  }

  // Ensure unique IDs and ensure `Other` is always present, locked, and offset 0.0
  const deduped = [];
  const seenIds = new Set();
  let hasOther = false;
  for (const item of list) {
    if (!item.id || seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    if (item.id === 'other') {
      hasOther = true;
      deduped.push({ id: 'other', name: 'Other', offset: 0.0, locked: true });
    } else {
      deduped.push(item);
    }
  }
  if (!hasOther) {
    deduped.push({ id: 'other', name: 'Other', offset: 0.0, locked: true });
  }
  return deduped;
}

// In-memory session caches to respect Jimaku 25 req/min rate limit & speed up episode switching
const ANILIST_CACHE = new Map(); // query -> mediaList
const JIMAKU_SEARCH_CACHE = new Map(); // queryKey -> entries
const JIMAKU_FILES_CACHE = new Map(); // entryId -> raw files array
const CACHE_TTL_MS = 10 * 60 * 1000;

function getCache(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function setCache(map, key, value) {
  map.set(key, { ts: Date.now(), value });
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      {
        jimakuApiKey: '',
        fontScale: 4.5,
        bottomPosition: 5,
        bgOpacity: 0.0,
        textColor: '#ffffff',
        autoSearchApply: true,
        preferredFormat: 'ass,srt,vtt',
        sourceProfiles: null,
        preferredSource: DEFAULT_PREFERRED_SOURCE,
        netflixDefaultOffsetSec: -1.0,
      },
      (items) => {
        items.sourceProfiles = normalizeSourceProfiles(
          items.sourceProfiles,
          items.preferredSource,
          items.netflixDefaultOffsetSec
        );
        resolve(items);
      }
    );
  });
}

const KANJI_NUMS = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
const ROMAN_NUMS = {
  ii: 2, iii: 3, iv: 4, v: 5, vi: 6, 'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5,
};

function toHalfWidth(str) {
  if (!str) return '';
  return str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) =>
    String.fromCharCode(s.charCodeAt(0) - 0xfee0)
  );
}

/**
 * Clean d-anime edition/broadcast tag brackets while preserving actual title brackets like 【推しの子】.
 * Also handles `テレビアニメ「Title」ArcName` and parenthesized season labels like `（第2期）`.
 */
function cleanTitleVariants(rawTitle) {
  if (!rawTitle) return { cleanTitle: '', baseTitle: '', queries: [] };

  let s = rawTitle.trim();
  // Strip edition/release tags only, keeping title brackets like 【推しの子】
  s = s
    .replace(/【[^】]*(?:版|放送|配信|ver|限定|特典|吹替|字幕|年齢|R\d+|禁|Web)[^】]*】/gi, ' ')
    .replace(/\[[^\]]*(?:版|放送|配信|ver|限定|特典|吹替|字幕|年齢|R\d+|禁|Web)[^\]]*\]/gi, ' ')
    .replace(/[（(＜<][^）)＞>]*(?:版|吹替|字幕|放送|オンエア)[^）)＞>]*[）)＞>]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let cleanTitle = s;
  const queries = [];

  // Handle テレビアニメ「鬼滅の刃」竈門炭治郎 立志編 / 遊郭編
  const tvMatch = s.match(/^(?:テレビアニメ|TVアニメ)\s*「([^」]+)」\s*(.*)$/i);
  if (tvMatch) {
    const core = tvMatch[1].trim();
    const arc = tvMatch[2].trim();
    const isFirstArc = !arc || /竈門炭治郎\s*立志編/.test(arc);
    cleanTitle = isFirstArc ? core : `${core} ${arc}`.trim();
    if (core) queries.push(core);
    if (cleanTitle && !queries.includes(cleanTitle)) queries.push(cleanTitle);
    return { cleanTitle, baseTitle: core, queries };
  }

  // Unwrap parenthesized season like （第2期） or (Season 2)
  const unparen = s
    .replace(
      /[（(]\s*(第[0-9０-９一二三四五六七八九十]+(?:期|シーズン)|Season\s*\d+|\d+(?:nd|rd|th)\s*Season)\s*[）)]/gi,
      ' $1'
    )
    .replace(/\s+/g, ' ')
    .trim();
  cleanTitle = unparen;

  // Base title without season/cour suffix for broad franchise lookup
  const hw = toHalfWidth(unparen);
  const baseTitle = hw
    .replace(
      /\s*(?:第[0-9一二三四五六七八九十]+(?:期|シーズン)|(?:Season|シーズン)\s*\d+|\d+\s*期|\bS\d+\b|\d+(?:nd|rd|th)\s*Season|(?<![A-Za-z])(?:II|III|IV|V|VI)(?![A-Za-z])|(?:Ⅱ|Ⅲ|Ⅳ|Ⅴ))\s*/gi,
      ' '
    )
    .replace(/[！!？?〜～\-－:：]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (baseTitle) queries.push(baseTitle);
  const parts = baseTitle.split(/[\s　]+/).filter(Boolean);
  if (parts.length >= 2 && parts[0].length >= 2 && !queries.includes(parts[0])) {
    queries.push(parts[0]);
  }
  if (unparen && !queries.includes(unparen)) {
    queries.push(unparen);
  }

  return { cleanTitle, baseTitle: baseTitle || cleanTitle, queries };
}

function normalizeAnimeTitle(rawTitle) {
  return cleanTitleVariants(rawTitle).cleanTitle;
}

/**
 * Detect explicit season number while ignoring Part / Cour / クール indicators.
 * Returns { hasExplicitSeason: boolean, seasonNumber: number }.
 */
function detectExplicitSeason(title) {
  if (!title) return { hasExplicitSeason: false, seasonNumber: 1 };
  const hw = toHalfWidth(title);
  const hwNoCour = hw
    .replace(/(?:Part\.?\s*\d+|Cour\s*\d+|第\s*\d+\s*クール|\d+\s*クール)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const m1 = hwNoCour.match(
    /(?:Season|シーズン|第)\s*(\d+)\s*(?:期|シーズン)?|(\d+)\s*(?:期|nd\s*Season|rd\s*Season|th\s*Season)|\bS(\d+)\b/i
  );
  if (m1) {
    return {
      hasExplicitSeason: true,
      seasonNumber: parseInt(m1[1] || m1[2] || m1[3], 10),
    };
  }

  const m2 = hwNoCour.match(/第([一二三四五六七八九十])(?:期|シーズン)/);
  if (m2 && KANJI_NUMS[m2[1]]) {
    return { hasExplicitSeason: true, seasonNumber: KANJI_NUMS[m2[1]] };
  }

  const m3 = hwNoCour.match(/(?<![A-Za-z])(II|III|IV|V|VI)(?![A-Za-z])|(Ⅱ|Ⅲ|Ⅳ|Ⅴ)/);
  if (m3) {
    const k = m3[1] || m3[2];
    const num = ROMAN_NUMS[k.toLowerCase()] || ROMAN_NUMS[k];
    if (num) return { hasExplicitSeason: true, seasonNumber: num };
  }

  const m4 = hwNoCour.match(/(?:！|!|\s)(\d)\s*$/);
  if (m4) {
    return { hasExplicitSeason: true, seasonNumber: parseInt(m4[1], 10) };
  }

  return { hasExplicitSeason: false, seasonNumber: 1 };
}

function detectSeasonNumber(title) {
  return detectExplicitSeason(title).seasonNumber;
}

function isCourContinuation(title) {
  if (!title) return false;
  const hw = toHalfWidth(title);
  return /(?:Part\.?\s*[2-9]|Cour\s*[2-9]|第\s*[2-9]\s*クール|[2-9]\s*クール|完結編|後編)/i.test(hw);
}

const SPINOFF_TITLE_RE =
  /ミニアニメ|猫猫のひとりごと|●●の魔法|よくわかる|転スラ日記|コラボ|ぷれあです|ちびキャラ|\bPV\b|\bCM\b/i;

async function searchAniList(searchQuery) {
  const cached = getCache(ANILIST_CACHE, searchQuery);
  if (cached) return cached;

  const query = `
    query ($search: String) {
      Page(page: 1, perPage: 15) {
        media(search: $search, type: ANIME, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
          id
          format
          episodes
          seasonYear
          startDate { year month day }
          title {
            native
            romaji
            english
          }
          synonyms
          relations {
            edges {
              relationType(version: 2)
              node {
                id
                type
                format
                episodes
                seasonYear
                startDate { year month day }
                title {
                  native
                  romaji
                  english
                }
              }
            }
          }
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
  const mainList = list.filter((m) => {
    const t = `${m.title?.native || ''} ${m.title?.romaji || ''}`;
    return ['TV', 'TV_SHORT', 'ONA'].includes(m.format) && !SPINOFF_TITLE_RE.test(t);
  });
  const result = mainList.length > 0 ? mainList : list.filter((m) => m.format !== 'MUSIC');
  setCache(ANILIST_CACHE, searchQuery, result);
  return result;
}

/**
 * Build chronological TV/TV_SHORT/ONA franchise chain using connected PREQUEL/SEQUEL edges.
 */
function buildAnnotatedChain(mediaList) {
  if (!Array.isArray(mediaList) || mediaList.length === 0) return [];

  const nodes = new Map();
  const adj = new Map(); // undirected over PREQUEL / SEQUEL so movies/OVAs in between still bridge seasons

  const addEdge = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };

  for (const m of mediaList) {
    nodes.set(m.id, m);
    for (const edge of m.relations?.edges || []) {
      const rt = edge.relationType;
      const n = edge.node;
      if (!n || n.type !== 'ANIME') continue;
      if (rt !== 'SEQUEL' && rt !== 'PREQUEL') continue;
      if (!nodes.has(n.id)) nodes.set(n.id, n);
      addEdge(m.id, n.id);
    }
  }

  // Start BFS from the top TV/ONA search match to capture the entire connected mainline chain
  const anchor =
    mediaList.find((m) => ['TV', 'TV_SHORT', 'ONA'].includes(m.format)) || mediaList[0];
  const visited = new Set([anchor.id]);
  const queue = [anchor.id];
  const rawChain = [];

  while (queue.length > 0) {
    const cid = queue.shift();
    const node = nodes.get(cid);
    if (!node) continue;

    const titleAll = `${node.title?.native || ''} ${node.title?.romaji || ''}`;
    if (
      ['TV', 'TV_SHORT', 'ONA'].includes(node.format) &&
      !SPINOFF_TITLE_RE.test(titleAll)
    ) {
      rawChain.push(node);
    }

    const neighbors = adj.get(cid);
    if (neighbors) {
      for (const nid of neighbors) {
        if (!visited.has(nid)) {
          visited.add(nid);
          queue.push(nid);
        }
      }
    }
  }

  // Chronological sort by broadcast startDate
  rawChain.sort((a, b) => {
    const sa = a.startDate || {};
    const sb = b.startDate || {};
    const ya = sa.year || a.seasonYear || 9999;
    const yb = sb.year || b.seasonYear || 9999;
    if (ya !== yb) return ya - yb;
    const ma = sa.month || 12;
    const mb = sb.month || 12;
    if (ma !== mb) return ma - mb;
    const da = sa.day || 31;
    const db = sb.day || 31;
    if (da !== db) return da - db;
    return a.id - b.id;
  });

  // Annotate cumulative episode ranges and season boundaries
  let cum = 0;
  let curSeason = 1;
  let seasonCumStart = 1;
  const annotated = [];

  for (let idx = 0; idx < rawChain.length; idx++) {
    const n = rawChain[idx];
    const eps = n.episodes || 0;
    const titlesStr = [n.title?.native, n.title?.romaji, n.title?.english]
      .filter(Boolean)
      .join(' ');
    const { hasExplicitSeason, seasonNumber } = detectExplicitSeason(titlesStr);

    if (idx === 0) {
      curSeason = 1;
      seasonCumStart = 1;
    } else if (hasExplicitSeason && seasonNumber >= curSeason) {
      if (seasonNumber > curSeason) {
        curSeason = seasonNumber;
        seasonCumStart = cum + 1;
      }
    } else if (!isCourContinuation(titlesStr)) {
      curSeason += 1;
      seasonCumStart = cum + 1;
    }

    annotated.push({
      id: n.id,
      title: n.title?.native || '',
      romaji: n.title?.romaji || '',
      english: n.title?.english || '',
      episodes: eps,
      cumStart: cum + 1,
      cumEnd: eps > 0 ? cum + eps : cum + 999,
      season: curSeason,
      seasonCumStart,
    });
    cum += eps;
  }

  return annotated;
}

/**
 * Resolve exact AniList target node, season, cumulative ep, season ep, and cour ep.
 */
async function resolveFranchiseAndEpisode(rawTitle, targetEpisode) {
  const { cleanTitle, baseTitle, queries } = cleanTitleVariants(rawTitle);
  let mediaList = [];
  for (const q of queries) {
    mediaList = await searchAniList(q).catch(() => []);
    if (mediaList.length > 0) break;
  }

  const chain = buildAnnotatedChain(mediaList);
  const { hasExplicitSeason, seasonNumber } = detectExplicitSeason(cleanTitle);

  if (chain.length === 0) {
    return {
      cleanTitle,
      baseTitle,
      queries,
      mediaList,
      chain: [],
      startNode: null,
      targetNode: null,
      seasonStartNode: null,
      season: seasonNumber,
      cumEp: targetEpisode || null,
      seasonEp: targetEpisode || null,
      courEp: targetEpisode || null,
      hasExplicitSeason,
      isBoundaryExtra: false,
    };
  }

  let startNode = chain[0];
  if (hasExplicitSeason) {
    const found = chain.find((c) => c.season === seasonNumber);
    if (found) startNode = found;
  } else {
    // Check if cleanTitle specifies a named arc (e.g. 遊郭編, 来訪者編, Final Season)
    const rootTokens = chain[0].title.split(/[\s　]+/).filter(Boolean);
    for (let i = 1; i < chain.length; i++) {
      const c = chain[i];
      const arcTokens = c.title
        .split(/[\s　]+/)
        .filter((tok) => tok.length >= 2 && !chain[0].title.includes(tok) && !rootTokens.includes(tok));
      if (arcTokens.length > 0 && arcTokens.every((tok) => cleanTitle.includes(tok))) {
        startNode = c;
        break;
      }
    }
  }

  const ep = Number(targetEpisode);
  const hasEp = Number.isFinite(ep) && ep > 0;
  let targetNode = startNode;
  let cumEp = hasEp ? ep : null;
  let seasonEp = hasEp ? ep : null;
  let courEp = hasEp ? ep : null;
  let isBoundaryExtra = false;

  if (hasEp) {
    if (
      !hasExplicitSeason &&
      startNode === chain[0] &&
      chain[0].episodes > 0 &&
      ep === chain[0].episodes + 1 &&
      chain.length > 1
    ) {
      // Ambiguous boundary (e.g., Ep 25 of a 24-ep Season 1: could be S1 extra recap or S2E01!)
      isBoundaryExtra = true;
    }

    let k = 0;
    if (ep >= startNode.cumStart) {
      const found = chain.find((c) => ep >= c.cumStart && ep <= c.cumEnd);
      if (found) targetNode = found;
      k = Math.max(0, ep - targetNode.cumStart);
    } else {
      const mappedCum = startNode.cumStart + ep - 1;
      const found = chain.find((c) => mappedCum >= c.cumStart && mappedCum <= c.cumEnd);
      if (found) targetNode = found;
      k = Math.max(0, mappedCum - targetNode.cumStart);
    }

    cumEp = targetNode.cumStart + k;
    courEp = k + 1;
    seasonEp = targetNode.cumStart - targetNode.seasonCumStart + k + 1;
  }

  const seasonStartNode =
    chain.find((c) => c.season === targetNode.season) || targetNode;

  return {
    cleanTitle,
    baseTitle,
    queries,
    mediaList,
    chain,
    startNode,
    targetNode,
    seasonStartNode,
    season: targetNode.season,
    cumEp,
    seasonEp,
    courEp,
    hasExplicitSeason,
    isBoundaryExtra,
  };
}

function scoreSeasonMatch(titlesArray, targetSeason) {
  const combined = titlesArray.filter(Boolean).join(' ');
  const detected = detectExplicitSeason(combined).seasonNumber;
  if (targetSeason > 1) {
    return detected === targetSeason ? 500 : -300;
  }
  return detected === 1 ? 200 : -200;
}

/**
 * Multi-stage Season & Franchise-Aware Search on Jimaku.cc
 */
async function jimakuSearch(rawTitle, apiKey, kind = 'anime', targetEpisode = null) {
  if (!apiKey) {
    throw createCodedError(
      'API_KEY_MISSING',
      'Jimaku API key is not set. Please register it in Settings.'
    );
  }
  const headers = {
    Authorization: apiKey.trim(),
    Accept: 'application/json',
  };

  // Live-action titles bypass AniList, preserving Prime Video's drama search.
  if (kind === 'drama') {
    const query = new URLSearchParams({ query: rawTitle.trim(), anime: 'false' });
    const response = await fetch(`${JIMAKU_BASE}/entries/search?${query}`, { headers });
    if (response.status === 401 || response.status === 403) {
      throw createCodedError(
        'UNAUTHORIZED',
        'Invalid Jimaku API key (401 Unauthorized). Check Settings.',
        response.status
      );
    }
    if (!response.ok) {
      throw createCodedError(
        'SEARCH_HTTP_ERROR',
        `Jimaku search error (${response.status})`,
        response.status
      );
    }
    const entries = await response.json();
    return { entries: Array.isArray(entries) ? entries : [], resolvedMeta: {} };
  }
  const resolved = await resolveFranchiseAndEpisode(rawTitle, targetEpisode);
  const cacheKey = `${resolved.cleanTitle}::${resolved.targetNode?.id || ''}::${resolved.isBoundaryExtra ? 'b' : ''}`;
  const cachedEntries = getCache(JIMAKU_SEARCH_CACHE, cacheKey);
  if (cachedEntries) {
    return {
      entries: cachedEntries,
      resolvedMeta: {
        targetEpisode: targetEpisode ? Number(targetEpisode) : null,
        season: resolved.season,
        cumEp: resolved.cumEp,
        seasonEp: resolved.seasonEp,
        courEp: resolved.courEp,
        hasExplicitSeason: resolved.hasExplicitSeason,
        isBoundaryExtra: resolved.isBoundaryExtra,
        targetAnilistId: resolved.targetNode?.id || null,
        seasonStartAnilistId: resolved.seasonStartNode?.id || null,
        rootAnilistId: resolved.chain[0]?.id || null,
        cleanTitle: resolved.cleanTitle,
      },
    };
  }

  const collectedEntries = [];
  const seenIds = new Set();

  const addEntries = (arr, matchSource) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (!item || !item.id || seenIds.has(item.id)) continue;
      seenIds.add(item.id);

      let rankScore = 0;
      const aid = item.anilist_id;

      if (resolved.isBoundaryExtra && resolved.chain.length > 1) {
        // Check Season 1 first (in case Ep 25 is a recap like Tensura), then Season 2 (like Kusuriya)!
        if (aid === resolved.chain[0].id) rankScore += 1100;
        else if (aid === resolved.targetNode?.id) rankScore += 1000;
      } else {
        if (resolved.targetNode && aid === resolved.targetNode.id) rankScore += 1200;
        else if (resolved.seasonStartNode && aid === resolved.seasonStartNode.id) rankScore += 950;
        else if (resolved.chain[0] && aid === resolved.chain[0].id) rankScore += 300;
      }

      rankScore += scoreSeasonMatch(
        [item.japanese_name, item.name, item.english_name],
        resolved.season
      );

      collectedEntries.push({
        ...item,
        _matchSource: matchSource,
        _rankScore: rankScore,
      });
    }
  };

  // Prioritize AniList IDs to query on Jimaku
  const idsToQuery = [];
  const pushUniqueId = (id) => {
    if (id && !idsToQuery.includes(id)) idsToQuery.push(id);
  };

  if (resolved.targetNode) pushUniqueId(resolved.targetNode.id);
  if (resolved.seasonStartNode) pushUniqueId(resolved.seasonStartNode.id);
  if (resolved.chain[0]) pushUniqueId(resolved.chain[0].id);
  for (const m of resolved.mediaList.slice(0, 3)) {
    pushUniqueId(m.id);
  }

  const idPromises = idsToQuery.slice(0, 4).map((id) =>
    fetch(`${JIMAKU_BASE}/entries/search?anilist_id=${id}`, { headers })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) {
          throw createCodedError(
            'UNAUTHORIZED',
            'Invalid Jimaku API key (401 Unauthorized). Check Settings.',
            r.status
          );
        }
        return r.ok ? r.json() : [];
      })
  );

  // Also run direct text search on cleanTitle (and baseTitle if needed)
  const textPromises = [
    fetch(`${JIMAKU_BASE}/entries/search?query=${encodeURIComponent(resolved.cleanTitle)}`, {
      headers,
    })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) {
          throw createCodedError(
            'UNAUTHORIZED',
            'Invalid Jimaku API key (401 Unauthorized). Check Settings.',
            r.status
          );
        }
        return r.ok ? r.json() : [];
      })
      .catch(() => []),
  ];

  if (resolved.baseTitle && resolved.baseTitle !== resolved.cleanTitle) {
    textPromises.push(
      fetch(`${JIMAKU_BASE}/entries/search?query=${encodeURIComponent(resolved.baseTitle)}`, {
        headers,
      })
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])
    );
  }

  const idResults = await Promise.all(idPromises);
  for (const arr of idResults) addEntries(arr, 'anilist_id');

  const textResults = await Promise.all(textPromises);
  for (const arr of textResults) addEntries(arr, 'text_query');

  // Fallback: if still empty, try romaji/english title from AniList
  if (collectedEntries.length === 0 && resolved.targetNode) {
    const fallbacks = [resolved.targetNode.romaji, resolved.targetNode.english].filter(Boolean);
    for (const q of fallbacks) {
      const r = await fetch(`${JIMAKU_BASE}/entries/search?query=${encodeURIComponent(q)}`, {
        headers,
      }).catch(() => null);
      if (r && r.ok) {
        addEntries(await r.json(), 'fallback_romaji');
        if (collectedEntries.length > 0) break;
      }
    }
  }

  collectedEntries.sort((a, b) => b._rankScore - a._rankScore);
  if (collectedEntries.length > 0) {
    setCache(JIMAKU_SEARCH_CACHE, cacheKey, collectedEntries);
  }

  return {
    entries: collectedEntries,
    resolvedMeta: {
      targetEpisode: targetEpisode ? Number(targetEpisode) : null,
      season: resolved.season,
      cumEp: resolved.cumEp,
      seasonEp: resolved.seasonEp,
      courEp: resolved.courEp,
      hasExplicitSeason: resolved.hasExplicitSeason,
      isBoundaryExtra: resolved.isBoundaryExtra,
      targetAnilistId: resolved.targetNode?.id || null,
      seasonStartAnilistId: resolved.seasonStartNode?.id || null,
      rootAnilistId: resolved.chain[0]?.id || null,
      cleanTitle: resolved.cleanTitle,
    },
  };
}

/**
 * Parse both explicit season and episode numbers from a subtitle filename.
 */
function parseFileSeasonAndEpisodes(filename) {
  if (!filename) return { fileSeason: null, episodes: [] };

  let fileSeason = null;
  const seMatch = filename.match(/\bS(\d{1,2})\s*E(\d{1,3})\b/i);
  if (seMatch) {
    fileSeason = parseInt(seMatch[1], 10);
  } else {
    const sDash = filename.match(/\bS(\d{1,2})\s*-\s*\d{1,3}\b/i);
    if (sDash) {
      fileSeason = parseInt(sDash[1], 10);
    } else {
      const sTitle = detectExplicitSeason(filename);
      if (sTitle.hasExplicitSeason) {
        fileSeason = sTitle.seasonNumber;
      }
    }
  }

  const cleaned = filename
    .replace(/\.(srt|ass|ssa|vtt)$/i, '')
    .replace(
      /\b(1080p|720p|480p|2160p|4K|10bit|8bit|x264|x265|h264|h265|hevc|aac|flac|ac3|eac3|assx2|mp4|mkv|mpeg2|at-x)\b/gi,
      ''
    )
    .replace(/\b\d{3,4}x\d{3,4}\b/gi, '')
    .replace(/\[\s*[0-9A-Fa-f]{8}\s*\]/g, '');

  const episodes = [];

  const seMatches = [...cleaned.matchAll(/\bS\d+\s*E(\d{1,3})\b/gi)];
  if (seMatches.length > 0) {
    return { fileSeason, episodes: seMatches.map((m) => parseInt(m[1], 10)) };
  }

  const jaMatches = [...cleaned.matchAll(/第?\s*(\d{1,3})\s*話/g)];
  if (jaMatches.length > 0) {
    return { fileSeason, episodes: jaMatches.map((m) => parseInt(m[1], 10)) };
  }

  const epMatches = [
    ...cleaned.matchAll(/(?:^|[\s._\-[])(?:EP?|Episode)\s*(\d{1,3})(?:$|[\s._\-\]v])/gi),
  ];
  if (epMatches.length > 0) {
    return { fileSeason, episodes: epMatches.map((m) => parseInt(m[1], 10)) };
  }

  const dashMatches = [...cleaned.matchAll(/\s-\s*(\d{1,3})(?:v\d+)?(?:$|[\s._\-[(\]])/g)];
  if (dashMatches.length > 0) {
    return { fileSeason, episodes: dashMatches.map((m) => parseInt(m[1], 10)) };
  }

  const bracketMatches = [
    ...cleaned.matchAll(/(?:[._\-[])\s*(\d{1,3})(?:v\d+)?\s*(?:[._\-]|\])/g),
  ];
  for (const m of bracketMatches) {
    const n = parseInt(m[1], 10);
    if (n > 0 && n < 1900) episodes.push(n);
  }

  return { fileSeason, episodes };
}

function extractEpisodeFromFilename(filename) {
  return parseFileSeasonAndEpisodes(filename).episodes;
}

function normalizeSubtitleCompareStr(str) {
  if (!str) return '';
  return toHalfWidth(str)
    .toLowerCase()
    .replace(/[\s　._\-:：・!?！？「」『』【】()（）\[\]～〜~…,_、。]/g, '');
}

const HAS_JAPANESE_RE = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/;

/**
 * Match d-anime episode subtitle (`partTitle`) against the episode-title segment of a subtitle filename.
 * Returns:
 *   +1 if matched (resolves shifted Netflix/streaming episode numbering!)
 *   -1 if filename contains a different Japanese episode subtitle (mismatch!)
 *    0 if neutral (filename has no episode subtitle or it is in English/romaji)
 */
function matchPartTitleInFilename(filename, partTitle, cleanWorkTitle) {
  if (!filename || !partTitle) return 0;

  // Strip leading episode markers from d-anime's partTitle (e.g. "第25話 「タイトル」" -> "タイトル")
  const strippedPart = partTitle
    .replace(/^第?\s*[0-9０-９]+\s*話\s*/, '')
    .replace(/^#\s*[0-9０-９]+\s*/, '')
    .trim();

  const normPart = normalizeSubtitleCompareStr(strippedPart);
  const normWork = normalizeSubtitleCompareStr(cleanWorkTitle || '');
  if (!normPart || normPart.length < 2 || normPart === normWork) return 0;

  // Extract strictly the episode-title segment after SxxExx / 第x話 / " - xx " and before tech tags
  let epSegment = filename
    .replace(/\.(srt|ass|ssa|vtt)$/i, '')
    .replace(/\.(?:ja|jpn|jp)\b.*$/i, '')
    .replace(/\.(?:WEBRip|WEB-DL|WEB|BDRip|BD|Netflix|ABEMA|DMMTV|U-NEXT|Amazon|AMZN)\b.*$/i, '')
    .replace(/\[(?:WebRip|WEBRip|WEB-DL|BDRip|1080p|720p|JPN|CHS|CHT).*$/i, '');

  const markerMatch = epSegment.match(
    /(?:\bS\d+\s*E\d{1,3}\b|第?\s*\d{1,3}\s*話|\s-\s*\d{1,3}(?:v\d+)?\b)[.\s_-]*(.*)$/i
  );
  if (!markerMatch) return 0;

  const rawEpTitle = markerMatch[1].trim();
  const normFileEpTitle = normalizeSubtitleCompareStr(rawEpTitle);
  if (!normFileEpTitle || normFileEpTitle.length < 2) return 0;

  if (normFileEpTitle === normPart) return 1;
  if (normPart.length >= 3 && (normFileEpTitle.includes(normPart) || normPart.includes(normFileEpTitle))) {
    return 1;
  }

  // Handle multi-part episode titles split by ／ or / or _ (e.g. "前半／後半")
  const subParts = strippedPart
    .split(/[／/]/)
    .map((p) => normalizeSubtitleCompareStr(p))
    .filter((p) => p.length >= 4);
  if (subParts.some((sp) => normFileEpTitle.includes(sp))) {
    return 1;
  }

  // Only flag conflict (-1) if BOTH are Japanese episode titles so English fansubs are never penalized
  if (HAS_JAPANESE_RE.test(rawEpTitle) && HAS_JAPANESE_RE.test(strippedPart)) {
    return -1;
  }
  return 0;
}

const NAMED_SOURCE_ALIASES = {
  abema: ['abema'],
  dmmtv: ['dmmtv', 'dmm'],
  'u-next': ['u-next', 'unext'],
  amazon: ['amazon', 'amzn', 'prime'],
  netflix: ['netflix', '.nf.', '[nf]'],
  nanokoraws: ['nanokoraws', 'nanakoraws'],
  nanakoraws: ['nanakoraws', 'nanokoraws'],
  shincaps: ['shincaps'],
};

function detectSourceCategory(filename, sourceProfiles) {
  const lower = (filename || '').toLowerCase();
  const profiles = Array.isArray(sourceProfiles) && sourceProfiles.length > 0
    ? sourceProfiles
    : DEFAULT_SOURCE_PROFILES;

  for (const profile of profiles) {
    const id = String(profile.id || profile.name || '').toLowerCase();
    if (!id || id === 'other') continue;
    const patterns = NAMED_SOURCE_ALIASES[id] || [
      String(profile.name || '').toLowerCase(),
      id,
    ].filter(Boolean);
    if (patterns.some((p) => p && lower.includes(p))) {
      return id;
    }
  }
  return 'other';
}

/**
 * Filter files by episode (with season, cumulative/cour mapping, and partTitle match)
 * and rank by user's source priority (`sourceProfiles` or legacy string), format priority, and language purity.
 */
function filterAndRankFiles(
  files,
  targetEpisode,
  preferredFormatStr,
  sourceProfilesOrStr,
  extraMeta = {}
) {
  const validFiles = (files || []).filter((f) => /\.(srt|ass|ssa|vtt)$/i.test(f.name || ''));
  if (validFiles.length === 0) return [];

  const formatOrder = (preferredFormatStr || 'ass,srt,vtt')
    .toLowerCase()
    .split(/[,、\s]+/)
    .map((s) => s.replace(/^\./, '').trim())
    .filter(Boolean);

  const profiles = Array.isArray(sourceProfilesOrStr)
    ? normalizeSourceProfiles(sourceProfilesOrStr)
    : normalizeSourceProfiles(null, typeof sourceProfilesOrStr === 'string' ? sourceProfilesOrStr : DEFAULT_PREFERRED_SOURCE);
  const sourceOrder = profiles.map((p) => p.id);

  const targetEp = targetEpisode != null ? Number(targetEpisode) : null;
  const partTitle = extraMeta.partTitle || '';
  const cleanWorkTitle = extraMeta.cleanWorkTitle || '';
  const resolvedSeason = extraMeta.season || null;
  const cumEp = extraMeta.cumEp || targetEp;
  const seasonEp = extraMeta.seasonEp || targetEp;
  const courEp = extraMeta.courEp || targetEp;
  const entryAnilistId = extraMeta.entryAnilistId || null;
  const targetAnilistId = extraMeta.targetAnilistId || null;
  const entrySeason = extraMeta.entryName
    ? detectExplicitSeason(extraMeta.entryName).seasonNumber
    : null;

  const parsedCache = new Map();
  let maxEpInFolder = 0;
  for (const f of validFiles) {
    const parsed = parseFileSeasonAndEpisodes(f.name || '');
    const ptMatch = matchPartTitleInFilename(f.name || '', partTitle, cleanWorkTitle);
    parsedCache.set(f, { ...parsed, ptMatch });
    for (const ep of parsed.episodes) {
      if (ep > maxEpInFolder) maxEpInFolder = ep;
    }
  }

  const isBoundaryExtra = Boolean(extraMeta.isBoundaryExtra);

  let candidateFiles = validFiles;
  let hasExactEpisodeMatch = false;

  if (targetEp != null && targetEp > 0) {
    const checkMatch = (f, allowCourEpFallback) => {
      const { fileSeason, episodes, ptMatch } = parsedCache.get(f);

      // 1. Exact Japanese episode subtitle match overrides episode-number shift!
      if (ptMatch === 1) {
        if (
          fileSeason &&
          resolvedSeason &&
          fileSeason !== resolvedSeason &&
          !(isBoundaryExtra && entrySeason === fileSeason)
        ) {
          return false;
        }
        return true;
      }

      // 2. Reject if Japanese episode subtitle explicitly conflicts
      if (ptMatch === -1) return false;

      // 3. Number + Season matching
      if (fileSeason && resolvedSeason) {
        if (fileSeason === resolvedSeason) {
          if (episodes.includes(seasonEp) || episodes.includes(cumEp)) return true;
          if (allowCourEpFallback && episodes.includes(courEp)) return true;
        } else if (isBoundaryExtra && entrySeason === fileSeason && episodes.includes(cumEp)) {
          // Boundary extra (e.g., S01E25 or S01E13 recap when S1 was 24 or 12 eps)
          return true;
        }
        return false;
      }

      // No explicit season tag in filename
      if (episodes.includes(cumEp)) return true;
      if (
        (entrySeason === resolvedSeason || (entryAnilistId && entryAnilistId === targetAnilistId)) &&
        episodes.includes(seasonEp)
      ) {
        return true;
      }
      if (allowCourEpFallback && episodes.includes(courEp)) {
        return true;
      }
      return false;
    };

    let epMatches = validFiles.filter((f) => checkMatch(f, false));
    if (
      epMatches.length === 0 &&
      courEp !== seasonEp &&
      entryAnilistId &&
      entryAnilistId === targetAnilistId &&
      maxEpInFolder <= 16
    ) {
      epMatches = validFiles.filter((f) => checkMatch(f, true));
    }

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

    const sourceCategory = detectSourceCategory(name, profiles);
    const { ptMatch } = parsedCache.get(file);

    // 1. Source priority score (supports `Other` at any tier position!)
    let rankIndex = sourceOrder.indexOf(sourceCategory);
    if (rankIndex === -1 && sourceCategory === 'nanokoraws') {
      rankIndex = sourceOrder.indexOf('nanakoraws');
    } else if (rankIndex === -1 && sourceCategory === 'nanakoraws') {
      rankIndex = sourceOrder.indexOf('nanokoraws');
    }
    if (rankIndex === -1) {
      // If file is 'other' (or unlisted category), place at 'other' index or end of list
      const otherIdx = sourceOrder.indexOf('other');
      rankIndex = otherIdx !== -1 ? otherIdx : sourceOrder.length;
    }
    const sourceScore = 1000 + (sourceOrder.length - rankIndex) * 80;

    // 2. Format score (ASS vs SRT)
    let formatRank = formatOrder.indexOf(ext);
    if (formatRank === -1) formatRank = formatOrder.length;
    const formatScore = (formatOrder.length - formatRank) * 20;

    // 3. Language purity score (penalize bilingual [CHS, JPN] / [CHT, JPN])
    let langScore = 0;
    if (/\b(chs|cht|sc|tc|zh|chi)\b/i.test(lower)) {
      langScore = -150;
    } else if (/\.ja\b|\[jpn\]|\[ja\]/i.test(lower)) {
      langScore = 30;
    }

    // 4. Episode subtitle match bonus (breaks ties in favor of exact partTitle match)
    const partTitleBonus = ptMatch === 1 ? 500 : 0;

    const totalScore = sourceScore + formatScore + langScore + partTitleBonus;
    return {
      ...file,
      _score: totalScore,
      _sourceCategory: sourceCategory,
      _partTitleMatched: ptMatch === 1,
      _exactEpisode: hasExactEpisodeMatch,
    };
  });

  scored.sort((a, b) => b._score - a._score || (a.name || '').localeCompare(b.name || ''));
  return scored;
}

async function jimakuGetFiles(entryId, episodeNumber, apiKey, settings, extraMeta = {}) {
  if (!apiKey) {
    throw createCodedError(
      'API_KEY_MISSING',
      'Jimaku API key is not set. Please register it in Settings.'
    );
  }
  const headers = {
    Authorization: apiKey.trim(),
    Accept: 'application/json',
  };

  // Fetch & cache the full entry file list so we see all naming styles (S02E01, - 25, Cour 2, shifted Netflix eps)
  let files = getCache(JIMAKU_FILES_CACHE, String(entryId));
  if (!files) {
    const allUrl = `${JIMAKU_BASE}/entries/${entryId}/files`;
    const allRes = await fetch(allUrl, { headers });
    if (allRes.status === 401 || allRes.status === 403) {
      throw createCodedError(
        'UNAUTHORIZED',
        'Invalid Jimaku API key (401 Unauthorized). Check Settings.',
        allRes.status
      );
    }
    if (!allRes.ok) {
      throw createCodedError(
        'FILES_HTTP_ERROR',
        `Failed to fetch subtitle files (${allRes.status})`,
        allRes.status
      );
    }
    files = await allRes.json();
    if (Array.isArray(files)) {
      setCache(JIMAKU_FILES_CACHE, String(entryId), files);
    }
  }

  return filterAndRankFiles(
    files,
    episodeNumber,
    settings.preferredFormat,
    settings.sourceProfiles || settings.preferredSource,
    extraMeta
  );
}

async function downloadSubtitleText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw createCodedError(
      'DOWNLOAD_HTTP_ERROR',
      `Failed to download subtitle file (${res.status})`,
      res.status
    );
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      const settings = await getSettings();

      switch (message.type) {
        case 'JIMAKU_SEARCH': {
          const apiKey = message.apiKey || settings.jimakuApiKey;
          const result = await jimakuSearch(
            message.title,
            apiKey,
            message.kind || 'anime',
            message.episode ?? null
          );
          sendResponse({
            ok: true,
            entries: result.entries,
            resolvedMeta: result.resolvedMeta,
          });
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
              sourceProfiles: message.sourceProfiles ?? settings.sourceProfiles,
              preferredSource: message.preferredSource ?? settings.preferredSource,
            },
            message.extraMeta || {}
          );
          sendResponse({ ok: true, files });
          break;
        }

        case 'JIMAKU_DOWNLOAD': {
          const text = await downloadSubtitleText(message.url);
          sendResponse({ ok: true, text });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      sendResponse({
        ok: false,
        error: err && err.message ? err.message : String(err),
        errorCode: err && err.errorCode ? err.errorCode : '',
        errorStatus: err && err.errorStatus ? err.errorStatus : null,
      });
    }
  })();
  return true;
});
