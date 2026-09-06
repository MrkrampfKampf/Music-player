/**
 * Settings: persisted preferences plus the Settings view.
 */

import * as db from './db.js';
import { player, EQ_BANDS, EQ_PRESETS } from './player.js';
import { library } from './library.js';
import {
  el, icon, clear, toast, formatBytes, menuSheet, confirmSheet, promptSheet,
  bindRangePaint, paintRange, plural,
} from './ui.js';
import { configureTactile, flip, tick, asButton } from './tactile.js';

export const settings = {
  theme: 'dark',
  quality: 'original',
  serverUrl: '',
  serverToken: '',
  crossfade: 0,
  eqEnabled: false,
  eqPreset: 'Flat',
  eqGains: EQ_PRESETS.Flat.slice(),
  preamp: 0,
  resumeOnLaunch: true,
  volume: 1,
  haptics: true,
  uiSound: true,
};

export async function loadSettings() {
  const stored = await db.getSetting('prefs', null);
  if (stored) Object.assign(settings, stored);
  applyTheme();

  player.setRate(1);
  player.volume = settings.volume;
  player.eqGains = settings.eqGains.slice();
  player.preampDb = settings.preamp;
  if (settings.eqEnabled) player.setEqEnabled(true);
  if (settings.crossfade > 0) player.setCrossfade(settings.crossfade);
  configureTactile({ haptics: settings.haptics, sound: settings.uiSound });
}

export async function saveSettings() {
  await db.setSetting('prefs', { ...settings });
}

export function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', settings.theme);
}

/* ------------------------------------------------------------------- view */

export async function renderSettings(host) {
  clear(host);

  host.append(await playbackGroup());
  host.append(audioGroup(host));
  host.append(converterGroup(host));
  host.append(feelGroup(host));
  host.append(appearanceGroup(host));
  host.append(await storageGroup(host));
  host.append(aboutGroup());
}

function group(title, ...children) {
  return el('section', { class: 'settings-group' },
    el('h2', { text: title }),
    el('div', { class: 'card-box' }, children.flat().filter(Boolean)));
}

function toggleRow(label, description, checked, onChange) {
  const sw = el('span', { class: 'switch', role: 'switch', 'aria-checked': String(checked) });
  const row = el('button', { class: 'setting' },
    el('div', { class: 'setting-text' }, el('b', { text: label }), description ? el('span', { text: description }) : null),
    sw);
  row.addEventListener('click', () => {
    const next = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', String(next));
    flip();
    onChange(next);
  });
  return row;
}

function valueRow(label, description, value, onSelect) {
  return el('button', { class: 'setting', onclick: onSelect },
    el('div', { class: 'setting-text' }, el('b', { text: label }), description ? el('span', { text: description }) : null),
    el('div', { class: 'setting-value', text: value }));
}

/* --------------------------------------------------------------- playback */

async function playbackGroup() {
  return group('Playback',
    toggleRow('Resume on launch', 'Pick up where you left off when the app opens.',
      settings.resumeOnLaunch, async (on) => { settings.resumeOnLaunch = on; await saveSettings(); }),

    valueRow('Crossfade', 'Blend the end of one song into the next.',
      settings.crossfade ? settings.crossfade + 's' : 'Off',
      () => menuSheet('Crossfade', [0, 2, 3, 5, 8, 12].map((seconds) => ({
        label: seconds ? seconds + ' seconds' : 'Off',
        icon: 'speed',
        checked: settings.crossfade === seconds,
        onSelect: async () => {
          settings.crossfade = seconds;
          player.setCrossfade(seconds);
          await saveSettings();
          renderSettings(document.getElementById('settings-body'));
          if (seconds) {
            toast('Crossfade on', { detail: 'This routes audio through the mixer, which resamples. Turn it off for bit-perfect playback.', duration: 6000 });
          }
        },
      })))),

    valueRow('Sleep timer', 'Fade out and pause after a while.',
      sleepLabel(),
      () => menuSheet('Sleep Timer', [
        ...[5, 10, 15, 30, 45, 60, 90].map((minutes) => ({
          label: minutes + ' minutes',
          icon: 'clock',
          onSelect: () => {
            player.startSleepTimer(minutes);
            toast('Sleeping in ' + minutes + ' minutes');
            renderSettings(document.getElementById('settings-body'));
          },
        })),
        {
          label: 'When this song ends',
          icon: 'clock',
          onSelect: () => {
            player.startSleepTimer(0, true);
            toast('Will stop after this song');
            renderSettings(document.getElementById('settings-body'));
          },
        },
        {
          label: 'Off',
          icon: 'x',
          onSelect: () => {
            player.cancelSleepTimer();
            renderSettings(document.getElementById('settings-body'));
          },
        },
      ])));
}

