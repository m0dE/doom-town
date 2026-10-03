// Sprite and sound name tables in Doom's order (linuxdoom-1.10 info.c `sprnames`,
// sounds.c `S_sfx`). Indices in MobjView/PlayerView/Event data refer to these; the
// sim exports the same lists (sim_sprite_names / sim_sound_names) and they must match.
// This file has no imports so node tools can import it directly (type stripping).

export const SPRITE_NAMES: readonly string[] = [
  'TROO', 'SHTG', 'PUNG', 'PISG', 'PISF', 'SHTF', 'SHT2', 'CHGG', 'CHGF', 'MISG',
  'MISF', 'SAWG', 'PLSG', 'PLSF', 'BFGG', 'BFGF', 'BLUD', 'PUFF', 'BAL1', 'BAL2',
  'PLSS', 'PLSE', 'MISL', 'BFS1', 'BFE1', 'BFE2', 'TFOG', 'IFOG', 'PLAY', 'POSS',
  'SPOS', 'VILE', 'FIRE', 'FATB', 'FBXP', 'SKEL', 'MANF', 'FATT', 'CPOS', 'SARG',
  'HEAD', 'BAL7', 'BOSS', 'BOS2', 'SKUL', 'SPID', 'BSPI', 'APLS', 'APBX', 'CYBR',
  'PAIN', 'SSWV', 'KEEN', 'BBRN', 'BOSF', 'ARM1', 'ARM2', 'BAR1', 'BEXP', 'FCAN',
  'BON1', 'BON2', 'BKEY', 'RKEY', 'YKEY', 'BSKU', 'RSKU', 'YSKU', 'STIM', 'MEDI',
  'SOUL', 'PINV', 'PSTR', 'PINS', 'MEGA', 'SUIT', 'PMAP', 'PVIS', 'CLIP', 'AMMO',
  'ROCK', 'BROK', 'CELL', 'CELP', 'SHEL', 'SBOX', 'BPAK', 'BFUG', 'MGUN', 'CSAW',
  'LAUN', 'PLAS', 'SHOT', 'SGN2', 'COLU', 'SMT2', 'GOR1', 'POL2', 'POL5', 'POL4',
  'POL3', 'POL1', 'POL6', 'GOR2', 'GOR3', 'GOR4', 'GOR5', 'SMIT', 'COL1', 'COL2',
  'COL3', 'COL4', 'CAND', 'CBRA', 'COL6', 'TRE1', 'TRE2', 'ELEC', 'CEYE', 'FSKU',
  'COL5', 'TBLU', 'TGRN', 'TRED', 'SMBT', 'SMGT', 'SMRT', 'HDB1', 'HDB2', 'HDB3',
  'HDB4', 'HDB5', 'HDB6', 'POB1', 'POB2', 'BRS1', 'TLMP', 'TLP2',
];

/** Doom's S_sfx order; index 0 is "" (sfx_None), as the sim exports it. Lump = "DS" + upper(name). */
export const SOUND_NAMES: readonly string[] = [
  '', 'pistol', 'shotgn', 'sgcock', 'dshtgn', 'dbopn', 'dbcls', 'dbload', 'plasma', 'bfg',
  'sawup', 'sawidl', 'sawful', 'sawhit', 'rlaunc', 'rxplod', 'firsht', 'firxpl', 'pstart', 'pstop',
  'doropn', 'dorcls', 'stnmov', 'swtchn', 'swtchx', 'plpain', 'dmpain', 'popain', 'vipain', 'mnpain',
  'pepain', 'slop', 'itemup', 'wpnup', 'oof', 'telept', 'posit1', 'posit2', 'posit3', 'bgsit1',
  'bgsit2', 'sgtsit', 'cacsit', 'brssit', 'cybsit', 'spisit', 'bspsit', 'kntsit', 'vilsit', 'mansit',
  'pesit', 'sklatk', 'sgtatk', 'skepch', 'vilatk', 'claw', 'skeswg', 'pldeth', 'pdiehi', 'podth1',
  'podth2', 'podth3', 'bgdth1', 'bgdth2', 'sgtdth', 'cacdth', 'skldth', 'brsdth', 'cybdth', 'spidth',
  'bspdth', 'vildth', 'kntdth', 'pedth', 'skedth', 'posact', 'bgact', 'dmact', 'bspact', 'bspwlk',
  'vilact', 'noway', 'barexp', 'punch', 'hoof', 'metal', 'chgun', 'tink', 'bdopn', 'bdcls',
  'itmbk', 'flame', 'flamst', 'getpow', 'bospit', 'boscub', 'bossit', 'bospn', 'bosdth', 'manatk',
  'mandth', 'sssit', 'ssdth', 'keenpn', 'keendt', 'skeact', 'skesit', 'skeatk', 'radio',
];

const spriteIndex = new Map<string, number>(SPRITE_NAMES.map((n, i) => [n, i]));
const soundIndex = new Map<string, number>(SOUND_NAMES.map((n, i) => [n, i]));

/** Sprite index for a 4-letter name, -1 if unknown. */
export function spriteNum(name: string): number {
  return spriteIndex.get(name.toUpperCase()) ?? -1;
}
/** Sound index for an sfx name ("pistol" or "DSPISTOL"), 0 if unknown. */
export function soundNum(name: string): number {
  let n = name.toLowerCase();
  if (n.startsWith('ds') && !soundIndex.has(n)) n = n.slice(2);
  return soundIndex.get(n) ?? 0;
}

/** Sprite frame bits (Doom's FF_FULLBRIGHT / FF_FRAMEMASK). */
export const FF_FULLBRIGHT = 0x8000;
export const FF_FRAMEMASK = 0x7fff;

/** Doom MF_* flags the renderer cares about. */
export const MF_SPAWNCEILING = 0x100;
export const MF_SHADOW = 0x40000;
export const MF_TRANSLATION = 0xc000000;
export const MF_TRANSSHIFT = 26;
