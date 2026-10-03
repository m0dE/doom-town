// Level-design helpers on top of the paint canvas: styles, stairs, terraces, crates,
// rings (thick walls), mirrored placement, and thing constants.
import { PaintCanvas, chamfer, rect, poly, type Paint, type Pt, type Shape, type Solid, type Style } from './canvas.mts';

export const T = {
  // generated-map things (DESIGN.md "Modes, teams and map rotation")
  RED_START: 9000, BLUE_START: 9001, POINT: 9010,
  // weapons
  SHOTGUN: 2001, SSG: 82, CHAINGUN: 2002, ROCKETL: 2003, PLASMA: 2004, BFG: 2006, CHAINSAW: 2005,
  // ammo
  CLIP: 2007, BULLETS: 2048, SHELLS: 2008, SHELLBOX: 2049, ROCKET: 2010, ROCKETBOX: 2046, CELL: 2047, CELLPACK: 17, BACKPACK: 8,
  // health / armor / powerups
  STIM: 2011, MEDI: 2012, HBONUS: 2014, SOUL: 2013, MEGA: 83, GREENARMOR: 2018, BLUEARMOR: 2019, ABONUS: 2015,
  INVIS: 2024, SUIT: 2025, BERSERK: 2023,
  // decoration
  TECHLAMP: 85, TECHLAMP2: 86, FLOORLAMP: 2028, TECHCOL: 48, CANDELABRA: 35, BARREL: 2035, BURNBARREL: 70,
  TORCH_BLUE: 44, TORCH_GREEN: 45, TORCH_RED: 46, STORCH_BLUE: 55, STORCH_GREEN: 56, STORCH_RED: 57,
  COL_GREEN: 30, COL_GREEN_S: 31, COL_RED: 32, COL_RED_S: 33, COL_HEART: 36,
  TREE_BURNT: 43, TREE_BIG: 54, STUMP: 47, STALAG: 47,
} as const;

export const SKY = 'F_SKY1';
export const levelsBetween = (z0: number, z1: number, max = 16): number[] => {
  const n = Math.max(1, Math.ceil(Math.abs(z1 - z0) / max));
  const out: number[] = [];
  for (let k = 1; k < n; k++) out.push(Math.round(z0 + ((z1 - z0) * k) / n));
  return out;
};
const snap = (v: number, g = 8) => Math.round(v / g) * g;

export type Dir = 'N' | 'S' | 'E' | 'W';
/**
 * Stairs filling rect (x0,y0)-(x1,y1), rising towards `dir`, with the given floor levels
 * (first level at the low end). mk(z, i) makes each step's style.
 */
export function stairs(c: PaintCanvas, x0: number, y0: number, x1: number, y1: number, dir: Dir, levels: number[], mk: (z: number, i: number) => Paint): void {
  [x0, x1] = [Math.min(x0, x1), Math.max(x0, x1)];
  [y0, y1] = [Math.min(y0, y1), Math.max(y0, y1)];
  const n = levels.length;
  for (let i = 0; i < n; i++) {
    const a = i / n, b = (i + 1) / n;
    let r: Shape;
    if (dir === 'E') r = rect(snap(x0 + (x1 - x0) * a), y0, snap(x0 + (x1 - x0) * b), y1);
    else if (dir === 'W') r = rect(snap(x1 - (x1 - x0) * b), y0, snap(x1 - (x1 - x0) * a), y1);
    else if (dir === 'N') r = rect(x0, snap(y0 + (y1 - y0) * a), x1, snap(y0 + (y1 - y0) * b));
    else r = rect(x0, snap(y1 - (y1 - y0) * b), x1, snap(y1 - (y1 - y0) * a));
    c.paint(r, mk(levels[i], i));
  }
}

/** A thick wall band around a chamfered rectangle (outer minus inner). */
export function ring(x0: number, y0: number, x1: number, y1: number, t: number, ch = 0): Shape[] {
  // four bands (with chamfer corners handled by painting the outer then re-painting the inner by the caller)
  return [chamfer(x0, y0, x1, y1, ch), chamfer(x0 + t, y0 + t, x1 - t, y1 - t, Math.max(0, ch - t / 2))];
}

/** Paints `outerStyle` on the chamfered rect and `inner` inside it, leaving a band of thickness t. */
export function walledArea(c: PaintCanvas, x0: number, y0: number, x1: number, y1: number, t: number, ch: number, wall: Paint, inner: Paint): void {
  c.paint(chamfer(x0, y0, x1, y1, ch), wall);
  c.paint(chamfer(x0 + t, y0 + t, x1 - t, y1 - t, Math.max(0, ch - snap(t * 0.41))), inner);
}

/** With a style transform applied to whatever is under the shape. */
export const lighten = (d: number) => (p: Paint): Paint | null => ((p as Solid).solid ? null : { ...(p as Style), light: Math.max(0, Math.min(255, (p as Style).light + d)) });
export const withProps = (o: Partial<Style>) => (p: Paint): Paint | null => ((p as Solid).solid ? null : { ...(p as Style), ...o });
export const raise = (dz: number, o: Partial<Style> = {}) => (p: Paint): Paint | null => ((p as Solid).solid ? null : { ...(p as Style), floor: (p as Style).floor + dz, ...o });

/** Deterministic PRNG (xorshift32). */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** Irregular rock outcrop: a polygon of 45° steps around a centre (vertices on the grid). */
export function blob(cx: number, cy: number, rx: number, ry: number, r: () => number, g = 16): Shape {
  // an octagon with jittered extents per side, edges at 0/45/90
  cx = snap(cx, g); cy = snap(cy, g);
  const j = (v: number) => Math.max(2 * g, snap(v * (0.75 + r() * 0.5), g));
  const e = j(rx), w = j(rx), n = j(ry), s = j(ry);
  const c1 = snap(Math.min(e, n) * (0.3 + r() * 0.3), g), c2 = snap(Math.min(w, n) * (0.3 + r() * 0.3), g);
  const c3 = snap(Math.min(w, s) * (0.3 + r() * 0.3), g), c4 = snap(Math.min(e, s) * (0.3 + r() * 0.3), g);
  const X = (v: number) => snap(cx + v, g), Y = (v: number) => snap(cy + v, g);
  return poly([
    [X(-w + c3), Y(-s)], [X(e - c4), Y(-s)], [X(e), Y(-s + c4)], [X(e), Y(n - c1)], [X(e - c1), Y(n)], [X(-w + c2), Y(n)], [X(-w), Y(n - c2)], [X(-w), Y(-s + c3)],
  ] as Pt[]);
}

export { rect, poly, chamfer };
