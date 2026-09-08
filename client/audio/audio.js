// Competitive synthesized sound design on the Web Audio API (Quake 3 / CPMA standard). No sample assets: every cue is generated.
//
// Mix architecture:
//   source(s) -> voice gain -> [HRTF panner for world sounds] -> category bus -> master gain -> limiter -> destination
// Buses: weapons, impacts, player (own body cues), enemy (other players' body cues), items, ui, ambient.
// Every world sound uses the same distance model (inverse, refDistance 320, maxDistance 3000, rolloff 1), so a cue at
// 600 units is always -5.5 dB and at 1500 units -13.4 dB relative to point blank. Enemy cues get REMOTE_GAIN so they are
// never quieter than the same cue played for the local player (measured, see tools/audio_measure.mjs and docs/AUDIO.md).
// Loudness per cue is set by CUE_TRIM, calibrated offline by `node tools/audio_measure.mjs --calibrate`.
//
// Lifecycle: each cue is a "voice" (gain + optional panner + N scheduled sources). A voice knows the time its last source
// stops; update() garbage-collects finished voices (and onended does the same eagerly), so no node outlives its sound.
// Loops (lightning beam, rocket flight) are voices flagged loop=true and are stopped explicitly.
import { EV, WEAPONS, ITEMS } from '../../shared/constants.js';
import { angleVectors } from '../../shared/vec3.js';

export const REF_DIST = 320, MAX_DIST = 3000, ROLLOFF = 1;
export const SPEED_OF_SOUND = 3000;          // ups, for the rocket flight doppler (rocket = 900 ups -> +-0.3 octave)
export const REMOTE_GAIN = 1.35;             // spatial voices: compensates the HRTF frontal loss so enemy cues are >= own cues at equal distance
// Direction-aware EQ on spatial voices flattening Chrome's HRTF (measured per direction with `node tools/audio_measure.mjs --hrtf`,
// table in docs/AUDIO.md). Relative to a direct connection the HRTF is +3 dB below 300 Hz and -5 dB around 1 kHz from the
// front; from behind / above / below it loses a further 4-6 dB in the 2-5 kHz band that carries the locating cues (footstep
// tap, MG crack), while the near ear from the side is flat. Each spatial voice runs low shelf -> 1 kHz peak -> 3.3 kHz peak
// with gains blended from the five hemisphere entries by the source direction in the listener's frame (see dirComp()).
// Entries: [low shelf dB @250 Hz, peak dB @1 kHz, peak dB @3.3 kHz, broadband dB].
export const HRTF_COMP = {
  shelfFreq: 250, peakFreq: 1000, peakQ: 0.8, hfFreq: 3300, hfQ: 0.55,
  front: [-3, 4, 0, 0], back: [-0.5, 1.5, 7.5, 0], side: [-3, 0, 0.5, 0], above: [-2.5, 4, 5.5, 0], below: [-2, 0.5, 6.5, 0],
};
export const CEILING = 0.95;                 // soft-clip ceiling after the limiter (Chrome's compressor alone lets summed peaks exceed 0 dBFS)
export const MAX_VOICES = 48;                // oldest one-shot voice is dropped beyond this
// Damage events are voiced per tick, not per event: shared/game.js emits one EV.HIT / EV.PAIN per shotgun pellet (and per
// splash victim), so HITs per attacker and PAINs per target that arrive within one tick window are summed into a single
// damage-scaled hit tone and a single pain grunt (Q3/CPMA play exactly one per blast). Queued in event(), flushed in update().
export const COALESCE_WINDOW = 1 / 60;
// Pain grunts are further debounced per target like Q3 (g_active.c P_DamageFeedback: pain_debounce_time = level.time + 700):
// the first PAIN in a window is voiced at once, later ones inside the window are silent and only lower the health the next
// grunt will be voiced with (so the tier still escalates). Hit tones are NOT debounced (CPMA: one per damage tick), so a
// lightning beam still ticks 20 times a second in the attacker's ears while the victim grunts at most every 700 ms.
export const PAIN_DEBOUNCE = 0.7;
export const BUS_LEVELS = { weapons: 1.0, impacts: 1.0, player: 1.0, enemy: 1.0, items: 1.0, ui: 1.0, ambient: 1.0 };
// Safety limiter only: cues are trimmed to peak <= -6 dBFS pre-limiter so a single cue never reaches the threshold (no pumping);
// it only catches the sum of simultaneous cues (rocket + rail + pain + hit tone...).
export const LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.001, release: 0.1 };

// Per-cue linear gain trims (calibrated so every weapon fire peaks at -6.5 dBFS +-3 post-limiter at the listener, <= -6 dBFS
// pre-limiter for own and point-blank enemy variants; see docs/AUDIO.md).
export const CUE_TRIM = {
  machinegunFire: 0.257, shotgunFire: 0.247, rocketFire: 0.253, lightningLoop: 0.274, railFire: 0.164, plasmaFire: 0.466, gauntletFire: 0.322,
  rocketLoop: 0.127, rocketExplode: 0.251, plasmaExplode: 0.176, bulletImpact: 0.116, railImpact: 0.132, gauntletImpact: 0.165, lgHit: 0.273,
  jump: 0.402, landSoft: 0.106, landHard: 0.208, footstep: 0.215, painLight: 0.596, painMid: 0.594, painHeavy: 0.621, painCritical: 0.679, death: 0.618, gib: 0.271,
  pickupHealth: 0.197, pickupMega: 0.254, pickupArmor: 0.176, pickupWeapon: 0.357, pickupAmmo: 0.284, respawnMajor: 0.27, respawnMinor: 0.084,
  jumppad: 0.274, teleport: 0.347,
  hitTone: 0.295, weaponChange: 0.213, noAmmo: 0.236, countdown: 0.258, fight: 0.22, win: 0.327, lose: 0.531, alert: 0.521,
  ambient: 0.024,
};

const T = CUE_TRIM;
// Events voiced at the emitting player's position (as opposed to at e.origin of a world point): dropped for a remote player
// whose position is unknown, see event().
const BODY_EVENTS = new Set([EV.FIRE, EV.PAIN, EV.DEATH, EV.JUMP, EV.LAND, EV.FOOTSTEP, EV.PICKUP, EV.JUMPPAD, EV.TELEPORT, EV.RESPAWN]);

