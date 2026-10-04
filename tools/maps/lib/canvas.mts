// The map DSL's core: a "paint" canvas compiled to Doom map geometry.
//
// The world is a grid of G-unit cells, each split by both diagonals into four triangles
// (S, E, N, W). A map is authored by painting shapes — rectangles and polygons whose
// vertices are on the grid and whose edges run at 0/45/90 degrees — with *styles*
// (sector properties + the textures its walls show), later paints over earlier ones.
// Because every shape edge runs along cell sides or full cell diagonals, a triangle is
// either fully inside a shape or fully outside, so the raster is exact.
//
// Compilation: triangles of one style that touch form a sector; every edge between two
// different sectors (or a sector and the void) becomes a linedef piece; collinear pieces
// with the same sides are merged through vertices where nothing else meets (capped at
// MAX_LINE units). All coordinates come out integral (cell centres sit on G/2).
import type { MapData, MapLine, MapSector, MapSide, MapThing, MapVertex } from '../../../src/wad/mapdata.ts';

export interface Style {
  floor: number; ceil: number;
  floorPic: string; ceilPic: string;
  light: number;
  special?: number; tag?: number;
  /** one-sided wall facing into this sector (unless the void painted there has its own) */
  wall?: string;
  /** lower texture of the step up onto this sector (shown when this floor is the higher one) */
  riser?: string;
  /** upper texture of this sector's ceiling drop (shown when this ceiling is the lower one) */
  upper?: string;
  /** two-sided mid texture + blocking on this sector's border (railings, grates) */
  fence?: string;
  /** one-sided walls are pegged to the floor (default) or the ceiling */
  wallPeg?: 'floor' | 'ceil';
  /** marks a style as void: solid rock/building mass with this wall texture */
  solid?: false;
  /** free-form label (for the top-down preview / checks), not part of the sector */
  tagName?: string;
  /**
   * Line special + tag on every line bordering this sector (walk-over triggers such as
   * 97 WR teleport or 88 WR lift). Those lines' front side faces away from this sector,
   * so walking *into* it crosses them from the front (teleports only fire that way).
   */
  line?: { special: number; tag: number };
}
export interface Solid { solid: true; wall: string; wallPeg?: 'floor' | 'ceil' }
export type Paint = Style | Solid;

export type Pt = [number, number];
export type Shape = { kind: 'rect'; x0: number; y0: number; x1: number; y1: number } | { kind: 'poly'; pts: Pt[] };

