// info.h / d_items.c / p_mobj.h constants. The tables themselves are generated into
// gen_info.rs from id's info.c. Copyright (C) 1993-1996 by id Software, Inc.
// GPL-2.0.

pub use crate::gen_info::ActionGen as Action;
pub use crate::gen_info::{mt, sfx, spr, st, MOBJINFO, NUMMOBJTYPES, NUMSFX, NUMSPRITES, NUMSTATES, SFXNAMES, SPRNAMES, STATES};

#[derive(Clone, Copy, Debug)]
pub struct State {
    pub sprite: i32,
    pub frame: i32,
    pub tics: i32,
    pub action: Action,
    pub next: i32,
    pub misc1: i32,
    pub misc2: i32,
}

#[derive(Clone, Copy, Debug)]
pub struct MobjInfo {
    pub doomednum: i32,
    pub spawnstate: i32,
    pub spawnhealth: i32,
    pub seestate: i32,
    pub seesound: i32,
    pub reactiontime: i32,
    pub attacksound: i32,
    pub painstate: i32,
    pub painchance: i32,
    pub painsound: i32,
    pub meleestate: i32,
    pub missilestate: i32,
    pub deathstate: i32,
    pub xdeathstate: i32,
    pub deathsound: i32,
    pub speed: i32,
    pub radius: i32,
    pub height: i32,
    pub mass: i32,
    pub damage: i32,
    pub activesound: i32,
    pub flags: i32,
    pub raisestate: i32,
}

#[inline]
pub fn info(t: usize) -> &'static MobjInfo {
    &MOBJINFO[t]
}
#[inline]
pub fn state(s: usize) -> &'static State {
    &STATES[s]
}

// mobj flags (p_mobj.h)
pub const MF_SPECIAL: u32 = 1;
pub const MF_SOLID: u32 = 2;
pub const MF_SHOOTABLE: u32 = 4;
pub const MF_NOSECTOR: u32 = 8;
pub const MF_NOBLOCKMAP: u32 = 16;
pub const MF_AMBUSH: u32 = 32;
pub const MF_JUSTHIT: u32 = 64;
pub const MF_JUSTATTACKED: u32 = 128;
pub const MF_SPAWNCEILING: u32 = 256;
pub const MF_NOGRAVITY: u32 = 512;
pub const MF_DROPOFF: u32 = 0x400;
pub const MF_PICKUP: u32 = 0x800;
pub const MF_NOCLIP: u32 = 0x1000;
pub const MF_SLIDE: u32 = 0x2000;
pub const MF_FLOAT: u32 = 0x4000;
pub const MF_TELEPORT: u32 = 0x8000;
pub const MF_MISSILE: u32 = 0x10000;
pub const MF_DROPPED: u32 = 0x20000;
pub const MF_SHADOW: u32 = 0x40000;
pub const MF_NOBLOOD: u32 = 0x80000;
pub const MF_CORPSE: u32 = 0x100000;
pub const MF_INFLOAT: u32 = 0x200000;
pub const MF_COUNTKILL: u32 = 0x400000;
pub const MF_COUNTITEM: u32 = 0x800000;
pub const MF_SKULLFLY: u32 = 0x1000000;
pub const MF_NOTDMATCH: u32 = 0x2000000;
pub const MF_TRANSLATION: u32 = 0xc000000;
pub const MF_TRANSSHIFT: u32 = 26;
/// battle royale: a supply-drop crate (unused by vanilla)
pub const MF_SUPPLY: u32 = 0x2000_0000;

pub const FF_FULLBRIGHT: i32 = 0x8000;
pub const FF_FRAMEMASK: i32 = 0x7fff;

