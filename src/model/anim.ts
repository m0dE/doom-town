/**
 * Procedural animation for the marine, keyed to Doom's player states.
 *
 * A `Pose` is a flat bag of joint angles and offsets (so two poses blend by
 * lerping numbers). `poseFor` builds the target pose for a sprite frame;
 * `solvePose` turns a pose into one model-space matrix per bone: forward
 * kinematics for the trunk and legs, the rifle placed in the torso's frame, and
 * two-bone IK that puts both hands on the rifle (or wherever the pose says).
 *
 * Gibbing (frames O..W) is not a pose: `gibMatrices` throws every bone off from
 * where it was, each on a fixed ballistic arc that ends lying flat on the floor.
 *
 * Doom frames: A..D walk (4 tics each), E aim (12), F fire (6, fullbright),
 * G pain (4+4), H..N die (10 each, N stays), O..W gib (5 each, W stays).
 */
import * as THREE from 'three';
import { B, NUM_BITS, NUM_BONES, PIVOT, UPPER_ARM, FOREARM, type BoxDef } from './rig.js';

export const FRAME = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9, K: 10, L: 11, M: 12, N: 13, O: 14, W: 22 } as const;
/** Tics each frame's state lasts (info.c S_PLAY_*); -1 = forever. */
export const FRAME_TICS = [4, 4, 4, 4, 12, 6, 4, 10, 10, 10, 10, 10, 10, -1, 5, 5, 5, 5, 5, 5, 5, 5, -1];
export const TICRATE = 35;

export const POSE_KEYS = [
  'px', 'py', 'pz', 'rx', 'ry', 'rz',
  'tx', 'ty', 'tz', 'hx', 'hy', 'hz',
  'thRx', 'thRz', 'knR', 'thLx', 'thLz', 'knL',
  'gx', 'gy', 'gz', 'gYaw', 'gPitch', 'gRoll', 'aim',
  'freeR', 'hRx', 'hRy', 'hRz', 'freeL', 'hLx', 'hLy', 'hLz',
  'drop', 'flash', 'pool', 'plant',
] as const;
export type PoseKey = (typeof POSE_KEYS)[number];
export type Pose = Record<PoseKey, number>;

export function zeroPose(): Pose {
  // a literal, so every pose shares one fast hidden class
  return {
    px: 0,
    py: 0,
    pz: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    tx: 0,
    ty: 0,
    tz: 0,
    hx: 0,
    hy: 0,
    hz: 0,
    thRx: 0,
    thRz: 0,
    knR: 0,
    thLx: 0,
    thLz: 0,
    knL: 0,
    gx: 0,
    gy: 0,
    gz: 0,
    gYaw: 0,
    gPitch: 0,
    gRoll: 0,
    aim: 0,
    freeR: 0,
    hRx: 0,
    hRy: 0,
    hRz: 0,
    freeL: 0,
    hLx: 0,
    hLy: 0,
    hLz: 0,
    drop: 0,
    flash: 0,
    pool: 0,
    plant: 0,
  };
}

