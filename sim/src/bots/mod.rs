// Deterministic deathmatch bots.
// Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.
//
// Bots drive a player slot through the same ticcmd path as humans (yaw, pitch, forward,
// side, buttons), so they obey the same physics and weapon rules. They only learn about
// enemies through P_CheckSight (REJECT + BSP) inside a field of view, react after a
// per-bot reaction time and aim with a per-bot error and turn-rate limit. Navigation uses
// the subsector graph in nav.rs with A*; re-planning is staggered and budgeted per tic.

pub mod nav;

use crate::fixed::*;
use crate::info::*;
use crate::random::BotRng;
use crate::world::*;
use nav::*;

/// at most this many A* searches per tic over all bots
const PLAN_BUDGET: i32 = 6;
const ENEMY_FORGET_TICS: u32 = 35 * 3;
const ANG1: u32 = ANG45 / 45;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Step {
    pub node: u32,
    pub px: Fixed,
    pub py: Fixed,
    pub kind: u8,
    pub line: i32,
}

#[derive(Clone, Debug, Default)]
pub struct Bot {
    pub rng: BotRng,
    // personality
    pub aim_err: u32,
    pub react: i32,
    pub turn: u32,
    pub aggression: i32,
    // navigation
    pub path: Vec<Step>,
    pub goal_node: i32,
    pub goal_x: Fixed,
    pub goal_y: Fixed,
    pub goal_item: MRef,
    pub need_plan: bool,
    pub next_goal_tic: u32,
    pub last_x: Fixed,
    pub last_y: Fixed,
    pub check_x: Fixed,
    pub check_y: Fixed,
    pub check_tic: u32,
    pub stuck: i32,
    pub unstick_until: u32,
    pub unstick_side: i32,
    pub ban_a: u32,
    pub ban_b: u32,
    pub ban_until: u32,
    pub wait_tics: i32,
    // combat
    pub enemy: MRef,
    pub enemy_seen: u32,
    pub enemy_x: Fixed,
    pub enemy_y: Fixed,
    pub enemy_z: Fixed,
    pub react_left: i32,
    pub err_yaw: i32,
    pub err_pitch: i32,
    pub err_until: u32,
    pub strafe: i32,
    pub strafe_until: u32,
    pub fire_toggle: bool,
    pub use_toggle: bool,
    pub weapon_key: u16,
    pub weapon_cooldown: i32,
    pub respawn_delay: i32,
    pub hurt_by: MRef,
    // last command decided (world angle, pitch)
    pub yaw: Angle,
    pub pitch: i32,
    /// war: the capture point being worked on (-1 none)
    pub goal_point: i32,
}

impl Bot {
    pub fn new(seed: u32) -> Bot {
        let mut rng = BotRng::new(seed);
        let aim_err = ANG1 * 2 + rng.below(ANG1 * 7);
        let react = rng.range(5, 16);
        let turn = (ANG1 * 9) + rng.below(ANG1 * 14);
        let aggression = rng.range(20, 95);
        Bot { rng, aim_err, react, turn, aggression, goal_node: -1, need_plan: true, goal_point: -1, ..Default::default() }
    }
    pub fn reset(&mut self) {
        self.path.clear();
        self.goal_node = -1;
        self.goal_item = MRef::NULL;
        self.need_plan = true;
        self.enemy = MRef::NULL;
        self.stuck = 0;
        self.weapon_key = 0;
        self.fire_toggle = false;
        self.use_toggle = false;
        self.hurt_by = MRef::NULL;
    }
    pub fn on_spawn(&mut self) {
        self.reset();
        self.next_goal_tic = 0;
        self.check_tic = 0;
        self.respawn_delay = self.rng.range(4, 30);
    }
}

#[inline]
fn angdiff(a: Angle, b: Angle) -> i32 {
    a.wrapping_sub(b) as i32
}

/// approximate distance in map units (i64 inside: war maps are wider than 32k units
/// diagonally, which overflows P_AproxDistance)
fn dist(x1: Fixed, y1: Fixed, x2: Fixed, y2: Fixed) -> i32 {
    let dx = ((x2 as i64 - x1 as i64).abs()) >> FRACBITS;
    let dy = ((y2 as i64 - y1 as i64).abs()) >> FRACBITS;
    let d = if dx < dy { dx + dy - (dx >> 1) } else { dx + dy - (dy >> 1) };
    d.min(i32::MAX as i64) as i32
}

/// players binned on a coarse grid, rebuilt once per tic (scratch, not state)
#[derive(Clone, Default)]
pub struct Bins {
    pub ox: i32,
    pub oy: i32,
    pub w: i32,
    pub h: i32,
    pub cells: Vec<Vec<u16>>,
}
const BIN_SHIFT: i32 = 10; // 1024-unit cells

fn build_bins(w: &mut World) {
    let map = w.map.clone();
    let mut b = std::mem::take(&mut w.sc.bins);
    b.ox = map.bmaporgx >> FRACBITS;
    b.oy = map.bmaporgy >> FRACBITS;
    b.w = ((map.bmapwidth * 128) >> BIN_SHIFT) + 1;
    b.h = ((map.bmapheight * 128) >> BIN_SHIFT) + 1;
    let n = (b.w * b.h) as usize;
    if b.cells.len() != n {
        b.cells = vec![Vec::new(); n];
    }
    for c in b.cells.iter_mut() {
        c.clear();
    }
    for (i, p) in w.players.iter().enumerate() {
        if p.playerstate != PST_LIVE {
            continue;
        }
        if let Some(h) = w.deref(p.mo) {
            let m = w.mo(h);
            let cx = (((m.x >> FRACBITS) - b.ox) >> BIN_SHIFT).clamp(0, b.w - 1);
            let cy = (((m.y >> FRACBITS) - b.oy) >> BIN_SHIFT).clamp(0, b.h - 1);
            b.cells[(cy * b.w + cx) as usize].push(i as u16);
        }
    }
    w.sc.bins = b;
}

