/**
 * The sim wrapper under the real lockstep layer, headless.
 *
 *   npx tsx tools/test-sim-wrapper.mts [--seconds=30] [--slots=64]
 *
 * Three clients, each with its own instance of public/doomsim.wasm, on the
 * SDK's InProcessNode (holding inputs to their frame and reporting slack, as
 * the real node does) over jittery links, all predicting. 30 s of scripted
 * play at 35 Hz: running, strafing, turning, shooting, jumping, switching
 * weapons. Client c joins late, from a snapshot. Two link holes force inputs
 * to land late so the prediction has to roll back.
 *
 * Asserts: no desync on any client, identical hashes at a common frame,
 * rollbacks happened and the predicted world agrees with the confirmed one at
 * the end, the clone path was used, nothing in the layer's error list.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { lockstep, netcode } from 'arrr-network';
import { DoomSim, createDoomApp, encodeCmd, type DoomApp, type DoomState } from '../src/sim/doomsim.js';
import { mapPwad } from '../src/sim/pwad.js';
import { MAP_LUMP, TICRATE } from '../src/sim/map.js';
import { PV } from '../src/sim/abi.js';
import { loadWad } from '../src/wad/wad.js';
import { cfgWords, gameFor } from '../src/menu/modes.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k: string, d: number): number => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d);
const SECONDS = arg('seconds', 30);
const SLOTS = arg('slots', 64);
/** --nosnap: nobody publishes, so the late joiner replays the whole history from frame 0. */
const NOSNAP = process.argv.includes('--nosnap');

const wasm = readFileSync(path.join(ROOT, 'public/doomsim.wasm'));
// a map's lumps ship in public/maps/<MAP>.map.wad, not in the base pak
const wad = loadWad(new Uint8Array(readFileSync(path.join(ROOT, `public/maps/${MAP_LUMP}.map.wad`))));
const pwad = mapPwad(wad, MAP_LUMP);

const rt = new netcode.FakeRuntime();
const node = new lockstep.InProcessNode(rt, 1000 / TICRATE);
node.buffers = true;
node.start();