function sleepLabel() {
  if (player.stopAfterTrack) return 'End of song';
  const remaining = player.sleepRemaining;
  if (remaining > 0) return Math.ceil(remaining / 60000) + ' min';
  return 'Off';
}

/* ------------------------------------------------------------------ audio */

function audioGroup(host) {
  const eqRow = toggleRow('Equaliser', 'Ten bands with presets.', settings.eqEnabled, async (on) => {
    settings.eqEnabled = on;
    player.setEqEnabled(on);
    await saveSettings();
    renderSettings(host);
    if (on) {
      toast('Equaliser on', {
        detail: 'Audio now goes through the mixer, which resamples it. Turn the equaliser off for bit-perfect playback.',
        duration: 6500,
      });
    }
  });

  const children = [
    el('div', { class: 'setting', style: { display: 'block' } },
      el('div', { class: 'setting-text', style: { marginBottom: '4px' } },
        el('b', { text: 'Bit-perfect by default' }),
        el('span', {
          text: settings.eqEnabled || settings.crossfade
            ? 'Currently off: the equaliser or crossfade is routing audio through the mixer.'
            : 'On. Your files play exactly as stored, with nothing in the signal path.',
        }))),
    eqRow,
  ];

  if (settings.eqEnabled) {
    children.push(valueRow('Preset', null, settings.eqPreset,
      () => menuSheet('Equaliser Preset', Object.keys(EQ_PRESETS).map((name) => ({
        label: name,
        icon: 'eq',
        checked: settings.eqPreset === name,
        onSelect: async () => {
          settings.eqPreset = name;
          settings.eqGains = EQ_PRESETS[name].slice();
          player.setEqGains(settings.eqGains);
          await saveSettings();
          renderSettings(host);
        },
      })))));
    children.push(eqSliders(host));
  }

  return group('Audio', children);
}

function eqSliders(host) {
  const wrap = el('div', { class: 'eq-desk' });
  const bands = el('div', { class: 'eq-bands' });

  // The fader cap is positioned from the value, so the desk reads at a glance
  // the way a real one does: the shape of the curve is the setting.
  const capOffset = (gain) => {
    const travel = 118 - 15;                  // slot height minus cap height
    return (travel * (12 - gain)) / 24;
  };

  EQ_BANDS.forEach((freq, index) => {
    const value = el('span', { class: 'val', text: fmtGain(settings.eqGains[index]) });
    const cap = el('span', { class: 'cap' });
    cap.style.setProperty('--capY', capOffset(settings.eqGains[index]) + 'px');

    const slider = el('input', {
      type: 'range',
      min: '-12',
      max: '12',
      step: '0.5',
      value: String(settings.eqGains[index]),
      'aria-label': freqLabel(freq) + ' band',
    });

    let lastNotch = Math.round(settings.eqGains[index]);
    slider.addEventListener('input', () => {
      const gain = Number(slider.value);
      const notch = Math.round(gain);
      if (notch !== lastNotch) { lastNotch = notch; tick(); }
      settings.eqGains[index] = gain;
      settings.eqPreset = 'Custom';
      value.textContent = fmtGain(gain);
      cap.style.setProperty('--capY', capOffset(gain) + 'px');
      player.setEqGains(settings.eqGains);
    });
    slider.addEventListener('change', saveSettings);

    bands.append(el('div', { class: 'eq-band' },
      value,
      el('span', { class: 'slot' }, slider, cap),
      el('label', { text: freqLabel(freq) })));
  });

  wrap.append(bands);

  const preamp = el('input', {
    type: 'range', min: '-12', max: '12', step: '0.5',
    value: String(settings.preamp), 'aria-label': 'Preamp',
  });
  const preampValue = el('span', { class: 'setting-value', text: fmtGain(settings.preamp) + ' dB' });
  bindRangePaint(preamp);
  preamp.addEventListener('input', () => {
    settings.preamp = Number(preamp.value);
    preampValue.textContent = fmtGain(settings.preamp) + ' dB';
    player.setPreamp(settings.preamp);
    paintRange(preamp);
  });
  preamp.addEventListener('change', saveSettings);

  wrap.append(el('div', { class: 'desk-row' }, el('b', { text: 'Gain' }), preamp, preampValue));

  wrap.append(el('button', {
    class: 'btn secondary wide',
    text: 'Zero the desk',
    style: { marginTop: '10px' },
    onclick: async () => {
      settings.eqPreset = 'Flat';
      settings.eqGains = EQ_PRESETS.Flat.slice();
      settings.preamp = 0;
      player.setEqGains(settings.eqGains);
      player.setPreamp(0);
      await saveSettings();
      renderSettings(host);
    },
  }));

  return wrap;
}

