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
import { enterFullscreen, exitFullscreen, isFullscreen } from './touch.js';

/** Doom's walk and run speeds (forwardmove, sidemove). */
const FWD_WALK = 25, FWD_RUN = 50, SIDE_WALK = 24, SIDE_RUN = 40;

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

export type Action = 'forward' | 'back' | 'left' | 'right' | 'turnleft' | 'turnright' | 'walk' | 'jump' | 'use' | 'attack'
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
  /** Every button bit sent since the tests last cleared it. */
  seenButtons = 0;
  /** Mouse look multiplier, < 1 while zoomed (the game sets it from the field of view). */
  lookScale = 1;

  private held = new Set<Action>();
  /** Pressed since the last beat - sent once even if already released. */
  private tapped = new Set<Action>();
  private weapon = 0;
  private cycle = 0;
  private disposers: (() => void)[] = [];
  private enabled = true;
  /**
   * Touch mode (src/input/touch.ts): no pointer lock; "locked" means the player tapped
   * to play, and the on-screen controls feed the analog stick, look and buttons here.
   */
  private touch = false;
  private touchActive = false;
  /** we asked for fullscreen this match: leaving it is the menu key, like losing the lock */
  private wantFullscreen = false;
  /** the touch stick: -1..1 forward / right, already shaped (dead zone, curve) */
  private stickF = 0;
  private stickS = 0;

  constructor(private readonly target: HTMLElement, private readonly hooks: InputHooks) {
    this.on(document, 'mousemove', (e) => this.onMouseMove(e as MouseEvent));
    this.on(window, 'mousedown', (e) => this.onButton(e as MouseEvent, true));
    this.on(window, 'mouseup', (e) => this.onButton(e as MouseEvent, false));
    this.on(window, 'wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.on(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.on(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    this.on(window, 'blur', () => this.releaseAll());
    this.on(document, 'visibilitychange', () => { if (document.hidden) this.releaseAll(); });
    // the right button is the scope: no context menu over the game
    this.on(target, 'contextmenu', (e) => e.preventDefault());
    this.on(document, 'pointerlockchange', () => {
      if (this.touch) return;
      // Esc under pointer lock is eaten by the browser: losing the lock IS the menu key.
      if (!this.locked && this.enabled) { this.releaseAll(); this.hooks.onMenu(); }
    });
    const onFs = (): void => {
      // a phone leaving fullscreen (back gesture, system UI) pauses like losing the lock
      if (!this.touch || !this.wantFullscreen || isFullscreen()) return;
      this.wantFullscreen = false;
      if (this.enabled && this.touchActive) { this.releaseAll(); this.hooks.onMenu(); }
    };
    this.on(document, 'fullscreenchange', onFs);
    this.on(document, 'webkitfullscreenchange', onFs);
  }

  /** Mouse: the pointer is locked to the view. Touch: the player tapped to play. */
  get locked(): boolean { return this.touch ? this.touchActive : document.pointerLockElement === this.target; }

  /** Touch mode on or off (a hybrid device switches with the last input used). */
  setTouch(on: boolean): void {
    if (on === this.touch) return;
    const wasLocked = this.locked;
    this.touch = on;
    this.stickF = this.stickS = 0;
    if (on) {
      // already playing with the mouse: carry on with the fingers
      this.touchActive = wasLocked;
      if (document.pointerLockElement === this.target) document.exitPointerLock();
    } else {
      this.touchActive = false;
      this.wantFullscreen = false;
      this.releaseAll();
    }
  }

  get touchMode(): boolean { return this.touch; }

  lock(): void {
    if (this.touch) {
      this.touchActive = true;
      // a tap is a user gesture: fullscreen and landscape where the browser allows
      if (!isFullscreen()) void enterFullscreen().then((ok) => { if (ok && this.touch) this.wantFullscreen = true; });
      else this.wantFullscreen = true;
      return;
    }
    if (this.locked) return;
    try {
      const p = (this.target.requestPointerLock as unknown as (o?: unknown) => Promise<void> | void).call(this.target, { unadjustedMovement: true });
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => { try { void this.target.requestPointerLock(); } catch { /* not allowed now */ } });
      }
    } catch { /* not allowed without a gesture */ }
  }

  unlock(): void {
    if (this.touch) { this.touchActive = false; return; }
    if (this.locked) document.exitPointerLock();
  }

  /** Paused (a menu is up): nothing reaches the sim, and losing the lock is not a menu press. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.releaseAll();
  }

  /** Held attack, for the status bar face's rampage grin. */
  get attacking(): boolean { return this.held.has('attack'); }

  /** Zoom held (right mouse button or Z, or toggled on by the touch ZOOM button), in a room that has the scope. */
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
      forward = ((has('forward') ? 1 : 0) - (has('back') ? 1 : 0)) * (run ? FWD_RUN : FWD_WALK);
      side = ((has('right') ? 1 : 0) - (has('left') ? 1 : 0)) * (run ? SIDE_RUN : SIDE_WALK);
      // the touch stick, where no key moves: analog, walking under 60 % deflection, running beyond
      if (!forward) forward = Math.round(analog(this.stickF, FWD_WALK, FWD_RUN));
      if (!side) side = Math.round(analog(this.stickS, SIDE_WALK, SIDE_RUN));
      if (has('attack')) buttons |= BT_ATTACK;
      if (has('use')) buttons |= BT_USE;
      if (has('jump')) buttons |= BT_JUMP;
      if (this.zoomAllowed && has('zoom')) buttons |= BT_ZOOM;
      if (this.zoomAllowed && has('grenade')) buttons |= BT_GRENADE;
      if (this.weapon) buttons |= (this.weapon & 15) << 4;
      if (this.cycle > 0) buttons |= BT_NEXT;
      else if (this.cycle < 0) buttons |= BT_PREV;
    }
    this.seenButtons |= buttons;
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
    // the page goes back to the menu: out of fullscreen too
    if (this.touch && this.wantFullscreen && isFullscreen()) exitFullscreen();
    this.unlock();
  }

  // ------------------------------------------------------------------ touch (src/input/touch.ts)

  /** The stick, -1..1 each way (forward up, right positive); magnitude = deflection past the dead zone. */
  setStick(forward: number, side: number): void {
    this.stickF = this.enabled ? Math.max(-1, Math.min(1, forward)) : 0;
    this.stickS = this.enabled ? Math.max(-1, Math.min(1, side)) : 0;
  }

  /** Turn the view by radians (already scaled by the touch look speed; the scope's lookScale applies here). */
  look(dyaw: number, dpitch: number): void {
    if (!this.enabled) return;
    this.yaw = wrap(this.yaw - dyaw * this.lookScale);
    const dy = dpitch * this.lookScale * (this.settings.invertY ? 1 : -1);
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch + dy));
  }

  /** A held on-screen button (fire, jump, use, grenade). */
  touchHold(a: Action, down: boolean): void {
    if (down && !this.enabled) return;
    this.press(a, down);
  }

  /** Next (1) / previous (-1) weapon, or a weapon slot (war: the spawn point while dead). */
  touchWeapon(dir: 1 | -1 | 0, slot = 0): void {
    if (!this.enabled) return;
    if (slot) this.weapon = slot; else this.cycle = dir;
  }

  /** Battle royale: the touch ZOOM button toggles the scope; it stays until tapped again. */
  toggleZoom(): void {
    if (!this.enabled || !this.zoomAllowed) return;
    this.press('zoom', !this.held.has('zoom'));
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
    // touch mode: the on-screen controls; a real mouse switches touch mode off first (touch.ts)
    if (!this.enabled || this.touch) return;
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

  /** Tests: what is held right now (actions and the stick). */
  get heldState(): { held: string[]; stick: [number, number] } { return { held: [...this.held], stick: [this.stickF, this.stickS] }; }

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
    this.stickF = this.stickS = 0;
    this.hooks.onScoreboard(false);
    this.onRelease?.();
  }

  /** The touch controls let go of their fingers too (blur, a menu, chat). */
  onRelease: (() => void) | null = null;
}

/** A shaped stick axis (-1..1) to a move speed: up to `walk` at 60 % deflection, `run` at full. */
function analog(v: number, walk: number, run: number): number {
  const m = Math.abs(v);
  if (m < 1e-3) return 0;
  const s = m <= 0.6 ? (m / 0.6) * walk : walk + ((m - 0.6) / 0.4) * (run - walk);
  return Math.sign(v) * Math.min(run, s);
}

function wrap(a: number): number {
  a %= TWO_PI;
  return a < 0 ? a + TWO_PI : a;
}
