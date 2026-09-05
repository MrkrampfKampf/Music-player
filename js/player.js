/**
 * Playback engine.
 *
 * Quality first: by default audio goes straight from a media element to the
 * output with nothing in between, so a 24-bit/96 kHz file is handed to the
 * system untouched. The Web Audio graph that powers the equaliser, crossfade
 * and in-app volume is built lazily and only once one of those is switched on,
 * because routing through an AudioContext resamples everything to the
 * context's own rate.
 *
 * Two audio elements are kept alive and swapped between tracks. That gives
 * near-gapless transitions (the next track is already buffered when the
 * current one ends) and is what makes crossfade possible at all. Elements are
 * reused rather than recreated because iOS ties its audio session to the
 * element that the user's tap first started.
 */

import * as db from './db.js';

export const REPEAT = { OFF: 'off', ALL: 'all', ONE: 'one' };

export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const EQ_PRESETS = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Acoustic: [4, 4, 3, 1, 1.5, 1.5, 3, 3.5, 3, 2],
  'Bass Booster': [6, 5, 4, 2.5, 1, 0, 0, 0, 0, 0],
  'Bass Reducer': [-6, -5, -4, -2.5, -1, 0, 0, 0, 0, 0],
  Classical: [4.5, 3.5, 3, 2, -1.5, -1.5, 0, 2, 3, 3.5],
  Dance: [5, 6.5, 4.5, 0, 1.5, 3.5, 4.5, 4, 2.5, 0],
  Electronic: [4.5, 4, 1, 0, -2, 2, 1, 1, 4, 4.5],
  'Hip-Hop': [5.5, 4.5, 1.5, 3, -1, -1, 1.5, -0.5, 2, 3],
  Jazz: [4, 3, 1.5, 2, -1.5, -1.5, 0, 1.5, 3, 3.5],
  Latin: [5, 3, 0, 0, -1.5, -1.5, -1.5, 0, 3, 5],
  Loudness: [7, 5.5, 0, 0, -2, 0, -1, -5, 6, 1],
  Lounge: [-3, -1.5, -0.5, 1.5, 4, 2.5, 0, -1.5, 2, 1],
  Piano: [3, 2, 0, 2.5, 3, 1, 2.5, 4, 3, 3.5],
  Pop: [-1.5, -1, 0, 2, 4, 4, 2, 0, -1, -1.5],
  'R&B': [3, 6.5, 5.5, 1.5, -2, -1.5, 2, 2.5, 3, 4],
  Rock: [5, 4, 3, 1.5, -0.5, -1, 0.5, 3, 4, 4.5],
  'Small Speakers': [6, 5, 4, 2.5, 1, 0, -1, -2, -3, -4],
  'Spoken Word': [-3, -1, 0, 1, 4, 5, 5.5, 4.5, 3, 0],
  'Treble Booster': [0, 0, 0, 0, 0, 1, 2.5, 4, 5, 6],
  'Treble Reducer': [0, 0, 0, 0, 0, -1, -2.5, -4, -5, -6],
  'Vocal Booster': [-2, -3, -3, 1.5, 4, 4, 3, 1.5, 0, -1.5],
};

class Player extends EventTarget {
  constructor() {
    super();

    /** @type {string[]} track ids in the order they will actually play */
    this.queue = [];
    /** @type {string[]} the queue before shuffling, so shuffle is reversible */
    this.baseQueue = [];
    this.index = -1;
    this.current = null;

    this.shuffle = false;
    this.repeat = REPEAT.OFF;
    this.playbackRate = 1;
    this.volume = 1;
    this.crossfadeSeconds = 0;
    this.eqEnabled = false;
    this.eqGains = EQ_PRESETS.Flat.slice();
    this.preampDb = 0;

    this.sleepTimer = null;
    this.sleepAt = 0;
    this.stopAfterTrack = false;

    this._urls = new Map();       // trackId -> object URL, so we can revoke
    this._audio = [this._makeAudio(), this._makeAudio()];
    this._active = 0;
    this._video = null;
    this._ctx = null;
    this._nodes = [null, null];   // per-element Web Audio chain
    this._masterGain = null;
    this._filters = null;
    this._crossfading = false;
    this._scrobbled = false;
    this._pendingPreload = null;

    this._tick = this._tick.bind(this);
    this._rafId = null;
  }

  /* ------------------------------------------------------------- elements */

