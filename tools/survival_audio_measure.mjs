#!/usr/bin/env node
// Offline loudness measurement of the survival sound palette (survival/audio/audio.js).
// Starts the static server, drives headless Edge, and renders every cue through the real AudioEngine in an
// OfflineAudioContext (panner, buses, limiter, soft clip). Prints peak dBFS / RMS / duration per cue and asserts:
//   - nothing clips (peak <= -0.5 dBFS post-limiter)
//   - level bands: UI/confirmation cues -12 dBFS peak, gunshot -4, groans at 3 tiles -10, ambient beds -36 dBFS RMS (tolerance +-3 dB)
//   - every voice is garbage-collected after its cue ends; loops stop when told to
//   - every EV type in shared/survival/constants.js is either in audio.cueTable() with a real cue or in SILENT
// usage: node tools/survival_audio_measure.mjs [--port 27992] [--out .evidence/survival/audio] [--only groan,gunshot]
//        [--calibrate] prints the trims that would hit every target; [--apply] also writes them into CUE_TRIM
//        [--live [seconds]] plays the real page (/survival?auto=1&fast=8), drives the player with the keyboard, and checks
//        the live engine: ctx.state, triggerLog vs window.__survival.eventLog per tick, voices returning to 0
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/index.mjs';
import { EV } from '../shared/survival/constants.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const port = +(args.port || 27992);
const outDir = path.resolve(args.out || path.join('.evidence', 'survival', 'audio'));
fs.mkdirSync(outDir, { recursive: true });
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('no Chromium browser found'); process.exit(1); }
const puppeteer = (await import('puppeteer-core')).default;

// ---- cue catalogue: target = post-limiter peak dBFS at the listener (rms for beds); origin in tiles from the player ----
const TOL = 3;
const CUES = [
  { name: 'footstepGrass', target: -16 }, { name: 'footstepAsphalt', target: -16 }, { name: 'footstepConcrete', target: -16 }, { name: 'footstepWood', target: -16 },
  { name: 'footstepSneak', target: -28, trim: 'footstepGrass', check: false }, { name: 'footstepRun', target: -12, trim: 'footstepAsphalt', check: false },
  { name: 'zombieStep', target: -20, origin: [3, 0] }, { name: 'zombieStepChase', target: -16, origin: [3, 0], trim: 'zombieStep', check: false },
  { name: 'swingFists', target: -18 }, { name: 'swingBat', target: -14 }, { name: 'meleeHitFists', target: -10, origin: [1, 0] }, { name: 'meleeHitBat', target: -8, origin: [1, 0] },
  { name: 'zombieDeath', target: -8, origin: [1, 0] }, { name: 'zombieStagger', target: -14, origin: [1, 0] }, { name: 'gunshot', target: -4, tol: 2 }, { name: 'bulletHitWorld', target: -18, origin: [6, 0] }, { name: 'bulletHitFlesh', target: -12, origin: [4, 0] },
  { name: 'reload', target: -14 }, { name: 'reloadDone', target: -14 }, { name: 'noAmmo', target: -16 },
  { name: 'groanIdle', target: -10, origin: [3, 0] }, { name: 'groanChase', target: -7, origin: [3, 0] }, { name: 'zombieAlert', target: -9, origin: [3, 0] }, { name: 'zombieAttack', target: -10, origin: [1, 0] }, { name: 'zombieBash', target: -10, origin: [3, 0] },
  { name: 'barricadeHit', target: -10, origin: [3, 0] }, { name: 'barricadeBroken', target: -6, origin: [3, 0] }, { name: 'doorBreak', target: -6, origin: [3, 0] }, { name: 'windowBreak', target: -8, origin: [3, 0] },
  { name: 'playerHurt', target: -8 }, { name: 'heartbeat', target: -12, loop: true, stopAt: 1.4 }, { name: 'playerDeath', target: -6, seconds: 3 }, { name: 'staminaOut', target: -16 },
  { name: 'pickupMetal', target: -12, ui: true }, { name: 'pickupPaper', target: -12, ui: true }, { name: 'pickupWood', target: -12, ui: true }, { name: 'pickupGlass', target: -12, ui: true }, { name: 'pickupTin', target: -12, ui: true },
  { name: 'containerFridge', target: -14, origin: [1, 0] }, { name: 'containerCabinet', target: -14, origin: [1, 0] }, { name: 'containerShelf', target: -14, origin: [1, 0] }, { name: 'containerLocker', target: -12, origin: [1, 0] }, { name: 'containerWreck', target: -12, origin: [1, 0] },
  { name: 'doorOpen', target: -14, origin: [1, 0] }, { name: 'doorClose', target: -12, origin: [1, 0] }, { name: 'harvestHit', target: -10, origin: [1, 0] }, { name: 'harvestDone', target: -8, origin: [1, 0] }, { name: 'barricadeBuilt', target: -10, origin: [1, 0] },
  { name: 'eat', target: -14 }, { name: 'drink', target: -14 }, { name: 'bandage', target: -14 },
  { name: 'weaponSwitch', target: -18, ui: true }, { name: 'actionDenied', target: -12, ui: true }, { name: 'objectiveStep', target: -12, ui: true }, { name: 'objectiveComplete', target: -10, ui: true },
  { name: 'phaseDusk', target: -10 }, { name: 'phaseNight', target: -8 }, { name: 'phaseDawn', target: -12 }, { name: 'phaseDay', target: -14 }, { name: 'hordeHorn', target: -6, seconds: 3 }, { name: 'tension', target: -18, loop: true, stopAt: 2.5, seconds: 5, rmsWindow: [2.0, 2.6] },
  { name: 'win', target: -8, seconds: 3 }, { name: 'lose', target: -8, seconds: 3 },
  { name: 'ambientDay', rms: -36, loop: true, ambient: true, seconds: 8, rmsWindow: [3.2, 4.4], stopAt: 4.5 }, { name: 'ambientDusk', rms: -36, loop: true, ambient: true, seconds: 8, rmsWindow: [3.2, 4.4], stopAt: 4.5 }, { name: 'ambientNight', rms: -36, loop: true, ambient: true, seconds: 8, rmsWindow: [3.2, 4.4], stopAt: 4.5 },
];
// distance model check: the same groan at 3 / 10 / 20 tiles (inverse rolloff: -10.5 dB at 10, -16.5 dB at 20 vs 3)
const DIST_CHECK = { name: 'groanIdle', dists: [3, 10, 20], minAt20: -30 };

