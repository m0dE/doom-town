// Line and sector specials (p_spec.c, p_switch.c, p_lights.c subset).
// Copyright (C) 1993-1996 by id Software, Inc.
// Port: Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.
//
// Deathmatch adaptations: exits do nothing, keys are not required (locked doors open for
// anyone), light-effect sector specials are not simulated (the renderer animates them),
// secret sectors are ignored.

pub mod ceiling;
pub mod doors;
pub mod floor;
pub mod plats;
pub mod telept;

use crate::fixed::*;
use crate::info::*;
use crate::map::*;
use crate::world::*;

pub use ceiling::*;
pub use doors::*;
pub use floor::*;
pub use plats::*;

#[derive(Clone, Debug)]
pub enum SThinker {
    Door(Door),
    Plat(Plat),
    Floor(FloorMove),
    Ceiling(Ceiling),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MoveResult {
    Ok,
    Crushed,
    PastDest,
}

pub const BUTTONTIME: i32 = 35;

impl World {
    pub fn run_sthinker(&mut self, h: u32) {
        let t = self.sthinkers[h as usize].clone();
        match t {
            Some(SThinker::Door(_)) => self.t_vertical_door(h),
            Some(SThinker::Plat(_)) => self.t_plat_raise(h),
            Some(SThinker::Floor(_)) => self.t_move_floor(h),
            Some(SThinker::Ceiling(_)) => self.t_move_ceiling(h),
            None => {}
        }
    }

    // ------------------------------------------------------------------ helpers
    pub fn get_next_sector(&self, line: usize, sec: usize) -> Option<usize> {
        let l = &self.map.lines[line];
        if l.flags & ML_TWOSIDED == 0 || l.backsector < 0 {
            return None;
        }
        if l.frontsector as usize == sec {
            return Some(l.backsector as usize);
        }
        Some(l.frontsector as usize)
    }

    pub fn find_lowest_floor_surrounding(&self, sec: usize) -> Fixed {
        let mut floor = self.sectors[sec].floorheight;
        for &l in &self.map.sectors[sec].lines {
            if let Some(o) = self.get_next_sector(l as usize, sec) {
                if self.sectors[o].floorheight < floor {
                    floor = self.sectors[o].floorheight;
                }
            }
        }
        floor
    }

    pub fn find_highest_floor_surrounding(&self, sec: usize) -> Fixed {
        let mut floor = -500 * FRACUNIT;
        for &l in &self.map.sectors[sec].lines {
            if let Some(o) = self.get_next_sector(l as usize, sec) {
                if self.sectors[o].floorheight > floor {
                    floor = self.sectors[o].floorheight;
                }
            }
        }
        floor
    }

    pub fn find_next_highest_floor(&self, sec: usize, currentheight: Fixed) -> Fixed {
        let mut list: Vec<Fixed> = Vec::new();
        for &l in &self.map.sectors[sec].lines {
            if let Some(o) = self.get_next_sector(l as usize, sec) {
                if self.sectors[o].floorheight > currentheight {
                    list.push(self.sectors[o].floorheight);
                }
                // vanilla overflows past 20 adjoining sectors; we stop like the fixed ports
                if list.len() >= 20 {
                    break;
                }
            }
        }
        match list.iter().min() {
            Some(&m) => m,
            None => currentheight,
        }
    }

    pub fn find_lowest_ceiling_surrounding(&self, sec: usize) -> Fixed {
        let mut height = i32::MAX;
        for &l in &self.map.sectors[sec].lines {
            if let Some(o) = self.get_next_sector(l as usize, sec) {
                if self.sectors[o].ceilingheight < height {
                    height = self.sectors[o].ceilingheight;
                }
            }
        }
        height
    }

    pub fn find_highest_ceiling_surrounding(&self, sec: usize) -> Fixed {
        let mut height = 0;
        for &l in &self.map.sectors[sec].lines {
            if let Some(o) = self.get_next_sector(l as usize, sec) {
                if self.sectors[o].ceilingheight > height {
                    height = self.sectors[o].ceilingheight;
                }
            }
        }
        height
    }

