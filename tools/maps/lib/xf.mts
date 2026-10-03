// Affine placement of a design (rotations by 90°, mirrors, translation): designs keep their
// 0/45/90-degree edges and grid alignment.
import { chamfer, poly, rect, type Pt, type Shape } from './canvas.mts';

export interface Xf { a: number; b: number; c: number; d: number; tx: number; ty: number }
export const ident: Xf = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
export const apply = (m: Xf, x: number, y: number): Pt => [m.a * x + m.b * y + m.tx, m.c * x + m.d * y + m.ty];
/** compose: first `inner`, then `outer` */
export const then = (inner: Xf, outer: Xf): Xf => ({
  a: outer.a * inner.a + outer.b * inner.c, b: outer.a * inner.b + outer.b * inner.d,
  c: outer.c * inner.a + outer.d * inner.c, d: outer.c * inner.b + outer.d * inner.d,
  tx: outer.a * inner.tx + outer.b * inner.ty + outer.tx, ty: outer.c * inner.tx + outer.d * inner.ty + outer.ty,
});
export const mirrorX: Xf = { a: -1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
export const rot180: Xf = { a: -1, b: 0, c: 0, d: -1, tx: 0, ty: 0 };
export const rot90: Xf = { a: 0, b: -1, c: 1, d: 0, tx: 0, ty: 0 };
export const translate = (tx: number, ty: number): Xf => ({ a: 1, b: 0, c: 0, d: 1, tx, ty });

/** Shape builders in a transformed frame. */
export function frame(m: Xf) {
  return {
    r: (x0: number, y0: number, x1: number, y1: number): Shape => { const [ax, ay] = apply(m, x0, y0), [bx, by] = apply(m, x1, y1); return rect(ax, ay, bx, by); },
    ch: (x0: number, y0: number, x1: number, y1: number, k: number): Shape => { const [ax, ay] = apply(m, x0, y0), [bx, by] = apply(m, x1, y1); return chamfer(ax, ay, bx, by, k); },
    p: (pts: Pt[]): Shape => poly(pts.map(([x, y]) => apply(m, x, y))),
    pt: (x: number, y: number): Pt => apply(m, x, y),
    /** a design angle (degrees) in world degrees */
    ang: (deg: number): number => { const t = (deg * Math.PI) / 180; const [x, y] = [m.a * Math.cos(t) + m.b * Math.sin(t), m.c * Math.cos(t) + m.d * Math.sin(t)]; return ((Math.round((Math.atan2(y, x) * 180) / Math.PI) % 360) + 360) % 360; },
  };
}
