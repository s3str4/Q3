// Synthesized competitive sound design on the Web Audio API. No sample assets: every cue is generated.
// Mix architecture: source -> (panner for world sounds) -> category bus (weapons/impacts/player/items/ui) -> master compressor -> out.
import { EV, WEAPONS, ITEMS } from '../../shared/constants.js';
import { angleVectors, dist } from '../../shared/vec3.js';

const REF_DIST = 320, MAX_DIST = 3000, ROLLOFF = 1;

export class AudioEngine {
  constructor() {
    this.ctx = null; this.enabled = false; this.volume = 0.8; this.listenerPos = [0, 0, 0]; this.localId = 0;
    this.loops = new Map(); this.lgLoop = null; this.lastFoot = 0;
  }
  init() {
    if (this.ctx) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = this.volume;
    this.comp = ctx.createDynamicsCompressor(); this.comp.threshold.value = -12; this.comp.knee.value = 10; this.comp.ratio.value = 4; this.comp.attack.value = 0.003; this.comp.release.value = 0.15;
    this.master.connect(this.comp); this.comp.connect(ctx.destination);
    this.bus = {};
    for (const [name, g] of Object.entries({ weapons: 0.9, impacts: 0.9, player: 0.8, items: 0.7, ui: 0.8, ambient: 0.35 })) { const b = ctx.createGain(); b.gain.value = g; b.connect(this.master); this.bus[name] = b; }
    this.noiseBuf = this.makeNoise(2);
    this.enabled = true;
    this.ambient();
  }
  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume(); }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }
  makeNoise(seconds) {
    const n = this.ctx.sampleRate * seconds; const b = this.ctx.createBuffer(1, n, this.ctx.sampleRate); const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; return b;
  }
  // Listener follows the camera
  updateListener(eye, angles) {
    if (!this.ctx) return;
    this.listenerPos = eye;
    const av = angleVectors(angles);
    const l = this.ctx.listener; const t = this.ctx.currentTime;
    if (l.positionX) { l.positionX.setValueAtTime(eye[0], t); l.positionY.setValueAtTime(eye[1], t); l.positionZ.setValueAtTime(eye[2], t); l.forwardX.setValueAtTime(av.forward[0], t); l.forwardY.setValueAtTime(av.forward[1], t); l.forwardZ.setValueAtTime(av.forward[2], t); l.upX.setValueAtTime(av.up[0], t); l.upY.setValueAtTime(av.up[1], t); l.upZ.setValueAtTime(av.up[2], t); }
    else { l.setPosition(eye[0], eye[1], eye[2]); l.setOrientation(av.forward[0], av.forward[1], av.forward[2], av.up[0], av.up[1], av.up[2]); }
  }
  // Output node for a sound: spatialized panner when origin is given, otherwise straight to the bus.
  out(bus, origin, opts = {}) {
    const ctx = this.ctx;
    const g = ctx.createGain(); g.gain.value = opts.gain ?? 1;
    if (origin && !opts.local) {
      const p = ctx.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = opts.ref ?? REF_DIST; p.maxDistance = MAX_DIST; p.rolloffFactor = opts.rolloff ?? ROLLOFF;
      p.positionX.value = origin[0]; p.positionY.value = origin[1]; p.positionZ.value = origin[2];
      g.connect(p); p.connect(this.bus[bus]); g.panner = p;
    } else g.connect(this.bus[bus]);
    return g;
  }
  osc(type, freq, dest, t0, t1, env = {}) {
    const ctx = this.ctx; const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(env.peak ?? 1, t0 + (env.attack ?? 0.005)); g.gain.exponentialRampToValueAtTime(0.001, t1);
    o.connect(g); g.connect(dest); o.start(t0); o.stop(t1 + 0.02); return o;
  }
  noise(dest, t0, t1, opts = {}) {
    const ctx = this.ctx; const s = ctx.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = opts.type || 'lowpass'; f.frequency.setValueAtTime(opts.freq ?? 2000, t0); if (opts.freqEnd) f.frequency.exponentialRampToValueAtTime(opts.freqEnd, t1); f.Q.value = opts.q ?? 0.7;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(opts.peak ?? 1, t0 + (opts.attack ?? 0.003)); g.gain.exponentialRampToValueAtTime(0.001, t1);
    s.connect(f); f.connect(g); g.connect(dest); s.start(t0); s.stop(t1 + 0.02); return s;
  }

  // ---------- cue library ----------
  fire(weapon, origin, local) {
    const ctx = this.ctx, t = ctx.currentTime;
    switch (weapon) {
      case WEAPONS.ROCKET: { const d = this.out('weapons', origin, { local, gain: 1.0 }); this.noise(d, t, t + 0.35, { freq: 900, freqEnd: 120, peak: 1.2, attack: 0.002 }); this.osc('sine', 110, d, t, t + 0.3, { peak: 0.9 }); this.osc('sawtooth', 60, d, t, t + 0.18, { peak: 0.4 }); break; }
      case WEAPONS.RAIL: { const d = this.out('weapons', origin, { local, gain: 1.0 }); const o = this.osc('sawtooth', 1800, d, t, t + 0.45, { peak: 0.5 }); o.frequency.exponentialRampToValueAtTime(240, t + 0.45); this.osc('square', 3200, d, t, t + 0.08, { peak: 0.35 }); this.noise(d, t, t + 0.12, { type: 'highpass', freq: 3000, peak: 0.8 }); this.osc('sine', 90, d, t, t + 0.25, { peak: 0.7 }); break; }
      case WEAPONS.LIGHTNING: this.lgStart(origin, local); break;
      case WEAPONS.SHOTGUN: { const d = this.out('weapons', origin, { local, gain: 1.0 }); this.noise(d, t, t + 0.25, { freq: 1600, freqEnd: 200, peak: 1.2 }); this.osc('sine', 140, d, t, t + 0.15, { peak: 0.8 }); this.noise(d, t + 0.32, t + 0.42, { type: 'bandpass', freq: 2500, peak: 0.35, q: 2 }); /* pump */ break; }
      case WEAPONS.PLASMA: { const d = this.out('weapons', origin, { local, gain: 0.55 }); const o = this.osc('square', 620, d, t, t + 0.09, { peak: 0.4 }); o.frequency.exponentialRampToValueAtTime(280, t + 0.09); this.noise(d, t, t + 0.05, { type: 'bandpass', freq: 4000, peak: 0.3, q: 3 }); break; }
      case WEAPONS.MACHINEGUN: { const d = this.out('weapons', origin, { local, gain: 0.6 }); this.noise(d, t, t + 0.07, { freq: 2200, freqEnd: 400, peak: 1.0, attack: 0.001 }); this.osc('sine', 180, d, t, t + 0.05, { peak: 0.5 }); break; }
      case WEAPONS.GAUNTLET: { const d = this.out('weapons', origin, { local, gain: 0.5 }); this.osc('sawtooth', 240, d, t, t + 0.12, { peak: 0.4 }); break; }
    }
  }
  lgStart(origin, local) {
    const ctx = this.ctx, t = ctx.currentTime;
    if (!this.lgLoop) {
      const d = this.out('weapons', origin, { local, gain: 0.5 });
      const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 95; const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 1400;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 28; const lg = ctx.createGain(); lg.gain.value = 600; lfo.connect(lg); lg.connect(o2.frequency);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200; f.Q.value = 1.5;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.02);
      const n = ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true; const nf = ctx.createBiquadFilter(); nf.type = 'highpass'; nf.frequency.value = 2500; const ng = ctx.createGain(); ng.gain.value = 0.25;
      o1.connect(f); o2.connect(f); f.connect(g); n.connect(nf); nf.connect(ng); ng.connect(g); g.connect(d);
      o1.start(t); o2.start(t); lfo.start(t); n.start(t);
      this.lgLoop = { g, d, stop: () => { const t2 = ctx.currentTime; g.gain.setTargetAtTime(0, t2, 0.03); o1.stop(t2 + 0.2); o2.stop(t2 + 0.2); lfo.stop(t2 + 0.2); n.stop(t2 + 0.2); }, last: t };
    }
    this.lgLoop.last = t;
    if (this.lgLoop.d.panner && origin) { this.lgLoop.d.panner.positionX.value = origin[0]; this.lgLoop.d.panner.positionY.value = origin[1]; this.lgLoop.d.panner.positionZ.value = origin[2]; }
  }
  explode(weapon, origin, onPlayer) {
    const ctx = this.ctx, t = ctx.currentTime;
    if (weapon === WEAPONS.ROCKET) {
      const d = this.out('impacts', origin, { gain: 1.3, ref: 400 });
      this.noise(d, t, t + 0.9, { freq: 2500, freqEnd: 60, peak: 1.4, attack: 0.002 });
      this.osc('sine', 70, d, t, t + 0.6, { peak: 1.2 }); this.osc('triangle', 45, d, t + 0.01, t + 0.8, { peak: 0.8 });
      this.noise(d, t + 0.05, t + 1.4, { type: 'lowpass', freq: 400, freqEnd: 80, peak: 0.5, attack: 0.05 });
    } else {
      const d = this.out('impacts', origin, { gain: 0.55 });
      this.noise(d, t, t + 0.12, { type: 'bandpass', freq: 1800, peak: 0.8, q: 1.5 }); this.osc('sine', 300, d, t, t + 0.08, { peak: 0.4 });
    }
  }
  impact(weapon, origin) {
    const ctx = this.ctx, t = ctx.currentTime;
    const d = this.out('impacts', origin, { gain: weapon === WEAPONS.RAIL ? 0.8 : 0.35 });
    this.noise(d, t, t + (weapon === WEAPONS.RAIL ? 0.25 : 0.06), { type: 'highpass', freq: weapon === WEAPONS.RAIL ? 1500 : 2500, peak: 1 });
    if (weapon === WEAPONS.RAIL) this.osc('sine', 500, d, t, t + 0.2, { peak: 0.4 });
  }
  lgHit(origin) { const ctx = this.ctx, t = ctx.currentTime; const d = this.out('impacts', origin, { gain: 0.35 }); this.noise(d, t, t + 0.05, { type: 'highpass', freq: 3500, peak: 0.8 }); }
  hitTone(damage) {
    // CPMA-style hit beeps: pitch rises with damage; local, non-spatial, always audible
    const ctx = this.ctx, t = ctx.currentTime; const d = this.out('ui', null, { gain: 0.5 });
    const f = damage >= 75 ? 1400 : damage >= 50 ? 1150 : damage >= 25 ? 950 : 780;
    this.osc('square', f, d, t, t + 0.06, { peak: 0.5, attack: 0.001 }); this.osc('sine', f * 2, d, t, t + 0.05, { peak: 0.2 });
  }
  pain(origin, local, health, damage) {
    const ctx = this.ctx, t = ctx.currentTime; const d = this.out('player', origin, { local, gain: local ? 0.8 : 0.9 });
    const base = health < 25 ? 180 : health < 50 ? 220 : 260;
    const o = this.osc('sawtooth', base, d, t, t + 0.22, { peak: 0.6 }); o.frequency.exponentialRampToValueAtTime(base * 0.7, t + 0.22);
    this.noise(d, t, t + 0.15, { type: 'bandpass', freq: 900, peak: 0.5, q: 1 });
  }
  death(origin, local, gib) {
    const ctx = this.ctx, t = ctx.currentTime; const d = this.out('player', origin, { local, gain: 1.0 });
    const o = this.osc('sawtooth', 200, d, t, t + 0.7, { peak: 0.7 }); o.frequency.exponentialRampToValueAtTime(60, t + 0.7);
    this.noise(d, t, t + 0.4, { type: 'bandpass', freq: 700, freqEnd: 200, peak: 0.6, q: 1 });
    if (gib) this.noise(d, t, t + 0.5, { type: 'lowpass', freq: 800, freqEnd: 100, peak: 1.2 });
  }
  jump(origin, local) { const ctx = this.ctx, t = ctx.currentTime; const d = this.out('player', origin, { local, gain: 0.45 }); const o = this.osc('sine', 260, d, t, t + 0.12, { peak: 0.5 }); o.frequency.exponentialRampToValueAtTime(400, t + 0.1); this.noise(d, t, t + 0.06, { type: 'bandpass', freq: 1200, peak: 0.3, q: 1 }); }
  land(origin, local, hard) { const ctx = this.ctx, t = ctx.currentTime; const d = this.out('player', origin, { local, gain: hard ? 0.9 : 0.5 }); this.noise(d, t, t + (hard ? 0.18 : 0.09), { freq: hard ? 500 : 800, freqEnd: 100, peak: 1 }); this.osc('sine', hard ? 70 : 120, d, t, t + 0.12, { peak: 0.6 }); }
  footstep(origin, local) { const ctx = this.ctx, t = ctx.currentTime; const d = this.out('player', origin, { local, gain: local ? 0.28 : 0.5, ref: 200 }); this.noise(d, t, t + 0.06, { freq: 700 + Math.random() * 300, freqEnd: 150, peak: 0.9 }); this.osc('sine', 150 + Math.random() * 40, d, t, t + 0.05, { peak: 0.3 }); }
  pickup(itemType, origin, local) {
    const ctx = this.ctx, t = ctx.currentTime; const def = ITEMS[itemType]; const d = this.out('items', origin, { local, gain: 0.7 });
    if (def.kind === 'health') { const big = itemType === 'mega'; this.osc('sine', big ? 520 : 660, d, t, t + 0.12, { peak: 0.5 }); this.osc('sine', big ? 780 : 880, d, t + 0.08, t + 0.25, { peak: 0.5 }); if (big) this.osc('sine', 1040, d, t + 0.16, t + 0.5, { peak: 0.5 }); }
    else if (def.kind === 'armor') { const big = itemType === 'armorRed'; this.noise(d, t, t + 0.08, { type: 'bandpass', freq: 3000, peak: 0.5, q: 2 }); this.osc('triangle', big ? 330 : 440, d, t, t + 0.18, { peak: 0.6 }); this.osc('triangle', big ? 495 : 660, d, t + 0.09, t + 0.35, { peak: 0.6 }); }
    else if (def.kind === 'weapon') { this.noise(d, t, t + 0.12, { type: 'bandpass', freq: 1500, freqEnd: 600, peak: 0.6, q: 1 }); this.osc('square', 220, d, t, t + 0.1, { peak: 0.3 }); this.osc('square', 330, d, t + 0.06, t + 0.2, { peak: 0.3 }); }
    else { this.osc('triangle', 500, d, t, t + 0.06, { peak: 0.35 }); this.osc('triangle', 700, d, t + 0.05, t + 0.12, { peak: 0.35 }); }
  }
  itemRespawn(itemType, origin) {
    const ctx = this.ctx, t = ctx.currentTime; const def = ITEMS[itemType]; const d = this.out('items', origin, { gain: def.major ? 0.9 : 0.4, ref: def.major ? 500 : 250 });
    const o = this.osc('sine', 300, d, t, t + 0.35, { peak: 0.6 }); o.frequency.exponentialRampToValueAtTime(900, t + 0.3);
    if (def.major) this.osc('triangle', 1200, d, t + 0.15, t + 0.5, { peak: 0.4 });
  }
  jumppad(origin, local) { const ctx = this.ctx, t = ctx.currentTime; const d = this.out('player', origin, { local, gain: 0.8 }); const o = this.osc('sawtooth', 120, d, t, t + 0.35, { peak: 0.6 }); o.frequency.exponentialRampToValueAtTime(600, t + 0.3); this.noise(d, t, t + 0.3, { type: 'bandpass', freq: 800, freqEnd: 2400, peak: 0.6, q: 1 }); }
  teleport(origin, local) { const ctx = this.ctx, t = ctx.currentTime; const d = this.out('player', origin, { local, gain: 0.8 }); for (let i = 0; i < 5; i++) this.osc('sine', 400 + i * 220, d, t + i * 0.03, t + 0.4, { peak: 0.3 }); this.noise(d, t, t + 0.4, { type: 'bandpass', freq: 2000, freqEnd: 400, peak: 0.5, q: 2 }); }
  weaponChange() { const ctx = this.ctx, t = ctx.currentTime; const d = this.out('ui', null, { gain: 0.4 }); this.noise(d, t, t + 0.05, { type: 'bandpass', freq: 2500, peak: 0.6, q: 2 }); this.osc('square', 180, d, t + 0.04, t + 0.09, { peak: 0.25 }); }
  noAmmo() { const ctx = this.ctx, t = ctx.currentTime; const d = this.out('ui', null, { gain: 0.5 }); this.osc('square', 320, d, t, t + 0.05, { peak: 0.3 }); this.osc('square', 320, d, t + 0.08, t + 0.13, { peak: 0.3 }); }
  countdown(sec) { const ctx = this.ctx, t = ctx.currentTime; const d = this.out('ui', null, { gain: 0.7 }); this.osc('sine', sec === 0 ? 880 : 440, d, t, t + (sec === 0 ? 0.5 : 0.15), { peak: 0.7 }); }
  fanfare(win) { const ctx = this.ctx, t = ctx.currentTime; const d = this.out('ui', null, { gain: 0.7 }); const notes = win ? [523, 659, 784, 1047] : [392, 349, 311, 262]; notes.forEach((f, i) => this.osc('triangle', f, d, t + i * 0.16, t + i * 0.16 + 0.4, { peak: 0.5 })); }
  ambient() {
    // low machine-room bed: filtered noise + slow drone, kept well under gameplay cues
    const ctx = this.ctx, t = ctx.currentTime; const d = this.bus.ambient;
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true; const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 180; const g = ctx.createGain(); g.gain.value = 0.35;
    n.connect(f); f.connect(g); g.connect(d); n.start(t);
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 48; const og = ctx.createGain(); og.gain.value = 0.18; const lfo = ctx.createOscillator(); lfo.frequency.value = 0.08; const lg = ctx.createGain(); lg.gain.value = 0.08; lfo.connect(lg); lg.connect(og.gain);
    o.connect(og); og.connect(d); o.start(t); lfo.start(t);
  }

  // ---------- event routing ----------
  event(e, cg, predicted) {
    if (!this.enabled) return;
    const local = e.id === cg.localId;
    switch (e.type) {
      case EV.FIRE: this.fire(e.weapon, e.origin, local); break;
      case EV.EXPLODE: this.explode(e.weapon, e.origin, e.onPlayer); break;
      case EV.BULLET_IMPACT: this.impact(e.weapon, e.origin); break;
      case EV.LG_HIT: this.lgHit(e.origin); break;
      case EV.HIT: if (local) this.hitTone(e.damage); break;
      case EV.PAIN: this.pain(e.origin, local, e.health, e.damage); break;
      case EV.DEATH: this.death(e.origin, local, e.gib); break;
      case EV.JUMP: this.jump(e.origin || (local ? null : e.origin), local); break;
      case EV.LAND: this.land(e.origin, local, e.hard); break;
      case EV.FOOTSTEP: this.footstep(e.origin, local); break;
      case EV.PICKUP: this.pickup(e.itemType, e.origin, local); break;
      case EV.ITEM_RESPAWN: this.itemRespawn(e.itemType, e.origin); break;
      case EV.JUMPPAD: this.jumppad(e.origin, local); break;
      case EV.TELEPORT: case EV.RESPAWN: this.teleport(e.origin, local); break;
      case EV.WEAPON_CHANGE: if (local) this.weaponChange(); break;
      case EV.NOAMMO: if (local) this.noAmmo(); break;
      case EV.COUNTDOWN: this.countdown(e.seconds); break;
      case EV.MATCH_START: case EV.ROUND_START: this.countdown(0); break;
      case EV.MATCH_END: this.fanfare(e.winner === cg.localId); break;
    }
  }
  // per-frame: stop LG loop when no longer firing, update projectile loops
  update(cg, now) {
    if (!this.enabled) return;
    if (this.lgLoop && this.ctx.currentTime - this.lgLoop.last > 0.12) { this.lgLoop.stop(); this.lgLoop = null; }
    // rocket flight loops
    const live = new Set();
    for (const pr of cg.remoteProjectiles || []) {
      if (pr.t !== WEAPONS.ROCKET) continue;
      live.add(pr.id);
      let l = this.loops.get(pr.id);
      if (!l) {
        const ctx = this.ctx, t = ctx.currentTime; const d = this.out('weapons', pr.origin, { gain: 0.6, ref: 250 });
        const n = ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true; const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 500; f.Q.value = 0.8;
        const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.7, t + 0.05); n.connect(f); f.connect(g); g.connect(d); n.start(t);
        l = { d, stop: () => { const t2 = ctx.currentTime; g.gain.setTargetAtTime(0, t2, 0.02); n.stop(t2 + 0.1); } }; this.loops.set(pr.id, l);
      }
      if (l.d.panner) { l.d.panner.positionX.value = pr.origin[0]; l.d.panner.positionY.value = pr.origin[1]; l.d.panner.positionZ.value = pr.origin[2]; }
    }
    for (const [id, l] of this.loops) if (!live.has(id)) { l.stop(); this.loops.delete(id); }
  }
}
