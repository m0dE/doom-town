// Player color translations: Doom remaps the green ramp 0x70..0x7F of player sprites
// (R_InitTranslationTables: gray 0x60, brown 0x40, red 0x20). We keep those three and
// generate more hues by matching each green shade's brightness with a tinted color and
// picking the nearest palette entry, so every translation is a pure palette remap.
import { nearestIndex, type PaletteData } from './palette';

export interface PlayerColor { name: string; /** representative CSS color for UI */ css: string; base?: [number, number, number]; ramp?: number }

/** Translation 0 is "no translation" (Doom green). */
export const PLAYER_COLORS: readonly PlayerColor[] = [
  { name: 'green', css: '#4fc33f' },
  { name: 'indigo', css: '#8b8b8b', ramp: 0x60 },
  { name: 'brown', css: '#a3754f', ramp: 0x40 },
  { name: 'red', css: '#d33b3b', ramp: 0x20 },
  { name: 'blue', css: '#3f5fff', base: [70, 90, 255] },
  { name: 'yellow', css: '#f0e040', base: [255, 235, 60] },
  { name: 'orange', css: '#ff8a20', base: [255, 140, 30] },
  { name: 'purple', css: '#9a40d0', base: [165, 70, 225] },
  { name: 'cyan', css: '#40e0e0', base: [70, 235, 235] },
  { name: 'pink', css: '#ff80c0', base: [255, 130, 190] },
  { name: 'white', css: '#f0f0f0', base: [250, 250, 250] },
  { name: 'black', css: '#303030', base: [90, 90, 90] },
  { name: 'teal', css: '#20a090', base: [40, 175, 155] },
  { name: 'magenta', css: '#e040e0', base: [235, 60, 235] },
  { name: 'tan', css: '#d8b888', base: [225, 190, 140] },
  { name: 'olive', css: '#8a8a30', base: [150, 150, 55] },
  { name: 'navy', css: '#283c90', base: [45, 65, 160] },
  { name: 'maroon', css: '#801c1c', base: [140, 35, 35] },
  { name: 'gold', css: '#e0b020', base: [235, 185, 40] },
  { name: 'sky', css: '#80b8ff', base: [135, 190, 255] },
];

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** N × 256 remap tables (row t maps palette index → palette index). */
export function buildTranslations(pal: PaletteData): Uint8Array {
  const n = PLAYER_COLORS.length;
  const out = new Uint8Array(n * 256);
  for (let t = 0; t < n; t++) {
    const row = out.subarray(t * 256, t * 256 + 256);
    for (let i = 0; i < 256; i++) row[i] = i;
    const c = PLAYER_COLORS[t];
    if (c.ramp !== undefined) {
      for (let j = 0; j < 16; j++) row[0x70 + j] = c.ramp + j;
    } else if (c.base) {
      const [br, bg, bb] = c.base;
      const bl = Math.max(1, lum(br, bg, bb));
      for (let j = 0; j < 16; j++) {
        const gi = (0x70 + j) * 3;
        // green ramp shades are very saturated: use a slightly boosted brightness
        const target = lum(pal.playpal[gi], pal.playpal[gi + 1], pal.playpal[gi + 2]) * 1.15;
        let r: number, g: number, b: number;
        if (target <= bl) { const k = target / bl; r = br * k; g = bg * k; b = bb * k; }
        else { const k = Math.min(1, (target - bl) / Math.max(1, 255 - bl)); r = br + (255 - br) * k; g = bg + (255 - bg) * k; b = bb + (255 - bb) * k; }
        row[0x70 + j] = nearestIndex(pal, r, g, b, (i) => i >= 0x70 && i < 0x80);
      }
    }
  }
  return out;
}
