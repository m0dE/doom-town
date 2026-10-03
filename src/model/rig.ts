/**
 * The marine's boxes, bones and texture sources.
 *
 * Model space is Doom map units: the marine stands on y = 0, is 56 tall, faces
 * +X (Doom angle 0) with his left hand toward -Z and his right toward +Z. So a
 * Doom point (x, y, z) maps to three (x, z, -y) and `object.rotation.y = angle`
 * turns him to a Doom angle.
 *
 * Sizes come from the sprite: one sprite pixel is one unit (row r of the 56-row
 * PLAYA1 spans y = 55 - r .. 56 - r). Front faces sample PLAYA1, backs PLAYA5,
 * sides PLAYA3A7 (mirrored for the right side), which is how Doom shows him.
 *
 * Every box rides exactly one bone (rigid skinning), so the whole marine is one
 * BufferGeometry, one material and one draw call.
 */
import * as THREE from 'three';
import type { PaletteData } from '../wad/index.js';
import MESHES from './meshes.json';
import { SpriteSource, cutRect, packAtlas, resample, shadeIndex, type FaceSpec, type FaceSource, type IndexImage, type Rect } from './texture.js';

export const BONES = [
  'pelvis', 'torso', 'head', 'padR', 'padL', 'uArmR', 'uArmL', 'fArmR', 'fArmL',
  'thighR', 'thighL', 'shinR', 'shinL', 'gun', 'flash', 'pool',
  'bit0', 'bit1', 'bit2', 'bit3', 'bit4', 'bit5', 'bit6', 'bit7',
] as const;
export type BoneName = (typeof BONES)[number];
export const B = {
  pelvis: 0, torso: 1, head: 2, padR: 3, padL: 4, uArmR: 5, uArmL: 6, fArmR: 7, fArmL: 8, thighR: 9, thighL: 10, shinR: 11, shinL: 12, gun: 13, flash: 14, pool: 15, bit0: 16, bit1: 17, bit2: 18, bit3: 19, bit4: 20, bit5: 21, bit6: 22, bit7: 23,
} as const satisfies Record<BoneName, number>;
export const NUM_BONES = BONES.length;
export const NUM_BITS = 8;

/** Joint pivots in bind (model) space. */
export const PIVOT = {
  pelvis: new THREE.Vector3(-1, 29.5, 0),
  waist: new THREE.Vector3(-1, 32, 0),
  neck: new THREE.Vector3(0.5, 46, 0),
  shoulderR: new THREE.Vector3(-0.5, 42.5, 13.5),
  shoulderL: new THREE.Vector3(-0.5, 42.5, -13.5),
  elbowR: new THREE.Vector3(-0.5, 35, 13.5),
  elbowL: new THREE.Vector3(-0.5, 35, -13.5),
  /** centre of the hand: the point the arm IK puts on the gun */
  handR: new THREE.Vector3(-0.5, 24, 13.5),
  handL: new THREE.Vector3(-0.5, 24, -13.5),
  hipR: new THREE.Vector3(-1, 27.5, 5.6),
  hipL: new THREE.Vector3(-1, 27.5, -5.6),
  kneeR: new THREE.Vector3(-1, 15, 5.6),
  kneeL: new THREE.Vector3(-1, 15, -5.6),
  /** gun-local (bind at the origin, barrel along +X): where each hand holds it */
  gunGrip: new THREE.Vector3(-1.5, -2.2, 0),
  gunFore: new THREE.Vector3(10.5, -1.2, 0),
  gunMuzzle: new THREE.Vector3(19, 0.5, 0),
};
export const UPPER_ARM = PIVOT.shoulderR.y - PIVOT.elbowR.y;
export const FOREARM = PIVOT.elbowR.y - PIVOT.handR.y;

