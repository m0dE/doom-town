use doomsim::map::*;
use doomsim::fixed::*;

#[test]
#[ignore]
fn nav_debug() {
    let w = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../assets/freedm.wad")).unwrap();
    let name = std::env::var("MAPNAME").unwrap_or("MAP11".into());
    let m = Map::load(&extract_map_pwad(&w, &name).unwrap()).unwrap();
    let nav = &m.nav;
    let mut big = 0;
    for (i, n) in nav.nodes.iter().enumerate() {
        if nav.reach[i] || n.area < 4096 { continue; }
        big += 1;
        let s = &m.sectors[n.sector as usize];
        let outs: Vec<String> = nav.edges_of(i).iter().map(|e| format!("{}k{}", e.to, e.kind)).collect();
        if big < 40 {
        println!("ss {} sec {} area {} c=({},{}) floor {} ceil {} spec {} tag {} out {:?}", i, n.sector, n.area, n.cx>>16, n.cy>>16, s.floorheight>>16, s.ceilingheight>>16, s.special, s.tag, outs);
        }
    }
    println!("big unreached {}", big);
}
