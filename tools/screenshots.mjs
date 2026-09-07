#!/usr/bin/env node
// Vantage screenshots for the visual evidence: starts a server (+1 bot) on --port, drives a real headless Edge
// client through window.__arena (same input path as tools/evidence.mjs), and captures 1920x1080 PNGs of specific
// moments into .evidence/screens/: spawn view, item cluster, rocket explosion, rail trail, LG beam, enemy model,
// HUD in combat, death camera. Also records fps / frame p99 / draw calls with the frame-rate limit disabled so
// the renderer's own cost is measured rather than the display refresh.
// usage: node tools/screenshots.mjs [--map testbox] [--port 27986] [--out .evidence/screens] [--headed] [--probe]
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/index.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const port = +(args.port || 27986);
const W = +(args.width || 1920), H = +(args.height || 1080);
const outDir = path.resolve(args.out || path.join('.evidence', 'screens'));
fs.mkdirSync(outDir, { recursive: true });
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('no Chromium browser found'); process.exit(1); }
const puppeteer = (await import('puppeteer-core')).default;

const server = await createServer({ port, map: args.map || 'testbox', mode: 'duel', bots: 1, quiet: true, botSkill: +(args.skill || 0.15) });
const browser = await puppeteer.launch({ executablePath: EDGE, headless: !args.headed, args: ['--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--disable-frame-rate-limit', '--disable-gpu-vsync', `--window-size=${W},${H}`, '--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H });
const logs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text().slice(0, 400)));
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
await page.goto(`http://localhost:${port}/?auto=1&bot=1&nolock=1&name=Screens`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__arena && window.__arena.cg && window.__arena.cg.predicted, { timeout: 15000 });
await sleep(1200);

// ---- helpers: drive the Input object exactly like evidence.mjs (no pointer lock headless) ----
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const setAngles = (pitch, yaw) => ev((p, y) => { window.__arena.input.setAngles(p, y); }, pitch, yaw);
const fire = (on) => ev((d) => { window.__arena.input.mouseButtons = d ? 1 : 0; }, on);
const key = async (k, down) => (down ? page.keyboard.down(k) : page.keyboard.up(k));
const press = async (k) => page.keyboard.press(k);
const state = () => ev(() => { const a = window.__arena, cg = a.cg, p = cg.predicted; const en = [...cg.remote.values()][0]; return { o: p.ps.origin, yaw: p.ps.viewangles[1], w: p.weapon, weapons: p.weapons, hp: p.health, dead: p.dead, enemy: en ? { o: en.origin, d: en.d, w: en.w } : null, stats: a.renderer.frameStats }; });
const shot = async (name) => { const f = path.join(outDir, name + '.png'); await page.screenshot({ path: f }); console.log('shot', path.relative(process.cwd(), f)); return f; };
const yawTo = (from, to) => Math.atan2(to[1] - from[1], to[0] - from[0]) * 180 / Math.PI;
const pitchTo = (from, to) => -Math.atan2(to[2] - from[2], Math.hypot(to[0] - from[0], to[1] - from[1])) * 180 / Math.PI;
// walk toward a point (optionally via waypoints) until close or timeout; when stuck on a corner, sidestep and retry
async function walkTo(target, timeoutMs = 6000, tol = 40, via = [], jump = false) {
  for (const w of via) await walkTo(w, timeoutMs, 80);
  const t0 = Date.now();
  let lastD = Infinity, stuckSince = Date.now(), side = 1;
  while (Date.now() - t0 < timeoutMs) {
    const s = await state();
    if (s.dead) { await fire(true); await sleep(120); await fire(false); await sleep(400); continue; }
    const d = Math.hypot(target[0] - s.o[0], target[1] - s.o[1]);
    if (d < tol) break;
    if (jump && d < 200) { await key('Space', true); setTimeout(() => key('Space', false).catch(() => {}), 100); } // ledge / gap on this leg
    if (d < lastD - 4) { lastD = d; stuckSince = Date.now(); }
    else if (Date.now() - stuckSince > 600) { // not progressing: strafe around the obstacle
      const k = side > 0 ? 'KeyD' : 'KeyA'; side = -side; stuckSince = Date.now();
      await key(k, true); await sleep(350); await key(k, false);
    }
    await setAngles(0, yawTo(s.o, target));
    await key('KeyW', true); await sleep(60);
  }
  await key('KeyW', false);
}
// route through the map's nav nodes (BFS over line-of-sight links, traced in-page with the shared tracer), then walk it
async function routeTo(target, timeoutMs = 9000, tol = 30) {
  const s = await state();
  // the bots' own nav graph (shared/bot.js): nodes + items + spawns + jump pads, edges validated by the tracer
  const path = await ev(async (from, to) => {
    const { buildNavGraph, findPath } = await import('/shared/bot.js');
    const cg = window.__arena.cg;
    if (!window.__nav) window.__nav = buildNavGraph(cg.game);
    return findPath(window.__nav, from, to).map((n) => ({ o: n.origin, jump: !!n.jump }));
  }, s.o, target);
  for (const n of path.slice(0, -1)) await walkTo(n.o, Math.min(timeoutMs, 6000), 56, [], n.jump);
  await walkTo(target, timeoutMs, tol, [], path.length ? path[path.length - 1].jump : false);
}
// make sure we hold a weapon: route to its pickup and stand on the spot until it (re)spawns into our hands
async function ensureWeapon(itemType, weaponBit, digit) {
  let s = await state();
  if (!(s.weapons & (1 << weaponBit))) {
    const it = itemAt(itemType); if (!it) return false;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      await routeTo(it.origin, 8000, 20);
      s = await state(); if (s.weapons & (1 << weaponBit)) break;
      await sleep(500);
    }
  }
  s = await state(); if (!(s.weapons & (1 << weaponBit))) return false;
  await press(digit); await sleep(500); return true;
}
// long-frame recorder inside the page: every rAF gap > 8 ms is logged with its time, independent of the tool's polling
await ev(() => { window.__longFrames = []; let last = 0; (function loop() { const t = performance.now(); if (last && t - last > 8) window.__longFrames.push([+(t / 1000).toFixed(2), +(t - last).toFixed(1)]); last = t; requestAnimationFrame(loop); })(); });
async function aimAt(point, from) { await setAngles(pitchTo(from, point), yawTo(from, point)); }
// wait until a predicate on the client is true (polling), returns true on success
async function waitFor(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(fn)) return true; await sleep(16); } return false; }
const stats = [];
async function sample() { const s = await ev(() => { const a = window.__arena; const ft = a.hud.frameTimes; const avg = ft.length ? ft.reduce((x, y) => x + y, 0) / ft.length : 0; const p99 = ft.length ? [...ft].sort((x, y) => x - y)[Math.floor(ft.length * 0.99)] : 0; return { fps: avg ? 1000 / avg : 0, frameAvg: avg, frameP99: p99, ...a.renderer.frameStats }; }); s.t = (Date.now() - T0) / 1000; stats.push(s); return s; }
const T0 = Date.now();

