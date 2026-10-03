// Standalone renderer viewer (no sim): MAP19 with its things as static sprites, ~100
// fake players running circles in random colors, rockets/plasma with lights, a weapon
// psprite, free-fly camera. Served by `npm run dev` at /viewer.html.
//
// URL params: ?x=&y=&z=&yaw=&pitch= (deg) camera, players=N, seed=N, weapon=SHTG|PISG|...,
// freeze=1 (no time), map=MAP19. window.__viewer exposes the renderer for scripting.
import { Renderer, type RenderFrame, type RenderMobj } from './render';
import { SoundBank } from './audio';
import {
  FF_FULLBRIGHT, MF_SHADOW, PLAYER_COLORS, THING_DEFS, loadWad, spriteNum,
} from './wad';

const params = new URLSearchParams(location.search);
const MAP = (params.get('map') || 'MAP19').toUpperCase();
const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
if (params.get('ui') === '0') { hud.style.display = 'none'; document.getElementById('help')!.style.display = 'none'; }

let seed = Number(params.get('seed') || 1) >>> 0 || 1;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };

const t0 = performance.now();
const res = await fetch('./freedm-lite.wad');
const bytes = new Uint8Array(await res.arrayBuffer());
const wad = loadWad(bytes);
const renderer = new Renderer(canvas, wad, MAP);
const loadMs = performance.now() - t0;
const map = renderer.map;
const sound = new SoundBank(wad);
sound.unlock();

const floorAt = (x: number, y: number) => map.sectors[renderer.sectorAt(x, y)].floor;
const ceilAt = (x: number, y: number) => map.sectors[renderer.sectorAt(x, y)].ceil;

const mkMobj = (id: number): RenderMobj => ({ id, x: 0, y: 0, z: 0, angle: 0, sprite: 0, frame: 0, flags: 0, type: 0, slot: -1, translation: 0 });

// ---- map things ------------------------------------------------------------------
interface Static { m: RenderMobj; frames: readonly number[] }
const statics: Static[] = [];
const defs = new Map(THING_DEFS.map((d) => [d[0], d]));
const MONSTERS = new Set([7, 9, 16, 58, 64, 65, 66, 67, 68, 69, 71, 72, 84, 88, 89, 3001, 3002, 3003, 3004, 3005, 3006]);
let nextId = 1;
for (const t of map.things) {
  const d = defs.get(t.type);
  if (!d || MONSTERS.has(t.type)) continue;
  const sp = spriteNum(d[2]);
  if (sp < 0) continue;
  const m = mkMobj(nextId++);
  m.x = t.x; m.y = t.y; m.angle = (t.angle * Math.PI) / 180; m.sprite = sp; m.type = d[1];
  m.frame = d[3][0];
  if (d[4]) {
    const L = renderer.assets.spriteLump(sp, m.frame, 0);
    m.z = ceilAt(t.x, t.y) - (L ? L.info.rect.h : 0);
  } else m.z = floorAt(t.x, t.y);
  statics.push({ m, frames: d[3] });
}

// ---- fake players ------------------------------------------------------------------
const starts = map.things.filter((t) => t.type === 11 || (t.type >= 1 && t.type <= 4));
const anchors = map.things.filter((t) => defs.has(t.type) && !MONSTERS.has(t.type));
interface Bot { m: RenderMobj; cx: number; cy: number; r: number; w: number; ph: number; fire: number }
const bots: Bot[] = [];
const PLAY = spriteNum('PLAY');
function makeBots(n: number) {
  bots.length = 0;
  for (let i = 0; i < n; i++) {
    const a = i < starts.length ? starts[i] : anchors[Math.floor(rnd() * anchors.length)] ?? starts[0];
    const m = mkMobj(10000 + i);
    m.sprite = PLAY; m.slot = i; m.type = 0;
    m.translation = Math.floor(rnd() * PLAYER_COLORS.length);
    if (i % 23 === 7) m.flags |= MF_SHADOW;
    bots.push({ m, cx: a.x, cy: a.y, r: 40 + rnd() * 120, w: (0.6 + rnd() * 1.2) * (rnd() < 0.5 ? -1 : 1), ph: rnd() * Math.PI * 2, fire: rnd() * 3 });
  }
}
makeBots(Number(params.get('players') || 100));

