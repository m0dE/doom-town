// Brute-force point-in-sector: for each sector, the even-odd rule over the linedefs that
// border it (a line with the same sector on both sides borders nothing). All sectors are
// tested at once with one ray towards +x; lines are bucketed by rows for speed.
import type { MapData } from '../../../src/wad/mapdata.ts';

export class SectorLocator {
  private rows = new Map<number, number[]>();
  private sf: Int32Array;
  private sb: Int32Array;
  readonly row = 64;
  readonly map: MapData;
  constructor(map: MapData) {
    this.map = map;
    const n = map.lines.length;
    this.sf = new Int32Array(n); this.sb = new Int32Array(n);
    map.lines.forEach((l, i) => {
      this.sf[i] = l.front >= 0 && map.sides[l.front] ? map.sides[l.front].sector : -1;
      this.sb[i] = l.back >= 0 && map.sides[l.back] ? map.sides[l.back].sector : -1;
      const a = map.vertexes[l.v1], b = map.vertexes[l.v2];
      if (a.y === b.y) return;
      const r0 = Math.floor(Math.min(a.y, b.y) / this.row), r1 = Math.floor(Math.max(a.y, b.y) / this.row);
      for (let r = r0; r <= r1; r++) { let arr = this.rows.get(r); if (!arr) this.rows.set(r, (arr = [])); arr.push(i); }
    });
  }

  /** Sector containing (x, y): -1 outside every sector, -2 if several claim it (bad map). */
  sectorAt(x: number, y: number): number {
    const lines = this.rows.get(Math.floor(y / this.row));
    if (!lines) return -1;
    const par = new Map<number, number>();
    const { map } = this;
    for (const i of lines) {
      const l = map.lines[i];
      const a = map.vertexes[l.v1], b = map.vertexes[l.v2];
      const lo = a.y < b.y ? a : b, hi = a.y < b.y ? b : a;
      if (y < lo.y || y >= hi.y) continue;
      const ix = lo.x + ((y - lo.y) * (hi.x - lo.x)) / (hi.y - lo.y);
      if (ix <= x) continue;
      const f = this.sf[i], k = this.sb[i];
      if (f === k) continue;
      if (f >= 0) par.set(f, (par.get(f) ?? 0) ^ 1);
      if (k >= 0) par.set(k, (par.get(k) ?? 0) ^ 1);
    }
    let found = -1;
    for (const [s, p] of par) if (p) { if (found >= 0) return -2; found = s; }
    return found;
  }

  /** Distance from (x, y) to the nearest linedef (only lines in nearby rows; capped). */
  nearLine(x: number, y: number, r: number): boolean {
    const { map } = this;
    const seen = new Set<number>();
    for (let row = Math.floor((y - r) / this.row); row <= Math.floor((y + r) / this.row); row++) {
      for (const i of this.rows.get(row) ?? []) {
        if (seen.has(i)) continue;
        seen.add(i);
        const l = map.lines[i];
        if (segDist(x, y, map.vertexes[l.v1], map.vertexes[l.v2]) <= r) return true;
      }
    }
    // horizontal lines are not in the rows: check them directly (rare enough)
    for (const i of this.horizontal()) {
      const l = map.lines[i];
      if (segDist(x, y, map.vertexes[l.v1], map.vertexes[l.v2]) <= r) return true;
    }
    return false;
  }
  private hz: number[] | null = null;
  private horizontal(): number[] {
    if (!this.hz) this.hz = this.map.lines.map((l, i) => (this.map.vertexes[l.v1].y === this.map.vertexes[l.v2].y ? i : -1)).filter((i) => i >= 0);
    return this.hz;
  }
}

export function segDist(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
}

/** BSP walk to a subsector, then that subsector's sector (via its first seg). */
export function bspSector(map: MapData, x: number, y: number): number {
  let n = map.nodes.length - 1;
  let ss = 0;
  if (n >= 0) {
    for (;;) {
      const nd = map.nodes[n];
      // R_PointOnSide
      let side: number;
      if (nd.dx === 0) side = x <= nd.x ? (nd.dy > 0 ? 1 : 0) : (nd.dy < 0 ? 1 : 0);
      else if (nd.dy === 0) side = y <= nd.y ? (nd.dx < 0 ? 1 : 0) : (nd.dx > 0 ? 1 : 0);
      else side = (y - nd.y) * nd.dx < (x - nd.x) * nd.dy ? 0 : 1;
      const c = nd.children[side];
      if (c & 0x8000) { ss = c & 0x7fff; break; }
      n = c;
    }
  }
  const s = map.subsectors[ss];
  const seg = map.segs[s.first];
  const line = map.lines[seg.line];
  const sd = seg.side ? line.back : line.front;
  return map.sides[sd]?.sector ?? -1;
}
