/**
 * The start screen's title, "DOOM TOWN": our own block lettering (no id or Freedoom
 * logo artwork), drawn at low resolution into a canvas and shown with
 * `image-rendering: pixelated` at a whole-number scale, so it reads like a
 * 1990s title graphic: chamfered slab letters, brushed steel over a hard
 * horizon into blood red, a bright top bevel, a dark under-bevel, a black
 * outline and a drop shadow.
 *
 * Glyphs are drawn on a grid of cells, CELL pixels square. A cell is full ('#'),
 * empty ('.'), or half, split on a diagonal: 'L' fills the lower-left triangle,
 * 'R' the lower-right, 'l' the upper-left, 'r' the upper-right.
 */
const CELL = 3;
const ROWS = 10;
const GLYPHS: Record<string, string[]> = {
  D: ['######L.', '#######L', '###..###', '###..###', '###..###', '###..###', '###..###', '###..###', '#######l', '######l.'],
  O: ['.R####L.', 'R######L', '###..###', '###..###', '###..###', '###..###', '###..###', '###..###', 'r######l', '.r####l.'],
  M: ['##L....R##', '###L..R###', '####LR####', '###r##l###', '###.rl.###', '###....###', '###....###', '###....###', '###....###', '###....###'],
  T: ['#########', '#########', '...###...', '...###...', '...###...', '...###...', '...###...', '...###...', '...###...', '...###...'],
  W: ['###....###', '###....###', '###....###', '###....###', '###....###', '###.RL.###', '###R##L###', '####lr####', '###l..r###', '##l....r##'],
  N: ['###L..###', '####L.###', '#####L###', '###r#####', '###.r####', '###..r###', '###...###', '###...###', '###...###', '###...###'],
  ' ': ['....', '....', '....', '....', '....', '....', '....', '....', '....', '....'],
};
/** pixels between letters, and around the lettering for the outline and shadow */
const GAP = 3;
const PAD = 4;

function inside(c: string, px: number, py: number): boolean {
  switch (c) {
    case '#': return true;
    case 'L': return px <= py;
    case 'R': return CELL - 1 - px <= py;
    case 'l': return px + py <= CELL - 1;
    case 'r': return px >= py;
    default: return false;
  }
}

/** Small deterministic noise, for the metal's grain. */
function grain(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Draws the title into `canvas` (resized to the lettering); returns its pixel size. */
export function drawTitle(canvas: HTMLCanvasElement, text = 'DOOM TOWN'): { w: number; h: number } {
  const glyphs = [...text.toUpperCase()].map((ch) => GLYPHS[ch] ?? GLYPHS[' ']);
  const textW = glyphs.reduce((s, g) => s + g[0].length * CELL, 0) + GAP * (glyphs.length - 1);
  const textH = ROWS * CELL;
  const W = textW + PAD * 2 + 2, H = textH + PAD * 2 + 2;
  // the lettering's mask
  const mask = new Uint8Array(W * H);
  let x0 = PAD;
  for (const g of glyphs) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < g[r].length; c++) {
        const ch = g[r][c];
        for (let py = 0; py < CELL; py++) for (let px = 0; px < CELL; px++) {
          if (inside(ch, px, py)) mask[(PAD + r * CELL + py) * W + x0 + c * CELL + px] = 1;
        }
      }
    }
    x0 += g[0].length * CELL + GAP;
  }
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= W || y >= H ? 0 : mask[y * W + x]);

  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const px = img.data;
  const put = (i: number, r: number, g: number, b: number, a = 255): void => {
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = a;
  };
  const horizon = PAD + Math.round(textH * 0.56);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (at(x, y)) {
        const t = (y - PAD) / (textH - 1);
        const n = (grain(x, y) - 0.5) * 26 + (grain(x >> 1, y * 7) - 0.5) * 14;
        let r: number, g: number, b: number;
        if (y < horizon) {
          // brushed steel: bright at the top, darkening toward the horizon
          const k = 1 - t / 0.56;
          const v = 120 + k * 120 + n;
          r = v * 1.0; g = v * 0.97; b = v * 0.94;
        } else if (y === horizon) {
          r = 255; g = 214; b = 150; // a hot seam where steel meets blood
        } else {
          // blood red, glowing at the seam and going dark at the foot
          const k = (y - horizon) / (PAD + textH - horizon);
          r = 225 - k * 120 + n; g = 34 - k * 24 + n * 0.3; b = 14 - k * 10;
        }
        // bevels: lit from above, shaded below and on the right
        if (!at(x, y - 1)) { r = r * 0.4 + 255 * 0.6; g = g * 0.4 + 240 * 0.6; b = b * 0.4 + 220 * 0.6; }
        else if (!at(x, y + 1) || !at(x + 1, y)) { r *= 0.45; g *= 0.4; b *= 0.4; }
        else if (!at(x - 1, y)) { r = Math.min(255, r * 1.15); g = Math.min(255, g * 1.15); b = Math.min(255, b * 1.15); }
        put(i, Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b)));
        continue;
      }
      // outline (black, 1px, 8-connected), then a dark-red second ring, then the drop shadow
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) if (at(x + dx, y + dy)) { edge = true; break; }
      if (edge) { put(i, 8, 3, 2); continue; }
      let ring = false;
      for (let dy = -2; dy <= 2 && !ring; dy++) for (let dx = -2; dx <= 2; dx++) if (Math.abs(dx) + Math.abs(dy) <= 3 && at(x + dx, y + dy)) { ring = true; break; }
      if (ring) { put(i, 70, 6, 2, 200); continue; }
      if (at(x - 3, y - 3) || at(x - 2, y - 3) || at(x - 3, y - 2)) put(i, 0, 0, 0, 150);
    }
  }
  ctx.putImageData(img, 0, 0);
  return { w: W, h: H };
}
