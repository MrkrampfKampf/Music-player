/**
 * Audio metadata reader.
 *
 * Parses tags and stream properties straight out of the file so the library
 * shows real titles, artists, album art and bit depth instead of filenames.
 *
 * Supported containers:
 *   MP3   - ID3v2.2/2.3/2.4, ID3v1 fallback, Xing/Info and CBR duration
 *   MP4   - M4A/M4B/MP4 iTunes atoms (also covers ALAC and AAC)
 *   FLAC  - STREAMINFO, VORBIS_COMMENT, PICTURE
 *   Ogg   - Vorbis and Opus comment headers
 *   WAV   - fmt chunk, LIST/INFO tags, plus an embedded ID3 chunk if present
 *   AIFF  - COMM, NAME/AUTH, embedded ID3
 *
 * Only the head and tail of a file are read, so tagging a 400 MB lossless
 * album costs a couple of hundred kilobytes rather than the whole file.
 */

const HEAD_BYTES = 512 * 1024;   // enough for oversized embedded artwork
const TAIL_BYTES = 1024 * 1024;

const NUL = String.fromCharCode(0);
const TRAILING_NUL = new RegExp(NUL + '+$');
const TRAILING_NUL_BOM = new RegExp('[' + NUL + '\\uFEFF]+$');

const td = {
  utf8: new TextDecoder('utf-8'),
  latin1: new TextDecoder('iso-8859-1'),
  utf16: new TextDecoder('utf-16'),
  utf16be: new TextDecoder('utf-16be'),
};

export async function readTags(file) {
  const meta = {
    title: '', artist: '', album: '', albumArtist: '', genre: '',
    year: null, trackNo: null, trackOf: null, discNo: null, discOf: null,
    duration: 0, bitrate: 0, sampleRate: 0, channels: 0, bitDepth: 0,
    codec: '', lossless: false, artwork: null, lyrics: '', comment: '',
  };

  try {
    const head = new Uint8Array(await slice(file, 0, Math.min(HEAD_BYTES, file.size)));
    const kind = sniff(head, file);

    if (kind === 'mp3') await parseMp3(file, head, meta);
    else if (kind === 'mp4') await parseMp4(file, meta);
    else if (kind === 'flac') parseFlac(head, meta);
    else if (kind === 'ogg') parseOgg(head, meta);
    else if (kind === 'wav') parseWav(head, meta);
    else if (kind === 'aiff') parseAiff(head, meta);

    // Lossless containers report no bitrate of their own; derive it.
    if (!meta.bitrate && meta.duration > 0) {
      meta.bitrate = Math.round((file.size * 8) / meta.duration);
    }
  } catch (err) {
    console.warn('Tag read failed, falling back to filename', err);
  }

  applyFilenameFallback(file, meta);
  return meta;
}

/** Duration is the one field worth decoding for when the tags omit it. */
export function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeAttribute('src');
      try { el.load(); } catch { /* teardown only */ }
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(value) && value > 0 ? value : 0);
    };
    const timer = setTimeout(() => finish(0), 15000);
    el.preload = 'metadata';
    el.addEventListener('loadedmetadata', () => finish(el.duration), { once: true });
    el.addEventListener('error', () => finish(0), { once: true });
    el.src = url;
  });
}

/* ------------------------------------------------------------------ common */

function slice(file, start, end) {
  return file.slice(start, Math.min(end, file.size)).arrayBuffer();
}

function sniff(head, file) {
  const s = (i, str) => str.split('').every((c, k) => head[i + k] === c.charCodeAt(0));
  if (s(0, 'fLaC')) return 'flac';
  if (s(0, 'OggS')) return 'ogg';
  if (s(0, 'RIFF') && s(8, 'WAVE')) return 'wav';
  if (s(0, 'FORM') && (s(8, 'AIFF') || s(8, 'AIFC'))) return 'aiff';
  if (s(4, 'ftyp')) return 'mp4';
  if (s(0, 'ID3')) return 'mp3';
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3';

  const name = (file.name || '').toLowerCase();
  if (/\.(m4a|m4b|m4p|mp4|m4v|mov|aac)$/.test(name)) return 'mp4';
  if (/\.mp3$/.test(name)) return 'mp3';
  if (/\.flac$/.test(name)) return 'flac';
  if (/\.(ogg|oga|opus)$/.test(name)) return 'ogg';
  if (/\.wave?$/.test(name)) return 'wav';
  if (/\.(aif|aiff|aifc)$/.test(name)) return 'aiff';
  return 'unknown';
}

