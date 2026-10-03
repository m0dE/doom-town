// Movement, collision handling, shooting, use, radius attacks, sector changes (p_map.c).
// Copyright (C) 1993-1996 by id Software, Inc.
// Port: Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.
//
// Freelook change: P_LineAttack callers pass the slope of the player's pitch instead of
// an autoaimed slope (see pspr.rs). P_AimLineAttack is kept for melee and BFG spray.

use crate::fixed::*;
use crate::info::*;
use crate::map::*;
use crate::maputl::*;
use crate::world::*;

pub const USERANGE: Fixed = 64 * FRACUNIT;
pub const MELEERANGE: Fixed = 64 * FRACUNIT;
pub const MISSILERANGE: Fixed = 32 * 64 * FRACUNIT;

impl World {
    fn tm_setup(&mut self, h: u32, x: Fixed, y: Fixed) {
        let (flags, radius) = {
            let m = self.mo(h);
            (m.flags, m.radius)
        };
        self.sc.tmthing = h;
        self.sc.tmflags = flags;
        self.sc.tmx = x;
        self.sc.tmy = y;
        self.sc.tmbbox[BOXTOP] = y.wrapping_add(radius);
        self.sc.tmbbox[BOXBOTTOM] = y.wrapping_sub(radius);
        self.sc.tmbbox[BOXRIGHT] = x.wrapping_add(radius);
        self.sc.tmbbox[BOXLEFT] = x.wrapping_sub(radius);
        let ss = self.map.point_in_subsector(x, y);
        let sec = &self.sectors[self.map.subsectors[ss].sector as usize];
        self.sc.ceilingline = -1;
        self.sc.tmfloorz = sec.floorheight;
        self.sc.tmdropoffz = sec.floorheight;
        self.sc.tmceilingz = sec.ceilingheight;
        self.new_validcount();
        self.sc.spechit.clear();
    }

    fn things_in_box(&self, extra: Fixed) -> Vec<u32> {
        let map = &self.map;
        let xl = (self.sc.tmbbox[BOXLEFT].wrapping_sub(map.bmaporgx).wrapping_sub(extra)) >> MAPBLOCKSHIFT;
        let xh = (self.sc.tmbbox[BOXRIGHT].wrapping_sub(map.bmaporgx).wrapping_add(extra)) >> MAPBLOCKSHIFT;
        let yl = (self.sc.tmbbox[BOXBOTTOM].wrapping_sub(map.bmaporgy).wrapping_sub(extra)) >> MAPBLOCKSHIFT;
        let yh = (self.sc.tmbbox[BOXTOP].wrapping_sub(map.bmaporgy).wrapping_add(extra)) >> MAPBLOCKSHIFT;
        let mut v = Vec::new();
        for bx in xl..=xh {
            for by in yl..=yh {
                // keep vanilla's per-block order: blocks x-major, then y
                self.block_things(bx, by, &mut v);
            }
        }
        v
    }

    /// PIT_StompThing
    fn stomp_thing(&mut self, t: u32) -> bool {
        let tm = self.sc.tmthing;
        let (tf, tx, ty, tr) = {
            let m = self.mo(t);
            (m.flags, m.x, m.y, m.radius)
        };
        if tf & MF_SHOOTABLE == 0 {
            return true;
        }
        let blockdist = tr + self.mo(tm).radius;
        if (tx - self.sc.tmx).wrapping_abs() >= blockdist || (ty - self.sc.tmy).wrapping_abs() >= blockdist {
            return true;
        }
        if t == tm {
            return true;
        }
        if self.mo(tm).player < 0 {
            return false;
        }
        self.damage_mobj(t, tm, tm, 10000, mod_::TELEFRAG);
        true
    }

    /// P_TeleportMove
    pub fn teleport_move(&mut self, h: u32, x: Fixed, y: Fixed) -> bool {
        self.tm_setup(h, x, y);
        let things = self.things_in_box(MAXRADIUS);
        for t in things {
            if !self.alive(t) || !self.alive(h) {
                continue;
            }
            if !self.stomp_thing(t) {
                return false;
            }
        }
        self.unset_thing_position(h);
        let (fz, cz) = (self.sc.tmfloorz, self.sc.tmceilingz);
        {
            let m = self.mo_mut(h);
            m.floorz = fz;
            m.ceilingz = cz;
            m.x = x;
            m.y = y;
        }
        self.set_thing_position(h);
        true
    }

