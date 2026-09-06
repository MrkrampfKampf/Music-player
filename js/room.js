/**
 * The room.
 *
 * Home is a studio you are standing in. It is rendered for real — geometry,
 * physically based materials, warm practical lights, soft shadows — and the
 * equipment in it is the interface. Touching the console opens the sound
 * settings by walking you to the console; the tonearm is the playhead; the
 * console's faders are the equaliser; the capo chip on the guitar's neck is
 * where you are in the track.
 *
 * Interaction is done with a thin layer of transparent buttons tracking each
 * object's projected outline rather than by ray-casting the canvas. That keeps
 * the room reachable by keyboard and legible to a screen reader, which a bare
 * canvas never is, and it means a tap lands on the same element whether it
 * came from a finger, the tab key or a test.
 *
 * If the device cannot give us WebGL, the drawn room in room2d.js takes over.
 */

import { player } from './player.js';
import { library } from './library.js';
import { settings, saveSettings } from './settings.js';
import { press, tick, flip, needleDrop, lever } from './tactile.js';

let studio = null;
let room = null;
let hosts = null;
let raf = null;
let go = null;
let tip = null;
let detach = [];
let fallback = null;
let lastDrag = 0;

/** What the room is doing, for anything that needs to observe it. */
const state = {
  ready: false,
  webgl: false,
  platter: 0,
  meter: 0,
  arm: 0,
  capo: 0,
  camera: [0, 0, 0],
  walk: 0,
  frames: 0,
};

export function roomState() { return { ...state }; }

/* --------------------------------------------------------------- utilities */

function el(tag, cls, attrs) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

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

