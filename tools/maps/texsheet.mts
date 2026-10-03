// Contact sheet of wall textures / flats (a level-design aid):
//   node tools/maps/texsheet.mts out.png [--flats] [--scale=0.5] NAME|/REGEX/ ...
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wad } from '../../src/wad/wad.ts';
import { readPalette } from '../../src/wad/palette.ts';
import { composeTexture, flatPicture, patchLoader, textureDefs } from '../../src/wad/graphics.ts';
import { Canvas } from './lib/png.mts';
import { ROOT } from './lib/paths.mts';

const args = process.argv.slice(2);
const out = args[0];
const flats = args.includes('--flats');
const scale = Number(args.find((a) => a.startsWith('--scale='))?.slice(8) ?? 0.5);
const pats = args.slice(1).filter((a) => !a.startsWith('--'));
const wad = new Wad(new Uint8Array(readFileSync(join(ROOT, 'assets/freedm.wad'))));
const pal = readPalette(wad);
const defs = textureDefs(wad);
const all = flats ? [...wad.namespace('F').keys()] : [...defs.keys()];
const names = all.filter((n) => pats.length === 0 || pats.some((p) => (p.startsWith('/') ? new RegExp(p.slice(1, -1)).test(n) : p === n)));
const getPatch = patchLoader(wad);
const pics = names.map((n) => (flats ? flatPicture(wad.namespace('F').get(n)!.data) : composeTexture(defs.get(n)!, getPatch)));
const cell = Math.max(64, Math.ceil((flats ? 64 : 256) * scale)) + 4;
const cols = Math.max(1, Math.floor(1800 / cell));
const rows = Math.ceil(names.length / cols);
const cv = new Canvas(cols * cell, rows * (cell + 12), [30, 30, 30]);
names.forEach((n, i) => {
  const p = pics[i];
  const ox = (i % cols) * cell, oy = Math.floor(i / cols) * (cell + 12);
  const w = Math.min(p.width, 256), h = Math.min(p.height, 256);
  for (let y = 0; y < h * scale; y++) for (let x = 0; x < w * scale; x++) {
    const sx = Math.floor(x / scale), sy = Math.floor(y / scale);
    const o = (sy * p.width + sx) * 2;
    if (!p.data[o + 1]) continue;
    const c = p.data[o] * 3;
    cv.set(ox + x, oy + 12 + y, [pal.playpal[c], pal.playpal[c + 1], pal.playpal[c + 2]]);
  }
  cv.text(ox, oy + 2, n, [255, 255, 120], 1);
});
writeFileSync(out, cv.png());
console.log(`${names.length} → ${out} ${cv.w}x${cv.h}`);
