// Ceiling animation (lowering, crushing, raising) (p_ceilng.c).
// Copyright (C) 1993-1996 by id Software, Inc.
// Port: Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.

use super::{MoveResult, SThinker};
use crate::fixed::*;
use crate::info::*;
use crate::world::*;

pub const CEILSPEED: Fixed = FRACUNIT;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CeilingType {
    LowerToFloor,
    RaiseToHighest,
    LowerAndCrush,
    CrushAndRaise,
    FastCrushAndRaise,
    SilentCrushAndRaise,
}

#[derive(Clone, Debug)]
pub struct Ceiling {
    pub type_: CeilingType,
    pub sector: u32,
    pub bottomheight: Fixed,
    pub topheight: Fixed,
    pub speed: Fixed,
    pub crush: bool,
    pub direction: i32,
    pub tag: i32,
    pub olddirection: i32,
}

impl World {
    fn ceil(&mut self, h: u32) -> &mut Ceiling {
        match self.sthinkers[h as usize].as_mut() {
            Some(SThinker::Ceiling(c)) => c,
            _ => panic!("not a ceiling"),
        }
    }

    /// T_MoveCeiling
    pub fn t_move_ceiling(&mut self, h: u32) {
        let c = self.ceil(h).clone();
        let sec = c.sector as usize;
        match c.direction {
            1 => {
                let res = self.move_plane(sec, c.speed, c.topheight, false, 1, c.direction);
                if (self.leveltime & 7) == 0 && c.type_ != CeilingType::SilentCrushAndRaise {
                    self.sector_sound(sec, sfx::stnmov);
                }
                if res == MoveResult::PastDest {
                    match c.type_ {
                        CeilingType::RaiseToHighest => self.remove_active_ceiling(h),
                        CeilingType::SilentCrushAndRaise => {
                            self.sector_sound(sec, sfx::pstop);
                            self.ceil(h).direction = -1;
                        }
                        CeilingType::FastCrushAndRaise | CeilingType::CrushAndRaise => self.ceil(h).direction = -1,
                        _ => {}
                    }
                }
            }
            -1 => {
                let res = self.move_plane(sec, c.speed, c.bottomheight, c.crush, 1, c.direction);
                if (self.leveltime & 7) == 0 && c.type_ != CeilingType::SilentCrushAndRaise {
                    self.sector_sound(sec, sfx::stnmov);
                }
                if res == MoveResult::PastDest {
                    match c.type_ {
                        CeilingType::SilentCrushAndRaise => {
                            self.sector_sound(sec, sfx::pstop);
                            let cc = self.ceil(h);
                            cc.speed = CEILSPEED;
                            cc.direction = 1;
                        }
                        CeilingType::CrushAndRaise => {
                            let cc = self.ceil(h);
                            cc.speed = CEILSPEED;
                            cc.direction = 1;
                        }
                        CeilingType::FastCrushAndRaise => self.ceil(h).direction = 1,
                        CeilingType::LowerAndCrush | CeilingType::LowerToFloor => self.remove_active_ceiling(h),
                        _ => {}
                    }
                } else if res == MoveResult::Crushed {
                    match c.type_ {
                        CeilingType::SilentCrushAndRaise | CeilingType::CrushAndRaise | CeilingType::LowerAndCrush => self.ceil(h).speed = CEILSPEED / 8,
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    /// EV_DoCeiling
    pub fn ev_do_ceiling(&mut self, line: usize, type_: CeilingType) -> bool {
        let mut rtn = false;
        if matches!(type_, CeilingType::FastCrushAndRaise | CeilingType::SilentCrushAndRaise | CeilingType::CrushAndRaise) {
            self.activate_in_stasis_ceiling(line);
        }
        for sec in self.tagged_sectors(line) {
            if self.sectors[sec].specialdata != NONE {
                continue;
            }
            rtn = true;
            let floor = self.sectors[sec].floorheight;
            let ceil = self.sectors[sec].ceilingheight;
            let mut c = Ceiling { type_, sector: sec as u32, bottomheight: 0, topheight: 0, speed: CEILSPEED, crush: false, direction: 0, tag: self.map.sectors[sec].tag, olddirection: 0 };
            match type_ {
                CeilingType::FastCrushAndRaise => {
                    c.crush = true;
                    c.topheight = ceil;
                    c.bottomheight = floor + 8 * FRACUNIT;
                    c.direction = -1;
                    c.speed = CEILSPEED * 2;
                }
                CeilingType::SilentCrushAndRaise | CeilingType::CrushAndRaise | CeilingType::LowerAndCrush | CeilingType::LowerToFloor => {
                    if matches!(type_, CeilingType::SilentCrushAndRaise | CeilingType::CrushAndRaise) {
                        c.crush = true;
                        c.topheight = ceil;
                    }
                    c.bottomheight = floor;
                    if type_ != CeilingType::LowerToFloor {
                        c.bottomheight += 8 * FRACUNIT;
                    }
                    c.direction = -1;
                    c.speed = CEILSPEED;
                }
                CeilingType::RaiseToHighest => {
                    c.topheight = self.find_highest_ceiling_surrounding(sec);
                    c.direction = 1;
                    c.speed = CEILSPEED;
                }
            }
            let h = self.alloc_sthinker(SThinker::Ceiling(c));
            self.sectors[sec].specialdata = h;
            self.activeceilings.push(h);
        }
        rtn
    }

    pub fn remove_active_ceiling(&mut self, h: u32) {
        if let Some(i) = self.activeceilings.iter().position(|&x| x == h) {
            let sec = self.ceil(h).sector as usize;
            self.sectors[sec].specialdata = NONE;
            self.remove_sthinker(h);
            self.activeceilings.remove(i);
        }
    }

    pub fn activate_in_stasis_ceiling(&mut self, line: usize) {
        let tag = self.map.lines[line].tag;
        for i in 0..self.activeceilings.len() {
            let h = self.activeceilings[i];
            let c = self.ceil(h);
            if c.tag == tag && c.direction == 0 {
                c.direction = c.olddirection;
            }
        }
    }

    pub fn ev_ceiling_crush_stop(&mut self, line: usize) -> bool {
        let tag = self.map.lines[line].tag;
        let mut rtn = false;
        for i in 0..self.activeceilings.len() {
            let h = self.activeceilings[i];
            let c = self.ceil(h);
            if c.tag == tag && c.direction != 0 {
                c.olddirection = c.direction;
                c.direction = 0;
                rtn = true;
            }
        }
        rtn
    }
}
