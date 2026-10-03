// Battle royale: rules, the shrinking zone (the storm), crates, loot and supply drops
// (DESIGN.md "Battle royale" and "Battle royale v2"). The lobby, the dropship and
// skydiving are in drop.rs; vehicles and grenades in vehicle.rs.
// Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.

use crate::fixed::*;
use crate::game::*;
use crate::info::*;
use crate::map::*;
use crate::world::*;

/// buttons bit 3: zoom (held)
pub const BT_ZOOM: u16 = 8;
/// buttons bit 10: throw a grenade
pub const BT_GRENADE: u16 = 0x400;
/// means of death: caught outside the zone
pub const MOD_ZONE: i32 = mod_::ZONE;
/// events
pub const EV_ZONE: i32 = 16;
pub const EV_CRATE: i32 = 17;
pub const EV_SUPPLY: i32 = 18;
/// world_view_match words after the boss words
pub const BR_WORDS: usize = 19;
/// use reach for crates and vehicles (from the thing's edge) and the facing cone
pub const USE_REACH: i32 = 96;
const USE_CONE: u32 = ANG45;
/// supply drops: event 18 this long before the crate lands
pub const SUPPLY_WARN_TICS: i32 = 35 * 10;
pub const MAX_STAGES: usize = 8;

pub const ZS_WAIT: i32 = 0;
pub const ZS_SHRINK: i32 = 1;
pub const ZS_CLOSED: i32 = 2;

/// Battle royale rules (the MODINFO `rules` block; DESIGN.md "Mods").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrRules {
    pub lobby_tics: u32,
    /// dropship altitude above the highest floor, map units
    pub drop_alt: i32,
    pub start_bullets: i32,
    pub vehicles: bool,
    pub supply: bool,
    /// per stage: wait tics, shrink tics, radius after (per mille of stage 0), damage/s
    pub stages: Vec<[i32; 4]>,
    /// loot weights (half-percent units), one per LOOT row
    pub loot: Vec<i32>,
}

pub const DEFAULT_STAGES: [[i32; 4]; 5] = [[35 * 60, 35 * 60, 600, 1], [35 * 45, 35 * 45, 350, 2], [35 * 40, 35 * 40, 180, 4], [35 * 30, 35 * 30, 80, 7], [35 * 30, 35 * 30, 0, 10]];

impl Default for BrRules {
    fn default() -> Self {
        BrRules {
            lobby_tics: 35 * 45,
            drop_alt: 4096,
            start_bullets: 20,
            vehicles: true,
            supply: true,
            stages: DEFAULT_STAGES.to_vec(),
            loot: LOOT.iter().map(|e| e.0).collect(),
        }
    }
}

impl BrRules {
    /// keep the numbers in range (idempotent)
    pub fn sanitize(&mut self) {
        if self.lobby_tics == 0 {
            self.lobby_tics = 1;
        }
        self.drop_alt = self.drop_alt.clamp(256, 16384);
        self.start_bullets = self.start_bullets.clamp(0, 400);
        if self.stages.is_empty() {
            self.stages = DEFAULT_STAGES.to_vec();
        }
        self.stages.truncate(MAX_STAGES);
        // each circle no larger than the one before it
        let mut prev_r = 1000;
        for s in self.stages.iter_mut() {
            s[0] = s[0].clamp(1, 35 * 3600);
            s[1] = s[1].clamp(1, 35 * 3600);
            s[2] = s[2].clamp(0, prev_r);
            s[3] = s[3].clamp(0, 1000);
            prev_r = s[2];
        }
        let def: Vec<i32> = LOOT.iter().map(|e| e.0).collect();
        self.loot.truncate(LOOT.len());
        while self.loot.len() < LOOT.len() {
            self.loot.push(def[self.loot.len()]);
        }
        for w in self.loot.iter_mut() {
            *w = (*w).clamp(0, 10000);
        }
        if self.loot.iter().all(|&w| w == 0) {
            self.loot = def;
        }
    }
}

