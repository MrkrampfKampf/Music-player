/**
 * The room.
 *
 * Not a picture of a studio. A room: walls, a floor and a set of objects, all
 * of them real quads placed in a perspective projection, so they occlude one
 * another, take the lamp according to the way they face, and slide against
 * each other as the camera moves. There is no separate interface layer — the
 * equipment is the interface. The deck's arm is the playhead, the console's
 * faders are the equaliser, the guitar's capo chip is the progress bar, the
 * speakers are play and pause.
 *
 * Everything is built from DOM elements rather than one flat drawing, because
 * depth, occlusion and per-face lighting are things the browser can do for
 * real once the geometry is real.
 *
 * Coordinates: the origin is at eye height in the middle of the room, y grows
 * downward, z grows toward the viewer. The floor is at y = 300, the back wall
 * at z = -1000, and the desk top at y = 40.
 */

import { player } from './player.js';
import { library } from './library.js';
import { settings, saveSettings } from './settings.js';
import { press, tick, flip, needleDrop, lever } from './tactile.js';

const FLOOR = 300;
const BACK = -1000;
const DESK_Y = 40;
/** Eye height: standing at the desk, looking a little down at it. */
const BASE_Y = 168;

let room = null;
let world = null;
let raf = null;
let go = null;
let tip = null;
let detach = [];
// A control that was actually moved swallows the tap that ended it, so
// nudging a fader does not also walk you across the room.
let lastDrag = 0;

/* Where the camera is. Written straight onto the world, because that is the
   one transform that has to be exact. */
const cam = { x: 0, y: BASE_Y, z: 0, s: 1, px: 0, py: 0, tilt: -4 };

function applyCamera() {
  if (!world) return;
  world.style.transform =
    'scale3d(' + cam.s + ',' + cam.s + ',' + cam.s + ') '
    + 'translate3d(' + (cam.x + cam.px * -22) + 'px,'
    + (cam.y + cam.py * -12) + 'px,' + cam.z + 'px) '
    + 'rotateX(' + (cam.tilt + cam.py * 1.6) + 'deg) '
    + 'rotateY(' + (cam.px * -2.6) + 'deg)';
}

/* ------------------------------------------------------------------ making */

function make(tag, cls, style) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (style) for (const [k, v] of Object.entries(style)) node.style.setProperty(k, v);
  return node;
}

/**
 * One plane in the room. Position is its centre; `lit` is how much of the
 * lamp this face receives, which is the whole lighting model.
 */
function q(o) {
  const node = make('div', 'q ' + (o.cls || ''), {
    '--w': o.w + 'px',
    '--h': o.h + 'px',
    '--x': (o.x || 0) + 'px',
    '--y': (o.y || 0) + 'px',
    '--z': (o.z || 0) + 'px',
    '--rx': (o.rx || 0) + 'deg',
    '--ry': (o.ry || 0) + 'deg',
    '--rz': (o.rz || 0) + 'deg',
    '--lit': String(o.lit == null ? 0.1 : o.lit),
  });
  if (o.lx) node.style.setProperty('--lx', o.lx);
  if (o.ly) node.style.setProperty('--ly', o.ly);
  if (o.ao) node.style.setProperty('--ao', o.ao);
  if (o.css) for (const [k, v] of Object.entries(o.css)) node.style.setProperty(k, v);
  if (o.html) node.insertAdjacentHTML('beforeend', o.html);
  return node;
}

/** A rectangular solid: the three faces a viewer in this room can ever see. */
function boxSolid({ w, h, d, x = 0, y = 0, z = 0, ry = 0, cls = 'm-walnut', lit = 0.3, faces = {} }) {
  const g = make('div', 'grp', {
    '--x': x + 'px', '--y': y + 'px', '--z': z + 'px', '--ry': ry + 'deg',
  });
  g.append(
    q({ w, h, z: d / 2, cls, lit, html: faces.front || '' }),
    q({ w: d, h, x: -w / 2, ry: -90, cls, lit: lit * 0.45, html: faces.left || '' }),
    q({ w: d, h, x: w / 2, ry: 90, cls, lit: lit * 0.6, html: faces.right || '' }),
    q({ w, h: d, y: -h / 2, rx: 90, cls, lit: Math.min(1, lit * 1.7), html: faces.top || '' }),
  );
  return g;
}

/** An object that answers to a touch. */
function actor(name, label, o) {
  const g = make('div', 'obj live', {
    '--x': (o.x || 0) + 'px', '--y': (o.y || 0) + 'px', '--z': (o.z || 0) + 'px',
    '--ry': (o.ry || 0) + 'deg', '--rx': (o.rx || 0) + 'deg', '--rz': (o.rz || 0) + 'deg',
    // The reach of the object: a transparent plane at its own position, set
    // just behind its faces so its own controls always win the touch.
    '--hw': (o.hw || 220) + 'px', '--hh': (o.hh || 220) + 'px',
  });
  g.dataset.go = name;
  g.dataset.label = label;
  g.tabIndex = 0;
  g.setAttribute('role', 'button');
  g.setAttribute('aria-label', label);
  return g;
}

