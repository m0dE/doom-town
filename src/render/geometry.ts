// Static map geometry. Everything is built once; heights come from the sector data
// texture at draw time (vertex shader), so moving floors/ceilings/doors never rebuild.
//
// Floors/ceilings: convex subsector polygons from the BSP (clip the map bbox by each
// node partition down the tree, then by the subsector's segs), snapped and T-junction
// fixed so neighbouring polygons share vertices.
import * as THREE from 'three';
import { ML_DONTPEGBOTTOM, ML_DONTPEGTOP, NF_SUBSECTOR, type MapData } from '../wad';
import type { RenderAssets } from './assets';

type Pt = [number, number];

/** Wall part codes (shader `part`). */
export const PART_MID = 0, PART_UPPER = 1, PART_LOWER = 2, PART_MASKED = 3;
/** Wall flag bits (shader). */
export const WF_PEGTOP = 1, WF_PEGBOTTOM = 2, WF_SCROLL = 4, WF_LIGHTER = 8, WF_DARKER = 16;

/** Clip polygon by half-plane: keep points with (p - a) × dir <= eps (right side / front). */
function clip(poly: Pt[], ax: number, ay: number, dx: number, dy: number, eps: number): Pt[] {
  const out: Pt[] = [];
  const n = poly.length;
  if (!n) return out;
  const len = Math.hypot(dx, dy) || 1;
  const side = (p: Pt) => (dx * (p[1] - ay) - dy * (p[0] - ax)) / len; // > 0: left (back)
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const sp = side(p), sq = side(q);
    const pin = sp <= eps, qin = sq <= eps;
    if (pin) out.push(p);
    if (pin !== qin) {
      const t = (sp - eps) / (sp - sq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

export interface SubsectorPoly { sector: number; pts: Pt[] }

export function buildSubsectorPolys(map: MapData): SubsectorPoly[] {
  const polys: SubsectorPoly[] = new Array(map.subsectors.length);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const v of map.vertexes) { minx = Math.min(minx, v.x); miny = Math.min(miny, v.y); maxx = Math.max(maxx, v.x); maxy = Math.max(maxy, v.y); }
  minx -= 64; miny -= 64; maxx += 64; maxy += 64;
  const box: Pt[] = [[minx, miny], [minx, maxy], [maxx, maxy], [maxx, miny]];
  const subsectorSector = (ss: number) => {
    const s = map.subsectors[ss];
    const seg = map.segs[s.first];
    const line = map.lines[seg.line];
    const side = seg.side ? line.back : line.front;
    return map.sides[side]?.sector ?? 0;
  };
  const leaf = (ss: number, poly: Pt[]) => {
    const s = map.subsectors[ss];
    let p = poly;
    for (let i = 0; i < s.count; i++) {
      const seg = map.segs[s.first + i];
      const a = map.vertexes[seg.v1], b = map.vertexes[seg.v2];
      // the subsector lies to the right of its segs; tolerate node builder rounding
      p = clip(p, a.x, a.y, b.x - a.x, b.y - a.y, 0.6);
    }
    polys[ss] = { sector: subsectorSector(ss), pts: p };
  };
  const walk = (child: number, poly: Pt[]) => {
    if (child & NF_SUBSECTOR) { leaf(child & ~NF_SUBSECTOR, poly); return; }
    const nd = map.nodes[child];
    // front (right) side
    walk(nd.children[0], clip(poly, nd.x, nd.y, nd.dx, nd.dy, 0.01));
    // back (left) side: flip the partition direction
    walk(nd.children[1], clip(poly, nd.x, nd.y, -nd.dx, -nd.dy, 0.01));
  };
  if (map.nodes.length) walk(map.nodes.length - 1, box);
  else leaf(0, box);

  // snap to map vertices, then fix T-junctions so adjacent polygons share edges
  const grid = new Map<string, Pt[]>();
  const key = (x: number, y: number) => `${Math.floor(x / 32)},${Math.floor(y / 32)}`;
  const addPt = (p: Pt) => { const k = key(p[0], p[1]); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(p); };
  const near = (x: number, y: number, r: number, f: (p: Pt) => void) => {
    const gx = Math.floor(x / 32), gy = Math.floor(y / 32);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const a = grid.get(`${gx + i},${gy + j}`);
      if (a) for (const p of a) if (Math.abs(p[0] - x) <= r && Math.abs(p[1] - y) <= r) f(p);
    }
  };
  for (const v of map.vertexes) addPt([v.x, v.y]);
  for (const poly of polys) {
    if (!poly) continue;
    const out: Pt[] = [];
    for (const p of poly.pts) {
      let best: Pt | null = null, bd = 0.75;
      near(p[0], p[1], 0.75, (q) => { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = q; } });
      const s: Pt = best ?? p;
      if (!best) addPt(s);
      const last = out[out.length - 1];
      if (!last || Math.abs(last[0] - s[0]) > 1e-3 || Math.abs(last[1] - s[1]) > 1e-3) out.push(s);
    }
    while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < 1e-3 && Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-3) out.pop();
    poly.pts = out;
  }
  for (const poly of polys) {
    if (!poly || poly.pts.length < 3) continue;
    const out: Pt[] = [];
    const n = poly.pts.length;
    for (let i = 0; i < n; i++) {
      const a = poly.pts[i], b = poly.pts[(i + 1) % n];
      out.push(a);
      const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
      if (len2 < 1) continue;
      const inserts: [number, Pt][] = [];
      const steps = Math.ceil(Math.sqrt(len2) / 32);
      const seen = new Set<Pt>();
      for (let s = 0; s <= steps; s++) {
        const cx = a[0] + (dx * s) / steps, cy = a[1] + (dy * s) / steps;
        near(cx, cy, 33, (q) => {
          if (q === a || q === b || seen.has(q)) return;
          seen.add(q);
          const t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len2;
          if (t <= 1e-4 || t >= 1 - 1e-4) return;
          const ex = a[0] + dx * t - q[0], ey = a[1] + dy * t - q[1];
          if (ex * ex + ey * ey < 0.02) inserts.push([t, q]);
        });
      }
      inserts.sort((u, v) => u[0] - v[0]);
      for (const [, q] of inserts) out.push(q);
    }
    poly.pts = out;
  }
  return polys;
}

