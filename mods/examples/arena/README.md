# arena — Reactor Arena

A tight 16-player deathmatch around a flooded reactor core: the first example of the
modding guide ([docs/MODDING.md](../../../docs/MODDING.md), "Example 1: a deathmatch
arena").

![top-down view](../../../docs/maps/ARENA-top.png)

- **Mode:** deathmatch, 16 slots, 5-minute matches (`rules.matchSeconds: 300`).
- **Layout:** an octagonal reactor hall in the middle (rocket launcher on the core,
  a water moat, four bridges, eight pillars), four corridors to four rooms — a
  control room with a plasma gun on its mezzanine (north), an open yard with the
  super shotgun (east), a pump room with a sunken basin and the chaingun (south), a
  tower with stairs up to a balcony and the blue armor (west) — and an outer ring of
  halls linking neighbouring rooms, so there is always a second way round.
- **Things:** 16 deathmatch starts (3 per room, 1 per ring corner), 7 weapons,
  ammo next to each, health and armor spread out, lamps and barrels.
- **Art:** almost all of it is in the game's base pak already, so the packed file is
  about 80 KB.

## Files

| file | what |
|---|---|
| `MODINFO.json` | the mod's id, title, mode, map name and rules |
| `map.mts` | the map, written with the map DSL (`tools/maps/lib/`) |
| `README.md` | this file: credits and licence |

Build and check:

```bash
npm run mods                              # → public/mods/arena.wad
npm run mod:check public/mods/arena.wad
npm run dev                               # then open /?offline=1&mod=mods/arena.wad
```

## Credits and licence

Map script by the Doom Town project, released under **CC0-1.0** (public domain: copy
it, change it, ship it as your own mod). The textures and flats are Freedoom's
(BSD-3-Clause, [assets/COPYING-FREEDOOM.txt](../../../assets/COPYING-FREEDOOM.txt)).
