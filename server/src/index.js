/**
 * Resonate converter server.
 *
 * Three endpoints and no dependencies beyond Node itself:
 *
 *   GET  /api/health   is the server up, and what can it do
 *   POST /api/resolve  what is behind this link
 *   POST /api/convert  stream the audio back
 *
 * Everything site-specific lives in the external extractor (see extract.js),
 * so this process only knows how to run a tool and pipe bytes.
 */

import http from 'node:http';
import { config, VERSION } from './config.js';
import { resolveUrl, resolveStream, ExtractError, run } from './extract.js';
import { planProfile, convertToStream, PROFILES } from './convert.js';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const PATH_UNSAFE = /[\\/:*?"<>|]+/g;

const started = Date.now();
let inFlight = 0;
const buckets = new Map(); // ip -> { count, resetAt }

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (err) {
    console.error('Unhandled error', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong on the server.' });
    else res.end();
  }
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/' || url.pathname === '/api') {
    sendJson(res, 200, {
      name: 'Resonate converter',
      version: VERSION,
      endpoints: ['/api/health', '/api/resolve', '/api/convert'],
    });
    return;
  }

  if (url.pathname === '/api/health') {
    if (!authorised(req)) { sendJson(res, 401, { error: 'Missing or wrong access token.' }); return; }
    sendJson(res, 200, await health());
    return;
  }

  if (url.pathname === '/api/resolve' && req.method === 'POST') {
    if (!authorised(req)) { sendJson(res, 401, { error: 'Missing or wrong access token.' }); return; }
    if (!rateLimit(req, res)) return;

    const body = await readJson(req);
    const target = validUrl(body.url);
    if (!target) { sendJson(res, 400, { error: 'That is not a valid public http or https link.' }); return; }

    try {
      sendJson(res, 200, await resolveUrl(target));
    } catch (err) {
      sendError(res, err);
    }
    return;
  }

  if (url.pathname === '/api/convert' && req.method === 'POST') {
    if (!authorised(req)) { sendJson(res, 401, { error: 'Missing or wrong access token.' }); return; }
    if (!rateLimit(req, res)) return;

    if (inFlight >= config.maxConcurrent) {
      res.setHeader('Retry-After', '30');
      sendJson(res, 503, {
        error: 'The server is busy with another conversion.',
        hint: 'Try again in a moment, or raise MAX_CONCURRENT.',
      });
      return;
    }

    const body = await readJson(req);
    const target = validUrl(body.url);
    if (!target) { sendJson(res, 400, { error: 'That is not a valid public http or https link.' }); return; }

    const requested = PROFILES[body.quality] ? body.quality : 'original';
    inFlight++;
    try {
      await streamConversion(res, target, requested);
    } catch (err) {
      if (!res.headersSent) sendError(res, err);
      else res.end(); // the phone already has partial bytes; nothing else to say
    } finally {
      inFlight--;
    }
    return;
  }

  sendJson(res, 404, { error: 'No such endpoint.' });
}

async function streamConversion(res, target, requested) {
  const { streamUrl, httpHeaders, meta } = await resolveStream(target, requested === 'original');
  const { profile, downgraded } = planProfile(requested, meta.acodec);

  const filename = safeName((meta.artist ? meta.artist + ' - ' : '') + meta.title) + '.' + profile.ext;

  res.writeHead(200, {
    'Content-Type': profile.mime,
    'Cache-Control': 'no-store',
    'Content-Disposition': 'attachment; filename="' + filename.replace(/"/g, '') + '"',
    // Headers are latin1 on the wire, so anything non-ASCII goes base64.
    'X-Media-Title': b64(meta.title),
    'X-Media-Artist': b64(meta.artist),
    'X-Media-Album': b64(meta.album),
    'X-Media-Filename': b64(filename),
    'X-Media-Profile': profile.label,
    'X-Media-Downgraded': downgraded ? '1' : '0',
    'X-Media-Duration': String(meta.duration || 0),
  });

  await convertToStream({ streamUrl, httpHeaders, profile, meta, output: res });
  res.end();
}

/* -------------------------------------------------------------------- auth */

function authorised(req) {
  if (!config.token) return true;
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  return timingSafeEqual(provided, config.token);
}

/** Constant-time compare so the token cannot be guessed a byte at a time. */
export function timingSafeEqual(a, b) {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  const allowAny = config.allowedOrigins.includes('*');

  if (allowAny) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // The app reads the track name and filename off the response.
  res.setHeader('Access-Control-Expose-Headers',
    'X-Media-Title, X-Media-Artist, X-Media-Album, X-Media-Filename, X-Media-Profile, X-Media-Downgraded, X-Media-Duration, Content-Length');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function rateLimit(req, res) {
  const forwarded = String(req.headers['x-forwarded-for'] || '');
  const ip = forwarded.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = buckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60000 };
    buckets.set(ip, bucket);
  }
  bucket.count++;

  // Keep the map from growing without bound on a long-lived process.
  if (buckets.size > 5000) {
    for (const [key, value] of buckets) if (now > value.resetAt) buckets.delete(key);
  }

  if (bucket.count > config.rateLimitPerMinute) {
    res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    sendJson(res, 429, { error: 'Too many requests. Slow down for a minute.' });
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ helpers */

export function validUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // Do not let a caller aim the server at machines on its own network.
  if (isPrivateHost(parsed.hostname)) return null;
  return parsed.toString();
}

export function isPrivateHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;            // link local, cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;  // carrier grade NAT
  return false;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendError(res, err) {
  if (err instanceof ExtractError) {
    sendJson(res, err.status, { error: err.message, hint: err.hint });
    return;
  }
  console.error(err);
  sendJson(res, 500, { error: err.message || 'Conversion failed.' });
}

function b64(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64');
}

/** A filename safe on every filesystem, and safe in a Content-Disposition. */
export function safeName(name) {
  const cleaned = String(name)
    .replace(CONTROL_CHARS, '')
    .replace(PATH_UNSAFE, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || 'track';
}

async function health() {
  const [extractor, ffmpeg] = await Promise.all([
    probe(config.extractor, ['--version']),
    probe(config.ffmpeg, ['-version']),
  ]);

  return {
    ok: !!(extractor && ffmpeg),
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - started) / 1000),
    extractor: extractor ? config.extractor + ' ' + extractor : null,
    ffmpeg: ffmpeg ? ffmpeg.split(' ').slice(0, 3).join(' ') : null,
    tokenRequired: !!config.token,
    maxDurationSeconds: config.maxDurationSeconds,
    maxConcurrent: config.maxConcurrent,
    inFlight,
    qualities: Object.keys(PROFILES),
  };
}

async function probe(command, args) {
  try {
    const out = await run(command, args, { timeoutMs: 8000, maxBuffer: 256 * 1024 });
    return out.split('\n')[0].trim();
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------- boot */

if (process.env.RESONATE_NO_LISTEN !== '1') {
  server.listen(config.port, config.host, () => {
    console.log('Resonate converter v' + VERSION + ' on ' + config.host + ':' + config.port);
    console.log('  extractor: ' + config.extractor);
    console.log('  ffmpeg:    ' + config.ffmpeg);
    console.log('  token:     ' + (config.token ? 'required' : 'NOT SET, anyone with the URL can use this server'));
    console.log('  origins:   ' + config.allowedOrigins.join(', '));
  });

  const shutdown = () => {
    console.log('Shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export { server };