export class AudioEngine {
  // opts: { context: existing (Offline)AudioContext, ambient: true, limiter: true, seed: number for deterministic randomness }
  constructor(opts = {}) {
    this.opts = { ambient: true, limiter: true, ...opts };
    this.ctx = null; this.enabled = false; this.volume = 0.8;
    this.listenerPos = [0, 0, 0]; this.listenerVel = [0, 0, 0]; this.listenerT = 0;
    this.listenerAxes = { forward: [1, 0, 0], right: [0, -1, 0], up: [0, 0, 1] };
    this.voices = new Set(); this.rocketLoops = new Map(); this.lgLoops = new Map(); this.ambientVoice = null;
    this.counters = { created: 0, killed: 0, spatial: 0, dropped: 0 };   // spatial: voices with a panner; dropped: remote body cues whose origin could not be resolved
    this.lastFootstep = new Map();
    this.lastOrigin = new Map();   // player id -> last origin seen in any event or snapshot (fallback for body cues of a player missing from cg.remote)
    this.pendingHits = new Map(); this.pendingPain = new Map();   // per-tick damage coalescing (see COALESCE_WINDOW)
    this.painDebounce = new Map();  // target id -> { t: time of the last voiced grunt, health: lowest health seen since (pending tier escalation) }
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
      // soft clipper: identity below the knee (0.6 = -4.4 dBFS), tanh knee above it, asymptote CEILING; inputs beyond full scale clamp at ~-1 dBFS
      const clip = ctx.createWaveShaper(); const n = 2049; const curve = new Float32Array(n); const knee = 0.6;
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; const a = Math.abs(x); curve[i] = Math.sign(x) * (a <= knee ? a : knee + (CEILING - knee) * Math.tanh((a - knee) / (CEILING - knee))); }
      clip.curve = curve; clip.oversample = '2x';
      this.limiter = c; this.clipper = clip; this.master.connect(c); c.connect(clip); clip.connect(ctx.destination);
    } else { this.limiter = null; this.master.connect(ctx.destination); }
    this.bus = {};
    for (const [name, g] of Object.entries(BUS_LEVELS)) { const b = ctx.createGain(); b.gain.value = g; b.connect(this.master); this.bus[name] = b; }
    this.noiseBuf = this.makeNoise(2);
    this.enabled = true;
    if (this.opts.ambient) this.ambient();
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume(); }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }
  close() {
    if (!this.ctx) return;
    for (const l of this.lgLoops.values()) l.stop(); this.lgLoops.clear();
    for (const l of this.rocketLoops.values()) l.stop(); this.rocketLoops.clear();
    if (this.ambientVoice) { this.ambientVoice.stop(); this.ambientVoice = null; }
    for (const v of [...this.voices]) this.kill(v);
    this.pendingHits.clear(); this.pendingPain.clear(); this.painDebounce.clear(); this.lastOrigin.clear(); this.lastFootstep.clear();
    if (this.ctx.close && !this.opts.context) this.ctx.close();
    this.enabled = false;
  }
  now() { return this.ctx.currentTime; }
  // Diagnostics for tests: live voice/loop counts and context state. voices must return to 0 after every cue ends.
  stats() {
    let oldest = 0; if (this.ctx) for (const v of this.voices) if (!v.loop) oldest = Math.max(oldest, this.ctx.currentTime - v.born);
    return { state: this.ctx ? this.ctx.state : 'none', voices: this.voices.size, loops: this.lgLoops.size + this.rocketLoops.size, oldest: +oldest.toFixed(2), created: this.counters.created, killed: this.counters.killed, spatial: this.counters.spatial, dropped: this.counters.dropped, reduction: this.limiter ? this.limiter.reduction : 0 };
  }

  makeNoise(seconds) {
    const n = Math.floor(this.ctx.sampleRate * seconds); const b = this.ctx.createBuffer(1, n, this.ctx.sampleRate); const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = this.rand() * 2 - 1; return b;
  }

  // ---------- listener ----------
  updateListener(eye, angles) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dt = t - this.listenerT;
    if (dt > 0.004 && dt < 0.25) this.listenerVel = [(eye[0] - this.listenerPos[0]) / dt, (eye[1] - this.listenerPos[1]) / dt, (eye[2] - this.listenerPos[2]) / dt];
    this.listenerPos = [eye[0], eye[1], eye[2]]; this.listenerT = t;
    const av = angleVectors(angles);
    this.listenerAxes = av;
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.setValueAtTime(eye[0], t); l.positionY.setValueAtTime(eye[1], t); l.positionZ.setValueAtTime(eye[2], t);
      l.forwardX.setValueAtTime(av.forward[0], t); l.forwardY.setValueAtTime(av.forward[1], t); l.forwardZ.setValueAtTime(av.forward[2], t);
      l.upX.setValueAtTime(av.up[0], t); l.upY.setValueAtTime(av.up[1], t); l.upZ.setValueAtTime(av.up[2], t);
    } else { l.setPosition(eye[0], eye[1], eye[2]); l.setOrientation(av.forward[0], av.forward[1], av.forward[2], av.up[0], av.up[1], av.up[2]); }
  }

  // ---------- voices ----------
  // A voice is the output stage of one cue: gain -> (HRTF panner) -> bus. opts: local (non-spatial), gain, ref, rolloff, maxDist, loop.
  voice(bus, origin, o = {}) {
    const ctx = this.ctx;
    const spatial = !!origin && !o.local;
    const g = ctx.createGain(); g.gain.value = (o.gain ?? 1) * (spatial ? REMOTE_GAIN : 1);
    const v = { in: g, panner: null, end: 0, pending: 0, loop: !!o.loop, dead: false, born: ctx.currentTime, bus, baseGain: g.gain.value };
    if (spatial) {
      const p = ctx.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = o.ref ?? REF_DIST; p.maxDistance = o.maxDist ?? MAX_DIST; p.rolloffFactor = o.rolloff ?? ROLLOFF;
      const shelf = ctx.createBiquadFilter(); shelf.type = 'lowshelf'; shelf.frequency.value = HRTF_COMP.shelfFreq;
      const eq = ctx.createBiquadFilter(); eq.type = 'peaking'; eq.frequency.value = HRTF_COMP.peakFreq; eq.Q.value = HRTF_COMP.peakQ;
      const hf = ctx.createBiquadFilter(); hf.type = 'peaking'; hf.frequency.value = HRTF_COMP.hfFreq; hf.Q.value = HRTF_COMP.hfQ;
      g.connect(shelf); shelf.connect(eq); eq.connect(hf); hf.connect(p); p.connect(this.bus[bus]); v.panner = p; v.eq = eq; v.shelf = shelf; v.hf = hf;
      this.place(v, origin, false); this.counters.spatial++;
    } else g.connect(this.bus[bus]);
    this.voices.add(v); this.counters.created++;
    if (this.voices.size > MAX_VOICES) { let oldest = null; for (const x of this.voices) if (!x.loop && (!oldest || x.born < oldest.born)) oldest = x; if (oldest) this.kill(oldest); }
    return v;
  }
  // HRTF compensation for a source at `origin`: blend of the HRTF_COMP hemisphere entries weighted by the direction's
  // components in the listener's frame (front/back by the forward component, side by |right|, above/below by the up
  // component), normalized so an axis-aligned source gets exactly its entry. Returns [shelf dB, 1 kHz dB, 3.3 kHz dB, broadband dB].
  dirComp(origin) {
    const C = HRTF_COMP, L = this.listenerPos, A = this.listenerAxes;
    const dx = origin[0] - L[0], dy = origin[1] - L[1], dz = origin[2] - L[2]; const d = Math.hypot(dx, dy, dz);
    if (d < 1) return C.front;
    const f = (dx * A.forward[0] + dy * A.forward[1] + dz * A.forward[2]) / d, r = Math.abs(dx * A.right[0] + dy * A.right[1] + dz * A.right[2]) / d, u = (dx * A.up[0] + dy * A.up[1] + dz * A.up[2]) / d;
    const w = [[C.front, Math.max(0, f)], [C.back, Math.max(0, -f)], [C.side, r], [C.above, Math.max(0, u)], [C.below, Math.max(0, -u)]];
    const sum = w.reduce((s, [, k]) => s + k, 0) || 1;
    return [0, 1, 2, 3].map((i) => w.reduce((s, [e, k]) => s + e[i] * k, 0) / sum);
  }
  // Move a spatial voice: panner position plus the direction-dependent compensation (smooth = loops that follow a moving source).
  place(v, origin, smooth = true) {
    const p = v.panner, t = this.ctx.currentTime;
    if (p.positionX) {
      if (smooth) { p.positionX.setTargetAtTime(origin[0], t, 0.02); p.positionY.setTargetAtTime(origin[1], t, 0.02); p.positionZ.setTargetAtTime(origin[2], t, 0.02); }
      else { p.positionX.setValueAtTime(origin[0], t); p.positionY.setValueAtTime(origin[1], t); p.positionZ.setValueAtTime(origin[2], t); }
    } else p.setPosition(origin[0], origin[1], origin[2]);
    const [shelf, peak, hf, bb] = this.dirComp(origin); const gain = v.baseGain * Math.pow(10, bb / 20);
    if (smooth) { v.shelf.gain.setTargetAtTime(shelf, t, 0.02); v.eq.gain.setTargetAtTime(peak, t, 0.02); v.hf.gain.setTargetAtTime(hf, t, 0.02); v.in.gain.setTargetAtTime(gain, t, 0.02); }
    else { v.shelf.gain.value = shelf; v.eq.gain.value = peak; v.hf.gain.value = hf; v.in.gain.value = gain; }
  }
  kill(v) {
    if (v.dead) return; v.dead = true;
    try { v.in.disconnect(); if (v.shelf) v.shelf.disconnect(); if (v.eq) v.eq.disconnect(); if (v.hf) v.hf.disconnect(); if (v.panner) v.panner.disconnect(); } catch {}
    this.voices.delete(v); this.counters.killed++;
  }
  // Register a scheduled source on a voice: the voice dies when its last source ends (onended) or, failing that, when update() sees v.end passed.
  track(v, node, t1) {
    v.pending++; v.end = Math.max(v.end, t1);
    node.onended = () => { v.pending--; if (!v.loop && v.pending <= 0) this.kill(v); };
    return node;
  }
  // Saturation stage inside a voice (for thumps/blasts): returns the node sources should connect to. level scales the saturated
  // output (a saturated group otherwise always peaks near 1, whatever its input level).
  drive(v, amount = 2, level = 1) {
    const ctx = this.ctx; const ws = ctx.createWaveShaper(); const n = 1024; const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * amount) / Math.tanh(amount); }
    ws.curve = curve; ws.oversample = '2x';
    if (level !== 1) { const g = ctx.createGain(); g.gain.value = level; ws.connect(g); g.connect(v.in); } else ws.connect(v.in);
    return ws;
  }
  // Amplitude envelope: 0 -> peak over attack, hold, then exponential decay to silence at t1.
  env(param, t0, t1, peak, attack = 0.005, hold = 0) {
    param.setValueAtTime(0, t0); param.linearRampToValueAtTime(peak, t0 + attack);
    const th = Math.min(t1 - 0.001, t0 + attack + hold); if (hold > 0) param.setValueAtTime(peak, th);
    param.exponentialRampToValueAtTime(0.0005, t1);
  }
  // Oscillator source. o: peak, attack, hold, f1 (exponential glide to f1 at t1 or after o.sweep seconds), detune, vib {rate, depth}, dest.
  osc(v, type, f0, t0, t1, o = {}) {
    const ctx = this.ctx; const s = ctx.createOscillator(); s.type = type; s.frequency.setValueAtTime(f0, t0);
    if (o.f1) s.frequency.exponentialRampToValueAtTime(o.f1, o.sweep ? t0 + o.sweep : t1);
    if (o.detune) s.detune.value = o.detune;
    if (o.vib) { const l = ctx.createOscillator(); l.frequency.value = o.vib.rate; const lg = ctx.createGain(); lg.gain.value = o.vib.depth; l.connect(lg); lg.connect(s.frequency); l.start(t0); l.stop(t1 + 0.02); }
    const g = ctx.createGain(); this.env(g.gain, t0, t1, o.peak ?? 1, o.attack ?? 0.005, o.hold ?? 0);
    s.connect(g); g.connect(o.dest || v.in); s.start(t0); s.stop(t1 + 0.02); this.track(v, s, t1 + 0.02); return s;
  }
  // Filtered noise source. o: type, freq, freqEnd, q, peak, attack, hold, rate (playbackRate), dest.
  noise(v, t0, t1, o = {}) {
    const ctx = this.ctx; const s = ctx.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true; s.loopStart = this.rand() * 1.5; if (o.rate) s.playbackRate.value = o.rate;
    const f = ctx.createBiquadFilter(); f.type = o.type || 'lowpass'; f.frequency.setValueAtTime(o.freq ?? 2000, t0); if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(o.freqEnd, t1); f.Q.value = o.q ?? 0.7;
    const g = ctx.createGain(); this.env(g.gain, t0, t1, o.peak ?? 1, o.attack ?? 0.003, o.hold ?? 0);
    s.connect(f); f.connect(g); g.connect(o.dest || v.in); s.start(t0, s.loopStart); s.stop(t1 + 0.02); this.track(v, s, t1 + 0.02); return s;
  }
  // Vocal grunt: sawtooth glide through three parallel formant filters (throat/mouth resonances). fm0 -> fm1 formant sets.
  grunt(v, t0, t1, o) {
    const ctx = this.ctx; const mix = ctx.createGain(); mix.gain.value = o.peak ?? 1; mix.connect(o.dest || v.in);
    const src = ctx.createOscillator(); src.type = 'sawtooth'; src.frequency.setValueAtTime(o.f0, t0); src.frequency.exponentialRampToValueAtTime(o.f1, t1);
    if (o.vib) { const l = ctx.createOscillator(); l.frequency.value = o.vib.rate; const lg = ctx.createGain(); lg.gain.value = o.vib.depth; l.connect(lg); lg.connect(src.frequency); l.start(t0); l.stop(t1 + 0.02); }
    const g = ctx.createGain(); this.env(g.gain, t0, t1, 1, o.attack ?? 0.02, o.hold ?? 0); src.connect(g);
    const fm0 = o.formants || [650, 1100, 2500], fm1 = o.formantsEnd || fm0;
    fm0.forEach((fq, i) => { const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 6; f.frequency.setValueAtTime(fq, t0); f.frequency.exponentialRampToValueAtTime(fm1[i], t1); const fg = ctx.createGain(); fg.gain.value = i === 0 ? 1 : i === 1 ? 0.6 : 0.3; g.connect(f); f.connect(fg); fg.connect(mix); });
    // breath: bandpassed noise under the voice
    this.noise(v, t0, t1, { type: 'bandpass', freq: 1600, q: 0.8, peak: (o.breath ?? 0.2), attack: o.attack ?? 0.02, dest: mix });
    src.start(t0); src.stop(t1 + 0.02); this.track(v, src, t1 + 0.02);
  }
  // Random short noise bursts between t0 and t1 (crackle, debris).
  crackle(v, t0, t1, n, o = {}) {
    for (let i = 0; i < n; i++) { const a = t0 + this.rand() * (t1 - t0); const d = (o.min ?? 0.008) + this.rand() * (o.max ?? 0.02); this.noise(v, a, a + d, { type: o.type || 'highpass', freq: (o.freq ?? 1800) * (0.7 + this.rand() * 0.8), q: o.q ?? 0.7, peak: (o.peak ?? 0.4) * (0.5 + this.rand() * 0.5), attack: 0.001, dest: o.dest }); }
  }

  // ---------- weapons ----------
  fire(w, origin, local) {
    switch (w) {
      case WEAPONS.ROCKET: return this.rocketFire(origin, local);
      case WEAPONS.RAIL: return this.railFire(origin, local);
      case WEAPONS.LIGHTNING: return null; // continuous: handled by lgStart via event()
      case WEAPONS.SHOTGUN: return this.shotgunFire(origin, local);
      case WEAPONS.PLASMA: return this.plasmaFire(origin, local);
      case WEAPONS.MACHINEGUN: return this.machinegunFire(origin, local);
      case WEAPONS.GAUNTLET: return this.gauntletFire(origin, local);
    }
    return null;
  }
  // Weapon fires are mixed "identity first": the layer that names the weapon (MG crack 0.8-3 kHz, rail ring 1.2-3.5 kHz,
  // SG blast 0.3-2 kHz, rocket whoosh, plasma bloop, gauntlet motor) is the loudest and longest one, and the sub thump is
  // support at -8..-12 dB under it. Reason: distance attenuation and A-weighting both act on the mid band, so the cue must
  // stay identifiable at 600-1500 units and the seven fires must sit within +-3 dB(A) of each other (asserted by
  // tools/audio_measure.mjs: A-weighted momentary level and < 50 % energy below 300 Hz for MG/RG/SG/PG).
  // Rocket: ignition crack, rising saturated whoosh as the missile leaves (the identity), deep thump underneath.
  rocketFire(origin, local) {
    const v = this.voice('weapons', origin, { local, gain: T.rocketFire }); const t = this.now(); const sub = this.drive(v, 2.5, 0.6), mid = this.drive(v, 3);
    this.noise(v, t, t + 0.03, { type: 'highpass', freq: 1800, peak: 0.6, attack: 0.001 });
    this.noise(v, t, t + 0.42, { type: 'bandpass', freq: 500, freqEnd: 2600, q: 1, peak: 1, attack: 0.015, hold: 0.16, dest: mid });
    this.noise(v, t + 0.01, t + 0.36, { type: 'bandpass', freq: 1400, q: 0.6, peak: 0.7, attack: 0.02, hold: 0.14, dest: mid });
    this.osc(v, 'sine', 95, t, t + 0.3, { f1: 36, peak: 0.45, attack: 0.003, dest: sub });
    this.osc(v, 'triangle', 62, t, t + 0.2, { f1: 30, peak: 0.25, dest: sub });
    this.noise(v, t, t + 0.25, { type: 'lowpass', freq: 800, freqEnd: 120, peak: 0.4, attack: 0.002, dest: sub });
    return v;
  }
  // Rail: rising charge whine, crack, then a long inharmonic metallic ring (the identity: 1.2-3.5 kHz partials held then decaying).
  railFire(origin, local) {
    const v = this.voice('weapons', origin, { local, gain: T.railFire }); const t = this.now(); const sub = this.drive(v, 2, 0.5);
    this.osc(v, 'sawtooth', 320, t, t + 0.1, { f1: 2800, peak: 0.35, attack: 0.07, sweep: 0.09 });
    this.noise(v, t + 0.085, t + 0.125, { type: 'highpass', freq: 2500, peak: 1.2, attack: 0.001 });
    this.noise(v, t + 0.085, t + 0.35, { type: 'bandpass', freq: 1800, freqEnd: 500, q: 1, peak: 0.6, attack: 0.002, hold: 0.03 });
    this.osc(v, 'sine', 130, t + 0.085, t + 0.3, { f1: 48, peak: 0.3, attack: 0.002, dest: sub });
    const ring = [[1180, 0.8, 0.8], [1770, 0.6, 0.72], [2650, 0.45, 0.62], [3540, 0.3, 0.5]];
    for (const [f, a, dur] of ring) this.osc(v, 'sine', f, t + 0.09, t + 0.09 + dur, { peak: a, attack: 0.003, hold: dur * 0.4, detune: (this.rand() - 0.5) * 12 });
    return v;
  }
  // Shotgun: wide saturated mid blast (0.3-2 kHz, the identity) over a low boom, then a two-click pump at +0.24 s.
  shotgunFire(origin, local) {
    const v = this.voice('weapons', origin, { local, gain: T.shotgunFire }); const t = this.now(); const blast = this.drive(v, 3), sub = this.drive(v, 2, 0.5);
    this.noise(v, t, t + 0.24, { type: 'bandpass', freq: 1300, freqEnd: 350, q: 0.5, peak: 1, attack: 0.002, hold: 0.15, dest: blast });
    this.noise(v, t, t + 0.06, { type: 'highpass', freq: 3000, peak: 0.5, attack: 0.001 });
    this.noise(v, t, t + 0.2, { type: 'lowpass', freq: 900, freqEnd: 200, peak: 0.45, attack: 0.002, hold: 0.05, dest: sub });
    this.osc(v, 'sine', 120, t, t + 0.18, { f1: 42, peak: 0.35, attack: 0.002, dest: sub });
    this.noise(v, t + 0.24, t + 0.27, { type: 'bandpass', freq: 2200, q: 3, peak: 0.45, attack: 0.001 });
    this.osc(v, 'triangle', 700, t + 0.24, t + 0.29, { f1: 300, peak: 0.2, attack: 0.001 });
    this.noise(v, t + 0.31, t + 0.35, { type: 'bandpass', freq: 1500, q: 3, peak: 0.4, attack: 0.001 });
    this.osc(v, 'square', 420, t + 0.31, t + 0.36, { peak: 0.1, attack: 0.001 });
    return v;
  }
  // Plasma: rapid "bloop" — held sine glide down with a square overtone; the 4.5 kHz tick sets the peak.
  plasmaFire(origin, local) {
    const v = this.voice('weapons', origin, { local, gain: T.plasmaFire }); const t = this.now();
    this.osc(v, 'sine', 1150, t, t + 0.085, { f1: 330, peak: 0.42, attack: 0.002, hold: 0.04 });
    this.osc(v, 'square', 580, t, t + 0.06, { f1: 220, peak: 0.15, attack: 0.002, hold: 0.02 });
    this.noise(v, t, t + 0.02, { type: 'bandpass', freq: 4500, q: 2, peak: 1, attack: 0.001 });
    return v;
  }
  // Machinegun: tight tick — crack transient + saturated 0.8-3 kHz body (the identity), tiny thump under it. < 90 ms so 10 Hz fire stays crisp.
  machinegunFire(origin, local) {
    const v = this.voice('weapons', origin, { local, gain: T.machinegunFire }); const t = this.now(); const body = this.drive(v, 3);
    this.noise(v, t, t + 0.012, { type: 'highpass', freq: 2200, peak: 1.3, attack: 0.0005 });
    this.noise(v, t, t + 0.065, { type: 'bandpass', freq: 1700, q: 0.8, peak: 1, attack: 0.001, hold: 0.035, dest: body });
    this.noise(v, t + 0.005, t + 0.075, { type: 'bandpass', freq: 900, q: 1, peak: 0.5, attack: 0.002, hold: 0.03 });
    this.osc(v, 'sine', 200, t, t + 0.045, { f1: 90, peak: 0.3, attack: 0.001 });
    return v;
  }
  // Gauntlet: motor spin-up — saturated 550->800 Hz sawtooth whine with vibrato (the identity), a quiet 140 Hz sawtooth for the
  // mechanical body, and a 3.2 kHz metallic whir.
  gauntletFire(origin, local) {
    const v = this.voice('weapons', origin, { local, gain: T.gauntletFire }); const t = this.now(); const motor = this.drive(v, 3, 0.55);
    this.osc(v, 'sawtooth', 550, t, t + 0.2, { f1: 800, peak: 1, attack: 0.015, hold: 0.1, sweep: 0.16, vib: { rate: 38, depth: 40 }, dest: motor });
    this.osc(v, 'sawtooth', 140, t, t + 0.2, { f1: 200, peak: 0.15, attack: 0.01, hold: 0.1, vib: { rate: 38, depth: 20 } });
    this.noise(v, t, t + 0.18, { type: 'bandpass', freq: 3200, q: 2, peak: 0.9, attack: 0.01, hold: 0.06 });
    this.noise(v, t, t + 0.16, { type: 'bandpass', freq: 1500, q: 1, peak: 0.3, attack: 0.01, hold: 0.06 });
    return v;
  }
  // Lightning: continuous buzz (low saw through a swept bandpass + noise-FM square) with gated crackle. One loop per shooter.
  lgStart(id, origin, local) {
    const ctx = this.ctx, t = this.now();
    let l = this.lgLoops.get(id);
    if (!l) {
      const v = this.voice('weapons', origin, { local, gain: T.lightningLoop, loop: true });
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.02); g.connect(this.drive(v, 2)); // saturated: buzz crest ~9 dB like the other fires
      const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 62;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 2;
      const lfo = ctx.createOscillator(); lfo.type = 'triangle'; lfo.frequency.value = 9; const lg = ctx.createGain(); lg.gain.value = 500; lfo.connect(lg); lg.connect(bp.frequency);
      const g1 = ctx.createGain(); g1.gain.value = 0.6; o1.connect(bp); bp.connect(g1); g1.connect(g);
      const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 1350;
      const fmN = ctx.createBufferSource(); fmN.buffer = this.noiseBuf; fmN.loop = true; const fmF = ctx.createBiquadFilter(); fmF.type = 'lowpass'; fmF.frequency.value = 60; const fmG = ctx.createGain(); fmG.gain.value = 900; fmN.connect(fmF); fmF.connect(fmG); fmG.connect(o2.frequency);
      const g2 = ctx.createGain(); g2.gain.value = 0.18; const hp2 = ctx.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = 700; o2.connect(hp2); hp2.connect(g2); g2.connect(g);
      const cr = ctx.createBufferSource(); cr.buffer = this.noiseBuf; cr.loop = true; const crF = ctx.createBiquadFilter(); crF.type = 'highpass'; crF.frequency.value = 3000;
      const gate = ctx.createGain(); gate.gain.value = 0.3; const gl = ctx.createOscillator(); gl.type = 'square'; gl.frequency.value = 41; const glg = ctx.createGain(); glg.gain.value = 0.3; gl.connect(glg); glg.connect(gate.gain);
      cr.connect(crF); crF.connect(gate); gate.connect(g);
      const nodes = [o1, lfo, o2, fmN, cr, gl]; for (const n of nodes) { n.start(t); this.track(v, n, Infinity); }
      l = { v, last: t, stop: () => { const t2 = this.now(); g.gain.cancelScheduledValues(t2); g.gain.setValueAtTime(g.gain.value, t2); g.gain.linearRampToValueAtTime(0, t2 + 0.04); for (const n of nodes) n.stop(t2 + 0.06); v.loop = false; v.end = t2 + 0.06; } };
      this.lgLoops.set(id, l);
    }
    l.last = t;
    if (l.v.panner && origin) this.place(l.v, origin);
    return l.v;
  }
  // Rocket in flight: rumbling hiss loop following the projectile, pitch-shifted by radial velocity (doppler).
  rocketLoopStart(id, origin, velocity) {
    const ctx = this.ctx, t = this.now();
    const v = this.voice('weapons', origin, { gain: T.rocketLoop, loop: true });
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.06); g.connect(v.in);
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true; const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 420; f.Q.value = 0.9;
    const wob = ctx.createOscillator(); wob.frequency.value = 17; const wg = ctx.createGain(); wg.gain.value = 120; wob.connect(wg); wg.connect(f.frequency);
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 58; const of = ctx.createBiquadFilter(); of.type = 'lowpass'; of.frequency.value = 300; const og = ctx.createGain(); og.gain.value = 0.5;
    n.connect(f); f.connect(g); o.connect(of); of.connect(og); og.connect(g);
    for (const s of [n, wob, o]) { s.start(t); this.track(v, s, Infinity); }
    const loop = { v, n, o, velocity: velocity || [0, 0, 0], stop: () => { const t2 = this.now(); g.gain.cancelScheduledValues(t2); g.gain.setValueAtTime(g.gain.value, t2); g.gain.linearRampToValueAtTime(0, t2 + 0.03); for (const s of [n, wob, o]) s.stop(t2 + 0.05); v.loop = false; v.end = t2 + 0.05; } };
    this.rocketLoops.set(id, loop);
    return loop;
  }
  dopplerFactor(origin, velocity) {
    const dx = origin[0] - this.listenerPos[0], dy = origin[1] - this.listenerPos[1], dz = origin[2] - this.listenerPos[2];
    const d = Math.hypot(dx, dy, dz); if (d < 1) return 1;
    const nx = dx / d, ny = dy / d, nz = dz / d;
    const vr = this.listenerVel[0] * nx + this.listenerVel[1] * ny + this.listenerVel[2] * nz;      // listener toward source (+)
    const vs = velocity[0] * nx + velocity[1] * ny + velocity[2] * nz;                                // source away from listener (+)
    return Math.max(0.6, Math.min(1.6, (SPEED_OF_SOUND + vr) / (SPEED_OF_SOUND + vs)));
  }

  // ---------- impacts ----------
  explode(w, origin) { return w === WEAPONS.ROCKET ? this.rocketExplode(origin) : this.plasmaExplode(origin); }
  // Rocket explosion: saturated sub impact, crack, mid body sweep, debris crackle, long low tail.
  rocketExplode(origin) {
    const v = this.voice('impacts', origin, { gain: T.rocketExplode }); const t = this.now(); const d = this.drive(v, 3);
    this.osc(v, 'sine', 66, t, t + 0.55, { f1: 28, peak: 1, attack: 0.003, dest: d });
    this.osc(v, 'triangle', 44, t + 0.01, t + 0.9, { f1: 24, peak: 0.6, attack: 0.01, dest: d });
    this.noise(v, t, t + 0.04, { type: 'highpass', freq: 2500, peak: 1, attack: 0.001 });
    this.noise(v, t, t + 0.7, { type: 'lowpass', freq: 3000, freqEnd: 90, peak: 1, attack: 0.002, dest: d });
    this.crackle(v, t + 0.04, t + 0.6, 10, { freq: 1800, peak: 0.45 });
    this.noise(v, t + 0.05, t + 1.5, { type: 'lowpass', freq: 350, freqEnd: 70, peak: 0.45, attack: 0.08 });
    return v;
  }
  plasmaExplode(origin) {
    const v = this.voice('impacts', origin, { gain: T.plasmaExplode }); const t = this.now();
    this.noise(v, t, t + 0.07, { type: 'bandpass', freq: 1800, q: 1.2, peak: 0.9, attack: 0.001 });
    this.osc(v, 'sine', 520, t, t + 0.06, { f1: 180, peak: 0.6, attack: 0.001 });
    return v;
  }
  impact(w, origin) {
    if (w === WEAPONS.RAIL) return this.railImpact(origin);
    if (w === WEAPONS.GAUNTLET) return this.gauntletImpact(origin);
    return this.bulletImpact(origin);
  }
  bulletImpact(origin) {
    const v = this.voice('impacts', origin, { gain: T.bulletImpact }); const t = this.now();
    this.noise(v, t, t + 0.035, { type: 'highpass', freq: 2500, peak: 1, attack: 0.0005 });
    this.osc(v, 'sine', 1800 + this.rand() * 1400, t, t + 0.03, { peak: 0.3, attack: 0.001 });
    return v;
  }
  railImpact(origin) {
    const v = this.voice('impacts', origin, { gain: T.railImpact }); const t = this.now();
    this.noise(v, t, t + 0.05, { type: 'highpass', freq: 1800, peak: 1, attack: 0.001 });
    this.osc(v, 'sine', 950, t, t + 0.3, { f1: 700, peak: 0.5, attack: 0.001 });
    this.osc(v, 'sine', 1900, t, t + 0.2, { peak: 0.25, attack: 0.001 });
    return v;
  }
  gauntletImpact(origin) {
    const v = this.voice('impacts', origin, { gain: T.gauntletImpact }); const t = this.now();
    this.noise(v, t, t + 0.03, { type: 'bandpass', freq: 3000, q: 1, peak: 0.8, attack: 0.001 });
    this.osc(v, 'sine', 1400, t, t + 0.12, { peak: 0.5, attack: 0.001 }); this.osc(v, 'sine', 2130, t, t + 0.09, { peak: 0.3, attack: 0.001 });
    return v;
  }
  // Lightning hit sizzle: bright noise + downward chirp.
  lgHit(origin) {
    const v = this.voice('impacts', origin, { gain: T.lgHit }); const t = this.now();
    this.noise(v, t, t + 0.06, { type: 'bandpass', freq: 4500, q: 1, peak: 1, attack: 0.001 });
    this.osc(v, 'square', 3200, t, t + 0.04, { f1: 1400, peak: 0.25, attack: 0.001 });
    return v;
  }

  // ---------- player body cues ----------
  bodyBus(local) { return local ? 'player' : 'enemy'; }
  jump(origin, local) {
    const v = this.voice(this.bodyBus(local), origin, { local, gain: T.jump }); const t = this.now();
    this.grunt(v, t, t + 0.14, { f0: 200, f1: 150, formants: [650, 1150, 2500], formantsEnd: [500, 900, 2300], peak: 1, attack: 0.012, breath: 0.25 });
    this.noise(v, t, t + 0.05, { type: 'bandpass', freq: 1100, q: 1, peak: 0.25, attack: 0.002 });
    return v;
  }
  land(origin, local, hard) {
    const v = this.voice(this.bodyBus(local), origin, { local, gain: hard ? T.landHard : T.landSoft }); const t = this.now(); const d = this.drive(v, 2);
    this.noise(v, t, t + (hard ? 0.16 : 0.07), { type: 'lowpass', freq: hard ? 700 : 900, freqEnd: 90, peak: 1, attack: 0.002, dest: d });
    this.osc(v, 'sine', hard ? 85 : 120, t, t + (hard ? 0.14 : 0.08), { f1: 45, peak: 0.8, attack: 0.002, dest: d });
    if (hard) this.grunt(v, t + 0.02, t + 0.24, { f0: 150, f1: 95, formants: [550, 1000, 2400], peak: 0.7, attack: 0.02, breath: 0.3 });
    return v;
  }
  // Footstep: bright "tap" transient (3-4.5 kHz, where the HRTF gives 12-18 dB of interaural level difference so the step is
  // located) plus a quieter heel thud; pitch randomized per step. Same distance model as everything else so it stays audible at 600+ units.
  footstep(origin, local) {
    const v = this.voice(this.bodyBus(local), origin, { local, gain: T.footstep }); const t = this.now(); const r = this.rand();
    this.noise(v, t, t + 0.018, { type: 'bandpass', freq: 3200 + r * 1300, q: 1.5, peak: 1, attack: 0.0007, hold: 0.003 });
    this.noise(v, t, t + 0.03, { type: 'bandpass', freq: 1800, q: 1, peak: 0.5, attack: 0.001 });
    this.noise(v, t, t + 0.045, { type: 'lowpass', freq: 500, freqEnd: 150, peak: 0.35, attack: 0.002 });
    this.osc(v, 'sine', 150 + r * 50, t, t + 0.04, { f1: 70, peak: 0.25, attack: 0.001 });
    return v;
  }
  // Pain in four tiers by remaining health (Q3 pain100/75/50/25): light (>= 75), mid (50-74), heavy (25-49), critical (< 25):
  // lower, longer and shakier as health drops. `id` is the grunting player (unused here; read by the live audit's instrumentation).
  pain(origin, local, health, id) {
    const tier = health < 25 ? 3 : health < 50 ? 2 : health < 75 ? 1 : 0;
    const v = this.voice(this.bodyBus(local), origin, { local, gain: [T.painLight, T.painMid, T.painHeavy, T.painCritical][tier] }); const t = this.now();
    if (tier === 0) this.grunt(v, t, t + 0.18, { f0: 250, f1: 190, formants: [700, 1200, 2600], formantsEnd: [550, 950, 2300], peak: 1, attack: 0.01, breath: 0.25 });
    else if (tier === 1) this.grunt(v, t, t + 0.26, { f0: 228, f1: 165, formants: [680, 1150, 2550], formantsEnd: [500, 900, 2250], peak: 1, attack: 0.012, breath: 0.28 });
    else if (tier === 2) this.grunt(v, t, t + 0.34, { f0: 205, f1: 130, formants: [650, 1100, 2500], formantsEnd: [450, 850, 2200], peak: 1, attack: 0.015, breath: 0.3, vib: { rate: 16, depth: 8 } });
    else this.grunt(v, t, t + 0.48, { f0: 165, f1: 95, formants: [600, 1000, 2400], formantsEnd: [400, 750, 2100], peak: 1, attack: 0.02, breath: 0.35, vib: { rate: 22, depth: 14 } });
    return v;
  }
  death(origin, local, gib) {
    const v = this.voice(this.bodyBus(local), origin, { local, gain: gib ? T.gib : T.death }); const t = this.now();
    if (gib) {
      // wet splat: bubbling lowpass noise with fast amplitude wobble + meaty pops
      const d = this.drive(v, 2.5);
      this.noise(v, t, t + 0.4, { type: 'lowpass', freq: 1100, freqEnd: 180, q: 1.5, peak: 1, attack: 0.002, dest: d });
      this.osc(v, 'sine', 90, t, t + 0.25, { f1: 40, peak: 0.9, attack: 0.002, dest: d });
      this.crackle(v, t + 0.02, t + 0.35, 8, { type: 'lowpass', freq: 900, min: 0.01, max: 0.03, peak: 0.8, dest: d });
      this.grunt(v, t, t + 0.22, { f0: 180, f1: 80, formants: [600, 1000, 2400], peak: 0.5, attack: 0.005, breath: 0.4 });
    } else {
      this.grunt(v, t, t + 0.75, { f0: 190, f1: 65, formants: [650, 1100, 2500], formantsEnd: [400, 700, 2000], peak: 1, attack: 0.01, breath: 0.3, vib: { rate: 12, depth: 10 } });
      this.noise(v, t + 0.55, t + 0.7, { type: 'lowpass', freq: 500, freqEnd: 80, peak: 0.7, attack: 0.003 });
      this.osc(v, 'sine', 80, t + 0.55, t + 0.68, { f1: 40, peak: 0.6, attack: 0.002 });
    }
    return v;
  }

  // ---------- items ----------
  pickup(itemType, origin, local) {
    const def = ITEMS[itemType] || { kind: 'ammo' };
    if (def.kind === 'health') return itemType === 'mega' ? this.pickupMega(origin, local) : this.pickupHealth(origin, local);
    if (def.kind === 'armor') return this.pickupArmor(origin, local, itemType);
    if (def.kind === 'weapon') return this.pickupWeapon(origin, local);
    return this.pickupAmmo(origin, local);
  }
  pickupHealth(origin, local) {
    const v = this.voice('items', origin, { local, gain: T.pickupHealth }); const t = this.now();
    this.osc(v, 'sine', 880, t, t + 0.08, { peak: 0.8, attack: 0.002 }); this.osc(v, 'sine', 1175, t + 0.07, t + 0.22, { peak: 0.8, attack: 0.002 });
    this.osc(v, 'triangle', 2350, t + 0.07, t + 0.15, { peak: 0.15, attack: 0.002 });
    return v;
  }
  pickupMega(origin, local) {
    const v = this.voice('items', origin, { local, gain: T.pickupMega }); const t = this.now();
    [[660, 0], [880, 0.09], [1320, 0.18]].forEach(([f, dt]) => { this.osc(v, 'triangle', f, t + dt, t + dt + 0.3, { peak: 0.7, attack: 0.003 }); this.osc(v, 'sine', f * 2, t + dt, t + dt + 0.2, { peak: 0.2, attack: 0.003 }); });
    this.osc(v, 'sine', 2640, t + 0.2, t + 0.7, { peak: 0.25, attack: 0.05, detune: 5 }); this.osc(v, 'sine', 2640, t + 0.2, t + 0.7, { peak: 0.25, attack: 0.05, detune: -5 });
    return v;
  }
  pickupArmor(origin, local, itemType) {
    const v = this.voice('items', origin, { local, gain: T.pickupArmor }); const t = this.now();
    const red = itemType === 'armorRed', shard = itemType === 'armorShard';
    this.noise(v, t, t + 0.04, { type: 'bandpass', freq: 3500, q: 2, peak: 0.6, attack: 0.001 });
    for (const [f, a] of [[1500, 0.35], [2250, 0.25], [3700, 0.15]]) this.osc(v, 'sine', f * (red ? 0.8 : 1), t, t + (shard ? 0.12 : 0.25), { peak: a, attack: 0.001 });
    if (!shard) { this.osc(v, 'triangle', red ? 330 : 440, t, t + 0.18, { peak: 0.6, attack: 0.003 }); this.osc(v, 'triangle', red ? 495 : 660, t + 0.1, t + 0.36, { peak: 0.6, attack: 0.003 }); }
    return v;
  }
  pickupWeapon(origin, local) {
    const v = this.voice('items', origin, { local, gain: T.pickupWeapon }); const t = this.now();
    this.noise(v, t, t + 0.03, { type: 'bandpass', freq: 900, q: 1.5, peak: 0.8, attack: 0.001 });
    this.osc(v, 'square', 190, t, t + 0.07, { f1: 120, peak: 0.45, attack: 0.002 });
    this.noise(v, t + 0.08, t + 0.11, { type: 'bandpass', freq: 2400, q: 2, peak: 0.7, attack: 0.001 });
    this.osc(v, 'square', 260, t + 0.08, t + 0.2, { peak: 0.35, attack: 0.002 }); this.osc(v, 'square', 390, t + 0.12, t + 0.24, { peak: 0.3, attack: 0.002 });
    return v;
  }
  pickupAmmo(origin, local) {
    const v = this.voice('items', origin, { local, gain: T.pickupAmmo }); const t = this.now();
    for (const dt of [0, 0.075]) { this.noise(v, t + dt, t + dt + 0.012, { type: 'bandpass', freq: 1900, q: 2, peak: 0.9, attack: 0.001 }); this.osc(v, 'sine', 1400, t + dt, t + dt + 0.04, { peak: 0.4, attack: 0.001 }); }
    return v;
  }
  // Item respawn. Majors (mega, RA, RL/RG/LG) get a long blooming sweep with a category tint and a wide reference distance so
  // the whole map hears them; minors are a short local pip.
  itemRespawn(itemType, origin) {
    const def = ITEMS[itemType] || {};
    if (!def.major) return this.respawnMinor(origin);
    return this.respawnMajor(origin, def.kind);
  }
  respawnMajor(origin, kind = 'health') {
    const v = this.voice('items', origin, { gain: T.respawnMajor, ref: 1200, maxDist: 8000 }); const t = this.now();
    this.osc(v, 'sine', 220, t, t + 0.5, { f1: 1100, peak: 0.7, attack: 0.04, sweep: 0.4 });
    this.osc(v, 'triangle', 1650, t + 0.2, t + 0.75, { peak: 0.3, attack: 0.1 });
    this.osc(v, 'sine', 2200, t + 0.3, t + 0.9, { peak: 0.2, attack: 0.05, detune: 6 }); this.osc(v, 'sine', 2200, t + 0.3, t + 0.9, { peak: 0.2, attack: 0.05, detune: -6 });
    if (kind === 'armor') for (const f of [1500, 2250]) this.osc(v, 'sine', f, t + 0.45, t + 0.8, { peak: 0.25, attack: 0.002 });
    if (kind === 'weapon') { this.noise(v, t + 0.45, t + 0.48, { type: 'bandpass', freq: 900, q: 1.5, peak: 0.7, attack: 0.001 }); this.osc(v, 'square', 190, t + 0.45, t + 0.55, { f1: 120, peak: 0.35, attack: 0.002 }); }
    return v;
  }
  respawnMinor(origin) {
    const v = this.voice('items', origin, { gain: T.respawnMinor, ref: 200, rolloff: 1.5 }); const t = this.now();
    this.osc(v, 'sine', 700, t, t + 0.09, { f1: 1000, peak: 0.8, attack: 0.003 });
    return v;
  }
  jumppad(origin, local) {
    const v = this.voice(this.bodyBus(local), origin, { local, gain: T.jumppad }); const t = this.now();
    this.osc(v, 'sawtooth', 90, t, t + 0.35, { f1: 650, peak: 0.6, attack: 0.01, sweep: 0.3 });
    this.noise(v, t, t + 0.3, { type: 'bandpass', freq: 600, freqEnd: 3000, q: 1, peak: 0.6, attack: 0.01 });
    this.osc(v, 'sine', 70, t, t + 0.08, { peak: 0.8, attack: 0.002 });
    return v;
  }
  teleport(origin, local) {
    const v = this.voice(this.bodyBus(local), origin, { local, gain: T.teleport }); const t = this.now();
    for (let i = 0; i < 6; i++) this.osc(v, 'sine', 300 + i * 260, t + i * 0.035, t + 0.5, { peak: 0.3, attack: 0.01, detune: (i % 2 ? 7 : -7) });
    this.noise(v, t, t + 0.5, { type: 'bandpass', freq: 3000, freqEnd: 300, q: 2, peak: 0.5, attack: 0.02 });
    return v;
  }

  // ---------- UI (non-spatial, always at full level) ----------
  // CPMA-style hit tones: four tiers by damage dealt, pitch rises with damage.
  hitTone(damage) {
    const tier = damage >= 75 ? 3 : damage >= 50 ? 2 : damage >= 25 ? 1 : 0;
    const v = this.voice('ui', null, { gain: T.hitTone }); const t = this.now(); const f = [620, 800, 1000, 1300][tier];
    this.osc(v, 'square', f, t, t + 0.06, { peak: 0.5, attack: 0.001 }); this.osc(v, 'sine', f * 2, t, t + 0.05, { peak: 0.3, attack: 0.001 });
    return v;
  }
  weaponChange() {
    const v = this.voice('ui', null, { gain: T.weaponChange }); const t = this.now();
    this.noise(v, t, t + 0.015, { type: 'bandpass', freq: 2500, q: 2, peak: 0.8, attack: 0.001 }); this.osc(v, 'sine', 160, t + 0.03, t + 0.07, { peak: 0.5, attack: 0.002 });
    return v;
  }
  noAmmo() {
    const v = this.voice('ui', null, { gain: T.noAmmo }); const t = this.now();
    for (const dt of [0, 0.09]) this.osc(v, 'square', 330, t + dt, t + dt + 0.02, { peak: 0.5, attack: 0.001 });
    return v;
  }
  countdown(sec) {
    if (sec === 0) return this.fight();
    const v = this.voice('ui', null, { gain: T.countdown }); const t = this.now();
    this.osc(v, 'sine', 660, t, t + 0.14, { peak: 0.8, attack: 0.002, hold: 0.06 });
    return v;
  }
  fight() {
    const v = this.voice('ui', null, { gain: T.fight }); const t = this.now();
    for (const f of [660, 880, 1320]) this.osc(v, 'triangle', f, t, t + 0.45, { peak: 0.5, attack: 0.002, hold: 0.1 });
    this.noise(v, t, t + 0.12, { type: 'bandpass', freq: 2000, q: 0.8, peak: 0.4, attack: 0.001 });
    return v;
  }
  fanfare(win) {
    const v = this.voice('ui', null, { gain: win ? T.win : T.lose }); const t = this.now();
    const notes = win ? [523, 659, 784, 1047] : [392, 349, 311, 262];
    notes.forEach((f, i) => this.osc(v, 'triangle', f, t + i * 0.16, t + i * 0.16 + 0.42, { peak: 0.5, attack: 0.005, detune: win ? 0 : -15 }));
    if (win) for (const f of [523, 659, 784]) this.osc(v, 'sine', f, t + 0.64, t + 1.3, { peak: 0.3, attack: 0.01 });
    return v;
  }
  alert() {
    const v = this.voice('ui', null, { gain: T.alert }); const t = this.now();
    for (const dt of [0, 0.18]) this.osc(v, 'square', 520, t + dt, t + dt + 0.12, { peak: 0.4, attack: 0.002, hold: 0.05 });
    return v;
  }
  // Low machine-room bed: filtered noise + slow drone, kept far under gameplay cues (target -40 dBFS RMS).
  ambient() {
    const ctx = this.ctx, t = this.now(); const v = this.voice('ambient', null, { gain: T.ambient, loop: true });
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true; const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 160; const g = ctx.createGain(); g.gain.value = 0.7;
    n.connect(f); f.connect(g); g.connect(v.in);
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 48; const og = ctx.createGain(); og.gain.value = 0.35; const lfo = ctx.createOscillator(); lfo.frequency.value = 0.08; const lg = ctx.createGain(); lg.gain.value = 0.15; lfo.connect(lg); lg.connect(og.gain);
    o.connect(og); og.connect(v.in);
    for (const s of [n, o, lfo]) { s.start(t); this.track(v, s, Infinity); }
    this.ambientVoice = { v, stop: () => { const t2 = this.now(); v.in.gain.setTargetAtTime(0, t2, 0.05); for (const s of [n, o, lfo]) s.stop(t2 + 0.3); v.loop = false; v.end = t2 + 0.3; } };
    return v;
  }

  // ---------- cue table (name -> trigger) used by tools/audio_measure.mjs and by tests ----------
  buildCueTable() {
    const W = WEAPONS;
    return {
      machinegunFire: (o) => this.fire(W.MACHINEGUN, o.origin, o.local), shotgunFire: (o) => this.fire(W.SHOTGUN, o.origin, o.local),
      rocketFire: (o) => this.fire(W.ROCKET, o.origin, o.local), railFire: (o) => this.fire(W.RAIL, o.origin, o.local),
      plasmaFire: (o) => this.fire(W.PLASMA, o.origin, o.local), gauntletFire: (o) => this.fire(W.GAUNTLET, o.origin, o.local),
      lightningLoop: (o) => this.lgStart(o.id ?? 1, o.origin, o.local),
      rocketLoop: (o) => this.rocketLoopStart(o.id ?? 1, o.origin, o.velocity || [0, 0, 0]).v,
      rocketExplode: (o) => this.explode(W.ROCKET, o.origin), plasmaExplode: (o) => this.explode(W.PLASMA, o.origin),
      bulletImpact: (o) => this.impact(W.MACHINEGUN, o.origin), railImpact: (o) => this.impact(W.RAIL, o.origin), gauntletImpact: (o) => this.impact(W.GAUNTLET, o.origin), lgHit: (o) => this.lgHit(o.origin),
      jump: (o) => this.jump(o.origin, o.local), landSoft: (o) => this.land(o.origin, o.local, false), landHard: (o) => this.land(o.origin, o.local, true), footstep: (o) => this.footstep(o.origin, o.local),
      painLight: (o) => this.pain(o.origin, o.local, 80), painMid: (o) => this.pain(o.origin, o.local, 60), painHeavy: (o) => this.pain(o.origin, o.local, 40), painCritical: (o) => this.pain(o.origin, o.local, 10),
      death: (o) => this.death(o.origin, o.local, false), gib: (o) => this.death(o.origin, o.local, true),
      pickupHealth: (o) => this.pickup('health25', o.origin, o.local), pickupMega: (o) => this.pickup('mega', o.origin, o.local), pickupArmor: (o) => this.pickup('armorRed', o.origin, o.local),
      pickupWeapon: (o) => this.pickup('weaponRocket', o.origin, o.local), pickupAmmo: (o) => this.pickup('ammoRockets', o.origin, o.local),
      respawnMajor: (o) => this.itemRespawn('mega', o.origin), respawnMinor: (o) => this.itemRespawn('health25', o.origin),
      jumppad: (o) => this.jumppad(o.origin, o.local), teleport: (o) => this.teleport(o.origin, o.local),
      hitTone1: () => this.hitTone(10), hitTone2: () => this.hitTone(30), hitTone3: () => this.hitTone(60), hitTone4: () => this.hitTone(100),
      weaponChange: () => this.weaponChange(), noAmmo: () => this.noAmmo(), countdown: () => this.countdown(3), fight: () => this.fight(), win: () => this.fanfare(true), lose: () => this.fanfare(false), alert: () => this.alert(),
    };
  }
  cue(name, o = {}) { const f = this.cues[name]; if (!f) throw new Error('unknown cue ' + name); return f(o); }

  // ---------- event routing (payloads from shared/game.js) ----------
  // Position of player `id` for a cue that carries none: interpolated remote entity, else the local game state, else the
  // newest snapshot (events of a snapshot are dispatched before its players are interpolated into cg.remote, so the first
  // snapshot after joining reaches here), else the last origin seen in any event.
  originOf(id, cg) {
    const r = cg.remote && cg.remote.get(id); if (r && r.origin) return r.origin;
    const p = cg.game && cg.game.players && cg.game.players.get(id); if (p) return p.ps.origin;
    const snap = cg.snapshots && cg.snapshots[cg.snapshots.length - 1]; const sp = snap && snap.players && snap.players.find((x) => x.id === id); if (sp && sp.o) return sp.o;
    return this.lastOrigin.get(id) || null;
  }
  event(e, cg, predicted) {
    if (!this.enabled) return;
    const local = e.id === cg.localId;
    const origin = e.origin || (e.id ? this.originOf(e.id, cg) : null);
    // Body cues of another player are only ever voiced spatially: if the player cannot be placed (not in cg.remote yet, and
    // never seen in an event) the cue is dropped rather than played non-spatially at own-cue level (a phantom "step behind
    // you" on top of you). Otherwise remember where the player was for the next event that carries no origin.
    if (!local && e.id) { if (!origin) { if (BODY_EVENTS.has(e.type)) { this.counters.dropped++; return; } } else this.lastOrigin.set(e.id, origin); }
    switch (e.type) {
      case EV.FIRE: if (e.weapon === WEAPONS.LIGHTNING) this.lgStart(e.id, origin, local); else this.fire(e.weapon, origin, local); break;
      case EV.EXPLODE: this.explode(e.weapon, e.origin); break;
      case EV.BULLET_IMPACT: this.impact(e.weapon, e.origin); break;
      case EV.LG_HIT: this.lgHit(e.origin); break;
      case EV.HIT: if (local) this.queueHit(e); break;
      case EV.PAIN: this.queuePain(e, origin, local); break;
      // the lethal hit's PAIN arrives in the same tick as the DEATH: the death cry replaces the grunt (Q3 plays no pain sound on
      // a kill), and the pain window is reset so the freshly spawned player grunts at once when hit
      case EV.DEATH: this.pendingPain.delete(e.id); this.painDebounce.delete(e.id); this.death(origin, local, e.gib); break;
      case EV.JUMP: this.jump(origin, local); break;
      case EV.LAND: this.land(origin, local, !!e.hard); break;
      case EV.FOOTSTEP: {
        // pmove emits one per bob cycle; guard against duplicate deliveries (redundant command batches) within 80 ms
        const t = this.now(); if (t - (this.lastFootstep.get(e.id) || -1) < 0.08) break; this.lastFootstep.set(e.id, t);
        this.footstep(origin, local); break;
      }
      case EV.PICKUP: this.pickup(e.itemType, e.origin || origin, local); break;
      case EV.ITEM_RESPAWN: this.itemRespawn(e.itemType, e.origin); break;
      case EV.JUMPPAD: this.jumppad(origin, local); break;
      case EV.TELEPORT: this.teleport(origin, local); break;
      case EV.RESPAWN: this.painDebounce.delete(e.id); this.teleport(origin, local); break;
      case EV.WEAPON_CHANGE: if (local) this.weaponChange(); break;
      case EV.NOAMMO: if (local) this.noAmmo(); break;
      case EV.COUNTDOWN: this.countdown(e.seconds); break;
      case EV.MATCH_START: case EV.ROUND_START: this.fight(); break;
      case EV.ROUND_END: if (e.winner != null) this.fanfare(e.winner === cg.localId); break;
      case EV.MATCH_END: this.fanfare(e.winner === cg.localId); break;
      case EV.MAJOR_WARN: this.alert(); break;
    }
  }
  // ---------- per-tick damage coalescing + per-target pain debounce ----------
  // One shotgun blast / rocket splash arrives as N HIT events (attacker) and N PAIN events (target) in the same tick. They are
  // summed here and voiced once per attacker / per target: HIT -> hitTone(total damage), PAIN -> pain(final health).
  // Queues flush in update() (every frame) or, if update() is late, as soon as a queued entry is older than COALESCE_WINDOW.
  // A flushed PAIN is then gated by PAIN_DEBOUNCE per target (see the constant): 1 s of lightning on one player is 20 ticks of
  // hit tones for the attacker but only 2 grunts from the victim.
  queueHit(e) {
    const t = this.now(); this.flushDamage(t - COALESCE_WINDOW);
    const q = this.pendingHits.get(e.id);
    if (q) q.damage += e.damage || 0; else this.pendingHits.set(e.id, { damage: e.damage || 0, t });
  }
  queuePain(e, origin, local) {
    const t = this.now(); this.flushDamage(t - COALESCE_WINDOW);
    const q = this.pendingPain.get(e.id);
    if (q) { q.damage += e.damage || 0; q.health = Math.min(q.health, e.health ?? q.health); if (origin) q.origin = origin; }
    else this.pendingPain.set(e.id, { damage: e.damage || 0, health: e.health ?? 100, origin, local, t });
  }
  // Voice and drop every queued entry created at or before `before` (Infinity = everything).
  flushDamage(before = Infinity) {
    for (const [id, q] of this.pendingHits) if (q.t <= before) { this.pendingHits.delete(id); this.hitTone(q.damage); }
    for (const [id, q] of this.pendingPain) if (q.t <= before) {
      this.pendingPain.delete(id);
      const t = this.now(), d = this.painDebounce.get(id);
      if (d && t < d.t + PAIN_DEBOUNCE) { d.health = Math.min(d.health, q.health); continue; }   // inside the window: silent, only the pending tier escalates
      this.painDebounce.set(id, { t, health: Infinity });
      this.pain(q.origin, q.local, d ? Math.min(d.health, q.health) : q.health, id);
    }
  }

  // Per frame: flush coalesced damage cues, garbage-collect finished voices, end lightning loops that stopped being refreshed,
  // follow rockets in flight.
  update(cg, now) {
    if (!this.enabled) return;
    this.flushDamage();
    const t = this.now();
    for (const v of this.voices) if (!v.loop && t > v.end + 0.1) this.kill(v);
    for (const [id, l] of this.lgLoops) if (t - l.last > 0.15) { l.stop(); this.lgLoops.delete(id); }
    const live = new Set();
    for (const pr of (cg && cg.remoteProjectiles) || []) {
      if (pr.t !== WEAPONS.ROCKET) continue;
      live.add(pr.id);
      let l = this.rocketLoops.get(pr.id);
      if (!l) l = this.rocketLoopStart(pr.id, pr.origin, pr.v);
      if (pr.v) l.velocity = pr.v;
      if (l.v.panner) this.place(l.v, pr.origin);
      const dop = this.dopplerFactor(pr.origin, l.velocity);
      l.n.playbackRate.setTargetAtTime(dop, t, 0.05); l.o.frequency.setTargetAtTime(58 * dop, t, 0.05);
    }
    for (const [id, l] of this.rocketLoops) if (!live.has(id)) { l.stop(); this.rocketLoops.delete(id); }
  }
}