export function lerpPose(out: Pose, a: Pose, b: Pose, t: number): Pose {
  out.px = a.px + (b.px - a.px) * t;
  out.py = a.py + (b.py - a.py) * t;
  out.pz = a.pz + (b.pz - a.pz) * t;
  out.rx = a.rx + (b.rx - a.rx) * t;
  out.ry = a.ry + (b.ry - a.ry) * t;
  out.rz = a.rz + (b.rz - a.rz) * t;
  out.tx = a.tx + (b.tx - a.tx) * t;
  out.ty = a.ty + (b.ty - a.ty) * t;
  out.tz = a.tz + (b.tz - a.tz) * t;
  out.hx = a.hx + (b.hx - a.hx) * t;
  out.hy = a.hy + (b.hy - a.hy) * t;
  out.hz = a.hz + (b.hz - a.hz) * t;
  out.thRx = a.thRx + (b.thRx - a.thRx) * t;
  out.thRz = a.thRz + (b.thRz - a.thRz) * t;
  out.knR = a.knR + (b.knR - a.knR) * t;
  out.thLx = a.thLx + (b.thLx - a.thLx) * t;
  out.thLz = a.thLz + (b.thLz - a.thLz) * t;
  out.knL = a.knL + (b.knL - a.knL) * t;
  out.gx = a.gx + (b.gx - a.gx) * t;
  out.gy = a.gy + (b.gy - a.gy) * t;
  out.gz = a.gz + (b.gz - a.gz) * t;
  out.gYaw = a.gYaw + (b.gYaw - a.gYaw) * t;
  out.gPitch = a.gPitch + (b.gPitch - a.gPitch) * t;
  out.gRoll = a.gRoll + (b.gRoll - a.gRoll) * t;
  out.aim = a.aim + (b.aim - a.aim) * t;
  out.freeR = a.freeR + (b.freeR - a.freeR) * t;
  out.hRx = a.hRx + (b.hRx - a.hRx) * t;
  out.hRy = a.hRy + (b.hRy - a.hRy) * t;
  out.hRz = a.hRz + (b.hRz - a.hRz) * t;
  out.freeL = a.freeL + (b.freeL - a.freeL) * t;
  out.hLx = a.hLx + (b.hLx - a.hLx) * t;
  out.hLy = a.hLy + (b.hLy - a.hLy) * t;
  out.hLz = a.hLz + (b.hLz - a.hLz) * t;
  out.drop = a.drop + (b.drop - a.drop) * t;
  out.flash = a.flash + (b.flash - a.flash) * t;
  out.pool = a.pool + (b.pool - a.pool) * t;
  out.plant = a.plant + (b.plant - a.plant) * t;
  return out;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const TAU = Math.PI * 2;

/** The rifle at the hip, across the body toward his left, muzzle a little down (PLAYA1/A3). */
function holdLow(p: Pose): void {
  // Held clear of the belt and its pouches (front at x ≈ 7), so the hands and the
  // rifle read in front of the body rather than sunk into it.
  p.gx = 9.5; p.gy = 31.5; p.gz = 1.5;
  p.gYaw = 0.5; p.gPitch = -0.12; p.gRoll = 0.15;
}
/** The rifle up at the chest, pointing straight ahead (PLAYE1/E3). */
function holdAim(p: Pose): void {
  p.gx = 4.5; p.gy = 37; p.gz = 4;
  p.gYaw = 0.04; p.gPitch = 0; p.gRoll = 0;
}

export interface PoseInput {
  frame: number;
  /** 0..1 through the current frame */
  progress: number;
  /** seconds, for idle breathing */
  time: number;
  /** walk cycle 0..1 (continuous) and stride amplitude 0..1 */
  walkPhase: number;
  walkAmp: number;
  pitch: number;
  airborne: boolean;
  /** tics since the first death frame (H) */
  deathTics: number;
}

/** Target pose for a frame (gibbing excluded). */
export function poseFor(inp: PoseInput): Pose {
  const p = zeroPose();
  const f = inp.frame;
  const breath = Math.sin(inp.time * 2.1);

  if (f >= FRAME.H && f <= FRAME.N) return deathPose(inp.deathTics, p);

  // ---- base: standing / walking --------------------------------------------
  holdLow(p);
  p.plant = 1;
  p.aim = inp.pitch * 0.9;
  p.hz = inp.pitch * 0.55;
  p.tz = inp.pitch * 0.15;
  p.py = breath * 0.25;
  p.tz += breath * 0.012;

  const amp = inp.walkAmp;
  if (amp > 0.001) {
    const s = Math.sin(inp.walkPhase * TAU), c = Math.cos(inp.walkPhase * TAU);
    // big marching strides, as the A..D sprites draw them: the leading leg's knee is raised
    p.thRz = (0.66 * s + 0.16) * amp;
    p.thLz = (-0.66 * s + 0.16) * amp;
    const lead = Math.sin(inp.walkPhase * TAU + 0.35);
    p.knR = -(0.38 + 0.9 * Math.max(0, lead)) * amp;
    p.knL = -(0.38 + 0.9 * Math.max(0, -lead)) * amp;
    p.py += -0.6 * Math.abs(c) * amp; // (feet are planted: this only adds a bounce)
    p.tz -= 0.12 * amp;
    p.ty = 0.07 * s * amp;
    p.hy = -0.05 * s * amp;
    p.gy += 0.6 * Math.abs(c) * amp;
  } else {
    p.thRx = 0.02; p.thLx = -0.02;
  }

  if (f === FRAME.E || f === FRAME.F) {
    holdAim(p);
    p.aim = inp.pitch;
    p.hz = inp.pitch * 0.8 - 0.06;
    p.tz -= 0.08;
    p.ty = -0.12;
    p.hy = 0.1;
    if (amp < 0.2) {
      // E1/E3: a braced stance, feet apart, one forward
      p.thRx = 0.16; p.thLx = -0.16;
      p.thLz = 0.5; p.thRz = -0.38;
      p.knL = -0.55; p.knR = -0.3;
      p.py -= 2.4;
      p.tz -= 0.08;
      p.ty = -0.2;
    }
    if (f === FRAME.F) {
      const k = 1 - smooth(clamp01(inp.progress * 1.4));
      p.gx -= 2.2 * k;
      p.gPitch += 0.16 * k;
      p.tz += 0.05 * k;
      p.hz += 0.05 * k;
      p.flash = inp.progress < 0.75 ? 1 : 0;
    }
  } else if (f === FRAME.G) {
    // pain: snap back, head thrown, rifle jerked up
    const k = Math.sin(clamp01(inp.progress) * Math.PI * 0.5 + 0.6);
    p.tz += 0.28 * k;
    p.hz += 0.4 * k;
    p.hy += 0.15 * k;
    p.px -= 1.5 * k;
    p.gPitch += 0.35 * k;
    p.gy += 2 * k;
    p.knR -= 0.25 * k; p.knL -= 0.25 * k;
    p.py -= 1 * k;
  }

  if (inp.airborne) {
    // jump: knees tucked, feet apart, rifle held up
    p.thRz = 0.55; p.knR = -1.1;
    p.thLz = 0.15; p.knL = -0.6;
    p.thRx = 0.08; p.thLx = -0.08;
    p.plant = 0;
    p.py += 2;
    p.gy += 1.5;
  }
  return p;
}

/** Death keyframes, one per Doom frame H..N (10 tics each). */
function deathKeys(): Pose[] {
  const keys: Pose[] = [];
  const k = (fn: (p: Pose) => void) => { const p = zeroPose(); holdLow(p); fn(p); keys.push(p); };
  // H: hit, staggering back, rifle flung up
  k((p) => { p.tz = 0.3; p.hz = 0.45; p.px = -2; p.gPitch = 0.7; p.gy = 34; p.knR = -0.25; p.knL = -0.15; p.thRz = 0.1; });
  // I: reeling, rifle slipping, head lolling
  k((p) => { p.tz = 0.42; p.hz = 0.55; p.hx = 0.35; p.px = -3; p.py = -2; p.gPitch = 0.9; p.gy = 32; p.drop = 0.25;
    p.knR = -0.6; p.knL = -0.4; p.thRz = 0.3; p.thLz = 0.2; });
  // J: knees buckle
  k((p) => { p.py = -9; p.px = -2; p.tz = 0.05; p.hz = -0.3; p.hx = 0.2; p.drop = 0.7;
    p.thRz = 1.0; p.knR = -1.8; p.thLz = 0.8; p.knL = -1.6; p.thRx = 0.15; p.thLx = -0.2;
    p.freeR = 1; p.hRx = 6; p.hRy = 30; p.hRz = 9; p.freeL = 1; p.hLx = 6; p.hLy = 30; p.hLz = -9; });
  // K: slumped on his knees, falling back
  k((p) => { p.py = -16; p.px = -5; p.rz = 0.45; p.tz = 0.2; p.hz = 0.3; p.hx = 0.25; p.drop = 1;
    p.thRz = 1.4; p.knR = -2.3; p.thLz = 1.2; p.knL = -2.2; p.thRx = 0.25; p.thLx = -0.3;
    p.freeR = 1; p.hRx = 2; p.hRy = 27; p.hRz = 16; p.freeL = 1; p.hLx = 2; p.hLy = 27; p.hLz = -16; });
  // L: on his back
  k((p) => { p.py = -21; p.px = -6; p.rz = 1.45; p.tz = 0.08; p.hz = 0.2; p.hx = 0.45; p.drop = 1; p.pool = 0.25;
    p.thRz = 1.0; p.knR = -1.6; p.thLz = 0.55; p.knL = -1.1; p.thRx = 0.35; p.thLx = -0.4;
    p.freeR = 1; p.hRx = -4; p.hRy = 40; p.hRz = 19; p.freeL = 1; p.hLx = 2; p.hLy = 36; p.hLz = -20; });
  // M: settling
  // M: settling, knees drawn up (the sprites end as a crumpled heap, not stretched out)
  k((p) => { Object.assign(p, keys[4]); p.py = -21.5; p.rz = 1.52; p.thRz = 1.25; p.knR = -1.9; p.thLz = 0.95; p.knL = -1.6; p.hx = 0.6; p.pool = 0.7; });
  // N: still, in a pool
  k((p) => { Object.assign(p, keys[5]); p.thRz = 1.15; p.knR = -1.75; p.thRx = 0.5; p.thLx = -0.55; p.pool = 1; });
  return keys;
}
const DEATH_KEYS = deathKeys();

function deathPose(tics: number, out: Pose): Pose {
  const t = Math.max(0, tics) / 10;
  const i = Math.min(DEATH_KEYS.length - 1, Math.floor(t));
  // a frame's key is reached at the frame's start + 6 tics, then held (snappy like the sprites)
  const a = DEATH_KEYS[Math.max(0, i - 1)], b = DEATH_KEYS[i];
  const k = i === 0 ? 1 : smooth(clamp01((t - i) / 0.6));
  lerpPose(out, a, b, k);
  if (i === DEATH_KEYS.length - 1) out.pool = clamp01(0.7 + (t - i) * 0.15);
  return out;
}

// ---------------------------------------------------------------------------
// solving a pose into bone matrices

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

function rotAbout(out: THREE.Matrix4, pivot: THREE.Vector3, x: number, y: number, z: number): THREE.Matrix4 {
  _e.set(x, y, z, 'YXZ');
  out.makeRotationFromEuler(_e);
  const px = pivot.x, py = pivot.y, pz = pivot.z;
  // T(p) R T(-p)
  _v.set(px, py, pz).applyMatrix4(_m2.copy(out).setPosition(0, 0, 0));
  out.setPosition(px - _v.x, py - _v.y, pz - _v.z);
  return out;
}

const CHEST = new THREE.Vector3(0, 40, 2);
/** boot sole sample points (bind space): heel and toe, each boot */
const FEET: [number, number][] = [[B.shinR, 5.6], [B.shinL, -5.6]];
const FOOT_X = [-7.5, 9];
// scratch (posing allocates nothing per call on the hot path)
const A_HAND = new THREE.Vector3(), A_D1 = new THREE.Vector3(), A_D2 = new THREE.Vector3(), A_B1 = new THREE.Vector3();
const A_S1 = new THREE.Vector3(), A_F2 = new THREE.Vector3(), P_TMP = new THREE.Vector3();
const S_G = new THREE.Vector3(), S_GR = new THREE.Vector3(), S_GL = new THREE.Vector3(), S_SR = new THREE.Vector3(), S_SL = new THREE.Vector3();
const S_T = new THREE.Vector3(), S_PR = new THREE.Vector3(), S_PL = new THREE.Vector3();
const BIND_DOWN = new THREE.Vector3(0, -1, 0), BIND_FWD = new THREE.Vector3(1, 0, 0), BIND_SIDE = new THREE.Vector3(0, 0, 1);
const _bindBasisT = new THREE.Matrix4().makeBasis(BIND_DOWN, BIND_FWD, BIND_SIDE).transpose();

/** Bone matrices for an arm reaching from `shoulder` (posed) to `target`. */
function solveArm(
  outUpper: THREE.Matrix4, outFore: THREE.Matrix4,
  shoulderBind: THREE.Vector3, elbowBind: THREE.Vector3,
  shoulder: THREE.Vector3, target: THREE.Vector3, pole: THREE.Vector3,
): void {
  const dir = _v.subVectors(target, shoulder);
  let dist = dir.length();
  dir.divideScalar(dist || 1);
  dist = Math.min(dist, UPPER_ARM + FOREARM - 0.01);
  dist = Math.max(dist, Math.abs(UPPER_ARM - FOREARM) + 0.01);
  const a = (UPPER_ARM * UPPER_ARM - FOREARM * FOREARM + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, UPPER_ARM * UPPER_ARM - a * a));
  const perp = _v2.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (perp.lengthSq() < 1e-6) perp.set(-1, 0, 0);
  perp.normalize();
  const elbow = _v3.copy(shoulder).addScaledVector(dir, a).addScaledVector(perp, h);
  const hand = A_HAND.copy(shoulder).addScaledVector(dir, dist);
  const d1 = A_D1.subVectors(elbow, shoulder).normalize();
  const d2 = A_D2.subVectors(hand, elbow).normalize();
  // bend axis: the forearm swings forward in the bind frame (down × fwd = side)
  const b1 = A_B1.copy(d2).addScaledVector(d1, -d1.dot(d2));
  if (b1.lengthSq() < 1e-6) b1.copy(perp).negate();
  b1.normalize();
  const s1 = A_S1.crossVectors(d1, b1);
  outUpper.makeBasis(d1, b1, s1).multiply(_bindBasisT);
  placePivot(outUpper, shoulderBind, shoulder);
  const f2 = A_F2.crossVectors(s1, d2);
  outFore.makeBasis(d2, f2, s1).multiply(_bindBasisT);
  placePivot(outFore, elbowBind, elbow);
}

