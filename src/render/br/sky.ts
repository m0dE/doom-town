// The sky from above (the dropship, skydiving): Doom draws sky only on sky ceilings and
// the walls between them, so a camera above the sky plane would see black around the
// map. This dome around the camera draws the same sky (same column/row mapping as
// SKY_FS) before the world, fading below the horizon into a haze of the sky's bottom
// row, so the town sits on a horizon. Only shown while the camera is above its sector's
// ceiling (out of the world's volume).
import * as THREE from 'three';
import { COMMON, DATA } from '../shaders';

const VS = /* glsl */ `
#define IS_VERTEX
${COMMON}
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
out vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position * 16000.0 + uCamPos, 1.0);
  gl_Position = p.xyww; // on the far plane
}
`;

const FS = /* glsl */ `
${COMMON}
${DATA}
uniform float uSkyTex;
uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;  // average of the texture's bottom row
uniform float uSkyStretch;
in vec3 vDir;
out vec4 fragColor;
void main() {
  vec3 d = vDir;
  float ang = atan(d.y, d.x);
  vec4 r = texRect(uSkyTex);
  float u = ang / 6.28318530718 * 1024.0;
  float tanE = d.z / max(length(d.xy), 1e-3);
  float v = 100.0 - tanE * uSkyStretch;
  vec2 t = atlasTexel(r, vec2(u, clamp(v, 0.0, r.w - 1.0)));
  vec3 c = palColor(floor(t.r * 255.0 + 0.5), 0.0);
  c = mix(c, uSkyTop, 1.0 - smoothstep(-6.0, 28.0, v));
  // below the horizon: the bottom row's colour, darkening toward the ground
  vec3 haze = uSkyBottom;
  float below = clamp(-tanE, 0.0, 1.0);
  // (blended from just above the horizon: the texture's last rows would show as a hard band)
  c = mix(c, haze * mix(0.85, 0.35, sqrt(below)), smoothstep(-0.06, 0.05, -tanE));
  fragColor = vec4(c, 0.0);
}
`;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  constructor(scene: THREE.Scene, world: Record<string, THREE.IUniform>) {
    const g = new THREE.SphereGeometry(1, 32, 16);
    g.rotateX(Math.PI / 2);
    this.mesh = new THREE.Mesh(g, new THREE.RawShaderMaterial({
      vertexShader: VS, fragmentShader: FS, glslVersion: THREE.GLSL3, uniforms: world,
      side: THREE.BackSide, depthTest: false, depthWrite: false,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }
  dispose(): void { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}
