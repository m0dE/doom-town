// Item pickups, damage and death (p_inter.c).
// Copyright (C) 1993-1996 by id Software, Inc.
// Port: Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.

use crate::fixed::*;
use crate::info::*;
use crate::world::*;

pub const BONUSADD: i32 = 6;

impl World {
    /// P_GiveAmmo
    pub fn give_ammo(&mut self, slot: usize, ammo: i32, num: i32) -> bool {
        if ammo == AM_NOAMMO || ammo < 0 || ammo as usize >= NUMAMMO {
            return false;
        }
        let p = &mut self.players[slot];
        let a = ammo as usize;
        if p.ammo[a] == p.maxammo[a] {
            return false;
        }
        let n = if num != 0 { num * CLIPAMMO[a] } else { CLIPAMMO[a] / 2 };
        let oldammo = p.ammo[a];
        p.ammo[a] += n;
        if p.ammo[a] > p.maxammo[a] {
            p.ammo[a] = p.maxammo[a];
        }
        if oldammo != 0 {
            return true;
        }
        match ammo {
            AM_CLIP => {
                if p.readyweapon == WP_FIST {
                    p.pendingweapon = if p.weaponowned[WP_CHAINGUN as usize] { WP_CHAINGUN } else { WP_PISTOL };
                }
            }
            AM_SHELL => {
                if (p.readyweapon == WP_FIST || p.readyweapon == WP_PISTOL) && p.weaponowned[WP_SHOTGUN as usize] {
                    p.pendingweapon = WP_SHOTGUN;
                }
            }
            AM_CELL => {
                if (p.readyweapon == WP_FIST || p.readyweapon == WP_PISTOL) && p.weaponowned[WP_PLASMA as usize] {
                    p.pendingweapon = WP_PLASMA;
                }
            }
            AM_MISL
                if p.readyweapon == WP_FIST && p.weaponowned[WP_MISSILE as usize] => {
                    p.pendingweapon = WP_MISSILE;
                }
            _ => {}
        }
        true
    }

    /// P_GiveWeapon. Placed weapons follow deathmatch 1's "weapons stay" rule (the item is
    /// never removed; returns false like vanilla, `stay_gave` tells whether it was given);
    /// dropped weapons (none in this game) use the normal path.
    pub fn give_weapon(&mut self, slot: usize, weapon: i32, dropped: bool) -> bool {
        let ammo = WEAPONINFO[weapon as usize].ammo;
        if !dropped {
            self.sc.stay_gave = false;
            if self.players[slot].weaponowned[weapon as usize] {
                return false;
            }
            let p = &mut self.players[slot];
            p.bonuscount += BONUSADD;
            p.weaponowned[weapon as usize] = true;
            self.give_ammo(slot, ammo, 5);
            self.players[slot].pendingweapon = weapon;
            self.sc.stay_gave = true;
            return false;
        }
        let gaveammo = if ammo != AM_NOAMMO { self.give_ammo(slot, ammo, 1) } else { false };
        let p = &mut self.players[slot];
        let gaveweapon = if p.weaponowned[weapon as usize] {
            false
        } else {
            p.weaponowned[weapon as usize] = true;
            p.pendingweapon = weapon;
            true
        };
        gaveweapon || gaveammo
    }

    /// P_GiveBody
    pub fn give_body(&mut self, slot: usize, num: i32) -> bool {
        let h = self.deref(self.players[slot].mo);
        let p = &mut self.players[slot];
        if p.health >= MAXHEALTH {
            return false;
        }
        p.health += num;
        if p.health > MAXHEALTH {
            p.health = MAXHEALTH;
        }
        let hp = p.health;
        if let Some(h) = h {
            self.mo_mut(h).health = hp;
        }
        true
    }

    /// P_GiveArmor
    pub fn give_armor(&mut self, slot: usize, armortype: i32) -> bool {
        let p = &mut self.players[slot];
        let hits = armortype * 100;
        if p.armorpoints >= hits {
            return false;
        }
        p.armortype = armortype;
        p.armorpoints = hits;
        true
    }

    /// P_GivePower
    pub fn give_power(&mut self, slot: usize, power: usize) -> bool {
        match power {
            PW_INVULNERABILITY => {
                self.players[slot].powers[power] = INVULNTICS;
                true
            }
            PW_INVISIBILITY => {
                self.players[slot].powers[power] = INVISTICS;
                if let Some(h) = self.deref(self.players[slot].mo) {
                    self.mo_mut(h).flags |= MF_SHADOW;
                }
                true
            }
            PW_INFRARED => {
                self.players[slot].powers[power] = INFRATICS;
                true
            }
            PW_IRONFEET => {
                self.players[slot].powers[power] = IRONTICS;
                true
            }
            PW_STRENGTH => {
                self.give_body(slot, 100);
                self.players[slot].powers[power] = 1;
                true
            }
            _ => {
                if self.players[slot].powers[power] != 0 {
                    return false;
                }
                self.players[slot].powers[power] = 1;
                true
            }
        }
    }

