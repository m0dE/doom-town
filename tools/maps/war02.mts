// WAR02 "Canal City" — 100 vs 100 conquest in a ruined city (15360 × 18944 units).
//
// Red base in the south, blue base in the north; a water canal runs east–west through the
// middle (no damage: it is a sunken flanking lane, with stairs and five bridges). Avenues
// run north–south, cross streets east–west, city blocks of buildings in between: tall
// blocks break sightlines, ruins and a few enterable buildings give close quarters.
//   A  Train depot      (-5472, -3616)  sheds, platforms and wagons      (red's west)
//   B  City park        (-5472,  3616)  fountain, hedges, statue          (blue's west)
//   C  Canal plaza      (    0,     0)  the wide bridge-plaza with an obelisk, centre
//   D  Church ruin      ( 5472, -3616)  cruciform stone church, bell tower (red's east)
//   E  Office court     ( 5472,  3616)  U-shaped office block around a court (blue's east)
// Point-symmetric layout (blocks, streets, bridges, item spots); landmarks differ.
import { PaintCanvas, rect, chamfer, oct, type Pt, type Shape, type Style, type Solid } from './lib/canvas.mts';
import { T, stairs, lighten, withProps, raise, rng, blob } from './lib/kit.mts';
import { SKYH, out, room, mass, solid } from './lib/styles.mts';
import { teamBase } from './lib/base.mts';
import { rot180, rot90, then, translate } from './lib/xf.mts';

export const NAME = 'WAR02';
export const TITLE = 'War: Canal City';

const W = 7680, H = 9472;
const CANAL_Z = -80;
const FACADES = ['BRICK7', 'BRICK1', 'BIGBRIK1', 'STUCCO1', 'BRWINDOW', 'A-BRICK1', 'BRICK10', 'BROWN96', 'STONE6', 'A-BRBRK'];
const street = (o: Partial<Style> = {}) => out(0, 'FLAT5_4', { light: 192, riser: 'STEP1', wall: 'BRICK7', ...o });
const walk = (o: Partial<Style> = {}) => out(8, 'FLAT1', { light: 192, riser: 'STEP1', ...o });

// columns (x) and rows (y) of the blocks in the north half; the south half is the point mirror
const COLS: [number, number][] = [[-7168, -3776], [-3392, -256], [256, 3392], [3776, 7168]];
const ROWS: [number, number][] = [[704, 2368], [2752, 4480], [4864, 6016]];

