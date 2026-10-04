/**
 * The maps the game plays, per mode, in rotation order, and their titles.
 *
 * The same lists as tools/build-pak.mjs ROTATIONS and public/maps/index.json (the
 * build writes the JSON from them); kept here as code because a room's world config
 * must be known synchronously and identically on every client. `checkIndex` warns at
 * runtime if the shipped index.json ever disagrees.
 */
export type RotationKey = 'deathmatch' | 'teamDeathmatch' | 'elimination' | 'war' | 'battleRoyale';

export const ROTATIONS: Record<RotationKey, readonly string[]> = {
  deathmatch: [
    'MAP19',
    'MAP24',
    'MAP20',
    'MAP30',
    'MAP27',
    'MAP32'
  ],
  teamDeathmatch: [
    'MAP19',
    'MAP24',
    'MAP20',
    'MAP30',
    'MAP27',
    'MAP32'
  ],
  elimination: [
    'MAP11',
    'MAP05',
    'MAP18',
    'MAP17'
  ],
  war: [
    'WAR01',
    'WAR02'
  ],
  battleRoyale: [
    'BR01'
  ]
};

export const MAP_TITLES: Record<string, string> = {
  'MAP19': 'DM19: Tech Isle',
  'MAP24': 'DM24: Flooded Base',
  'MAP20': 'DM20: Warehouse',
  'MAP30': 'DM30: Last Man Standing',
  'MAP27': 'DM27: The Exile',
  'MAP32': 'DM32: Fourplay',
  'MAP11': 'DM11: Isolated Facility',
  'MAP05': 'DM05: Dense Fields',
  'MAP18': 'DM18: Deserted Courtyard',
  'MAP17': 'DM17: Underwoods',
  'WAR01': 'WAR01: Nukage Front',
  'WAR02': 'WAR02: Canal City',
  'BR01': 'BR01: Doom Town'
};

export function mapTitle(name: string): string { return MAP_TITLES[name] ?? name; }

/** Every map any rotation plays, in a fixed order. */
export const ALL_MAPS: readonly string[] = [...new Set(Object.values(ROTATIONS).flat())];

/** Compare with the shipped index (dev aid; never throws). */
export function checkIndex(index: { rotations?: Record<string, string[]> }): void {
  for (const [k, list] of Object.entries(ROTATIONS)) {
    const other = index.rotations?.[k];
    if (other && other.join() !== list.join()) console.warn(`[maps] rotation ${k} differs from maps/index.json: ${other.join()} vs ${list.join()}`);
  }
}
