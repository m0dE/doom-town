#!/usr/bin/env node
/**
 * N real pages (default 3) joining one room at the same moment on a local ARRR cluster.
 *
 *   (cd /app/data/home/arrr-mono && node e2e/cluster.js)      # central :9201 + nodes
 *   VITE_ARRR_APP_ID=freedm-local-35 npx vite --port 5190      # an app central has never seen:
 *                                                               # the first connect creates it at 35 Hz
 *   node tools/test-mp.mjs [--players=3] [--seconds=60] [--room=mp-test] [--url=http://localhost:5190/]
 *
 * Asserts: every page is in the same world (N humans in each roster, same slots),
 * each sees every other one move, frags register, the network runs at 35 tics/s on
 * every page, and the pages stay in sync for the whole run: at every sample the
 * world hashes agree on every hashed frame they have in common (not just once at the
 * end), with zero desyncs and verdicts actually reached.
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const BASE = arg('url', 'http://localhost:5190/');
const CENTRAL = arg('central', 'http://localhost:9201');
const ROOM = arg('room', `mp-${Date.now().toString(36)}`);
const SECONDS = Number(arg('seconds', 60));
const PLAYERS = Number(arg('players', 3));
const SHOTS = path.resolve(ROOT, arg('shots', 'docs/shots'));
const PW = process.env.PLAYWRIGHT ?? '/app/data/home/arrr-mono/node_modules/playwright/index.mjs';
const CHROME = process.env.CHROME ?? '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
mkdirSync(SHOTS, { recursive: true });

const { chromium } = await import(PW);
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const url = `${BASE}?room=${encodeURIComponent(ROOM)}&central=${encodeURIComponent(CENTRAL)}`;

async function open(name, i) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(([n, c]) => { localStorage.setItem('freedm.prefs', JSON.stringify({ name: n, color: c })); }, [name, 3 + i]);
  await page.goto(url);
  await page.waitForFunction(() => { const g = window.__game; return !!g && g.debug().slot >= 0 && g.debug().frame > 10; }, null, { timeout: 90000 });
  return { page, errors, name };
}

/** Every hashed frame in [from, to] the page still remembers: frame → hash. */
const hashesOf = (P, from, to) => P.page.evaluate(([a, b]) => {
  const w = window.__game.net.lockstep.world;
  const out = {};
  for (let f = a; f <= b; f++) { const h = w.hashAt(f); if (h !== undefined) out[f] = h; }
  return out;
}, [from, to]);

/** Compare all pages on the hashed frames they share in the last `span` confirmed frames. */
async function agree(pages, span = 120) {
  const frames = await Promise.all(pages.map((P) => P.page.evaluate(() => window.__game.net.lockstep.frame)));
  const to = Math.min(...frames) - 2, from = to - span;
  const maps = await Promise.all(pages.map((P) => hashesOf(P, from, to)));
  const common = Object.keys(maps[0]).filter((f) => maps.every((m) => m[f] !== undefined));
  const bad = common.filter((f) => maps.some((m) => m[f] !== maps[0][f]));
  return { compared: common.length, bad, from, to };
}

