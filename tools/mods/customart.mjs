// A mod's own art (tools/mods/pack.mjs): PNG patches and flats from the mod dir, quantised
// to Doom's palette (PLAYPAL 0 of FreeDM), and composite wall textures from textures.json.
//
//   mods/<id>/textures/*.png   one patch per file, named by the file (upper-cased, <= 8
//                              chars: A-Z 0-9 _ -). Transparent pixels (alpha < 128) are
//                              holes (use them for masked mid textures: grates, fences).
//                              Height <= 254. A PNG that textures.json doesn't define also
//                              becomes a wall texture of the same name and size by itself.
//   mods/<id>/flats/*.png      64 x 64 floor/ceiling flats, named by the file (no transparency).
//   mods/<id>/textures.json    composite textures:
//                              { "MYWALL": { "width": 128, "height": 128, "patches": [
//                                  { "patch": "MYBRICK", "x": 0, "y": 0 },
//                                  { "patch": "MYSIGN", "x": 32, "y": 40 } ] } }
//                              patches may be the mod's PNGs or any Freedoom patch.
// Overriding a Freedoom patch name is an error (it would change Freedoom's own textures);
// a texture or flat of the mod may replace a Freedoom one of the same name.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const NAME_RE = /^[A-Z0-9_-]{1,8}$/;

/** Decodes a non-interlaced PNG (grey, RGB, palette, grey+alpha, RGBA; 8-bit, palette 1-8 bit) to RGBA. */
export function decodePng(buf, file = 'png') {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, i) => buf[i] === b)) throw new Error(`${file}: not a PNG`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let w = 0, h = 0, depth = 0, ct = 0, interlace = 0, plte = null, trns = null;
  const idat = [];
  for (let p = 8; p < buf.length;) {
    const len = dv.getUint32(p), type = String.fromCharCode(...buf.subarray(p + 4, p + 8)), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = d[8]; ct = d[9]; interlace = d[12]; }
    else if (type === 'PLTE') plte = d;
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (interlace) throw new Error(`${file}: interlaced PNGs are not supported (save without interlacing)`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  if (!ch || (ct !== 3 && depth !== 8) || (ct === 3 && ![1, 2, 4, 8].includes(depth))) throw new Error(`${file}: unsupported PNG (colour type ${ct}, ${depth}-bit); use 8-bit RGB/RGBA/grey or indexed`);
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (ch * depth) >> 3), stride = (w * ch * depth + 7) >> 3;
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride), up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0, b = up ? up[i] : 0, c = up && i >= bpp ? up[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[i] = v & 255;
    }
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, r = y * stride;
    if (ct === 3) {
      const i = depth === 8 ? px[r + x] : (px[r + ((x * depth) >> 3)] >> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1);
      rgba[o] = plte[i * 3]; rgba[o + 1] = plte[i * 3 + 1]; rgba[o + 2] = plte[i * 3 + 2]; rgba[o + 3] = trns && i < trns.length ? trns[i] : 255;
    } else {
      const s = r + x * ch;
      const g = px[s];
      if (ct === 0) { rgba.set([g, g, g, 255], o); }
      else if (ct === 4) { rgba.set([g, g, g, px[s + 1]], o); }
      else { rgba.set([px[s], px[s + 1], px[s + 2], ct === 6 ? px[s + 3] : 255], o); }
    }
  }
  return { w, h, rgba };
}

/** Nearest PLAYPAL index per RGB (memoised). `pal`: 768 bytes. */
export function quantiser(pal) {
  const memo = new Map();
  return (r, g, b) => {
    const k = (r << 16) | (g << 8) | b;
    let best = memo.get(k);
    if (best !== undefined) return best;
    let bd = Infinity;
    for (let i = 0; i < 256; i++) {
      const dr = pal[i * 3] - r, dg = pal[i * 3 + 1] - g, db = pal[i * 3 + 2] - b;
      const d = dr * dr * 3 + dg * dg * 4 + db * db * 2; // weighted (green counts most)
      if (d < bd) { bd = d; best = i; }
    }
    memo.set(k, best);
    return best;
  };
}

