#!/usr/bin/env node
// Packs mods: one map + its art + MODINFO → one PWAD (DESIGN.md "Mods: one file per mod").
//
//   npm run mods                                  build every mod source dir (any dir under
//                                                 mods/ holding a MODINFO.json, e.g. mods/br01/,
//                                                 mods/examples/arena/) → public/mods/<id>.wad,
//                                                 then write public/mods/index.json
//   node tools/mods/pack.mjs mods/br01 [...]      build the given mod dirs (index refreshed)
//   node tools/mods/pack.mjs --modinfo M.json --map SRC [--art DIR] [--out FILE]
//                                                 pack one mod from loose files (no index);
//                                                 --art: a dir with textures/ flats/ textures.json;
//                                                 default out: public/mods/<id>.wad
//   options: --no-check   skip the map checks of map scripts (BSP / walkability; faster)
//            --no-index   don't touch public/mods/index.json
//
// A mod source dir holds MODINFO.json (format 1), README.md (credits, licence) and the map:
//   map.wad    a PWAD from any editor holding the map (nodes built; the map named as MODINFO
//              "map" says, or the only map in the file — it is renamed to MODINFO "map")
//   map.mts    a map script in our DSL (tools/maps/lib/canvas.mts): exports build(): PaintCanvas
//              (and optionally report(): string); compiled with our node builder and checked
//              like the war maps (tools/maps/build.mts compileMapModule)
// Optional custom art in the mod dir (tools/mods/customart.mjs): textures/*.png (patches; a PNG
// not defined in textures.json is also a wall texture of its own name and size), flats/*.png
// (64 x 64), textures.json (composite textures from the mod's and Freedoom's patches); PNGs are
// quantised to the PLAYPAL palette. Names are the file names, upper-cased, <= 8 chars.
// The packed file holds, in order: MODINFO (the JSON, normalised), the map marker + its lumps
// (THINGS LINEDEFS SIDEDEFS VERTEXES SEGS SSECTORS NODES SECTORS REJECT BLOCKMAP), then the
// art: PNAMES + TEXTURE1 defining every wall texture the map uses (and its sky, switch and
// animation partners), the patches and flats among those that public/freedm-lite.wad (the
// base pak) does not carry, between P_START/P_END and F_START/F_END. Textures resolve against
// Freedoom (assets/freedm.wad, then the Freedoom2 IWAD). Output is deterministic.
//
// API (for mod:check and other tools):
//   packMod({ modinfo, lumps, map, custom? }) → { bytes, info, stats }
//   customArtOf(dir) → custom art for packMod / mapFromScript (null when the dir has none)
//   mapFromWad(bytes, wantName) / mapFromScript(file, name, opts) → { lumps, map }
//   buildModDir(dir, opts) → index entry (writes public/mods/<id>.wad)
//   findModDirs(root?) / writeIndex(entries)
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Wad, buildWadFile, MAP_LUMPS } from '../../src/wad/wad.ts';
import { parsePnames, writeTextureLumps } from '../../src/wad/texturedefs.ts';
import { parseMap } from '../../src/wad/mapdata.ts';
import { ROOT, loadArtSources } from '../lib/art.mjs';
import { readCustomArt } from './customart.mjs';

export const MODS_SRC = join(ROOT, 'mods');
export const MODS_OUT = join(ROOT, 'public', 'mods');
export const BASE_PAK = join(ROOT, 'public', 'freedm-lite.wad');
const MODES = ['deathmatch', 'team-deathmatch', 'elimination', 'war', 'battle-royale'];

/** Minimal MODINFO validation (the full schema check is mod:check's); returns the normalised object. */
export function checkModinfo(o) {
  const errs = [];
  if (!o || typeof o !== 'object') throw new Error('MODINFO must be a JSON object');
  if (o.format !== 1) errs.push('format must be 1');
  if (typeof o.id !== 'string' || !/^[a-z0-9]{2,16}$/.test(o.id)) errs.push('id must be 2-16 of a-z 0-9');
  if (!MODES.includes(o.mode)) errs.push(`mode must be one of ${MODES.join(', ')}`);
  if (typeof o.map !== 'string' || !/^[A-Z0-9_]{1,8}$/.test(o.map)) errs.push('map must be an upper-case lump name of up to 8 characters (e.g. "BR01")');
  if (typeof o.title !== 'string' || !o.title) errs.push('title is required');
  if (o.slots !== undefined && !(Number.isInteger(o.slots) && o.slots >= 2 && o.slots <= 200)) errs.push('slots must be an integer 2..200');
  if (errs.length) throw new Error(`MODINFO ${o?.id ?? ''}: ${errs.join('; ')}`);
  return o;
}

