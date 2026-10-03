// GPU-side asset tables built from the WAD: palette/colormap lookup, translations,
// a palette-index atlas for wall textures + flats, a sprite atlas, and the tables that
// map names → ids → atlas rectangles (with animation translation).
import * as THREE from 'three';
import {
  ANIMDEFS, SKY_FLAT, SPRITE_NAMES, SWITCHES, buildSpriteDefs, buildTranslations, composeTexture, flatPicture,
  decodePatch, isPatch, patchLoader, readPalette, textureDefs, NUM_COLORMAPS, NUM_PALETTES,
  type PaletteData, type Picture, type SpriteDef, type Wad,
} from '../wad';

export interface AtlasRect { x: number; y: number; w: number; h: number }

/** Shelf packer; returns rects and the atlas height used. */
function pack(sizes: { w: number; h: number }[], width: number): { rects: AtlasRect[]; height: number } {
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[b].h - sizes[a].h || sizes[b].w - sizes[a].w || a - b);
  const rects: AtlasRect[] = new Array(sizes.length);
  let x = 0, y = 0, shelf = 0;
  for (const i of order) {
    const { w, h } = sizes[i];
    if (x + w > width) { x = 0; y += shelf; shelf = 0; }
    rects[i] = { x, y, w, h };
    x += w;
    shelf = Math.max(shelf, h);
  }
  return { rects, height: y + shelf };
}

function buildAtlas(pics: Picture[], width: number): { tex: THREE.DataTexture; rects: AtlasRect[]; width: number; height: number } {
  const { rects, height: h0 } = pack(pics.map((p) => ({ w: p.width, h: p.height })), width);
  const height = Math.max(1, h0);
  const data = new Uint8Array(width * height * 2);
  pics.forEach((p, i) => {
    const r = rects[i];
    for (let y = 0; y < p.height; y++) data.set(p.data.subarray(y * p.width * 2, (y + 1) * p.width * 2), ((r.y + y) * width + r.x) * 2);
  });
  const tex = new THREE.DataTexture(data, width, height, THREE.RGFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { tex, rects, width, height };
}

const srgbToLinear = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };

/** Wall textures that get brightmaps (bright pixels ignore sector light) and bloom. */
const GLOW_TEXTURE = /^(LITE|TLITE|TEKLITE|COMPSTA|COMPTALL|COMPUTE|COMPBLUE|COMPWERD|SW[12]COMP|EXITSIGN|PLANET|SPACEW|LITEBLU|LITERED|LITEYEL|FIREBLU|FIREWAL|FIRELAV|FIREMAG|LFALL|BFALL|SFALL)/;
/** Liquids: whole flat glows and lights the walls around it. */
const GLOW_LIQUID = /^(NUKAGE|LAVA|SLIME(09|1[0-2])|BLOOD|RROCK0[5-8])/;
/** Ceiling/floor lights: brightmapped, faint glow onto nearby walls. */
const GLOW_LIGHTFLAT = /^(TLITE|CEIL1_[23]|CEIL3_[46]|FLAT2$|FLAT17|FLAT22|GRNLITE|FLOOR1_7|CEIL5_?)/;

export interface SpriteGlow { color: [number, number, number]; /** height above the mobj origin */ z: number }

export interface SpriteLumpInfo { rect: AtlasRect; left: number; top: number }

export class RenderAssets {
  readonly pal: PaletteData;
  /** RGBA float, 256 × (14 palettes × 34 colormaps): linear color of colormap[row][index] in palette p */
  readonly palTex: THREE.DataTexture;
  readonly transTex: THREE.DataTexture;
  readonly translationCount: number;

