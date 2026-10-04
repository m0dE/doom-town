// Battle royale sprites the base pak doesn't have (DESIGN.md "Battle royale v2"): the
// sniper rifle's pickup (SNPR A), its weapon psprite (SNPG A ready, B fire, C-D bolt),
// its muzzle flash (SNPF A) and the grenade (GREN A).
//
// They are drawn here, in code: a tiny low-poly model of the rifle (and the grenade) is
// rasterised in software (perspective for the psprite, 3/4 orthographic for the
// pickups), 2x supersampled, shaded with a key light, then quantised to the WAD's own
// palette and encoded as Doom patches. `injectBrSprites` adds them to the WAD's sprite
// namespace before the renderer builds its sprite atlas, so the psprite and thing paths
// draw them like any Doom sprite. A WAD (a mod) that ships its own SNPR/SNPG/SNPF/GREN
// lumps keeps them.
import { nearestIndex, readPalette, type PaletteData, type Wad } from '../../wad';

type V3 = [number, number, number];
interface Mat { rgb: V3; grain?: number; spec?: number; glow?: boolean }
interface Tri { p: V3[]; n: V3[]; l: V3[]; m: Mat }

// ---- materials (sRGB 0..255) -----------------------------------------------------
const STEEL: Mat = { rgb: [92, 96, 104], spec: 0.9 };
const BLUED: Mat = { rgb: [60, 64, 76], spec: 1.0 };
const RUBBER: Mat = { rgb: [26, 26, 28], spec: 0.2 };
const WOOD: Mat = { rgb: [128, 76, 38], grain: 1, spec: 0.25 };
const WOOD_DARK: Mat = { rgb: [92, 52, 26], grain: 1, spec: 0.2 };
const LENS: Mat = { rgb: [70, 120, 170], spec: 1.4, glow: true };
const OLIVE: Mat = { rgb: [78, 92, 46], spec: 0.5 };
const OLIVE_DARK: Mat = { rgb: [52, 62, 30], spec: 0.3 };
const BRASS: Mat = { rgb: [176, 140, 64], spec: 1.2 };

// ---- mesh building ---------------------------------------------------------------
class Mesh {
  tris: Tri[] = [];
  private add(p: V3[], n: V3[], m: Mat): void { this.tris.push({ p, n, l: p.map((v) => [...v] as V3), m }); }

  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, m: Mat, taper = 1): this {
    // taper scales the +z end's x/y extent about the box centre
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const P = (x: number, y: number, z: number): V3 => {
      const k = z === z1 ? taper : 1;
      return [cx + (x - cx) * k, cy + (y - cy) * k, z];
    };
    const q = (a: V3, b: V3, c: V3, d: V3, n: V3) => { this.add([a, b, c], [n, n, n], m); this.add([a, c, d], [n, n, n], m); };
    const c = [P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0), P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)];
    q(c[0], c[3], c[2], c[1], [0, 0, -1]);
    q(c[4], c[5], c[6], c[7], [0, 0, 1]);
    q(c[0], c[1], c[5], c[4], [0, -1, 0]);
    q(c[3], c[7], c[6], c[2], [0, 1, 0]);
    q(c[0], c[4], c[7], c[3], [-1, 0, 0]);
    q(c[1], c[2], c[6], c[5], [1, 0, 0]);
    return this;
  }

  /** A cylinder along z (or x when axis = 'x'), radius r0 at z0 and r1 at z1, capped. */
  cyl(cx: number, cy: number, r0: number, r1: number, z0: number, z1: number, m: Mat, seg = 12, axis: 'z' | 'x' = 'z'): this {
    const map = (a: number, b: number, z: number): V3 => (axis === 'z' ? [cx + a, cy + b, z] : [z, cy + b, cx + a]);
    const nm = (a: number, b: number, nz: number): V3 => (axis === 'z' ? [a, b, nz] : [nz, b, a]);
    const slope = (r0 - r1) / Math.max(1e-6, z1 - z0);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const p00 = map(c0 * r0, s0 * r0, z0), p01 = map(c1 * r0, s1 * r0, z0), p10 = map(c0 * r1, s0 * r1, z1), p11 = map(c1 * r1, s1 * r1, z1);
      const n0 = norm(nm(c0, s0, slope)), n1 = norm(nm(c1, s1, slope));
      this.add([p00, p01, p11], [n0, n1, n1], m);
      this.add([p00, p11, p10], [n0, n1, n0], m);
      const e0 = nm(0, 0, -1), e1 = nm(0, 0, 1);
      this.add([map(0, 0, z0), p01, p00], [e0, e0, e0], m);
      this.add([map(0, 0, z1), p10, p11], [e1, e1, e1], m);
    }
    return this;
  }

  /** An ellipsoid. */
  ball(c: V3, r: V3, m: Mat, seg = 10): this {
    const P = (u: number, v: number): [V3, V3] => {
      const th = (u / seg) * Math.PI * 2, ph = (v / (seg / 2)) * Math.PI - Math.PI / 2;
      const d: V3 = [Math.cos(ph) * Math.cos(th), Math.sin(ph), Math.cos(ph) * Math.sin(th)];
      return [[c[0] + d[0] * r[0], c[1] + d[1] * r[1], c[2] + d[2] * r[2]], norm([d[0] / r[0], d[1] / r[1], d[2] / r[2]])];
    };
    for (let u = 0; u < seg; u++) for (let v = 0; v < seg / 2; v++) {
      const a = P(u, v), b = P(u + 1, v), cc = P(u + 1, v + 1), d = P(u, v + 1);
      this.add([a[0], b[0], cc[0]], [a[1], b[1], cc[1]], m);
      this.add([a[0], cc[0], d[0]], [a[1], cc[1], d[1]], m);
    }
    return this;
  }

  /** Transform (rotate about x then y then z, in degrees; then translate). */
  xform(rx: number, ry: number, rz: number, t: V3): Mesh {
    const R = rot(rx, ry, rz);
    const out = new Mesh();
    out.tris = this.tris.map((tr) => ({
      p: tr.p.map((v) => add(mul(R, v), t)), n: tr.n.map((v) => mul(R, v)), l: tr.l, m: tr.m,
    }));
    return out;
  }
}

