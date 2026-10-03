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
  (the full corresponding source of this directory) — that is how GPL §3(a) is met for a
  web build, without depending on GitHub. The menu's footer does not link the zip: its
  Source code link goes to the repository home, github.com/m0dE/doom-town (never a
  commit tree), and the footer's `build <rev>` names the built commit; `npm run export`
  refuses uncommitted or unpushed work so that commit is always on GitHub.

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

### Slower movement, no player collision (requested 2026-10-03)

The user: "players are moving tadbit too fast" and "add option for disabling collision for
player units for certain rooms? especially the team game maps that have massive player
counts? they seem to get stuck too often".

- **Speed:** P_MovePlayer thrusts `cmd × 1741` instead of vanilla's `× 2048` (85%), for
  humans and bots alike (bots drive the same ticcmd path). Top run speed ≈ 14.2 units/tic
  instead of 16.7.
- **No player collision:** a room modifier, `flags` bit 1 in `world_new_cfg`. Players
  pass through each other (PIT_CheckThing ignores player vs player); missiles, hitscan,
  monsters, pickups and telefrags are unchanged. On by default in War rooms; any room
  name can turn it on with `ghost` / `ghosts` / `nocollide` (`na-tdm-ghost-1`) or off with
  `solid` / `collide` (`my-war-solid`).
- sim_version 7 (both changes alter the simulation).

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

### War minimap and contested points (requested 2026-10-03)

The user: "in a war map, improve UI to clearly indicate which part of the map is being
overridden maybe show a minimap at top right". Client only, no sim change.

- **Minimap** (War and Battle royale rooms), top right: the whole map north-up, its
  one-sided lines drawn once to an offscreen canvas; capture points as circles filled
  with the owner's colour (grey neutral), lettered, with a capture-progress ring in the
  capturing team's colour; teammates as dots in the team colour (enemies are never
  shown); ourselves as a gold arrow. A point being taken from its owner, or with both
  teams inside, blinks. Battle royale draws the safe zone (white circle, the area
  outside it tinted red) and the next zone (dashed). `M` toggles a large centred map.
- **Point strip**: a point under capture blinks in the attacker's colour; both teams
  inside reads "CONTESTED"; the bar fills toward the team gaining.
- **Alerts**: when an enemy starts taking a point our team owns: a message "POINT C IS
  UNDER ATTACK" (once per point per 10 s). Standing inside a point: a bar under the
  crosshair, "CAPTURING B", "DEFENDING B", "CONTESTED B", or "B SECURED".

### Battle royale (requested 2026-10-03)

The user: "a battle royale gameplay where you're in this vast map with many buildings in
it. PUBG style. you open crate and bunch of items will fall out like health/armor
shards, sniper, etc." Prior art: DooM Royale (Zandronum, 2018, up to 64 players).

| mode | id | slots | teams | rules |
|---|---|---|---|---|
| Battle royale | 4 | 64 | – | one life; a shrinking zone; crates spill loot; last marine standing wins |

- **Room names**: `br`, `royale`, `battle`, `pubg` pick it (`na-br-1`). Rotation key
  `battleRoyale`: `BR01`. No bosses; players collide (solid) unless the name says `ghost`.
- **Match**: a 10 s freeze phase (PH_FREEZE, phase 1; everyone is placed on spawn
  spots spread across the map, may look, not move or fire), then PH_PLAY until one
  player is alive or 15 min (`match_tics` default 35*900) pass, then the intermission
  (winner = the last alive slot; at the time limit the live player with the most frags,
  -1 if nobody lives) and the next match. Starting kit: fist, pistol, 20 bullets, 100
  health, no armor.
- **One life**: no respawn during PH_PLAY (like elimination); the dead spectate an
  alive player (PlayerView[50], attack cycles). A joiner, or a bot slot a human takes
  over mid-match, waits for the next match. `PlayerView[33]` frags = kills.
- **Items**: nothing on the map respawns and weapons don't stay (a weapon picked up is
  gone). Spilled and placed items are all one-shot.
- **Crates**: thing 9020 → `MT_CRATE` (mobjtype **137**, appended after vanilla's 137
  types), radius 20, height 40, MF_SOLID|MF_SHOOTABLE|MF_NOBLOOD, health 25. A crate opens
  when it is destroyed (any damage) or when a live player presses *use* facing it
  within 96 units (±45°). Opening removes it, plays a wooden-break sound (one the base pak ships,
  e.g. `sfx::pstop`) and spills 4–7 items
  at its centre, each with a P_Random momentum (|momx|,|momy| ≤ 5 units/tic, momz 4–8),
  MF_DROPPED. Loot table (weights out of 100): health bonus ×3 (15), armor bonus ×3
  (15), stimpack (10), medikit (6), green armor (5), blue armor (1), shotgun + shells
  (8), super shotgun (5), chaingun (7), rocket launcher (4), plasma gun (3), BFG (0.5,
  i.e. 1 in 200), box of bullets (6), box of shells (5), box of rockets (3), cell (2),
  backpack (3), berserk (2), soulsphere (0.5) — the remainder rounds the weights to 100.
  Every crate drops at least one health or armor bunch. Event **17** crate opened
  (a = opener slot or -1, b = items spilled, x/y/z = crate centre).
