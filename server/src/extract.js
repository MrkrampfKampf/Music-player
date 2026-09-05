/**
 * Resolving a link into media.
 *
 * The extractor is a separate program, named by EXTRACTOR, rather than
 * anything hard-coded here. That keeps site-specific scraping out of this
 * codebase: the server knows how to run a tool, read its JSON, and hand the
 * result to ffmpeg. Which tool, and what it is pointed at, is the operator's
 * choice.
 *
 * The expected JSON is the yt-dlp `-J` shape, which several tools emit.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

/** Extra arguments derived from configuration, filled in at boot. */
let derivedArgs = [];

/**
 * Write the configured cookie jar to a private file and return whether one is
 * in use. Called once at boot; the contents are never logged.
 */
export function initExtractorArgs() {
  derivedArgs = [];
  if (!config.cookiesB64) return false;

  try {
    const jar = Buffer.from(config.cookiesB64, 'base64').toString('utf8');
    if (!/^#|\t/m.test(jar)) {
      console.warn('COOKIES_B64 does not look like a Netscape cookies.txt; ignoring it.');
      return false;
    }
    const target = path.join(os.tmpdir(), 'extractor-cookies.txt');
    fs.writeFileSync(target, jar, { mode: 0o600 });
    derivedArgs = ['--cookies', target];
    return true;
  } catch (err) {
    console.warn('Could not read COOKIES_B64:', err.message);
    return false;
  }
}

export function usingCookies() {
  return derivedArgs.length > 0;
}

export class ExtractError extends Error {
  constructor(message, { status = 502, hint = '' } = {}) {
    super(message);
    this.name = 'ExtractError';
    this.status = status;
    this.hint = hint;
  }
}

/** Run a command, capture stdout, and fail loudly on a non-zero exit. */
export function run(command, args, { timeoutMs, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new ExtractError('Could not start ' + command + '.', {
        status: 500,
        hint: 'Is it installed and on PATH inside the container?',
      }));
      return;
    }

    const out = [];
    const errOut = [];
    let outLength = 0;
    let settled = false;

    const timer = timeoutMs ? setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new ExtractError(command + ' timed out after ' + Math.round(timeoutMs / 1000) + 's.', {
        status: 504,
        hint: 'The source may be slow, very long, or blocking this server.',
      }));
    }, timeoutMs) : null;

    child.stdout.on('data', (chunk) => {
      outLength += chunk.length;
      if (outLength > maxBuffer) {
        child.kill('SIGKILL');
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      // Keep only the tail; extractor logs can be enormous.
      errOut.push(chunk);
      if (errOut.length > 40) errOut.splice(0, errOut.length - 40);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new ExtractError(
        err.code === 'ENOENT' ? command + ' is not installed on the server.' : 'Failed to run ' + command + '.',
        { status: 500, hint: err.code === 'ENOENT' ? 'Add it to the image, or set EXTRACTOR to something you do have.' : String(err.message) },
      ));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stderr = Buffer.concat(errOut).toString('utf8').trim();
      if (code !== 0) {
        reject(new ExtractError(summariseFailure(stderr, command), { status: 502, hint: lastLine(stderr) }));
        return;
      }
      resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}

function lastLine(text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : '';
}

/** Turn extractor stderr into something a person can act on. */
function summariseFailure(stderr, command) {
  const text = String(stderr).toLowerCase();
  if (text.includes('unsupported url')) return 'That site is not supported by the extractor.';
  if (text.includes('private') || text.includes('members-only') || text.includes('login')) {
    return 'That item is private or needs a sign-in.';
  }
  if (text.includes('drm') || text.includes('encrypted')) {
    return 'That audio is DRM protected and cannot be converted.';
  }
  if (text.includes('not available') || text.includes('removed') || text.includes('404')) {
    return 'That item is gone or not available in this region.';
  }
  if (text.includes('sign in to confirm') || text.includes('bot')) {
    return 'The source is blocking this server as automated traffic.';
  }
  if (text.includes('http error 429') || text.includes('too many requests')) {
    return 'The source is rate limiting this server. Try again later.';
  }
  return command + ' could not read that link.';
}

/**
 * Ask the extractor what is behind a URL.
 * @returns {{type:'track'|'playlist', title:string, items:object[]}}
 */
export async function resolveUrl(url) {
  const args = [
    '--dump-single-json',
    '--flat-playlist',
    '--no-warnings',
    '--no-progress',
    '--playlist-end', String(config.maxPlaylistItems),
    ...derivedArgs,
    ...config.extractorArgs,
    url,
  ];

  const raw = await run(config.extractor, args, { timeoutMs: config.extractorTimeoutMs });

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ExtractError('The extractor returned something that is not JSON.', {
      hint: 'Check that EXTRACTOR points at a yt-dlp compatible tool.',
    });
  }

  if (data._type === 'playlist' || Array.isArray(data.entries)) {
    const entries = (data.entries || []).filter(Boolean).slice(0, config.maxPlaylistItems);
    return {
      type: entries.length > 1 ? 'playlist' : 'track',
      title: data.title || 'Playlist',
      sourceUrl: url,
      items: entries.map((entry) => toItem(entry, url)),
    };
  }

  return { type: 'track', title: data.title || '', sourceUrl: url, items: [toItem(data, url)] };
}

