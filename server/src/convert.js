/**
 * ffmpeg wiring.
 *
 * The default is deliberately "copy": remux the source audio into an MP4
 * container without touching the samples. Re-encoding audio that is already
 * lossy throws away quality for nothing, so it only happens when the caller
 * explicitly asks for MP3 or AAC.
 */

import { spawn } from 'node:child_process';
import { config } from './config.js';

export const PROFILES = {
  original: {
    // Copy the bitstream. AAC and ALAC go into .m4a untouched.
    args: ['-c:a', 'copy'],
    container: 'ipod',
    ext: 'm4a',
    mime: 'audio/mp4',
    label: 'Original',
  },
  mp3_320: {
    args: ['-c:a', 'libmp3lame', '-b:a', '320k'],
    container: 'mp3',
    ext: 'mp3',
    mime: 'audio/mpeg',
    label: 'MP3 320',
  },
  mp3_v0: {
    args: ['-c:a', 'libmp3lame', '-q:a', '0'],
    container: 'mp3',
    ext: 'mp3',
    mime: 'audio/mpeg',
    label: 'MP3 V0',
  },
  m4a_256: {
    args: ['-c:a', 'aac', '-b:a', '256k'],
    container: 'ipod',
    ext: 'm4a',
    mime: 'audio/mp4',
    label: 'AAC 256',
  },
};

/** Codecs that can sit in an MP4 container untouched. */
const MP4_SAFE = /^(aac|mp4a|alac)/i;

/**
 * Choose the profile actually used. "original" falls back to a re-encode when
 * the source codec cannot live in MP4, which is the case for Opus and Vorbis.
 */
export function planProfile(requested, sourceCodec) {
  const profile = PROFILES[requested] || PROFILES.original;
  if (requested !== 'original') return { profile, downgraded: false };

  if (MP4_SAFE.test(sourceCodec || '')) return { profile, downgraded: false };

  // Opus in MP4 is not something iOS reliably plays, so transcode instead of
  // handing back a file that imports fine and then refuses to play.
  return {
    profile: { ...PROFILES.m4a_256, label: 'AAC 256 (source codec cannot be copied)' },
    downgraded: true,
  };
}

/**
 * Stream converted audio to a writable.
 * @returns {Promise<void>} resolves when ffmpeg exits cleanly
 */
export function convertToStream({ streamUrl, httpHeaders, profile, meta, output, onSpawn }) {
  const headerLines = Object.entries(httpHeaders || {})
    .map(([key, value]) => key + ': ' + value)
    .join('\r\n');

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    // Long transfers from a CDN drop; let ffmpeg pick itself back up.
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '10',
  ];

  if (headerLines) args.push('-headers', headerLines + '\r\n');

  args.push('-i', streamUrl, '-vn', '-map_metadata', '-1', ...profile.args);

  if (meta.title) args.push('-metadata', 'title=' + meta.title);
  if (meta.artist) args.push('-metadata', 'artist=' + meta.artist);
  if (meta.album) args.push('-metadata', 'album=' + meta.album);

  // A non-seekable stdout needs the moov atom written up front for MP4.
  if (profile.container === 'ipod') args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof');

  args.push('-f', profile.container, 'pipe:1');

  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (onSpawn) onSpawn(child);

    const errTail = [];
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('Conversion timed out.'));
    }, config.convertTimeoutMs);

    child.stderr.on('data', (chunk) => {
      errTail.push(chunk.toString('utf8'));
      if (errTail.length > 20) errTail.splice(0, errTail.length - 20);
    });

    child.stdout.pipe(output, { end: false });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error('ffmpeg is not installed on the server.') : err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(errTail.join('').trim().split('\n').pop() || ('ffmpeg exited with code ' + code)));
    });

    // If the phone hangs up mid-download, stop burning CPU on it.
    output.on('close', () => {
      if (!settled) child.kill('SIGKILL');
    });
  });
}