/// live players (slots) within `r` units of (x, y), in slot order
fn players_near(w: &World, x: Fixed, y: Fixed, r: i32, out: &mut Vec<usize>) {
    out.clear();
    let b = &w.sc.bins;
    if b.w == 0 {
        return;
    }
    let cx = ((x >> FRACBITS) - b.ox) >> BIN_SHIFT;
    let cy = ((y >> FRACBITS) - b.oy) >> BIN_SHIFT;
    let k = (r >> BIN_SHIFT) + 1;
    for gy in (cy - k).max(0)..=(cy + k).min(b.h - 1) {
        for gx in (cx - k).max(0)..=(cx + k).min(b.w - 1) {
            for &s in &b.cells[(gy * b.w + gx) as usize] {
                out.push(s as usize);
            }
        }
    }
    out.sort_unstable();
}

/// signed pitch (BAM) to look from (dist, dz)
fn pitch_to(d: Fixed, dz: Fixed) -> i32 {
    let a = point_to_angle(d.max(FRACUNIT), dz) as i32;
    a.clamp(-MAX_PITCH, MAX_PITCH)
}

pub fn think_all(w: &mut World) {
    let n = w.players.len();
    let mut budget = PLAN_BUDGET;
    // statistics: distance travelled
    for i in 0..n {
        if let Some(h) = w.deref(w.players[i].mo) {
            let (x, y) = {
                let m = w.mo(h);
                (m.x, m.y)
            };
            let b = &mut w.players[i].bot;
            let d = dist(b.last_x, b.last_y, x, y);
            if d < 64 {
                w.players[i].travelled += d as i64;
            }
            let b = &mut w.players[i].bot;
            b.last_x = x;
            b.last_y = y;
        }
    }
    build_bins(w);
    // rotate who gets the planning budget first
    let start = if n > 0 { (w.tic as usize) % n } else { 0 };
    for k in 0..n {
        let i = (start + k) % n;
        if w.players[i].control == CTRL_HUMAN {
            continue;
        }
        think(w, i, &mut budget);
    }
}

fn set_cmd(w: &mut World, slot: usize, yaw: Angle, pitch: i32, forward: i32, side: i32, buttons: u16) {
    let p = &mut w.players[slot];
    p.bot.yaw = yaw;
    p.bot.pitch = pitch;
    let cy = yaw.wrapping_sub(p.yaw_offset);
    p.cmd = Cmd { yaw: (cy >> 16) as u16, pitch: (pitch >> 16) as i16, forward: forward.clamp(-50, 50) as i8, side: side.clamp(-40, 40) as i8, buttons };
}