function shadow(x, z, w, h, soft = 14) {
  return make('div', 'shadow', {
    '--w': w + 'px', '--h': h + 'px',
    '--x': x + 'px', '--y': (FLOOR - 1) + 'px', '--z': z + 'px',
    '--soft': soft + 'px',
  });
}

/* ------------------------------------------------------------- the objects */

/** The shell: two walls, a floor and a ceiling the lamp hangs from. */
function shell() {
  const g = make('div', 'grp');
  g.append(
    q({ w: 2000, h: 1500, y: -400, z: BACK, cls: 'm-plaster grainy', lit: 0.07, lx: '50%', ly: '92%',
      ao: 'inset 0 -60px 90px rgba(0,0,0,0.75), inset 0 60px 80px rgba(0,0,0,0.6)' }),
    q({ w: 2400, h: 2000, y: FLOOR, z: -300, rx: 90, cls: 'm-boards', lit: 0.34, lx: '50%', ly: '38%',
      ao: 'inset 0 0 200px rgba(0,0,0,0.8)' }),
    q({ w: 2000, h: 1500, y: -400, x: -900, ry: 90, cls: 'm-plaster grainy', lit: 0.05,
      ao: 'inset 0 0 160px rgba(0,0,0,0.85)' }),
    q({ w: 2000, h: 1500, y: -400, x: 900, ry: -90, cls: 'm-plaster grainy', lit: 0.045,
      ao: 'inset 0 0 160px rgba(0,0,0,0.85)' }),
    q({ w: 2400, h: 1900, y: -1000, z: -300, rx: -90, cls: 'm-black', lit: 0.04 }),
  );

  // Acoustic panels, standing proud of the wall so they cast onto it.
  for (const [px, py, pw, ph] of [[-397, -320, 200, 300], [-234, -300, 200, 340], [305, -350, 220, 260]]) {
    g.append(boxSolid({
      w: pw, h: ph, d: 34, x: px, y: py, z: BACK + 17,
      cls: 'm-cloth', lit: 0.13,
    }));
  }

  // A shelf of records high on the wall, and a sleeve framed beside it.
  g.append(
    q({ w: 420, h: 22, x: -121, y: -452, z: BACK + 70, rx: 90, cls: 'm-walnut', lit: 0.24 }),
    q({ w: 420, h: 26, x: -121, y: -440, z: BACK + 130, cls: 'm-walnut', lit: 0.18 }),
    q({ w: 400, h: 120, x: -121, y: -513, z: BACK + 80, cls: 'flat', lit: 0,
      css: {
        background: 'repeating-linear-gradient(90deg,'
          + '#2b241c 0 5px, #120f0d 5px 7px, #43331f 7px 12px, #0f0c0a 12px 14px,'
          + '#35281c 14px 19px, #100d0b 19px 21px, #56381f 21px 27px, #0d0a09 27px 29px)',
        'box-shadow': 'inset 0 -14px 22px rgba(0,0,0,0.7)',
      } }),
    q({ w: 190, h: 190, x: 227, y: -520, z: BACK + 24, cls: 'flat',
      css: {
        background: 'linear-gradient(150deg, #6b4a2c, #2a1d13)',
        'box-shadow': 'inset 0 0 0 9px #14100e, 0 16px 30px rgba(0,0,0,0.6)',
      } }),
  );

  // A window in the back wall: a cold counter-light so the warm lamp is not
  // the only thing shaping the room.
  g.append(
    q({ w: 300, h: 380, x: 454, y: -260, z: BACK + 6, cls: 'flat',
      css: {
        background: 'linear-gradient(180deg, rgba(150,186,214,0.16), rgba(150,186,214,0.05) 62%, rgba(0,0,0,0))',
        'box-shadow': '0 0 90px 30px rgba(150,186,214,0.07)',
      } }),
    q({ w: 316, h: 396, x: 454, y: -260, z: BACK + 4, cls: 'flat',
      css: { 'box-shadow': 'inset 0 0 0 8px #191512, inset 0 0 40px rgba(0,0,0,0.7)' } }),
    q({ w: 6, h: 380, x: 454, y: -260, z: BACK + 8, cls: 'flat', css: { background: '#191512' } }),
  );

  return g;
}

