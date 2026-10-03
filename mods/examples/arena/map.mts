// ARENA "Reactor Arena" — a small deathmatch map (16 players), the modding guide's first
// example (docs/MODDING.md "Example 1"). Built with the map DSL in tools/maps/lib/.
//
//          N  control room (plasma on the mezzanine)
//          |
//   W  ----+----  E      the reactor hall in the middle: a water moat around the core
//  tower   |    yard     (rocket launcher), four bridges, eight pillars;
//          |             corridors to four rooms, and an outer ring of L-shaped
//          S  pump room  halls linking the rooms so there is always a way around.
//
// Coordinates: +x east, +y north, 1 unit = 1 Doom map unit. The canvas grid is 8 units;
// every shape edge runs at 0, 45 or 90 degrees (see tools/maps/lib/canvas.mts).
// Art: mostly textures and flats the base pak already carries, so the mod stays small.
import { PaintCanvas, rect, oct, chamfer, type Style } from '../../../tools/maps/lib/canvas.mts';
import { T, stairs, lighten } from '../../../tools/maps/lib/kit.mts';
import { solid } from '../../../tools/maps/lib/styles.mts';

export const NAME = 'ARENA';
export const TITLE = 'Reactor Arena';

/** An indoor sector style: floor/ceiling heights, flats, light and the wall textures. */
const inside = (floor: number, ceil: number, floorPic: string, ceilPic: string, light: number, wall: string, o: Partial<Style> = {}): Style =>
  ({ floor, ceil, floorPic, ceilPic, light, wall, riser: 'STEP6', upper: wall, ...o });

