/**
 * Phones and tablets (DESIGN.md "Mobile"): touch mode, and the on-screen controls
 * drawn over the view.
 *
 *   - Touch mode is on when the primary pointer is coarse or a touch arrives; a real
 *     mouse or a key switches it off again (hybrids), `?touch=1` / `?touch=0` force it.
 *   - Move: a floating stick - the thumb lands anywhere in the left 40 % and the stick
 *     centres there; past its rim the base follows the thumb. A dead zone, then the
 *     deflection maps circle-to-square onto forward/side (so a full diagonal runs both
 *     ways like W+D does); Input shapes it to walk under 60 %, run beyond.
 *   - Look: drag anywhere on the right (not on a button); FIRE looks too while held.
 *   - Buttons: FIRE (hold), JUMP, USE, weapon prev / next / the weapon icon (cycles);
 *     in battle royale ZOOM (toggles) and GRENADE; the top bar: menu, scores (hold),
 *     map (rooms with a minimap), chat. Left-handed mirrors the lot.
 *   - Fingers are tracked by pointer id, any number at once. Nothing stays held when
 *     a finger is lost: pointercancel, a touchend with no fingers left, blur, the page
 *     going hidden and every menu/chat release all of them.
 *
 * Pointer events (touch and pen); the layer has `touch-action: none` and its
 * touchstart is cancelled, so the browser neither scrolls, zooms, long-presses nor
 * makes compatibility mouse events out of it.
 */
import './touch.css';
import type { Input, Action } from './input.js';
import type { Gfx } from '../hud/gfx.js';

// ------------------------------------------------------------------ touch mode

let mode = false;
let forced: boolean | null = null;
let installed = false;
const subs = new Set<(on: boolean) => void>();

function setMode(on: boolean): void {
  if (forced !== null) on = forced;
  if (on === mode) return;
  mode = on;
  document.documentElement.classList.toggle('touch-mode', on);
  for (const cb of subs) cb(on);
}

/** Install the touch-mode detection once (the start screen and the match share it). */
export function initTouchMode(): void {
  if (installed) return;
  installed = true;
  const q = new URLSearchParams(location.search).get('touch');
  forced = q === '1' ? true : q === '0' ? false : null;
  mode = forced ?? (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  document.documentElement.classList.toggle('touch-mode', mode);
  if (forced !== null) return;
  addEventListener('touchstart', () => setMode(true), { capture: true, passive: true });
  addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' || e.pointerType === 'pen') setMode(true); else if (e.pointerType === 'mouse') setMode(false); }, { capture: true, passive: true });
  // a mouse that actually moves (pointer events never come from compatibility mouse events)
  addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && (e.movementX || e.movementY)) setMode(false); }, { capture: true, passive: true });
  addEventListener('keydown', (e) => {
    // an on-screen keyboard (code '' / 'Unidentified', or typing in a field) is not a keyboard player
    const t = e.target as HTMLElement | null;
    if (!e.code || e.code === 'Unidentified' || t?.closest?.('input, textarea, [contenteditable]')) return;
    setMode(false);
  }, { capture: true, passive: true });
}

export function touchMode(): boolean { return mode; }

export function onTouchMode(cb: (on: boolean) => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }

/** A phone-sized screen's touch default (the minimal HUD) before any pref is saved. */
export function coarsePointer(): boolean {
  try { return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches; } catch { return false; }
}

// ------------------------------------------------------------------ fullscreen

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };

export function isFullscreen(): boolean {
  const d = document as FsDoc;
  return !!(d.fullscreenElement ?? d.webkitFullscreenElement);
}

/**
 * Fullscreen, then landscape (Android Chrome; iOS Safari has neither on a phone - the
 * rotate card covers portrait there). Call from a tap. Resolves true when fullscreen.
 */
export async function enterFullscreen(): Promise<boolean> {
  const el = document.documentElement as FsEl;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else return false;
  } catch { return false; }
  try {
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await o?.lock?.('landscape');
  } catch { /* not allowed here: the rotate card */ }
  return isFullscreen();
}