    /// PIT_CheckLine
    fn check_line(&mut self, l: u32) -> bool {
        let map = self.map.clone();
        let ld = &map.lines[l as usize];
        let b = &self.sc.tmbbox;
        if b[BOXRIGHT] <= ld.bbox[BOXLEFT] || b[BOXLEFT] >= ld.bbox[BOXRIGHT] || b[BOXTOP] <= ld.bbox[BOXBOTTOM] || b[BOXBOTTOM] >= ld.bbox[BOXTOP] {
            return true;
        }
        if box_on_line_side(&self.sc.tmbbox, ld) != -1 {
            return true;
        }
        if ld.backsector < 0 {
            return false;
        }
        let tm = self.sc.tmthing;
        let (tflags, tplayer) = {
            let m = self.mo(tm);
            (m.flags, m.player)
        };
        if tflags & MF_MISSILE == 0 {
            if ld.flags & ML_BLOCKING != 0 {
                return false;
            }
            if tplayer < 0 && ld.flags & ML_BLOCKMONSTERS != 0 {
                return false;
            }
        }
        self.line_opening(l as usize);
        if self.sc.opentop < self.sc.tmceilingz {
            self.sc.tmceilingz = self.sc.opentop;
            self.sc.ceilingline = l as i32;
        }
        if self.sc.openbottom > self.sc.tmfloorz {
            self.sc.tmfloorz = self.sc.openbottom;
        }
        if self.sc.lowfloor < self.sc.tmdropoffz {
            self.sc.tmdropoffz = self.sc.lowfloor;
        }
        if self.line_special[l as usize] != 0 {
            self.sc.spechit.push(l);
        }
        true
    }

    /// PIT_CheckThing
    fn check_thing(&mut self, t: u32) -> bool {
        let tm = self.sc.tmthing;
        let (tf, tx, ty, tr, tz, th, ttype) = {
            let m = self.mo(t);
            (m.flags, m.x, m.y, m.radius, m.z, m.height, m.type_)
        };
        if tf & (MF_SOLID | MF_SPECIAL | MF_SHOOTABLE) == 0 {
            return true;
        }
        let (mflags, mradius, mz, mheight, mtarget, mtype) = {
            let m = self.mo(tm);
            (m.flags, m.radius, m.z, m.height, m.target, m.type_)
        };
        let blockdist = tr + mradius;
        if (tx - self.sc.tmx).wrapping_abs() >= blockdist || (ty - self.sc.tmy).wrapping_abs() >= blockdist {
            return true;
        }
        if t == tm {
            return true;
        }
        // grenades bounce off walls and floors only
        if mtype as usize == mt::GRENADE {
            return true;
        }
        if mflags & MF_SKULLFLY != 0 {
            let damage = ((self.p_random() % 8) + 1) * info(mtype as usize).damage;
            self.damage_mobj(t, tm, tm, damage, mod_::WORLD);
            let m = self.mo_mut(tm);
            m.flags &= !MF_SKULLFLY;
            m.momx = 0;
            m.momy = 0;
            m.momz = 0;
            let ss = info(mtype as usize).spawnstate;
            self.set_mobj_state(tm, ss);
            return false;
        }
        if mflags & MF_MISSILE != 0 {
            if mz > tz + th {
                return true;
            }
            if mz + mheight < tz {
                return true;
            }
            let target = self.deref(mtarget);
            if let Some(src) = target {
                let stype = self.mo(src).type_ as usize;
                if stype == ttype as usize || (stype == mt::KNIGHT && ttype as usize == mt::BRUISER) || (stype == mt::BRUISER && ttype as usize == mt::KNIGHT) {
                    if t == src {
                        return true;
                    }
                    if ttype as usize != mt::PLAYER {
                        return false;
                    }
                }
            }
            if tf & MF_SHOOTABLE == 0 {
                return tf & MF_SOLID == 0;
            }
            let damage = ((self.p_random() % 8) + 1) * info(mtype as usize).damage;
            let m = missile_mod(mtype as usize);
            self.damage_mobj(t, tm, target.unwrap_or(NONE), damage, m);
            return false;
        }
        if tf & MF_SPECIAL != 0 {
            let solid = tf & MF_SOLID != 0;
            if self.sc.tmflags & MF_PICKUP != 0 {
                self.touch_special_thing(t, tm);
            }
            return !solid;
        }
        if self.g.cfg.ghost_players() && self.mo(t).player >= 0 && self.mo(tm).player >= 0 {
            return true;
        }
        tf & MF_SOLID == 0
    }

