// Moving object handling: spawning, state machine, momentum (p_mobj.c).
// Copyright (C) 1993-1996 by id Software, Inc.
// Port: Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.

use crate::fixed::*;
use crate::info::*;
use crate::map::*;
use crate::world::*;

pub const STOPSPEED: Fixed = 0x1000;
pub const FRICTION: Fixed = 0xe800;
pub const GRAVITY: Fixed = FRACUNIT;
pub const MAXMOVE: Fixed = 30 * FRACUNIT;
pub const FLOATSPEED: Fixed = 4 * FRACUNIT;

impl World {
    /// P_SetMobjState. Returns true if the mobj is still present.
    pub fn set_mobj_state(&mut self, h: u32, mut state: i32) -> bool {
        loop {
            if state == st::NULL as i32 {
                self.mo_mut(h).state = st::NULL as u16;
                self.remove_mobj(h);
                return false;
            }
            let s = crate::info::state(state as usize);
            {
                let m = self.mo_mut(h);
                m.state = state as u16;
                m.tics = s.tics;
                m.sprite = s.sprite;
                m.frame = s.frame;
            }
            if s.action != Action::None {
                self.mobj_action(h, s.action);
                if !self.alive(h) {
                    return false;
                }
            }
            state = crate::info::state(self.mo(h).state as usize).next;
            if self.mo(h).tics != 0 {
                break;
            }
        }
        true
    }

    fn mobj_action(&mut self, h: u32, a: Action) {
        match a {
            Action::Explode => self.a_explode(h),
            Action::Pain => {
                let s = info(self.mo(h).type_ as usize).painsound;
                self.start_sound(h, s);
            }
            Action::PlayerScream => self.a_player_scream(h),
            Action::Fall => {
                self.mo_mut(h).flags &= !MF_SOLID;
            }
            Action::XScream => self.start_sound(h, sfx::slop),
            Action::Scream => {
                let s = info(self.mo(h).type_ as usize).deathsound;
                self.start_sound(h, s);
            }
            Action::BFGSpray => self.a_bfg_spray(h),
            _ => {}
        }
    }

    /// A_Explode
    fn a_explode(&mut self, h: u32) {
        let src = self.deref(self.mo(h).target).unwrap_or(NONE);
        self.radius_attack(h, src, 128, mod_::SPLASH);
    }

    /// A_PlayerScream
    fn a_player_scream(&mut self, h: u32) {
        let mut sound = sfx::pldeth;
        if self.mo(h).health < -50 {
            sound = sfx::pdiehi;
        }
        self.start_sound(h, sound);
    }

    /// A_BFGSpray
    fn a_bfg_spray(&mut self, h: u32) {
        let src = match self.deref(self.mo(h).target) {
            Some(s) => s,
            None => return,
        };
        let base = self.mo(h).angle;
        for i in 0..40u32 {
            if !self.alive(src) {
                return;
            }
            let an = base.wrapping_sub(ANG90 / 2).wrapping_add((ANG90 / 40).wrapping_mul(i));
            self.aim_line_attack(src, an, 16 * 64 * FRACUNIT);
            let lt = match self.deref(self.sc.linetarget) {
                Some(t) => t,
                None => continue,
            };
            let (x, y, z, ht) = {
                let m = self.mo(lt);
                (m.x, m.y, m.z, m.height)
            };
            self.spawn_mobj(x, y, z + (ht >> 2), mt::EXTRABFG);
            let mut damage = 0;
            for _ in 0..15 {
                damage += (self.p_random() & 7) + 1;
            }
            self.damage_mobj(lt, src, src, damage, mod_::BFG);
        }
    }

    /// P_ExplodeMissile
    pub fn explode_missile(&mut self, h: u32) {
        {
            let m = self.mo_mut(h);
            m.momx = 0;
            m.momy = 0;
            m.momz = 0;
        }
        let t = self.mo(h).type_ as usize;
        if !self.set_mobj_state(h, info(t).deathstate) {
            return;
        }
        let r = self.p_random() & 3;
        let m = self.mo_mut(h);
        m.tics -= r;
        if m.tics < 1 {
            m.tics = 1;
        }
        m.flags &= !MF_MISSILE;
        let ds = info(t).deathsound;
        self.start_sound(h, ds);
    }

