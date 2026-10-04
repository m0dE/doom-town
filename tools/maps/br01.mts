// BR01 "Doom Town" — the battle royale map (16384 × 16384 units, DESIGN.md "Battle royale").
//
// A town in the middle of a valley ringed by rock ridges:
//   Town          x -4352..4352, y -1408..3456: a 6 × 4 street grid of blocks — houses,
//                 shops, a church, an office block (stairs to a roof terrace), the town hall,
//                 police station, hotel, bar, school, clinic, apartments, warehouses, a park
//                 and the town square with a fountain in the middle.
//   West          factory compound (hall with a mezzanine, workshop, offices, tanks, yard).
//   East          freight depot (three warehouses, tracks with wagons, container yard).
//   North         farm with barn and silo and fields (NW), a wooded hill (N), a pond with
//                 cabins (N), the radio station compound on a terraced hill (NE).
//   South         a river crossing the whole map (five bridges, wadeable: stepped banks),
//                 the army base (S), a farm (SW), a gas station and motel (SE), hills.
// Everything is walkable with steps <= 24 and doorways >= 96 wide, 112 high. Crates (thing
// 9020) sit mostly inside buildings; 64+ DM starts spread over the whole map.
//
// Sky: ONE sky height (SKYZ = 320) over every outdoor area and every wall mass (no sky
// "walls" between different sky heights anywhere: seen from the dropship the whole valley
// reads as one surface). Every enterable building's shell is exactly SKYZ high: a doorway or
// window under a lower lintel draws its facade up to the outdoor ceiling, so a shell lower
// than the sky would show slabs above its doors. Walkable roofs (the office terrace, 192)
// stay below every shell so nobody on foot looks down into a room.
// Lobby island (things 9030) in the SE corner, sealed off by solid rock; buggies (9040) on
// the 256-wide roads and open ground; a few sniper rifles (9050) and grenade packs (9051).
import { PaintCanvas, rect, chamfer, oct, poly, type Pt, type Shape, type Style, type Solid, type Paint } from './lib/canvas.mts';
import { T, stairs, lighten, withProps, raise, rng, blob } from './lib/kit.mts';
import { room, solid } from './lib/styles.mts';

export const NAME = 'BR01';
export const TITLE = 'BR01: Doom Town';

const W = 8192;
const SKYZ = 320;
const SKY = 'F_SKY1';
const CRATE = 9020, START = 11, LOBBY_SPOT = 9030, BUGGY = 9040, SNIPER = 9050, GRENADES = 9051;
/** The lobby island (SE corner): its floor, and the box of rock + rim sealing it off. */
const LOBBY: R4 = [4992, -7936, 7808, -6784];
const LOBBY_RING: R4 = [4736, -8192, 8192, -6656];
/** Off-limits for DM starts and buggies: the lobby box + 640 (the sim keeps its playfield box and
 * the zone off the lobby spots' box + a margin; a spawn spot in there would be refused). */
const nearLobby = (x: number, y: number) => x > LOBBY[0] - 640 && y < LOBBY[3] + 640;
const inLobbyRing = (x: number, y: number, m = 0) => x > LOBBY_RING[0] - m && x < LOBBY_RING[2] + m && y > LOBBY_RING[1] - m && y < LOBBY_RING[3] + m;
const RIVER_Z = -48;

const out = (floor: number, pic = 'GRASS2', o: Partial<Style> = {}): Style =>
  ({ floor, ceil: SKYZ, floorPic: pic, ceilPic: SKY, light: 200, wall: 'ROCK4', riser: 'ROCK4', upper: 'ROCK4', ...o });
// a wall mass's sky ceiling is the common sky (a building's shell top = SKYZ = its ceiling):
// one sky height everywhere, so no sky "walls" anywhere (the dropship looks down on it all)
const mass = (top: number, face: string, o: Partial<Style> = {}): Style =>
  ({ floor: top, ceil: Math.max(SKYZ, top), floorPic: 'FLAT1', ceilPic: SKY, light: 184, wall: face, riser: face, upper: face, ...o });
const snap = (v: number, g = 16) => Math.round(v / g) * g;

const HOUSE_FACES = ['BRICK1', 'BRICK12', 'BRICK5', 'BRICK6', 'BRICK7', 'STUCCO1', 'STUCCO3', 'A-BROCK2', 'BIGBRIK1', 'STONEW1', 'A-MYWOOD', 'BROWN1', 'BRICK10', 'A-BRICK1'];
const INNERS = ['PANEL6', 'PANEL7', 'WOOD12', 'STUCCO', 'PANEL1', 'BRICK12', 'PANEL3', 'WOOD3'];
const HOUSE_FLOORS = ['FLOOR0_1', 'FLAT5_1', 'FLOOR4_1', 'FLAT5_2', 'FLOOR0_2', 'FLOOR4_6', 'FLOOR3_3'];
const HOUSE_CEILS = ['CEIL1_1', 'CEIL3_1', 'CEIL3_2', 'FLAT5_5', 'CEIL3_5'];

type R4 = [number, number, number, number];
type Side = 'N' | 'S' | 'E' | 'W';
interface Open { side: Side; at: number; w?: number; h?: number; r?: number }
interface Spec {
  rects: R4[]; face: string; inner: string; f?: number; ceil?: number; fpic?: string; cpic?: string; light?: number;
  doors: Open[]; windows?: Open[]; vx?: number[]; hy?: number[]; noGaps?: boolean; lamp?: string; lampSpecial?: number;
  furnish?: (b: Bld) => void; crates?: number; kind: string;
}
interface Bld { rm: Style; f: number; cells: R4[]; i: R4; light: number; spec: Spec }

// ---- module state (reset by build) ---------------------------------------------------------
let c: PaintCanvas;
let R: () => number;
let crates: Pt[] = [];
let doorPts: Pt[] = [];
let blds: Bld[] = [];
const pick = <X,>(a: readonly X[]): X => a[Math.floor(R() * a.length)];
const shuffle = <X,>(a: X[]): X[] => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const th = (x: number, y: number, t: number, a = 0) => c.thing(x, y, t, a);

/** Every point within ±r (8-unit samples) walkable at one floor with ≥ 64 headroom. */
function free(x: number, y: number, r: number): number | null {
  let floor: number | null = null;
  for (let dy = -r; dy <= r; dy += 8) for (let dx = -r; dx <= r; dx += 8) {
    const s = c.at(x + dx + 1, y + dy + 1) as Style;
    if ((s as unknown as Solid).solid) return null;
    if (floor === null) floor = s.floor; else if (s.floor !== floor) return null;
    if (s.ceil - s.floor < 64) return null;
  }
  return floor;
}
const near = (pts: Pt[], x: number, y: number, d: number) => pts.some(([a, b]) => Math.hypot(a - x, b - y) < d);
function crate(x: number, y: number): boolean {
  x = snap(x, 8); y = snap(y, 8);
  if (free(x, y, 32) === null || near(doorPts, x, y, 112) || near(crates, x, y, 72)) return false;
  crates.push([x, y]);
  th(x, y, CRATE, Math.floor(R() * 8) * 45);
  return true;
}

// ---- buildings ---------------------------------------------------------------------------------
function opening(r: R4, o: Open, d0: number, d1: number): Shape {
  const [x0, y0, x1, y1] = r, w = o.w ?? 96, a = o.at - w / 2, b = o.at + w / 2;
  switch (o.side) {
    case 'S': return rect(a, y0 + d0, b, y0 + d1);
    case 'N': return rect(a, y1 - d1, b, y1 - d0);
    case 'W': return rect(x0 + d0, a, x0 + d1, b);
    default: return rect(x1 - d1, a, x1 - d0, b);
  }
}
const openingPt = (r: R4, o: Open): Pt => {
  const [x0, y0, x1, y1] = r;
  return o.side === 'S' ? [o.at, y0 + 16] : o.side === 'N' ? [o.at, y1 - 16] : o.side === 'W' ? [x0 + 16, o.at] : [x1 - 16, o.at];
};

/**
 * An enterable building: facade ring (16) + inner ring (16), both SKYZ high, the interior
 * room, doorways (two halves so each side shows its own wall texture above the lintel),
 * windows (48-high slots: see and shoot through, not walk), partitions with 96-wide gaps,
 * furniture (callback), ceiling lights and crates.
 */
function building(s: Spec): Bld {
  const f = s.f ?? 16, ce = s.ceil ?? f + 144, light = s.light ?? 160;
  const fpic = s.fpic ?? 'FLOOR0_1', cpic = s.cpic ?? 'CEIL3_5';
  for (const r of s.rects) c.paint(rect(...r), mass(SKYZ, s.face, { floorPic: 'FLAT1', light: 176 }));
  for (const [x0, y0, x1, y1] of s.rects) c.paint(rect(x0 + 16, y0 + 16, x1 - 16, y1 - 16), mass(SKYZ, s.inner, { floorPic: 'FLAT1', light: 176 }));
  const rm = room(f, ce, fpic, cpic, light, { riser: 'STEP1', upper: s.inner, wall: s.inner });
  for (const [x0, y0, x1, y1] of s.rects) c.paint(rect(x0 + 32, y0 + 32, x1 - 32, y1 - 32), rm);
  for (const d of s.doors) {
    const r = s.rects[d.r ?? 0], h = d.h ?? 112;
    c.paint(opening(r, d, 0, 16), room(f, f + h, fpic, cpic, light + 8, { upper: s.face, riser: 'STEP1', wall: s.face }));
    c.paint(opening(r, d, 16, 32), room(f, f + h, fpic, cpic, light + 8, { upper: s.inner, riser: 'STEP1', wall: s.inner }));
    doorPts.push(openingPt(r, d));
  }
  for (const wdw of s.windows ?? []) {
    const r = s.rects[wdw.r ?? 0];
    c.paint(opening(r, wdw, 0, 16), room(f + 48, f + 96, 'FLAT1', cpic, light + 24, { riser: s.face, upper: s.face }));
    c.paint(opening(r, wdw, 16, 32), room(f + 48, f + 96, 'FLAT1', cpic, light + 24, { riser: s.inner, upper: s.inner }));
  }
  const [x0, y0, x1, y1] = s.rects[0];
  const i: R4 = [x0 + 32, y0 + 32, x1 - 32, y1 - 32];
  const vx = (s.vx ?? []).slice().sort((a, b) => a - b), hy = (s.hy ?? []).slice().sort((a, b) => a - b);
  const xs = [i[0], ...vx, i[2]], ys = [i[1], ...hy, i[3]];
  for (const x of vx) c.paint(rect(x - 8, i[1], x + 8, i[3]), solid(s.inner));
  for (const y of hy) c.paint(rect(i[0], y - 8, i[2], y + 8), solid(s.inner));
  if (!s.noGaps) {
    for (const x of vx) for (let k = 0; k + 1 < ys.length; k++) { const m = snap((ys[k] + ys[k + 1]) / 2, 8); c.paint(rect(x - 8, m - 48, x + 8, m + 48), rm); doorPts.push([x, m]); }
    for (const y of hy) for (let k = 0; k + 1 < xs.length; k++) { const m = snap((xs[k] + xs[k + 1]) / 2, 8); c.paint(rect(m - 48, y - 8, m + 48, y + 8), rm); doorPts.push([m, y]); }
  }
  const cells: R4[] = [];
  for (let a = 0; a + 1 < xs.length; a++) for (let b = 0; b + 1 < ys.length; b++) {
    cells.push([a === 0 ? xs[a] : xs[a] + 8, b === 0 ? ys[b] : ys[b] + 8, a + 1 === xs.length - 1 ? xs[a + 1] : xs[a + 1] - 8, b + 1 === ys.length - 1 ? ys[b + 1] : ys[b + 1] - 8]);
  }
  // extra rects (cross-shaped buildings) are cells too
  for (const [a, b, d, e] of s.rects.slice(1)) cells.push([a + 32, b + 32, d - 32, e - 32]);
  const B: Bld = { rm, f, cells, i, light, spec: s };
  s.furnish?.(B);
  // ceiling lights: one panel per cell
  for (const [a, b, d, e] of cells) {
    if (d - a < 128 || e - b < 128) continue;
    const mx = snap((a + d) / 2), my = snap((b + e) / 2);
    c.modify(rect(mx - 32, my - 32, mx + 32, my + 32), (p) => ((p as Solid).solid ? null : { ...(p as Style), ceilPic: s.lamp ?? 'TLITE6_6', light: Math.min(255, (p as Style).light + 40), special: s.lampSpecial ?? 0 }));
  }
  // crates in cell corners
  const want = s.crates ?? 1;
  const cand: Pt[] = [];
  for (const [a, b, d, e] of cells) for (const [px, py] of [[a + 40, b + 40], [d - 40, b + 40], [a + 40, e - 40], [d - 40, e - 40], [(a + d) / 2, b + 40], [(a + d) / 2, e - 40], [a + 40, (b + e) / 2], [d - 40, (b + e) / 2]] as Pt[]) cand.push([px, py]);
  let n = 0;
  for (const [px, py] of [...shuffle(cand.slice(0, cells.length * 4)), ...shuffle(cand.slice(cells.length * 4))]) { if (n >= want) break; if (crate(px, py)) n++; }
  blds.push(B);
  return B;
}
/** Raised piece of a room (furniture, daises): same ceiling, floor + dz. */
function furn(b: Bld, r: R4, dz: number, tex: string, pic: string, o: Partial<Style> = {}): void {
  c.paint(rect(...r), { ...b.rm, floor: b.f + dz, floorPic: pic, riser: tex, ...o });
}

