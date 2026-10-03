// Doom sound effects: DMX lumps → AudioBuffers, positional playback with Doom's
// distance attenuation and stereo separation (s_sound.c S_AdjustSoundParams), and a
// voice limit sized for 100 players (Doom's 8 channels are too few).
import { SOUND_NAMES, decodeDmx, soundNum, type Wad } from '../wad';

/** s_sound.c constants (map units) */
export const S_CLIPPING_DIST = 1200;
export const S_CLOSE_DIST = 160;
const S_ATTENUATOR = S_CLIPPING_DIST - S_CLOSE_DIST;
const S_STEREO_SWING = 96;

export interface SoundOrigin { x: number; y: number; z?: number }

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
  origin: SoundOrigin | null;
  key: unknown;
  sfx: number;
  /** 0..1 base volume (before distance) */
  vol: number;
  /** current effective volume (for voice stealing) */
  level: number;
  start: number;
}

export interface PlayOptions {
  /** 0..127 like Doom (default 127) */
  volume?: number;
  /**
   * One sound per key at a time (Doom: one per origin mobj); a new sound with the same
   * key stops the old one. Defaults to the origin object itself.
   */
  key?: unknown;
  /** playback-rate jitter (Doom 1.2 pitch shifting), 0 = off */
  pitchJitter?: number;
}

export class SoundBank {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  private buffers: (AudioBuffer | null)[] = [];
  private voices: Voice[] = [];
  private lx = 0;
  private ly = 0;
  private langle = 0;
  private unlocked = false;
  /** simultaneous voices (oldest/quietest is dropped beyond this) */
  maxVoices: number;

  constructor(wad: Wad, opts: { maxVoices?: number; context?: AudioContext } = {}) {
    this.ctx = opts.context ?? new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);
    this.maxVoices = opts.maxVoices ?? 32;
    SOUND_NAMES.forEach((name, i) => {
      this.buffers[i] = null;
      if (!name) return;
      const lump = wad.get('DS' + name.toUpperCase());
      const pcm = lump ? decodeDmx(lump) : null;
      if (!pcm || !pcm.samples.length) return;
      const buf = this.ctx.createBuffer(1, pcm.samples.length, Math.max(3000, Math.min(96000, pcm.rate)));
      buf.copyToChannel(pcm.samples as Float32Array<ArrayBuffer>, 0);
      this.buffers[i] = buf;
    });
  }

  /** Resumes the AudioContext on the first user gesture (browsers start it suspended). */
  unlock(target: EventTarget = window): void {
    if (this.unlocked) return;
    const go = () => {
      void this.ctx.resume().then(() => {
        this.unlocked = true;
        for (const ev of ['pointerdown', 'keydown', 'touchstart']) target.removeEventListener(ev, go, true);
      });
    };
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) target.addEventListener(ev, go, true);
    if (this.ctx.state === 'running') this.unlocked = true;
  }

  setVolume(v: number): void { this.master.gain.value = Math.max(0, v); }

  /** Listener position and facing (radians, Doom convention). Call every frame. */
  setListener(x: number, y: number, angle: number): void {
    this.lx = x; this.ly = y; this.langle = angle;
  }

  has(sfx: number | string): boolean {
    const id = typeof sfx === 'number' ? sfx : soundNum(sfx);
    return !!this.buffers[id];
  }

  /**
   * Plays sfx (id in Doom's S_sfx order, or name like "pistol"/"DSPISTOL").
   * `origin` null = non-positional (the local player's own sounds). The origin object
   * is re-read on update(), so passing a live mobj makes the sound follow it.
   */
  play(sfx: number | string, origin: SoundOrigin | null = null, opts: PlayOptions = {}): void {
    const id = typeof sfx === 'number' ? sfx : soundNum(sfx);
    const buf = this.buffers[id];
    if (!buf || this.ctx.state !== 'running') return;
    const vol = Math.max(0, Math.min(127, opts.volume ?? 127)) / 127;
    const key = opts.key ?? origin;
    const [level, pan] = this.params(origin, vol);
    if (level <= 0) return;
    // one sound per origin
    if (key != null) {
      for (let i = this.voices.length - 1; i >= 0; i--) if (this.voices[i].key === key) this.stopVoice(i);
    }
    if (this.voices.length >= this.maxVoices) {
      // steal the quietest (then oldest) voice if the new one is louder
      let w = 0;
      for (let i = 1; i < this.voices.length; i++) {
        const a = this.voices[i], b = this.voices[w];
        if (a.level < b.level || (a.level === b.level && a.start < b.start)) w = i;
      }
      if (this.voices[w].level > level) return;
      this.stopVoice(w);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    if (opts.pitchJitter) src.playbackRate.value = 1 + (Math.random() * 2 - 1) * opts.pitchJitter;
    const gain = this.ctx.createGain();
    gain.gain.value = level;
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(gain).connect(p).connect(this.master);
    const v: Voice = { src, gain, pan: p, origin, key, sfx: id, vol, level, start: this.ctx.currentTime };
    src.onended = () => {
      const i = this.voices.indexOf(v);
      if (i >= 0) { this.voices.splice(i, 1); this.disconnect(v); }
    };
    this.voices.push(v);
    src.start();
  }

  /** Stops sounds with this key (or origin). */
  stop(key: unknown): void {
    for (let i = this.voices.length - 1; i >= 0; i--) if (this.voices[i].key === key) this.stopVoice(i);
  }

  stopAll(): void {
    for (let i = this.voices.length - 1; i >= 0; i--) this.stopVoice(i);
  }

  /** Re-attenuates playing positional sounds for the current listener (S_UpdateSounds). */
  update(): void {
    const t = this.ctx.currentTime;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (!v.origin) continue;
      const [level, pan] = this.params(v.origin, v.vol);
      if (level <= 0) { this.stopVoice(i); continue; }
      v.level = level;
      v.gain.gain.setTargetAtTime(level, t, 0.02);
      v.pan.pan.setTargetAtTime(pan, t, 0.02);
    }
  }

  get activeVoices(): number { return this.voices.length; }

  dispose(): void {
    this.stopAll();
    this.master.disconnect();
    void this.ctx.close();
  }

  /** Doom's S_AdjustSoundParams: approximate distance, linear falloff, ±96/128 separation. */
  private params(o: SoundOrigin | null, vol: number): [number, number] {
    if (!o) return [vol, 0];
    const adx = Math.abs(this.lx - o.x), ady = Math.abs(this.ly - o.y);
    const dist = adx + ady - Math.min(adx, ady) / 2;
    if (dist > S_CLIPPING_DIST) return [0, 0];
    const level = dist < S_CLOSE_DIST ? vol : (vol * (S_CLIPPING_DIST - dist)) / S_ATTENUATOR;
    if (dist < 1) return [level, 0];
    const rel = Math.atan2(o.y - this.ly, o.x - this.lx) - this.langle;
    // sep = 128 - 96*sin(rel): positive sin (source to the left) pans left
    const pan = -(S_STEREO_SWING / 128) * Math.sin(rel);
    return [level, pan];
  }

  private stopVoice(i: number): void {
    const v = this.voices[i];
    this.voices.splice(i, 1);
    v.src.onended = null;
    try { v.src.stop(); } catch { /* already stopped */ }
    this.disconnect(v);
  }

  private disconnect(v: Voice): void {
    v.src.disconnect(); v.gain.disconnect(); v.pan.disconnect();
  }
}
