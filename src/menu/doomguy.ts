/**
 * The start screen's marine: the player sprite (PLAY*) straight out of the
 * WAD, palette-correct, in the player's colour, walking and slowly turning
 * through Doom's eight rotations, stopping now and then to aim and fire.
 *
 * Drawn at the sprite's own resolution into a small canvas that CSS scales up
 * with `image-rendering: pixelated`, so every pixel stays a crisp square.
 *
 * Self-contained on purpose: the start screen talks to it only through
 * `mount(el)` / `setColor(i)` / `start()` / `stop()` / `dispose()`, so a 3D
 * model (src/model/) can replace the sprite without the menu changing.
 */
import type { Gfx } from '../hud/gfx.js';
import { translationFor } from '../game/colors.js';

const W = 72, H = 72, BASE = 66, CX = 36;
const TIC = 1000 / 35;

export class Doomguy {
  readonly canvas: HTMLCanvasElement;
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

  /** Put the marine into `el` (its size is the element's; CSS scales the pixels). */
  mount(el: HTMLElement): void { el.append(this.canvas); this.start(); }

  dispose(): void { this.stop(); this.canvas.remove(); }

  /** The WAD's graphics, once loaded; until then nothing is drawn. */
  setGfx(g: Gfx): void { this.gfx = g; }
  setColor(c: number): void { this.color = c; }

  start(): void {
    if (this.raf) return;
    this.t0 = performance.now();
    const loop = (now: number): void => { this.raf = requestAnimationFrame(loop); this.draw(now); };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
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
