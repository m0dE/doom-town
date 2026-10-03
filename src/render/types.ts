// The renderer's input, filled by the game loop from lockstep.view() (DESIGN.md "TS side
// contracts"). Everything is in Doom map units (floats, not 16.16 fixed) and radians.
// The renderer never touches the sim; it only reads a RenderFrame.
//
// Allocation-free use: keep one RenderFrame and reuse its arrays/objects every frame;
// set `mobjCount` instead of resizing `mobjs`.

export interface RenderCamera {
  /** eye position, map units; z is the absolute view height (player viewz) */
  x: number;
  y: number;
  z: number;
  /** radians, Doom convention: 0 = east (+x), counter-clockwise (BAM * 2π / 2^32) */
  yaw: number;
  /** radians, positive = looking up (sim pitch BAM, clamped ±0.9·90°) */
  pitch: number;
}

export interface RenderMobj {
  /** MobjView id (stable for the mobj's life) */
  id: number;
  /** interpolated position, map units; z = bottom of the mobj */
  x: number;
  y: number;
  z: number;
  /** radians, Doom convention (BAM → rad) */
  angle: number;
  /** index into SPRITE_NAMES (Doom sprnames order) */
  sprite: number;
  /** frame number with FF_FULLBRIGHT (0x8000) kept */
  frame: number;
  /** Doom MF_* bits (MF_SHADOW 0x40000 → spectre fuzz) */
  flags: number;
  /** mobjtype_t index */
  type: number;
  /** player slot for player bodies, -1 otherwise */
  slot: number;
  /** player color: index into PLAYER_COLORS (0 = untranslated green) */
  translation: number;
}

export interface RenderSector {
  /** current floor/ceiling heights, map units (moving doors and lifts) */
  floor: number;
  ceil: number;
  /** current light level 0..255 */
  light: number;
  /** current flat numbers from the sim (index into the sim's flat name table), optional */
  floorpic?: number;
  ceilpic?: number;
}

export interface RenderPsprite {
  /** index into SPRITE_NAMES */
  sprite: number;
  /** frame | FF_FULLBRIGHT */
  frame: number;
  /** Doom psprite position in 320×200 units (fixed / 65536), weapon bob included */
  sx: number;
  sy: number;
}

export interface RenderPlayer {
  /** PlayerView fields used for screen tints / lighting */
  damagecount: number;
  bonuscount: number;
  /** 0..2, from gun flashes */
  extralight: number;
  /** 0 none, 1 light amp (fullbright), 32 invulnerability (inverse map) */
  fixedcolormap: number;
  /** tics remaining: [invuln, strength, invis, ironfeet, allmap, infrared] */
  powers: ArrayLike<number>;
  /** weapon and muzzle flash psprites, null when absent (sprite -1 in PlayerView) */
  weapon: RenderPsprite | null;
  flash: RenderPsprite | null;
}

/** Sim Event (DESIGN.md table), with x/y/z converted to map units. */
export interface RenderEvent {
  kind: number;
  a: number;
  b: number;
  c: number;
  x: number;
  y: number;
  z: number;
  d: number;
}

export interface RenderFrame {
  /** sim tic, may carry the interpolation fraction (drives texture animation, scrolling, light specials) */
  tic: number;
  camera: RenderCamera;
  mobjs: ArrayLike<RenderMobj>;
  /** number of valid entries in `mobjs` (defaults to mobjs.length) */
  mobjCount?: number;
  /** mobj id of the camera's own body: not drawn (still used for its sound/flash events) */
  viewMobjId?: number;
  /** per map sector, in map order; null = load-time values */
  sectors: ArrayLike<RenderSector> | null;
  /**
   * Side-0 texture numbers per line (top, mid, bottom, 3 per line; world_view_lines),
   * indices into the sim's texture name table (Renderer.setSimNameTables). null = map's.
   */
  lineTextures: ArrayLike<number> | null;
  /** local player status (null when spectating / no player) */
  player: RenderPlayer | null;
  /** events from the tics consumed since the previous frame */
  events: ArrayLike<RenderEvent>;
  eventCount?: number;
}

/** Hook for drawing player bodies some other way than sprites (e.g. 3D models). */
export interface PlayerBodyRenderer {
  /**
   * Called once per frame with the player-body mobjs that the sprite path skipped
   * (`bodies[0..count)`), before the scene is drawn: every PLAY-sprite mobj except
   * the camera's own body - live players (slot >= 0), their corpses (slot -1) and
   * invisible ones (MF_SHADOW; the hook draws the fuzz). `lightOf(m)` returns the Doom
   * light level (0..255, specials applied) of the sector the body stands in. Objects
   * added to `scene` are drawn with the world (scene is Z-up, Doom map units).
   */
  update(bodies: readonly RenderMobj[], count: number, ctx: PlayerBodyContext): void;
  dispose?(): void;
}
export interface PlayerBodyContext {
  scene: import('three').Scene;
  camera: import('three').PerspectiveCamera;
  lightOf(m: RenderMobj): number;
  /** floor height under the body (map units, moving floors included) */
  floorOf(m: RenderMobj): number;
  /** dynamic light (linear RGB, renderer gain applied) at map point x, y, z for a body in `m`'s sector */
  dynLightAt(m: RenderMobj, z: number, out: import('three').Vector3): import('three').Vector3;
  extralight: number;
  tic: number;
  /** seconds, monotonic (animation clock) */
  time: number;
  /** the renderer's palette texture: 256 × (14 palettes · 34 COLORMAP rows), linear RGB */
  palette: import('three').Texture;
  /** current screen palette (damage/pickup/radsuit tint), 0..13 */
  palNum: number;
  /** fixed colormap row (light amp 1 → fullbright, 32 invulnerability), -1 = none */
  fixedColormap: number;
}
