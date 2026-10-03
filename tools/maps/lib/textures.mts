// Texture / flat names available to generated maps (FreeDM first, then the Freedoom2 IWAD).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wad } from '../../../src/wad/wad.ts';
import { parsePnames, parseTextureLump } from '../../../src/wad/texturedefs.ts';
import { ROOT } from './paths.mts';

export const FREEDOOM2 = '/app/data/home/doom-ref/freedoom-0.13.0/freedoom2.wad';

export function textureInfo(): { width: Map<string, number>; flats: Set<string>; extraTex: Set<string>; extraFlats: Set<string> } {
  const width = new Map<string, number>();
  const flats = new Set<string>();
  const extraTex = new Set<string>(), extraFlats = new Set<string>();
  const load = (path: string, extra: boolean) => {
    const w = new Wad(new Uint8Array(readFileSync(path)));
    const pn = parsePnames(w.get('PNAMES')!);
    for (const t of ['TEXTURE1', 'TEXTURE2']) {
      const l = w.get(t);
      if (!l) continue;
      for (const d of parseTextureLump(l, pn)) if (!width.has(d.name)) { width.set(d.name, d.width); if (extra) extraTex.add(d.name); }
    }
    for (const f of w.namespace('F').keys()) if (!flats.has(f)) { flats.add(f); if (extra) extraFlats.add(f); }
  };
  load(join(ROOT, 'assets/freedm.wad'), false);
  if (existsSync(FREEDOOM2)) load(FREEDOOM2, true);
  return { width, flats, extraTex, extraFlats };
}