export function exitFullscreen(): void {
  const d = document as FsDoc;
  try {
    try { screen.orientation?.unlock?.(); } catch { /* never locked */ }
    if (d.exitFullscreen) void d.exitFullscreen().catch(() => { /* already out */ });
    else d.webkitExitFullscreen?.();
  } catch { /* already out */ }
}

// ------------------------------------------------------------------ the controls

export interface TouchHooks {
  menu(): void;
  scores(on: boolean): void;
  map(): void;
  chat(): void;
}

/** What the match tells the controls every frame. */
export interface TouchFrame {
  /** no menu or chat is up */
  playing: boolean;
  /** tapped to play (Input.locked) */
  engaged: boolean;
  hasMap: boolean;
  /** battle royale: ZOOM and GRENADE */
  br: boolean;
  zoomOn: boolean;
  grenades: number | null;
  /** the weapon in hand (PlayerView ready), -1 none (dead, airborne) */
  weapon: number;
  /** war, dead: "1 BASE", "2 POINT A", ... */
  spawnChoices: string[] | null;
  /** CSS px the classic status bar covers at the bottom (0: the minimal HUD) */
  barPx: number;
  /** dead or the intermission: FIRE alone (respawn, watch someone else) */
  dead: boolean;
}

export interface TouchPrefs { touchLook: number; leftHanded: boolean }

/** Radians per CSS px of drag at look speed 1: a 400 px swipe turns about 100°. */
const LOOK_RAD_PER_PX = 0.0044;
/** Stick dead zone (fraction of the radius). */
const DEAD = 0.12;
/** The move zone: this much of the screen width on the stick's side. */
const MOVE_ZONE = 0.4;
/** Pickup sprites (else the weapon sprite) per weapontype, for the weapon button. */
const WEAPON_ICONS: string[][] = [
  [], ['PISTA0'], ['SHOTA0'], ['MGUNA0'], ['LAUNA0'], ['PLASA0'], ['BFUGA0'], ['CSAWA0'], ['SGN2A0'], ['SNPGA0', 'SNPRA0'],
];
const WEAPON_NAMES = ['FIST', 'PISTOL', 'SHOTGUN', 'CHAINGUN', 'ROCKETS', 'PLASMA', 'BFG', 'SAW', 'SUPER SG', 'SNIPER'];

type Kind = 'stick' | 'look' | 'fire' | 'hold' | 'tap' | 'scores' | 'engage';
interface Finger { kind: Kind; x: number; y: number; el?: HTMLElement; action?: Action }

const ICONS: Record<string, string> = {
  menu: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  scores: '<svg viewBox="0 0 24 24"><path d="M5 5h14M5 10h14M5 15h14M5 20h9"/></svg>',
  map: '<svg viewBox="0 0 24 24"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v10H9l-5 4z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
};

export class TouchControls {
  readonly root = document.createElement('div');
  private readonly fingers = new Map<number, Finger>();
  private readonly stickBase = document.createElement('div');
  private readonly stickKnob = document.createElement('div');
  private readonly spawnBox = document.createElement('div');
  private readonly btn: Record<string, HTMLElement> = {};
  private stickOrigin = { x: 0, y: 0 };
  private lookSpeed = 1;
  private lefty = false;
  private shown = false;
  private wasPlaying = false;
  private lastWeapon = -2;
  private lastSpawn = '';
  private lastClass = '';
  private readonly disposers: (() => void)[] = [];