  /** wall textures then flats share one id space */
  readonly texIds = new Map<string, number>();
  readonly flatIds = new Map<string, number>();
  readonly texCount: number;
  readonly texSize: { w: number; h: number }[] = [];
  readonly atlas: THREE.DataTexture;
  readonly atlasRects: AtlasRect[];
  /** 2 texels per id: (x, y, w, h) of the current animation frame, (glowR, glowG, glowB, flags) */
  readonly texInfo: THREE.DataTexture;
  private texInfoData: Float32Array;
  readonly texInfoWidth = 1024;
  /** per id: animation sequence (ids) and speed in tics, or null */
  private anims: { ids: number[]; speed: number }[] = [];
  readonly skyFlatId: number;
  readonly skyTexId: number;
  readonly switchPartner = new Map<number, number>();

  readonly spriteDefs: SpriteDef[];
  readonly spriteAtlas: THREE.DataTexture;
  readonly spriteAtlasSize: { w: number; h: number };
  readonly spriteLumps = new Map<string, SpriteLumpInfo>();
  /** average linear color of each sprite lump's opaque pixels (for light colors) */

  constructor(readonly wad: Wad, skyTexture: string) {
    this.pal = readPalette(wad);
    // palette × colormap → linear RGB
    const rows = NUM_PALETTES * NUM_COLORMAPS;
    const pd = new Float32Array(256 * rows * 4);
    for (let p = 0; p < NUM_PALETTES; p++) {
      for (let m = 0; m < NUM_COLORMAPS; m++) {
        for (let i = 0; i < 256; i++) {
          const ci = this.pal.colormap[m * 256 + i];
          const o = ((p * NUM_COLORMAPS + m) * 256 + i) * 4;
          const s = p * 768 + ci * 3;
          pd[o] = srgbToLinear(this.pal.playpal[s]);
          pd[o + 1] = srgbToLinear(this.pal.playpal[s + 1]);
          pd[o + 2] = srgbToLinear(this.pal.playpal[s + 2]);
          pd[o + 3] = 1;
        }
      }
    }
    this.palTex = new THREE.DataTexture(pd, 256, rows, THREE.RGBAFormat, THREE.FloatType);
    this.palTex.minFilter = this.palTex.magFilter = THREE.NearestFilter;
    this.palTex.needsUpdate = true;

    const tr = buildTranslations(this.pal);
    this.translationCount = tr.length / 256;
    this.transTex = new THREE.DataTexture(tr as Uint8Array<ArrayBuffer>, 256, this.translationCount, THREE.RedFormat, THREE.UnsignedByteType);
    this.transTex.minFilter = this.transTex.magFilter = THREE.NearestFilter;
    this.transTex.needsUpdate = true;

    // ---- wall textures + flats -------------------------------------------------
    const getPatch = patchLoader(wad);
    const defs = textureDefs(wad);
    const pics: Picture[] = [];
    const names: string[] = [];
    for (const [name, def] of defs) {
      this.texIds.set(name, pics.length);
      names.push(name);
      pics.push(composeTexture(def, getPatch));
    }
    this.texCount = pics.length;
    const flatNames = [...wad.namespace('F').keys()];
    for (const name of flatNames) {
      const l = wad.namespace('F').get(name)!;
      if (l.data.length < 4096) continue;
      this.flatIds.set(name, pics.length);
      names.push(name);
      pics.push(flatPicture(l.data));
    }
    for (const p of pics) this.texSize.push({ w: p.width, h: p.height });
    const a = buildAtlas(pics, 2048);
    this.atlas = a.tex;
    this.atlasRects = a.rects;
    this.skyFlatId = this.flatIds.get(SKY_FLAT) ?? -1;
    this.skyTexId = this.texIds.get(skyTexture) ?? this.texIds.get('SKY1') ?? -1;

    const n = pics.length;
    this.texInfoData = new Float32Array(this.texInfoWidth * Math.ceil((n * 2) / this.texInfoWidth) * 4);
    for (let id = 0; id < n; id++) {
      const name = names[id];
      const isFlat = id >= this.texCount;
      let flags = 0, glow: [number, number, number] = [0, 0, 0];
      const pic = pics[id];
      if (!isFlat && GLOW_TEXTURE.test(name)) flags |= 1; // brightmap
      if (isFlat && GLOW_LIGHTFLAT.test(name)) { flags |= 1; glow = this.avgColor(pic, true, 0.35); }
      if (isFlat && GLOW_LIQUID.test(name)) { flags |= 2; glow = this.avgColor(pic, false, 0.9); }
      const o = id * 8;
      this.texInfoData.set([0, 0, 0, 0, glow[0], glow[1], glow[2], flags], o);
      this.setFrame(id, id);
    }
    this.texInfo = new THREE.DataTexture(this.texInfoData as Float32Array<ArrayBuffer>, this.texInfoWidth, this.texInfoData.length / 4 / this.texInfoWidth, THREE.RGBAFormat, THREE.FloatType);
    this.texInfo.minFilter = this.texInfo.magFilter = THREE.NearestFilter;
    this.texInfo.needsUpdate = true;

    // animations: ranges by position (textures: TEXTURE order, flats: namespace order)
    for (const ad of ANIMDEFS) {
      const pool = ad.isTexture ? names.slice(0, this.texCount) : names.slice(this.texCount);
      const base = ad.isTexture ? 0 : this.texCount;
      const i0 = pool.indexOf(ad.first), i1 = pool.indexOf(ad.last);
      if (i0 < 0 || i1 <= i0) continue;
      const ids: number[] = [];
      for (let i = i0; i <= i1; i++) ids.push(base + i);
      for (const id of ids) this.anims[id] = { ids, speed: ad.speed };
    }
    for (const [off, on] of SWITCHES) {
      const a1 = this.texIds.get(off), b1 = this.texIds.get(on);
      if (a1 !== undefined && b1 !== undefined) { this.switchPartner.set(a1, b1); this.switchPartner.set(b1, a1); }
    }

    // ---- sprites ---------------------------------------------------------------
    this.spriteDefs = buildSpriteDefs(wad, SPRITE_NAMES);
    const lumpNames: string[] = [];
    const spics: Picture[] = [];
    for (const [name, l] of wad.namespace('S')) {
      if (!isPatch(l.data)) continue;
      lumpNames.push(name);
      spics.push(decodePatch(l.data));
    }
    const sa = buildAtlas(spics, 2048);
    this.spriteAtlas = sa.tex;
    this.spriteAtlasSize = { w: sa.width, h: sa.height };
    lumpNames.forEach((name, i) => this.spriteLumps.set(name, { rect: sa.rects[i], left: spics[i].left, top: spics[i].top }));
  }

