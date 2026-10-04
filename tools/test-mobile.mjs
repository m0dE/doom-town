#!/usr/bin/env node
/**
 * The page as a phone and a tablet (DESIGN.md "Mobile"): Playwright device emulation
 * (isMobile, hasTouch) and real multi-touch through CDP Input.dispatchTouchEvent - no
 * mouse, no keys, no test hooks to steer (the hooks only read state back).
 *
 *   node tools/test-mobile.mjs [--url=http://localhost:5190/] [--shots=docs/shots] [--only=menu,practice,war,br] [--throttle=4]
 *
 * Covers: the start screen at 844x390 @3x, 390x844 @3x and a 1024x768 tablet (tap
 * targets, no sideways scrolling, the Controls and Create dialogs); Practice: TAP TO
 * PLAY, the stick moves, a drag looks, FIRE shoots (and looks while dragged), JUMP,
 * weapons, move + look + fire at once, no stuck buttons after touchcancel / blur, the
 * scoreboard, the Esc menu and its touch rows, left-handed, chat, the rotate card, a
 * mouse taking over and a touch taking back; a war room's map button; a battle royale
 * room from the lobby through the drop (JUMP), the chute, the landing, a crate (USE),
 * ZOOM and GRENADE. Screenshots: docs/shots/mobile-*.jpg. The tic rate under a CPU
 * throttle is reported (software GL here, so not a pass/fail number).
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const URL0 = arg('url', 'http://localhost:5190/');
const SHOTS = path.resolve(ROOT, arg('shots', 'docs/shots'));
const ONLY = arg('only', 'menu,practice,war,br').split(',');
const THROTTLE = Number(arg('throttle', '4'));
const PW = process.env.PLAYWRIGHT ?? '/app/data/home/arrr-mono/node_modules/playwright/index.mjs';
const CHROME = process.env.CHROME ?? '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
mkdirSync(SHOTS, { recursive: true });

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const { chromium } = await import(PW);
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const fails = [];
const notes = [];
const say = (...a) => console.log(...a);
const check = (ok, what) => { say(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// CSS-pixel size (844x390 for a 3x phone): the repo keeps small JPEGs
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `mobile-${name}.jpg`), type: 'jpeg', quality: 85, scale: 'css' });

async function phone(w, h, dpr) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true, userAgent: UA });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const cdp = await ctx.newCDPSession(page);
  return { ctx, page, errors, cdp, touch: new Touch(cdp) };
}

/** Fingers on the glass: every event carries all the active points, as a real screen does. */
class Touch {
  constructor(cdp) { this.cdp = cdp; this.pts = new Map(); this.next = 1; }
  list() { return [...this.pts.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 8, radiusY: 8, force: 1 })); }
  async down(x, y) { const id = this.next++; this.pts.set(id, { x, y }); await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: this.list() }); return id; }
  async move(id, x, y) { this.pts.set(id, { x, y }); await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: this.list() }); }
  async up(id) { this.pts.delete(id); await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: this.list() }); }
  async cancel() { this.pts.clear(); await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); }
  async tap(x, y, ms = 60) { const id = await this.down(x, y); await sleep(ms); await this.up(id); }
  /** A drag in steps (a finger moves in many small events). */
  async drag(id, x0, y0, x1, y1, steps = 10, ms = 16) {
    for (let i = 1; i <= steps; i++) { await this.move(id, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps); await sleep(ms); }
  }
}

