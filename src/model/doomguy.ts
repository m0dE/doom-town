/**
 * The marine as a 3D box model: Freedoom's player sprite rebuilt as ~30 boxes,
 * textured with the sprite's own pixels (palette indices), rigged on one
 * skinned mesh, and animated procedurally from Doom's player frames.
 *
 * Conventions (see rig.ts): Doom map units, stands on y = 0, 56 tall, faces +X
 * (Doom angle 0), his left toward -Z. Doom (x, y, z) → three (x, z, -y); set
 * `object.rotation.y = angle` for a Doom angle.
 *
 *   const factory = createDoomguyFactory(wad);       // once: atlas, geometry, tables
 *   const guy = factory.create(color);                // per player: one draw call
 *   scene.add(guy.object);
 *   guy.setLight(sector.lightlevel, extralight);
 *   guy.pose({ frame, tics, moveSpeed, pitch, time }); // every rendered frame
 */
import * as THREE from 'three';
import { readPalette, buildTranslations, PLAYER_COLORS, type Wad, type PaletteData } from '../wad/index.js';
import { buildRig, NUM_BONES, type BuiltRig } from './rig.js';
import { SpriteSource } from './texture.js';
import { createDoomguyMaterial, makeIndexTexture, makePaletteTexture, type DoomguyUniforms, type SharedTextures } from './material.js';
import { FRAME, FRAME_TICS, TICRATE, gibMatrices, gibParts, lerpPose, poseFor, solvePose, zeroPose, type Pose } from './anim.js';

export interface DoomguyPoseInput {
  /** Doom sprite frame (A = 0 … W = 22), as the sim reports it */
  frame: number;
  /** tics left in the current state (mobj->tics); optional, else timed from `time` */
  tics?: number;
  /** horizontal speed in map units per tic (Doom momentum); drives the walk cycle */
  moveSpeed?: number;
  /** view pitch in radians, positive up (freelook) */
  pitch?: number;
  /** off the ground (jump pose) */
  airborne?: boolean;
  /** seconds, monotonic */
  time: number;
}

export interface DoomguyOptions {
  wad: Wad;
  color?: number;
  /** seed for the gib scatter (e.g. the player number), default 0 */
  seed?: number;
}

interface Shared {
  rig: BuiltRig;
  tex: SharedTextures;
  pal: PaletteData;
  parts: ReturnType<typeof gibParts>;
}

export class DoomguyModel {
  readonly object: THREE.Group;
  readonly mesh: THREE.SkinnedMesh;
  private readonly uniforms: DoomguyUniforms;
  private readonly material: THREE.MeshLambertMaterial;
  private readonly bones: THREE.Bone[] = [];
  private readonly mats: THREE.Matrix4[] = [];
  private readonly gibStart: THREE.Matrix4[] = [];
  private cur: Pose = zeroPose();
  private lastTime = -1;
  private lastFrame = -1;
  private frameStart = 0;
  private deathStart = 0;
  private gibStartTime = -1;
  private walkPhase = 0;
  private walkAmp = 0;
  private lastWalkFrame = -1;
  private lastWalkChange = -10;
  private seed: number;
  private fuzz = false;

  constructor(private readonly shared: Shared, color = 0, seed = 0) {
    this.seed = seed;
    const { material, uniforms } = createDoomguyMaterial(shared.tex);
    this.material = material;
    this.uniforms = uniforms;
    for (let i = 0; i < NUM_BONES; i++) {
      const b = new THREE.Bone();
      b.matrixAutoUpdate = false;
      this.bones.push(b);
      this.mats.push(new THREE.Matrix4());
      this.gibStart.push(new THREE.Matrix4());
    }
    this.mesh = new THREE.SkinnedMesh(shared.rig.geometry, material);
    for (const b of this.bones) this.mesh.add(b);
    const skeleton = new THREE.Skeleton(this.bones, this.bones.map(() => new THREE.Matrix4()));
    this.mesh.bind(skeleton, new THREE.Matrix4());
    this.mesh.frustumCulled = true;
    this.mesh.boundingSphere = shared.rig.geometry.boundingSphere!.clone();
    this.object = new THREE.Group();
    this.object.name = 'doomguy';
    this.object.add(this.mesh);
    this.setColor(color);
    this.pose({ frame: 0, time: 0 });
  }

  /** Player colour: a row of `buildTranslations` (index into PLAYER_COLORS). */
  setColor(i: number): void {
    this.uniforms.uColor.value = Math.max(0, Math.min(this.shared.tex.numColors - 1, i | 0));
  }

