/**
 * The wasm ABI (DESIGN.md "The wasm ABI"), typed, and nothing else.
 *
 * Every pointer the sim hands back is into its linear memory and valid only
 * until the next call on that world, so every reader here COPIES what it
 * returns. `memory.buffer` is re-read after each call: a call may grow the
 * memory, which detaches every view made before it.
 */

export interface DoomSimExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  map_load(ptr: number, len: number): number;
  sim_sprite_names(): number;
  sim_sound_names(): number;
  sim_version(): number;
  world_new(map: number, seed: number, slots: number): number;
  /** v2: cfg = u32 words (src/menu/modes.ts cfgWords) */
  world_new_cfg(ptr: number, len: number): number;
  /** v2: 13 words, 6 per capture point, 5 boss words, BR_WORDS battle royale words (MV, BR below) */
  world_view_match(h: number): number;
  world_free(h: number): void;
  world_clone(h: number): number;
  world_serialize(h: number): number;
  world_buf_ptr(): number;
  /** v2: the snapshot records its map */
  world_deserialize(ptr: number, len: number): number;
  /** v2: the old form, map given (a snapshot from before maps were recorded) */
  world_deserialize_map?(map: number, ptr: number, len: number): number;
  world_hash(h: number): number;
  world_tic(h: number): number;
  world_human_join(h: number, slot: number): void;
  world_human_leave(h: number, slot: number): void;
  world_human_idle(h: number, slot: number): void;
  world_free_slot(h: number): number;
  world_set_cmd(h: number, slot: number, angle: number, pitch: number, forward: number, side: number, buttons: number): void;
  world_tick(h: number): void;
  world_view_mobjs(h: number): number;
  world_view_player(h: number, slot: number): number;
  world_view_players(h: number): number;
  world_view_sectors(h: number): number;
  world_view_lines(h: number): number;
  world_map_texture_names(map: number): number;
  world_map_flat_names(map: number): number;
  world_events(h: number): number;
}

/** MobjView: 12 u32 words per mobj. */
export const MOBJ_WORDS = 12;
export const M_ID = 0, M_X = 1, M_Y = 2, M_Z = 3, M_ANGLE = 4, M_SPRITE = 5, M_FLAGS = 6, M_TYPE = 7,
  M_RADIUS = 8, M_HEIGHT = 9, M_MOMX = 10, M_MOMY = 11;

/** PlayerView word indices. */
export const PV = {
  slot: 0, mobj: 1, state: 2, x: 3, y: 4, z: 5, viewz: 6, angle: 7, pitch: 8,
  health: 9, armor: 10, armortype: 11, ready: 12, pending: 13, owned: 14,
  ammo: 15, maxammo: 19, powers: 23, damagecount: 29, bonuscount: 30, extralight: 31, fixedcolormap: 32,
  frags: 33, deaths: 34, attacker: 35,
  psWeapon: 36, psWeaponSx: 37, psWeaponSy: 38, psFlash: 39, psFlashSx: 40, psFlashSy: 41,
  isHuman: 42, respawnReady: 43, matchTic: 44, matchPhase: 45, onground: 46, refire: 47,
  team: 48, respawnMask: 49, spectating: 50,
  /** battle royale v2 (sim_version 9): 0 none, 1 in the ship, 2 freefall, 3 parachute, 4 driving */
  air: 51, airX: 52, airY: 53, airZ: 54, vehicle: 55, grenades: 56,
} as const;
/** 57 since sim_version 9 (51 before) */
export const PLAYER_WORDS = 57;
export const AIR_NONE = 0, AIR_SHIP = 1, AIR_FREEFALL = 2, AIR_CHUTE = 3, AIR_VEHICLE = 4;

/** PlayerRow: 9 i32 per slot (v2 added team). */
export const ROW_WORDS = 9;
export const R_SLOT = 0, R_HUMAN = 1, R_MOBJ = 2, R_FRAGS = 3, R_DEATHS = 4, R_HEALTH = 5, R_STATE = 6, R_COLOR = 7, R_TEAM = 8;

