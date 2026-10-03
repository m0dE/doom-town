// Bot navigation graph, built once per map from the BSP.
// Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.
//
// Nodes are subsectors. Each subsector's convex polygon is rebuilt by clipping the map
// box with the partition lines on the way down the BSP and with the subsector's own segs.
// Neighbours are found by probing just outside every polygon edge. An edge is walkable
// when the step up is <= 24, headroom >= 56 (doors count as open), drops are one-way,
// lifts are passable from below when their low position is reachable. Teleport lines
// add edges to their destination. Everything is integer math (i64/i128).

use crate::fixed::*;
use crate::map::*;
use crate::maputl::box_on_line_side;

pub const EK_WALK: u8 = 0;
pub const EK_DROP: u8 = 1;
pub const EK_DOOR: u8 = 2;
pub const EK_LIFT: u8 = 3;
pub const EK_TELEPORT: u8 = 4;

#[derive(Clone, Debug, Default)]
pub struct NavNode {
    pub cx: Fixed,
    pub cy: Fixed,
    pub sector: u32,
    /// area in map units^2 (0 for degenerate leaves)
    pub area: i64,
    pub hurts: bool,
}

#[derive(Clone, Debug)]
pub struct NavEdge {
    pub to: u32,
    /// crossing point
    pub px: Fixed,
    pub py: Fixed,
    pub cost: i32,
    pub kind: u8,
    /// linedef crossed (-1 for BSP-only boundaries)
    pub line: i32,
}

#[derive(Clone, Debug, Default)]
pub struct Nav {
    pub nodes: Vec<NavNode>,
    pub edges: Vec<NavEdge>,
    /// CSR: edges of node i are first[i]..first[i+1]
    pub first: Vec<u32>,
    /// node is in the main connected area (both reachable from and able to reach a start)
    pub reach: Vec<bool>,
    pub door_sector: Vec<bool>,
    pub lift_sector: Vec<bool>,
    /// for door sectors: the open ceiling height (static estimate)
    pub door_top: Vec<Fixed>,
    pub lift_low: Vec<Fixed>,
    /// subsector polygons in map units (debugging / visualisation)
    pub polys: Vec<Vec<(i32, i32)>>,
}

type P = (i64, i64); // 16.16 fixed in i64

fn cross(px: i64, py: i64, lx: i64, ly: i64, ldx: i64, ldy: i64) -> i128 {
    (px - lx) as i128 * ldy as i128 - (py - ly) as i128 * ldx as i128
}

/// keep the part of the polygon where side*cross >= 0
fn clip(poly: &[P], lx: i64, ly: i64, ldx: i64, ldy: i64, keep_front: bool) -> Vec<P> {
    let n = poly.len();
    if n == 0 {
        return Vec::new();
    }
    let s = |c: i128| if keep_front { c } else { -c };
    let mut out = Vec::with_capacity(n + 2);
    for i in 0..n {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        let ca = s(cross(a.0, a.1, lx, ly, ldx, ldy));
        let cb = s(cross(b.0, b.1, lx, ly, ldx, ldy));
        if ca >= 0 {
            out.push(a);
        }
        if (ca > 0 && cb < 0) || (ca < 0 && cb > 0) {
            let t_num = ca;
            let t_den = ca - cb;
            let ix = a.0 + ((b.0 - a.0) as i128 * t_num / t_den) as i64;
            let iy = a.1 + ((b.1 - a.1) as i128 * t_num / t_den) as i64;
            out.push((ix, iy));
        }
    }
    // remove consecutive duplicates
    let mut res: Vec<P> = Vec::with_capacity(out.len());
    for p in out {
        if res.last() != Some(&p) {
            res.push(p);
        }
    }
    while res.len() > 1 && res.first() == res.last() {
        res.pop();
    }
    res
}

fn area2(poly: &[P]) -> i128 {
    let n = poly.len();
    let mut a: i128 = 0;
    for i in 0..n {
        let p = poly[i];
        let q = poly[(i + 1) % n];
        a += p.0 as i128 * q.1 as i128 - q.0 as i128 * p.1 as i128;
    }
    a
}

fn centroid(poly: &[P]) -> P {
    let n = poly.len() as i64;
    if n == 0 {
        return (0, 0);
    }
    let mut sx: i128 = 0;
    let mut sy: i128 = 0;
    for p in poly {
        sx += p.0 as i128;
        sy += p.1 as i128;
    }
    ((sx / n as i128) as i64, (sy / n as i128) as i64)
}