- **Sniper (scope)**: buttons bit 3 = *zoom* (held; the client binds the right mouse
  button and `Z`, and narrows the FOV to 25° while held). In battle royale, while zoomed:
  pistol and chaingun bullets have no spread, and the pistol does ×3 damage (a marksman
  shot, 15–45); the player moves at half speed. Outside battle royale the bit is ignored
  and the client does not zoom.
- **Zone**: a circle. Stage 0 covers the whole map (centre = the map's bounding-box
  centre, radius = its half diagonal). Each stage waits, then shrinks linearly to the
  next circle, which lies inside the current one, centred on a spawn spot picked with
  P_Random among those with dist(spot, centre) <= r_cur − r_next (else the same centre).

  | stage | wait | shrink | radius after (of stage-0 radius) | damage / s outside |
  |---|---|---|---|---|
  | 1 | 60 s | 60 s | 60 % | 1 |
  | 2 | 45 s | 45 s | 35 % | 2 |
  | 3 | 40 s | 40 s | 18 % | 4 |
  | 4 | 30 s | 30 s | 8 % | 7 |
  | 5 | 30 s | 30 s | 0 | 10 |

  The clock starts at PH_PLAY. Outside the current circle, a live player takes the
  stage's damage every 35 tics (damage of the stage being waited for/shrunk; stage 1's
  values during stage 1), through P_DamageMobj with no source, armor ignored. Means of
  death **16** zone ("%o was caught outside the zone"). Event **16** zone (a = stage,
  b = 0 waiting / 1 shrinking, c = tics until the state ends), sent when the state
  changes.
- **world_view_match**: after the boss words, always present (zeros outside battle
  royale), `BR_WORDS = 11`: 0 zone x, 1 y, 2 radius (fixed, current, interpolated while
  shrinking), 3 next x, 4 next y, 5 next radius, 6 stage (1..5, 6 = closed), 7 state (0
  waiting, 1 shrinking, 2 closed), 8 tics until the state ends, 9 alive players,
  10 damage per second outside.
- **Bots**: in PH_PLAY a bot outside the next circle (or the current one while
  shrinking) paths toward the circle's centre, with priority over items; otherwise
  crates within reach are item goals: walk up, face, press use. Spilled loot is picked
  up by the ordinary item goals.
- **Map BR01 "Doom Town"** (`tools/maps/br01.mts`): about 16384 × 16384 units, a town of
  streets and 40+ enterable buildings (houses, shops, a church, warehouses, an office
  block with stairs to a roof, a factory), outskirts with fields, hills, a river with
  bridges and a few compounds. ~160 crates (thing 9020), mostly indoors; sparse ground
  loot (bonuses, clips, a few shotguns/chainguns); 64+ DM starts spread across the
  whole map. Wall texture `CRATE1` and flat `CRATOP2` appear in it (crate stacks), so
  the crate model's textures are in the map's art pak.
- **Client**: a crate is drawn as a 3D box (sides `CRATE1`, top `CRATOP2`) instead of a
  sprite. HUD: top "ALIVE n", "KILLS n", the zone line ("ZONE SHRINKS IN 0:42" /
  "ZONE CLOSING" / "FINAL ZONE"); "OUTSIDE THE ZONE" in red while outside; dead:
  "YOU PLACED #n" + spectating; intermission: "<NAME> IS THE LAST MARINE STANDING".
- sim_version 8.

As implemented (sim_version 8, `sim/src/royale.rs`):

- `MT_CRATE` = 137 with one state `S_CRATE` = 967 (sprite `BAR1` frame A as the fallback;
  NUMMOBJTYPES 138, NUMSTATES 968), appended by `sim/gen/gen.py`. Thing 9020 spawns a
  crate whatever its skill bits. Crates exist in any mode whose map has them.