  /** Doom lighting: sector light 0..255 and the player's extralight (gun flash), in light levels. */
  setLight(level: number, extralight = 0): void {
    this.uniforms.uLightLevel.value = level;
    this.uniforms.uExtraLight.value = extralight;
  }

  /**
   * 0 = Doom's light tables only (in the world), 1 = lit by the scene's three.js
   * lights (start screen); in between mixes them.
   */
  setSceneLighting(mix: number): void { this.uniforms.uLit.value = mix; }

  /** Brightness of the fullbright muzzle flash under scene lights (start screen glow). */
  setFlashBoost(k: number): void { this.uniforms.uFlashBoost.value = k; }

  /**
   * In the world: draw through the renderer's palette texture (256 × 14·34, COLORMAP rows
   * folded in) so screen tints and fixed colormaps match the sprites; `palNum` -1 = off.
   */
  setWorldPalette(tex: THREE.Texture | null, palNum: number, fixedColormap = -1): void {
    this.uniforms.uWorldPal.value = tex;
    this.uniforms.uPalNum.value = tex ? palNum : -1;
    this.uniforms.uFixedCmap.value = fixedColormap;
  }

  /** Dynamic light reaching the model (linear RGB), added like the sprites' (world palette mode). */
  setDynamicLight(r: number, g: number, b: number): void { this.uniforms.uDyn.value.set(r, g, b); }

  /** 1: alpha carries the emissive amount (a renderer that blooms on alpha); 0: opaque alpha. */
  setEmissiveAlpha(k: number): void { this.uniforms.uEmisAlpha.value = k; }

  /** Spectre fuzz (invisibility): darkens what is behind, like the fuzz sprites. */
  setFuzz(on: boolean, time = 0): void {
    this.uniforms.uFuzz.value = on ? 1 : 0;
    this.uniforms.uTime.value = time;
    if (on === this.fuzz) return;
    this.fuzz = on;
    const m = this.material;
    m.transparent = on;
    m.depthWrite = !on;
    m.blending = on ? THREE.CustomBlending : THREE.NormalBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.ZeroFactor; m.blendDst = THREE.SrcColorFactor;
    m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
    m.needsUpdate = true;
  }

  /** Forget the animation state (a pooled model taking over another body). */
  reset(seed = this.seed): void {
    this.seed = seed;
    this.cur = zeroPose();
    this.lastTime = -1;
    this.lastFrame = -1;
    this.frameStart = 0;
    this.deathStart = 0;
    this.gibStartTime = -1;
    this.walkPhase = 0;
    this.walkAmp = 0;
    this.lastWalkFrame = -1;
    this.lastWalkChange = -10;
  }

