/**
 * Player colours. The list and the translation tables are the WAD module's
 * (src/wad/translations.ts: Doom's green ramp 0x70..0x7f remapped, row t of
 * `buildTranslations` is colour t), so the start screen, the status bar and
 * the renderer all agree on what colour 5 is.
 *
 * A colour is an index into PLAYER_COLORS. It travels as an app message
 * (`{ n, col }`), never through the sim, so it can change at any time.
 */
import { PLAYER_COLORS, buildTranslations, type PaletteData } from '../wad/index.js';

export { PLAYER_COLORS };
export const DEFAULT_COLOR = 0;

export function clampColor(c: unknown): number {
  const n = typeof c === 'number' && Number.isInteger(c) ? c : -1;
  return n >= 0 && n < PLAYER_COLORS.length ? n : DEFAULT_COLOR;
}

let tables: Uint8Array | null = null;
let tablesFor: PaletteData | null = null;

/** A 256-entry palette translation for a colour (identity outside the green ramp). */
export function translationFor(pal: PaletteData, color: number): Uint8Array {
  if (!tables || tablesFor !== pal) { tables = buildTranslations(pal); tablesFor = pal; }
  const c = clampColor(color);
  return tables.subarray(c * 256, c * 256 + 256);
}

/** The colour a bot wears: spread across the set, fixed per slot so every client agrees. */
export function botColor(slot: number): number {
  return (slot * 7 + 3) % PLAYER_COLORS.length;
}

/** "green" → "Green". */
export function colorLabel(c: number): string {
  const n = PLAYER_COLORS[clampColor(c)].name;
  return n.charAt(0).toUpperCase() + n.slice(1);
}
