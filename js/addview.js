/**
 * The Add tab: import files from the device, and turn a pasted link into a
 * track in the library.
 *
 * Everything that lands here goes into Liked Songs by default, which is what
 * was asked for and also makes converted tracks easy to find again.
 */

import { library } from './library.js';
import { Converter, ConverterError, normaliseUrl, isSpotify, QUALITY } from './converter.js';
import { settings, saveSettings } from './settings.js';
import { el, icon, clear, artNode, toast, formatBytes, menuSheet, closeSheet, plural } from './ui.js';
import * as db from './db.js';

let converter = null;
let jobs = [];
/** The last import, kept so its summary survives a re-render of this view. */
let lastImport = null;

export function initAdd() {
  converter = new Converter(settings);
}

export function renderAdd(host) {
  clear(host);
  converter = new Converter(settings);

  /* ------------------------------------------------------------ from files */

  const filesCard = el('div', { class: 'convert-card' },
    el('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '12px' } },
      el('span', { class: 'art placeholder', style: { width: '42px', height: '42px' } }, icon('folder')),
      el('div', {},
        el('b', { text: 'From this iPhone' }),
        el('div', { style: { fontSize: '12.5px', color: 'var(--text-dim)', marginTop: '2px' } },
          'MP3, M4A, WAV, FLAC, AIFF, Opus, MP4 and MOV'))),
    el('button', {
      class: 'btn wide',
      onclick: () => document.getElementById('file-input').click(),
    }, icon('plus', 20), el('span', { text: 'Choose files' })),
    el('button', {
      class: 'btn wide secondary',
      style: { marginTop: '10px' },
      onclick: spotifyFolderHelp,
    }, icon('note', 20), el('span', { text: 'From my Spotify folder' })),
    el('p', {
      class: 'hint',
      style: { marginTop: '10px' },
      text: 'Files are copied into the app and stay on your device. Nothing is uploaded, '
        + 'and nothing is re-encoded, so lossless files stay lossless.',
    }));
  host.append(filesCard);

  /* ------------------------------------------------------------- from link */

  host.append(el('h2', { class: 'section-title', text: 'From a link' }));

  const input = el('input', {
    type: 'url',
    placeholder: 'Paste a link',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
  });

  const qualityBtn = el('button', {
    class: 'setting',
    style: { background: 'var(--surface)', borderRadius: '12px', marginBottom: '12px' },
  },
  el('div', { class: 'setting-text' },
    el('b', { text: 'Quality' }),
    el('span', { text: QUALITY[settings.quality].hint })),
  el('div', { class: 'setting-value', text: QUALITY[settings.quality].label }));

  qualityBtn.addEventListener('click', () => {
    menuSheet('Quality', Object.entries(QUALITY).map(([key, value]) => ({
      label: value.label,
      icon: key === 'original' ? 'check' : 'download',
      checked: settings.quality === key,
      onSelect: async () => {
        settings.quality = key;
        await saveSettings();
        renderAdd(host);
      },
    })));
  });

  const goBtn = el('button', { class: 'btn wide' }, icon('download', 20), el('span', { text: 'Add to Liked Songs' }));

  const linkCard = el('div', { class: 'convert-card' },
    el('div', { class: 'field', style: { marginBottom: '12px' } }, input),
    qualityBtn,
    goBtn);
  host.append(linkCard);

  const paste = async () => {
    const url = normaliseUrl(input.value);
    if (!url) { toast('That does not look like a link.', { error: true }); return; }
    input.value = '';
    input.blur();
    await startJob(url, host);
  };

  goBtn.addEventListener('click', paste);
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') paste(); });

  /* ---------------------------------------------------------------- status */

  host.append(serverStatusCard());
  host.append(jobsSection());
  const safe = safeToDeleteSection();
  if (safe) host.append(safe);
}

