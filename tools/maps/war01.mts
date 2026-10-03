// WAR01 "Nukage Front" — 100 vs 100 conquest map (20480 × 12288 units).
//
// Red base in the west, blue base in the east, a nukage river running north–south down
// the middle. Five capture points:
//   A  Tech bunker      (-4608,  3328)  sunken concrete complex, red's forward point
//   B  Nukage bridge    (    0,  4096)  stone bridge over the river, north
//   C  Fort             (    0,     0)  ruined stone fort ringed by a nukage moat, centre
//   D  Hilltop tower    (    0, -3840)  terraced hill with a watchtower, south; the river's spring
//   E  Industrial yard  ( 4608, -3328)  containers, sheds, catwalks, blue's forward point
// The layout is point-symmetric for fairness (bases, lanes, ridges, item spots); the
// landmarks themselves differ. Three lanes leave each base (north / centre / south),
// separated by rock ridges with passes. Everything is walkable with steps ≤ 24.
import { PaintCanvas, rect, chamfer, oct, poly, diamond, type Paint, type Pt, type Shape, type Style, type Solid } from './lib/canvas.mts';
import { T, stairs, lighten, withProps, raise, rng, blob } from './lib/kit.mts';
import { SKYH, out, room, mass, solid } from './lib/styles.mts';
import { teamBase } from './lib/base.mts';
import { ident, mirrorX } from './lib/xf.mts';

export const NAME = 'WAR01';
export const TITLE = 'War: Nukage Front';

const RIVER_Z = -96;            // river bed
const W = 10240, H = 6144;      // half extents

