// Door animation code (p_doors.c).
// Copyright (C) 1993-1996 by id Software, Inc.
// Port: Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.
//
// Deathmatch: keys are not needed, locked doors open for anyone.

use super::{MoveResult, SThinker};
use crate::fixed::*;
use crate::info::*;
use crate::world::*;

pub const VDOORSPEED: Fixed = FRACUNIT * 2;
pub const VDOORWAIT: i32 = 150;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DoorType {
    Normal,
    Close30ThenOpen,
    Close,
    Open,
    RaiseIn5Mins,
    BlazeRaise,
    BlazeOpen,
    BlazeClose,
}

#[derive(Clone, Debug)]
pub struct Door {
    pub type_: DoorType,
    pub sector: u32,
    pub topheight: Fixed,
    pub speed: Fixed,
    pub direction: i32,
    pub topwait: i32,
    pub topcountdown: i32,
}

impl World {
    fn door(&mut self, h: u32) -> &mut Door {
        match self.sthinkers[h as usize].as_mut() {
            Some(SThinker::Door(d)) => d,
            _ => panic!("not a door"),
        }
    }

    /// T_VerticalDoor
    pub fn t_vertical_door(&mut self, h: u32) {
        let d = self.door(h).clone();
        let sec = d.sector as usize;
        match d.direction {
            0 => {
                let dd = self.door(h);
                dd.topcountdown -= 1;
                if dd.topcountdown == 0 {
                    match d.type_ {
                        DoorType::BlazeRaise => {
                            self.door(h).direction = -1;
                            self.sector_sound(sec, sfx::bdcls);
                        }
                        DoorType::Normal => {
                            self.door(h).direction = -1;
                            self.sector_sound(sec, sfx::dorcls);
                        }
                        DoorType::Close30ThenOpen => {
                            self.door(h).direction = 1;
                            self.sector_sound(sec, sfx::doropn);
                        }
                        _ => {}
                    }
                }
            }
            2 => {
                let dd = self.door(h);
                dd.topcountdown -= 1;
                if dd.topcountdown == 0 && d.type_ == DoorType::RaiseIn5Mins {
                    dd.direction = 1;
                    dd.type_ = DoorType::Normal;
                    self.sector_sound(sec, sfx::doropn);
                }
            }
            -1 => {
                let floor = self.sectors[sec].floorheight;
                let res = self.move_plane(sec, d.speed, floor, false, 1, d.direction);
                if res == MoveResult::PastDest {
                    match d.type_ {
                        DoorType::BlazeRaise | DoorType::BlazeClose => {
                            self.sectors[sec].specialdata = NONE;
                            self.remove_sthinker(h);
                            self.sector_sound(sec, sfx::bdcls);
                        }
                        DoorType::Normal | DoorType::Close => {
                            self.sectors[sec].specialdata = NONE;
                            self.remove_sthinker(h);
                        }
                        DoorType::Close30ThenOpen => {
                            let dd = self.door(h);
                            dd.direction = 0;
                            dd.topcountdown = 35 * 30;
                        }
                        _ => {}
                    }
                } else if res == MoveResult::Crushed {
                    match d.type_ {
                        DoorType::BlazeClose | DoorType::Close => {}
                        _ => {
                            self.door(h).direction = 1;
                            self.sector_sound(sec, sfx::doropn);
                        }
                    }
                }
            }
            1 => {
                let res = self.move_plane(sec, d.speed, d.topheight, false, 1, d.direction);
                if res == MoveResult::PastDest {
                    match d.type_ {
                        DoorType::BlazeRaise | DoorType::Normal => {
                            let dd = self.door(h);
                            dd.direction = 0;
                            dd.topcountdown = dd.topwait;
                        }
                        DoorType::Close30ThenOpen | DoorType::BlazeOpen | DoorType::Open => {
                            self.sectors[sec].specialdata = NONE;
                            self.remove_sthinker(h);
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    /// EV_DoDoor
    pub fn ev_do_door(&mut self, line: usize, type_: DoorType) -> bool {
        let mut rtn = false;
        for sec in self.tagged_sectors(line) {
            if self.sectors[sec].specialdata != NONE {
                continue;
            }
            rtn = true;
            let mut d = Door { type_, sector: sec as u32, topheight: 0, speed: VDOORSPEED, direction: 1, topwait: VDOORWAIT, topcountdown: 0 };
            let ceil = self.sectors[sec].ceilingheight;
            match type_ {
                DoorType::BlazeClose => {
                    d.topheight = self.find_lowest_ceiling_surrounding(sec) - 4 * FRACUNIT;
                    d.direction = -1;
                    d.speed = VDOORSPEED * 4;
                    self.sector_sound(sec, sfx::bdcls);
                }
                DoorType::Close => {
                    d.topheight = self.find_lowest_ceiling_surrounding(sec) - 4 * FRACUNIT;
                    d.direction = -1;
                    self.sector_sound(sec, sfx::dorcls);
                }
                DoorType::Close30ThenOpen => {
                    d.topheight = ceil;
                    d.direction = -1;
                    self.sector_sound(sec, sfx::dorcls);
                }
                DoorType::BlazeRaise | DoorType::BlazeOpen => {
                    d.direction = 1;
                    d.topheight = self.find_lowest_ceiling_surrounding(sec) - 4 * FRACUNIT;
                    d.speed = VDOORSPEED * 4;
                    if d.topheight != ceil {
                        self.sector_sound(sec, sfx::bdopn);
                    }
                }
                DoorType::Normal | DoorType::Open => {
                    d.direction = 1;
                    d.topheight = self.find_lowest_ceiling_surrounding(sec) - 4 * FRACUNIT;
                    if d.topheight != ceil {
                        self.sector_sound(sec, sfx::doropn);
                    }
                }
                _ => {}
            }
            let h = self.alloc_sthinker(SThinker::Door(d));
            self.sectors[sec].specialdata = h;
        }
        rtn
    }

    /// EV_VerticalDoor (manual doors, keys not required)
    pub fn ev_vertical_door(&mut self, line: usize, thing: u32) {
        let l = &self.map.lines[line];
        if l.sidenum[1] < 0 {
            return;
        }
        let sec = self.map.sides[l.sidenum[1] as usize].sector as usize;
        let special = self.line_special[line];
        let is_player = self.player_of(thing).is_some();
        let sd = self.sectors[sec].specialdata;
        if sd != NONE {
            if let Some(SThinker::Door(_)) = self.sthinkers[sd as usize] {
                match special {
                    1 | 26 | 27 | 28 | 117 => {
                        let dd = self.door(sd);
                        if dd.direction == -1 {
                            dd.direction = 1;
                        } else {
                            if !is_player {
                                return;
                            }
                            dd.direction = -1;
                        }
                        return;
                    }
                    _ => {}
                }
            }
            // another kind of thinker owns the sector (vanilla would corrupt it): do nothing
            return;
        }
        match special {
            117 | 118 => self.sector_sound(sec, sfx::bdopn),
            _ => self.sector_sound(sec, sfx::doropn),
        }
        let mut d = Door { type_: DoorType::Normal, sector: sec as u32, topheight: 0, speed: VDOORSPEED, direction: 1, topwait: VDOORWAIT, topcountdown: 0 };
        match special {
            1 | 26 | 27 | 28 => d.type_ = DoorType::Normal,
            31..=34 => {
                d.type_ = DoorType::Open;
                self.line_special[line] = 0;
            }
            117 => {
                d.type_ = DoorType::BlazeRaise;
                d.speed = VDOORSPEED * 4;
            }
            118 => {
                d.type_ = DoorType::BlazeOpen;
                self.line_special[line] = 0;
                d.speed = VDOORSPEED * 4;
            }
            _ => {}
        }
        d.topheight = self.find_lowest_ceiling_surrounding(sec) - 4 * FRACUNIT;
        let h = self.alloc_sthinker(SThinker::Door(d));
        self.sectors[sec].specialdata = h;
    }

    /// P_SpawnDoorCloseIn30
    pub fn spawn_door_close_in_30(&mut self, sec: usize) {
        let d = Door { type_: DoorType::Normal, sector: sec as u32, topheight: 0, speed: VDOORSPEED, direction: 0, topwait: 0, topcountdown: 30 * 35 };
        let h = self.alloc_sthinker(SThinker::Door(d));
        self.sectors[sec].specialdata = h;
        self.sectors[sec].special = 0;
    }

    /// P_SpawnDoorRaiseIn5Mins
    pub fn spawn_door_raise_in_5_mins(&mut self, sec: usize) {
        let top = self.find_lowest_ceiling_surrounding(sec) - 4 * FRACUNIT;
        let d = Door { type_: DoorType::RaiseIn5Mins, sector: sec as u32, topheight: top, speed: VDOORSPEED, direction: 2, topwait: VDOORWAIT, topcountdown: 5 * 60 * 35 };
        let h = self.alloc_sthinker(SThinker::Door(d));
        self.sectors[sec].specialdata = h;
        self.sectors[sec].special = 0;
    }
}
