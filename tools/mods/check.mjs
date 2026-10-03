#!/usr/bin/env node
// Checks a mod file before it is submitted (DESIGN.md "Mods: one file per mod").
//
//   npm run mod:check public/mods/arena.wad          one or more files
//   npm run mod:check -- --all                        every public/mods/*.wad
//   npm run mod:check -- my.wad --seconds=30          shorter bot run
//   npm run mod:check -- my.wad --no-sim              skip the bot run
//   npm run mod:check -- my.wad --verbose             also list the rules block sent to the sim
//   npm run mod:check -- my.wad --wasm=other.wasm     run another build of the sim
//
// What it checks, in order, with a friendly report and exit code 1 on any error:
//   1. the file: a PWAD, at most 4 MB, only lumps a mod may carry
//   2. MODINFO: valid JSON, every field and rule (types, ranges, mode fit), the licence
//   3. the id: format, not taken by another installed mod (public/mods/index.json)
//   4. the map: exactly one, named as MODINFO says, nodes built, sane references
//   5. things: every type known; what the mode needs (starts, team starts, points, ...)
//   6. art: every wall texture and flat resolves against the base pak + the mod's own art
//   7. the sim: public/doomsim.wasm loads the map and plays 60 s with bots (no panic,
//      tic cost, kills, deterministic after a snapshot round trip)
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Wad, parseWadFile } from '../../src/wad/wad.ts';
import { parsePnames, parseTextureLump } from '../../src/wad/texturedefs.ts';
import { parseMap, NF_SUBSECTOR } from '../../src/wad/mapdata.ts';
import { THING_DEFS } from '../../src/wad/things.ts';
import { LOOT_ROWS, MOD_MODES, MAX_ZONE_STAGES, rulesBlock } from '../../src/mods/modinfo.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MAX_BYTES = 4 * 1024 * 1024;

/** Licences a mod may use (SPDX ids): GPL-2.0-compatible, or permissive data licences. */
export const LICENSES = {
  'GPL-2.0-only': 'GNU GPL 2.0', 'GPL-2.0-or-later': 'GNU GPL 2.0 or later',
  'BSD-3-Clause': 'BSD 3-clause (Freedoom\'s licence)', 'BSD-2-Clause': 'BSD 2-clause', 'MIT': 'MIT',
  'CC0-1.0': 'Creative Commons Zero (public domain)', 'CC-BY-4.0': 'Creative Commons Attribution 4.0',
  'CC-BY-3.0': 'Creative Commons Attribution 3.0',
};
const LICENSE_HINTS = {
  'GPL-2.0': 'GPL-2.0-only', 'GPL2': 'GPL-2.0-only', 'GPLV2': 'GPL-2.0-only', 'BSD': 'BSD-3-Clause', 'BSD3': 'BSD-3-Clause',
  'CC0': 'CC0-1.0', 'PUBLIC DOMAIN': 'CC0-1.0', 'CC-BY': 'CC-BY-4.0', 'CC BY': 'CC-BY-4.0', 'CC BY 4.0': 'CC-BY-4.0',
};
const LICENSE_REFUSED = {
  'GPL-3.0': 'GPL-3.0 cannot be combined with id\'s GPL-2.0-only engine code',
  'CC-BY-SA': 'share-alike terms are not compatible with the GPL-2.0 game',
  'CC-BY-NC': 'non-commercial terms are not allowed (nobody could redistribute the game freely)',
  'CC-BY-ND': 'no-derivatives terms are not allowed',
};

/** Thing types a mod map may use beyond Doom's own (DESIGN.md). */
export const OUR_THINGS = {
  9000: 'red team start', 9001: 'blue team start', 9010: 'capture point (angle = radius / 8)',
  9020: 'loot crate', 9030: 'lobby spot (battle royale)', 9040: 'buggy (battle royale)',
  9050: 'sniper rifle', 9051: 'grenade pack',
};
const STARTS = { 1: 'player 1 start', 2: 'player 2 start', 3: 'player 3 start', 4: 'player 4 start', 11: 'deathmatch start' };
const MONSTERS = new Set([7, 9, 16, 58, 64, 65, 66, 67, 68, 69, 71, 72, 84, 88, 89, 3001, 3002, 3003, 3004, 3005, 3006]);
const KEYS = new Set([5, 6, 13, 38, 39, 40]);
const MODE_IDS = { 'deathmatch': 0, 'team-deathmatch': 1, 'elimination': 2, 'war': 3, 'battle-royale': 4 };
const MODE_SLOTS = { 'deathmatch': 64, 'team-deathmatch': 64, 'elimination': 24, 'war': 200, 'battle-royale': 64 };
const MAP_LUMPS = ['THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS', 'SSECTORS', 'NODES', 'SECTORS', 'REJECT', 'BLOCKMAP'];
const REQUIRED_LUMPS = ['THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS', 'SSECTORS', 'NODES', 'SECTORS'];
const RECORD = { THINGS: 10, LINEDEFS: 14, SIDEDEFS: 30, VERTEXES: 4, SEGS: 12, SSECTORS: 4, NODES: 28, SECTORS: 26 };