export function build(): PaintCanvas {
  const c = new PaintCanvas(-W, -H, W, H, 8, solid('ROCK4'));
  const R = rng(1977);
  const P = (x: number, y: number): Pt => [x, y];
  // point symmetry (x, y) → (-x, -y) for fairness
  const both = (f: (sx: number) => void) => { f(1); f(-1); };
  const rs = (s: number, x0: number, y0: number, x1: number, y1: number) => rect(s * x0, s * y0, s * x1, s * y1);
  const ps = (s: number, pts: Pt[]) => poly(pts.map(([x, y]) => [s * x, s * y] as Pt));

  // ==== 1. land, perimeter ridges ======================================================
  c.paint(chamfer(-W + 128, -H + 128, W - 128, H - 128, 1024), out(0, 'GRASS2'));
  // ridges: jagged blocks along the edges, 192..448 high, with a foothill step in front
  const ridgeTop = ['RROCK09', 'MFLR8_3', 'FLAT1_2'];
  const edgeBlocks = (horizontal: boolean, fixed: number, dir: number, from: number, to: number) => {
    let p = from;
    while (p < to) {
      const len = 256 + Math.floor(R() * 6) * 128;
      const depth = 384 + Math.floor(R() * 4) * 64;
      const h = 192 + Math.floor(R() * 5) * 64;
      const q = Math.min(to, p + len);
      const a = fixed, b = fixed - dir * depth;
      // the perimeter keeps a low sky (top + 8): its sky "wall" is the horizon
      const top = mass(h, R() < 0.5 ? 'ROCK4' : 'ROCK5', { floorPic: ridgeTop[Math.floor(R() * 3)], light: 176, ceil: h + 8 });
      // chamfered inner corners so the skyline reads as rock, not boxes
      const k = 64 + Math.floor(R() * 3) * 32;
      if (horizontal) c.paint(chamfer(p, a + dir * 512, q, b, k), top); else c.paint(chamfer(a + dir * 512, p, b, q, k), top);
      // foothill
      const fd = 64 + Math.floor(R() * 3) * 32;
      const foot = out(24 + Math.floor(R() * 2) * 16, 'FLOOR6_2', { light: 192 });
      if (R() < 0.6) {
        const p2 = p + 64, q2 = q - 64;
        if (q2 > p2) { if (horizontal) c.paint(rect(p2, b, q2, b - dir * fd), foot); else c.paint(rect(b, p2, b - dir * fd, q2), foot); }
      }
      p = q;
    }
  };
  edgeBlocks(true, H - 128, 1, -W + 128, W - 128);
  edgeBlocks(true, -H + 128, -1, -W + 128, W - 128);
  edgeBlocks(false, W - 128, 1, -H + 128, H - 128);
  edgeBlocks(false, -W + 128, -1, -H + 128, H - 128);

  // ==== 2. ground variation & roads ====================================================
  // grass patches, gravel and dirt
  for (let i = 0; i < 70; i++) {
    const x = Math.round((R() * 2 - 1) * (W - 1200) / 16) * 16, y = Math.round((R() * 2 - 1) * (H - 1200) / 16) * 16;
    c.modify(blob(x, y, 256 + R() * 512, 192 + R() * 384, R), withProps({ floorPic: R() < 0.5 ? 'GRASS1' : 'FLOOR7_2' }));
  }
  both((s) => {
    // roads: centre lane, north lane and south lane from the base gates (dirt)
    const road = withProps({ floorPic: 'FLAT10' });
    c.modify(rs(s, 1152, -128, 7424, 128), road);                  // centre: fort causeway → base west gate
    c.modify(ps(s, [[7424, 1792], [7424, 2048], [6144, 2048], [5120, 3072], [1024, 3072], [1024, 2816], [5024, 2816], [6048, 1792]]), road); // north-ish lane (blue: village side)
    c.modify(ps(s, [[7424, -1792], [7424, -2048], [6144, -2048], [5120, -3072], [1024, -3072], [1024, -2816], [5024, -2816], [6048, -1792]]), road);
  });

  // ==== 3. lane ridges (sight blockers with passes) =====================================
  both((s) => {
    // a ridge: a low rock skirt along the outline, then a chain of craggy blobs on top
    const ridge = (pts: Pt[], h: number) => {
      c.paint(ps(s, pts), mass(56, 'ROCK5', { floorPic: 'RROCK09', light: 184 }));
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const x0 = Math.min(...xs) + 160, x1 = Math.max(...xs) - 160, ym = (Math.min(...ys) + Math.max(...ys)) / 2;
      const half = (Math.max(...ys) - Math.min(...ys)) / 2;
      for (let x = x0; x <= x1; x += 192 + Math.floor(R() * 3) * 32) {
        const hh = h - 64 + Math.floor(R() * 5) * 24;
        c.paint(blob(s * x, s * (ym + (R() - 0.5) * half * 0.4), 112 + R() * 96, half * (0.45 + R() * 0.25), R), mass(hh, R() < 0.5 ? 'ROCK5' : 'ROCK4', { floorPic: 'RROCK09', light: 176 + Math.floor(R() * 3) * 8 }));
      }
    };
    // between centre and north lanes, blue half: two long rocks with a pass at x≈4200
    ridge([[1536, 1408], [3328, 1408], [3584, 1664], [3584, 1792], [3328, 2048], [1792, 2048], [1536, 1792]], 192);
    ridge([[4864, 1280], [6272, 1280], [6528, 1536], [6272, 1792], [5120, 1792], [4864, 1536]], 160);
    // between centre and south lanes
    ridge([[1536, -1408], [3328, -1408], [3584, -1664], [3584, -1792], [3328, -2048], [1792, -2048], [1536, -1792]], 192);
    ridge([[4864, -1280], [6272, -1280], [6528, -1536], [6272, -1792], [5120, -1792], [4864, -1536]], 160);
    // terraced foothills against the ridges (walkable lookouts)
    c.paint(chamfer(s * 3712, s * 1856, s * 4608, s * 2304, 128), out(24, 'GRASS1'));
    c.paint(chamfer(s * 3840, s * 1920, s * 4480, s * 2240, 96), out(48, 'GRASS1'));
    c.paint(chamfer(s * 3712, -s * 1856, s * 4608, -s * 2304, 128), out(24, 'GRASS1'));
    c.paint(chamfer(s * 3840, -s * 1920, s * 4480, -s * 2240, 96), out(48, 'GRASS1'));
    // low hills in the centre lane fields (cover, height variety)
    const hill = (x: number, y: number, r: number, levels: number) => {
      for (let k = 0; k < levels; k++) c.modify(oct(s * x, s * y, r - k * 96, Math.round((r - k * 96) * 0.7 / 8) * 8), raise(16, { floorPic: k === levels - 1 ? 'GRASS1' : 'GRASS2', riser: 'A-MOSROK' }));
    };
    hill(2560, 704, 512, 3);
    hill(5632, -640, 448, 3);
    hill(6528, 768, 320, 2);
    // rock outcrops (cover)
    for (const [x, y, rx, ry] of [[2048, -768, 96, 64], [3072, 512, 64, 128], [3968, -384, 128, 80], [4608, 896, 80, 80], [5888, 256, 96, 64], [6656, -1024, 64, 96], [1664, 1024, 64, 64], [3456, -1024, 96, 64]]) {
      c.paint(blob(s * x, s * y, rx, ry, R), mass(64 + Math.floor(R() * 3) * 32, 'ROCK5', { floorPic: 'RROCK09', light: 200 }));
    }
  });

  // ==== 4. bases ======================================================================
  const points: { x: number; y: number; r: number }[] = [];
  teamBase(c, true, ident);
  teamBase(c, false, mirrorX);

  // ==== 5. A: tech bunker (red side, north) =============================================
  bunker(c, -4608, 3584);
  points.push({ x: -4608, y: 3584, r: 320 });
  // ==== 6. E: industrial yard (blue side, south) ========================================
  yard(c, 4608, -3584, R);
  // ==== 7. woods (red south) and ruined village (blue north) =============================
  woods(c, -4608, -3328, R);
  village(c, 4608, 3328, R);
  // ==== 8. D: hill with the tower (south centre) =========================================
  hillTower(c, 0, -3840);
  // ==== 9. river, fort (C), bridge (B), catwalk ==========================================
  river(c);
  fort(c);
  bridge(c, 0, 4096);
  points.push({ x: 0, y: 4096, r: 320 }, { x: 0, y: 0, r: 384 }, { x: 0, y: -3840, r: 384 }, { x: 4608, y: -3584, r: 352 });
  for (const p of points) c.thing(p.x, p.y, T.POINT, p.r / 8);

  // ==== 10. items in the field ==========================================================
  both((s) => {
    const it = (x: number, y: number, t: number) => c.thing(s * x, s * y, t);
    // centre lane caches
    for (const [x, y] of [[2560, 704], [5632, -640]]) { it(x, y, T.CHAINGUN); it(x + 64, y, T.BULLETS); it(x - 64, y, T.MEDI); it(x, y + 64, T.SHELLBOX); }
    for (const [x, y] of [[3328, 0], [4864, 256], [6400, -256], [1792, -384]]) { it(x, y, T.STIM); it(x + 48, y, T.CLIP); it(x - 48, y, T.SHELLS); it(x, y - 48, T.HBONUS); it(x, y + 48, T.ABONUS); }
    it(4096, 0, T.SHOTGUN); it(4160, 0, T.SHELLS);
    it(2304, -1152, T.ROCKETL); it(2368, -1152, T.ROCKET); it(2240, -1152, T.ROCKET);
    it(4096, 2112, T.GREENARMOR); it(4160, 2112, T.SHELLBOX); it(4032, 2112, T.MEDI);
    it(4096, -2112, T.SSG); it(4160, -2112, T.SHELLBOX); it(4032, -2112, T.MEDI);
    // lane roads
    for (const x of [1536, 2560, 3584, 4608]) { it(x, 2944, x % 2048 ? T.CLIP : T.SHELLS); it(x, -2944, x % 2048 ? T.STIM : T.ROCKET); }
    it(6912, 1408, T.BACKPACK); it(6912, -1408, T.BACKPACK);
  });
  // ==== 11. field dressing: trees, boulders and light pools ===============================
  const plain = (x: number, y: number) => {
    const st = c.at(x, y) as Style;
    if ((st as unknown as Solid).solid || st.floor !== 0 || !/^(GRASS|FLOOR7_2)/.test(st.floorPic)) return false;
    for (const [dx, dy] of [[96, 0], [-96, 0], [0, 96], [0, -96]]) { const n = c.at(x + dx, y + dy) as Style; if ((n as unknown as Solid).solid || n.floor !== 0) return false; }
    return true;
  };
  const near = (x: number, y: number, r: number) => c.things.some((t) => Math.abs(t.x - x) < r && Math.abs(t.y - y) < r);
  both((s) => {
    let placed = 0;
    for (let i = 0; i < 400 && placed < 70; i++) {
      const x = Math.round((900 + R() * 6200) / 8) * 8, y = Math.round((R() * 2 - 1) * 5000 / 8) * 8;
      if (Math.abs(y) < 256 || !plain(s * x, s * y) || near(s * x, s * y, 160)) continue;
      c.thing(s * x, s * y, R() < 0.5 ? T.TREE_BIG : R() < 0.7 ? T.TREE_BURNT : T.STUMP);
      placed++;
    }
    for (let i = 0, n = 0; i < 300 && n < 14; i++) {
      const x = Math.round((1200 + R() * 5600) / 16) * 16, y = Math.round((R() * 2 - 1) * 4800 / 16) * 16;
      if (Math.abs(y) < 320 || !plain(s * x, s * y) || near(s * x, s * y, 200)) continue;
      c.paint(blob(s * x, s * y, 48 + R() * 64, 40 + R() * 48, R), mass(32 + Math.floor(R() * 3) * 24, 'ROCK5', { floorPic: 'RROCK09', light: 200 }));
      n++;
    }
  });
  // light pools under lamps and torches (Doom-style: a brighter octagon around the source)
  const LAMPS = new Set<number>([T.TECHLAMP, T.TECHLAMP2, T.FLOORLAMP, T.TORCH_RED, T.TORCH_BLUE, T.TORCH_GREEN, T.STORCH_RED, T.STORCH_BLUE, T.STORCH_GREEN, T.CANDELABRA, T.BURNBARREL]);
  for (const t of [...c.things]) {
    if (!LAMPS.has(t.type)) continue;
    const x = Math.round(t.x / 8) * 8, y = Math.round(t.y / 8) * 8;
    c.modify(oct(x, y, 128, 128), lighten(24));
  }
  return c;
}

