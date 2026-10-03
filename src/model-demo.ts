/**
 * model.html: the 3D marine next to the sprite it was built from.
 *
 *   ?mode=compare   (default) turntable model beside the sprite at the same angle
 *   ?mode=hero      the start screen's dramatic lighting preset
 *   ?mode=sheet     all 8 rotations side by side (&frame=A..W)
 *   ?mode=anims     one cell per animation, mid-pose (&angle=degrees)
 *   ?mode=perf      100 animated instances, frame time in the corner
 *   ?mode=ragdoll   ragdoll deaths (rocket, plasma, BFG, shotgun, chaingun), looping
 *                   (&t=seconds after the hit: a still, simulated up to then; &near: close up)
 *   &t=seconds      freeze time (screenshots); &color=n player colour
 */
import * as THREE from 'three';
import { loadWad, readPalette, decodePatch, buildSpriteDefs, buildTranslations, PLAYER_COLORS, type Wad, type SpriteDef, type PaletteData } from './wad/index.js';
import type { RagdollKick } from './model/ragdoll.js';
import { createDoomguyFactory, FRAME, type DoomguyModel, type DoomguyFactory, type DoomguyPoseInput } from './model/index.js';

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') ?? 'compare';
const FIXED_T = params.has('t') ? Number(params.get('t')) : null;
let color = Number(params.get('color') ?? 0) | 0;
if (params.has('shot')) document.body.classList.add('shot');

const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
const octx = overlay.getContext('2d')!;
const statsEl = document.getElementById('stats')!;
const ui = document.getElementById('ui')!;

// ---------------------------------------------------------------------------
// sprites, drawn palette-correct for comparison

