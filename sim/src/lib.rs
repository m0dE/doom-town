// doomsim: deterministic Doom deathmatch playsim for Freedoom Deathmatch.
// Port of id Software's linuxdoom-1.10 playsim.
// Copyright (C) 1993-1996 by id Software, Inc.
// Copyright (C) 2026 Freedoom Deathmatch authors.
// This program is free software; you can redistribute it and/or modify it under the
// terms of the GNU General Public License version 2 (GPL-2.0) as published by the Free
// Software Foundation.
#![deny(clippy::float_arithmetic, clippy::float_cmp, clippy::cast_precision_loss)]
#![allow(clippy::too_many_arguments, clippy::needless_range_loop, clippy::collapsible_else_if, clippy::collapsible_if, clippy::type_complexity, clippy::should_implement_trait, clippy::collapsible_match)]

pub mod abi;
pub mod bots;
pub mod fixed;
mod gen_info;
mod gen_tables;
pub mod info;
pub mod inter;
pub mod map;
pub mod mapmove;
pub mod maputl;
pub mod mobj;
pub mod pspr;
pub mod random;
pub mod serialize;
pub mod sight;
pub mod specials;
pub mod spots;
pub mod tables;
pub mod user;
pub mod world;

/// bump on any change to sim behaviour or layout
pub const SIM_VERSION: u32 = 2;
