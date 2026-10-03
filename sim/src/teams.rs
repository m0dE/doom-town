// Team sides and capture points for the team modes.
// Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.
//
// Maps with explicit team starts (things 9000 red / 9001 blue) use them as the bases
// (plus generated spots within 1024 units of them). Other maps (FreeDM) are split in two:
// the two most distant DM starts seed a 2-means clustering over all spawn spots; the
// seed listed first is red. Capture points are things 9010 (angle = radius / 8), or five
// generated ones: the spot nearest the middle of the two bases, then farthest-point
// sampling away from the bases and each other.

use crate::fixed::*;
use crate::map::*;

const DEFAULT_RADIUS: i32 = 192;

fn d2(a: (i64, i64), b: (i64, i64)) -> i64 {
    (a.0 - b.0) * (a.0 - b.0) + (a.1 - b.1) * (a.1 - b.1)
}

pub fn build_teams(map: &mut Map) {
    let spots: Vec<(i64, i64, i16)> = map.spawn_spots.iter().map(|s| (s.x as i64, s.y as i64, s.type_)).collect();
    let n = spots.len();
    let mut team = vec![255u8; n];
    let reds: Vec<usize> = (0..n).filter(|&i| spots[i].2 == 9000).collect();
    let blues: Vec<usize> = (0..n).filter(|&i| spots[i].2 == 9001).collect();
    let centroid = |idx: &[usize]| -> (i64, i64) {
        let k = idx.len().max(1) as i64;
        (idx.iter().map(|&i| spots[i].0).sum::<i64>() / k, idx.iter().map(|&i| spots[i].1).sum::<i64>() / k)
    };
    let mut cent = [(0i64, 0i64); 2];
    if !reds.is_empty() && !blues.is_empty() {
        map.explicit_teams = true;
        for &i in &reds {
            team[i] = 0;
        }
        for &i in &blues {
            team[i] = 1;
        }
        // generated spots close to a team start join that base
        for i in 0..n {
            if team[i] != 255 || spots[i].2 == 11 {
                continue;
            }
            let p = (spots[i].0, spots[i].1);
            let dr = reds.iter().map(|&r| d2(p, (spots[r].0, spots[r].1))).min().unwrap();
            let db = blues.iter().map(|&b| d2(p, (spots[b].0, spots[b].1))).min().unwrap();
            if dr.min(db) <= 1024 * 1024 {
                team[i] = if dr <= db { 0 } else { 1 };
            }
        }
        cent = [centroid(&reds), centroid(&blues)];
    } else if n >= 2 {
        // seeds: the two most distant DM starts (or spots)
        let mut cand: Vec<usize> = (0..n).filter(|&i| spots[i].2 == 11).collect();
        if cand.len() < 2 {
            cand = (0..n).collect();
        }
        let (mut sa, mut sb, mut best) = (cand[0], cand[1], -1i64);
        for (ai, &a) in cand.iter().enumerate() {
            for &b in &cand[ai + 1..] {
                let d = d2((spots[a].0, spots[a].1), (spots[b].0, spots[b].1));
                if d > best {
                    best = d;
                    sa = a;
                    sb = b;
                }
            }
        }
        cent = [(spots[sa].0, spots[sa].1), (spots[sb].0, spots[sb].1)];
        for _ in 0..10 {
            let mut groups: [Vec<usize>; 2] = [Vec::new(), Vec::new()];
            for i in 0..n {
                let p = (spots[i].0, spots[i].1);
                let t = if d2(p, cent[0]) <= d2(p, cent[1]) { 0 } else { 1 };
                team[i] = t as u8;
                groups[t].push(i);
            }
            if groups[0].is_empty() || groups[1].is_empty() {
                break;
            }
            cent = [centroid(&groups[0]), centroid(&groups[1])];
        }
    }
    map.spot_team = team;

    // capture points
    let mut pts: Vec<(Fixed, Fixed, Fixed)> = map
        .things
        .iter()
        .filter(|t| t.type_ == 9010)
        .map(|t| {
            let r = if t.angle > 0 { t.angle as i32 * 8 } else { DEFAULT_RADIUS };
            ((t.x as i32) << FRACBITS, (t.y as i32) << FRACBITS, r.clamp(32, 4096) << FRACBITS)
        })
        .collect();
    if pts.is_empty() && n > 0 {
        let mid = ((cent[0].0 + cent[1].0) / 2, (cent[0].1 + cent[1].1) / 2);
        let mut chosen: Vec<usize> = Vec::new();
        let first = (0..n).min_by_key(|&i| (d2((spots[i].0, spots[i].1), mid), i)).unwrap();
        chosen.push(first);
        while chosen.len() < 5.min(n) {
            let mut best = (-1i64, usize::MAX);
            for i in 0..n {
                if chosen.contains(&i) {
                    continue;
                }
                let p = (spots[i].0, spots[i].1);
                let mut m = i64::MAX;
                for &c in &chosen {
                    m = m.min(d2(p, (spots[c].0, spots[c].1)));
                }
                // keep points away from the bases too
                m = m.min(d2(p, cent[0]) / 2).min(d2(p, cent[1]) / 2);
                if m > best.0 {
                    best = (m, i);
                }
            }
            if best.1 == usize::MAX {
                break;
            }
            chosen.push(best.1);
        }
        pts = chosen.iter().map(|&i| ((spots[i].0 as i32) << FRACBITS, (spots[i].1 as i32) << FRACBITS, DEFAULT_RADIUS << FRACBITS)).collect();
    }
    // spawn spots for each point: nearest first, within 1024 units (at least 8)
    let mut psp = Vec::new();
    for &(px, py, _) in &pts {
        let c = ((px >> FRACBITS) as i64, (py >> FRACBITS) as i64);
        let mut idx: Vec<usize> = (0..n).collect();
        idx.sort_by_key(|&i| (d2((spots[i].0, spots[i].1), c), i));
        let near: Vec<u16> = idx.iter().enumerate().filter(|&(k, &i)| k < 8 || d2((spots[i].0, spots[i].1), c) <= 1024 * 1024).take(32).map(|(_, &i)| i as u16).collect();
        psp.push(near);
    }
    map.cap_points = pts;
    map.point_spots = psp;
}
