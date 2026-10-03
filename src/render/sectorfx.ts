// Cosmetic sector light specials (p_lights.c): blink, strobes, glow, fire flicker.
// Re-implemented as small per-sector state machines stepped by the frame's tic, with
// the renderer's own random numbers (purely visual, never fed back to the sim).
import type { MapData } from '../wad';

const enum Kind { None, Flash, Strobe, Glow, Flicker }
interface Fx { kind: Kind; min: number; max: number; count: number; a: number; b: number; dir: number; level: number }

export class SectorLightFx {
  private fx: (Fx | null)[];
  private lastTic = -1;
  private seed = 0x1234567;

  constructor(map: MapData) {
    const minNeighbor = (s: number) => {
      let m = map.sectors[s].light;
      for (const l of map.lines) {
        if (l.front < 0 || l.back < 0) continue;
        const a = map.sides[l.front].sector, b = map.sides[l.back].sector;
        if (a === s && map.sectors[b].light < m) m = map.sectors[b].light;
        if (b === s && map.sectors[a].light < m) m = map.sectors[a].light;
      }
      return m;
    };
    this.fx = map.sectors.map((sec, i) => {
      const max = sec.light;
      const strobe = (dark: number, sync: boolean): Fx => {
        let min = minNeighbor(i);
        if (min === max) min = 0;
        return { kind: Kind.Strobe, min, max, a: dark, b: 5, count: sync ? 1 : (this.rand() & 7) + 1, dir: 0, level: max };
      };
      switch (sec.special) {
        case 1: return { kind: Kind.Flash, min: minNeighbor(i), max, a: 64, b: 7, count: (this.rand() & 64) + 1, dir: 0, level: max };
        case 2: case 4: return strobe(15, false);
        case 3: return strobe(35, false);
        case 12: return strobe(35, true);
        case 13: return strobe(15, true);
        case 8: return { kind: Kind.Glow, min: minNeighbor(i), max, a: 0, b: 0, count: 0, dir: -1, level: max };
        case 17: return { kind: Kind.Flicker, min: minNeighbor(i) + 16, max, a: 0, b: 0, count: 4, dir: 0, level: max };
        default: return null;
      }
    });
  }

  private rand(): number {
    // xorshift, 0..255
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed & 255;
  }

  private step(): void {
    for (const f of this.fx) {
      if (!f) continue;
      switch (f.kind) {
        case Kind.Flash:
          if (--f.count) break;
          if (f.level === f.max) { f.level = f.min; f.count = (this.rand() & f.b) + 1; }
          else { f.level = f.max; f.count = (this.rand() & f.a) + 1; }
          break;
        case Kind.Strobe:
          if (--f.count) break;
          if (f.level === f.min) { f.level = f.max; f.count = f.b; }
          else { f.level = f.min; f.count = f.a; }
          break;
        case Kind.Glow:
          if (f.dir < 0) { f.level -= 8; if (f.level <= f.min) { f.level += 8; f.dir = 1; } }
          else { f.level += 8; if (f.level >= f.max) { f.level -= 8; f.dir = -1; } }
          break;
        case Kind.Flicker: {
          if (--f.count) break;
          const amount = (this.rand() & 3) * 16;
          f.level = f.level - amount < f.min ? f.min : f.max - amount;
          f.count = 4;
          break;
        }
      }
    }
  }

  /** Advances to `tic` (integer part). */
  update(tic: number): void {
    const t = Math.floor(tic);
    if (this.lastTic < 0 || t < this.lastTic || t - this.lastTic > 70) this.lastTic = t - 1;
    while (this.lastTic < t) { this.step(); this.lastTic++; }
  }

  /** Effective light for sector `s` given its current (sim) light. */
  light(s: number, simLight: number): number {
    const f = this.fx[s];
    if (!f) return simLight;
    return f.level;
  }
}
