use doomsim::map::*;
use doomsim::world::*;
use std::rc::Rc;

fn wad() -> Vec<u8> {
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../assets/freedm.wad")).expect("freedm.wad")
}

#[test]
fn load_all_maps() {
    let w = wad();
    for i in 1..=32 {
        let name = format!("MAP{:02}", i);
        let pw = extract_map_pwad(&w, &name).unwrap();
        let t = std::time::Instant::now();
        let m = Map::load(&pw).unwrap_or_else(|e| panic!("{} failed {}", name, e));
        let edges = m.nav.edges.len();
        let reach = m.nav.reach.iter().filter(|&&r| r).count();
        println!("{}: lines {} ss {} spots {} (dm {}) nav edges {} reach {}/{} in {:?}", name, m.lines.len(), m.subsectors.len(), m.spawn_spots.len(), m.num_dm_starts, edges, reach, m.subsectors.len(), t.elapsed());
        let mut world = World::new(Rc::new(m), 1, 16);
        for _ in 0..70 {
            world.tick();
        }
    }
}
