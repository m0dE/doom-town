/**
 * Boot: the start screen, then a match.
 *
 * URL parameters: ?room=<name> joins that room, ?offline=1 plays alone with
 * bots on a local loopback, ?offline=1&mod=<url> playtests a mod file (DESIGN.md
 * "Mods"), ?name=<name>, ?autostart=1 skips the menu (tests),
 * and the three the arrr harness aims a run with - ?central=<url>,
 * ?nodeUrl=<ws url> (or ?via=).
 *
 * While the menu is up the sim (doomsim.wasm), the game data and the game's
 * code are all fetched, so Play is instant.
 */
import './menu/menu.css';
import { prefetch, loadWad, onAssetProgress, setLocalMod } from './game/assets.js';
import { installedMods, registerMod } from './mods/index.js';
import { readModInfo, MOD_MODES } from './mods/modinfo.js';
import { Wad } from './wad/index.js';
import { Gfx } from './hud/gfx.js';
import { Doomguy } from './menu/doomguy.js';
import { drawTitle } from './menu/title.js';
import { PLAYER_COLORS, colorLabel } from './game/colors.js';
import { prefs, savePrefs, cleanName } from './menu/prefs.js';
import { ServerBrowser, esc } from './menu/serverbrowser.js';
import { Account, type AccountState } from './menu/account.js';
import { cleanRoomName } from './menu/rooms.js';
import { homeRegion, regionNodeUrl, regionRoomName } from './menu/regions.js';
import { MODES, MODE_ORDER, gameFor, roomNameFor, type CfgOverrides, type ModeKey } from './menu/modes.js';
import { indieProgress, startIndie } from './platform/indie.js';
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

// The title: our own lettering, at a whole-number pixel scale that fits the column.
const logo = $<HTMLCanvasElement>('logo');
const logoSize = drawTitle(logo);
function fitLogo(): void {
  const room = (logo.parentElement?.clientWidth ?? innerWidth) * 0.92;
  const k = Math.max(1, Math.min(innerHeight < 800 ? 2 : 3, Math.floor(room / logoSize.w)));
  logo.style.width = `${logoSize.w * k}px`;
  logo.style.height = `${logoSize.h * k}px`;
}
fitLogo();
addEventListener('resize', fitLogo);
const rev = typeof __BUILD_REV__ === 'string' ? __BUILD_REV__ : 'dev';
$('build').textContent = `build ${rev}`;

// The indie.fun SDK, in that export only (src/platform/indie.ts).
startIndie();
indieProgress('menu');

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
(window as unknown as { __menuGuy?: Doomguy }).__menuGuy = guy;
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

// The colours live behind a Customize button, in a popover under the marine.
const customizeBtn = $('customize-btn');
const customizePop = $('customize-pop');
function showCustomize(open: boolean): void {
  customizePop.hidden = !open;
  customizeBtn.setAttribute('aria-expanded', String(open));
}
customizeBtn.addEventListener('click', () => showCustomize(customizePop.hidden));
document.addEventListener('click', (e) => {
  if (!customizePop.hidden && !(e.target as Element).closest('.customize')) showCustomize(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !customizePop.hidden) { showCustomize(false); customizeBtn.focus(); }
});