    /// P_FindSectorFromLineTag (all sectors with the line's tag, in order)
    pub fn tagged_sectors(&self, line: usize) -> Vec<usize> {
        let tag = self.map.lines[line].tag;
        (0..self.map.sectors.len()).filter(|&i| self.map.sectors[i].tag == tag).collect()
    }

    /// T_MovePlane
    pub fn move_plane(&mut self, sec: usize, speed: Fixed, dest: Fixed, crush: bool, floor_or_ceiling: i32, direction: i32) -> MoveResult {
        if floor_or_ceiling == 0 {
            match direction {
                -1 => {
                    if self.sectors[sec].floorheight - speed < dest {
                        let lastpos = self.sectors[sec].floorheight;
                        self.sectors[sec].floorheight = dest;
                        if self.change_sector(sec, crush) {
                            self.sectors[sec].floorheight = lastpos;
                            self.change_sector(sec, crush);
                        }
                        return MoveResult::PastDest;
                    } else {
                        let lastpos = self.sectors[sec].floorheight;
                        self.sectors[sec].floorheight -= speed;
                        if self.change_sector(sec, crush) {
                            self.sectors[sec].floorheight = lastpos;
                            self.change_sector(sec, crush);
                            return MoveResult::Crushed;
                        }
                    }
                }
                1 => {
                    if self.sectors[sec].floorheight + speed > dest {
                        let lastpos = self.sectors[sec].floorheight;
                        self.sectors[sec].floorheight = dest;
                        if self.change_sector(sec, crush) {
                            self.sectors[sec].floorheight = lastpos;
                            self.change_sector(sec, crush);
                        }
                        return MoveResult::PastDest;
                    } else {
                        let lastpos = self.sectors[sec].floorheight;
                        self.sectors[sec].floorheight += speed;
                        if self.change_sector(sec, crush) {
                            if crush {
                                return MoveResult::Crushed;
                            }
                            self.sectors[sec].floorheight = lastpos;
                            self.change_sector(sec, crush);
                            return MoveResult::Crushed;
                        }
                    }
                }
                _ => {}
            }
        } else {
            match direction {
                -1 => {
                    if self.sectors[sec].ceilingheight - speed < dest {
                        let lastpos = self.sectors[sec].ceilingheight;
                        self.sectors[sec].ceilingheight = dest;
                        if self.change_sector(sec, crush) {
                            self.sectors[sec].ceilingheight = lastpos;
                            self.change_sector(sec, crush);
                        }
                        return MoveResult::PastDest;
                    } else {
                        let lastpos = self.sectors[sec].ceilingheight;
                        self.sectors[sec].ceilingheight -= speed;
                        if self.change_sector(sec, crush) {
                            if crush {
                                return MoveResult::Crushed;
                            }
                            self.sectors[sec].ceilingheight = lastpos;
                            self.change_sector(sec, crush);
                            return MoveResult::Crushed;
                        }
                    }
                }
                1 => {
                    if self.sectors[sec].ceilingheight + speed > dest {
                        let lastpos = self.sectors[sec].ceilingheight;
                        self.sectors[sec].ceilingheight = dest;
                        if self.change_sector(sec, crush) {
                            self.sectors[sec].ceilingheight = lastpos;
                            self.change_sector(sec, crush);
                        }
                        return MoveResult::PastDest;
                    } else {
                        self.sectors[sec].ceilingheight += speed;
                        self.change_sector(sec, crush);
                    }
                }
                _ => {}
            }
        }
        MoveResult::Ok
    }