// ---- a report ------------------------------------------------------------------------
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const col = (c, s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const red = (s) => col('31', s), green = (s) => col('32', s), yellow = (s) => col('33', s), dim = (s) => col('2', s), bold = (s) => col('1', s);

class Report {
  constructor() { this.sections = []; this.errors = 0; this.warnings = 0; }
  section(title) { const s = { title, lines: [] }; this.sections.push(s); this.cur = s; return this; }
  ok(msg) { this.cur.lines.push(['ok', msg]); }
  info(msg) { this.cur.lines.push(['info', msg]); }
  warn(msg) { this.warnings++; this.cur.lines.push(['warn', msg]); }
  error(msg) { this.errors++; this.cur.lines.push(['error', msg]); }
  print() {
    for (const s of this.sections) {
      const bad = s.lines.some((l) => l[0] === 'error'), meh = s.lines.some((l) => l[0] === 'warn');
      console.log(`\n${bold(s.title)} ${bad ? red('FAIL') : meh ? yellow('ok, with warnings') : green('ok')}`);
      for (const [k, m] of s.lines) {
        const tag = k === 'error' ? red('  x ') : k === 'warn' ? yellow('  ! ') : k === 'ok' ? green('  + ') : dim('  - ');
        console.log(tag + m.replace(/\n/g, '\n    '));
      }
    }
  }
}

// ---- helpers -------------------------------------------------------------------------
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const plural = (n, w) => `${n} ${n === 1 ? w : /(s|sh|ch|x)$/.test(w) ? w + 'es' : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + 'ies' : w + 's'}`;
const list = (xs, n = 12) => (xs.length > n ? `${xs.slice(0, n).join(', ')} and ${xs.length - n} more` : xs.join(', '));
function closest(word, options) {
  let best = null, bd = Infinity;
  const d = (a, b) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  };
  for (const o of options) { const v = d(word.toLowerCase(), o.toLowerCase()); if (v < bd) { bd = v; best = o; } }
  return bd <= Math.max(2, word.length / 3) ? best : null;
}
const didYouMean = (w, opts) => { const c = closest(w, opts); return c ? ` (did you mean "${c}"?)` : ''; };

let baseCache = null;
function basePak() {
  if (!baseCache) {
    const p = join(ROOT, 'public', 'freedm-lite.wad');
    if (!existsSync(p)) throw new Error('public/freedm-lite.wad missing (run `npm run pak`)');
    baseCache = new Uint8Array(readFileSync(p));
  }
  return baseCache;
}
function installedIndex() {
  const p = join(ROOT, 'public', 'mods', 'index.json');
  if (!existsSync(p)) return [];
  try { const j = JSON.parse(readFileSync(p, 'utf8')); return Array.isArray(j) ? j : Array.isArray(j.mods) ? j.mods : []; } catch { return []; }
}
function builtinMaps() {
  try { return Object.keys(JSON.parse(readFileSync(join(ROOT, 'public', 'maps', 'index.json'), 'utf8')).maps ?? {}); } catch { return []; }
}

// ---- 1. the file ---------------------------------------------------------------------
function checkFile(r, path, bytes) {
  r.section('File');
  if (bytes.length > MAX_BYTES) r.error(`${kb(bytes.length)} is over the 4 MB limit: ship only the art your map uses beyond the base pak`);
  else r.ok(`${basename(path)}: ${kb(bytes.length)} (limit 4 MB)`);
  let lumps;
  try { lumps = parseWadFile(bytes); } catch (e) { r.error(`not a WAD file: ${e.message}`); return null; }
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'PWAD') r.error('the file is an IWAD: a mod must be a PWAD');
  for (const l of lumps) if (l.data.byteOffset + l.data.length > bytes.byteOffset + bytes.length || l.data.length < 0) { r.error(`lump ${l.name} points outside the file`); return null; }
  return lumps;
}

/** Splits a mod's lumps into the map, namespaces and the rest. */
function classify(r, lumps, baseWad) {
  const maps = [];
  const ns = { P: [], F: [], S: [] };
  const other = [];
  let cur = null;
  for (let i = 0; i < lumps.length; i++) {
    const n = lumps[i].name;
    if (/^(PP|P|FF|F|SS|S)_START$/.test(n)) { cur = n[0]; continue; }
    if (/^(PP|P|FF|F|SS|S)_END$/.test(n)) { cur = null; continue; }
    if (/^[PF][123]_(START|END)$/.test(n)) continue;
    if (cur) { ns[cur].push(lumps[i]); continue; }
    if (lumps[i + 1]?.name === 'THINGS' && !MAP_LUMPS.includes(n)) {
      const own = new Map();
      let j = i + 1;
      while (j < lumps.length && MAP_LUMPS.includes(lumps[j].name) && !own.has(lumps[j].name)) { own.set(lumps[j].name, lumps[j].data); j++; }
      if (lumps[j]?.name === 'BEHAVIOR') r.error(`map ${n} is in Hexen format (BEHAVIOR lump): save it in Doom format ("Doom: Doom 2 (Doom format)" in Ultimate Doom Builder)`);
      if (lumps[j]?.name === 'TEXTMAP' || lumps[i + 1]?.name === 'TEXTMAP') r.error(`map ${n} is UDMF: save it in Doom format`);
      maps.push({ name: n, lumps: own, index: i });
      i = j - 1;
      continue;
    }
    if (n === 'TEXTMAP') { r.error('UDMF map (TEXTMAP) found: save the map in Doom format'); continue; }
    other.push(lumps[i]);
  }
  r.section('Lumps');
  r.ok(`${lumps.length} lumps: ${plural(maps.length, 'map')}, ${plural(ns.P.length, 'patch')}, ${plural(ns.F.length, 'flat')}${ns.S.length ? `, ${plural(ns.S.length, 'sprite')}` : ''}`);
  const allowed = new Set(['MODINFO', 'PNAMES', 'TEXTURE1', 'TEXTURE2']);
  for (const l of other) {
    if (allowed.has(l.name)) continue;
    if (MAP_LUMPS.includes(l.name)) { r.error(`${l.name} is not right after a map marker: keep the map's lumps together (marker, THINGS, LINEDEFS, ...)`); continue; }
    if (baseWad.has(l.name)) r.error(`${l.name} would replace the game's own ${l.name}: mods may not override game data (palette, sounds, menus, ...)`);
    else r.warn(`${l.name} is not used by the game (only the map, MODINFO, PNAMES/TEXTURE1 and art between P_/F_ markers are)`);
  }
  for (const l of ns.S) if (baseWad.namespace('S').has(l.name)) r.error(`sprite ${l.name} would replace the game's own sprite`);
  if (ns.S.length) r.warn(`${plural(ns.S.length, 'sprite')} in S_START..S_END: the game does not load new sprites from mods yet`);
  if (other.filter((l) => l.name === 'MODINFO').length > 1) r.error('more than one MODINFO lump');
  return { maps, ns, other };
}

