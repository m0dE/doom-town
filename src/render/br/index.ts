// Battle royale in the world (DESIGN.md "Battle royale v2"), all visual: the storm wall
// and the next circle, the purple screen tint outside the zone, the sky dome for views
// from altitude, supply-drop smoke and flare, and the 3D buggy / dropship / parachute
// canopy (with the parachuter's and the driver's bodies handed back to the player-body
// path posed for it). The Renderer owns one RoyaleLayer and calls it from its mobj loop.
import * as THREE from 'three';
import type { PaletteData } from '../../wad';
import type { RenderMobj, RenderRoyale } from '../types';
import { buildBuggy, buildCanopy, buildDropship, type BuggyGeometry, type ShipGeometry } from './models';
import { palMaterial } from './palmodel';
import { SkyDome } from './sky';
import { SmokeColumns } from './smoke';
import { Storm } from './storm';

/** mobjtypes appended after MT_CRATE (137) by the sim (DESIGN.md "Battle royale v2") */
export const MT_DROPSHIP = 138, MT_PARACHUTER = 139, MT_BUGGY = 140;
/** MobjView flags: a supply-drop crate */
export const MF_SUPPLY = 0x20000000;
/** RenderMobj.pose values for the player-body hook */
export const POSE_SEATED = 1, POSE_FREEFALL = 2, POSE_CHUTE = 3;

const FF_FRAMEMASK = 0x7fff;
const TAU = Math.PI * 2;

interface Obj { id: number; group: THREE.Group; mat: THREE.RawShaderMaterial; seen: number }
interface Buggy extends Obj { wheels: THREE.Object3D[]; steer: THREE.Object3D[]; x: number; y: number; a: number; tic: number; spin: number; speed: number; turn: number }
interface Ship extends Obj { x: number; y: number; heading: number }
interface Canopy extends Obj { open: number; t: number }

export interface RoyaleContext {
  camera: THREE.PerspectiveCamera;
  tic: number;
  time: number;
  floorAt(x: number, y: number): number;
  addLight(x: number, y: number, z: number, radius: number, r: number, g: number, b: number): void;
}

export class RoyaleLayer {
  private readonly buggyGeo: BuggyGeometry;
  private readonly shipGeo: ShipGeometry;
  private readonly canopyGeo: THREE.BufferGeometry;
  private readonly buggies = new Map<number, Buggy>();
  private readonly ships = new Map<number, Ship>();
  private readonly canopies = new Map<number, Canopy>();
  private readonly storm: Storm;
  private readonly smoke: SmokeColumns;
  readonly sky: SkyDome;
  /** this frame's buggies (position, heading) for seating drivers */
  private seats: RenderMobj[] = [];
  private nSeats = 0;
  private pool: RenderMobj[] = [];
  private nPool = 0;
  private stamp = 0;
  private ctx: RoyaleContext | null = null;
  private readonly playSprite: number;

  constructor(private readonly scene: THREE.Scene, private readonly world: Record<string, THREE.IUniform>, pal: PaletteData,
    zMin: number, zMax: number, playSprite: number) {
    this.buggyGeo = buildBuggy(pal);
    this.shipGeo = buildDropship(pal);
    this.canopyGeo = buildCanopy(pal);
    this.storm = new Storm(scene, world, zMin, zMax);
    this.smoke = new SmokeColumns(scene, world);
    this.sky = new SkyDome(scene, world);
    this.playSprite = playSprite;
  }

  /** Before the mobj loop: remembers the buggies (drivers are seated in them). */
  begin(mobjs: ArrayLike<RenderMobj>, count: number, ctx: RoyaleContext): void {
    this.ctx = ctx;
    this.stamp++;
    this.nSeats = 0;
    this.nPool = 0;
    this.smoke.begin(ctx.camera);
    for (let i = 0; i < count; i++) {
      const m = mobjs[i];
      if (m.type === MT_BUGGY) this.seats[this.nSeats++] = m;
    }
  }

  /**
   * A battle royale mobj (types 138..140): drawn here. Returns a player body to draw
   * in its place (the parachuter's, posed), or null.
   */
  mobj(m: RenderMobj, sector: number, light: number, own = false): RenderMobj | null {
    if (m.type === MT_BUGGY) { this.drawBuggy(m, sector, light); return null; }
    if (m.type === MT_DROPSHIP) { this.drawShip(m, sector, light); return null; }
    if (m.type === MT_PARACHUTER) return this.drawParachuter(m, sector, light, own);
    return null;
  }