// ---- projectiles --------------------------------------------------------------------
interface Proj { m: RenderMobj; vx: number; vy: number; vz: number; life: number; boom: number; kind: 'MISL' | 'PLSS' | 'BFS1' }
const projs: Proj[] = [];
const SPR: Record<string, number> = Object.fromEntries(['MISL', 'PLSS', 'PLSE', 'BFS1', 'BFE1', 'PUFF'].map((n) => [n, spriteNum(n)]));
let projId = 50000;
function fire(x: number, y: number, z: number, ang: number, pitch: number, kind: Proj['kind']) {
  const m = mkMobj(projId++);
  m.x = x; m.y = y; m.z = z; m.angle = ang; m.sprite = SPR[kind]; m.frame = FF_FULLBRIGHT;
  const sp = kind === 'MISL' ? 20 : 25;
  projs.push({ m, vx: Math.cos(ang) * Math.cos(pitch) * sp, vy: Math.sin(ang) * Math.cos(pitch) * sp, vz: Math.sin(pitch) * sp, life: 0, boom: -1, kind });
  sound.play(kind === 'MISL' ? 'rlaunc' : kind === 'PLSS' ? 'plasma' : 'bfg', m);
}

// ---- camera / input -----------------------------------------------------------------
const deg = (v: string | null, d: number) => (v === null ? d : (Number(v) * Math.PI) / 180);
const s0 = starts[0] ?? { x: 0, y: 0, angle: 0 };
const cam = {
  x: Number(params.get('x') ?? s0.x), y: Number(params.get('y') ?? s0.y), z: 0,
  yaw: deg(params.get('yaw'), (s0.angle * Math.PI) / 180), pitch: deg(params.get('pitch'), 0),
};
cam.z = params.get('z') !== null ? Number(params.get('z')) : floorAt(cam.x, cam.y) + 41;
const keys = new Set<string>();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyB') renderer.setOptions({ bloom: !renderer.options.bloom });
  if (e.code === 'KeyL') renderer.setOptions({ dynamicLights: !renderer.options.dynamicLights });
  if (e.code === 'KeyO') renderer.setOptions({ ao: renderer.options.ao ? 0 : 1 });
  if (e.code === 'KeyP') makeBots(bots.length ? 0 : 100);
  const w = { Digit1: 'PISG', Digit2: 'SHTG', Digit3: 'MISG', Digit4: 'PLSG', Digit5: 'BFGG', Digit6: 'CHGG' }[e.code];
  if (w) weapon = w;
});
addEventListener('keyup', (e) => keys.delete(e.code));
canvas.addEventListener('click', () => { if (document.pointerLockElement !== canvas) void canvas.requestPointerLock(); });
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  cam.yaw -= e.movementX * 0.0025;
  cam.pitch = Math.max(-1.41, Math.min(1.41, cam.pitch - e.movementY * 0.0025));
});
let firing = 0;
let pendingShot = false;
addEventListener('mousedown', (e) => { if (document.pointerLockElement === canvas && e.button === 0) firing = 1; });
addEventListener('mouseup', () => { firing = 0; });

let weapon = (params.get('weapon') || 'SHTG').toUpperCase();
const FLASH: Record<string, string> = { PISG: 'PISF', SHTG: 'SHTF', MISG: 'MISF', PLSG: 'PLSF', BFGG: 'BFGF', CHGG: 'CHGF', SHT2: 'SHT2' };
let flashUntil = -1;
let lastShot = -10;

