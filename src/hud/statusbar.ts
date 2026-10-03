/**
 * The classic status bar, drawn the way st_stuff.c lays it out (positions are
 * linuxdoom-1.10's ST_* constants, Copyright (C) 1993-1996 id Software, Inc.,
 * GPL-2.0) onto a 320×32 canvas that CSS scales up pixelated.
 *
 * Deathmatch: vanilla shows FRAGS where the ARMS panel goes; this game shows
 * the ARMS panel (what you are carrying matters more with 99 opponents) and
 * puts frags and rank in the corner of the screen instead.
 */
import type { Gfx, Patch } from './gfx.js';
import { faceLumps } from './face.js';
import { PV } from '../sim/abi.js';
import { translationFor } from '../game/colors.js';

const Y = 168;
/** weapon → ammo type (weaponinfo[].ammo); -1 = am_noammo. */
export const WEAPON_AMMO = [-1, 0, 1, 0, 3, 2, 2, -1, 1];
/** Small ammo counters: y per ammo type (clip, shell, cell, misl). */
const AMMO_Y = [173, 179, 191, 185];

export class StatusBar {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private last = '';
  private readonly faces: string[] = faceLumps();

  constructor(private readonly gfx: Gfx) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 320; this.canvas.height = 32;
    this.canvas.className = 'stbar';
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;
  }

  /** Redraws only when something on the bar changed. */
  draw(pv: Int32Array, face: number, color: number): void {
    const key = `${face}|${color}|${pv[PV.health]}|${pv[PV.armor]}|${pv[PV.ready]}|${pv[PV.owned]}|${pv.subarray(PV.ammo, PV.ammo + 8).join(',')}`;
    if (key === this.last) return;
    this.last = key;
    const c = this.ctx;
    c.clearRect(0, 0, 320, 32);
    this.patch('STBAR', 0, Y);
    // ammo for the weapon in hand
    const ready = pv[PV.ready];
    const at = WEAPON_AMMO[ready] ?? -1;
    if (at >= 0) this.num(pv[PV.ammo + at], 44, 171, 3, 'STTNUM');
    // health and armor, with %
    this.num(Math.max(0, pv[PV.health]), 90, 171, 3, 'STTNUM');
    this.patch('STTPRCNT', 90, 171);
    this.num(Math.max(0, pv[PV.armor]), 221, 171, 3, 'STTNUM');
    this.patch('STTPRCNT', 221, 171);
    // arms: 2..7 lit when owned (3 for either shotgun)
    this.patch('STARMS', 104, 168);
    const owned = pv[PV.owned];
    for (let i = 0; i < 6; i++) {
      const w = i + 1;
      const has = (owned >> w) & 1 || (w === 2 && (owned >> 8) & 1);
      this.patch(`${has ? 'STYSNUM' : 'STGNUM'}${i + 2}`, 111 + (i % 3) * 12, 172 + Math.floor(i / 3) * 10);
    }
    // face, over its background in the player's colour
    const tr = translationFor(this.gfx.pal, color);
    this.patch('STFB0', 143, 168, tr, `c${color}`);
    const fl = this.faces[face] ?? this.faces[0];
    this.patch(fl, 143, 168);
    // ammo and max ammo, small
    for (let a = 0; a < 4; a++) {
      this.num(pv[PV.ammo + a], 288, AMMO_Y[a], 3, 'STYSNUM');
      this.num(pv[PV.maxammo + a], 314, AMMO_Y[a], 3, 'STYSNUM');
    }
  }

  private patch(name: string, x: number, y: number, tr?: Uint8Array, key = ''): Patch | null {
    const p = this.gfx.patch(name, tr, key);
    if (p) this.ctx.drawImage(p.canvas, x - p.left, y - Y - p.top);
    return p;
  }

  /** STlib_drawNum: right-aligned at x, at most `digits` digits. */
  private num(n: number, x: number, y: number, digits: number, font: string): void {
    const zero = this.gfx.patch(`${font}0`);
    if (!zero) return;
    const w = zero.width;
    let v = Math.abs(n);
    const neg = n < 0;
    if (v >= 10 ** digits) v = 10 ** digits - 1;
    if (v === 0) { this.patch(`${font}0`, x - w, y); return; }
    let cx = x;
    while (v && digits--) {
      cx -= w;
      this.patch(`${font}${v % 10}`, cx, y);
      v = Math.floor(v / 10);
    }
    if (neg) this.patch('STTMINUS', cx - 8, y);
  }
}
