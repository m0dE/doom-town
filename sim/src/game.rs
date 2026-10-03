// Game modes, teams, rounds, capture points and map rotation (DESIGN.md "Modes, teams
// and map rotation (v2)").
// Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.

use std::rc::Rc;

use crate::fixed::*;
use crate::info::*;
use crate::map::Map;
use crate::world::*;

pub const MODE_FFA: u32 = 0;
pub const MODE_TDM: u32 = 1;
pub const MODE_ELIM: u32 = 2;
pub const MODE_WAR: u32 = 3;

pub const PH_PLAY: u8 = 0;
pub const PH_FREEZE: u8 = 1;
pub const PH_ROUND_OVER: u8 = 2;
pub const PH_INTER: u8 = 3;

pub const ROUND_OVER_TICS: u32 = 35 * 3;
pub const WAVE_TICS: u32 = 35 * 10;
pub const BLEED_TICS: u32 = 35 * 5;
/// capture progress runs -CAP_FULL (red) .. +CAP_FULL (blue): 10 s for one capper
pub const CAP_FULL: i32 = 35 * 10;
pub const TICKETS_LOW: i32 = 100;
pub const BOSS_FIRST_TICS: i32 = 35 * 60;
pub const BOSS_NEXT_TICS: i32 = 35 * 90;
pub const BOSS_FRAGS: i32 = 5;

const PEND_MATCH: u8 = 1;
const PEND_ROUND: u8 = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub mode: u32,
    pub slots: u32,
    pub match_tics: u32,
    pub inter_tics: u32,
    pub round_tics: u32,
    pub freeze_tics: u32,
    pub rounds_to_win: u32,
    pub tickets: u32,
    pub friendly_fire: bool,
    /// bit 0: random bosses (FFA and TDM only), bit 1: players pass through each other
    pub flags: u32,
}

