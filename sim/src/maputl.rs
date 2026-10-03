// Movement/collision utility functions (p_maputl.c).
// Copyright (C) 1993-1996 by id Software, Inc.
// Port: Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.

use crate::fixed::*;
use crate::info::*;
use crate::map::*;
use crate::world::*;

pub const PT_ADDLINES: i32 = 1;
pub const PT_ADDTHINGS: i32 = 2;
pub const PT_EARLYOUT: i32 = 4;

/// P_PointOnLineSide
#[inline]
pub fn point_on_line_side(x: Fixed, y: Fixed, line: &Line) -> i32 {
    if line.dx == 0 {
        if x <= line.v1.x {
            return (line.dy > 0) as i32;
        }
        return (line.dy < 0) as i32;
    }
    if line.dy == 0 {
        if y <= line.v1.y {
            return (line.dx < 0) as i32;
        }
        return (line.dx > 0) as i32;
    }
    let dx = x.wrapping_sub(line.v1.x);
    let dy = y.wrapping_sub(line.v1.y);
    let left = fixed_mul(line.dy >> FRACBITS, dx);
    let right = fixed_mul(dy, line.dx >> FRACBITS);
    if right < left {
        0
    } else {
        1
    }
}

/// P_BoxOnLineSide
pub fn box_on_line_side(tmbox: &[Fixed; 4], ld: &Line) -> i32 {
    let (p1, p2);
    match ld.slopetype {
        ST_HORIZONTAL => {
            let mut a = (tmbox[BOXTOP] > ld.v1.y) as i32;
            let mut b = (tmbox[BOXBOTTOM] > ld.v1.y) as i32;
            if ld.dx < 0 {
                a ^= 1;
                b ^= 1;
            }
            p1 = a;
            p2 = b;
        }
        ST_VERTICAL => {
            let mut a = (tmbox[BOXRIGHT] < ld.v1.x) as i32;
            let mut b = (tmbox[BOXLEFT] < ld.v1.x) as i32;
            if ld.dy < 0 {
                a ^= 1;
                b ^= 1;
            }
            p1 = a;
            p2 = b;
        }
        ST_POSITIVE => {
            p1 = point_on_line_side(tmbox[BOXLEFT], tmbox[BOXTOP], ld);
            p2 = point_on_line_side(tmbox[BOXRIGHT], tmbox[BOXBOTTOM], ld);
        }
        _ => {
            p1 = point_on_line_side(tmbox[BOXRIGHT], tmbox[BOXTOP], ld);
            p2 = point_on_line_side(tmbox[BOXLEFT], tmbox[BOXBOTTOM], ld);
        }
    }
    if p1 == p2 {
        p1
    } else {
        -1
    }
}

/// P_PointOnDivlineSide
#[inline]
pub fn point_on_divline_side(x: Fixed, y: Fixed, line: &Divline) -> i32 {
    if line.dx == 0 {
        if x <= line.x {
            return (line.dy > 0) as i32;
        }
        return (line.dy < 0) as i32;
    }
    if line.dy == 0 {
        if y <= line.y {
            return (line.dx < 0) as i32;
        }
        return (line.dx > 0) as i32;
    }
    let dx = x.wrapping_sub(line.x);
    let dy = y.wrapping_sub(line.y);
    if ((line.dy ^ line.dx ^ dx ^ dy) as u32) & 0x8000_0000 != 0 {
        if ((line.dy ^ dx) as u32) & 0x8000_0000 != 0 {
            return 1;
        }
        return 0;
    }
    let left = fixed_mul(line.dy >> 8, dx >> 8);
    let right = fixed_mul(dy >> 8, line.dx >> 8);
    if right < left {
        0
    } else {
        1
    }
}

#[inline]
pub fn make_divline(li: &Line) -> Divline {
    Divline { x: li.v1.x, y: li.v1.y, dx: li.dx, dy: li.dy }
}

/// P_InterceptVector
#[inline]
pub fn intercept_vector(v2: &Divline, v1: &Divline) -> Fixed {
    let den = fixed_mul(v1.dy >> 8, v2.dx).wrapping_sub(fixed_mul(v1.dx >> 8, v2.dy));
    if den == 0 {
        return 0;
    }
    let num = fixed_mul(v1.x.wrapping_sub(v2.x) >> 8, v1.dy).wrapping_add(fixed_mul(v2.y.wrapping_sub(v1.y) >> 8, v1.dx));
    fixed_div(num, den)
}

