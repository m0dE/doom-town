/**
 * The marine's material: MeshLambertMaterial whose albedo is looked up per texel
 * from a palette-index atlas, through the player's colour translation (Doom's
 * green ramp 0x70..0x7F remapped, rows of `buildTranslations`) and PLAYPAL.
 *
 * Two kinds of light, mixed by `uLit`:
 *  - Doom (uLit = 0): the sector light picks a COLORMAP row the way R_ProjectSprite
 *    does (startmap minus a distance term), plus a few rows of "fake contrast"
 *    per face direction so the boxes read as solid; the result is still a
 *    palette colour, so the model darkens exactly like the sprites around it.
 *    Fullbright frames (the firing frame) use row 0.
 *  - three.js lights (uLit = 1): the palette colour is the albedo of a flat
 *    shaded Lambert surface lit by the scene's lights (the start screen).
 *
 * Every model instance owns one of these (cheap: the program is shared), so
 * colour, light and gore are plain uniforms.
 */
import * as THREE from 'three';

export interface SharedTextures {
  atlas: THREE.DataTexture;
  palette: THREE.DataTexture;
  colormap: THREE.DataTexture;
  translations: THREE.DataTexture;
  numColors: number;
}

export interface DoomguyUniforms {
  uColor: { value: number };
  uLightLevel: { value: number };
  uExtraLight: { value: number };
  uLit: { value: number };
  uFullbright: { value: number };
  uGore: { value: number };
  uGoreSeed: { value: number };
  uFlashBoost: { value: number };
  /** the world renderer's palette (256 × 14·34 linear RGB, COLORMAP rows folded in); used when uPalNum >= 0 */
  uWorldPal: { value: THREE.Texture | null };
  /** world palette number (damage/pickup tints), -1 = the model's own palette and colormap */
  uPalNum: { value: number };
  /** fixed colormap row (light amp, invulnerability), -1 = none */
  uFixedCmap: { value: number };
  /** dynamic light reaching the model (linear RGB, added as albedo × light) */
  uDyn: { value: THREE.Vector3 };
  /** 1 = alpha carries the emissive amount (the world's bloom), 0 = opaque alpha (start screen) */
  uEmisAlpha: { value: number };
  /** 1 = spectre fuzz (drawn with multiply blending) */
  uFuzz: { value: number };
  uTime: { value: number };
}

