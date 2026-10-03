// Binary world (de)serialization and hashing.
// Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.
//
// Format: "DSIM" magic, u32 format version, u32 SIM_VERSION, u32 map hash, then every
// field of the world in a fixed order, little-endian. Scratch state (p_map.c statics,
// validcount) is not part of it; deserialize(serialize(w)) steps bit-identically to w.

use std::collections::VecDeque;
use std::rc::Rc;

use crate::bots::{Bot, Step};
use crate::map::{Map, MapThing};
use crate::random::{BotRng, PRandom};
use crate::specials::*;
use crate::game::{CapPoint, Config, Game};
use crate::world::*;

pub const FORMAT_VERSION: u32 = 2;

pub struct Writer {
    pub buf: Vec<u8>,
}
pub struct Reader<'a> {
    pub b: &'a [u8],
    pub p: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        if self.p + n > self.b.len() {
            return None;
        }
        let s = &self.b[self.p..self.p + n];
        self.p += n;
        Some(s)
    }
}

pub trait Ser: Sized {
    fn put(&self, w: &mut Writer);
    fn get(r: &mut Reader) -> Option<Self>;
}

macro_rules! ser_prim {
    ($t:ty, $n:expr) => {
        impl Ser for $t {
            #[inline]
            fn put(&self, w: &mut Writer) {
                w.buf.extend_from_slice(&self.to_le_bytes());
            }
            #[inline]
            fn get(r: &mut Reader) -> Option<Self> {
                let s = r.take($n)?;
                let mut a = [0u8; $n];
                a.copy_from_slice(s);
                Some(<$t>::from_le_bytes(a))
            }
        }
    };
}
ser_prim!(u8, 1);
ser_prim!(i8, 1);
ser_prim!(u16, 2);
ser_prim!(i16, 2);
ser_prim!(u32, 4);
ser_prim!(i32, 4);
ser_prim!(i64, 8);

impl Ser for bool {
    fn put(&self, w: &mut Writer) {
        w.buf.push(*self as u8);
    }
    fn get(r: &mut Reader) -> Option<Self> {
        Some(u8::get(r)? != 0)
    }
}

impl<T: Ser> Ser for Vec<T> {
    fn put(&self, w: &mut Writer) {
        (self.len() as u32).put(w);
        for x in self {
            x.put(w);
        }
    }
    fn get(r: &mut Reader) -> Option<Self> {
        let n = u32::get(r)? as usize;
        if n > r.b.len() {
            return None;
        }
        let mut v = Vec::with_capacity(n);
        for _ in 0..n {
            v.push(T::get(r)?);
        }
        Some(v)
    }
}
impl<T: Ser> Ser for VecDeque<T> {
    fn put(&self, w: &mut Writer) {
        (self.len() as u32).put(w);
        for x in self {
            x.put(w);
        }
    }
    fn get(r: &mut Reader) -> Option<Self> {
        Some(Vec::<T>::get(r)?.into())
    }
}
impl<T: Ser> Ser for Option<T> {
    fn put(&self, w: &mut Writer) {
        match self {
            Some(x) => {
                1u8.put(w);
                x.put(w);
            }
            None => 0u8.put(w),
        }
    }
    fn get(r: &mut Reader) -> Option<Self> {
        match u8::get(r)? {
            0 => Some(None),
            1 => Some(Some(T::get(r)?)),
            _ => None,
        }
    }
}
impl<T: Ser + Copy + Default, const N: usize> Ser for [T; N] {
    fn put(&self, w: &mut Writer) {
        for x in self {
            x.put(w);
        }
    }
    fn get(r: &mut Reader) -> Option<Self> {
        let mut a = [T::default(); N];
        for x in a.iter_mut() {
            *x = T::get(r)?;
        }
        Some(a)
    }
}
impl<A: Ser, B: Ser> Ser for (A, B) {
    fn put(&self, w: &mut Writer) {
        self.0.put(w);
        self.1.put(w);
    }
    fn get(r: &mut Reader) -> Option<Self> {
        Some((A::get(r)?, B::get(r)?))
    }
}

macro_rules! ser_struct {
    ($t:ident { $($f:ident),* $(,)? }) => {
        impl Ser for $t {
            fn put(&self, w: &mut Writer) {
                $( self.$f.put(w); )*
            }
            fn get(r: &mut Reader) -> Option<Self> {
                Some($t { $( $f: Ser::get(r)?, )* })
            }
        }
    };
}

