/**
 * A stand-in world view: Doom's automap, drawn from the same RenderFrame the
 * three.js renderer takes. Used when the 3D renderer cannot start (no WebGL)
 * and as the view the shell was built and tested against.
 */
import type { RenderFrame } from '../render/types.js';
import type { MapData } from '../wad/index.js';
import { MT_CRATE } from './br.js';

export interface WorldView {
  readonly canvas: HTMLCanvasElement;
  render(frame: RenderFrame): void;
  resize(w: number, h: number): void;
  /** CSS px of status bar over the bottom of the view (the renderer lifts the weapon). */
  hudHeight(px: number): void;
  setFov(deg: number): void;
  /** Player bodies: the 3D marine or Doom's sprites (views without 3D ignore it). */
  setPlayers?(mode: '3d' | 'sprites'): void;
  /** Frame statistics, for tests. */
  stats?(): Record<string, number | string>;
  dispose(): void;
}

export class AutomapView implements WorldView {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 0.6;

  constructor(private readonly map: MapData) {
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;background:#000';
  }

  resize(w: number, h: number): void {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.scale = 0.55 * dpr;
  }

  render(f: RenderFrame): void {
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height, k = this.scale;
    c.fillStyle = '#000';
    c.fillRect(0, 0, W, H);
    const cam = f.camera;
    c.save();
    c.translate(W / 2, H / 2);
    c.scale(k, -k);
    c.rotate(Math.PI / 2 - cam.yaw);
    c.translate(-cam.x, -cam.y);
    c.lineWidth = 1.5 / k;
    const m = this.map;
    for (const l of m.lines) {
      const a = m.vertexes[l.v1], b = m.vertexes[l.v2];
      c.strokeStyle = l.back < 0 ? '#fc0000' : l.special ? '#e7e700' : '#bc7843';
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    }
    const n = f.mobjCount ?? f.mobjs.length;
    for (let i = 0; i < n; i++) {
      const o = f.mobjs[i];
      if (o.id === f.viewMobjId) continue;
      if (o.slot >= 0) {
        c.fillStyle = '#7fff7f';
        c.save(); c.translate(o.x, o.y); c.rotate(o.angle);
        c.beginPath(); c.moveTo(24, 0); c.lineTo(-14, 12); c.lineTo(-14, -12); c.closePath(); c.fill();
        c.restore();
      } else if (o.type === MT_CRATE) {
        // a battle royale crate: its 40 x 40 footprint
        c.fillStyle = '#b07a3c';
        c.fillRect(o.x - 20, o.y - 20, 40, 40);
        c.strokeStyle = '#5a3a18';
        c.strokeRect(o.x - 20, o.y - 20, 40, 40);
      } else {
        c.fillStyle = (o.flags & 0x10000) ? '#ff8040' : '#8080ff';
        c.fillRect(o.x - 6, o.y - 6, 12, 12);
      }
    }
    c.restore();
    // you, in the middle, pointing up
    c.fillStyle = '#fff';
    c.beginPath(); c.moveTo(W / 2, H / 2 - 14 * k * 2); c.lineTo(W / 2 - 9 * k * 2, H / 2 + 9 * k * 2); c.lineTo(W / 2 + 9 * k * 2, H / 2 + 9 * k * 2); c.closePath(); c.fill();
  }

  hudHeight(): void { /* the automap has no weapon to lift */ }
  setFov(): void { /* nor a field of view */ }
  dispose(): void { this.canvas.remove(); }
}
