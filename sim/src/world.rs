// World state: one complete deathmatch game (p_tick.c, g_game.c subset, d_player.h).
// Copyright (C) 1993-1996 by id Software, Inc.
// Port: Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.

use std::collections::VecDeque;
use std::rc::Rc;

use crate::fixed::*;
use crate::info::*;
use crate::map::*;
use crate::random::PRandom;

pub const NONE: u32 = u32::MAX;

pub const MATCH_TICS: u32 = 35 * 600;
pub const INTER_TICS: u32 = 35 * 10;
pub const RESPAWN_MIN_TICS: i32 = 35;
pub const RESPAWN_FORCE_TICS: i32 = 35 * 5;
pub const ITEM_RESPAWN_TICS: i32 = 30 * 35;
pub const BODYQUESIZE: usize = 32;
pub const VIEWHEIGHT: Fixed = 41 * FRACUNIT;
pub const MAXHEALTH: i32 = 100;
pub const MAX_PITCH: i32 = (ANG90 as i64 * 9 / 10) as i32;
pub const JUMP_MOMZ: Fixed = 8 * FRACUNIT;
pub const JUMP_COOLDOWN: i32 = 18;

pub const PST_LIVE: u8 = 0;
pub const PST_DEAD: u8 = 1;
pub const PST_REBORN: u8 = 2;

pub const BT_ATTACK: u16 = 1;
pub const BT_USE: u16 = 2;
pub const BT_JUMP: u16 = 4;
pub const BT_WEAPONMASK: u16 = 0xf0;
pub const BT_WEAPONSHIFT: u16 = 4;
pub const BT_NEXTWEAPON: u16 = 0x100;
pub const BT_PREVWEAPON: u16 = 0x200;

pub const CTRL_BOT: u8 = 0;
pub const CTRL_HUMAN: u8 = 1;
pub const CTRL_IDLE: u8 = 2;

/// A reference to a mobj that survives the mobj's removal (deref yields None then).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MRef {
    pub h: u32,
    pub id: u32,
}
impl MRef {
    pub const NULL: MRef = MRef { h: NONE, id: 0 };
    #[inline]
    pub fn is_null(&self) -> bool {
        self.h == NONE
    }
}
impl Default for MRef {
    fn default() -> Self {
        MRef::NULL
    }
}