    /// P_XYMovement
    pub fn xy_movement(&mut self, h: u32) {
        let (momx0, momy0, flags) = {
            let m = self.mo(h);
            (m.momx, m.momy, m.flags)
        };
        if momx0 == 0 && momy0 == 0 {
            if flags & MF_SKULLFLY != 0 {
                let t = self.mo(h).type_ as usize;
                {
                    let m = self.mo_mut(h);
                    m.flags &= !MF_SKULLFLY;
                    m.momx = 0;
                    m.momy = 0;
                    m.momz = 0;
                }
                self.set_mobj_state(h, info(t).spawnstate);
            }
            return;
        }
        let player = self.player_of(h);
        {
            let m = self.mo_mut(h);
            m.momx = m.momx.clamp(-MAXMOVE, MAXMOVE);
            m.momy = m.momy.clamp(-MAXMOVE, MAXMOVE);
        }
        let (mut xmove, mut ymove) = {
            let m = self.mo(h);
            (m.momx, m.momy)
        };
        loop {
            let (x, y) = {
                let m = self.mo(h);
                (m.x, m.y)
            };
            let (ptryx, ptryy);
            if xmove > MAXMOVE / 2 || ymove > MAXMOVE / 2 {
                ptryx = x + xmove / 2;
                ptryy = y + ymove / 2;
                xmove >>= 1;
                ymove >>= 1;
            } else {
                ptryx = x + xmove;
                ptryy = y + ymove;
                xmove = 0;
                ymove = 0;
            }
            if !self.try_move(h, ptryx, ptryy) {
                if !self.alive(h) {
                    return;
                }
                if player.is_some() {
                    self.slide_move(h);
                } else if self.mo(h).flags & MF_MISSILE != 0 {
                    let cl = self.sc.ceilingline;
                    if cl >= 0 {
                        let bs = self.map.lines[cl as usize].backsector;
                        if bs >= 0 && self.sectors[bs as usize].ceilingpic == self.map.sky_flat {
                            self.remove_mobj(h);
                            return;
                        }
                    }
                    self.explode_missile(h);
                } else {
                    let m = self.mo_mut(h);
                    m.momx = 0;
                    m.momy = 0;
                }
            }
            if !self.alive(h) {
                return;
            }
            if xmove == 0 && ymove == 0 {
                break;
            }
        }
        let (flags, z, floorz, momx, momy, subsector) = {
            let m = self.mo(h);
            (m.flags, m.z, m.floorz, m.momx, m.momy, m.subsector)
        };
        if flags & (MF_MISSILE | MF_SKULLFLY) != 0 {
            return;
        }
        if z > floorz {
            return;
        }
        if flags & MF_CORPSE != 0 && (!(-FRACUNIT / 4..=FRACUNIT / 4).contains(&momx) || !(-FRACUNIT / 4..=FRACUNIT / 4).contains(&momy)) {
            let sec = self.map.subsectors[subsector as usize].sector as usize;
            if floorz != self.sectors[sec].floorheight {
                return;
            }
        }
        let still_cmd = match player {
            Some(p) => self.players[p].cmd.forward == 0 && self.players[p].cmd.side == 0,
            None => true,
        };
        if momx > -STOPSPEED && momx < STOPSPEED && momy > -STOPSPEED && momy < STOPSPEED && still_cmd {
            if player.is_some() {
                let s = self.mo(h).state as i32;
                if (s - st::PLAY_RUN1 as i32) >= 0 && (s - st::PLAY_RUN1 as i32) < 4 {
                    self.set_mobj_state(h, st::PLAY as i32);
                }
            }
            let m = self.mo_mut(h);
            m.momx = 0;
            m.momy = 0;
        } else {
            let m = self.mo_mut(h);
            m.momx = fixed_mul(m.momx, FRICTION);
            m.momy = fixed_mul(m.momy, FRICTION);
        }
    }