    // ------------------------------------------------------------------ triggers
    /// P_CrossSpecialLine
    pub fn cross_special_line(&mut self, linenum: usize, side: i32, thing: u32) {
        let is_player = self.player_of(thing).is_some();
        let special = self.line_special[linenum];
        if !is_player {
            let t = self.mo(thing).type_ as usize;
            if t == mt::ROCKET || t == mt::PLASMA || t == mt::BFG || t == mt::TROOPSHOT || t == mt::HEADSHOT || t == mt::BRUISERSHOT {
                return;
            }
            if !matches!(special, 39 | 97 | 125 | 126 | 4 | 10 | 88) {
                return;
            }
        }
        let once = |w: &mut World| w.line_special[linenum] = 0;
        match special {
            2 => {
                self.ev_do_door(linenum, DoorType::Open);
                once(self);
            }
            3 => {
                self.ev_do_door(linenum, DoorType::Close);
                once(self);
            }
            4 => {
                self.ev_do_door(linenum, DoorType::Normal);
                once(self);
            }
            5 => {
                self.ev_do_floor(linenum, FloorType::RaiseFloor);
                once(self);
            }
            6 => {
                self.ev_do_ceiling(linenum, CeilingType::FastCrushAndRaise);
                once(self);
            }
            8 => {
                self.ev_build_stairs(linenum, false);
                once(self);
            }
            10 => {
                self.ev_do_plat(linenum, PlatType::DownWaitUpStay, 0);
                once(self);
            }
            12 => {
                self.ev_light_turn_on(linenum, 0);
                once(self);
            }
            13 => {
                self.ev_light_turn_on(linenum, 255);
                once(self);
            }
            16 => {
                self.ev_do_door(linenum, DoorType::Close30ThenOpen);
                once(self);
            }
            17 => {
                // start light strobing: cosmetic, not simulated
                once(self);
            }
            19 => {
                self.ev_do_floor(linenum, FloorType::LowerFloor);
                once(self);
            }
            22 => {
                self.ev_do_plat(linenum, PlatType::RaiseToNearestAndChange, 0);
                once(self);
            }
            25 => {
                self.ev_do_ceiling(linenum, CeilingType::CrushAndRaise);
                once(self);
            }
            30 => {
                self.ev_do_floor(linenum, FloorType::RaiseToTexture);
                once(self);
            }
            35 => {
                self.ev_light_turn_on(linenum, 35);
                once(self);
            }
            36 => {
                self.ev_do_floor(linenum, FloorType::TurboLower);
                once(self);
            }
            37 => {
                self.ev_do_floor(linenum, FloorType::LowerAndChange);
                once(self);
            }
            38 => {
                self.ev_do_floor(linenum, FloorType::LowerFloorToLowest);
                once(self);
            }
            39 => {
                self.ev_teleport(linenum, side, thing);
                once(self);
            }
            40 => {
                self.ev_do_ceiling(linenum, CeilingType::RaiseToHighest);
                self.ev_do_floor(linenum, FloorType::LowerFloorToLowest);
                once(self);
            }
            44 => {
                self.ev_do_ceiling(linenum, CeilingType::LowerAndCrush);
                once(self);
            }
            52 | 124 => {} // exits do nothing
            53 => {
                self.ev_do_plat(linenum, PlatType::PerpetualRaise, 0);
                once(self);
            }
            54 => {
                self.ev_stop_plat(linenum);
                once(self);
            }
            56 => {
                self.ev_do_floor(linenum, FloorType::RaiseFloorCrush);
                once(self);
            }
            57 => {
                self.ev_ceiling_crush_stop(linenum);
                once(self);
            }
            58 => {
                self.ev_do_floor(linenum, FloorType::RaiseFloor24);
                once(self);
            }
            59 => {
                self.ev_do_floor(linenum, FloorType::RaiseFloor24AndChange);
                once(self);
            }
            104 => {
                self.ev_turn_tag_lights_off(linenum);
                once(self);
            }
            108 => {
                self.ev_do_door(linenum, DoorType::BlazeRaise);
                once(self);
            }
            109 => {
                self.ev_do_door(linenum, DoorType::BlazeOpen);
                once(self);
            }
            100 => {
                self.ev_build_stairs(linenum, true);
                once(self);
            }
            110 => {
                self.ev_do_door(linenum, DoorType::BlazeClose);
                once(self);
            }
            119 => {
                self.ev_do_floor(linenum, FloorType::RaiseFloorToNearest);
                once(self);
            }
            121 => {
                self.ev_do_plat(linenum, PlatType::BlazeDWUS, 0);
                once(self);
            }
            125 => {
                if !is_player {
                    self.ev_teleport(linenum, side, thing);
                    once(self);
                }
            }
            130 => {
                self.ev_do_floor(linenum, FloorType::RaiseFloorTurbo);
                once(self);
            }
            141 => {
                self.ev_do_ceiling(linenum, CeilingType::SilentCrushAndRaise);
                once(self);
            }
            // retriggers
            72 => {
                self.ev_do_ceiling(linenum, CeilingType::LowerAndCrush);
            }
            73 => {
                self.ev_do_ceiling(linenum, CeilingType::CrushAndRaise);
            }
            74 => {
                self.ev_ceiling_crush_stop(linenum);
            }
            75 => {
                self.ev_do_door(linenum, DoorType::Close);
            }
            76 => {
                self.ev_do_door(linenum, DoorType::Close30ThenOpen);
            }
            77 => {
                self.ev_do_ceiling(linenum, CeilingType::FastCrushAndRaise);
            }
            79 => self.ev_light_turn_on(linenum, 35),
            80 => self.ev_light_turn_on(linenum, 0),
            81 => self.ev_light_turn_on(linenum, 255),
            82 => {
                self.ev_do_floor(linenum, FloorType::LowerFloorToLowest);
            }
            83 => {
                self.ev_do_floor(linenum, FloorType::LowerFloor);
            }
            84 => {
                self.ev_do_floor(linenum, FloorType::LowerAndChange);
            }
            86 => {
                self.ev_do_door(linenum, DoorType::Open);
            }
            87 => {
                self.ev_do_plat(linenum, PlatType::PerpetualRaise, 0);
            }
            88 => {
                self.ev_do_plat(linenum, PlatType::DownWaitUpStay, 0);
            }
            89 => self.ev_stop_plat(linenum),
            90 => {
                self.ev_do_door(linenum, DoorType::Normal);
            }
            91 => {
                self.ev_do_floor(linenum, FloorType::RaiseFloor);
            }
            92 => {
                self.ev_do_floor(linenum, FloorType::RaiseFloor24);
            }
            93 => {
                self.ev_do_floor(linenum, FloorType::RaiseFloor24AndChange);
            }
            94 => {
                self.ev_do_floor(linenum, FloorType::RaiseFloorCrush);
            }
            95 => {
                self.ev_do_plat(linenum, PlatType::RaiseToNearestAndChange, 0);
            }
            96 => {
                self.ev_do_floor(linenum, FloorType::RaiseToTexture);
            }
            97 => {
                self.ev_teleport(linenum, side, thing);
            }
            98 => {
                self.ev_do_floor(linenum, FloorType::TurboLower);
            }
            105 => {
                self.ev_do_door(linenum, DoorType::BlazeRaise);
            }
            106 => {
                self.ev_do_door(linenum, DoorType::BlazeOpen);
            }
            107 => {
                self.ev_do_door(linenum, DoorType::BlazeClose);
            }
            120 => {
                self.ev_do_plat(linenum, PlatType::BlazeDWUS, 0);
            }
            126 => {
                if !is_player {
                    self.ev_teleport(linenum, side, thing);
                }
            }
            128 => {
                self.ev_do_floor(linenum, FloorType::RaiseFloorToNearest);
            }
            129 => {
                self.ev_do_floor(linenum, FloorType::RaiseFloorTurbo);
            }
            _ => {}
        }
    }