- **Use**: the press goes to the nearest live crate whose centre is within 116 units
  (96 from its edge), within ±45° of the facing, overlapping in height and in sight;
  it takes the press before the lines. **Damage**: any damage opens it (opener = the
  damage source's slot, -1 for none); nothing else of P_DamageMobj applies.
- **Loot**: 4–7 *entries* per crate; an entry is one row of the table, so "health bonus
  ×3" spawns 3 things and "shotgun + shells" 2 (event 17 `b` = things spawned, 4..21).
  The first entry is always drawn from the six health/armor rows. The listed weights sum
  to 101, so they are used as given (half-percent units out of 202). Things spawn at the
  crate's mid-height with momx/momy = (P_Random-128)·5/128 units/tic, momz = 4 +
  P_Random/64 units/tic, MF_DROPPED; they fly, land and slide to rest under the usual
  P_XYMovement / P_ZMovement rules. Sound: `sfx::pstop` (DSPSTOP) at the crate centre
  (event 1, origin 0).
- **Weapons in battle royale** (placed or spilled): taken and removed like any item; give
  the weapon (if not owned) plus 2 clips of its ammo (vanilla's non-deathmatch amount:
  shotgun/SSG 8 shells, chaingun 20 bullets, RL 2 rockets, plasma/BFG 40 cells). Nothing
  respawns (no item queue in battle royale).
- **Match**: the map (crates and items) is rebuilt at every match start, so each match
  starts with full crates (event 9 only when the map actually changes). (sim_version 8:
  freeze = phase 1; since 9 the lobby and the drop replace it, see v2 below), then PH_PLAY with `phase_left` = `match_tics` counted from PH_PLAY. The match ends at
  the end of the tic where <= 1 player is alive (winner = that slot, -1 if none) or at
  the time limit (the live player with the most frags, lowest slot on ties). In battle
  royale suicides and zone deaths do not subtract a frag (frags = kills).
- **Placement** (the lobby on a map without lobby spots): each player takes the spawn spot farthest from
  everyone already placed (a random one of the best 8, P_Random), so 64 players spread.
- **Zone**: the stage-0 circle and stage 1's target are set at match start (one P_Random
  pair per pick), so during the freeze the words read stage 1, waiting, 60 s. Event 16
  is sent at PH_PLAY start and at every state change (`b` = 2 when closed; x/y = the
  current centre). Damage every 35 tics of PH_PLAY (first at 1 s); once closed (radius
  0) every live player takes 10/s. `zone` damage ignores armor but not
  invulnerability. Word 10 (damage/s) reads 1 during the freeze.
- **Zoom** (bit 3) is ignored outside battle royale. Pistol damage ×3 = 15/30/45,
  chaingun and pistol shots without spread, thrust 1741/2 per move unit.
- **Bots**: "urgent" = outside the next circle while waiting, outside the current one
  while shrinking or closed; then they head for a spawn spot inside half that circle,
  re-checking every second, and keep running their route while fighting. Otherwise
  their item goals include crates (value 70 unarmed / 30 armed, + missing health / 3),
  only items inside the current circle count; within 100 units of a goal crate they
  face it and tap use. Bots don't zoom. Dead bots don't press attack.
- Tests: `sim/tests/royale.rs` (64 bots on WAR01 with crates added next to spawn spots:
  a whole match to a last marine standing, the zone stages, crates opened by use, loot
  picked up, crates back next match; twin/clone/deserialize determinism; use/damage
  opening, loot coming to rest and picked up; zoom; zone damage/armor/obituary; late
  joiner; a BR01 smoke when `public/maps/BR01.map.wad` exists).

### Battle royale v2: lobby, dropship, parachutes, vehicles, sniper, grenades, storm (requested 2026-10-03)

The user: "we need more weapons in battle royale like sniper with zoom, ridable
vehicles, etc. there needs to be clear storm closing in. lobby before the game
launches. parasuting down, etc etc. it needs to be pretty comprehensive" and "all this
should be contained within a single map file". Supersedes the 10 s freeze above.

- **Match flow**: phase 4 **lobby** (45 s) → phase 5 **drop** (the dropship crossing)
  → phase 0 play (zone clock starts) → phase 3 intermission. The freeze phase is not
  used in battle royale.
- **Lobby** (phase 4): everyone spawns on the map's lobby island — things **9030**
  (lobby spots), a walled area away from the playfield (not inside the zone's
  bounding box; the zone and the bus use only DM starts / non-lobby spots). Players move,
  jump and shoot freely but nothing does damage (P_DamageMobj on players is a no-op in
  the lobby); everyone has fist + pistol + 200 bullets there for fun; on leaving the
  lobby the kit resets to the starting kit. Joiners arriving in the lobby play this
  match. PlayerView[44]/match words show the countdown.
- **Dropship / bus** (phase 5): a straight flight line across the playfield through a
  P_Random point within 25 % of the centre, at a P_Random angle, at altitude
  `drop_alt` (default 4096 units above the highest floor), 24 units/tic. Everyone is in
  it: their bodies are taken out of the world (no mobj; PlayerView[1] = 0) and their
  position is the ship's. A `MT_DROPSHIP` mobj (type **138**) is flown along the line,
  MF_NOBLOCKMAP|MF_NOGRAVITY|MF_NOCLIP, positioned directly (no P_TryMove; z
  unconstrained). *Jump* or *use* jumps out; at the end of the line everyone left is
  ejected. Phase 5 ends when the ship reaches the end of the line.