/** Local frame of a lot: u along the front, v from the front inwards. */
function frame(x0: number, y0: number, x1: number, y1: number, front: Side) {
  const horiz = front === 'S' || front === 'N';
  const len = horiz ? x1 - x0 : y1 - y0, dep = horiz ? y1 - y0 : x1 - x0;
  const P = (u: number, v: number): Pt => front === 'S' ? [x0 + u, y0 + v] : front === 'N' ? [x0 + u, y1 - v] : front === 'W' ? [x0 + v, y0 + u] : [x1 - v, y0 + u];
  const L = (u0: number, v0: number, u1: number, v1: number): R4 => { const [a, b] = P(u0, v0), [d, e] = P(u1, v1); return [Math.min(a, d), Math.min(b, e), Math.max(a, d), Math.max(b, e)].map((v) => snap(v, 8)) as R4; };
  const opp: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };
  const side = (k: 'front' | 'back' | 'left' | 'right'): Side => k === 'front' ? front : k === 'back' ? opp[front] : horiz ? (k === 'left' ? 'W' : 'E') : (k === 'left' ? 'S' : 'N');
  const atU = (u: number) => snap(horiz ? x0 + u : y0 + u, 8);
  const atV = (v: number) => snap(front === 'S' ? y0 + v : front === 'N' ? y1 - v : front === 'W' ? x0 + v : x1 - v, 8);
  const cutU = (us: number[]) => (horiz ? { vx: us.map(atU) } : { hy: us.map(atU) });
  const cutV = (vs: number[]) => (horiz ? { hy: vs.map(atV) } : { vx: vs.map(atV) });
  return { len, dep, P, L, side, atU, atV, cutU, cutV, horiz };
}
const mergeCuts = (...cs: { vx?: number[]; hy?: number[] }[]) => ({ vx: cs.flatMap((k) => k.vx ?? []), hy: cs.flatMap((k) => k.hy ?? []) });

let bcount: Record<string, number> = {};
const count = (k: string) => { bcount[k] = (bcount[k] ?? 0) + 1; };

function house(x0: number, y0: number, x1: number, y1: number, front: Side, sideDoor: 'left' | 'right' | null, f = 16): Bld {
  count('house');
  const F = frame(x0, y0, x1, y1, front);
  const pu = snap(F.len * 0.58);
  const face = pick(HOUSE_FACES), inner = pick(INNERS);
  const doors: Open[] = [{ side: F.side('front'), at: F.atU(snap(pu * 0.5)) }];
  if (sideDoor) doors.push({ side: F.side(sideDoor), at: F.atV(snap(F.dep / 2)) });
  const windows: Open[] = [{ side: F.side('front'), at: F.atU(snap(pu + (F.len - pu) / 2)), w: 64 }, { side: F.side('back'), at: F.atU(snap(pu * 0.5)), w: 96 }];
  if (F.len - pu > 160) windows.push({ side: F.side('back'), at: F.atU(snap(pu + (F.len - pu) / 2)), w: 64 });
  return building({
    kind: 'house', rects: [[x0, y0, x1, y1]], face, inner, f, ceil: f + 136, fpic: pick(HOUSE_FLOORS), cpic: pick(HOUSE_CEILS), light: 136 + Math.floor(R() * 4) * 12,
    doors, windows, ...F.cutU([pu]), lamp: 'FLAT17', crates: 1,
    furnish: (b) => {
      // a table in the back room, a sofa / bed along the back wall of the front room
      const [a, bb, d, e] = F.L(pu + 64, snap(F.dep / 2) - 32, pu + 128, snap(F.dep / 2) + 32);
      furn(b, [a, bb, d, e], 32, 'WOOD12', 'FLAT5_1');
      const [g, h, k, l] = F.L(48, F.dep - 32 - 64, 48 + 128, F.dep - 32 - 16);
      if (pu > 224) furn(b, [g, h, k, l], 24, 'WOOD3', 'FLOOR6_1');
    },
  });
}

function shop(x0: number, y0: number, x1: number, y1: number, front: Side, f = 16): Bld {
  count('shop');
  const F = frame(x0, y0, x1, y1, front);
  const face = pick(['BRICK12', 'BRICK1', 'STUCCO1', 'BRWINDOW', 'BRICK6', 'A-BRICK1', 'CEMENT1', 'BRICK5']);
  const mid = snap(F.len / 2);
  return building({
    kind: 'shop', rects: [[x0, y0, x1, y1]], face, inner: pick(['PANEL6', 'GRAY1', 'CEMENT7', 'PANEL7', 'BRICK12']), f, ceil: f + 160,
    fpic: pick(['FLOOR4_6', 'FLAT20', 'FLOOR0_3', 'FLOOR4_8', 'FLAT5_4']), cpic: 'CEIL3_4', light: 168 + Math.floor(R() * 3) * 8,
    doors: [{ side: F.side('front'), at: F.atU(mid), w: 128 }, { side: F.side('back'), at: F.atU(snap(F.len * 0.25)), w: 96 }],
    windows: F.len >= 384 ? [{ side: F.side('front'), at: F.atU(snap(mid / 2 - 16)), w: 96 }, { side: F.side('front'), at: F.atU(snap(mid + (F.len - mid) / 2 + 16)), w: 96 }] : [],
    lamp: 'TLITE6_5', crates: 1 + (R() < 0.3 ? 1 : 0),
    furnish: (b) => {
      // shelves (raised 64, jump-proof) in rows from the front, a counter at the back
      for (let u = 128; u + 96 <= F.len - 96; u += 160) furn(b, F.L(u, 160, u + 32, F.dep - 224), 64, pick(['PANBOOK', 'WOOD12', 'CRATINY']), 'FLAT5_2');
      furn(b, F.L(snap(F.len * 0.5), F.dep - 128, F.len - 64, F.dep - 96), 40, 'WOOD12', 'FLAT5_1');
    },
  });
}

/** Multi-room building in a lot frame with grid partitions (fractions of len/dep). */
function hall(kind: string, x0: number, y0: number, x1: number, y1: number, front: Side, o: {
  face: string; inner: string; fpic: string; cpic: string; light: number; ceil?: number; us?: number[]; vs?: number[]; frontDoors?: number[]; backDoors?: number[]; sideDoors?: ('left' | 'right')[];
  doorW?: number; doorH?: number; windowsFront?: number[]; windowsBack?: number[]; crates: number; lamp?: string; lampSpecial?: number; furnish?: (b: Bld, F: ReturnType<typeof frame>) => void; noGaps?: boolean; f?: number;
}): Bld {
  count(kind);
  const F = frame(x0, y0, x1, y1, front);
  const doors: Open[] = [
    ...(o.frontDoors ?? [0.5]).map((u) => ({ side: F.side('front'), at: F.atU(snap(F.len * u)), w: o.doorW ?? 128, h: o.doorH })),
    ...(o.backDoors ?? []).map((u) => ({ side: F.side('back'), at: F.atU(snap(F.len * u)), w: o.doorW ?? 96, h: o.doorH })),
    ...(o.sideDoors ?? []).map((k) => ({ side: F.side(k), at: F.atV(snap(F.dep * 0.5)), w: 96, h: o.doorH })),
  ];
  const windows: Open[] = [
    ...(o.windowsFront ?? []).map((u) => ({ side: F.side('front'), at: F.atU(snap(F.len * u)), w: 64 })),
    ...(o.windowsBack ?? []).map((u) => ({ side: F.side('back'), at: F.atU(snap(F.len * u)), w: 64 })),
  ];
  const cuts = mergeCuts(F.cutU((o.us ?? []).map((u) => snap(F.len * u))), F.cutV((o.vs ?? []).map((v) => snap(F.dep * v))));
  return building({
    kind, rects: [[x0, y0, x1, y1]], face: o.face, inner: o.inner, f: o.f, ceil: (o.f ?? 16) + (o.ceil ?? 144), fpic: o.fpic, cpic: o.cpic, light: o.light,
    doors, windows, ...cuts, noGaps: o.noGaps, lamp: o.lamp, lampSpecial: o.lampSpecial, crates: o.crates, furnish: o.furnish ? (b) => o.furnish!(b, F) : undefined,
  });
}

/** Ruined house: broken walls open to the sky, rubble inside. */
function ruin(x0: number, y0: number, x1: number, y1: number, f = 16): void {
  count('ruin');
  const face = pick(HOUSE_FACES);
  const h = 96 + Math.floor(R() * 4) * 32;
  c.paint(rect(x0, y0, x1, y1), mass(h, face, { light: 184, floorPic: 'FLOOR6_2' }));
  const inside = out(f, 'FLOOR6_2', { light: 176, riser: face });
  c.paint(rect(x0 + 24, y0 + 24, x1 - 24, y1 - 24), inside);
  // breaches, one per side
  const mx = snap((x0 + x1) / 2 + (R() - 0.5) * (x1 - x0) * 0.4), my = snap((y0 + y1) / 2 + (R() - 0.5) * (y1 - y0) * 0.4);
  for (const r of [rect(mx - 64, y0, mx + 64, y0 + 24), rect(mx - 48, y1 - 24, mx + 80, y1), rect(x0, my - 64, x0 + 24, my + 64), rect(x1 - 24, my - 80, x1, my + 48)]) c.paint(r, inside);
  doorPts.push([mx, y0], [mx, y1], [x0, my], [x1, my]);
  c.paint(rect(x0, snap(y0 + (y1 - y0) * 0.7), x0 + 24, y1 - 32), mass(40, face, { light: 184 }));
  for (let k = 0; k < 2; k++) c.paint(blob(snap(x0 + 96 + R() * (x1 - x0 - 192)), snap(y0 + 96 + R() * (y1 - y0 - 192)), 48, 40, R), out(f + 24, 'FLOOR6_2', { riser: 'ROCK3', light: 176 }));
  th(x0 + 64, y0 + 64, T.BURNBARREL);
  crate(x1 - 64, y1 - 64) || crate(x1 - 64, y0 + 64);
}

// ---- terrain helpers ---------------------------------------------------------------------------
function hill(cx: number, cy: number, rx: number, ry: number, levels: number, pics = ['GRASS2', 'GRASS1']): void {
  for (let k = 0; k < levels; k++) {
    const a = rx - k * 256, b = ry - k * 256;
    if (a < 160 || b < 160) break;
    c.modify(oct(cx, cy, a, b), raise(24, { floorPic: pics[k % pics.length], riser: k < 2 ? 'A-MOSROK' : 'ROCK4', light: 200 + k * 4 }));
  }
}
function trees(x0: number, y0: number, x1: number, y1: number, n: number, kinds = [T.TREE_BIG, T.TREE_BIG, T.TREE_BURNT]): void {
  for (let k = 0, tries = 0; k < n && tries < n * 20; tries++) {
    const x = snap(x0 + R() * (x1 - x0), 8), y = snap(y0 + R() * (y1 - y0), 8);
    const s = c.at(x, y) as Style;
    if (inLobbyRing(x, y, 64) || (s as unknown as Solid).solid || s.ceilPic !== SKY || !/GRASS|FLOOR7|RROCK09/.test(s.floorPic)) continue;
    if (free(x, y, 40) === null || near(doorPts, x, y, 160) || near(crates, x, y, 96)) continue;
    th(x, y, pick(kinds));
    k++;
  }
}
function compound(x0: number, y0: number, x1: number, y1: number, gates: Open[], tex: string, ground: Style, h = 160): void {
  c.paint(rect(x0, y0, x1, y1), mass(ground.floor + h, tex, { floorPic: 'FLAT1', light: 184 }));
  c.paint(rect(x0 + 32, y0 + 32, x1 - 32, y1 - 32), ground);
  for (const g of gates) { c.paint(opening([x0, y0, x1, y1], { ...g, w: g.w ?? 256 }, 0, 32), ground); }
}
const crateStack = (x: number, y: number, sz: number, h: number, f = 0) =>
  c.paint(rect(x, y, x + sz, y + sz), mass(f + h, 'CRATE1', { floorPic: 'CRATOP2', light: 192, riser: 'CRATE1' }));