export function build(): PaintCanvas {
  const c = new PaintCanvas(-W, -H, W, H, 8, solid('BRICK7'));
  const R = rng(4242);

  // ==== 1. streets everywhere, city wall on the perimeter ===============================
  c.paint(rect(-W + 128, -H + 128, W - 128, H - 128), street());
  // the edge: a ring of tall old buildings (low sky = the horizon), with set-backs
  const edge = (x0: number, y0: number, x1: number, y1: number) => { const h = 256 + Math.floor(R() * 6) * 48; c.paint(rect(x0, y0, x1, y1), mass(h, FACADES[Math.floor(R() * FACADES.length)], { floorPic: 'FLAT1', light: 176, ceil: h + 8 })); };
  const ring = (horizontal: boolean, fixed: number, dir: number, from: number, to: number) => {
    for (let p = from; p < to;) {
      const len = 384 + Math.floor(R() * 5) * 128, q = Math.min(to, p + len);
      const depth = 384 + Math.floor(R() * 3) * 64;
      if (horizontal) edge(p, fixed, q, fixed - dir * depth); else edge(fixed, p, fixed - dir * depth, q);
      p = q;
    }
  };
  ring(true, H - 128, 1, -W + 128, W - 128); ring(true, -H + 128, -1, -W + 128, W - 128);
  ring(false, W - 128, 1, -H + 128, H - 128); ring(false, -W + 128, -1, -H + 128, H - 128);

  // ==== 2. city blocks ================================================================
  const both = (f: (s: number) => void) => { f(1); f(-1); };
  const pointBlocks = new Set(['0,1', '3,1']);
  both((s) => {
    ROWS.forEach(([y0, y1], ri) => COLS.forEach(([x0, x1], ci) => {
      const X0 = s > 0 ? x0 : -x1, X1 = s > 0 ? x1 : -x0, Y0 = s > 0 ? y0 : -y1, Y1 = s > 0 ? y1 : -y0;
      // sidewalk around every block
      c.paint(chamfer(X0, Y0, X1, Y1, 64), walk());
      if (pointBlocks.has(`${ci},${ri}`)) return; // landmarks are painted below
      cityBlock(c, X0 + 64, Y0 + 64, X1 - 64, Y1 - 64, R, (ci + ri * 4 + (s > 0 ? 0 : 7)) % 5);
    }));
    // the open square in front of each base
    c.paint(rect(-1792, s > 0 ? 6016 : -6784, 1792, s > 0 ? 6784 : -6016), out(0, 'FLAT5_7', { light: 200, riser: 'STEP1' }));
  });

  // ==== 3. bases ======================================================================
  const blueXf = then(translate(-640, 0), rot90);
  teamBase(c, true, blueXf);
  teamBase(c, false, then(blueXf, rot180));

  // ==== 4. landmarks / points ===========================================================
  depot(c, -5472, -3616, R);
  park(c, -5472, 3616, R);
  church(c, 5472, -3616, R);
  offices(c, 5472, 3616, R);
  canal(c, R);
  for (const [x, y, r] of [[-5472, -3616, 352], [-5472, 3616, 320], [0, 0, 384], [5472, -3616, 320], [5472, 3616, 320]]) c.thing(x, y, T.POINT, r / 8);

  // ==== 5. streets: barricades, wrecks, lamps, items ==========================================
  both((s) => {
    const P = (x: number, y: number): Pt => [Math.round((s * x) / 8) * 8, Math.round((s * y) / 8) * 8];
    const bar = (x0: number, y0: number, x1: number, y1: number) => { const [a, b] = P(x0, y0), [d, e] = P(x1, y1); c.paint(rect(a, b, d, e), mass(40, 'CEMENT7', { floorPic: 'FLAT1', light: 192 })); };
    const wreck = (x0: number, y0: number, w: number, d: number) => { const [a, b] = P(x0, y0), [e, f] = P(x0 + w, y0 + d); c.paint(rect(a, b, e, f), mass(56, 'CRATE2', { floorPic: 'CRATOP1', light: 184 })); };
    // central boulevard (x −256..256): barricades staggered, wrecks
    bar(-224, 1600, -32, 1640); bar(32, 3200, 224, 3240); bar(-224, 5000, -32, 5040);
    wreck(96, 1024, 64, 160); wreck(-160, 4100, 64, 160);
    // side avenues
    bar(3424, 1800, 3584, 1840); bar(3584, 3900, 3744, 3940); wreck(3456, 5400, 64, 160);
    bar(-3744, 1300, -3584, 1340); bar(-3584, 3400, -3424, 3440); wreck(-3712, 5200, 64, 160);
    // cross streets
    for (const x of [-6400, -1800, 1800, 6400]) bar(x, 2400, x + 40, 2560);
    for (const x of [-4800, 0, 4800]) wreck(x - 80, 4560, 160, 64);
    // lamps along the avenues
    for (let y = 900; y < 6000; y += 768) for (const x of [-288, 288, -3424, 3424, -3744, 3744]) { const [a, b] = P(x, y); c.thing(a, b, T.FLOORLAMP); }
    // items on the streets
    const it = (x: number, y: number, t: number) => { const [a, b] = P(x, y); c.thing(a, b, t); };
    for (const y of [1200, 3000, 5400]) { it(0, y, T.STIM); it(64, y, T.CLIP); it(-64, y, T.SHELLS); }
    for (const [x, y] of [[-3584, 2560], [3584, 2560], [-3584, 4672], [3584, 4672]]) { it(x, y, T.MEDI); it(x + 64, y, T.SHELLBOX); it(x - 64, y, T.BULLETS); }
    it(0, 2560, T.CHAINGUN); it(0, 4672, T.ROCKETL); it(96, 4672, T.ROCKET);
    it(-1600, 2560, T.SSG); it(1600, 4672, T.SHOTGUN); it(-1600, 4672, T.GREENARMOR); it(1600, 2560, T.BACKPACK);
    it(-5472, 2560, T.SHOTGUN); it(5472, 4672, T.CHAINGUN); it(-5472, 4672, T.ROCKET); it(5472, 2560, T.MEDI);
    it(0, 6400, T.SHELLBOX); it(-1024, 6400, T.MEDI); it(1024, 6400, T.BULLETS);
  });

  // ==== 6. light pools under lamps, torches, fires ======================================
  const LAMPS = new Set<number>([T.TECHLAMP, T.TECHLAMP2, T.FLOORLAMP, T.TORCH_RED, T.TORCH_BLUE, T.TORCH_GREEN, T.STORCH_RED, T.STORCH_BLUE, T.STORCH_GREEN, T.CANDELABRA, T.BURNBARREL]);
  for (const t of [...c.things]) {
    if (!LAMPS.has(t.type)) continue;
    c.modify(oct(Math.round(t.x / 8) * 8, Math.round(t.y / 8) * 8, 128, 128), lighten(24));
  }
  return c;
}

