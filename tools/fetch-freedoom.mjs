#!/usr/bin/env node
// Downloads FreeDM 0.13.0 (BSD-3-Clause, https://freedoom.github.io) and extracts
// freedm.wad into assets/. Both the zip and the wad are pinned by sha256.
// No dependencies: the zip entry is inflated with node's zlib.inflateRawSync.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'assets');
const ZIP_URL = 'https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedm-0.13.0.zip';
const ZIP_SHA = 'b420f13508ef745d7b38e83d15e55e0fc0b09d9a503c96741cddd9773d43f7c9';
const WAD_SHA = 'd9adc4d792627e7fc47b09067b15486da724010c71dd12831e1cf8e0755b68ad';
const WAD_PATH = join(ASSETS, 'freedm.wad');
const ZIP_PATH = join(ASSETS, 'freedm-0.13.0.zip');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

if (existsSync(WAD_PATH) && sha256(readFileSync(WAD_PATH)) === WAD_SHA) {
  console.log('assets/freedm.wad present and verified');
  process.exit(0);
}

let zip;
if (existsSync(ZIP_PATH) && sha256(readFileSync(ZIP_PATH)) === ZIP_SHA) {
  zip = readFileSync(ZIP_PATH);
} else {
  console.log('downloading', ZIP_URL);
  const res = await fetch(ZIP_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  zip = Buffer.from(await res.arrayBuffer());
  const got = sha256(zip);
  if (got !== ZIP_SHA) throw new Error(`zip sha256 mismatch: ${got}`);
  mkdirSync(ASSETS, { recursive: true });
  writeFileSync(ZIP_PATH, zip);
}

// Walk the central directory (sizes in local headers may be zero when a data
// descriptor is used, the central directory always has them).
let eocd = -1;
for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
  if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error('zip: no end of central directory');
const count = zip.readUInt16LE(eocd + 10);
let p = zip.readUInt32LE(eocd + 16);
let wad = null;
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
  if (!/(^|\/)freedm\.wad$/i.test(name)) continue;
  const lNameLen = zip.readUInt16LE(local + 26);
  const lExtraLen = zip.readUInt16LE(local + 28);
  const data = zip.subarray(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + csize);
  wad = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : null;
  if (!wad) throw new Error(`zip: unsupported compression method ${method}`);
}
if (!wad) throw new Error('zip: freedm.wad not found');
const got = sha256(wad);
if (got !== WAD_SHA) throw new Error(`freedm.wad sha256 mismatch: ${got}`);
writeFileSync(WAD_PATH, wad);
console.log(`wrote assets/freedm.wad (${wad.length} bytes)`);