const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function rot(rx: number, ry: number, rz: number): number[] {
  const [a, b, c] = [rx, ry, rz].map((d) => (d * Math.PI) / 180);
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  // Rz * Ry * Rx
  return [
    cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa,
    sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa,
    -sb, cb * sa, cb * ca,
  ];
}
const mul = (R: number[], v: V3): V3 => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];

// ---- the models ----------------------------------------------------------------------
/** The rifle, rifle space: x right, y up, z along the barrel (muzzle at z ≈ 44). `bolt` 0 closed .. 1 pulled back. */
function rifle(bolt = 0, fat = 1): Mesh {
  const m = new Mesh();
  // stock: butt, grip, cheek rest
  m.box(-0.8, 0.8, -3.6, 0.2, -17, -8, WOOD, 1);
  m.box(-0.7, 0.7, -2.4, 0.4, -8, -3, WOOD, 1);
  m.box(-0.75, 0.75, 0.2, 0.9, -15, -9, WOOD_DARK);
  m.box(-0.85, 0.85, -3.8, -3.3, -17.4, -17, RUBBER);
  m.box(-0.55, 0.55, -4.2, -1.6, -4.6, -2.6, WOOD_DARK); // pistol grip
  // receiver, magazine, trigger guard
  m.box(-0.9, 0.9, -1.0, 0.9, -3, 8, BLUED);
  m.box(-0.6, 0.6, -2.9, -1.0, 2, 5, STEEL, 0.95);
  m.box(-0.25, 0.25, -2.0, -1.0, -2.2, 1.4, STEEL);
  // forend under the barrel
  m.box(-1.05, 1.05, -2.0, 0.1, 8, 21, WOOD, 0.85);
  m.box(-0.5, 0.5, -2.2, -1.9, 9, 20, WOOD_DARK);
  // barrel and muzzle brake
  m.cyl(0, 0, 0.55 * fat, 0.42 * fat, 7, 41, BLUED, 10);
  m.cyl(0, 0, 0.72, 0.72, 41, 44.5, STEEL, 8);
  m.box(-0.9, 0.9, -0.2, 0.2, 42, 44, RUBBER);
  // scope: mounts, tube, bells, lens, turrets
  m.box(-0.35, 0.35, 0.8, 1.7, -1, 0.4, STEEL);
  m.box(-0.35, 0.35, 0.8, 1.7, 6.2, 7.6, STEEL);
  m.cyl(0, 2.3, 0.72, 0.72, -2.5, 11, BLUED, 12);
  m.cyl(0, 2.3, 1.05, 0.75, -5.2, -2.5, BLUED, 12);
  m.cyl(0, 2.3, 0.75, 1.3, 11, 15.5, BLUED, 12);
  m.cyl(0, 2.3, 0.82, 0.82, -5.3, -5.15, RUBBER, 12);
  m.cyl(0, 2.3, 1.08, 1.08, 15.4, 15.6, LENS, 12);
  m.box(-0.45, 0.45, 2.9, 3.6, 3.4, 4.6, STEEL);
  m.box(0.6, 1.6, 2.0, 2.6, 3.4, 4.6, STEEL);
  // bolt and handle (right side), slid back by `bolt`
  const bz = 1.2 - bolt * 3.6;
  m.cyl(0, 0.35, 0.42, 0.42, bz - 1.5, bz + 1.5, STEEL, 8);
  m.cyl(bz, 0.2, 0.22, 0.22, 0.9, 2.6, STEEL, 6, 'x');
  m.ball([2.75, 0.2, bz], [0.5, 0.5, 0.5], STEEL, 8);
  return m;
}

