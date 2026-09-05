/**
 * Builds synthetic audio files byte by byte and checks the parser reads them
 * back. Run with: node test/tags.test.mjs
 */
import { readTags } from '../js/tags.js';

const Z = String.fromCharCode(0); // NUL terminator used throughout tag formats

let pass = 0, fail = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else { fail++; console.log('  FAIL ' + name + ': got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected)); }
}
function near(name, actual, expected, tol) {
  if (Math.abs(actual - expected) <= tol) pass++;
  else { fail++; console.log('  FAIL ' + name + ': got ' + actual + ' want ~' + expected); }
}

const enc = new TextEncoder();
function bytes(...parts) {
  const chunks = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p)));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
const u32be = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u32le = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const u16le = (n) => new Uint8Array([n & 255, (n >>> 8) & 255]);
const u16be = (n) => new Uint8Array([(n >>> 8) & 255, n & 255]);
const synchsafe = (n) => new Uint8Array([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);

/* ------------------------------------------------------------------ ID3v2.3 */

function textFrame(id, value) {
  const body = bytes([0x00], value + Z);
  return bytes(id, u32be(body.length), [0, 0], body);
}
function apicFrame(mime, imageBytes) {
  const body = bytes([0x00], mime + Z, [0x03], 'cover' + Z, imageBytes);
  return bytes('APIC', u32be(body.length), [0, 0], body);
}

const jpegBytes = bytes([0xff, 0xd8, 0xff, 0xe0], new Uint8Array(64).fill(0x41));

const frames = bytes(
  textFrame('TIT2', 'Midnight Drive'),
  textFrame('TPE1', 'The Neon Hours'),
  textFrame('TALB', 'After Dark'),
  textFrame('TPE2', 'The Neon Hours'),
  textFrame('TRCK', '3/12'),
  textFrame('TPOS', '1/2'),
  textFrame('TYER', '2019'),
  textFrame('TCON', '(13)'),
  apicFrame('image/jpeg', jpegBytes),
);
const id3Body = bytes(frames, new Uint8Array(100));
const id3 = bytes('ID3', [3, 0, 0], synchsafe(id3Body.length), id3Body);

// A 128 kbps 44.1 kHz joint-stereo MPEG-1 Layer III frame header.
const mp3Frame = new Uint8Array([0xff, 0xfb, 0x92, 0x00]);
const mp3Audio = bytes(mp3Frame, new Uint8Array(128 * 1024));
const mp3File = new File([bytes(id3, mp3Audio)], 'track.mp3', { type: 'audio/mpeg' });

console.log('MP3 with ID3v2.3');
{
  const m = await readTags(mp3File);
  check('title', m.title, 'Midnight Drive');
  check('artist', m.artist, 'The Neon Hours');
  check('album', m.album, 'After Dark');
  check('albumArtist', m.albumArtist, 'The Neon Hours');
  check('trackNo', m.trackNo, 3);
  check('trackOf', m.trackOf, 12);
  check('discNo', m.discNo, 1);
  check('discOf', m.discOf, 2);
  check('year', m.year, 2019);
  check('genre', m.genre, 'Pop');
  check('codec', m.codec, 'MP3');
  check('sampleRate', m.sampleRate, 44100);
  check('channels', m.channels, 2);
  check('bitrate', m.bitrate, 128000);
  check('artwork type', m.artwork && m.artwork.type, 'image/jpeg');
  check('artwork size', m.artwork && m.artwork.size, jpegBytes.length);
  near('duration', m.duration, (mp3Audio.length * 8) / 128000, 0.1);
}

/* -------------------------------------------------------------------- ID3v1 */

console.log('MP3 with only ID3v1');
{
  const pad = (s, n) => { const b = new Uint8Array(n); b.set(enc.encode(s).slice(0, n)); return b; };
  const v1 = bytes('TAG', pad('Old Tape', 30), pad('Cassette Kid', 30), pad('Basement', 30), '1994', new Uint8Array(28), [0, 7], [17]);
  const f = new File([bytes(mp3Frame, new Uint8Array(8192), v1)], 'x.mp3', { type: 'audio/mpeg' });
  const m = await readTags(f);
  check('title', m.title, 'Old Tape');
  check('artist', m.artist, 'Cassette Kid');
  check('album', m.album, 'Basement');
  check('year', m.year, 1994);
  check('trackNo', m.trackNo, 7);
  check('genre', m.genre, 'Rock');
}

/* ---------------------------------------------------------------------- WAV */

console.log('WAV 24-bit with LIST/INFO');
{
  const fmt = bytes('fmt ', u32le(16), u16le(1), u16le(2), u32le(48000), u32le(48000 * 2 * 3), u16le(6), u16le(24));
  const infoEntry = (id, text) => {
    const b = enc.encode(text + Z);
    const padded = b.length % 2 ? bytes(b, [0]) : b;
    return bytes(id, u32le(b.length), padded);
  };
  const infoBody = bytes('INFO', infoEntry('INAM', 'Rain On Glass'), infoEntry('IART', 'Field Notes'), infoEntry('IPRD', 'Ambient Vol 1'), infoEntry('ICRD', '2021'));
  const list = bytes('LIST', u32le(infoBody.length), infoBody);
  const audioBytes = 48000 * 2 * 3 * 2; // two seconds
  const body = bytes('WAVE', fmt, list, 'data', u32le(audioBytes));
  const f = new File([bytes('RIFF', u32le(body.length), body), new Uint8Array(1024)], 'rain.wav', { type: 'audio/wav' });
  const m = await readTags(f);
  check('title', m.title, 'Rain On Glass');
  check('artist', m.artist, 'Field Notes');
  check('album', m.album, 'Ambient Vol 1');
  check('year', m.year, 2021);
  check('sampleRate', m.sampleRate, 48000);
  check('channels', m.channels, 2);
  check('bitDepth', m.bitDepth, 24);
  check('lossless', m.lossless, true);
  check('codec', m.codec, 'PCM 24-bit');
  near('duration', m.duration, 2, 0.001);
  check('bitrate', m.bitrate, 48000 * 2 * 3 * 8);
}

/* --------------------------------------------------------------------- FLAC */

console.log('FLAC with Vorbis comments and a picture');
{
  const sr = 96000, ch = 2, depth = 24, samples = 96000 * 5;
  const si = new Uint8Array(34);
  si[10] = (sr >> 12) & 0xff;
  si[11] = (sr >> 4) & 0xff;
  si[12] = ((sr & 0x0f) << 4) | (((ch - 1) & 0x07) << 1) | (((depth - 1) >> 4) & 0x01);
  si[13] = (((depth - 1) & 0x0f) << 4) | (Math.floor(samples / 4294967296) & 0x0f);
  si.set(u32be(samples >>> 0), 14);
  const streaminfo = bytes([0x00], [0, 0, 34], si);

  const comment = (s) => { const b = enc.encode(s); return bytes(u32le(b.length), b); };
  const vc = bytes(comment('ref libFLAC'), u32le(5),
    comment('TITLE=Glacier'), comment('ARTIST=Ice Field'), comment('ALBUM=Northbound'),
    comment('DATE=2023'), comment('TRACKNUMBER=4/9'));
  const vcBlock = bytes([0x04], [(vc.length >> 16) & 255, (vc.length >> 8) & 255, vc.length & 255], vc);

  const png = bytes([0x89, 0x50, 0x4e, 0x47], new Uint8Array(32).fill(9));
  const mime = 'image/png';
  const picBody = bytes(u32be(3), u32be(mime.length), mime, u32be(0), u32be(500), u32be(500), u32be(24), u32be(0), u32be(png.length), png);
  const picBlock = bytes([0x80 | 0x06], [(picBody.length >> 16) & 255, (picBody.length >> 8) & 255, picBody.length & 255], picBody);

  const f = new File([bytes('fLaC', streaminfo, vcBlock, picBlock, new Uint8Array(4096))], 'g.flac', { type: 'audio/flac' });
  const m = await readTags(f);
  check('title', m.title, 'Glacier');
  check('artist', m.artist, 'Ice Field');
  check('album', m.album, 'Northbound');
  check('year', m.year, 2023);
  check('trackNo', m.trackNo, 4);
  check('trackOf', m.trackOf, 9);
  check('sampleRate', m.sampleRate, 96000);
  check('bitDepth', m.bitDepth, 24);
  check('channels', m.channels, 2);
  check('lossless', m.lossless, true);
  near('duration', m.duration, 5, 0.001);
  check('artwork type', m.artwork && m.artwork.type, 'image/png');
  check('artwork size', m.artwork && m.artwork.size, png.length);
}

/* ---------------------------------------------------------------------- MP4 */

console.log('M4A with iTunes atoms');
{
  // Atom names are latin1: the iTunes copyright-sign atoms are the single
  // byte 0xA9, not its two byte UTF-8 encoding.
  const latin1 = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));
  const atom = (name, ...body) => { const b = bytes(...body); return bytes(u32be(b.length + 8), latin1(name), b); };
  const dataAtom = (flag, ...body) => atom('data', u32be(flag), u32be(0), bytes(...body));
  const textItem = (name, value) => atom(name, dataAtom(1, value));

  const jpg = bytes([0xff, 0xd8, 0xff], new Uint8Array(48).fill(7));
  const ilst = atom('ilst',
    textItem('©nam', 'Sunset Bloom'),
    textItem('©ART', 'Coral Sky'),
    textItem('©alb', 'Tidal'),
    textItem('aART', 'Coral Sky'),
    textItem('©day', '2024'),
    textItem('©gen', 'Electronic'),
    atom('trkn', dataAtom(0, u16be(0), u16be(2), u16be(10), u16be(0))),
    atom('covr', dataAtom(13, jpg)),
  );
  const udta = atom('udta', atom('meta', u32be(0), ilst));
  const mvhd = atom('mvhd', [0], [0, 0, 0], u32be(0), u32be(0), u32be(1000), u32be(215500), new Uint8Array(80));
  const stsdBody = bytes(u32be(0), u32be(1), atom('mp4a', new Uint8Array(16), u16be(2), u16be(16), u32be(0), u16be(44100), u16be(0)));
  const trak = atom('trak', atom('mdia', atom('minf', atom('stbl', atom('stsd', stsdBody)))));
  const moov = atom('moov', mvhd, trak, udta);
  const ftyp = atom('ftyp', 'M4A ', u32be(0), 'M4A mp42isom');

  const f = new File([bytes(ftyp, moov, 'mdat', new Uint8Array(2048))], 's.m4a', { type: 'audio/mp4' });
  const m = await readTags(f);
  check('title', m.title, 'Sunset Bloom');
  check('artist', m.artist, 'Coral Sky');
  check('album', m.album, 'Tidal');
  check('albumArtist', m.albumArtist, 'Coral Sky');
  check('genre', m.genre, 'Electronic');
  check('year', m.year, 2024);
  check('trackNo', m.trackNo, 2);
  check('trackOf', m.trackOf, 10);
  check('codec', m.codec, 'AAC');
  check('channels', m.channels, 2);
  check('sampleRate', m.sampleRate, 44100);
  near('duration', m.duration, 215.5, 0.01);
  check('artwork type', m.artwork && m.artwork.type, 'image/jpeg');
  check('artwork size', m.artwork && m.artwork.size, jpg.length);
}

