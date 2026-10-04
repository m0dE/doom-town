/**
 * Battle royale and the scope: the ABI numbers DESIGN.md "Battle royale" and "Battle
 * royale v2" add, and the small pure helpers the game loop uses to read them.
 *
 * Every ABI number comes from src/sim/abi.ts (re-exported here for the game loop).
 */
import { BOSS_WORDS, BR, MV, POINT_WORDS } from '../sim/abi.js';
export {
  AIR_CHUTE, AIR_FREEFALL, AIR_NONE, AIR_SHIP, AIR_VEHICLE, BR, BR_WORDS, BT_GRENADE, BT_ZOOM, EV_CRATE, EV_SUPPLY, EV_ZONE,
  MF_SUPPLY, MODE_BR, MODE_WAR, MOD_GRENADE, MOD_ROADKILL, MOD_SNIPER, MOD_ZONE, MSG_GRENADES, MSG_SNIPER,
  MT_BUGGY, MT_CRATE, MT_DROPSHIP, MT_GRENADE, MT_GRENADEPACK, MT_PARACHUTER, MT_SNIPER, PHASE_DROP, PHASE_LOBBY, PV, WP_SNIPER,
} from '../sim/abi.js';

/** The scope's field of view, degrees (DESIGN.md: 25° zoomed, 12° with the sniper rifle). */
export const ZOOM_FOV = 25;
export const SNIPER_FOV = 12;

/** Battle royale words before sim_version 9 (no lobby, ship or supply drop). */
const BR_WORDS_V1 = 11;

const FRAC = 1 / 65536;

/** The zone (and v2's ship and supply drop) as world_view_match reports it (map units; seconds). */
export interface ZoneView {
  x: number; y: number; r: number;
  nx: number; ny: number; nr: number;
  /** 1..5, 6 = closed */
  stage: number;
  /** 0 waiting, 1 shrinking, 2 closed */
  state: number;
  secondsLeft: number;
  alive: number;
  /** damage per second outside */
  dps: number;
  /** v2: seconds left of the lobby / the drop, the ship (position, unit direction), the supply drop */
  lobbyLeft: number;
  ship: { x: number; y: number; dx: number; dy: number } | null;
  supply: { x: number; y: number; state: number } | null;
}

/** The battle royale words of a world_view_match buffer, or null when absent. */
export function readZone(m: Int32Array): ZoneView | null {
  const nPoints = Math.max(0, m[MV.points] | 0);
  const o = MV.points + 1 + nPoints * POINT_WORDS + BOSS_WORDS;
  if (m.length < o + BR_WORDS_V1) return null;
  const v2 = m.length >= o + BR.supplyState + 1;
  const sx = v2 ? m[o + BR.shipX] : 0, sy = v2 ? m[o + BR.shipY] : 0;
  const supplyState = v2 ? m[o + BR.supplyState] : 0;
  return {
    x: m[o + BR.zoneX] * FRAC, y: m[o + BR.zoneY] * FRAC, r: m[o + BR.zoneR] * FRAC,
    nx: m[o + BR.nextX] * FRAC, ny: m[o + BR.nextY] * FRAC, nr: m[o + BR.nextR] * FRAC,
    stage: m[o + BR.stage], state: m[o + BR.state], secondsLeft: Math.max(0, m[o + BR.stateLeft]) / 35,
    alive: m[o + BR.alive], dps: m[o + BR.damage],
    lobbyLeft: v2 ? Math.max(0, m[o + BR.phaseLeft]) / 35 : 0,
    ship: v2 && (sx || sy) ? { x: sx * FRAC, y: sy * FRAC, dx: m[o + BR.shipDirX] * FRAC, dy: m[o + BR.shipDirY] * FRAC } : null,
    supply: supplyState > 0 ? { x: m[o + BR.supplyX] * FRAC, y: m[o + BR.supplyY] * FRAC, state: supplyState } : null,
  };
}

/** Zone stages of a battle royale room without a `zone` rule (DESIGN.md table). */
export const DEFAULT_ZONE_STAGES = 5;

/** "0:42" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The HUD's zone line: "ZONE SHRINKS IN 0:42" / "ZONE CLOSING" / "FINAL ZONE". */
export function zoneLine(z: ZoneView, stages = DEFAULT_ZONE_STAGES): string {
  if (z.state === 2 || z.stage > stages) return 'FINAL ZONE';
  if (z.state === 1) return z.stage >= stages ? 'FINAL ZONE CLOSING' : 'STORM CLOSING IN';
  return `STORM SHRINKS IN ${clock(z.secondsLeft)}`;
}