// weapons (doomdef.h weapontype_t)
pub const WP_FIST: i32 = 0;
pub const WP_PISTOL: i32 = 1;
pub const WP_SHOTGUN: i32 = 2;
pub const WP_CHAINGUN: i32 = 3;
pub const WP_MISSILE: i32 = 4;
pub const WP_PLASMA: i32 = 5;
pub const WP_BFG: i32 = 6;
pub const WP_CHAINSAW: i32 = 7;
pub const WP_SUPERSHOTGUN: i32 = 8;
/// battle royale v2: the sniper rifle (bullets, 5 a shot)
pub const WP_SNIPER: i32 = 9;
pub const NUMWEAPONS: usize = 10;
pub const SNIPER_AMMO: i32 = 5;
pub const WP_NOCHANGE: i32 = 10;

// ammo
pub const AM_CLIP: i32 = 0;
pub const AM_SHELL: i32 = 1;
pub const AM_CELL: i32 = 2;
pub const AM_MISL: i32 = 3;
pub const NUMAMMO: usize = 4;
pub const AM_NOAMMO: i32 = 5;

// powers
pub const PW_INVULNERABILITY: usize = 0;
pub const PW_STRENGTH: usize = 1;
pub const PW_INVISIBILITY: usize = 2;
pub const PW_IRONFEET: usize = 3;
pub const PW_ALLMAP: usize = 4;
pub const PW_INFRARED: usize = 5;
pub const NUMPOWERS: usize = 6;

pub const INVULNTICS: i32 = 30 * 35;
pub const INVISTICS: i32 = 60 * 35;
pub const INFRATICS: i32 = 120 * 35;
pub const IRONTICS: i32 = 60 * 35;

pub struct WeaponInfo {
    pub ammo: i32,
    pub upstate: i32,
    pub downstate: i32,
    pub readystate: i32,
    pub atkstate: i32,
    pub flashstate: i32,
}

pub const WEAPONINFO: [WeaponInfo; NUMWEAPONS] = [
    WeaponInfo { ammo: AM_NOAMMO, upstate: st::PUNCHUP as i32, downstate: st::PUNCHDOWN as i32, readystate: st::PUNCH as i32, atkstate: st::PUNCH1 as i32, flashstate: st::NULL as i32 },
    WeaponInfo { ammo: AM_CLIP, upstate: st::PISTOLUP as i32, downstate: st::PISTOLDOWN as i32, readystate: st::PISTOL as i32, atkstate: st::PISTOL1 as i32, flashstate: st::PISTOLFLASH as i32 },
    WeaponInfo { ammo: AM_SHELL, upstate: st::SGUNUP as i32, downstate: st::SGUNDOWN as i32, readystate: st::SGUN as i32, atkstate: st::SGUN1 as i32, flashstate: st::SGUNFLASH1 as i32 },
    WeaponInfo { ammo: AM_CLIP, upstate: st::CHAINUP as i32, downstate: st::CHAINDOWN as i32, readystate: st::CHAIN as i32, atkstate: st::CHAIN1 as i32, flashstate: st::CHAINFLASH1 as i32 },
    WeaponInfo { ammo: AM_MISL, upstate: st::MISSILEUP as i32, downstate: st::MISSILEDOWN as i32, readystate: st::MISSILE as i32, atkstate: st::MISSILE1 as i32, flashstate: st::MISSILEFLASH1 as i32 },
    WeaponInfo { ammo: AM_CELL, upstate: st::PLASMAUP as i32, downstate: st::PLASMADOWN as i32, readystate: st::PLASMA as i32, atkstate: st::PLASMA1 as i32, flashstate: st::PLASMAFLASH1 as i32 },
    WeaponInfo { ammo: AM_CELL, upstate: st::BFGUP as i32, downstate: st::BFGDOWN as i32, readystate: st::BFG as i32, atkstate: st::BFG1 as i32, flashstate: st::BFGFLASH1 as i32 },
    WeaponInfo { ammo: AM_NOAMMO, upstate: st::SAWUP as i32, downstate: st::SAWDOWN as i32, readystate: st::SAW as i32, atkstate: st::SAW1 as i32, flashstate: st::NULL as i32 },
    WeaponInfo { ammo: AM_SHELL, upstate: st::DSGUNUP as i32, downstate: st::DSGUNDOWN as i32, readystate: st::DSGUN as i32, atkstate: st::DSGUN1 as i32, flashstate: st::DSGUNFLASH1 as i32 },
    WeaponInfo { ammo: AM_CLIP, upstate: st::SNIPERUP as i32, downstate: st::SNIPERDOWN as i32, readystate: st::SNIPER as i32, atkstate: st::SNIPER1 as i32, flashstate: st::SNIPERFLASH as i32 },
];

