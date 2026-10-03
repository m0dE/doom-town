// Top-down PNGs: node tools/maps/topdown.mts MAP01 MAP11 WAR01 ...  → docs/maps/<MAP>-top.png
// FreeDM maps come from assets/freedm.wad, generated maps from tools/maps/out/<MAP>.wad.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wad } from '../../src/wad/wad.ts';
import { parseMap } from '../../src/wad/mapdata.ts';
import { renderTopDown } from './lib/topdown.mts';
import { ROOT } from './lib/paths.mts';

const args = process.argv.slice(2);
const px = Number(args.find((a) => a.startsWith('--px='))?.slice(5) ?? 1600);
for (const name of args.filter((a) => !a.startsWith('--')).map((a) => a.toUpperCase())) {
  const gen = join(ROOT, 'tools/maps/out', `${name}.wad`);
  const wad = new Wad(new Uint8Array(readFileSync(existsSync(gen) ? gen : join(ROOT, 'assets/freedm.wad'))));
  const map = parseMap(name, wad.mapLumps(name));
  const t0 = performance.now();
  const cv = renderTopDown(map, name, px);
  const out = join(ROOT, 'docs/maps', `${name}-top.png`);
  writeFileSync(out, cv.png());
  console.log(`${out} ${cv.w}x${cv.h} (${(performance.now() - t0).toFixed(0)} ms)`);
}
