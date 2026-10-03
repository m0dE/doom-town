#!/usr/bin/env node
// Smoke test of public/doomsim.wasm from Node: extracts MAP19 from assets/freedm.wad into a
// one-map PWAD, creates a 64-slot world, runs 30 s of tics, serializes/deserializes and
// checks the copies step identically, and prints a summary.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAP = process.argv[2] ?? 'MAP19'
const SLOTS = 64
const TICS = 35 * 30

// ---- minimal WAD extraction
function lumps(buf) {
  const n = buf.readInt32LE(4), off = buf.readInt32LE(8)
  const out = []
  for (let i = 0; i < n; i++) {
    const p = off + i * 16
    const pos = buf.readInt32LE(p), size = buf.readInt32LE(p + 4)
    const name = buf.toString('latin1', p + 8, p + 16).replace(/\0.*$/, '')
    out.push({ name, data: buf.subarray(pos, pos + size) })
  }
  return out
}
function mapPwad(wad, name) {
  const ls = lumps(wad)
  const i = ls.findIndex((l) => l.name === name)
  if (i < 0) throw new Error(`${name} not in wad`)
  const want = ['THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS', 'SSECTORS', 'NODES', 'SECTORS', 'REJECT', 'BLOCKMAP']
  const sel = [{ name, data: Buffer.alloc(0) }, ...want.map((w) => ls.slice(i + 1, i + 12).find((l) => l.name === w))]
  const dataLen = sel.reduce((a, l) => a + l.data.length, 0)
  const out = Buffer.alloc(12 + dataLen + sel.length * 16)
  out.write('PWAD', 0, 'latin1')
  out.writeInt32LE(sel.length, 4)
  out.writeInt32LE(12 + dataLen, 8)
  let pos = 12, dir = 12 + dataLen
  for (const l of sel) {
    l.data.copy(out, pos)
    out.writeInt32LE(pos, dir); out.writeInt32LE(l.data.length, dir + 4)
    out.write(l.name.padEnd(8, '\0'), dir + 8, 8, 'latin1')
    pos += l.data.length; dir += 16
  }
  return out
}

// ---- load the module
const wasmBytes = readFileSync(join(root, 'public', 'doomsim.wasm'))
const { instance } = await WebAssembly.instantiate(wasmBytes, {})
const ex = instance.exports
const mem = () => new Uint8Array(ex.memory.buffer)
const i32 = (ptr, n) => new Int32Array(ex.memory.buffer, ptr, n).slice()
const names = (ptr) => {
  const m = mem(); const out = []; let at = ptr
  for (;;) {
    let s = ''
    while (m[at] !== 0) s += String.fromCharCode(m[at++])
    at++
    if (s === '' && out.length > 0) break
    out.push(s)
  }
  return out
}
const pass = (bytes) => { const p = ex.alloc(bytes.length); mem().set(bytes, p); return p }
let failures = 0
const check = (ok, msg) => { if (!ok) { failures++; console.error('FAIL:', msg) } }

const pwad = mapPwad(readFileSync(join(root, 'assets', 'freedm.wad')), MAP)
const wp = pass(pwad)
const t0 = performance.now()
const mapId = ex.map_load(wp, pwad.length)
ex.dealloc(wp, pwad.length)
check(mapId >= 0, `map_load returned ${mapId}`)
console.log(`map_load ${MAP}: id ${mapId} in ${(performance.now() - t0).toFixed(1)} ms; sim_version ${ex.sim_version()}`)
const sprites = names(ex.sim_sprite_names()), sounds = names(ex.sim_sound_names())
const tex = names(ex.world_map_texture_names(mapId)), flats = names(ex.world_map_flat_names(mapId))
console.log(`sprites ${sprites.length} (${sprites.slice(0, 4).join(',')}…) sounds ${sounds.length} textures ${tex.length} flats ${flats.length}`)
check(sprites.length === 138 && sounds.length === 109 && tex[0] === '-', 'name tables')

const h = ex.world_new(mapId, 1234, SLOTS)
check(h > 0, 'world_new')
ex.world_human_join(h, 0)
check(ex.world_free_slot(h) === 1, 'free slot after join')
let events = 0, kills = 0, sounds1 = 0
const t1 = performance.now()
for (let t = 0; t < TICS; t++) {
  // a human in slot 0 that runs forward, turns slowly and fires
  ex.world_set_cmd(h, 0, (t * 64) & 0xffff, 0, 50, 0, t % 10 < 5 ? 1 : 0)
  ex.world_tick(h)
  const ep = ex.world_events(h)
  const n = new Uint32Array(ex.memory.buffer, ep, 1)[0]
  events += n
  const ev = i32(ep + 4, n * 8)
  for (let k = 0; k < n; k++) { if (ev[k * 8] === 2) kills++; if (ev[k * 8] === 1) sounds1++ }
}
const ms = performance.now() - t1
console.log(`${TICS} tics in ${ms.toFixed(0)} ms (${(ms / TICS).toFixed(3)} ms/tic), ${events} events, ${kills} kills, ${sounds1} sounds`)
check(ex.world_tic(h) === TICS, 'world_tic')

// views
const mp = ex.world_view_mobjs(h)
const nm = new Uint32Array(ex.memory.buffer, mp, 1)[0]
const pv = i32(ex.world_view_player(h, 0), 48)
const pr = ex.world_view_players(h)
const np = new Uint32Array(ex.memory.buffer, pr, 1)[0]
// each view buffer is only valid until the next call on the same world: read right away
const nsec = new Uint32Array(ex.memory.buffer, ex.world_view_sectors(h), 1)[0]
const nlin = new Uint32Array(ex.memory.buffer, ex.world_view_lines(h), 1)[0]
console.log(`mobjs ${nm}; player0 health ${pv[9]} weapon ${pv[12]} frags ${pv[33]} human ${pv[42]}; players ${np}; sectors ${nsec}; lines ${nlin}`)
check(np === SLOTS && nm > 100 && nsec > 0 && nlin > nsec, 'views')

// serialize / deserialize / clone
const len = ex.world_serialize(h)
const bytes = mem().slice(ex.world_buf_ptr(), ex.world_buf_ptr() + len)
const bp = pass(bytes)
const h2 = ex.world_deserialize(mapId, bp, bytes.length)
ex.dealloc(bp, bytes.length)
check(h2 > 0, 'world_deserialize')
const h3 = ex.world_clone(h)
check(ex.world_hash(h) === ex.world_hash(h2) && ex.world_hash(h) === ex.world_hash(h3), 'hash after copy')
for (let t = 0; t < 35 * 5; t++) {
  for (const w of [h, h2, h3]) { ex.world_set_cmd(w, 0, 1000, -2000, 25, 10, 4); ex.world_tick(w) }
  const a = ex.world_hash(h), b = ex.world_hash(h2), c = ex.world_hash(h3)
  if (a !== b || a !== c) { check(false, `diverged at +${t}: ${a} ${b} ${c}`); break }
}
// bad data must be rejected, not crash
const junk = pass(bytes.slice(0, 100))
check(ex.world_deserialize(mapId, junk, 100) === 0, 'reject truncated data')
console.log(`serialized ${len} bytes; hash ${(ex.world_hash(h) >>> 0).toString(16)}; copies in sync`)
ex.world_free(h); ex.world_free(h2); ex.world_free(h3)
if (failures) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('OK')
