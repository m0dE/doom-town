// Structural checks of a built BSP: every subsector has segs of one sector, its convex
// cell (map box clipped by the partitions down the tree) has area, every seg lies on the
// cell's boundary, and the cell's centre is inside the subsector's sector (brute force).
import type { MapData } from '../../../src/wad/mapdata.ts';
import { SectorLocator } from './locate.mts';

type Pt = [number, number];
function clip(poly: Pt[], ax: number, ay: number, dx: number, dy: number): Pt[] {
  const out: Pt[] = [];
  const len = Math.hypot(dx, dy) || 1;
  const side = (p: Pt) => (dx * (p[1] - ay) - dy * (p[0] - ax)) / len;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const sp = side(p), sq = side(q);
    if (sp <= 0) out.push(p);
    if ((sp <= 0) !== (sq <= 0)) { const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return out;
}
const area = (p: Pt[]) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return Math.abs(a) / 2; };

export interface BspReport { subsectors: number; mixedSector: number; emptyCell: number; tinyCell: number; segOffCell: number; centreMismatch: number; centreVoid: number; minArea: number }

export function checkBsp(map: MapData, loc = new SectorLocator(map)): BspReport {
  const r: BspReport = { subsectors: map.subsectors.length, mixedSector: 0, emptyCell: 0, tinyCell: 0, segOffCell: 0, centreMismatch: 0, centreVoid: 0, minArea: Infinity };
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const v of map.vertexes) { minx = Math.min(minx, v.x); miny = Math.min(miny, v.y); maxx = Math.max(maxx, v.x); maxy = Math.max(maxy, v.y); }
  const box: Pt[] = [[minx - 64, miny - 64], [minx - 64, maxy + 64], [maxx + 64, maxy + 64], [maxx + 64, miny - 64]];
  const segSector = (si: number) => { const sg = map.segs[si]; const l = map.lines[sg.line]; return map.sides[sg.side ? l.back : l.front].sector; };
  const leaf = (ss: number, cell: Pt[]) => {
    const s = map.subsectors[ss];
    const sec = segSector(s.first);
    for (let i = 1; i < s.count; i++) if (segSector(s.first + i) !== sec) { r.mixedSector++; break; }
    // the leaf's region: the cell clipped by its own segs (what renderers draw)
    let poly = cell;
    for (let i = 0; i < s.count; i++) {
      const sg = map.segs[s.first + i];
      const a = map.vertexes[sg.v1], b = map.vertexes[sg.v2];
      poly = clip(poly, a.x, a.y, b.x - a.x, b.y - a.y);
    }
    const A = area(poly);
    if (poly.length < 3) { r.emptyCell++; return; }
    r.minArea = Math.min(r.minArea, A);
    if (A < 1) r.tinyCell++;
    // segs must lie on the boundary of the region
    for (let i = 0; i < s.count; i++) {
      const sg = map.segs[s.first + i];
      const a = map.vertexes[sg.v1], b = map.vertexes[sg.v2];
      for (const p of [a, b]) {
        let inside = true;
        for (let k = 0; k < poly.length && inside; k++) {
          const u = poly[k], w = poly[(k + 1) % poly.length];
          const dx = w[0] - u[0], dy = w[1] - u[1];
          const len = Math.hypot(dx, dy);
          if (len < 1e-9) continue;
          if ((dx * (p.y - u[1]) - dy * (p.x - u[0])) / len > 1.5) inside = false;
        }
        if (!inside) { r.segOffCell++; break; }
      }
    }
    let cx = 0, cy = 0;
    for (const p of poly) { cx += p[0]; cy += p[1]; }
    cx /= poly.length; cy /= poly.length;
    const bs = loc.sectorAt(cx + 0.013, cy + 0.017);
    if (bs < 0) r.centreVoid++;
    else if (bs !== sec) r.centreMismatch++;
  };
  const walk = (child: number, cell: Pt[]) => {
    if (child & 0x8000) { leaf(child & 0x7fff, cell); return; }
    const nd = map.nodes[child];
    walk(nd.children[0], clip(cell, nd.x, nd.y, nd.dx, nd.dy));
    walk(nd.children[1], clip(cell, nd.x, nd.y, -nd.dx, -nd.dy));
  };
  if (map.nodes.length) walk(map.nodes.length - 1, box);
  return r;
}

/** Grid comparison: brute-force sector vs BSP sector at points inside sectors. */
export function gridCompare(map: MapData, bsp: (x: number, y: number) => number, step: number, loc = new SectorLocator(map)) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const v of map.vertexes) { minx = Math.min(minx, v.x); miny = Math.min(miny, v.y); maxx = Math.max(maxx, v.x); maxy = Math.max(maxy, v.y); }
  let inside = 0, agree = 0, bad = 0, nearLineBad = 0;
  const samples: [number, number, number, number][] = [];
  for (let y = miny + 0.37; y < maxy; y += step) {
    for (let x = minx + 0.61; x < maxx; x += step) {
      const s = loc.sectorAt(x, y);
      if (s < 0) continue;
      inside++;
      const b = bsp(x, y);
      if (b === s) agree++;
      else { bad++; if (loc.nearLine(x, y, 1.5)) nearLineBad++; else if (samples.length < 5) samples.push([x, y, s, b]); }
    }
  }
  return { inside, agree, bad, nearLineBad, samples };
}
