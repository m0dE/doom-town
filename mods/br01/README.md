# br01 — Doom Town Royale

The battle royale map the built-in `br` rooms play (DESIGN.md "Battle royale" and
"Battle royale v2"): a 16384 × 16384 valley with a town of 76 enterable buildings
(houses, shops, a church, an office block with a roof terrace, town hall, police,
hotel, school, clinic, warehouses), a factory, a freight depot, farms, a radio station
on a hill, an army base, a gas station and motel, a river with five bridges, and a
lobby island sealed off in the south-east corner.

- Things: 170 crates (9020), 81 DM starts (11), 72 lobby spots (9030), 22 buggies
  (9040), sniper rifles (9050) and grenade packs (9051), sparse ground loot.
- Source: `map.mts` re-exports `tools/maps/br01.mts` (the map DSL in
  `tools/maps/lib/`). Build: `npm run mods` → `public/mods/br01.wad`.
- Preview: `docs/maps/BR01-top.png` and `docs/maps/BR01-*.jpg`.

Credits and licence: map script by the Doom Town project (GPL-2.0-only, like the rest
of `games/doom/`); every texture and flat is Freedoom's (BSD-3-Clause,
`assets/COPYING-FREEDOOM.txt`), so the packed file's data is BSD-3-Clause.
