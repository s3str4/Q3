#!/usr/bin/env node
// Map vantage probe (graphics evidence): loads a map in headless Edge (1080p, uncapped), reports the bake time (worker ms) and the
// material generation cost, then parks the free camera on every spawn view plus a list of hand-picked vantages,
// measuring gpuMs / CPU frame time per vantage and saving a PNG of each hand-picked one.
// usage: node tools/map_views.mjs --map arena_duel --port 27991 --out .evidence/maps2/after [--frames 120] [--views .evidence/maps2/views.json]
// views.json: { "<map>": [{ name, origin: [x, y, z], angles: [pitch, yaw] }, ...] } - hand-picked free-camera vantages, one PNG each
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/index.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const port = +(args.port || 27991), map = args.map || 'arena_duel', FRAMES = +(args.frames || 120);
const outDir = path.resolve(args.out || '.evidence/maps2/probe');
fs.mkdirSync(outDir, { recursive: true });
const W = 1920, H = 1080;
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const puppeteer = (await import('puppeteer-core')).default;
const views = args.views ? JSON.parse(fs.readFileSync(args.views, 'utf8'))[map] || [] : [];
const server = await createServer({ port, map, mode: 'duel', bots: 0, quiet: true });
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--disable-frame-rate-limit', '--disable-gpu-vsync', `--window-size=${W},${H}`, '--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H });
const logs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text().slice(0, 300)));
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
const tLoad = Date.now();
await page.goto(`http://localhost:${port}/?auto=1&bot=0&nolock=1&name=Probe`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__arena && window.__arena.cg && window.__arena.cg.predicted, { timeout: 20000 });
await page.waitForFunction(() => window.__arena.renderer.frameStats.bake >= 1, { timeout: 60000 }).catch(() => console.log('bake did not finish'));
const loadMs = Date.now() - tLoad;
const bake = await page.evaluate(async () => { const r = await window.__arena.renderer.bakePromise; return r || null; });
const mats = await page.evaluate(async () => { const m = await import('/client/render/materials.js'); return m.materialStats ? m.materialStats() : null; });
const world = await page.evaluate(() => { const s = window.__arena.renderer.frameStats; return { worldVerts: s.worldVerts, worldTris: s.worldTris }; });
await page.evaluate(() => window.__arena.hud.hide());
const M = await page.evaluate(() => { const m = window.__arena.cg.game.map; return { spawns: m.spawns, brushes: m.brushes.length, lights: m.lights.length }; });

async function measure(name, origin, angles) {
  await page.evaluate((o, a) => { window.__arena.renderer.freeCamera = { origin: o, angles: a }; }, origin, angles);
  await sleep(250);
  const r = await page.evaluate((n) => new Promise((res) => {
    const R = window.__arena.renderer, gpu = [], cpu = []; let last = performance.now(), k = 0;
    (function loop() { const t = performance.now(); cpu.push(t - last); last = t; if (R.frameStats.gpuMs > 0) gpu.push(R.frameStats.gpuMs); if (++k < n) requestAnimationFrame(loop); else res({ gpuMs: med(gpu), cpuMs: med(cpu), draws: R.frameStats.draws, tris: R.frameStats.tris }); })();
    function med(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(3); }
  }), FRAMES);
  return { name, origin, angles, ...r };
}
const results = [];
for (let i = 0; i < M.spawns.length; i++) {
  const sp = M.spawns[i];
  results.push(await measure(`spawn${i}`, [sp.origin[0], sp.origin[1], sp.origin[2] + 26], [0, sp.yaw || 0]));
}
for (const v of views) {
  const r = await measure(v.name, v.origin, v.angles);
  await sleep(100);
  await page.screenshot({ path: path.join(outDir, `${map}_${v.name}.png`) });
  results.push(r);
}
const summary = { map, loadMs, bakeMs: bake && bake.ms, bakeWorkerMs: bake && bake.workerMs, bakeStartDelayMs: bake && bake.startDelayMs, bakeDoneDelayMs: bake && bake.doneDelayMs, materials: mats, world, brushes: M.brushes, lights: M.lights,
  gpuMsMedianOfViews: med(results.map((r) => r.gpuMs)), cpuMsMedianOfViews: med(results.map((r) => r.cpuMs)), views: results, logs: [...new Set(logs)].slice(0, 20) };
fs.writeFileSync(path.join(outDir, `${map}_perf.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, views: undefined, logs: undefined }, null, 1));
for (const r of results) console.log(r.name.padEnd(24), 'gpu', r.gpuMs, 'cpu', r.cpuMs, 'draws', r.draws, 'tris', r.tris);
await browser.close(); await server.close(); process.exit(0);
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function med(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(3); }