// ---- a generic city block: buildings on lots, an alley, sometimes a ruin or a yard ----------
function cityBlock(c: PaintCanvas, x0: number, y0: number, x1: number, y1: number, R: () => number, flavour: number): void {
  const w = x1 - x0;
  // lots: split along x into 2..3 parts with 192-wide alleys
  const n = w > 2800 ? 3 : 2;
  const alley = 192;
  const lotW = Math.floor((w - (n - 1) * alley) / n / 16) * 16;
  for (let i = 0; i < n; i++) {
    const lx0 = x0 + i * (lotW + alley), lx1 = i === n - 1 ? x1 : lx0 + lotW;
    const kind = (flavour + i * 2) % 5;
    const face = FACADES[Math.floor(R() * FACADES.length)];
    if (kind === 0 || kind === 3) {
      // tall block, chamfered corner, light strips by its door-less facade
      c.paint(chamfer(lx0, y0, lx1, y1, 64 + Math.floor(R() * 3) * 32), mass(SKYH, face, { light: 184 }));
    } else if (kind === 1) {
      // enterable building: shell at SKYH, interior hall, doors on both long sides
      c.paint(rect(lx0, y0, lx1, y1), mass(SKYH, face, { light: 184 }));
      const ix0 = lx0 + 48, ix1 = lx1 - 48, iy0 = y0 + 48, iy1 = y1 - 48;
      c.paint(rect(ix0, iy0, ix1, iy1), room(8, 152, 'FLOOR4_6', 'CEIL3_5', 136, { upper: face, wall: 'PANEL4', riser: 'STEP1' }));
      // inner columns
      for (let x = ix0 + 256; x < ix1 - 128; x += 384) for (let y = iy0 + 256; y < iy1 - 128; y += 512) c.paint(rect(x, y, x + 48, y + 48), solid('WOODMET1'));
      // doors (lintels at 128 so the facade continues above)
      const mid = Math.round((lx0 + lx1) / 2 / 8) * 8;
      for (const [a, b] of [[y0, y0 + 48], [y1 - 48, y1]]) c.paint(rect(mid - 96, a, mid + 96, b), room(8, 128, 'FLOOR4_6', 'CEIL3_5', 160, { upper: face }));
      for (const x of [lx0, lx1 - 48]) { const yy = Math.round((y0 + y1) / 2 / 8) * 8; c.paint(rect(x, yy - 96, x + 48, yy + 96), room(8, 128, 'FLOOR4_6', 'CEIL3_5', 160, { upper: face })); }
      c.paint(rect(ix0 + 64, iy0 + 64, ix0 + 192, iy0 + 192), room(8, 152, 'FLOOR4_6', 'TLITE6_6', 176, { upper: face }));
      c.paint(rect(ix1 - 192, iy1 - 192, ix1 - 64, iy1 - 64), room(8, 152, 'FLOOR4_6', 'TLITE6_6', 176, { upper: face }));
      c.thing(mid, Math.round((y0 + y1) / 2), [T.SSG, T.CHAINGUN, T.ROCKETL, T.PLASMA][Math.floor(R() * 4)]);
      c.thing(mid + 64, Math.round((y0 + y1) / 2), T.MEDI);
      c.thing(ix0 + 128, iy0 + 128, T.SHELLBOX);
      c.thing(ix1 - 128, iy1 - 128, T.BULLETS);
    } else if (kind === 2) {
      // ruin: broken walls, open to the sky, rubble inside
      const h = 160 + Math.floor(R() * 4) * 32;
      c.paint(rect(lx0, y0, lx1, y1), mass(h, face, { light: 184 }));
      c.paint(rect(lx0 + 32, y0 + 32, lx1 - 32, y1 - 32), out(8, 'FLOOR6_2', { light: 184, riser: face }));
      // breaches on every side
      for (let k = 0; k < 4; k++) {
        const along = (lo: number, hi: number) => lo + 64 + Math.floor(R() * Math.max(1, (hi - lo - 320) / 16)) * 16;
        const bx = along(lx0, lx1), by = along(y0, y1);
        if (k === 0) c.paint(rect(bx, y0, bx + 192, y0 + 32), out(8, 'FLOOR6_2', { light: 188, riser: face }));
        if (k === 1) c.paint(rect(bx, y1 - 32, bx + 192, y1), out(8, 'FLOOR6_2', { light: 188, riser: face }));
        if (k === 2) c.paint(rect(lx0, by, lx0 + 32, by + 192), out(8, 'FLOOR6_2', { light: 188, riser: face }));
        if (k === 3) c.paint(rect(lx1 - 32, by, lx1, by + 192), out(8, 'FLOOR6_2', { light: 188, riser: face }));
      }
      // lower wall stretches (collapsed)
      c.paint(rect(lx0 + Math.floor((lx1 - lx0) / 3 / 16) * 16, y0, lx0 + Math.floor((lx1 - lx0) / 2 / 16) * 16, y0 + 32), mass(64, face, { light: 188 }));
      for (let k = 0; k < 3; k++) {
        const bx = lx0 + 160 + Math.floor(R() * Math.max(1, (lx1 - lx0 - 320) / 16)) * 16, by = y0 + 160 + Math.floor(R() * Math.max(1, (y1 - y0 - 320) / 16)) * 16;
        c.paint(blob(bx, by, 64 + R() * 48, 48 + R() * 48, R), out(32, 'FLOOR6_2', { riser: 'ROCK3', light: 184 }));
        c.paint(blob(bx, by, 32, 32, R), out(56, 'FLOOR6_2', { riser: 'ROCK3', light: 184 }));
      }
      c.thing(Math.round((lx0 + lx1) / 2), Math.round((y0 + y1) / 2), [T.SHELLBOX, T.ROCKET, T.CELL, T.STIM][Math.floor(R() * 4)]);
      c.thing(lx0 + 96, y0 + 96, T.BURNBARREL);
    } else {
      // low shops with a back yard
      c.paint(rect(lx0, y0, lx1, y1), mass(128 + Math.floor(R() * 3) * 32, face, { light: 184 }));
      const yy0 = y0 + Math.floor((y1 - y0) * 0.35 / 16) * 16, yy1 = y1 - Math.floor((y1 - y0) * 0.35 / 16) * 16;
      c.paint(rect(lx0 + 48, yy0, lx1 - 48, yy1), out(8, 'FLOOR7_1', { light: 188, riser: face }));
      c.paint(rect(lx0, yy0 + 64, lx0 + 48, yy0 + 256), out(8, 'FLOOR7_1', { light: 188, riser: face }));
      c.paint(rect(lx1 - 48, yy1 - 256, lx1, yy1 - 64), out(8, 'FLOOR7_1', { light: 188, riser: face }));
      c.thing(Math.round((lx0 + lx1) / 2), Math.round((yy0 + yy1) / 2), T.BURNBARREL);
      c.thing(Math.round((lx0 + lx1) / 2) + 96, Math.round((yy0 + yy1) / 2), T.HBONUS);
      c.thing(Math.round((lx0 + lx1) / 2) - 96, Math.round((yy0 + yy1) / 2), T.ABONUS);
    }
  }
}

