/**
 * The online half of Search.
 *
 * Deliberately plain to operate: a field, a row of filters, a list of results.
 * The character is in the materials, not in making the reader work out how to
 * search. Quality is stated as the source actually provides it.
 */

import { search, release, fetchTrack, DiscoverError } from './discover.js';
import { library } from './library.js';
import {
  el, icon, clear, formatTime, formatBytes, plural, toast, menuSheet, closeSheet,
} from './ui.js';
import { press, tick, needleDrop } from './tactile.js';

const KINDS = [
  ['all', 'Everything'],
  ['artist', 'Artist'],
  ['album', 'Album'],
  ['song', 'Song'],
  ['genre', 'Genre'],
];

let kind = 'all';
let lastQuery = '';
let results = [];
let state = 'idle';   // idle | searching | done | error
let message = '';
let inFlight = null;

export function resetDiscover() {
  lastQuery = '';
  results = [];
  state = 'idle';
}

export function renderDiscover(host, query) {
  clear(host);

  host.append(el('div', { class: 'chip-row', style: { marginBottom: '16px' } },
    KINDS.map(([value, label]) => el('button', {
      class: 'chip' + (kind === value ? ' on' : ''),
      text: label,
      onclick: () => {
        kind = value;
        press();
        run(host, query, true);
      },
    }))));

  const body = el('div', { id: 'discover-body' });
  host.append(body);
  paint(body, host, query);

  if (query.trim() && query.trim() !== lastQuery) run(host, query, false);
}

async function run(host, query, force) {
  const text = query.trim();
  const body = host.querySelector('#discover-body');
  if (!text) { state = 'idle'; results = []; paint(body, host, query); return; }
  if (!force && text === lastQuery) return;

  lastQuery = text;
  state = 'searching';
  paint(body, host, query);

  if (inFlight) inFlight.abort();
  inFlight = new AbortController();

  try {
    results = await search(text, { kind, signal: inFlight.signal });
    state = 'done';
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    state = 'error';
    message = err instanceof DiscoverError ? err.message : 'Search failed.';
  }
  paint(host.querySelector('#discover-body'), host, query);
}

function paint(body, host, query) {
  if (!body) return;
  clear(body);

  if (state === 'idle') {
    body.append(el('div', { class: 'notice' }, icon('search'),
      el('div', {},
        el('b', { text: 'Search the open archive' }),
        el('span', {
          text: 'Live recordings, netlabels and public domain music from the Internet '
            + 'Archive. Everything here can be downloaded and played offline, and each '
            + 'result shows the licence and the real format on the source.',
        }))));
    return;
  }

  if (state === 'searching') {
    body.append(el('div', { class: 'empty' },
      el('span', { class: 'spinner', style: { margin: '0 auto 16px' } }),
      el('p', { text: 'Looking through the shelves.' })));
    return;
  }

  if (state === 'error') {
    body.append(el('div', { class: 'empty' }, icon('x'),
      el('h3', { text: 'Could not search' }), el('p', { text: message })));
    return;
  }

  if (!results.length) {
    body.append(el('div', { class: 'empty' }, icon('search'),
      el('h3', { text: 'Nothing found' }),
      el('p', { text: 'No recordings match "' + query.trim() + '" in the archive.' })));
    return;
  }

  const rows = el('div', { class: 'rows' });
  for (const item of results) rows.append(resultRow(item));
  body.append(rows);
  body.append(el('p', {
    class: 'silk',
    text: plural(results.length, 'result') + ' from the Internet Archive',
    style: { textAlign: 'center', color: 'var(--text-faint)', padding: '20px 0' },
  }));
}

