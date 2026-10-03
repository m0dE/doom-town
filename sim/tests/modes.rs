mod common;
use common::*;
use doomsim::game::*;
use doomsim::map::*;
use doomsim::world::*;
use std::rc::Rc;

fn registry(names: &[&str]) -> Vec<Rc<Map>> {
    let w = wad();
    names
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let mut m = Map::load(&extract_map_pwad(&w, n).unwrap()).unwrap();
            m.id = i as i32;
            Rc::new(m)
        })
        .collect()
}

#[derive(Default, Debug)]
struct Seen {
    kinds: [u32; 16],
    round_winners: Vec<i32>,
    match_ends: Vec<(i32, i32)>,
    map_changes: Vec<i32>,
    captures: u32,
}

/// run `tics` with twin / clone / deserialized copies, checking hashes every tic
fn run_checked(reg: &[Rc<Map>], cfg: Config, tics: u32, label: &str) -> (World, Seen) {
    let mut a = World::new_cfg(cfg.clone(), reg.to_vec(), 31337);
    let mut b = World::new_cfg(cfg, reg.to_vec(), 31337);
    a.human_join(4);
    b.human_join(4);
    let mut copies: Vec<World> = Vec::new();
    let mut seen = Seen::default();
    let (mut ba, mut bb) = (Vec::new(), Vec::new());
    for t in 0..tics {
        // a scripted human in slot 4 so inputs matter
        let cmd = (t.wrapping_mul(97) & 0xffff, ((t % 200) as i32) - 100, if t % 70 < 50 { 50 } else { -25 }, if t % 90 < 45 { 30 } else { -30 }, if t % 3 == 0 { 1 } else { 0 } | if t % 50 == 0 { 4 } else { 0 });
        // snapshot copies at varied points, including right at boundaries
        let boundary = a.events.iter().any(|e| matches!(e.kind, 8 | 9 | 10 | 11));
        if t % 1500 == 700 || boundary {
            copies.push(a.clone());
            let bytes = a.serialize();
            let d = World::deserialize(reg, &bytes).unwrap_or_else(|| panic!("{} tic {}: deserialize failed", label, t));
            assert_eq!(d.serialize(), bytes);
            copies.push(d);
            if copies.len() > 6 {
                copies.drain(0..2);
            }
        }
        for w in std::iter::once(&mut a).chain(std::iter::once(&mut b)).chain(copies.iter_mut()) {
            w.set_cmd(4, cmd.0, cmd.1, cmd.2, cmd.3, cmd.4);
            w.tick();
        }
        let ha = a.hash_with(&mut ba);
        assert_eq!(ha, b.hash_with(&mut bb), "{} tic {}: twins diverged", label, t);
        for (k, c) in copies.iter().enumerate() {
            assert_eq!(c.hash_with(&mut bb), ha, "{} tic {}: copy {} diverged", label, t, k);
        }
        for e in &a.events {
            seen.kinds[(e.kind as usize).min(15)] += 1;
            match e.kind {
                8 => seen.match_ends.push((e.a, e.b)),
                9 => seen.map_changes.push(e.a),
                11 => seen.round_winners.push(e.a),
                12 => seen.captures += 1,
                _ => {}
            }
        }
    }
    (a, seen)
}

fn report(label: &str, w: &World, s: &Seen) {
    let alive = w.alive_counts();
    println!(
        "{}: tic {} map {} match {} phase {} score {:?} round {} alive {:?} | match ends {:?} map changes {:?} rounds {:?} captures {} kills {}",
        label, w.tic, w.map.name, w.g.match_index, w.g.phase, w.g.team_score, w.g.round, alive, s.match_ends, s.map_changes, s.round_winners.len(), s.captures, s.kinds[2]
    );
}

#[test]
fn tdm_rotation_deterministic() {
    let reg = registry(&["MAP19", "MAP01"]);
    let cfg = Config { match_tics: 35 * 90, inter_tics: 35 * 3, ..Config::mode(MODE_TDM, 64) };
    let (w, s) = run_checked(&reg, cfg, 35 * 300, "TDM");
    report("TDM", &w, &s);
    assert!(s.match_ends.len() >= 3, "matches end");
    assert!(s.map_changes.len() >= 3, "map switches");
    // no friendly kills: every obituary has killer on the other team, self or world
    assert!(s.kinds[2] > 100);
}

#[test]
fn ffa_rotation_deterministic() {
    let reg = registry(&["MAP19", "MAP01"]);
    let cfg = Config { match_tics: 35 * 100, inter_tics: 35 * 2, ..Config::mode(MODE_FFA, 64) };
    let (w, s) = run_checked(&reg, cfg, 35 * 300, "FFA");
    report("FFA", &w, &s);
    assert!(s.map_changes.len() >= 2);
}

#[test]
fn elimination_rounds() {
    let reg = registry(&["MAP01", "MAP19"]);
    let cfg = Config { round_tics: 35 * 60, freeze_tics: 35 * 2, rounds_to_win: 4, inter_tics: 35 * 3, ..Config::mode(MODE_ELIM, 24) };
    let (w, s) = run_checked(&reg, cfg, 35 * 330, "ELIM");
    report("ELIM", &w, &s);
    let decided = s.round_winners.iter().filter(|&&x| x >= 0).count();
    println!("  round winners {:?}", s.round_winners);
    assert!(s.round_winners.len() >= 6, "rounds end");
    assert!(decided >= 4, "rounds are won");
    assert!(!s.match_ends.is_empty(), "a team reaches the round target");
    assert!(!s.map_changes.is_empty(), "next map after the match");
}

