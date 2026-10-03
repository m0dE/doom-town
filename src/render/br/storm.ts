// The storm (battle royale's zone, DESIGN.md "Battle royale v2"): a translucent,
// animated purple-blue wall standing on the current zone circle, from below the lowest
// floor to far above the highest ceiling, visible from anywhere (depth-tested against
// the world, both sides, not writing depth); it glows where it meets the ground. The
// next circle is a faint white curtain a few units high on the ground.
//
// One unit cylinder of SEG columns; per column the floor height under the circle is
// sampled on the CPU (aFloor), so the ground glow and the curtain follow the terrain.
import * as THREE from 'three';
import { COMMON } from '../shaders';

const SEG = 192;

const VS = /* glsl */ `
#define IS_VERTEX
${COMMON}
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec4 uCircle;   // x, y, r, 0
uniform vec2 uZ;        // bottom, top (absolute) - the curtain: height above the floor
uniform float uCurtain; // 1: a short curtain standing on aFloor
in vec3 position;       // cos, sin, 0 bottom / 1 top
in float aFloor;
out vec3 vWorld;
out float vFloor;
out float vU;
out float vT;
void main() {
  float z = uCurtain > 0.5 ? aFloor + position.z * uZ.y : mix(uZ.x, uZ.y, position.z);
  vec3 wp = vec3(uCircle.xy + position.xy * uCircle.z, z);
  vWorld = wp;
  vFloor = aFloor;
  vU = atan(position.y, position.x) * uCircle.z;
  vT = position.z;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
}
`;

const FS = /* glsl */ `
${COMMON}
uniform float uTime;
uniform vec4 uCircle;
uniform vec2 uZ;
uniform float uCurtain;
uniform float uStrength;
in vec3 vWorld;
in float vFloor;
in float vU;
in float vT;
out vec4 fragColor;
float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float h31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y);
  float b = mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y);
  return mix(a, b, f.z);
}
// noise on the wall from world x, y (no seam around the circle) and height
float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { s += a * vnoise3(p); p = p * 2.03 + 17.1; a *= 0.5; } return s / 0.875; }
void main() {
  if (uCurtain > 0.5) {
    // the next circle: a white line on the ground fading up
    float a = (1.0 - vT) * (1.0 - vT) * 0.09 * uStrength;
    fragColor = vec4(vec3(0.85, 0.9, 1.0) * a, a * 0.5);
    return;
  }
  float t = uTime;
  vec3 p = vec3(vWorld.xy / 420.0, vWorld.z / 640.0);
  // rising, swirling bands
  float n = fbm(p + vec3(t * 0.03, t * 0.02, -t * 0.22));
  float m = fbm(p * vec3(3.1, 3.1, 2.3) + vec3(-t * 0.07, t * 0.05, -t * 0.45) + n * 1.5);
  float streak = smoothstep(0.55, 0.95, vnoise3(vec3(vWorld.xy / 90.0, vWorld.z / 2400.0 - t * 0.35)));
  vec3 deep = vec3(0.16, 0.04, 0.42), bright = vec3(0.52, 0.30, 1.0);
  vec3 c = mix(deep, bright, m) + vec3(0.6, 0.5, 1.0) * streak * 0.35;
  // looking along the wall (grazing) it is thicker
  vec3 v = normalize(vWorld - uCamPos);
  vec2 nr = normalize(vWorld.xy - uCircle.xy);
  float graze = 1.0 - abs(dot(v.xy, nr)) * length(v.xy);
  float a = (0.16 + 0.22 * m + 0.25 * graze) * uStrength;
  // the edge where the wall meets the ground
  float hf = max(vWorld.z - vFloor, 0.0);
  float edge = exp(-hf / 28.0) * (0.6 + 0.25 * sin(t * 3.0 + vU / 60.0));
  // fade out high up
  a *= 1.0 - smoothstep(uZ.y - 3000.0, uZ.y, vWorld.z);
  a *= step(vFloor - 2.0, vWorld.z) * 0.85 + 0.15;
  vec3 col = c * a + vec3(0.75, 0.55, 1.0) * edge * 1.1 * uStrength;
  // premultiplied: darkens what is behind by a, adds the storm's light
  fragColor = vec4(col, a * 0.55);
}
`;

export interface Circle { x: number; y: number; r: number }

class Cylinder {
  readonly mesh: THREE.Mesh;
  readonly geo = new THREE.BufferGeometry();
  private readonly floor = new Float32Array((SEG + 1) * 2);
  private readonly floorAttr: THREE.BufferAttribute;
  readonly u: Record<string, THREE.IUniform>;
  private last = { x: NaN, y: NaN, r: NaN };

  constructor(world: Record<string, THREE.IUniform>, curtain: boolean, order: number) {
    const P: number[] = [], I: number[] = [];
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      P.push(Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a), 1);
      if (i < SEG) { const k = i * 2; I.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    this.floorAttr = new THREE.BufferAttribute(this.floor, 1);
    this.floorAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aFloor', this.floorAttr);
    this.geo.setIndex(I);
    this.u = {
      ...world, uCircle: { value: new THREE.Vector4() }, uZ: { value: new THREE.Vector2(-1024, 8192) },
      uCurtain: { value: curtain ? 1 : 0 }, uStrength: { value: 1 },
    };
    const mat = new THREE.RawShaderMaterial({
      vertexShader: VS, fragmentShader: FS, glslVersion: THREE.GLSL3, uniforms: this.u,
      side: THREE.DoubleSide, transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      // the alpha channel is the bloom's emissive mask: keep the world's
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }

  /** Move to `c`; the floor heights are resampled when the circle moved more than a few units. */
  set(c: Circle, floorAt: (x: number, y: number) => number): void {
    (this.u.uCircle.value as THREE.Vector4).set(c.x, c.y, c.r, 0);
    const L = this.last;
    if (Math.abs(L.x - c.x) + Math.abs(L.y - c.y) + Math.abs(L.r - c.r) < 4) return;
    L.x = c.x; L.y = c.y; L.r = c.r;
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const f = floorAt(c.x + Math.cos(a) * c.r, c.y + Math.sin(a) * c.r);
      this.floor[i * 2] = f; this.floor[i * 2 + 1] = f;
    }
    this.floorAttr.needsUpdate = true;
  }
}

export class Storm {
  private readonly wall: Cylinder;
  private readonly next: Cylinder;

  constructor(scene: THREE.Scene, world: Record<string, THREE.IUniform>, zMin: number, zMax: number) {
    this.wall = new Cylinder(world, false, 7);
    this.next = new Cylinder(world, true, 6);
    (this.wall.u.uZ.value as THREE.Vector2).set(zMin - 1024, zMax + 12000);
    (this.next.u.uZ.value as THREE.Vector2).set(0, 20);
    scene.add(this.wall.mesh, this.next.mesh);
  }

  /** The current circle (null: no storm) and the next one (null or the same: none). */
  update(cur: Circle | null, next: Circle | null, floorAt: (x: number, y: number) => number): void {
    this.wall.mesh.visible = !!cur && cur.r > 1;
    if (cur && cur.r > 1) this.wall.set(cur, floorAt);
    const showNext = !!next && next.r > 1 && !!cur && (Math.abs(next.r - cur.r) > 8 || Math.hypot(next.x - cur.x, next.y - cur.y) > 8);
    this.next.mesh.visible = showNext;
    if (showNext) this.next.set(next!, floorAt);
  }

  dispose(): void {
    for (const c of [this.wall, this.next]) { c.mesh.removeFromParent(); c.geo.dispose(); (c.mesh.material as THREE.Material).dispose(); }
  }
}