/** The lamp over the desk, and the cone it throws. */
function lamp() {
  const g = make('div', 'grp', { '--x': '0px', '--y': '-238px', '--z': '-430px' });
  g.append(
    q({ w: 4, h: 330, y: -165, cls: 'm-steel', lit: 0.2 }),
    q({ w: 150, h: 54, cls: 'm-alloy', lit: 0.5,
      css: { 'clip-path': 'polygon(22% 0, 78% 0, 100% 100%, 0 100%)' } }),
    q({ w: 150, h: 54, ry: 90, cls: 'm-alloy', lit: 0.28,
      css: { 'clip-path': 'polygon(22% 0, 78% 0, 100% 100%, 0 100%)' } }),
    q({ w: 96, h: 96, y: 26, rx: 90, cls: 'flat',
      css: {
        background: 'radial-gradient(closest-side, #fff4d8, #ffd08a 55%, #c98a3a)',
        filter: 'blur(1px)', 'box-shadow': '0 0 60px 22px rgba(255,214,150,0.55)',
      } }),
  );
  const beam = make('div', 'beam', { '--w': '680px', '--h': '520px', '--x': '0px', '--y': '290px', '--z': '40px' });
  g.append(beam);
  return g;
}

/** The desk. Everything on it is placed relative to its top at y = DESK_Y. */
function desk() {
  const g = make('div', 'grp');
  g.append(
    shadow(0, -420, 900, 480, 26),
    q({ w: 760, h: 330, y: DESK_Y, z: -420, rx: 90, cls: 'm-walnut', lit: 0.62, lx: '50%', ly: '30%',
      ao: 'inset 0 0 60px rgba(0,0,0,0.4)' }),
    q({ w: 760, h: 14, y: DESK_Y + 7, z: -256, cls: 'm-walnut', lit: 0.8 }),
    q({ w: 760, h: 84, y: DESK_Y + 56, z: -262, cls: 'm-walnut', lit: 0.16,
      ao: 'inset 0 16px 26px rgba(0,0,0,0.6)' }),
    q({ w: 330, h: 84, x: -380, y: DESK_Y + 56, z: -420, ry: -90, cls: 'm-walnut', lit: 0.08 }),
    q({ w: 330, h: 84, x: 380, y: DESK_Y + 56, z: -420, ry: 90, cls: 'm-walnut', lit: 0.12 }),
    q({ w: 700, h: 60, y: DESK_Y + 56, z: -260, cls: 'flat',
      css: {
        background: 'linear-gradient(180deg, rgba(255,214,150,0.05), rgba(0,0,0,0) 30%,'
          + ' rgba(0,0,0,0.35) 92%, rgba(255,214,150,0.05))',
        'box-shadow': 'inset 0 0 0 1px rgba(0,0,0,0.5)',
      } }),
    q({ w: 120, h: 8, x: -180, y: DESK_Y + 56, z: -258, cls: 'm-steel', lit: 0.6 }),
    q({ w: 120, h: 8, x: 180, y: DESK_Y + 56, z: -258, cls: 'm-steel', lit: 0.6 }),
  );
  // Legs, so the desk stands on the floor rather than hovering over it.
  for (const lx of [-340, 340]) {
    for (const lz of [-280, -560]) {
      g.append(boxSolid({ w: 26, h: FLOOR - DESK_Y - 84, d: 26, x: lx, y: DESK_Y + 84 + (FLOOR - DESK_Y - 84) / 2, z: lz, cls: 'm-walnut', lit: 0.12 }));
    }
  }
  return g;
}

/** The turntable: the arm is the playhead and the platter is the transport. */
function deck() {
  const g = actor('player', 'Turntable', { x: -101, y: 25, z: -320, hw: 108, hh: 79 });

  g.append(
    shadow(-101, -320, 320, 260, 10),
    // plinth
    q({ w: 300, h: 52, y: -11, z: 110, cls: 'm-black', lit: 0.34,
      html: '<i class="led" style="left:22px;top:22px" data-led></i>' }),
    q({ w: 220, h: 52, y: -11, x: -150, ry: -90, cls: 'm-black', lit: 0.16 }),
    q({ w: 220, h: 52, y: -11, x: 150, ry: 90, cls: 'm-black', lit: 0.22 }),
  );

  // The top face carries the platter, the arm and the two speed keys.
  const top = q({
    w: 300, h: 220, y: -37, rx: 90, cls: 'm-alloy', lit: 0.6, lx: '40%', ly: '30%',
    ao: 'inset 0 0 34px rgba(0,0,0,0.55)',
  });
  top.insertAdjacentHTML('beforeend', `
    <div class="deck-well"></div>
    <div class="platter" data-platter>
      <div class="disc"></div>
      <div class="disc-label" data-disc-label></div>
      <div class="spindle"></div>
    </div>
    <div class="arm" data-arm><i class="arm-tube"></i><i class="arm-head"></i></div>
    <div class="arm-post"></div>
    <button class="deck-key" data-deck-key="33" aria-label="33 rpm">33</button>
    <button class="deck-key" data-deck-key="45" aria-label="45 rpm">45</button>
    <div class="deck-plate">Resonate DP-01</div>
  `);
  g.append(top);
  return g;
}