impl Config {
    /// apply a rules block: (key, value) pairs (DESIGN.md "Mods"); unknown keys are ignored
    pub fn apply_rules(&mut self, kv: &[(u32, i32)]) {
        let u = |v: i32| v.max(0) as u32;
        // the stage count first, so per-stage keys land in the resized table
        for &(k, v) in kv {
            if k == 7 {
                if v <= 0 {
                    // no stages: the default storm
                    self.br.stages = DEFAULT_STAGES.to_vec();
                } else {
                    let n = (v as usize).min(MAX_STAGES);
                    let last = *self.br.stages.last().unwrap_or(&DEFAULT_STAGES[4]);
                    self.br.stages.resize(n, last);
                }
            }
        }
        for &(k, v) in kv {
            match k {
                1 => self.match_tics = u(v),
                2 => self.br.lobby_tics = u(v),
                3 => self.br.drop_alt = v,
                4 => self.br.start_bullets = v,
                5 => self.br.vehicles = v != 0,
                6 => self.br.supply = v != 0,
                8..=39 => {
                    let (i, f) = (((k - 8) / 4) as usize, ((k - 8) % 4) as usize);
                    if i < self.br.stages.len() {
                        self.br.stages[i][f] = v;
                    }
                }
                64..=99 => {
                    let i = (k - 64) as usize;
                    if i < self.br.loot.len() {
                        self.br.loot[i] = v;
                    }
                }
                100 => self.round_tics = u(v),
                101 => self.freeze_tics = u(v),
                102 => self.rounds_to_win = u(v),
                103 => self.tickets = u(v),
                104 => self.friendly_fire = v != 0,
                _ => {}
            }
        }
    }
}

/// The zone. Circles are (x, y, radius), fixed point.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Zone {
    /// 0 before PH_PLAY, 1..n, n+1 closed
    pub stage: i32,
    pub state: i32,
    /// tics until the state ends
    pub left: i32,
    pub x: Fixed,
    pub y: Fixed,
    pub r: Fixed,
    /// the circle the current shrink started from
    pub fx: Fixed,
    pub fy: Fixed,
    pub fr: Fixed,
    pub nx: Fixed,
    pub ny: Fixed,
    pub nr: Fixed,
    /// stage-0 radius
    pub r0: Fixed,
    /// tics since PH_PLAY began (zone damage every 35)
    pub clock: u32,
    /// the playfield's bounding box (x0, y0, x1, y1), fixed: the lobby is not in it
    pub bx0: Fixed,
    pub by0: Fixed,
    pub bx1: Fixed,
    pub by1: Fixed,
}

/// A supply drop: announced (state 1), then landed (2) as a supply crate.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Supply {
    pub x: Fixed,
    pub y: Fixed,
    pub state: i32,
    pub timer: i32,
    pub mo: MRef,
}

