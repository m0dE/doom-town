// In-game screenshots of a map through the real renderer (tools/maps/preview), with the
// cached Chromium and SwiftShader. Build the preview first:
//   npx vite build -c tools/maps/preview/vite.config.js
//   node tools/maps/shots.mts WAR01 out-dir name[.jpg]:x,y,z|-,yaw,pitch ...
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/paths.mts';

const { chromium } = await import('/app/data/home/arrr-mono/node_modules/playwright/index.mjs');
const [map, outDir, ...specs] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '-c', 'tools/maps/preview/vite.config.js', '--port', '5194', '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: true });
const kill = () => { try { process.kill(-server.pid!, 'SIGTERM'); } catch { /* gone */ } };
process.on('exit', kill);
try {
  for (let i = 0; i < 60; i++) { try { await fetch('http://localhost:5194/'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error('console', m.text()); });
  await page.goto(`http://localhost:5194/index.html?map=${map}&ui=0`);
  await page.waitForFunction(() => (window as unknown as { __preview?: { ready: boolean } }).__preview?.ready, null, { timeout: 120000 });
  for (const s of specs) {
    const [name, rest] = s.split(':');
    const [x, y, z, yaw, pitch] = rest.split(',');
    await page.evaluate(([x, y, z, yaw, pitch]) => (window as unknown as { __preview: { shot(...a: unknown[]): void } }).__preview.shot(+x, +y, z === '-' ? null : +z, +yaw, +(pitch ?? 0)), [x, y, z, yaw, pitch]);
    await page.waitForTimeout(300);
    // name.jpg → JPEG (quality 85, for docs), otherwise PNG
    const file = join(outDir, /\.jpg$/.test(name) ? name : `${name}.png`);
    await page.screenshot(/\.jpg$/.test(name) ? { path: file, type: 'jpeg', quality: 85, timeout: 180000 } : { path: file, timeout: 180000 });
    console.log(file);
  }
  await browser.close();
} finally { kill(); }
