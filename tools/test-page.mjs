#!/usr/bin/env node
/**
 * The real page in a real browser: the start screen, offline play, the HUD,
 * the scoreboard, the Esc menu and leaving.
 *
 *   node tools/test-page.mjs [--url=http://localhost:5190/] [--shots=docs/shots]
 *
 * Needs a running dev server (npm run dev) or a preview of the export. Uses the
 * machine's cached Chromium and the monorepo's Playwright (nothing installed here).
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const URL0 = arg('url', 'http://localhost:5190/');
const SHOTS = path.resolve(ROOT, arg('shots', 'docs/shots'));
const PW = process.env.PLAYWRIGHT ?? '/app/data/home/arrr-mono/node_modules/playwright/index.mjs';
const CHROME = process.env.CHROME ?? '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
mkdirSync(SHOTS, { recursive: true });

const { chromium } = await import(PW);
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const fails = [];
const say = (...a) => console.log(...a);
const check = (ok, what) => { say(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };

try {
  // ------------------------------------------------------------------ menu at three sizes
  for (const [w, h, name] of [[1920, 1080, 'menu-1920x1080'], [1280, 720, 'menu-1280x720'], [420, 900, 'menu-narrow']]) {
    const p = await browser.newPage({ viewport: { width: w, height: h } });
    p.setDefaultTimeout(120000);
    const warm = new Promise((r) => p.on('console', (m) => { if (m.text().includes('3D view ready')) r(); }));
    await p.goto(URL0);
    // The menu builds the 3D view in the background; under software GL that blocks for seconds.
    await Promise.race([warm, p.waitForTimeout(90000)]);
    await p.waitForFunction(() => document.querySelectorAll('.srv-row').length > 0, null, { timeout: 15000 });
    await p.waitForTimeout(1200);
    await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    if (w === 1920) {
      const rows = await p.locator('.srv-row').count();
      check(rows >= 4, `server list shows the regional servers (${rows} rows)`);
      const logo = await p.evaluate(() => { const c = document.getElementById('logo'); return c.width > 100; });
      await p.waitForFunction(() => !!document.querySelector('canvas.doomguy-3d'), null, { timeout: 60000 }).catch(() => {});
      check(logo, 'title drawn');
      const hero = await p.evaluate(() => !!document.querySelector('canvas.doomguy-3d'));
      check(hero, 'the 3D marine is on the start screen');
    }
    await p.close();
  }

  // ------------------------------------------------------------------ offline play
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const warmed = new Promise((r) => page.on('console', (m) => { if (m.text().includes('3D view ready')) r(m.text()); }));
  await page.goto(URL0);
  // The time a player spends looking at the menu: everything is fetched and the 3D view built.
  say('  ' + await Promise.race([warmed, page.waitForTimeout(90000).then(() => 'no prewarm message')]));
  await page.waitForTimeout(1000);
  const t0 = Date.now();
  await page.click('#offline');
  // In the game: the match object is up and the loading screen is gone.
  await page.waitForFunction(() => !!window.__game && document.getElementById('loading').classList.contains('hidden'), null, { timeout: 20000, polling: 20 });
  const entered = Date.now() - t0;
  await page.waitForFunction(() => { const g = window.__game; return !!g && g.debug().frame > 5 && g.debug().slot >= 0; }, null, { timeout: 20000, polling: 20 });
  const playing = Date.now() - t0;
  check(entered < 2000, `Play offline → in the game in ${entered} ms, own marine on the map at ${playing} ms (target < 2000)`);
  await page.waitForTimeout(1500);
  const d0 = await page.evaluate(() => window.__game.debug());
  say('  start', JSON.stringify({ slot: d0.slot, pos: d0.pos, health: d0.health, frame: d0.frame }));

  // move, shoot, jump
  await page.mouse.click(640, 360);
  await page.evaluate(() => { const g = window.__game; g.testHold('forward', true); g.testHold('attack', true); });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { const g = window.__game; g.testHold('jump', true); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const g = window.__game; g.testHold('jump', false); g.testHold('right', true); });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(SHOTS, 'game-offline.png') });
  await page.evaluate(() => { const g = window.__game; for (const a of ['forward', 'attack', 'right']) g.testHold(a, false); });
  const d1 = await page.evaluate(() => window.__game.debug());
  say('  after', JSON.stringify({ pos: d1.pos, health: d1.health, frame: d1.frame, rollbacks: d1.rollbacks, desyncs: d1.desyncs }));
  const moved = d0.pos && d1.pos && Math.hypot(d1.pos[0] - d0.pos[0], d1.pos[1] - d0.pos[1]) > 16;
  check(!!moved, 'the marine moved when told to');

  // scoreboard
  await page.keyboard.down('Tab');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, 'game-scoreboard.png') });
  const scoresShown = await page.evaluate(() => !document.querySelector('.h-scores').hidden && document.querySelectorAll('.h-scores .row').length > 10);
  check(scoresShown, 'Tab shows the scoreboard');
  await page.keyboard.up('Tab');

  // minimal HUD style
  await page.evaluate(() => { localStorage.setItem('freedm.prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('freedm.prefs')), hud: 'full' })); });

  // Esc menu → Leave
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const pauseOpen = await page.evaluate(() => !!document.querySelector('.pause:not(.hidden)'));
  check(pauseOpen, 'Esc opens the menu');
  await page.screenshot({ path: path.join(SHOTS, 'game-menu.png') });
  // Players: Classic sprites / 3D, persisted
  await page.click('.pause [data-players="sprites"]');
  const sprites = await page.evaluate(() => JSON.parse(localStorage.getItem('freedm.prefs')).players === 'sprites' && window.__game.debug().render.bodies3d === 0);
  await page.click('.pause [data-players="3d"]');
  await page.waitForTimeout(800);
  const back3d = await page.evaluate(() => JSON.parse(localStorage.getItem('freedm.prefs')).players === '3d');
  check(sprites && back3d, 'Esc menu switches players between classic sprites and 3D, and keeps it');
  if (pauseOpen) await page.click('.pause [data-act="leave"]');
  await page.waitForTimeout(600);
  const back = await page.evaluate(() => !document.getElementById('menu').classList.contains('hidden') && !window.__game);
  check(back, 'Leave returns to the start screen');
  check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
  await page.close();
} catch (err) {
  fails.push(String(err?.stack ?? err));
  console.error(err);
} finally {
  await browser.close();
}
say(fails.length ? `FAIL (${fails.length})` : 'PASS');
process.exit(fails.length ? 1 : 0);