function toItem(entry, fallbackUrl) {
  const thumbnails = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
  const thumbnail = entry.thumbnail
    || (thumbnails.length ? thumbnails[thumbnails.length - 1].url : '');

  return {
    id: String(entry.id || entry.url || fallbackUrl),
    title: entry.track || entry.title || 'Unknown title',
    artist: entry.artist || entry.creator || entry.uploader || entry.channel || '',
    album: entry.album || '',
    duration: Math.round(entry.duration || 0),
    thumbnail: thumbnail || '',
    webpageUrl: entry.webpage_url || entry.url || fallbackUrl,
    direct: false,
  };
}

/** Get the concrete stream URL and metadata for one item, ready for ffmpeg. */
export async function resolveStream(url, preferOriginal) {
  // Prefer a container Safari plays natively so "original" needs no re-encode.
  const format = preferOriginal
    ? 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best'
    : 'bestaudio/best';

  const args = [
    '--dump-single-json',
    '--no-warnings',
    '--no-progress',
    '--no-playlist',
    '-f', format,
    ...derivedArgs,
    ...config.extractorArgs,
    url,
  ];

  const raw = await run(config.extractor, args, { timeoutMs: config.extractorTimeoutMs });

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ExtractError('The extractor returned something that is not JSON.');
  }

  const duration = Math.round(data.duration || 0);
  if (duration && duration > config.maxDurationSeconds) {
    throw new ExtractError(
      'That is ' + Math.round(duration / 60) + ' minutes long, over this server’s limit.',
      { status: 413, hint: 'Raise MAX_DURATION if you want longer items.' },
    );
  }

  const streamUrl = pickStreamUrl(data);
  if (!streamUrl) {
    throw new ExtractError('No audio stream was found at that link.', {
      hint: 'The page may be video-only, encrypted, or need a sign-in.',
    });
  }

  return {
    streamUrl,
    httpHeaders: data.http_headers || {},
    meta: {
      title: data.track || data.title || 'Unknown title',
      artist: data.artist || data.creator || data.uploader || data.channel || '',
      album: data.album || '',
      duration,
      acodec: data.acodec || '',
      ext: data.ext || '',
      abr: data.abr || 0,
    },
  };
}

function pickStreamUrl(data) {
  if (data.url) return data.url;
  const formats = Array.isArray(data.requested_formats) ? data.requested_formats : [];
  const audio = formats.find((f) => f.acodec && f.acodec !== 'none');
  return audio ? audio.url : null;
}