// ---- A: tech bunker ---------------------------------------------------------------------------
function bunker(c: PaintCanvas, cx: number, cy: number): void {
  const R0 = (x0: number, y0: number, x1: number, y1: number) => rect(cx + x0, cy + y0, cx + x1, cy + y1);
  const th = (x: number, y: number, t: number, a = 0) => c.thing(cx + x, cy + y, t, a);
  // concrete apron around the blockhouse
  c.paint(chamfer(cx - 1152, cy - 896, cx + 1152, cy + 896, 256), out(0, 'FLOOR6_2', { light: 200 }));
  // blockhouse: a tall concrete command block (roof at SKYH, so the walls above its doors
  // are its own facade), with steel pilasters along the long sides
  const block = mass(SKYH, 'CEMENT3', { floorPic: 'FLAT1', light: 176 });
  c.paint(chamfer(cx - 832, cy - 576, cx + 832, cy + 576, 128), block);
  for (let x = -640; x <= 608; x += 256) {
    if (Math.abs(x + 16 - -352) < 160 || Math.abs(x + 16 - 352) < 160) continue; // keep the south doors clear
    c.paint(R0(x, -592, x + 32, -576), mass(SKYH, 'SUPPORT3'));
    c.paint(R0(x, 576, x + 32, 592), mass(SKYH, 'SUPPORT3'));
  }
  // interior ring (inner face) and the main hall, sunk to -64
  c.paint(chamfer(cx - 768, cy - 512, cx + 768, cy + 512, 96), mass(SKYH, 'TEKWALL4', { floorPic: 'FLAT1' }));
  const hall = room(-64, 128, 'FLOOR0_6', 'CEIL5_1', 144, { riser: 'STEP2', upper: 'SUPPORT3' });
  c.paint(chamfer(cx - 704, cy - 448, cx + 704, cy + 448, 64), hall);
  // computer banks along the north and south walls (inner ring segments)
  for (let x = -576; x <= 448; x += 256) c.paint(R0(x, 448, x + 128, 512), mass(SKYH, x % 512 ? 'COMPSTA1' : 'COMPSTA2'));
  for (let x = -576; x <= 448; x += 256) if (Math.abs(x + 64 - -352) > 128 && Math.abs(x + 64 - 352) > 128) c.paint(R0(x, -512, x + 128, -448), mass(SKYH, 'COMPTALL'));
  // pillars
  for (const [x, y] of [[-320, -192], [-320, 128], [256, -192], [256, 128]]) c.paint(R0(x, y, x + 64, y + 64), { solid: true, wall: 'SUPPORT3' });
  // central raised console island with glowing floor (the capture point)
  c.paint(R0(-192, -128, 192, 128), { ...hall, floor: -48, floorPic: 'CONS1_5', light: 176, ceilPic: 'CEIL4_2' });
  c.paint(R0(-128, -64, 128, 64), { ...hall, floor: -40, floorPic: 'GRNLITE1', light: 208, special: 8, ceilPic: 'CEIL4_2' });
  // ceiling lights (pulsing) over the floor, darker corners
  for (const [x, y] of [[-512, -320], [-512, 256], [448, -320], [448, 256], [-64, -384], [-64, 320]]) c.paint(R0(x, y, x + 64, y + 64), { ...hall, ceilPic: 'TLITE6_5', light: 192, special: 8 });
  c.modify(R0(-704, -448, -576, -320), lighten(-32));
  c.modify(R0(576, 320, 704, 448), lighten(-32));
  // entrances: west, east and two south ramps down into the hall, through the walls
  const ramp = (x0: number, y0: number, x1: number, y1: number, dir: 'N' | 'S' | 'E' | 'W', light = 160) =>
    stairs(c, cx + x0, cy + y0, cx + x1, cy + y1, dir, [-48, -32, -16], (z) => room(z, 128, 'FLOOR0_6', 'FLAT18', light, { riser: 'STEP2', upper: 'CEMENT3' }));
  ramp(-832, -128, -704, 128, 'W');
  ramp(704, -128, 832, 128, 'E');
  ramp(-448, -576, -256, -448, 'S');
  ramp(256, -576, 448, -448, 'S');
  // door frames: steel tracks on both sides of each doorway
  for (const [x0, y0, x1, y1] of [[-832, 128, -816, 144], [-832, -144, -816, -128], [816, 128, 832, 144], [816, -144, 832, -128], [-464, -576, -448, -560], [-256, -576, -240, -560], [240, -576, 256, -560], [448, -576, 464, -560]]) c.paint(R0(x0, y0, x1, y1), mass(SKYH, 'DOORTRAK'));
  // side room north: server room (through a gap in the inner ring)
  c.paint(R0(-128, 448, 128, 576), room(-64, 96, 'FLOOR0_6', 'CEIL5_1', 128, { upper: 'SUPPORT3' }));
  c.paint(R0(-320, 576, 320, 832), mass(192, 'CEMENT3', { floorPic: 'FLAT1', light: 176 }));
  c.paint(R0(-256, 576, 256, 768), room(-64, 96, 'FLOOR0_6', 'CEIL4_2', 136, { wall: 'COMPWERD' }));
  c.paint(R0(-224, 704, 224, 768), { solid: true, wall: 'COMPSTA2' });
  // things
  th(0, 0, T.PLASMA); th(-96, 0, T.CELL); th(96, 0, T.CELL);
  th(-448, 0, T.SSG); th(448, 0, T.CHAINGUN); th(-448, 64, T.SHELLS); th(448, 64, T.BULLETS);
  th(0, 640, T.BLUEARMOR); th(-160, 640, T.CELLPACK); th(160, 640, T.MEDI);
  th(-608, -352, T.MEDI); th(608, 352, T.MEDI); th(-608, 352, T.SHELLBOX); th(608, -352, T.ROCKET);
  for (const [x, y] of [[-640, 384], [640, -384], [-640, -384], [640, 384]]) th(x, y, T.TECHCOL);
  // outside: lamps, barrels, sandbags at the entrances
  for (const [x, y] of [[-960, 320], [-960, -320], [960, 320], [960, -320], [-512, -704], [512, -704]]) th(x, y, T.TECHLAMP);
  for (const [x, y] of [[-1024, 704], [1024, 704], [-1024, -704], [1088, -640]]) th(x, y, T.BARREL);
  const sand = mass(40, 'CEMENT7', { floorPic: 'FLAT1', light: 200 });
  c.paint(R0(-1088, -320, -1024, 320), sand);
  c.paint(R0(1024, -320, 1088, 320), sand);
  c.paint(R0(-128, -832, 128, -768), sand);
  th(-1120, 0, T.ROCKETL); th(1120, 0, T.SHOTGUN); th(0, -864, T.SSG);
  th(-1120, 128, T.ROCKET); th(1120, 128, T.SHELLS); th(0, -928, T.STIM);
}

