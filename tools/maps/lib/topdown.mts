// Top-down preview of a map: sectors shaded by floor height (liquids and outdoor areas
// tinted), walls, spawn points, capture points and items.
import type { MapData } from '../../../src/wad/mapdata.ts';
import { Canvas, type RGB } from './png.mts';
import { SectorLocator } from './locate.mts';

const WEAPONS = new Set([2001, 82, 2002, 2003, 2004, 2006, 2005]);
const AMMO = new Set([2007, 2048, 2008, 2049, 2010, 2046, 2047, 17, 8]);
const HEALTH = new Set([2011, 2012, 2014, 2013, 83]);
const ARMOR = new Set([2018, 2019, 2015]);
const POWER = new Set([2022, 2023, 2024, 2025, 2026, 2045]);

export function liquidColor(flat: string): RGB | null {
  if (/^NUKAGE|^SLIME0[1-8]/.test(flat)) return [70, 170, 40];
  if (/^FWATER|^SWATER/.test(flat)) return [40, 80, 170];
  if (/^LAVA|^RROCK0[5-8]/.test(flat)) return [200, 70, 20];
  if (/^BLOOD/.test(flat)) return [140, 10, 10];
  return null;
}

export function renderTopDown(map: MapData, title: string, maxPx = 1600): Canvas {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const v of map.vertexes) { minx = Math.min(minx, v.x); miny = Math.min(miny, v.y); maxx = Math.max(maxx, v.x); maxy = Math.max(maxy, v.y); }
  const pad = 64;
  minx -= pad; miny -= pad; maxx += pad; maxy += pad;
  const scale = maxPx / Math.max(maxx - minx, maxy - miny);
  const W = Math.ceil((maxx - minx) * scale), H = Math.ceil((maxy - miny) * scale) + 28;
  const cv = new Canvas(W, H, [12, 12, 16]);
  const X = (x: number) => (x - minx) * scale;
  const Y = (y: number) => 28 + (maxy - y) * scale;
  const loc = new SectorLocator(map);
  let fmin = Infinity, fmax = -Infinity;
  for (const s of map.sectors) { fmin = Math.min(fmin, s.floor); fmax = Math.max(fmax, s.floor); }
  const span = Math.max(1, fmax - fmin);
  for (let py = 28; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const wx = minx + (px + 0.5) / scale, wy = maxy - (py - 28 + 0.5) / scale;
      const s = loc.sectorAt(wx, wy);
      if (s < 0) { if (s === -2) cv.set(px, py, [255, 0, 255]); continue; }
      const sec = map.sectors[s];
      const t = (sec.floor - fmin) / span;
      let c: RGB = [Math.round(50 + 150 * t), Math.round(55 + 150 * t), Math.round(70 + 140 * t)];
      if (sec.ceilPic === 'F_SKY1') c = [Math.round(c[0] * 0.85 + 20), Math.round(c[1] * 0.95 + 18), Math.round(c[2] * 0.7)];
      const liq = liquidColor(sec.floorPic);
      if (liq) c = [Math.round(liq[0] * (0.6 + 0.4 * t)), Math.round(liq[1] * (0.6 + 0.4 * t)), Math.round(liq[2] * (0.6 + 0.4 * t))];
      const shade = 0.55 + 0.45 * Math.min(1, sec.light / 200);
      cv.set(px, py, [c[0] * shade, c[1] * shade, c[2] * shade].map(Math.round) as RGB);
    }
  }
  for (const l of map.lines) {
    const a = map.vertexes[l.v1], b = map.vertexes[l.v2];
    const one = l.back < 0;
    let col: RGB = one ? [235, 235, 225] : [120, 120, 110];
    let alpha = one ? 1 : 0.6;
    if (!one) {
      const f = map.sectors[map.sides[l.front]?.sector ?? 0], k = map.sectors[map.sides[l.back]?.sector ?? 0];
      if (f && k && Math.abs(f.floor - k.floor) > 24) { col = [200, 180, 120]; alpha = 0.9; }
      else if (f && k && f.floor === k.floor && f.ceil === k.ceil) alpha = 0.18;
    }
    if (l.special) col = [90, 200, 255];
    cv.line(X(a.x), Y(a.y), X(b.x), Y(b.y), col, alpha);
  }
  const r = Math.max(1.5, 16 * scale);
  // FreeDM maps: the sim's team split (DESIGN.md: the two most distant DM starts seed a
  // 2-means over the spawn points; side 0 = red) — shown on the DM starts
  const dm = map.things.filter((t) => t.type === 11);
  const side = new Map<typeof dm[number], number>();
  if (dm.length >= 2) {
    let best = -1, a = dm[0], b = dm[1];
    for (const p of dm) for (const q of dm) { const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2; if (d > best) { best = d; a = p; b = q; } }
    let ca = [a.x, a.y], cb = [b.x, b.y];
    for (let it = 0; it < 10; it++) {
      const A: number[][] = [], B: number[][] = [];
      for (const p of dm) { const da = (p.x - ca[0]) ** 2 + (p.y - ca[1]) ** 2, db = (p.x - cb[0]) ** 2 + (p.y - cb[1]) ** 2; (da <= db ? A : B).push([p.x, p.y]); side.set(p, da <= db ? 0 : 1); }
      const mean = (v: number[][], d: number[]) => (v.length ? [v.reduce((s, p) => s + p[0], 0) / v.length, v.reduce((s, p) => s + p[1], 0) / v.length] : d);
      ca = mean(A, ca); cb = mean(B, cb);
    }
  }
  for (const t of map.things) {
    const x = X(t.x), y = Y(t.y);
    if (t.type === 9010) {
      const rad = t.angle * 8 * scale;
      cv.disc(x, y, rad, [255, 230, 60], 0.18);
      cv.ring(x, y, rad, [255, 230, 60]);
    } else if (t.type === 9000) cv.disc(x, y, r * 1.2, [255, 60, 50]);
    else if (t.type === 9001) cv.disc(x, y, r * 1.2, [60, 120, 255]);
    else if (t.type === 11) { cv.disc(x, y, r * 2.2, [255, 240, 0]); cv.disc(x, y, r * 1.5, side.get(t) === 1 ? [60, 120, 255] : [255, 60, 50]); }
    else if (t.type >= 1 && t.type <= 4) cv.disc(x, y, r * 1.6, [255, 255, 255]);
    else if (WEAPONS.has(t.type)) cv.disc(x, y, r * 1.5, [255, 140, 0]);
    else if (AMMO.has(t.type)) cv.disc(x, y, r, [200, 200, 80]);
    else if (HEALTH.has(t.type)) cv.disc(x, y, r, [80, 255, 120]);
    else if (ARMOR.has(t.type)) cv.disc(x, y, r, [120, 220, 255]);
    else if (POWER.has(t.type)) cv.disc(x, y, r * 1.5, [255, 80, 255]);
    else cv.disc(x, y, Math.max(1, r * 0.6), [150, 110, 90]);
  }
  let pi = 0;
  for (const t of map.things) if (t.type === 9010) cv.text(X(t.x) - 3, Y(t.y) - 5, 'ABCDEFGH'[pi++] ?? '?', [20, 20, 20], 3, false);
  const nStart = map.things.filter((t) => t.type === 11).length;
  cv.text(8, 8, `${title}  ${Math.round(maxx - minx - 2 * pad)}x${Math.round(maxy - miny - 2 * pad)}  ${map.lines.length} LINES ${map.sectors.length} SECTORS  ${nStart} DM STARTS`, [230, 230, 230], 2);
  return cv;
}
