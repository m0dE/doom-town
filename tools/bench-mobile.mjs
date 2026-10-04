#!/usr/bin/env node
/**
 * Phone performance: the page as a phone (844×390 @3x, touch) under Chrome's CPU
 * throttle, per room and graphics quality. Prints tic rate, sim ms, frame rate and
 * the per-frame JS costs (DESIGN.md "Mobile", "As implemented").
 *
 *   node tools/bench-mobile.mjs [--url=http://localhost:5293/] [--rooms=dm,war,br]
 *       [--quality=high,medium,low,auto] [--throttle=4,6] [--seconds=10] [--warm=8]
 *       [--shots=docs/shots]   (screenshots high vs low: mobile-quality-<room>-<q>.jpg)
 *
 * Needs a running dev server (npm run dev) or a preview. The GPU here is SwiftShader
 * (software GL, not throttled): frame rates are pessimistic, compare levels with each
 * other; the sim's tic rate under the throttle is the hard check.
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const URL0 = arg('url', 'http://localhost:5293/');
const ROOMS = arg('rooms', 'dm,war,br').split(',');
const QUALITIES = arg('quality', 'high,medium,low,auto').split(',');
const THROTTLES = arg('throttle', '4,6').split(',').map(Number);
const SECONDS = Number(arg('seconds', '10'));
const WARM = Number(arg('warm', '8'));
/** 1: the world view is not drawn (no GPU work at all): the CPU budget of sim + HUD + frame JS */
const NORENDER = arg('norender', '0') === '1';
const SHOTS = arg('shots', '') ? path.resolve(ROOT, arg('shots', '')) : '';
const PW = process.env.PLAYWRIGHT ?? '/app/data/home/arrr-mono/node_modules/playwright/index.mjs';
const CHROME = process.env.CHROME ?? '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/** room → URL query (offline) and how long the match needs before it is representative */
const ROOM = {
  dm: { q: 'room=bench-dm-1', label: 'deathmatch (64 slots)' },
  war: { q: 'room=bench-war-1', label: 'war (200 bots)' },
  // battle royale: a short lobby, then the drop; measured once the bots are down
  br: { q: 'room=test-br-1&lobby=2', label: 'battle royale BR01 (64)', ground: true },
};

const { chromium } = await import(PW);
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist'],
});

const say = (...a) => console.log(...a);
const rows = [];

async function run(roomKey, quality, throttle) {
  const R = ROOM[roomKey];
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await ctx.addInitScript((q) => {
    try {
      const p = JSON.parse(localStorage.getItem('freedm.prefs') ?? '{}') ?? {};
      localStorage.setItem('freedm.prefs', JSON.stringify({ name: 'bench', ...p, quality: q, showFps: true }));
    } catch { /* */ }
    // frame times from rAF, for the page's own frame rate
    const ft = [];
    let last = 0;
    const tick = (t) => { if (last) ft.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.__ft = ft;
  }, quality);
  const page = await ctx.newPage();
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`${URL0}?offline=1&${R.q}`);
  await page.waitForFunction(() => { const g = window.__game; return !!g && g.debug().frame > 5; }, null, { timeout: 180000, polling: 250 });
  // instrument: sim tics (incl. prediction re-sims), the whole frame, the HUD
  await page.evaluate(() => {
    const g = window.__game;
    const sim = g.app.sim;
    const acc = { tick: 0, tickN: 0, clone: 0, cloneN: 0, draw: 0, drawN: 0, hud: 0, hudN: 0, drawMax: 0 };
    window.__acc = acc;
    const wrap = (o, k, a, n) => { const f = o[k]; o[k] = function (...args) { const t = performance.now(); try { return f.apply(this, args); } finally { const d = performance.now() - t; acc[a] += d; acc[n]++; if (a === 'draw') acc.drawMax = Math.max(acc.drawMax, d); } }; };
    wrap(sim, 'tick', 'tick', 'tickN');
    wrap(sim, 'clone', 'clone', 'cloneN');
    wrap(g, 'draw', 'draw', 'drawN');
    wrap(g, 'updateHud', 'hud', 'hudN');
  });
  if (NORENDER) await page.evaluate(() => { window.__game.view.render = () => {}; });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  // turn slowly so the view is not one static picture
  const turn = arg('turn', '1') === '0' ? 0 : setInterval(() => { page.evaluate(() => { const g = window.__game; g.__yaw = (g.__yaw ?? 0) + 0.08; g.testLook?.(g.__yaw, 0); }).catch(() => {}); }, 400);
  if (R.ground) {
    // wait for the ground phase (PHASE_PLAY = 0, after lobby 4 and drop 5), at most 150 s
    await page.waitForFunction(() => { const s = window.__game.confirmed.latest(); return s && s.match[1] === 0; }, null, { timeout: 150000, polling: 1000 }).catch(() => say('    (BR still not in play phase)'));
  }
  await page.waitForTimeout(WARM * 1000);
  const before = await page.evaluate(() => { const g = window.__game; const a = window.__acc; window.__ft.length = 0; for (const k in a) a[k] = 0; return { frame: g.debug().frame, t: performance.now() }; });
  await page.waitForTimeout(SECONDS * 1000);
  const r = await page.evaluate((b0) => {
    const g = window.__game, d = g.debug(), a = window.__acc;
    const s = (performance.now() - b0.t) / 1000;
    const ft = [...window.__ft].sort((x, y) => x - y);
    const q = (p) => ft.length ? ft[Math.min(ft.length - 1, Math.floor(ft.length * p))] : 0;
    const snap = g.confirmed.latest();
    return {
      tics: (d.frame - b0.frame) / s, tickMs: a.tickN ? a.tick / a.tickN : 0, simPct: (a.tick + a.clone) / (s * 10),
      ticksPerS: a.tickN / s, clonesPerS: a.cloneN / s,
      fps: ft.length / s, p50: q(0.5), p95: q(0.95),
      drawMs: a.drawN ? a.draw / a.drawN : 0, drawMax: a.drawMax, hudMs: a.hudN ? a.hud / a.hudN : 0, renderMs: d.renderMs,
      render: d.render, phase: snap?.match[1], players: snap ? snap.ids.length : 0,
    };
  }, before);
  clearInterval(turn);
  if (SHOTS && (quality === 'high' || quality === 'low')) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, `mobile-quality-${roomKey}-${quality}.jpg`), type: 'jpeg', quality: 85 });
  }
  await ctx.close();
  const row = { room: roomKey, quality, throttle, ...r, errors: errors.slice(0, 2) };
  rows.push(row);
  const rd = r.render ?? {};
  say(`${roomKey.padEnd(4)} ${(NORENDER ? 'none' : quality).padEnd(6)} x${throttle}  tics/s ${r.tics.toFixed(1).padStart(5)}  sim ${r.tickMs.toFixed(2)} ms/tic (${r.simPct.toFixed(0)}% of main, ${r.ticksPerS.toFixed(0)} ticks/s)` +
    `  fps ${r.fps.toFixed(1).padStart(4)} (p50 ${r.p50.toFixed(0)} p95 ${r.p95.toFixed(0)} ms)  frame JS ${r.drawMs.toFixed(1)} ms (max ${r.drawMax.toFixed(0)}) render ${r.renderMs.toFixed(1)} hud ${r.hudMs.toFixed(1)}` +
    `  px ${rd.width ?? '?'}x${rd.height ?? '?'} lights ${rd.lights ?? '?'} bodies ${rd.bodies3d ?? '?'} phase ${r.phase}${errors.length ? '  ERR ' + errors[0] : ''}`);
}