    /// P_CheckPosition
    pub fn check_position(&mut self, h: u32, x: Fixed, y: Fixed) -> bool {
        self.tm_setup(h, x, y);
        if self.sc.tmflags & MF_NOCLIP != 0 {
            return true;
        }
        let things = self.things_in_box(MAXRADIUS);
        for t in things {
            if !self.alive(t) {
                continue;
            }
            if !self.check_thing(t) {
                return false;
            }
            if !self.alive(h) {
                return false;
            }
        }
        let map = self.map.clone();
        let xl = (self.sc.tmbbox[BOXLEFT].wrapping_sub(map.bmaporgx)) >> MAPBLOCKSHIFT;
        let xh = (self.sc.tmbbox[BOXRIGHT].wrapping_sub(map.bmaporgx)) >> MAPBLOCKSHIFT;
        let yl = (self.sc.tmbbox[BOXBOTTOM].wrapping_sub(map.bmaporgy)) >> MAPBLOCKSHIFT;
        let yh = (self.sc.tmbbox[BOXTOP].wrapping_sub(map.bmaporgy)) >> MAPBLOCKSHIFT;
        let mut lines = Vec::new();
        for bx in xl..=xh {
            for by in yl..=yh {
                lines.clear();
                self.block_lines(bx, by, &mut lines);
                for &l in &lines {
                    if !self.check_line(l) {
                        return false;
                    }
                }
            }
        }
        true
    }

    /// P_TryMove
    pub fn try_move(&mut self, h: u32, x: Fixed, y: Fixed) -> bool {
        self.sc.floatok = false;
        if !self.check_position(h, x, y) {
            return false;
        }
        let (flags, height, z) = {
            let m = self.mo(h);
            (m.flags, m.height, m.z)
        };
        if flags & MF_NOCLIP == 0 {
            if self.sc.tmceilingz - self.sc.tmfloorz < height {
                return false;
            }
            self.sc.floatok = true;
            if flags & MF_TELEPORT == 0 && self.sc.tmceilingz - z < height {
                return false;
            }
            if flags & MF_TELEPORT == 0 && self.sc.tmfloorz - z > 24 * FRACUNIT {
                return false;
            }
            if flags & (MF_DROPOFF | MF_FLOAT) == 0 && self.sc.tmfloorz - self.sc.tmdropoffz > 24 * FRACUNIT {
                return false;
            }
        }
        self.unset_thing_position(h);
        let (oldx, oldy) = {
            let m = self.mo(h);
            (m.x, m.y)
        };
        let (fz, cz) = (self.sc.tmfloorz, self.sc.tmceilingz);
        {
            let m = self.mo_mut(h);
            m.floorz = fz;
            m.ceilingz = cz;
            m.x = x;
            m.y = y;
        }
        self.set_thing_position(h);
        if flags & (MF_TELEPORT | MF_NOCLIP) == 0 {
            let spechit = std::mem::take(&mut self.sc.spechit);
            for &l in spechit.iter().rev() {
                if !self.alive(h) {
                    break;
                }
                let (mx, my) = {
                    let m = self.mo(h);
                    (m.x, m.y)
                };
                let ld = &self.map.lines[l as usize];
                let side = point_on_line_side(mx, my, ld);
                let oldside = point_on_line_side(oldx, oldy, ld);
                if side != oldside && self.line_special[l as usize] != 0 {
                    self.cross_special_line(l as usize, oldside, h);
                }
            }
            self.sc.spechit = spechit;
        }
        true
    }

    /// P_ThingHeightClip
    pub fn thing_height_clip(&mut self, h: u32) -> bool {
        let onfloor = {
            let m = self.mo(h);
            m.z == m.floorz
        };
        let (x, y) = {
            let m = self.mo(h);
            (m.x, m.y)
        };
        self.check_position(h, x, y);
        if !self.alive(h) {
            return true;
        }
        let (fz, cz) = (self.sc.tmfloorz, self.sc.tmceilingz);
        let m = self.mo_mut(h);
        m.floorz = fz;
        m.ceilingz = cz;
        if onfloor {
            m.z = m.floorz;
        } else if m.z + m.height > m.ceilingz {
            m.z = m.ceilingz - m.height;
        }
        m.ceilingz - m.floorz >= m.height
    }