/** The console: five faders are the equaliser, the knob is the crossfade. */
function console_() {
  const g = actor('settings', 'Mixing console', { x: 106, y: 25, z: -340, hw: 110, hh: 81 });
  g.append(
    shadow(106, -340, 280, 220, 9),
    q({ w: 260, h: 40, y: -3, z: 96, rx: 8, cls: 'm-black', lit: 0.3 }),
  );

  const panel = q({
    w: 260, h: 190, y: -37, z: 4, rx: 68, cls: 'm-alloy', lit: 0.62, lx: '50%', ly: '20%',
    ao: 'inset 0 0 30px rgba(0,0,0,0.5)',
  });
  const bands = ['31', '160', '1k', '6k', '16k'];
  panel.insertAdjacentHTML('beforeend', `
    <div class="vu"><i class="needle" data-needle></i><span>L</span></div>
    <div class="vu vu-r"><i class="needle" data-needle></i><span>R</span></div>
    <div class="strip">
      ${bands.map((b, i) => `
        <div class="fader" data-band="${i}">
          <i class="slot"></i>
          <i class="cap" data-cap></i>
          <span>${b}</span>
        </div>`).join('')}
    </div>
    <div class="knob" data-knob="crossfade" role="slider" aria-label="Crossfade"><i></i></div>
    <span class="knob-tag">Fade</span>
  `);
  g.append(panel);
  return g;
}

/** Speakers. They start and stop the music, and they move while it plays. */
function speaker(side) {
  const x = side * 235;
  // The reach is the top corner of the cabinet, the one part of a speaker a
  // desk in front of it never hides. Everything else hangs off that.
  const cab = 103;
  const g = actor('toggle', 'Speakers', { x, y: -163, z: -760, ry: side * -18, hw: 142, hh: 105 });
  g.append(
    shadow(x, -760, 300, 240, 18),
    q({ w: 190, h: 310, y: cab, z: 80, cls: 'm-walnut', lit: 0.3, ly: '18%' }),
    q({ w: 160, h: 310, y: cab, x: -95, ry: -90, cls: 'm-walnut', lit: 0.12 }),
    q({ w: 160, h: 310, y: cab, x: 95, ry: 90, cls: 'm-walnut', lit: 0.18 }),
    q({ w: 190, h: 160, y: cab - 155, rx: 90, cls: 'm-walnut', lit: 0.62 }),
    q({
      w: 164, h: 284, y: cab, z: 82, cls: 'm-cloth', lit: 0.22, ly: '14%',
      ao: 'inset 0 0 26px rgba(0,0,0,0.85)',
      html: `
        <div class="cone woof" data-cone></div>
        <div class="cone tweet" data-cone></div>
        <i class="led" style="left:50%;bottom:14px;margin-left:-2px" data-led></i>`,
    }),
    boxSolid({ w: 130, h: 205, d: 118, y: 360, cls: 'm-black', lit: 0.1 }),
  );
  return g;
}

/** The crate: the library, as the thing a library actually is. */
function crate() {
  const g = actor('library', 'Record crate', { x: -164, y: 250, z: -300, ry: 17, hw: 106, hh: 78 });
  const sleeves = ['#2c241c', '#4e3a27', '#7a4a2c', '#3a2f3c', '#5c4a2a']
    .map((c, n) => `<i class="sleeve" style="--c:${c};--n:${n}"></i>`).join('');
  g.append(
    shadow(-164, -300, 260, 200, 14),
    q({ w: 190, h: 52, y: -150, rx: 90, cls: 'flat',
      css: { background: 'linear-gradient(180deg,#0c0a08,#161210)' },
      html: `<div class="sleeve-tops">${sleeves}</div>` }),
    q({ w: 190, h: 140, y: -50, z: 76, cls: 'm-walnut', lit: 0.42,
      html: '<i class="crate-front"></i><i class="crate-plate"></i>' }),
    q({ w: 152, h: 140, y: -50, x: -95, ry: -90, cls: 'm-walnut', lit: 0.16 }),
    q({ w: 152, h: 140, y: -50, x: 95, ry: 90, cls: 'm-walnut', lit: 0.24 }),
  );
  return g;
}

/** The tape machine: where new music comes in. */
function tape() {
  const g = actor('add', 'Tape machine', { x: 232, y: -66, z: -690, ry: -20, hw: 110, hh: 84 });
  g.append(
    shadow(232, -690, 260, 200, 16),
    q({
      w: 250, h: 180, y: -129, z: 70, rx: 6, cls: 'm-black', lit: 0.44,
      html: `
        <div class="reel reel-l"><i></i><i></i><i></i></div>
        <div class="reel reel-r small"><i></i><i></i><i></i></div>
        <div class="tape-path"></div>
        <div class="tape-keys"><b></b><b></b><b class="rec"></b></div>
        <i class="led" style="right:16px;top:14px" data-led></i>`,
    }),
    q({ w: 150, h: 180, y: -129, x: -125, ry: -90, cls: 'm-black', lit: 0.14 }),
    q({ w: 150, h: 180, y: -129, x: 125, ry: 90, cls: 'm-black', lit: 0.2 }),
    q({ w: 250, h: 150, y: -219, rx: 90, cls: 'm-black', lit: 0.5 }),
    boxSolid({ w: 230, h: 330, d: 150, y: 201, cls: 'm-black', lit: 0.1 }),
  );
  return g;
}

