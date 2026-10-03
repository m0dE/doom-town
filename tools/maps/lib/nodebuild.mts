// A classic Doom BSP node builder (vanilla NODES / SEGS / SSECTORS), written for this
// project.
//
// Segs start as the linedefs' sides (side 0 v1→v2, side 1 v2→v1). Recursively: a set of
// segs that all face one sector and form a convex set (no seg has another seg's endpoint
// strictly behind it) becomes a subsector; otherwise a partition line is chosen among the
// segs' own lines (cost = splits × SPLIT_COST + |front − back|, axis-aligned lines
// preferred on ties), segs crossing it are split at the intersection (rounded to an
// integer vertex; a cut within a unit of an end is not made — the seg goes to the side
// of its far end), segs on the line go front when they run the same way, back otherwise.
// If no seg line separates a set (convex but mixed sectors), an axis-aligned line through
// the median of the seg midpoints is used. Node bounding boxes cover each child's segs.
import type { MapData, MapNode, MapSeg, MapSubsector, MapVertex } from '../../../src/wad/mapdata.ts';

export interface BuildInput {
  vertexes: MapVertex[];
  lines: { v1: number; v2: number; front: number; back: number }[];
  sides: { sector: number }[];
}
export interface BuildOutput {
  vertexes: MapVertex[];
  segs: MapSeg[];
  subsectors: MapSubsector[];
  nodes: MapNode[];
  stats: { splits: number; depth: number; fallbackPartitions: number; ms: number };
}

interface Seg {
  ax: number; ay: number; bx: number; by: number; // exact endpoints (split points are not rounded here)
  va: number; vb: number;                         // vertex indices (split points rounded to integers)
  line: number; side: number;
  sector: number;
  offset: number;                                 // distance from the linedef side's start
  // the side's full line (start + direction), used as a partition
  lx: number; ly: number; ldx: number; ldy: number;
}

const SPLIT_COST = 8;
// Classification works on exact (unrounded) split points, so pieces of one line stay exactly
// collinear; distinct integer lines are at least 1/46341 apart, far above this.
const EPS = 1e-6;

