// Our own dynamic-light table for Freedoom's sprites (written for this project; no
// GZDoom/UZDoom material — see DESIGN.md licensing).
//
// Only the *class* of each light lives here: reach, brightness, which frames glow and
// how it moves (flicker/pulse). Color and height are measured from the sprite itself at
// load time (RenderAssets.spriteGlow: luminance-weighted average of the frame's bright
// pixels and their centroid), so the light always matches Freedoom's art — e.g.
// Freedoom's soulsphere is gold and its megasphere red, unlike id's.

export interface LightClass {
  /** reach in map units (light falls to zero there) */
  radius: number;
  /** brightness multiplier on the measured color */
  intensity: number;
  /** frame letters that emit, with per-frame intensity (default: every frame at 1) */
  frames?: Record<string, number>;
  /** random per-tic brightness drop 0..1 (fire) */
  flicker?: number;
  /** slow sine pulse: [period seconds, depth 0..1] (pickups, lamps) */
  pulse?: [number, number];
  /** fixed height above the mobj's origin instead of the measured bright-pixel centroid */
  z?: number;
}

// Radii by object class: projectiles ~150, their explosions ~250-300, BFG ~400,
// floor lamps / tall torches ~230, short torches ~170, candles ~90, pickups ~80-120,
// puffs ~50. Intensity 1 = measured color at full strength (linear, added to albedo).
export const LIGHT_TABLE: Record<string, LightClass> = {
  // projectiles & impacts
  MISL: { radius: 150, intensity: 1.0, frames: { A: 0.9, B: 2.0, C: 1.3, D: 0.6 }, z: 4 },
  PLSS: { radius: 140, intensity: 1.1, z: 8 },
  PLSE: { radius: 170, intensity: 1.0, frames: { A: 1.5, B: 1.1, C: 0.7, D: 0.4, E: 0.2 }, z: 8 },
  BFS1: { radius: 260, intensity: 1.4, z: 16 },
  BFE1: { radius: 400, intensity: 1.0, frames: { A: 2.0, B: 1.8, C: 1.4, D: 1.0, E: 0.5, F: 0.25 }, z: 24 },
  BFE2: { radius: 140, intensity: 1.0, frames: { A: 1.2, B: 0.8, C: 0.4, D: 0.2 }, z: 16 },
  PUFF: { radius: 50, intensity: 0.9, frames: { A: 1.0, B: 0.6 }, z: 4 },
  BEXP: { radius: 260, intensity: 1.0, frames: { C: 1.0, D: 2.0, E: 1.0 } },
  TFOG: { radius: 150, intensity: 0.8, frames: { A: 1, B: 1, C: 0.85, D: 0.7, E: 0.5, F: 0.35, G: 0.2, H: 0.1 }, z: 28 },
  IFOG: { radius: 110, intensity: 0.8, frames: { A: 1, B: 0.8, C: 0.5, D: 0.3, E: 0.15 }, z: 20 },
  // light-source decorations
  TLMP: { radius: 240, intensity: 1.0, pulse: [3, 0.08] },
  TLP2: { radius: 200, intensity: 1.0, pulse: [3, 0.08] },
  COLU: { radius: 220, intensity: 1.0 },
  CAND: { radius: 90, intensity: 0.9, flicker: 0.15 },
  CBRA: { radius: 180, intensity: 1.0, flicker: 0.1 },
  FCAN: { radius: 220, intensity: 1.1, flicker: 0.3 },
  TRED: { radius: 230, intensity: 1.0, flicker: 0.25 },
  TGRN: { radius: 230, intensity: 1.0, flicker: 0.25 },
  TBLU: { radius: 230, intensity: 1.0, flicker: 0.25 },
  SMRT: { radius: 170, intensity: 1.0, flicker: 0.25 },
  SMGT: { radius: 170, intensity: 1.0, flicker: 0.25 },
  SMBT: { radius: 170, intensity: 1.0, flicker: 0.25 },
  POL3: { radius: 110, intensity: 0.9, flicker: 0.2 },
  FSKU: { radius: 140, intensity: 0.9, flicker: 0.3 },
  CEYE: { radius: 110, intensity: 0.8, pulse: [1.2, 0.3] },
  ELEC: { radius: 120, intensity: 0.6 },
  // glowing pickups
  SOUL: { radius: 120, intensity: 0.9, pulse: [2, 0.3] },
  MEGA: { radius: 120, intensity: 0.9, pulse: [2, 0.3] },
  PINV: { radius: 120, intensity: 0.9, pulse: [2, 0.3] },
  PVIS: { radius: 70, intensity: 0.6 },
  SUIT: { radius: 80, intensity: 0.5 },
  ARM1: { radius: 80, intensity: 0.6, pulse: [2.5, 0.2] },
  ARM2: { radius: 80, intensity: 0.6, pulse: [2.5, 0.2] },
  BON1: { radius: 48, intensity: 0.6 },
  BON2: { radius: 48, intensity: 0.5 },
  // players firing (fullbright attack frame F)
  PLAY: { radius: 160, intensity: 1.2, frames: { F: 1 }, z: 36 },
};

/** Weapon flash psprite → muzzle light for the local player: [radius, intensity]. */
export const MUZZLE_TABLE: Record<string, [number, number]> = {
  PISF: [170, 1.8], SHTF: [200, 2.0], SHT2: [220, 2.2], CHGF: [180, 1.8],
  MISF: [210, 2.0], PLSF: [180, 1.8], BFGF: [240, 2.0],
};