const server = await createServer({ port, map: 'arena_duel', mode: 'duel', bots: 0, quiet: true });
const browser = await puppeteer.launch({ executablePath: EDGE, headless: !args.headed, protocolTimeout: 600000, args: ['--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required', '--window-size=1400,900', '--no-sandbox'] });
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test((m.location() || {}).url || '')) consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
const finish = async (code) => { await browser.close().catch(() => {}); await server.close().catch(() => {}); process.exit(code); };
const live = args.live ? +(args.live === true ? 12 : args.live) : 0;
if (live) { await liveRun(); await finish(process.exitCode || 0); }

await page.goto(`http://localhost:${port}/survival`, { waitUntil: 'load' });
await page.evaluate(() => {
  window.__render = async (spec) => {
    const mod = await import('/survival/audio/audio.js');
    const sr = 48000, seconds = spec.seconds || 2.5;
    const ctx = new OfflineAudioContext(2, Math.ceil(sr * seconds), sr);
    const eng = new mod.AudioEngine({ context: ctx, ambient: !!spec.ambient, limiter: spec.limiter !== false, seed: 7 });
    eng.init(); eng.setVolume(1); eng.setCameraYaw(spec.cameraYaw || 0);   // renderer yaw: screen-up = (-cos yaw, -sin yaw) in sim x/y
    const sim = { player: { x: 0, y: 0, facing: 0 }, phase: spec.phase || 'day', zombies: [], result: null };
    // Chrome's DynamicsCompressor starts with its gain ramped down for ~0.2 s: trigger at T0 so cues measure like a running context.
    const T0 = spec.t0 ?? 0.25; const checks = {};
    const Q = 128; const sched = new Map(); const at = (t, fn) => { const k = Math.floor(t * sr / Q); if (!sched.has(k)) sched.set(k, []); sched.get(k).push(fn); };
    at(T0, () => { for (const c of spec.cues || []) eng.cue(c.name, { origin: c.origin, gait: c.gait, health: c.health }); });
    for (const fr of spec.frames || []) at(T0 + (fr.at || 0), () => { if (fr.result !== undefined) sim.result = fr.result; for (const e of fr.events || []) eng.event(e, sim); eng.update(sim, 0); });   // fr.result mirrors sim.result ('won' / 'lost') as the real sim sets it with WIN / LOSE
    // a 60 fps update() clock like the client's (keeps heartbeat / ambient events scheduled ahead, collects voices)
    for (let t = 0.05; T0 + t < seconds - 0.1; t += 1 / 60) at(T0 + t, () => eng.update(sim, 1 / 60));
    if (spec.stopAt) at(T0 + spec.stopAt, () => { for (const k of [...eng.loops.keys()]) eng.stopLoop(k); checks.loopsAfterStop = eng.loops.size; });
    at(spec.checkAt || seconds - 0.05, () => { checks.beforeGc = eng.stats(); eng.update(sim, 0); checks.afterGc = eng.stats(); });
    for (const [k, fns] of sched) ctx.suspend((k * Q + 1) / sr).then(() => { for (const f of fns) f(); ctx.resume(); });
    const buf = await ctx.startRendering();
    const L = buf.getChannelData(0), R = buf.getChannelData(1); const n = L.length; const thr = Math.pow(10, -60 / 20);
    let peakL = 0, peakR = 0, first = -1, last = -1;
    // spec.window [a, b] (s after T0) restricts peak / extent / centroid analysis to that stretch (e.g. after a fanfare)
    const i0 = spec.window ? Math.max(0, Math.floor((T0 + spec.window[0]) * sr)) : 0, i1 = spec.window ? Math.min(n, Math.floor((T0 + spec.window[1]) * sr)) : n;
    for (let i = i0; i < i1; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > peakL) peakL = a; if (b > peakR) peakR = b; if (a > thr || b > thr) { if (first < 0) first = i; last = i; } }
    const w0 = spec.rmsWindow ? Math.floor(spec.rmsWindow[0] * sr) : Math.max(0, first), w1 = spec.rmsWindow ? Math.floor(spec.rmsWindow[1] * sr) : last + 1;
    let sq = 0; for (let i = w0; i < w1; i++) sq += (L[i] * L[i] + R[i] * R[i]) / 2;
    const rms = w1 > w0 ? Math.sqrt(sq / (w1 - w0)) : 0;
    const dB = (x) => x > 0 ? +(20 * Math.log10(x)).toFixed(2) : -120;
    // spectral centroid of the mono mix over the cue extent (for the confirmation-vs-alarm ordering check)
    let cen = null; if (first >= 0) { const N = 4096; const i0 = first; const acc = new Float64Array(N / 2); let frames = 0; for (let s = i0; s + N <= Math.min(n, last + 1) + N && s < last; s += N / 2) { const re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < N; i++) { const j = s + i; re[i] = j < n ? (L[j] + R[j]) / 2 * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)) : 0; } fftInPlace(re, im); for (let k = 0; k < N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k]; frames++; } let num = 0, den = 0; for (let k = 1; k < N / 2; k++) { num += k * sr / N * acc[k]; den += acc[k]; } cen = den > 0 ? Math.round(num / den) : null; }
    let wav = null; if (spec.wav) { const dec = 2; wav = new Array(Math.floor(n / dec)); for (let i = 0; i < wav.length; i++) wav[i] = Math.max(-32768, Math.min(32767, Math.round((L[i * dec] + R[i * dec]) / 2 * 32767))); }
    return { peak: dB(Math.max(peakL, peakR)), peakL: dB(peakL), peakR: dB(peakR), rms: dB(rms), duration: first < 0 ? 0 : +((last - first + 1) / sr).toFixed(3), start: first < 0 ? null : +(first / sr - T0).toFixed(3), centroid: cen, checks, final: eng.stats(), trims: mod.CUE_TRIM, triggerLog: eng.triggerLog, wav, sr: sr / 2 };
  };
  window.fftInPlace = (re, im) => { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } } for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2; const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr; } } } };
  window.__cueTable = async () => { const mod = await import('/survival/audio/audio.js'); const e = new mod.AudioEngine({ seed: 1 }); return { table: e.cueTable(), silent: [...mod.SILENT], cues: Object.keys(e.cues) }; };
});
const render = (spec) => page.evaluate((s) => window.__render(s), spec);
const only = args.only ? new RegExp(String(args.only).split(',').join('|')) : null;
const failures = [];
const fail = (m) => { failures.push(m); console.log('  FAIL ' + m); };

