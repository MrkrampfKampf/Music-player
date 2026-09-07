/**
 * Service worker.
 *
 * Caches the app shell so it opens with no network at all. Media never goes
 * near this cache: it lives in IndexedDB, which is the durable store and is
 * not subject to cache eviction the same way.
 */

const VERSION = 'resonate-v8';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './css/room.css',
  './js/main.js',
  './js/db.js',
  './js/tags.js',
  './js/player.js',
  './js/library.js',
  './js/lyrics.js',
  './js/converter.js',
  './js/ui.js',
  './js/views.js',
  './js/nowplaying.js',
  './js/addview.js',
  './js/settings.js',
  './js/tactile.js',
  './js/discover.js',
  './js/discoverview.js',
  './js/room.js',
  './js/room2d.js',
  './js/studio/scene.js',
  './js/studio/textures.js',
  './vendor/three/three.module.js',
  './vendor/three/environments/RoomEnvironment.js',
  './vendor/three/postprocessing/EffectComposer.js',
  './vendor/three/postprocessing/RenderPass.js',
  './vendor/three/postprocessing/ShaderPass.js',
  './vendor/three/postprocessing/MaskPass.js',
  './vendor/three/postprocessing/Pass.js',
  './vendor/three/postprocessing/UnrealBloomPass.js',
  './vendor/three/postprocessing/OutputPass.js',
  './vendor/three/shaders/CopyShader.js',
  './vendor/three/shaders/LuminosityHighPassShader.js',
  './vendor/three/shaders/OutputShader.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // A single failing entry must not fail the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // converter traffic passes through

  event.respondWith(networkFirst(request));
});

/**
 * Serve from the network when there is one, fall back to the cache when there
 * is not.
 *
 * The shell is a handful of small files, so going to the network first costs
 * almost nothing online and means a new version is live the next time the app
 * opens, rather than the time after that. A slow connection does not stall the
 * app: after a short wait the cached copy is served instead.
 */
async function networkFirst(request) {
  const cached = await caches.match(request);

  try {
    const response = await withTimeout(fetch(request), 3000, cached);
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    if (response) return response;
  } catch {
    // Offline, or the request failed. The cache is the fallback below.
  }

  if (cached) return cached;
  if (request.mode === 'navigate') {
    const shell = await caches.match('./index.html');
    if (shell) return shell;
  }
  return Response.error();
}

/**
 * Resolve `promise`, or give up after `ms` and return `fallback` instead.
 * The request itself is left running so its result still reaches the cache.
 */
function withTimeout(promise, ms, fallback) {
  if (!fallback) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