const center = async (page, sel) => page.evaluate((s) => {
  const el = [...document.querySelectorAll(s)].find((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  if (!el) return null;
  const r0 = el.getBoundingClientRect();
  if (r0.top < 0 || r0.bottom > innerHeight) el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, right: r.right };
}, sel);
const dbg = (page) => page.evaluate(() => window.__game?.debug() ?? null);
const tapSel = async (page, touch, sel) => { const c = await center(page, sel); if (!c) throw new Error(`nothing to tap: ${sel}`); await touch.tap(c.x, c.y); };
const wrapA = (a) => { a %= Math.PI * 2; if (a > Math.PI) a -= Math.PI * 2; if (a < -Math.PI) a += Math.PI * 2; return a; };

async function startMatch(page, query) {
  await page.goto(`${URL0}?${query}`);
  await page.waitForFunction(() => { const g = window.__game; return !!g && g.debug().frame > 5 && g.debug().slot >= 0; }, null, { timeout: 120000, polling: 100 });
  await sleep(800);
}

/** Practice bots shoot back: if we are dead, FIRE respawns us (touch, like a player would). */
async function ensureAlive(page, touch) {
  for (let i = 0; i < 40; i++) {
    const d = await dbg(page);
    // alive, and the controls show it (they follow the HUD a frame later)
    if (d && d.dead === false && d.pos && await page.evaluate(() => !document.querySelector('.tc').classList.contains('dead'))) return;
    const f = await center(page, '.t-fire');
    if (f) await touch.tap(f.x, f.y, 80);
    await sleep(250);
  }
}

/** Turn the view to a map direction with look drags on the right side (touch only). */
async function aimAt(page, touch, dir, W, H) {
  for (let i = 0; i < 10; i++) {
    const { view, speed } = await page.evaluate(() => ({ view: window.__game.testViewDir(), speed: JSON.parse(localStorage.getItem('freedm.prefs') ?? '{}').touchLook ?? 1 }));
    const delta = wrapA(dir - view);
    if (Math.abs(delta) < 0.06) return true;
    // yaw -= dx * 0.0044 * speed: a drag to the left turns left (yaw up)
    const px = Math.max(-W * 0.22, Math.min(W * 0.22, -delta / (0.0044 * speed)));
    const x0 = W * 0.7 - px / 2, y0 = H * 0.42;
    const id = await touch.down(x0, y0);
    await touch.drag(id, x0, y0, x0 + px, y0, 6, 12);
    await touch.up(id);
    await sleep(60);
  }
  return false;
}

try {
  // ------------------------------------------------------------------ the start screen
  if (ONLY.includes('menu')) {
    for (const [w, h, dpr, name] of [[844, 390, 3, 'landscape'], [390, 844, 3, 'portrait'], [1024, 768, 2, 'tablet'], [360, 640, 3, '360']]) {
      const { ctx, page, errors, touch } = await phone(w, h, dpr);
      await page.goto(URL0);
      await page.waitForFunction(() => document.querySelectorAll('.srv-row').length > 0, null, { timeout: 60000 });
      await sleep(1500);
      await shot(page, `menu-${name}`);
      const m = await page.evaluate(() => {
        const menu = document.getElementById('menu');
        const small = [];
        for (const el of menu.querySelectorAll('button, a, input:not([type=hidden]), [role=button], .srv-row')) {
          if (!el.getClientRects().length || el.closest('[hidden]')) continue;
          const r = el.getBoundingClientRect();
          if (r.height < 44 || r.width < 44) small.push(`${el.id || el.className || el.tagName}:${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        // nothing cut off at the server panel's edge (the Join buttons)
        const panel = document.querySelector('.servers').getBoundingClientRect();
        const clipped = [...document.querySelectorAll('.srv-join')].filter((b) => b.getBoundingClientRect().right > panel.right + 1).length;
        return { touch: document.documentElement.classList.contains('touch-mode'), wide: menu.scrollWidth - menu.clientWidth, small, clipped };
      });
      check(m.touch, `${name}: touch mode on (coarse pointer)`);
      check(m.wide <= 1, `${name}: no sideways scrolling (${m.wide}px over)`);
      check(m.clipped === 0, `${name}: the server rows fit their panel (${m.clipped} Join buttons cut off)`);
      check(m.small.length === 0, `${name}: tap targets >= 44 px (${m.small.slice(0, 6).join(', ')})`);
      if (name === 'portrait' || name === '360') {
        await tapSel(page, touch, '#controls-btn');
        await sleep(400);
        const c = await page.evaluate(() => {
          const d = document.getElementById('controls');
          const r = d.getBoundingClientRect();
          return { open: d.open, touchKeys: getComputedStyle(d.querySelector('.touch-keys')).display !== 'none', fits: r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1, scrolls: d.scrollHeight > d.clientHeight };
        });
        check(c.open && c.touchKeys && c.fits, `${name}: the Controls dialog shows the touch layout and fits (scrolls: ${c.scrolls})`);
        if (name === 'portrait') await shot(page, 'controls');
        await tapSel(page, touch, '#controls button[type=submit]');
        await sleep(300);
        await tapSel(page, touch, '#create-btn');
        await sleep(400);
        const cr = await page.evaluate(() => {
          const d = document.getElementById('create');
          const r = d.getBoundingClientRect();
          return { open: d.open, fits: r.top >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1 };
        });
        check(cr.open && cr.fits, `${name}: the Create room dialog fits the screen`);
        if (name === 'portrait') await shot(page, 'create');
        await page.evaluate(() => document.activeElement?.blur());
        await tapSel(page, touch, '#create [data-act="cancel"]');
      }
      check(errors.length === 0, `${name}: no page errors (${errors.slice(0, 3).join(' | ')})`);
      await ctx.close();
    }
    // the modding page at phone width
    const { ctx, page, errors } = await phone(360, 640, 3);
    await page.goto(`${URL0}modding.html`);
    await sleep(800);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    await shot(page, 'modding-360');
    check(over <= 1, `modding page at 360 px: no sideways scrolling (${over}px over)`);
    check(errors.length === 0, `modding page: no page errors (${errors.slice(0, 3).join(' | ')})`);
    await ctx.close();
  }

  // ------------------------------------------------------------------ Practice
  if (ONLY.includes('practice')) {
    const W = 844, H = 390;
    const { ctx, page, errors, touch, cdp } = await phone(W, H, 3);
    await startMatch(page, 'offline=1');
    let d = await dbg(page);
    check(d.touch && !d.locked, 'Practice: touch mode, waiting for a tap');
    const waiting = await page.evaluate(() => document.querySelector('.tc')?.classList.contains('waiting'));
    check(waiting, 'TAP TO PLAY shown (the tap catcher is up)');
    await shot(page, 'tap-to-play');
    await touch.tap(W / 2, H / 2);
    await sleep(500);
    d = await dbg(page);
    const fs = await page.evaluate(() => !!document.fullscreenElement);
    check(d.locked, `a tap starts play (fullscreen: ${fs})`);
    check(await page.evaluate(() => getComputedStyle(document.querySelector('.h-full')).display !== 'none' && JSON.parse(localStorage.getItem('freedm.prefs')).hud === 'full'), 'the minimal HUD is the touch default');

    // move with the stick
    await ensureAlive(page, touch);
    const p0 = (await dbg(page)).pos;
    let s = await touch.down(150, 270);
    await touch.drag(s, 150, 270, 150, 190, 8);
    await sleep(1400);
    const mid = await dbg(page);
    await touch.up(s);
    await sleep(300);
    const p1 = (await dbg(page)).pos;
    const moved = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    check(moved > 32, `the stick moves the marine (${Math.round(moved)} units; stick ${mid.stick.map((v) => v.toFixed(2))})`);
    check(Math.abs(mid.stick[0]) > 0.9, 'a full push runs (stick forward > 0.9)');
    d = await dbg(page);
    check(d.stick[0] === 0 && d.stick[1] === 0, 'lifting the thumb stops the stick');
    // a small push walks: inside the dead zone nothing, then under 60 % a walk
    s = await touch.down(150, 270);
    await touch.drag(s, 150, 270, 150, 266, 2);
    const dz = (await dbg(page)).stick[0];
    await touch.drag(s, 150, 266, 150, 250, 3);
    const walk = (await dbg(page)).stick[0];
    await touch.up(s);
    check(dz === 0 && walk > 0.1 && walk < 0.6, `dead zone (${dz}) and a gentle push walks (${walk.toFixed(2)})`);

    // look
    const y0 = (await dbg(page)).yaw;
    s = await touch.down(560, 200);
    await touch.drag(s, 560, 200, 660, 170, 10);
    await touch.up(s);
    await sleep(200);
    d = await dbg(page);
    const turned = wrapA(d.yaw - y0);
    check(turned < -0.3, `a drag on the right turns the view (${turned.toFixed(2)} rad for 100 px right) and pitches (${d.pitch.toFixed(2)})`);
    await sleep(600);
    const angleSim = (await dbg(page)).angle;
    check(angleSim !== null, `the sim's angle follows (${angleSim?.toFixed(2)})`);

    // fire
    const fire = await center(page, '.t-fire');
    const a0 = (await dbg(page)).ammo[0];
    s = await touch.down(fire.x, fire.y);
    await sleep(1200);
    // dragging FIRE looks too
    const yf = (await dbg(page)).yaw;
    await touch.drag(s, fire.x, fire.y, fire.x - 60, fire.y, 6);
    const yf2 = (await dbg(page)).yaw;
    await touch.up(s);
    await sleep(400);
    const a1 = (await dbg(page)).ammo[0];
    check(a1 < a0, `FIRE shoots (bullets ${a0} → ${a1})`);
    check(wrapA(yf2 - yf) > 0.15, `dragging FIRE aims (${wrapA(yf2 - yf).toFixed(2)} rad)`);
    d = await dbg(page);
    check(!d.held.includes('attack'), 'lifting FIRE stops firing');

    // jump: the view rises (practice bots kill fast: a death mid-test is retried)
    const jump = await center(page, '.t-jump');
    let jumped = false, z0 = 0, zMax = 0;
    for (let tries = 0; tries < 4 && !jumped; tries++) {
      await ensureAlive(page, touch);
      await sleep(300);
      z0 = (await dbg(page)).pos[2]; zMax = z0;
      await page.evaluate(() => window.__game.testClearButtons());
      await touch.tap(jump.x, jump.y, 80);
      for (let i = 0; i < 14; i++) { await sleep(50); zMax = Math.max(zMax, (await dbg(page)).pos[2]); }
      d = await dbg(page);
      jumped = (d.buttons & 4) !== 0 && zMax > z0 + 8;
    }
    check(jumped, `JUMP jumps (z ${z0} → ${zMax})`);

    // weapons: next, and the weapon icon
    let w0, w1, w2, cycled = false;
    for (let tries = 0; tries < 4 && !cycled; tries++) {
      await ensureAlive(page, touch);
      await sleep(300);
      w0 = (await dbg(page)).weapon;
      try {
        await tapSel(page, touch, '.t-weapons [data-t="next"]');
        await sleep(900);
        w1 = (await dbg(page)).weapon;
        await tapSel(page, touch, '.t-weapon');
      } catch { continue; }   // died in between: the weapon buttons hide
      await sleep(900);
      d = await dbg(page);
      w2 = d.weapon;
      cycled = !d.dead && w1 !== w0 && w2 !== w1;
    }
    check(cycled, `weapon next and the weapon icon cycle (${w0} → ${w1} → ${w2})`);
    const wl = await page.evaluate(() => document.querySelector('.t-weapon small').textContent);
    say(`  weapon button reads ${wl}`);

    // all at once: move + look + fire, three fingers
    await ensureAlive(page, touch);
    let q0, q1, qm = 0, multi = false;
    for (let tries = 0; tries < 4 && !multi; tries++) {
      await ensureAlive(page, touch);
      await sleep(200);
      q0 = await dbg(page);
      const fs1 = await touch.down(140, 280);
      const fs2 = await touch.down(520, 160);
      const fs3 = await touch.down(fire.x, fire.y);
      // a different way each try, in case a wall is in the way
      const [mx, my] = [[50, -70], [-60, -60], [0, 80], [80, 0]][tries];
      await touch.drag(fs1, 140, 280, 140 + mx, 280 + my, 5);
      await touch.drag(fs2, 520, 160, 600, 150, 8);
      await sleep(900);
      if (tries === 0 || !multi) await shot(page, 'practice');
      q1 = await dbg(page);
      for (const id of [fs1, fs2, fs3]) await touch.up(id);
      await sleep(300);
      qm = Math.hypot(q1.pos[0] - q0.pos[0], q1.pos[1] - q0.pos[1]);
      multi = !q0.dead && !q1.dead && qm > 16 && qm < 2500 && Math.abs(wrapA(q1.yaw - q0.yaw)) > 0.1 && q1.held.includes('attack');
    }
    check(multi, `move + look + fire at once (moved ${Math.round(qm)}, turned ${wrapA(q1.yaw - q0.yaw).toFixed(2)}, firing ${q1.held.includes('attack')})`);

    // nothing stuck: touchcancel, blur, the page hidden
    await touch.down(fire.x, fire.y);
    const st = await touch.down(140, 280);
    await touch.drag(st, 140, 280, 140, 200, 3);
    await touch.cancel();
    await sleep(100);
    d = await dbg(page);
    check(!d.held.includes('attack') && d.stick[0] === 0, 'touchcancel lets go of FIRE and the stick');
    await touch.down(fire.x, fire.y);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await sleep(100);
    d = await dbg(page);
    check(!d.held.includes('attack'), 'losing focus lets go of FIRE');
    await touch.cancel();

    // scoreboard: hold
    const sc = await center(page, '.t-top [data-t="scores"]');
    s = await touch.down(sc.x, sc.y);
    await sleep(500);
    const scoresOn = await page.evaluate(() => !document.querySelector('.h-scores').hidden);
    await shot(page, 'scoreboard');
    await touch.up(s);
    await sleep(300);
    const scoresOff = await page.evaluate(() => document.querySelector('.h-scores').hidden);
    say(`  scores: on ${scoresOn}, off ${scoresOff}, phase ${(await dbg(page)).phase}`);
    check(scoresOn && scoresOff, 'holding the scores button shows the scoreboard; letting go hides it');

    // the Esc menu
    await tapSel(page, touch, '.t-top [data-t="menu"]');
    await sleep(500);
    d = await dbg(page);
    const pm = await page.evaluate(() => {
      const box = document.querySelector('.pause .box');
      const r = box.getBoundingClientRect();
      const rows = [...document.querySelectorAll('.pause .touch-only')].map((e) => getComputedStyle(e).display !== 'none');
      return { rows, fits: r.top >= 0 && r.bottom <= innerHeight + 1, hidden: getComputedStyle(document.querySelector('.tc')).display === 'none' };
    });
    check(d.paused && pm.rows.length === 2 && pm.rows.every(Boolean) && pm.hidden, 'the menu button opens the Esc menu with the touch rows (controls hidden)');
    check(pm.fits, 'the Esc menu fits a landscape phone');
    await shot(page, 'pause');
    // left-handed
    await tapSel(page, touch, '.pause [data-k="leftHanded"]');
    await sleep(200);
    await tapSel(page, touch, '.pause [data-act="resume"]');
    await sleep(500);
    d = await dbg(page);
    const lf = await center(page, '.t-fire');
    check(!d.paused && d.locked && lf.x < W / 2, `left-handed puts FIRE on the left (x ${Math.round(lf.x)}), back in the game`);
    // the stick is now on the right
    let lmoved = 0;
    for (let tries = 0; tries < 4 && !(lmoved > 16); tries++) {
      await ensureAlive(page, touch);
      await sleep(300);
      const pl0 = (await dbg(page)).pos;
      s = await touch.down(W - 150, 270);
      await touch.drag(s, W - 150, 270, W - 150, 190, 6);
      await sleep(900);
      if (tries === 0) await shot(page, 'lefty');
      await touch.up(s);
      d = await dbg(page);
      lmoved = d.dead ? 0 : Math.hypot(d.pos[0] - pl0[0], d.pos[1] - pl0[1]);
      if (lmoved > 2500) lmoved = 0;   // a respawn, not a walk
    }
    check(lmoved > 16, `left-handed: the stick works on the right (${Math.round(lmoved)} units)`);
    await tapSel(page, touch, '.t-top [data-t="menu"]');
    await sleep(500);
    await tapSel(page, touch, '.pause [data-k="leftHanded"]');
    await sleep(300);
    await tapSel(page, touch, '.pause [data-act="resume"]');
    await sleep(500);
    d = await dbg(page);
    check(!d.paused && !(await page.evaluate(() => JSON.parse(localStorage.getItem('freedm.prefs')).leftHanded)), 'left-handed off again, back in the game');

    // chat
    await tapSel(page, touch, '.t-top [data-t="chat"]');
    await sleep(300);
    const chatOpen = await page.evaluate(() => document.activeElement?.closest('.h-chat') !== null && !!document.querySelector('.h-chat'));
    await page.keyboard.type('gg');
    await page.keyboard.press('Enter');
    await sleep(300);
    d = await dbg(page);
    check(chatOpen && d.touch && d.locked && !(await page.evaluate(() => !!document.querySelector('.h-chat'))), 'chat opens from its button, sends, and play resumes (still touch)');

    // leaving fullscreen pauses
    if (await page.evaluate(() => !!document.fullscreenElement)) {
      await page.evaluate(() => document.exitFullscreen());
      await sleep(500);
      check((await dbg(page)).paused, 'leaving fullscreen opens the menu');
      await tapSel(page, touch, '.pause [data-act="resume"]');
      await sleep(300);
    } else notes.push('fullscreen was not granted in this headless browser: the leave-fullscreen pause was not exercised');

    // portrait: the rotate card
    await page.setViewportSize({ width: H, height: W });
    await sleep(500);
    const rot = await page.evaluate(() => getComputedStyle(document.querySelector('.t-rotate')).display !== 'none');
    await shot(page, 'rotate');
    check(rot, 'portrait on a phone shows the rotate card');
    await page.setViewportSize({ width: W, height: H });
    await sleep(500);

    // a mouse takes over, a touch takes back
    await page.mouse.move(300, 200);
    await page.mouse.move(340, 220);
    await sleep(200);
    d = await dbg(page);
    const offUi = await page.evaluate(() => getComputedStyle(document.querySelector('.tc')).display === 'none');
    check(!d.touch && offUi, 'moving a mouse hides the touch controls (CLICK TO PLAY)');
    await touch.tap(W / 2, H / 2);
    await sleep(300);
    d = await dbg(page);
    const onUi = await page.evaluate(() => getComputedStyle(document.querySelector('.tc')).display !== 'none');
    check(d.touch && onUi, 'a touch shows them again');
    await touch.tap(W / 2, H / 2);
    await sleep(300);

    // the tic rate under a CPU throttle (a mid-range phone): reported
    if (THROTTLE > 1) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
      await sleep(1500);
      const t0 = await page.evaluate(() => ({ f: window.__game.debug().frame, t: performance.now(), n: window.__game.debug().fps }));
      await sleep(5000);
      const t1 = await page.evaluate(() => ({ f: window.__game.debug().frame, t: performance.now() }));
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      const tics = ((t1.f - t0.f) * 1000) / (t1.t - t0.t);
      notes.push(`deathmatch at ${THROTTLE}x CPU throttle: ${tics.toFixed(1)} tics/s (software GL on this machine)`);
      say(`  ${notes.at(-1)}`);
    }
    check(errors.length === 0, `Practice: no page errors (${errors.slice(0, 3).join(' | ')})`);
    await ctx.close();
  }

  // ------------------------------------------------------------------ war: the map button
  if (ONLY.includes('war')) {
    const W = 844, H = 390;
    const { ctx, page, errors, touch } = await phone(W, H, 3);
    await startMatch(page, 'offline=1&room=test-war-1');
    await touch.tap(W / 2, H / 2);
    await page.waitForFunction(() => document.querySelector('.tc')?.classList.contains('engaged'), null, { timeout: 10000, polling: 50 });
    await sleep(1000);
    const m = await page.evaluate(() => ({
      btn: getComputedStyle(document.querySelector('.t-top [data-t="map"]')).display !== 'none',
      corner: getComputedStyle(document.querySelector('.h-map')).display === 'none',
    }));
    check(m.btn && m.corner, 'war: a map button, no corner minimap');
    await shot(page, 'war');
    await tapSel(page, touch, '.t-top [data-t="map"]');
    await sleep(600);
    const big = await page.evaluate(() => ({ big: window.__game.debug().mapBig, shown: getComputedStyle(document.querySelector('.h-map')).display !== 'none' }));
    await shot(page, 'war-map');
    await tapSel(page, touch, '.t-top [data-t="map"]');
    await sleep(300);
    check(big.big && big.shown && !(await dbg(page)).mapBig, 'the map button opens the large map and closes it');
    check(errors.length === 0, `war: no page errors (${errors.slice(0, 3).join(' | ')})`);
    await ctx.close();
  }

  // ------------------------------------------------------------------ battle royale, touch only
  if (ONLY.includes('br')) {
    const W = 844, H = 390;
    const { ctx, page, errors, touch } = await phone(W, H, 3);
    // One life, 63 bots that land on crates too: a death before the crate is played again
    // (up to four matches); the steps passed on the way are kept.
    const seen = {};
    const pass = (k, ok, what) => { if (ok) seen[k] = what; else if (!seen[k]) seen[k] = null; return ok; };
    const failWhy = {};
    let opened = false, zoomed = null, nade = null;
    for (let match = 0; match < 4 && !opened; match++) {
      if (match) say(`  battle royale: the marine died before reaching a crate, match ${match + 1}`);
      await startMatch(page, 'offline=1&room=test-br-1&lobby=25&slots=12');
      await touch.tap(W / 2, H / 2);
      await page.waitForFunction(() => document.querySelector('.tc')?.classList.contains('engaged'), null, { timeout: 10000, polling: 50 });
      let d = await dbg(page);
      const br = await page.evaluate(() => ({ zoom: getComputedStyle(document.querySelector('.t-zoom')).display !== 'none', nade: getComputedStyle(document.querySelector('.t-nade')).display !== 'none' }));
      pass('buttons', br.zoom && br.nade, 'battle royale: ZOOM and NADE buttons');
      if (d.phase === 4) {
        pass('lobby', await page.evaluate(() => !document.querySelector('.h-lobby').hidden), 'the lobby panel is up');
        // fists only in the lobby: FIRE punches
        await page.evaluate(() => window.__game.testClearButtons());
        const fire = await center(page, '.t-fire');
        await touch.tap(fire.x, fire.y, 150);
        await sleep(300);
        d = await dbg(page);
        const label = await page.evaluate(() => document.querySelector('.t-weapon small').textContent);
        pass('punch', (d.buttons & 1) !== 0 && d.weapon === 0 && label === 'FIST', `lobby: FIRE punches with the fists (weapon ${d.weapon}, button reads ${label})`);
        if (!match) await shot(page, 'br-lobby');
      } else notes.push(`the lobby had already ended when the page was up (phase ${d.phase})`);
      // the dropship
      await page.waitForFunction(() => window.__game.debug().air === 1, null, { timeout: 60000, polling: 100 });
      await sleep(1200);
      if (!match) await shot(page, 'br-dropship');
      // jump over a crate, as a player picks a spot
      const tShip = Date.now();
      let over = null;
      while (Date.now() - tShip < 45000) {
        over = (await page.evaluate(() => window.__game.testMobjs(137)))[0];
        if (over && over.dist < 260) break;
        await sleep(100);
      }
      say(`  jumping ${Math.round(over?.dist ?? -1)} units from a crate`);
      const jump = await center(page, '.t-jump');
      await touch.tap(jump.x, jump.y, 80);
      await page.waitForFunction(() => window.__game.debug().air === 2, null, { timeout: 5000, polling: 50 }).catch(() => {});
      d = await dbg(page);
      pass('drop', d.air === 2, 'JUMP leaves the dropship');
      // the freefall is short: the chute right away
      await touch.tap(jump.x, jump.y, 80);
      await page.waitForFunction(() => window.__game.debug().air === 3, null, { timeout: 5000, polling: 50 }).catch(() => {});
      d = await dbg(page);
      pass('chute', d.air === 3, 'JUMP in freefall opens the chute');
      if (!match) await shot(page, 'br-chute');

      // look at the crate below while drifting down, then on foot: the left thumb holds the
      // stick, the right corrects the aim (two fingers at once)
      const state = (id) => page.evaluate((id) => {
        const g = window.__game, d = g.debug();
        const c = g.testMobjs(137).find((x) => id === undefined || x.id === id) ?? null;
        return { air: d.air, dead: d.dead, health: d.health, view: g.testViewDir(), c };
      }, id);
      const correct = async (dir, view, tol = 0.12) => {
        const delta = wrapA(dir - view);
        if (Math.abs(delta) < tol) return;
        const px = Math.max(-W * 0.22, Math.min(W * 0.22, -delta / 0.0044));
        const x0 = W * 0.7 - px / 2, f = await touch.down(x0, H * 0.4);
        await touch.drag(f, x0, H * 0.4, x0 + px, H * 0.4, 4, 8);
        await touch.up(f);
      };
      const tc = Date.now();
      let s0 = await state();
      while (Date.now() - tc < 60000 && s0.air !== 0 && s0.air !== null && !s0.dead) {
        if (s0.c) await correct(s0.c.dir, s0.view);
        // the ship's speed carries the chute on: steer back over the crate
        if (s0.c && s0.c.dist > 150) {
          const st = await touch.down(150, 270);
          await touch.drag(st, 150, 270, 150, 200, 2, 8);
          await sleep(350);
          await touch.up(st);
        }
        await sleep(100);
        s0 = await state();
      }
      d = await dbg(page);
      pass('landed', d.air === 0, 'landed');
      say(`  landed: health ${d.health}, nearest crate ${Math.round(s0.c?.dist ?? -1)}`);
      if (!match) await shot(page, 'br-landed');
      const skip = new Set();
      for (let attempt = 0; attempt < 8 && !opened && !d.dead; attempt++) {
        // the nearest crate nobody beat us to and no wall kept us from
        const c = (await page.evaluate(() => window.__game.testMobjs(137))).find((x) => !skip.has(x.id));
        if (!c || c.dist > 1500) break;
        skip.add(c.id);
        // short pushes of the stick, re-aiming between them (this machine draws a frame or two a second)
        let best = c.dist, stall = 0, now = await state(c.id);
        const tw = Date.now();
        while (Date.now() - tw < 30000 && now.c && !now.dead && now.c.dist >= 58) {
          if (now.c.dist < best - 4) { best = now.c.dist; stall = 0; } else if (++stall > 5) break;
          await correct(now.c.dir, now.view, 0.1);
          const st = await touch.down(150, 270);
          await touch.drag(st, 150, 270, 150, now.c.dist > 200 ? 200 : 232, 2, 8);
          await sleep(Math.max(100, Math.min(700, (now.c.dist - 50) * 1.6)));
          await touch.up(st);
          await sleep(150);
          now = await state(c.id);
        }
        say(`  walk to crate ${c.id}: ${Math.round(c.dist)} → ${Math.round(now.c?.dist ?? -1)} (best ${Math.round(best)}, stall ${stall}), view err ${now.c ? wrapA(now.c.dir - now.view).toFixed(2) : '-'}, dead ${now.dead}, ${((Date.now() - tw) / 1000).toFixed(1)} s`);
        if (!now.c || now.dead || now.c.dist > 110) { d = await dbg(page); continue; }
        // USE (again after a re-aim if the first press was not facing it squarely)
        for (let u = 0; u < 3 && !opened; u++) {
          now = await state(c.id);
          if (!now.c || now.dead) break;
          await correct(now.c.dir, now.view, 0.06);
          const use = await center(page, '.t-use');
          if (!use) break;
          await touch.tap(use.x, use.y, 100);
          await sleep(700);
          opened = !(await state(c.id)).c;
        }
        if (opened) say(`  opened crate ${c.id} (${Math.round(c.dist)} units from where we landed)`);
        d = await dbg(page);
      }
      if (!opened) continue;
      await sleep(400);
      await shot(page, 'br-crate');

      // the scope: ZOOM toggles and stays
      d = await dbg(page);
      if (d.dead) { notes.push('the marine died before the zoom/grenade checks'); break; }
      try {
        await tapSel(page, touch, '.t-zoom');
        await sleep(900);
        const z1 = (await dbg(page)).zoom;
        await shot(page, 'br-zoom');
        await sleep(500);
        const z2 = (await dbg(page)).zoom;
        await tapSel(page, touch, '.t-zoom');
        await sleep(900);
        const z3 = (await dbg(page)).zoom;
        zoomed = [z1, z2, z3];
        const g0 = (await dbg(page)).grenades;
        await page.evaluate(() => window.__game.testClearButtons());
        await tapSel(page, touch, '.t-nade');
        await sleep(700);
        d = await dbg(page);
        nade = { bit: (d.buttons & (1 << 10)) !== 0, g0, g1: d.grenades };
      } catch (err) {
        // killed in between: the buttons hide while dead
        if (!(await dbg(page)).dead) throw err;
        notes.push('the marine died during the zoom/grenade checks');
      }
    }
    for (const [k, what] of Object.entries(seen)) check(what !== null, what ?? `battle royale step: ${k}`);
    check(opened, 'walked to a crate with the stick and opened it with USE');
    if (zoomed) check(zoomed[0] > 0.9 && zoomed[1] > 0.9 && zoomed[2] < 0.05, `ZOOM toggles the scope on and off (${zoomed.map((z) => z.toFixed(2)).join(', ')})`);
    if (nade) check(nade.bit && (nade.g0 > 0 ? nade.g1 < nade.g0 : true), `NADE sends the grenade button (grenades ${nade.g0} → ${nade.g1})`);
    check(errors.length === 0, `battle royale: no page errors (${errors.slice(0, 3).join(' | ')})`);
    await ctx.close();
  }
} catch (err) {
  fails.push(String(err?.stack ?? err));
  console.error(err);
} finally {
  await browser.close();
}
for (const n of notes) say(`note ${n}`);
say(fails.length ? `FAIL (${fails.length})` : 'PASS');
process.exit(fails.length ? 1 : 0);
