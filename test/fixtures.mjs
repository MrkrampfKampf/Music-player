/**
 * Test fixtures: real, playable WAV files carrying an ID3 chunk with tags and
 * cover art, written at run time so no binary assets live in the repository.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Write real, playable WAV files carrying an ID3 chunk with tags and cover
 * art. Building them here keeps binary test assets out of the repository and
 * means the test exercises the tag reader on bytes it did not itself produce
 * at parse time.
 */
export function makeFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resonate-fixtures-'));

  const albums = [
    { album: 'Daybreak', artist: 'Aurora Fields', year: '2024', genre: 'Ambient', rgb: [255, 138, 76], tracks: [
      ['First Light', 392.0, 6, '1/3'], ['Second Wind', 523.25, 7, '2/3'], ['Slow Return', 329.63, 5, '3/3'] ] },
    { album: 'Transit', artist: 'Night Bus', year: '2023', genre: 'Electronic', rgb: [86, 132, 255], tracks: [
      ['Third Rail', 440.0, 6, '1/2'], ['Last Stop', 293.66, 8, '2/2'] ] },
  ];

  const files = [];
  for (const spec of albums) {
    const art = makePng(120, spec.rgb);
    for (const [title, freq, secs, trk] of spec.tracks) {
      const name = trk.split('/')[0].padStart(2, '0') + ' ' + title + '.wav';
      const target = path.join(dir, name);
      fs.writeFileSync(target, makeWav(freq, secs, {
        TIT2: title, TPE1: spec.artist, TALB: spec.album, TPE2: spec.artist,
        TRCK: trk, TYER: spec.year, TCON: spec.genre,
      }, art));
      files.push(target);
    }
  }

  files.sort();
  return { files, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A single extra track, distinct from the album fixtures. */
export function makeOneOff() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resonate-oneoff-'));
  const target = path.join(dir, '01 One Off.wav');
  fs.writeFileSync(target, makeWav(261.63, 4, {
    TIT2: 'One Off', TPE1: 'Nobody', TALB: 'Loose Ends', TRCK: '1/1',
  }, makePng(60, [120, 220, 140])));
  return { path: target, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function makePng(size, [r, g, b]) {
  const chunk = (tag, data) => {
    const body = Buffer.concat([Buffer.from(tag), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const t = 0.55 + 0.45 * ((x + y) / (2 * size));
      row[1 + x * 3] = Math.round(r * t);
      row[2 + x * 3] = Math.round(g * t);
      row[3 + x * 3] = Math.round(b * t);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  // Cached on the function itself: fixtures are built before the module's
  // top-level statements run, so a module-scoped `let` would still be in its
  // temporal dead zone here.
  let table = crc32.table;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    crc32.table = table;
  }
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeWav(freq, secs, tags, art, sampleRate = 44100) {
  const NUL = Buffer.from([0]);
  const frames = Math.round(sampleRate * secs);
  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const env = Math.min(1, i / (sampleRate * 0.04), (frames - i) / (sampleRate * 0.04));
    const s = (Math.sin(2 * Math.PI * freq * i / sampleRate)
      + 0.3 * Math.sin(4 * Math.PI * freq * i / sampleRate)) / 1.3;
    const v = Math.max(-32768, Math.min(32767, Math.round(17000 * env * s)));
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }

  const frame = (id, value) => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8'), NUL]);
    const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
    return Buffer.concat([Buffer.from(id), size, Buffer.alloc(2), body]);
  };
  const apic = () => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from('image/png'), NUL,
      Buffer.from([3]), Buffer.from('cover'), NUL, art]);
    const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
    return Buffer.concat([Buffer.from('APIC'), size, Buffer.alloc(2), body]);
  };

  const frameData = Buffer.concat([
    ...Object.entries(tags).map(([id, value]) => frame(id, value)),
    apic(),
    Buffer.alloc(64),
  ]);
  const synch = Buffer.from([
    (frameData.length >> 21) & 127, (frameData.length >> 14) & 127,
    (frameData.length >> 7) & 127, frameData.length & 127,
  ]);
  let id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), synch, frameData]);
  if (id3.length % 2) id3 = Buffer.concat([id3, NUL]);

  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(2, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 4, 16);
  fmt.writeUInt16LE(4, 20);
  fmt.writeUInt16LE(16, 22);

  const id3Header = Buffer.alloc(8);
  id3Header.write('id3 ', 0);
  id3Header.writeUInt32LE(id3.length, 4);

  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0);
  dataHeader.writeUInt32LE(pcm.length, 4);

  const body = Buffer.concat([Buffer.from('WAVE'), fmt, id3Header, id3, dataHeader, pcm]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0);
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