fn think(w: &mut World, slot: usize, budget: &mut i32) {
    let h = match w.deref(w.players[slot].mo) {
        Some(h) => h,
        None => {
            w.players[slot].cmd = Cmd::default();
            return;
        }
    };
    let tic = w.tic;
    if w.players[slot].playerstate != PST_LIVE {
        // dead: respawn after a short, human-like delay
        let p = &w.players[slot];
        let want = p.dead_tics >= RESPAWN_MIN_TICS + p.bot.respawn_delay;
        let mut b = 0u16;
        if want && tic.is_multiple_of(2) && w.mode() != crate::game::MODE_ELIM {
            b = BT_ATTACK;
        }
        if w.mode() == crate::game::MODE_WAR {
            b = war_spawn_choice(w, slot) << BT_WEAPONSHIFT;
        }
        let yaw = w.mo(h).angle;
        set_cmd(w, slot, yaw, 0, 0, 0, b);
        return;
    }
    let (x, y, z, angle, ss) = {
        let m = w.mo(h);
        (m.x, m.y, m.z, m.angle, m.subsector)
    };
    let map = w.map.clone();
    let nav = &map.nav;

    // ------------------------------------------------ perception
    if let Some(att) = w.deref(w.players[slot].attacker) {
        if att != h && w.players[slot].damagecount > 0 {
            w.players[slot].bot.hurt_by = w.mref(att);
        }
    }
    if (tic + slot as u32).is_multiple_of(4) {
        acquire_enemy(w, slot, h);
    } else if (tic + slot as u32).is_multiple_of(2) {
        if let Some(e) = w.deref(w.players[slot].bot.enemy) {
            if enemy_alive(w, e) && w.check_sight(h, e) {
                let (ex, ey, ez) = {
                    let m = w.mo(e);
                    (m.x, m.y, m.z)
                };
                let b = &mut w.players[slot].bot;
                b.enemy_seen = tic;
                b.enemy_x = ex;
                b.enemy_y = ey;
                b.enemy_z = ez;
            }
        }
    }
    let mut enemy = w.deref(w.players[slot].bot.enemy);
    if let Some(e) = enemy {
        if !enemy_alive(w, e) || tic.wrapping_sub(w.players[slot].bot.enemy_seen) > ENEMY_FORGET_TICS {
            w.players[slot].bot.enemy = MRef::NULL;
            enemy = None;
        }
    }
    let visible = match enemy {
        Some(_) => w.players[slot].bot.enemy_seen == tic || tic.wrapping_sub(w.players[slot].bot.enemy_seen) <= 2,
        None => false,
    };
    if w.players[slot].bot.react_left > 0 {
        w.players[slot].bot.react_left -= 1;
    }

    // ------------------------------------------------ goals and planning
    let health = w.players[slot].health;
    // gone, or no longer wanted (weapons stay on the map once we own them)
    let goal_gone = match w.players[slot].bot.goal_item {
        r if r.is_null() => false,
        r => match w.deref(r) {
            None => true,
            Some(g) => item_value(w, slot, w.mo(g).type_ as usize) <= 0,
        },
    };
    if goal_gone || tic >= w.players[slot].bot.next_goal_tic || w.players[slot].bot.goal_node < 0 {
        choose_goal(w, slot, h);
        w.players[slot].bot.need_plan = true;
    }
    // reached the goal node: walk to the goal point, then pick a new goal
    if w.players[slot].bot.goal_node == ss as i32 && w.players[slot].bot.path.is_empty() {
        let b = &w.players[slot].bot;
        if dist(x, y, b.goal_x, b.goal_y) < 24 && b.goal_item.is_null() {
            w.players[slot].bot.next_goal_tic = tic;
        }
    }
    // path bookkeeping
    {
        let b = &mut w.players[slot].bot;
        if let Some(pos) = b.path.iter().take(4).position(|s| s.node == ss) {
            b.path.drain(0..=pos);
        }
    }
    let off_path = {
        let b = &w.players[slot].bot;
        !b.path.is_empty() && b.goal_node != ss as i32 && {
            // still in the node before the next step? fine; else off path
            let first = b.path[0];
            let from_ok = nav.edges_of(ss as usize).iter().any(|e| e.to == first.node);
            !from_ok
        }
    };
    if off_path {
        w.players[slot].bot.need_plan = true;
    }
    if w.players[slot].bot.need_plan && *budget > 0 {
        *budget -= 1;
        plan(w, slot, ss as usize);
    }

    // ------------------------------------------------ weapon choice
    let edist = match enemy {
        Some(e) => {
            let m = w.mo(e);
            dist(x, y, m.x, m.y)
        }
        None => 99999,
    };
    let mut buttons: u16 = 0;
    choose_weapon(w, slot, edist, &mut buttons);

    // ------------------------------------------------ steering target
    let (mut tx, mut ty, mut step_kind, step_line, step_node) = {
        let b = &w.players[slot].bot;
        if let Some(s) = b.path.first() {
            (s.px, s.py, s.kind, s.line, s.node as i32)
        } else {
            (b.goal_x, b.goal_y, EK_WALK, -1, -1)
        }
    };
    // look ahead: close to the crossing point, aim for the next one
    if step_node >= 0 && dist(x, y, tx, ty) < 40 && step_kind != EK_TELEPORT {
        let b = &w.players[slot].bot;
        if let Some(s2) = b.path.get(1) {
            if step_kind == EK_WALK || step_kind == EK_DROP {
                tx = s2.px;
                ty = s2.py;
                step_kind = EK_WALK;
            }
        } else {
            tx = b.goal_x;
            ty = b.goal_y;
        }
    }
    let mut want_use = false;
    let mut wait = false;
    // doors and lifts on the next two steps
    for i in 0..2usize {
        let (st, from_node) = {
            let b = &w.players[slot].bot;
            match b.path.get(i) {
                Some(&st) => (st, if i == 0 { ss } else { b.path[0].node }),
                None => break,
            }
        };
        if st.kind != EK_DOOR && st.kind != EK_LIFT {
            continue;
        }
        let d = dist(x, y, st.px, st.py);
        if d > 72 {
            break;
        }
        let from_sec = nav.nodes[from_node as usize].sector as usize;
        let to_sec = nav.nodes[st.node as usize].sector as usize;
        if st.kind == EK_DOOR {
            let ds = if nav.door_sector[to_sec] { to_sec } else { from_sec };
            let sd = w.sectors[ds];
            if sd.ceilingheight - sd.floorheight < 56 * FRACUNIT {
                tx = st.px;
                ty = st.py;
                if sd.specialdata == NONE && d < 64 {
                    want_use = true;
                }
                if d < 48 {
                    wait = true;
                }
            }
        } else {
            let lift_up = w.sectors[to_sec].floorheight - w.sectors[from_sec].floorheight > 24 * FRACUNIT;
            if lift_up {
                tx = st.px;
                ty = st.py;
                let usable = st.line >= 0 && matches!(w.line_special[st.line as usize], 21 | 62 | 122 | 123);
                if w.sectors[to_sec].specialdata == NONE && d < 64 && usable {
                    want_use = true;
                }
                if d < 56 {
                    wait = true;
                }
            }
        }
        break;
    }
    let _ = (step_line, step_kind);
    // standing on a lift that is moving: wait
    {
        let cur_sec = map.subsectors[ss as usize].sector as usize;
        if nav.lift_sector[cur_sec] && w.sectors[cur_sec].specialdata != NONE && step_node >= 0 {
            let ns = nav.nodes[step_node as usize].sector as usize;
            if w.sectors[ns].floorheight - w.sectors[cur_sec].floorheight > 24 * FRACUNIT {
                wait = true;
            }
        }
    }

    // ------------------------------------------------ stuck detection
    if tic.wrapping_sub(w.players[slot].bot.check_tic) >= 35 {
        let b = &mut w.players[slot].bot;
        let moved = dist(b.check_x, b.check_y, x, y);
        b.check_x = x;
        b.check_y = y;
        b.check_tic = tic;
        let fighting = visible;
        if moved < 24 && !wait && !fighting && b.wait_tics < 35 * 6 {
            b.stuck += 1;
            b.unstick_until = tic + 18 + b.rng.below(20);
            b.unstick_side = if b.rng.chance(1, 2) { 1 } else { -1 };
            if b.stuck >= 3 {
                // give up on this edge for a while
                if let Some(s) = b.path.first() {
                    b.ban_a = ss;
                    b.ban_b = s.node;
                    b.ban_until = tic + 35 * 10;
                }
                b.need_plan = true;
            }
            if b.stuck >= 5 {
                b.goal_node = -1;
                b.stuck = 0;
            }
        } else if moved >= 48 {
            b.stuck = 0;
        }
    }
    if wait {
        w.players[slot].bot.wait_tics += 1;
        if w.players[slot].bot.wait_tics > 35 * 6 {
            // waited too long for a door/lift: route around it
            let b = &mut w.players[slot].bot;
            if let Some(s) = b.path.first() {
                b.ban_a = ss;
                b.ban_b = s.node;
                b.ban_until = tic + 35 * 15;
            }
            b.need_plan = true;
            b.wait_tics = 0;
        }
    } else {
        w.players[slot].bot.wait_tics = 0;
    }

    // ------------------------------------------------ movement vector (world space)
    let move_angle = point_to_angle2(x, y, tx, ty);
    let mut fwd_world: i32 = if wait { 0 } else { 50 };
    let mut side_world: i32 = 0; // + = right of move direction
    let unsticking = tic < w.players[slot].bot.unstick_until;
    if unsticking {
        side_world = 40 * w.players[slot].bot.unstick_side;
        if w.players[slot].bot.stuck >= 2 {
            fwd_world = -25;
        }
    }
    if wait && dist(x, y, tx, ty) > 24 {
        fwd_world = 15;
    }

    // ------------------------------------------------ aiming
    let mut yaw_target = move_angle;
    let mut pitch_target = 0;
    let mut fire = false;
    let mut face_enemy = false;
    if let Some(e) = enemy {
        let (ex, ey, ez, eh, emx, emy, eflags) = {
            let m = w.mo(e);
            (m.x, m.y, m.z, m.height, m.momx, m.momy, m.flags)
        };
        let b = &w.players[slot].bot;
        let (lx, ly, lz) = if visible { (ex, ey, ez) } else { (b.enemy_x, b.enemy_y, b.enemy_z) };
        let d = dist(x, y, lx, ly).max(1);
        let rw = w.players[slot].readyweapon;
        // lead projectiles
        let (mut ax, mut ay) = (lx, ly);
        let speed = match rw {
            WP_MISSILE => 20,
            WP_PLASMA => 25,
            WP_BFG => 25,
            _ => 0,
        };
        if speed > 0 && visible {
            let t = (d / speed).min(30);
            ax = ax.wrapping_add(emx.wrapping_mul(t));
            ay = ay.wrapping_add(emy.wrapping_mul(t));
        }
        let aimz = if speed > 0 && rw == WP_MISSILE { lz + 8 * FRACUNIT } else { lz + eh / 2 };
        let eyez = z + 41 * FRACUNIT;
        let exact = point_to_angle2(x, y, ax, ay);
        // aim error drifts every so often
        if tic >= b.err_until {
            let b = &mut w.players[slot].bot;
            let mut e = b.aim_err;
            if eflags & MF_SHADOW != 0 {
                e *= 3;
            }
            b.err_yaw = (b.rng.below(e * 2 + 1) as i64 - e as i64) as i32;
            b.err_pitch = (b.rng.below(e + 1) as i64 - (e / 2) as i64) as i32;
            b.err_until = tic + 8 + b.rng.below(18);
        }
        let b = &w.players[slot].bot;
        yaw_target = exact.wrapping_add(b.err_yaw as u32);
        pitch_target = pitch_to(d << FRACBITS, aimz - eyez).wrapping_add(b.err_pitch).clamp(-MAX_PITCH, MAX_PITCH);
        face_enemy = true;
        // fire when lined up
        if visible && b.react_left == 0 {
            // the bot fires when its crosshair is where it *thinks* the target is (aim
            // error included), like a human would
            let cur = angle;
            let tol = point_to_angle(d << FRACBITS, 20 << FRACBITS).min(ANG1 * 12);
            let off = angdiff(yaw_target, cur).unsigned_abs();
            let mut ok = off <= tol.max(ANG1 * 2);
            if (rw == WP_MISSILE || rw == WP_BFG) && d < 160 {
                ok = false;
            }
            if (rw == WP_FIST || rw == WP_CHAINSAW) && d > 90 {
                ok = false;
            }
            if d > 2000 && rw != WP_CHAINGUN && rw != WP_PISTOL {
                ok = false;
            }
            fire = ok;
        }
        // combat movement: strafe, keep a weapon-dependent distance
        let low = health < 35;
        let pref = match rw {
            WP_FIST | WP_CHAINSAW => 40,
            WP_SUPERSHOTGUN => 180,
            WP_SHOTGUN => 280,
            WP_MISSILE => 520,
            WP_BFG => 400,
            WP_PLASMA => 360,
            _ => 480,
        };
        if visible && !unsticking {
            let b = &mut w.players[slot].bot;
            if tic >= b.strafe_until {
                b.strafe = if b.rng.chance(1, 2) { 1 } else { -1 };
                if b.rng.chance(1, 6) {
                    b.strafe = 0;
                }
                b.strafe_until = tic + 12 + b.rng.below(40);
            }
            // badly armed or hurt: keep running the route (to a weapon / health) while
            // shooting back; otherwise dance with the enemy
            let weak = rw == WP_PISTOL || rw == WP_FIST;
            let keep_route = (low || weak) && !b.path.is_empty();
            if !keep_route {
                // approach / back off relative to the enemy direction, strafing across it
                let towards = point_to_angle2(x, y, ex, ey);
                let mut f = 0;
                if d > pref + 120 && b.aggression > 30 {
                    f = 50;
                } else if d < pref - 80 {
                    f = -40;
                }
                let s = 40 * b.strafe;
                // convert (f along towards, s right of towards) into a world move angle
                let (mvx, mvy) = vec_from(towards, f, s);
                if mvx != 0 || mvy != 0 {
                    let ma = point_to_angle(mvx, mvy);
                    let mag = (aprox_distance(mvx, mvy) >> FRACBITS).min(50);
                    fwd_world = mag;
                    side_world = 0;
                    return finish(w, slot, h, angle, yaw_target, pitch_target, ma, fwd_world, side_world, fire, want_use, face_enemy, buttons);
                } else {
                    fwd_world = 0;
                }
            } else {
                side_world = 40 * b.strafe;
            }
        } else if !visible && !low && w.players[slot].bot.aggression > 50 && w.players[slot].bot.path.is_empty() {
            // chase the last known position
            tx = lx;
            ty = ly;
        }
    } else if let Some(hb) = w.deref(w.players[slot].bot.hurt_by) {
        // shot from somewhere we did not see: turn towards it
        if w.players[slot].damagecount > 0 {
            let m = w.mo(hb);
            yaw_target = point_to_angle2(x, y, m.x, m.y);
            face_enemy = true;
        }
    }
    let ma = point_to_angle2(x, y, tx, ty);
    let _ = move_angle;
    // occasionally jump while running in the open
    if !face_enemy && !wait && w.players[slot].bot.rng.chance(1, 400) {
        buttons |= BT_JUMP;
    }
    if unsticking && w.players[slot].bot.rng.chance(1, 10) {
        buttons |= BT_JUMP;
    }
    finish(w, slot, h, angle, yaw_target, pitch_target, ma, fwd_world, side_world, fire, want_use, face_enemy, buttons);
}

