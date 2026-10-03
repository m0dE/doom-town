// Builds the generated war maps: DSL → geometry → our BSP → checks → PWAD.
//   npx tsx tools/maps/build.mts [WAR01 ...] [--no-check] [--top]
// Writes tools/maps/out/<MAP>.wad (one map, vanilla lumps; REJECT empty, BLOCKMAP built
// when its offsets fit in 16 bits, else empty — the sim then builds its own) and, with
// --top, docs/maps/<MAP>-top.png.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWadFile } from '../../src/wad/wad.ts';
import { parseMap, type MapData } from '../../src/wad/mapdata.ts';
import { Wad } from '../../src/wad/wad.ts';
import { buildNodes } from './lib/nodebuild.mts';
import { mapLumps } from './lib/mapwad.mts';
import { checkStructure, checkBspAgainstBruteForce } from './lib/validate.mts';
import { textureInfo } from './lib/textures.mts';
import { renderTopDown } from './lib/topdown.mts';
import { reachability } from './lib/walk.mts';
import { ROOT } from './lib/paths.mts';
import * as war01 from './war01.mts';
import * as war02 from './war02.mts';

export const WAR_MAPS: Record<string, { NAME: string; TITLE: string; build: typeof war01.build }> = { WAR01: war01, WAR02: war02 };