class Sprites {
  private defs: SpriteDef;
  private cache = new Map<string, { c: HTMLCanvasElement; left: number; top: number } | null>();
  private trans: Uint8Array;
  constructor(private wad: Wad, private pal: PaletteData) {
    this.defs = buildSpriteDefs(wad, ['PLAY'])[0];
    this.trans = buildTranslations(pal);
  }
  /** rot 1..8 */
  get(frame: number, rot: number, col: number, row = SPRITE_ROW): { c: HTMLCanvasElement; left: number; top: number; flip: boolean } | null {
    const f = this.defs[frame];
    if (!f) return null;
    const r = f.rotate ? f.rotations[rot - 1] : f.rotations[0];
    const key = `${r.lump}/${col}/${row}`;
    if (!this.cache.has(key)) {
      const l = this.wad.lumps.find((x) => x.name === r.lump && x.source === 0) ?? this.wad.lump(r.lump);
      if (!l) { this.cache.set(key, null); return null; }
      const p = decodePatch(l.data);
      const c = document.createElement('canvas');
      c.width = p.width; c.height = p.height;
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(p.width, p.height);
      for (let i = 0; i < p.width * p.height; i++) {
        if (!p.data[i * 2 + 1]) continue;
        const idx = this.pal.colormap[row * 256 + this.trans[col * 256 + p.data[i * 2]]];
        img.data[i * 4] = this.pal.playpal[idx * 3];
        img.data[i * 4 + 1] = this.pal.playpal[idx * 3 + 1];
        img.data[i * 4 + 2] = this.pal.playpal[idx * 3 + 2];
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      this.cache.set(key, { c, left: p.left, top: p.top });
    }
    const e = this.cache.get(key);
    return e ? { ...e, flip: r.flip } : null;
  }
}

/** Doom's rotation (1..8) for a viewer at Doom angle `viewDeg` from a thing facing angle 0. */
function rotationFor(viewDeg: number): number {
  const ang = viewDeg + 180; // viewer → thing
  const a = ((ang + 202.5) % 360 + 360) % 360;
  return Math.floor(a / 45) + 1;
}

// ---------------------------------------------------------------------------
// animation drivers: what the sim would report, per animation

type Driver = (t: number) => Omit<DoomguyPoseInput, 'time'>;
const TIC = 1 / 35;
function cycle(t: number, seq: [number, number][], loop = true): { frame: number; tics: number } {
  const total = seq.reduce((s, [, n]) => s + n, 0);
  let tic = t / TIC;
  if (loop) tic %= total; else tic = Math.min(tic, total - 0.001);
  for (const [f, n] of seq) {
    if (tic < n) return { frame: f, tics: n - tic };
    tic -= n;
  }
  const last = seq[seq.length - 1];
  return { frame: last[0], tics: 0 };
}
const WALK: [number, number][] = [[0, 4], [1, 4], [2, 4], [3, 4]];
const DRIVERS: Record<string, Driver> = {
  idle: () => ({ frame: FRAME.A, moveSpeed: 0 }),
  walk: (t) => ({ ...cycle(t, WALK), moveSpeed: 8 }),
  run: (t) => ({ ...cycle(t, WALK), moveSpeed: 16 }),
  fire: (t) => ({ ...cycle(t, [[FRAME.E, 12], [FRAME.F, 6], [FRAME.E, 12], [FRAME.F, 6], [FRAME.A, 20]]), moveSpeed: 0 }),
  pain: (t) => ({ ...cycle(t, [[FRAME.G, 4], [FRAME.G, 4], [FRAME.A, 30]]), moveSpeed: 0 }),
  death: (t) => cycle(t % 4, [[7, 10], [8, 10], [9, 10], [10, 10], [11, 10], [12, 10], [13, 80]], false),
  gib: (t) => cycle(t % 4, [[14, 5], [15, 5], [16, 5], [17, 5], [18, 5], [19, 5], [20, 5], [21, 5], [22, 100]], false),
  jump: (t) => ({ frame: FRAME.A, moveSpeed: 6, airborne: (t % 1.6) < 0.8 }),
  look: (t) => ({ frame: FRAME.A, moveSpeed: 0, pitch: Math.sin(t * 1.5) * 0.7 }),
};

// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;

async function main(): Promise<void> {
  const res = await fetch('./freedm-lite.wad');
  const wad = loadWad(new Uint8Array(await res.arrayBuffer()));
  const pal = readPalette(wad);
  const t0 = performance.now();
  const factory = createDoomguyFactory(wad);
  const buildMs = performance.now() - t0;
  const sprites = new Sprites(wad, pal);
  const info = `factory ${buildMs.toFixed(1)} ms · ${factory.triangles} tris/model · atlas ${factory.atlas.w}×${factory.atlas.h}`;
  (window as unknown as { __model: unknown }).__model = { factory, triangles: factory.triangles };
  if (MODE === 'hero') hero(factory, info);
  else if (MODE === 'sheet') sheet(factory, sprites, info);
  else if (MODE === 'anims') anims(factory, sprites, info);
  else if (MODE === 'perf') perf(factory, info);
  else if (MODE === 'ragdoll') ragdoll(factory, info);
  else compare(factory, sprites, info);
}

function resize(): { w: number; h: number } {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  overlay.width = w; overlay.height = h;
  octx.imageSmoothingEnabled = false;
  return { w, h };
}

function now(): number { return FIXED_T ?? performance.now() / 1000; }

/** Comparison cameras stand this far off (map units): it sets Doom's distance light term. */
const CAM_DIST = 100;
const LIGHT = Number(params.get('light') ?? 255);
/** COLORMAP row Doom would draw a sprite with at CAM_DIST in a sector of LIGHT (R_ProjectSprite). */
const SPRITE_ROW = Math.max(0, Math.min(31, Math.floor((15 - (LIGHT >> 4)) * 4 - Math.min(1280 / CAM_DIST, 23))));

/** An orthographic, eye-level camera like a sprite's billboard: `unitPx` screen px per map unit. */
function orthoCam(cellW: number, cellH: number, unitPx: number, viewDeg: number, cy = 28): THREE.OrthographicCamera {
  const hw = cellW / unitPx / 2, hh = cellH / unitPx / 2;
  const cam = new THREE.OrthographicCamera(-hw, hw, cy + hh, cy - hh, 1, 1000);
  const a = (viewDeg * Math.PI) / 180;
  // Doom (x, y) → three (x, -y): the viewer at Doom angle a
  cam.position.set(Math.cos(a) * CAM_DIST, 0, -Math.sin(a) * CAM_DIST);
  cam.lookAt(0, 0, 0);
  cam.position.y = 0;
  cam.top = cy + hh; cam.bottom = cy - hh;
  cam.updateProjectionMatrix();
  return cam;
}

/** Draws the sprite with its origin at screen (x, groundY), `s` px per sprite pixel (row r at height 56 - r). */
function drawSprite(sprites: Sprites, frame: number, rot: number, col: number, x: number, groundY: number, s: number): void {
  const sp = sprites.get(frame, rot, col);
  if (!sp) return;
  const top = sp.top + 2;
  octx.save();
  if (sp.flip) {
    octx.translate(x, 0);
    octx.scale(-1, 1);
    octx.drawImage(sp.c, -sp.left * s, groundY - top * s, sp.c.width * s, sp.c.height * s);
  } else {
    octx.drawImage(sp.c, x - sp.left * s, groundY - top * s, sp.c.width * s, sp.c.height * s);
  }
  octx.restore();
}

function label(text: string, x: number, y: number, align: CanvasTextAlign = 'center', c = '#aaa'): void {
  octx.fillStyle = c;
  octx.font = '13px ui-monospace, Menlo, monospace';
  octx.textAlign = align;
  octx.fillText(text, x, y);
}

function renderCell(scene: THREE.Scene, cam: THREE.Camera, x: number, y: number, w: number, h: number, H: number): void {
  renderer.setViewport(x, H - y - h, w, h);
  renderer.setScissor(x, H - y - h, w, h);
  renderer.setScissorTest(true);
  renderer.render(scene, cam);
}

function button(group: HTMLElement, text: string, on: boolean, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.classList.toggle('on', on);
  b.onclick = fn;
  group.appendChild(b);
  return b;
}
function group(name: string): HTMLElement {
  const g = document.createElement('div');
  g.className = 'group';
  const l = document.createElement('span');
  l.className = 'label';
  l.textContent = name;
  g.appendChild(l);
  ui.appendChild(g);
  return g;
}
function radio(name: string, items: string[], cur: string, set: (v: string) => void): void {
  const g = group(name);
  const bs = items.map((it) => button(g, it, it === cur, () => { set(it); bs.forEach((b) => b.classList.toggle('on', b.textContent === it)); }));
}
function colorPicker(models: () => DoomguyModel[]): void {
  const g = group('colour');
  const bs: HTMLButtonElement[] = [];
  PLAYER_COLORS.forEach((c, i) => {
    const b = button(g, '', i === color, () => {
      color = i;
      for (const m of models()) m.setColor(i);
      bs.forEach((x, k) => x.classList.toggle('on', k === i));
    });
    b.className = 'swatch' + (i === color ? ' on' : '');
    b.title = c.name;
    b.style.background = c.css;
    bs.push(b);
  });
}

// ---------------------------------------------------------------------------
// compare: turntable model | sprite at the same rotation

function compare(factory: DoomguyFactory, sprites: Sprites, info: string): void {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x3c3c3c);
  const guy = factory.create(color);
  guy.setLight(LIGHT);
  scene.add(guy.object);
  scene.add(floorGrid());
  let anim = params.get('anim') ?? 'idle';
  let spin = !params.has('angle');
  let viewDeg = Number(params.get('angle') ?? 0);
  let pitch = 0;
  radio('anim', Object.keys(DRIVERS), anim, (v) => { anim = v; animT0 = now(); });
  const ag = group('angle');
  const spinB = button(ag, 'spin', spin, () => { spin = !spin; spinB.classList.toggle('on', spin); });
  for (let r = 0; r < 8; r++) button(ag, `${r + 1}`, false, () => { spin = false; spinB.classList.remove('on'); viewDeg = r * 45; });
  const lg = group('look');
  const slider = document.createElement('input');
  slider.type = 'range'; slider.min = '-0.8'; slider.max = '0.8'; slider.step = '0.01'; slider.value = '0';
  slider.oninput = () => { pitch = Number(slider.value); };
  lg.appendChild(slider);
  colorPicker(() => [guy]);
  const pg = group('');
  button(pg, 'menu hero', false, () => { location.search = '?mode=hero'; });
  button(pg, '8-angle sheet', false, () => { location.search = '?mode=sheet'; });
  button(pg, 'all anims', false, () => { location.search = '?mode=anims'; });
  button(pg, '100 instances', false, () => { location.search = '?mode=perf'; });