type Faces = { px?: FaceSpec; nx?: FaceSpec; pz?: FaceSpec; nz?: FaceSpec; py?: FaceSpec; ny?: FaceSpec };
export interface BoxDef {
  name: string;
  bone: number;
  min: [number, number, number];
  max: [number, number, number];
  faces: Faces;
  /** fullbright (muzzle flash) */
  bright?: boolean;
  /** derived top face: COLORMAP rows darker than the sides' top edge (tops hidden under a joint read as creases, not seams) */
  topShade?: number;
}

const S = (l: string, r: Rect, keep?: string, flip?: boolean): FaceSource => ({ l, r, keep, flip });
const A1 = (r: Rect, keep?: string, flip?: boolean) => S('PLAYA1', r, keep, flip);
const A5 = (r: Rect, keep?: string, flip?: boolean) => S('PLAYA5', r, keep, flip);
/** side view (we see his left); `flip` gives rotation 7, his right */
const A3 = (r: Rect, keep?: string, flip?: boolean) => S('PLAYA3A7', r, keep, flip);
const sides = (f: (flip: boolean) => FaceSpec): Faces => ({ nz: f(false), pz: f(true) });
const all = (s: FaceSpec): Faces => ({ px: s, nx: s, pz: s, nz: s, py: s, ny: s });
const mirrorZ = (b: BoxDef, name: string, bone: number, faces: Faces): BoxDef => ({
  name, bone, faces, topShade: b.topShade,
  min: [b.min[0], b.min[1], -b.max[2]],
  max: [b.max[0], b.max[1], -b.min[2]],
});