/// world-space vector for "f along angle a, s to the right of it"
fn vec_from(a: Angle, f: i32, sd: i32) -> (Fixed, Fixed) {
    let fa = fine(a);
    let ra = fine(a.wrapping_sub(ANG90));
    let x = f * finecosine(fa) + sd * finecosine(ra);
    let y = f * finesine(fa) + sd * finesine(ra);
    (x, y)
}

#[allow(clippy::too_many_arguments)]
fn finish(w: &mut World, slot: usize, h: u32, cur_angle: Angle, yaw_target: Angle, pitch_target: i32, move_angle: Angle, fwd_world: i32, side_world: i32, fire: bool, want_use: bool, face_enemy: bool, mut buttons: u16) {
    let tic = w.tic;
    let rw = w.players[slot].readyweapon;
    let b = &mut w.players[slot].bot;
    // turn with a per-bot rate limit and some smoothing (tracking lag)
    let mut yaw_goal = yaw_target;
    if want_use {
        yaw_goal = move_angle;
    }
    let diff = angdiff(yaw_goal, cur_angle);
    let maxturn = if face_enemy { b.turn as i32 } else { (b.turn as i32) / 2 + (ANG1 * 4) as i32 };
    let step = (diff / 3).clamp(-maxturn, maxturn);
    let step = if diff.unsigned_abs() < ANG1 { diff } else { step };
    let new_yaw = cur_angle.wrapping_add(step as u32);
    let pdiff = pitch_target.wrapping_sub(b.pitch);
    let new_pitch = b.pitch.wrapping_add((pdiff / 3).clamp(-(ANG1 as i32) * 6, (ANG1 as i32) * 6)).clamp(-MAX_PITCH, MAX_PITCH);
    // movement relative to the new facing
    let d = move_angle.wrapping_sub(new_yaw);
    let fd = fine(d);
    let fwd = (fwd_world * finecosine(fd)) >> FRACBITS;
    let mut side = -((fwd_world * finesine(fd)) >> FRACBITS) * 40 / 50;
    side += side_world;
    let mut fwd = fwd;
    if fwd_world == 0 && side_world == 0 {
        fwd = 0;
        side = 0;
    }
    if fire {
        if rw == WP_MISSILE || rw == WP_BFG || rw == WP_PISTOL || rw == WP_SHOTGUN {
            // semi-automatic: tap the trigger
            b.fire_toggle = !b.fire_toggle;
            if b.fire_toggle || rw == WP_SHOTGUN || rw == WP_PISTOL {
                buttons |= BT_ATTACK;
            }
        } else {
            buttons |= BT_ATTACK;
        }
    }
    if want_use {
        b.use_toggle = !b.use_toggle;
        if b.use_toggle {
            buttons |= BT_USE;
        }
    }
    let _ = (tic, h);
    set_cmd(w, slot, new_yaw, new_pitch, fwd, side, buttons);
}