function serverStatusCard() {
  const configured = !!(settings.serverUrl || '').trim();

  if (configured) {
    const card = el('div', { class: 'notice' }, icon('link'),
      el('div', {},
        el('b', { text: 'Converter server' }),
        el('span', { id: 'server-status', text: 'Checking ' + shortHost(settings.serverUrl) + '...' })));

    converter.ping().then((result) => {
      const node = card.querySelector('#server-status');
      if (!node) return;
      node.textContent = result.ok
        ? 'Connected to ' + shortHost(settings.serverUrl)
          + (result.info && result.info.extractor ? ' · extractor: ' + result.info.extractor : '')
        : shortHost(settings.serverUrl) + ' is not answering. ' + result.reason;
    });

    return card;
  }

  return el('div', { class: 'notice' }, icon('link'),
    el('div', {},
      el('b', { text: 'Only direct file links work right now' }),
      el('span', {
        text: 'A link ending in .mp3, .m4a, .wav or .mp4 downloads on its own. '
          + 'For YouTube, SoundCloud and the like, set up the converter server and '
          + 'paste its address in Settings.',
      }),
      el('button', {
        class: 'btn secondary',
        style: { marginTop: '10px' },
        text: 'Open Settings',
        onclick: () => document.querySelector('[data-nav="settings"]').click(),
      })));
}

function shortHost(url) {
  try { return new URL(url).host; } catch { return url; }
}

/* -------------------------------------------------------------------- jobs */

function jobsSection() {
  const wrap = el('div', { id: 'jobs-section' });
  if (!jobs.length) return wrap;

  wrap.append(el('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' } },
    el('h2', { class: 'section-title', text: 'Downloads' }),
    el('button', {
      class: 'text-btn',
      text: 'Clear',
      onclick: () => {
        jobs = jobs.filter((j) => j.state === 'working');
        repaintJobs();
      },
    })));

  const card = el('div', { class: 'convert-card' });
  for (const job of jobs) card.append(jobRow(job));
  wrap.append(card);
  return wrap;
}

function jobRow(job) {
  const row = el('div', { class: 'convert-item' });

  row.append(job.artworkKey
    ? artNode(job.artworkKey)
    : el('span', { class: 'art placeholder', style: { width: '46px', height: '46px' } },
      job.state === 'working' ? el('span', { class: 'spinner' }) : icon(job.state === 'done' ? 'check' : job.state === 'failed' ? 'x' : 'note')));

  const body = el('div', { style: { flex: 1, minWidth: 0 } },
    el('div', { class: 'row-title', text: job.title }),
    el('div', { class: 'convert-status' + (job.state === 'done' ? ' done' : job.state === 'failed' ? ' failed' : ''), text: job.status }));

  if (job.state === 'working') {
    const bar = el('div', { class: 'bar' }, el('i', { style: { width: (job.progress * 100) + '%' } }));
    body.append(bar);
  }

  row.append(body);
  return row;
}

function repaintJobs() {
  const host = document.getElementById('add-body');
  if (!host) return;
  const existing = host.querySelector('#jobs-section');
  const next = jobsSection();
  if (existing) existing.replaceWith(next);
  else host.append(next);
}

function addJob(title) {
  const job = { id: Math.random().toString(36).slice(2), title, status: 'Starting', state: 'working', progress: 0, artworkKey: null };
  jobs.unshift(job);
  repaintJobs();
  return job;
}

function updateJob(job, patch) {
  Object.assign(job, patch);
  repaintJobs();
}

/* ------------------------------------------------------------------ start */

