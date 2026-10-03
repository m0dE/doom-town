#!/usr/bin/env node
// Builds the game data paks from FreeDM (BSD-3-Clause) and our generated war maps:
//
//   public/freedm-lite.wad   base pak: PLAYPAL, COLORMAP, every sprite the sim can show
//                            (+ every decoration any shipped map uses), the game's sounds,
//                            status bar / HUD font / title graphics, PNAMES + TEXTURE1
//                            defining every wall texture any shipped map uses (definitions
//                            are tiny), the map lumps of EVERY shipped map, and the art
//                            (patches + flats) of BASE_ART_MAP so the default map needs
//                            nothing else.
//   public/maps/<MAP>.wad    per-map art pak: the patches and flats that map needs beyond
//                            the base (with animation / switch partners and its sky).
//   public/maps/index.json   rotations, titles, skies, pak sizes.
//
// Load order for a map: base, then public/maps/<MAP>.wad merged over it by lump name
// (src/wad/wad.ts `Wad.add`). Output is deterministic (input order, no dates).
//
//   node tools/build-pak.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildWadFile, MAP_LUMPS } from '../src/wad/wad.ts';
import { parsePnames, writeTextureLumps } from '../src/wad/texturedefs.ts';
import { parseMap } from '../src/wad/mapdata.ts';
import { skyTextureForMap } from '../src/wad/animdefs.ts';
import { THING_DEFS } from '../src/wad/things.ts';
import { compileWarMap } from './maps/build.mts';
import { ROOT, loadArtSources } from './lib/art.mjs';

/**
 * Map rotations per mode (DESIGN.md "Modes, teams and map rotation"). Battle royale's BR01
 * is not here: it ships as a mod, public/mods/br01.wad (tools/mods/pack.mjs, `npm run mods`).
 */
export const ROTATIONS = {
  deathmatch: ['MAP19', 'MAP24', 'MAP20', 'MAP30', 'MAP27', 'MAP32'],
  teamDeathmatch: ['MAP19', 'MAP24', 'MAP20', 'MAP30', 'MAP27', 'MAP32'],
  elimination: ['MAP11', 'MAP05', 'MAP18', 'MAP17'],
  war: ['WAR01', 'WAR02'],
};
/** The map whose art ships inside the base pak (the first deathmatch map). */
export const BASE_ART_MAP = 'MAP19';

const OUT = join(ROOT, 'public', 'freedm-lite.wad');
const MAPS_DIR = join(ROOT, 'public', 'maps');

const { wad, allTex, artOf, artLumps: artLumpsOf, orderFlats } = loadArtSources();

// ---- maps -----------------------------------------------------------------
const SHIPPED = [...new Set(Object.values(ROTATIONS).flat())];
/** name → { lumps: Map<lumpName, bytes>, map: MapData } */
const maps = new Map();
for (const name of SHIPPED) {
  if (/^MAP\d\d$/.test(name)) {
    const lumps = wad.mapLumps(name);
    maps.set(name, { lumps, map: parseMap(name, lumps) });
  } else {
    const { lumps, map, errors } = compileWarMap(name);
    if (errors.length) { console.error(`${name}: ${errors.join('\n  ')}`); process.exit(1); }
    maps.set(name, { lumps: new Map(lumps.slice(1).map((l) => [l.name, l.data])), map });
  }
}

// ---- titles (FreeDM's DEHACKED HUSTR_n) --------------------------------------
const titles = {};
for (const line of new TextDecoder('latin1').decode(wad.get('DEHACKED') ?? new Uint8Array(0)).split('\n')) {
  const m = /^HUSTR_(\d+) = (.*)$/.exec(line.trim());
  if (m) titles[`MAP${m[1].padStart(2, '0')}`] = m[2].trim();
}
const WAR_TITLES = { WAR01: 'WAR01: Nukage Front', WAR02: 'WAR02: Canal City' };

// ---- art per map (tools/lib/art.mjs) ----------------------------------------
const art = new Map([...maps].map(([n, m]) => [n, artOf(n, m.map)]));

// union of all textures, in the original order (animation ranges stay contiguous)
const allWant = new Set();
for (const a of art.values()) for (const t of a.tex) allWant.add(t);
const texDefs = allTex.filter((t) => allWant.has(t.name));
const { pnames: pnamesOut, texture1 } = writeTextureLumps(texDefs);

