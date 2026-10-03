// Low-poly models lit like the rest of Doom: every face carries a palette index, and
// the fragment shader picks its COLORMAP row from the sector light and the distance
// (wallLevel, as walls and sprites), shaded a few rows by a fixed key light, plus the
// dynamic lights. Faces may be fullbright (lamps, engine glow: they feed the bloom) or
// take the player colour translation (green ramp 112..127 → the slot's colour).
//
// Models are built from three.js primitives (Box, Cylinder, Sphere, ...) transformed and
// merged into one non-indexed BufferGeometry per part; units are Doom map units, Z up,
// facing +X (Doom angle 0).
import * as THREE from 'three';
import { nearestIndex, type PaletteData } from '../../wad';
import { COMMON } from '../shaders';

export const PALMODEL_VS = /* glsl */ `
#define IS_VERTEX
${COMMON}
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
in vec3 normal;
in vec2 aCol;      // palette index, flags (1 fullbright, 2 player colour)
out vec3 vWorld;
out vec3 vNormal;
flat out vec2 vCol;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vCol = aCol;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const PALMODEL_FS = /* glsl */ `
${COMMON}
uniform sampler2D uTrans;
uniform vec4 uObj;        // sector light, sector, translation, glow gain
uniform vec4 uObjTint;    // rgb added to the albedo-lit colour (supply red, engine pulse), w: fade (1 = opaque)
in vec3 vWorld;
in vec3 vNormal;
flat in vec2 vCol;
out vec4 fragColor;
void main() {
  float idx = vCol.x;
  int flags = int(vCol.y + 0.5);
  if ((flags & 2) != 0 && uObj.z > 0.5) idx = floor(texelFetch(uTrans, ivec2(int(idx), int(uObj.z)), 0).r * 255.0 + 0.5);
  vec3 n = normalize(vNormal);
  bool full = (flags & 1) != 0;
  // key light from above and the side: +-3 colormap rows, like Doom's fake contrast but round
  float ndl = dot(n, normalize(vec3(-0.35, 0.45, 0.82)));
  float level = full ? 0.0 : clamp(wallLevel(uObj.x, viewDepth(vWorld), 0.0) + (1.0 - ndl) * 3.5 - 3.0, 0.0, 31.0);
  if (uFixedCmap >= 0.0) level = uFixedCmap;
  vec3 c = palColor(idx, level);
  vec3 alb = palColor(idx, albedoLevel());
  vec3 dl = full ? vec3(0.0) : dynLight(vWorld, n, int(uObj.y), 0.3);
  float emis = full && uFixedCmap < 0.0 ? uObj.w * smoothstep(0.2, 0.6, luma(alb)) : 0.0;
  fragColor = vec4(max(c + alb * dl + alb * uObjTint.rgb, 0.0), emis);
}
`;

export const FULLBRIGHT = 1, PLAYER_COLOR = 2;

/** Accumulates three.js primitives into one flat-shaded, palette-coloured geometry. */
export class PalBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];
  private readonly cache = new Map<number, number>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();

  constructor(private readonly pal: PaletteData) {}

  /** Palette index nearest an sRGB colour (0xRRGGBB). */
  idx(rgb: number): number {
    let i = this.cache.get(rgb);
    if (i === undefined) {
      i = nearestIndex(this.pal, (rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, (k) => k === 247 || k === 255);
      this.cache.set(rgb, i);
    }
    return i;
  }

  /**
   * Adds a primitive: `g` is consumed (disposed). Rotation in radians (XYZ euler), then
   * translation. `color` is 0xRRGGBB (or a palette index with `raw`); `flags` FULLBRIGHT /
   * PLAYER_COLOR. `flat` re-computes face normals (the default: low poly look).
   */
  add(g: THREE.BufferGeometry, color: number, at: [number, number, number] = [0, 0, 0], rot: [number, number, number] = [0, 0, 0],
    o: { flags?: number; raw?: boolean; flat?: boolean; scale?: [number, number, number] } = {}): this {
    const s = o.scale ?? [1, 1, 1];
    this.m.compose(new THREE.Vector3(...at), this.q.setFromEuler(this.e.set(rot[0], rot[1], rot[2])), new THREE.Vector3(...s));
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    geo.applyMatrix4(this.m);
    if (o.flat !== false) geo.computeVertexNormals();
    // computeVertexNormals on non-indexed geometry gives face normals
    const P = geo.getAttribute('position'), N = geo.getAttribute('normal');
    const ci = o.raw ? color : this.idx(color);
    for (let i = 0; i < P.count; i++) {
      this.pos.push(P.getX(i), P.getY(i), P.getZ(i));
      this.nrm.push(N.getX(i), N.getY(i), N.getZ(i));
      this.col.push(ci, o.flags ?? 0);
    }
    geo.dispose();
    return this;
  }

  /** An axis-aligned box from min to max corners. */
  box(min: [number, number, number], max: [number, number, number], color: number, o: { flags?: number; rot?: [number, number, number] } = {}): this {
    const c: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    return this.add(new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]), color, c, o.rot ?? [0, 0, 0], { flags: o.flags });
  }

  /** A cylinder between two points. */
  tube(a: [number, number, number], b: [number, number, number], r0: number, color: number, o: { r1?: number; seg?: number; flags?: number; open?: boolean } = {}): this {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
    const len = va.distanceTo(vb);
    const g = new THREE.CylinderGeometry(o.r1 ?? r0, r0, len, o.seg ?? 8, 1, o.open ?? false);
    // cylinder is along +Y; rotate it onto a→b
    const dir = vb.clone().sub(va).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const mid = va.clone().add(vb).multiplyScalar(0.5);
    const m = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m);
    return this.add(g, color, [0, 0, 0], [0, 0, 0], { flags: o.flags });
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(this.col, 2));
    g.computeBoundingSphere();
    this.pos = []; this.nrm = []; this.col = [];
    return g;
  }
}

/** A material for one drawn object (its own light/sector/translation uniforms), sharing the world's. */
export function palMaterial(world: Record<string, THREE.IUniform>, o: { side?: THREE.Side; transparent?: boolean } = {}): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    vertexShader: PALMODEL_VS, fragmentShader: PALMODEL_FS, glslVersion: THREE.GLSL3,
    uniforms: { ...world, uObj: { value: new THREE.Vector4(160, 0, 0, 1) }, uObjTint: { value: new THREE.Vector4(0, 0, 0, 1) } },
    side: o.side ?? THREE.FrontSide,
  });
}