fn enemy_alive(w: &World, e: u32) -> bool {
    let m = w.mo(e);
    m.health > 0 && m.flags & MF_SHOOTABLE != 0 && w.player_of(e).is_some()
}

fn acquire_enemy(w: &mut World, slot: usize, h: u32) {
    let (x, y, angle) = {
        let m = w.mo(h);
        (m.x, m.y, m.angle)
    };
    let tic = w.tic;
    let mut cands: Vec<(i32, u32)> = Vec::new();
    let hurt_by = w.deref(w.players[slot].bot.hurt_by);
    let mut near = Vec::new();
    players_near(w, x, y, 3000, &mut near);
    for j in near {
        if j == slot || w.same_team(slot, j) {
            continue;
        }
        let e = match w.deref(w.players[j].mo) {
            Some(e) => e,
            None => continue,
        };
        if w.players[j].playerstate != PST_LIVE {
            continue;
        }
        let m = w.mo(e);
        let d = dist(x, y, m.x, m.y);
        let maxd = if m.flags & MF_SHADOW != 0 { 700 } else { 3000 };
        if d > maxd {
            continue;
        }
        let a = point_to_angle2(x, y, m.x, m.y);
        let off = angdiff(a, angle).unsigned_abs();
        let fov = if Some(e) == hurt_by || d < 200 { ANG180 } else { ANG1 * 70 };
        if off > fov {
            continue;
        }
        cands.push((d, e));
    }
    cands.sort_unstable();
    let cur = w.deref(w.players[slot].bot.enemy);
    for &(_, e) in cands.iter().take(3) {
        if w.check_sight(h, e) {
            let (ex, ey, ez) = {
                let m = w.mo(e);
                (m.x, m.y, m.z)
            };
            let b = &mut w.players[slot].bot;
            if cur != Some(e) {
                // switching target only if the new one is clearly closer or the old is lost
                if let Some(c) = cur {
                    if tic.wrapping_sub(b.enemy_seen) < 10 && c != e {
                        // keep the current one if it is still visible recently
                        let keep = cands.iter().any(|&(_, x)| x == c);
                        if keep {
                            return;
                        }
                    }
                }
                b.react_left = b.react;
            }
            b.enemy = MRef { h: e, id: w.mobjs[e as usize].as_ref().map(|m| m.id).unwrap_or(0) };
            let b = &mut w.players[slot].bot;
            b.enemy_seen = tic;
            b.enemy_x = ex;
            b.enemy_y = ey;
            b.enemy_z = ez;
            return;
        }
    }
}

