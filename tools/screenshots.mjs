#!/usr/bin/env node
// Vantage screenshots + visual assertions for the evidence: starts a server (+1 bot) on --port, drives a real
// headless Edge client through window.__arena (same input path as tools/evidence.mjs) and captures 1920x1080 PNGs
// into .evidence/screens/:
//   tone_*.png      free-camera vantages (renderer.freeCamera, HUD hidden, frame-exact readPixels): every spawn view
//                   and every major item's floor view, each with tonal statistics (luminance std / inter-quartile
//                   range, mean saturation, blue/red ratio) asserted against the id Tech 3 lightmap targets
//   fx_*.png        frame-exact captures scheduled inside the page relative to the fire / explosion events (a CDP
//                   page.screenshot blocks ~1 s while the game keeps simulating, so timed effect shots cannot use it):
//                   rocket in flight with its trail, fireball, smoke column at +500 / +1000 ms, with darker / brighter
//                   pixel fractions measured against a reference frame in a window around the impact point
//   01..08_*.png    the gameplay shots (spawn, item cluster, explosion, scorch, rail trail, LG beam, enemy model,
//                   HUD in combat, death camera) via page.screenshot, HUD included
// and records fps / frame p99 / draw calls with the frame-rate limit disabled so the renderer's own cost is measured
// rather than the display refresh. stats.json carries every number and a `pass` verdict per check.
// usage: node tools/screenshots.mjs [--map testbox] [--port 27986] [--out .evidence/screens] [--headed] [--tone-only] [--bots 1]
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/index.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const port = +(args.port || 27986);
const W = +(args.width || 1920), H = +(args.height || 1080);
const outDir = path.resolve(args.out || path.join('.evidence', 'screens'));
fs.mkdirSync(outDir, { recursive: true });
// stale captures from a previous run must not survive next to a fresh stats.json
for (const f of fs.readdirSync(outDir)) if (/^(fx_|tone_|\d\d[a-z]?_).*\.png$/.test(f)) fs.unlinkSync(path.join(outDir, f));
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('no Chromium browser found'); process.exit(1); }
const puppeteer = (await import('puppeteer-core')).default;
const toneOnly = !!args['tone-only'];
const bots = args.bots !== undefined ? +args.bots : (toneOnly ? 0 : 1);

// Tonal targets (HUD-excluded region x 0-1700, y 110-940 of a 1920x1080 frame). An id Tech 3 lightmapped room has
// dark corners and bright pools: a luminance inter-quartile range >= 0.25 and std >= 0.18; it is coloured but not
// monochrome: mean saturation >= 0.45 with the blue channel at most 1.6x the red on average.
const TONE = { region: { x: 0, y: 110, w: 1700, h: 830 }, minIqr: 0.25, minStd: 0.18, minSat: 0.45, maxBlueOverRed: 1.6 };

