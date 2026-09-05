/**
 * Lyrics: plain text and synced .lrc.
 *
 * Stored per track as { kind: 'plain' | 'synced', text, lines }. Synced lines
 * are kept sorted by time so the Now Playing view can binary search the
 * active line on every frame without re-scanning.
 */

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_TAG = /^\[(ti|ar|al|au|by|offset|length|re|ve):(.*)\]$/i;

/** Parse .lrc text. Falls back to plain lyrics when there are no timestamps. */
export function parseLrc(text) {
  const raw = String(text || '').replace(/\r\n?/g, '\n');
  const lines = [];
  const meta = {};
  let offset = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const metaMatch = trimmed.match(META_TAG);
    if (metaMatch) {
      const key = metaMatch[1].toLowerCase();
      const value = metaMatch[2].trim();
      if (key === 'offset') offset = parseInt(value, 10) / 1000 || 0;
      else meta[key] = value;
      continue;
    }

    TIME_TAG.lastIndex = 0;
    const stamps = [];
    let match;
    while ((match = TIME_TAG.exec(trimmed)) !== null) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const fracRaw = match[3] || '0';
      // Two digits mean hundredths, three mean milliseconds.
      const frac = parseInt(fracRaw, 10) / Math.pow(10, fracRaw.length);
      stamps.push(minutes * 60 + seconds + frac);
    }
    if (!stamps.length) continue;

    const content = trimmed.replace(TIME_TAG, '').trim();
    for (const time of stamps) lines.push({ time: Math.max(0, time - offset), text: content });
  }

  if (!lines.length) {
    const plain = raw.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    return plain ? { kind: 'plain', text: plain, lines: [] } : null;
  }

  lines.sort((a, b) => a.time - b.time);
  return { kind: 'synced', text: raw, lines, meta };
}

/** Accept .lrc or plain .txt content and normalise it into stored form. */
export function parseLyricsFile(text) {
  return parseLrc(text);
}

/** Index of the line that should be highlighted at `time`, or -1. */
export function activeLineIndex(lines, time) {
  if (!lines || !lines.length) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= time) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found;
}