  let animT0 = FIXED_T === null ? now() : 0;
  let last = now();
  const loop = (): void => {
    const { w, h } = resize();
    const t = now();
    if (spin && FIXED_T === null) viewDeg = (viewDeg + (t - last) * 30) % 360;
    last = t;
    const drv = DRIVERS[anim](t - animT0);
    guy.pose({ ...drv, pitch: drv.pitch ?? pitch, time: t });
    const cellW = Math.floor(w / 2), cellH = h - 70;
    const unitPx = Math.max(2, Math.floor(Math.min(cellW / 70, cellH / 72)));
    const cam = orthoCam(cellW, cellH, unitPx, viewDeg, 28);
    renderer.setClearColor(0x3c3c3c);
    renderCell(scene, cam, 0, 0, cellW, cellH, h);
    octx.clearRect(0, 0, w, h);
    octx.fillStyle = '#3c3c3c';
    octx.fillRect(cellW, 0, w - cellW, cellH);
    const groundY = cellH / 2 + 28 * unitPx;
    const rot = rotationFor(viewDeg);
    drawSprite(sprites, drv.frame, rot, color, cellW + cellW / 2, groundY, unitPx);
    label(`3D model · view ${viewDeg.toFixed(0)}°`, cellW / 2, 22);
    label(`sprite PLAY${String.fromCharCode(65 + drv.frame)} rotation ${rot}`, cellW + cellW / 2, 22);
    statsEl.textContent = info;
    if (FIXED_T === null) requestAnimationFrame(loop);
    else (window as unknown as { __ready: boolean }).__ready = true;
  };
  loop();
}

