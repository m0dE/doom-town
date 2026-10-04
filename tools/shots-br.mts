/**
 * Battle royale rendering screenshots, staged in the renderer viewer (viewer.html, no
 * sim) on BR01: the storm wall from inside and outside, the buggy with a driver, the
 * dropship from the ground and from altitude, parachuters, crates and a supply drop,
 * the sniper rifle psprite.
 *
 *   npx vite --port 5195 &   # dev server
 *   npx tsx tools/shots-br.mts [--url=http://localhost:5195/] [--out=docs/shots] [--only=storm,buggy]
 */
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loadWad, parseMap, pointInSubsector } from '../src/wad/index.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k: string, d: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const URL0 = arg('url', 'http://localhost:5195/');
const OUT = path.resolve(ROOT, arg('out', 'docs/shots'));
const ONLY = arg('only', '').split(',').filter(Boolean);
const PW = process.env.PLAYWRIGHT ?? '/app/data/home/arrr-mono/node_modules/playwright/index.mjs';
const CHROME = process.env.CHROME ?? '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
mkdirSync(OUT, { recursive: true });

const MOD = existsSync(path.join(ROOT, 'public/mods/br01.wad')) ? 'mods/br01.wad' : null;
const wad = loadWad(new Uint8Array(readFileSync(path.join(ROOT, 'public/freedm-lite.wad'))));
if (MOD) wad.add(new Uint8Array(readFileSync(path.join(ROOT, 'public', MOD))));
else { wad.add(new Uint8Array(readFileSync(path.join(ROOT, 'public/maps/BR01.wad')))); wad.add(new Uint8Array(readFileSync(path.join(ROOT, 'public/maps/BR01.map.wad')))); }
const map = parseMap('BR01', wad.mapLumps('BR01'));
const sectorAt = (x: number, y: number) => {
  const ss = pointInSubsector(map, x, y);
  const seg = map.segs[map.subsectors[ss].first];
  const line = map.lines[seg.line];
  return map.sides[seg.side ? line.back : line.front].sector;
};
const floorAt = (x: number, y: number) => map.sectors[sectorAt(x, y)].floor;
const sky = (x: number, y: number) => map.sectors[sectorAt(x, y)].ceilPic === 'F_SKY1';
// an open street spot: a DM start with sky above and flat sky ground 400 units ahead
const starts = map.things.filter((t) => t.type === 11 || (t.type >= 1 && t.type <= 4));
let spot = starts[0], dir = 0;
outer: for (const s of starts) {
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI * 2;
    let ok = sky(s.x, s.y);
    for (let d = 64; d <= 700 && ok; d += 32) {
      const x = s.x + Math.cos(ang) * d, y = s.y + Math.sin(ang) * d;
      ok = sky(x, y) && Math.abs(floorAt(x, y) - floorAt(s.x, s.y)) < 8;
      for (const side of [-120, 120]) ok &&= sky(x - Math.sin(ang) * side, y + Math.cos(ang) * side);
      ok &&= !map.things.some((t) => t !== s && t.type !== 9020 && Math.hypot(t.x - x, t.y - y) < 96);
    }
    if (ok) { spot = s; dir = ang; break outer; }
  }
}
console.log('spot', spot.x, spot.y, (dir * 180) / Math.PI, 'floor', floorAt(spot.x, spot.y));

const { chromium } = await import(PW);
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(180000);
page.on('pageerror', (e: Error) => console.log('pageerror', e.message));
page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console', m.text()); });
const q = new URLSearchParams({ map: 'BR01', players: '0', ui: '0', freeze: '1', bodies: '3d', weapon: 'SNPG' });
if (MOD) q.append('mod', MOD); else { q.append('pwad', 'maps/BR01.wad'); q.append('pwad', 'maps/BR01.map.wad'); }
await page.goto(`${URL0}viewer.html?${q}`);
await page.waitForFunction(() => !!(window as any).__viewer, null, { timeout: 180000 });

const X = spot.x, Y = spot.y, F0 = floorAt(X, Y), D = (dir * 180) / Math.PI;
const cx = Math.cos(dir), sy = Math.sin(dir);
const at = (fwd: number, side = 0) => ({ x: X + cx * fwd - sy * side, y: Y + sy * fwd + cx * side });

