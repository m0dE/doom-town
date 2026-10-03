/**
 * The start screen's marine: the 3D box model (src/model, see hero3d.ts) under the
 * hero lighting, in the player's colour, turning slowly and now and then aiming
 * and firing. Drag turns him.
 *
 * Kept light: the 3D view (three.js, the model's atlas) is loaded and built only
 * once the WAD is in, renders only while the menu is shown, and is released when
 * a match starts (rebuilt on return). Where WebGL will not start, the player
 * sprite (PLAY*) straight out of the WAD is drawn instead: palette-correct, at
 * its own resolution in a small canvas that CSS scales up with
 * `image-rendering: pixelated`, walking and turning through Doom's eight rotations.
 *
 * The start screen talks to it only through `mount(el)` / `setGfx(g)` /
 * `setColor(i)` / `start()` / `stop()` / `dispose()`.
 */
import type { Gfx } from '../hud/gfx.js';
import { translationFor } from '../game/colors.js';

const W = 72, H = 72, BASE = 66, CX = 36;
const TIC = 1000 / 35;

type Hero = import('./hero3d.js').Hero3D;

export class Doomguy {
  readonly canvas: HTMLCanvasElement;
  private host: HTMLElement | null = null;
  private hero: Hero | null = null;
  private heroLoading = false;
  /** WebGL did not start (or ?hero=2d): the sprite for good */
  private no3d = new URLSearchParams(location.search).get('hero') === '2d';
  private running = false;
  private readonly ctx: CanvasRenderingContext2D;
  private gfx: Gfx | null = null;
  private color = 0;
  private raf = 0;
  private t0 = 0;
  /** Turn by drag: a manual offset in rotations, eased back to the auto turn when released. */
  private dragRot = 0;
  private dragging = false;
  private lastX = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.canvas.className = 'doomguy';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;
    this.canvas.addEventListener('pointerdown', (e) => { this.dragging = true; this.lastX = e.clientX; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.dragRot -= (e.clientX - this.lastX) / 40;
      this.lastX = e.clientX;
    });
    const up = (): void => { this.dragging = false; };
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
  }

  /** Put the marine into `el` (its size is the element's). */
  mount(el: HTMLElement): void { this.host = el; this.start(); }

  dispose(): void { this.stop(); this.canvas.remove(); }

  /** The WAD's graphics, once loaded; until then nothing is drawn. */
  setGfx(g: Gfx): void { this.gfx = g; if (this.running) this.ensureHero(); }
  setColor(c: number): void { this.color = c; this.hero?.setColor(c); }

  /** Start drawing (the menu is shown). */
  start(): void {
    this.running = true;
    this.ensureHero();
    if (this.raf) return;
    this.t0 = performance.now();
    const loop = (now: number): void => {
      this.raf = requestAnimationFrame(loop);
      if (this.hero) this.hero.render(now / 1000);
      else if (this.no3d) this.draw(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Stop drawing and give the 3D view's GPU memory back (a match is starting). */
  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.hero) { this.hero.dispose(); this.hero = null; this.host?.parentElement?.classList.remove('has-3d'); }
  }

  /** Frame time of the 3D view, for tests (null when the sprite is drawn). */
  get heroFrameMs(): number | null { return this.hero ? this.hero.frameMs : null; }

  /** For tests: hold a turn (radians from facing the camera) and/or start the aim-and-fire. */
  testPose(yaw: number | null, fire = false, frame = -1): void { this.hero?.testPose(yaw, fire, frame); }

  private ensureHero(): void {
    if (this.hero || this.heroLoading || !this.host) return;
    if (this.no3d || !this.gfx) { if (this.no3d) this.useSprite(); return; }
    this.heroLoading = true;
    const wad = this.gfx.wad;
    import('./hero3d.js').then(({ Hero3D }) => {
      this.heroLoading = false;
      if (!this.running || this.hero) return;
      const t0 = performance.now();
      const hero = new Hero3D(wad, this.color);
      this.canvas.remove();
      this.host!.append(hero.canvas);
      this.host!.parentElement?.classList.add('has-3d');
      this.hero = hero;
      console.info(`[menu] 3D marine ready in ${Math.round(performance.now() - t0)} ms (WebGL context ${Math.round(hero.glMs)} ms)`);
    }).catch((err: unknown) => {
      this.heroLoading = false;
      console.warn('[menu] no 3D marine, drawing the sprite:', err);
      this.no3d = true;
      this.useSprite();
    });
  }

  private useSprite(): void {
    if (this.host && !this.canvas.isConnected) this.host.append(this.canvas);
  }

  private draw(now: number): void {
    const g = this.gfx;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    if (!g) return;
    const tics = Math.floor((now - this.t0) / TIC);
    // A 10 s loop: 8 s walking, then aim (E), fire (F, bright), aim, fire, aim.
    const loop = tics % 350;
    let frame: string;
    if (loop < 280) frame = 'ABCD'[Math.floor(loop / 4) % 4];
    else {
      const k = loop - 280;
      frame = k < 12 ? 'E' : k < 18 ? 'F' : k < 30 ? 'E' : k < 36 ? 'F' : 'E';
    }
    // One rotation step every ~1.1 s, plus whatever the drag added. Rotation 1 faces us.
    if (!this.dragging) this.dragRot *= 0.98;
    const turn = Math.floor(tics / 40) + Math.round(this.dragRot);
    const rot = (((turn % 8) + 8) % 8) + 1;
    const tr = translationFor(g.pal, this.color);
    const f = g.spriteFrame('PLAY', frame, rot, tr, `c${this.color}`) ?? g.spriteFrame('PLAY', 'A', 1, tr, `c${this.color}`);
    if (!f) return;
    const p = f.patch;
    ctx.save();
    if (f.flip) {
      // A mirrored rotation: Doom keeps x1 = x - leftoffset and reads the columns backwards.
      ctx.translate(CX - p.left + p.width, BASE - p.top);
      ctx.scale(-1, 1);
      ctx.drawImage(p.canvas, 0, 0);
    } else {
      ctx.drawImage(p.canvas, CX - p.left, BASE - p.top);
    }
    ctx.restore();
  }
}
