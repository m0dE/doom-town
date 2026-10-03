mod common;
use common::*;
use doomsim::game::*;
use doomsim::info::*;
use doomsim::world::*;

fn boss_run(mode: u32, slots: u32, secs: u32) -> (Vec<(u32, i32)>, Vec<(u32, i32, i32)>, u32, World) {
    boss_run_seed(mode, slots, secs, 4242)
}

fn boss_run_seed(mode: u32, slots: u32, secs: u32, seed: u32) -> (Vec<(u32, i32)>, Vec<(u32, i32, i32)>, u32, World) {
    let cfg = Config { flags: 1, ..Config::mode(mode, slots) };
    let reg = vec![load("MAP19")];
    let mut a = World::new_cfg(cfg.clone(), reg.clone(), seed);
    let mut b = World::new_cfg(cfg, reg.clone(), seed);
    let mut copies: Vec<World> = Vec::new();
    let (mut ba, mut bb) = (Vec::new(), Vec::new());
    let mut spawns = Vec::new();
    let mut kills = Vec::new();
    let mut bfg_pickups = 0;
    let mut drops: Vec<(i32, i32)> = Vec::new();
    for t in 0..35 * secs {
        // copies while a boss lives (at spawn and every 5 s after)
        if a.deref(a.g.boss).is_some() && t % 175 == 0 {
            copies.push(a.clone());
            let bytes = a.serialize();
            copies.push(World::deserialize(&reg, &bytes).expect("deserialize with boss"));
            if copies.len() > 4 {
                copies.drain(0..2);
            }
        }
        a.tick();
        b.tick();
        for c in copies.iter_mut() {
            c.tick();
        }
        let h = a.hash_with(&mut ba);
        assert_eq!(h, b.hash_with(&mut bb), "tic {}: twins diverged", t);
        for c in &copies {
            assert_eq!(c.hash_with(&mut bb), h, "tic {}: copy diverged", t);
        }
        for e in &a.events {
            match e.kind {
                14 => spawns.push((a.tic, e.a)),
                15 => {
                    kills.push((a.tic, e.a, e.b));
                    drops.push((e.x, e.y));
                }
                3 if e.b == mt::MISC25 as i32 && drops.contains(&(e.x, e.y)) => bfg_pickups += 1,
                _ => {}
            }
        }
    }
    (spawns, kills, bfg_pickups, a)
}

#[test]
fn boss_ffa_64_bots() {
    let (spawns, kills, pickups, w) = boss_run(MODE_FFA, 64, 420);
    println!("boss spawns {:?}", spawns);
    println!("boss kills (tic, type, killer) {:?}", kills);
    for (i, k) in kills.iter().enumerate() {
        let s = spawns[i].0;
        println!("  boss {} ({}) died after {:.1} s", i + 1, if k.1 == mt::CYBORG as i32 { "Cyberdemon" } else { "Spider Mastermind" }, (k.0 - s) as f64 / 35.0);
    }
    println!("dropped-BFG pickups {}; top frags {:?}", pickups, w.players.iter().map(|p| p.frags).max());
    assert!(!spawns.is_empty());
    // 60 s in; up to 5 s more when no spawn spot is 1024 units clear of all 64 players
    assert!((2099..=2100 + 35 * 6).contains(&spawns[0].0), "first boss 60 s in: {:?}", spawns[0]);
    assert!(!kills.is_empty(), "64 bots kill the boss");
    assert!(pickups <= kills.len() as u32, "each dropped BFG is taken at most once");
    if spawns.len() > 1 {
        let gap = spawns[1].0 - kills[0].0;
        assert!((3149..=3150 + 35 * 6).contains(&gap), "next boss 90 s after the kill: {}", gap);
    }
    // every dropped BFG is gone (taken once) or still lying there, never duplicated
    let dropped = w.mobjs.iter().flatten().filter(|m| m.type_ as usize == mt::MISC25 && m.flags & MF_DROPPED != 0).count();
    assert!(dropped <= 1);
}

#[test]
fn boss_tdm() {
    let (spawns, kills, _, w) = boss_run(MODE_TDM, 64, 200);
    println!("TDM boss spawns {:?} kills {:?} team score {:?}", spawns, kills, w.g.team_score);
    assert!(!spawns.is_empty());
}

#[test]
fn no_boss_in_elimination_or_war() {
    for mode in [MODE_ELIM, MODE_WAR] {
        let cfg = Config { flags: 1, ..Config::mode(mode, 24) };
        let mut w = World::new_cfg(cfg, vec![load("MAP19")], 1);
        for _ in 0..35 * 90 {
            w.tick();
            assert!(!w.events.iter().any(|e| e.kind == 14), "no boss in mode {}", mode);
        }
        assert!(w.boss_view()[4] == -1);
    }
}

#[test]
fn boss_spider_ffa() {
    let (spawns, kills, pickups, _) = boss_run_seed(MODE_FFA, 64, 360, 3);
    println!("spider run: spawns {:?} kills {:?} dropped-BFG pickups {}", spawns, kills, pickups);
    assert_eq!(spawns[0].1, mt::SPIDER as i32);
    if let Some(k) = kills.first() {
        println!("  Spider Mastermind died after {:.1} s", (k.0 - spawns[0].0) as f64 / 35.0);
    }
}