// ---- 2. MODINFO ----------------------------------------------------------------------
const TOP_KEYS = ['format', 'id', 'title', 'author', 'license', 'description', 'mode', 'map', 'slots', 'ghosts', 'bosses', 'rules'];
const RULE_SPEC = {
  matchSeconds: { min: 30, max: 3600, modes: null, what: 'match length in seconds' },
  lobbySeconds: { min: 5, max: 300, modes: ['battle-royale'], what: 'lobby countdown' },
  dropAltitude: { min: 512, max: 16384, modes: ['battle-royale'], what: 'dropship altitude above the highest floor' },
  startBullets: { min: 0, max: 200, modes: ['battle-royale'], what: 'bullets in the starting kit' },
  vehicles: { bool: true, modes: ['battle-royale'] },
  supplyDrops: { bool: true, modes: ['battle-royale'] },
  zone: { modes: ['battle-royale'] },
  loot: { modes: ['battle-royale'] },
  roundSeconds: { min: 20, max: 900, modes: ['elimination'], what: 'round length' },
  freezeSeconds: { min: 0, max: 30, modes: ['elimination'], what: 'freeze time at round start' },
  roundsToWin: { min: 1, max: 50, modes: ['elimination'], what: 'rounds to win the match' },
  tickets: { min: 50, max: 100000, modes: ['war'], what: 'tickets per team' },
  friendlyFire: { bool: true, modes: ['team-deathmatch', 'elimination', 'war'] },
};

function checkModInfo(r, lump, opts) {
  r.section('MODINFO');
  if (!lump) { r.error('no MODINFO lump: add one (UTF-8 JSON, see docs/MODDING.md "MODINFO reference")'); return null; }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(lump); } catch { r.error('MODINFO is not valid UTF-8'); return null; }
  let o;
  try { o = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { r.error(`MODINFO is not valid JSON: ${e.message}`); return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) { r.error('MODINFO must be a JSON object { ... }'); return null; }
  const e0 = r.errors;
  for (const k of Object.keys(o)) if (!TOP_KEYS.includes(k)) r.error(`unknown field "${k}"${didYouMean(k, TOP_KEYS)}`);
  if (o.format !== 1) r.error(`"format" must be 1 (got ${JSON.stringify(o.format)})`);
  const str = (k, max, required) => {
    if (o[k] === undefined) { if (required) r.error(`"${k}" is missing`); return; }
    if (typeof o[k] !== 'string' || !o[k].trim()) r.error(`"${k}" must be a non-empty string`);
    else if (o[k].length > max) r.error(`"${k}" is ${o[k].length} characters; keep it under ${max}`);
  };
  if (typeof o.id !== 'string') r.error('"id" is missing: 2-16 lowercase letters or digits, e.g. "arena"');
  else if (!/^[a-z0-9]{2,16}$/.test(o.id)) r.error(`"id" "${o.id}" must be 2-16 characters of a-z and 0-9 only (no dashes: room names use dashes between words)`);
  str('title', 40, true); str('author', 40, true); str('description', 200, false);
  if (o.description === undefined) r.warn('no "description": the host picker shows one line about your mod');
  // licence
  if (typeof o.license !== 'string' || !o.license) r.error(`"license" is missing: one of ${Object.keys(LICENSES).join(', ')}`);
  else if (!LICENSES[o.license]) {
    const up = o.license.toUpperCase();
    const refused = Object.entries(LICENSE_REFUSED).find(([k]) => up.startsWith(k));
    const hint = LICENSE_HINTS[up];
    r.error(`licence "${o.license}" is not accepted: ${refused ? refused[1] : hint ? `write the SPDX id "${hint}"` : `use one of ${Object.keys(LICENSES).join(', ')}`}`);
  }
  // mode, map, slots
  const modes = Object.keys(MOD_MODES);
  if (!modes.includes(o.mode)) r.error(`"mode" must be one of ${modes.join(', ')}${typeof o.mode === 'string' ? didYouMean(o.mode, modes) : ''} (got ${JSON.stringify(o.mode)})`);
  if (typeof o.map !== 'string' || !/^[A-Z0-9_]{1,8}$/.test(o.map)) r.error(`"map" must be the map's marker name, 1-8 of A-Z 0-9 _ in capitals, e.g. "ARENA" (got ${JSON.stringify(o.map)})`);
  if (o.slots !== undefined) {
    const max = MODE_SLOTS[o.mode] ?? 64;
    if (!Number.isInteger(o.slots) || o.slots < 2 || o.slots > 200) r.error(`"slots" must be a whole number 2..200 (got ${JSON.stringify(o.slots)})`);
    else if (o.slots > max) r.warn(`"slots" ${o.slots} is more than ${o.mode} rooms usually have (${max}): every slot is a bot until a human takes it, and they all cost CPU`);
    if ((o.mode === 'team-deathmatch' || o.mode === 'elimination' || o.mode === 'war') && o.slots % 2) r.warn(`"slots" is odd: teams are slot % 2, so red gets one more player`);
  }
  for (const k of ['ghosts', 'bosses']) if (o[k] !== undefined && typeof o[k] !== 'boolean') r.error(`"${k}" must be true or false`);
  if (o.bosses === true && o.mode !== 'deathmatch' && o.mode !== 'team-deathmatch') r.error('"bosses" only works in deathmatch and team-deathmatch');
  // rules
  if (o.rules !== undefined) checkRules(r, o.rules, o.mode);
  if (r.errors === e0) {
    r.ok(`${o.id}: "${o.title}" by ${o.author}, ${o.mode}, map ${o.map}, ${o.slots ?? MODE_SLOTS[o.mode]} slots, licence ${o.license}`);
    const block = rulesBlock(o.rules);
    if (block[0]) r.info(`rules → ${block[0]} sim keys${opts.verbose ? `: ${block.slice(1).join(' ')}` : ' (--verbose lists them)'}`);
  }
  return r.errors === e0 ? o : null;
}

