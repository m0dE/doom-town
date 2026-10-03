// Map loading (p_setup.c, w_wad.c subset) and the static, shared part of a level.
// Copyright (C) 1993-1996 by id Software, Inc.
// Port: Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.

use crate::fixed::*;

pub const ML_BLOCKING: i32 = 1;
pub const ML_BLOCKMONSTERS: i32 = 2;
pub const ML_TWOSIDED: i32 = 4;
pub const ML_SECRET: i32 = 32;

pub const NF_SUBSECTOR: u32 = 0x8000;

pub const ST_HORIZONTAL: u8 = 0;
pub const ST_VERTICAL: u8 = 1;
pub const ST_POSITIVE: u8 = 2;
pub const ST_NEGATIVE: u8 = 3;

pub const BOXTOP: usize = 0;
pub const BOXBOTTOM: usize = 1;
pub const BOXLEFT: usize = 2;
pub const BOXRIGHT: usize = 3;

pub const MAPBLOCKSHIFT: i32 = FRACBITS + 7;
pub const MAPBLOCKSIZE: i32 = 128 * FRACUNIT;
pub const MAPBTOFRAC: i32 = MAPBLOCKSHIFT - FRACBITS;
pub const MAXRADIUS: Fixed = 32 * FRACUNIT;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MapThing {
    pub x: i16,
    pub y: i16,
    pub angle: i16,
    pub type_: i16,
    pub options: i16,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Vertex {
    pub x: Fixed,
    pub y: Fixed,
}

#[derive(Clone, Debug)]
pub struct Line {
    pub v1: Vertex,
    pub v2: Vertex,
    pub dx: Fixed,
    pub dy: Fixed,
    pub flags: i32,
    pub special: i32,
    pub tag: i32,
    pub sidenum: [i32; 2],
    pub bbox: [Fixed; 4],
    pub slopetype: u8,
    pub frontsector: i32,
    pub backsector: i32,
}

#[derive(Clone, Debug)]
pub struct Side {
    pub textureoffset: Fixed,
    pub rowoffset: Fixed,
    pub toptexture: i32,
    pub bottomtexture: i32,
    pub midtexture: i32,
    pub sector: i32,
}

#[derive(Clone, Debug)]
pub struct SectorDef {
    pub floorheight: Fixed,
    pub ceilingheight: Fixed,
    pub floorpic: i32,
    pub ceilingpic: i32,
    pub lightlevel: i32,
    pub special: i32,
    pub tag: i32,
    pub lines: Vec<u32>,
    pub soundorg: (Fixed, Fixed),
    pub blockbox: [i32; 4],
}

#[derive(Clone, Debug)]
pub struct Subsector {
    pub sector: i32,
    pub numlines: i32,
    pub firstline: i32,
}

#[derive(Clone, Debug)]
pub struct Seg {
    pub v1: Vertex,
    pub v2: Vertex,
    pub linedef: i32,
    pub side: i32,
    pub frontsector: i32,
    pub backsector: i32,
}

#[derive(Clone, Debug)]
pub struct Node {
    pub x: Fixed,
    pub y: Fixed,
    pub dx: Fixed,
    pub dy: Fixed,
    pub bbox: [[Fixed; 4]; 2],
    pub children: [u32; 2],
}

pub struct Map {
    pub name: String,
    pub things: Vec<MapThing>,
    pub vertexes: Vec<Vertex>,
    pub lines: Vec<Line>,
    pub sides: Vec<Side>,
    pub sectors: Vec<SectorDef>,
    pub subsectors: Vec<Subsector>,
    pub segs: Vec<Seg>,
    pub nodes: Vec<Node>,
    pub blockmaplump: Vec<i16>,
    pub bmaporgx: Fixed,
    pub bmaporgy: Fixed,
    pub bmapwidth: i32,
    pub bmapheight: i32,
    /// per block: list of line indices (decoded from blockmaplump, includes vanilla's leading 0)
    pub blocklines: Vec<Vec<u32>>,
    pub reject: Vec<u8>,
    pub texture_names: Vec<String>,
    pub flat_names: Vec<String>,
    /// texture index -> its SW1/SW2 partner (or -1)
    pub switch_partner: Vec<i32>,
    pub sky_flat: i32,
    /// fnv hash of the map lumps, to validate serialized worlds
    pub hash: u32,
    /// deathmatch starts, player starts (1..4) and generated spawn spots
    pub spawn_spots: Vec<MapThing>,
    pub num_dm_starts: usize,
    pub nav: crate::bots::nav::Nav,
}

pub fn fnv1a(bytes: &[u8], mut h: u32) -> u32 {
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(16777619);
    }
    h
}

