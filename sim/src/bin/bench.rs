// Native benchmark: cost of world_tick with 64 bots, plus hash/serialize/clone.
//   cargo run --release --bin bench [MAPxx] [seconds]
use doomsim::map::{extract_map_pwad, Map};
use doomsim::world::World;
use std::rc::Rc;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let name = args.get(1).cloned().unwrap_or_else(|| "MAP19".into());
    let secs: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(60);
    if name == "br01" || name.ends_with(".wad") {
        return bench_br(&name, secs, args.get(3).and_then(|s| s.parse().ok()).unwrap_or(1));
    }
    let wad = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../assets/freedm.wad")).expect("assets/freedm.wad");
    let t = Instant::now();
    let map = Rc::new(Map::load(&extract_map_pwad(&wad, &name).expect("map")).expect("load"));
    println!("{}: map_load {:.1} ms ({} spawn spots, {} nav edges)", name, t.elapsed().as_secs_f64() * 1e3, map.spawn_spots.len(), map.nav.edges.len());
    let mut w = World::new(map, 1, 64);
    let mut times: Vec<f64> = Vec::new();
    for _ in 0..35 * secs {
        let t = Instant::now();
        w.tick();
        times.push(t.elapsed().as_secs_f64() * 1e3);
    }
    let total: f64 = times.iter().sum();
    let mut s = times.clone();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "world_tick, 64 bots, {} tics: avg {:.3} ms, p50 {:.3} ms, p99 {:.3} ms, max {:.3} ms",
        times.len(),
        total / times.len() as f64,
        s[s.len() / 2],
        s[s.len() * 99 / 100],
        s[s.len() - 1]
    );
    #[cfg(feature = "prof")]
    {
        let p = doomsim::world::prof::get();
        for (i, n) in ["bots", "reborn", "players", "thinkers"].iter().enumerate() {
            println!("  {:8} total {:.1} ms ({:.3} ms/tic) max {:.3} ms", n, p[i].0, p[i].0 / times.len() as f64, p[i].1);
        }
    }
    let mut buf = Vec::new();
    let t = Instant::now();
    for _ in 0..100 {
        w.serialize_into(&mut buf);
    }
    println!("serialize: {:.3} ms ({} bytes)", t.elapsed().as_secs_f64() * 10.0, buf.len());
    let t = Instant::now();
    let mut hsum = 0u32;
    for _ in 0..100 {
        hsum ^= w.hash_with(&mut buf);
    }
    println!("hash: {:.3} ms ({:08x})", t.elapsed().as_secs_f64() * 10.0, hsum);
    let t = Instant::now();
    for _ in 0..100 {
        let c = w.clone();
        std::hint::black_box(&c);
    }
    println!("clone: {:.3} ms", t.elapsed().as_secs_f64() * 10.0);
    let frags: i32 = w.players.iter().map(|p| p.deaths).sum();
    println!("deaths in run: {} ({:.0}/min)", frags, frags as f64 / secs as f64 * 60.0);
}

/// battle royale: a whole match with 64 bots on a mod / map PWAD
///   cargo run --release --bin bench br01 [max seconds] [seed]
fn bench_br(name: &str, secs: u32, seed: u32) {
    use doomsim::game::*;
    let path = if name == "br01" { concat!(env!("CARGO_MANIFEST_DIR"), "/../public/mods/br01.wad").to_string() } else { name.to_string() };
    let bytes = std::fs::read(&path).expect("wad");
    let mut m = Map::load(&bytes).expect("map");
    m.id = 0;
    let mut w = World::new_cfg(Config::mode(MODE_BR, 64), vec![Rc::new(m)], seed);
    let mut times: Vec<(f64, u32, u8)> = Vec::new();
    let mut alive_ship_end = 0;
    let mut alive_landed_30s = 0;
    let mut play_start = 0;
    let mut dbg_mods = [0u32; 20];
    for t in 0..35 * secs {
        let ph = w.g.phase;
        // the machine is shared: a slow tic is re-timed on copies (min of 3) so spikes are
        // the sim's, not the scheduler's
        let before = w.clone();
        let t0 = Instant::now();
        w.tick();
        let mut ms = t0.elapsed().as_secs_f64() * 1e3;
        if ms > 1.0 {
            for _ in 0..2 {
                let mut c = before.clone();
                let t1 = Instant::now();
                c.tick();
                ms = ms.min(t1.elapsed().as_secs_f64() * 1e3);
            }
        }
        times.push((ms, t, ph));
        if std::env::var("BRDBG").is_ok() && (w.g.phase == PH_DROP || w.g.phase == PH_PLAY) && t % 175 == 0 {
            let pos: Vec<(i64, i64)> = (0..64).filter_map(|s| w.deref(w.players[s].mo).map(|h| ((w.mo(h).x >> 16) as i64, (w.mo(h).y >> 16) as i64))).collect();
            let mut nn: Vec<i64> = pos.iter().enumerate().map(|(i, a)| pos.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, b)| (a.0 - b.0).pow(2) + (a.1 - b.1).pow(2)).min().unwrap_or(0)).map(|d| (d as f64).sqrt() as i64).collect();
            nn.sort();
            let air = w.players.iter().filter(|p| p.air != 0).count();
            println!("  t {} phase {} alive {} bodies {} airborne {} nn median {:?} deaths-by-mod {:?}", t, w.g.phase, w.br_alive().len(), pos.len(), air, nn.get(nn.len() / 2), dbg_mods);
        }
        for e in &w.events {
            if e.kind == 2 {
                dbg_mods[(e.c as usize).min(19)] += 1;
            }
        }
        if ph == PH_DROP && w.g.phase == PH_PLAY {
            alive_ship_end = w.br_alive().len();
            play_start = t;
        }
        if play_start > 0 && t == play_start + 35 * 30 {
            alive_landed_30s = w.br_alive().len();
        }
        if w.events.iter().any(|e| e.kind == 8) {
            break;
        }
    }
    let mut s: Vec<f64> = times.iter().map(|x| x.0).collect();
    let total: f64 = s.iter().sum();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut worst = times.clone();
    worst.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    println!(
        "BR {} seed {}: {} tics, avg {:.3} ms p50 {:.3} p99 {:.3} max {:.3}; alive at ship end {}, 30 s later {}, at the end {}",
        name, seed, s.len(), total / s.len() as f64, s[s.len() / 2], s[s.len() * 99 / 100], s[s.len() - 1], alive_ship_end, alive_landed_30s, w.br_alive().len()
    );
    println!("  worst tics (ms, tic, phase): {:?}", worst.iter().take(8).map(|x| (format!("{:.2}", x.0), x.1, x.2)).collect::<Vec<_>>());
    #[cfg(feature = "prof")]
    {
        let p = doomsim::world::prof::get();
        for (i, n) in ["bots", "reborn", "players", "thinkers", "plan", "goal", "mode"].iter().enumerate() {
            println!("  {:8} total {:.1} ms ({:.3} ms/tic) max {:.3} ms", n, p[i].0, p[i].0 / s.len() as f64, p[i].1);
        }
    }
}