macro_rules! ser_enum {
    ($t:ident { $($v:ident = $n:expr),* $(,)? }) => {
        impl Ser for $t {
            fn put(&self, w: &mut Writer) {
                let x: u8 = match self { $( $t::$v => $n, )* };
                x.put(w);
            }
            fn get(r: &mut Reader) -> Option<Self> {
                match u8::get(r)? { $( $n => Some($t::$v), )* _ => None }
            }
        }
    };
}

ser_struct!(MRef { h, id });
ser_struct!(MapThing { x, y, angle, type_, options });
ser_struct!(Mobj { id, x, y, z, snext, sprev, bnext, bprev, angle, sprite, frame, subsector, floorz, ceilingz, radius, height, momx, momy, momz, type_, tics, state, flags, health, movedir, movecount, target, tracer, reactiontime, threshold, player, lastlook, spawnpoint });
ser_struct!(Cmd { yaw, pitch, forward, side, buttons });
ser_struct!(Psp { state, tics, sx, sy });
ser_struct!(Sector { floorheight, ceilingheight, floorpic, ceilingpic, lightlevel, special, specialdata, thinglist });
ser_struct!(Button { line, where_, btexture, btimer });
ser_struct!(Event { kind, a, b, c, x, y, z, d });
ser_struct!(PRandom { index });
ser_struct!(BotRng { s });
ser_struct!(Step { node, px, py, kind, line });
ser_struct!(Bot {
    rng, aim_err, react, turn, aggression, path, goal_node, goal_x, goal_y, goal_item, need_plan, next_goal_tic, last_x, last_y, check_x, check_y, check_tic, stuck,
    unstick_until, unstick_side, ban_a, ban_b, ban_until, wait_tics, enemy, enemy_seen, enemy_x, enemy_y, enemy_z, react_left, err_yaw, err_pitch, err_until, strafe,
    strafe_until, fire_toggle, use_toggle, weapon_key, weapon_cooldown, respawn_delay, hurt_by, yaw, pitch, goal_point
});
ser_struct!(Player {
    slot, mo, playerstate, control, cmd, human_cmd, prev_buttons, yaw_offset, pitch, viewz, viewheight, deltaviewheight, bob, onground, health, armorpoints, armortype,
    powers, backpack, frags, deaths, readyweapon, pendingweapon, weaponowned, ammo, maxammo, attackdown, usedown, refire, damagecount, bonuscount, attacker,
    extralight, fixedcolormap, psprites, dead_tics, jump_cooldown, fresh, color, items, travelled, spawn_choice, spec_cycle, bot
});
ser_enum!(DoorType { Normal = 0, Close30ThenOpen = 1, Close = 2, Open = 3, RaiseIn5Mins = 4, BlazeRaise = 5, BlazeOpen = 6, BlazeClose = 7 });
ser_struct!(Door { type_, sector, topheight, speed, direction, topwait, topcountdown });
ser_enum!(PlatType { PerpetualRaise = 0, DownWaitUpStay = 1, RaiseAndChange = 2, RaiseToNearestAndChange = 3, BlazeDWUS = 4 });
ser_enum!(PlatStatus { Up = 0, Down = 1, Waiting = 2, InStasis = 3 });
ser_struct!(Plat { sector, speed, low, high, wait, count, status, oldstatus, crush, tag, type_ });
ser_enum!(FloorType {
    LowerFloor = 0, LowerFloorToLowest = 1, TurboLower = 2, RaiseFloor = 3, RaiseFloorToNearest = 4, RaiseToTexture = 5, LowerAndChange = 6, RaiseFloor24 = 7,
    RaiseFloor24AndChange = 8, RaiseFloorCrush = 9, RaiseFloorTurbo = 10, DonutRaise = 11, RaiseFloor512 = 12, Stairs = 13
});
ser_struct!(FloorMove { type_, crush, sector, direction, newspecial, texture, floordestheight, speed });
ser_enum!(CeilingType { LowerToFloor = 0, RaiseToHighest = 1, LowerAndCrush = 2, CrushAndRaise = 3, FastCrushAndRaise = 4, SilentCrushAndRaise = 5 });
ser_struct!(CapPoint { owner, progress, flags });
ser_struct!(Ceiling { type_, sector, bottomheight, topheight, speed, crush, direction, tag, olddirection });