fn inside(poly: &[P], x: i64, y: i64, tol: i64) -> bool {
    // works for either winding: all crosses must share a sign (with tolerance)
    let n = poly.len();
    if n < 3 {
        return false;
    }
    let mut pos = false;
    let mut neg = false;
    for i in 0..n {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        let dx = b.0 - a.0;
        let dy = b.1 - a.1;
        let len = isqrt(((dx >> 8) * (dx >> 8) + (dy >> 8) * (dy >> 8)).max(1)) << 8;
        let c = cross(x, y, a.0, a.1, dx, dy);
        // distance = c / len
        let lim = tol as i128 * len.max(1) as i128;
        if c > lim {
            pos = true;
        } else if c < -lim {
            neg = true;
        }
        if pos && neg {
            return false;
        }
    }
    true
}

/// static test: can a body of `radius` stand at x,y without crossing a one-sided or
/// blocking line (two-sided lines are checked only when `strict`)
pub fn static_clear(map: &Map, x: Fixed, y: Fixed, radius: Fixed, strict: bool) -> bool {
    let bbox = [y + radius, y - radius, x - radius, x + radius];
    let xl = (bbox[BOXLEFT] - map.bmaporgx) >> MAPBLOCKSHIFT;
    let xh = (bbox[BOXRIGHT] - map.bmaporgx) >> MAPBLOCKSHIFT;
    let yl = (bbox[BOXBOTTOM] - map.bmaporgy) >> MAPBLOCKSHIFT;
    let yh = (bbox[BOXTOP] - map.bmaporgy) >> MAPBLOCKSHIFT;
    for bx in xl..=xh {
        for by in yl..=yh {
            if bx < 0 || by < 0 || bx >= map.bmapwidth || by >= map.bmapheight {
                return false;
            }
            for &l in &map.blocklines[(by * map.bmapwidth + bx) as usize] {
                let ld = &map.lines[l as usize];
                if bbox[BOXRIGHT] <= ld.bbox[BOXLEFT] || bbox[BOXLEFT] >= ld.bbox[BOXRIGHT] || bbox[BOXTOP] <= ld.bbox[BOXBOTTOM] || bbox[BOXBOTTOM] >= ld.bbox[BOXTOP] {
                    continue;
                }
                if box_on_line_side(&bbox, ld) != -1 {
                    continue;
                }
                if ld.backsector < 0 || ld.flags & ML_BLOCKING != 0 || strict {
                    return false;
                }
            }
        }
    }
    true
}

fn is_door_special(s: i32) -> bool {
    matches!(s, 1 | 26 | 27 | 28 | 31 | 32 | 33 | 34 | 117 | 118)
}
fn is_remote_door_special(s: i32) -> bool {
    matches!(s, 2 | 4 | 16 | 29 | 46 | 61 | 63 | 76 | 86 | 90 | 99 | 103 | 105 | 106 | 108 | 109 | 111 | 112 | 114 | 115 | 133 | 134 | 135 | 136 | 137)
}
fn is_lift_special(s: i32) -> bool {
    matches!(s, 10 | 21 | 62 | 88 | 120 | 121 | 122 | 123 | 53 | 87)
}

