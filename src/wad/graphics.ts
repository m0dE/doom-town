// Patch (column/post) decoding, texture composition, flats.
// Pictures are stored row-major, 2 bytes per pixel: palette index, opacity (0/255).
import type { Wad } from './wad';
import { parsePnames, parseTextureLump, type TextureDef } from './texturedefs';

export interface Picture {
  width: number;
  height: number;
  /** patch offsets (sprites: leftoffset/topoffset); 0 for textures and flats */
  left: number;
  top: number;
  /** width*height*2: [index, alpha] */
  data: Uint8Array;
}

/** Decodes a Doom patch (picture format with column posts). Tall patches (DeePsea) supported. */
export function decodePatch(lump: Uint8Array): Picture {
  const dv = new DataView(lump.buffer, lump.byteOffset, lump.byteLength);
  const width = dv.getUint16(0, true);
  const height = dv.getUint16(2, true);
  const left = dv.getInt16(4, true);
  const top = dv.getInt16(6, true);
  const data = new Uint8Array(width * height * 2);
  for (let x = 0; x < width; x++) {
    let p = dv.getUint32(8 + x * 4, true);
    let lastTop = -1;
    while (p < lump.length) {
      let topdelta = lump[p];
      if (topdelta === 0xff) break;
      // tall patch convention: a delta <= previous one is relative
      if (topdelta <= lastTop) topdelta += lastTop;
      lastTop = topdelta;
      const len = lump[p + 1];
      p += 3; // skip unused byte
      for (let i = 0; i < len; i++) {
        const y = topdelta + i;
        if (y >= 0 && y < height) {
          const o = (y * width + x) * 2;
          data[o] = lump[p + i];
          data[o + 1] = 255;
        }
      }
      p += len + 1; // + unused byte
    }
  }
  return { width, height, left, top, data };
}

export function isPatch(lump: Uint8Array): boolean {
  if (lump.length < 8) return false;
  const dv = new DataView(lump.buffer, lump.byteOffset, lump.byteLength);
  const w = dv.getUint16(0, true), h = dv.getUint16(2, true);
  if (w === 0 || h === 0 || w > 4096 || h > 4096 || 8 + w * 4 > lump.length) return false;
  for (let x = 0; x < w; x++) if (dv.getUint32(8 + x * 4, true) >= lump.length) return false;
  return true;
}

export function flatPicture(lump: Uint8Array): Picture {
  const data = new Uint8Array(64 * 64 * 2);
  for (let i = 0; i < 4096; i++) { data[i * 2] = lump[i] ?? 0; data[i * 2 + 1] = 255; }
  return { width: 64, height: 64, left: 0, top: 0, data };
}

/**
 * Texture definitions from every TEXTURE1/TEXTURE2 in the WAD stack, each resolved
 * with the PNAMES of its own file; later files override by texture name.
 */
export function textureDefs(wad: Wad): Map<string, TextureDef> {
  const out = new Map<string, TextureDef>();
  const pn = wad.all('PNAMES');
  for (const tl of [...wad.all('TEXTURE1'), ...wad.all('TEXTURE2')].sort((a, b) => a.source - b.source)) {
    const p = pn.filter((l) => l.source === tl.source).pop() ?? pn[pn.length - 1];
    if (!p) continue;
    for (const d of parseTextureLump(tl.data, parsePnames(p.data))) out.set(d.name, d);
  }
  return out;
}

/** Composes a wall texture from its patches (transparent where no patch covers). */
export function composeTexture(def: TextureDef, getPatch: (name: string) => Picture | null): Picture {
  const { width, height } = def;
  const data = new Uint8Array(width * height * 2);
  for (const ref of def.patches) {
    const p = getPatch(ref.patch);
    if (!p) continue;
    for (let py = 0; py < p.height; py++) {
      const y = ref.originY + py;
      if (y < 0 || y >= height) continue;
      for (let px = 0; px < p.width; px++) {
        const x = ref.originX + px;
        if (x < 0 || x >= width) continue;
        const s = (py * p.width + px) * 2;
        if (!p.data[s + 1]) continue;
        const d = (y * width + x) * 2;
        data[d] = p.data[s];
        data[d + 1] = 255;
      }
    }
  }
  return { width, height, left: 0, top: 0, data };
}

/** Caching patch loader over a WAD (patch namespace first, then any lump). */
export function patchLoader(wad: Wad): (name: string) => Picture | null {
  const cache = new Map<string, Picture | null>();
  return (name: string) => {
    const key = name.toUpperCase();
    if (cache.has(key)) return cache.get(key)!;
    const l = wad.nsLump('P', key) ?? wad.nsLump('S', key);
    const pic = l && isPatch(l.data) ? decodePatch(l.data) : null;
    cache.set(key, pic);
    return pic;
  };
}
