mod common;
use common::*;
use doomsim::game::*;
use doomsim::world::*;
#[test]
#[ignore]
fn bossdiag() {
    let cfg = Config { flags: 1, ..Config::mode(MODE_FFA, 64) };
    let mut w = World::new_cfg(cfg, vec![load("MAP19")], 4242);
    for s in 0..20 {
        for _ in 0..35 * 15 { w.tick(); }
        let bv = w.boss_view();
        let targeting = w.players.iter().filter(|p| w.deref(p.bot.enemy) == w.deref(w.g.boss) && w.deref(w.g.boss).is_some()).count();
        let pos = w.deref(w.g.boss).map(|b| { let m = w.mo(b); (m.x >> 16, m.y >> 16, m.state, m.movedir, w.deref(m.target).is_some()) });
        println!("t={}s boss {:?} pos {:?} bots targeting {}", (s + 1) * 15, bv, pos, targeting);
    }
}
#[test]
#[ignore]
fn boss_types() {
    for seed in 1..7 {
        let cfg = Config { flags: 1, match_tics: 35 * 75, inter_tics: 35, ..Config::mode(MODE_FFA, 64) };
        let mut w = World::new_cfg(cfg, vec![load("MAP19")], seed);
        let mut types = vec![];
        for _ in 0..35 * 77 * 3 { w.tick(); for e in &w.events { if e.kind == 14 { types.push(e.a); } } }
        println!("seed {} boss types {:?} (spider {}, cyber {})", seed, types, doomsim::info::mt::SPIDER, doomsim::info::mt::CYBORG);
    }
}
