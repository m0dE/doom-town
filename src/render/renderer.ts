// The world renderer: Doom-exact palette lighting on true-3D geometry, plus dynamic
// lights, contact shadows, glowing flats, bloom and a palette-preserving tone curve.
//
// Draw calls per frame: flats, walls, masked mids, sky, sprites, fuzz sprites, psprites,
// bloom (9 small passes) and composite.
import * as THREE from 'three';
import {
  FF_FULLBRIGHT, MF_SHADOW, SPRITE_NAMES, Wad, loadWad, parseMap, pointInSubsector, screenPalette, skyTextureForMap, spriteNum,
  type MapData,
} from '../wad';
import { RenderAssets } from './assets';
import { MUZZLE_TABLE } from './lights-table';
import { buildAoTexture, buildGeometry, type MapGeometry } from './geometry';
import { LightManager } from './lights';
import { PostFX } from './post';
import { SectorLightFx } from './sectorfx';
import {
  FLAT_FS, FLAT_VS, MAX_LIGHTS, PSPRITE_FS, PSPRITE_VS, SKY_FS, SKY_VS, SPRITE_FS, SPRITE_VS, WALL_FS, WALL_VS,
} from './shaders';
import type { PlayerBodyRenderer, RenderFrame, RenderMobj, RenderPsprite } from './types';

export interface RendererOptions {
  /** Doom's non-square pixels (320×200 shown at 4:3): 1.2; 1 = square */
  pixelAspect?: number;
  /** horizontal FOV in degrees at 4:3 (Hor+ for wider screens); Doom: 90 */
  fov?: number;
  /** render resolution relative to the canvas' CSS size × devicePixelRatio (capped) */
  resolutionScale?: number;
  maxPixelRatio?: number;
  bloom?: boolean;
  bloomStrength?: number;
  dynamicLights?: boolean;
  /** dynamic light gain (light colors are 0..1, added in linear space) */
  lightIntensity?: number;
  /** 0..1 contact darkening strength */
  ao?: number;
  /** animate sector light specials on the client (turn off if the sim already does) */
  clientLightSpecials?: boolean;
  /** film grain amount (0 = off) */
  grain?: number;
}

const DEFAULTS: Required<RendererOptions> = {
  pixelAspect: 1.2, fov: 90, resolutionScale: 1, maxPixelRatio: 1.5, bloom: true, bloomStrength: 0.9,
  dynamicLights: true, lightIntensity: 1.6, ao: 1, clientLightSpecials: true, grain: 0.012,
};

const TAU = Math.PI * 2;
const SPR_PLAY = spriteNum('PLAY');
const SPRITE_CAP = 4096;
const FUZZ_CAP = 512;

