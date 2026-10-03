/**
 * A Verlet ragdoll for the marine (Jakobsen-style particles and stick constraints):
 * every death falls with it. Bullets and fists knock him back so he crumples;
 * rockets, plasma and the BFG throw him.
 *
 * Client-side only: the sim's corpse (and its slide from Doom's thrust) stays the
 * authority on where the body is; this only animates the rig on top of it. The
 * ragdoll lives in model space (the holder follows the mobj), so the sim's slide
 * carries it, and a leash keeps the trunk near the mobj so it never ends up
 * through a wall the sim stopped the corpse at.
 *
 * Particles sit on the rig's joints, started from the bone matrices of the pose at
 * the moment of death; every frame the bone matrices are rebuilt from them: the
 * pelvis and the torso as two rigid frames that bend at the waist, each limb
 * segment and the head as its parent's rotation swung onto the segment's
 * direction, and the rifle as a free stick that drops out of his hands.
 */
import * as THREE from 'three';
import { B, NUM_BITS, PIVOT } from './rig.js';

export interface RagdollKick {
  /** push direction in model space (horizontal, unit); 0,0 = straight up */
  dx: number;
  dz: number;
  /** 0..1: how hard (damage) */
  power: number;
  /** 0 rocket/splash, 1 plasma, 2 BFG, 3 bullets/melee/anything else (a knock-back and a collapse) */
  kind: number;
}

export interface RagdollEnv {
  /** floor and ceiling heights in model space (y) */
  floor: number;
  ceil: number;
}

// particles
const HIP_R = 0, HIP_L = 1, SH_R = 2, SH_L = 3, NECK = 4, HEAD = 5, ELB_R = 6, ELB_L = 7, HAND_R = 8, HAND_L = 9;
const KNEE_R = 10, KNEE_L = 11, FOOT_R = 12, FOOT_L = 13, GRIP = 14, MUZZLE = 15, WAIST = 16;
const NP = 17;
const PELVIS = [HIP_R, HIP_L, WAIST];
const CHEST = [WAIST, SH_R, SH_L, NECK];
const TRUNK = [HIP_R, HIP_L, SH_R, SH_L, NECK];
/** collision radius per particle (body thickness around the joint) */
const RADIUS = [5, 5, 5.5, 5.5, 5, 5.5, 3.5, 3.5, 2.5, 2.5, 4, 4, 3, 3, 1.5, 1.2, 5.5];
/** bind-space joint positions (body particles; the rifle's are gun-local) */
function bindPoints(): THREE.Vector3[] {
  const v = (p: THREE.Vector3) => p.clone();
  return [
    v(PIVOT.hipR), v(PIVOT.hipL), v(PIVOT.shoulderR), v(PIVOT.shoulderL), v(PIVOT.neck),
    new THREE.Vector3(PIVOT.neck.x + 1, PIVOT.neck.y + 9.5, 0),
    v(PIVOT.elbowR), v(PIVOT.elbowL), v(PIVOT.handR), v(PIVOT.handL),
    v(PIVOT.kneeR), v(PIVOT.kneeL),
    new THREE.Vector3(PIVOT.kneeR.x, 1, PIVOT.kneeR.z), new THREE.Vector3(PIVOT.kneeL.x, 1, PIVOT.kneeL.z),
    v(PIVOT.gunGrip), v(PIVOT.gunMuzzle), v(PIVOT.waist),
  ];
}
/** per bone: the particle it is anchored on, the one its direction points at, and its frame of reference (0 pelvis, 1 torso) */
const SEGMENTS: [bone: number, from: number, to: number, ref: number][] = [
  [B.head, NECK, HEAD, 1],
  [B.uArmR, SH_R, ELB_R, 1], [B.fArmR, ELB_R, HAND_R, 1], [B.uArmL, SH_L, ELB_L, 1], [B.fArmL, ELB_L, HAND_L, 1],
  [B.thighR, HIP_R, KNEE_R, 0], [B.shinR, KNEE_R, FOOT_R, 0], [B.thighL, HIP_L, KNEE_L, 0], [B.shinL, KNEE_L, FOOT_L, 0],
];
/** bone whose matrix places each particle at the start */
const OWNER = [B.thighR, B.thighL, B.uArmR, B.uArmL, B.head, B.head, B.fArmR, B.fArmL, B.fArmR, B.fArmL, B.shinR, B.shinL, B.shinR, B.shinL, B.gun, B.gun, B.pelvis];

type Stick = { a: number; b: number; min: number; max: number };

const GRAVITY = 1000; // units/s² (Doom's is 1225; a touch floatier so the flight reads)
const STEP = 1 / 120;
const ITER = 8;
/** the trunk may drift this far (horizontally) from the mobj before it is held back */
const LEASH = 36;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _m = new THREE.Matrix4();

