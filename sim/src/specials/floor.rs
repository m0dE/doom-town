// Floor animation: raising stairs, moving floors (p_floor.c).
// Copyright (C) 1993-1996 by id Software, Inc.
// Port: Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.

use super::{MoveResult, SThinker};
use crate::fixed::*;
use crate::info::*;
use crate::map::*;
use crate::world::*;

pub const FLOORSPEED: Fixed = FRACUNIT;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FloorType {
    LowerFloor,
    LowerFloorToLowest,
    TurboLower,
    RaiseFloor,
    RaiseFloorToNearest,
    RaiseToTexture,
    LowerAndChange,
    RaiseFloor24,
    RaiseFloor24AndChange,
    RaiseFloorCrush,
    RaiseFloorTurbo,
    DonutRaise,
    RaiseFloor512,
    Stairs,
}

#[derive(Clone, Debug)]
pub struct FloorMove {
    pub type_: FloorType,
    pub crush: bool,
    pub sector: u32,
    pub direction: i32,
    pub newspecial: i32,
    pub texture: i32,
    pub floordestheight: Fixed,
    pub speed: Fixed,
}

impl World {
    /// T_MoveFloor
    pub fn t_move_floor(&mut self, h: u32) {
        let f = match &self.sthinkers[h as usize] {
            Some(SThinker::Floor(f)) => f.clone(),
            _ => return,
        };
        let sec = f.sector as usize;
        let res = self.move_plane(sec, f.speed, f.floordestheight, f.crush, 0, f.direction);
        if (self.leveltime & 7) == 0 {
            self.sector_sound(sec, sfx::stnmov);
        }
        if res == MoveResult::PastDest {
            self.sectors[sec].specialdata = NONE;
            if f.direction == 1 {
                if f.type_ == FloorType::DonutRaise {
                    self.sectors[sec].special = f.newspecial;
                    self.sectors[sec].floorpic = f.texture;
                }
            } else if f.direction == -1 && f.type_ == FloorType::LowerAndChange {
                self.sectors[sec].special = f.newspecial;
                self.sectors[sec].floorpic = f.texture;
            }
            self.remove_sthinker(h);
            self.sector_sound(sec, sfx::pstop);
        }
    }

