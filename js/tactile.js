/**
 * Touch, click and haptics for the physical controls.
 *
 * Every gesture that moves a part gets feedback matched to what that part
 * would actually do: a button clicks, a switch bumps, a knob ticks, the
 * stylus lands with a thud. Nothing fires on a plain tap of flat UI.
 *
 * Sound is synthesised, so there are no assets and nothing to load offline.
 * It runs in its own small AudioContext at low gain, kept apart from the
 * playback path so the bit-perfect route stays untouched.
 */

let hapticsOn = true;
let soundOn = true;
let ctx = null;
let bus = null;
let iosSwitch = null;

export function configureTactile({ haptics, sound }) {
  if (haptics != null) hapticsOn = !!haptics;
  if (sound != null) soundOn = !!sound;
}

/* ------------------------------------------------------------- haptics */

/**
 * iOS has no vibrate API, but Safari 17.4 added the switch checkbox, and
 * toggling one produces the system's own light tap. A hidden one is the only
 * way a web page gets haptics on an iPhone at all.
 */
function iosTap() {
  try {
    if (!iosSwitch) {
      const label = document.createElement('label');
      label.setAttribute('aria-hidden', 'true');
      label.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none;overflow:hidden';
      iosSwitch = document.createElement('input');
      iosSwitch.type = 'checkbox';
      iosSwitch.setAttribute('switch', '');
      iosSwitch.tabIndex = -1;
      label.append(iosSwitch);
      document.body.append(label);
    }
    iosSwitch.click();
    return true;
  } catch {
    return false;
  }
}

function buzz(pattern) {
  if (!hapticsOn) return;
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); return; } catch { /* blocked */ }
  }
  iosTap();
}

/* --------------------------------------------------------------- sound */

function audio() {
  if (ctx) return ctx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    ctx = new Ctx();
    bus = ctx.createGain();
    bus.gain.value = 0.16;
    bus.connect(ctx.destination);
  } catch {
    ctx = null;
  }
  return ctx;
}

/** A burst of filtered noise: the body of any mechanical knock. */
function knock({ freq = 1400, q = 2.4, decay = 0.045, level = 1, type = 'bandpass' } = {}) {
  if (!soundOn) return;
  const c = audio();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});

  const frames = Math.ceil(c.sampleRate * decay);
  const buffer = c.createBuffer(1, frames, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    // Exponential decay, so it reads as a strike rather than a hiss.
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 3.5);
  }

  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const gain = c.createGain();
  gain.gain.value = level;

  src.connect(filter).connect(gain).connect(bus);
  src.start();
}

/* -------------------------------------------------------------- gestures */

/** A pushbutton bottoming out. */
export function press() {
  buzz(8);
  knock({ freq: 2100, q: 1.6, decay: 0.03, level: 0.85 });
}

/** The same button coming back up, quieter and higher. */
export function release() {
  knock({ freq: 3000, q: 1.2, decay: 0.018, level: 0.4 });
}

/** A toggle throwing over its detent. */
export function flip() {
  buzz([12, 18, 8]);
  knock({ freq: 950, q: 3.2, decay: 0.055, level: 1 });
  setTimeout(() => knock({ freq: 1800, q: 2, decay: 0.025, level: 0.5 }), 34);
}

/** One notch of a knob or one groove under a dragged stylus. */
export function tick() {
  buzz(4);
  knock({ freq: 4200, q: 6, decay: 0.012, level: 0.3 });
}

/** The stylus landing on a record: low, soft, with a little surface noise. */
export function needleDrop() {
  buzz([16, 26, 30]);
  knock({ freq: 220, q: 1.1, decay: 0.16, level: 1 });
  knock({ freq: 3200, q: 0.7, decay: 0.34, level: 0.14, type: 'highpass' });
}

/** The cue lever seating at one end of its throw. */
export function lever() {
  buzz([10, 14, 16]);
  knock({ freq: 640, q: 2.6, decay: 0.07, level: 1 });
}

/** Something refusing to move. */
export function bump() {
  buzz([18, 30, 18]);
  knock({ freq: 420, q: 4, decay: 0.09, level: 0.8 });
}

/**
 * Wire a plain element up as a pushbutton: it depresses, clicks and springs
 * back. Used for the transport keys and anything else meant to feel switched.
 */
export function asButton(el, { sound = press, up = release } = {}) {
  if (!el || el.dataset.tactile) return;
  el.dataset.tactile = '1';
  el.addEventListener('pointerdown', () => { el.classList.add('pushed'); sound(); });
  const lift = () => {
    if (!el.classList.contains('pushed')) return;
    el.classList.remove('pushed');
    if (up) up();
  };
  el.addEventListener('pointerup', lift);
  el.addEventListener('pointerleave', lift);
  el.addEventListener('pointercancel', lift);
}