- **Skydiving**: a player out of the ship is "airborne" — still no body in the world;
  the sim keeps a virtual position (x, y, z fixed) and moves it: freefall momz −24
  units/tic, horizontal steer 10 units/tic along the view yaw from forward/side;
  the parachute opens automatically 512 units above the floor below (or on *jump* when
  more than 256 above it): fall −5 units/tic, steer 6. Landing (z at or below the floor
  of the sector under (x, y)): the body is spawned there if the spot fits (P_CheckPosition,
  room for the height), else at the nearest spawn spot that fits; then the starting kit.
  A `MT_PARACHUTER` mobj (type **139**, MF_NOBLOCKMAP|MF_NOGRAVITY|MF_NOCLIP, never
  hit) mirrors each airborne player so others can see them; MobjView[7] carries the slot
  like a player body; its frame A = freefall, B = parachute open.
  PlayerView appends: **51** air state (0 none, 1 in ship, 2 freefall, 3 parachute,
  4 vehicle driver), **52/53/54** virtual x, y, z (fixed) while 1–3, **55** vehicle mobj
  id while driving (0 none). The camera follows the virtual position.
- **Vehicles**: things **9040** spawn `MT_BUGGY` (type **140**): radius 32, height 48,
  MF_SOLID|MF_SHOOTABLE, health 400. *Use* within 96 units enters it (one seat):
  the driver's body is unlinked from the blockmap and rides — the buggy moves with
  car physics (forward/back accelerate up to 28 units/tic, side steers the heading, the
  heading is the buggy's, not the mouse's, mouse yaw is free look), through P_TryMove at
  the buggy's radius (stairs ≤ 24 like players; it can't climb more), and the driver
  is placed at the buggy each tic. Hitting a player at > 12 units/tic does speed/2
  damage and knocks them (MOD **17** roadkill "%o was run over by %k"). Damage aimed at
  the driver hits the buggy; at 0 health it explodes (P_RadiusAttack 128, the driver
  ejected and takes the blast) and leaves nothing. *Use* again exits to the left side
  (or any free side). Driver can't fire. Respawn: none within a match; every match the
  map's buggies are back. Bots ignore vehicles except avoiding them.
- **Sniper rifle**: weapontype **9** (`wp_sniper`), slot key **2** toggles pistol ↔
  sniper (like 3 toggles shotgun ↔ SSG). Ammo: bullets, 5 per shot. One hitscan of
  70 + P_Random%31 damage (one-shots 100 hp with no armor most of the time), no spread
  when zoomed, ±(spread of the shotgun) when not; refire 50 tics (1.4 s). Thing pickup
  `MT_SNIPER` (type **141**, doomednum 9050, gives 10 bullets). Sprites (new sprite names
  appended to SPRNAMES): **SNPR** (pickup, frame A), **SNPG** (weapon: A ready, B fire,
  C–D bolt), **SNPF** (flash A). The client generates these patches in code (Doom-style
  palette pixel art) and adds them to the WAD before the atlas is built; the sim only
  uses the names. While zoomed with the sniper the client FOV is 12° (other weapons 25°).
- **Grenades**: an inventory count (max 5), not a weapon: buttons bit **10** throws one
  (key `G`), 30 tics cooldown. `MT_GRENADE` (type **142**): a missile with gravity that
  bounces off floors/walls (momentum halves each bounce), explodes 70 tics after the
  throw (P_RadiusAttack 160, MOD 5-like **18** "%o caught %k's grenade"). Pickup
  `MT_GRENADEPACK` (type **143**, doomednum 9051, +2 grenades). Sprites **GREN** (in
  flight / pickup, frame A). PlayerView **56** = grenades.
- **Loot** gains: sniper rifle (5), grenade pack ×1 (8); weights renormalised.
- **Supply drops**: at the start of zone stages 2, 3 and 4 a supply drop lands at a
  P_Random spawn spot inside the next circle: event **18** (x, y) 10 s before, then an
  `MT_CRATE` with flag "supply" (MobjView flags bit MF_SUPPLY = 0x20000000 —
  unused by vanilla) whose loot table is the rare items (sniper, BFG, blue armor,
  megasphere/soulsphere, plasma, RL + rockets, grenades ×3). The client draws it red with
  a smoke column and marks it on the minimap.
- **Storm** (the zone, client): a translucent, animated purple-blue wall (cylinder from
  well below the lowest floor to far above the highest ceiling) at the current radius,
  visible from anywhere; outside it the screen is tinted purple with a storm sound
  loop; the next circle shows as a white ring on the minimap and a faint ground ring.
  "THE STORM IS CLOSING IN" banner when shrinking starts.
- **Lobby UI** (client): during phase 4 a panel lists the players in the match (humans
  first), "DROPSHIP LEAVES IN 0:32", tips (keys: use = open crate / enter vehicle, G
  grenade, right mouse zoom, jump = leave the ship / open chute). During phase 5 the
  minimap shows the flight line and the ship; "PRESS JUMP TO DROP".
