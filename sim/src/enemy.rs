// Monster AI for the random bosses (p_enemy.c subset: Cyberdemon, Spider Mastermind).
// Copyright (C) 1993-1996 by id Software, Inc.
// Port: Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.
//
// Differences from vanilla: P_LookForPlayers picks the nearest player in sight (vanilla
// scanned at most two of four player slots); no sound propagation (A_Look only looks).

use crate::fixed::*;
use crate::info::*;
use crate::mapmove::*;
use crate::world::*;

pub const DI_EAST: i32 = 0;
pub const DI_NODIR: i32 = 8;
const OPPOSITE: [i32; 9] = [4, 5, 6, 7, 0, 1, 2, 3, 8];
const DIAGS: [i32; 4] = [3, 1, 5, 7]; // NW, NE, SW, SE
const XSPEED: [i32; 8] = [FRACUNIT, 47000, 0, -47000, -FRACUNIT, -47000, 0, 47000];
const YSPEED: [i32; 8] = [0, 47000, FRACUNIT, 47000, 0, -47000, -FRACUNIT, -47000];

impl World {
    pub fn is_boss_type(t: usize) -> bool {
        t == mt::CYBORG || t == mt::SPIDER
    }

    /// P_CheckMeleeRange
    fn check_melee_range(&mut self, a: u32) -> bool {
        let t = match self.deref(self.mo(a).target) {
            Some(t) => t,
            None => return false,
        };
        let (ax, ay) = (self.mo(a).x, self.mo(a).y);
        let m = self.mo(t);
        let dist = aprox_distance(m.x - ax, m.y - ay);
        if dist >= MELEERANGE - 20 * FRACUNIT + info(m.type_ as usize).radius {
            return false;
        }
        self.check_sight(a, t)
    }

    /// P_CheckMissileRange
    fn check_missile_range(&mut self, a: u32) -> bool {
        let t = match self.deref(self.mo(a).target) {
            Some(t) => t,
            None => return false,
        };
        if !self.check_sight(a, t) {
            return false;
        }
        if self.mo(a).flags & MF_JUSTHIT != 0 {
            self.mo_mut(a).flags &= !MF_JUSTHIT;
            return true;
        }
        if self.mo(a).reactiontime != 0 {
            return false;
        }
        let (tx, ty) = (self.mo(t).x, self.mo(t).y);
        let m = self.mo(a);
        let ty_ = m.type_ as usize;
        let mut dist = aprox_distance(m.x - tx, m.y - ty) - 64 * FRACUNIT;
        if info(ty_).meleestate == 0 {
            dist -= 128 * FRACUNIT;
        }
        dist >>= 16;
        if ty_ == mt::CYBORG || ty_ == mt::SPIDER || ty_ == mt::SKULL {
            dist >>= 1;
        }
        if dist > 200 {
            dist = 200;
        }
        if ty_ == mt::CYBORG && dist > 160 {
            dist = 160;
        }
        self.p_random() >= dist
    }

    /// P_Move
    fn monster_move(&mut self, a: u32) -> bool {
        let (dir, x, y, t) = {
            let m = self.mo(a);
            (m.movedir, m.x, m.y, m.type_ as usize)
        };
        if dir == DI_NODIR || !(0..8).contains(&dir) {
            return false;
        }
        let speed = info(t).speed;
        let tryx = x.wrapping_add(speed.wrapping_mul(XSPEED[dir as usize]));
        let tryy = y.wrapping_add(speed.wrapping_mul(YSPEED[dir as usize]));
        if !self.try_move(a, tryx, tryy) {
            if !self.alive(a) {
                return false;
            }
            if self.sc.spechit.is_empty() {
                return false;
            }
            self.mo_mut(a).movedir = DI_NODIR;
            let mut good = false;
            let spechit = std::mem::take(&mut self.sc.spechit);
            for &l in spechit.iter().rev() {
                if self.use_special_line(a, l as usize, 0) {
                    good = true;
                }
            }
            return good;
        }
        if !self.alive(a) {
            return false;
        }
        let m = self.mo_mut(a);
        m.flags &= !MF_INFLOAT;
        if m.flags & MF_FLOAT == 0 {
            m.z = m.floorz;
        }
        true
    }

    /// P_TryWalk
    fn try_walk(&mut self, a: u32) -> bool {
        if !self.monster_move(a) {
            return false;
        }
        let r = self.p_random() & 15;
        if self.alive(a) {
            self.mo_mut(a).movecount = r;
        }
        true
    }

