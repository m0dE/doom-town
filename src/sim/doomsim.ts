/**
 * The Rust sim (public/doomsim.wasm) as arrr-network's `lockstep.Sim`.
 *
 * The world lives in wasm memory; the TS state is a handle plus the slot table
 * (slot → player id). Every client runs the same calls in the same order, so
 * the slot a joining player takes is a pure function of the ordered stream:
 * `world_free_slot` (the lowest bot slot) at the moment its join is applied.
 *
 * Prediction: the SDK builds the predicted world as `deserialize(serialize(s))`.
 * `serialize` hands back a payload that remembers the live world it came from,
 * and `deserialize` of that payload - while the world is still exactly as it
 * was - is `world_clone`, a memcpy in wasm, rather than an encode and a decode.
 * The base64 is only produced when something actually reads `w` (a snapshot
 * going on the wire).
 */
import type { lockstep } from 'arrr-network';
import {
  instantiateSim, copyCounted, copyI32, readNames,
  type DoomSimExports, EVENT_WORDS, MOBJ_WORDS, PLAYER_WORDS, PV, ROW_WORDS,
} from './abi.js';
import { MAP_LUMP, SLOTS, TICRATE } from './map.js';

declare const __BUILD_REV__: string;

export interface DoomState {
  /** World handle in the wasm module; 0 once disposed. */
  h: number;
  /** slot → player id ('' for a bot-driven slot). Part of the hash. */
  ids: string[];
  /**
   * Events from the last `step` (every tic of it, in order). Not hashed, not
   * serialized: what this world just did, for whoever reads it next.
   */
  ev: Int32Array;
}

/** What goes on the wire for a snapshot: `w` is the world, base64. */
export interface DoomSnapshot { w: string; ids: string[] }

/** A cmd as the sim takes it (DESIGN.md `world_set_cmd`). */
export interface Cmd { angle: number; pitch: number; forward: number; side: number; buttons: number }

const SRC = Symbol('doomsim.src');
interface Source { sim: DoomSim; h: number; tic: number; hash: number; bytes: Uint8Array }

const EMPTY = new Int32Array(0);

/** One loaded module + map. Many worlds may live in it at once (confirmed, predicted, test peers). */
export class DoomSim {
  readonly spriteNames: string[];
  readonly soundNames: string[];
  readonly textureNames: string[];
  readonly flatNames: string[];
  readonly version: number;
  /** Worlds alive in this module, so a stale handle is never cloned. */
  private readonly live = new Set<number>();

  private constructor(readonly ex: DoomSimExports, readonly mapId: number) {
    this.spriteNames = readNames(ex, ex.sim_sprite_names());
    this.soundNames = readNames(ex, ex.sim_sound_names());
    this.textureNames = readNames(ex, ex.world_map_texture_names(mapId));
    this.flatNames = readNames(ex, ex.world_map_flat_names(mapId));
    this.version = ex.sim_version() >>> 0;
  }

  /** Instantiate the wasm and load one map (a PWAD from `mapPwad`). */
  static async create(wasm: Parameters<typeof instantiateSim>[0], pwad: Uint8Array, map = MAP_LUMP): Promise<DoomSim> {
    const ex = await instantiateSim(wasm);
    const ptr = ex.alloc(pwad.length);
    new Uint8Array(ex.memory.buffer, ptr, pwad.length).set(pwad);
    const id = ex.map_load(ptr, pwad.length);
    ex.dealloc(ptr, pwad.length);
    if (id < 0) throw new Error(`the sim refused ${map} (error ${id})`);
    return new DoomSim(ex, id);
  }

  // ------------------------------------------------------------------ worlds

  newWorld(seed: number, slots = SLOTS): number {
    const h = this.ex.world_new(this.mapId, seed >>> 0, slots);
    if (h <= 0) throw new Error(`world_new failed (${h})`);
    this.live.add(h);
    return h;
  }

  clone(h: number): number {
    const h2 = this.ex.world_clone(h);
    if (h2 <= 0) throw new Error(`world_clone failed (${h2})`);
    this.live.add(h2);
    return h2;
  }

  free(h: number): void {
    if (!this.live.delete(h)) return;
    this.ex.world_free(h);
  }

  isLive(h: number): boolean { return this.live.has(h); }

  serialize(h: number): Uint8Array {
    const len = this.ex.world_serialize(h);
    return new Uint8Array(this.ex.memory.buffer, this.ex.world_buf_ptr(), len).slice();
  }

  deserialize(bytes: Uint8Array): number {
    const ptr = this.ex.alloc(bytes.length);
    new Uint8Array(this.ex.memory.buffer, ptr, bytes.length).set(bytes);
    const h = this.ex.world_deserialize(ptr, bytes.length);
    this.ex.dealloc(ptr, bytes.length);
    if (h <= 0) throw new Error('world_deserialize refused the snapshot');
    this.live.add(h);
    return h;
  }