function checkRules(r, rules, mode) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) { r.error('"rules" must be an object { "matchSeconds": 600, ... }'); return; }
  const keys = Object.keys(RULE_SPEC);
  for (const [k, v] of Object.entries(rules)) {
    const spec = RULE_SPEC[k];
    if (!spec) { r.error(`unknown rule "${k}"${didYouMean(k, keys)}`); continue; }
    if (spec.modes && !spec.modes.includes(mode)) r.warn(`rule "${k}" only applies to ${spec.modes.join(' / ')} (this mod is ${mode}): it will be ignored`);
    if (spec.bool) { if (typeof v !== 'boolean') r.error(`rule "${k}" must be true or false`); continue; }
    if (spec.min !== undefined) {
      if (typeof v !== 'number' || !Number.isFinite(v)) r.error(`rule "${k}" (${spec.what}) must be a number`);
      else if (v < spec.min || v > spec.max) r.error(`rule "${k}" (${spec.what}) must be ${spec.min}..${spec.max} (got ${v})`);
      else if (!Number.isInteger(v)) r.warn(`rule "${k}" ${v} will be rounded`);
    }
  }
  if (rules.zone !== undefined) {
    const z = rules.zone;
    if (!Array.isArray(z) || !z.length) r.error('rule "zone" must be a list of 1..8 stages: [{ "wait": 60, "shrink": 60, "radius": 60, "dps": 1 }, ...]');
    else {
      if (z.length > MAX_ZONE_STAGES) r.error(`rule "zone" has ${z.length} stages; at most ${MAX_ZONE_STAGES}`);
      let prev = 100;
      z.forEach((s, i) => {
        const at = `zone stage ${i + 1}`;
        if (!s || typeof s !== 'object') { r.error(`${at} must be an object`); return; }
        for (const k of Object.keys(s)) if (!['wait', 'shrink', 'radius', 'dps'].includes(k)) r.error(`${at}: unknown field "${k}"${didYouMean(k, ['wait', 'shrink', 'radius', 'dps'])}`);
        const n = (k, lo, hi, what) => {
          if (s[k] === undefined) { r.error(`${at}: "${k}" (${what}) is missing`); return; }
          if (typeof s[k] !== 'number' || s[k] < lo || s[k] > hi) r.error(`${at}: "${k}" (${what}) must be ${lo}..${hi} (got ${JSON.stringify(s[k])})`);
        };
        n('wait', 0, 600, 'seconds before shrinking'); n('shrink', 1, 600, 'seconds to shrink'); n('radius', 0, 100, 'radius after, % of the whole map'); n('dps', 0, 100, 'damage per second outside');
        if (typeof s.radius === 'number' && s.radius >= 0 && s.radius <= 100) { if (s.radius > prev) r.error(`${at}: radius ${s.radius}% is larger than the stage before (${prev}%): the storm only shrinks`); prev = s.radius; }
      });
      const total = z.reduce((a, s) => a + (s?.wait ?? 0) + (s?.shrink ?? 0), 0);
      const match = rules.matchSeconds ?? 900;
      if (total > match) r.warn(`the zone takes ${total} s to close but the match ends at ${match} s`);
      r.info(`storm: ${plural(z.length, 'stage')}, closed after ${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`);
    }
  }
  if (rules.loot !== undefined) {
    const L = rules.loot;
    if (!L || typeof L !== 'object' || Array.isArray(L)) r.error('rule "loot" must be an object { "sniper": 20, "bfg": 0, ... }');
    else {
      for (const [k, v] of Object.entries(L)) {
        if (!LOOT_ROWS.includes(k)) { r.error(`loot "${k}" is not a loot row${didYouMean(k, LOOT_ROWS)}; rows: ${LOOT_ROWS.join(', ')}`); continue; }
        if (typeof v !== 'number' || v < 0 || v > 100) r.error(`loot "${k}" must be a weight 0..100 (got ${JSON.stringify(v)})`);
        else if (Math.round(v * 2) !== v * 2) r.error(`loot "${k}" ${v}: weights go in steps of 0.5`);
      }
      // the first six rows are health/armor: every crate's first item comes from them
      const health = LOOT_ROWS.slice(0, 6);
      if (health.every((k) => L[k] === 0)) r.error(`loot: ${health.join(', ')} are all 0, but every crate's first item is drawn from those rows`);
      if (LOOT_ROWS.every((k) => L[k] === 0)) r.error('loot: every weight is 0');
    }
  }
}

// ---- 3. id ---------------------------------------------------------------------------
function checkId(r, info, path) {
  r.section('Id');
  const idx = installedIndex();
  const same = idx.find((m) => m.id === info.id);
  const installedPath = resolve(ROOT, 'public', 'mods', `${info.id}.wad`);
  if (same && resolve(path) !== installedPath) r.error(`id "${info.id}" is taken by "${same.title}" by ${same.author}: pick another id`);
  else if (same) r.ok(`"${info.id}" is installed (public/mods/${info.id}.wad, listed in public/mods/index.json)`);
  else r.ok(`"${info.id}" is free (${plural(idx.length, 'installed mod')})`);
  if (resolve(path).startsWith(resolve(ROOT, 'public', 'mods')) && basename(path) !== `${info.id}.wad`) r.error(`the file is ${basename(path)} but its id is "${info.id}": name it ${info.id}.wad`);
  for (const other of idx.filter((m) => m.id !== info.id && m.map === info.map)) {
    // the sim tells maps apart by name + content hash, but players' caches and the server
    // list go by name: the same name must mean the same map
    const theirs = join(ROOT, 'public', 'mods', `${other.id}.wad`);
    const same = existsSync(theirs) && sameMap(mapLumpsOf(bytesOf(path), info.map), mapLumpsOf(bytesOf(theirs), info.map));
    if (same) r.ok(`reuses mod "${other.id}"'s map ${info.map} unchanged (fine: a rules remix)`);
    else r.error(`map name ${info.map} is already used by mod "${other.id}" for a different map: rename yours (e.g. "${info.id.toUpperCase().slice(0, 8)}")`);
  }
  if (builtinMaps().includes(info.map) && !idx.some((m) => m.id === info.id && m.map === info.map) && !/^BR\d\d$/.test(info.map)) {
    r.warn(`map name ${info.map} is also a built-in map's: pick a name of your own unless you are deliberately reusing that map`);
  }
}

