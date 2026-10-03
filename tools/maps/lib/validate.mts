// Checks of a compiled map: (a) sides/sectors sane and every sector's boundary closed,
// (b) BSP point-in-subsector agrees with brute-force point-in-sector on a dense grid.
import type { MapData } from '../../../src/wad/mapdata.ts';
import { SectorLocator, bspSector } from './locate.mts';
import { checkBsp, gridCompare } from './bspcheck.mts';

export function checkStructure(map: MapData): string[] {
  const errs: string[] = [];
  const ns = map.sectors.length;
  const deg = Array.from({ length: ns }, () => new Map<number, number>());
  map.lines.forEach((l, i) => {
    if (l.v1 >= map.vertexes.length || l.v2 >= map.vertexes.length) errs.push(`line ${i}: bad vertex`);
    if (l.v1 === l.v2) errs.push(`line ${i}: zero length`);
    const f = map.sides[l.front];
    if (!f) { errs.push(`line ${i}: no front side`); return; }
    if (f.sector < 0 || f.sector >= ns) errs.push(`line ${i}: front sector ${f.sector}`);
    const b = l.back >= 0 ? map.sides[l.back] : null;
    if (l.back >= 0 && !b) errs.push(`line ${i}: bad back side`);
    if (b && (b.sector < 0 || b.sector >= ns)) errs.push(`line ${i}: back sector ${b.sector}`);
    if (b && b.sector === f.sector) errs.push(`line ${i}: same sector both sides`);
    if (!!(l.flags & 4) !== !!b) errs.push(`line ${i}: two-sided flag mismatch`);
    // boundary edges, sector on the right: in/out degree per vertex
    const add = (s: number, from: number, to: number) => {
      deg[s].set(from, (deg[s].get(from) ?? 0) + 1);
      deg[s].set(to, (deg[s].get(to) ?? 0) - 1);
    };
    add(f.sector, l.v1, l.v2);
    if (b) add(b.sector, l.v2, l.v1);
  });
  let open = 0;
  deg.forEach((m, s) => { for (const [, d] of m) if (d !== 0) { open++; if (open < 5) errs.push(`sector ${s}: boundary not closed`); break; } });
  if (open >= 5) errs.push(`${open} sectors with open boundaries`);
  const used = new Set(map.sides.map((s) => s.sector));
  for (let s = 0; s < ns; s++) if (!used.has(s)) errs.push(`sector ${s} has no sides`);
  return errs;
}

export function checkBspAgainstBruteForce(map: MapData, step: number) {
  const loc = new SectorLocator(map);
  const grid = gridCompare(map, (x, y) => bspSector(map, x, y), step, loc);
  const bsp = checkBsp(map, loc);
  return { grid, bsp };
}
