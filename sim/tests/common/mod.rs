#![allow(dead_code)]
use doomsim::map::*;
use doomsim::world::*;
use std::rc::Rc;

pub fn wad() -> Vec<u8> {
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../assets/freedm.wad")).expect("freedm.wad")
}

pub fn load(name: &str) -> Rc<Map> {
    let w = wad();
    Rc::new(Map::load(&extract_map_pwad(&w, name).unwrap()).unwrap())
}

#[derive(Default, Debug)]
pub struct Stats {
    pub frags: i64,
    pub deaths: i64,
    pub items: i64,
    pub travelled: i64,
    pub stuck_events: i64,
    pub out_of_map: i64,
    pub max_tic_us: u128,
    pub max_tic_at: u32,
    pub p99_us: u128,
    pub total_us: u128,
    pub tics: u64,
    pub suicides: i64,
    pub kills_by_mod: [i64; 16],
}

/// run `tics` tics, collecting gameplay sanity counters
pub fn run_stats(w: &mut World, tics: u32) -> Stats {
    let mut st = Stats::default();
    let n = w.players.len();
    // stuck tracking: (x, y, tic of sample, alive-since)
    let mut samp: Vec<(i32, i32, u32, bool)> = vec![(0, 0, 0, false); n];
    let mut all: Vec<u128> = Vec::new();
    for _ in 0..tics {
        let t0 = std::time::Instant::now();
        w.tick();
        let us = t0.elapsed().as_micros();
        st.total_us += us;
        if us > st.max_tic_us {
            st.max_tic_us = us;
            st.max_tic_at = w.tic;
        }
        all.push(us);
        st.tics += 1;
        for e in &w.events {
            if e.kind == 2 {
                if e.b < 0 || e.b == e.a {
                    st.suicides += 1;
                }
                st.kills_by_mod[(e.c as usize).min(15)] += 1;
            }
        }
        for i in 0..n {
            let p = &w.players[i];
            match w.deref(p.mo) {
                Some(h) if p.playerstate == PST_LIVE => {
                    let m = w.mo(h);
                    if !samp[i].3 {
                        samp[i] = (m.x, m.y, w.tic, true);
                    } else if w.tic - samp[i].2 >= 350 {
                        let d = doomsim::fixed::aprox_distance(m.x - samp[i].0, m.y - samp[i].1) >> 16;
                        if d < 64 {
                            st.stuck_events += 1;
                        }
                        samp[i] = (m.x, m.y, w.tic, true);
                    }
                }
                _ => samp[i].3 = false,
            }
        }
    }
    all.sort();
    st.p99_us = all[all.len() * 99 / 100];
    // everything inside the map?
    let map = w.map.clone();
    for o in w.mobjs.iter().flatten() {
        let ss = map.point_in_subsector(o.x, o.y);
        let sec = &w.sectors[map.subsectors[ss].sector as usize];
        if o.z < sec.floorheight - 64 * 65536 || o.z > sec.ceilingheight + 64 * 65536 {
            st.out_of_map += 1;
        }
    }
    for p in &w.players {
        st.frags += p.frags as i64;
        st.deaths += p.deaths as i64;
        st.items += p.items as i64;
        st.travelled += p.travelled;
    }
    st
}

/// Rebuild a one-map PWAD, dropping lumps in `drop` and scaling all horizontal map
/// coordinates by `k` (vertices, things, segs offsets, nodes): an affine scale keeps the
/// BSP valid, so this makes big maps for stress tests.
pub fn transform_pwad(pwad: &[u8], k: i32, drop: &[&str]) -> Vec<u8> {
    let lumps = wad_lumps(pwad).unwrap();
    let mut sel: Vec<(String, Vec<u8>)> = Vec::new();
    for l in &lumps {
        if drop.contains(&l.name.as_str()) {
            continue;
        }
        let mut d = l.data.to_vec();
        let sc = |d: &mut Vec<u8>, o: usize| {
            let v = i16::from_le_bytes([d[o], d[o + 1]]) as i32 * k;
            let v = v.clamp(-32767, 32767) as i16;
            d[o..o + 2].copy_from_slice(&v.to_le_bytes());
        };
        match l.name.as_str() {
            "VERTEXES" => (0..d.len() / 4).for_each(|i| { sc(&mut d, i * 4); sc(&mut d, i * 4 + 2); }),
            "THINGS" => (0..d.len() / 10).for_each(|i| { sc(&mut d, i * 10); sc(&mut d, i * 10 + 2); }),
            "SEGS" => (0..d.len() / 12).for_each(|i| sc(&mut d, i * 12 + 10)),
            "NODES" => (0..d.len() / 28).for_each(|i| { for j in 0..12 { sc(&mut d, i * 28 + j * 2); } }),
            _ => {}
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
        for (i, c) in n.bytes().take(8).enumerate() { nm[i] = c; }
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