/** The tuner on the wall shelf: what is out there, rather than what is here. */
function tuner() {
  const g = actor('find', 'Tuner', { x: -216, y: -294, z: -910, ry: 6, hw: 142, hh: 106 });
  g.append(
    q({ w: 300, h: 26, y: 60, rx: 90, cls: 'm-walnut', lit: 0.3 }),
    q({ w: 240, h: 92, z: 40, cls: 'm-walnut', lit: 0.4,
      html: `
        <div class="dial">
          <i class="dial-glass"></i>
          <i class="dial-mark" style="left:12%"></i><i class="dial-mark" style="left:32%"></i>
          <i class="dial-mark" style="left:52%"></i><i class="dial-mark" style="left:72%"></i>
          <i class="dial-mark" style="left:92%"></i>
          <i class="dial-needle" data-tune></i>
        </div>
        <div class="tuner-knob"><i></i></div>
        <i class="led" style="left:14px;bottom:12px;--c:122,192,160" data-led></i>` }),
    q({ w: 80, h: 92, x: -120, ry: -90, cls: 'm-walnut', lit: 0.16 }),
    q({ w: 80, h: 92, x: 120, ry: 90, cls: 'm-walnut', lit: 0.2 }),
  );
  return g;
}

/** Headphones on a hook: what you love, kept where you reach for it. */
function phones() {
  const g = actor('liked', 'Headphones', { x: 196, y: -298, z: -940, ry: -8, hw: 142, hh: 106 });
  g.append(q({
    w: 150, h: 190, cls: 'flat',
    html: `
      <i class="hook"></i>
      <i class="band"></i>
      <i class="cup l"></i><i class="cup r"></i>
      <i class="cord"></i>
      <i class="led" style="left:24px;top:126px;--c:192,68,47" data-led></i>`,
  }));
  return g;
}

/** The microphone, close to the camera so the room has a foreground. */
function mic() {
  const g = actor('search', 'Microphone', { x: 160, y: 300, z: -110, ry: -26, hw: 57, hh: 106 });
  g.append(
    shadow(160, -110, 220, 180, 16),
    q({
      w: 170, h: 520, y: -286, x: -46, cls: 'flat',
      html: `
        <i class="mic-pole"></i>
        <i class="mic-foot"></i>
        <i class="mic-boom"></i>
        <i class="mic-body"></i>
        <i class="mic-head"></i>
        <i class="led" style="left:50%;top:112px;margin-left:-2px;--c:192,68,47" data-led></i>`,
    }),
  );
  return g;
}

/**
 * The guitar, with the mechanical capo chip that rides the neck.
 *
 * The chip is the playhead: it sits at the nut when a track starts and reaches
 * the body as it ends, so the room shows the position of the music without a
 * progress bar anywhere in it.
 */
function guitar() {
  const g = actor('shuffle', 'Guitar', { x: -213, y: 150, z: -600, ry: 30, rz: -8, hw: 120, hh: 99 });
  g.append(
    shadow(-213, -590, 240, 200, 16),
    q({
      w: 220, h: 620, y: -248, cls: 'flat',
      html: `
        <i class="g-body"></i>
        <i class="g-hole"></i>
        <i class="g-neck"></i>
        <i class="g-head"></i>
        <i class="g-bridge"></i>
        <div class="g-strings" data-strings><b></b><b></b><b></b><b></b><b></b><b></b></div>
        <div class="chip" data-chip><i></i><i></i><span></span></div>`,
    }),
  );
  return g;
}

/** A rug, a cable and a mug: the things that make a room somebody's. */
function props() {
  const g = make('div', 'grp');
  g.append(
    q({ w: 940, h: 430, y: FLOOR - 1, z: -370, rx: 90, cls: 'm-felt', lit: 0.26,
      ao: 'inset 0 0 60px rgba(0,0,0,0.55)',
      css: { 'box-shadow': '0 0 0 10px rgba(120,74,44,0.35) inset' } }),
    q({ w: 300, h: 200, x: 85, y: FLOOR - 2, z: -230, rx: 90, cls: 'flat',
      css: {
        background: 'radial-gradient(closest-side, rgba(0,0,0,0) 62%, rgba(10,8,7,0.9) 64%, rgba(10,8,7,0.9) 70%, rgba(0,0,0,0) 72%)',
      } }),
    boxSolid({ w: 44, h: 52, d: 44, x: 178, y: DESK_Y - 26, z: -230, cls: 'm-alloy', lit: 0.7 }),
  );
  return g;
}

