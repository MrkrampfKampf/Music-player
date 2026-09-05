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
import { el, icon, clear, artNode, toast, formatBytes, menuSheet, plural } from './ui.js';

let converter = null;
let jobs = [];

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

  host.append(serverStatusCard(host));
  host.append(jobsSection());
}

function serverStatusCard(host) {
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
        onclick: () => { settled = true; closeSheetNow(); resolve(true); },
      }),
      el('button', {
        class: 'btn wide secondary',
        text: 'Cancel',
        style: { marginTop: '10px' },
        onclick: () => { settled = true; closeSheetNow(); resolve(false); },
      })));

    const host = document.getElementById('sheet-host');
    const observer = new MutationObserver(() => {
      if (host.hidden && !settled) { settled = true; observer.disconnect(); resolve(false); }
    });
    observer.observe(host, { attributes: true, attributeFilter: ['hidden'] });
  });
}

function closeSheetNow() {
  document.getElementById('sheet-host').hidden = true;
  document.body.style.overflow = '';
}

/* ------------------------------------------------------------ file import */

export async function importPickedFiles(files) {
  if (!files || !files.length) return;

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

  const parts = [];
  if (result.added.length) parts.push(plural(result.added.length, 'song') + ' added');
  if (result.failed.length) parts.push(result.failed.length + ' failed');
  if (result.skipped) parts.push(result.skipped + ' skipped');

  updateJob(job, {
    state: result.added.length ? 'done' : 'failed',
    status: parts.join(' · ') || 'Nothing to import',
    progress: 1,
    title: plural(files.length, 'file'),
  });

  if (result.added.length) {
    toast(plural(result.added.length, 'song') + ' added', {
      detail: result.failed.length ? result.failed.length + ' could not be read.' : '',
    });
  } else {
    toast('Nothing was imported', {
      detail: result.skipped ? 'Those file types are not supported.' : 'The files could not be read.',
      error: true,
    });
  }
}
