// Weapon sprite animation and weapon attacks (p_pspr.c).
// Copyright (C) 1993-1996 by id Software, Inc.
// Port: Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.
//
// Freelook change: hitscan weapons use the slope of the player's view pitch
// (finetangent) instead of P_BulletSlope's autoaim; missiles fly along the pitch.

use crate::fixed::*;
use crate::info::*;
use crate::mapmove::*;
use crate::world::*;

pub const LOWERSPEED: Fixed = FRACUNIT * 6;
pub const RAISESPEED: Fixed = FRACUNIT * 6;
pub const WEAPONBOTTOM: Fixed = 128 * FRACUNIT;
pub const WEAPONTOP: Fixed = 32 * FRACUNIT;
pub const BFGCELLS: i32 = 40;

impl World {
    #[inline]
    fn pmo(&self, slot: usize) -> u32 {
        self.deref(self.players[slot].mo).unwrap_or(NONE)
    }

    /// P_SetPsprite
    pub fn set_psprite(&mut self, slot: usize, position: usize, mut stnum: i32) {
        loop {
            if stnum == 0 {
                self.players[slot].psprites[position].state = 0;
                break;
            }
            let s = crate::info::state(stnum as usize);
            {
                let psp = &mut self.players[slot].psprites[position];
                psp.state = stnum;
                psp.tics = s.tics;
                if s.misc1 != 0 {
                    psp.sx = s.misc1 << FRACBITS;
                    psp.sy = s.misc2 << FRACBITS;
                }
            }
            if s.action != Action::None {
                self.psprite_action(slot, position, s.action);
                if self.players[slot].psprites[position].state == 0 {
                    break;
                }
            }
            let cur = self.players[slot].psprites[position].state;
            stnum = crate::info::state(cur as usize).next;
            if self.players[slot].psprites[position].tics != 0 {
                break;
            }
        }
    }

    fn psprite_action(&mut self, slot: usize, pos: usize, a: Action) {
        // the body may be gone (a player that left); weapon actions need it
        let h = self.pmo(slot);
        if h == NONE {
            return;
        }
        match a {
            Action::Light0 => self.players[slot].extralight = 0,
            Action::Light1 => self.players[slot].extralight = 1,
            Action::Light2 => self.players[slot].extralight = 2,
            Action::WeaponReady => self.a_weapon_ready(slot, pos, h),
            Action::Lower => self.a_lower(slot, pos),
            Action::Raise => self.a_raise(slot, pos),
            Action::Punch => self.a_punch(slot, h),
            Action::ReFire => self.a_refire(slot),
            Action::FirePistol => self.a_fire_pistol(slot, h),
            Action::FireShotgun => self.a_fire_shotgun(slot, h),
            Action::FireShotgun2 => self.a_fire_shotgun2(slot, h),
            Action::CheckReload => {
                self.check_ammo(slot);
            }
            Action::OpenShotgun2 => self.start_sound(h, sfx::dbopn),
            Action::LoadShotgun2 => self.start_sound(h, sfx::dbload),
            Action::CloseShotgun2 => {
                self.start_sound(h, sfx::dbcls);
                self.a_refire(slot);
            }
            Action::FireCGun => self.a_fire_cgun(slot, pos, h),
            Action::GunFlash => {
                self.set_mobj_state(h, st::PLAY_ATK2 as i32);
                let fs = WEAPONINFO[self.players[slot].readyweapon as usize].flashstate;
                self.set_psprite(slot, PS_FLASH, fs);
            }
            Action::FireMissile => {
                let w = self.players[slot].readyweapon as usize;
                self.players[slot].ammo[WEAPONINFO[w].ammo as usize] -= 1;
                let pitch = self.players[slot].pitch;
                self.spawn_player_missile(h, mt::ROCKET, pitch);
            }
            Action::Saw => self.a_saw(slot, h),
            Action::FirePlasma => {
                let w = self.players[slot].readyweapon as usize;
                self.players[slot].ammo[WEAPONINFO[w].ammo as usize] -= 1;
                let r = self.p_random() & 1;
                self.set_psprite(slot, PS_FLASH, WEAPONINFO[w].flashstate + r);
                let pitch = self.players[slot].pitch;
                if self.alive(h) {
                    self.spawn_player_missile(h, mt::PLASMA, pitch);
                }
            }
            Action::BFGsound => self.start_sound(h, sfx::bfg),
            Action::FireBFG => {
                let w = self.players[slot].readyweapon as usize;
                self.players[slot].ammo[WEAPONINFO[w].ammo as usize] -= BFGCELLS;
                let pitch = self.players[slot].pitch;
                self.spawn_player_missile(h, mt::BFG, pitch);
            }
            _ => {}
        }
    }

