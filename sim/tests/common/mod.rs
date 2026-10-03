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
