// Dynamic point lights. Which sprite frames emit, how far and how they move comes from
// our table (lights-table.ts); color and height are measured from the sprite's pixels.
//
// Each frame: candidates from mobjs (+ extra lights such as the local muzzle flash) →
// the nearest visible MAX_LIGHTS → uniforms, a sector "reach" mask (light does not
// leak through solid walls or closed doors) and a screen-tile light list so a pixel
// only loops over the few lights that can touch its tile (forward+ with CPU culling).
import * as THREE from 'three';
import { SPRITE_NAMES, type MapData } from '../wad';
import type { SpriteGlow } from './assets';
import { LIGHT_TABLE, type LightClass } from './lights-table';
import { MAX_LIGHTS, TILES_X, TILES_Y, TILE_MAX } from './shaders';
import type { RenderMobj } from './types';

const MAX_CAND = 1024;

/** sprite index → frame (0..28) → [class, frame intensity] */
const BY_FRAME: ([LightClass, number] | null)[][] = SPRITE_NAMES.map((name) => {
  const c = LIGHT_TABLE[name];
  const out: ([LightClass, number] | null)[] = [];
  for (let f = 0; f < 29; f++) {
    const k = c ? (c.frames ? c.frames[String.fromCharCode(65 + f)] : 1) : undefined;
    out.push(c && k !== undefined ? [c, k] : null);
  }
  return out;
});

