# Freedoom Deathmatch on ARRR — design

A 100-player Doom deathmatch that runs in a web page, built to dogfood arrr-network.
This file is the contract between the three parts (sim, renderer, shell). Change it
first, then the code.

## Licensing (read before copying anything)

- **Engine code is GPL-2.0-or-later.** The simulation is a port of id Software's
  linuxdoom-1.10 (GPL-2.0, github.com/id-Software/DOOM). Everything under
  `games/doom/` is therefore GPL-2.0-or-later (`games/doom/LICENSE`), even though the
  rest of this monorepo is MIT. Keep id's copyright notices in ported files' headers.
- **Game data is Freedoom / FreeDM 0.13.0** (BSD-3-Clause, `assets/COPYING-FREEDOOM.txt`,
  `assets/CREDITS-FREEDOOM.txt`). We never ship id's DOOM/DOOM2 WADs. A player may load
  their *own* DOOM2.WAD from disk (kept in their browser only) to get the original art;
  lump names are compatible, so this is only an art override.
- **Name.** "DOOM" is id/ZeniMax's trademark. Player-facing title: **FREEDOOM
  DEATHMATCH** (short: "Freedoom DM"). Directory and code identifiers may say `doom`.
- The published bundle carries `LICENSE.txt`, `COPYING-FREEDOOM.txt` and `source.zip`
  (the full corresponding source of this directory), linked from the menu's footer —
  that is how GPL §3(a) is met for a web build.

## Layout

```
games/doom/
  DESIGN.md              this file
  LICENSE                GPL-2.0 text
  sim/                   Rust crate `doomsim` → wasm32 (no wasm-bindgen, raw C ABI)
  assets/                freedm.wad is NOT committed; tools/fetch-freedoom.mjs pins + downloads it
  tools/                 node scripts: fetch, pak builder, export, tests
  public/                built runtime files served as-is (doomsim.wasm, freedm-lite.wad)
  src/                   TypeScript client (Vite)
    main.ts              boot: menu → game
    menu/                start screen: doomguy, room list, sign-in, name, quick play
    net/                 lockstep session (arrr-network), offline loopback
    sim/                 wasm wrapper implementing arrr-network's lockstep.Sim
    wad/                 WAD parsing, palette/colormap, patches, flats, sprites, sounds
    render/              three.js world renderer, sprites, lights, post FX, psprite
    hud/                 status bar, face, messages, killfeed, scoreboard, chat
    audio/               DMX sound playback, positional
    input/               pointer lock, keys, mouse pitch/yaw → ticcmd
```

Build: `npm run build:sim` (cargo → `public/doomsim.wasm`, committed so the client builds
without Rust), `npm run pak` (freedm.wad → `public/freedm-lite.wad`, committed),
`npm run dev`, `npm run export` (→ `export/freedm/` + zip, committed like vibe-strike).

## Game rules

- **Map:** FreeDM `MAP19` "DM19: Tech Isle" (8704×6656 units, the largest FreeDM map).
  The sim takes any map; the map name is a constant in one place (`src/sim/map.ts`).
- **Slots:** `SLOTS = 100`. Every slot is always occupied: a bot plays it unless a human
  has it. A joining human takes over a bot's slot (lowest-index bot slot); leaving gives
  it back to a bot. Frags of a slot reset when it changes hands.
- **Rules:** deathmatch 2 ("altdeath"): items and weapons are taken when picked up and
  respawn 30 s later (`P_RespawnSpecials`). No monsters (things with MF_COUNTKILL are not
  spawned). Exits do nothing. Keys are irrelevant (locked doors open for anyone).
- **Matches:** 10-minute rounds driven by the tic counter (`MATCH_TICS = 35*600`),
  then 10 s of intermission (scoreboard, everyone frozen), frags reset, everyone respawns.
  Aligned to the absolute tic so a late joiner lands on the same boundary.
- **Respawn:** a dead player respawns on attack/use after 1 s, forced after 5 s.
  Spawn point: random DM start / extra spawn point that passes `G_CheckSpot`
  (no telefrag) — the sim generates extra spawn points from the map (open floor
  spots far from walls) because 10 DM starts are not enough for 100 players.
- **Freelook + jump:** pitch is part of the input; hitscan and projectiles use the
  pitch slope (no vertical autoaim). Jump: `momz = 8*FRACUNIT` when on the ground,
  then Doom gravity. Max pitch ±(ANG90 * 0.9) is clamped in the sim.