impl Ser for SThinker {
    fn put(&self, w: &mut Writer) {
        match self {
            SThinker::Door(d) => {
                0u8.put(w);
                d.put(w)
            }
            SThinker::Plat(d) => {
                1u8.put(w);
                d.put(w)
            }
            SThinker::Floor(d) => {
                2u8.put(w);
                d.put(w)
            }
            SThinker::Ceiling(d) => {
                3u8.put(w);
                d.put(w)
            }
        }
    }
    fn get(r: &mut Reader) -> Option<Self> {
        Some(match u8::get(r)? {
            0 => SThinker::Door(Door::get(r)?),
            1 => SThinker::Plat(Plat::get(r)?),
            2 => SThinker::Floor(FloorMove::get(r)?),
            3 => SThinker::Ceiling(Ceiling::get(r)?),
            _ => return None,
        })
    }
}

impl World {
    pub fn serialize_into(&self, out: &mut Vec<u8>) {
        let mut w = Writer { buf: std::mem::take(out) };
        w.buf.clear();
        w.buf.extend_from_slice(b"DSIM");
        FORMAT_VERSION.put(&mut w);
        crate::SIM_VERSION.put(&mut w);
        // config and the map rotation, by name + content hash
        let c = &self.g.cfg;
        for x in [c.mode, c.slots, c.match_tics, c.inter_tics, c.round_tics, c.freeze_tics, c.rounds_to_win, c.tickets, c.friendly_fire as u32] {
            x.put(&mut w);
        }
        (self.g.maps.len() as u32).put(&mut w);
        for m in &self.g.maps {
            let name = m.name.as_bytes();
            (name.len() as u8).put(&mut w);
            w.buf.extend_from_slice(name);
            m.hash.put(&mut w);
        }
        self.g.map_index.put(&mut w);
        self.g.match_index.put(&mut w);
        self.g.phase.put(&mut w);
        self.g.phase_left.put(&mut w);
        self.g.match_tic.put(&mut w);
        self.g.team_score.put(&mut w);
        self.g.round.put(&mut w);
        self.g.winner.put(&mut w);
        self.g.points.put(&mut w);
        self.g.low_sent.put(&mut w);
        self.g.pending.put(&mut w);
        self.tic.put(&mut w);
        self.leveltime.put(&mut w);
        self.rng.put(&mut w);
        self.mobjs.put(&mut w);
        self.mobj_free.put(&mut w);
        self.next_id.put(&mut w);
        self.sthinkers.put(&mut w);
        self.sthinker_free.put(&mut w);
        self.order.put(&mut w);
        self.dirty_order.put(&mut w);
        self.pending_free_m.put(&mut w);
        self.pending_free_s.put(&mut w);
        self.blocklinks.put(&mut w);
        self.sectors.put(&mut w);
        self.line_special.put(&mut w);
        self.side_tex.put(&mut w);
        self.buttons.put(&mut w);
        self.activeplats.put(&mut w);
        self.activeceilings.put(&mut w);
        self.players.put(&mut w);
        self.item_queue.put(&mut w);
        self.bodyque.put(&mut w);
        self.bodyqueslot.put(&mut w);
        // events are output of the last tic, not state (their map ids are local)
        *out = w.buf;
    }

    pub fn serialize(&self) -> Vec<u8> {
        let mut v = Vec::new();
        self.serialize_into(&mut v);
        v
    }

    /// a snapshot of a world whose rotation is just `map`
    pub fn deserialize_one(map: Rc<Map>, bytes: &[u8]) -> Option<World> {
        World::deserialize(&[map], bytes)
    }