// ---- the canal, quays and bridges ------------------------------------------------------------
function canal(c: PaintCanvas, R: () => number): void {
  const quay = out(0, 'FLAT5_7', { light: 196, riser: 'STONE2' });
  c.paint(rect(-W + 640, -704, W - 640, 704), quay);
  const water = out(CANAL_Z, 'FWATER1', { light: 176, riser: 'STONE2', wall: 'STONE2' });
  c.paint(rect(-W + 640, -320, W - 640, 320), water);
  // stairs down to the water on both quays
  for (const x of [-6400, -4608, -2048, 1408, 4224, 6016]) {
    for (const s of [1, -1]) {
      const xx = s > 0 ? x : -x - 256;
      stairs(c, xx, s > 0 ? 160 : -320, xx + 256, s > 0 ? 320 : -160, s > 0 ? 'N' : 'S', [-64, -48, -32, -16], (z) => out(z, 'FLAT5_7', { riser: 'STEP6', light: 192 }));
    }
  }
  // bridges: the central plaza, two avenue bridges, two footbridges (point symmetric pairs)
  const deck = (x0: number, x1: number, pic: string) => {
    c.paint(rect(x0, -320, x1, 320), out(0, pic, { light: 204, riser: 'STONE3' }));
    c.paint(rect(x0, -320, x0 + 32, 320), mass(48, 'STONE3', { floorPic: 'FLAT5_7', light: 204 }));
    c.paint(rect(x1 - 32, -320, x1, 320), mass(48, 'STONE3', { floorPic: 'FLAT5_7', light: 204 }));
  };
  deck(-3776, -3392, 'FLAT5_4'); deck(3392, 3776, 'FLAT5_4');
  // footbridges (narrow, steel)
  for (const x of [-5536, 5408]) {
    c.paint(rect(x, -320, x + 128, 320), out(0, 'FLAT4', { light: 200, riser: 'METAL', fence: 'MIDBARS3' }));
  }
  // the plaza bridge (C): wide, cobbled, with an obelisk and four lamp posts
  c.paint(rect(-768, -704, 768, 704), out(0, 'FLAT5_7', { light: 208, riser: 'STONE3' }));
  c.paint(rect(-768, -704, -736, -320), mass(48, 'STONE3', { floorPic: 'FLAT5_7', light: 208 }));
  c.paint(rect(736, 320, 768, 704), mass(48, 'STONE3', { floorPic: 'FLAT5_7', light: 208 }));
  c.paint(oct(0, 0, 320, 320), out(16, 'FLOOR5_3', { light: 216, riser: 'STEP6' }));
  c.paint(oct(0, 0, 192, 192), out(32, 'FLOOR5_3', { light: 220, riser: 'STEP6' }));
  // four obelisks around the centre of the plaza
  for (const [x, y] of [[-176, -176], [144, -176], [-176, 144], [144, 144]]) c.paint(rect(x, y, x + 32, y + 32), mass(256, 'MARBLE2', { floorPic: 'FLAT5_7', light: 224 }));
  for (const [x, y] of [[-256, -256], [256, -256], [-256, 256], [256, 256]]) c.thing(x, y, T.TECHLAMP);
  c.thing(0, 128, T.MEGA); c.thing(0, -128, T.BFG); c.thing(128, 0, T.CELLPACK); c.thing(-128, 0, T.CELLPACK);
  for (const [x, y, t] of [[-640, 512, T.ROCKETL], [640, -512, T.ROCKETL], [-640, -512, T.PLASMA], [640, 512, T.PLASMA], [-512, 0, T.SHELLBOX], [512, 0, T.ROCKETBOX], [0, 512, T.GREENARMOR], [0, -512, T.GREENARMOR]] as [number, number, number][]) c.thing(x, y, t);
  // a few boats (crates) moored on the water
  for (const [x, y] of [[-6000, 96], [2600, -160], [-2600, 160], [6000, -96]]) c.paint(rect(x, y - 64, x + 256, y + 64), mass(CANAL_Z + 40, 'WOOD1', { floorPic: 'FLOOR4_1', light: 184 }));
  for (const [x, y] of [[-4900, 0], [4900, 0], [-1400, 0], [1400, 0]]) c.thing(x, y, T.SUIT);
}