const server = await createServer({ port, map: args.map || 'testbox', mode: 'duel', bots, quiet: true, botSkill: +(args.skill || 0.05) }); // a mild bot: it still roams into the enemy shot, but rarely wrecks a timed capture
const browser = await puppeteer.launch({ executablePath: EDGE, headless: !args.headed, args: ['--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--disable-frame-rate-limit', '--disable-gpu-vsync', `--window-size=${W},${H}`, '--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H });
const logs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text().slice(0, 400)));
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
await page.goto(`http://localhost:${port}/?auto=1&bot=${bots ? 1 : 0}&nolock=1&name=Screens`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__arena && window.__arena.cg && window.__arena.cg.predicted, { timeout: 15000 });
// every shot must show the finished bake (AO + shadows + bounce), not the flat pre-bake estimate
await page.waitForFunction(() => window.__arena.renderer.frameStats.bake >= 1, { timeout: 40000 }).catch(() => console.log('bake did not finish in 40 s'));
await sleep(1200);

// ---- helpers: drive the Input object exactly like evidence.mjs (no pointer lock headless) ----
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const setAngles = (pitch, yaw) => ev((p, y) => { window.__arena.input.setAngles(p, y); }, pitch, yaw);
const fire = (on) => ev((d) => { window.__arena.input.mouseButtons = d ? 1 : 0; }, on);
const key = async (k, down) => (down ? page.keyboard.down(k) : page.keyboard.up(k));
const press = async (k) => page.keyboard.press(k);
const state = () => ev(async () => {
  const a = window.__arena, cg = a.cg, p = cg.predicted; const en = [...cg.remote.values()][0];
  let los = false;
  if (en) { // line of sight to the enemy (eye to chest), so the model shot is not taken face-first into a wall
    const { traceBox } = await import('/shared/trace.js');
    const eye = [p.ps.origin[0], p.ps.origin[1], p.ps.origin[2] + 26];
    los = traceBox(cg.game.world, eye, [en.origin[0], en.origin[1], en.origin[2] + 8], [0, 0, 0], [0, 0, 0], null, { skipFlags: 4 }).fraction >= 1;
  }
  return { o: p.ps.origin, yaw: p.ps.viewangles[1], w: p.weapon, weapons: p.weapons, ammo: p.ammo, hp: p.health, dead: p.dead, enemy: en ? { o: en.origin, d: en.d, w: en.w, los } : null, stats: a.renderer.frameStats };
});
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
    while (Date.now() - t0 < 40000) {
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

// ---- frame-exact capture machinery (in page): renderer.afterRender runs right after the last composer pass, so a
// readPixels there is exactly the frame that was just drawn, at the time the job asked for ----
await ev(() => {
  const r = window.__arena.renderer;
  const cap = window.__cap = { jobs: [], results: {} };
  r.afterRender = (gl) => {
    const now = performance.now();
    for (const j of cap.jobs) {
      if (j.done || now < j.at) continue;
      j.done = true;
      r.renderer.setRenderTarget(null); // three's state stays in sync (the output pass already rendered to screen)
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      cap.results[j.name] = { buf, w, h, t: now, meta: j.meta || null };
    }
    cap.jobs = cap.jobs.filter((j) => !j.done);
  };
  // wait until a named capture exists
  window.__capWait = (name, timeoutMs) => new Promise((res) => { const t0 = performance.now(); (function poll() { if (cap.results[name]) return res(true); if (performance.now() - t0 > timeoutMs) return res(false); setTimeout(poll, 8); })(); });
  // PNG (base64) of a capture, rows flipped to top-down
  window.__capPng = (name) => {
    const c = cap.results[name]; if (!c) return null;
    const cv = document.createElement('canvas'); cv.width = c.w; cv.height = c.h; const ctx = cv.getContext('2d'); const img = ctx.createImageData(c.w, c.h);
    for (let y = 0; y < c.h; y++) img.data.set(c.buf.subarray((c.h - 1 - y) * c.w * 4, (c.h - y) * c.w * 4), y * c.w * 4);
    // readPixels leaves alpha at whatever the buffer holds; the screenshot is opaque
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    ctx.putImageData(img, 0, 0); return cv.toDataURL('image/png').split(',')[1];
  };
  // tonal statistics of a capture inside a CSS-pixel region (top-down y)
  window.__capTone = (name, reg) => {
    const c = cap.results[name]; if (!c) return null;
    const sx = c.w / window.innerWidth, sy = c.h / window.innerHeight;
    const x0 = Math.round(reg.x * sx), x1 = Math.round((reg.x + reg.w) * sx), yTop = Math.round(reg.y * sy), yBot = Math.round((reg.y + reg.h) * sy);
    const L = new Float32Array((x1 - x0) * (yBot - yTop)); let n = 0, rs = 0, gs = 0, bs = 0, sat = 0;
    for (let y = yTop; y < yBot; y++) {
      const row = (c.h - 1 - y) * c.w;
      for (let x = x0; x < x1; x++) {
        const i = (row + x) * 4, r = c.buf[i], g = c.buf[i + 1], b = c.buf[i + 2];
        L[n++] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; rs += r; gs += g; bs += b;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b); sat += mx ? (mx - mn) / mx : 0;
      }
    }
    const S = L.slice(0, n).sort(); let mean = 0; for (let i = 0; i < n; i++) mean += S[i]; mean /= n;
    let v = 0; for (let i = 0; i < n; i++) v += (S[i] - mean) * (S[i] - mean);
    const q = (p) => +S[Math.min(n - 1, Math.floor(n * p))].toFixed(3);
    let dark = 0, bright = 0; for (let i = 0; i < n; i++) { if (S[i] < 0.12) dark++; else if (S[i] > 0.7) bright++; }
    return { meanLum: +mean.toFixed(3), stdLum: +Math.sqrt(v / n).toFixed(3), p5: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95), iqr: +(q(0.75) - q(0.25)).toFixed(3), darkFrac: +(dark / n).toFixed(3), brightFrac: +(bright / n).toFixed(3), meanRGB: [rs / n, gs / n, bs / n].map(Math.round), meanSat: +(sat / n).toFixed(3), blueOverRed: +(bs / Math.max(1, rs)).toFixed(2), redOverBlue: +(rs / Math.max(1, bs)).toFixed(2) };
  };
  // pixel-change statistics of capture `name` against capture `ref` inside a window (buffer pixels, top-down y)
  window.__capDiff = (name, ref, win, thr) => {
    const A = cap.results[ref], B = cap.results[name]; if (!A || !B) return null;
    let n = 0, ch = 0, darker = 0, brighter = 0, dl = 0;
    const x0 = Math.max(0, win.x), x1 = Math.min(A.w, win.x + win.w), y0 = Math.max(0, win.y), y1 = Math.min(A.h, win.y + win.h);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = ((A.h - 1 - y) * A.w + x) * 4; n++;
      const la = 0.2126 * A.buf[i] + 0.7152 * A.buf[i + 1] + 0.0722 * A.buf[i + 2], lb = 0.2126 * B.buf[i] + 0.7152 * B.buf[i + 1] + 0.0722 * B.buf[i + 2];
      const d = Math.max(Math.abs(A.buf[i] - B.buf[i]), Math.abs(A.buf[i + 1] - B.buf[i + 1]), Math.abs(A.buf[i + 2] - B.buf[i + 2]));
      dl += (lb - la) / 255;
      if (d > thr) { ch++; if (lb < la - thr * 0.7) darker++; else if (lb > la + thr * 0.7) brighter++; }
    }
    return { tMs: +(B.t - A.t).toFixed(0), changedFrac: +(ch / n).toFixed(4), darkerFrac: +(darker / n).toFixed(4), brighterFrac: +(brighter / n).toFixed(4), meanLumDelta: +(dl / n).toFixed(4) };
  };
  window.__capDrop = (name) => { delete cap.results[name]; };
});
// schedule a frame-exact capture `delayMs` from now (in page time) and wait for it
async function capture(name, delayMs = 0, timeoutMs = 3000) {
  await ev((n, d) => { window.__cap.jobs.push({ name: n, at: performance.now() + d }); }, name, delayMs);
  return ev((n, t) => window.__capWait(n, t), name, timeoutMs + delayMs);
}
async function savePng(name, file = name) {
  const b64 = await ev((n) => window.__capPng(n), name);
  if (!b64) return null;
  const f = path.join(outDir, file + '.png'); fs.writeFileSync(f, Buffer.from(b64, 'base64')); console.log('shot', path.relative(process.cwd(), f)); return f;
}
const toneOf = (name) => ev((n, r) => window.__capTone(n, r), name, TONE.region);
const toneVerdict = (t, colour = true) => t ? { passContrast: t.iqr >= TONE.minIqr && t.stdLum >= TONE.minStd, passColour: !colour || (t.meanSat >= TONE.minSat && t.blueOverRed <= TONE.maxBlueOverRed), pass: t.iqr >= TONE.minIqr && t.stdLum >= TONE.minStd && (!colour || (t.meanSat >= TONE.minSat && t.blueOverRed <= TONE.maxBlueOverRed)), ...t } : null;
// tonal stats of an already-saved screenshot PNG (decoded in the page), same region
async function toneOfFile(file) {
  const b64 = fs.readFileSync(file).toString('base64');
  await ev(async (s, name) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + s; await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height; const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data; const buf = new Uint8Array(d.length);
    for (let y = 0; y < img.height; y++) buf.set(d.subarray(y * img.width * 4, (y + 1) * img.width * 4), (img.height - 1 - y) * img.width * 4); // bottom-up like readPixels
    window.__cap.results[name] = { buf, w: img.width, h: img.height, t: 0 };
  }, b64, 'file');
  const t = await toneOf('file'); await ev(() => window.__capDrop('file'));
  return toneVerdict(t);
}