impl World {
    /// P_LineOpening
    pub fn line_opening(&mut self, li: usize) {
        let line = &self.map.lines[li];
        if line.sidenum[1] == -1 || line.backsector < 0 {
            self.sc.openrange = 0;
            return;
        }
        let front = &self.sectors[line.frontsector as usize];
        let back = &self.sectors[line.backsector as usize];
        self.sc.opentop = if front.ceilingheight < back.ceilingheight { front.ceilingheight } else { back.ceilingheight };
        if front.floorheight > back.floorheight {
            self.sc.openbottom = front.floorheight;
            self.sc.lowfloor = back.floorheight;
        } else {
            self.sc.openbottom = back.floorheight;
            self.sc.lowfloor = front.floorheight;
        }
        self.sc.openrange = self.sc.opentop.wrapping_sub(self.sc.openbottom);
    }

    /// P_UnsetThingPosition
    pub fn unset_thing_position(&mut self, h: u32) {
        let (flags, snext, sprev, bnext, bprev, ss, x, y) = {
            let m = self.mo(h);
            (m.flags, m.snext, m.sprev, m.bnext, m.bprev, m.subsector, m.x, m.y)
        };
        if flags & MF_NOSECTOR == 0 {
            if snext != NONE {
                self.mo_mut(snext).sprev = sprev;
            }
            if sprev != NONE {
                self.mo_mut(sprev).snext = snext;
            } else {
                let sec = self.map.subsectors[ss as usize].sector as usize;
                self.sectors[sec].thinglist = snext;
            }
        }
        if flags & MF_NOBLOCKMAP == 0 {
            if bnext != NONE {
                self.mo_mut(bnext).bprev = bprev;
            }
            if bprev != NONE {
                self.mo_mut(bprev).bnext = bnext;
            } else {
                let bx = x.wrapping_sub(self.map.bmaporgx) >> MAPBLOCKSHIFT;
                let by = y.wrapping_sub(self.map.bmaporgy) >> MAPBLOCKSHIFT;
                if bx >= 0 && bx < self.map.bmapwidth && by >= 0 && by < self.map.bmapheight {
                    let idx = (by * self.map.bmapwidth + bx) as usize;
                    // only unlink if we really are the head (guards against corrupt links)
                    if self.blocklinks[idx] == h {
                        self.blocklinks[idx] = bnext;
                    }
                }
            }
        }
    }

    /// P_SetThingPosition
    pub fn set_thing_position(&mut self, h: u32) {
        let (x, y, flags) = {
            let m = self.mo(h);
            (m.x, m.y, m.flags)
        };
        let ss = self.map.point_in_subsector(x, y) as u32;
        self.mo_mut(h).subsector = ss;
        if flags & MF_NOSECTOR == 0 {
            let sec = self.map.subsectors[ss as usize].sector as usize;
            let head = self.sectors[sec].thinglist;
            {
                let m = self.mo_mut(h);
                m.sprev = NONE;
                m.snext = head;
            }
            if head != NONE {
                self.mo_mut(head).sprev = h;
            }
            self.sectors[sec].thinglist = h;
        }
        if flags & MF_NOBLOCKMAP == 0 {
            let bx = x.wrapping_sub(self.map.bmaporgx) >> MAPBLOCKSHIFT;
            let by = y.wrapping_sub(self.map.bmaporgy) >> MAPBLOCKSHIFT;
            if bx >= 0 && bx < self.map.bmapwidth && by >= 0 && by < self.map.bmapheight {
                let idx = (by * self.map.bmapwidth + bx) as usize;
                let head = self.blocklinks[idx];
                {
                    let m = self.mo_mut(h);
                    m.bprev = NONE;
                    m.bnext = head;
                }
                if head != NONE {
                    self.mo_mut(head).bprev = h;
                }
                self.blocklinks[idx] = h;
            } else {
                let m = self.mo_mut(h);
                m.bnext = NONE;
                m.bprev = NONE;
            }
        }
    }