// ---- A: train depot ---------------------------------------------------------------------------
function depot(c: PaintCanvas, cx: number, cy: number, R: () => number): void {
  const X = (v: number) => cx + v, Y = (v: number) => cy + v;
  c.paint(rect(X(-1632), Y(-800), X(1632), Y(800)), out(0, 'MFLR8_4', { light: 196, riser: 'STEP1' }));
  // tracks: gravel beds with steel rails, running east–west
  for (const ty of [-512, -128, 256]) {
    c.paint(rect(X(-1632), Y(ty), X(1632), Y(ty + 128)), out(0, 'FLOOR6_2', { light: 196 }));
    c.paint(rect(X(-1632), Y(ty + 24), X(1632), Y(ty + 40)), out(0, 'FLAT23', { light: 200 }));
    c.paint(rect(X(-1632), Y(ty + 88), X(1632), Y(ty + 104)), out(0, 'FLAT23', { light: 200 }));
  }
  // platform between tracks (raised 24) with a canopy shed over the middle
  c.paint(rect(X(-1408), Y(16), X(1408), Y(224)), out(24, 'FLAT1', { riser: 'AQTRIM07', light: 204 }));
  c.paint(rect(X(-1408), Y(-736), X(1408), Y(-560)), out(24, 'FLAT1', { riser: 'AQTRIM07', light: 204 }));
  // the shed: a hall over the tracks, open at both ends, roof at SKYH
  c.paint(rect(X(-640), Y(-800), X(640), Y(800)), mass(SKYH, 'BROWN1', { light: 176 }));
  c.paint(rect(X(-640), Y(-768), X(640), Y(768)), room(0, 256, 'FLOOR6_2', 'CEIL3_5', 160, { upper: 'BROWN1' }));
  for (const ty of [-512, -128, 256]) {
    c.paint(rect(X(-640), Y(ty + 24), X(640), Y(ty + 40)), room(0, 256, 'FLAT23', 'CEIL3_5', 164, { upper: 'BROWN1' }));
    c.paint(rect(X(-640), Y(ty + 88), X(640), Y(ty + 104)), room(0, 256, 'FLAT23', 'CEIL3_5', 164, { upper: 'BROWN1' }));
  }
  c.paint(rect(X(-640), Y(16), X(640), Y(224)), room(24, 256, 'FLAT1', 'CEIL3_5', 168, { riser: 'AQTRIM07', upper: 'BROWN1' }));
  c.paint(rect(X(-640), Y(-736), X(640), Y(-560)), room(24, 256, 'FLAT1', 'CEIL3_5', 168, { riser: 'AQTRIM07', upper: 'BROWN1' }));
  for (let x = -512; x <= 448; x += 320) c.paint(rect(X(x), Y(-32), X(x + 64), Y(32)), { ...room(0, 256, 'FLOOR6_2', 'TLITE6_6', 192, { upper: 'BROWN1' }) });
  for (let x = -448; x <= 448; x += 448) for (const y of [-640, 640]) c.paint(rect(X(x), Y(y), X(x + 32), Y(y + 32)), solid('SUPPORT3'));
  // wagons on the tracks (long crates)
  for (const [x, ty, len] of [[-1504, -512, 448], [896, -512, 384], [-1200, 256, 384], [-384, -128, 320], [1104, 256, 448]] as [number, number, number][]) {
    c.paint(rect(X(x), Y(ty + 8), X(x + len), Y(ty + 120)), mass(72, len > 400 ? 'CRATWIDE' : 'CRATE2', { floorPic: 'CRATOP1', light: 188 }));
  }
  c.thing(cx, cy, T.ROCKETL); c.thing(cx + 64, cy - 64, T.ROCKETBOX); c.thing(cx - 64, cy - 64, T.ROCKET);
  c.thing(cx - 1000, cy + 128, T.CHAINGUN); c.thing(cx + 1000, cy + 128, T.SSG); c.thing(cx - 160, cy - 650, T.MEDI); c.thing(cx + 160, cy - 650, T.GREENARMOR);
  c.thing(cx - 1200, cy - 650, T.SHELLBOX); c.thing(cx + 1200, cy - 650, T.BULLETS);
  for (const [x, y] of [[-1500, 700], [1500, 700], [-1500, -720], [1500, -720]]) c.thing(cx + x, cy + y, T.TECHLAMP2);
}