fn rd16(b: &[u8], o: usize) -> i16 {
    i16::from_le_bytes([b[o], b[o + 1]])
}
fn rd32(b: &[u8], o: usize) -> i32 {
    i32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn name8(b: &[u8], o: usize) -> String {
    let mut s = String::new();
    for i in 0..8 {
        let c = b[o + i];
        if c == 0 {
            break;
        }
        s.push((c as char).to_ascii_uppercase());
    }
    s
}

pub struct Lump<'a> {
    pub name: String,
    pub data: &'a [u8],
}

pub fn wad_lumps(wad: &[u8]) -> Result<Vec<Lump<'_>>, i32> {
    if wad.len() < 12 {
        return Err(-1);
    }
    let id = &wad[0..4];
    if id != b"PWAD" && id != b"IWAD" {
        return Err(-1);
    }
    let n = rd32(wad, 4);
    let off = rd32(wad, 8);
    if n < 0 || off < 0 || (off as usize) + (n as usize) * 16 > wad.len() {
        return Err(-2);
    }
    let mut v = Vec::with_capacity(n as usize);
    for i in 0..n as usize {
        let p = off as usize + i * 16;
        let pos = rd32(wad, p);
        let size = rd32(wad, p + 4);
        if pos < 0 || size < 0 || pos as usize + size as usize > wad.len() {
            return Err(-2);
        }
        v.push(Lump { name: name8(wad, p + 8), data: &wad[pos as usize..pos as usize + size as usize] });
    }
    Ok(v)
}

/// p_switch.c alphSwitchList (Doom II set, episode <= 3).
pub const SWITCH_LIST: [(&str, &str); 41] = [
    ("SW1BRCOM", "SW2BRCOM"),
    ("SW1BRN1", "SW2BRN1"),
    ("SW1BRN2", "SW2BRN2"),
    ("SW1BRNGN", "SW2BRNGN"),
    ("SW1BROWN", "SW2BROWN"),
    ("SW1COMM", "SW2COMM"),
    ("SW1COMP", "SW2COMP"),
    ("SW1DIRT", "SW2DIRT"),
    ("SW1EXIT", "SW2EXIT"),
    ("SW1GRAY", "SW2GRAY"),
    ("SW1GRAY1", "SW2GRAY1"),
    ("SW1METAL", "SW2METAL"),
    ("SW1PIPE", "SW2PIPE"),
    ("SW1SLAD", "SW2SLAD"),
    ("SW1STARG", "SW2STARG"),
    ("SW1STON1", "SW2STON1"),
    ("SW1STON2", "SW2STON2"),
    ("SW1STONE", "SW2STONE"),
    ("SW1STRTN", "SW2STRTN"),
    ("SW1BLUE", "SW2BLUE"),
    ("SW1CMT", "SW2CMT"),
    ("SW1GARG", "SW2GARG"),
    ("SW1GSTON", "SW2GSTON"),
    ("SW1HOT", "SW2HOT"),
    ("SW1LION", "SW2LION"),
    ("SW1SATYR", "SW2SATYR"),
    ("SW1SKIN", "SW2SKIN"),
    ("SW1VINE", "SW2VINE"),
    ("SW1WOOD", "SW2WOOD"),
    ("SW1PANEL", "SW2PANEL"),
    ("SW1ROCK", "SW2ROCK"),
    ("SW1MET2", "SW2MET2"),
    ("SW1WDMET", "SW2WDMET"),
    ("SW1BRIK", "SW2BRIK"),
    ("SW1MOD1", "SW2MOD1"),
    ("SW1ZIM", "SW2ZIM"),
    ("SW1STON6", "SW2STON6"),
    ("SW1TEK", "SW2TEK"),
    ("SW1MARB", "SW2MARB"),
    ("SW1SKULL", "SW2SKULL"),
    ("", ""),
];

