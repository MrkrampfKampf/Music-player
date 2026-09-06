/**
 * Bootstrap and routing.
 *
 * Navigation is driven by the history stack so the iPhone back swipe and the
 * hardware-style back gesture work, and so the Now Playing sheet closes with
 * a back rather than trapping the user.
 */

import * as db from './db.js';
import { library, LIKED_ID } from './library.js';
import { player } from './player.js';
import { settings, loadSettings, saveSettings, renderSettings, applyTheme } from './settings.js';
import { initNowPlaying, isPlayerOpen, closePlayer } from './nowplaying.js';
import { renderHome, renderLibrary, renderSearch, renderDetail, setRouter } from './views.js';
import { renderDiscover, resetDiscover } from './discoverview.js';
import { setRoomRouter, prepareRoom } from './room.js';
import { initAdd, renderAdd, importPickedFiles } from './addview.js';
import { closeSheet, isSheetOpen, toast } from './ui.js';
import { asButton, press } from './tactile.js';

const state = {
  view: 'home',
  libraryTab: 'songs',
  query: '',
  searchScope: 'library',
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
  // In the room the equipment reports what is playing, so the player bar
  // stays out of it.
  document.body.classList.toggle('in-room', state.view === 'home');

  const main = document.getElementById('main');

  if (state.view === 'home') renderHome(document.getElementById('home-body'));
  else if (state.view === 'library') {
    for (const tab of document.querySelectorAll('#library-tabs [data-tab]')) {
      tab.setAttribute('aria-selected', String(tab.dataset.tab === state.libraryTab));
    }
    renderLibrary(document.getElementById('library-body'), state.libraryTab);
  } else if (state.view === 'search') {
    for (const tab of document.querySelectorAll('#search-tabs [data-scope]')) {
      tab.setAttribute('aria-selected', String(tab.dataset.scope === state.searchScope));
    }
    const input = document.getElementById('search-input');
    input.placeholder = state.searchScope === 'online'
      ? 'Artists, albums, songs, genres' : 'Songs, albums, artists';
    const body = document.getElementById('search-body');
    if (state.searchScope === 'online') renderDiscover(body, state.query);
    else renderSearch(body, state.query);
  }
  else if (state.view === 'add') renderAdd(document.getElementById('add-body'));
  else if (state.view === 'settings') renderSettings(document.getElementById('settings-body'));
  else if (state.view === 'detail' && state.detail) renderDetail(document.getElementById('detail-body'), state.detail);

  main.scrollTop = 0;
}

setRouter(navigate);

// The studio takes a moment to build, so start it before it is asked for.
prepareRoom();

// The room's objects route by name.
setRoomRouter((where) => {
  if (where === 'player') {
    if (player.current) openPlayerFromRoom();
    else navigate({ view: 'library', tab: 'songs' });
  } else if (where === 'library') navigate({ view: 'library', tab: 'albums' });
  else if (where === 'settings') navigate({ view: 'settings' });
  else if (where === 'add') navigate({ view: 'add' });
  else if (where === 'search') { state.searchScope = 'library'; navigate({ view: 'search' }); }
  else if (where === 'find') { state.searchScope = 'online'; resetDiscover(); navigate({ view: 'search' }); }
  else if (where === 'liked') navigate({ view: 'playlist', key: LIKED_ID });
  else if (where === 'playlists') navigate({ view: 'library', tab: 'playlists' });
});

function openPlayerFromRoom() {
  document.getElementById('mini').click();
}

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
  // Everything comes back to the room, from the same place on every screen.
  for (const button of document.querySelectorAll('[data-back]')) {
    asButton(button);
    button.addEventListener('click', () => navigate({ view: 'home' }));
  }

  for (const tab of document.querySelectorAll('#library-tabs [data-tab]')) {
    tab.addEventListener('click', () => { press(); navigate({ view: 'library', tab: tab.dataset.tab }); });
  }

  // Home has no settings button of its own any more: the mixing console is
  // the settings, and the light switch by the door lists everything by name.
  const gear = document.querySelector('[data-action="open-settings"]');
  if (gear) gear.addEventListener('click', () => navigate({ view: 'settings' }));
  document.querySelector('[data-action="import"]').addEventListener('click', () => document.getElementById('file-input').click());

  for (const tab of document.querySelectorAll('#search-tabs [data-scope]')) {
    tab.addEventListener('click', () => {
      press();
      state.searchScope = tab.dataset.scope;
      if (state.searchScope === 'online') resetDiscover();
      render();
    });
  }

  const search = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear');
  let searchTimer = null;
  search.addEventListener('input', () => {
    state.query = search.value;
    clearBtn.hidden = !search.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (state.view !== 'search') return;
      const body = document.getElementById('search-body');
      // Online searching hits the network, so it waits a little longer.
      if (state.searchScope === 'online') renderDiscover(body, state.query);
      else renderSearch(body, state.query);
    }, state.searchScope === 'online' ? 450 : 130);
  });
  clearBtn.addEventListener('click', () => {
    search.value = '';
    state.query = '';
    clearBtn.hidden = true;
    if (state.searchScope === 'online') resetDiscover();
    render();
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

  // Views ask to move elsewhere without reaching into the router themselves.
  document.addEventListener('goto', (event) => navigate(event.detail));

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
  // Register straight away. Waiting for the load event is the usual advice,
  // but boot() has already awaited storage and the library by the time this
  // runs, so that event has long since fired and the listener never ran,
  // leaving the app with no offline support at all.
  navigator.serviceWorker.register('sw.js').catch((err) => {
    console.warn('Service worker registration failed', err);
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