fn weapon_score(w: &World, slot: usize, wp: i32, d: i32) -> i32 {
    let p = &w.players[slot];
    if !p.weaponowned[wp as usize] {
        return -1;
    }
    let a = WEAPONINFO[wp as usize].ammo;
    let need = match wp {
        WP_BFG => 40,
        WP_SUPERSHOTGUN => 2,
        _ => 1,
    };
    if a != AM_NOAMMO && p.ammo[a as usize] < need {
        return -1;
    }
    let berserk = p.powers[PW_STRENGTH] != 0;
    let close = d < 160;
    let mid = d < 650;
    match wp {
        WP_FIST => {
            if berserk && close {
                55
            } else {
                1
            }
        }
        WP_CHAINSAW => {
            if close {
                50
            } else {
                3
            }
        }
        WP_PISTOL => 10,
        WP_SHOTGUN => {
            if close {
                65
            } else if mid {
                55
            } else {
                30
            }
        }
        WP_SUPERSHOTGUN => {
            if close {
                95
            } else if d < 400 {
                80
            } else {
                35
            }
        }
        WP_CHAINGUN => {
            if mid {
                65
            } else {
                80
            }
        }
        WP_MISSILE => {
            if d < 200 {
                0
            } else if mid {
                90
            } else {
                60
            }
        }
        WP_PLASMA => {
            if close {
                80
            } else if mid {
                85
            } else {
                65
            }
        }
        WP_BFG => {
            if d < 200 {
                5
            } else {
                88
            }
        }
        _ => 0,
    }
}

fn weapon_key(wp: i32) -> u16 {
    match wp {
        WP_CHAINSAW => 8,
        WP_SUPERSHOTGUN => 9,
        w => (w + 1) as u16,
    }
}

fn choose_weapon(w: &mut World, slot: usize, edist: i32, buttons: &mut u16) {
    let b = &mut w.players[slot].bot;
    if b.weapon_key != 0 {
        // release the key for a tic so the next press is an edge
        b.weapon_key = 0;
        return;
    }
    if b.weapon_cooldown > 0 {
        b.weapon_cooldown -= 1;
        return;
    }
    let p = &w.players[slot];
    if p.pendingweapon != WP_NOCHANGE {
        return;
    }
    let d = if edist == 99999 { 400 } else { edist };
    let cur = p.readyweapon;
    let cur_score = weapon_score(w, slot, cur, d);
    let mut best = cur;
    let mut best_score = cur_score;
    for wp in 0..9 {
        let sc = weapon_score(w, slot, wp, d);
        if sc > best_score + 8 {
            best = wp;
            best_score = sc;
        }
    }
    if best != cur {
        // plain shotgun is selected through the SSG toggle; skip that case
        if best == WP_SHOTGUN && w.players[slot].weaponowned[WP_SUPERSHOTGUN as usize] {
            return;
        }
        let k = weapon_key(best);
        let b = &mut w.players[slot].bot;
        b.weapon_key = k;
        b.weapon_cooldown = 20;
        *buttons |= k << BT_WEAPONSHIFT;
    }
}

fn item_value(w: &World, slot: usize, t: usize) -> i32 {
    let p = &w.players[slot];
    let hp = p.health;
    let need_hp = (100 - hp).max(0);
    let owns = |wp: i32| p.weaponowned[wp as usize];
    let low = |a: i32| p.ammo[a as usize] < p.maxammo[a as usize] / 2;
    match t {
        x if x == mt::MISC25 => if owns(WP_BFG) { if low(AM_CELL) { 20 } else { 0 } } else { 100 },
        x if x == mt::CHAINGUN => if owns(WP_CHAINGUN) { if low(AM_CLIP) { 12 } else { 0 } } else { 55 },
        x if x == mt::MISC26 => if owns(WP_CHAINSAW) { 0 } else { 25 },
        x if x == mt::MISC27 => if owns(WP_MISSILE) { if low(AM_MISL) { 25 } else { 0 } } else { 90 },
        x if x == mt::MISC28 => if owns(WP_PLASMA) { if low(AM_CELL) { 20 } else { 0 } } else { 85 },
        x if x == mt::SHOTGUN => if owns(WP_SHOTGUN) { if low(AM_SHELL) { 12 } else { 0 } } else { 45 },
        x if x == mt::SUPERSHOTGUN => if owns(WP_SUPERSHOTGUN) { if low(AM_SHELL) { 20 } else { 0 } } else { 85 },
        x if x == mt::MISC0 => if p.armorpoints < 100 { 40 } else { 0 }, // green armor
        x if x == mt::MISC1 => if p.armorpoints < 200 { 70 } else { 0 }, // blue armor
        x if x == mt::MISC2 => if hp < 200 { 4 } else { 0 },             // health bonus
        x if x == mt::MISC3 => if p.armorpoints < 200 { 4 } else { 0 },  // armor bonus
        x if x == mt::MISC10 => if need_hp > 0 { 10 + need_hp / 3 } else { 0 }, // stim
        x if x == mt::MISC11 => if need_hp > 0 { 20 + need_hp / 2 } else { 0 }, // medikit
        x if x == mt::MISC12 => 90,  // soulsphere
        x if x == mt::MEGA => 110,
        x if x == mt::INV => 100,
        x if x == mt::MISC13 => 50 + need_hp / 2, // berserk
        x if x == mt::INS => 55,
        x if x == mt::MISC14 => 10, // radsuit
        x if x == mt::MISC15 => 3,  // allmap
        x if x == mt::MISC16 => 3,  // visor
        x if x == mt::CLIP => if low(AM_CLIP) { 14 } else { 2 },
        x if x == mt::MISC17 => if low(AM_CLIP) { 22 } else { 4 },
        x if x == mt::MISC18 => if owns(WP_MISSILE) && low(AM_MISL) { 18 } else { 2 },
        x if x == mt::MISC19 => if owns(WP_MISSILE) && low(AM_MISL) { 28 } else { 4 },
        x if x == mt::MISC20 => if (owns(WP_PLASMA) || owns(WP_BFG)) && low(AM_CELL) { 16 } else { 2 },
        x if x == mt::MISC21 => if (owns(WP_PLASMA) || owns(WP_BFG)) && low(AM_CELL) { 26 } else { 4 },
        x if x == mt::MISC22 => if (owns(WP_SHOTGUN) || owns(WP_SUPERSHOTGUN)) && low(AM_SHELL) { 16 } else { 2 },
        x if x == mt::MISC23 => if (owns(WP_SHOTGUN) || owns(WP_SUPERSHOTGUN)) && low(AM_SHELL) { 26 } else { 4 },
        x if x == mt::MISC24 => if p.backpack { 8 } else { 40 },
        _ => 0,
    }
}