// ---- 1. mapping completeness ----
const map = await page.evaluate(() => window.__cueTable());
for (const type of Object.values(EV)) {
  const m = map.table[type];
  if (m === undefined) fail(`EV.${type} missing from cueTable()`);
  else if (m === 'SILENT') { if (!map.silent.includes(type)) fail(`EV.${type} marked SILENT in cueTable but not in SILENT set`); }
  else for (const c of [].concat(m)) if (!map.cues.includes(c)) fail(`EV.${type} -> unknown cue ${c}`);
}
console.log(`cue table: ${Object.values(EV).length} event types, ${map.cues.length} cues, silent: ${map.silent.join(', ')}`);

// ---- 2. per-cue renders ----
const rows = []; let trims = null; const suggested = {};
for (const c of CUES) {
  if (only && !only.test(c.name)) continue;
  const r = await render({ cues: [{ name: c.name, origin: c.origin }], seconds: c.seconds, ambient: c.ambient, stopAt: c.stopAt, rmsWindow: c.rmsWindow, wav: !args['no-wav'] });
  trims = r.trims;
  const row = { cue: c.name, origin: c.origin || 'own', peak: r.peak, rms: r.rms, duration: r.duration, start: r.start, centroid: r.centroid, voicesAfterGc: r.checks.afterGc.voices, loopsAfterGc: r.checks.afterGc.loops, loopsAfterStop: r.checks.loopsAfterStop, created: r.final.created, killed: r.final.killed };
  rows.push(row);
  const trimKey = c.trim || c.name; const measured = c.rms !== undefined ? r.rms : r.peak; const target = c.rms !== undefined ? c.rms : c.target;
  const delta = measured - target; const ok = Math.abs(delta) <= (c.tol ?? TOL);
  if (c.check !== false) suggested[trimKey] = +(trims[trimKey] * Math.pow(10, -delta / 20)).toFixed(3);
  console.log(`${c.name.padEnd(18)} ${String(row.origin).padEnd(8)} peak ${String(r.peak).padStart(7)}  rms ${String(r.rms).padStart(7)}  dur ${String(r.duration).padStart(6)}s  start ${String(r.start).padStart(6)}s  centroid ${String(r.centroid).padStart(5)} Hz  target ${c.rms !== undefined ? 'rms' : 'peak'} ${target}  ${ok ? 'ok' : 'OFF ' + delta.toFixed(1)}  voices@end ${row.voicesAfterGc} loops ${row.loopsAfterGc}`);
  if (r.peak > -0.5) fail(`${c.name} clips: peak ${r.peak} dBFS`);
  if (!args.calibrate && c.check !== false && !ok) fail(`${c.name} level ${measured} dBFS off target ${target} by ${delta.toFixed(1)} dB`);
  if (r.duration === 0) fail(`${c.name} is silent`);
  if (!c.ambient && r.start !== null && r.start > 0.03) fail(`${c.name} starts ${r.start} s after the trigger (must be scheduled at ctx.currentTime)`);
  if (row.voicesAfterGc !== 0) fail(`${c.name} leaves ${row.voicesAfterGc} voice(s) after gc`);
  if (c.loop && row.loopsAfterStop !== 0) fail(`${c.name} loop still registered after stop`);
  if (r.wav && !args['no-wav']) writeWav(path.join(outDir, `${c.name}.wav`), r.wav, r.sr);
}
if (!only) {
  // distance model: the same groan at 3 / 10 / 20 tiles
  const d = {}; for (const dist of DIST_CHECK.dists) d[dist] = (await render({ cues: [{ name: DIST_CHECK.name, origin: [dist, 0] }] })).peak;
  console.log(`distance ${DIST_CHECK.name}: ` + DIST_CHECK.dists.map((x) => `${x} tiles ${d[x]} dBFS`).join(', '));
  if (!(d[3] > d[10] && d[10] > d[20])) fail('distance attenuation not monotonic');
  if (d[20] < DIST_CHECK.minAt20) fail(`groan at 20 tiles ${d[20]} dBFS < ${DIST_CHECK.minAt20}`);
  // panning in screen terms. cameraYaw 0: screen-up = -x, screen-right = -y, so [0, 3] is screen-left and [0, -3] screen-right
  // (90 deg azimuth): the near ear leads by >= 3 dB and the far ear stays within 12 dB (softened equal-power pan, no dead ear).
  const pan = await render({ cues: [{ name: 'groanIdle', origin: [0, 3] }] }); const panR = await render({ cues: [{ name: 'groanIdle', origin: [0, -3] }] });
  console.log(`panning (yaw 0): screen-left groan L/R ${pan.peakL}/${pan.peakR}, screen-right groan L/R ${panR.peakL}/${panR.peakR}`);
  if (!(pan.peakL > pan.peakR + 3 && panR.peakR > panR.peakL + 3)) fail('groans are not panned by side');
  if (pan.peakR < pan.peakL - 12 || panR.peakL < panR.peakR - 12) fail(`far ear more than 12 dB under the near ear (L/R ${pan.peakL}/${pan.peakR}, ${panR.peakL}/${panR.peakR})`);
  // the game camera: yaw PI/4 -> screen-up = (-0.707, -0.707); a groan straight up the screen is centred, screen-left is left-heavy
  const yaw = Math.PI / 4; const up = await render({ cues: [{ name: 'groanIdle', origin: [-2.12, -2.12] }], cameraYaw: yaw }); const left = await render({ cues: [{ name: 'groanIdle', origin: [-2.12, 2.12] }], cameraYaw: yaw });
  console.log(`panning (yaw PI/4): screen-up groan L/R ${up.peakL}/${up.peakR}, screen-left groan L/R ${left.peakL}/${left.peakR}`);
  if (Math.abs(up.peakL - up.peakR) > 1) fail(`screen-up groan not centred at camera yaw PI/4 (L/R ${up.peakL}/${up.peakR})`);
  if (!(left.peakL > left.peakR + 3)) fail(`screen-left groan not left-heavy at camera yaw PI/4 (L/R ${left.peakL}/${left.peakR})`);
  // WIN/LOSE duck: a chase groan 2.2 s after WIN (fanfare over) sits >= 12 dB under the same groan in a live match; tension + heartbeat loops stop
  const groanRef = await render({ frames: [{ at: 2.2, events: [{ type: EV.ZOMBIE_GROAN, state: 'chase', tick: 60, t: 2, x: 3, y: 0 }] }], seconds: 4, window: [2.2, 3.5] });
  const groanWin = await render({ frames: [{ at: 0, events: [{ type: EV.LOW_HEALTH, on: true, tick: 1, t: 0 }, { type: EV.HORDE, tick: 1, t: 0, x: 0, y: 0, wave: 0, count: 6 }] }, { at: 0.5, result: 'won', events: [{ type: EV.WIN, tick: 15, t: 0.5, x: 0, y: 0 }] }, { at: 2.2, events: [{ type: EV.ZOMBIE_GROAN, state: 'chase', tick: 60, t: 2, x: 3, y: 0 }] }], seconds: 4, window: [2.2, 3.5] });
  console.log(`duck after WIN: groanChase ${groanRef.peak} -> ${groanWin.peak} dBFS (${(groanWin.peak - groanRef.peak).toFixed(1)} dB), loops after WIN ${JSON.stringify(groanWin.checks.afterGc.loopNames)}, ducked ${groanWin.checks.afterGc.ducked}`);
  if (!(groanWin.peak <= groanRef.peak - 12)) fail(`world/zombie buses not ducked after WIN (${groanRef.peak} -> ${groanWin.peak} dBFS)`);
  if (groanWin.checks.afterGc.loops !== 0) fail('tension / heartbeat loops still running after WIN');
  // concrete vs asphalt steps must be distinguishable blind: centroid >= 400 Hz apart, duration >= 20 ms apart
  const fc = rows.find((r) => r.cue === 'footstepConcrete'), fa = rows.find((r) => r.cue === 'footstepAsphalt');
  if (fc && fa) { console.log(`footsteps: concrete centroid ${fc.centroid} Hz / ${fc.duration} s vs asphalt ${fa.centroid} Hz / ${fa.duration} s`); if (!(fc.centroid - fa.centroid >= 400)) fail(`concrete not >= 400 Hz brighter than asphalt (${fc.centroid} vs ${fa.centroid})`); if (!(Math.abs(fc.duration - fa.duration) >= 0.02)) fail(`concrete / asphalt durations too alike (${fc.duration} vs ${fa.duration})`); }
  // tension escalation: a second HORDE wave at 2.5 s re-opens the bed's filter (+150 Hz over 2 s): centroid over 5-6 s rises vs a single wave
  const hordeEv = (t, wave) => ({ type: EV.HORDE, tick: Math.round(t * 30), t, x: 0, y: 0, wave, count: 5 });
  const wave1 = await render({ frames: [{ at: 0, events: [hordeEv(0, 0)] }], seconds: 6.5, window: [5, 6], checkAt: 6.4 });
  const wave2 = await render({ frames: [{ at: 0, events: [hordeEv(0, 0)] }, { at: 2.5, events: [hordeEv(2.5, 1)] }], seconds: 6.5, window: [5, 6], checkAt: 6.4 });
  console.log(`tension escalation: 1 wave centroid ${wave1.centroid} Hz (cutoff ${wave1.checks.afterGc.tensionHz} Hz) vs 2 waves ${wave2.centroid} Hz (cutoff ${wave2.checks.afterGc.tensionHz} Hz, hordeWave ${wave2.checks.afterGc.hordeWave})`);
  if (!(wave2.checks.afterGc.tensionHz >= wave1.checks.afterGc.tensionHz + 100)) fail(`tension cutoff did not re-open on wave 2 (${wave1.checks.afterGc.tensionHz} -> ${wave2.checks.afterGc.tensionHz} Hz)`);
  if (!(wave2.centroid >= wave1.centroid + 20)) fail(`tension bed not audibly brighter on wave 2 (centroid ${wave1.centroid} -> ${wave2.centroid} Hz)`);
  // heartbeat stops on LOW_HEALTH off and on death; tension stops when the last horde zombie dies
  const hb = await render({ frames: [{ at: 0, events: [{ type: EV.LOW_HEALTH, on: true, tick: 1, t: 0 }] }, { at: 1.0, events: [{ type: EV.LOW_HEALTH, on: false, tick: 30, t: 1 }] }], seconds: 2.5 });
  const hbDeath = await render({ frames: [{ at: 0, events: [{ type: EV.LOW_HEALTH, on: true, tick: 1, t: 0 }] }, { at: 1.0, events: [{ type: EV.PLAYER_DEATH, tick: 30, t: 1, x: 0, y: 0 }] }], seconds: 3.5 });
  console.log(`heartbeat: loops after off ${hb.checks.afterGc.loops}, after death ${hbDeath.checks.afterGc.loops}; trigger log ${JSON.stringify(hb.triggerLog.map((x) => x.cue))}`);
  if (hb.checks.afterGc.loops !== 0 || hbDeath.checks.afterGc.loops !== 0) fail('heartbeat loop not stopped');
  // stress mix: gunshot + groan + hurt + door break + horn at once must not clip
  const stress = await render({ cues: [{ name: 'gunshot' }, { name: 'groanChase', origin: [1, 0] }, { name: 'playerHurt' }, { name: 'doorBreak', origin: [1, 0] }, { name: 'hordeHorn' }, { name: 'windowBreak', origin: [1, 1] }], seconds: 3 });
  console.log(`stress mix peak ${stress.peak} dBFS`); if (stress.peak > -0.5) fail(`stress mix clips: ${stress.peak}`);
  // confirmation (short, high) vs denial (low buzz) vs danger (low, long): spectral centroid ordering
  const g = (n) => rows.find((r) => r.cue === n);
  if (g('objectiveStep') && g('actionDenied') && g('groanIdle')) { console.log(`centroids: objectiveStep ${g('objectiveStep').centroid} Hz > actionDenied ${g('actionDenied').centroid} Hz; groanIdle ${g('groanIdle').centroid} Hz, durations ${g('objectiveStep').duration}/${g('actionDenied').duration}/${g('groanIdle').duration}`); if (!(g('objectiveStep').centroid > g('actionDenied').centroid)) fail('confirmation chime not brighter than denial buzz'); if (!(g('groanIdle').duration > g('objectiveStep').duration)) fail('danger cue not longer than confirmation'); }
  // hammer x3 spacing: onsets 100 ms apart on the audio clock
  const hm = await render({ cues: [{ name: 'barricadeBuilt', origin: [1, 0] }], wav: true }); const onsets = findOnsets(hm.wav, hm.sr, 3);
  console.log(`barricadeBuilt hammer onsets: ${onsets.map((x) => x.toFixed(3)).join(', ')} s`);
  if (onsets.length < 3 || Math.abs((onsets[1] - onsets[0]) - 0.1) > 0.02 || Math.abs((onsets[2] - onsets[1]) - 0.1) > 0.02) fail('hammer hits not 100 ms apart');
}
if (args.calibrate) {
  console.log('\nsuggested CUE_TRIM: ' + JSON.stringify(suggested));
  if (args.apply) { const f = path.resolve('survival/audio/audio.js'); let s = fs.readFileSync(f, 'utf8'); const i0 = s.indexOf('export const CUE_TRIM'), i1 = s.indexOf('};', i0); let block = s.slice(i0, i1); for (const [k, v] of Object.entries(suggested)) block = block.replace(new RegExp(`(\\b${k}: )[0-9.]+`), `$1${v}`); s = s.slice(0, i0) + block + s.slice(i1); fs.writeFileSync(f, s); console.log('applied to survival/audio/audio.js'); }
}
fs.writeFileSync(path.join(outDir, 'measure.json'), JSON.stringify({ date: new Date().toISOString(), rows, failures, consoleErrors, trims }, null, 1));
if (consoleErrors.length) { console.log('console errors:', consoleErrors); failures.push('console errors'); }
console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nall audio rules pass');
await finish(failures.length ? 1 : 0);