  constructor(private readonly gfx: Gfx, private readonly input: Input, private readonly hooks: TouchHooks) {
    const r = this.root;
    r.className = 'tc hidden';
    r.innerHTML = `
      <div class="t-tap" data-t="engage"></div>
      <div class="t-top">
        <button type="button" data-t="menu" aria-label="Menu">${ICONS.menu}</button>
        <button type="button" data-t="scores" aria-label="Scores (hold)">${ICONS.scores}</button>
        <button type="button" data-t="map" aria-label="Map">${ICONS.map}</button>
        <button type="button" data-t="chat" aria-label="Chat">${ICONS.chat}</button>
      </div>
      <div class="t-pad">
        <button type="button" class="t-fire" data-t="fire" aria-label="Fire"><span>FIRE</span></button>
        <button type="button" class="t-jump" data-t="jump" aria-label="Jump"><span>JUMP</span></button>
        <button type="button" class="t-use" data-t="use" aria-label="Use"><span>USE</span></button>
        <div class="t-weapons">
          <button type="button" data-t="prev" aria-label="Previous weapon">${ICONS.prev}</button>
          <button type="button" class="t-weapon" data-t="cycle" aria-label="Next weapon"><canvas></canvas><small></small></button>
          <button type="button" data-t="next" aria-label="Next weapon">${ICONS.next}</button>
        </div>
        <button type="button" class="t-zoom" data-t="zoom" aria-label="Zoom"><span>ZOOM</span></button>
        <button type="button" class="t-nade" data-t="grenade" aria-label="Grenade"><span>NADE</span><b></b></button>
      </div>
      <div class="t-rotate"><div class="card"><i></i><b>Turn your phone sideways</b><small>Doom Town plays in landscape</small></div></div>`;
    for (const el of r.querySelectorAll<HTMLElement>('[data-t]')) this.btn[el.dataset.t!] = el;
    this.stickBase.className = 't-stick';
    this.stickKnob.className = 't-knob';
    this.stickBase.append(this.stickKnob);
    r.append(this.stickBase);
    this.spawnBox.className = 't-spawn';
    r.append(this.spawnBox);
    document.body.append(r);

    const on = <K extends keyof WindowEventMap>(t: EventTarget, type: K | string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void => {
      t.addEventListener(type, fn, opts);
      this.disposers.push(() => t.removeEventListener(type, fn, opts));
    };
    on(r, 'pointerdown', (e) => this.down(e as PointerEvent));
    on(window, 'pointermove', (e) => this.move(e as PointerEvent), { passive: true });
    on(window, 'pointerup', (e) => this.up(e as PointerEvent, false));
    on(window, 'pointercancel', (e) => this.up(e as PointerEvent, true));
    // no scrolling, zooming, callouts or compatibility mouse events from the layer
    on(r, 'touchstart', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    on(r, 'touchmove', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    on(r, 'contextmenu', (e) => e.preventDefault());
    // no finger left on the glass: nothing can still be held
    const anyLeft = (e: Event): void => { if ((e as TouchEvent).touches.length === 0) this.releaseFingers(); };
    on(window, 'touchend', anyLeft, { passive: true });
    on(window, 'touchcancel', anyLeft, { passive: true });
    on(window, 'blur', () => this.releaseFingers());
    on(document, 'visibilitychange', () => { if (document.hidden) this.releaseFingers(); });
    // iOS Safari's pinch gesture events
    on(document, 'gesturestart', (e) => { if (this.shown) e.preventDefault(); }, { passive: false });
    on(window, 'resize', () => this.layout());
    this.layout();
  }

  setPrefs(p: TouchPrefs): void {
    this.lookSpeed = Math.max(0.1, Math.min(4, p.touchLook || 1));
    this.lefty = !!p.leftHanded;
    this.root.classList.toggle('lefty', this.lefty);
    this.lastClass = '';
  }

  /** Show the controls (touch mode on) or hide them. */
  setVisible(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    this.root.classList.toggle('hidden', !on);
    if (!on) this.releaseFingers();
  }

  /** Scale with the screen: a phone in landscape is 1, a tablet up to 1.45. */
  private layout(): void {
    const u = Math.max(0.85, Math.min(1.45, Math.min(innerWidth, innerHeight) / 400));
    this.root.style.setProperty('--u', u.toFixed(3));
  }

  /** Per frame, from the match. Cheap: classes and the odd repaint on a change. */
  frame(f: TouchFrame): void {
    if (!this.shown) return;
    const playing = f.playing;
    if (!playing && this.wasPlaying) this.releaseFingers();
    this.wasPlaying = playing;
    const cls = [
      playing ? '' : 'idle', f.engaged ? 'engaged' : 'waiting',
      f.hasMap ? 'has-map' : '', f.br ? 'br' : '', f.zoomOn ? 'zoom-on' : '', f.weapon < 0 ? 'no-weapon' : '',
      f.spawnChoices?.length ? 'spawning' : '', f.dead ? 'dead' : '',
    ].filter(Boolean).join(' ');
    if (cls !== this.lastClass) {
      this.lastClass = cls;
      this.root.className = `tc${this.lefty ? ' lefty' : ''} ${cls}`;
    }
    this.root.style.setProperty('--bar', `${f.barPx}px`);
    if (f.weapon !== this.lastWeapon) { this.lastWeapon = f.weapon; this.paintWeapon(f.weapon); }
    const g = this.btn.grenade.querySelector('b')!;
    const gt = f.grenades === null ? '' : String(f.grenades);
    if (g.textContent !== gt) g.textContent = gt;
    this.btn.grenade.classList.toggle('empty', f.grenades === 0);
    const sk = f.spawnChoices?.join('|') ?? '';
    if (sk !== this.lastSpawn) {
      this.lastSpawn = sk;
      this.spawnBox.innerHTML = '';
      for (const c of f.spawnChoices ?? []) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.t = `spawn-${c.split(' ')[0]}`;
        b.textContent = c.replace(/^\d+ /, '');
        this.spawnBox.append(b);
      }
    }
  }

  private paintWeapon(w: number): void {
    const b = this.btn.cycle;
    const c = b.querySelector('canvas')!;
    const label = b.querySelector('small')!;
    label.textContent = w >= 0 ? (WEAPON_NAMES[w] ?? '') : '';
    const p = w >= 0 ? (WEAPON_ICONS[w] ?? []).map((n) => this.gfx.patch(n)).find(Boolean) ?? null : null;
    if (!p) { c.width = c.height = 1; c.getContext('2d')!.clearRect(0, 0, 1, 1); c.style.visibility = 'hidden'; return; }
    c.width = p.width; c.height = p.height;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, p.width, p.height);
    ctx.drawImage(p.canvas, 0, 0);
    c.style.visibility = '';
    // pixel art at a whole-ish scale inside the button
    const k = Math.max(1, Math.min(3, Math.floor(40 / Math.max(p.width / 1.6, p.height))));
    c.style.width = `${p.width * k}px`;
    c.style.height = `${p.height * k}px`;
  }

  // ------------------------------------------------------------------ fingers

  private down(e: PointerEvent): void {
    if (e.pointerType === 'mouse') return;
    if (e.cancelable) e.preventDefault();
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-t]');
    const id = t?.dataset.t ?? '';
    const f: Finger = { kind: 'look', x: e.clientX, y: e.clientY };
    if (id === 'engage') f.kind = 'engage';
    else if (id === 'fire') { f.kind = 'fire'; f.action = 'attack'; this.input.touchHold('attack', true); }
    else if (id === 'jump' || id === 'use' || id === 'grenade') { f.kind = 'hold'; f.action = id === 'grenade' ? 'grenade' : id; this.input.touchHold(f.action, true); }
    else if (id === 'scores') { f.kind = 'scores'; this.hooks.scores(true); }
    else if (id === 'zoom') { f.kind = 'tap'; this.input.toggleZoom(); }
    else if (id === 'prev' || id === 'next' || id === 'cycle') { f.kind = 'tap'; this.input.touchWeapon(id === 'prev' ? -1 : 1); }
    else if (id.startsWith('spawn-')) { f.kind = 'tap'; this.input.touchWeapon(0, Number(id.slice(6)) || 1); }
    else if (id === 'map') { f.kind = 'tap'; this.hooks.map(); }
    else if (id === 'menu' || id === 'chat') f.kind = 'tap';   // acted on at the lift (a user gesture for the keyboard)
    else if (this.inMoveZone(e.clientX) && ![...this.fingers.values()].some((o) => o.kind === 'stick')) {
      f.kind = 'stick';
      this.startStick(e.clientX, e.clientY);
    }
    if (t) { f.el = t; t.classList.add('down'); }
    this.fingers.set(e.pointerId, f);
  }

