/**
 * Materials, made rather than downloaded.
 *
 * Every surface in the room needs colour, roughness and a normal map, and the
 * app has to work offline from a 2 MB budget, so the maps are drawn into
 * canvases at load time instead of shipped as images. They are built from
 * value noise, which is enough for the things this room is made of: sawn oak,
 * open-cell foam, woven grille cloth, brushed alloy, plaster and wool.
 *
 * Nothing here is perfectly regular. Grain wanders, the weave drifts, the
 * plaster is blotchy, because the difference between a material and a texture
 * is the irregularity.
 */

import { CanvasTexture, RepeatWrapping, SRGBColorSpace, Vector2 } from '../../vendor/three/three.module.js';

/* ------------------------------------------------------------------- noise */

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise: a lattice of random values, smoothly interpolated. */
function lattice(size, seed) {
  const rand = mulberry(seed);
  const grid = new Float32Array(size * size);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const at = (ax, ay) => grid[(((ay % size) + size) % size) * size + (((ax % size) + size) % size)];
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

/** Several octaves of it, which is what makes noise look like a material. */
function fbm(seed, octaves = 4, freq = 4) {
  const layers = [];
  for (let i = 0; i < octaves; i++) layers.push(lattice(16, seed + i * 977));
  return (x, y) => {
    let sum = 0;
    let amp = 1;
    let total = 0;
    let f = freq;
    for (const layer of layers) {
      sum += layer(x * f, y * f) * amp;
      total += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / total;
  };
}

/* --------------------------------------------------------------- machinery */

function surface(size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
}

function finish(canvas, repeat, srgb) {
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(repeat[0], repeat[1]);
  texture.anisotropy = 8;
  if (srgb) texture.colorSpace = SRGBColorSpace;
  return texture;
}

/**
 * A normal map from a height field.
 *
 * Central differences on the heights give the slope at each texel; the slope
 * is the normal. This is why a foam wedge catches the lamp along one edge and
 * goes dark along the other without any of it being painted in.
 */
function normalFrom(height, size, strength) {
  const { canvas, ctx } = surface(size);
  const image = ctx.createImageData(size, size);
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      image.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      image.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      image.data[i + 2] = (1 / len) * 0.5 * 255 + 127;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function grayCanvas(values, size) {
  const { canvas, ctx } = surface(size);
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < values.length; i++) {
    const v = Math.max(0, Math.min(255, values[i] * 255)) | 0;
    image.data[i * 4] = v;
    image.data[i * 4 + 1] = v;
    image.data[i * 4 + 2] = v;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/* --------------------------------------------------------------- materials */

const cache = new Map();
const once = (key, build) => {
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key);
};

/**
 * Sawn oak. The grain is noise stretched hard along one axis and then folded,
 * which is what growth rings look like on a flat-sawn board; knots are a few
 * tight whorls. Colour, roughness and normal all come off the same field, so
 * a dark line is also a slightly rougher, slightly lower one.
 */
export function oak(seed = 3, tone = 1) {
  return once('oak', () => {
    const size = 384;
    const streak = fbm(3, 4, 3);       // the long lines, stretched along U
    const figure = fbm(34, 3, 2);      // the occasional cathedral
    const pores = fbm(80, 3, 24);      // open pores, which oak has a lot of
    const { canvas, ctx } = surface(size);
    const image = ctx.createImageData(size, size);
    const height = new Float32Array(size * size);
    const rough = new Float32Array(size * size);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;

        // Grain runs the length of a board, so the noise is stretched hard
        // along U and left fine across V.
        const lines = streak(u * 0.5, v * 26);
        // A cathedral every so often, where the saw crossed a growth ring.
        const arch = Math.pow(Math.abs(Math.sin((v * 2.2 + figure(u * 0.7, v * 0.5) * 1.6) * Math.PI)), 7);
        const pore = pores(u * 2, v * 8);

        const g = lines * 0.62 + arch * 0.3 + pore * 0.08;
        const i = (y * size + x) * 4;
        // Oak is a narrow band of browns; the contrast between early and late
        // wood is much smaller than it looks in a photograph.
        const light = 0.72 + (1 - g) * 0.4;
        image.data[i] = Math.min(255, 132 * light);
        image.data[i + 1] = Math.min(255, 96 * light);
        image.data[i + 2] = Math.min(255, 61 * light);
        image.data[i + 3] = 255;

        // Pores are the only real relief; the grain itself is nearly flat.
        height[y * size + x] = 1 - (pore * 0.75 + lines * 0.25);
        rough[y * size + x] = 0.52 + pore * 0.3 + lines * 0.1;
      }
    }
    ctx.putImageData(image, 0, 0);
    return {
      map: finish(canvas, [1, 1], true),
      normalMap: finish(normalFrom(height, size, 0.55), [1, 1], false),
      roughnessMap: finish(grayCanvas(rough, size), [1, 1], false),
    };
  });
}

/** Open-cell acoustic foam: a wedge field with a bubbled surface on top. */
export function foam() {
  return once('foam', () => {
    const size = 512;
    const cells = fbm(701, 4, 22);
    const height = new Float32Array(size * size);
    const { canvas, ctx } = surface(size);
    const image = ctx.createImageData(size, size);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        // pyramid wedges, eight across
        const wedge = Math.min(
          1 - Math.abs(((u * 8) % 1) * 2 - 1),
          1 - Math.abs(((v * 8) % 1) * 2 - 1),
        );
        const grain = cells(u, v);
        const h = wedge * 0.82 + grain * 0.18;
        height[y * size + x] = h;
        const i = (y * size + x) * 4;
        const shade = 26 + h * 26 + grain * 12;
        image.data[i] = shade * 1.02;
        image.data[i + 1] = shade * 0.95;
        image.data[i + 2] = shade * 0.86;
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return {
      map: finish(canvas, [1, 1], true),
      normalMap: finish(normalFrom(height, size, 6), [1, 1], false),
      roughness: 0.98,
    };
  });
}

/** Grille cloth: a real over-under weave, so it catches light in two axes. */
export function grille() {
  return once('grille', () => {
    const size = 256;
    const height = new Float32Array(size * size);
    const { canvas, ctx } = surface(size);
    const image = ctx.createImageData(size, size);
    const fuzz = fbm(211, 3, 40);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const warp = Math.sin((x / size) * Math.PI * 64);
        const weft = Math.sin((y / size) * Math.PI * 64);
        const over = ((x >> 2) + (y >> 2)) % 2 === 0;
        const h = (over ? warp : weft) * 0.5 + 0.5;
        const n = fuzz(x / size, y / size);
        height[y * size + x] = h * 0.8 + n * 0.2;
        const i = (y * size + x) * 4;
        const shade = 13 + h * 12 + n * 7;
        image.data[i] = shade;
        image.data[i + 1] = shade * 0.97;
        image.data[i + 2] = shade * 0.92;
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return {
      map: finish(canvas, [1, 1], true),
      normalMap: finish(normalFrom(height, size, 2.6), [1, 1], false),
      roughness: 0.93,
    };
  });
}

/** Brushed alloy: roughness streaked along one axis, colour almost flat. */
export function brushed() {
  return once('brushed', () => {
    const size = 512;
    const streak = fbm(97, 4, 3);
    const rough = new Float32Array(size * size);
    const height = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = streak(x / size * 0.4, y / size * 40);
        rough[y * size + x] = 0.18 + s * 0.26;
        height[y * size + x] = s;
      }
    }
    return {
      roughnessMap: finish(grayCanvas(rough, size), [1, 1], false),
      normalMap: finish(normalFrom(height, size, 0.45), [1, 1], false),
    };
  });
}