    /// P_HitSlideLine
    fn hit_slide_line(&mut self, l: i32) {
        let ld = &self.map.lines[l as usize];
        if ld.slopetype == ST_HORIZONTAL {
            self.sc.tmymove = 0;
            return;
        }
        if ld.slopetype == ST_VERTICAL {
            self.sc.tmxmove = 0;
            return;
        }
        let (sx, sy) = {
            let m = self.mo(self.sc.slidemo);
            (m.x, m.y)
        };
        let side = point_on_line_side(sx, sy, ld);
        let mut lineangle = point_to_angle2(0, 0, ld.dx, ld.dy);
        if side == 1 {
            lineangle = lineangle.wrapping_add(ANG180);
        }
        let moveangle = point_to_angle2(0, 0, self.sc.tmxmove, self.sc.tmymove);
        let mut deltaangle = moveangle.wrapping_sub(lineangle);
        if deltaangle > ANG180 {
            deltaangle = deltaangle.wrapping_add(ANG180);
        }
        let la = fine(lineangle);
        let da = fine(deltaangle);
        let movelen = aprox_distance(self.sc.tmxmove, self.sc.tmymove);
        let newlen = fixed_mul(movelen, finecosine(da));
        self.sc.tmxmove = fixed_mul(newlen, finecosine(la));
        self.sc.tmymove = fixed_mul(newlen, finesine(la));
    }

    /// PTR_SlideTraverse
    fn slide_traverse(&mut self, inter: &Intercept) -> bool {
        let li = inter.d as usize;
        let map = self.map.clone();
        let line = &map.lines[li];
        let (sx, sy, sz, sh) = {
            let m = self.mo(self.sc.slidemo);
            (m.x, m.y, m.z, m.height)
        };
        let blocking = if line.flags & ML_TWOSIDED == 0 {
            if point_on_line_side(sx, sy, line) != 0 {
                return true;
            }
            true
        } else {
            self.line_opening(li);
            self.sc.openrange < sh || self.sc.opentop - sz < sh || self.sc.openbottom - sz > 24 * FRACUNIT
        };
        if !blocking {
            return true;
        }
        if inter.frac < self.sc.bestslidefrac {
            self.sc.secondslidefrac = self.sc.bestslidefrac;
            self.sc.secondslideline = self.sc.bestslideline;
            self.sc.bestslidefrac = inter.frac;
            self.sc.bestslideline = li as i32;
        }
        false
    }

    fn slide_path(&mut self, x1: Fixed, y1: Fixed, x2: Fixed, y2: Fixed) {
        let mut list = std::mem::take(&mut self.sc.intercepts);
        if self.path_traverse_collect(x1, y1, x2, y2, PT_ADDLINES, &mut list) {
            while let Some(i) = World::next_intercept(&mut list, FRACUNIT) {
                if !self.slide_traverse(&i) {
                    break;
                }
            }
        }
        list.clear();
        self.sc.intercepts = list;
    }

    /// P_SlideMove
    pub fn slide_move(&mut self, h: u32) {
        self.sc.slidemo = h;
        let mut hitcount = 0;
        loop {
            hitcount += 1;
            if hitcount == 3 {
                self.stairstep(h);
                return;
            }
            let (x, y, r, momx, momy) = {
                let m = self.mo(h);
                (m.x, m.y, m.radius, m.momx, m.momy)
            };
            let (leadx, trailx) = if momx > 0 { (x + r, x - r) } else { (x - r, x + r) };
            let (leady, traily) = if momy > 0 { (y + r, y - r) } else { (y - r, y + r) };
            self.sc.bestslidefrac = FRACUNIT + 1;
            self.slide_path(leadx, leady, leadx.wrapping_add(momx), leady.wrapping_add(momy));
            self.slide_path(trailx, leady, trailx.wrapping_add(momx), leady.wrapping_add(momy));
            self.slide_path(leadx, traily, leadx.wrapping_add(momx), traily.wrapping_add(momy));
            if self.sc.bestslidefrac == FRACUNIT + 1 {
                self.stairstep(h);
                return;
            }
            self.sc.bestslidefrac -= 0x800;
            if self.sc.bestslidefrac > 0 {
                let newx = fixed_mul(momx, self.sc.bestslidefrac);
                let newy = fixed_mul(momy, self.sc.bestslidefrac);
                let (x, y) = {
                    let m = self.mo(h);
                    (m.x, m.y)
                };
                if !self.try_move(h, x.wrapping_add(newx), y.wrapping_add(newy)) {
                    self.stairstep(h);
                    return;
                }
            }
            let mut bsf = FRACUNIT - (self.sc.bestslidefrac + 0x800);
            if bsf > FRACUNIT {
                bsf = FRACUNIT;
            }
            if bsf <= 0 {
                return;
            }
            self.sc.bestslidefrac = bsf;
            self.sc.tmxmove = fixed_mul(momx, bsf);
            self.sc.tmymove = fixed_mul(momy, bsf);
            let bl = self.sc.bestslideline;
            self.hit_slide_line(bl);
            let (tx, ty) = (self.sc.tmxmove, self.sc.tmymove);
            {
                let m = self.mo_mut(h);
                m.momx = tx;
                m.momy = ty;
            }
            let (x, y) = {
                let m = self.mo(h);
                (m.x, m.y)
            };
            if self.try_move(h, x.wrapping_add(tx), y.wrapping_add(ty)) {
                return;
            }
        }
    }

