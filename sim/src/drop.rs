// Battle royale v2: the dropship and skydiving (DESIGN.md "Battle royale v2").
// Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.
//
// From the drop on, every player in the match is "airborne" until landing: no body in the
// world, a virtual position the sim moves (in the ship, freefall, parachute), mirrored by
// an MT_PARACHUTER mobj once out of the ship.

use crate::fixed::*;
use crate::info::*;
use crate::map::MapThing;
use crate::world::*;

pub const AIR_NONE: u8 = 0;
pub const AIR_SHIP: u8 = 1;
pub const AIR_FREEFALL: u8 = 2;
pub const AIR_CHUTE: u8 = 3;
/// PlayerView[51] for a vehicle driver (not stored: derived from `vehicle`)
pub const AIR_VEHICLE: i32 = 4;
/// PlayerView words (51..56 added by battle royale v2)
pub const PLAYER_WORDS: usize = 57;

pub const SHIP_SPEED: i32 = 24;
pub const FREEFALL_SPEED: i32 = 24;
pub const FREEFALL_STEER: i32 = 10;
pub const CHUTE_SPEED: i32 = 5;
pub const CHUTE_STEER: i32 = 6;
pub const CHUTE_AUTO: i32 = 512;
pub const CHUTE_MIN: i32 = 256;
/// how far a bot aims to glide from where it jumps (map units)
const GLIDE_REACH: i64 = 1800;
/// bots don't start fights for this long after landing (unless shot or better armed)
pub const CALM_TICS: u32 = 35 * 3;

/// The dropship's flight.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Ship {
    pub mo: MRef,
    pub x: Fixed,
    pub y: Fixed,
    pub z: Fixed,
    /// direction, fixed unit vector
    pub dx: Fixed,
    pub dy: Fixed,
    pub angle: Angle,
    /// tics until the end of the line
    pub left: i32,
}

impl World {
    /// take a body out of the world without a trace (boarding, landing elsewhere)
    fn remove_body_silent(&mut self, slot: usize) {
        if let Some(h) = self.deref(self.players[slot].mo) {
            self.leave_vehicle(slot, true);
            self.mo_mut(h).player = -1;
            self.remove_mobj(h);
        }
        self.players[slot].mo = MRef::NULL;
    }

    /// drop the airborne state and its parachuter (joins, map changes)
    pub fn clear_air(&mut self, slot: usize) {
        if let Some(m) = self.deref(self.players[slot].air_mo) {
            self.remove_mobj(m);
        }
        let p = &mut self.players[slot];
        p.air_mo = MRef::NULL;
        p.air = AIR_NONE;
    }

