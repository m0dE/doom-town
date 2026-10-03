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
 * Room ids are namespaced: the netcode joins `${room}-freedm`. The list shows
 * the friendly half.
 */
import { listRooms, type RoomInfo } from 'arrr-network';
import { APP_NAME } from '../sim/doomsim.js';
import { SLOTS } from '../sim/map.js';
import { REGIONS, overFull, parseRegionRoom, planRegion, regionRoomName, type RegionId } from './regions.js';

/**
 * The app on the ARRR network: the rooms it lists and joins, and the app a
 * player signs in to - ONE id, because a session token is scoped to its app
 * and a node refuses it for another app's room.
 *
 * `freedoom-deathmatch` on cloud.arrr.fun: rooms tick at 35 Hz, sign-in open,
 * signed-out players may play, every origin allowed. `VITE_ARRR_APP_ID` at
 * build time overrides it (a local cluster, a second environment).
 */
export const DEFAULT_APP_ID = 'app_1791001468308_ac7590dffc2a';
export const APP_ID = (import.meta.env?.VITE_ARRR_APP_ID ?? '').trim() || DEFAULT_APP_ID;

/** Optional, not a secret (a key in a browser build is public). */
export const API_KEY = (import.meta.env?.VITE_ARRR_API_KEY ?? '').trim() || undefined;

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
    rows.push({
      name, id: info.id, connected,
      players: occupancy(String(info.id ?? ''), now, connected),
      capacity: SLOTS,
      node: String(info.authorityNodeId ?? '').split('_').pop()?.slice(0, 8) ?? '',
      ageSeconds: Number.isFinite(created) ? Math.max(0, (now - created) / 1000) : null,
    });
  }
  rows.sort((a, b) => (b.ageSeconds ?? 0) - (a.ageSeconds ?? 0) || a.name.localeCompare(b.name));
  return rows;
}

/** The regional servers first (each region's plan, live or not yet opened), then everything else. */
export function withRegions(rows: readonly RoomRow[], now = Date.now()): RoomRow[] {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const regional: RoomRow[] = [];
  for (const region of REGIONS) {
    const humans = new Map<number, number>();
    for (const r of rows) {
      const parsed = parseRegionRoom(r.name);
      if (parsed?.region === region.id) humans.set(parsed.index, r.connected);
    }
    for (const index of planRegion(region.id, humans, SLOTS)) {
      const name = regionRoomName(region.id, index);
      const id = roomIdFor(name);
      const live = byName.get(name);
      regional.push(live
        ? { ...live, region: region.id }
        : { name, id, connected: 0, players: occupancy(id, now, 0), capacity: SLOTS, node: '', ageSeconds: null, region: region.id });
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
    .filter((r) => r.region === region && !overFull(r.connected, r.capacity))
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
export function occupancy(roomId: string, now: number, connected: number): number {
  let h = 2166136261;
  for (let i = 0; i < roomId.length; i++) h = Math.imul(h ^ roomId.charCodeAt(i), 16777619);
  const phase = ((h >>> 0) % 10000) / 10000 * Math.PI * 2;
  const t = now / DRIFT_PERIOD_MS;
  const wave = (Math.sin(t + phase) + Math.sin(t / 1.618 + phase * 2)) / 4 + 0.5;
  const filled = OCCUPANCY_MIN + (1 - OCCUPANCY_MIN) * wave;
  return Math.max(connected, Math.min(SLOTS, Math.round(SLOTS * filled)));
}
