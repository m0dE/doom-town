#!/usr/bin/env node
/**
 * The web build, packaged for arrr.fun (after vibe-strike's tools/export.mjs).
 *
 *   npm run export                    # typecheck, build, zip into export/
 *   npm run export -- --no-build      # re-zip what is already in export/doom-town
 *
 * Writes:
 *   export/doom-town/          the site (index.html at its root, relative URLs only)
 *   export/doom-town.zip       the upload: deterministic (fixed timestamps, sorted entries)
 *   export/BUILD.txt        what this build is: commit, app id, sizes, sha256
 *
 * The site carries LICENSE.txt and the Freedoom data's COPYING and CREDITS;
 * the start screen's footer links the source to the public repository,
 * https://github.com/m0dE/doom-town.
 *
 * arrr.fun's rules, checked here before an upload rather than after: index.html
 * at the zip root, at most 5000 files and 100 MiB inflated, no absolute asset
 * paths, no symlinks, no zip64.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const flag = (name) => process.argv.includes(`--${name}`);

const SLUG = arg('slug', 'doom-town');
const OUT = path.resolve(ROOT, arg('out', 'export'));
const SITE = path.join(OUT, SLUG);
const ZIP = path.join(OUT, `${SLUG}.zip`);
const MAX_FILES = 5000;
const MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_APP_ID = 'app_1791001468308_ac7590dffc2a';

const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
const fail = (why) => { console.error(`export refused: ${why}`); process.exit(1); };

// ---------------------------------------------------------------------------- build

if (!flag('no-build')) {
  console.log(`building into ${path.relative(ROOT, SITE)}/`);
  execFileSync('npx', ['tsc', '--noEmit'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('npx', ['vite', 'build', '--outDir', path.relative(ROOT, SITE), '--emptyOutDir'], { cwd: ROOT, stdio: 'inherit' });
}
if (!existsSync(path.join(SITE, 'index.html'))) fail(`no index.html in ${SITE} — run without --no-build`);

// ---------------------------------------------------------------------------- licences

copyFileSync(path.join(ROOT, 'LICENSE'), path.join(SITE, 'LICENSE.txt'));
copyFileSync(path.join(ROOT, 'assets', 'COPYING-FREEDOOM.txt'), path.join(SITE, 'COPYING-FREEDOOM.txt'));
copyFileSync(path.join(ROOT, 'assets', 'CREDITS-FREEDOOM.txt'), path.join(SITE, 'CREDITS-FREEDOOM.txt'));

let head = 'dev';
try { head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
let dirty = false;
try { dirty = execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: ROOT, encoding: 'utf8' }).trim() !== ''; } catch { /* not a checkout */ }

// ---------------------------------------------------------------------------- check

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else if (st.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

const files = walk(SITE);
const bytes = files.reduce((n, f) => n + statSync(path.join(SITE, f)).size, 0);
if (files.length > MAX_FILES) fail(`${files.length} files; arrr.fun takes at most ${MAX_FILES}`);
if (bytes > MAX_BYTES) fail(`${mib(bytes)}; arrr.fun takes at most ${mib(MAX_BYTES)}`);
const index = readFileSync(path.join(SITE, 'index.html'), 'utf8');
const absolute = [...index.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
if (absolute.length) fail(`index.html asks for ${absolute.length} file(s) by absolute path (${absolute[0]})`);
for (const need of ['doomsim.wasm', 'freedm-lite.wad', 'LICENSE.txt', 'COPYING-FREEDOOM.txt']) {
  if (!files.includes(need)) fail(`the site has no ${need}`);
}

// ---------------------------------------------------------------------------- zip

function crcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
}
let CRC = null;
function crc32(buf) { CRC ??= crcTable(); let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** A deterministic zip: entries in the order given, 1980-01-01 timestamps, no unix modes, no zip64. */
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x0021, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12); dir.writeUInt16LE(0x0021, 14); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28); dir.writeUInt32LE(0, 38); dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  if (offset > 0xfffffff0 || entries.length > 0xffff) throw new Error('zip too large for a non-zip64 archive');
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

mkdirSync(OUT, { recursive: true });
if (existsSync(ZIP)) rmSync(ZIP);
writeFileSync(ZIP, zip(files.map((f) => ({ name: f, data: readFileSync(path.join(SITE, f)) }))));
const zipped = statSync(ZIP).size;
const sha256 = createHash('sha256').update(readFileSync(ZIP)).digest('hex');
const appId = (process.env.VITE_ARRR_APP_ID || '').trim() || DEFAULT_APP_ID;

writeFileSync(path.join(OUT, 'BUILD.txt'), [
  'Doom Town — web build, generated by `npm run export` (tools/export.mjs). Do not edit.',
  '',
  `built from commit : ${head}${dirty ? ' (with uncommitted changes)' : ''}   (baked in as the build every other client must match)`,
  `app               : ${appId}   (rooms joined, and the app players sign in to)`,
  `api key baked in  : ${process.env.VITE_ARRR_API_KEY ? 'yes, from VITE_ARRR_API_KEY (not a secret)' : appId === DEFAULT_APP_ID ? "yes, the doom-town app's (src/menu/rooms.ts; not a secret)" : 'no'}`,
  `site              : ${SLUG}/  ${files.length} files, ${bytes} bytes`,
  `zip               : ${SLUG}.zip  ${zipped} bytes`,
  `zip sha256        : ${sha256}`,
  '',
].join('\n'));

console.log(`\n${path.relative(ROOT, SITE)}/  ${files.length} files, ${mib(bytes)}`);
console.log(`${path.relative(ROOT, ZIP)}  ${mib(zipped)}  sha256 ${sha256}`);
console.log(`app ${appId}, build ${head}`);