async function startJob(url, host) {
  const job = addJob(shortHost(url));

  try {
    updateJob(job, { status: 'Looking up the link' });
    const resolved = await converter.resolve(url);
    const items = resolved.items || [];

    if (!items.length) throw new ConverterError('Nothing to download at that link.');

    if (resolved.type === 'playlist' && items.length > 1) {
      updateJob(job, { title: resolved.title || 'Playlist', status: plural(items.length, 'track') + ' found' });
      const confirmed = await confirmPlaylist(resolved, items.length);
      if (!confirmed) { updateJob(job, { state: 'failed', status: 'Cancelled' }); return; }

      let done = 0;
      for (const item of items) {
        const child = addJob(item.title || 'Track');
        try {
          await downloadOne(child, item);
          done++;
        } catch (err) {
          reportJobError(child, err);
        }
      }
      updateJob(job, { state: 'done', status: done + ' of ' + items.length + ' added to Liked Songs' });
      toast('Added ' + plural(done, 'song'), { detail: 'Find them in Liked Songs.' });
      return;
    }

    const item = items[0];
    updateJob(job, { title: item.title || job.title });
    await downloadOne(job, item);
    toast('Added to Liked Songs', { detail: item.title || '' });
  } catch (err) {
    reportJobError(job, err);
  }
}

async function downloadOne(job, item) {
  updateJob(job, { title: item.title || job.title, status: 'Downloading' });

  const track = await converter.fetchToLibrary(item, {
    quality: settings.quality,
    liked: true,
    onProgress: (loaded, total) => {
      updateJob(job, {
        progress: total ? loaded / total : 0,
        status: total ? formatBytes(loaded) + ' of ' + formatBytes(total) : formatBytes(loaded) + ' downloaded',
      });
    },
  });

  updateJob(job, {
    state: 'done',
    status: 'Added to Liked Songs',
    progress: 1,
    artworkKey: track ? track.artworkKey : null,
    title: track ? track.title : job.title,
  });
  return track;
}

function reportJobError(job, err) {
  const message = err instanceof ConverterError ? err.message : (err && err.message) || 'Something went wrong.';
  updateJob(job, { state: 'failed', status: message });
  toast('Could not add that link', {
    detail: (err && err.hint) || message,
    error: true,
    duration: 8000,
  });
}

function confirmPlaylist(resolved, count) {
  return new Promise((resolve) => {
    let settled = false;
    menuSheet(null, [], el('div', {},
      el('h2', { text: resolved.title || 'Playlist' }),
      el('p', {
        text: 'This link has ' + plural(count, 'track') + '. They will be downloaded one at a time '
          + 'and added to Liked Songs.',
        style: { color: 'var(--text-dim)', margin: '0 0 18px', lineHeight: '1.5' },
      }),
      isSpotify(resolved.sourceUrl || '') ? el('div', { class: 'notice', style: { marginBottom: '14px' } },
        icon('note'),
        el('div', {}, el('b', { text: 'Matched, not copied' }),
          el('span', { text: 'Spotify audio is encrypted, so each track is found from another source. Some may not match exactly.' }))) : null,
      el('button', {
        class: 'btn wide',
        text: 'Download ' + plural(count, 'track'),
        onclick: () => { settled = true; closeSheet(); resolve(true); },
      }),
      el('button', {
        class: 'btn wide secondary',
        text: 'Cancel',
        style: { marginTop: '10px' },
        onclick: () => { settled = true; closeSheet(); resolve(false); },
      })));

    // Dismissing by backdrop or swipe counts as declining the download.
    const host = document.getElementById('sheet-host');
    const observer = new MutationObserver(() => {
      if (!host.hidden) return;
      observer.disconnect();
      if (!settled) { settled = true; resolve(false); }
    });
    observer.observe(host, { attributes: true, attributeFilter: ['hidden'] });
  });
}

/* ------------------------------------------------------------ file import */

/**
 * Warn before an import that will not fit.
 *
 * Importing copies each file into the app's own storage, because Safari gives
 * a web app no way to keep playing a file that stays where it is. On a phone
 * that is nearly full that matters, and finding out halfway through an import
 * is the worst way to learn it.
 *
 * @returns {Promise<boolean>} whether to go ahead
 */
