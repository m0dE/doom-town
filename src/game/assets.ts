/**
 * The two downloads a match needs - the sim (doomsim.wasm) and the game data
 * (freedm-lite.wad) - started once, from the start screen, so Play is instant.
 *
 * Everything else asks for the same promises; nothing is fetched twice.
 */
import { DoomSim } from '../sim/doomsim.js';
import { compileSim } from '../sim/abi.js';
import { Wad, isArtLump, loadWad as openWad } from '../wad/index.js';
import { mapPwad } from '../sim/pwad.js';
import { ROTATIONS, checkIndex, type RotationKey } from '../sim/maps.js';

const base = (): string => (import.meta.env?.BASE_URL ?? './');

let wadP: Promise<Wad> | null = null;
let baseBytes: Uint8Array | null = null;
let moduleP: Promise<WebAssembly.Module> | null = null;
const sims = new Map<RotationKey, Promise<DoomSim>>();
const arts = new Map<string, Promise<Uint8Array | null>>();
const listeners = new Set<(label: string, frac: number) => void>();
const progress = { wad: 0, sim: 0 };
/** A player's own DOOM2.WAD (art only), merged over the game's; see src/wad/wad.ts `loadWad`. */
let userWad: Uint8Array | null = null;
export function setUserWad(bytes: Uint8Array | null): void { userWad = bytes; wadP = null; }

function report(): void {
  const frac = (progress.wad * 0.8 + progress.sim * 0.2);
  for (const l of listeners) l(frac >= 1 ? 'Ready' : 'Loading game data', frac);
}

export function onAssetProgress(cb: (label: string, frac: number) => void): () => void {
  listeners.add(cb);
  report();
  return () => { listeners.delete(cb); };
}

async function fetchBytes(url: string, onFrac: (f: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) { const b = new Uint8Array(await res.arrayBuffer()); onFrac(1); return b; }
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > out.length) {
      // A content-length that lied (a compressed transfer): fall back to growing.
      const grown = new Uint8Array(Math.max(out.length * 2, at + value.length));
      grown.set(out.subarray(0, at));
      grown.set(value, at);
      at += value.length;
      return finishGrow(reader, grown, at, onFrac);
    }
    out.set(value, at);
    at += value.length;
    onFrac(Math.min(0.99, at / total));
  }
  onFrac(1);
  return at === out.length ? out : out.subarray(0, at);
}

async function finishGrow(reader: ReadableStreamDefaultReader<Uint8Array>, buf: Uint8Array, at: number, onFrac: (f: number) => void): Promise<Uint8Array> {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > buf.length) { const g = new Uint8Array(Math.max(buf.length * 2, at + value.length)); g.set(buf.subarray(0, at)); buf = g; }
    buf.set(value, at);
    at += value.length;
  }
  onFrac(1);
  return buf.subarray(0, at);
}

/** The game's WAD. In a dev server without the built pak, the full FreeDM IWAD from assets/. */
export function loadWad(): Promise<Wad> {
  wadP ??= (async () => {
    const urls = [`${base()}freedm-lite.wad`];
    if (import.meta.env?.DEV) urls.push('/assets/freedm.wad');
    let last: unknown = null;
    for (const url of urls) {
      try {
        const bytes = await fetchBytes(url, (f) => { progress.wad = f; report(); });
        baseBytes = bytes;
        const wad = openWad(bytes, userWad);
        progress.wad = 1; report();
        return wad;
      } catch (err) { last = err; }
    }
    wadP = null;
    throw new Error(`could not load the game data: ${last instanceof Error ? last.message : String(last)}`);
  })();
  return wadP;
}

/**
 * The sim with one rotation's maps loaded (in rotation order, so every client numbers
 * them alike). The module is compiled once; each rotation gets its own instance.
 */
export function loadSim(rotation: RotationKey = 'deathmatch', onMap?: (i: number, n: number) => void): Promise<DoomSim> {
  let p = sims.get(rotation);
  if (!p) {
    p = (async () => {
      moduleP ??= compileSim(fetch(`${base()}doomsim.wasm`)).catch((err) => { moduleP = null; throw err; });
      const [module, wad] = await Promise.all([moduleP, loadWad()]);
      const maps = ROTATIONS[rotation].map((name) => ({ name, pwad: mapPwad(wad, name) }));
      const sim = await DoomSim.create(module, maps, onMap);
      progress.sim = 1; report();
      return sim;
    })().catch((err) => { sims.delete(rotation); throw err; });
    sims.set(rotation, p);
  }
  return p;
}

/** A map's art pak (public/maps/<MAP>.wad), fetched once; null when there is none. */
export function fetchMapArt(map: string): Promise<Uint8Array | null> {
  let p = arts.get(map);
  if (!p) {
    p = fetch(`${base()}maps/${map}.wad`).then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null)).catch(() => null);
    arts.set(map, p);
  }
  return p;
}

/** The game data with a map's art merged over the base (a fresh Wad: the renderer's per-map assets). */
export async function mapWad(map: string): Promise<Wad> {
  const base0 = await loadWad();
  const art = await fetchMapArt(map);
  if (!art || art.length <= 12 || !baseBytes) return base0;
  const w = new Wad(baseBytes);
  w.add(art);
  if (userWad) w.add(userWad, isArtLump);
  return w;
}

/** maps/index.json, for a consistency check against src/sim/maps.ts (dev aid). */
export function checkMapIndex(): void {
  void fetch(`${base()}maps/index.json`).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) checkIndex(j); }).catch(() => { /* optional */ });
}

/** Kick both off; errors surface when Play awaits them. */
export function prefetch(): void {
  void loadWad().catch(() => { /* reported at Play */ });
  void loadSim('deathmatch').catch(() => { /* reported at Play */ });
}