let art = null;
const artSources = () => (art ??= loadArtSources());
let base = null;
const basePak = () => {
  if (!base) {
    if (!existsSync(BASE_PAK)) throw new Error('public/freedm-lite.wad missing: run `npm run pak` first');
    const w = new Wad(new Uint8Array(readFileSync(BASE_PAK)));
    base = { patches: new Set([...w.namespace('P').keys()].map((n) => n.toUpperCase())), flats: new Set(w.namespace('F').keys()) };
  }
  return base;
};

/** The map lumps of a PWAD: the map named `wantName`, or its only map. Returns { lumps, map }. */
export function mapFromWad(bytes, wantName) {
  const w = new Wad(bytes);
  const markers = w.lumps.map((l, i) => ({ l, i })).filter(({ i }) => w.lumps[i + 1]?.name === 'THINGS').map(({ l }) => l.name);
  const name = markers.includes(wantName) ? wantName : markers.length === 1 ? markers[0] : null;
  if (!name) throw new Error(markers.length ? `the WAD has maps ${markers.join(', ')}, none named ${wantName}` : 'the WAD has no map');
  const src = w.mapLumps(name);
  for (const n of ['NODES', 'SEGS', 'SSECTORS']) if (!src.get(n)?.length) throw new Error(`map ${name} has no ${n}: run a node builder (ZDBSP, ZenNode, glBSP; Ultimate Doom Builder builds them on save)`);
  const lumps = new Map(MAP_LUMPS.filter((n) => src.has(n)).map((n) => [n, src.get(n)]));
  return { lumps, map: parseMap(wantName, lumps) };
}

/** Compiles a map script (exports build()) with our node builder. Returns { lumps, map, errors }. */
export async function mapFromScript(file, name, { check = true, log = () => {}, custom = null } = {}) {
  const { compileMapModule } = await import('../maps/build.mts');
  const mod = await import(pathToFileURL(resolve(file)).href);
  if (typeof mod.build !== 'function') throw new Error(`${file} must export build(): PaintCanvas`);
  const extraTextures = new Map((custom?.textures ?? []).map((t) => [t.name, t.width]));
  const { lumps, map, errors } = compileMapModule(name, mod, { check, log, extraTextures, extraFlats: new Set(custom?.flats.keys() ?? []) });
  return { lumps: new Map(lumps.slice(1).map((l) => [l.name, l.data])), map, errors };
}

/** A mod dir's own art (PNG patches/flats + textures.json; tools/mods/customart.mjs), or null. */
export function customArtOf(dir) {
  const A = artSources();
  const pal = A.wad.get('PLAYPAL');
  const fdPatch = (n) => !!A.patchLump(n);
  return readCustomArt(dir, pal, fdPatch);
}

/**
 * Packs one mod. `lumps`: Map of the map's lumps (no marker), `map`: its parsed MapData,
 * `custom`: the mod's own art (customArtOf(dir)) or null.
 * Returns the WAD bytes, the normalised MODINFO and stats (art counts, missing names).
 */
