#!/usr/bin/env node
// Builds the Rust playsim (games/doom/sim) to wasm32 and copies it to public/doomsim.wasm.
// Usage: node tools/build-sim.mjs            (release build)
// Requires a Rust toolchain with the wasm32-unknown-unknown target (rustup target add ...).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const simDir = join(root, 'sim')
const env = { ...process.env, PATH: `${join(homedir(), '.cargo', 'bin')}:${process.env.PATH ?? ''}` }

execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '--lib'], { cwd: simDir, env, stdio: 'inherit' })

const built = join(simDir, 'target', 'wasm32-unknown-unknown', 'release', 'doomsim.wasm')
const wasm = stripCustomSections(readFileSync(built))
// sanity: it must compile and export the ABI
const mod = new WebAssembly.Module(wasm)
const exports = WebAssembly.Module.exports(mod).map((e) => e.name)
for (const name of ['alloc', 'map_load', 'world_new', 'world_tick', 'world_serialize', 'world_deserialize', 'world_hash', 'world_view_mobjs', 'world_events', 'memory']) {
  if (!exports.includes(name)) throw new Error(`doomsim.wasm is missing export ${name}`)
}
const out = join(root, 'public', 'doomsim.wasm')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, wasm)
console.log(`wrote ${out} (${(wasm.length / 1024).toFixed(1)} KB)`)

/** drop custom sections (names, producers, target_features) — they only add size */
function stripCustomSections(buf) {
  const parts = [buf.subarray(0, 8)]
  let p = 8
  const leb = () => {
    let r = 0, s = 0, b
    do { b = buf[p++]; r |= (b & 0x7f) << s; s += 7 } while (b & 0x80)
    return r >>> 0
  }
  while (p < buf.length) {
    const start = p
    const id = buf[p++]
    const size = leb()
    const end = p + size
    if (id !== 0) parts.push(buf.subarray(start, end))
    p = end
  }
  return Buffer.concat(parts)
}