function dataTex(data: Float32Array, w: number, h: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data as Float32Array<ArrayBuffer>, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

class SpriteBatch {
  readonly geo = new THREE.InstancedBufferGeometry();
  readonly pos: Float32Array; readonly rect: Float32Array; readonly off: Float32Array; readonly misc: Float32Array;
  private attrs: THREE.InstancedBufferAttribute[];
  count = 0;
  constructor(readonly cap: number) {
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
    this.geo.setIndex([0, 3, 1, 1, 3, 2]);
    this.pos = new Float32Array(cap * 4); this.rect = new Float32Array(cap * 4);
    this.off = new Float32Array(cap * 4); this.misc = new Float32Array(cap * 4);
    this.attrs = [
      new THREE.InstancedBufferAttribute(this.pos, 4), new THREE.InstancedBufferAttribute(this.rect, 4),
      new THREE.InstancedBufferAttribute(this.off, 4), new THREE.InstancedBufferAttribute(this.misc, 4),
    ];
    ['iPos', 'iRect', 'iOff', 'iMisc'].forEach((n, i) => { this.attrs[i].setUsage(THREE.DynamicDrawUsage); this.geo.setAttribute(n, this.attrs[i]); });
    this.geo.instanceCount = 0;
  }
  push(x: number, y: number, z: number, sector: number, rx: number, ry: number, rw: number, rh: number,
    left: number, top: number, flags: number, trans: number, light: number): void {
    if (this.count >= this.cap) return;
    const o = this.count++ * 4;
    this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z; this.pos[o + 3] = sector;
    this.rect[o] = rx; this.rect[o + 1] = ry; this.rect[o + 2] = rw; this.rect[o + 3] = rh;
    this.off[o] = left; this.off[o + 1] = top; this.off[o + 2] = flags; this.off[o + 3] = trans;
    this.misc[o] = light;
  }
  commit(): void {
    for (const a of this.attrs) { a.clearUpdateRanges(); a.addUpdateRange(0, this.count * 4); a.needsUpdate = true; }
    this.geo.instanceCount = this.count;
  }
}

export class Renderer {
  readonly wad: Wad;
  readonly map: MapData;
  readonly assets: RenderAssets;
  readonly geometry: MapGeometry;
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 2, 30000);
  readonly options: Required<RendererOptions>;
  /** frame statistics (for debug overlays) */
  readonly stats = { sprites: 0, lights: 0, calls: 0, triangles: 0 };

  private frame: RenderFrame | null = null;
  private post = new PostFX();
  private lights: LightManager;
  private fx: SectorLightFx;
  private ssSector: Int32Array;
  private sectorData: Float32Array;
  private sectorTex: THREE.DataTexture;
  private floorH: Float32Array;
  private ceilH: Float32Array;
  private lightLv: Float32Array;
  private sideData: Float32Array;
  private sideTex: THREE.DataTexture;
  private sideBase: Float32Array;
  private simTex: Int32Array | null = null;
  private simFlat: Int32Array | null = null;
  private sprites = new SpriteBatch(SPRITE_CAP);
  private fuzz = new SpriteBatch(FUZZ_CAP);
  private psp = new THREE.InstancedBufferGeometry();
  private pspScreen = new Float32Array(8); private pspRect = new Float32Array(8); private pspInfo = new Float32Array(8);
  private pspAttrs: THREE.InstancedBufferAttribute[] = [];
  private pspScene = new THREE.Scene();
  private pspCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private u: Record<string, THREE.IUniform>;
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private tmpV = new THREE.Vector3();
  private hudPx = 0;
  private bodyRenderer: PlayerBodyRenderer | null = null;
  /** this frame's player bodies by slot */
  private readonly slotMobj = new Map<number, RenderMobj>();
  private bodies: RenderMobj[] = [];
  private mobjById = new Map<number, RenderMobj>();
  private startTime = performance.now();
  private lastW = 0;
  private lastH = 0;

  constructor(canvas: HTMLCanvasElement, wadData: Uint8Array | ArrayBuffer | Wad, mapName: string, options: RendererOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.wad = wadData instanceof Wad ? wadData : loadWad(wadData instanceof Uint8Array ? wadData : new Uint8Array(wadData));
    this.map = parseMap(mapName, this.wad.mapLumps(mapName));
    this.assets = new RenderAssets(this.wad, skyTextureForMap(mapName));
    this.geometry = buildGeometry(this.map, this.assets);
    this.fx = new SectorLightFx(this.map);
    this.lights = new LightManager(this.map, this.geometry.adjacency, (sp, fr) => this.assets.spriteGlow(sp, fr));

    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance' });
    this.gl.autoClear = false;
    this.gl.info.autoReset = false;
    this.gl.setClearColor(0x000000, 1);

    const nsec = this.map.sectors.length;
    this.ssSector = new Int32Array(this.map.subsectors.length);
    this.geometry.polys.forEach((p, i) => { this.ssSector[i] = p ? p.sector : 0; });
    const texW = 1024;
    this.sectorData = new Float32Array(texW * Math.max(1, Math.ceil((nsec * 2) / texW)) * 4);
    this.floorH = new Float32Array(nsec); this.ceilH = new Float32Array(nsec); this.lightLv = new Float32Array(nsec);
    this.map.sectors.forEach((s, i) => {
      this.floorH[i] = s.floor; this.ceilH[i] = s.ceil; this.lightLv[i] = s.light;
      const o = i * 8;
      this.sectorData[o + 4] = this.assets.flatId(s.floorPic);
      this.sectorData[o + 5] = this.assets.flatId(s.ceilPic);
    });
    this.sectorTex = dataTex(this.sectorData, texW, this.sectorData.length / 4 / texW);
    const nsides = this.map.sides.length;
    this.sideData = new Float32Array(texW * Math.max(1, Math.ceil(nsides / texW)) * 4);
    this.map.sides.forEach((s, i) => {
      this.sideData.set([this.assets.textureId(s.top), this.assets.textureId(s.mid), this.assets.textureId(s.bottom), 0], i * 4);
    });
    this.sideBase = this.sideData.slice();
    this.sideTex = dataTex(this.sideData, texW, this.sideData.length / 4 / texW);
    const ao = buildAoTexture(this.map, this.geometry.bounds);

    const posVec = this.lights.posVec, colVec = this.lights.colVec;
    this.u = {
      uPal: { value: this.assets.palTex }, uPalNum: { value: 0 }, uFixedCmap: { value: -1 }, uExtraLight: { value: 0 },
      uCamPos: { value: new THREE.Vector3() }, uCamFwd: { value: new THREE.Vector2(1, 0) },
      uCamFwd3: { value: new THREE.Vector3(1, 0, 0) }, uCamRight: { value: new THREE.Vector2(0, -1) },
      uLightPos: { value: posVec }, uLightCol: { value: colVec }, uLightCount: { value: 0 },
      uLightReach: { value: this.lights.reachTex }, uLightTiles: { value: this.lights.tileTex }, uViewport: { value: new THREE.Vector2(1, 1) }, uDynScale: { value: 1 },
      uSectors: { value: this.sectorTex }, uTexInfo: { value: this.assets.texInfo }, uAtlas: { value: this.assets.atlas },
      uSides: { value: this.sideTex }, uTic: { value: 0 }, uTime: { value: 0 },
      uAo: { value: ao.tex }, uAoXform: { value: new THREE.Vector4(ao.origin[0], ao.origin[1], 1 / (ao.cell * ao.size[0]), 1 / (ao.cell * ao.size[1])) },
      uAoStrength: { value: this.options.ao },
      uSkyTex: { value: this.assets.skyTexId }, uSkyTop: { value: this.skyTopColor() }, uSkyStretch: { value: 160 }, // Doom: 1 sky texel per row of a 320x200 view (160 rows per unit tan)
      uSpriteAtlas: { value: this.assets.spriteAtlas }, uTrans: { value: this.assets.transTex },
      uPspLevel: { value: 0 }, uPspLight: { value: new THREE.Vector3() }, uPspGlow: { value: 0.2 },
    };
    const mat = (vs: string, fs: string, extra: Partial<THREE.ShaderMaterialParameters> = {}, own: Record<string, THREE.IUniform> = {}) =>
      new THREE.RawShaderMaterial({ vertexShader: vs, fragmentShader: fs, glslVersion: THREE.GLSL3, uniforms: { ...this.u, ...own }, ...extra });
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, order: number) => {
      const o = new THREE.Mesh(g, m);
      o.frustumCulled = false;
      o.renderOrder = order;
      o.matrixAutoUpdate = false;
      this.scene.add(o);
      return o;
    };
    mesh(this.geometry.flats, mat(FLAT_VS, FLAT_FS), 0);
    mesh(this.geometry.walls, mat(WALL_VS, WALL_FS), 1);
    mesh(this.geometry.sky, mat(SKY_VS, SKY_FS), 2);
    mesh(this.geometry.masked, mat(WALL_VS, WALL_FS, { side: THREE.FrontSide }), 3);
    mesh(this.sprites.geo, mat(SPRITE_VS, SPRITE_FS, { side: THREE.DoubleSide }, { uFuzz: { value: 0 } }), 4);
    mesh(this.fuzz.geo, mat(SPRITE_VS, SPRITE_FS, {
      side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    }, { uFuzz: { value: 1 } }), 5);

    // psprites (screen space)
    this.psp.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
    this.psp.setIndex([0, 3, 1, 1, 3, 2]);
    for (const [n, a] of [['iScreen', this.pspScreen], ['iRect', this.pspRect], ['iInfo', this.pspInfo]] as const) {
      const at = new THREE.InstancedBufferAttribute(a, 4);
      at.setUsage(THREE.DynamicDrawUsage);
      this.pspAttrs.push(at);
      this.psp.setAttribute(n, at);
    }
    this.psp.instanceCount = 0;
    const pm = new THREE.Mesh(this.psp, mat(PSPRITE_VS, PSPRITE_FS, { depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    pm.frustumCulled = false;
    this.pspScene.add(pm);

    this.camera.up.set(0, 0, 1);
    this.applyOptions();
  }

  // ---- public API ---------------------------------------------------------------

  setFrame(frame: RenderFrame): void {
    this.frame = frame;
  }

  /** Height in CSS px of the status bar drawn over the bottom of the canvas (moves the weapon up like Doom). */
  setHudHeightPx(px: number): void { this.hudPx = Math.max(0, px); }

  /** The sim's texture/flat name tables (world_map_texture_names / world_map_flat_names). */
  setSimNameTables(textures: readonly string[], flats: readonly string[]): void {
    this.simTex = Int32Array.from(textures, (n) => this.assets.textureId(n));
    this.simFlat = Int32Array.from(flats, (n) => this.assets.flatId(n));
  }

  /** The current player-body hook, if any. */
  get playerBodyRenderer(): PlayerBodyRenderer | null { return this.bodyRenderer; }

  /** Draw player bodies with something else (3D models); null = classic sprites. */
  setPlayerBodyRenderer(r: PlayerBodyRenderer | null): void {
    if (this.bodyRenderer && this.bodyRenderer !== r) this.bodyRenderer.dispose?.();
    this.bodyRenderer = r;
  }

  setOptions(o: RendererOptions): void {
    Object.assign(this.options, o);
    this.applyOptions();
  }

  /** Sector index at a map position (R_PointInSubsector). */
  sectorAt(x: number, y: number): number {
    return this.ssSector[pointInSubsector(this.map, x, y)] ?? 0;
  }

  render(): void {
    const f = this.frame;
    if (!f) return;
    const now = (performance.now() - this.startTime) / 1000;
    this.resize();
    const cam = f.camera;
    const tic = f.tic;

    // ---- animated textures, sector state ----------------------------------------
    this.assets.updateAnimations(tic);
    if (this.options.clientLightSpecials) this.fx.update(tic);
    const secs = f.sectors;
    const nsec = this.map.sectors.length;
    for (let i = 0; i < nsec; i++) {
      const s = secs ? secs[i] : undefined;
      const base = this.map.sectors[i];
      const fl = s ? s.floor : base.floor, ce = s ? s.ceil : base.ceil, li = s ? s.light : base.light;
      this.floorH[i] = fl; this.ceilH[i] = ce;
      const lv = this.options.clientLightSpecials ? this.fx.light(i, li) : li;
      this.lightLv[i] = lv;
      const o = i * 8;
      this.sectorData[o] = fl; this.sectorData[o + 1] = ce; this.sectorData[o + 2] = lv;
      if (s && this.simFlat) {
        if (s.floorpic !== undefined && s.floorpic >= 0) this.sectorData[o + 4] = this.simFlat[s.floorpic] ?? -1;
        if (s.ceilpic !== undefined && s.ceilpic >= 0) this.sectorData[o + 5] = this.simFlat[s.ceilpic] ?? -1;
      }
    }
    this.sectorTex.needsUpdate = true;
    if (f.lineTextures && this.simTex) this.applyLineTextures(f.lineTextures);

    // ---- camera -------------------------------------------------------------------
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    this.camera.position.set(cam.x, cam.y, cam.z);
    this.camera.lookAt(cam.x + cy * cp, cam.y + sy * cp, cam.z + sp);
    this.camera.updateMatrixWorld();
    this.projView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    this.u.uCamPos.value.set(cam.x, cam.y, cam.z);
    this.u.uCamFwd.value.set(cy, sy);
    this.u.uCamFwd3.value.set(cy, sy, 0);
    this.u.uCamRight.value.set(sy, -cy);
    this.u.uTic.value = tic;
    this.u.uTime.value = now;

    // ---- player status --------------------------------------------------------------
    const p = f.player;
    let extralight = 0, fixed = -1, pal = 0;
    if (p) {
      extralight = p.extralight;
      // 1 = light amplification (near fullbright), 32 = invulnerability inverse map
      fixed = p.fixedcolormap > 0 ? p.fixedcolormap : -1;
      pal = screenPalette(p.damagecount, p.bonuscount, p.powers[1] ?? 0, p.powers[3] ?? 0);
    }
    this.u.uExtraLight.value = extralight;
    this.u.uFixedCmap.value = fixed;
    this.u.uPalNum.value = pal;

    // ---- mobjs: sprites, lights --------------------------------------------------------
    const count = f.mobjCount ?? f.mobjs.length;
    const viewId = f.viewMobjId ?? -1;
    this.lights.begin();
    this.sprites.count = 0;
    this.fuzz.count = 0;
    this.mobjById.clear();
    this.slotMobj.clear();
    let nb = 0;
    const useBodies = this.bodyRenderer !== null;
    for (let i = 0; i < count; i++) {
      const m = f.mobjs[i];
      this.mobjById.set(m.id, m);
      if (m.slot >= 0) this.slotMobj.set(m.slot, m);
      const sector = this.sectorAt(m.x, m.y);
      if (this.options.dynamicLights) this.lights.addMobj(m, sector, now);
      if (m.id === viewId) continue;
      if (useBodies && m.sprite === SPR_PLAY) {
        this.bodies[nb++] = m;
        continue;
      }
      this.pushSprite(m, sector, cam.x, cam.y);
    }
    this.sprites.commit();
    this.fuzz.commit();
    this.stats.sprites = this.sprites.count + this.fuzz.count;

    // the local player's muzzle flash (its own body is not drawn, so PLAY frame F doesn't
    // light it): color measured from the flash psprite, reach from MUZZLE_TABLE
    if (this.options.dynamicLights && p && p.flash && p.flash.sprite >= 0 && !this.mobjById.has(viewId)) {
      const g = this.assets.spriteGlow(p.flash.sprite, p.flash.frame);
      const mt = MUZZLE_TABLE[SPRITE_NAMES[p.flash.sprite]] ?? [160, 1.2];
      if (g) {
        const fx = cam.x + cy * 24, fyy = cam.y + sy * 24;
        this.lights.add(fx, fyy, cam.z - 8, mt[0], g.color[0] * mt[1], g.color[1] * mt[1], g.color[2] * mt[1], this.sectorAt(fx, fyy));
      }
    }
    this.lights.finish(this.camera.position, this.frustum, this.projView, this.floorH, this.ceilH, this.options.dynamicLights);
    this.u.uLightCount.value = this.lights.count;
    this.stats.lights = this.lights.count;

    if (this.bodyRenderer) {
      const dyn = this.options.dynamicLights ? this.options.lightIntensity : 0;
      this.bodyRenderer.update(this.bodies, nb, {
        scene: this.scene, camera: this.camera, extralight, tic, time: now,
        lightOf: (m) => this.lightLv[this.sectorAt(m.x, m.y)] ?? 0,
        floorOf: (m) => this.floorH[this.sectorAt(m.x, m.y)] ?? 0,
        ceilOf: (m) => this.ceilH[this.sectorAt(m.x, m.y)] ?? Infinity,
        playerAt: (slot) => this.slotMobj.get(slot),
        events: f.events, eventCount: f.eventCount ?? f.events.length,
        dynLightAt: (m, z, out) => {
          if (!dyn) return out.set(0, 0, 0);
          return this.lights.lightAt(m.x, m.y, z, this.sectorAt(m.x, m.y), out).multiplyScalar(dyn);
        },
        palette: this.assets.palTex, palNum: pal, fixedColormap: fixed,
      });
    }

    // ---- psprites ------------------------------------------------------------------
    this.updatePsprites(f, extralight);

    // ---- draw ------------------------------------------------------------------------
    const gl = this.gl;
    gl.info.reset();
    gl.setRenderTarget(this.post.scene);
    gl.clear(true, true, false);
    gl.render(this.scene, this.camera);
    if (this.psp.instanceCount) {
      gl.clearDepth();
      gl.render(this.pspScene, this.pspCam);
    }
    this.post.finish(gl, now);
    this.stats.calls = gl.info.render.calls;
    this.stats.triangles = gl.info.render.triangles;
  }

  dispose(): void {
    this.bodyRenderer?.dispose?.();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
    });
    this.psp.dispose();
    this.post.dispose();
    this.lights.dispose();
    this.assets.dispose();
    this.sectorTex.dispose();
    this.sideTex.dispose();
    (this.u.uAo.value as THREE.Texture).dispose();
    this.gl.dispose();
  }

  // ---- internals -------------------------------------------------------------------

  private applyOptions(): void {
    const o = this.options;
    this.post.bloom = o.bloom;
    this.post.bloomStrength = o.bloomStrength;
    this.post.composite.uniforms.uGrain.value = o.grain;
    if (this.u) {
      this.u.uAoStrength.value = o.ao;
      this.u.uDynScale.value = o.dynamicLights ? o.lightIntensity : 0;
    }
    this.lastW = 0; // force projection update
  }

  private resize(): void {
    const c = this.gl.domElement;
    const dpr = Math.min(window.devicePixelRatio || 1, this.options.maxPixelRatio) * this.options.resolutionScale;
    const cw = Math.max(1, c.clientWidth || c.width), ch = Math.max(1, c.clientHeight || c.height);
    const w = Math.max(1, Math.round(cw * dpr)), h = Math.max(1, Math.round(ch * dpr));
    if (w === this.lastW && h === this.lastH) return;
    this.lastW = w; this.lastH = h;
    this.gl.setPixelRatio(1);
    this.gl.setSize(w, h, false);
    this.post.setSize(w, h);
    this.u.uViewport.value.set(w, h);
    // Hor+: vertical extent fixed by the 4:3 reference, horizontal grows with the aspect
    const tx43 = Math.tan((this.options.fov * Math.PI) / 360);
    const ty = (tx43 * 0.75) / this.options.pixelAspect;
    const tx = ty * (w / h) * this.options.pixelAspect;
    this.camera.fov = (2 * Math.atan(ty) * 180) / Math.PI;
    this.camera.aspect = tx / ty;
    this.camera.updateProjectionMatrix();
  }

  private applyLineTextures(lt: ArrayLike<number>): void {
    const lines = this.map.lines;
    const st = this.simTex!;
    let dirty = false;
    const n = Math.min(lines.length, Math.floor(lt.length / 3));
    for (let i = 0; i < n; i++) {
      const s = lines[i].front;
      if (s < 0) continue;
      const o = s * 4;
      for (let k = 0; k < 3; k++) {
        const v = lt[i * 3 + k];
        const id = v > 0 ? (st[v] ?? -1) : -1;
        const ch = k === 0 ? 0 : k === 1 ? 1 : 2;
        // only switch-style changes: keep "-" where the map had none and the sim has none
        if (this.sideData[o + ch] !== id && !(id < 0 && this.sideBase[o + ch] < 0)) { this.sideData[o + ch] = id; dirty = true; }
      }
    }
    if (dirty) this.sideTex.needsUpdate = true;
  }

  private pushSprite(m: RenderMobj, sector: number, vx: number, vy: number): void {
    // R_ProjectSprite: rot = (R_PointToAngle(thing) - thing->angle + ANG45/2*9) >> 29
    const a = Math.atan2(m.y - vy, m.x - vx);
    let r = (a - m.angle + (TAU * 9) / 16) % TAU;
    if (r < 0) r += TAU;
    const rot = Math.floor(r / (TAU / 8)) & 7;
    const L = this.assets.spriteLump(m.sprite, m.frame, rot);
    if (!L) return;
    const shadow = (m.flags & MF_SHADOW) !== 0;
    const flags = (L.flip ? 1 : 0) | (m.frame & FF_FULLBRIGHT ? 2 : 0) | (shadow ? 4 : 0);
    const b = shadow ? this.fuzz : this.sprites;
    const R = L.info.rect;
    b.push(m.x, m.y, m.z, sector, R.x, R.y, R.w, R.h, L.info.left, L.info.top, flags,
      m.translation > 0 && m.translation < this.assets.translationCount ? m.translation : 0, this.lightLv[sector] ?? 255);
  }

  private updatePsprites(f: RenderFrame, extralight: number): void {
    const p = f.player;
    let n = 0;
    if (p) {
      const W = this.lastW, H = this.lastH;
      const dpr = H / Math.max(1, this.gl.domElement.clientHeight || H);
      const hud = this.hudPx * dpr;
      const sy = H / 200, sx = sy / this.options.pixelAspect;
      const cyPix = (H - hud) / 2;
      const add = (ps: RenderPsprite | null) => {
        if (!ps || ps.sprite < 0) return;
        const L = this.assets.spriteLump(ps.sprite, ps.frame, 0);
        if (!L) return;
        const R = L.info.rect;
        // R_DrawPSprite: x1 = sx - leftoffset (320 space), top row = sy - topoffset - 0.5 (200 space)
        const x0 = W / 2 + (ps.sx - L.info.left - 160) * sx;
        const y0 = cyPix + (ps.sy - L.info.top - 0.5 - 100) * sy;
        const x1 = x0 + R.w * sx, y1 = y0 + R.h * sy;
        const o = n * 4;
        this.pspScreen[o] = (x0 / W) * 2 - 1; this.pspScreen[o + 1] = 1 - (y0 / H) * 2;
        this.pspScreen[o + 2] = (x1 / W) * 2 - 1; this.pspScreen[o + 3] = 1 - (y1 / H) * 2;
        this.pspRect[o] = R.x; this.pspRect[o + 1] = R.y; this.pspRect[o + 2] = R.w; this.pspRect[o + 3] = R.h;
        this.pspInfo[o] = (L.flip ? 1 : 0) | (ps.frame & FF_FULLBRIGHT ? 2 : 0);
        n++;
      };
      add(p.weapon);
      add(p.flash);
      const cam = f.camera;
      const sec = this.sectorAt(cam.x, cam.y);
      const invis = p.powers[2] ?? 0;
      if (invis > 4 * 32 || invis & 8) this.u.uPspLevel.value = -1;
      else {
        const ln = Math.max(0, Math.min(15, (this.lightLv[sec] >> 4) + extralight));
        this.u.uPspLevel.value = Math.max(0, Math.min(31, (15 - ln) * 4 - 23));
      }
      this.lights.lightAt(cam.x, cam.y, cam.z - 10, sec, this.tmpV);
      (this.u.uPspLight.value as THREE.Vector3).copy(this.tmpV).multiplyScalar(this.options.dynamicLights ? 0.6 : 0);
    }
    this.psp.instanceCount = n;
    for (const a of this.pspAttrs) a.needsUpdate = true;
  }

  private skyTopColor(): THREE.Vector3 {
    const id = this.assets.skyTexId;
    const out = new THREE.Vector3(0.2, 0.2, 0.25);
    if (id < 0) return out;
    const r = this.assets.atlasRects[id];
    const data = this.assets.atlas.image.data as Uint8Array;
    const aw = this.assets.atlas.image.width;
    let R = 0, G = 0, B = 0;
    const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    for (let x = 0; x < r.w; x++) {
      const idx = data[(r.y * aw + r.x + x) * 2];
      const pp = this.assets.pal.playpal;
      R += lin(pp[idx * 3]); G += lin(pp[idx * 3 + 1]); B += lin(pp[idx * 3 + 2]);
    }
    return out.set(R / r.w, G / r.w, B / r.w);
  }
}

export { MAX_LIGHTS };
