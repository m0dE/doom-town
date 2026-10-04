// Battle royale v2: buggies and grenades (DESIGN.md "Battle royale v2").
// Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.
//
// A buggy (MT_BUGGY) keeps its speed in `movecount` (fixed, signed), its heading in
// `angle` and its driver in `tracer`. The driver's body leaves the blockmap and rides
// at the buggy. A grenade (MT_GRENADE) keeps its fuse in `movecount` and its thrower in
// `target`; it moves itself (bouncing) while in its S_GRENADE state.

use crate::fixed::*;
use crate::info::*;
use crate::mobj::{FRICTION, GRAVITY};
use crate::world::*;

pub const BUGGY_MAX: i32 = 28;
pub const BUGGY_REVERSE: i32 = 10;
pub const ROADKILL_SPEED: i32 = 12;
pub const GRENADE_FUSE: i32 = 70;
pub const GRENADE_COOLDOWN: i32 = 30;
pub const GRENADE_MAX: i32 = 5;
pub const GRENADE_SPEED: i32 = 18;
const ANG1: u32 = ANG45 / 45;

impl World {
    /// the buggy this player drives, if any
    pub fn driving(&self, slot: usize) -> Option<u32> {
        self.deref(self.players[slot].vehicle)
    }

    /// *use* near a free buggy: get in (true if entered)
    pub fn use_vehicle(&mut self, slot: usize) -> bool {
        let h = match self.deref(self.players[slot].mo) {
            Some(h) => h,
            None => return false,
        };
        let b = match self.usable_in_reach(h, mt::BUGGY) {
            Some(b) => b,
            None => return false,
        };
        if self.deref(self.mo(b).tracer).is_some() {
            return false;
        }
        // the body leaves the blockmap and rides at the buggy
        self.unset_thing_position(h);
        let (bx, by, bz, bf, bc) = {
            let m = self.mo(b);
            (m.x, m.y, m.z, m.floorz, m.ceilingz)
        };
        {
            let m = self.mo_mut(h);
            m.flags |= MF_NOBLOCKMAP | MF_NOGRAVITY;
            m.x = bx;
            m.y = by;
            m.z = bz;
            m.floorz = bf;
            m.ceilingz = bc;
            m.momx = 0;
            m.momy = 0;
            m.momz = 0;
        }
        self.set_thing_position(h);
        let (rb, rh) = (self.mref(b), self.mref(h));
        self.mo_mut(b).tracer = rh;
        self.players[slot].vehicle = rb;
        self.start_sound(b, sfx::pstart);
        true
    }

    /// can a body stand at (x, y) next to a buggy at floor `floor`?
    fn exit_fits(&mut self, x: Fixed, y: Fixed, floor: Fixed) -> bool {
        let map = self.map.clone();
        let sec = &self.sectors[map.sector_at(x, y)];
        sec.ceilingheight - sec.floorheight >= 56 * FRACUNIT
            && (sec.floorheight - floor).abs() <= 24 * FRACUNIT
            && crate::bots::nav::static_clear(&map, x, y, 17 * FRACUNIT, false)
            && self.spot_clear(x, y, 17 * FRACUNIT)
    }

    /// get out: to the left, else the right, back or front; `force` (the buggy is gone or
    /// the driver died) puts the body where the buggy is when no side is free
    pub fn leave_vehicle(&mut self, slot: usize, force: bool) -> bool {
        let rb = self.players[slot].vehicle;
        if rb.is_null() {
            return false;
        }
        let h = match self.deref(self.players[slot].mo) {
            Some(h) => h,
            None => {
                if let Some(b) = self.deref(rb) {
                    self.mo_mut(b).tracer = MRef::NULL;
                }
                self.players[slot].vehicle = MRef::NULL;
                return true;
            }
        };
        let (bx, by, ba, bf) = match self.deref(rb) {
            Some(b) => {
                let m = self.mo(b);
                (m.x, m.y, m.angle, m.floorz)
            }
            None => {
                let m = self.mo(h);
                (m.x, m.y, m.angle, m.floorz)
            }
        };
        let mut at = None;
        if self.deref(rb).is_some() {
            for turn in [ANG90, ANG90.wrapping_neg(), ANG180, 0] {
                let a = fine(ba.wrapping_add(turn));
                let (x, y) = (bx + 56 * finecosine(a), by + 56 * finesine(a));
                if self.exit_fits(x, y, bf) {
                    at = Some((x, y));
                    break;
                }
            }
        }
        if at.is_none() {
            if !force {
                return false;
            }
            at = Some((bx, by));
        }
        let (x, y) = at.unwrap();
        self.unset_thing_position(h);
        let sec = self.sectors[self.map.sector_at(x, y)];
        {
            let m = self.mo_mut(h);
            m.flags &= !(MF_NOBLOCKMAP | MF_NOGRAVITY);
            m.x = x;
            m.y = y;
            m.floorz = sec.floorheight;
            m.ceilingz = sec.ceilingheight;
            m.z = sec.floorheight;
            m.momx = 0;
            m.momy = 0;
            m.momz = 0;
        }
        self.set_thing_position(h);
        if let Some(b) = self.deref(rb) {
            let m = self.mo_mut(b);
            m.tracer = MRef::NULL;
            m.movecount = 0;
        }
        self.players[slot].vehicle = MRef::NULL;
        true
    }

