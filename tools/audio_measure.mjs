#!/usr/bin/env node
// Offline loudness measurement of the synthesized sound palette (client/audio/audio.js).
// Starts the game server (to serve the client modules), drives headless Edge, and for every cue renders an
// OfflineAudioContext with the real AudioEngine (HRTF panner, buses, limiter) at listener distances 0/300/600/1500 units.
// Reports peak dBFS, RMS dBFS and duration per cue as a JSON table (.evidence/audio/measure.json), a palette sheet
// (.evidence/audio/palette.png: waveform + spectrogram per cue), WAVs of every cue, and asserts the competitive mixing rules.
// Exit code is non-zero when a rule is violated.
// Every cue with an own + enemy variant is also rendered with the enemy at 100 and 600 units in six directions (front, back,
// left, right, above, below) and must never be quieter than the own cue in any of them.
// usage: node tools/audio_measure.mjs [--port 27981] [--out .evidence/audio] [--calibrate] [--no-wav] [--headed]
//        [--only rocketFire,rail] (regex filter: render matching cues only, print the table, skip rules) [--limiter off]
//        [--dirs] (with --only: also print the directional variants)
//        --hrtf: measure Chrome's raw HRTF panner response (L/R dB vs a direct connection) per direction and frequency
//        -> .evidence/audio/hrtf.json; the basis of HRTF_COMP in client/audio/audio.js
//        --live [seconds]: instead of offline renders, play a real practice match vs a bot in the browser and sample the live
//        engine (context state, voice/loop counts, events heard, damage coalescing) -> .evidence/audio/live.json; asserts running
//        context, no zombies, one hit tone per tick and at most one pain grunt per 700 ms per player (Q3 P_DamageFeedback).
//        [--mode arena|duel] (live default: arena = full loadout)
// Offline the same pain debounce is asserted through event() + a 120 fps update() clock: 20 PAIN ticks in 1 s -> exactly 2
// grunts, never overlapping, at single-grunt level, while the attacker still gets 20 hit tones (CPMA).
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/index.mjs';
import { EV, WEAPONS } from '../shared/constants.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const port = +(args.port || 27981);
const outDir = path.resolve(args.out || path.join('.evidence', 'audio'));
fs.mkdirSync(outDir, { recursive: true });

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('no Chromium browser found'); process.exit(1); }
const puppeteer = (await import('puppeteer-core')).default;

// ---- cue catalogue: kind decides which variants get rendered; target = post-limiter peak dBFS at the listener (d=0) ----
// dual: own (non-spatial) + enemy at each distance. world: spatial only. ui: non-spatial only. loop: stopped by update() at stopAt.
// Weapon fires target -6.5 post-limiter (mean of own and enemy@0) so the louder enemy variant stays <= -6 dBFS pre-limiter.
const DIST = [0, 300, 600, 1500];
const CUES = [
  { name: 'machinegunFire', kind: 'dual', target: -6.5, maxDur: 0.12 }, { name: 'shotgunFire', kind: 'dual', target: -6.5, maxDur: 0.8 },
  { name: 'rocketFire', kind: 'dual', target: -6.5, maxDur: 0.7 }, { name: 'railFire', kind: 'dual', target: -6.5, maxDur: 1.2 },
  { name: 'plasmaFire', kind: 'dual', target: -6.5, maxDur: 0.15 }, { name: 'gauntletFire', kind: 'dual', target: -6.5, maxDur: 0.3 },
  { name: 'lightningLoop', kind: 'dual', loop: true, target: -6.5, stopAt: 0.6, maxDur: 0.8 },
  { name: 'rocketLoop', kind: 'world', loop: true, target: -14, stopAt: 0.6, maxDur: 0.8, velocity: [900, 0, 0] },
  { name: 'rocketExplode', kind: 'world', target: -3, maxDur: 2.0 }, { name: 'plasmaExplode', kind: 'world', target: -12, maxDur: 0.2 },
  { name: 'bulletImpact', kind: 'world', target: -16, maxDur: 0.1 }, { name: 'railImpact', kind: 'world', target: -10, maxDur: 0.5 },
  { name: 'gauntletImpact', kind: 'world', target: -14, maxDur: 0.2 }, { name: 'lgHit', kind: 'world', target: -14, maxDur: 0.12 },
  { name: 'jump', kind: 'dual', target: -14, maxDur: 0.25 }, { name: 'landSoft', kind: 'dual', target: -16, maxDur: 0.15 }, { name: 'landHard', kind: 'dual', target: -10, maxDur: 0.35 },
  { name: 'footstep', kind: 'dual', target: -14, maxDur: 0.1 },
  { name: 'painLight', kind: 'dual', target: -10, maxDur: 0.3 }, { name: 'painMid', kind: 'dual', target: -9.5, maxDur: 0.4 }, { name: 'painHeavy', kind: 'dual', target: -9, maxDur: 0.5 }, { name: 'painCritical', kind: 'dual', target: -8, maxDur: 0.65 },
  { name: 'death', kind: 'dual', target: -8, maxDur: 1.0 }, { name: 'gib', kind: 'dual', target: -6, maxDur: 0.6 },
  { name: 'pickupHealth', kind: 'dual', target: -12, maxDur: 0.35 }, { name: 'pickupMega', kind: 'dual', target: -10, maxDur: 0.9 }, { name: 'pickupArmor', kind: 'dual', target: -12, maxDur: 0.5 },
  { name: 'pickupWeapon', kind: 'dual', target: -11, maxDur: 0.35 }, { name: 'pickupAmmo', kind: 'dual', target: -14, maxDur: 0.2 },
  { name: 'respawnMajor', kind: 'world', target: -8, maxDur: 1.1, extraDist: [3000] }, { name: 'respawnMinor', kind: 'world', target: -18, maxDur: 0.2, extraDist: [3000] },
  { name: 'jumppad', kind: 'dual', target: -10, maxDur: 0.5 }, { name: 'teleport', kind: 'dual', target: -10, maxDur: 0.7 },
  { name: 'hitTone1', kind: 'ui', target: -12, maxDur: 0.1, trim: 'hitTone' }, { name: 'hitTone2', kind: 'ui', target: -12, maxDur: 0.1, trim: 'hitTone' },
  { name: 'hitTone3', kind: 'ui', target: -12, maxDur: 0.1, trim: 'hitTone' }, { name: 'hitTone4', kind: 'ui', target: -12, maxDur: 0.1, trim: 'hitTone' },
  { name: 'weaponChange', kind: 'ui', target: -20, maxDur: 0.15 }, { name: 'noAmmo', kind: 'ui', target: -18, maxDur: 0.15 },
  { name: 'countdown', kind: 'ui', target: -12, maxDur: 0.2 }, { name: 'fight', kind: 'ui', target: -10, maxDur: 0.6 },
  { name: 'win', kind: 'ui', target: -10, maxDur: 1.6 }, { name: 'lose', kind: 'ui', target: -10, maxDur: 1.2 }, { name: 'alert', kind: 'ui', target: -12, maxDur: 0.4 },
];
const WEAPON_FIRE = ['machinegunFire', 'shotgunFire', 'rocketFire', 'railFire', 'plasmaFire', 'gauntletFire', 'lightningLoop'];
// listener looks down +X with +Z up (angles [0,0,0]): right is -Y (Q3 angleVectors). Directional variants of every dual cue.
const DIRS = { front: [1, 0, 0], back: [-1, 0, 0], left: [0, 1, 0], right: [0, -1, 0], above: [0, 0, 1], below: [0, 0, -1] };
const DIR_DIST = [100, 600];
const REF_DIST = 320, distanceDb = (d) => d <= REF_DIST ? 0 : 20 * Math.log10(REF_DIST / d); // inverse model, rolloff 1: -5.46 dB at 600

const live = args.live ? +(args.live === true ? 20 : args.live) : 0;
// live runs default to arena mode: players spawn with the full arsenal, so every weapon (and the shotgun's multi-pellet hits) is exercised
const server = await createServer({ port, map: 'arena_duel', mode: args.mode || (live ? 'arena' : 'duel'), bots: live ? 1 : 0, quiet: true, botSkill: live ? 0.4 : 0.6 });
// protocolTimeout: an offline render normally takes < 1 s but a loaded machine (several browsers rendering at once) can stall
// one for minutes; the default 180 s would abort the whole run
const browser = await puppeteer.launch({ executablePath: EDGE, headless: !args.headed, protocolTimeout: 600000, args: ['--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required', '--window-size=1400,900', '--no-sandbox'] });
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test((m.location() || {}).url || '')) consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
if (live) { await liveRun(); process.exit(process.exitCode || 0); }
await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
if (args.hrtf) { await hrtfRun(); process.exit(process.exitCode || 0); }