  hash(h: number): number { return this.ex.world_hash(h) >>> 0; }
  tic(h: number): number { return this.ex.world_tic(h) >>> 0; }
  tick(h: number): void { this.ex.world_tick(h); }
  freeSlot(h: number): number { return this.ex.world_free_slot(h); }
  join(h: number, slot: number): void { this.ex.world_human_join(h, slot); }
  leave(h: number, slot: number): void { this.ex.world_human_leave(h, slot); }
  idle(h: number, slot: number): void { this.ex.world_human_idle(h, slot); }
  setCmd(h: number, slot: number, c: Cmd): void {
    this.ex.world_set_cmd(h, slot, c.angle, c.pitch, c.forward, c.side, c.buttons);
  }

  // ------------------------------------------------------------------ views (copies)

  /** count × 12 words (MobjView). */
  mobjs(h: number): Int32Array { return copyCounted(this.ex, this.ex.world_view_mobjs(h), MOBJ_WORDS); }
  /** One PlayerView (PLAYER_WORDS = 51 words in v2). */
  player(h: number, slot: number): Int32Array { return copyI32(this.ex, this.ex.world_view_player(h, slot), PLAYER_WORDS); }
  /** count(=slots) × 8 words (PlayerRow). */
  players(h: number): Int32Array { return copyCounted(this.ex, this.ex.world_view_players(h), ROW_WORDS); }
  /** count × 5 words: floor, ceil, light, floorpic, ceilpic. */
  sectors(h: number): Int32Array { return copyCounted(this.ex, this.ex.world_view_sectors(h), 5); }
  /** count × 3 words: top, mid, bottom texture of side 0. */
  lines(h: number): Int32Array { return copyCounted(this.ex, this.ex.world_view_lines(h), 3); }
  /** Events of the last world_tick: count × 8 words. */
  events(h: number): Int32Array { return copyCounted(this.ex, this.ex.world_events(h), EVENT_WORDS); }
}

// ---------------------------------------------------------------------- input on the wire

/** The sim-side check: a gameplay payload is `{ c: [5 ints] }`, nothing else. */
export function isGameplayInput(data: unknown): boolean {
  return typeof data === 'object' && data !== null && Array.isArray((data as { c?: unknown }).c);
}

const clampInt = (v: unknown, lo: number, hi: number): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  return n < lo ? lo : n > hi ? hi : n;
};

/** Validate and range-limit a wire cmd. Null when it is not one. */
export function decodeCmd(data: unknown): Cmd | null {
  if (!isGameplayInput(data)) return null;
  const c = (data as { c: unknown[] }).c;
  if (c.length !== 5) return null;
  const angle = clampInt(c[0], 0, 0xffff);
  const pitch = clampInt(c[1], -32768, 32767);
  const forward = clampInt(c[2], -50, 50);
  const side = clampInt(c[3], -40, 40);
  let buttons = clampInt(c[4], 0, 0x3ff);
  if (angle === null || pitch === null || forward === null || side === null || buttons === null) return null;
  // Weapon select is 0..9 in bits 4..7; 10..15 means nothing.
  if (((buttons >> 4) & 15) > 9) buttons &= ~0xf0;
  return { angle, pitch, forward, side, buttons };
}

export function encodeCmd(c: Cmd): { c: [number, number, number, number, number] } {
  return { c: [c.angle & 0xffff, c.pitch | 0, c.forward | 0, c.side | 0, c.buttons & 0x3ff] };
}

// ---------------------------------------------------------------------- base64

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------- the lockstep app

export interface DoomApp extends lockstep.Sim<DoomState, unknown> {
  readonly name: string;
  readonly version: string;
  readonly sim: DoomSim;
  /** Sim tics per network frame: max(1, round(35 / node fps)). Set at connect, before any step. */
  ticsPerFrame: number;
  isGameplayInput(data: unknown): boolean;
  slotOf(s: DoomState, id: string): number;
  /** Counters for tests: how often prediction took the clone path vs the byte path. */
  readonly stats: { clones: number; decodes: number; encodes: number };
}

/**
 * The lockstep app's name, and the room namespace suffix: rooms are `${room}-${APP_NAME}`.
 * One constant for both (src/menu/rooms.ts imports it), so they cannot drift apart.
 */
export const APP_NAME = 'doom-town';

export function ticsPerFrameFor(fps: number): number {
  return Math.max(1, Math.round(TICRATE / Math.max(1, fps)));
}

