// GLSL (WebGL2 / GLSL ES 3.00) for the world, sprites, sky, psprites and post FX.
//
// Doom lighting (r_main.c R_InitLightTables): a surface's light level picks a COLORMAP
// row; distance makes it darker. With LIGHTLEVELS=16, NUMCOLORMAPS=32, a 320-wide view:
//   lightnum = (sectorlight >> 4) + extralight (+1/-1 fake contrast on axis walls)
//   startmap = (15 - lightnum) * 4
//   walls/sprites: j = min(47, 2560 / depth),        level = startmap - j/2
//   flats:         j = min(127, depth / 16),         level = startmap - (160/(j+1))/2
// where depth is the distance along the view direction. The palette color of
// COLORMAP[level][index] is the lit pixel. Palette 0..13 (damage/pickup/radsuit tints)
// is folded into the same lookup texture.

export const MAX_LIGHTS = 64;
/** screen tiles for per-tile light lists (forward+ with CPU culling) */
export const TILES_X = 16, TILES_Y = 9, TILE_MAX = 24;

export const COMMON = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
#define MAX_LIGHTS ${MAX_LIGHTS}
#define TILES_X ${TILES_X}
#define TILES_Y ${TILES_Y}
uniform sampler2D uPal;        // 256 x (14*34) linear RGB
uniform float uPalNum;
uniform float uFixedCmap;      // -1 = none
uniform float uExtraLight;
uniform vec3 uCamPos;
uniform vec2 uCamFwd;
uniform vec4 uLightPos[MAX_LIGHTS];
uniform vec4 uLightCol[MAX_LIGHTS];
uniform int uLightCount;
uniform sampler2D uLightReach; // R8: (sector, light) -> 0..1
uniform sampler2D uLightTiles; // R8: (tile, 0) = count, (tile, k+1) = light index
uniform vec2 uViewport;        // render target size in pixels
uniform float uDynScale;