export function defineBoxes(): BoxDef[] {
  const boxes: BoxDef[] = [];
  const add = (b: BoxDef) => { boxes.push(b); return b; };

  // ---- trunk -------------------------------------------------------------
  add({ name: 'pelvis', bone: B.pelvis, min: [-8, 26.5, -9.5], max: [5, 31, 9.5], faces: {
    px: A1([9, 27, 26, 34], 'G'), nx: A5([10, 25, 28, 33], 'G'), ...sides((f) => A3([11, 26, 25, 34], 'G', f)),
  } });
  add({ name: 'belt', bone: B.pelvis, min: [-8.6, 31, -9.4], max: [6.4, 34, 9.4], faces: {
    px: A5([10, 22, 28, 25], 'AK'), nx: A5([10, 22, 28, 25], 'AK'), ...sides((f) => A5([12, 22, 26, 25], 'AK', f)),
  } });
  add({ name: 'torso', bone: B.torso, min: [-8, 34, -9], max: [6, 46, 9], faces: {
    px: A1([9, 10, 27, 22], 'GA'), nx: A5([10, 10, 28, 22], 'GA'), ...sides((f) => A3([11, 10, 25, 22], 'G', f)),
  } });

  // ---- head --------------------------------------------------------------
  add({ name: 'helmet', topShade: 0, bone: B.head, min: [-5, 46, -6], max: [8, 54, 6], faces: {
    px: A1([12, 2, 24, 10], 'ABK'), nx: A5([13, 2, 25, 10], 'AK'), ...sides((f) => A3([9, 2, 22, 10], 'ABK', f)),
  } });
  add({ name: 'cap', topShade: 0, bone: B.head, min: [-3.5, 54, -4.5], max: [5.5, 56, 4.5], faces: {
    px: A1([13, 0, 23, 2], 'A'), nx: A5([14, 0, 24, 2], 'A'), ...sides((f) => A3([11, 0, 21, 2], 'A', f)),
  } });
  add({ name: 'visor', bone: B.head, min: [7.2, 46.4, -4.7], max: [8.8, 51, 4.7], faces: {
    px: A1([14, 5, 22, 10], 'B'), nx: 0xcf, ...sides((f) => A3([9, 5, 11, 10], 'B', f)),
  } });

  // ---- shoulder pads (+ the antenna on the right one) ---------------------
  const padR = add({ name: 'padR', topShade: 0, bone: B.padR, min: [-7.5, 42.5, 8], max: [3, 47, 16.5], faces: {
    px: A1([0, 8, 12, 13], 'AK'), nx: A5([26, 8, 38, 13], 'AK'), ...sides((f) => A3([13, 8, 27, 13], 'AK', f)),
  } });
  add(mirrorZ(padR, 'padL', B.padL, {
    px: A1([24, 8, 36, 13], 'AK'), nx: A5([0, 8, 12, 13], 'AK'), ...sides((f) => A3([13, 8, 27, 13], 'AK', f)),
  }));
  const capR = add({ name: 'padCapR', topShade: 0, bone: B.padR, min: [-5.5, 47, 9], max: [1, 48.5, 14.5], faces: {
    px: A1([3, 6, 11, 8], 'A'), nx: A5([27, 6, 35, 8], 'A'), ...sides((f) => A3([14, 6, 26, 8], 'A', f)),
  } });
  add(mirrorZ(capR, 'padCapL', B.padL, {
    px: A1([25, 6, 33, 8], 'A'), nx: A5([3, 6, 11, 8], 'A'), ...sides((f) => A3([14, 6, 26, 8], 'A', f)),
  }));
  add({ name: 'antenna', topShade: 0, bone: B.padR, min: [-5.5, 48.5, 10], max: [-4.5, 53, 11], faces: all(A1([9, 1, 10, 6])) });

  // ---- arms: bare upper arms, gray gauntlets, bare hands ------------------
  const uArmR = add({ name: 'uArmR', bone: B.uArmR, min: [-4, 34, 10], max: [3, 42.5, 17], faces: {
    px: A1([1, 13, 9, 22], 'S'), nx: A5([29, 13, 37, 22], 'S'), ...sides((f) => A3([14, 15, 22, 22], 'S', f)),
  } });
  add(mirrorZ(uArmR, 'uArmL', B.uArmL, {
    px: A1([27, 13, 35, 22], 'S'), nx: A5([1, 13, 9, 22], 'S'), ...sides((f) => A3([14, 15, 22, 22], 'S', f)),
  }));
  const fArmR = add({ name: 'fArmR', bone: B.fArmR, min: [-4, 26, 10], max: [3, 35, 17], faces: {
    px: A1([3, 20, 9, 28], 'A'), nx: A1([3, 20, 9, 28], 'A', true), ...sides((f) => A3([3, 21, 13, 27], 'A', f)),
  } });
  add(mirrorZ(fArmR, 'fArmL', B.fArmL, {
    px: A1([3, 20, 9, 28], 'A', true), nx: A1([3, 20, 9, 28], 'A'), ...sides((f) => A3([3, 21, 13, 27], 'A', f)),
  }));
  const handR = add({ name: 'handR', bone: B.fArmR, min: [-2.5, 22, 11.5], max: [1.5, 26, 15.5], faces: {
    ...all(A1([12, 23, 17, 27], 'S')), py: 'derive', ny: 'derive',
  } });
  add(mirrorZ(handR, 'handL', B.fArmL, { ...all(A1([12, 23, 17, 27], 'S', true)), py: 'derive', ny: 'derive' }));

  // ---- legs: green tops, gray armour, boots --------------------------------
  const thighR = add({ name: 'thighR', bone: B.thighR, min: [-7, 15, 0.6], max: [5, 28, 10.6], faces: {
    px: A1([18, 33, 27, 44], 'GAK', true), nx: A5([19, 33, 28, 44], 'GAK'), ...sides((f) => A3([8, 33, 20, 44], 'GA', f)),
  } });
  add(mirrorZ(thighR, 'thighL', B.thighL, {
    px: A1([18, 33, 27, 44], 'GAK'), nx: A5([10, 33, 19, 44], 'GAK'), ...sides((f) => A3([8, 33, 20, 44], 'GA', f)),
  }));
  const shinR = add({ name: 'shinR', bone: B.shinR, min: [-7.5, 0, 0.4], max: [5, 15.2, 11], faces: {
    px: A1([18, 44, 27, 56], 'AK', true), nx: A5([19, 44, 28, 56], 'AK'), ...sides((f) => A3([16, 43, 28, 54], 'AK', f)),
  } });
  add(mirrorZ(shinR, 'shinL', B.shinL, {
    px: A1([18, 44, 27, 56], 'AK'), nx: A5([10, 44, 19, 56], 'AK'), ...sides((f) => A3([16, 43, 28, 54], 'AK', f)),
  }));
  const toeR = add({ name: 'toeR', bone: B.shinR, min: [5, 0, 0.9], max: [9, 4.5, 10.5], faces: {
    px: A1([18, 52, 27, 56], 'AK', true), ...sides((f) => A3([13, 51, 17, 55], 'A', f)),
  } });
  add(mirrorZ(toeR, 'toeL', B.shinL, { px: A1([18, 52, 27, 56], 'AK'), ...sides((f) => A3([13, 51, 17, 55], 'A', f)) }));

  // ---- the rifle (gun-local bind: barrel along +X) -------------------------
  const gunSide = (f: boolean) => S('PLAYE3E7', [0, 16, 12, 19], 'AK', f);
  add({ name: 'gunBody', bone: B.gun, min: [-6, -1.6, -1.1], max: [9, 1.6, 1.1], faces: {
    px: A1([17, 23, 21, 26], 'K'), nx: A1([17, 23, 21, 26], 'AK'), ...sides(gunSide),
  } });
  add({ name: 'gunBarrel', bone: B.gun, min: [9, -0.3, -0.75], max: [19, 1.2, 0.75], faces: all(A1([29, 24, 36, 26], 'K')) });
  add({ name: 'gunMag', bone: B.gun, min: [1.5, -4.6, -0.8], max: [4, -1.6, 0.8], faces: all(A1([17, 23, 22, 25], 'K')) });

  // ---- effects: muzzle flash, blood pool, blood bits (hidden at rest) -------
  add({ name: 'flash', bone: B.flash, min: [-2.5, -2.5, -2.5], max: [2.5, 2.5, 2.5], bright: true,
    faces: all(S('PLAYF3F7', [0, 14, 11, 22])) });
  add({ name: 'pool', bone: B.pool, min: [-13, 0.1, -11], max: [13, 0.4, 11], faces: all({ l: 'PLAYW0', r: [0, 3, 53, 16], keep: 'R', scatter: true }) });
  for (let i = 0; i < NUM_BITS; i++) {
    const s = i % 3 === 0 ? 2.5 : 1.6;
    add({ name: `bit${i}`, bone: B.bit0 + i, min: [-s / 2, -s / 2, -s / 2], max: [s / 2, s / 2, s / 2],
      faces: all({ l: 'PLAYW0', r: [0, 3, 53, 16], keep: 'R', scatter: true }) });
  }
  return boxes;
}

