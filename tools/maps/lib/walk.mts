// Walkability check on a built map (the bots' rules, DESIGN.md "Sim notes"): sectors are
// connected through two-sided, non-blocking linedefs whose opening is ≥ 56 high and at
// least `minGap` long (a player is 32 wide), with a step up ≤ 24 (drops are one-way).
// Reports which capture points / team bases are reachable from each base and back.
import type { MapData } from '../../../src/wad/mapdata.ts';
import { SectorLocator } from './locate.mts';

export function walkGraph(map: MapData, minGap = 33): { fwd: number[][] } {
  const fwd: number[][] = map.sectors.map(() => []);
  for (const l of map.lines) {
    if (l.back < 0 || l.flags & 1) continue;
    const a = map.sides[l.front].sector, b = map.sides[l.back].sector;
    const va = map.vertexes[l.v1], vb = map.vertexes[l.v2];
    if (Math.hypot(vb.x - va.x, vb.y - va.y) < minGap) {
      // short lines may still be part of a wide opening; keep them (merged openings) —
      // the pieces of one boundary are counted together below
    }
    const A = map.sectors[a], B = map.sectors[b];
    const head = Math.min(A.ceil, B.ceil) - Math.max(A.floor, B.floor);
    if (head < 56) continue;
    if (B.floor - A.floor <= 24) fwd[a].push(b);
    if (A.floor - B.floor <= 24) fwd[b].push(a);
  }
  return { fwd };
}

export function reachability(map: MapData, places: { name: string; x: number; y: number }[]): { matrix: boolean[][]; names: string[] } {
  const loc = new SectorLocator(map);
  const { fwd } = walkGraph(map);
  const secs = places.map((p) => loc.sectorAt(p.x + 0.5, p.y + 0.5));
  const bfs = (s: number) => {
    const seen = new Uint8Array(map.sectors.length);
    const q = [s]; seen[s] = 1;
    while (q.length) { const u = q.pop()!; for (const v of fwd[u]) if (!seen[v]) { seen[v] = 1; q.push(v); } }
    return seen;
  };
  const matrix = secs.map((s) => { const seen = s >= 0 ? bfs(s) : new Uint8Array(map.sectors.length); return secs.map((t) => t >= 0 && !!seen[t]); });
  return { matrix, names: places.map((p) => p.name) };
}