fn best_item(w: &mut World, slot: usize, h: u32, maxd: i32) -> Option<(i64, u32)> {
    let (x, y, ss) = {
        let m = w.mo(h);
        (m.x, m.y, m.subsector)
    };
    let map = w.map.clone();
    let nav = &map.nav;
    let mut best: Option<(i64, u32)> = None;
    let mut k = 0usize;
    while k < w.order.len() {
        let o = w.order[k];
        k += 1;
        if o & SPEC_FLAG != 0 || !w.alive(o) {
            continue;
        }
        let m = w.mo(o);
        if m.flags & MF_SPECIAL == 0 {
            continue;
        }
        let d = dist(x, y, m.x, m.y);
        if d > maxd {
            continue;
        }
        if !nav.reach[m.subsector as usize] && !nav.reach[ss as usize] {
            // both outside the main area: allow (same pocket); otherwise skip pockets
        } else if !nav.reach[m.subsector as usize] {
            continue;
        }
        let v = item_value(w, slot, m.type_ as usize);
        if v <= 0 {
            continue;
        }
        let jitter = 85 + w.players[slot].bot.rng.below(30) as i64;
        let score = v as i64 * 100_000 * jitter / 100 / (d as i64 + 350);
        if best.is_none_or(|(bs, _)| score > bs) {
            best = Some((score, o));
        }
    }
    best
}

fn set_goal_item(w: &mut World, slot: usize, o: u32, tics: u32) {
    let tic = w.tic;
    let (id, x, y, ss) = {
        let m = w.mo(o);
        (m.id, m.x, m.y, m.subsector)
    };
    let b = &mut w.players[slot].bot;
    b.goal_item = MRef { h: o, id };
    b.goal_x = x;
    b.goal_y = y;
    b.goal_node = ss as i32;
    b.goal_point = -1;
    b.next_goal_tic = tic + tics + b.rng.below(35 * 4);
}

fn set_goal_pos(w: &mut World, slot: usize, gx: Fixed, gy: Fixed, tics: u32) {
    let tic = w.tic;
    let node = w.map.point_in_subsector(gx, gy) as i32;
    let b = &mut w.players[slot].bot;
    b.goal_item = MRef::NULL;
    b.goal_x = gx;
    b.goal_y = gy;
    b.goal_node = node;
    b.next_goal_tic = tic + tics + b.rng.below(35 * 5);
}

fn choose_goal(w: &mut World, slot: usize, h: u32) {
    match w.mode() {
        crate::game::MODE_ELIM => elim_goal(w, slot, h),
        crate::game::MODE_WAR => war_goal(w, slot, h),
        _ => dm_goal(w, slot, h),
    }
}

fn random_spot(w: &mut World, slot: usize, team: i32) -> Option<(Fixed, Fixed)> {
    let map = w.map.clone();
    let cand: Vec<usize> = (0..map.spawn_spots.len()).filter(|&i| team < 0 || map.spot_team.get(i).copied() == Some(team as u8)).collect();
    let list: Vec<usize> = if cand.is_empty() { (0..map.spawn_spots.len()).collect() } else { cand };
    if list.is_empty() {
        return None;
    }
    let i = list[w.players[slot].bot.rng.below(list.len() as u32) as usize];
    let sp = map.spawn_spots[i];
    Some(((sp.x as i32) << FRACBITS, (sp.y as i32) << FRACBITS))
}

fn dm_goal(w: &mut World, slot: usize, h: u32) {
    let best = best_item(w, slot, h, 4000);
    let roll = w.players[slot].bot.rng.chance(1, 2);
    match best {
        Some((sc, o)) if sc > 1500 || roll => set_goal_item(w, slot, o, 35 * 8),
        _ => {
            if let Some((gx, gy)) = random_spot(w, slot, -1) {
                set_goal_pos(w, slot, gx, gy, 35 * 10);
            }
        }
    }
}

/// elimination: grab a good weapon if one is close, else push towards the enemy side or
/// move with a teammate
fn elim_goal(w: &mut World, slot: usize, h: u32) {
    if let Some((sc, o)) = best_item(w, slot, h, 900) {
        if sc > 4000 {
            return set_goal_item(w, slot, o, 35 * 6);
        }
    }
    let team = w.team_of(slot);
    let group = w.players[slot].bot.rng.chance(1, 3);
    if group {
        let mates: Vec<usize> = (0..w.players.len())
            .filter(|&i| i != slot && w.team_of(i) == team && w.players[i].playerstate == PST_LIVE && w.deref(w.players[i].mo).is_some())
            .collect();
        if !mates.is_empty() {
            let i = mates[w.players[slot].bot.rng.below(mates.len() as u32) as usize];
            let m = w.mo(w.deref(w.players[i].mo).unwrap());
            let (gx, gy) = (m.x, m.y);
            return set_goal_pos(w, slot, gx, gy, 35 * 5);
        }
    }
    if let Some((gx, gy)) = random_spot(w, slot, 1 - team) {
        set_goal_pos(w, slot, gx, gy, 35 * 8);
    }
}

