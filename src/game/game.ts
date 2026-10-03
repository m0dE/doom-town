/**
 * A match: the lockstep session, the rings it records, and the frame loop
 * that turns `lockstep.view(now)` into a RenderFrame, sounds and the HUD.
 *
 * The rules (harness/INTEGRATION.md, sdk/docs/lockstep.md):
 *   - ONE clock: `view(now)` at the rAF timestamp, once per frame; nothing
 *     drawn is timed from anything else.
 *   - everyone else from the CONFIRMED ring at `frame + alpha`;
 *   - the local player from the PREDICTED ring at `predictedFrame - 1 +
 *     selfAlpha` (the camera), with the mouse's own yaw/pitch so the view
 *     turns on the frame the mouse moves;
 *   - bodies are never extrapolated; a jump of more than 64 units in one tic
 *     (respawn, teleport) is drawn as a cut, not a line across the map;
 *     projectiles alone run on along their momentum.
 *   - rings are recorded from the tick callbacks, keyed by absolute frame.
 *
 * Sounds: the local player's own weapon sounds come off the predicted world
 * (so a shot is heard on the click), once per frame however often a rollback
 * replays it; everything else off confirmed frames, once each.
 */
import { lockstep, type IdentitySession } from 'arrr-network';
import { fetchMapArt, loadSim, loadWad, mapWad } from './assets.js';
import { createDoomApp, encodeCmd, type DoomApp, type DoomState } from '../sim/doomsim.js';
import {
  EVENT_WORDS, EV_MATCH_END, EV_MATCH_START, EV_OBITUARY, EV_PICKUP, EV_SOUND, EV_SWITCH,
  EV_MAP_CHANGE, EV_ROUND_START, EV_ROUND_END, EV_POINT_CAPTURED, EV_TICKETS_LOW, EV_BOSS_SPAWN, EV_BOSS_KILLED,
  MV, POINT_WORDS, PHASE_INTERMISSION, R_TEAM,
  MF_MISSILE, MOBJ_WORDS, M_ANGLE, M_FLAGS, M_ID, M_MOMX, M_MOMY, M_SPRITE, M_TYPE, M_X, M_Y, M_Z,
  PV, ROW_WORDS, R_DEATHS, R_FRAGS, R_HUMAN, R_COLOR,
} from '../sim/abi.js';
import { TICRATE } from '../sim/map.js';
import { ROTATIONS, mapTitle } from '../sim/maps.js';
import { cfgWords, roomGame, type CfgOverrides, type RoomGame } from '../menu/modes.js';
import { NetSession } from '../net/session.js';
import { APP_ID, API_KEY } from '../menu/rooms.js';
import { Input, MAX_PITCH } from '../input/input.js';
import { TicRing } from './ring.js';
import { Gfx } from '../hud/gfx.js';
import { Hud, type ModeHud, type ScoreRow } from '../hud/hud.js';
import { FaceWidget, pointToAngle } from '../hud/face.js';
import { obituaryTemplate, pickupMessage } from '../hud/strings.js';
import { botColor, clampColor, PLAYER_COLORS } from './colors.js';
import { botNames, botPing } from './names.js';
import { GameSound, type SoundOut } from './sound.js';
import { Renderer } from '../render/index.js';
import { MapView, type WarmView } from './view.js';
import { PauseMenu } from './pause.js';
import { ModelBodies, bodyDebug } from './bodies.js';
import { prefs, savePrefs, cleanName } from '../menu/prefs.js';
import { parseMap, SPRITE_NAMES, type Wad } from '../wad/index.js';
import type { RenderEvent, RenderFrame, RenderMobj, RenderSector } from '../render/types.js';

const { renderTimes } = lockstep;
const FRAC = 1 / 65536;
const BAM = (2 * Math.PI) / 4294967296;
/** A body that moved more than this in one tic teleported (DESIGN: 64 units). */
const TELEPORT = 64 * 65536;
/**
 * Our own projectiles (MT_ROCKET, MT_PLASMA, MT_BFG in mobjtype_t order). MobjView has
 * no owner, so a missile is ours when it first appears within OWN_RADIUS of our body in
 * the same world and tic (P_SpawnPlayerMissile spawns at the shooter and moves it at
 * most 1.5 x speed = 37.5 units before the tic ends).
 */
const OWN_TYPES = new Set([33, 34, 35]);
const OWN_RADIUS = 64 * 65536;
/** Snapshots: every 10 s of tics (DESIGN "Netcode numbers"). */
const SNAPSHOT_EVERY = TICRATE * 10;

export interface GameOptions {
  room: string;
  offline: boolean;
  name: string;
  color: number;
  identity?: IdentitySession;
  central?: string;
  nodeUrl?: string;
  host: HTMLElement;
  hud: HTMLElement;
  /** timing overrides for the world config (tests; honoured offline only) */
  overrides?: CfgOverrides;
}

/** mobjtype_t of the two bosses (DESIGN.md "Random bosses"). */
const MT_SPIDER = 19, MT_CYBORG = 21;
const TEAM_TINT: Record<number, string> = { 0: '#ff5a4a', 1: '#5aa0ff' };
/** PlayerView word 50: the slot a dead elimination player is watching (-1 none). */
const PV_SPECTATING = 50;
/** PlayerView word 49 (war): where a dead player may spawn — bit 0 the base, bit 1+i point i. */
const PV_RESPAWN_MASK = 49;
/** "1 BASE", "2 POINT A", ...: the weapon key picks the spawn (DESIGN.md, war). */
function spawnChoices(mask: number): string[] {
  const out: string[] = [];
  for (let bit = 0; bit < 9; bit++) {
    if (!(mask & (1 << bit))) continue;
    out.push(`${bit + 1} ${bit === 0 ? 'BASE' : `POINT ${String.fromCharCode(64 + bit)}`}`);
  }
  return out;
}
export const bossName = (type: number): string => (type === MT_SPIDER ? 'Spider Mastermind' : type === MT_CYBORG ? 'Cyberdemon' : 'demon');
/** Team colours: indices into PLAYER_COLORS (red, blue). */
const TEAM_COLOR = [3, 4];
const TEAM_NAME = ['Red', 'Blue'];

/** One confirmed frame, as the loop keeps it. */
interface Snap {
  mobjs: Int32Array;
  rows: Int32Array;
  sectors: Int32Array;
  /** Our PlayerView, when we have a slot. */
  me: Int32Array | null;
  /** world_view_match */
  match: Int32Array;
  mySlot: number;
  ids: string[];
  /** id → index into `mobjs`, built on first use. */
  index?: Map<number, number>;
}