export function createDoomApp(sim: DoomSim, opts: { slots?: number; rev?: string } = {}): DoomApp {
  const slots = opts.slots ?? SLOTS;
  const rev = opts.rev ?? (typeof __BUILD_REV__ === 'string' ? __BUILD_REV__ : 'dev');
  const stats = { clones: 0, decodes: 0, encodes: 0 };

  const slotOf = (s: DoomState, id: string): number => (id ? s.ids.indexOf(id) : -1);

  const app: DoomApp = {
    name: APP_NAME,
    version: `doomsim-${sim.version}+${rev}`,
    sim,
    ticsPerFrame: 1,
    stats,
    isGameplayInput,
    slotOf,

    init(ctx) {
      const h = sim.newWorld(ctx.seed, slots);
      const s: DoomState = { h, ids: new Array<string>(slots).fill(''), ev: EMPTY };
      for (const id of ctx.roster) app.addPlayer!(s, id, { frame: ctx.frame, player: '', roster: ctx.roster, rng: () => 0 });
      return s;
    },

    addPlayer(s, id) {
      let slot = slotOf(s, id);
      if (slot < 0) {
        slot = sim.freeSlot(s.h);
        if (slot < 0 || slot >= s.ids.length) return;   // every slot is human: a spectator
        s.ids[slot] = id;
      }
      // A reconnect lands here with its slot kept: the sim makes it human again.
      sim.join(s.h, slot);
    },

    removePlayer(s, id) {
      const slot = slotOf(s, id);
      if (slot < 0) return;
      sim.leave(s.h, slot);
      s.ids[slot] = '';
    },

    disconnectPlayer(s, id) {
      const slot = slotOf(s, id);
      if (slot >= 0) sim.idle(s.h, slot);
    },

    applyInput(s, data, _ctx, sender) {
      if (!sender) return;
      const cmd = decodeCmd(data);
      if (!cmd) return;
      const slot = slotOf(s, sender);
      if (slot < 0) return;
      sim.setCmd(s.h, slot, cmd);
    },

    step(s) {
      const n = app.ticsPerFrame;
      if (n === 1) {
        sim.tick(s.h);
        s.ev = sim.events(s.h);
        return;
      }
      const parts: Int32Array[] = [];
      let len = 0;
      for (let i = 0; i < n; i++) {
        sim.tick(s.h);
        const e = sim.events(s.h);
        parts.push(e);
        len += e.length;
      }
      const ev = new Int32Array(len);
      let at = 0;
      for (const p of parts) { ev.set(p, at); at += p.length; }
      s.ev = ev;
    },

    hash(s) {
      // The world's own hash, then the slot table over it (FNV-1a).
      let h = sim.hash(s.h) ^ 0x811c9dc5;
      for (let i = 0; i < s.ids.length; i++) {
        const id = s.ids[i];
        if (!id) continue;
        h = Math.imul(h ^ i, 16777619);
        for (let k = 0; k < id.length; k++) h = Math.imul(h ^ id.charCodeAt(k), 16777619);
      }
      return h >>> 0;
    },

    serialize(s): DoomSnapshot {
      // The bytes are taken now (a memcpy out of wasm, ~1 ms for a full room):
      // a transport may hold the payload and read it later, after this world
      // has stepped on. Only the base64 is deferred until something reads `w`.
      const bytes = sim.serialize(s.h);
      const src: Source = { sim, h: s.h, tic: sim.tic(s.h), hash: sim.hash(s.h), bytes };
      let text: string | null = null;
      const out = { ids: [...s.ids] } as DoomSnapshot;
      Object.defineProperty(out, 'w', {
        enumerable: true,
        get() {
          if (text === null) { stats.encodes++; text = toBase64(bytes); }
          return text;
        },
      });
      Object.defineProperty(out, SRC, { value: src, enumerable: false });
      return out;
    },

    deserialize(json) {
      const snap = json as DoomSnapshot & { [SRC]?: Source };
      if (!snap || !Array.isArray(snap.ids)) throw new Error('doomsim: not a snapshot');
      const ids = snap.ids.map((x) => (typeof x === 'string' ? x : ''));
      const src = snap[SRC];
      if (src && src.sim === sim) {
        // Our own payload, straight back (the prediction's rebuild): a clone
        // while the world it names is untouched, else the bytes it captured.
        if (sim.isLive(src.h) && sim.tic(src.h) === src.tic && sim.hash(src.h) === src.hash) {
          stats.clones++;
          return { h: sim.clone(src.h), ids, ev: EMPTY };
        }
        stats.decodes++;
        return { h: sim.deserialize(src.bytes), ids, ev: EMPTY };
      }
      if (typeof snap.w !== 'string') throw new Error('doomsim: snapshot has no world');
      stats.decodes++;
      return { h: sim.deserialize(src ? src.bytes : fromBase64(snap.w)), ids, ev: EMPTY };
    },

    dispose(s) {
      if (s.h) sim.free(s.h);
      s.h = 0;
    },

    fingerprint(s, player) {
      const slot = slotOf(s, player);
      if (slot < 0) return '-';
      const p = sim.player(s.h, slot);
      // Whole map units: the sim is fixed point and bit-exact, so anything a
      // player could see differ is a real misprediction.
      return `${slot},${p[PV.state]},${p[PV.x] >> 16},${p[PV.y] >> 16},${p[PV.z] >> 16},${p[PV.health]},${p[PV.ready]}`;
    },

    status(s) {
      return { tic: sim.tic(s.h), humans: s.ids.filter(Boolean).length };
    },
  };
  return app;
}