/// war: go capture or defend points, spread over them; patch up when hurt
fn war_goal(w: &mut World, slot: usize, h: u32) {
    let (x, y) = {
        let m = w.mo(h);
        (m.x, m.y)
    };
    if w.players[slot].health < 40 {
        if let Some((sc, o)) = best_item(w, slot, h, 700) {
            if sc > 2000 {
                return set_goal_item(w, slot, o, 35 * 5);
            }
        }
    }
    let map = w.map.clone();
    let team = w.team_of(slot);
    let mut best: Option<(i64, usize)> = None;
    for (i, p) in w.g.points.iter().enumerate() {
        let (px, py, _) = map.cap_points[i];
        let d = dist(x, y, px, py) as i64;
        let enemy_on = p.flags & (if team == 0 { 2 } else { 1 }) != 0;
        let weight: i64 = if p.owner == team {
            if enemy_on || p.progress.abs() < crate::game::CAP_FULL {
                90
            } else {
                12
            }
        } else if p.owner < 0 {
            120
        } else {
            100
        };
        // per-bot preference spreads the team over the points
        let pref = ((slot as u32).wrapping_mul(2654435761) >> (i as u32 * 3 % 29)) as i64 & 63;
        let jitter = 70 + w.players[slot].bot.rng.below(60) as i64 + pref;
        let score = weight * jitter * 1000 / (d + 1500);
        if best.is_none_or(|(bs, _)| score > bs) {
            best = Some((score, i));
        }
    }
    if let Some((_, i)) = best {
        let (px, py, r) = map.cap_points[i];
        let b = &mut w.players[slot].bot;
        let rr = (r >> FRACBITS) / 2;
        let ox = b.rng.range(-rr, rr);
        let oy = b.rng.range(-rr, rr);
        let (gx, gy) = (px + (ox << FRACBITS), py + (oy << FRACBITS));
        let node = map.point_in_subsector(gx, gy);
        let (gx, gy) = if map.nav.reach[node] { (gx, gy) } else { (px, py) };
        set_goal_pos(w, slot, gx, gy, 35 * 4);
        w.players[slot].bot.goal_point = i as i32;
        return;
    }
    dm_goal(w, slot, h)
}

/// war respawn choice: the owned point closest to contested ground, else base
fn war_spawn_choice(w: &World, slot: usize) -> u16 {
    let team = w.team_of(slot);
    let map = &w.map;
    let mut best: Option<(i64, usize)> = None;
    for (i, p) in w.g.points.iter().enumerate() {
        if p.owner != team {
            continue;
        }
        let (ax, ay, _) = map.cap_points[i];
        let mut dmin = i64::MAX;
        for (j, q) in w.g.points.iter().enumerate() {
            if q.owner != team {
                let (bx, by, _) = map.cap_points[j];
                dmin = dmin.min(dist(ax, ay, bx, by) as i64);
            }
        }
        if best.is_none_or(|(bd, _)| dmin < bd) {
            best = Some((dmin, i));
        }
    }
    match best {
        Some((_, i)) if i < 14 => (i + 2) as u16,
        _ => 1,
    }
}

/// A* over the subsector graph from `start` to the bot's goal node
fn plan(w: &mut World, slot: usize, start: usize) {
    let map = w.map.clone();
    let nav = &map.nav;
    let tic = w.tic;
    let b = &mut w.players[slot].bot;
    b.need_plan = false;
    b.path.clear();
    let goal = b.goal_node;
    if goal < 0 || goal as usize >= nav.nodes.len() {
        return;
    }
    let goal = goal as usize;
    if goal == start {
        return;
    }
    let (ban_a, ban_b, ban_on) = (b.ban_a, b.ban_b, tic < b.ban_until);
    let n = nav.nodes.len();
    let gx = nav.nodes[goal].cx;
    let gy = nav.nodes[goal].cy;
    let mut g = vec![i32::MAX; n];
    let mut came: Vec<u32> = vec![u32::MAX; n];
    let mut came_edge: Vec<u32> = vec![u32::MAX; n];
    let mut closed = vec![false; n];
    let mut heap = std::collections::BinaryHeap::new();
    g[start] = 0;
    heap.push(std::cmp::Reverse((0i32, start as u32)));
    let mut found = false;
    let mut expanded = 0;
    while let Some(std::cmp::Reverse((_, a))) = heap.pop() {
        let a = a as usize;
        if closed[a] {
            continue;
        }
        closed[a] = true;
        expanded += 1;
        if a == goal {
            found = true;
            break;
        }
        if expanded > n {
            break;
        }
        let base = nav.first[a] as usize;
        for (k, e) in nav.edges_of(a).iter().enumerate() {
            let bn = e.to as usize;
            if closed[bn] {
                continue;
            }
            if ban_on && a as u32 == ban_a && e.to == ban_b {
                continue;
            }
            if e.kind == EK_TELEPORT && e.line >= 0 && w.line_special[e.line as usize] == 0 {
                continue;
            }
            let ng = g[a].saturating_add(e.cost);
            if ng < g[bn] {
                g[bn] = ng;
                came[bn] = a as u32;
                came_edge[bn] = (base + k) as u32;
                let hcost = dist(nav.nodes[bn].cx, nav.nodes[bn].cy, gx, gy);
                heap.push(std::cmp::Reverse((ng.saturating_add(hcost), bn as u32)));
            }
        }
    }
    if !found {
        // unreachable goal: forget it so a new one is chosen
        let b = &mut w.players[slot].bot;
        b.goal_node = -1;
        b.goal_item = MRef::NULL;
        return;
    }
    let mut steps: Vec<Step> = Vec::new();
    let mut cur = goal;
    while cur != start {
        let e = &nav.edges[came_edge[cur] as usize];
        steps.push(Step { node: cur as u32, px: e.px, py: e.py, kind: e.kind, line: e.line });
        cur = came[cur] as usize;
    }
    steps.reverse();
    w.players[slot].bot.path = steps;
}