export function packMod({ modinfo, lumps, map, custom = null }) {
  const info = checkModinfo(modinfo);
  const A = artSources(), B = basePak();
  const a = A.artOf(info.map, map);
  const ownTex = new Map((custom?.textures ?? []).map((t) => [t.name, t]));
  const ownFlats = custom?.flats ?? new Map();
  // the mod's own textures/flats: used ones are kept, the rest resolve against Freedoom
  const usedOwnTex = new Set(), usedOwnFlats = new Set();
  for (const s of map.sides) for (const n of [s.top, s.mid, s.bottom]) if (ownTex.has(n)) usedOwnTex.add(n);
  for (const s of map.sectors) for (const n of [s.floorPic, s.ceilPic]) if (ownFlats.has(n)) usedOwnFlats.add(n);
  const missing = [...a.missing].filter((n) => !ownTex.has(n) && !ownFlats.has(n));
  if (missing.length) throw new Error(`${info.id}: textures/flats neither in Freedoom nor the mod's own art: ${missing.join(' ')}`);
  // every texture the map uses is defined in the mod (later TEXTURE1s override by name:
  // identical definitions are harmless), so the mod does not depend on what base defines
  const defs = [...A.allTex.filter((t) => a.tex.has(t.name) && !ownTex.has(t.name)), ...(custom?.textures ?? [])];
  const { pnames, texture1 } = writeTextureLumps(defs);
  const patchOrder = parsePnames(pnames);
  const wantPatch = new Set([...a.patches, ...(custom?.freedoomPatches ?? [])]);
  const patches = patchOrder.filter((p) => !custom?.patches.has(p) && wantPatch.has(p.toUpperCase()) && !B.patches.has(p.toUpperCase()));
  const flats = A.orderFlats(new Set([...a.flats].filter((f) => !B.flats.has(f) && !ownFlats.has(f))));
  const missingPatch = new Set();
  const L = [{ name: 'MODINFO', data: new TextEncoder().encode(JSON.stringify(info, null, 2) + '\n') }];
  L.push({ name: info.map, data: new Uint8Array(0) });
  for (const n of MAP_LUMPS) if (lumps.has(n)) L.push({ name: n, data: lumps.get(n) });
  L.push({ name: 'PNAMES', data: pnames }, { name: 'TEXTURE1', data: texture1 });
  const artL = A.artLumps(patches, flats, missingPatch);
  if (custom && (custom.patches.size || ownFlats.size)) {
    // the mod's own patches go inside P_START..P_END, its flats inside F_START..F_END (sorted by name)
    const own = (ns, m) => [...m.keys()].sort().map((n) => ({ name: n, data: m.get(n) }));
    const insert = (start, end, items) => {
      if (!items.length) return;
      const e = artL.findIndex((l) => l.name === end);
      if (e >= 0) artL.splice(e, 0, ...items);
      else artL.push({ name: start, data: new Uint8Array(0) }, ...items, { name: end, data: new Uint8Array(0) });
    };
    insert('P_START', 'P_END', own('P', custom.patches));
    const fl = own('F', ownFlats);
    const fe = artL.findIndex((l) => l.name === 'F_END');
    if (fe >= 0) artL.splice(fe, 0, ...fl); else if (fl.length) artL.push({ name: 'F_START', data: new Uint8Array(0) }, ...fl, { name: 'F_END', data: new Uint8Array(0) });
  }
  L.push(...artL);
  if (missingPatch.size) throw new Error(`${info.id}: patches missing from Freedoom: ${[...missingPatch].join(' ')}`);
  const bytes = buildWadFile(L);
  return { bytes, info, stats: { textures: defs.length, patches: patches.length + (custom?.patches.size ?? 0), flats: flats.length + ownFlats.size, ownTextures: custom?.textures.length ?? 0, lines: map.lines.length, sectors: map.sectors.length, things: map.things.length } };
}

