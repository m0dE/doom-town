// PNAMES / TEXTURE1 / TEXTURE2 parsing and writing. No imports (used by tools/build-pak).

export interface TexturePatchRef { originX: number; originY: number; patch: string }
export interface TextureDef { name: string; masked: number; width: number; height: number; patches: TexturePatchRef[] }

const dec = new TextDecoder('latin1');
function name8(b: Uint8Array, off: number): string {
  let e = off;
  while (e < off + 8 && b[e] !== 0) e++;
  return dec.decode(b.subarray(off, e)).toUpperCase();
}
function put8(b: Uint8Array, off: number, s: string): void {
  for (let i = 0; i < 8; i++) b[off + i] = i < s.length ? s.charCodeAt(i) : 0;
}
function view(b: Uint8Array): DataView { return new DataView(b.buffer, b.byteOffset, b.byteLength); }

export function parsePnames(data: Uint8Array): string[] {
  const n = view(data).getInt32(0, true);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(name8(data, 4 + i * 8));
  return out;
}

export function parseTextureLump(data: Uint8Array, pnames: string[]): TextureDef[] {
  const dv = view(data);
  const n = dv.getInt32(0, true);
  const out: TextureDef[] = [];
  for (let i = 0; i < n; i++) {
    const o = dv.getInt32(4 + i * 4, true);
    const pc = dv.getInt16(o + 20, true);
    const patches: TexturePatchRef[] = [];
    for (let k = 0; k < pc; k++) {
      const p = o + 22 + k * 10;
      patches.push({ originX: dv.getInt16(p, true), originY: dv.getInt16(p + 2, true), patch: pnames[dv.getInt16(p + 4, true)] ?? '' });
    }
    out.push({ name: name8(data, o), masked: dv.getInt32(o + 8, true), width: dv.getInt16(o + 12, true), height: dv.getInt16(o + 14, true), patches });
  }
  return out;
}

/** Writes PNAMES + TEXTURE1 for a set of texture definitions (patch names deduped in order). */
export function writeTextureLumps(defs: TextureDef[]): { pnames: Uint8Array; texture1: Uint8Array; patchNames: string[] } {
  const patchNames: string[] = [];
  const pidx = new Map<string, number>();
  for (const d of defs) for (const p of d.patches) if (!pidx.has(p.patch)) { pidx.set(p.patch, patchNames.length); patchNames.push(p.patch); }
  const pnames = new Uint8Array(4 + patchNames.length * 8);
  view(pnames).setInt32(0, patchNames.length, true);
  patchNames.forEach((n, i) => put8(pnames, 4 + i * 8, n));
  let size = 4 + defs.length * 4;
  for (const d of defs) size += 22 + d.patches.length * 10;
  const t = new Uint8Array(size);
  const dv = view(t);
  dv.setInt32(0, defs.length, true);
  let o = 4 + defs.length * 4;
  defs.forEach((d, i) => {
    dv.setInt32(4 + i * 4, o, true);
    put8(t, o, d.name);
    dv.setInt32(o + 8, d.masked, true);
    dv.setInt16(o + 12, d.width, true);
    dv.setInt16(o + 14, d.height, true);
    dv.setInt32(o + 16, 0, true);
    dv.setInt16(o + 20, d.patches.length, true);
    d.patches.forEach((p, k) => {
      const q = o + 22 + k * 10;
      dv.setInt16(q, p.originX, true);
      dv.setInt16(q + 2, p.originY, true);
      dv.setInt16(q + 4, pidx.get(p.patch)!, true);
      dv.setInt16(q + 6, 1, true);
      dv.setInt16(q + 8, 0, true);
    });
    o += 22 + d.patches.length * 10;
  });
  return { pnames, texture1: t, patchNames };
}