fn intern(names: &mut Vec<String>, n: &str) -> i32 {
    if let Some(i) = names.iter().position(|x| x == n) {
        return i as i32;
    }
    names.push(n.to_string());
    (names.len() - 1) as i32
}

impl Map {
    pub fn load(wad: &[u8]) -> Result<Map, i32> {
        let lumps = wad_lumps(wad)?;
        // find the map marker: the lump right before THINGS
        let ti = lumps.iter().position(|l| l.name == "THINGS").ok_or(-3)?;
        let name = if ti > 0 { lumps[ti - 1].name.clone() } else { String::from("MAP") };
        let find = |n: &str| -> Result<&[u8], i32> {
            for l in &lumps[ti..] {
                if l.name == n {
                    return Ok(l.data);
                }
            }
            Err(-4)
        };
        let things_l = find("THINGS")?;
        let lines_l = find("LINEDEFS")?;
        let sides_l = find("SIDEDEFS")?;
        let verts_l = find("VERTEXES")?;
        let segs_l = find("SEGS")?;
        let ss_l = find("SSECTORS")?;
        let nodes_l = find("NODES")?;
        let secs_l = find("SECTORS")?;
        let reject_l = find("REJECT").unwrap_or(&[]);
        let bmap_l = find("BLOCKMAP")?;

        let mut hash = 2166136261u32;
        for l in [things_l, lines_l, sides_l, verts_l, segs_l, ss_l, nodes_l, secs_l, reject_l, bmap_l] {
            hash = fnv1a(l, hash);
        }

        // vertexes
        let vertexes: Vec<Vertex> = (0..verts_l.len() / 4)
            .map(|i| Vertex { x: (rd16(verts_l, i * 4) as i32) << FRACBITS, y: (rd16(verts_l, i * 4 + 2) as i32) << FRACBITS })
            .collect();
        if vertexes.is_empty() {
            return Err(-5);
        }

        // sectors
        let mut flat_names: Vec<String> = Vec::new();
        let mut sectors: Vec<SectorDef> = Vec::new();
        for i in 0..secs_l.len() / 26 {
            let o = i * 26;
            let fp = intern(&mut flat_names, &name8(secs_l, o + 4));
            let cp = intern(&mut flat_names, &name8(secs_l, o + 12));
            sectors.push(SectorDef {
                floorheight: (rd16(secs_l, o) as i32) << FRACBITS,
                ceilingheight: (rd16(secs_l, o + 2) as i32) << FRACBITS,
                floorpic: fp,
                ceilingpic: cp,
                lightlevel: rd16(secs_l, o + 20) as i32,
                special: rd16(secs_l, o + 22) as i32,
                tag: rd16(secs_l, o + 24) as i32,
                lines: Vec::new(),
                soundorg: (0, 0),
                blockbox: [0; 4],
            });
        }
        if sectors.is_empty() {
            return Err(-5);
        }
        let sky_flat = flat_names.iter().position(|n| n == "F_SKY1").map(|x| x as i32).unwrap_or(-1);

        // sides
        let mut texture_names: Vec<String> = vec![String::from("-")];
        let mut sides: Vec<Side> = Vec::new();
        for i in 0..sides_l.len() / 30 {
            let o = i * 30;
            let tex = |names: &mut Vec<String>, s: String| -> i32 { if s == "-" || s.is_empty() { 0 } else { intern(names, &s) } };
            let top = tex(&mut texture_names, name8(sides_l, o + 4));
            let bot = tex(&mut texture_names, name8(sides_l, o + 12));
            let mid = tex(&mut texture_names, name8(sides_l, o + 20));
            let mut sec = rd16(sides_l, o + 28) as i32;
            if sec < 0 || sec as usize >= sectors.len() {
                sec = 0;
            }
            sides.push(Side {
                textureoffset: (rd16(sides_l, o) as i32) << FRACBITS,
                rowoffset: (rd16(sides_l, o + 2) as i32) << FRACBITS,
                toptexture: top,
                bottomtexture: bot,
                midtexture: mid,
                sector: sec,
            });
        }
        // switch partners: make sure both halves of every switch pair exist in the table
        let mut pairs: Vec<(i32, i32)> = Vec::new();
        for (a, b) in SWITCH_LIST.iter() {
            if a.is_empty() {
                break;
            }
            let ha = texture_names.iter().any(|n| n == a);
            let hb = texture_names.iter().any(|n| n == b);
            if ha || hb {
                let ia = intern(&mut texture_names, a);
                let ib = intern(&mut texture_names, b);
                pairs.push((ia, ib));
            }
        }
        let mut switch_partner = vec![-1i32; texture_names.len()];
        for (a, b) in pairs {
            switch_partner[a as usize] = b;
            switch_partner[b as usize] = a;
        }

        // lines
        let nv = vertexes.len() as i32;
        let ns = sides.len() as i32;
        let mut lines: Vec<Line> = Vec::new();
        for i in 0..lines_l.len() / 14 {
            let o = i * 14;
            let iv1 = (rd16(lines_l, o) as u16 as i32).min(nv - 1);
            let iv2 = (rd16(lines_l, o + 2) as u16 as i32).min(nv - 1);
            let v1 = vertexes[iv1 as usize];
            let v2 = vertexes[iv2 as usize];
            let dx = v2.x.wrapping_sub(v1.x);
            let dy = v2.y.wrapping_sub(v1.y);
            let slopetype = if dx == 0 {
                ST_VERTICAL
            } else if dy == 0 {
                ST_HORIZONTAL
            } else if fixed_div(dy, dx) > 0 {
                ST_POSITIVE
            } else {
                ST_NEGATIVE
            };
            let mut bbox = [0; 4];
            if v1.x < v2.x {
                bbox[BOXLEFT] = v1.x;
                bbox[BOXRIGHT] = v2.x;
            } else {
                bbox[BOXLEFT] = v2.x;
                bbox[BOXRIGHT] = v1.x;
            }
            if v1.y < v2.y {
                bbox[BOXBOTTOM] = v1.y;
                bbox[BOXTOP] = v2.y;
            } else {
                bbox[BOXBOTTOM] = v2.y;
                bbox[BOXTOP] = v1.y;
            }
            let mut s0 = rd16(lines_l, o + 10) as i32;
            let mut s1 = rd16(lines_l, o + 12) as i32;
            if s0 >= ns {
                s0 = -1;
            }
            if s1 >= ns {
                s1 = -1;
            }
            if s0 < 0 {
                s0 = 0; // malformed one-sided-without-front: use side 0
            }
            let mut flags = rd16(lines_l, o + 4) as i32 & 0xffff;
            if s1 < 0 {
                flags &= !ML_TWOSIDED;
            }
            lines.push(Line {
                v1,
                v2,
                dx,
                dy,
                flags,
                special: rd16(lines_l, o + 6) as i32,
                tag: rd16(lines_l, o + 8) as i32,
                sidenum: [s0, s1],
                bbox,
                slopetype,
                frontsector: sides[s0 as usize].sector,
                backsector: if s1 >= 0 { sides[s1 as usize].sector } else { -1 },
            });
        }
        if lines.is_empty() {
            return Err(-5);
        }

        // segs
        let mut segs = Vec::new();
        for i in 0..segs_l.len() / 12 {
            let o = i * 12;
            let v1 = vertexes[(rd16(segs_l, o) as u16 as usize).min(vertexes.len() - 1)];
            let v2 = vertexes[(rd16(segs_l, o + 2) as u16 as usize).min(vertexes.len() - 1)];
            let ld = (rd16(segs_l, o + 6) as u16 as i32).min(lines.len() as i32 - 1);
            let side = (rd16(segs_l, o + 8) as i32) & 1;
            let line = &lines[ld as usize];
            let sd = if line.sidenum[side as usize] >= 0 { line.sidenum[side as usize] } else { line.sidenum[0] };
            let frontsector = sides[sd as usize].sector;
            let backsector = if line.flags & ML_TWOSIDED != 0 {
                let bs = line.sidenum[(side ^ 1) as usize];
                if bs >= 0 { sides[bs as usize].sector } else { -1 }
            } else {
                -1
            };
            segs.push(Seg { v1, v2, linedef: ld, side, frontsector, backsector });
        }
        // subsectors
        let mut subsectors = Vec::new();
        for i in 0..ss_l.len() / 4 {
            let numlines = rd16(ss_l, i * 4) as u16 as i32;
            let firstline = rd16(ss_l, i * 4 + 2) as u16 as i32;
            if firstline as usize >= segs.len() {
                return Err(-6);
            }
            let sector = segs[firstline as usize].frontsector;
            subsectors.push(Subsector { sector, numlines, firstline });
        }
        if subsectors.is_empty() {
            return Err(-6);
        }
        // nodes
        let mut nodes = Vec::new();
        for i in 0..nodes_l.len() / 28 {
            let o = i * 28;
            let mut bbox = [[0; 4]; 2];
            for j in 0..2 {
                for k in 0..4 {
                    bbox[j][k] = (rd16(nodes_l, o + 8 + j * 8 + k * 2) as i32) << FRACBITS;
                }
            }
            nodes.push(Node {
                x: (rd16(nodes_l, o) as i32) << FRACBITS,
                y: (rd16(nodes_l, o + 2) as i32) << FRACBITS,
                dx: (rd16(nodes_l, o + 4) as i32) << FRACBITS,
                dy: (rd16(nodes_l, o + 6) as i32) << FRACBITS,
                bbox,
                children: [rd16(nodes_l, o + 24) as u16 as u32, rd16(nodes_l, o + 26) as u16 as u32],
            });
        }
        // things
        let things: Vec<MapThing> = (0..things_l.len() / 10)
            .map(|i| {
                let o = i * 10;
                MapThing { x: rd16(things_l, o), y: rd16(things_l, o + 2), angle: rd16(things_l, o + 4), type_: rd16(things_l, o + 6), options: rd16(things_l, o + 8) }
            })
            .collect();
        // blockmap
        if bmap_l.len() < 8 {
            return Err(-7);
        }
        let blockmaplump: Vec<i16> = (0..bmap_l.len() / 2).map(|i| rd16(bmap_l, i * 2)).collect();
        let bmaporgx = (blockmaplump[0] as i32) << FRACBITS;
        let bmaporgy = (blockmaplump[1] as i32) << FRACBITS;
        let bmapwidth = blockmaplump[2] as i32;
        let bmapheight = blockmaplump[3] as i32;
        if bmapwidth <= 0 || bmapheight <= 0 || 4 + (bmapwidth * bmapheight) as usize > blockmaplump.len() {
            return Err(-7);
        }
        let mut blocklines = Vec::with_capacity((bmapwidth * bmapheight) as usize);
        for b in 0..(bmapwidth * bmapheight) as usize {
            let mut off = blockmaplump[4 + b] as u16 as usize;
            let mut v = Vec::new();
            while off < blockmaplump.len() {
                let l = blockmaplump[off];
                if l == -1 {
                    break;
                }
                let li = l as u16 as usize;
                if li < lines.len() {
                    v.push(li as u32);
                }
                off += 1;
            }
            blocklines.push(v);
        }
        let numsectors = sectors.len();
        let mut reject = reject_l.to_vec();
        let need = (numsectors * numsectors).div_ceil(8);
        if reject.len() < need {
            reject.resize(need, 0);
        }

        // P_GroupLines
        for (i, li) in lines.iter().enumerate() {
            sectors[li.frontsector as usize].lines.push(i as u32);
            if li.backsector >= 0 && li.backsector != li.frontsector {
                sectors[li.backsector as usize].lines.push(i as u32);
            }
        }
        for sec in sectors.iter_mut() {
            let mut bbox = [i32::MIN, i32::MAX, i32::MAX, i32::MIN];
            for &l in &sec.lines {
                let li = &lines[l as usize];
                for v in [li.v1, li.v2] {
                    if v.x < bbox[BOXLEFT] {
                        bbox[BOXLEFT] = v.x;
                    }
                    if v.x > bbox[BOXRIGHT] {
                        bbox[BOXRIGHT] = v.x;
                    }
                    if v.y < bbox[BOXBOTTOM] {
                        bbox[BOXBOTTOM] = v.y;
                    }
                    if v.y > bbox[BOXTOP] {
                        bbox[BOXTOP] = v.y;
                    }
                }
            }
            if sec.lines.is_empty() {
                bbox = [0, 0, 0, 0];
            }
            sec.soundorg = (((bbox[BOXRIGHT] as i64 + bbox[BOXLEFT] as i64) / 2) as i32, ((bbox[BOXTOP] as i64 + bbox[BOXBOTTOM] as i64) / 2) as i32);
            let mut block = (bbox[BOXTOP].wrapping_sub(bmaporgy).wrapping_add(MAXRADIUS)) >> MAPBLOCKSHIFT;
            block = if block >= bmapheight { bmapheight - 1 } else { block };
            sec.blockbox[BOXTOP] = block;
            block = (bbox[BOXBOTTOM].wrapping_sub(bmaporgy).wrapping_sub(MAXRADIUS)) >> MAPBLOCKSHIFT;
            block = if block < 0 { 0 } else { block };
            sec.blockbox[BOXBOTTOM] = block;
            block = (bbox[BOXRIGHT].wrapping_sub(bmaporgx).wrapping_add(MAXRADIUS)) >> MAPBLOCKSHIFT;
            block = if block >= bmapwidth { bmapwidth - 1 } else { block };
            sec.blockbox[BOXRIGHT] = block;
            block = (bbox[BOXLEFT].wrapping_sub(bmaporgx).wrapping_sub(MAXRADIUS)) >> MAPBLOCKSHIFT;
            block = if block < 0 { 0 } else { block };
            sec.blockbox[BOXLEFT] = block;
        }

        let mut map = Map {
            name,
            things,
            vertexes,
            lines,
            sides,
            sectors,
            subsectors,
            segs,
            nodes,
            blockmaplump,
            bmaporgx,
            bmaporgy,
            bmapwidth,
            bmapheight,
            blocklines,
            reject,
            texture_names,
            flat_names,
            switch_partner,
            sky_flat,
            hash,
            spawn_spots: Vec::new(),
            num_dm_starts: 0,
            nav: Default::default(),
        };
        map.nav = crate::bots::nav::Nav::build(&map);
        map.spawn_spots = crate::spots::build_spawn_spots(&map);
        map.num_dm_starts = map.things.iter().filter(|t| t.type_ == 11).count();
        Ok(map)
    }

