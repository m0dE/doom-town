// Vanilla map lumps from MapData, and a BLOCKMAP builder.
import type { MapData } from '../../../src/wad/mapdata.ts';

const enc = (s: string, b: Uint8Array, off: number) => { for (let i = 0; i < 8; i++) b[off + i] = i < s.length ? s.charCodeAt(i) : 0; };
function lump(n: number, size: number, f: (dv: DataView, b: Uint8Array, i: number, o: number) => void): Uint8Array {
  const b = new Uint8Array(n * size);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < n; i++) f(dv, b, i, i * size);
  return b;
}
const i16 = (v: number) => { if (v < -32768 || v > 32767 || !Number.isInteger(v)) throw new Error(`not an i16: ${v}`); return v; };

/**
 * BLOCKMAP (128-unit blocks; each list starts with the conventional 0 and ends with -1;
 * identical lists are shared). Returns null if the offsets would not fit in 16 bits.
 */
export function buildBlockmap(map: MapData): Uint8Array | null {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const v of map.vertexes) { minx = Math.min(minx, v.x); miny = Math.min(miny, v.y); maxx = Math.max(maxx, v.x); maxy = Math.max(maxy, v.y); }
  const ox = minx - 8, oy = miny - 8;
  const W = Math.floor((maxx - ox) / 128) + 1, H = Math.floor((maxy - oy) / 128) + 1;
  const blocks: number[][] = Array.from({ length: W * H }, () => []);
  map.lines.forEach((l, li) => {
    const a = map.vertexes[l.v1], b = map.vertexes[l.v2];
    const bx0 = Math.floor((Math.min(a.x, b.x) - ox) / 128), bx1 = Math.floor((Math.max(a.x, b.x) - ox) / 128);
    const by0 = Math.floor((Math.min(a.y, b.y) - oy) / 128), by1 = Math.floor((Math.max(a.y, b.y) - oy) / 128);
    const dx = b.x - a.x, dy = b.y - a.y;
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
      // does the segment touch this block's box (closed)? test the box corners against the line
      const x0 = ox + bx * 128, y0 = oy + by * 128, x1 = x0 + 128, y1 = y0 + 128;
      let pos = 0, neg = 0;
      for (const [cx, cy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
        const s = dx * (cy - a.y) - dy * (cx - a.x);
        if (s > 0) pos++; else if (s < 0) neg++; else { pos++; neg++; }
      }
      if (pos && neg) blocks[by * W + bx].push(li);
    }
  });
  const words: number[] = [ox, oy, W, H];
  const header = 4;
  for (let i = 0; i < W * H; i++) words.push(0);
  const shared = new Map<string, number>();
  for (let i = 0; i < W * H; i++) {
    const k = blocks[i].join(',');
    let off = shared.get(k);
    if (off === undefined) {
      off = words.length;
      words.push(0, ...blocks[i], -1);
      shared.set(k, off);
    }
    words[header + i] = off;
  }
  if (words.length > 65535) return null;
  const out = new Uint8Array(words.length * 2);
  const dv = new DataView(out.buffer);
  words.forEach((w, i) => dv.setInt16(i * 2, w > 32767 ? w - 65536 : w, true));
  return out;
}

export function mapLumps(map: MapData, opts: { blockmap?: boolean } = {}): { name: string; data: Uint8Array }[] {
  const things = lump(map.things.length, 10, (dv, _b, i, o) => {
    const t = map.things[i];
    dv.setInt16(o, i16(t.x), true); dv.setInt16(o + 2, i16(t.y), true); dv.setInt16(o + 4, i16(t.angle), true);
    dv.setInt16(o + 6, t.type, true); dv.setInt16(o + 8, t.flags, true);
  });
  const linedefs = lump(map.lines.length, 14, (dv, _b, i, o) => {
    const l = map.lines[i];
    dv.setUint16(o, l.v1, true); dv.setUint16(o + 2, l.v2, true); dv.setUint16(o + 4, l.flags, true);
    dv.setUint16(o + 6, l.special, true); dv.setUint16(o + 8, l.tag, true);
    dv.setUint16(o + 10, l.front < 0 ? 0xffff : l.front, true); dv.setUint16(o + 12, l.back < 0 ? 0xffff : l.back, true);
  });
  const sidedefs = lump(map.sides.length, 30, (dv, b, i, o) => {
    const s = map.sides[i];
    dv.setInt16(o, i16(s.xoff), true); dv.setInt16(o + 2, i16(s.yoff), true);
    enc(s.top, b, o + 4); enc(s.bottom, b, o + 12); enc(s.mid, b, o + 20);
    dv.setUint16(o + 28, s.sector, true);
  });
  const vertexes = lump(map.vertexes.length, 4, (dv, _b, i, o) => { dv.setInt16(o, i16(map.vertexes[i].x), true); dv.setInt16(o + 2, i16(map.vertexes[i].y), true); });
  const segs = lump(map.segs.length, 12, (dv, _b, i, o) => {
    const s = map.segs[i];
    dv.setUint16(o, s.v1, true); dv.setUint16(o + 2, s.v2, true); dv.setInt16(o + 4, s.angle, true);
    dv.setUint16(o + 6, s.line, true); dv.setInt16(o + 8, s.side, true); dv.setInt16(o + 10, i16(s.offset), true);
  });
  const ssectors = lump(map.subsectors.length, 4, (dv, _b, i, o) => { dv.setUint16(o, map.subsectors[i].count, true); dv.setUint16(o + 2, map.subsectors[i].first, true); });
  const nodes = lump(map.nodes.length, 28, (dv, _b, i, o) => {
    const n = map.nodes[i];
    [n.x, n.y, n.dx, n.dy, ...n.bbox[0], ...n.bbox[1]].forEach((v, k) => dv.setInt16(o + k * 2, i16(v), true));
    dv.setUint16(o + 24, n.children[0], true); dv.setUint16(o + 26, n.children[1], true);
  });
  const sectors = lump(map.sectors.length, 26, (dv, b, i, o) => {
    const s = map.sectors[i];
    dv.setInt16(o, i16(s.floor), true); dv.setInt16(o + 2, i16(s.ceil), true);
    enc(s.floorPic, b, o + 4); enc(s.ceilPic, b, o + 12);
    dv.setInt16(o + 20, s.light, true); dv.setInt16(o + 22, s.special, true); dv.setInt16(o + 24, s.tag, true);
  });
  const blockmap = opts.blockmap === false ? new Uint8Array(0) : buildBlockmap(map) ?? new Uint8Array(0);
  return [
    { name: map.name, data: new Uint8Array(0) },
    { name: 'THINGS', data: things }, { name: 'LINEDEFS', data: linedefs }, { name: 'SIDEDEFS', data: sidedefs },
    { name: 'VERTEXES', data: vertexes }, { name: 'SEGS', data: segs }, { name: 'SSECTORS', data: ssectors },
    { name: 'NODES', data: nodes }, { name: 'SECTORS', data: sectors },
    { name: 'REJECT', data: new Uint8Array(0) }, // empty = no rejection (the sim pads it with zeros)
    { name: 'BLOCKMAP', data: blockmap },
  ];
}
