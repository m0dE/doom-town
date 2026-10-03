/**
 * The server list on the start screen (after vibe-strike's): regional servers
 * first, the player's own region on top, then rooms players named. Every room
 * is a live match - bots fill the empty slots - and how many players are
 * human is never shown, per row or in total.
 */
import { fetchRooms, formatAge, quickPlayRoom, type RoomRow } from './rooms.js';
import { REGIONS, homeRegion, regionOf, type RegionId } from './regions.js';
import { MAP_TITLE } from '../sim/map.js';

const REFRESH_SECONDS = 20;

export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export class ServerBrowser {
  onJoin: ((room: string) => void) | null = null;

  private rows: RoomRow[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  readonly home: RegionId = homeRegion();

  constructor(
    private readonly list: HTMLElement,
    private readonly status: HTMLElement,
    private readonly quickBtn: HTMLButtonElement,
    private readonly central?: string,
  ) {
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
    const order = [this.home, ...REGIONS.map((r) => r.id).filter((id) => id !== this.home)];
    const groups = order.map((id) => ({ title: regionOf(id).label, mine: id === this.home, rows: this.rows.filter((r) => r.region === id) }));
    groups.push({ title: 'Player rooms', mine: false, rows: this.rows.filter((r) => !r.region) });
    this.list.innerHTML = groups.filter((g) => g.rows.length).map((g) =>
      `<div class="srv-group">${esc(g.title)}${g.mine ? ' <em>nearest</em>' : ''}</div>`
      + g.rows.map((r) => this.row(r)).join('')).join('');
  }

  private row(r: RoomRow): string {
    const fill = Math.round((r.players / r.capacity) * 100);
    return `
      <div class="srv-row" data-room="${esc(r.name)}" tabindex="0" role="button" aria-label="Join ${esc(r.name)}">
        <span class="srv-name">${esc(r.name)}</span>
        <span class="srv-map">${esc(MAP_TITLE)}</span>
        <span class="srv-pop"><i style="--fill:${fill}%"></i><b>${r.players}</b>/${r.capacity}</span>
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