  private move(e: PointerEvent): void {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    const dx = e.clientX - f.x, dy = e.clientY - f.y;
    f.x = e.clientX; f.y = e.clientY;
    if (f.kind === 'stick') this.moveStick(e.clientX, e.clientY);
    else if (f.kind === 'look' || f.kind === 'fire') {
      const k = LOOK_RAD_PER_PX * this.lookSpeed;
      this.input.look(dx * k, dy * k * 0.8);
    }
  }

  private up(e: PointerEvent, cancelled: boolean): void {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    this.fingers.delete(e.pointerId);
    this.release(f);
    if (cancelled) return;
    // still over the button it pressed: these act on the lift
    const over = f.el ? (document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-t]') === f.el) : false;
    const id = f.el?.dataset.t;
    if (f.kind === 'engage') this.input.lock();
    else if (id === 'menu' && over) this.hooks.menu();
    else if (id === 'chat' && over) this.hooks.chat();
  }

  private release(f: Finger): void {
    f.el?.classList.remove('down');
    if (f.kind === 'stick') this.endStick();
    else if ((f.kind === 'fire' || f.kind === 'hold') && f.action) this.input.touchHold(f.action, false);
    else if (f.kind === 'scores') this.hooks.scores(false);
  }

  /** Let go of everything (blur, hidden page, a menu, a lost finger). The ZOOM toggle stays. */
  releaseFingers(): void {
    const all = [...this.fingers.values()];
    this.fingers.clear();
    for (const f of all) this.release(f);
    this.endStick();
  }