// ==================================================================================================
export function build(): PaintCanvas {
  c = new PaintCanvas(-W, -W, W, W, 8, solid('ROCK4'));
  R = rng(160);
  crates = []; doorPts = []; blds = []; bcount = {};

  // ==== 1. ground and the ridge around the valley =================================================
  c.paint(chamfer(-W + 128, -W + 128, W - 128, W - 128, 1024), out(0, 'GRASS2'));
  const edge = (horizontal: boolean, fixed: number, dir: number, from: number, to: number) => {
    for (let p = from; p < to;) {
      const q = Math.min(to, p + 256 + Math.floor(R() * 6) * 128);
      const depth = 320 + Math.floor(R() * 4) * 64;
      const h = 160 + Math.floor(R() * 5) * 32;
      const top = mass(h, R() < 0.5 ? 'ROCK4' : 'ROCK5', { floorPic: pick(['RROCK09', 'MFLR8_3', 'FLAT1_2']), light: 176 });
      const k = 64 + Math.floor(R() * 3) * 32;
      if (horizontal) c.paint(chamfer(p, fixed + dir * 512, q, fixed - dir * depth, k), top); else c.paint(chamfer(fixed + dir * 512, p, fixed - dir * depth, q, k), top);
      p = q;
    }
  };
  edge(true, W - 128, 1, -W, W); edge(true, -W + 128, -1, -W, W);
  edge(false, W - 128, 1, -W, W); edge(false, -W + 128, -1, -W, W);
  // ground variety
  for (let i = 0; i < 30; i++) {
    const x = snap((R() * 2 - 1) * 6800), y = snap((R() * 2 - 1) * 6800);
    if (Math.abs(x) < 4600 && y > -1700 && y < 3800) continue;
    c.modify(blob(x, y, 256 + R() * 384, 192 + R() * 320, R), withProps({ floorPic: pick(['GRASS1', 'FLOOR7_2', 'FLOOR7_1']) }));
  }

  // ==== 2. hills ======================================================================================
  hill(5120, 5632, 1664, 1536, 4);       // radio station hill (NE), top at 96
  hill(-2560, 5760, 1280, 1024, 3);      // wooded hill (N)
  hill(-3072, -5888, 1280, 1152, 3);     // SW hill
  hill(3456, -5504, 1024, 896, 3);       // SE hill
  hill(-6912, 4096, 640, 512, 2);
  hill(2560, 7040, 768, 384, 2);

  // ==== 3. the river (wadeable: banks step down 24 at a time) ===========================================
  river();

  // ==== 4. roads outside the town =========================================================================
  const asphalt = withProps({ floorPic: 'FLOOR6_2', light: 196 });
  const dirt = withProps({ floorPic: 'FLAT10' });
  c.modify(rect(-128, -7424, 128, 7424), asphalt);                 // main road north–south
  c.modify(rect(-7424, 896, 7424, 1152), asphalt);                  // east–west road
  c.modify(rect(-6528, -5376, -6272, -1536), dirt);                 // factory south gate → west bridge → SW farm
  c.modify(rect(-6528, -5504, -4864, -5248), dirt);
  c.modify(rect(5760, -5632, 6016, -1536), asphalt);                // depot south gate → east bridge → gas station
  c.modify(rect(4224, 3456, 4480, 6016), dirt);                     // town NE corner → radio hill
  c.modify(rect(-4480, 3456, -4224, 5248), dirt);                   // town NW corner → farm
  c.modify(rect(-6400, 4992, -4224, 5248), dirt);
  c.modify(rect(128, 5248, 1024, 5504), dirt);                      // to the pond

  // ==== 5. the town ======================================================================================
  town();

  // ==== 6. outskirts ==================================================================================
  factory(-7424, -1536, -4864, 2560);
  depot(4864, -1536, 7424, 2560);
  farm(-5248, 5376, true);
  farm(-5248, -5632, false);
  radioStation(5120, 5632);
  pond(1536, 5376);
  armyBase(0, -5952);
  gasStation(5888, -4992);
  // a lone ruined chapel and a hunter's hut in the woods
  ruin(-2944, 5568, -2496, 5952, 88);
  hutAt(-1792, -4608);
  hutAt(7040, 4096);
  hutAt(-7040, -3712);

  // ==== 7. bridges (after the river and the roads) =====================================================
  bridges();

  // ==== 8. trees, lamps, light pools ===================================================================
  trees(-7424, 3456, -4480, 7424, 40);      // NW: orchard and woods
  trees(-3712, 4096, -1280, 7296, 45);      // N: wooded hill
  trees(-7424, -7424, -4352, -3584, 35);    // SW
  trees(1792, -7424, 4480, -3840, 30);      // SE hill
  trees(-4480, -2560, 4480, -1536, 30);     // meadows between town and river
  trees(2560, 3584, 7424, 7424, 20);        // NE
  trees(-7424, -3584, 7424, -2560, 20);     // along the river
  trees(-1280, 3584, 1280, 7424, 12);       // north road

  const LAMPS = new Set<number>([T.TECHLAMP, T.TECHLAMP2, T.FLOORLAMP, T.TORCH_RED, T.TORCH_BLUE, T.TORCH_GREEN, T.CANDELABRA, T.BURNBARREL]);
  for (const t of [...c.things]) {
    if (!LAMPS.has(t.type)) continue;
    c.modify(oct(snap(t.x, 8), snap(t.y, 8), 128, 128), lighten(24));
  }

  // ==== 9. the lobby island, loot on the ground, the DM starts, buggies ==============================
  lobby();
  loot();
  starts();
  buggies();
  return c;
}

/** Counts for the build log. */
export function report(): string {
  const n = (t: number) => c.things.filter((x) => x.type === t).length;
  return `${n(LOBBY_SPOT)} lobby spots, ${n(BUGGY)} buggies, ${n(SNIPER)} sniper rifles, ${n(GRENADES)} grenade packs, ${blds.length} enterable buildings + ${bcount.ruin ?? 0} ruins (${Object.entries(bcount).map(([k, v]) => `${k} ${v}`).join(', ')}), ${n(CRATE)} crates (${crates.filter(([x, y]) => (c.at(x, y) as Style).ceilPic !== SKY).length} indoors), ${n(START)} DM starts`;
}

// ---- the town ----------------------------------------------------------------------------------
const COLS: [number, number][] = [[-4096, -2944], [-2688, -1536], [-1280, -128], [128, 1280], [1536, 2688], [2944, 4096]];
const ROWS: [number, number][] = [[-1152, -256], [0, 896], [1152, 2048], [2304, 3200]];

function town(): void {
  const street = out(0, 'FLOOR6_2', { light: 184, riser: 'STEP1', wall: 'BRICK7' });
  c.paint(rect(-4352, -1408, 4352, 3456), street);
  const walk = out(8, 'FLAT1', { light: 188, riser: 'STEP1' });
  ROWS.forEach(([y0, y1], ri) => COLS.forEach(([x0, x1], ci) => {
    c.paint(chamfer(x0, y0, x1, y1, 64), walk);
    block(ci, ri, x0 + 64, y0 + 64, x1 - 64, y1 - 64);
    // street lamps on two corners of each block
    const k = (ci + ri) % 2;
    th(k ? x0 + 48 : x1 - 48, y0 + 48, T.FLOORLAMP);
    th(k ? x1 - 48 : x0 + 48, y1 - 48, T.FLOORLAMP);
  }));
  // street furniture: wrecked cars, barricades
  const car = (x: number, y: number, along: boolean) => c.paint(along ? rect(x, y, x + 160, y + 80) : rect(x, y, x + 80, y + 160), mass(48, pick(['SILVER1', 'METAL2', 'SHAWN2', 'BROWN144']), { floorPic: 'FLAT23', light: 184 }));
  // (never on the two through roads, x -128..128 and y 896..1152: buggies run there)
  car(1312, 2112, false); car(-2240, 2400, false); car(3200, -224, false); car(-1408, -1328, true); car(1600, 3296, true); car(-4320, 1600, false); car(4224, 160, false); car(-2240, -160, false);
  for (const [x, y] of [[-1408, 2176], [2816, 2176], [-2816, -128]]) c.paint(rect(x, y, x + 64, y + 64), mass(40, 'CEMENT7', { floorPic: 'FLAT1', light: 184 }));
}

