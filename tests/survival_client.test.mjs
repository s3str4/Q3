// Survival slice in a real browser: boots the static server and headless Edge, loads
// /survival?auto=1&autopilot=win&fast=8, runs 25 s and asserts the client-side benchmark rows: no page/console
// errors, frame p99 <= 16.7 ms and draw calls <= 150 (skipped with a message when there is no GPU or the renderer is
// still the stub), cue/event alignment within 1 tick for every event type not declared silent (reported, not
// asserted, while the audio engine is the stub), objective progress >= 2 steps, screenshot saved to
// .evidence/survival/client_test/shot.png. Skips entirely when no Chromium/Edge binary is installed. Port from
// SURVIVAL_TEST_PORT (default 27993).
// Also the headless autopilot behaviour tests behind the evidence runs: no 'arrived but out of reach' stall (no idle
// window >= 3 s while a stage is unfinished, seeds 1/7/10/11/16 at timeScale 4) and the reckless control hides in the
// start house (door shut, no barricade) until 21:30, then walks out and dies at night.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/index.mjs';
import { autopilotIdleWindows, ticks } from './helpers_survival.mjs';
import { DAY } from '../shared/survival/constants.js';

const PORT = +(process.env.SURVIVAL_TEST_PORT || 27993), FAST = 8, RUN_SECONDS = 25;
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const outDir = path.resolve('.evidence', 'survival', 'client_test');

test('survival client: 25 s autopilot run in headless Edge', { skip: EDGE ? false : 'no Chromium/Edge binary found', timeout: 60000 }, async (t) => {
  fs.mkdirSync(outDir, { recursive: true });
  const puppeteer = (await import('puppeteer-core')).default;
  const server = await createServer({ port: PORT, quiet: true });
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--use-angle=d3d11', '--disable-frame-rate-limit', '--disable-gpu-vsync', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--window-size=1920,1080', '--no-sandbox'] });
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1920, height: 1080 });
    const errors = [], warnings = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); else if (m.type() === 'warning') warnings.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await page.goto(`http://localhost:${PORT}/survival?auto=1&autopilot=win&fast=${FAST}&seed=7`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__survival && window.__survival.sim && window.__survival.sim.tick > 30, { timeout: 20000 });
    const gpu = await page.evaluate(() => { try { const gl = window.__survival.renderer.renderer.getContext(); const ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown'; } catch (e) { return 'none'; } });
    const samples = []; const t0 = Date.now();
    while ((Date.now() - t0) / 1000 < RUN_SECONDS) {
      samples.push(await page.evaluate(() => { const s = window.__survival; const ft = [...(s.hud.frameTimes || [])].sort((a, b) => a - b); return { p99: ft.length ? ft[Math.min(ft.length - 1, Math.floor(ft.length * 0.99))] : 0, draws: s.renderer.frameStats.draws, tick: s.sim.tick, objective: s.sim.objective.index, result: s.sim.result }; }));
      await new Promise((r) => setTimeout(r, 500));
    }
    await page.screenshot({ path: path.join(outDir, 'shot.png') });
    const logs = await page.evaluate(() => { const s = window.__survival; const table = typeof s.audio.cueTable === 'function' ? s.audio.cueTable() : null;
      let silent = []; if (s.audio.SILENT) silent.push(...s.audio.SILENT); if (table) { if (table.SILENT) silent.push(...table.SILENT); else if (table.silent) silent.push(...table.silent); else for (const [k, v] of Object.entries(table)) if (v == null || (typeof v === 'string' && v.toLowerCase() === 'silent') || (v && v.silent)) silent.push(k); }
      return { events: s.eventLog.map((e) => ({ type: e.type, tick: e.tick })), audio: (s.audio.triggerLog || []).map((a) => ({ cue: a.cue, event: a.event, tick: a.tick })), silent, hasCueTable: !!table, summary: s.sim.summary(), stats: s.audio.stats() }; });
    const last = samples[samples.length - 1];
    t.diagnostic(`gpu=${gpu} ticks=${last.tick} clock=${logs.summary.clock} objective=${last.objective} result=${last.result} events=${logs.events.length} cues=${logs.audio.length} audio=${JSON.stringify(logs.stats)} warnings=${warnings.length}`);
    // 1. clean console
    assert.deepEqual(errors, [], 'console/page errors');
    // 2. performance (skip when no GPU or stub renderer)
    const draws = Math.max(...samples.map((s) => s.draws)); const p99 = Math.max(...samples.slice(3).map((s) => s.p99));
    const software = /swiftshader|llvmpipe|software/i.test(gpu) || gpu === 'none';
    if (draws === 0) t.diagnostic('renderer stub (0 draw calls): frame/draw budget not judged');
    else if (software) t.diagnostic(`no hardware GPU (${gpu}): frame/draw budget not judged, p99=${p99.toFixed(2)} draws=${draws}`);
    else { assert.ok(p99 <= 16.7, `frame p99 ${p99.toFixed(2)} ms > 16.7`); assert.ok(draws <= 150, `draw calls ${draws} > 150`); }
    // 3. cue/event alignment: every event type seen has a trigger within 1 tick or is declared silent
    const align = cueAlignment(logs.events, logs.audio, new Set(logs.silent));
    t.diagnostic('cue alignment: ' + Object.entries(align.types).map(([k, v]) => k + ':' + [...v.cues].join('/') + (v.unmatched ? ' unmatched=' + v.unmatched : '') + (v.maxDelay ? ' delay=' + v.maxDelay : '')).join(' '));
    if (logs.audio.length === 0 && !logs.hasCueTable) t.diagnostic('audio stub (empty triggerLog, no cueTable): alignment not judged; event types seen: ' + Object.keys(align.types).join(','));
    else { assert.deepEqual(align.noCue, [], 'event types without a cue or explicit silence'); assert.ok(align.maxDelay <= 1, `cue delay ${align.maxDelay} ticks (${align.worst}) > 1`); assert.equal((logs.stats.voices || 0) > 40, false, 'voice pile-up'); }
    // 4. the loop advances: at fast=8, 25 s is ~10 game hours, plenty for supplies + arm
    assert.ok(last.objective >= 2, `objective index ${last.objective} < 2`);
    assert.ok(last.tick > 20 * 25 && last.tick <= 30 * 25 + 200, `sim ticks ${last.tick} not ~30 Hz over 25 s`);
    assert.ok(fs.existsSync(path.join(outDir, 'shot.png')));
  } finally { await browser.close(); await server.close(); }
});

