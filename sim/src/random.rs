// m_random.c: P_Random. Copyright (C) 1993-1996 by id Software, Inc. GPL-2.0.
use crate::gen_tables::RNDTABLE;

#[derive(Clone, Default)]
pub struct PRandom {
    pub index: u8,
}

impl PRandom {
    #[inline]
    pub fn p_random(&mut self) -> i32 {
        self.index = self.index.wrapping_add(1);
        RNDTABLE[self.index as usize] as i32
    }
}

/// Small deterministic PRNG for bot decisions (xorshift32), separate from P_Random so
/// bot thinking never perturbs the playsim's random sequence order assumptions.
#[derive(Clone, Default, Debug)]
pub struct BotRng {
    pub s: u32,
}

impl BotRng {
    pub fn new(seed: u32) -> Self {
        let mut s = seed ^ 0x9E37_79B9;
        if s == 0 {
            s = 0x1234_5678;
        }
        let mut r = BotRng { s };
        r.next();
        r.next();
        r
    }
    #[inline]
    pub fn next(&mut self) -> u32 {
        let mut x = self.s;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.s = x;
        x
    }
    /// 0..n-1
    #[inline]
    pub fn below(&mut self, n: u32) -> u32 {
        if n == 0 {
            0
        } else {
            self.next() % n
        }
    }
    /// inclusive range
    #[inline]
    pub fn range(&mut self, lo: i32, hi: i32) -> i32 {
        if hi <= lo {
            lo
        } else {
            lo + self.below((hi - lo + 1) as u32) as i32
        }
    }
    #[inline]
    pub fn chance(&mut self, num: u32, den: u32) -> bool {
        self.below(den) < num
    }
}