  _makeAudio() {
    const el = new Audio();
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    // Lets iOS surface the AirPlay route picker for this element.
    el.setAttribute('x-webkit-airplay', 'allow');
    el.addEventListener('ended', () => this._onEnded(el));
    el.addEventListener('error', () => this._onError(el));
    el.addEventListener('play', () => this._emitState());
    el.addEventListener('pause', () => this._emitState());
    el.addEventListener('loadedmetadata', () => this._emitState());
    el.addEventListener('progress', () => this._emitState());
    el.addEventListener('waiting', () => this._emitState());
    el.addEventListener('canplay', () => this._emitState());
    return el;
  }

  /** The <video> surface is supplied by the UI once the Now Playing view exists. */
  attachVideo(el) {
    if (this._video === el) return;
    this._video = el;
    if (!el) return;
    el.playsInline = true;
    el.setAttribute('x-webkit-airplay', 'allow');
    el.addEventListener('ended', () => this._onEnded(el));
    el.addEventListener('error', () => this._onError(el));
    el.addEventListener('play', () => this._emitState());
    el.addEventListener('pause', () => this._emitState());
    el.addEventListener('loadedmetadata', () => this._emitState());
  }

  get media() {
    if (this.current && this.current.kind === 'video' && this._video) return this._video;
    return this._audio[this._active];
  }

  get idleAudio() {
    return this._audio[1 - this._active];
  }

  get isVideo() {
    return !!(this.current && this.current.kind === 'video');
  }

  get playing() {
    const m = this.media;
    return !!m && !m.paused && !m.ended;
  }

  get currentTime() {
    const m = this.media;
    return m ? m.currentTime || 0 : 0;
  }

  get duration() {
    const m = this.media;
    if (m && Number.isFinite(m.duration) && m.duration > 0) return m.duration;
    return this.current ? this.current.duration || 0 : 0;
  }

  get buffered() {
    const m = this.media;
    if (!m || !m.buffered || !m.buffered.length) return 0;
    try { return m.buffered.end(m.buffered.length - 1); } catch { return 0; }
  }

  /* ---------------------------------------------------------------- queue */

  /**
   * Start a list of tracks.
   * @param {object[]} tracks resolved track rows
   * @param {number} startIndex index into `tracks` before any shuffling
   */
  async play(tracks, startIndex = 0) {
    if (!tracks || !tracks.length) return;
    const ids = tracks.map((t) => t.id);
    this.baseQueue = ids.slice();

    if (this.shuffle) {
      // Keep the tapped track first, shuffle everything after it.
      const picked = ids[startIndex];
      const rest = ids.filter((_, i) => i !== startIndex);
      this.queue = [picked, ...shuffled(rest)];
      this.index = 0;
    } else {
      this.queue = ids;
      this.index = startIndex;
    }

    this._emitQueue();
    await this._load(this.queue[this.index], true);
  }

  async playTrack(track) {
    await this.play([track], 0);
  }

  /** Insert tracks directly after the current one. */
  playNext(tracks) {
    const ids = tracks.map((t) => t.id);
    this.queue.splice(this.index + 1, 0, ...ids);
    this.baseQueue.splice(Math.min(this.index + 1, this.baseQueue.length), 0, ...ids);
    this._emitQueue();
  }

  addToQueue(tracks) {
    const ids = tracks.map((t) => t.id);
    this.queue.push(...ids);
    this.baseQueue.push(...ids);
    this._emitQueue();
  }

  removeFromQueue(position) {
    if (position < 0 || position >= this.queue.length) return;
    const [id] = this.queue.splice(position, 1);
    const baseAt = this.baseQueue.indexOf(id);
    if (baseAt >= 0) this.baseQueue.splice(baseAt, 1);
    if (position < this.index) {
      this.index--;
    } else if (position === this.index) {
      // The track that shifted into this slot becomes the current one.
      this.index--;
      this.next();
    }
    this._emitQueue();
  }