function canRender() {
  try {
    const probe = document.createElement('canvas');
    return !!(probe.getContext('webgl2') || probe.getContext('webgl'));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ mount */

export async function renderRoom(host) {
  detachAll();
  host.innerHTML = '';

  if (!canRender()) return mountFallback(host);

  room = el('div', 'room');
  host.append(room);

  const canvas = el('canvas', 'room-view');
  canvas.setAttribute('aria-hidden', 'true');
  room.append(canvas);

  try {
    if (!sceneModule) sceneModule = await import('./studio/scene.js');
    studio = sceneModule.buildStudio(canvas);
  } catch (error) {
    console.warn('The room could not be rendered; falling back.', error);
    return mountFallback(host);
  }

  hosts = el('div', 'hotspots');
  tip = el('div', 'room-tip');
  room.append(hosts, tip, lightSwitch());

  buildHotspots();
  wireControls();
  resize();
  on(window, 'resize', resize);
  live();

  state.ready = true;
  state.webgl = true;
  return room;
}

function mountFallback(host) {
  state.webgl = false;
  host.innerHTML = '';
  return import('./room2d.js').then((mod) => {
    fallback = mod;
    if (go) mod.setRoomRouter(go);
    return mod.renderRoom(host);
  });
}

export function setRoomRouter(fn) {
  go = fn;
  if (fallback) fallback.setRoomRouter(fn);
}

export function stopRoom() {
  detachAll();
  if (fallback) fallback.stopRoom();
  if (studio) {
    studio.renderer.setAnimationLoop(null);
    studio.renderer.dispose();
    studio.env.dispose();
    studio.pmrem.dispose();
    studio = null;
  }
  state.ready = false;
}

/* Loading the renderer is deferred so a phone that never opens the room does
   not pay for a megabyte of it before it has to. */
let sceneModule = null;

/** Warm the renderer up ahead of the first time the room is shown. */
export function prepareRoom() {
  if (sceneModule || !canRender()) return Promise.resolve();
  return import('./studio/scene.js').then((m) => { sceneModule = m; }).catch(() => {});
}

/* --------------------------------------------------------------- hotspots */

/**
 * One transparent button per object, kept over that object's outline.
 *
 * The outline comes from projecting the eight corners of the object's own box,
 * so a button is exactly as big as the thing it stands for and shrinks as the
 * camera pulls away from it.
 */
const spots = [];
const controls = [];

function buildHotspots() {
  spots.length = 0;
  for (const pick of studio.pickables) {
    const button = el('button', 'obj', {
      type: 'button',
      'data-go': pick.name,
      'data-label': pick.label,
      'aria-label': pick.label,
    });
    hosts.append(button);
    spots.push({ ...pick, button });

    const show = () => { tip.textContent = pick.label; tip.classList.add('on'); };
    const hide = () => tip.classList.remove('on');
    on(button, 'pointerenter', show);
    on(button, 'focus', show);
    on(button, 'pointerleave', () => { hide(); button.classList.remove('press'); });
    on(button, 'blur', hide);
    on(button, 'pointerdown', () => { button.classList.add('press'); tick(); nudge(pick, true); });
    const release = () => { button.classList.remove('press'); nudge(pick, false); };
    on(button, 'pointerup', release);
    on(button, 'pointercancel', release);
    on(button, 'click', () => {
      if (performance.now() - lastDrag < 350) return;
      activate(pick);
    });
  }
}

/** An object gives a little when a finger lands on it. */
function nudge(pick, down) {
  const node = pick.move || pick.node;
  if (!node) return;
  if (down) {
    if (pick.rest === undefined) pick.rest = node.position.y;
    node.position.y = pick.rest - 0.004;
  } else if (pick.rest !== undefined) {
    node.position.y = pick.rest;
  }
}

/**
 * Track a mesh with a small button of its own: a fader cap, a knob, an arm.
 *
 * A control sits on top of the object it belongs to, so a tap that was not a
 * drag has to fall through to that object — otherwise touching a fader on the
 * console would do nothing at all.
 */
function trackControl(node, attrs, pad, owner) {
  const button = el('div', 'ctl', { role: 'slider', tabindex: '-1', ...attrs });
  hosts.append(button);
  controls.push({ node, button, pad: pad || 10 });
  if (owner) {
    controls[controls.length - 1].owner = owner;
    button.addEventListener('click', () => {
      if (performance.now() - lastDrag < 350) return;
      activate(owner);
    });
  }
  return button;
}

const ownerOf = (name) => spots.find((s) => s.name === name);

const V = { x: 0, y: 0, z: 0 };
function projectBox(node, camera, w, h, pad) {
  node.updateWorldMatrix(true, false);
  if (!node.geometry && !node.children.length) return null;
  const three = studio.three;
  const boxOf = three.box.setFromObject(node);
  if (boxOf.isEmpty()) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p = three.corner.set(
      i & 1 ? boxOf.max.x : boxOf.min.x,
      i & 2 ? boxOf.max.y : boxOf.min.y,
      i & 4 ? boxOf.max.z : boxOf.min.z,
    );
    p.project(camera);
    const sx = (p.x * 0.5 + 0.5) * w;
    const sy = (-p.y * 0.5 + 0.5) * h;
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  }
  return {
    left: minX - pad, top: minY - pad,
    width: (maxX - minX) + pad * 2, height: (maxY - minY) + pad * 2,
  };
}

function layoutHotspots(w, h) {
  const camera = studio.camera;
  for (const spot of spots) {
    // Nearer objects sit above further ones, which is what occlusion means.
    spot.button.style.zIndex = String(100 - Math.round(spot.node.position.z * 4));
    const r = projectBox(spot.node, camera, w, h, 6);
    apply(spot.button, r, w, h);
  }
  for (const c of controls) {
    const r = projectBox(c.node, camera, w, h, c.pad);
    apply(c.button, r, w, h);
    // A control sits just above the object it is mounted on, and no higher:
    // the tonearm must not steal a touch meant for the speaker behind it.
    const base = c.owner ? Number(c.owner.button.style.zIndex || 100) : 100;
    c.button.style.zIndex = String(base + 1);
  }
}

function apply(button, r, w, h) {
  if (!r || r.left > w || r.top > h || r.left + r.width < 0 || r.top + r.height < 0) {
    button.style.display = 'none';
    return;
  }
  // Clamp to what is actually on screen, so the middle of the button is over
  // the part of the object you can see rather than off the edge of it.
  const left = Math.max(0, r.left);
  const top = Math.max(0, r.top);
  const right = Math.min(w, r.left + r.width);
  const bottom = Math.min(h, r.top + r.height);
  button.style.display = '';
  button.style.left = left.toFixed(1) + 'px';
  button.style.top = top.toFixed(1) + 'px';
  button.style.width = Math.max(24, right - left).toFixed(1) + 'px';
  button.style.height = Math.max(24, bottom - top).toFixed(1) + 'px';
}

/* ------------------------------------------------------------- what a tap does */

function activate(pick) {
  if (pick.name === 'toggle') {
    press();
    if (!player.current && library.tracks.length) player.play(library.mix(40), 0);
    else player.toggle();
    return;
  }
  if (pick.name === 'shuffle') {
    needleDrop();
    strum();
    const mix = library.mix(60);
    if (mix.length) { player.setShuffle(true); player.play(mix, 0); }
    return;
  }
  press();
  approach(pick, () => go && go(pick.name));
}

/**
 * Walk to the object.
 *
 * The camera flies from where it is to a position in front of the thing that
 * was touched and keeps looking at it the whole way, so arriving somewhere
 * reads as crossing the room rather than as a screen replacing another.
 */
let walk = null;
function approach(pick, then) {
  const three = studio.three;
  const camera = studio.camera;
  // The walk is timed off the clock, not off frames: a slow device should
  // arrive at the same moment as a fast one, with fewer steps in between.
  walk = {
    fromPos: camera.position.clone(),
    toPos: new three.Vector3(...pick.from),
    fromAim: studio.aim.clone(),
    toAim: new three.Vector3(...pick.look),
    start: performance.now(),
    dur: 620,
    then,
    done: false,
  };
  room.classList.add('walking');
  // Rendering can be slow enough on a weak device that the frame loop alone
  // would not reach the far end of the walk in time; a timer guarantees it.
  setTimeout(() => stepWalk(), 400);
  setTimeout(() => stepWalk(), 660);
}

function stepWalk() {
  if (!walk) return;
  walk.t = Math.min(1, (performance.now() - walk.start) / walk.dur);
  // ease out, so the camera settles rather than stops
  const k = 1 - Math.pow(1 - walk.t, 3);
  studio.camera.position.lerpVectors(walk.fromPos, walk.toPos, k);
  studio.aim.lerpVectors(walk.fromAim, walk.toAim, k);
  studio.camera.lookAt(studio.aim);
  state.camera = studio.camera.position.toArray();
  if (!walk.done && walk.t > 0.62) {
    walk.done = true;
    walk.then();
    room.classList.remove('walking');
    // put the camera back where it stands, ready for the next time
    setTimeout(reseat, 260);
  }
  if (walk.t >= 1) walk = null;
}

function reseat() {
  if (!studio) return;
  walk = null;
  studio.camera.position.copy(studio.home.pos);
  studio.aim.copy(studio.home.aim);
  studio.camera.lookAt(studio.aim);
}

function strum() {
  const strings = studio.parts.strings || [];
  strings.forEach((s, i) => {
    s.userData.ring = 1;
    s.userData.phase = i * 0.6;
  });
}

/* ------------------------------------------------- the controls on the gear */

function wireControls() {
  const parts = studio.parts;

  // The five fader caps are the equaliser, and they really travel.
  (parts.faderCaps || []).forEach((cap, band) => {
    cap.userData.rest = cap.position.clone();
    const button = trackControl(cap, { 'data-band': String(band), 'aria-label': 'Equaliser band ' + (band + 1) }, 9, ownerOf('settings'));
    let from = 0;
    let start = 0;
    let notch = 0;
    let moved = false;

    const place = () => {
      const g = bandGain(band);
      const along = (g / 12) * 0.075;
      cap.position.set(
        cap.userData.rest.x,
        cap.userData.rest.y + along * Math.cos(1.16),
        cap.userData.rest.z + along * Math.sin(1.16),
      );
    };
    place();

    on(button, 'pointerdown', (e) => {
      button.setPointerCapture(e.pointerId);
      start = e.clientY;
      from = bandGain(band);
      notch = Math.round(from);
      moved = false;
    });
    on(button, 'pointermove', (e) => {
      if (!button.hasPointerCapture(e.pointerId)) return;
      if (!moved && Math.abs(e.clientY - start) < 4) return;
      if (!moved) { moved = true; lever(); }
      lastDrag = performance.now();
      const next = Math.max(-12, Math.min(12, from - (e.clientY - start) / 4));
      setBandGain(band, next);
      place();
      if (Math.round(next) !== notch) { notch = Math.round(next); tick(); }
    });
    const done = (e) => {
      if (!button.hasPointerCapture(e.pointerId)) return;
      button.releasePointerCapture(e.pointerId);
      if (moved) { lastDrag = performance.now(); saveSettings(); }
    };
    on(button, 'pointerup', done);
    on(button, 'pointercancel', done);
  });

  // The knob beside them is the crossfade, and it really turns.
  if (parts.crossfadeKnob) {
    const knob = parts.crossfadeKnob;
    const rest = knob.rotation.y;
    const button = trackControl(knob, { 'data-knob': 'crossfade', 'aria-label': 'Crossfade' }, 9, ownerOf('settings'));
    let from = 0;
    let start = 0;
    let notch = 0;
    let moved = false;
    const place = () => {
      knob.rotation.y = rest + (settings.crossfade / 12) * 4.6 - 2.3;
      button.setAttribute('aria-valuenow', String(settings.crossfade));
    };
    place();
    on(button, 'pointerdown', (e) => {
      button.setPointerCapture(e.pointerId);
      start = e.clientY;
      from = settings.crossfade;
      notch = from;
      moved = false;
    });
    on(button, 'pointermove', (e) => {
      if (!button.hasPointerCapture(e.pointerId)) return;
      if (!moved && Math.abs(e.clientY - start) < 4) return;
      moved = true;
      lastDrag = performance.now();
      settings.crossfade = Math.max(0, Math.min(12, Math.round(from - (e.clientY - start) / 9)));
      player.setCrossfade(settings.crossfade);
      place();
      if (settings.crossfade !== notch) { notch = settings.crossfade; tick(); }
    });
    const done = (e) => {
      if (!button.hasPointerCapture(e.pointerId)) return;
      button.releasePointerCapture(e.pointerId);
      if (moved) { lastDrag = performance.now(); saveSettings(); }
    };
    on(button, 'pointerup', done);
    on(button, 'pointercancel', done);
  }

  // The tonearm is the playhead. Drag it across the record to move.
  if (parts.tonearm) {
    const arm = parts.tonearm;
    const button = trackControl(arm, { 'data-arm': '', 'aria-label': 'Tonearm' }, 9, ownerOf('player'));
    let dragging = false;
    let last = -1;
    const at = (e) => {
      const box = room.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - box.left - box.width * 0.12) / (box.width * 0.5)));
    };
    on(button, 'pointerdown', (e) => {
      if (!player.current || !player.duration) return;
      button.setPointerCapture(e.pointerId);
      dragging = true;
      needleDrop();
    });
    on(button, 'pointermove', (e) => {
      if (!dragging) return;
      lastDrag = performance.now();
      const t = at(e);
      armTo(t);
      const step = Math.round(t * 22);
      if (step !== last) { last = step; tick(); }
    });
    const drop = (e) => {
      if (!dragging) return;
      dragging = false;
      button.releasePointerCapture(e.pointerId);
      lastDrag = performance.now();
      player.seek(at(e) * player.duration);
      needleDrop();
    };
    on(button, 'pointerup', drop);
    on(button, 'pointercancel', drop);
  }

  // The tuning knob on the meter bridge turns under a finger too.
  if (parts.tunerKnob) {
    const knob = parts.tunerKnob;
    const button = trackControl(knob, { 'data-knob': 'tune', 'aria-label': 'Tuning' }, 9, ownerOf('find'));
    let start = 0;
    let from = 0;
    on(button, 'pointerdown', (e) => {
      button.setPointerCapture(e.pointerId);
      start = e.clientY;
      from = knob.rotation.z;
    });
    on(button, 'pointermove', (e) => {
      if (!button.hasPointerCapture(e.pointerId)) return;
      lastDrag = performance.now();
      knob.rotation.z = from - (e.clientY - start) / 90;
      tick();
    });
    const done = (e) => {
      if (button.hasPointerCapture(e.pointerId)) button.releasePointerCapture(e.pointerId);
    };
    on(button, 'pointerup', done);
    on(button, 'pointercancel', done);
  }
}