// ---------------------------------------------------------------------------
// face frames: normal n, texture right aU, texture down aV (aU × aV = -n)
type V3 = [number, number, number];
const FACE_FRAMES: Record<keyof Faces, { n: V3; u: V3; v: V3 }> = {
  px: { n: [1, 0, 0], u: [0, 0, -1], v: [0, -1, 0] },
  nx: { n: [-1, 0, 0], u: [0, 0, 1], v: [0, -1, 0] },
  nz: { n: [0, 0, -1], u: [-1, 0, 0], v: [0, -1, 0] },
  pz: { n: [0, 0, 1], u: [1, 0, 0], v: [0, -1, 0] },
  py: { n: [0, 1, 0], u: [0, 0, -1], v: [1, 0, 0] },
  ny: { n: [0, -1, 0], u: [0, 0, -1], v: [-1, 0, 0] },
};
const FACE_KEYS = ['px', 'nx', 'nz', 'pz', 'py', 'ny'] as const;
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const absv = (a: V3): V3 => [Math.abs(a[0]), Math.abs(a[1]), Math.abs(a[2])];

interface FaceImg { key: keyof Faces; img: IndexImage; sizeU: number; sizeV: number }

function scatterRect(src: SpriteSource, s: FaceSource, w: number, h: number, seed: number): IndexImage {
  const cut = cutRect(src, { ...s, keep: undefined });
  const keepRed = (i: number) => (i >= 0x20 && i <= 0x2f) || (i >= 0xb0 && i <= 0xbf);
  const pool = [...cut.px].filter(keepRed);
  const px = new Uint8Array(w * h);
  for (let i = 0; i < px.length; i++) {
    let x = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(seed + 7, 0x85ebca6b);
    x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d); x ^= x >>> 12;
    px[i] = pool.length ? pool[(x >>> 0) % pool.length] : 0x2f;
  }
  return { w, h, px };
}

