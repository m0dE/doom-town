// Style factories shared by the war maps.
import type { Solid, Style } from './canvas.mts';

/**
 * One sky height over every outdoor area and every low wall mass: two sky ceilings of
 * different heights make Doom's sky hack draw a sky "wall" between them that hides what is
 * behind (only map-edge ridges use that on purpose, to form the horizon). Building roofs
 * with doorways sit exactly at SKYH so the wall above a doorway is the facade.
 */
export const SKYH = 448;
export const SKY = 'F_SKY1';

/** Outdoor ground (sky ceiling at SKYH). */
export function out(floor: number, pic = 'GRASS2', o: Partial<Style> = {}): Style {
  return { floor, ceil: SKYH, floorPic: pic, ceilPic: SKY, light: 208, wall: 'ROCK4', riser: 'ROCK4', upper: 'ROCK4', ...o };
}
/** Indoor space. */
export function room(floor: number, ceil: number, pic: string, cpic: string, light: number, o: Partial<Style> = {}): Style {
  return { floor, ceil, floorPic: pic, ceilPic: cpic, light, wall: 'GRAY7', riser: 'STEP3', upper: 'GRAY7', ...o };
}
/** A wall mass: a raised sector under the common sky, its top visible from above. */
export function mass(top: number, face: string, o: Partial<Style> = {}): Style {
  return { floor: top, ceil: Math.max(SKYH, top + 8), floorPic: 'FLAT1', ceilPic: SKY, light: 192, wall: face, riser: face, upper: face, ...o };
}
export const solid = (wall: string, peg: 'floor' | 'ceil' = 'floor'): Solid => ({ solid: true, wall, wallPeg: peg });