function bandGain(i) {
  const gains = settings.eqGains || [];
  return gains[i * 2] || 0;
}

function setBandGain(i, value) {
  if (!settings.eqGains) return;
  settings.eqGains[i * 2] = value;
  settings.eqGains[i * 2 + 1] = value;
  if (!settings.eqEnabled) { settings.eqEnabled = true; player.setEqEnabled(true); }
  player.setEqGains(settings.eqGains);
}

/** Swing the arm to a fraction through the side. */
function armTo(t) {
  const arm = studio && studio.parts.tonearm;
  if (!arm) return;
  arm.rotation.y = -0.30 + t * 0.42;
  state.arm = arm.rotation.y;
}

/* ------------------------------------------------------------- the frame */

function resize() {
  if (!studio || !room) return;
  const w = room.clientWidth || 1;
  const h = room.clientHeight || 1;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  studio.renderer.setPixelRatio(dpr);
  studio.renderer.setSize(w, h, false);
  studio.composer.setPixelRatio(dpr);
  studio.composer.setSize(w, h);
  studio.bloom.resolution.set(w, h);
  studio.camera.aspect = w / h;
  // A portrait frame is a narrow slice of a room, so it needs a wide lens to
  // hold the desk: the horizontal field is only about half the vertical one.
  studio.camera.fov = w / h < 0.75 ? 68 : 44;
  studio.camera.updateProjectionMatrix();
  layoutHotspots(w, h);
}