/** Doom patch (column posts; alpha < 128 is transparent). */
export function encodePatch({ w, h, rgba }, q, file = 'patch') {
  if (w < 1 || w > 4096 || h < 1 || h > 254) throw new Error(`${file}: a patch must be 1..4096 wide and 1..254 high (is ${w}x${h})`);
  const cols = [];
  for (let x = 0; x < w; x++) {
    const bytes = [];
    for (let y = 0; y < h;) {
      if (rgba[(y * w + x) * 4 + 3] < 128) { y++; continue; }
      const top = y, pix = [];
      while (y < h && rgba[(y * w + x) * 4 + 3] >= 128) { const o = (y * w + x) * 4; pix.push(q(rgba[o], rgba[o + 1], rgba[o + 2])); y++; }
      bytes.push(top, pix.length, 0, ...pix, 0);
    }
    bytes.push(255);
    cols.push(bytes);
  }
  const head = 8 + 4 * w;
  const out = new Uint8Array(head + cols.reduce((s, c) => s + c.length, 0));
  const dv = new DataView(out.buffer);
  dv.setInt16(0, w, true); dv.setInt16(2, h, true); dv.setInt16(4, 0, true); dv.setInt16(6, 0, true);
  let o = head;
  cols.forEach((c, x) => { dv.setUint32(8 + 4 * x, o, true); out.set(c, o); o += c.length; });
  return out;
}

/** Raw 64x64 flat. */
export function encodeFlat({ w, h, rgba }, q, file = 'flat') {
  if (w !== 64 || h !== 64) throw new Error(`${file}: a flat must be 64x64 (is ${w}x${h})`);
  const out = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) out[i] = q(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  return out;
}

const stem = (f) => f.replace(/\.png$/i, '').toUpperCase();
const pngs = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort() : []);

/**
 * Reads a mod dir's custom art. `palette`: PLAYPAL bytes; `isFreedoomPatch(name)`, `freedoomPatchSize(name)`
 * resolve Freedoom patches referenced from textures.json. Returns null when the dir has none, else
 * { patches: Map<name, bytes>, flats: Map<name, bytes>, textures: TextureDef[], freedoomPatches: Set<name> }.
 */
export function readCustomArt(dir, palette, isFreedoomPatch) {
  const tdir = join(dir, 'textures'), fdir = join(dir, 'flats'), tjson = join(dir, 'textures.json');
  if (!pngs(tdir).length && !pngs(fdir).length && !existsSync(tjson)) return null;
  const q = quantiser(palette);
  const patches = new Map(), sizes = new Map(), flats = new Map();
  for (const f of pngs(tdir)) {
    const n = stem(f);
    if (!NAME_RE.test(n)) throw new Error(`textures/${f}: the name must be 1-8 of A-Z 0-9 _ -`);
    if (isFreedoomPatch(n)) throw new Error(`textures/${f}: ${n} is a Freedoom patch name; rename the file (overriding it would change Freedoom's textures)`);
    const img = decodePng(readFileSync(join(tdir, f)), `textures/${f}`);
    patches.set(n, encodePatch(img, q, `textures/${f}`));
    sizes.set(n, [img.w, img.h]);
  }
  for (const f of pngs(fdir)) {
    const n = stem(f);
    if (!NAME_RE.test(n)) throw new Error(`flats/${f}: the name must be 1-8 of A-Z 0-9 _ -`);
    flats.set(n, encodeFlat(decodePng(readFileSync(join(fdir, f)), `flats/${f}`), q, `flats/${f}`));
  }
  const textures = [];
  const freedoomPatches = new Set();
  const defs = existsSync(tjson) ? JSON.parse(readFileSync(tjson, 'utf8')) : {};
  for (const [rawName, d] of Object.entries(defs)) {
    const name = rawName.toUpperCase();
    if (!NAME_RE.test(name)) throw new Error(`textures.json: texture name ${rawName} must be 1-8 of A-Z 0-9 _ -`);
    if (!d || !Number.isInteger(d.width) || !Number.isInteger(d.height) || d.width < 1 || d.height < 1 || !Array.isArray(d.patches) || !d.patches.length) throw new Error(`textures.json: ${rawName} needs integer width, height and a non-empty patches list`);
    const refs = d.patches.map((p, i) => {
      const pn = String(p.patch ?? '').toUpperCase();
      if (!patches.has(pn)) { if (isFreedoomPatch(pn)) freedoomPatches.add(pn); else throw new Error(`textures.json: ${rawName} patch ${i}: ${p.patch} is neither in textures/ nor a Freedoom patch`); }
      return { originX: Math.round(p.x ?? 0), originY: Math.round(p.y ?? 0), patch: pn };
    });
    textures.push({ name, masked: 0, width: d.width, height: d.height, patches: refs });
  }
  const defined = new Set(textures.map((t) => t.name));
  for (const [n, [w, h]] of sizes) if (!defined.has(n)) textures.push({ name: n, masked: 0, width: w, height: h, patches: [{ originX: 0, originY: 0, patch: n }] });
  return { patches, flats, textures, freedoomPatches };
}