export function compileWarMap(name: string, opts: { check?: boolean; log?: (s: string) => void } = {}): { lumps: { name: string; data: Uint8Array }[]; map: MapData; errors: string[] } {
  const log = opts.log ?? (() => {});
  const mod = WAR_MAPS[name];
  if (!mod) throw new Error(`unknown war map ${name}`);
  const tex = textureInfo();
  let t = performance.now();
  const canvas = mod.build();
  log(`${name}: painted in ${(performance.now() - t).toFixed(0)} ms (${canvas.styles.length} styles)`);
  t = performance.now();
  const { map, stats } = canvas.compile((n) => tex.width.get(n) ?? 64);
  map.name = name;
  log(`${name}: compiled in ${(performance.now() - t).toFixed(0)} ms: ${JSON.stringify(stats)}`);
  const errors: string[] = [];
  // textures and flats must exist
  const missing = new Set<string>();
  for (const s of map.sides) for (const n of [s.top, s.bottom, s.mid]) if (n !== '-' && !tex.width.has(n)) missing.add(n);
  for (const s of map.sectors) for (const n of [s.floorPic, s.ceilPic]) if (!tex.flats.has(n)) missing.add(n);
  if (missing.size) errors.push(`missing textures/flats: ${[...missing].join(' ')}`);
  for (const v of map.vertexes) if (Math.abs(v.x) > 30000 || Math.abs(v.y) > 30000) { errors.push('vertex outside ±30000'); break; }
  errors.push(...checkStructure(map));
  t = performance.now();
  const bsp = buildNodes(map);
  Object.assign(map, { vertexes: bsp.vertexes, segs: bsp.segs, subsectors: bsp.subsectors, nodes: bsp.nodes });
  log(`${name}: nodes in ${bsp.stats.ms.toFixed(0)} ms: ${map.segs.length} segs, ${map.subsectors.length} subsectors, ${map.nodes.length} nodes, ${bsp.stats.splits} splits, depth ${bsp.stats.depth}, fallback partitions ${bsp.stats.fallbackPartitions}`);
  if (bsp.stats.fallbackPartitions) errors.push(`${bsp.stats.fallbackPartitions} fallback partitions`);
  const lumps = mapLumps(map);
  const bm = lumps.find((l) => l.name === 'BLOCKMAP')!;
  log(`${name}: BLOCKMAP ${bm.data.length ? `${bm.data.length} bytes` : 'too large for 16-bit offsets — left empty (the sim builds it)'}`);
  if (opts.check !== false) {
    // round-trip through the lump parser so the check sees exactly what ships
    const wad = new Wad(buildWadFile(lumps));
    const shipped = parseMap(name, wad.mapLumps(name));
    errors.push(...checkStructure(shipped).map((e) => `shipped: ${e}`));
    t = performance.now();
    const { grid, bsp: chk } = checkBspAgainstBruteForce(shipped, 16);
    log(`${name}: grid check ${grid.inside} points inside sectors (step 16): BSP = brute force at ${grid.agree} (${grid.bad} differ, ${grid.nearLineBad} of them within 1.5 units of a line) in ${(performance.now() - t).toFixed(0)} ms`);
    log(`${name}: subsectors ${chk.subsectors}: mixed-sector ${chk.mixedSector}, empty ${chk.emptyCell}, tiny(<1u²) ${chk.tinyCell}, seg off cell ${chk.segOffCell}, centre outside sector ${chk.centreMismatch + chk.centreVoid}, min area ${chk.minArea.toFixed(1)}`);
    if (grid.bad - grid.nearLineBad > 0) errors.push(`BSP disagrees with brute force at ${grid.bad - grid.nearLineBad} points: ${JSON.stringify(grid.samples)}`);
    // walkability: both bases, every capture point and every pickup, both ways
    const base = (type: number) => shipped.things.find((t) => t.type === type)!;
    const places = [{ name: 'red base', ...base(9000) }, { name: 'blue base', ...base(9001) },
      ...shipped.things.filter((t) => t.type === 9010).map((t, i) => ({ name: `point ${'ABCDEFGH'[i]}`, x: t.x, y: t.y })),
      ...shipped.things.filter((t) => (t.type >= 2001 && t.type <= 2049 && t.type !== 2028 && t.type !== 2035) || t.type === 82 || t.type === 83 || t.type === 8 || t.type === 17).map((t) => ({ name: `item ${t.type} at ${t.x},${t.y}`, x: t.x, y: t.y }))];
    const { matrix, names } = reachability(shipped, places);
    const bad: string[] = [];
    for (let i = 0; i < names.length; i++) {
      if (!matrix[0][i] || !matrix[i][0]) bad.push(names[i]);
      if (i < 7 && (!matrix[1][i] || !matrix[i][1])) bad.push(`${names[i]} (blue)`);
    }
    log(`${name}: walkability: ${places.length} places (2 bases, ${places.length - 2 - (names.filter((n) => n.startsWith('item')).length)} points, ${names.filter((n) => n.startsWith('item')).length} pickups): ${bad.length ? 'UNREACHABLE ' + bad.join('; ') : 'all reachable both ways from both bases'}`);
    if (bad.length) errors.push(`unreachable: ${bad.join('; ')}`);
    if (chk.mixedSector || chk.emptyCell || chk.tinyCell || chk.centreMismatch || chk.centreVoid) errors.push('degenerate subsectors');
  }
  return { lumps, map, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const names = args.filter((a) => !a.startsWith('--'));
  const outDir = join(ROOT, 'tools/maps/out');
  mkdirSync(outDir, { recursive: true });
  let failed = 0;
  for (const name of names.length ? names : Object.keys(WAR_MAPS)) {
    const { lumps, map, errors } = compileWarMap(name, { check: !args.includes('--no-check'), log: console.log });
    const file = buildWadFile(lumps);
    writeFileSync(join(outDir, `${name}.wad`), file);
    console.log(`${name}: ${map.lines.length} lines, ${map.sides.length} sides, ${map.sectors.length} sectors, ${map.things.length} things → tools/maps/out/${name}.wad (${(file.length / 1024).toFixed(0)} KB)`);
    if (args.includes('--top')) {
      const png = renderTopDown(map, `${name}`, 2000).png();
      writeFileSync(join(ROOT, 'docs/maps', `${name}-top.png`), png);
      console.log(`${name}: docs/maps/${name}-top.png`);
    }
    if (errors.length) { failed++; console.error(`${name}: ${errors.length} problems:\n  ${errors.slice(0, 20).join('\n  ')}`); }
  }
  process.exit(failed ? 1 : 0);
}
