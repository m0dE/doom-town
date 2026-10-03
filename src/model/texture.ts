/**
 * The marine model's texture atlas, built from the player sprite's own pixels.
 *
 * Every box face names a rectangle of a PLAY* sprite lump (front faces from
 * rotation 1, backs from rotation 5, sides from rotation 3, mirrored for 7) and
 * the colour classes that belong on it. Pixels outside those classes (an arm
 * painted over the chest, the gun across the belly, the background) become
 * holes, and holes take the nearest kept pixel, so a face is the sprite's paint
 * with the occluders lifted off. The rectangle is then resampled, nearest, to
 * the face's size in map units: one texel per sprite pixel, give or take.
 *
 * Tops and bottoms are not in any sprite; each of their texels copies the
 * nearest side face's edge pixel (bottoms one shade darker via COLORMAP).
 *
 * The atlas keeps palette indices (one byte per texel), not colours, so the
 * shader can apply a player translation and Doom's light tables to it.
 */
import { decodePatch, type Picture, type Wad, type PaletteData } from '../wad/index.js';

/** A rectangle of a sprite lump: [x0, y0, x1, y1), in sprite pixels. */
export type Rect = readonly [number, number, number, number];

export interface FaceSource {
  /** sprite lump, e.g. 'PLAYA1' */
  l: string;
  r: Rect;
  /** mirror horizontally (rotation 7 is rotation 3 mirrored) */
  flip?: boolean;
  /**
   * colour classes kept from the sprite (others are holes): G green ramp,
   * S skin, A gray, K near-black, B blue (visor), R blood reds, '*' anything.
   */
  keep?: string;
  /** fill the face with a hash-scattered choice of the rect's blood-red pixels (pool, gore bits) */
  scatter?: boolean;
}

/**
 * A painted face: the palette colour nearest `paint` (sRGB 0..255), in blocky shade
 * noise (low-poly flat colour, a little texture). `green`: stay in the green ramp
 * 0x70..0x7F, which the player colour translations remap (the suit).
 */
export interface PaintSpec { paint: readonly [number, number, number]; green?: boolean }

/** Source for a face: a sprite rectangle, a painted colour, a solid palette index, or derived (tops and bottoms). */
export type FaceSpec = FaceSource | PaintSpec | number | 'derive';

/** Nearest palette index to an sRGB colour (optionally among `allow`ed indices). */
export function nearestPal(pal: PaletteData, r: number, g: number, b: number, allow?: (i: number) => boolean): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < 256; i++) {
    if (allow && !allow(i)) continue;
    const dr = pal.playpal[i * 3] - r, dg = pal.playpal[i * 3 + 1] - g, db = pal.playpal[i * 3 + 2] - b;
    // weighted toward green like the eye
    const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** A painted face image `w`×`h`: 2×2-texel blocks of the colour, a few a shade darker. */
export function paintRect(pal: PaletteData, spec: PaintSpec, w: number, h: number, seed: number): IndexImage {
  const allow = spec.green ? (i: number) => i >= 0x70 && i <= 0x7f : (i: number) => i !== 0 && !(i >= 0x70 && i <= 0x7f);
  const [r, g, b] = spec.paint;
  // mostly the flat colour, some blocks one or two COLORMAP rows darker: a low-poly look, not camouflage
  const base = nearestPal(pal, r, g, b, allow);
  const shades = [base, base, base, base, base, shadeIndex(pal, base, 1), shadeIndex(pal, base, 2)];
  const px = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let x = Math.imul((i >> 1) + 1, 0x9e3779b1) ^ Math.imul((j >> 1) + 7, 0x85ebca6b) ^ Math.imul(seed + 3, 0xc2b2ae35);
      x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d); x ^= x >>> 12;
      px[j * w + i] = shades[(x >>> 0) % shades.length];
    }
  }
  return { w, h, px };
}

const CLASSES: Record<string, (i: number) => boolean> = {
  G: (i) => i >= 0x70 && i <= 0x7f,
  S: (i) => i >= 0x30 && i <= 0x4f,
  A: (i) => (i >= 0x50 && i <= 0x6f) || i === 0x03,
  K: (i) => i <= 0x0f && i !== 0x03,
  B: (i) => i >= 0xc0 && i <= 0xcf,
  R: (i) => (i >= 0x20 && i <= 0x2f) || (i >= 0xb0 && i <= 0xbf),
  '*': () => true,
};

function keeper(keep: string | undefined): (i: number) => boolean {
  const fs = [...(keep ?? '*')].map((c) => CLASSES[c]).filter(Boolean);
  return (i) => fs.some((f) => f(i));
}