async function confirmSpace(files) {
  const needed = [...files].reduce((sum, f) => sum + (f.size || 0), 0);
  const estimate = await db.storageEstimate();
  if (!estimate || !estimate.quota) return true;

  const free = Math.max(0, estimate.quota - estimate.usage);
  if (needed < free * 0.9) return true;

  return new Promise((resolve) => {
    let settled = false;
    menuSheet(null, [], el('div', {},
      el('h2', { text: 'This may not fit' }),
      el('div', { class: 'card-box', style: { marginBottom: '14px' } },
        el('div', { class: 'setting' },
          el('div', { class: 'setting-text' }, el('b', { text: 'These files' })),
          el('div', { class: 'setting-value', text: formatBytes(needed) })),
        el('div', { class: 'setting' },
          el('div', { class: 'setting-text' }, el('b', { text: 'Room left' })),
          el('div', { class: 'setting-value', text: formatBytes(free) }))),
      el('p', {
        text: 'Importing copies each file into the app, so for a while a song '
          + 'takes up space twice. Import a few albums at a time and delete each '
          + 'batch from its old folder once it is here, and you never need room '
          + 'for two full copies.',
        style: { color: 'var(--text-dim)', margin: '0 0 18px', lineHeight: '1.5' },
      }),
      el('button', {
        class: 'btn wide',
        text: 'Import anyway',
        onclick: () => { settled = true; closeSheet(); resolve(true); },
      }),
      el('button', {
        class: 'btn wide secondary',
        text: 'Cancel',
        style: { marginTop: '10px' },
        onclick: () => { settled = true; closeSheet(); resolve(false); },
      })));

    const host = document.getElementById('sheet-host');
    const observer = new MutationObserver(() => {
      if (!host.hidden) return;
      observer.disconnect();
      if (!settled) { settled = true; resolve(false); }
    });
    observer.observe(host, { attributes: true, attributeFilter: ['hidden'] });
  });
}

export async function importPickedFiles(files) {
  if (!files || !files.length) return;
  if (!await confirmSpace(files)) return;

  const job = addJob(plural(files.length, 'file'));
  updateJob(job, { status: 'Reading tags' });
  repaintJobs();

  const result = await library.importFiles(files, (done, total, name) => {
    updateJob(job, {
      progress: total ? done / total : 0,
      status: done + ' of ' + total + (name ? ' · ' + name : ''),
      title: name || job.title,
    });
  });

  const dupes = result.duplicates.length;
  const parts = [];
  if (result.added.length) parts.push(plural(result.added.length, 'song') + ' added');
  if (dupes) parts.push(dupes + ' already here');
  if (result.failed.length) parts.push(result.failed.length + ' failed');
  if (result.skipped) parts.push(result.skipped + ' unsupported');

  // Nothing new from a folder you already imported is a success, not a failure.
  const worked = result.added.length > 0 || dupes > 0;

  updateJob(job, {
    state: worked ? 'done' : 'failed',
    status: parts.join(' · ') || 'Nothing to import',
    progress: 1,
    title: plural(files.length, 'file'),
  });

  lastImport = (result.added.length || dupes) ? result : null;
  if (lastImport) repaintSafeToDelete();

  if (result.added.length) {
    const notes = [];
    if (dupes) notes.push(dupes + ' were already in your library.');
    if (result.failed.length) notes.push(result.failed.length + ' could not be read.');
    toast(plural(result.added.length, 'song') + ' added', { detail: notes.join(' ') });
  } else if (dupes) {
    toast('Nothing new to add', {
      detail: 'All ' + dupes + ' of those are already in your library.',
    });
  } else {
    toast('Nothing was imported', {
      detail: result.skipped ? 'Those file types are not supported.' : 'The files could not be read.',
      error: true,
    });
  }
}

/**
 * List the files that are now definitely in the library.
 *
 * Freeing space means deleting the originals, and doing that from memory is
 * how people lose music. This names each file that made it, and separately
 * names any that did not, so the decision needs no guessing.
 *
 * Built from stored state rather than appended to the DOM, because importing
 * re-renders this view.
 */
