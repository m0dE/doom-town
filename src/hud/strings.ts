/**
 * Words the HUD prints.
 *
 * Pickup messages are Doom's own (linuxdoom-1.10 d_englsh.h, id Software,
 * GPL-2.0), chosen by the type of the thing picked up as P_TouchSpecialThing
 * chooses them by its sprite. Obituaries follow ZDoom's multiplayer set.
 */

/** mobjtype_t index → d_englsh.h string. */
const PICKUPS: Record<number, string> = {
  43: 'Picked up the armor.',
  44: 'Picked up the MegaArmor!',
  45: 'Picked up a health bonus.',
  46: 'Picked up an armor bonus.',
  47: 'Picked up a blue keycard.',
  48: 'Picked up a red keycard.',
  49: 'Picked up a yellow keycard.',
  50: 'Picked up a yellow skull key.',
  51: 'Picked up a red skull key.',
  52: 'Picked up a blue skull key.',
  53: 'Picked up a stimpack.',
  54: 'Picked up a medikit.',
  55: 'Supercharge!',
  56: 'Invulnerability!',
  57: 'Berserk!',
  58: 'Partial Invisibility',
  59: 'Radiation Shielding Suit',
  60: 'Computer Area Map',
  61: 'Light Amplification Visor',
  62: 'MegaSphere!',
  63: 'Picked up a clip.',
  64: 'Picked up a box of bullets.',
  65: 'Picked up a rocket.',
  66: 'Picked up a box of rockets.',
  67: 'Picked up an energy cell.',
  68: 'Picked up an energy cell pack.',
  69: 'Picked up 4 shotgun shells.',
  70: 'Picked up a box of shotgun shells.',
  71: 'Picked up a backpack full of ammo!',
  72: 'You got the BFG9000!  Oh, yes.',
  73: 'You got the chaingun!',
  74: 'A chainsaw!  Find some meat!',
  75: 'You got the rocket launcher!',
  76: 'You got the plasma gun!',
  77: 'You got the shotgun!',
  78: 'You got the super shotgun!',
  // battle royale v2 (mobjtypes 141 sniper rifle, 143 grenade pack)
  141: 'You got the sniper rifle!',
  143: 'Picked up 2 grenades.',
};
const MEDIKIT = 54, MEDINEED = 'Picked up a medikit that you REALLY need!';
/** A clip dropped by a dead player is MT_CLIP too; Doom says the same thing. */

/** The message for a pickup, or null for a type with none. `health` is the player's after the pickup. */
export function pickupMessage(type: number, health: number): string | null {
  // P_TouchSpecialThing tests health < 25 BEFORE adding the 25: after it, < 50.
  if (type === MEDIKIT && health < 50) return MEDINEED;
  return PICKUPS[type] ?? null;
}

/** True for the pickups that are weapons (the face grins, the sound is wpnup). */
export function isWeaponPickup(type: number): boolean { return (type >= 72 && type <= 78) || type === 141; }

/** Means of death (DESIGN.md) → [obituary, suicide]. %o victim, %k killer. */
const OBITS: Record<number, [string, string]> = {
  0: ['%o died.', '%o died.'],
  1: ["%o chewed on %k's fist.", '%o punched himself out.'],
  2: ["%o was tickled by %k's pea shooter.", '%o shot himself.'],
  3: ["%o chowed down on %k's boomstick.", '%o shot himself.'],
  4: ["%o was mowed down by %k's chaingun.", '%o shot himself.'],
  5: ["%o rode %k's rocket.", '%o should have stood back.'],
  6: ["%o was melted by %k's plasma gun.", '%o melted himself.'],
  7: ["%o couldn't hide from %k's BFG.", '%o used the BFG wrong.'],
  8: ["%o was mowed over by %k's chainsaw.", '%o sawed himself.'],
  9: ["%o was splattered by %k's super shotgun.", '%o shot himself.'],
  10: ['%o was telefragged by %k.', '%o telefragged himself.'],
  11: ['%o mutated.', '%o mutated.'],
  12: ['%o was squished.', '%o was squished.'],
  13: ["%o was splattered by %k's rocket.", '%o should have stood back.'],
  14: ['%o was knocked into next week by %k.', '%o punched himself out.'],
  15: ['%o fell too far.', '%o fell too far.'],
  16: ['%o was caught outside the zone.', '%o was caught outside the zone.'],
  17: ['%o was run over by %k.', '%o ran himself over.'],
  18: ["%o caught %k's grenade.", '%o juggled a live grenade.'],
  19: ["%o was picked off by %k's sniper rifle.", '%o shot himself.'],
};

export interface ObitParts { before: string; killer: string | null; after: string; victimFirst: boolean }

/**
 * The obituary split around the names, so the HUD can colour them:
 * returns the template with %o and %k still in it.
 */
export function obituaryTemplate(mod: number, suicide: boolean, world: boolean): string {
  const pair = OBITS[mod] ?? OBITS[0];
  if (world) return mod === 0 || !pair[0].includes('%k') ? pair[0] : '%o died.';
  return suicide ? pair[1] : pair[0];
}

export function obituary(mod: number, victim: string, killer: string | null): string {
  const suicide = killer !== null && killer === victim;
  return obituaryTemplate(mod, suicide, killer === null).replace('%o', victim).replace('%k', killer ?? '');
}

/** 1 → "1st", 2 → "2nd", 11 → "11th", 22 → "22nd". */
export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}