function toInt(value) {
  if (value == null) return null;
  const m = String(value).match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function splitPair(value, meta, numKey, ofKey) {
  if (value == null) return;
  const parts = String(value).split('/');
  const n = toInt(parts[0]);
  const of = parts.length > 1 ? toInt(parts[1]) : null;
  if (n != null && !meta[numKey]) meta[numKey] = n;
  if (of != null && !meta[ofKey]) meta[ofKey] = of;
}

/** Take the first value of a NUL separated multi-value ID3 text frame. */
function firstValue(text) {
  const parts = String(text).split(NUL).filter((x) => x.trim().length);
  return (parts[0] || '').trim();
}

function applyFilenameFallback(file, meta) {
  if (meta.title && meta.artist) return;
  const base = (file.name || 'Unknown').replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  // "01 - Artist - Title" / "Artist - Title" / "01. Title"
  const stripped = base.replace(/^\s*\d{1,3}\s*[-.\s]\s*/, '');
  const parts = stripped.split(/\s+-\s+/);
  if (!meta.title) meta.title = (parts.length > 1 ? parts.slice(1).join(' - ') : stripped) || base;
  if (!meta.artist && parts.length > 1) meta.artist = parts[0];
}

/* --------------------------------------------------------------------- MP3 */

async function parseMp3(file, head, meta) {
  meta.codec = 'MP3';
  let audioStart = 0;

  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    const size = synchsafe(head, 6);
    audioStart = 10 + size;
    let buf = head;
    if (audioStart > head.length) {
      buf = new Uint8Array(await slice(file, 0, Math.min(audioStart + 8192, file.size)));
    }
    try { parseId3v2(buf, meta); } catch (err) { console.warn('ID3v2 parse failed', err); }
  }

  let frameBuf = head;
  if (audioStart > head.length - 4096) {
    frameBuf = new Uint8Array(await slice(file, 0, Math.min(audioStart + 65536, file.size)));
  }
  parseMpegFrame(file, frameBuf, meta, audioStart);

  if (!meta.title || !meta.artist) {
    try {
      const tail = new Uint8Array(await slice(file, Math.max(0, file.size - 128), file.size));
      parseId3v1(tail, meta);
    } catch { /* ID3v1 is optional */ }
  }
}

function synchsafe(b, at) {
  return ((b[at] & 0x7f) << 21) | ((b[at + 1] & 0x7f) << 14) | ((b[at + 2] & 0x7f) << 7) | (b[at + 3] & 0x7f);
}

function parseId3v2(b, meta) {
  const version = b[3];
  const flags = b[5];
  const size = synchsafe(b, 6);
  let pos = 10;
  const end = Math.min(10 + size, b.length);

  if (flags & 0x40) { // extended header
    pos += version === 4 ? synchsafe(b, pos) : (readU32(b, pos) + 4);
  }

  const idLen = version === 2 ? 3 : 4;
  const headerLen = version === 2 ? 6 : 10;

  while (pos + headerLen <= end) {
    const id = td.latin1.decode(b.subarray(pos, pos + idLen));
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;

    let frameSize;
    if (version === 2) frameSize = (b[pos + 3] << 16) | (b[pos + 4] << 8) | b[pos + 5];
    else if (version === 4) frameSize = synchsafe(b, pos + 4);
    else frameSize = readU32(b, pos + 4);

    let frameFlags = 0;
    if (version > 2) frameFlags = (b[pos + 8] << 8) | b[pos + 9];

    const dataStart = pos + headerLen;
    if (frameSize <= 0 || dataStart + frameSize > end) break;
    let data = b.subarray(dataStart, dataStart + frameSize);

    // Strip the data-length indicator that accompanies v2.4 unsync/compression.
    if (version === 4 && (frameFlags & 0x0001)) data = data.subarray(4);
    if (version === 4 && (frameFlags & 0x0002)) data = deunsync(data);

    assignId3Frame(id, data, meta);
    pos = dataStart + frameSize;
  }
}

