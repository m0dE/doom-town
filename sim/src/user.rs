// Player related stuff: movement, view height, think (p_user.c), plus freelook,
// jumping and the weapon-select semantics of the ticcmd (g_game.c G_BuildTiccmd).
// Copyright (C) 1993-1996 by id Software, Inc.
// Port: Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.

use crate::fixed::*;
use crate::info::*;
use crate::world::*;

pub const MAXBOB: Fixed = 0x100000;
const ANG5: Angle = ANG90 / 18;

/// order used by next/previous weapon
pub const WEAPON_CYCLE: [i32; 9] = [WP_FIST, WP_CHAINSAW, WP_PISTOL, WP_SHOTGUN, WP_SUPERSHOTGUN, WP_CHAINGUN, WP_MISSILE, WP_PLASMA, WP_BFG];

impl World {
    /// P_Thrust
    pub fn thrust(&mut self, h: u32, angle: Angle, mv: Fixed) {
        let a = fine(angle);
        let m = self.mo_mut(h);
        m.momx = m.momx.wrapping_add(fixed_mul(mv, finecosine(a)));
        m.momy = m.momy.wrapping_add(fixed_mul(mv, finesine(a)));
    }

    /// P_CalcHeight
    pub fn calc_height(&mut self, slot: usize, h: u32) {
        let (momx, momy, z, ceilingz) = {
            let m = self.mo(h);
            (m.momx, m.momy, m.z, m.ceilingz)
        };
        let leveltime = self.leveltime;
        let p = &mut self.players[slot];
        p.bob = fixed_mul(momx, momx).wrapping_add(fixed_mul(momy, momy));
        p.bob >>= 2;
        if p.bob > MAXBOB {
            p.bob = MAXBOB;
        }
        if !p.onground {
            // vanilla computes a clamped value and then overwrites it with this
            p.viewz = z + p.viewheight;
            return;
        }
        let angle = ((FINEANGLES / 20) as i32).wrapping_mul(leveltime) as usize & FINEMASK;
        let bob = fixed_mul(p.bob / 2, finesine(angle));
        if p.playerstate == PST_LIVE {
            p.viewheight += p.deltaviewheight;
            if p.viewheight > VIEWHEIGHT {
                p.viewheight = VIEWHEIGHT;
                p.deltaviewheight = 0;
            }
            if p.viewheight < VIEWHEIGHT / 2 {
                p.viewheight = VIEWHEIGHT / 2;
                if p.deltaviewheight <= 0 {
                    p.deltaviewheight = 1;
                }
            }
            if p.deltaviewheight != 0 {
                p.deltaviewheight += FRACUNIT / 4;
                if p.deltaviewheight == 0 {
                    p.deltaviewheight = 1;
                }
            }
        }
        p.viewz = z + p.viewheight + bob;
        if p.viewz > ceilingz - 4 * FRACUNIT {
            p.viewz = ceilingz - 4 * FRACUNIT;
        }
    }

    /// absolute yaw and pitch from the ticcmd
    fn look_player(&mut self, slot: usize, h: u32) {
        let cmd = self.players[slot].cmd;
        let yaw = ((cmd.yaw as u32) << 16).wrapping_add(self.players[slot].yaw_offset);
        self.mo_mut(h).angle = yaw;
        let pitch = ((cmd.pitch as i32) << 16).clamp(-MAX_PITCH, MAX_PITCH);
        self.players[slot].pitch = pitch;
    }

    /// P_MovePlayer (thrust + jump; looking is done in look_player)
    fn move_player(&mut self, slot: usize, h: u32) {
        let cmd = self.players[slot].cmd;
        let yaw = self.mo(h).angle;
        let onground = {
            let m = self.mo(h);
            m.z <= m.floorz
        };
        self.players[slot].onground = onground;
        if cmd.forward != 0 && onground {
            self.thrust(h, yaw, cmd.forward as i32 * 2048);
        }
        if cmd.side != 0 && onground {
            self.thrust(h, yaw.wrapping_sub(ANG90), cmd.side as i32 * 2048);
        }
        // jump (not in vanilla): from the ground only, with a short cooldown after landing
        if onground {
            if self.players[slot].jump_cooldown > 0 {
                self.players[slot].jump_cooldown -= 1;
            } else if cmd.buttons & BT_JUMP != 0 {
                let m = self.mo_mut(h);
                if m.ceilingz - m.floorz > m.height + 8 * FRACUNIT {
                    m.momz = JUMP_MOMZ;
                    self.players[slot].jump_cooldown = 7;
                    self.players[slot].onground = false;
                }
            }
        }
        if (cmd.forward != 0 || cmd.side != 0) && self.mo(h).state as usize == st::PLAY {
            self.set_mobj_state(h, st::PLAY_RUN1 as i32);
        }
    }