/**
 * --gpu=1: the cost of a frame at each level on one view, rendered back to back, each
 * read back (best of 6) (the GPU's work included, nothing else running), unthrottled - the
 * relative cost of the levels, free of the frame loop's noise.
 */
async function gpu(roomKey) {
  const R = ROOM[roomKey];
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(180000);
  await page.goto(`${URL0}?offline=1&${R.q}`);
  await page.waitForFunction(() => { const g = window.__game; return !!g && g.debug().frame > 5; }, null, { timeout: 180000, polling: 250 });
  if (R.ground) await page.waitForFunction(() => window.__game.confirmed.latest()?.match[1] === 0, null, { timeout: 150000, polling: 1000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const out = {};
  for (const q of ['high', 'medium', 'low']) {
    await page.evaluate((lv) => window.__game.view.setQuality(lv), q);
    await page.waitForTimeout(1500);
    out[q] = await page.evaluate(() => {
      const r = window.__game.view.renderer, gl = r.gl.getContext();
      // a pixel read back waits for the GPU to finish the frame (gl.finish need not)
      const px = new Uint8Array(4);
      const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      r.render(); sync();
      let best = Infinity;
      for (let i = 0; i < 6; i++) { const t0 = performance.now(); r.render(); sync(); best = Math.min(best, performance.now() - t0); }
      return { ms: best, px: `${r.stats.width}x${r.stats.height}`, lights: r.stats.lights, calls: r.stats.calls };
    });
    // the same view at each level (the player stands still): docs/shots/mobile-quality-<room>-<level>.jpg
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `mobile-quality-${roomKey}-${q}.jpg`), type: 'jpeg', quality: 85 });
  }
  say(`${roomKey.padEnd(4)} frame (render + read back, best of 6, x1): ` + Object.entries(out).map(([q, o]) => `${q} ${o.ms.toFixed(0)} ms (${o.px}, ${o.lights} lights, ${o.calls} calls)`).join('  |  '));
  await ctx.close();
}

try {
  if (arg('gpu', '0') === '1') { for (const room of ROOMS) await gpu(room); ROOMS.length = 0; }
  for (const room of ROOMS) for (const q of QUALITIES) for (const th of THROTTLES) await run(room, q, th);
} finally {
  await browser.close();
}
if (arg('json', '')) (await import('node:fs')).writeFileSync(arg('json', ''), JSON.stringify(rows, null, 1));
