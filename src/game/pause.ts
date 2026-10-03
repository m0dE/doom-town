/** The Esc menu during a match: back to the game, options, or leave. */
import type { Gfx } from '../hud/gfx.js';
import { prefs, savePrefs, type Prefs } from '../menu/prefs.js';

export interface PauseHooks {
  resume(): void;
  leave(): void;
  changed(p: Prefs): void;
}

export class PauseMenu {
  private readonly root: HTMLElement;
  open = false;

  constructor(gfx: Gfx, private readonly hooks: PauseHooks) {
    this.root = document.createElement('div');
    this.root.className = 'pause hidden';
    this.root.innerHTML = `
      <div class="box" role="dialog" aria-label="Menu">
        <div class="skull"></div>
        <div class="opts">
          <label class="opt">Mouse sensitivity <input type="range" min="0.5" max="20" step="0.5" data-k="sensitivity"><output></output></label>
          <label class="opt check">Invert mouse <input type="checkbox" data-k="invertY"></label>
          <label class="opt">Field of view <input type="range" min="75" max="110" step="1" data-k="fov"><output></output></label>
          <label class="opt">Volume <input type="range" min="0" max="1" step="0.05" data-k="volume"><output></output></label>
          <div class="opt check">Status bar <span class="seg"><button type="button" data-hud="bar">Classic</button><button type="button" data-hud="full">Minimal</button></span></div>
          <div class="opt check">Players <span class="seg"><button type="button" data-players="3d">3D</button><button type="button" data-players="sprites">Classic sprites</button></span></div>
        </div>
        <div class="buttons">
          <button class="btn primary" type="button" data-act="resume">Back to the game</button>
          <button class="btn ghost" type="button" data-act="leave">Leave match</button>
        </div>
      </div>`;
    document.body.append(this.root);
    // Doom's own menu art for the heading, when the WAD has it.
    const head = this.root.querySelector('.skull')!;
    const p = gfx.patch('M_SKULL1');
    if (p) {
      const c = document.createElement('canvas');
      c.width = p.width; c.height = p.height;
      c.getContext('2d')!.drawImage(p.canvas, 0, 0);
      head.append(c);
    }
    const h = document.createElement('h2');
    h.textContent = 'Options';
    head.append(h);
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'resume') this.hooks.resume();
      else if (act === 'leave') this.hooks.leave();
      const hud = t.closest<HTMLElement>('[data-hud]')?.dataset.hud;
      if (hud === 'bar' || hud === 'full') { this.hooks.changed(savePrefs({ hud })); this.paint(); }
      const players = t.closest<HTMLElement>('[data-players]')?.dataset.players;
      if (players === '3d' || players === 'sprites') { this.hooks.changed(savePrefs({ players })); this.paint(); }
      if (t === this.root) this.hooks.resume();
    });
    this.root.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      const k = el.dataset.k as keyof Prefs | undefined;
      if (!k) return;
      const v = el.type === 'checkbox' ? el.checked : Number(el.value);
      this.hooks.changed(savePrefs({ [k]: v } as Partial<Prefs>));
      this.paint();
    });
    this.root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); this.hooks.resume(); } });
  }

  private paint(): void {
    const p = prefs();
    for (const el of this.root.querySelectorAll<HTMLInputElement>('[data-k]')) {
      const k = el.dataset.k as keyof Prefs;
      if (el.type === 'checkbox') el.checked = !!p[k];
      else el.value = String(p[k]);
      const out = el.parentElement?.querySelector('output');
      if (out) out.textContent = k === 'volume' ? `${Math.round(p.volume * 100)}%` : k === 'fov' ? `${p.fov}°` : String(p[k]);
    }
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-hud]')) b.setAttribute('aria-pressed', String(b.dataset.hud === p.hud));
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-players]')) b.setAttribute('aria-pressed', String(b.dataset.players === p.players));
  }

  show(): void {
    this.open = true;
    this.paint();
    this.root.classList.remove('hidden');
    this.root.querySelector<HTMLButtonElement>('[data-act="resume"]')?.focus();
  }

  hide(): void {
    this.open = false;
    this.root.classList.add('hidden');
  }

  dispose(): void { this.root.remove(); }
}
