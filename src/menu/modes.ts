/**
 * A room's game is a pure function of its name (DESIGN.md "Modes, teams and map
 * rotation"), so every client builds the same world without asking anyone.
 *
 * Names are dash-separated words. A word picks the mode, another adds random
 * bosses; anything else (region, number, a player's own words) is ignored:
 *
 *   na-1, my-room             Deathmatch (the default)
 *   na-tdm-1, team-room       Team Deathmatch        (tdm, team, teams)
 *   na-elim-1, cs-night       Elimination            (elim, elimination, cs, rounds)
 *   na-war-1, big-war         War, 100 v 100         (war, conquest)
 *   na-br-1, pubg-night       Battle royale, 64      (br, royale, battle, pubg) - plays the br01 mod
 *   na-mod-br01-1, my-mod-x   a mod: `mod` then the mod's id (public/mods/index.json);
 *                             the mod's mode, map and slots apply
 *   na-boss-1, na-tdm-boss-1  + Random bosses        (boss, bosses) - Deathmatch and TDM only
 *   na-tdm-ghost-1            + No player collision  (ghost, ghosts, nocollide) - on by default in War
 *   my-war-solid              - player collision     (solid, collide) - War rooms that want it back
 */
import { ROTATIONS, type RotationKey } from '../sim/maps.js';
import { MOD_MODES, RULE, rulesBlock, type ModEntry } from '../mods/modinfo.js';
import { modById } from '../mods/index.js';

/** The mod battle royale rooms play (DESIGN.md "Mods"). */
export const BR_MOD = 'br01';

export type ModeKey = 'dm' | 'tdm' | 'elim' | 'war' | 'br';

export interface ModeInfo {
  key: ModeKey;
  /** the sim's mode id (world_new_cfg word 1) */
  id: number;
  label: string;
  /** short label for tight places (HUD, tabs) */
  short: string;
  slots: number;
  rotation: RotationKey;
  teams: boolean;
  /** seconds a match usually lasts, intermission included (for guessing a room's current map) */
  matchSeconds: number;
  /** one line for the menu */
  blurb: string;
}

export const MODES: Record<ModeKey, ModeInfo> = {
  dm: { key: 'dm', id: 0, label: 'Deathmatch', short: 'DM', slots: 64, rotation: 'deathmatch', teams: false, matchSeconds: 610, blurb: 'Everyone for themselves, 10-minute matches' },
  tdm: { key: 'tdm', id: 1, label: 'Team Deathmatch', short: 'TDM', slots: 64, rotation: 'teamDeathmatch', teams: true, matchSeconds: 610, blurb: 'Red against blue, 32 a side' },
  elim: { key: 'elim', id: 2, label: 'Elimination', short: 'ELIM', slots: 24, rotation: 'elimination', teams: true, matchSeconds: 900, blurb: 'Rounds, no respawns, first team to 7' },
  war: { key: 'war', id: 3, label: 'War', short: 'WAR', slots: 200, rotation: 'war', teams: true, matchSeconds: 1210, blurb: '100 against 100, hold the capture points' },
  br: { key: 'br', id: 4, label: 'Battle Royale', short: 'BR', slots: 64, rotation: 'battleRoyale', teams: false, matchSeconds: 440, blurb: 'One life, a shrinking zone, crates full of loot' },
};

export const MODE_ORDER: readonly ModeKey[] = ['dm', 'tdm', 'elim', 'war', 'br'];

export interface RoomGame {
  mode: ModeInfo;
  bosses: boolean;
  /** players pass through each other (crowded rooms: nobody gets wedged in a doorway) */
  ghosts: boolean;
  slots: number;
  rotation: readonly string[];
  /** "Team Deathmatch · Random bosses" */
  label: string;
  /** the word(s) a regional room name carries for this game: '', 'tdm', 'boss', 'tdm-boss', 'mod-arena', ... */
  kind: string;
  /** the mod the room plays (its map, art and rules come from the mod's file), or null */
  mod: ModEntry | null;
}

const WORDS: Record<string, ModeKey> = {
  tdm: 'tdm', team: 'tdm', teams: 'tdm',
  elim: 'elim', elimination: 'elim', cs: 'elim', rounds: 'elim',
  war: 'war', conquest: 'war',
  br: 'br', royale: 'br', battle: 'br', pubg: 'br',
};

/** War (100 v 100) rooms have no player collision unless the name says otherwise. */
const GHOSTS_BY_DEFAULT: Record<ModeKey, boolean> = { dm: false, tdm: false, elim: false, war: true, br: false };

