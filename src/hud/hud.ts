/**
 * The in-game HUD: status bar (or the minimal fullscreen one), messages,
 * killfeed, frags/rank/timer, the respawn prompt, the Tab scoreboard, chat.
 *
 * Drawn with the WAD's graphics: the status bar's patches, and Doom's HUD font
 * (STCFN) for every line of text, on canvases scaled pixelated by an integer
 * factor `k` that follows the window height. Screen tints (damage red, pickup
 * gold) are the renderer's, from the frame it is handed - not drawn here.
 */
import './hud.css';
import type { Gfx } from './gfx.js';
import { DoomFont } from './font.js';
import { StatusBar, WEAPON_AMMO } from './statusbar.js';
import { PV } from '../sim/abi.js';
import { PLAYER_COLORS } from '../game/colors.js';
import { ordinal } from './strings.js';

export interface ScoreRow { slot: number; name: string; color: number; frags: number; deaths: number; ping: number; me: boolean }

export interface HudState {
  pv: Int32Array | null;
  face: number;
  color: number;
  frags: number;
  rank: number;
  total: number;
  /** Seconds left in the match (or in the intermission). */
  timeLeft: number;
  intermission: boolean;
  dead: boolean;
  respawnReady: boolean;
  /** Who fragged us, while dead. */
  killer: string | null;
  locked: boolean;
  style: 'bar' | 'full';
  /** A network line ("Reconnecting") or null. */
  net: string | null;
}

const RED = undefined;
const GOLD = '#ffd25a';
const WHITE = '#f4f0e8';
const GREY = '#b8aea0';

export class Hud {
  private readonly font: DoomFont;
  private readonly bar: StatusBar;
  private k = 2;
  private readonly el: Record<string, HTMLElement> = {};
  private scoresVisible = false;
  private scoresAt = 0;
  private lastTop = '';
  private lastCenter = '';
  private lastFull = '';
  private chatInput: HTMLInputElement | null = null;
  private rows: ScoreRow[] = [];

  constructor(private readonly host: HTMLElement, private readonly gfx: Gfx) {
    this.font = new DoomFont(gfx);
    this.bar = new StatusBar(gfx);
    host.innerHTML = '';
    for (const c of ['msgs', 'feed', 'top', 'cross', 'center', 'bar', 'full', 'scores', 'net']) {
      const d = document.createElement('div');
      d.className = `h-${c}`;
      host.append(d);
      this.el[c] = d;
    }
    this.el.bar.append(this.bar.canvas);
    this.el.scores.hidden = true;
    this.el.net.hidden = true;
    this.paintBarFill();
    this.resize();
    addEventListener('resize', this.resize);
  }

  private readonly resize = (): void => {
    this.k = Math.max(2, Math.min(5, Math.round(innerHeight / 360)));
    this.host.style.setProperty('--k', String(this.k));
    // text canvases carry their own pixel sizes
    this.lastTop = this.lastCenter = this.lastFull = '';
  };