    /// P_ZMovement
    pub fn z_movement(&mut self, h: u32) {
        let player = self.player_of(h);
        if let Some(p) = player {
            let (z, floorz) = {
                let m = self.mo(h);
                (m.z, m.floorz)
            };
            if z < floorz {
                let pl = &mut self.players[p];
                pl.viewheight -= floorz - z;
                pl.deltaviewheight = (VIEWHEIGHT - pl.viewheight) >> 3;
            }
        }
        {
            let m = self.mo_mut(h);
            m.z = m.z.wrapping_add(m.momz);
        }
        let (flags, target) = {
            let m = self.mo(h);
            (m.flags, m.target)
        };
        if flags & MF_FLOAT != 0 {
            if let Some(t) = self.deref(target) {
                if flags & MF_SKULLFLY == 0 && flags & MF_INFLOAT == 0 {
                    let (tx, ty, tz) = {
                        let m = self.mo(t);
                        (m.x, m.y, m.z)
                    };
                    let m = self.mo_mut(h);
                    let dist = aprox_distance(m.x - tx, m.y - ty);
                    let delta = (tz + (m.height >> 1)) - m.z;
                    if delta < 0 && dist < -(delta * 3) {
                        m.z -= FLOATSPEED;
                    } else if delta > 0 && dist < delta * 3 {
                        m.z += FLOATSPEED;
                    }
                }
            }
        }
        let (z, floorz, momz) = {
            let m = self.mo(h);
            (m.z, m.floorz, m.momz)
        };
        if z <= floorz {
            if flags & MF_SKULLFLY != 0 {
                self.mo_mut(h).momz = -momz;
            }
            let momz = self.mo(h).momz;
            if momz < 0 {
                if let Some(p) = player {
                    if momz < -GRAVITY * 8 {
                        self.players[p].deltaviewheight = momz >> 3;
                        self.start_sound(h, sfx::oof);
                    }
                }
                self.mo_mut(h).momz = 0;
            }
            self.mo_mut(h).z = floorz;
            if flags & MF_MISSILE != 0 && flags & MF_NOCLIP == 0 {
                self.explode_missile(h);
                return;
            }
        } else if flags & MF_NOGRAVITY == 0 {
            let m = self.mo_mut(h);
            if m.momz == 0 {
                m.momz = -GRAVITY * 2;
            } else {
                m.momz -= GRAVITY;
            }
        }
        let (z, height, ceilingz) = {
            let m = self.mo(h);
            (m.z, m.height, m.ceilingz)
        };
        if z.wrapping_add(height) > ceilingz {
            {
                let m = self.mo_mut(h);
                if m.momz > 0 {
                    m.momz = 0;
                }
                m.z = m.ceilingz - m.height;
                if flags & MF_SKULLFLY != 0 {
                    m.momz = -m.momz;
                }
            }
            if flags & MF_MISSILE != 0 && flags & MF_NOCLIP == 0 {
                self.explode_missile(h);
            }
        }
    }

    /// P_MobjThinker
    pub fn mobj_thinker(&mut self, h: u32) {
        let (momx, momy, flags) = {
            let m = self.mo(h);
            (m.momx, m.momy, m.flags)
        };
        if momx != 0 || momy != 0 || flags & MF_SKULLFLY != 0 {
            self.xy_movement(h);
            if !self.alive(h) {
                return;
            }
        }
        let (z, floorz, momz) = {
            let m = self.mo(h);
            (m.z, m.floorz, m.momz)
        };
        if z != floorz || momz != 0 {
            self.z_movement(h);
            if !self.alive(h) {
                return;
            }
        }
        let tics = self.mo(h).tics;
        if tics != -1 {
            let m = self.mo_mut(h);
            m.tics -= 1;
            if m.tics == 0 {
                let next = crate::info::state(m.state as usize).next;
                self.set_mobj_state(h, next);
            }
        }
    }