function floorGrid(): THREE.Object3D {
  const g = new THREE.GridHelper(128, 8, 0x555555, 0x4a4a4a);
  g.position.y = -0.05;
  return g;
}

// ---------------------------------------------------------------------------
// sheet: every rotation of one frame

function sheet(factory: DoomguyFactory, sprites: Sprites, info: string): void {
  const frame = (params.get('frame') ?? 'A').charCodeAt(0) - 65;
  const scene = new THREE.Scene();
  const guy = factory.create(color);
  guy.setLight(LIGHT);
  scene.add(guy.object);
  const { w, h } = resize();
  const cols = 4, rows = 2;
  const cellW = Math.floor(w / cols), cellH = Math.floor(h / rows);
  const unitPx = Math.max(2, Math.floor(Math.min(cellW / 2 / 44, (cellH - 30) / 64)));
  octx.clearRect(0, 0, w, h);
  renderer.setClearColor(0x3c3c3c);
  renderer.setScissorTest(false);
  renderer.clear();
  const t = FIXED_T ?? 0.4;
  guy.pose({ frame, time: t, moveSpeed: Number(params.get('speed') ?? 0), tics: 2 });
  for (let r = 0; r < 8; r++) {
    const cx = (r % cols) * cellW, cy = Math.floor(r / cols) * cellH;
    const viewDeg = r * 45;
    const cam = orthoCam(cellW / 2, cellH - 24, unitPx, viewDeg, 28);
    renderCell(scene, cam, cx, cy + 24, Math.floor(cellW / 2), cellH - 24, h);
    const groundY = cy + 24 + (cellH - 24) / 2 + 28 * unitPx;
    drawSprite(sprites, frame, r + 1, color, cx + cellW * 0.75, groundY, unitPx);
    label(`rotation ${r + 1}: model | PLAY${String.fromCharCode(65 + frame)}${r + 1}`, cx + cellW / 2, cy + 18);
  }
  statsEl.textContent = info;
  (window as unknown as { __ready: boolean }).__ready = true;
}

// ---------------------------------------------------------------------------
// anims: one cell per animation, mid-pose

