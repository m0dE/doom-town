// Battle royale (DESIGN.md "Battle royale"): one life, the zone, crates, zoom, bots.
mod common;
use common::*;
use doomsim::fixed::*;
use doomsim::game::*;
use doomsim::info::*;
use doomsim::map::*;
use doomsim::royale::*;
use doomsim::world::*;
use std::collections::HashSet;
use std::rc::Rc;

fn public_map(name: &str) -> Option<Vec<u8>> {
    std::fs::read(format!("{}/../public/maps/{}.map.wad", env!("CARGO_MANIFEST_DIR"), name)).ok()
}

fn load_reg(pwad: &[u8]) -> Vec<Rc<Map>> {
    let mut m = Map::load(pwad).expect("map loads");
    m.id = 0;
    vec![Rc::new(m)]
}

/// the PWAD with extra things appended to THINGS
fn add_things(pwad: &[u8], extra: &[MapThing]) -> Vec<u8> {
    let lumps = wad_lumps(pwad).unwrap();
    let mut sel: Vec<(String, Vec<u8>)> = Vec::new();
    for l in &lumps {
        let mut d = l.data.to_vec();
        if l.name == "THINGS" {
            for t in extra {
                for v in [t.x, t.y, t.angle, t.type_, t.options] {
                    d.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
        sel.push((l.name.clone(), d));
    }
    let mut data: Vec<u8> = Vec::new();
    let mut dir: Vec<u8> = Vec::new();
    let mut pos = 12u32;
    for (n, d) in &sel {
        dir.extend_from_slice(&pos.to_le_bytes());
        dir.extend_from_slice(&(d.len() as u32).to_le_bytes());
        let mut nm = [0u8; 8];
        for (i, c) in n.bytes().take(8).enumerate() {
            nm[i] = c;
        }
        dir.extend_from_slice(&nm);
        data.extend_from_slice(d);
        pos += d.len() as u32;
    }
    let mut out = b"PWAD".to_vec();
    out.extend_from_slice(&(sel.len() as u32).to_le_bytes());
    out.extend_from_slice(&(12 + data.len() as u32).to_le_bytes());
    out.extend_from_slice(&data);
    out.extend_from_slice(&dir);
    out
}

/// WAR01 with crates (thing 9020) next to every 4th spawn spot, where they fit
fn war01_with_crates() -> Vec<u8> {
    let pw = public_map("WAR01").expect("public/maps/WAR01.map.wad");
    let map = Map::load(&pw).unwrap();
    let mut extra = Vec::new();
    for (i, s) in map.spawn_spots.iter().enumerate() {
        if i % 4 != 0 {
            continue;
        }
        for (dx, dy) in [(56i16, 0i16), (-56, 0), (0, 56), (0, -56)] {
            let (x, y) = (s.x.saturating_add(dx), s.y.saturating_add(dy));
            let (fx, fy) = ((x as i32) << FRACBITS, (y as i32) << FRACBITS);
            let ss = map.point_in_subsector(fx, fy);
            if map.nav.reach[ss] && doomsim::bots::nav::static_clear(&map, fx, fy, 24 * FRACUNIT, false) {
                extra.push(MapThing { x, y, angle: 0, type_: 9020, options: 0 });
                break;
            }
        }
    }
    assert!(extra.len() >= 20, "crates placed: {}", extra.len());
    add_things(&pw, &extra)
}

fn count_type(w: &World, t: usize) -> usize {
    w.mobjs.iter().flatten().filter(|m| m.type_ as usize == t).count()
}

#[test]
fn br_config_defaults() {
    let c = Config::mode(MODE_BR, 0);
    assert_eq!((c.mode, c.slots, c.match_tics, c.br.lobby_tics, c.br.drop_alt, c.br.start_bullets), (MODE_BR, 64, 35 * 900, 35 * 45, 4096, 20));
    assert!(c.br.vehicles && c.br.supply && c.br.stages.len() == 5 && c.br.loot.len() == LOOT.len());
    assert!(!c.teams());
    assert!(!Config { flags: 1, ..c.clone() }.bosses());
}

/// a full match with 64 bots: lobby, dropship, landing, the zone closes in and hurts,
/// crates are opened (mostly by use) and their loot is picked up, the match ends with a
/// last marine standing and the next one rebuilds the crates
#[test]
fn br_match_war01_64_bots() {
    let reg = load_reg(&war01_with_crates());
    let mut w = World::new_cfg(fast(Config::mode(MODE_BR, 64)), reg, 4242);
    let crates0 = count_type(&w, mt::CRATE);
    assert!(crates0 >= 20);
    assert_eq!(w.team_of(3), -1);
    let mut zone_events: Vec<(i32, i32, i32)> = Vec::new();
    let mut zone_deaths = 0;
    let mut zone_hits = 0;
    let mut crate_events = 0;
    let mut crate_by_player = 0;
    let mut crate_by_use = 0;
    let mut spilled = 0;
    let mut dropped_seen: HashSet<u32> = HashSet::new();
    let mut alive_at_play = 0;
    let mut alive_min = 99;
    let mut last_r = i32::MAX;
    let mut end: Option<(i32, u32)> = None;
    let mut respawn_in_play = 0;
    let mut timeline: Vec<usize> = Vec::new();
    let mut play_start = 0u32;
    let mut boarded = 0;
    let mut mods = [0u32; 17];
    let t0 = std::time::Instant::now();
    for t in 0..35 * 960u32 {
        let phase_before = w.g.phase;
        w.tick();
        if play_start > 0 && t == play_start + 35 * 40 {
            assert!(w.players.iter().all(|p| p.air == 0), "everyone landed 40 s into play");
        }
        if phase_before == PH_LOBBY && w.g.phase == PH_DROP {
            boarded = w.players.iter().filter(|p| p.air == 1).count();
        }
        if phase_before == PH_DROP && w.g.phase == PH_PLAY {
            alive_at_play = w.br_alive().len();
            play_start = t;
        }
        for e in &w.events {
            match e.kind {
                EV_ZONE => zone_events.push((e.a, e.b, e.c)),
                EV_CRATE => {
                    crate_events += 1;
                    spilled += e.b;
                    assert!((4..=21).contains(&e.b), "spill {}", e.b);
                    if e.a >= 0 {
                        crate_by_player += 1;
                        if w.players[e.a as usize].cmd.buttons & 2 != 0 {
                            crate_by_use += 1;
                        }
                    }
                }
                2 => {
                    mods[(e.c as usize).min(16)] += 1;
                    if e.c == MOD_ZONE {
                        zone_deaths += 1;
                    }
                }
                4 if e.b < 0 && w.g.phase == PH_PLAY => zone_hits += 1,
                5 if e.b == 0 && phase_before == PH_PLAY => respawn_in_play += 1,
                8 => end = Some((e.a, t)),
                _ => {}
            }
        }
        if phase_before == PH_PLAY {
            let v = w.br_view();
            assert!(v[2] <= last_r, "zone radius never grows");
            last_r = v[2];
            alive_min = alive_min.min(v[9]);
            assert_eq!(v[9] as usize, w.br_alive().len());
        }
        if t % (35 * 30) == 0 {
            timeline.push(w.br_alive().len());
        }
        if t % 35 == 0 {
            for m in w.mobjs.iter().flatten() {
                if m.flags & MF_DROPPED != 0 && m.flags & MF_SPECIAL != 0 {
                    dropped_seen.insert(m.id);
                }
            }
        }
        if end.is_some() {
            break;
        }
    }
    let live_ids: HashSet<u32> = w.mobjs.iter().flatten().map(|m| m.id).collect();
    let taken = dropped_seen.iter().filter(|id| !live_ids.contains(id)).count();
    let pickups: i32 = w.players.iter().map(|p| p.items).sum();
    println!(
        "BR WAR01: {:.1}s; alive at play {} min {} | zone events {:?} | zone hits {} zone deaths {} | crates {} opened {} (by players {}, by use {}) spilled {} loot taken {}/{} items {} | end {:?}",
        t0.elapsed().as_secs_f64(), alive_at_play, alive_min, zone_events, zone_hits, zone_deaths, crates0, crate_events, crate_by_player, crate_by_use, spilled, taken, dropped_seen.len(), pickups, end
    );
    println!("  alive every 30 s {:?}; deaths by mod {:?}", timeline, mods);
    println!("  boarded {} alive when the ship left {}", boarded, alive_at_play);
    assert_eq!(boarded, 64, "everyone boards the ship");
    assert_eq!(respawn_in_play, 0, "one life");
    assert!(alive_min <= 1, "down to the last marine");
    assert_eq!(zone_events[0], (1, 0, 35 * 60), "zone clock");
    // one event per state change: 0, 60, 120, 165, 210, 250, 290, 320, 350, 380, 410 s into play
    let play_tics = end.map(|e| e.1).unwrap_or(0) + 1 - play_start;
    let mut bounds = vec![0u32];
    for [wait, shrink, _, _] in DEFAULT_STAGES {
        let last = *bounds.last().unwrap();
        bounds.push(last + wait as u32);
        bounds.push(last + (wait + shrink) as u32);
    }
    let expect = bounds.iter().filter(|&&b| b < play_tics).count();
    assert_eq!(zone_events.len(), expect, "zone events {:?} in {} tics of play", zone_events, play_tics);
    assert!(zone_events.windows(2).all(|p| (p[1].0, p[1].1) > (p[0].0, p[0].1)), "zone stages advance");
    assert!(zone_hits > 0, "the zone hurts");
    assert!(crate_events >= 10 && crate_by_use >= 5, "bots open crates with use");
    assert!(taken >= 20, "spilled loot is picked up");
    let (winner, _) = end.expect("the match ends");
    assert!(winner >= 0 && (winner as usize) < 64);
    assert_eq!(w.g.phase, PH_INTER);
    // the next match: everyone back, crates rebuilt
    for _ in 0..INTER_TICS + 2 {
        w.tick();
    }
    assert_eq!(w.g.phase, PH_LOBBY);
    assert_eq!(count_type(&w, mt::CRATE), crates0);
    for _ in 0..35 * 60 {
        w.tick();
        if w.g.phase == PH_DROP {
            break;
        }
    }
    assert_eq!(w.g.phase, PH_DROP);
    assert_eq!(w.players.iter().filter(|p| p.air == 1).count(), 64, "everyone boards again");
}

/// twins, clones and deserialized copies step identically in battle royale, with a
/// scripted human using zoom, use and fire
#[test]
fn br_determinism() {
    let reg = load_reg(&mod_br01().unwrap_or_else(war01_with_crates));
    let cfg = fast(Config::mode(MODE_BR, 64));
    let mut a = World::new_cfg(cfg.clone(), reg.clone(), 777);
    let mut b = World::new_cfg(cfg, reg.clone(), 777);
    a.human_join(4);
    b.human_join(4);
    let mut copies: Vec<World> = Vec::new();
    let (mut ba, mut bb) = (Vec::new(), Vec::new());
    let mut kinds = [0u32; 19];
    let mut landed = 0;
    for t in 0..35 * 240u32 {
        let buttons = (if t % 3 == 0 { 1 } else { 0 }) | (if t % 20 == 0 { 2 } else { 0 }) | (if t % 50 == 0 { 4 } else { 0 }) | (if t % 200 < 100 { 8 } else { 0 }) | (if t % 400 == 399 { 0x400 } else { 0 });
        if t == 35 * 20 {
            // something to throw and something to snipe with
            for w in std::iter::once(&mut a).chain(std::iter::once(&mut b)).chain(copies.iter_mut()) {
                w.players[4].grenades = 5;
            }
        }
        let cmd = (t.wrapping_mul(97) & 0xffff, ((t % 200) as i32) - 100, if t % 70 < 50 { 50 } else { -25 }, if t % 90 < 45 { 30 } else { -30 }, buttons);
        if t % 1000 == 400 || a.events.iter().any(|e| matches!(e.kind, 8 | 16 | 17 | 18) || e.kind == 5 && e.b == 2 && e.a == 4) && copies.len() < 4 || (a.g.phase == PH_DROP && t % 97 == 0) {
            copies.push(a.clone());
            let bytes = a.serialize();
            let d = World::deserialize(&reg, &bytes).unwrap_or_else(|| panic!("tic {}: deserialize failed", t));
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
        assert_eq!(ha, b.hash_with(&mut bb), "tic {}: twins diverged", t);
        for (k, c) in copies.iter().enumerate() {
            assert_eq!(c.hash_with(&mut bb), ha, "tic {}: copy {} diverged", t, k);
        }
        for e in &a.events {
            kinds[(e.kind as usize).min(18)] += 1;
            if e.kind == 5 && e.b == 2 {
                landed += 1;
            }
        }
    }
    println!("BR determinism on {}: events by kind {:?}; landed {}; alive {}", a.map.name, kinds, landed, a.br_alive().len());
    assert!(kinds[16] >= 2 && kinds[17] >= 1 && kinds[2] >= 5 && landed >= 60);
}

/// a small BR world on WAR01 with two humans who jump out of the ship at once, in play
fn duel() -> World {
    let reg = load_reg(&public_map("WAR01").expect("WAR01"));
    let mut cfg = Config::mode(MODE_BR, 2);
    cfg.br.lobby_tics = 35;
    cfg.br.drop_alt = 512;
    let mut w = World::new_cfg(cfg, reg, 5);
    w.human_join(0);
    w.human_join(1);
    for t in 0..35 * 60 {
        for s in 0..2 {
            w.set_cmd(s, 0, 0, 0, 0, if t % 2 == 0 { 4 } else { 0 });
        }
        w.tick();
        if w.g.phase == PH_PLAY && w.players.iter().all(|p| p.air == 0 && w.deref(p.mo).is_some()) {
            break;
        }
    }
    for s in 0..2 {
        w.set_cmd(s, 0, 0, 0, 0, 0);
    }
    // settle (the last jump press)
    for _ in 0..40 {
        w.tick();
    }
    assert_eq!(w.g.phase, PH_PLAY);
    w
}

/// BR01, the battle royale mod (map + MODINFO + art in one PWAD)
fn mod_br01() -> Option<Vec<u8>> {
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../public/mods/br01.wad")).ok()
}

/// a short lobby (tests)
fn fast(mut c: Config) -> Config {
    c.br.lobby_tics = 35 * 5;
    c
}

/// point slot 0 at (x, y) through its absolute-yaw command
fn face(w: &mut World, x: Fixed, y: Fixed, buttons: u32, forward: i32) {
    let h = w.deref(w.players[0].mo).unwrap();
    let (px, py) = (w.mo(h).x, w.mo(h).y);
    let a = point_to_angle2(px, py, x, y).wrapping_sub(w.players[0].yaw_offset);
    w.set_cmd(0, a >> 16, 0, forward, 0, buttons);
}

/// a place `d` units in front of slot 0 where a crate fits
fn spot_ahead(w: &World, d: i32) -> (Fixed, Fixed) {
    let h = w.deref(w.players[0].mo).unwrap();
    let (px, py) = (w.mo(h).x, w.mo(h).y);
    for k in 0..16u32 {
        let a = ANG45.wrapping_div(2).wrapping_mul(k);
        let (x, y) = (px + d * finecosine(fine(a)), py + d * finesine(fine(a)));
        let ss = w.map.point_in_subsector(x, y);
        let sec = w.map.subsectors[ss].sector as usize;
        let sec0 = w.map.subsectors[w.mo(h).subsector as usize].sector as usize;
        if w.sectors[sec].floorheight == w.sectors[sec0].floorheight && doomsim::bots::nav::static_clear(&w.map, x, y, 40 * FRACUNIT, false) {
            return (x, y);
        }
    }
    panic!("no room for a crate");
}

#[test]
fn crate_opens_by_use_and_damage_and_loot_is_taken() {
    let mut w = duel();
    // a crate from a synthetic map thing (skill bits not required)
    let (x, y) = spot_ahead(&w, 80);
    w.spawn_map_thing(&MapThing { x: (x >> FRACBITS) as i16, y: (y >> FRACBITS) as i16, angle: 0, type_: 9020, options: 0 });
    assert_eq!(count_type(&w, mt::CRATE), 1);
    let c = w.mobjs.iter().position(|m| m.as_ref().is_some_and(|m| m.type_ as usize == mt::CRATE)).unwrap() as u32;
    assert_eq!((w.mo(c).radius, w.mo(c).height, w.mo(c).health), (20 * FRACUNIT, 40 * FRACUNIT, 25));
    assert_eq!(w.mo(c).flags & (MF_SOLID | MF_SHOOTABLE | MF_NOBLOOD), MF_SOLID | MF_SHOOTABLE | MF_NOBLOOD);
    let (cx, cy) = (w.mo(c).x, w.mo(c).y);
    // facing away: use does nothing
    let (ax, ay) = {
        let m = w.mo(w.deref(w.players[0].mo).unwrap());
        (2 * m.x - cx, 2 * m.y - cy)
    };
    face(&mut w, ax, ay, 0, 0);
    w.tick();
    face(&mut w, ax, ay, 2, 0);
    w.tick();
    assert_eq!(count_type(&w, mt::CRATE), 1, "not facing it");
    face(&mut w, cx, cy, 0, 0);
    w.tick();
    face(&mut w, cx, cy, 2, 0);
    w.tick();
    let ev: Vec<Event> = w.events.iter().copied().filter(|e| e.kind == EV_CRATE).collect();
    assert_eq!(ev.len(), 1, "use opens the crate");
    assert_eq!(ev[0].a, 0);
    assert!((4..=21).contains(&ev[0].b));
    assert!(w.events.iter().any(|e| e.kind == 1 && e.a == sfx_pstop()), "break sound");
    assert_eq!(count_type(&w, mt::CRATE), 0);
    let loot: Vec<u32> = w.mobjs.iter().flatten().filter(|m| m.flags & MF_DROPPED != 0).map(|m| m.id).collect();
    assert_eq!(loot.len() as i32, ev[0].b);
    let health_armor = [mt::MISC2, mt::MISC3, mt::MISC10, mt::MISC11, mt::MISC0, mt::MISC1];
    assert!(w.mobjs.iter().flatten().any(|m| m.flags & MF_DROPPED != 0 && health_armor.contains(&(m.type_ as usize))), "a health/armor bunch");
    assert!(w.mobjs.iter().flatten().filter(|m| m.flags & MF_DROPPED != 0).any(|m| m.momx != 0 || m.momy != 0), "spilled with momentum");
    // it all comes to rest on the floor
    w.set_cmd(0, 0, 0, 0, 0, 0);
    for _ in 0..105 {
        w.tick();
    }
    for m in w.mobjs.iter().flatten().filter(|m| m.flags & MF_DROPPED != 0) {
        assert!(m.momx == 0 && m.momy == 0 && m.momz == 0 && m.z == m.floorz, "at rest: {:?}", (m.type_, m.momx, m.momy, m.z, m.floorz));
    }
    // walk over the loot (hurt, so every kind of item is wanted)
    w.players[0].health = 50;
    let h = w.deref(w.players[0].mo).unwrap();
    w.mo_mut(h).health = 50;
    let mut picked = 0;
    for _ in 0..35 * 12 {
        let h = w.deref(w.players[0].mo).unwrap();
        let (px, py) = (w.mo(h).x, w.mo(h).y);
        let near = w
            .mobjs
            .iter()
            .flatten()
            .filter(|m| m.flags & MF_DROPPED != 0 && loot.contains(&m.id))
            .min_by_key(|m| aprox_distance(m.x - px, m.y - py))
            .map(|m| (m.x, m.y));
        match near {
            Some((ix, iy)) => face(&mut w, ix, iy, 0, 25),
            None => break,
        }
        w.tick();
        picked += w.events.iter().filter(|e| e.kind == 3 && e.a == 0).count();
    }
    println!("crate: spilled {} picked up {}", loot.len(), picked);
    assert!(picked >= 2, "spilled loot can be picked up");

    // damage opens a crate too (no opener)
    let (x2, y2) = spot_ahead(&w, 200);
    let c2 = w.spawn_mobj(x2, y2, ONFLOORZ, mt::CRATE);
    w.damage_mobj(c2, NONE, NONE, 1, 0);
    let ev: Vec<Event> = w.events.iter().copied().filter(|e| e.kind == EV_CRATE).collect();
    assert_eq!(ev.last().map(|e| e.a), Some(-1));
    assert!(!w.alive(c2) || w.mo(c2).type_ as usize != mt::CRATE);
}

fn sfx_pstop() -> i32 {
    SFXNAMES.iter().position(|&n| n == "pstop").unwrap() as i32
}

#[test]
fn zoom_half_speed_and_marksman_pistol() {
    let mut w = duel();
    let h0 = w.deref(w.players[0].mo).unwrap();
    // half speed while zoomed (one tic of thrust from rest)
    let speed = |w: &mut World, buttons: u32| {
        let h = w.deref(w.players[0].mo).unwrap();
        {
            let m = w.mo_mut(h);
            m.momx = 0;
            m.momy = 0;
        }
        let yaw = (w.mo(h).angle.wrapping_sub(w.players[0].yaw_offset)) >> 16;
        w.set_cmd(0, yaw, 0, 50, 0, buttons);
        w.tick();
        let m = w.mo(h);
        aprox_distance(m.momx, m.momy)
    };
    let full = speed(&mut w, 0);
    let half = speed(&mut w, 8);
    println!("thrust: {} zoomed {}", full, half);
    assert!(full > 0 && (half - full / 2).abs() <= full / 10, "half speed zoomed: {} vs {}", half, full);
    // the other marine stands 256 units in front; zoomed pistol shots do 15, 30 or 45
    let (px, py, pa) = {
        let m = w.mo(h0);
        (m.x, m.y, m.angle)
    };
    let (tx, ty) = spot_ahead(&w, 256);
    let h1 = w.deref(w.players[1].mo).unwrap();
    assert!(w.teleport_move(h1, tx, ty));
    let _ = (px, py, pa);
    let mut dmg = Vec::new();
    for t in 0..35 * 4u32 {
        let h1 = match w.deref(w.players[1].mo) {
            Some(h) if w.players[1].playerstate == PST_LIVE => h,
            _ => break,
        };
        let (ex, ey) = (w.mo(h1).x, w.mo(h1).y);
        w.players[1].health = 1000; // keep the target alive for the sample
        w.mo_mut(h1).health = 1000;
        face(&mut w, ex, ey, if t % 2 == 0 { 1 | 8 } else { 8 }, 0);
        w.tick();
        for e in &w.events {
            if e.kind == 4 && e.a == 1 && e.b == 0 {
                dmg.push(e.c);
            }
        }
    }
    println!("zoomed pistol damage {:?}", dmg);
    assert!(dmg.len() >= 3, "shots land (no spread)");
    assert!(dmg.iter().all(|d| [15, 30, 45].contains(d)), "x3 damage");
}

/// the zone: stage 0 covers the map; outside the circle a live player loses the stage's
/// damage every second, armor ignored, obituary mod 16
#[test]
fn zone_damage_ignores_armor() {
    let mut w = duel();
    let v = w.br_view();
    assert_eq!((v[6], v[7]), (1, 0));
    assert!(v[8] > 0 && v[8] <= 35 * 60);
    assert!(v[5] < v[2] && v[5] > 0);
    // shrink the circle to nothing far away and give slot 0 armor
    w.g.zone.r = FRACUNIT;
    w.g.zone.x = w.map.vertexes[0].x;
    w.g.zone.y = w.map.vertexes[0].y;
    w.players[0].armorpoints = 200;
    w.players[0].armortype = 2;
    let mut hits = Vec::new();
    for _ in 0..70 {
        w.tick();
        for e in &w.events {
            if e.kind == 4 && e.a == 0 {
                hits.push((e.b, e.c));
            }
        }
    }
    assert_eq!(hits, vec![(-1, 1), (-1, 1)], "1 per second in stage 1, full damage");
    assert_eq!(w.players[0].armorpoints, 200);
    // stage 5 damage kills; obituary mod 16, no frag lost
    w.players[0].health = 5;
    w.mo_mut(w.deref(w.players[0].mo).unwrap()).health = 5;
    w.g.zone.stage = 5;
    let mut ob = None;
    for _ in 0..40 {
        w.tick();
        if let Some(e) = w.events.iter().find(|e| e.kind == 2) {
            ob = Some(*e);
        }
        if w.g.phase == PH_INTER {
            break;
        }
    }
    let ob = ob.expect("killed by the zone");
    assert_eq!((ob.a, ob.b, ob.c), (0, -1, MOD_ZONE));
    assert_eq!(w.players[0].frags, 0);
    // one left: the match ends with slot 1 the winner
    assert_eq!(w.g.phase, PH_INTER);
    assert_eq!(w.g.winner, 1);
    // dead spectate the survivor
    assert_eq!(w.spectating(0), 1);
}

/// late joiners wait for the next match
#[test]
fn br_joiner_waits() {
    let mut w = duel();
    // slot 1 handed to a new human mid-match: its body goes, it waits
    w.human_leave(1);
    w.human_join(1);
    for _ in 0..5 {
        w.tick();
    }
    assert!(w.deref(w.players[1].mo).is_none());
    assert_eq!(w.g.phase, PH_INTER, "one marine left");
}

/// BR01 (the battle royale map) once it ships: a short smoke with 64 bots
#[test]
fn br01_smoke() {
    let pw = match mod_br01() {
        Some(p) => p,
        None => {
            println!("BR01 not built yet: skipped");
            return;
        }
    };
    let reg = load_reg(&pw);
    let crates = count_type(&World::new_cfg(Config::mode(MODE_BR, 1), reg.clone(), 1), mt::CRATE);
    let mut w = World::new_cfg(fast(Config::mode(MODE_BR, 64)), reg.clone(), 99);
    let mut b = World::new_cfg(fast(Config::mode(MODE_BR, 64)), reg.clone(), 99);
    let st = run_stats(&mut w, 35 * 150);
    for _ in 0..35 * 150 {
        b.tick();
    }
    let (mut ba, mut bb) = (Vec::new(), Vec::new());
    assert_eq!(w.hash_with(&mut ba), b.hash_with(&mut bb));
    let bytes = w.serialize();
    assert!(World::deserialize(&reg, &bytes).is_some());
    println!(
        "BR01: {} spots, {} crates ({} left), alive {}, zone {:?}; deaths {} items {} stuck {} out of map {}; avg {} us/tic p99 {} max {}",
        w.map.spawn_spots.len(), crates, count_type(&w, mt::CRATE), w.br_alive().len(), w.br_view(), st.deaths, st.items, st.stuck_events, st.out_of_map,
        st.total_us / st.tics as u128, st.p99_us, st.max_tic_us
    );
    assert!(w.map.spawn_spots.len() >= 64);
    assert!(crates > 0);
    assert!(count_type(&w, mt::CRATE) < crates, "crates get opened");
    assert!(st.deaths > 0);
}

// ---------------------------------------------------------------- battle royale v2

/// an open, flat lane from slot 0's body: (angle, first point) with room for a buggy
fn open_lane(w: &World, from: i32, len: i32) -> (Angle, Fixed, Fixed) {
    let h = w.deref(w.players[0].mo).unwrap();
    let (px, py) = (w.mo(h).x, w.mo(h).y);
    let sec0 = w.map.sector_at(px, py);
    for k in 0..32u32 {
        let a = (ANG45 / 4).wrapping_mul(k);
        let ok = (from..=len).step_by(16).all(|d| {
            let (x, y) = (px + d * finecosine(fine(a)), py + d * finesine(fine(a)));
            let sec = w.map.sector_at(x, y);
            w.sectors[sec].floorheight == w.sectors[sec0].floorheight && doomsim::bots::nav::static_clear(&w.map, x, y, 48 * FRACUNIT, false)
        });
        if ok {
            return (a, px + from * finecosine(fine(a)), py + from * finesine(fine(a)));
        }
    }
    panic!("no open lane");
}

/// lobby on the island (no damage), everyone into the ship without a body, out, chutes,
/// landed on the playfield with the starting kit; nobody stays in the air
#[test]
fn lobby_drop_landing_br01() {
    let pw = match mod_br01() {
        Some(p) => p,
        None => return println!("br01.wad not built: skipped"),
    };
    let reg = load_reg(&pw);
    let map = reg[0].clone();
    assert!(!map.lobby_spots.is_empty(), "lobby spots (things 9030)");
    let (lx0, ly0, lx1, ly1) = map.lobby_spots.iter().fold((i32::MAX, i32::MAX, i32::MIN, i32::MIN), |b, s| (b.0.min(s.x as i32), b.1.min(s.y as i32), b.2.max(s.x as i32), b.3.max(s.y as i32)));
    let in_lobby = |x: Fixed, y: Fixed| {
        let (x, y) = (x >> FRACBITS, y >> FRACBITS);
        x >= lx0 - 600 && x <= lx1 + 600 && y >= ly0 - 600 && y <= ly1 + 600
    };
    assert!(map.spawn_spots.iter().all(|s| !in_lobby((s.x as i32) << FRACBITS, (s.y as i32) << FRACBITS)), "no spawn spot on the lobby island");
    println!("BR01: {} spawn spots, {} lobby spots, {} buggies, {} snipers, {} grenade packs", map.spawn_spots.len(), map.lobby_spots.len(),
        map.things.iter().filter(|t| t.type_ == 9040).count(), map.things.iter().filter(|t| t.type_ == 9050).count(), map.things.iter().filter(|t| t.type_ == 9051).count());
    let mut cfg = Config::mode(MODE_BR, 64);
    cfg.br.lobby_tics = 35 * 8;
    let mut w = World::new_cfg(cfg, reg, 1234);
    assert_eq!(w.g.phase, PH_LOBBY);
    assert!(count_type(&w, mt::BUGGY) > 0 && count_type(&w, mt::SNIPERRIFLE) > 0 && count_type(&w, mt::GRENADEPACK) > 0);
    let z = w.g.zone;
    assert!(!in_lobby(z.x, z.y), "zone centre off the island");
    let mut lobby_hurt = 0;
    while w.g.phase == PH_LOBBY {
        w.tick();
        lobby_hurt += w.events.iter().filter(|e| e.kind == 4 || e.kind == 2).count();
        for p in &w.players {
            if let Some(h) = w.deref(p.mo) {
                assert!(in_lobby(w.mo(h).x, w.mo(h).y), "lobby on the island");
                assert!(p.ammo[0] > 100 && p.ammo[0] <= 200, "200 bullets in the lobby");
            }
        }
    }
    assert_eq!(lobby_hurt, 0, "nothing hurts in the lobby");
    assert_eq!(w.g.phase, PH_DROP);
    assert!(w.players.iter().all(|p| p.air == 1 && w.deref(p.mo).is_none()), "all in the ship, no bodies");
    assert_eq!(count_type(&w, mt::DROPSHIP), 1);
    let v = w.br_view();
    assert!(v[11] > 0 && (v[14] != 0 || v[15] != 0));
    let mut landings = 0;
    let mut max_para = 0;
    let mut tracked = 0;
    let mut drop_end = 0;
    for t in 0..35 * 120u32 {
        w.tick();
        max_para = max_para.max(count_type(&w, mt::PARACHUTER));
        // what others see: a parachuter mobj sits at its player's virtual position
        for p in &w.players {
            if let Some(m) = w.deref(p.air_mo) {
                let m = w.mo(m);
                assert_eq!((m.x, m.y, m.z), (p.ax, p.ay, p.az), "parachuter mobj tracks PlayerView[52..54]");
                tracked += 1;
            }
        }
        for e in w.events.clone() {
            if e.kind == 5 && e.b == 2 {
                landings += 1;
                let p = &w.players[e.a as usize];
                let h = w.deref(p.mo).unwrap();
                assert!(!in_lobby(w.mo(h).x, w.mo(h).y), "landed on the playfield");
                assert_eq!(p.ammo[0], 20, "starting kit");
                assert!(p.weaponowned[0] && p.weaponowned[1] && !p.weaponowned[2]);
            }
        }
        if w.g.phase == PH_PLAY && drop_end == 0 {
            drop_end = t;
            let alive = w.br_alive().len();
            println!("BR01: {} alive when the ship reaches the end of its line", alive);
            assert!(alive >= 45, "landings spread out: {} alive at the end of the line", alive);
            assert_eq!(count_type(&w, mt::DROPSHIP), 0);
        }
        if drop_end > 0 && t > drop_end + 35 * 30 {
            break;
        }
    }
    let airborne: Vec<usize> = (0..64).filter(|&i| w.players[i].air != 0).collect();
    println!("BR01 drop: ship line {} tics, {} landings, {} chutes at once, still airborne {:?}", drop_end, landings, max_para, airborne);
    assert!(airborne.is_empty(), "nobody stuck in the air");
    assert!(tracked > 1000);
    assert!(landings >= 60);
    assert_eq!(count_type(&w, mt::PARACHUTER), 0);
}

#[test]
fn buggy_enter_drive_roadkill_exit_explode() {
    let mut w = duel();
    let (a, bx, by) = open_lane(&w, 96, 600);
    let b = w.spawn_mobj(bx, by, ONFLOORZ, mt::BUGGY);
    w.mo_mut(b).angle = a;
    assert_eq!(w.mo(b).health, 400);
    face(&mut w, bx, by, 0, 0);
    w.tick();
    face(&mut w, bx, by, 2, 0);
    w.tick();
    let h0 = w.deref(w.players[0].mo).unwrap();
    assert_eq!(w.players[0].vehicle.h, b, "use enters the buggy");
    assert!(w.mo(h0).flags & MF_NOBLOCKMAP != 0);
    // drive: forward, the body rides along
    let (x0, y0) = (w.mo(b).x, w.mo(b).y);
    for _ in 0..40 {
        w.set_cmd(0, 0, 0, 50, 0, 0);
        w.tick();
    }
    let moved = aprox_distance(w.mo(b).x - x0, w.mo(b).y - y0) >> FRACBITS;
    let speed = w.mo(b).movecount >> FRACBITS;
    println!("buggy: moved {} units, speed {}", moved, speed);
    assert!(moved > 150 && speed > 12);
    assert_eq!((w.mo(h0).x, w.mo(h0).y), (w.mo(b).x, w.mo(b).y));
    // roadkill: the other marine right in front
    let h1 = w.deref(w.players[1].mo).unwrap();
    let ah = fine(w.mo(b).angle);
    let (tx, ty) = (w.mo(b).x + 80 * finecosine(ah), w.mo(b).y + 80 * finesine(ah));
    if w.teleport_move(h1, tx, ty) {
        let mut hit = None;
        for _ in 0..10 {
            w.set_cmd(0, 0, 0, 50, 0, 0);
            w.tick();
            if let Some(e) = w.events.iter().find(|e| e.kind == 4 && e.a == 1 && e.b == 0) {
                hit = Some(e.c);
            }
        }
        println!("roadkill damage {:?}", hit);
        assert!(hit.is_some_and(|d| d >= 6), "run over");
    }
    // shots at the driver hit the buggy
    let hb = w.mo(b).health;
    w.damage_mobj(h0, NONE, NONE, 30, 0);
    assert_eq!(w.mo(b).health, hb - 30);
    assert_eq!(w.players[0].health, 100);
    // stop and get out
    for _ in 0..40 {
        w.set_cmd(0, 0, 0, 0, 0, 0);
        w.tick();
    }
    w.set_cmd(0, 0, 0, 0, 0, 2);
    w.tick();
    assert!(w.players[0].vehicle.is_null(), "use gets out");
    assert!(w.mo(h0).flags & MF_NOBLOCKMAP == 0);
    let d = aprox_distance(w.mo(h0).x - w.mo(b).x, w.mo(h0).y - w.mo(b).y) >> FRACBITS;
    assert!(d >= 48, "beside the buggy: {}", d);
    // back in, then it explodes: the driver is thrown out and takes the blast
    w.set_cmd(0, 0, 0, 0, 0, 0);
    w.tick();
    let (bx, by) = (w.mo(b).x, w.mo(b).y);
    face(&mut w, bx, by, 0, 0);
    w.tick();
    face(&mut w, bx, by, 2, 0);
    w.tick();
    assert_eq!(w.players[0].vehicle.h, b);
    w.players[0].health = 1000;
    w.mo_mut(h0).health = 1000;
    let n_before = w.events.len();
    let _ = n_before;
    w.damage_mobj(b, NONE, NONE, 1000, 0);
    assert!(!w.alive(b) || w.mo(b).type_ as usize != mt::BUGGY, "gone");
    assert!(w.players[0].vehicle.is_null());
    let hurt = w.events.iter().any(|e| e.kind == 4 && e.a == 0);
    assert!(hurt, "the driver takes the blast");
    assert_eq!(count_type(&w, mt::BUGGY), 0);
}

#[test]
fn sniper_and_grenade() {
    let mut w = duel();
    let h0 = w.deref(w.players[0].mo).unwrap();
    // a sniper rifle on the floor ahead: walk over it
    let (_, sx, sy) = open_lane(&w, 64, 400);
    w.spawn_mobj(sx, sy, ONFLOORZ, mt::SNIPERRIFLE);
    let mut got = false;
    for _ in 0..70 {
        face(&mut w, sx, sy, 0, 25);
        w.tick();
        got |= w.events.iter().any(|e| e.kind == 3 && e.a == 0 && e.c == 32);
    }
    assert!(got && w.players[0].weaponowned[WP_SNIPER as usize], "sniper picked up");
    assert_eq!(w.players[0].ammo[0], 30, "20 + 10 bullets");
    assert_eq!(w.players[0].readyweapon, WP_SNIPER, "switches to the new weapon");
    // key 2 toggles sniper -> pistol -> sniper
    for want in [WP_PISTOL, WP_SNIPER] {
        face(&mut w, sx, sy, 0, 0);
        w.tick();
        face(&mut w, sx, sy, 2 << 4, 0);
        w.tick();
        for _ in 0..40 {
            face(&mut w, sx, sy, 0, 0);
            w.tick();
        }
        assert_eq!(w.players[0].readyweapon, want);
    }
    // the other marine 400 units down the lane; zoomed shots: 70..100, 5 bullets each
    let (a, _, _) = open_lane(&w, 64, 450);
    let (px, py) = (w.mo(h0).x, w.mo(h0).y);
    let (tx, ty) = (px + 400 * finecosine(fine(a)), py + 400 * finesine(fine(a)));
    let h1 = w.deref(w.players[1].mo).unwrap();
    assert!(w.teleport_move(h1, tx, ty));
    let mut dmg = Vec::new();
    let mut fired_at = Vec::new();
    for t in 0..35 * 4u32 {
        w.players[1].health = 1000;
        w.mo_mut(h1).health = 1000;
        let (ex, ey) = (w.mo(h1).x, w.mo(h1).y);
        face(&mut w, ex, ey, 1 | 8, 0);
        let ammo = w.players[0].ammo[0];
        w.tick();
        if w.players[0].ammo[0] < ammo {
            fired_at.push(t);
            assert_eq!(ammo - w.players[0].ammo[0], 5);
        }
        for e in &w.events {
            if e.kind == 4 && e.a == 1 && e.b == 0 {
                dmg.push(e.c);
            }
        }
    }
    println!("sniper: shots at {:?} damage {:?}", fired_at, dmg);
    assert!(dmg.len() >= 2 && dmg.iter().all(|d| (70..=100).contains(d)));
    assert!(fired_at.windows(2).all(|p| p[1] - p[0] >= 50), "1.4 s between shots");
    // grenades: picked up as a pack (+2), thrown with bit 10, bounce, blow up at 70 tics
    let (_, gx, gy) = open_lane(&w, 48, 200);
    w.spawn_mobj(gx, gy, ONFLOORZ, mt::GRENADEPACK);
    for _ in 0..50 {
        face(&mut w, gx, gy, 0, 25);
        w.tick();
        if w.players[0].grenades > 0 {
            break;
        }
    }
    assert_eq!(w.players[0].grenades, 2);
    let h1 = w.deref(w.players[1].mo).unwrap();
    let (ex, ey) = (w.mo(h1).x, w.mo(h1).y);
    face(&mut w, ex, ey, 0x400, 0);
    w.tick();
    assert_eq!(w.players[0].grenades, 1);
    assert_eq!(count_type(&w, mt::GRENADE), 1);
    face(&mut w, ex, ey, 0, 0);
    let mut blast = None;
    for t in 0..80 {
        w.players[1].health = 1000;
        w.mo_mut(h1).health = 1000;
        w.tick();
        if w.events.iter().any(|e| e.kind == 1 && e.a == SFXNAMES.iter().position(|&n| n == "rxplod").unwrap() as i32) {
            blast = Some(t);
        }
    }
    println!("grenade blew up at tic {:?}", blast);
    assert!(blast.is_some_and(|t| (66..=70).contains(&t)), "fuse 70 tics");
}

#[test]
fn supply_drop() {
    let mut w = duel();
    // end stage 1 now: stage 2 starts and a supply drop is announced inside the next circle
    w.g.zone.state = 1;
    w.g.zone.left = 1;
    w.tick();
    let ev = w.events.iter().find(|e| e.kind == EV_SUPPLY).copied().expect("event 18");
    assert_eq!((ev.a, ev.b), (2, 35 * 10));
    let v = w.br_view();
    assert_eq!((v[16], v[17], v[18]), (ev.x, ev.y, 1));
    let mut landed = None;
    for _ in 0..35 * 20 {
        w.tick();
        if let Some(c) = w.mobjs.iter().flatten().find(|m| m.flags & MF_SUPPLY != 0) {
            landed = Some((c.x, c.y));
            break;
        }
    }
    assert_eq!(landed, Some((ev.x, ev.y)));
    assert_eq!(w.br_view()[18], 2);
    let c = w.mobjs.iter().position(|m| m.as_ref().is_some_and(|m| m.flags & MF_SUPPLY != 0)).unwrap() as u32;
    w.damage_mobj(c, NONE, NONE, 1, 0);
    let ev = w.events.iter().find(|e| e.kind == EV_CRATE).copied().unwrap();
    assert_eq!(ev.c, 1, "a supply crate");
    let rare = [mt::SNIPERRIFLE, mt::MISC25, mt::MISC1, mt::MEGA, mt::MISC12, mt::MISC28, mt::MISC27, mt::MISC19, mt::GRENADEPACK];
    assert!(w.mobjs.iter().flatten().filter(|m| m.flags & MF_DROPPED != 0).all(|m| rare.contains(&(m.type_ as usize))));
    w.tick();
    assert_eq!(w.br_view()[18], 0);
}

/// the rules block through the ABI: world_new_cfg words + [count, (key, value) x count]
#[test]
fn rules_block() {
    let pw = public_map("WAR01").unwrap();
    let id = unsafe { doomsim::abi::map_load(pw.as_ptr(), pw.len() as u32) };
    assert!(id >= 0);
    // two fast stages, no vehicles, snipers only, 3 s lobby, 50 starting bullets
    let rules: Vec<(u32, i32)> = vec![(2, 105), (4, 50), (5, 0), (7, 2), (8, 35), (9, 35), (10, 500), (11, 3), (12, 35), (13, 35), (14, 0), (15, 9), (999, 1)];
    let mut words: Vec<u32> = vec![2, MODE_BR, 4, 0, 0, 0, 0, 0, 0, 0, 1, id as u32, 77, 0, rules.len() as u32];
    for (k, v) in &rules {
        words.push(*k);
        words.push(*v as u32);
    }
    let h = unsafe { doomsim::abi::world_new_cfg(words.as_ptr(), words.len() as u32 * 4) };
    assert!(h > 0);
    let m = doomsim::abi::world_view_match(h);
    let mv = unsafe { std::slice::from_raw_parts(m as *const i32, 13 + 5 + BR_WORDS) };
    assert_eq!((mv[0], mv[1], mv[18 + 11]), (4, PH_LOBBY as i32, 105));
    // the same rules applied directly
    let mut cfg = Config::mode(MODE_BR, 4);
    cfg.apply_rules(&rules);
    let mut loot_rules = vec![];
    for i in 0..LOOT.len() as u32 {
        loot_rules.push((64 + i, if i == 19 { 10 } else { 0 }));
    }
    cfg.apply_rules(&loot_rules);
    let cfg = cfg.with_defaults();
    assert_eq!(cfg.br.stages, vec![[35, 35, 500, 3], [35, 35, 0, 9]]);
    // no stages: the default storm; a growing circle is clamped to the one before
    let mut c2 = Config::mode(MODE_BR, 4);
    c2.apply_rules(&[(7, 0)]);
    assert_eq!(c2.with_defaults().br.stages, DEFAULT_STAGES.to_vec());
    let mut c3 = Config::mode(MODE_BR, 4);
    c3.apply_rules(&[(7, 2), (10, 300), (14, 800)]);
    assert_eq!(c3.with_defaults().br.stages[1][2], 300);
    // a heavy loot table (total > 65535) still reaches its last rows
    let mut c4 = Config::mode(MODE_BR, 4);
    c4.apply_rules(&(0..LOOT.len() as u32).map(|i| (64 + i, if i < 19 { 10000 } else { 0 })).chain([(64 + 20, 10000)]).collect::<Vec<_>>());
    let mut w4 = World::new_cfg(c4, load_reg(&public_map("WAR01").unwrap()), 9);
    let mut packs = 0;
    for _ in 0..40 {
        let c = w4.spawn_mobj(w4.g.zone.x, w4.g.zone.y, ONFLOORZ, mt::CRATE);
        w4.open_crate(c, -1);
        packs += w4.mobjs.iter().flatten().filter(|m| m.type_ as usize == mt::GRENADEPACK && m.flags & MF_DROPPED != 0).count();
        for i in 0..w4.mobjs.len() {
            if w4.mobjs[i].as_ref().is_some_and(|m| m.flags & MF_DROPPED != 0) {
                w4.remove_mobj(i as u32);
            }
        }
        w4.compact();
    }
    assert!(packs > 0, "the last row drops");
    // a rules count that would overflow is rejected
    let bad: Vec<u32> = vec![2, MODE_BR, 4, 0, 0, 0, 0, 0, 0, 0, 1, id as u32, 77, 0, 0x8000_0001, 1, 2];
    assert_eq!(unsafe { doomsim::abi::world_new_cfg(bad.as_ptr(), bad.len() as u32 * 4) }, 0);
    let bad2: Vec<u32> = vec![2, MODE_BR, 4, 0, 0, 0, 0, 0, 0, 0, u32::MAX, id as u32];
    assert_eq!(unsafe { doomsim::abi::world_new_cfg(bad2.as_ptr(), bad2.len() as u32 * 4) }, 0);
    assert!(!cfg.br.vehicles);
    let pw2 = mod_br01().unwrap_or(pw);
    let reg = load_reg(&pw2);
    let mut w = World::new_cfg(cfg, reg.clone(), 3);
    assert_eq!(count_type(&w, mt::BUGGY), 0, "vehicles off");
    let mut stages = Vec::new();
    for _ in 0..35 * 90 {
        w.tick();
        for e in &w.events {
            if e.kind == EV_ZONE {
                stages.push((e.a, e.b));
            }
            if e.kind == 5 && e.b == 2 {
                assert_eq!(w.players[e.a as usize].ammo[0], 50);
            }
        }
        if w.g.zone.state == 2 {
            break;
        }
    }
    println!("rules: zone {:?}", stages);
    assert_eq!(stages, vec![(1, 0), (1, 1), (2, 0), (2, 1), (3, 2)]);
    // snipers only
    let c = w.spawn_mobj(w.g.zone.x, w.g.zone.y, ONFLOORZ, mt::CRATE);
    w.damage_mobj(c, NONE, NONE, 1, 0);
    assert!(w.mobjs.iter().flatten().filter(|m| m.flags & MF_DROPPED != 0).all(|m| m.type_ as usize == mt::SNIPERRIFLE));
    let bytes = w.serialize();
    let d = World::deserialize(&reg, &bytes).expect("rules survive a snapshot");
    assert_eq!(d.g.cfg, w.g.cfg);
}

/// through the ABI: a skydiver's MobjView (type 139, slot in word 7) follows PlayerView[52..54]
#[test]
fn parachuter_view_tracks_player() {
    let pw = public_map("WAR01").unwrap();
    let id = unsafe { doomsim::abi::map_load(pw.as_ptr(), pw.len() as u32) };
    let words: Vec<u32> = vec![2, MODE_BR, 2, 0, 0, 0, 0, 0, 0, 0, 1, id as u32, 5, 0, 2, 2, 35, 3, 2048];
    let h = unsafe { doomsim::abi::world_new_cfg(words.as_ptr(), words.len() as u32 * 4) };
    assert!(h > 0);
    let mut seen = Vec::new();
    for t in 0..35 * 60 {
        doomsim::abi::world_set_cmd(h, 0, 0, 0, 0, 0, if t % 2 == 0 { 4 } else { 0 });
        doomsim::abi::world_tick(h);
        let pv = unsafe { std::slice::from_raw_parts(doomsim::abi::world_view_player(h, 0) as *const i32, 57) }.to_vec();
        if pv[51] != 2 && pv[51] != 3 {
            continue;
        }
        let mp = doomsim::abi::world_view_mobjs(h);
        let n = unsafe { *(mp as *const u32) } as usize;
        let mv = unsafe { std::slice::from_raw_parts((mp as *const i32).add(1), n * 12) };
        let me = (0..n).map(|i| &mv[i * 12..i * 12 + 12]).find(|m| m[7] == (mt::PARACHUTER as i32 | 1 << 16)).expect("a parachuter for slot 0");
        assert_eq!((me[1], me[2], me[3]), (pv[52], pv[53], pv[54]));
        seen.push(pv[54] >> 16);
    }
    println!("parachuter z: {:?}", seen.iter().step_by(20).collect::<Vec<_>>());
    assert!(seen.len() > 50 && seen.first().unwrap() - seen.last().unwrap() > 1000, "it comes down");
}