    /// P_DeathThink
    fn death_think(&mut self, slot: usize, h: u32) {
        self.move_psprites(slot);
        {
            let p = &mut self.players[slot];
            if p.viewheight > 6 * FRACUNIT {
                p.viewheight -= FRACUNIT;
            }
            if p.viewheight < 6 * FRACUNIT {
                p.viewheight = 6 * FRACUNIT;
            }
            p.deltaviewheight = 0;
        }
        let onground = {
            let m = self.mo(h);
            m.z <= m.floorz
        };
        self.players[slot].onground = onground;
        self.calc_height(slot, h);
        let attacker = self.deref(self.players[slot].attacker);
        match attacker {
            Some(a) if a != h => {
                let (ax, ay) = {
                    let m = self.mo(a);
                    (m.x, m.y)
                };
                let (x, y, ang) = {
                    let m = self.mo(h);
                    (m.x, m.y, m.angle)
                };
                let angle = point_to_angle2(x, y, ax, ay);
                let delta = angle.wrapping_sub(ang);
                if delta < ANG5 || delta > 0u32.wrapping_sub(ANG5) {
                    self.mo_mut(h).angle = angle;
                    if self.players[slot].damagecount != 0 {
                        self.players[slot].damagecount -= 1;
                    }
                } else if delta < ANG180 {
                    self.mo_mut(h).angle = ang.wrapping_add(ANG5);
                } else {
                    self.mo_mut(h).angle = ang.wrapping_sub(ANG5);
                }
            }
            _ => {
                if self.players[slot].damagecount != 0 {
                    self.players[slot].damagecount -= 1;
                }
            }
        }
        let p = &mut self.players[slot];
        p.dead_tics += 1;
        let pressed = p.cmd.buttons & (BT_USE | BT_ATTACK) != 0;
        match self.g.cfg.mode {
            crate::game::MODE_ELIM => {
                // dead until the next round; attack cycles whom we watch
                let p = &mut self.players[slot];
                if p.cmd.buttons & BT_ATTACK != 0 && p.prev_buttons & BT_ATTACK == 0 {
                    p.spec_cycle = p.spec_cycle.wrapping_add(1) & 0xffff;
                }
            }
            crate::game::MODE_WAR => {
                // respawn waves; weapon-select picks where (1 base, 2.. points)
                let sel = ((p.cmd.buttons & BT_WEAPONMASK) >> BT_WEAPONSHIFT) as i32;
                if sel == 1 {
                    p.spawn_choice = -1;
                } else if sel >= 2 {
                    p.spawn_choice = sel - 2;
                }
            }
            _ => {
                if (p.dead_tics >= RESPAWN_MIN_TICS && pressed) || p.dead_tics >= RESPAWN_FORCE_TICS {
                    p.playerstate = PST_REBORN;
                }
            }
        }
    }

    fn weapon_has_ammo(&self, slot: usize, w: i32) -> bool {
        let p = &self.players[slot];
        if !p.weaponowned[w as usize] {
            return false;
        }
        let a = WEAPONINFO[w as usize].ammo;
        if a == AM_NOAMMO {
            return true;
        }
        let need = if w == WP_BFG {
            40
        } else if w == WP_SUPERSHOTGUN {
            2
        } else {
            1
        };
        p.ammo[a as usize] >= need
    }

    fn cycle_weapon(&self, slot: usize, dir: i32) -> i32 {
        let p = &self.players[slot];
        let cur = if p.pendingweapon != WP_NOCHANGE { p.pendingweapon } else { p.readyweapon };
        let idx = WEAPON_CYCLE.iter().position(|&w| w == cur).unwrap_or(0) as i32;
        for k in 1..=9 {
            let i = (idx + dir * k).rem_euclid(9) as usize;
            let w = WEAPON_CYCLE[i];
            if self.weapon_has_ammo(slot, w) {
                return w;
            }
        }
        cur
    }

