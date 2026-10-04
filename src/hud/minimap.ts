/**
 * The minimap of War and Battle royale rooms (DESIGN.md "War minimap and contested
 * points"): the whole map north-up at the top right, `M` for a large one in the middle.
 *
 * The map's walls (one-sided lines, and two-sided ones with a real step) are drawn
 * once per pixel size to an offscreen canvas; every frame copies that and draws on it
 * the safe zone (battle royale), the capture points (owner-coloured, lettered, with a
 * progress ring in the capturing team's colour, blinking while taken or contested),
 * teammates as dots (never enemies) and ourselves as a gold arrow.
 */
import type { MapData } from '../wad/index.js';
import type { DoomFont } from './font.js';

export interface MinimapPoint {
  x: number; y: number; r: number;
  owner: number;
  /** -100 (red) .. 100 (blue) */
  progress: number;
  /** someone is taking it or both teams are inside: it blinks */
  blink: boolean;
  /** colour the blink alternates with (the attacker's; white when contested) */
  blinkCss: string;
}

export interface MinimapState {
  points: MinimapPoint[];
  /** teammates' positions, x, y pairs (map units) */
  mates: number[];
  mateCss: string;
  self: { x: number; y: number; angle: number } | null;
  zone: { x: number; y: number; r: number; nx: number; ny: number; nr: number } | null;
  /** battle royale v2, the drop: the dropship and its heading (the flight line runs through it) */
  ship?: { x: number; y: number; dx: number; dy: number } | null;
  /** battle royale v2: a supply drop (state 1 incoming, 2 landed) */
  supply?: { x: number; y: number; state: number } | null;
}

const TEAM_CSS = ['#ff4a3a', '#5a7bff'];
const NEUTRAL = '#6b655c';
const GOLD = '#ffd25a';
const LETTERS = 'ABCDEFGH';

/**
 * A capture point as the HUD shows it (flags: 1 red inside, 2 blue inside): being taken
 * when one team stands in a point it does not own (it blinks in that team's colour),
 * contested when both teams are inside (it blinks white).
 */
export function pointState(p: { owner: number; flags: number }): { blink: boolean; contested: boolean; attacker: number; attackerCss: string } {
  const red = (p.flags & 1) !== 0, blue = (p.flags & 2) !== 0;
  if (red && blue) return { blink: true, contested: true, attacker: -1, attackerCss: '#ffffff' };
  const team = red ? 0 : blue ? 1 : -1;
  if (team >= 0 && p.owner !== team) return { blink: true, contested: false, attacker: team, attackerCss: TEAM_CSS[team] };
  return { blink: false, contested: false, attacker: -1, attackerCss: '' };
}

