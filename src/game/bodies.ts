/**
 * Player bodies as the 3D box marine (src/model), through the renderer's
 * `setPlayerBodyRenderer` hook.
 *
 * Per body mobj (live players and their corpses; the camera's own body never
 * arrives here):
 *   - position/angle: the interpolated RenderMobj (Doom map units, Z-up). The model
 *     is Y-up facing +X, so each sits in a holder turned +90° about X, and the
 *     Doom angle is its own rotation about its up axis;
 *   - frame: the sim's PLAY frame letter (A..W, FF_FULLBRIGHT stripped) is the pose;
 *     tics are not exported, so each frame is timed from its start;
 *   - walk speed: position delta per tic of the drawn (confirmed-ring) position,
 *     smoothed; airborne when standing clear of the floor;
 *   - light: the sector's Doom light + the viewer's extralight through the world's
 *     palette (damage tint, light amp and invulnerability colormaps included), plus
 *     the dynamic lights at the chest (a firing neighbour, rockets, plasma);
 *   - MF_SHADOW: the fuzz pass (multiply-darkening streaks, as the sprites);
 *   - colour: the RenderMobj's translation; a corpse (slot -1) keeps the colour it
 *     had while it was a player.
 *
 * Models share the factory's geometry and textures (one draw call each); bodies
 * that vanish go back to a small free list, the rest are disposed.
 */
import * as THREE from 'three';
import { createDoomguyFactory, type DoomguyFactory, type DoomguyModel } from '../model/index.js';
import type { Wad } from '../wad/index.js';
import type { PlayerBodyContext, PlayerBodyRenderer, RenderMobj } from '../render/types.js';

const MF_SHADOW = 0x40000;
const FF_FRAMEMASK = 0x7fff;
/** a body this many units above its floor is in the air (jump, fall) */
const AIRBORNE = 6;
/** models kept for reuse when bodies vanish */
const FREE_KEEP = 8;
/** drawn bodies further than this are not posed (they are too small to read, and off the camera's interest) */
const POSE_RANGE = 4096;

/** For tests: draw every body with the invisibility fuzz. */
export const bodyDebug = { fuzz: false };

interface Body {
  id: number;
  model: DoomguyModel;
  holder: THREE.Group;
  color: number;
  x: number;
  y: number;
  tic: number;
  speed: number;
  seen: number;
}

let factoryCache: { wad: Wad; f: DoomguyFactory; users: number } | null = null;

/** One factory per WAD, shared by every ModelBodies (the prewarmed view and the match's). */
function factoryFor(wad: Wad): DoomguyFactory {
  if (!factoryCache || factoryCache.wad !== wad) {
    factoryCache?.f.dispose();
    factoryCache = { wad, f: createDoomguyFactory(wad), users: 0 };
  }
  factoryCache.users++;
  return factoryCache.f;
}
function releaseFactory(f: DoomguyFactory): void {
  if (factoryCache?.f !== f) return;
  if (--factoryCache.users <= 0) { f.dispose(); factoryCache = null; }
}

export class ModelBodies implements PlayerBodyRenderer {
  private readonly factory: DoomguyFactory;
  private readonly live = new Map<number, Body>();
  private readonly free: Body[] = [];
  /** last known colour of a body, by mobj id (corpses keep their player's) */
  private readonly colorOf = new Map<number, number>();
  private readonly tmp = new THREE.Vector3();
  private readonly sphere = new THREE.Sphere();
  private readonly frustum = new THREE.Frustum();
  private readonly pv = new THREE.Matrix4();
  private stamp = 0;
  private scene: THREE.Scene | null = null;
  private disposed = false;
  /** bodies posed last frame (for the debug line / tests) */
  posed = 0;

  constructor(wad: Wad) {
    this.factory = factoryFor(wad);
  }

