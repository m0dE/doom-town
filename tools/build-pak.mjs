#!/usr/bin/env node
// Builds public/freedm-lite.wad: a PWAD with exactly what the game needs from FreeDM
// (BSD-3-Clause): palette, colormap, one map, the textures/patches/flats it uses (+ switch
// and animation partners, + the sky), every sprite the sim can show, the game's sounds,
// status bar / HUD font / title graphics. Output is deterministic (input order, no dates).
//
//   node tools/build-pak.mjs            (MAP from PAK_MAP below)
//   node tools/build-pak.mjs MAP07      (another map)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { Wad, buildWadFile, MAP_LUMPS } from '../src/wad/wad.ts';
import { parsePnames, parseTextureLump, writeTextureLumps } from '../src/wad/texturedefs.ts';
import { parseMap } from '../src/wad/mapdata.ts';
import { ANIMDEFS, SWITCHES, skyTextureForMap, SKY_FLAT } from '../src/wad/animdefs.ts';
import { THING_DEFS } from '../src/wad/things.ts';

/** The one place the pak's map is chosen (the sim's map constant is src/sim/map.ts). */
export const PAK_MAP = 'MAP19';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'assets', 'freedm.wad');
const OUT = join(ROOT, 'public', 'freedm-lite.wad');
const MAP = (process.argv[2] || PAK_MAP).toUpperCase();

if (!existsSync(SRC)) {
  console.error('assets/freedm.wad missing: run `npm run fetch` first');
  process.exit(1);
}
const wadBytes = new Uint8Array(readFileSync(SRC));
const wad = new Wad(wadBytes);

// ---- map ------------------------------------------------------------------
const mapLumps = wad.mapLumps(MAP);
const map = parseMap(MAP, mapLumps);

// ---- textures -------------------------------------------------------------
const pnames = parsePnames(wad.get('PNAMES'));
const allTex = [...parseTextureLump(wad.get('TEXTURE1'), pnames), ...(wad.get('TEXTURE2') ? parseTextureLump(wad.get('TEXTURE2'), pnames) : [])];
const texIndex = new Map(allTex.map((t, i) => [t.name, i]));
const wantTex = new Set();
const addTex = (n) => { if (n && n !== '-' && texIndex.has(n)) wantTex.add(n); };
for (const s of map.sides) { addTex(s.top); addTex(s.mid); addTex(s.bottom); }
addTex(skyTextureForMap(MAP));
for (const [a, b] of SWITCHES) { if (wantTex.has(a) || wantTex.has(b)) { addTex(a); addTex(b); } }
// animation ranges are by position in TEXTURE1: keep every texture between first and last
for (const a of ANIMDEFS.filter((d) => d.isTexture)) {
  const i0 = texIndex.get(a.first), i1 = texIndex.get(a.last);
  if (i0 === undefined || i1 === undefined) continue;
  let used = false;
  for (let i = i0; i <= i1; i++) if (wantTex.has(allTex[i].name)) used = true;
  if (used) for (let i = i0; i <= i1; i++) wantTex.add(allTex[i].name);
}
const missingTex = [];
for (const s of map.sides) for (const n of [s.top, s.mid, s.bottom]) if (n !== '-' && !texIndex.has(n)) missingTex.push(n);
const texDefs = allTex.filter((t) => wantTex.has(t.name)); // original order keeps anim ranges contiguous
const { pnames: pnamesOut, texture1, patchNames } = writeTextureLumps(texDefs);

// ---- flats ----------------------------------------------------------------
const flatNs = [...wad.namespace('F').keys()]; // namespace order
const flatPos = new Map(flatNs.map((n, i) => [n, i]));
const wantFlat = new Set([SKY_FLAT]);
for (const s of map.sectors) { wantFlat.add(s.floorPic); wantFlat.add(s.ceilPic); }
for (const a of ANIMDEFS.filter((d) => !d.isTexture)) {
  const i0 = flatPos.get(a.first), i1 = flatPos.get(a.last);
  if (i0 === undefined || i1 === undefined) continue;
  let used = false;
  for (let i = i0; i <= i1; i++) if (wantFlat.has(flatNs[i])) used = true;
  if (used) for (let i = i0; i <= i1; i++) wantFlat.add(flatNs[i]);
}
const flats = flatNs.filter((n) => wantFlat.has(n));

