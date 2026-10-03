// Minimal PNG encoder (RGB, 8 bit) and a tiny raster canvas for map previews.
import { deflateSync } from 'node:zlib';

const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c;
}
function crc32(b: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function encodePng(w: number, h: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  const chunks: Uint8Array[] = [];
  const chunk = (type: string, data: Uint8Array) => {
    const b = new Uint8Array(12 + data.length);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
    b.set(data, 8);
    dv.setUint32(8 + data.length, crc32(b.subarray(4, 8 + data.length)));
    chunks.push(b);
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 2;
  chunks.push(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  chunk('IHDR', ihdr);
  chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 })));
  chunk('IEND', new Uint8Array(0));
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export type RGB = [number, number, number];

// 3x5 pixel font for labels (uppercase, digits, a few marks)
const FONT: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110',
  '4': '101101111001001', '5': '111100110001110', '6': '011100111101111', '7': '111001010010010', '8': '111101111101111',
  '9': '111101111001110', ' ': '000000000000000', '-': '000000111000000', ':': '000010000010000', '.': '000000000000010',
  '/': '001001010100100', '(': '010100100100010', ')': '010001001001010', '+': '000010111010000', 'x': '000101010101000',
};

export class Canvas {
  readonly px: Uint8Array;
  readonly w: number;
  readonly h: number;
  constructor(w: number, h: number, bg: RGB = [0, 0, 0]) {
    this.w = w; this.h = h;
    this.px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) this.px.set(bg, i * 3);
  }
  set(x: number, y: number, c: RGB, a = 1): void {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 3;
    if (a >= 1) { this.px[o] = c[0]; this.px[o + 1] = c[1]; this.px[o + 2] = c[2]; return; }
    for (let k = 0; k < 3; k++) this.px[o + k] = Math.round(this.px[o + k] * (1 - a) + c[k] * a);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, a = 1): void {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let i = 0; i <= n; i++) this.set(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), c, a);
  }
  disc(cx: number, cy: number, r: number, c: RGB, a = 1): void {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) this.set(x, y, c, a);
    }
  }
  ring(cx: number, cy: number, r: number, c: RGB, a = 1): void {
    const n = Math.max(16, Math.ceil(r * 7));
    for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2; this.set(Math.round(cx + Math.cos(t) * r), Math.round(cy + Math.sin(t) * r), c, a); }
  }
  rect(x: number, y: number, w: number, h: number, c: RGB, a = 1): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c, a);
  }
  text(x: number, y: number, s: string, c: RGB, scale = 2, shadow = true): void {
    if (shadow) this.text(x + 1, y + 1, s, [0, 0, 0], scale, false);
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const g = FONT[ch] ?? FONT[' '];
      for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) if (g[j * 3 + i] === '1') this.rect(cx + i * scale, y + j * scale, scale, scale, c);
      cx += 4 * scale;
    }
  }
  png(): Uint8Array { return encodePng(this.w, this.h, this.px); }
}
