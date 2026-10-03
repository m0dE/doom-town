/** The player's own settings, kept in this browser. */
import { clampColor } from '../game/colors.js';

export interface Prefs {
  name: string;
  color: number;
  sensitivity: number;
  invertY: boolean;
  volume: number;
  fov: number;
  /** 'bar' = the classic status bar; 'full' = the minimal fullscreen HUD. */
  hud: 'bar' | 'full';
  /** How other players are drawn: '3d' = the box marine model, 'sprites' = Doom's sprites. */
  players: '3d' | 'sprites';
}

const KEY = 'freedm.prefs';

const defaults = (): Prefs => ({
  name: `marine${Math.floor(Math.random() * 900 + 100)}`,
  color: 0, sensitivity: 5, invertY: false, volume: 0.8, fov: 90, hud: 'bar', players: '3d',
});

let cached: Prefs | null = null;

export function prefs(): Prefs {
  if (cached) return cached;
  const d = defaults();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Prefs> | null;
    if (raw && typeof raw === 'object') {
      cached = {
        name: typeof raw.name === 'string' && raw.name.trim() ? cleanName(raw.name) : d.name,
        color: clampColor(raw.color),
        sensitivity: num(raw.sensitivity, 0.5, 20, d.sensitivity),
        invertY: raw.invertY === true,
        volume: num(raw.volume, 0, 1, d.volume),
        fov: num(raw.fov, 75, 110, d.fov),
        hud: raw.hud === 'full' ? 'full' : 'bar',
        players: raw.players === 'sprites' ? 'sprites' : '3d',
      };
      return cached;
    }
  } catch { /* storage blocked or junk: defaults */ }
  cached = d;
  // The generated name is the player's from now on, so it does not change on every visit.
  try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* storage blocked */ }
  return cached;
}

export function savePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...prefs(), ...patch };
  next.name = cleanName(next.name) || prefs().name;
  next.color = clampColor(next.color);
  cached = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
  for (const l of listeners) l(next);
  return next;
}

const listeners = new Set<(p: Prefs) => void>();
export function onPrefs(cb: (p: Prefs) => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }

/** A name others will see: printable, trimmed, at most 20 characters. */
export function cleanName(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20);
}

function num(v: unknown, lo: number, hi: number, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
}
