// Teleportation (p_telept.c).
// Copyright (C) 1993-1996 by id Software, Inc.
// Port: Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.

use crate::fixed::*;
use crate::info::*;
use crate::world::*;

impl World {
    /// EV_Teleport
    pub fn ev_teleport(&mut self, line: usize, side: i32, thing: u32) -> bool {
        if self.mo(thing).flags & MF_MISSILE != 0 {
            return false;
        }
        if side == 1 {
            return false;
        }
        let tag = self.map.lines[line].tag;
        for i in 0..self.map.sectors.len() {
            if self.map.sectors[i].tag != tag {
                continue;
            }
            // thinker list order = self.order
            let mut k = 0;
            while k < self.order.len() {
                let o = self.order[k];
                k += 1;
                if o & SPEC_FLAG != 0 || !self.alive(o) {
                    continue;
                }
                let m = self.mo(o);
                if m.type_ as usize != mt::TELEPORTMAN {
                    continue;
                }
                if self.map.subsectors[m.subsector as usize].sector as usize != i {
                    continue;
                }
                let (dx, dy, dangle) = (m.x, m.y, m.angle);
                let (oldx, oldy, oldz) = {
                    let t = self.mo(thing);
                    (t.x, t.y, t.z)
                };
                if !self.teleport_move(thing, dx, dy) {
                    return false;
                }
                if !self.alive(thing) {
                    return false;
                }
                let z = {
                    let t = self.mo_mut(thing);
                    t.z = t.floorz;
                    t.z
                };
                let player = self.player_of(thing);
                if let Some(p) = player {
                    self.players[p].viewz = z + self.players[p].viewheight;
                }
                let fog = self.spawn_mobj(oldx, oldy, oldz, mt::TFOG);
                self.start_sound(fog, sfx::telept);
                let an = fine(dangle);
                let fog = self.spawn_mobj(dx + 20 * finecosine(an), dy + 20 * finesine(an), z, mt::TFOG);
                self.start_sound(fog, sfx::telept);
                if let Some(p) = player {
                    self.mo_mut(thing).reactiontime = 18;
                    self.emit(5, p as i32, 1, 0, dx, dy, z, 0);
                }
                if player.is_some() {
                    self.set_player_angle(thing, dangle);
                } else {
                    self.mo_mut(thing).angle = dangle;
                }
                let t = self.mo_mut(thing);
                t.momx = 0;
                t.momy = 0;
                t.momz = 0;
                return true;
            }
        }
        false
    }
}
