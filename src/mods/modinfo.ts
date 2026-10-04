/**
 * Mods (DESIGN.md "Mods: one file per mod"): a PWAD with one map, its art and a
 * MODINFO lump (UTF-8 JSON). This module reads MODINFO and turns its `rules` into the
 * rules block `world_new_cfg` takes after the flags word: `[count, (key, value) × count]`.
 *
 * Every client derives the same numbers from the same file, so lockstep holds.
 */
import type { Wad } from '../wad/index.js';

/** MODINFO `mode` → the room mode key (src/menu/modes.ts ModeKey). */
export const MOD_MODES = {
  'deathmatch': 'dm',
  'team-deathmatch': 'tdm',
  'elimination': 'elim',
  'war': 'war',
  'battle-royale': 'br',
} as const;
export type ModModeName = keyof typeof MOD_MODES;

export interface ZoneStageRule { wait?: number; shrink?: number; radius?: number; dps?: number }

export interface ModRules {
  matchSeconds?: number;
  lobbySeconds?: number;
  dropAltitude?: number;
  startBullets?: number;
  vehicles?: boolean;
  supplyDrops?: boolean;
  zone?: ZoneStageRule[];
  loot?: Partial<Record<LootName, number>>;
  roundSeconds?: number;
  freezeSeconds?: number;
  roundsToWin?: number;
  tickets?: number;
  friendlyFire?: boolean;
}

export interface ModInfo {
  format: 1;
  id: string;
  title: string;
  author: string;
  license?: string;
  description?: string;
  mode: ModModeName;
  map: string;
  slots?: number;
  ghosts?: boolean;
  bosses?: boolean;
  rules?: ModRules;
}

/** An installed mod as public/mods/index.json lists it. */
export interface ModEntry {
  id: string;
  title: string;
  author: string;
  mode: ModModeName;
  map: string;
  slots: number;
  bytes?: number;
  description?: string;
  ghosts?: boolean;
  bosses?: boolean;
  /** the parsed MODINFO, once the file has been read (rules for the world config) */
  info?: ModInfo;
}

/**
 * Loot rows in the sim's table order (DESIGN.md "Battle royale" "As implemented", then
 * v2's sniper and grenade pack): `rules.loot` key → rules key 64 + index.
 */
export const LOOT_ROWS = [
  'healthBonus', 'armorBonus', 'stimpack', 'medikit', 'greenArmor', 'blueArmor',
  'shotgun', 'superShotgun', 'chaingun', 'rocketLauncher', 'plasma', 'bfg',
  'bullets', 'shells', 'rockets', 'cells', 'backpack', 'berserk', 'soulsphere',
  'sniper', 'grenades',
] as const;
export type LootName = typeof LOOT_ROWS[number];

const ID_RE = /^[a-z0-9]{2,16}$/;
const TICS = 35;

/** Rules block keys (DESIGN.md "Rules to the sim"). */
export const RULE = {
  matchTics: 1, lobbyTics: 2, dropAlt: 3, startBullets: 4, vehicles: 5, supplyDrops: 6, zoneStages: 7,
  zoneBase: 8, lootBase: 64, roundTics: 100, freezeTics: 101, roundsToWin: 102, tickets: 103, friendlyFire: 104,
} as const;
export const MAX_ZONE_STAGES = 8;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const u32 = (v: number): number => Math.max(0, Math.min(0x7fffffff, Math.round(v)));

