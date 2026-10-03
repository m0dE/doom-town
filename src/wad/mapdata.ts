// Map lump parsing (vanilla Doom format). No imports (used by tools/build-pak).

export interface MapVertex { x: number; y: number }
export interface MapLine { v1: number; v2: number; flags: number; special: number; tag: number; front: number; back: number }
export interface MapSide { xoff: number; yoff: number; top: string; bottom: string; mid: string; sector: number }
export interface MapSector { floor: number; ceil: number; floorPic: string; ceilPic: string; light: number; special: number; tag: number }
export interface MapSeg { v1: number; v2: number; angle: number; line: number; side: number; offset: number }
export interface MapSubsector { count: number; first: number }
export interface MapNode { x: number; y: number; dx: number; dy: number; bbox: [number[], number[]]; children: [number, number] }
export interface MapThing { x: number; y: number; angle: number; type: number; flags: number }

export interface MapData {
  name: string;
  vertexes: MapVertex[]; lines: MapLine[]; sides: MapSide[]; sectors: MapSector[];
  segs: MapSeg[]; subsectors: MapSubsector[]; nodes: MapNode[]; things: MapThing[];
}

/** Line flags (doomdata.h). */
export const ML_BLOCKING = 1, ML_TWOSIDED = 4, ML_DONTPEGTOP = 8, ML_DONTPEGBOTTOM = 16, ML_SECRET = 32, ML_DONTDRAW = 128, ML_MAPPED = 256;
/** NF_SUBSECTOR bit in node children. */
export const NF_SUBSECTOR = 0x8000;

const dec = new TextDecoder('latin1');
function name8(b: Uint8Array, off: number): string {
  let e = off;
  while (e < off + 8 && b[e] !== 0) e++;
  return dec.decode(b.subarray(off, e)).toUpperCase();
}
function dv(b: Uint8Array): DataView { return new DataView(b.buffer, b.byteOffset, b.byteLength); }
function rows<T>(b: Uint8Array | undefined, size: number, f: (d: DataView, o: number) => T): T[] {
  if (!b) return [];
  const d = dv(b);
  const out: T[] = [];
  for (let o = 0; o + size <= b.length; o += size) out.push(f(d, o));
  return out;
}

export function parseMap(name: string, lumps: Map<string, Uint8Array>): MapData {
  const u16 = (d: DataView, o: number) => d.getUint16(o, true);
  const i16 = (d: DataView, o: number) => d.getInt16(o, true);
  const sideIdx = (d: DataView, o: number) => { const v = d.getUint16(o, true); return v === 0xffff ? -1 : v; };
  return {
    name,
    vertexes: rows(lumps.get('VERTEXES'), 4, (d, o) => ({ x: i16(d, o), y: i16(d, o + 2) })),
    lines: rows(lumps.get('LINEDEFS'), 14, (d, o) => ({ v1: u16(d, o), v2: u16(d, o + 2), flags: u16(d, o + 4), special: u16(d, o + 6), tag: u16(d, o + 8), front: sideIdx(d, o + 10), back: sideIdx(d, o + 12) })),
    sides: rows(lumps.get('SIDEDEFS'), 30, (d, o) => {
      const b = lumps.get('SIDEDEFS')!;
      return { xoff: i16(d, o), yoff: i16(d, o + 2), top: name8(b, o + 4), bottom: name8(b, o + 12), mid: name8(b, o + 20), sector: u16(d, o + 28) };
    }),
    sectors: rows(lumps.get('SECTORS'), 26, (d, o) => {
      const b = lumps.get('SECTORS')!;
      return { floor: i16(d, o), ceil: i16(d, o + 2), floorPic: name8(b, o + 4), ceilPic: name8(b, o + 12), light: i16(d, o + 20), special: i16(d, o + 22), tag: i16(d, o + 24) };
    }),
    segs: rows(lumps.get('SEGS'), 12, (d, o) => ({ v1: u16(d, o), v2: u16(d, o + 2), angle: i16(d, o + 4), line: u16(d, o + 6), side: i16(d, o + 8), offset: i16(d, o + 10) })),
    subsectors: rows(lumps.get('SSECTORS'), 4, (d, o) => ({ count: u16(d, o), first: u16(d, o + 2) })),
    nodes: rows(lumps.get('NODES'), 28, (d, o) => ({
      x: i16(d, o), y: i16(d, o + 2), dx: i16(d, o + 4), dy: i16(d, o + 6),
      bbox: [[i16(d, o + 8), i16(d, o + 10), i16(d, o + 12), i16(d, o + 14)], [i16(d, o + 16), i16(d, o + 18), i16(d, o + 20), i16(d, o + 22)]] as [number[], number[]],
      children: [u16(d, o + 24), u16(d, o + 26)] as [number, number],
    })),
    things: rows(lumps.get('THINGS'), 10, (d, o) => ({ x: i16(d, o), y: i16(d, o + 2), angle: i16(d, o + 4), type: i16(d, o + 6), flags: i16(d, o + 8) })),
  };
}

/** R_PointOnSide: 0 = front (right of the partition line), 1 = back. */
export function pointOnSide(x: number, y: number, node: MapNode): number {
  if (node.dx === 0) return x <= node.x ? (node.dy > 0 ? 1 : 0) : (node.dy < 0 ? 1 : 0);
  if (node.dy === 0) return y <= node.y ? (node.dx < 0 ? 1 : 0) : (node.dx > 0 ? 1 : 0);
  return (y - node.y) * node.dx < (x - node.x) * node.dy ? 0 : 1;
}

/** R_PointInSubsector: walks the BSP to the subsector containing (x, y). */
export function pointInSubsector(map: MapData, x: number, y: number): number {
  if (!map.nodes.length) return 0;
  let n = map.nodes.length - 1;
  for (;;) {
    const node = map.nodes[n];
    const side = pointOnSide(x, y, node);
    const child = node.children[side];
    if (child & NF_SUBSECTOR) return child & ~NF_SUBSECTOR;
    n = child;
  }
}