  /** The strip either side of the status bar: Doom's border flat, darkened. */
  private paintBarFill(): void {
    const flat = this.gfx.wad.nsLump('F', 'GRNROCK') ?? this.gfx.wad.nsLump('F', 'FLOOR7_2') ?? this.gfx.wad.nsLump('F', 'FLAT5_4');
    if (!flat || flat.data.length < 4096) return;
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(64, 64);
    const pal = this.gfx.pal.playpal;
    for (let i = 0; i < 4096; i++) {
      const v = flat.data[i];
      img.data[i * 4] = pal[v * 3] * 0.55; img.data[i * 4 + 1] = pal[v * 3 + 1] * 0.55; img.data[i * 4 + 2] = pal[v * 3 + 2] * 0.55; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.el.bar.classList.add('fill');
    this.el.bar.style.backgroundImage = `url(${c.toDataURL()})`;
  }

  /** A line of Doom font text as an element at the HUD scale. */
  private text(s: string, tint?: string, scale = this.k): HTMLCanvasElement {
    const src = this.font.text(s, tint);
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.getContext('2d')!.drawImage(src, 0, 0);
    c.style.width = `${src.width * scale}px`;
    c.style.height = `${src.height * scale}px`;
    return c;
  }

  private line(parts: [string, string | undefined][], scale = this.k): HTMLElement {
    const d = document.createElement('div');
    d.style.display = 'flex';
    for (const [s, t] of parts) if (s) d.append(this.text(s, t, scale));
    return d;
  }

  // ------------------------------------------------------------------ transient lines

  /** A pickup or system message (Doom's top-left line), 4 s. */
  message(text: string, tint?: string): void { this.push(this.el.msgs, this.line([[text, tint ?? RED]]), 4000, 4); }

  chat(name: string, text: string, color: number): void {
    this.push(this.el.msgs, this.line([[`${name}: `, PLAYER_COLORS[color]?.css ?? GOLD], [text, WHITE]]), 7000, 6);
  }

  /** An obituary split into pieces so names can wear their colours. */
  obituary(pieces: [string, string | undefined][], mine: boolean): void {
    const d = this.line(pieces, Math.max(2, this.k - 1));
    if (mine) d.style.filter = 'drop-shadow(0 0 4px rgba(255, 200, 80, .55))';
    this.push(this.el.feed, d, 6000, 5);
  }

  private push(box: HTMLElement, d: HTMLElement, ms: number, max: number): void {
    box.append(d);
    while (box.children.length > max) box.firstElementChild!.remove();
    setTimeout(() => d.classList.add('old'), ms);
    setTimeout(() => d.remove(), ms + 450);
  }

  // ------------------------------------------------------------------ chat

  get chatting(): boolean { return this.chatInput !== null; }

  openChat(send: (text: string) => void, done: () => void): void {
    if (this.chatInput) return;
    const box = document.createElement('div');
    box.className = 'h-chat';
    box.append(this.text('SAY:', GOLD));
    const input = document.createElement('input');
    input.maxLength = 120;
    input.setAttribute('aria-label', 'Chat message');
    box.append(input);
    this.host.append(box);
    this.chatInput = input;
    const close = (): void => { box.remove(); this.chatInput = null; done(); };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { const t = input.value.trim(); if (t) send(t); close(); }
      else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', () => { if (this.chatInput === input) close(); });
    setTimeout(() => input.focus(), 0);
  }

  // ------------------------------------------------------------------ per frame

  /** CSS px the status bar covers at the bottom of the screen. */
  get barHeight(): number { return 32 * this.k; }

  showScores(on: boolean): void { this.scoresVisible = on; this.scoresAt = 0; }

  setRows(rows: ScoreRow[]): void { this.rows = rows; }

  update(s: HudState, now: number): void {
    const pv = s.pv;
    const full = s.style === 'full';
    this.el.bar.hidden = full || !pv;
    this.el.full.hidden = !full || !pv;
    this.el.cross.hidden = !pv || s.dead || s.intermission;
    if (pv && !full) this.bar.draw(pv, s.face, s.color);
    if (pv && full) this.drawFull(pv);

    // frags, rank, clock
    const mm = Math.floor(Math.max(0, s.timeLeft) / 60), ss = Math.floor(Math.max(0, s.timeLeft) % 60);
    const clock = `${mm}:${String(ss).padStart(2, '0')}`;
    const top = `${s.frags}|${s.rank}|${s.total}|${clock}|${s.intermission}|${this.k}`;
    if (top !== this.lastTop) {
      this.lastTop = top;
      const t = this.el.top;
      t.innerHTML = '';
      t.append(this.line([['FRAGS ', GREY], [String(s.frags), GOLD]]));
      if (s.rank > 0) t.append(this.line([[ordinal(s.rank).toUpperCase(), WHITE], [` OF ${s.total}`, GREY]]));
      t.append(this.line([[s.intermission ? 'NEXT ' : '', GREY], [clock, s.timeLeft < 30 && !s.intermission ? RED : WHITE]]));
    }

    // center prompts
    let center = '';
    if (!s.locked && !s.intermission) center = 'click';
    else if (s.dead) center = `dead|${s.killer ?? ''}|${s.respawnReady}`;
    const centerKey = `${center}|${this.k}`;
    if (centerKey !== this.lastCenter) {
      this.lastCenter = centerKey;
      const c = this.el.center;
      c.innerHTML = '';
      if (center === 'click') {
        c.append(this.text('CLICK TO PLAY', WHITE, this.k + 1));
        c.append(this.text('ESC FOR THE MENU', GREY));
      } else if (s.dead) {
        if (s.killer) c.append(this.line([['FRAGGED BY ', RED], [s.killer, WHITE]], this.k + 1));
        if (s.respawnReady) c.append(this.text('PRESS FIRE TO RESPAWN', GOLD, this.k));
      }
    }

    // scoreboard: held Tab, or the intermission
    const show = this.scoresVisible || s.intermission;
    this.el.scores.hidden = !show;
    this.el.center.hidden = show;
    if (show && now - this.scoresAt > 250) { this.scoresAt = now; this.drawScores(s); }

    this.el.net.hidden = !s.net;
    if (s.net && this.el.net.textContent !== s.net) this.el.net.textContent = s.net;
  }

  private drawFull(pv: Int32Array): void {
    const ready = pv[PV.ready];
    const at = WEAPON_AMMO[ready] ?? -1;
    const key = `${pv[PV.health]}|${pv[PV.armor]}|${at >= 0 ? pv[PV.ammo + at] : -1}|${ready}|${this.k}`;
    if (key === this.lastFull) return;
    this.lastFull = key;
    const box = this.el.full;
    box.innerHTML = '';
    const left = document.createElement('div'); left.className = 'grp';
    left.append(this.item('MEDIA0', Math.max(0, pv[PV.health]), true));
    if (pv[PV.armor] > 0) left.append(this.item(pv[PV.armortype] === 2 ? 'ARM2A0' : 'ARM1A0', pv[PV.armor], true));
    const right = document.createElement('div'); right.className = 'grp';
    if (at >= 0) right.append(this.item(['CLIPA0', 'SHELA0', 'CELLA0', 'ROCKA0'][at], pv[PV.ammo + at], false));
    box.append(left, right);
  }

  private item(icon: string, value: number, pct: boolean): HTMLElement {
    const d = document.createElement('div');
    d.className = 'item';
    const p = this.gfx.patch(icon);
    if (p) {
      const c = document.createElement('canvas');
      c.width = p.width; c.height = p.height;
      c.getContext('2d')!.drawImage(p.canvas, 0, 0);
      c.style.width = `${p.width * this.k}px`; c.style.height = `${p.height * this.k}px`;
      d.append(c);
    }
    const digits = String(value);
    const c = document.createElement('canvas');
    const zero = this.gfx.patch('STTNUM0');
    const pc = pct ? this.gfx.patch('STTPRCNT') : null;
    const w = (zero?.width ?? 14) * digits.length + (pc?.width ?? 0);
    const h = zero?.height ?? 16;
    c.width = Math.max(1, w); c.height = h;
    const ctx = c.getContext('2d')!;
    let x = 0;
    for (const ch of digits) {
      const g = this.gfx.patch(`STTNUM${ch}`);
      if (g) ctx.drawImage(g.canvas, x, 0);
      x += zero?.width ?? 14;
    }
    if (pc) ctx.drawImage(pc.canvas, x, 0);
    c.style.width = `${w * this.k}px`; c.style.height = `${h * this.k}px`;
    d.append(c);
    return d;
  }

  private drawScores(s: HudState): void {
    const box = this.el.scores;
    box.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'title';
    title.append(this.text(s.intermission ? 'MATCH OVER' : 'DEATHMATCH', s.intermission ? GOLD : RED, this.k));
    title.append(this.text(`${this.rows.length} PLAYERS`, GREY, this.k));
    box.append(title);
    const head = document.createElement('div');
    head.className = 'row';
    for (const [t, r] of [['#', false], ['NAME', false], ['FRAGS', true], ['DEATHS', true], ['PING', true]] as const) {
      const c = this.text(t, GREY, Math.max(1, this.k - 1));
      if (r) c.classList.add('r');
      head.append(c);
    }
    box.append(head);
    const top = this.rows.slice(0, 20);
    const meIdx = this.rows.findIndex((r) => r.me);
    const list: (ScoreRow | null)[] = [...top];
    if (meIdx >= 20) list.push(null, this.rows[meIdx]);
    for (const r of list) {
      const row = document.createElement('div');
      if (!r) { row.className = 'row gap'; box.append(row); continue; }
      row.className = r.me ? 'row me' : 'row';
      const pos = this.rows.indexOf(r) + 1;
      const tint = r.me ? GOLD : WHITE;
      row.append(this.text(String(pos), GREY));
      const name = document.createElement('div');
      name.className = 'name';
      const sw = document.createElement('i');
      sw.className = 'sw';
      sw.style.background = PLAYER_COLORS[r.color]?.css ?? '#888';
      name.append(sw, this.text(r.name, tint));
      row.append(name);
      for (const v of [r.frags, r.deaths, r.ping]) { const c = this.text(String(v), tint); c.classList.add('r'); row.append(c); }
      box.append(row);
    }
  }

  dispose(): void {
    removeEventListener('resize', this.resize);
    this.host.innerHTML = '';
  }
}
