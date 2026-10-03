// Map preview (tools only): loads the base pak and public/maps/<MAP>.wad (or a mod,
// ?mod=<id>: public/mods/<id>.wad) merged over it
// (the delivery layout of DESIGN.md "Map data delivery"), shows the map's things as static
// sprites, and renders from a camera given in the URL:
//   ?map=WAR01&x=&y=&z=&yaw=&pitch=  (degrees; z defaults to floor + 41)
// window.__preview.shot(x, y, z|null, yaw, pitch) re-renders synchronously.
import { Renderer, type RenderFrame, type RenderMobj } from '../../../src/render';
import { THING_DEFS, Wad, loadWad, spriteNum } from '../../../src/wad';

const params = new URLSearchParams(location.search);
const MAP = (params.get('map') || 'WAR01').toUpperCase();
const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
if (params.get('ui') === '0') hud.style.display = 'none';

const get = async (u: string) => new Uint8Array(await (await fetch(u)).arrayBuffer());
// a mod (?mod=br01: public/mods/br01.wad holds the map and its art) or a rotation map
// (art in public/maps/<MAP>.wad, lumps in public/maps/<MAP>.map.wad)
const MOD = params.get('mod');
const paks = MOD ? [`./mods/${MOD}.wad`] : [`./maps/${MAP}.wad`, `./maps/${MAP}.map.wad`];
const [baseBytes, ...pakBytes] = await Promise.all([get('./freedm-lite.wad'), ...paks.map(get)]);
const wad: Wad = loadWad(baseBytes);
for (const b of pakBytes) wad.add(b);
const renderer = new Renderer(canvas, wad, MAP);
const map = renderer.map;
const floorAt = (x: number, y: number) => map.sectors[renderer.sectorAt(x, y)].floor;
const ceilAt = (x: number, y: number) => map.sectors[renderer.sectorAt(x, y)].ceil;

const defs = new Map(THING_DEFS.map((d) => [d[0], d]));
const mobjs: RenderMobj[] = [];
let id = 1;
for (const t of map.things) {
  const d = defs.get(t.type);
  if (!d) continue;
  const sp = spriteNum(d[2]);
  if (sp < 0) continue;
  const m: RenderMobj = { id: id++, x: t.x, y: t.y, z: 0, angle: (t.angle * Math.PI) / 180, sprite: sp, frame: d[3][0], flags: 0, type: d[1], slot: -1, translation: 0 };
  if (d[4]) { const L = renderer.assets.spriteLump(sp, m.frame, 0); m.z = ceilAt(t.x, t.y) - (L ? L.info.rect.h : 0); }
  else m.z = floorAt(t.x, t.y);
  mobjs.push(m);
}
// team starts as player sprites in team colors (red 3, blue 1 = indigo in Doom's table)
const PLAY = spriteNum('PLAY');
for (const t of map.things) {
  if (t.type !== 9000 && t.type !== 9001) continue;
  if (params.get('players') === '0') break;
  mobjs.push({ id: id++, x: t.x, y: t.y, z: floorAt(t.x, t.y), angle: (t.angle * Math.PI) / 180, sprite: PLAY, frame: 0, flags: 0, type: 0, slot: id, translation: t.type === 9000 ? 3 : 1 });
}

const deg = (v: string | null, d: number) => (v === null ? d : (Number(v) * Math.PI) / 180);
const cam = { x: Number(params.get('x') ?? 0), y: Number(params.get('y') ?? 0), z: 0, yaw: deg(params.get('yaw'), 0), pitch: deg(params.get('pitch'), 0) };
cam.z = params.get('z') !== null ? Number(params.get('z')) : floorAt(cam.x, cam.y) + 41;
const frame: RenderFrame = { tic: 0, camera: cam, mobjs, mobjCount: mobjs.length, sectors: null, lineTextures: null, player: null, events: [] };

function draw() {
  renderer.setFrame(frame);
  renderer.render();
  hud.textContent = `${MAP} x ${cam.x.toFixed(0)} y ${cam.y.toFixed(0)} z ${cam.z.toFixed(0)} yaw ${(cam.yaw * 180 / Math.PI).toFixed(0)} pitch ${(cam.pitch * 180 / Math.PI).toFixed(0)}  sector ${renderer.sectorAt(cam.x, cam.y)}`;
}
let t = 0;
function loop() { frame.tic = t++ / 2; draw(); requestAnimationFrame(loop); }
requestAnimationFrame(loop);
(window as unknown as { __preview: unknown }).__preview = {
  renderer,
  shot(x: number, y: number, z: number | null, yaw: number, pitch = 0) {
    cam.x = x; cam.y = y; cam.z = z ?? floorAt(x, y) + 41; cam.yaw = (yaw * Math.PI) / 180; cam.pitch = (pitch * Math.PI) / 180;
    for (let i = 0; i < 3; i++) draw();
  },
  ready: true,
};