    /// P_SpawnMobj
    pub fn spawn_mobj(&mut self, x: Fixed, y: Fixed, z: Fixed, type_: usize) -> u32 {
        let inf = info(type_);
        let lastlook = self.p_random() % 4;
        let s = crate::info::state(inf.spawnstate as usize);
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        let m = Mobj {
            id,
            x,
            y,
            z: 0,
            snext: NONE,
            sprev: NONE,
            bnext: NONE,
            bprev: NONE,
            angle: 0,
            sprite: s.sprite,
            frame: s.frame,
            subsector: 0,
            floorz: 0,
            ceilingz: 0,
            radius: inf.radius,
            height: inf.height,
            momx: 0,
            momy: 0,
            momz: 0,
            type_: type_ as u16,
            tics: s.tics,
            state: inf.spawnstate as u16,
            flags: inf.flags as u32,
            health: inf.spawnhealth,
            movedir: 0,
            movecount: 0,
            target: MRef::NULL,
            tracer: MRef::NULL,
            reactiontime: inf.reactiontime,
            threshold: 0,
            player: -1,
            lastlook,
            spawnpoint: MapThing::default(),
        };
        let h = self.alloc_mobj(m);
        self.set_thing_position(h);
        let ss = self.mo(h).subsector as usize;
        let sec = self.sectors[self.map.subsectors[ss].sector as usize];
        let m = self.mo_mut(h);
        m.floorz = sec.floorheight;
        m.ceilingz = sec.ceilingheight;
        m.z = if z == ONFLOORZ {
            m.floorz
        } else if z == ONCEILINGZ {
            m.ceilingz - inf.height
        } else {
            z
        };
        h
    }

    /// P_RemoveMobj
    pub fn remove_mobj(&mut self, h: u32) {
        if !self.alive(h) {
            return;
        }
        let (flags, type_, spawnpoint) = {
            let m = self.mo(h);
            (m.flags, m.type_ as usize, m.spawnpoint)
        };
        if flags & MF_SPECIAL != 0 && flags & MF_DROPPED == 0 && type_ != mt::INV && type_ != mt::INS {
            let lt = self.leveltime;
            self.item_queue.push_back((spawnpoint, lt));
        }
        self.unset_thing_position(h);
        self.mobjs[h as usize] = None;
        self.pending_free_m.push(h);
        self.dirty_order = true;
    }

    /// P_RespawnSpecials (deathmatch 2)
    pub fn respawn_specials(&mut self) {
        let (mthing, t) = match self.item_queue.front() {
            Some(&e) => e,
            None => return,
        };
        if self.leveltime.wrapping_sub(t) < ITEM_RESPAWN_TICS {
            return;
        }
        self.item_queue.pop_front();
        let x = (mthing.x as i32) << FRACBITS;
        let y = (mthing.y as i32) << FRACBITS;
        let ss = self.map.point_in_subsector(x, y);
        let floor = self.sectors[self.map.subsectors[ss].sector as usize].floorheight;
        let fog = self.spawn_mobj(x, y, floor, mt::IFOG);
        self.start_sound(fog, sfx::itmbk);
        let i = match (0..NUMMOBJTYPES).find(|&i| info(i).doomednum == mthing.type_ as i32) {
            Some(i) => i,
            None => return,
        };
        let z = if info(i).flags as u32 & MF_SPAWNCEILING != 0 { ONCEILINGZ } else { ONFLOORZ };
        let mo = self.spawn_mobj(x, y, z, i);
        let m = self.mo_mut(mo);
        m.spawnpoint = mthing;
        m.angle = ANG45.wrapping_mul((mthing.angle as i32 / 45) as u32);
    }

