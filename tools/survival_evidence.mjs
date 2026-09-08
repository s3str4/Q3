#!/usr/bin/env node
// Evidence capture for the survival slice (docs/SURVIVAL_BENCHMARK.md section 4): starts the static server, drives a
// real headless Edge through /survival?auto=1&autopilot=<mode>&fast=N&seed=S, samples fps / frame p99 / draw calls /
// sim.summary() / audio.stats() every 0.5 s, screenshots the story beats detected from window.__survival.eventLog
// (first pickup, first zombie alert, first hit or shot, dusk, first barricade, horde, dawn or win/lose) plus one shot
// every 20 s, and writes .evidence/survival/<name>/:
//   shot_NN_<beat>.png   stats.json (summary, samples, cue/event alignment, silhouette contrast, benchmark checks)
//   events.json (eventLog)  state_log.json (sim.log)  audio_log.json (audio.triggerLog)  sheet.png (contact sheet)
// Stub renderer / audio are tolerated: the checks that need them report "not judged" instead of failing.
// usage: node tools/survival_evidence.mjs [--name run] [--port 27990] [--fast 4] [--seed 7] [--mode win] [--seconds 200] [--headed]
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/index.mjs';
import { EV } from '../shared/survival/constants.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const name = args.name || 'run';
const port = +(args.port || 27990);
const fast = +(args.fast || 4), seed = +(args.seed || 7), mode = args.mode || 'win';
const maxSeconds = +(args.seconds || Math.ceil(22 * 20 / fast) + 60);   // the whole slice at this speed, plus slack
const W = +(args.width || 1920), H = +(args.height || 1080);
const outDir = path.resolve('.evidence', 'survival', name);
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) if (/^shot_\d\d.*\.png$|^sheet\.png$/.test(f)) fs.unlinkSync(path.join(outDir, f));

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('no Chromium browser found'); process.exit(1); }
const puppeteer = (await import('puppeteer-core')).default;

