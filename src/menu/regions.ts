/**
 * Regional servers, and when to open another one (from vibe-strike).
 *
 * Every region keeps a standing pool of rooms that is listed at all times,
 * whether or not anyone is in them: two in North America, one in Europe, one
 * in Asia. A standing room that nobody has joined yet is still a real server —
 * the mesh creates a room the moment its first player dials it — so the list
 * shows it and Join works.
 *
 * Scaling is decided on REAL humans only: the connected client count the room
 * service reports. Bots fill every empty slot inside the simulation and are not
 * clients, and the browser's drifting `players` figure (rooms.ts `occupancy`)
 * is presentation, so neither can trigger a scale-up. When every room a region
 * is showing is more than SCALE_UP_FILL full of humans, the region opens the
 * next numbered room (`na-3`, `eu-2`, …) so there is always somewhere to play
 * that is not about to fill. An overflow room stays listed while humans are in
 * it and drops off once it empties and is not needed as the spare — the mesh
 * reaps an empty room on its own, so scaling down needs nothing more.
 *
 * Every client computes the same plan from the same listing, so two players in
 * one region are sent to the same new room rather than each minting their own.
 *
 * Where a room physically runs is central's choice, not the page's: the SDK has
 * no region field, only a preferred node. `VITE_ARRR_NODE_NA`, `…_EU` and
 * `…_ASIA` name a node in each location at build time, and a regional room asks
 * for it (`regionNodeUrl`). Unset, central places the room as it always has.
 */

export type RegionId = 'na' | 'eu' | 'asia';

export interface Region {
  id: RegionId;
  label: string;
  /** Deathmatch rooms this region keeps listed at all times. */
  standing: number;
}

/** In the order the browser lists them. */
export const REGIONS: readonly Region[] = [
  { id: 'na', label: 'North America', standing: 2 },
  { id: 'eu', label: 'Europe', standing: 1 },
  { id: 'asia', label: 'Asia', standing: 1 },
];

/**
 * The standing rooms of every other game, per region: the room kind is the words a
 * regional room name carries between region and number (src/menu/modes.ts), e.g.
 * `na-tdm-1`, `eu-war-1`, `na-boss-1` (Deathmatch with random bosses).
 */
export const STANDING: Record<string, Partial<Record<RegionId, number>>> = {
  '': { na: 2, eu: 1, asia: 1 },
  tdm: { na: 1, eu: 1, asia: 1 },
  elim: { na: 1, eu: 1 },
  war: { na: 1, eu: 1 },
  boss: { na: 1, eu: 1 },
  'tdm-boss': { na: 1 },
};
export const KINDS: readonly string[] = Object.keys(STANDING);

/** A room over this share of its slots taken by humans counts as full for scaling. */
export const SCALE_UP_FILL = 0.8;

const REGION_IDS = new Set<string>(REGIONS.map((r) => r.id));

export function regionOf(id: RegionId): Region {
  return REGIONS.find((r) => r.id === id)!;
}

/** `na`, 2 → `na-2`; `na`, 1, `tdm` → `na-tdm-1`: the name the player sees and the netcode joins. */
export function regionRoomName(region: RegionId, index: number, kind = ''): string {
  return kind ? `${region}-${kind}-${index}` : `${region}-${index}`;
}

/** `na-2` → { region: 'na', kind: '', index: 2 }; `eu-tdm-boss-1` → kind 'tdm-boss'; null otherwise. */
export function parseRegionRoom(name: string): { region: RegionId; kind: string; index: number } | null {
  const m = /^([a-z]+)-(?:([a-z]+(?:-[a-z]+)?)-)?([1-9]\d{0,2})$/.exec(name);
  if (!m || !REGION_IDS.has(m[1])) return null;
  const kind = m[2] ?? '';
  if (!(kind in STANDING)) return null;
  return { region: m[1] as RegionId, kind, index: Number(m[3]) };
}

/** True when more than SCALE_UP_FILL of the room's slots are held by humans. */
export function overFull(humans: number, capacity: number): boolean {
  return capacity > 0 && humans / capacity > SCALE_UP_FILL;
}

/**
 * The room numbers a region shows, given the humans in each of its live rooms
 * (index → connected clients; rooms missing from the map are empty).
 *
 * The standing rooms always; every overflow room with a human in it; and, if
 * all of those are over the scale-up line, the lowest unused number as a spare.
 */
export function planRegion(region: RegionId, humans: ReadonlyMap<number, number>, capacity: number, kind = ''): number[] {
  const shown = new Set<number>();
  const standing = kind ? (STANDING[kind]?.[region] ?? 0) : regionOf(region).standing;
  if (standing === 0 && ![...humans.values()].some((n) => n > 0)) return [];
  for (let i = 1; i <= standing; i++) shown.add(i);
  for (const [i, n] of humans) if (n > 0) shown.add(i);
  const saturated = [...shown].every((i) => overFull(humans.get(i) ?? 0, capacity));
  if (saturated) {
    let next = 1;
    while (shown.has(next)) next++;
    shown.add(next);
  }
  return [...shown].sort((a, b) => a - b);
}

/**
 * The region a player is probably in, from their time zone. Coarse on purpose:
 * it only orders the list and aims Quick play, and the player can pick any row.
 */
export function regionForTimeZone(tz: string | undefined): RegionId {
  const zone = tz ?? '';
  if (/^(Europe|Africa|Atlantic\/(Reykjavik|Canary|Faroe|Madeira|Azores))\//.test(zone)) return 'eu';
  if (/^(Asia|Australia|Pacific|Indian)\//.test(zone)) return 'asia';
  return 'na';
}

export function homeRegion(): RegionId {
  try {
    return regionForTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return 'na';
  }
}

const NODE_URLS: Record<RegionId, string | undefined> = {
  na: (import.meta.env?.VITE_ARRR_NODE_NA ?? '').trim() || undefined,
  eu: (import.meta.env?.VITE_ARRR_NODE_EU ?? '').trim() || undefined,
  asia: (import.meta.env?.VITE_ARRR_NODE_ASIA ?? '').trim() || undefined,
};

/** The node a regional room asks central for, when the build names one for its region. */
export function regionNodeUrl(room: string): string | undefined {
  const parsed = parseRegionRoom(room);
  return parsed ? NODE_URLS[parsed.region] : undefined;
}