// ---- frame ------------------------------------------------------------------------
const mobjs: RenderMobj[] = [];
// ?dark=N overrides every sector's light level (MAP19 is uniformly bright: 224)
const dark = params.get('dark');
const sectorsOverride = dark === null ? null : map.sectors.map((s) => ({ floor: s.floor, ceil: s.ceil, light: Number(dark) }));
const frame: RenderFrame = {
  tic: 0, camera: cam, mobjs, mobjCount: 0, sectors: sectorsOverride, lineTextures: null, events: [],
  player: { damagecount: 0, bonuscount: 0, extralight: 0, fixedcolormap: 0, powers: [0, 0, 0, 0, 0, 0], weapon: { sprite: 0, frame: 0, sx: 1, sy: 32 }, flash: null },
};
const flashPs = { sprite: 0, frame: FF_FULLBRIGHT, sx: 1, sy: 32 };
const freeze = params.get('freeze') === '1';
let last = performance.now();
let simTime = Number(params.get('t') || 0);
let fpsAcc = 0, fpsN = 0, fps = 0, msAvg = 0;

function step(dt: number) {
  simTime += dt;
  const tic = simTime * 35;
  frame.tic = tic;
  // fly
  const sp = (keys.has('ShiftLeft') ? 900 : 350) * dt;
  const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0), s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  cam.x += (Math.cos(cam.yaw) * f + Math.sin(cam.yaw) * s) * sp;
  cam.y += (Math.sin(cam.yaw) * f - Math.cos(cam.yaw) * s) * sp;
  cam.z += ((keys.has('Space') ? 1 : 0) - (keys.has('KeyC') ? 1 : 0)) * sp;

  let n = 0;
  for (const st of statics) {
    st.m.frame = st.frames[Math.floor(tic / 6) % st.frames.length];
    mobjs[n++] = st.m;
  }
  for (const b of bots) {
    const a = b.ph + (simTime * b.w * 120) / b.r;
    const m = b.m;
    m.x = b.cx + Math.cos(a) * b.r; m.y = b.cy + Math.sin(a) * b.r; m.z = floorAt(m.x, m.y);
    m.angle = a + (b.w > 0 ? Math.PI / 2 : -Math.PI / 2);
    const firingNow = ((simTime + b.fire) % 3) < 0.35;
    m.frame = firingNow ? (((simTime + b.fire) % 3) < 0.17 ? 4 : 5 | FF_FULLBRIGHT) : Math.floor(tic / 4 + b.ph * 3) % 4;
    if (!freeze && firingNow && ((simTime - dt + b.fire) % 3) >= 0.35 - dt && rnd() < 0.15 && projs.length < 60) {
      const k = rnd();
      fire(m.x + Math.cos(m.angle) * 20, m.y + Math.sin(m.angle) * 20, m.z + 32, m.angle, 0, k < 0.6 ? 'MISL' : k < 0.92 ? 'PLSS' : 'BFS1');
    }
    mobjs[n++] = m;
  }
  for (let i = projs.length - 1; i >= 0; i--) {
    const p = projs[i];
    const m = p.m;
    if (p.boom < 0) {
      const nx = m.x + p.vx * dt * 35, ny = m.y + p.vy * dt * 35, nz = m.z + p.vz * dt * 35;
      p.life += dt;
      if (nz < floorAt(nx, ny) || nz + 8 > ceilAt(nx, ny) || p.life > 2.5 || ceilAt(nx, ny) - floorAt(nx, ny) < 16) {
        p.boom = 0;
        sound.play(p.kind === 'MISL' ? 'rxplod' : 'firxpl', m);
        if (p.kind === 'PLSS') m.sprite = SPR.PLSE;
        if (p.kind === 'BFS1') m.sprite = SPR.BFE1;
      } else { m.x = nx; m.y = ny; m.z = nz; m.frame = (Math.floor(tic / 4) % (p.kind === 'MISL' ? 1 : 2)) | FF_FULLBRIGHT; }
    }
    if (p.boom >= 0) {
      p.boom += dt;
      const fr = Math.floor(p.boom * 35 / 6);
      const maxF = p.kind === 'MISL' ? 3 : p.kind === 'PLSS' ? 5 : 6;
      if (fr >= maxF) { projs.splice(i, 1); continue; }
      m.frame = (p.kind === 'MISL' ? 1 + fr : fr) | FF_FULLBRIGHT;
    }
    mobjs[n++] = m;
  }
  frame.mobjCount = n;

  // weapon psprite with Doom's bob (P_CalcPlayerSprite-ish)
  const pl = frame.player!;
  const moving = f !== 0 || s !== 0;
  const bob = moving ? 16 : 0;
  const ang = (tic * 128 / 8192) * Math.PI * 2;
  pl.weapon!.sprite = spriteNum(weapon);
  pl.weapon!.sx = 1 + bob * Math.cos(ang);
  pl.weapon!.sy = 32 + bob * Math.abs(Math.sin(ang));
  if ((firing || pendingShot) && simTime - lastShot > 0.5) {
    pendingShot = false;
    lastShot = simTime;
    flashUntil = simTime + 0.12;
    const kind = weapon === 'PLSG' ? 'PLSS' : weapon === 'BFGG' ? 'BFS1' : weapon === 'MISG' ? 'MISL' : null;
    if (kind) fire(cam.x + Math.cos(cam.yaw) * 24, cam.y + Math.sin(cam.yaw) * 24, cam.z - 8, cam.yaw, cam.pitch, kind);
    else sound.play(weapon === 'SHTG' ? 'shotgn' : 'pistol', null);
  }
  const flashing = simTime < flashUntil && FLASH[weapon];
  pl.weapon!.frame = 0;
  if (flashing) { flashPs.sprite = spriteNum(FLASH[weapon]); flashPs.sx = pl.weapon!.sx; flashPs.sy = pl.weapon!.sy; pl.flash = flashPs; }
  else pl.flash = null;
  pl.extralight = flashing ? 1 : 0;
  sound.setListener(cam.x, cam.y, cam.yaw);
  sound.update();
}