    /// P_NewChaseDir
    fn new_chase_dir(&mut self, a: u32) {
        let t = match self.deref(self.mo(a).target) {
            Some(t) => t,
            None => return,
        };
        let olddir = self.mo(a).movedir.clamp(0, 8);
        let turnaround = OPPOSITE[olddir as usize];
        let deltax = self.mo(t).x.wrapping_sub(self.mo(a).x);
        let deltay = self.mo(t).y.wrapping_sub(self.mo(a).y);
        let mut d = [0i32; 3];
        d[1] = if deltax > 10 * FRACUNIT {
            0
        } else if deltax < -10 * FRACUNIT {
            4
        } else {
            DI_NODIR
        };
        d[2] = if deltay < -10 * FRACUNIT {
            6
        } else if deltay > 10 * FRACUNIT {
            2
        } else {
            DI_NODIR
        };
        let walk = |w: &mut World, dir: i32| -> bool {
            w.mo_mut(a).movedir = dir;
            w.try_walk(a) || !w.alive(a)
        };
        if d[1] != DI_NODIR && d[2] != DI_NODIR {
            let dir = DIAGS[(((deltay < 0) as usize) << 1) + (deltax > 0) as usize];
            if dir != turnaround && walk(self, dir) {
                return;
            }
        }
        if self.p_random() > 200 || deltay.wrapping_abs() > deltax.wrapping_abs() {
            d.swap(1, 2);
        }
        if d[1] == turnaround {
            d[1] = DI_NODIR;
        }
        if d[2] == turnaround {
            d[2] = DI_NODIR;
        }
        if d[1] != DI_NODIR && walk(self, d[1]) {
            return;
        }
        if d[2] != DI_NODIR && walk(self, d[2]) {
            return;
        }
        if olddir != DI_NODIR && walk(self, olddir) {
            return;
        }
        if self.p_random() & 1 != 0 {
            for tdir in 0..8 {
                if tdir != turnaround && walk(self, tdir) {
                    return;
                }
            }
        } else {
            for tdir in (0..8).rev() {
                if tdir != turnaround && walk(self, tdir) {
                    return;
                }
            }
        }
        if turnaround != DI_NODIR && walk(self, turnaround) {
            return;
        }
        if self.alive(a) {
            self.mo_mut(a).movedir = DI_NODIR;
        }
    }

    /// P_LookForPlayers: the nearest live player in sight (in front unless `allaround`)
    pub fn look_for_players(&mut self, a: u32, allaround: bool) -> bool {
        let (x, y, angle) = {
            let m = self.mo(a);
            (m.x, m.y, m.angle)
        };
        let mut cands: Vec<(i64, u32)> = Vec::new();
        for p in &self.players {
            if p.health <= 0 || p.playerstate != PST_LIVE {
                continue;
            }
            if let Some(h) = self.deref(p.mo) {
                let m = self.mo(h);
                let dx = (m.x as i64 - x as i64) >> FRACBITS;
                let dy = (m.y as i64 - y as i64) >> FRACBITS;
                if !allaround {
                    let an = point_to_angle2(x, y, m.x, m.y).wrapping_sub(angle);
                    if an > ANG90 && an < ANG270 && dx * dx + dy * dy > 64 * 64 {
                        continue;
                    }
                }
                cands.push((dx * dx + dy * dy, h));
            }
        }
        cands.sort_unstable();
        for &(_, h) in cands.iter().take(4) {
            if self.check_sight(a, h) {
                let r = self.mref(h);
                self.mo_mut(a).target = r;
                return true;
            }
        }
        false
    }

    /// A_Look
    pub fn a_look(&mut self, a: u32) {
        self.mo_mut(a).threshold = 0;
        if !self.look_for_players(a, false) {
            return;
        }
        let t = self.mo(a).type_ as usize;
        let s = info(t).seesound;
        if s > 0 {
            let (x, y, z) = {
                let m = self.mo(a);
                (m.x, m.y, m.z)
            };
            // bosses: full volume, map-wide
            self.start_sound_at(x, y, z, s);
        }
        self.set_mobj_state(a, info(t).seestate);
    }

