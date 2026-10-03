#!/usr/bin/env node
/**
 * Publish the indie.fun edition: build it, then upload it to indie.fun.
 *
 *   INDIE_DEPLOY_KEY=idk_… npm run deploy:indiefun
 *   INDIE_DEPLOY_KEY=idk_… npm run deploy:indiefun -- --no-build   # upload what export/ already has
 *
 * The build is `npm run export:indiefun` (tools/export.mjs --platform=indiefun),
 * so everything it refuses - uncommitted or unpushed work, a missing App ID -
 * stops a deploy too. The upload is export/doom-town-indiefun.zip, POSTed to
 * indie.fun's deploy API.
 *
 * INDIE_DEPLOY_KEY is a deploy key (indie.fun → your game → Deploy keys). It
 * can only replace this game's files, but a key made with "Builds go live
 * without review" publishes straight to players - so it lives in the
 * environment, never in this repo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ZIP = path.join(ROOT, 'export', 'doom-town-indiefun.zip');
const API = process.env.INDIE_DEPLOY_URL || 'https://indie.fun/api/deploy/build';
const fail = (why) => { console.error(`deploy refused: ${why}`); process.exit(1); };

const key = (process.env.INDIE_DEPLOY_KEY ?? '').trim();
if (!key) fail('no INDIE_DEPLOY_KEY (indie.fun → your game → Deploy keys; an idk_… key)');
if (!key.startsWith('idk_')) fail('INDIE_DEPLOY_KEY is not a deploy key (idk_…); an App ID or App Secret will not do');

if (!process.argv.includes('--no-build')) {
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'export.mjs'), '--platform=indiefun'], { cwd: ROOT, stdio: 'inherit' });
}
if (!existsSync(ZIP)) fail(`no ${path.relative(ROOT, ZIP)} — run without --no-build`);

console.log(`\nuploading ${path.relative(ROOT, ZIP)} to ${API}`);
const form = new FormData();
form.append('zip', new Blob([readFileSync(ZIP)], { type: 'application/zip' }), 'game.zip');
const res = await fetch(API, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
const text = await res.text();
if (!res.ok) fail(`indie.fun answered ${res.status}: ${text.slice(0, 500)}`);

let build;
try { ({ build } = JSON.parse(text)); } catch { fail(`indie.fun answered ${res.status} with something that is not JSON: ${text.slice(0, 200)}`); }
const play = build?.playUrl ? new URL(build.playUrl, API).href : '(no play URL in the reply)';
console.log(`deployed build ${build?.id}: ${build?.fileCount} files, review ${build?.review}`);
console.log(build?.review === 'approved' ? `live at ${play}` : `waiting for review on indie.fun; it will be at ${play}`);