/** Event: 8 i32. */
export const EVENT_WORDS = 8;
export const EV_SOUND = 1, EV_OBITUARY = 2, EV_PICKUP = 3, EV_DAMAGE = 4, EV_SPAWN = 5, EV_SWITCH = 6, EV_MATCH_START = 7, EV_MATCH_END = 8;
export const EV_MAP_CHANGE = 9, EV_ROUND_START = 10, EV_ROUND_END = 11, EV_POINT_CAPTURED = 12, EV_TICKETS_LOW = 13, EV_BOSS_SPAWN = 14, EV_BOSS_KILLED = 15;

/** world_view_match words (DESIGN.md "ABI additions (v2)"). */
export const MV = {
  mode: 0, phase: 1, phaseLeft: 2, matchIndex: 3, map: 4, nextMap: 5, scoreRed: 6, scoreBlue: 7,
  round: 8, aliveRed: 9, aliveBlue: 10, winner: 11, points: 12,
} as const;
/** per capture point, after MV.points: x, y, radius (fixed), owner (-1/0/1), progress (-100 red..100 blue), flags (1 red in, 2 blue in) */
export const POINT_WORDS = 6;
/** after the points: boss mobj id, boss type, health, max health, tics to the next boss (-1 none) */
export const BOSS_WORDS = 5;
/**
 * After the boss words, always present (zeros outside battle royale): the zone and the
 * alive count. x/y/radius are fixed point; the current radius is interpolated while
 * shrinking. stage 1..n, n+1 = closed (6 with the default 5 stages); state 0 waiting,
 * 1 shrinking, 2 closed. sim_version 9 adds 11..18: lobby/drop tics left, the ship's
 * x, y and direction (fixed unit vector) during the drop, the supply drop's x, y and
 * state (0 none, 1 incoming, 2 landed). 11 words before sim_version 9.
 */
export const BR_WORDS = 19;
export const BR = {
  zoneX: 0, zoneY: 1, zoneR: 2, nextX: 3, nextY: 4, nextR: 5,
  stage: 6, state: 7, stateLeft: 8, alive: 9, damage: 10,
  phaseLeft: 11, shipX: 12, shipY: 13, shipDirX: 14, shipDirY: 15, supplyX: 16, supplyY: 17, supplyState: 18,
} as const;
export const ZONE_WAITING = 0, ZONE_SHRINKING = 1, ZONE_CLOSED = 2;
/** battle royale events: 16 zone (a stage, b state, c tics until it ends, x/y centre),
 * 17 crate opened (a opener slot or -1, b things spilled, c 1 = supply crate, x/y/z crate
 * centre), 18 supply drop incoming (a stage, b tics until it lands, x/y). Event 5 spawn
 * has b = 2 for a parachute landing. */
export const EV_ZONE = 16, EV_CRATE = 17, EV_SUPPLY = 18;
/** means of death: 16 caught outside the zone, 17 run over, 18 grenade, 19 sniper rifle */
export const MOD_ZONE = 16, MOD_ROADKILL = 17, MOD_GRENADE = 18, MOD_SNIPER = 19;
/** pickup message ids added by battle royale v2 */
export const MSG_SNIPER = 32, MSG_GRENADES = 33;
/** mobjtypes (things 9020 crate, 9040 buggy, 9050 sniper, 9051 grenade pack; 9030 = lobby spot) */
export const MT_CRATE = 137, MT_DROPSHIP = 138, MT_PARACHUTER = 139, MT_BUGGY = 140, MT_SNIPER = 141, MT_GRENADE = 142, MT_GRENADEPACK = 143;
/** weapontype of the sniper rifle (key 2 toggles pistol / sniper) */
export const WP_SNIPER = 9;
/** MobjView flags: a supply-drop crate */
export const MF_SUPPLY = 0x20000000;
/** ticcmd buttons */
export const BT_ATTACK = 1, BT_USE = 2, BT_JUMP = 4, BT_ZOOM = 8, BT_GRENADE = 1 << 10;
/** game modes (world_view_match word 0) */
export const MODE_FFA = 0, MODE_TDM = 1, MODE_ELIM = 2, MODE_WAR = 3, MODE_BR = 4;
/** match phases */
export const PHASE_PLAY = 0, PHASE_FREEZE = 1, PHASE_ROUND_OVER = 2, PHASE_INTERMISSION = 3, PHASE_LOBBY = 4, PHASE_DROP = 5;