vec3 palColor(float idx, float level) {
  return texelFetch(uPal, ivec2(int(idx), int(uPalNum) * 34 + int(level)), 0).rgb;
}
float startMap(float light, float contrast) {
  float ln = clamp(floor(light / 16.0) + uExtraLight + contrast, 0.0, 15.0);
  return (15.0 - ln) * 4.0;
}
float wallLevel(float light, float depth, float contrast) {
  if (uFixedCmap >= 0.0) return uFixedCmap;
  float j = min(47.0, floor(2560.0 / max(depth, 1.0)));
  return clamp(startMap(light, contrast) - floor(j * 0.5), 0.0, 31.0);
}
float flatLevel(float light, float depth) {
  if (uFixedCmap >= 0.0) return uFixedCmap;
  float j = min(127.0, floor(max(depth, 0.0) / 16.0));
  float scale = floor(160.0 / (j + 1.0));
  return clamp(startMap(light, 0.0) - floor(scale * 0.5), 0.0, 31.0);
}
float albedoLevel() { return uFixedCmap >= 0.0 ? uFixedCmap : 0.0; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float viewDepth(vec3 wp) { return dot(wp.xy - uCamPos.xy, uCamFwd); }

#ifndef IS_VERTEX
vec3 dynLight(vec3 wp, vec3 n, int sector, float wrap) {
  vec3 sum = vec3(0.0);
  if (uLightCount == 0) return sum;
  ivec2 tc = ivec2(gl_FragCoord.xy / uViewport * vec2(TILES_X, TILES_Y));
  int tile = clamp(tc.y, 0, TILES_Y - 1) * TILES_X + clamp(tc.x, 0, TILES_X - 1);
  int count = int(texelFetch(uLightTiles, ivec2(tile, 0), 0).r * 255.0 + 0.5);
  for (int k = 0; k < 24; k++) {
    if (k >= count) break;
    int i = int(texelFetch(uLightTiles, ivec2(tile, k + 1), 0).r * 255.0 + 0.5);
    vec4 lp = uLightPos[i];
    vec3 L = lp.xyz - wp;
    float d2 = dot(L, L);
    if (d2 >= lp.w * lp.w) continue;
    float reach = texelFetch(uLightReach, ivec2(sector, i), 0).r;
    if (reach <= 0.0) continue;
    float d = sqrt(d2);
    // linear falloff over the radius, lambert
    float a = 1.0 - d / lp.w;
    float ndl = dot(n, L / max(d, 1e-3));
    ndl = wrap > 0.0 ? ndl * (1.0 - wrap) + wrap : ndl;
    ndl = mix(1.0, max(ndl, 0.0), smoothstep(0.0, 16.0, d));
    sum += uLightCol[i].rgb * (a * ndl * reach);
  }
  return sum * uDynScale;
}
#endif
`;

/** Data texture helpers shared by world shaders. */
export const DATA = /* glsl */ `
uniform sampler2D uSectors;   // 2 texels per sector: (floor, ceil, light, 0), (floorTex, ceilTex, 0, 0)
uniform sampler2D uTexInfo;   // 2 texels per texture id: (x, y, w, h), (glow rgb, flags)
uniform sampler2D uAtlas;     // RG8: palette index, opacity
vec4 fetchW(sampler2D t, int i) { int w = textureSize(t, 0).x; return texelFetch(t, ivec2(i % w, i / w), 0); }
vec4 sectorA(int s) { return fetchW(uSectors, s * 2); }
vec4 sectorB(int s) { return fetchW(uSectors, s * 2 + 1); }
vec4 texRect(float id) { return fetchW(uTexInfo, int(id) * 2); }
vec4 texGlow(float id) { return id < 0.0 ? vec4(0.0) : fetchW(uTexInfo, int(id) * 2 + 1); }
vec2 atlasTexel(vec4 r, vec2 uv) {
  vec2 t = mod(floor(uv), r.zw);
  return texelFetch(uAtlas, ivec2(r.xy + t), 0).rg;
}
`;

export const WALL_VS = /* glsl */ `
#define IS_VERTEX
${COMMON}
${DATA}
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform sampler2D uSides;     // per side: (top, mid, bottom) texture ids
uniform float uTic;
in vec3 position;
in vec4 aW0; // u, side, part, top
in vec4 aW1; // front, back, flags, yoff
in vec4 aW2; // nx, ny, line, 0
out vec3 vWorld;
out vec2 vUV;
flat out vec4 vRectId;   // texture id, contrast, masked, sector
flat out vec4 vFront;    // floor, ceil, light, 0
flat out vec2 vNormal;
flat out vec4 vGlowIds;  // floor flat id, ceil flat id
void main() {
  int part = int(aW0.z);
  int fs = int(aW1.x);
  int bs = int(aW1.y);
  int flags = int(aW1.z);
  vec4 F = sectorA(fs);
  vec4 B = bs >= 0 ? sectorA(bs) : F;
  vec4 st = fetchW(uSides, int(aW0.y));
  float texId = part == 1 ? st.r : (part == 2 ? st.b : st.g);
  if (texId < 0.0) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  float texH = texRect(texId).w;
  bool pegTop = (flags & 1) != 0;
  bool pegBot = (flags & 2) != 0;
  float zt, zb, mid;
  if (part == 0) { zt = F.y; zb = F.x; mid = (pegBot ? F.x + texH : F.y) + aW1.w; }
  else if (part == 1) { zt = F.y; zb = max(min(B.y, F.y), F.x); mid = (pegTop ? F.y : B.y + texH) + aW1.w; }
  else if (part == 2) { zt = min(max(B.x, F.x), F.y); zb = F.x; mid = (pegBot ? F.y : B.x) + aW1.w; }
  else {
    float ot = min(F.y, B.y), ob = max(F.x, B.x);
    mid = (pegBot ? ob + texH : ot) + aW1.w;
    zt = min(ot, mid); zb = max(ob, mid - texH);
    if (zt < zb) zt = zb;
  }
  float z = aW0.w > 0.5 ? zt : zb;
  float u = aW0.x + ((flags & 4) != 0 ? floor(uTic) : 0.0);
  vUV = vec2(u, mid - z);
  vWorld = vec3(position.xy, z);
  float contrast = (flags & 8) != 0 ? 1.0 : ((flags & 16) != 0 ? -1.0 : 0.0);
  vRectId = vec4(texId, contrast, part == 3 ? 1.0 : 0.0, float(fs));
  vFront = F;
  vNormal = aW2.xy;
  vec4 SB = sectorB(fs);
  vGlowIds = vec4(SB.x, SB.y, 0.0, 0.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vWorld, 1.0);
}
`;

export const WALL_FS = /* glsl */ `
${COMMON}
${DATA}
in vec3 vWorld;
in vec2 vUV;
flat in vec4 vRectId;
flat in vec4 vFront;
flat in vec2 vNormal;
flat in vec4 vGlowIds;
uniform float uAoStrength;
out vec4 fragColor;
void main() {
  vec4 r = texRect(vRectId.x);
  vec2 uv = vUV;
  if (vRectId.z > 0.5) { if (uv.y < 0.0 || uv.y >= r.w) discard; }
  vec2 t = atlasTexel(r, uv);
  if (vRectId.z > 0.5 && t.g < 0.5) discard;
  float idx = floor(t.r * 255.0 + 0.5);
  float depth = viewDepth(vWorld);
  vec3 c = palColor(idx, wallLevel(vFront.z, depth, vRectId.y));
  vec3 alb = palColor(idx, albedoLevel());
  float emis = 0.0;
  vec4 g = texGlow(vRectId.x);
  if ((int(g.w) & 1) != 0 && uFixedCmap < 0.0) {
    float b = smoothstep(0.30, 0.55, luma(alb));
    c = mix(c, alb, b * 0.9);
    emis = b;
  }
  // contact darkening at the room's floor and ceiling corners
  float hf = vWorld.z - vFront.x, hc = vFront.y - vWorld.z;
  float ao = mix(1.0 - 0.45 * uAoStrength, 1.0, smoothstep(0.0, 40.0, hf)) * mix(1.0 - 0.3 * uAoStrength, 1.0, smoothstep(0.0, 28.0, hc));
  // glowing floors/ceilings (nukage, lava, light panels) tint the walls above/below
  vec3 gf = texGlow(vGlowIds.x).rgb, gc = texGlow(vGlowIds.y).rgb;
  vec3 glow = gf * pow(clamp(1.0 - hf / 96.0, 0.0, 1.0), 2.0) + gc * pow(clamp(1.0 - hc / 96.0, 0.0, 1.0), 2.0);
  vec3 dl = dynLight(vWorld, vec3(vNormal, 0.0), int(vRectId.w), 0.0) + glow;
  fragColor = vec4(max(c * ao + alb * dl, 0.0), emis);
}
`;

export const FLAT_VS = /* glsl */ `
#define IS_VERTEX
${COMMON}
${DATA}
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
in vec2 aF; // sector, plane (0 floor, 1 ceiling)
out vec3 vWorld;
flat out vec4 vInfo; // tex id, sector, plane, light
void main() {
  int s = int(aF.x);
  vec4 A = sectorA(s);
  vec4 B = sectorB(s);
  bool ceil = aF.y > 0.5;
  vWorld = vec3(position.xy, ceil ? A.y : A.x);
  vInfo = vec4(ceil ? B.y : B.x, aF.x, aF.y, A.z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vWorld, 1.0);
}
`;

export const FLAT_FS = /* glsl */ `
${COMMON}
${DATA}
uniform sampler2D uAo;
uniform vec4 uAoXform; // origin x, origin y, 1/(cell*w), 1/(cell*h)
uniform float uAoStrength;
in vec3 vWorld;
flat in vec4 vInfo;
out vec4 fragColor;
void main() {
  if (vInfo.x < 0.0) discard;
  vec4 r = texRect(vInfo.x);
  vec2 t = atlasTexel(r, vec2(vWorld.x, -vWorld.y));
  float idx = floor(t.r * 255.0 + 0.5);
  float depth = viewDepth(vWorld);
  vec3 c = palColor(idx, flatLevel(vInfo.w, depth));
  vec3 alb = palColor(idx, albedoLevel());
  vec4 g = texGlow(vInfo.x);
  int gflags = int(g.w);
  float emis = 0.0;
  if (uFixedCmap < 0.0) {
    if ((gflags & 2) != 0) { c = max(c, alb * 0.6); emis = 0.35 * smoothstep(0.1, 0.5, luma(alb)); }
    if ((gflags & 1) != 0) { float b = smoothstep(0.30, 0.55, luma(alb)); c = mix(c, alb, b * 0.9); emis = b; }
  }
  vec2 aoUV = (vWorld.xy - uAoXform.xy) * uAoXform.zw;
  vec2 aoS = texture(uAo, aoUV).rg;
  float aoV = vInfo.z > 0.5 ? aoS.g : aoS.r;
  float ao = mix(1.0 - 0.5 * uAoStrength, 1.0, smoothstep(0.0, 1.0, aoV));
  vec3 n = vec3(0.0, 0.0, vInfo.z > 0.5 ? -1.0 : 1.0);
  vec3 dl = dynLight(vWorld, n, int(vInfo.y), 0.0);
  fragColor = vec4(max(c * ao + alb * dl, 0.0), emis);
}
`;

export const SKY_VS = /* glsl */ `
#define IS_VERTEX
${COMMON}
${DATA}
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
in vec4 aS; // front, back, kind (0 ceiling, 1 wall), top
out vec3 vWorld;
void main() {
  vec4 F = sectorA(int(aS.x));
  float z = F.y;
  if (aS.z > 0.5) {
    vec4 B = sectorA(int(aS.y));
    z = aS.w > 0.5 ? F.y : min(B.y, F.y);
  }
  vWorld = vec3(position.xy, z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vWorld, 1.0);
}
`;

export const SKY_FS = /* glsl */ `
${COMMON}
${DATA}
uniform float uSkyTex;
uniform vec3 uSkyTop;     // linear color the sky fades to above the texture
uniform float uSkyStretch; // vertical texels per unit tan(elevation) (Doom: 160)
in vec3 vWorld;
out vec4 fragColor;
void main() {
  vec3 d = vWorld - uCamPos;
  float ang = atan(d.y, d.x);
  vec4 r = texRect(uSkyTex);
  // Doom: 1024 sky columns per 360 degrees (ANGLETOSKYSHIFT), texturemid row 100
  float u = ang / 6.28318530718 * 1024.0; // column = angle >> 22 (screen right = smaller angle)
  float tanE = d.z / max(length(d.xy), 1e-3);
  float v = 100.0 - tanE * uSkyStretch;
  vec2 t = atlasTexel(r, vec2(u, clamp(v, 0.0, r.w - 1.0)));
  vec3 c = palColor(floor(t.r * 255.0 + 0.5), 0.0);
  c = mix(c, uSkyTop, smoothstep(0.0, 56.0, -v));
  fragColor = vec4(c, 0.0);
}
`;

export const SPRITE_VS = /* glsl */ `
#define IS_VERTEX
${COMMON}
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 uCamRight;
in vec3 position;     // corner: x 0..1 (left→right), y 0..1 (top→bottom)
in vec4 iPos;         // x, y, z, sector
in vec4 iRect;        // atlas x, y, w, h
in vec4 iOff;         // leftoffset, topoffset, flags (1 flip, 2 fullbright, 4 fuzz), translation
in vec4 iMisc;        // sector light, 0, 0, 0
out vec2 vUV;
out vec3 vWorld;
flat out vec4 vRect;
flat out vec4 vInfo;  // flags, translation, light, sector
void main() {
  float w = iRect.z, h = iRect.w;
  float lx = -iOff.x + position.x * w;
  vec3 wp = vec3(iPos.xy + uCamRight * lx, iPos.z + iOff.y - position.y * h);
  int flags = int(iOff.z);
  vUV = vec2((flags & 1) != 0 ? w - position.x * w : position.x * w, position.y * h);
  vWorld = wp;
  vRect = iRect;
  vInfo = vec4(iOff.z, iOff.w, iMisc.x, iPos.w);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
}
`;

export const SPRITE_FS = /* glsl */ `
${COMMON}
uniform sampler2D uSpriteAtlas;
uniform sampler2D uTrans;
uniform vec3 uCamFwd3;
uniform float uTime;
uniform float uFuzz;   // 1 when drawing the fuzz pass
out vec4 fragColor;
in vec2 vUV;
in vec3 vWorld;
flat in vec4 vRect;
flat in vec4 vInfo;
float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
void main() {
  vec2 uv = clamp(floor(vUV), vec2(0.0), vRect.zw - 1.0);
  vec2 t = texelFetch(uSpriteAtlas, ivec2(vRect.xy + uv), 0).rg;
  if (t.g < 0.5) discard;
  int flags = int(vInfo.x);
  if (uFuzz > 0.5) {
    // Doom's spectre fuzz: darken what is behind by a jittering amount
    // per-column streaks re-rolled every tic, like Doom's fuzzoffset table
    float tic = mod(floor(uTime * 35.0), 256.0);
    vec2 cell = floor(gl_FragCoord.xy / vec2(2.0, 3.0));
    float n = hash(cell + vec2(tic * 3.0, tic * 7.0));
    fragColor = vec4(vec3(n < 0.35 ? 0.18 : (n < 0.7 ? 0.45 : 0.78)), 1.0);
    return;
  }
  float idx = floor(t.r * 255.0 + 0.5);
  if (vInfo.y > 0.5) idx = floor(texelFetch(uTrans, ivec2(int(idx), int(vInfo.y)), 0).r * 255.0 + 0.5);
  bool full = (flags & 2) != 0;
  float depth = viewDepth(vWorld);
  float level = uFixedCmap >= 0.0 ? uFixedCmap : (full ? 0.0 : wallLevel(vInfo.z, depth, 0.0));
  vec3 c = palColor(idx, level);
  vec3 alb = palColor(idx, albedoLevel());
  float emis = full && uFixedCmap < 0.0 ? smoothstep(0.15, 0.6, luma(alb)) : 0.0;
  vec3 dl = full ? vec3(0.0) : dynLight(vWorld, -uCamFwd3, int(vInfo.w), 0.45);
  fragColor = vec4(max(c + alb * dl, 0.0), emis);
}
`;

export const PSPRITE_VS = /* glsl */ `
precision highp float;
in vec3 position;   // corner 0..1
in vec4 iScreen;    // ndc x0, y0 (top-left), x1, y1
in vec4 iRect;
in vec4 iInfo;      // flags (1 flip, 2 fullbright), 0, 0, 0
out vec2 vUV;
flat out vec4 vRect;
flat out vec4 vInfo;
void main() {
  vec2 p = mix(iScreen.xy, iScreen.zw, position.xy);
  int flags = int(iInfo.x);
  vUV = vec2((flags & 1) != 0 ? iRect.z - position.x * iRect.z : position.x * iRect.z, position.y * iRect.w);
  vRect = iRect;
  vInfo = iInfo;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

export const PSPRITE_FS = /* glsl */ `
${COMMON}
uniform sampler2D uSpriteAtlas;
uniform float uPspLevel;     // colormap row for the weapon (sector light), -1 = fuzz
uniform vec3 uPspLight;      // dynamic light at the camera
uniform float uPspGlow;      // bloom feed of the fullbright weapon flash (a screen-filling sprite: keep it modest)
uniform float uTime;
in vec2 vUV;
flat in vec4 vRect;
flat in vec4 vInfo;
out vec4 fragColor;
float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
void main() {
  vec2 uv = clamp(floor(vUV), vec2(0.0), vRect.zw - 1.0);
  vec2 t = texelFetch(uSpriteAtlas, ivec2(vRect.xy + uv), 0).rg;
  if (t.g < 0.5) discard;
  float idx = floor(t.r * 255.0 + 0.5);
  bool full = (int(vInfo.x) & 2) != 0;
  if (uPspLevel < 0.0) {
    float n = hash(floor(gl_FragCoord.xy / 2.0) + mod(floor(uTime * 35.0), 256.0) * 5.0);
    fragColor = vec4(palColor(idx, 31.0) * (n < 0.5 ? 0.3 : 0.6), 0.0);
    return;
  }
  float level = uFixedCmap >= 0.0 ? uFixedCmap : (full ? 0.0 : uPspLevel);
  vec3 c = palColor(idx, level);
  vec3 alb = palColor(idx, albedoLevel());
  // only the hottest pixels of the flash feed the bloom, and weakly: Doom's flash is a
  // flat bright sprite, the glow should rim it, not swallow the gun in an orb
  float emis = full && uFixedCmap < 0.0 ? smoothstep(0.55, 0.95, luma(alb)) * uPspGlow : 0.0;
  fragColor = vec4(c + (full ? vec3(0.0) : alb * uPspLight), emis);
}
`;

// ---- post ----------------------------------------------------------------------

export const FULLSCREEN_VS = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Bright-pass + 2x downsample: emissive pixels (alpha) and HDR overflow feed bloom. */
export const BLOOM_EXTRACT_FS = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 fragColor;
vec3 pick(vec2 uv) {
  vec4 c = texture(uSrc, uv);
  float l = max(c.r, max(c.g, c.b));
  return c.rgb * c.a + c.rgb * max(l - 0.9, 0.0) / max(l, 1e-4);
}
void main() {
  vec3 s = pick(vUv + uTexel * vec2(-0.5, -0.5)) + pick(vUv + uTexel * vec2(0.5, -0.5))
         + pick(vUv + uTexel * vec2(-0.5, 0.5)) + pick(vUv + uTexel * vec2(0.5, 0.5));
  fragColor = vec4(s * 0.25, 1.0);
}
`;

/** Dual-filter (Kawase) downsample. */
export const BLOOM_DOWN_FS = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 s = texture(uSrc, vUv).rgb * 4.0;
  s += texture(uSrc, vUv - uTexel).rgb;
  s += texture(uSrc, vUv + uTexel).rgb;
  s += texture(uSrc, vUv + vec2(uTexel.x, -uTexel.y)).rgb;
  s += texture(uSrc, vUv - vec2(uTexel.x, -uTexel.y)).rgb;
  fragColor = vec4(s / 8.0, 1.0);
}
`;

/** Dual-filter upsample, added onto the next larger level. */
export const BLOOM_UP_FS = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uBase;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec3 s = texture(uSrc, vUv + vec2(-uTexel.x * 2.0, 0.0)).rgb;
  s += texture(uSrc, vUv + vec2(-uTexel.x, uTexel.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(0.0, uTexel.y * 2.0)).rgb;
  s += texture(uSrc, vUv + vec2(uTexel.x, uTexel.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(uTexel.x * 2.0, 0.0)).rgb;
  s += texture(uSrc, vUv + vec2(uTexel.x, -uTexel.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(0.0, -uTexel.y * 2.0)).rgb;
  s += texture(uSrc, vUv + vec2(-uTexel.x, -uTexel.y)).rgb * 2.0;
  fragColor = vec4(s / 12.0 + texture(uBase, vUv).rgb, 1.0);
}
`;

/**
 * Composite: scene + bloom, then a tone curve that is the identity up to 0.8 (so the
 * Doom palette is reproduced exactly where no extra light was added) with a soft,
 * hue-preserving shoulder above, then sRGB encode and a touch of film grain.
 */
export const COMPOSITE_FS = /* glsl */ `
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uTime;
uniform float uGrain;
in vec2 vUv;
out vec4 fragColor;
vec3 shoulder(vec3 c) {
  float m = max(c.r, max(c.g, c.b));
  const float k = 0.8;
  if (m <= k) return c;
  float t = m - k;
  float mm = k + (1.0 - k) * (1.0 - exp(-t / (1.0 - k)));
  vec3 o = c * (mm / m);
  // very hot light burns toward white like film
  float burn = clamp((m - 1.5) / 6.0, 0.0, 0.6);
  return mix(o, vec3(mm), burn);
}
vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
void main() {
  vec3 c = texture(uScene, vUv).rgb + texture(uBloom, vUv).rgb * uBloomStrength;
  c = toSRGB(shoulder(c));
  c += (hash(gl_FragCoord.xy + fract(uTime) * 100.0) - 0.5) * uGrain;
  fragColor = vec4(c, 1.0);
}
`;
