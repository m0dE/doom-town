/**
 * Screenshots of the 3D player bodies and of an own rocket right after firing,
 * from a real offline match in the built bundle (npx vite build; npx vite preview --port 5193).
 *
 *   npx tsx tools/shots-3d.mts [--url=http://localhost:5193/] [--out=/tmp/shots] [--mode=bodies|rocket|both] [--n=12]
 *
 * Bodies: faces clusters of marines (nearest first) and takes a shot each time.
 * Rocket: walks (straight lines only, map geometry checked here) to a rocket
 * launcher or plasma gun on MAP19, dying and respawning until one is reachable,
 * then fires at a marine and takes a burst of shots.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadWad, parseMap } from '../src/wad/index.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k: string, d: string): string => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const URL0 = arg('url', 'http://localhost:5193/');
const OUT = arg('out', '/tmp/shots');
const MODE = arg('mode', 'both');
const N = Number(arg('n', '12'));
mkdirSync(OUT, { recursive: true });

const wad = loadWad(new Uint8Array(readFileSync(path.join(ROOT, 'public/freedm-lite.wad'))));
const map = parseMap('MAP19', wad.mapLumps('MAP19'));
/** doomednum → weapon bit (weapontype_t) */
const WEAPONS: Record<number, number> = { 2003: 4, 2004: 5, 2006: 6 };
const WANT = (1 << 4) | (1 << 5) | (1 << 6);
const targets = map.things.filter((t) => WEAPONS[t.type] !== undefined);