    /// collect the things linked in a block (callers iterate the snapshot, so callbacks
    /// may freely spawn/remove mobjs)
    pub fn block_things(&self, bx: i32, by: i32, out: &mut Vec<u32>) {
        if bx < 0 || by < 0 || bx >= self.map.bmapwidth || by >= self.map.bmapheight {
            return;
        }
        let mut h = self.blocklinks[(by * self.map.bmapwidth + bx) as usize];
        let mut guard = self.mobjs.len();
        while h != NONE && guard > 0 {
            out.push(h);
            h = self.mo(h).bnext;
            guard -= 1;
        }
    }

    /// lines of a block not yet visited in this validcount pass (marks them)
    pub fn block_lines(&mut self, bx: i32, by: i32, out: &mut Vec<u32>) {
        if bx < 0 || by < 0 || bx >= self.map.bmapwidth || by >= self.map.bmapheight {
            return;
        }
        let map = &self.map;
        let vc = self.sc.validcount;
        for &l in &map.blocklines[(by * map.bmapwidth + bx) as usize] {
            let lv = &mut self.sc.line_valid[l as usize];
            if *lv == vc {
                continue;
            }
            *lv = vc;
            out.push(l);
        }
    }

    #[inline]
    pub fn new_validcount(&mut self) {
        self.sc.validcount = self.sc.validcount.wrapping_add(1);
    }

    /// P_PathTraverse. Collects intercepts; the caller runs the traverser over the
    /// returned, sorted-on-demand list (see `traverse_intercepts`). Returns false if an
    /// early-out line was hit.
    pub fn path_traverse_collect(&mut self, mut x1: Fixed, mut y1: Fixed, mut x2: Fixed, mut y2: Fixed, flags: i32, out: &mut Vec<Intercept>) -> bool {
        self.sc.earlyout = flags & PT_EARLYOUT != 0;
        self.new_validcount();
        out.clear();
        let map = self.map.clone();
        if (x1.wrapping_sub(map.bmaporgx) & (MAPBLOCKSIZE - 1)) == 0 {
            x1 = x1.wrapping_add(FRACUNIT);
        }
        if (y1.wrapping_sub(map.bmaporgy) & (MAPBLOCKSIZE - 1)) == 0 {
            y1 = y1.wrapping_add(FRACUNIT);
        }
        let trace = Divline { x: x1, y: y1, dx: x2.wrapping_sub(x1), dy: y2.wrapping_sub(y1) };
        self.sc.trace = trace;
        x1 = x1.wrapping_sub(map.bmaporgx);
        y1 = y1.wrapping_sub(map.bmaporgy);
        let xt1 = x1 >> MAPBLOCKSHIFT;
        let yt1 = y1 >> MAPBLOCKSHIFT;
        x2 = x2.wrapping_sub(map.bmaporgx);
        y2 = y2.wrapping_sub(map.bmaporgy);
        let xt2 = x2 >> MAPBLOCKSHIFT;
        let yt2 = y2 >> MAPBLOCKSHIFT;
        let (mapxstep, ystep, mut partial);
        if xt2 > xt1 {
            mapxstep = 1;
            partial = FRACUNIT - ((x1 >> MAPBTOFRAC) & (FRACUNIT - 1));
            ystep = fixed_div(y2.wrapping_sub(y1), x2.wrapping_sub(x1).wrapping_abs());
        } else if xt2 < xt1 {
            mapxstep = -1;
            partial = (x1 >> MAPBTOFRAC) & (FRACUNIT - 1);
            ystep = fixed_div(y2.wrapping_sub(y1), x2.wrapping_sub(x1).wrapping_abs());
        } else {
            mapxstep = 0;
            partial = FRACUNIT;
            ystep = 256 * FRACUNIT;
        }
        let mut yintercept = (y1 >> MAPBTOFRAC).wrapping_add(fixed_mul(partial, ystep));
        let (mapystep, xstep);
        if yt2 > yt1 {
            mapystep = 1;
            partial = FRACUNIT - ((y1 >> MAPBTOFRAC) & (FRACUNIT - 1));
            xstep = fixed_div(x2.wrapping_sub(x1), y2.wrapping_sub(y1).wrapping_abs());
        } else if yt2 < yt1 {
            mapystep = -1;
            partial = (y1 >> MAPBTOFRAC) & (FRACUNIT - 1);
            xstep = fixed_div(x2.wrapping_sub(x1), y2.wrapping_sub(y1).wrapping_abs());
        } else {
            mapystep = 0;
            partial = FRACUNIT;
            xstep = 256 * FRACUNIT;
        }
        let mut xintercept = (x1 >> MAPBTOFRAC).wrapping_add(fixed_mul(partial, xstep));
        let mut mapx = xt1;
        let mut mapy = yt1;
        let mut lines = Vec::new();
        let mut things = std::mem::take(&mut self.sc.thingbuf);
        for _count in 0..64 {
            if flags & PT_ADDLINES != 0 {
                lines.clear();
                self.block_lines(mapx, mapy, &mut lines);
                for &l in &lines {
                    if !self.add_line_intercept(l, &trace, out) {
                        self.sc.thingbuf = things;
                        return false;
                    }
                }
            }
            if flags & PT_ADDTHINGS != 0 {
                things.clear();
                self.block_things(mapx, mapy, &mut things);
                for &t in &things {
                    self.add_thing_intercept(t, &trace, out);
                }
            }
            if mapx == xt2 && mapy == yt2 {
                break;
            }
            if (yintercept >> FRACBITS) == mapy {
                yintercept = yintercept.wrapping_add(ystep);
                mapx += mapxstep;
            } else if (xintercept >> FRACBITS) == mapx {
                xintercept = xintercept.wrapping_add(xstep);
                mapy += mapystep;
            }
        }
        things.clear();
        self.sc.thingbuf = things;
        true
    }