// ---- E: industrial yard -------------------------------------------------------------------
function yard(c: PaintCanvas, cx: number, cy: number, R: () => number): void {
  const R0 = (x0: number, y0: number, x1: number, y1: number) => rect(cx + x0, cy + y0, cx + x1, cy + y1);
  const th = (x: number, y: number, t: number, a = 0) => c.thing(cx + x, cy + y, t, a);
  // yard floor and the low perimeter wall (with wide openings)
  const ground = out(0, 'FLAT5_4', { light: 200, wall: 'CEMENT7' });
  c.paint(chamfer(cx - 1152, cy - 896, cx + 1152, cy + 896, 192), mass(96, 'CEMENT7', { floorPic: 'FLAT1', light: 184 }));
  c.paint(chamfer(cx - 1088, cy - 832, cx + 1088, cy + 832, 160), ground);
  for (const [x0, y0, x1, y1] of [[-1152, -192, -1088, 192], [1088, -192, 1152, 192], [-384, 832, 128, 896], [-128, -896, 384, -832], [-1024, 704, -768, 896], [768, -896, 1024, -704]]) c.paint(R0(x0, y0, x1, y1), ground);
  // warehouse sheds: north-east and south-west, open on the yard side
  const shed = (x0: number, y0: number, x1: number, y1: number, openSide: 'N' | 'S') => {
    c.paint(R0(x0, y0, x1, y1), mass(SKYH, 'STARTAN3', { floorPic: 'FLAT1', light: 176 }));
    c.paint(R0(x0 + 32, y0 + 32, x1 - 32, y1 - 32), room(0, 192, 'FLOOR4_8', 'CEIL3_5', 136, { upper: 'STARTAN3' }));
    // the open side: support columns and wide gaps
    const yy = openSide === 'S' ? y0 : y1 - 32;
    c.paint(R0(x0 + 32, yy, x1 - 32, yy + 32), room(0, 192, 'FLOOR4_8', 'CEIL3_5', 160, { upper: 'STARTAN3' }));
    for (let x = x0 + 32 + 224; x < x1 - 64; x += 256) c.paint(R0(x, yy, x + 32, yy + 32), { solid: true, wall: 'SUPPORT3' });
    for (let x = x0 + 128; x < x1 - 96; x += 256) c.paint(R0(x, y0 + 96, x + 64, y1 - 96), { ...room(0, 192, 'FLOOR4_8', 'TLITE6_6', 176), upper: 'STARTAN3' });
  };
  shed(128, 320, 960, 768, 'S');
  shed(-960, -768, -128, -320, 'N');
  // containers (stacks) as cover: two heights
  const cont = (x0: number, y0: number, w: number, d: number, h: number, tex: string) => c.paint(R0(x0, y0, x0 + w, y0 + d), mass(h, tex, { floorPic: 'CRATOP1', light: 192 }));
  cont(-768, 128, 256, 128, 64, 'CRATE2'); cont(-768, 256, 128, 128, 112, 'CRATE3');
  cont(512, -256, 256, 128, 64, 'CRATE2'); cont(640, -384, 128, 128, 112, 'CRATE3');
  cont(-256, 384, 128, 128, 64, 'CRATE1'); cont(128, -512, 128, 128, 64, 'CRATE1');
  cont(-960, -128, 128, 256, 128, 'CRATWIDE'); cont(832, -128, 128, 256, 128, 'CRATWIDE');
  // nukage tank (sunken, railed) — west, avoidable
  c.paint(R0(-640, -224, -320, 32), mass(24, 'METAL', { floorPic: 'FLAT4', light: 192 }));
  c.paint(R0(-608, -192, -352, 0), out(-32, 'NUKAGE1', { light: 224, special: 7, riser: 'NUKEDGE1', wall: 'NUKEDGE1', fence: 'MIDBARS3' }));
  // the catwalk: raised steel walkway along the east wall reached by stairs
  c.paint(R0(896, -640, 1024, 640), out(96, 'FLAT4', { riser: 'METAL', light: 200, wall: 'METAL' }));
  stairs(c, cx + 640, cy + 512, cx + 896, cy + 640, 'E', [16, 32, 48, 64, 80], (z) => out(z, 'FLAT23', { riser: 'STEP4' }));
  stairs(c, cx + 640, cy - 640, cx + 896, cy - 512, 'E', [16, 32, 48, 64, 80], (z) => out(z, 'FLAT23', { riser: 'STEP4' }));
  // central loading platform (the capture point), with hazard trims
  c.paint(R0(-256, -192, 256, 192), out(16, 'FLOOR0_3', { riser: 'AQTRIM07', light: 216 }));
  c.paint(R0(-128, -96, 128, 96), out(16, 'FLAT2', { riser: 'AQTRIM07', light: 224 }));
  // pipes along the north wall (wall segments with pipe textures)
  c.paint(R0(-896, 832, -512, 864), mass(96, 'PIPE2'));
  c.paint(R0(256, -864, 640, -832), mass(96, 'PIPE4'));
  // things
  th(0, 0, T.ROCKETL); th(-64, 0, T.ROCKETBOX); th(64, 0, T.ROCKETBOX);
  th(960, 0, T.PLASMA); th(960, 64, T.CELL); th(960, -64, T.CELL);
  th(544, 544, T.CHAINGUN); th(-544, -544, T.SSG); th(608, 544, T.BULLETS); th(-480, -544, T.SHELLBOX);
  th(544, 416, T.MEDI); th(-544, -416, T.MEDI); th(0, 256, T.GREENARMOR); th(-736, 0, T.SUIT);
  th(-320, 640, T.SHOTGUN); th(320, -640, T.SHOTGUN);
  for (const [x, y] of [[-1024, 512], [1024, 768], [-256, -768], [256, 768], [-1024, -512]]) th(x, y, T.BARREL);
  for (const [x, y] of [[-704, 704], [704, -704], [-1024, 0], [384, 192], [-384, -192]]) th(x, y, T.FLOORLAMP);
  th(0, 704, T.BURNBARREL); th(0, -704, T.BURNBARREL);
}