function safeToDeleteSection() {
  if (!lastImport) return null;

  const safe = [
    ...lastImport.added.map((t) => t.fileName || t.title),
    ...lastImport.duplicates,
  ].sort((a, b) => a.localeCompare(b));
  if (!safe.length) return null;

  const list = el('div', {
    style: {
      maxHeight: '220px', overflowY: 'auto', marginTop: '10px',
      borderTop: '1px solid var(--line)', paddingTop: '10px',
    },
  });
  for (const name of safe) {
    list.append(el('div', {
      class: 'safe-file',
      text: name,
      style: {
        fontSize: '13px', color: 'var(--text-dim)', padding: '4px 0',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
    }));
  }

  const failedCount = lastImport.failed.length;

  return el('section', { id: 'safe-to-delete' },
    el('h2', { class: 'section-title', text: 'Now safe to delete' }),
    el('div', { class: 'convert-card' },
      el('p', {
        text: plural(safe.length, 'file') + ' from that import are in your library now. '
          + 'You can delete these from wherever they came from, and the copy here keeps working.',
        style: { margin: '0', fontSize: '13.5px', color: 'var(--text-dim)', lineHeight: '1.5' },
      }),
      failedCount ? el('p', {
        text: 'Keep the other ' + plural(failedCount, 'file') + '. Those could not be read.',
        style: { margin: '10px 0 0', fontSize: '13.5px', color: 'var(--danger)', lineHeight: '1.5' },
      }) : null,
      list,
      el('button', {
        class: 'btn secondary wide',
        text: 'Done',
        style: { marginTop: '12px' },
        onclick: () => { lastImport = null; repaintSafeToDelete(); },
      })));
}

function repaintSafeToDelete() {
  const host = document.getElementById('add-body');
  if (!host) return;
  const existing = host.querySelector('#safe-to-delete');
  const next = safeToDeleteSection();

  if (existing && next) existing.replaceWith(next);
  else if (existing) existing.remove();
  else if (next) host.append(next);

  if (next) next.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Guidance for pulling in music Spotify holds as Local Files.
 *
 * There is no way to skip the picker. A web page cannot read a path, iOS has
 * no folder picker for the web, and Safari cannot receive files from the share
 * sheet either. So the honest thing is to name the exact route and then open
 * the picker, rather than pretend a button can do it alone.
 */
function spotifyFolderHelp() {
  const step = (n, text) => el('div', { class: 'setting' },
    el('div', {
      style: {
        flex: 'none', width: '24px', height: '24px', borderRadius: '50%',
        background: 'var(--accent)', color: '#fff', display: 'grid',
        placeItems: 'center', fontSize: '13px', fontWeight: '700',
      },
      text: String(n),
    }),
    el('div', { class: 'setting-text' }, el('span', { text, style: { color: 'var(--text)', fontSize: '14px' } })));

  menuSheet(null, [], el('div', {},
    el('h2', { text: 'From your Spotify folder' }),
    el('p', {
      text: 'Music you added to Spotify yourself sits in a normal folder you can open. '
        + 'Tap below and the picker opens; from there it is three taps.',
      style: { color: 'var(--text-dim)', margin: '0 0 14px', lineHeight: '1.5' },
    }),
    el('div', { class: 'card-box', style: { marginBottom: '14px' } },
      step(1, 'Tap Browse at the bottom, then On My iPhone.'),
      step(2, 'Open the Spotify folder.'),
      step(3, 'Tap the songs you want. You can pick many at once.')),
    el('p', {
      text: 'Next time the picker opens in that same folder, so it is one tap after this.',
      style: { color: 'var(--text-faint)', fontSize: '13px', margin: '0 0 8px', lineHeight: '1.5' },
    }),
    el('p', {
      text: 'Take an album at a time rather than everything. Importing copies each file, '
        + 'so a batch at a time is what keeps you from needing room for two full copies. '
        + 'Anything already here is skipped, so you can run this as often as you like.',
      style: { color: 'var(--text-faint)', fontSize: '13px', margin: '0 0 18px', lineHeight: '1.5' },
    }),
    el('button', {
      class: 'btn wide',
      text: 'Open the picker',
      onclick: () => { closeSheet(); document.getElementById('file-input').click(); },
    })));
}
