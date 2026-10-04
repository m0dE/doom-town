// Supply-drop smoke: a red flare smoke column rising from each supply crate, as soft
// camera-facing puffs (one instanced draw). Visual only; the puffs are a pure function of
// time and the crate's id, so nothing is simulated.
import * as THREE from 'three';
import { COMMON } from '../shaders';

const PER = 56;
const CAP = 16 * PER;
/** seconds for a puff to rise the whole column */
const LIFE = 9;
const HEIGHT = 900;

const VS = /* glsl */ `
#define IS_VERTEX
${COMMON}
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uRight;
uniform vec3 uUp;
in vec3 position;   // corner -1..1
in vec4 iPos;       // x, y, z, size
in vec4 iInfo;      // alpha, heat (0..1), seed, 0
out vec2 vQ;
flat out vec4 vInfo;
void main() {
  vec3 wp = iPos.xyz + (uRight * position.x + uUp * position.y) * iPos.w;
  vQ = position.xy;
  vInfo = iInfo;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
}
`;

const FS = /* glsl */ `
${COMMON}
uniform float uTime;
in vec2 vQ;
flat in vec4 vInfo;
out vec4 fragColor;
float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
void main() {
  float d = length(vQ);
  if (d > 1.0) discard;
  // blocky, Doom-ish puff: 8x8 cells of noise
  vec2 cell = floor((vQ * 0.5 + 0.5) * 8.0);
  float n = h21(cell + vInfo.z * 31.0);
  float a = (1.0 - smoothstep(0.35, 1.0, d)) * (0.6 + 0.4 * n) * vInfo.x;
  vec3 smoke = mix(vec3(0.16, 0.08, 0.08), vec3(0.34, 0.22, 0.22), n);
  vec3 flare = mix(vec3(0.75, 0.06, 0.03), vec3(0.95, 0.25, 0.12), n);
  vec3 c = mix(smoke, flare, vInfo.y);
  if (uFixedCmap >= 0.0) c = palColor(4.0, uFixedCmap) * luma(c);
  fragColor = vec4(c * a, a);
}
`;

export class SmokeColumns {
  readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.InstancedBufferGeometry();
  private readonly pos = new Float32Array(CAP * 4);
  private readonly info = new Float32Array(CAP * 4);
  private readonly attrs: THREE.InstancedBufferAttribute[];
  private readonly u: Record<string, THREE.IUniform>;
  private n = 0;
  /** graphics quality low: half the puffs, a little larger and denser */
  lowFx = false;

  constructor(scene: THREE.Scene, world: Record<string, THREE.IUniform>) {
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.attrs = [new THREE.InstancedBufferAttribute(this.pos, 4), new THREE.InstancedBufferAttribute(this.info, 4)];
    ['iPos', 'iInfo'].forEach((k, i) => { this.attrs[i].setUsage(THREE.DynamicDrawUsage); this.geo.setAttribute(k, this.attrs[i]); });
    this.geo.instanceCount = 0;
    this.u = { ...world, uRight: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3() } };
    this.mesh = new THREE.Mesh(this.geo, new THREE.RawShaderMaterial({
      vertexShader: VS, fragmentShader: FS, glslVersion: THREE.GLSL3, uniforms: this.u,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);
  }

  begin(camera: THREE.Camera): void {
    this.n = 0;
    const e = camera.matrixWorld.elements;
    (this.u.uRight.value as THREE.Vector3).set(e[0], e[1], e[2]);
    (this.u.uUp.value as THREE.Vector3).set(e[4], e[5], e[6]);
  }

  /** A column rising from (x, y, z) (the crate's top). */
  column(id: number, x: number, y: number, z: number, time: number): void {
    const step = this.lowFx ? 2 : 1, grow = this.lowFx ? 1.2 : 1, dense = this.lowFx ? 1.35 : 1;
    for (let i = 0; i < PER && this.n < CAP; i += step) {
      const seed = (Math.sin(id * 12.9898 + i * 78.233) * 43758.5453) % 1;
      const s = Math.abs(seed);
      const t = ((time / LIFE + i / PER + s * 0.02) % 1 + 1) % 1;
      const h = t * HEIGHT;
      // drifts downwind as it rises, wobbling
      const drift = h * 0.18;
      const wob = Math.sin(time * 0.7 + i * 1.7) * (8 + h * 0.05);
      const o = this.n++ * 4;
      this.pos[o] = x + drift * 0.8 + wob; this.pos[o + 1] = y + drift * 0.45 + Math.cos(i * 2.3 + time * 0.5) * (6 + h * 0.04); this.pos[o + 2] = z + 8 + h;
      this.pos[o + 3] = (22 + t * 110) * grow;
      this.info[o] = Math.min(1, t * 14) * (1 - t) * 0.6 * dense;
      this.info[o + 1] = Math.max(0, 1 - t * 7);
      this.info[o + 2] = s;
    }
  }

  commit(): void {
    for (const a of this.attrs) { a.clearUpdateRanges(); a.addUpdateRange(0, this.n * 4); a.needsUpdate = true; }
    this.geo.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
