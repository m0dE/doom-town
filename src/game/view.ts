/**
 * The world view of a match: one canvas, a three.js Renderer per map. A room plays
 * a rotation of maps, so the view is told which map to show (`setMap`) when the
 * sim's world changes map (event 9, or the map it is on at join) and builds that
 * map's renderer from the map's own art (base pak + public/maps/<MAP>.wad).
 *
 * Until a map is set (or while the next one is being built) `ready` is false and
 * `render` draws nothing; the HUD says what is loading. Where WebGL will not start
 * the view falls back to Doom's automap, drawn into a 2D canvas over the same spot.
 *
 * Graphics quality (DESIGN.md "Mobile"): the view applies `prefs.quality` to its
 * renderer, live, and in 'auto' feeds every frame to the render-scale governor
 * (src/render/quality.ts). `prefs.showFps` puts a small frame-rate counter over it.
 */
import { Renderer } from '../render/index.js';
import { parseMap, type Wad } from '../wad/index.js';
import type { RenderFrame } from '../render/types.js';
import { AutomapView, type WorldView } from './automap.js';
import { ModelBodies } from './bodies.js';
import { LEVELS, ScaleGovernor, guessLevel, rendererOptions, type QualityLevel } from '../render/quality.js';
import { onPrefs, prefs, type Prefs } from '../menu/prefs.js';

export interface WarmView { canvas: HTMLCanvasElement; renderer: Renderer; map: string }

export class MapView implements WorldView {
  readonly canvas: HTMLCanvasElement;
  private renderer: Renderer | null = null;
  private automap: AutomapView | null = null;
  private noGl = false;
  private hudPx = 0;
  private players: '3d' | 'sprites' = '3d';
  map = '';
  private quality: Prefs['quality'];
  private level: QualityLevel = 'high';
  private levelWhy = '';
  private readonly governor = new ScaleGovernor();
  private readonly offPrefs: () => void;
  private fpsBox: HTMLDivElement | null = null;
  private fpsFrames = 0;
  private fpsSince = 0;
  private fpsWorst = 0;
  private fpsLast = 0;

  constructor(private fov: number, private readonly bodyWad: Wad, private warm: WarmView | null) {
    this.canvas = warm?.canvas ?? document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    const p = prefs();
    this.quality = p.quality;
    this.setShowFps(p.showFps);
    // the Esc menu saves prefs: quality and the counter apply at once, no reload
    this.offPrefs = onPrefs((np) => { this.setQuality(np.quality); this.setShowFps(np.showFps); });
  }

  get ready(): boolean { return !!this.renderer || !!this.automap; }

  /** Show `map` (its art in `wad`; the sim's name tables for its lines and sectors). */
  setMap(map: string, wad: Wad, tables: { textures: string[]; flats: string[] }): void {
    if (map === this.map && this.ready) return;
    const t0 = performance.now();
    this.renderer?.dispose();
    this.renderer = null;
    this.map = map;
    if (this.noGl) { this.useAutomap(map, wad); return; }
    try {
      let r: Renderer;
      if (this.warm && this.warm.map === map) {
        r = this.warm.renderer;
        r.setOptions({ fov: this.fov });
      } else {
        this.warm?.renderer.dispose();
        r = new Renderer(this.canvas, wad, map, { fov: this.fov });
      }
      this.warm = null;
      r.setSimNameTables(tables.textures, tables.flats);
      r.setHudHeightPx(this.hudPx);
      r.setZoomFov(this.zoomFov);
      this.renderer = r;
      this.applyQuality(false);
      this.governor.settle(performance.now());
      this.applyPlayers();
      console.info(`[render] ${map} ready in ${Math.round(performance.now() - t0)} ms`);
    } catch (err) {
      console.warn('[render] no 3D view, drawing the automap instead:', err);
      this.noGl = true;
      this.useAutomap(map, wad);
    }
  }

  private useAutomap(map: string, wad: Wad): void {
    this.automap?.dispose();
    this.automap = new AutomapView(parseMap(map, wad.mapLumps(map)));
    this.canvas.parentElement?.append(this.automap.canvas);
    this.automap.resize(innerWidth, innerHeight);
  }

  render(f: RenderFrame): void {
    if (this.renderer) {
      this.renderer.setFrame(f);
      this.renderer.render();
      const now = performance.now();
      if (this.quality === 'auto' && this.governor.frame(now)) this.applyQuality(false);
      if (this.fpsBox) this.countFrame(now);
    } else this.automap?.render(f);
  }