const map = server.args.map;
const M = await ev(() => { const m = window.__arena.cg.map; return { items: m.items, spawns: m.spawns, bounds: m.bounds }; });
const itemAt = (type) => M.items.find((i) => i.type === type);
let s = await state();
console.log('spawned at', s.o.map(Math.round), 'bake', s.stats.bake, 'programs', s.stats.programs);
if (args.probe) { await sleep(2500); console.log('probe', JSON.stringify(await state())); console.log(logs.join('\n')); }

// ================= tone vantages (free camera, HUD hidden) =================
// Every spawn twice (its own view direction, and the yaw with the longest free line of sight: the room from the
// spawn), and every non-weapon major item (eye 32 above the item, looking toward the map centre). Contrast (std,
// inter-quartile range) is asserted everywhere; the colour checks (saturation floor, blue/red ceiling) only in the
// atria, i.e. vantages within ATRIUM_R of a Mega Health / Red Armor: a white-lit hub is neutral by design.
const ATRIUM_R = 720;
const tone = {};
{
  await ev(() => { window.__arena.hud.hide(); });
  const cx = (M.bounds.mins[0] + M.bounds.maxs[0]) / 2, cy = (M.bounds.mins[1] + M.bounds.maxs[1]) / 2;
  const majors = M.items.filter((it) => it.type === 'mega' || it.type === 'armorRed');
  const inAtrium = (o) => majors.some((it) => Math.hypot(it.origin[0] - o[0], it.origin[1] - o[1]) < ATRIUM_R);
  const vantages = [];
  for (let i = 0; i < M.spawns.length; i++) {
    const sp = M.spawns[i], eye = [sp.origin[0], sp.origin[1], sp.origin[2] + 26];
    vantages.push({ name: `tone_spawn${i}`, origin: eye, pitch: 0, yaw: sp.yaw || 0 });
    const long = await ev(async (eye) => { // longest free eye-level line over 32 yaws (the critic's "spawn long view")
      const { traceBox } = await import('/shared/trace.js'); const cg = window.__arena.cg; let best = { yaw: 0, d: 0 };
      for (let k = 0; k < 32; k++) { const yaw = k * 11.25, r = yaw * Math.PI / 180, end = [eye[0] + Math.cos(r) * 3000, eye[1] + Math.sin(r) * 3000, eye[2]]; const d = traceBox(cg.game.world, eye, end, [0, 0, 0], [0, 0, 0], null, { skipFlags: 4 }).fraction * 3000; if (d > best.d) best = { yaw, d }; }
      return best;
    }, eye);
    vantages.push({ name: `tone_spawn${i}_long`, origin: eye, pitch: 0, yaw: long.yaw, lookDist: Math.round(long.d) });
  }
  // major items: from a player standing at the pickup, looking down the longest free line (along the atrium)
  for (const it of M.items.filter((it) => it.type === 'mega' || it.type === 'armorRed' || it.type === 'armorYellow')) {
    const eye = [it.origin[0], it.origin[1], it.origin[2] + 32];
    const long = await ev(async (eye) => { const { traceBox } = await import('/shared/trace.js'); const cg = window.__arena.cg; let best = { yaw: 0, d: 0 }; for (let k = 0; k < 32; k++) { const yaw = k * 11.25, r = yaw * Math.PI / 180, end = [eye[0] + Math.cos(r) * 3000, eye[1] + Math.sin(r) * 3000, eye[2]]; const d = traceBox(cg.game.world, eye, end, [0, 0, 0], [0, 0, 0], null, { skipFlags: 4 }).fraction * 3000; if (d > best.d) best = { yaw, d }; } return best; }, eye);
    vantages.push({ name: `tone_${it.type}${vantages.length}`, origin: eye, pitch: 5, yaw: long.yaw, lookDist: Math.round(long.d) });
  }
  for (const v of vantages) {
    await ev((v) => { window.__arena.renderer.freeCamera = { origin: v.origin, angles: [v.pitch, v.yaw] }; }, v);
    await sleep(120); // a few frames: item bob / bake uploads settle
    await capture(v.name, 30);
    await savePng(v.name);
    tone[v.name] = { origin: v.origin.map(Math.round), yaw: Math.round(v.yaw), lookDist: v.lookDist, atrium: inAtrium(v.origin), ...toneVerdict(await toneOf(v.name), inAtrium(v.origin)) };
    await ev((n) => window.__capDrop(n), v.name);
    console.log('tone', v.name, JSON.stringify(tone[v.name]));
  }
  await ev(() => { window.__arena.renderer.freeCamera = null; window.__arena.hud.show(); });
  await sleep(200);
}
const toneSummary = { targets: TONE, atriumRadius: ATRIUM_R, vantages: tone, pass: Object.values(tone).every((t) => t.pass) };
if (toneOnly) {
  fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify({ summary: { map, port, tone: toneSummary, logs: [...new Set(logs)].slice(0, 30) } }, null, 2));
  console.log(JSON.stringify(toneSummary, null, 2));
  await browser.close(); await server.close(); process.exit(0);
}

