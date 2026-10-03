// Freedoom art lookup shared by the pak builder (tools/build-pak.mjs) and the mod packer
// (tools/mods/pack.mjs): texture definitions (FreeDM first, then the Freedoom2 IWAD for
// anything FreeDM lacks), flats, patches, and the art one map needs (with switch partners,
// animation ranges and its sky).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wad } from '../../src/wad/wad.ts';
import { parsePnames, parseTextureLump } from '../../src/wad/texturedefs.ts';
import { ANIMDEFS, SWITCHES, skyTextureForMap, SKY_FLAT } from '../../src/wad/animdefs.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FREEDM = join(ROOT, 'assets', 'freedm.wad');
export const FREEDOOM2 = join(ROOT, 'assets', 'freedoom2.wad');

/** Both Freedoom WADs must be in assets/ (`npm run fetch` downloads and verifies them). */
export function requireFreedoomAssets() {
  const missing = [FREEDM, FREEDOOM2].filter((p) => !existsSync(p)).map((p) => `assets/${p.split('/').pop()}`);
  if (missing.length) throw new Error(`${missing.join(' and ')} missing: run \`npm run fetch\` first (downloads Freedoom 0.13.0, sha256-verified)`);
}

/** Loads assets/freedm.wad + assets/freedoom2.wad (throws with a hint when missing). */
export function loadArtSources() {
  requireFreedoomAssets();
  const wad = new Wad(new Uint8Array(readFileSync(FREEDM)));
  const extra = new Wad(new Uint8Array(readFileSync(FREEDOOM2)));
  const texOf = (w) => {
    const pn = parsePnames(w.get('PNAMES'));
    return [...parseTextureLump(w.get('TEXTURE1'), pn), ...(w.get('TEXTURE2') ? parseTextureLump(w.get('TEXTURE2'), pn) : [])];
  };
  const allTex = texOf(wad);
  const known = new Set(allTex.map((t) => t.name));
  if (extra) for (const t of texOf(extra)) if (!known.has(t.name)) { allTex.push(t); known.add(t.name); }
  const texIndex = new Map(allTex.map((t, i) => [t.name, i]));
  const texByName = new Map(allTex.map((t) => [t.name, t]));
  const flatNs = [...wad.namespace('F').keys()];
  const extraFlatNs = extra ? [...extra.namespace('F').keys()].filter((n) => !wad.namespace('F').has(n)) : [];
  const allFlats = [...flatNs, ...extraFlatNs]; // namespace order, FreeDM first
  const flatPos = new Map(allFlats.map((n, i) => [n, i]));
  const flatLump = (n) => wad.namespace('F').get(n)?.data ?? extra?.namespace('F').get(n)?.data;
  const patchLump = (n) => wad.nsLump('P', n)?.data ?? extra?.nsLump('P', n)?.data;

  /** Wall textures, flats and patches one map needs (with switch partners, animation ranges, sky). */
  function artOf(name, map) {
    const wantTex = new Set();
    const addTex = (n) => { if (n && n !== '-' && texIndex.has(n)) wantTex.add(n); };
    for (const s of map.sides) { addTex(s.top); addTex(s.mid); addTex(s.bottom); }
    addTex(skyTextureForMap(name));
    for (const [a, b] of SWITCHES) if (wantTex.has(a) || wantTex.has(b)) { addTex(a); addTex(b); }
    for (const a of ANIMDEFS.filter((d) => d.isTexture)) {
      const i0 = texIndex.get(a.first), i1 = texIndex.get(a.last);
      if (i0 === undefined || i1 === undefined) continue;
      let used = false;
      for (let i = i0; i <= i1; i++) if (wantTex.has(allTex[i].name)) used = true;
      if (used) for (let i = i0; i <= i1; i++) wantTex.add(allTex[i].name);
    }
    const wantFlat = new Set([SKY_FLAT]);
    for (const s of map.sectors) { if (flatPos.has(s.floorPic)) wantFlat.add(s.floorPic); if (flatPos.has(s.ceilPic)) wantFlat.add(s.ceilPic); }
    for (const a of ANIMDEFS.filter((d) => !d.isTexture)) {
      const i0 = flatPos.get(a.first), i1 = flatPos.get(a.last);
      if (i0 === undefined || i1 === undefined) continue;
      let used = false;
      for (let i = i0; i <= i1; i++) if (wantFlat.has(allFlats[i])) used = true;
      if (used) for (let i = i0; i <= i1; i++) wantFlat.add(allFlats[i]);
    }
    const patches = new Set();
    for (const t of wantTex) for (const p of texByName.get(t).patches) patches.add(p.patch.toUpperCase());
    const missing = new Set();
    for (const s of map.sides) for (const n of [s.top, s.mid, s.bottom]) if (n !== '-' && !texIndex.has(n)) missing.add(n);
    for (const s of map.sectors) for (const n of [s.floorPic, s.ceilPic]) if (!flatPos.has(n)) missing.add(n);
    return { tex: wantTex, flats: wantFlat, patches, missing };
  }

  /** P_START..P_END / F_START..F_END lumps for the given patch and flat names (missing patches reported). */
  function artLumps(patchNames, flatNames, missingPatch = new Set()) {
    const L = [];
    const put = (name, data) => L.push({ name, data: data ?? new Uint8Array(0) });
    if (patchNames.length) {
      put('P_START', null);
      for (const n of patchNames) { const d = patchLump(n); if (d) put(n, d); else missingPatch.add(n); }
      put('P_END', null);
    }
    if (flatNames.length) {
      put('F_START', null);
      for (const n of flatNames) put(n, flatLump(n));
      put('F_END', null);
    }
    return L;
  }
  const orderFlats = (set) => allFlats.filter((f) => set.has(f));

  return { wad, extra, allTex, texIndex, texByName, allFlats, flatPos, flatLump, patchLump, artOf, artLumps, orderFlats };
}
