# snipers — Snipers Only Royale

A battle-royale **rules remix**: BR01's map (Doom Town, `mods/br01`) unchanged, with
crates that spill sniper rifles instead of shotguns and rocket launchers, and a storm
that closes in about three minutes. The third example of the modding guide
([docs/MODDING.md](../../../docs/MODDING.md), "Example 3: a rules remix").

- **Mode:** battle royale, 100 slots, 30 s lobby, 7-minute match limit.
- **Storm** (`rules.zone`): four stages instead of five — 30 s wait + 30 s shrink to
  50 % of the map, then 25 + 25 s to 25 %, 20 + 20 s to 10 %, 15 + 20 s to nothing;
  2, 4, 8 and 15 damage per second outside.
- **Loot** (`rules.loot`, weights in percent): the health and armor rows as in BR01,
  every other weapon row 0, **sniper 30**, grenades 8, boxes of bullets 20 (the rifle
  fires 5 bullets a shot), backpacks 4. Everyone starts with 40 bullets
  (`rules.startBullets`). Supply drops and buggies stay on.
- The ground items placed on BR01's map itself (a few shotguns and chainguns) are part
  of the map, not the loot table, so they are still there: a remix changes rules, not
  the map.

## Files

| file | what |
|---|---|
| `MODINFO.json` | everything that makes this mod different |
| `map.mts` | one line: re-exports `mods/br01/map.mts` so the pack tool builds BR01's map |
| `README.md` | this file |

Because the map lumps are identical to br01's, `mod:check` reports "reuses mod br01's
map BR01 unchanged". Reusing a map *name* with *different* geometry is an error.

## Credits and licence

Rules by the Doom Town project; the map is BR01 by the Doom Town project; textures and
flats are Freedoom's. The packed data is **BSD-3-Clause** (like Freedoom), see
[assets/COPYING-FREEDOOM.txt](../../../assets/COPYING-FREEDOOM.txt).