export interface MapGeometry {
  walls: THREE.BufferGeometry;
  masked: THREE.BufferGeometry;
  flats: THREE.BufferGeometry;
  sky: THREE.BufferGeometry;
  polys: SubsectorPoly[];
  /** sector adjacency: for each sector, [otherSector, lineIndex] pairs */
  adjacency: [number, number][][];
  bounds: { minx: number; miny: number; maxx: number; maxy: number };
}

/**
 * Wall vertex layout (all float):
 *   position (x, y, 0)
 *   aW0 = (u texels at this vertex, side index, part, top(1)/bottom(0))
 *   aW1 = (front sector, back sector (-1), flags, row offset)
 *   aW2 = (normal x, normal y, line index, 0)
 */
export function buildGeometry(map: MapData, assets: RenderAssets): MapGeometry {
  const isSkyCeil = (s: number) => map.sectors[s].ceilPic === 'F_SKY1';
  const wall = { pos: [] as number[], w0: [] as number[], w1: [] as number[], w2: [] as number[], idx: [] as number[] };
  const mask = { pos: [] as number[], w0: [] as number[], w1: [] as number[], w2: [] as number[], idx: [] as number[] };
  const sky = { pos: [] as number[], s0: [] as number[], idx: [] as number[] };

  const quad = (dst: typeof wall, ax: number, ay: number, bx: number, by: number, u0: number, u1: number, side: number, part: number,
    front: number, back: number, flags: number, yoff: number, nx: number, ny: number, line: number) => {
    const base = dst.pos.length / 3;
    // 0: a-top, 1: b-top, 2: b-bottom, 3: a-bottom
    const vs: [number, number, number, number][] = [[ax, ay, u0, 1], [bx, by, u1, 1], [bx, by, u1, 0], [ax, ay, u0, 0]];
    for (const [x, y, u, top] of vs) {
      dst.pos.push(x, y, 0);
      dst.w0.push(u, side, part, top);
      dst.w1.push(front, back, flags, yoff);
      dst.w2.push(nx, ny, line, 0);
    }
    // front face: seen from the right side of a→b; counter-clockwise from the viewer
    dst.idx.push(base, base + 3, base + 1, base + 1, base + 3, base + 2);
  };
  // sky: s0 = (front sector, back sector, kind, top) kind 0 = ceiling plane, 1 = wall between sky ceilings
  const skyQuad = (ax: number, ay: number, bx: number, by: number, front: number, back: number) => {
    const base = sky.pos.length / 3;
    for (const [x, y, top] of [[ax, ay, 1], [bx, by, 1], [bx, by, 0], [ax, ay, 0]]) {
      sky.pos.push(x, y, 0);
      sky.s0.push(front, back, 1, top);
    }
    sky.idx.push(base, base + 3, base + 1, base + 1, base + 3, base + 2);
  };

  const adjacency: [number, number][][] = map.sectors.map(() => []);
  map.lines.forEach((l, li) => {
    if (l.front < 0 || l.back < 0) return;
    const a = map.sides[l.front].sector, b = map.sides[l.back].sector;
    if (a === b) return;
    adjacency[a].push([b, li]);
    adjacency[b].push([a, li]);
  });

  for (const seg of map.segs) {
    const line = map.lines[seg.line];
    const sideIdx = seg.side ? line.back : line.front;
    const otherIdx = seg.side ? line.front : line.back;
    if (sideIdx < 0) continue;
    const side = map.sides[sideIdx];
    const v1 = map.vertexes[seg.v1], v2 = map.vertexes[seg.v2];
    const dx = v2.x - v1.x, dy = v2.y - v1.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const nx = dy / len, ny = -dx / len; // right-hand normal: points into the front sector
    const u0 = seg.offset + side.xoff, u1 = u0 + len;
    let flags = 0;
    if (line.flags & ML_DONTPEGTOP) flags |= WF_PEGTOP;
    if (line.flags & ML_DONTPEGBOTTOM) flags |= WF_PEGBOTTOM;
    if (line.special === 48) flags |= WF_SCROLL;
    if (v1.y === v2.y) flags |= WF_DARKER;
    else if (v1.x === v2.x) flags |= WF_LIGHTER;
    const front = side.sector;
    if (otherIdx < 0) {
      if (assets.textureId(side.mid) >= 0) quad(wall, v1.x, v1.y, v2.x, v2.y, u0, u1, sideIdx, PART_MID, front, -1, flags, side.yoff, nx, ny, seg.line);
      continue;
    }
    const back = map.sides[otherIdx].sector;
    const bothSky = isSkyCeil(front) && isSkyCeil(back);
    if (bothSky) {
      // Doom's sky hack: no upper texture between two sky ceilings; the gap shows sky
      skyQuad(v1.x, v1.y, v2.x, v2.y, front, back);
    } else if (assets.textureId(side.top) >= 0) {
      quad(wall, v1.x, v1.y, v2.x, v2.y, u0, u1, sideIdx, PART_UPPER, front, back, flags, side.yoff, nx, ny, seg.line);
    }
    if (assets.textureId(side.bottom) >= 0) quad(wall, v1.x, v1.y, v2.x, v2.y, u0, u1, sideIdx, PART_LOWER, front, back, flags, side.yoff, nx, ny, seg.line);
    if (assets.textureId(side.mid) >= 0) quad(mask, v1.x, v1.y, v2.x, v2.y, u0, u1, sideIdx, PART_MASKED, front, back, flags, side.yoff, nx, ny, seg.line);
  }

  // flats: per subsector polygon, floor and ceiling (sky ceilings go to the sky mesh)
  const polys = buildSubsectorPolys(map);
  const fpos: number[] = [], fattr: number[] = [], fidx: number[] = [];
  for (const poly of polys) {
    if (!poly || poly.pts.length < 3) continue;
    const s = poly.sector;
    const pts = poly.pts; // clockwise in map coords (right side of segs)
    // floor: visible from above. Map coords are x right, y up; clockwise when seen from +z
    const fb = fpos.length / 3;
    for (const p of pts) { fpos.push(p[0], p[1], 0); fattr.push(s, 0); }
    for (let i = 1; i + 1 < pts.length; i++) fidx.push(fb, fb + i + 1, fb + i);
    if (isSkyCeil(s)) {
      const sb = sky.pos.length / 3;
      for (const p of pts) { sky.pos.push(p[0], p[1], 0); sky.s0.push(s, -1, 0, 1); }
      for (let i = 1; i + 1 < pts.length; i++) sky.idx.push(sb, sb + i, sb + i + 1);
    } else {
      const cb = fpos.length / 3;
      for (const p of pts) { fpos.push(p[0], p[1], 0); fattr.push(s, 1); }
      for (let i = 1; i + 1 < pts.length; i++) fidx.push(cb, cb + i, cb + i + 1);
    }
  }

  const mk = (d: typeof wall) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(d.pos, 3));
    g.setAttribute('aW0', new THREE.Float32BufferAttribute(d.w0, 4));
    g.setAttribute('aW1', new THREE.Float32BufferAttribute(d.w1, 4));
    g.setAttribute('aW2', new THREE.Float32BufferAttribute(d.w2, 4));
    g.setIndex(d.idx);
    return g;
  };
  const flats = new THREE.BufferGeometry();
  flats.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
  flats.setAttribute('aF', new THREE.Float32BufferAttribute(fattr, 2));
  flats.setIndex(fidx);
  const skyG = new THREE.BufferGeometry();
  skyG.setAttribute('position', new THREE.Float32BufferAttribute(sky.pos, 3));
  skyG.setAttribute('aS', new THREE.Float32BufferAttribute(sky.s0, 4));
  skyG.setIndex(sky.idx);

  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const v of map.vertexes) { minx = Math.min(minx, v.x); miny = Math.min(miny, v.y); maxx = Math.max(maxx, v.x); maxy = Math.max(maxy, v.y); }
  return { walls: mk(wall), masked: mk(mask), flats, sky: skyG, polys, adjacency, bounds: { minx, miny, maxx, maxy } };
}


