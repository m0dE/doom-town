// Plats (i.e. elevator platforms) code, raising/lowering (p_plats.c).
// Copyright (C) 1993-1996 by id Software, Inc.
// Port: Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.

use super::{MoveResult, SThinker};
use crate::fixed::*;
use crate::info::*;
use crate::world::*;

pub const PLATWAIT: i32 = 3;
pub const PLATSPEED: Fixed = FRACUNIT;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlatType {
    PerpetualRaise,
    DownWaitUpStay,
    RaiseAndChange,
    RaiseToNearestAndChange,
    BlazeDWUS,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlatStatus {
    Up,
    Down,
    Waiting,
    InStasis,
}

#[derive(Clone, Debug)]
pub struct Plat {
    pub sector: u32,
    pub speed: Fixed,
    pub low: Fixed,
    pub high: Fixed,
    pub wait: i32,
    pub count: i32,
    pub status: PlatStatus,
    pub oldstatus: PlatStatus,
    pub crush: bool,
    pub tag: i32,
    pub type_: PlatType,
}

impl World {
    fn plat(&mut self, h: u32) -> &mut Plat {
        match self.sthinkers[h as usize].as_mut() {
            Some(SThinker::Plat(p)) => p,
            _ => panic!("not a plat"),
        }
    }

    /// T_PlatRaise
    pub fn t_plat_raise(&mut self, h: u32) {
        let p = self.plat(h).clone();
        let sec = p.sector as usize;
        match p.status {
            PlatStatus::Up => {
                let res = self.move_plane(sec, p.speed, p.high, p.crush, 0, 1);
                if (p.type_ == PlatType::RaiseAndChange || p.type_ == PlatType::RaiseToNearestAndChange) && (self.leveltime & 7) == 0 {
                    self.sector_sound(sec, sfx::stnmov);
                }
                if res == MoveResult::Crushed && !p.crush {
                    let pp = self.plat(h);
                    pp.count = pp.wait;
                    pp.status = PlatStatus::Down;
                    self.sector_sound(sec, sfx::pstart);
                } else if res == MoveResult::PastDest {
                    let pp = self.plat(h);
                    pp.count = pp.wait;
                    pp.status = PlatStatus::Waiting;
                    self.sector_sound(sec, sfx::pstop);
                    match p.type_ {
                        PlatType::BlazeDWUS | PlatType::DownWaitUpStay | PlatType::RaiseAndChange | PlatType::RaiseToNearestAndChange => self.remove_active_plat(h),
                        _ => {}
                    }
                }
            }
            PlatStatus::Down => {
                let res = self.move_plane(sec, p.speed, p.low, false, 0, -1);
                if res == MoveResult::PastDest {
                    let pp = self.plat(h);
                    pp.count = pp.wait;
                    pp.status = PlatStatus::Waiting;
                    self.sector_sound(sec, sfx::pstop);
                }
            }
            PlatStatus::Waiting => {
                let pp = self.plat(h);
                pp.count -= 1;
                if pp.count == 0 {
                    let floor = self.sectors[sec].floorheight;
                    let pp = self.plat(h);
                    pp.status = if floor == pp.low { PlatStatus::Up } else { PlatStatus::Down };
                    self.sector_sound(sec, sfx::pstart);
                }
            }
            PlatStatus::InStasis => {}
        }
    }

    /// EV_DoPlat
    pub fn ev_do_plat(&mut self, line: usize, type_: PlatType, amount: i32) -> bool {
        let mut rtn = false;
        let tag = self.map.lines[line].tag;
        if type_ == PlatType::PerpetualRaise {
            self.activate_in_stasis(tag);
        }
        for sec in self.tagged_sectors(line) {
            if self.sectors[sec].specialdata != NONE {
                continue;
            }
            rtn = true;
            let mut p = Plat { sector: sec as u32, speed: 0, low: 0, high: 0, wait: 0, count: 0, status: PlatStatus::Up, oldstatus: PlatStatus::Up, crush: false, tag, type_ };
            let floor = self.sectors[sec].floorheight;
            match type_ {
                PlatType::RaiseToNearestAndChange => {
                    p.speed = PLATSPEED / 2;
                    let fs = self.map.sides[self.map.lines[line].sidenum[0] as usize].sector as usize;
                    self.sectors[sec].floorpic = self.sectors[fs].floorpic;
                    p.high = self.find_next_highest_floor(sec, floor);
                    p.wait = 0;
                    p.status = PlatStatus::Up;
                    self.sectors[sec].special = 0;
                    self.sector_sound(sec, sfx::stnmov);
                }
                PlatType::RaiseAndChange => {
                    p.speed = PLATSPEED / 2;
                    let fs = self.map.sides[self.map.lines[line].sidenum[0] as usize].sector as usize;
                    self.sectors[sec].floorpic = self.sectors[fs].floorpic;
                    p.high = floor + amount * FRACUNIT;
                    p.wait = 0;
                    p.status = PlatStatus::Up;
                    self.sector_sound(sec, sfx::stnmov);
                }
                PlatType::DownWaitUpStay | PlatType::BlazeDWUS => {
                    p.speed = if type_ == PlatType::BlazeDWUS { PLATSPEED * 8 } else { PLATSPEED * 4 };
                    p.low = self.find_lowest_floor_surrounding(sec);
                    if p.low > floor {
                        p.low = floor;
                    }
                    p.high = floor;
                    p.wait = 35 * PLATWAIT;
                    p.status = PlatStatus::Down;
                    self.sector_sound(sec, sfx::pstart);
                }
                PlatType::PerpetualRaise => {
                    p.speed = PLATSPEED;
                    p.low = self.find_lowest_floor_surrounding(sec);
                    if p.low > floor {
                        p.low = floor;
                    }
                    p.high = self.find_highest_floor_surrounding(sec);
                    if p.high < floor {
                        p.high = floor;
                    }
                    p.wait = 35 * PLATWAIT;
                    p.status = if self.p_random() & 1 != 0 { PlatStatus::Down } else { PlatStatus::Up };
                    self.sector_sound(sec, sfx::pstart);
                }
            }
            let h = self.alloc_sthinker(SThinker::Plat(p));
            self.sectors[sec].specialdata = h;
            self.activeplats.push(h);
        }
        rtn
    }

    pub fn activate_in_stasis(&mut self, tag: i32) {
        for i in 0..self.activeplats.len() {
            let h = self.activeplats[i];
            let p = self.plat(h);
            if p.tag == tag && p.status == PlatStatus::InStasis {
                p.status = p.oldstatus;
            }
        }
    }

    pub fn ev_stop_plat(&mut self, line: usize) {
        let tag = self.map.lines[line].tag;
        for i in 0..self.activeplats.len() {
            let h = self.activeplats[i];
            let p = self.plat(h);
            if p.status != PlatStatus::InStasis && p.tag == tag {
                p.oldstatus = p.status;
                p.status = PlatStatus::InStasis;
            }
        }
    }

    pub fn remove_active_plat(&mut self, h: u32) {
        if let Some(i) = self.activeplats.iter().position(|&x| x == h) {
            let sec = self.plat(h).sector as usize;
            self.sectors[sec].specialdata = NONE;
            self.remove_sthinker(h);
            self.activeplats.remove(i);
        }
    }
}
