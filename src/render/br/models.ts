// The battle royale vehicles as low-poly palette models (src/render/br/palmodel.ts):
// the buggy (MT_BUGGY 140), the dropship (MT_DROPSHIP 138) and the parachute canopy
// over a parachuter (MT_PARACHUTER 139, frame B). Doom map units, Z up, facing +X.
import * as THREE from 'three';
import type { PaletteData } from '../../wad';
import { FULLBRIGHT, PLAYER_COLOR, PalBuilder } from './palmodel';

type P3 = [number, number, number];

export interface BuggyGeometry {
  chassis: THREE.BufferGeometry;
  /** one wheel, axle along Y, centred on the origin */
  wheel: THREE.BufferGeometry;
  /** wheel centres (front left, front right, rear left, rear right) */
  wheels: P3[];
  wheelRadius: number;
}

const SAND = 0xa07440, SAND_DARK = 0x6e4c28, IRON = 0x4a4a4a, IRON_DARK = 0x2a2a2a, TIRE = 0x1e1e1e, HUB = 0x8c8c8c;
const SEAT = 0x4a2a14, LAMP = 0xfff4c0, RED_LAMP = 0xd02010;

export function buildBuggy(pal: PaletteData): BuggyGeometry {
  const b = new PalBuilder(pal);
  // floor pan, side tubs, nose and hood
  b.box([-34, -20, 9], [34, 20, 13], IRON_DARK);
  b.box([-30, -22, 12], [24, -17, 28], SAND).box([-30, 17, 12], [24, 22, 28], SAND);
  b.box([-30, -22, 22], [24, -21, 24], SAND_DARK).box([-30, 21, 22], [24, 22, 24], SAND_DARK);
  b.add(new THREE.BoxGeometry(26, 40, 12), SAND, [26, 0, 20], [0, -0.22, 0]);
  b.box([10, -18, 12], [16, 18, 30], SAND_DARK); // firewall / dash
  b.box([36, -24, 11], [40, 24, 17], IRON);      // bumper
  b.box([34, -6, 13], [40, 6, 24], IRON_DARK);   // grille
  b.box([35, -19, 21], [38, -12, 26], LAMP, { flags: FULLBRIGHT }).box([35, 12, 21], [38, 19, 26], LAMP, { flags: FULLBRIGHT });
  b.box([-35, -20, 22], [-33, -15, 26], RED_LAMP, { flags: FULLBRIGHT }).box([-35, 15, 22], [-33, 20, 26], RED_LAMP, { flags: FULLBRIGHT });
  // fenders over the wheels
  for (const [x, y] of [[24, -28], [24, 28], [-24, -28], [-24, 28]]) b.box([x - 15, y - 6, 27], [x + 15, y + 6, 30], SAND_DARK);
  // seat, steering wheel
  b.box([-14, -12, 13], [-2, 12, 20], SEAT).box([-18, -12, 18], [-13, 12, 38], SEAT);
  b.tube([12, 0, 24], [6, 0, 33], 1.2, IRON_DARK, { seg: 5 });
  b.add(new THREE.TorusGeometry(6, 1.2, 4, 10), IRON_DARK, [6, 0, 34], [0, Math.PI / 2 - 0.5, 0]);
  // roll cage
  const rb = (a: P3, c: P3) => b.tube(a, c, 1.8, IRON, { seg: 6 });
  rb([-18, -19, 26], [-18, -17, 60]); rb([-18, 19, 26], [-18, 17, 60]); rb([-18, -17, 60], [-18, 17, 60]);
  rb([-18, -17, 60], [12, -18, 30]); rb([-18, 17, 60], [12, 18, 30]);
  rb([-18, -17, 60], [-34, -16, 28]); rb([-18, 17, 60], [-34, 16, 28]);
  // engine at the back, exhausts
  b.box([-38, -14, 18], [-24, 14, 36], IRON_DARK).box([-36, -10, 36], [-26, 10, 39], IRON);
  b.tube([-36, -8, 30], [-46, -11, 36], 2, IRON, { seg: 6 }).tube([-36, 8, 30], [-46, 11, 36], 2, IRON, { seg: 6 });
  b.box([-34, -26, 22], [-30, 26, 26], IRON); // rear bar
  const chassis = b.build();

  // the wheel: tyre with tread blocks (so it reads as turning), hub and spokes
  const R = 13, W = 10;
  b.add(new THREE.CylinderGeometry(R - 1.5, R - 1.5, W, 12), TIRE, [0, 0, 0], [0, 0, 0], { flat: false });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    b.add(new THREE.BoxGeometry(4.5, W + 0.5, 2.2), i % 2 ? TIRE : 0x303030, [Math.cos(a) * (R - 0.8), 0, Math.sin(a) * (R - 0.8)], [0, -a, 0]);
  }
  b.add(new THREE.CylinderGeometry(6, 6, W + 1, 8), HUB, [0, 0, 0], [0, 0, 0]);
  for (let i = 0; i < 4; i++) b.add(new THREE.BoxGeometry(10, W + 1.6, 2), IRON, [0, 0, 0], [0, (i * Math.PI) / 4, 0]);
  const wheel = b.build();
  return { chassis, wheel, wheels: [[24, 28, R], [24, -28, R], [-24, 28, R], [-24, -28, R]], wheelRadius: R };
}