function loop() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  step(freeze ? 0 : dt);
  const r0 = performance.now();
  renderer.setFrame(frame);
  renderer.render();
  const rms = performance.now() - r0;
  fpsAcc += dt; fpsN++; msAvg = msAvg * 0.95 + rms * 0.05;
  if (fpsAcc >= 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  const st = renderer.stats;
  hud.textContent = `${MAP}  ${fps.toFixed(0)} fps  cpu ${msAvg.toFixed(1)} ms  load ${loadMs.toFixed(0)} ms\n` +
    `sprites ${st.sprites}  lights ${st.lights}  calls ${st.calls}  tris ${st.triangles}\n` +
    `x ${cam.x.toFixed(0)} y ${cam.y.toFixed(0)} z ${cam.z.toFixed(0)} yaw ${((cam.yaw * 180) / Math.PI % 360).toFixed(0)} pitch ${((cam.pitch * 180) / Math.PI).toFixed(0)}  sector ${renderer.sectorAt(cam.x, cam.y)}`;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// scripting hook (screenshots / benchmarks)
(window as unknown as { __viewer: unknown }).__viewer = {
  renderer, frame, cam, bots, projs, fire, step, makeBots,
  setCamera(x: number, y: number, z: number | null, yawDeg: number, pitchDeg = 0) {
    cam.x = x; cam.y = y; cam.z = z ?? floorAt(x, y) + 41; cam.yaw = (yawDeg * Math.PI) / 180; cam.pitch = (pitchDeg * Math.PI) / 180;
  },
  setWeapon(w: string) { weapon = w; },
  shoot() { pendingShot = true; },
  /** render one frame synchronously and return the CPU time */
  renderOnce() { const a = performance.now(); renderer.setFrame(frame); renderer.render(); return performance.now() - a; },
  loadMs,
};