/* ---------------------------------------------------------------- assembly */

export function renderRoom(host) {
  detachAll();
  host.innerHTML = '';

  room = make('div', 'room');
  const stage = make('div', 'stage');
  world = make('div', 'world');

  world.append(shell(), lamp(), props(), desk(), deck(), console_(),
    speaker(-1), speaker(1), crate(), tape(), tuner(), phones(), guitar(), mic());
  stage.append(world);

  const air = make('div', 'air');
  for (let i = 0; i < 14; i++) {
    const d = make('div', 'dust', {
      left: (8 + Math.random() * 84) + '%',
      top: (18 + Math.random() * 56) + '%',
      '--dx': (Math.random() * 34 - 17).toFixed(0) + 'px',
      '--dy': (-40 - Math.random() * 90).toFixed(0) + 'px',
      'animation-duration': (9 + Math.random() * 11).toFixed(1) + 's',
      'animation-delay': (-Math.random() * 14).toFixed(1) + 's',
      opacity: (0.25 + Math.random() * 0.5).toFixed(2),
    });
    air.append(d);
  }
  air.append(make('div', 'bloom'), make('div', 'vig'));

  tip = make('div', 'room-tip');
  room.append(stage, air, tip, lightSwitch());

  host.append(room);

  fitCamera();
  on(window, 'resize', fitCamera);
  wireObjects();
  wireParallax();
  wireControls();
  live();
  return room;
}

export function setRoomRouter(fn) { go = fn; }

/**
 * Stand back far enough that the room fits the screen it is on. A wider phone
 * simply stands closer; the geometry of the room never changes.
 */
let baseScale = 1;
function fitCamera() {
  if (!room) return;
  const w = room.clientWidth || 393;
  baseScale = Math.max(0.7, Math.min(1.5, w / 358));
  cam.s = baseScale;
  applyCamera();
}

/* -------------------------------------------------------------- behaviour */

function on(node, type, fn, opts) {
  node.addEventListener(type, fn, opts);
  detach.push(() => node.removeEventListener(type, fn, opts));
}

function detachAll() {
  for (const off of detach) off();
  detach = [];
  if (raf != null) cancelAnimationFrame(raf);
  raf = null;
}

function wireObjects() {
  for (const obj of room.querySelectorAll('.obj.live')) {
    const label = obj.dataset.label || '';
    const show = () => { tip.textContent = label; tip.classList.add('on'); };
    const hide = () => tip.classList.remove('on');

    on(obj, 'pointerenter', show);
    on(obj, 'focus', show);
    on(obj, 'pointerleave', () => { hide(); obj.classList.remove('press', 'hot'); });
    on(obj, 'blur', hide);
    on(obj, 'pointerdown', (e) => {
      if (e.target.closest('[data-arm],[data-deck-key]')) return;
      obj.classList.add('press', 'hot');
      tick();
      show();
    });
    on(obj, 'pointerup', () => obj.classList.remove('press'));
    on(obj, 'pointercancel', () => obj.classList.remove('press'));
    on(obj, 'click', (e) => {
      if (e.target.closest('[data-arm],[data-deck-key]')) return;
      if (performance.now() - lastDrag < 350) return;
      activate(obj);
    });
    on(obj, 'keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(obj); }
    });
  }
}

function activate(obj) {
  const target = obj.dataset.go;

  if (target === 'toggle') {
    press();
    if (!player.current && library.tracks.length) player.play(library.mix(40), 0);
    else player.toggle();
    return;
  }
  if (target === 'shuffle') {
    strum(obj);
    const mix = library.mix(60);
    if (mix.length) { player.setShuffle(true); player.play(mix, 0); }
    return;
  }

  press();
  approach(obj, () => go && go(target));
}

/**
 * The camera walks up to whatever was touched.
 *
 * The object's own position is what the camera flies to, so the move reads as
 * crossing the room rather than as a panel appearing over it.
 */
function approach(obj, then) {
  const read = (name) => parseFloat(obj.style.getPropertyValue(name)) || 0;
  const x = read('--x');
  const y = read('--y');
  const z = read('--z');
  // How far in front of the object to stop: near things need less.
  const pull = Math.min(760, Math.max(280, 900 + z));

  world.classList.add('settling');
  cam.x = -x * 0.9;
  cam.y = BASE_Y - y * 0.85;
  cam.z = pull;
  cam.s = baseScale * 1.7;
  applyCamera();
  room.classList.add('leaving');

  setTimeout(() => {
    then();
    cam.x = 0;
    cam.y = BASE_Y;
    cam.z = 0;
    cam.s = baseScale;
    applyCamera();
    room.classList.remove('leaving');
    world.classList.remove('settling');
  }, 420);
}

