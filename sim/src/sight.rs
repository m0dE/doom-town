// Line of sight checking (p_sight.c).
// Copyright (C) 1993-1996 by id Software, Inc.
// Port: Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.

use crate::fixed::*;
use crate::map::*;
use crate::world::*;

/// P_DivlineSide (0 front, 1 back, 2 on). Keeps vanilla's `x == node->y` quirk.
#[inline]
fn divline_side(x: Fixed, y: Fixed, node: &Divline) -> i32 {
    if node.dx == 0 {
        if x == node.x {
            return 2;
        }
        if x <= node.x {
            return (node.dy > 0) as i32;
        }
        return (node.dy < 0) as i32;
    }
    if node.dy == 0 {
        if x == node.y {
            return 2;
        }
        if y <= node.y {
            return (node.dx < 0) as i32;
        }
        return (node.dx > 0) as i32;
    }
    let dx = x.wrapping_sub(node.x);
    let dy = y.wrapping_sub(node.y);
    let left = (node.dy >> FRACBITS).wrapping_mul(dx >> FRACBITS);
    let right = (dy >> FRACBITS).wrapping_mul(node.dx >> FRACBITS);
    if right < left {
        return 0;
    }
    if left == right {
        return 2;
    }
    1
}

#[inline]
fn intercept_vector2(v2: &Divline, v1: &Divline) -> Fixed {
    let den = fixed_mul(v1.dy >> 8, v2.dx).wrapping_sub(fixed_mul(v1.dx >> 8, v2.dy));
    if den == 0 {
        return 0;
    }
    let num = fixed_mul(v1.x.wrapping_sub(v2.x) >> 8, v1.dy).wrapping_add(fixed_mul(v2.y.wrapping_sub(v1.y) >> 8, v1.dx));
    fixed_div(num, den)
}

/// Sight-trace state (p_sight.c statics), local to one P_CheckSight call.
pub struct SightTrace {
    pub sightzstart: Fixed,
    pub topslope: Fixed,
    pub bottomslope: Fixed,
    pub strace: Divline,
    pub t2x: Fixed,
    pub t2y: Fixed,
}

impl World {
    fn cross_subsector(&mut self, num: usize, s: &mut SightTrace) -> bool {
        let map = &self.map;
        let sub = &map.subsectors[num];
        let vc = self.sc.validcount;
        for i in 0..sub.numlines {
            let seg = &map.segs[(sub.firstline + i) as usize];
            let li = seg.linedef as usize;
            let line = &map.lines[li];
            if self.sc.line_valid[li] == vc {
                continue;
            }
            self.sc.line_valid[li] = vc;
            let s1 = divline_side(line.v1.x, line.v1.y, &s.strace);
            let s2 = divline_side(line.v2.x, line.v2.y, &s.strace);
            if s1 == s2 {
                continue;
            }
            let divl = Divline { x: line.v1.x, y: line.v1.y, dx: line.v2.x.wrapping_sub(line.v1.x), dy: line.v2.y.wrapping_sub(line.v1.y) };
            let s1 = divline_side(s.strace.x, s.strace.y, &divl);
            let s2 = divline_side(s.t2x, s.t2y, &divl);
            if s1 == s2 {
                continue;
            }
            if line.flags & ML_TWOSIDED == 0 || seg.backsector < 0 {
                return false;
            }
            let front = &self.sectors[seg.frontsector as usize];
            let back = &self.sectors[seg.backsector as usize];
            if front.floorheight == back.floorheight && front.ceilingheight == back.ceilingheight {
                continue;
            }
            let opentop = if front.ceilingheight < back.ceilingheight { front.ceilingheight } else { back.ceilingheight };
            let openbottom = if front.floorheight > back.floorheight { front.floorheight } else { back.floorheight };
            if openbottom >= opentop {
                return false;
            }
            let frac = intercept_vector2(&s.strace, &divl);
            if front.floorheight != back.floorheight {
                let slope = fixed_div(openbottom.wrapping_sub(s.sightzstart), frac);
                if slope > s.bottomslope {
                    s.bottomslope = slope;
                }
            }
            if front.ceilingheight != back.ceilingheight {
                let slope = fixed_div(opentop.wrapping_sub(s.sightzstart), frac);
                if slope < s.topslope {
                    s.topslope = slope;
                }
            }
            if s.topslope <= s.bottomslope {
                return false;
            }
        }
        true
    }

    fn cross_bsp_node(&mut self, bspnum: u32, s: &mut SightTrace) -> bool {
        if bspnum & NF_SUBSECTOR != 0 {
            let n = (bspnum & !NF_SUBSECTOR) as usize;
            if n >= self.map.subsectors.len() {
                return self.cross_subsector(0, s);
            }
            return self.cross_subsector(n, s);
        }
        let (dl, children) = {
            let bsp = &self.map.nodes[bspnum as usize];
            (Divline { x: bsp.x, y: bsp.y, dx: bsp.dx, dy: bsp.dy }, bsp.children)
        };
        let mut side = divline_side(s.strace.x, s.strace.y, &dl);
        if side == 2 {
            side = 0;
        }
        if !self.cross_bsp_node(children[side as usize], s) {
            return false;
        }
        if side == divline_side(s.t2x, s.t2y, &dl) {
            return true;
        }
        self.cross_bsp_node(children[(side ^ 1) as usize], s)
    }

    /// P_CheckSight
    pub fn check_sight(&mut self, t1: u32, t2: u32) -> bool {
        let (x1, y1, z1, h1, ss1) = {
            let m = self.mo(t1);
            (m.x, m.y, m.z, m.height, m.subsector)
        };
        let (x2, y2, z2, h2, ss2) = {
            let m = self.mo(t2);
            (m.x, m.y, m.z, m.height, m.subsector)
        };
        self.check_sight_pts(x1, y1, z1 + h1 - (h1 >> 2), ss1 as usize, x2, y2, z2, z2 + h2, ss2 as usize)
    }

    /// Sight from an eye point to a vertical span (used by P_CheckSight and the bots).
    #[allow(clippy::too_many_arguments)]
    pub fn check_sight_pts(&mut self, x1: Fixed, y1: Fixed, eyez: Fixed, ss1: usize, x2: Fixed, y2: Fixed, bot2: Fixed, top2: Fixed, ss2: usize) -> bool {
        let map = &self.map;
        let s1 = map.subsectors[ss1].sector as usize;
        let s2 = map.subsectors[ss2].sector as usize;
        let pnum = s1 * map.sectors.len() + s2;
        let bytenum = pnum >> 3;
        let bitnum = 1u8 << (pnum & 7);
        if bytenum < map.reject.len() && map.reject[bytenum] & bitnum != 0 {
            return false;
        }
        self.new_validcount();
        let mut s = SightTrace {
            sightzstart: eyez,
            topslope: top2.wrapping_sub(eyez),
            bottomslope: bot2.wrapping_sub(eyez),
            strace: Divline { x: x1, y: y1, dx: x2.wrapping_sub(x1), dy: y2.wrapping_sub(y1) },
            t2x: x2,
            t2y: y2,
        };
        if self.map.nodes.is_empty() {
            return self.cross_subsector(0, &mut s);
        }
        let root = (self.map.nodes.len() - 1) as u32;
        self.cross_bsp_node(root, &mut s)
    }
}
