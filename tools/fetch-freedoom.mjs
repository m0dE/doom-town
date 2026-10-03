#!/usr/bin/env node
// Downloads the Freedoom 0.13.0 data the tools need (BSD-3-Clause, https://freedoom.github.io)
// into assets/ (gitignored), every zip and every extracted WAD pinned by sha256:
//   assets/freedm.wad     FreeDM: the game's data (sprites, sounds, the textures and flats
//                         the base pak and the shipped maps use)
//   assets/freedoom2.wad  Freedoom Phase 2 IWAD: the extra textures and flats generated maps
//                         and mods may use beyond FreeDM (tools/lib/art.mjs, the map DSL)
// No dependencies: zip entries are inflated with node's zlib.inflateRawSync.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'assets');
const REL = 'https://github.com/freedoom/freedoom/releases/download/v0.13.0';
const FILES = [
  { wad: 'freedm.wad', wadSha: 'd9adc4d792627e7fc47b09067b15486da724010c71dd12831e1cf8e0755b68ad',
    zip: 'freedm-0.13.0.zip', zipSha: 'b420f13508ef745d7b38e83d15e55e0fc0b09d9a503c96741cddd9773d43f7c9' },
  { wad: 'freedoom2.wad', wadSha: 'a8772e088847032510d97ba2312406a6998f21cbab44d4ff10696faa9c0ecd4b',
    zip: 'freedoom-0.13.0.zip', zipSha: '3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59' },
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** The named entry of a zip (walks the central directory: local header sizes may be zero). */
function unzipEntry(zip, wanted) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: no end of central directory');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory');
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.split('/').pop().toLowerCase() !== wanted) continue;
    const lNameLen = zip.readUInt16LE(local + 26);
    const lExtraLen = zip.readUInt16LE(local + 28);
    const data = zip.subarray(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + csize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data);
    throw new Error(`zip: unsupported compression method ${method}`);
  }
  throw new Error(`zip: ${wanted} not found`);
}

mkdirSync(ASSETS, { recursive: true });
for (const f of FILES) {
  const wadPath = join(ASSETS, f.wad), zipPath = join(ASSETS, f.zip);
  if (existsSync(wadPath) && sha256(readFileSync(wadPath)) === f.wadSha) {
    console.log(`assets/${f.wad} present and verified`);
    continue;
  }
  let zip;
  if (existsSync(zipPath) && sha256(readFileSync(zipPath)) === f.zipSha) {
    zip = readFileSync(zipPath);
  } else {
    const url = `${REL}/${f.zip}`;
    console.log('downloading', url);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    zip = Buffer.from(await res.arrayBuffer());
    const got = sha256(zip);
    if (got !== f.zipSha) throw new Error(`${f.zip} sha256 mismatch: ${got}`);
    writeFileSync(zipPath, zip);
  }
  const wad = unzipEntry(zip, f.wad);
  const got = sha256(wad);
  if (got !== f.wadSha) throw new Error(`${f.wad} sha256 mismatch: ${got}`);
  writeFileSync(wadPath, wad);
  console.log(`wrote assets/${f.wad} (${wad.length} bytes)`);
}