    /// P_ShootSpecialLine
    pub fn shoot_special_line(&mut self, thing: u32, line: usize) {
        if self.player_of(thing).is_none() {
            if self.line_special[line] != 46 {
                return;
            }
        }
        match self.line_special[line] {
            24 => {
                self.ev_do_floor(line, FloorType::RaiseFloor);
                self.change_switch_texture(line, false);
            }
            46 => {
                self.ev_do_door(line, DoorType::Open);
                self.change_switch_texture(line, true);
            }
            47 => {
                self.ev_do_plat(line, PlatType::RaiseToNearestAndChange, 0);
                self.change_switch_texture(line, false);
            }
            _ => {}
        }
    }

    /// P_UseSpecialLine
    pub fn use_special_line(&mut self, thing: u32, line: usize, side: i32) -> bool {
        if side != 0 {
            return false;
        }
        let special = self.line_special[line];
        let sw = |w: &mut World, ok: bool, again: bool| {
            if ok {
                w.change_switch_texture(line, again);
            }
        };
        match special {
            1 | 26 | 27 | 28 | 31 | 32 | 33 | 34 | 117 | 118 => self.ev_vertical_door(line, thing),
            7 => {
                let ok = self.ev_build_stairs(line, false);
                sw(self, ok, false)
            }
            9 => {
                let ok = self.ev_do_donut(line);
                sw(self, ok, false)
            }
            11 | 51 => sw(self, true, false), // exits do nothing but the switch flips
            14 => {
                let ok = self.ev_do_plat(line, PlatType::RaiseAndChange, 32);
                sw(self, ok, false)
            }
            15 => {
                let ok = self.ev_do_plat(line, PlatType::RaiseAndChange, 24);
                sw(self, ok, false)
            }
            18 => {
                let ok = self.ev_do_floor(line, FloorType::RaiseFloorToNearest);
                sw(self, ok, false)
            }
            20 => {
                let ok = self.ev_do_plat(line, PlatType::RaiseToNearestAndChange, 0);
                sw(self, ok, false)
            }
            21 => {
                let ok = self.ev_do_plat(line, PlatType::DownWaitUpStay, 0);
                sw(self, ok, false)
            }
            23 => {
                let ok = self.ev_do_floor(line, FloorType::LowerFloorToLowest);
                sw(self, ok, false)
            }
            29 => {
                let ok = self.ev_do_door(line, DoorType::Normal);
                sw(self, ok, false)
            }
            41 => {
                let ok = self.ev_do_ceiling(line, CeilingType::LowerToFloor);
                sw(self, ok, false)
            }
            71 => {
                let ok = self.ev_do_floor(line, FloorType::TurboLower);
                sw(self, ok, false)
            }
            49 => {
                let ok = self.ev_do_ceiling(line, CeilingType::CrushAndRaise);
                sw(self, ok, false)
            }
            50 => {
                let ok = self.ev_do_door(line, DoorType::Close);
                sw(self, ok, false)
            }
            55 => {
                let ok = self.ev_do_floor(line, FloorType::RaiseFloorCrush);
                sw(self, ok, false)
            }
            101 => {
                let ok = self.ev_do_floor(line, FloorType::RaiseFloor);
                sw(self, ok, false)
            }
            102 => {
                let ok = self.ev_do_floor(line, FloorType::LowerFloor);
                sw(self, ok, false)
            }
            103 => {
                let ok = self.ev_do_door(line, DoorType::Open);
                sw(self, ok, false)
            }
            111 => {
                let ok = self.ev_do_door(line, DoorType::BlazeRaise);
                sw(self, ok, false)
            }
            112 => {
                let ok = self.ev_do_door(line, DoorType::BlazeOpen);
                sw(self, ok, false)
            }
            113 => {
                let ok = self.ev_do_door(line, DoorType::BlazeClose);
                sw(self, ok, false)
            }
            122 => {
                let ok = self.ev_do_plat(line, PlatType::BlazeDWUS, 0);
                sw(self, ok, false)
            }
            127 => {
                let ok = self.ev_build_stairs(line, true);
                sw(self, ok, false)
            }
            131 => {
                let ok = self.ev_do_floor(line, FloorType::RaiseFloorTurbo);
                sw(self, ok, false)
            }
            133 | 135 | 137 => {
                // locked blazing doors open for anyone in deathmatch
                let ok = self.ev_do_door(line, DoorType::BlazeOpen);
                sw(self, ok, false)
            }
            140 => {
                let ok = self.ev_do_floor(line, FloorType::RaiseFloor512);
                sw(self, ok, false)
            }
            // buttons
            42 => {
                let ok = self.ev_do_door(line, DoorType::Close);
                sw(self, ok, true)
            }
            43 => {
                let ok = self.ev_do_ceiling(line, CeilingType::LowerToFloor);
                sw(self, ok, true)
            }
            45 => {
                let ok = self.ev_do_floor(line, FloorType::LowerFloor);
                sw(self, ok, true)
            }
            60 => {
                let ok = self.ev_do_floor(line, FloorType::LowerFloorToLowest);
                sw(self, ok, true)
            }
            61 => {
                let ok = self.ev_do_door(line, DoorType::Open);
                sw(self, ok, true)
            }
            62 => {
                let ok = self.ev_do_plat(line, PlatType::DownWaitUpStay, 1);
                sw(self, ok, true)
            }
            63 => {
                let ok = self.ev_do_door(line, DoorType::Normal);
                sw(self, ok, true)
            }
            64 => {
                let ok = self.ev_do_floor(line, FloorType::RaiseFloor);
                sw(self, ok, true)
            }
            66 => {
                let ok = self.ev_do_plat(line, PlatType::RaiseAndChange, 24);
                sw(self, ok, true)
            }
            67 => {
                let ok = self.ev_do_plat(line, PlatType::RaiseAndChange, 32);
                sw(self, ok, true)
            }
            65 => {
                let ok = self.ev_do_floor(line, FloorType::RaiseFloorCrush);
                sw(self, ok, true)
            }
            68 => {
                let ok = self.ev_do_plat(line, PlatType::RaiseToNearestAndChange, 0);
                sw(self, ok, true)
            }
            69 => {
                let ok = self.ev_do_floor(line, FloorType::RaiseFloorToNearest);
                sw(self, ok, true)
            }
            70 => {
                let ok = self.ev_do_floor(line, FloorType::TurboLower);
                sw(self, ok, true)
            }
            114 => {
                let ok = self.ev_do_door(line, DoorType::BlazeRaise);
                sw(self, ok, true)
            }
            115 => {
                let ok = self.ev_do_door(line, DoorType::BlazeOpen);
                sw(self, ok, true)
            }
            116 => {
                let ok = self.ev_do_door(line, DoorType::BlazeClose);
                sw(self, ok, true)
            }
            123 => {
                let ok = self.ev_do_plat(line, PlatType::BlazeDWUS, 0);
                sw(self, ok, true)
            }
            132 => {
                let ok = self.ev_do_floor(line, FloorType::RaiseFloorTurbo);
                sw(self, ok, true)
            }
            99 | 134 | 136 => {
                let ok = self.ev_do_door(line, DoorType::BlazeOpen);
                sw(self, ok, true)
            }
            138 => {
                self.ev_light_turn_on(line, 255);
                sw(self, true, true)
            }
            139 => {
                self.ev_light_turn_on(line, 35);
                sw(self, true, true)
            }
            _ => {}
        }
        true
    }

