// Deathmatch spawn spots: the map's DM starts and player starts, plus generated open-floor
// spots so 100 players can spawn without telefragging each other.
// Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.

use crate::bots::nav::static_clear;
use crate::fixed::*;
use crate::map::*;

pub const MAX_SPOTS: usize = 512;
const MIN_SPACING: i32 = 96;
const GRID: i32 = 128;

pub fn build_spawn_spots(map: &Map) -> Vec<MapThing> {
    let mut spots: Vec<MapThing> = Vec::new();
    // battle royale: nothing on (or near) the lobby island, things 9030
    let lobby: Option<(i32, i32, i32, i32)> = map.things.iter().filter(|t| t.type_ == LOBBY_THING).fold(None, |b, t| {
        let (x, y) = (t.x as i32, t.y as i32);
        Some(match b {
            None => (x - 512, y - 512, x + 512, y + 512),
            Some((x0, y0, x1, y1)) => (x0.min(x - 512), y0.min(y - 512), x1.max(x + 512), y1.max(y + 512)),
        })
    });
    let in_lobby = |x: i32, y: i32| lobby.is_some_and(|(x0, y0, x1, y1)| x >= x0 && x <= x1 && y >= y0 && y <= y1);
    for t in &map.things {
        if t.type_ == 11 && !in_lobby(t.x as i32, t.y as i32) {
            spots.push(*t);
        }
    }
    for t in &map.things {
        if ((1..=4).contains(&t.type_) || t.type_ == 9000 || t.type_ == 9001) && !in_lobby(t.x as i32, t.y as i32) {
            spots.push(*t);
        }
    }
    let nav = &map.nav;
    // candidate subsectors, largest first (deterministic: area desc, index asc)
    let mut cands: Vec<usize> = (0..map.subsectors.len()).filter(|&i| nav.reach.get(i).copied().unwrap_or(false)).collect();
    cands.sort_by(|&a, &b| nav.nodes[b].area.cmp(&nav.nodes[a].area).then(a.cmp(&b)));
    let mut k = 0u32;
    for ss in cands {
        if spots.len() >= MAX_SPOTS {
            break;
        }
        let n = &nav.nodes[ss];
        if n.area < 48 * 48 || n.hurts {
            continue;
        }
        let sec = n.sector as usize;
        let s = &map.sectors[sec];
        if s.tag != 0 || nav.door_sector[sec] || nav.lift_sector[sec] {
            continue;
        }
        if s.ceilingheight - s.floorheight < 72 * FRACUNIT {
            continue;
        }
        let poly = &nav.polys[ss];
        if poly.len() < 3 {
            continue;
        }
        // grid points inside the polygon, centroid first
        let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        for &(x, y) in poly {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
        let mut pts: Vec<(i32, i32)> = vec![(n.cx >> FRACBITS, n.cy >> FRACBITS)];
        let mut gy = y0 - y0.rem_euclid(GRID) + GRID / 2;
        while gy < y1 {
            let mut gx = x0 - x0.rem_euclid(GRID) + GRID / 2;
            while gx < x1 {
                pts.push((gx, gy));
                gx += GRID;
            }
            gy += GRID;
        }
        for (x, y) in pts {
            if spots.len() >= MAX_SPOTS {
                break;
            }
            if x.abs() > 32000 || y.abs() > 32000 || in_lobby(x, y) {
                continue;
            }
            let fx = x << FRACBITS;
            let fy = y << FRACBITS;
            if map.point_in_subsector(fx, fy) != ss {
                continue;
            }
            if !static_clear(map, fx, fy, 36 * FRACUNIT, true) {
                continue;
            }
            if spots.iter().any(|t| (t.x as i32 - x).abs() < MIN_SPACING && (t.y as i32 - y).abs() < MIN_SPACING) {
                continue;
            }
            // keep clear of map things (items, decorations, teleport destinations)
            if map.things.iter().any(|t| (t.x as i32 - x).abs() < 48 && (t.y as i32 - y).abs() < 48) {
                continue;
            }
            spots.push(MapThing { x: x as i16, y: y as i16, angle: ((k % 8) * 45) as i16, type_: -1, options: 7 });
            k += 1;
        }
    }
    spots
}
