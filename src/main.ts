/**
 * Boot: the start screen, then a match.
 *
 * URL parameters: ?room=<name> joins that room, ?offline=1 plays alone with
 * bots on a local loopback, ?name=<name>, ?autostart=1 skips the menu (tests),
 * and the three the arrr harness aims a run with - ?central=<url>,
 * ?nodeUrl=<ws url> (or ?via=).
 *
 * While the menu is up the sim (doomsim.wasm), the game data and the game's
 * code are all fetched, so Play is instant.
 */
import './menu/menu.css';
import { prefetch, loadWad, onAssetProgress } from './game/assets.js';
import { Gfx } from './hud/gfx.js';
import { Doomguy } from './menu/doomguy.js';
import { PLAYER_COLORS, colorLabel } from './game/colors.js';
import { prefs, savePrefs, cleanName } from './menu/prefs.js';
import { ServerBrowser, esc } from './menu/serverbrowser.js';
import { Account, type AccountState } from './menu/account.js';
import { cleanRoomName } from './menu/rooms.js';
import { homeRegion, regionNodeUrl, regionRoomName } from './menu/regions.js';
import { MAP_TITLE } from './sim/map.js';
import type { Game } from './game/game.js';

declare const __BUILD_REV__: string;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const central = params.get('central') ?? undefined;

const menu = $('menu');
const nameIn = $<HTMLInputElement>('name');
const roomIn = $<HTMLInputElement>('room');
const errorBox = $('error');
const loading = $('loading');
const loadingBar = $('loading-bar');
const loadingLabel = $('loading-label');

$('map-title').textContent = MAP_TITLE;
$('build').textContent = `build ${typeof __BUILD_REV__ === 'string' ? __BUILD_REV__ : 'dev'}`;

// Everything a match needs starts downloading now.
prefetch();
const gameModule = import('./game/game.js');
gameModule.catch(() => { /* reported at Play */ });
/** The 3D view, built once the WAD is in and the page is idle - so Play does not wait for it. */
function prewarmView(): void {
  const go = (): void => { void gameModule.then((m) => m.Game.prewarm()).catch(() => { /* Play builds its own */ }); };
  if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 1500 }); else setTimeout(go, 300);
}
void loadWad().then(prewarmView).catch(() => { /* reported below */ });

// ------------------------------------------------------------------ you

const p0 = prefs();
nameIn.value = cleanName(params.get('name') ?? '') || p0.name;
nameIn.addEventListener('change', () => { const n = cleanName(nameIn.value); if (n) savePrefs({ name: n }); else nameIn.value = prefs().name; });
nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') nameIn.blur(); });

const guy = new Doomguy();
guy.mount($('doomguy'));
guy.setColor(p0.color);

const swatches = $('swatches');
const colorName = $('color-name');
function paintSwatches(sel: number): void {
  swatches.innerHTML = PLAYER_COLORS.map((c, i) =>
    `<button type="button" class="swatch" role="radio" aria-checked="${i === sel}" aria-label="${esc(colorLabel(i))}" title="${esc(colorLabel(i))}" data-c="${i}" style="background:${c.css}"></button>`).join('');
  colorName.textContent = colorLabel(sel);
}
paintSwatches(p0.color);
swatches.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLElement>('[data-c]');
  if (!b) return;
  const c = Number(b.dataset.c);
  savePrefs({ color: c });
  guy.setColor(c);
  paintSwatches(c);
});

// The WAD paints the marine, the logo and the backdrop once it is here.
void loadWad().then((wad) => {
  const gfx = new Gfx(wad);
  guy.setGfx(gfx);
  const logo = gfx.patch('M_DOOM');
  const lc = $<HTMLCanvasElement>('logo');
  if (logo) {
    lc.width = logo.width; lc.height = logo.height;
    lc.getContext('2d')!.drawImage(logo.canvas, 0, 0);
  } else lc.closest('.logo')?.classList.add('plain');
  const back = gfx.patch('INTERPIC') ?? gfx.patch('TITLEPIC');
  if (back) {
    const bc = $<HTMLCanvasElement>('backdrop');
    bc.width = back.width; bc.height = back.height;
    bc.getContext('2d')!.drawImage(back.canvas, 0, 0);
    bc.style.objectFit = 'cover';
  }
}).catch((err) => {
  $('logo').closest('.logo')?.classList.add('plain');
  errorBox.textContent = `The game data did not load: ${err instanceof Error ? err.message : String(err)}`;
});

// ------------------------------------------------------------------ account