    fn stairstep(&mut self, h: u32) {
        let (x, y, momx, momy) = {
            let m = self.mo(h);
            (m.x, m.y, m.momx, m.momy)
        };
        if !self.try_move(h, x, y.wrapping_add(momy)) {
            self.try_move(h, x.wrapping_add(momx), y);
        }
    }

    // ------------------------------------------------------------------ line attacks
    /// PTR_AimTraverse
    fn aim_traverse(&mut self, inter: &Intercept) -> bool {
        if inter.isaline {
            let li = inter.d as usize;
            let map = self.map.clone();
            let line = &map.lines[li];
            if line.flags & ML_TWOSIDED == 0 {
                return false;
            }
            self.line_opening(li);
            if self.sc.openbottom >= self.sc.opentop {
                return false;
            }
            let dist = fixed_mul(self.sc.attackrange, inter.frac);
            let front = &self.sectors[line.frontsector as usize];
            let back = &self.sectors[line.backsector as usize];
            if front.floorheight != back.floorheight {
                let slope = fixed_div(self.sc.openbottom - self.sc.shootz, dist);
                if slope > self.sc.bottomslope {
                    self.sc.bottomslope = slope;
                }
            }
            if front.ceilingheight != back.ceilingheight {
                let slope = fixed_div(self.sc.opentop - self.sc.shootz, dist);
                if slope < self.sc.topslope {
                    self.sc.topslope = slope;
                }
            }
            return self.sc.topslope > self.sc.bottomslope;
        }
        let th = inter.d;
        if !self.alive(th) || self.mo(th).id != inter.id {
            return true;
        }
        if th == self.sc.shootthing {
            return true;
        }
        let (flags, z, height) = {
            let m = self.mo(th);
            (m.flags, m.z, m.height)
        };
        if flags & MF_SHOOTABLE == 0 {
            return true;
        }
        let dist = fixed_mul(self.sc.attackrange, inter.frac);
        let mut thingtopslope = fixed_div(z + height - self.sc.shootz, dist);
        if thingtopslope < self.sc.bottomslope {
            return true;
        }
        let mut thingbottomslope = fixed_div(z - self.sc.shootz, dist);
        if thingbottomslope > self.sc.topslope {
            return true;
        }
        if thingtopslope > self.sc.topslope {
            thingtopslope = self.sc.topslope;
        }
        if thingbottomslope < self.sc.bottomslope {
            thingbottomslope = self.sc.bottomslope;
        }
        self.sc.aimslope = ((thingtopslope as i64 + thingbottomslope as i64) / 2) as i32;
        self.sc.linetarget = self.mref(th);
        false
    }