    /// the driver's tic (instead of P_MovePlayer): car physics, roadkill, ride along
    pub fn drive(&mut self, slot: usize, h: u32) {
        let b = match self.driving(slot) {
            Some(b) => b,
            None => {
                self.leave_vehicle(slot, true);
                return;
            }
        };
        let cmd = self.players[slot].cmd;
        let (mut speed, mut heading, onground) = {
            let m = self.mo(b);
            (m.movecount, m.angle, m.z <= m.floorz)
        };
        if onground {
            let f = cmd.forward as i32;
            if f > 0 {
                speed += FRACUNIT * f / 50;
            } else if f < 0 {
                speed += FRACUNIT * 3 * f / 100;
            } else if speed > 0 {
                speed = (speed - FRACUNIT / 2).max(0);
            } else {
                speed = (speed + FRACUNIT / 2).min(0);
            }
            speed = speed.clamp(-BUGGY_REVERSE * FRACUNIT, BUGGY_MAX * FRACUNIT);
            if speed.abs() > FRACUNIT / 2 && cmd.side != 0 {
                let turn = (ANG1 as i64 * 4 * cmd.side as i64 / 40) as i32;
                let turn = if speed < 0 { -turn } else { turn };
                heading = heading.wrapping_sub(turn as u32);
            }
        }
        let fa = fine(heading);
        let (dx, dy) = (fixed_mul(speed, finecosine(fa)), fixed_mul(speed, finesine(fa)));
        // roadkill: players in the way at speed
        if speed.abs() > ROADKILL_SPEED * FRACUNIT {
            let (bx, by, br) = {
                let m = self.mo(b);
                (m.x + dx, m.y + dy, m.radius)
            };
            for s in 0..self.players.len() {
                if s == slot || self.players[s].playerstate != PST_LIVE {
                    continue;
                }
                let t = match self.deref(self.players[s].mo) {
                    Some(t) => t,
                    None => continue,
                };
                if self.driving(s).is_some() {
                    continue;
                }
                let (tx, ty, tr) = {
                    let m = self.mo(t);
                    (m.x, m.y, m.radius)
                };
                let bd = br + tr + 4 * FRACUNIT;
                if (tx - bx).abs() < bd && (ty - by).abs() < bd {
                    let dmg = (speed.abs() >> FRACBITS) / 2;
                    {
                        let m = self.mo_mut(t);
                        m.momx = m.momx.wrapping_add(dx);
                        m.momy = m.momy.wrapping_add(dy);
                        m.momz = m.momz.wrapping_add(4 * FRACUNIT);
                    }
                    self.damage_mobj(t, b, h, dmg, mod_::ROADKILL);
                    speed = speed * 3 / 4;
                    if !self.alive(h) || !self.alive(b) {
                        return;
                    }
                }
            }
        }
        // move in steps (never more than 16 units at once), stop against walls
        let (dx, dy) = (fixed_mul(speed, finecosine(fa)), fixed_mul(speed, finesine(fa)));
        let steps = ((dx.abs().max(dy.abs()) >> FRACBITS) / 16 + 1).max(1);
        for _ in 0..steps {
            let (x, y) = {
                let m = self.mo(b);
                (m.x, m.y)
            };
            if !self.try_move(b, x + dx / steps, y + dy / steps) {
                if !self.alive(b) {
                    return;
                }
                speed = -speed / 4;
                break;
            }
            if !self.alive(b) {
                return;
            }
        }
        {
            let m = self.mo_mut(b);
            m.movecount = speed;
            m.angle = heading;
            m.momx = 0;
            m.momy = 0;
        }
        self.ride(h, b);
    }

    /// put the driver's body where the buggy is
    pub fn ride(&mut self, h: u32, b: u32) {
        let (bx, by, bz, bf, bc) = {
            let m = self.mo(b);
            (m.x, m.y, m.z, m.floorz, m.ceilingz)
        };
        self.unset_thing_position(h);
        {
            let m = self.mo_mut(h);
            m.x = bx;
            m.y = by;
            m.z = bz;
            m.floorz = bf;
            m.ceilingz = bc;
            m.momx = 0;
            m.momy = 0;
            m.momz = 0;
        }
        self.set_thing_position(h);
    }

