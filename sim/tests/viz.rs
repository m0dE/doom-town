// Debug visualisation (ignored by default): top-down PNG of a map with bot traces.
//   VIZ_MAP=MAP19 VIZ_SECS=60 cargo test --release --test viz -- --ignored --nocapture
mod common;
use common::*;
use doomsim::world::*;

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    !c
}

fn png(w: usize, h: usize, rgb: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity((w * 3 + 1) * h);
    for y in 0..h {
        raw.push(0);
        raw.extend_from_slice(&rgb[y * w * 3..(y + 1) * w * 3]);
    }
    let mut z = vec![0x78, 0x01];
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for &x in &raw {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    for (i, chunk) in raw.chunks(65535).enumerate() {
        let last = (i + 1) * 65535 >= raw.len();
        z.push(last as u8);
        z.extend_from_slice(&(chunk.len() as u16).to_le_bytes());
        z.extend_from_slice(&(!(chunk.len() as u16)).to_le_bytes());
        z.extend_from_slice(chunk);
    }
    z.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut chunk = |t: &[u8], d: &[u8]| {
        out.extend_from_slice(&(d.len() as u32).to_be_bytes());
        let mut c = t.to_vec();
        c.extend_from_slice(d);
        out.extend_from_slice(&c);
        out.extend_from_slice(&crc32(&c).to_be_bytes());
    };
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&(w as u32).to_be_bytes());
    ihdr.extend_from_slice(&(h as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    chunk(b"IHDR", &ihdr);
    chunk(b"IDAT", &z);
    chunk(b"IEND", &[]);
    out
}

#[test]
#[ignore]
fn viz() {
    let name = std::env::var("VIZ_MAP").unwrap_or("MAP19".into());
    let secs: u32 = std::env::var("VIZ_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(60);
    let map = load(&name);
    let mut w = World::new(map.clone(), 4242, 64);
    // bounds
    let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for (i, n) in map.nav.nodes.iter().enumerate() {
        if !map.nav.reach[i] {
            continue;
        }
        x0 = x0.min((n.cx >> 16) - 300);
        y0 = y0.min((n.cy >> 16) - 300);
        x1 = x1.max((n.cx >> 16) + 300);
        y1 = y1.max((n.cy >> 16) + 300);
    }
    let scale: i32 = std::env::var("VIZ_SCALE").ok().and_then(|s| s.parse().ok()).unwrap_or(((x1 - x0).max(y1 - y0) / 1600).max(1) + 1);
    let wd = ((x1 - x0) / scale + 8) as usize;
    println!("origin x0 {} y1 {} scale {}", x0, y1, scale);
    let ht = ((y1 - y0) / scale + 8) as usize;
    let mut heat = vec![0u32; wd * ht];
    let mut stuck = vec![false; wd * ht];
    let px = |x: i32, y: i32| -> Option<usize> {
        let u = ((x >> 16) - x0) / scale + 4;
        let v = (y1 - (y >> 16)) / scale + 4;
        if u < 0 || v < 0 || u as usize >= wd || v as usize >= ht { None } else { Some(v as usize * wd + u as usize) }
    };
    let n = w.players.len();
    let mut samp: Vec<(i32, i32, u32)> = vec![(0, 0, 0); n];
    for _ in 0..35 * secs {
        w.tick();
        for i in 0..n {
            if let Some(h) = w.deref(w.players[i].mo) {
                if w.players[i].playerstate != PST_LIVE {
                    samp[i].2 = w.tic;
                    continue;
                }
                let m = w.mo(h);
                if let Some(p) = px(m.x, m.y) {
                    heat[p] += 1;
                }
                if w.tic - samp[i].2 >= 350 {
                    let d = doomsim::fixed::aprox_distance(m.x - samp[i].0, m.y - samp[i].1) >> 16;
                    if d < 64 && samp[i].2 != 0 {
                        if let Some(p) = px(m.x, m.y) {
                            stuck[p] = true;
                        }
                        println!("stuck slot {} at ({}, {}) sector {} goal {} path {:?}", i, m.x >> 16, m.y >> 16, map.subsectors[m.subsector as usize].sector, w.players[i].bot.goal_node, w.players[i].bot.path.iter().take(2).collect::<Vec<_>>());
                    }
                    samp[i] = (m.x, m.y, w.tic);
                }
            }
        }
    }
    let mut rgb = vec![0u8; wd * ht * 3];
    // nav nodes: blue = main area, red = outside it, magenta = door/lift sector
    for (i, poly) in map.nav.polys.iter().enumerate() {
        if poly.len() < 3 {
            continue;
        }
        let (mut a0, mut b0, mut a1, mut b1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        for &(x, y) in poly {
            a0 = a0.min(x);
            b0 = b0.min(y);
            a1 = a1.max(x);
            b1 = b1.max(y);
        }
        let sec = map.nav.nodes[i].sector as usize;
        let col: [u8; 3] = if !map.nav.reach[i] { [70, 0, 0] } else if map.nav.door_sector[sec] || map.nav.lift_sector[sec] { [60, 0, 60] } else { [0, 0, 55] };
        let mut y = b0 - b0.rem_euclid(scale);
        while y <= b1 {
            let mut x = a0 - a0.rem_euclid(scale);
            while x <= a1 {
                let n = poly.len();
                let mut pos = false;
                let mut neg = false;
                for k in 0..n {
                    let (ax, ay) = poly[k];
                    let (bx, by) = poly[(k + 1) % n];
                    let c = (x - ax) as i64 * (by - ay) as i64 - (y - ay) as i64 * (bx - ax) as i64;
                    if c > 0 { pos = true; } else if c < 0 { neg = true; }
                }
                if !(pos && neg) {
                    if let Some(p) = px(x << 16, y << 16) {
                        rgb[p * 3..p * 3 + 3].copy_from_slice(&col);
                    }
                }
                x += scale;
            }
            y += scale;
        }
    }
    for i in 0..wd * ht {
        let hv = heat[i];
        if hv > 0 {
            let v = (40 + (hv as f32).sqrt() as u32 * 12).min(255) as u8;
            rgb[i * 3 + 1] = v;
        }
    }
    // lines
    for l in &map.lines {
        let steps = ((((l.dx >> 16).abs() + (l.dy >> 16).abs()) / scale) + 1) as i64;
        for k in 0..=steps {
            let x = l.v1.x as i64 + l.dx as i64 * k / steps;
            let y = l.v1.y as i64 + l.dy as i64 * k / steps;
            if let Some(p) = px(x as i32, y as i32) {
                let c = if l.backsector < 0 { 255 } else if l.special != 0 { 200 } else { 110 };
                rgb[p * 3] = c;
                rgb[p * 3 + 1] = if l.special != 0 { 60 } else { c };
                rgb[p * 3 + 2] = if l.special != 0 { 255 } else { c };
            }
        }
    }
    for i in 0..wd * ht {
        if stuck[i] {
            for (dx, dy) in [(0i32, 0i32), (1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)] {
                let x = (i % wd) as i32 + dx;
                let y = (i / wd) as i32 + dy;
                if x >= 0 && y >= 0 && (x as usize) < wd && (y as usize) < ht {
                    let j = y as usize * wd + x as usize;
                    rgb[j * 3] = 255;
                    rgb[j * 3 + 1] = 0;
                    rgb[j * 3 + 2] = 0;
                }
            }
        }
    }
    let out = format!("/tmp/viz-{}.png", name);
    std::fs::write(&out, png(wd, ht, &rgb)).unwrap();
    println!("wrote {} ({}x{})", out, wd, ht);
}