/** Reads and checks MODINFO JSON; throws with a readable message when it is not a mod. */
export function parseModInfo(json: string): ModInfo {
  let j: unknown;
  try { j = JSON.parse(json); } catch (e) { throw new Error(`MODINFO is not JSON: ${e instanceof Error ? e.message : String(e)}`); }
  if (!j || typeof j !== 'object') throw new Error('MODINFO must be a JSON object');
  const o = j as Record<string, unknown>;
  if (o.format !== 1) throw new Error('MODINFO format must be 1');
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) throw new Error('MODINFO id must be 2-16 of a-z 0-9');
  if (typeof o.mode !== 'string' || !(o.mode in MOD_MODES)) throw new Error(`MODINFO mode must be one of ${Object.keys(MOD_MODES).join(', ')}`);
  if (typeof o.map !== 'string' || !/^[A-Z0-9_]{1,8}$/i.test(o.map)) throw new Error('MODINFO map must name the map lump (e.g. "BR01")');
  const str = (k: string, d = ''): string => (typeof o[k] === 'string' ? (o[k] as string).slice(0, 200) : d);
  const slots = num(o.slots);
  return {
    format: 1, id: o.id, title: str('title', o.id), author: str('author', 'unknown'),
    license: str('license') || undefined, description: str('description') || undefined,
    mode: o.mode as ModModeName, map: o.map.toUpperCase(),
    slots: slots !== undefined ? Math.max(2, Math.min(200, Math.round(slots))) : undefined,
    ghosts: typeof o.ghosts === 'boolean' ? o.ghosts : undefined,
    bosses: typeof o.bosses === 'boolean' ? o.bosses : undefined,
    rules: o.rules && typeof o.rules === 'object' ? o.rules as ModRules : undefined,
  };
}

/** MODINFO of a mod's WAD, or null when it has none. */
export function readModInfo(wad: Wad): ModInfo | null {
  const lump = wad.get('MODINFO');
  if (!lump) return null;
  return parseModInfo(new TextDecoder().decode(lump));
}

/** `rules` → `[count, (key, value) × count]` (u32 words appended to world_new_cfg after the flags). */
export function rulesBlock(rules: ModRules | undefined, extra: ReadonlyMap<number, number> = new Map()): number[] {
  const kv: [number, number][] = [];
  const done = (): number[] => {
    const out = kv.filter(([k]) => !extra.has(k));
    for (const [k, v] of extra) out.push([k, u32(v)]);
    return [out.length, ...out.flat()];
  };
  if (!rules) return done();
  const put = (key: number, v: number | undefined, scale = 1): void => { if (v !== undefined) kv.push([key, u32(v * scale)]); };
  const bool = (key: number, v: unknown): void => { if (typeof v === 'boolean') kv.push([key, v ? 1 : 0]); };
  put(RULE.matchTics, num(rules.matchSeconds), TICS);
  put(RULE.lobbyTics, num(rules.lobbySeconds), TICS);
  put(RULE.dropAlt, num(rules.dropAltitude));
  put(RULE.startBullets, num(rules.startBullets));
  bool(RULE.vehicles, rules.vehicles);
  bool(RULE.supplyDrops, rules.supplyDrops);
  if (Array.isArray(rules.zone)) {
    const stages = rules.zone.slice(0, MAX_ZONE_STAGES);
    kv.push([RULE.zoneStages, stages.length]);
    stages.forEach((st, i) => {
      const s = (st ?? {}) as ZoneStageRule;
      const k = RULE.zoneBase + 4 * i;
      put(k, num(s.wait), TICS);
      put(k + 1, num(s.shrink), TICS);
      // percent of the stage-0 radius → per mille
      const r = num(s.radius);
      if (r !== undefined) kv.push([k + 2, u32(Math.max(0, Math.min(100, r)) * 10)]);
      put(k + 3, num(s.dps));
    });
  }
  if (rules.loot && typeof rules.loot === 'object') {
    for (const [name, w] of Object.entries(rules.loot)) {
      const i = LOOT_ROWS.indexOf(name as LootName);
      const v = num(w);
      // weights in percent → half-percent units
      if (i >= 0 && v !== undefined) kv.push([RULE.lootBase + i, u32(v * 2)]);
    }
  }
  put(RULE.roundTics, num(rules.roundSeconds), TICS);
  put(RULE.freezeTics, num(rules.freezeSeconds), TICS);
  put(RULE.roundsToWin, num(rules.roundsToWin));
  put(RULE.tickets, num(rules.tickets));
  bool(RULE.friendlyFire, rules.friendlyFire);
  return done();
}