/** Painted plaster: blotchy, with the faint orange-peel of a roller. */
export function plaster() {
  return once('plaster', () => {
    const size = 256;
    const blotch = fbm(451, 5, 2);
    const peel = fbm(452, 3, 30);
    const height = new Float32Array(size * size);
    const rough = new Float32Array(size * size);
    const { canvas, ctx } = surface(size);
    const image = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const b = blotch(x / size, y / size);
        const p = peel(x / size, y / size);
        height[y * size + x] = p * 0.7 + b * 0.3;
        rough[y * size + x] = 0.82 + b * 0.14;
        const i = (y * size + x) * 4;
        const shade = 30 + b * 12 + p * 5;
        image.data[i] = shade * 1.06;
        image.data[i + 1] = shade;
        image.data[i + 2] = shade * 0.92;
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return {
      map: finish(canvas, [1, 1], true),
      normalMap: finish(normalFrom(height, size, 0.7), [1, 1], false),
      roughnessMap: finish(grayCanvas(rough, size), [1, 1], false),
    };
  });
}

/** Wool rug: deep pile, so a strong normal and no shine at all. */
export function wool() {
  return once('wool', () => {
    const size = 256;
    const pile = fbm(881, 5, 26);
    const drift = fbm(882, 3, 3);
    const height = new Float32Array(size * size);
    const { canvas, ctx } = surface(size);
    const image = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const p = pile(x / size, y / size);
        const d = drift(x / size, y / size);
        height[y * size + x] = p;
        const i = (y * size + x) * 4;
        const shade = 20 + p * 22 + d * 10;
        image.data[i] = shade * 1.05;
        image.data[i + 1] = shade * 0.98;
        image.data[i + 2] = shade * 0.9;
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return {
      map: finish(canvas, [1, 1], true),
      normalMap: finish(normalFrom(height, size, 3.4), [1, 1], false),
      roughness: 1,
    };
  });
}