// In-page renderer: one OfflineAudioContext per spec, real engine, analysis done in the page to keep transfers small.
await page.evaluate(() => {
  // in-place radix-2 FFT (re/im Float64Array, length a power of two)
  const fft = (re, im) => { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } } for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2; const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr; } } } };
  window.__render = async (spec) => {
    const mod = await import('/client/audio/audio.js');
    const sr = 48000, seconds = spec.seconds || 2.5;
    const ctx = new OfflineAudioContext(2, Math.ceil(sr * seconds), sr);
    const eng = new mod.AudioEngine({ context: ctx, ambient: !!spec.ambient, limiter: spec.limiter !== false, seed: 7 });
    eng.init(); eng.setVolume(1); eng.updateListener([0, 0, 0], [0, 0, 0]);
    const cg = { localId: 1, remote: new Map(spec.remote || []), game: null, remoteProjectiles: [] };
    if (spec.probe) { const o = ctx.createOscillator(); o.frequency.value = 1000; const g = ctx.createGain(); g.gain.value = spec.probe; o.connect(g); g.connect(eng.master); o.start(0); o.stop(1.2); }
    // Chrome's DynamicsCompressor starts a fresh context with its gain ramped down (~12 dB loss on a burst at t=0, settled by
    // ~0.2 s): trigger the cues at T0 so they are measured the way a live, long-running context plays them.
    const T0 = spec.t0 ?? 0.25;
    const checks = {};
    // an OfflineAudioContext accepts one suspend per render quantum (128 samples): actions are keyed by quantum index and the
    // suspend is placed one sample into that quantum, so two keys can never quantize to the same suspend time
    const Q = 128; const sched = new Map(); const at = (t, fn) => { const k = Math.floor(t * sr / Q); if (!sched.has(k)) sched.set(k, []); sched.get(k).push(fn); };
    at(T0, () => { for (const c of spec.cues || []) eng.cue(c.name, { origin: c.origin, local: c.local, id: c.id, velocity: c.velocity }); });
    // event frames: raw game events fed through eng.event() at T0 + at, followed by the per-frame eng.update() (which flushes the
    // coalesced damage cues) - this is exactly the client's onEvent()/update() sequence for one rendered frame.
    for (const fr of spec.frames || []) at(T0 + (fr.at || 0), () => { if (fr.remote) cg.remote = new Map(fr.remote); for (const e of fr.events || []) eng.event(e, cg, false); eng.update(cg, 0); checks.createdAfterFrames = eng.counters.created; });
    // pain / hit-tone audit: every grunt and tone voiced is logged (time, health, player), and with spec.fps the engine's update()
    // runs on a frame clock like the client's, sampling how many grunts are alive at once and the peak live voice count
    const painCalls = [], toneCalls = [], painVoices = []; let maxPainAlive = 0, maxVoices = 0;
    const pain0 = eng.pain.bind(eng); eng.pain = (o, l, h, id) => { const v = pain0(o, l, h, id); painCalls.push({ t: +(ctx.currentTime - T0).toFixed(3), health: h, local: !!l, id }); painVoices.push(v); return v; };
    const tone0 = eng.hitTone.bind(eng); eng.hitTone = (d) => { toneCalls.push({ t: +(ctx.currentTime - T0).toFixed(3), damage: d }); return tone0(d); };
    if (spec.fps) for (let t = 0; T0 + t < seconds - 0.1; t += 1 / spec.fps) at(T0 + t, () => { eng.update(cg, 0); maxPainAlive = Math.max(maxPainAlive, painVoices.filter((v) => !v.dead).length); maxVoices = Math.max(maxVoices, eng.voices.size); });
    if (spec.stopAt) at(T0 + spec.stopAt, () => eng.update(cg, 0));
    at(spec.checkAt || seconds - 0.05, () => { checks.beforeGc = eng.stats(); eng.update(cg, 0); checks.afterGc = eng.stats(); });
    for (const [k, fns] of sched) ctx.suspend((k * Q + 1) / sr).then(() => { for (const f of fns) f(); ctx.resume(); });
    const buf = await ctx.startRendering();
    const L = buf.getChannelData(0), R = buf.getChannelData(1); const n = L.length;
    const thr = Math.pow(10, -60 / 20);
    let peakL = 0, peakR = 0, first = -1, last = -1;
    for (let i = 0; i < n; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > peakL) peakL = a; if (b > peakR) peakR = b; if (a > thr || b > thr) { if (first < 0) first = i; last = i; } }
    const w0 = spec.rmsWindow ? Math.floor(spec.rmsWindow[0] * sr) : Math.max(0, first), w1 = spec.rmsWindow ? Math.floor(spec.rmsWindow[1] * sr) : last + 1;
    let sq = 0; for (let i = w0; i < w1; i++) sq += (L[i] * L[i] + R[i] * R[i]) / 2;
    const rms = w1 > w0 ? Math.sqrt(sq / (w1 - w0)) : 0;
    const dB = (x) => x > 0 ? +(20 * Math.log10(x)).toFixed(2) : -120;
    // envelope (max abs per bucket) + spectrogram (Goertzel on log-spaced bands) for the palette sheet
    const env = []; const EB = 160; for (let b = 0; b < EB; b++) { let m = 0; const i0 = Math.floor(b * n / EB), i1 = Math.floor((b + 1) * n / EB); for (let i = i0; i < i1; i++) { const a = Math.abs(L[i] + R[i]) / 2; if (a > m) m = a; } env.push(+m.toFixed(4)); }
    const FR = 80, NB = 40, WIN = 1024; const bands = []; for (let b = 0; b < NB; b++) bands.push(60 * Math.pow(12000 / 60, b / (NB - 1)));
    const spec2 = []; const span = Math.min(n, Math.floor(sr * (spec.specSeconds || 1.6)));
    for (let f = 0; f < FR; f++) { const i0 = Math.floor(f * (span - WIN) / FR); const row = []; for (const fq of bands) { const k = 2 * Math.cos(2 * Math.PI * fq / sr); let s0 = 0, s1 = 0, s2 = 0; for (let i = 0; i < WIN; i++) { const x = (L[i0 + i] + R[i0 + i]) / 2 * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / WIN)); s0 = x + k * s1 - s2; s2 = s1; s1 = s0; } const p = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) / (WIN / 4); row.push(Math.max(0, Math.min(1, (20 * Math.log10(p + 1e-9) + 70) / 70))); } spec2.push(row.map((x) => Math.round(x * 255))); }
    // dominant frequency inside a window (Goertzel every 5 Hz, 200 Hz..4 kHz) - used to verify the hit tone tier
    // (bands: level in dB of the hit-tone tier frequencies inside the same window, so a tone can be identified under a louder grunt)
    let peakHz = null; const tierBands = {}; if (spec.spectrumWindow) {
      const i0 = Math.floor(spec.spectrumWindow[0] * sr), N = Math.min(n - i0, Math.floor((spec.spectrumWindow[1] - spec.spectrumWindow[0]) * sr));
      const power = (fq) => { const k = 2 * Math.cos(2 * Math.PI * fq / sr); let s1 = 0, s2 = 0; for (let i = 0; i < N; i++) { const x = (L[i0 + i] + R[i0 + i]) / 2 * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); const s0 = x + k * s1 - s2; s2 = s1; s1 = s0; } return s1 * s1 + s2 * s2 - k * s1 * s2; };
      let best = -1; for (let fq = 200; fq <= 4000; fq += 5) { const p = power(fq); if (p > best) { best = p; peakHz = fq; } }
      for (const fq of [620, 800, 1000, 1300]) tierBands[fq] = +(10 * Math.log10(power(fq) / (N * N / 16) + 1e-12)).toFixed(2);
    }
    let wav = null; if (spec.wav) { const dec = 2; wav = new Array(Math.floor(n / dec)); for (let i = 0; i < wav.length; i++) wav[i] = Math.max(-32768, Math.min(32767, Math.round((L[i * dec] + R[i * dec]) / 2 * 32767))); }
    // Perceived loudness and spectral balance of the mono mix (L+R)/2, FFT per 50 ms Hann window (zero-padded to 4096):
    //   aMom  = A-weighted momentary level: max over windows (hop 10 ms) of the A-weighted RMS, dBFS (full-scale sine = -3.01)
    //   aMean = A-weighted mean level over the -40 dBFS extent of the cue (hop 25 ms), the metric a duration-integrating meter reads
    //   sub300 = fraction of the unweighted energy below 300 Hz over the same extent
    const WN = Math.round(sr * 0.05), NF = 4096, hann = new Float32Array(WN); let wpow = 0; for (let i = 0; i < WN; i++) { hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / WN); wpow += hann[i] * hann[i]; } wpow /= WN;
    const aw = new Float64Array(NF / 2 + 1); for (let k = 0; k <= NF / 2; k++) { const f = k * sr / NF, f2 = f * f; const r = 12194 ** 2 * f2 * f2 / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2)); aw[k] = k === 0 ? 0 : Math.pow(10, (20 * Math.log10(r) + 2.0) / 10); }
    const k300 = Math.ceil(300 * NF / sr);
    const re = new Float64Array(NF), im = new Float64Array(NF);
    const analyze = (i0) => { // -> { ms: mean square (window-power corrected), msA: A-weighted mean square, sub: mean square below 300 Hz }
      re.fill(0); im.fill(0); for (let i = 0; i < WN; i++) { const j = i0 + i; re[i] = j >= 0 && j < n ? (L[j] + R[j]) / 2 * hann[i] : 0; }
      fft(re, im); let ms = 0, msA = 0, sub = 0; for (let k = 0; k <= NF / 2; k++) { const p = (re[k] * re[k] + im[k] * im[k]) * (k === 0 || k === NF / 2 ? 1 : 2); ms += p; msA += p * aw[k]; if (k < k300) sub += p; }
      const norm = 1 / (NF * WN * wpow); return { ms: ms * norm, msA: msA * norm, sub: sub * norm };
    };
    let aMom = 0; const thr40 = Math.pow(10, -40 / 20); let f40 = -1, l40 = -1;
    for (let i = 0; i < n; i++) { const a = Math.abs((L[i] + R[i]) / 2); if (a > thr40) { if (f40 < 0) f40 = i; l40 = i; } }
    if (first >= 0) for (let i0 = Math.max(0, first - WN); i0 <= Math.min(n - 1, last); i0 += Math.round(sr * 0.01)) { const r = analyze(i0); if (r.msA > aMom) aMom = r.msA; }
    // extent mean: windows at hop WN/2 centred over [f40, l40]; each window accounts for hop samples of energy, so the mean is
    // total energy / extent length and a cue shorter than one window is not diluted by the silence after it
    let sumA = 0, sumMs = 0, sumSub = 0; const hop = WN / 2; let nw = 0;
    if (f40 >= 0) for (let i0 = f40 - hop; i0 < l40 - hop + 1; i0 += hop) { const r = analyze(i0); sumA += r.msA; sumMs += r.ms; sumSub += r.sub; nw++; }
    const ext = l40 - f40 + 1, dBp = (p) => p > 0 ? +(10 * Math.log10(p)).toFixed(2) : -120;
    const loud = { aMom: dBp(aMom), aMean: nw ? dBp(sumA * hop / ext) : -120, sub300: nw && sumMs > 0 ? +(sumSub / sumMs).toFixed(3) : 0 };
    return { peak: dB(Math.max(peakL, peakR)), peakL: dB(peakL), peakR: dB(peakR), rms: dB(rms), duration: first < 0 ? 0 : +((last - first + 1) / sr).toFixed(3), start: first < 0 ? null : +(first / sr).toFixed(3), ...loud, env, spec: spec2, checks, peakHz, tierBands, painCalls, toneCalls, maxPainAlive, maxVoices, final: eng.stats(), created: eng.counters.created, spatial: eng.counters.spatial, dropped: eng.counters.dropped, trims: mod.CUE_TRIM, remoteGain: mod.REMOTE_GAIN, hrtfComp: mod.HRTF_COMP, wav, sr: sr / 2 };
  };
});
// one retry: a render that hit the protocol timeout is re-issued in a fresh OfflineAudioContext (renders are deterministic)
const render = async (spec) => { const s = { ...spec, limiter: args.limiter === 'off' ? false : spec.limiter }; try { return await page.evaluate((s) => window.__render(s), s); } catch (e) { console.error('render failed, retrying once:', String(e).split('\n')[0]); return page.evaluate((s) => window.__render(s), s); } };
const only = args.only ? new RegExp(String(args.only).split(',').join('|')) : null;