export function gameFor(mode: ModeKey, bosses: boolean, ghosts?: boolean, modId?: string): RoomGame {
  // battle royale is a mod (br01); a named mod brings its own mode
  const explicit = modId ? modById(modId) : null;
  const mod = explicit ?? (mode === 'br' ? modById(BR_MOD) : null);
  if (explicit) mode = MOD_MODES[explicit.mode];
  if (modId && !explicit) console.warn(`[mods] no mod "${modId}" installed`);
  const m = MODES[mode];
  // a mod's MODINFO (or its index entry) sets ghosts and bosses unless the room name does
  const modGhosts = explicit ? (explicit.info?.ghosts ?? explicit.ghosts) : undefined;
  const modBosses = explicit ? (explicit.info?.bosses ?? explicit.bosses) : undefined;
  const modDefault = modGhosts ?? GHOSTS_BY_DEFAULT[mode];
  if (ghosts === undefined) ghosts = modDefault;
  if (modBosses) bosses = true;
  const b = bosses && (mode === 'dm' || mode === 'tdm');
  const g = ghosts !== modDefault ? (ghosts ? 'ghost' : 'solid') : '';
  const kind = [explicit ? `mod-${explicit.id}` : mode === 'dm' ? '' : mode, b && !modBosses ? 'boss' : '', g].filter(Boolean).join('-');
  const label = [explicit ? `${explicit.title} (${m.label} mod)` : m.label, b ? 'Random bosses' : '', g ? (ghosts ? 'No player collision' : 'Player collision') : ''].filter(Boolean).join(' · ');
  const rotation = mod ? [mod.map] : ROTATIONS[m.rotation];
  return { mode: m, bosses: b, ghosts, slots: mod?.slots ?? m.slots, rotation, label, kind, mod };
}

/**
 * The name of a new room playing `g`: the player's own words with any game words taken
 * out, then the game's words, so roomGame(roomNameFor(base, g)) plays g.
 */
export function roomNameFor(base: string, g: RoomGame): string {
  const game = new Set([...Object.keys(WORDS), 'boss', 'bosses', 'ghost', 'ghosts', 'nocollide', 'solid', 'collide']);
  const words = base.split(/[-_]+/);
  const own = words.filter((w, i) => w && !game.has(w) && w !== 'mod' && words[i - 1] !== 'mod').join('-').slice(0, 32 - g.kind.length - 1).replace(/-+$/, '');
  return [own || 'room', g.kind].filter(Boolean).join('-');
}

/**
 * Where in its rotation a room starts. Without this every room of a mode would open on
 * the same first map and the server list would read the same map down every row; with
 * it na-1 and na-2 start on different maps. A hash of the name, so every client agrees.
 */
function rotationStart(name: string, length: number): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return length > 0 ? (h >>> 0) % length : 0;
}

/** The game a room plays, from its name alone. */
export function roomGame(name: string): RoomGame {
  let mode: ModeKey = 'dm';
  let bosses = false;
  let ghosts: boolean | undefined;
  let modId: string | undefined;
  const words = name.toLowerCase().split(/[-_\s]+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === 'mod' && words[i + 1] && !modId) { modId = words[++i]; continue; }
    if (WORDS[w] && mode === 'dm') mode = WORDS[w];
    if (w === 'boss' || w === 'bosses') bosses = true;
    if (w === 'ghost' || w === 'ghosts' || w === 'nocollide') ghosts = true;
    if (w === 'solid' || w === 'collide') ghosts = false;
  }
  const g = gameFor(mode, bosses, ghosts, modId);
  const k = rotationStart(name.toLowerCase(), g.rotation.length);
  return { ...g, rotation: [...g.rotation.slice(k), ...g.rotation.slice(0, k)] };
}

/** Optional overrides of the mode's timings (tests; offline only). */
export interface CfgOverrides {
  matchTics?: number; interTics?: number; roundTics?: number; freezeTics?: number; roundsToWin?: number; tickets?: number;
  /** battle royale (rules block, sim_version >= 9): the lobby's length */
  lobbyTics?: number;
}

/**
 * world_new_cfg words (DESIGN.md "ABI additions (v2)"): version 2, mode, slots, timings
 * (0 = the mode's default), friendly fire, the rotation's map ids, seed, flags.
 */
export function cfgWords(g: RoomGame, mapIds: readonly number[], seed: number, o: CfgOverrides = {}, withRules = false): Uint32Array {
  // a mod's rules (MODINFO `rules`) as the rules block after the flags word (sim_version >= 9)
  const extra = new Map<number, number>();
  if (o.lobbyTics !== undefined) extra.set(RULE.lobbyTics, o.lobbyTics);
  const rules = withRules && (g.mod?.info?.rules || extra.size) ? rulesBlock(g.mod?.info?.rules, extra) : [];
  return Uint32Array.from([
    2, g.mode.id, g.slots,
    o.matchTics ?? 0, o.interTics ?? 0, o.roundTics ?? 0, o.freezeTics ?? 0, o.roundsToWin ?? 0, o.tickets ?? 0,
    0,
    mapIds.length, ...mapIds,
    seed >>> 0,
    (g.bosses ? 1 : 0) | (g.ghosts ? 2 : 0),
    ...(rules.length > 1 ? rules : []),
  ]);
}

/** The map a room is probably on now: its rotation at (age / match length), else the first. */
export function guessMap(g: RoomGame, ageSeconds: number | null): string {
  if (ageSeconds === null || !(ageSeconds >= 0)) return g.rotation[0];
  return g.rotation[Math.floor(ageSeconds / g.mode.matchSeconds) % g.rotation.length];
}