/** Builds mods/<...>/<dir> → public/mods/<id>.wad; returns its index entry. */
export async function buildModDir(dir, { check = true, log = console.log } = {}) {
  const modinfo = JSON.parse(readFileSync(join(dir, 'MODINFO.json'), 'utf8'));
  checkModinfo(modinfo);
  const custom = customArtOf(dir);
  let src;
  if (existsSync(join(dir, 'map.wad'))) src = mapFromWad(new Uint8Array(readFileSync(join(dir, 'map.wad'))), modinfo.map);
  else if (existsSync(join(dir, 'map.mts'))) {
    src = await mapFromScript(join(dir, 'map.mts'), modinfo.map, { check, log, custom });
    if (src.errors.length) throw new Error(`${modinfo.id}: the map has problems:\n  ${src.errors.slice(0, 20).join('\n  ')}`);
  } else throw new Error(`${relative(ROOT, dir)}: no map.wad or map.mts`);
  const { bytes, info, stats } = packMod({ modinfo, ...src, custom });
  mkdirSync(MODS_OUT, { recursive: true });
  const out = join(MODS_OUT, `${info.id}.wad`);
  writeFileSync(out, bytes);
  log(`${relative(ROOT, out)}: ${(bytes.length / 1024).toFixed(0)} KB — ${stats.lines} lines, ${stats.sectors} sectors, ${stats.things} things; ${stats.textures} texture defs${stats.ownTextures ? ` (${stats.ownTextures} the mod's own)` : ''}, ${stats.patches} patches and ${stats.flats} flats beyond the base pak`);
  if (bytes.length > 4 * 1024 * 1024) log(`  warning: ${info.id} is over 4 MB (mod:check rejects it)`);
  return indexEntry(info, bytes.length);
}

export const indexEntry = (info, bytes) => ({ id: info.id, title: info.title, author: info.author ?? 'unknown', mode: info.mode, map: info.map, slots: info.slots ?? 64, bytes, description: info.description ?? '' });

/** Every directory under `root` (two levels deep) holding a MODINFO.json, sorted. */
export function findModDirs(root = MODS_SRC) {
  const out = [];
  const walk = (d, depth) => {
    if (!existsSync(d)) return;
    if (existsSync(join(d, 'MODINFO.json'))) { out.push(d); return; }
    if (depth >= 2) return;
    for (const n of readdirSync(d).sort()) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p, depth + 1); }
  };
  walk(root, 0);
  return out;
}

/** public/mods/index.json: the given entries merged over the existing ones (by id), sorted with br01 first. */
export function writeIndex(entries, { replace = false } = {}) {
  const file = join(MODS_OUT, 'index.json');
  const byId = new Map();
  if (!replace && existsSync(file)) for (const e of JSON.parse(readFileSync(file, 'utf8'))) if (existsSync(join(MODS_OUT, `${e.id}.wad`))) byId.set(e.id, e);
  for (const e of entries) byId.set(e.id, e);
  const list = [...byId.values()].sort((a, b) => (a.id === 'br01' ? -1 : b.id === 'br01' ? 1 : a.id.localeCompare(b.id)));
  mkdirSync(MODS_OUT, { recursive: true });
  writeFileSync(file, JSON.stringify(list, null, 2) + '\n');
  return list;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const check = !args.includes('--no-check');
  try {
    if (opt('--modinfo')) {
      const modinfo = JSON.parse(readFileSync(opt('--modinfo'), 'utf8'));
      const mapSrc = opt('--map');
      if (!mapSrc) throw new Error('--map map.wad|map.mts is required with --modinfo');
      const custom = opt('--art') ? customArtOf(opt('--art')) : null;
      const src = /\.m?[jt]s$/.test(mapSrc) ? await mapFromScript(mapSrc, modinfo.map, { check, log: console.log, custom }) : mapFromWad(new Uint8Array(readFileSync(mapSrc)), modinfo.map);
      if (src.errors?.length) throw new Error(`the map has problems:\n  ${src.errors.slice(0, 20).join('\n  ')}`);
      const { bytes, info, stats } = packMod({ modinfo, ...src, custom });
      const out = opt('--out') ?? join(MODS_OUT, `${info.id}.wad`);
      mkdirSync(resolve(out, '..'), { recursive: true });
      writeFileSync(out, bytes);
      console.log(`${out}: ${(bytes.length / 1024).toFixed(0)} KB, ${stats.textures} texture defs, ${stats.patches} patches, ${stats.flats} flats beyond the base pak`);
    } else {
      const named = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && ['--out', '--map', '--modinfo', '--art'].includes(args[i - 1])));
      const dirs = named.length ? named.map((d) => resolve(d)) : findModDirs();
      if (!dirs.length) throw new Error('no mod sources found (mods/*/MODINFO.json)');
      const entries = [];
      for (const d of dirs) entries.push(await buildModDir(d, { check }));
      if (!args.includes('--no-index')) {
        const list = writeIndex(entries, { replace: !named.length });
        console.log(`public/mods/index.json: ${list.map((e) => e.id).join(', ')}`);
      }
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
