/**
 * The server list on the start screen (after vibe-strike's): regional servers
 * first, the player's own region on top, then rooms players named. Every room
 * is a live match - bots fill the empty slots - and how many players are
 * human is never shown, per row or in total.
 */
import { fetchRooms, formatAge, quickPlayRoom, type RoomRow } from './rooms.js';
import { REGIONS, homeRegion, regionOf, type RegionId } from './regions.js';
import { MODES, type ModeKey } from './modes.js';
import { mapTitle } from '../sim/maps.js';

/** The list's tabs: every room, one per mode, and the random-boss rooms on their own. */
type Tab = 'all' | ModeKey | 'boss' | 'mod';
const TABS: { id: Tab; label: string; title: string }[] = [
  { id: 'all', label: 'All', title: 'Every room' },
  { id: 'dm', label: 'DM', title: MODES.dm.label },
  { id: 'tdm', label: 'Team DM', title: MODES.tdm.label },
  { id: 'elim', label: 'Elim', title: MODES.elim.label },
  { id: 'war', label: 'War', title: MODES.war.label },
  { id: 'br', label: 'Royale', title: MODES.br.label },
  { id: 'boss', label: 'Bosses', title: 'Random bosses' },
  { id: 'mod', label: 'Mods', title: 'Rooms playing a mod' },
];
/** A room named after a mod (`na-mod-arena-1`); battle royale rooms play br01 but list as BR. */
const isModRoom = (r: RoomRow): boolean => !!r.game.mod && r.game.kind.startsWith('mod-');
const tabOf = (r: RoomRow): Tab => (isModRoom(r) ? 'mod' : r.game.bosses ? 'boss' : r.game.mode.key);
const inTab = (r: RoomRow, t: Tab): boolean => t === 'all' || tabOf(r) === t;

const REFRESH_SECONDS = 20;

export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export class ServerBrowser {
  onJoin: ((room: string) => void) | null = null;

  private rows: RoomRow[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  readonly home: RegionId = homeRegion();

  private tab: Tab = 'all';

  constructor(
    private readonly list: HTMLElement,
    private readonly status: HTMLElement,
    private readonly quickBtn: HTMLButtonElement,
    private readonly central?: string,
    private readonly tabs?: HTMLElement,
  ) {
    tabs?.addEventListener('click', (e) => {
      const t = (e.target as Element).closest<HTMLElement>('[data-tab]');
      if (!t) return;
      this.tab = t.dataset.tab as Tab;
      this.render();
    });
    list.addEventListener('click', (e) => {
      const row = (e.target as Element).closest<HTMLElement>('[data-room]');
      if (row) this.onJoin?.(row.dataset.room!);
    });
    list.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const row = (e.target as Element).closest<HTMLElement>('[data-room]');
      if (row) this.onJoin?.(row.dataset.room!);
    });
    quickBtn.addEventListener('click', () => void this.quickPlay());
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => { if (!document.hidden) void this.refresh(); }, REFRESH_SECONDS * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    if (!this.rows.length) this.status.textContent = 'Looking for servers…';
    const result = await fetchRooms(this.central);
    this.busy = false;
    if (!result.ok) {
      // Still a list: the regional servers exist whether or not the room
      // service answers, and joining one does not need it.
      this.rows = (await import('./rooms.js')).withRegions([]);
      this.status.textContent = 'Server list is offline — you can still join';
    } else {
      this.rows = result.rooms;
      this.status.textContent = '';
    }
    this.render();
  }

  private render(): void {
    if (this.tabs) {
      this.tabs.innerHTML = TABS.map((t) => {
        const n = this.rows.filter((r) => inTab(r, t.id)).reduce((a, r) => a + r.players, 0);
        return `<button type="button" role="tab" data-tab="${t.id}" title="${esc(t.title)}" aria-selected="${t.id === this.tab}">${esc(t.label)}<small>${n}</small></button>`;
      }).join('');
    }
    const mine = this.rows.filter((r) => inTab(r, this.tab));
    const order = [this.home, ...REGIONS.map((r) => r.id).filter((id) => id !== this.home)];
    const groups = order.map((id) => ({ title: regionOf(id).label, mine: id === this.home, rows: mine.filter((r) => r.region === id) }));
    groups.push({ title: 'Player rooms', mine: false, rows: mine.filter((r) => !r.region) });
    this.list.innerHTML = groups.filter((g) => g.rows.length).map((g) =>
      `<div class="srv-group">${esc(g.title)}${g.mine ? ' <em>nearest</em>' : ''}</div>`
      + g.rows.map((r) => this.row(r)).join('')).join('');
  }

  private row(r: RoomRow): string {
    return `
      <div class="srv-row" data-room="${esc(r.name)}" tabindex="0" role="button" aria-label="Join ${esc(r.name)}">
        <span class="srv-name">${esc(r.name)}</span>
        <span class="srv-mode">${esc(r.game.mode.short)}${r.game.bosses ? ' <em class="badge boss">Bosses</em>' : ''}${isModRoom(r) ? ' <em class="badge mod">MOD</em>' : ''}</span>
        <span class="srv-map">${isModRoom(r) ? `${esc(r.game.mod!.title)} <small class="by">by ${esc(r.game.mod!.author)}</small>` : esc(mapTitle(r.map))}</span>
        <span class="srv-pop"><b>${r.players}</b> / ${r.capacity}</span>
        <span class="srv-age">${esc(formatAge(r.ageSeconds))}</span>
        <span class="srv-join">Join</span>
      </div>`;
  }

  private async quickPlay(): Promise<void> {
    this.quickBtn.disabled = true;
    const result = await fetchRooms(this.central);
    if (result.ok) this.rows = result.rooms;
    this.quickBtn.disabled = false;
    this.onJoin?.(quickPlayRoom(result.ok ? result.rooms : [], this.home));
  }
}
