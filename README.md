# Freedoom Deathmatch

A 100-player Doom deathmatch that runs in a web page, on [arrr-network](https://arrr.fun).
Open the page, pick a server, play. Bots fill every empty slot, so a room is always a
full match.

- **Simulation:** a Rust port of the Doom playsim (id Software's linuxdoom-1.10),
  compiled to WebAssembly. Fixed point throughout, so every browser computes the same
  game, and arrr-network keeps everyone in lockstep. Adds freelook and jumping.
- **Rendering:** three.js with Doom's palette and sector lighting, plus dynamic lights
  and bloom.
- **Data:** [Freedoom](https://freedoom.github.io/) / FreeDM 0.13.0. The map is DM19 "Tech Isle".

```bash
npm install
npm run dev          # http://localhost:5190  (?offline=1 plays against bots alone)
npm run build:sim    # rebuild public/doomsim.wasm (needs Rust + wasm32-unknown-unknown)
npm run fetch && npm run pak   # rebuild public/freedm-lite.wad from FreeDM
npm run export       # the build to upload to arrr.fun
```

How the parts fit is in [DESIGN.md](DESIGN.md).

## License

The code is **GPL-2.0-or-later** ([LICENSE](LICENSE)). It is derived from the DOOM
source code, Copyright (C) 1993-1996 id Software, Inc., released under the GPL.

Game data is from the Freedoom project, BSD-3-Clause
([assets/COPYING-FREEDOOM.txt](assets/COPYING-FREEDOOM.txt),
[assets/CREDITS-FREEDOOM.txt](assets/CREDITS-FREEDOOM.txt)).

DOOM is a trademark of id Software. This project is not affiliated with or endorsed by
id Software, ZeniMax or Bethesda.

This repository is published from the arrr-mono monorepo (`games/doom/`); each commit
here is a sync from there.
