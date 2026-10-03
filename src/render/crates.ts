// Battle royale loot crates (MT_CRATE, DESIGN.md "Battle royale"): a textured 3D box
// per crate instead of its sprite - sides CRATE1, top CRATOP2 from the map's art, a flat
// brown where the art has neither - lit by Doom's sector light and distance, plus the
// dynamic lights, like the walls around it.
import * as THREE from 'three';
import { COMMON, DATA } from './shaders';
import { MT_CRATE } from '../sim/abi';

export { MT_CRATE };
const CAP = 1024;

export const CRATE_VS = /* glsl */ `
#define IS_VERTEX
${COMMON}
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;   // unit box: x, y -1..1, z 0..1
in vec4 aFace;      // u, v (0..1), face (0 side, 1 top), contrast
in vec3 aNormal;
in vec4 iPos;       // x, y, z, sector
in vec4 iSize;      // radius, height, light, supply (1: a supply drop, drawn red)
out vec3 vWorld;
out vec2 vUV;
flat out vec4 vInfo;  // face, contrast, light, sector
flat out vec3 vNormal;
flat out float vSupply;
void main() {
  vec3 wp = vec3(iPos.xy + position.xy * iSize.x, iPos.z + position.z * iSize.y);
  vWorld = wp;
  vUV = aFace.xy;
  vInfo = vec4(aFace.z, aFace.w, iSize.z, iPos.w);
  vNormal = aNormal;
  vSupply = iSize.w;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
}
`;

export const CRATE_FS = /* glsl */ `
${COMMON}
${DATA}
uniform float uCrateSide;   // texture id of the sides, -1 none
uniform float uCrateTop;    // flat id of the top, -1 none
out vec4 fragColor;
in vec3 vWorld;
in vec2 vUV;
flat in vec4 vInfo;
flat in vec3 vNormal;
flat in float vSupply;
void main() {
  bool top = vInfo.x > 0.5;
  float id = top ? uCrateTop : uCrateSide;
  float idx = -1.0;
  if (id >= 0.0) {
    vec4 r = texRect(id);
    vec2 t = atlasTexel(r, vUV * r.zw);
    // a texture whose patches the pak left out has no opaque texels: use the planks
    if (t.g > 0.5) idx = floor(t.r * 255.0 + 0.5);
  }
  if (idx < 0.0) {
    // no art: planks of Doom's brown ramp
    float plank = step(0.5, fract(vUV.y * 4.0)) * 2.0 + step(0.92, fract(vUV.x * 2.0)) * 3.0;
    idx = (top ? 66.0 : 70.0) + plank;
  }
  float level = wallLevel(vInfo.z, viewDepth(vWorld), vInfo.y);
  vec3 c = palColor(idx, level);
  vec3 alb = palColor(idx, albedoLevel());
  vec3 dl = dynLight(vWorld, vNormal, int(vInfo.w), 0.0);
  float emis = 0.0;
  if (vSupply > 0.5) {
    // supply drop: painted red, a white band, and a glowing strobe on top
    float l = luma(c);
    bool band = abs(vUV.y - 0.5) < 0.08 && !top;
    vec3 red = vec3(0.75, 0.05, 0.03) * (0.35 + 1.6 * l);
    c = band ? vec3(0.9) * (0.4 + 1.2 * l) : mix(c, red, 0.8);
    alb = band ? vec3(0.9) : vec3(0.8, 0.08, 0.05);
    if (top && length(vUV - 0.5) < 0.12) { c = vec3(1.4, 0.2, 0.1); emis = 1.0; }
  }
  fragColor = vec4(max(c + alb * dl, 0.0), emis);
}
`;

/** The crates of one frame, as instances of one box. */
export class CrateBatch {
  readonly geo = new THREE.InstancedBufferGeometry();
  private readonly pos = new Float32Array(CAP * 4);
  private readonly size = new Float32Array(CAP * 4);
  private readonly attrs: THREE.InstancedBufferAttribute[];
  count = 0;

  constructor() {
    const P: number[] = [], F: number[] = [], N: number[] = [], I: number[] = [];
    // four sides (Doom's fake contrast: east/west walls +1, north/south -1) and the top
    const quad = (c: number[][], uv: number[][], face: number, contrast: number, n: number[]): void => {
      const b = P.length / 3;
      for (let i = 0; i < 4; i++) { P.push(...c[i]); F.push(uv[i][0], uv[i][1], face, contrast); N.push(...n); }
      I.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    const side = [[0, 1], [1, 1], [1, 0], [0, 0]];
    quad([[-1, -1, 0], [1, -1, 0], [1, -1, 1], [-1, -1, 1]], side, 0, -1, [0, -1, 0]);
    quad([[1, -1, 0], [1, 1, 0], [1, 1, 1], [1, -1, 1]], side, 0, 1, [1, 0, 0]);
    quad([[1, 1, 0], [-1, 1, 0], [-1, 1, 1], [1, 1, 1]], side, 0, -1, [0, 1, 0]);
    quad([[-1, 1, 0], [-1, -1, 0], [-1, -1, 1], [-1, 1, 1]], side, 0, 1, [-1, 0, 0]);
    quad([[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], [[0, 1], [1, 1], [1, 0], [0, 0]], 1, 0, [0, 0, 1]);
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    this.geo.setAttribute('aFace', new THREE.Float32BufferAttribute(F, 4));
    this.geo.setAttribute('aNormal', new THREE.Float32BufferAttribute(N, 3));
    this.geo.setIndex(I);
    this.attrs = [new THREE.InstancedBufferAttribute(this.pos, 4), new THREE.InstancedBufferAttribute(this.size, 4)];
    ['iPos', 'iSize'].forEach((n, i) => { this.attrs[i].setUsage(THREE.DynamicDrawUsage); this.geo.setAttribute(n, this.attrs[i]); });
    this.geo.instanceCount = 0;
  }

  push(x: number, y: number, z: number, sector: number, radius: number, height: number, light: number, supply = false): void {
    if (this.count >= CAP) return;
    const o = this.count++ * 4;
    this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z; this.pos[o + 3] = sector;
    this.size[o] = radius; this.size[o + 1] = height; this.size[o + 2] = light; this.size[o + 3] = supply ? 1 : 0;
  }

  commit(): void {
    for (const a of this.attrs) { a.clearUpdateRanges(); a.addUpdateRange(0, this.count * 4); a.needsUpdate = true; }
    this.geo.instanceCount = this.count;
  }
}