function anims(factory: DoomguyFactory, sprites: Sprites, info: string): void {
  const viewDeg = Number(params.get('angle') ?? 30);
  const cells: { name: string; drv: Driver; at: number }[] = [
    { name: 'idle', drv: DRIVERS.idle, at: 1 },
    { name: 'walk B', drv: DRIVERS.walk, at: 5.5 * TIC },
    { name: 'run D', drv: DRIVERS.run, at: 13.5 * TIC },
    { name: 'aim E', drv: DRIVERS.fire, at: 8 * TIC },
    { name: 'fire F', drv: DRIVERS.fire, at: 13 * TIC },
    { name: 'pain G', drv: DRIVERS.pain, at: 3 * TIC },
    { name: 'look up', drv: () => ({ frame: 0, pitch: 0.6 }), at: 1 },
    { name: 'look down', drv: () => ({ frame: 0, pitch: -0.6 }), at: 1 },
    { name: 'jump', drv: DRIVERS.jump, at: 0.4 },
    { name: 'death I', drv: DRIVERS.death, at: 16 * TIC },
    { name: 'death J', drv: DRIVERS.death, at: 26 * TIC },
    { name: 'death K', drv: DRIVERS.death, at: 36 * TIC },
    { name: 'death N', drv: DRIVERS.death, at: 100 * TIC },
    { name: 'gib Q', drv: DRIVERS.gib, at: 12 * TIC },
    { name: 'gib S', drv: DRIVERS.gib, at: 22 * TIC },
    { name: 'gib W', drv: DRIVERS.gib, at: 60 * TIC },
  ];
  const scene = new THREE.Scene();
  const { w, h } = resize();
  const cols = 4, rows = 4;
  const cellW = Math.floor(w / cols), cellH = Math.floor(h / rows);
  const unitPx = Math.max(2, Math.floor(Math.min(cellW / 2 / 52, (cellH - 22) / 62)));
  octx.clearRect(0, 0, w, h);
  renderer.setClearColor(0x3c3c3c);
  renderer.setScissorTest(false);
  renderer.clear();
  const rot = rotationFor(viewDeg);
  cells.forEach((c, i) => {
    const guy = factory.create(color, 1);
    scene.add(guy.object);
    // step through time at 60 fps so the eased pose settles exactly as it would live
    for (let tt = 0; tt <= c.at + 1e-6; tt += 1 / 60) guy.pose({ ...c.drv(tt), time: tt });
    const d = c.drv(c.at);
    guy.pose({ ...d, time: c.at });
    const cx = (i % cols) * cellW, cy = Math.floor(i / cols) * cellH;
    const ch = cellH - 22;
    const cam = orthoCam(cellW / 2, ch, unitPx, viewDeg, 26);
    renderCell(scene, cam, cx, cy + 22, Math.floor(cellW / 2), ch, h);
    scene.remove(guy.object);
    guy.dispose();
    drawSprite(sprites, d.frame, rot, color, cx + cellW * 0.75, cy + 22 + ch / 2 + 26 * unitPx, unitPx);
    label(`${c.name}  (sprite PLAY${String.fromCharCode(65 + d.frame)})`, cx + cellW / 2, cy + 16);
  });
  statsEl.textContent = info;
  (window as unknown as { __ready: boolean }).__ready = true;
}

// ---------------------------------------------------------------------------
// hero: the start screen's lighting