const rows = []; let trims = null, remoteGain = 1, hrtfComp = null;
const get = (cue, variant, dist) => rows.find((r) => r.cue === cue && r.variant === variant && r.dist === dist);
const get0 = (cue, variant) => get(cue, variant, 0);
const sheet = []; // for the palette png
function origin(d) { return [d || 1, 0, 0]; }
for (const c of CUES) {
  if (only && !only.test(c.name)) continue;
  const base = { stopAt: c.stopAt, seconds: c.loop ? 1.8 : 2.5, rmsWindow: c.loop ? [0.35, 0.75] : undefined };
  const variants = [];
  if (c.kind === 'dual' || c.kind === 'ui') variants.push({ label: 'own', d: 0, cues: [{ name: c.name, local: true, origin: [0, 0, 0], velocity: c.velocity }], wav: true });
  if (c.kind !== 'ui') for (const d of [...DIST, ...(c.extraDist || [])]) variants.push({ label: 'enemy', d, cues: [{ name: c.name, local: false, origin: origin(d), velocity: c.velocity }], wav: c.kind === 'world' && d === 0 });
  // six directions at 100 u (inside the reference distance: pure HRTF response) and 600 u
  if (c.kind === 'dual' && (!only || args.dirs)) for (const d of DIR_DIST) for (const [dn, dv] of Object.entries(DIRS)) variants.push({ label: 'enemy-' + dn, d, cues: [{ name: c.name, local: false, origin: dv.map((x) => x * d), velocity: c.velocity, id: 2 }] });
  for (const v of variants) {
    const r = await render({ ...base, cues: v.cues, wav: !!v.wav && !args['no-wav'] });
    trims = r.trims; remoteGain = r.remoteGain; hrtfComp = r.hrtfComp;
    const row = { cue: c.name, variant: v.label, dist: v.d, peak: r.peak, peakL: r.peakL, peakR: r.peakR, rms: r.rms, aMom: r.aMom, aMean: r.aMean, sub300: r.sub300, duration: r.duration, voicesBeforeGc: r.checks.beforeGc?.voices, voicesAfterGc: r.checks.afterGc?.voices, loopsAfterGc: r.checks.afterGc?.loops, created: r.final.created, killed: r.final.killed };
    // weapon fires: also the pre-limiter peak (own and point blank), the level the limiter threshold is compared against
    if (WEAPON_FIRE.includes(c.name) && v.d === 0) row.peakPre = (await render({ ...base, cues: v.cues, limiter: false })).peak;
    rows.push(row);
    if ((v.label === 'own') || (c.kind === 'world' && v.d === 0)) sheet.push({ name: c.name, env: r.env, spec: r.spec, peak: r.peak, duration: r.duration });
    if (r.wav && !args['no-wav']) writeWav(path.join(outDir, `${c.name}.wav`), r.wav, r.sr);
    process.stdout.write(`${c.name.padEnd(16)} ${v.label.padEnd(12)} ${String(v.d).padStart(5)}u  peak ${String(r.peak).padStart(7)} dBFS${row.peakPre !== undefined ? ` (pre ${String(row.peakPre).padStart(6)})` : ''.padEnd(13)}  L/R ${String(r.peakL).padStart(7)}/${String(r.peakR).padEnd(7)}  rms ${String(r.rms).padStart(7)}  A-mom ${String(r.aMom).padStart(7)}  A-mean ${String(r.aMean).padStart(7)}  <300Hz ${String(Math.round(r.sub300 * 100)).padStart(3)}%  dur ${r.duration}s\n`);
  }
  if (c.kind === 'dual' && (!only || args.dirs)) { // directional summary: enemy - own in dB per direction, 100 u and 600 u (model -5.46 dB)
    const own = get(c.name, 'own', 0).peak;
    process.stdout.write(`${''.padEnd(16)} vs own:  ` + DIR_DIST.map((d) => `${d}u ` + Object.keys(DIRS).map((dn) => `${dn} ${(get(c.name, 'enemy-' + dn, d).peak - own - distanceDb(d)).toFixed(1).padStart(5)}`).join(' ')).join('   |   ') + '\n');
  }
}
if (only) { await browser.close(); await server.close(); process.exit(0); }
// ambient bed alone (RMS over 1..3 s), limiter probe (makeup gain), explosion pre/post limiter, stress mix
const amb = await render({ ambient: true, seconds: 3, rmsWindow: [1, 3], cues: [], specSeconds: 3 });
rows.push({ cue: 'ambient', variant: 'bed', dist: 0, peak: amb.peak, rms: amb.rms, duration: amb.duration });
sheet.push({ name: 'ambient', env: amb.env, spec: amb.spec, peak: amb.peak, duration: amb.duration });
const probe = await render({ probe: 0.1, seconds: 1.2, rmsWindow: [0.5, 1.0] });
const makeup = +(probe.rms - (-20 - 3.01)).toFixed(2); // -20 dBFS sine amplitude has RMS -23.01
const explPre = await render({ limiter: false, cues: [{ name: 'rocketExplode', origin: [1, 0, 0] }] });
const explPost = rows.find((r) => r.cue === 'rocketExplode' && r.dist === 0);
const explGR = +((explPre.peak + makeup) - explPost.peak).toFixed(2);
const stressCues = [{ name: 'rocketExplode', origin: [1, 0, 0] }, { name: 'shotgunFire', local: true, origin: [0, 0, 0] }, { name: 'railFire', origin: [200, 100, 0] }, { name: 'painHeavy', local: true, origin: [0, 0, 0] }, { name: 'hitTone4' }, { name: 'lightningLoop', local: true, origin: [0, 0, 0], id: 1 }, { name: 'rocketFire', origin: [300, -100, 0] }];
const stress = await render({ cues: stressCues, stopAt: 0.6, seconds: 2.5, wav: !args['no-wav'] });
const stressPre = await render({ cues: stressCues, stopAt: 0.6, seconds: 2.5, limiter: false });
if (stress.wav) writeWav(path.join(outDir, 'stress_mix.wav'), stress.wav, stress.sr);
sheet.push({ name: 'stress mix', env: stress.env, spec: stress.spec, peak: stress.peak, duration: stress.duration });
const stressGR = +((stressPre.peak + makeup) - stress.peak).toFixed(2);
console.log(`ambient bed rms ${amb.rms} dBFS | limiter makeup ${makeup} dB | rocket explosion gain reduction ${explGR} dB | stress mix peak ${stress.peak} dBFS (GR ${stressGR} dB)`);