    /// P_ChangeSwitchTexture
    pub fn change_switch_texture(&mut self, line: usize, use_again: bool) {
        if !use_again {
            self.line_special[line] = 0;
        }
        let side = self.map.lines[line].sidenum[0] as usize;
        let tex = self.side_tex[side];
        let sound = if self.line_special[line] == 11 { sfx::swtchx } else { sfx::swtchn };
        // vanilla scans the switch list in order and tests top, mid, bottom for each entry:
        // the texture with the lowest list position wins, top before mid before bottom
        let map = self.map.clone();
        let partner = &map.switch_partner;
        let mut best: Option<(usize, i32)> = None;
        let mut best_rank = usize::MAX;
        for (where_, &t) in [(0usize, &tex[0]), (1usize, &tex[1]), (2usize, &tex[2])] {
            if t > 0 && (t as usize) < partner.len() && partner[t as usize] >= 0 {
                let rank = crate::specials::switch_rank(&self.map, t);
                if rank < best_rank {
                    best_rank = rank;
                    best = Some((where_, t));
                }
            }
        }
        if let Some((where_, t)) = best {
            let (sx, sy) = self.map.sectors[self.map.lines[line].frontsector as usize].soundorg;
            let fz = self.sectors[self.map.lines[line].frontsector as usize].floorheight;
            self.start_sound_at(sx, sy, fz, sound);
            self.side_tex[side][where_] = partner[t as usize];
            self.emit(6, line as i32, 0, 0, 0, 0, 0, 0);
            if use_again {
                // P_StartButton
                if !self.buttons.iter().any(|b| b.btimer != 0 && b.line == line as i32) {
                    let btn = Button { line: line as i32, where_: where_ as i32, btexture: t, btimer: BUTTONTIME };
                    if let Some(slot) = self.buttons.iter_mut().find(|b| b.btimer == 0) {
                        *slot = btn;
                    } else {
                        self.buttons.push(btn);
                    }
                }
            }
        }
    }