function fmtGain(value) {
  return (value > 0 ? '+' : '') + value;
}

function freqLabel(freq) {
  return freq >= 1000 ? (freq / 1000) + 'k' : String(freq);
}

/* -------------------------------------------------------------- converter */

function converterGroup(host) {
  return group('Converter server',
    valueRow('Server address', 'Where links get converted. Must be HTTPS.',
      settings.serverUrl ? shortHost(settings.serverUrl) : 'Not set',
      async () => {
        const value = await promptSheet({
          title: 'Converter server',
          label: 'Address',
          value: settings.serverUrl,
          placeholder: 'https://my-converter.onrender.com',
        });
        if (value === null) return;
        settings.serverUrl = value.replace(/\/+$/, '');
        await saveSettings();
        renderSettings(host);
      }),

    valueRow('Access token', 'The token the server was started with.',
      settings.serverToken ? 'Set' : 'None',
      async () => {
        const value = await promptSheet({
          title: 'Access token',
          label: 'Token',
          value: settings.serverToken,
          placeholder: 'Leave empty if the server has none',
        });
        if (value === null) return;
        settings.serverToken = value;
        await saveSettings();
        renderSettings(host);
      }),

    el('button', {
      class: 'setting',
      onclick: async () => {
        const { Converter } = await import('./converter.js');
        const result = await new Converter(settings).ping();
        if (result.ok) {
          const info = result.info || {};
          toast('Server is up', {
            detail: [info.version ? 'v' + info.version : '', info.extractor ? 'extractor: ' + info.extractor : '']
              .filter(Boolean).join(' · '),
          });
        } else {
          toast('Could not reach the server', { detail: result.reason, error: true, duration: 7000 });
        }
      },
    }, el('div', { class: 'setting-text' }, el('b', { text: 'Test connection' }))),

    el('div', { class: 'setting', style: { display: 'block' } },
      el('div', { class: 'setting-text' },
        el('span', {
          text: 'Without a server, only links that point straight at a media file work. '
            + 'Setup instructions are in server/README.md in the project.',
        }))));
}

function shortHost(url) {
  try { return new URL(url).host; } catch { return url; }
}

/* ------------------------------------------------------------- appearance */

function feelGroup(host) {
  return group('Feel',
    toggleRow('Haptics', 'A tap for a key, a bump for a switch, ticks along the grooves.',
      settings.haptics, async (on) => {
        settings.haptics = on;
        configureTactile({ haptics: on });
        await saveSettings();
      }),
    toggleRow('Mechanical sounds', 'Quiet clicks and knocks from the controls. Synthesised, nothing to download.',
      settings.uiSound, async (on) => {
        settings.uiSound = on;
        configureTactile({ sound: on });
        await saveSettings();
      }),
    el('div', { class: 'setting', style: { display: 'block' } },
      el('div', { class: 'setting-text' },
        el('span', {
          text: 'Haptics need iOS 17.4 or later, and only work once the app is on '
            + 'your Home Screen. Sounds are separate from playback and never touch '
            + 'the bit-perfect route.',
        }))));
}

function appearanceGroup(host) {
  return group('Appearance',
    valueRow('Theme', null, { dark: 'Dark', light: 'Light', auto: 'Match system' }[settings.theme],
      () => menuSheet('Theme', [
        { label: 'Dark', icon: 'note', checked: settings.theme === 'dark', onSelect: () => setTheme('dark', host) },
        { label: 'Light', icon: 'note', checked: settings.theme === 'light', onSelect: () => setTheme('light', host) },
        { label: 'Match system', icon: 'gear', checked: settings.theme === 'auto', onSelect: () => setTheme('auto', host) },
      ])));
}