const HULL = 0x5c646c, HULL_DARK = 0x363c44, STRIPE = 0x9c2014, GLASS = 0x1c2a44, ENGINE = 0x2c2c30, GLOW = 0xffa83c, GLOW_HOT = 0xfff0c0;

export interface ShipGeometry { hull: THREE.BufferGeometry; glow: THREE.BufferGeometry }

/** The troop carrier: ~680 long, 920 span; origin at its belly centre. */
export function buildDropship(pal: PaletteData): ShipGeometry {
  const b = new PalBuilder(pal);
  b.box([-240, -62, 0], [240, 62, 112], HULL);
  b.box([-236, -63, 62], [236, 63, 72], STRIPE);
  b.tube([240, 0, 56], [340, 0, 46], 62, HULL, { r1: 16, seg: 6 });
  b.add(new THREE.BoxGeometry(46, 96, 26), GLASS, [278, 0, 92], [0, 0.32, 0]);
  b.tube([-240, 0, 62], [-340, 0, 92], 58, HULL, { r1: 22, seg: 6 });
  b.add(new THREE.BoxGeometry(110, 10, 120), HULL_DARK, [-300, 0, 150], [0, -0.45, 0]);
  b.box([-330, -120, 88], [-276, 120, 96], HULL_DARK);
  b.box([-236, -46, -6], [-150, 46, 2], HULL_DARK); // cargo ramp
  b.box([-120, -66, -10], [120, -50, 16], HULL_DARK).box([-120, 50, -10], [120, 66, 16], HULL_DARK); // gear pods
  // wings and tip lights
  b.box([-70, -470, 104], [90, 470, 118], HULL_DARK);
  b.box([-40, -470, 118], [60, 470, 121], HULL);
  b.box([-10, -478, 104], [20, -470, 118], 0xff2010, { flags: FULLBRIGHT });
  b.box([-10, 470, 104], [20, 478, 118], 0x20ff40, { flags: FULLBRIGHT });
  // four engines under the wings
  for (const y of [-330, -175, 175, 330]) {
    b.tube([120, y, 76], [-80, y, 76], 30, ENGINE, { r1: 26, seg: 10 });
    b.tube([124, y, 76], [118, y, 76], 33, IRON_DARK, { seg: 10 });
    b.box([-30, y - 6, 96], [70, y + 6, 106], HULL_DARK);
  }
  const hull = b.build();
  // exhausts: hot discs and a cone, fullbright (bloom)
  for (const y of [-330, -175, 175, 330]) {
    b.tube([-80, y, 76], [-84, y, 76], 24, GLOW, { seg: 10, flags: FULLBRIGHT });
    b.tube([-84, y, 76], [-86, y, 76], 14, GLOW_HOT, { seg: 10, flags: FULLBRIGHT });
  }
  const glow = b.build();
  return { hull, glow };
}

const CANOPY_LIGHT = 0xe8e8e8;

/** The canopy and its lines over a parachuter's feet (origin), facing +X; colour cells take the player's colour. */
export function buildCanopy(pal: PaletteData): THREE.BufferGeometry {
  const b = new PalBuilder(pal);
  const cells = 9, R = 74, span = (2 * Math.PI) / 3, cz = 96;
  const green = 114; // the player green ramp, translated per slot
  for (let i = 0; i < cells; i++) {
    const a = -span / 2 + ((i + 0.5) / cells) * span;
    const w = 2 * R * Math.sin(span / cells / 2) + 5;
    b.add(new THREE.BoxGeometry(60, w, 7), i % 2 ? CANOPY_LIGHT : green, [0, Math.sin(a) * R, cz + Math.cos(a) * R], [a, 0, 0],
      i % 2 ? {} : { raw: true, flags: PLAYER_COLOR });
    // the cell's leading edge (darker)
    b.add(new THREE.BoxGeometry(4, w, 8), i % 2 ? 0x9c9c9c : green + 6, [30, Math.sin(a) * R, cz + Math.cos(a) * R], [a, 0, 0],
      i % 2 ? {} : { raw: true, flags: PLAYER_COLOR });
  }
  // lines from the lower edge of the canopy to the shoulders
  for (const s of [-1, 1]) for (let k = 0; k < 4; k++) {
    const a = s * (span / 2) * (0.25 + 0.25 * k);
    for (const x of [-22, 22]) b.tube([x, Math.sin(a) * (R - 4), cz + Math.cos(a) * (R - 4) - 4], [0, s * 7, 50], 0.5, 0x202020, { seg: 3 });
  }
  return b.build();
}