    /// P_UpdateSpecials: buttons only (texture animation and scrollers are cosmetic)
    pub fn update_specials(&mut self) {
        for i in 0..self.buttons.len() {
            if self.buttons[i].btimer != 0 {
                self.buttons[i].btimer -= 1;
                if self.buttons[i].btimer == 0 {
                    let b = self.buttons[i];
                    let side = self.map.lines[b.line as usize].sidenum[0] as usize;
                    self.side_tex[side][b.where_ as usize] = b.btexture;
                    let fs = self.map.lines[b.line as usize].frontsector as usize;
                    let (sx, sy) = self.map.sectors[fs].soundorg;
                    let fz = self.sectors[fs].floorheight;
                    self.start_sound_at(sx, sy, fz, sfx::swtchn);
                    self.emit(6, b.line, 0, 0, 0, 0, 0, 0);
                    self.buttons[i] = Button::default();
                }
            }
        }
        // keep the list compact so it does not grow forever
        while let Some(b) = self.buttons.last() {
            if b.btimer == 0 {
                self.buttons.pop();
            } else {
                break;
            }
        }
    }

    /// P_PlayerInSpecialSector
    pub fn player_in_special_sector(&mut self, slot: usize, h: u32) {
        let sec = self.map.subsectors[self.mo(h).subsector as usize].sector as usize;
        if self.mo(h).z != self.sectors[sec].floorheight {
            return;
        }
        let iron = self.players[slot].powers[PW_IRONFEET] != 0;
        match self.sectors[sec].special {
            5 => {
                if !iron && (self.leveltime & 0x1f) == 0 {
                    self.damage_mobj(h, NONE, NONE, 10, mod_::SLIME);
                }
            }
            7 => {
                if !iron && (self.leveltime & 0x1f) == 0 {
                    self.damage_mobj(h, NONE, NONE, 5, mod_::SLIME);
                }
            }
            16 | 4 => {
                if !iron || self.p_random() < 5 {
                    if (self.leveltime & 0x1f) == 0 {
                        self.damage_mobj(h, NONE, NONE, 20, mod_::SLIME);
                    }
                }
            }
            11
                if (self.leveltime & 0x1f) == 0 => {
                    self.damage_mobj(h, NONE, NONE, 20, mod_::SLIME);
                }
            _ => {} // secrets and light specials: nothing
        }
    }