// ---- damage coalescing: one point-blank shotgun blast reaches the client as 11 HIT (attacker) + 11 PAIN (target) events in
// one tick (shared/game.js emits one pair per pellet). Fed through eng.event() + the per-frame eng.update() the engine must
// voice exactly one hitTone(110) (tier 4, 1300 Hz) and one pain grunt, at single-cue level: no stacking, no limiter slam. ----
const HIT = (dmg) => ({ type: EV.HIT, id: 1, target: 2, damage: dmg, origin: [100, 0, 0], weapon: WEAPONS.SHOTGUN });
const PAIN = (dmg, health) => ({ type: EV.PAIN, id: 2, attacker: 1, damage: dmg, health, origin: [100, 0, 0], mod: WEAPONS.SHOTGUN, self: false });
const hits = Array.from({ length: 11 }, () => HIT(10)), pains = Array.from({ length: 11 }, (_, i) => PAIN(10, 190 - i * 10));
const T0 = 0.25, toneWin = [T0, T0 + 0.064];
const coalHit = await render({ frames: [{ at: 0, events: hits }], spectrumWindow: toneWin, wav: !args['no-wav'] });
const coalHitPre = await render({ frames: [{ at: 0, events: hits }], limiter: false });
const coalBoth = await render({ frames: [{ at: 0, events: [...hits, ...pains] }], spectrumWindow: toneWin });
const coalBothPre = await render({ frames: [{ at: 0, events: [...hits, ...pains] }], limiter: false });
const twoFrames = await render({ frames: [{ at: 0, events: hits }, { at: 0.05, events: hits }] });
const stackedPre = await render({ cues: Array.from({ length: 11 }, () => ({ name: 'hitTone1' })), limiter: false }); // what per-event voicing would have produced
const tone4 = rows.find((r) => r.cue === 'hitTone4'), tone1 = rows.find((r) => r.cue === 'hitTone1'), painRef = get0('painLight', 'enemy');
const tone4Pre = await render({ cues: [{ name: 'hitTone4' }], limiter: false, spectrumWindow: toneWin });
if (coalHit.wav && !args['no-wav']) writeWav(path.join(outDir, 'shotgun_hit_coalesced.wav'), coalHit.wav, coalHit.sr);
const coalescing = { hitEvents: 11, painEvents: 11, voicesHitOnly: coalHit.created, voicesHitAndPain: coalBoth.created, voicesTwoFrames: twoFrames.created, toneHz: coalHit.peakHz, toneHzWithPain: coalBoth.peakHz, tone4Hz: tone4Pre.peakHz, tierBandsDb: coalHit.tierBands, tierBandsDbWithPain: coalBoth.tierBands, peakHitOnly: coalHit.peak, peakHitOnlyPre: coalHitPre.peak, peakHitAndPain: coalBoth.peak, peakHitAndPainPre: coalBothPre.peak, stackedPerEventPre: stackedPre.peak, singleTone4: tone4.peak, singleTone4Pre: tone4Pre.peak, singleTone1: tone1.peak };
console.log('damage coalescing:', JSON.stringify(coalescing));

// ---- pain debounce (Q3 P_DamageFeedback: one pain sound per 700 ms per player): 1 s of lightning on one player is 20 damage
// ticks 50 ms apart. Through event() + a 120 fps update() clock the victim must grunt exactly twice (t = 0 and 0.7 s), never two
// grunts at once, at single-grunt level - while the attacker still gets one hit tone per tick (CPMA). ----
const ENEMY = [100, 0, 0], FPS = 120;
const painStream = (id, dmg, health0, n = 20, dt = 0.05, mk = (i) => []) => Array.from({ length: n }, (_, i) => ({ at: i * dt, events: [{ type: EV.PAIN, id, attacker: id === 1 ? 2 : 1, damage: dmg, health: health0 - dmg * (i + 1), origin: id === 1 ? [0, 0, 0] : ENEMY, mod: WEAPONS.LIGHTNING, self: false }, ...mk(i)] }));
const painEnemy = await render({ frames: painStream(2, 8, 200), fps: FPS, wav: !args['no-wav'] });      // 200 hp: every grunt stays tier light
const painEnemyPre = await render({ frames: painStream(2, 8, 200), fps: FPS, limiter: false });
const painLocal = await render({ frames: painStream(1, 8, 200), fps: FPS });
const painEscalate = await render({ frames: painStream(2, 5, 100), fps: FPS });                          // health 95 -> 0: the second grunt must carry the lowest pending health
const painPerEvent = await render({ cues: painStream(2, 8, 200).map(() => ({ name: 'painLight', origin: ENEMY, local: false })), limiter: false }); // 20 grunts stacked at once (per-event voicing, worst case)
const painThenDeath = await render({ frames: [{ at: 0, events: [{ type: EV.PAIN, id: 2, attacker: 1, damage: 100, health: -10, origin: ENEMY, mod: WEAPONS.ROCKET }, { type: EV.DEATH, id: 2, attacker: 1, mod: WEAPONS.ROCKET, origin: ENEMY, gib: false }] }], fps: FPS });
const painAfterRespawn = await render({ frames: [{ at: 0, events: [{ type: EV.PAIN, id: 2, attacker: 1, damage: 8, health: 92, origin: ENEMY, mod: 1 }] }, { at: 0.3, events: [{ type: EV.DEATH, id: 2, attacker: 1, mod: 1, origin: ENEMY, gib: false }] }, { at: 0.5, events: [{ type: EV.RESPAWN, id: 2, origin: ENEMY }, { type: EV.PAIN, id: 2, attacker: 1, damage: 8, health: 92, origin: ENEMY, mod: 1 }] }], fps: FPS });
// the full exchange as the attacker hears it: own LG fire + victim PAIN + own HIT + LG_HIT sizzle, 20 ticks
const lgExchange = await render({ frames: painStream(2, 8, 200, 20, 0.05, (i) => [{ type: EV.FIRE, id: 1, weapon: WEAPONS.LIGHTNING, origin: [0, 0, 0], seq: i }, { type: EV.HIT, id: 1, target: 2, damage: 8, origin: ENEMY, weapon: WEAPONS.LIGHTNING }, { type: EV.LG_HIT, id: 1, origin: ENEMY }]), fps: FPS, stopAt: 1.0, wav: !args['no-wav'] });
// ... and as the victim: enemy LG fire + own PAIN + LG_HIT on us
const lgVictim = await render({ frames: Array.from({ length: 20 }, (_, i) => ({ at: i * 0.05, events: [{ type: EV.FIRE, id: 2, weapon: WEAPONS.LIGHTNING, origin: ENEMY, seq: i }, { type: EV.PAIN, id: 1, attacker: 2, damage: 8, health: 200 - 8 * (i + 1), origin: [0, 0, 0], mod: WEAPONS.LIGHTNING }, { type: EV.LG_HIT, id: 2, origin: [0, 0, 0] }] })), fps: FPS, stopAt: 1.0 });
if (painEnemy.wav && !args['no-wav']) writeWav(path.join(outDir, 'pain_lg_debounced.wav'), painEnemy.wav, painEnemy.sr);
if (lgExchange.wav && !args['no-wav']) writeWav(path.join(outDir, 'lg_exchange.wav'), lgExchange.wav, lgExchange.sr);
const painLightEnemy100 = get('painLight', 'enemy-front', 100), painLightOwn = get('painLight', 'own', 0);
const painRate = {
  events: 20, spacingMs: 50, debounceMs: 700,
  enemy: { voices: painEnemy.created, grunts: painEnemy.painCalls, maxPainAlive: painEnemy.maxPainAlive, maxVoices: painEnemy.maxVoices, peak: painEnemy.peak, peakPre: painEnemyPre.peak, rms: painEnemy.rms, singlePainLight100: painLightEnemy100.peak, singlePainLight0: painRef.peak },
  local: { voices: painLocal.created, grunts: painLocal.painCalls, maxPainAlive: painLocal.maxPainAlive, peak: painLocal.peak, singlePainLight: painLightOwn.peak },
  escalate: { grunts: painEscalate.painCalls },
  perEventStacked: { voices: painPerEvent.created, peakPre: painPerEvent.peak },
  painThenDeath: { voices: painThenDeath.created, grunts: painThenDeath.painCalls.length },
  painAfterRespawn: { grunts: painAfterRespawn.painCalls },
  lgExchange: { voices: lgExchange.created, hitTones: lgExchange.toneCalls.length, grunts: lgExchange.painCalls.length, maxPainAlive: lgExchange.maxPainAlive, maxVoices: lgExchange.maxVoices, peak: lgExchange.peak, rms: lgExchange.rms },
  lgVictim: { voices: lgVictim.created, grunts: lgVictim.painCalls.length, maxPainAlive: lgVictim.maxPainAlive, maxVoices: lgVictim.maxVoices, peak: lgVictim.peak },
};
console.log('pain debounce:', JSON.stringify(painRate));

// ---- origin resolution: a remote FOOTSTEP (no origin in the event) with the player unknown / known / known only from an earlier event ----
const FOOT = { type: EV.FOOTSTEP, id: 2 };
const pick = (r) => ({ created: r.created, spatial: r.spatial, dropped: r.dropped, peak: r.peak });
const originCases = {
  unknown: pick(await render({ frames: [{ at: 0, events: [FOOT] }] })),
  known: pick(await render({ remote: [[2, { origin: [600, 0, 0] }]], frames: [{ at: 0, events: [FOOT] }] })),
  lastKnown: pick(await render({ frames: [{ at: 0, events: [{ type: EV.PAIN, id: 2, attacker: 1, damage: 10, health: 90, origin: [-600, 0, 0], mod: 1 }] }, { at: 0.5, remote: [], events: [FOOT] }] })),
};
console.log('origin resolution:', JSON.stringify(originCases));