    fn set_health(&mut self, slot: usize, hp: i32) {
        self.players[slot].health = hp;
        if let Some(h) = self.deref(self.players[slot].mo) {
            self.mo_mut(h).health = hp;
        }
    }

    /// P_TouchSpecialThing
    pub fn touch_special_thing(&mut self, special: u32, toucher: u32) {
        let (sz, sprite, sflags, stype, sx, sy) = {
            let m = self.mo(special);
            (m.z, m.sprite as usize, m.flags, m.type_, m.x, m.y)
        };
        let (tz, th, thealth) = {
            let m = self.mo(toucher);
            (m.z, m.height, m.health)
        };
        let delta = sz - tz;
        if delta > th || delta < -8 * FRACUNIT {
            return;
        }
        if thealth <= 0 {
            return;
        }
        let slot = match self.player_of(toucher) {
            Some(s) => s,
            None => return,
        };
        let mut sound = sfx::itemup;
        let dropped = sflags & MF_DROPPED != 0;
        let message;
        match sprite {
            spr::ARM1 => {
                if !self.give_armor(slot, 1) {
                    return;
                }
                message = msg::GOTARMOR;
            }
            spr::ARM2 => {
                if !self.give_armor(slot, 2) {
                    return;
                }
                message = msg::GOTMEGA;
            }
            spr::BON1 => {
                let hp = (self.players[slot].health + 1).min(200);
                self.set_health(slot, hp);
                message = msg::GOTHTHBONUS;
            }
            spr::BON2 => {
                let p = &mut self.players[slot];
                p.armorpoints = (p.armorpoints + 1).min(200);
                if p.armortype == 0 {
                    p.armortype = 1;
                }
                message = msg::GOTARMBONUS;
            }
            spr::SOUL => {
                let hp = (self.players[slot].health + 100).min(200);
                self.set_health(slot, hp);
                message = msg::GOTSUPER;
                sound = sfx::getpow;
            }
            spr::MEGA => {
                self.set_health(slot, 200);
                self.give_armor(slot, 2);
                message = msg::GOTMSPHERE;
                sound = sfx::getpow;
            }
            spr::BKEY | spr::YKEY | spr::RKEY | spr::BSKU | spr::YSKU | spr::RSKU => {
                // keys are irrelevant in deathmatch (and stay in place)
                return;
            }
            spr::STIM => {
                if !self.give_body(slot, 10) {
                    return;
                }
                message = msg::GOTSTIM;
            }
            spr::MEDI => {
                if !self.give_body(slot, 25) {
                    return;
                }
                message = if self.players[slot].health < 25 { msg::GOTMEDINEED } else { msg::GOTMEDIKIT };
            }
            spr::PINV => {
                if !self.give_power(slot, PW_INVULNERABILITY) {
                    return;
                }
                message = msg::GOTINVUL;
                sound = sfx::getpow;
            }
            spr::PSTR => {
                if !self.give_power(slot, PW_STRENGTH) {
                    return;
                }
                message = msg::GOTBERSERK;
                if self.players[slot].readyweapon != WP_FIST {
                    self.players[slot].pendingweapon = WP_FIST;
                }
                sound = sfx::getpow;
            }
            spr::PINS => {
                if !self.give_power(slot, PW_INVISIBILITY) {
                    return;
                }
                message = msg::GOTINVIS;
                sound = sfx::getpow;
            }
            spr::SUIT => {
                if !self.give_power(slot, PW_IRONFEET) {
                    return;
                }
                message = msg::GOTSUIT;
                sound = sfx::getpow;
            }
            spr::PMAP => {
                if !self.give_power(slot, PW_ALLMAP) {
                    return;
                }
                message = msg::GOTMAP;
                sound = sfx::getpow;
            }
            spr::PVIS => {
                if !self.give_power(slot, PW_INFRARED) {
                    return;
                }
                message = msg::GOTVISOR;
                sound = sfx::getpow;
            }
            spr::CLIP => {
                if !self.give_ammo(slot, AM_CLIP, if dropped { 0 } else { 1 }) {
                    return;
                }
                message = msg::GOTCLIP;
            }
            spr::AMMO => {
                if !self.give_ammo(slot, AM_CLIP, 5) {
                    return;
                }
                message = msg::GOTCLIPBOX;
            }
            spr::ROCK => {
                if !self.give_ammo(slot, AM_MISL, 1) {
                    return;
                }
                message = msg::GOTROCKET;
            }
            spr::BROK => {
                if !self.give_ammo(slot, AM_MISL, 5) {
                    return;
                }
                message = msg::GOTROCKBOX;
            }
            spr::CELL => {
                if !self.give_ammo(slot, AM_CELL, 1) {
                    return;
                }
                message = msg::GOTCELL;
            }
            spr::CELP => {
                if !self.give_ammo(slot, AM_CELL, 5) {
                    return;
                }
                message = msg::GOTCELLBOX;
            }
            spr::SHEL => {
                if !self.give_ammo(slot, AM_SHELL, 1) {
                    return;
                }
                message = msg::GOTSHELLS;
            }
            spr::SBOX => {
                if !self.give_ammo(slot, AM_SHELL, 5) {
                    return;
                }
                message = msg::GOTSHELLBOX;
            }
            spr::BPAK => {
                if !self.players[slot].backpack {
                    for i in 0..NUMAMMO {
                        self.players[slot].maxammo[i] *= 2;
                    }
                    self.players[slot].backpack = true;
                }
                for i in 0..NUMAMMO {
                    self.give_ammo(slot, i as i32, 1);
                }
                message = msg::GOTBACKPACK;
            }
            spr::BFUG => {
                return self.weapon_stay_pickup(slot, WP_BFG, special, dropped, msg::GOTBFG9000);
            }
            spr::MGUN => {
                return self.weapon_stay_pickup(slot, WP_CHAINGUN, special, dropped, msg::GOTCHAINGUN);
            }
            spr::CSAW => {
                return self.weapon_stay_pickup(slot, WP_CHAINSAW, special, dropped, msg::GOTCHAINSAW);
            }
            spr::LAUN => {
                return self.weapon_stay_pickup(slot, WP_MISSILE, special, dropped, msg::GOTLAUNCHER);
            }
            spr::PLAS => {
                return self.weapon_stay_pickup(slot, WP_PLASMA, special, dropped, msg::GOTPLASMA);
            }
            spr::SHOT => {
                return self.weapon_stay_pickup(slot, WP_SHOTGUN, special, dropped, msg::GOTSHOTGUN);
            }
            spr::SGN2 => {
                return self.weapon_stay_pickup(slot, WP_SUPERSHOTGUN, special, dropped, msg::GOTSHOTGUN2);
            }
            _ => return,
        }
        self.players[slot].items += 1;
        self.remove_mobj(special);
        self.players[slot].bonuscount += BONUSADD;
        // pickup event: d = sound to play for that player only (S_StartSound(NULL, ...))
        self.emit(3, slot as i32, stype as i32, message, sx, sy, sz, sound);
    }

