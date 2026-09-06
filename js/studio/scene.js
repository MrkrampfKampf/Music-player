/**
 * The studio.
 *
 * A real room, built and lit rather than drawn: geometry in metres, physically
 * based materials, warm practical fixtures, soft shadows and a camera you can
 * walk through it. There is no interface layer over the top — the equipment is
 * the interface, and the only thing the DOM contributes is one transparent
 * button per object so the room can be reached by keyboard and read by a
 * screen reader.
 *
 * The room is laid out the way a small control room actually is: a long timber
 * desk against the back wall, monitors up on the bridge, the console under
 * your right hand, the recorder where you can reach it, the guitar in the
 * corner where guitars end up, and everything cabled to everything else.
 */

import {
  ACESFilmicToneMapping, AmbientLight, Box3, BoxGeometry, CapsuleGeometry, CatmullRomCurve3,
  CircleGeometry, Color, CylinderGeometry, DoubleSide, ExtrudeGeometry, Group, LatheGeometry,
  Mesh, MeshPhysicalMaterial, MeshStandardMaterial, PCFSoftShadowMap, PMREMGenerator,
  PerspectiveCamera, PlaneGeometry, PointLight, Scene, Shape, SphereGeometry, SpotLight,
  SRGBColorSpace, TorusGeometry, TubeGeometry, Vector2, Vector3, WebGLRenderer,
} from '../../vendor/three/three.module.js';
import { RoomEnvironment } from '../../vendor/three/environments/RoomEnvironment.js';
import { EffectComposer } from '../../vendor/three/postprocessing/EffectComposer.js';
import { RenderPass } from '../../vendor/three/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../../vendor/three/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../../vendor/three/postprocessing/OutputPass.js';
import * as tex from './textures.js';

/* --------------------------------------------------------------- materials */

const V2 = (x, y) => new Vector2(x, y);

function wood(seed, tone, repeat, extra = {}) {
  const t = tex.oak(seed, tone);
  const m = new MeshStandardMaterial({
    map: t.map.clone(),
    normalMap: t.normalMap.clone(),
    roughnessMap: t.roughnessMap.clone(),
    normalScale: V2(0.7, 0.7),
    roughness: 1,
    metalness: 0,
    ...extra,
  });
  for (const key of ['map', 'normalMap', 'roughnessMap']) {
    m[key].repeat.set(repeat[0], repeat[1]);
    m[key].needsUpdate = true;
  }
  return m;
}

function foamMat(repeat) {
  const t = tex.foam();
  const m = new MeshStandardMaterial({
    map: t.map.clone(), normalMap: t.normalMap.clone(),
    normalScale: V2(1.5, 1.5), roughness: 0.98, metalness: 0,
  });
  m.map.repeat.set(repeat[0], repeat[1]);
  m.normalMap.repeat.set(repeat[0], repeat[1]);
  return m;
}

function clothMat(repeat) {
  const t = tex.grille();
  const m = new MeshStandardMaterial({
    map: t.map.clone(), normalMap: t.normalMap.clone(),
    normalScale: V2(0.9, 0.9), roughness: 0.94, metalness: 0,
  });
  m.map.repeat.set(repeat[0], repeat[1]);
  m.normalMap.repeat.set(repeat[0], repeat[1]);
  return m;
}

function alloy(colour = 0xb9b2a4, roughness = 0.34, metalness = 1) {
  const t = tex.brushed();
  return new MeshStandardMaterial({
    color: colour, roughness, metalness,
    roughnessMap: t.roughnessMap, normalMap: t.normalMap, normalScale: V2(0.3, 0.3),
  });
}

/** A shape that is only there to be touched: it has size but no surface. */
const untouchableGeom = () => new MeshStandardMaterial({ visible: false });

const painted = (colour, roughness = 0.5, side) =>
  new MeshStandardMaterial({ color: colour, roughness, metalness: 0.05, ...(side ? { side } : {}) });

const glass = () => new MeshPhysicalMaterial({
  color: 0x0b0d0e, roughness: 0.06, metalness: 0, transmission: 0,
  clearcoat: 1, clearcoatRoughness: 0.03, reflectivity: 0.6,
});

function lit(colour, strength = 1) {
  return new MeshStandardMaterial({
    color: 0x000000, emissive: new Color(colour), emissiveIntensity: strength,
    roughness: 1, metalness: 0,
  });
}

/* ------------------------------------------------------------------ shapes */

const box = (w, h, d, m, seg) => new Mesh(new BoxGeometry(w, h, d, seg, seg, seg), m);

function place(mesh, x, y, z, rx = 0, ry = 0, rz = 0) {
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  return mesh;
}