    /// R_PointOnSide
    #[inline]
    pub fn point_on_node_side(x: Fixed, y: Fixed, node: &Node) -> usize {
        if node.dx == 0 {
            if x <= node.x {
                return (node.dy > 0) as usize;
            }
            return (node.dy < 0) as usize;
        }
        if node.dy == 0 {
            if y <= node.y {
                return (node.dx < 0) as usize;
            }
            return (node.dx > 0) as usize;
        }
        let dx = x.wrapping_sub(node.x);
        let dy = y.wrapping_sub(node.y);
        if ((node.dy ^ node.dx ^ dx ^ dy) as u32) & 0x8000_0000 != 0 {
            if ((node.dy ^ dx) as u32) & 0x8000_0000 != 0 {
                return 1;
            }
            return 0;
        }
        let left = fixed_mul(node.dy >> FRACBITS, dx);
        let right = fixed_mul(dy, node.dx >> FRACBITS);
        if right < left {
            0
        } else {
            1
        }
    }

    /// R_PointInSubsector
    pub fn point_in_subsector(&self, x: Fixed, y: Fixed) -> usize {
        if self.nodes.is_empty() {
            return 0;
        }
        let mut nodenum = (self.nodes.len() - 1) as u32;
        while nodenum & NF_SUBSECTOR == 0 {
            let node = &self.nodes[nodenum as usize];
            let side = Self::point_on_node_side(x, y, node);
            nodenum = node.children[side];
            if nodenum & NF_SUBSECTOR == 0 && nodenum as usize >= self.nodes.len() {
                return 0;
            }
        }
        let s = (nodenum & !NF_SUBSECTOR) as usize;
        if s < self.subsectors.len() {
            s
        } else {
            0
        }
    }