/**
 * The room while it runs.
 *
 * Everything that moves is driven from the player and nothing else: the
 * platter turns while there is audio, the cones push, the meters swing, the
 * capo chip walks down the neck, the candle gutters. When nothing is playing
 * the room is not switched off — the standby lamps breathe and the candle
 * still moves, because a real room is never completely still.
 */
function live() {
  const parts = studio.parts;
  let last = performance.now();
  let level = 0;
  let angle = 0;
  let breath = 0;

  const frame = (now) => {
    if (!room || !room.isConnected || !studio) { raf = null; return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const playing = player.playing;

    const want = playing ? 0.34 + Math.random() * 0.5 : 0;
    level += (want - level) * Math.min(1, dt * 6);
    state.meter = level;

    // cones
    for (const cone of studio.cones) cone.position.z = cone.userData.z0 + level * 0.004;

    // the platter, and the record on it
    if (playing) {
      angle += dt * 3.49;   // 33 1/3 rpm
      if (parts.platter) parts.platter.rotation.y = angle;
      state.platter = angle;
    }

    // console meters
    breath += dt;
    for (let i = 0; i < (parts.meters || []).length; i++) {
      const swing = -0.62 + level * 1.15 + (i ? 0.06 : 0);
      parts.meters[i].rotation.z = swing;
    }

    // the lamps: bright with the music, breathing without it
    const idle = 0.55 + Math.sin(breath * 1.2) * 0.12;
    const lamp = playing ? 1.6 + level * 1.6 : idle;
    for (const key of ['monitorLedL', 'monitorLedR', 'deckLed', 'tapeLed', 'micLed', 'chipLed']) {
      if (parts[key]) parts[key].material.emissiveIntensity = lamp;
    }
    if (parts.tunerFace) parts.tunerFace.material.emissiveIntensity = playing ? 0.72 : 0.42;

    // reels turn while tape would be moving
    if (playing && parts.reels) {
      parts.reels[0].rotation.z -= dt * 1.5;
      parts.reels[1].rotation.z -= dt * 2.2;
    }

    // the candle gutters, which is most of what makes the room feel occupied
    if (parts.flicker) {
      const f = 0.7 + Math.sin(breath * 11.3) * 0.06 + Math.sin(breath * 4.1) * 0.09 + Math.random() * 0.05;
      parts.flicker.intensity = f;
      parts.flame.scale.set(0.9 + f * 0.2, 1.5 + f * 0.4, 0.9 + f * 0.2);
    }

    // the tonearm and the capo chip are the only progress indicators here
    const t = player.duration ? Math.max(0, Math.min(1, player.currentTime / player.duration)) : 0;
    if (!document.querySelector('[data-arm]:active')) armTo(t);
    if (parts.capo) {
      parts.capo.position.y = 0.34 + (1 - t) * 0.34;
      state.capo = t;
    }

    // strings ring down after a strum
    for (const s of (parts.strings || [])) {
      if (!s.userData.ring) continue;
      s.userData.ring = Math.max(0, s.userData.ring - dt * 2.4);
      s.position.z = s.userData.z0 + Math.sin(breath * 60 + s.userData.phase) * 0.0016 * s.userData.ring;
    }

    stepWalk();
    state.walk = walk ? walk.t : -1;
    state.frames++;
    state.camera = studio.camera.position.toArray();

    // The buttons follow the objects, because the camera moves.
    layoutHotspots(room.clientWidth || 1, room.clientHeight || 1);

    // Nothing is rendered while the room is not the view: a studio you are not
    // looking at should not be costing anyone battery.
    if (room.offsetParent !== null) studio.composer.render();
    raf = requestAnimationFrame(frame);
  };

  // remember the rest positions the animation moves things away from
  for (const cone of studio.cones) cone.userData.z0 = cone.position.z;
  for (const s of (parts.strings || [])) s.userData.z0 = s.position.z;

  const paint = () => {
    const track = player.current;
    if (room) room.classList.toggle('loaded', !!track);
  };
  on(player, 'trackchange', paint);
  paint();

  raf = requestAnimationFrame(frame);
}

/* ------------------------------------------------ the way out of the room */

/**
 * A light switch by the door. Everything here is reached by touching the thing
 * that does it, but nobody should have to hunt when they are in a hurry.
 */
function lightSwitch() {
  const frag = document.createDocumentFragment();
  const button = el('button', 'room-switch', {
    type: 'button', 'aria-label': 'Everything in this room', 'aria-expanded': 'false',
  });
  const menu = el('div', 'room-menu');
  menu.hidden = true;

  const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  for (const [label, where] of [
    ['Library', 'library'], ['Liked', 'liked'], ['Playlists', 'playlists'],
    ['Search', 'search'], ['Find online', 'find'], ['Add music', 'add'],
    ['Now playing', 'player'], ['Settings', 'settings'],
  ]) {
    const item = el('button', null, { type: 'button' });
    item.textContent = label;
    item.addEventListener('click', () => { press(); close(); if (go) go(where); });
    menu.append(item);
  }
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