// ---- red south: woods and a ruined chapel ---------------------------------------------------
function woods(c: PaintCanvas, cx: number, cy: number, R: () => number): void {
  const th = (x: number, y: number, t: number, a = 0) => c.thing(cx + x, cy + y, t, a);
  c.modify(oct(cx, cy, 1408, 1024), withProps({ floorPic: 'GRASS1', light: 176 }));
  // gentle mound
  c.modify(oct(cx + 256, cy - 128, 768, 512), raise(16, { riser: 'A-MOSROK', floorPic: 'FLOOR7_2' }));
  c.modify(oct(cx + 256, cy - 128, 512, 320), raise(16, { riser: 'A-MOSROK' }));
  // the chapel: stone shell with broken walls, wooden floor, open roof
  const x0 = cx - 768, y0 = cy + 128, x1 = cx - 128, y1 = cy + 640;
  c.paint(rect(x0, y0, x1, y1), mass(224, 'BSTONE2', { floorPic: 'FLAT1_2', light: 176 }));
  c.paint(rect(x0 + 48, y0 + 48, x1 - 48, y1 - 48), out(8, 'FLOOR4_1', { light: 160, riser: 'BSTONE2' }));
  // breaches
  for (const [a, b, d, e] of [[x0, y0 + 192, x0 + 48, y0 + 320], [x1 - 48, y0 + 160, x1, y0 + 352], [x0 + 256, y0, x0 + 384, y0 + 48], [x0 + 192, y1 - 48, x0 + 288, y1]]) c.paint(rect(a, b, d, e), out(8, 'FLAT1_2', { light: 168, riser: 'BSTONE2' }));
  // altar
  c.paint(rect(x0 + 256, y1 - 160, x0 + 384, y1 - 96), out(32, 'FLAT5_7', { riser: 'MARBLE1', light: 192 }));
  c.thing(x0 + 320, y1 - 128, T.MEGA);
  c.thing(x0 + 160, y0 + 160, T.CANDELABRA); c.thing(x1 - 160, y0 + 160, T.CANDELABRA);
  c.thing(x0 + 320, y0 + 256, T.SSG);
  // trees and stumps
  for (let i = 0; i < 70; i++) {
    const a = R() * Math.PI * 2, d = Math.sqrt(R()) * 1300;
    const x = Math.round(Math.cos(a) * d * 1.1), y = Math.round(Math.sin(a) * d * 0.75);
    if (x > -800 && x < -96 && y > 96 && y < 672) continue; // not inside the chapel
    const st = c.at(cx + x, cy + y);
    if ((st as Solid).solid) continue;
    th(x, y, R() < 0.55 ? T.TREE_BIG : R() < 0.6 ? T.TREE_BURNT : T.STUMP);
  }
  // rocks
  for (const [x, y] of [[640, 512], [-384, -512], [896, -384], [-1024, -128]]) c.paint(blob(cx + x, cy + y, 96, 64, R), mass(56 + Math.floor(R() * 2) * 24, 'ROCK5', { floorPic: 'RROCK09', light: 176 }));
  th(256, -128, T.CHAINGUN); th(320, -128, T.BULLETS); th(-512, -256, T.MEDI); th(512, 256, T.SHELLBOX); th(0, -640, T.ROCKETL); th(64, -640, T.ROCKET);
}

