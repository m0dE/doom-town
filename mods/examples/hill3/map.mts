// HILL3 "Three Hills" — a compact war map (16 v 16) with three capture points, the modding
// guide's second example (docs/MODDING.md "Example 2"). Built with the map DSL.
//
//   red base (west)      A watchtower                         blue base (east)
//   ┌────┐                    B the central hill (terraces)        ┌────┐
//   │ 9000│                                       C pump house     │9001 │
//   └────┘                                                         └────┘
//
// The layout is point-symmetric around (0, 0): whatever red has, blue has rotated by 180°,
// so neither side is favoured. War rules (DESIGN.md "Modes"): standing in a point's radius
// with more teammates than enemies captures it; tickets drain while you hold fewer points.
// Things that make it a war map: 9000 red team starts, 9001 blue team starts, 9010 capture
// points (angle field = radius / 8).
import { PaintCanvas, rect, oct, chamfer, poly, type Pt, type Style } from '../../../tools/maps/lib/canvas.mts';
import { T, stairs, rng, blob, withProps, lighten } from '../../../tools/maps/lib/kit.mts';
import { out, room, mass, solid } from '../../../tools/maps/lib/styles.mts';

export const NAME = 'HILL3';
export const TITLE = 'Three Hills';

const W = 3712, H = 2304; // half extents