- **Tic rate:** the app runs its rooms at **35 Hz** (Doom's TICRATE): one network frame
  = one Doom tic. If a node reports a different rate, `ticsPerFrame = max(1, round(35/fps))`
  sim tics run per frame (offline loopback runs at 35).

## Determinism

The sim is Rust compiled to one wasm binary every client runs, using Doom's 16.16
fixed point (`i32`), BAM angles (`u32`), Doom's `finesine`/`finetangent`/`tantoangle`
tables and its `rndtable`. **No floats in the sim at all** (enforce with
`#![deny(clippy::float_arithmetic)]` in sim code). Iteration order is creation order.
`world_hash` and `world_serialize` cover the whole state; `deserialize(serialize(w))`
must step bit-identically to `w`.

## The wasm ABI (`sim/src/abi.rs`) — the only interface between Rust and TS

All exports are `extern "C"`, `#[no_mangle]`. Integers are i32/u32 unless noted.
Pointers are offsets into the wasm memory. Little-endian throughout.

```
// memory
alloc(len) -> ptr                      scratch allocation for passing bytes in
dealloc(ptr, len)

// static data, once per page
map_load(wad_ptr, wad_len) -> i32      a PWAD holding exactly one map's lumps
                                       (MAPxx marker + THINGS LINEDEFS SIDEDEFS VERTEXES
                                       SEGS SSECTORS NODES SECTORS REJECT BLOCKMAP).
                                       Returns map id >= 0, or a negative error code.
sim_sprite_names() -> ptr              NUL-separated sprite names, Doom's sprnames order
sim_sound_names() -> ptr               NUL-separated sound names, Doom's S_sfx order ("" for 0)
sim_version() -> u32                   bump on any change to sim behaviour or layout

// worlds (a world is one full game state; several coexist: confirmed + predicted)
world_new(map_id, seed, slots) -> h    h > 0. Spawns map things and `slots` bots.
world_free(h)
world_clone(h) -> h2                   exact copy (fast path for prediction)
world_serialize(h) -> len              bytes are at world_buf_ptr() until the next call
world_buf_ptr() -> ptr
world_deserialize(map_id, ptr, len) -> h   0 on bad data
world_hash(h) -> u32
world_tic(h) -> u32                    tics simulated since world_new

// membership — pure functions of the ordered stream
world_human_join(h, slot)              slot becomes human-driven (bot removed, frags reset,
                                       respawns fresh). Idempotent.
world_human_leave(h, slot)             slot goes back to a bot (frags reset). Idempotent.
world_human_idle(h, slot)              disconnected but still a member: a bot drives the
                                       body, frags kept, until join/leave.
world_free_slot(h) -> i32              lowest bot-driven slot, -1 if none (who a join takes)

// input — last command wins; held until replaced
world_set_cmd(h, slot, angle_hi16, pitch, forward, side, buttons)
    angle_hi16: u32 0..65535, yaw = angle_hi16 << 16 (BAM)
    pitch:      i32, BAM>>16 signed (-32768..32767 = -180°..180°), sim clamps
    forward:    i32 -50..50 (Doom forwardmove units; run = 50, walk = 25)
    side:       i32 -40..40 (sidemove units; run = 40, walk = 24)
    buttons:    bit0 attack, bit1 use, bit2 jump, bits 4..7 weapon select (0 = none,
                1..9 = slot like Doom's number keys: 1 fist/chainsaw toggle, 3 shotgun/SSG
                toggle), bit8 next weapon, bit9 prev weapon
world_tick(h)                          advance one tic

// reading a world — each returns a pointer to a buffer valid until the next call on h
world_view_mobjs(h) -> ptr             u32 count, then count × MobjView (12 × u32 = 48 bytes)
world_view_player(h, slot) -> ptr      PlayerView (below)
world_view_players(h) -> ptr           u32 count(=slots), then count × PlayerRow (8 × i32)
world_view_sectors(h) -> ptr           u32 count, then count × (floor fixed i32, ceil fixed i32,
                                       light i32, floorpic i32, ceilpic i32) — current values
world_view_lines(h) -> ptr             u32 count, then count × (top i32, mid i32, bottom i32)
                                       current side-0 texture numbers (switches change them);
                                       numbers index the map's texture name table:
world_map_texture_names(map_id) -> ptr NUL-separated texture names (index 0 = "-")
world_map_flat_names(map_id) -> ptr    NUL-separated flat names
world_events(h) -> ptr                 events emitted by the LAST world_tick only:
                                       u32 count, then count × Event (8 × i32 = 32 bytes)
```

`MobjView` (12 × u32):

| # | field | notes |
|---|---|---|
| 0 | id | stable for the mobj's life, never reused within a world |
| 1 | x | fixed |
| 2 | y | fixed |
| 3 | z | fixed |
| 4 | angle | BAM |
| 5 | sprite \| frame<<16 | frame keeps FF_FULLBRIGHT (0x8000) |
| 6 | flags | Doom MF_* bits (MF_SHADOW = invisibility fuzz) |
| 7 | type \| (slot+1)<<16 | mobjtype_t index; slot+1 for player bodies, 0 otherwise |
| 8 | radius | fixed |
| 9 | height | fixed |
| 10 | momx | fixed — projectiles are extrapolated along it |
| 11 | momy | fixed (momz is not exported; projectiles' z comes from the ring) |

`PlayerView` (i32 words):

```
0 slot  1 mobj id (0 if none)  2 playerstate (0 live,1 dead,2 reborn)
3 x  4 y  5 z  6 viewz  7 angle  8 pitch (BAM)
9 health  10 armorpoints  11 armortype
12 readyweapon  13 pendingweapon  14 weaponowned bitmask (bit i = weapontype i)
15..18 ammo[4]  19..22 maxammo[4]
23..28 powers[6] (tics remaining; invuln, strength, invis, ironfeet, allmap, infrared)
29 damagecount  30 bonuscount  31 extralight  32 fixedcolormap
33 frags (total kills of others)  34 deaths  35 attacker slot+1 (who hurt us last; 0 none)
36 psprite weapon: sprite | frame<<16 (-1 if none)  37 sx fixed  38 sy fixed
39 psprite flash: sprite | frame<<16 (-1 if none)   40 sx  41 sy
42 is_human  43 respawn_ready (dead long enough to respawn)
44 match tic (tics into the current match)  45 match phase (0 play, 1 intermission)
46 onground  47 refire
```

`PlayerRow` (8 × i32): `slot, is_human, mobj id, frags, deaths, health, state, color`.

`Event` (8 × i32): `kind, a, b, c, x, y, z, d`

| kind | meaning | a | b | c | d |
|---|---|---|---|---|---|
| 1 | sound | sfx id | origin mobj id (0 = at x,y,z) | volume 0..127 | slot+1 if a player's own (weapon) sound |
| 2 | obituary | victim slot | killer slot (-1 world) | mod (weapon/means) | 0 |
| 3 | pickup | slot | mobj type picked | message id | 0 |
| 4 | damage | victim slot | attacker slot (-1) | amount | 0 |
| 5 | spawn (respawn/teleport fog) | slot or -1 | — | — | — |
| 6 | line switch texture changed | line index | — | — | — |
| 7 | match start | — | — | — | — |
| 8 | match end | winner slot | — | — | — |

Means of death `mod`: 0 world, 1 fist, 2 pistol, 3 shotgun, 4 chaingun, 5 rocket, 6 plasma,
7 BFG, 8 chainsaw, 9 SSG, 10 telefrag, 11 slime, 12 crush, 13 splash (rocket),
14 berserk fist, 15 fall/other.

## TS side contracts

- `src/sim/doomsim.ts` loads the wasm (instantiateStreaming, started from the menu so it
  is ready before Play), wraps the ABI, and implements `lockstep.Sim` from arrr-network.
  The TS state is `{ h: number, ids: string[] /* slot → player id or '' */, names }`;
  `serialize` = `{ w: base64(world bytes), ids }`; `hash` mixes `world_hash` with the
  slot table. `dispose` calls `world_free`.
- Input payload on the wire: `{ c: [angle_hi16, pitch, forward, side, buttons] }`.
  Anything without `c` is not gameplay (app messages: `{ n: name, col: color }`, chat
  `{ say: text }`, ping reports) and is ignored by the sim.
- Rendering follows `harness/INTEGRATION.md`: everything drawn comes off `lockstep.view()`;
  remote mobjs from a ring of confirmed `MobjView`s at `frame + alpha`, the local player
  from the predicted ring at `selfAlpha`. Projectiles extrapolate along momx/momy.
- The renderer is fed a `RenderFrame` (`src/render/types.ts`) by the game loop:
  interpolated mobjs, sector heights/light, line textures, camera (x, y, z, yaw, pitch),
  psprites, and the event list for effects. It never touches the sim.

## Netcode numbers

- 35 Hz, inputs ~30 bytes. 100 humans would be ~100 KB/s down per client; bots cost
  nothing on the wire (they run inside every client's sim).
- Snapshots every 35 × 10 tics.
- Prediction: whole-world, via `world_clone`.
