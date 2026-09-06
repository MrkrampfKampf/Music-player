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
<svg id="room-svg" viewBox="4 0 392 624" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  <defs>
    <!-- Nothing in this room is a flat fill: every surface gets grain, a lit
         edge and a shadowed one, and every object sits in a contact shadow. -->
    <filter id="grain" x="-4%" y="-4%" width="108%" height="108%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" seed="7" result="n"/>
      <feColorMatrix in="n" type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.5"/></feComponentTransfer>
    </filter>
    <filter id="woodgrain" x="-2%" y="-2%" width="104%" height="104%">
      <feTurbulence type="fractalNoise" baseFrequency="0.006 0.4" numOctaves="5" seed="3" result="t"/>
      <feColorMatrix in="t" type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.34"/></feComponentTransfer>
    </filter>
    <filter id="brushed" x="-2%" y="-2%" width="104%" height="104%">
      <feTurbulence type="fractalNoise" baseFrequency="0.55 0.02" numOctaves="3" seed="2" result="t"/>
      <feColorMatrix in="t" type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.2"/></feComponentTransfer>
    </filter>
    <filter id="bloom" x="-140%" y="-140%" width="380%" height="380%">
      <feGaussianBlur stdDeviation="3.2"/>
    </filter>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="2.4"/>
    </filter>
    <filter id="contact" x="-70%" y="-70%" width="240%" height="240%">
      <feGaussianBlur stdDeviation="5"/>
    </filter>

    <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2c231c"/><stop offset="0.5" stop-color="#171310"/><stop offset="1" stop-color="#0c0a09"/>
    </linearGradient>
    <radialGradient id="lamp" cx="0.5" cy="0.02" r="0.66">
      <stop offset="0" stop-color="#ffd79a" stop-opacity="0.46"/>
      <stop offset="0.38" stop-color="#c98a3a" stop-opacity="0.13"/>
      <stop offset="1" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#33281f"/><stop offset="0.3" stop-color="#1e1811"/><stop offset="1" stop-color="#0b0908"/>
    </linearGradient>
    <linearGradient id="metal" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#fdf5e3"/><stop offset="0.17" stop-color="#cabea5"/>
      <stop offset="0.45" stop-color="#7d7461"/><stop offset="0.57" stop-color="#aca189"/>
      <stop offset="0.81" stop-color="#5a5344"/><stop offset="1" stop-color="#908772"/>
    </linearGradient>
    <linearGradient id="brass" x1="0" y1="0" x2="0.62" y2="1">
      <stop offset="0" stop-color="#fff0c6"/><stop offset="0.29" stop-color="#d4a04a"/>
      <stop offset="0.65" stop-color="#87611f"/><stop offset="0.87" stop-color="#e3ba6c"/>
      <stop offset="1" stop-color="#9a7128"/>
    </linearGradient>
    <linearGradient id="woodT" x1="0" y1="0" x2="1" y2="0.22">
      <stop offset="0" stop-color="#3c291a"/><stop offset="0.3" stop-color="#6d4928"/>
      <stop offset="0.58" stop-color="#4b321e"/><stop offset="0.85" stop-color="#5c3e24"/>
      <stop offset="1" stop-color="#281a10"/>
    </linearGradient>
    <linearGradient id="deckTop" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#4a4038"/><stop offset="0.35" stop-color="#2b2420"/>
      <stop offset="0.75" stop-color="#1d1815"/><stop offset="1" stop-color="#2a2321"/>
    </linearGradient>
    <linearGradient id="grille" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a322a"/><stop offset="1" stop-color="#161210"/>
    </linearGradient>
    <radialGradient id="vinylG" cx="0.36" cy="0.28" r="0.86">
      <stop offset="0" stop-color="#282320"/><stop offset="0.42" stop-color="#110f0d"/><stop offset="1" stop-color="#050404"/>
    </radialGradient>
    <linearGradient id="sheen" x1="0.05" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#fff3d6" stop-opacity="0.26"/>
      <stop offset="0.2" stop-color="#fff3d6" stop-opacity="0.04"/>
      <stop offset="0.45" stop-color="#fff3d6" stop-opacity="0"/>
      <stop offset="0.72" stop-color="#ffd79a" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#fff3d6" stop-opacity="0.15"/>
    </linearGradient>
    <linearGradient id="labelG" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0" stop-color="#e35e43"/><stop offset="0.5" stop-color="#c0442f"/><stop offset="1" stop-color="#82271a"/>
    </linearGradient>
    <radialGradient id="knurl" cx="0.34" cy="0.28" r="0.8">
      <stop offset="0" stop-color="#cfc2a6"/><stop offset="0.55" stop-color="#6f6656"/><stop offset="1" stop-color="#2a251e"/>
    </radialGradient>
    <pattern id="cloth" width="2.6" height="2.6" patternUnits="userSpaceOnUse">
      <rect width="2.6" height="2.6" fill="#2a231c"/>
      <circle cx="0.9" cy="0.9" r="0.62" fill="#0a0807"/>
      <circle cx="0.6" cy="0.6" r="0.24" fill="#4a4136" opacity="0.5"/>
    </pattern>
    <radialGradient id="vig" cx="0.5" cy="0.42" r="0.78">
      <stop offset="0.6" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.5"/>
    </radialGradient>
  </defs>

  <!-- shell -->
  <rect width="400" height="624" fill="url(#wall)"/>
  <rect width="400" height="624" fill="url(#lamp)" pointer-events="none"/>
  <rect width="400" height="624" filter="url(#grain)" opacity="0.05" pointer-events="none" style="mix-blend-mode:overlay"/>
  <path d="M0 372 L400 372 L400 624 L0 624 Z" fill="url(#floor)"/>
  <path d="M0 372 L400 372 L400 624 L0 624 Z" filter="url(#woodgrain)" opacity="0.28" style="mix-blend-mode:multiply"/>
  <g stroke="#000" stroke-opacity="0.4" pointer-events="none">
    <path d="M-20 428 L420 428"/><path d="M-40 500 L440 500"/><path d="M-60 586 L460 586"/>
  </g>
  <g stroke="#6b5335" stroke-opacity="0.12" pointer-events="none">
    <path d="M-20 430 L420 430"/><path d="M-40 502 L440 502"/><path d="M-60 588 L460 588"/>
  </g>

  <!-- a rug, so the floor is a floor and not a backdrop -->
  <g pointer-events="none">
    <path d="M44 494 L356 494 L378 566 L22 566 Z" fill="#4a2f22"/>
    <path d="M44 494 L356 494 L378 566 L22 566 Z" filter="url(#grain)" opacity="0.13" style="mix-blend-mode:multiply"/>
    <path d="M44 494 L356 494 L378 566 L22 566 Z" fill="url(#lamp)" opacity="0.4"/>
    <path d="M56 504 L344 504 L362 556 L38 556 Z" fill="#5a3826" opacity="0.75"/>
    <path d="M56 504 L344 504 L362 556 L38 556 Z" fill="none" stroke="#8c5a34" stroke-width="1" opacity="0.35"/>
    <g stroke="#2c1a12" stroke-width="1.6" opacity="0.28">
      <path d="M46 500 L360 500"/><path d="M40 522 L364 522"/><path d="M32 546 L370 546"/>
    </g>
    <g stroke="#5c3b28" stroke-width="1.6" opacity="0.6">
      <path d="M22 566 L18 572"/><path d="M62 566 L59 572"/><path d="M102 566 L100 572"/>
      <path d="M142 566 L141 572"/><path d="M182 566 L182 572"/><path d="M222 566 L223 572"/>
      <path d="M262 566 L264 572"/><path d="M302 566 L305 572"/><path d="M342 566 L346 572"/>
    </g>
  </g>

  <!-- a cable, coiled and left where it was dropped -->
  <g pointer-events="none" fill="none" stroke="#100e0c" stroke-width="2.6">
    <ellipse cx="322" cy="524" rx="26" ry="9"/>
    <ellipse cx="325" cy="521" rx="20" ry="7"/>
    <path d="M348 522 Q366 514 372 498"/>
  </g>
  <g pointer-events="none" fill="none" stroke="#3a332a" stroke-width="0.9" opacity="0.5">
    <ellipse cx="322" cy="523" rx="26" ry="9"/>
  </g>
  <path d="M0 372 L400 372" stroke="#000" stroke-opacity="0.75" stroke-width="1.4"/>
  <path d="M0 373 L400 373" stroke="#6b5335" stroke-opacity="0.3"/>

  <!-- acoustic panels, thick enough to cast their own shadow on the wall -->
  <g>
    <rect x="26" y="48" width="52" height="86" fill="#000" opacity="0.45" filter="url(#soft)"/>
    <rect x="24" y="46" width="52" height="86" fill="#241c16"/>
    <rect x="24" y="46" width="52" height="86" fill="url(#lamp)" opacity="0.5"/>
    <rect x="24" y="46" width="52" height="2.6" fill="#3d3025"/>
    <rect x="86" y="48" width="52" height="86" fill="#000" opacity="0.45" filter="url(#soft)"/>
    <rect x="84" y="46" width="52" height="86" fill="#1e1813"/>
    <rect x="84" y="46" width="52" height="2.6" fill="#332822"/>
    <rect x="266" y="42" width="52" height="70" fill="#000" opacity="0.45" filter="url(#soft)"/>
    <rect x="264" y="40" width="52" height="70" fill="#1e1813"/>
    <rect x="264" y="40" width="52" height="2.6" fill="#332822"/>
  </g>

  <!-- ===================== SPEAKERS : play and pause ===================== -->
  <g class="obj" data-go="toggle" data-label="Speakers. Start or stop the music.">
    <g class="hit"><rect x="8" y="196" width="84" height="176" rx="2"/></g>
    <ellipse cx="50" cy="372" rx="50" ry="10" fill="#000" opacity="0.72" filter="url(#contact)"/>
    <rect x="10" y="200" width="80" height="172" rx="1.5" fill="url(#woodT)"/>
    <rect x="10" y="200" width="80" height="172" rx="1.5" filter="url(#woodgrain)" opacity="0.5" style="mix-blend-mode:multiply"/>
    <rect x="10" y="200" width="80" height="3" fill="#a2733f" opacity="0.7"/>
    <rect x="10" y="200" width="2.6" height="172" fill="#c08f4f" opacity="0.32"/>
    <rect x="87.4" y="200" width="2.6" height="172" fill="#000" opacity="0.42"/>
    <rect x="16" y="206" width="68" height="158" fill="url(#grille)"/>
    <rect x="16" y="206" width="68" height="158" fill="url(#cloth)"/>
    <rect x="16" y="206" width="68" height="158" fill="url(#lamp)" opacity="0.45"/>
    <circle cx="50" cy="252" r="27" fill="#0b0a09"/>
    <circle class="cone" cx="50" cy="252" r="26" fill="#15110e" stroke="#050404"/>
    <circle class="cone" cx="50" cy="252" r="26" fill="url(#sheen)"/>
    <circle class="cone" cx="50" cy="252" r="9" fill="#2a231c"/>
    <circle class="cone" cx="50" cy="252" r="9" fill="url(#sheen)"/>
    <circle class="cone2" cx="50" cy="320" r="15" fill="#15110e" stroke="#050404"/>
    <circle class="cone2" cx="50" cy="320" r="15" fill="url(#sheen)"/>
    <circle cx="50" cy="356" r="3.4" fill="#0d0b09"/>
    <circle class="led" cx="50" cy="356" r="2.2" fill="#d4a04a"/>
    <circle class="led" cx="50" cy="356" r="5" fill="#d4a04a" opacity="0.45" filter="url(#bloom)"/>
  </g>

  <g class="obj" data-go="toggle" data-label="Speakers. Start or stop the music.">
    <g class="hit"><rect x="308" y="196" width="84" height="176" rx="2"/></g>
    <ellipse cx="350" cy="372" rx="50" ry="10" fill="#000" opacity="0.72" filter="url(#contact)"/>
    <rect x="310" y="200" width="80" height="172" rx="1.5" fill="url(#woodT)"/>
    <rect x="310" y="200" width="80" height="172" rx="1.5" filter="url(#woodgrain)" opacity="0.5" style="mix-blend-mode:multiply"/>
    <rect x="310" y="200" width="80" height="3" fill="#a2733f" opacity="0.7"/>
    <rect x="310" y="200" width="2.6" height="172" fill="#c08f4f" opacity="0.32"/>
    <rect x="387.4" y="200" width="2.6" height="172" fill="#000" opacity="0.42"/>
    <rect x="316" y="206" width="68" height="158" fill="url(#grille)"/>
    <rect x="316" y="206" width="68" height="158" fill="url(#cloth)"/>
    <rect x="316" y="206" width="68" height="158" fill="url(#lamp)" opacity="0.45"/>
    <circle cx="350" cy="252" r="27" fill="#0b0a09"/>
    <circle class="cone" cx="350" cy="252" r="26" fill="#15110e" stroke="#050404"/>
    <circle class="cone" cx="350" cy="252" r="26" fill="url(#sheen)"/>
    <circle class="cone" cx="350" cy="252" r="9" fill="#2a231c"/>
    <circle class="cone" cx="350" cy="252" r="9" fill="url(#sheen)"/>
    <circle class="cone2" cx="350" cy="320" r="15" fill="#15110e" stroke="#050404"/>
    <circle class="cone2" cx="350" cy="320" r="15" fill="url(#sheen)"/>
    <circle cx="350" cy="356" r="3.4" fill="#0d0b09"/>
    <circle class="led" cx="350" cy="356" r="2.2" fill="#d4a04a"/>
    <circle class="led" cx="350" cy="356" r="5" fill="#d4a04a" opacity="0.45" filter="url(#bloom)"/>
  </g>

  <!-- ===================== DESK ===================== -->
  <path d="M84 374 L316 374 L318 382 L82 382 Z" fill="#000" opacity="0.6" filter="url(#soft)"/>
  <path d="M96 300 L304 300 L316 372 L84 372 Z" fill="#2b211a"/>
  <path d="M96 300 L304 300 L316 372 L84 372 Z" filter="url(#woodgrain)" opacity="0.42" style="mix-blend-mode:multiply"/>
  <path d="M96 300 L304 300 L316 372 L84 372 Z" fill="url(#lamp)" opacity="0.5"/>
  <path d="M96 300 L304 300 L303 305 L97 305 Z" fill="#7a5735" opacity="0.85"/>
  <path d="M96 300 L304 300 L303.6 302 L96.4 302 Z" fill="#c39355" opacity="0.55"/>
  <path d="M84 372 L316 372" stroke="#0a0806" stroke-width="1.6"/>
  <g pointer-events="none">
    <path d="M99 316 L301 316" stroke="#0a0806" stroke-opacity="0.6"/>
    <path d="M99 317 L301 317" stroke="#7a5735" stroke-opacity="0.25"/>
    <path d="M95 346 L305 346" stroke="#0a0806" stroke-opacity="0.6"/>
    <path d="M95 347 L305 347" stroke="#7a5735" stroke-opacity="0.25"/>
    <rect x="176" y="326" width="48" height="5" rx="2" fill="#0d0b09"/>
    <rect x="176.6" y="326.6" width="46.8" height="3.4" rx="1.6" fill="url(#metal)" opacity="0.75"/>
    <rect x="174" y="356" width="52" height="5" rx="2" fill="#0d0b09"/>
    <rect x="174.6" y="356.6" width="50.8" height="3.4" rx="1.6" fill="url(#metal)" opacity="0.75"/>
  </g>

  <!-- ===================== TURNTABLE : the player ===================== -->
  <g class="obj" data-go="player" data-label="Turntable. Open the player.">
    <g class="hit"><rect x="98" y="214" width="118" height="92" rx="2"/></g>
    <ellipse cx="156" cy="304" rx="60" ry="7" fill="#000" opacity="0.62" filter="url(#contact)"/>
    <rect x="100" y="222" width="112" height="80" rx="1.5" fill="#0d0b09"/>
    <rect x="101" y="223" width="110" height="78" rx="1" fill="url(#deckTop)"/>
    <rect x="101" y="223" width="110" height="78" rx="1" filter="url(#brushed)" opacity="0.45" style="mix-blend-mode:overlay"/>
    <rect x="101" y="223" width="110" height="78" rx="1" fill="url(#lamp)" opacity="0.4"/>
    <rect x="101" y="223" width="110" height="1.8" fill="#fff2dc" opacity="0.32"/>
    <rect x="101" y="299" width="110" height="1.6" fill="#000" opacity="0.55"/>
    <!-- the platter sits in a machined well -->
    <circle cx="146" cy="264" r="33.5" fill="#070605"/>
    <circle cx="146" cy="264" r="32.5" fill="url(#metal)" opacity="0.35"/>
    <circle cx="146" cy="264" r="31.5" fill="#0c0a09"/>
    <g fill="#d4a04a" opacity="0.5">
      <circle cx="146" cy="233.5" r="0.6"/><circle cx="167.5" cy="242.5" r="0.6"/>
      <circle cx="176.5" cy="264" r="0.6"/><circle cx="167.5" cy="285.5" r="0.6"/>
      <circle cx="146" cy="294.5" r="0.6"/><circle cx="124.5" cy="285.5" r="0.6"/>
      <circle cx="115.5" cy="264" r="0.6"/><circle cx="124.5" cy="242.5" r="0.6"/>
    </g>
    <g class="platter">
      <circle cx="146" cy="264" r="30" fill="url(#vinylG)"/>
      <g fill="none" stroke="#221e1a" stroke-width="0.32" opacity="0.9">
        <circle cx="146" cy="264" r="28.4"/><circle cx="146" cy="264" r="26.6"/>
        <circle cx="146" cy="264" r="24.8"/><circle cx="146" cy="264" r="23"/>
        <circle cx="146" cy="264" r="21.2"/><circle cx="146" cy="264" r="19.4"/>
        <circle cx="146" cy="264" r="17.6"/><circle cx="146" cy="264" r="15.8"/>
        <circle cx="146" cy="264" r="14"/><circle cx="146" cy="264" r="12.2"/>
      </g>
      <g fill="none" stroke="#0a0908" stroke-width="1" opacity="0.85">
        <circle cx="146" cy="264" r="25.7"/><circle cx="146" cy="264" r="18.5"/>
      </g>
      <circle cx="146" cy="264" r="30" fill="url(#sheen)"/>
      <circle class="disc-label" cx="146" cy="264" r="10" fill="url(#labelG)"/>
      <circle cx="146" cy="264" r="10" fill="url(#sheen)" opacity="0.7"/>
      <circle cx="146" cy="264" r="7.6" fill="none" stroke="#f0c58a" stroke-width="0.3" opacity="0.4"/>
      <circle cx="146" cy="264" r="1.6" fill="url(#metal)"/>
    </g>
    <!-- tonearm, with its shadow falling on the record -->
    <g class="arm">
      <path d="M196 238 L170 266" stroke="#000" stroke-opacity="0.45" stroke-width="4.6"
            stroke-linecap="round" filter="url(#soft)" transform="translate(2,4)"/>
      <circle cx="198" cy="234" r="7" fill="#0c0a09"/>
      <circle cx="198" cy="234" r="6" fill="url(#knurl)"/>
      <circle cx="198" cy="234" r="3" fill="url(#brass)"/>
      <circle cx="197" cy="233" r="0.9" fill="#fff5d8" opacity="0.65"/>
      <rect x="202" y="230" width="9" height="8" rx="2" fill="#100e0c"/>
      <rect x="202.8" y="230.8" width="7.4" height="6.4" rx="1.6" fill="url(#metal)"/>
      <path d="M196 238 L170 266" stroke="#0a0806" stroke-width="3.6" stroke-linecap="round"/>
      <path d="M196 238 L170 266" stroke="url(#metal)" stroke-width="2.1" stroke-linecap="round"/>
      <path d="M195.4 237.4 L169.4 265.4" stroke="#fff4dc" stroke-width="0.5" stroke-linecap="round" opacity="0.5"/>
      <g transform="rotate(-45 169 265)">
        <rect x="164" y="261" width="10" height="6.4" rx="1" fill="#100e0c"/>
        <rect x="164.6" y="261.6" width="8.8" height="5.2" rx="0.8" fill="url(#metal)"/>
        <path d="M165.6 267.4 H172.4 L171.4 271 H166.6 Z" fill="#c0442f"/>
      </g>
    </g>
    <circle class="led" cx="108" cy="296" r="1.8" fill="#d4a04a"/>
    <circle class="led" cx="108" cy="296" r="4" fill="#d4a04a" opacity="0.4" filter="url(#bloom)"/>
  </g>

  <!-- ===================== MIXER : settings ===================== -->
  <g class="obj" data-go="settings" data-label="Mixing console. Sound and settings.">
    <g class="hit"><rect x="222" y="246" width="86" height="60" rx="2"/></g>
    <ellipse cx="265" cy="302" rx="46" ry="6" fill="#000" opacity="0.6" filter="url(#contact)"/>
    <path d="M224 300 L306 300 L302 258 L228 258 Z" fill="#0c0a09"/>
    <path d="M225.4 298.6 L304.6 298.6 L301 259.4 L229 259.4 Z" fill="#282119"/>
    <path d="M225.4 298.6 L304.6 298.6 L301 259.4 L229 259.4 Z" filter="url(#brushed)" opacity="0.35" style="mix-blend-mode:overlay"/>
    <path d="M225.4 298.6 L304.6 298.6 L301 259.4 L229 259.4 Z" fill="url(#lamp)" opacity="0.45"/>
    <path d="M228 258 L302 258 L301.6 261 L228.4 261 Z" fill="#8a7b62" opacity="0.7"/>
    <path d="M228 258 L302 258 L301.8 259.2 L228.2 259.2 Z" fill="#e6d7b6" opacity="0.5"/>
    <g class="faders">
      <rect x="235.4" y="267.4" width="4.2" height="27.2" rx="2" fill="#050404"/>
      <rect x="247.4" y="267.4" width="4.2" height="27.2" rx="2" fill="#050404"/>
      <rect x="259.4" y="267.4" width="4.2" height="27.2" rx="2" fill="#050404"/>
      <rect x="271.4" y="267.4" width="4.2" height="27.2" rx="2" fill="#050404"/>
      <rect x="283.4" y="267.4" width="4.2" height="27.2" rx="2" fill="#050404"/>
      <g fill="#5e5648" opacity="0.55">
        <rect x="237.1" y="268" width="0.8" height="26"/><rect x="249.1" y="268" width="0.8" height="26"/>
        <rect x="261.1" y="268" width="0.8" height="26"/><rect x="273.1" y="268" width="0.8" height="26"/>
        <rect x="285.1" y="268" width="0.8" height="26"/>
      </g>
      <rect class="fc" x="233" y="276" width="9" height="4.4" rx="0.8" fill="url(#metal)"/>
      <rect class="fc" x="245" y="270" width="9" height="4.4" rx="0.8" fill="url(#metal)"/>
      <rect class="fc" x="257" y="282" width="9" height="4.4" rx="0.8" fill="url(#metal)"/>
      <rect class="fc" x="269" y="273" width="9" height="4.4" rx="0.8" fill="url(#metal)"/>
      <rect class="fc" x="281" y="279" width="9" height="4.4" rx="0.8" fill="url(#metal)"/>
    </g>
    <g class="vu">
      <rect x="233.4" y="247.4" width="27.2" height="8.2" rx="1" fill="#050404"/>
      <rect x="234" y="248" width="26" height="7" rx="0.8" fill="#141008"/>
      <rect x="234" y="248" width="26" height="3.4" rx="0.8" fill="#d4a04a" opacity="0.07"/>
      <line class="needle" x1="247" y1="255" x2="247" y2="249" stroke="#d4a04a" stroke-width="0.9"/>
      <rect x="265.4" y="247.4" width="27.2" height="8.2" rx="1" fill="#050404"/>
      <rect x="266" y="248" width="26" height="7" rx="0.8" fill="#141008"/>
      <rect x="266" y="248" width="26" height="3.4" rx="0.8" fill="#d4a04a" opacity="0.07"/>
      <line class="needle n2" x1="279" y1="255" x2="279" y2="249" stroke="#d4a04a" stroke-width="0.9"/>
    </g>
  </g>

  <!-- ===================== CRATE : the library ===================== -->
  <g class="obj" data-go="library" data-label="Record crate. Browse your library.">
    <g class="hit"><rect x="86" y="380" width="122" height="106" rx="2"/></g>
    <ellipse cx="147" cy="488" rx="66" ry="9" fill="#000" opacity="0.72" filter="url(#contact)"/>
    <!-- sleeves stood on end, leaning the way a browsed crate always does -->
    <g class="sleeves">
      <g transform="rotate(-2.2 132 420)">
        <rect x="96" y="372" width="72" height="108" fill="#2c241c"/>
        <rect x="96" y="372" width="72" height="108" filter="url(#grain)" opacity="0.1" style="mix-blend-mode:multiply"/>
        <rect x="96" y="372" width="2.4" height="108" fill="#4c4033" opacity="0.6"/>
        <rect x="96" y="372" width="72" height="2.4" fill="#4c4033" opacity="0.45"/>
      </g>
      <g transform="rotate(-1.1 148 420)">
        <rect x="112" y="378" width="72" height="102" fill="#4e3a27"/>
        <rect x="112" y="378" width="72" height="102" filter="url(#grain)" opacity="0.1" style="mix-blend-mode:multiply"/>
        <rect x="112" y="378" width="2.4" height="102" fill="#7d6244" opacity="0.6"/>
        <rect x="112" y="378" width="72" height="2.4" fill="#8a6c4a" opacity="0.5"/>
        <rect x="124" y="392" width="48" height="12" fill="#0f0c0a" opacity="0.45"/>
      </g>
      <g>
        <rect x="128" y="374" width="72" height="106" fill="#7a4a2c"/>
        <rect x="128" y="374" width="72" height="106" filter="url(#grain)" opacity="0.11" style="mix-blend-mode:multiply"/>
        <rect x="128" y="374" width="72" height="106" fill="url(#lamp)" opacity="0.4"/>
        <rect x="128" y="374" width="2.4" height="106" fill="#b57c46" opacity="0.6"/>
        <rect x="128" y="374" width="72" height="2.4" fill="#c08c52" opacity="0.55"/>
        <circle cx="164" cy="400" r="15" fill="#120e0b" opacity="0.5"/>
        <circle cx="164" cy="400" r="5.4" fill="#c0442f" opacity="0.8"/>
      </g>
      <!-- one record slipped half out of its sleeve -->
      <g transform="rotate(3 206 400)">
        <circle cx="206" cy="404" r="26" fill="url(#vinylG)"/>
        <g fill="none" stroke="#241f1b" stroke-width="0.4" opacity="0.8">
          <circle cx="206" cy="404" r="23"/><circle cx="206" cy="404" r="20"/>
          <circle cx="206" cy="404" r="17"/><circle cx="206" cy="404" r="14"/>
        </g>
        <circle cx="206" cy="404" r="26" fill="url(#sheen)"/>
        <circle cx="206" cy="404" r="8" fill="url(#labelG)"/>
        <circle cx="206" cy="404" r="1.2" fill="#0a0908"/>
      </g>
    </g>
    <path d="M88 400 L206 400 L206 486 L88 486 Z" fill="#241c15"/>
    <path d="M88 400 L206 400 L206 486 L88 486 Z" filter="url(#woodgrain)" opacity="0.45" style="mix-blend-mode:multiply"/>
    <path d="M88 400 L206 400 L206 408 L88 408 Z" fill="#4a3627"/>
    <path d="M88 400 L206 400 L206 402.4 L88 402.4 Z" fill="#8a6540" opacity="0.7"/>
    <rect x="88" y="400" width="2.4" height="86" fill="#6b4f34" opacity="0.4"/>
    <rect x="203.6" y="400" width="2.4" height="86" fill="#000" opacity="0.45"/>
    <path d="M88 486 L206 486" stroke="#000" stroke-opacity="0.7" stroke-width="1.4"/>
    <rect x="132" y="452" width="30" height="12" rx="1" fill="#120f0d"/>
    <rect x="133" y="453" width="28" height="10" rx="0.8" fill="#2a231c"/>
  </g>

  <!-- ===================== TAPE MACHINE : add music ===================== -->
  <g class="obj" data-go="add" data-label="Tape machine. Add music.">
    <g class="hit"><rect x="216" y="388" width="112" height="80" rx="2"/></g>
    <ellipse cx="272" cy="468" rx="60" ry="8" fill="#000" opacity="0.7" filter="url(#contact)"/>
    <rect x="218" y="392" width="108" height="74" rx="1.5" fill="#0b0a09"/>
    <rect x="219" y="393" width="106" height="72" rx="1" fill="#26201a"/>
    <rect x="219" y="393" width="106" height="72" rx="1" filter="url(#brushed)" opacity="0.3" style="mix-blend-mode:overlay"/>
    <rect x="219" y="393" width="106" height="72" rx="1" fill="url(#lamp)" opacity="0.35"/>
    <rect x="219" y="393" width="106" height="2.2" fill="#6e6151" opacity="0.7"/>
    <rect x="219" y="463" width="106" height="1.6" fill="#000" opacity="0.55"/>
    <g class="reel r1">
      <circle cx="248" cy="422" r="18" fill="#0a0908"/>
      <circle cx="248" cy="422" r="17" fill="#1a1512"/>
      <circle cx="248" cy="422" r="13" fill="#3a2f22"/>
      <circle cx="248" cy="422" r="13" fill="url(#sheen)"/>
      <circle cx="248" cy="422" r="11" fill="none" stroke="#6b5c48" stroke-width="1.2"/>
      <path d="M248 405 L248 411 M265 422 L259 422 M248 439 L248 433 M231 422 L237 422" stroke="#8b7a60" stroke-width="1.4"/>
      <circle cx="248" cy="422" r="3.4" fill="url(#metal)"/>
    </g>
    <g class="reel r2">
      <circle cx="296" cy="422" r="18" fill="#0a0908"/>
      <circle cx="296" cy="422" r="17" fill="#1a1512"/>
      <circle cx="296" cy="422" r="9" fill="#3a2f22"/>
      <circle cx="296" cy="422" r="9" fill="url(#sheen)"/>
      <circle cx="296" cy="422" r="8" fill="none" stroke="#6b5c48" stroke-width="1.2"/>
      <path d="M296 405 L296 411 M313 422 L307 422 M296 439 L296 433 M279 422 L285 422" stroke="#8b7a60" stroke-width="1.4"/>
      <circle cx="296" cy="422" r="3.4" fill="url(#metal)"/>
    </g>
    <path d="M248 440 Q272 453 296 440" stroke="#000" stroke-opacity="0.5" stroke-width="2.6" fill="none"/>
    <path d="M248 439 Q272 452 296 439" stroke="#171310" stroke-width="2.2" fill="none"/>
    <g>
      <rect x="229.4" y="449.4" width="11.2" height="8.2" rx="1.2" fill="#080706"/>
      <rect x="230" y="450" width="10" height="7" rx="1" fill="url(#metal)"/>
      <rect x="243.4" y="449.4" width="11.2" height="8.2" rx="1.2" fill="#080706"/>
      <rect x="244" y="450" width="10" height="7" rx="1" fill="url(#metal)"/>
      <rect x="257.4" y="449.4" width="11.2" height="8.2" rx="1.2" fill="#080706"/>
      <rect x="258" y="450" width="10" height="7" rx="1" fill="#c0442f"/>
      <rect x="258" y="450" width="10" height="2.4" rx="1" fill="#e6704f" opacity="0.6"/>
    </g>
    <circle class="led" cx="312" cy="404" r="2" fill="#d4a04a"/>
    <circle class="led" cx="312" cy="404" r="4.6" fill="#d4a04a" opacity="0.4" filter="url(#bloom)"/>
  </g>

  <!-- ===================== TUNER : find online ===================== -->
  <g class="obj" data-go="find" data-label="Tuner. Find music online.">
    <g class="hit"><rect x="222" y="196" width="88" height="46" rx="2"/></g>
    <ellipse cx="266" cy="240" rx="44" ry="5" fill="#000" opacity="0.55" filter="url(#contact)"/>
    <rect x="226" y="200" width="80" height="38" rx="1.5" fill="#0b0a09"/>
    <rect x="227" y="201" width="78" height="36" rx="1" fill="#241e19"/>
    <rect x="227" y="201" width="78" height="36" rx="1" filter="url(#woodgrain)" opacity="0.3" style="mix-blend-mode:multiply"/>
    <rect x="227" y="201" width="78" height="36" rx="1" fill="url(#lamp)" opacity="0.4"/>
    <rect x="227" y="201" width="78" height="2" fill="#6a5c4a" opacity="0.6"/>
    <rect x="231.4" y="205.4" width="53.2" height="17.2" rx="1" fill="#050404"/>
    <rect x="232" y="206" width="52" height="16" rx="0.8" fill="#100d0b"/>
    <rect x="232" y="206" width="52" height="16" rx="0.8" fill="#d4a04a" opacity="0.06"/>
    <g class="dialmarks" opacity="0.6">
      <path d="M236 219 L236 209 M244 219 L244 211 M252 219 L252 209 M260 219 L260 211 M268 219 L268 209 M276 219 L276 211"
            stroke="#a3987d" stroke-width="0.7"/>
    </g>
    <line class="tune" x1="248" y1="205" x2="248" y2="223" stroke="#c0442f" stroke-width="1.4"/>
    <rect x="232" y="206" width="52" height="6" rx="0.8" fill="#fff3d6" opacity="0.06"/>
    <circle cx="295" cy="215" r="9" fill="#0b0a09"/>
    <circle class="knob-tune" cx="295" cy="215" r="8" fill="url(#knurl)"/>
    <g stroke="#171310" stroke-width="0.5" opacity="0.7">
      <line x1="295" y1="208" x2="295" y2="222"/><line x1="290" y1="210" x2="300" y2="220"/>
      <line x1="288" y1="215" x2="302" y2="215"/><line x1="290" y1="220" x2="300" y2="210"/>
    </g>
    <circle cx="295" cy="215" r="4.4" fill="url(#brass)"/>
    <circle cx="293.6" cy="213.6" r="1.2" fill="#fff5d8" opacity="0.6"/>
    <line x1="295" y1="215" x2="295" y2="209.4" stroke="#241e18" stroke-width="1.2"/>
    <circle class="led alive" cx="234" cy="232" r="1.8" fill="#7ac0a0"/>
    <circle class="led alive" cx="234" cy="232" r="4" fill="#7ac0a0" opacity="0.4" filter="url(#bloom)"/>
  </g>

  <!-- ===================== GUITAR : shuffle everything ===================== -->
  <g class="obj guitar" data-go="shuffle" data-label="Guitar. Shuffle everything.">
    <g class="hit"><rect x="10" y="334" width="84" height="212" rx="4"/></g>
    <g transform="rotate(-7 50 500)">
      <path d="M50 444 C36 444 27 452 25 464 C23 474 30 481 30 487 C30 494 21 500 21 512 C21 528 34 540 50 540 C66 540 79 528 79 512 C79 500 70 494 70 487 C70 481 77 474 75 464 C73 452 64 444 50 444 Z"
            fill="#000" opacity="0.6" filter="url(#contact)" transform="translate(7,10)"/>
      <path d="M50 352 L50 446" stroke="#0f0a06" stroke-width="10"/>
      <path d="M50 352 L50 446" stroke="#2f2115" stroke-width="8"/>
      <path d="M46.6 352 L46.6 446" stroke="#5a4229" stroke-width="1.4" opacity="0.5"/>
      <g stroke="#8d8269" stroke-width="0.7" opacity="0.5">
        <line x1="45" y1="364" x2="55" y2="364"/><line x1="45" y1="378" x2="55" y2="378"/>
        <line x1="45" y1="392" x2="55" y2="392"/><line x1="45" y1="406" x2="55" y2="406"/>
        <line x1="45" y1="420" x2="55" y2="420"/><line x1="45" y1="434" x2="55" y2="434"/>
      </g>
      <rect x="42.4" y="337.4" width="15.2" height="19.2" rx="2" fill="#0d0906"/>
      <rect x="43" y="338" width="14" height="18" rx="2" fill="#3a2a1c"/>
      <rect x="43" y="338" width="14" height="18" rx="2" filter="url(#woodgrain)" opacity="0.4" style="mix-blend-mode:multiply"/>
      <g fill="url(#metal)">
        <rect x="39.6" y="341" width="3.4" height="2" rx="1"/><rect x="39.6" y="348" width="3.4" height="2" rx="1"/>
        <rect x="57" y="341" width="3.4" height="2" rx="1"/><rect x="57" y="348" width="3.4" height="2" rx="1"/>
      </g>
      <path d="M50 444 C36 444 27 452 25 464 C23 474 30 481 30 487 C30 494 21 500 21 512 C21 528 34 540 50 540 C66 540 79 528 79 512 C79 500 70 494 70 487 C70 481 77 474 75 464 C73 452 64 444 50 444 Z" fill="#7a4d24"/>
      <path d="M50 444 C36 444 27 452 25 464 C23 474 30 481 30 487 C30 494 21 500 21 512 C21 528 34 540 50 540 C66 540 79 528 79 512 C79 500 70 494 70 487 C70 481 77 474 75 464 C73 452 64 444 50 444 Z"
            filter="url(#woodgrain)" opacity="0.42" style="mix-blend-mode:multiply"/>
      <path d="M50 444 C36 444 27 452 25 464 C23 474 30 481 30 487 C30 494 21 500 21 512 C21 528 34 540 50 540 C66 540 79 528 79 512 C79 500 70 494 70 487 C70 481 77 474 75 464 C73 452 64 444 50 444 Z" fill="url(#sheen)"/>
      <path d="M50 444 C36 444 27 452 25 464 C23 474 30 481 30 487 C30 494 21 500 21 512 C21 528 34 540 50 540 C66 540 79 528 79 512 C79 500 70 494 70 487 C70 481 77 474 75 464 C73 452 64 444 50 444 Z" fill="url(#lamp)" opacity="0.4"/>
      <path d="M50 445.5 C37 445.5 28.5 453 26.5 464.5 C24.8 474 31.5 481 31.5 487.4 C31.5 494.6 22.5 500.6 22.5 512" stroke="#d9b077" stroke-width="1" fill="none" opacity="0.35"/>
      <circle cx="50" cy="504" r="11.6" fill="#0c0805"/>
      <circle cx="50" cy="504" r="10.6" fill="#150f0a"/>
      <circle cx="50" cy="504" r="12.6" fill="none" stroke="#4a3018" stroke-width="1.4"/>
      <circle cx="50" cy="504" r="12.6" fill="none" stroke="#c99a5e" stroke-width="0.4" opacity="0.5"/>
      <g class="strings" stroke="#d9cdb4" stroke-width="0.55" opacity="0.85">
        <path class="s" d="M46 344 L46 526"/>
        <path class="s" d="M48 344 L48 526"/>
        <path class="s" d="M50 344 L50 526"/>
        <path class="s" d="M52 344 L52 526"/>
        <path class="s" d="M54 344 L54 526"/>
      </g>
      <rect x="41.4" y="519.4" width="17.2" height="6.2" rx="1.2" fill="#0d0906"/>
      <rect x="42" y="520" width="16" height="5" rx="1" fill="#2a1d13"/>
      <rect x="42" y="520" width="16" height="1.4" rx="1" fill="#6a4f31" opacity="0.7"/>
    </g>
  </g>

  <!-- ===================== MICROPHONE : search your library ===================== -->
  <g class="obj" data-go="search" data-label="Microphone. Search your library.">
    <g class="hit"><rect x="330" y="366" width="66" height="120" rx="3"/></g>
    <ellipse cx="362" cy="476" rx="26" ry="6" fill="#000" opacity="0.7" filter="url(#contact)"/>
    <path d="M362 470 L362 412" stroke="#0c0a08" stroke-width="4"/>
    <path d="M362 470 L362 412" stroke="#2b241d" stroke-width="2.6"/>
    <path d="M361 470 L361 412" stroke="#7d7461" stroke-width="0.6" opacity="0.5"/>
    <path d="M344 472 L380 472" stroke="#0c0a08" stroke-width="4" stroke-linecap="round"/>
    <path d="M344 472 L380 472" stroke="#2b241d" stroke-width="2.6" stroke-linecap="round"/>
    <ellipse cx="362" cy="474" rx="22" ry="4" fill="#0d0b09"/>
    <ellipse cx="362" cy="473" rx="22" ry="4" fill="url(#metal)" opacity="0.35"/>
    <path d="M352 404 L372 404 L370 386 A8 8 0 0 0 354 386 Z" fill="#0c0a09"/>
    <path d="M352.8 403.2 L371.2 403.2 L369.3 386.6 A7.3 7.3 0 0 0 354.7 386.6 Z" fill="#2e2721"/>
    <path d="M352.8 403.2 L371.2 403.2 L369.3 386.6 A7.3 7.3 0 0 0 354.7 386.6 Z" fill="url(#lamp)" opacity="0.45"/>
    <ellipse cx="362" cy="390" rx="12" ry="14" fill="#0a0908"/>
    <ellipse class="mic-head" cx="362" cy="390" rx="11" ry="13" fill="#1a1512"/>
    <ellipse cx="362" cy="390" rx="11" ry="13" fill="url(#cloth)"/>
    <ellipse cx="362" cy="390" rx="11" ry="13" fill="url(#sheen)"/>
    <path d="M355 380 Q362 376 369 380" stroke="#fff3d6" stroke-width="0.8" fill="none" opacity="0.25"/>
    <rect x="355.4" y="405.4" width="13.2" height="6.2" rx="1.2" fill="#080706"/>
    <rect x="356" y="406" width="12" height="5" rx="1" fill="url(#metal)"/>
    <circle class="led" cx="362" cy="414" r="1.7" fill="#c0442f"/>
    <circle class="led" cx="362" cy="414" r="4" fill="#c0442f" opacity="0.45" filter="url(#bloom)"/>
  </g>

  <!-- ===================== HEADPHONES : liked songs ===================== -->
  <!-- Hung on the wall, clear of the desk. -->
  <g class="obj" data-go="liked" data-label="Headphones. Your liked songs.">
    <g class="hit"><rect x="104" y="122" width="66" height="76" rx="3"/></g>
    <ellipse cx="137" cy="184" rx="24" ry="7" fill="#000" opacity="0.45" filter="url(#contact)"/>
    <path d="M137 124 L137 140" stroke="#4a4038" stroke-width="2"/>
    <circle cx="137" cy="123" r="3" fill="#0d0b09"/>
    <circle cx="137" cy="123" r="2.2" fill="url(#metal)"/>
    <path d="M119 172 A19 19 0 0 1 155 172" fill="none" stroke="#0f0d0b" stroke-width="7" stroke-linecap="round"/>
    <path d="M119 172 A19 19 0 0 1 155 172" fill="none" stroke="#3f362c" stroke-width="4" stroke-linecap="round"/>
    <path d="M120.6 169.4 A18 18 0 0 1 153.4 169.4" fill="none" stroke="#8b8170" stroke-width="0.8"
          stroke-linecap="round" opacity="0.5"/>
    <rect x="112.4" y="169.4" width="13.2" height="20.2" rx="5.6" fill="#0f0d0b"/>
    <rect x="113" y="170" width="12" height="19" rx="5" fill="#1c1713"/>
    <rect x="114.2" y="171.2" width="9.6" height="16.6" rx="4.4" fill="url(#cloth)"/>
    <rect x="148.4" y="169.4" width="13.2" height="20.2" rx="5.6" fill="#0f0d0b"/>
    <rect x="149" y="170" width="12" height="19" rx="5" fill="#1c1713"/>
    <rect x="150.2" y="171.2" width="9.6" height="16.6" rx="4.4" fill="url(#cloth)"/>
    <path class="hp-cord" d="M155 187 Q166 200 160 212" stroke="#0a0807" stroke-width="2.2" fill="none"/>
    <circle class="led" cx="119" cy="193" r="1.5" fill="#c0442f"/>
    <circle class="led" cx="119" cy="193" r="3.6" fill="#c0442f" opacity="0.42" filter="url(#bloom)"/>
  </g>

  <!-- cable running to the desk, because everything here is plugged in -->
  <path d="M92 372 C120 392 150 386 168 372" stroke="#000" stroke-opacity="0.5" stroke-width="4" fill="none"/>
  <path d="M92 371 C120 391 150 385 168 371" stroke="#151210" stroke-width="3" fill="none"/>
  <path d="M316 372 C296 396 268 388 250 372" stroke="#000" stroke-opacity="0.5" stroke-width="4" fill="none"/>
  <path d="M316 371 C296 395 268 387 250 371" stroke="#151210" stroke-width="3" fill="none"/>

  <!-- dust in the lamp beam -->
  <g class="motes" opacity="0.5" fill="#ffe9bd" pointer-events="none">
    <circle cx="150" cy="120" r="1"/><circle cx="212" cy="80" r="0.8"/><circle cx="176" cy="170" r="0.9"/>
    <circle cx="248" cy="140" r="0.7"/><circle cx="124" cy="188" r="0.8"/>
    <circle cx="292" cy="176" r="0.7"/><circle cx="68" cy="150" r="0.6"/>
  </g>

  <!-- the box closes: grain over everything, then the falloff to the corners -->
  <rect width="400" height="624" filter="url(#grain)" opacity="0.045" pointer-events="none" style="mix-blend-mode:overlay"/>
  <rect width="400" height="624" fill="url(#vig)" pointer-events="none"/>
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