    /// the lobby is over: the ship's line, everyone boards with the starting kit
    pub fn begin_drop(&mut self) {
        let z = self.g.zone;
        let r0u = (z.r0 >> FRACBITS).max(256) as i64;
        let ox = (self.p_random() - 128) as i64 * (r0u / 4) / 128;
        let oy = (self.p_random() - 128) as i64 * (r0u / 4) / 128;
        let (px, py) = ((z.x >> FRACBITS) as i64 + ox, (z.y >> FRACBITS) as i64 + oy);
        let angle = ((self.p_random() as u32) << 24) | ((self.p_random() as u32) << 16);
        let (dx, dy) = (finecosine(fine(angle)), finesine(fine(angle)));
        let clamp = |v: i64| (v.clamp(-32000, 32000) as i32) << FRACBITS;
        let sx = clamp(px - ((dx as i64 * r0u) >> FRACBITS));
        let sy = clamp(py - ((dy as i64 * r0u) >> FRACBITS));
        let left = (2 * r0u / SHIP_SPEED as i64) as i32;
        let top = self.sectors.iter().map(|s| s.floorheight).max().unwrap_or(0);
        let sz = (top as i64 + ((self.g.cfg.br.drop_alt as i64) << FRACBITS)).min(i32::MAX as i64 / 2) as Fixed;
        let mo = self.spawn_mobj(sx, sy, sz, mt::DROPSHIP);
        self.mo_mut(mo).angle = angle;
        let r = self.mref(mo);
        self.g.ship = Ship { mo: r, x: sx, y: sy, z: sz, dx, dy, angle, left };
        self.g.phase = crate::game::PH_DROP;
        self.g.phase_left = left.max(1) as u32;
        let bullets = self.g.cfg.br.start_bullets;
        for i in 0..self.players.len() {
            if self.players[i].playerstate == PST_DEAD {
                continue;
            }
            self.remove_body_silent(i);
            self.clear_air(i);
            self.player_reborn(i);
            let p = &mut self.players[i];
            p.ammo[AM_CLIP as usize] = bullets;
            p.grenades = 0;
            p.fresh = false;
            p.air = AIR_SHIP;
            (p.ax, p.ay, p.az) = (sx, sy, sz);
            p.aangle = angle;
            p.bot.reset();
        }
        // where everyone would like to land (bots use it): each picks a P_Random point on
        // 10..95 % of the line, then the spawn spot within glide range of it that is farthest
        // from the spots picked before (slot order), so the landings spread out
        let map = self.map.clone();
        let mut picked: Vec<(i64, i64)> = Vec::with_capacity(self.players.len());
        let (bx0, by0, bx1, by1) = ((z.bx0 >> FRACBITS) as i64, (z.by0 >> FRACBITS) as i64, (z.bx1 >> FRACBITS) as i64, (z.by1 >> FRACBITS) as i64);
        for i in 0..self.players.len() {
            let f = 26 + (self.p_random() as i64 * 217) / 255; // 26..243 of 256: 10..95 %
            let elapsed = (left as i64 * f / 256) as i32;
            let k = elapsed as i64 * SHIP_SPEED as i64;
            let px = ((sx >> FRACBITS) as i64 + ((k * dx as i64) >> FRACBITS)).clamp(bx0, bx1.max(bx0));
            let py = ((sy >> FRACBITS) as i64 + ((k * dy as i64) >> FRACBITS)).clamp(by0, by1.max(by0));
            // 12 P_Random points within glide reach where a body can land (open sky, room),
            // the one farthest from the landings picked so far; else the nearest spawn spot
            let mut best: Option<(i64, i64, i64)> = None; // (crowding, x, y)
            for _ in 0..12 {
                let ox = (self.p_random() - 128) as i64 * GLIDE_REACH / 128;
                let oy = (self.p_random() - 128) as i64 * GLIDE_REACH / 128;
                let (x, y) = ((px + ox).clamp(bx0, bx1.max(bx0)), (py + oy).clamp(by0, by1.max(by0)));
                if !self.landable((x as i32) << FRACBITS, (y as i32) << FRACBITS) {
                    continue;
                }
                let crowd = picked.iter().map(|&(qx, qy)| (x - qx) * (x - qx) + (y - qy) * (y - qy)).min().unwrap_or(i64::MAX);
                if best.is_none_or(|b| crowd > b.0) {
                    best = Some((crowd, x, y));
                }
            }
            let (tx, ty) = match best {
                Some((_, x, y)) => (x, y),
                None => map
                    .spawn_spots
                    .iter()
                    .map(|s| ((s.x as i64 - px).pow(2) + (s.y as i64 - py).pow(2), s.x as i64, s.y as i64))
                    .min()
                    .map(|(_, x, y)| (x, y))
                    .unwrap_or((px, py)),
            };
            picked.push((tx, ty));
            let b = &mut self.players[i].bot;
            b.drop_x = (tx as i32) << FRACBITS;
            b.drop_y = (ty as i32) << FRACBITS;
            b.drop_t = (left - elapsed).max(0);
        }
    }