- **world_view_match** BR words gain: 11 lobby/drop tics left, 12 ship x, 13 ship y,
  14 ship dir x (fixed unit vector), 15 ship dir y, 16 supply drop x, 17 y (0/0 none),
  18 supply drop state (0 none, 1 incoming, 2 landed). `BR_WORDS = 19`.
- sim_version 9.

As implemented (sim_version 9; `sim/src/drop.rs`, `sim/src/vehicle.rs`, `sim/src/royale.rs`):

- **Numbers**: mobjtypes 137 crate, 138 dropship, 139 parachuter, 140 buggy, 141 sniper
  rifle (9050), 142 grenade, 143 grenade pack (9051); states 967 S_CRATE, 968 S_DROPSHIP,
  969/970 S_PARA_FALL/OPEN, 971 S_BUGGY, 972 S_SNIPERRIFLE, 973 S_GRENADE, 974
  S_GRENADEPACK, 975–982 the sniper's psprite states; sprites 138 SNPR, 139 SNPG, 140
  SNPF, 141 GREN (NUMSPRITES 142, NUMSTATES 983, NUMMOBJTYPES 144). Fallback sprites:
  crate, dropship and buggy BAR1A; parachuter PLAYA (freefall) / PLAYB (chute) — the
  client draws all four as models. The buggy also has MF_NOBLOOD (puffs, not blood).
- **Phases**: 4 lobby, 5 drop. `phase_left` counts the lobby down, then the ship's tics
  to the end of its line. Lobby spawns use things 9030 (any spawn spot if the map has
  none); every spawn spot (DM starts included) within 512 units of the lobby spots'
  box is dropped, and with a lobby the playfield box (zone stage 0, flight line,
  skydiving clamp) is the spawn spots' box + 256. In the lobby nothing takes damage
  (players, crates, buggies) and crates can't be used; kit fist + pistol + 200 bullets.
- **Drop**: line through the stage-0 centre ± r0/4 (P_Random x, y), P_Random angle
  (two bytes), from −r0 to +r0 along it (2·r0/24 tics; ~790 on BR01), at the highest
  floor + `drop_alt`. Boarding (everyone not dead, waiting joiners included) resets the
  kit (fist, pistol, `start_bullets`, no grenades). Leaving: an edge of *jump* or *use*.
  Freefall starts 64 below the ship. The airborne position is clamped to the playfield
  box. Landing triggers at the floor, or at a non-sky ceiling (no passing through roofs);
  the spot must have sky above, 56 of headroom, be in the bots' main area, clear of
  walls and things; else the nearest of the 64 closest spawn spots that fits; if none
  fits, the player hovers and retries next tic. Landing emits event 5 with b = 2. The
  ship is ejected at the end of its line and the phase turns to play (zone clock) even if
  people are still under canopy. PlayerView[7] is the view yaw while airborne. The
  dropship and parachuter mobjs skip the ordinary mobj thinker: they sit exactly at the
  ship's / player's virtual position (MobjView x/y/z = PlayerView[52..54]).
- **Buggy**: speed kept in the mobj's `movecount` (fixed), heading = its angle, driver in
  `tracer`. Forward accelerates 1 unit/tic (to 28), back brakes 1.5 (to −10 reverse),
  none coasts down 0.5; side turns up to 4°/tic (reversed in reverse), only on the
  ground. Moves in ≤16-unit P_TryMove steps; a blocked step bounces speed to −¼. Roadkill
  over 12 units/tic: speed/2 damage (inflictor the buggy, source the driver, MOD 17),
  the victim is shoved, the buggy keeps ¾ of its speed. Exit: 56 units out to the left,
  right, back or front (headroom, ≤ 24 step, clear); a press does nothing if none fits.
  Explosion: driver ejected (forced), a 128 blast from an MT_GRENADE in S_EXPLODE1
  (credited to whoever destroyed it). Zone damage still hits the driver. `vehicles: 0`
  in the rules stops things 9040 from spawning. Use order: get out / crate / buggy / lines.
- **Sniper**: S_SNIPER1 B 4 (fire) → C 23 → D 23 → A 5 (refire): a held trigger fires
  every 50 tics. Range 4096. Sound `dshtgn`. Means of death **19** (new: sniper rifle).
  Pickup message **32**; it gives 10 bullets (in every mode). The sniper sits after the
  pistol in next/prev weapon order.
- **Grenades**: thrown from eye height at 18 units/tic along the view (pitch) + 4 up
  + the thrower's momentum; moves itself in ≤8-unit steps per axis, bounces off walls
  (that axis ×−½), floors (momz ×−½ and momx/momy ×½ when falling faster than 3),
  ceilings; rolls with friction; passes through things. At 70 tics: P_RadiusAttack 160
  from the thrower (MOD 18), sound `rxplod`, S_EXPLODE2. Pack pickup message **33**, not
  taken at 5. Throwing sound `sgcock`.
