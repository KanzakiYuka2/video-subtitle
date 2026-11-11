/**
 * Background Service Worker for d-anime Subtitle Assistant
 * Handles cross-origin API requests to:
 *  - Jimaku.cc API (search entries, list episode files, download subtitle file)
 *  - AniList GraphQL API (optional title -> anilist_id lookup)
 *  - Local AI Whisper Server (http://127.0.0.1:8765)
 */

const JIMAKU_BASE = 'https://jimaku.cc/api';
const ANILIST_URL = 'https://graphql.anilist.co';
const DEFAULT_AI_SERVER = 'http://127.0.0.1:8765';

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      {
        jimakuApiKey: '',
        aiServerUrl: DEFAULT_AI_SERVER,
        fontSize: 28,
        bottomPosition: 10,
        bgOpacity: 0.65,
        textColor: '#ffffff',
      },
      (items) => resolve(items)
    );
  });
}

async function searchAniList(title) {
  const query = `
    query ($search: String) {
      Page(page: 1, perPage: 5) {
        media(search: $search, type: ANIME) {
          id
          title {
            native
            romaji
            english
          }
          seasonYear
          episodes
        }
      }
    }
  `;
  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables: { search: title } }),
  });
  if (!res.ok) return [];
  const json = await res.json();
  return json?.data?.Page?.media || [];
}

async function jimakuSearch(title, apiKey) {
  if (!apiKey) {
    throw new Error('Jimaku APIキーが設定されていません。パネルの「⚙ 設定」から登録してください。');
  }
  const headers = {
    Authorization: apiKey.trim(),
    Accept: 'application/json',
  };

  // 1. Try direct query search on Jimaku.cc
  const cleanTitle = title
    .replace(/（.*?）|\(.*?\)|【.*?】|\[.*?\]/g, ' ')
    .replace(/第\d+期|Season\s*\d+/gi, (m) => ` ${m} `)
    .trim();

  const searchUrl = `${JIMAKU_BASE}/entries/search?query=${encodeURIComponent(cleanTitle)}`;
  let entries = [];
  const res = await fetch(searchUrl, { headers });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Jimaku APIキーが無効です（401 Unauthorized）。設定を確認してください。');
  }
  if (res.ok) {
    entries = await res.json();
  }

  // 2. Also query AniList to find exact anilist_id match if direct search returned nothing or to enrich results
  if (!entries || entries.length === 0) {
    try {
      const mediaList = await searchAniList(cleanTitle);
      for (const media of mediaList.slice(0, 2)) {
        const byIdRes = await fetch(
          `${JIMAKU_BASE}/entries/search?anilist_id=${media.id}`,
          { headers }
        );
        if (byIdRes.ok) {
          const idEntries = await byIdRes.json();
          if (Array.isArray(idEntries) && idEntries.length > 0) {
            entries.push(...idEntries);
          }
        }
      }
    } catch (_) {
      // Ignore AniList fallback errors
    }
  }

  // Deduplicate by entry.id
  const seen = new Set();
  return (entries || []).filter((e) => {
    if (!e || seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

async function jimakuGetFiles(entryId, episodeNumber, apiKey) {
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

  // Filter to subtitle extensions (.srt, .ass, .ssa, .vtt)
  return (files || []).filter((f) =>
    /\.(srt|ass|ssa|vtt)$/i.test(f.name || '')
  );
}

async function downloadSubtitleText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`字幕ファイルのダウンロードに失敗しました (${res.status})`);
  }
  const buffer = await res.arrayBuffer();
  // Detect UTF-16 BOM or decode as UTF-8
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
            apiKey
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
  return true; // Async response
});
