mod common;
use common::*;
#[test]
#[ignore]
fn navq() {
    let map = load(&std::env::var("MAPNAME").unwrap_or("MAP19".into()));
    let lines: Vec<usize> = std::env::var("LINES").unwrap_or_default().split(',').filter_map(|s| s.parse().ok()).collect();
    for l in lines {
        let li = &map.lines[l];
        println!("line {} v1 ({},{}) v2 ({},{}) flags {} special {} tag {} front {} back {}", l, li.v1.x>>16, li.v1.y>>16, li.v2.x>>16, li.v2.y>>16, li.flags, li.special, li.tag, li.frontsector, li.backsector);
        for s in [li.frontsector, li.backsector] { if s >= 0 { let se = &map.sectors[s as usize]; println!("   sector {} floor {} ceil {} special {} tag {} door {} lift {} doortop {}", s, se.floorheight>>16, se.ceilingheight>>16, se.special, se.tag, map.nav.door_sector[s as usize], map.nav.lift_sector[s as usize], map.nav.door_top[s as usize]>>16); } }
    }
    let nodes: Vec<usize> = std::env::var("NODES").unwrap_or_default().split(',').filter_map(|s| s.parse().ok()).collect();
    for n in nodes {
        let nd = &map.nav.nodes[n];
        println!("node {} sector {} c=({},{}) area {} reach {} poly {:?}", n, nd.sector, nd.cx>>16, nd.cy>>16, nd.area, map.nav.reach[n], map.nav.polys[n]);
        for e in map.nav.edges_of(n) { println!("   -> {} kind {} line {} at ({},{}) cost {}", e.to, e.kind, e.line, e.px>>16, e.py>>16, e.cost); }
    }
}

#[test]
#[ignore]
fn empty_polys() {
    for i in 1..=32 {
        let name = format!("MAP{:02}", i);
        let map = load(&name);
        let mut bad = 0;
        let mut ex = Vec::new();
        for (si, ss) in map.subsectors.iter().enumerate() {
            // seg extent
            let mut len = 0i64;
            for k in 0..ss.numlines {
                let sg = &map.segs[(ss.firstline + k) as usize];
                len += (((sg.v2.x - sg.v1.x) >> 16) as i64).abs() + (((sg.v2.y - sg.v1.y) >> 16) as i64).abs();
            }
            if map.nav.nodes[si].area < 16 && len > 64 {
                bad += 1;
                if ex.len() < 3 { ex.push((si, map.nav.polys[si].len(), len, map.nav.nodes[si].area)); }
            }
        }
        println!("{}: {} subsectors with empty polygons {:?}", name, bad, ex);
    }
}

#[test]
#[ignore]
fn point() {
    let map = load(&std::env::var("MAPNAME").unwrap_or("MAP19".into()));
    let xy: Vec<i32> = std::env::var("XY").unwrap().split(',').map(|s| s.parse().unwrap()).collect();
    let ss = map.point_in_subsector(xy[0] << 16, xy[1] << 16);
    let n = &map.nav.nodes[ss];
    let sec = &map.sectors[n.sector as usize];
    println!("ss {} sector {} floor {} ceil {} area {} reach {} poly {:?}", ss, n.sector, sec.floorheight >> 16, sec.ceilingheight >> 16, n.area, map.nav.reach[ss], map.nav.polys[ss]);
    let s = &map.subsectors[ss];
    for k in 0..s.numlines { let sg = &map.segs[(s.firstline + k) as usize]; println!("  seg ({},{})->({},{}) line {} side {}", sg.v1.x>>16, sg.v1.y>>16, sg.v2.x>>16, sg.v2.y>>16, sg.linedef, sg.side); }
    for e in map.nav.edges_of(ss) { println!("   -> {} kind {} line {}", e.to, e.kind, e.line); }
}
