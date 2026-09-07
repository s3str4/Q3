#!/usr/bin/env node
// Evidence capture: starts a server (with a bot), drives a real Chromium (Edge) client with scripted input,
// captures screenshots + performance/netcode stats into .evidence/<name>/. Works headless or headed.
// usage: node tools/evidence.mjs [--name run1] [--port 27970] [--map arena_duel] [--seconds 20] [--headed] [--latency 100 --jitter 20 --loss 2] [--width 1920 --height 1080]
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/index.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const name = args.name || 'run';
const port = +(args.port || 27970);
const seconds = +(args.seconds || 20);
const W = +(args.width || 1920), H = +(args.height || 1080);
const outDir = path.resolve('.evidence', name);
fs.mkdirSync(outDir, { recursive: true });

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('no Chromium browser found'); process.exit(1); }
const puppeteer = (await import('puppeteer-core')).default;

const server = await createServer({ port, map: args.map || 'arena_duel', mode: args.mode || 'duel', bots: 1, quiet: true, latency: +(args.latency || 0), jitter: +(args.jitter || 0), loss: +(args.loss || 0), botSkill: +(args.skill || 0.6) });
const browser = await puppeteer.launch({ executablePath: EDGE, headless: !args.headed, args: ['--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H}`, '--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(m.type() + ': ' + m.text().slice(0, 300)); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
await page.goto(`http://localhost:${port}/?auto=1&bot=1&nolock=1&name=Evidence`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__arena && window.__arena.cg && window.__arena.cg.predicted, { timeout: 15000 });
await sleep(1500);

const stats = [];
const shots = [];
const script = [
  { t: 0, keys: ['KeyW'], mouse: [0, 0] }, { t: 1.5, keys: ['KeyW', 'KeyD'], mouse: [-6, 0] }, { t: 3, keys: ['KeyW'], mouse: [4, 0], fire: true },
  { t: 4.5, keys: ['KeyA'], mouse: [8, 0], fire: true, jump: true }, { t: 6, keys: ['KeyW'], mouse: [-3, 1], weapon: 'Digit4', fire: true }, { t: 8, keys: ['KeyS'], mouse: [10, 0], fire: true, jump: true },
  { t: 10, keys: ['KeyW', 'KeyA'], mouse: [-8, 0], weapon: 'Digit6', fire: true }, { t: 12, keys: ['KeyW'], mouse: [3, -1], weapon: 'Digit5', fire: true }, { t: 14, keys: ['KeyD'], mouse: [-5, 0], fire: true, jump: true }, { t: 16, keys: ['KeyW'], mouse: [2, 0], fire: true },
];
const t0 = Date.now();
let si = 0; let held = new Set(); let mouseDown = false;
const forceLock = async () => { await page.evaluate(() => { const i = window.__arenaInput; }); };
// pointer lock is impossible headless; feed mouse motion straight into the Input object
await page.evaluate(() => { const d = document; window.__fakeLock = true; });
const feed = async (dx, dy) => page.evaluate((dx, dy) => { const a = window.__arena; const inp = a.input; if (inp) { inp.dx += dx; inp.dy += dy; } }, dx, dy);
while ((Date.now() - t0) / 1000 < seconds) {
  const el = (Date.now() - t0) / 1000;
  const step = script[si % script.length];
  if (el >= (Math.floor(si / script.length) * 18 + step.t)) {
    for (const k of held) await page.keyboard.up(k); held.clear();
    for (const k of step.keys) { await page.keyboard.down(k); held.add(k); }
    if (step.jump) { await page.keyboard.down('Space'); setTimeout(() => page.keyboard.up('Space').catch(() => {}), 120); }
    if (step.weapon) { await page.keyboard.press(step.weapon); }
    if (step.fire !== mouseDown) { mouseDown = !!step.fire; await page.evaluate((d) => { const inp = window.__arena.input; if (inp) inp.mouseButtons = d ? 1 : 0; }, mouseDown); }
    si++;
  }
  await feed(step.mouse[0] * 2, step.mouse[1] * 2);
  if (stats.length === 0 || el - stats[stats.length - 1].t > 0.5) {
    const s = await page.evaluate(() => { const a = window.__arena; const cg = a.cg; const ft = a.hud.frameTimes; const avg = ft.length ? ft.reduce((x, y) => x + y, 0) / ft.length : 0; const p99 = ft.length ? [...ft].sort((x, y) => x - y)[Math.floor(ft.length * 0.99)] : 0; const p = cg.predicted; return { fps: avg ? 1000 / avg : 0, frameAvg: avg, frameP99: p99, rtt: cg.clock.rtt, jitter: cg.clock.jitter, mispred: cg.misprediction, mispredMax: cg.mispredMax, corrections: cg.corrections, snaps: cg.stats.snapsReceived, cmds: cg.stats.cmdsSent, health: p.health, armor: p.armor, frags: p.frags, deaths: p.deaths, speed: Math.hypot(p.ps.velocity[0], p.ps.velocity[1]), draws: a.renderer.frameStats.draws, tris: a.renderer.frameStats.tris, programs: a.renderer.renderer.info.programs.length, match: cg.game.match.state, audioState: a.audio.ctx ? a.audio.ctx.state : 'none' }; });
    s.t = el; stats.push(s);
  }
  if (shots.length < 12 && el >= shots.length * (seconds / 12)) {
    const file = path.join(outDir, `shot_${String(shots.length).padStart(2, '0')}.png`);
    await page.screenshot({ path: file }); shots.push(file);
  }
  await sleep(30);
}
for (const k of held) await page.keyboard.up(k);
const summary = {
  name, seconds, map: server.args.map, port, netsim: { latency: server.args.latency, jitter: server.args.jitter, loss: server.args.loss },
  fps: { avg: mean(stats.map((s) => s.fps)), min: Math.min(...stats.map((s) => s.fps)) }, frameMs: { avg: mean(stats.map((s) => s.frameAvg)), p99max: Math.max(...stats.map((s) => s.frameP99)) },
  rtt: { avg: mean(stats.map((s) => s.rtt)), jitter: mean(stats.map((s) => s.jitter)) }, misprediction: { max: Math.max(...stats.map((s) => s.mispredMax)), corrections: stats[stats.length - 1].corrections },
  snapshots: stats[stats.length - 1].snaps, commands: stats[stats.length - 1].cmds, programs: stats[stats.length - 1].programs, draws: stats[stats.length - 1].draws, tris: stats[stats.length - 1].tris,
  final: { health: stats[stats.length - 1].health, armor: stats[stats.length - 1].armor, frags: stats[stats.length - 1].frags, deaths: stats[stats.length - 1].deaths, match: stats[stats.length - 1].match },
  serverTick: server.session.tickStats(), consoleErrors: [...new Set(consoleErrors)].slice(0, 20), screenshots: shots.map((s) => path.relative(process.cwd(), s)),
};
fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify({ summary, samples: stats }, null, 2));
console.log(JSON.stringify(summary, null, 2));
await browser.close();
await server.close();
process.exit(0);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function mean(a) { return a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : 0; }