function grenade(): Mesh {
  const m = new Mesh();
  m.ball([0, 0, 0], [1.0, 1.3, 1.0], OLIVE, 12);
  m.cyl(0, 0, 0.42, 0.42, 1.1, 1.75, OLIVE_DARK, 8, 'z');
  // the spoon down the side and the pin ring
  m.box(0.75, 1.05, -0.8, 1.6, -0.2, 0.2, STEEL);
  m.cyl(0, -0.55, 0.45, 0.45, 1.3, 1.45, BRASS, 8, 'z');
  // stand it up: the "cyl along z" pieces were built along z, the body along y
  for (const t of m.tris) if (t.m === OLIVE_DARK || t.m === BRASS) for (let i = 0; i < 3; i++) {
    const p = t.p[i]; t.p[i] = [p[0], p[2], -p[1]];
    const n = t.n[i]; t.n[i] = [n[0], n[2], -n[1]];
  }
  return m;
}

// ---- rasteriser ----------------------------------------------------------------------
interface Raster { w: number; h: number; rgb: Float32Array; a: Uint8Array; /** screen origin of pixel (0,0), in output pixels */ ox: number; oy: number }

const LIGHT = norm([-0.55, 0.75, -0.45]);

function shade(t: Tri, n: V3, l: V3, viewDir: V3): V3 {
  const m = t.m;
  const nd = Math.max(0, dot(n, LIGHT));
  const fill = Math.max(0, dot(n, norm([0.6, 0.2, -0.3]))) * 0.18;
  let k = 0.32 + 0.85 * nd + fill;
  if (m.grain) {
    // wood: grain stripes along the stock and forend
    const g = Math.sin(l[2] * 2.1 + Math.sin(l[1] * 3.3 + l[0] * 2.0) * 1.6) * 0.5 + 0.5;
    k *= 0.86 + 0.22 * g;
  }
  const h = norm(add(LIGHT, viewDir));
  const sp = Math.pow(Math.max(0, dot(n, h)), 18) * (m.spec ?? 0);
  const c: V3 = [m.rgb[0] * k + 210 * sp, m.rgb[1] * k + 215 * sp, m.rgb[2] * k + 225 * sp];
  if (m.glow) { c[0] += 20; c[1] += 40; c[2] += 60; }
  return c;
}

/**
 * Rasterise triangles. `project` maps a camera-space point to output pixels (x, y) and a
 * depth (smaller = nearer); null = behind the camera. `ss` supersamples.
 */
