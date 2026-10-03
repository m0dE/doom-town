/**
 * The world view of a match: one canvas, a three.js Renderer per map. A room plays
 * a rotation of maps, so the view is told which map to show (`setMap`) when the
 * sim's world changes map (event 9, or the map it is on at join) and builds that
 * map's renderer from the map's own art (base pak + public/maps/<MAP>.wad).
 *
 * Until a map is set (or while the next one is being built) `ready` is false and
 * `render` draws nothing; the HUD says what is loading. Where WebGL will not start
 * the view falls back to Doom's automap, drawn into a 2D canvas over the same spot.
 */
import { Renderer } from '../render/index.js';
import { parseMap, type Wad } from '../wad/index.js';
import type { RenderFrame } from '../render/types.js';
import { AutomapView, type WorldView } from './automap.js';
import { ModelBodies } from './bodies.js';

export interface WarmView { canvas: HTMLCanvasElement; renderer: Renderer; map: string }

export class MapView implements WorldView {
  readonly canvas: HTMLCanvasElement;
  private renderer: Renderer | null = null;
  private automap: AutomapView | null = null;
  private noGl = false;
  private hudPx = 0;
  private players: '3d' | 'sprites' = '3d';
  map = '';

  constructor(private fov: number, private readonly bodyWad: Wad, private warm: WarmView | null) {
    this.canvas = warm?.canvas ?? document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
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
      this.renderer = r;
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
    if (this.renderer) { this.renderer.setFrame(f); this.renderer.render(); }
    else this.automap?.render(f);
  }

  resize(w: number, h: number): void { this.automap?.resize(w, h); }
  hudHeight(px: number): void { this.hudPx = px; this.renderer?.setHudHeightPx(px); }
  setFov(deg: number): void { this.fov = deg; this.renderer?.setOptions({ fov: deg }); }

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

  stats(): Record<string, number> {
    const r = this.renderer;
    if (!r) return {};
    const b = r.playerBodyRenderer as ModelBodies | null;
    return { ...r.stats, bodies3d: b?.count ?? 0, posed3d: b?.posed ?? 0 };
  }

  dispose(): void {
    this.renderer?.dispose();
    this.warm?.renderer.dispose();
    this.automap?.dispose();
    this.renderer = null;
    this.canvas.remove();
  }
}