/** Sets the translation of rotation matrix `m` so bind point `from` lands on `to`. */
function placePivot(m: THREE.Matrix4, from: THREE.Vector3, to: THREE.Vector3): void {
  m.setPosition(0, 0, 0);
  const p = P_TMP.copy(from).applyMatrix4(m);
  m.setPosition(to.x - p.x, to.y - p.y, to.z - p.z);
}

const GUN_FLOOR = new THREE.Matrix4().compose(
  new THREE.Vector3(14, 2.3, -3), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0.5, 0, 'YXZ')), new THREE.Vector3(1, 1, 1));

/**
 * Model-space matrix per bone (`out` has NUM_BONES entries) for a pose.
 * Effects bones (flash, pool, bits) are scaled to zero unless the pose shows them.
 */
export function solvePose(p: Pose, out: THREE.Matrix4[], time: number): void {
  const pelvis = out[B.pelvis];
  rotAbout(pelvis, PIVOT.pelvis, p.rx, p.ry, p.rz);
  pelvis.premultiply(_m.makeTranslation(p.px, p.py, p.pz));
  const legs = (): void => {
    const thR = out[B.thighR].copy(pelvis).multiply(rotAbout(_m, PIVOT.hipR, p.thRx, 0, p.thRz));
    out[B.shinR].copy(thR).multiply(rotAbout(_m, PIVOT.kneeR, 0, 0, p.knR));
    const thL = out[B.thighL].copy(pelvis).multiply(rotAbout(_m, PIVOT.hipL, p.thLx, 0, p.thLz));
    out[B.shinL].copy(thL).multiply(rotAbout(_m, PIVOT.kneeL, 0, 0, p.knL));
  };
  legs();
  if (p.plant > 0) {
    // plant the lower foot on the floor: heel and toe corners of both boots
    let low = Infinity;
    for (const [bone, z] of FEET) {
      for (const x of FOOT_X) low = Math.min(low, S_T.set(x, 0, z).applyMatrix4(out[bone]).y);
    }
    pelvis.premultiply(_m.makeTranslation(0, -low * p.plant, 0));
    legs();
  }
  const torso = out[B.torso].copy(pelvis).multiply(rotAbout(_m, PIVOT.waist, p.tx, p.ty, p.tz));
  out[B.head].copy(torso).multiply(rotAbout(_m, PIVOT.neck, p.hx, p.hy, p.hz));
  out[B.padR].copy(torso);
  out[B.padL].copy(torso);

  // the rifle, in the torso's frame, pitched about the chest for freelook
  const gun = out[B.gun].copy(torso).multiply(rotAbout(_m, CHEST, 0, 0, p.aim));
  _e.set(p.gRoll, p.gYaw, p.gPitch, 'YZX');
  _m.makeRotationFromEuler(_e);
  placePivot(_m, PIVOT.gunGrip, S_G.set(p.gx, p.gy, p.gz));
  gun.multiply(_m);
  const gripR = S_GR.copy(PIVOT.gunGrip).applyMatrix4(gun);
  const gripL = S_GL.copy(PIVOT.gunFore).applyMatrix4(gun);
  if (p.drop > 0) {
    // dropped: slide from the hands to the floor in front of him (gravity-ish ease)
    const k = p.drop * p.drop;
    const a = new THREE.Vector3(), qa = new THREE.Quaternion(), sa = new THREE.Vector3();
    const b = new THREE.Vector3(), qb = new THREE.Quaternion();
    gun.decompose(a, qa, sa);
    GUN_FLOOR.decompose(b, qb, sa);
    a.lerp(b, k);
    qa.slerp(qb, k);
    gun.compose(a, qa, sa.set(1, 1, 1));
  }

  // arms: IK onto the rifle, or onto free targets (in the torso's frame)
  const shR = S_SR.copy(PIVOT.shoulderR).applyMatrix4(torso);
  const shL = S_SL.copy(PIVOT.shoulderL).applyMatrix4(torso);
  const tR = p.freeR > 0 ? gripR.lerp(S_T.set(p.hRx, p.hRy, p.hRz).applyMatrix4(torso), p.freeR) : gripR;
  const tL = p.freeL > 0 ? gripL.lerp(S_T.set(p.hLx, p.hLy, p.hLz).applyMatrix4(torso), p.freeL) : gripL;
  // elbows: out to the side and a little back, so the forearms come around the
  // body to the rifle instead of passing through the torso
  const poleR = S_PR.set(-0.35, -0.3, 1).transformDirection(torso);
  const poleL = S_PL.set(-0.35, -0.3, -1).transformDirection(torso);
  solveArm(out[B.uArmR], out[B.fArmR], PIVOT.shoulderR, PIVOT.elbowR, shR, tR, poleR);
  solveArm(out[B.uArmL], out[B.fArmL], PIVOT.shoulderL, PIVOT.elbowL, shL, tL, poleL);

  // effects
  const fl = out[B.flash];
  if (p.flash > 0.5) {
    const muzzle = PIVOT.gunMuzzle.clone().add(new THREE.Vector3(2.6, 0, 0)).applyMatrix4(gun);
    _q.setFromEuler(_e.set(time * 37, time * 23, time * 41));
    const s = 1.1 + 0.3 * Math.abs(Math.sin(time * 60));
    fl.compose(muzzle, _q, new THREE.Vector3(s, s, s));
  } else fl.makeScale(0, 0, 0);
  const pool = out[B.pool];
  if (p.pool > 0.01) {
    // under the torso of the lying body
    const at = new THREE.Vector3(-14, 0, 0).applyMatrix4(_m.makeTranslation(p.px, 0, p.pz));
    pool.compose(at.setY(0), _q.identity(), new THREE.Vector3(p.pool, 1, p.pool));
  } else pool.makeScale(0, 0, 0);
  for (let i = 0; i < NUM_BITS; i++) out[B.bit0 + i].makeScale(0, 0, 0);
}