- **Loot**: rows 19 sniper rifle (10) and 20 grenade pack (16) appended; weights are
  relative (any total). Supply crates: 4 entries, equal odds, from sniper, BFG, blue
  armor, megasphere, soulsphere, plasma gun, RL + box of rockets, 3 grenade packs (no
  forced health row). Event 17 `c` = 1 for a supply crate.
- **Supply drops**: at the start of stages 2, 3 and 4 (when they exist and `supply`):
  a P_Random spawn spot inside the new next circle; event 18 (a = stage, b = 350, x, y);
  the crate lands 10 s later (sound `barexp`), waiting up to 5 s more for the spot to be
  clear of things; BR words 16–18 show it until it is opened.
- **Rules block**: after the flags word (`seed`, `flags` must both be present before
  it). Stage count (key 7) is applied first; new stages copy the last row; a count of 0
  means the default stages. Values are clamped (stages ≤ 8, timings ≥ 1 tic, radius
  0–1000 ‰ and never above the previous stage's, drop_alt 256–16384, start bullets
  0–400, loot rows 0–10000; a crate's roll takes 24 random bits, so heavy tables reach
  every row). A rules count or map count longer than the buffer is rejected (0). The rules travel in snapshots (`world_deserialize` restores them).
- **map_load** takes the map's lumps as the contiguous run after THINGS (THINGS ...
  BLOCKMAP, BEHAVIOR) and ignores everything else in the PWAD (MODINFO, TEXTURE1,
  PNAMES, P_/F_ namespaces).
- **Bots**: at the drop each picks (P_Random) a jump point uniformly over 10–95 % of the
  line, then, of 12 P_Random points within 1800 units of it where a body can land (sky,
  room), the one farthest from the landings the lower slots picked; it jumps when the
  ship passes the point and steers there at full forward. For 3 s after landing a bot
  armed with only fist/pistol starts no fight (it still shoots back at whoever hurts it).
  While the zone waits, a bot outside the next circle only heads in once the wait left
  is under its distance to the edge / 10 units per tic + 15 s; it then goes to one of
  the 8 spawn spots inside ¾ of the circle nearest to it. In the lobby they wander
  between lobby spots.
- **Landing fallback**: when the spot under a skydiver doesn't fit, rings of 64, 128, 256
  and 512 units (8 directions) are tried for a landable point before the nearest spawn
  spot (BR01's generated spawn spots crowd into a few fields, so the old fallback piled
  people up).
- **Cost** (`cargo run --release --bin bench br01 900 <seed>`, a whole 64-bot match;
  slow tics re-timed on copies, min of 3, because this 2-core machine is shared): native
  avg 0.06 ms, p99 0.2–0.4 ms, max ~1 ms; wasm in Node (`tools/test-wasm.mjs`) avg
  0.1 ms, p99 0.45 ms, max 1.1 ms. Raw timings on the loaded machine showed 8–28 ms
  outliers that do not reproduce when the same tic is re-run: scheduler pauses.
  On BR01, 56–62 of 64 are alive when the ship reaches the end of its line. They don't drive (a bot slot left at the wheel
  gets out); they zoom with the sniper beyond 300 units, throw a grenade at 250–700
  units now and then, and value snipers (70) and grenade packs (25).

As implemented (client rendering; `src/render/br/`, all visual):

- **Storm** (`storm.ts`): a 192-column cylinder at the current circle from the lowest floor
  − 1024 to the highest ceiling + 12000, both sides, depth-tested, no depth write,
  premultiplied blend (darkens what is behind, adds a rising 3D-noise purple), brighter
  at grazing angles and in a band where it meets the floor (floor heights sampled per
  column when the circle moves). The next circle: a 20-unit white curtain on the
  ground. Outside the circle the composite pass tints the screen purple (`uStorm`,
  ramping over ~100 units). Fed by `RenderFrame.royale` (game.ts fills it from the BR
  words outside the lobby and intermission).
- **Models** (`palmodel.ts`, `models.ts`): three.js primitives merged per part, each
  face a palette index lit through COLORMAP like walls (sector light + distance, a
  ±3-row key light, dynamic lights; fullbright faces feed the bloom; green-ramp faces
  take the player translation). Buggy: tub, roll cage, fenders, lamps (+ a headlight
  dynamic light), four wheels spinning with the drawn speed, front wheels steering from
  the turn rate. A player body within 6 units of a buggy is drawn seated in it (body
  hook `RenderMobj.pose` = 1: upright, not walking). Dropship: ~680 × 940, four engines
  with glowing exhausts, heading from its motion, drawn 60 below its z. Parachuter: the
  slot's 3D marine (pose 2 = face-down freefall, 3 = hanging), frame B adds a 9-cell
  canopy in the slot colour that blossoms open; our own parachuter (the view mobj)
  shows only the canopy, 64 units ahead so looking up shows it. In the ship the client
  uses a chase camera 1250 back along the view, 300 up and tilted down 0.3 rad.