  /** Average linear color of a picture (optionally only its bright pixels), scaled. */
  private avgColor(p: Picture, brightOnly: boolean, scale: number): [number, number, number] {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < p.width * p.height; i++) {
      if (!p.data[i * 2 + 1]) continue;
      const s = p.data[i * 2] * 3;
      const cr = srgbToLinear(this.pal.playpal[s]), cg = srgbToLinear(this.pal.playpal[s + 1]), cb = srgbToLinear(this.pal.playpal[s + 2]);
      if (brightOnly && 0.2126 * cr + 0.7152 * cg + 0.0722 * cb < 0.35) continue;
      r += cr; g += cg; b += cb; n++;
    }
    if (!n) return [0, 0, 0];
    // normalize to a saturated glow color of given strength
    const m = Math.max(r, g, b) / n || 1;
    return [(r / n / m) * scale, (g / n / m) * scale, (b / n / m) * scale];
  }

  private setFrame(id: number, frameId: number): void {
    const r = this.atlasRects[frameId];
    const o = id * 8;
    this.texInfoData[o] = r.x; this.texInfoData[o + 1] = r.y; this.texInfoData[o + 2] = r.w; this.texInfoData[o + 3] = r.h;
  }

  private lastAnimStep = -1;
  /** Doom's P_UpdateSpecials texture/flat animation: frame = (leveltime/speed + i) % numpics. */
  updateAnimations(tic: number): void {
    const step = Math.floor(tic / 8);
    if (step === this.lastAnimStep) return;
    this.lastAnimStep = step;
    let changed = false;
    this.anims.forEach((a, id) => {
      if (!a) return;
      const i = a.ids.indexOf(id);
      const f = a.ids[(Math.floor(tic / a.speed) + i) % a.ids.length];
      this.setFrame(id, f);
      changed = true;
    });
    if (changed) this.texInfo.needsUpdate = true;
  }

  textureId(name: string): number {
    if (!name || name === '-') return -1;
    return this.texIds.get(name.toUpperCase()) ?? -1;
  }
  flatId(name: string): number {
    return this.flatIds.get(name.toUpperCase()) ?? -1;
  }
  glowFlags(id: number): number { return id < 0 ? 0 : this.texInfoData[id * 8 + 7]; }

  /** Sprite lump for sprite/frame/rotation (rot 0..7), or null. */
  spriteLump(sprite: number, frame: number, rot: number): { info: SpriteLumpInfo; flip: boolean } | null {
    const def = this.spriteDefs[sprite];
    const f = def && def[frame & 0x7fff];
    if (!f) return null;
    const r = f.rotate ? f.rotations[rot] : f.rotations[0];
    if (!r) return null;
    const info = this.spriteLumps.get(r.lump);
    return info ? { info, flip: r.flip } : null;
  }

  private glowCache = new Map<number, SpriteGlow | null>();
  /**
   * Measured light of a sprite frame: luminance-weighted average color of its bright
   * pixels (normalized so the max channel is 1) and the height of their centroid above
   * the mobj origin. Frames without bright pixels borrow the color of the sprite's
   * first frame that has some.
   */
  spriteGlow(sprite: number, frame: number): SpriteGlow | null {
    const f = frame & 0x7fff;
    const key = sprite * 64 + f;
    const hit = this.glowCache.get(key);
    if (hit !== undefined) return hit;
    let out = this.measureGlow(sprite, f);
    if (!out) {
      const def = this.spriteDefs[sprite];
      for (let g = 0; def && g < def.length && !out; g++) {
        const m = g !== f ? this.measureGlow(sprite, g) : null;
        if (m) {
          const L = this.spriteLump(sprite, f, 0);
          out = { color: m.color, z: L ? L.info.top - L.info.rect.h / 2 : m.z };
        }
      }
    }
    this.glowCache.set(key, out);
    return out;
  }

  private measureGlow(sprite: number, frame: number): SpriteGlow | null {
    const L = this.spriteLump(sprite, frame, 0);
    if (!L) return null;
    const r = L.info.rect, data = this.spriteAtlas.image.data as Uint8Array, aw = this.spriteAtlasSize.w, pp = this.pal.playpal;
    let R = 0, G = 0, B = 0, W = 0, Y = 0;
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const o = ((r.y + y) * aw + r.x + x) * 2;
      if (!data[o + 1]) continue;
      const i = data[o] * 3;
      const cr = srgbToLinear(pp[i]), cg = srgbToLinear(pp[i + 1]), cb = srgbToLinear(pp[i + 2]);
      const l = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
      if (l < 0.25) continue;
      R += cr * l; G += cg * l; B += cb * l; W += l; Y += y * l;
    }
    if (W < 1) return null;
    const m = Math.max(R, G, B);
    // slightly richer than the average so colored lights read as colored
    const sat = (c: number) => Math.pow(c / m, 1.5);
    return { color: [sat(R), sat(G), sat(B)], z: L.info.top - Y / W };
  }

  dispose(): void {
    for (const t of [this.palTex, this.transTex, this.atlas, this.texInfo, this.spriteAtlas]) t.dispose();
  }
}
