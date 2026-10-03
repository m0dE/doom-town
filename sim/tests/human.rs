mod common;
use common::*;
use doomsim::bots::nav::static_clear;
use doomsim::fixed::*;
use doomsim::info::*;
use doomsim::world::*;

fn body(w: &World, slot: usize) -> u32 {
    w.deref(w.players[slot].mo).expect("body")
}

#[test]
fn human_slot_script() {
    let map = load("MAP19");
    // one slot only: no bots to interfere
    let mut w = World::new(map.clone(), 99, 1);
    w.human_join(0);
    w.set_cmd(0, 0, 0, 0, 0, 0);
    w.tick();
    let h = body(&w, 0);
    // put the player somewhere with 192 units of open floor towards angle 0
    let spot = map
        .spawn_spots
        .iter()
        .find(|s| (0..=12).all(|k| static_clear(&map, ((s.x as i32) + k * 16) << 16, (s.y as i32) << 16, 24 << 16, true)))
        .expect("open spot");
    let (sx, sy) = ((spot.x as i32) << 16, (spot.y as i32) << 16);
    assert!(w.teleport_move(h, sx, sy));
    {
        let m = w.mo_mut(h);
        m.z = m.floorz;
    }
    let yaw0 = w.players[0].yaw_offset; // cmd yaw that makes the body face angle 0
    let cmd_yaw = (0u32.wrapping_sub(yaw0) >> 16) & 0xffff;
    // let the pistol come up
    for _ in 0..20 {
        w.set_cmd(0, cmd_yaw, 0, 0, 0, 0);
        w.tick();
    }
    assert_eq!(w.mo(h).angle >> 16, 0, "absolute yaw input");
    // ---- walk forward
    let x0 = w.mo(h).x;
    for _ in 0..8 {
        w.set_cmd(0, cmd_yaw, 0, 50, 0, 0);
        w.tick();
    }
    let m = w.mo(h);
    let moved = (m.x - x0) >> 16;
    println!("walked {} units in 8 tics, momx {:.2}", moved, m.momx as f64 / 65536.0);
    // vanilla: thrust 50*2048 per tic, friction 0xe800 -> 1.5625, 2.98, ... units/tic
    assert!(moved > 20 && moved < 80, "moved {}", moved);
    assert!(m.momx > 6 * FRACUNIT && m.momx < 17 * FRACUNIT);
    // stop (vanilla friction needs ~50 tics to get under STOPSPEED from this speed)
    for _ in 0..60 {
        w.set_cmd(0, cmd_yaw, 0, 0, 0, 0);
        w.tick();
    }
    assert_eq!(w.mo(h).momx, 0, "friction stops the player");

    // ---- shoot the pistol at a wall (aim slightly down: puff on the floor or wall)
    let ammo0 = w.players[0].ammo[AM_CLIP as usize];
    let mut puffs = 0;
    let mut pistol_sound = false;
    for t in 0..20 {
        w.set_cmd(0, cmd_yaw, -1000, 0, 0, if t < 2 { 1 } else { 0 });
        w.tick();
        for e in &w.events {
            if e.kind == 1 && e.a == sfx::pistol && e.d == 1 {
                pistol_sound = true;
            }
        }
        puffs = puffs.max(w.mobjs.iter().flatten().filter(|m| m.type_ as usize == mt::PUFF).count());
    }
    assert!(pistol_sound, "pistol sound event");
    assert_eq!(w.players[0].ammo[AM_CLIP as usize], ammo0 - 1, "one bullet used");
    assert!(puffs >= 1, "bullet puff spawned");

    // ---- switch weapons: give a shotgun, press 3
    w.players[0].weaponowned[WP_SHOTGUN as usize] = true;
    w.players[0].ammo[AM_SHELL as usize] = 8;
    let mut switched_at = None;
    for t in 0..60 {
        w.set_cmd(0, cmd_yaw, 0, 0, 0, if t < 3 { 3 << 4 } else { 0 });
        w.tick();
        if w.players[0].readyweapon == WP_SHOTGUN && w.players[0].psprites[PS_WEAPON].sy == 32 * FRACUNIT && switched_at.is_none() {
            switched_at = Some(t);
        }
    }
    println!("shotgun up after {:?} tics", switched_at);
    assert!(switched_at.is_some(), "weapon switch");
    // next weapon cycles to... (fist->pistol->shotgun order): prev goes back to pistol
    for t in 0..60 {
        w.set_cmd(0, cmd_yaw, 0, 0, 0, if t < 2 { 0x200 } else { 0 });
        w.tick();
    }
    assert_eq!(w.players[0].readyweapon, WP_PISTOL, "prev weapon");

    // ---- jump
    let floor = w.mo(h).floorz;
    let mut top = floor;
    let mut landed_at = None;
    for t in 0..40 {
        w.set_cmd(0, cmd_yaw, 0, 0, 0, if t == 0 { 4 } else { 0 });
        w.tick();
        let z = w.mo(h).z;
        top = top.max(z);
        if t > 2 && z == floor && landed_at.is_none() {
            landed_at = Some(t);
        }
    }
    println!("jump apex {} units, landed after {:?} tics", (top - floor) >> 16, landed_at);
    assert!(top - floor >= 30 * FRACUNIT && top - floor <= 40 * FRACUNIT);
    assert!(landed_at.is_some());

    // ---- pick up an item placed in front of us
    let (x, y) = {
        let m = w.mo(h);
        (m.x, m.y)
    };
    let it = w.spawn_mobj(x + 64 * FRACUNIT, y, ONFLOORZ, mt::SUPERSHOTGUN);
    assert!(w.alive(it));
    let mut picked = false;
    for _ in 0..30 {
        w.set_cmd(0, cmd_yaw, 0, 25, 0, 0);
        w.tick();
        for e in &w.events {
            if e.kind == 3 && e.a == 0 && e.b == mt::SUPERSHOTGUN as i32 {
                picked = true;
            }
        }
    }
    assert!(picked, "pickup event");
    assert!(w.players[0].weaponowned[WP_SUPERSHOTGUN as usize]);
    assert_eq!(w.players[0].items, 1);
}