// ================= gameplay shots =================
// 1. spawn view (world lighting + HUD at rest)
await sleep(400); await sample();
const spawnShot = await shot('01_spawn');
tone['01_spawn'] = await toneOfFile(spawnShot);

// 2. item cluster: look at the nearest major item cluster from a little distance
{
  const rl = itemAt('weaponRocket') || M.items[0];
  const from = [rl.origin[0] - 260, rl.origin[1] - 60, rl.origin[2]];
  await routeTo(from, 9000, 60);
  s = await state(); await aimAt([rl.origin[0], rl.origin[1], rl.origin[2] - 4], [s.o[0], s.o[1], s.o[2] + 26]);
  await sleep(250); await sample();
  await shot('02_items');
}
// 3. rocket explosion: fire the RL at a wall ~300 units away; frame-exact captures of the flight (trail), the
// fireball and the smoke column, each measured against a reference frame in a window around the impact point
const fx = {};
// wait until alive with the launcher in hand (the bot may have killed us on the way to the pickup)
async function aliveWithRocket() { for (let i = 0; i < 20; i++) { s = await state(); if (!s.dead && (s.weapons & (1 << 5))) break; await sleep(300); } await press('Digit4'); await sleep(450); s = await state(); return !s.dead && (s.weapons & (1 << 5)) !== 0; }
async function botFar() { for (let i = 0; i < 50; i++) { s = await state(); if (!s.enemy || s.enemy.d || Math.hypot(s.enemy.o[0] - s.o[0], s.enemy.o[1] - s.o[1]) > 700) return true; await sleep(300); } return false; }
// up to 3 attempts: get the launcher (re-routing to the pickup after a death), let the bot get far, confirm we still hold it
let ready = false;
for (let attempt = 0; attempt < 3 && !ready; attempt++) { if (!(await ensureWeapon('weaponRocket', 5, 'Digit4'))) break; ready = await aliveWithRocket(); }
if (ready) {
  // aim at the nearest wall between 260 (outside our own splash radius) and 480 units (16 yaw directions traced in-page), so the fireball, the
  // shockwave ring and the clipped scorch mark are all large enough to judge; fall back to the map bound along x
  const wall = await ev(async () => {
    const { traceBox } = await import('/shared/trace.js');
    const cg = window.__arena.cg, o = cg.predicted.ps.origin, eye = [o[0], o[1], o[2] + 26];
    let best = null;
    for (let i = 0; i < 16; i++) {
      const yaw = i * 22.5, r = yaw * Math.PI / 180, end = [eye[0] + Math.cos(r) * 900, eye[1] + Math.sin(r) * 900, eye[2]];
      const tr = traceBox(cg.game.world, eye, end, [0, 0, 0], [0, 0, 0], null, { skipFlags: 4 });
      const d = tr.fraction * 900;
      const headOn = tr.plane ? Math.abs(tr.plane.n[0] * Math.cos(r) + tr.plane.n[1] * Math.sin(r)) : 0; // a grazing hit puts the blast far down the wall, small on screen
      if (tr.fraction < 1 && d >= 260 && tr.plane && Math.abs(tr.plane.n[2]) < 0.5 && headOn >= 0.7 && (!best || d < best.d)) best = { yaw, d, end: tr.endpos };
    }
    return best;
  });
  s = await state();
  if (wall) await setAngles(2, wall.yaw);
  else { const wallX = (s.o[0] - M.bounds.mins[0] < M.bounds.maxs[0] - s.o[0]) ? M.bounds.mins[0] + 64 : M.bounds.maxs[0] - 64; await setAngles(4, wallX < s.o[0] ? 180 : 0); }
  await sleep(150);
  await capture('fx_ref', 30); // reference frame from the firing pose
  // hooks: the local FIRE schedules the in-flight capture, the explosion schedules the fireball / smoke captures
  // hooks filtered to OUR rocket: the bot's rockets explode too, and any of them would otherwise start the captures
  await ev((target) => {
    const a = window.__arena, r = a.renderer, cap = window.__cap; a.__lastExplode = 0; a.__fired = 0;
    const origFire = r.effects.localFire.bind(r.effects);
    r.effects.localFire = (e, cg) => { if (!a.__fired && e.weapon === 5 /* WEAPONS.ROCKET */) { a.__fired = performance.now(); cap.jobs.push({ name: 'fx_rocket_flight_150ms', at: a.__fired + 150 }); } return origFire(e, cg); };
    const orig = r.effects.explosion.bind(r.effects);
    r.effects.explosion = (o, n, w) => { const near = !target || Math.hypot(o[0] - target[0], o[1] - target[1], o[2] - target[2]) < 160; if (!a.__lastExplode && a.__fired && near) { a.__lastExplode = performance.now(); a.__explodeAt = o; for (const d of [30, 500, 1000]) cap.jobs.push({ name: 'fx_explosion_' + d + 'ms', at: a.__lastExplode + d }); } return orig(o, n, w); };
  }, wall ? wall.end : null);
  await fire(true); // hold fire until an explosion is seen (a weapon switch may still be in progress)
  const ok = await waitFor(() => window.__arena.__lastExplode > 0, 4500); await fire(false);
  // no page.screenshot until the timed captures are in: a CDP screenshot stalls the page ~1 s (the game keeps
  // simulating), which would push the +30 ms fireball capture past the fireball
  await ev(() => window.__capWait('fx_explosion_1000ms', 2500));
  await sample(); await shot('03_rocket_explosion'); console.log('explosion captured:', ok);
  // impact point on screen -> 700x700 measurement window (buffer pixels, top-down)
  const win = await ev(() => {
    const a = window.__arena, r = a.renderer, o = a.__explodeAt; if (!o) return null;
    const v = r.camera.position.clone().set(o[0], o[1], o[2]).project(r.camera);
    const gl = r.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const cx = Math.max(350, Math.min(w - 350, (v.x * 0.5 + 0.5) * w)), cy = Math.max(350, Math.min(h - 350, (1 - (v.y * 0.5 + 0.5)) * h)); // clamped on screen
    return { x: Math.round(cx - 350), y: Math.round(cy - 350), w: 700, h: 700, onScreen: Math.abs(v.x) < 1 && Math.abs(v.y) < 1 && v.z < 1 };
  });
  for (const n of ['fx_rocket_flight_150ms', 'fx_explosion_30ms', 'fx_explosion_500ms', 'fx_explosion_1000ms']) {
    if (!(await ev((n) => !!window.__cap.results[n], n))) { fx[n] = null; continue; }
    await savePng(n);
    // the trail runs from the muzzle to the wall: measured over the whole frame; the blast in its impact window
    const w = n.startsWith('fx_rocket_flight') ? { x: 0, y: 0, w: 4096, h: 4096 } : win;
    fx[n] = w ? await ev((n, w) => window.__capDiff(n, 'fx_ref', w, 14), n, w) : null;
    console.log('fx', n, JSON.stringify(fx[n]));
  }
  await ev(() => { for (const n of Object.keys(window.__cap.results)) window.__capDrop(n); });
  await sleep(1200); await shot('03c_scorch_mark'); // fireball and smoke gone: the mark clipped to the wall's faces
  // rocket trail proper: one rocket down the longest free line, captured 500 ms into the flight (450 units of
  // trail, the puffs behind it 0.5 s old at most) and measured over the whole frame against a fresh reference
  // the bot may kill us or we may be out of rockets between the explosion and this shot: every attempt re-arms
  // (re-routing to the pickup when the launcher or its ammo is gone), re-aims and takes a fresh reference frame
  await ev(() => { const a = window.__arena, r = a.renderer, cap = window.__cap; a.__fired2 = 0; const orig = r.effects.localFire; r.effects.localFire = (e, cg) => { if (!a.__fired2 && e.weapon === 5 /* WEAPONS.ROCKET */) { a.__fired2 = performance.now(); cap.jobs.push({ name: 'fx_rocket_trail_500ms', at: a.__fired2 + 500 }); } return orig(e, cg); }; });
  let long = { yaw: 0, d: 0 };
  for (let attempt = 0; attempt < 4 && !(await ev(() => !!window.__cap.results.fx_rocket_trail_500ms)); attempt++) {
    s = await state();
    if (s.dead || !(s.weapons & (1 << 5)) || (s.ammo && s.ammo[5] === 0)) { if (!(await ensureWeapon('weaponRocket', 5, 'Digit4'))) break; }
    if (!(await aliveWithRocket())) continue;
    s = await state();
    long = await ev(async (eye) => { const { traceBox } = await import('/shared/trace.js'); const cg = window.__arena.cg; let best = { yaw: 0, d: 0 }; for (let k = 0; k < 32; k++) { const yaw = k * 11.25, r = yaw * Math.PI / 180, end = [eye[0] + Math.cos(r) * 3000, eye[1] + Math.sin(r) * 3000, eye[2]]; const d = traceBox(cg.game.world, eye, end, [0, 0, 0], [0, 0, 0], null, { skipFlags: 4 }).fraction * 3000; if (d > best.d) best = { yaw, d }; } return best; }, [s.o[0], s.o[1], s.o[2] + 26]);
    await setAngles(-2, long.yaw); await sleep(700); // let the previous smoke clear
    await ev(() => window.__capDrop('fx_ref2')); await capture('fx_ref2', 30); // reference from the firing pose itself
    await fire(true); await waitFor(() => window.__arena.__fired2 > 0, 2500); await fire(false);
    await ev(() => window.__capWait('fx_rocket_trail_500ms', 1500));
    if (!(await ev(() => !!window.__cap.results.fx_rocket_trail_500ms))) await ev(() => { window.__arena.__fired2 = 0; }); // fired but the capture never came (e.g. died): allow another shot
  }
  if (await ev(() => window.__capWait('fx_rocket_trail_500ms', 3000))) {
    await savePng('fx_rocket_trail_500ms');
    fx.fx_rocket_trail_500ms = await ev(() => window.__capDiff('fx_rocket_trail_500ms', 'fx_ref2', { x: 0, y: 0, w: 4096, h: 4096 }, 14));
    fx.fx_rocket_trail_500ms.smokeParticles = await ev(() => window.__arena.renderer.effects.smoke.active);
    console.log('fx fx_rocket_trail_500ms', JSON.stringify(fx.fx_rocket_trail_500ms), 'free line', Math.round(long.d));
  } else console.log('no rocket trail capture');
  await ev(() => { for (const n of Object.keys(window.__cap.results)) window.__capDrop(n); });
} else console.log('could not get the rocket launcher, skipping explosion shot');
// smoke verdict: the column must still darken a real share of the impact window half a second after the blast
// (the scorch decal alone measured 1.9-3.1%), and the trail must be visible in flight
// (the scorch decal alone measured 1.9-3.1% darker in the critic's probe; the trail must change >= 2% of the frame)
// the column reads darker on a lit wall and lighter on a shadowed one, so the verdict counts changed pixels either way
const smokePass = !!(fx.fx_explosion_500ms && fx.fx_explosion_500ms.changedFrac >= 0.06 && fx.fx_explosion_1000ms && fx.fx_explosion_1000ms.changedFrac >= 0.05 && fx.fx_rocket_trail_500ms && fx.fx_rocket_trail_500ms.changedFrac >= 0.02);
// 4. rail trail: fire the railgun along the room (weapon given by pickup if present, else skip)
{
  if (await ensureWeapon('weaponRail', 7, 'Digit6')) {
    s = await state();
    await setAngles(2, s.o[0] > (M.bounds.mins[0] + M.bounds.maxs[0]) / 2 ? 180 : 0);
    await ev(() => { window.__arena.__rail = 0; const r = window.__arena.renderer; const orig = r.effects.railTrail.bind(r.effects); r.effects.railTrail = (...a) => { window.__arena.__rail = performance.now(); return orig(...a); }; });
    await fire(true);
    const ok = await waitFor(() => window.__arena.__rail > 0 && performance.now() - window.__arena.__rail > 40, 3000); await fire(false);
    // step aside a little so the trail is seen from an angle
    await key('KeyD', true); await sleep(120); await key('KeyD', false);
    await sample(); await shot('04_rail_trail'); console.log('rail captured:', ok);
  } else console.log(itemAt('weaponRail') ? 'could not reach the railgun in time, skipping rail shot' : 'no railgun on this map, skipping rail shot');
}
// 5. LG beam: hold fire with the lightning gun at a wall
{
  if (await ensureWeapon('weaponLightning', 6, 'Digit5')) {
    await setAngles(6, 45);
    await fire(true); await sleep(350); await sample();
    const f = await shot('05_lg_beam');
    await fire(false);
    tone['05_lg_beam'] = await toneOfFile(f);
  } else console.log(itemAt('weaponLightning') ? 'could not reach the lightning gun in time, skipping LG shot' : 'no lightning gun on this map, skipping LG shot');
}
// 6. enemy model: turn toward the bot when it is alive and in view range; keep firing for a combat HUD
{
  let got = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && !got) {
    s = await state();
    if (s.enemy && !s.enemy.d && !s.dead) {
      const d = Math.hypot(s.enemy.o[0] - s.o[0], s.enemy.o[1] - s.o[1]);
      if (d > 600 || !s.enemy.los) { await walkTo(s.enemy.o, 1500, 500); continue; } // close the distance / get a clear line (the bot roams)
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
const summary = {
  perf, longFramesWholeRun: { note: 'includes stalls caused by the tool itself (screenshots, CDP round trips)', count: longFrames.length, over16ms: longFrames.filter((f) => f[1] > 16).length, worst: longFrames.slice().sort((a, b) => b[1] - a[1]).slice(0, 8) },
  map, port, resolution: `${W}x${H}`, uncapped: true,
  fps: { avg: +(fps.reduce((a, b) => a + b, 0) / fps.length).toFixed(1), min: +Math.min(...fps).toFixed(1) }, frameP99: { max: +Math.max(...p99).toFixed(2), avg: +(p99.reduce((a, b) => a + b, 0) / p99.length).toFixed(2) },
  draws: perf[perf.length - 1].draws, tris: perf[perf.length - 1].tris, programs: perf[perf.length - 1].programs, particles: Math.max(...perf.map((p) => p.particles)), bake: perf[perf.length - 1].bake, worldVerts: perf[0].worldVerts, worldTris: perf[0].worldTris,
  tone: { ...toneSummary, gameplayShots: { '01_spawn': tone['01_spawn'] || null, '05_lg_beam': tone['05_lg_beam'] || null }, pass: Object.values(tone).every((t) => !t || t.pass) },
  smoke: { note: 'frame-exact captures vs a reference frame, 700x700 window around the impact point, change threshold 14/255', frames: fx, pass: smokePass },
  logs: [...new Set(logs)].slice(0, 30),
};
fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify({ summary, samples: stats, perf }, null, 2));
console.log(JSON.stringify(summary, null, 2));
await browser.close();
await server.close();
process.exit(0);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
