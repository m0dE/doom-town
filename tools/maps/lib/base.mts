// A team base: walled compound with three gates, a spawn hangar holding 72 team starts
// (9 × 8, 96 apart, facing the doors), weapon daises, supplies, team colours (red: brick,
// red light strips, red torches; blue: silver/blue windows, blue strips, blue torches).
// Designed in a local frame where the base sits at x 7424..9984, y -1792..1792 and the map
// centre is towards -x; placed with an affine transform.
import { PaintCanvas } from './canvas.mts';
import { T, lighten } from './kit.mts';
import { SKYH, out, room, mass } from './styles.mts';
import { frame, type Xf } from './xf.mts';

// ---- bases (designed for blue in the east; s = -1 mirrors to red in the west) ---------------
export function teamBase(c: PaintCanvas, blue: boolean, m: Xf): void {
  const team = blue
    ? { accent: 'LITEBLU5', banner: 'PANBLUE', floorAcc: 'FLOOR1_1', face: 'SILVER2', light: 'LITEBLU4', torch: T.TORCH_BLUE, storch: T.STORCH_BLUE, start: T.BLUE_START, door: 'M_BDOOR' }
    : { accent: 'LITERED1', banner: 'PANRED', floorAcc: 'FLOOR1_7', face: 'BRICK11', light: 'LITERED', torch: T.TORCH_RED, storch: T.STORCH_RED, start: T.RED_START, door: 'M_RDOOR' };
  const F = frame(m);
  const r = F.r, ch = F.ch;
  const th = (x: number, y: number, t: number, a = 180) => { const [wx, wy] = F.pt(x, y); c.thing(wx, wy, t, F.ang(a)); };

  // compound: perimeter wall + paved courtyard
  const yardS = out(0, 'FLAT5_4', { light: 200, wall: 'CEMENT1' });
  const cwall = mass(128, 'CEMENT1', { floorPic: 'FLAT1', light: 192 });
  c.paint(ch(7424, -1792, 9984, 1792, 320), cwall);
  c.paint(ch(7488, -1728, 9920, 1728, 256), yardS);
  // gates (west gate wide, north/south gates)
  c.paint(r(7424, -256, 7488, 256), yardS);
  c.paint(r(8320, 1728, 8832, 1792), yardS);
  c.paint(r(8320, -1792, 8832, -1728), yardS);
  // gate posts with banners and torches on top
  for (const [x0, y0] of [[7392, 256], [7392, -320], [8256, 1696], [8832, 1696], [8256, -1760], [8832, -1760]] as [number, number][]) {
    c.paint(r(x0, y0, x0 + 64, y0 + 64), mass(192, team.banner, { floorPic: 'FLAT1', light: 208 }));
    th(x0 + 32, y0 + 32, team.storch);
  }
  // hangar: outer facade ring + inner wall ring, interior
  const hx0 = 8448, hx1 = 9728, hy = 768;
  c.paint(r(hx0, -hy, hx1, hy), mass(SKYH, team.face, { floorPic: 'FLAT1' }));
  c.paint(r(hx0 + 32, -hy + 32, hx1 - 32, hy - 32), mass(SKYH, 'GRAY7', { floorPic: 'FLAT1' }));
  const hall = room(0, 288, 'FLAT20', 'CEIL5_1', 160, { riser: 'STEP3' });
  c.paint(r(hx0 + 64, -hy + 64, hx1 - 64, hy - 64), hall);
  // ceiling light strips and floor accents
  for (const y of [-512, -192, 128, 448]) c.paint(r(hx0 + 192, y, hx1 - 192, y + 64), { ...hall, ceilPic: 'CEIL3_4', light: 208 });
  c.paint(r(hx0 + 448, -64, hx1 - 320, 64), { ...hall, floorPic: team.floorAcc, light: 176 });
  // wall light strips (inner ring segments with the team's light texture)
  for (let y = -640; y <= 576; y += 256) {
    c.paint(r(hx1 - 64, y, hx1 - 32, y + 32), mass(SKYH, team.accent));
  }
  for (let x = hx0 + 192; x <= hx1 - 256; x += 256) {
    c.paint(r(x, hy - 64, x + 32, hy - 32), mass(SKYH, team.accent));
    c.paint(r(x, -hy + 32, x + 32, -hy + 64), mass(SKYH, team.accent));
  }
  // three doorways in the west wall (two halves: facade side / interior side)
  for (const y0 of [-576, -128, 320]) {
    c.paint(r(hx0, y0, hx0 + 32, y0 + 256), room(0, 192, 'FLAT20', 'CEIL5_1', 176, { upper: team.face }));
    c.paint(r(hx0 + 32, y0, hx0 + 64, y0 + 256), room(0, 192, 'FLAT20', 'CEIL5_1', 176, { upper: 'GRAY7' }));
    // door trims: light strips beside the doorway on the facade
    c.paint(r(hx0, y0 - 16, hx0 + 32, y0), mass(SKYH, team.light));
    c.paint(r(hx0, y0 + 256, hx0 + 32, y0 + 272), mass(SKYH, team.light));
  }
  // weapon daises along the north and south walls of the hangar
  const dais = { ...hall, floor: 16, floorPic: team.floorAcc, light: 192, riser: 'STEP3' };
  const wpn = [T.SSG, T.CHAINGUN, T.ROCKETL, T.PLASMA];
  wpn.forEach((w, i) => {
    const x = hx0 + 256 + i * 256;
    c.paint(r(x - 64, hy - 192, x + 64, hy - 64), dais);
    c.paint(r(x - 64, -hy + 64, x + 64, -hy + 192), dais);
    th(x, hy - 128, w); th(x, -hy + 128, w);
  });
  // team starts: 9 × 8 grid, 96 apart, facing the doors
  for (let i = 0; i < 9; i++) for (let j = 0; j < 8; j++) th(8640 + i * 96, -336 + j * 96, team.start);
  // supplies inside the hangar
  for (const y of [-640, 640]) { th(9600, y, T.SHELLBOX); th(9536, y, T.BULLETS); th(9472, y, T.ROCKETBOX); th(9408, y, T.CELLPACK); }
  th(9600, 0, T.GREENARMOR); th(9600, 96, T.MEDI); th(9600, -96, T.MEDI);
  for (const y of [-704, 704]) { th(hx0 + 96, y, T.TECHLAMP); th(hx1 - 96, y, T.TECHLAMP); }
  // courtyard: sandbag walls, crates, lamps, a shotgun rack
  const sand = mass(40, 'CEMENT7', { floorPic: 'FLAT1', light: 200 });
  for (const [x0, y0, x1, y1] of [[7808, -704, 7872, -320], [7808, 320, 7872, 704], [8064, -1280, 8448, -1216], [8064, 1216, 8448, 1280], [7680, -1408, 7744, -1024], [7680, 1024, 7744, 1408]]) c.paint(r(x0, y0, x1, y1), sand);
  const crate = (x: number, y: number, sz: number, h: number) => c.paint(r(x, y, x + sz, y + sz), mass(h, 'CRATE1', { floorPic: 'CRATOP2', light: 200, riser: sz >= 128 ? 'CRATWIDE' : 'CRATE1' }));
  crate(9152, 1152, 128, 64); crate(9280, 1152, 64, 96); crate(9152, -1280, 128, 64); crate(9280, -1216, 64, 96);
  crate(8064, 896, 64, 64); crate(8064, -960, 64, 64);
  for (const [x, y] of [[8256, 896], [8256, -896], [9216, 1536], [9216, -1536], [7616, 448], [7616, -448]]) th(x, y, T.TECHLAMP2);
  for (const [x, y] of [[8064, 0], [8064, 160], [8064, -160]]) th(x, y, T.SHOTGUN);
  th(8128, 0, T.SHELLBOX); th(8128, 160, T.SHELLS); th(8128, -160, T.SHELLS);
  th(9600, 1536, T.MEDI); th(9600, -1536, T.MEDI); th(9664, 1536, T.CLIP); th(9664, -1536, T.CLIP);
  // flagpole plinth with the team torch at the hangar front
  c.paint(r(8320, -64, 8384, 64), mass(32, team.banner, { floorPic: team.floorAcc, light: 224 }));
  th(8352, 0, team.torch);
  // lights around the yard
  c.modify(r(7488, -320, 8448, 320), lighten(16));
}

