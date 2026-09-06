/**
 * The room.
 *
 * Home is not a screen of cards, it is the studio itself. Every object in it
 * is a control: the deck opens the player, the crate opens the library, the
 * console opens settings, the tape machine imports, the tuner searches online,
 * the guitar shuffles everything, and the speakers start and stop the music
 * while moving with it.
 *
 * Drawn as one inline SVG so it stays sharp at any size, needs no assets and
 * works offline. The living parts are driven from the player, and only while
 * something is actually playing.
 */

import { player } from './player.js';
import { library } from './library.js';
import { el } from './ui.js';
import { press, tick, needleDrop } from './tactile.js';

let raf = null;
let room = null;
let go = null;

const SCENE = `
<svg id="room-svg" viewBox="4 104 392 448" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
  <defs>
    <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#241d18"/><stop offset="0.55" stop-color="#171310"/><stop offset="1" stop-color="#0d0b09"/>
    </linearGradient>
    <radialGradient id="lamp" cx="0.5" cy="0.02" r="0.62">
      <stop offset="0" stop-color="#ffcf87" stop-opacity="0.5"/>
      <stop offset="0.5" stop-color="#c98a3a" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a221b"/><stop offset="1" stop-color="#0f0d0b"/>
    </linearGradient>
    <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#d9cdb4"/><stop offset="0.45" stop-color="#8d8269"/><stop offset="1" stop-color="#4a4238"/>
    </linearGradient>
    <linearGradient id="woodT" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#4a3524"/><stop offset="0.5" stop-color="#6b4c33"/><stop offset="1" stop-color="#3a2a1c"/>
    </linearGradient>
    <linearGradient id="deckTop" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#302722"/><stop offset="1" stop-color="#1a1512"/>
    </linearGradient>
    <linearGradient id="grille" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a322a"/><stop offset="1" stop-color="#1d1814"/>
    </linearGradient>
    <pattern id="cloth" width="3" height="3" patternUnits="userSpaceOnUse">
      <rect width="3" height="3" fill="#2b241d"/>
      <circle cx="1" cy="1" r="0.55" fill="#100d0b"/>
    </pattern>
  </defs>

  <!-- shell -->
  <rect width="400" height="560" fill="url(#wall)"/>
  <rect width="400" height="560" fill="url(#lamp)"/>
  <path d="M0 372 L400 372 L400 560 L0 560 Z" fill="url(#floor)"/>
  <path d="M0 372 L400 372" stroke="#000" stroke-opacity="0.6"/>

  <!-- acoustic panels on the back wall -->
  <g opacity="0.5">
    <rect x="24" y="46" width="52" height="86" fill="#221b16" stroke="#000" stroke-opacity="0.4"/>
    <rect x="84" y="46" width="52" height="86" fill="#1d1712" stroke="#000" stroke-opacity="0.4"/>
    <rect x="264" y="40" width="52" height="70" fill="#1d1712" stroke="#000" stroke-opacity="0.4"/>
  </g>

  <!-- ===================== SPEAKERS : play and pause ===================== -->
  <g class="obj" data-go="toggle" data-label="Speakers. Start or stop the music.">
    <g class="hit"><rect x="8" y="196" width="84" height="176" rx="2"/></g>
    <rect x="10" y="200" width="80" height="170" rx="2" fill="url(#woodT)" stroke="#000" stroke-opacity="0.55"/>
    <rect x="16" y="206" width="68" height="158" fill="url(#grille)"/>
    <rect x="16" y="206" width="68" height="158" fill="url(#cloth)" opacity="0.85"/>
    <circle class="cone" cx="50" cy="252" r="26" fill="#15110e" stroke="#050404"/>
    <circle class="cone" cx="50" cy="252" r="9" fill="#2a231c"/>
    <circle class="cone2" cx="50" cy="320" r="15" fill="#15110e" stroke="#050404"/>
    <circle class="led" cx="50" cy="356" r="2.2" fill="#d4a04a"/>
  </g>

  <g class="obj" data-go="toggle" data-label="Speakers. Start or stop the music.">
    <g class="hit"><rect x="308" y="196" width="84" height="176" rx="2"/></g>
    <rect x="310" y="200" width="80" height="170" rx="2" fill="url(#woodT)" stroke="#000" stroke-opacity="0.55"/>
    <rect x="316" y="206" width="68" height="158" fill="url(#grille)"/>
    <rect x="316" y="206" width="68" height="158" fill="url(#cloth)" opacity="0.85"/>
    <circle class="cone" cx="350" cy="252" r="26" fill="#15110e" stroke="#050404"/>
    <circle class="cone" cx="350" cy="252" r="9" fill="#2a231c"/>
    <circle class="cone2" cx="350" cy="320" r="15" fill="#15110e" stroke="#050404"/>
    <circle class="led" cx="350" cy="356" r="2.2" fill="#d4a04a"/>
  </g>

  <!-- ===================== DESK ===================== -->
  <path d="M96 300 L304 300 L316 372 L84 372 Z" fill="#2b211a" stroke="#000" stroke-opacity="0.5"/>
  <path d="M96 300 L304 300 L302 306 L98 306 Z" fill="#3d2f24"/>

  <!-- ===================== TURNTABLE : the player ===================== -->
  <g class="obj" data-go="player" data-label="Turntable. Open the player.">
    <g class="hit"><rect x="98" y="214" width="118" height="92" rx="2"/></g>
    <rect x="100" y="222" width="112" height="80" rx="2" fill="url(#deckTop)" stroke="#000" stroke-opacity="0.6"/>
    <rect x="100" y="222" width="112" height="4" fill="#453a31" opacity="0.7"/>
    <g class="platter">
      <circle cx="146" cy="264" r="31" fill="#0a0908" stroke="#2c2620"/>
      <circle cx="146" cy="264" r="26" fill="none" stroke="#191512" stroke-width="9" stroke-dasharray="0.6 1.4"/>
      <circle class="disc-label" cx="146" cy="264" r="10" fill="#c0442f"/>
      <circle cx="146" cy="264" r="1.6" fill="#d9cdb4"/>
    </g>
    <g class="arm">
      <circle cx="198" cy="234" r="5.5" fill="#2b241c" stroke="#000" stroke-opacity="0.5"/>
      <circle cx="198" cy="234" r="2.6" fill="url(#metal)"/>
      <path d="M196 238 L170 266" stroke="#0a0806" stroke-width="3.4" stroke-linecap="round"/>
      <path d="M196 238 L170 266" stroke="url(#metal)" stroke-width="2" stroke-linecap="round"/>
      <rect x="165" y="262" width="8" height="6" rx="1" fill="#241e18" transform="rotate(-45 169 265)"/>
    </g>
    <circle class="led" cx="108" cy="296" r="1.8" fill="#d4a04a"/>
  </g>

  <!-- ===================== MIXER : settings ===================== -->
  <g class="obj" data-go="settings" data-label="Mixing console. Sound and settings.">
    <g class="hit"><rect x="222" y="246" width="86" height="60" rx="2"/></g>
    <path d="M224 300 L306 300 L302 258 L228 258 Z" fill="#241e19" stroke="#000" stroke-opacity="0.6"/>
    <path d="M228 258 L302 258 L301 262 L229 262 Z" fill="#3a3128"/>
    <g class="faders">
      <rect x="236" y="268" width="3" height="26" fill="#0b0908"/>
      <rect x="248" y="268" width="3" height="26" fill="#0b0908"/>
      <rect x="260" y="268" width="3" height="26" fill="#0b0908"/>
      <rect x="272" y="268" width="3" height="26" fill="#0b0908"/>
      <rect x="284" y="268" width="3" height="26" fill="#0b0908"/>
      <rect class="fc" x="233" y="276" width="9" height="4" rx="0.6" fill="url(#metal)"/>
      <rect class="fc" x="245" y="270" width="9" height="4" rx="0.6" fill="url(#metal)"/>
      <rect class="fc" x="257" y="282" width="9" height="4" rx="0.6" fill="url(#metal)"/>
      <rect class="fc" x="269" y="273" width="9" height="4" rx="0.6" fill="url(#metal)"/>
      <rect class="fc" x="281" y="279" width="9" height="4" rx="0.6" fill="url(#metal)"/>
    </g>
    <g class="vu">
      <rect x="234" y="248" width="26" height="7" rx="1" fill="#0d0b09" stroke="#3a3128" stroke-width="0.6"/>
      <line class="needle" x1="247" y1="255" x2="247" y2="249" stroke="#d4a04a" stroke-width="0.9"/>
      <rect x="266" y="248" width="26" height="7" rx="1" fill="#0d0b09" stroke="#3a3128" stroke-width="0.6"/>
      <line class="needle n2" x1="279" y1="255" x2="279" y2="249" stroke="#d4a04a" stroke-width="0.9"/>
    </g>
  </g>

  <!-- ===================== CRATE : the library ===================== -->
  <g class="obj" data-go="library" data-label="Record crate. Browse your library.">
    <g class="hit"><rect x="86" y="380" width="122" height="106" rx="2"/></g>
    <g class="sleeves">
      <rect x="98" y="392" width="86" height="86" fill="#3c3128" stroke="#000" stroke-opacity="0.5"/>
      <rect x="104" y="388" width="86" height="90" fill="#5d4630" stroke="#000" stroke-opacity="0.5"/>
      <rect x="110" y="384" width="86" height="94" fill="#7a4a2c" stroke="#000" stroke-opacity="0.5"/>
      <rect x="110" y="384" width="86" height="94" fill="url(#lamp)" opacity="0.35"/>
    </g>
    <path d="M88 400 L206 400 L206 486 L88 486 Z" fill="#2a2019" stroke="#000" stroke-opacity="0.6"/>
    <path d="M88 400 L206 400 L206 408 L88 408 Z" fill="#3b2d22"/>
    <path d="M88 486 L206 486" stroke="#000" stroke-opacity="0.5"/>
  </g>

  <!-- ===================== TAPE MACHINE : add music ===================== -->
  <g class="obj" data-go="add" data-label="Tape machine. Add music.">
    <g class="hit"><rect x="216" y="388" width="112" height="80" rx="2"/></g>
    <rect x="218" y="392" width="108" height="74" rx="2" fill="#26201a" stroke="#000" stroke-opacity="0.6"/>
    <rect x="218" y="392" width="108" height="4" fill="#3f3529" opacity="0.8"/>
    <g class="reel r1">
      <circle cx="248" cy="422" r="17" fill="#14100d" stroke="#4a4038"/>
      <circle cx="248" cy="422" r="11" fill="none" stroke="#6b5c48" stroke-width="1.2"/>
      <circle cx="248" cy="422" r="3" fill="url(#metal)"/>
      <path d="M248 405 L248 411 M265 422 L259 422 M248 439 L248 433 M231 422 L237 422" stroke="#6b5c48" stroke-width="1.4"/>
    </g>
    <g class="reel r2">
      <circle cx="296" cy="422" r="17" fill="#14100d" stroke="#4a4038"/>
      <circle cx="296" cy="422" r="8" fill="none" stroke="#6b5c48" stroke-width="1.2"/>
      <circle cx="296" cy="422" r="3" fill="url(#metal)"/>
      <path d="M296 405 L296 411 M313 422 L307 422 M296 439 L296 433 M279 422 L285 422" stroke="#6b5c48" stroke-width="1.4"/>
    </g>
    <path d="M248 439 Q272 452 296 439" stroke="#0d0b09" stroke-width="2.2" fill="none"/>
    <rect x="230" y="450" width="10" height="7" rx="1" fill="url(#metal)"/>
    <rect x="244" y="450" width="10" height="7" rx="1" fill="url(#metal)"/>
    <rect x="258" y="450" width="10" height="7" rx="1" fill="#c0442f"/>
    <circle class="led" cx="312" cy="404" r="2" fill="#d4a04a"/>
  </g>

  <!-- ===================== TUNER : find online ===================== -->
  <g class="obj" data-go="find" data-label="Tuner. Find music online.">
    <g class="hit"><rect x="222" y="196" width="88" height="46" rx="2"/></g>
    <rect x="226" y="200" width="80" height="38" rx="2" fill="#241e19" stroke="#000" stroke-opacity="0.6"/>
    <rect x="232" y="206" width="52" height="16" rx="1" fill="#120f0d" stroke="#3a3128" stroke-width="0.6"/>
    <g class="dialmarks" opacity="0.55">
      <path d="M236 219 L236 209 M244 219 L244 211 M252 219 L252 209 M260 219 L260 211 M268 219 L268 209 M276 219 L276 211"
            stroke="#8d8269" stroke-width="0.7"/>
    </g>
    <line class="tune" x1="248" y1="205" x2="248" y2="223" stroke="#c0442f" stroke-width="1.4"/>
    <circle class="knob-tune" cx="295" cy="215" r="8" fill="#2e2721" stroke="#000" stroke-opacity="0.5"/>
    <circle cx="295" cy="215" r="5" fill="url(#metal)"/>
    <line x1="295" y1="215" x2="295" y2="209" stroke="#241e18" stroke-width="1.2"/>
    <circle class="led alive" cx="234" cy="232" r="1.8" fill="#7ac0a0"/>
  </g>

  <!-- ===================== GUITAR : shuffle everything ===================== -->
  <g class="obj guitar" data-go="shuffle" data-label="Guitar. Shuffle everything.">
    <g class="hit"><rect x="12" y="374" width="76" height="176" rx="4"/></g>
    <g transform="rotate(-9 50 470)">
      <path d="M50 386 L50 440" stroke="#2a1d13" stroke-width="9"/>
      <rect x="43" y="376" width="14" height="16" rx="2" fill="#3a2a1c" stroke="#000" stroke-opacity="0.5"/>
      <path d="M50 440 C24 440 20 470 30 490 C38 508 62 508 70 490 C80 470 76 440 50 440 Z"
            fill="#8a5a2a" stroke="#000" stroke-opacity="0.55"/>
      <path d="M50 440 C24 440 20 470 30 490 C38 508 62 508 70 490 C80 470 76 440 50 440 Z"
            fill="url(#lamp)" opacity="0.4"/>
      <circle cx="50" cy="470" r="11" fill="#150f0a"/>
      <circle cx="50" cy="470" r="13" fill="none" stroke="#4a3018" stroke-width="1.4"/>
      <g class="strings" stroke="#d9cdb4" stroke-width="0.55" opacity="0.85">
        <path class="s" d="M46 380 L46 500"/>
        <path class="s" d="M48 380 L48 500"/>
        <path class="s" d="M50 380 L50 500"/>
        <path class="s" d="M52 380 L52 500"/>
        <path class="s" d="M54 380 L54 500"/>
      </g>
      <rect x="42" y="492" width="16" height="5" rx="1" fill="#2a1d13"/>
    </g>
  </g>

  <!-- ===================== MICROPHONE : search your library ===================== -->
  <g class="obj" data-go="search" data-label="Microphone. Search your library.">
    <g class="hit"><rect x="330" y="366" width="66" height="120" rx="3"/></g>
    <path d="M362 470 L362 412" stroke="#1d1813" stroke-width="3"/>
    <path d="M344 472 L380 472" stroke="#1d1813" stroke-width="3" stroke-linecap="round"/>
    <ellipse cx="362" cy="474" rx="22" ry="4" fill="#12100d" opacity="0.8"/>
    <path d="M352 404 L372 404 L370 386 A8 8 0 0 0 354 386 Z" fill="#2e2721" stroke="#000" stroke-opacity="0.5"/>
    <ellipse class="mic-head" cx="362" cy="390" rx="11" ry="13" fill="#1a1512" stroke="#4a4038"/>
    <ellipse cx="362" cy="390" rx="11" ry="13" fill="url(#cloth)" opacity="0.9"/>
    <rect x="356" y="406" width="12" height="5" rx="1" fill="url(#metal)"/>
    <circle class="led" cx="362" cy="414" r="1.7" fill="#c0442f"/>
  </g>

  <!-- ===================== HEADPHONES : liked songs ===================== -->
  <!-- Hung on the wall, clear of the desk. -->
  <g class="obj" data-go="liked" data-label="Headphones. Your liked songs.">
    <g class="hit"><rect x="104" y="122" width="66" height="76" rx="3"/></g>
    <path d="M137 124 L137 140" stroke="#3a3128" stroke-width="2"/>
    <circle cx="137" cy="123" r="2.6" fill="#4a4038"/>
    <path d="M119 172 A19 19 0 0 1 155 172" fill="none" stroke="#241e18" stroke-width="6" stroke-linecap="round"/>
    <path d="M119 172 A19 19 0 0 1 155 172" fill="none" stroke="#3f362c" stroke-width="2.2" stroke-linecap="round"/>
    <rect x="113" y="170" width="12" height="19" rx="5" fill="#1c1713" stroke="#000" stroke-opacity="0.5"/>
    <rect x="149" y="170" width="12" height="19" rx="5" fill="#1c1713" stroke="#000" stroke-opacity="0.5"/>
    <path class="hp-cord" d="M155 187 Q166 200 160 212" stroke="#0d0b09" stroke-width="2" fill="none"/>
    <circle class="led" cx="119" cy="193" r="1.5" fill="#c0442f"/>
  </g>

  <!-- cable running to the desk, because everything here is plugged in -->
  <path d="M92 372 C120 392 150 386 168 372" stroke="#0d0b09" stroke-width="3" fill="none" opacity="0.8"/>
  <path d="M316 372 C296 396 268 388 250 372" stroke="#0d0b09" stroke-width="3" fill="none" opacity="0.8"/>

  <!-- dust in the lamp beam -->
  <g class="motes" opacity="0.5">
    <circle cx="150" cy="120" r="1"/><circle cx="212" cy="80" r="0.8"/><circle cx="176" cy="170" r="0.9"/>
    <circle cx="248" cy="140" r="0.7"/><circle cx="124" cy="188" r="0.8"/>
  </g>
</svg>`;

