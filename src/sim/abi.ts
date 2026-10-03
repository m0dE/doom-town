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
  world_free(h: number): void;
  world_clone(h: number): number;
  world_serialize(h: number): number;
  world_buf_ptr(): number;
  world_deserialize(map: number, ptr: number, len: number): number;
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
} as const;
export const PLAYER_WORDS = 48;

/** PlayerRow: 8 i32 per slot. */
export const ROW_WORDS = 8;
export const R_SLOT = 0, R_HUMAN = 1, R_MOBJ = 2, R_FRAGS = 3, R_DEATHS = 4, R_HEALTH = 5, R_STATE = 6, R_COLOR = 7;

/** Event: 8 i32. */
export const EVENT_WORDS = 8;
export const EV_SOUND = 1, EV_OBITUARY = 2, EV_PICKUP = 3, EV_DAMAGE = 4, EV_SPAWN = 5, EV_SWITCH = 6, EV_MATCH_START = 7, EV_MATCH_END = 8;

/** Doom mobj flags the shell reads. */
export const MF_SHOOTABLE = 0x4, MF_MISSILE = 0x10000, MF_SHADOW = 0x40000, MF_CORPSE = 0x100000;

/**
 * Instantiate the module. Whatever the binary imports (a panic hook, a log) is
 * satisfied with a stub that reports, so a sim built with or without them loads.
 */
export async function instantiateSim(source: Response | Promise<Response> | ArrayBuffer | Uint8Array): Promise<DoomSimExports> {
  let module: WebAssembly.Module;
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
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
