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
 *   na-boss-1, na-tdm-boss-1  + Random bosses        (boss, bosses) - Deathmatch and TDM only
 */
import { ROTATIONS, type RotationKey } from '../sim/maps.js';

export type ModeKey = 'dm' | 'tdm' | 'elim' | 'war';

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
};

export const MODE_ORDER: readonly ModeKey[] = ['dm', 'tdm', 'elim', 'war'];

export interface RoomGame {
  mode: ModeInfo;
  bosses: boolean;
  slots: number;
  rotation: readonly string[];
  /** "Team Deathmatch · Random bosses" */
  label: string;
  /** the word(s) a regional room name carries for this game: '', 'tdm', 'boss', 'tdm-boss', ... */
  kind: string;
}

const WORDS: Record<string, ModeKey> = {
  tdm: 'tdm', team: 'tdm', teams: 'tdm',
  elim: 'elim', elimination: 'elim', cs: 'elim', rounds: 'elim',
  war: 'war', conquest: 'war',
};

export function gameFor(mode: ModeKey, bosses: boolean): RoomGame {
  const m = MODES[mode];
  const b = bosses && (mode === 'dm' || mode === 'tdm');
  const kind = [mode === 'dm' ? '' : mode, b ? 'boss' : ''].filter(Boolean).join('-');
  return { mode: m, bosses: b, slots: m.slots, rotation: ROTATIONS[m.rotation], label: b ? `${m.label} · Random bosses` : m.label, kind };
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
  for (const w of name.toLowerCase().split(/[-_\s]+/)) {
    if (WORDS[w] && mode === 'dm') mode = WORDS[w];
    if (w === 'boss' || w === 'bosses') bosses = true;
  }
  const g = gameFor(mode, bosses);
  const k = rotationStart(name.toLowerCase(), g.rotation.length);
  return { ...g, rotation: [...g.rotation.slice(k), ...g.rotation.slice(0, k)] };
}

/** Optional overrides of the mode's timings (tests; offline only). */
export interface CfgOverrides { matchTics?: number; interTics?: number; roundTics?: number; freezeTics?: number; roundsToWin?: number; tickets?: number }

/**
 * world_new_cfg words (DESIGN.md "ABI additions (v2)"): version 2, mode, slots, timings
 * (0 = the mode's default), friendly fire, the rotation's map ids, seed, flags.
 */
export function cfgWords(g: RoomGame, mapIds: readonly number[], seed: number, o: CfgOverrides = {}): Uint32Array {
  return Uint32Array.from([
    2, g.mode.id, g.slots,
    o.matchTics ?? 0, o.interTics ?? 0, o.roundTics ?? 0, o.freezeTics ?? 0, o.roundsToWin ?? 0, o.tickets ?? 0,
    0,
    mapIds.length, ...mapIds,
    seed >>> 0,
    g.bosses ? 1 : 0,
  ]);
}

/** The map a room is probably on now: its rotation at (age / match length), else the first. */
export function guessMap(g: RoomGame, ageSeconds: number | null): string {
  if (ageSeconds === null || !(ageSeconds >= 0)) return g.rotation[0];
  return g.rotation[Math.floor(ageSeconds / g.mode.matchSeconds) % g.rotation.length];
}