export function buildNodes(map: BuildInput): BuildOutput {
  const t0 = performance.now();
  const verts: MapVertex[] = map.vertexes.map((v) => ({ x: v.x, y: v.y }));
  const vkey = new Map<number, number>();
  const key = (x: number, y: number) => (x + 40000) * 100000 + (y + 40000);
  verts.forEach((v, i) => { if (!vkey.has(key(v.x, v.y))) vkey.set(key(v.x, v.y), i); });
  const vertexAt = (x: number, y: number): number => {
    const k = key(x, y);
    let i = vkey.get(k);
    if (i === undefined) { i = verts.length; verts.push({ x, y }); vkey.set(k, i); }
    return i;
  };

  const segs0: Seg[] = [];
  map.lines.forEach((l, li) => {
    const a = map.vertexes[l.v1], b = map.vertexes[l.v2];
    if (a.x === b.x && a.y === b.y) return; // zero-length line: no seg
    for (const side of [0, 1]) {
      const sd = side ? l.back : l.front;
      if (sd < 0 || sd === 0xffff || !map.sides[sd]) continue;
      const [p, q, vp, vq] = side ? [b, a, l.v2, l.v1] : [a, b, l.v1, l.v2];
      segs0.push({ ax: p.x, ay: p.y, bx: q.x, by: q.y, va: vp, vb: vq, line: li, side, sector: map.sides[sd].sector, offset: 0,
        lx: p.x, ly: p.y, ldx: q.x - p.x, ldy: q.y - p.y });
    }
  });

  const segsOut: MapSeg[] = [];
  const subsectors: MapSubsector[] = [];
  const nodes: MapNode[] = [];
  let splits = 0, maxDepth = 0, fallback = 0;

  // signed distance of (x, y) from the partition, > 0 = left/back, < 0 = right/front
  const dist = (px: number, py: number, dx: number, dy: number, len: number, x: number, y: number) => (dx * (y - py) - dy * (x - px)) / len;

  type Part = { x: number; y: number; dx: number; dy: number };

  /** 0 front, 1 back, 2 split (with t), for a seg against a partition. */
  function classify(s: Seg, p: Part, len: number): [number, number] {
    let d1 = dist(p.x, p.y, p.dx, p.dy, len, s.ax, s.ay);
    let d2 = dist(p.x, p.y, p.dx, p.dy, len, s.bx, s.by);
    if (Math.abs(d1) < EPS) d1 = 0;
    if (Math.abs(d2) < EPS) d2 = 0;
    if (d1 === 0 && d2 === 0) return [(s.bx - s.ax) * p.dx + (s.by - s.ay) * p.dy > 0 ? 0 : 1, 0];
    if (d1 <= 0 && d2 <= 0) return [0, 0];
    if (d1 >= 0 && d2 >= 0) return [1, 0];
    return [2, d1 / (d1 - d2)];
  }

  /** Exact split point, or null when a piece would be shorter than a unit or round onto an end. */
  function splitPoint(s: Seg, t: number): [number, number] | null {
    const x = s.ax + (s.bx - s.ax) * t, y = s.ay + (s.by - s.ay) * t;
    const segLen = Math.hypot(s.bx - s.ax, s.by - s.ay);
    if (t * segLen < 1 || (1 - t) * segLen < 1) return null;
    const rx = Math.round(x), ry = Math.round(y);
    const A = verts[s.va], B = verts[s.vb];
    if ((rx === A.x && ry === A.y) || (rx === B.x && ry === B.y)) return null;
    return [x, y];
  }

  function isConvexLeaf(segs: Seg[]): boolean {
    const sec = segs[0].sector;
    for (const s of segs) if (s.sector !== sec) return false;
    for (const s of segs) {
      const len = Math.hypot(s.ldx, s.ldy);
      for (const o of segs) {
        if (o === s) continue;
        if (dist(s.lx, s.ly, s.ldx, s.ldy, len, o.ax, o.ay) > EPS || dist(s.lx, s.ly, s.ldx, s.ldy, len, o.bx, o.by) > EPS) return false;
      }
    }
    return true;
  }

  function evaluate(p: Part, segs: Seg[], best: number): number {
    const len = Math.hypot(p.dx, p.dy);
    let f = 0, b = 0, sp = 0;
    for (const s of segs) {
      const [c, t] = classify(s, p, len);
      if (c === 0) f++;
      else if (c === 1) b++;
      else {
        const pt = splitPoint(s, t);
        if (!pt) { if (t < 0.5) { if (dist(p.x, p.y, p.dx, p.dy, len, s.bx, s.by) < 0) f++; else b++; } else { if (dist(p.x, p.y, p.dx, p.dy, len, s.ax, s.ay) < 0) f++; else b++; } }
        else { sp++; f++; b++; }
      }
      if (sp * SPLIT_COST > best) return Infinity;
    }
    if (f === 0 || b === 0) return Infinity;
    let cost = sp * SPLIT_COST + Math.abs(f - b);
    if (p.dx !== 0 && p.dy !== 0) cost += 2; // prefer axis-aligned partitions
    return cost;
  }

  function choosePartition(segs: Seg[]): Part | null {
    let best = Infinity, bestP: Part | null = null;
    const tried = new Set<number>();
    const tryList = (list: Seg[]) => {
      for (const s of list) {
        const id = s.line * 2 + s.side;
        if (tried.has(id) || tried.has(s.line * 2 + (1 - s.side))) continue;
        tried.add(id);
        const p = { x: s.lx, y: s.ly, dx: s.ldx, dy: s.ldy };
        const c = evaluate(p, segs, best);
        if (c < best) { best = c; bestP = p; }
      }
    };
    const MAXC = 96;
    if (segs.length <= MAXC) tryList(segs);
    else {
      const step = segs.length / MAXC;
      const pick: Seg[] = [];
      for (let i = 0; i < MAXC; i++) pick.push(segs[Math.floor(i * step)]);
      tryList(pick);
      if (!bestP) tryList(segs);
    }
    return bestP;
  }

  function fallbackPartition(segs: Seg[]): Part | null {
    const mx = segs.map((s) => (s.ax + s.bx) / 2).sort((a, b) => a - b);
    const my = segs.map((s) => (s.ay + s.by) / 2).sort((a, b) => a - b);
    const cands: Part[] = [];
    for (const q of [0.5, 0.33, 0.67, 0.2, 0.8]) {
      const x = Math.round(mx[Math.floor(mx.length * q)]), y = Math.round(my[Math.floor(my.length * q)]);
      cands.push({ x, y: 0, dx: 0, dy: 1 }, { x: 0, y, dx: 1, dy: 0 });
    }
    let best = Infinity, bestP: Part | null = null;
    for (const p of cands) { const c = evaluate(p, segs, best); if (c < best) { best = c; bestP = p; } }
    return bestP;
  }

  function bboxOf(segs: Seg[]): number[] {
    let top = -Infinity, bottom = Infinity, left = Infinity, right = -Infinity;
    for (const s of segs) {
      const a = verts[s.va], b = verts[s.vb];
      top = Math.max(top, a.y, b.y); bottom = Math.min(bottom, a.y, b.y);
      left = Math.min(left, a.x, b.x); right = Math.max(right, a.x, b.x);
    }
    return [top, bottom, left, right];
  }

  function emitLeaf(segs: Seg[]): number {
    const first = segsOut.length;
    for (const s of segs) {
      const line = map.lines[s.line];
      const ldx = s.ldx, ldy = s.ldy;
      let ang = Math.round((Math.atan2(ldy, ldx) / (2 * Math.PI)) * 65536);
      ang = ((ang % 65536) + 65536) % 65536;
      const start = s.side ? map.vertexes[line.v2] : map.vertexes[line.v1];
      const v = verts[s.va];
      const off = Math.round(Math.hypot(v.x - start.x, v.y - start.y));
      segsOut.push({ v1: s.va, v2: s.vb, angle: ang >= 32768 ? ang - 65536 : ang, line: s.line, side: s.side, offset: off });
    }
    subsectors.push({ count: segs.length, first });
    return (subsectors.length - 1) | 0x8000;
  }

  function build(segs: Seg[], depth: number): number {
    maxDepth = Math.max(maxDepth, depth);
    if (isConvexLeaf(segs)) return emitLeaf(segs);
    let p = choosePartition(segs);
    if (!p) { p = fallbackPartition(segs); fallback++; }
    if (!p) {
      // cannot separate (should not happen on sane input): emit as one leaf
      return emitLeaf(segs);
    }
    const len = Math.hypot(p.dx, p.dy);
    const front: Seg[] = [], back: Seg[] = [];
    for (const s of segs) {
      const [c, t] = classify(s, p, len);
      if (c === 0) front.push(s);
      else if (c === 1) back.push(s);
      else {
        const pt = splitPoint(s, t);
        if (!pt) {
          const far = t < 0.5 ? [s.bx, s.by] : [s.ax, s.ay];
          (dist(p.x, p.y, p.dx, p.dy, len, far[0], far[1]) < 0 ? front : back).push(s);
          continue;
        }
        splits++;
        const vi = vertexAt(Math.round(pt[0]), Math.round(pt[1]));
        const s1: Seg = { ...s, bx: pt[0], by: pt[1], vb: vi };
        const s2: Seg = { ...s, ax: pt[0], ay: pt[1], va: vi };
        const d1 = dist(p.x, p.y, p.dx, p.dy, len, s.ax, s.ay);
        if (d1 < 0) { front.push(s1); back.push(s2); } else { back.push(s1); front.push(s2); }
      }
    }
    if (!front.length || !back.length) return emitLeaf(segs);
    const r = build(front, depth + 1);
    const l = build(back, depth + 1);
    const node: MapNode = { x: p.x, y: p.y, dx: p.dx, dy: p.dy, bbox: [bboxOf(front), bboxOf(back)], children: [r, l] };
    nodes.push(node);
    return nodes.length - 1;
  }

  if (segs0.length) build(segs0, 0);
  if (nodes.length >= 0x8000 || subsectors.length >= 0x8000) throw new Error(`BSP too large: ${nodes.length} nodes, ${subsectors.length} subsectors`);
  if (segsOut.length > 0xffff || verts.length > 0xffff) throw new Error(`BSP too large: ${segsOut.length} segs, ${verts.length} vertexes`);
  return { vertexes: verts, segs: segsOut, subsectors, nodes, stats: { splits, depth: maxDepth, fallbackPartitions: fallback, ms: performance.now() - t0 } };
}

/** The map with its BSP replaced by our own. */
export function rebuildMap(map: MapData): MapData & { stats: BuildOutput['stats'] } {
  const out = buildNodes(map);
  return { ...map, vertexes: out.vertexes, segs: out.segs, subsectors: out.subsectors, nodes: out.nodes, stats: out.stats };
}