    /// A_Chase
    pub fn a_chase(&mut self, a: u32) {
        {
            let m = self.mo_mut(a);
            if m.reactiontime != 0 {
                m.reactiontime -= 1;
            }
        }
        if self.mo(a).threshold != 0 {
            let dead = match self.deref(self.mo(a).target) {
                Some(t) => self.mo(t).health <= 0,
                None => true,
            };
            let m = self.mo_mut(a);
            if dead {
                m.threshold = 0;
            } else {
                m.threshold -= 1;
            }
        }
        {
            let m = self.mo_mut(a);
            if (0..8).contains(&m.movedir) {
                m.angle &= 7 << 29;
                let delta = m.angle.wrapping_sub((m.movedir as u32) << 29) as i32;
                if delta > 0 {
                    m.angle = m.angle.wrapping_sub(ANG90 / 2);
                } else if delta < 0 {
                    m.angle = m.angle.wrapping_add(ANG90 / 2);
                }
            }
        }
        let t = self.mo(a).type_ as usize;
        let target_ok = match self.deref(self.mo(a).target) {
            Some(tg) => self.mo(tg).flags & MF_SHOOTABLE != 0,
            None => false,
        };
        if !target_ok {
            if self.look_for_players(a, true) {
                return;
            }
            self.set_mobj_state(a, info(t).spawnstate);
            return;
        }
        if self.mo(a).flags & MF_JUSTATTACKED != 0 {
            self.mo_mut(a).flags &= !MF_JUSTATTACKED;
            self.new_chase_dir(a);
            return;
        }
        if info(t).meleestate != 0 && self.check_melee_range(a) {
            let s = info(t).attacksound;
            self.start_sound(a, s);
            self.set_mobj_state(a, info(t).meleestate);
            return;
        }
        if info(t).missilestate != 0 && self.mo(a).movecount == 0 && self.check_missile_range(a) {
            self.set_mobj_state(a, info(t).missilestate);
            if self.alive(a) {
                self.mo_mut(a).flags |= MF_JUSTATTACKED;
            }
            return;
        }
        // nomissile (netgame): look for someone in sight
        if self.mo(a).threshold == 0 {
            let tg = self.deref(self.mo(a).target).unwrap();
            if !self.check_sight(a, tg) && self.look_for_players(a, true) {
                return;
            }
        }
        let mc = {
            let m = self.mo_mut(a);
            m.movecount -= 1;
            m.movecount
        };
        if mc < 0 || !self.monster_move(a) {
            if !self.alive(a) {
                return;
            }
            self.new_chase_dir(a);
        }
        if !self.alive(a) {
            return;
        }
        let s = info(t).activesound;
        if s > 0 && self.p_random() < 3 {
            self.start_sound(a, s);
        }
    }

    /// A_FaceTarget
    pub fn a_face_target(&mut self, a: u32) {
        let t = match self.deref(self.mo(a).target) {
            Some(t) => t,
            None => return,
        };
        let (tx, ty, tflags) = {
            let m = self.mo(t);
            (m.x, m.y, m.flags)
        };
        let (x, y) = (self.mo(a).x, self.mo(a).y);
        self.mo_mut(a).flags &= !MF_AMBUSH;
        let mut an = point_to_angle2(x, y, tx, ty);
        if tflags & MF_SHADOW != 0 {
            an = an.wrapping_add(((self.p_random() - self.p_random()) << 21) as u32);
        }
        self.mo_mut(a).angle = an;
    }

    /// A_SPosAttack (the Spider Mastermind's chaingun)
    pub fn a_spos_attack(&mut self, a: u32) {
        if self.deref(self.mo(a).target).is_none() {
            return;
        }
        self.start_sound(a, sfx::shotgn);
        self.a_face_target(a);
        let bangle = self.mo(a).angle;
        let slope = self.aim_line_attack(a, bangle, MISSILERANGE);
        for _ in 0..3 {
            if !self.alive(a) {
                return;
            }
            let angle = bangle.wrapping_add(((self.p_random() - self.p_random()) << 20) as u32);
            let damage = ((self.p_random() % 5) + 1) * 3;
            self.line_attack(a, angle, MISSILERANGE, slope, damage, mod_::CHAINGUN);
        }
    }

    /// A_SpidRefire
    pub fn a_spid_refire(&mut self, a: u32) {
        self.a_face_target(a);
        if self.p_random() < 10 {
            return;
        }
        let lost = match self.deref(self.mo(a).target) {
            Some(t) => self.mo(t).health <= 0 || !self.check_sight(a, t),
            None => true,
        };
        if lost {
            let s = info(self.mo(a).type_ as usize).seestate;
            self.set_mobj_state(a, s);
        }
    }

    /// A_CyberAttack
    pub fn a_cyber_attack(&mut self, a: u32) {
        let t = match self.deref(self.mo(a).target) {
            Some(t) => t,
            None => return,
        };
        self.a_face_target(a);
        self.spawn_missile(a, t, mt::ROCKET);
    }

    /// P_SpawnMissile (monster missiles)
    pub fn spawn_missile(&mut self, source: u32, dest: u32, type_: usize) {
        let (sx, sy, sz) = {
            let m = self.mo(source);
            (m.x, m.y, m.z)
        };
        let (dx, dy, dz, dflags) = {
            let m = self.mo(dest);
            (m.x, m.y, m.z, m.flags)
        };
        let th = self.spawn_mobj(sx, sy, sz + 4 * 8 * FRACUNIT, type_);
        let ss = info(type_).seesound;
        self.start_sound(th, ss);
        let src = self.mref(source);
        let mut an = point_to_angle2(sx, sy, dx, dy);
        if dflags & MF_SHADOW != 0 {
            an = an.wrapping_add(((self.p_random() - self.p_random()) << 20) as u32);
        }
        let speed = info(type_).speed;
        let mut dist = aprox_distance(dx - sx, dy - sy) / speed;
        if dist < 1 {
            dist = 1;
        }
        let m = self.mo_mut(th);
        m.target = src;
        m.angle = an;
        m.momx = fixed_mul(speed, finecosine(fine(an)));
        m.momy = fixed_mul(speed, finesine(fine(an)));
        m.momz = (dz - sz) / dist;
        self.check_missile_spawn(th);
    }
}