// ---- B: park with fountain ----------------------------------------------------------------------
function park(c: PaintCanvas, cx: number, cy: number, R: () => number): void {
  c.paint(chamfer(cx - 1632, cy - 800, cx + 1632, cy + 800, 128), out(8, 'GRASS1', { light: 204, riser: 'STEP1' }));
  // paths
  c.paint(rect(cx - 1632, cy - 64, cx + 1632, cy + 64), out(8, 'FLAT10', { light: 204 }));
  c.paint(rect(cx - 64, cy - 800, cx + 64, cy + 800), out(8, 'FLAT10', { light: 204 }));
  // fountain: rim, water, statue
  c.paint(oct(cx, cy, 352, 352), out(8, 'FLAT5_7', { light: 212 }));
  c.paint(oct(cx, cy, 256, 256), mass(32, 'MARBLE1', { floorPic: 'FLAT5_7', light: 212 }));
  c.paint(oct(cx, cy, 224, 224), out(16, 'FWATER1', { light: 208, riser: 'MARBLE1' }));
  // the statue stands on an island in the basin (the centre stays open for the capture)
  c.paint(oct(cx, cy, 96, 96), out(24, 'FLAT5_7', { riser: 'MARBLE1', light: 220 }));
  c.thing(cx, cy + 48, T.COL_GREEN);
  // hedges (leafy walls) framing the lawns, with gaps
  const hedge = mass(56, 'A-CAMO1', { floorPic: 'GRASS1', light: 196 });
  for (const [x0, y0, x1, y1] of [[-1408, 256, -704, 320], [-576, 256, -192, 320], [192, 256, 576, 320], [704, 256, 1408, 320], [-1408, -320, -704, -256], [-576, -320, -192, -256], [192, -320, 576, -256], [704, -320, 1408, -256], [-1024, 448, -960, 704], [960, -704, 1024, -448]]) c.paint(rect(cx + x0, cy + y0, cx + x1, cy + y1), hedge);
  // a bandstand (raised, with columns) east of the fountain
  c.paint(oct(cx + 1152, cy + 512, 160, 160), out(32, 'FLOOR4_1', { light: 208, riser: 'WOOD1' }));
  stairs(c, cx + 1088, cy + 288, cx + 1216, cy + 352, 'N', [20], () => out(20, 'FLOOR4_1', { riser: 'WOOD1', light: 208 }));
  for (const [x, y] of [[-96, -96], [64, -96], [-96, 64], [64, 64]]) c.paint(rect(cx + 1152 + x, cy + 512 + y, cx + 1152 + x + 32, cy + 512 + y + 32), solid('WOOD1'));
  // trees
  for (let i = 0; i < 40; i++) {
    const x = Math.round((R() * 2 - 1) * 1500), y = Math.round((R() * 2 - 1) * 720);
    if (Math.abs(x) < 420 && Math.abs(y) < 420) continue;
    if (Math.abs(x) < 100 || Math.abs(y) < 100) continue;
    const st = c.at(cx + x, cy + y) as Style;
    if ((st as unknown as Solid).solid || st.floor !== 8 || st.floorPic !== 'GRASS1') continue;
    c.thing(cx + x, cy + y, R() < 0.6 ? T.TREE_BIG : T.TREE_BURNT);
  }
  c.thing(cx + 1152, cy + 512, T.PLASMA); c.thing(cx + 1216, cy + 512, T.CELL);
  c.thing(cx - 1300, cy, T.SSG); c.thing(cx + 1300, cy, T.CHAINGUN); c.thing(cx, cy + 600, T.MEDI); c.thing(cx, cy - 600, T.SHELLBOX);
  c.thing(cx - 300, cy + 400, T.STIM); c.thing(cx + 300, cy - 400, T.BULLETS); c.thing(cx, cy - 400, T.BLUEARMOR);
  for (const [x, y] of [[-400, 400], [400, -400], [-400, -400], [400, 400]]) c.thing(cx + x, cy + y, T.FLOORLAMP);
}