async function setTheme(theme, host) {
  settings.theme = theme;
  applyTheme();
  await saveSettings();
  renderSettings(host);
}

/* ---------------------------------------------------------------- storage */

async function storageGroup(host) {
  const estimate = await db.storageEstimate();
  const persisted = navigator.storage && navigator.storage.persisted
    ? await navigator.storage.persisted().catch(() => false)
    : false;

  const librarySize = library.tracks.reduce((sum, t) => sum + (t.size || 0), 0);

  const children = [];

  if (estimate && estimate.quota) {
    const pct = Math.min(100, (estimate.usage / estimate.quota) * 100);
    children.push(el('div', { class: 'setting', style: { display: 'block' } },
      el('div', { class: 'setting-text' },
        el('b', { text: formatBytes(estimate.usage) + ' used' }),
        el('span', { text: 'of about ' + formatBytes(estimate.quota) + ' available to this app' })),
      el('div', { class: 'storage-bar' }, el('i', { style: { width: pct + '%' } }))));
  }

  children.push(el('div', { class: 'setting' },
    el('div', { class: 'setting-text' },
      el('b', { text: 'Library' }),
      el('span', { text: plural(library.tracks.length, 'track') + ' · ' + plural(library.playlists.length, 'playlist') })),
    el('div', { class: 'setting-value', text: formatBytes(librarySize) })));

  if (!persisted) {
    children.push(el('button', {
      class: 'setting',
      onclick: async () => {
        const granted = await db.requestPersistence();
        toast(granted ? 'Storage protected' : 'iOS did not grant it', {
          detail: granted
            ? 'Your library will not be cleared automatically.'
            : 'Adding the app to your Home Screen and using it regularly usually earns this.',
          duration: 6000,
        });
        renderSettings(host);
      },
    },
    el('div', { class: 'setting-text' },
      el('b', { text: 'Protect my library' }),
      el('span', { text: 'Ask iOS not to clear this app when storage runs low.' }))));
  } else {
    children.push(el('div', { class: 'setting' },
      el('div', { class: 'setting-text' },
        el('b', { text: 'Storage is protected' }),
        el('span', { text: 'iOS will not clear this app automatically.' })),
      el('div', { class: 'setting-value' }, icon('check', 20))));
  }

  children.push(el('button', {
    class: 'setting',
    onclick: exportBackup,
  }, el('div', { class: 'setting-text' },
    el('b', { text: 'Export library details' }),
    el('span', { text: 'A JSON file of your tracks, playlists and settings. Audio files are not included.' }))));

  children.push(el('button', {
    class: 'setting destructive',
    onclick: async () => {
      const yes = await confirmSheet({
        title: 'Delete everything?',
        message: 'Every song, playlist and setting will be removed from this device. This cannot be undone.',
        confirmLabel: 'Delete everything',
        destructive: true,
      });
      if (!yes) return;
      player.stop();
      await db.wipeEverything();
      await library.load();
      toast('Library cleared');
      renderSettings(host);
    },
  }, el('div', { class: 'setting-text' },
    el('b', { text: 'Delete all content', style: { color: 'var(--danger)' } }),
    el('span', { text: 'Wipes the library and starts over.' }))));

  return group('Storage', children);
}

async function exportBackup() {
  const backup = await library.exportBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const name = 'resonate-library-' + new Date().toISOString().slice(0, 10) + '.json';
  const file = new File([blob], name, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Library backup' }); return; }
    catch (err) { if (err && err.name === 'AbortError') return; }
  }

  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ------------------------------------------------------------------ about */

function aboutGroup() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

  return group('About',
    !standalone ? el('div', { class: 'setting', style: { display: 'block' } },
      el('div', { class: 'setting-text' },
        el('b', { text: 'Add to your Home Screen' }),
        el('span', {
          text: 'Tap the Share button in Safari, then "Add to Home Screen". '
            + 'The app then runs full screen and keeps your library safely.',
        }))) : null,

    el('div', { class: 'setting' },
      el('div', { class: 'setting-text' }, el('b', { text: 'Everything stays on this device' }),
        el('span', { text: 'No account, no sync, no analytics. Your files never leave your iPhone.' }))),

    el('div', { class: 'setting' },
      el('div', { class: 'setting-text' }, el('b', { text: 'Resonate' })),
      el('div', { class: 'setting-value', text: 'v1.0' })));
}