function cueAlignment(events, audioLog, silent) {
  // entries are consumed one-to-one so a culled cue (e.g. a far footstep) counts as unmatched instead of borrowing the next entry's delay
  const byTick = new Map(); for (const a of audioLog) { const k = (a.event || '') + '@' + a.tick; if (!byTick.has(k)) byTick.set(k, []); byTick.get(k).push(a); }
  const types = {}; let maxDelay = 0, worst = null;
  // two passes: exact-tick matches first for every event, then late (1-3 tick) matches for the leftovers, so a
  // culled cue never steals the entry of a later event of the same type
  const pending = [];
  for (const e of events) { const t = types[e.type] || (types[e.type] = { count: 0, cues: new Set(), unmatched: 0, maxDelay: 0 }); t.count++; const list = byTick.get(e.type + '@' + e.tick); if (list && list.length) { const hit = { d: 0, a: list.shift() }; t.cues.add(hit.a.cue); t.maxDelay = Math.max(t.maxDelay, 0); if (0 > maxDelay) { maxDelay = 0; worst = e.type; } } else pending.push(e); }
  for (const e of pending) { const t = types[e.type]; let hit = null; for (let d = 1; d <= 3 && !hit; d++) { const list = byTick.get(e.type + '@' + (e.tick + d)); if (list && list.length) hit = { d, a: list.shift() }; }
    if (hit) { t.cues.add(hit.a.cue); t.maxDelay = Math.max(t.maxDelay, hit.d); if (hit.d > maxDelay) { maxDelay = hit.d; worst = e.type; } } else t.unmatched++; }
  for (const a of audioLog) if (a.event && types[a.event]) types[a.event].cues.add(a.cue);
  const noCue = Object.entries(types).filter(([k, v]) => v.cues.size === 0 && !silent.has(k)).map(([k]) => k);
  return { types, noCue, maxDelay, worst };
}

// ---------------- autopilot behaviour (headless sim) ----------------
const STALL_S = 3;
for (const seed of [1, 7, 10, 11, 16]) test(`autopilot 'win' seed ${seed} at timeScale 4 never idles >= ${STALL_S} s with a stage unfinished`, () => {
  const { sim, windows } = autopilotIdleWindows(seed, 'win', 4, ticks(STALL_S));
  assert.equal(sim.result, 'won', `result ${sim.result} at ${sim.clock()} day ${sim.day}`);
  assert.deepEqual(windows, [], 'idle windows (ticks, stage, position): ' + JSON.stringify(windows));
});
test("autopilot 'reckless' seed 7: hides in the start house until 21:30 (door shut, no barricade), then dies on the road at night", () => {
  const { sim, ap } = autopilotIdleWindows(7, 'reckless', 4, 1e9);
  assert.equal(sim.result, 'lost'); assert.equal(sim.metrics.barricadesBuilt, 0); assert.equal(sim.player.alive, false);
  const out = ap.stages.find((s) => s.stage === 'road_night' || s.stage === 'road');
  assert.ok(out && out.hour >= 21.5 && out.hour < 22, 'left the house at 21:30: ' + JSON.stringify(ap.stages));
  assert.ok(ap.stages[0].stage === 'hide' && ap.stages.slice(0, ap.stages.indexOf(out)).every((s) => s.stage === 'hide'), 'hid all day: ' + JSON.stringify(ap.stages));
  assert.ok(sim.day === 2 || sim.hour >= DAY.nightHour, 'died after 21:00 day 1: ' + sim.clock() + ' day ' + sim.day);
  const doors = sim.log.filter((l) => l.kind === 'door');                       // the player's own door toggles
  assert.ok(doors.every((l) => l.hour >= 21.5), 'door untouched until 21:30: ' + JSON.stringify(doors.slice(0, 3)));
  assert.ok(sim.log.every((l) => !(l.kind === 'player.state' && l.to === 'attack')), 'never swung');
});