  update(bodies: readonly RenderMobj[], count: number, ctx: PlayerBodyContext): void {
    if (this.disposed) return;
    this.scene = ctx.scene;
    const stamp = ++this.stamp;
    const cam = ctx.camera;
    this.pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    let posed = 0;
    for (let i = 0; i < count; i++) {
      const m = bodies[i];
      let b = this.live.get(m.id);
      if (m.slot >= 0) this.colorOf.set(m.id, m.translation);
      const color = m.slot >= 0 ? m.translation : (this.colorOf.get(m.id) ?? m.translation);
      if (!b) {
        b = this.take(m.id, color);
        b.x = m.x; b.y = m.y; b.tic = ctx.tic; b.speed = 0;
        ctx.scene.add(b.holder);
      }
      b.seen = stamp;
      if (b.color !== color) { b.color = color; b.model.setColor(color); }

      // walk speed: drawn position delta per tic (the confirmed ring's motion)
      const dt = ctx.tic - b.tic;
      if (dt > 0.05) {
        const d = Math.hypot(m.x - b.x, m.y - b.y) / dt;
        const sp = d > 64 ? 0 : d; // a teleport is not a sprint
        b.speed += (sp - b.speed) * Math.min(1, dt * 0.35);
        b.x = m.x; b.y = m.y; b.tic = ctx.tic;
      } else if (dt < 0) { b.x = m.x; b.y = m.y; b.tic = ctx.tic; }

      const h = b.holder;
      h.position.set(m.x, m.y, m.z);
      b.model.object.rotation.y = m.angle;
      // off camera or far away: placed but not posed
      this.sphere.center.set(m.x, m.y, m.z + 28);
      this.sphere.radius = 48;
      const dx = m.x - cam.position.x, dy = m.y - cam.position.y;
      const visible = this.frustum.intersectsSphere(this.sphere) && dx * dx + dy * dy < POSE_RANGE * POSE_RANGE;
      h.visible = visible;
      if (!visible) continue;
      posed++;
      const frame = m.frame & FF_FRAMEMASK;
      const model = b.model;
      model.setLight(ctx.lightOf(m), ctx.extralight);
      model.setWorldPalette(ctx.palette, ctx.palNum, ctx.fixedColormap);
      const dl = ctx.dynLightAt(m, m.z + 32, this.tmp);
      // one sample for the whole body (the sprites light per pixel with a wrapped
      // facing term, ~0.7 on average); capped so a stack of plasma balls cannot blow it white
      const k = 0.7 / Math.max(1, Math.max(dl.x, dl.y, dl.z) * 0.7 / 1.1);
      model.setDynamicLight(dl.x * k, dl.y * k, dl.z * k);
      model.setFuzz((m.flags & MF_SHADOW) !== 0 || bodyDebug.fuzz, ctx.time);
      model.pose({
        frame,
        moveSpeed: b.speed,
        airborne: m.z > ctx.floorOf(m) + AIRBORNE,
        time: ctx.time,
      });
    }
    this.posed = posed;
    // bodies that are gone: back to the free list, or disposed
    for (const [id, b] of this.live) {
      if (b.seen === stamp) continue;
      this.live.delete(id);
      b.holder.removeFromParent();
      if (this.free.length < FREE_KEEP) this.free.push(b);
      else b.model.dispose();
    }
    if (this.colorOf.size > 512) {
      for (const id of this.colorOf.keys()) { if (!this.live.has(id)) this.colorOf.delete(id); if (this.colorOf.size <= 256) break; }
    }
  }

  get count(): number { return this.live.size; }

  private take(id: number, color: number): Body {
    const reuse = this.free.pop();
    if (reuse) {
      reuse.id = id;
      reuse.model.reset(id);
      reuse.model.setColor(color);
      reuse.color = color;
      reuse.speed = 0;
      this.live.set(id, reuse);
      return reuse;
    }
    const model = this.factory.create(color, id);
    model.setSceneLighting(0);
    model.setEmissiveAlpha(1);
    const holder = new THREE.Group();
    holder.name = 'player-body';
    holder.rotation.x = Math.PI / 2; // Y-up model in the Z-up world
    holder.add(model.object);
    holder.matrixAutoUpdate = true;
    const b: Body = { id, model, holder, color, x: 0, y: 0, tic: 0, speed: 0, seen: 0 };
    this.live.set(id, b);
    return b;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of [...this.live.values(), ...this.free]) { b.holder.removeFromParent(); b.model.dispose(); }
    this.live.clear();
    this.free.length = 0;
    this.scene = null;
    releaseFactory(this.factory);
  }
}