/// ammo a shot of weapon `w` takes
pub fn ammo_per_shot(w: i32) -> i32 {
    match w {
        WP_BFG => 40,
        WP_SUPERSHOTGUN => 2,
        WP_SNIPER => SNIPER_AMMO,
        _ => 1,
    }
}

pub const MAXAMMO: [i32; NUMAMMO] = [200, 50, 300, 50];
pub const CLIPAMMO: [i32; NUMAMMO] = [10, 4, 20, 1];

/// Pickup message ids carried by the pickup event (kind 3, field c).
pub mod msg {
    pub const NONE: i32 = 0;
    pub const GOTARMOR: i32 = 1;
    pub const GOTMEGA: i32 = 2;
    pub const GOTHTHBONUS: i32 = 3;
    pub const GOTARMBONUS: i32 = 4;
    pub const GOTSUPER: i32 = 5;
    pub const GOTMSPHERE: i32 = 6;
    pub const GOTSTIM: i32 = 7;
    pub const GOTMEDINEED: i32 = 8;
    pub const GOTMEDIKIT: i32 = 9;
    pub const GOTINVUL: i32 = 10;
    pub const GOTBERSERK: i32 = 11;
    pub const GOTINVIS: i32 = 12;
    pub const GOTSUIT: i32 = 13;
    pub const GOTMAP: i32 = 14;
    pub const GOTVISOR: i32 = 15;
    pub const GOTCLIP: i32 = 16;
    pub const GOTCLIPBOX: i32 = 17;
    pub const GOTROCKET: i32 = 18;
    pub const GOTROCKBOX: i32 = 19;
    pub const GOTCELL: i32 = 20;
    pub const GOTCELLBOX: i32 = 21;
    pub const GOTSHELLS: i32 = 22;
    pub const GOTSHELLBOX: i32 = 23;
    pub const GOTBACKPACK: i32 = 24;
    pub const GOTBFG9000: i32 = 25;
    pub const GOTCHAINGUN: i32 = 26;
    pub const GOTCHAINSAW: i32 = 27;
    pub const GOTLAUNCHER: i32 = 28;
    pub const GOTPLASMA: i32 = 29;
    pub const GOTSHOTGUN: i32 = 30;
    pub const GOTSHOTGUN2: i32 = 31;
    /// battle royale v2
    pub const GOTSNIPER: i32 = 32;
    pub const GOTGRENADES: i32 = 33;
}

/// Means of death (obituary event `mod`).
pub mod mod_ {
    pub const WORLD: i32 = 0;
    pub const FIST: i32 = 1;
    pub const PISTOL: i32 = 2;
    pub const SHOTGUN: i32 = 3;
    pub const CHAINGUN: i32 = 4;
    pub const ROCKET: i32 = 5;
    pub const PLASMA: i32 = 6;
    pub const BFG: i32 = 7;
    pub const CHAINSAW: i32 = 8;
    pub const SSG: i32 = 9;
    pub const TELEFRAG: i32 = 10;
    pub const SLIME: i32 = 11;
    pub const CRUSH: i32 = 12;
    pub const SPLASH: i32 = 13;
    pub const BERSERK: i32 = 14;
    pub const FALL: i32 = 15;
    /// battle royale: caught outside the zone
    pub const ZONE: i32 = 16;
    /// run over by a buggy
    pub const ROADKILL: i32 = 17;
    /// a grenade
    pub const GRENADE: i32 = 18;
    /// the sniper rifle
    pub const SNIPER: i32 = 19;
}
