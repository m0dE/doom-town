/**
 * The start screen's marine in 3D: the box model (src/model) under the "hero"
 * lighting of model.html?mode=hero - warm key from the front, hard red rims from
 * behind, a cool low fill - standing on a floor that catches the key light and
 * fades to nothing, on a transparent canvas, so he stands in the page itself with
 * no box around him.
 *
 * A slow turntable; now and then, when he faces us, he aims and fires twice (Doom's
 * E and F frames, with the muzzle flash lighting him and the floor). Drag turns him.
 *
 * Loaded on demand (three.js is the match's chunk too), built once the WAD is in.
 * The caller owns the loop: `render(now)` once per animation frame.
 */
import * as THREE from 'three';
import { createDoomguyFactory, FRAME, type DoomguyFactory, type DoomguyModel } from '../model/index.js';
import type { Wad } from '../wad/index.js';

const TIC = 1 / 35;
/** aim, fire, aim, fire, aim: tics per step (the demo's "fire" driver) */
const FIRE_SEQ: [number, number][] = [[FRAME.E, 10], [FRAME.F, 6], [FRAME.E, 12], [FRAME.F, 6], [FRAME.E, 14]];
const FIRE_TICS = FIRE_SEQ.reduce((s, [, n]) => s + n, 0);
/** turntable speed, radians a second */
const SPIN = 0.32;
/** the yaw he faces us from: 0 = straight at the camera; a little to his right reads best */
const FACE = 0.45;