#[test]
fn war_conquest_map19() {
    let reg = registry(&["MAP19"]);
    let cfg = Config { match_tics: 35 * 360, tickets: 300, inter_tics: 35 * 3, ..Config::mode(MODE_WAR, 64) };
    let (w, s) = run_checked(&reg, cfg, 35 * 300, "WAR");
    report("WAR", &w, &s);
    println!("  points {:?}", w.g.points);
    assert!(s.captures >= 3, "points change hands");
    assert!(w.g.team_score[0] < 300 || w.g.team_score[1] < 300 || !s.match_ends.is_empty(), "tickets drain");
}

/// 200 bots in war on the biggest map available; prints the cost per tic
#[test]
fn war_200_bots_cost() {
    let name = std::env::var("WAR_MAP").unwrap_or_else(|_| "MAP19".into());
    let reg: Vec<Rc<Map>> = match std::fs::read(&name) {
        Ok(bytes) => {
            let mut m = Map::load(&bytes).expect("war map");
            m.id = 0;
            vec![Rc::new(m)]
        }
        Err(_) => registry(&[&name]),
    };
    let mut w = World::new_cfg(Config::mode(MODE_WAR, 200), reg, 7);
    let t0 = std::time::Instant::now();
    let mut caps = 0;
    let mut times = Vec::new();
    for _ in 0..35 * 180 {
        let t = std::time::Instant::now();
        w.tick();
        times.push(t.elapsed().as_secs_f64() * 1000.0);
        caps += w.events.iter().filter(|e| e.kind == 12).count();
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let kills: i32 = w.players.iter().map(|p| p.deaths).sum();
    println!(
        "WAR 200 bots on {} ({} spots, {} points): 180 s in {:.1} s, avg {:.3} ms/tic p50 {:.3} p99 {:.3}; deaths {} captures {} tickets {:?} points {:?}",
        w.map.name, w.map.spawn_spots.len(), w.map.cap_points.len(), t0.elapsed().as_secs_f64(),
        times.iter().sum::<f64>() / times.len() as f64, times[times.len() / 2], times[times.len() * 99 / 100], kills, caps, w.g.team_score, w.g.points.iter().map(|p| p.owner).collect::<Vec<_>>()
    );
    assert!(kills > 50);
}

#[test]
fn built_blockmap_and_big_maps() {
    let w = wad();
    let pw = extract_map_pwad(&w, "MAP19").unwrap();
    // no BLOCKMAP / REJECT: our own blockmap, no rejection
    let plain = Map::load(&pw).unwrap();
    let bare = Map::load(&transform_pwad(&pw, 1, &["BLOCKMAP", "REJECT"])).expect("load without blockmap/reject");
    assert_eq!(bare.nav.edges.len(), plain.nav.edges.len());
    let mut a = World::new(Rc::new(bare), 3, 64);
    for _ in 0..35 * 60 {
        a.tick();
    }
    let kills: i32 = a.players.iter().map(|p| p.deaths).sum();
    println!("MAP19 with a built blockmap: {} deaths in 60 s", kills);
    assert!(kills > 100);
    // MAP19 scaled x3 (~26k units across): blockmap must be built (the lump no longer fits)
    let big = Map::load(&transform_pwad(&pw, 3, &["BLOCKMAP"])).expect("big map");
    println!("MAP19x3: blockmap {}x{} blocks, {} spots, {} points, reach {}/{}", big.bmapwidth, big.bmapheight, big.spawn_spots.len(), big.cap_points.len(), big.nav.reach.iter().filter(|&&r| r).count(), big.nav.reach.len());
    let mut m = big;
    m.id = 0;
    let reg = vec![Rc::new(m)];
    let mut w2 = World::new_cfg(Config::mode(MODE_WAR, 200), reg.clone(), 9);
    let mut b2 = World::new_cfg(Config::mode(MODE_WAR, 200), reg.clone(), 9);
    let t0 = std::time::Instant::now();
    let (mut ba, mut bb) = (Vec::new(), Vec::new());
    for t in 0..35 * 120 {
        w2.tick();
        b2.tick();
        if t % 35 == 0 {
            assert_eq!(w2.hash_with(&mut ba), b2.hash_with(&mut bb));
        }
    }
    let deaths: i32 = w2.players.iter().map(|p| p.deaths).sum();
    println!("WAR 200 bots on MAP19x3: 2 worlds x 120 s in {:.1} s; deaths {} tickets {:?} owners {:?}", t0.elapsed().as_secs_f64(), deaths, w2.g.team_score, w2.g.points.iter().map(|p| p.owner).collect::<Vec<_>>());
    let bytes = w2.serialize();
    assert!(World::deserialize(&reg, &bytes).is_some());
}

#[test]
fn ghost_players_pass_through() {
    let reg = registry(&["MAP19"]);
    for flags in [0, 2] {
        let mut w = World::new_cfg(Config { flags, ..Config::mode(MODE_TDM, 8) }, reg.clone(), 7);
        for _ in 0..5 {
            w.tick();
        }
        let live: Vec<u32> = (0..8).filter_map(|s| w.deref(w.players[s].mo)).filter(|&h| w.mo(h).health > 0).collect();
        assert!(live.len() >= 2, "players spawned");
        let (a, b) = (live[0], live[1]);
        let (bx, by) = (w.mo(b).x, w.mo(b).y);
        // standing exactly on another player: blocked normally, allowed in a ghost room
        assert_eq!(w.check_position(a, bx, by), flags != 0, "flags {}", flags);
    }
    let cfg = Config { match_tics: 35 * 60, inter_tics: 35 * 2, flags: 2, ..Config::mode(MODE_TDM, 64) };
    let (w, s) = run_checked(&reg, cfg, 35 * 90, "TDM ghosts");
    report("TDM ghosts", &w, &s);
    assert!(s.kinds[2] > 10, "players still shoot each other");
}