function raster(mesh: Mesh, project: (p: V3) => [number, number, number] | null, view: (p: V3) => V3,
  bx0: number, by0: number, bx1: number, by1: number, ss = 2): Raster {
  const W = (bx1 - bx0) * ss, H = (by1 - by0) * ss;
  const rgb = new Float32Array(W * H * 3), zb = new Float32Array(W * H).fill(Infinity);
  const nn: V3 = [0, 0, 0], ll: V3 = [0, 0, 0], pc: V3 = [0, 0, 0];
  for (const t of mesh.tris) {
    const P = t.p.map(project);
    if (P.some((p) => !p)) continue;
    const q = (P as [number, number, number][]).map(([x, y, z]) => [(x - bx0) * ss, (y - by0) * ss, z]);
    const area = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
    if (Math.abs(area) < 1e-9) continue;
    const minx = Math.max(0, Math.floor(Math.min(q[0][0], q[1][0], q[2][0]))), maxx = Math.min(W - 1, Math.ceil(Math.max(q[0][0], q[1][0], q[2][0])));
    const miny = Math.max(0, Math.floor(Math.min(q[0][1], q[1][1], q[2][1]))), maxy = Math.min(H - 1, Math.ceil(Math.max(q[0][1], q[1][1], q[2][1])));
    for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((q[1][0] - px) * (q[2][1] - py) - (q[2][0] - px) * (q[1][1] - py)) / area;
      const w1 = ((q[2][0] - px) * (q[0][1] - py) - (q[0][0] - px) * (q[2][1] - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * q[0][2] + w1 * q[1][2] + w2 * q[2][2];
      const o = y * W + x;
      if (z >= zb[o]) continue;
      zb[o] = z;
      for (let i = 0; i < 3; i++) {
        nn[i] = w0 * t.n[0][i] + w1 * t.n[1][i] + w2 * t.n[2][i];
        ll[i] = w0 * t.l[0][i] + w1 * t.l[1][i] + w2 * t.l[2][i];
        pc[i] = w0 * t.p[0][i] + w1 * t.p[1][i] + w2 * t.p[2][i];
      }
      const c = shade(t, norm(nn), ll, view(pc));
      rgb[o * 3] = c[0]; rgb[o * 3 + 1] = c[1]; rgb[o * 3 + 2] = c[2];
    }
  }
  // resolve the supersampling: a pixel is opaque when most of its samples are covered
  const w = bx1 - bx0, h = by1 - by0;
  const out: Raster = { w, h, rgb: new Float32Array(w * h * 3), a: new Uint8Array(w * h), ox: bx0, oy: by0 };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let n = 0; const s: V3 = [0, 0, 0];
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
      const o = (y * ss + j) * W + x * ss + i;
      if (zb[o] === Infinity) continue;
      n++; s[0] += rgb[o * 3]; s[1] += rgb[o * 3 + 1]; s[2] += rgb[o * 3 + 2];
    }
    if (n * 2 < ss * ss) continue;
    const o = y * w + x;
    out.a[o] = 1;
    out.rgb[o * 3] = s[0] / n; out.rgb[o * 3 + 1] = s[1] / n; out.rgb[o * 3 + 2] = s[2] / n;
  }
  return out;
}

/** Darken the silhouette's lower/right rim (Doom's hand-drawn sprites read by their dark edges). */
function rim(r: Raster, k = 0.62): void {
  const { w, h, a, rgb } = r;
  const edge = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * w + x;
    if (!a[o]) continue;
    const t = (dx: number, dy: number) => { const X = x + dx, Y = y + dy; return X < 0 || Y < 0 || X >= w || Y >= h || !a[Y * w + X]; };
    if (t(1, 0) || t(0, 1) || t(-1, 0) || t(0, -1)) edge[o] = 1;
  }
  for (let o = 0; o < w * h; o++) if (edge[o]) { rgb[o * 3] *= k; rgb[o * 3 + 1] *= k; rgb[o * 3 + 2] *= k; }
}

// ---- palette + patch -------------------------------------------------------------------
class Quant {
  private cache = new Map<number, number>();
  constructor(private pal: PaletteData) {}
  index(r: number, g: number, b: number): number {
    const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    const R = c(r), G = c(g), B = c(b);
    const key = ((R >> 2) << 12) | ((G >> 2) << 6) | (B >> 2);
    let i = this.cache.get(key);
    if (i === undefined) {
      // never the cyan/pink "transparent" markers some tools use, nor the palette's black 0 (keeps rims readable)
      i = nearestIndex(this.pal, R, G, B, (k) => k === 247 || k === 251 || k === 255);
      this.cache.set(key, i);
    }
    return i;
  }
}