function block(ci: number, ri: number, x0: number, y0: number, x1: number, y1: number): void {
  const key = `${ci},${ri}`;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const yard = out(8, 'GRASS1', { light: 192, riser: 'STEP1' });
  const fourHouses = () => {
    c.paint(rect(x0, y0, x1, y1), yard);
    for (const [a, b, front, side] of [[x0, y0, 'S', 'left'], [mx + 32, y0, 'S', 'right'], [x0, my + 32, 'N', 'left'], [mx + 32, my + 32, 'N', 'right']] as [number, number, Side, 'left' | 'right'][]) {
      const w = mx - 32 - x0, h = my - 32 - y0;
      if (R() < 0.12) { ruin(a + 32, b + 32, a + w - 32, b + h - 32); continue; }
      // houses vary in footprint inside their lot
      const sx = snap(R() * 48), sy = snap(R() * 32);
      house(a + 16 + sx, front === 'S' ? b + 16 : b + 48 + sy, a + w - 16 - (48 - sx), front === 'S' ? b + h - 48 + sy : b + h - 16, front, side);
    }
    // garden walls between the lots, a tree or two
    c.paint(rect(mx - 8, y0 + 64, mx + 8, y1 - 64), mass(48, 'BRICK12', { light: 184, floorPic: 'FLAT1' }));
    c.paint(rect(mx - 8, my - 32, mx + 8, my + 32), yard);
  };
  switch (key) {
    // central blocks of the bottom row and the square
    case '2,0': case '3,0': {
      c.paint(rect(x0, y0, x1, y1), out(8, 'FLAT5_4', { light: 188 }));
      const n = key === '2,0' ? 3 : 2;
      const lw = snap(((x1 - x0) - (n - 1) * 32) / n);
      for (let k = 0; k < n; k++) shop(x0 + k * (lw + 32), y1 - 512, k === n - 1 ? x1 : x0 + k * (lw + 32) + lw, y1, 'N');
      // back alley with bins
      crate(x0 + 480, y0 + 96);
      th(x0 + 64, y0 + 64, T.BURNBARREL);
      if (n === 2) { /* diner: one more enterable in the alley */ }
      return;
    }
    case '2,1': return;
    case '3,1': square(); return; // spans both central blocks and the street between
    case '2,2': church(x0, y0, x1, y1); return;
    case '3,2': office(x0, y0, x1, y1); return;
    case '2,3': {
      c.paint(rect(x0, y0, x1, y1), yard);
      house(x0, y0 + 64, x0 + 448, y0 + 384, 'W', 'right');
      house(x0, y1 - 320, x0 + 480, y1, 'N', 'left');
      // garden: hedges, a shed
      for (const [a, b, d, e] of [[x0 + 576, y0 + 128, x0 + 608, y1 - 128], [x0 + 640, y0, x1, y0 + 32]]) c.paint(rect(a, b, d, e), mass(56, 'A-CAMO1', { floorPic: 'GRASS1', light: 196 }));
      hall('shed', x1 - 320, y1 - 256, x1, y1, 'W', { face: 'WOOD9', inner: 'WOOD3', fpic: 'FLOOR4_1', cpic: 'CEIL1_1', light: 140, crates: 1, frontDoors: [0.5] });
      trees(x0 + 640, y0 + 64, x1 - 64, y1 - 320, 4);
      return;
    }
    case '3,3': townHall(x0, y0, x1, y1); return;
    case '0,0': {
      // warehouse + parking lot
      c.paint(rect(x0, y0, x1, y1), out(8, 'FLOOR6_2', { light: 180 }));
      warehouse(x0, y0, x0 + 576, y1, 'E', 2);
      for (let k = 0; k < 3; k++) c.paint(rect(x0 + 704 + k * 96, y0 + 64, x0 + 768 + k * 96, y0 + 192), mass(48, pick(['SILVER1', 'METAL2', 'SHAWN2']), { floorPic: 'FLAT23' }));
      crateStack(x1 - 128, y1 - 128, 64, 64, 8); crateStack(x1 - 192, y1 - 128, 64, 32, 8);
      crate(x0 + 800, y1 - 96); crate(x1 - 64, y0 + 320);
      return;
    }
    case '0,1': {
      c.paint(rect(x0, y0, x1, y1), out(8, 'FLAT5_4', { light: 188 }));
      shop(x0, y0, x0 + 448, y0 + 448, 'S');
      shop(x0 + 480, y0, x0 + 896, y0 + 448, 'S');
      house(x0, y1 - 288, x0 + 512, y1, 'N', 'left');
      bar(x0 + 576, y1 - 320, x1, y1, 'E');
      return;
    }
    case '0,2': case '1,3': case '4,2': case '5,3': case '0,3': fourHouses(); return;
    case '1,0': {
      c.paint(rect(x0, y0, x1, y1), yard);
      house(x0, y0, x0 + 480, y0 + 320, 'S', 'left');
      house(x0 + 544, y0, x1, y0 + 320, 'S', 'right');
      hall('garage', x0, y1 - 384, x0 + 512, y1, 'N', { face: 'CEMENT1', inner: 'CEMENT7', fpic: 'FLAT5_4', cpic: 'CEIL5_1', light: 144, ceil: 176, doorW: 192, doorH: 144, crates: 2,
        furnish: (b, F) => { for (const u of [96, 288]) c.paint(rect(...F.L(u, 96, u + 80, 256)), { ...b.rm, floor: b.f + 48, floorPic: 'FLAT23', riser: 'SILVER1' }); } });
      house(x0 + 576, y1 - 352, x1, y1, 'N', 'right');
      return;
    }
    case '1,1': {
      c.paint(rect(x0, y0, x1, y1), out(8, 'FLAT1', { light: 188 }));
      hall('police', x0, y0, x0 + 640, y1, 'E', { face: 'BIGBRIK1', inner: 'GRAY1', fpic: 'FLOOR0_3', cpic: 'CEIL3_4', light: 176, us: [0.36, 0.68], vs: [0.5], frontDoors: [0.5], backDoors: [0.5], windowsFront: [0.2, 0.84], windowsBack: [0.2, 0.84], crates: 3, lamp: 'TLITE6_5',
        furnish: (b, F) => { furn(b, F.L(F.dep * 0.5 + 16, F.len * 0.42, F.dep * 0.5 + 48, F.len * 0.62), 40, 'WOOD12', 'FLAT5_1'); } });
      c.paint(rect(x0 + 704, y0 + 64, x1, y1 - 64), mass(40, 'MIDBARS3', { light: 184 }));
      c.paint(rect(x0 + 720, y0 + 80, x1, y1 - 80), out(8, 'FLAT5_4', { light: 188 }));
      c.paint(rect(x0 + 704, my - 64, x0 + 720, my + 64), out(8, 'FLAT5_4', { light: 188 }));
      crate(x1 - 64, y0 + 144); crate(x1 - 64, y1 - 144);
      return;
    }
    case '1,2': {
      c.paint(rect(x0, y0, x1, y1), yard);
      hall('apartments', x0, y0, x0 + 576, y1, 'W', { face: 'BRICK10', inner: 'STUCCO', fpic: 'FLOOR0_2', cpic: 'CEIL1_1', light: 152, us: [0.33, 0.67], vs: [0.5], frontDoors: [0.5], backDoors: [0.17, 0.83], windowsFront: [0.17, 0.83], crates: 3, lamp: 'FLAT17' });
      house(x0 + 640, y0, x1, y0 + 352, 'E', 'left');
      house(x0 + 640, y1 - 352, x1, y1, 'E', 'right');
      return;
    }
    case '4,0': {
      c.paint(rect(x0, y0, x1, y1), out(8, 'FLAT1', { light: 188 }));
      hall('hotel', x0, y0, x0 + 576, y1, 'N', { face: 'STONE2', inner: 'PANEL7', fpic: 'FLOOR6_1', cpic: 'CEIL3_5', light: 152, us: [0.5], vs: [0.3, 0.65], frontDoors: [0.25], backDoors: [0.75], sideDoors: ['left'], windowsFront: [0.75], windowsBack: [0.25], crates: 3, lamp: 'FLAT17' });
      bar(x0 + 640, y0, x1, y0 + 448, 'E');
      crate(x1 - 96, y1 - 96);
      return;
    }
    case '4,1': {
      c.paint(rect(x0, y0, x1, y1), out(8, 'FLAT5_4', { light: 188 }));
      hall('school', x0, y0 + 256, x1, y1, 'S', { face: 'BRICK5', inner: 'STUCCO1', fpic: 'FLOOR4_6', cpic: 'CEIL3_4', light: 168, us: [0.33, 0.67], frontDoors: [0.5], backDoors: [0.15, 0.85], windowsFront: [0.15, 0.85], windowsBack: [0.33, 0.67], crates: 3, lamp: 'TLITE6_5',
        furnish: (b, F) => { for (const u of [0.08, 0.72]) for (const v of [0.3, 0.6]) furn(b, F.L(snap(F.len * u), snap(F.dep * v), snap(F.len * u) + 128, snap(F.dep * v) + 32), 32, 'WOOD12', 'FLAT5_1'); } });
      // schoolyard with a basketball court
      c.paint(rect(x0 + 64, y0 + 32, x1 - 64, y0 + 224), out(8, 'FLOOR0_3', { light: 196 }));
      crate(x0 + 96, y0 + 128);
      return;
    }
    case '4,3': {
      // park with a gazebo
      c.paint(rect(x0, y0, x1, y1), out(8, 'GRASS1', { light: 200, riser: 'STEP1' }));
      c.paint(rect(x0, my - 48, x1, my + 48), out(8, 'FLAT5_7', { light: 200 }));
      c.paint(rect(mx - 48, y0, mx + 48, y1), out(8, 'FLAT5_7', { light: 200 }));
      c.paint(oct(mx, my, 192, 192), out(24, 'FLOOR4_1', { riser: 'WOOD1', light: 208 }));
      c.paint(oct(mx, my, 144, 144), out(40, 'FLOOR4_1', { riser: 'WOOD1', light: 208 }));
      for (const [dx, dy] of [[-112, -112], [96, -112], [-112, 96], [96, 96]]) c.paint(rect(mx + dx, my + dy, mx + dx + 16, my + dy + 16), solid('WOOD1'));
      crate(mx + 48, my - 16);
      hall('shed', x1 - 256, y1 - 224, x1, y1, 'S', { face: 'WOOD9', inner: 'WOOD3', fpic: 'FLOOR4_1', cpic: 'CEIL1_1', light: 136, crates: 1 });
      th(mx - 256, my - 128, T.FLOORLAMP); th(mx + 256, my + 128, T.FLOORLAMP);
      trees(x0 + 32, y0 + 32, x1 - 32, y1 - 32, 10);
      return;
    }
    case '5,0': {
      c.paint(rect(x0, y0, x1, y1), out(8, 'FLOOR6_2', { light: 180 }));
      warehouse(x0, y0, x0 + 480, y1, 'W', 2);
      warehouse(x0 + 544, y0, x1, y0 + 448, 'E', 1);
      crateStack(x1 - 192, y1 - 128, 64, 64, 8); crateStack(x1 - 128, y1 - 128, 64, 96, 8);
      crate(x0 + 640, y1 - 96);
      return;
    }
    case '5,1': {
      c.paint(rect(x0, y0, x1, y1), out(8, 'FLAT5_4', { light: 188 }));
      for (let k = 0; k < 3; k++) shop(x0 + k * 352, y0, x0 + k * 352 + 320, y0 + 448, 'S');
      c.paint(rect(x0, y1 - 256, x1, y1), yard);
      crate(x0 + 160, y1 - 128); crate(x1 - 160, y1 - 128);
      return;
    }
    case '5,2': {
      c.paint(rect(x0, y0, x1, y1), out(8, 'FLAT1', { light: 188 }));
      hall('clinic', x0, y0, x1, y0 + 448, 'S', { face: 'SILVER2', inner: 'GRAY7', fpic: 'FLAT18', cpic: 'CEIL3_4', light: 184, us: [0.25, 0.5, 0.75], frontDoors: [0.375], backDoors: [0.875], windowsFront: [0.125, 0.625, 0.875], crates: 3, lamp: 'TLITE6_5',
        furnish: (b, F) => { for (const u of [0.05, 0.3, 0.55, 0.8]) furn(b, F.L(snap(F.len * u) + 32, F.dep - 160, snap(F.len * u) + 96, F.dep - 48), 24, 'GRAY1', 'FLAT2'); } });
      house(x0, y1 - 288, x0 + 480, y1, 'N', 'left');
      house(x0 + 544, y1 - 288, x1, y1, 'N', 'right');
      return;
    }
    default: fourHouses();
  }
}

function bar(x0: number, y0: number, x1: number, y1: number, front: Side): Bld {
  return hall('bar', x0, y0, x1, y1, front, { face: 'BROWN96', inner: 'WOOD5', fpic: 'FLOOR0_2', cpic: 'CEIL3_2', light: 128, frontDoors: [0.5], backDoors: [0.25], windowsFront: [0.2, 0.8], crates: 2, lamp: 'TLITE6_1', lampSpecial: 17,
    furnish: (b, F) => { furn(b, F.L(64, F.dep - 128, F.len - 96, F.dep - 96), 40, 'WOOD12', 'FLAT5_1'); for (const u of [0.3, 0.6]) furn(b, F.L(snap(F.len * u), 112, snap(F.len * u) + 48, 160), 32, 'WOOD3', 'FLAT5_2'); } });
}

function warehouse(x0: number, y0: number, x1: number, y1: number, front: Side, n: number, f = 16): Bld {
  return hall('warehouse', x0, y0, x1, y1, front, { f, face: pick(['GRAY1', 'BROWN144', 'METAL', 'CEMENT1', 'BROWNHUG']), inner: 'GRAY7', fpic: 'FLAT5_4', cpic: 'CEIL5_1', light: 136, ceil: 240, doorW: 192, doorH: 160, frontDoors: [0.5], backDoors: [0.3], crates: n, lamp: 'TLITE6_5',
    furnish: (b, F) => {
      // crate stacks (CRATE1 / CRATOP2) with a climbable pallet stair on one of them
      const stack = (u: number, v: number, h: number) => c.paint(rect(...F.L(u, v, u + 64, v + 64)), { ...b.rm, floor: b.f + h, floorPic: 'CRATOP2', riser: 'CRATE1' });
      stack(64, F.dep - 128, 64); stack(128, F.dep - 128, 64); stack(64, F.dep - 192, 64);
      if (F.len > 400) { stack(F.len - 128, 96, 24); stack(F.len - 128, 160, 48); stack(F.len - 128, 224, 72); stack(F.len - 192, 224, 96); }
    } });
}

// ---- town square ---------------------------------------------------------------------------------
function square(): void {
  const X0 = -1280, X1 = 1280, Y0 = 0, Y1 = 896;
  c.paint(chamfer(X0, Y0, X1, Y1, 64), out(8, 'FLAT5_7', { light: 208, riser: 'STEP1' }));
  c.paint(chamfer(X0 + 192, Y0 + 128, X1 - 192, Y1 - 128, 128), out(8, 'FLOOR5_3', { light: 208, riser: 'STEP1' }));
  // the fountain: rim, water, statue on a plinth (landmark)
  const cx = 0, cy = 448;
  c.paint(oct(cx, cy, 256, 256), out(24, 'FLAT5_7', { riser: 'MARBLE1', light: 216 }));
  c.paint(oct(cx, cy, 224, 224), out(8, 'FWATER1', { riser: 'MARBLE1', light: 212 }));
  c.paint(oct(cx, cy, 80, 80), mass(48, 'MARBLE2', { floorPic: 'FLAT5_7', light: 220 }));
  c.paint(rect(cx - 24, cy - 24, cx + 24, cy + 24), mass(176, 'MARBLE3', { floorPic: 'FLAT5_7', light: 224 }));
  // market stalls (low counters) and benches
  for (const x of [-1024, -768, 640, 896]) {
    c.paint(rect(x, Y0 + 96, x + 128, Y0 + 144), mass(40, 'WOOD12', { floorPic: 'FLAT5_1', light: 200 }));
    c.paint(rect(x, Y1 - 144, x + 128, Y1 - 96), mass(40, 'WOOD12', { floorPic: 'FLAT5_1', light: 200 }));
  }
  for (const [x, y] of [[-1104, 192], [-1104, 640], [1072, 192], [1072, 640]]) c.paint(rect(x, y, x + 32, y + 96), mass(24, 'WOOD3', { floorPic: 'FLAT5_2', light: 200 }));
  for (const [x, y] of [[-960, 448], [960, 448]]) crate(x, y);
  for (const [x, y] of [[-320, 128], [320, 128], [-320, 768], [320, 768]]) th(x, y, T.FLOORLAMP);
  for (const [x, y] of [[-1152, 64], [1152, 64], [-1152, 832], [1152, 832]]) th(x, y, T.TREE_BIG);
  th(cx, cy - 288, T.SHOTGUN);
}