    /// one tic of the ship; true when it reached the end of the line (everyone left out)
    pub fn ship_tick(&mut self) -> bool {
        let mut s = self.g.ship;
        s.x = s.x.wrapping_add(s.dx * SHIP_SPEED);
        s.y = s.y.wrapping_add(s.dy * SHIP_SPEED);
        s.left -= 1;
        self.g.ship = s;
        self.g.phase_left = s.left.max(0) as u32;
        if let Some(m) = self.deref(s.mo) {
            self.unset_thing_position(m);
            {
                let mm = self.mo_mut(m);
                mm.x = s.x;
                mm.y = s.y;
                mm.z = s.z;
            }
            self.set_thing_position(m);
        }
        for i in 0..self.players.len() {
            if self.players[i].air == AIR_SHIP {
                let p = &mut self.players[i];
                (p.ax, p.ay, p.az) = (s.x, s.y, s.z);
            }
        }
        if s.left > 0 {
            return false;
        }
        for i in 0..self.players.len() {
            if self.players[i].air == AIR_SHIP {
                self.start_freefall(i);
            }
        }
        if let Some(m) = self.deref(s.mo) {
            self.remove_mobj(m);
        }
        self.g.ship.mo = MRef::NULL;
        true
    }

    fn start_freefall(&mut self, slot: usize) {
        let s = self.g.ship;
        let z = s.z - 64 * FRACUNIT;
        let a = self.players[slot].aangle;
        let m = self.spawn_mobj(s.x, s.y, z, mt::PARACHUTER);
        {
            let mm = self.mo_mut(m);
            mm.player = slot as i32;
            mm.angle = a;
        }
        let r = self.mref(m);
        let p = &mut self.players[slot];
        p.air = AIR_FREEFALL;
        (p.ax, p.ay, p.az) = (s.x, s.y, z);
        p.air_mo = r;
    }

    /// an airborne player's tic: leave the ship, fall, steer, open the chute, land
    pub fn air_tick(&mut self, i: usize) {
        {
            if self.players[i].air == AIR_NONE || self.players[i].playerstate != PST_LIVE {
                return;
            }
            let cmd = self.players[i].cmd;
            let prev = self.players[i].prev_buttons;
            {
                let p = &mut self.players[i];
                p.aangle = ((cmd.yaw as u32) << 16).wrapping_add(p.yaw_offset);
                p.pitch = ((cmd.pitch as i32) << 16).clamp(-MAX_PITCH, MAX_PITCH);
            }
            let edge = |b: u16| cmd.buttons & b != 0 && prev & b == 0;
            match self.players[i].air {
                AIR_SHIP => {
                    if edge(BT_JUMP) || edge(BT_USE) {
                        self.start_freefall(i);
                    }
                }
                _ => self.fall(i, edge(BT_JUMP)),
            }
            let p = &mut self.players[i];
            p.viewz = p.az + VIEWHEIGHT;
        }
    }

    fn fall(&mut self, slot: usize, jump: bool) {
        let cmd = self.players[slot].cmd;
        let (air, a) = (self.players[slot].air, self.players[slot].aangle);
        let spd = if air == AIR_FREEFALL { FREEFALL_STEER } else { CHUTE_STEER };
        let f = cmd.forward as i32 * spd * FRACUNIT / 50;
        let s = cmd.side as i32 * spd * FRACUNIT / 40;
        let (fa, ra) = (fine(a), fine(a.wrapping_sub(ANG90)));
        let z = self.g.zone;
        let (mut x, mut y) = (self.players[slot].ax, self.players[slot].ay);
        x = x.wrapping_add(fixed_mul(f, finecosine(fa)) + fixed_mul(s, finecosine(ra)));
        y = y.wrapping_add(fixed_mul(f, finesine(fa)) + fixed_mul(s, finesine(ra)));
        if z.bx1 > z.bx0 {
            x = x.clamp(z.bx0, z.bx1);
            y = y.clamp(z.by0, z.by1);
        }
        let sec = self.map.sector_at(x, y);
        let (floor, ceil, sky) = {
            let s = &self.sectors[sec];
            (s.floorheight, s.ceilingheight, s.ceilingpic == self.map.sky_flat)
        };
        let mut az = self.players[slot].az;
        let mut air = air;
        if air == AIR_FREEFALL {
            az -= FREEFALL_SPEED * FRACUNIT;
            if az - floor <= CHUTE_AUTO * FRACUNIT || (jump && az - floor > CHUTE_MIN * FRACUNIT) {
                air = AIR_CHUTE;
                if let Some(m) = self.deref(self.players[slot].air_mo) {
                    self.set_mobj_state(m, st::PARA_OPEN as i32);
                }
            }
        } else {
            az -= CHUTE_SPEED * FRACUNIT;
        }
        {
            let p = &mut self.players[slot];
            p.ax = x;
            p.ay = y;
            p.az = az;
            p.air = air;
        }
        if let Some(m) = self.deref(self.players[slot].air_mo) {
            self.unset_thing_position(m);
            {
                let mm = self.mo_mut(m);
                mm.x = x;
                mm.y = y;
                mm.z = az;
                mm.angle = a;
            }
            self.set_thing_position(m);
        }
        if az <= floor || (!sky && az <= ceil) {
            if !self.try_land(slot, sky) {
                // nowhere to stand yet: hover just above the floor and retry next tic
                self.players[slot].az = az.max(floor);
            }
        }
    }