- **Supply crate** (MF_SUPPLY): the crate box painted red with a white band and a
  strobe on top, a red smoke column (instanced puffs) and a pulsing red light.
- **Sprites** (`sprites.ts`): SNPR/SNPG A–D/SNPF/GREN are rasterised in software from a
  low-poly rifle and grenade (perspective for the psprite, aimed at the crosshair;
  orthographic 3/4 for the pickups), quantised to the WAD's palette and injected into
  the sprite namespace before the atlas is built (a WAD with its own lumps keeps them).
- **From altitude**: the sky is written at the far plane (whatever flies above the sky
  ceiling draws over it); a sky dome (same sky mapping, horizon haze below) is drawn
  while the camera is above its sector's ceiling, ceilings are then drawn double-sided
  (roofs seen from above) and the near plane moves out; Doom's view depth also counts
  vertical distance beyond 256 so the town below is distance-lit; far plane 65536.

## Mods: one file per mod (requested 2026-10-03)

The user: "all this should be contained within a single map file", "we want to
encourage others to submit their mod like this and host room", "there needs to be
documentation page on how to build mod with examples".

- **A mod is one PWAD file** `public/mods/<id>.wad` holding: exactly one map (marker +
  THINGS LINEDEFS SIDEDEFS VERTEXES SECTORS, optional SEGS/SSECTORS/NODES/BLOCKMAP/
  REJECT — nodes are required, any node builder will do), the art it needs beyond the base pak (TEXTURE1/PNAMES with patches
  between P_START/P_END, flats between F_START/F_END), and a **`MODINFO`** lump (UTF-8
  JSON). Battle royale's BR01 is the first mod (`public/mods/br01.wad`); the built-in
  `br` rooms play it.
- **MODINFO** (format 1):
  ```json
  { "format": 1, "id": "br01", "title": "Doom Town Royale", "author": "Doom Town",
    "license": "BSD-3-Clause", "description": "64 marines, one island, one survivor.",
    "mode": "battle-royale", "map": "BR01", "slots": 64,
    "ghosts": false, "bosses": false,
    "rules": { "matchSeconds": 900, "lobbySeconds": 45, "dropAltitude": 4096,
               "startBullets": 20, "vehicles": true, "supplyDrops": true,
               "zone": [ { "wait": 60, "shrink": 60, "radius": 60, "dps": 1 }, ... ],
               "loot": { "sniper": 5, "bfg": 0.5, ... } } }
  ```
  `mode` is one of `deathmatch`, `team-deathmatch`, `elimination`, `war`,
  `battle-royale`. `id` is `[a-z0-9]{2,16}`. Every rule is optional (the mode's default).
- **Rules to the sim**: the client turns `rules` into numbers and appends a rules block
  to `world_new_cfg` after the flags word: `[count, (key, value) × count]`, keys:
  1 match_tics, 2 lobby_tics, 3 drop_alt (units), 4 start_bullets, 5 vehicles (0/1),
  6 supply_drops (0/1), 7 zone stage count, 8.. per stage i (0-based): 8+4i wait tics,
  9+4i shrink tics, 10+4i radius ‰ of stage-0, 11+4i dps — stages ≤ 8 (keys 8..39);
  64.. loot weights in half-percent units, key 64 + loot row index (row order in DESIGN
  "As implemented" loot list); 100 round_tics, 101 freeze_tics, 102 rounds_to_win,
  103 tickets, 104 friendly fire (0/1). Unknown keys are ignored; the same file gives
  the same numbers on every client, so lockstep holds.
- **Rooms**: a room name with the word `mod` followed by the mod id plays that mod
  (`na-mod-br01-1`, `my-mod-arena-night`); the mod's mode and slots apply. The list of
  installed mods is `public/mods/index.json` (`[{ id, title, author, mode, map, slots,
  bytes, description }]`), built by `npm run mods`, imported into the client at build
  time (so `roomGame(name)` stays synchronous); the WAD itself is fetched when a room
  using it is joined, and the sim gets its map lumps via `map_load` (extra lumps are
  ignored).
- **Hosting**: the menu's Host / Create room lets the player pick a mode *or* a mod and
  names the room; the server list shows a mod room's title and "MOD" badge with its
  author.
- **Playtesting your own file**: `?offline=1&mod=<url or path>` loads a local/dev WAD,
  and the menu has "Test a mod file…" (offline only) taking a file from disk — nobody
  else can join a room built from a file only you have.
- **Submitting**: mods enter through a pull request adding `mods/<id>/` (the source:
  map script or editor files, MODINFO.json, README with credits/licence) and the built
  `public/mods/<id>.wad`; `npm run mod:check public/mods/<id>.wad` validates it (lumps,
  MODINFO schema, id uniqueness, size ≤ 4 MB, known thing types, textures resolvable
  against Freedoom + the mod's own art, licence GPL-2.0-compatible or BSD/CC0/CC-BY;
  the sim loads it and runs 60 s with bots). Once merged and deployed it appears in the
  server list's host picker.
- **Docs**: `docs/MODDING.md` (repo) and the same guide at `/modding.html` in the site
  (linked from the menu footer "Make a mod"), with examples under `mods/examples/`:
  a tiny deathmatch arena built with the map DSL (`mods/examples/arena`), a war map with
  three capture points (`mods/examples/hill3`), and a battle-royale rules remix that
  reuses BR01's map with a fast storm and snipers-only loot (`mods/examples/snipers`).
  Each example builds with `npm run mods` and passes `mod:check`.

As implemented (check and docs):

- `tools/mods/check.mjs` (`npm run mod:check <file…>`, `-- --all` for every
  `public/mods/*.wad`; `--seconds=N`, `--no-sim`, `--verbose`, `--wasm=<file>`): errors
  fail, warnings don't. Allowed licences (SPDX): CC0-1.0, CC-BY-4.0, CC-BY-3.0,
  BSD-3-Clause, BSD-2-Clause, MIT, GPL-2.0-only, GPL-2.0-or-later. Lumps outside the map
  and the P_/F_ namespaces may only be MODINFO, PNAMES, TEXTURE1/2; a lump the base pak
  has (PLAYPAL, DS*, …) is refused. Unknown MODINFO fields and rule keys are errors
  (typos); rules of another mode are warnings; all six health/armor loot rows at 0 is an
  error. A map name another installed mod uses is fine only with byte-identical map
  lumps (a rules remix such as `snipers`). Things: Doom's (`src/wad/things.ts`), starts
  1-4/11, 9000-9051; monsters and keys warn; decorations whose sprites the base pak lacks
  warn; per mode: ≥ 4 DM starts (DM/TDM/elim), team starts + 1-8 points (war). The sim
  run uses the mod's rules (battle royale: lobby capped at 10 s so the drop and play are
  covered), reports ms/tic, kills/captures/crates/storm events/sniper pickups, bots that
  moved > 512 units, and that a world deserialized at half time ends with the same hash.