// ---- blue north: ruined village -----------------------------------------------------------
function village(c: PaintCanvas, cx: number, cy: number, R: () => number): void {
  const th = (x: number, y: number, t: number, a = 0) => c.thing(cx + x, cy + y, t, a);
  c.modify(oct(cx, cy, 1408, 1024), withProps({ floorPic: 'FLOOR6_2' }));
  // cobbled square
  c.paint(oct(cx, cy, 448, 384), out(0, 'FLAT5_7', { light: 208 }));
  c.paint(oct(cx, cy, 96, 96), mass(48, 'MARBLE2', { floorPic: 'FLAT5_7' }));
  c.thing(cx, cy, T.COL_GREEN);
  // houses (ruined: walls with gaps, open roofs)
  const house = (x0: number, y0: number, w: number, d: number, tex: string, gaps: [number, number, number, number][]) => {
    c.paint(rect(cx + x0, cy + y0, cx + x0 + w, cy + y0 + d), mass(160 + Math.floor(R() * 3) * 32, tex, { floorPic: 'FLAT5_1', light: 184 }));
    c.paint(rect(cx + x0 + 32, cy + y0 + 32, cx + x0 + w - 32, cy + y0 + d - 32), out(8, 'FLOOR0_1', { light: 168, riser: tex }));
    for (const [a, b, e, f] of gaps) c.paint(rect(cx + x0 + a, cy + y0 + b, cx + x0 + e, cy + y0 + f), out(8, 'FLOOR0_1', { light: 172, riser: tex }));
  };
  house(-1024, 256, 384, 320, 'BRICK7', [[0, 96, 32, 224], [160, 0, 288, 32]]);
  house(-896, -704, 448, 320, 'STUCCO1', [[448 - 32, 64, 448, 192], [96, 320 - 32, 224, 320]]);
  house(576, 384, 384, 384, 'BRICK1', [[0, 128, 32, 256], [128, 0, 256, 32], [384 - 32, 96, 384, 192]]);
  house(512, -768, 448, 320, 'WOOD1', [[0, 96, 32, 224], [192, 320 - 32, 320, 320]]);
  house(-256, 640, 320, 256, 'BRICK7', [[96, 0, 224, 32]]);
  // craters
  for (const [x, y, rr] of [[-512, -128, 192], [384, -256, 160], [-64, -640, 128], [960, -64, 160]]) {
    c.paint(oct(cx + x, cy + y, rr, rr), out(-16, 'FLOOR7_1', { riser: 'ROCK3', light: 196 }));
    c.paint(oct(cx + x, cy + y, rr - 64, rr - 64), out(-32, 'FLOOR7_1', { riser: 'ROCK3', light: 190 }));
  }
  th(0, 256, T.ROCKETL); th(64, 256, T.ROCKET); th(-832, 416, T.CHAINGUN); th(-672, -544, T.SSG); th(768, 576, T.PLASMA);
  th(736, -608, T.GREENARMOR); th(-128, 768, T.MEDI); th(-512, -128, T.SHELLBOX); th(384, -256, T.BULLETS); th(-64, -640, T.MEDI);
  for (const [x, y] of [[-384, 384], [384, 384], [-384, -384], [384, -384]]) th(x, y, T.FLOORLAMP);
  for (const [x, y] of [[-1152, -512], [1152, 640], [1088, -896], [-1216, 768], [256, 960], [-640, 896]]) th(x, y, T.TREE_BURNT);
}

