/** Dev only: the HUD over a still, with made-up numbers, for screenshots while the sim is not there. */
import '../../src/menu/menu.css';
import { loadWad } from '../../src/game/assets.js';
import { Gfx } from '../../src/hud/gfx.js';
import { Hud, type ScoreRow } from '../../src/hud/hud.js';
import { PV, PLAYER_WORDS } from '../../src/sim/abi.js';
import { botNames } from '../../src/game/names.js';
import { obituaryTemplate } from '../../src/hud/strings.js';

const q = new URLSearchParams(location.search);
const wad = await loadWad();
const gfx = new Gfx(wad);
const bg = gfx.patch('TITLEPIC')!;
const c = document.getElementById('bg') as HTMLCanvasElement;
c.width = bg.width; c.height = bg.height; c.getContext('2d')!.drawImage(bg.canvas, 0, 0);
const hud = new Hud(document.getElementById('hud')!, gfx);
const pv = new Int32Array(PLAYER_WORDS);
pv[PV.health] = 87; pv[PV.armor] = 45; pv[PV.armortype] = 1; pv[PV.ready] = 2; pv[PV.owned] = 0b111 | (1 << 4);
pv.set([123, 18, 0, 6], PV.ammo); pv.set([200, 50, 300, 50], PV.maxammo);
const names = botNames('na-1', 64);
const rows: ScoreRow[] = names.map((n, i) => ({ slot: i, name: n, color: (i * 7 + 3) % 20, frags: Math.max(0, 31 - i - (i % 3)), deaths: (i * 5) % 17, ping: 20 + (i * 37) % 110, me: i === 27 }));
rows[27].name = 'MARINE364';
hud.setRows(rows);
if (q.has('scores')) hud.showScores(true);
hud.message('Picked up a shotgun!');
hud.chat('Ripper', 'gg, nice rocket', 3);
const ob = (v: string, k: string, mod: number, vc: string, kc: string) => {
  const parts: [string, string | undefined][] = [];
  for (const p of obituaryTemplate(mod, false, false).split(/(%o|%k)/)) parts.push(p === '%o' ? [v, vc] : p === '%k' ? [k, kc] : [p, undefined]);
  hud.obituary(parts.filter((x) => x[0]), v === 'MARINE364' || k === 'MARINE364');
};
ob('Kronos', 'MARINE364', 13, '#3f5fff', '#4fc33f');
ob('Vex', 'xXdoomXx', 9, '#f0e040', '#d33b3b');
ob('Tank', 'Hollow', 4, '#ff8a20', '#9a40d0');
let face = 0;
const tick = (now: number) => {
  hud.update({ pv, face: q.has('dead') ? 41 : face, color: 0, frags: 12, rank: 2, total: 64, timeLeft: 462, intermission: q.has('inter'), dead: q.has('dead'), respawnReady: true, killer: q.has('dead') ? 'Ripper' : null, locked: true, style: q.get('style') === 'full' ? 'full' : 'bar', net: null }, now);
  requestAnimationFrame(tick);
};
setInterval(() => { face = (face + 1) % 3; }, 600);
requestAnimationFrame(tick);