// ---- rules ----
const failures = [], checks = [];
const rule = (ok, text) => { checks.push({ ok, text }); if (!ok) failures.push(text); };
rule(coalHit.created === 1, `damage coalescing: 11 HIT(10) in one frame -> ${coalHit.created} voice (expect 1)`);
rule(coalBoth.created === 2, `damage coalescing: 11 HIT(10) + 11 PAIN(10) in one frame -> ${coalBoth.created} voices (expect exactly 2: one tone + one grunt)`);
rule(twoFrames.created === 2, `damage coalescing is per frame: 11 HIT in frame A + 11 HIT in frame B (+50 ms) -> ${twoFrames.created} voices (expect 2)`);
rule(Math.abs(coalHit.peakHz - 1300) <= 65, `coalesced tone tier = hitTone(110): dominant ${coalHit.peakHz} Hz within 5% of 1300 Hz (single hitTone4: ${tone4Pre.peakHz} Hz)`);
// under the (louder) grunt the tone is identified by its partial: 1300 Hz band at the same level as the tone alone, well above the tier-0 620 Hz band
const b1 = coalHit.tierBands, b2 = coalBoth.tierBands;
rule(Math.abs(b2[1300] - b1[1300]) <= 1.5 && b2[1300] >= b2[620] + 6, `coalesced tone under the grunt: 1300 Hz band ${b2[1300]} dB (tone alone ${b1[1300]}, +-1.5) and >= 6 dB over the tier-0 620 Hz band ${b2[620]}`);
rule(coalHitPre.peak <= -8 && coalBothPre.peak <= -8, `coalesced blast pre-limiter peak ${coalHitPre.peak} dBFS (with pain ${coalBothPre.peak}) <= -8 dBFS (per-event stacking would give ${stackedPre.peak})`);
rule(Math.abs(coalHit.peak - tone4.peak) <= 1, `coalesced tone post-limiter peak ${coalHit.peak} dBFS within +-1 dB of single hitTone4 ${tone4.peak}`);
rule(coalBoth.peak >= tone4.peak - 1 && coalBoth.peak <= Math.max(tone4.peak, painRef.peak) + 1, `coalesced tone + grunt post-limiter peak ${coalBoth.peak} dBFS within +-1 dB of the louder single cue (hitTone4 ${tone4.peak}, enemy painLight ${painRef.peak})`);
// pain debounce (Q3 700 ms per player): grunt count, no overlap, single-grunt level, tier escalation, death/respawn handling
const gruntTimes = (r) => r.painCalls.map((p) => p.t).join(', ');
rule(painEnemy.created === 2 && painEnemy.painCalls.length === 2, `pain debounce: 20 x PAIN(8) on enemy id 2 at 50 ms spacing over 1 s -> ${painEnemy.created} voices / ${painEnemy.painCalls.length} grunts at [${gruntTimes(painEnemy)}] s (expect exactly 2)`);
rule(painEnemy.painCalls.length === 2 && Math.abs(painEnemy.painCalls[1].t - painEnemy.painCalls[0].t - 0.7) <= 0.02, `pain debounce: second enemy grunt ${(painEnemy.painCalls[1]?.t - painEnemy.painCalls[0]?.t).toFixed(3)} s after the first (expect 0.70 +-0.02)`);
rule(painEnemy.maxPainAlive <= 1, `pain debounce: never more than one enemy grunt alive at once (max ${painEnemy.maxPainAlive}, ${painEnemy.maxVoices} voices total)`);
rule(Math.abs(painEnemy.peak - painLightEnemy100.peak) <= 1, `pain debounce: post-limiter peak ${painEnemy.peak} dBFS within +-1 dB of a single enemy painLight at 100 u ${painLightEnemy100.peak} (enemy@0 ${painRef.peak}; 20 stacked per-event grunts would give ${painPerEvent.peak} pre-limiter)`);
rule(painLocal.created === 2 && painLocal.painCalls.length === 2, `pain debounce: 20 x PAIN(8) on the local player id 1 -> ${painLocal.created} voices / ${painLocal.painCalls.length} grunts at [${gruntTimes(painLocal)}] s (expect exactly 2)`);
rule(painLocal.maxPainAlive <= 1 && Math.abs(painLocal.peak - painLightOwn.peak) <= 1, `pain debounce (local): max ${painLocal.maxPainAlive} grunt alive, peak ${painLocal.peak} within +-1 dB of own painLight ${painLightOwn.peak}`);
rule(painEscalate.painCalls.length === 2 && painEscalate.painCalls[1].health === 25, `pain debounce escalates: health 95 -> 0 by 5 per tick -> grunts ${JSON.stringify(painEscalate.painCalls.map((p) => [p.t, p.health]))} (second grunt voiced with the lowest pending health 25 = heavy tier)`);
rule(painThenDeath.created === 1 && painThenDeath.painCalls.length === 0, `lethal PAIN + DEATH in one tick -> ${painThenDeath.created} voice (death cry only), ${painThenDeath.painCalls.length} grunts`);
rule(painAfterRespawn.painCalls.length === 2, `pain window reset by death/respawn: PAIN, DEATH +0.3 s, RESPAWN + PAIN +0.5 s -> grunts at [${gruntTimes(painAfterRespawn)}] s (expect 2)`);
rule(lgExchange.toneCalls.length === 20 && lgExchange.painCalls.length === 2 && lgExchange.maxPainAlive <= 1, `LG exchange (attacker): 20 ticks of FIRE+PAIN+HIT+LG_HIT -> ${lgExchange.toneCalls.length} hit tones (expect 20, per tick), ${lgExchange.painCalls.length} grunts (expect 2), max ${lgExchange.maxPainAlive} grunt alive, ${lgExchange.maxVoices} voices peak, mix peak ${lgExchange.peak} dBFS`);
rule(lgVictim.painCalls.length === 2 && lgVictim.maxPainAlive <= 1, `LG exchange (victim): 20 ticks of enemy FIRE + own PAIN + LG_HIT -> ${lgVictim.painCalls.length} grunts (expect 2), max ${lgVictim.maxPainAlive} alive, mix peak ${lgVictim.peak} dBFS`);
for (const r of rows) rule(r.peak <= -0.5, `no clipping: ${r.cue}/${r.variant}@${r.dist} peak ${r.peak} <= -0.5 dBFS`);
rule(stress.peak <= -0.3, `stress mix (explosion+SG+RG+pain+hit+LG+RL) peak ${stress.peak} <= -0.3 dBFS`);
rule(explGR <= 4, `limiter never pumps: rocket explosion gain reduction ${explGR} dB <= 4`);
const fireOwn = WEAPON_FIRE.map((n) => get(n, 'own', 0).peak); const med = median(fireOwn);
for (const n of WEAPON_FIRE) rule(Math.abs(get(n, 'own', 0).peak - med) <= 3, `weapon fire consistency (own): ${n} ${get(n, 'own', 0).peak} within +-3 dB of median ${med.toFixed(2)}`);
for (const d of DIST) { const ps = WEAPON_FIRE.map((n) => get(n, 'enemy', d).peak); const m = median(ps); for (const n of WEAPON_FIRE) rule(Math.abs(get(n, 'enemy', d).peak - m) <= 3, `weapon fire consistency (enemy@${d}): ${n} ${get(n, 'enemy', d).peak} within +-3 dB of median ${m.toFixed(2)}`); }
// perceived loudness: sample peak is set by the transient, so the seven fires must also agree A-weighted (momentary = max
// 50 ms window, the level a short cue is heard at; mean over the extent = what a duration-integrating meter reads)
const aMoms = WEAPON_FIRE.map((n) => get(n, 'own', 0).aMom); const aMed = median(aMoms);
for (const n of WEAPON_FIRE) rule(Math.abs(get(n, 'own', 0).aMom - aMed) <= 3, `weapon fire A-weighted momentary (own): ${n} ${get(n, 'own', 0).aMom} dB(A) within +-3 dB of median ${aMed.toFixed(2)}`);
for (const d of DIST) { const xs = WEAPON_FIRE.map((n) => get(n, 'enemy', d).aMom); const m = median(xs); for (const n of WEAPON_FIRE) rule(Math.abs(get(n, 'enemy', d).aMom - m) <= 3.5, `weapon fire A-weighted momentary (enemy@${d}): ${n} ${get(n, 'enemy', d).aMom} dB(A) within +-3.5 dB of median ${m.toFixed(2)}`); }
const aMeans = WEAPON_FIRE.map((n) => get(n, 'own', 0).aMean);
rule(Math.max(...aMeans) - Math.min(...aMeans) <= 6, `weapon fire A-weighted mean over extent (own) spans ${(Math.max(...aMeans) - Math.min(...aMeans)).toFixed(2)} dB <= 6 (${WEAPON_FIRE.map((n, i) => `${n} ${aMeans[i]}`).join(', ')})`);
// spectral balance: the identifying layer (MG crack, rail ring, SG blast, plasma bloop) carries the energy, the sub thump is support
for (const n of ['machinegunFire', 'railFire', 'shotgunFire', 'plasmaFire']) rule(get(n, 'own', 0).sub300 < 0.5, `spectral balance: ${n} energy below 300 Hz ${(get(n, 'own', 0).sub300 * 100).toFixed(1)}% < 50% (enemy@0 ${(get(n, 'enemy', 0).sub300 * 100).toFixed(1)}%)`);
// headroom: a single weapon fire never reaches the limiter threshold (-3 dBFS): pre-limiter peak <= -6 dBFS own and point blank
for (const n of WEAPON_FIRE) for (const vr of ['own', 'enemy']) rule(get(n, vr, 0).peakPre <= -6, `pre-limiter headroom: ${n}/${vr}@0 peak ${get(n, vr, 0).peakPre} <= -6 dBFS`);
for (const c of CUES.filter((c) => c.kind === 'dual')) rule(get(c.name, 'enemy', 0).peak >= get(c.name, 'own', 0).peak - 0.5, `enemy >= own: ${c.name} enemy@0 ${get(c.name, 'enemy', 0).peak} >= own ${get(c.name, 'own', 0).peak} - 0.5`);
// ... in every direction: the HRTF loses 4-6 dB at 2-5 kHz behind / above / below the listener (see --hrtf); the direction-aware
// compensation must bring every cue back to >= own at 100 u, and >= own + model (-5.46 dB) at 600 u. Also bounded above: no
// direction may be more than 4 dB louder than the same cue straight ahead (the side near-ear gain is ~+2.5), so the
// compensation does not overshoot and a cue keeps one loudness whichever way the listener faces.
for (const c of CUES.filter((c) => c.kind === 'dual')) for (const d of DIR_DIST) {
  const own = get(c.name, 'own', 0).peak, floor = own + distanceDb(d) - 0.5, front = get(c.name, 'enemy-front', d).peak;
  for (const dn of Object.keys(DIRS)) { const r = get(c.name, 'enemy-' + dn, d); rule(r.peak >= floor, `enemy >= own (${dn}, ${d}u): ${c.name} ${r.peak} >= own ${own} ${d > REF_DIST ? `+ model ${distanceDb(d).toFixed(2)} ` : ''}- 0.5`); }
  const mx = Math.max(...Object.keys(DIRS).map((dn) => get(c.name, 'enemy-' + dn, d).peak));
  rule(mx <= front + 4, `directional overshoot (${d}u): ${c.name} loudest direction ${mx} <= front ${front} + 4`);
}
const fs600 = get('footstep', 'enemy', 600), fsR = get('footstep', 'enemy-right', 600), fsB = get('footstep', 'enemy-back', 100), mgB = get('machinegunFire', 'enemy-back', 100);
rule(fsB.peak >= -14.6, `footstep 100u behind: peak ${fsB.peak} >= -14.6 dBFS`);
rule(mgB.peak >= -7.8, `machinegun 100u behind: peak ${mgB.peak} >= -7.8 dBFS`);
// origin resolution for remote body cues (EV.FOOTSTEP carries no origin): unknown player -> dropped, not voiced non-spatially;
// player in cg.remote -> one spatial voice; player seen earlier in an event with an origin but since gone from cg.remote -> spatial at that origin
rule(originCases.unknown.created === 0 && originCases.unknown.dropped === 1, `unresolvable remote footstep (id 2, empty cg.remote) -> ${originCases.unknown.created} voices (expect 0), dropped ${originCases.unknown.dropped} (expect 1), peak ${originCases.unknown.peak}`);
rule(originCases.known.created === 1 && originCases.known.spatial === 1 && Math.abs(originCases.known.peak - fs600.peak) <= 0.5, `remote footstep with cg.remote at 600u front -> ${originCases.known.created} voice, spatial ${originCases.known.spatial}, peak ${originCases.known.peak} (enemy@600 ${fs600.peak} +-0.5)`);
rule(originCases.lastKnown.created === 2 && originCases.lastKnown.spatial === 2 && originCases.lastKnown.dropped === 0, `remote footstep after PAIN with origin, player gone from cg.remote -> ${originCases.lastKnown.created} voices (expect 2), spatial ${originCases.lastKnown.spatial} (expect 2), dropped ${originCases.lastKnown.dropped}`);
rule(fs600.peak >= -30, `enemy footstep audible at 600u: peak ${fs600.peak} >= -30 dBFS`);
rule(Math.abs(fsR.peakL - fsR.peakR) >= 6, `enemy footstep located at 600u (right side): |L-R| ${Math.abs(fsR.peakL - fsR.peakR).toFixed(2)} dB >= 6`);
rule(get('respawnMajor', 'enemy', 1500).peak >= -24 && get('respawnMajor', 'enemy', 3000).peak >= -30, `major respawn map-wide: peak@1500 ${get('respawnMajor', 'enemy', 1500).peak} >= -24, @3000 ${get('respawnMajor', 'enemy', 3000).peak} >= -30`);
rule(get('respawnMinor', 'enemy', 1500).peak <= get('respawnMajor', 'enemy', 1500).peak - 10, `minor respawn local: peak@1500 ${get('respawnMinor', 'enemy', 1500).peak} <= major - 10`);
const quietestFar = Math.min(...WEAPON_FIRE.map((n) => get(n, 'enemy', 1500).peak));
rule(amb.rms <= -36 && amb.rms <= quietestFar - 12, `ambient bed rms ${amb.rms} <= -36 dBFS and >= 12 dB under quietest weapon at 1500u (${quietestFar})`);
const ref = get('railFire', 'enemy', 300).peak;
rule(Math.abs((get('railFire', 'enemy', 600).peak - ref) - (-5.46)) <= 3 && Math.abs((get('railFire', 'enemy', 1500).peak - ref) - (-13.42)) <= 3, `inverse distance model (ref 320): rail 600u ${(get('railFire', 'enemy', 600).peak - ref).toFixed(2)} dB (expect -5.5), 1500u ${(get('railFire', 'enemy', 1500).peak - ref).toFixed(2)} dB (expect -13.4)`);
for (const r of rows.filter((r) => r.voicesAfterGc !== undefined)) rule(r.voicesAfterGc === 0 && r.loopsAfterGc === 0 && r.created === r.killed, `no zombie nodes: ${r.cue}/${r.variant}@${r.dist} voices ${r.voicesAfterGc} loops ${r.loopsAfterGc} created ${r.created} killed ${r.killed}`);
rule(stress.final.voices === 0 && stress.final.loops === 0, `no zombie nodes after stress mix: voices ${stress.final.voices} loops ${stress.final.loops}`);
for (const c of CUES) { const r = get(c.name, c.kind === 'world' ? 'enemy' : 'own', 0); rule(r.duration <= c.maxDur + 0.05, `duration: ${c.name} ${r.duration}s <= ${c.maxDur}s`); }
rule(consoleErrors.length === 0, `no console errors: ${JSON.stringify(consoleErrors.slice(0, 5))}`);