    /// PTR_ShootTraverse
    fn shoot_traverse(&mut self, inter: &Intercept) -> bool {
        let trace = self.sc.trace;
        if inter.isaline {
            let li = inter.d as usize;
            let map = self.map.clone();
            let line = &map.lines[li];
            if self.line_special[li] != 0 {
                let st = self.sc.shootthing;
                self.shoot_special_line(st, li);
            }
            let mut hit = line.flags & ML_TWOSIDED == 0;
            if !hit {
                self.line_opening(li);
                let dist = fixed_mul(self.sc.attackrange, inter.frac);
                let front = self.sectors[line.frontsector as usize];
                let back = self.sectors[line.backsector as usize];
                if front.floorheight != back.floorheight {
                    let slope = fixed_div(self.sc.openbottom - self.sc.shootz, dist);
                    if slope > self.sc.aimslope {
                        hit = true;
                    }
                }
                if !hit && front.ceilingheight != back.ceilingheight {
                    let slope = fixed_div(self.sc.opentop - self.sc.shootz, dist);
                    if slope < self.sc.aimslope {
                        hit = true;
                    }
                }
                if !hit {
                    return true;
                }
            }
            // hit line: position a bit closer
            let frac = inter.frac - fixed_div(4 * FRACUNIT, self.sc.attackrange);
            let x = trace.x.wrapping_add(fixed_mul(trace.dx, frac));
            let y = trace.y.wrapping_add(fixed_mul(trace.dy, frac));
            let z = self.sc.shootz.wrapping_add(fixed_mul(self.sc.aimslope, fixed_mul(frac, self.sc.attackrange)));
            let front = self.sectors[line.frontsector as usize];
            if front.ceilingpic == self.map.sky_flat {
                if z > front.ceilingheight {
                    return false;
                }
                if line.backsector >= 0 && self.sectors[line.backsector as usize].ceilingpic == self.map.sky_flat {
                    return false;
                }
            }
            self.spawn_puff(x, y, z);
            return false;
        }
        let th = inter.d;
        if !self.alive(th) || self.mo(th).id != inter.id {
            return true;
        }
        if th == self.sc.shootthing {
            return true;
        }
        let (flags, z, height) = {
            let m = self.mo(th);
            (m.flags, m.z, m.height)
        };
        if flags & MF_SHOOTABLE == 0 {
            return true;
        }
        let dist = fixed_mul(self.sc.attackrange, inter.frac);
        let thingtopslope = fixed_div(z + height - self.sc.shootz, dist);
        if thingtopslope < self.sc.aimslope {
            return true;
        }
        let thingbottomslope = fixed_div(z - self.sc.shootz, dist);
        if thingbottomslope > self.sc.aimslope {
            return true;
        }
        let frac = inter.frac - fixed_div(10 * FRACUNIT, self.sc.attackrange);
        let x = trace.x.wrapping_add(fixed_mul(trace.dx, frac));
        let y = trace.y.wrapping_add(fixed_mul(trace.dy, frac));
        let z = self.sc.shootz.wrapping_add(fixed_mul(self.sc.aimslope, fixed_mul(frac, self.sc.attackrange)));
        if flags & MF_NOBLOOD != 0 {
            self.spawn_puff(x, y, z);
        } else {
            let d = self.sc.la_damage;
            self.spawn_blood(x, y, z, d);
        }
        if self.sc.la_damage != 0 {
            let st = self.sc.shootthing;
            let (d, m) = (self.sc.la_damage, self.sc.la_mod);
            self.damage_mobj(th, st, st, d, m);
        }
        false
    }

    /// P_AimLineAttack (vertical autoaim; used for melee and the BFG spray only)
    pub fn aim_line_attack(&mut self, t1: u32, angle: Angle, distance: Fixed) -> Fixed {
        let an = fine(angle);
        let (x, y, z, h) = {
            let m = self.mo(t1);
            (m.x, m.y, m.z, m.height)
        };
        self.sc.shootthing = t1;
        let x2 = x.wrapping_add((distance >> FRACBITS).wrapping_mul(finecosine(an)));
        let y2 = y.wrapping_add((distance >> FRACBITS).wrapping_mul(finesine(an)));
        self.sc.shootz = z + (h >> 1) + 8 * FRACUNIT;
        self.sc.topslope = 100 * FRACUNIT / 160;
        self.sc.bottomslope = -100 * FRACUNIT / 160;
        self.sc.attackrange = distance;
        self.sc.linetarget = MRef::NULL;
        let mut list = std::mem::take(&mut self.sc.intercepts);
        if self.path_traverse_collect(x, y, x2, y2, PT_ADDLINES | PT_ADDTHINGS, &mut list) {
            while let Some(i) = World::next_intercept(&mut list, FRACUNIT) {
                if !self.aim_traverse(&i) {
                    break;
                }
            }
        }
        list.clear();
        self.sc.intercepts = list;
        if !self.sc.linetarget.is_null() {
            self.sc.aimslope
        } else {
            0
        }
    }

