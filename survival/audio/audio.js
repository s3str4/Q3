// Synthesized Web Audio engine for the survival slice (Millbrook). No sample assets: every cue is generated from
// oscillators, filtered noise and formant "grunts", in the same architecture as client/audio/audio.js:
//
//   source(s) -> voice gain -> [PannerNode for world sounds] -> bus -> master -> limiter -> soft clip -> destination
//
// Buses: player (own body/weapon cues), world (doors, wood, glass, loot), zombies (groans, steps, swipes), ui (chimes,
// stings, denials), ambient (beds, tension). Spatial cues use one distance model (inverse, refDistance 3 tiles,
// maxDistance 30, rolloff 1; sim x -> X, sim y -> Z, up +Y) with the listener at the player. Cues whose `who` is the
// player are non-spatial. Every cue is scheduled at ctx.currentTime when its event arrives (never setTimeout); loops
// (heartbeat, ambient beds, horde tension) are voices flagged loop=true and are stopped explicitly. update() garbage
// collects finished voices so no node outlives its sound.
//
// Levels (post-limiter peak at the listener, calibrated offline by `node tools/survival_audio_measure.mjs --calibrate`):
// UI/confirmations ~ -12 dBFS, gunshot -4, groans at 3 tiles -10, ambient beds -36 dBFS RMS. Limiter -3 dBFS, ceiling 0.95.
//
// Instrumentation for tests: triggerLog [{ cue, event, tick, simT, t, ctxTime, wall }] (cap 5000), cueTable() (EV -> cue),
// SILENT (EV types voiced by nothing, on purpose), ambientState (current bed), stats().
import { EV, ITEMS } from '../../shared/survival/constants.js';

export const REF_DIST = 3, MAX_DIST = 30, ROLLOFF = 1;
export const PANNING_MODEL = 'equalpower';   // predictable levels with many simultaneous zombies (HRTF costs ~1 ms per voice)
export const CEILING = 0.95;
export const MAX_VOICES = 56;
export const LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.001, release: 0.1 };
export const BUS_LEVELS = { player: 1, world: 1, zombies: 1, ui: 1, ambient: 1 };
export const AMBIENT_XFADE = 3;               // s, bed crossfade on phase change
export const TRIGGER_LOG_MAX = 5000;
// Event types deliberately voiced by nothing. NOISE is an AI diagnostic (every audible noise already has its own cue);
// ZOMBIE_LOST is a silent state transition (the groan cadence change is the tell). Far zombie steps/groans (beyond
// MAX_DIST) are dropped before a voice is created (counted in counters.far).
export const SILENT = new Set([EV.NOISE, EV.ZOMBIE_LOST]);

// Linear gain per cue (calibrated: see tools/survival_audio_measure.mjs --calibrate).
export const CUE_TRIM = {
  footstepGrass: 0.28, footstepAsphalt: 0.195, footstepConcrete: 0.159, footstepWood: 0.131, zombieStep: 0.149,
  swingFists: 0.237, swingBat: 0.443, meleeHitFists: 0.263, meleeHitBat: 0.261, zombieDeath: 0.43, gunshot: 0.43, bulletHitWorld: 0.17, bulletHitFlesh: 0.317,
  reload: 0.288, reloadDone: 0.231, noAmmo: 0.248,
  groanIdle: 0.672, groanChase: 0.806, zombieAlert: 0.747, zombieAttack: 0.809, zombieBash: 0.246, zombieStagger: 0.444,
  barricadeHit: 0.233, barricadeBroken: 0.377, doorBreak: 0.377, windowBreak: 0.233,
  playerHurt: 0.581, heartbeat: 0.206, playerDeath: 0.554, staminaOut: 0.229,
  pickupMetal: 0.246, pickupPaper: 0.322, pickupWood: 0.184, pickupGlass: 0.224, pickupTin: 0.232,
  containerFridge: 0.214, containerCabinet: 0.328, containerShelf: 0.176, containerLocker: 0.349, containerWreck: 0.559,
  doorOpen: 0.202, doorClose: 0.181, harvestHit: 0.205, harvestDone: 0.344, barricadeBuilt: 0.233, eat: 0.379, drink: 0.196, bandage: 0.182,
  weaponSwitch: 0.254, actionDenied: 0.417, objectiveStep: 0.353, objectiveComplete: 0.479,
  phaseDusk: 0.223, phaseNight: 0.26, phaseDawn: 0.22, phaseDay: 0.184, hordeHorn: 0.471, tension: 0.051, win: 0.399, lose: 0.449,
  ambientDay: 0.111, ambientDusk: 0.046, ambientNight: 0.046,
};
const T = CUE_TRIM;
// Gait scaling for footsteps: sneak is ~-12 dB under walk, run +4 dB. Zombie steps: shamble quiet drag, chase heavier.
const GAIT_GAIN = { sneak: 0.25, walk: 1, run: 1.6, shamble: 0.7, chase: 1.1 };
const PICKUP_MATERIAL = { ammo: 'metal', pistol: 'metal', bat: 'wood', fists: 'metal', bandage: 'paper', plank: 'wood', water: 'glass', food: 'tin' };
const CONTAINER_CUE = { fridge: 'containerFridge', cabinet: 'containerCabinet', closet: 'containerCabinet', shelf: 'containerShelf', locker: 'containerLocker', wreck: 'containerWreck' };

export class AudioEngine {
  // opts: { context: existing (Offline)AudioContext, ambient: true, limiter: true, seed }
  constructor(opts = {}) {
    this.opts = { ambient: true, limiter: true, ...opts };
    this.ctx = null; this.enabled = false; this.volume = 0.8;
    this.voices = new Set(); this.loops = new Map();          // loops: name -> { v, stop() } (heartbeat, tension, ambient:<phase>)
    this.counters = { created: 0, killed: 0, spatial: 0, far: 0 };
    this.triggerLog = []; this.ambientState = 'none'; this.listenerPos = [0, 0]; this.cameraYaw = 0;
    this.ambientSched = null;                                  // { phase, next: ctx time of the next sparse ambient event }
    this.hordeAlive = false;
    const seed = this.opts.seed;
    this.rand = seed === undefined ? Math.random : (() => { let s = (seed >>> 0) || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
    this.cues = this.buildCueTable();
  }

  init(opts) {
    if (opts) Object.assign(this.opts, opts);
    if (this.ctx) return;
    const ctx = this.opts.context || new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = this.volume;
    if (this.opts.limiter) {
      const c = ctx.createDynamicsCompressor(); c.threshold.value = LIMITER.threshold; c.knee.value = LIMITER.knee; c.ratio.value = LIMITER.ratio; c.attack.value = LIMITER.attack; c.release.value = LIMITER.release;
      const clip = ctx.createWaveShaper(); const n = 2049; const curve = new Float32Array(n); const knee = 0.6;
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; const a = Math.abs(x); curve[i] = Math.sign(x) * (a <= knee ? a : knee + (CEILING - knee) * Math.tanh((a - knee) / (CEILING - knee))); }
      clip.curve = curve; clip.oversample = '2x';
      this.limiter = c; this.clipper = clip; this.master.connect(c); c.connect(clip); clip.connect(ctx.destination);
    } else { this.limiter = null; this.master.connect(ctx.destination); }
    this.bus = {};
    for (const [name, g] of Object.entries(BUS_LEVELS)) { const b = ctx.createGain(); b.gain.value = g; b.connect(this.master); this.bus[name] = b; }
    this.noiseBuf = this.makeNoise(2);
    const l = ctx.listener; if (l.upX) { l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0; }
    this.setCameraYaw(this.cameraYaw);
    this.enabled = true;
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume(); }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }
  close() {
    if (!this.ctx) return;
    for (const l of this.loops.values()) l.stop(); this.loops.clear();
    for (const v of [...this.voices]) this.kill(v);
    if (this.ctx.close && !this.opts.context) this.ctx.close();
    this.enabled = false;
  }
  now() { return this.ctx.currentTime; }
  stats() {
    let oldest = 0; if (this.ctx) for (const v of this.voices) if (!v.loop) oldest = Math.max(oldest, this.ctx.currentTime - v.born);
    return { state: this.ctx ? this.ctx.state : 'none', voices: this.voices.size, loops: this.loops.size, loopNames: [...this.loops.keys()], oldest: +oldest.toFixed(2), created: this.counters.created, killed: this.counters.killed, spatial: this.counters.spatial, far: this.counters.far, ambient: this.ambientState, reduction: this.limiter ? this.limiter.reduction : 0 };
  }
  makeNoise(seconds) {
    const n = Math.floor(this.ctx.sampleRate * seconds); const b = this.ctx.createBuffer(1, n, this.ctx.sampleRate); const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = this.rand() * 2 - 1; return b;
  }