    /// P_BringUpWeapon
    pub fn bring_up_weapon(&mut self, slot: usize) {
        let h = self.pmo(slot);
        if self.players[slot].pendingweapon == WP_NOCHANGE {
            self.players[slot].pendingweapon = self.players[slot].readyweapon;
        }
        if self.players[slot].pendingweapon == WP_CHAINSAW && h != NONE {
            self.start_sound(h, sfx::sawup);
        }
        let newstate = WEAPONINFO[self.players[slot].pendingweapon as usize].upstate;
        self.players[slot].pendingweapon = WP_NOCHANGE;
        self.players[slot].psprites[PS_WEAPON].sy = WEAPONBOTTOM;
        self.set_psprite(slot, PS_WEAPON, newstate);
    }

    /// P_CheckAmmo
    pub fn check_ammo(&mut self, slot: usize) -> bool {
        let p = &mut self.players[slot];
        let ammo = WEAPONINFO[p.readyweapon as usize].ammo;
        let count = if p.readyweapon == WP_BFG {
            BFGCELLS
        } else if p.readyweapon == WP_SUPERSHOTGUN {
            2
        } else {
            1
        };
        if ammo == AM_NOAMMO || p.ammo[ammo as usize] >= count {
            return true;
        }
        let own = |w: i32| p.weaponowned[w as usize];
        p.pendingweapon = if own(WP_PLASMA) && p.ammo[AM_CELL as usize] != 0 {
            WP_PLASMA
        } else if own(WP_SUPERSHOTGUN) && p.ammo[AM_SHELL as usize] > 2 {
            WP_SUPERSHOTGUN
        } else if own(WP_CHAINGUN) && p.ammo[AM_CLIP as usize] != 0 {
            WP_CHAINGUN
        } else if own(WP_SHOTGUN) && p.ammo[AM_SHELL as usize] != 0 {
            WP_SHOTGUN
        } else if p.ammo[AM_CLIP as usize] != 0 {
            WP_PISTOL
        } else if own(WP_CHAINSAW) {
            WP_CHAINSAW
        } else if own(WP_MISSILE) && p.ammo[AM_MISL as usize] != 0 {
            WP_MISSILE
        } else if own(WP_BFG) && p.ammo[AM_CELL as usize] > 40 {
            WP_BFG
        } else {
            WP_FIST
        };
        let ds = WEAPONINFO[p.readyweapon as usize].downstate;
        self.set_psprite(slot, PS_WEAPON, ds);
        false
    }

    /// P_FireWeapon
    fn fire_weapon(&mut self, slot: usize, h: u32) {
        if !self.check_ammo(slot) {
            return;
        }
        self.set_mobj_state(h, st::PLAY_ATK1 as i32);
        let ns = WEAPONINFO[self.players[slot].readyweapon as usize].atkstate;
        self.set_psprite(slot, PS_WEAPON, ns);
    }

    /// P_DropWeapon
    pub fn drop_weapon(&mut self, slot: usize) {
        let ds = WEAPONINFO[self.players[slot].readyweapon as usize].downstate;
        self.set_psprite(slot, PS_WEAPON, ds);
    }

    /// A_WeaponReady
    fn a_weapon_ready(&mut self, slot: usize, pos: usize, h: u32) {
        let s = self.mo(h).state as usize;
        if s == st::PLAY_ATK1 || s == st::PLAY_ATK2 {
            self.set_mobj_state(h, st::PLAY as i32);
        }
        if self.players[slot].readyweapon == WP_CHAINSAW && self.players[slot].psprites[pos].state == st::SAW as i32 {
            self.start_sound(h, sfx::sawidl);
        }
        if self.players[slot].pendingweapon != WP_NOCHANGE || self.players[slot].health == 0 {
            let ds = WEAPONINFO[self.players[slot].readyweapon as usize].downstate;
            self.set_psprite(slot, PS_WEAPON, ds);
            return;
        }
        if self.players[slot].cmd.buttons & BT_ATTACK != 0 {
            let rw = self.players[slot].readyweapon;
            if !self.players[slot].attackdown || (rw != WP_MISSILE && rw != WP_BFG) {
                self.players[slot].attackdown = true;
                self.fire_weapon(slot, h);
                return;
            }
        } else {
            self.players[slot].attackdown = false;
        }
        let lt = self.leveltime;
        let p = &mut self.players[slot];
        let angle = (128i32.wrapping_mul(lt)) as usize & FINEMASK;
        p.psprites[pos].sx = FRACUNIT + fixed_mul(p.bob, finecosine(angle));
        let angle2 = angle & (FINEANGLES / 2 - 1);
        p.psprites[pos].sy = WEAPONTOP + fixed_mul(p.bob, finesine(angle2));
    }

