/**
 * The one place the map is named. The sim takes any map; the game plays this one.
 */
export const MAP_LUMP = 'MAP19';
/** What players see in the server list and on the loading screen. */
export const MAP_TITLE = 'DM19: Tech Isle';
/** Every slot is always occupied: a bot plays it unless a human has it. */
export const SLOTS = 64;
/** Doom's TICRATE, and the rate the app's rooms run at. */
export const TICRATE = 35;
/** A match: 10 minutes of play, then 10 s of intermission (the sim drives both). */
export const MATCH_TICS = TICRATE * 600;
export const INTERMISSION_TICS = TICRATE * 10;
/** The lumps a map is made of, after its marker, in the order a PWAD carries them. */
export const MAP_LUMPS = ['THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS', 'SSECTORS', 'NODES', 'SECTORS', 'REJECT', 'BLOCKMAP'] as const;