// ---------------------------------------------------------------------------
// gibs

interface GibPart { c0: THREE.Vector3; half: THREE.Vector3 }
/** Bind-space bounds of the boxes on each bone. */
export function gibParts(boxes: BoxDef[]): GibPart[] {
  const parts: GibPart[] = [];
  for (let b = 0; b < NUM_BONES; b++) {
    const box = new THREE.Box3();
    for (const d of boxes) if (d.bone === b) box.expandByPoint(new THREE.Vector3(...d.min)).expandByPoint(new THREE.Vector3(...d.max));
    const c0 = new THREE.Vector3(), size = new THREE.Vector3();
    if (box.isEmpty()) { parts.push({ c0, half: new THREE.Vector3(1, 1, 1) }); continue; }
    box.getCenter(c0); box.getSize(size);
    parts.push({ c0, half: size.multiplyScalar(0.5) });
  }
  return parts;
}

function hash(n: number): number {
  let x = Math.imul(n ^ 0x5bd1e995, 0x27d4eb2d);
  x ^= x >>> 15; x = Math.imul(x, 0x165667b1); x ^= x >>> 13;
  return ((x >>> 0) % 100000) / 100000;
}

const GRAVITY = 420; // units/s², softer than Doom's so the burst reads

/** How hard each bone is thrown: [up speed, outward speed]. */
const THROW: Partial<Record<number, [number, number]>> = {
  [B.head]: [95, 22], [B.padR]: [75, 30], [B.padL]: [75, 30], [B.torso]: [25, 6], [B.pelvis]: [0, 3],
  [B.uArmR]: [65, 32], [B.uArmL]: [65, 32], [B.fArmR]: [55, 38], [B.fArmL]: [55, 38],
  [B.thighR]: [10, 14], [B.thighL]: [10, 14], [B.shinR]: [0, 8], [B.shinL]: [0, 8], [B.gun]: [45, 30],
};