export const rect = (x0: number, y0: number, x1: number, y1: number): Shape =>
  ({ kind: 'rect', x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
export const poly = (pts: Pt[]): Shape => ({ kind: 'poly', pts });
/** Rectangle with 45° chamfered corners (c = chamfer length along each axis). */
export function chamfer(x0: number, y0: number, x1: number, y1: number, c: number): Shape {
  [x0, x1] = [Math.min(x0, x1), Math.max(x0, x1)];
  [y0, y1] = [Math.min(y0, y1), Math.max(y0, y1)];
  c = Math.min(c, (x1 - x0) / 2, (y1 - y0) / 2);
  if (c <= 0) return rect(x0, y0, x1, y1);
  return poly([[x0 + c, y0], [x1 - c, y0], [x1, y0 + c], [x1, y1 - c], [x1 - c, y1], [x0 + c, y1], [x0, y1 - c], [x0, y0 + c]]);
}
/** Octagon centred on (cx, cy) with half-extent r and chamfer r*k (k≈0.41 is regular). */
export const oct = (cx: number, cy: number, r: number, ry = r, k = 0.42, g = 8): Shape => {
  const c = Math.round((Math.min(r, ry) * k) / g) * g;
  return chamfer(cx - r, cy - ry, cx + r, cy + ry, c);
};
/** Diamond (square rotated 45°). */
export const diamond = (cx: number, cy: number, r: number): Shape => poly([[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]]);

const MAX_LINE = 1024;

export class PaintCanvas {
  readonly G: number;
  readonly X0: number; readonly Y0: number; readonly NX: number; readonly NY: number;
  /** style id per triangle (cell*4 + q; q: 0 S, 1 E, 2 N, 3 W) */
  readonly tri: Uint16Array;
  readonly styles: Paint[] = [];
  private styleKey = new Map<string, number>();
  readonly things: MapThing[] = [];

  constructor(x0: number, y0: number, x1: number, y1: number, g = 8, voidStyle: Solid = { solid: true, wall: 'ROCK2' }) {
    this.G = g; this.X0 = x0; this.Y0 = y0;
    this.NX = Math.round((x1 - x0) / g); this.NY = Math.round((y1 - y0) / g);
    if (x0 % g || y0 % g || x1 % g || y1 % g) throw new Error('bounds must be on the grid');
    this.tri = new Uint16Array(this.NX * this.NY * 4);
    this.id(voidStyle); // style 0 = default void
  }

  id(p: Paint): number {
    const k = JSON.stringify(Object.keys(p).sort().map((key) => [key, (p as unknown as Record<string, unknown>)[key]]));
    let i = this.styleKey.get(k);
    if (i === undefined) {
      i = this.styles.length;
      if (i >= 65535) throw new Error('too many styles');
      this.styles.push(p); this.styleKey.set(k, i);
    }
    return i;
  }

  private check(x: number, y: number): void {
    if (x % this.G || y % this.G) throw new Error(`point ${x},${y} is off the ${this.G}-unit grid`);
  }

  /** Calls f(triangleIndex) for every triangle inside the shape. */
  forEach(shape: Shape, f: (t: number) => void): void {
    const { G, X0, Y0, NX, NY } = this;
    if (shape.kind === 'rect') {
      this.check(shape.x0, shape.y0); this.check(shape.x1, shape.y1);
      const cx0 = Math.max(0, (shape.x0 - X0) / G), cx1 = Math.min(NX, (shape.x1 - X0) / G);
      const cy0 = Math.max(0, (shape.y0 - Y0) / G), cy1 = Math.min(NY, (shape.y1 - Y0) / G);
      for (let cy = cy0; cy < cy1; cy++) for (let cx = cx0; cx < cx1; cx++) { const b = (cy * NX + cx) * 4; f(b); f(b + 1); f(b + 2); f(b + 3); }
      return;
    }
    const pts = shape.pts;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
      this.check(x, y);
      const dx = Math.abs(x2 - x), dy = Math.abs(y2 - y);
      if (!(dx === 0 || dy === 0 || dx === dy)) throw new Error(`edge ${x},${y} → ${x2},${y2} is not at 0/45/90 degrees`);
      minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y);
    }
    const cx0 = Math.max(0, Math.floor((minx - X0) / G)), cx1 = Math.min(NX, Math.ceil((maxx - X0) / G));
    const cy0 = Math.max(0, Math.floor((miny - Y0) / G)), cy1 = Math.min(NY, Math.ceil((maxy - Y0) / G));
    // triangle centroids, in cell fractions: S (.5,1/6) E (5/6,.5) N (.5,5/6) W (1/6,.5)
    const OFF: Pt[] = [[0.5, 1 / 6], [5 / 6, 0.5], [0.5, 5 / 6], [1 / 6, 0.5]];
    const n = pts.length;
    for (let cy = cy0; cy < cy1; cy++) {
      for (let q = 0; q < 4; q++) {
        const y = Y0 + (cy + OFF[q][1]) * G;
        // crossings of this scanline with the polygon
        const xs: number[] = [];
        for (let i = 0; i < n; i++) {
          const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
          if ((ay > y) !== (by > y)) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
        }
        if (!xs.length) continue;
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          // cells whose centroid x for this q lies in [xs[k], xs[k+1]]
          const lo = Math.max(cx0, Math.ceil((xs[k] - X0) / G - OFF[q][0]));
          const hi = Math.min(cx1 - 1, Math.floor((xs[k + 1] - X0) / G - OFF[q][0]));
          for (let cx = lo; cx <= hi; cx++) f((cy * NX + cx) * 4 + q);
        }
      }
    }
  }

  paint(shape: Shape, p: Paint): void {
    const id = this.id(p);
    this.forEach(shape, (t) => { this.tri[t] = id; });
  }
  /** Re-styles what is already painted inside the shape (memoized per style). */
  modify(shape: Shape, f: (p: Paint) => Paint | null): void {
    const memo = new Map<number, number>();
    this.forEach(shape, (t) => {
      const cur = this.tri[t];
      let n = memo.get(cur);
      if (n === undefined) { const r = f(this.styles[cur]); n = r ? this.id(r) : cur; memo.set(cur, n); }
      this.tri[t] = n;
    });
  }
  /** Style at a world point (centre of the triangle containing it). */
  at(x: number, y: number): Paint {
    const { G, X0, Y0, NX, NY } = this;
    const fx = (x - X0) / G, fy = (y - Y0) / G;
    const cx = Math.floor(fx), cy = Math.floor(fy);
    if (cx < 0 || cy < 0 || cx >= NX || cy >= NY) return this.styles[0];
    const u = fx - cx - 0.5, v = fy - cy - 0.5;
    const q = Math.abs(u) > Math.abs(v) ? (u > 0 ? 1 : 3) : (v > 0 ? 2 : 0);
    return this.styles[this.tri[(cy * NX + cx) * 4 + q]];
  }
  thing(x: number, y: number, type: number, angle = 0, flags = 7): void {
    this.things.push({ x: Math.round(x), y: Math.round(y), angle: Math.round(angle), type, flags });
  }

  compile(texWidth: (name: string) => number = () => 64): { map: MapData; styleOfSector: number[]; stats: Record<string, number> } {
    const { G, X0, Y0, NX, NY, tri, styles } = this;
    const NT = NX * NY * 4;
    const isSolid = (s: number) => (styles[s] as Solid).solid === true;
    // ---- sectors: connected components of equal non-solid style ----------------------
    const sec = new Int32Array(NT).fill(-1);
    const styleOfSector: number[] = [];
    const stack = new Int32Array(NT);
    const nb = (t: number, k: number): number => {
      const c = t >> 2, q = t & 3, cx = c % NX, cy = (c - cx) / NX;
      if (k === 0) return (c << 2) | ((q + 1) & 3);
      if (k === 1) return (c << 2) | ((q + 3) & 3);
      switch (q) {
        case 0: return cy > 0 ? ((c - NX) << 2) | 2 : -1;
        case 1: return cx < NX - 1 ? ((c + 1) << 2) | 3 : -1;
        case 2: return cy < NY - 1 ? ((c + NX) << 2) | 0 : -1;
        default: return cx > 0 ? ((c - 1) << 2) | 1 : -1;
      }
    };
    for (let t = 0; t < NT; t++) {
      if (sec[t] >= 0 || isSolid(tri[t])) continue;
      const s = styleOfSector.length, st = tri[t];
      styleOfSector.push(st);
      let sp = 0;
      stack[sp++] = t; sec[t] = s;
      while (sp) {
        const u = stack[--sp];
        for (let k = 0; k < 3; k++) {
          const v = nb(u, k);
          if (v >= 0 && sec[v] < 0 && tri[v] === st) { sec[v] = s; stack[sp++] = v; }
        }
      }
    }
    // ---- edges ---------------------------------------------------------------------------
    // directed piece a→b with the front (right) side a sector; key of the merge class
    interface Edge { ax: number; ay: number; bx: number; by: number; f: number; b: number; fs: number; bs: number; next: number; used: boolean }
    const edges: Edge[] = [];
    const H = G / 2;
    // emit an edge between triangle L (left of a→b) and R (right of a→b)
    const emit = (ax: number, ay: number, bx: number, by: number, L: number, R: number) => {
      const sl = L >= 0 ? sec[L] : -1, sr = R >= 0 ? sec[R] : -1;
      if (sl === sr) return; // same sector, or void on both sides
      const stl = L >= 0 ? tri[L] : 0, str = R >= 0 ? tri[R] : 0;
      // front = the sector side; between two sectors, the lower sector number — unless one
      // side is a trigger sector (Style.line): then the front faces away from it
      const trig = (st: number) => !!(styles[st] as Style).line;
      const frontR = sl >= 0 && sr >= 0 && trig(stl) !== trig(str) ? trig(stl) : sr >= 0 && (sl < 0 || sr < sl);
      if (frontR) edges.push({ ax, ay, bx, by, f: sr, b: sl, fs: str, bs: stl, next: -1, used: false });
      else edges.push({ ax: bx, ay: by, bx: ax, by: ay, f: sl, b: sr, fs: stl, bs: str, next: -1, used: false });
    };
    for (let cy = 0; cy < NY; cy++) {
      for (let cx = 0; cx < NX; cx++) {
        const c = cy * NX + cx, b = c * 4;
        const x0 = X0 + cx * G, y0 = Y0 + cy * G, x1 = x0 + G, y1 = y0 + G, mx = x0 + H, my = y0 + H;
        // half-diagonals, centre → corner: S|E to (x1,y0): S is right of centre→(x1,y0)? centre→SE corner runs down-right; S lies to its right
        emit(mx, my, x1, y0, b + 1, b + 0);
        emit(mx, my, x1, y1, b + 2, b + 1);
        emit(mx, my, x0, y1, b + 3, b + 2);
        emit(mx, my, x0, y0, b + 0, b + 3);
        // cell sides: E side (x1,y0)→(x1,y1) has E on its left, the east neighbour's W on its right
        emit(x1, y0, x1, y1, b + 1, cx < NX - 1 ? (c + 1) * 4 + 3 : -1);
        // N side (x1,y1)→(x0,y1): N on the left, the north neighbour's S on the right
        emit(x1, y1, x0, y1, b + 2, cy < NY - 1 ? (c + NX) * 4 : -1);
        if (cx === 0) emit(x0, y1, x0, y0, b + 3, -1);
        if (cy === 0) emit(x0, y0, x1, y0, b + 0, -1);
      }
    }
    // ---- merge collinear pieces ----------------------------------------------------------
    const vk = (x: number, y: number) => (x + 40000) * 80000 + (y + 40000);
    const deg = new Map<number, number>();
    const outOf = new Map<number, number[]>();
    edges.forEach((e, i) => {
      const a = vk(e.ax, e.ay), b = vk(e.bx, e.by);
      deg.set(a, (deg.get(a) ?? 0) + 1); deg.set(b, (deg.get(b) ?? 0) + 1);
      let o = outOf.get(a); if (!o) outOf.set(a, (o = [])); o.push(i);
    });
    const dir = (e: Edge) => `${Math.sign(e.bx - e.ax)},${Math.sign(e.by - e.ay)}`;
    const same = (e: Edge, n: Edge) => e.f === n.f && e.b === n.b && e.fs === n.fs && e.bs === n.bs && dir(e) === dir(n);
    const hasPrev = new Uint8Array(edges.length);
    edges.forEach((e, i) => {
      const bk = vk(e.bx, e.by);
      if (deg.get(bk) !== 2) return;
      const outs = outOf.get(bk);
      if (!outs || outs.length !== 1) return;
      const n = edges[outs[0]];
      if (same(e, n)) { e.next = outs[0]; hasPrev[outs[0]] = 1; }
    });
    const verts: MapVertex[] = [];
    const vidx = new Map<number, number>();
    const V = (x: number, y: number) => { const k = vk(x, y); let i = vidx.get(k); if (i === undefined) { i = verts.length; verts.push({ x, y }); vidx.set(k, i); } return i; };
    const lines: MapLine[] = [];
    const sides: MapSide[] = [];
    const sectorStyle = (s: number) => styles[styleOfSector[s]] as Style;
    const tex = (n: string | undefined, d: string) => (n && n !== '-' ? n : d);
    const xoff = (ax: number, ay: number, bx: number, by: number, t: string) => {
      const len = Math.hypot(bx - ax, by - ay);
      const along = (ax * (bx - ax) + ay * (by - ay)) / len;
      const w = texWidth(t) || 64;
      return ((Math.round(along) % w) + w) % w;
    };
    const makeLine = (e: Edge, ax: number, ay: number, bx: number, by: number) => {
      const F = sectorStyle(e.f);
      let flags = 0;
      const front: MapSide = { xoff: 0, yoff: 0, top: '-', bottom: '-', mid: '-', sector: e.f };
      let backIdx = -1;
      if (e.b < 0) {
        const vs = styles[e.bs] as Solid;
        const isDefaultVoid = e.bs === 0;
        front.mid = isDefaultVoid ? tex(F.wall, vs.wall) : tex(vs.wall, F.wall ?? 'ROCK2');
        const peg = (isDefaultVoid ? F.wallPeg : vs.wallPeg ?? F.wallPeg) ?? 'floor';
        flags = 1 | (peg === 'floor' ? 16 : 0);
        front.xoff = xoff(ax, ay, bx, by, front.mid);
      } else {
        const B = sectorStyle(e.b);
        flags = 4;
        const back: MapSide = { xoff: 0, yoff: 0, top: '-', bottom: '-', mid: '-', sector: e.b };
        const sideTex = (me: Style, other: Style, side: MapSide) => {
          if (other.floor > me.floor) side.bottom = tex(other.riser, tex(other.wall, 'ROCK2'));
          if (other.ceil < me.ceil) side.top = tex(other.upper, tex(other.wall, 'ROCK2'));
          if (me.ceilPic === 'F_SKY1' && other.ceilPic === 'F_SKY1' && side.top !== '-') { /* sky hack: not drawn */ }
        };
        sideTex(F, B, front);
        sideTex(B, F, back);
        const fence = F.fence && F.fence !== B.fence ? F.fence : B.fence && B.fence !== F.fence ? B.fence : null;
        if (fence) { front.mid = fence; back.mid = fence; flags |= 1; }
        front.xoff = xoff(ax, ay, bx, by, front.bottom !== '-' ? front.bottom : front.top !== '-' ? front.top : front.mid);
        back.xoff = xoff(bx, by, ax, ay, back.bottom !== '-' ? back.bottom : back.top !== '-' ? back.top : back.mid);
        sides.push(back);
        backIdx = sides.length - 1;
      }
      sides.push(front);
      const frontIdx = sides.length - 1;
      const trigger = F.line ?? (e.b >= 0 ? sectorStyle(e.b).line : undefined);
      lines.push({ v1: V(ax, ay), v2: V(bx, by), flags, special: trigger?.special ?? 0, tag: trigger?.tag ?? 0, front: frontIdx, back: backIdx });
    };
    const flush = (e: Edge, ax: number, ay: number, bx: number, by: number) => {
      // cap the length: split long runs into equal pieces on the grid
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.ceil(len / MAX_LINE);
      let px = ax, py = ay;
      for (let i = 1; i <= n; i++) {
        let qx = i === n ? bx : ax + Math.round(((bx - ax) * i) / n / H) * H;
        let qy = i === n ? by : ay + Math.round(((by - ay) * i) / n / H) * H;
        if (i < n && Math.abs(bx - ax) === Math.abs(by - ay) && bx !== ax) { // keep diagonals exact
          const step = Math.round((Math.abs(bx - ax) * i) / n / H) * H;
          qx = ax + Math.sign(bx - ax) * step; qy = ay + Math.sign(by - ay) * step;
        }
        if (qx === px && qy === py) continue;
        makeLine(e, px, py, qx, qy);
        px = qx; py = qy;
      }
    };
    const walkChain = (start: number) => {
      const e0 = edges[start];
      let e = e0;
      e.used = true;
      let bx = e.bx, by = e.by;
      while (e.next >= 0 && !edges[e.next].used) { e = edges[e.next]; e.used = true; bx = e.bx; by = e.by; }
      flush(e0, e0.ax, e0.ay, bx, by);
    };
    edges.forEach((e, i) => { if (!e.used && !hasPrev[i]) walkChain(i); });
    edges.forEach((e, i) => { if (!e.used) walkChain(i); }); // closed runs (cannot happen with straight runs, kept for safety)

    const sectors: MapSector[] = styleOfSector.map((st) => {
      const s = styles[st] as Style;
      return { floor: s.floor, ceil: s.ceil, floorPic: s.floorPic, ceilPic: s.ceilPic, light: s.light, special: s.special ?? 0, tag: s.tag ?? 0 };
    });
    // sidedefs: front of line i is sides[...]; reorder so sides are in line order (front then back)
    const sidesOut: MapSide[] = [];
    const linesOut: MapLine[] = lines.map((l) => {
      const f = sidesOut.length; sidesOut.push(sides[l.front]);
      let b = -1;
      if (l.back >= 0) { b = sidesOut.length; sidesOut.push(sides[l.back]); }
      return { ...l, front: f, back: b };
    });
    const map: MapData = { name: 'MAP', vertexes: verts, lines: linesOut, sides: sidesOut, sectors, segs: [], subsectors: [], nodes: [], things: this.things };
    return { map, styleOfSector, stats: { pieces: edges.length, lines: linesOut.length, sides: sidesOut.length, sectors: sectors.length, vertexes: verts.length, styles: styles.length } };
  }
}