export function build(): PaintCanvas {
  const c = new PaintCanvas(-W, -H, W, H, 8, solid('ROCK4'));
  const R = rng(333);
  /** Point symmetry: f(1) paints the red half's feature, f(-1) the same rotated 180°. */
  const both = (f: (s: number) => void) => { f(1); f(-1); };
  const rs = (s: number, x0: number, y0: number, x1: number, y1: number) => rect(s * x0, s * y0, s * x1, s * y1);
  const ps = (s: number, pts: Pt[]) => poly(pts.map(([x, y]) => [s * x, s * y] as Pt));
  const th = (s: number, x: number, y: number, t: number, a = 0) => c.thing(s * x, s * y, t, s > 0 ? a : (a + 180) % 360);

  // ---- the valley: grass, dirt roads, a rocky rim ----------------------------------------
  const grass = out(0, 'GRASS1');
  c.paint(chamfer(-W + 128, -H + 128, W - 128, H - 128, 512), grass);
  for (let i = 0; i < 24; i++) {
    const x = Math.round((R() * 2 - 1) * (W - 800) / 16) * 16, y = Math.round((R() * 2 - 1) * (H - 600) / 16) * 16;
    const p = R() < 0.5 ? 'GRASS2' : 'FLOOR7_2';
    c.modify(blob(x, y, 160 + R() * 256, 128 + R() * 192, R), withProps({ floorPic: p }));
    c.modify(blob(-x, -y, 160 + R() * 256, 128 + R() * 192, R), withProps({ floorPic: p }));
  }
  // the rim: rock blocks of varied height, a little higher than the sky line elsewhere
  const rim = (horizontal: boolean, fixed: number, dir: number, from: number, to: number) => {
    for (let p = from; p < to;) {
      const q = Math.min(to, p + 256 + Math.floor(R() * 4) * 128);
      const h = 160 + Math.floor(R() * 4) * 48, d = 256 + Math.floor(R() * 3) * 64;
      const st = mass(h, R() < 0.5 ? 'ROCK4' : 'ROCK5', { floorPic: 'RROCK09', light: 176, ceil: h + 8 });
      if (horizontal) c.paint(chamfer(p, fixed, q, fixed - dir * d, 48), st); else c.paint(chamfer(fixed, p, fixed - dir * d, q, 48), st);
      p = q;
    }
  };
  rim(true, H - 128, 1, -W + 128, W - 128); rim(true, -H + 128, -1, -W + 128, W - 128);
  rim(false, W - 128, 1, -H + 128, H - 128); rim(false, -W + 128, -1, -H + 128, H - 128);
  // roads from each base to all three points
  const road = withProps({ floorPic: 'FLAT10' });
  both((s) => {
    c.modify(rs(s, -2560, -96, -320, 96), road);                                   // base → B
    c.modify(ps(s, [[-2560, 96], [-2368, 96], [-1536, 928], [-1536, 1120], [-1728, 1120], [-2560, 288]]), road); // base → A
    c.modify(ps(s, [[-2368, -96], [-1600, -864], [-1408, -864], [-1408, -672], [-1600, -672], [-2176, -96]]), road); // base → the south lane
  });

  // ---- the bases ------------------------------------------------------------------------
  both((s) => {
    const blue = s < 0;
    const face = blue ? 'SILVER2' : 'BRICK11', accent = blue ? 'LITEBLU4' : 'LITERED1', banner = blue ? 'PANBLUE' : 'PANRED';
    // compound wall and yard
    c.paint(rs(s, -3520, -896, -2496, 896), mass(128, 'CEMENT1', { floorPic: 'FLAT1', light: 192 }));
    c.paint(rs(s, -3456, -832, -2560, 832), out(0, 'FLAT5_4', { light: 200 }));
    // gates: east (toward B) and north/south
    c.paint(rs(s, -2560, -192, -2496, 192), out(0, 'FLAT5_4', { light: 208 }));
    c.paint(rs(s, -2944, 832, -2752, 896), out(0, 'FLAT5_4', { light: 208 }));
    c.paint(rs(s, -2944, -896, -2752, -832), out(0, 'FLAT5_4', { light: 208 }));
    for (const [x, y] of [[-2560, 192], [-2560, -256], [-3008, 832], [-2752, 832], [-3008, -896], [-2752, -896]]) {
      c.paint(rs(s, x, y, x + 64, y + 64), mass(176, banner, { floorPic: 'FLAT1', light: 208 }));
    }
    // the hangar: team starts inside, three doorways facing the yard
    c.paint(rs(s, -3456, -512, -3008, 512), mass(320, face, { floorPic: 'FLAT1' }));
    const hall = room(0, 192, 'FLAT20', 'CEIL5_1', 160);
    c.paint(rs(s, -3424, -480, -3040, 480), hall);
    c.paint(rs(s, -3424, -64, -3040, 64), { ...hall, floorPic: blue ? 'FLOOR1_1' : 'FLOOR1_7', ceilPic: 'CEIL3_4', light: 200 });
    for (const y of [-384, -64, 256]) c.paint(rs(s, -3040, y, -3008, y + 128), room(0, 128, 'FLAT20', 'CEIL5_1', 176, { upper: face }));
    for (const y of [-448, 416]) c.paint(rs(s, -3392, y, -3072, y + 32), mass(320, accent));
    // 16 team starts (4 × 4), facing the doors
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) th(s, -3360 + i * 80, -144 + j * 96, blue ? T.BLUE_START : T.RED_START, 0);
    // weapons and supplies in the hangar and the yard
    th(s, -3360, 352, T.SHOTGUN); th(s, -3264, 352, T.SHELLS); th(s, -3360, -352, T.CHAINGUN); th(s, -3264, -352, T.CLIP);
    th(s, -3136, 352, T.MEDI); th(s, -3136, -352, T.GREENARMOR);
    // sandbag cover in the yard
    for (const [x0, y0, x1, y1] of [[-2816, 320, -2752, 576], [-2816, -576, -2752, -320], [-2688, -64, -2624, 64]]) c.paint(rs(s, x0, y0, x1, y1), mass(40, 'CEMENT7', { floorPic: 'FLAT1', light: 200 }));
    th(s, -2880, 640, T.STORCH_RED + (blue ? -2 : 0)); th(s, -2880, -640, T.STORCH_RED + (blue ? -2 : 0));
  });

  // ---- B: the central hill, three terraces and a ring of standing stones -----------------
  c.paint(oct(0, 0, 640, 512), out(24, 'GRASS1', { riser: 'A-MOSROK' }));
  c.paint(oct(0, 0, 480, 384), out(48, 'GRASS2', { riser: 'A-MOSROK' }));
  c.paint(oct(0, 0, 320, 256), out(72, 'RROCK19', { riser: 'A-MOSROK', light: 224 }));
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const x = Math.round((Math.cos(a) * 256) / 16) * 16, y = Math.round((Math.sin(a) * 192) / 16) * 16;
    c.paint(rect(x - 24, y - 24, x + 24, y + 24), mass(176, 'STONE3', { floorPic: 'FLAT1', light: 200 }));
  }

  // ---- A and C: a watchtower on a rocky knoll, mirrored ----------------------------------
  both((s) => {
    const cx = -1408, cy = 1152;
    c.paint(ps(s, [[cx - 448, cy - 320], [cx + 320, cy - 320], [cx + 448, cy - 192], [cx + 448, cy + 320], [cx - 320, cy + 320], [cx - 448, cy + 192]]), out(16, 'FLOOR7_2', { riser: 'ROCK5' }));
    // tower: a solid base with a stair up its south side to a lookout at 96
    c.paint(rs(s, cx - 128, cy - 32, cx + 128, cy + 224), mass(96, 'STONE3', { floorPic: 'FLAT5_7', light: 208 }));
    stairs(c, s * (cx - 64), s * (cy - 192), s * (cx + 64), s * (cy - 32), s > 0 ? 'N' : 'S', [32, 48, 64, 80], (z) => out(z, 'STEP2', { riser: 'STEP3' }));
    // battlements around the lookout (low walls the defenders shoot over)
    for (const [x0, y0, x1, y1] of [[cx - 128, cy + 192, cx + 128, cy + 224], [cx - 128, cy - 32, cx - 96, cy + 224], [cx + 96, cy - 32, cx + 128, cy + 224]]) {
      c.paint(rs(s, x0, y0, x1, y1), mass(136, 'STONE3', { floorPic: 'FLAT5_7', light: 208 }));
    }
    th(s, cx, cy + 96, T.ROCKETL); th(s, cx + 48, cy + 96, T.ROCKET); th(s, cx - 48, cy + 96, T.ROCKET);
    // a pond in the empty quadrant, with an ammo cache on its island
    const px = 1280, py = 1152;
    c.paint(oct(s * px, s * py, 384, 256), out(-24, 'FWATER1', { riser: 'ROCK5', light: 192 }));
    c.paint(oct(s * px, s * py, 128, 96), out(0, 'FLOOR7_2', { riser: 'ROCK5' }));
    th(s, px, py, T.BULLETS); th(s, px + 48, py, T.SHELLBOX); th(s, px - 48, py, T.STIM);
    // rock outcrops and ruined walls along the lanes (cover)
    for (const [x, y, rx, ry] of [[-1984, 512, 96, 64], [-768, 896, 64, 96], [-896, -640, 96, 64], [-1792, -1152, 64, 80], [-384, 1536, 80, 64], [-2048, -512, 64, 64]]) {
      c.paint(blob(s * x, s * y, rx, ry, R), mass(64 + Math.floor(R() * 3) * 32, 'ROCK5', { floorPic: 'RROCK09', light: 200 }));
    }
    for (const [x0, y0, x1, y1] of [[-1216, 256, -1184, 448], [-1184, -448, -992, -416], [-640, 1344, -448, 1376]]) c.paint(rs(s, x0, y0, x1, y1), mass(72, 'STONE2', { floorPic: 'FLAT5_7', light: 200 }));
    // field items
    th(s, -1984, 0, T.CHAINGUN); th(s, -1920, 0, T.BULLETS);
    th(s, -896, -1024, T.SSG); th(s, -832, -1024, T.SHELLS);
    th(s, -1152, 352, T.MEDI); th(s, -640, -320, T.STIM); th(s, -1600, -640, T.CLIP); th(s, -1600, 640, T.SHELLS);
    th(s, -448, 640, T.ABONUS); th(s, -384, 640, T.ABONUS); th(s, -320, 640, T.ABONUS);
    th(s, -1408, 1600, T.GREENARMOR);
  });
  // the prize on the hilltop
  c.thing(0, 0, T.MEGA);
  c.thing(64, 0, T.CELL); c.thing(-64, 0, T.CELL);
  c.thing(0, 96, T.PLASMA); c.thing(0, -96, T.PLASMA);
  // capture points, in letter order (the order of the 9010 things): A the red side's tower,
  // B the hill, C the blue side's tower. The angle field is the radius / 8.
  c.thing(-1408, 1056, T.POINT, 256 / 8);
  c.thing(0, 0, T.POINT, 288 / 8);
  c.thing(1408, -1056, T.POINT, 256 / 8);
  // a little extra light on the hill
  c.modify(oct(0, 0, 640, 512), lighten(8));
  return c;
}