function hash(n: number): number {
  let x = Math.imul(n ^ 0x2c9277b5, 0x27d4eb2d);
  x ^= x >>> 15; x = Math.imul(x, 0x165667b1); x ^= x >>> 13;
  return ((x >>> 0) % 100000) / 100000;
}

export class Ragdoll {
  private readonly pos: THREE.Vector3[] = [];
  private readonly prev: THREE.Vector3[] = [];
  private readonly bind = bindPoints();
  private readonly sticks: Stick[] = [];
  /** bind bases (inverse) and centroids of the pelvis and the chest, and the rifle's rotation when it was let go */
  private readonly pelvisBindInv = new THREE.Matrix4();
  private readonly pelvisBindCentre = new THREE.Vector3();
  private readonly chestBindInv = new THREE.Matrix4();
  private readonly chestBindCentre = new THREE.Vector3();
  private readonly gunRot0 = new THREE.Quaternion();
  private readonly gunDir0 = new THREE.Vector3();
  private acc = 0;
  /** seconds simulated */
  t = 0;
  private still = 0;
  asleep = false;

  constructor(mats: readonly THREE.Matrix4[], kick: RagdollKick, seed: number) {
    for (let i = 0; i < NP; i++) {
      this.pos.push(this.bind[i].clone().applyMatrix4(mats[OWNER[i]]));
      this.prev.push(new THREE.Vector3());
    }
    // constraints keep the lengths of the pose he died in (bones are rigid, so these are the rig's)
    const stick = (a: number, b: number, lo = 1, hi = 1) => {
      const l = this.pos[a].distanceTo(this.pos[b]);
      this.sticks.push({ a, b, min: l * lo, max: l * hi });
    };
    // two rigid pieces, pelvis and chest, joined at the waist: it bends (forward more than back) and twists a little
    for (const set of [PELVIS, CHEST]) for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) stick(set[i], set[j]);
    stick(HIP_R, SH_R, 0.8, 1.04); stick(HIP_L, SH_L, 0.8, 1.04);
    stick(HIP_R, SH_L, 0.88, 1.04); stick(HIP_L, SH_R, 0.88, 1.04);
    stick(HIP_R, NECK, 0.78, 1.03); stick(HIP_L, NECK, 0.78, 1.03);
    stick(NECK, HEAD); stick(SH_R, HEAD, 0.85, 1.05); stick(SH_L, HEAD, 0.85, 1.05);
    for (const [, a, b] of SEGMENTS) if (a !== NECK) stick(a, b);
    // joint limits, loosely: no limb folds flat onto itself, feet and knees stay apart
    const reach = (a: number, m: number, b: number, k: number) => {
      const l = this.pos[a].distanceTo(this.pos[m]) + this.pos[m].distanceTo(this.pos[b]);
      this.sticks.push({ a, b, min: l * k, max: l });
    };
    reach(SH_R, ELB_R, HAND_R, 0.4); reach(SH_L, ELB_L, HAND_L, 0.4);
    reach(HIP_R, KNEE_R, FOOT_R, 0.55); reach(HIP_L, KNEE_L, FOOT_L, 0.55);
    this.sticks.push({ a: KNEE_R, b: KNEE_L, min: 8, max: 40 }, { a: FOOT_R, b: FOOT_L, min: 8, max: 46 });
    // hips: a leg swings forward, back and out, but never across the other one — knee and
    // foot keep at least their standing distance from the opposite hip
    const across = (p: number, hip: number) => this.sticks.push({ a: p, b: hip, min: this.pos[p].distanceTo(this.pos[hip]) * 0.97, max: 1e9 });
    across(KNEE_R, HIP_L); across(FOOT_R, HIP_L); across(KNEE_L, HIP_R); across(FOOT_L, HIP_R);
    // hands and knees stay out of the chest/belly
    for (const p of [HAND_R, HAND_L, ELB_R, ELB_L]) this.sticks.push({ a: p, b: p === HAND_R || p === ELB_R ? SH_L : SH_R, min: 9, max: 1e9 });
    for (const p of [KNEE_R, KNEE_L]) this.sticks.push({ a: p, b: NECK, min: 14, max: 1e9 });
    stick(GRIP, MUZZLE);

    this.pelvisBindInv.copy(this.basis(this.bind, HIP_R, HIP_L, HIP_R, HIP_L, WAIST, _m)).invert();
    this.chestBindInv.copy(this.basis(this.bind, SH_R, SH_L, WAIST, WAIST, NECK, _m)).invert();
    this.centroid(this.bind, this.pelvisBindCentre, PELVIS);
    this.centroid(this.bind, this.chestBindCentre, CHEST);
    const g = new THREE.Vector3(), s = new THREE.Vector3();
    mats[B.gun].decompose(g, this.gunRot0, s);
    this.gunDir0.subVectors(this.bind[MUZZLE], this.bind[GRIP]).normalize();

