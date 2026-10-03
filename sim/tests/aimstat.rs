mod common;
use common::*;
use doomsim::info::*;
use doomsim::world::*;
#[test]
#[ignore]
fn aimstat() {
    let map = load("MAP19");
    let mut w = World::new(map, 3, 64);
    let (mut pistol_shots, mut hits_when_pistol, mut dmg_events) = (0, 0, 0);
    for _ in 0..35 * 60 {
        w.tick();
        let mut shooters = std::collections::HashSet::new();
        for e in &w.events {
            if e.kind == 1 && e.a == sfx::pistol && e.d > 0 && w.players[(e.d - 1) as usize].readyweapon == WP_PISTOL {
                pistol_shots += 1;
                shooters.insert(e.d - 1);
            }
        }
        for e in &w.events {
            if e.kind == 4 && e.b >= 0 {
                dmg_events += 1;
                if shooters.contains(&e.b) {
                    hits_when_pistol += 1;
                }
            }
        }
    }
    println!("pistol shots {} hits {} ({:.0}%), damage events {}", pistol_shots, hits_when_pistol, hits_when_pistol as f64 * 100.0 / pistol_shots as f64, dmg_events);
}
