// Animated textures/flats (p_spec.c animdefs) and switch pairs (p_switch.c
// alphSwitchList) from linuxdoom-1.10. No imports: node tools import this file.

export interface AnimDef { isTexture: boolean; last: string; first: string; speed: number }

export const ANIMDEFS: readonly AnimDef[] = [
  { isTexture: false, last: 'NUKAGE3', first: 'NUKAGE1', speed: 8 },
  { isTexture: false, last: 'FWATER4', first: 'FWATER1', speed: 8 },
  { isTexture: false, last: 'SWATER4', first: 'SWATER1', speed: 8 },
  { isTexture: false, last: 'LAVA4', first: 'LAVA1', speed: 8 },
  { isTexture: false, last: 'BLOOD3', first: 'BLOOD1', speed: 8 },
  { isTexture: false, last: 'RROCK08', first: 'RROCK05', speed: 8 },
  { isTexture: false, last: 'SLIME04', first: 'SLIME01', speed: 8 },
  { isTexture: false, last: 'SLIME08', first: 'SLIME05', speed: 8 },
  { isTexture: false, last: 'SLIME12', first: 'SLIME09', speed: 8 },
  { isTexture: true, last: 'BLODGR4', first: 'BLODGR1', speed: 8 },
  { isTexture: true, last: 'SLADRIP3', first: 'SLADRIP1', speed: 8 },
  { isTexture: true, last: 'BLODRIP4', first: 'BLODRIP1', speed: 8 },
  { isTexture: true, last: 'FIREWALL', first: 'FIREWALA', speed: 8 },
  { isTexture: true, last: 'GSTFONT3', first: 'GSTFONT1', speed: 8 },
  { isTexture: true, last: 'FIRELAVA', first: 'FIRELAV3', speed: 8 },
  { isTexture: true, last: 'FIREMAG3', first: 'FIREMAG1', speed: 8 },
  { isTexture: true, last: 'FIREBLU2', first: 'FIREBLU1', speed: 8 },
  { isTexture: true, last: 'ROCKRED3', first: 'ROCKRED1', speed: 8 },
  { isTexture: true, last: 'BFALL4', first: 'BFALL1', speed: 8 },
  { isTexture: true, last: 'SFALL4', first: 'SFALL1', speed: 8 },
  { isTexture: true, last: 'WFALL4', first: 'WFALL1', speed: 8 },
  { isTexture: true, last: 'DBRAIN4', first: 'DBRAIN1', speed: 8 },
];

/** [off, on] switch texture pairs (all episodes; Doom 2 uses every entry). */
export const SWITCHES: readonly (readonly [string, string])[] = [
  ['SW1BRCOM', 'SW2BRCOM'], ['SW1BRN1', 'SW2BRN1'], ['SW1BRN2', 'SW2BRN2'], ['SW1BRNGN', 'SW2BRNGN'],
  ['SW1BROWN', 'SW2BROWN'], ['SW1COMM', 'SW2COMM'], ['SW1COMP', 'SW2COMP'], ['SW1DIRT', 'SW2DIRT'],
  ['SW1EXIT', 'SW2EXIT'], ['SW1GRAY', 'SW2GRAY'], ['SW1GRAY1', 'SW2GRAY1'], ['SW1METAL', 'SW2METAL'],
  ['SW1PIPE', 'SW2PIPE'], ['SW1SLAD', 'SW2SLAD'], ['SW1STARG', 'SW2STARG'], ['SW1STON1', 'SW2STON1'],
  ['SW1STON2', 'SW2STON2'], ['SW1STONE', 'SW2STONE'], ['SW1STRTN', 'SW2STRTN'],
  ['SW1BLUE', 'SW2BLUE'], ['SW1CMT', 'SW2CMT'], ['SW1GARG', 'SW2GARG'], ['SW1GSTON', 'SW2GSTON'],
  ['SW1HOT', 'SW2HOT'], ['SW1LION', 'SW2LION'], ['SW1SATYR', 'SW2SATYR'], ['SW1SKIN', 'SW2SKIN'],
  ['SW1VINE', 'SW2VINE'], ['SW1WOOD', 'SW2WOOD'],
  ['SW1PANEL', 'SW2PANEL'], ['SW1ROCK', 'SW2ROCK'], ['SW1MET2', 'SW2MET2'], ['SW1WDMET', 'SW2WDMET'],
  ['SW1BRIK', 'SW2BRIK'], ['SW1MOD1', 'SW2MOD1'], ['SW1ZIM', 'SW2ZIM'], ['SW1STON6', 'SW2STON6'],
  ['SW1TEK', 'SW2TEK'], ['SW1MARB', 'SW2MARB'], ['SW1SKULL', 'SW2SKULL'],
];

/**
 * Doom 2 sky rule (g_game.c G_DoLoadLevel): MAP01-11 SKY1, MAP12-20 SKY2, MAP21+ SKY3.
 * ExMy maps use SKY<x>.
 */
export function skyTextureForMap(mapName: string): string {
  const m = /^MAP(\d\d)$/i.exec(mapName);
  if (m) {
    const n = Number(m[1]);
    return n < 12 ? 'SKY1' : n < 21 ? 'SKY2' : 'SKY3';
  }
  const e = /^E(\d)M\d$/i.exec(mapName);
  return e ? `SKY${e[1]}` : 'SKY1';
}

export const SKY_FLAT = 'F_SKY1';
