/**
 * Running out of room mid-import.
 *
 * Moving a music library onto a phone that is nearly full only works if the
 * import stops cleanly and can be resumed, so this drives exactly that: offer
 * more than fits, check it takes what it can and says what is left, then free
 * room and offer the same files again.
 *
 * Needs Playwright and the app served locally:
 *   npx http-server -p 8099 -c-1 .
 *   node test/quota.test.mjs http://127.0.0.1:8099
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
const log = (...a) => fs.writeSync(1, a.join(' ') + '\n');

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  if (ok) { pass++; log('  ok   ' + n); } else { fail++; log('  FAIL ' + n + (extra ? ' :: ' + extra : '')); }
};

const BASE = process.argv[2] || 'http://127.0.0.1:8099';
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
page.on('pageerror', (e) => log('  [pageerror]', e.message));

await page.goto(BASE + '/index.html', { waitUntil: 'load' });
await page.waitForTimeout(2500);

/*
 * Pretend the quota is nearly full. Ten fake tracks of 1 MB each are offered
 * with only enough room reported for a few, so the loop must stop partway and
 * say so rather than failing or silently dropping the rest.
 */
const result = await page.evaluate(async () => {
  const { library } = await import('./js/library.js');

  const QUOTA = 40 * 1024 * 1024;
  // Patch the browser API itself: a module namespace object is read-only, so
  // stubbing db.storageEstimate from out here would silently do nothing.
  const realEstimate = navigator.storage.estimate.bind(navigator.storage);
  let pretendUsed = QUOTA - (20 * 1024 * 1024); // 20 MB free, before headroom
  navigator.storage.estimate = async () => ({ usage: pretendUsed, quota: QUOTA });

  const files = [];
  for (let i = 0; i < 10; i++) {
    // Distinct bytes so each gets its own fingerprint.
    const bytes = new Uint8Array(4 * 1024 * 1024);
    bytes[0] = i;
    bytes[1] = 0xff;
    files.push(new File([bytes], 'fake-' + i + '.mp3', { type: 'audio/mpeg' }));
  }

  const first = await library.importFiles(files);
  // Reflect the writes so the second round sees a different picture.
  pretendUsed += first.added.reduce((s, t) => s + t.size, 0);

  const out = {
    firstAdded: first.added.length,
    firstStopped: first.stoppedForSpace,
    firstLeft: first.notAttempted.length,
  };

  // Free room, as deleting the originals would, and run the same selection.
  pretendUsed = QUOTA - (40 * 1024 * 1024);
  const second = await library.importFiles(files);
  out.secondAdded = second.added.length;
  out.secondDupes = second.duplicates.length;
  out.total = library.tracks.length;

  navigator.storage.estimate = realEstimate;
  return out;
});

log('  ' + JSON.stringify(result));
check('stops when the room runs out', result.firstStopped === true);
check('imports what does fit', result.firstAdded > 0 && result.firstAdded < 10, String(result.firstAdded));
check('reports what is still to go', result.firstLeft === 10 - result.firstAdded,
  result.firstLeft + ' vs ' + (10 - result.firstAdded));
check('a second round carries on', result.secondAdded === 10 - result.firstAdded, String(result.secondAdded));
check('already imported ones are skipped, not repeated', result.secondDupes === result.firstAdded,
  result.secondDupes + ' vs ' + result.firstAdded);
check('all ten end up in the library exactly once', result.total === 10, String(result.total));

log('');
log(pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail ? 1 : 0);
