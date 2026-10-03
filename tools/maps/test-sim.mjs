#!/usr/bin/env node
// Loads generated maps into public/doomsim.wasm (read-only use of the sim) and runs a war
// match of bots: map_load result, ms/tic, kills, which capture points got captured and by
// whom, how far bots got from their base. Also loads every map of the base pak.
//   node tools/maps/test-sim.mjs [WAR01] [--seconds=120] [--slots=200]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/paths.mts';
import { Wad, buildWadFile, MAP_LUMPS } from '../../src/wad/wad.ts';

const args = process.argv.slice(2);
const name = (args.find((a) => !a.startsWith('--')) ?? 'WAR01').toUpperCase();
const seconds = Number(args.find((a) => a.startsWith('--seconds='))?.slice(10) ?? 120);
const slots = Number(args.find((a) => a.startsWith('--slots='))?.slice(8) ?? 200);

const { instance } = await WebAssembly.instantiate(readFileSync(join(ROOT, 'public/doomsim.wasm')), {});
const ex = instance.exports;
const mem = () => new Uint8Array(ex.memory.buffer);
const i32 = (p, n) => new Int32Array(ex.memory.buffer, p, n).slice();
const pass = (b) => { const p = ex.alloc(b.length); mem().set(b, p); return p; };
const base = new Wad(new Uint8Array(readFileSync(join(ROOT, 'public/freedm-lite.wad'))));
const pwadOf = (m) => {
  const lumps = base.mapLumps(m);
  return buildWadFile([{ name: m, data: new Uint8Array(0) }, ...MAP_LUMPS.filter((n) => lumps.has(n)).map((n) => ({ name: n, data: lumps.get(n) }))]);
};
const load = (bytes) => { const p = pass(bytes); const id = ex.map_load(p, bytes.length); ex.dealloc(p, bytes.length); return id; };

// every map in the base pak loads
const index = JSON.parse(readFileSync(join(ROOT, 'public/maps/index.json'), 'utf8'));
const ids = {};
for (const m of Object.keys(index.maps)) {
  const t0 = performance.now();
  ids[m] = load(pwadOf(m));
  console.log(`map_load ${m}: ${ids[m]} (${(performance.now() - t0).toFixed(0)} ms)`);
}
// and the standalone generated map
const sid = load(new Uint8Array(readFileSync(join(ROOT, 'tools/maps/out', `${name}.wad`))));
console.log(`map_load tools/maps/out/${name}.wad: ${sid}`);
if (ids[name] < 0 || sid < 0) process.exit(1);

if (!ex.world_new_cfg) { console.log('this wasm has no world_new_cfg; skipping the war run'); process.exit(0); }
const words = new Uint32Array([2, 3, slots, 0, 0, 0, 0, 0, 0, 0, 1, ids[name]]);
const p = ex.alloc(words.byteLength);
new Uint32Array(ex.memory.buffer, p, words.length).set(words);
const h = ex.world_new_cfg(p, words.byteLength);
ex.dealloc(p, words.byteLength);
if (h <= 0) { console.error('world_new_cfg failed'); process.exit(1); }

const things = base.mapLumps(name).get('THINGS');
const pts = [];
for (let o = 0; o + 10 <= things.length; o += 10) {
  const dv = new DataView(things.buffer, things.byteOffset + o, 10);
  if (dv.getInt16(6, true) === 9010) pts.push({ x: dv.getInt16(0, true), y: dv.getInt16(2, true) });
}
const captures = [];
let kills = 0;
const reach = new Map(); // slot → max distance from spawn x
const t0 = performance.now();
const tics = seconds * 35;
const visits = pts.map(() => new Set());
for (let t = 0; t < tics; t++) {
  ex.world_tick(h);
  const ep = ex.world_events(h);
  const n = new Uint32Array(ex.memory.buffer, ep, 1)[0];
  const ev = i32(ep + 4, n * 8);
  for (let k = 0; k < n; k++) {
    if (ev[k * 8] === 2) kills++;
    if (ev[k * 8] === 12) captures.push({ t: (t / 35).toFixed(0), point: 'ABCDEFGH'[ev[k * 8 + 1]], team: ev[k * 8 + 2] ? 'blue' : 'red' });
  }
  if (t % 35 === 0) {
    const rp = ex.world_view_players(h);
    const cnt = new Uint32Array(ex.memory.buffer, rp, 1)[0];
    const width = 9;
    const rows = i32(rp + 4, cnt * width);
    for (let s = 0; s < cnt; s++) {
      const pv = i32(ex.world_view_player(h, s), 8);
      if (pv[2] !== 0) continue;
      const x = pv[3] / 65536, y = pv[4] / 65536;
      pts.forEach((q, i) => { if (Math.hypot(q.x - x, q.y - y) < 512) visits[i].add(s); });
      const team = rows[s * width + 8];
      const adv = team === 0 ? x + 10240 : 10240 - x;
      reach.set(s, Math.max(reach.get(s) ?? 0, adv));
    }
  }
}
const ms = performance.now() - t0;
const mp = ex.world_view_match(h);
const head = i32(mp, 13);
const np = head[12];
const pv = i32(mp + 52, np * 6);
console.log(`${name} war, ${slots} bots, ${seconds} s: ${(ms / tics).toFixed(2)} ms/tic, ${kills} kills, tickets red ${head[6]} blue ${head[7]}, phase ${head[1]}`);
console.log(`points: ${pts.map((q, i) => `${'ABCDE'[i]} owner ${pv[i * 6 + 3]} progress ${pv[i * 6 + 4]} visited by ${visits[i].size} bots`).join(' | ')}`);
console.log(`captures: ${captures.map((c) => `${c.t}s ${c.point}→${c.team}`).join(', ') || 'none'}`);
const adv = [...reach.values()].sort((a, b) => a - b);
console.log(`advance from own map edge: median ${adv[adv.length >> 1]?.toFixed(0)}, 90th pct ${adv[Math.floor(adv.length * 0.9)]?.toFixed(0)}, max ${adv[adv.length - 1]?.toFixed(0)} (centre is 10240)`);
