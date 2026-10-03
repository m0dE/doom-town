# Doom Town on ARRR — design

A 64-player Doom deathmatch that runs in a web page, built to dogfood arrr-network.
This file is the contract between the three parts (sim, renderer, shell). Change it
first, then the code.

## Licensing (read before copying anything)

- **Engine code is GPL-2.0.** The simulation is a port of id Software's
  linuxdoom-1.10, "Licensed under the GNU General Public License 2.0" with no "or any
  later version" (github.com/id-Software/DOOM README.TXT). Everything under
  `games/doom/` is therefore distributed under GPL-2.0 (`games/doom/LICENSE`), even
  though the rest of this monorepo is MIT. GPL-3-only material (GZDoom/UZDoom files)
  cannot be combined with it. Keep id's copyright notices in ported files' headers.
- **Game data is Freedoom / FreeDM 0.13.0** (BSD-3-Clause, `assets/COPYING-FREEDOOM.txt`,
  `assets/CREDITS-FREEDOOM.txt`). We never ship id's DOOM/DOOM2 WADs. A player may load
  their *own* DOOM2.WAD from disk (kept in their browser only) to get the original art;
  lump names are compatible, so this is only an art override.
- No GZDoom/UZDoom-derived material: id's source is GPL-2.0-only, which is incompatible with their GPL-3 files.
- **Name.** Player-facing title: **DOOM TOWN** (the user's choice, 2026-10-03; repo
  github.com/m0dE/doom-town). "DOOM" is id/ZeniMax's trademark: never use id's logo
  artwork, keep "Game art: Freedoom" visible, and the README carries the
  not-affiliated line. Directory and code identifiers may say `doom`.
- The published bundle carries `LICENSE.txt`, `COPYING-FREEDOOM.txt` and `source.zip`
  (the full corresponding source of this directory), linked from the menu's footer —
  that is how GPL §3(a) is met for a web build.

## Layout