export function makeIndexTexture(data: Uint8Array, w: number, h: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data as Uint8Array<ArrayBuffer>, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export function makePaletteTexture(playpal: Uint8Array): THREE.DataTexture {
  const rgba = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    rgba[i * 4] = playpal[i * 3]; rgba[i * 4 + 1] = playpal[i * 3 + 1]; rgba[i * 4 + 2] = playpal[i * 3 + 2]; rgba[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(rgba, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

const PARS = /* glsl */ `
uniform sampler2D uAtlas;
uniform sampler2D uPalette;
uniform sampler2D uColormap;
uniform sampler2D uTrans;
uniform float uColor;
uniform float uLightLevel;
uniform float uExtraLight;
uniform float uLit;
uniform float uFullbright;
uniform float uGore;
uniform float uGoreSeed;
uniform float uFlashBoost;
uniform sampler2D uWorldPal;
uniform float uPalNum;
uniform float uFixedCmap;
uniform vec3 uDyn;
uniform float uEmisAlpha;
uniform float uFuzz;
uniform float uTime;
varying vec2 vPalUv;
varying vec3 vObjPos;
varying vec3 vObjNormal;
varying float vBright;
varying float vDepth;

int palAt(sampler2D t, int x, int y) { return int(texelFetch(t, ivec2(x, y), 0).r * 255.0 + 0.5); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

export function createDoomguyMaterial(tex: SharedTextures): { material: THREE.MeshLambertMaterial; uniforms: DoomguyUniforms } {
  const uniforms: DoomguyUniforms = {
    uColor: { value: 0 },
    uLightLevel: { value: 255 },
    uExtraLight: { value: 0 },
    uLit: { value: 0 },
    uFullbright: { value: 0 },
    uGore: { value: 0 },
    uGoreSeed: { value: 0 },
    uFlashBoost: { value: 1 },
    uWorldPal: { value: null },
    uPalNum: { value: -1 },
    uFixedCmap: { value: -1 },
    uDyn: { value: new THREE.Vector3() },
    uEmisAlpha: { value: 0 },
    uFuzz: { value: 0 },
    uTime: { value: 0 },
  };
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      uAtlas: { value: tex.atlas },
      uPalette: { value: tex.palette },
      uColormap: { value: tex.colormap },
      uTrans: { value: tex.translations },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aBright;
varying vec2 vPalUv;
varying float vBright;
varying float vDepth;
varying vec3 vObjPos;
varying vec3 vObjNormal;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
vPalUv = uv; vBright = aBright;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
vDepth = -mvPosition.z;
vObjPos = transformed;
vObjNormal = objectNormal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
${PARS}`)
      .replace('#include <map_fragment>', `
ivec2 atlasSize = textureSize(uAtlas, 0);
ivec2 tc = ivec2(floor(vPalUv * vec2(atlasSize)));
int idx = palAt(uAtlas, tc.x, tc.y);
if (uGore > 0.0) {
  // smeared blotches (value noise over the texels), so it reads as gore rather than static
  float h = vnoise(vec2(tc) / 2.7 + uGoreSeed * 7.3);
  if (h < uGore) {
    // blood: the dark ends of Doom's two red ramps, as in the gib sprites
    float h2 = hash12(vec2(tc) * 1.7 + 3.1);
    idx = h2 < 0.55 ? 0xb9 + int(h2 / 0.55 * 6.99) : 0x26 + int((h2 - 0.55) / 0.45 * 9.99);
  }
}
int tidx = palAt(uTrans, idx, int(uColor + 0.5));
// Doom light (R_ProjectSprite / scalelight): startmap minus distance term, plus fake contrast
float lightnum = clamp(floor(uLightLevel / 16.0) + uExtraLight, 0.0, 15.0);
float startmap = (15.0 - lightnum) * 4.0;
float level = startmap - min(1280.0 / max(vDepth, 1.0), 23.0);
vec3 fn = normalize(cross(dFdx(-vViewPosition), dFdy(-vViewPosition)));
float contrast = floor((1.0 - dot(fn, normalize(vec3(-0.35, 0.75, 0.55)))) * 2.6);
float bright = max(uFullbright, vBright);
float row = bright > 0.5 ? 0.0 : clamp(floor(level) + contrast, 0.0, 31.0);
vec3 doomRgb, albedo;
if (uPalNum >= 0.0) {
  // the world renderer's palette: same tints (damage, pickups) and fixed colormaps as the sprites
  int pr = int(uPalNum + 0.5) * 34;
  float wrow = uFixedCmap >= 0.0 ? uFixedCmap : row;
  doomRgb = texelFetch(uWorldPal, ivec2(tidx, pr + int(wrow)), 0).rgb;
  albedo = texelFetch(uWorldPal, ivec2(tidx, pr + (uFixedCmap >= 0.0 ? int(uFixedCmap) : 0)), 0).rgb;
  if (bright < 0.5 && uFixedCmap < 0.0) doomRgb += albedo * uDyn;
} else {
  int doomIdx = palAt(uColormap, tidx, int(row));
  doomRgb = texelFetch(uPalette, ivec2(doomIdx, 0), 0).rgb;
  albedo = texelFetch(uPalette, ivec2(tidx, 0), 0).rgb;
}
diffuseColor.rgb = albedo;
// emissive amount for the world's bloom: only the muzzle flash glows
float emis = vBright * smoothstep(0.15, 0.6, dot(albedo, vec3(0.2126, 0.7152, 0.0722)));
`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
// No shadow maps: a face turned toward the body's mid-plane from an arm or a shoulder
// pad (the inside of the arm, seen through the gap beside the torso once the arm swings
// to the gun) would catch a back or rim light at full strength, a bright sliver where
// the torso should shade it. Those faces get the ambient only.
{
  float side = abs(vObjPos.z);
  float inward = -normalize(vObjNormal).z * sign(vObjPos.z);
  float occ = smoothstep(0.15, 0.5, inward) * smoothstep(5.0, 8.0, side) * (1.0 - vBright);
  reflectedLight.directDiffuse *= 1.0 - occ;
  reflectedLight.indirectDiffuse *= 1.0 - 0.35 * occ;
}`)
      .replace('#include <opaque_fragment>', `
outgoingLight += albedo * vBright * uFlashBoost;
outgoingLight = mix(doomRgb, outgoingLight, uLit);
#include <opaque_fragment>
// (after opaque_fragment, which forces alpha to 1 on opaque materials)
gl_FragColor.a = mix(1.0, emis, uEmisAlpha);
if (uFuzz > 0.5) {
  // Doom's spectre fuzz, as the sprites do it: darken what is behind by a jittering
  // amount, per-column streaks re-rolled every tic (multiply blending)
  float tic = mod(floor(uTime * 35.0), 256.0);
  vec2 cell = floor(gl_FragCoord.xy / vec2(2.0, 3.0));
  float fz = hash12(cell + vec2(tic * 3.0, tic * 7.0));
  gl_FragColor = vec4(vec3(fz < 0.35 ? 0.18 : (fz < 0.7 ? 0.45 : 0.78)), 1.0);
}`);
  };
  material.customProgramCacheKey = () => 'doomguy-v2';
  return { material, uniforms };
}
