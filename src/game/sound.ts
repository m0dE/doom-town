/**
 * The game loop's seam onto src/audio's SoundBank: sim sound events in,
 * positional playback out.
 *
 * A sound from a mobj follows it: the origin object handed to the bank is
 * kept per mobj id and moved every frame to where that mobj is drawn, so the
 * bank's re-attenuation (S_UpdateSounds) hears it where it is seen. The local
 * player's own sounds are non-positional, like Doom's consoleplayer sounds.
 */
import { SoundBank } from '../audio/index.js';
import type { Wad } from '../wad/index.js';
import type { RenderMobj } from '../render/types.js';

export interface SoundOut {
  /** origin: a mobj id (0 = a fixed point); x,y in map units; vol 0..127; local = our own (non-positional). */
  play(sfx: number, origin: number, x: number, y: number, vol: number, local: boolean): void;
  /** Once per frame: the listener, and where every drawn mobj is. */
  frame(x: number, y: number, angle: number, mobjs: ArrayLike<RenderMobj>, count: number): void;
  setVolume(v: number): void;
  /** Battle royale: the storm's roar, 0 (silent) .. 1 (deep in it). */
  setStorm?(level: number): void;
  dispose(): void;
}

const SELF = { self: true };

export class GameSound implements SoundOut {
  private readonly bank: SoundBank | null;
  private readonly origins = new Map<number, { x: number; y: number }>();

  constructor(wad: Wad) {
    let bank: SoundBank | null = null;
    try { bank = new SoundBank(wad, { maxVoices: 32 }); bank.unlock(); } catch (err) { console.warn('[sound] no audio:', err); }
    this.bank = bank;
  }

  play(sfx: number, origin: number, x: number, y: number, vol: number, local: boolean): void {
    const bank = this.bank;
    if (!bank || sfx <= 0) return;
    if (local) { bank.play(sfx, null, { volume: vol, key: SELF }); return; }
    let o: { x: number; y: number };
    if (origin) {
      o = this.origins.get(origin) ?? { x, y };
      o.x = x; o.y = y;
      this.origins.set(origin, o);
    } else o = { x, y };
    bank.play(sfx, o, { volume: vol, key: origin ? o : undefined });
  }

  frame(x: number, y: number, angle: number, mobjs: ArrayLike<RenderMobj>, count: number): void {
    const bank = this.bank;
    if (!bank) return;
    bank.setListener(x, y, angle);
    if (this.origins.size) {
      for (let i = 0; i < count; i++) {
        const o = this.origins.get(mobjs[i].id);
        if (o) { o.x = mobjs[i].x; o.y = mobjs[i].y; }
      }
      // Origins whose sounds have surely ended are forgotten (Doom's longest sfx is ~3 s).
      if (this.origins.size > 256) this.origins.clear();
    }
    bank.update();
  }

  setVolume(v: number): void { this.bank?.setVolume(v); this.volume = v; if (this.storm) this.storm.out.gain.value = this.stormLevel * 0.35 * v; }

  private volume = 1;
  private stormLevel = 0;
  private storm: { src: AudioBufferSourceNode; out: GainNode } | null = null;

  /**
   * The storm loop (DESIGN.md "Storm"): generated, not a WAD sound - two seconds of
   * brown noise through a swept low-pass, looped, faded with `level`.
   */
  setStorm(level: number): void {
    const bank = this.bank;
    if (!bank) return;
    level = Math.max(0, Math.min(1, level));
    if (Math.abs(level - this.stormLevel) < 0.01 && (level > 0) === !!this.storm) return;
    this.stormLevel = level;
    const ctx = bank.ctx;
    if (!this.storm && level > 0) {
      if (ctx.state !== 'running') return;
      const n = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < n; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
      // fade the seam
      for (let i = 0; i < 2000; i++) { const k = i / 2000; d[i] *= k; d[n - 1 - i] *= k; }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 500;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.23;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 260;
      lfo.connect(lfoGain).connect(lp.frequency);
      const out = ctx.createGain();
      out.gain.value = 0;
      src.connect(lp).connect(out).connect(ctx.destination);
      src.start();
      lfo.start();
      src.onended = () => { try { lfo.stop(); } catch { /* stopped */ } };
      this.storm = { src, out };
    }
    if (this.storm) {
      this.storm.out.gain.setTargetAtTime(level * 0.35 * this.volume, ctx.currentTime, 0.25);
      if (level === 0) {
        const st = this.storm;
        this.storm = null;
        setTimeout(() => { try { st.src.stop(); } catch { /* stopped */ } }, 1500);
      }
    }
  }

  dispose(): void {
    try { this.storm?.src.stop(); } catch { /* stopped */ }
    try { this.bank?.dispose(); } catch { /* closed */ }
  }
}