// ---- calibration suggestions: trim * 10^((target - measured)/20); dual cues use the mean of own and enemy@0 so both sit inside the window ----
const suggest = {};
for (const c of CUES) {
  const key = c.trim || c.name; const cur = trims[key]; if (cur === undefined) continue;
  const measured = c.kind === 'dual' ? (get(c.name, 'own', 0).peak + get(c.name, 'enemy', 0).peak) / 2 : get(c.name, c.kind === 'world' ? 'enemy' : 'own', 0).peak;
  const s = cur * Math.pow(10, (c.target - measured) / 20); suggest[key] = suggest[key] ? +((suggest[key] + s) / 2).toFixed(3) : +s.toFixed(3);
}
suggest.ambient = +(trims.ambient * Math.pow(10, (-40 - amb.rms) / 20)).toFixed(3);
const ownVsEnemy = CUES.filter((c) => c.kind === 'dual').map((c) => get(c.name, 'enemy', 0).peak - get(c.name, 'own', 0).peak);
const suggestRemote = +(remoteGain * Math.pow(10, -Math.min(...ownVsEnemy) / 20)).toFixed(3);
if (args.calibrate) console.log('suggested CUE_TRIM:', JSON.stringify(suggest), '\nsuggested REMOTE_GAIN:', suggestRemote, '(min enemy-own delta', Math.min(...ownVsEnemy).toFixed(2), 'dB)');

// ---- palette sheet: waveform + spectrogram tiles drawn in-page, saved as PNG ----
const png = await page.evaluate((tiles) => {
  const TW = 300, TH = 130, COLS = 5; const rowsN = Math.ceil(tiles.length / COLS);
  const cv = document.createElement('canvas'); cv.width = TW * COLS; cv.height = TH * rowsN + 24; const g = cv.getContext('2d');
  g.fillStyle = '#101418'; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = '#c8d0d8'; g.font = '13px monospace'; g.fillText('Arena Duel synthesized palette: waveform (top) + spectrogram 60 Hz..12 kHz log (bottom), first 1.6 s', 8, 16);
  tiles.forEach((t, i) => {
    const x0 = (i % COLS) * TW, y0 = 24 + Math.floor(i / COLS) * TH;
    g.fillStyle = '#181e26'; g.fillRect(x0 + 2, y0 + 2, TW - 4, TH - 4);
    g.fillStyle = '#e8eef4'; g.font = 'bold 12px monospace'; g.fillText(`${t.name}  ${t.peak} dBFS  ${t.duration}s`, x0 + 8, y0 + 16);
    const wy = y0 + 22, wh = 40; g.fillStyle = '#4fc3f7'; const n = t.env.length; const visible = Math.floor(n * 1.6 / 2.5);
    for (let k = 0; k < Math.min(n, visible); k++) { const h = Math.max(1, t.env[k] * wh); g.fillRect(x0 + 8 + k * (TW - 16) / visible, wy + wh / 2 - h / 2, Math.max(1, (TW - 16) / visible - 0.5), h); }
    const sy = y0 + 68, sh = 56; const FR = t.spec.length, NB = t.spec[0].length;
    for (let f = 0; f < FR; f++) for (let b = 0; b < NB; b++) { const v = t.spec[f][b] / 255; g.fillStyle = `rgb(${Math.round(20 + 235 * v)},${Math.round(20 + 120 * v * v)},${Math.round(60 + 60 * (1 - v))})`; g.fillRect(x0 + 8 + f * (TW - 16) / FR, sy + sh - (b + 1) * sh / NB, (TW - 16) / FR + 0.5, sh / NB + 0.5); }
  });
  return cv.toDataURL('image/png').split(',')[1];
}, sheet);
fs.writeFileSync(path.join(outDir, 'palette.png'), Buffer.from(png, 'base64'));