    /// A_ReFire
    fn a_refire(&mut self, slot: usize) {
        let h = self.pmo(slot);
        let p = &self.players[slot];
        if p.cmd.buttons & BT_ATTACK != 0 && p.pendingweapon == WP_NOCHANGE && p.health != 0 && h != NONE {
            self.players[slot].refire += 1;
            self.fire_weapon(slot, h);
        } else {
            self.players[slot].refire = 0;
            self.check_ammo(slot);
        }
    }

    /// A_Lower
    fn a_lower(&mut self, slot: usize, pos: usize) {
        self.players[slot].psprites[pos].sy += LOWERSPEED;
        if self.players[slot].psprites[pos].sy < WEAPONBOTTOM {
            return;
        }
        if self.players[slot].playerstate == PST_DEAD {
            self.players[slot].psprites[pos].sy = WEAPONBOTTOM;
            return;
        }
        if self.players[slot].health == 0 {
            self.set_psprite(slot, PS_WEAPON, st::NULL as i32);
            return;
        }
        self.players[slot].readyweapon = self.players[slot].pendingweapon;
        self.bring_up_weapon(slot);
    }

    /// A_Raise
    fn a_raise(&mut self, slot: usize, pos: usize) {
        self.players[slot].psprites[pos].sy -= RAISESPEED;
        if self.players[slot].psprites[pos].sy > WEAPONTOP {
            return;
        }
        self.players[slot].psprites[pos].sy = WEAPONTOP;
        let ns = WEAPONINFO[self.players[slot].readyweapon as usize].readystate;
        self.set_psprite(slot, PS_WEAPON, ns);
    }

    /// A_Punch
    fn a_punch(&mut self, slot: usize, h: u32) {
        let mut damage = (self.p_random() % 10 + 1) << 1;
        let berserk = self.players[slot].powers[PW_STRENGTH] != 0;
        if berserk {
            damage *= 10;
        }
        let mut angle = self.mo(h).angle;
        angle = angle.wrapping_add(((self.p_random() - self.p_random()) << 18) as u32);
        let slope = self.aim_line_attack(h, angle, MELEERANGE);
        self.line_attack(h, angle, MELEERANGE, slope, damage, if berserk { mod_::BERSERK } else { mod_::FIST });
        if !self.alive(h) {
            return;
        }
        if let Some(lt) = self.deref(self.sc.linetarget) {
            self.start_sound(h, sfx::punch);
            let (x, y) = {
                let m = self.mo(h);
                (m.x, m.y)
            };
            let (tx, ty) = {
                let m = self.mo(lt);
                (m.x, m.y)
            };
            let a = point_to_angle2(x, y, tx, ty);
            self.set_player_angle(h, a);
        }
    }

    /// A_Saw
    fn a_saw(&mut self, _slot: usize, h: u32) {
        let damage = 2 * (self.p_random() % 10 + 1);
        let mut angle = self.mo(h).angle;
        angle = angle.wrapping_add(((self.p_random() - self.p_random()) << 18) as u32);
        let slope = self.aim_line_attack(h, angle, MELEERANGE + 1);
        self.line_attack(h, angle, MELEERANGE + 1, slope, damage, mod_::CHAINSAW);
        if !self.alive(h) {
            return;
        }
        let lt = match self.deref(self.sc.linetarget) {
            Some(t) => t,
            None => {
                self.start_sound(h, sfx::sawful);
                return;
            }
        };
        self.start_sound(h, sfx::sawhit);
        let (x, y, ma) = {
            let m = self.mo(h);
            (m.x, m.y, m.angle)
        };
        let (tx, ty) = {
            let m = self.mo(lt);
            (m.x, m.y)
        };
        let angle = point_to_angle2(x, y, tx, ty);
        let newa = if angle.wrapping_sub(ma) > ANG180 {
            if (angle.wrapping_sub(ma) as i32) < -((ANG90 / 20) as i32) {
                angle.wrapping_add(ANG90 / 21)
            } else {
                ma.wrapping_sub(ANG90 / 20)
            }
        } else if angle.wrapping_sub(ma) > ANG90 / 20 {
            angle.wrapping_sub(ANG90 / 21)
        } else {
            ma.wrapping_add(ANG90 / 20)
        };
        self.set_player_angle(h, newa);
        self.mo_mut(h).flags |= MF_JUSTATTACKED;
    }