    /// weapon pickup under "weapons stay": the item remains unless it was dropped
    fn weapon_stay_pickup(&mut self, slot: usize, weapon: i32, special: u32, dropped: bool, message: i32) {
        let (stype, sx, sy, sz) = {
            let m = self.mo(special);
            (m.type_, m.x, m.y, m.z)
        };
        if dropped {
            if !self.give_weapon(slot, weapon, true) {
                return;
            }
            self.remove_mobj(special);
            self.players[slot].bonuscount += BONUSADD;
        } else {
            self.give_weapon(slot, weapon, false);
            if !self.sc.stay_gave {
                return;
            }
        }
        self.players[slot].items += 1;
        self.emit(3, slot as i32, stype as i32, message, sx, sy, sz, sfx::wpnup);
    }

    /// P_KillMobj
    pub fn kill_mobj(&mut self, source: u32, target: u32, mod_: i32) {
        {
            let m = self.mo_mut(target);
            m.flags &= !(MF_SHOOTABLE | MF_FLOAT | MF_SKULLFLY);
            if m.type_ as usize != mt::SKULL {
                m.flags &= !MF_NOGRAVITY;
            }
            m.flags |= MF_CORPSE | MF_DROPOFF;
            m.height >>= 2;
        }
        let tplayer = self.player_of(target);
        let splayer = if source != NONE && self.alive(source) { self.player_of(source) } else { None };
        if let Some(tp) = tplayer {
            // scoring: kills of others count +1, suicides and world deaths -1 (vanilla frags[])
            match splayer {
                Some(sp) if sp != tp => self.players[sp].frags += 1,
                _ => self.players[tp].frags -= 1,
            }
            self.players[tp].deaths += 1;
            let killer = match splayer {
                Some(sp) => sp as i32,
                None => -1,
            };
            self.emit(2, tp as i32, killer, mod_, 0, 0, 0, 0);
            self.mo_mut(target).flags &= !MF_SOLID;
            self.players[tp].playerstate = PST_DEAD;
            self.players[tp].dead_tics = 0;
            self.drop_weapon(tp);
        }
        let (health, type_) = {
            let m = self.mo(target);
            (m.health, m.type_ as usize)
        };
        let inf = info(type_);
        let ok = if health < -inf.spawnhealth && inf.xdeathstate != 0 { self.set_mobj_state(target, inf.xdeathstate) } else { self.set_mobj_state(target, inf.deathstate) };
        if !ok {
            return;
        }
        let r = self.p_random() & 3;
        let m = self.mo_mut(target);
        m.tics -= r;
        if m.tics < 1 {
            m.tics = 1;
        }
        // no monster drops in deathmatch without monsters
    }

