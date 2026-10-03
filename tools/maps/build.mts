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
import type { PaintCanvas } from './lib/canvas.mts';
import * as war01 from './war01.mts';
import * as war02 from './war02.mts';
import * as br01 from './br01.mts';

/** Generated maps (war maps and the battle royale map). */
export const WAR_MAPS: Record<string, { NAME: string; TITLE: string; build: typeof war01.build; report?: () => string }> = { WAR01: war01, WAR02: war02, BR01: br01 };

/** A map script: the map DSL (lib/canvas.mts) painted by `build()`; `report()` adds a log line. */
export interface MapModule { build: () => PaintCanvas; report?: () => string }

export function compileWarMap(name: string, opts: { check?: boolean; log?: (s: string) => void } = {}): { lumps: { name: string; data: Uint8Array }[]; map: MapData; errors: string[] } {
  const mod = WAR_MAPS[name];
  if (!mod) throw new Error(`unknown war map ${name}`);
  return compileMapModule(name, mod, opts);
}

/**
 * Compiles a map script to vanilla map lumps (marker first) with our node builder, and
 * checks it (textures, structure, BSP vs brute force, walkability) unless check is false.
 */
export function compileMapModule(name: string, mod: MapModule, opts: { check?: boolean; log?: (s: string) => void; extraTextures?: Map<string, number>; extraFlats?: Set<string> } = {}): { lumps: { name: string; data: Uint8Array }[]; map: MapData; errors: string[] } {
  const log = opts.log ?? (() => {});
  const tex = textureInfo();
  // a mod's own art (tools/mods/customart.mjs): texture name → width, flat names
  for (const [n, w] of opts.extraTextures ?? []) tex.width.set(n, w);
  for (const n of opts.extraFlats ?? []) tex.flats.add(n);
  let t = performance.now();
  const canvas = mod.build();
  log(`${name}: painted in ${(performance.now() - t).toFixed(0)} ms (${canvas.styles.length} styles)`);
  if (mod.report) log(`${name}: ${mod.report()}`);
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
    // walkability: war maps — both bases, every capture point and every pickup, both ways;
    // battle royale maps (no team bases) — every DM start, crate and pickup to and from the
    // first DM start
    const PICKUP = (t: number) => (t >= 2001 && t <= 2049 && t !== 2028 && t !== 2035) || t === 82 || t === 83 || t === 8 || t === 17 || t === 9050 || t === 9051;
    const pickups = shipped.things.filter((t) => PICKUP(t.type)).map((t) => ({ name: `item ${t.type} at ${t.x},${t.y}`, x: t.x, y: t.y }));
    const isWar = shipped.things.some((t) => t.type === 9000);
    if (isWar) {
      const base = (type: number) => shipped.things.find((t) => t.type === type)!;
      const places = [{ name: 'red base', ...base(9000) }, { name: 'blue base', ...base(9001) },
        ...shipped.things.filter((t) => t.type === 9010).map((t, i) => ({ name: `point ${'ABCDEFGH'[i]}`, x: t.x, y: t.y })), ...pickups];
      const { matrix, names } = reachability(shipped, places);
      const bad: string[] = [];
      for (let i = 0; i < names.length; i++) {
        if (!matrix[0][i] || !matrix[i][0]) bad.push(names[i]);
        if (i < 7 && (!matrix[1][i] || !matrix[i][1])) bad.push(`${names[i]} (blue)`);
      }
      log(`${name}: walkability: ${places.length} places (2 bases, ${places.length - 2 - pickups.length} points, ${pickups.length} pickups): ${bad.length ? 'UNREACHABLE ' + bad.join('; ') : 'all reachable both ways from both bases'}`);
      if (bad.length) errors.push(`unreachable: ${bad.join('; ')}`);
    } else {
      const startsList = shipped.things.filter((t) => t.type === 11).map((t, i) => ({ name: `start ${i} at ${t.x},${t.y}`, x: t.x, y: t.y }));
      const cratesList = shipped.things.filter((t) => t.type === 9020).map((t) => ({ name: `crate at ${t.x},${t.y}`, x: t.x, y: t.y }));
      const buggies = shipped.things.filter((t) => t.type === 9040).map((t) => ({ name: `buggy at ${t.x},${t.y}`, x: t.x, y: t.y }));
      const lobby = shipped.things.filter((t) => t.type === 9030).map((t) => ({ name: `lobby spot at ${t.x},${t.y}`, x: t.x, y: t.y }));
      const places = [...startsList, ...cratesList, ...pickups, ...buggies, ...lobby];
      const { matrix, names } = reachability(shipped, places);
      const nPlay = places.length - lobby.length;
      const bad: string[] = [], leaks: string[] = [];
      for (let i = 0; i < nPlay; i++) if (!matrix[0][i] || !matrix[i][0]) bad.push(names[i]);
      // the lobby: one connected area, sealed off from the playfield both ways
      for (let i = nPlay; i < names.length; i++) {
        if (!matrix[nPlay][i] || !matrix[i][nPlay]) bad.push(names[i]);
        if (matrix[0][i] || matrix[i][0]) leaks.push(names[i]);
      }
      log(`${name}: walkability: ${places.length} places (${startsList.length} DM starts, ${cratesList.length} crates, ${pickups.length} pickups, ${buggies.length} buggies, ${lobby.length} lobby spots): ${bad.length ? 'UNREACHABLE ' + bad.join('; ') : 'all reachable both ways from the first start / lobby spot'}; lobby ${leaks.length ? 'LEAKS to the playfield: ' + leaks.slice(0, 5).join('; ') : 'sealed off'}`);
      // battle royale maps (crates / a lobby) spread 64 players over DM starts; small
      // deathmatch maps (mods/examples/arena) need far fewer
      if ((cratesList.length || lobby.length) && startsList.length < 64) errors.push(`only ${startsList.length} DM starts`);
      if (startsList.length < 4) errors.push(`only ${startsList.length} DM starts`);
      if (lobby.length && lobby.length < 64) errors.push(`only ${lobby.length} lobby spots`);
      if (bad.length) errors.push(`unreachable: ${bad.join('; ')}`);
      if (leaks.length) errors.push(`lobby reachable from the playfield: ${leaks.length} spots`);
    }
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