  // ---------- listener (the player; forward = screen-up so left/right pan matches the fixed camera) ----------
  setCameraYaw(yaw) {
    this.cameraYaw = yaw; if (!this.ctx) return; const l = this.ctx.listener;
    const fx = -Math.cos(yaw), fz = -Math.sin(yaw);            // renderer convention: screen-up = (-cos yaw, -sin yaw) in sim x/y (yaw PI/4 -> NW), so left/right pan matches the fixed 3/4 camera
    if (l.forwardX) { l.forwardX.value = fx; l.forwardY.value = 0; l.forwardZ.value = fz; } else l.setOrientation(fx, 0, fz, 0, 1, 0);
  }
  updateListener(x, y) {
    if (!this.ctx) return; this.listenerPos = [x, y]; const l = this.ctx.listener, t = this.now();
    if (l.positionX) { l.positionX.setTargetAtTime(x, t, 0.02); l.positionY.setTargetAtTime(0, t, 0.02); l.positionZ.setTargetAtTime(y, t, 0.02); } else l.setPosition(x, 0, y);
  }
  dist(origin) { return origin ? Math.hypot(origin[0] - this.listenerPos[0], origin[1] - this.listenerPos[1]) : 0; }

  // ---------- voices ----------
  // origin: [simX, simY] for spatial cues, null for own/UI cues. o: gain, loop, ref, maxDist, local.
  voice(bus, origin, o = {}) {
    const ctx = this.ctx; const spatial = !!origin && !o.local;
    const g = ctx.createGain(); g.gain.value = o.gain ?? 1;
    const v = { in: g, panner: null, end: 0, pending: 0, loop: !!o.loop, dead: false, born: ctx.currentTime, bus };
    if (spatial) {
      const p = ctx.createPanner(); p.panningModel = PANNING_MODEL; p.distanceModel = 'inverse'; p.refDistance = o.ref ?? REF_DIST; p.maxDistance = o.maxDist ?? MAX_DIST; p.rolloffFactor = o.rolloff ?? ROLLOFF;
      g.connect(p); p.connect(this.bus[bus]); v.panner = p; this.place(v, origin, false); this.counters.spatial++;
    } else g.connect(this.bus[bus]);
    this.voices.add(v); this.counters.created++;
    if (this.voices.size > MAX_VOICES) { let oldest = null; for (const x of this.voices) if (!x.loop && (!oldest || x.born < oldest.born)) oldest = x; if (oldest) this.kill(oldest); }
    return v;
  }
  place(v, origin, smooth = true) {
    const p = v.panner, t = this.now(); if (!p) return;
    if (p.positionX) { if (smooth) { p.positionX.setTargetAtTime(origin[0], t, 0.03); p.positionZ.setTargetAtTime(origin[1], t, 0.03); } else { p.positionX.setValueAtTime(origin[0], t); p.positionY.setValueAtTime(0, t); p.positionZ.setValueAtTime(origin[1], t); } }
    else p.setPosition(origin[0], 0, origin[1]);
  }
  kill(v) { if (v.dead) return; v.dead = true; try { v.in.disconnect(); if (v.panner) v.panner.disconnect(); } catch {} this.voices.delete(v); this.counters.killed++; }
  track(v, node, t1) { v.pending++; v.end = Math.max(v.end, t1); node.onended = () => { v.pending--; if (!v.loop && v.pending <= 0) this.kill(v); }; return node; }
  // Saturation stage (thumps, blasts): sources connect to the returned node.
  drive(v, amount = 2, level = 1) {
    const ctx = this.ctx; const ws = ctx.createWaveShaper(); const n = 1024; const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * amount) / Math.tanh(amount); }
    ws.curve = curve; ws.oversample = '2x';
    if (level !== 1) { const g = ctx.createGain(); g.gain.value = level; ws.connect(g); g.connect(v.in); } else ws.connect(v.in);
    return ws;
  }
  env(param, t0, t1, peak, attack = 0.005, hold = 0) {
    param.setValueAtTime(0, t0); param.linearRampToValueAtTime(peak, t0 + attack);
    const th = Math.min(t1 - 0.001, t0 + attack + hold); if (hold > 0) param.setValueAtTime(peak, th);
    param.exponentialRampToValueAtTime(0.0005, t1);
  }
  // o: peak, attack, hold, f1 (glide target at t1 or after o.sweep s), detune, vib {rate, depth}, dest
  osc(v, type, f0, t0, t1, o = {}) {
    const ctx = this.ctx; const s = ctx.createOscillator(); s.type = type; s.frequency.setValueAtTime(f0, t0);
    if (o.f1) s.frequency.exponentialRampToValueAtTime(o.f1, o.sweep ? t0 + o.sweep : t1);
    if (o.detune) s.detune.value = o.detune;
    if (o.vib) { const l = ctx.createOscillator(); l.frequency.value = o.vib.rate; const lg = ctx.createGain(); lg.gain.value = o.vib.depth; l.connect(lg); lg.connect(s.frequency); l.start(t0); l.stop(t1 + 0.02); }
    const g = ctx.createGain(); this.env(g.gain, t0, t1, o.peak ?? 1, o.attack ?? 0.005, o.hold ?? 0);
    s.connect(g); g.connect(o.dest || v.in); s.start(t0); s.stop(t1 + 0.02); this.track(v, s, t1 + 0.02); return s;
  }
  // o: type, freq, freqEnd, q, peak, attack, hold, rate, dest
  noise(v, t0, t1, o = {}) {
    const ctx = this.ctx; const s = ctx.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true; s.loopStart = this.rand() * 1.5; if (o.rate) s.playbackRate.value = o.rate;
    const f = ctx.createBiquadFilter(); f.type = o.type || 'lowpass'; f.frequency.setValueAtTime(o.freq ?? 2000, t0); if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(o.freqEnd, t1); f.Q.value = o.q ?? 0.7;
    const g = ctx.createGain(); this.env(g.gain, t0, t1, o.peak ?? 1, o.attack ?? 0.003, o.hold ?? 0);
    s.connect(f); f.connect(g); g.connect(o.dest || v.in); s.start(t0, s.loopStart); s.stop(t1 + 0.02); this.track(v, s, t1 + 0.02); return s;
  }
  // Vocal: sawtooth glide through three parallel formant bandpasses + breath noise. o: f0, f1, formants, formantsEnd, peak, attack, hold, vib, breath, q, dest
  grunt(v, t0, t1, o) {
    const ctx = this.ctx; const mix = ctx.createGain(); mix.gain.value = o.peak ?? 1; mix.connect(o.dest || v.in);
    const src = ctx.createOscillator(); src.type = o.type || 'sawtooth'; src.frequency.setValueAtTime(o.f0, t0); src.frequency.exponentialRampToValueAtTime(o.f1, t1);
    if (o.vib) { const l = ctx.createOscillator(); l.frequency.value = o.vib.rate; const lg = ctx.createGain(); lg.gain.value = o.vib.depth; l.connect(lg); lg.connect(src.frequency); l.start(t0); l.stop(t1 + 0.02); }
    const g = ctx.createGain(); this.env(g.gain, t0, t1, 1, o.attack ?? 0.02, o.hold ?? 0); src.connect(g);
    const fm0 = o.formants || [650, 1100, 2500], fm1 = o.formantsEnd || fm0;
    fm0.forEach((fq, i) => { const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = o.q ?? 6; f.frequency.setValueAtTime(fq, t0); f.frequency.exponentialRampToValueAtTime(fm1[i], t1); const fg = ctx.createGain(); fg.gain.value = i === 0 ? 1 : i === 1 ? 0.6 : 0.3; g.connect(f); f.connect(fg); fg.connect(mix); });
    this.noise(v, t0, t1, { type: 'bandpass', freq: o.breathFreq ?? 1600, q: 0.8, peak: (o.breath ?? 0.2), attack: o.attack ?? 0.02, dest: mix });
    src.start(t0); src.stop(t1 + 0.02); this.track(v, src, t1 + 0.02);
  }
  crackle(v, t0, t1, n, o = {}) {
    for (let i = 0; i < n; i++) { const a = t0 + this.rand() * (t1 - t0); const d = (o.min ?? 0.008) + this.rand() * (o.max ?? 0.02); this.noise(v, a, a + d, { type: o.type || 'highpass', freq: (o.freq ?? 1800) * (0.7 + this.rand() * 0.8), q: o.q ?? 0.7, peak: (o.peak ?? 0.4) * (0.5 + this.rand() * 0.5), attack: 0.001, dest: o.dest }); }
  }
  // Short wood knock: saturated low thump + two resonant taps. Used by doors, bashes, barricades, planks.
  wood(v, t, o = {}) {
    const d = this.drive(v, 2, o.level ?? 1); const f = o.freq ?? 180, p = o.peak ?? 1;
    this.noise(v, t, t + 0.06, { type: 'lowpass', freq: 900, freqEnd: 150, peak: p, attack: 0.001, dest: d });
    this.osc(v, 'sine', f, t, t + 0.09, { f1: f * 0.5, peak: p * 0.8, attack: 0.001, dest: d });
    this.osc(v, 'triangle', f * 2.7, t, t + 0.05, { peak: p * 0.35, attack: 0.001 });
    this.noise(v, t, t + 0.025, { type: 'bandpass', freq: 2200, q: 1.5, peak: p * 0.5, attack: 0.0007 });
  }

  // ---------- footsteps ----------
  // Player: surface identity in the first 30 ms (grass = soft thud + rustle, asphalt/concrete = hard tap, wood = hollow knock), scaled by gait.
  footstep(surface, gait, origin, local) {
    const key = { grass: 'footstepGrass', asphalt: 'footstepAsphalt', concrete: 'footstepConcrete', wood: 'footstepWood' }[surface] || 'footstepGrass';
    const v = this.voice('player', origin, { local, gain: T[key] * (GAIT_GAIN[gait] ?? 1) }); const t = this.now(); const r = this.rand();
    if (surface === 'grass') {
      this.noise(v, t, t + 0.06, { type: 'lowpass', freq: 500, freqEnd: 120, peak: 0.8, attack: 0.004 });
      this.noise(v, t + 0.005, t + 0.09, { type: 'bandpass', freq: 3500 + r * 1500, q: 0.8, peak: 0.5, attack: 0.01, hold: 0.02 }); // rustle
      this.osc(v, 'sine', 110 + r * 30, t, t + 0.05, { f1: 60, peak: 0.5, attack: 0.002 });
    } else if (surface === 'wood') {
      const d = this.drive(v, 2);
      this.osc(v, 'sine', 150 + r * 40, t, t + 0.09, { f1: 75, peak: 0.9, attack: 0.001, dest: d }); // hollow
      this.noise(v, t, t + 0.03, { type: 'bandpass', freq: 1200, q: 1.5, peak: 0.6, attack: 0.001 });
      this.osc(v, 'triangle', 420 + r * 60, t, t + 0.04, { peak: 0.3, attack: 0.001 });
    } else { // asphalt / concrete: hard tap, concrete slightly brighter
      const bright = surface === 'concrete' ? 1.25 : 1;
      this.noise(v, t, t + 0.018, { type: 'bandpass', freq: (2800 + r * 1200) * bright, q: 1.5, peak: 1, attack: 0.0006, hold: 0.003 });
      this.noise(v, t, t + 0.035, { type: 'bandpass', freq: 1400 * bright, q: 1, peak: 0.45, attack: 0.001 });
      this.osc(v, 'sine', 170 + r * 40, t, t + 0.04, { f1: 80, peak: 0.3, attack: 0.001 });
    }
    return v;
  }
  // Zombie: dragging scuff (long lowpass noise) under a lower dull thud; chase gait is a heavier stomp.
  zombieStep(surface, gait, origin) {
    const v = this.voice('zombies', origin, { gain: T.zombieStep * (GAIT_GAIN[gait] ?? 0.7) }); const t = this.now(); const r = this.rand();
    const hard = surface === 'asphalt' || surface === 'concrete';
    this.osc(v, 'sine', 80 + r * 20, t, t + 0.1, { f1: 45, peak: 0.9, attack: 0.004 });
    this.noise(v, t, t + (gait === 'chase' ? 0.06 : 0.16), { type: hard ? 'bandpass' : 'lowpass', freq: hard ? 1800 : 700, freqEnd: hard ? undefined : 250, q: 0.7, peak: gait === 'chase' ? 0.5 : 0.7, attack: gait === 'chase' ? 0.002 : 0.02, hold: gait === 'chase' ? 0 : 0.06 }); // drag
    return v;
  }

  // ---------- combat ----------
  swing(weapon, local = true) {
    const bat = weapon === 'bat'; const v = this.voice('player', null, { gain: bat ? T.swingBat : T.swingFists }); const t = this.now();
    this.noise(v, t, t + (bat ? 0.22 : 0.14), { type: 'bandpass', freq: bat ? 500 : 900, freqEnd: bat ? 1800 : 2600, q: 1.2, peak: 1, attack: bat ? 0.06 : 0.03, hold: 0.02 });
    if (bat) this.noise(v, t + 0.03, t + 0.2, { type: 'lowpass', freq: 400, freqEnd: 900, peak: 0.5, attack: 0.05 });
    return v;
  }
  // Wet thump (both) + a bone/wood crack on the bat.
  meleeHit(weapon, origin, killed) {
    const bat = weapon === 'bat'; const v = this.voice('world', origin, { gain: bat ? T.meleeHitBat : T.meleeHitFists }); const t = this.now(); const d = this.drive(v, 2.5);
    this.noise(v, t, t + 0.12, { type: 'lowpass', freq: 800, freqEnd: 150, q: 1.5, peak: 1, attack: 0.002, dest: d });
    this.osc(v, 'sine', 120, t, t + 0.12, { f1: 50, peak: 0.8, attack: 0.002, dest: d });
    this.noise(v, t + 0.01, t + 0.09, { type: 'bandpass', freq: 600, q: 2, peak: 0.5, attack: 0.005 }); // wet
    if (bat) { this.noise(v, t, t + 0.03, { type: 'highpass', freq: 2500, peak: 1, attack: 0.0005 }); this.crackle(v, t + 0.01, t + 0.08, 4, { freq: 2200, peak: 0.6 }); }
    return v;
  }
  zombieDeath(origin) {
    const v = this.voice('zombies', origin, { gain: T.zombieDeath }); const t = this.now();
    this.grunt(v, t, t + 0.55, { f0: 140, f1: 55, formants: [500, 900, 2200], formantsEnd: [350, 650, 1900], peak: 1, attack: 0.02, breath: 0.35, vib: { rate: 9, depth: 14 } }); // gurgle
    this.noise(v, t + 0.05, t + 0.5, { type: 'bandpass', freq: 350, q: 3, peak: 0.4, attack: 0.05, rate: 0.6 });
    this.noise(v, t + 0.5, t + 0.68, { type: 'lowpass', freq: 500, freqEnd: 90, peak: 0.8, attack: 0.003 }); // fall
    this.osc(v, 'sine', 80, t + 0.5, t + 0.64, { f1: 38, peak: 0.7, attack: 0.002 });
    return v;
  }
  zombieStagger(origin) {
    const v = this.voice('zombies', origin, { gain: T.zombieStagger }); const t = this.now();
    this.grunt(v, t, t + 0.2, { f0: 170, f1: 120, formants: [600, 1000, 2300], peak: 1, attack: 0.01, breath: 0.3 });
    return v;
  }
  // Pistol: crack transient + saturated 0.5-2 kHz body + short low tail. Own cue, the loudest thing in the mix (-4 dBFS).
  gunshot() {
    const v = this.voice('player', null, { gain: T.gunshot }); const t = this.now(); const body = this.drive(v, 3), sub = this.drive(v, 2, 0.6);
    this.noise(v, t, t + 0.015, { type: 'highpass', freq: 2500, peak: 1.3, attack: 0.0004 });
    this.noise(v, t, t + 0.14, { type: 'bandpass', freq: 1100, freqEnd: 400, q: 0.7, peak: 1, attack: 0.001, hold: 0.04, dest: body });
    this.osc(v, 'sine', 160, t, t + 0.12, { f1: 55, peak: 0.6, attack: 0.001, dest: sub });
    this.noise(v, t + 0.04, t + 0.45, { type: 'lowpass', freq: 500, freqEnd: 120, peak: 0.35, attack: 0.03 }); // tail
    return v;
  }
  bulletHit(origin, flesh) {
    const v = this.voice('world', origin, { gain: flesh ? T.bulletHitFlesh : T.bulletHitWorld }); const t = this.now();
    if (flesh) { const d = this.drive(v, 2); this.noise(v, t, t + 0.08, { type: 'lowpass', freq: 700, freqEnd: 150, q: 1.5, peak: 1, attack: 0.001, dest: d }); this.osc(v, 'sine', 140, t, t + 0.07, { f1: 60, peak: 0.7, attack: 0.001, dest: d }); }
    else { this.noise(v, t, t + 0.03, { type: 'highpass', freq: 2500, peak: 1, attack: 0.0005 }); this.noise(v, t + 0.01, t + 0.12, { type: 'bandpass', freq: 1500, q: 1, peak: 0.35, attack: 0.01 }); this.osc(v, 'sine', 1900 + this.rand() * 1200, t, t + 0.03, { peak: 0.3, attack: 0.001 }); } // dust tick
    return v;
  }
  reload() { // mag out (click + slide), mag in (heavier click) at +0.35 s
    const v = this.voice('player', null, { gain: T.reload }); const t = this.now();
    this.noise(v, t, t + 0.02, { type: 'bandpass', freq: 2600, q: 2, peak: 1, attack: 0.001 }); this.osc(v, 'square', 420, t, t + 0.04, { f1: 250, peak: 0.3, attack: 0.001 });
    this.noise(v, t + 0.04, t + 0.16, { type: 'bandpass', freq: 1800, q: 1, peak: 0.3, attack: 0.02 });
    this.noise(v, t + 0.35, t + 0.37, { type: 'bandpass', freq: 1900, q: 2, peak: 1, attack: 0.001 }); this.osc(v, 'square', 300, t + 0.35, t + 0.41, { f1: 180, peak: 0.45, attack: 0.001 });
    return v;
  }
  reloadDone() { // slide rack: metallic scrape then a snap
    const v = this.voice('player', null, { gain: T.reloadDone }); const t = this.now();
    this.noise(v, t, t + 0.09, { type: 'bandpass', freq: 2200, freqEnd: 3200, q: 1.5, peak: 0.6, attack: 0.01, hold: 0.04 });
    this.noise(v, t + 0.1, t + 0.125, { type: 'bandpass', freq: 3000, q: 2, peak: 1, attack: 0.001 }); this.osc(v, 'square', 520, t + 0.1, t + 0.15, { f1: 260, peak: 0.4, attack: 0.001 });
    return v;
  }
  noAmmo() { const v = this.voice('player', null, { gain: T.noAmmo }); const t = this.now(); this.noise(v, t, t + 0.015, { type: 'bandpass', freq: 3200, q: 3, peak: 1, attack: 0.001 }); this.osc(v, 'square', 700, t, t + 0.03, { f1: 400, peak: 0.4, attack: 0.001 }); return v; }

  // ---------- zombies ----------
  // Idle: low slow moan (90->70 Hz, wide vibrato). Chase: aggressive snarl (higher, rasped by fast vibrato, louder, breathier).
  groan(state, origin) {
    const chase = state === 'chase' || state === 'attack'; const v = this.voice('zombies', origin, { gain: chase ? T.groanChase : T.groanIdle }); const t = this.now(); const r = this.rand();
    if (chase) this.grunt(v, t, t + 0.55, { f0: 190 + r * 30, f1: 130, formants: [700, 1300, 2600], formantsEnd: [550, 1000, 2400], peak: 1, attack: 0.02, hold: 0.2, breath: 0.4, breathFreq: 2200, vib: { rate: 28, depth: 22 } });
    else this.grunt(v, t, t + 1.1, { f0: 95 + r * 15, f1: 68, formants: [480, 900, 2100], formantsEnd: [380, 700, 1900], peak: 1, attack: 0.15, hold: 0.3, breath: 0.25, vib: { rate: 5.5, depth: 7 } });
    return v;
  }
  zombieAlert(origin) { // short rising growl: "noticed you"
    const v = this.voice('zombies', origin, { gain: T.zombieAlert }); const t = this.now();
    this.grunt(v, t, t + 0.4, { f0: 110, f1: 240, formants: [550, 1000, 2400], formantsEnd: [750, 1400, 2800], peak: 1, attack: 0.03, hold: 0.1, breath: 0.35, vib: { rate: 20, depth: 15 } });
    return v;
  }
  zombieAttack(origin) { // swipe: fast dark whoosh + snarl bite
    const v = this.voice('zombies', origin, { gain: T.zombieAttack }); const t = this.now();
    this.noise(v, t, t + 0.18, { type: 'bandpass', freq: 400, freqEnd: 1500, q: 1.2, peak: 1, attack: 0.05, hold: 0.02 });
    this.grunt(v, t + 0.02, t + 0.22, { f0: 210, f1: 150, formants: [700, 1300, 2600], peak: 0.6, attack: 0.01, breath: 0.4, vib: { rate: 30, depth: 20 } });
    return v;
  }
  zombieBash(origin) { const v = this.voice('world', origin, { gain: T.zombieBash }); this.wood(v, this.now(), { freq: 140, peak: 1 }); return v; }
  barricadeHit(origin) { const v = this.voice('world', origin, { gain: T.barricadeHit }); const t = this.now(); this.wood(v, t, { freq: 200, peak: 1 }); this.crackle(v, t + 0.01, t + 0.1, 3, { freq: 2500, peak: 0.4 }); return v; }
  // Splinter: wood knock + dense crackle + falling planks.
  splinter(origin, big, trim) {
    const v = this.voice('world', origin, { gain: trim }); const t = this.now();
    this.wood(v, t, { freq: 120, peak: 1 });
    this.crackle(v, t, t + (big ? 0.35 : 0.25), big ? 14 : 8, { freq: 2600, peak: 0.7, min: 0.006, max: 0.03 });
    this.noise(v, t + 0.02, t + 0.3, { type: 'bandpass', freq: 900, q: 0.8, peak: 0.5, attack: 0.01 });
    for (const dt of big ? [0.25, 0.42] : [0.28]) this.wood(v, t + dt, { freq: 160 + this.rand() * 80, peak: 0.5 });
    return v;
  }
  windowBreak(origin) { // glass: bright inharmonic ring + tinkling shards
    const v = this.voice('world', origin, { gain: T.windowBreak }); const t = this.now();
    this.noise(v, t, t + 0.06, { type: 'highpass', freq: 4000, peak: 1, attack: 0.0005 });
    for (const [f, a] of [[3100, 0.5], [4700, 0.35], [6300, 0.25]]) this.osc(v, 'sine', f, t, t + 0.25, { peak: a, attack: 0.001, detune: (this.rand() - 0.5) * 30 });
    for (let i = 0; i < 9; i++) { const a = t + 0.05 + this.rand() * 0.45; this.osc(v, 'sine', 3500 + this.rand() * 4500, a, a + 0.08, { peak: 0.25, attack: 0.001 }); }
    this.noise(v, t + 0.05, t + 0.5, { type: 'highpass', freq: 5000, peak: 0.25, attack: 0.02 });
    return v;
  }

  // ---------- player body ----------
  playerHurt(health) {
    const v = this.voice('player', null, { gain: T.playerHurt }); const t = this.now(); const tier = health < 30 ? 2 : health < 60 ? 1 : 0;
    this.noise(v, t, t + 0.07, { type: 'lowpass', freq: 700, freqEnd: 150, peak: 0.8, attack: 0.001 }); this.osc(v, 'sine', 110, t, t + 0.08, { f1: 50, peak: 0.6, attack: 0.001 }); // impact
    this.grunt(v, t + 0.02, t + 0.22 + tier * 0.08, { f0: 230 - tier * 25, f1: 150 - tier * 25, formants: [680, 1150, 2550], formantsEnd: [500, 900, 2250], peak: 1, attack: 0.012, breath: 0.28, vib: tier ? { rate: 18, depth: 8 + tier * 4 } : undefined });
    return v;
  }
  playerDeath() {
    this.stopLoop('heartbeat');
    const v = this.voice('player', null, { gain: T.playerDeath }); const t = this.now();
    this.grunt(v, t, t + 1.1, { f0: 180, f1: 60, formants: [650, 1100, 2500], formantsEnd: [380, 650, 1900], peak: 1, attack: 0.03, hold: 0.2, breath: 0.5, vib: { rate: 10, depth: 10 } }); // long exhale
    this.noise(v, t + 0.3, t + 1.3, { type: 'bandpass', freq: 1500, freqEnd: 600, q: 0.6, peak: 0.35, attack: 0.1 });
    this.noise(v, t + 1.0, t + 1.2, { type: 'lowpass', freq: 500, freqEnd: 80, peak: 0.8, attack: 0.003 }); this.osc(v, 'sine', 75, t + 1.0, t + 1.16, { f1: 36, peak: 0.8, attack: 0.002 }); // thud
    return v;
  }
  staminaOut() { // heavy breath in/out
    const v = this.voice('player', null, { gain: T.staminaOut }); const t = this.now();
    this.noise(v, t, t + 0.35, { type: 'bandpass', freq: 900, freqEnd: 1500, q: 0.8, peak: 0.8, attack: 0.12, hold: 0.05 });
    this.noise(v, t + 0.4, t + 0.85, { type: 'bandpass', freq: 1400, freqEnd: 600, q: 0.8, peak: 1, attack: 0.08, hold: 0.1 });
    return v;
  }
  // Heartbeat loop: lub-dub pairs, 72 bpm, scheduled ahead on the audio clock by update() (see scheduleHeartbeat).
  heartbeatStart() {
    if (this.loops.has('heartbeat')) return this.loops.get('heartbeat').v;
    const ctx = this.ctx, t = this.now(); const v = this.voice('player', null, { gain: T.heartbeat, loop: true });
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.08); g.connect(this.drive(v, 2));
    const l = { v, g, next: t, bpm: 72, stop: () => { const t2 = this.now(); g.gain.cancelScheduledValues(t2); g.gain.setValueAtTime(g.gain.value, t2); g.gain.linearRampToValueAtTime(0, t2 + 0.15); v.loop = false; v.end = Math.max(v.end, t2 + 0.2); l.dead = true; } };
    this.loops.set('heartbeat', l); this.scheduleHeartbeat(l); return v;
  }
  scheduleHeartbeat(l) { // keep ~0.5 s of beats queued; each beat: lub (55 Hz) + dub (48 Hz) 0.14 s later
    const period = 60 / l.bpm;
    while (l.next < this.now() + 0.5) {
      const t = l.next; for (const [dt, f, p] of [[0, 58, 1], [0.14, 48, 0.7]]) { this.osc(l.v, 'sine', f, t + dt, t + dt + 0.11, { f1: f * 0.6, peak: p, attack: 0.004, dest: l.g }); this.noise(l.v, t + dt, t + dt + 0.05, { type: 'lowpass', freq: 200, peak: p * 0.4, attack: 0.002, dest: l.g }); }
      l.next += period;
    }
    l.v.end = l.next + 0.3;
  }

  // ---------- interaction / items ----------
  // Rising two-note confirmation plus a material tick that names the item kind.
  pickup(item) {
    const mat = PICKUP_MATERIAL[item] || (ITEMS[item] && ITEMS[item].kind === 'ammo' ? 'metal' : 'tin');
    const key = { metal: 'pickupMetal', paper: 'pickupPaper', wood: 'pickupWood', glass: 'pickupGlass', tin: 'pickupTin' }[mat];
    const v = this.voice('player', null, { gain: T[key] }); const t = this.now();
    this.osc(v, 'sine', 660, t, t + 0.07, { peak: 0.6, attack: 0.002 }); this.osc(v, 'sine', 880, t + 0.06, t + 0.2, { peak: 0.6, attack: 0.002 });
    switch (mat) {
      case 'metal': for (const dt of [0, 0.05]) { this.noise(v, t + dt, t + dt + 0.012, { type: 'bandpass', freq: 2400, q: 3, peak: 0.9, attack: 0.001 }); this.osc(v, 'sine', 3100, t + dt, t + dt + 0.05, { peak: 0.35, attack: 0.001 }); } break;
      case 'paper': this.noise(v, t, t + 0.12, { type: 'bandpass', freq: 3500, freqEnd: 6000, q: 0.6, peak: 0.6, attack: 0.02, hold: 0.03 }); this.crackle(v, t, t + 0.1, 5, { freq: 4500, peak: 0.4 }); break;
      case 'wood': this.wood(v, t, { freq: 220, peak: 0.6, level: 0.8 }); break;
      case 'glass': this.osc(v, 'sine', 2600, t, t + 0.15, { peak: 0.4, attack: 0.001 }); this.osc(v, 'sine', 3900, t + 0.005, t + 0.12, { peak: 0.25, attack: 0.001 }); this.noise(v, t + 0.05, t + 0.2, { type: 'lowpass', freq: 800, peak: 0.3, attack: 0.02, rate: 0.5 }); break; // slosh
      default: this.noise(v, t, t + 0.02, { type: 'bandpass', freq: 1700, q: 2.5, peak: 0.8, attack: 0.001 }); this.osc(v, 'square', 900, t, t + 0.06, { f1: 700, peak: 0.25, attack: 0.001 }); this.osc(v, 'sine', 1350, t, t + 0.1, { peak: 0.3, attack: 0.001 }); // tin
    }
    return v;
  }
  containerOpen(kind, origin) {
    const key = CONTAINER_CUE[kind] || 'containerCabinet'; const v = this.voice('world', origin, { gain: T[key] }); const t = this.now();
    switch (key) {
      case 'containerFridge': this.noise(v, t, t + 0.06, { type: 'lowpass', freq: 600, peak: 0.6, attack: 0.005 }); this.noise(v, t + 0.04, t + 0.45, { type: 'bandpass', freq: 3000, freqEnd: 5000, q: 0.7, peak: 0.7, attack: 0.08, hold: 0.1 }); this.osc(v, 'sine', 120, t + 0.1, t + 0.5, { peak: 0.2, attack: 0.1 }); break; // seal hiss + hum
      case 'containerShelf': this.wood(v, t, { freq: 200, peak: 0.7 }); this.noise(v, t + 0.08, t + 0.25, { type: 'bandpass', freq: 1200, q: 1, peak: 0.35, attack: 0.02 }); break;
      case 'containerLocker': this.noise(v, t, t + 0.03, { type: 'bandpass', freq: 2000, q: 2, peak: 1, attack: 0.001 }); this.osc(v, 'square', 260, t, t + 0.3, { f1: 200, peak: 0.25, attack: 0.002, vib: { rate: 8, depth: 6 } }); this.osc(v, 'sine', 1600, t, t + 0.35, { peak: 0.3, attack: 0.001 }); break; // metal clang
      case 'containerWreck': this.noise(v, t, t + 0.35, { type: 'bandpass', freq: 800, freqEnd: 300, q: 1.5, peak: 0.8, attack: 0.03, hold: 0.1 }); this.osc(v, 'sawtooth', 90, t, t + 0.4, { f1: 60, peak: 0.3, attack: 0.05 }); this.noise(v, t + 0.3, t + 0.33, { type: 'bandpass', freq: 1800, q: 2, peak: 0.8, attack: 0.001 }); break; // rusty groan + clunk
      default: this.osc(v, 'sawtooth', 300, t, t + 0.3, { f1: 420, peak: 0.25, attack: 0.05, hold: 0.1, vib: { rate: 14, depth: 25 } }); this.noise(v, t, t + 0.3, { type: 'bandpass', freq: 1400, freqEnd: 2200, q: 2, peak: 0.4, attack: 0.05 }); this.wood(v, t + 0.3, { freq: 240, peak: 0.4, level: 0.7 }); // creak + latch
    }
    return v;
  }
  door(open, origin) { // creak (rising or falling) + latch
    const v = this.voice('world', origin, { gain: open ? T.doorOpen : T.doorClose }); const t = this.now();
    this.osc(v, 'sawtooth', open ? 220 : 330, t, t + 0.35, { f1: open ? 340 : 200, peak: 0.3, attack: 0.04, hold: 0.15, vib: { rate: 11, depth: 18 } });
    this.noise(v, t, t + 0.35, { type: 'bandpass', freq: 1100, freqEnd: open ? 1900 : 700, q: 2.5, peak: 0.45, attack: 0.04, hold: 0.1 });
    this.wood(v, t + (open ? 0.02 : 0.33), { freq: 190, peak: open ? 0.45 : 0.9 });
    if (!open) this.noise(v, t + 0.34, t + 0.36, { type: 'bandpass', freq: 2800, q: 2, peak: 0.6, attack: 0.001 }); // latch
    return v;
  }
  harvestHit(origin) { // axe chop: bright transient + wood body
    const v = this.voice('world', origin, { gain: T.harvestHit }); const t = this.now();
    this.noise(v, t, t + 0.02, { type: 'highpass', freq: 3000, peak: 1, attack: 0.0005 });
    this.wood(v, t, { freq: 160, peak: 1 }); this.crackle(v, t + 0.01, t + 0.12, 4, { freq: 2200, peak: 0.4 });
    return v;
  }
  harvestDone(origin) { // long crack, creaking fall, planks tumble
    const v = this.voice('world', origin, { gain: T.harvestDone }); const t = this.now();
    this.crackle(v, t, t + 0.4, 16, { freq: 2200, peak: 0.7, min: 0.008, max: 0.04 });
    this.osc(v, 'sawtooth', 140, t, t + 0.5, { f1: 90, peak: 0.25, attack: 0.05, vib: { rate: 7, depth: 12 } });
    this.noise(v, t + 0.3, t + 0.9, { type: 'lowpass', freq: 900, freqEnd: 200, peak: 0.7, attack: 0.1, hold: 0.1 });
    for (const dt of [0.75, 0.9, 1.0]) this.wood(v, t + dt, { freq: 200 + this.rand() * 80, peak: 0.6 });
    return v;
  }
  barricadeBuilt(origin) { // hammer x3, 100 ms apart on the audio clock
    const v = this.voice('world', origin, { gain: T.barricadeBuilt }); const t = this.now();
    for (let i = 0; i < 3; i++) { const a = t + i * 0.1; this.noise(v, a, a + 0.015, { type: 'bandpass', freq: 2800, q: 2, peak: 1, attack: 0.0006 }); this.wood(v, a, { freq: 230, peak: 0.8 }); }
    return v;
  }
  eat() { const v = this.voice('player', null, { gain: T.eat }); const t = this.now(); for (const dt of [0, 0.22]) { this.noise(v, t + dt, t + dt + 0.09, { type: 'lowpass', freq: 1200, freqEnd: 300, q: 1.5, peak: 1, attack: 0.01, hold: 0.02 }); this.crackle(v, t + dt, t + dt + 0.08, 4, { type: 'bandpass', freq: 1500, peak: 0.5 }); } return v; }
  drink() { const v = this.voice('player', null, { gain: T.drink }); const t = this.now(); for (const dt of [0, 0.3]) { this.osc(v, 'sine', 260, t + dt, t + dt + 0.14, { f1: 120, peak: 0.7, attack: 0.02 }); this.noise(v, t + dt, t + dt + 0.12, { type: 'lowpass', freq: 700, q: 2, peak: 0.6, attack: 0.02, rate: 0.5 }); } return v; }
  bandage() { const v = this.voice('player', null, { gain: T.bandage }); const t = this.now(); this.noise(v, t, t + 0.3, { type: 'bandpass', freq: 2500, freqEnd: 4500, q: 0.7, peak: 1, attack: 0.02, hold: 0.15 }); this.crackle(v, t, t + 0.28, 12, { freq: 3500, peak: 0.5, min: 0.004, max: 0.012 }); return v; }
  weaponSwitch() { const v = this.voice('ui', null, { gain: T.weaponSwitch }); const t = this.now(); this.noise(v, t, t + 0.015, { type: 'bandpass', freq: 2500, q: 2, peak: 0.8, attack: 0.001 }); this.osc(v, 'sine', 180, t + 0.03, t + 0.07, { peak: 0.5, attack: 0.002 }); return v; }
  actionDenied() { const v = this.voice('ui', null, { gain: T.actionDenied }); const t = this.now(); for (const dt of [0, 0.11]) this.osc(v, 'square', 150, t + dt, t + dt + 0.07, { peak: 0.5, attack: 0.002, hold: 0.04 }); return v; }
  objectiveStep() { const v = this.voice('ui', null, { gain: T.objectiveStep }); const t = this.now(); this.osc(v, 'triangle', 659, t, t + 0.18, { peak: 0.6, attack: 0.003 }); this.osc(v, 'triangle', 831, t + 0.12, t + 0.42, { peak: 0.6, attack: 0.003 }); this.osc(v, 'sine', 1662, t + 0.12, t + 0.3, { peak: 0.12, attack: 0.003 }); return v; }
  objectiveComplete() { const v = this.voice('ui', null, { gain: T.objectiveComplete }); const t = this.now(); [523, 659, 784, 1047].forEach((f, i) => this.osc(v, 'triangle', f, t + i * 0.13, t + i * 0.13 + 0.45, { peak: 0.5, attack: 0.003 })); for (const f of [523, 784]) this.osc(v, 'sine', f * 2, t + 0.4, t + 1.0, { peak: 0.15, attack: 0.05 }); return v; }

  // ---------- stings ----------
  phaseSting(phase) {
    const key = { dusk: 'phaseDusk', night: 'phaseNight', dawn: 'phaseDawn', day: 'phaseDay' }[phase] || 'phaseDay';
    const v = this.voice('ui', null, { gain: T[key] }); const t = this.now();
    if (phase === 'dusk') { for (const [f, d] of [[110, 0], [165, 4], [220, -3]]) this.osc(v, 'sawtooth', f, t, t + 1.2, { peak: 0.5, attack: 0.6, hold: 0.2, detune: d }); this.noise(v, t, t + 1.2, { type: 'lowpass', freq: 600, peak: 0.25, attack: 0.5, hold: 0.2 }); } // brass swell
    else if (phase === 'night') { const d = this.drive(v, 2.5); this.osc(v, 'sine', 70, t, t + 1.4, { f1: 32, peak: 1, attack: 0.005, dest: d }); this.noise(v, t, t + 0.9, { type: 'lowpass', freq: 400, freqEnd: 60, peak: 0.6, attack: 0.005, dest: d }); this.osc(v, 'triangle', 55, t + 0.02, t + 1.8, { peak: 0.3, attack: 0.02 }); } // deep hit
    else if (phase === 'dawn') { for (const [f, d] of [[392, 4], [494, -4], [587, 3], [784, -3]]) this.osc(v, 'triangle', f, t, t + 1.8, { peak: 0.3, attack: 0.5, hold: 0.5, detune: d }); } // bright pad
    else { for (let i = 0; i < 4; i++) this.chirp(v, t + i * 0.16 + this.rand() * 0.05, 0.9); } // day: birds
    return v;
  }
  hordeHorn() { // blood-moon horn: detuned low saws with a slow swell, then a drone tail (2 s)
    const v = this.voice('ui', null, { gain: T.hordeHorn }); const t = this.now(); const d = this.drive(v, 2, 0.8);
    for (const [f, dt] of [[73.4, 0], [110, 6], [146.8, -5], [220, 3]]) this.osc(v, 'sawtooth', f, t, t + 2.0, { f1: f * 0.94, peak: 0.5, attack: 0.35, hold: 0.9, detune: dt, dest: d });
    this.noise(v, t, t + 2.0, { type: 'bandpass', freq: 300, q: 1, peak: 0.3, attack: 0.4, hold: 0.8 });
    return v;
  }
  tensionStart() { // rising bed while horde zombies are alive: two detuned low saws, a slow filter rise, a pulsing 6 Hz tremolo
    if (this.loops.has('tension')) return this.loops.get('tension').v;
    const ctx = this.ctx, t = this.now(); const v = this.voice('ambient', null, { gain: T.tension, loop: true });
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 2); g.connect(v.in);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(200, t); f.frequency.linearRampToValueAtTime(900, t + 40); f.Q.value = 2; f.connect(g);
    const nodes = [];
    for (const [fq, d] of [[55, 0], [82.4, 7]]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = fq; o.detune.value = d; o.connect(f); nodes.push(o); }
    const trem = ctx.createOscillator(); trem.frequency.value = 6; const tg = ctx.createGain(); tg.gain.value = 0.3; trem.connect(tg); tg.connect(g.gain); nodes.push(trem);
    for (const n of nodes) { n.start(t); this.track(v, n, Infinity); }
    const l = { v, stop: () => { const t2 = this.now(); g.gain.cancelScheduledValues(t2); g.gain.setValueAtTime(g.gain.value, t2); g.gain.linearRampToValueAtTime(0, t2 + 1.5); for (const n of nodes) n.stop(t2 + 1.6); v.loop = false; v.end = t2 + 1.6; } };
    this.loops.set('tension', l); return v;
  }
  fanfare(win) {
    const v = this.voice('ui', null, { gain: win ? T.win : T.lose }); const t = this.now();
    const notes = win ? [523, 659, 784, 1047] : [392, 349, 311, 262];
    notes.forEach((f, i) => this.osc(v, 'triangle', f, t + i * 0.18, t + i * 0.18 + 0.5, { peak: 0.5, attack: 0.005, detune: win ? 0 : -12 }));
    if (win) for (const f of [523, 659, 784]) this.osc(v, 'sine', f, t + 0.72, t + 1.6, { peak: 0.3, attack: 0.01 });
    else for (const f of [262, 311]) this.osc(v, 'sine', f, t + 0.72, t + 1.8, { peak: 0.35, attack: 0.02 });
    return v;
  }
  stopLoop(name) { const l = this.loops.get(name); if (l) { l.stop(); this.loops.delete(name); } }

  // ---------- ambient beds (by sim.phase, crossfade AMBIENT_XFADE s) ----------
  chirp(v, t, peak = 1) { // one bird note: quick sine up-chirp with a short repeat
    const f = 2400 + this.rand() * 1600;
    this.osc(v, 'sine', f, t, t + 0.07, { f1: f * 1.4, peak, attack: 0.005 }); this.osc(v, 'sine', f * 1.15, t + 0.1, t + 0.16, { f1: f * 1.5, peak: peak * 0.8, attack: 0.005 });
  }
  bedStart(phase) {
    const ctx = this.ctx, t = this.now(); const key = { day: 'ambientDay', dusk: 'ambientDusk', night: 'ambientNight', dawn: 'ambientDay' }[phase] || 'ambientDay';
    const v = this.voice('ambient', null, { gain: T[key], loop: true });
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + AMBIENT_XFADE); g.connect(v.in);
    const nodes = [];
    // wind: lowpassed noise with a slow LFO on the cutoff (gusts); darker and stronger at night
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true; const wf = ctx.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = phase === 'night' ? 220 : 420; wf.Q.value = 0.8;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.11; const lg = ctx.createGain(); lg.gain.value = phase === 'night' ? 120 : 220; lfo.connect(lg); lg.connect(wf.frequency);
    const wg = ctx.createGain(); wg.gain.value = phase === 'dusk' ? 0.5 : 1; n.connect(wf); wf.connect(wg); wg.connect(g); nodes.push(n, lfo);
    if (phase === 'dusk' || phase === 'night') { // crickets: 4.3 kHz tone chopped at 28 Hz (fainter at night)
      const c = ctx.createOscillator(); c.type = 'sine'; c.frequency.value = 4300; const chop = ctx.createOscillator(); chop.type = 'square'; chop.frequency.value = 28;
      const cg = ctx.createGain(); cg.gain.value = 0; const cgg = ctx.createGain(); cgg.gain.value = phase === 'dusk' ? 0.12 : 0.05; chop.connect(cgg); cgg.connect(cg.gain);
      const cs = ctx.createOscillator(); cs.frequency.value = 0.7; const csg = ctx.createGain(); csg.gain.value = 0.5; cs.connect(csg); csg.connect(cg.gain);   // slow swell between chirp bursts
      c.connect(cg); cg.connect(g); nodes.push(c, chop, cs);
    }
    for (const s of nodes) { s.start(t); this.track(v, s, Infinity); }
    const l = { v, g, stop: () => { const t2 = this.now(); g.gain.cancelScheduledValues(t2); g.gain.setValueAtTime(g.gain.value, t2); g.gain.linearRampToValueAtTime(0, t2 + AMBIENT_XFADE); for (const s of nodes) s.stop(t2 + AMBIENT_XFADE + 0.05); v.loop = false; v.end = t2 + AMBIENT_XFADE + 0.05; } };
    return l;
  }
  setAmbient(phase) {
    if (!this.enabled || !this.opts.ambient || phase === this.ambientState) return;
    for (const [k] of this.loops) if (k.startsWith('ambient:')) this.stopLoop(k);
    this.loops.set('ambient:' + phase, this.bedStart(phase));
    this.ambientState = phase;
    const t = this.now(); this.ambientSched = { phase, next: t + (phase === 'night' ? 6 : 2) + this.rand() * 3 };
  }
  // Sparse ambient events on the audio clock (day: bird chirp every 4-9 s; night: a distant moan every 10-20 s), scheduled 0.3 s ahead from update().
  stepAmbient() {
    const s = this.ambientSched; if (!s || !this.loops.has('ambient:' + s.phase)) return; const t = this.now(); if (s.next > t + 0.3) return;
    const at = Math.max(s.next, t);
    if (s.phase === 'day' || s.phase === 'dawn') { const l = this.loops.get('ambient:' + s.phase); if (l) { for (let i = 0; i < 1 + Math.floor(this.rand() * 3); i++) this.chirp(l.v, at + i * 0.22, 0.6 + this.rand() * 0.5); l.v.end = Infinity; } s.next = at + 4 + this.rand() * 5; }
    else if (s.phase === 'night') { const a = this.rand() * Math.PI * 2, d = 18 + this.rand() * 10; const v = this.voice('zombies', [this.listenerPos[0] + Math.cos(a) * d, this.listenerPos[1] + Math.sin(a) * d], { gain: T.groanIdle * 0.9 }); this.grunt(v, at, at + 1.3, { f0: 90, f1: 62, formants: [450, 850, 2000], formantsEnd: [350, 650, 1800], peak: 1, attack: 0.25, hold: 0.3, breath: 0.2, vib: { rate: 5, depth: 6 } }); s.next = at + 10 + this.rand() * 10; }
    else s.next = at + 5;
  }

  // ---------- cue table (name -> trigger) for tools/survival_audio_measure.mjs ----------
  buildCueTable() {
    const O = (o) => o.origin || [3, 0];
    return {
      footstepGrass: (o) => this.footstep('grass', o.gait || 'walk', null, true), footstepAsphalt: (o) => this.footstep('asphalt', o.gait || 'walk', null, true), footstepConcrete: (o) => this.footstep('concrete', o.gait || 'walk', null, true), footstepWood: (o) => this.footstep('wood', o.gait || 'walk', null, true),
      footstepSneak: () => this.footstep('grass', 'sneak', null, true), footstepRun: () => this.footstep('asphalt', 'run', null, true),
      zombieStep: (o) => this.zombieStep('grass', o.gait || 'shamble', O(o)), zombieStepChase: (o) => this.zombieStep('asphalt', 'chase', O(o)),
      swingFists: () => this.swing('fists'), swingBat: () => this.swing('bat'), meleeHitFists: (o) => this.meleeHit('fists', o.origin || [1, 0], false), meleeHitBat: (o) => this.meleeHit('bat', o.origin || [1, 0], false),
      zombieDeath: (o) => this.zombieDeath(o.origin || [1, 0]), zombieStagger: (o) => this.zombieStagger(o.origin || [1, 0]), gunshot: () => this.gunshot(), bulletHitWorld: (o) => this.bulletHit(o.origin || [6, 0], false), bulletHitFlesh: (o) => this.bulletHit(o.origin || [4, 0], true),
      reload: () => this.reload(), reloadDone: () => this.reloadDone(), noAmmo: () => this.noAmmo(),
      groanIdle: (o) => this.groan('idle', O(o)), groanChase: (o) => this.groan('chase', O(o)), zombieAlert: (o) => this.zombieAlert(O(o)), zombieAttack: (o) => this.zombieAttack(o.origin || [1, 0]), zombieBash: (o) => this.zombieBash(O(o)),
      barricadeHit: (o) => this.barricadeHit(O(o)), barricadeBroken: (o) => this.splinter(O(o), false, T.barricadeBroken), doorBreak: (o) => this.splinter(O(o), true, T.doorBreak), windowBreak: (o) => this.windowBreak(O(o)),
      playerHurt: (o) => this.playerHurt(o.health ?? 70), heartbeat: () => this.heartbeatStart(), playerDeath: () => this.playerDeath(), staminaOut: () => this.staminaOut(),
      pickupMetal: () => this.pickup('ammo'), pickupPaper: () => this.pickup('bandage'), pickupWood: () => this.pickup('plank'), pickupGlass: () => this.pickup('water'), pickupTin: () => this.pickup('food'),
      containerFridge: (o) => this.containerOpen('fridge', o.origin || [1, 0]), containerCabinet: (o) => this.containerOpen('cabinet', o.origin || [1, 0]), containerShelf: (o) => this.containerOpen('shelf', o.origin || [1, 0]), containerLocker: (o) => this.containerOpen('locker', o.origin || [1, 0]), containerWreck: (o) => this.containerOpen('wreck', o.origin || [1, 0]),
      doorOpen: (o) => this.door(true, o.origin || [1, 0]), doorClose: (o) => this.door(false, o.origin || [1, 0]), harvestHit: (o) => this.harvestHit(o.origin || [1, 0]), harvestDone: (o) => this.harvestDone(o.origin || [1, 0]), barricadeBuilt: (o) => this.barricadeBuilt(o.origin || [1, 0]),
      eat: () => this.eat(), drink: () => this.drink(), bandage: () => this.bandage(), weaponSwitch: () => this.weaponSwitch(), actionDenied: () => this.actionDenied(), objectiveStep: () => this.objectiveStep(), objectiveComplete: () => this.objectiveComplete(),
      phaseDusk: () => this.phaseSting('dusk'), phaseNight: () => this.phaseSting('night'), phaseDawn: () => this.phaseSting('dawn'), phaseDay: () => this.phaseSting('day'), hordeHorn: () => this.hordeHorn(), tension: () => this.tensionStart(), win: () => this.fanfare(true), lose: () => this.fanfare(false),
      ambientDay: () => { this.setAmbient('day'); return this.loops.get('ambient:day').v; }, ambientDusk: () => { this.setAmbient('dusk'); return this.loops.get('ambient:dusk').v; }, ambientNight: () => { this.setAmbient('night'); return this.loops.get('ambient:night').v; },
    };
  }
  cue(name, o = {}) { const f = this.cues[name]; if (!f) throw new Error('unknown cue ' + name); return f(o); }
  // EV type -> cue name(s) (a string, an array of variants, or 'SILENT'). Static: what event() does for each type.
  cueTable() {
    const S = 'SILENT';
    return {
      [EV.FOOTSTEP]: ['footstepGrass', 'footstepAsphalt', 'footstepConcrete', 'footstepWood', 'zombieStep'], [EV.SWING]: ['swingFists', 'swingBat'], [EV.MELEE_HIT]: ['meleeHitFists', 'meleeHitBat'],
      [EV.GUNSHOT]: 'gunshot', [EV.BULLET_HIT]: ['bulletHitWorld', 'bulletHitFlesh'], [EV.RELOAD]: 'reload', [EV.RELOAD_DONE]: 'reloadDone', [EV.NO_AMMO]: 'noAmmo',
      [EV.ZOMBIE_GROAN]: ['groanIdle', 'groanChase'], [EV.ZOMBIE_ALERT]: 'zombieAlert', [EV.ZOMBIE_LOST]: S, [EV.ZOMBIE_ATTACK]: 'zombieAttack', [EV.ZOMBIE_BASH]: 'zombieBash', [EV.ZOMBIE_STAGGER]: 'zombieStagger', [EV.ZOMBIE_DEATH]: 'zombieDeath',
      [EV.PLAYER_HURT]: 'playerHurt', [EV.PLAYER_DEATH]: 'playerDeath', [EV.LOW_HEALTH]: 'heartbeat', [EV.STAMINA_OUT]: 'staminaOut',
      [EV.PICKUP]: ['pickupMetal', 'pickupPaper', 'pickupWood', 'pickupGlass', 'pickupTin'], [EV.CONTAINER_OPEN]: ['containerFridge', 'containerCabinet', 'containerShelf', 'containerLocker', 'containerWreck'],
      [EV.DOOR_OPEN]: 'doorOpen', [EV.DOOR_CLOSE]: 'doorClose', [EV.DOOR_BREAK]: 'doorBreak', [EV.WINDOW_BREAK]: 'windowBreak', [EV.BARRICADE_BUILT]: 'barricadeBuilt', [EV.BARRICADE_HIT]: 'barricadeHit', [EV.BARRICADE_BROKEN]: 'barricadeBroken',
      [EV.HARVEST_HIT]: 'harvestHit', [EV.HARVEST_DONE]: 'harvestDone', [EV.EAT]: 'eat', [EV.DRINK]: 'drink', [EV.BANDAGE]: 'bandage', [EV.WEAPON_SWITCH]: 'weaponSwitch', [EV.ACTION_DENIED]: 'actionDenied',
      [EV.PHASE]: ['phaseDusk', 'phaseNight', 'phaseDawn', 'phaseDay'], [EV.HORDE]: 'hordeHorn', [EV.OBJECTIVE_STEP]: 'objectiveStep', [EV.OBJECTIVE_COMPLETE]: 'objectiveComplete', [EV.WIN]: 'win', [EV.LOSE]: 'lose', [EV.NOISE]: S,
    };
  }

  // ---------- event routing (payloads from shared/survival/sim.js) ----------
  log(cue, e) { if (this.triggerLog.length >= TRIGGER_LOG_MAX) this.triggerLog.shift(); this.triggerLog.push({ cue, event: e.type, tick: e.tick, simT: e.t, t: e.t, ctxTime: +this.now().toFixed(4), wall: +performance.now().toFixed(1) }); }
  event(e, sim) {
    if (!this.enabled) return;
    if (sim && sim.player) this.listenerPos = [sim.player.x, sim.player.y];
    const own = e.who === 'player'; const origin = e.x !== undefined ? [e.x, e.y] : null;
    const far = origin && !own && this.dist(origin) > MAX_DIST;
    let cue = null;
    switch (e.type) {
      case EV.FOOTSTEP:
        if (own) { const k = { grass: 'footstepGrass', asphalt: 'footstepAsphalt', concrete: 'footstepConcrete', wood: 'footstepWood' }[e.surface] || 'footstepGrass'; this.footstep(e.surface, e.gait, null, true); cue = k; }
        else if (far) { this.counters.far++; return; }
        else { this.zombieStep(e.surface, e.gait, origin); cue = 'zombieStep'; }
        break;
      case EV.SWING: this.swing(e.weapon); cue = e.weapon === 'bat' ? 'swingBat' : 'swingFists'; break;
      case EV.MELEE_HIT: this.meleeHit(e.weapon, origin, e.killed); cue = e.weapon === 'bat' ? 'meleeHitBat' : 'meleeHitFists'; break;
      case EV.GUNSHOT: this.gunshot(); cue = 'gunshot'; break;
      case EV.BULLET_HIT: this.bulletHit(origin, e.target != null); cue = e.target != null ? 'bulletHitFlesh' : 'bulletHitWorld'; break;
      case EV.RELOAD: this.reload(); cue = 'reload'; break;
      case EV.RELOAD_DONE: this.reloadDone(); cue = 'reloadDone'; break;
      case EV.NO_AMMO: this.noAmmo(); cue = 'noAmmo'; break;
      case EV.ZOMBIE_GROAN: if (far) { this.counters.far++; return; } this.groan(e.state, origin); cue = (e.state === 'chase' || e.state === 'attack') ? 'groanChase' : 'groanIdle'; break;
      case EV.ZOMBIE_ALERT: this.zombieAlert(origin); cue = 'zombieAlert'; break;
      case EV.ZOMBIE_ATTACK: this.zombieAttack(origin); cue = 'zombieAttack'; break;
      case EV.ZOMBIE_BASH: this.zombieBash(origin); cue = 'zombieBash'; break;
      case EV.ZOMBIE_STAGGER: this.zombieStagger(origin); cue = 'zombieStagger'; break;
      case EV.ZOMBIE_DEATH: this.zombieDeath(origin); cue = 'zombieDeath'; break;
      case EV.PLAYER_HURT: this.playerHurt(e.health); cue = 'playerHurt'; break;
      case EV.PLAYER_DEATH: this.playerDeath(); cue = 'playerDeath'; break;
      case EV.LOW_HEALTH: if (e.on) this.heartbeatStart(); else this.stopLoop('heartbeat'); cue = e.on ? 'heartbeat' : 'heartbeatStop'; break;
      case EV.STAMINA_OUT: this.staminaOut(); cue = 'staminaOut'; break;
      case EV.PICKUP: { const mat = PICKUP_MATERIAL[e.item] || 'tin'; this.pickup(e.item); cue = 'pickup' + mat[0].toUpperCase() + mat.slice(1); break; }
      case EV.CONTAINER_OPEN: this.containerOpen(e.kind, origin); cue = CONTAINER_CUE[e.kind] || 'containerCabinet'; break;
      case EV.DOOR_OPEN: this.door(true, origin); cue = 'doorOpen'; break;
      case EV.DOOR_CLOSE: this.door(false, origin); cue = 'doorClose'; break;
      case EV.DOOR_BREAK: this.splinter(origin, true, T.doorBreak); cue = 'doorBreak'; break;
      case EV.WINDOW_BREAK: this.windowBreak(origin); cue = 'windowBreak'; break;
      case EV.BARRICADE_BUILT: this.barricadeBuilt(origin); cue = 'barricadeBuilt'; break;
      case EV.BARRICADE_HIT: this.barricadeHit(origin); cue = 'barricadeHit'; break;
      case EV.BARRICADE_BROKEN: this.splinter(origin, false, T.barricadeBroken); cue = 'barricadeBroken'; break;
      case EV.HARVEST_HIT: this.harvestHit(origin); cue = 'harvestHit'; break;
      case EV.HARVEST_DONE: this.harvestDone(origin); cue = 'harvestDone'; break;
      case EV.EAT: this.eat(); cue = 'eat'; break;
      case EV.DRINK: this.drink(); cue = 'drink'; break;
      case EV.BANDAGE: this.bandage(); cue = 'bandage'; break;
      case EV.WEAPON_SWITCH: this.weaponSwitch(); cue = 'weaponSwitch'; break;
      case EV.ACTION_DENIED: this.actionDenied(); cue = 'actionDenied'; break;
      case EV.PHASE: this.phaseSting(e.phase); this.setAmbient(e.phase); cue = 'phase' + e.phase[0].toUpperCase() + e.phase.slice(1); break;
      case EV.HORDE: this.hordeHorn(); this.tensionStart(); cue = 'hordeHorn'; break;
      case EV.OBJECTIVE_STEP: this.objectiveStep(); cue = 'objectiveStep'; break;
      case EV.OBJECTIVE_COMPLETE: this.objectiveComplete(); cue = 'objectiveComplete'; break;
      case EV.WIN: this.stopLoop('tension'); this.fanfare(true); cue = 'win'; break;
      case EV.LOSE: this.stopLoop('tension'); this.fanfare(false); cue = 'lose'; break;
      default: if (!SILENT.has(e.type)) console.warn('[audio] unmapped event', e.type); return;
    }
    this.log(cue, e);
  }

  // Per frame: listener follows the player, ambient bed follows sim.phase, heartbeat and sparse ambient events are kept
  // scheduled ahead on the audio clock, the horde tension bed lives while any horde zombie does, finished voices are collected.
  update(sim, dt) {
    if (!this.enabled) return;
    if (sim && sim.player) {
      this.updateListener(sim.player.x, sim.player.y);
      if (this.ambientState === 'none' && sim.phase) this.setAmbient(sim.phase);
      const horde = sim.zombies ? sim.zombies.some((z) => z.horde && z.state !== 'dead') : false;
      if (horde && !this.hordeAlive && !this.loops.has('tension') && !sim.result) this.tensionStart();
      if (!horde && this.hordeAlive) this.stopLoop('tension');
      this.hordeAlive = horde;
    }
    const hb = this.loops.get('heartbeat'); if (hb) this.scheduleHeartbeat(hb);
    this.stepAmbient();
    const t = this.now();
    for (const v of this.voices) if (!v.loop && t > v.end + 0.1) this.kill(v);
  }
}
