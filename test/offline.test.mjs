/**
 * Offline behaviour.
 *
 * The app's central promise is that it keeps working with no signal, and that
 * rests on the service worker registering and caching the shell. A silent
 * failure there looks completely normal until the moment you are on a train,
 * so it gets its own test.
 *
 * Needs Playwright and the app served locally:
 *   npx http-server -p 8099 -c-1 .
 *   node test/offline.test.mjs http://127.0.0.1:8099
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
const log = (...a) => fs.writeSync(1, a.join(' ') + '\n');

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  if (ok) { pass++; log('  ok   ' + n); } else { fail++; log('  FAIL ' + n + (extra ? ' :: ' + extra : '')); }
};

const BASE = process.argv[2] || 'http://127.0.0.1:8099';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE + '/index.html', { waitUntil: 'load' });
await page.waitForTimeout(3500);

const reg = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.ready;
  return !!r.active;
});
check('service worker activates', reg === true);

const cached = await page.evaluate(async () => {
  const names = await caches.keys();
  const c = await caches.open(names[0]);
  return { names, count: (await c.keys()).length };
});
check('cache is version 2', cached.names.includes('resonate-v2'), JSON.stringify(cached.names));
check('shell is cached', cached.count >= 12, String(cached.count));

log('going offline');
await ctx.setOffline(true);
await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 });
await page.waitForTimeout(5000);

const offline = await page.evaluate(() => {
  const root = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  return {
    tabs: document.querySelectorAll('[data-nav]').length,
    home: !!document.querySelector('[data-view="home"]'),
    // These custom properties only exist if the stylesheet itself loaded, so
    // they beat asserting a literal colour that any redesign would break.
    token: root.getPropertyValue('--bg').trim(),
    bg: body.backgroundColor,
    icons: !!document.querySelector('#i-play'),
  };
});
check('app loads with no network', offline.tabs === 5 && offline.home, JSON.stringify(offline));
check('stylesheet came from cache',
  offline.token.length > 0 && offline.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(offline));
check('icon sprite is present', offline.icons === true);
check('no errors while offline', errors.length === 0, errors.slice(0, 3).join(' | '));

await ctx.setOffline(false);
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(2000);
check('recovers when back online', (await page.locator('[data-nav]').count()) === 5);

log('');
log(pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail ? 1 : 0);