/** The head moves a little, so the room has parallax rather than a picture. */
function wireParallax() {
  let ticking = false;
  const set = (px, py) => {
    cam.px = px;
    cam.py = py;
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { applyCamera(); ticking = false; });
  };

  on(room, 'pointermove', (e) => {
    const r = room.getBoundingClientRect();
    set(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
  });
  on(room, 'pointerleave', () => set(0, 0));

  // On a phone there is no pointer to follow, so follow the phone.
  if (window.DeviceOrientationEvent) {
    const tilt = (e) => {
      if (e.gamma == null && e.beta == null) return;
      set(Math.max(-1, Math.min(1, (e.gamma || 0) / 26)),
        Math.max(-1, Math.min(1, ((e.beta || 45) - 45) / 26)));
    };
    on(window, 'deviceorientation', tilt);
  }
}

/* --------------------------------------------- the controls on the objects */

function wireControls() {
  // The console's faders are the equaliser, and they travel when dragged.
  for (const fader of room.querySelectorAll('[data-band]')) {
    const band = Number(fader.dataset.band);
    const cap = fader.querySelector('[data-cap]');
    let start = 0;
    let from = 0;
    let notch = 0;

    const gain = () => bandGain(band);
    const place = () => { cap.style.setProperty('--t', (-gain() / 12 * 34).toFixed(1) + 'px'); };
    place();

    let moved = false;
    on(fader, 'pointerdown', (e) => {
      fader.setPointerCapture(e.pointerId);
      start = e.clientY;
      from = gain();
      notch = Math.round(from);
      moved = false;
    });
    on(fader, 'pointermove', (e) => {
      if (!fader.hasPointerCapture(e.pointerId)) return;
      if (!moved && Math.abs(e.clientY - start) < 4) return;
      if (!moved) { moved = true; lever(); }
      lastDrag = performance.now();
      const next = Math.max(-12, Math.min(12, from - (e.clientY - start) / 3.4));
      setBandGain(band, next);
      place();
      if (Math.round(next) !== notch) { notch = Math.round(next); tick(); }
    });
    const done = (e) => {
      if (!fader.hasPointerCapture(e.pointerId)) return;
      fader.releasePointerCapture(e.pointerId);
      if (moved) { lastDrag = performance.now(); saveSettings(); }
    };
    on(fader, 'pointerup', done);
    on(fader, 'pointercancel', done);
  }

  // The crossfade knob actually turns, and actually crossfades.
  const knob = room.querySelector('[data-knob="crossfade"]');
  if (knob) {
    let start = 0;
    let from = 0;
    let notch = 0;
    const place = () => {
      knob.style.setProperty('--a', (-140 + (settings.crossfade / 12) * 280).toFixed(1) + 'deg');
      knob.setAttribute('aria-valuenow', String(settings.crossfade));
    };
    place();
    let moved = false;
    on(knob, 'pointerdown', (e) => {
      knob.setPointerCapture(e.pointerId);
      start = e.clientY;
      from = settings.crossfade;
      notch = Math.round(from);
      moved = false;
    });
    on(knob, 'pointermove', (e) => {
      if (!knob.hasPointerCapture(e.pointerId)) return;
      if (!moved && Math.abs(e.clientY - start) < 4) return;
      moved = true;
      lastDrag = performance.now();
      const next = Math.max(0, Math.min(12, from - (e.clientY - start) / 8));
      settings.crossfade = Math.round(next);
      player.setCrossfade(settings.crossfade);
      place();
      if (settings.crossfade !== notch) { notch = settings.crossfade; tick(); }
    });
    const done = (e) => {
      if (!knob.hasPointerCapture(e.pointerId)) return;
      knob.releasePointerCapture(e.pointerId);
      if (moved) { lastDrag = performance.now(); saveSettings(); }
    };
    on(knob, 'pointerup', done);
    on(knob, 'pointercancel', done);
  }

  // The tonearm is the playhead: drag it and the music moves with it.
  const arm = room.querySelector('[data-arm]');
  if (arm) {
    let dragging = false;
    let last = -1;
    on(arm, 'pointerdown', (e) => {
      if (!player.current || !player.duration) return;
      e.stopPropagation();
      arm.setPointerCapture(e.pointerId);
      dragging = true;
      needleDrop();
    });
    on(arm, 'pointermove', (e) => {
      if (!dragging) return;
      const box = arm.parentElement.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
      armTo(t);
      const step = Math.round(t * 24);
      if (step !== last) { last = step; tick(); }
    });
    const drop = (e) => {
      if (!dragging) return;
      dragging = false;
      arm.releasePointerCapture(e.pointerId);
      const box = arm.parentElement.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
      player.seek(t * player.duration);
      needleDrop();
    };
    on(arm, 'pointerup', drop);
    on(arm, 'pointercancel', drop);
  }

  // The speed keys really do depress, and really do change the speed.
  for (const key of room.querySelectorAll('[data-deck-key]')) {
    on(key, 'click', (e) => {
      e.stopPropagation();
      flip();
      for (const other of room.querySelectorAll('[data-deck-key]')) {
        other.classList.toggle('on', other === key);
      }
      room.style.setProperty('--rpm', key.dataset.deckKey === '45' ? '1.33s' : '1.8s');
    });
  }
  const first = room.querySelector('[data-deck-key="33"]');
  if (first) first.classList.add('on');
}

