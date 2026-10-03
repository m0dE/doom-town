/**
 * The PWAD `map_load` takes: exactly one map's marker and its ten lumps
 * (DESIGN.md), cut out of whichever WAD holds the map.
 */
import { buildWadFile, type Wad } from '../wad/wad.js';
import { MAP_LUMPS } from './map.js';

export function mapPwad(wad: Wad, map: string): Uint8Array {
  const lumps = wad.mapLumps(map);
  const parts: { name: string; data: Uint8Array }[] = [{ name: map.toUpperCase(), data: new Uint8Array(0) }];
  for (const name of MAP_LUMPS) {
    const data = lumps.get(name);
    if (!data) throw new Error(`${map} has no ${name}`);
    parts.push({ name, data });
  }
  return buildWadFile(parts, 'PWAD');
}