// ---- church --------------------------------------------------------------------------------------
function church(x0: number, y0: number, x1: number, y1: number): void {
  count('church');
  c.paint(rect(x0, y0, x1, y1), out(8, 'GRASS1', { light: 188, riser: 'STEP1' }));
  // cross-shaped: nave east–west, transept north–south; entrance in the west front
  const nave: R4 = [x0 + 64, y0 + 224, x1 - 32, y0 + 544];
  const tr: R4 = [x0 + 576, y0 + 32, x0 + 832, y1 - 32];
  const cy = (nave[1] + nave[3]) / 2;
  building({
    kind: 'church', rects: [nave, tr], face: 'STONE3', inner: 'STONE2', f: 24, ceil: 24 + 256, fpic: 'FLAT1_1', cpic: 'CEIL5_2', light: 136,
    doors: [{ side: 'W', at: snap(cy, 8), w: 128, h: 144 }, { side: 'N', at: (tr[0] + tr[2]) / 2, r: 1 }, { side: 'S', at: (tr[0] + tr[2]) / 2, r: 1 }],
    windows: [{ side: 'N', at: x0 + 224, w: 64 }, { side: 'N', at: x0 + 416, w: 64 }, { side: 'S', at: x0 + 224, w: 64 }, { side: 'S', at: x0 + 416, w: 64 }, { side: 'E', at: snap(cy, 8), w: 64 }],
    lamp: 'CEIL5_1', crates: 2,
    furnish: (b) => {
      // pews, columns, the altar on a dais under a glowing light
      for (let x = x0 + 192; x <= x0 + 448; x += 128) for (const y of [nave[1] + 64, cy + 48]) furn(b, [x, y, x + 64, y + 64], 16, 'WOOD12', 'FLAT5_1');
      for (let x = x0 + 160; x <= x0 + 480; x += 160) for (const y of [nave[1] + 40, nave[3] - 56]) c.paint(rect(x, y, x + 16, y + 16), solid('MARBLE1'));
      furn(b, [x1 - 224, nave[1] + 48, x1 - 64, nave[3] - 48], 16, 'STEP6', 'FLOOR5_3', { light: 176, special: 8 });
      furn(b, [x1 - 160, cy - 64, x1 - 64, cy + 64], 32, 'STEP6', 'FLOOR5_3', { light: 192, special: 8 });
      furn(b, [x1 - 112, cy - 32, x1 - 80, cy + 32], 72, 'MARBLE2', 'FLAT5_7', { light: 192, special: 8 });
      th(x1 - 140, cy - 80, T.CANDELABRA); th(x1 - 140, cy + 80, T.CANDELABRA);
    },
  });
  // bell tower beside the west front, graves in the churchyard
  c.paint(rect(x0 + 64, y0 + 560, x0 + 256, y0 + 736), mass(SKYZ, 'STONE3', { floorPic: 'FLAT1', light: 184 }));
  c.paint(rect(x0 + 96, y0 + 592, x0 + 224, y0 + 704), mass(SKYZ, 'STONE2', { floorPic: 'FLAT1', light: 184 }));
  for (let k = 0; k < 6; k++) {
    const gx = x0 + 896 + (k % 2) * 80, gy = y0 + 40 + Math.floor(k / 2) * 56;
    c.paint(rect(gx, gy, gx + 32, gy + 16), mass(40, 'GSTONE1', { floorPic: 'FLAT5_7', light: 188 }));
  }
  th(x0 + 32, snap(cy, 8) - 96, T.TORCH_GREEN); th(x0 + 32, snap(cy, 8) + 96, T.TORCH_GREEN);
}

// ---- office block: tower lobby + podium roof terrace reached by stairs ------------------------------
function office(x0: number, y0: number, x1: number, y1: number): void {
  count('office');
  c.paint(rect(x0, y0, x1, y1), out(8, 'FLAT1', { light: 192, riser: 'STEP1' }));
  const tx1 = x0 + 512; // tower x0..tx1, podium tx1..x1
  const face = 'STARGR2';
  const B = building({
    kind: 'office', rects: [[x0, y0, tx1, y1]], face, inner: 'GRAY7', f: 16, ceil: 176, fpic: 'FLOOR0_3', cpic: 'CEIL3_4', light: 176,
    doors: [{ side: 'W', at: snap((y0 + y1) / 2 + 64, 8), w: 128 }, { side: 'S', at: x0 + 256, w: 128 }],
    windows: [{ side: 'N', at: x0 + 128, w: 64 }, { side: 'N', at: x0 + 384, w: 64 }, { side: 'W', at: y0 + 160, w: 64 }, { side: 'W', at: y1 - 128, w: 64 }],
    hy: [y1 - 288], lamp: 'TLITE6_5', crates: 2,
    furnish: (b) => {
      furn(b, [x0 + 160, y0 + 256, x0 + 352, y0 + 288], 40, 'WOOD12', 'FLAT5_1'); // reception desk
      for (const [x, y] of [[x0 + 96, y0 + 384], [x0 + 400, y0 + 384]]) c.paint(rect(x, y, x + 32, y + 32), solid('SUPPORT2'));
      // cubicles upstairs-feel in the back room
      for (const x of [x0 + 96, x0 + 288]) furn(b, [x, y1 - 192, x + 128, y1 - 160], 48, 'CUBICLE', 'FLAT1');
    },
  });
  // podium: parapet mass, the terrace (floor 192, sky) and the stair house along the south side
  const RT = 192;
  c.paint(rect(tx1, y0, x1, y1), mass(RT + 32, face, { floorPic: 'FLAT1', light: 184 }));
  c.paint(rect(tx1, y0 + 224, x1 - 16, y1 - 16), out(RT, 'FLOOR0_3', { light: 212, riser: face }));
  c.paint(rect(tx1, y0, x1, y0 + 224), mass(SKYZ, face, { floorPic: 'FLAT1', light: 184 }));
  const st = (z: number) => room(z, z + 120, 'FLOOR0_3', 'CEIL3_4', 168, { riser: 'STEP2', upper: 'GRAY7', wall: 'GRAY7' });
  c.paint(rect(tx1 - 32, y0 + 32, tx1, y0 + 160), st(16)); // door from the lobby
  doorPts.push([tx1 - 16, y0 + 96]);
  c.paint(rect(tx1, y0 + 32, tx1 + 32, y0 + 192), st(16));
  stairs(c, tx1 + 32, y0 + 32, tx1 + 352, y0 + 192, 'E', [38, 60, 82, 104, 126, 148, 170, RT], (z) => st(z));
  c.paint(rect(tx1 + 352, y0 + 32, x1 - 32, y0 + 192), st(RT));
  c.paint(rect(tx1 + 352, y0 + 192, x1 - 32, y0 + 224), room(RT, RT + 112, 'FLOOR0_3', 'CEIL3_4', 176, { upper: face, riser: 'STEP2' }));
  doorPts.push([tx1 + 416, y0 + 208]);
  // the terrace: sandbags, planters, a lamp, loot worth the climb
  c.paint(rect(tx1 + 96, y1 - 160, tx1 + 224, y1 - 128), mass(RT + 40, 'CEMENT7', { floorPic: 'FLAT1', light: 208 }));
  c.paint(rect(x1 - 160, y0 + 320, x1 - 96, y0 + 448), mass(RT + 24, 'BRICK10', { floorPic: 'GRASS1', light: 208 }));
  crate(tx1 + 160, y0 + 320); crate(x1 - 96, y1 - 96);
  th(tx1 + 64, y1 - 64, T.TECHLAMP2);
  th(tx1 + 320, y1 - 256, T.CHAINGUN);
  th(tx1 + 256, y1 - 96, T.GREENARMOR);
  void B;
}

function townHall(x0: number, y0: number, x1: number, y1: number): void {
  c.paint(rect(x0, y0, x1, y1), out(8, 'FLAT5_7', { light: 196 }));
  // steps up to the entrance
  c.paint(rect(x0 + 384, y0, x0 + 640, y0 + 64), out(16, 'FLAT5_7', { light: 200, riser: 'STEP6' }));
  hall('townhall', x0 + 64, y0 + 64, x1 - 64, y1 - 32, 'S', { f: 24, face: 'MARBGRAY', inner: 'PANEL5', fpic: 'FLOOR1_6', cpic: 'CEIL3_5', light: 160, ceil: 224, us: [0.25, 0.75], frontDoors: [0.5], backDoors: [0.12, 0.88], sideDoors: ['left', 'right'], windowsFront: [0.12, 0.35, 0.65, 0.88], doorW: 160, doorH: 144, crates: 3, lamp: 'TLITE6_6',
    furnish: (b, F) => {
      for (const u of [0.35, 0.65]) for (const v of [0.3, 0.7]) c.paint(rect(...F.L(snap(F.len * u) - 16, snap(F.dep * v) - 16, snap(F.len * u) + 16, snap(F.dep * v) + 16)), solid('MARBLE1'));
      furn(b, F.L(snap(F.len * 0.4), F.dep - 160, snap(F.len * 0.6), F.dep - 96), 24, 'WOOD12', 'FLAT5_1');
    } });
}

// ---- the river and bridges -------------------------------------------------------------------------
const RIVER: Pt[] = [[-W, -2816], [-5376, -2816], [-4736, -3456], [2560, -3456], [3200, -2816], [W, -2816]];
function band(h: number, st: Style): void {
  for (let i = 0; i + 1 < RIVER.length; i++) {
    const [ax, ay] = RIVER[i], [bx, by] = RIVER[i + 1];
    if (ay === by) c.paint(rect(ax, ay - h, bx, by + h), st);
    else c.paint(poly([[ax, ay - h], [bx, by - h], [bx, by + h], [ax, ay + h]]), st);
    if (i > 0) c.paint(oct(ax, ay, h, h), st);
  }
}
function river(): void {
  band(320, out(0, 'FLOOR7_1', { light: 200, riser: 'A-MOSROK' }));
  band(256, out(-24, 'FLOOR7_1', { light: 192, riser: 'A-MOSROK' }));
  band(192, out(RIVER_Z, 'FWATER1', { light: 184, riser: 'A-MOSROK' }));
}
function bridges(): void {
  const deck = (x: number, y: number, w: number, pic: string, rail: string, light = 208) => {
    c.paint(rect(x - w / 2, y - 352, x + w / 2, y + 352), out(0, pic, { light, riser: rail }));
    c.paint(rect(x - w / 2, y - 288, x - w / 2 + 24, y + 288), mass(40, rail, { floorPic: pic, light }));
    c.paint(rect(x + w / 2 - 24, y - 288, x + w / 2, y + 288), mass(40, rail, { floorPic: pic, light }));
  };
  deck(0, -3456, 384, 'FLOOR6_2', 'STONE3');       // main road bridge
  deck(-6400, -2816, 320, 'FLAT5_7', 'STONE3');    // west (stone)
  deck(5888, -2816, 320, 'FLOOR6_2', 'STONE3');    // east road
  deck(-2560, -3456, 160, 'FLOOR4_1', 'WOOD1');    // footbridges (wood)
  deck(1792, -3456, 160, 'FLOOR4_1', 'WOOD1');
  for (const [x, y] of [[-160, -3824], [160, -3088], [-6528, -3184], [6016, -2448]]) th(x, y, T.FLOORLAMP);
  // stepping stones (a ford) in the east
  for (let k = 0; k < 4; k++) c.paint(rect(4224 + k * 8, -2992 + k * 96, 4288 + k * 8, -2928 + k * 96), out(-24, 'RROCK09', { riser: 'ROCK3', light: 196 }));
}