    /// EV_LightTurnOn
    pub fn ev_light_turn_on(&mut self, line: usize, mut bright: i32) {
        let tag = self.map.lines[line].tag;
        for i in 0..self.sectors.len() {
            if self.map.sectors[i].tag == tag {
                if bright == 0 {
                    for &l in &self.map.sectors[i].lines {
                        if let Some(o) = self.get_next_sector(l as usize, i) {
                            if self.sectors[o].lightlevel > bright {
                                bright = self.sectors[o].lightlevel;
                            }
                        }
                    }
                }
                self.sectors[i].lightlevel = bright;
            }
        }
    }

    /// EV_TurnTagLightsOff
    pub fn ev_turn_tag_lights_off(&mut self, line: usize) {
        let tag = self.map.lines[line].tag;
        for j in 0..self.sectors.len() {
            if self.map.sectors[j].tag == tag {
                let mut min = self.sectors[j].lightlevel;
                for &l in &self.map.sectors[j].lines {
                    if let Some(o) = self.get_next_sector(l as usize, j) {
                        if self.sectors[o].lightlevel < min {
                            min = self.sectors[o].lightlevel;
                        }
                    }
                }
                self.sectors[j].lightlevel = min;
            }
        }
    }

    /// EV_DoDonut
    pub fn ev_do_donut(&mut self, line: usize) -> bool {
        let mut rtn = false;
        for s1 in self.tagged_sectors(line) {
            if self.sectors[s1].specialdata != NONE {
                continue;
            }
            rtn = true;
            let l0 = match self.map.sectors[s1].lines.first() {
                Some(&l) => l as usize,
                None => continue,
            };
            let s2 = match self.get_next_sector(l0, s1) {
                Some(s) => s,
                None => continue,
            };
            let lines = self.map.sectors[s2].lines.clone();
            for l in lines {
                let li = &self.map.lines[l as usize];
                // vanilla: (!flags & ML_TWOSIDED) is always 0, so only the backsector test
                if li.backsector < 0 || li.backsector as usize == s1 {
                    continue;
                }
                let s3 = li.backsector as usize;
                let s3pic = self.sectors[s3].floorpic;
                let s3h = self.sectors[s3].floorheight;
                let f = FloorMove { type_: FloorType::DonutRaise, crush: false, sector: s2 as u32, direction: 1, newspecial: 0, texture: s3pic, floordestheight: s3h, speed: FLOORSPEED / 2 };
                let h = self.alloc_sthinker(SThinker::Floor(f));
                self.sectors[s2].specialdata = h;
                let f = FloorMove { type_: FloorType::LowerFloor, crush: false, sector: s1 as u32, direction: -1, newspecial: 0, texture: 0, floordestheight: s3h, speed: FLOORSPEED / 2 };
                let h = self.alloc_sthinker(SThinker::Floor(f));
                self.sectors[s1].specialdata = h;
                break;
            }
        }
        rtn
    }

    /// P_SpawnSpecials (doors on timers only; lights are cosmetic)
    pub fn spawn_specials(&mut self) {
        for i in 0..self.sectors.len() {
            match self.sectors[i].special {
                10 => self.spawn_door_close_in_30(i),
                14 => self.spawn_door_raise_in_5_mins(i),
                _ => {}
            }
        }
    }
}

/// position of a texture in the vanilla switch list (SW1 x, SW2 x pairs in order)
pub fn switch_rank(map: &Map, t: i32) -> usize {
    let name = &map.texture_names[t as usize];
    for (i, (a, b)) in SWITCH_LIST.iter().enumerate() {
        if a == name {
            return i * 2;
        }
        if b == name {
            return i * 2 + 1;
        }
    }
    usize::MAX - 1
}
