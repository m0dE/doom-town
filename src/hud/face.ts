/**
 * The status bar face: a port of linuxdoom-1.10's ST_updateFaceWidget and
 * ST_calcPainOffset (st_stuff.c, Copyright (C) 1993-1996 id Software, Inc.,
 * GPL-2.0). Ticked at 35 Hz from the local player's view.
 *
 * One deliberate change: id's "ouch" test reads `health - oldhealth >
 * ST_MUCHPAIN`, which is backwards (it fires on a big HEAL while hurt, so the
 * ouch face almost never shows). Every source port fixes it; so do we.
 */

const TICRATE = 35;
const ST_NUMPAINFACES = 5;
const ST_NUMSTRAIGHTFACES = 3;
const ST_NUMTURNFACES = 2;
const ST_NUMSPECIALFACES = 3;
const ST_FACESTRIDE = ST_NUMSTRAIGHTFACES + ST_NUMTURNFACES + ST_NUMSPECIALFACES;
const ST_TURNOFFSET = ST_NUMSTRAIGHTFACES;
const ST_OUCHOFFSET = ST_TURNOFFSET + ST_NUMTURNFACES;
const ST_EVILGRINOFFSET = ST_OUCHOFFSET + 1;
const ST_RAMPAGEOFFSET = ST_EVILGRINOFFSET + 1;
const ST_GODFACE = ST_NUMPAINFACES * ST_FACESTRIDE;
const ST_DEADFACE = ST_GODFACE + 1;
const ST_EVILGRINCOUNT = 2 * TICRATE;
const ST_STRAIGHTFACECOUNT = TICRATE / 2;
const ST_TURNCOUNT = 1 * TICRATE;
const ST_RAMPAGEDELAY = 2 * TICRATE;
const ST_MUCHPAIN = 20;
const ANG45 = 0x20000000, ANG180 = 0x80000000;

/** The face lumps in st_faceindex order (ST_loadGraphics). */
export function faceLumps(): string[] {
  const out: string[] = [];
  for (let i = 0; i < ST_NUMPAINFACES; i++) {
    for (let j = 0; j < ST_NUMSTRAIGHTFACES; j++) out.push(`STFST${i}${j}`);
    out.push(`STFTR${i}0`, `STFTL${i}0`, `STFOUCH${i}`, `STFEVL${i}`, `STFKILL${i}`);
  }
  out.push('STFGOD0', 'STFDEAD0');
  return out;
}

export interface FaceInput {
  health: number;
  /** weaponowned bitmask. */
  owned: number;
  bonuscount: number;
  damagecount: number;
  /** Who hurt us last is someone else (attacker slot+1 set and not us). */
  attacked: boolean;
  /** Our angle and the attacker's direction from us, BAM; only read when `attacked`. */
  angle: number;
  attackerAngle: number;
  attackDown: boolean;
  invulnerable: boolean;
}

export class FaceWidget {
  index = 0;
  private count = 0;
  private priority = 0;
  private lastAttackDown = -1;
  private oldHealth = -1;       // ST_calcPainOffset's
  private lastCalc = 0;
  private stOldHealth = -1;     // st_oldhealth, updated at the end of ST_Ticker
  private oldOwned = -1;

  reset(): void {
    this.index = 0; this.count = 0; this.priority = 0; this.lastAttackDown = -1;
    this.oldHealth = -1; this.stOldHealth = -1; this.oldOwned = -1;
  }

  private painOffset(health: number): number {
    const h = health > 100 ? 100 : health;
    if (h !== this.oldHealth) {
      this.lastCalc = ST_FACESTRIDE * Math.floor(((100 - h) * ST_NUMPAINFACES) / 101);
      this.oldHealth = h;
    }
    return this.lastCalc;
  }

  /** One tic. */
  tick(p: FaceInput): void {
    if (this.oldOwned < 0) this.oldOwned = p.owned;
    if (this.stOldHealth < 0) this.stOldHealth = p.health;

    if (this.priority < 10 && p.health <= 0) {
      this.priority = 9;
      this.index = ST_DEADFACE;
      this.count = 1;
    }

    if (this.priority < 9 && p.bonuscount) {
      if (this.oldOwned !== p.owned) {
        const grin = (p.owned & ~this.oldOwned) !== 0;
        this.oldOwned = p.owned;
        if (grin) {
          this.priority = 8;
          this.count = ST_EVILGRINCOUNT;
          this.index = this.painOffset(p.health) + ST_EVILGRINOFFSET;
        }
      }
    } else if (p.owned !== this.oldOwned && p.bonuscount === 0) {
      // A respawn takes weapons away with no bonus: remember the new set quietly.
      this.oldOwned = p.owned;
    }

    if (this.priority < 8 && p.damagecount && p.attacked) {
      this.priority = 7;
      if (this.stOldHealth - p.health > ST_MUCHPAIN) {
        this.count = ST_TURNCOUNT;
        this.index = this.painOffset(p.health) + ST_OUCHOFFSET;
      } else {
        const bad = p.attackerAngle >>> 0, me = p.angle >>> 0;
        let diff: number, right: boolean;
        if (bad > me) { diff = (bad - me) >>> 0; right = diff > ANG180; }
        else { diff = (me - bad) >>> 0; right = diff <= ANG180; }
        this.count = ST_TURNCOUNT;
        this.index = this.painOffset(p.health);
        if (diff < ANG45) this.index += ST_RAMPAGEOFFSET;
        else if (right) this.index += ST_TURNOFFSET;
        else this.index += ST_TURNOFFSET + 1;
      }
    }

    if (this.priority < 7 && p.damagecount) {
      if (this.stOldHealth - p.health > ST_MUCHPAIN) {
        this.priority = 7;
        this.count = ST_TURNCOUNT;
        this.index = this.painOffset(p.health) + ST_OUCHOFFSET;
      } else {
        this.priority = 6;
        this.count = ST_TURNCOUNT;
        this.index = this.painOffset(p.health) + ST_RAMPAGEOFFSET;
      }
    }

    if (this.priority < 6) {
      if (p.attackDown) {
        if (this.lastAttackDown === -1) this.lastAttackDown = ST_RAMPAGEDELAY;
        else if (!--this.lastAttackDown) {
          this.priority = 5;
          this.index = this.painOffset(p.health) + ST_RAMPAGEOFFSET;
          this.count = 1;
          this.lastAttackDown = 1;
        }
      } else this.lastAttackDown = -1;
    }

    if (this.priority < 5 && p.invulnerable) {
      this.priority = 4;
      this.index = ST_GODFACE;
      this.count = 1;
    }

    if (!this.count) {
      this.index = this.painOffset(p.health) + Math.floor(Math.random() * 3);
      this.count = ST_STRAIGHTFACECOUNT;
      this.priority = 0;
    }
    this.count--;
    this.stOldHealth = p.health;
  }
}

/** R_PointToAngle2 in float (cosmetic only - the face's look direction). */
export function pointToAngle(x1: number, y1: number, x2: number, y2: number): number {
  const a = Math.atan2(y2 - y1, x2 - x1);
  return (Math.round(((a < 0 ? a + 2 * Math.PI : a) / (2 * Math.PI)) * 4294967296) >>> 0);
}
