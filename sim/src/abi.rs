// The wasm ABI: the only interface between the TypeScript client and the sim.
// Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.
//
// See games/doom/DESIGN.md "The wasm ABI". All functions are extern "C" / #[no_mangle];
// pointers are offsets into the wasm linear memory; everything is little-endian.

use std::cell::RefCell;
use std::rc::Rc;

use crate::info::*;
use crate::map::Map;
use crate::world::*;

struct Slot {
    world: World,
    view: Vec<u8>,
}

#[derive(Default)]
struct State {
    maps: Vec<Rc<Map>>,
    worlds: Vec<Option<Slot>>,
    buf: Vec<u8>,
    hashbuf: Vec<u8>,
    sprite_names: Vec<u8>,
    sound_names: Vec<u8>,
    tex_names: Vec<Vec<u8>>,
    flat_names: Vec<Vec<u8>>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

fn names_blob<'a>(names: impl Iterator<Item = &'a str>) -> Vec<u8> {
    // each name NUL-terminated, then one more NUL (an empty name ends the list; only the
    // sound list has an empty name, at index 0)
    let mut v = Vec::new();
    for n in names {
        v.extend_from_slice(n.as_bytes());
        v.push(0);
    }
    v.push(0);
    v
}

fn put_i32(v: &mut Vec<u8>, x: i32) {
    v.extend_from_slice(&x.to_le_bytes());
}

fn world_mut(s: &mut State, h: u32) -> Option<&mut Slot> {
    if h == 0 {
        return None;
    }
    s.worlds.get_mut(h as usize - 1).and_then(|w| w.as_mut())
}

fn add_world(s: &mut State, w: World) -> u32 {
    let slot = Slot { world: w, view: Vec::new() };
    if let Some(i) = s.worlds.iter().position(|w| w.is_none()) {
        s.worlds[i] = Some(slot);
        return i as u32 + 1;
    }
    s.worlds.push(Some(slot));
    s.worlds.len() as u32
}