  moveInQueue(from, to) {
    if (from === to || from < 0 || to < 0) return;
    if (from >= this.queue.length || to >= this.queue.length) return;
    const [id] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, id);
    if (from === this.index) this.index = to;
    else if (from < this.index && to >= this.index) this.index--;
    else if (from > this.index && to <= this.index) this.index++;
    this._emitQueue();
  }

  clearQueue() {
    this.queue = this.index >= 0 ? [this.queue[this.index]] : [];
    this.baseQueue = this.queue.slice();
    this.index = this.queue.length ? 0 : -1;
    this._emitQueue();
  }

  setShuffle(on) {
    if (this.shuffle === on) return;
    this.shuffle = on;
    const currentId = this.queue[this.index];

    if (on) {
      const rest = this.baseQueue.filter((id) => id !== currentId);
      this.queue = currentId ? [currentId, ...shuffled(rest)] : shuffled(rest);
      this.index = currentId ? 0 : -1;
    } else {
      this.queue = this.baseQueue.slice();
      this.index = currentId ? this.queue.indexOf(currentId) : -1;
    }

    this._emitQueue();
    this._schedulePreload();
  }

  setRepeat(mode) {
    this.repeat = mode;
    this.dispatchEvent(new CustomEvent('modechange'));
    this._schedulePreload();
  }

  cycleRepeat() {
    const order = [REPEAT.OFF, REPEAT.ALL, REPEAT.ONE];
    this.setRepeat(order[(order.indexOf(this.repeat) + 1) % order.length]);
  }

  /* --------------------------------------------------------------- loading */

  async _load(trackId, autoplay) {
    const track = await db.getTrack(trackId);
    if (!track) {
      this.dispatchEvent(new CustomEvent('error', { detail: { message: 'That track is missing from the library.' } }));
      return;
    }

    const wasVideo = this.isVideo;
    this.current = track;
    this._scrobbled = false;

    // Switching between audio and video means the other surface must go quiet.
    if (wasVideo !== this.isVideo) {
      (wasVideo ? this._video : this._audio[this._active])?.pause();
    }

    const url = await this._urlFor(trackId);
    if (!url) {
      this.dispatchEvent(new CustomEvent('error', { detail: { message: 'The file for this track could not be read.' } }));
      return;
    }

    const media = this.media;
    if (media.src !== url) {
      media.src = url;
      media.load();
    }
    media.playbackRate = this.playbackRate;
    this._applyVolume();

    this.dispatchEvent(new CustomEvent('trackchange', { detail: { track } }));
    this._updateMediaSession();

    if (autoplay) await this._start(media);
    this._schedulePreload();
    this._startTicking();
  }

  async _start(media) {
    try {
      if (this._ctx && this._ctx.state === 'suspended') await this._ctx.resume();
      await media.play();
    } catch (err) {
      // A rejected play() is almost always a missing user gesture on iOS.
      if (err && err.name !== 'AbortError') {
        this.dispatchEvent(new CustomEvent('needsgesture', { detail: { error: err } }));
      }
    }
    this._emitState();
  }

  async _urlFor(trackId) {
    if (this._urls.has(trackId)) return this._urls.get(trackId);
    const blob = await db.getBlob(trackId);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this._urls.set(trackId, url);
    this._trimUrls(trackId);
    return url;
  }

  /**
   * Keep object URLs only for the tracks around the playhead. The previous
   * track is kept too: during a crossfade the outgoing element is still
   * reading from its URL.
   */
  _trimUrls(keepId) {
    const keep = new Set([
      keepId,
      this.queue[this.index - 1],
      this.queue[this.index],
      this.queue[this.index + 1],
    ].filter(Boolean));
    for (const [id, url] of this._urls) {
      if (keep.has(id)) continue;
      URL.revokeObjectURL(url);
      this._urls.delete(id);
    }
  }

  /** Warm the idle element with the next track so the handover is seamless. */
  async _schedulePreload() {
    if (this.isVideo) return;
    const nextId = this._peekNextId();
    if (!nextId || nextId === this._pendingPreload) return;
    this._pendingPreload = nextId;
    const url = await this._urlFor(nextId);
    if (!url || this._pendingPreload !== nextId) return;
    const idle = this.idleAudio;
    if (idle.src !== url) {
      idle.src = url;
      idle.load();
    }
  }

  _peekNextId() {
    if (this.repeat === REPEAT.ONE) return this.queue[this.index];
    if (this.index + 1 < this.queue.length) return this.queue[this.index + 1];
    if (this.repeat === REPEAT.ALL && this.queue.length) return this.queue[0];
    return null;
  }

  /* -------------------------------------------------------------- transport */

  async toggle() {
    if (this.playing) this.pause();
    else await this.resume();
  }

  async resume() {
    if (!this.current && this.queue.length) {
      await this._load(this.queue[Math.max(0, this.index)], true);
      return;
    }
    await this._start(this.media);
  }

  pause() {
    this.media?.pause();
    this._emitState();
  }

  stop() {
    this._audio.forEach((el) => { el.pause(); el.removeAttribute('src'); el.load(); });
    if (this._video) { this._video.pause(); this._video.removeAttribute('src'); }
    this.current = null;
    this.index = -1;
    this.queue = [];
    this.baseQueue = [];
    this._stopTicking();
    this._emitQueue();
    this._emitState();
    this.dispatchEvent(new CustomEvent('trackchange', { detail: { track: null } }));
  }

  async next(userInitiated = true) {
    if (!this.queue.length) return;

    if (!userInitiated && this.repeat === REPEAT.ONE) {
      this.seek(0);
      await this._start(this.media);
      return;
    }

    if (this.index + 1 < this.queue.length) {
      this.index++;
    } else if (this.repeat === REPEAT.ALL) {
      this.index = 0;
    } else {
      // End of the queue: stop on the last track rather than looping.
      this.pause();
      this.seek(0);
      return;
    }

    this._swapElements();
    await this._load(this.queue[this.index], true);
  }

  async previous() {
    // Matches every other player: restart the track unless you tap twice.
    if (this.currentTime > 3 || this.index <= 0) {
      this.seek(0);
      if (!this.playing) await this._start(this.media);
      return;
    }
    this.index--;
    this._swapElements();
    await this._load(this.queue[this.index], true);
  }

  async jumpTo(position) {
    if (position < 0 || position >= this.queue.length) return;
    this.index = position;
    this._swapElements();
    await this._load(this.queue[this.index], true);
  }

  /** Hand playback to the element that already has the next track buffered. */
  _swapElements() {
    if (this.isVideo) return;
    const idle = this.idleAudio;
    const nextUrl = this._pendingPreload ? this._urls.get(this._pendingPreload) : null;
    if (nextUrl && idle.src === nextUrl) {
      this._audio[this._active].pause();
      this._active = 1 - this._active;
    }
    this._pendingPreload = null;
  }

  seek(seconds) {
    const m = this.media;
    if (!m) return;
    const d = this.duration;
    const target = Math.max(0, d ? Math.min(seconds, d) : seconds);
    try { m.currentTime = target; } catch { /* not seekable yet */ }
    this._emitTime();
  }

  seekBy(delta) {
    this.seek(this.currentTime + delta);
  }

  setRate(rate) {
    this.playbackRate = rate;
    this._audio.forEach((el) => { el.playbackRate = rate; });
    if (this._video) this._video.playbackRate = rate;
    this.dispatchEvent(new CustomEvent('modechange'));
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    this._applyVolume();
    this.dispatchEvent(new CustomEvent('modechange'));
  }

  _applyVolume() {
    // iOS ignores HTMLMediaElement.volume, so the Web Audio gain is the only
    // in-app volume that works there. Set both and let whichever one applies.
    this._audio.forEach((el) => { el.volume = this.volume; });
    if (this._video) this._video.volume = this.volume;
    if (this._masterGain) {
      this._masterGain.gain.setTargetAtTime(this.volume * dbToGain(this.preampDb), this._ctx.currentTime, 0.01);
    }
  }

  /** True when the platform honours element volume, so the UI can hide it. */
  static supportsElementVolume() {
    const probe = new Audio();
    probe.volume = 0.42;
    return Math.abs(probe.volume - 0.42) < 0.01;
  }

  /* ------------------------------------------------------------- equaliser */

  setEqEnabled(on) {
    this.eqEnabled = on;
    if (on) this._ensureGraph();
    this._applyEq();
    this.dispatchEvent(new CustomEvent('modechange'));
  }

  setEqGains(gains) {
    this.eqGains = gains.slice();
    if (this.eqEnabled) this._applyEq();
    this.dispatchEvent(new CustomEvent('modechange'));
  }

  setPreamp(db_) {
    this.preampDb = db_;
    this._applyVolume();
    this.dispatchEvent(new CustomEvent('modechange'));
  }

  setCrossfade(seconds) {
    this.crossfadeSeconds = seconds;
    if (seconds > 0) this._ensureGraph();
    this.dispatchEvent(new CustomEvent('modechange'));
  }

  /**
   * Build the Web Audio chain. Only called once the user turns on a feature
   * that needs it, since routing through an AudioContext costs a resample.
   */
  _ensureGraph() {
    if (this._ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;

    try {
      this._ctx = new Ctx();
      this._masterGain = this._ctx.createGain();

      this._filters = EQ_BANDS.map((freq, i) => {
        const f = this._ctx.createBiquadFilter();
        f.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
        f.frequency.value = freq;
        f.Q.value = 1.1;
        f.gain.value = 0;
        return f;
      });

      // element -> per-element gain -> filter chain -> master -> output
      this._filters.reduce((prev, node) => { prev.connect(node); return node; });
      this._filters[this._filters.length - 1].connect(this._masterGain);
      this._masterGain.connect(this._ctx.destination);

      this._audio.forEach((el, i) => {
        const source = this._ctx.createMediaElementSource(el);
        const gain = this._ctx.createGain();
        gain.gain.value = 1;
        source.connect(gain);
        gain.connect(this._filters[0]);
        this._nodes[i] = { source, gain };
      });

      this._applyVolume();
    } catch (err) {
      console.warn('Web Audio unavailable, staying on the direct path', err);
      this._ctx = null;
      this._masterGain = null;
      this._filters = null;
    }
  }

  _applyEq() {
    if (!this._filters || !this._ctx) return;
    const now = this._ctx.currentTime;
    this._filters.forEach((f, i) => {
      const value = this.eqEnabled ? (this.eqGains[i] || 0) : 0;
      f.gain.setTargetAtTime(value, now, 0.02);
    });
  }

  /* ----------------------------------------------------------- sleep timer */

  startSleepTimer(minutes, stopAfterTrack = false) {
    this.cancelSleepTimer();
    this.stopAfterTrack = stopAfterTrack;
    if (stopAfterTrack) {
      this.sleepAt = 0;
      this.dispatchEvent(new CustomEvent('sleepchange'));
      return;
    }
    this.sleepAt = Date.now() + minutes * 60000;
    this.sleepTimer = setTimeout(() => {
      this._fadeOutAndPause(4);
      this.sleepAt = 0;
      this.sleepTimer = null;
      this.dispatchEvent(new CustomEvent('sleepchange'));
    }, minutes * 60000);
    this.dispatchEvent(new CustomEvent('sleepchange'));
  }

  cancelSleepTimer() {
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    this.sleepAt = 0;
    this.stopAfterTrack = false;
    this.dispatchEvent(new CustomEvent('sleepchange'));
  }

  get sleepRemaining() {
    if (this.stopAfterTrack) return -1;
    return this.sleepAt ? Math.max(0, this.sleepAt - Date.now()) : 0;
  }

  _fadeOutAndPause(seconds) {
    const media = this.media;
    if (!media) return;
    const startVolume = this.volume;
    const steps = 40;
    let step = 0;
    const id = setInterval(() => {
      step++;
      const t = 1 - step / steps;
      if (this._masterGain && this._ctx) {
        this._masterGain.gain.setTargetAtTime(startVolume * t * dbToGain(this.preampDb), this._ctx.currentTime, 0.05);
      } else {
        media.volume = Math.max(0, startVolume * t);
      }
      if (step >= steps) {
        clearInterval(id);
        media.pause();
        media.volume = startVolume;
        this._applyVolume();
        this._emitState();
      }
    }, (seconds * 1000) / steps);
  }

  /* ---------------------------------------------------------------- events */

  _onEnded(el) {
    if (el !== this.media) return;
    if (this.stopAfterTrack) {
      this.cancelSleepTimer();
      this.pause();
      return;
    }
    this.next(false);
  }

  _onError(el) {
    if (el !== this.media) return;
    const name = this.current ? this.current.title : 'this track';
    this.dispatchEvent(new CustomEvent('error', {
      detail: { message: 'Could not play ' + name + '. The file may be in a format iOS cannot decode.' },
    }));
    // Do not spin through a whole broken library; stop on the failure.
    this.pause();
  }

  _startTicking() {
    if (this._rafId != null) return;
    this._rafId = requestAnimationFrame(this._tick);
  }

  _stopTicking() {
    if (this._rafId != null) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  _tick() {
    this._rafId = requestAnimationFrame(this._tick);
    if (!this.current) return;

    this._emitTime();
    this._maybeScrobble();
    this._maybeCrossfade();

    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && this.playing) {
      const d = this.duration;
      if (d > 0 && this.currentTime <= d) {
        try {
          navigator.mediaSession.setPositionState({
            duration: d,
            playbackRate: this.playbackRate,
            position: this.currentTime,
          });
        } catch { /* Safari throws on transient bad values */ }
      }
    }
  }

  /** Count a listen once half the track, or four minutes, has gone by. */
  _maybeScrobble() {
    if (this._scrobbled || !this.playing) return;
    const d = this.duration;
    const threshold = d > 0 ? Math.min(d * 0.5, 240) : 30;
    if (this.currentTime >= threshold) {
      this._scrobbled = true;
      db.recordPlay(this.current.id).catch(() => {});
      this.dispatchEvent(new CustomEvent('scrobble', { detail: { trackId: this.current.id } }));
    }
  }

  _maybeCrossfade() {
    const fade = this.crossfadeSeconds;
    if (!fade || this._crossfading || this.isVideo || !this.playing) return;
    if (this.repeat === REPEAT.ONE) return;

    const d = this.duration;
    if (!d) return;
    const remaining = d - this.currentTime;
    if (remaining > fade || remaining <= 0) return;
    if (!this._peekNextId()) return;

    this._crossfading = true;
    const outNode = this._nodes[this._active];
    const outEl = this._audio[this._active];
    const inEl = this.idleAudio;
    const inNode = this._nodes[1 - this._active];

    if (this._ctx && outNode && inNode) {
      const now = this._ctx.currentTime;
      outNode.gain.gain.setValueAtTime(outNode.gain.gain.value, now);
      outNode.gain.gain.linearRampToValueAtTime(0.0001, now + remaining);
      inNode.gain.gain.setValueAtTime(0.0001, now);
      inNode.gain.gain.linearRampToValueAtTime(1, now + remaining);
    }

    inEl.play().catch(() => {});
    setTimeout(() => {
      outEl.pause();
      if (outNode) outNode.gain.gain.value = 1;
      this._crossfading = false;
    }, remaining * 1000);

    // Advance the model now so the UI and lock screen follow the audio.
    this.next(false);
  }

  _emitState() {
    this.dispatchEvent(new CustomEvent('statechange'));
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    }
  }

  _emitTime() {
    this.dispatchEvent(new CustomEvent('timeupdate'));
  }

  _emitQueue() {
    this.dispatchEvent(new CustomEvent('queuechange'));
  }

  /* -------------------------------------------------------- media session */

  async _updateMediaSession() {
    if (!('mediaSession' in navigator) || !this.current) return;
    const t = this.current;

    const art = [];
    if (t.artworkKey) {
      const blob = await db.getArtwork(t.artworkKey);
      if (blob) {
        if (this._artUrl) URL.revokeObjectURL(this._artUrl);
        this._artUrl = URL.createObjectURL(blob);
        art.push({ src: this._artUrl, sizes: '512x512', type: blob.type || 'image/jpeg' });
      }
    }
    if (!art.length) art.push({ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' });

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title || 'Unknown title',
        artist: t.artist || 'Unknown artist',
        album: t.album || '',
        artwork: art,
      });
    } catch { /* older WebKit */ }

    const handlers = {
      play: () => this.resume(),
      pause: () => this.pause(),
      previoustrack: () => this.previous(),
      nexttrack: () => this.next(),
      seekbackward: (d) => this.seekBy(-(d && d.seekOffset ? d.seekOffset : 15)),
      seekforward: (d) => this.seekBy(d && d.seekOffset ? d.seekOffset : 15),
      seekto: (d) => { if (d && d.seekTime != null) this.seek(d.seekTime); },
      stop: () => this.pause(),
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
    }
  }

  /* --------------------------------------------------------- persistence */

  snapshot() {
    return {
      queue: this.queue,
      baseQueue: this.baseQueue,
      index: this.index,
      position: this.currentTime,
      shuffle: this.shuffle,
      repeat: this.repeat,
    };
  }

  /** Restore the last session without starting playback. */
  async restore(state) {
    if (!state || !state.queue || !state.queue.length) return;
    this.queue = state.queue;
    this.baseQueue = state.baseQueue || state.queue.slice();
    this.index = Math.min(Math.max(0, state.index || 0), this.queue.length - 1);
    this.shuffle = !!state.shuffle;
    this.repeat = state.repeat || REPEAT.OFF;

    const track = await db.getTrack(this.queue[this.index]);
    if (!track) { this.queue = []; this.index = -1; return; }

    this.current = track;
    const url = await this._urlFor(track.id);
    if (url) {
      const media = this.media;
      media.src = url;
      media.load();
      if (state.position > 0) {
        media.addEventListener('loadedmetadata', () => { try { media.currentTime = state.position; } catch { /* not seekable */ } }, { once: true });
      }
    }

    this._emitQueue();
    this.dispatchEvent(new CustomEvent('trackchange', { detail: { track } }));
    this._updateMediaSession();
    this._startTicking();
  }
}

function shuffled(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function dbToGain(value) {
  return Math.pow(10, value / 20);
}

export const player = new Player();