/** Ordered 2x2 dither offsets, a touch of Doom's hand-shaded texture. */
const DITHER = [-3, 1, 3, -1];

/** A Doom patch from palette indices (row-major, -1 transparent). */
export function encodePatch(w: number, h: number, left: number, top: number, px: Int16Array): Uint8Array {
  const cols: number[][] = [];
  for (let x = 0; x < w; x++) {
    const c: number[] = [];
    let y = 0;
    while (y < h) {
      if (px[y * w + x] < 0) { y++; continue; }
      let n = 0;
      while (y + n < h && n < 254 && px[(y + n) * w + x] >= 0) n++;
      c.push(y, n, 0);
      for (let i = 0; i < n; i++) c.push(px[(y + i) * w + x]);
      c.push(0);
      y += n;
    }
    c.push(0xff);
    cols.push(c);
  }
  const size = 8 + w * 4 + cols.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, w, true); dv.setUint16(2, h, true); dv.setInt16(4, left, true); dv.setInt16(6, top, true);
  let p = 8 + w * 4;
  cols.forEach((c, x) => { dv.setUint32(8 + x * 4, p, true); out.set(c, p); p += c.length; });
  return out;
}

/** Trim a raster to its opaque bounds and quantise it. */
function toPatch(r: Raster, q: Quant, offsets: (x0: number, y0: number, w: number, h: number) => [number, number]): Uint8Array | null {
  let x0 = r.w, y0 = r.h, x1 = -1, y1 = -1;
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (r.a[y * r.w + x]) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const px = new Int16Array(w * h).fill(-1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y + y0) * r.w + x + x0;
    if (!r.a[o]) continue;
    const d = DITHER[((y + y0) & 1) * 2 + ((x + x0) & 1)];
    px[y * w + x] = q.index(r.rgb[o * 3] + d, r.rgb[o * 3 + 1] + d, r.rgb[o * 3 + 2] + d);
  }
  const [left, top] = offsets(r.ox + x0, r.oy + y0, w, h);
  return encodePatch(w, h, left, top, px);
}

// ---- the sprites -----------------------------------------------------------------------
/** Doom's 320x200 view: focal length for a 90° horizontal FOV, centre at (160, 100). */
const F = 160;
/** Rifle pose in camera space per weapon frame: [pitch (deg, + muzzle up), yaw (deg, + muzzle left), roll (deg), offset]. */
/** [extra pitch (deg, + muzzle up), extra yaw (deg, + muzzle left), roll (deg), offset, bolt]; the base aim is at the crosshair. */
const POSES: Record<string, [number, number, number, V3, number]> = {
  A: [0, 0, 0, [6, -9, 20], 0],
  B: [5, 0, -3, [6.1, -8.5, 18.4], 0],        // recoil: muzzle up, kicked back
  C: [4, 6, 20, [6.4, -9.8, 19.5], 1],         // bolt back, rifle canted
  D: [2, 3, 10, [6.2, -9.4, 19.7], 0.35],      // bolt going home
};
/** the point on the view axis the rifle aims at */
const AIM = 90;
const WEAPONTOP = 32;

function pspriteRaster(frame: keyof typeof POSES): { r: Raster; muzzle: [number, number] } {
  const [dp, dy, roll, t, bolt] = POSES[frame];
  const pitch = (Math.atan2(-t[1], AIM - t[2]) * 180) / Math.PI + dp;
  const yaw = (Math.atan2(t[0], AIM - t[2]) * 180) / Math.PI + dy;
  // camera space: x right, y up, z forward; rifle rotated (roll about z, pitch about x, yaw about y)
  const mesh = rifle(bolt).xform(-pitch, -yaw, roll, t);
  const near = 1.2;
  const project = (p: V3): [number, number, number] | null => (p[2] < near ? null : [F + (F * p[0]) / p[2], 100 - (F * p[1]) / p[2], p[2]]);
  const r = raster(mesh, project, (p) => norm([-p[0], -p[1], -p[2]]), 100, 60, 320, 200, 2);
  rim(r, 0.7);
  // muzzle: the brake's far end, on the barrel axis
  const R = rot(-pitch, -yaw, roll);
  const mz = add(mul(R, [0, 0, 44.8]), t);
  const mp = project(mz)!;
  return { r, muzzle: [mp[0], mp[1]] };
}