function radial(stops: [number, string][]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Hero3D {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly cam = new THREE.PerspectiveCamera(28, 1, 10, 1000);
  private readonly factory: DoomguyFactory;
  private readonly guy: DoomguyModel;
  private readonly flash: THREE.PointLight;
  private readonly disposables: { dispose(): void }[] = [];
  private yaw = FACE - 1.2;
  private drag = 0;
  private dragging = false;
  private lastX = 0;
  private fireAt = -1;
  private nextFire = 2.5;
  private last = -1;
  private w = 0;
  private h = 0;
  /** ms the WebGL context took to create */
  readonly glMs: number;
  /** ms per rendered frame, averaged (for the debug hook) */
  frameMs = 0;

  constructor(wad: Wad, color: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'doomguy doomguy-3d';
    this.canvas.setAttribute('aria-hidden', 'true');
    // throws without WebGL: the caller falls back to the sprite
    const t0 = performance.now();
    this.gl = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, powerPreference: 'low-power', premultipliedAlpha: true });
    this.gl.setClearColor(0x000000, 0);
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

    this.glMs = performance.now() - t0;
    this.factory = createDoomguyFactory(wad);
    this.guy = this.factory.create(color, 3);
    this.guy.setSceneLighting(1);
    this.guy.setFlashBoost(2.5);
    this.guy.setEmissiveAlpha(0);
    this.scene.add(this.guy.object);

    // warm key from front-left-above, hard red rims from behind both sides, cool low fill
    const key = new THREE.DirectionalLight(0xfff1e2, 8);
    key.position.set(95, 70, 45);
    const rim = new THREE.DirectionalLight(0xff2a10, 16);
    rim.position.set(-50, 35, -70);
    const rim2 = new THREE.DirectionalLight(0xff7a30, 7);
    rim2.position.set(-60, 25, 70);
    const fill = new THREE.DirectionalLight(0x6070a0, 2);
    fill.position.set(80, 10, -40);
    this.scene.add(key, rim, rim2, fill, new THREE.HemisphereLight(0x3a4458, 0x200a04, 2.4));
    (window as any).__heroDbg = { key, rim, rim2, fill, guy: this.guy };//DBG
    this.flash = new THREE.PointLight(0xffb040, 0, 140, 1.2);
    this.scene.add(this.flash);

    // the floor: lit by the key (and the muzzle flash), fading out to transparent
    const floorTex = radial([[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,.75)'], [0.7, 'rgba(255,255,255,.22)'], [1, 'rgba(255,255,255,0)']]);
    const floorGeo = new THREE.CircleGeometry(64, 48);
    const floorMat = new THREE.MeshLambertMaterial({ color: 0x5a2a1a, map: floorTex, transparent: true, depthWrite: false });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.renderOrder = -2;
    // contact shadow under his boots
    const shadowTex = radial([[0, 'rgba(0,0,0,.85)'], [0.5, 'rgba(0,0,0,.45)'], [1, 'rgba(0,0,0,0)']]);
    const shadowGeo = new THREE.CircleGeometry(30, 32);
    const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false });
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.05;
    shadow.scale.set(1, 0.8, 1);
    shadow.renderOrder = -1;
    this.scene.add(floor, shadow);
    this.disposables.push(floorTex, floorGeo, floorMat, shadowTex, shadowGeo, shadowMat);

    this.canvas.addEventListener('pointerdown', (e) => { this.dragging = true; this.lastX = e.clientX; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.drag += ((e.clientX - this.lastX) / Math.max(120, this.canvas.clientWidth)) * Math.PI * 1.6;
      this.lastX = e.clientX;
    });
    const up = (): void => { this.dragging = false; };
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
  }

  setColor(c: number): void { this.guy.setColor(c); }

  private hold: number | null = null;
  private holdFrame = -1;
  /** For tests: hold a turn (radians; null = turntable), fire now, or hold one Doom frame (-1 = none). */
  testPose(yaw: number | null, fire: boolean, frame = -1): void {
    this.hold = yaw;
    this.holdFrame = frame;
    if (yaw !== null) this.yaw = yaw;
    if (fire) this.fireAt = this.last < 0 ? 0 : this.last;
  }

  /** One frame at `now` seconds (monotonic). */
  render(now: number): void {
    const t0 = performance.now();
    const dt = this.last < 0 ? 0 : Math.min(0.1, now - this.last);
    this.last = now;
    this.resize();

    // the turntable, slowed while he shoots; drag adds its own turn
    const firing = this.fireAt >= 0;
    if (this.hold !== null) this.yaw = this.hold;
    else if (!this.dragging) this.yaw += dt * SPIN * (firing ? 0.15 : 1);
    this.yaw += this.drag;
    this.drag = 0;
    const facing = Math.atan2(Math.sin(this.yaw - FACE), Math.cos(this.yaw - FACE));
    if (!firing && !this.dragging && now >= this.nextFire && facing > -0.5 && facing < 0.15) this.fireAt = now;

    let frame: number = FRAME.A;
    let tics: number | undefined;
    if (this.fireAt >= 0) {
      let k = (now - this.fireAt) / TIC;
      if (k >= FIRE_TICS) { this.fireAt = -1; this.nextFire = now + 7 + Math.random() * 4; }
      else for (const [f, n] of FIRE_SEQ) { if (k < n) { frame = f; tics = n - k; break; } k -= n; }
    }
    if (this.holdFrame >= 0) { frame = this.holdFrame; tics = 3; }
    this.guy.pose({ frame, tics, moveSpeed: 0, time: now });
    this.guy.object.rotation.y = this.yaw;
    const fl = frame === FRAME.F;
    this.flash.intensity = fl ? 260 : 0;
    this.flash.position.set(24, 38, -8).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);

    this.gl.render(this.scene, this.cam);
    this.frameMs += (performance.now() - t0 - this.frameMs) * 0.1;
  }

  private resize(): void {
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.gl.setSize(w, h, false);
    this.cam.aspect = w / h;
    // eye a little above his chest, looking slightly down so the floor pool reads
    this.cam.position.set(168, 48, 0);
    this.cam.lookAt(0, 28, 0);
    this.cam.updateProjectionMatrix();
  }

  dispose(): void {
    this.guy.dispose();
    this.factory.dispose();
    for (const d of this.disposables) d.dispose();
    this.gl.dispose();
    this.gl.forceContextLoss();
    this.canvas.remove();
  }
}