// ---- sprites --------------------------------------------------------------
const wantSprites = new Set([
  // players, effects, projectiles, weapon psprites
  'PLAY', 'PUFF', 'BLUD', 'TFOG', 'IFOG', 'MISL', 'PLSS', 'PLSE', 'BFS1', 'BFE1', 'BFE2',
  'PUNG', 'SAWG', 'PISG', 'PISF', 'SHTG', 'SHTF', 'SHT2', 'CHGG', 'CHGF', 'MISG', 'MISF', 'PLSG', 'PLSF', 'BFGG', 'BFGF',
  // weapons on the ground, ammo, health/armor, powerups (anything deathmatch can spawn)
  'CSAW', 'SHOT', 'SGN2', 'MGUN', 'LAUN', 'PLAS', 'BFUG',
  'CLIP', 'AMMO', 'SHEL', 'SBOX', 'ROCK', 'BROK', 'CELL', 'CELP', 'BPAK',
  'STIM', 'MEDI', 'BON1', 'BON2', 'ARM1', 'ARM2', 'SOUL', 'MEGA', 'PINV', 'PSTR', 'PINS', 'SUIT', 'PMAP', 'PVIS',
  // random bosses (DESIGN.md "Random bosses"): Cyberdemon, Spider Mastermind (rockets = MISL, bullets = PUFF)
  'CYBR', 'SPID',
]);
const MONSTERS = [7, 9, 16, 58, 64, 65, 66, 67, 68, 69, 71, 72, 84, 88, 89];
const defByNum = new Map(THING_DEFS.map((d) => [d[0], d]));
for (const { map } of maps.values()) {
  for (const t of map.things) {
    if (t.type === 2035) { wantSprites.add('BAR1'); wantSprites.add('BEXP'); continue; }
    const d = defByNum.get(t.type);
    if (d && !(d[0] >= 3001 && d[0] <= 3006) && !MONSTERS.includes(d[0])) wantSprites.add(d[2]);
  }
}
// The bosses' sprites are most of a megabyte and only boss rooms show them: they ship
// in their own pak (public/maps/BOSSES.wad), fetched by boss rooms alone.
const BOSS_SPRITES = new Set(['CYBR', 'SPID']);
const sprites = [...wad.namespace('S').keys()].filter((n) => wantSprites.has(n.slice(0, 4)) && !BOSS_SPRITES.has(n.slice(0, 4)));
const bossSprites = [...wad.namespace('S').keys()].filter((n) => BOSS_SPRITES.has(n.slice(0, 4)));

// ---- sounds ---------------------------------------------------------------
const SOUNDS = ['pistol', 'shotgn', 'sgcock', 'dshtgn', 'dbopn', 'dbcls', 'dbload', 'plasma', 'bfg', 'sawup', 'sawidl', 'sawful', 'sawhit',
  'rlaunc', 'rxplod', 'firxpl', 'pstart', 'pstop', 'doropn', 'dorcls', 'stnmov', 'swtchn', 'swtchx', 'plpain', 'slop', 'itemup', 'wpnup', 'oof',
  'telept', 'pldeth', 'pdiehi', 'noway', 'barexp', 'punch', 'tink', 'bdopn', 'bdcls', 'itmbk', 'getpow', 'radio',
  // random bosses: sight / death / active / pain, footsteps (vanilla info.c sounds of the two)
  'cybsit', 'cybdth', 'spisit', 'spidth', 'dmact', 'dmpain', 'hoof', 'metal', 'bspact', 'bspwlk'];
const sounds = SOUNDS.map((s) => 'DS' + s.toUpperCase()).filter((n) => wad.has(n));

// ---- status bar, HUD font, menu art ---------------------------------------
const UI = /^(STBAR|STARMS|STTNUM\d|STYSNUM\d|STGNUM\d|STTPRCNT|STTMINUS|STF\w+|STKEYS\d|STCFN\d\d\d|M_DOOM|M_SKULL[12]|TITLEPIC|INTERPIC)$/;
const ui = wad.lumps.filter((l) => UI.test(l.name) && l.source === 0).map((l) => l.name);

// ---- assemble the base ----------------------------------------------------
const lump = (n) => { const d = wad.get(n); if (!d) throw new Error(`missing lump ${n}`); return d; };
const baseArt = art.get(BASE_ART_MAP);
const missingPatch = new Set();
const artLumps = (patchNames, flatNames) => artLumpsOf(patchNames, flatNames, missingPatch);
// patches in PNAMES order, flats in namespace order (animation ranges contiguous per pak)
const patchOrder = parsePnames(pnamesOut);
const orderPatches = (set) => patchOrder.filter((p) => set.has(p.toUpperCase()));