  pose(p: DoomguyPoseInput): void {
    const time = p.time;
    const dt = this.lastTime < 0 ? 0 : Math.max(0, Math.min(0.1, time - this.lastTime));
    this.lastTime = time;
    const frame = Math.max(0, Math.min(FRAME.W, p.frame | 0));
    const dying = frame >= FRAME.H;
    const wasDying = this.lastFrame >= FRAME.H;
    if (frame !== this.lastFrame) {
      this.frameStart = time;
      if (frame >= FRAME.H && frame <= FRAME.N && !(this.lastFrame >= FRAME.H && this.lastFrame <= FRAME.N)) {
        // entering death part-way (joined late): start at this frame's keyframe
        this.deathStart = time - (frame - FRAME.H) * 10 / TICRATE;
      }
      if (frame >= FRAME.O && !(this.lastFrame >= FRAME.O)) {
        for (let i = 0; i < NUM_BONES; i++) this.gibStart[i].copy(this.mats[i]);
        this.gibStartTime = time - (frame - FRAME.O) * 5 / TICRATE;
      }
      if (!dying && wasDying) this.walkAmp = 0;
    }
    // progress through the frame: from tics when given, else from time
    const dur = FRAME_TICS[frame] ?? -1;
    let progress: number;
    if (p.tics !== undefined && dur > 0) progress = 1 - Math.max(0, Math.min(dur, p.tics)) / dur;
    else progress = dur > 0 ? Math.min(1, ((time - this.frameStart) * TICRATE) / dur) : 0;

    // Walk cycle. Doom cycles A..D at a fixed 4 tics a frame whenever the player
    // moves; when the sim does that, the phase is locked to the frames (so the
    // legs match the sprite's), and the stride scales with speed. A frozen A with
    // speed (e.g. a sim that doesn't cycle) runs the cycle off the clock instead.
    if (frame <= FRAME.D) {
      if (frame !== this.lastWalkFrame && this.lastWalkFrame >= 0 && this.lastWalkFrame <= FRAME.D) this.lastWalkChange = time;
      const cycling = time - this.lastWalkChange < 0.3;
      const sp = p.moveSpeed;
      const targetAmp = sp !== undefined ? (sp > 0.3 ? Math.min(1, 0.3 + sp / 10) : 0) : cycling ? 1 : 0;
      this.walkAmp += (targetAmp - this.walkAmp) * Math.min(1, dt * 7);
      if (cycling) {
        const target = (frame + progress) / 4;
        let d = target - (this.walkPhase - Math.floor(this.walkPhase));
        if (d < -0.5) d += 1;
        if (d > 0.5) d -= 1;
        this.walkPhase += d * Math.min(1, dt * 25);
      } else if (sp !== undefined && sp > 0.3) {
        // Doom's run: 16 tics a cycle (2.2 Hz)
        this.walkPhase += dt * 2.19 * Math.min(1.2, Math.max(0.5, sp / 14));
      }
      this.lastWalkFrame = frame;
    } else {
      this.walkAmp *= Math.max(0, 1 - dt * 4);
      this.lastWalkFrame = -1;
    }
    if (this.lastFrame < 0 && frame <= FRAME.D) {
      // first pose: no easing in from nothing
      this.walkPhase = (frame + progress) / 4;
      if (p.moveSpeed !== undefined && p.moveSpeed > 0.3) this.walkAmp = Math.min(1, 0.3 + p.moveSpeed / 10);
    }

    this.uniforms.uFullbright.value = frame === FRAME.F ? 1 : 0;

    if (frame >= FRAME.O) {
      const t = time - this.gibStartTime;
      gibMatrices(this.gibStart, this.shared.parts, t, this.seed, this.mats);
      this.uniforms.uGore.value = Math.min(0.62, t * 2.5);
      this.uniforms.uGoreSeed.value = this.seed;
    } else {
      this.uniforms.uGore.value = 0;
      const target = poseFor({
        frame, progress, time, walkPhase: this.walkPhase, walkAmp: this.walkAmp,
        pitch: p.pitch ?? 0, airborne: !!p.airborne && !dying,
        deathTics: (time - this.deathStart) * TICRATE,
      });
      // ease toward the target; snappier for attack/pain so the recoil reads
      const rate = dying ? 1 : frame === FRAME.F || frame === FRAME.G ? 40 : 14;
      const k = dt === 0 || this.lastFrame < 0 ? 1 : Math.min(1, dt * rate);
      lerpPose(this.cur, this.cur, target, k);
      if (frame === FRAME.F) this.cur.flash = target.flash;
      if (dying) Object.assign(this.cur, target);
      solvePose(this.cur, this.mats, time);
    }
    this.lastFrame = frame;
    for (let i = 0; i < NUM_BONES; i++) this.bones[i].matrix.copy(this.mats[i]);
  }

  dispose(): void {
    this.object.removeFromParent();
    this.mesh.skeleton.dispose();
    this.material.dispose();
  }
}

export interface DoomguyFactory {
  create(color?: number, seed?: number): DoomguyModel;
  /** triangles in one model (all boxes, effects included) */
  readonly triangles: number;
  /** the palette-index atlas (for debugging/inspection) */
  readonly atlas: { w: number; h: number; data: Uint8Array };
  dispose(): void;
}

/** Builds the shared atlas/geometry/tables once; `create` is then cheap. */
export function createDoomguyFactory(wad: Wad): DoomguyFactory {
  const pal = readPalette(wad);
  const rig = buildRig(new SpriteSource(wad), pal);
  const trans = buildTranslations(pal);
  const tex: SharedTextures = {
    atlas: makeIndexTexture(rig.atlas.data, rig.atlas.w, rig.atlas.h),
    palette: makePaletteTexture(pal.playpal),
    colormap: makeIndexTexture(pal.colormap.slice(0, 34 * 256), 256, 34),
    translations: makeIndexTexture(trans, 256, PLAYER_COLORS.length),
    numColors: PLAYER_COLORS.length,
  };
  const shared: Shared = { rig, tex, pal, parts: gibParts(rig.boxes) };
  return {
    create: (color = 0, seed = 0) => new DoomguyModel(shared, color, seed),
    triangles: rig.triangles,
    atlas: rig.atlas,
    dispose() {
      rig.geometry.dispose();
      tex.atlas.dispose(); tex.palette.dispose(); tex.colormap.dispose(); tex.translations.dispose();
    },
  };
}

/** One-off model (builds its own factory). */
export function createDoomguy(opts: DoomguyOptions): DoomguyModel {
  return createDoomguyFactory(opts.wad).create(opts.color ?? 0, opts.seed ?? 0);
}