    /// P_PlayerThink
    pub fn player_think(&mut self, slot: usize) {
        let h = match self.deref(self.players[slot].mo) {
            Some(h) => h,
            None => return,
        };
        {
            let m = self.mo_mut(h);
            m.flags &= !MF_NOCLIP;
        }
        if self.mo(h).flags & MF_JUSTATTACKED != 0 {
            let yaw_now = self.mo(h).angle;
            let p = &mut self.players[slot];
            // keep facing the chainsaw target: cancel the turn from the absolute yaw
            p.yaw_offset = yaw_now.wrapping_sub((p.cmd.yaw as u32) << 16);
            p.cmd.forward = (0xc800 / 512) as i8;
            p.cmd.side = 0;
            self.mo_mut(h).flags &= !MF_JUSTATTACKED;
        }
        if self.players[slot].playerstate == PST_DEAD {
            self.death_think(slot, h);
            return;
        }
        let (x0, y0) = {
            let m = self.mo(h);
            (m.x, m.y)
        };
        // turning and looking stay live during the post-teleport freeze (mouse play);
        // vanilla froze them too
        self.look_player(slot, h);
        if self.mo(h).reactiontime != 0 {
            self.mo_mut(h).reactiontime -= 1;
        } else {
            self.move_player(slot, h);
        }
        self.calc_height(slot, h);
        let sec = self.map.subsectors[self.mo(h).subsector as usize].sector as usize;
        if self.sectors[sec].special != 0 {
            self.player_in_special_sector(slot, h);
            if !self.alive(h) {
                return;
            }
        }
        // weapon change: edge-triggered on the select nibble and next/prev bits
        let cmd = self.players[slot].cmd;
        let prev = self.players[slot].prev_buttons;
        let sel = (cmd.buttons & BT_WEAPONMASK) >> BT_WEAPONSHIFT;
        let psel = (prev & BT_WEAPONMASK) >> BT_WEAPONSHIFT;
        let mut newweapon = WP_NOCHANGE;
        if sel != 0 && sel != psel && sel <= 9 {
            let p = &self.players[slot];
            let mut w = sel as i32 - 1;
            if w == WP_FIST && p.weaponowned[WP_CHAINSAW as usize] && !(p.readyweapon == WP_CHAINSAW && p.powers[PW_STRENGTH] != 0) {
                w = WP_CHAINSAW;
            }
            if w == WP_SHOTGUN && p.weaponowned[WP_SUPERSHOTGUN as usize] && p.readyweapon != WP_SUPERSHOTGUN {
                w = WP_SUPERSHOTGUN;
            }
            newweapon = w;
        } else if cmd.buttons & BT_NEXTWEAPON != 0 && prev & BT_NEXTWEAPON == 0 {
            newweapon = self.cycle_weapon(slot, 1);
        } else if cmd.buttons & BT_PREVWEAPON != 0 && prev & BT_PREVWEAPON == 0 {
            newweapon = self.cycle_weapon(slot, -1);
        }
        if newweapon != WP_NOCHANGE {
            let p = &mut self.players[slot];
            if p.weaponowned[newweapon as usize] && newweapon != p.readyweapon {
                p.pendingweapon = newweapon;
            }
        }
        // use
        if cmd.buttons & BT_USE != 0 {
            if !self.players[slot].usedown {
                self.use_lines(slot);
                self.players[slot].usedown = true;
            }
        } else {
            self.players[slot].usedown = false;
        }
        if !self.alive(h) {
            return;
        }
        self.move_psprites(slot);
        if !self.alive(h) {
            return;
        }
        let shadow_off;
        {
            let p = &mut self.players[slot];
            if p.powers[PW_STRENGTH] != 0 {
                p.powers[PW_STRENGTH] += 1;
            }
            if p.powers[PW_INVULNERABILITY] != 0 {
                p.powers[PW_INVULNERABILITY] -= 1;
            }
            shadow_off = if p.powers[PW_INVISIBILITY] != 0 {
                p.powers[PW_INVISIBILITY] -= 1;
                p.powers[PW_INVISIBILITY] == 0
            } else {
                false
            };
            if p.powers[PW_INFRARED] != 0 {
                p.powers[PW_INFRARED] -= 1;
            }
            if p.powers[PW_IRONFEET] != 0 {
                p.powers[PW_IRONFEET] -= 1;
            }
            if p.damagecount != 0 {
                p.damagecount -= 1;
            }
            if p.bonuscount != 0 {
                p.bonuscount -= 1;
            }
            if p.powers[PW_INVULNERABILITY] != 0 {
                p.fixedcolormap = if p.powers[PW_INVULNERABILITY] > 4 * 32 || (p.powers[PW_INVULNERABILITY] & 8) != 0 { 32 } else { 0 };
            } else if p.powers[PW_INFRARED] != 0 {
                p.fixedcolormap = if p.powers[PW_INFRARED] > 4 * 32 || (p.powers[PW_INFRARED] & 8) != 0 { 1 } else { 0 };
            } else {
                p.fixedcolormap = 0;
            }
        }
        if shadow_off {
            self.mo_mut(h).flags &= !MF_SHADOW;
        }
        let (x1, y1) = {
            let m = self.mo(h);
            (m.x, m.y)
        };
        let _ = (x0, y0, x1, y1);
    }
}