    /// can a body stand at (x, y)?
    fn landing_fits(&mut self, x: Fixed, y: Fixed) -> bool {
        let map = self.map.clone();
        let ss = map.point_in_subsector(x, y);
        let sec = &self.sectors[map.subsectors[ss].sector as usize];
        sec.ceilingheight - sec.floorheight >= 56 * FRACUNIT
            && map.nav.reach.get(ss).copied().unwrap_or(false)
            && crate::bots::nav::static_clear(&map, x, y, 17 * FRACUNIT, false)
            && self.spot_clear(x, y, 17 * FRACUNIT)
    }

    /// open sky above and room for a body
    pub fn landable(&mut self, x: Fixed, y: Fixed) -> bool {
        let sec = self.map.sector_at(x, y);
        self.sectors[sec].ceilingpic == self.map.sky_flat && self.landing_fits(x, y)
    }

    /// land here if it fits (open sky above), else the first landable point on rings of
    /// 64..512 units around, else the nearest spawn spot that fits
    fn try_land(&mut self, slot: usize, sky: bool) -> bool {
        let (x, y) = (self.players[slot].ax, self.players[slot].ay);
        let mut at = None;
        if sky && self.landing_fits(x, y) {
            at = Some((x >> FRACBITS, y >> FRACBITS));
        }
        'rings: for ring in [64, 128, 256, 512] {
            if at.is_some() {
                break;
            }
            for k in 0..8u32 {
                let a = fine(ANG45.wrapping_mul(k));
                let (rx, ry) = (x.wrapping_add(ring * finecosine(a)), y.wrapping_add(ring * finesine(a)));
                if self.landable(rx, ry) {
                    at = Some((rx >> FRACBITS, ry >> FRACBITS));
                    break 'rings;
                }
            }
        }
        if at.is_none() {
            let map = self.map.clone();
            let mut order: Vec<(i64, usize)> = map
                .spawn_spots
                .iter()
                .enumerate()
                .map(|(i, s)| (crate::royale::dist2(x, y, (s.x as i32) << FRACBITS, (s.y as i32) << FRACBITS), i))
                .collect();
            order.sort_unstable();
            for &(_, i) in order.iter().take(64) {
                let s = map.spawn_spots[i];
                if self.landing_fits((s.x as i32) << FRACBITS, (s.y as i32) << FRACBITS) {
                    at = Some((s.x as i32, s.y as i32));
                    break;
                }
            }
        }
        let (lx, ly) = match at {
            Some(p) => p,
            None => return false,
        };
        self.clear_air(slot);
        let spot = MapThing { x: lx as i16, y: ly as i16, angle: 0, type_: 1, options: 7 };
        let n_ev = self.events.len();
        self.spawn_player(slot, &spot);
        // a landing: spawn event b = 2
        for e in self.events[n_ev..].iter_mut() {
            if e.kind == 5 && e.a == slot as i32 {
                e.b = 2;
            }
        }
        self.players[slot].bot.calm_until = self.tic.wrapping_add(CALM_TICS);
        if let Some(h) = self.deref(self.players[slot].mo) {
            let a = self.players[slot].aangle;
            self.mo_mut(h).angle = a;
            let p = &mut self.players[slot];
            p.yaw_offset = a.wrapping_sub((p.cmd.yaw as u32) << 16);
        }
        true
    }
}