impl Nav {
    pub fn build(map: &Map) -> Nav {
        let nsec = map.sectors.len();
        let nss = map.subsectors.len();
        // ---- door and lift sectors
        let mut door_sector = vec![false; nsec];
        let mut lift_sector = vec![false; nsec];
        for li in &map.lines {
            if is_door_special(li.special) && li.backsector >= 0 {
                door_sector[li.backsector as usize] = true;
            }
            if (is_remote_door_special(li.special) || is_lift_special(li.special)) && li.tag != 0 {
                for (i, s) in map.sectors.iter().enumerate() {
                    if s.tag == li.tag {
                        if is_lift_special(li.special) {
                            lift_sector[i] = true;
                        } else {
                            door_sector[i] = true;
                        }
                    }
                }
            }
        }
        for (i, s) in map.sectors.iter().enumerate() {
            if s.special == 10 || s.special == 14 {
                door_sector[i] = true;
            }
        }
        let neighbours = |sec: usize| -> Vec<usize> {
            let mut v = Vec::new();
            for &l in &map.sectors[sec].lines {
                let li = &map.lines[l as usize];
                if li.backsector < 0 {
                    continue;
                }
                let o = if li.frontsector as usize == sec { li.backsector } else { li.frontsector };
                v.push(o as usize);
            }
            v
        };
        let mut door_top = vec![0; nsec];
        let mut lift_low = vec![0; nsec];
        for i in 0..nsec {
            let s = &map.sectors[i];
            if door_sector[i] {
                let mut h = i32::MAX;
                for o in neighbours(i) {
                    h = h.min(map.sectors[o].ceilingheight);
                }
                door_top[i] = if h == i32::MAX { s.ceilingheight } else { (h - 4 * FRACUNIT).max(s.ceilingheight) };
            } else {
                door_top[i] = s.ceilingheight;
            }
            let mut low = s.floorheight;
            if lift_sector[i] {
                for o in neighbours(i) {
                    low = low.min(map.sectors[o].floorheight);
                }
            }
            lift_low[i] = low;
        }

        // ---- polygons
        let mut polys: Vec<Vec<P>> = vec![Vec::new(); nss];
        let pad = 256 * FRACUNIT as i64;
        let x0 = map.bmaporgx as i64 - pad;
        let y0 = map.bmaporgy as i64 - pad;
        let x1 = map.bmaporgx as i64 + (map.bmapwidth as i64) * MAPBLOCKSIZE as i64 + pad;
        let y1 = map.bmaporgy as i64 + (map.bmapheight as i64) * MAPBLOCKSIZE as i64 + pad;
        let root_poly = vec![(x0, y0), (x1, y0), (x1, y1), (x0, y1)];
        if map.nodes.is_empty() {
            polys[0] = root_poly;
        } else {
            let mut stack: Vec<(u32, Vec<P>)> = vec![((map.nodes.len() - 1) as u32, root_poly)];
            while let Some((n, poly)) = stack.pop() {
                if n & NF_SUBSECTOR != 0 {
                    let s = (n & !NF_SUBSECTOR) as usize;
                    if s < nss {
                        polys[s] = poly;
                    }
                    continue;
                }
                let node = &map.nodes[n as usize];
                let (lx, ly, ldx, ldy) = (node.x as i64, node.y as i64, node.dx as i64, node.dy as i64);
                let front = clip(&poly, lx, ly, ldx, ldy, true);
                let back = clip(&poly, lx, ly, ldx, ldy, false);
                stack.push((node.children[0], front));
                stack.push((node.children[1], back));
            }
        }
        let mut seg_ss = vec![0u32; map.segs.len()];
        for (si, ss) in map.subsectors.iter().enumerate() {
            let mut poly = std::mem::take(&mut polys[si]);
            for k in 0..ss.numlines {
                let seg = &map.segs[(ss.firstline + k) as usize];
                seg_ss[(ss.firstline + k) as usize] = si as u32;
                let (lx, ly) = (seg.v1.x as i64, seg.v1.y as i64);
                let (ldx, ldy) = (seg.v2.x as i64 - lx, seg.v2.y as i64 - ly);
                if ldx == 0 && ldy == 0 {
                    continue;
                }
                poly = clip(&poly, lx, ly, ldx, ldy, true);
            }
            polys[si] = poly;
        }

        let mut nodes: Vec<NavNode> = Vec::with_capacity(nss);
        for (si, poly) in polys.iter().enumerate() {
            let a = area2(poly).abs() / 2;
            let area = (a >> 32) as i64;
            let c = centroid(poly);
            let sec = map.subsectors[si].sector as u32;
            let sp = map.sectors[sec as usize].special;
            nodes.push(NavNode { cx: c.0 as i32, cy: c.1 as i32, sector: sec, area, hurts: matches!(sp, 4 | 5 | 7 | 11 | 16) });
        }

        // ---- neighbours by probing outside each polygon edge
        // (a, b) -> (edge P, edge Q, tmin, tmax, n)
        let mut raw: Vec<Vec<(u32, P, P, i64, i64, i64)>> = vec![Vec::new(); nss];
        for a in 0..nss {
            let poly = &polys[a];
            if poly.len() < 3 || nodes[a].area < 16 {
                continue;
            }
            let c = (nodes[a].cx as i64, nodes[a].cy as i64);
            for i in 0..poly.len() {
                let p = poly[i];
                let q = poly[(i + 1) % poly.len()];
                let dx = q.0 - p.0;
                let dy = q.1 - p.1;
                let len = isqrt((dx >> 8) * (dx >> 8) + (dy >> 8) * (dy >> 8)) << 8; // fixed
                if len < FRACUNIT as i64 {
                    continue;
                }
                let lu = len >> 16; // map units
                let n = (lu / 8).clamp(1, 512);
                // outward unit normal * 2 units
                let (mut nx, mut ny) = (dy, -dx);
                let mid = ((p.0 + q.0) / 2, (p.1 + q.1) / 2);
                if (mid.0 - c.0) as i128 * nx as i128 + (mid.1 - c.1) as i128 * ny as i128 <= 0 {
                    nx = -nx;
                    ny = -ny;
                }
                let ox = (nx as i128 * 2 * FRACUNIT as i128 / len as i128) as i64;
                let oy = (ny as i128 * 2 * FRACUNIT as i128 / len as i128) as i64;
                let mut cur: Option<(u32, i64, i64)> = None;
                let flush = |cur: &mut Option<(u32, i64, i64)>, raw: &mut Vec<Vec<(u32, P, P, i64, i64, i64)>>| {
                    if let Some((b, t0, t1)) = cur.take() {
                        raw[a].push((b, p, q, t0, t1, n));
                    }
                };
                for k in 0..n {
                    let sx = p.0 + (dx as i128 * (2 * k + 1) as i128 / (2 * n) as i128) as i64;
                    let sy = p.1 + (dy as i128 * (2 * k + 1) as i128 / (2 * n) as i128) as i64;
                    let qx = sx + ox;
                    let qy = sy + oy;
                    let b = if qx.abs() < i32::MAX as i64 && qy.abs() < i32::MAX as i64 { map.point_in_subsector(qx as i32, qy as i32) } else { a };
                    let valid = b != a && inside(&polys[b], qx, qy, FRACUNIT as i64 / 2);
                    match (&mut cur, valid) {
                        (Some((cb, _, t1)), true) if *cb == b as u32 => *t1 = k,
                        (_, true) => {
                            flush(&mut cur, &mut raw);
                            cur = Some((b as u32, k, k));
                        }
                        (_, false) => flush(&mut cur, &mut raw),
                    }
                }
                flush(&mut cur, &mut raw);
            }
        }

        // ---- build edges
        let mut adj: Vec<Vec<NavEdge>> = vec![Vec::new(); nss];
        for a in 0..nss {
            let mut raws = std::mem::take(&mut raw[a]);
            let plen_of = |e: &(u32, P, P, i64, i64, i64)| -> i64 {
                let dx = e.2 .0 - e.1 .0;
                let dy = e.2 .1 - e.1 .1;
                let l = isqrt((dx >> 8) * (dx >> 8) + (dy >> 8) * (dy >> 8)) >> 8;
                l * (e.4 - e.3 + 1) / e.5.max(1)
            };
            // longest portal first per neighbour, stable
            raws.sort_by(|x, y| x.0.cmp(&y.0).then(plen_of(y).cmp(&plen_of(x))));
            raws.dedup_by(|x, y| x.0 == y.0);
            for (b, p, q, t0, t1, n) in raws {
                let b = b as usize;
                let dx = q.0 - p.0;
                let dy = q.1 - p.1;
                let e1 = (p.0 + (dx as i128 * t0 as i128 / n as i128) as i64, p.1 + (dy as i128 * t0 as i128 / n as i128) as i64);
                let e2 = (p.0 + (dx as i128 * (t1 + 1) as i128 / n as i128) as i64, p.1 + (dy as i128 * (t1 + 1) as i128 / n as i128) as i64);
                let mid = ((e1.0 + e2.0) / 2, (e1.1 + e2.1) / 2);
                // the linedef along this boundary, if any
                let mut line: i32 = -1;
                let ss = &map.subsectors[a];
                for k in 0..ss.numlines {
                    let seg = &map.segs[(ss.firstline + k) as usize];
                    let (lx, ly) = (seg.v1.x as i64, seg.v1.y as i64);
                    let (ldx, ldy) = (seg.v2.x as i64 - lx, seg.v2.y as i64 - ly);
                    let slen = isqrt((ldx >> 8) * (ldx >> 8) + (ldy >> 8) * (ldy >> 8)) << 8;
                    if slen == 0 {
                        continue;
                    }
                    let c = cross(mid.0, mid.1, lx, ly, ldx, ldy);
                    if c.abs() <= (FRACUNIT as i128) * slen as i128 {
                        // within 1 unit of the seg's line; and within its extent
                        let dot = (mid.0 - lx) as i128 * ldx as i128 + (mid.1 - ly) as i128 * ldy as i128;
                        let l2 = ldx as i128 * ldx as i128 + ldy as i128 * ldy as i128;
                        if dot >= 0 && dot <= l2 {
                            line = seg.linedef;
                            break;
                        }
                    }
                }
                if line >= 0 {
                    let li = &map.lines[line as usize];
                    if li.backsector < 0 || li.flags & ML_BLOCKING != 0 {
                        continue;
                    }
                }
                let sa = nodes[a].sector as usize;
                let sb = nodes[b].sector as usize;
                let fa = map.sectors[sa].floorheight;
                let fb = map.sectors[sb].floorheight;
                let ca = door_top[sa].max(map.sectors[sa].ceilingheight);
                let cb = door_top[sb].max(map.sectors[sb].ceilingheight);
                let static_ca = map.sectors[sa].ceilingheight;
                let static_cb = map.sectors[sb].ceilingheight;
                let mut kind = EK_WALK;
                // heights
                let step = fb - fa;
                if step > 24 * FRACUNIT {
                    // lift from below?
                    let fa_max = fa; // a lift we stand on rides up to its static height
                    let fb_min = if lift_sector[sb] { lift_low[sb] } else { fb };
                    if fb_min - fa_max <= 24 * FRACUNIT {
                        kind = EK_LIFT;
                    } else if lift_sector[sa] {
                        // riding lift a up: its static (top) height is fa already
                        continue;
                    } else {
                        continue;
                    }
                } else if step < -24 * FRACUNIT {
                    kind = EK_DROP;
                }
                let top = ca.min(cb);
                let bottom = fa.max(fb);
                let head_needed = 56 * FRACUNIT;
                if kind != EK_LIFT && top - bottom < head_needed {
                    continue;
                }
                if kind == EK_LIFT && top - fb.max(lift_low[sb]) < head_needed {
                    continue;
                }
                if static_ca.min(static_cb) - bottom < head_needed && (door_sector[sa] || door_sector[sb]) && kind == EK_WALK {
                    kind = EK_DOOR;
                }
                // crossing point: closest clear spot to the portal middle
                let plen = {
                    let ddx = e2.0 - e1.0;
                    let ddy = e2.1 - e1.1;
                    isqrt((ddx >> 8) * (ddx >> 8) + (ddy >> 8) * (ddy >> 8)) >> 8
                };
                let steps = (plen / 4).max(1);
                let mut found: Option<P> = None;
                for s in 0..=steps {
                    // middle-out order
                    let off = if s % 2 == 0 { s / 2 } else { -(s / 2 + 1) };
                    let t = steps / 2 + off;
                    if t < 0 || t > steps {
                        continue;
                    }
                    let x = e1.0 + ((e2.0 - e1.0) as i128 * t as i128 / steps as i128) as i64;
                    let y = e1.1 + ((e2.1 - e1.1) as i128 * t as i128 / steps as i128) as i64;
                    if static_clear(map, x as i32, y as i32, 16 * FRACUNIT, false) {
                        found = Some((x, y));
                        break;
                    }
                }
                let pt = match found {
                    Some(p) => p,
                    None => continue,
                };
                let d1 = aprox_distance((pt.0 - nodes[a].cx as i64) as i32, (pt.1 - nodes[a].cy as i64) as i32) >> FRACBITS;
                let d2 = aprox_distance((nodes[b].cx as i64 - pt.0) as i32, (nodes[b].cy as i64 - pt.1) as i32) >> FRACBITS;
                let mut cost = d1 + d2 + 8;
                match kind {
                    EK_DOOR => cost += 96,
                    EK_LIFT => cost += 320,
                    _ => {}
                }
                if nodes[b].hurts {
                    cost += 256;
                }
                adj[a].push(NavEdge { to: b as u32, px: pt.0 as i32, py: pt.1 as i32, cost, kind, line });
            }
        }
        // ---- teleporters
        for (li_idx, li) in map.lines.iter().enumerate() {
            if li.special != 39 && li.special != 97 {
                continue;
            }
            // destination
            let mut dest: Option<(Fixed, Fixed)> = None;
            for t in &map.things {
                if t.type_ != 14 {
                    continue;
                }
                let tx = (t.x as i32) << FRACBITS;
                let ty = (t.y as i32) << FRACBITS;
                let s = map.sector_at(tx, ty);
                if map.sectors[s].tag == li.tag {
                    dest = Some((tx, ty));
                    break;
                }
            }
            let (tx, ty) = match dest {
                Some(d) => d,
                None => continue,
            };
            let dss = map.point_in_subsector(tx, ty) as u32;
            // front-side subsectors touching the line
            let mx = li.v1.x / 2 + li.v2.x / 2;
            let my = li.v1.y / 2 + li.v2.y / 2;
            // aim a bit past the line on its back side
            let len = isqrt(((li.dx >> 8) as i64).pow(2) + ((li.dy >> 8) as i64).pow(2)).max(1) << 8;
            let bx = (-(li.dy as i64) * 20 * FRACUNIT as i64 / len) as i32; // back normal = left of v1->v2
            let by = ((li.dx as i64) * 20 * FRACUNIT as i64 / len) as i32;
            let (px, py) = (mx + bx, my + by);
            for (si, seg) in map.segs.iter().enumerate() {
                if seg.linedef as usize != li_idx || seg.side != 0 {
                    continue;
                }
                let a = seg_ss[si] as usize;
                if adj[a].iter().any(|e| e.kind == EK_TELEPORT && e.to == dss) {
                    continue;
                }
                adj[a].push(NavEdge { to: dss, px, py, cost: 64, kind: EK_TELEPORT, line: li_idx as i32 });
            }
        }
        // ---- CSR
        let mut first = Vec::with_capacity(nss + 1);
        let mut edges = Vec::new();
        for list in adj.into_iter() {
            first.push(edges.len() as u32);
            edges.extend(list);
        }
        first.push(edges.len() as u32);

        let polys_mu: Vec<Vec<(i32, i32)>> = polys.iter().map(|p| p.iter().map(|&(x, y)| ((x >> 16) as i32, (y >> 16) as i32)).collect()).collect();
        let mut nav = Nav { nodes, edges, first, reach: vec![false; nss], door_sector, lift_sector, door_top, lift_low, polys: polys_mu };
        // ---- main area: strongly connected with the deathmatch / player starts
        let mut starts: Vec<usize> = map
            .things
            .iter()
            .filter(|t| t.type_ == 11 || (1..=4).contains(&t.type_))
            .map(|t| map.point_in_subsector((t.x as i32) << FRACBITS, (t.y as i32) << FRACBITS))
            .collect();
        starts.sort_unstable();
        starts.dedup();
        if !starts.is_empty() {
            let fwd = nav.bfs(&starts, false);
            let bwd = nav.bfs(&starts, true);
            for i in 0..nss {
                nav.reach[i] = fwd[i] && bwd[i];
            }
        }
        nav
    }

    pub fn edges_of(&self, n: usize) -> &[NavEdge] {
        &self.edges[self.first[n] as usize..self.first[n + 1] as usize]
    }

    fn bfs(&self, starts: &[usize], reverse: bool) -> Vec<bool> {
        let n = self.nodes.len();
        let mut seen = vec![false; n];
        let mut q: Vec<usize> = Vec::new();
        let mut radj: Vec<Vec<u32>> = Vec::new();
        if reverse {
            radj = vec![Vec::new(); n];
            for a in 0..n {
                for e in self.edges_of(a) {
                    radj[e.to as usize].push(a as u32);
                }
            }
        }
        for &s in starts {
            if !seen[s] {
                seen[s] = true;
                q.push(s);
            }
        }
        while let Some(a) = q.pop() {
            if reverse {
                for &b in &radj[a] {
                    if !seen[b as usize] {
                        seen[b as usize] = true;
                        q.push(b as usize);
                    }
                }
            } else {
                for e in self.edges_of(a) {
                    let b = e.to as usize;
                    if !seen[b] {
                        seen[b] = true;
                        q.push(b);
                    }
                }
            }
        }
        seen
    }
}
