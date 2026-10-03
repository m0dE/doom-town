mod common;
use common::*;
use doomsim::world::*;

fn report(name: &str, slots: usize, secs: u32) {
    let map = load(name);
    let mut w = World::new(map, 12345, slots);
    let st = run_stats(&mut w, 35 * secs);
    let minutes = secs as f64 / 60.0;
    println!(
        "{} bots={} {}s: kills {} (suicides/world {}) frags/min {:.1} deaths {} items {} travelled/bot/s {:.0} stuck-events {} out-of-map {} avg tic {:.3} ms p99 {:.3} ms max {:.3} ms (tic {})",
        name, slots, secs, st.deaths - st.suicides, st.suicides, (st.deaths - st.suicides) as f64 / minutes, st.deaths, st.items,
        st.travelled as f64 / slots as f64 / secs as f64, st.stuck_events, st.out_of_map,
        st.total_us as f64 / st.tics as f64 / 1000.0, st.p99_us as f64 / 1000.0, st.max_tic_us as f64 / 1000.0, st.max_tic_at
    );
    println!("  kills by means {:?}", st.kills_by_mod);
    let mut fr: Vec<(i32, i32)> = w.players.iter().map(|p| (p.frags, p.slot)).collect();
    fr.sort();
    println!("  top {:?} bottom {:?}", &fr[fr.len() - 5..], &fr[..5]);
    assert_eq!(st.out_of_map, 0);
}

#[test]
fn gameplay_map19() {
    report("MAP19", 64, 120);
}

#[test]
fn gameplay_map01() {
    report("MAP01", 64, 120);
}

#[test]
fn all_maps_64_bots_60s() {
    let mut worst = (0i64, String::new());
    for i in 1..=32 {
        let name = format!("MAP{:02}", i);
        let map = load(&name);
        let mut w = World::new(map, i as u32, 64);
        let st = run_stats(&mut w, 35 * 60);
        println!(
            "{}: kills/min {} items {} travelled/bot/s {} stuck-events {} out-of-map {} avg tic {:.3} ms",
            name, st.deaths - st.suicides, st.items, st.travelled / 64 / 60, st.stuck_events, st.out_of_map, st.total_us as f64 / st.tics as f64 / 1000.0
        );
        assert_eq!(st.out_of_map, 0, "{}", name);
        if st.stuck_events > worst.0 {
            worst = (st.stuck_events, name.clone());
        }
    }
    println!("worst stuck: {:?}", worst);
}

#[test]
fn weapons_stay_map19() {
    use doomsim::info::*;
    let map = load("MAP19");
    let weapon_types = [mt::SHOTGUN, mt::SUPERSHOTGUN, mt::CHAINGUN, mt::MISC25, mt::MISC26, mt::MISC27, mt::MISC28];
    let count = |w: &World| w.mobjs.iter().flatten().filter(|m| weapon_types.contains(&(m.type_ as usize))).count();
    let mut w = World::new(map, 2024, 64);
    let before = count(&w);
    let st = run_stats(&mut w, 35 * 120);
    let after = count(&w);
    let mut dist = [0usize; NUMWEAPONS];
    let mut owned = [0usize; NUMWEAPONS];
    for p in &w.players {
        dist[p.readyweapon as usize] += 1;
        for i in 0..NUMWEAPONS {
            if p.weaponowned[i] {
                owned[i] += 1;
            }
        }
    }
    let names = ["fist", "pistol", "shotgun", "chaingun", "rocket", "plasma", "bfg", "chainsaw", "ssg"];
    println!("MAP19 weapon things: {} at start, {} after 2 min ({} pickups total)", before, after, st.items);
    println!("  readyweapon distribution: {:?}", names.iter().zip(dist.iter()).collect::<Vec<_>>());
    println!("  owned:                    {:?}", names.iter().zip(owned.iter()).collect::<Vec<_>>());
    println!("  kills by means {:?}", st.kills_by_mod);
    assert_eq!(before, 28);
    assert_eq!(after, 28);
    let non_pistol: usize = dist.iter().enumerate().filter(|&(i, _)| i != WP_PISTOL as usize && i != WP_FIST as usize).map(|(_, &n)| n).sum();
    assert!(non_pistol >= 64 / 4, "bots should hold a spread of weapons: {:?}", dist);
}