const bytesOf = (p) => new Uint8Array(readFileSync(p));
function mapLumpsOf(bytes, name) {
  try { return new Wad(bytes).mapLumps(name); } catch { return null; }
}
function sameMap(a, b) {
  if (!a || !b) return false;
  for (const n of REQUIRED_LUMPS) {
    const x = a.get(n), y = b.get(n);
    if (!x || !y || x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}

// ---- 4. map --------------------------------------------------------------------------
function checkMap(r, maps, info) {
  r.section('Map');
  if (!maps.length) { r.error('no map in the file: a mod needs exactly one (marker + THINGS LINEDEFS SIDEDEFS VERTEXES SEGS SSECTORS NODES SECTORS)'); return null; }
  if (maps.length > 1) r.error(`${maps.length} maps (${maps.map((m) => m.name).join(', ')}): a mod holds exactly one`);
  const m = maps[0];
  if (info && m.name !== info.map) r.error(`the map is called ${m.name} but MODINFO "map" says ${info.map}`);
  const sig = String.fromCharCode(...(m.lumps.get('NODES') ?? new Uint8Array(0)).subarray(0, 4));
  if (/^[XZ](NOD|GLN|GL2|GL3)$/.test(sig)) { r.error(`NODES are ZDoom extended/compressed nodes (${sig}): build vanilla nodes instead (in Ultimate Doom Builder: Map > Map Options or Preferences > Nodebuilder, choose "ZDBSP - Normal (no reject)"; ZenNode or glBSP's normal mode work too)`); return null; }
  const missing = REQUIRED_LUMPS.filter((n) => !m.lumps.has(n) || (!m.lumps.get(n).length && n !== 'THINGS'));
  const nodesMissing = ['SEGS', 'SSECTORS', 'NODES'].filter((n) => missing.includes(n));
  if (nodesMissing.length) r.error(`no nodes (${nodesMissing.join(', ')} empty or missing): run a node builder (ZDBSP / ZenNode / glBSP; Ultimate Doom Builder does it when you save) before packing`);
  const rest = missing.filter((n) => !nodesMissing.includes(n));
  if (rest.length) { r.error(`map lumps missing or empty: ${rest.join(', ')}`); return null; }
  for (const [n, size] of Object.entries(RECORD)) if (m.lumps.get(n).length % size) r.error(`${n} is ${m.lumps.get(n).length} bytes, not a multiple of its ${size}-byte record`);
  if (nodesMissing.length) return null;
  const map = parseMap(m.name, m.lumps);
  const errs = [];
  const nv = map.vertexes.length, ns = map.sides.length, nsec = map.sectors.length, nl = map.lines.length;
  map.lines.forEach((l, i) => {
    if (l.v1 >= nv || l.v2 >= nv) errs.push(`linedef ${i} uses a vertex that does not exist`);
    if (l.front < 0 || l.front >= ns) errs.push(`linedef ${i} has no front sidedef`);
    if (l.back >= ns) errs.push(`linedef ${i} back sidedef ${l.back} does not exist`);
    if (l.back >= 0 && !(l.flags & 4)) errs.push(`linedef ${i} has two sides but no two-sided flag`);
    if (l.back < 0 && (l.flags & 4)) errs.push(`linedef ${i} is flagged two-sided but has only one side`);
  });
  map.sides.forEach((s, i) => { if (s.sector >= nsec) errs.push(`sidedef ${i} points at sector ${s.sector}, which does not exist`); });
  map.segs.forEach((s, i) => { if (s.v1 >= nv || s.v2 >= nv || s.line >= nl) errs.push(`seg ${i} has bad references (rebuild the nodes)`); });
  map.subsectors.forEach((s, i) => { if (s.first + s.count > map.segs.length || !s.count) errs.push(`subsector ${i} has bad segs (rebuild the nodes)`); });
  map.nodes.forEach((n, i) => { for (const c of n.children) if (c & NF_SUBSECTOR ? (c & ~NF_SUBSECTOR) >= map.subsectors.length : c >= i) errs.push(`node ${i} has a bad child (rebuild the nodes)`); });
  if (!map.nodes.length && map.subsectors.length !== 1) errs.push('no NODES but more than one subsector');
  if (errs.length) r.error(`${plural(errs.length, 'broken reference')}: ${list(errs, 6)}`);
  map.sectors.forEach((s, i) => { if (s.ceil < s.floor) r.warn(`sector ${i}: ceiling ${s.ceil} is below its floor ${s.floor}`); });
  if (nl > 32767 || ns > 65534 || nv > 65534) r.error('the map is too big for the Doom format (more than 32767 linedefs or 65534 sides/vertexes)');
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const v of map.vertexes) { x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y); }
  r.ok(`${m.name}: ${nl} linedefs, ${ns} sidedefs, ${nv} vertexes, ${nsec} sectors, ${map.subsectors.length} subsectors, ${map.nodes.length} nodes; ${x1 - x0} x ${y1 - y0} units`);
  if (!m.lumps.get('BLOCKMAP')?.length) r.info('no BLOCKMAP: the sim builds its own (fine)');
  if (!m.lumps.get('REJECT')?.length) r.info('no REJECT: treated as "no rejection" (fine)');
  return map;
}