/** An image of palette indices. */
export interface IndexImage { w: number; h: number; px: Uint8Array }

export class SpriteSource {
  private cache = new Map<string, Picture>();
  constructor(private readonly wad: Wad) {}
  /**
   * The game's own lump (first file loaded), so a player's DOOM2.WAD art override
   * cannot misalign the hand-picked rectangles below; falls back to any.
   */
  pic(name: string): Picture {
    let p = this.cache.get(name);
    if (!p) {
      const l = this.wad.lumps.find((x) => x.name === name && x.source === 0 && x.data.length) ?? this.wad.lump(name);
      if (!l) throw new Error(`model: sprite ${name} missing`);
      p = decodePatch(l.data);
      this.cache.set(name, p);
    }
    return p;
  }
}

/**
 * Cuts a sprite rectangle, lifts out the pixels not in `keep`, and fills every
 * hole from the nearest kept pixel (breadth-first, so fills are Voronoi-ish and
 * keep the neighbouring shading rather than smearing one colour).
 */
export function cutRect(src: SpriteSource, s: FaceSource, fallback = 0x6c): IndexImage {
  const p = src.pic(s.l);
  const [x0, y0, x1, y1] = s.r;
  const w = x1 - x0, h = y1 - y0;
  const px = new Uint8Array(w * h);
  const ok = new Uint8Array(w * h);
  const keepF = keeper(s.keep);
  const queue: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = s.flip ? x1 - 1 - x : x0 + x, sy = y0 + y;
      if (sx < 0 || sy < 0 || sx >= p.width || sy >= p.height) continue;
      const o = (sy * p.width + sx) * 2;
      if (!p.data[o + 1] || !keepF(p.data[o])) continue;
      px[y * w + x] = p.data[o];
      ok[y * w + x] = 1;
      queue.push(y * w + x);
    }
  }
  if (!queue.length) { px.fill(fallback); return { w, h, px }; }
  for (let qi = 0; qi < queue.length; qi++) {
    const k = queue[qi], x = k % w, y = (k / w) | 0;
    const nb = [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1];
    for (const n of nb) {
      if (n < 0 || ok[n]) continue;
      ok[n] = 1;
      px[n] = px[k];
      queue.push(n);
    }
  }
  return { w, h, px };
}

/** Nearest-neighbour resample to w×h. */
export function resample(img: IndexImage, w: number, h: number): IndexImage {
  if (img.w === w && img.h === h) return img;
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.h - 1, Math.floor(((y + 0.5) * img.h) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.w - 1, Math.floor(((x + 0.5) * img.w) / w));
      px[y * w + x] = img.px[sy * img.w + sx];
    }
  }
  return { w, h, px };
}

/** Darkens a palette index by `rows` light levels through COLORMAP (stays in the palette). */
export function shadeIndex(pal: PaletteData, i: number, rows: number): number {
  return pal.colormap[Math.max(0, Math.min(31, rows)) * 256 + i];
}

/** Rectangle of the atlas a face occupies (texel units, excluding the 1-texel pad). */
export interface AtlasRect { x: number; y: number; w: number; h: number }

/**
 * Shelf-packs face images into one atlas with a 1-texel border that repeats
 * each image's edge, so nearest sampling at a face's edge never bleeds.
 */
export function packAtlas(images: IndexImage[], width = 128): { w: number; h: number; data: Uint8Array; rects: AtlasRect[] } {
  const order = images.map((_, i) => i).sort((a, b) => images[b].h - images[a].h || images[b].w - images[a].w);
  const rects: AtlasRect[] = new Array(images.length);
  let x = 0, y = 0, rowH = 0;
  for (const i of order) {
    const im = images[i];
    const W = im.w + 2, H = im.h + 2;
    if (x + W > width) { x = 0; y += rowH; rowH = 0; }
    rects[i] = { x: x + 1, y: y + 1, w: im.w, h: im.h };
    x += W;
    rowH = Math.max(rowH, H);
  }
  let h = 1;
  while (h < y + rowH) h *= 2;
  const data = new Uint8Array(width * h);
  images.forEach((im, i) => {
    const r = rects[i];
    for (let yy = -1; yy <= im.h; yy++) {
      for (let xx = -1; xx <= im.w; xx++) {
        const sx = Math.max(0, Math.min(im.w - 1, xx)), sy = Math.max(0, Math.min(im.h - 1, yy));
        data[(r.y + yy) * width + r.x + xx] = im.px[sy * im.w + sx];
      }
    }
  });
  return { w: width, h, data, rects };
}