const report = { generated: new Date().toISOString(), remoteGain, hrtfComp, trims, makeupGainDb: makeup, originCases, rocketExplosionGainReductionDb: explGR, stressMix: { peak: stress.peak, gainReductionDb: stressGR, voicesAfter: stress.final.voices }, ambient: { peak: amb.peak, rms: amb.rms }, coalescing, painRate, rows, checks, failures, suggestedTrims: suggest, suggestedRemoteGain: suggestRemote, consoleErrors };
fs.writeFileSync(path.join(outDir, 'measure.json'), JSON.stringify(report, null, 2));
console.log(`\n${checks.length - failures.length}/${checks.length} rules passed. Report: ${path.relative(process.cwd(), path.join(outDir, 'measure.json'))}, palette: ${path.relative(process.cwd(), path.join(outDir, 'palette.png'))}`);
if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log(' - ' + f); }
await browser.close(); await server.close();
process.exit(failures.length ? 1 : 0);

// Live mode: real client, real AudioContext, bot opponent. The local player runs, jumps and fires through the weapons while the
// engine is sampled twice a second; at the end it idles so every voice must be gone.
async function liveRun() {
  await page.goto(`http://localhost:${port}/?auto=1&bot=1&nolock=1&name=AudioLive`, { waitUntil: 'load' });
  // instrument as soon as the engine exists (before the first snapshot arrives) so the join sequence is audited too
  await page.waitForFunction(() => window.__arena && window.__arena.audio && window.__arena.audio.ctx, { timeout: 15000 });
  // Instrumentation: count events by type as the engine receives them, and audit the damage coalescing: local HIT / PAIN events
  // are grouped by render frame (the engine flushes in update()) and by arrival burst (events > 8 ms apart came from different
  // server ticks); the number of hit tones / pain grunts actually voiced must sit between those two counts and far below the
  // raw event count whenever a multi-pellet shotgun blast landed (maxHitsPerFrame > 1).
  await page.evaluate((SG) => {
    const a = window.__arena.audio; window.__evCount = {}; window.__frame = 0;
    const c = window.__coal = { hitEvents: 0, hitFrames: 0, hitBursts: 0, hitTones: 0, maxHitsPerFrame: 0, painEvents: 0, painFrames: 0, painBursts: 0, painGrunts: 0, maxPainPerFrame: 0, hitsByWeapon: {}, hitFrameSizes: {}, painById: {} };
    // per player: PAIN events, grunts actually voiced, span of the PAIN stream, and the grunt count a Q3 700 ms debounce would
    // give on the arrival times (lethal PAINs are not voiced and, like the engine, reset the window)
    const painOf = (id, now) => c.painById[id] || (c.painById[id] = { events: 0, grunts: 0, first: now, last: now, expected: 0, simT: -1e9 });
    const notePainId = (e, now) => { const p = painOf(e.id, now); p.events++; p.last = now; if (e.health <= 0) { p.simT = -1e9; return; } if (now - p.simT >= 700) { p.expected++; p.simT = now; } };
    const st = { hit: { frame: -1, last: -1e9, n: 0 }, pain: { frame: -1, last: -1e9, n: 0 } };
    const note = (k) => { const s = st[k], now = performance.now(); c[k + 'Events']++; if (now - s.last > 8) c[k + 'Bursts']++; s.last = now; if (s.frame !== window.__frame) { s.frame = window.__frame; s.n = 0; c[k + 'Frames']++; } s.n++; c[k === 'hit' ? 'maxHitsPerFrame' : 'maxPainPerFrame'] = Math.max(c[k === 'hit' ? 'maxHitsPerFrame' : 'maxPainPerFrame'], s.n); };
    // dropped remote body cues (player position unresolvable): log type, whether the player was in cg.remote, and when
    window.__dropped = [];
    const orig = a.event.bind(a); a.event = (e, cg, p) => { window.__evCount[e.type] = (window.__evCount[e.type] || 0) + 1; if (e.type === 2 && e.id === cg.localId) { note('hit'); c.hitsByWeapon[e.weapon] = (c.hitsByWeapon[e.weapon] || 0) + 1; c.hitFrameSizes[st.hit.n] = (c.hitFrameSizes[st.hit.n] || 0) + 1; if (st.hit.n > 1) c.hitFrameSizes[st.hit.n - 1]--; } if (e.type === 5) { notePainId(e, performance.now()); if (e.id === cg.localId) note('pain'); } const d0 = a.counters.dropped; const r = orig(e, cg, p); if (a.counters.dropped > d0) window.__dropped.push({ type: e.type, id: e.id, inRemote: cg.remote.has(e.id), remoteIds: [...cg.remote.keys()], t: +(performance.now() / 1000).toFixed(2) }); return r; };
    const upd = a.update.bind(a); a.update = (cg, now) => { upd(cg, now); window.__frame++; };
    const ht = a.hitTone.bind(a); a.hitTone = (d) => { c.hitTones++; return ht(d); };
    const pn = a.pain.bind(a); a.pain = (o, l, h, id) => { if (l) c.painGrunts++; if (id !== undefined) painOf(id, performance.now()).grunts++; return pn(o, l, h, id); };
    // aim at the nearest opponent (server rewinds hitscan to the interpolated position we are looking at) so weapons connect
    window.__aim = setInterval(() => { const A = window.__arena, cg = A.cg; if (!cg || !cg.predicted || !A.input) return; let best = null, bd = 1e9; for (const r of cg.remote.values()) { const d = Math.hypot(r.origin[0] - cg.predicted.ps.origin[0], r.origin[1] - cg.predicted.ps.origin[1]); if (d < bd) { bd = d; best = r; } } if (!best) return; const eye = cg.predicted.ps.origin, vh = cg.predicted.ps.viewHeight || 26; const dx = best.origin[0] - eye[0], dy = best.origin[1] - eye[1], dz = best.origin[2] + 4 - (eye[2] + vh); A.input.setAngles(-Math.atan2(dz, Math.hypot(dx, dy)) * 180 / Math.PI, Math.atan2(dy, dx) * 180 / Math.PI); if (bd < 900 && cg.predicted.weapon !== SG) A.input.weapon = SG; }, 30);
  }, WEAPONS.SHOTGUN);
  await page.waitForFunction(() => window.__arena.cg && window.__arena.cg.predicted, { timeout: 15000 });
  const samples = []; const t0 = Date.now(); let held = new Set(); let step = 0;
  // shotgun first and often (the coalescing audit needs multi-pellet hits), then the rest of the arsenal
  // always pushing toward the opponent we are aiming at (the aim helper switches to the shotgun inside 900 units so the
  // coalescing audit sees multi-pellet hits), strafing and jumping to exercise the movement cues
  const script = [{ keys: ['KeyW'], weapon: 'Digit3', fire: true }, { keys: ['KeyW', 'KeyD'], jump: true, weapon: 'Digit2', fire: true }, { keys: ['KeyW', 'KeyA'], weapon: 'Digit3', fire: true, jump: true }, { keys: ['KeyW'], weapon: 'Digit4', fire: true }, { keys: ['KeyW', 'KeyD'], weapon: 'Digit3', fire: true, jump: true }, { keys: ['KeyW', 'KeyA'], weapon: 'Digit6', fire: true }, { keys: ['KeyW'], weapon: 'Digit5', fire: true, jump: true }, { keys: ['KeyW', 'KeyD'], weapon: 'Digit7', fire: true }, { keys: ['KeyW', 'KeyA'], weapon: 'Digit3', fire: true }, { keys: ['KeyW'], weapon: 'Digit1', fire: true, jump: true }];
  while ((Date.now() - t0) / 1000 < live) {
    const el = (Date.now() - t0) / 1000;
    const active = el < live - 2.5; // idle at the end so loops and voices drain
    if (active && el >= step * 2) {
      const s = script[step % script.length]; step++;
      for (const k of held) await page.keyboard.up(k); held.clear();
      for (const k of s.keys) { await page.keyboard.down(k); held.add(k); }
      if (s.jump) { await page.keyboard.down('Space'); setTimeout(() => page.keyboard.up('Space').catch(() => {}), 120); }
      if (s.weapon) await page.keyboard.press(s.weapon);
      await page.evaluate((f) => { const inp = window.__arena.input; if (inp) inp.mouseButtons = f ? 1 : 0; }, !!s.fire);
    }
    if (!active && held.size) { for (const k of held) await page.keyboard.up(k); held.clear(); await page.evaluate(() => { const inp = window.__arena.input; if (inp) inp.mouseButtons = 0; }); }
    const s = await page.evaluate(() => { const a = window.__arena.audio; return { ...a.stats(), sampleRate: a.ctx.sampleRate, baseLatency: a.ctx.baseLatency, events: { ...window.__evCount }, coal: { ...window.__coal }, droppedEvents: window.__dropped.slice() }; });
    s.t = +el.toFixed(2); samples.push(s);
    await new Promise((r) => setTimeout(r, 500));
  }
  const last = samples[samples.length - 1]; const maxVoices = Math.max(...samples.map((s) => s.voices)); const oldest = Math.max(...samples.map((s) => s.oldest));
  const EVN = { 1: 'FIRE', 2: 'HIT', 3: 'EXPLODE', 4: 'PICKUP', 5: 'PAIN', 6: 'DEATH', 7: 'RESPAWN', 8: 'JUMP', 9: 'LAND', 10: 'FOOTSTEP', 11: 'ITEM_RESPAWN', 12: 'RAIL_TRAIL', 13: 'BULLET_IMPACT', 14: 'JUMPPAD', 15: 'TELEPORT', 16: 'WEAPON_CHANGE', 17: 'NOAMMO', 18: 'MATCH_START', 19: 'MATCH_END', 20: 'ROUND_START', 21: 'ROUND_END', 22: 'GIB', 23: 'LG_HIT', 24: 'COUNTDOWN', 25: 'MAJOR_WARN', 26: 'FALL_DAMAGE', 27: 'STEP' };
  const events = Object.fromEntries(Object.entries(last.events).map(([k, v]) => [EVN[k] || k, v]));
  const fails = [];
  if (!samples.every((s) => s.state === 'running')) fails.push('audio context not running: ' + [...new Set(samples.map((s) => s.state))].join(','));
  // the bot keeps fighting during the local idle window, so a few in-flight voices are legitimate; a zombie would age forever
  if (oldest > 3) fails.push(`zombie voices: oldest one-shot voice alive for ${oldest}s (> 3 s)`);
  if (last.created !== last.killed + last.voices) fails.push(`voice accounting: created ${last.created} != killed ${last.killed} + live ${last.voices}`);
  if (maxVoices > 48) fails.push(`voice cap exceeded: ${maxVoices}`);
  if (last.voices > 8) fails.push(`voices still alive after idle: ${last.voices} (bed + the bot's in-flight cues expected <= 8)`);
  if (!(events.FIRE > 10 && events.FOOTSTEP > 5)) fails.push('too few gameplay events heard: ' + JSON.stringify(events));
  // damage coalescing audit (see instrumentation above): tones/grunts voiced per frame-or-tick, never per pellet
  const co = last.coal;
  if (!(co.hitFrames > 0 || co.painFrames > 0)) fails.push('no damage exchanged in the live run: ' + JSON.stringify(co));
  if (!(co.hitTones >= co.hitFrames && co.hitTones <= co.hitBursts)) fails.push(`hit tones not coalesced per tick: ${co.hitTones} tones for ${co.hitEvents} HIT events in ${co.hitFrames} frames / ${co.hitBursts} bursts`);
  if (!(co.painGrunts <= co.painBursts && (co.painEvents === 0 || co.painGrunts >= 1))) fails.push(`pain grunts not coalesced per tick: ${co.painGrunts} grunts for ${co.painEvents} PAIN events in ${co.painFrames} frames / ${co.painBursts} bursts`);
  // pain debounce per player (Q3: one grunt per 700 ms): grunts <= ceil(span / 0.7) + 1, and within +-1 of the count a 700 ms
  // debounce on the arrival times predicts (the engine's window runs on flush-to-flush time, one frame later than arrival)
  for (const [id, p] of Object.entries(co.painById || {})) {
    const span = Math.max(0, (p.last - p.first) / 1000), cap = Math.ceil(span / 0.7) + 1;
    p.spanSeconds = +span.toFixed(2); p.cap = cap;
    if (p.grunts > cap) fails.push(`pain not debounced for player ${id}: ${p.grunts} grunts for ${p.events} PAIN events over ${span.toFixed(2)} s (cap ceil(span/0.7)+1 = ${cap})`);
    if (Math.abs(p.grunts - p.expected) > 1) fails.push(`pain debounce drift for player ${id}: ${p.grunts} grunts, a 700 ms debounce on the ${p.events} arrivals predicts ${p.expected} (+-1)`);
  }
  if (co.maxHitsPerFrame > 1 && co.hitTones >= co.hitEvents) fails.push(`multi-pellet hits voiced per pellet: ${co.hitTones} tones for ${co.hitEvents} HIT events`);
  if (consoleErrors.length) fails.push('console errors: ' + JSON.stringify(consoleErrors.slice(0, 5)));
  const dropped = (last.droppedEvents || []).map((d) => ({ ...d, type: EVN[d.type] || d.type }));
  // a dropped cue is only legitimate while the player is not in cg.remote (never seen) - any drop for a placed player is a bug
  const badDrops = dropped.filter((d) => d.inRemote);
  if (badDrops.length) fails.push(`body cues dropped for players present in cg.remote: ${JSON.stringify(badDrops.slice(0, 5))}`);
  const out = { seconds: live, state: last.state, sampleRate: last.sampleRate, baseLatency: last.baseLatency, maxVoices, oldestVoiceAge: oldest, final: { voices: last.voices, loops: last.loops, created: last.created, killed: last.killed, spatial: last.spatial, dropped: last.dropped }, events, dropped, coalescing: co, fails, samples: samples.map((s) => ({ ...s, droppedEvents: undefined })) };
  fs.writeFileSync(path.join(outDir, 'live.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...out, samples: undefined }, null, 2));
  await browser.close(); await server.close();
  process.exitCode = fails.length ? 1 : 0;
}
// --hrtf: raw PannerNode (HRTF, no compensation) response per direction: sine tones at FREQS, RMS of L and R over the steady
// state, in dB relative to the same tone connected directly. Directions are unit vectors in the listener frame (looking down +X, +Z up).
async function hrtfRun() {
  const FREQS = [125, 180, 250, 350, 500, 700, 1000, 1400, 2000, 2500, 3000, 3500, 4000, 5000, 6000, 8000, 10000];
  const dirs = { ...Object.fromEntries(Object.entries(DIRS).map(([k, v]) => [k, v.map((x) => x * 100)])),
    frontLeft: [70.7, 70.7, 0], backLeft: [-70.7, 70.7, 0], frontUp: [70.7, 0, 70.7], backUp: [-70.7, 0, 70.7], frontDown: [70.7, 0, -70.7], backDown: [-70.7, 0, -70.7], leftUp: [0, 70.7, 70.7],
    az30: [86.6, 50, 0], az60: [50, 86.6, 0], az120: [-50, 86.6, 0], az150: [-86.6, 50, 0], el30: [86.6, 0, 50], el_30: [86.6, 0, -50] };
  const measure = (pos) => page.evaluate(async (pos, FREQS) => {
    const sr = 48000, step = 0.3; const ctx = new OfflineAudioContext(2, Math.ceil(sr * (FREQS.length * step + 0.2)), sr);
    const l = ctx.listener; l.positionX.value = 0; l.positionY.value = 0; l.positionZ.value = 0; l.forwardX.value = 1; l.forwardY.value = 0; l.forwardZ.value = 0; l.upX.value = 0; l.upY.value = 0; l.upZ.value = 1;
    let dest = ctx.destination;
    if (pos) { const p = ctx.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 320; p.maxDistance = 3000; p.rolloffFactor = 1; p.positionX.value = pos[0]; p.positionY.value = pos[1]; p.positionZ.value = pos[2]; p.connect(ctx.destination); dest = p; }
    FREQS.forEach((f, i) => { const o = ctx.createOscillator(); o.frequency.value = f; const g = ctx.createGain(); g.gain.value = 0.3; o.connect(g); g.connect(dest); o.start(i * step); o.stop(i * step + 0.25); });
    const buf = await ctx.startRendering(); const L = buf.getChannelData(0), R = buf.getChannelData(1); const res = {};
    FREQS.forEach((f, i) => { const i0 = Math.floor((i * step + 0.1) * sr), i1 = Math.floor((i * step + 0.24) * sr); let sl = 0, sr2 = 0; for (let k = i0; k < i1; k++) { sl += L[k] * L[k]; sr2 += R[k] * R[k]; } const dB = (x) => 10 * Math.log10(x / (i1 - i0) + 1e-20); res[f] = [dB(sl), dB(sr2)]; });
    return res;
  }, pos, FREQS);
  const direct = await measure(null); const rel = {};
  for (const [name, pos] of Object.entries(dirs)) { const r = await measure(pos); rel[name] = {}; for (const f of FREQS) rel[name][f] = [+(r[f][0] - direct[f][0]).toFixed(1), +(r[f][1] - direct[f][0]).toFixed(1)]; }
  let txt = 'Hz'.padEnd(6) + Object.keys(rel).map((n) => n.padStart(13)).join('') + '\n';
  for (const f of FREQS) txt += String(f).padEnd(6) + Object.values(rel).map((r) => `${String(r[f][0]).padStart(6)}/${String(r[f][1]).padEnd(6)}`).join('') + '\n';
  console.log('HRTF panner response, L/R dB relative to direct:\n' + txt);
  fs.writeFileSync(path.join(outDir, 'hrtf.json'), JSON.stringify({ generated: new Date().toISOString(), freqs: FREQS, directions: dirs, dB: rel }, null, 1));
  console.log('written ' + path.relative(process.cwd(), path.join(outDir, 'hrtf.json')));
  await browser.close(); await server.close();
}
function median(a) { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; }
function writeWav(file, samples, sr) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  fs.writeFileSync(file, buf);
}