/**
 * Bone matrices `t` seconds into a gib, starting from `start` (the pose at the
 * moment of death). Deterministic in (t, seed): every part follows a fixed arc,
 * tumbles, and lands flat on one face.
 */
export function gibMatrices(start: THREE.Matrix4[], parts: GibPart[], t: number, seed: number, out: THREE.Matrix4[]): void {
  const pos = new THREE.Vector3(), q0 = new THREE.Quaternion(), qf = new THREE.Quaternion(), sc = new THREE.Vector3();
  const centre = new THREE.Vector3(0, 30, 0).applyMatrix4(start[B.torso]);
  for (let b = 0; b < NUM_BONES; b++) {
    const o = out[b];
    const isBit = b >= B.bit0;
    if (b === B.flash) { o.makeScale(0, 0, 0); continue; }
    if (b === B.pool) {
      const k = smooth(clamp01((t - 0.25) / 0.9));
      o.compose(pos.set(centre.x, 0, centre.z), q0.identity(), sc.set(0.25 + 1.05 * k, 1, 0.25 + 1.05 * k));
      if (k <= 0) o.makeScale(0, 0, 0);
      continue;
    }
    const part = parts[b];
    const h1 = hash(seed * 131 + b * 7 + 1), h2 = hash(seed * 131 + b * 7 + 2), h3 = hash(seed * 131 + b * 7 + 3);
    let p0: THREE.Vector3;
    if (isBit) { p0 = centre.clone().add(new THREE.Vector3((h1 - 0.5) * 8, (h2 - 0.5) * 14, (h3 - 0.5) * 8)); q0.identity(); }
    else { start[b].decompose(pos, q0, sc); p0 = part.c0.clone().applyMatrix4(start[b]); }
    const [up, out0] = isBit ? [110 + 110 * h1, 35 + 45 * h2] : (THROW[b] ?? [80, 50]);
    // outward: away from the body centre, jittered
    const dir = p0.clone().sub(centre).setY(0);
    if (dir.lengthSq() < 1) dir.set(Math.cos(h1 * TAU), 0, Math.sin(h1 * TAU));
    dir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), (h2 - 0.5) * 1.2);
    const vy = up * (0.8 + 0.4 * h3), vh = out0 * (0.7 + 0.6 * h1);
    // lands flat: on its side (k odd: a quarter turn about X) or upright, with a yaw
    const k = Math.floor(h2 * 4);
    const rest = isBit ? part.half.y : (k & 1 ? part.half.z : part.half.y);
    // y(t) = y0 + vy t - g t²/2 = rest  →  landing time
    const y0 = p0.y;
    const tl = (vy + Math.sqrt(vy * vy + 2 * GRAVITY * Math.max(0, y0 - rest))) / GRAVITY;
    const tt = Math.min(t, tl);
    const s = tt / tl;
    pos.copy(p0).addScaledVector(dir, vh * tt * (1 - 0.35 * s));
    pos.y = t >= tl ? rest : y0 + vy * tt - 0.5 * GRAVITY * tt * tt;
    qf.setFromEuler(_e.set((k * Math.PI) / 2, (h3 - 0.5) * 5, 0, 'YXZ'));
    const q = q0.clone().slerp(qf, smooth(s));
    // a little extra spin while airborne
    if (s < 1) q.multiply(_q.setFromAxisAngle(_v.set(h1 - 0.5, 0.3, h3 - 0.5).normalize(), Math.sin(s * Math.PI) * (2 + 3 * h2)));
    o.compose(pos, q, sc.set(1, 1, 1));
    // T(pos) R T(-c0): the part's centre lands at pos
    const off = part.c0.clone().applyQuaternion(q);
    o.setPosition(pos.x - off.x, pos.y - off.y, pos.z - off.z);
    if (isBit && t <= 0.02) o.makeScale(0, 0, 0);
  }
}
