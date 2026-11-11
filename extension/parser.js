/**
 * Subtitle Parser for .srt, .vtt, and .ass / .ssa formats.
 * Returns normalized cues sorted by startTime:
 *   Array<{ start: number, end: number, text: string }>
 */
(function (global) {
  function parseTimeSRT(timeStr) {
    // 00:01:23,456 or 01:23.456
    const cleaned = timeStr.trim().replace(',', '.');
    const parts = cleaned.split(':');
    if (parts.length === 3) {
      return (
        parseInt(parts[0], 10) * 3600 +
        parseInt(parts[1], 10) * 60 +
        parseFloat(parts[2])
      );
    } else if (parts.length === 2) {
      return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
    }
    return 0;
  }

  function parseTimeASS(timeStr) {
    // 0:01:23.45
    const parts = timeStr.trim().split(':');
    if (parts.length !== 3) return 0;
    return (
      parseInt(parts[0], 10) * 3600 +
      parseInt(parts[1], 10) * 60 +
      parseFloat(parts[2])
    );
  }

  function cleanText(raw) {
    return raw
      // Remove ASS override tags like {\pos(100,200)\fad(100,100)}
      .replace(/\{[^}]*\}/g, '')
      // Convert ASS line breaks \N and \n to actual newlines
      .replace(/\\[Nn]/g, '\n')
      // Convert HTML <br> tags to newlines
      .replace(/<br\s*\/?>/gi, '\n')
      // Strip other HTML tags except ruby (<ruby>, <rt>, <rp>)
      .replace(/<(?!\/?(?:ruby|rt|rp)\b)[^>]+>/gi, '')
      .trim();
  }

  function parseSRTorVTT(content) {
    const cues = [];
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = normalized.split(/\n\s*\n/);

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length === 0) continue;

      let timeLineIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('-->')) {
          timeLineIdx = i;
          break;
        }
      }
      if (timeLineIdx === -1) continue;

      const timeLine = lines[timeLineIdx];
      const match = timeLine.match(
        /(\d{1,2}:?\d{2}:\d{2}[,.]\d{1,3}|\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:?\d{2}:\d{2}[,.]\d{1,3}|\d{2}:\d{2}[,.]\d{1,3})/
      );
      if (!match) continue;

      const start = parseTimeSRT(match[1]);
      const end = parseTimeSRT(match[2]);
      const rawText = lines.slice(timeLineIdx + 1).join('\n');
      const text = cleanText(rawText);

      if (text && end > start) {
        cues.push({ start, end, text });
      }
    }
    return mergeOverlappingIdenticalCues(cues);
  }

  function parseASS(content) {
    const cues = [];
    const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    let inEvents = false;
    let formatFields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith(';')) continue;

      if (line.startsWith('[')) {
        inEvents = line.toLowerCase() === '[events]';
        continue;
      }
      if (!inEvents) continue;

      if (line.toLowerCase().startsWith('format:')) {
        const formatSpec = line.slice(7).split(',');
        formatFields = formatSpec.map((f) => f.trim().toLowerCase());
        continue;
      }

      if (line.toLowerCase().startsWith('dialogue:')) {
        const payload = line.slice(9).trim();
        // Split only up to formatFields.length - 1 commas so Text field keeps its commas
        const parts = [];
        let currentIdx = 0;
        for (let i = 0; i < formatFields.length - 1; i++) {
          const commaIdx = payload.indexOf(',', currentIdx);
          if (commaIdx === -1) break;
          parts.push(payload.slice(currentIdx, commaIdx).trim());
          currentIdx = commaIdx + 1;
        }
        parts.push(payload.slice(currentIdx));

        if (parts.length < formatFields.length) continue;

        const startIdx = formatFields.indexOf('start');
        const endIdx = formatFields.indexOf('end');
        const textIdx = formatFields.indexOf('text');
        const styleIdx = formatFields.indexOf('style');

        if (startIdx === -1 || endIdx === -1 || textIdx === -1) continue;

        const rawText = parts[textIdx];
        // Skip pure drawing commands {\p1}...
        if (/\\p[1-9]/.test(rawText)) continue;

        const start = parseTimeASS(parts[startIdx]);
        const end = parseTimeASS(parts[endIdx]);
        const text = cleanText(rawText);
        const style = styleIdx !== -1 ? parts[styleIdx] : '';

        if (text && end > start) {
          cues.push({ start, end, text, style });
        }
      }
    }

    return mergeOverlappingIdenticalCues(cues);
  }

  function mergeOverlappingIdenticalCues(cues) {
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const cue of cues) {
      const prev = merged[merged.length - 1];
      if (
        prev &&
        prev.text === cue.text &&
        Math.abs(prev.end - cue.start) < 0.15
      ) {
        prev.end = Math.max(prev.end, cue.end);
      } else if (
        prev &&
        prev.text === cue.text &&
        Math.abs(prev.start - cue.start) < 0.05 &&
        Math.abs(prev.end - cue.end) < 0.05
      ) {
        // Duplicate cue (common in ASS border layers)
        continue;
      } else {
        merged.push({ ...cue });
      }
    }
    return merged;
  }

  function parseSubtitles(content, filename = '') {
    const lower = filename.toLowerCase();
    if (
      lower.endsWith('.ass') ||
      lower.endsWith('.ssa') ||
      content.includes('[Script Info]') ||
      content.includes('\nDialogue:')
    ) {
      return parseASS(content);
    }
    return parseSRTorVTT(content);
  }

  function toSRT(cues) {
    const pad = (n, len = 2) => String(Math.floor(n)).padStart(len, '0');
    const formatTime = (sec) => {
      const s = Math.max(0, sec);
      const hrs = Math.floor(s / 3600);
      const mins = Math.floor((s % 3600) / 60);
      const secs = Math.floor(s % 60);
      const ms = Math.round((s - Math.floor(s)) * 1000);
      return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
    };

    return cues
      .map((c, idx) => `${idx + 1}\n${formatTime(c.start)} --> ${formatTime(c.end)}\n${c.text}\n`)
      .join('\n');
  }

  global.SubtitleParser = {
    parseSubtitles,
    parseSRTorVTT,
    parseASS,
    toSRT,
  };
})(typeof window !== 'undefined' ? window : globalThis);