function bandGain(i) {
  const gains = settings.eqGains || [];
  // Five faders across ten bands: each one moves its pair.
  return gains[i * 2] || 0;
}

function setBandGain(i, value) {
  if (!settings.eqGains) return;
  settings.eqGains[i * 2] = value;
  settings.eqGains[i * 2 + 1] = value;
  if (!settings.eqEnabled) { settings.eqEnabled = true; player.setEqEnabled(true); }
  player.setEqGains(settings.eqGains);
}

/** Put the arm where a fraction through the record would put it. */
function armTo(t) {
  const arm = room && room.querySelector('[data-arm]');
  if (!arm) return;
  arm.style.setProperty('--a', (-27 + t * 22).toFixed(2) + 'deg');
}

function strum(obj) {
  needleDrop();
  obj.classList.remove('strummed');
  void obj.offsetWidth;
  obj.classList.add('strummed');
}

/* --------------------------------------------------------- the room lives */

/**
 * What the equipment does while the app is running. It reads the player and
 * nothing else, and it only works hard while something is playing.
 */
function live() {
  const cones = room.querySelectorAll('[data-cone]');
  const needles = room.querySelectorAll('[data-needle]');
  const leds = room.querySelectorAll('[data-led]');
  const platter = room.querySelector('[data-platter]');
  const chip = room.querySelector('[data-chip]');
  const discLabel = room.querySelector('[data-disc-label]');
  const tune = room.querySelector('[data-tune]');

  let level = 0;
  let angle = 0;
  let last = performance.now();
  let breath = 0;

  const step = (now) => {
    if (!room || !room.isConnected) { raf = null; return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const playing = player.playing;
    room.classList.toggle('playing', playing);

    // A stand-in level meter: it wanders, but only when there is audio.
    const want = playing ? 0.34 + Math.random() * 0.52 : 0;
    level += (want - level) * Math.min(1, dt * 7);

    for (const cone of cones) cone.style.setProperty('--push', (level * 3.4).toFixed(2) + 'px');
    for (const n of needles) {
      const extra = n.parentElement.classList.contains('vu-r') ? 5 : 0;
      n.style.transform = 'rotate(' + (-40 + level * 72 + extra).toFixed(1) + 'deg)';
    }

    // Even at rest the room is not switched off: the standby lamps breathe.
    breath += dt;
    const idle = 0.2 + Math.sin(breath * 1.1) * 0.05;
    for (const led of leds) led.style.opacity = String(playing ? 0.6 + level * 0.4 : idle);
    if (tune) tune.style.opacity = String(playing ? 0.9 : 0.45);

    if (playing) {
      angle = (angle + 78 * dt) % 360;
      if (platter) platter.style.transform = 'rotate(' + angle.toFixed(1) + 'deg)';
    }

    // The arm and the capo chip are the only progress indicators in the room.
    const t = player.duration ? Math.max(0, Math.min(1, player.currentTime / player.duration)) : 0;
    if (!room.querySelector('[data-arm]:active')) armTo(t);
    if (chip) chip.style.setProperty('--t', (t * 100).toFixed(2) + '%');

    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);

  const paint = () => {
    const track = player.current;
    if (discLabel) discLabel.textContent = track ? (track.title || '') : '';
    if (room) room.classList.toggle('loaded', !!track);
  };
  on(player, 'trackchange', paint);
  paint();
}

export function stopRoom() { detachAll(); }

/* -------------------------------------------------- the way out of the room */

/**
 * A light switch by the door. Everything in the room is reachable by touching
 * the thing that does it, but nobody should have to hunt when they are in a
 * hurry, so the switch lists the same places in words.
 */
function lightSwitch() {
  const frag = document.createDocumentFragment();
  const button = make('button', 'room-switch');
  button.type = 'button';
  button.setAttribute('aria-label', 'Everything in this room');
  button.setAttribute('aria-expanded', 'false');

  const menu = make('div', 'room-menu');
  menu.hidden = true;
  for (const [label, where] of [
    ['Library', 'library'], ['Liked', 'liked'], ['Playlists', 'playlists'],
    ['Search', 'search'], ['Find online', 'find'], ['Add music', 'add'],
    ['Now playing', 'player'], ['Settings', 'settings'],
  ]) {
    const item = make('button');
    item.type = 'button';
    item.textContent = label;
    item.addEventListener('click', () => {
      press();
      close();
      if (go) go(where);
    });
    menu.append(item);
  }

  const close = () => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  button.addEventListener('click', () => {
    flip();
    const open = menu.hidden;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== button) close();
  });

  frag.append(button, menu);
  return frag;
}