    /// P_LineAttack
    pub fn line_attack(&mut self, t1: u32, angle: Angle, distance: Fixed, slope: Fixed, damage: i32, mod_: i32) {
        let an = fine(angle);
        let (x, y, z, h) = {
            let m = self.mo(t1);
            (m.x, m.y, m.z, m.height)
        };
        self.sc.shootthing = t1;
        self.sc.la_damage = damage;
        self.sc.la_mod = mod_;
        let x2 = x.wrapping_add((distance >> FRACBITS).wrapping_mul(finecosine(an)));
        let y2 = y.wrapping_add((distance >> FRACBITS).wrapping_mul(finesine(an)));
        self.sc.shootz = z + (h >> 1) + 8 * FRACUNIT;
        self.sc.attackrange = distance;
        self.sc.aimslope = slope;
        let mut list = std::mem::take(&mut self.sc.intercepts);
        // freelook: shots can hit floors and ceilings, so track the sector the trace is in
        let mut cur = self.map.sector_at(x, y);
        if self.path_traverse_collect(x, y, x2, y2, PT_ADDLINES | PT_ADDTHINGS, &mut list) {
            let mut done = false;
            while let Some(i) = World::next_intercept(&mut list, FRACUNIT) {
                if !self.alive(t1) {
                    done = true;
                    break;
                }
                if self.shot_hits_plane(cur, i.frac) {
                    done = true;
                    break;
                }
                if !self.shoot_traverse(&i) {
                    done = true;
                    break;
                }
                if i.isaline {
                    let l = &self.map.lines[i.d as usize];
                    if l.backsector >= 0 {
                        let side = crate::maputl::point_on_line_side(self.sc.trace.x, self.sc.trace.y, l);
                        cur = if side == 0 { l.backsector as usize } else { l.frontsector as usize };
                    }
                }
            }
            if !done && self.alive(t1) {
                self.shot_hits_plane(cur, FRACUNIT);
            }
        }
        list.clear();
        self.sc.intercepts = list;
    }

    /// does the shot leave sector `sec` through its floor or ceiling before reaching `frac`
    /// along the trace? If so, puff there (not on sky) and return true.
    fn shot_hits_plane(&mut self, sec: usize, frac: Fixed) -> bool {
        let slope = self.sc.aimslope;
        if slope == 0 {
            return false;
        }
        let dist = fixed_mul(self.sc.attackrange, frac);
        let z = self.sc.shootz.wrapping_add(fixed_mul(slope, dist));
        let s = self.sectors[sec];
        let (plane, sky) = if z < s.floorheight && slope < 0 {
            (s.floorheight, false)
        } else if z > s.ceilingheight && slope > 0 {
            (s.ceilingheight, s.ceilingpic == self.map.sky_flat)
        } else {
            return false;
        };
        if sky {
            return true;
        }
        let t = fixed_div(plane - self.sc.shootz, slope);
        let f = fixed_div(t, self.sc.attackrange);
        let trace = self.sc.trace;
        let x = trace.x.wrapping_add(fixed_mul(trace.dx, f));
        let y = trace.y.wrapping_add(fixed_mul(trace.dy, f));
        let pz = if slope < 0 { plane + 2 * FRACUNIT } else { plane - 2 * FRACUNIT };
        self.spawn_puff(x, y, pz);
        true
    }

    // ------------------------------------------------------------------ use lines
    /// P_UseLines
    pub fn use_lines(&mut self, slot: usize) {
        let h = match self.deref(self.players[slot].mo) {
            Some(h) => h,
            None => return,
        };
        self.sc.usething = h;
        let (x1, y1, angle) = {
            let m = self.mo(h);
            (m.x, m.y, m.angle)
        };
        let an = fine(angle);
        let x2 = x1.wrapping_add((USERANGE >> FRACBITS) * finecosine(an));
        let y2 = y1.wrapping_add((USERANGE >> FRACBITS) * finesine(an));
        let mut list = std::mem::take(&mut self.sc.intercepts);
        if self.path_traverse_collect(x1, y1, x2, y2, PT_ADDLINES, &mut list) {
            while let Some(i) = World::next_intercept(&mut list, FRACUNIT) {
                // PTR_UseTraverse
                let li = i.d as usize;
                if self.line_special[li] == 0 {
                    self.line_opening(li);
                    if self.sc.openrange <= 0 {
                        self.start_sound(h, sfx::noway);
                        break;
                    }
                    continue;
                }
                let side = if point_on_line_side(x1, y1, &self.map.lines[li]) == 1 { 1 } else { 0 };
                self.use_special_line(h, li, side);
                break;
            }
        }
        list.clear();
        self.sc.intercepts = list;
    }