// ---- D: hill with the watchtower; the river's spring at its north foot --------------------------
function hillTower(c: PaintCanvas, cx: number, cy: number): void {
  // terraces, 24 high each
  const rings = [1600, 1344, 1120, 896, 704, 544];
  rings.forEach((rr, i) => {
    const z = 24 * (i + 1);
    c.paint(oct(cx, cy, rr, Math.round(rr * 0.8 / 8) * 8), out(z, i % 2 ? 'GRASS1' : 'GRASS2', { riser: i < 3 ? 'A-MOSROK' : 'ROCK4', light: 208 + i * 4 }));
  });
  const top = 144;
  // summit paving
  c.paint(oct(cx, cy, 448, 384), out(top, 'FLAT5_7', { riser: 'STONE2', light: 224 }));
  // watchtower: 320×320 stone shell, open inside, stair up to a platform
  const tx0 = cx - 160, ty0 = cy - 160, tx1 = cx + 160, ty1 = cy + 160;
  c.paint(chamfer(tx0, ty0, tx1, ty1, 48), mass(SKYH, 'STONE3', { floorPic: 'FLAT1', light: 200 }));
  c.paint(rect(tx0 + 48, ty0 + 48, tx1 - 48, ty1 - 48), out(top, 'FLAT5_7', { light: 168, riser: 'STONE3' }));
  // doorways (N, S, E, W)
  for (const [a, b, d, e] of [[cx - 64, ty1 - 48, cx + 64, ty1], [cx - 64, ty0, cx + 64, ty0 + 48], [tx0, cy - 64, tx0 + 48, cy + 64], [tx1 - 48, cy - 64, tx1, cy + 64]]) {
    c.paint(rect(a, b, d, e), room(top, top + 128, 'FLAT5_7', 'FLAT1', 176, { upper: 'STONE3' }));
  }
  c.thing(cx, cy, T.SOUL);
  // stone balustrade posts around the summit and lamps
  for (const [x, y] of [[-384, -320], [384, -320], [-384, 320], [384, 320]]) {
    c.paint(rect(cx + x - 32, cy + y - 32, cx + x + 32, cy + y + 32), mass(top + 48, 'STONE2', { floorPic: 'FLAT5_7', light: 224 }));
    c.thing(cx + x, cy + y, T.TORCH_GREEN);
  }
  // items on the terraces
  for (const [x, y, t] of [[0, -640, T.ROCKETL], [-800, 0, T.CHAINGUN], [800, 0, T.CHAINGUN], [0, 640, T.SSG], [-560, -480, T.MEDI], [560, 480, T.MEDI], [-560, 480, T.SHELLBOX], [560, -480, T.BULLETS], [64, -640, T.ROCKETBOX], [0, -1200, T.BLUEARMOR], [-1200, -400, T.STIM], [1200, 400, T.STIM]] as [number, number, number][]) c.thing(cx + x, cy + y, t);
  for (const [x, y] of [[-1000, 600], [1000, -600], [-700, -900], [700, 900], [1400, 0], [-1400, 0]]) c.thing(cx + x, cy + y, T.TREE_BIG);
}

// ---- the river and its crossings -----------------------------------------------------------
function river(c: PaintCanvas): void {
  const nuk = out(RIVER_Z, 'NUKAGE1', { light: 200, special: 7, riser: 'NUKEDGE1', wall: 'NUKEDGE1' });
  const shore = (z: number) => out(z, 'FLOOR7_1', { light: 196, riser: 'NUKEDGE1' });
  // banks (a strip so the river walls show the nukage-edge texture), then the channel from
  // the hill's north foot to the north ridge; it widens into the moat around the fort
  const bank = out(0, 'FLOOR7_1', { light: 200, riser: 'NUKEDGE1' });
  c.paint(rect(-352, -2720, 352, 5376), bank);
  c.paint(chamfer(-1120, -1120, 1120, 1120, 272), bank);
  c.paint(rect(-320, -2688, 320, 5376), nuk);
  c.paint(chamfer(-1088, -1088, 1088, 1088, 256), nuk);
  // the spring: a slime fall in the hill face at the south end, with a little grotto
  c.paint(rect(-224, -2848, 224, -2688), bank);
  c.paint(rect(-192, -2816, 192, -2688), nuk);
  // a rock outcrop the slime pours out of: the fall is the riser of a thin ledge in front
  c.paint(rect(-288, -2976, 288, -2816), mass(176, 'ROCK5', { floorPic: 'RROCK09', light: 192 }));
  c.paint(rect(-160, -2824, 160, -2816), mass(144, 'SFALL1', { floorPic: 'NUKAGE1', light: 224 }));
  // escape stairs on both banks (from the bed up to the ground)
  for (const y of [-2432, -1792, 1536, 2688, 3392, 4864]) {
    for (const s of [1, -1]) {
      stairs(c, s * 320 - s * 192, y, s * 320, y + 160, s > 0 ? 'E' : 'W', [-72, -48, -24], (z) => shore(z));
    }
  }
  // the catwalk: a narrow steel crossing at y≈2200 with railings
  c.paint(rect(-320, 2176, 320, 2272), out(0, 'FLAT4', { light: 208, riser: 'METAL', fence: 'MIDBARS3' }));
  c.thing(-288, 2224, T.TECHLAMP2); c.thing(288, 2224, T.TECHLAMP2);
}