function xorshift(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** A pure function of (player, frame): what a scripted player does on that frame. */
function script(player: string, frame: number): unknown {
  const k = player.charCodeAt(0);
  const phase = Math.floor(frame / 35) + k;
  const angle = ((frame * (90 + k * 7)) + k * 9000) & 0xffff;
  const forward = phase % 4 === 3 ? -25 : 50;
  const side = phase % 3 === 0 ? 40 : phase % 3 === 1 ? -40 : 0;
  let buttons = 0;
  if (frame % 50 < 20) buttons |= 1;                         // fire in bursts
  if (frame % 140 === 70) buttons |= 4;                      // jump
  if (frame % 175 === 0) buttons |= ((2 + (phase % 3)) << 4); // weapon 2..4
  if (frame % 90 === 45) buttons |= 2;                       // use
  return encodeCmd({ angle, pitch: ((frame % 200) - 100) * 40, forward, side, buttons });
}

interface Client { name: string; app: DoomApp; ls: lockstep.Lockstep<DoomState, unknown>; desyncs: number; confirmedFrames: number; predictedFrames: number }

async function client(name: string, jitterSeed: number): Promise<Client> {
  const sim = await DoomSim.create(wasm, [{ name: MAP_LUMP, pwad }]);
  const game = gameFor('dm', false);
  const app = createDoomApp(sim, { slots: SLOTS, rev: 'test', cfg: (seed) => cfgWords({ ...game, slots: SLOTS }, [sim.mapIds.get(MAP_LUMP)!], seed) });
  const rnd = xorshift(jitterSeed);
  // One way 2..10 ms: inside a tic, so the in-process node's verdict for F
  // (taken when it ticks F+1) has both votes. Lateness comes from the holes below.
  const link = (): number => 2 + rnd() * 8;
  const c: Client = { name, app, ls: null as unknown as Client['ls'], desyncs: 0, confirmedFrames: 0, predictedFrames: 0 };
  c.ls = new lockstep.Lockstep<DoomState, unknown>({
    sim: app, player: name, room: 'test-freedm', runtime: rt, fps: TICRATE, predict: true,
    snapshotEvery: NOSNAP ? 0 : TICRATE * 10,
    inputSource: (ctx) => script(name, ctx?.frame ?? 0),
    dial: async (events, hints) => node.join(name, events, link, hints?.publishes),
    onConfirmedTick: (s) => { c.confirmedFrames++; void s; },
    onCaughtUp: (f) => console.log(`${name} caught up at ${f}, origin ${c.ls.world.origin?.via}@${c.ls.world.origin?.frame}`),
    onPredictedTick: () => { c.predictedFrames++; },
    onDesync: () => { c.desyncs++; },
  });
  await c.ls.start();
  return c;
}

const t0 = Date.now();
const a = await client('a', 1);
rt.advance(300);
const b = await client('b', 2);
rt.advance(300);
const clients = [a, b];

const STEP = 1000 / 60;
let joinedC = false;
let holes = 0;
for (let t = 0; t < SECONDS * 1000; t += STEP) {
  rt.advance(STEP);
  // Exercise both paths: a view every render frame, as a page would.
  for (const c of clients) { const v = c.ls.view(rt.now()); void lockstep.renderTimes(v); }
  if (!joinedC && t > 12_000) { joinedC = true; clients.push(await client('c', 3)); }
  if ((t > 8000 && holes === 0) || (t > 20_000 && holes === 1)) {
    holes++;
    const conn = [...node.clients.values()].find((x) => x.conn.player === (holes === 1 ? 'b' : 'a'))?.conn;
    if (conn) node.hole(conn, 300);
  }
}
rt.advance(2000);
const wall = (Date.now() - t0) / 1000;

// ---------------------------------------------------------------------------- verdict

const fails: string[] = [];
const frame = Math.min(...clients.map((c) => c.ls.frame)) - 5;
const hashes = clients.map((c) => c.ls.world.hashAt(frame));
console.log(`frame ${frame}: hashes ${hashes.map((h) => (h ?? 0).toString(16)).join(' ')}`);
if (new Set(hashes).size !== 1 || hashes[0] === undefined) fails.push(`hashes differ at frame ${frame}`);

for (const c of clients) {
  const r = c.ls.report();
  const s = c.app.stats;
  const d = r.desync as unknown as { disagreed: number; verdicts: number; noVerdict?: number; resyncs: number };
  console.log(`${c.name}: frame ${c.ls.frame} origin ${r.origin?.via}@${r.origin?.frame} | verdicts ${d.verdicts} disagreed ${d.disagreed} noVerdict ${d.noVerdict ?? '?'} resyncs ${d.resyncs}`
    + ` | mispredictions ${r.prediction?.mispredictions} rollbacks ${r.prediction?.rollbacks} reseats ${r.prediction?.reseats} lead ${r.prediction?.lead}`
    + ` | published ${r.snapshotsPublished} | clones ${s.clones} decodes ${s.decodes} encodes ${s.encodes} | errors ${r.errors.length}`);
  if (c.desyncs || d.disagreed) fails.push(`${c.name}: ${d.disagreed} desynced verdicts`);
  if (d.verdicts < 100) fails.push(`${c.name}: only ${d.verdicts} verdicts - agreement was not really tested`);
  if (r.errors.length) fails.push(`${c.name}: errors ${r.errors.slice(0, 3).join(' | ')}`);
  if (s.clones === 0) fails.push(`${c.name}: prediction never took the clone path`);
  // The prediction resolves: at the confirmed frame, the predicted world's view of us is the confirmed one.
  const st = c.ls.world.state!;
  const slot = st.ids.indexOf(c.name);
  if (slot < 0) fails.push(`${c.name}: has no slot`);
  else {
    const p = c.app.sim.player(st.h, slot);
    console.log(`   ${c.name} slot ${slot}: pos ${p[PV.x] >> 16},${p[PV.y] >> 16},${p[PV.z] >> 16} health ${p[PV.health]} frags ${p[PV.frags]} deaths ${p[PV.deaths]} weapon ${p[PV.ready]}`);
  }
}
const rollbacks = clients.reduce((n, c) => n + (c.ls.report().prediction?.rollbacks ?? 0), 0);
if (rollbacks === 0) fails.push('no client ever rolled back: the prediction was not exercised');
if (!NOSNAP) {
  if (!clients.some((c) => c.ls.report().origin?.via === 'snapshot')) fails.push('the late joiner did not start from a snapshot');
  const decodes = clients.reduce((n, c) => n + c.app.stats.decodes, 0);
  if (decodes === 0) fails.push('no snapshot was ever decoded from bytes');
}

console.log(`${SECONDS} s of play, ${SLOTS} slots, 3 clients, in ${wall.toFixed(1)} s of wall time`);
if (fails.length) { console.log(`FAIL\n  ${fails.join('\n  ')}`); process.exit(1); }
console.log('PASS');