// ---- 5. things -----------------------------------------------------------------------
function checkThings(r, map, info, art) {
  r.section('Things');
  const defs = new Map(THING_DEFS.map((d) => [d[0], d]));
  const count = new Map();
  const unknown = new Map();
  const monsters = [], keys = [];
  for (const t of map.things) {
    count.set(t.type, (count.get(t.type) ?? 0) + 1);
    if (MONSTERS.has(t.type)) monsters.push(t.type);
    else if (KEYS.has(t.type)) keys.push(t.type);
    else if (!defs.has(t.type) && !OUR_THINGS[t.type] && !STARTS[t.type]) unknown.set(t.type, (unknown.get(t.type) ?? 0) + 1);
  }
  if (unknown.size) r.error(`unknown thing types: ${[...unknown].map(([t, n]) => `${t} (×${n})`).join(', ')}. Allowed: Doom 2's items/decorations, starts 1-4 and 11, and ${Object.entries(OUR_THINGS).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (monsters.length) r.warn(`${plural(monsters.length, 'monster')} on the map: monsters are not spawned in Doom Town`);
  if (keys.length) r.warn(`${plural(keys.length, 'key')} on the map: keys are not spawned (locked doors open for anyone)`);
  const n = (t) => count.get(t) ?? 0;
  const dm = n(11), coop = n(1) + n(2) + n(3) + n(4);
  const mode = info?.mode;
  const parts = [`${dm} deathmatch starts`];
  if (n(9000) + n(9001)) parts.push(`${n(9000)} red / ${n(9001)} blue team starts`);
  if (n(9010)) parts.push(`${plural(n(9010), 'capture point')}`);
  if (n(9020)) parts.push(`${plural(n(9020), 'crate')}`);
  if (n(9030)) parts.push(`${n(9030)} lobby spots`);
  if (n(9040)) parts.push(plural(n(9040), 'buggy'));
  const items = map.things.filter((t) => (t.type >= 2001 && t.type <= 2026) || [8, 17, 82, 83, 2045, 2046, 2047, 2048, 2049, 9050, 9051].includes(t.type)).length;
  parts.push(`${items} items`);
  r.ok(`${map.things.length} things: ${parts.join(', ')}`);
  if (!dm && !coop && !n(9000) && !n(9030)) r.error('no starts at all: place deathmatch starts (type 11)');
  if (mode === 'deathmatch' || mode === 'team-deathmatch' || mode === 'elimination') {
    if (dm < 4) r.error(`${dm} deathmatch starts: place at least 4 (8+ is better; the sim adds more spawn spots on open floor)`);
    else if (dm < 8) r.warn(`only ${dm} deathmatch starts: 8 or more spread around the map make spawns fairer`);
  }
  if (mode === 'war') {
    if (!n(9000) || !n(9001)) r.error('war needs red team starts (9000) and blue team starts (9001)');
    else if (Math.abs(n(9000) - n(9001)) > Math.max(2, n(9000) / 5)) r.warn(`team starts are lopsided: ${n(9000)} red vs ${n(9001)} blue`);
    if (!n(9010)) r.error('war needs capture points (thing 9010; the angle field is the radius / 8)');
    if (n(9010) > 8) r.error(`${n(9010)} capture points: at most 8 (lettered A-H)`);
    for (const t of map.things.filter((t) => t.type === 9010)) if (t.angle <= 0 || t.angle * 8 > 2048) r.warn(`capture point at ${t.x},${t.y}: angle ${t.angle} means radius ${t.angle * 8}; use 16..64 (radius 128..512)`);
  }
  if (mode === 'battle-royale') {
    if (dm < 16) r.warn(`${dm} deathmatch starts: battle royale spreads players over spawn spots; 64 spread over the map work best`);
    if (!n(9030)) r.warn('no lobby spots (9030): players wait for the dropship on deathmatch starts instead of a lobby island');
    if (!n(9020)) r.warn('no crates (9020): battle royale loot comes from crates');
  }
  if (n(9020) && art) {
    const miss = ['CRATE1'].filter((t) => !art.texOk(t)).concat(['CRATOP2'].filter((f) => !art.flatOk(f)));
    if (miss.length) r.error(`the map has crates, but the crate model's art ${miss.join(' / ')} is not in the base pak or the mod: pack it`);
  }
  if (mode && mode !== 'war' && n(9010)) r.info('capture points only matter in war');
  // sprites for decorations / items the base pak does not carry
  if (art) {
    const noSprite = new Set();
    for (const t of map.things) {
      const d = defs.get(t.type);
      if (!d || MONSTERS.has(t.type) || KEYS.has(t.type)) continue;
      if (!art.spriteOk(d[2])) noSprite.add(`${t.type} (${d[2]})`);
    }
    if (noSprite.size) r.warn(`no sprites in the base pak for: ${[...noSprite].join(', ')}; they will be invisible (pick decorations the built-in maps use)`);
  }
}

// ---- 6. art --------------------------------------------------------------------------
function artIndex(baseBytes, modBytes) {
  const wad = new Wad(baseBytes, modBytes);
  // TEXTURE1/2 of every file, each with its own PNAMES; later files override by name
  const defs = new Map();
  const pn = wad.all('PNAMES');
  for (const tl of [...wad.all('TEXTURE1'), ...wad.all('TEXTURE2')].sort((a, b) => a.source - b.source)) {
    const p = pn.filter((l) => l.source === tl.source).pop();
    if (!p) continue;
    for (const d of parseTextureLump(tl.data, parsePnames(p.data))) defs.set(d.name, { ...d, source: tl.source });
  }
  const patchOk = (n) => !!(wad.nsLump('P', n) ?? wad.namespace('S').get(n.toUpperCase()));
  const flats = wad.namespace('F');
  const sprites = new Set([...wad.namespace('S').keys()].map((n) => n.slice(0, 4)));
  return {
    wad, defs,
    texOk: (n) => { const d = defs.get(n); return !!d && d.patches.every((p) => patchOk(p.patch)); },
    flatOk: (n) => flats.has(n),
    spriteOk: (s) => sprites.has(s),
    patchOk,
  };
}