#[derive(Clone, Debug)]
pub struct Mobj {
    pub id: u32,
    pub x: Fixed,
    pub y: Fixed,
    pub z: Fixed,
    pub snext: u32,
    pub sprev: u32,
    pub bnext: u32,
    pub bprev: u32,
    pub angle: Angle,
    pub sprite: i32,
    pub frame: i32,
    pub subsector: u32,
    pub floorz: Fixed,
    pub ceilingz: Fixed,
    pub radius: Fixed,
    pub height: Fixed,
    pub momx: Fixed,
    pub momy: Fixed,
    pub momz: Fixed,
    pub type_: u16,
    pub tics: i32,
    pub state: u16,
    pub flags: u32,
    pub health: i32,
    pub movedir: i32,
    pub movecount: i32,
    pub target: MRef,
    pub tracer: MRef,
    pub reactiontime: i32,
    pub threshold: i32,
    /// slot of the player driving this body, -1 if none
    pub player: i32,
    pub lastlook: i32,
    pub spawnpoint: MapThing,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cmd {
    pub yaw: u16,
    pub pitch: i16,
    pub forward: i8,
    pub side: i8,
    pub buttons: u16,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Psp {
    /// state number, 0 = not active
    pub state: i32,
    pub tics: i32,
    pub sx: Fixed,
    pub sy: Fixed,
}

pub const PS_WEAPON: usize = 0;
pub const PS_FLASH: usize = 1;

#[derive(Clone, Debug)]
pub struct Player {
    pub slot: i32,
    pub mo: MRef,
    pub playerstate: u8,
    pub control: u8,
    /// command used this tic (human input or bot output)
    pub cmd: Cmd,
    /// last command received from the human driving this slot
    pub human_cmd: Cmd,
    pub prev_buttons: u16,
    pub yaw_offset: u32,
    pub pitch: i32,
    pub viewz: Fixed,
    pub viewheight: Fixed,
    pub deltaviewheight: Fixed,
    pub bob: Fixed,
    pub onground: bool,
    pub health: i32,
    pub armorpoints: i32,
    pub armortype: i32,
    pub powers: [i32; NUMPOWERS],
    pub backpack: bool,
    pub frags: i32,
    pub deaths: i32,
    pub readyweapon: i32,
    pub pendingweapon: i32,
    pub weaponowned: [bool; NUMWEAPONS],
    pub ammo: [i32; NUMAMMO],
    pub maxammo: [i32; NUMAMMO],
    pub attackdown: bool,
    pub usedown: bool,
    pub refire: i32,
    pub damagecount: i32,
    pub bonuscount: i32,
    pub attacker: MRef,
    pub extralight: i32,
    pub fixedcolormap: i32,
    pub psprites: [Psp; 2],
    pub dead_tics: i32,
    pub jump_cooldown: i32,
    /// remove the current body instead of leaving a corpse on the next reborn
    pub fresh: bool,
    pub color: i32,
    // statistics (part of the state; used by tests and the scoreboard)
    pub items: i32,
    pub travelled: i64,
    /// war: chosen respawn point (-1 base)
    pub spawn_choice: i32,
    /// elimination: which living player a dead one watches (cycled with attack)
    pub spec_cycle: i32,
    pub bot: crate::bots::Bot,
}

impl Player {
    pub fn new(slot: i32) -> Player {
        Player {
            slot,
            mo: MRef::NULL,
            playerstate: PST_REBORN,
            control: CTRL_BOT,
            cmd: Cmd::default(),
            human_cmd: Cmd::default(),
            prev_buttons: 0,
            yaw_offset: 0,
            pitch: 0,
            viewz: 0,
            viewheight: VIEWHEIGHT,
            deltaviewheight: 0,
            bob: 0,
            onground: false,
            health: MAXHEALTH,
            armorpoints: 0,
            armortype: 0,
            powers: [0; NUMPOWERS],
            backpack: false,
            frags: 0,
            deaths: 0,
            readyweapon: WP_PISTOL,
            pendingweapon: WP_PISTOL,
            weaponowned: [false; NUMWEAPONS],
            ammo: [0; NUMAMMO],
            maxammo: MAXAMMO,
            attackdown: false,
            usedown: false,
            refire: 0,
            damagecount: 0,
            bonuscount: 0,
            attacker: MRef::NULL,
            extralight: 0,
            fixedcolormap: 0,
            psprites: [Psp::default(); 2],
            dead_tics: 0,
            jump_cooldown: 0,
            fresh: true,
            color: slot & 3,
            items: 0,
            travelled: 0,
            spawn_choice: -1,
            spec_cycle: 0,
            bot: crate::bots::Bot::new(slot as u32),
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Sector {
    pub floorheight: Fixed,
    pub ceilingheight: Fixed,
    pub floorpic: i32,
    pub ceilingpic: i32,
    pub lightlevel: i32,
    pub special: i32,
    pub specialdata: u32,
    pub thinglist: u32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Button {
    pub line: i32,
    pub where_: i32,
    pub btexture: i32,
    pub btimer: i32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Event {
    pub kind: i32,
    pub a: i32,
    pub b: i32,
    pub c: i32,
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub d: i32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Divline {
    pub x: Fixed,
    pub y: Fixed,
    pub dx: Fixed,
    pub dy: Fixed,
}

#[derive(Clone, Copy, Debug)]
pub struct Intercept {
    pub frac: Fixed,
    pub isaline: bool,
    /// line index or mobj handle
    pub d: u32,
    pub id: u32,
}

/// Transient globals of the playsim (p_map.c / p_maputl.c / p_sight.c statics).
/// Never serialized: every use re-initializes what it reads.
#[derive(Clone, Default)]
pub struct Scratch {
    pub validcount: i32,
    pub line_valid: Vec<i32>,
    pub tmthing: u32,
    pub tmflags: u32,
    pub tmx: Fixed,
    pub tmy: Fixed,
    pub tmbbox: [Fixed; 4],
    pub tmfloorz: Fixed,
    pub tmceilingz: Fixed,
    pub tmdropoffz: Fixed,
    pub floatok: bool,
    pub ceilingline: i32,
    pub spechit: Vec<u32>,
    pub opentop: Fixed,
    pub openbottom: Fixed,
    pub openrange: Fixed,
    pub lowfloor: Fixed,
    pub trace: Divline,
    pub earlyout: bool,
    pub intercepts: Vec<Intercept>,
    pub linetarget: MRef,
    pub shootthing: u32,
    pub shootz: Fixed,
    pub la_damage: i32,
    pub la_mod: i32,
    pub attackrange: Fixed,
    pub aimslope: Fixed,
    pub topslope: Fixed,
    pub bottomslope: Fixed,
    pub bestslidefrac: Fixed,
    pub secondslidefrac: Fixed,
    pub bestslideline: i32,
    pub secondslideline: i32,
    pub slidemo: u32,
    pub tmxmove: Fixed,
    pub tmymove: Fixed,
    pub usething: u32,
    pub crushchange: bool,
    pub nofit: bool,
    pub thingbuf: Vec<u32>,
    /// P_GiveWeapon under weapons-stay gave the weapon
    pub stay_gave: bool,
    pub bins: crate::bots::Bins,
}

#[derive(Clone)]
pub struct World {
    pub map: Rc<Map>,
    pub tic: u32,
    pub leveltime: i32,
    pub rng: PRandom,
    pub mobjs: Vec<Option<Mobj>>,
    pub mobj_free: Vec<u32>,
    pub next_id: u32,
    pub sthinkers: Vec<Option<crate::specials::SThinker>>,
    pub sthinker_free: Vec<u32>,
    /// thinker run order: mobj handles, or special-thinker handles | 0x8000_0000
    pub order: Vec<u32>,
    pub dirty_order: bool,
    pub pending_free_m: Vec<u32>,
    pub pending_free_s: Vec<u32>,
    pub blocklinks: Vec<u32>,
    pub sectors: Vec<Sector>,
    pub line_special: Vec<i32>,
    /// current side textures: top, mid, bottom
    pub side_tex: Vec<[i32; 3]>,
    pub buttons: Vec<Button>,
    pub activeplats: Vec<u32>,
    pub activeceilings: Vec<u32>,
    pub players: Vec<Player>,
    pub item_queue: VecDeque<(MapThing, i32)>,
    pub bodyque: Vec<MRef>,
    pub bodyqueslot: u32,
    pub events: Vec<Event>,
    pub g: crate::game::Game,
    pub sc: Scratch,
}

pub const SPEC_FLAG: u32 = 0x8000_0000;

impl World {
    /// deathmatch on one map (the v1 constructor)
    pub fn new(map: Rc<Map>, seed: u32, slots: usize) -> World {
        World::new_cfg(crate::game::Config::ffa(slots as u32), vec![map], seed)
    }

    /// a world for a mode and a map rotation (maps must not be empty)
    pub fn new_cfg(cfg: crate::game::Config, maps: Vec<Rc<Map>>, seed: u32) -> World {
        let cfg = cfg.with_defaults();
        let slots = cfg.slots as usize;
        let map = maps[0].clone();
        let mut w = World {
            map: map.clone(),
            tic: 0,
            leveltime: 0,
            rng: PRandom { index: (seed & 0xff) as u8 },
            mobjs: Vec::new(),
            mobj_free: Vec::new(),
            next_id: 1,
            sthinkers: Vec::new(),
            sthinker_free: Vec::new(),
            order: Vec::new(),
            dirty_order: false,
            pending_free_m: Vec::new(),
            pending_free_s: Vec::new(),
            blocklinks: Vec::new(),
            sectors: Vec::new(),
            line_special: Vec::new(),
            side_tex: Vec::new(),
            buttons: Vec::new(),
            activeplats: Vec::new(),
            activeceilings: Vec::new(),
            players: (0..slots).map(|i| Player::new(i as i32)).collect(),
            item_queue: VecDeque::new(),
            bodyque: Vec::new(),
            bodyqueslot: 0,
            events: Vec::new(),
            g: crate::game::Game::new(cfg, maps),
            sc: Scratch::default(),
        };
        let teams = w.g.cfg.teams();
        for (i, p) in w.players.iter_mut().enumerate() {
            p.bot = crate::bots::Bot::new(seed.wrapping_mul(2654435761).wrapping_add(i as u32 * 7919 + 1));
            if teams {
                // red / indigo-blue translations
                p.color = if i & 1 == 0 { 3 } else { 1 };
            }
        }
        w.load_map(map);
        w.begin_match();
        w
    }

    /// (re)build everything that depends on the map: mobjs, specials, sectors, lines
    pub fn load_map(&mut self, map: Rc<Map>) {
        let nblocks = (map.bmapwidth * map.bmapheight) as usize;
        self.sectors = map
            .sectors
            .iter()
            .map(|s| Sector {
                floorheight: s.floorheight,
                ceilingheight: s.ceilingheight,
                floorpic: s.floorpic,
                ceilingpic: s.ceilingpic,
                lightlevel: s.lightlevel,
                special: s.special,
                specialdata: NONE,
                thinglist: NONE,
            })
            .collect();
        self.line_special = map.lines.iter().map(|l| l.special).collect();
        self.side_tex = map.sides.iter().map(|s| [s.toptexture, s.midtexture, s.bottomtexture]).collect();
        self.map = map.clone();
        self.mobjs.clear();
        self.mobj_free.clear();
        self.sthinkers.clear();
        self.sthinker_free.clear();
        self.order.clear();
        self.dirty_order = false;
        self.pending_free_m.clear();
        self.pending_free_s.clear();
        self.blocklinks = vec![NONE; nblocks];
        self.buttons.clear();
        self.activeplats.clear();
        self.activeceilings.clear();
        self.item_queue.clear();
        self.bodyque.clear();
        self.bodyqueslot = 0;
        self.sc = Scratch { line_valid: vec![0; map.lines.len()], ..Default::default() };
        for p in self.players.iter_mut() {
            p.mo = MRef::NULL;
            p.attacker = MRef::NULL;
            p.playerstate = PST_REBORN;
            p.fresh = false;
            p.bot.reset();
            p.bot.goal_point = -1;
        }
        let things = map.things.clone();
        for t in &things {
            self.spawn_map_thing(t);
        }
        self.spawn_specials();
        self.compact();
    }

    // ------------------------------------------------------------------ mobj storage
    #[inline]
    pub fn mo(&self, h: u32) -> &Mobj {
        self.mobjs[h as usize].as_ref().expect("dead mobj")
    }
    #[inline]
    pub fn mo_mut(&mut self, h: u32) -> &mut Mobj {
        self.mobjs[h as usize].as_mut().expect("dead mobj")
    }
    #[inline]
    pub fn alive(&self, h: u32) -> bool {
        h != NONE && (h as usize) < self.mobjs.len() && self.mobjs[h as usize].is_some()
    }
    #[inline]
    pub fn deref(&self, r: MRef) -> Option<u32> {
        if r.h == NONE {
            return None;
        }
        match self.mobjs.get(r.h as usize) {
            Some(Some(m)) if m.id == r.id => Some(r.h),
            _ => None,
        }
    }
    #[inline]
    pub fn mref(&self, h: u32) -> MRef {
        if h == NONE {
            MRef::NULL
        } else {
            MRef { h, id: self.mo(h).id }
        }
    }
    pub fn alloc_mobj(&mut self, m: Mobj) -> u32 {
        let h = if let Some(h) = self.mobj_free.pop() {
            self.mobjs[h as usize] = Some(m);
            h
        } else {
            self.mobjs.push(Some(m));
            (self.mobjs.len() - 1) as u32
        };
        self.order.push(h);
        h
    }
    pub fn alloc_sthinker(&mut self, t: crate::specials::SThinker) -> u32 {
        let h = if let Some(h) = self.sthinker_free.pop() {
            self.sthinkers[h as usize] = Some(t);
            h
        } else {
            self.sthinkers.push(Some(t));
            (self.sthinkers.len() - 1) as u32
        };
        self.order.push(h | SPEC_FLAG);
        h
    }
    pub fn remove_sthinker(&mut self, h: u32) {
        if self.sthinkers[h as usize].is_some() {
            self.sthinkers[h as usize] = None;
            self.pending_free_s.push(h);
            self.dirty_order = true;
        }
    }
    /// drop removed thinkers from the run order and recycle their handles
    pub fn compact(&mut self) {
        if self.dirty_order {
            let mobjs = &self.mobjs;
            let sth = &self.sthinkers;
            self.order.retain(|&o| if o & SPEC_FLAG != 0 { sth[(o & !SPEC_FLAG) as usize].is_some() } else { mobjs[o as usize].is_some() });
            self.dirty_order = false;
        }
        // recycle in a canonical order
        self.pending_free_m.sort_unstable_by(|a, b| b.cmp(a));
        self.mobj_free.append(&mut self.pending_free_m);
        self.pending_free_s.sort_unstable_by(|a, b| b.cmp(a));
        self.sthinker_free.append(&mut self.pending_free_s);
    }

    // ------------------------------------------------------------------ events
    pub fn emit(&mut self, kind: i32, a: i32, b: i32, c: i32, x: i32, y: i32, z: i32, d: i32) {
        self.events.push(Event { kind, a, b, c, x, y, z, d });
    }
    /// S_StartSound(mobj, sfx)
    pub fn start_sound(&mut self, h: u32, sfx: i32) {
        if sfx <= 0 {
            return;
        }
        if h == NONE || !self.alive(h) {
            return;
        }
        let m = self.mo(h);
        let (id, x, y, z, p) = (m.id, m.x, m.y, m.z, m.player);
        self.emit(1, sfx, id as i32, 127, x, y, z, if p >= 0 { p + 1 } else { 0 });
    }
    /// sound at a fixed point (sector sound origins)
    pub fn start_sound_at(&mut self, x: Fixed, y: Fixed, z: Fixed, sfx: i32) {
        self.emit(1, sfx, 0, 127, x, y, z, 0);
    }
    pub fn sector_sound(&mut self, sec: usize, sfx: i32) {
        let (x, y) = self.map.sectors[sec].soundorg;
        let z = self.sectors[sec].floorheight;
        self.start_sound_at(x, y, z, sfx);
    }

    #[inline]
    pub fn p_random(&mut self) -> i32 {
        self.rng.p_random()
    }

    pub fn match_tic(&self) -> u32 {
        self.g.match_tic
    }
    /// 0 play, 1 intermission (PlayerView[45])
    pub fn match_phase(&self) -> i32 {
        (self.g.phase == crate::game::PH_INTER) as i32
    }

    // ------------------------------------------------------------------ the tic
    pub fn tick(&mut self) {
        self.events.clear();
        self.emit_pending();
        if self.intermission_tick() {
            // intermission: everyone frozen
            self.tic = self.tic.wrapping_add(1);
            return;
        }

        // bots choose their commands from the state at the start of the tic
        #[cfg(feature = "prof")]
        let t0 = std::time::Instant::now();
        crate::bots::think_all(self);
        #[cfg(feature = "prof")]
        prof::add(0, t0);
        let freeze = self.g.phase == crate::game::PH_FREEZE;
        for i in 0..self.players.len() {
            if self.players[i].control == CTRL_HUMAN {
                self.players[i].cmd = self.players[i].human_cmd;
            }
            if freeze {
                // round freeze: look around, nothing else
                let c = &mut self.players[i].cmd;
                c.forward = 0;
                c.side = 0;
                c.buttons &= !(BT_ATTACK | BT_USE | BT_JUMP);
            }
        }

        // G_Ticker: reborns
        #[cfg(feature = "prof")]
        let t0 = std::time::Instant::now();
        for i in 0..self.players.len() {
            if self.players[i].playerstate == PST_REBORN {
                self.do_reborn(i);
            }
        }
        #[cfg(feature = "prof")]
        prof::add(1, t0);
        #[cfg(feature = "prof")]
        let t0 = std::time::Instant::now();
        // P_Ticker
        for i in 0..self.players.len() {
            if self.deref(self.players[i].mo).is_some() {
                self.player_think(i);
            }
            let b = self.players[i].cmd.buttons;
            self.players[i].prev_buttons = b;
        }
        #[cfg(feature = "prof")]
        prof::add(2, t0);
        #[cfg(feature = "prof")]
        let t0 = std::time::Instant::now();
        self.run_thinkers();
        #[cfg(feature = "prof")]
        prof::add(3, t0);
        self.update_specials();
        self.respawn_specials();
        self.mode_tick();
        self.compact();
        self.leveltime = self.leveltime.wrapping_add(1);
        self.tic = self.tic.wrapping_add(1);
    }

    fn run_thinkers(&mut self) {
        let mut i = 0;
        while i < self.order.len() {
            let o = self.order[i];
            i += 1;
            if o & SPEC_FLAG != 0 {
                let h = o & !SPEC_FLAG;
                if self.sthinkers[h as usize].is_some() {
                    self.run_sthinker(h);
                }
            } else if self.mobjs[o as usize].is_some() {
                self.mobj_thinker(o);
            }
        }
    }

    // ------------------------------------------------------------------ membership
    pub fn human_join(&mut self, slot: usize) {
        if slot >= self.players.len() {
            return;
        }
        match self.players[slot].control {
            CTRL_HUMAN => {}
            CTRL_IDLE => {
                self.players[slot].control = CTRL_HUMAN;
            }
            _ => {
                let p = &mut self.players[slot];
                p.control = CTRL_HUMAN;
                p.human_cmd = Cmd::default();
                p.frags = 0;
                p.deaths = 0;
                p.items = 0;
                p.fresh = true;
                p.playerstate = PST_REBORN;
                p.bot.reset();
                self.remove_player_body(slot);
            }
        }
    }
    pub fn human_leave(&mut self, slot: usize) {
        if slot >= self.players.len() || self.players[slot].control == CTRL_BOT {
            return;
        }
        let p = &mut self.players[slot];
        p.control = CTRL_BOT;
        p.frags = 0;
        p.deaths = 0;
        p.items = 0;
        p.human_cmd = Cmd::default();
        p.bot.reset();
    }
    pub fn human_idle(&mut self, slot: usize) {
        if slot >= self.players.len() || self.players[slot].control != CTRL_HUMAN {
            return;
        }
        self.players[slot].control = CTRL_IDLE;
        self.players[slot].bot.reset();
    }
    pub fn free_slot(&self) -> i32 {
        for p in &self.players {
            if p.control == CTRL_BOT {
                return p.slot;
            }
        }
        -1
    }
    pub fn set_cmd(&mut self, slot: usize, yaw: u32, pitch: i32, forward: i32, side: i32, buttons: u32) {
        if slot >= self.players.len() {
            return;
        }
        self.players[slot].human_cmd = Cmd {
            yaw: (yaw & 0xffff) as u16,
            pitch: pitch.clamp(-32768, 32767) as i16,
            forward: forward.clamp(-50, 50) as i8,
            side: side.clamp(-40, 40) as i8,
            buttons: (buttons & 0x3ff) as u16,
        };
    }

    /// take the slot's current body out of the world (with fog), used when a human takes a slot
    pub fn remove_player_body(&mut self, slot: usize) {
        if let Some(h) = self.deref(self.players[slot].mo) {
            let (x, y, z) = {
                let m = self.mo(h);
                (m.x, m.y, m.z)
            };
            let fog = self.spawn_mobj(x, y, z, mt::TFOG);
            self.start_sound(fog, sfx::telept);
            self.mo_mut(h).player = -1;
            self.remove_mobj(h);
        }
        self.players[slot].mo = MRef::NULL;
    }

    /// G_PlayerReborn
    pub fn player_reborn(&mut self, slot: usize) {
        let p = &mut self.players[slot];
        p.usedown = true;
        p.attackdown = true;
        p.playerstate = PST_LIVE;
        p.health = MAXHEALTH;
        p.armorpoints = 0;
        p.armortype = 0;
        p.powers = [0; NUMPOWERS];
        p.backpack = false;
        p.readyweapon = WP_PISTOL;
        p.pendingweapon = WP_PISTOL;
        p.weaponowned = [false; NUMWEAPONS];
        p.weaponowned[WP_FIST as usize] = true;
        p.weaponowned[WP_PISTOL as usize] = true;
        p.ammo = [0; NUMAMMO];
        p.ammo[AM_CLIP as usize] = 50;
        p.maxammo = MAXAMMO;
        p.refire = 0;
        p.damagecount = 0;
        p.bonuscount = 0;
        p.attacker = MRef::NULL;
        p.extralight = 0;
        p.fixedcolormap = 0;
        p.psprites = [Psp::default(); 2];
        p.dead_tics = 0;
        p.jump_cooldown = 0;
        p.viewheight = VIEWHEIGHT;
        p.deltaviewheight = 0;
        p.pitch = 0;
    }

    /// G_DoReborn for deathmatch
    pub fn do_reborn(&mut self, slot: usize) {
        if !self.may_spawn() {
            // elimination mid-round: wait (spectating) for the next round
            if self.players[slot].fresh {
                self.players[slot].fresh = false;
                if self.deref(self.players[slot].mo).is_some() {
                    self.remove_player_body(slot);
                }
            }
            return;
        }
        let fresh = self.players[slot].fresh;
        self.players[slot].fresh = false;
        let old = self.deref(self.players[slot].mo);
        if let Some(h) = old {
            if fresh {
                self.remove_player_body(slot);
            } else {
                // first dissasociate the corpse
                self.mo_mut(h).player = -1;
            }
        }
        self.deathmatch_spawn_player(slot);
    }

    /// G_CheckSpot (P_CheckPosition with the old body, or a clearance test when there is none)
    fn check_spot(&mut self, slot: usize, spot: &MapThing) -> bool {
        let x = (spot.x as i32) << FRACBITS;
        let y = (spot.y as i32) << FRACBITS;
        match self.deref(self.players[slot].mo) {
            Some(h) => {
                if !self.check_position(h, x, y) {
                    return false;
                }
            }
            None => {
                if !self.spot_clear(x, y, 16 * FRACUNIT) {
                    return false;
                }
            }
        }
        if let Some(h) = self.deref(self.players[slot].mo) {
            // flush an old corpse if needed
            if self.bodyque.len() < BODYQUESIZE {
                self.bodyque.push(MRef::NULL);
            }
            let qi = (self.bodyqueslot as usize) % BODYQUESIZE;
            if self.bodyqueslot as usize >= BODYQUESIZE {
                if let Some(old) = self.deref(self.bodyque[qi]) {
                    if self.mo(old).player < 0 {
                        self.remove_mobj(old);
                    }
                }
            }
            self.bodyque[qi] = self.mref(h);
            self.bodyqueslot += 1;
        }
        // spawn a teleport fog
        let ss = self.map.point_in_subsector(x, y);
        let floor = self.sectors[self.map.subsectors[ss].sector as usize].floorheight;
        let an = fine(ANG45.wrapping_mul((spot.angle as i32 / 45) as u32));
        let fog = self.spawn_mobj(x + 20 * finecosine(an), y + 20 * finesine(an), floor, mt::TFOG);
        self.start_sound(fog, sfx::telept);
        true
    }

    /// thing-blocking test for a not-yet-existing player body
    pub fn spot_clear(&mut self, x: Fixed, y: Fixed, radius: Fixed) -> bool {
        let map = self.map.clone();
        let xl = (x - radius - map.bmaporgx - MAXRADIUS) >> MAPBLOCKSHIFT;
        let xh = (x + radius - map.bmaporgx + MAXRADIUS) >> MAPBLOCKSHIFT;
        let yl = (y - radius - map.bmaporgy - MAXRADIUS) >> MAPBLOCKSHIFT;
        let yh = (y + radius - map.bmaporgy + MAXRADIUS) >> MAPBLOCKSHIFT;
        for bx in xl..=xh {
            for by in yl..=yh {
                if bx < 0 || by < 0 || bx >= map.bmapwidth || by >= map.bmapheight {
                    continue;
                }
                let mut h = self.blocklinks[(by * map.bmapwidth + bx) as usize];
                while h != NONE {
                    let m = self.mo(h);
                    if m.flags & (MF_SOLID | MF_SHOOTABLE) != 0 {
                        let bd = m.radius + radius;
                        if (m.x - x).abs() < bd && (m.y - y).abs() < bd {
                            return false;
                        }
                    }
                    h = m.bnext;
                }
            }
        }
        true
    }

    /// G_DeathMatchSpawnPlayer, extended with the generated spawn spots
    pub fn deathmatch_spawn_player(&mut self, slot: usize) {
        let map = self.map.clone();
        let cands = self.spawn_candidates(slot);
        let n = cands.len();
        if n == 0 {
            return;
        }
        for _ in 0..20 {
            let r = (self.p_random() << 8) | self.p_random();
            let i = cands[(r as usize) % n];
            let spot = map.spawn_spots[i];
            if self.check_spot(slot, &spot) {
                self.spawn_player(slot, &spot);
                return;
            }
        }
        // scan for any free spot, starting at a random one
        let start = (self.p_random() as usize * n) / 256;
        for k in 0..n {
            let spot = map.spawn_spots[cands[(start + k) % n]];
            if self.check_spot(slot, &spot) {
                self.spawn_player(slot, &spot);
                return;
            }
        }
        // crowded: try positions around the spots
        for ring in [48i16, 96, 144] {
            for k in 0..n {
                let spot = map.spawn_spots[cands[(start + k) % n]];
                for (dx, dy) in [(1i16, 0i16), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)] {
                    let cand = MapThing { x: spot.x.saturating_add(dx * ring), y: spot.y.saturating_add(dy * ring), ..spot };
                    let x = (cand.x as i32) << FRACBITS;
                    let y = (cand.y as i32) << FRACBITS;
                    let ss = map.point_in_subsector(x, y);
                    let sec = map.subsectors[ss].sector as usize;
                    let ssec = map.sector_at((spot.x as i32) << FRACBITS, (spot.y as i32) << FRACBITS);
                    if !map.nav.reach[ss] || (self.sectors[sec].floorheight - self.sectors[ssec].floorheight).abs() > 24 * FRACUNIT {
                        continue;
                    }
                    if !crate::bots::nav::static_clear(&map, x, y, 17 * FRACUNIT, false) {
                        continue;
                    }
                    if self.check_spot(slot, &cand) {
                        self.spawn_player(slot, &cand);
                        return;
                    }
                }
            }
        }
        // nowhere to stand: stay dead and try again next tic (never spawn inside someone)
        self.players[slot].playerstate = PST_REBORN;
    }

    /// P_SpawnPlayer
    pub fn spawn_player(&mut self, slot: usize, spot: &MapThing) {
        if self.players[slot].playerstate == PST_REBORN || self.players[slot].playerstate == PST_DEAD {
            self.player_reborn(slot);
            self.apply_loadout(slot);
        }
        let x = (spot.x as i32) << FRACBITS;
        let y = (spot.y as i32) << FRACBITS;
        let h = self.spawn_mobj(x, y, ONFLOORZ, mt::PLAYER);
        let color = self.players[slot].color;
        let angle = ANG45.wrapping_mul((spot.angle as i32 / 45) as u32);
        let health = self.players[slot].health;
        {
            let m = self.mo_mut(h);
            m.flags |= ((color & 3) as u32) << MF_TRANSSHIFT;
            m.angle = angle;
            m.player = slot as i32;
            m.health = health;
        }
        let r = self.mref(h);
        let viewz;
        {
            let m = self.mo(h);
            viewz = m.z + VIEWHEIGHT;
        }
        let p = &mut self.players[slot];
        p.mo = r;
        p.playerstate = PST_LIVE;
        p.refire = 0;
        p.damagecount = 0;
        p.bonuscount = 0;
        p.extralight = 0;
        p.fixedcolormap = 0;
        p.viewheight = VIEWHEIGHT;
        p.viewz = viewz;
        p.pitch = 0;
        let cmdyaw = (p.cmd.yaw as u32) << 16;
        p.yaw_offset = angle.wrapping_sub(cmdyaw);
        p.bot.on_spawn();
        self.setup_psprites(slot);
        self.emit(5, slot as i32, 0, 0, x, y, self.mo(h).z, 0);
    }

    /// change the angle of a player's body from inside the sim (teleport, punch, saw), keeping
    /// the absolute-yaw input consistent
    pub fn set_player_angle(&mut self, h: u32, angle: Angle) {
        let (old, p) = {
            let m = self.mo(h);
            (m.angle, m.player)
        };
        self.mo_mut(h).angle = angle;
        if p >= 0 {
            let pl = &mut self.players[p as usize];
            if pl.mo.h == h {
                pl.yaw_offset = pl.yaw_offset.wrapping_add(angle.wrapping_sub(old));
            }
        }
    }

    pub fn player_of(&self, h: u32) -> Option<usize> {
        if h == NONE {
            return None;
        }
        let p = self.mo(h).player;
        if p >= 0 && (p as usize) < self.players.len() && self.players[p as usize].mo.h == h {
            Some(p as usize)
        } else {
            None
        }
    }
}

pub const ONFLOORZ: Fixed = i32::MIN;
pub const ONCEILINGZ: Fixed = i32::MAX;

#[cfg(feature = "prof")]
pub mod prof {
    use std::cell::RefCell;
    thread_local! {
        pub static T: RefCell<[(f64, f64); 8]> = const { RefCell::new([(0.0, 0.0); 8]) };
    }
    /// accumulate (total ms, max ms) for section i
    pub fn add(i: usize, t0: std::time::Instant) {
        let ms = t0.elapsed().as_secs_f64() * 1e3;
        T.with(|t| {
            let mut t = t.borrow_mut();
            t[i].0 += ms;
            if ms > t[i].1 {
                t[i].1 = ms;
            }
        });
    }
    pub fn get() -> [(f64, f64); 8] {
        T.with(|t| *t.borrow())
    }
}