    /// P_SpawnMapThing (deathmatch, netgame, skill 4)
    pub fn spawn_map_thing(&mut self, mthing: &MapThing) {
        if mthing.type_ == 11 || (mthing.type_ >= 1 && mthing.type_ <= 4) {
            return; // starts are collected in Map::spawn_spots
        }
        let bit = 4; // ultra-violence
        if mthing.options & bit == 0 {
            return;
        }
        let i = match (0..NUMMOBJTYPES).find(|&i| info(i).doomednum == mthing.type_ as i32) {
            Some(i) => i,
            None => return,
        };
        let fl = info(i).flags as u32;
        if fl & MF_NOTDMATCH != 0 {
            return;
        }
        // no monsters
        if i == mt::SKULL || fl & MF_COUNTKILL != 0 {
            return;
        }
        let x = (mthing.x as i32) << FRACBITS;
        let y = (mthing.y as i32) << FRACBITS;
        let z = if fl & MF_SPAWNCEILING != 0 { ONCEILINGZ } else { ONFLOORZ };
        let h = self.spawn_mobj(x, y, z, i);
        self.mo_mut(h).spawnpoint = *mthing;
        let tics = self.mo(h).tics;
        if tics > 0 {
            let r = self.p_random();
            self.mo_mut(h).tics = 1 + (r % tics);
        }
        let m = self.mo_mut(h);
        m.angle = ANG45.wrapping_mul((mthing.angle as i32 / 45) as u32);
        if mthing.options & 8 != 0 {
            m.flags |= MF_AMBUSH;
        }
    }

    /// P_SpawnPuff
    pub fn spawn_puff(&mut self, x: Fixed, y: Fixed, mut z: Fixed) {
        z = z.wrapping_add((self.p_random() - self.p_random()) << 10);
        let th = self.spawn_mobj(x, y, z, mt::PUFF);
        let r = self.p_random() & 3;
        {
            let m = self.mo_mut(th);
            m.momz = FRACUNIT;
            m.tics -= r;
            if m.tics < 1 {
                m.tics = 1;
            }
        }
        if self.sc.attackrange == crate::mapmove::MELEERANGE {
            self.set_mobj_state(th, st::PUFF3 as i32);
        }
    }

    /// P_SpawnBlood
    pub fn spawn_blood(&mut self, x: Fixed, y: Fixed, mut z: Fixed, damage: i32) {
        z = z.wrapping_add((self.p_random() - self.p_random()) << 10);
        let th = self.spawn_mobj(x, y, z, mt::BLOOD);
        let r = self.p_random() & 3;
        {
            let m = self.mo_mut(th);
            m.momz = FRACUNIT * 2;
            m.tics -= r;
            if m.tics < 1 {
                m.tics = 1;
            }
        }
        if (9..=12).contains(&damage) {
            self.set_mobj_state(th, st::BLOOD2 as i32);
        } else if damage < 9 {
            self.set_mobj_state(th, st::BLOOD3 as i32);
        }
    }

    /// P_CheckMissileSpawn
    pub fn check_missile_spawn(&mut self, th: u32) {
        let r = self.p_random() & 3;
        {
            let m = self.mo_mut(th);
            m.tics -= r;
            if m.tics < 1 {
                m.tics = 1;
            }
            m.x = m.x.wrapping_add(m.momx >> 1);
            m.y = m.y.wrapping_add(m.momy >> 1);
            m.z = m.z.wrapping_add(m.momz >> 1);
        }
        let (x, y) = {
            let m = self.mo(th);
            (m.x, m.y)
        };
        if !self.try_move(th, x, y) && self.alive(th) {
            self.explode_missile(th);
        }
    }

    /// P_SpawnPlayerMissile with freelook: the missile flies along the view pitch
    /// (horizontal speed * cos(pitch), vertical speed * sin(pitch)); no autoaim.
    pub fn spawn_player_missile(&mut self, source: u32, type_: usize, pitch: i32) {
        let (x, y, z, an) = {
            let m = self.mo(source);
            (m.x, m.y, m.z, m.angle)
        };
        let th = self.spawn_mobj(x, y, z + 4 * 8 * FRACUNIT, type_);
        let ss = info(type_).seesound;
        self.start_sound(th, ss);
        let speed = info(type_).speed;
        let pf = fine(pitch as u32);
        let hspeed = fixed_mul(speed, finecosine(pf));
        let vspeed = fixed_mul(speed, finesine(pf));
        let src = self.mref(source);
        {
            let m = self.mo_mut(th);
            m.target = src;
            m.angle = an;
            m.momx = fixed_mul(hspeed, finecosine(fine(an)));
            m.momy = fixed_mul(hspeed, finesine(fine(an)));
            m.momz = vspeed;
        }
        self.check_missile_spawn(th);
    }
}