pub fn isqrt(n: i64) -> i64 {
    if n <= 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

/// squared distance in 1/16 units (no overflow on the largest maps)
#[inline]
pub fn dist2(x1: Fixed, y1: Fixed, x2: Fixed, y2: Fixed) -> i64 {
    let dx = (x2 as i64 - x1 as i64) >> 12;
    let dy = (y2 as i64 - y1 as i64) >> 12;
    dx * dx + dy * dy
}

/// is (x, y) inside the circle (cx, cy, r)?
#[inline]
pub fn inside(x: Fixed, y: Fixed, cx: Fixed, cy: Fixed, r: Fixed) -> bool {
    let rr = (r as i64) >> 12;
    dist2(x, y, cx, cy) <= rr * rr
}

/// Loot table rows: (default weight in half-percent units, things spawned). The row index
/// is the rules key 64 + i.
pub const LOOT: [(i32, &[usize]); 21] = [
    (30, &[mt::MISC2, mt::MISC2, mt::MISC2]), // 0 health bonus x3
    (30, &[mt::MISC3, mt::MISC3, mt::MISC3]), // 1 armor bonus x3
    (20, &[mt::MISC10]),                      // 2 stimpack
    (12, &[mt::MISC11]),                      // 3 medikit
    (10, &[mt::MISC0]),                       // 4 green armor
    (2, &[mt::MISC1]),                        // 5 blue armor
    (16, &[mt::SHOTGUN, mt::MISC22]),         // 6 shotgun + shells
    (10, &[mt::SUPERSHOTGUN]),                // 7
    (14, &[mt::CHAINGUN]),                    // 8
    (8, &[mt::MISC27]),                       // 9 rocket launcher
    (6, &[mt::MISC28]),                       // 10 plasma gun
    (1, &[mt::MISC25]),                       // 11 BFG
    (12, &[mt::MISC17]),                      // 12 box of bullets
    (10, &[mt::MISC23]),                      // 13 box of shells
    (6, &[mt::MISC19]),                       // 14 box of rockets
    (4, &[mt::MISC20]),                       // 15 cell
    (6, &[mt::MISC24]),                       // 16 backpack
    (4, &[mt::MISC13]),                       // 17 berserk
    (1, &[mt::MISC12]),                       // 18 soulsphere
    (10, &[mt::SNIPERRIFLE]),                 // 19 sniper rifle
    (16, &[mt::GRENADEPACK]),                 // 20 grenade pack
];
/// the first LOOT_HEALTH rows are the health / armor ones
const LOOT_HEALTH: usize = 6;
/// supply crates: the rare items, equal odds
const SUPPLY_LOOT: [&[usize]; 8] = [
    &[mt::SNIPERRIFLE],
    &[mt::MISC25],
    &[mt::MISC1],
    &[mt::MEGA],
    &[mt::MISC12],
    &[mt::MISC28],
    &[mt::MISC27, mt::MISC19],
    &[mt::GRENADEPACK, mt::GRENADEPACK, mt::GRENADEPACK],
];

impl World {
    #[inline]
    pub fn is_br(&self) -> bool {
        self.mode() == MODE_BR
    }

    /// zoom held in battle royale (pistol/chaingun accuracy, marksman pistol, half speed)
    #[inline]
    pub fn zoomed(&self, slot: usize) -> bool {
        self.is_br() && self.players[slot].cmd.buttons & BT_ZOOM != 0
    }

    fn stage_count(&self) -> i32 {
        self.g.cfg.br.stages.len() as i32
    }

    /// the playfield box: every vertex, or (with a lobby island) the spawn spots + 256
    fn playfield_box(&self) -> (i64, i64, i64, i64) {
        let map = &self.map;
        let (mut x0, mut y0, mut x1, mut y1) = (i64::MAX, i64::MAX, i64::MIN, i64::MIN);
        if !map.lobby_spots.is_empty() && !map.spawn_spots.is_empty() {
            for s in &map.spawn_spots {
                x0 = x0.min(((s.x as i64) - 256) << FRACBITS);
                y0 = y0.min(((s.y as i64) - 256) << FRACBITS);
                x1 = x1.max(((s.x as i64) + 256) << FRACBITS);
                y1 = y1.max(((s.y as i64) + 256) << FRACBITS);
            }
        } else {
            for v in &map.vertexes {
                x0 = x0.min(v.x as i64);
                y0 = y0.min(v.y as i64);
                x1 = x1.max(v.x as i64);
                y1 = y1.max(v.y as i64);
            }
        }
        if x0 > x1 {
            return (0, 0, 0, 0);
        }
        (x0, y0, x1, y1)
    }

    /// stage 0: the whole playfield; the first target circle picked (the clock waits for
    /// PH_PLAY)
    pub fn zone_reset(&mut self) {
        let mut z = Zone::default();
        self.g.supply = Supply::default();
        if self.is_br() && !self.map.vertexes.is_empty() {
            let (x0, y0, x1, y1) = self.playfield_box();
            z.bx0 = x0 as Fixed;
            z.by0 = y0 as Fixed;
            z.bx1 = x1 as Fixed;
            z.by1 = y1 as Fixed;
            z.x = ((x0 + x1) / 2) as Fixed;
            z.y = ((y0 + y1) / 2) as Fixed;
            let (w, h) = ((x1 - x0) >> FRACBITS, (y1 - y0) >> FRACBITS);
            let half = isqrt(w * w + h * h) / 2 + 1;
            z.r = (half << FRACBITS).min(i32::MAX as i64) as Fixed;
            z.r0 = z.r;
            z.stage = 0;
            z.state = ZS_WAIT;
            z.left = self.g.cfg.br.stages[0][0];
            (z.fx, z.fy, z.fr) = (z.x, z.y, z.r);
            self.g.zone = z;
            self.zone_pick_next(0);
        } else {
            self.g.zone = z;
        }
    }

    /// a P_Random spawn spot within `r` of (cx, cy), None if there is none
    pub fn spot_within(&mut self, cx: Fixed, cy: Fixed, r: Fixed) -> Option<(Fixed, Fixed)> {
        let map = self.map.clone();
        let cands: Vec<usize> = (0..map.spawn_spots.len())
            .filter(|&i| {
                let s = map.spawn_spots[i];
                r >= 0 && inside((s.x as i32) << FRACBITS, (s.y as i32) << FRACBITS, cx, cy, r)
            })
            .collect();
        if cands.is_empty() {
            return None;
        }
        let k = ((self.p_random() << 8) | self.p_random()) as usize;
        let s = map.spawn_spots[cands[k % cands.len()]];
        Some(((s.x as i32) << FRACBITS, (s.y as i32) << FRACBITS))
    }

    /// the next circle for stage index `si` (0-based): inside the current one, centred on a
    /// spawn spot within r_cur - r_next of the current centre (P_Random), else the same centre
    fn zone_pick_next(&mut self, si: usize) {
        let z = self.g.zone;
        let nr = ((z.r0 as i64) * self.g.cfg.br.stages[si][2] as i64 / 1000) as Fixed;
        let (nx, ny) = self.spot_within(z.x, z.y, z.r - nr).unwrap_or((z.x, z.y));
        let zm = &mut self.g.zone;
        zm.nx = nx;
        zm.ny = ny;
        zm.nr = nr;
    }

    fn zone_event(&mut self) {
        let z = self.g.zone;
        self.emit(EV_ZONE, z.stage, z.state, z.left, z.x, z.y, 0, 0);
    }

    /// damage per second outside the zone now
    pub fn zone_damage(&self) -> i32 {
        let z = &self.g.zone;
        let st = &self.g.cfg.br.stages;
        if z.stage <= 0 || st.is_empty() {
            0
        } else {
            st[(z.stage as usize - 1).min(st.len() - 1)][3]
        }
    }

    /// PH_PLAY just began: stage 1 starts waiting
    pub fn zone_start(&mut self) {
        let w0 = self.g.cfg.br.stages[0][0];
        let z = &mut self.g.zone;
        z.stage = 1;
        z.state = ZS_WAIT;
        z.left = w0;
        z.clock = 0;
        self.zone_event();
    }

    /// one PH_PLAY tic of the zone: advance, then hurt whoever is outside
    pub fn zone_tick(&mut self) {
        {
            let z = &mut self.g.zone;
            z.clock = z.clock.wrapping_add(1);
        }
        let n = self.stage_count();
        let z = self.g.zone;
        if z.state != ZS_CLOSED {
            let si = (z.stage.clamp(1, n) - 1) as usize;
            let left = z.left - 1;
            self.g.zone.left = left;
            if z.state == ZS_SHRINK {
                let total = self.g.cfg.br.stages[si][1].max(1) as i64;
                let done = total - left as i64;
                let lerp = |a: Fixed, b: Fixed| (a as i64 + (b as i64 - a as i64) * done / total) as Fixed;
                let zm = &mut self.g.zone;
                zm.x = lerp(z.fx, z.nx);
                zm.y = lerp(z.fy, z.ny);
                zm.r = lerp(z.fr, z.nr);
            }
            if left <= 0 {
                if z.state == ZS_WAIT {
                    let shrink = self.g.cfg.br.stages[si][1];
                    let zm = &mut self.g.zone;
                    zm.state = ZS_SHRINK;
                    zm.left = shrink;
                    (zm.fx, zm.fy, zm.fr) = (zm.x, zm.y, zm.r);
                } else {
                    {
                        let zm = &mut self.g.zone;
                        (zm.x, zm.y, zm.r) = (zm.nx, zm.ny, zm.nr);
                        (zm.fx, zm.fy, zm.fr) = (zm.x, zm.y, zm.r);
                    }
                    if si as i32 == n - 1 {
                        let zm = &mut self.g.zone;
                        zm.stage = n + 1;
                        zm.state = ZS_CLOSED;
                        zm.left = 0;
                    } else {
                        let wait = self.g.cfg.br.stages[si + 1][0];
                        let zm = &mut self.g.zone;
                        zm.stage += 1;
                        zm.state = ZS_WAIT;
                        zm.left = wait;
                        self.zone_pick_next(si + 1);
                        let stage = self.g.zone.stage;
                        if (2..=4).contains(&stage) && self.g.cfg.br.supply {
                            self.supply_announce(stage);
                        }
                    }
                }
                self.zone_event();
            }
        }
        self.supply_tick();
        // damage outside the circle, every second of play (bodies only: skydivers are safe)
        if self.g.zone.clock.is_multiple_of(35) {
            let dmg = self.zone_damage();
            let z = self.g.zone;
            for s in 0..self.players.len() {
                if self.players[s].playerstate != PST_LIVE {
                    continue;
                }
                let h = match self.deref(self.players[s].mo) {
                    Some(h) => h,
                    None => continue,
                };
                let (x, y) = {
                    let m = self.mo(h);
                    (m.x, m.y)
                };
                if dmg > 0 && (z.state == ZS_CLOSED || !inside(x, y, z.x, z.y, z.r)) {
                    self.damage_mobj(h, NONE, NONE, dmg, MOD_ZONE);
                }
            }
        }
    }

    // ------------------------------------------------------------------ supply drops
    fn supply_announce(&mut self, stage: i32) {
        let z = self.g.zone;
        let (x, y) = self.spot_within(z.nx, z.ny, z.nr).unwrap_or((z.nx, z.ny));
        self.g.supply = Supply { x, y, state: 1, timer: SUPPLY_WARN_TICS, mo: MRef::NULL };
        self.emit(EV_SUPPLY, stage, SUPPLY_WARN_TICS, 0, x, y, 0, 0);
    }

    fn supply_tick(&mut self) {
        let s = self.g.supply;
        match s.state {
            1 => {
                let t = s.timer - 1;
                self.g.supply.timer = t;
                // lands when the spot is clear (a few seconds' grace, then anyway)
                if t <= 0 && (self.spot_clear(s.x, s.y, 24 * FRACUNIT) || t < -35 * 5) {
                    let c = self.spawn_mobj(s.x, s.y, ONFLOORZ, mt::CRATE);
                    self.mo_mut(c).flags |= MF_SUPPLY;
                    let z = self.mo(c).z;
                    self.start_sound_at(s.x, s.y, z, sfx::barexp);
                    let r = self.mref(c);
                    let sp = &mut self.g.supply;
                    sp.state = 2;
                    sp.mo = r;
                }
            }
            2 => {
                if self.deref(s.mo).is_none() {
                    self.g.supply = Supply::default();
                }
            }
            _ => {}
        }
    }

    /// world_view_match battle royale words (zeros outside battle royale)
    pub fn br_view(&self) -> [i32; BR_WORDS] {
        if !self.is_br() {
            return [0; BR_WORDS];
        }
        let z = &self.g.zone;
        let alive = self.br_alive().len() as i32;
        let stage = z.stage.max(1);
        let sh = &self.g.ship;
        let (left, sx, sy, dx, dy) = match self.g.phase {
            PH_LOBBY => (self.g.phase_left as i32, 0, 0, 0, 0),
            PH_DROP => (sh.left, sh.x, sh.y, sh.dx, sh.dy),
            _ => (0, 0, 0, 0, 0),
        };
        let su = &self.g.supply;
        let dps = self.zone_damage().max(self.g.cfg.br.stages[0][3]);
        [z.x, z.y, z.r, z.nx, z.ny, z.nr, stage, z.state, z.left, alive, dps, left, sx, sy, dx, dy, su.x, su.y, su.state]
    }

    /// is this player still in the match (a body, in the ship or skydiving)?
    pub fn br_in_play(&self, slot: usize) -> bool {
        let p = &self.players[slot];
        p.playerstate == PST_LIVE && (self.deref(p.mo).is_some() || (1..=3).contains(&p.air))
    }

    /// players still in the match
    pub fn br_alive(&self) -> Vec<usize> {
        (0..self.players.len()).filter(|&i| self.br_in_play(i)).collect()
    }

    // ------------------------------------------------------------------ crates
    /// the nearest thing of `type_` within reach in front of a body (±45°, in sight)
    pub fn usable_in_reach(&mut self, h: u32, type_: usize) -> Option<u32> {
        let (x, y, z, angle) = {
            let m = self.mo(h);
            (m.x, m.y, m.z, m.angle)
        };
        let map = self.map.clone();
        let reach = (USE_REACH << FRACBITS) + info(type_).radius;
        let xl = (x - reach - map.bmaporgx) >> MAPBLOCKSHIFT;
        let xh = (x + reach - map.bmaporgx) >> MAPBLOCKSHIFT;
        let yl = (y - reach - map.bmaporgy) >> MAPBLOCKSHIFT;
        let yh = (y + reach - map.bmaporgy) >> MAPBLOCKSHIFT;
        let mut best: Option<(i64, u32)> = None;
        for by in yl..=yh {
            for bx in xl..=xh {
                if bx < 0 || by < 0 || bx >= map.bmapwidth || by >= map.bmapheight {
                    continue;
                }
                let mut t = self.blocklinks[(by * map.bmapwidth + bx) as usize];
                while t != NONE {
                    let m = self.mo(t);
                    let next = m.bnext;
                    if m.type_ as usize == type_ && m.health > 0 {
                        let d2 = dist2(x, y, m.x, m.y);
                        let rr = (reach as i64) >> 12;
                        let a = point_to_angle2(x, y, m.x, m.y).wrapping_sub(angle) as i32;
                        let zok = m.z < z + 64 * FRACUNIT && m.z + m.height > z;
                        if d2 <= rr * rr && a.unsigned_abs() <= USE_CONE && zok && best.is_none_or(|(bd, _)| d2 < bd) {
                            best = Some((d2, t));
                        }
                    }
                    t = next;
                }
            }
        }
        let (_, c) = best?;
        if self.check_sight(h, c) {
            Some(c)
        } else {
            None
        }
    }

    /// *use* pressed: open the crate this player faces within reach; true if one opened
    pub fn use_crate(&mut self, slot: usize) -> bool {
        if self.g.phase == PH_LOBBY {
            return false;
        }
        let h = match self.deref(self.players[slot].mo) {
            Some(h) => h,
            None => return false,
        };
        match self.usable_in_reach(h, mt::CRATE) {
            Some(c) => {
                self.open_crate(c, slot as i32);
                true
            }
            None => false,
        }
    }

    pub fn crate_in_reach(&mut self, h: u32) -> Option<u32> {
        self.usable_in_reach(h, mt::CRATE)
    }

    fn spill(&mut self, x: Fixed, y: Fixed, cz: Fixed, things: &[usize]) -> i32 {
        let mut n = 0;
        for &t in things {
            let it = self.spawn_mobj(x, y, cz, t);
            let mx = ((self.p_random() - 128) * 5 * FRACUNIT) >> 7;
            let my = ((self.p_random() - 128) * 5 * FRACUNIT) >> 7;
            let mz = 4 * FRACUNIT + (self.p_random() << 10);
            let m = self.mo_mut(it);
            m.flags |= MF_DROPPED;
            m.momx = mx;
            m.momy = my;
            m.momz = mz;
            n += 1;
        }
        n
    }

    /// open a crate: remove it, break sound, spill 4-7 loot entries (one always health or
    /// armor; a supply crate: 4 rare entries) with P_Random momentum; event 17
    pub fn open_crate(&mut self, c: u32, opener: i32) {
        let (x, y, z, ht, supply) = {
            let m = self.mo(c);
            (m.x, m.y, m.z, m.height, m.flags & MF_SUPPLY != 0)
        };
        self.mo_mut(c).health = 0;
        self.remove_mobj(c);
        let cz = z + ht / 2;
        self.start_sound_at(x, y, cz, sfx::pstop);
        let mut spilled = 0;
        if supply {
            for _ in 0..4 {
                let e = (self.p_random() as usize) % SUPPLY_LOOT.len();
                spilled += self.spill(x, y, cz, SUPPLY_LOOT[e]);
            }
        } else {
            let weights = self.g.cfg.br.loot.clone();
            let n = 4 + (self.p_random() & 3);
            let total_all: i32 = weights.iter().sum::<i32>().max(1);
            let total_health: i32 = weights[..LOOT_HEALTH].iter().sum::<i32>();
            for k in 0..n {
                let first = k == 0 && total_health > 0;
                let total = if first { total_health } else { total_all };
                // 24 random bits: the total can pass 65535 (rows go up to 10000 each)
                let mut r = ((self.p_random() << 16) | (self.p_random() << 8) | self.p_random()) % total;
                let mut e = 0;
                while e + 1 < LOOT.len() && r >= weights[e] {
                    r -= weights[e];
                    e += 1;
                }
                spilled += self.spill(x, y, cz, LOOT[e].1);
            }
        }
        self.emit(EV_CRATE, opener, spilled, supply as i32, x, y, cz, 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isqrt_exact() {
        for n in [0i64, 1, 2, 3, 4, 15, 16, 17, 1 << 40, (1 << 40) + 12345, 999_999_999_999] {
            let r = isqrt(n);
            assert!(r * r <= n && (r + 1) * (r + 1) > n, "{}", n);
        }
    }
    #[test]
    fn rules_block() {
        let mut c = Config::mode(MODE_BR, 64);
        c.apply_rules(&[(7, 2), (8, 100), (13, 500), (64, 0), (5, 0), (2, 70), (999, 5)]);
        let c = c.with_defaults();
        assert_eq!(c.br.stages.len(), 2);
        assert_eq!(c.br.stages[0][0], 100);
        assert_eq!(c.br.stages[1][1], 500);
        assert_eq!(c.br.loot[0], 0);
        assert!(!c.br.vehicles);
        assert_eq!(c.br.lobby_tics, 70);
    }
}
