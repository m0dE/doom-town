// WAD container reader. No imports: node tools (build-pak) import this file directly.
//
// A `Wad` is an ordered list of lumps from one or more WAD files; lookups by name
// return the LAST match, so later files override earlier ones (PWAD semantics).

export interface Lump {
  name: string;
  data: Uint8Array;
  /** which loaded file the lump came from (0 = base) */
  source: number;
}

export type Namespace = 'S' | 'F' | 'P';

const dec = new TextDecoder('latin1');

export function lumpName(bytes: Uint8Array, off: number): string {
  let end = off;
  while (end < off + 8 && bytes[end] !== 0) end++;
  return dec.decode(bytes.subarray(off, end)).toUpperCase();
}

export function parseWadFile(bytes: Uint8Array, source = 0): Lump[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dec.decode(bytes.subarray(0, 4));
  if (magic !== 'IWAD' && magic !== 'PWAD') throw new Error(`not a WAD (${JSON.stringify(magic)})`);
  const count = dv.getInt32(4, true);
  const dir = dv.getInt32(8, true);
  const lumps: Lump[] = [];
  for (let i = 0; i < count; i++) {
    const p = dir + i * 16;
    const pos = dv.getInt32(p, true);
    const size = dv.getInt32(p + 4, true);
    lumps.push({ name: lumpName(bytes, p + 8), data: bytes.subarray(pos, pos + size), source });
  }
  return lumps;
}

const NS_MARKERS: Record<Namespace, [RegExp, RegExp]> = {
  S: [/^S?S_START$/, /^S?S_END$/],
  F: [/^F?F_START$/, /^F?F_END$/],
  P: [/^P?P_START$/, /^P?P_END$/],
};

export class Wad {
  readonly lumps: Lump[] = [];
  private byName = new Map<string, number>();
  private ns: Record<Namespace, Map<string, Lump>> = { S: new Map(), F: new Map(), P: new Map() };
  private sources = 0;

  constructor(...files: Uint8Array[]) {
    for (const f of files) this.add(f);
  }

  /** Appends a WAD file; its lumps override earlier ones by name. */
  add(bytes: Uint8Array, filter?: (name: string, ns: Namespace | null) => boolean): void {
    const src = this.sources++;
    let cur: Namespace | null = null;
    for (const l of parseWadFile(bytes, src)) {
      let marker = false;
      for (const k of ['S', 'F', 'P'] as Namespace[]) {
        if (NS_MARKERS[k][0].test(l.name)) { cur = k; marker = true; }
        else if (NS_MARKERS[k][1].test(l.name)) { cur = null; marker = true; }
      }
      if (/^[FP][123]_(START|END)$/.test(l.name)) marker = true;
      if (marker) continue;
      if (filter && !filter(l.name, cur)) continue;
      this.lumps.push(l);
      this.byName.set(l.name, this.lumps.length - 1);
      if (cur && l.data.length) this.ns[cur].set(l.name, l);
    }
  }

  has(name: string): boolean { return this.byName.has(name.toUpperCase()); }
  get(name: string): Uint8Array | null {
    const i = this.byName.get(name.toUpperCase());
    return i === undefined ? null : this.lumps[i].data;
  }
  lump(name: string): Lump | null {
    const i = this.byName.get(name.toUpperCase());
    return i === undefined ? null : this.lumps[i];
  }
  /** Lump inside a namespace (sprites S, flats F, patches P), falling back to the global name. */
  nsLump(ns: Namespace, name: string): Lump | null {
    return this.ns[ns].get(name.toUpperCase()) ?? (ns === 'P' ? this.lump(name) : null);
  }
  namespace(ns: Namespace): Map<string, Lump> { return this.ns[ns]; }
  /** All lumps with this name, in load order (e.g. TEXTURE1 from each file). */
  all(name: string): Lump[] { return this.lumps.filter((l) => l.name === name); }

  /** Lumps of a map: the marker and the following map lumps (THINGS..BLOCKMAP). */
  mapLumps(map: string): Map<string, Uint8Array> {
    const idx = this.byName.get(map.toUpperCase());
    if (idx === undefined) throw new Error(`map ${map} not found`);
    const out = new Map<string, Uint8Array>();
    for (let i = idx + 1; i < this.lumps.length && i <= idx + 11; i++) {
      const n = this.lumps[i].name;
      if (!MAP_LUMPS.includes(n) || out.has(n)) break;
      out.set(n, this.lumps[i].data);
    }
    return out;
  }
}

export const MAP_LUMPS = ['THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS', 'SSECTORS', 'NODES', 'SECTORS', 'REJECT', 'BLOCKMAP', 'BEHAVIOR'];

/** Lumps a user's own IWAD may override: art and sounds, never maps or game data. */
export function isArtLump(name: string, ns: Namespace | null): boolean {
  if (ns) return true;
  if (MAP_LUMPS.includes(name) || /^(MAP\d\d|E\dM\d)$/.test(name)) return false;
  return /^(PLAYPAL|COLORMAP|TEXTURE[12]|PNAMES|DS\w+|ST\w+|M_\w+|WI\w+|TITLEPIC|INTERPIC|CWILV\d\d|AMMNUM\d|BRDR\w+)$/.test(name);
}

/**
 * Loads the game's WAD, optionally merging a user-supplied DOOM2.WAD (kept in the
 * browser) over it by lump name — art only (textures, flats, sprites, patches,
 * sounds, status bar and menu graphics, palette). Maps stay the game's.
 */
export function loadWad(base: Uint8Array, userOverride?: Uint8Array | null): Wad {
  const w = new Wad(base);
  if (userOverride) w.add(userOverride, isArtLump);
  return w;
}

/** Builds a PWAD file from lumps (deterministic: no timestamps, fixed layout). */
export function buildWadFile(lumps: { name: string; data: Uint8Array }[], kind: 'PWAD' | 'IWAD' = 'PWAD'): Uint8Array {
  let size = 12;
  for (const l of lumps) size += l.data.length;
  const dirOff = size;
  size += lumps.length * 16;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = kind.charCodeAt(i);
  dv.setInt32(4, lumps.length, true);
  dv.setInt32(8, dirOff, true);
  let pos = 12;
  lumps.forEach((l, i) => {
    out.set(l.data, pos);
    const d = dirOff + i * 16;
    dv.setInt32(d, l.data.length ? pos : 0, true);
    dv.setInt32(d + 4, l.data.length, true);
    for (let k = 0; k < 8; k++) out[d + 8 + k] = k < l.name.length ? l.name.charCodeAt(k) : 0;
    pos += l.data.length;
  });
  return out;
}