  /** Graphics quality: 'auto' or a fixed level; applies to the running renderer at once. */
  setQuality(q: Prefs['quality']): void {
    if (q === this.quality) return;
    this.quality = q;
    this.applyQuality(true);
  }

  /** The level's settings at the governor's scale (auto) or the level's own. */
  private applyQuality(reset: boolean): void {
    const r = this.renderer;
    if (!r) return;
    if (this.quality === 'auto') {
      const g = guessLevel(r.gl.getContext());
      this.level = g.level; this.levelWhy = g.why;
    } else { this.level = this.quality; this.levelWhy = 'chosen'; }
    const s = LEVELS[this.level];
    if (reset) this.governor.reset(performance.now());
    this.governor.configure(s.scale, window.devicePixelRatio || 1);
    r.setOptions(rendererOptions(s, s.scale * (this.quality === 'auto' ? this.governor.scale : 1)));
  }

  /** The frame-rate counter (prefs.showFps): fps and the slowest frame of the last half second. */
  private setShowFps(on: boolean): void {
    if (!on) { this.fpsBox?.remove(); this.fpsBox = null; return; }
    if (this.fpsBox) return;
    const el = document.createElement('div');
    el.className = 'fps-counter';
    el.style.cssText = 'position:absolute;left:max(6px, env(safe-area-inset-left));top:38%;z-index:21;pointer-events:none;'
      + 'font:11px/1.25 ui-monospace,Menlo,Consolas,monospace;color:#d8f5c8;background:rgba(0,0,0,.5);padding:2px 5px;border-radius:3px;white-space:pre';
    el.textContent = '-- fps';
    this.fpsBox = el;
    this.fpsFrames = 0; this.fpsSince = 0; this.fpsWorst = 0;
    (this.canvas.parentElement ?? document.body).append(el);
  }

  private countFrame(now: number): void {
    const box = this.fpsBox!;
    if (!box.isConnected && this.canvas.parentElement) this.canvas.parentElement.append(box);
    if (this.fpsLast) this.fpsWorst = Math.max(this.fpsWorst, now - this.fpsLast);
    this.fpsLast = now;
    if (!this.fpsSince) { this.fpsSince = now; this.fpsFrames = 0; this.fpsWorst = 0; return; }
    this.fpsFrames++;
    const span = now - this.fpsSince;
    if (span < 500) return;
    const st = this.renderer?.stats;
    const lv = this.level === 'medium' ? 'med' : this.level;
    box.textContent = `${(this.fpsFrames * 1000 / span).toFixed(0)} fps  ${Math.round(this.fpsWorst)} ms\n`
      + `${this.quality === 'auto' ? 'auto ' : ''}${lv} ${st ? `${st.width}×${st.height}` : ''}`;
    this.fpsSince = now; this.fpsFrames = 0; this.fpsWorst = 0;
  }

  resize(w: number, h: number): void {
    this.automap?.resize(w, h);
    // a rotated phone or a moved window can change the pixel ratio
    if (this.renderer) this.applyQuality(false);
  }
  hudHeight(px: number): void { this.hudPx = px; this.renderer?.setHudHeightPx(px); }
  setFov(deg: number): void { this.fov = deg; this.renderer?.setOptions({ fov: deg }); }
  /** The scope's field of view while zoomed (null: the player's own); survives a map change. */
  setZoomFov(deg: number | null): void { this.zoomFov = deg; this.renderer?.setZoomFov(deg); }
  private zoomFov: number | null = null;

  setPlayers(mode: '3d' | 'sprites'): void {
    this.players = mode;
    this.applyPlayers();
  }

  private applyPlayers(): void {
    const r = this.renderer;
    if (!r) return;
    const want3d = this.players === '3d';
    if (want3d && !r.playerBodyRenderer) r.setPlayerBodyRenderer(new ModelBodies(this.bodyWad));
    else if (!want3d && r.playerBodyRenderer) r.setPlayerBodyRenderer(null);
  }

  stats(): Record<string, number | string> {
    const r = this.renderer;
    if (!r) return {};
    const b = r.playerBodyRenderer as ModelBodies | null;
    return {
      ...r.stats, bodies3d: b?.count ?? 0, posed3d: b?.posed ?? 0, ragdolls3d: b?.ragdolls ?? 0,
      quality: this.quality, level: this.level, why: this.levelWhy, scale: r.options.resolutionScale, govMs: this.governor.frameMs,
    };
  }

  dispose(): void {
    this.offPrefs();
    this.fpsBox?.remove();
    this.renderer?.dispose();
    this.warm?.renderer.dispose();
    this.automap?.dispose();
    this.renderer = null;
    this.canvas.remove();
  }
}