function flashRaster(cx: number, cy: number, q: Quant): Uint8Array | null {
  const R = 19, w = 2 * R + 1;
  const px = new Int16Array(w * w).fill(-1);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const dx = x - R, dy = (y - R) * 1.1;
    const d = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
    // six spikes, the upper ones longer (the shot goes into the screen)
    const spike = Math.pow(Math.abs(Math.cos(3 * th + 0.3)), 6);
    const reach = R * (0.32 + 0.6 * spike) * (dy < 0 ? 1 : 0.8);
    if (d > reach) continue;
    const k = d / reach;
    const c: V3 = k < 0.22 ? [255, 255, 235] : k < 0.5 ? [255, 236, 120] : k < 0.78 ? [255, 168, 48] : [220, 92, 24];
    px[y * w + x] = q.index(c[0], c[1], c[2]);
  }
  return encodePatch(w, w, Math.round(1 - (cx - R)), Math.round(WEAPONTOP - (cy - R)), px);
}

function orthoRaster(mesh: Mesh, scale: number, rx: number, ry: number, rz: number): Raster {
  const m = mesh.xform(rx, ry, rz, [0, 0, 0]);
  // screen x = model x, screen y = -model y; depth = model z (camera looks along +z)
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const t of m.tris) for (const p of t.p) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, -p[1]); y1 = Math.max(y1, -p[1]); }
  const project = (p: V3): [number, number, number] => [(p[0] - x0) * scale + 1, (-p[1] - y0) * scale + 1, p[2]];
  const r = raster(m, project, () => [0, 0, -1], 0, 0, Math.ceil((x1 - x0) * scale) + 3, Math.ceil((y1 - y0) * scale) + 3, 4);
  rim(r, 0.6);
  return r;
}

/** Generates the battle royale sprites as Doom patches (lump name → patch). */
export function buildBrSprites(pal: PaletteData): Map<string, Uint8Array> {
  const q = new Quant(pal);
  const out = new Map<string, Uint8Array>();
  const put = (name: string, p: Uint8Array | null) => { if (p) out.set(name, p); };
  // weapon frames: psprite offsets so that drawn at (sx, sy) = (1, WEAPONTOP) the picture lands where it was rendered
  const psOff = (x0: number, y0: number): [number, number] => [Math.round(1 - x0), Math.round(WEAPONTOP - y0)];
  let flashAt: [number, number] = [160, 100];
  for (const f of ['A', 'B', 'C', 'D'] as const) {
    const { r, muzzle } = pspriteRaster(f);
    if (f === 'B') flashAt = muzzle;
    put(`SNPG${f}0`, toPatch(r, q, psOff));
  }
  put('SNPFA0', flashRaster(flashAt[0], flashAt[1], q));
  // pickups: centred, standing on the floor
  const thing = (x0: number, y0: number, w: number, h: number): [number, number] => { void x0; void y0; return [Math.floor(w / 2), h]; };
  // the rifle, seen from its right side and a little above, muzzle to the right
  put('SNPRA0', toPatch(orthoRaster(rifle(0, 1.7).xform(0, 90, 0, [0, 0, 0]), 1.08, -15, 0, 0), q, thing));
  put('GRENA0', toPatch(orthoRaster(grenade(), 4.2, -20, 25, 0), q, thing));
  return out;
}

/**
 * Adds the battle royale sprites to `wad`'s sprite namespace (where it has none of its
 * own), so buildSpriteDefs and the sprite atlas see them. Idempotent.
 */
export function injectBrSprites(wad: Wad, pal: PaletteData = readPalette(wad)): void {
  const ns = wad.namespace('S');
  if (ns.has('SNPGA0') && ns.has('SNPRA0') && ns.has('SNPFA0') && ns.has('GRENA0')) return;
  // drawn once per palette (a few hundred ms), then reused by every renderer
  const key = pal.playpal.subarray(0, 768).join(',');
  if (cache?.key !== key) cache = { key, lumps: buildBrSprites(pal) };
  for (const [name, data] of cache.lumps) if (!ns.has(name)) ns.set(name, { name, data, source: -1 });
}
let cache: { key: string; lumps: Map<string, Uint8Array> } | null = null;