// ---- D: church ruin ------------------------------------------------------------------------------
function church(c: PaintCanvas, cx: number, cy: number, R: () => number): void {
  c.paint(chamfer(cx - 1632, cy - 800, cx + 1632, cy + 800, 128), out(8, 'FLOOR6_2', { light: 196, riser: 'STEP1' }));
  // cruciform shell: nave (east–west) and transept, walls 48 thick, 288 high, open roof
  const wall = mass(288, 'STONE3', { floorPic: 'FLAT5_7', light: 188 });
  c.paint(rect(cx - 1152, cy - 320, cx + 1024, cy + 320), wall);
  c.paint(rect(cx + 128, cy - 704, cx + 640, cy + 704), wall);
  const floor = out(16, 'FLAT5_7', { light: 180, riser: 'STONE3' });
  c.paint(rect(cx - 1104, cy - 272, cx + 976, cy + 272), floor);
  c.paint(rect(cx + 176, cy - 656, cx + 592, cy + 656), floor);
  // aisle columns
  for (let x = -960; x <= -64; x += 224) for (const y of [-160, 128]) c.paint(rect(cx + x, cy + y, cx + x + 32, cy + y + 32), solid('MARBLE1'));
  // the west door (main) and breaches
  c.paint(rect(cx - 1152, cy - 96, cx - 1104, cy + 96), out(16, 'FLAT5_7', { light: 188, riser: 'STONE3' }));
  for (const [a, b, d, e] of [[cx - 640, cy + 272, cx - 448, cy + 320], [cx - 320, cy - 320, cx - 160, cy - 272], [cx + 256, cy + 656, cx + 448, cy + 704], [cx + 304, cy - 704, cx + 464, cy - 656], [cx + 976, cy - 64, cx + 1024, cy + 96], [cx + 640, cy + 272, cx + 688, cy + 320]]) c.paint(rect(a, b, d, e), out(16, 'FLAT5_7', { light: 188, riser: 'STONE3' }));
  // lowered (collapsed) wall stretches
  c.paint(rect(cx - 800, cy - 320, cx - 512, cy - 272), mass(72, 'STONE3', { light: 188 }));
  c.paint(rect(cx + 592, cy + 320, cx + 640, cy + 560), mass(88, 'STONE3', { light: 188 }));
  // chancel: raised apse at the east end with the altar
  c.paint(rect(cx + 720, cy - 208, cx + 976, cy + 208), out(40, 'FLOOR5_3', { light: 196, riser: 'STEP6' }));
  stairs(c, cx + 656, cy - 128, cx + 720, cy + 128, 'E', [28], () => out(28, 'FLOOR5_3', { riser: 'STEP6', light: 192 }));
  c.paint(rect(cx + 848, cy - 64, cx + 912, cy + 64), mass(80, 'MARBLE2', { floorPic: 'FLAT5_7', light: 210 }));
  // bell tower at the west front (roof at SKYH)
  c.paint(rect(cx - 1408, cy + 192, cx - 1152, cy + 448), mass(SKYH, 'STONE3', { floorPic: 'FLAT1', light: 184 }));
  c.paint(rect(cx - 1408, cy - 448, cx - 1152, cy - 192), mass(SKYH, 'STONE3', { floorPic: 'FLAT1', light: 184 }));
  // rubble in the nave
  for (const [x, y] of [[-700, 0], [-300, -120], [400, 450], [380, -500]]) c.paint(blob(cx + x, cy + y, 72, 56, R), out(40, 'FLAT5_7', { riser: 'STONE3', light: 184 }));
  c.thing(cx + 384, cy, T.SSG); c.thing(cx + 448, cy, T.SHELLBOX); c.thing(cx + 880, cy + 128, T.SOUL);
  c.thing(cx - 900, cy, T.CHAINGUN); c.thing(cx + 384, cy + 500, T.ROCKETL); c.thing(cx + 384, cy - 400, T.MEDI); c.thing(cx - 200, cy + 200, T.BULLETS);
  for (const [x, y] of [[820, -160], [820, 160], [-1050, -200], [-1050, 200]]) c.thing(cx + x, cy + y, T.CANDELABRA);
  for (const [x, y] of [[-1400, 600], [1400, -600], [1300, 600], [-1300, -650], [0, 760], [-600, -720]]) c.thing(cx + x, cy + y, T.TREE_BURNT);
}

