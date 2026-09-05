/**
 * Cookie jar handling. The jar is a live session, so these check that it is
 * written privately, round-trips intact, and that junk is refused rather than
 * handed to the extractor.
 *
 * Each case runs in its own process: the module caches the parsed result.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const extractor = path.resolve(here, '../src/extract.js');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
};

/** Run a snippet in a fresh process with the given environment. */
function runCase(env, snippet) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', snippet], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => out.push(d));
    child.on('close', () => resolve(Buffer.concat(out).toString('utf8').trim()));
  });
}

const JAR = '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t0\tSID\tsecret-value\n';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

const report = `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { initExtractorArgs, usingCookies } = await import(${JSON.stringify(extractor)});
const loaded = initExtractorArgs();
const target = path.join(os.tmpdir(), 'extractor-cookies.txt');
const exists = fs.existsSync(target);
console.log(JSON.stringify({
  loaded,
  using: usingCookies(),
  exists,
  contents: exists ? fs.readFileSync(target, 'utf8') : null,
  mode: exists ? (fs.statSync(target).mode & 0o777) : null,
}));
`;

const parse = (text) => {
  const line = text.split('\n').filter((l) => l.startsWith('{')).pop();
  return line ? JSON.parse(line) : {};
};

console.log('A valid cookie jar');
{
  const r = parse(await runCase({ COOKIES_B64: b64(JAR) }, report));
  check('is accepted', r.loaded === true);
  check('is reported as in use', r.using === true);
  check('is written to disk', r.exists === true);
  check('round-trips intact', r.contents === JAR);
  check('is private, mode 0600', r.mode === 0o600, r.mode == null ? 'absent' : '0' + r.mode.toString(8));
}

console.log('Anything else');
{
  const r = parse(await runCase({ COOKIES_B64: b64('just some words') }, report));
  check('junk is refused', r.loaded === false && r.using === false, JSON.stringify(r));

  const empty = parse(await runCase({ COOKIES_B64: '' }, report));
  check('an unset variable means no cookies', empty.loaded === false && empty.using === false);

  const broken = parse(await runCase({ COOKIES_B64: 'not!valid!base64!!' }, report));
  check('undecodable input does not crash the server', broken.loaded === false);
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
