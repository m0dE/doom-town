// Fixed point arithmetic and angles (m_fixed.c, tables.h, r_main.c R_PointToAngle).
// Copyright (C) 1993-1996 by id Software, Inc.
// Port: Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.

use crate::gen_tables::{FINESINE, FINETANGENT, TANTOANGLE};

pub type Fixed = i32;
pub type Angle = u32;

pub const FRACBITS: i32 = 16;
pub const FRACUNIT: Fixed = 1 << FRACBITS;

pub const ANG45: Angle = 0x2000_0000;
pub const ANG90: Angle = 0x4000_0000;
pub const ANG180: Angle = 0x8000_0000;
pub const ANG270: Angle = 0xc000_0000;
pub const ANGLETOFINESHIFT: u32 = 19;
pub const FINEANGLES: usize = 8192;
pub const FINEMASK: usize = FINEANGLES - 1;
pub const SLOPERANGE: u32 = 2048;
pub const DBITS: i32 = FRACBITS - 11;

#[inline]
pub fn fixed_mul(a: Fixed, b: Fixed) -> Fixed {
    ((a as i64 * b as i64) >> FRACBITS) as i32
}

#[inline]
pub fn fixed_div(a: Fixed, b: Fixed) -> Fixed {
    if (a.wrapping_abs() >> 14) >= b.wrapping_abs() {
        return if (a ^ b) < 0 { i32::MIN } else { i32::MAX };
    }
    if b == 0 {
        return if a < 0 { i32::MIN } else { i32::MAX };
    }
    let c = ((a as i64) << FRACBITS) / b as i64;
    if c > i32::MAX as i64 {
        i32::MAX
    } else if c < i32::MIN as i64 {
        i32::MIN
    } else {
        c as i32
    }
}

#[inline]
pub fn finesine(i: usize) -> Fixed {
    FINESINE[i & FINEMASK]
}
#[inline]
pub fn finecosine(i: usize) -> Fixed {
    FINESINE[(i & FINEMASK) + FINEANGLES / 4]
}
#[inline]
pub fn finetangent(i: usize) -> Fixed {
    FINETANGENT[i & 4095]
}
#[inline]
pub fn fine(a: Angle) -> usize {
    (a >> ANGLETOFINESHIFT) as usize
}

#[inline]
pub fn slope_div(num: u32, den: u32) -> usize {
    if den < 512 {
        return SLOPERANGE as usize;
    }
    let ans = (num.wrapping_shl(3)) / (den >> 8);
    if ans <= SLOPERANGE {
        ans as usize
    } else {
        SLOPERANGE as usize
    }
}

/// R_PointToAngle2: angle of the vector (x2-x1, y2-y1).
pub fn point_to_angle2(x1: Fixed, y1: Fixed, x2: Fixed, y2: Fixed) -> Angle {
    point_to_angle(x2.wrapping_sub(x1), y2.wrapping_sub(y1))
}

pub fn point_to_angle(mut x: Fixed, mut y: Fixed) -> Angle {
    if x == 0 && y == 0 {
        return 0;
    }
    if x >= 0 {
        if y >= 0 {
            if x > y {
                TANTOANGLE[slope_div(y as u32, x as u32)]
            } else {
                ANG90.wrapping_sub(1).wrapping_sub(TANTOANGLE[slope_div(x as u32, y as u32)])
            }
        } else {
            y = y.wrapping_neg();
            if x > y {
                0u32.wrapping_sub(TANTOANGLE[slope_div(y as u32, x as u32)])
            } else {
                ANG270.wrapping_add(TANTOANGLE[slope_div(x as u32, y as u32)])
            }
        }
    } else {
        x = x.wrapping_neg();
        if y >= 0 {
            if x > y {
                ANG180.wrapping_sub(1).wrapping_sub(TANTOANGLE[slope_div(y as u32, x as u32)])
            } else {
                ANG90.wrapping_add(TANTOANGLE[slope_div(x as u32, y as u32)])
            }
        } else {
            y = y.wrapping_neg();
            if x > y {
                ANG180.wrapping_add(TANTOANGLE[slope_div(y as u32, x as u32)])
            } else {
                ANG270.wrapping_sub(1).wrapping_sub(TANTOANGLE[slope_div(x as u32, y as u32)])
            }
        }
    }
}

/// P_AproxDistance
#[inline]
pub fn aprox_distance(dx: Fixed, dy: Fixed) -> Fixed {
    let dx = dx.wrapping_abs();
    let dy = dy.wrapping_abs();
    if dx < dy {
        dx.wrapping_add(dy).wrapping_sub(dx >> 1)
    } else {
        dx.wrapping_add(dy).wrapping_sub(dy >> 1)
    }
}

/// Integer square root (floor) of a non-negative i64.
pub fn isqrt(n: i64) -> i64 {
    if n <= 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

/// Tangent (16.16 slope) of a signed BAM pitch in (-ANG90, ANG90).
pub fn pitch_slope(pitch: i32) -> Fixed {
    // finetangent[i] is sampled at the middle of fine angle i; average the two samples
    // around the pitch so that pitch 0 gives exactly 0 (a level shot, as in vanilla)
    let a = (pitch as u32).wrapping_add(ANG90);
    let i = ((a >> ANGLETOFINESHIFT) as usize).clamp(1, 4095);
    ((finetangent(i) as i64 + finetangent(i - 1) as i64) / 2) as i32
}