const map = server.args.map;
const M = await ev(() => { const m = window.__arena.cg.map; return { items: m.items, spawns: m.spawns, bounds: m.bounds }; });
const itemAt = (type) => M.items.find((i) => i.type === type);
let s = await state();
console.log('spawned at', s.o.map(Math.round), 'bake', s.stats.bake, 'programs', s.stats.programs);
if (args.probe) { await sleep(2500); console.log('probe', JSON.stringify(await state())); console.log(logs.join('\n')); }

// 1. spawn view (world lighting + HUD at rest)
await sleep(400); await sample();
await shot('01_spawn');

// 2. item cluster: look at the nearest major item cluster from a little distance
{
  const rl = itemAt('weaponRocket') || M.items[0];
  const from = [rl.origin[0] - 260, rl.origin[1] - 60, rl.origin[2]];
  await routeTo(from, 9000, 60);
  s = await state(); await aimAt([rl.origin[0], rl.origin[1], rl.origin[2] - 4], [s.o[0], s.o[1], s.o[2] + 26]);
  await sleep(250); await sample();
  await shot('02_items');
}
// 3. rocket explosion: fire the RL at a wall ~300 units away and capture at the explosion
if (await ensureWeapon('weaponRocket', 5, 'Digit4')) {
  s = await state();
  // aim at a nearby wall: pick the map bound in the closest direction along x
  const wallX = (s.o[0] - M.bounds.mins[0] < M.bounds.maxs[0] - s.o[0]) ? M.bounds.mins[0] + 64 : M.bounds.maxs[0] - 64;
  await setAngles(4, wallX < s.o[0] ? 180 : 0);
  await sleep(100);
  await ev(() => { window.__arena.__lastExplode = 0; const r = window.__arena.renderer; const orig = r.effects.explosion.bind(r.effects); r.effects.explosion = (...a) => { window.__arena.__lastExplode = performance.now(); return orig(...a); }; });
  await fire(true); await sleep(60); await fire(false);
  const ok = await waitFor(() => window.__arena.__lastExplode > 0, 3000);
  await sample(); await shot('03_rocket_explosion'); console.log('explosion captured:', ok);
  await sleep(700); await shot('03b_rocket_smoke');
} else console.log('could not get the rocket launcher, skipping explosion shot');
// 4. rail trail: fire the railgun along the room (weapon given by pickup if present, else skip)
{
  if (await ensureWeapon('weaponRail', 7, 'Digit6')) {
    s = await state();
    await setAngles(2, s.o[0] > (M.bounds.mins[0] + M.bounds.maxs[0]) / 2 ? 180 : 0);
    await ev(() => { window.__arena.__rail = 0; const r = window.__arena.renderer; const orig = r.effects.railTrail.bind(r.effects); r.effects.railTrail = (...a) => { window.__arena.__rail = performance.now(); return orig(...a); }; });
    await fire(true); await sleep(60); await fire(false);
    const ok = await waitFor(() => window.__arena.__rail > 0 && performance.now() - window.__arena.__rail > 40, 3000);
    // step aside a little so the trail is seen from an angle
    await key('KeyD', true); await sleep(120); await key('KeyD', false);
    await sample(); await shot('04_rail_trail'); console.log('rail captured:', ok);
  } else console.log('no railgun on this map, skipping rail shot');
}
// 5. LG beam: hold fire with the lightning gun at a wall
{
  if (await ensureWeapon('weaponLightning', 6, 'Digit5')) {
    await setAngles(6, 45);
    await fire(true); await sleep(350); await sample();
    await shot('05_lg_beam');
    await fire(false);
  } else console.log('no lightning gun on this map, skipping LG shot');
}
// 6. enemy model: turn toward the bot when it is alive and in view range; keep firing for a combat HUD
{
  let got = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && !got) {
    s = await state();
    if (s.enemy && !s.enemy.d && !s.dead) {
      const d = Math.hypot(s.enemy.o[0] - s.o[0], s.enemy.o[1] - s.o[1]);
      if (d > 600) { await walkTo(s.enemy.o, 1500, 500); continue; } // close the distance (the bot roams)
      await aimAt([s.enemy.o[0], s.enemy.o[1], s.enemy.o[2] + 8], [s.o[0], s.o[1], s.o[2] + 26]);
      await sleep(80);
      await sample(); await shot('06_enemy'); got = true;
      await press('Digit2'); await sleep(400);
      await fire(true); await sleep(250); await sample(); await shot('07_hud_combat'); await fire(false);
    }
    await sleep(150);
  }
  if (!got) console.log('enemy never came into range for the model shot');
}
// 7. death camera: wait (still, firing occasionally) until the bot kills us, then capture
{
  const t0 = Date.now();
  let dead = false;
  while (Date.now() - t0 < 12000) { s = await state(); if (s.dead) { dead = true; break; } if (s.enemy && !s.enemy.d) await aimAt([s.enemy.o[0], s.enemy.o[1], s.enemy.o[2]], [s.o[0], s.o[1], s.o[2] + 26]); await sleep(200); }
  if (!dead && await ensureWeapon('weaponRocket', 5, 'Digit4')) { // fallback: rocket our own feet until we die (self damage is real Q3 behaviour)
    s = await state(); await setAngles(85, s.yaw);
    for (let i = 0; i < 8 && !dead; i++) { await fire(true); await sleep(80); await fire(false); await sleep(900); dead = (await state()).dead; }
  }
  if (dead) { await sleep(600); await sample(); await shot('08_death_cam'); } else console.log('no death cam shot: never died');
}
// performance: two windows with NO CDP traffic (no evaluate/keyboard/screenshot) while an in-page rAF recorder
// stores every frame time — (a) running + firing rockets, (b) turning with the LG on — then the numbers are read back.
async function perfWindow(name, ms, setup) {
  await setup();
  await ev(() => { window.__rec = { ft: [] }; let last = 0; (function loop() { const t = performance.now(); if (last) window.__rec.ft.push(t - last); last = t; if (window.__rec.on !== false) requestAnimationFrame(loop); })(); });
  await sleep(ms);
  const r = await ev(() => { const r = window.__rec; r.on = false; const ft = r.ft.slice(30); const s = [...ft].sort((a, b) => a - b); const sum = ft.reduce((a, b) => a + b, 0); return { frames: ft.length, fps: +(1000 / (sum / ft.length)).toFixed(1), avgMs: +(sum / ft.length).toFixed(2), p99Ms: +s[Math.floor(s.length * 0.99)].toFixed(2), maxMs: +s[s.length - 1].toFixed(2), over8ms: ft.filter((x) => x > 8).length, over16ms: ft.filter((x) => x > 16).length, ...window.__arena.renderer.frameStats }; });
  r.name = name; console.log('perf', name, JSON.stringify(r)); return r;
}
const perf = [];
perf.push(await perfWindow('run+rockets', 4000, async () => { await press('Digit4'); await key('KeyW', true); await key('KeyA', true); await fire(true); }));
await fire(false); await key('KeyW', false); await key('KeyA', false);
perf.push(await perfWindow('lg+strafe', 4000, async () => { await press('Digit5'); await setAngles(5, 45); await key('KeyD', true); await fire(true); }));
await fire(false); await key('KeyD', false);
const fps = perf.map((p) => p.fps), p99 = perf.map((p) => p.p99Ms);
const longFrames = await ev(() => window.__longFrames);
const summary = { perf, longFramesWholeRun: { note: 'includes stalls caused by the tool itself (screenshots, CDP round trips)', count: longFrames.length, over16ms: longFrames.filter((f) => f[1] > 16).length, worst: longFrames.slice().sort((a, b) => b[1] - a[1]).slice(0, 8) }, map, port, resolution: `${W}x${H}`, uncapped: true, fps: { avg: +(fps.reduce((a, b) => a + b, 0) / fps.length).toFixed(1), min: +Math.min(...fps).toFixed(1) }, frameP99: { max: +Math.max(...p99).toFixed(2), avg: +(p99.reduce((a, b) => a + b, 0) / p99.length).toFixed(2) }, draws: perf[perf.length - 1].draws, tris: perf[perf.length - 1].tris, programs: perf[perf.length - 1].programs, particles: Math.max(...perf.map((p) => p.particles)), bake: perf[perf.length - 1].bake, worldVerts: perf[0].worldVerts, worldTris: perf[0].worldTris, logs: [...new Set(logs)].slice(0, 30) };
fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify({ summary, samples: stats, perf }, null, 2));
console.log(JSON.stringify(summary, null, 2));
await browser.close();
await server.close();
process.exit(0);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