function deunsync(data) {
  const out = new Uint8Array(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    out[n++] = data[i];
    if (data[i] === 0xff && data[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

const ID3V22 = {
  TT2: 'TIT2', TP1: 'TPE1', TP2: 'TPE2', TAL: 'TALB', TCO: 'TCON',
  TRK: 'TRCK', TPA: 'TPOS', TYE: 'TYER', TLE: 'TLEN', PIC: 'APIC',
  ULT: 'USLT', COM: 'COMM',
};

function assignId3Frame(id, data, meta) {
  const key = id.length === 3 ? ID3V22[id] : id;
  if (!key || !data.length) return;

  if (key === 'APIC') { readApic(data, meta); return; }
  if (key === 'USLT') { readUslt(data, meta); return; }
  if (key === 'COMM') {
    if (!meta.comment) {
      const parts = readTextFrame(data.subarray(4), data[0]).split(NUL);
      meta.comment = (parts[parts.length - 1] || '').trim();
    }
    return;
  }
  if (key[0] !== 'T') return;

  const value = firstValue(readTextFrame(data.subarray(1), data[0]));
  if (!value) return;

  switch (key) {
    case 'TIT2': meta.title = meta.title || value; break;
    case 'TPE1': meta.artist = meta.artist || value; break;
    case 'TPE2': meta.albumArtist = meta.albumArtist || value; break;
    case 'TALB': meta.album = meta.album || value; break;
    case 'TCON': meta.genre = meta.genre || normaliseGenre(value); break;
    case 'TRCK': splitPair(value, meta, 'trackNo', 'trackOf'); break;
    case 'TPOS': splitPair(value, meta, 'discNo', 'discOf'); break;
    case 'TYER': case 'TDRC': case 'TDRL': case 'TORY':
      meta.year = meta.year || toInt(value); break;
    case 'TLEN': {
      const ms = toInt(value);
      if (ms && !meta.duration) meta.duration = ms / 1000;
      break;
    }
    default: break;
  }
}

function normaliseGenre(value) {
  // ID3v1 numeric references still show up as "(17)" or "17".
  const bare = String(value).match(/^\(?(\d{1,3})\)?$/);
  if (bare) return ID3_GENRES[+bare[1]] || value;
  return String(value).replace(/^\((\d+)\)/, (m, n) => (ID3_GENRES[+n] ? ID3_GENRES[+n] + ' ' : '')).trim();
}

function readTextFrame(bytes, encoding) {
  try {
    switch (encoding) {
      case 0: return td.latin1.decode(bytes).replace(TRAILING_NUL, '');
      case 1: return td.utf16.decode(bytes).replace(TRAILING_NUL_BOM, '');
      case 2: return td.utf16be.decode(bytes).replace(TRAILING_NUL_BOM, '');
      default: return td.utf8.decode(bytes).replace(TRAILING_NUL, '');
    }
  } catch {
    return '';
  }
}

function readApic(data, meta) {
  if (meta.artwork) return;
  const encoding = data[0];
  let pos = 1;
  let mime;

  // v2.2 PIC uses a 3 byte image-format code where v2.3+ uses a MIME string.
  const maybeType = td.latin1.decode(data.subarray(1, 4));
  if (/^(PNG|JPG|JPE)$/i.test(maybeType) && data[4] !== undefined && data[4] < 0x15) {
    mime = /png/i.test(maybeType) ? 'image/png' : 'image/jpeg';
    pos = 4;
  } else {
    const zero = data.indexOf(0, pos);
    if (zero < 0) return;
    mime = td.latin1.decode(data.subarray(pos, zero)) || 'image/jpeg';
    pos = zero + 1;
  }

  pos += 1; // picture type byte

  // Description, terminated by one NUL for latin1/utf8 and two for UTF-16.
  if (encoding === 1 || encoding === 2) {
    while (pos + 1 < data.length && !(data[pos] === 0 && data[pos + 1] === 0)) pos += 2;
    pos += 2;
  } else {
    const zero = data.indexOf(0, pos);
    if (zero < 0) return;
    pos = zero + 1;
  }

  if (pos >= data.length) return;
  if (!mime.includes('/')) mime = 'image/' + mime.toLowerCase();
  meta.artwork = new Blob([data.slice(pos)], { type: mime });
}

function readUslt(data, meta) {
  if (meta.lyrics) return;
  const encoding = data[0];
  let pos = 4; // encoding byte + 3 byte language code
  if (encoding === 1 || encoding === 2) {
    while (pos + 1 < data.length && !(data[pos] === 0 && data[pos + 1] === 0)) pos += 2;
    pos += 2;
  } else {
    const zero = data.indexOf(0, pos);
    pos = zero < 0 ? data.length : zero + 1;
  }
  meta.lyrics = readTextFrame(data.subarray(pos), encoding).trim();
}

function parseId3v1(tail, meta) {
  const at = tail.length - 128;
  if (at < 0) return;
  if (td.latin1.decode(tail.subarray(at, at + 3)) !== 'TAG') return;
  const str = (from, len) => td.latin1.decode(tail.subarray(at + from, at + from + len))
    .split(NUL)[0].trim();
  meta.title = meta.title || str(3, 30);
  meta.artist = meta.artist || str(33, 30);
  meta.album = meta.album || str(63, 30);
  meta.year = meta.year || toInt(str(93, 4));
  if (tail[at + 125] === 0 && tail[at + 126] !== 0) meta.trackNo = meta.trackNo || tail[at + 126];
  meta.genre = meta.genre || ID3_GENRES[tail[at + 127]] || '';
}

const MPEG_BITRATES_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG_BITRATES_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MPEG_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function parseMpegFrame(file, head, meta, audioStart) {
  let i = audioStart;
  const limit = Math.min(head.length - 4, audioStart + 65536);
  while (i < limit && !(head[i] === 0xff && (head[i + 1] & 0xe0) === 0xe0)) i++;
  if (i >= limit) return;

  const b1 = head[i + 1], b2 = head[i + 2], b3 = head[i + 3];
  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  const rateIndex = (b2 >> 2) & 0x03;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const channelMode = (b3 >> 6) & 0x03;
  if (versionBits === 1 || layerBits === 0 || rateIndex === 3) return;

  const table = versionBits === 3 ? MPEG_BITRATES_V1L3 : MPEG_BITRATES_V2L3;
  const sampleRate = (MPEG_RATES[versionBits] || MPEG_RATES[3])[rateIndex];
  const bitrate = table[bitrateIndex] * 1000;

  meta.sampleRate = sampleRate;
  meta.channels = channelMode === 3 ? 1 : 2;
  meta.codec = layerBits === 1 ? 'MP3' : 'MP2';

  const samplesPerFrame = versionBits === 3 ? 1152 : 576;

  // Xing/Info/VBRI headers carry the exact frame count for VBR files.
  const xingOffset = i + 4 + (versionBits === 3 ? (channelMode === 3 ? 17 : 32) : (channelMode === 3 ? 9 : 17));
  const tag = td.latin1.decode(head.subarray(xingOffset, xingOffset + 4));
  if (tag === 'Xing' || tag === 'Info') {
    const flags = readU32(head, xingOffset + 4);
    let p = xingOffset + 8;
    let frames = 0, bytes = 0;
    if (flags & 1) { frames = readU32(head, p); p += 4; }
    if (flags & 2) { bytes = readU32(head, p); p += 4; }
    if (frames > 0 && sampleRate) {
      meta.duration = (frames * samplesPerFrame) / sampleRate;
      meta.bitrate = Math.round(((bytes > 0 ? bytes : file.size - audioStart) * 8) / meta.duration);
      return;
    }
  }
  if (td.latin1.decode(head.subarray(i + 36, i + 40)) === 'VBRI') {
    const frames = readU32(head, i + 50);
    const bytes = readU32(head, i + 46);
    if (frames > 0 && sampleRate) {
      meta.duration = (frames * samplesPerFrame) / sampleRate;
      meta.bitrate = Math.round(((bytes > 0 ? bytes : file.size - audioStart) * 8) / meta.duration);
      return;
    }
  }

  // Constant bitrate: size over rate is exact enough.
  if (bitrate > 0) {
    meta.bitrate = bitrate;
    if (!meta.duration) meta.duration = ((file.size - audioStart) * 8) / bitrate;
  }
}

/* --------------------------------------------------------------------- MP4 */

const MP4_TEXT = {
  '©nam': 'title', '©ART': 'artist', '©alb': 'album', aART: 'albumArtist',
  '©gen': 'genre', '©day': 'year', '©cmt': 'comment', '©lyr': 'lyrics',
};

async function parseMp4(file, meta) {
  meta.codec = 'AAC';
  // moov can sit at either end of the file; read whichever holds it.
  const head = new Uint8Array(await slice(file, 0, Math.min(HEAD_BYTES, file.size)));
  const found = walkMp4(head, 0, head.length, meta);
  if (!found && file.size > HEAD_BYTES) {
    const tailStart = Math.max(0, file.size - TAIL_BYTES);
    const tail = new Uint8Array(await slice(file, tailStart, file.size));
    // The tail slice starts mid-atom, so find the moov box header directly.
    const at = findAtom(tail, 'moov');
    if (at >= 0) walkMp4(tail, at, tail.length, meta);
  }
}

function findAtom(b, name) {
  for (let i = 0; i + 8 <= b.length; i++) {
    if (b[i + 4] === name.charCodeAt(0) && b[i + 5] === name.charCodeAt(1)
      && b[i + 6] === name.charCodeAt(2) && b[i + 7] === name.charCodeAt(3)) return i;
  }
  return -1;
}

const MP4_CONTAINERS = new Set(['moov', 'udta', 'trak', 'mdia', 'minf', 'stbl']);

function walkMp4(b, start, end, meta, depth = 0) {
  if (depth > 8) return false;
  let pos = start;
  let sawMoov = false;

  while (pos + 8 <= end) {
    let size = readU32(b, pos);
    const type = td.latin1.decode(b.subarray(pos + 4, pos + 8));
    let headerSize = 8;

    if (size === 1) {
      // 64 bit size. The high word is zero for anything we hold in memory.
      size = readU32(b, pos + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize) break;

    const bodyStart = pos + headerSize;
    const bodyEnd = Math.min(pos + size, end);

    if (MP4_CONTAINERS.has(type)) {
      if (type === 'moov') sawMoov = true;
      walkMp4(b, bodyStart, bodyEnd, meta, depth + 1);
    } else if (type === 'meta') {
      walkMp4(b, bodyStart + 4, bodyEnd, meta, depth + 1); // meta carries a version/flags word
    } else if (type === 'ilst') {
      parseIlst(b, bodyStart, bodyEnd, meta);
    } else if (type === 'mvhd') {
      const version = b[bodyStart];
      const timescale = version === 1 ? readU32(b, bodyStart + 20) : readU32(b, bodyStart + 12);
      const dur = version === 1 ? readU32(b, bodyStart + 28) : readU32(b, bodyStart + 16);
      if (timescale > 0 && dur > 0 && !meta.duration) meta.duration = dur / timescale;
    } else if (type === 'stsd') {
      parseStsd(b, bodyStart + 8, bodyEnd, meta);
    }

    pos += size;
  }
  return sawMoov;
}

const MP4_CODECS = {
  mp4a: 'AAC', alac: 'ALAC', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3',
  avc1: 'H.264', hvc1: 'HEVC', hev1: 'HEVC', Opus: 'Opus', fLaC: 'FLAC',
};

function parseStsd(b, pos, end, meta) {
  if (pos + 8 > end) return;
  const format = td.latin1.decode(b.subarray(pos + 4, pos + 8));
  const named = MP4_CODECS[format];
  // A video track's stsd must not overwrite the audio codec we already found.
  if (named && !/H\.264|HEVC/.test(named)) meta.codec = named;
  if (format === 'alac' || format === 'fLaC') meta.lossless = true;

  if (format === 'mp4a' || format === 'alac' || format === 'fLaC') {
    meta.channels = meta.channels || readU16(b, pos + 24);
    const depth = readU16(b, pos + 26);
    if (depth && depth !== 16) meta.bitDepth = meta.bitDepth || depth;
    meta.sampleRate = meta.sampleRate || readU16(b, pos + 32);
  }
}

function parseIlst(b, pos, end, meta) {
  while (pos + 8 <= end) {
    const size = readU32(b, pos);
    if (size < 8 || pos + size > end) break;
    const name = td.latin1.decode(b.subarray(pos + 4, pos + 8));

    let dp = pos + 8;
    while (dp + 8 <= pos + size) {
      const dataSize = readU32(b, dp);
      const dataType = td.latin1.decode(b.subarray(dp + 4, dp + 8));
      if (dataSize < 8 || dp + dataSize > pos + size) break;
      if (dataType === 'data') {
        const flag = readU32(b, dp + 8) & 0xffffff;
        applyIlst(name, flag, b.subarray(dp + 16, dp + dataSize), meta);
      }
      dp += dataSize;
    }
    pos += size;
  }
}

function applyIlst(name, flag, payload, meta) {
  if (name === 'covr') {
    if (!meta.artwork && payload.length) {
      const mime = flag === 13 ? 'image/jpeg' : flag === 14 ? 'image/png' : sniffImage(payload);
      meta.artwork = new Blob([payload.slice()], { type: mime });
    }
    return;
  }
  if (name === 'trkn' || name === 'disk') {
    const n = readU16(payload, 2);
    const of = readU16(payload, 4);
    if (name === 'trkn') { if (n) meta.trackNo = meta.trackNo || n; if (of) meta.trackOf = meta.trackOf || of; }
    else { if (n) meta.discNo = meta.discNo || n; if (of) meta.discOf = meta.discOf || of; }
    return;
  }
  const key = MP4_TEXT[name];
  if (!key) return;
  const text = td.utf8.decode(payload).replace(TRAILING_NUL, '').trim();
  if (!text) return;
  if (key === 'year') meta.year = meta.year || toInt(text);
  else if (!meta[key]) meta[key] = text;
}

function sniffImage(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  return 'image/jpeg';
}

/* -------------------------------------------------------------------- FLAC */

function parseFlac(b, meta) {
  meta.codec = 'FLAC';
  meta.lossless = true;
  let pos = 4;
  while (pos + 4 <= b.length) {
    const last = (b[pos] & 0x80) !== 0;
    const type = b[pos] & 0x7f;
    const size = (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3];
    const body = pos + 4;
    if (body + size > b.length) break;

    if (type === 0) { // STREAMINFO
      const sr = (b[body + 10] << 12) | (b[body + 11] << 4) | (b[body + 12] >> 4);
      const channels = ((b[body + 12] >> 1) & 0x07) + 1;
      const depth = (((b[body + 12] & 0x01) << 4) | (b[body + 13] >> 4)) + 1;
      // Total samples is a 36 bit field, so the top nibble needs its own term.
      const samples = ((b[body + 13] & 0x0f) * 4294967296) + readU32(b, body + 14);
      meta.sampleRate = sr;
      meta.channels = channels;
      meta.bitDepth = depth;
      if (sr > 0 && samples > 0) meta.duration = samples / sr;
    } else if (type === 4) { // VORBIS_COMMENT
      parseVorbisComment(b, body, body + size, meta);
    } else if (type === 6) { // PICTURE
      parseFlacPicture(b, body, meta);
    }

    pos = body + size;
    if (last) break;
  }
}

function parseFlacPicture(b, pos, meta) {
  if (meta.artwork) return;
  const mimeLen = readU32(b, pos + 4);
  if (mimeLen > 255) return;
  const mime = td.latin1.decode(b.subarray(pos + 8, pos + 8 + mimeLen));
  let p = pos + 8 + mimeLen;
  const descLen = readU32(b, p);
  p += 4 + descLen + 16; // description, then width/height/depth/colour count
  const dataLen = readU32(b, p);
  p += 4;
  if (dataLen > 0 && p + dataLen <= b.length) {
    meta.artwork = new Blob([b.slice(p, p + dataLen)], { type: mime || 'image/jpeg' });
  }
}

function parseVorbisComment(b, pos, end, meta) {
  const vendorLen = readU32LE(b, pos);
  let p = pos + 4 + vendorLen;
  if (p + 4 > end) return;
  const count = readU32LE(b, p);
  p += 4;
  for (let i = 0; i < count && p + 4 <= end; i++) {
    const len = readU32LE(b, p);
    p += 4;
    if (p + len > end) break;
    const entry = td.utf8.decode(b.subarray(p, p + len));
    p += len;
    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    applyVorbisTag(entry.slice(0, eq).toUpperCase(), entry.slice(eq + 1), meta);
  }
}

function applyVorbisTag(key, value, meta) {
  if (!value) return;
  switch (key) {
    case 'TITLE': meta.title = meta.title || value; break;
    case 'ARTIST': meta.artist = meta.artist || value; break;
    case 'ALBUM': meta.album = meta.album || value; break;
    case 'ALBUMARTIST': case 'ALBUM ARTIST': meta.albumArtist = meta.albumArtist || value; break;
    case 'GENRE': meta.genre = meta.genre || value; break;
    case 'DATE': case 'YEAR': meta.year = meta.year || toInt(value); break;
    case 'TRACKNUMBER': splitPair(value, meta, 'trackNo', 'trackOf'); break;
    case 'TRACKTOTAL': case 'TOTALTRACKS': meta.trackOf = meta.trackOf || toInt(value); break;
    case 'DISCNUMBER': splitPair(value, meta, 'discNo', 'discOf'); break;
    case 'DISCTOTAL': case 'TOTALDISCS': meta.discOf = meta.discOf || toInt(value); break;
    case 'LYRICS': case 'UNSYNCEDLYRICS': meta.lyrics = meta.lyrics || value; break;
    case 'COMMENT': case 'DESCRIPTION': meta.comment = meta.comment || value; break;
    case 'METADATA_BLOCK_PICTURE': readBase64Picture(value, meta); break;
    default: break;
  }
}

function readBase64Picture(value, meta) {
  if (meta.artwork) return;
  try {
    const bin = atob(value);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // The block matches a FLAC PICTURE body minus its 4 byte block header.
    parseFlacPicture(bytes, -4, meta);
  } catch { /* malformed picture block */ }
}

/* --------------------------------------------------------------------- Ogg */

function parseOgg(b, meta) {
  // The comment header sits in the second logical page; scan pages for it.
  let pos = 0;
  let pages = 0;
  while (pos + 27 <= b.length && pages < 12) {
    if (td.latin1.decode(b.subarray(pos, pos + 4)) !== 'OggS') break;
    const segCount = b[pos + 26];
    const segTable = pos + 27;
    let payloadLen = 0;
    for (let i = 0; i < segCount; i++) payloadLen += b[segTable + i];
    const payload = segTable + segCount;
    if (payload + payloadLen > b.length) break;

    const magic8 = td.latin1.decode(b.subarray(payload, payload + 8));
    if (magic8 === 'OpusHead') {
      meta.codec = 'Opus';
      meta.channels = b[payload + 9];
      meta.sampleRate = readU32LE(b, payload + 12) || 48000;
    } else if (magic8 === 'OpusTags') {
      parseVorbisComment(b, payload + 8, payload + payloadLen, meta);
    } else if (td.latin1.decode(b.subarray(payload + 1, payload + 7)) === 'vorbis') {
      const packetType = b[payload];
      if (packetType === 1) {
        meta.codec = 'Vorbis';
        meta.channels = b[payload + 11];
        meta.sampleRate = readU32LE(b, payload + 12);
      } else if (packetType === 3) {
        parseVorbisComment(b, payload + 7, payload + payloadLen, meta);
      }
    } else if (magic8.slice(1, 5) === 'FLAC') {
      meta.codec = 'FLAC';
      meta.lossless = true;
    }

    pos = payload + payloadLen;
    pages++;
  }
}

/* --------------------------------------------------------------------- WAV */

const WAV_INFO = { INAM: 'title', IART: 'artist', IPRD: 'album', IGNR: 'genre', ICRD: 'year', ICMT: 'comment' };

function parseWav(b, meta) {
  meta.codec = 'PCM';
  meta.lossless = true;
  let pos = 12;
  let dataSize = 0;
  let byteRate = 0;

  while (pos + 8 <= b.length) {
    const id = td.latin1.decode(b.subarray(pos, pos + 4));
    const size = readU32LE(b, pos + 4);
    const body = pos + 8;

    if (id === 'fmt ') {
      const format = readU16LE(b, body);
      meta.channels = readU16LE(b, body + 2);
      meta.sampleRate = readU32LE(b, body + 4);
      byteRate = readU32LE(b, body + 8);
      meta.bitDepth = readU16LE(b, body + 14);
      if (format === 3) meta.codec = 'PCM float';
      else if (format !== 1 && format !== 0xfffe) {
        meta.codec = 'WAV 0x' + format.toString(16);
        meta.lossless = false;
      }
    } else if (id === 'data') {
      dataSize = size;
    } else if (id === 'LIST' && td.latin1.decode(b.subarray(body, body + 4)) === 'INFO') {
      parseRiffInfo(b, body + 4, Math.min(body + size, b.length), meta);
    } else if (id === 'id3 ' || id === 'ID3 ') {
      try { parseId3v2(b.subarray(body, body + size), meta); } catch { /* optional */ }
    }

    // The data chunk is the whole file; never walk into it.
    if (id === 'data' && body + size > b.length) break;
    pos = body + size + (size % 2); // chunks are word aligned
    if (size <= 0) break;
  }

  if (byteRate > 0) {
    meta.bitrate = byteRate * 8;
    if (dataSize > 0) meta.duration = dataSize / byteRate;
  }
  if (meta.bitDepth && meta.codec.startsWith('PCM')) meta.codec = meta.codec + ' ' + meta.bitDepth + '-bit';
}

function parseRiffInfo(b, pos, end, meta) {
  while (pos + 8 <= end) {
    const id = td.latin1.decode(b.subarray(pos, pos + 4));
    const size = readU32LE(b, pos + 4);
    if (size <= 0) break;
    const text = td.utf8.decode(b.subarray(pos + 8, Math.min(pos + 8 + size, end)))
      .replace(TRAILING_NUL, '').trim();
    const key = WAV_INFO[id];
    if (key && text) {
      if (key === 'year') meta.year = meta.year || toInt(text);
      else if (!meta[key]) meta[key] = text;
    }
    pos += 8 + size + (size % 2);
  }
}

/* -------------------------------------------------------------------- AIFF */

function parseAiff(b, meta) {
  meta.codec = 'AIFF';
  meta.lossless = true;
  let pos = 12;
  while (pos + 8 <= b.length) {
    const id = td.latin1.decode(b.subarray(pos, pos + 4));
    const size = readU32(b, pos + 4);
    const body = pos + 8;
    if (size <= 0) break;

    if (id === 'COMM') {
      meta.channels = readU16(b, body);
      const frames = readU32(b, body + 2);
      meta.bitDepth = readU16(b, body + 6);
      const rate = readExtendedFloat(b, body + 8);
      meta.sampleRate = Math.round(rate);
      if (rate > 0 && frames > 0) meta.duration = frames / rate;
      if (meta.channels && meta.bitDepth && rate) meta.bitrate = Math.round(meta.channels * meta.bitDepth * rate);
    } else if (id === 'NAME') {
      meta.title = meta.title || td.latin1.decode(b.subarray(body, body + size)).trim();
    } else if (id === 'AUTH') {
      meta.artist = meta.artist || td.latin1.decode(b.subarray(body, body + size)).trim();
    } else if (id === 'ID3 ') {
      try { parseId3v2(b.subarray(body, body + size), meta); } catch { /* optional */ }
    }

    if (id === 'SSND' && body + size > b.length) break;
    pos = body + size + (size % 2);
  }
  if (meta.bitDepth) meta.codec = 'AIFF ' + meta.bitDepth + '-bit';
}

/** 80 bit IEEE 754 extended precision, as AIFF stores its sample rate. */
function readExtendedFloat(b, pos) {
  const exponent = ((b[pos] & 0x7f) << 8) | b[pos + 1];
  let mantissa = 0;
  for (let i = 0; i < 8; i++) mantissa = mantissa * 256 + b[pos + 2 + i];
  if (exponent === 0 && mantissa === 0) return 0;
  const sign = b[pos] & 0x80 ? -1 : 1;
  return sign * mantissa * Math.pow(2, exponent - 16383 - 63);
}

/* ----------------------------------------------------------------- numbers */

function readU32(b, p) { return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; }
function readU16(b, p) { return (b[p] << 8) | b[p + 1]; }
function readU32LE(b, p) { return ((b[p + 3] << 24) | (b[p + 2] << 16) | (b[p + 1] << 8) | b[p]) >>> 0; }
function readU16LE(b, p) { return (b[p + 1] << 8) | b[p]; }

const ID3_GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'Alt. Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock', 'Folk', 'Folk-Rock', 'National Folk', 'Swing', 'Fast Fusion', 'Bebob', 'Latin', 'Revival', 'Celtic', 'Bluegrass', 'Avantgarde', 'Gothic Rock', 'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus', 'Easy Listening', 'Acoustic', 'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove', 'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle', 'Duet', 'Punk Rock', 'Drum Solo', 'A Capella', 'Euro-House', 'Dance Hall'];