function checkArt(r, map, art, modWad) {
  r.section('Textures and flats');
  const tex = new Map(), flats = new Map();
  map.sides.forEach((s) => { for (const n of [s.top, s.mid, s.bottom]) if (n && n !== '-') tex.set(n, (tex.get(n) ?? 0) + 1); });
  map.sectors.forEach((s) => { for (const n of [s.floorPic, s.ceilPic]) flats.set(n, (flats.get(n) ?? 0) + 1); });
  const noDef = [], noPatch = [], noFlat = [];
  for (const n of tex.keys()) {
    const d = art.defs.get(n);
    if (!d) noDef.push(n);
    else { const miss = d.patches.filter((p) => !art.patchOk(p.patch)).map((p) => p.patch); if (miss.length) noPatch.push(`${n} (patches ${[...new Set(miss)].join(' ')})`); }
  }
  for (const n of flats.keys()) if (n !== 'F_SKY1' && !art.flatOk(n)) noFlat.push(n);
  if (noDef.length) r.error(`wall textures nobody defines: ${list(noDef)}. Use Freedoom textures (the base pak's list is in docs/MODDING.md) or ship your own TEXTURE1 + PNAMES + patches`);
  if (noPatch.length) r.error(`textures whose patches are not in the base pak or the mod: ${list(noPatch, 8)}. Pack the art with \`npm run mods\` (it copies what your map uses from Freedoom), or add the patches between P_START and P_END`);
  if (noFlat.length) r.error(`flats not in the base pak or the mod: ${list(noFlat)}. Pack them between F_START and F_END`);
  const own = [...tex.keys()].filter((n) => art.defs.get(n)?.source === 1).length;
  const ownFlats = [...flats.keys()].filter((n) => modWad.namespace('F').has(n)).length;
  if (!noDef.length && !noPatch.length && !noFlat.length) r.ok(`${tex.size} wall textures and ${flats.size} flats, all resolvable (the mod defines ${own} textures and carries ${ownFlats} flats; the rest come from the base pak)`);
  if (tex.has('AASHITTY') || tex.has('AASTINKY')) r.warn('AASHITTY / AASTINKY is texture 0, which vanilla Doom draws as nothing: use "-" for no texture');
  const sky = 'SKY1';
  if (!art.texOk(sky)) r.warn(`the sky (${sky}) is not resolvable: outdoor areas would show no sky`);
  // what the mod ships but the map does not use
  const unusedFlats = [...modWad.namespace('F').keys()].filter((n) => !flats.has(n));
  if (unusedFlats.length > 4) r.info(`${unusedFlats.length} flats in the mod are not on the map (fine if they are animation frames): ${list(unusedFlats, 6)}`);
}

// ---- 7. the sim ----------------------------------------------------------------------
async function runSim(r, bytes, info, map, seconds, opts = {}) {
  r.section(`Simulation (${seconds} s with bots)`);
  const wasmPath = opts.wasm ? resolve(opts.wasm) : join(ROOT, 'public', 'doomsim.wasm');
  if (!existsSync(wasmPath)) { r.error(`${wasmPath} missing (npm run build:sim)`); return; }
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
  const ex = instance.exports;
  const mem = () => new Uint8Array(ex.memory.buffer);
  const i32 = (p, n) => new Int32Array(ex.memory.buffer, p, n).slice();
  const pass = (b) => { const p = ex.alloc(b.length); mem().set(b, p); return p; };
  const version = ex.sim_version();
  let mapId;
  try {
    const p = pass(bytes);
    mapId = ex.map_load(p, bytes.length);
    ex.dealloc(p, bytes.length);
  } catch (e) { r.error(`the sim crashed loading the map: ${e.message}`); return; }
  const codes = { [-1]: 'not a WAD', [-2]: 'bad WAD directory', [-3]: 'no THINGS lump', [-4]: 'a map lump is missing or not within the 10 lumps after THINGS', [-5]: 'no vertexes, sectors or linedefs', [-6]: 'bad subsectors/segs (rebuild the nodes)' };
  if (mapId < 0) { r.error(`map_load failed: ${codes[mapId] ?? `error ${mapId}`}`); return; }
  r.ok(`map_load: map id ${mapId} (sim_version ${version})`);
  const mode = MODE_IDS[info.mode];
  const slots = info.slots ?? MODE_SLOTS[info.mode];
  const ghosts = info.ghosts ?? info.mode === 'war';
  const rules = { ...(info.rules ?? {}) };
  let note = '';
  if (info.mode === 'battle-royale' && (rules.lobbySeconds ?? 45) > 10) { rules.lobbySeconds = 10; note = ' (lobby shortened to 10 s for the test)'; }
  const words = Uint32Array.from([2, mode, slots, 0, 0, 0, 0, 0, 0, 0, 1, mapId, 12345, (info.bosses ? 1 : 0) | (ghosts ? 2 : 0), ...rulesBlock(rules)]);
  const wp = ex.alloc(words.byteLength);
  new Uint32Array(ex.memory.buffer, wp, words.length).set(words);
  const h = ex.world_new_cfg(wp, words.byteLength);
  ex.dealloc(wp, words.byteLength);
  if (!(h > 0)) { r.error('world_new_cfg refused the config'); return; }
  const tics = seconds * 35;
  const half = tics >> 1;
  let h2 = 0;
  const stats = { kills: 0, captures: 0, crates: 0, events: 0, matchEnds: 0, zone: 0, pickups: 0, snipers: 0 };
  const first = new Map(), far = new Map();
  let worst = 0, total = 0, tic = 0;
  try {
    for (tic = 0; tic < tics; tic++) {
      const t0 = performance.now();
      ex.world_tick(h);
      const dt = performance.now() - t0;
      total += dt; if (tic >= 35 && dt > worst) worst = dt;
      const ep = ex.world_events(h);
      const n = new Uint32Array(ex.memory.buffer, ep, 1)[0];
      stats.events += n;
      const ev = i32(ep + 4, n * 8);
      for (let k = 0; k < n; k++) {
        const kind = ev[k * 8];
        if (kind === 2 && ev[k * 8 + 2] !== ev[k * 8 + 1]) stats.kills++;
        if (kind === 12) stats.captures++;
        if (kind === 17) stats.crates++;
        if (kind === 8) stats.matchEnds++;
        if (kind === 16) stats.zone++;
        if (kind === 3) { stats.pickups++; if (ev[k * 8 + 2] === 141) stats.snipers++; } // 141 = MT_SNIPER
      }
      if (h2) ex.world_tick(h2);
      if (tic === half) {
        const len = ex.world_serialize(h);
        const snap = mem().slice(ex.world_buf_ptr(), ex.world_buf_ptr() + len);
        const sp = pass(snap);
        h2 = ex.world_deserialize(sp, snap.length);
        ex.dealloc(sp, snap.length);
        if (!(h2 > 0)) r.error('world_deserialize refused a snapshot of this map');
      }
      if (tic % 35 === 0) {
        for (let s = 0; s < slots; s++) {
          const pv = i32(ex.world_view_player(h, s), 8);
          if (pv[2] !== 0 || !pv[1]) continue;
          const x = pv[3] / 65536, y = pv[4] / 65536;
          if (!first.has(s)) first.set(s, [x, y]);
          const [fx, fy] = first.get(s);
          far.set(s, Math.max(far.get(s) ?? 0, Math.hypot(x - fx, y - fy)));
        }
      }
    }
  } catch (e) {
    r.error(`the sim crashed (panicked) at tic ${tic} (${(tic / 35).toFixed(1)} s): ${e.message}. Please report it with your file; it is a sim bug, but your map triggers it`);
    return;
  }
  const avg = total / tics;
  const line = `${tics} tics, ${slots} bots${note}: ${avg.toFixed(2)} ms/tic average, ${worst.toFixed(1)} ms worst after the first second`;
  if (avg > 6) r.warn(`${line}. That is heavy: a browser runs 35 tics/s plus prediction; fewer slots or a smaller map help`);
  else r.ok(line);
  const extra = [];
  if (info.mode === 'war') extra.push(`${stats.captures} captures`);
  if (stats.crates) extra.push(`${stats.crates} crates opened`);
  if (stats.zone) extra.push(`${stats.zone} storm updates`);
  if (info.mode === 'battle-royale') extra.push(`${stats.pickups} pickups (${stats.snipers} sniper rifles)`);
  r.ok(`${stats.kills} kills, ${stats.events} events${extra.length ? ', ' + extra.join(', ') : ''}`);
  const moved = [...far.values()].filter((d) => d > 512).length;
  if (first.size) {
    const msg = `${moved} of ${first.size} bots that spawned travelled more than 512 units`;
    if (moved < first.size * 0.5) r.warn(`${msg}: bots may be stuck (steps over 24 units, gaps under 56 high, doors that need keys?)`); else r.ok(msg);
  } else if (info.mode !== 'battle-royale') r.warn('no bot ever spawned: check the starts');
  else r.warn('no bot landed during the test');
  if (info.mode === 'battle-royale' && seconds >= 60) {
    if (!stats.zone) r.warn(`the storm never started in ${seconds} s (no zone events): is the sim (sim_version ${version}) older than battle royale? rebuild it with npm run build:sim`);
    if (!stats.crates && map.things.some((t) => t.type === 9020)) r.warn('no crate was opened: bots open crates they can reach; check they are not walled in');
  }
  if (info.mode !== 'battle-royale' && stats.kills === 0 && seconds >= 60) r.warn('no kills in a minute: bots may not find each other (is the map connected?)');
  if (h2 > 0) {
    if (ex.world_hash(h) === ex.world_hash(h2)) r.ok(`deterministic: a snapshot taken at ${(half / 35).toFixed(0)} s stepped identically to the end`);
    else r.error('a snapshot of this world did not step identically: report this (it is a sim bug)');
    ex.world_free(h2);
  }
  ex.world_free(h);
}