export class Minimap {
  readonly el = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private map: MapData | null = null;
  private bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };
  private walls: HTMLCanvasElement | null = null;
  private wallsKey = '';
  private k = 2;
  big = false;

  constructor(private readonly font: DoomFont) {
    this.el.className = 'h-map';
    this.el.hidden = true;
    this.el.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  /** The map to draw (null: none, the minimap hides). */
  setMap(map: MapData | null): void {
    if (map === this.map) return;
    this.map = map;
    this.walls = null;
    this.wallsKey = '';
    if (!map || !map.vertexes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const v of map.vertexes) { x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y); }
    const pad = Math.max(x1 - x0, y1 - y0) * 0.03;
    this.bounds = { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  }

  get hasMap(): boolean { return !!this.map; }

  setK(k: number): void { this.k = k; }

  toggleBig(): void { this.big = !this.big; }

  /** CSS size of the map box: 112 HUD pixels wide at the corner (224 CSS px at 720p), most of the screen when large; the map's aspect, within limits. */
  private cssSize(): { w: number; h: number } {
    const b = this.bounds;
    const aspect = Math.max(0.6, Math.min(1.5, (b.y1 - b.y0) / Math.max(1, b.x1 - b.x0)));
    if (this.big) {
      const side = Math.min(innerHeight * 0.8, innerWidth * 0.8);
      return aspect >= 1 ? { w: Math.round(side / aspect), h: Math.round(side) } : { w: Math.round(side), h: Math.round(side * aspect) };
    }
    const w = 112 * this.k;
    return { w, h: Math.round(w * aspect) };
  }

  draw(s: MinimapState | null, now: number): void {
    const show = !!s && !!this.map;
    this.el.hidden = !show;
    this.el.classList.toggle('big', show && this.big);
    if (!show || !s) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const css = this.cssSize();
    const W = Math.max(1, Math.round(css.w * dpr)), H = Math.max(1, Math.round(css.h * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W; this.canvas.height = H;
      this.canvas.style.width = `${css.w}px`; this.canvas.style.height = `${css.h}px`;
      // the killfeed sits under the corner map (hud.css)
      if (!this.big) this.el.parentElement?.style.setProperty('--map-h', `${css.h}px`);
    }
    // one HUD pixel in canvas pixels (the large map draws its marks bigger)
    const u = (dpr * this.k) / 2 * (this.big ? 1.6 : 1);
    const b = this.bounds;
    const sc = Math.min(W / (b.x1 - b.x0), H / (b.y1 - b.y0));
    const ox = (W - (b.x1 - b.x0) * sc) / 2, oy = (H - (b.y1 - b.y0) * sc) / 2;
    const px = (x: number): number => ox + (x - b.x0) * sc;
    const py = (y: number): number => oy + (b.y1 - y) * sc;

    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(6, 4, 3, 0.62)';
    c.fillRect(0, 0, W, H);
    c.drawImage(this.wallCanvas(W, H, sc, ox, oy, u), 0, 0);

    // battle royale: outside the zone tinted, the zone white, the next one dashed
    const z = s.zone;
    if (z && z.r > 0) {
      c.save();
      c.beginPath();
      c.rect(0, 0, W, H);
      c.arc(px(z.x), py(z.y), z.r * sc, 0, Math.PI * 2);
      c.fillStyle = 'rgba(210, 30, 18, 0.26)';
      c.fill('evenodd');
      c.beginPath();
      c.arc(px(z.x), py(z.y), z.r * sc, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      c.lineWidth = 1.2 * u;
      c.stroke();
      if (z.nr > 0 && (Math.abs(z.nr - z.r) > 1 || Math.abs(z.nx - z.x) > 1 || Math.abs(z.ny - z.y) > 1)) {
        c.beginPath();
        c.arc(px(z.nx), py(z.ny), z.nr * sc, 0, Math.PI * 2);
        c.setLineDash([3 * u, 3 * u]);
        c.strokeStyle = 'rgba(255, 255, 255, 0.75)';
        c.lineWidth = 1 * u;
        c.stroke();
      }
      c.restore();
    }

    // the dropship's flight line, across the whole map, and the ship on it
    if (s.ship && (s.ship.dx || s.ship.dy)) {
      const sh = s.ship;
      const L = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
      c.save();
      c.beginPath();
      c.moveTo(px(sh.x - sh.dx * L), py(sh.y - sh.dy * L));
      c.lineTo(px(sh.x + sh.dx * L), py(sh.y + sh.dy * L));
      c.setLineDash([4 * u, 3 * u]);
      c.strokeStyle = 'rgba(255, 210, 90, 0.85)';
      c.lineWidth = 1.2 * u;
      c.stroke();
      c.setLineDash([]);
      c.translate(px(sh.x), py(sh.y));
      c.rotate(-Math.atan2(sh.dy, sh.dx));
      c.beginPath();
      // a plane seen from above
      c.moveTo(7 * u, 0); c.lineTo(1 * u, 1.4 * u); c.lineTo(-1 * u, 6 * u); c.lineTo(-3 * u, 6 * u); c.lineTo(-2 * u, 1.4 * u);
      c.lineTo(-6 * u, 1.2 * u); c.lineTo(-7 * u, 3 * u); c.lineTo(-8 * u, 3 * u); c.lineTo(-7.5 * u, 0);
      c.lineTo(-8 * u, -3 * u); c.lineTo(-7 * u, -3 * u); c.lineTo(-6 * u, -1.2 * u); c.lineTo(-2 * u, -1.4 * u);
      c.lineTo(-3 * u, -6 * u); c.lineTo(-1 * u, -6 * u); c.lineTo(1 * u, -1.4 * u); c.closePath();
      c.fillStyle = '#f4f0e8';
      c.fill();
      c.lineWidth = 0.7 * u;
      c.strokeStyle = 'rgba(0, 0, 0, 0.9)';
      c.stroke();
      c.restore();
    }

    // a supply drop: a red crate, ringed while it is still coming down
    if (s.supply) {
      const x = px(s.supply.x), y = py(s.supply.y);
      if (s.supply.state === 1) {
        const t = (now % 1200) / 1200;
        c.beginPath();
        c.arc(x, y, (4 + 8 * t) * u, 0, Math.PI * 2);
        c.strokeStyle = `rgba(255, 70, 50, ${1 - t})`;
        c.lineWidth = 1.2 * u;
        c.stroke();
      }
      c.fillStyle = '#e8321e';
      c.fillRect(x - 3 * u, y - 3 * u, 6 * u, 6 * u);
      c.lineWidth = 0.8 * u;
      c.strokeStyle = '#ffffff';
      c.strokeRect(x - 3 * u, y - 3 * u, 6 * u, 6 * u);
    }

    // capture points: the whole capture radius of one being taken is washed in the
    // attacker's colour (white when contested), so the ground being overridden shows
    const blinkOn = Math.floor(now / 260) % 2 === 0;
    for (const p of s.points) {
      // the radius itself, faint, in the owner's colour
      c.beginPath();
      c.arc(px(p.x), py(p.y), p.r * sc, 0, Math.PI * 2);
      c.globalAlpha = 0.18;
      c.fillStyle = p.owner >= 0 ? TEAM_CSS[p.owner] : NEUTRAL;
      c.fill();
      c.globalAlpha = 1;
      if (!p.blink) continue;
      c.beginPath();
      c.arc(px(p.x), py(p.y), Math.max(p.r * sc, 3 * u), 0, Math.PI * 2);
      c.globalAlpha = blinkOn ? 0.45 : 0.28;
      c.fillStyle = p.blinkCss;
      c.fill();
      c.globalAlpha = 0.9;
      c.lineWidth = 1 * u;
      c.strokeStyle = p.blinkCss;
      c.stroke();
      c.globalAlpha = 1;
    }
    s.points.forEach((p, i) => {
      const x = px(p.x), y = py(p.y);
      const R = 6.5 * u;
      let fill = p.owner >= 0 ? TEAM_CSS[p.owner] : NEUTRAL;
      if (p.blink && blinkOn) fill = p.blinkCss;
      c.beginPath();
      c.arc(x, y, R, 0, Math.PI * 2);
      c.globalAlpha = 0.85;
      c.fillStyle = fill;
      c.fill();
      c.globalAlpha = 1;
      c.lineWidth = 1 * u;
      c.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      c.stroke();
      // the capture progress, in the colour of the team it moves toward
      const prog = Math.abs(p.progress) / 100;
      const toward = p.progress < 0 ? 0 : 1;
      if (prog > 0 && !(prog >= 1 && p.owner === toward)) {
        c.beginPath();
        c.arc(x, y, R + 1.4 * u, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
        c.lineWidth = 1.8 * u;
        c.strokeStyle = TEAM_CSS[toward];
        c.stroke();
      }
      const g = this.font.text(LETTERS[i] ?? '?', '#ffffff');
      const gs = Math.max(1, Math.round(u * (this.big ? 1.2 : 1)));
      c.imageSmoothingEnabled = false;
      c.drawImage(g, Math.round(x - (g.width * gs) / 2), Math.round(y - (g.height * gs) / 2), g.width * gs, g.height * gs);
    });

    // teammates
    c.fillStyle = s.mateCss;
    c.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    c.lineWidth = 0.6 * u;
    for (let i = 0; i + 1 < s.mates.length; i += 2) {
      c.beginPath();
      c.arc(px(s.mates[i]), py(s.mates[i + 1]), 1.5 * u, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    }

    // us: a gold arrow (Doom angles turn counter-clockwise, the canvas' y runs down)
    if (s.self) {
      c.save();
      c.translate(px(s.self.x), py(s.self.y));
      c.rotate(-s.self.angle);
      c.beginPath();
      c.moveTo(6 * u, 0);
      c.lineTo(-4 * u, 3.6 * u);
      c.lineTo(-2 * u, 0);
      c.lineTo(-4 * u, -3.6 * u);
      c.closePath();
      c.fillStyle = GOLD;
      c.fill();
      c.lineWidth = 0.8 * u;
      c.strokeStyle = 'rgba(0, 0, 0, 0.9)';
      c.stroke();
      c.restore();
    }
  }

  /** The walls at this pixel size, drawn once. */
  private wallCanvas(W: number, H: number, sc: number, ox: number, oy: number, u: number): HTMLCanvasElement {
    const key = `${W}x${H}x${u}`;
    if (this.walls && this.wallsKey === key) return this.walls;
    const cv = this.walls ?? document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d')!;
    c.clearRect(0, 0, W, H);
    const m = this.map!, b = this.bounds;
    const px = (x: number): number => ox + (x - b.x0) * sc;
    const py = (y: number): number => oy + (b.y1 - y) * sc;
    c.lineCap = 'round';
    // steps and ledges, faint
    c.beginPath();
    for (const l of m.lines) {
      if (l.back < 0 || l.front < 0) continue;
      const fs = m.sides[l.front]?.sector, bs = m.sides[l.back]?.sector;
      if (fs === undefined || bs === undefined || fs === bs) continue;
      const f = m.sectors[fs], k = m.sectors[bs];
      if (!f || !k || Math.abs(f.floor - k.floor) <= 24) continue;
      const a = m.vertexes[l.v1], e = m.vertexes[l.v2];
      c.moveTo(px(a.x), py(a.y)); c.lineTo(px(e.x), py(e.y));
    }
    c.strokeStyle = 'rgba(170, 146, 110, 0.6)';
    c.lineWidth = 0.7 * u;
    c.stroke();
    // walls
    c.beginPath();
    for (const l of m.lines) {
      if (l.back >= 0) continue;
      const a = m.vertexes[l.v1], e = m.vertexes[l.v2];
      c.moveTo(px(a.x), py(a.y)); c.lineTo(px(e.x), py(e.y));
    }
    c.strokeStyle = 'rgba(236, 216, 176, 0.95)';
    c.lineWidth = 1.1 * u;
    c.stroke();
    this.walls = cv;
    this.wallsKey = key;
    return cv;
  }
}
