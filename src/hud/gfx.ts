/**
 * Doom patches as canvases: palette-correct, optionally colour-translated,
 * cached. What the start screen's marine, its logo and the status bar draw
 * with. Decoding is the WAD module's (`decodePatch`); this only paints.
 */
import { decodePatch, readPalette, type PaletteData, type Wad } from '../wad/index.js';

export interface Patch {
  name: string;
  width: number;
  height: number;
  /** Doom's offsets: the patch is drawn at (x - left, y - top). */
  left: number;
  top: number;
  canvas: HTMLCanvasElement;
  /** The same pixels as RGBA, so a recolour never reads a canvas back (slow on GPU-backed canvases). */
  rgba: Uint8ClampedArray;
}

export class Gfx {
  readonly pal: PaletteData;
  private readonly cache = new Map<string, Patch | null>();

  constructor(readonly wad: Wad) {
    this.pal = readPalette(wad);
  }

  has(name: string): boolean { return this.wad.has(name); }

  /** A patch by lump name, translated by `translation` (256 entries) when given. Null if missing or broken. */
  patch(name: string, translation?: Uint8Array, key = ''): Patch | null {
    const id = `${name}|${key}`;
    const hit = this.cache.get(id);
    if (hit !== undefined) return hit;
    let p: Patch | null = null;
    const lump = this.wad.nsLump('S', name)?.data ?? this.wad.get(name);
    if (lump && lump.length >= 8) {
      try { p = this.paint(name, lump, translation); } catch { p = null; }
    }
    this.cache.set(id, p);
    return p;
  }

  private paint(name: string, lump: Uint8Array, tr?: Uint8Array): Patch {
    const pic = decodePatch(lump);
    const { width: w, height: h } = pic;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    const px = img.data, pal = this.pal.playpal, src = pic.data;
    for (let i = 0, n = w * h; i < n; i++) {
      if (!src[i * 2 + 1]) continue;
      const c = tr ? tr[src[i * 2]] : src[i * 2];
      px[i * 4] = pal[c * 3]; px[i * 4 + 1] = pal[c * 3 + 1]; px[i * 4 + 2] = pal[c * 3 + 2]; px[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return { name, width: w, height: h, left: pic.left, top: pic.top, canvas, rgba: img.data };
  }

  /**
   * A sprite frame for a rotation (1..8), the way R_InitSprites names them:
   * `PLAYA1`, or `PLAYA2A8` serving rotation 2 and, mirrored, 8; `PLAYH0` for all.
   */
  spriteFrame(sprite: string, frame: string, rot: number, translation?: Uint8Array, key = ''): { patch: Patch; flip: boolean } | null {
    const ns = this.wad.namespace('S');
    const names: Iterable<string> = ns.size ? ns.keys() : this.wad.lumps.map((l) => l.name);
    let flipHit: string | null = null, zero: string | null = null;
    for (const n of names) {
      if (!n.startsWith(sprite)) continue;
      if (n[4] === frame && n[5] === String(rot)) return this.wrap(n, false, translation, key);
      if (n.length >= 8 && n[6] === frame && n[7] === String(rot)) flipHit = n;
      if (n[4] === frame && n[5] === '0') zero = n;
    }
    if (flipHit) return this.wrap(flipHit, true, translation, key);
    if (zero) return this.wrap(zero, false, translation, key);
    return null;
  }

  private wrap(n: string, flip: boolean, tr: Uint8Array | undefined, key: string): { patch: Patch; flip: boolean } | null {
    const p = this.patch(n, tr, key);
    return p ? { patch: p, flip } : null;
  }
}