impl Config {
    pub fn ffa(slots: u32) -> Config {
        Config { mode: MODE_FFA, slots, match_tics: 0, inter_tics: 0, round_tics: 0, freeze_tics: 0, rounds_to_win: 0, tickets: 0, friendly_fire: false, flags: 0 }.with_defaults()
    }
    pub fn mode(mode: u32, slots: u32) -> Config {
        Config { mode, slots, match_tics: 0, inter_tics: 0, round_tics: 0, freeze_tics: 0, rounds_to_win: 0, tickets: 0, friendly_fire: false, flags: 0 }.with_defaults()
    }
    /// fill zero timing fields with the mode's defaults
    pub fn with_defaults(mut self) -> Config {
        if self.mode > MODE_WAR {
            self.mode = MODE_FFA;
        }
        let d = |v: &mut u32, x: u32| {
            if *v == 0 {
                *v = x
            }
        };
        d(&mut self.match_tics, if self.mode == MODE_WAR { 35 * 1200 } else { MATCH_TICS });
        d(&mut self.inter_tics, INTER_TICS);
        d(&mut self.round_tics, 35 * 150);
        d(&mut self.freeze_tics, 35 * 5);
        d(&mut self.rounds_to_win, 7);
        d(&mut self.tickets, 3000);
        d(&mut self.slots, match self.mode {
            MODE_ELIM => 24,
            MODE_WAR => 200,
            _ => 64,
        });
        self.slots = self.slots.clamp(1, 255);
        self
    }
    pub fn teams(&self) -> bool {
        self.mode != MODE_FFA
    }
    pub fn bosses(&self) -> bool {
        self.flags & 1 != 0 && (self.mode == MODE_FFA || self.mode == MODE_TDM)
    }
    /// players don't block each other (crowded rooms); monsters, missiles and pickups still hit
    pub fn ghost_players(&self) -> bool {
        self.flags & 2 != 0
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CapPoint {
    pub owner: i32,
    pub progress: i32,
    pub flags: i32,
}

#[derive(Clone)]
pub struct Game {
    pub cfg: Config,
    /// the rotation (identified in snapshots by name + content hash)
    pub maps: Vec<Rc<Map>>,
    pub map_index: u32,
    pub match_index: u32,
    pub phase: u8,
    pub phase_left: u32,
    /// tics into the current match (all phases but the intermission)
    pub match_tic: u32,
    /// FFA unused, TDM team frags, elimination rounds won, war tickets
    pub team_score: [i32; 2],
    pub round: i32,
    pub winner: i32,
    pub points: Vec<CapPoint>,
    pub low_sent: [bool; 2],
    pub pending: u8,
    pub boss: MRef,
    pub boss_max: i32,
    /// tics until the next boss, -1 none scheduled
    pub boss_timer: i32,
    pub boss_drop: MRef,
    /// failed boss placements in a row (after 5 the 1024-unit rule relaxes)
    pub boss_tries: i32,
}

impl Game {
    pub fn new(cfg: Config, maps: Vec<Rc<Map>>) -> Game {
        Game { cfg, maps, map_index: 0, match_index: 0, phase: PH_PLAY, phase_left: 0, match_tic: 0, team_score: [0; 2], round: 0, winner: -1, points: Vec::new(), low_sent: [false; 2], pending: 0, boss: MRef::NULL, boss_max: 0, boss_timer: -1, boss_drop: MRef::NULL, boss_tries: 0 }
    }
}

impl World {
    #[inline]
    pub fn mode(&self) -> u32 {
        self.g.cfg.mode
    }
    /// team of a slot: slot % 2 in the team modes, -1 in deathmatch
    #[inline]
    pub fn team_of(&self, slot: usize) -> i32 {
        if self.g.cfg.teams() {
            (slot & 1) as i32
        } else {
            -1
        }
    }
    pub fn same_team(&self, a: usize, b: usize) -> bool {
        self.g.cfg.teams() && (a & 1) == (b & 1)
    }
    pub fn next_map_index(&self) -> u32 {
        let n = self.g.maps.len().max(1) as u32;
        (self.g.match_index + 1) % n
    }

    /// start match `g.match_index` (at world creation and after every intermission)
    pub fn begin_match(&mut self) {
        let n = self.g.maps.len().max(1) as u32;
        let want = self.g.match_index % n;
        if want != self.g.map_index {
            self.g.map_index = want;
            let m = self.g.maps[want as usize].clone();
            self.load_map(m);
            let id = self.map.id;
            self.emit(9, id, want as i32, self.g.match_index as i32, 0, 0, 0, 0);
        } else {
            for p in self.players.iter_mut() {
                p.fresh = true;
                p.playerstate = PST_REBORN;
            }
            self.remove_live_boss();
        }
        self.g.boss = MRef::NULL;
        self.g.boss_drop = MRef::NULL;
        self.g.boss_timer = if self.g.cfg.bosses() { BOSS_FIRST_TICS } else { -1 };
        for p in self.players.iter_mut() {
            p.frags = 0;
            p.deaths = 0;
            p.spawn_choice = -1;
        }
        self.g.team_score = if self.mode() == MODE_WAR { [self.g.cfg.tickets as i32; 2] } else { [0; 2] };
        self.g.round = 0;
        self.g.winner = -1;
        self.g.low_sent = [false; 2];
        self.g.match_tic = 0;
        self.g.points = vec![CapPoint { owner: -1, progress: 0, flags: 0 }; if self.mode() == MODE_WAR { self.map.cap_points.len() } else { 0 }];
        self.g.pending |= PEND_MATCH;
        if self.mode() == MODE_ELIM {
            self.begin_round();
        } else {
            self.g.phase = PH_PLAY;
            self.g.phase_left = self.g.cfg.match_tics;
        }
    }

    fn begin_round(&mut self) {
        self.g.round += 1;
        for p in self.players.iter_mut() {
            p.fresh = true;
            p.playerstate = PST_REBORN;
        }
        self.g.phase = PH_FREEZE;
        self.g.phase_left = self.g.cfg.freeze_tics.max(1);
        self.g.pending |= PEND_ROUND;
    }

    fn end_match(&mut self, winner: i32) {
        self.remove_live_boss();
        self.g.boss_timer = -1;
        let score = if self.g.cfg.teams() {
            if winner >= 0 {
                self.g.team_score[winner as usize]
            } else {
                self.g.team_score[0]
            }
        } else if winner >= 0 {
            self.players[winner as usize].frags
        } else {
            0
        };
        self.g.winner = winner;
        self.emit(8, winner, score, self.g.match_index as i32, 0, 0, 0, 0);
        self.g.phase = PH_INTER;
        self.g.phase_left = self.g.cfg.inter_tics.max(1);
    }

    /// events owed from the previous state change, at the start of a tic
    pub fn emit_pending(&mut self) {
        if self.g.pending & PEND_MATCH != 0 {
            self.emit(7, self.g.match_index as i32, self.mode() as i32, 0, 0, 0, 0, 0);
        }
        if self.g.pending & PEND_ROUND != 0 {
            self.emit(10, self.g.round, 0, 0, 0, 0, 0, 0);
        }
        self.g.pending = 0;
    }

    /// intermission tic; returns true while it lasts
    pub fn intermission_tick(&mut self) -> bool {
        if self.g.phase != PH_INTER {
            return false;
        }
        self.g.phase_left = self.g.phase_left.saturating_sub(1);
        if self.g.phase_left == 0 {
            self.g.match_index += 1;
            self.begin_match();
        }
        true
    }

    pub fn alive_counts(&self) -> [i32; 2] {
        let mut a = [0; 2];
        for (i, p) in self.players.iter().enumerate() {
            if p.playerstate == PST_LIVE && self.deref(p.mo).is_some() {
                let t = self.team_of(i);
                if t >= 0 {
                    a[t as usize] += 1;
                }
            }
        }
        a
    }

    /// may this player be put into the world now?
    pub fn may_spawn(&self) -> bool {
        !(self.mode() == MODE_ELIM && self.g.phase != PH_FREEZE)
    }

    /// mode rules after the thinkers ran
    pub fn mode_tick(&mut self) {
        match self.mode() {
            MODE_FFA | MODE_TDM => {
                self.boss_tick();
                self.g.match_tic += 1;
                self.g.phase_left = self.g.phase_left.saturating_sub(1);
                if self.g.phase_left == 0 {
                    let w = if self.mode() == MODE_FFA {
                        let mut best = -1i32;
                        let mut bestf = i32::MIN;
                        for p in &self.players {
                            if p.frags > bestf {
                                bestf = p.frags;
                                best = p.slot;
                            }
                        }
                        best
                    } else {
                        let s = self.g.team_score;
                        if s[0] > s[1] {
                            0
                        } else if s[1] > s[0] {
                            1
                        } else {
                            -1
                        }
                    };
                    self.end_match(w);
                }
            }
            MODE_ELIM => self.elim_tick(),
            MODE_WAR => self.war_tick(),
            _ => {}
        }
    }

    fn elim_tick(&mut self) {
        self.g.match_tic += 1;
        self.g.phase_left = self.g.phase_left.saturating_sub(1);
        match self.g.phase {
            PH_FREEZE => {
                if self.g.phase_left == 0 {
                    self.g.phase = PH_PLAY;
                    self.g.phase_left = self.g.cfg.round_tics.max(1);
                }
            }
            PH_PLAY => {
                let a = self.alive_counts();
                let over = a[0] == 0 || a[1] == 0 || self.g.phase_left == 0;
                if over {
                    let w = if a[0] == a[1] {
                        -1
                    } else if a[0] > a[1] {
                        0
                    } else {
                        1
                    };
                    if w >= 0 {
                        self.g.team_score[w as usize] += 1;
                    }
                    self.emit(11, w, self.g.round, self.g.team_score[0], 0, 0, 0, self.g.team_score[1]);
                    self.g.phase = PH_ROUND_OVER;
                    self.g.phase_left = ROUND_OVER_TICS;
                }
            }
            PH_ROUND_OVER => {
                if self.g.phase_left == 0 {
                    let need = self.g.cfg.rounds_to_win as i32;
                    if self.g.team_score[0] >= need || self.g.team_score[1] >= need {
                        let w = if self.g.team_score[0] >= need { 0 } else { 1 };
                        self.end_match(w);
                    } else {
                        self.begin_round();
                    }
                }
            }
            _ => {}
        }
    }

    fn war_tick(&mut self) {
        self.g.match_tic += 1;
        self.g.phase_left = self.g.phase_left.saturating_sub(1);
        let map = self.map.clone();
        // capture points
        for i in 0..self.g.points.len() {
            let (px, py, r) = map.cap_points[i];
            let c = ((px >> FRACBITS) as i64, (py >> FRACBITS) as i64);
            let r2 = ((r >> FRACBITS) as i64).pow(2);
            let mut n = [0i32; 2];
            for (s, p) in self.players.iter().enumerate() {
                if p.playerstate != PST_LIVE {
                    continue;
                }
                if let Some(h) = self.deref(p.mo) {
                    let m = self.mo(h);
                    let dx = (m.x >> FRACBITS) as i64 - c.0;
                    let dy = (m.y >> FRACBITS) as i64 - c.1;
                    if dx * dx + dy * dy <= r2 {
                        n[s & 1] += 1;
                    }
                }
            }
            let pt = &mut self.g.points[i];
            pt.flags = (n[0] > 0) as i32 | (((n[1] > 0) as i32) << 1);
            let diff = n[1] - n[0];
            let mut captured = -1;
            if diff != 0 {
                let step = diff.signum() * diff.abs().min(4);
                pt.progress = (pt.progress + step).clamp(-CAP_FULL, CAP_FULL);
                if pt.owner == 0 && pt.progress > 0 || pt.owner == 1 && pt.progress < 0 {
                    pt.owner = -1;
                }
                if pt.progress == -CAP_FULL && pt.owner != 0 {
                    pt.owner = 0;
                    captured = 0;
                } else if pt.progress == CAP_FULL && pt.owner != 1 {
                    pt.owner = 1;
                    captured = 1;
                }
            }
            if captured >= 0 {
                self.emit(12, i as i32, captured, 0, px, py, 0, 0);
            }
        }
        // ticket bleed for the team holding fewer points
        if self.g.match_tic % BLEED_TICS == 0 {
            let mut o = [0; 2];
            for p in &self.g.points {
                if p.owner >= 0 {
                    o[p.owner as usize] += 1;
                }
            }
            if o[0] < o[1] {
                self.g.team_score[0] -= 1;
            } else if o[1] < o[0] {
                self.g.team_score[1] -= 1;
            }
        }
        for t in 0..2 {
            if self.g.team_score[t] <= TICKETS_LOW && !self.g.low_sent[t] {
                self.g.low_sent[t] = true;
                self.emit(13, t as i32, self.g.team_score[t], 0, 0, 0, 0, 0);
            }
        }
        // respawn wave
        if self.g.match_tic % WAVE_TICS == 0 {
            for p in self.players.iter_mut() {
                if p.playerstate == PST_DEAD && p.dead_tics >= RESPAWN_MIN_TICS {
                    p.playerstate = PST_REBORN;
                }
            }
        }
        let s = self.g.team_score;
        if s[0] <= 0 || s[1] <= 0 || self.g.phase_left == 0 {
            let w = if s[0] > s[1] {
                0
            } else if s[1] > s[0] {
                1
            } else {
                -1
            };
            self.end_match(w);
        }
    }

    /// scoring for a player's death (called from P_KillMobj)
    pub fn score_death(&mut self, victim: usize, killer: Option<usize>) {
        match self.mode() {
            MODE_TDM => match killer {
                Some(k) if k != victim => {
                    let t = self.team_of(k) as usize;
                    if self.same_team(k, victim) {
                        self.g.team_score[t] -= 1;
                    } else {
                        self.g.team_score[t] += 1;
                    }
                }
                _ => self.g.team_score[self.team_of(victim) as usize] -= 1,
            },
            MODE_WAR => {
                if self.g.phase == PH_PLAY {
                    self.g.team_score[self.team_of(victim) as usize] -= 1;
                }
            }
            _ => {}
        }
    }

    /// where may this player respawn in war: bit 0 base, bit 1+i point i
    pub fn respawn_mask(&self, slot: usize) -> i32 {
        if self.mode() != MODE_WAR {
            return 0;
        }
        let t = self.team_of(slot);
        let mut m = 1;
        for (i, p) in self.g.points.iter().enumerate() {
            if p.owner == t && i < 30 {
                m |= 1 << (1 + i);
            }
        }
        m
    }

    /// spawn spot indices this player may use now
    pub fn spawn_candidates(&self, slot: usize) -> Vec<usize> {
        let map = &self.map;
        let n = map.spawn_spots.len();
        if !self.g.cfg.teams() {
            return (0..n).collect();
        }
        let t = self.team_of(slot);
        if self.mode() == MODE_WAR {
            let c = self.players[slot].spawn_choice;
            if c >= 0 && (c as usize) < self.g.points.len() && self.g.points[c as usize].owner == t {
                let v: Vec<usize> = map.point_spots[c as usize].iter().map(|&i| i as usize).collect();
                if !v.is_empty() {
                    return v;
                }
            }
        }
        let v: Vec<usize> = (0..n).filter(|&i| map.spot_team.get(i).copied() == Some(t as u8)).collect();
        if v.is_empty() {
            (0..n).collect()
        } else {
            v
        }
    }

    /// elimination round loadout: pistol + shotgun + 50 shells (health is full already)
    pub fn apply_loadout(&mut self, slot: usize) {
        if self.mode() == MODE_ELIM {
            let p = &mut self.players[slot];
            p.weaponowned[WP_SHOTGUN as usize] = true;
            p.ammo[AM_SHELL as usize] = 50;
            p.readyweapon = WP_SHOTGUN;
            p.pendingweapon = WP_SHOTGUN;
        }
    }

    /// slot a dead elimination player watches (-1 none)
    pub fn spectating(&self, slot: usize) -> i32 {
        if self.mode() != MODE_ELIM {
            return -1;
        }
        let p = &self.players[slot];
        if p.playerstate == PST_LIVE && self.deref(p.mo).is_some() {
            return -1;
        }
        let t = self.team_of(slot);
        let alive: Vec<usize> = (0..self.players.len())
            .filter(|&i| i != slot && self.players[i].playerstate == PST_LIVE && self.deref(self.players[i].mo).is_some())
            .collect();
        let mates: Vec<usize> = alive.iter().copied().filter(|&i| self.team_of(i) == t).collect();
        let list = if mates.is_empty() { alive } else { mates };
        if list.is_empty() {
            return -1;
        }
        list[(p.spec_cycle.max(0) as usize) % list.len()] as i32
    }
}

impl World {
    fn remove_live_boss(&mut self) {
        if let Some(b) = self.deref(self.g.boss) {
            if self.mo(b).health > 0 {
                let (x, y, z) = {
                    let m = self.mo(b);
                    (m.x, m.y, m.z)
                };
                let fog = self.spawn_mobj(x, y, z, mt::TFOG);
                self.start_sound(fog, sfx::telept);
                self.remove_mobj(b);
            }
        }
        self.g.boss = MRef::NULL;
    }

    fn boss_tick(&mut self) {
        if self.g.boss_timer < 0 || self.g.phase != PH_PLAY {
            return;
        }
        self.g.boss_timer -= 1;
        if self.g.boss_timer > 0 {
            return;
        }
        let first = if self.p_random() & 1 != 0 { mt::SPIDER } else { mt::CYBORG };
        let other = if first == mt::SPIDER { mt::CYBORG } else { mt::SPIDER };
        let relaxed = self.g.boss_tries >= 5;
        if !self.try_spawn_boss(first, relaxed) && !self.try_spawn_boss(other, relaxed) {
            self.g.boss_timer = 35; // try again in a second
            self.g.boss_tries += 1;
        } else {
            self.g.boss_tries = 0;
        }
    }

    /// a boss at a spawn spot that fits it and is >= 1024 units from every live player
    /// `relaxed`: crowded map, no spot 1024 units clear of everyone: take the spot that is
    /// farthest from the nearest player instead
    fn try_spawn_boss(&mut self, t: usize, relaxed: bool) -> bool {
        let map = self.map.clone();
        let n = map.spawn_spots.len();
        if n == 0 {
            return false;
        }
        let inf = info(t);
        let live: Vec<(i64, i64)> = self
            .players
            .iter()
            .filter(|p| p.playerstate == PST_LIVE)
            .filter_map(|p| self.deref(p.mo))
            .map(|h| {
                let m = self.mo(h);
                ((m.x >> FRACBITS) as i64, (m.y >> FRACBITS) as i64)
            })
            .collect();
        let start = (((self.p_random() << 8) | self.p_random()) as usize) % n;
        let mut order: Vec<usize> = (0..n).map(|k| (start + k) % n).collect();
        let near2 = |sx: i64, sy: i64| live.iter().map(|&(x, y)| (x - sx) * (x - sx) + (y - sy) * (y - sy)).min().unwrap_or(i64::MAX);
        if relaxed {
            // farthest from everyone first (stable: ties keep the random rotation)
            order.sort_by_key(|&i| std::cmp::Reverse(near2(map.spawn_spots[i].x as i64, map.spawn_spots[i].y as i64)));
        }
        for i in order {
            let sp = map.spawn_spots[i];
            let (sx, sy) = (sp.x as i64, sp.y as i64);
            if !relaxed && near2(sx, sy) < 1024 * 1024 {
                continue;
            }
            let (fx, fy) = ((sp.x as i32) << FRACBITS, (sp.y as i32) << FRACBITS);
            let sec = map.sector_at(fx, fy);
            if self.sectors[sec].ceilingheight - self.sectors[sec].floorheight < inf.height {
                continue;
            }
            if !crate::bots::nav::static_clear(&map, fx, fy, inf.radius, false) || !self.spot_clear(fx, fy, inf.radius) {
                continue;
            }
            let h = self.spawn_mobj(fx, fy, ONFLOORZ, t);
            let mult = (16 + live.len() as i32).min(16 * 3);
            let health = inf.spawnhealth * mult / 16;
            {
                let m = self.mo_mut(h);
                m.health = health;
                m.angle = ANG45.wrapping_mul((sp.angle as i32 / 45) as u32);
            }
            // hunt the nearest player straight away
            let mut best: Option<(i64, u32)> = None;
            for p in &self.players {
                if p.playerstate != PST_LIVE {
                    continue;
                }
                if let Some(ph) = self.deref(p.mo) {
                    let m = self.mo(ph);
                    let d = (((m.x >> FRACBITS) as i64) - sx).pow(2) + (((m.y >> FRACBITS) as i64) - sy).pow(2);
                    if best.is_none_or(|(bd, _)| d < bd) {
                        best = Some((d, ph));
                    }
                }
            }
            if let Some((_, ph)) = best {
                let r = self.mref(ph);
                self.mo_mut(h).target = r;
                self.set_mobj_state(h, inf.seestate);
            }
            let z = self.mo(h).z;
            self.start_sound_at(fx, fy, z, inf.seesound);
            let fog = self.spawn_mobj(fx, fy, z, mt::TFOG);
            self.start_sound(fog, sfx::telept);
            self.emit(14, t as i32, 0, 0, fx, fy, z, 0);
            self.g.boss = self.mref(h);
            self.g.boss_max = health;
            self.g.boss_timer = -1;
            return true;
        }
        false
    }

    /// P_KillMobj on a boss: BFG + cell pack drop, +5 frags, next boss in 90 s
    pub fn boss_killed(&mut self, h: u32, killer: Option<usize>) {
        let (x, y, t) = {
            let m = self.mo(h);
            (m.x, m.y, m.type_ as i32)
        };
        self.emit(15, t, killer.map(|k| k as i32).unwrap_or(-1), 0, x, y, 0, 0);
        if let Some(k) = killer {
            self.players[k].frags += BOSS_FRAGS;
            if self.mode() == MODE_TDM {
                let tm = self.team_of(k) as usize;
                self.g.team_score[tm] += BOSS_FRAGS;
            }
        }
        let bfg = self.spawn_mobj(x, y, ONFLOORZ, mt::MISC25);
        self.mo_mut(bfg).flags |= MF_DROPPED;
        let cells = self.spawn_mobj(x + 24 * FRACUNIT, y, ONFLOORZ, mt::MISC21);
        self.mo_mut(cells).flags |= MF_DROPPED;
        self.g.boss_drop = self.mref(bfg);
        if self.deref(self.g.boss) == Some(h) {
            self.g.boss = MRef::NULL;
            if self.g.cfg.bosses() && self.g.phase == PH_PLAY {
                self.g.boss_timer = BOSS_NEXT_TICS;
            }
        }
    }

    /// world_view_match boss words: id, type, health, max health, tics until next
    pub fn boss_view(&self) -> [i32; 5] {
        match self.deref(self.g.boss) {
            Some(b) => {
                let m = self.mo(b);
                [m.id as i32, m.type_ as i32, m.health.max(0), self.g.boss_max, -1]
            }
            None => [0, 0, 0, 0, self.g.boss_timer],
        }
    }
}
