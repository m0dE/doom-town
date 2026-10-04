/**
 * The installed mods: public/mods/index.json (built by `npm run mods`), imported at build
 * time so a room's game stays a pure, synchronous function of its name. Mods loaded from
 * a file or a URL for playtesting (offline only) are registered at runtime.
 */
import installed from '../../public/mods/index.json';
import type { ModEntry, ModInfo, ModModeName } from './modinfo.js';
import { MOD_MODES } from './modinfo.js';

const mods = new Map<string, ModEntry>();
for (const m of installed as ModEntry[]) {
  if (m && typeof m.id === 'string' && m.mode in MOD_MODES) mods.set(m.id, { ...m });
}

/** The mods the server list and the host picker offer, in index order. */
export function installedMods(): ModEntry[] {
  return (installed as ModEntry[]).map((m) => mods.get(m.id)).filter((m): m is ModEntry => !!m);
}

export function modById(id: string): ModEntry | null { return mods.get(id) ?? null; }

/** A mod read from a file or URL (playtesting): known to roomGame from now on, by its id. */
export function registerMod(info: ModInfo, bytes: number): ModEntry {
  const e: ModEntry = { id: info.id, title: info.title, author: info.author, mode: info.mode as ModModeName, map: info.map, slots: info.slots ?? 64, bytes, description: info.description, info };
  mods.set(info.id, e);
  return e;
}

/** Keep the parsed MODINFO of an installed mod once its file has been fetched. */
export function attachInfo(id: string, info: ModInfo): void {
  const e = mods.get(id);
  if (e) e.info = info;
}