function findOnsets(wav, sr, n) { // peaks of the short-window energy envelope, 60 ms refractory, threshold relative to the max
  const W = Math.round(sr * 0.004); const env = []; for (let i = 0; i + W < wav.length; i += W) { let m = 0; for (let j = i; j < i + W; j++) m = Math.max(m, Math.abs(wav[j])); env.push(m); }
  const max = Math.max(...env); const out = []; let lastT = -1;
  for (let i = 1; i < env.length; i++) { const t = i * W / sr; if (env[i] > max * 0.35 && env[i] > env[i - 1] * 1.8 && t - lastT > 0.06) { out.push(t); lastT = t; if (out.length >= n) break; } }
  return out;
}
function writeWav(file, samples, sr) {
  const n = samples.length; const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  fs.writeFileSync(file, buf);
}

// ---- live run: the real page, keyboard-driven, engine sampled every 250 ms ----
async function liveRun() {
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(`http://localhost:${port}/survival?auto=1&fast=8&seed=${args.seed || 7}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__survival && window.__survival.sim && window.__survival.audio.ctx, { timeout: 20000 });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(500);
  await page.mouse.click(640, 360);                          // user gesture: resumes the context if the autoplay policy suspended it
  const samples = []; const t0 = Date.now();
  const sample = async (label) => { const s = await page.evaluate(() => { const a = window.__survival.audio; const st = a.stats(); return { ...st, ctxTime: +a.ctx.currentTime.toFixed(2), log: a.triggerLog.length, events: window.__survival.eventLog.length, tick: window.__survival.sim.tick, phase: window.__survival.sim.phase, ambient: a.ambientState }; }); s.label = label; s.t = +((Date.now() - t0) / 1000).toFixed(2); samples.push(s); return s; };
  await sample('start');
  // walk (W 1 s), interact (E), attack (click), sprint burst, weapon slot 2 (denied: no bat), eat (F), then wait in silence
  await page.keyboard.down('KeyW'); await sleep(1000); await page.keyboard.up('KeyW'); await sample('walked');
  await page.keyboard.down('KeyE'); await sleep(120); await page.keyboard.up('KeyE'); await sleep(150); await page.mouse.down(); await sleep(120); await page.mouse.up(); await sleep(400);
  await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyD'); await sleep(800); await page.keyboard.up('KeyD'); await page.keyboard.up('ShiftLeft');
  for (const k of ['Digit2', 'KeyF', 'KeyB']) { await page.keyboard.down(k); await sleep(120); await page.keyboard.up(k); await sleep(80); } await sample('acted');
  const until = t0 + live * 1000; while (Date.now() < until) { await sleep(250); await sample('idle'); }
  // cross-check: every event in eventLog has a triggerLog entry of the same tick, or is in the SILENT set / far dropped
  const x = await page.evaluate(() => {
    const a = window.__survival.audio; const ev = window.__survival.eventLog; const silent = a.cueTable(); const p = window.__survival.sim.player;
    const byTick = new Map(); for (const l of a.triggerLog) { if (!byTick.has(l.tick)) byTick.set(l.tick, []); byTick.get(l.tick).push(l); }
    const missing = [], types = {}; let checked = 0, far = 0;
    for (const e of ev) { types[e.type] = (types[e.type] || 0) + 1; if (silent[e.type] === 'SILENT') continue; checked++; const hits = (byTick.get(e.tick) || []).filter((l) => l.event === e.type); if (!hits.length) { const d = e.x !== undefined && e.who !== 'player' ? Math.hypot(e.x - p.x, e.y - p.y) : 0; if (d > 30) far++; else missing.push({ type: e.type, tick: e.tick, who: e.who }); } }
    const delays = a.triggerLog.map((l) => { const e = ev.find((q) => q.tick === l.tick && q.type === l.event); return e ? l.wall - e.wall : null; }).filter((d) => d !== null);
    return { events: ev.length, checked, missing: missing.slice(0, 20), missingCount: missing.length, farDropped: far, types, cues: a.triggerLog.reduce((m, l) => { m[l.cue] = (m[l.cue] || 0) + 1; return m; }, {}), maxDelayMs: delays.length ? Math.max(...delays) : null, logLen: a.triggerLog.length, ctxState: a.ctx.state, stats: a.stats() };
  });
  const minActive = Math.min(...samples.slice(3).map((s) => s.voices - s.loops));
  console.log('live samples:'); for (const s of samples) console.log(`  ${String(s.t).padStart(6)}s ${s.label.padEnd(7)} tick ${String(s.tick).padStart(5)} ${s.phase.padEnd(5)} ctx ${s.state} ${s.ctxTime}s voices ${s.voices} loops ${s.loops} [${s.loopNames}] created ${s.created} killed ${s.killed} log ${s.log} events ${s.events}`);
  console.log('event types seen:', JSON.stringify(x.types)); console.log('cues voiced:', JSON.stringify(x.cues));
  console.log(`checked ${x.checked}/${x.events} events: missing cue ${x.missingCount} (far dropped ${x.farDropped}), max event->schedule delay ${x.maxDelayMs} ms, triggerLog ${x.logLen}, ctx ${x.ctxState}, min active (non-loop) voices while idle ${minActive}`);
  if (x.missingCount) console.log('missing:', JSON.stringify(x.missing));
  const fails = [];
  if (x.ctxState !== 'running') fails.push('ctx not running: ' + x.ctxState);
  if (x.logLen === 0) fails.push('triggerLog empty');
  if (x.missingCount) fails.push(`${x.missingCount} event(s) without a cue in the same tick`);
  if (minActive !== 0) fails.push(`voices never returned to 0 (min active ${minActive})`);
  if (!(x.types.footstep > 0)) fails.push('no footsteps: keyboard drive failed');
  if (consoleErrors.length) fails.push('console errors: ' + consoleErrors.join(' | '));
  fs.writeFileSync(path.join(outDir, 'live.json'), JSON.stringify({ date: new Date().toISOString(), samples, ...x, fails, consoleErrors }, null, 1));
  console.log(fails.length ? 'LIVE FAIL: ' + fails.join('; ') : 'live run: all checks pass');
  process.exitCode = fails.length ? 1 : 0;
}
