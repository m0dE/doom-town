/**
 * Keyboard and mouse → the ticcmd the sim takes once per beat.
 *
 * The view angles are absolute and live here: the mouse turns them every
 * event, the camera reads them every frame, and each beat sends them whole as
 * `{ c: [angle_hi16, pitch, forward, side, buttons] }`. Movement keys are held
 * state; a press that starts and ends between two beats (a quick click at
 * 35 Hz is under 29 ms) is latched until the next beat so it is never lost.
 *
 * Doom's angle convention: yaw 0 looks along +x, positive turns
 * counter-clockwise seen from above; mouse right turns right (yaw down).
 */
import type { Cmd } from '../sim/doomsim.js';

export const BT_ATTACK = 1, BT_USE = 2, BT_JUMP = 4, BT_ZOOM = 8, BT_NEXT = 1 << 8, BT_PREV = 1 << 9, BT_GRENADE = 1 << 10;
const TWO_PI = Math.PI * 2;
/** DESIGN.md: the sim clamps pitch to ±0.9 of straight up/down; so do we, so the view never fights it. */
export const MAX_PITCH = (Math.PI / 2) * 0.9;
/** Doom's angleturn for a held turn key while running, in radians per second (1280 << 16 BAM per tic). */
const KEY_TURN_RATE = (1280 / 65536) * TWO_PI * 35;

export interface InputSettings {
  /** Mouse sensitivity, 1..20; 5 is Doom-ish at 800 dpi. */
  sensitivity: number;
  invertY: boolean;
}

export interface InputHooks {
  /** Esc, or the pointer lock being taken away. */
  onMenu(): void;
  onScoreboard(visible: boolean): void;
  onChat(): void;
  /** While dead: the respawn prompt wants a click to count as "fire". */
  keyboardCaptured(): boolean;
  /** `M`: the large map (rooms with a minimap). */
  onMap?(): void;
}

type Action = 'forward' | 'back' | 'left' | 'right' | 'turnleft' | 'turnright' | 'walk' | 'jump' | 'use' | 'attack'
  | 'next' | 'prev' | 'w1' | 'w2' | 'w3' | 'w4' | 'w5' | 'w6' | 'w7' | 'scores' | 'chat' | 'menu' | 'zoom' | 'map' | 'grenade';

const BINDS: Record<string, Action> = {
  KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  ArrowUp: 'forward', ArrowDown: 'back', ArrowLeft: 'turnleft', ArrowRight: 'turnright',
  ShiftLeft: 'walk', ShiftRight: 'walk', Space: 'jump',
  ControlLeft: 'use', ControlRight: 'use', KeyE: 'use',
  KeyQ: 'prev',
  Digit1: 'w1', Digit2: 'w2', Digit3: 'w3', Digit4: 'w4', Digit5: 'w5', Digit6: 'w6', Digit7: 'w7',
  Tab: 'scores', KeyT: 'chat', KeyY: 'chat', Enter: 'chat', Escape: 'menu',
  KeyZ: 'zoom', KeyM: 'map', KeyG: 'grenade',
};

export class Input {
  /** Radians, Doom convention. */
  yaw = 0;
  pitch = 0;
  settings: InputSettings = { sensitivity: 5, invertY: false };
  /**
   * Battle royale's buttons (DESIGN.md): when true, the right mouse button and Z hold
   * the zoom button (bit 3) and G throws a grenade (bit 10). Elsewhere they do nothing
   * and nothing zooms.
   */
  zoomAllowed = false;
  /** Mouse look multiplier, < 1 while zoomed (the game sets it from the field of view). */
  lookScale = 1;

  private held = new Set<Action>();
  /** Pressed since the last beat - sent once even if already released. */
  private tapped = new Set<Action>();
  private weapon = 0;
  private cycle = 0;
  private disposers: (() => void)[] = [];
  private enabled = true;