/* --------------------------------------------------------------------- Opus */

console.log('Ogg Opus');
{
  const page = (payload) => {
    const segs = [];
    let left = payload.length;
    while (left >= 255) { segs.push(255); left -= 255; }
    segs.push(left);
    return bytes('OggS', [0], [0x02], new Uint8Array(8), u32le(1), u32le(0), u32le(0), [segs.length], new Uint8Array(segs), payload);
  };
  const head = bytes('OpusHead', [1], [2], u16le(312), u32le(48000), u16le(0), [0]);
  const comment = (s) => { const b = enc.encode(s); return bytes(u32le(b.length), b); };
  const tags = bytes('OpusTags', comment('libopus'), u32le(2), comment('TITLE=Low Tide'), comment('ARTIST=Harbour'));
  const f = new File([bytes(page(head), page(tags))], 'lt.opus', { type: 'audio/ogg' });
  const m = await readTags(f);
  check('codec', m.codec, 'Opus');
  check('title', m.title, 'Low Tide');
  check('artist', m.artist, 'Harbour');
  check('sampleRate', m.sampleRate, 48000);
  check('channels', m.channels, 2);
}

/* --------------------------------------------------------- filename fallback */

console.log('Untagged file falls back to the filename');
{
  const f = new File([bytes(mp3Frame, new Uint8Array(4096))], '05 - Deep Cuts - Blue Room.mp3', { type: 'audio/mpeg' });
  const m = await readTags(f);
  check('artist', m.artist, 'Deep Cuts');
  check('title', m.title, 'Blue Room');
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