/** Build the room and return it. */
export function renderRoom(host) {
  host.innerHTML = '';

  room = el('div', { class: 'room' });
  room.innerHTML = SCENE;

  const caption = el('div', { class: 'room-caption silk' });
  room.append(caption);
  host.append(room);

  for (const obj of room.querySelectorAll('.obj')) {
    const label = obj.dataset.label || '';
    obj.setAttribute('tabindex', '0');
    obj.setAttribute('role', 'button');
    obj.setAttribute('aria-label', label);

    const show = () => { caption.textContent = label; caption.classList.add('on'); };
    const hide = () => caption.classList.remove('on');

    obj.addEventListener('pointerenter', show);
    obj.addEventListener('focus', show);
    obj.addEventListener('pointerleave', hide);
    obj.addEventListener('blur', hide);
    obj.addEventListener('pointerdown', () => { obj.classList.add('pressing'); tick(); });
    obj.addEventListener('pointerup', () => obj.classList.remove('pressing'));
    obj.addEventListener('pointercancel', () => obj.classList.remove('pressing'));
    obj.addEventListener('click', () => activate(obj));
    obj.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(obj); }
    });
  }

  live();
  return room;
}

export function setRoomRouter(fn) { go = fn; }

/** Walk up to the object, then hand over to whatever it controls. */
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
 * The viewport moves toward whatever was touched, so arriving somewhere reads
 * as walking up to it rather than as a window appearing.
 */