  constructor(private readonly target: HTMLElement, private readonly hooks: InputHooks) {
    this.on(document, 'mousemove', (e) => this.onMouseMove(e as MouseEvent));
    this.on(window, 'mousedown', (e) => this.onButton(e as MouseEvent, true));
    this.on(window, 'mouseup', (e) => this.onButton(e as MouseEvent, false));
    this.on(window, 'wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.on(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.on(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    this.on(window, 'blur', () => this.releaseAll());
    // the right button is the scope: no context menu over the game
    this.on(target, 'contextmenu', (e) => e.preventDefault());
    this.on(document, 'pointerlockchange', () => {
      // Esc under pointer lock is eaten by the browser: losing the lock IS the menu key.
      if (!this.locked && this.enabled) { this.releaseAll(); this.hooks.onMenu(); }
    });
  }

  get locked(): boolean { return document.pointerLockElement === this.target; }

  lock(): void {
    if (this.locked) return;
    try {
      const p = (this.target.requestPointerLock as unknown as (o?: unknown) => Promise<void> | void).call(this.target, { unadjustedMovement: true });
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => { try { void this.target.requestPointerLock(); } catch { /* not allowed now */ } });
      }
    } catch { /* not allowed without a gesture */ }
  }

  unlock(): void { if (this.locked) document.exitPointerLock(); }

  /** Paused (a menu is up): nothing reaches the sim, and losing the lock is not a menu press. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.releaseAll();
  }

  /** Held attack, for the status bar face's rampage grin. */
  get attacking(): boolean { return this.held.has('attack'); }

  /** Zoom held (right mouse button or Z), in a room that has the scope. */
  get zooming(): boolean { return this.zoomAllowed && this.enabled && this.held.has('zoom'); }

  /** Per rendered frame: keyboard turning. */
  update(dt: number): void {
    if (!this.enabled) return;
    const turn = (this.held.has('turnleft') ? 1 : 0) - (this.held.has('turnright') ? 1 : 0);
    if (turn) this.yaw = wrap(this.yaw + turn * KEY_TURN_RATE * (this.held.has('walk') ? 0.5 : 1) * dt);
  }

  /** Set the view (a respawn faces the spawn point's angle). */
  face(yaw: number, pitch = 0): void { this.yaw = wrap(yaw); this.pitch = pitch; }

  /** This beat's command. Clears the one-beat latches. */
  cmd(): Cmd {
    const has = (a: Action): boolean => this.held.has(a) || this.tapped.has(a);
    const run = !this.held.has('walk');
    let forward = 0, side = 0, buttons = 0;
    if (this.enabled) {
      forward = ((has('forward') ? 1 : 0) - (has('back') ? 1 : 0)) * (run ? 50 : 25);
      side = ((has('right') ? 1 : 0) - (has('left') ? 1 : 0)) * (run ? 40 : 24);
      if (has('attack')) buttons |= BT_ATTACK;
      if (has('use')) buttons |= BT_USE;
      if (has('jump')) buttons |= BT_JUMP;
      if (this.zoomAllowed && has('zoom')) buttons |= BT_ZOOM;
      if (this.zoomAllowed && has('grenade')) buttons |= BT_GRENADE;
      if (this.weapon) buttons |= (this.weapon & 15) << 4;
      if (this.cycle > 0) buttons |= BT_NEXT;
      else if (this.cycle < 0) buttons |= BT_PREV;
    }
    this.tapped.clear();
    this.weapon = 0;
    this.cycle = 0;
    return {
      angle: Math.round((wrap(this.yaw) / TWO_PI) * 65536) & 0xffff,
      pitch: Math.max(-32768, Math.min(32767, Math.round((this.pitch / TWO_PI) * 65536))),
      forward, side, buttons,
    };
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.unlock();
  }

  // ------------------------------------------------------------------ events

  private on(t: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    t.addEventListener(type, fn, opts);
    this.disposers.push(() => t.removeEventListener(type, fn, opts));
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.locked || !this.enabled) return;
    // 0.022° per count at sensitivity 1, like the Quake family; Doom players run hot, default 5.
    const k = (this.settings.sensitivity * 0.022 * Math.PI) / 180 * this.lookScale;
    this.yaw = wrap(this.yaw - e.movementX * k);
    const dy = e.movementY * k * (this.settings.invertY ? 1 : -1);
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch + dy));
  }

  private onButton(e: MouseEvent, down: boolean): void {
    if (!this.enabled) return;
    if (e.button === 2) { if (this.locked) this.press('zoom', down); return; }
    if (e.button !== 0) return;
    if (!this.locked) {
      // The first click captures the mouse; it is not a shot.
      if (down && e.target === this.target) this.lock();
      return;
    }
    this.press('attack', down);
  }

  private onWheel(e: WheelEvent): void {
    if (!this.locked || !this.enabled) return;
    e.preventDefault();
    if (e.deltaY > 0) this.cycle = 1;
    else if (e.deltaY < 0) this.cycle = -1;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (this.hooks.keyboardCaptured()) return;
    const a = BINDS[e.code];
    if (!a) return;
    if (!this.enabled && a !== 'scores') return;
    e.preventDefault();
    if (down && e.repeat) return;
    switch (a) {
      case 'scores': this.hooks.onScoreboard(down); return;
      case 'chat': if (down) { this.releaseAll(); this.hooks.onChat(); } return;
      case 'menu': if (down) this.hooks.onMenu(); return;
      case 'map': if (down) this.hooks.onMap?.(); return;
      case 'next': if (down) this.cycle = 1; return;
      case 'prev': if (down) this.cycle = -1; return;
      case 'w1': case 'w2': case 'w3': case 'w4': case 'w5': case 'w6': case 'w7':
        if (down) this.weapon = Number(a.slice(1));
        return;
      default: this.press(a, down);
    }
  }

  /** Tests: hold or release an action by name, as a key would. */
  hold(a: string, down: boolean): void {
    if (a.startsWith('w') && a.length === 2) { if (down) this.weapon = Number(a.slice(1)); return; }
    this.press(a as Action, down);
  }

  private press(a: Action, down: boolean): void {
    if (down) { this.held.add(a); this.tapped.add(a); } else this.held.delete(a);
  }

  private releaseAll(): void {
    this.held.clear();
    this.hooks.onScoreboard(false);
  }
}

function wrap(a: number): number {
  a %= TWO_PI;
  return a < 0 ? a + TWO_PI : a;
}
