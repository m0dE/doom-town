#!/usr/bin/env node
/**
 * Two real pages in one room on a local ARRR cluster.
 *
 *   (cd /app/data/home/arrr-mono && node e2e/cluster.js)      # central :9201 + nodes
 *   VITE_ARRR_APP_ID=freedm-local-35 npx vite --port 5190      # an app central has never seen:
 *                                                               # the first connect creates it at 35 Hz
 *   node tools/test-mp.mjs [--seconds=60] [--room=mp-test]
 *
 * Asserts: both pages are in the same world (two humans in each roster, same
 * slots), each sees the other move, frags register (the room's frag total rises
 * and both pages agree on it), and zero desyncs with verdicts actually reached.
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const BASE = arg('url', 'http://localhost:5190/');
const CENTRAL = arg('central', 'http://localhost:9201');
const ROOM = arg('room', `mp-${Date.now().toString(36)}`);
const SECONDS = Number(arg('seconds', 60));
const SHOTS = path.resolve(ROOT, arg('shots', 'docs/shots'));
const PW = process.env.PLAYWRIGHT ?? '/app/data/home/arrr-mono/node_modules/playwright/index.mjs';
const CHROME = process.env.CHROME ?? '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
mkdirSync(SHOTS, { recursive: true });

const { chromium } = await import(PW);
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const url = `${BASE}?room=${encodeURIComponent(ROOM)}&central=${encodeURIComponent(CENTRAL)}`;

async function open(name) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((n) => { localStorage.setItem('freedm.prefs', JSON.stringify({ name: n, color: n === 'Alpha' ? 3 : 4 })); }, name);
  await page.goto(url);
  await page.waitForFunction(() => { const g = window.__game; return !!g && g.debug().slot >= 0 && g.debug().frame > 10; }, null, { timeout: 60000 });
  return { page, errors, name };
}

try {
  const A = await open('Alpha');
  const B = await open('Bravo');
  await A.page.waitForTimeout(3000);
  const ra = await A.page.evaluate(() => window.__game.roster());
  const rb = await B.page.evaluate(() => window.__game.roster());
  console.log('roster A', JSON.stringify(ra));
  console.log('roster B', JSON.stringify(rb));
  check(ra.length === 2 && rb.length === 2, 'each page sees two humans');
  check(JSON.stringify(ra.map((r) => [r.id, r.slot])) === JSON.stringify(rb.map((r) => [r.id, r.slot])), 'both pages put the same players in the same slots');

  const aId = await A.page.evaluate(() => window.__game.id);
  const bId = await B.page.evaluate(() => window.__game.id);
  const posOf = async (P, id) => (await P.page.evaluate(() => window.__game.roster())).find((r) => r.id === id)?.pos ?? null;
  const t0 = await A.page.evaluate(() => window.__game.totals());

  // Drive both: run in circles, shoot, jump.
  const drive = (P, k) => P.page.evaluate((k) => {
    const g = window.__game;
    let t = 0;
    window.__drive = setInterval(() => {
      t++;
      g.testHold('forward', true); g.testHold('attack', t % 3 !== 0);
      g.testHold('jump', t % 7 === 0);
      g.testLook(((t * 0.15 + k) % (2 * Math.PI)), 0);
    }, 100);
  }, k);
  const b0 = await posOf(A, bId), a0 = await posOf(B, aId);
  await drive(A, 0); await drive(B, 2);
  const samples = [];
  for (let s = 0; s < SECONDS; s += 5) {
    await A.page.waitForTimeout(5000);
    const da = await A.page.evaluate(() => window.__game.debug());
    const db = await B.page.evaluate(() => window.__game.debug());
    samples.push({ s: s + 5, a: { frame: da.frame, desyncs: da.desyncs, verdicts: da.verdicts, rollbacks: da.rollbacks, rtt: da.rtt }, b: { frame: db.frame, desyncs: db.desyncs, verdicts: db.verdicts, rollbacks: db.rollbacks, rtt: db.rtt } });
    console.log(JSON.stringify(samples.at(-1)));
  }
  const b1 = await posOf(A, bId), a1 = await posOf(B, aId);
  const dist = (p, q) => (p && q ? Math.hypot(p[0] - q[0], p[1] - q[1]) : 0);
  check(dist(b0, b1) > 64, `A saw B move (${Math.round(dist(b0, b1))} units)`);
  check(dist(a0, a1) > 64, `B saw A move (${Math.round(dist(a0, a1))} units)`);

  for (const P of [A, B]) await P.page.evaluate(() => clearInterval(window.__drive));
  await A.page.waitForTimeout(2000);
  // Agreement at one frame: ask both for the hash at a frame both have.
  const ta = await A.page.evaluate(() => window.__game.totals());
  const tb = await B.page.evaluate(() => window.__game.totals());
  const f = Math.min(ta.frame, tb.frame) - 5;
  const ha = await A.page.evaluate((f) => window.__game.net.lockstep.world.hashAt(f), f);
  const hb = await B.page.evaluate((f) => window.__game.net.lockstep.world.hashAt(f), f);
  check(ha !== undefined && ha === hb, `same world hash at frame ${f} (${ha?.toString(16)} / ${hb?.toString(16)})`);
  check(ta.frags > t0.frags, `frags registered (room total ${t0.frags} → ${ta.frags}, B says ${tb.frags})`);
  const last = samples.at(-1);
  check(last.a.desyncs === 0 && last.b.desyncs === 0, `zero desyncs (A ${last.a.desyncs}, B ${last.b.desyncs})`);
  check(last.a.verdicts > 100 && last.b.verdicts > 100, `the room reached verdicts (A ${last.a.verdicts}, B ${last.b.verdicts})`);
  // Last: a screenshot written into the project makes a dev server reload the page.
  await A.page.screenshot({ path: path.join(SHOTS, 'mp-alpha.png') });
  await B.page.screenshot({ path: path.join(SHOTS, 'mp-bravo.png') });
  check(A.errors.length + B.errors.length === 0, `no page errors ${[...A.errors, ...B.errors].slice(0, 3).join(' | ')}`);
} catch (err) {
  fails.push(String(err?.stack ?? err));
  console.error(err);
} finally {
  await browser.close();
}
console.log(fails.length ? `FAIL (${fails.length})` : 'PASS');
process.exit(fails.length ? 1 : 0);