  /** A player body riding a buggy: a copy seated in it (facing its heading, not walking), else the body itself. */
  seat(m: RenderMobj): RenderMobj {
    if (m.slot < 0 || (m.frame & FF_FRAMEMASK) >= 7) return m;
    for (let i = 0; i < this.nSeats; i++) {
      const b = this.seats[i];
      if (Math.abs(b.x - m.x) < 6 && Math.abs(b.y - m.y) < 6 && Math.abs(b.z - m.z) < 32) {
        const c = this.copy(m);
        c.x = b.x - Math.cos(b.angle) * 6; c.y = b.y - Math.sin(b.angle) * 6;
        c.z = b.z + 4; c.angle = b.angle; c.pose = POSE_SEATED;
        return c;
      }
    }
    return m;
  }

  /** A supply crate: smoke column and a pulsing red flare. */
  supply(m: RenderMobj): void {
    const ctx = this.ctx!;
    this.smoke.column(m.id, m.x, m.y, m.z + 40, ctx.time);
    const k = 0.75 + 0.25 * Math.sin(ctx.time * 9 + m.id) * Math.sin(ctx.time * 23.7);
    ctx.addLight(m.x, m.y, m.z + 52, 220, 1.3 * k, 0.18 * k, 0.08 * k);
  }

  /**
   * After the mobj loop: the storm, unused models dropped. Returns the screen tint
   * strength (0..1) for a camera outside the storm.
   */
  finish(z: RenderRoyale | null | undefined, camX: number, camY: number): number {
    const ctx = this.ctx!;
    this.smoke.commit();
    for (const map of [this.buggies, this.ships, this.canopies] as Map<number, Obj>[]) {
      for (const [id, o] of map) {
        if (o.seen === this.stamp) continue;
        o.group.removeFromParent();
        o.mat.dispose();
        map.delete(id);
      }
    }
    const storm = z && z.storm !== false ? z : null;
    this.storm.update(storm ? { x: storm.x, y: storm.y, r: storm.r } : null, storm ? { x: storm.nx, y: storm.ny, r: storm.nr } : null, ctx.floorAt);
    if (!storm) return 0;
    const d = Math.hypot(camX - storm.x, camY - storm.y) - storm.r;
    return storm.r <= 1 ? 1 : Math.max(0, Math.min(1, d / 96 + 0.5));
  }

  dispose(): void {
    for (const map of [this.buggies, this.ships, this.canopies] as Map<number, Obj>[]) for (const o of map.values()) { o.group.removeFromParent(); o.mat.dispose(); }
    this.buggies.clear(); this.ships.clear(); this.canopies.clear();
    this.buggyGeo.chassis.dispose(); this.buggyGeo.wheel.dispose();
    this.shipGeo.hull.dispose(); this.shipGeo.glow.dispose(); this.canopyGeo.dispose();
    this.storm.dispose(); this.smoke.dispose(); this.sky.dispose();
  }

  // ---- internals ------------------------------------------------------------------

  private copy(m: RenderMobj): RenderMobj {
    let c = this.pool[this.nPool];
    if (!c) c = this.pool[this.nPool] = { ...m };
    else Object.assign(c, m);
    this.nPool++;
    c.pose = 0;
    return c;
  }

  private light(o: Obj, sector: number, light: number, translation = 0, glow = 1): void {
    (o.mat.uniforms.uObj.value as THREE.Vector4).set(light, sector, translation, glow);
  }

  private obj<T extends Obj>(map: Map<number, T>, id: number, make: (o: Obj) => T): T {
    let o = map.get(id);
    if (!o) {
      const group = new THREE.Group();
      group.matrixAutoUpdate = true;
      o = make({ id, group, mat: palMaterial(this.world), seen: 0 });
      map.set(id, o);
      this.scene.add(group);
    }
    o.seen = this.stamp;
    return o;
  }