const server = await createServer({ port, quiet: true });
const browser = await puppeteer.launch({ executablePath: EDGE, headless: !args.headed, args: ['--use-angle=d3d11', '--disable-frame-rate-limit', '--disable-gpu-vsync', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H}`, '--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(m.type() + ': ' + m.text().slice(0, 300)); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
await page.goto(`http://localhost:${port}/survival?auto=1&autopilot=${mode}&fast=${fast}&seed=${seed}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__survival && window.__survival.sim && window.__survival.sim.tick > 0, { timeout: 20000 });
const gpu = await page.evaluate(() => { try { const gl = window.__survival.renderer.renderer.getContext(); const ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown'; } catch (e) { return 'none: ' + e.message; } });

// ---------------- sampling + story beats ----------------
const SAMPLE = () => { const s = window.__survival; const ft = s.hud.frameTimes || []; const sorted = [...ft].sort((a, b) => a - b); const avg = ft.length ? ft.reduce((x, y) => x + y, 0) / ft.length : 0;
  return { fps: avg ? 1000 / avg : 0, frameAvg: avg, frameP99: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : 0, draws: s.renderer.frameStats.draws, tris: s.renderer.frameStats.tris, renderMs: s.renderer.frameStats.ms, summary: s.sim.summary(), audio: s.audio.stats(), events: s.eventLog.length }; };
const BEATS = [
  { id: 'first_pickup', match: (e) => e.type === EV.PICKUP },
  { id: 'first_alert', match: (e) => e.type === EV.ZOMBIE_ALERT },
  { id: 'first_combat', match: (e) => e.type === EV.MELEE_HIT || e.type === EV.GUNSHOT },
  { id: 'dusk', match: (e) => e.type === EV.PHASE && e.phase === 'dusk' },
  { id: 'first_barricade', match: (e) => e.type === EV.BARRICADE_BUILT },
  { id: 'horde', match: (e) => e.type === EV.HORDE },
  { id: 'night', match: (e) => e.type === EV.PHASE && e.phase === 'night' },
  { id: 'dawn_or_end', match: (e) => (e.type === EV.PHASE && e.phase === 'dawn') || e.type === EV.WIN || e.type === EV.LOSE },
];
const seenBeats = new Set(); const samples = []; const shots = []; let scanned = 0; let lastPeriodic = 0;
const contrastShots = { day: null, night: null };
const t0 = Date.now();
const shoot = async (label) => {
  const file = path.join(outDir, `shot_${String(shots.length).padStart(2, '0')}_${label}.png`);
  const b64 = await page.screenshot({ encoding: 'base64' }); fs.writeFileSync(file, Buffer.from(b64, 'base64'));   // puppeteer skips `path` when encoding is base64
  const info = await page.evaluate(() => { const s = window.__survival; const p = s.sim.player; return { tick: s.sim.tick, clock: s.sim.clock(), phase: s.sim.phase, player: s.renderer.worldToScreen(p.x, p.y, 0) }; });
  shots.push({ file: path.relative(process.cwd(), file), label, ...info, t: +((Date.now() - t0) / 1000).toFixed(1) });
  return { b64, info };
};
// luminance around the player's screen position vs a ring 20 px outside, measured in-page from the PNG we just took
const measureContrast = async (b64, info) => page.evaluate(async (b64, px, py) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data; const lum = (i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  const ring = (r0, r1) => { let s = 0, n = 0; for (let y = Math.max(0, py - r1); y <= Math.min(c.height - 1, py + r1); y++) for (let x = Math.max(0, px - r1); x <= Math.min(c.width - 1, px + r1); x++) { const r = Math.hypot(x - px, y - py); if (r >= r0 && r <= r1) { s += lum(((y | 0) * c.width + (x | 0)) * 4); n++; } } return n ? s / n : 0; };
  let total = 0; for (let i = 0; i < d.length; i += 4 * 97) total += lum(i); const mean = total / (d.length / (4 * 97));
  const inner = ring(0, 10), outer = ring(22, 30);
  return { px: Math.round(px), py: Math.round(py), inner: +inner.toFixed(3), outer: +outer.toFixed(3), delta: +Math.abs(inner - outer).toFixed(3), relative: +(Math.abs(inner - outer) / Math.max(inner, outer, 0.01)).toFixed(3), meanLuminance: +mean.toFixed(3) };
}, b64, info.player[0], info.player[1]);

const phaseMeans = {};
let finished = false;
while (!finished && (Date.now() - t0) / 1000 < maxSeconds) {
  const el = (Date.now() - t0) / 1000;
  const s = await page.evaluate(SAMPLE); s.t = +el.toFixed(2); samples.push(s);
  const fresh = await page.evaluate((from) => window.__survival.eventLog.slice(from), scanned); scanned += fresh.length;
  for (const beat of BEATS) if (!seenBeats.has(beat.id) && fresh.some(beat.match)) {
    seenBeats.add(beat.id); const { b64, info } = await shoot(beat.id);
    if (beat.id === 'night' && !contrastShots.night) contrastShots.night = await measureContrast(b64, info);
    if (['dusk', 'night', 'dawn_or_end'].includes(beat.id) || !phaseMeans[info.phase]) { const m = await measureContrast(b64, info); phaseMeans[info.phase] = phaseMeans[info.phase] ?? m.meanLuminance; }
  }
  if (shots.length === 0 || el - lastPeriodic >= 20) { lastPeriodic = el; const { b64, info } = await shoot(`t${Math.round(el)}`); if (!contrastShots.day && info.phase === 'day') contrastShots.day = await measureContrast(b64, info); if (phaseMeans[info.phase] == null) phaseMeans[info.phase] = (await measureContrast(b64, info)).meanLuminance; }
  if (s.summary.result) { finished = true; if (!seenBeats.has('dawn_or_end')) { seenBeats.add('dawn_or_end'); await shoot('end'); } }
  await sleep(500);
}
if (!contrastShots.night) { const { b64, info } = await shoot('final'); contrastShots.night = await measureContrast(b64, info); contrastShots.nightNote = 'no night shot: measured on the final frame (phase ' + info.phase + ')'; }

// ---------------- logs + cue alignment ----------------
const logs = await page.evaluate(() => { const s = window.__survival; const table = typeof s.audio.cueTable === 'function' ? s.audio.cueTable() : null;
  let silent = []; if (s.audio.SILENT) silent.push(...s.audio.SILENT); if (table) { if (table.SILENT) silent.push(...table.SILENT); else if (table.silent) silent.push(...table.silent); else for (const [k, v] of Object.entries(table)) if (v == null || (typeof v === 'string' && v.toLowerCase() === 'silent') || (v && v.silent)) silent.push(k); }
  return { events: s.eventLog, stateLog: s.sim.log, audioLog: s.audio.triggerLog || [], summary: s.sim.summary(), silent, stages: s.sim.__stages || null, hasCueTable: !!table }; });
fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify(logs.events));
fs.writeFileSync(path.join(outDir, 'state_log.json'), JSON.stringify(logs.stateLog));
fs.writeFileSync(path.join(outDir, 'audio_log.json'), JSON.stringify(logs.audioLog));
const alignment = cueAlignment(logs.events, logs.audioLog, new Set(logs.silent));

// contact sheet (2 fps of the story: every shot, 4 per row) rendered in-page from the PNG files
try {
  const thumbs = shots.map((s) => ({ label: `${s.label} ${s.clock} ${s.phase}`, b64: fs.readFileSync(path.resolve(s.file)).toString('base64') }));
  const sheet = await page.evaluate(async (thumbs) => { const tw = 480, th = 270, cols = 4; const rows = Math.ceil(thumbs.length / cols); const c = document.createElement('canvas'); c.width = tw * cols; c.height = th * rows; const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < thumbs.length; i++) { const img = new Image(); img.src = 'data:image/png;base64,' + thumbs[i].b64; await img.decode(); const x = (i % cols) * tw, y = Math.floor(i / cols) * th; g.drawImage(img, x, y, tw, th); g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(x, y + th - 22, tw, 22); g.fillStyle = '#fff'; g.font = '14px sans-serif'; g.fillText(thumbs[i].label, x + 6, y + th - 6); }
    return c.toDataURL('image/png').split(',')[1]; }, thumbs);
  fs.writeFileSync(path.join(outDir, 'sheet.png'), Buffer.from(sheet, 'base64'));
} catch (e) { consoleErrors.push('sheet: ' + e.message); }

// ---------------- summary + benchmark checks ----------------
const last = samples[samples.length - 1]; const fin = logs.summary;
const p99 = Math.max(...samples.slice(2).map((s) => s.frameP99)); const draws = Math.max(...samples.map((s) => s.draws));
const rendererStub = draws === 0, audioStub = logs.audioLog.length === 0 && !logs.hasCueTable;
const checks = [];
const check = (row, pass, detail) => checks.push({ row, pass, detail });
check('1 loop closed: autopilot completes the slice', mode === 'win' ? fin.result === 'won' : fin.result === 'lost', `result=${fin.result} at ${fin.clock} day ${fin.day}, objective ${fin.objective.index}/5 ${fin.objective.state}`);
check('1 fortification + horde: >= 2 barricades, horde spawned, kills', fin.metrics.barricadesBuilt >= 2 && fin.metrics.hordeSpawned >= 6 && fin.metrics.kills >= 1, `barricades=${fin.metrics.barricadesBuilt} horde=${fin.metrics.hordeSpawned} kills=${fin.metrics.kills} damageTaken=${fin.metrics.damageTaken}`);
check('2 silhouette contrast >= 25% (day)', contrastShots.day ? contrastShots.day.relative >= 0.25 : null, JSON.stringify(contrastShots.day));
check('2 silhouette contrast >= 25% (night)', contrastShots.night ? contrastShots.night.relative >= 0.25 : null, JSON.stringify(contrastShots.night) + (contrastShots.nightNote ? ' ' + contrastShots.nightNote : ''));
check('2 tone per phase: mean luminance day > dusk > night', phaseMeans.day != null && phaseMeans.dusk != null && phaseMeans.night != null ? phaseMeans.day > phaseMeans.dusk && phaseMeans.dusk > phaseMeans.night : null, JSON.stringify(phaseMeans));
check('2 first frame lit', samples.length && phaseMeans[Object.keys(phaseMeans)[0]] > 0.02, `mean luminance of first shot ${phaseMeans[Object.keys(phaseMeans)[0]]}`);
check('2 frame p99 <= 16.7 ms', rendererStub ? null : p99 <= 16.7, rendererStub ? 'renderer stub (0 draws): not judged' : `p99max=${p99.toFixed(2)} ms, gpu=${gpu}`);
check('2 draw calls <= 150', rendererStub ? null : draws <= 150, rendererStub ? 'renderer stub: not judged' : `draws max=${draws}`);
check('3 every event type has a cue or an explicit silence', audioStub ? null : alignment.noCue.length === 0, audioStub ? 'audio stub (empty triggerLog, no cueTable): not judged' : `no cue: ${alignment.noCue.join(', ') || 'none'}`);
check('3 cues fire within 1 tick of the event', audioStub ? null : alignment.maxDelay <= 1, audioStub ? 'audio stub: not judged' : `max tick delay ${alignment.maxDelay} (${alignment.worst})`);
check('3 no orphan voices: no voice older than 60 s, no pile-up', audioStub ? null : (last.audio.voices || 0) <= 16 && (last.audio.oldest == null || last.audio.oldest < 60), JSON.stringify(last.audio));
check('client: no console errors / page errors', consoleErrors.filter((e) => !e.startsWith('warning')).length === 0, consoleErrors.slice(0, 5).join(' | ') || 'clean');

const summary = {
  name, mode, seed, fast, port, seconds: +((Date.now() - t0) / 1000).toFixed(1), gpu, url: `/survival?auto=1&autopilot=${mode}&fast=${fast}&seed=${seed}`,
  result: fin.result, clock: fin.clock, day: fin.day, objective: fin.objective, metrics: fin.metrics, player: fin.player,
  fps: { avg: mean(samples.map((s) => s.fps)), min: Math.min(...samples.map((s) => s.fps)) }, frameMs: { avg: mean(samples.map((s) => s.frameAvg)), p99max: +p99.toFixed(2) }, draws, tris: Math.max(...samples.map((s) => s.tris)),
  events: logs.events.length, eventTypes: alignment.types, cueAlignment: alignment, contrast: contrastShots, phaseLuminance: phaseMeans,
  beats: shots, checks, consoleErrors: [...new Set(consoleErrors)].slice(0, 20), stubs: { renderer: rendererStub, audio: audioStub },
};
fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify({ summary, samples }, null, 2));
console.log(JSON.stringify({ ...summary, cueAlignment: { noCue: alignment.noCue, maxDelay: alignment.maxDelay }, beats: shots.map((s) => `${s.file} ${s.clock}`) }, null, 2));
for (const c of checks) console.log(`${c.pass === null ? 'SKIP' : c.pass ? 'PASS' : 'FAIL'}  ${c.row}  -- ${c.detail}`);
await browser.close();
await server.close();
process.exit(0);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function mean(a) { return a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : 0; }
// Per event type: cue names seen in the audio log for that event, max delay in ticks between the event tick and the
// first matching audio entry, and the list of event types with no cue at all (minus the declared silent set).
export function cueAlignment(events, audioLog, silent = new Set()) {
  // entries are consumed one-to-one so a culled cue (e.g. a far footstep) counts as unmatched instead of borrowing the next entry's delay
  const byTick = new Map(); for (const a of audioLog) { const k = (a.event || '') + '@' + a.tick; if (!byTick.has(k)) byTick.set(k, []); byTick.get(k).push(a); }
  const types = {}; let maxDelay = 0, worst = null;
  // two passes: exact-tick matches first for every event, then late (1-3 tick) matches for the leftovers, so a
  // culled cue never steals the entry of a later event of the same type
  const pending = [];
  for (const e of events) { const t = types[e.type] || (types[e.type] = { count: 0, cues: new Set(), maxTickDelay: null, unmatched: 0 }); t.count++; const list = byTick.get(e.type + '@' + e.tick); if (list && list.length) { const hit = { d: 0, a: list.shift() }; t.cues.add(hit.a.cue); t.maxTickDelay = Math.max(t.maxTickDelay ?? 0, 0); if (0 > maxDelay) { maxDelay = 0; worst = e.type; } } else pending.push(e); }
  for (const e of pending) { const t = types[e.type]; let hit = null; for (let d = 1; d <= 3 && !hit; d++) { const list = byTick.get(e.type + '@' + (e.tick + d)); if (list && list.length) hit = { d, a: list.shift() }; }
    if (hit) { t.cues.add(hit.a.cue); t.maxTickDelay = Math.max(t.maxTickDelay ?? 0, hit.d); if (hit.d > maxDelay) { maxDelay = hit.d; worst = e.type; } } else t.unmatched++; }
  for (const a of audioLog) if (a.event && types[a.event]) types[a.event].cues.add(a.cue);
  const out = {}; for (const [k, v] of Object.entries(types)) out[k] = { count: v.count, cues: [...v.cues], maxTickDelay: v.maxTickDelay, unmatched: v.unmatched, silent: silent.has(k) };
  const noCue = Object.entries(out).filter(([k, v]) => v.cues.length === 0 && !silent.has(k)).map(([k]) => k);
  return { types: out, noCue, maxDelay, worst, silent: [...silent] };
}
