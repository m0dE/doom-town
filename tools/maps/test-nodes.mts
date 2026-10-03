// Node-builder test on every FreeDM map: rebuild the BSP with tools/maps/lib/nodebuild,
// then at a grid of points inside sectors compare the sector found by
//   brute force (even-odd over each sector's lines), the map's original nodes, our nodes.
// Also structural checks of our BSP (see lib/bspcheck).
//   node tools/maps/test-nodes.mts [MAP01 ...] [--step=16]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wad } from '../../src/wad/wad.ts';
import { parseMap } from '../../src/wad/mapdata.ts';
import { rebuildMap } from './lib/nodebuild.mts';
import { SectorLocator, bspSector } from './lib/locate.mts';
import { checkBsp, gridCompare } from './lib/bspcheck.mts';
import { ROOT } from './lib/paths.mts';

const args = process.argv.slice(2);
const step = Number(args.find((a) => a.startsWith('--step='))?.slice(7) ?? 16);
const wad = new Wad(new Uint8Array(readFileSync(join(ROOT, 'assets/freedm.wad'))));
let names = args.filter((a) => !a.startsWith('--'));
if (!names.length) names = Array.from({ length: 32 }, (_, i) => `MAP${String(i + 1).padStart(2, '0')}`);

let tot = { inside: 0, origAgree: 0, ourAgree: 0, ourVsOrig: 0, ourBadFar: 0 };
let fail = 0;
for (const n of names) {
  const orig = parseMap(n, wad.mapLumps(n));
  const ours = rebuildMap(orig);
  const loc = new SectorLocator(orig);
  const go = gridCompare(orig, (x, y) => bspSector(orig, x, y), step, loc);
  const gm = gridCompare(ours, (x, y) => bspSector(ours, x, y), step, loc);
  // ours vs original nodes directly
  let same = 0, cnt = 0;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const v of orig.vertexes) { minx = Math.min(minx, v.x); miny = Math.min(miny, v.y); maxx = Math.max(maxx, v.x); maxy = Math.max(maxy, v.y); }
  for (let y = miny + 0.37; y < maxy; y += step) for (let x = minx + 0.61; x < maxx; x += step) {
    if (loc.sectorAt(x, y) < 0) continue;
    cnt++;
    if (bspSector(orig, x, y) === bspSector(ours, x, y)) same++;
  }
  const chk = checkBsp(ours, loc);
  const s = ours.stats;
  const farBad = gm.bad - gm.nearLineBad;
  if (farBad > 0 || chk.mixedSector || chk.emptyCell || chk.tinyCell) fail++;
  console.log(`${n}: ${orig.lines.length} lines | orig ${orig.segs.length} segs ${orig.subsectors.length} ss ${orig.nodes.length} nodes | ours ${ours.segs.length} segs ${ours.subsectors.length} ss ${ours.nodes.length} nodes, ${s.splits} splits, depth ${s.depth}, fallback ${s.fallbackPartitions}, ${s.ms.toFixed(0)} ms`);
  console.log(`   grid ${go.inside} pts: orig-vs-brute ${go.agree} (${go.bad} differ, ${go.nearLineBad} within 1.5u of a line) | ours-vs-brute ${gm.agree} (${gm.bad} differ, ${gm.nearLineBad} near a line) | ours-vs-orig ${same}/${cnt}`);
  console.log(`   bsp: mixed ${chk.mixedSector} empty ${chk.emptyCell} tiny ${chk.tinyCell} segOffCell ${chk.segOffCell} centreMismatch ${chk.centreMismatch} centreVoid ${chk.centreVoid} minArea ${chk.minArea.toFixed(1)}${gm.samples.length ? ' samples ' + JSON.stringify(gm.samples) : ''}`);
  tot.inside += go.inside; tot.origAgree += go.agree; tot.ourAgree += gm.agree; tot.ourVsOrig += same; tot.ourBadFar += farBad;
}
console.log(`TOTAL ${names.length} maps, ${tot.inside} points: orig nodes agree with brute force ${(100 * tot.origAgree / tot.inside).toFixed(4)}%, ours ${(100 * tot.ourAgree / tot.inside).toFixed(4)}%, ours = orig ${(100 * tot.ourVsOrig / tot.inside).toFixed(4)}%; ours wrong away from lines: ${tot.ourBadFar}; maps failing: ${fail}`);
process.exit(fail ? 1 : 0);