const BUCKET = 128;
const buckets = new Map<string, number[]>();
map.lines.forEach((l, i) => {
  const a = map.vertexes[l.v1], b = map.vertexes[l.v2];
  for (let bx = Math.floor(Math.min(a.x, b.x) / BUCKET); bx <= Math.floor(Math.max(a.x, b.x) / BUCKET); bx++)
    for (let by = Math.floor(Math.min(a.y, b.y) / BUCKET); by <= Math.floor(Math.max(a.y, b.y) / BUCKET); by++) {
      const k = `${bx},${by}`;
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i);
    }
});
/** Can a marine walk the straight segment? (no one-sided line, no step > 24, room >= 56, no blocking flag) */
function clear(x0: number, y0: number, x1: number, y1: number): boolean {
  const seen = new Set<number>();
  for (let bx = Math.floor(Math.min(x0, x1) / BUCKET); bx <= Math.floor(Math.max(x0, x1) / BUCKET); bx++)
    for (let by = Math.floor(Math.min(y0, y1) / BUCKET); by <= Math.floor(Math.max(y0, y1) / BUCKET); by++)
      for (const i of buckets.get(`${bx},${by}`) ?? []) {
        if (seen.has(i)) continue;
        seen.add(i);
        const l = map.lines[i];
        const a = map.vertexes[l.v1], b = map.vertexes[l.v2];
        const d = (x1 - x0) * (b.y - a.y) - (y1 - y0) * (b.x - a.x);
        if (Math.abs(d) < 1e-9) continue;
        const t = ((a.x - x0) * (b.y - a.y) - (a.y - y0) * (b.x - a.x)) / d;
        const u = ((a.x - x0) * (y1 - y0) - (a.y - y0) * (x1 - x0)) / d;
        if (t < -0.05 || t > 1.05 || u < 0 || u > 1) continue;
        if (l.back < 0 || (l.flags & 1)) return false;
        const f = map.sectors[map.sides[l.front].sector], k = map.sectors[map.sides[l.back].sector];
        if (Math.abs(f.floor - k.floor) > 24) return false;
        if (Math.min(f.ceil, k.ceil) - Math.max(f.floor, k.floor) < 56) return false;
      }
  return true;
}
/** Grid A* (32-unit cells, segments checked against the map) to the nearest wanted weapon. */
const CELL = 32;
function route(x: number, y: number): { x: number; y: number }[] | null {
  const goals = targets.map((t) => `${Math.round(t.x / CELL)},${Math.round(t.y / CELL)}`);
  const start = `${Math.round(x / CELL)},${Math.round(y / CELL)}`;
  const prev = new Map<string, string>([[start, '']]);
  let frontier = [start];
  for (let step = 0; step < 400 && frontier.length; step++) {
    const next: string[] = [];
    for (const c of frontier) {
      if (goals.includes(c)) {
        const out: { x: number; y: number }[] = [];
        for (let k = c; k; k = prev.get(k)!) { const [cx, cy] = k.split(',').map(Number); out.unshift({ x: cx * CELL, y: cy * CELL }); }
        return out;
      }
      const [cx, cy] = c.split(',').map(Number);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${cx + dx},${cy + dy}`;
        if (prev.has(k)) continue;
        const ax = cx * CELL, ay = cy * CELL, bx = (cx + dx) * CELL, by = (cy + dy) * CELL;
        // the marine is 32 wide: check the centre line and both edges
        const ox = dy * 14, oy = dx * 14;
        if (!clear(ax, ay, bx, by) || !clear(ax + ox, ay + oy, bx + ox, by + oy) || !clear(ax - ox, ay - oy, bx - ox, by - oy)) continue;
        prev.set(k, c);
        next.push(k);
      }
    }
    frontier = next;
  }
  return null;
}

const PW = process.env.PLAYWRIGHT ?? '/app/data/home/arrr-mono/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(120000);
page.on('pageerror', (e: Error) => console.log('pageerror', e.message));
page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') console.log('console error', m.text().slice(0, 300)); });
await page.goto(`${URL0}?offline=1`);
await page.waitForFunction(() => { const g = (window as any).__game; return !!g && g.debug().frame > 5 && g.debug().slot >= 0; }, null, { polling: 200 });
await page.mouse.click(640, 360);
await page.waitForTimeout(1000);

type Dbg = { pos: number[] | null; health: number | null; owned: number | null; weapon: number | null; fps: number; renderMs: number; render: Record<string, number> | null; ownMissiles: number };
const dbg = (): Promise<Dbg> => page.evaluate(() => (window as any).__game.debug());
const hold = (a: string, d: boolean): Promise<void> => page.evaluate(([x, y]) => (window as any).__game.testHold(x, y), [a, d] as const);
const face = (dir: number, pitch = 0): Promise<void> => page.evaluate(([d, p]) => (window as any).__game.testFace(d, p), [dir, pitch] as const);
const bodies = (): Promise<{ id: number; slot: number; dist: number; dir: number; dz: number; frame: string; color: number }[]> =>
  page.evaluate(() => (window as any).__game.testBodies());
async function respawnIfDead(d: Dbg): Promise<boolean> {
  if (d.health !== null && d.health <= 0) { await hold('use', true); await page.waitForTimeout(200); await hold('use', false); return true; }
  return false;
}

if (MODE === 'bodies' || MODE === 'both') {
  for (let i = 0; i < N; i++) {
    const d = await dbg();
    if (await respawnIfDead(d)) { await page.waitForTimeout(800); continue; }
    const bs = (await bodies()).filter((b) => b.dist > 60 && b.dist < 700 && Math.abs(b.dz) < 64);
    if (!bs.length) { await page.waitForTimeout(800); continue; }
    let best = bs[0], score = -1e9;
    for (const b of bs) {
      const near = bs.filter((o) => Math.abs(Math.atan2(Math.sin(o.dir - b.dir), Math.cos(o.dir - b.dir))) < 0.5);
      const s = near.length + new Set(near.map((o) => o.color)).size * 0.5 + near.filter((o) => o.frame >= 'H').length - b.dist / 500;
      if (s > score) { score = s; best = b; }
    }
    await face(best.dir, -0.05);
    await page.waitForTimeout(400);
    const file = path.join(OUT, `bodies-${i}.png`);
    await page.screenshot({ path: file });
    const near = (await bodies()).slice(0, 8).map((b) => `${b.slot}:${b.frame}@${Math.round(b.dist)}c${b.color}`).join(' ');
    console.log(file, `fps ${d.fps.toFixed(1)} render ${d.renderMs.toFixed(1)} ms`, JSON.stringify(d.render), near);
    await page.waitForTimeout(700);
  }
}

if (MODE === 'stage') {
  // a staged line-up through the game's own body path: close and mid range, colours,
  // one firing, one dying, one gibbed, one invisible (fuzz), in open floor ahead
  for (let k = 0; k < 6; k++) {
    let d = await dbg();
    if (await respawnIfDead(d)) { await page.waitForTimeout(400); d = await dbg(); }
    if (!d.pos) continue;
    const [x, y] = d.pos;
    let dir = 0;
    for (let a = 0; a < 64; a++) {
      const t = (a / 64) * Math.PI * 2;
      if (clear(x, y, x + Math.cos(t) * 520, y + Math.sin(t) * 520) && clear(x - Math.sin(t) * 120, y + Math.cos(t) * 120, x + Math.cos(t) * 400 - Math.sin(t) * 120, y + Math.sin(t) * 400 + Math.cos(t) * 120)
        && clear(x + Math.sin(t) * 120, y - Math.cos(t) * 120, x + Math.cos(t) * 400 + Math.sin(t) * 120, y + Math.sin(t) * 400 - Math.cos(t) * 120)) { dir = t; break; }
    }
    await face(dir, -0.04);
    await page.evaluate(`window.__game.testStage([
      { fwd: 92, left: 46, face: 0.5, frame: 'E', color: 3 },
      { fwd: 150, left: -62, face: -0.7, frame: 'F', color: 4 },
      { fwd: 128, left: 2, face: 1.3, frame: 'N', color: 0 },
      { fwd: 205, left: -14, face: 0.4, frame: 'W', color: 7 },
      { fwd: 260, left: 72, face: 2.4, frame: 'B', color: 5 },
      { fwd: 380, left: -40, face: -1.2, frame: 'C', color: 9 },
      { fwd: 200, left: 118, face: 0.0, frame: 'A', color: 12, flags: 0x40000 },
    ])`);
    await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(OUT, `stage-${k}.png`) });
    console.log(`stage-${k}`, x, y, dir.toFixed(2));
    await page.evaluate('window.__game.testStage([])');
    await page.waitForTimeout(1500);
  }
}

if (MODE === 'flash' || MODE === 'both') {
  for (let k = 0; k < 4; k++) {
    const d = await dbg();
    if (await respawnIfDead(d)) { await page.waitForTimeout(800); continue; }
    // (strings: tsx would put its __name helper into a function passed to the page)
    const t = await page.evaluate(`new Promise((done) => {
      const g = window.__game;
      g.testHold('attack', true);
      const t0 = performance.now();
      function poll() {
        if (g.frame && g.frame.player && g.frame.player.flash) { done('flash after ' + Math.round(performance.now() - t0) + ' ms'); return; }
        if (performance.now() - t0 > 3000) { done('no flash'); return; }
        requestAnimationFrame(poll);
      }
      poll();
    })`) as string;
    await page.screenshot({ path: path.join(OUT, `flash-${k}.png`) });
    await hold('attack', false);
    console.log(`flash-${k}`, t);
    await page.waitForTimeout(1200);
  }
}

if (MODE === 'rocket' || MODE === 'both') {
  let have = false;
  // walking is steered from here: a small view draws fast, so the steering keeps up
  await page.setViewportSize({ width: 320, height: 200 });
  await hold('walk', true);
  for (let tries = 0; tries < 60 && !have; tries++) {
    const d = await dbg();
    if (((d.owned ?? 0) & WANT) !== 0) { have = true; break; }
    if (await respawnIfDead(d)) { await page.waitForTimeout(600); continue; }
    if (!d.pos) { await page.waitForTimeout(500); continue; }
    const [x, y] = d.pos;
    const path0 = route(x, y);
    if (!path0) { console.log('no route from', x, y); await hold('use', true); await page.waitForTimeout(300); await hold('use', false); await page.waitForTimeout(2000); continue; }
    console.log(`route of ${path0.length} cells from ${x},${y}`);
    await hold('forward', true);
    let wp = 0;
    for (let k = 0; k < 400 && wp < path0.length; k++) {
      const e = await dbg();
      if (!e.pos || (e.health ?? 0) <= 0) break;
      if (((e.owned ?? 0) & WANT) !== 0) { have = true; break; }
      while (wp < path0.length && Math.hypot(path0[wp].x - e.pos[0], path0[wp].y - e.pos[1]) < 24) wp++;
      // look ahead to the furthest waypoint in a straight line
      let la = wp;
      while (la + 1 < path0.length && la - wp < 8 && clear(e.pos[0], e.pos[1], path0[la + 1].x, path0[la + 1].y)) la++;
      const t = path0[Math.min(la, path0.length - 1)];
      await face(Math.atan2(t.y - e.pos[1], t.x - e.pos[0]));
      await page.waitForTimeout(150);
    }
    await hold('forward', false);
    if (!have) { const e = await dbg(); have = ((e.owned ?? 0) & WANT) !== 0; }
  }
  await hold('walk', false);
  await page.setViewportSize({ width: 1280, height: 720 });
  console.log('have rocket/plasma:', have);
  if (have) {
    const d = await dbg();
    await page.evaluate(() => (window as any).__game.testHold(((window as any).__game.debug().owned & 16) ? 'w5' : ((window as any).__game.debug().owned & 32) ? 'w6' : 'w7', true));
    await page.waitForTimeout(1500);
    const bs = (await bodies()).filter((b) => b.dist > 200 && b.dist < 900 && b.slot >= 0);
    await face(bs[0]?.dir ?? 0, 0);
    await page.waitForTimeout(600);
    console.log('weapon', (await dbg()).weapon, 'pos', d.pos);
    // one shot (a tap): wait in the page until our missile exists, let one frame draw, then shoot the screen
    for (let k = 0; k < 4; k++) {
      await face((bs[k % Math.max(1, bs.length)]?.dir ?? 0), 0.06);
      await page.waitForTimeout(500);
      const t = await page.evaluate(`new Promise((done) => {
        const g = window.__game;
        const n0 = g.debug().ownMissiles;
        g.testHold('attack', true);
        const t0 = performance.now();
        function poll() {
          const d = g.debug();
          if (d.ownMissiles > n0) { g.testHold('attack', false); requestAnimationFrame(function () { done('own missile after ' + Math.round(performance.now() - t0) + ' ms, frame ' + d.frame); }); return; }
          if (performance.now() - t0 > 4000) { g.testHold('attack', false); done('no missile'); return; }
          requestAnimationFrame(poll);
        }
        poll();
      })`) as string;
      await page.screenshot({ path: path.join(OUT, `rocket-${k}.png`) });
      console.log(`rocket-${k}`, t);
      await page.waitForTimeout(1500);
    }
  }
}
await browser.close();