function hero(factory: DoomguyFactory, info: string): void {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070605);
  scene.fog = new THREE.Fog(0x070605, 150, 290);
  const guy = factory.create(color);
  guy.setSceneLighting(1);
  guy.setFlashBoost(2.5);
  scene.add(guy.object);
  // warm key from front-left-above, hard red rims from behind both sides, cool low fill
  const key = new THREE.DirectionalLight(0xfff1e2, 8);
  key.position.set(95, 70, 45);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xff2a10, 16);
  rim.position.set(-50, 35, -70);
  scene.add(rim);
  const rim2 = new THREE.DirectionalLight(0xff7a30, 7);
  rim2.position.set(-60, 25, 70);
  scene.add(rim2);
  const fill = new THREE.DirectionalLight(0x6070a0, 2);
  fill.position.set(80, 10, -40);
  scene.add(fill);
  scene.add(new THREE.HemisphereLight(0x3a4458, 0x200a04, 2.4));
  const flashLight = new THREE.PointLight(0xffb040, 0, 120, 1.2);
  scene.add(flashLight);
  // a floor that catches the light and fades into the dark (fog)
  const floor = new THREE.Mesh(new THREE.CircleGeometry(600, 64), new THREE.MeshLambertMaterial({ color: 0x24140f }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const cam = new THREE.PerspectiveCamera(30, 1, 1, 1000);
  let anim = params.get('anim') ?? 'idle';
  radio('anim', Object.keys(DRIVERS), anim, (v) => { anim = v; animT0 = now(); });
  colorPicker(() => [guy]);
  const pg = group('');
  button(pg, 'compare', false, () => { location.search = ''; });
  let animT0 = FIXED_T === null ? now() : 0;
  const yaw0 = Number(params.get('yaw') ?? 0.55);
  const loop = (): void => {
    const { w, h } = resize();
    const t = now();
    const drv = DRIVERS[anim](t - animT0);
    guy.pose({ ...drv, time: t });
    // slow sway rather than a full spin: he stays facing out of the screen
    guy.object.rotation.y = yaw0 + (FIXED_T === null ? Math.sin(t * 0.35) * 0.35 : 0);
    flashLight.intensity = drv.frame === FRAME.F ? 250 : 0;
    flashLight.position.set(22, 38, -8).applyAxisAngle(new THREE.Vector3(0, 1, 0), guy.object.rotation.y);
    cam.aspect = w / h;
    // he stands in the left third, as on the start screen
    const dist = 175;
    cam.position.set(dist, 38, 0);
    cam.lookAt(0, 30, 0);
    cam.setViewOffset(w, h, w * 0.18, 0, w, h);
    cam.updateProjectionMatrix();
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.setClearColor(0x070605);
    renderer.render(scene, cam);
    octx.clearRect(0, 0, w, h);
    const g = octx.createRadialGradient(w * 0.32, h * 0.55, h * 0.15, w * 0.32, h * 0.55, h * 0.95);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.75)');
    octx.fillStyle = g;
    octx.fillRect(0, 0, w, h);
    statsEl.textContent = info;
    if (FIXED_T === null) requestAnimationFrame(loop);
    else (window as unknown as { __ready: boolean }).__ready = true;
  };
  loop();
}

// ---------------------------------------------------------------------------
// perf: 100 instances

function perf(factory: DoomguyFactory, info: string): void {
  const n = Number(params.get('n') ?? 100);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x202020);
  const guys: { m: DoomguyModel; anim: string; off: number }[] = [];
  const names = ['walk', 'run', 'fire', 'idle', 'pain', 'look', 'jump', 'death', 'gib'];
  const side = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    const m = factory.create(i % PLAYER_COLORS.length, i);
    m.object.position.set((Math.floor(i / side) - side / 2) * 48, 0, ((i % side) - side / 2) * 48);
    m.object.rotation.y = i * 0.7;
    m.setLight(160 + (i * 37) % 96);
    scene.add(m.object);
    guys.push({ m, anim: names[i % names.length], off: i * 0.37 });
  }
  const cam = new THREE.PerspectiveCamera(60, 1, 1, 4000);
  const times: number[] = [];
  const cpu: number[] = [];
  let lastT = performance.now();
  const loop = (): void => {
    const { w, h } = resize();
    const tn = performance.now();
    times.push(tn - lastT); lastT = tn;
    const t = tn / 1000;
    const c0 = performance.now();
    for (const g of guys) g.m.pose({ ...DRIVERS[g.anim](t + g.off), time: t });
    cam.aspect = w / h;
    cam.position.set(Math.cos(t * 0.1) * 420, 260, Math.sin(t * 0.1) * 420);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.render(scene, cam);
    cpu.push(performance.now() - c0);
    if (times.length > 120) { times.shift(); cpu.shift(); }
    const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
    const res = { instances: n, frameMs: avg(times), cpuMs: avg(cpu), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    (window as unknown as { __perf: unknown }).__perf = res;
    statsEl.textContent = `${info}\n${n} instances · ${res.calls} draw calls · ${res.triangles} tris\nframe ${res.frameMs.toFixed(2)} ms · pose+render CPU ${res.cpuMs.toFixed(2)} ms`;
    octx.clearRect(0, 0, w, h);
    requestAnimationFrame(loop);
  };
  loop();
}

