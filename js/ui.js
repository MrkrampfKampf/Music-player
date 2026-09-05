/**
 * Shared UI plumbing: element building, artwork URLs, sheets, toasts and the
 * colour extraction that tints the Now Playing screen to match the album art.
 */

import * as db from './db.js';

/* ------------------------------------------------------------------ markup */

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function icon(name, size) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (size) { svg.style.width = size + 'px'; svg.style.height = size + 'px'; }
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/* ---------------------------------------------------------------- artwork */

const artUrls = new Map();
const artPending = new Map();

/** Object URL for a stored cover, cached so a list of 40 rows shares one. */
export async function artworkUrl(key) {
  if (!key) return null;
  if (artUrls.has(key)) return artUrls.get(key);
  if (artPending.has(key)) return artPending.get(key);

  const promise = db.getArtwork(key).then((blob) => {
    if (!blob) { artUrls.set(key, null); return null; }
    const url = URL.createObjectURL(blob);
    artUrls.set(key, url);
    artPending.delete(key);
    return url;
  });
  artPending.set(key, promise);
  return promise;
}

export function forgetArtwork(key) {
  const url = artUrls.get(key);
  if (url) URL.revokeObjectURL(url);
  artUrls.delete(key);
}

/**
 * An <span class="art"> that fills in its image once the blob is read.
 *
 * The fill must not depend on the node already being in the document: callers
 * routinely build a whole subtree and append it a tick later, and an
 * isConnected check here would lose that race and leave a placeholder.
 */
export function artNode(key, extraClass = '') {
  const wrap = el('span', { class: 'art placeholder ' + extraClass });
  wrap.append(icon('note'));
  if (key) {
    artworkUrl(key).then((url) => {
      if (!url) return;
      clear(wrap);
      wrap.classList.remove('placeholder');
      wrap.append(el('img', { src: url, alt: '', loading: 'lazy', decoding: 'async' }));
    });
  }
  return wrap;
}

/* -------------------------------------------------------------- formatting */

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return m + ':' + String(s).padStart(2, '0');
}

export function formatDurationLong(seconds) {
  const total = Math.round(seconds || 0);
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h > 0) return h + ' hr ' + m + ' min';
  if (m > 0) return m + ' min';
  return total + ' sec';
}

export function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return (value >= 100 || i <= 1 ? Math.round(value) : value.toFixed(1)) + ' ' + units[i];
}

export function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : (many || one + 's'));
}

/** A short quality label, e.g. "FLAC 24/96" or "MP3 320". */
export function qualityLabel(track) {
  if (!track) return '';
  const parts = [];
  if (track.codec) parts.push(track.codec.split(' ')[0]);
  if (track.lossless && track.bitDepth && track.sampleRate) {
    parts.push(track.bitDepth + '/' + Math.round(track.sampleRate / 1000));
  } else if (track.bitrate) {
    parts.push(Math.round(track.bitrate / 1000).toString());
  }
  return parts.join(' ');
}

export function isHiRes(track) {
  return !!(track && track.lossless && (track.sampleRate > 48000 || track.bitDepth > 16));
}

/* ------------------------------------------------------------------ sheets */

const sheetHost = () => document.getElementById('sheet-host');
const sheetBody = () => document.getElementById('sheet');
let sheetCloser = null;

/** Show a bottom sheet. `build` receives a close() it can call. */
export function openSheet(build) {
  const host = sheetHost();
  const body = clear(sheetBody());
  const close = () => closeSheet();
  sheetCloser = close;
  build(body, close);
  host.hidden = false;
  document.body.style.overflow = 'hidden';
  return close;
}

export function closeSheet() {
  const host = sheetHost();
  if (!host || host.hidden) return;
  host.hidden = true;
  clear(sheetBody());
  document.body.style.overflow = '';
  sheetCloser = null;
}

export function isSheetOpen() {
  const host = sheetHost();
  return !!host && !host.hidden;
}

/** A list of tappable rows. Each item: { label, icon, onSelect, destructive, checked } */
export function menuSheet(title, items, headerNode) {
  return openSheet((body, close) => {
    if (headerNode) body.append(headerNode);
    else if (title) body.append(el('h2', { text: title }));

    for (const item of items) {
      if (!item) continue;
      const row = el('button', {
        class: 'menu-item' + (item.destructive ? ' destructive' : ''),
        onclick: () => { close(); setTimeout(() => item.onSelect(), 60); },
      }, item.icon ? icon(item.icon) : el('span', { style: { width: '21px' } }), el('span', { text: item.label }));
      if (item.checked) row.append(el('span', { class: 'check' }, icon('check', 20)));
      body.append(row);
    }
  });
}

/** A yes/no sheet. Resolves true when the confirming button is tapped. */
export function confirmSheet({ title, message, confirmLabel = 'Confirm', destructive = false }) {
  return new Promise((resolve) => {
    let settled = false;
    openSheet((body, close) => {
      body.append(el('h2', { text: title }));
      if (message) body.append(el('p', { text: message, style: { color: 'var(--text-dim)', margin: '0 0 18px', lineHeight: '1.5' } }));
      body.append(el('button', {
        class: 'btn wide' + (destructive ? ' danger' : ''),
        text: confirmLabel,
        onclick: () => { settled = true; close(); resolve(true); },
      }));
      body.append(el('button', {
        class: 'btn wide secondary',
        text: 'Cancel',
        style: { marginTop: '10px' },
        onclick: () => { settled = true; close(); resolve(false); },
      }));
      const observer = new MutationObserver(() => {
        if (sheetHost().hidden && !settled) { settled = true; observer.disconnect(); resolve(false); }
      });
      observer.observe(sheetHost(), { attributes: true, attributeFilter: ['hidden'] });
    });
  });
}

