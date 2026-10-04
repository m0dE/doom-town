// Graphics quality (DESIGN.md "Mobile" → "Graphics quality"): three levels of what the
// renderer spends per frame, the device guess "auto" starts from, and the render-scale
// governor that keeps auto at a playable frame rate.
//
// Render scale is relative to the device's pixels with the pixel ratio capped at 2: a
// 3x phone renders at most 2 pixels per CSS pixel. The governor only ever lowers the
// scale below the level's own, in steps, with a hysteresis that cannot flicker: down
// after ~2 s slow, up after ~5 s fast, and a step that had to be taken back is barred
// for a while (20 s, then 40 s, then for good). A step down that does not make frames
// faster (the CPU, not the pixels, is the limit) is taken back the same way.
import type { RendererOptions } from './renderer';

export type QualityPref = 'auto' | 'high' | 'medium' | 'low';
export type QualityLevel = 'high' | 'medium' | 'low';

export interface QualitySettings {
  /** render pixels per device pixel (device pixels: CSS px × min(DPR, 2)) */
  scale: number;
  bloom: 'full' | 'half' | 'off';
  /** dynamic lights kept per frame (the nearest visible ones) */
  maxLights: number;
  /** cheaper storm wall, supply smoke and composite (no grain), no contact darkening */
  lowFx: boolean;
  /** player bodies further than this (map units) are drawn as Doom's sprites, not 3D */
  bodyLod: number;
}

export const LEVELS: Readonly<Record<QualityLevel, Readonly<QualitySettings>>> = {
  high: { scale: 1, bloom: 'full', maxLights: 64, lowFx: false, bodyLod: Infinity },
  medium: { scale: 0.75, bloom: 'half', maxLights: 24, lowFx: false, bodyLod: 2048 },
  low: { scale: 0.5, bloom: 'off', maxLights: 8, lowFx: true, bodyLod: 1024 },
};

/** The device pixel ratio the render scale is relative to. */
export const MAX_DPR = 2;
/** The governor never goes below this many render pixels per CSS pixel. */
const MIN_CSS_SCALE = 0.5;

/** Renderer options for a level at a render scale (the governor's, ≤ the level's). */
export function rendererOptions(s: QualitySettings, scale = s.scale): RendererOptions {
  return {
    maxPixelRatio: MAX_DPR, resolutionScale: scale,
    bloom: s.bloom !== 'off', bloomHalf: s.bloom === 'half',
    maxLights: s.maxLights, lowFx: s.lowFx, bodyLod: s.bodyLod,
  };
}

export interface DeviceGuess { level: QualityLevel; why: string }

let guessed: DeviceGuess | null = null;

/**
 * The level auto starts at, from what the browser tells: a touch device, its memory
 * and cores, and the WebGL renderer string (unmasked where the browser allows).
 */