    for (let i = 0; i < NP; i++) this.prev[i].copy(this.pos[i]);
    this.push(kick, seed);
  }

  /**
   * Adds a push: everything up and along it, the upper body more so he goes over.
   * A light one (kind 3) mostly knocks the chest back and buckles the knees: he crumples.
   */
  push(kick: RagdollKick, seed: number): void {
    this.asleep = false;
    this.still = 0;
    const p = Math.max(0, Math.min(1, kick.power));
    // [along, up, jitter]; u 330 → a ~55 unit hop at the hips
    const [h, u, jit] = kick.kind === 2 ? [300 + 200 * p, 280 + 180 * p, 80]
      : kick.kind === 1 ? [120 + 120 * p, 80 + 90 * p, 40]
        : kick.kind === 0 ? [200 + 220 * p, 170 + 190 * p, 60]
          : [50 + 110 * p, 10 + 40 * p, 25];
    const light = kick.kind === 3;
    for (let i = 0; i < NP; i++) {
      const q = this.pos[i];
      const high = Math.max(0, Math.min(1.4, q.y / 40));
      const r1 = hash(seed * 97 + i * 3 + 1) - 0.5, r2 = hash(seed * 97 + i * 3 + 2) - 0.5, r3 = hash(seed * 97 + i * 3 + 3) - 0.5;
      const loose = i === GRIP || i === MUZZLE ? 1.6 : i === HAND_R || i === HAND_L || i === HEAD ? 1.25 : 1;
      // light hits: the push grows with height (feet stay, the chest goes), knees are thrown forward so the legs fold
      const along = light ? (i === KNEE_R || i === KNEE_L ? -0.5 : high * high * 0.8) : 0.55 + 0.6 * high;
      const vx = kick.dx * h * along + r1 * jit * loose;
      const vy = (light ? u * high : u * (0.85 + 0.25 * high)) + r2 * jit * 0.5 * loose;
      let vz = kick.dz * h * along + r3 * jit * loose;
      // the legs splay: knees and feet are kicked out to their own side (a little more on light hits)
      if (i === KNEE_R || i === FOOT_R || i === KNEE_L || i === FOOT_L) {
        const out = (i === KNEE_R || i === FOOT_R ? 1 : -1) * (25 + 45 * hash(seed * 31 + (i === KNEE_R || i === FOOT_R ? 1 : 2))) * (light ? 1.2 : 1);
        vz += out;
      }
      this.prev[i].x -= vx * STEP; this.prev[i].y -= vy * STEP; this.prev[i].z -= vz * STEP;
    }
  }

  /** Advance by `dt` seconds. */
  step(dt: number, env: RagdollEnv): void {
    if (this.asleep) return;
    this.acc = Math.min(this.acc + dt, 0.1);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this.t += STEP;
      this.substep(env);
    }
  }

  private substep(env: RagdollEnv): void {
    const g = GRAVITY * STEP * STEP;
    let motion = 0;
    for (let i = 0; i < NP; i++) {
      const p = this.pos[i], o = this.prev[i];
      const vx = (p.x - o.x) * 0.999, vy = (p.y - o.y) * 0.999, vz = (p.z - o.z) * 0.999;
      o.copy(p);
      p.x += vx; p.y += vy - g; p.z += vz;
      motion += vx * vx + vy * vy + vz * vz;
    }
    for (let it = 0; it < ITER; it++) {
      for (const s of this.sticks) {
        const a = this.pos[s.a], b = this.pos[s.b];
        _a.subVectors(b, a);
        const d = _a.length();
        if (d < 1e-6) continue;
        const target = d < s.min ? s.min : d > s.max ? s.max : d;
        if (target === d) continue;
        _a.multiplyScalar((d - target) / d * 0.5);
        a.add(_a); b.sub(_a);
      }
      this.collide(env);
    }
    // the leash: the trunk stays over the sim's corpse
    this.centroid(this.pos, _c, TRUNK);
    const hd = Math.hypot(_c.x, _c.z);
    if (hd > LEASH) {
      const k = (hd - LEASH) / hd;
      for (const p of this.pos) { p.x -= _c.x * k; p.z -= _c.z * k; }
    }
    // asleep once (nearly) still for a while; a body that never settles stops at 8 s
    this.still = motion < NP * 0.0004 ? this.still + STEP : 0;
    if ((this.t > 1 && this.still > 0.5) || this.t > 8) this.asleep = true;
  }

  private collide(env: RagdollEnv): void {
    for (let i = 0; i < NP; i++) {
      const p = this.pos[i], o = this.prev[i], r = RADIUS[i];
      if (p.y < env.floor + r) {
        p.y = env.floor + r;
        // friction and a little bounce
        const vy = p.y - o.y;
        o.x = p.x - (p.x - o.x) * 0.82;
        o.z = p.z - (p.z - o.z) * 0.82;
        if (vy < 0) o.y = p.y + vy * 0.25;
      } else if (p.y > env.ceil - r && env.ceil - r > env.floor + r) {
        p.y = env.ceil - r;
        if (o.y < p.y) o.y = p.y + (p.y - o.y) * 0.3;
      }
    }
  }

  private centroid(pts: readonly THREE.Vector3[], out: THREE.Vector3, set: readonly number[]): THREE.Vector3 {
    out.set(0, 0, 0);
    for (const i of set) out.add(pts[i]);
    return out.multiplyScalar(1 / set.length);
  }

  /** Orientation (fwd, up, side columns): side from r - l, up from the midpoint of lo1/lo2 to `hi`. */
  private basis(pts: readonly THREE.Vector3[], r: number, l: number, lo1: number, lo2: number, hi: number, out: THREE.Matrix4): THREE.Matrix4 {
    const side = _a.subVectors(pts[r], pts[l]).normalize();
    const up = _b.addVectors(pts[lo1], pts[lo2]).multiplyScalar(0.5);
    up.subVectors(pts[hi], up);
    up.addScaledVector(side, -up.dot(side)).normalize();
    const fwd = _c.crossVectors(up, side);
    return out.makeBasis(fwd, up, side);
  }

  /** Bone matrices (model space) for the current state. */
  write(out: THREE.Matrix4[]): void {
    // pelvis and chest: rotation from bind to now, the bind centroid onto the current one
    const pelvis = out[B.pelvis];
    this.basis(this.pos, HIP_R, HIP_L, HIP_R, HIP_L, WAIST, pelvis).multiply(this.pelvisBindInv);
    placeAt(pelvis, this.pelvisBindCentre, this.centroid(this.pos, _d, PELVIS));
    const torso = out[B.torso];
    this.basis(this.pos, SH_R, SH_L, WAIST, WAIST, NECK, torso).multiply(this.chestBindInv);
    placeAt(torso, this.chestBindCentre, this.centroid(this.pos, _d, CHEST));
    out[B.padR].copy(torso); out[B.padL].copy(torso);
    const pq = _qp.setFromRotationMatrix(pelvis), tq = _q.setFromRotationMatrix(torso);
    // limbs and head: the parent's rotation, swung onto the segment
    for (const [bone, a, b, ref] of SEGMENTS) {
      const rq = ref ? tq : pq;
      const d0 = _a.subVectors(this.bind[b], this.bind[a]).normalize().applyQuaternion(rq);
      const d1 = _b.subVectors(this.pos[b], this.pos[a]).normalize();
      _q2.setFromUnitVectors(d0, d1).multiply(rq);
      out[bone].makeRotationFromQuaternion(_q2);
      placeAt(out[bone], this.bind[a], this.pos[a]);
    }
    // the rifle: its own stick
    const d1 = _b.subVectors(this.pos[MUZZLE], this.pos[GRIP]).normalize();
    _q2.setFromUnitVectors(_a.copy(this.gunDir0).applyQuaternion(this.gunRot0), d1).multiply(this.gunRot0);
    out[B.gun].makeRotationFromQuaternion(_q2);
    placeAt(out[B.gun], this.bind[GRIP], this.pos[GRIP]);
    out[B.flash].makeScale(0, 0, 0);
    // blood pool under the trunk once he is down
    const pool = Math.max(0, Math.min(1, (this.t - 0.8) * 0.5));
    if (pool > 0.01) {
      const c = this.centroid(this.pos, _d, TRUNK);
      out[B.pool].makeScale(pool, 1, pool).setPosition(c.x, this.floorY, c.z);
    } else out[B.pool].makeScale(0, 0, 0);
    for (let i = 0; i < NUM_BITS; i++) out[B.bit0 + i].makeScale(0, 0, 0);
  }

  /** floor (model y) the pool is drawn on; set by the caller with the env */
  floorY = 0;
}

/** Sets the translation of rotation matrix `m` so bind point `from` lands on `to`. */
function placeAt(m: THREE.Matrix4, from: THREE.Vector3, to: THREE.Vector3): void {
  m.setPosition(0, 0, 0);
  const p = _c.copy(from).applyMatrix4(m);
  m.setPosition(to.x - p.x, to.y - p.y, to.z - p.z);
}