// The WAD paints the marine, the logo and the backdrop once it is here.
void loadWad().then((wad) => {
  const gfx = new Gfx(wad);
  guy.setGfx(gfx);
  const back = gfx.patch('INTERPIC') ?? gfx.patch('TITLEPIC');
  if (back) {
    const bc = $<HTMLCanvasElement>('backdrop');
    bc.width = back.width; bc.height = back.height;
    bc.getContext('2d')!.drawImage(back.canvas, 0, 0);
    bc.style.objectFit = 'cover';
  }
}).catch((err) => {
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

const browser = new ServerBrowser($('rooms'), $('rooms-status'), $<HTMLButtonElement>('quickplay'), central, $('mode-tabs'));
browser.onJoin = (room) => void play(room, false);
// Practice against bots has no button (?offline=1 is the way in); tests start it from the warm menu.
(window as unknown as { __practice?: () => void }).__practice = () => void play('practice', true);

// Create room: a name, a mode and bosses make a room name (rooms are their names - modes.ts).
const create = $<HTMLDialogElement>('create');
const createModes = $('create-modes');
const createBosses = $<HTMLInputElement>('create-bosses');
const createPreview = $('create-preview');
createModes.innerHTML = MODE_ORDER.map((k, i) =>
  `<label><input type="radio" name="create-mode" value="${k}"${i === 0 ? ' checked' : ''}><b>${esc(MODES[k].label)}</b><small>${esc(MODES[k].blurb)}</small></label>`).join('');
// the installed mods (public/mods/index.json), in the same radio group: a room plays a mode or a mod
const createMods = $('create-mods');
const mods = installedMods();
createMods.innerHTML = mods.map((m) =>
  `<label><input type="radio" name="create-mode" value="mod:${esc(m.id)}"><b>${esc(m.title)} <em class="badge mod">MOD</em></b><small>${esc(MODES[MOD_MODES[m.mode]].label)} · by ${esc(m.author)}${m.description ? ` · ${esc(m.description)}` : ''}</small></label>`).join('');
$('create-mods-set').hidden = !mods.length;
const pickedMode = (): string => (create.querySelector<HTMLInputElement>('input[name="create-mode"]:checked')?.value ?? 'dm');
function createdRoom(): { name: string; label: string } {
  const pick = pickedMode();
  const g = pick.startsWith('mod:') ? gameFor('dm', false, undefined, pick.slice(4)) : gameFor(pick as ModeKey, createBosses.checked);
  return { name: roomNameFor(cleanRoomName(roomIn.value), g), label: g.label };
}
function paintCreate(): void {
  const mode = pickedMode();
  createBosses.disabled = mode !== 'dm' && mode !== 'tdm';
  const r = createdRoom();
  createPreview.innerHTML = `Room <b>${esc(r.name)}</b> · ${esc(r.label)}`;
}
create.addEventListener('input', paintCreate);
$('create-btn').addEventListener('click', () => { paintCreate(); create.showModal(); roomIn.focus(); });
create.querySelector('[data-act="cancel"]')!.addEventListener('click', () => create.close());
$<HTMLFormElement>('create-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const room = createdRoom().name;
  create.close();
  void play(room, false);
});

const controls = $<HTMLDialogElement>('controls');
$('controls-btn').addEventListener('click', () => controls.showModal());

// ------------------------------------------------------------------ mods

/**
 * Playtest a mod file (DESIGN.md "Mods"): read its MODINFO, make its id known to the
 * room layer, hand its bytes to the asset loader, and play it offline against bots -
 * nobody else could join a room built from a file only this page has.
 */
async function playModFile(bytes: Uint8Array, source: string): Promise<void> {
  try {
    const info = readModInfo(new Wad(bytes));
    if (!info) throw new Error('it has no MODINFO lump');
    new Wad(bytes).mapLumps(info.map);
    registerMod(info, bytes.length);
    setLocalMod(info.id, bytes);
    modSource = source;
    await play(`practice-mod-${info.id}`, true);
  } catch (err) {
    errorBox.textContent = `That mod file will not load: ${err instanceof Error ? err.message : String(err)}`;
  }
}
let modSource: string | null = null;
const testModFile = $<HTMLInputElement>('test-mod-file');
$('test-mod-btn').addEventListener('click', () => testModFile.click());
testModFile.addEventListener('change', () => {
  const f = testModFile.files?.[0];
  testModFile.value = '';
  if (f) void f.arrayBuffer().then((b) => playModFile(new Uint8Array(b), ''));
});

// ------------------------------------------------------------------ the match

let current: Game | null = null;
let starting = false;

function showMenu(): void {
  current = null;
  prewarmView();
  starting = false;
  loading.classList.add('hidden');
  menu.classList.remove('hidden');
  document.title = 'Doom Town';
  guy.start();
  browser.start();
}

/** Offline only (tests, playtesting): ?lobby= ?match= ?inter= in seconds shorten the match's phases. */
function testOverrides(): CfgOverrides | undefined {
  const sec = (k: string): number | undefined => { const v = Number(params.get(k)); return params.has(k) && Number.isFinite(v) && v > 0 ? Math.round(v * 35) : undefined; };
  const o: CfgOverrides = { lobbyTics: sec('lobby'), matchTics: sec('match'), interTics: sec('inter') };
  return Object.values(o).some((v) => v !== undefined) ? o : undefined;
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
      overrides: offline ? testOverrides() : undefined,
    }, (label, frac) => { loadingLabel.textContent = label; loadingBar.style.width = `${Math.round(70 + frac * 30)}%`; });
    off();
    current = game;
    (window as unknown as { __game?: Game }).__game = game;
    document.title = offline ? 'Practice — Doom Town' : `${room} — Doom Town`;
    const keep = new URLSearchParams({ room });
    if (offline) keep.set('offline', '1');
    if (offline && modSource) keep.set('mod', modSource);
    for (const k of ['central', 'nodeUrl', 'via', ...(offline ? ['lobby', 'match', 'inter'] as const : [])] as const) { const v = params.get(k); if (v !== null) keep.set(k, v); }
    history.replaceState(null, '', `${location.pathname}?${keep}`);
    loading.classList.add('hidden');
    if (!offline) indieProgress('match_joined');
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
if (params.has('offline') && params.get('mod')) {
  // ?offline=1&mod=<url or path>: a mod file under test
  const url = params.get('mod')!;
  void fetch(url).then(async (r) => {
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    await playModFile(new Uint8Array(await r.arrayBuffer()), url);
  }).catch((err) => { errorBox.textContent = `Could not load the mod: ${err instanceof Error ? err.message : String(err)}`; browser.start(); });
} else if (params.has('autostart') || params.has('room') || params.has('offline')) {
  const offline = params.has('offline');
  const room = cleanRoomName(params.get('room') ?? '') || (offline ? 'practice' : regionRoomName(homeRegion(), 1));
  void play(room, offline);
} else {
  browser.start();
}