interface Stage { x: number; y: number; z: number; type: number; sprite?: string; frame?: number; flags?: number; slot?: number; angle?: number; translation?: number }
async function shot(name: string, o: { cam: [number, number, number | null, number, number]; mobjs?: Stage[]; royale?: object | null; psprite?: [number, boolean] | null; t?: number; frames?: number }) {
  if (ONLY.length && !ONLY.some((k) => name.includes(k))) return;
  await page.evaluate(({ o }) => {
    const v = (window as any).__viewer;
    v.extra.length = 0;
    let id = 70000;
    for (const s of o.mobjs ?? []) {
      const m = v.mkMobj(id++);
      Object.assign(m, { x: s.x, y: s.y, z: s.z, type: s.type, flags: s.flags ?? 0, slot: s.slot ?? -1, angle: ((s.angle ?? 0) * Math.PI) / 180, translation: s.translation ?? 0, frame: s.frame ?? 0 });
      m.sprite = s.sprite ? v.spriteNum(s.sprite) : 0;
      v.extra.push(m);
    }
    v.frame.royale = o.royale ?? null;
    v.setWeapon(o.psprite ? 'SNPG' : 'NONE');
    v.setWeaponFrame(o.psprite ? o.psprite[0] : 0, o.psprite ? o.psprite[1] : false);
    const [x, y, z, yaw, pitch] = o.cam;
    v.setCamera(x, y, z, yaw, pitch);
    v.step(0);
    for (let i = 0; i < (o.frames ?? 2); i++) { v.frame.tic = (o.t ?? 100) + i; v.renderOnce(); }
  }, { o });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, `br-${name}.png`) });
  console.log('shot', name);
}

const PLAY_SPRITE = 'PLAY';
const ahead = at(260, 40);
// storm: the wall crossing the street ahead, the next circle further in
const r = 2600;
const cIn = at(-r + 520, 0);
await shot('storm', {
  cam: [X, Y, null, D, 6], royale: { x: cIn.x, y: cIn.y, r, nx: at(-r + 900, -200).x, ny: at(-r + 900, -200).y, nr: r - 700 },
});
const cOut = at(r + 200, 0);
await shot('storm-outside', {
  cam: [X, Y, null, D, 4], royale: { x: cOut.x, y: cOut.y, r, nx: cOut.x, ny: cOut.y, nr: 1200 },
});
await shot('storm-altitude', {
  cam: [X - cx * 1500, Y - sy * 1500, F0 + 3600, D, -38], royale: { x: at(400).x, y: at(400).y, r: 2400, nx: at(900).x, ny: at(900).y, nr: 1100 },
});
await shot('buggy', {
  cam: [X, Y, null, D, -8], mobjs: [
    { ...ahead, z: floorAt(ahead.x, ahead.y), type: 140, angle: D + 140 },
    { ...ahead, z: floorAt(ahead.x, ahead.y), type: 0, sprite: PLAY_SPRITE, slot: 3, translation: 3, angle: D + 140 },
    { ...at(330, -110), z: floorAt(at(330, -110).x, at(330, -110).y), type: 140, angle: D + 60 },
  ],
});
const shipAt = at(900, 0);
await shot('dropship', {
  cam: [X, Y, null, D, 32], mobjs: [{ ...shipAt, z: F0 + 700, type: 138, angle: D + 120 }],
});
await shot('dropship-altitude', {
  cam: [X - cx * 900, Y - sy * 900, F0 + 4200, D, -20], mobjs: [{ ...at(-300, 150), z: F0 + 3900, type: 138, angle: D + 20 }],
});
const pa = at(300, -60), pb = at(380, 90);
await shot('parachuter', {
  cam: [X, Y, F0 + 1400, D, 4], mobjs: [
    { ...pa, z: F0 + 1300, type: 139, sprite: PLAY_SPRITE, frame: 1, slot: 4, translation: 2, angle: D + 200 },
    { ...pb, z: F0 + 1480, type: 139, sprite: PLAY_SPRITE, frame: 0, slot: 5, translation: 5, angle: D + 160 },
  ],
});
const c1 = at(170, -50), c2 = at(170, 20), c3 = at(260, 90);
await shot('crate', {
  cam: [X, Y, null, D, -4], t: 200, mobjs: [
    { ...c1, z: floorAt(c1.x, c1.y), type: 137, sprite: 'BAR1' },
    { ...c2, z: floorAt(c2.x, c2.y), type: 137, sprite: 'BAR1' },
    { ...c3, z: floorAt(c3.x, c3.y), type: 137, sprite: 'BAR1', flags: 0x20000000 },
  ],
});
await shot('sniper', { cam: [X, Y, null, D, 0], psprite: [0, false] });
await shot('sniper-fire', { cam: [X, Y, null, D, 0], psprite: [1, true] });
await shot('sniper-bolt', { cam: [X, Y, null, D, 0], psprite: [2, false] });
const pk = at(110, 0);
await shot('pickups', {
  cam: [X, Y, null, D, -12], mobjs: [
    { ...at(110, -20), z: floorAt(pk.x, pk.y), type: 141, sprite: 'SNPR' },
    { ...at(110, 30), z: floorAt(pk.x, pk.y), type: 143, sprite: 'GREN' },
  ],
});
await browser.close();
