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
