/**
 * Who a slot is, for the scoreboard and the killfeed.
 *
 * Bots must read like players: a handle drawn per slot from a list (seeded by
 * the room so every client agrees, and different rooms differ), and a latency
 * that looks like someone's connection - a base per bot, wandering slowly.
 * Humans are named by the `{ n, col }` app message they broadcast, or the name
 * they joined with.
 */

const HANDLES = [
  'Ripper', 'xXdoomXx', 'Kronos', 'mancubus_mike', 'Vex', 'Tank', 'Hollow', 'B4rr3l', 'nightfall', 'Gibsy',
  'PlasmaPete', 'Rook', 'saw_n_order', 'Kestrel', 'Grim', 'Moss', 'IceBreaker', 'Torque', 'Lazarus', 'Jinx',
  'rocketjump', 'Sable', 'Fennec', 'Blitz', 'Quill', 'Overkill', 'Wraith', 'Pyro', 'deathwish', 'Nova',
  'cacodemon', 'Vulture', 'zer0', 'Hex', 'Maverick', 'Shrike', 'Juggernaut', 'tele_frag', 'Echo', 'Riot',
  'BFGenius', 'Mortis', 'Viper', 'Dread', 'snipe', 'Caliber', 'Havoc', 'Onyx', 'Splat', 'Fury',
  'gl_hf', 'Stalker', 'Brimstone', 'Crash', 'Phantom', 'Ash', 'Bolt', 'Ember', 'Scrap', 'Doomslayer99',
  'Krieg', 'Mako', 'Rampage', 'Talon', 'Cinder', 'Ghoul', 'impaler', 'Banshee', 'Raze', 'Slug',
  'Volt', 'Crimson', 'Warden', 'Zealot', 'pinky', 'Revenant', 'Specter', 'chaingunner', 'Atlas', 'Shade',
  'Cyber', 'Frost', 'Gunner', 'Lurker', 'Marrow', 'Nails', 'Oxide', 'Picket', 'Quake', 'Rust',
  'Skulltaker', 'Thorn', 'Umbra', 'Vandal', 'Wolf', 'Xeno', 'Yeti', 'Zap', 'arch_vile', 'hellknight',
];

function mix(seed: number, n: number): number {
  let h = (seed ^ Math.imul(n + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function roomSeed(room: string): number {
  let h = 2166136261;
  for (let i = 0; i < room.length; i++) h = Math.imul(h ^ room.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A permutation of the handles for the room, so no two bots share one. */
export function botNames(room: string, slots: number): string[] {
  const seed = roomSeed(room);
  const order = HANDLES.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = mix(seed, i) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const out: string[] = [];
  for (let s = 0; s < slots; s++) out.push(HANDLES[order[s % order.length]] + (s >= order.length ? String(s) : ''));
  return out;
}

/** A plausible ping for a bot, ms: a base per (room, slot) and a slow wander. */
export function botPing(room: string, slot: number, nowMs: number): number {
  const r = mix(roomSeed(room), slot + 1000);
  const base = 18 + (r % 120);
  const wander = Math.sin(nowMs / 7000 + (r % 628) / 100) * 6 + Math.sin(nowMs / 2300 + slot) * 2;
  return Math.max(5, Math.round(base + wander));
}