/** Doom mobj flags the shell reads. */
export const MF_SHOOTABLE = 0x4, MF_MISSILE = 0x10000, MF_SHADOW = 0x40000, MF_CORPSE = 0x100000;

/**
 * Instantiate the module. Whatever the binary imports (a panic hook, a log) is
 * satisfied with a stub that reports, so a sim built with or without them loads.
 */
export async function compileSim(source: Response | Promise<Response> | ArrayBuffer | Uint8Array): Promise<WebAssembly.Module> {
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) return WebAssembly.compile(source as BufferSource);
  const res = await source;
  if (!res.ok) throw new Error(`doomsim.wasm: HTTP ${res.status}`);
  try {
    return await WebAssembly.compileStreaming(res.clone());
  } catch {
    return WebAssembly.compile(await res.arrayBuffer());
  }
}

export async function instantiateSim(source: Response | Promise<Response> | ArrayBuffer | Uint8Array | WebAssembly.Module): Promise<DoomSimExports> {
  let module: WebAssembly.Module;
  if (source instanceof WebAssembly.Module) {
    module = source;
  } else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    module = await WebAssembly.compile(source as BufferSource);
  } else {
    const res = await source;
    if (!res.ok) throw new Error(`doomsim.wasm: HTTP ${res.status}`);
    // Streaming compile needs the right MIME type; a static host that serves
    // octet-stream gets the buffered path instead of an error.
    try {
      module = await WebAssembly.compileStreaming(res.clone());
    } catch {
      module = await WebAssembly.compile(await res.arrayBuffer());
    }
  }
  let memory: WebAssembly.Memory | null = null;
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    const ns = (imports[imp.module] ??= {});
    if (imp.kind !== 'function') continue;
    ns[imp.name] = (...args: number[]) => {
      // A string-ish (ptr, len) pair is the common shape for a log or a panic message.
      if (memory && args.length >= 2 && args[1] > 0 && args[1] < 4096) {
        const text = new TextDecoder().decode(new Uint8Array(memory.buffer, args[0], args[1]));
        console.warn(`[doomsim] ${imp.name}: ${text}`);
      } else {
        console.warn(`[doomsim] ${imp.module}.${imp.name}(${args.join(', ')})`);
      }
      return 0;
    };
  }
  const instance = await WebAssembly.instantiate(module, imports);
  const ex = instance.exports as unknown as DoomSimExports;
  memory = ex.memory;
  for (const k of ['alloc', 'map_load', 'world_new', 'world_tick', 'world_hash', 'world_serialize', 'world_deserialize', 'world_view_mobjs', 'world_view_player', 'world_events'] as const) {
    if (typeof ex[k] !== 'function') throw new Error(`doomsim.wasm does not export ${k}`);
  }
  return ex;
}

/** Copy `count` i32s out of wasm memory. */
export function copyI32(ex: DoomSimExports, ptr: number, count: number): Int32Array {
  return new Int32Array(ex.memory.buffer, ptr, count).slice();
}

/** `u32 count` then `count × words` i32s. */
export function copyCounted(ex: DoomSimExports, ptr: number, words: number): Int32Array {
  const n = new Uint32Array(ex.memory.buffer, ptr, 1)[0];
  return new Int32Array(ex.memory.buffer, ptr + 4, n * words).slice();
}

/** A name list as sim/src/abi.rs writes it: `u32 count`, then `count` NUL-terminated names. */
export function readNames(ex: DoomSimExports, ptr: number): string[] {
  if (!ptr) return [];
  const mem = new Uint8Array(ex.memory.buffer);
  const count = new DataView(ex.memory.buffer).getUint32(ptr, true);
  const out: string[] = [];
  let at = ptr + 4;
  for (let i = 0; i < count && at < mem.length; i++) {
    let s = '';
    while (at < mem.length && mem[at] !== 0) s += String.fromCharCode(mem[at++]);
    at++;
    out.push(s);
  }
  return out;
}