try {
  // Join together: every page dials in the same instant.
  const t0join = Date.now();
  const pages = await Promise.all(NAMES.slice(0, PLAYERS).map((n, i) => open(n, i)));
  console.log(`${PLAYERS} pages joined in ${((Date.now() - t0join) / 1000).toFixed(1)} s`);
  await pages[0].page.waitForTimeout(3000);

  const rosters = await Promise.all(pages.map((P) => P.page.evaluate(() => window.__game.roster())));
  rosters.forEach((r, i) => console.log(`roster ${pages[i].name}`, JSON.stringify(r.map((x) => [x.name, x.slot]))));
  check(rosters.every((r) => r.length === PLAYERS), `each page sees ${PLAYERS} humans (${rosters.map((r) => r.length).join(', ')})`);
  const key = (r) => JSON.stringify(r.map((x) => [x.id, x.slot]));
  check(rosters.every((r) => key(r) === key(rosters[0])), 'every page puts the same players in the same slots');

  const ids = await Promise.all(pages.map((P) => P.page.evaluate(() => window.__game.id)));
  const posOf = async (P, id) => (await P.page.evaluate(() => window.__game.roster())).find((r) => r.id === id)?.pos ?? null;
  const tot0 = await pages[0].page.evaluate(() => window.__game.totals());

  // Drive every page differently: run, strafe, turn at its own rate, shoot, jump, switch weapon.
  const drive = (P, k) => P.page.evaluate((k) => {
    const g = window.__game;
    let t = 0;
    window.__drive = setInterval(() => {
      t++;
      g.testHold('forward', (t + k) % 23 > 2); g.testHold('back', (t + k) % 23 <= 2);
      g.testHold('left', k % 2 === 0 && t % 11 < 4); g.testHold('right', k % 2 === 1 && t % 13 < 5);
      g.testHold('attack', t % (3 + k) !== 0);
      g.testHold('jump', t % (7 + k) === 0);
      g.testHold(`w${2 + ((t >> 6) + k) % 3}`, t % 64 === 0);
      g.testLook(((t * (0.1 + 0.05 * k) + k * 2) % (2 * Math.PI)), Math.sin(t * 0.03 + k) * 0.3);
    }, 100);
  }, k);
  const before = await Promise.all(pages.map((P) => Promise.all(ids.map((id) => posOf(P, id)))));
  await Promise.all(pages.map((P, k) => drive(P, k)));

  // Sample: tic rate, prediction, and full hash agreement, every 5 s.
  // tps is frames advanced per second since the previous sample (a page that is still
  // catching up after its join runs fast for a while; the last interval is the steady rate).
  const mark = () => Promise.all(pages.map((P) => P.page.evaluate(() => ({ f: window.__game.net.lockstep.frame, t: performance.now() }))));
  let net0 = await mark();
  let compared = 0, mismatched = 0;
  const pick = (d) => ({ frame: d.frame, tps: d.tps, fps: Math.round(d.fps), rtt: d.rtt, delay: Math.round(d.delayMs), lead: d.lead, rollbacks: d.rollbacks, starv: d.starvations, desyncs: d.desyncs, verdicts: d.verdicts });
  let last = [];
  for (let s = 0; s < SECONDS; s += 5) {
    await pages[0].page.waitForTimeout(5000);
    last = await Promise.all(pages.map((P, i) => P.page.evaluate((n0) => {
      const d = window.__game.debug();
      return { ...d, tps: Math.round(((d.frame - n0.f) / ((performance.now() - n0.t) / 1000)) * 10) / 10 };
    }, net0[i])));
    net0 = await mark();
    const a = await agree(pages);
    compared += a.compared; mismatched += a.bad.length;
    console.log(`t=${s + 5}s hashes ${a.compared - a.bad.length}/${a.compared} agree [${a.from}..${a.to}]`, JSON.stringify(Object.fromEntries(last.map((d, i) => [pages[i].name, pick(d)]))));
    if (a.bad.length) console.log('  mismatched frames', a.bad.slice(0, 10).join(' '));
  }

  const after = await Promise.all(pages.map((P) => Promise.all(ids.map((id) => posOf(P, id)))));
  const dist = (p, q) => (p && q ? Math.hypot(p[0] - q[0], p[1] - q[1]) : 0);
  for (let i = 0; i < PLAYERS; i++) for (let j = 0; j < PLAYERS; j++) {
    if (i === j) continue;
    const d = dist(before[i][j], after[i][j]);
    check(d > 64, `${pages[i].name} saw ${pages[j].name} move (${Math.round(d)} units)`);
  }

  for (const P of pages) await P.page.evaluate(() => { clearInterval(window.__drive); for (const a of ['forward', 'back', 'left', 'right', 'attack', 'jump']) window.__game.testHold(a, false); });
  await pages[0].page.waitForTimeout(2000);
  const fin = await agree(pages, 300);
  compared += fin.compared; mismatched += fin.bad.length;
  check(fin.compared > 0 && fin.bad.length === 0, `after the run: ${fin.compared - fin.bad.length}/${fin.compared} hashed frames agree on every page [${fin.from}..${fin.to}]`);
  check(compared > 0 && mismatched === 0, `whole run: ${compared - mismatched}/${compared} hash comparisons agree`);

  // Same confirmed world, same per-player numbers: positions/frags/deaths at one frame.
  const tots = await Promise.all(pages.map((P) => P.page.evaluate(() => window.__game.totals())));
  check(tots[0].frags > tot0.frags, `frags registered (room total ${tot0.frags} → ${tots.map((t) => t.frags).join(' / ')})`);
  check(last.every((d) => d.tps >= 33 && d.tps <= 37), `network runs at ~35 tics/s on every page (${last.map((d) => d.tps).join(', ')})`);
  check(last.every((d) => d.tickRate === 35), `node rate is 35 Hz (${last.map((d) => d.tickRate).join(', ')})`);
  check(last.every((d) => d.desyncs === 0), `zero desyncs (${last.map((d) => d.desyncs).join(', ')})`);
  check(last.every((d) => d.verdicts > 100), `the room reached verdicts (${last.map((d) => d.verdicts).join(', ')})`);
  // Last: a screenshot written into the project makes a dev server reload the page.
  for (const P of pages) await P.page.screenshot({ path: path.join(SHOTS, `mp-${P.name.toLowerCase()}.png`) });
  const errs = pages.flatMap((P) => P.errors);
  check(errs.length === 0, `no page errors ${errs.slice(0, 3).join(' | ')}`);
} catch (err) {
  fails.push(String(err?.stack ?? err));
  console.error(err);
} finally {
  await browser.close();
}
console.log(fails.length ? `FAIL (${fails.length})` : 'PASS');
process.exit(fails.length ? 1 : 0);