function indexOf(s: Snap): Map<number, number> {
  if (s.index) return s.index;
  const m = new Map<number, number>();
  for (let i = 0, n = s.mobjs.length / MOBJ_WORDS; i < n; i++) m.set(s.mobjs[i * MOBJ_WORDS + M_ID], i);
  s.index = m;
  return m;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Shortest-way interpolation of BAM angles, to radians. */
function lerpAngle(a: number, b: number, t: number): number {
  const d = ((b - a) | 0);           // signed BAM difference
  return (((a >>> 0) + d * t) * BAM) % (2 * Math.PI);
}

function playerId(identity?: IdentitySession): string {
  if (identity) return identity.userId;
  try {
    const have = sessionStorage.getItem('freedm.pid');
    if (have) return have;
    const id = (crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, '').slice(0, 16);
    sessionStorage.setItem('freedm.pid', id);
    return id;
  } catch {
    return `p${Math.random().toString(36).slice(2, 12)}`;
  }
}

/** A frame that touches every material: the world, a marine, a weapon. */
function warmupFrame(wad: Wad, mapName: string): RenderFrame {
  const map = parseMap(mapName, wad.mapLumps(mapName));
  const start = map.things.find((t) => t.type === 1) ?? map.things[0] ?? { x: 0, y: 0, angle: 0 };
  const play = SPRITE_NAMES.indexOf('PLAY'), pisg = SPRITE_NAMES.indexOf('PISG');
  return {
    tic: 0,
    camera: { x: start.x, y: start.y, z: 41, yaw: (start.angle * Math.PI) / 180, pitch: 0 },
    mobjs: [{ id: 1, x: start.x + Math.cos((start.angle * Math.PI) / 180) * 96, y: start.y + Math.sin((start.angle * Math.PI) / 180) * 96, z: 0, angle: 0, sprite: play, frame: 0, flags: 0, type: 0, slot: 1, translation: 3 }],
    mobjCount: 1,
    sectors: null,
    lineTextures: null,
    player: { damagecount: 0, bonuscount: 0, extralight: 0, fixedcolormap: 0, powers: [0, 0, 0, 0, 0, 0], weapon: { sprite: pisg, frame: 0, sx: 0, sy: 32 }, flash: null },
    events: [],
  };
}

/** A renderer built while the menu is up, so Play does not wait on the atlas and the shaders. */
let warm: WarmView | null = null;
/** The map the start screen prewarms: Quick Play's (the deathmatch rotation's first). */
const WARM_MAP = ROTATIONS.deathmatch[0];

const EMPTY = new Int32Array(0);

/** Ids of the missiles that may be ours (OWN_TYPES), in world order. */
function missileIds(mobjs: Int32Array): Int32Array {
  const out: number[] = [];
  for (let i = 0, n = mobjs.length / MOBJ_WORDS; i < n; i++) if (OWN_TYPES.has(mobjs[i * MOBJ_WORDS + M_TYPE] & 0xffff)) out.push(mobjs[i * MOBJ_WORDS + M_ID]);
  return Int32Array.from(out);
}

export class Game {
  /**
   * Build the 3D view ahead of time (from the start screen, when the WAD is in).
   * Best effort: if WebGL is not there, the match makes its own fallback later.
   */
  static async prewarm(): Promise<void> {
    if (warm) return;
    const wad = await loadWad();
    if (warm) return;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    const t0 = performance.now();
    try {
      const renderer = new Renderer(canvas, wad, WARM_MAP, { fov: prefs().fov });
      // the 3D marines too: their factory and shader are part of the first frame
      if (prefs().players === '3d') renderer.setPlayerBodyRenderer(new ModelBodies(wad));
      // One frame now compiles every shader, which is otherwise the first frame of the match.
      renderer.setFrame(warmupFrame(wad, WARM_MAP));
      renderer.render();
      warm = { canvas, renderer, map: WARM_MAP };
    } catch { warm = null; }
    console.info(`[render] 3D view ready in ${Math.round(performance.now() - t0)} ms`);
  }

  onLeave: (() => void) | null = null;

  readonly id: string;
  readonly net: NetSession;
  readonly app: DoomApp;
  private readonly input: Input;
  private readonly hud: Hud;
  private readonly sound: SoundOut;
  private view: MapView;
  /** the map whose view is being built, and the next map whose art was fetched */
  private mapLoading = '';
  private prefetched = '';
  private readonly pause: PauseMenu;

  private readonly confirmed = new TicRing<Snap>(96);
  private readonly selfRing = new TicRing<Int32Array>(96);
  /**
   * Own projectiles drawn from the prediction (see draw()): ids judged ours, the
   * MobjView rows of those per predicted frame, and every candidate missile id per
   * predicted frame (to tell a new one from an old one).
   */
  private readonly ownMissiles = new Set<number>();
  private readonly predOwn = new TicRing<Int32Array>(96);
  private readonly predCand = new TicRing<Int32Array>(96);
  private lines: Int32Array | null = null;
  private mySlot = -1;
  private raf = 0;
  private lastT = 0;
  private disposed = false;

  // events
  private lastEventFrame = -1;
  private lastPredSoundFrame = -1;
  private predictedAt = 0;
  private readonly pending: RenderEvent[] = [];
  private readonly sentAngle = new Map<number, number>();
  private yawOffset = 0;
  private wasDead = false;

  // people
  private readonly names = new Map<string, string>();
  private readonly colors = new Map<string, number>();
  private readonly pings = new Map<string, number>();
  private readonly bots: string[];
  private killer: string | null = null;
  private lastObitAt = 0;
  private helloAt = 0;
  private pingAt = 0;

  // hud
  private readonly face = new FaceWidget();
  private faceAcc = 0;
  private faceTic = 0;

  // the reused RenderFrame
  private readonly frame: RenderFrame;
  private readonly mobjPool: RenderMobj[] = [];
  private readonly sectorPool: RenderSector[] = [];

  static async start(opts: GameOptions, progress: (label: string, frac: number) => void): Promise<Game> {
    progress('Loading', 0.1);
    const game = roomGame(opts.room);
    const [wad, sim] = await Promise.all([loadWad(), loadSim(game.mode.rotation, (i, n) => progress(`Loading maps ${i}/${n}`, 0.1 + 0.5 * (i / n)))]);
    progress('Connecting', 0.6);
    const mapIds = game.rotation.map((m) => sim.mapIds.get(m)!);
    const overrides = opts.offline ? opts.overrides : undefined;
    const app = createDoomApp(sim, { slots: game.slots, cfg: (seed) => cfgWords(game, mapIds, seed, overrides) });
    const g = new Game(opts, wad, app, game);
    try {
      await g.net.start();
    } catch (err) {
      g.dispose();
      throw err;
    }
    progress('Ready', 1);
    g.loop();
    return g;
  }

  private constructor(private readonly opts: GameOptions, private readonly wad: Wad, app: DoomApp, readonly game: RoomGame) {
    this.app = app;
    this.id = playerId(opts.identity);
    this.names.set(this.id, opts.name);
    this.colors.set(this.id, clampColor(opts.color));
    this.bots = botNames(opts.room, game.slots);
    const gfx = new Gfx(wad);
    const p = prefs();

    // the world view: three.js, or the automap where WebGL will not start
    this.view = this.makeView(wad, p.fov);
    opts.host.append(this.view.canvas);
    this.resize();
    addEventListener('resize', this.resize);

    this.hud = new Hud(opts.hud, gfx);
    opts.hud.classList.remove('hidden');
    this.sound = new GameSound(wad);
    this.sound.setVolume(p.volume);

    this.pause = new PauseMenu(gfx, {
      resume: () => this.resume(),
      leave: () => this.onLeave?.(),
      changed: (np) => { this.input.settings = { sensitivity: np.sensitivity, invertY: np.invertY }; this.sound.setVolume(np.volume); this.view.setFov(np.fov); this.view.setPlayers?.(np.players); },
    });

    this.input = new Input(this.view.canvas, {
      onMenu: () => this.openPause(),
      onScoreboard: (on) => this.hud.showScores(on),
      onChat: () => this.openChat(),
      keyboardCaptured: () => this.hud.chatting || this.pause.open,
    });
    this.input.settings = { sensitivity: p.sensitivity, invertY: p.invertY };

    this.frame = {
      tic: 0,
      camera: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 },
      mobjs: this.mobjPool,
      mobjCount: 0,
      viewMobjId: 0,
      sectors: this.sectorPool,
      lineTextures: null,
      player: null,
      events: [],
      eventCount: 0,
    };

    this.net = new NetSession({
      app,
      room: opts.room,
      appId: APP_ID,
      apiKey: API_KEY,
      centralServiceUrl: opts.central,
      nodeUrl: opts.nodeUrl,
      playerId: this.id,
      playerName: opts.name,
      ...(opts.identity ? { identity: opts.identity } : {}),
      offline: opts.offline,
      snapshotEvery: SNAPSHOT_EVERY,
      makeInput: (ctx) => this.makeInput(ctx),
      onConfirmedTick: (s, f) => this.onConfirmed(s, f),
      onPredictedTick: (s, f) => this.onPredicted(s, f),
    });
    this.net.onAppMessage = (player, data) => this.onAppMessage(player, data);
    this.net.onJoin = (player, name) => {
      if (!this.names.has(player)) this.names.set(player, cleanName(name) || 'Player');
      // A newcomer has none of our app messages: say who we are again, soon.
      if (player !== this.id) this.helloAt = Math.min(this.helloAt, performance.now() + 500 + Math.random() * 1500);
    };
  }

  private readonly disposers: (() => void)[] = [];

  // ------------------------------------------------------------------ the stream

  private makeInput(ctx?: lockstep.SimContext): unknown {
    const cmd = this.input.cmd();
    if (ctx) {
      this.sentAngle.set(ctx.frame, cmd.angle);
      if (this.sentAngle.size > 256) for (const k of this.sentAngle.keys()) { if (k < ctx.frame - 200) this.sentAngle.delete(k); else break; }
    }
    return encodeCmd(cmd);
  }

  private onConfirmed(s: DoomState, f: number): void {
    const sim = this.app.sim;
    const slot = s.ids.indexOf(this.id);
    this.mySlot = slot;
    const snap: Snap = {
      mobjs: sim.mobjs(s.h),
      rows: sim.players(s.h),
      sectors: sim.sectors(s.h),
      me: slot >= 0 ? sim.player(s.h, slot) : null,
      match: sim.match(s.h),
      mySlot: slot,
      ids: s.ids.slice(),
    };
    const prevSnap = this.confirmed.get(f - 1);
    this.confirmed.record(f, snap);
    if (snap.me && prevSnap) this.claimMissiles(snap.mobjs, missileIds(prevSnap.mobjs), snap.me);
    if (!this.lines) this.lines = sim.lines(s.h);
    if (f <= this.lastEventFrame) return;
    this.lastEventFrame = f;
    const ev = s.ev;
    let switched = false;
    // A catch-up replays history: its frames happened before we were here.
    const live = !this.net.lockstep.catchup.active;
    for (let i = 0; i < ev.length; i += EVENT_WORDS) {
      const kind = ev[i];
      if (kind === EV_SWITCH || kind === EV_MAP_CHANGE) switched = true;
      if (!live) continue;
      this.pushEvent(ev, i);
      this.confirmedEvent(ev, i, snap);
    }
    if (switched) this.lines = sim.lines(s.h);
  }

  private onPredicted(s: DoomState, f: number): void {
    const slot = s.ids.indexOf(this.id);
    if (slot < 0) return;
    const pv = this.app.sim.player(s.h, slot);
    this.selfRing.record(f, pv);
    this.recordOwnMissiles(s, f, pv);
    this.predictedAt = performance.now();
    const sent = this.sentAngle.get(f);
    if (sent !== undefined) this.yawOffset = ((pv[PV.angle] >>> 0) - ((sent << 16) >>> 0)) >>> 0;
    // Our own weapon, heard on the frame it was predicted - once, whatever a rollback replays.
    if (f > this.lastPredSoundFrame) {
      this.lastPredSoundFrame = f;
      const ev = s.ev;
      for (let i = 0; i < ev.length; i += EVENT_WORDS) {
        if (ev[i] === EV_SOUND && ev[i + 7] === slot + 1) this.sound.play(ev[i + 1], ev[i + 2], ev[i + 4] * FRAC, ev[i + 5] * FRAC, ev[i + 3], true);
      }
    }
  }

  /** Missiles new in `mobjs` (not in `prev`) that spawned at our body: ours. */
  private claimMissiles(mobjs: Int32Array, prev: Int32Array | null, me: Int32Array): void {
    // only while we hold a weapon that fires one (wp_missile 4, wp_plasma 5, wp_bfg 6):
    // a rival firing beside us is then never mistaken for us
    if (!prev || me[PV.state] !== 0 || me[PV.ready] < 4 || me[PV.ready] > 6) return;
    const n = mobjs.length / MOBJ_WORDS;
    for (let i = 0; i < n; i++) {
      const o = i * MOBJ_WORDS;
      if (!OWN_TYPES.has(mobjs[o + M_TYPE] & 0xffff)) continue;
      const id = mobjs[o + M_ID];
      if (this.ownMissiles.has(id) || prev.includes(id)) continue;
      if (Math.abs(mobjs[o + M_X] - me[PV.x]) < OWN_RADIUS && Math.abs(mobjs[o + M_Y] - me[PV.y]) < OWN_RADIUS) this.ownMissiles.add(id);
    }
  }

  /** The predicted world's copy of our projectiles at frame f (rows of MobjView). */
  private recordOwnMissiles(s: DoomState, f: number, pv: Int32Array): void {
    const mobjs = this.app.sim.mobjs(s.h);
    const cand = missileIds(mobjs);
    const conf = this.confirmed.get(f - 1);
    const prev = this.predCand.get(f - 1) ?? (conf ? missileIds(conf.mobjs) : null);
    this.predCand.record(f, cand);
    this.claimMissiles(mobjs, prev, pv);
    if (!this.ownMissiles.size) { this.predOwn.record(f, EMPTY); return; }
    let k = 0;
    const n = mobjs.length / MOBJ_WORDS;
    for (let i = 0; i < n; i++) if (this.ownMissiles.has(mobjs[i * MOBJ_WORDS + M_ID])) k++;
    const rows = new Int32Array(k * MOBJ_WORDS);
    k = 0;
    for (let i = 0; i < n; i++) {
      if (!this.ownMissiles.has(mobjs[i * MOBJ_WORDS + M_ID])) continue;
      rows.set(mobjs.subarray(i * MOBJ_WORDS, (i + 1) * MOBJ_WORDS), k++ * MOBJ_WORDS);
    }
    this.predOwn.record(f, rows);
    // forget ids that neither world has any more
    if (this.ownMissiles.size > 32) {
      const latest = this.confirmed.latest();
      const conf = latest ? missileIds(latest.mobjs) : EMPTY;
      for (const id of this.ownMissiles) if (!cand.includes(id) && !conf.includes(id)) this.ownMissiles.delete(id);
    }
  }

  private pushEvent(ev: Int32Array, i: number): void {
    if (this.pending.length > 512) return;
    this.pending.push({ kind: ev[i], a: ev[i + 1], b: ev[i + 2], c: ev[i + 3], x: ev[i + 4] * FRAC, y: ev[i + 5] * FRAC, z: ev[i + 6] * FRAC, d: ev[i + 7] });
  }

  private confirmedEvent(ev: Int32Array, i: number, snap: Snap): void {
    const kind = ev[i], a = ev[i + 1], b = ev[i + 2], c = ev[i + 3];
    const me = snap.mySlot;
    switch (kind) {
      case EV_SOUND: {
        const own = me >= 0 && ev[i + 7] === me + 1;
        // Ours was played off the prediction, unless there is none right now.
        if (own && performance.now() - this.predictedAt < 500) return;
        this.sound.play(a, b, ev[i + 4] * FRAC, ev[i + 5] * FRAC, c, own);
        return;
      }
      case EV_OBITUARY: {
        const victim = this.slotName(a, snap), killer = b >= 0 ? this.slotName(b, snap) : null;
        const tpl = obituaryTemplate(c, b === a, b < 0);
        const pieces: [string, string | undefined][] = [];
        for (const part of tpl.split(/(%o|%k)/)) {
          if (part === '%o') pieces.push([victim, this.slotCss(a, snap)]);
          else if (part === '%k') pieces.push([killer ?? '', b >= 0 ? this.slotCss(b, snap) : undefined]);
          else if (part) pieces.push([part, undefined]);
        }
        // 64 players frag several times a second: every line of yours is shown,
        // others' at a readable pace (humans' more often than bots').
        const mine = a === me || b === me;
        const human = !!snap.ids[a] || (b >= 0 && !!snap.ids[b]);
        const now = performance.now();
        if (mine || now - this.lastObitAt > (human ? 800 : 2200)) {
          if (!mine) this.lastObitAt = now;
          this.hud.obituary(pieces, mine);
        }
        if (a === me) this.killer = b >= 0 && b !== a ? killer : null;
        return;
      }
      case EV_PICKUP:
        if (a === me) {
          const msg = pickupMessage(b, snap.me ? snap.me[PV.health] : 100);
          if (msg) this.hud.message(msg);
        }
        return;
      case EV_MATCH_START:
        this.hud.message('A new match begins. Fight!', '#ffd25a');
        return;
      case EV_MATCH_END:
        if (this.game.mode.teams) this.hud.banner(a === 0 ? 'RED TEAM WINS THE MATCH' : a === 1 ? 'BLUE TEAM WINS THE MATCH' : 'THE MATCH IS A DRAW', TEAM_TINT[a] ?? '#ffd25a', 5000);
        else if (a >= 0) this.hud.message(`${this.slotName(a, snap)} wins the match!`, '#ffd25a');
        return;
      case EV_MAP_CHANGE:
        this.hud.message(`Now playing ${mapTitle(this.app.sim.mapName(a))}`, '#ffd25a');
        return;
      case EV_ROUND_START:
        this.hud.banner(`ROUND ${a}`, '#ffd25a', 2500);
        return;
      case EV_ROUND_END:
        this.hud.banner(a === 0 ? 'RED WINS THE ROUND' : a === 1 ? 'BLUE WINS THE ROUND' : 'ROUND DRAW', TEAM_TINT[a] ?? '#ffd25a', 3500);
        return;
      case EV_POINT_CAPTURED:
        this.hud.message(`${b === 0 ? 'Red' : 'Blue'} team captured point ${String.fromCharCode(65 + a)}`, TEAM_TINT[b]);
        return;
      case EV_TICKETS_LOW:
        this.hud.message(`${a === 0 ? 'Red' : 'Blue'} team is running out of tickets!`, TEAM_TINT[a]);
        return;
      case EV_BOSS_SPAWN:
        this.hud.banner(`A ${bossName(a).toUpperCase()} HAS ENTERED THE TOWN`, '#ff4b3a', 5000);
        return;
      case EV_BOSS_KILLED:
        this.hud.banner(b >= 0 ? `${this.slotName(b, snap).toUpperCase()} SLEW THE ${bossName(a).toUpperCase()}` : `THE ${bossName(a).toUpperCase()} IS DEAD`, '#ffd25a', 4000);
        this.hud.message('A BFG 9000 dropped where it fell!', '#7cff6b');
        return;
    }
  }

  /** The match as the HUD shows it: teams, rounds, tickets, capture points, the boss. */
  private modeHud(snap: Snap): ModeHud {
    const m = snap.match, g = this.game;
    const me = snap.mySlot;
    const nPoints = Math.max(0, m[MV.points] | 0);
    const points: ModeHud['points'] = [];
    for (let i = 0; i < nPoints; i++) {
      const o = MV.points + 1 + i * POINT_WORDS;
      points.push({ owner: m[o + 3], progress: m[o + 4] });
    }
    const bo = MV.points + 1 + nPoints * POINT_WORDS;
    const bossId = m.length > bo ? m[bo] : 0;
    const boss = bossId > 0 ? { name: bossName(m[bo + 1]), health: Math.max(0, m[bo + 2]), max: Math.max(1, m[bo + 3]) } : null;
    const phase = m[MV.phase];
    const w = m[MV.winner];
    let winner: string | null = null;
    if (phase === PHASE_INTERMISSION && w >= 0) {
      winner = g.mode.teams ? `${w === 0 ? 'RED' : 'BLUE'} TEAM WINS` : `${this.slotName(w, snap).toUpperCase()} WINS`;
    }
    const spec = snap.me ? snap.me[PV_SPECTATING] : -1;
    return {
      mode: m[MV.mode], label: g.label, teams: g.mode.teams, phase,
      phaseLeft: Math.max(0, m[MV.phaseLeft]) / TICRATE,
      round: m[MV.round],
      score: [m[MV.scoreRed], m[MV.scoreBlue]],
      alive: [m[MV.aliveRed], m[MV.aliveBlue]],
      myTeam: me >= 0 ? snap.rows[me * ROW_WORDS + R_TEAM] : -1,
      points, boss, winner,
      mapTitle: mapTitle(this.app.sim.mapName(m[MV.map])),
      nextMapTitle: mapTitle(this.app.sim.mapName(m[MV.nextMap])),
      spectating: spec >= 0 && spec !== me ? this.slotName(spec, snap) : null,
      spawnChoices: m[MV.mode] === 3 && snap.me ? spawnChoices(snap.me[PV_RESPAWN_MASK]) : null,
    };
  }

  private onAppMessage(player: string | null, data: unknown): void {
    if (!player || typeof data !== 'object' || data === null) return;
    const d = data as { n?: unknown; col?: unknown; say?: unknown; ping?: unknown };
    if (typeof d.n === 'string') { const n = cleanName(d.n); if (n) this.names.set(player, n); }
    if (d.col !== undefined) this.colors.set(player, clampColor(d.col));
    if (typeof d.ping === 'number' && Number.isFinite(d.ping)) this.pings.set(player, Math.max(0, Math.min(9999, Math.round(d.ping))));
    if (typeof d.say === 'string' && d.say.trim()) {
      const snap = this.confirmed.latest();
      const slot = snap ? snap.ids.indexOf(player) : -1;
      this.hud.chat(this.names.get(player) ?? 'Player', d.say.trim().slice(0, 120), slot >= 0 ? this.slotColor(slot, snap!) : 0);
    }
  }

  // ------------------------------------------------------------------ people

  private slotName(slot: number, snap: Snap): string {
    const id = snap.ids[slot];
    if (id) return this.names.get(id) ?? 'Player';
    return this.bots[slot] ?? `Bot ${slot}`;
  }

  private slotColor(slot: number, snap: Snap): number {
    if (this.game.mode.teams) {
      const team = snap.rows[slot * ROW_WORDS + R_TEAM];
      if (team === 0 || team === 1) return TEAM_COLOR[team];
    }
    const id = snap.ids[slot];
    if (id) return this.colors.get(id) ?? clampColor(snap.rows[slot * ROW_WORDS + R_COLOR]);
    return botColor(slot);
  }

  private slotCss(slot: number, snap: Snap): string {
    return PLAYER_COLORS[this.slotColor(slot, snap)]?.css ?? '#ffffff';
  }

  private slotPing(slot: number, snap: Snap, now: number): number {
    const id = snap.ids[slot];
    if (!id) return botPing(this.opts.room, slot, now);
    if (id === this.id) return Math.round(this.net.lockstep.roundTripMs ?? 0);
    return this.pings.get(id) ?? 0;
  }

  // ------------------------------------------------------------------ the frame

  private loop(): void {
    const tick = (now: number): void => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(tick);
      try { this.draw(now); } catch (err) { console.error(err); }
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Frames drawn, and when the count started: the page's frame rate for tests and the debug line. */
  private drawn = 0;
  /** CPU ms spent in the view's render call, smoothed (tests, perf numbers) */
  private renderMs = 0;
  private drawnSince = 0;

  private draw(now: number): void {
    if (!this.drawnSince) this.drawnSince = now;
    this.drawn++;
    const dt = this.lastT ? Math.min(0.1, (now - this.lastT) / 1000) : 0;
    this.lastT = now;
    this.input.update(dt);
    this.chatter(now);

    const v = this.net.lockstep.view(now);
    const t = renderTimes(v);
    const snapPair = t ? this.confirmed.pair(t.others) : null;
    if (!t || !snapPair) {
      this.hud.update({ pv: null, face: 0, color: 0, frags: 0, rank: 0, total: this.game.slots, timeLeft: 0, intermission: false, dead: false, respawnReady: false, killer: null, locked: this.input.locked, style: prefs().hud, net: this.net.statusText === 'Connected' || this.net.statusText === 'Offline' ? 'Joining…' : this.net.statusText }, now);
      return;
    }
    const { a, b, frac } = snapPair;
    const f = this.frame;
    f.tic = t.others;

    // --- the local player: predicted ring at `self`, or the confirmed one until it arms
    let pv: Int32Array | null = null, pvB: Int32Array | null = null, pvFrac = 0;
    if (t.drawSelfFromPrediction) {
      const sp = this.selfRing.pair(t.self);
      if (sp) { pv = sp.a; pvB = sp.b; pvFrac = sp.frac; }
    }
    if (!pv) {
      const cp = this.confirmed.pair(t.self);
      if (cp?.a.me) { pv = cp.a.me; pvB = cp.b.me ?? cp.a.me; pvFrac = cp.frac; }
    }

    // --- camera
    const cam = f.camera;
    const dead = !!pv && pv[PV.state] !== 0;
    if (pv && pvB) {
      const jump = Math.abs(pvB[PV.x] - pv[PV.x]) > TELEPORT || Math.abs(pvB[PV.y] - pv[PV.y]) > TELEPORT || Math.abs(pvB[PV.viewz] - pv[PV.viewz]) > TELEPORT;
      const k = jump ? (pvFrac < 0.5 ? 0 : 1) : pvFrac;
      cam.x = lerp(pv[PV.x], pvB[PV.x], k) * FRAC;
      cam.y = lerp(pv[PV.y], pvB[PV.y], k) * FRAC;
      cam.z = lerp(pv[PV.viewz], pvB[PV.viewz], k) * FRAC;
      if (dead) {
        cam.yaw = lerpAngle(pv[PV.angle], pvB[PV.angle], k);
        cam.pitch = 0;
      } else {
        cam.yaw = (this.input.yaw + (this.yawOffset >>> 0) * BAM) % (2 * Math.PI);
        cam.pitch = this.input.pitch;
      }
      if (this.wasDead && !dead) this.input.pitch = 0;   // a respawn looks straight ahead
      this.wasDead = dead;
      f.viewMobjId = pv[PV.mobj];
      const ps = (word: number, sxw: number): { sprite: number; frame: number; sx: number; sy: number } | null => {
        const s = (k < 0.5 ? pv! : pvB!)[word];
        if (s === -1) return null;
        return { sprite: s & 0xffff, frame: s >>> 16, sx: lerp(pv![sxw], pvB![sxw], k) * FRAC, sy: lerp(pv![sxw + 1], pvB![sxw + 1], k) * FRAC };
      };
      const cur = k < 0.5 ? pv : pvB;
      f.player = {
        damagecount: cur[PV.damagecount], bonuscount: cur[PV.bonuscount], extralight: cur[PV.extralight], fixedcolormap: cur[PV.fixedcolormap],
        powers: cur.subarray(PV.powers, PV.powers + 6),
        weapon: dead ? null : ps(PV.psWeapon, PV.psWeaponSx),
        flash: dead ? null : ps(PV.psFlash, PV.psFlashSx),
      };
    } else {
      f.player = null;
      f.viewMobjId = 0;
    }

    // --- everyone else, confirmed at `others`. Our own projectiles come from the
    // prediction instead (at `self`, like the camera), so a rocket leaves the barrel on
    // the frame we fire it rather than a playout delay later; their confirmed copies
    // are skipped so nothing is drawn twice. When there is no prediction to draw from,
    // the confirmed copies are drawn as everything else.
    const own = t.drawSelfFromPrediction && this.ownMissiles.size ? this.predOwn.pair(t.self) : null;
    let count = this.addMobjs(a, b, frac, own ? this.ownMissiles : null, 0);
    if (own) count = this.addMobjs({ mobjs: own.a } as Snap, { mobjs: own.b } as Snap, own.frac, null, count);
    if (this.staged.length && pv) count = this.addStaged(count, cam, pv[PV.z] * FRAC);
    f.mobjCount = count;


    // --- sectors (doors and lifts move between tics too)
    const ns = Math.min(a.sectors.length, b.sectors.length) / 5;
    for (let i = 0; i < ns; i++) {
      const s = this.sectorPool[i] ?? (this.sectorPool[i] = { floor: 0, ceil: 0, light: 0, floorpic: 0, ceilpic: 0 });
      const o = i * 5;
      s.floor = lerp(a.sectors[o], b.sectors[o], frac) * FRAC;
      s.ceil = lerp(a.sectors[o + 1], b.sectors[o + 1], frac) * FRAC;
      s.light = b.sectors[o + 2];
      s.floorpic = b.sectors[o + 3];
      s.ceilpic = b.sectors[o + 4];
    }
    this.sectorPool.length = ns;
    f.lineTextures = this.lines;

    // --- events since the last frame
    f.events = this.pending.splice(0);
    f.eventCount = (f.events as RenderEvent[]).length;

    this.sound.frame(cam.x, cam.y, cam.yaw, this.mobjPool, count);
    this.view.hudHeight(prefs().hud === 'bar' && f.player ? this.hud.barHeight : 0);
    const r0 = performance.now();
    this.followMap(b);
    // draw only once the view shows the map the world is on
    if (this.view.ready && this.view.map === this.app.sim.mapName(b.match[MV.map])) this.view.render(f);
    this.renderMs += (performance.now() - r0 - this.renderMs) * 0.05;

    // --- HUD
    this.updateHud(now, dt, pv, b, dead);
  }

  /** Interpolated RenderMobjs from a pair of frames into the pool from `count`; `skip` ids are left out. */
  private addMobjs(a: Snap, b: Snap, frac: number, skip: Set<number> | null, count: number): number {
    const ia = indexOf(a);
    const nb = b.mobjs.length / MOBJ_WORDS;
    for (let j = 0; j < nb; j++) {
      const ob = j * MOBJ_WORDS;
      const id = b.mobjs[ob + M_ID];
      if (skip?.has(id)) continue;
      const ja = ia.get(id);
      const A = ja === undefined ? b.mobjs : a.mobjs;
      const oa = ja === undefined ? ob : ja * MOBJ_WORDS;
      const B = b.mobjs;
      const m = this.mobjPool[count] ?? (this.mobjPool[count] = { id: 0, x: 0, y: 0, z: 0, angle: 0, sprite: 0, frame: 0, flags: 0, type: 0, slot: -1, translation: 0 });
      count++;
      const missile = (B[ob + M_FLAGS] & MF_MISSILE) !== 0;
      const jump = Math.abs(B[ob + M_X] - A[oa + M_X]) > TELEPORT || Math.abs(B[ob + M_Y] - A[oa + M_Y]) > TELEPORT || Math.abs(B[ob + M_Z] - A[oa + M_Z]) > TELEPORT;
      const k = jump ? (frac < 0.5 ? 0 : 1) : frac;
      m.id = id;
      if (ja === undefined && missile && frac > 0) {
        // Only the later frame has it: it was fired this tic. A projectile is a
        // computable straight line, so it may run back along its momentum.
        m.x = (B[ob + M_X] - B[ob + M_MOMX] * (1 - frac)) * FRAC;
        m.y = (B[ob + M_Y] - B[ob + M_MOMY] * (1 - frac)) * FRAC;
      } else {
        m.x = lerp(A[oa + M_X], B[ob + M_X], k) * FRAC;
        m.y = lerp(A[oa + M_Y], B[ob + M_Y], k) * FRAC;
      }
      m.z = lerp(A[oa + M_Z], B[ob + M_Z], k) * FRAC;
      m.angle = lerpAngle(A[oa + M_ANGLE], B[ob + M_ANGLE], k);
      const src = k < 0.5 ? A : B, so = k < 0.5 ? oa : ob;
      m.sprite = src[so + M_SPRITE] & 0xffff;
      m.frame = src[so + M_SPRITE] >>> 16;
      m.flags = src[so + M_FLAGS];
      const type = B[ob + M_TYPE];
      m.type = type & 0xffff;
      m.slot = (type >>> 16) - 1;
      m.translation = m.slot >= 0 ? this.slotColor(m.slot, b) : 0;
    }
    return count;
  }

  private updateHud(now: number, dt: number, pv: Int32Array | null, snap: Snap, dead: boolean): void {
    const me = snap.mySlot;
    // face, ticked at 35 Hz off the drawn player
    if (pv) {
      this.faceAcc += dt * TICRATE;
      let n = Math.min(4, Math.floor(this.faceAcc));
      this.faceAcc -= Math.floor(this.faceAcc);
      while (n-- > 0) {
        const att = pv[PV.attacker] - 1;
        let attackerAngle = 0;
        if (att >= 0 && att !== me) {
          const ia = indexOf(snap).get(snap.rows[att * ROW_WORDS + 2]);
          if (ia !== undefined) attackerAngle = pointToAngle(pv[PV.x], pv[PV.y], snap.mobjs[ia * MOBJ_WORDS + M_X], snap.mobjs[ia * MOBJ_WORDS + M_Y]);
        }
        this.face.tick({
          health: pv[PV.health], owned: pv[PV.owned], bonuscount: pv[PV.bonuscount], damagecount: pv[PV.damagecount],
          attacked: att >= 0 && att !== me, angle: pv[PV.angle] >>> 0, attackerAngle,
          attackDown: this.input.attacking, invulnerable: pv[PV.powers] > 0,
        });
        this.faceTic++;
      }
    }

    // standings
    const rows = snap.rows;
    const order: number[] = [];
    for (let s = 0; s < rows.length / ROW_WORDS; s++) order.push(s);
    order.sort((x, y) => rows[y * ROW_WORDS + R_FRAGS] - rows[x * ROW_WORDS + R_FRAGS] || rows[x * ROW_WORDS + R_DEATHS] - rows[y * ROW_WORDS + R_DEATHS] || x - y);
    const rank = me >= 0 ? order.indexOf(me) + 1 : 0;
    if (this.scoresWanted(now)) {
      const list: ScoreRow[] = order.map((s) => ({
        slot: s, name: this.slotName(s, snap), color: this.slotColor(s, snap),
        frags: rows[s * ROW_WORDS + R_FRAGS], deaths: rows[s * ROW_WORDS + R_DEATHS],
        ping: this.slotPing(s, snap, Date.now()), me: s === me,
      }));
      this.hud.setRows(list);
    }

    // The sim says which phase the match is in and how long that phase has left,
    // whatever the room's mode and timings are.
    const inter = snap.match[MV.phase] === PHASE_INTERMISSION;
    const timeLeft = Math.max(0, snap.match[MV.phaseLeft]) / TICRATE;
    const st = this.net.statusText;
    this.hud.update({
      pv, face: this.face.index, color: this.colors.get(this.id) ?? 0,
      frags: me >= 0 ? rows[me * ROW_WORDS + R_FRAGS] : 0, rank, total: rows.length / ROW_WORDS,
      timeLeft, intermission: inter, dead, respawnReady: !!pv && pv[PV.respawnReady] === 1,
      killer: dead ? this.killer : null,
      locked: this.input.locked || this.pause.open,
      style: prefs().hud,
      net: st === 'Connected' || st === 'Offline' ? null : st,
      mode: this.modeHud(snap),
    }, now);
    if (!dead) this.killer = null;
    void R_HUMAN;
  }

  private scoresAt = 0;
  /** The scoreboard's rows are rebuilt at 4 Hz, only while it can be seen. */
  private scoresWanted(now: number): boolean {
    if (now - this.scoresAt < 250) return false;
    this.scoresAt = now;
    return true;
  }

  /** Name/colour now and then, and when someone new arrives; our latency every 3 s. */
  private chatter(now: number): void {
    if (!this.net.lockstep.connected) return;
    if (now >= this.helloAt) {
      const p = prefs();
      if (this.net.sendAppMessage({ n: this.names.get(this.id) ?? p.name, col: this.colors.get(this.id) ?? p.color })) this.helloAt = now + 15000;
    }
    if (now >= this.pingAt) {
      this.pingAt = now + 3000;
      const rtt = this.net.lockstep.roundTripMs;
      if (rtt !== null && !this.net.offline) this.net.sendAppMessage({ ping: Math.round(rtt) });
    }
  }

  // ------------------------------------------------------------------ menus

  private openPause(): void {
    if (this.pause.open || this.disposed) return;
    this.input.setEnabled(false);
    this.input.unlock();
    this.pause.show();
  }

  private resume(): void {
    this.pause.hide();
    const np = prefs();
    if (np.color !== this.colors.get(this.id) || np.name !== this.names.get(this.id)) {
      this.colors.set(this.id, np.color);
      this.names.set(this.id, np.name);
      this.helloAt = 0;
    }
    this.input.setEnabled(true);
    this.input.lock();
  }

  private openChat(): void {
    this.input.setEnabled(false);
    this.hud.openChat((text) => { this.net.sendAppMessage({ say: text }); }, () => {
      if (this.pause.open) return;
      this.input.setEnabled(true);
      this.input.lock();
    });
  }

  private makeView(wad: Wad, fov: number): MapView {
    const pre = warm;
    warm = null;
    const v = new MapView(fov, wad, pre);
    v.setPlayers(prefs().players);
    return v;
  }

  /** The map the world is on (confirmed); the view follows it, building the map's art off the critical path. */
  private followMap(snap: Snap): void {
    const sim = this.app.sim;
    const want = sim.mapName(snap.match[MV.map]);
    if (want && want !== this.view.map && this.mapLoading !== want) {
      const id = snap.match[MV.map];
      this.mapLoading = want;
      void mapWad(want).then((w) => {
        if (this.disposed || this.mapLoading !== want) return;
        this.view.setMap(want, w, sim.nameTables(id));
        this.mapLoading = '';
      }).catch((err) => { console.error(err); this.mapLoading = ''; });
    }
    // the next map's art, while this one is played
    const next = sim.mapName(snap.match[MV.nextMap]);
    if (next && next !== want && next !== this.prefetched) { this.prefetched = next; void fetchMapArt(next); }
  }

  private readonly resize = (): void => {
    this.view.resize(innerWidth, innerHeight);
  };

  /** Leave: tell the room, stop everything, give the page back. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    removeEventListener('resize', this.resize);
    for (const d of this.disposers) d();
    this.input.setEnabled(false);
    this.input.dispose();
    try { this.net.leave(); } catch { /* already gone */ }
    this.pause.dispose();
    this.hud.dispose();
    this.opts.hud.classList.add('hidden');
    this.sound.dispose();
    this.view.dispose();
    this.confirmed.clear();
    this.selfRing.clear();
    this.predOwn.clear();
    this.predCand.clear();
    this.ownMissiles.clear();
  }

  // ------------------------------------------------------------------ tests

  /** For Playwright: what the page is doing, in numbers. */
  debug(): Record<string, unknown> {
    const s = this.net.stats();
    const snap = this.confirmed.latest();
    const pv = snap?.me ?? null;
    return {
      ...s, slot: this.mySlot, frame: this.net.lockstep.frame,
      pos: pv ? [pv[PV.x] >> 16, pv[PV.y] >> 16, pv[PV.z] >> 16] : null,
      health: pv?.[PV.health] ?? null, frags: snap && this.mySlot >= 0 ? snap.rows[this.mySlot * ROW_WORDS + R_FRAGS] : null,
      humans: snap ? snap.ids.filter(Boolean).length : 0,
      clones: this.app.stats.clones, decodes: this.app.stats.decodes,
      maxPitch: MAX_PITCH,
      fps: this.drawn / Math.max(0.001, (performance.now() - this.drawnSince) / 1000),
      ownMissiles: this.ownMissiles.size, renderMs: this.renderMs,
      weapon: pv ? pv[PV.ready] : null, owned: pv ? pv[PV.owned] : null,
      ammo: pv ? Array.from(pv.subarray(PV.ammo, PV.ammo + 4)) : null,
      angle: pv ? ((pv[PV.angle] >>> 0) * BAM) : null,
      render: this.view.stats?.() ?? null,
    };
  }

  /** For tests: steer without a mouse. */
  testLook(yaw: number, pitch: number): void { this.input.face(yaw, pitch); }

  /**
   * For tests (screenshots): extra player bodies placed relative to the camera, drawn
   * through the same path as the sim's (forward/left in map units, facing in radians
   * relative to looking back at us, Doom frame letter, colour, MF_* flags).
   */
  testStage(actors: { fwd: number; left: number; face?: number; frame: string; color: number; flags?: number }[]): void { this.staged = actors; }
  private staged: { fwd: number; left: number; face?: number; frame: string; color: number; flags?: number }[] = [];

  private addStaged(count: number, cam: { x: number; y: number; yaw: number }, floorZ: number): number {
    const play = SPRITE_NAMES.indexOf('PLAY');
    const c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
    this.staged.forEach((a, i) => {
      const m = this.mobjPool[count] ?? (this.mobjPool[count] = { id: 0, x: 0, y: 0, z: 0, angle: 0, sprite: 0, frame: 0, flags: 0, type: 0, slot: -1, translation: 0 });
      count++;
      m.id = 0x7fff0000 + i;
      m.x = cam.x + c * a.fwd - s * a.left;
      m.y = cam.y + s * a.fwd + c * a.left;
      m.z = floorZ;
      m.angle = cam.yaw + Math.PI + (a.face ?? 0);
      m.sprite = play;
      m.frame = a.frame.charCodeAt(0) - 65;
      m.flags = a.flags ?? 0;
      m.type = 0;
      m.slot = 60 + (i % 4);
      m.translation = a.color;
    });
    return count;
  }

  /** For tests: draw every 3D body with the invisibility fuzz. */
  testBodyFuzz(on: boolean): void { bodyDebug.fuzz = on; }

  /** For tests: look along a map direction (radians), whatever yaw offset the sim added. */
  testFace(dir: number, pitch = 0): void { this.input.face(dir - (this.yawOffset >>> 0) * BAM, pitch); }

  /** For tests: the player bodies and corpses around us (confirmed), nearest first. */
  testBodies(): { id: number; slot: number; dist: number; dir: number; dz: number; frame: string; flags: number; color: number }[] {
    const snap = this.confirmed.latest();
    const me = snap?.me;
    if (!snap || !me) return [];
    const out = [];
    const play = SPRITE_NAMES.indexOf('PLAY');
    for (let i = 0, n = snap.mobjs.length / MOBJ_WORDS; i < n; i++) {
      const o = i * MOBJ_WORDS;
      if ((snap.mobjs[o + M_SPRITE] & 0xffff) !== play || snap.mobjs[o + M_ID] === me[PV.mobj]) continue;
      const dx = (snap.mobjs[o + M_X] - me[PV.x]) * FRAC, dy = (snap.mobjs[o + M_Y] - me[PV.y]) * FRAC;
      const slot = (snap.mobjs[o + M_TYPE] >>> 16) - 1;
      out.push({
        id: snap.mobjs[o + M_ID], slot, dist: Math.hypot(dx, dy), dir: Math.atan2(dy, dx),
        dz: (snap.mobjs[o + M_Z] - me[PV.z]) * FRAC,
        frame: String.fromCharCode(65 + ((snap.mobjs[o + M_SPRITE] >>> 16) & 0x7fff)),
        flags: snap.mobjs[o + M_FLAGS], color: slot >= 0 ? this.slotColor(slot, snap) : -1,
      });
    }
    return out.sort((x, y) => x.dist - y.dist);
  }

  /** For tests: hold an action ('forward', 'attack', 'jump', 'w3', ...). */
  testHold(action: string, down: boolean): void { this.input.hold(action, down); }

  /** For tests: every human in the room as the confirmed world has them. */
  roster(): { id: string; slot: number; name: string; pos: number[] | null; frags: number; deaths: number }[] {
    const snap = this.confirmed.latest();
    if (!snap) return [];
    const out = [];
    const idx = indexOf(snap);
    for (let s = 0; s < snap.ids.length; s++) {
      const id = snap.ids[s];
      if (!id) continue;
      const mi = idx.get(snap.rows[s * ROW_WORDS + 2]);
      out.push({
        id, slot: s, name: this.slotName(s, snap),
        pos: mi === undefined ? null : [snap.mobjs[mi * MOBJ_WORDS + M_X] >> 16, snap.mobjs[mi * MOBJ_WORDS + M_Y] >> 16, snap.mobjs[mi * MOBJ_WORDS + M_Z] >> 16],
        frags: snap.rows[s * ROW_WORDS + R_FRAGS], deaths: snap.rows[s * ROW_WORDS + R_DEATHS],
      });
    }
    return out;
  }

  /** For tests: total frags in the room, and the confirmed frame and hash. */
  totals(): { frame: number; frags: number; hash: number | undefined } {
    const snap = this.confirmed.latest();
    let frags = 0;
    if (snap) for (let s = 0; s < snap.rows.length / ROW_WORDS; s++) frags += snap.rows[s * ROW_WORDS + R_FRAGS];
    const frame = this.net.lockstep.frame;
    return { frame, frags, hash: this.net.lockstep.world.hashAt(frame - 2) };
  }

  savePlayer(name: string, color: number): void {
    savePrefs({ name, color });
    this.names.set(this.id, name);
    this.colors.set(this.id, color);
    this.helloAt = 0;
  }
}
