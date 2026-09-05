/**
 * Bootstrap and routing.
 *
 * Navigation is driven by the history stack so the iPhone back swipe and the
 * hardware-style back gesture work, and so the Now Playing sheet closes with
 * a back rather than trapping the user.
 */

import * as db from './db.js';
import { library } from './library.js';
import { player } from './player.js';
import { settings, loadSettings, saveSettings, renderSettings, applyTheme } from './settings.js';
import { initNowPlaying, isPlayerOpen, closePlayer } from './nowplaying.js';
import { renderHome, renderLibrary, renderSearch, renderDetail, setRouter } from './views.js';
import { initAdd, renderAdd, importPickedFiles } from './addview.js';
import { closeSheet, isSheetOpen, toast } from './ui.js';

const state = {
  view: 'home',
  libraryTab: 'songs',
  query: '',
  detail: null,
};

let saveTimer = null;

/* ------------------------------------------------------------------ router */

function navigate(route, replace = false) {
  if (route.view === 'library') {
    state.view = 'library';
    if (route.tab) state.libraryTab = route.tab;
    state.detail = null;
  } else if (['album', 'artist', 'genre', 'playlist'].includes(route.view)) {
    state.detail = { view: route.view, key: route.key };
    state.view = 'detail';
  } else {
    state.view = route.view;
    state.detail = null;
  }

  if (!replace) history.pushState({ route: { ...route } }, '');
  render();
}

function render() {
  for (const section of document.querySelectorAll('.view')) {
    section.hidden = section.dataset.view !== state.view;
  }

  for (const button of document.querySelectorAll('[data-nav]')) {
    const target = state.view === 'detail' ? detailParentTab() : state.view;
    button.classList.toggle('active', button.dataset.nav === target);
  }

  const main = document.getElementById('main');

  if (state.view === 'home') renderHome(document.getElementById('home-body'));
  else if (state.view === 'library') {
    for (const tab of document.querySelectorAll('#library-tabs [data-tab]')) {
      tab.setAttribute('aria-selected', String(tab.dataset.tab === state.libraryTab));
    }
    renderLibrary(document.getElementById('library-body'), state.libraryTab);
  } else if (state.view === 'search') renderSearch(document.getElementById('search-body'), state.query);
  else if (state.view === 'add') renderAdd(document.getElementById('add-body'));
  else if (state.view === 'settings') renderSettings(document.getElementById('settings-body'));
  else if (state.view === 'detail' && state.detail) renderDetail(document.getElementById('detail-body'), state.detail);

  main.scrollTop = 0;
}

function detailParentTab() {
  return 'library';
}

setRouter(navigate);

/* ---------------------------------------------------------------- history */

/** The route that describes what is on screen right now. */
function currentRoute() {
  if (state.view === 'detail' && state.detail) return { ...state.detail };
  if (state.view === 'library') return { view: 'library', tab: state.libraryTab };
  return { view: state.view };
}

window.addEventListener('popstate', (event) => {
  // Back closes whatever overlay is on top before it changes view. Re-push the
  // route we are actually on, so the next back still lands somewhere sensible.
  if (isSheetOpen()) {
    closeSheet();
    history.pushState({ route: currentRoute() }, '');
    return;
  }
  if (isPlayerOpen()) { closePlayer(); return; }

  const route = event.state && event.state.route;
  if (route) navigate(route, true);
  else { state.view = 'home'; state.detail = null; render(); }
});

/* --------------------------------------------------------------- controls */