// ---- outskirts ---------------------------------------------------------------------------------
function factory(x0: number, y0: number, x1: number, y1: number): void {
  count('compound');
  const ground = out(0, 'FLAT5_4', { light: 180, riser: 'STEP1' });
  compound(x0, y0, x1, y1, [{ side: 'E', at: 1024 }, { side: 'S', at: -6400 }, { side: 'N', at: -6144 }], 'CEMENT1', ground);
  // the main hall
  hall('factory', x0 + 256, y0 + 256, x0 + 1792, y0 + 1536, 'N', {
    face: 'BRICK10', inner: 'METAL', fpic: 'FLOOR0_7', cpic: 'CEIL5_1', light: 144, ceil: 256, doorW: 192, doorH: 176, frontDoors: [0.25, 0.75], backDoors: [], sideDoors: ['right', 'left'],
    windowsFront: [0.5], us: [0.82], crates: 6, lamp: 'TLITE6_4', lampSpecial: 17,
    furnish: (b, F) => {
      // machines, a conveyor, columns
      for (const [u, v] of [[160, 320], [480, 320], [800, 320], [160, 704], [480, 704]]) furn(b, F.L(u, v, u + 160, v + 128), 56, 'METAL2', 'FLAT23');
      furn(b, F.L(96, 560, 1120, 608), 24, 'STEP4', 'FLAT23');
      for (const u of [352, 672, 992]) for (const v of [224, 896]) c.paint(rect(...F.L(u, v, u + 32, v + 32)), solid('SUPPORT3'));
      // a mezzanine along the back wall, reached by stairs (24 per step)
      const z = b.f;
      c.paint(rect(...F.L(96, F.dep - 224, 896, F.dep - 32)), { ...b.rm, floor: z + 96, floorPic: 'FLOOR0_3', riser: 'METAL' });
      for (let k = 0; k < 4; k++) c.paint(rect(...F.L(896 + k * 48, F.dep - 224, 944 + k * 48, F.dep - 96)), { ...b.rm, floor: z + 96 - (k + 1) * 24 + 24, floorPic: 'FLOOR0_3', riser: 'STEP4' });
    },
  });
  // office annex, workshop
  hall('factory offices', x0 + 2048, y0 + 256, x0 + 2368, y0 + 1024, 'W', { face: 'BRICK10', inner: 'PANEL4', fpic: 'FLOOR4_6', cpic: 'CEIL3_5', light: 152, us: [0.5], frontDoors: [0.25, 0.75], windowsBack: [0.25, 0.75], crates: 2, lamp: 'FLAT17' });
  hall('workshop', x0 + 256, y1 - 1152, x0 + 1280, y1 - 384, 'E', { face: 'BROWN144', inner: 'GRAY1', fpic: 'FLAT5_4', cpic: 'CEIL5_1', light: 136, ceil: 208, doorW: 192, doorH: 160, frontDoors: [0.5], backDoors: [], sideDoors: ['left'], crates: 3, lamp: 'TLITE6_5',
    furnish: (b, F) => { for (const u of [128, 448]) furn(b, F.L(u, 160, u + 192, 224), 40, 'METAL2', 'FLAT23'); } });
  // chimney, storage tanks, containers, crate stacks
  c.paint(oct(x0 + 2112, y0 + 1856, 96, 96), mass(SKYZ, 'BRICK10', { floorPic: 'FLAT1', light: 176 }));
  for (const [x, y] of [[x0 + 1664, y1 - 512], [x0 + 2048, y1 - 512]]) c.paint(oct(x, y, 160, 160), mass(208, 'METAL2', { floorPic: 'FLAT23', light: 184 }));
  for (const [x, y] of [[x0 + 1600, y0 + 1792], [x0 + 1600, y0 + 2048]]) c.paint(rect(x, y, x + 320, y + 128), mass(128, 'CRATWIDE', { floorPic: 'CRATOP1', light: 184 }));
  crateStack(x0 + 2112, y0 + 1280, 64, 64); crateStack(x0 + 2176, y0 + 1280, 64, 32); crateStack(x0 + 2112, y0 + 1216, 64, 96);
  for (const [x, y] of [[x0 + 1984, y0 + 1600], [x0 + 1440, y1 - 192], [x0 + 2240, y1 - 192], [x0 + 128, y0 + 1792]]) crate(x, y);
  for (const [x, y] of [[x0 + 2400, y0 + 128], [x0 + 128, y1 - 128], [x0 + 2400, y1 - 128], [x0 + 1920, y0 + 128]]) th(x, y, T.TECHLAMP2);
  th(x0 + 1920, y0 + 1600, T.BURNBARREL);
}

function depot(x0: number, y0: number, x1: number, y1: number): void {
  count('compound');
  const ground = out(0, 'FLAT5_4', { light: 184, riser: 'STEP1' });
  compound(x0, y0, x1, y1, [{ side: 'W', at: 1024 }, { side: 'S', at: 5888 }, { side: 'N', at: 6144 }], 'BROWN144', ground, 144);
  warehouse(x0 + 384, y0 + 256, x0 + 1664, y0 + 1152, 'N', 4, 16);
  warehouse(x0 + 384, y1 - 1024, x0 + 1408, y1 - 256, 'S', 3, 16);
  warehouse(x1 - 640, y1 - 1408, x1 - 256, y1 - 256, 'W', 2, 16);
  // tracks east–west with wagons
  for (const ty of [1408, 1664]) {
    c.paint(rect(x0 + 32, ty, x1 - 32, ty + 128), out(0, 'FLOOR6_2', { light: 188 }));
    c.paint(rect(x0 + 32, ty + 24, x1 - 32, ty + 40), out(0, 'FLAT23', { light: 192 }));
    c.paint(rect(x0 + 32, ty + 88, x1 - 32, ty + 104), out(0, 'FLAT23', { light: 192 }));
  }
  for (const [x, ty, len] of [[x0 + 256, 1408, 448], [x0 + 1408, 1664, 384], [x0 + 1920, 1408, 320]] as [number, number, number][]) {
    c.paint(rect(x, ty + 8, x + len, ty + 120), mass(80, len > 400 ? 'CRATWIDE' : 'CRATE2', { floorPic: 'CRATOP1', light: 184 }));
  }
  // container yard
  for (const [x, y] of [[x1 - 640, y0 + 256], [x1 - 640, y0 + 448]]) c.paint(rect(x, y, x + 384, y + 128), mass(128, 'CRATWIDE', { floorPic: 'CRATOP1', light: 184 }));
  crateStack(x1 - 192, y0 + 256, 64, 64); crateStack(x1 - 192, y0 + 320, 64, 32);
  for (const [x, y] of [[x1 - 448, y0 + 704], [x0 + 1920, y0 + 256], [x0 + 1920, y0 + 1088], [x0 + 192, y1 - 128]]) crate(x, y);
  for (const [x, y] of [[x0 + 128, y0 + 128], [x1 - 128, y1 - 128], [x0 + 1792, y0 + 1280], [x1 - 128, y0 + 128]]) th(x, y, T.TECHLAMP2);
}

function farm(cx: number, cy: number, north: boolean): void {
  count('farm');
  const s = north ? 1 : -1;
  // fields: crop stripes, fenced
  const fx0 = cx - 2048, fx1 = cx + 896, fy0 = north ? cy + 768 : cy - 1792, fy1 = north ? cy + 1792 : cy - 768;
  c.paint(rect(fx0 - 32, fy0 - 32, fx1 + 32, fy1 + 32), mass(40, 'WOOD9', { floorPic: 'FLAT5_2', light: 196 }));
  for (let x = fx0, k = 0; x < fx1; x += 128, k++) c.paint(rect(x, fy0, Math.min(fx1, x + 128), fy1), out(0, k % 2 ? 'FLOOR7_1' : 'GRASS1', { light: 204, riser: 'WOOD9' }));
  c.paint(rect(cx - 704, north ? fy0 - 32 : fy1, cx - 448, north ? fy0 : fy1 + 32), out(0, 'FLAT10', { light: 200 }));
  // farmyard
  c.paint(rect(cx - 1024, cy - 640, cx + 1024, cy + 640), out(0, 'FLAT10', { light: 200, riser: 'STEP1' }));
  house(cx - 960, cy - 512, cx - 448, cy - 96, north ? 'S' : 'N', 'left', 16);
  const barn = hall('barn', cx - 256, cy - 384, cx + 640, cy + 448, 'W', { face: 'A-MYWOOD', inner: 'WOOD5', fpic: 'FLOOR4_1', cpic: 'CEIL1_1', light: 128, ceil: 256, doorW: 192, doorH: 176, frontDoors: [0.5], backDoors: [0.5], crates: 3, lamp: 'CEIL1_3',
    furnish: (b, F) => {
      // stalls and a hay loft reached by bale steps
      for (const u of [96, 352, 608]) c.paint(rect(...F.L(u, F.dep - 224, u + 16, F.dep - 32)), solid('WOOD5'));
      for (let k = 0; k < 4; k++) c.paint(rect(...F.L(64, 96 + k * 48, 192, 144 + k * 48)), { ...b.rm, floor: b.f + 24 * (k + 1), floorPic: 'CRATOP2', riser: 'CRATE1' });
    } });
  void barn;
  // silo, a water trough, tractor (crates)
  c.paint(oct(cx + 832, cy - 448 * s, 128, 128), mass(SKYZ, 'METAL1', { floorPic: 'FLAT23', light: 184 }));
  c.paint(rect(cx - 896, cy + 64 * s, cx - 640, cy + 128 * s), mass(32, 'METAL2', { floorPic: 'FWATER1', light: 196 }));
  crateStack(cx - 320, cy + 512 * s - 32, 64, 48);
  crate(cx - 640, cy + 384 * s); crate(cx + 832, cy + 128 * s);
  th(cx - 384, cy + 256 * s, T.BURNBARREL);
}

function radioStation(cx: number, cy: number): void {
  count('compound');
  const top = 96;
  const ground = out(top, 'FLAT5_4', { light: 196, riser: 'STEP1' });
  compound(cx - 640, cy - 512, cx + 640, cy + 512, [{ side: 'S', at: cx - 384 }, { side: 'W', at: cy }], 'CEMENT7', ground, 128);
  hall('radio station', cx - 512, cy - 384, cx, cy + 128, 'E', { f: top + 16, face: 'CEMENT1', inner: 'COMPTILE', fpic: 'FLOOR0_3', cpic: 'CEIL3_4', light: 168, us: [0.5], frontDoors: [0.25], backDoors: [0.75], windowsFront: [0.75], crates: 3, lamp: 'TLITE6_5',
    furnish: (b, F) => { furn(b, F.L(256, F.dep - 96, 480, F.dep - 64), 48, 'COMPSTA1', 'FLAT14'); } });
  hall('barracks', cx + 128, cy + 64, cx + 576, cy + 448, 'S', { f: top + 16, face: 'A-BRICK1', inner: 'GRAY1', fpic: 'FLAT5_4', cpic: 'CEIL5_1', light: 144, us: [0.5], frontDoors: [0.25, 0.75], crates: 2, lamp: 'TLITE6_5' });
  // the mast
  c.paint(rect(cx + 256, cy - 320, cx + 320, cy - 256), mass(SKYZ, 'SUPPORT3', { floorPic: 'FLAT23', light: 200 }));
  for (const [x, y] of [[cx + 224, cy - 352], [cx + 352, cy - 352], [cx + 224, cy - 224], [cx + 352, cy - 224]]) th(x, y, T.TECHCOL);
  crateStack(cx + 448, cy - 448, 64, 64, top);
  crate(cx + 448, cy - 160); crate(cx - 448, cy + 320);
  th(cx + 64, cy - 448, T.TECHLAMP);
}

