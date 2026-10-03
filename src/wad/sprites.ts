// Sprite frame table (R_InitSpriteDefs): lump names NAME<frame><rot>[<frame><rot>].
import type { Wad } from './wad';

export interface SpriteRotation { lump: string; flip: boolean }
export interface SpriteFrame {
  /** true when rotation 0 (one picture for all angles) */
  rotate: boolean;
  /** 8 entries (or 1 when !rotate) */
  rotations: SpriteRotation[];
}
export type SpriteDef = SpriteFrame[]; // indexed by frame number (A=0)

/** Builds sprite definitions for `names` (Doom's sprnames order) from the S_ namespace. */
export function buildSpriteDefs(wad: Wad, names: readonly string[]): SpriteDef[] {
  const byPrefix = new Map<string, string[]>();
  for (const name of wad.namespace('S').keys()) {
    const k = name.slice(0, 4);
    let a = byPrefix.get(k);
    if (!a) byPrefix.set(k, (a = []));
    a.push(name);
  }
  return names.map((sn) => {
    const frames: SpriteDef = [];
    const install = (lump: string, frame: number, rot: number, flip: boolean) => {
      if (frame < 0 || frame > 28) return;
      let f = frames[frame];
      if (!f) f = frames[frame] = { rotate: rot !== 0, rotations: [] };
      if (rot === 0) {
        f.rotate = false;
        f.rotations = [{ lump, flip }];
      } else {
        if (!f.rotate) { f.rotate = true; f.rotations = []; }
        f.rotations[rot - 1] = { lump, flip };
      }
    };
    for (const lump of byPrefix.get(sn) ?? []) {
      install(lump, lump.charCodeAt(4) - 65, lump.charCodeAt(5) - 48, false);
      if (lump.length >= 8) install(lump, lump.charCodeAt(6) - 65, lump.charCodeAt(7) - 48, true);
    }
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (!f) continue;
      if (f.rotate) for (let r = 0; r < 8; r++) if (!f.rotations[r]) f.rotations[r] = f.rotations.find(Boolean)!;
    }
    return frames;
  });
}