function shadowy(mesh, cast = true, receive = true) {
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

/** A rounded slab: what most equipment actually is. */
function slab(w, h, d, r, m) {
  const shape = new Shape();
  const x = -w / 2;
  const y = -h / 2;
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  const geo = new ExtrudeGeometry(shape, {
    depth: d, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.004, bevelSegments: 2,
    curveSegments: 6,
  });
  geo.translate(0, 0, -d / 2);
  return new Mesh(geo, m);
}

/* ============================================================== the studio */

export function buildStudio(canvas) {
  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  const scene = new Scene();
  scene.background = new Color(0x070605);

  // Indirect light. Without it every metal in the room is a black hole, and
  // the shadows have nothing to fill them.
  const pmrem = new PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.06);
  scene.environment = env.texture;
  scene.environmentIntensity = 0.1;

  const camera = new PerspectiveCamera(52, 1, 0.05, 60);
  camera.position.set(0.05, 1.5, 2.12);
  // Where the camera is looking, and where it stands when it is not walking.
  const aim = new Vector3(0.0, 0.97, -2.3);
  camera.lookAt(aim);
  const home = { pos: camera.position.clone(), aim: aim.clone() };

  const parts = {};
  const pickables = [];

  /* ------------------------------------------------------------- the shell */

  const W = 3.7;
  const H = 2.72;
  const D = 7.4;
  const WALL = -2.45;
  const BACK = WALL;

  const floorMat = (() => {
    const t = tex.concrete();
    const m = new MeshStandardMaterial({
      map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap,
      normalScale: V2(0.6, 0.6), roughness: 1, metalness: 0, color: 0x6b6055,
    });
    for (const k of ['map', 'normalMap', 'roughnessMap']) m[k].repeat.set(4, 4);
    return m;
  })();
  const floor = shadowy(place(new Mesh(new PlaneGeometry(W, D), floorMat), 0, 0, BACK + D / 2, -Math.PI / 2), false, true);
  scene.add(floor);

  const wallMat = (() => {
    const t = tex.plaster();
    const m = new MeshStandardMaterial({
      map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap,
      normalScale: V2(0.5, 0.5), roughness: 1, metalness: 0, color: 0x4a423c,
    });
    for (const k of ['map', 'normalMap', 'roughnessMap']) m[k].repeat.set(3, 2);
    return m;
  })();
  scene.add(shadowy(place(new Mesh(new PlaneGeometry(W, H), wallMat), 0, H / 2, BACK), false, true));
  scene.add(shadowy(place(new Mesh(new PlaneGeometry(D, H), wallMat.clone()), -W / 2, H / 2, BACK + D / 2, 0, Math.PI / 2), false, true));
  scene.add(shadowy(place(new Mesh(new PlaneGeometry(D, H), wallMat.clone()), W / 2, H / 2, BACK + D / 2, 0, -Math.PI / 2), false, true));
  scene.add(place(new Mesh(new PlaneGeometry(W, D), painted(0x2b2521, 0.95)), 0, H, BACK + D / 2, Math.PI / 2));

  /* -------------------------------------------------- acoustic treatment */

  const foam1 = foamMat([2, 3]);
  const addPanel = (x, y, z, w, h, ry = 0) => {
    const p = shadowy(place(box(w, h, 0.075, foam1), x, y, z, 0, ry));
    scene.add(p);
    return p;
  };
  // back wall, deliberately not a grid: two tall, one short, one offset
  addPanel(-1.24, 1.6, BACK + 0.04, 0.46, 0.96);
  addPanel(-0.72, 1.5, BACK + 0.04, 0.4, 0.66);
  addPanel(1.06, 1.72, BACK + 0.04, 0.52, 0.84);
  addPanel(1.48, 1.26, BACK + 0.04, 0.32, 0.52);
  // left wall
  addPanel(-W / 2 + 0.045, 1.7, -1.9, 1.2, 1.1, Math.PI / 2);
  addPanel(-W / 2 + 0.045, 1.4, -0.6, 0.8, 0.66, Math.PI / 2);

  /* ------------------------------------------------------------- the desk */

  const deskWood = wood(3, 1, [3.2, 0.8]);
  const deskDark = wood(11, 0.72, [3.2, 0.5]);
  const DESK_TOP = 0.79;
  const DESK_FRONT = -1.36;
  const DESK_BACK = BACK + 0.12;
  const DESK_DEPTH = DESK_FRONT - DESK_BACK;
  const DESK_W = 2.9;

  const desk = new Group();
  // the worktop, with a lipped front edge
  desk.add(shadowy(place(box(DESK_W, 0.055, DESK_DEPTH, deskWood),
    -0.06, DESK_TOP, (DESK_FRONT + DESK_BACK) / 2)));
  desk.add(shadowy(place(box(DESK_W, 0.1, 0.03, deskWood),
    -0.06, DESK_TOP - 0.04, DESK_FRONT + 0.005)));
  // the front panel, vertical boards, set back so the top overhangs it
  desk.add(shadowy(place(box(DESK_W, DESK_TOP - 0.12, 0.05, wood(7, 0.92, [3.2, 0.7])),
    -0.06, (DESK_TOP - 0.12) / 2 + 0.06, DESK_FRONT - 0.06)));
  desk.add(shadowy(place(box(DESK_W, 0.06, 0.5, painted(0x0b0908, 0.9)),
    -0.06, 0.04, DESK_FRONT - 0.3), false, true));
  // the raised bridge at the back, where the monitors and console sit
  const BRIDGE = 1.06;
  desk.add(shadowy(place(box(DESK_W, 0.05, 0.42, deskWood.clone()),
    -0.06, BRIDGE, DESK_BACK + 0.21)));
  desk.add(shadowy(place(box(DESK_W, BRIDGE - DESK_TOP, 0.05, deskDark),
    -0.06, (BRIDGE + DESK_TOP) / 2, DESK_BACK + 0.4)));
  scene.add(desk);

  /* -------------------------------------------------------------- lighting */

  scene.add(new AmbientLight(0x252830, 0.4));
  // The light that has bounced off the walls once. Without it a room lit only
  // by spots is a set of pools in a void.
  const bounce = new PointLight(0xffc48c, 2.4, 8, 1.6);
  bounce.position.set(0, H - 0.5, BACK + 1.3);
  scene.add(bounce);

  // Recessed ceiling spots. Each one is a real fixture with a real cone.
  const spots = [];
  // Only the two lamps over the desk cast: shadow maps are the expensive part
  // of a room like this, and the rest of the fixtures only wash surfaces.
  const addSpot = (x, z, tx, tz, intensity, angle, colour = 0xffc078, ty = 0.8, cast = false) => {
    const s = new SpotLight(colour, intensity, 12, angle, 0.75, 1.6);
    s.position.set(x, H - 0.06, z);
    s.target.position.set(tx, ty, tz);
    s.castShadow = cast;
    s.shadow.mapSize.set(1024, 1024);
    s.shadow.bias = -0.0016;
    s.shadow.normalBias = 0.02;
    s.shadow.camera.near = 0.4;
    s.shadow.camera.far = 9;
    scene.add(s, s.target);
    // the fixture: a housing, and the lamp recessed a little way up inside it
    scene.add(place(new Mesh(new CylinderGeometry(0.078, 0.062, 0.055, 24, 1, true), painted(0x14100e, 0.55, DoubleSide)), x, H - 0.028, z));
    scene.add(place(new Mesh(new CircleGeometry(0.058, 22), lit(0xffd9a4, 2.2)), x, H - 0.052, z, Math.PI / 2));
    spots.push(s);
    return s;
  };
  addSpot(-0.95, -0.95, -1.05, BACK + 0.5, 44, 0.56, 0xffc078, 0.8, true);
  addSpot(0.85, -0.2, 0.75, -1.3, 38, 0.52, 0xffc078, 0.8, true);
  addSpot(0.0, -1.8, 0.0, BACK + 0.1, 26, 0.46, 0xffb968);
  addSpot(-1.15, -1.85, -1.2, BACK + 0.05, 24, 0.42, 0xffb968, 1.75);
  addSpot(1.1, -1.85, 1.15, BACK + 0.05, 24, 0.42, 0xffb968, 1.75);

  /** A strip of light under a shelf: the thing that makes a studio look warm. */
  const strips = [];
  const addStrip = (x, y, z, w, colour = 0xffb15c, power = 1.1) => {
    const bar = place(new Mesh(new BoxGeometry(w, 0.01, 0.016), lit(colour, 1.5)), x, y, z);
    scene.add(bar);
    const n = Math.max(2, Math.round(w / 0.9));
    for (let i = 0; i < n; i++) {
      const p = new PointLight(colour, power, 2.2, 1.8);
      p.position.set(x - w / 2 + (w * (i + 0.5)) / n, y - 0.03, z + 0.05);
      scene.add(p);
      strips.push(p);
    }
    return bar;
  };
  addStrip(-0.06, DESK_TOP - 0.072, DESK_FRONT - 0.028, 2.6, 0xffab54, 0.85);
  addStrip(-0.06, BRIDGE - 0.028, DESK_BACK + 0.4, 2.55, 0xffb15c, 0.55);

  /* ------------------------------------------------ the meter bridge (find) */

  {
    const g = new Group();
    const shell = shadowy(place(box(1.24, 0.46, 0.3, wood(19, 0.95, [2, 1])), 0, 0, 0));
    g.add(shell);
    g.add(place(box(1.16, 0.34, 0.02, painted(0x0d0b0a, 0.5)), 0, 0.02, 0.155));
    const face = place(new Mesh(new PlaneGeometry(1.06, 0.2), lit(0xffcf82, 0.28)), -0.06, 0.05, 0.168);
    g.add(face);
    parts.tunerFace = face;
    // the scale, drawn as ticks and a needle
    for (let i = 0; i < 22; i++) {
      const h = i % 5 === 0 ? 0.05 : 0.03;
      g.add(place(new Mesh(new PlaneGeometry(0.004, h), painted(0x1a1512, 0.9)),
        -0.55 + i * 0.047, 0.06 - (0.05 - h) / 2, 0.1695));
    }
    const needle = place(new Mesh(new PlaneGeometry(0.006, 0.17), lit(0xff5a34, 2.4)), -0.3, 0.05, 0.171);
    g.add(needle);
    parts.tunerNeedle = needle;
    // the tuning knob, a real turned aluminium dial
    const knob = place(new Mesh(new CylinderGeometry(0.062, 0.062, 0.05, 40), alloy(0xd8d0bf, 0.22)),
      0.47, 0.02, 0.17, Math.PI / 2);
    g.add(shadowy(knob));
    parts.tunerKnob = knob;
    g.position.set(-0.86, 1.94, BACK + 0.18);
    g.rotation.y = 0.06;
    scene.add(g);
    pickables.push({ name: 'find', label: 'Tuner. Find music online.', node: g,
      size: [1.3, 0.5, 0.35], look: [-0.86, 1.94, BACK + 0.18], from: [-0.62, 1.86, -1.15] });
  }

  /* ----------------------------------------------------- monitors (toggle) */

  const cones = [];
  const monitor = (x, flip) => {
    const g = new Group();
    const cab = shadowy(slab(0.30, 0.44, 0.27, 0.02, painted(0x171412, 0.62)));
    g.add(cab);
    // baffle, set proud, in a lighter grey the way real monitors are
    g.add(place(slab(0.275, 0.415, 0.012, 0.016, painted(0x201c19, 0.55)), 0, 0, 0.142));
    // woofer: a real cone, turned on a lathe profile
    const profile = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      profile.push(new Vector2(0.005 + t * 0.082, -0.03 * (1 - t) * (1 - t)));
    }
    const cone = place(new Mesh(new LatheGeometry(profile, 36), painted(0x0d0b0a, 0.72)), 0, -0.075, 0.148, -Math.PI / 2);
    g.add(cone);
    cones.push(cone);
    g.add(place(new Mesh(new TorusGeometry(0.088, 0.012, 10, 34), painted(0x0a0908, 0.8)), 0, -0.075, 0.15));
    g.add(place(new Mesh(new SphereGeometry(0.022, 20, 14), alloy(0x9c968a, 0.3)), 0, -0.075, 0.156));
    // tweeter in a shallow waveguide
    g.add(place(new Mesh(new LatheGeometry([
      new Vector2(0.012, 0), new Vector2(0.028, -0.012), new Vector2(0.046, -0.016),
    ], 28), painted(0x141110, 0.6)), 0, 0.115, 0.148, -Math.PI / 2));
    g.add(place(new Mesh(new SphereGeometry(0.014, 18, 12), alloy(0xcfc7b6, 0.18)), 0, 0.115, 0.152));
    // port and badge
    g.add(place(new Mesh(new CylinderGeometry(0.022, 0.022, 0.03, 20), painted(0x080706, 0.9)), 0, 0.038, 0.143, Math.PI / 2));
    const led = place(new Mesh(new SphereGeometry(0.005, 10, 8), lit(0x6fe08a, 3)), 0.1, -0.185, 0.15);
    g.add(led);
    parts['monitorLed' + (flip ? 'R' : 'L')] = led;
    g.position.set(x, BRIDGE + 0.245, DESK_BACK + 0.2);
    g.rotation.y = flip ? -0.26 : 0.26;
    scene.add(g);
    return g;
  };
  const monL = monitor(-0.94, false);
  const monR = monitor(0.78, true);
  pickables.push({ name: 'toggle', label: 'Monitors. Start or stop the music.', node: monR,
    size: [0.34, 0.5, 0.32], look: [0.78, BRIDGE + 0.245, DESK_BACK + 0.2], from: [0.58, 1.44, -1.05] });
  pickables.push({ name: 'toggle', label: 'Monitors. Start or stop the music.', node: monL,
    size: [0.34, 0.5, 0.32], look: [-0.94, BRIDGE + 0.245, DESK_BACK + 0.2], from: [-0.68, 1.44, -1.05] });

  /* ------------------------------------------------------ console (settings) */

  {
    const g = new Group();
    const body = shadowy(place(box(1.15, 0.09, 0.5, painted(0x22201d, 0.55)), 0, 0.045, 0));
    g.add(body);
    // the panel is raked, the way a desk you actually reach across is
    const panel = place(slab(1.1, 0.46, 0.018, 0.008, alloy(0xa8a294, 0.38, 0.85)), 0, 0.135, 0.02, -1.16);
    g.add(shadowy(panel));
    parts.consolePanel = panel;

    // two backlit meter windows
    const meters = [];
    for (const mx of [-0.1, 0.26]) {
      const w = place(new Mesh(new PlaneGeometry(0.3, 0.1), lit(0xffb959, 1.5)), mx, 0.226, 0.128, -1.16);
      g.add(w);
      const needle = place(new Mesh(new PlaneGeometry(0.004, 0.075), painted(0x120e0a, 0.9)), mx, 0.226, 0.13, -1.16);
      needle.geometry.translate(0, -0.037, 0);
      g.add(needle);
      meters.push(needle);
      const p = new PointLight(0xffb959, 1.4, 1.1, 1.8);
      p.position.set(mx, 0.3, 0.16);
      g.add(p);
    }
    parts.meters = meters;

    // faders on real tracks, and their caps
    const caps = [];
    for (let i = 0; i < 5; i++) {
      const fx = -0.24 + i * 0.16;
      g.add(place(box(0.012, 0.005, 0.17, painted(0x080706, 0.6)), fx, 0.153, -0.03, -1.16));
      const cap = place(slab(0.042, 0.022, 0.026, 0.004, alloy(0xe6ded0, 0.3, 0.4)), fx, 0.168, -0.03, -1.16);
      g.add(cap);
      caps.push(cap);
    }
    parts.faderCaps = caps;

    // the crossfade knob
    const knob = place(new Mesh(new CylinderGeometry(0.036, 0.034, 0.028, 32), alloy(0xd0c8b8, 0.26)),
      -0.46, 0.176, -0.03, -1.16 + Math.PI / 2);
    g.add(shadowy(knob));
    parts.crossfadeKnob = knob;
    g.add(place(new Mesh(new BoxGeometry(0.004, 0.03, 0.008), painted(0x14100e, 0.7)), -0.46, 0.19, -0.042, -1.16));

    g.position.set(0.26, BRIDGE + 0.025, DESK_BACK + 0.24);
    g.rotation.y = -0.08;
    scene.add(g);
    // The reach is the console's chassis, below the panel: the faders and the
    // knob own the panel itself, and they are what you touch up there.
    pickables.push({ name: 'settings', label: 'Mixing console. Sound and settings.', node: body, move: g,
      size: [1.2, 0.2, 0.55], look: [0.26, BRIDGE + 0.16, DESK_BACK + 0.24], from: [0.22, 1.42, -1.2] });
  }

  /* --------------------------------------------------------- deck (player) */

  {
    const g = new Group();
    const plinth = shadowy(place(box(0.46, 0.075, 0.37, wood(23, 0.85, [0.6, 0.5])), 0, 0.037, 0));
    g.add(plinth);
    const top = place(box(0.44, 0.008, 0.35, alloy(0x8d8779, 0.4, 0.7)), 0, 0.078, 0);
    g.add(shadowy(top));
    // the platter, machined, sitting in its well
    g.add(place(new Mesh(new CylinderGeometry(0.155, 0.155, 0.012, 60), painted(0x0a0908, 0.85)), -0.04, 0.079, 0.005));
    const platter = place(new Mesh(new CylinderGeometry(0.148, 0.148, 0.014, 60), alloy(0x6e6a60, 0.42, 0.9)), -0.04, 0.089, 0.005);
    g.add(shadowy(platter));
    // the record on it
    const record = new Group();
    record.add(place(new Mesh(new CylinderGeometry(0.146, 0.146, 0.0022, 72), new MeshStandardMaterial({
      color: 0x080707, roughness: 0.22, metalness: 0.0, clearcoat: 1,
    })), 0, 0, 0));
    record.add(place(new Mesh(new CylinderGeometry(0.049, 0.049, 0.0025, 40), painted(0xb8452c, 0.65)), 0, 0.0004, 0));
    record.add(place(new Mesh(new CylinderGeometry(0.0035, 0.0035, 0.012, 12), alloy(0xd4ccbb, 0.25)), 0, 0.006, 0));
    record.position.set(-0.04, 0.097, 0.005);
    g.add(record);
    parts.platter = record;
    // tonearm: pivot, counterweight, tube, headshell, stylus
    const arm = new Group();
    arm.add(place(new Mesh(new CylinderGeometry(0.024, 0.026, 0.05, 24), alloy(0xa39c8c, 0.3)), 0, 0.02, 0));
    arm.add(place(new Mesh(new CylinderGeometry(0.005, 0.005, 0.24, 14), alloy(0xc9c1b1, 0.24)), -0.1, 0.042, 0, 0, 0, Math.PI / 2));
    arm.add(place(box(0.03, 0.014, 0.02, painted(0x8d8779, 0.4)), -0.215, 0.042, 0));
    arm.add(place(box(0.016, 0.02, 0.014, painted(0xb8452c, 0.5)), -0.222, 0.03, 0));
    arm.add(place(new Mesh(new CylinderGeometry(0.019, 0.019, 0.034, 20), alloy(0x8f887a, 0.3)), 0.055, 0.042, 0, 0, 0, Math.PI / 2));
    arm.position.set(0.16, 0.082, -0.11);
    g.add(shadowy(arm));
    parts.tonearm = arm;
    // speed keys and the maker's plate
    for (let i = 0; i < 2; i++) {
      g.add(place(slab(0.036, 0.016, 0.008, 0.002, painted(i ? 0x2b2724 : 0x3d3a35, 0.5)),
        -0.17 + i * 0.045, 0.084, 0.152, -Math.PI / 2));
    }
    const deckLed = place(new Mesh(new SphereGeometry(0.004, 10, 8), lit(0xffb15c, 3)), -0.2, 0.086, 0.152);
    g.add(deckLed);
    parts.deckLed = deckLed;

    g.position.set(-0.6, DESK_TOP + 0.028, DESK_BACK + 0.62);
    g.rotation.y = 0.12;
    scene.add(g);
    // The reach is the front left of the plinth, clear of the arm, which owns
    // the space over the record.
    const reach = place(box(0.2, 0.07, 0.1, untouchableGeom()), -0.13, 0.04, 0.13);
    g.add(reach);
    pickables.push({ name: 'player', label: 'Turntable. Open the player.', node: reach, move: g,
      size: [0.5, 0.12, 0.42], look: [-0.6, DESK_TOP + 0.09, DESK_BACK + 0.62], from: [-0.48, 1.24, -0.55] });
  }

  /* ----------------------------------------------------- tape machine (add) */

  {
    const g = new Group();
    g.add(shadowy(place(box(0.62, 0.42, 0.2, painted(0x1b1917, 0.5)), 0, 0, 0)));
    g.add(place(slab(0.58, 0.38, 0.014, 0.006, alloy(0x8a8478, 0.42, 0.8)), 0, 0.01, 0.104));
    const reels = [];
    for (const [rx, rr] of [[-0.14, 0.11], [0.15, 0.075]]) {
      const hub = new Group();
      hub.add(place(new Mesh(new CylinderGeometry(rr, rr, 0.022, 40), painted(0x241f1a, 0.55)), 0, 0, 0, Math.PI / 2));
      hub.add(place(new Mesh(new CylinderGeometry(0.026, 0.026, 0.03, 20), alloy(0xbdb5a4, 0.3)), 0, 0, 0.006, Math.PI / 2));
      for (let i = 0; i < 3; i++) {
        hub.add(place(box(0.012, rr * 1.5, 0.006, painted(0x6d6353, 0.5)), 0, 0, 0.012, 0, 0, (i * Math.PI) / 3));
      }
      hub.position.set(rx, 0.06, 0.118);
      g.add(hub);
      reels.push(hub);
    }
    parts.reels = reels;
    // transport keys, the middle one red
    for (let i = 0; i < 3; i++) {
      g.add(place(slab(0.05, 0.022, 0.012, 0.003, painted(i === 2 ? 0xc0442f : 0xd8d0c0, 0.42)),
        -0.13 + i * 0.062, -0.135, 0.108));
    }
    const led = place(new Mesh(new SphereGeometry(0.005, 10, 8), lit(0xffb15c, 3)), 0.24, 0.15, 0.108);
    g.add(led);
    parts.tapeLed = led;

    g.position.set(0.58, 0.63, DESK_FRONT + 0.42);
    g.rotation.y = -0.14;
    // it sits on a low crate of its own, on the floor in front of the desk
    scene.add(shadowy(place(box(0.7, 0.62, 0.34, wood(31, 0.8, [0.9, 0.8])), 0.58, 0.32, DESK_FRONT + 0.42, 0, -0.14)));
    scene.add(g);
    pickables.push({ name: 'add', label: 'Tape machine. Add music.', node: g,
      size: [0.68, 0.5, 0.28], look: [0.58, 0.63, DESK_FRONT + 0.42], from: [0.45, 1.22, 0.9] });
  }

  /* ------------------------------------------------------- crate (library) */

  {
    const g = new Group();
    const crateWood = wood(41, 0.78, [0.7, 0.5]);
    g.add(shadowy(place(box(0.44, 0.34, 0.02, crateWood), 0, 0, 0.19)));
    g.add(shadowy(place(box(0.44, 0.34, 0.02, crateWood), 0, 0, -0.19)));
    g.add(shadowy(place(box(0.02, 0.34, 0.4, crateWood), -0.22, 0, 0)));
    g.add(shadowy(place(box(0.02, 0.34, 0.4, crateWood), 0.22, 0, 0)));
    g.add(place(box(0.42, 0.02, 0.38, painted(0x0e0c0b, 0.8)), 0, -0.16, 0));
    // sleeves standing in it, leaning back, all slightly different
    const tints = [0x2c241c, 0x4e3a27, 0x7a4a2c, 0x33293c, 0x5c4a2a, 0x1f2a2c, 0x6b3a24];
    for (let i = 0; i < tints.length; i++) {
      const s = place(box(0.395, 0.4, 0.012, painted(tints[i], 0.78)),
        0, 0.06 + i * 0.002, -0.14 + i * 0.045, -0.06 - i * 0.008);
      g.add(shadowy(s));
    }
    g.position.set(-0.44, 0.17, DESK_FRONT + 0.66);
    g.rotation.y = 0.24;
    scene.add(g);
    pickables.push({ name: 'library', label: 'Record crate. Browse your library.', node: g,
      size: [0.5, 0.46, 0.46], look: [-0.44, 0.32, DESK_FRONT + 0.66], from: [-0.4, 1.0, 0.98] });
  }

  /* ------------------------------------------------------- guitar (shuffle) */

  {
    const g = new Group();
    // a dreadnought outline: two lobes and a waist, traced in beziers
    const s = new Shape();
    s.moveTo(0, 0.26);
    s.bezierCurveTo(0.13, 0.26, 0.19, 0.17, 0.185, 0.075);
    s.bezierCurveTo(0.182, 0.03, 0.15, 0.012, 0.15, -0.015);
    s.bezierCurveTo(0.15, -0.05, 0.2, -0.08, 0.205, -0.16);
    s.bezierCurveTo(0.21, -0.26, 0.12, -0.325, 0, -0.325);
    s.bezierCurveTo(-0.12, -0.325, -0.21, -0.26, -0.205, -0.16);
    s.bezierCurveTo(-0.2, -0.08, -0.15, -0.05, -0.15, -0.015);
    s.bezierCurveTo(-0.15, 0.012, -0.182, 0.03, -0.185, 0.075);
    s.bezierCurveTo(-0.19, 0.17, -0.13, 0.26, 0, 0.26);
    const bodyGeo = new ExtrudeGeometry(s, {
      depth: 0.105, bevelEnabled: true, bevelSize: 0.016, bevelThickness: 0.014,
      bevelSegments: 5, curveSegments: 22,
    });
    bodyGeo.translate(0, 0, -0.05);
    const body = shadowy(new Mesh(bodyGeo, wood(53, 0.62, [0.55, 0.7], { roughness: 0.26 })));
    g.add(body);
    // soundhole and rosette
    g.add(place(new Mesh(new CircleGeometry(0.043, 32), painted(0x050403, 1)), 0, 0.07, 0.0565));
    g.add(place(new Mesh(new TorusGeometry(0.05, 0.004, 8, 40), painted(0x3a2a18, 0.5)), 0, 0.07, 0.056));
    // neck, fretboard, head
    g.add(shadowy(place(box(0.055, 0.52, 0.026, wood(59, 0.55, [0.2, 1.1])), 0, 0.5, 0.03)));
    const board = shadowy(place(box(0.052, 0.5, 0.008, painted(0x1c130c, 0.42)), 0, 0.5, 0.047));
    g.add(board);
    parts.fretboard = board;
    for (let i = 1; i < 13; i++) {
      g.add(place(box(0.052, 0.0018, 0.002, alloy(0xd8d2c4, 0.22)), 0, 0.26 + i * 0.038, 0.0515));
    }
    g.add(shadowy(place(box(0.07, 0.1, 0.02, wood(61, 0.5, [0.3, 0.3])), 0, 0.79, 0.028, 0.16)));
    for (let i = 0; i < 6; i++) {
      g.add(place(new Mesh(new CylinderGeometry(0.005, 0.005, 0.024, 10), alloy(0xcfc7b6, 0.25)),
        (i < 3 ? -0.042 : 0.042), 0.755 + (i % 3) * 0.03, 0.028, 0, 0, Math.PI / 2));
    }
    // bridge and strings
    g.add(place(box(0.11, 0.022, 0.01, painted(0x241608, 0.45)), 0, -0.085, 0.058));
    const strings = [];
    for (let i = 0; i < 6; i++) {
      const st = place(new Mesh(new CylinderGeometry(0.0009, 0.0009, 0.86, 6), alloy(0xd8d2c0, 0.2)),
        -0.021 + i * 0.0084, 0.31, 0.0565);
      g.add(st);
      strings.push(st);
    }
    parts.strings = strings;
    // the capo chip: a real little machine clamped round the neck
    const chip = new Group();
    chip.add(place(slab(0.072, 0.03, 0.03, 0.006, alloy(0xbdb5a4, 0.28)), 0, 0, 0.042));
    chip.add(place(new Mesh(new TorusGeometry(0.036, 0.006, 8, 22), painted(0x1a1614, 0.5)), 0, 0, 0.036, 0, Math.PI / 2));
    const chipLed = place(new Mesh(new SphereGeometry(0.004, 10, 8), lit(0x7ee08a, 3)), 0, 0.008, 0.058);
    chip.add(chipLed);
    parts.chipLed = chipLed;
    chip.position.set(0, 0.68, 0);
    g.add(chip);
    parts.capo = chip;

    g.position.set(-0.98, 0.44, BACK + 1.28);
    g.rotation.set(0.16, 0.36, -0.1);
    scene.add(g);
    // The neck is the part of a leaning guitar that stands clear of whatever
    // is on the floor in front of it, so that is what a finger goes for.
    pickables.push({ name: 'shuffle', label: 'Guitar. Shuffle everything.', node: board, move: g,
      size: [0.2, 0.6, 0.2], look: [-0.98, 0.72, BACK + 1.28], from: [-0.72, 1.3, -0.15] });
  }

  /* ---------------------------------------------------- microphone (search) */

  {
    const g = new Group();
    g.add(shadowy(place(new Mesh(new CylinderGeometry(0.16, 0.17, 0.022, 36), painted(0x121110, 0.55)), 0, 0.011, 0)));
    g.add(shadowy(place(new Mesh(new CylinderGeometry(0.014, 0.017, 1.42, 20), alloy(0x8e887c, 0.3)), 0, 0.72, 0)));
    g.add(place(new Mesh(new CylinderGeometry(0.021, 0.021, 0.05, 20), alloy(0x6f6a60, 0.35)), 0, 1.24, 0));
    // shock mount and capsule
    const head = new Group();
    head.add(place(new Mesh(new TorusGeometry(0.058, 0.005, 8, 30), alloy(0x9a9488, 0.3)), 0, 0, 0));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      head.add(place(new Mesh(new CylinderGeometry(0.0012, 0.0012, 0.052, 6), painted(0x8a8478, 0.5)),
        Math.cos(a) * 0.04, Math.sin(a) * 0.04, -0.012, Math.PI / 2, 0, 0));
    }
    const capsule = place(new Mesh(new CapsuleGeometry(0.026, 0.075, 8, 22), painted(0x121110, 0.42)), 0, 0, 0);
    head.add(shadowy(capsule));
    head.add(place(new Mesh(new CylinderGeometry(0.027, 0.027, 0.055, 28), clothMat([3, 1])), 0, 0.03, 0));
    const micLed = place(new Mesh(new SphereGeometry(0.004, 10, 8), lit(0xc0442f, 2.6)), 0, -0.05, 0.026);
    head.add(micLed);
    parts.micLed = micLed;
    head.position.set(-0.07, 1.4, 0.05);
    head.rotation.set(0.1, -0.5, 0.14);
    g.add(head);
    parts.micHead = head;

    g.position.set(0.5, 0, 0.74);
    scene.add(g);
    pickables.push({ name: 'search', label: 'Microphone. Search your library.', node: head,
      size: [0.22, 0.28, 0.22], look: [0.46, 1.4, 0.79], from: [0.3, 1.46, 1.46] });
  }

  /* ------------------------------------------------------ headphones (liked) */

  {
    const g = new Group();
    g.add(place(new Mesh(new CylinderGeometry(0.008, 0.008, 0.05, 12), alloy(0x8a8478, 0.35)), 0, 0.15, -0.02, Math.PI / 2));
    g.add(place(new Mesh(new TorusGeometry(0.095, 0.011, 10, 40, Math.PI), painted(0x141210, 0.55)), 0, 0.06, 0));
    for (const side of [-1, 1]) {
      const cup = new Group();
      cup.add(shadowy(place(new Mesh(new CylinderGeometry(0.048, 0.052, 0.036, 30), painted(0x171513, 0.5)), 0, 0, 0, Math.PI / 2)));
      cup.add(place(new Mesh(new TorusGeometry(0.042, 0.014, 10, 26), painted(0x0e0c0b, 0.85)), 0, 0, 0.022));
      cup.position.set(side * 0.095, 0.055, 0);
      g.add(cup);
    }
    // the cable, hanging the way a cable hangs
    const curve = new CatmullRomCurve3([
      new Vector3(0.095, -0.01, 0.01), new Vector3(0.14, -0.16, 0.05),
      new Vector3(0.1, -0.34, 0.02), new Vector3(0.13, -0.5, 0.04),
    ]);
    g.add(new Mesh(new TubeGeometry(curve, 26, 0.0045, 7, false), painted(0x0d0b0a, 0.6)));
    g.position.set(0.58, 1.88, BACK + 0.07);
    scene.add(g);
    pickables.push({ name: 'liked', label: 'Headphones. Your liked songs.', node: g,
      size: [0.3, 0.34, 0.2], look: [0.58, 1.84, BACK + 0.07], from: [0.42, 1.78, -1.1] });
  }

  /* ------------------------------------------------------------- the extras */

  // A keyboard along the bridge: the studio has instruments in it, not icons.
  {
    const g = new Group();
    g.add(shadowy(place(box(1.02, 0.05, 0.24, painted(0x161412, 0.5)), 0, 0, 0)));
    for (let i = 0; i < 30; i++) {
      g.add(place(box(0.0295, 0.012, 0.15, painted(0xdcd6c8, 0.36)), -0.49 + i * 0.0335, 0.03, 0.03));
    }
    for (let i = 0; i < 30; i++) {
      if ([2, 6, 9, 13, 16, 20, 23, 27].includes(i % 30)) continue;
      if (i % 7 === 3 || i % 7 === 6) {
        g.add(place(box(0.017, 0.014, 0.095, painted(0x100e0d, 0.42)), -0.473 + i * 0.0335, 0.04, -0.005));
      }
    }
    g.position.set(-0.52, BRIDGE + 0.05, DESK_BACK + 0.24);
    g.rotation.y = 0.04;
    scene.add(g);
  }

  // A rug, because a concrete floor alone sounds and looks wrong.
  {
    const t = tex.wool();
    const m = new MeshStandardMaterial({
      map: t.map, normalMap: t.normalMap, normalScale: V2(1.6, 1.6),
      roughness: 1, metalness: 0, color: 0x4a3c30,
    });
    m.map.repeat.set(3, 3);
    m.normalMap.repeat.set(3, 3);
    scene.add(place(new Mesh(new PlaneGeometry(2.5, 2.4), m), -0.05, 0.006, -0.15, -Math.PI / 2));
  }

  // Cables, run the way cables run: sagging, not straight.
  const cable = (points, r = 0.007) => {
    const c = new CatmullRomCurve3(points.map((p) => new Vector3(...p)));
    scene.add(new Mesh(new TubeGeometry(c, 40, r, 7, false), painted(0x0c0a09, 0.65)));
  };
  cable([[0.5, 0.02, 0.74], [0.7, 0.02, 0.24], [0.66, 0.03, -0.35], [0.5, 0.12, DESK_FRONT - 0.06]]);
  cable([[-0.94, BRIDGE + 0.1, DESK_BACK + 0.05], [-0.86, 0.9, DESK_BACK - 0.02], [-0.7, 0.84, DESK_BACK + 0.06]], 0.005);
  cable([[0.58, 0.5, DESK_FRONT + 0.4], [0.7, 0.06, DESK_FRONT + 0.15], [0.62, 0.05, -0.1]], 0.006);

  // A candle on the desk, and a plant: someone works here.
  {
    const candle = place(new Mesh(new CylinderGeometry(0.036, 0.036, 0.09, 24), painted(0xe8dcc2, 0.75)), 0.94, DESK_TOP + 0.073, DESK_BACK + 0.28);
    scene.add(shadowy(candle));
    const flame = place(new Mesh(new SphereGeometry(0.012, 12, 10), lit(0xffb45a, 6)), 0.94, DESK_TOP + 0.128, DESK_BACK + 0.28);
    flame.scale.set(1, 1.7, 1);
    scene.add(flame);
    const flicker = new PointLight(0xff9d42, 2.4, 1.8, 1.8);
    flicker.position.copy(flame.position);
    scene.add(flicker);
    parts.flame = flame;
    parts.flicker = flicker;

    const pot = place(new Mesh(new CylinderGeometry(0.075, 0.058, 0.11, 24), painted(0x30291f, 0.85)), 1.2, DESK_TOP + 0.083, DESK_BACK + 0.24);
    scene.add(shadowy(pot));
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const leaf = place(new Mesh(new SphereGeometry(0.045, 10, 8), painted(0x2c4326, 0.8)),
        1.2 + Math.cos(a) * 0.07, DESK_TOP + 0.16 + (i % 4) * 0.035, DESK_BACK + 0.24 + Math.sin(a) * 0.06);
      leaf.scale.set(1.5, 0.42, 1.1);
      leaf.rotation.set(0.3, a, 0.2);
      scene.add(shadowy(leaf, true, false));
    }
  }

  // What someone left on the desk.
  {
    const mug = place(new Mesh(new CylinderGeometry(0.042, 0.036, 0.095, 26), painted(0x2a2723, 0.55)),
      -0.24, DESK_TOP + 0.075, DESK_BACK + 0.72);
    scene.add(shadowy(mug));
    scene.add(place(new Mesh(new TorusGeometry(0.028, 0.006, 8, 18), painted(0x2a2723, 0.55)),
      -0.195, DESK_TOP + 0.078, DESK_BACK + 0.72, 0, Math.PI / 2));
    scene.add(place(new Mesh(new CylinderGeometry(0.033, 0.033, 0.004, 24), painted(0x18120c, 0.25)),
      -0.24, DESK_TOP + 0.121, DESK_BACK + 0.72));

    // a pad of paper and a pencil, at the angle someone put them down
    const pad = shadowy(place(box(0.21, 0.006, 0.29, painted(0xd6cdb8, 0.82)),
      0.24, DESK_TOP + 0.031, DESK_BACK + 0.76, 0, 0.22));
    scene.add(pad);
    scene.add(shadowy(place(new Mesh(new CylinderGeometry(0.004, 0.004, 0.17, 8), painted(0xc9a13f, 0.5)),
      0.27, DESK_TOP + 0.038, DESK_BACK + 0.72, Math.PI / 2, 0, 0.5)));

    // a stomp box, still plugged in
    const pedal = shadowy(place(slab(0.12, 0.16, 0.05, 0.006, painted(0x2b4a52, 0.42)),
      -0.52, DESK_TOP + 0.053, DESK_BACK + 0.7, -Math.PI / 2, 0, 0.3));
    scene.add(pedal);
    scene.add(place(new Mesh(new CylinderGeometry(0.018, 0.018, 0.02, 20), alloy(0xcfc7b6, 0.28)),
      -0.52, DESK_TOP + 0.068, DESK_BACK + 0.74));
    const pedalLed = place(new Mesh(new SphereGeometry(0.005, 10, 8), lit(0xff5a3c, 3)),
      -0.52, DESK_TOP + 0.06, DESK_BACK + 0.64);
    scene.add(pedalLed);
    parts.pedalLed = pedalLed;
  }

  // A shelf of records, high on the wall.
  {
    const shelf = shadowy(place(box(1.0, 0.04, 0.24, wood(67, 0.85, [1.3, 0.4])), 0.6, 2.24, BACK + 0.13));
    scene.add(shelf);
    const tints = [0x2c241c, 0x54402c, 0x7a4a2c, 0x33293c, 0x5c4a2a, 0x243033, 0x6b3a24, 0x3c3128];
    for (let i = 0; i < 22; i++) {
      const s = place(box(0.012, 0.31, 0.31, painted(tints[i % tints.length], 0.8)),
        0.2 + i * 0.03, 2.42, BACK + 0.14, 0, 0, (i > 18 ? 0.16 : 0));
      scene.add(shadowy(s));
    }
  }

  /* --------------------------------------------------------------- compose */

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.5, 0.7, 0.94);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  return {
    renderer, scene, camera, composer, bloom, parts, pickables, cones, spots, strips, env, pmrem,
    aim, home,
    // scratch objects the hotspot layer projects with, kept here so the frame
    // loop never allocates
    three: { Vector3, box: new Box3(), corner: new Vector3() },
  };
}