export function guessLevel(gl: WebGLRenderingContext | WebGL2RenderingContext | null): DeviceGuess {
  if (guessed) return guessed;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const touch = matchMedia?.('(pointer: coarse)').matches || (nav.maxTouchPoints ?? 0) > 0;
  const mem = nav.deviceMemory ?? 0;     // GB, Chrome only (rounded, capped at 8)
  const cores = nav.hardwareConcurrency ?? 0;
  let gpu = '';
  try {
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    gpu = String((ext && gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl?.getParameter(gl.RENDERER) || '');
  } catch { /* blocked */ }
  guessed = classify(gpu, touch, mem, cores);
  return guessed;
}

/** The decision itself (pure, for tests). */
export function classify(gpu: string, touch: boolean, mem: number, cores: number): DeviceGuess {
  const g = gpu.toLowerCase();
  const why = (level: QualityLevel, reason: string): DeviceGuess => ({ level, why: `${reason}${gpu ? ` (${gpu})` : ''}` });
  // software GL: every pixel costs CPU
  if (/swiftshader|llvmpipe|softpipe|software|microsoft basic render/.test(g)) return why('low', 'software renderer');
  // GPUs known to struggle with a full-resolution forward+ pass on a phone screen
  const adreno = /adreno[^0-9]*(\d{3})/.exec(g);
  const mali = /mali-?([gt])(\d+)/.exec(g);
  if (adreno) {
    const n = Number(adreno[1]);
    if (n < 600) return why('low', 'older Adreno');
    if (n < 700) return why(n >= 640 ? 'medium' : 'low', 'Adreno 6xx');
  }
  if (mali) {
    if (mali[1] === 't') return why('low', 'Mali T');
    const n = Number(mali[2]);
    if (n < 70) return why('low', 'Mali G5x');
    if (n < 710) return why('medium', 'Mali G7x');
  }
  if (/powervr|sgx|videocore|tegra 3|tegra 4/.test(g)) return why('low', 'PowerVR / VideoCore');
  if (touch) {
    if ((mem && mem <= 3) || (cores && cores <= 4)) return why('low', `small phone (${mem || '?'} GB, ${cores || '?'} cores)`);
    // phones and tablets with a decent GPU (Apple, recent Adreno / Mali / Xclipse): never
    // full resolution on a 3x screen, the governor takes it from there
    return why('medium', 'touch device');
  }
  if ((mem && mem <= 2) || (cores && cores <= 2)) return why('medium', `small machine (${mem || '?'} GB, ${cores || '?'} cores)`);
  // integrated laptop GPUs on a big screen are handled by the governor
  return why('high', 'desktop');
}

/** Frame-time bands: below 48 fps is slow (aim ≥ 50), 57 and up is fast (a 60 Hz screen at its rate). */
const SLOW_MS = 1000 / 48, FAST_MS = 1000 / 57;
const CHUNK_MS = 500;
const DOWN_CHUNKS = 4;   // ~2 s slow
const UP_CHUNKS = 10;    // ~5 s fast
const SETTLE_MS = 1500;  // after a change (and a map load), before measuring again
const BAR_MS = 20000;    // a failed step stays barred this long, doubling per failure,
const BAR_MAX = 40000;   // and for good (this level, this map) once it failed a third time
/** steps below the level's own scale (multipliers) */
const STEPS = [1, 0.85, 0.72, 0.6, 0.5, 0.42, 0.35];

/**
 * The auto render-scale governor. Feed it every frame's timestamp; `scale` is the
 * multiplier on the level's scale (1 = the level's own). `changed` is true on the call
 * that moved it.
 */
export class ScaleGovernor {
  /** index into STEPS */
  private step = 0;
  private maxStep = STEPS.length - 1;
  private last = 0;
  private chunkStart = 0;
  private chunkFrames = 0;
  private slow = 0;
  private fast = 0;
  /** sum of the slow streak's chunk frame times */
  private slowMs = 0;
  private settleUntil = 0;
  /** per step: barred until (ms), and its current bar length */
  private barUntil = new Float64Array(STEPS.length);
  private barLen = new Float64Array(STEPS.length).fill(BAR_MS);
  /** the frame time before the last down step, and when it was taken (to see whether it helped) */
  private beforeDown = 0;
  private downAt = 0;
  /** no down steps until then: lowering the resolution did not help (CPU bound) */
  private holdDown = 0;
  private holdLen = 30000;
  /** last measured chunk: mean frame ms */
  frameMs = 0;

  get scale(): number { return STEPS[this.step]; }

  /** The level's scale and the device: the lowest step keeps ≥ MIN_CSS_SCALE px per CSS px. */
  configure(levelScale: number, dpr: number): void {
    const dev = Math.min(Math.max(1, dpr), MAX_DPR) * levelScale;
    let m = 0;
    while (m < STEPS.length - 1 && dev * STEPS[m + 1] >= MIN_CSS_SCALE - 1e-6) m++;
    this.maxStep = m;
    if (this.step > m) this.step = m;
  }

  /** Start over at the level's own scale (a new level or an explicit choice). */
  reset(now: number): void {
    this.step = 0;
    this.barUntil.fill(0);
    this.barLen.fill(BAR_MS);
    this.holdDown = 0;
    this.settle(now);
  }

  /** Ignore the frames for a moment (map load, resume, a change of scale). */
  settle(now: number): void {
    this.settleUntil = now + SETTLE_MS;
    this.chunkStart = 0; this.chunkFrames = 0; this.slow = 0; this.fast = 0; this.slowMs = 0;
  }

  /** One frame drawn at `now` (ms). Returns true when the scale changed. */
  frame(now: number): boolean {
    const dt = this.last ? now - this.last : 0;
    this.last = now;
    // a gap of seconds is the tab in the background or a load, not the frame rate
    if (dt > 2000) { this.settle(now); return false; }
    if (now < this.settleUntil) return false;
    if (!this.chunkStart) { this.chunkStart = now; this.chunkFrames = 0; return false; }
    this.chunkFrames++;
    const span = now - this.chunkStart;
    if (span < CHUNK_MS) return false;
    const ms = span / this.chunkFrames;
    this.frameMs = ms;
    this.chunkStart = now; this.chunkFrames = 0;
    if (ms > SLOW_MS) { this.slow++; this.slowMs += ms; this.fast = 0; }
    else if (ms <= FAST_MS) { this.fast++; this.slow = 0; this.slowMs = 0; }
    else { this.slow = 0; this.slowMs = 0; this.fast = 0; }
    const slowMean = this.slow ? this.slowMs / this.slow : 0;
    // the down step just taken did not help (under 5 % faster): CPU bound, not pixels -
    // take it back and hold off further steps down (30 s, doubling)
    if (this.downAt && now - this.downAt > 15000) this.downAt = 0;
    if (this.downAt && this.slow >= DOWN_CHUNKS && this.step > 0 && slowMean > this.beforeDown * 0.95) {
      this.downAt = 0;
      this.holdDown = now + this.holdLen;
      this.holdLen = this.holdLen >= 2 * 30000 ? Infinity : this.holdLen * 2;
      this.barUntil[this.step - 1] = 0;
      return this.move(this.step - 1, now);
    }
    if (this.slow >= DOWN_CHUNKS && this.step < this.maxStep && now >= this.holdDown) {
      // the step we leave failed: bar it, longer each time
      const s = this.step;
      this.barUntil[s] = now + this.barLen[s];
      this.barLen[s] = this.barLen[s] >= BAR_MAX ? Infinity : this.barLen[s] * 2;
      this.beforeDown = slowMean;
      this.downAt = now;
      return this.move(s + 1, now);
    }
    if (this.slow >= DOWN_CHUNKS) { this.downAt = 0; this.slow = 0; this.slowMs = 0; }
    if (this.fast >= UP_CHUNKS && this.step > 0 && now >= this.barUntil[this.step - 1]) {
      this.downAt = 0;
      return this.move(this.step - 1, now);
    }
    if (this.fast >= UP_CHUNKS) this.fast = 0;
    return false;
  }

  private move(step: number, now: number): boolean {
    if (step === this.step) return false;
    this.step = step;
    this.settle(now);
    return true;
  }
}