    #[inline]
    pub fn sector_at(&self, x: Fixed, y: Fixed) -> usize {
        self.subsectors[self.point_in_subsector(x, y)].sector as usize
    }

    pub fn sprite_names_blob() -> Vec<u8> {
        let mut v = Vec::new();
        for n in crate::info::SPRNAMES.iter() {
            v.extend_from_slice(n.as_bytes());
            v.push(0);
        }
        v
    }
}

/// Build a PWAD holding one map's lumps (marker + the 10 map lumps) out of a bigger WAD.
pub fn extract_map_pwad(wad: &[u8], mapname: &str) -> Option<Vec<u8>> {
    let lumps = wad_lumps(wad).ok()?;
    let i = lumps.iter().position(|l| l.name == mapname)?;
    let names = ["THINGS", "LINEDEFS", "SIDEDEFS", "VERTEXES", "SEGS", "SSECTORS", "NODES", "SECTORS", "REJECT", "BLOCKMAP"];
    let mut sel: Vec<(&str, &[u8])> = vec![(mapname, &[][..])];
    for n in names {
        let l = lumps[i + 1..].iter().take(12).find(|l| l.name == n)?;
        sel.push((n, l.data));
    }
    let mut data: Vec<u8> = Vec::new();
    let mut dir: Vec<u8> = Vec::new();
    let mut pos = 12u32;
    for (n, d) in &sel {
        dir.extend_from_slice(&pos.to_le_bytes());
        dir.extend_from_slice(&(d.len() as u32).to_le_bytes());
        let mut nm = [0u8; 8];
        for (k, c) in n.bytes().take(8).enumerate() {
            nm[k] = c;
        }
        dir.extend_from_slice(&nm);
        data.extend_from_slice(d);
        pos += d.len() as u32;
    }
    let mut out = Vec::new();
    out.extend_from_slice(b"PWAD");
    out.extend_from_slice(&(sel.len() as u32).to_le_bytes());
    out.extend_from_slice(&(12 + data.len() as u32).to_le_bytes());
    out.extend_from_slice(&data);
    out.extend_from_slice(&dir);
    Some(out)
}