    fn bullet_slope(&self, slot: usize) -> Fixed {
        pitch_slope(self.players[slot].pitch)
    }

    /// P_GunShot
    fn gun_shot(&mut self, h: u32, accurate: bool, slope: Fixed, mod_: i32) {
        let damage = 5 * (self.p_random() % 3 + 1);
        let mut angle = self.mo(h).angle;
        if !accurate {
            angle = angle.wrapping_add(((self.p_random() - self.p_random()) << 18) as u32);
        }
        self.line_attack(h, angle, MISSILERANGE, slope, damage, mod_);
    }

    fn a_fire_pistol(&mut self, slot: usize, h: u32) {
        self.start_sound(h, sfx::pistol);
        self.set_mobj_state(h, st::PLAY_ATK2 as i32);
        let w = self.players[slot].readyweapon as usize;
        self.players[slot].ammo[WEAPONINFO[w].ammo as usize] -= 1;
        self.set_psprite(slot, PS_FLASH, WEAPONINFO[w].flashstate);
        let slope = self.bullet_slope(slot);
        let acc = self.players[slot].refire == 0;
        if self.alive(h) {
            self.gun_shot(h, acc, slope, mod_::PISTOL);
        }
    }

    fn a_fire_shotgun(&mut self, slot: usize, h: u32) {
        self.start_sound(h, sfx::shotgn);
        self.set_mobj_state(h, st::PLAY_ATK2 as i32);
        let w = self.players[slot].readyweapon as usize;
        self.players[slot].ammo[WEAPONINFO[w].ammo as usize] -= 1;
        self.set_psprite(slot, PS_FLASH, WEAPONINFO[w].flashstate);
        let slope = self.bullet_slope(slot);
        for _ in 0..7 {
            if !self.alive(h) {
                break;
            }
            self.gun_shot(h, false, slope, mod_::SHOTGUN);
        }
    }

    fn a_fire_shotgun2(&mut self, slot: usize, h: u32) {
        self.start_sound(h, sfx::dshtgn);
        self.set_mobj_state(h, st::PLAY_ATK2 as i32);
        let w = self.players[slot].readyweapon as usize;
        self.players[slot].ammo[WEAPONINFO[w].ammo as usize] -= 2;
        self.set_psprite(slot, PS_FLASH, WEAPONINFO[w].flashstate);
        let slope = self.bullet_slope(slot);
        for _ in 0..20 {
            if !self.alive(h) {
                break;
            }
            let damage = 5 * (self.p_random() % 3 + 1);
            let mut angle = self.mo(h).angle;
            angle = angle.wrapping_add(((self.p_random() - self.p_random()) << 19) as u32);
            let s = slope.wrapping_add((self.p_random() - self.p_random()) << 5);
            self.line_attack(h, angle, MISSILERANGE, s, damage, mod_::SSG);
        }
    }

    fn a_fire_cgun(&mut self, slot: usize, pos: usize, h: u32) {
        self.start_sound(h, sfx::pistol);
        let w = self.players[slot].readyweapon as usize;
        let am = WEAPONINFO[w].ammo as usize;
        if self.players[slot].ammo[am] == 0 {
            return;
        }
        self.set_mobj_state(h, st::PLAY_ATK2 as i32);
        self.players[slot].ammo[am] -= 1;
        let off = self.players[slot].psprites[pos].state - st::CHAIN1 as i32;
        self.set_psprite(slot, PS_FLASH, WEAPONINFO[w].flashstate + off);
        let slope = self.bullet_slope(slot);
        let acc = self.players[slot].refire == 0;
        if self.alive(h) {
            self.gun_shot(h, acc, slope, mod_::CHAINGUN);
        }
    }

    /// P_SetupPsprites
    pub fn setup_psprites(&mut self, slot: usize) {
        for i in 0..2 {
            self.players[slot].psprites[i].state = 0;
        }
        self.players[slot].pendingweapon = self.players[slot].readyweapon;
        self.bring_up_weapon(slot);
    }

    /// P_MovePsprites
    pub fn move_psprites(&mut self, slot: usize) {
        for i in 0..2 {
            let psp = self.players[slot].psprites[i];
            if psp.state != 0 && psp.tics != -1 {
                self.players[slot].psprites[i].tics -= 1;
                if self.players[slot].psprites[i].tics == 0 {
                    let next = crate::info::state(psp.state as usize).next;
                    self.set_psprite(slot, i, next);
                }
            }
        }
        let p = &mut self.players[slot];
        p.psprites[PS_FLASH].sx = p.psprites[PS_WEAPON].sx;
        p.psprites[PS_FLASH].sy = p.psprites[PS_WEAPON].sy;
    }
}
