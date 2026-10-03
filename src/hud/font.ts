/**
 * Doom's HUD font (STCFN033..STCFN121, hu_stuff.c) as text canvases.
 *
 * Text is upper-cased like HU_Responder does; characters the font lacks are
 * skipped with a space's advance. A tint recolours the red glyphs by their
 * brightness (killfeed names, your own lines in gold), keeping the shading.
 * Every rendered string is cached - a HUD redraws the same few lines a lot.
 */
import type { Gfx, Patch } from './gfx.js';

const SPACE = 4;
const LINE = 8;

export class DoomFont {
  private readonly glyphs = new Map<string, Patch | null>();
  private readonly cache = new Map<string, HTMLCanvasElement>();

  constructor(private readonly gfx: Gfx) {}

  /** Pixel width of a string at scale 1. */
  width(text: string): number {
    let w = 0;
    for (const ch of text.toUpperCase()) w += this.glyph(ch)?.width ?? SPACE;
    return w;
  }

  /**
   * A canvas with `text` drawn at 1:1 (CSS scales it, pixelated). `tint` is a
   * CSS hex colour; omitted = Doom's red.
   */
  text(text: string, tint?: string, shadow = true): HTMLCanvasElement {
    const key = `${tint ?? ''}|${shadow ? 1 : 0}|${text}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const up = text.toUpperCase();
    const w = Math.max(1, this.width(up) + (shadow ? 1 : 0));
    const c = document.createElement('canvas');
    c.width = w; c.height = LINE + (shadow ? 1 : 0);
    const ctx = c.getContext('2d')!;
    let x = 0;
    const draw = (dx: number, dy: number, img: CanvasImageSource): void => { ctx.drawImage(img, dx, dy); };
    for (const ch of up) {
      const g = this.glyph(ch);
      if (!g) { x += SPACE; continue; }
      if (shadow) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.85;
        draw(x + 1, 1, this.silhouette(g));
        ctx.globalAlpha = 1;
      }
      draw(x, 0, tint ? this.tinted(g, tint) : g.canvas);
      x += g.width;
    }
    if (this.cache.size > 600) this.cache.clear();
    this.cache.set(key, c);
    return c;
  }

  private glyph(ch: string): Patch | null {
    let g = this.glyphs.get(ch);
    if (g !== undefined) return g;
    const code = ch.charCodeAt(0);
    g = code > 32 && code < 128 ? this.gfx.patch(`STCFN${String(code).padStart(3, '0')}`) : null;
    this.glyphs.set(ch, g);
    return g;
  }

  private readonly tints = new Map<string, HTMLCanvasElement>();

  private tinted(g: Patch, tint: string): HTMLCanvasElement {
    const key = `${g.name}|${tint}`;
    let c = this.tints.get(key);
    if (c) return c;
    const [tr, tg, tb] = hex(tint);
    c = recolor(g, (r, gg, b) => {
      const l = Math.min(1, Math.max(r, gg, b) / 200);
      return [tr * l, tg * l, tb * l];
    });
    this.tints.set(key, c);
    return c;
  }

  private silhouette(g: Patch): HTMLCanvasElement {
    return this.tinted(g, '#000000');
  }
}

function hex(s: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
}

function recolor(src: Patch, f: (r: number, g: number, b: number) => [number, number, number]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(c.width, c.height);
  const d = img.data, s = src.rgba;
  for (let i = 0; i < d.length; i += 4) {
    if (!s[i + 3]) continue;
    const [r, g, b] = f(s[i], s[i + 1], s[i + 2]);
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Put a text canvas into an element at an integer scale (crisp). */
export function placeText(host: HTMLElement, canvas: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const c = canvas.cloneNode(false) as HTMLCanvasElement;
  c.getContext('2d')!.drawImage(canvas, 0, 0);
  c.style.width = `${canvas.width * scale}px`;
  c.style.height = `${canvas.height * scale}px`;
  c.className = 'dtext';
  host.append(c);
  return c;
}