// ---------------------------------------------------------------------------
// ragdoll: deaths that throw the body

function ragdoll(factory: DoomguyFactory, info: string): void {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2a2a2a);
  const g = new THREE.GridHelper(512, 32, 0x555555, 0x444444);
  g.position.y = -0.05;
  scene.add(g);
  const kinds = [
    { name: 'rocket', kick: { dx: 1, dz: 0.15, power: 0.9, kind: 0 } },
    { name: 'plasma', kick: { dx: 1, dz: -0.1, power: 0.6, kind: 1 } },
    { name: 'BFG', kick: { dx: 0.8, dz: 0.5, power: 1, kind: 2 } },
    { name: 'shotgun', kick: { dx: 1, dz: 0.2, power: 0.5, kind: 3 } },
    { name: 'chaingun', kick: { dx: 1, dz: -0.3, power: 0.15, kind: 3 } },
  ];
  const guys = kinds.map((k, i) => {
    const m = factory.create(i + 1, i + 3);
    m.setLight(220);
    m.object.position.set(-40, 0, (i - 2) * 100);
    m.object.rotation.y = Math.PI; // facing the shooter at -X: the push is along +X world, his back
    scene.add(m.object);
    return { m, ...k };
  });
  const cam = new THREE.PerspectiveCamera(50, 1, 1, 4000);
  const STAND = 0.6, CYCLE = 5;
  // a cycle: standing, then hit (death frames H.., N held), the kick given on the first death pose
  const poseAt = (m: DoomguyModel, kick: RagdollKick, t: number, first: boolean): void => {
    const dt = t - STAND;
    const frame = dt < 0 ? FRAME.A : Math.min(FRAME.N, FRAME.H + Math.floor(dt * 3.5));
    // turned 180°: model +X is world -X, so a world +X push is model -X
    const k = { ...kick, dx: -kick.dx, dz: -kick.dz };
    m.pose({ frame, time: t, kick: dt >= 0 && first ? k : null, floor: 0, ceil: 256 });
  };
  const sim = (t: number): void => {
    for (const gy of guys) {
      gy.m.reset(1);
      let kicked = false;
      for (let u = 0; u <= t; u += 1 / 60) {
        const first = !kicked && u >= STAND;
        if (first) kicked = true;
        poseAt(gy.m, gy.kick, u, first);
      }
    }
  };
  let t0 = performance.now() / 1000, cycleStart = -1;
  const kicked = guys.map(() => false);
  const loop = (): void => {
    const { w, h } = resize();
    if (FIXED_T !== null) sim(FIXED_T + STAND);
    else {
      const t = performance.now() / 1000 - t0;
      const c = Math.floor(t / CYCLE);
      if (c !== cycleStart) { cycleStart = c; guys.forEach((gy, i) => { gy.m.reset(c + i); kicked[i] = false; }); }
      const tc = t - c * CYCLE;
      guys.forEach((gy, i) => {
        const first = !kicked[i] && tc >= STAND;
        if (first) kicked[i] = true;
        poseAt(gy.m, gy.kick, tc, first);
      });
    }
    cam.aspect = w / h;
    if (params.has('near')) { cam.position.set(-60, 110, 150); cam.lookAt(10, 0, 0); } // the middle body, close
    else { cam.position.set(-330, 170, 380); cam.lookAt(20, 20, 0); }
    cam.updateProjectionMatrix();
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.render(scene, cam);
    octx.clearRect(0, 0, w, h);
    guys.forEach((gy, i) => {
      const p = new THREE.Vector3(-40, 75, (i - 2) * 100).project(cam);
      label(gy.name, (p.x * 0.5 + 0.5) * w, (0.5 - p.y * 0.5) * h);
    });
    statsEl.textContent = info;
    if (FIXED_T === null) requestAnimationFrame(loop);
    else (window as unknown as { __ready: boolean }).__ready = true;
  };
  loop();
}

main().catch((e) => { statsEl.textContent = String(e?.stack ?? e); console.error(e); });