// ---- driver ----------------------------------------------------------------------------
export async function checkMod(path, opts = {}) {
  const r = new Report();
  const bytes = new Uint8Array(readFileSync(path));
  const baseBytes = basePak();
  const baseWad = new Wad(baseBytes);
  const lumps = checkFile(r, path, bytes);
  if (!lumps) return r;
  const { maps, ns } = classify(r, lumps, baseWad);
  const modinfo = lumps.find((l) => l.name === 'MODINFO')?.data;
  const info = checkModInfo(r, modinfo, opts);
  if (info) checkId(r, info, path);
  const map = checkMap(r, maps, info);
  let art = null;
  if (map) {
    const modWad = new Wad(bytes);
    art = artIndex(baseBytes, bytes);
    checkArt(r, map, art, modWad);
    if (ns.P.length || ns.F.length) {
      const dup = [...ns.F.map((l) => l.name).filter((n) => baseWad.namespace('F').has(n)), ...ns.P.map((l) => l.name).filter((n) => baseWad.namespace('P').has(n))];
      if (dup.length) r.info(`${plural(dup.length, 'lump')} the base pak already has (harmless, but they cost bytes): ${list(dup, 6)}`);
    }
  }
  if (map) checkThings(r, map, info, art);
  if (map && info && !opts.noSim) {
    if (r.errors) { r.section('Simulation'); r.info('skipped: fix the errors above first'); }
    else await runSim(r, bytes, info, map, opts.seconds ?? 60, opts);
  }
  return r;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const flag = (k) => args.includes(`--${k}`);
  const val = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  let files = args.filter((a) => !a.startsWith('--'));
  if (flag('all')) {
    const dir = join(ROOT, 'public', 'mods');
    files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.wad')).sort().map((f) => join(dir, f)) : [];
  }
  if (!files.length || flag('help')) {
    console.log('usage: npm run mod:check <file.wad> [more.wad ...] [-- --seconds=60 --no-sim]\n       npm run mod:check -- --all     (every public/mods/*.wad)\nSee docs/MODDING.md.');
    process.exit(files.length ? 0 : 2);
  }
  let failed = 0;
  const summary = [];
  for (const f of files) {
    if (!existsSync(f) || !statSync(f).isFile()) { console.error(red(`${f}: no such file`)); failed++; continue; }
    console.log(bold(`\n=== ${f}`));
    const r = await checkMod(f, { seconds: Number(val('seconds') ?? 60), noSim: flag('no-sim'), verbose: flag('verbose'), wasm: val('wasm') });
    r.print();
    const verdict = r.errors ? red(`FAIL: ${plural(r.errors, 'error')}`) : green('PASS');
    console.log(`\n${verdict}${r.warnings ? yellow(`, ${plural(r.warnings, 'warning')}`) : ''}  ${f}`);
    summary.push(`${r.errors ? 'FAIL' : 'PASS'}  ${f}${r.warnings ? `  (${plural(r.warnings, 'warning')})` : ''}`);
    if (r.errors) failed++;
  }
  if (files.length > 1) console.log(`\n${summary.join('\n')}`);
  process.exit(failed ? 1 : 0);
}