const account = new Account(central);
const accountEl = $('account');
function paintAccount(s: AccountState): void {
  if (s.status === 'signing-in') {
    accountEl.innerHTML = '<span class="avatar guest">…</span><span class="who"><b>Signing in…</b><small>Finish in the window that opened</small></span>';
    return;
  }
  if (s.status === 'signed-in' && s.session) {
    const u = (s.session.username || 'player').trim();
    accountEl.innerHTML = `<span class="avatar">${esc(u.charAt(0).toUpperCase())}</span><span class="who"><b>${esc(u)}</b><small>Signed in with ARRR</small></span><button type="button" data-act="out">Sign out</button>`;
    accountEl.querySelector('[data-act="out"]')!.addEventListener('click', () => account.signOut());
    // The account's name, unless the player chose one of their own.
    if (/^marine\d{3}$/.test(nameIn.value) || !nameIn.value) { nameIn.value = cleanName(u); savePrefs({ name: nameIn.value }); }
    return;
  }
  accountEl.innerHTML = `<span class="avatar guest">?</span><span class="who"><b>Playing as a guest</b>${s.note ? `<small>${esc(s.note)}</small>` : '<small>Sign in to keep your name</small>'}</span><button type="button" class="primary" data-act="in">Sign in with ARRR</button>`;
  accountEl.querySelector('[data-act="in"]')!.addEventListener('click', () => void account.signIn());
}
account.onChange(paintAccount);
account.start();

// ------------------------------------------------------------------ servers

const browser = new ServerBrowser($('rooms'), $('rooms-status'), $<HTMLButtonElement>('quickplay'), central);
browser.onJoin = (room) => void play(room, false);
$('offline').addEventListener('click', () => void play('practice', true));
$<HTMLFormElement>('custom').addEventListener('submit', (e) => {
  e.preventDefault();
  const room = cleanRoomName(roomIn.value);
  if (!room) { roomIn.focus(); return; }
  void play(room, false);
});

const controls = $<HTMLDialogElement>('controls');
$('controls-btn').addEventListener('click', () => controls.showModal());

// ------------------------------------------------------------------ the match

let current: Game | null = null;
let starting = false;

function showMenu(): void {
  current = null;
  prewarmView();
  starting = false;
  loading.classList.add('hidden');
  menu.classList.remove('hidden');
  document.title = 'Freedoom Deathmatch';
  guy.start();
  browser.start();
}

async function play(room: string, offline: boolean): Promise<void> {
  if (starting || current) return;
  starting = true;
  errorBox.textContent = '';
  const name = cleanName(nameIn.value) || prefs().name;
  savePrefs({ name });
  browser.stop();
  guy.stop();
  menu.classList.add('hidden');
  loading.classList.remove('hidden');
  loadingLabel.textContent = offline ? 'Starting practice' : `Joining ${room}`;
  const off = onAssetProgress((_l, f) => { loadingBar.style.width = `${Math.round(f * 70)}%`; });
  try {
    const { Game } = await gameModule;
    const session = account.session();
    const game = await Game.start({
      room, offline, name, color: prefs().color,
      identity: session ?? undefined,
      central,
      nodeUrl: params.get('nodeUrl') ?? params.get('via') ?? regionNodeUrl(room),
      host: $('view'),
      hud: $('hud'),
    }, (label, frac) => { loadingLabel.textContent = label; loadingBar.style.width = `${Math.round(70 + frac * 30)}%`; });
    off();
    current = game;
    (window as unknown as { __game?: Game }).__game = game;
    document.title = offline ? 'Practice — Freedoom Deathmatch' : `${room} — Freedoom Deathmatch`;
    const keep = new URLSearchParams({ room });
    if (offline) keep.set('offline', '1');
    for (const k of ['central', 'nodeUrl', 'via'] as const) { const v = params.get(k); if (v !== null) keep.set(k, v); }
    history.replaceState(null, '', `${location.pathname}?${keep}`);
    loading.classList.add('hidden');
    game.onLeave = () => {
      game.dispose();
      (window as unknown as { __game?: Game }).__game = undefined;
      history.replaceState(null, '', location.pathname);
      showMenu();
    };
  } catch (err) {
    off();
    console.error(err);
    showMenu();
    errorBox.textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ------------------------------------------------------------------ entry

// A ?room= link (or ?offline=1) is an invitation: straight into that match.
if (params.has('autostart') || params.has('room') || params.has('offline')) {
  const offline = params.has('offline');
  const room = cleanRoomName(params.get('room') ?? '') || (offline ? 'practice' : regionRoomName(homeRegion(), 1));
  void play(room, offline);
} else {
  browser.start();
}