function pond(cx: number, cy: number): void {
  c.paint(oct(cx, cy, 704, 512), out(0, 'FLOOR7_1', { light: 204, riser: 'A-MOSROK' }));
  c.paint(oct(cx, cy, 640, 448), out(-16, 'FLOOR7_1', { light: 200, riser: 'A-MOSROK' }));
  c.paint(oct(cx, cy, 576, 384), out(-32, 'FWATER1', { light: 196, riser: 'A-MOSROK' }));
  // jetty
  c.paint(rect(cx - 640, cy - 48, cx - 256, cy + 48), out(0, 'FLOOR4_1', { light: 204, riser: 'WOOD1' }));
  crate(cx - 320, cy);
  // cabins
  for (const [x, y, f] of [[cx - 1280, cy + 768, 'S'], [cx + 640, cy + 704, 'S'], [cx + 1088, cy - 896, 'W']] as [number, number, Side][]) {
    hall('cabin', x, y, x + 416, y + 320, f, { face: 'WOOD1', inner: 'WOOD3', fpic: 'FLOOR4_1', cpic: 'CEIL1_1', light: 136, frontDoors: [0.3], windowsFront: [0.75], windowsBack: [0.5], crates: 1, lamp: 'FLAT17' });
  }
  th(cx - 896, cy - 512, T.BURNBARREL);
}

function armyBase(cx: number, cy: number): void {
  count('compound');
  const ground = out(0, 'FLAT5_4', { light: 188, riser: 'STEP1' });
  const x0 = cx - 1536, x1 = cx + 1536, y0 = cy - 1280, y1 = cy + 1280;
  compound(x0, y0, x1, y1, [{ side: 'N', at: cx }, { side: 'E', at: cy - 512 }, { side: 'W', at: cy + 384 }], 'CEMENT7', ground, 160);
  hall('barracks', x0 + 192, y0 + 256, x0 + 1152, y0 + 768, 'N', { face: 'A-CAMO1', inner: 'GRAY1', fpic: 'FLAT5_4', cpic: 'CEIL5_1', light: 144, us: [0.33, 0.67], frontDoors: [0.17, 0.83], backDoors: [0.5], windowsFront: [0.5], crates: 3, lamp: 'TLITE6_5',
    furnish: (b, F) => { for (const u of [0.05, 0.38, 0.71]) furn(b, F.L(snap(F.len * u) + 16, F.dep - 160, snap(F.len * u) + 112, F.dep - 96), 24, 'WOOD12', 'FLAT5_2'); } });
  hall('barracks', x1 - 1152, y0 + 256, x1 - 192, y0 + 768, 'N', { face: 'A-CAMO1', inner: 'GRAY1', fpic: 'FLAT5_4', cpic: 'CEIL5_1', light: 144, us: [0.33, 0.67], frontDoors: [0.17, 0.83], backDoors: [0.5], windowsFront: [0.5], crates: 3, lamp: 'TLITE6_5' });
  hall('army hq', cx - 448, cy + 384, cx + 448, cy + 960, 'S', { face: 'BIGBRIK2', inner: 'GRAY7', fpic: 'FLOOR0_3', cpic: 'CEIL3_4', light: 160, us: [0.33, 0.67], vs: [0.55], frontDoors: [0.5], sideDoors: ['left', 'right'], windowsFront: [0.17, 0.83], crates: 4, lamp: 'TLITE6_5' });
  // guard towers: platforms reached by stairs, sandbags on top
  for (const [tx, ty] of [[x0 + 128, y1 - 448], [x1 - 384, y1 - 448]]) {
    c.paint(rect(tx, ty, tx + 256, ty + 256), out(72, 'FLAT23', { riser: 'METAL', light: 200 }));
    stairs(c, tx + 64, ty - 192, tx + 192, ty, 'N', [24, 48], (z) => out(z, 'FLAT23', { riser: 'STEP4', light: 196 }));
    c.paint(rect(tx, ty + 224, tx + 256, ty + 256), mass(112, 'CEMENT7', { floorPic: 'FLAT1', light: 196 }));
  }
  // helipad and sandbag walls, crates of supplies
  c.paint(oct(cx, cy - 192, 256, 256), out(0, 'FLAT22', { light: 204 }));
  for (const [a, b, d, e] of [[cx - 896, cy - 128, cx - 640, cy - 96], [cx + 640, cy - 128, cx + 896, cy - 96], [cx - 128, y1 - 320, cx + 128, y1 - 288]]) c.paint(rect(a, b, d, e), mass(40, 'CEMENT7', { floorPic: 'FLAT1', light: 196 }));
  crateStack(cx + 896, cy + 512, 64, 64); crateStack(cx + 960, cy + 512, 64, 96); crateStack(cx + 896, cy + 576, 64, 32);
  for (const [x, y] of [[cx - 960, cy + 256], [cx + 640, cy + 256], [cx - 256, cy - 640], [cx + 256, cy - 640]]) crate(x, y);
  th(cx, cy - 192, T.CHAINGUN);
  for (const [x, y] of [[x0 + 96, y0 + 96], [x1 - 96, y0 + 96], [x0 + 96, y1 - 96], [x1 - 96, y1 - 96], [cx - 160, y1 - 96], [cx + 160, y1 - 96]]) th(x, y, T.TECHLAMP2);
}

function gasStation(cx: number, cy: number): void {
  count('gas station');
  c.paint(rect(cx - 896, cy - 512, cx - 128, cy + 512), out(0, 'FLAT5_4', { light: 200, riser: 'STEP1' }));
  shop(cx - 832, cy + 64, cx - 384, cy + 448, 'S', 16);
  // pumps
  for (const y of [cy - 320, cy - 96]) c.paint(rect(cx - 448, y, cx - 384, y + 64), mass(56, 'SILVER1', { floorPic: 'FLAT23', light: 216 }));
  for (const [x, y] of [[cx - 640, cy - 448], [cx - 192, cy + 448]]) th(x, y, T.FLOORLAMP);
  crate(cx - 704, cy - 256);
  // the motel: a row of rooms, each with its own door
  hall('motel', cx - 1792, cy - 1536, cx + 640, cy - 1024, 'N', { face: 'STUCCO1', inner: 'PANEL7', fpic: 'FLOOR6_1', cpic: 'CEIL3_5', light: 140, us: [0.2, 0.4, 0.6, 0.8], noGaps: true, frontDoors: [0.1, 0.3, 0.5, 0.7, 0.9], doorW: 96, windowsBack: [0.1, 0.5, 0.9], crates: 4, lamp: 'FLAT17',
    furnish: (b, F) => { for (const u of [0.02, 0.22, 0.42, 0.62, 0.82]) furn(b, F.L(snap(F.len * u) + 32, F.dep - 192, snap(F.len * u) + 160, F.dep - 64), 24, 'WOOD3', 'FLOOR6_1'); } });
  c.paint(rect(cx - 1792, cy - 1024, cx + 640, cy - 896), out(8, 'FLAT1', { light: 200, riser: 'STEP1' }));
}

function hutAt(x: number, y: number): void {
  hall('hut', x, y, x + 320, y + 256, 'S', { f: 16 + ((c.at(x + 160, y + 128) as Style).floor ?? 0), face: 'WOOD1', inner: 'WOOD3', fpic: 'FLOOR4_1', cpic: 'CEIL1_1', light: 128, frontDoors: [0.5], windowsBack: [0.5], crates: 2, lamp: 'FLAT17' });
}

// ---- loot and starts -------------------------------------------------------------------------------
function loot(): void {
  const placed: Pt[] = [];
  const at = (x: number, y: number, t: number) => { x = snap(x, 8); y = snap(y, 8); if (inLobbyRing(x, y, 64) || free(x, y, 48) === null || near(crates, x, y, 56) || near(placed, x, y, 48)) return false; placed.push([x, y]); th(x, y, t); return true; };
  // indoors: something in most buildings
  for (const b of blds) {
    const [a, bb, d, e] = b.cells[Math.floor(R() * b.cells.length)];
    const t = pick([T.HBONUS, T.HBONUS, T.ABONUS, T.ABONUS, T.CLIP, T.CLIP, T.SHELLS, T.STIM]);
    for (let k = 0; k < 6 && !at(a + (d - a) * (0.3 + R() * 0.4), bb + (e - bb) * (0.3 + R() * 0.4), t); k++);
  }
  // outdoors: sparse bonuses, clips, a few shotguns and chainguns
  const table: [number, number][] = [[T.HBONUS, 45], [T.ABONUS, 45], [T.CLIP, 35], [T.SHELLS, 12], [T.STIM, 8], [T.SHOTGUN, 10], [T.CHAINGUN, 4], [SNIPER, 5], [GRENADES, 10]];
  for (const [t, n] of table) {
    for (let k = 0, tries = 0; k < n && tries < n * 50; tries++) {
      const x = (R() * 2 - 1) * 7200, y = (R() * 2 - 1) * 7200;
      if (at(x, y, t)) k++;
    }
  }
}

function starts(): void {
  // a jittered 9 × 9 grid over the valley; each cell takes the first good spot near its centre
  const pts: Pt[] = [];
  const N = 9, span = 7168 * 2 / N;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const cx = -7168 + (i + 0.5) * span, cy = -7168 + (j + 0.5) * span;
    let ok = false;
    for (let r = 0; r < 640 && !ok; r += 64) {
      for (let k = 0; k < 8 && !ok; k++) {
        const a = (k / 8) * Math.PI * 2 + r;
        const x = snap(cx + Math.cos(a) * r, 8), y = snap(cy + Math.sin(a) * r, 8);
        const s = c.at(x, y) as Style;
        if (nearLobby(x, y) || (s as unknown as Solid).solid || /WATER/.test(s.floorPic)) continue;
        if (free(x, y, 48) === null || near(crates, x, y, 128) || near(doorPts, x, y, 128) || near(pts, x, y, 256)) continue;
        if (c.things.some((t) => Math.hypot(t.x - x, t.y - y) < 72)) continue;
        pts.push([x, y]);
        th(x, y, START, Math.floor(R() * 8) * 45);
        ok = true;
      }
    }
  }
}