/** Sealed concrete floor, poured and polished unevenly. */
export function concrete() {
  return once('concrete', () => {
    const size = 256;
    const mottle = fbm(619, 5, 2.2);
    const grit = fbm(620, 3, 34);
    const height = new Float32Array(size * size);
    const rough = new Float32Array(size * size);
    const { canvas, ctx } = surface(size);
    const image = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const m = mottle(x / size, y / size);
        const g = grit(x / size, y / size);
        height[y * size + x] = g * 0.6 + m * 0.4;
        rough[y * size + x] = 0.42 + m * 0.3;
        const i = (y * size + x) * 4;
        const shade = 24 + m * 16 + g * 6;
        image.data[i] = shade * 1.04;
        image.data[i + 1] = shade * 0.99;
        image.data[i + 2] = shade * 0.93;
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return {
      map: finish(canvas, [1, 1], true),
      normalMap: finish(normalFrom(height, size, 0.9), [1, 1], false),
      roughnessMap: finish(grayCanvas(rough, size), [1, 1], false),
    };
  });
}

/**
 * The fine detail every made object has and no flat colour does: the texture
 * of the paint, the swirl left by a polishing wheel, the dust that has settled
 * since. It is nearly invisible on its own and it is the whole difference
 * between a surface and a fill, because it breaks up the specular highlight —
 * a perfectly smooth panel reflects a lamp as a hard disc, and nothing real
 * does that.
 */
export function micro() {
  return once('micro', () => {
    const size = 256;
    const paint = fbm(1301, 4, 30);   // the tooth of the finish
    const swirl = fbm(1302, 3, 6);    // wider unevenness, from wear
    const height = new Float32Array(size * size);
    const rough = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const a = paint(x / size, y / size);
        const b = swirl(x / size, y / size);
        height[y * size + x] = a * 0.8 + b * 0.2;
        rough[y * size + x] = 0.5 + (a - 0.5) * 0.34 + (b - 0.5) * 0.5;
      }
    }
    // Four tiles across whatever it is put on: on a knob that is the tooth of
    // the paint, on a panel it is the unevenness of the finish. It is the same
    // texture either way, which is why every made thing in the room agrees.
    return {
      normalMap: finish(normalFrom(height, size, 0.34), [4, 4], false),
      roughnessMap: finish(grayCanvas(rough, size), [4, 4], false),
    };
  });
}

/**
 * Dust, for the surfaces that face the ceiling. It sits in patches, it is
 * lighter than what it settles on, and it kills the shine.
 */
export function dust() {
  return once('dust', () => {
    const size = 256;
    const patch = fbm(1401, 4, 5);
    const speck = fbm(1402, 3, 40);
    const rough = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.max(0, patch(x / size, y / size) - 0.42) * 1.7 + speck(x / size, y / size) * 0.2;
        rough[y * size + x] = 0.55 + Math.min(0.45, d);
      }
    }
    return { roughnessMap: finish(grayCanvas(rough, size), [1, 1], false) };
  });
}

/**
 * Print.
 *
 * Real equipment is covered in writing: a maker's plate, a channel number, a
 * frequency scale, the label in the middle of a record. Blank panels are one
 * of the loudest signals that a thing was modelled rather than made, and text
 * is nearly free to draw, so the room gets its lettering.
 *
 * `draw` receives a 2D context and the canvas size and may do anything.
 */
export function printed(key, w, h, draw) {
  return once('print-' + key, () => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    draw(ctx, w, h);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
  });
}

/** The mono face the equipment in this room is silkscreened in. */
export const SILK = '600 __PXpx ui-monospace, "SF Mono", Menlo, Consolas, monospace';
export const silk = (px) => SILK.replace('__PX', String(px));

/** The scale a normal map should be read at, per material. */
export const NORMAL_SCALE = new Vector2(1, 1);