    /// 0 health: the driver is thrown out, a 128 blast, nothing left
    pub fn buggy_explode(&mut self, b: u32, source: u32) {
        let (x, y, z, driver) = {
            let m = self.mo(b);
            (m.x, m.y, m.z, m.tracer)
        };
        if let Some(d) = self.deref(driver) {
            if let Some(s) = self.player_of(d) {
                self.leave_vehicle(s, true);
            }
        }
        self.remove_mobj(b);
        let boom = self.spawn_mobj(x, y, z + 24 * FRACUNIT, mt::GRENADE);
        let src = if source != NONE && self.alive(source) { self.mref(source) } else { MRef::NULL };
        self.mo_mut(boom).target = src;
        self.start_sound(boom, sfx::barexp);
        // S_EXPLODE1's A_Explode: P_RadiusAttack 128 from the source
        self.set_mobj_state(boom, st::EXPLODE1 as i32);
    }

    // ------------------------------------------------------------------ grenades
    /// grenade button held: throw one (30-tic cooldown)
    pub fn grenade_tick(&mut self, slot: usize, h: u32) {
        if self.players[slot].grenade_cd > 0 {
            self.players[slot].grenade_cd -= 1;
            return;
        }
        let p = &self.players[slot];
        if p.cmd.buttons & crate::royale::BT_GRENADE == 0 || p.grenades <= 0 || !p.vehicle.is_null() {
            return;
        }
        self.players[slot].grenades -= 1;
        self.players[slot].grenade_cd = GRENADE_COOLDOWN;
        let (x, y, z, a, mx, my) = {
            let m = self.mo(h);
            (m.x, m.y, m.z, m.angle, m.momx, m.momy)
        };
        let pitch = self.players[slot].pitch;
        let g = self.spawn_mobj(x, y, z + 40 * FRACUNIT, mt::GRENADE);
        let pf = fine(pitch as u32);
        let hs = GRENADE_SPEED * finecosine(pf);
        let vs = GRENADE_SPEED * finesine(pf) + 4 * FRACUNIT;
        let fa = fine(a);
        let src = self.mref(h);
        {
            let m = self.mo_mut(g);
            m.target = src;
            m.angle = a;
            m.momx = fixed_mul(hs, finecosine(fa)).wrapping_add(mx);
            m.momy = fixed_mul(hs, finesine(fa)).wrapping_add(my);
            m.momz = vs;
            m.movecount = GRENADE_FUSE;
        }
        self.start_sound(h, sfx::sgcock);
    }

    /// a grenade in flight: bounce off walls, floors and ceilings (momentum halves), roll
    /// to a stop, explode when the fuse runs out
    pub fn grenade_think(&mut self, g: u32) {
        self.mo_mut(g).movecount -= 1;
        if self.mo(g).movecount <= 0 {
            let src = self.deref(self.mo(g).target).unwrap_or(NONE);
            {
                let m = self.mo_mut(g);
                m.momx = 0;
                m.momy = 0;
                m.momz = 0;
                m.flags |= MF_NOGRAVITY;
            }
            self.start_sound(g, sfx::rxplod);
            self.radius_attack(g, src, 160, mod_::GRENADE);
            if self.alive(g) {
                self.set_mobj_state(g, st::EXPLODE2 as i32);
            }
            return;
        }
        let (momx, momy) = {
            let m = self.mo(g);
            (m.momx, m.momy)
        };
        if momx != 0 || momy != 0 {
            let steps = (momx.abs().max(momy.abs()) >> FRACBITS) / 8 + 1;
            let (sx, sy) = (momx / steps, momy / steps);
            let (mut bx, mut by) = (false, false);
            for _ in 0..steps {
                let (x, y) = {
                    let m = self.mo(g);
                    (m.x, m.y)
                };
                if !bx && sx != 0 && !self.try_move(g, x + sx, y) {
                    bx = true;
                }
                if !self.alive(g) {
                    return;
                }
                let (x, y) = {
                    let m = self.mo(g);
                    (m.x, m.y)
                };
                if !by && sy != 0 && !self.try_move(g, x, y + sy) {
                    by = true;
                }
                if !self.alive(g) {
                    return;
                }
            }
            let m = self.mo_mut(g);
            if bx {
                m.momx = -m.momx / 2;
            }
            if by {
                m.momy = -m.momy / 2;
            }
        }
        let m = self.mo_mut(g);
        m.z = m.z.wrapping_add(m.momz);
        if m.z <= m.floorz {
            m.z = m.floorz;
            if m.momz < -3 * FRACUNIT {
                m.momz = -m.momz / 2;
                m.momx /= 2;
                m.momy /= 2;
            } else {
                m.momz = 0;
                m.momx = fixed_mul(m.momx, FRICTION);
                m.momy = fixed_mul(m.momy, FRICTION);
                if m.momx.abs() < FRACUNIT / 8 && m.momy.abs() < FRACUNIT / 8 {
                    m.momx = 0;
                    m.momy = 0;
                }
            }
        } else {
            m.momz -= GRAVITY;
        }
        if m.z + m.height > m.ceilingz {
            m.z = m.ceilingz - m.height;
            if m.momz > 0 {
                m.momz = -m.momz / 2;
            }
        }
    }
}