- `/modding.html` is `docs/MODDING.md` rendered into `modding.html` by a Vite plugin
  (`vite.config.js`, renderer `tools/mods/markdown.mjs`, no dependencies; styles
  `src/menu/modding.css`); it is a second build input next to `index.html`.

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
  never sees it. Look (2026-10-03, after the user's low-poly reference sheet): part meshes
  modelled in Blender (`tools/model/build_parts.py`, runs headless with the `bpy` module)
  — the Doomguy helmet (open face framed by brow, cheek and chin guards, recessed visor,
  ear pieces, neck guard, top ridge), V chest with plates, domed sleeves, 8-sided
  limbs, boots with a knee cuff and sole, a pump shotgun; legs half his height, shoulders
  at ±10.5, hips ±7.6 inside the chest (±9), feet apart; faces painted flat
  palette colours in blocky shade noise (`PaintSpec`, rig.ts) — tan helmet, dark visor,
  green suit (kept in the green ramp so player colours apply), bare arms, dark gloves,
  khaki boots, dark gun with wood, all at the sprite's brightness (the sheet's studio-lit
  values drew 1.5-2x brighter than the sprites in the world). Gun grip at his right hip.
- The renderer is fed a `RenderFrame` (`src/render/types.ts`) by the game loop:
  interpolated mobjs, sector heights/light, line textures, camera (x, y, z, yaw, pitch),
  psprites, and the event list for effects. It never touches the sim.

## Netcode numbers

- 35 Hz, inputs ~30 bytes. 100 humans would be ~100 KB/s down per client; bots cost
  nothing on the wire (they run inside every client's sim).
- Snapshots every 35 × 10 tics.
- Prediction: whole-world, via `world_clone`.
- Measured 2026-10-03 (`node tools/test-mp.mjs --players=3 --seconds=180`, local
  cluster, three headless pages joining at the same instant, each running, strafing,
  turning, jumping and firing): 35.0–35.4 tics/s on every page, RTT 0–15 ms, playout
  delay 0–50 ms, prediction lead 1–3 tics, ~70 rollbacks/min per page, 0 desyncs.
  World hashes compared on every shared hashed frame every 5 s: 4657/4657 agree; same
  slots and the same frag total (2074) on all three. A page that joins catches up at
  ~360 tics/s for its first seconds. (Render fps in that test is not meaningful: three
  pages share one software-GL CPU.)