  private drawBuggy(m: RenderMobj, sector: number, light: number): void {
    const ctx = this.ctx!;
    const G = this.buggyGeo;
    const b = this.obj(this.buggies, m.id, (o) => {
      const chassis = new THREE.Mesh(G.chassis, o.mat);
      chassis.renderOrder = 4;
      o.group.add(chassis);
      const wheels: THREE.Object3D[] = [], steer: THREE.Object3D[] = [];
      G.wheels.forEach((p, i) => {
        const s = new THREE.Group();
        s.position.set(...p);
        const w = new THREE.Mesh(G.wheel, o.mat);
        w.renderOrder = 4;
        s.add(w);
        o.group.add(s);
        wheels.push(w);
        if (i < 2) steer.push(s);
      });
      return { ...o, wheels, steer, x: m.x, y: m.y, a: m.angle, tic: ctx.tic, spin: 0, speed: 0, turn: 0 };
    });
    // speed and turn rate from the drawn motion
    const dt = ctx.tic - b.tic;
    if (dt > 0.02) {
      const dx = m.x - b.x, dy = m.y - b.y;
      let da = m.angle - b.a;
      da -= Math.round(da / TAU) * TAU;
      const d = Math.hypot(dx, dy);
      const fwd = dx * Math.cos(m.angle) + dy * Math.sin(m.angle) >= 0 ? 1 : -1;
      const v = d / dt > 64 ? 0 : (fwd * d) / dt;
      const k = Math.min(1, dt * 0.5);
      b.speed += (v - b.speed) * k;
      b.turn += (da / dt - b.turn) * k;
      b.spin += (fwd * Math.min(d, 64)) / G.wheelRadius;
      b.x = m.x; b.y = m.y; b.a = m.angle; b.tic = ctx.tic;
    } else if (dt < 0) { b.x = m.x; b.y = m.y; b.a = m.angle; b.tic = ctx.tic; }
    b.group.position.set(m.x, m.y, m.z);
    b.group.rotation.set(0, 0, m.angle);
    // a little body roll in turns and pitch under acceleration
    b.group.rotation.x = Math.max(-0.08, Math.min(0.08, -b.turn * b.speed * 0.25));
    for (const w of b.wheels) w.rotation.y = b.spin;
    const steer = Math.abs(b.speed) > 0.5 ? Math.max(-0.5, Math.min(0.5, Math.atan((48 * b.turn) / b.speed))) : 0;
    for (const s of b.steer) s.rotation.z = steer;
    this.light(b, sector, light);
    // headlights
    const c = Math.cos(m.angle), s = Math.sin(m.angle);
    ctx.addLight(m.x + c * 72, m.y + s * 72, m.z + 24, 160, 0.5, 0.45, 0.32);
  }

  private drawShip(m: RenderMobj, sector: number, light: number): void {
    const ctx = this.ctx!;
    const sh = this.obj(this.ships, m.id, (o) => {
      const hull = new THREE.Mesh(this.shipGeo.hull, o.mat);
      const glow = new THREE.Mesh(this.shipGeo.glow, o.mat);
      hull.renderOrder = glow.renderOrder = 4;
      o.group.add(hull, glow);
      return { ...o, x: m.x, y: m.y, heading: m.angle };
    });
    const dx = m.x - sh.x, dy = m.y - sh.y;
    if (dx * dx + dy * dy > 4) sh.heading = Math.atan2(dy, dx);
    else if (dx === 0 && dy === 0 && m.angle !== 0) sh.heading = m.angle;
    sh.x = m.x; sh.y = m.y;
    sh.group.position.set(m.x, m.y, m.z - 60);
    // a slow wallow
    sh.group.rotation.set(Math.sin(ctx.time * 0.6) * 0.025, Math.sin(ctx.time * 0.43) * 0.015, sh.heading);
    this.light(sh, sector, Math.max(light, 176), 0, 0.9 + 0.1 * Math.sin(ctx.time * 31));
  }

  private drawParachuter(m: RenderMobj, sector: number, light: number, own: boolean): RenderMobj | null {
    const ctx = this.ctx!;
    const open = (m.frame & FF_FRAMEMASK) >= 1;
    if (open) {
      const cn = this.obj(this.canopies, m.id, (o) => {
        const mesh = new THREE.Mesh(this.canopyGeo, o.mat);
        mesh.renderOrder = 4;
        o.group.add(mesh);
        return { ...o, open: 0, t: ctx.time };
      });
      // the canopy blossoms over half a second
      cn.open = Math.min(1, cn.open + Math.max(0, ctx.time - cn.t) * 2.2);
      cn.t = ctx.time;
      const k = 0.25 + 0.75 * (1 - Math.pow(1 - cn.open, 3));
      // our own canopy (the camera hangs under it) sits a little ahead, so looking up shows it
      const ahead = own ? 64 : 0;
      cn.group.position.set(m.x + Math.cos(m.angle) * ahead, m.y + Math.sin(m.angle) * ahead, m.z);
      cn.group.rotation.set(0, 0, m.angle);
      cn.group.scale.set(k, 0.3 + 0.7 * k, k);
      this.light(cn, sector, Math.max(light, 160), m.translation);
    }
    // our own body: not drawn (the camera is in it); the canopy is
    const cam = ctx.camera.position;
    if (Math.hypot(cam.x - m.x, cam.y - m.y) < 40 && cam.z - m.z > -16 && cam.z - m.z < 96) return null;
    const c = this.copy(m);
    c.sprite = this.playSprite;
    c.frame = 0;
    c.pose = open ? POSE_CHUTE : POSE_FREEFALL;
    return c;
  }
}