    /// EV_DoFloor
    pub fn ev_do_floor(&mut self, line: usize, floortype: FloorType) -> bool {
        let mut rtn = false;
        for secnum in self.tagged_sectors(line) {
            if self.sectors[secnum].specialdata != NONE {
                continue;
            }
            rtn = true;
            let fh = self.sectors[secnum].floorheight;
            let mut f = FloorMove { type_: floortype, crush: false, sector: secnum as u32, direction: 1, newspecial: 0, texture: 0, floordestheight: 0, speed: FLOORSPEED };
            match floortype {
                FloorType::LowerFloor => {
                    f.direction = -1;
                    f.floordestheight = self.find_highest_floor_surrounding(secnum);
                }
                FloorType::LowerFloorToLowest => {
                    f.direction = -1;
                    f.floordestheight = self.find_lowest_floor_surrounding(secnum);
                }
                FloorType::TurboLower => {
                    f.direction = -1;
                    f.speed = FLOORSPEED * 4;
                    f.floordestheight = self.find_highest_floor_surrounding(secnum);
                    if f.floordestheight != fh {
                        f.floordestheight += 8 * FRACUNIT;
                    }
                }
                FloorType::RaiseFloorCrush | FloorType::RaiseFloor => {
                    f.crush = floortype == FloorType::RaiseFloorCrush;
                    f.direction = 1;
                    f.floordestheight = self.find_lowest_ceiling_surrounding(secnum);
                    if f.floordestheight > self.sectors[secnum].ceilingheight {
                        f.floordestheight = self.sectors[secnum].ceilingheight;
                    }
                    if floortype == FloorType::RaiseFloorCrush {
                        f.floordestheight -= 8 * FRACUNIT;
                    }
                }
                FloorType::RaiseFloorTurbo => {
                    f.speed = FLOORSPEED * 4;
                    f.floordestheight = self.find_next_highest_floor(secnum, fh);
                }
                FloorType::RaiseFloorToNearest => {
                    f.floordestheight = self.find_next_highest_floor(secnum, fh);
                }
                FloorType::RaiseFloor24 => {
                    f.floordestheight = fh + 24 * FRACUNIT;
                }
                FloorType::RaiseFloor512 => {
                    f.floordestheight = fh + 512 * FRACUNIT;
                }
                FloorType::RaiseFloor24AndChange => {
                    f.floordestheight = fh + 24 * FRACUNIT;
                    let fs = self.map.lines[line].frontsector as usize;
                    self.sectors[secnum].floorpic = self.sectors[fs].floorpic;
                    self.sectors[secnum].special = self.sectors[fs].special;
                }
                FloorType::RaiseToTexture => {
                    // texture heights live in the IWAD's TEXTURE lumps, which the sim does not
                    // load; FreeDM never uses this special. Assume 64-unit lower textures.
                    let mut minsize = i32::MAX;
                    for &l in &self.map.sectors[secnum].lines {
                        let li = &self.map.lines[l as usize];
                        if li.flags & ML_TWOSIDED != 0 {
                            minsize = minsize.min(64 * FRACUNIT);
                        }
                    }
                    if minsize == i32::MAX {
                        minsize = 0;
                    }
                    f.floordestheight = fh.wrapping_add(minsize);
                }
                FloorType::LowerAndChange => {
                    f.direction = -1;
                    f.floordestheight = self.find_lowest_floor_surrounding(secnum);
                    f.texture = self.sectors[secnum].floorpic;
                    for &l in &self.map.sectors[secnum].lines {
                        let li = &self.map.lines[l as usize];
                        if li.flags & ML_TWOSIDED != 0 && li.backsector >= 0 {
                            let other = if li.frontsector as usize == secnum { li.backsector as usize } else { li.frontsector as usize };
                            if self.sectors[other].floorheight == f.floordestheight {
                                f.texture = self.sectors[other].floorpic;
                                f.newspecial = self.sectors[other].special;
                                break;
                            }
                        }
                    }
                }
                FloorType::DonutRaise | FloorType::Stairs => {}
            }
            let h = self.alloc_sthinker(SThinker::Floor(f));
            self.sectors[secnum].specialdata = h;
        }
        rtn
    }

    /// EV_BuildStairs
    pub fn ev_build_stairs(&mut self, line: usize, turbo16: bool) -> bool {
        let mut rtn = false;
        let (speed, stairsize) = if turbo16 { (FLOORSPEED * 4, 16 * FRACUNIT) } else { (FLOORSPEED / 4, 8 * FRACUNIT) };
        for start in self.tagged_sectors(line) {
            if self.sectors[start].specialdata != NONE {
                continue;
            }
            rtn = true;
            let mut secnum = start;
            let mut height = self.sectors[secnum].floorheight + stairsize;
            let f = FloorMove { type_: FloorType::Stairs, crush: false, sector: secnum as u32, direction: 1, newspecial: 0, texture: 0, floordestheight: height, speed };
            let h = self.alloc_sthinker(SThinker::Floor(f));
            self.sectors[secnum].specialdata = h;
            let texture = self.sectors[secnum].floorpic;
            loop {
                let mut ok = false;
                let lines = self.map.sectors[secnum].lines.clone();
                for l in lines {
                    let li = &self.map.lines[l as usize];
                    if li.flags & ML_TWOSIDED == 0 || li.backsector < 0 {
                        continue;
                    }
                    if li.frontsector as usize != secnum {
                        continue;
                    }
                    let tsec = li.backsector as usize;
                    if self.sectors[tsec].floorpic != texture {
                        continue;
                    }
                    height += stairsize;
                    if self.sectors[tsec].specialdata != NONE {
                        continue;
                    }
                    secnum = tsec;
                    let f = FloorMove { type_: FloorType::Stairs, crush: false, sector: secnum as u32, direction: 1, newspecial: 0, texture: 0, floordestheight: height, speed };
                    let h = self.alloc_sthinker(SThinker::Floor(f));
                    self.sectors[secnum].specialdata = h;
                    ok = true;
                    break;
                }
                if !ok {
                    break;
                }
            }
        }
        rtn
    }
}