// ---- lobby island ------------------------------------------------------------------------------------
// The 45 s wait before the drop (fists only, nothing takes damage, punches shove twice as
// hard): a 2816 × 1152 island in the SE corner, walled by solid rock on three sides and a
// 256-high stone rim on the north (low enough to see the town over from the lookout,
// out of reach from anywhere in the lobby; nothing outside can climb it either).
//   west    the obstacle course: stepping stones over a (harmless) nukage pit, stairs to a
//           32-wide ledge, a jump-up block (+40), a gap jump, the finish platform with a
//           WR teleporter back to the start
//   middle  the boxing ring: an octagon raised over a nukage moat, no ropes — punch them
//           off; glowing carpet, red corner posts, two blue beacons, banners
//   east    a crate-stack maze (a teleporter in its far cell to the top of the slide), the
//           slide (8-unit steps) down into the pool, the lookout tower (240) with a WR lift
// 72+ lobby spots (9030) spread over the open floor.
const TAG_TP_START = 1, TAG_TP_SLIDE = 2, TAG_LIFT = 3;
function lobby(): void {
  const playR = R;
  R = rng(9030); // its own random stream: the playfield's loot / starts don't shift with it
  try { lobbyIsland(); } finally { R = playR; }
}
function lobbyIsland(): void {
  const [x0, y0, x1, y1] = LOBBY;
  c.paint(rect(...LOBBY_RING), solid('STONE2'));
  // the north rim borders the playfield (the strip behind the motel), the island inside
  c.paint(rect(x0, y1, x1, LOBBY_RING[3]), mass(256, 'STONE3', { floorPic: 'FLAT1', light: 192 }));
  const ground = out(0, 'FLAT5_4', { light: 200, riser: 'STEP1' });
  c.paint(rect(x0, y0, x1, y1), ground);
  c.modify(rect(x0 + 64, y0 + 64, x1 - 64, y1 - 64), withProps({ floorPic: 'FLOOR0_3', light: 208 }));
  // banners on the rim and the walls
  for (let x = x0 + 192; x < x1 - 128; x += 384) c.paint(rect(x, y1 - 16, x + 64, y1), mass(224, (x / 384) % 2 ? 'PANRED' : 'PANBLUE', { floorPic: 'FLAT1', light: 224 }));
  for (let x = x0 + 384; x < x1 - 128; x += 768) c.paint(rect(x, y0, x + 64, y0 + 16), mass(224, 'PANRED', { floorPic: 'FLAT1', light: 224 }));

  // ==== west: the obstacle course =====================================================
  const course = (z: number, pic = 'FLAT1', o: Partial<Style> = {}) => out(z, pic, { light: 200, riser: 'METAL', ...o });
  // start pad (teleport destination 1)
  c.paint(rect(x0 + 64, y1 - 192, x0 + 320, y1 - 64), out(0, 'FLOOR1_1', { light: 224, riser: 'STEP1', tag: TAG_TP_START }));
  th(x0 + 192, y1 - 128, 14, 270);
  th(x0 + 96, y1 - 96, T.TECHLAMP2); th(x0 + 288, y1 - 96, T.TECHLAMP2);
  // the nukage pit (harmless in the lobby) with a ledge to climb out anywhere, stones across
  const pit: R4 = [x0 + 64, y0 + 320, x0 + 832, y1 - 288];
  c.paint(rect(pit[0] - 32, pit[1] - 32, pit[2] + 32, pit[3] + 32), out(-16, 'FLOOR7_1', { light: 192, riser: 'NUKEDGE1' }));
  c.paint(rect(...pit), out(-40, 'NUKAGE1', { light: 224, riser: 'NUKEDGE1' }));
  // stones north → south (gaps of 32..96: the wide ones want a running jump)
  const stones: Pt[] = [[x0 + 128, y1 - 352], [x0 + 224, y1 - 448], [x0 + 128, y1 - 576], [x0 + 256, y1 - 672], [x0 + 352, y1 - 768]];
  for (const [sx, sy] of stones) c.paint(rect(sx, sy, sx + 64, sy + 64), course(0, 'FLAT5_7', { riser: 'ROCK3' }));
  // a second, harder line of single stones east–west across the pit (96 apart)
  for (let k = 0; k < 5; k++) { const sx = x0 + 448 + k * 96; c.paint(rect(sx, y1 - 480, sx + 48, y1 - 432), course(0, 'FLAT5_7', { riser: 'ROCK3' })); }
  // the climb: stairs up to a 32-wide ledge at 72 along the pit's east side
  const cx0 = x0 + 864;
  stairs(c, x0 + 640, y0 + 64, cx0, y0 + 192, 'E', [24, 48, 72], (z) => course(z, 'FLAT23', { riser: 'STEP4' }));
  c.paint(rect(cx0, y0 + 64, cx0 + 32, y1 - 448), course(72, 'FLAT23'));
  // jump-up block (+40: needs the jump button), a gap, the finish (+24)
  c.paint(rect(cx0 - 32, y1 - 448, cx0 + 32, y1 - 384), course(112, 'FLAT23'));
  c.paint(rect(cx0 - 96, y1 - 288, cx0 + 32, y1 - 160), course(112, 'FLAT23'));
  c.paint(rect(cx0 - 96, y1 - 160, cx0 + 32, y1 - 64), course(136, 'FLAT1', { light: 224 }));
  c.paint(rect(cx0 - 64, y1 - 144, cx0, y1 - 80), out(136, 'GATE3', { light: 255, riser: 'METAL', line: { special: 97, tag: TAG_TP_START } }));
  th(cx0 + 16, y1 - 80, T.TECHLAMP2);

  // ==== middle: the boxing ring ========================================================
  const rx = snap(x0 + 1408), ry = snap((y0 + y1) / 2);
  c.paint(oct(rx, ry, 480, 480), out(-16, 'FLOOR7_1', { light: 200, riser: 'NUKEDGE1' }));
  c.paint(oct(rx, ry, 448, 448), out(-40, 'NUKAGE1', { light: 216, riser: 'NUKEDGE1' }));
  c.paint(oct(rx, ry, 320, 320), out(32, 'FLAT14', { light: 232, riser: 'METAL', special: 8 }));
  c.paint(oct(rx, ry, 96, 96), out(32, 'FLAT22', { light: 255, riser: 'METAL', special: 8 }));
  stairs(c, rx - 64, ry + 320, rx + 64, ry + 416, 'S', [-16, 8], (z) => out(z, 'FLAT23', { light: 208, riser: 'STEP4' }));
  stairs(c, rx - 64, ry - 416, rx + 64, ry - 320, 'N', [-16, 8], (z) => out(z, 'FLAT23', { light: 208, riser: 'STEP4' }));
  for (const [dx, dy] of [[-216, -216], [200, -216], [-216, 200], [200, 200]]) c.paint(rect(rx + dx, ry + dy, rx + dx + 16, ry + dy + 16), mass(104, 'LITERED1', { floorPic: 'FLAT23', light: 255 }));
  for (const bx of [rx - 512, rx + 480]) c.paint(oct(bx + 16, y1 - 96, 32, 32), mass(288, 'LITEBLU4', { floorPic: 'FLAT22', light: 255 }));
  for (const [dx, dy] of [[-400, -400], [400, -400], [-400, 400], [400, 400]]) th(rx + dx, ry + dy, T.TORCH_BLUE);

  // ==== east: maze, slide + pool, lookout tower =======================================
  // crate maze: 5 × 4 cells of 128 (96 corridors, 32 crate walls), carved by a seeded DFS
  const mz0 = x1 - 704, mzy0 = ry - 64, NXc = 5, NYc = 4, P = 128;
  c.paint(rect(mz0, mzy0, mz0 + NXc * P + 32, mzy0 + NYc * P + 32), mass(96, 'CRATE1', { floorPic: 'CRATOP2', light: 176 }));
  const cellR = (i: number, j: number): R4 => [mz0 + 32 + i * P, mzy0 + 32 + j * P, mz0 + i * P + P, mzy0 + j * P + P];
  const mazeFloor = out(0, 'FLOOR4_8', { light: 152, riser: 'CRATE1' });
  const seen = new Set<number>(); const stack: [number, number][] = [[0, 0]]; seen.add(0);
  c.paint(rect(...cellR(0, 0)), mazeFloor);
  while (stack.length) {
    const [i, j] = stack[stack.length - 1];
    const nb = shuffle([[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => [i + a, j + b] as [number, number]).filter(([a, b]) => a >= 0 && b >= 0 && a < NXc && b < NYc && !seen.has(b * NXc + a)));
    if (!nb.length) { stack.pop(); continue; }
    const [a, b] = nb[0];
    seen.add(b * NXc + a); stack.push([a, b]);
    const [p0, q0, p1, q1] = cellR(a, b), [r0, s0, r1, s1] = cellR(i, j);
    c.paint(rect(Math.min(p0, r0), Math.min(q0, s0), Math.max(p1, r1), Math.max(q1, s1)), mazeFloor);
  }
  // entrances (west side, south side) and the teleporter in the far cell (to the slide top)
  const e1 = cellR(0, 0), e2 = cellR(2, NYc - 1);
  c.paint(rect(mz0, e1[1], mz0 + 32, e1[3]), mazeFloor);
  c.paint(rect(e2[0], e2[3], e2[2], e2[3] + 32), mazeFloor);
  const far = cellR(NXc - 1, NYc - 1);
  c.paint(rect(far[0] + 16, far[1] + 16, far[2] - 16, far[3] - 16), out(0, 'GATE1', { light: 255, riser: 'CRATE1', line: { special: 97, tag: TAG_TP_SLIDE } }));
  // the slide: 8-unit steps from a platform at 96 down into the pool
  const sx0 = x0 + 1984, sx1 = sx0 + 128;
  const pool: R4 = [sx0 - 64, y0 + 64, sx1 + 96, y0 + 320];
  c.paint(rect(...pool), out(-24, 'FWATER1', { light: 200, riser: 'A-MOSROK' }));
  stairs(c, sx0, pool[3], sx1, pool[3] + 352, 'N', [8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88], (z) => out(z, 'FLAT23', { light: 208, riser: 'SILVER1' }));
  c.paint(rect(sx0, pool[3] + 352, sx1, pool[3] + 480), out(96, 'FLOOR1_1', { light: 224, riser: 'SILVER1', tag: TAG_TP_SLIDE }));
  th((sx0 + sx1) / 2, pool[3] + 416, 14, 270);
  // a diving board over the pool
  c.paint(rect(sx0 + 32, pool[3] - 96, sx1 - 32, pool[3]), out(8, 'FLAT23', { light: 208, riser: 'SILVER1' }));
  // the lookout tower (240) in the SE corner with a WR lift on its west side
  const tw: R4 = [x1 - 320, y0 + 64, x1 - 64, y0 + 384];
  c.paint(rect(...tw), out(240, 'FLAT1', { light: 216, riser: 'STONE3' }));
  c.paint(rect(tw[0] - 128, tw[1], tw[0], tw[3]), out(240, 'FLAT1', { light: 216, riser: 'STONE3' }));
  c.paint(rect(tw[0] - 128, tw[1] + 96, tw[0], tw[3] - 96), out(232, 'STEP2', { light: 216, riser: 'SUPPORT3', tag: TAG_LIFT }));
  c.paint(rect(tw[0] - 256, tw[1] + 96, tw[0] - 128, tw[3] - 96), out(0, 'FLOOR1_7', { light: 232, riser: 'STEP1', line: { special: 88, tag: TAG_LIFT } }));
  th(tw[2] - 32, tw[3] - 32, T.TECHLAMP); th(tw[0] - 96, tw[3] - 32, T.TECHLAMP2);

  // crate stacks for cover around the open floor
  for (const [dx, dy] of [[x0 + 1024, y1 - 160], [x0 + 1792, y1 - 160], [x0 + 1024, y0 + 96], [x0 + 1728, y0 + 96]]) {
    crateStack(dx, dy, 64, 64); crateStack(dx + 64, dy, 64, 32); crateStack(dx, dy - 64 > y0 ? dy - 64 : dy + 64, 64, 96);
  }
  for (const [x, y] of [[x0 + 480, y0 + 96], [x0 + 1216, y1 - 96], [x0 + 2496, y1 - 96], [x0 + 1600, y0 + 96]]) th(x, y, T.TECHLAMP2);
  // light pools of the lamps in the lobby
  const glow = lighten(24);
  for (const t of c.things) {
    if (!((t.type === T.TECHLAMP || t.type === T.TECHLAMP2 || t.type === T.TORCH_BLUE) && inLobbyRing(t.x, t.y))) continue;
    // (never split a tagged or trigger sector: a lift / teleport pad stays one sector)
    c.modify(oct(snap(t.x, 8), snap(t.y, 8), 96, 96), (p) => ((p as Style).tag || (p as Style).line ? null : glow(p)));
  }

  // lobby spots: an 88 grid over the floor (the plaza, the ring, the maze, the slide; not in the
  // nukage or the pool, not on a trigger, not near things)
  let n = 0;
  for (let y = y0 + 80; y < y1 - 40; y += 88) for (let x = x0 + 80; x < x1 - 40; x += 88) {
    const s = c.at(x, y) as Style;
    if ((s as unknown as Solid).solid || s.line) continue;
    const fl = free(x, y, 24);
    if (fl === null || fl < -16 || fl > 96) continue;
    if (c.things.some((t) => Math.hypot(t.x - x, t.y - y) < 64)) continue;
    th(x, y, LOBBY_SPOT, Math.floor(R() * 8) * 45);
    n++;
  }
  if (n < 72) throw new Error(`lobby: only ${n} spots`);
}

// ---- buggies --------------------------------------------------------------------------------------
// On the through roads (256 wide, flat), in compound yards and on open ground: each needs
// 160 units of clear, nearly level floor around it, and they keep 1024 apart.
function buggies(): void {
  const placed: Pt[] = [];
  const clear = (x: number, y: number): boolean => {
    let f0: number | null = null;
    for (let dy = -160; dy <= 160; dy += 16) for (let dx = -160; dx <= 160; dx += 16) {
      if (dx * dx + dy * dy > 160 * 160) continue;
      const s = c.at(x + dx + 1, y + dy + 1) as Style;
      if ((s as unknown as Solid).solid || s.ceil - s.floor < 96 || /WATER/.test(s.floorPic)) return false;
      if (f0 === null) f0 = s.floor; else if (Math.abs(s.floor - f0) > 8) return false;
    }
    return !c.things.some((t) => Math.hypot(t.x - x, t.y - y) < 160);
  };
  const tryAt = (x: number, y: number, ang: number) => {
    x = snap(x, 8); y = snap(y, 8);
    if (inLobbyRing(x, y, 256) || nearLobby(x, y) || near(placed, x, y, 1024) || !clear(x, y)) return false;
    placed.push([x, y]); th(x, y, BUGGY, ang); return true;
  };
  // the through roads first (facing along the road), then open ground
  for (const y of [-6400, -4096, -2048, 2560, 4352, 6400]) tryAt(0, y, 90);
  for (const x of [-6912, -4608, -3328, 3328, 4608, 6912]) tryAt(x, 1024, 0);
  for (let k = 0; k < 400 && placed.length < 22; k++) tryAt((R() * 2 - 1) * 6800, (R() * 2 - 1) * 6800, Math.floor(R() * 8) * 45);
}