  private inMoveZone(x: number): boolean {
    return this.lefty ? x > innerWidth * (1 - MOVE_ZONE) : x < innerWidth * MOVE_ZONE;
  }

  private get stickR(): number {
    return 52 * Number(this.root.style.getPropertyValue('--u') || 1);
  }

  private startStick(x: number, y: number): void {
    const R = this.stickR;
    // the base stays wholly on screen
    this.stickOrigin = { x: Math.max(R + 8, Math.min(innerWidth - R - 8, x)), y: Math.max(R + 8, Math.min(innerHeight - R - 8, y)) };
    this.stickBase.style.left = `${this.stickOrigin.x}px`;
    this.stickBase.style.top = `${this.stickOrigin.y}px`;
    this.stickBase.classList.add('on');
    this.moveStick(x, y);
  }

  private moveStick(x: number, y: number): void {
    const R = this.stickR;
    let dx = x - this.stickOrigin.x, dy = y - this.stickOrigin.y;
    let d = Math.hypot(dx, dy);
    if (d > R * 1.25) {
      // dragged well past the rim: the base follows the thumb
      const k = (d - R) / d;
      this.stickOrigin.x += dx * k; this.stickOrigin.y += dy * k;
      this.stickBase.style.left = `${this.stickOrigin.x}px`;
      this.stickBase.style.top = `${this.stickOrigin.y}px`;
      dx = x - this.stickOrigin.x; dy = y - this.stickOrigin.y; d = Math.hypot(dx, dy);
    }
    const m = Math.min(1, d / R);
    const kx = d > 0 ? (dx / d) * m * R : 0, ky = d > 0 ? (dy / d) * m * R : 0;
    this.stickKnob.style.transform = `translate(${kx.toFixed(1)}px, ${ky.toFixed(1)}px)`;
    const mm = m <= DEAD ? 0 : (m - DEAD) / (1 - DEAD);
    if (!mm || !d) { this.input.setStick(0, 0); return; }
    const ux = dx / d, uy = dy / d;
    // circle to square: full deflection on a diagonal runs both ways, like two keys
    const s = mm / Math.max(Math.abs(ux), Math.abs(uy));
    this.input.setStick(Math.max(-1, Math.min(1, -uy * s)), Math.max(-1, Math.min(1, ux * s)));
    this.stickBase.classList.toggle('run', mm > 0.6);
  }

  private endStick(): void {
    this.stickBase.classList.remove('on', 'run');
    this.stickKnob.style.transform = '';
    this.input.setStick(0, 0);
  }

  dispose(): void {
    this.releaseFingers();
    for (const d of this.disposers) d();
    this.root.remove();
  }
}