const L = [];
const put = (name, data) => L.push({ name, data: data ?? new Uint8Array(0) });
put('PLAYPAL', lump('PLAYPAL'));
put('COLORMAP', lump('COLORMAP'));
// Map lumps are not in the base: each map's are in public/maps/<MAP>.map.wad, and a
// room fetches only its own rotation's (the sim needs every map of it from the start).
put('PNAMES', pnamesOut);
put('TEXTURE1', texture1);
for (const n of sounds) put(n, lump(n));
for (const n of ui) put(n, lump(n));
put('S_START', null);
for (const n of sprites) put(n, wad.nsLump('S', n).data);
put('S_END', null);
L.push(...artLumps(orderPatches(baseArt.patches), orderFlats(baseArt.flats)));
const base = buildWadFile(L);
writeFileSync(OUT, base);

// ---- per-map art paks -----------------------------------------------------
mkdirSync(MAPS_DIR, { recursive: true });
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
const gz = (b) => gzipSync(b, { level: 9 }).length;
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);
console.log(`public/freedm-lite.wad: ${maps.size} maps, ${texDefs.length} texture defs, base art = ${BASE_ART_MAP} (${baseArt.patches.size} patches, ${baseArt.flats.size} flats), ` +
  `${sprites.length} sprite lumps (${wantSprites.size} sprites), ${sounds.length} sounds, ${ui.length} ui lumps`);
console.log(`  size ${kb(base.length)}  gzip ${kb(gz(base))}  sha256 ${sha(base)}`);
const index = { base: 'freedm-lite.wad', baseBytes: base.length, baseArtMap: BASE_ART_MAP, rotations: ROTATIONS, maps: {} };
let totalPak = 0, totalPakGz = 0;
for (const [name, a] of art) {
  const patches = orderPatches(new Set([...a.patches].filter((p) => !baseArt.patches.has(p))));
  const flats = orderFlats(new Set([...a.flats].filter((f) => !baseArt.flats.has(f))));
  const pak = buildWadFile(artLumps(patches, flats));
  writeFileSync(join(MAPS_DIR, `${name}.wad`), pak);
  const { map } = maps.get(name);
  index.maps[name] = {
    title: titles[name] ?? WAR_TITLES[name] ?? name, sky: skyTextureForMap(name), pak: `maps/${name}.wad`, pakBytes: pak.length,
    textures: a.tex.size, flats: a.flats.size, lines: map.lines.length, sectors: map.sectors.length,
  };
  totalPak += pak.length; totalPakGz += gz(pak);
  console.log(`public/maps/${name}.wad: ${patches.length} patches, ${flats.length} flats beyond the base — size ${kb(pak.length)}  gzip ${kb(gz(pak))}  sha256 ${sha(pak)}` +
    (a.missing.size ? `  MISSING: ${[...a.missing].join(' ')}` : ''));
}
// ---- per-map lump paks (what the sim and the renderer read the map from) -----------
let totalLumps = 0, totalLumpsGz = 0;
for (const [name, { lumps }] of maps) {
  const ML = [{ name, data: new Uint8Array(0) }];
  for (const n of MAP_LUMPS) if (lumps.has(n)) ML.push({ name: n, data: lumps.get(n) });
  const pak = buildWadFile(ML);
  writeFileSync(join(MAPS_DIR, `${name}.map.wad`), pak);
  if (index.maps[name]) { index.maps[name].mapPak = `maps/${name}.map.wad`; index.maps[name].mapPakBytes = pak.length; }
  totalLumps += pak.length; totalLumpsGz += gz(pak);
}
console.log(`map lump paks total ${kb(totalLumps)}  gzip ${kb(totalLumpsGz)}`);
// ---- the bosses' sprites -------------------------------------------------------------
{
  const BL = [{ name: 'S_START', data: new Uint8Array(0) }];
  for (const n of bossSprites) BL.push({ name: n, data: wad.nsLump('S', n).data });
  BL.push({ name: 'S_END', data: new Uint8Array(0) });
  const pak = buildWadFile(BL);
  writeFileSync(join(MAPS_DIR, 'BOSSES.wad'), pak);
  index.bosses = { pak: 'maps/BOSSES.wad', bytes: pak.length };
  console.log(`public/maps/BOSSES.wad: ${bossSprites.length} sprite lumps — size ${kb(pak.length)}  gzip ${kb(gz(pak))}`);
}
writeFileSync(join(MAPS_DIR, 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`map paks total ${kb(totalPak)}  gzip ${kb(totalPakGz)}; public/maps/index.json`);
if (missingPatch.size) console.warn('patches missing:', [...missingPatch].join(' '));