function wireChrome() {
  for (const button of document.querySelectorAll('[data-nav]')) {
    button.addEventListener('click', () => {
      const target = button.dataset.nav;
      // Tapping the tab you are already on scrolls back to the top.
      if (state.view === target) {
        document.getElementById('main').scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      navigate({ view: target });
    });
  }

  for (const tab of document.querySelectorAll('#library-tabs [data-tab]')) {
    tab.addEventListener('click', () => navigate({ view: 'library', tab: tab.dataset.tab }));
  }

  document.querySelector('[data-action="open-settings"]').addEventListener('click', () => navigate({ view: 'settings' }));
  document.querySelector('[data-action="import"]').addEventListener('click', () => document.getElementById('file-input').click());

  const search = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear');
  let searchTimer = null;
  search.addEventListener('input', () => {
    state.query = search.value;
    clearBtn.hidden = !search.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (state.view === 'search') renderSearch(document.getElementById('search-body'), state.query);
    }, 130);
  });
  clearBtn.addEventListener('click', () => {
    search.value = '';
    state.query = '';
    clearBtn.hidden = true;
    renderSearch(document.getElementById('search-body'), '');
    search.focus();
  });

  const fileInput = document.getElementById('file-input');
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (!files.length) return;
    if (state.view !== 'add') navigate({ view: 'add' });
    await importPickedFiles(files);
    render();
  });

  // Drag and drop, for when the app is open on a Mac or iPad alongside Files.
  document.addEventListener('dragover', (event) => { event.preventDefault(); });
  document.addEventListener('drop', async (event) => {
    event.preventDefault();
    const files = [...(event.dataTransfer.files || [])];
    if (!files.length) return;
    navigate({ view: 'add' });
    await importPickedFiles(files);
    render();
  });

  document.querySelector('.sheet-backdrop').addEventListener('click', closeSheet);

  // Keyboard shortcuts, useful with a hardware keyboard or on desktop.
  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input, textarea')) return;
    if (event.code === 'Space') { event.preventDefault(); player.toggle(); }
    else if (event.key === 'ArrowRight' && event.metaKey) player.next();
    else if (event.key === 'ArrowLeft' && event.metaKey) player.previous();
    else if (event.key === 'ArrowRight') player.seekBy(10);
    else if (event.key === 'ArrowLeft') player.seekBy(-10);
    else if (event.key === 'Escape') { if (isSheetOpen()) closeSheet(); else if (isPlayerOpen()) history.back(); }
  });
}

/* -------------------------------------------------------------- persistence */

function wirePersistence() {
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      db.setSetting('session', player.snapshot()).catch(() => {});
    }, 800);
  };

  player.addEventListener('trackchange', save);
  player.addEventListener('queuechange', save);
  player.addEventListener('modechange', async () => {
    settings.volume = player.volume;
    await saveSettings();
  });

  // Position is worth saving on the way out, not on every frame.
  const flush = () => { db.setSetting('session', player.snapshot()).catch(() => {}); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  applyTheme();

  await loadSettings();
  await library.load();
  initAdd();
  initNowPlaying();
  wireChrome();
  wirePersistence();

  document.body.classList.add('no-mini');

  library.addEventListener('change', () => {
    if (state.view !== 'add') render();
  });

  if (settings.resumeOnLaunch) {
    const session = await db.getSetting('session', null);
    if (session) await player.restore(session);
  }

  history.replaceState({ route: { view: 'home' } }, '');
  render();

  // Ask for durable storage once there is something worth protecting.
  if (library.tracks.length > 0) db.requestPersistence().catch(() => {});

  registerServiceWorker();
  showInstallHintIfNeeded();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Service worker registration failed', err);
    });
  });
}

function showInstallHintIfNeeded() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (standalone) return;

  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (!isIos) return;

  db.getSetting('installHintShown', false).then((shown) => {
    if (shown) return;
    setTimeout(() => {
      toast('Add this to your Home Screen', {
        detail: 'Tap the Share button below, then "Add to Home Screen". '
          + 'The app then runs full screen and keeps your library safely.',
        duration: 11000,
      });
      db.setSetting('installHintShown', true);
    }, 2500);
  });
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = '<div style="padding:40px 24px;font:15px -apple-system,system-ui,sans-serif;color:#f5f5f7;background:#08080b;min-height:100vh">'
    + '<h1 style="font-size:22px">Resonate could not start</h1>'
    + '<p style="color:#a1a1ac;line-height:1.5">' + String(err && err.message ? err.message : err) + '</p>'
    + '<p style="color:#a1a1ac;line-height:1.5">If this keeps happening, close the app and open it again. '
    + 'Private Browsing blocks the storage this app needs.</p></div>';
});