```
games/doom/
  DESIGN.md              this file
  LICENSE                GPL-2.0 text (id's own LICENSE.TXT)
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
`npm run dev`, `npm run export` (→ `export/doom-town/` + zip; build output, gitignored — 30 MB per rebuild is too much history).

## Game rules

- **Map:** FreeDM `MAP19` "DM19: Tech Isle" (8704×6656 units, the largest FreeDM map).
  The sim takes any map; the map name is a constant in one place (`src/sim/map.ts`).
- **Slots:** `SLOTS = 64` (was 100; the user capped it at 64 on 2026-10-03). Every slot is always occupied: a bot plays it unless a human
  has it. A joining human takes over a bot's slot (lowest-index bot slot); leaving gives
  it back to a bot. Frags of a slot reset when it changes hands.
- **Rules:** weapons stay (deathmatch 1's rule): a weapon on the map is never removed
  when picked up, so the map always shows every weapon; a player who already owns that
  weapon cannot take it again (vanilla `P_GiveWeapon` with `deathmatch == 1`, ammo
  included). Everything else (ammo, health, armor, powerups, backpacks) is taken and
  respawns 30 s later (`P_RespawnSpecials`). Weapons a dead player drops are not a
  thing in vanilla and stay out. No monsters (things with MF_COUNTKILL are not
  spawned). Exits do nothing. Keys are irrelevant (locked doors open for anyone).
- **Matches:** 10-minute rounds driven by the tic counter (`MATCH_TICS = 35*600`),
  then 10 s of intermission (scoreboard, everyone frozen), frags reset, everyone respawns.
  Aligned to the absolute tic so a late joiner lands on the same boundary.
- **Respawn:** a dead player respawns on attack/use after 1 s, forced after 5 s.
  Spawn point: random DM start / extra spawn point that passes `G_CheckSpot`
  (no telefrag) — the sim generates extra spawn points from the map (open floor
  spots far from walls) because 10 DM starts are not enough for 64 players.
- **Freelook + jump:** pitch is part of the input; hitscan and projectiles use the
  pitch slope (no vertical autoaim). Jump: `momz = 8*FRACUNIT` when on the ground,
  then Doom gravity. Max pitch ±(ANG90 * 0.9) is clamped in the sim.
- **Tic rate:** the app runs its rooms at **35 Hz** (Doom's TICRATE): one network frame
  = one Doom tic. If a node reports a different rate, `ticsPerFrame = max(1, round(35/fps))`
  sim tics run per frame (offline loopback runs at 35).

## Modes, teams and map rotation (v2 — requested 2026-10-03)

The user asked for more maps, team modes "like Counter-Strike", 100 vs 100 war maps,
and deathmatch maps that restart after a set time so scores reset. A room's **mode is a
pure function of its room name** (`src/menu/modes.ts`), so every client builds the same
world config without asking anyone.

| mode | id | slots | teams | rules |
|---|---|---|---|---|
| Deathmatch | 0 | 64 | – | as above; 10-min match, 10 s scoreboard, next map in rotation |
| Team Deathmatch | 1 | 64 (32v32) | red/blue | team frags; no friendly fire (self-damage stays); 10-min match, next map |
| Elimination (CS-style) | 2 | 24 (12v12) | red/blue | rounds of ≤ 2:30 with 5 s freeze at the start; no respawn inside a round (the dead spectate); a team wiped out or the team with more alive at time-out loses the round (tie = draw); every round everyone restarts at full health with pistol + shotgun + 50 shells; map weapons stay as usual; first to 7 rounds wins the match, then next map |
| War (conquest) | 3 | 200 (100v100) | red/blue | massive maps with 5 capture points; standing in a point's radius with more teammates than enemies captures it over 10 s (faster with more); each team starts with 3000 tickets (600 drained in ~2 min with 200 bots, measured), loses 1 per death and 1 every 5 s while holding fewer points than the enemy; 0 tickets or 20 min ends the match; respawn wave every 10 s at your team's base or at any point your team owns (the player picks with weapon-select keys while dead; bots choose the point nearest the front) |

- **Teams:** slot `s` is on team `s % 2` (0 red, 1 blue) — a human taking a bot slot
  keeps the team, so teams stay balanced by construction. Team colors override the
  player's chosen color (red/blue translation; the player's own color is kept as a
  shade within the team ramp only if cheap, otherwise plain team colors).
- **Team spawns:** FreeDM maps have no team starts. At map load the sim splits the map's
  spawn points into two sides deterministically (the two most distant DM starts seed a
  2-means clustering over all spawn points; side 0 = red). Generated war maps carry
  explicit team starts (thing types 9000 red / 9001 blue) and capture points
  (thing type 9010, angle field = radius/8).
- **Rotation:** each mode has an ordered map list; match `k` (counted from tic 0 of the
  room's world, so late joiners agree) plays `maps[k % n]`. When the intermission ends
  the world switches map in place: mobjs/specials are rebuilt from the new map's things,
  every player respawns, scores reset. `world_view_match` exposes the current and the
  next map so the client can prepare the next map's visuals during the match.
  - Deathmatch / TDM: FreeDM MAP19 Tech Isle, MAP24 Flooded Base, MAP20 Warehouse,
    MAP30, MAP27, MAP32 (the largest FreeDM maps).
  - Elimination: medium FreeDM maps with good two-sided layouts (MAP01, MAP11, MAP18,
    MAP20 — the map agent picks and documents the final list).
  - War: generated maps `WAR01`.. built by `tools/maps/` (see below).
- **Map data delivery:** map lumps of every map in every rotation ship in the base pak
  (they are small and the sim must never wait for a download). Map *art* (textures,
  flats) can ship per map (`public/maps/<MAP>.wad`), fetched for the current map at
  join and the next map during the match; the renderer shows the new map when its art
  is in, never blocking the sim.
- **War maps** (`tools/maps/`): authored in a small TypeScript map DSL (rooms, outdoor
  areas, bridges, bunkers, ramps, water/nukage, sky), compiled to a vanilla-format PWAD
  with our own node builder (NODES/SEGS/SSECTORS) — BLOCKMAP and REJECT optional: the
  sim builds its own blockmap at load when the lump is missing or would overflow, and
  treats a missing REJECT as "no rejection". Size: up to ~24k × 24k units (WAD
  coordinates are i16). Freedoom textures only; must look good (lighting variety,
  detail, landmarks) and be navigable by bots.

### Random bosses (requested 2026-10-03)

The user: "in some of the maps, can we throw in random boss demons and when it dies it drops
BFG (spider or cyberdemon)" and "it should clearly indicate on room name saying random bosses".

- A **room modifier**, not a mode: Deathmatch and Team Deathmatch rooms can have it. Boss
  rooms are their own rows in the server list, named so it's obvious, e.g.
  `na-1 · Random bosses` (room id `na-boss-1`; `src/menu/modes.ts` parses it).
  Elimination and War rooms don't get bosses.
- **Spawning:** 60 s into every match, and then 90 s after the previous boss dies, a boss
  appears at a spot chosen deterministically (`P_Random` / sim rng) among spawn points
  that pass `P_CheckPosition` for its size and are at least 1024 units from every live
  player. Cyberdemon or Spider Mastermind, 50/50. One boss alive at a time; an alive boss
  is removed at the match end.
- **Behaviour:** vanilla monster AI ported from p_enemy.c for these two (A_Look, A_Chase,
  A_FaceTarget, P_Move/P_NewChaseDir, A_CyberAttack rockets, A_SpidRefire/A_SPosAttack
  chaingun, A_Hoof/A_Metal/A_BabyMetal sounds, pain/death states) — targets the
  nearest visible player, retargets when hurt by someone else (vanilla infighting rule for
  players). Health scaled for crowds: vanilla × (1 + live players / 16), capped at ×3 (×5 took 2–3 min for 64 bots to kill, measured).
- **Reward:** on death it drops a BFG 9000 (MF_DROPPED: taken by the first player who
  touches it, never respawns — unlike map weapons) plus a cell pack, at the death spot.
  The killer gets +5 frags (TDM: the team gets +5). Bots treat a live boss as a target
  of opportunity and race for a dropped BFG.
- **Config/ABI:** `world_new_cfg` gets an optional word after the seed: `flags`
  (bit0 = random bosses). `world_view_match` appends: boss mobj id (0 none), boss type
  (mobjtype), boss health, boss max health, tics until the next boss (−1 none).
  Events: 14 boss spawned (a = mobjtype, x/y/z), 15 boss killed (a = mobjtype,
  b = killer slot, −1 none).
- **Client:** room row badge "Random bosses"; on spawn a big banner ("A CYBERDEMON HAS
  ENTERED THE TOWN") + its sight sound map-wide; a boss health bar at the top while one
  lives; killfeed line on death ("Gibsy slew the Spider Mastermind — BFG dropped!").
  The CYBR/SPID sprites and DSCYB*/DSSPI*/DSHOOF/DSMETAL sounds ship in the base pak
  (FreeDM has them).

### ABI additions (v2)

```
world_new_cfg(cfg_ptr, cfg_len) -> h      replaces world_new for new code (world_new stays = FFA MAP-only)
    cfg = u32 words: [version=2, mode, slots, match_tics, intermission_tics,
                      round_tics, freeze_tics, rounds_to_win, tickets, friendly_fire(0/1),
                      map_count, map_id × map_count]
    (0 in a timing field = the mode's default from the table above)
world_view_match(h) -> ptr                i32 words:
    0 mode  1 phase (0 play, 1 round freeze, 2 round over, 3 intermission)
    2 tics left in this phase  3 match index  4 current map id  5 next map id
    6 team score red  7 team score blue  (frags / rounds won / tickets)
    8 round number  9 alive red  10 alive blue  11 winner (-1 none, 0/1 team, slot for FFA)
    12 point count, then per point 6 words: x, y (fixed), radius (fixed), owner (-1/0/1),
       capture progress (-100..100, + toward blue), contesting flags
world_view_players: PlayerRow gains a team word → 9 × i32: slot, is_human, mobj id,
    frags, deaths, health, state, color, team (-1 none)
PlayerView: 48 team, 49 can_respawn_at bitmask (war), 50 spectating slot (-1 none)
world_deserialize(ptr, len) no longer needs a map id: the snapshot records which map
    (by the map's name + content hash) and resolves it against loaded maps (0 if absent)
Events: 9 map change (a = new map id), 10 round start (a = round), 11 round end
    (a = winning team, -1 draw), 12 point captured (a = point, b = team),
    13 tickets low (a = team)
Buttons while dead in war: weapon-select bits pick the spawn (1 = base, 2.. = points).
```

As implemented (sim_version 3):

- `world_new_cfg`: an optional word after the map ids is the seed (default 0). Teams in
  every mode but FFA; team colors are Doom translations 3 (red) and 1 (indigo/blue).
  Returns 0 if the version word is not 2, a map id is unknown, or the length is short.
- `world_deserialize(ptr, len)` resolves the snapshot's rotation against every map_load'ed
  map (name + content hash). `world_deserialize_map(map_id, ptr, len)` is the old
  three-argument form kept for old callers (the map id is ignored). Last-tic events
  are not part of a snapshot (they carry local map ids); a deserialized world reports no
  events until it ticks.
- Event fields: 7 match start (a = match index, b = mode); 8 match end (a = winner: slot
  in FFA, team in the team modes, -1 draw; b = winner's frags / team score; c = match
  index); 9 map change (a = new map id, b = rotation index, c = match index); 10 round
  start (a = round); 11 round end (a = winning team or -1, b = round, c = red rounds,
  d = blue rounds); 12 point captured (a = point, b = team, x/y = point); 13 tickets low
  (a = team, b = tickets left, sent once per match at <= 100).
- `world_view_match` capture progress is -100 (red) .. 100 (blue); the flags word is
  bit 0 red inside, bit 1 blue inside. Capturing: progress moves by min(4, majority) per
  tic (10 s alone from neutral), a point turns neutral when progress crosses 0 against
  its owner. Phase 2 (round over) lasts 3 s; the freeze phase lets players look but not
  move, fire, use or jump.
- PlayerView is 51 words (48 team, 49 respawn mask: bit 0 base, bit 1+i point i;
  50 spectated slot, elimination only; attack cycles it). PlayerView[44] is the match
  tic, [45] is 1 during the intermission only.
- War respawn waves run every 10 s of match time for players dead >= 1 s; the
  weapon-select nibble while dead picks base (1) or point (n-2). Elimination: a player
  who joins mid-round waits for the next round.
- Map loading: BLOCKMAP is rebuilt by the sim when missing, past 128 KB (u16 offsets),
  or not covering every vertex; REJECT may be missing. Things 9000/9001 are team spawn
  spots, 9010 capture points (angle = radius / 8, default 192). FreeDM maps get five
  generated points (middle of the two bases, then spread out).
- Random bosses (sim_version 5): the `flags` word follows the seed in `world_new_cfg`
  (so a flags word needs a seed word before it). `world_view_match` appends the 5 boss
  words after the capture points (offset 13 + 6 × point count). Placement scans the spawn
  spots from a P_Random start for one that fits the boss (ceiling, walls, things) and is
  >= 1024 units from every live player, retrying each second; after 5 failed seconds
  (crowded maps — common on MAP19 with 64 players) it takes the fitting spot farthest from
  the nearest player. If the rolled boss fits nowhere the other one is tried. A spawned
  boss starts chasing the nearest player. Obituary events of players killed by a monster
  carry the monster's mobjtype in `d` (killer slot -1); such deaths cost no frag (vanilla).
  Event 15 x/y = the death spot (= the dropped BFG's position; a pickup event of that BFG
  has the same x/y). The dropped BFG gives the weapon + 1 clip of cells and is removed;
  the cell pack is a normal (dropped) pickup.

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
                                       (every name list: each name NUL-terminated, then one
                                       extra NUL; an empty name after the first ends the list)
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
    pitch:      i32, BAM>>16 signed (-32768..32767 = -180°..180°), sim clamps;
                positive = looking up
    The body's angle is (angle_hi16 << 16) + a per-player yaw offset that the sim sets
    when it turns the body itself (spawn facing, teleport exit, punch/chainsaw pull), so
    absolute mouse yaw keeps working: PlayerView[7] is the effective angle.
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
33 frags (kills of others minus suicides/world deaths, vanilla scoring)  34 deaths  35 attacker slot+1 (who hurt us last; 0 none)
36 psprite weapon: sprite | frame<<16 (-1 if none)  37 sx fixed  38 sy fixed
39 psprite flash: sprite | frame<<16 (-1 if none)   40 sx  41 sy
42 is_human (0 bot, 1 human, 2 idle member driven by a bot)  43 respawn_ready (dead long enough to respawn)
44 match tic (tics into the current match)  45 match phase (0 play, 1 intermission)
46 onground  47 refire
```

`PlayerRow` (8 × i32): `slot, is_human, mobj id, frags, deaths, health, state, color`
(`is_human` as in PlayerView[42]; `color` = slot & 3, Doom's green/indigo/brown/red
translation, also in the body's MF_TRANSLATION flag bits).

`Event` (8 × i32): `kind, a, b, c, x, y, z, d`

| kind | meaning | a | b | c | d |
|---|---|---|---|---|---|
| 1 | sound | sfx id | origin mobj id (0 = at x,y,z) | volume 0..127 | slot+1 if a player's own (weapon) sound |
| 2 | obituary | victim slot | killer slot (-1 world; = victim for suicide) | mod (weapon/means) | 0 |
| 3 | pickup | slot | mobj type picked | message id | sfx id to play for that player only |
| 4 | damage | victim slot | attacker slot (-1) | amount (after armor) | 0 |
| 5 | spawn (respawn/teleport fog) | slot | 0 respawn, 1 teleport | — | — |
| 6 | line switch texture changed | line index | — | — | — |
| 7 | match start | — | — | — | — |
| 8 | match end | winner slot | winner frags | — | — |

x, y, z (fixed) are the sound origin (kind 1), the item (3), the victim (4) and the
spawn/teleport destination (5); 0 otherwise. Sector sounds (doors, lifts, switches) are
kind 1 with origin 0 at the sector's sound origin.

Pickup message ids: 1 armor, 2 megaarmor, 3 health bonus, 4 armor bonus, 5 soulsphere,
6 megasphere, 7 stimpack, 8 medikit (needed), 9 medikit, 10 invulnerability, 11 berserk,
12 invisibility, 13 radiation suit, 14 computer map, 15 light amp, 16 clip, 17 box of
bullets, 18 rocket, 19 box of rockets, 20 cell, 21 cell pack, 22 shells, 23 box of
shells, 24 backpack, 25 BFG9000, 26 chaingun, 27 chainsaw, 28 rocket launcher,
29 plasma gun, 30 shotgun, 31 super shotgun.

Means of death `mod`: 0 world, 1 fist, 2 pistol, 3 shotgun, 4 chaingun, 5 rocket, 6 plasma,
7 BFG, 8 chainsaw, 9 SSG, 10 telefrag, 11 slime, 12 crush, 13 splash (rocket),
14 berserk fist, 15 fall/other.

### Sim notes (what `sim/` actually does)

- Port of linuxdoom-1.10's playsim (p_*.c, info.c tables generated by `sim/gen/gen.py`),
  16.16 fixed point and Doom's tables, no floats. Deathmatch 2 with weapons stay (placed
  weapons are never removed; an owner cannot take the same weapon again), skill 4 (UV) things,
  netgame rules. Keys are never spawned (MF_NOTDMATCH); locked doors open for anyone.
- Freelook: hitscan uses `finetangent` of the pitch as the shot slope (no autoaim) and
  can hit floors/ceilings (puff; none on sky). Missiles fly at speed·cos(pitch)
  horizontally and speed·sin(pitch) vertically. Melee and the BFG spray keep vanilla's
  vertical autoaim. Jump: momz = 8.0 from the ground (apex 36 units), 7-tic cooldown
  after landing; holding jump repeats. Turning/looking stays live during the 18-tic
  post-teleport freeze (vanilla froze it); moving does not.
- Weapon keys are edge-triggered (a new nibble value); 8 = chainsaw, 9 = super shotgun.
  Next/prev cycle fist, chainsaw, pistol, shotgun, SSG, chaingun, RL, plasma, BFG,
  skipping weapons without ammo.
- Item respawn queue is unbounded (vanilla's 128-entry ring would drop items with 100
  players). Invulnerability and invisibility do not respawn (vanilla).
- Spawn spots: DM starts, player starts, then up to 256 generated open-floor spots in the
  main connected area. A player that cannot be placed without overlapping someone stays
  dead and retries next tic.
- Light specials, texture animation and scrollers are cosmetic and not simulated
  (line-triggered light level changes, specials 12/13/35/79-81/104/138/139, are).
- Bots (`sim/src/bots/`): subsector navigation graph built at map_load (polygons from the
  BSP, step <= 24, headroom >= 56, drops one-way, doors/lifts/teleporters), A* with a
  per-tic budget, item goals weighted by need, enemies only via P_CheckSight inside a
  140° view (360° when hurt or within 200 units), per-bot reaction time / aim error /
  turn rate, strafing, weapon choice by range. They drive their slot through the same
  ticcmd as humans.
- Tests: `cd sim && cargo test --release` (all 32 maps load and run with 64 bots; MAP19 keeps all 28 weapons;
  twin/clone/deserialize determinism over 2 minutes; a scripted human slot);
  `cargo run --release --bin bench` (tic cost); `node tools/test-wasm.mjs` (the built
  wasm from Node). `node tools/build-sim.mjs` rebuilds `public/doomsim.wasm`.
- `MATCH_TICS` boundaries emit kind 7 / kind 8; during intermission nothing moves; the
  next match respawns everyone with a fresh inventory (bodies removed).

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
- Own projectiles (MT_ROCKET, MT_PLASMA, MT_BFG) are drawn from the predicted world at
  `selfAlpha`, like the camera, so they leave the barrel on the frame the shot is fired.
  MobjView has no owner: a missile of those types is ours when it first appears (absent
  the tic before, in the same world) within 64 units of our body; the id is remembered
  and every confirmed copy of it is skipped, so nothing is drawn twice. The predicted
  copy is drawn for the missile's whole life (explosion included) rather than handed
  back to the confirmed one, which would jump it back by the prediction lead; the
  predicted world is rebuilt from confirmed state, so it carries the confirmed ids and
  outcome. With no prediction to draw from, confirmed copies are drawn as usual.
  (A rival firing the same tic within 64 units of us could have a missile claimed as
  ours: it is then drawn from prediction too, which is harmless.)
- Player bodies: the 3D box marine (`src/model`, via `src/game/bodies.ts` on the
  renderer's `setPlayerBodyRenderer` hook) by default, Doom's sprites when the Esc menu
  says "Players: Classic sprites" (`prefs.players`). Corpses (PLAY mobjs no longer a
  player's body) are 3D too and keep their player's colour.
  Every death is a ragdoll (`src/model/ragdoll.ts`: a client-side Verlet ragdoll on the
  rig's joints, bending at the waist, leashed to the sim's corpse) instead of the
  keyframed fall: bullets and fists knock him over, rockets (or splash), plasma and the
  BFG throw him, away from the killer. Only an old corpse coming into view keeps the
  keyframed pose. Visual only; the sim
  never sees it. Look (2026-10-03, after the user's low-poly reference sheet): legs half
  his height, thick legs and boots, rounded green shoulder sleeves; faces painted flat
  palette colours in blocky shade noise (`PaintSpec`, rig.ts) — tan helmet, dark visor,
  green suit (kept in the green ramp so player colours apply), bare arms, dark gloves,
  khaki boots, dark gun with wood.
- The renderer is fed a `RenderFrame` (`src/render/types.ts`) by the game loop:
  interpolated mobjs, sector heights/light, line textures, camera (x, y, z, yaw, pitch),
  psprites, and the event list for effects. It never touches the sim.

## Netcode numbers

- 35 Hz, inputs ~30 bytes. 100 humans would be ~100 KB/s down per client; bots cost
  nothing on the wire (they run inside every client's sim).
- Snapshots every 35 × 10 tics.
- Prediction: whole-world, via `world_clone`.
