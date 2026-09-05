/**
 * Server tests. Runs the real HTTP server on a spare port against a stub
 * extractor, so routing, auth, the URL guards and error mapping are all
 * exercised end to end without needing yt-dlp or the network.
 *
 * Run with: npm test   (from the server directory)
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = 8123;
const TOKEN = 'test-token-123';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
};

/* A stub extractor that speaks the yt-dlp JSON dialect. */
const stub = [
  '#!/usr/bin/env node',
  "const args = process.argv.slice(2);",
  "if (args.includes('--version')) { console.log('stub 2026.01.01'); process.exit(0); }",
  "const url = args[args.length - 1];",
  "if (url.includes('fails')) { console.error('ERROR: Unsupported URL: ' + url); process.exit(1); }",
  "if (url.includes('private')) { console.error('ERROR: Private video. Sign in to view'); process.exit(1); }",
  "if (url.includes('playlist')) {",
  "  console.log(JSON.stringify({ _type: 'playlist', title: 'Stub Playlist', entries: [",
  "    { id: 'a1', title: 'Alpha', uploader: 'Stub', duration: 100, webpage_url: 'https://example.com/a1' },",
  "    { id: 'b2', title: 'Beta', uploader: 'Stub', duration: 200, webpage_url: 'https://example.com/b2' } ] }));",
  "  process.exit(0);",
  "}",
  "if (url.includes('toolong')) {",
  "  console.log(JSON.stringify({ id: 'x', title: 'Epic', duration: 99999, url: 'https://cdn.example.com/x.m4a', acodec: 'mp4a.40.2' }));",
  "  process.exit(0);",
  "}",
  "console.log(JSON.stringify({ id: 'z9', title: 'Stub Song', artist: 'Stub Artist', album: 'Stub Album',",
  "  duration: 123, ext: 'm4a', acodec: 'mp4a.40.2', abr: 128, url: 'https://cdn.example.com/z9.m4a',",
  "  thumbnails: [{ url: 'https://cdn.example.com/z9.jpg' }], webpage_url: url }));",
].join('\n');

const stubPath = path.join(here, 'stub-extractor.mjs');
fs.writeFileSync(stubPath, stub);
fs.chmodSync(stubPath, 0o755);

const child = spawn(process.execPath, [path.join(root, 'src/index.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    ACCESS_TOKEN: TOKEN,
    EXTRACTOR: stubPath,
    MAX_DURATION: '3600',
    RATE_LIMIT_PER_MINUTE: '1000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
  child.stdout.on('data', (d) => {
    if (String(d).includes('Resonate converter')) { clearTimeout(timer); setTimeout(resolve, 150); }
  });
});

const base = 'http://127.0.0.1:' + PORT;
const auth = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const post = (route, body, headers = auth) =>
  fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });

try {
  console.log('Auth');
  check('health rejects a missing token', (await fetch(base + '/api/health')).status === 401);
  check('health rejects a wrong token',
    (await fetch(base + '/api/health', { headers: { Authorization: 'Bearer nope' } })).status === 401);

  const healthRes = await fetch(base + '/api/health', { headers: auth });
  const health = await healthRes.json();
  check('health accepts the right token', healthRes.status === 200);
  check('health reports the extractor', /stub 2026/.test(health.extractor || ''), String(health.extractor));
  check('health reports the token as required', health.tokenRequired === true);
  check('health lists the quality profiles', (health.qualities || []).includes('mp3_320'));

  console.log('CORS');
  const pre = await fetch(base + '/api/convert', { method: 'OPTIONS', headers: { Origin: 'https://example.github.io' } });
  check('preflight succeeds', pre.status === 204, String(pre.status));
  check('preflight allows the origin', pre.headers.get('access-control-allow-origin') === '*');
  check('metadata headers are exposed',
    (pre.headers.get('access-control-expose-headers') || '').includes('X-Media-Title'));

  console.log('URL guards');
  for (const [bad, label] of [
    ['file:///etc/passwd', 'file scheme'],
    ['http://127.0.0.1:22/', 'loopback'],
    ['http://localhost/x', 'localhost'],
    ['http://10.0.0.1/x', 'private 10/8'],
    ['http://192.168.1.1/x', 'private 192.168/16'],
    ['http://172.20.0.1/x', 'private 172.16/12'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://100.100.0.1/x', 'carrier grade NAT'],
    ['not-a-url', 'garbage'],
  ]) {
    check('rejects ' + label, (await post('/api/resolve', { url: bad })).status === 400);
  }
  check('accepts a public url', (await post('/api/resolve', { url: 'https://example.com/track' })).status === 200);
  check('172.32 is public, not private', (await post('/api/resolve', { url: 'https://172.32.0.1/track' })).status === 200);

  console.log('Resolve');
  const single = await (await post('/api/resolve', { url: 'https://example.com/track' })).json();
  check('single track resolves', single.type === 'track' && single.items.length === 1, JSON.stringify(single));
  check('title read from extractor', single.items[0].title === 'Stub Song');
  check('artist read from extractor', single.items[0].artist === 'Stub Artist');
  check('duration read from extractor', single.items[0].duration === 123);
  check('thumbnail carried through', single.items[0].thumbnail === 'https://cdn.example.com/z9.jpg');

  const list = await (await post('/api/resolve', { url: 'https://example.com/playlist/1' })).json();
  check('playlist resolves', list.type === 'playlist' && list.items.length === 2, String(list.type));
  check('playlist title', list.title === 'Stub Playlist');

  console.log('Extractor failures become useful messages');
  const unsupported = await post('/api/resolve', { url: 'https://example.com/fails' });
  const unsupportedBody = await unsupported.json();
  check('unsupported url gives 502', unsupported.status === 502, String(unsupported.status));
  check('unsupported url is explained', /not supported/i.test(unsupportedBody.error), unsupportedBody.error);

  const priv = await post('/api/resolve', { url: 'https://example.com/private' });
  const privBody = await priv.json();
  check('private item is explained', /private|sign-in/i.test(privBody.error), privBody.error);

  console.log('Convert guards');
  const tooLong = await post('/api/convert', { url: 'https://example.com/toolong' });
  const tooLongBody = await tooLong.json();
  check('over-length item is refused', tooLong.status === 413, String(tooLong.status));
  check('length limit is explained', /minutes/.test(tooLongBody.error), tooLongBody.error);

  console.log('Routing');
  check('unknown path is 404', (await fetch(base + '/api/nope', { headers: auth })).status === 404);
  check('root describes the service', (await (await fetch(base + '/')).json()).name === 'Resonate converter');
} finally {
  child.kill('SIGKILL');
  fs.rmSync(stubPath, { force: true });
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