function resultRow(item) {
  const art = el('span', { class: 'art placeholder' }, icon('note'));
  const img = el('img', { src: item.thumb, alt: '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('load', () => { clear(art); art.classList.remove('placeholder'); art.append(img); });

  const sub = el('span', { class: 'row-sub' });
  if (item.license) sub.append(el('span', { class: 'badge', text: item.license }));
  sub.append(el('span', { text: item.artist + (item.year ? ' · ' + item.year : '') }));

  const row = el('button', { class: 'row' },
    art,
    el('span', { class: 'row-text' }, el('span', { class: 'row-title', text: item.title }), sub),
    el('span', { class: 'leader', 'aria-hidden': 'true' }),
    el('span', { class: 'icon-btn row-more' }, icon('download')));

  row.addEventListener('click', () => { press(); openRelease(item); });
  return row;
}

/* ------------------------------------------------------------- the sheet */

async function openRelease(item) {
  let sheetBody = null;
  menuSheet(null, [], (() => {
    sheetBody = el('div', {},
      el('h2', { text: item.title }),
      el('div', { class: 'empty', style: { padding: '30px 0' } },
        el('span', { class: 'spinner', style: { margin: '0 auto' } })));
    return sheetBody;
  })());

  let rel;
  try {
    rel = await release(item.id);
  } catch (err) {
    clear(sheetBody);
    sheetBody.append(el('h2', { text: item.title }),
      el('p', { text: err.message || 'Could not load that release.', style: { color: 'var(--text-dim)' } }));
    return;
  }

  clear(sheetBody);
  sheetBody.append(releaseView(rel));
}

function releaseView(rel) {
  const wrap = el('div', {});

  const cover = el('span', { class: 'art', style: { width: '76px', height: '76px' } },
    el('img', { src: rel.thumb, alt: '' }));

  const facts = el('div', { style: { minWidth: 0 } },
    el('div', { class: 'row-title', style: { fontSize: '19px' }, text: rel.title }),
    el('div', { class: 'np-sub', style: { marginTop: '5px' }, text: rel.artist }));

  if (rel.best) {
    facts.append(el('div', { style: { marginTop: '8px' } },
      el('span', { class: 'badge' + (rel.best.tier === 'hi-res' || rel.best.tier === 'lossless' ? ' hi' : ''), text: rel.best.label })));
  }

  wrap.append(el('div', { class: 'sheet-head' }, cover, facts));

  const meta = [
    rel.year && ['Released', rel.year],
    rel.genre && ['Tagged', rel.genre],
    rel.license && ['Licence', rel.license],
    ['Tracks', String(rel.tracks.length)],
  ].filter(Boolean);

  wrap.append(el('div', { class: 'card-box' }, meta.map(([k, v]) => el('div', { class: 'setting' },
    el('div', { class: 'setting-text' }, el('b', { text: k })),
    el('div', { class: 'setting-value', style: { maxWidth: '60%', textAlign: 'right' }, text: v })))));

  if (rel.description) {
    wrap.append(el('p', {
      text: rel.description,
      style: { fontSize: '13px', color: 'var(--text-dim)', lineHeight: '1.6', marginTop: '14px' },
    }));
  }

  if (!rel.downloadable) {
    wrap.append(el('div', { class: 'notice', style: { marginTop: '16px' } }, icon('x'),
      el('div', {}, el('b', { text: 'Not available to download' }),
        el('span', { text: 'The archive marks this item as restricted, so it can only be played on its own page.' }))));
    return wrap;
  }

  const status = el('div', { class: 'convert-status', style: { marginTop: '10px', textAlign: 'center' } });
  const bar = el('div', { class: 'bar', style: { marginTop: '8px' } }, el('i'));
  bar.hidden = true;

  const all = el('button', { class: 'btn wide primary', style: { marginTop: '16px' } },
    icon('download', 18), el('span', { text: 'Download all ' + rel.tracks.length }));

  all.addEventListener('click', async () => {
    all.disabled = true;
    bar.hidden = false;
    let added = 0;
    let skipped = 0;

    for (let i = 0; i < rel.tracks.length; i++) {
      const track = rel.tracks[i];
      status.textContent = 'Track ' + (i + 1) + ' of ' + rel.tracks.length + ' · ' + track.title;
      try {
        await fetchTrack(rel, track, {
          onProgress: (loaded, total) => {
            const share = total ? loaded / total : 0;
            bar.firstChild.style.width = (((i + share) / rel.tracks.length) * 100) + '%';
          },
        });
        added++;
      } catch (err) {
        if (/already in your library/.test(err.message || '')) skipped++;
        else { status.textContent = err.message; break; }
      }
    }

    bar.firstChild.style.width = '100%';
    status.classList.add('done');
    status.textContent = plural(added, 'track') + ' added' + (skipped ? ', ' + skipped + ' already here' : '');
    needleDrop();
    toast(plural(added, 'track') + ' added to your library', { detail: rel.title });
    all.disabled = false;
  });

  wrap.append(all, bar, status);
  wrap.append(el('h2', { class: 'section-title', text: 'Tracks' }));

  const rows = el('div', { class: 'rows' });
  rel.tracks.forEach((track, index) => {
    const line = el('div', { class: 'row' },
      el('span', { class: 'row-index', text: String(track.track || index + 1).padStart(2, '0') }),
      el('span', { class: 'row-text' },
        el('span', { class: 'row-title', style: { fontSize: '15px' }, text: track.title }),
        el('span', { class: 'row-sub' },
          el('span', { class: 'badge' + (track.grade.rank >= 4 ? ' hi' : ''), text: track.grade.label }),
          el('span', { text: track.size ? formatBytes(track.size) : '' }))),
      el('span', { class: 'leader', 'aria-hidden': 'true' }),
      el('span', { class: 'row-time num', text: track.seconds ? formatTime(track.seconds) : '' }));

    const get = el('button', { class: 'icon-btn row-more', 'aria-label': 'Download ' + track.title }, icon('download'));
    get.addEventListener('click', async () => {
      get.disabled = true;
      tick();
      try {
        await fetchTrack(rel, track, { liked: false });
        clear(get);
        get.append(icon('check'));
        needleDrop();
        toast('Added', { detail: track.title });
      } catch (err) {
        get.disabled = false;
        toast('Could not download', { detail: err.message, error: true });
      }
    });
    line.append(get);
    rows.append(line);
  });

  wrap.append(rows);
  wrap.append(el('button', {
    class: 'btn wide secondary',
    style: { marginTop: '14px' },
    text: 'Close',
    onclick: () => closeSheet(),
  }));
  return wrap;
}