    /// `registry`: every loaded map; the snapshot's rotation is resolved against it by name
    /// and content hash (None if a map is missing or the data is bad)
    pub fn deserialize(registry: &[Rc<Map>], bytes: &[u8]) -> Option<World> {
        let mut r = Reader { b: bytes, p: 0 };
        if r.take(4)? != b"DSIM" {
            return None;
        }
        if u32::get(&mut r)? != FORMAT_VERSION || u32::get(&mut r)? != crate::SIM_VERSION {
            return None;
        }
        let mut cw = [0u32; 9];
        for x in cw.iter_mut() {
            *x = u32::get(&mut r)?;
        }
        let cfg = Config { mode: cw[0], slots: cw[1], match_tics: cw[2], inter_tics: cw[3], round_tics: cw[4], freeze_tics: cw[5], rounds_to_win: cw[6], tickets: cw[7], friendly_fire: cw[8] != 0 };
        if cfg.clone().with_defaults() != cfg {
            return None;
        }
        let nmaps = u32::get(&mut r)? as usize;
        if nmaps == 0 || nmaps > 256 {
            return None;
        }
        let mut maps = Vec::with_capacity(nmaps);
        for _ in 0..nmaps {
            let len = u8::get(&mut r)? as usize;
            let name = r.take(len)?.to_vec();
            let hash = u32::get(&mut r)?;
            let m = registry.iter().find(|m| m.hash == hash && m.name.as_bytes() == &name[..])?;
            maps.push(m.clone());
        }
        let mut g = Game::new(cfg, maps);
        g.map_index = Ser::get(&mut r)?;
        if g.map_index as usize >= nmaps {
            return None;
        }
        g.match_index = Ser::get(&mut r)?;
        g.phase = Ser::get(&mut r)?;
        g.phase_left = Ser::get(&mut r)?;
        g.match_tic = Ser::get(&mut r)?;
        g.team_score = Ser::get(&mut r)?;
        g.round = Ser::get(&mut r)?;
        g.winner = Ser::get(&mut r)?;
        g.points = Ser::get(&mut r)?;
        g.low_sent = Ser::get(&mut r)?;
        g.pending = Ser::get(&mut r)?;
        let map = g.maps[g.map_index as usize].clone();
        if g.phase > crate::game::PH_INTER || (cfg_mode_war(&g) && g.points.len() != map.cap_points.len()) || (!cfg_mode_war(&g) && !g.points.is_empty()) {
            return None;
        }
        let nlines = map.lines.len();
        let w = World {
            map: map.clone(),
            tic: Ser::get(&mut r)?,
            leveltime: Ser::get(&mut r)?,
            rng: Ser::get(&mut r)?,
            mobjs: Ser::get(&mut r)?,
            mobj_free: Ser::get(&mut r)?,
            next_id: Ser::get(&mut r)?,
            sthinkers: Ser::get(&mut r)?,
            sthinker_free: Ser::get(&mut r)?,
            order: Ser::get(&mut r)?,
            dirty_order: Ser::get(&mut r)?,
            pending_free_m: Ser::get(&mut r)?,
            pending_free_s: Ser::get(&mut r)?,
            blocklinks: Ser::get(&mut r)?,
            sectors: Ser::get(&mut r)?,
            line_special: Ser::get(&mut r)?,
            side_tex: Ser::get(&mut r)?,
            buttons: Ser::get(&mut r)?,
            activeplats: Ser::get(&mut r)?,
            activeceilings: Ser::get(&mut r)?,
            players: Ser::get(&mut r)?,
            item_queue: Ser::get(&mut r)?,
            bodyque: Ser::get(&mut r)?,
            bodyqueslot: Ser::get(&mut r)?,
            events: Vec::new(),
            g,
            sc: Scratch { line_valid: vec![0; nlines], ..Default::default() },
        };
        if r.p != bytes.len() {
            return None;
        }
        if w.players.len() != w.g.cfg.slots as usize {
            return None;
        }
        // structural validation so bad data cannot cause out-of-bounds panics later
        if w.sectors.len() != map.sectors.len() || w.line_special.len() != nlines || w.side_tex.len() != map.sides.len() {
            return None;
        }
        if w.blocklinks.len() != (map.bmapwidth * map.bmapheight) as usize {
            return None;
        }
        let nm = w.mobjs.len() as u32;
        let ns = w.sthinkers.len() as u32;
        let ok_m = |h: u32| h == NONE || (h < nm && w.mobjs[h as usize].is_some());
        for m in w.mobjs.iter().flatten() {
            if !ok_m(m.snext) || !ok_m(m.sprev) || !ok_m(m.bnext) || !ok_m(m.bprev) || m.subsector as usize >= map.subsectors.len() || m.state as usize >= crate::info::NUMSTATES || m.type_ as usize >= crate::info::NUMMOBJTYPES {
                return None;
            }
            if m.player >= w.players.len() as i32 {
                return None;
            }
        }
        for &o in &w.order {
            if o & SPEC_FLAG != 0 {
                if (o & !SPEC_FLAG) >= ns {
                    return None;
                }
            } else if o >= nm {
                return None;
            }
        }
        for s in &w.sectors {
            if !ok_m(s.thinglist) || (s.specialdata != NONE && s.specialdata >= ns) {
                return None;
            }
        }
        // the intrusive lists must be well-formed (no cycles, consistent back links)
        let walk = |heads: &mut dyn Iterator<Item = u32>, next: &dyn Fn(&Mobj) -> u32, prev: &dyn Fn(&Mobj) -> u32| -> bool {
            let mut seen = vec![false; nm as usize];
            for head in heads {
                let mut h = head;
                let mut p = NONE;
                while h != NONE {
                    if h >= nm || seen[h as usize] {
                        return false;
                    }
                    seen[h as usize] = true;
                    let m = match &w.mobjs[h as usize] {
                        Some(m) => m,
                        None => return false,
                    };
                    if prev(m) != p {
                        return false;
                    }
                    p = h;
                    h = next(m);
                }
            }
            true
        };
        if !walk(&mut w.blocklinks.iter().copied(), &|m| m.bnext, &|m| m.bprev) {
            return None;
        }
        if !walk(&mut w.sectors.iter().map(|s| s.thinglist), &|m| m.snext, &|m| m.sprev) {
            return None;
        }
        // handle bookkeeping: free lists point at empty slots, every live thinker runs once
        let mut in_order_m = vec![false; nm as usize];
        let mut in_order_s = vec![false; ns as usize];
        for &o in &w.order {
            if o & SPEC_FLAG != 0 {
                let i = (o & !SPEC_FLAG) as usize;
                if in_order_s[i] {
                    return None;
                }
                in_order_s[i] = true;
            } else {
                if in_order_m[o as usize] {
                    return None;
                }
                in_order_m[o as usize] = true;
            }
        }
        for (i, m) in w.mobjs.iter().enumerate() {
            if m.is_some() != in_order_m[i] && !w.dirty_order {
                return None;
            }
        }
        for (i, t) in w.sthinkers.iter().enumerate() {
            if t.is_some() != in_order_s[i] && !w.dirty_order {
                return None;
            }
        }
        let mut freed = vec![false; nm as usize];
        for &f in w.mobj_free.iter().chain(w.pending_free_m.iter()) {
            if f >= nm || freed[f as usize] || w.mobjs[f as usize].is_some() {
                return None;
            }
            freed[f as usize] = true;
        }
        let mut sfreed = vec![false; ns as usize];
        for &f in w.sthinker_free.iter().chain(w.pending_free_s.iter()) {
            if f >= ns || sfreed[f as usize] || w.sthinkers[f as usize].is_some() {
                return None;
            }
            sfreed[f as usize] = true;
        }
        for p in &w.players {
            let wok = |x: i32| (0..crate::info::NUMWEAPONS as i32).contains(&x) || x == crate::info::WP_NOCHANGE;
            if !wok(p.readyweapon) || p.readyweapon == crate::info::WP_NOCHANGE || !wok(p.pendingweapon) {
                return None;
            }
            if p.psprites.iter().any(|ps| ps.state < 0 || ps.state as usize >= crate::info::NUMSTATES) {
                return None;
            }
            if p.bot.path.iter().any(|st| st.node as usize >= map.subsectors.len()) || p.bot.goal_node >= map.subsectors.len() as i32 {
                return None;
            }
            if p.playerstate > PST_REBORN || p.control > CTRL_IDLE {
                return None;
            }
        }
        for t in w.sthinkers.iter().flatten() {
            let sec = match t {
                SThinker::Door(d) => d.sector,
                SThinker::Plat(d) => d.sector,
                SThinker::Floor(d) => d.sector,
                SThinker::Ceiling(d) => d.sector,
            };
            if sec as usize >= map.sectors.len() {
                return None;
            }
        }
        if w.buttons.iter().any(|b| b.line < 0 || b.line as usize >= nlines || !(0..3).contains(&b.where_)) {
            return None;
        }
        if w.activeplats.iter().chain(w.activeceilings.iter()).any(|&h| h >= ns || w.sthinkers[h as usize].is_none()) {
            return None;
        }
        if w.blocklinks.iter().any(|&b| !ok_m(b)) || w.mobj_free.iter().any(|&f| f >= nm) || w.sthinker_free.iter().any(|&f| f >= ns) {
            return None;
        }
        Some(w)
    }

    /// 32-bit hash of the whole state (over the serialized bytes)
    pub fn hash_with(&self, buf: &mut Vec<u8>) -> u32 {
        self.serialize_into(buf);
        hash_bytes(buf)
    }
}

pub fn hash_bytes(b: &[u8]) -> u32 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut chunks = b.chunks_exact(8);
    for c in &mut chunks {
        let v = u64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]);
        h = (h ^ v).wrapping_mul(0x0000_0100_0000_01b3);
        h ^= h >> 29;
    }
    for &x in chunks.remainder() {
        h = (h ^ x as u64).wrapping_mul(0x0000_0100_0000_01b3);
    }
    h ^= b.len() as u64;
    h = (h ^ (h >> 33)).wrapping_mul(0xff51_afd7_ed55_8ccd);
    h ^= h >> 33;
    (h ^ (h >> 32)) as u32
}

fn cfg_mode_war(g: &Game) -> bool {
    g.cfg.mode == crate::game::MODE_WAR
}
