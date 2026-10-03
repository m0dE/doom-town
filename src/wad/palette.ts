// PLAYPAL (14 palettes × 256 RGB) and COLORMAP (34 light maps × 256 indices).
import type { Wad } from './wad';

export const NUM_PALETTES = 14;
export const NUM_COLORMAPS = 34; // 0..31 light levels, 32 invulnerability, 33 all-black
export const INVERSE_COLORMAP = 32;
/** palette numbers used by ST_doPaletteStuff */
export const STARTREDPALS = 1, NUMREDPALS = 8, STARTBONUSPALS = 9, NUMBONUSPALS = 4, RADIATIONPAL = 13;

export interface PaletteData {
  /** 14 × 768 bytes RGB */
  playpal: Uint8Array;
  /** 34 × 256 palette indices */
  colormap: Uint8Array;
}

export function readPalette(wad: Wad): PaletteData {
  const playpal = wad.get('PLAYPAL');
  const colormap = wad.get('COLORMAP');
  if (!playpal || !colormap) throw new Error('WAD lacks PLAYPAL/COLORMAP');
  const pp = new Uint8Array(NUM_PALETTES * 768);
  pp.set(playpal.subarray(0, Math.min(playpal.length, pp.length)));
  for (let p = Math.floor(playpal.length / 768); p < NUM_PALETTES; p++) pp.set(playpal.subarray(0, 768), p * 768);
  const cm = new Uint8Array(NUM_COLORMAPS * 256);
  cm.set(colormap.subarray(0, Math.min(colormap.length, cm.length)));
  return { playpal: pp, colormap: cm };
}

/** RGB of palette index `i` in palette `pal` (0..13). */
export function paletteRGB(p: PaletteData, i: number, pal = 0): [number, number, number] {
  const o = pal * 768 + i * 3;
  return [p.playpal[o], p.playpal[o + 1], p.playpal[o + 2]];
}

/** Nearest palette index to an RGB color (palette 0), optionally limited to a range. */
export function nearestIndex(p: PaletteData, r: number, g: number, b: number, exclude?: (i: number) => boolean): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < 256; i++) {
    if (exclude && exclude(i)) continue;
    const dr = p.playpal[i * 3] - r, dg = p.playpal[i * 3 + 1] - g, db = p.playpal[i * 3 + 2] - b;
    // weighted (redmean-ish) distance keeps hues closer than plain RGB
    const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/**
 * The palette Doom's status bar code would pick (ST_doPaletteStuff): red when hurt or
 * berserk, gold on pickups, green with the radiation suit.
 */
export function screenPalette(damagecount: number, bonuscount: number, strengthTics: number, ironfeetTics: number): number {
  let cnt = damagecount;
  if (strengthTics) {
    const bzc = 12 - (strengthTics >> 6);
    if (bzc > cnt) cnt = bzc;
  }
  if (cnt > 0) {
    let pal = (cnt + 7) >> 3;
    if (pal >= NUMREDPALS) pal = NUMREDPALS - 1;
    return pal + STARTREDPALS;
  }
  if (bonuscount > 0) {
    let pal = (bonuscount + 7) >> 3;
    if (pal >= NUMBONUSPALS) pal = NUMBONUSPALS - 1;
    return pal + STARTBONUSPALS;
  }
  if (ironfeetTics > 4 * 32 || (ironfeetTics & 8)) return RADIATIONPAL;
  return 0;
}