// ---- sprites --------------------------------------------------------------
const wantSprites = new Set([
  // players, effects, projectiles, weapon psprites
  'PLAY', 'PUFF', 'BLUD', 'TFOG', 'IFOG', 'MISL', 'PLSS', 'PLSE', 'BFS1', 'BFE1', 'BFE2',
  'PUNG', 'SAWG', 'PISG', 'PISF', 'SHTG', 'SHTF', 'SHT2', 'CHGG', 'CHGF', 'MISG', 'MISF', 'PLSG', 'PLSF', 'BFGG', 'BFGF',
  // weapons on the ground, ammo, health/armor, powerups (anything deathmatch can spawn)
  'CSAW', 'SHOT', 'SGN2', 'MGUN', 'LAUN', 'PLAS', 'BFUG',
  'CLIP', 'AMMO', 'SHEL', 'SBOX', 'ROCK', 'BROK', 'CELL', 'CELP', 'BPAK',
  'STIM', 'MEDI', 'BON1', 'BON2', 'ARM1', 'ARM2', 'SOUL', 'MEGA', 'PINV', 'PSTR', 'PINS', 'SUIT', 'PMAP', 'PVIS',
]);
const hasBarrel = map.things.some((t) => t.type === 2035);
if (hasBarrel) { wantSprites.add('BAR1'); wantSprites.add('BEXP'); }
const defByNum = new Map(THING_DEFS.map((d) => [d[0], d]));
for (const t of map.things) {
  const d = defByNum.get(t.type);
  if (d && d[0] !== 2035 && !(d[0] >= 3001 && d[0] <= 3006) && ![7, 9, 16, 58, 64, 65, 66, 67, 68, 69, 71, 72, 84, 88, 89].includes(d[0])) wantSprites.add(d[2]);
}
const sprites = [...wad.namespace('S').keys()].filter((n) => wantSprites.has(n.slice(0, 4)));

// ---- sounds ---------------------------------------------------------------
const SOUNDS = ['pistol', 'shotgn', 'sgcock', 'dshtgn', 'dbopn', 'dbcls', 'dbload', 'plasma', 'bfg', 'sawup', 'sawidl', 'sawful', 'sawhit',
  'rlaunc', 'rxplod', 'firxpl', 'pstart', 'pstop', 'doropn', 'dorcls', 'stnmov', 'swtchn', 'swtchx', 'plpain', 'slop', 'itemup', 'wpnup', 'oof',
  'telept', 'pldeth', 'pdiehi', 'noway', 'barexp', 'punch', 'tink', 'bdopn', 'bdcls', 'itmbk', 'getpow', 'radio'];
const sounds = SOUNDS.map((s) => 'DS' + s.toUpperCase()).filter((n) => wad.has(n));

// ---- status bar, HUD font, menu art ---------------------------------------
const UI = /^(STBAR|STARMS|STTNUM\d|STYSNUM\d|STGNUM\d|STTPRCNT|STTMINUS|STF\w+|STKEYS\d|STCFN\d\d\d|M_DOOM|M_SKULL[12]|TITLEPIC|INTERPIC)$/;
const ui = wad.lumps.filter((l) => UI.test(l.name) && l.source === 0).map((l) => l.name);

// ---- assemble -------------------------------------------------------------
const L = [];
const put = (name, data) => L.push({ name, data: data ?? new Uint8Array(0) });
const lump = (n) => { const d = wad.get(n); if (!d) throw new Error(`missing lump ${n}`); return d; };
put('PLAYPAL', lump('PLAYPAL'));
put('COLORMAP', lump('COLORMAP'));
put(MAP, null);
for (const n of MAP_LUMPS) if (mapLumps.has(n)) put(n, mapLumps.get(n));
put('PNAMES', pnamesOut);
put('TEXTURE1', texture1);
for (const n of sounds) put(n, lump(n));
for (const n of ui) put(n, lump(n));
put('S_START', null);
for (const n of sprites) put(n, wad.nsLump('S', n).data);
put('S_END', null);
put('P_START', null);
const missingPatch = [];
for (const n of patchNames) { const l = wad.nsLump('P', n); if (l) put(n, l.data); else missingPatch.push(n); }
put('P_END', null);
put('F_START', null);
for (const n of flats) put(n, wad.nsLump('F', n).data);
put('F_END', null);

const out = buildWadFile(L);
writeFileSync(OUT, out);
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log(`public/freedm-lite.wad: ${MAP}, ${texDefs.length} textures, ${patchNames.length} patches, ${flats.length} flats, ` +
  `${sprites.length} sprite lumps (${wantSprites.size} sprites), ${sounds.length} sounds, ${ui.length} ui lumps`);
console.log(`size ${kb(out.length)}  gzip ${kb(gzipSync(out, { level: 9 }).length)}  brotli ${kb(brotliCompressSync(out).length)}  sha256 ${createHash('sha256').update(out).digest('hex').slice(0, 16)}`);
if (missingTex.length) console.warn('textures not in TEXTURE1:', [...new Set(missingTex)].join(' '));
if (missingPatch.length) console.warn('patches missing:', missingPatch.join(' '));
