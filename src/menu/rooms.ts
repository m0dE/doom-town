/**
 * The server list's data (adapted from vibe-strike's rooms.ts).
 *
 * Central knows a room's id, its connected client count, its authority node
 * and when it was created - no map, no score. Every slot in a match is always
 * filled (bots play the empty ones), so the true figure is always 64/64;
 * the list instead shows a slowly drifting population seeded from the room
 * id, never below the humans actually connected, so two clients agree and a
 * row keeps its character between refreshes.
 *
 * Room ids are namespaced: the netcode joins `${room}-doom-town` (APP_NAME, the
 * lockstep app's own name too). The list shows
 * the friendly half.
 */
import { listRooms, type RoomInfo } from 'arrr-network';
import { APP_NAME } from '../sim/doomsim.js';
import { KINDS, REGIONS, overFull, parseRegionRoom, planRegion, regionRoomName, type RegionId } from './regions.js';
import { guessMap, roomGame, type RoomGame } from './modes.js';

/**
 * The app on the ARRR network: the rooms it lists and joins, and the app a
 * player signs in to - ONE id, because a session token is scoped to its app
 * and a node refuses it for another app's room.
 *
 * `doom-town` on cloud.arrr.fun: rooms tick at 35 Hz, sign-in open,
 * signed-out players may play, every origin allowed. `VITE_ARRR_APP_ID` at
 * build time overrides it (a local cluster, a second environment).
 */
export const DEFAULT_APP_ID = 'app_1791001468308_ac7590dffc2a';
export const APP_ID = (import.meta.env?.VITE_ARRR_APP_ID ?? '').trim() || DEFAULT_APP_ID;

/**
 * The app's API key (console → doom-town → API key, "main"). Not a secret: the console
 * says it ships in the client and is attribution, and a key in a browser build is public
 * anyway. It goes only with the app it belongs to, so a build pointed at another app
 * (a local cluster) sends none unless `VITE_ARRR_API_KEY` names one.
 */
const DEFAULT_API_KEY = 'arrr_b1cca897fa86e8ff56416f5e65b1a47f8ca42e59788b9861ae0f61b03c40951b';
export const API_KEY = (import.meta.env?.VITE_ARRR_API_KEY ?? '').trim()
  || (APP_ID === DEFAULT_APP_ID ? DEFAULT_API_KEY : undefined);

const SUFFIX = `-${APP_NAME}`;

export function roomIdFor(name: string): string { return `${name}${SUFFIX}`; }

export function roomNameFrom(id: string): string | null {
  return id.endsWith(SUFFIX) && id.length > SUFFIX.length ? id.slice(0, -SUFFIX.length) : null;
}

/** What a typed room name may be: what the netcode and a URL carry without surprises. */
export function cleanRoomName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 32);
}

export interface RoomRow {
  name: string;
  id: string;
  connected: number;
  players: number;
  capacity: number;
  node: string;
  ageSeconds: number | null;
  region?: RegionId;
  /** what the room plays (from its name) and the map it is probably on now */
  game: RoomGame;
  map: string;
}

function row(name: string, id: string, connected: number, node: string, ageSeconds: number | null, now: number): RoomRow {
  const game = roomGame(name);
  return {
    name, id, connected, node, ageSeconds, game,
    players: occupancy(id, now, connected, game.slots),
    capacity: game.slots,
    map: guessMap(game, ageSeconds),
  };
}

export type RoomsResult = { ok: true; rooms: RoomRow[] } | { ok: false; error: string };

export function toRows(infos: readonly RoomInfo[], now = Date.now()): RoomRow[] {
  const rows: RoomRow[] = [];
  for (const info of infos) {
    const name = roomNameFrom(String(info.id ?? ''));
    if (!name) continue;
    const created = Date.parse(String(info.createdAt ?? ''));
    const raw = Number(info.clientCount);
    const connected = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    rows.push(row(name, info.id, connected,
      String(info.authorityNodeId ?? '').split('_').pop()?.slice(0, 8) ?? '',
      Number.isFinite(created) ? Math.max(0, (now - created) / 1000) : null, now));
  }
  rows.sort((a, b) => (b.ageSeconds ?? 0) - (a.ageSeconds ?? 0) || a.name.localeCompare(b.name));
  return rows;
}

/** The regional servers first (each region's plan, live or not yet opened), then everything else. */
export function withRegions(rows: readonly RoomRow[], now = Date.now()): RoomRow[] {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const regional: RoomRow[] = [];
  for (const kind of KINDS) {
    const capacity = roomGame(regionRoomName('na', 1, kind)).slots;
    for (const region of REGIONS) {
      const humans = new Map<number, number>();
      for (const r of rows) {
        const parsed = parseRegionRoom(r.name);
        if (parsed?.region === region.id && parsed.kind === kind) humans.set(parsed.index, r.connected);
      }
      for (const index of planRegion(region.id, humans, capacity, kind)) {
        const name = regionRoomName(region.id, index, kind);
        const live = byName.get(name);
        regional.push({ ...(live ?? row(name, roomIdFor(name), 0, '', null, now)), region: region.id });
      }
    }
  }
  return [...regional, ...rows.filter((r) => !parseRegionRoom(r.name))];
}

/** Never throws: Play must keep working when the room service does not. */
export async function fetchRooms(central?: string, limit = 100): Promise<RoomsResult> {
  try {
    const result = await listRooms(APP_ID, { limit, ...(central ? { centralServiceUrl: central } : {}) });
    return { ok: true, rooms: withRegions(toRows(result?.rooms ?? [])) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Quick Play: the busiest of the region's rooms still under the scale-up line. */
export function quickPlayRoom(rows: readonly RoomRow[], region: RegionId): string {
  const open = rows
    .filter((r) => r.region === region && r.game.kind === '' && !overFull(r.connected, r.capacity))
    .sort((a, b) => b.connected - a.connected || (parseRegionRoom(a.name)?.index ?? 0) - (parseRegionRoom(b.name)?.index ?? 0));
  return open[0]?.name ?? regionRoomName(region, 1);
}

/** "just now", "4m", "2h 10m". */
export function formatAge(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 90) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const OCCUPANCY_MIN = 0.82;
const DRIFT_PERIOD_MS = 95_000;

/** Two slow waves seeded from the room id: a population that wanders like a real one. */
export function occupancy(roomId: string, now: number, connected: number, slots = 64): number {
  let h = 2166136261;
  for (let i = 0; i < roomId.length; i++) h = Math.imul(h ^ roomId.charCodeAt(i), 16777619);
  const phase = ((h >>> 0) % 10000) / 10000 * Math.PI * 2;
  const t = now / DRIFT_PERIOD_MS;
  const wave = (Math.sin(t + phase) + Math.sin(t / 1.618 + phase * 2)) / 4 + 0.5;
  const filled = OCCUPANCY_MIN + (1 - OCCUPANCY_MIN) * wave;
  return Math.max(connected, Math.min(slots, Math.round(slots * filled)));
}