/** small deterministic hash → 0..1 */
function rnd(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class LightManager {
  posVec: THREE.Vector4[] = [];
  colVec: THREE.Vector4[] = [];
  count = 0;
  readonly reachTex: THREE.DataTexture;
  readonly tileTex: THREE.DataTexture;
  private reach: Uint8Array;
  private tiles: Uint8Array;
  private nsec: number;

  private cx = new Float32Array(MAX_CAND); private cy = new Float32Array(MAX_CAND); private cz = new Float32Array(MAX_CAND);
  private cr = new Float32Array(MAX_CAND); private cc = new Float32Array(MAX_CAND * 3); private cs = new Int32Array(MAX_CAND);
  private score = new Float32Array(MAX_CAND); private order = new Int32Array(MAX_CAND);
  private n = 0;

  private stamp: Int32Array; private stampN = 0; private queue: Int32Array; private depthQ: Int32Array;
  private sphere = new THREE.Sphere();
  private v4 = new THREE.Vector4();
  private lineGeo: Float32Array;

  constructor(map: MapData, private adjacency: [number, number][][], private glowOf: (sprite: number, frame: number) => SpriteGlow | null) {
    this.nsec = Math.max(1, map.sectors.length);
    this.reach = new Uint8Array(this.nsec * MAX_LIGHTS);
    this.reachTex = new THREE.DataTexture(this.reach as Uint8Array<ArrayBuffer>, this.nsec, MAX_LIGHTS, THREE.RedFormat, THREE.UnsignedByteType);
    this.reachTex.minFilter = this.reachTex.magFilter = THREE.NearestFilter;
    this.reachTex.needsUpdate = true;
    this.tiles = new Uint8Array(TILES_X * TILES_Y * (TILE_MAX + 1));
    this.tileTex = new THREE.DataTexture(this.tiles as Uint8Array<ArrayBuffer>, TILES_X * TILES_Y, TILE_MAX + 1, THREE.RedFormat, THREE.UnsignedByteType);
    this.tileTex.minFilter = this.tileTex.magFilter = THREE.NearestFilter;
    this.tileTex.needsUpdate = true;
    this.stamp = new Int32Array(this.nsec);
    this.queue = new Int32Array(this.nsec);
    this.depthQ = new Int32Array(this.nsec);
    for (let i = 0; i < MAX_LIGHTS; i++) { this.posVec.push(new THREE.Vector4()); this.colVec.push(new THREE.Vector4()); }
    this.lineGeo = new Float32Array(map.lines.length * 4);
    map.lines.forEach((l, i) => {
      const a = map.vertexes[l.v1], b = map.vertexes[l.v2];
      this.lineGeo.set([a.x, a.y, b.x, b.y], i * 4);
    });
  }

  begin(): void { this.n = 0; }

  /** Adds a light; `radius` is the full reach in map units. */
  add(x: number, y: number, z: number, radius: number, r: number, g: number, b: number, sector: number): void {
    if (this.n >= MAX_CAND || radius <= 0 || Math.abs(r) + Math.abs(g) + Math.abs(b) <= 0.005) return;
    const i = this.n++;
    this.cx[i] = x; this.cy[i] = y; this.cz[i] = z; this.cr[i] = radius;
    this.cc[i * 3] = r; this.cc[i * 3 + 1] = g; this.cc[i * 3 + 2] = b; this.cs[i] = sector;
  }

  /** True if this sprite frame emits light. */
  static hasLight(sprite: number, frame: number): boolean { return !!BY_FRAME[sprite]?.[frame & 0x7fff]; }

  /** The light this mobj's current sprite frame emits, if any. */
  addMobj(m: RenderMobj, sector: number, time: number): void {
    const e = BY_FRAME[m.sprite]?.[m.frame & 0x7fff];
    if (!e) return;
    const [c, fk] = e;
    const g = this.glowOf(m.sprite, m.frame);
    if (!g) return;
    let k = c.intensity * fk;
    if (c.flicker) k *= 1 - c.flicker * rnd(m.id, Math.floor(time * 35 / 3));
    if (c.pulse) k *= 1 - c.pulse[1] * (0.5 + 0.5 * Math.sin((time / c.pulse[0] + rnd(m.id, 7)) * Math.PI * 2));
    this.add(m.x, m.y, m.z + (c.z ?? g.z), c.radius, g.color[0] * k, g.color[1] * k, g.color[2] * k, sector);
  }

  /**
   * Picks the nearest visible lights, fills uniforms, the reach mask and tile lists.
   * `floor`/`ceil` are current sector heights.
   */
  finish(cam: THREE.Vector3, frustum: THREE.Frustum, projView: THREE.Matrix4, floor: Float32Array, ceil: Float32Array, enabled: boolean): void {
    let m = 0;
    if (enabled) {
      for (let i = 0; i < this.n; i++) {
        this.sphere.center.set(this.cx[i], this.cy[i], this.cz[i]);
        this.sphere.radius = this.cr[i];
        if (!frustum.intersectsSphere(this.sphere)) continue;
        const dx = this.cx[i] - cam.x, dy = this.cy[i] - cam.y, dz = this.cz[i] - cam.z;
        this.score[i] = Math.sqrt(dx * dx + dy * dy + dz * dz) - this.cr[i];
        this.order[m++] = i;
      }
      for (let a = 1; a < m; a++) {
        const v = this.order[a], s = this.score[v];
        let b = a - 1;
        if (b >= MAX_LIGHTS && s >= this.score[this.order[MAX_LIGHTS - 1]]) continue;
        while (b >= 0 && this.score[this.order[b]] > s) { this.order[b + 1] = this.order[b]; b--; }
        this.order[b + 1] = v;
      }
    }
    const count = Math.min(m, MAX_LIGHTS);
    this.reach.fill(0);
    this.tiles.fill(0);
    const T = TILES_X * TILES_Y;
    for (let k = 0; k < count; k++) {
      const i = this.order[k];
      this.posVec[k].set(this.cx[i], this.cy[i], this.cz[i], this.cr[i]);
      this.colVec[k].set(this.cc[i * 3], this.cc[i * 3 + 1], this.cc[i * 3 + 2], 0);
      this.flood(k, this.cs[i], this.cx[i], this.cy[i], this.cr[i], floor, ceil);
      // screen rect of the light's bounding box → tiles
      let x0 = 1, y0 = 1, x1 = -1, y1 = -1, behind = false;
      const r = this.cr[i];
      for (let c = 0; c < 8; c++) {
        this.v4.set(this.cx[i] + (c & 1 ? r : -r), this.cy[i] + (c & 2 ? r : -r), this.cz[i] + (c & 4 ? r : -r), 1).applyMatrix4(projView);
        if (this.v4.w <= 1) { behind = true; break; }
        const nx = this.v4.x / this.v4.w, ny = this.v4.y / this.v4.w;
        x0 = Math.min(x0, nx); x1 = Math.max(x1, nx); y0 = Math.min(y0, ny); y1 = Math.max(y1, ny);
      }
      if (behind) { x0 = -1; y0 = -1; x1 = 1; y1 = 1; }
      const tx0 = Math.max(0, Math.floor((x0 * 0.5 + 0.5) * TILES_X)), tx1 = Math.min(TILES_X - 1, Math.floor((x1 * 0.5 + 0.5) * TILES_X));
      const ty0 = Math.max(0, Math.floor((y0 * 0.5 + 0.5) * TILES_Y)), ty1 = Math.min(TILES_Y - 1, Math.floor((y1 * 0.5 + 0.5) * TILES_Y));
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
        const t = ty * TILES_X + tx;
        const n = this.tiles[t];
        if (n >= TILE_MAX) continue;
        this.tiles[(n + 1) * T + t] = k;
        this.tiles[t] = n + 1;
      }
    }
    this.count = count;
    this.reachTex.needsUpdate = true;
    this.tileTex.needsUpdate = true;
  }

  /** Marks sectors light `k` can reach: through open two-sided lines within its radius. */
  private flood(k: number, start: number, x: number, y: number, r: number, floor: Float32Array, ceil: Float32Array): void {
    if (start < 0 || start >= this.nsec) return;
    const st = ++this.stampN;
    let qh = 0, qt = 0;
    this.queue[qt] = start; this.depthQ[qt++] = 0; this.stamp[start] = st;
    const row = k * this.nsec;
    const r2 = r * r;
    while (qh < qt) {
      const s = this.queue[qh], d = this.depthQ[qh++];
      this.reach[row + s] = 255;
      if (d >= 3) continue;
      const adj = this.adjacency[s];
      for (let j = 0; j < adj.length; j++) {
        const o = adj[j][0];
        if (this.stamp[o] === st) continue;
        if (Math.min(ceil[s], ceil[o]) - Math.max(floor[s], floor[o]) <= 0) continue; // closed door / lift
        const li = adj[j][1] * 4, g = this.lineGeo;
        const ax = g[li], ay = g[li + 1], dx = g[li + 2] - ax, dy = g[li + 3] - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        const ex = ax + dx * t - x, ey = ay + dy * t - y;
        if (ex * ex + ey * ey > r2) continue;
        this.stamp[o] = st;
        this.queue[qt] = o; this.depthQ[qt++] = d + 1;
      }
    }
  }

  /** Sum of light colors at a point (for the weapon sprite), ignoring normals. */
  lightAt(x: number, y: number, z: number, sector: number, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    for (let k = 0; k < this.count; k++) {
      const p = this.posVec[k];
      if (sector >= 0 && !this.reach[k * this.nsec + sector]) continue;
      const dx = p.x - x, dy = p.y - y, dz = p.z - z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= p.w) continue;
      const a = 1 - d / p.w;
      out.x += this.colVec[k].x * a; out.y += this.colVec[k].y * a; out.z += this.colVec[k].z * a;
    }
    return out;
  }

  dispose(): void { this.reachTex.dispose(); this.tileTex.dispose(); }
}
