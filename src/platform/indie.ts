/**
 * The indie.fun SDK (https://www.indie.fun/js/indie.js), in the indie.fun
 * export only: `npm run export:indiefun` bakes `VITE_INDIE_APP_ID` into the
 * bundle. Every other build has no App ID, loads nothing and sends nothing -
 * each call below is then a no-op.
 *
 * What the SDK gives a page by being constructed: sessions and their length,
 * frame rate, and crash reports, on indie.fun's game dashboard. On top of that
 * we report a progression funnel (PROGRESSION) and the player's best frag count
 * in an online match as their score, for indie.fun's per-game leaderboard.
 *
 * `login: false`: the SDK's own login pill stays out. A match is joined on the
 * ARRR network, whose nodes take an ARRR session token and nothing else, so an
 * indie.fun sign-in would buy the player nothing in the game - and a second
 * "Sign in" button next to "Sign in with ARRR" would only confuse. Everything
 * else the SDK measures does not need a signed-in player.
 *
 * The App ID is public (the SDK sends it on every request); the App SECRET is
 * not, and has no place in this page.
 *
 * Nothing here may break the game: a blocked or offline SDK just means no
 * analytics.
 */

const SDK_URL = 'https://www.indie.fun/js/indie.js';

export const INDIE_APP_ID = (import.meta.env?.VITE_INDIE_APP_ID ?? '').trim();

/** The milestones, in the order a player meets them. */
const PROGRESSION = ['menu', 'match_joined', 'first_frag', 'match_finished'] as const;
export type IndieStep = (typeof PROGRESSION)[number];

/** The part of the browser SDK's `IndieClient` this page calls. */
interface IndieClient {
  progress(step: string): void;
  submitScore(score: number): void;
}
type IndieCtor = new (cfg: { appId: string; login?: boolean; progression?: string[] }) => IndieClient;

let client: IndieClient | null = null;
/** Calls made before the SDK arrived, replayed once it has. */
const queued: ((c: IndieClient) => void)[] = [];

function call(fn: (c: IndieClient) => void): void {
  if (!INDIE_APP_ID) return;
  if (!client) { if (queued.length < 64) queued.push(fn); return; }
  try { fn(client); } catch (err) { console.warn('[indie]', err); }
}

/** Load the SDK and construct the client. Once, at boot; a no-op outside the indie.fun build. */
export function startIndie(): void {
  if (!INDIE_APP_ID || document.querySelector('script[data-indie-sdk]')) return;
  const s = document.createElement('script');
  s.src = SDK_URL;
  s.async = true;
  s.dataset.indieSdk = '1';
  s.onload = () => {
    const Ctor = (window as unknown as { Indie?: IndieCtor }).Indie;
    if (!Ctor) { console.warn('[indie] SDK loaded but window.Indie is missing'); return; }
    try {
      client = new Ctor({ appId: INDIE_APP_ID, login: false, progression: [...PROGRESSION] });
    } catch (err) { console.warn('[indie] SDK failed to start:', err); return; }
    for (const fn of queued.splice(0)) call(fn);
  };
  s.onerror = () => console.warn(`[indie] could not load ${SDK_URL}; playing without it`);
  document.head.appendChild(s);
}

export function indieProgress(step: IndieStep): void { call((c) => c.progress(step)); }

/** Frags in an online match. The SDK keeps the best and coalesces the requests, so every change may be sent. */
export function indieScore(frags: number): void { if (frags > 0) call((c) => c.submitScore(frags)); }