export function build(): PaintCanvas {
  // the canvas: x/y bounds, 8-unit grid, and what unpainted space is (solid wall)
  const c = new PaintCanvas(-2304, -2304, 2304, 2304, 8, solid('TEKWALL4'));

  // ---- the reactor hall ---------------------------------------------------------------
  const hall = inside(0, 288, 'FLOOR4_8', 'CEIL5_1', 176, 'TEKWALL4');
  c.paint(oct(0, 0, 704), hall);
  // a ring of ceiling lights over the walkway
  c.modify(oct(0, 0, 608), (p) => ({ ...(p as Style), ceilPic: 'TLITE6_4', light: 200 }));
  c.paint(oct(0, 0, 512), hall);
  // the moat and the core
  c.paint(oct(0, 0, 352), inside(-24, 288, 'FWATER1', 'CEIL5_1', 160, 'TEKWALL4', { riser: 'METAL' }));
  c.paint(oct(0, 0, 176), inside(16, 224, 'FLOOR0_3', 'TLITE6_1', 240, 'TEKWALL4', { riser: 'METAL', upper: 'COMPSPAN' }));
  // four bridges across the moat
  const bridge = inside(0, 288, 'FLAT20', 'CEIL5_1', 176, 'TEKWALL4', { riser: 'METAL' });
  c.paint(rect(-64, 176, 64, 352), bridge);
  c.paint(rect(-64, -352, 64, -176), bridge);
  c.paint(rect(176, -64, 352, 64), bridge);
  c.paint(rect(-352, -64, -176, 64), bridge);
  // eight pillars on the walkway (cover), with light strips
  const pillar = solid('SUPPORT3');
  for (const [x, y] of [[448, 448], [-448, 448], [448, -448], [-448, -448], [0, 576], [0, -576], [576, 0], [-576, 0]]) {
    if (x && y) c.paint(chamfer(x - 48, y - 48, x + 48, y + 48, 16), pillar);
    else c.paint(chamfer(x - 32, y - 32, x + 32, y + 32, 16), solid('LITE5'));
  }

  // ---- corridors from the hall to the four rooms --------------------------------------
  const corr = inside(0, 128, 'FLOOR0_1', 'CEIL3_5', 136, 'STARTAN1');
  c.paint(rect(-96, 640, 96, 1088), corr);
  c.paint(rect(-96, -1088, 96, -640), corr);
  c.paint(rect(640, -96, 1088, 96), corr);
  c.paint(rect(-1088, -96, -640, 96), corr);
  // a lit door frame where each corridor meets the hall
  for (const s of [1, -1]) {
    c.paint(rect(-96, s * 640, 96, s * 704), { ...corr, ceil: 112, ceilPic: 'TLITE6_6', light: 192 });
    c.paint(rect(s * 640, -96, s * 704, 96), { ...corr, ceil: 112, ceilPic: 'TLITE6_6', light: 192 });
  }

  // ---- north: control room with a mezzanine (plasma gun) ------------------------------
  const ctrl = inside(0, 224, 'FLOOR5_2', 'CEIL5_2', 160, 'COMPSTA1', { upper: 'COMPSPAN' });
  c.paint(rect(-448, 1088, 448, 1984), ctrl);
  stairs(c, -128, 1600, 128, 1728, 'N', [16, 32], (z) => ({ ...ctrl, floor: z, floorPic: 'STEP2' }));
  c.paint(rect(-448, 1728, 448, 1984), { ...ctrl, floor: 48, floorPic: 'FLOOR4_8', light: 192 });
  c.modify(rect(-320, 1216, 320, 1472), (p) => ({ ...(p as Style), ceilPic: 'TLITE6_4', light: 192 }));
  // computer consoles (solid blocks) along the side walls
  for (const y of [1216, 1408]) { c.paint(rect(-448, y, -384, y + 128), solid('COMPTALL')); c.paint(rect(384, y, 448, y + 128), solid('COMPTALL')); }

  // ---- east: open yard under the sky (super shotgun) ----------------------------------
  const yard = inside(0, 384, 'FLOOR7_1', 'F_SKY1', 208, 'BROWN1', { riser: 'BROWN1' });
  c.paint(chamfer(1088, -448, 1984, 448, 128), yard);
  // a raised gravel planter in the middle, and broken walls for cover
  c.paint(oct(1536, 0, 128), { ...yard, floor: 24, floorPic: 'RROCK17' });
  for (const [x0, y0, x1, y1] of [[1280, 256, 1408, 288], [1664, -288, 1792, -256], [1792, 128, 1824, 256], [1248, -256, 1280, -128]]) c.paint(rect(x0, y0, x1, y1), solid('STONE2'));

  // ---- south: pump room, stairs down into a basin (chaingun + armor) ------------------
  const pump = inside(0, 192, 'FLOOR0_2', 'CEIL5_1', 152, 'BROWNGRN', { riser: 'STEP4' });
  c.paint(rect(-448, -1984, 448, -1088), pump);
  stairs(c, -192, -1344, 192, -1216, 'N', [-48, -32, -16], (z) => ({ ...pump, floor: z, floorPic: 'STEP2' }));
  c.paint(rect(-320, -1856, 320, -1344), { ...pump, floor: -64, floorPic: 'FLOOR5_4', light: 128 });
  // slime channels either side of the basin (shallow, harmless)
  c.paint(rect(-320, -1856, -224, -1408), { ...pump, floor: -80, floorPic: 'NUKAGE1', light: 176 });
  c.paint(rect(224, -1856, 320, -1408), { ...pump, floor: -80, floorPic: 'NUKAGE1', light: 176 });

  // ---- west: the tower, stairs up to a balcony (blue armor) ---------------------------
  const tower = inside(0, 320, 'FLAT1', 'CEIL5_1', 168, 'STONE', { riser: 'STEP6' });
  c.paint(rect(-1984, -448, -1088, 448), tower);
  // a wide stair straight ahead of the corridor, up to a balcony along the west wall
  const steps = [16, 32, 48, 64, 80, 96, 112];
  stairs(c, -1664, -128, -1216, 128, 'W', steps, (z) => ({ ...tower, floor: z, floorPic: 'STEP2' }));
  c.paint(rect(-1984, -448, -1664, 448), { ...tower, floor: 128, floorPic: 'FLOOR4_8', light: 192 });
  c.modify(rect(-1920, -128, -1728, 128), lighten(32));

  // ---- the outer ring: L-shaped halls between neighbouring rooms ----------------------
  const ring = inside(0, 160, 'FLAT14', 'CEIL3_5', 128, 'METAL', {});
  const L = (sx: number, sy: number) => {
    // from the north/south room's side wall out to x = 1472, then to the east/west room
    c.paint(rect(sx * 448, sy * 1408, sx * 1600, sy * 1600), ring);
    c.paint(rect(sx * 1408, sy * 448, sx * 1600, sy * 1600), ring);
    c.modify(rect(sx * 1408, sy * 1408, sx * 1600, sy * 1600), (p) => ({ ...(p as Style), ceilPic: 'TLITE6_6', light: 176 }));
  };
  L(1, 1); L(-1, 1); L(1, -1); L(-1, -1);

  // ---- things ---------------------------------------------------------------------------
  const th = (x: number, y: number, t: number, a = 0) => c.thing(x, y, t, a);
  // deathmatch starts: 3 per room, 1 per ring corner = 16
  for (const [x, y, a] of [
    [-256, 1280, 270], [256, 1280, 270], [0, 1856, 270],
    [1344, 320, 180], [1344, -320, 180], [1856, 0, 180],
    [-256, -1152, 90], [256, -1152, 90], [0, -1600, 90],
    [-1216, -320, 0], [-1216, 0, 0], [-1856, 0, 0],
    [1504, 1504, 225], [-1504, 1504, 315], [1504, -1504, 135], [-1504, -1504, 45],
  ]) th(x, y, 11, a);
  // weapons: one per room plus the prize on the core
  th(0, 0, T.ROCKETL);
  th(0, 1856, T.PLASMA);
  th(1536, 0, T.SSG);
  th(0, -1728, T.CHAINGUN);
  th(-1216, 192, T.SHOTGUN);
  th(0, 896, T.SHOTGUN); th(0, -896, T.SHOTGUN);
  // ammo next to the weapons, and in the corridors
  th(64, 0, T.ROCKET); th(-64, 0, T.ROCKET);
  th(128, 1856, T.CELL); th(-128, 1856, T.CELL);
  th(1536, 128, T.SHELLBOX); th(1536, -128, T.SHELLS);
  th(128, -1728, T.BULLETS); th(-128, -1728, T.CLIP);
  th(-1280, 192, T.SHELLS);
  th(896, 0, T.CLIP); th(-896, 0, T.CLIP); th(0, 1024, T.SHELLS); th(0, -1024, T.SHELLS);
  // health and armor: medikits on opposite sides, bonuses around the moat
  th(-1856, 256, T.BLUEARMOR);
  th(0, -1920, T.GREENARMOR);
  th(1856, 320, T.MEDI); th(-256, 1856, T.MEDI);
  th(1504, 1504, T.STIM); th(-1504, -1504, T.STIM); th(-1504, 1504, T.BULLETS); th(1504, -1504, T.ROCKET);
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 + Math.PI / 8;
    th(Math.round(Math.cos(a) * 400), Math.round(Math.sin(a) * 400), i % 2 ? T.HBONUS : T.ABONUS);
  }
  // decoration (sprites the base pak carries): tech lamps around the hall, floor lamps in
  // the control room, burning barrels in the yard, explosive barrels in the pump room
  for (const [x, y] of [[640, 160], [640, -160], [-640, 160], [-640, -160], [160, 640], [-160, 640], [160, -640], [-160, -640]]) th(x, y, T.TECHLAMP);
  for (const x of [-384, 384]) th(x, 1920, T.FLOORLAMP);
  for (const [x, y] of [[1216, 384], [1856, -384], [1856, 384], [1216, -384]]) th(x, y, T.BURNBARREL);
  th(1600, 80, T.TREE_BIG);
  for (const [x, y] of [[-384, -1920], [384, -1920], [-384, -1152], [384, -1152]]) th(x, y, T.BARREL);
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) th(sx * 1568, sy * 1024, T.TECHLAMP2);
  return c;
}