/**
 * Contact-shadow texture for flats: for each 8-unit cell, how close the nearest wall
 * is that rises above this floor (R) / drops below this ceiling (G), as 0..255
 * (255 = no darkening). Built once from load-time heights.
 */
export function buildAoTexture(map: MapData, bounds: MapGeometry['bounds']): { tex: THREE.DataTexture; origin: [number, number]; cell: number; size: [number, number] } {
  const cell = 8, R = 40;
  const ox = bounds.minx - R, oy = bounds.miny - R;
  const w = Math.ceil((bounds.maxx - bounds.minx + 2 * R) / cell), h = Math.ceil((bounds.maxy - bounds.miny + 2 * R) / cell);
  const fl = new Float32Array(w * h).fill(1e9); // distance to a wall above the floor
  const cl = new Float32Array(w * h).fill(1e9);
  // per-line: which heights it blocks; floor occluder top = max floor of both sides (or +inf)
  for (const l of map.lines) {
    const a = map.vertexes[l.v1], b = map.vertexes[l.v2];
    const fs = l.front >= 0 ? map.sectors[map.sides[l.front].sector] : null;
    const bs = l.back >= 0 ? map.sectors[map.sides[l.back].sector] : null;
    // a two-sided line darkens only the lower floor next to a step of >= 8 units
    const floorTop = fs && bs ? Math.max(fs.floor, bs.floor) : Infinity;
    const floorLow = fs && bs ? Math.min(fs.floor, bs.floor) : -Infinity;
    const ceilBot = fs && bs ? Math.min(fs.ceil, bs.ceil) : -Infinity;
    const ceilHigh = fs && bs ? Math.max(fs.ceil, bs.ceil) : Infinity;
    const doFloor = !(fs && bs) || floorTop - floorLow >= 8;
    const doCeil = !(fs && bs) || ceilHigh - ceilBot >= 8;
    if (!doFloor && !doCeil) continue;
    const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - R - ox) / cell)), x1 = Math.min(w - 1, Math.ceil((Math.max(a.x, b.x) + R - ox) / cell));
    const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - R - oy) / cell)), y1 = Math.min(h - 1, Math.ceil((Math.max(a.y, b.y) + R - oy) / cell));
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = ox + (x + 0.5) * cell, py = oy + (y + 0.5) * cell;
      const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
      const d = Math.hypot(a.x + dx * t - px, a.y + dy * t - py);
      const i = y * w + x;
      if (fs && bs) {
        // only the side whose floor is lower is in the corner
        const side = (dx * (py - a.y) - dy * (px - a.x)) > 0 ? 'back' : 'front';
        const mySec = side === 'front' ? fs : bs;
        if (doFloor && mySec.floor === floorLow && d < fl[i]) fl[i] = d;
        if (doCeil && mySec.ceil === ceilHigh && d < cl[i]) cl[i] = d;
      } else {
        if (d < fl[i]) fl[i] = d;
        if (d < cl[i]) cl[i] = d;
      }
    }
  }
  const data = new Uint8Array(w * h * 2);
  for (let i = 0; i < w * h; i++) {
    data[i * 2] = Math.min(255, Math.round((Math.min(fl[i], R) / R) * 255));
    data[i * 2 + 1] = Math.min(255, Math.round((Math.min(cl[i], R) / R) * 255));
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { tex, origin: [ox, oy], cell, size: [w, h] };
}