    // ------------------------------------------------------------------ radius attack
    /// P_RadiusAttack
    pub fn radius_attack(&mut self, spot: u32, source: u32, damage: i32, mod_: i32) {
        let dist = (damage + (MAXRADIUS >> FRACBITS)) << FRACBITS;
        let (sx, sy) = {
            let m = self.mo(spot);
            (m.x, m.y)
        };
        let map = self.map.clone();
        let yh = (sy.wrapping_add(dist).wrapping_sub(map.bmaporgy)) >> MAPBLOCKSHIFT;
        let yl = (sy.wrapping_sub(dist).wrapping_sub(map.bmaporgy)) >> MAPBLOCKSHIFT;
        let xh = (sx.wrapping_add(dist).wrapping_sub(map.bmaporgx)) >> MAPBLOCKSHIFT;
        let xl = (sx.wrapping_sub(dist).wrapping_sub(map.bmaporgx)) >> MAPBLOCKSHIFT;
        let mut things = Vec::new();
        for y in yl..=yh {
            for x in xl..=xh {
                things.clear();
                self.block_things(x, y, &mut things);
                for &t in &things {
                    if !self.alive(t) || !self.alive(spot) {
                        continue;
                    }
                    // PIT_RadiusAttack
                    let (flags, tx, ty, tr, ttype) = {
                        let m = self.mo(t);
                        (m.flags, m.x, m.y, m.radius, m.type_)
                    };
                    if flags & MF_SHOOTABLE == 0 {
                        continue;
                    }
                    if ttype as usize == mt::CYBORG || ttype as usize == mt::SPIDER {
                        continue;
                    }
                    let dx = (tx - sx).wrapping_abs();
                    let dy = (ty - sy).wrapping_abs();
                    let mut d = if dx > dy { dx } else { dy };
                    d = (d - tr) >> FRACBITS;
                    if d < 0 {
                        d = 0;
                    }
                    if d >= damage {
                        continue;
                    }
                    if self.check_sight(t, spot) {
                        let src = if self.alive(source) { source } else { NONE };
                        self.damage_mobj(t, spot, src, damage - d, mod_);
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------ sector change
    /// P_ChangeSector
    pub fn change_sector(&mut self, sec: usize, crunch: bool) -> bool {
        self.sc.nofit = false;
        self.sc.crushchange = crunch;
        let bb = self.map.sectors[sec].blockbox;
        let mut things = Vec::new();
        for x in bb[BOXLEFT]..=bb[BOXRIGHT] {
            for y in bb[BOXBOTTOM]..=bb[BOXTOP] {
                things.clear();
                self.block_things(x, y, &mut things);
                for &t in &things {
                    if self.alive(t) {
                        self.pit_change_sector(t);
                    }
                }
            }
        }
        self.sc.nofit
    }

    fn pit_change_sector(&mut self, t: u32) {
        if self.thing_height_clip(t) {
            return;
        }
        if !self.alive(t) {
            return;
        }
        let (health, flags) = {
            let m = self.mo(t);
            (m.health, m.flags)
        };
        if health <= 0 {
            self.set_mobj_state(t, st::GIBS as i32);
            if self.alive(t) {
                let m = self.mo_mut(t);
                m.flags &= !MF_SOLID;
                m.height = 0;
                m.radius = 0;
            }
            return;
        }
        if flags & MF_DROPPED != 0 {
            self.remove_mobj(t);
            return;
        }
        if flags & MF_SHOOTABLE == 0 {
            return;
        }
        self.sc.nofit = true;
        if self.sc.crushchange && (self.leveltime & 3) == 0 {
            self.damage_mobj(t, NONE, NONE, 10, mod_::CRUSH);
            if !self.alive(t) {
                return;
            }
            let (x, y, z, h) = {
                let m = self.mo(t);
                (m.x, m.y, m.z, m.height)
            };
            let mo = self.spawn_mobj(x, y, z + h / 2, mt::BLOOD);
            let mx = (self.p_random() - self.p_random()) << 12;
            let my = (self.p_random() - self.p_random()) << 12;
            let m = self.mo_mut(mo);
            m.momx = mx;
            m.momy = my;
        }
    }
}

pub fn missile_mod(t: usize) -> i32 {
    match t {
        x if x == mt::ROCKET => mod_::ROCKET,
        x if x == mt::PLASMA => mod_::PLASMA,
        x if x == mt::BFG => mod_::BFG,
        _ => mod_::WORLD,
    }
}