// ---- E: office court -------------------------------------------------------------------------------
function offices(c: PaintCanvas, cx: number, cy: number, R: () => number): void {
  c.paint(chamfer(cx - 1632, cy - 800, cx + 1632, cy + 800, 128), out(8, 'FLAT1', { light: 196, riser: 'STEP1' }));
  // U-shaped block (open to the south), roof at SKYH; facade of steel and glass
  const face = 'STARGR2';
  c.paint(rect(cx - 1472, cy - 160, cx + 1472, cy + 736), mass(SKYH, face, { light: 184 }));
  // the court (sky) cut out of the U
  c.paint(rect(cx - 704, cy - 160, cx + 704, cy + 384), out(8, 'FLOOR0_3', { light: 204, riser: 'STEP1' }));
  // lobbies in both wings (interiors with doors to the court and to the street)
  for (const s of [-1, 1]) {
    const x0 = s < 0 ? cx - 1408 : cx + 768, x1 = s < 0 ? cx - 768 : cx + 1408;
    c.paint(rect(x0, cy - 96, x1, cy + 672), room(8, 160, 'FLOOR0_3', 'CEIL3_4', 168, { upper: face, wall: 'PANEL5' }));
    // door to the court
    c.paint(rect(s < 0 ? cx - 768 : cx + 704, cy + 64, s < 0 ? cx - 704 : cx + 768, cy + 256), room(8, 128, 'FLOOR0_3', 'CEIL3_4', 176, { upper: face }));
    // door to the street (south) and outer side
    c.paint(rect(x0 + 192, cy - 160, x0 + 384, cy - 96), room(8, 128, 'FLOOR0_3', 'CEIL3_4', 176, { upper: face }));
    c.paint(rect(s < 0 ? cx - 1472 : cx + 1408, cy + 192, s < 0 ? cx - 1408 : cx + 1472, cy + 384), room(8, 128, 'FLOOR0_3', 'CEIL3_4', 176, { upper: face }));
    // reception desks and columns
    c.paint(rect(x0 + 192, cy + 448, x1 - 192, cy + 496), mass(48, 'WOOD12', { floorPic: 'FLAT5_1', light: 168 }));
    for (const y of [96, 320]) c.paint(rect(x0 + 288, cy + y, x0 + 320, cy + y + 32), solid('SUPPORT2'));
    c.thing(Math.round((x0 + x1) / 2), cy + 300, s < 0 ? T.PLASMA : T.CHAINGUN);
    c.thing(Math.round((x0 + x1) / 2) + 64, cy + 300, s < 0 ? T.CELL : T.BULLETS);
  }
  // court: planters and a sculpture
  for (const [x, y] of [[-512, 192], [384, 192], [-512, -64], [384, -64]]) c.paint(rect(cx + x, cy + y, cx + x + 128, cy + y + 64), mass(40, 'BRICK10', { floorPic: 'GRASS1', light: 204 }));
  c.paint(oct(cx, cy + 96, 64, 64), mass(96, 'MARBLE2', { floorPic: 'FLAT1', light: 220 }));
  c.thing(cx, cy - 64, T.ROCKETL); c.thing(cx + 64, cy - 64, T.ROCKET); c.thing(cx, cy + 260, T.GREENARMOR);
  c.thing(cx - 1200, cy - 500, T.SHOTGUN); c.thing(cx + 1200, cy - 500, T.SSG); c.thing(cx, cy - 600, T.MEDI);
  for (const [x, y] of [[-640, -100], [640, -100], [-640, 320], [640, 320]]) c.thing(cx + x, cy + y, T.TECHLAMP2);
}