    /// PIT_AddLineIntercepts
    fn add_line_intercept(&self, l: u32, trace: &Divline, out: &mut Vec<Intercept>) -> bool {
        let ld = &self.map.lines[l as usize];
        let (s1, s2);
        if trace.dx > FRACUNIT * 16 || trace.dy > FRACUNIT * 16 || trace.dx < -FRACUNIT * 16 || trace.dy < -FRACUNIT * 16 {
            s1 = point_on_divline_side(ld.v1.x, ld.v1.y, trace);
            s2 = point_on_divline_side(ld.v2.x, ld.v2.y, trace);
        } else {
            s1 = point_on_line_side(trace.x, trace.y, ld);
            s2 = point_on_line_side(trace.x.wrapping_add(trace.dx), trace.y.wrapping_add(trace.dy), ld);
        }
        if s1 == s2 {
            return true;
        }
        let dl = make_divline(ld);
        let frac = intercept_vector(trace, &dl);
        if frac < 0 {
            return true;
        }
        if self.sc.earlyout && frac < FRACUNIT && ld.backsector < 0 {
            return false;
        }
        out.push(Intercept { frac, isaline: true, d: l, id: 0 });
        true
    }

    /// PIT_AddThingIntercepts
    fn add_thing_intercept(&self, h: u32, trace: &Divline, out: &mut Vec<Intercept>) {
        let t = self.mo(h);
        let tracepositive = (trace.dx ^ trace.dy) > 0;
        let (x1, y1, x2, y2);
        if tracepositive {
            x1 = t.x - t.radius;
            y1 = t.y + t.radius;
            x2 = t.x + t.radius;
            y2 = t.y - t.radius;
        } else {
            x1 = t.x - t.radius;
            y1 = t.y - t.radius;
            x2 = t.x + t.radius;
            y2 = t.y + t.radius;
        }
        let s1 = point_on_divline_side(x1, y1, trace);
        let s2 = point_on_divline_side(x2, y2, trace);
        if s1 == s2 {
            return;
        }
        let dl = Divline { x: x1, y: y1, dx: x2 - x1, dy: y2 - y1 };
        let frac = intercept_vector(trace, &dl);
        if frac < 0 {
            return;
        }
        out.push(Intercept { frac, isaline: false, d: h, id: t.id });
    }

    /// P_TraverseIntercepts: pops the nearest intercept each call. Returns None when done
    /// (or beyond maxfrac).
    pub fn next_intercept(list: &mut [Intercept], maxfrac: Fixed) -> Option<Intercept> {
        let mut dist = i32::MAX;
        let mut idx = usize::MAX;
        for (i, s) in list.iter().enumerate() {
            if s.frac < dist {
                dist = s.frac;
                idx = i;
            }
        }
        if idx == usize::MAX || dist > maxfrac {
            return None;
        }
        let r = list[idx];
        list[idx].frac = i32::MAX;
        Some(r)
    }
}