/** A single text field sheet. Resolves the trimmed value, or null. */
export function promptSheet({ title, label, value = '', placeholder = '', confirmLabel = 'Save', multiline = false }) {
  return new Promise((resolve) => {
    let settled = false;
    openSheet((body, close) => {
      body.append(el('h2', { text: title }));
      const input = multiline
        ? el('textarea', { placeholder })
        : el('input', { type: 'text', value, placeholder, autocapitalize: 'sentences' });
      if (multiline) input.value = value;
      body.append(el('div', { class: 'field' }, label ? el('label', { text: label }) : null, input));
      body.append(el('button', {
        class: 'btn wide',
        text: confirmLabel,
        onclick: () => { settled = true; const v = input.value.trim(); close(); resolve(v || null); },
      }));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !multiline) {
          settled = true;
          const v = input.value.trim();
          close();
          resolve(v || null);
        }
      });
      setTimeout(() => input.focus(), 120);
      const observer = new MutationObserver(() => {
        if (sheetHost().hidden && !settled) { settled = true; observer.disconnect(); resolve(null); }
      });
      observer.observe(sheetHost(), { attributes: true, attributeFilter: ['hidden'] });
    });
  });
}

/* ------------------------------------------------------------------ toasts */

export function toast(message, { detail = '', error = false, duration = 3600 } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = el('div', { class: 'toast' + (error ? ' error' : '') },
    el('div', {}, el('b', { text: message }), detail ? el('span', { text: detail }) : null));
  host.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity 0.25s, transform 0.25s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px)';
    setTimeout(() => node.remove(), 260);
  }, duration);
}

/* -------------------------------------------------------- colour extraction */

const colourCache = new Map();

/**
 * Average the most saturated pixels of a cover to get an accent colour.
 * Downsamples to 24x24 first, so this is a few hundred pixels of work.
 */
export async function accentFromArtwork(key) {
  if (!key) return null;
  if (colourCache.has(key)) return colourCache.get(key);

  const url = await artworkUrl(key);
  if (!url) return null;

  try {
    const bitmap = await loadImage(url);
    const size = 24;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);

    let best = null;
    let bestScore = -1;
    let rSum = 0, gSum = 0, bSum = 0, n = 0;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

      // Skip near-black and near-white pixels; they make for a dull accent.
      if (lum < 0.12 || lum > 0.94) continue;
      rSum += r; gSum += g; bSum += b; n++;

      const score = sat * 1.6 + (1 - Math.abs(lum - 0.55)) * 0.6;
      if (score > bestScore) { bestScore = score; best = [r, g, b]; }
    }

    if (!best && n) best = [rSum / n, gSum / n, bSum / n];
    if (!best) return null;

    const accent = liftForContrast(best);
    colourCache.set(key, accent);
    return accent;
  } catch {
    return null;
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** Push a colour towards a lightness that stays readable on a dark ground. */
function liftForContrast([r, g, b]) {
  let [h, s, l] = rgbToHsl(r, g, b);
  s = Math.min(1, Math.max(0.45, s * 1.25));
  l = Math.min(0.72, Math.max(0.52, l));
  const [nr, ng, nb] = hslToRgb(h, s, l);
  return { hex: rgbToHex(nr, ng, nb), rgb: [nr, ng, nb] };
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(channel(h + 1 / 3) * 255),
    Math.round(channel(h) * 255),
    Math.round(channel(h - 1 / 3) * 255),
  ];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

/* -------------------------------------------------------------- range fill */

/** Paint the filled portion of a range input, which CSS alone cannot do. */
export function paintRange(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value || 0);
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--pct', pct + '%');
}

export function bindRangePaint(input) {
  paintRange(input);
  input.addEventListener('input', () => paintRange(input));
}

/* ------------------------------------------------------------ drag to sort */

/**
 * Long-press drag reordering for a list, using pointer events so it works
 * with touch. Calls onReorder(from, to) once the drop lands.
 */
export function makeSortable(list, { handleSelector = '.drag-handle', onReorder }) {
  let dragging = null;
  let startIndex = -1;
  let lastTarget = null;

  list.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest(handleSelector);
    if (!handle) return;
    const item = handle.closest('li');
    if (!item) return;

    event.preventDefault();
    dragging = item;
    startIndex = [...list.children].indexOf(item);
    item.classList.add('dragging');
    handle.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => {
      const under = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const target = under && under.closest('li');
      if (!target || target === dragging || target.parentElement !== list) return;
      if (lastTarget) lastTarget.classList.remove('drop-target');
      lastTarget = target;
      target.classList.add('drop-target');
    };

    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      item.classList.remove('dragging');
      if (lastTarget) lastTarget.classList.remove('drop-target');

      if (lastTarget && lastTarget !== dragging) {
        const endIndex = [...list.children].indexOf(lastTarget);
        if (endIndex >= 0 && endIndex !== startIndex) onReorder(startIndex, endIndex);
      }
      dragging = null;
      lastTarget = null;
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}