    /// P_DamageMobj. `mod_` is the means of death reported in obituaries.
    pub fn damage_mobj(&mut self, target: u32, inflictor: u32, source: u32, mut damage: i32, mod_: i32) {
        if !self.alive(target) {
            return;
        }
        let (tflags, thealth) = {
            let m = self.mo(target);
            (m.flags, m.health)
        };
        if tflags & MF_SHOOTABLE == 0 {
            return;
        }
        if thealth <= 0 {
            return;
        }
        if tflags & MF_SKULLFLY != 0 {
            let m = self.mo_mut(target);
            m.momx = 0;
            m.momy = 0;
            m.momz = 0;
        }
        let inflictor = if inflictor != NONE && self.alive(inflictor) { inflictor } else { NONE };
        let source = if source != NONE && self.alive(source) { source } else { NONE };
        let player = self.player_of(target);
        let source_saw = match self.player_of(source) {
            Some(sp) => self.players[sp].readyweapon == WP_CHAINSAW,
            None => false,
        };
        if inflictor != NONE && tflags & MF_NOCLIP == 0 && (source == NONE || self.player_of(source).is_none() || !source_saw) {
            let (ix, iy, iz) = {
                let m = self.mo(inflictor);
                (m.x, m.y, m.z)
            };
            let (tx, ty, tz, ttype) = {
                let m = self.mo(target);
                (m.x, m.y, m.z, m.type_ as usize)
            };
            let mut ang = point_to_angle2(ix, iy, tx, ty);
            let mass = info(ttype).mass.max(1);
            let mut thrust = ((damage as i64 * (FRACUNIT >> 3) as i64 * 100) / mass as i64) as i32;
            if damage < 40 && damage > thealth && tz - iz > 64 * FRACUNIT && (self.p_random() & 1) != 0 {
                ang = ang.wrapping_add(ANG180);
                thrust = thrust.wrapping_mul(4);
            }
            let a = fine(ang);
            let m = self.mo_mut(target);
            m.momx = m.momx.wrapping_add(fixed_mul(thrust, finecosine(a)));
            m.momy = m.momy.wrapping_add(fixed_mul(thrust, finesine(a)));
        }
        if let Some(p) = player {
            let sec = self.map.subsectors[self.mo(target).subsector as usize].sector as usize;
            if self.sectors[sec].special == 11 && damage >= thealth {
                damage = thealth - 1;
            }
            if damage < 1000 && self.players[p].powers[PW_INVULNERABILITY] != 0 {
                return;
            }
            let pl = &mut self.players[p];
            if pl.armortype != 0 {
                let mut saved = if pl.armortype == 1 { damage / 3 } else { damage / 2 };
                if pl.armorpoints <= saved {
                    saved = pl.armorpoints;
                    pl.armortype = 0;
                }
                pl.armorpoints -= saved;
                damage -= saved;
            }
            pl.health -= damage;
            if pl.health < 0 {
                pl.health = 0;
            }
            pl.damagecount += damage;
            if pl.damagecount > 100 {
                pl.damagecount = 100;
            }
            let sref = self.mref(source);
            self.players[p].attacker = sref;
            let sslot = match self.player_of(source) {
                Some(s) => s as i32,
                None => -1,
            };
            let (tx, ty, tz) = {
                let m = self.mo(target);
                (m.x, m.y, m.z)
            };
            self.emit(4, p as i32, sslot, damage, tx, ty, tz, 0);
        }
        let m = self.mo_mut(target);
        m.health -= damage;
        if m.health <= 0 {
            self.kill_mobj(source, target, mod_);
            return;
        }
        let ttype = self.mo(target).type_ as usize;
        if self.p_random() < info(ttype).painchance && tflags & MF_SKULLFLY == 0 {
            self.mo_mut(target).flags |= MF_JUSTHIT;
            self.set_mobj_state(target, info(ttype).painstate);
            if !self.alive(target) {
                return;
            }
        }
        self.mo_mut(target).reactiontime = 0;
        let threshold = self.mo(target).threshold;
        if (threshold == 0 || ttype == mt::VILE) && source != NONE && source != target && self.mo(source).type_ as usize != mt::VILE {
            let sref = self.mref(source);
            let m = self.mo_mut(target);
            m.target = sref;
            m.threshold = 100;
            let s = m.state as i32;
            if s == info(ttype).spawnstate && info(ttype).seestate != st::NULL as i32 {
                let ss = info(ttype).seestate;
                self.set_mobj_state(target, ss);
            }
        }
    }
}