export interface BuiltRig {
  geometry: THREE.BufferGeometry;
  atlas: { w: number; h: number; data: Uint8Array };
  boxes: BoxDef[];
  triangles: number;
}

/** Builds the shared geometry and palette-index atlas from the WAD's sprites. */
export function buildRig(src: SpriteSource, pal: PaletteData): BuiltRig {
  const boxes = defineBoxes();
  const images: IndexImage[] = [];
  const perBox: FaceImg[][] = [];

  boxes.forEach((b, bi) => {
    const size: V3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    const faces: FaceImg[] = [];
    const tex = (n: number) => Math.max(1, Math.round(n));
    for (const key of FACE_KEYS) {
      const fr = FACE_FRAMES[key];
      const sizeU = dot(absv(fr.u), size), sizeV = dot(absv(fr.v), size);
      const W = tex(sizeU), H = tex(sizeV);
      let spec: FaceSpec = b.faces[key] ?? 'derive';
      if (spec === 'derive' && key !== 'py' && key !== 'ny') spec = 0x6c;
      let img: IndexImage | null = null;
      if (typeof spec === 'number') img = { w: W, h: H, px: new Uint8Array(W * H).fill(spec) };
      else if (spec !== 'derive') {
        img = spec.scatter
          ? scatterRect(src, spec, W, H, bi * 8 + FACE_KEYS.indexOf(key))
          : resample(cutRect(src, spec), W, H);
      }
      faces.push({ key, img: img ?? { w: W, h: H, px: new Uint8Array(W * H) }, sizeU, sizeV });
      if (spec === 'derive') (faces[faces.length - 1] as FaceImg & { derive?: boolean }).derive = true;
    }
    // tops and bottoms: each texel takes the nearest side face's top/bottom edge pixel
    for (const f of faces) {
      if (!(f as FaceImg & { derive?: boolean }).derive) continue;
      const top = f.key === 'py';
      const fr = FACE_FRAMES[f.key];
      const half: V3 = [size[0] / 2, size[1] / 2, size[2] / 2];
      for (let j = 0; j < f.img.h; j++) {
        for (let i = 0; i < f.img.w; i++) {
          // texel centre relative to the box centre
          const cu = ((i + 0.5) / f.img.w - 0.5) * f.sizeU, cv = ((j + 0.5) / f.img.h - 0.5) * f.sizeV;
          const p: V3 = [0, 0, 0];
          for (let k = 0; k < 3; k++) p[k] = fr.n[k] * half[k] + fr.u[k] * cu + fr.v[k] * cv;
          let best = Infinity, val = 0x6c;
          for (const sf of faces) {
            if (sf.key === 'py' || sf.key === 'ny') continue;
            const sfr = FACE_FRAMES[sf.key];
            const hn = dot(absv(sfr.n), half);
            const d = hn - dot(p, sfr.n);
            if (d >= best) continue;
            const uu = dot(p, sfr.u) + sf.sizeU / 2;
            const x = Math.max(0, Math.min(sf.img.w - 1, Math.floor((uu / sf.sizeU) * sf.img.w)));
            const row = top ? 0 : sf.img.h - 1;
            best = d;
            val = sf.img.px[row * sf.img.w + x];
          }
          f.img.px[j * f.img.w + i] = shadeIndex(pal, val, top ? (b.topShade ?? 3) : 6);
        }
      }
    }
    for (const f of faces) images.push(f.img);
    perBox.push(faces);
  });

  const atlas = packAtlas(images, 128);
  // ---- geometry -------------------------------------------------------------
  // A part with a modelled mesh (src/model/meshes.json, built in Blender by
  // tools/model/build_parts.py) is textured by box projection: each triangle takes
  // the face of the part's bounds its normal points at most, and its texels from
  // that face's sprite cut. A part without one is the plain box.
  const P: number[] = [], N: number[] = [], UV: number[] = [], SI: number[] = [], BR: number[] = [];
  const index: number[] = [];
  let ri = 0;
  const vert = (p: V3, n: V3, u: number, v: number, bone: number, bright: number) => {
    P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); UV.push(u, v); SI.push(bone); BR.push(bright);
    return P.length / 3 - 1;
  };
  boxes.forEach((b, bi) => {
    const c: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const half: V3 = [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2];
    const rects = perBox[bi].map(() => atlas.rects[ri++]);
    const mesh = (MESHES as Record<string, { p: number[]; i: number[] } | undefined>)[b.name];
    if (mesh) {
      for (let t = 0; t < mesh.i.length; t += 3) {
        const q = [0, 1, 2].map((k) => { const o = mesh.i[t + k] * 3; return [mesh.p[o], mesh.p[o + 1], mesh.p[o + 2]] as V3; });
        const e1: V3 = [q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]];
        const e2: V3 = [q[2][0] - q[0][0], q[2][1] - q[0][1], q[2][2] - q[0][2]];
        const n: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const len = Math.hypot(n[0], n[1], n[2]);
        if (len < 1e-9) continue;
        n[0] /= len; n[1] /= len; n[2] /= len;
        let fk = 0, best = -Infinity;
        perBox[bi].forEach((f, k) => { const d = dot(FACE_FRAMES[f.key].n, n); if (d > best) { best = d; fk = k; } });
        const f = perBox[bi][fk], fr = FACE_FRAMES[f.key], r = rects[fk];
        for (const p of q) {
          const d: V3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
          // clamp half a texel inside the cut, so nothing samples a neighbour in the atlas
          const iu = 0.5 / r.w, iv = 0.5 / r.h;
          const u = Math.min(1 - iu, Math.max(iu, dot(d, fr.u) / f.sizeU + 0.5));
          const v = Math.min(1 - iv, Math.max(iv, dot(d, fr.v) / f.sizeV + 0.5));
          index.push(vert(p, n, (r.x + u * r.w) / atlas.w, (r.y + v * r.h) / atlas.h, b.bone, b.bright ? 1 : 0));
        }
      }
      return;
    }
    perBox[bi].forEach((f, k) => {
      const fr = FACE_FRAMES[f.key];
      const r = rects[k];
      const hn = dot(absv(fr.n), half);
      const ids = ([[0, 0], [0, 1], [1, 1], [1, 0]] as [number, number][]).map(([u, v]) => {
        const p: V3 = [0, 0, 0];
        for (let a = 0; a < 3; a++) p[a] = c[a] + fr.n[a] * hn + fr.u[a] * (u - 0.5) * f.sizeU + fr.v[a] * (v - 0.5) * f.sizeV;
        return vert(p, fr.n, (r.x + u * r.w) / atlas.w, (r.y + v * r.h) / atlas.h, b.bone, b.bright ? 1 : 0);
      });
      index.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
    });
  });
  const pos = new Float32Array(P), nor = new Float32Array(N), uv = new Float32Array(UV), bright = new Float32Array(BR);
  const skinIndex = new Uint16Array(SI.length * 4), skinWeight = new Float32Array(SI.length * 4);
  SI.forEach((bone, k) => { skinIndex[k * 4] = bone; skinWeight[k * 4] = 1; });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  g.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
  g.setIndex(index);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 28, 0), 90);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-90, -2, -90), new THREE.Vector3(90, 90, 90));
  return { geometry: g, atlas: { w: atlas.w, h: atlas.h, data: atlas.data }, boxes, triangles: index.length / 3 };
}
