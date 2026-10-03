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

  setVolume(v: number): void { this.bank?.setVolume(v); }

  dispose(): void { try { this.bank?.dispose(); } catch { /* closed */ } }
}