// ---------------------------------------------------------------- memory
#[no_mangle]
pub extern "C" fn alloc(len: u32) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(len.max(1) as usize);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr`/`len` must come from `alloc`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: u32) {
    if ptr.is_null() {
        return;
    }
    drop(Vec::from_raw_parts(ptr, 0, len.max(1) as usize));
}

// ---------------------------------------------------------------- static data
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn map_load(ptr: *const u8, len: u32) -> i32 {
    let bytes = std::slice::from_raw_parts(ptr, len as usize);
    match Map::load(bytes) {
        Ok(mut m) => with(|s| {
            m.id = s.maps.len() as i32;
            let tex = names_blob(m.texture_names.iter().map(|x| x.as_str()));
            let flats = names_blob(m.flat_names.iter().map(|x| x.as_str()));
            s.maps.push(Rc::new(m));
            s.tex_names.push(tex);
            s.flat_names.push(flats);
            (s.maps.len() - 1) as i32
        }),
        Err(e) => e.min(-1),
    }
}

#[no_mangle]
pub extern "C" fn sim_sprite_names() -> *const u8 {
    with(|s| {
        if s.sprite_names.is_empty() {
            s.sprite_names = names_blob(SPRNAMES.iter().copied());
        }
        s.sprite_names.as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn sim_sound_names() -> *const u8 {
    with(|s| {
        if s.sound_names.is_empty() {
            s.sound_names = names_blob(SFXNAMES.iter().copied());
        }
        s.sound_names.as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn sim_version() -> u32 {
    crate::SIM_VERSION
}

#[no_mangle]
pub extern "C" fn world_map_texture_names(map_id: i32) -> *const u8 {
    with(|s| s.tex_names.get(map_id as usize).map(|v| v.as_ptr()).unwrap_or(std::ptr::null()))
}

#[no_mangle]
pub extern "C" fn world_map_flat_names(map_id: i32) -> *const u8 {
    with(|s| s.flat_names.get(map_id as usize).map(|v| v.as_ptr()).unwrap_or(std::ptr::null()))
}

// ---------------------------------------------------------------- worlds
#[no_mangle]
pub extern "C" fn world_new(map_id: i32, seed: u32, slots: u32) -> u32 {
    with(|s| {
        let map = match s.maps.get(map_id as usize) {
            Some(m) => m.clone(),
            None => return 0,
        };
        let w = World::new(map, seed, slots.clamp(1, 255) as usize);
        add_world(s, w)
    })
}

#[no_mangle]
pub extern "C" fn world_free(h: u32) {
    with(|s| {
        if h > 0 && (h as usize) <= s.worlds.len() {
            s.worlds[h as usize - 1] = None;
        }
    })
}

#[no_mangle]
pub extern "C" fn world_clone(h: u32) -> u32 {
    with(|s| {
        let w = match world_mut(s, h) {
            Some(sl) => sl.world.clone(),
            None => return 0,
        };
        add_world(s, w)
    })
}

#[no_mangle]
pub extern "C" fn world_serialize(h: u32) -> u32 {
    with(|s| {
        let mut buf = std::mem::take(&mut s.buf);
        let n = match world_mut(s, h) {
            Some(sl) => {
                sl.world.serialize_into(&mut buf);
                buf.len() as u32
            }
            None => {
                buf.clear();
                0
            }
        };
        s.buf = buf;
        n
    })
}

#[no_mangle]
pub extern "C" fn world_buf_ptr() -> *const u8 {
    with(|s| s.buf.as_ptr())
}

/// # Safety
/// `ptr` must point to `len` readable bytes.
/// The snapshot names its maps (name + content hash); they must have been map_load'ed.
#[no_mangle]
pub unsafe extern "C" fn world_deserialize(ptr: *const u8, len: u32) -> u32 {
    let bytes = std::slice::from_raw_parts(ptr, len as usize);
    with(|s| match World::deserialize(&s.maps, bytes) {
        Some(w) => add_world(s, w),
        None => 0,
    })
}

/// # Safety
/// v1 signature kept for old callers: the map id is ignored.
#[no_mangle]
pub unsafe extern "C" fn world_deserialize_map(_map_id: i32, ptr: *const u8, len: u32) -> u32 {
    world_deserialize(ptr, len)
}

/// # Safety
/// `ptr` must point to `len` bytes of u32 config words (DESIGN.md "ABI additions (v2)"):
/// [version=2, mode, slots, match_tics, intermission_tics, round_tics, freeze_tics,
///  rounds_to_win, tickets, friendly_fire, map_count, map_id × map_count, (seed)]
#[no_mangle]
pub unsafe extern "C" fn world_new_cfg(ptr: *const u32, len: u32) -> u32 {
    let n = (len / 4) as usize;
    if n < 11 || !(ptr as usize).is_multiple_of(4) {
        return 0;
    }
    let w: Vec<u32> = std::slice::from_raw_parts(ptr, n).to_vec();
    if w[0] != 2 {
        return 0;
    }
    let count = w[10] as usize;
    if count == 0 || count > n - 11 {
        return 0;
    }
    let seed = if n > 11 + count { w[11 + count] } else { 0 };
    let flags = if n > 12 + count { w[12 + count] } else { 0 };
    // the rules block after the flags word: [count, (key, value) x count]
    let mut rules: Vec<(u32, i32)> = Vec::new();
    if n > 13 + count {
        let rc = w[13 + count] as usize;
        // compare against what is left (no rc * 2 overflow on wasm32)
        if rc > (n - 14 - count) / 2 {
            return 0;
        }
        for i in 0..rc {
            rules.push((w[14 + count + 2 * i], w[15 + count + 2 * i] as i32));
        }
    }
    let mut cfg = crate::game::Config {
        mode: w[1],
        slots: w[2],
        match_tics: w[3],
        inter_tics: w[4],
        round_tics: w[5],
        freeze_tics: w[6],
        rounds_to_win: w[7],
        tickets: w[8],
        friendly_fire: w[9] != 0,
        flags,
        br: Default::default(),
    };
    cfg.apply_rules(&rules);
    with(|s| {
        let mut maps = Vec::new();
        for &id in &w[11..11 + count] {
            match s.maps.get(id as usize) {
                Some(m) => maps.push(m.clone()),
                None => return 0,
            }
        }
        let world = World::new_cfg(cfg, maps, seed);
        add_world(s, world)
    })
}

#[no_mangle]
pub extern "C" fn world_view_match(h: u32) -> *const u8 {
    with(|s| {
        let sl = match world_mut(s, h) {
            Some(sl) => sl,
            None => return std::ptr::null(),
        };
        let w = &sl.world;
        let g = &w.g;
        let v = &mut sl.view;
        v.clear();
        let alive = w.alive_counts();
        let next = &g.maps[w.next_map_index() as usize];
        for x in [
            g.cfg.mode as i32,
            g.phase as i32,
            g.phase_left as i32,
            g.match_index as i32,
            w.map.id,
            next.id,
            g.team_score[0],
            g.team_score[1],
            g.round,
            alive[0],
            alive[1],
            g.winner,
            g.points.len() as i32,
        ] {
            put_i32(v, x);
        }
        for (i, p) in g.points.iter().enumerate() {
            let (x, y, r) = w.map.cap_points[i];
            for q in [x, y, r, p.owner, p.progress * 100 / crate::game::CAP_FULL, p.flags] {
                put_i32(v, q);
            }
        }
        for q in w.boss_view() {
            put_i32(v, q);
        }
        // battle royale (BR_WORDS, zeros in the other modes)
        for q in w.br_view() {
            put_i32(v, q);
        }
        v.as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn world_hash(h: u32) -> u32 {
    with(|s| {
        let mut hb = std::mem::take(&mut s.hashbuf);
        let r = match world_mut(s, h) {
            Some(sl) => sl.world.hash_with(&mut hb),
            None => 0,
        };
        s.hashbuf = hb;
        r
    })
}

#[no_mangle]
pub extern "C" fn world_tic(h: u32) -> u32 {
    with(|s| world_mut(s, h).map(|sl| sl.world.tic).unwrap_or(0))
}

#[no_mangle]
pub extern "C" fn world_human_join(h: u32, slot: u32) {
    with(|s| {
        if let Some(sl) = world_mut(s, h) {
            sl.world.human_join(slot as usize)
        }
    })
}

#[no_mangle]
pub extern "C" fn world_human_leave(h: u32, slot: u32) {
    with(|s| {
        if let Some(sl) = world_mut(s, h) {
            sl.world.human_leave(slot as usize)
        }
    })
}

#[no_mangle]
pub extern "C" fn world_human_idle(h: u32, slot: u32) {
    with(|s| {
        if let Some(sl) = world_mut(s, h) {
            sl.world.human_idle(slot as usize)
        }
    })
}

#[no_mangle]
pub extern "C" fn world_free_slot(h: u32) -> i32 {
    with(|s| world_mut(s, h).map(|sl| sl.world.free_slot()).unwrap_or(-1))
}

#[no_mangle]
pub extern "C" fn world_set_cmd(h: u32, slot: u32, angle_hi16: u32, pitch: i32, forward: i32, side: i32, buttons: u32) {
    with(|s| {
        if let Some(sl) = world_mut(s, h) {
            sl.world.set_cmd(slot as usize, angle_hi16, pitch, forward, side, buttons)
        }
    })
}

#[no_mangle]
pub extern "C" fn world_tick(h: u32) {
    with(|s| {
        if let Some(sl) = world_mut(s, h) {
            sl.world.tick()
        }
    })
}

// ---------------------------------------------------------------- views
#[no_mangle]
pub extern "C" fn world_view_mobjs(h: u32) -> *const u8 {
    with(|s| {
        let sl = match world_mut(s, h) {
            Some(sl) => sl,
            None => return std::ptr::null(),
        };
        let w = &sl.world;
        let v = &mut sl.view;
        v.clear();
        put_i32(v, 0);
        let mut n = 0i32;
        for &o in &w.order {
            if o & SPEC_FLAG != 0 {
                continue;
            }
            let m = match &w.mobjs[o as usize] {
                Some(m) => m,
                None => continue,
            };
            let own = |p: &Player| p.mo.h == o || (m.type_ as usize == mt::PARACHUTER && p.air_mo.h == o);
            let pslot = if m.player >= 0 && w.players.get(m.player as usize).map(own).unwrap_or(false) { m.player + 1 } else { 0 };
            for x in [m.id as i32, m.x, m.y, m.z, m.angle as i32, (m.sprite & 0xffff) | (m.frame << 16), m.flags as i32, (m.type_ as i32) | (pslot << 16), m.radius, m.height, m.momx, m.momy] {
                put_i32(v, x);
            }
            n += 1;
        }
        v[0..4].copy_from_slice(&n.to_le_bytes());
        v.as_ptr()
    })
}

fn psp_word(p: &Psp) -> i32 {
    if p.state == 0 {
        return -1;
    }
    let st = crate::info::state(p.state as usize);
    (st.sprite & 0xffff) | (st.frame << 16)
}

#[no_mangle]
pub extern "C" fn world_view_player(h: u32, slot: u32) -> *const u8 {
    with(|s| {
        let sl = match world_mut(s, h) {
            Some(sl) => sl,
            None => return std::ptr::null(),
        };
        let w = &sl.world;
        let v = &mut sl.view;
        v.clear();
        let p = match w.players.get(slot as usize) {
            Some(p) => p,
            None => {
                for _ in 0..crate::drop::PLAYER_WORDS {
                    put_i32(v, 0);
                }
                return v.as_ptr();
            }
        };
        let mo = w.deref(p.mo);
        let (id, x, y, z, angle, onground) = match mo {
            Some(hh) => {
                let m = w.mo(hh);
                (m.id as i32, m.x, m.y, m.z, m.angle as i32, (m.z <= m.floorz) as i32)
            }
            None => (0, 0, 0, 0, if p.air != 0 { p.aangle as i32 } else { 0 }, 0),
        };
        let vehicle = w.deref(p.vehicle);
        let air = if vehicle.is_some() { crate::drop::AIR_VEHICLE } else { p.air as i32 };
        let (ax, ay, az) = if (1..=3).contains(&p.air) { (p.ax, p.ay, p.az) } else { (0, 0, 0) };
        let mut owned = 0i32;
        for (i, &o) in p.weaponowned.iter().enumerate() {
            if o {
                owned |= 1 << i;
            }
        }
        let attacker = match w.deref(p.attacker) {
            Some(a) => match w.player_of(a) {
                Some(s) => s as i32 + 1,
                None => 0,
            },
            None => 0,
        };
        let words: [i32; crate::drop::PLAYER_WORDS] = [
            p.slot,
            id,
            p.playerstate as i32,
            x,
            y,
            z,
            p.viewz,
            angle,
            p.pitch,
            p.health,
            p.armorpoints,
            p.armortype,
            p.readyweapon,
            p.pendingweapon,
            owned,
            p.ammo[0],
            p.ammo[1],
            p.ammo[2],
            p.ammo[3],
            p.maxammo[0],
            p.maxammo[1],
            p.maxammo[2],
            p.maxammo[3],
            p.powers[0],
            p.powers[1],
            p.powers[2],
            p.powers[3],
            p.powers[4],
            p.powers[5],
            p.damagecount,
            p.bonuscount,
            p.extralight,
            p.fixedcolormap,
            p.frags,
            p.deaths,
            attacker,
            psp_word(&p.psprites[PS_WEAPON]),
            p.psprites[PS_WEAPON].sx,
            p.psprites[PS_WEAPON].sy,
            psp_word(&p.psprites[PS_FLASH]),
            p.psprites[PS_FLASH].sx,
            p.psprites[PS_FLASH].sy,
            p.control as i32,
            (p.playerstate == PST_DEAD && p.dead_tics >= RESPAWN_MIN_TICS) as i32,
            w.match_tic() as i32,
            w.match_phase(),
            onground,
            p.refire,
            w.team_of(slot as usize),
            w.respawn_mask(slot as usize),
            w.spectating(slot as usize),
            air,
            ax,
            ay,
            az,
            vehicle.map(|b| w.mo(b).id as i32).unwrap_or(0),
            p.grenades,
        ];
        for x in words {
            put_i32(v, x);
        }
        v.as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn world_view_players(h: u32) -> *const u8 {
    with(|s| {
        let sl = match world_mut(s, h) {
            Some(sl) => sl,
            None => return std::ptr::null(),
        };
        let w = &sl.world;
        let v = &mut sl.view;
        v.clear();
        put_i32(v, w.players.len() as i32);
        for p in &w.players {
            let id = w.deref(p.mo).map(|hh| w.mo(hh).id as i32).unwrap_or(0);
            for x in [p.slot, p.control as i32, id, p.frags, p.deaths, p.health, p.playerstate as i32, p.color, w.team_of(p.slot as usize)] {
                put_i32(v, x);
            }
        }
        v.as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn world_view_sectors(h: u32) -> *const u8 {
    with(|s| {
        let sl = match world_mut(s, h) {
            Some(sl) => sl,
            None => return std::ptr::null(),
        };
        let w = &sl.world;
        let v = &mut sl.view;
        v.clear();
        put_i32(v, w.sectors.len() as i32);
        for sec in &w.sectors {
            for x in [sec.floorheight, sec.ceilingheight, sec.lightlevel, sec.floorpic, sec.ceilingpic] {
                put_i32(v, x);
            }
        }
        v.as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn world_view_lines(h: u32) -> *const u8 {
    with(|s| {
        let sl = match world_mut(s, h) {
            Some(sl) => sl,
            None => return std::ptr::null(),
        };
        let w = &sl.world;
        let v = &mut sl.view;
        v.clear();
        put_i32(v, w.map.lines.len() as i32);
        for l in &w.map.lines {
            let t = w.side_tex[l.sidenum[0] as usize];
            for x in [t[0], t[1], t[2]] {
                put_i32(v, x);
            }
        }
        v.as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn world_events(h: u32) -> *const u8 {
    with(|s| {
        let sl = match world_mut(s, h) {
            Some(sl) => sl,
            None => return std::ptr::null(),
        };
        let w = &sl.world;
        let v = &mut sl.view;
        v.clear();
        put_i32(v, w.events.len() as i32);
        for e in &w.events {
            for x in [e.kind, e.a, e.b, e.c, e.x, e.y, e.z, e.d] {
                put_i32(v, x);
            }
        }
        v.as_ptr()
    })
}