function fort(c: PaintCanvas): void {
  const cour = out(0, 'FLAT5_7', { light: 208, riser: 'STONE2' });
  // outer walls (ruined): stone mass, 64 thick, height 224
  c.paint(chamfer(-768, -768, 768, 768, 192), mass(224, 'STONE2', { floorPic: 'FLAT5_7', light: 192 }));
  c.paint(chamfer(-704, -704, 704, 704, 160), cour);
  // corner bastions: raised, reached from the courtyard by stairs
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    c.paint(rect(sx * 448, sy * 448, sx * 704, sy * 704), out(96, 'FLAT5_7', { riser: 'STONE3', light: 216 }));
    // stairs from the courtyard to the bastion
    const y0 = sy * 256, y1 = sy * 448;
    stairs(c, sx * 512, Math.min(y0, y1), sx * 640, Math.max(y0, y1), sy > 0 ? 'N' : 'S', [24, 48, 72], (z) => out(z, 'FLAT5_7', { riser: 'STEP6', light: 208 }));
  }
  // gates west and east (wide), across causeways over the moat
  for (const s of [1, -1]) {
    c.paint(rect(s * 704, -192, s * 768, 192), out(0, 'FLAT5_7', { light: 200, riser: 'STONE2' }));
    c.paint(rect(s * 768, -192, s * 1088, 192), out(0, 'FLAT1_2', { light: 208, riser: 'STONE2' }));
    // causeway parapets
    c.paint(rect(s * 768, 192, s * 1088, 224), mass(40, 'STONE2', { floorPic: 'FLAT5_7', light: 208 }));
    c.paint(rect(s * 768, -224, s * 1088, -192), mass(40, 'STONE2', { floorPic: 'FLAT5_7', light: 208 }));
    // gate towers
    c.paint(rect(s * 704, 192, s * 832, 320), mass(288, 'STONE3', { floorPic: 'FLAT1' }));
    c.paint(rect(s * 704, -320, s * 832, -192), mass(288, 'STONE3', { floorPic: 'FLAT1' }));
    c.thing(s * 1056, 256, T.TORCH_GREEN); c.thing(s * 1056, -256, T.TORCH_GREEN);
  }
  // breaches in the north and south walls, rubble ramps down to the moat bank... kept as windows:
  for (const s of [1, -1]) {
    for (const x of [-384, 256]) c.paint(rect(x, s * 704, x + 128, s * 768), mass(112, 'STONE2', { floorPic: 'FLAT5_7', light: 200 }));
  }
  // the keep: raised platform with stairs on four sides, ruined pillars on it
  c.paint(rect(-256, -256, 256, 256), out(96, 'FLOOR5_3', { riser: 'STONE3', light: 224 }));
  for (const s of [1, -1]) {
    stairs(c, -96, s * 256, 96, s * 448, s > 0 ? 'S' : 'N', [24, 48, 72], (z) => out(z, 'FLAT5_7', { riser: 'STEP6', light: 216 }));
    stairs(c, s * 256, -96, s * 448, 96, s > 0 ? 'W' : 'E', [24, 48, 72], (z) => out(z, 'FLAT5_7', { riser: 'STEP6', light: 216 }));
  }
  for (const [x, y] of [[-192, -192], [128, -192], [-192, 128], [128, 128]]) c.paint(rect(x, y, x + 64, y + 64), mass(96 + 160 + ((x + y) & 64), 'STONE3', { floorPic: 'FLAT1', light: 224 }));
  c.thing(0, 0, T.MEGA);
  c.thing(0, 96, T.BFG); c.thing(64, 96, T.CELLPACK); c.thing(-64, 96, T.CELLPACK);
  for (const [x, y] of [[-576, 0], [576, 0], [0, -576], [0, 576]]) c.thing(x, y, T.FLOORLAMP);
  for (const [x, y, t] of [[-576, 576, T.ROCKETL], [576, -576, T.ROCKETL], [576, 576, T.PLASMA], [-576, -576, T.PLASMA], [-512, 256, T.SHELLBOX], [512, -256, T.SHELLBOX], [-512, -256, T.ROCKETBOX], [512, 256, T.ROCKETBOX], [0, -352, T.GREENARMOR], [0, 352, T.GREENARMOR], [-352, 0, T.MEDI], [352, 0, T.MEDI]] as [number, number, number][]) c.thing(x, y, t);
}

function bridge(c: PaintCanvas, cx: number, cy: number): void {
  const deck = out(48, 'FLAT5_7', { light: 216, riser: 'STONE2' });
  // approach ramps on both banks, deck over the river
  for (const s of [1, -1]) stairs(c, s * 576, cy - 192, s * 832, cy + 192, s > 0 ? 'W' : 'E', [16, 32], (z) => out(z, 'FLAT5_7', { riser: 'STEP6', light: 212 }));
  c.paint(rect(-576, cy - 192, 576, cy + 192), deck);
  // parapets (chest-high) with gaps at the posts
  c.paint(rect(-576, cy + 160, 576, cy + 192), mass(96, 'STONE2', { floorPic: 'FLAT5_7', light: 216 }));
  c.paint(rect(-576, cy - 192, 576, cy - 160), mass(96, 'STONE2', { floorPic: 'FLAT5_7', light: 216 }));
  // piers in the river (visible stone buttresses) and lamp posts
  for (const s of [1, -1]) {
    for (const x of [-256, 192]) c.paint(rect(x, cy + s * 192, x + 64, cy + s * 256), mass(48, 'STONE3', { floorPic: 'FLAT5_7', light: 208 }));
    for (const x of [-576, 512]) { c.paint(rect(x, cy + s * 160 - (s > 0 ? 0 : 32), x + 64, cy + s * 160 + (s > 0 ? 32 : 0)), mass(144, 'STONE3', { floorPic: 'FLAT1', light: 224 })); c.thing(x + 32, cy + s * 176, T.TECHLAMP); }
  }
  // bank guard posts (sandbags) and supplies
  const sand = mass(40, 'CEMENT7', { floorPic: 'FLAT1', light: 208 });
  for (const s of [1, -1]) {
    c.paint(rect(s * 1024, cy - 320, s * 1088, cy - 128), sand);
    c.paint(rect(s * 1024, cy + 128, s * 1088, cy + 320), sand);
    c.thing(s * 960, cy, T.CHAINGUN); c.thing(s * 960, cy + 64, T.BULLETS); c.thing(s * 1152, cy, T.MEDI);
    c.thing(s * 1152, cy + 384, T.SHELLBOX); c.thing(s * 1152, cy - 384, T.ROCKET);
  }
  c.thing(cx, cy, T.SOUL); c.thing(cx - 128, cy, T.SSG); c.thing(cx + 128, cy, T.ROCKETL);
}