function approach(obj, then) {
  const svg = room.querySelector('#room-svg');
  const box = obj.getBBox();
  const view = svg.viewBox.baseVal;

  const cx = ((box.x + box.width / 2) / view.width) * 100;
  const cy = ((box.y + box.height / 2) / view.height) * 100;

  room.style.transformOrigin = cx + '% ' + cy + '%';
  room.classList.add('approaching');
  setTimeout(() => {
    then();
    room.classList.remove('approaching');
  }, 260);
}

/** The strings move when the guitar is played. */
function strum(obj) {
  needleDrop();
  obj.classList.remove('strummed');
  void obj.offsetWidth;
  obj.classList.add('strummed');
}

/* ------------------------------------------------------------ the room lives */

/**
 * The equipment reacts to what the app is doing. It runs only while something
 * plays, so a still room costs nothing.
 */
function live() {
  if (raf != null) cancelAnimationFrame(raf);

  const cones = room.querySelectorAll('.cone, .cone2');
  const needles = room.querySelectorAll('.needle');
  const platter = room.querySelector('.platter');
  const reels = room.querySelectorAll('.reel');
  const leds = room.querySelectorAll('.led');
  const label = room.querySelector('.disc-label');

  let angle = 0;
  let level = 0;
  let last = performance.now();

  const step = (now) => {
    if (!room || !room.isConnected) { raf = null; return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const playing = player.playing;

    // A cheap stand-in for a level meter: a wander that only moves with audio.
    const want = playing ? 0.35 + Math.random() * 0.5 : 0;
    level += (want - level) * Math.min(1, dt * 7);

    for (const cone of cones) {
      cone.style.transform = 'scale(' + (1 + level * 0.045).toFixed(3) + ')';
    }
    for (const n of needles) {
      const swing = -42 + level * 74 + (n.classList.contains('n2') ? 6 : 0);
      n.style.transform = 'rotate(' + swing.toFixed(1) + 'deg)';
    }
    for (const led of leds) led.style.opacity = playing ? String(0.55 + level * 0.45) : '0.22';

    if (playing) {
      angle = (angle + 84 * dt) % 360;
      if (platter) platter.style.transform = 'rotate(' + angle.toFixed(1) + 'deg)';
      for (const reel of reels) {
        const dir = reel.classList.contains('r1') ? 1 : -1;
        reel.style.transform = 'rotate(' + (angle * 0.5 * dir).toFixed(1) + 'deg)';
      }
    }

    raf = requestAnimationFrame(step);
  };

  raf = requestAnimationFrame(step);

  // The record on the deck takes the colour of what is playing.
  const tint = () => {
    if (!label) return;
    const track = player.current;
    label.setAttribute('fill', track && track.artworkKey ? 'var(--lamp, #c0442f)' : '#c0442f');
  };
  player.addEventListener('trackchange', tint);
  tint();
}

export function stopRoom() {
  if (raf != null) cancelAnimationFrame(raf);
  raf = null;
}
