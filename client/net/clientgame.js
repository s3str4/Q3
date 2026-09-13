// Client-side game state: prediction/reconciliation for the local player, snapshot interpolation for everything else.
import { Game } from '../../shared/game.js';
import { MSG, PROTOCOL_VERSION } from '../../shared/protocol.js';
import { TICK_MS, TICK_RATE, EV, PM } from '../../shared/constants.js';
import { copy, lerp, lerpAngle, dist } from '../../shared/vec3.js';
import { PMF } from '../../shared/pmove.js';

const STEP_TIME = 200; // ms, Q3 cg_view.c STEP_TIME
const MAX_STEP_CHANGE = 32; // Q3 MAX_STEP_CHANGE

export class ClientGame {
  constructor(map, transport, opts = {}) {
    this.map = map;
    this.transport = transport;
    this.game = new Game(map, { mode: opts.mode || 'duel', isServer: false, lagComp: false });
    this.localId = 0;
    this.name = opts.name || 'player';
    this.pending = []; // unacked commands
    this.seq = 0;
    this.snapshots = []; // recent snapshots for interpolation
    this.snapRate = 60;
    this.interpSnaps = opts.interpSnaps || 2;
    this.clock = { offset: 0, rtt: 0, samples: [], jitter: 0 };
    this.onEvent = opts.onEvent || (() => {});
    this.onInfo = opts.onInfo || (() => {});
    this.onKick = opts.onKick || (() => {});
    this.onChat = opts.onChat || (() => {});
    this.predicted = null; // predicted local player state (ps + stats)
    this.misprediction = 0; this.corrections = 0; this.mispredMax = 0;
    this.lastSnapAt = 0; this.snapGaps = [];
    this.stats = { snapsReceived: 0, bytesIn: 0, cmdsSent: 0, acked: 0 };
    this.pendingLocalEvents = []; // predicted events (fire) awaiting server confirmation dedupe
    this.rules = null; this.serverLagComp = true;
    this.viewSmoothZ = 0; this.stepSmooth = 0;
    this.snapClock = []; this._snapClockDirty = true; this._snapClockSorted = [];
    transport.onmessage = (m) => this.handle(m);
    this.remote = new Map(); // id -> { origin, angles, velocity, ... } interpolated
  }

  // opts.bot: ask the server to add a practice bot (with opts.botSkill) when the match has room.
  join(opts = {}) {
    const msg = { t: MSG.JOIN, name: this.name, v: PROTOCOL_VERSION };
    if (opts.bot) { msg.bot = true; msg.botSkill = opts.botSkill ?? 0.6; }
    this.transport.send(msg);
    // resend until WELCOME arrives (unreliable P2P channel / simulated loss); the server ignores duplicate joins
    this.joinTimer = setInterval(() => { if (this.localId) clearInterval(this.joinTimer); else this.transport.send(msg); }, 500);
    this.pingTimer = setInterval(() => this.ping(), 500); this.ping();
  }
  close() { clearInterval(this.pingTimer); clearInterval(this.joinTimer); this.transport.close(); }
  ping() { this.transport.send({ t: MSG.PING, c: performance.now(), rtt: Math.round(this.clock.rtt) }); }

  // estimated current server time (NTP-style from pings; used for stats only)
  serverTime() { return performance.now() + this.clock.offset; }

  // Render clock (Q3 cl.serverTime): derived from snapshot ARRIVAL, not from the ping estimate, so it always trails
  // the newest snapshot by the interpolation delay and we interpolate instead of extrapolating. We take a low
  // percentile of (snap.t - recvAt) over the last ~1.5 s so jitter bunching does not push us ahead of the data.
  renderTime(now = performance.now()) {
    const s = this.snapClock;
    if (!s.length) return this.serverTime() - this.interpDelayMs();
    if (this._snapClockDirty) { this._snapClockSorted = [...s].sort((a, b) => a - b); this._snapClockDirty = false; }
    const sorted = this._snapClockSorted;
    const offset = sorted[Math.floor(sorted.length * 0.1)];
    return now + offset - this.interpDelayMs();
  }
  interpDelayMs() { return (1000 / this.snapRate) * this.interpSnaps; }

  handle(m) {
    switch (m.t) {
      case MSG.WELCOME:
        this.localId = m.id; this.snapRate = m.snapRate || 60; this.rules = m.rules; this.serverLagComp = m.lagComp;
        this.game.mode = m.mode;
        break;
      case MSG.PONG: {
        const now = performance.now();
        const rtt = now - m.c;
        const offset = m.s + rtt / 2 - now;
        const s = this.clock.samples; s.push({ rtt, offset }); if (s.length > 10) s.shift();
        // use the lowest-RTT samples for the offset estimate (NTP-style)
        const sorted = [...s].sort((a, b) => a.rtt - b.rtt);
        const best = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
        this.clock.offset = best.reduce((a, b) => a + b.offset, 0) / best.length;
        this.clock.rtt = this.clock.rtt ? this.clock.rtt * 0.8 + rtt * 0.2 : rtt;
        const mean = s.reduce((a, b) => a + b.rtt, 0) / s.length;
        this.clock.jitter = Math.sqrt(s.reduce((a, b) => a + (b.rtt - mean) ** 2, 0) / s.length);
        break;
      }
      case MSG.SNAP: this.onSnapshot(m.s); break;
      case MSG.INFO: this.onInfo(m.info); break;
      case MSG.KICK: this.onKick(m.reason); break;
      case MSG.CHAT: this.onChat(m); break;
    }
  }

  onSnapshot(snap) {
    const now = performance.now();
    if (this.lastSnapAt) { this.snapGaps.push(now - this.lastSnapAt); if (this.snapGaps.length > 60) this.snapGaps.shift(); }
    this.lastSnapAt = now;
    this.stats.snapsReceived++;
    snap.recvAt = now;
    this.snapClock.push(snap.t - now); if (this.snapClock.length > 90) this.snapClock.shift(); this._snapClockDirty = true;
    this.snapshots.push(snap);
    if (this.snapshots.length > 32) this.snapshots.shift();
    // events
    for (const e of snap.ev || []) this.dispatchEvent(e);
    // reconcile local player
    const me = snap.players.find((p) => p.id === this.localId);
    if (!me) return;
    const prev = this.predicted;
    const predictedBefore = prev ? copy(prev.ps.origin) : null;
    const wasDead = prev ? prev.dead : true;
    const prevSpawn = prev ? prev.spawnTime : -1, prevTele = prev ? (prev.teleportSeq || 0) : 0;
    // authoritative state -> game, then replay unacked commands
    this.game.applySnapshot(snap, this.localId);
    const p = this.game.players.get(this.localId);
    this.pending = this.pending.filter((c) => c.seq > me.ack);
    this.stats.acked = me.ack;
    for (const c of this.pending) this.game.runPlayerCommand(p, c, true);
    p.ps.stepTime = 0; // replays re-climb the same stairs; only the fresh command (runCommand) may feed step smoothing
    // A respawn or teleport moves the player by design (the server picks the spot); it is not a misprediction.
    const reset = p.spawnTime !== prevSpawn || (p.teleportSeq || 0) !== prevTele || wasDead;
    if (predictedBefore && !p.dead && !reset) {
      const err = dist(predictedBefore, p.ps.origin);
      this.misprediction = err;
      if (err > 0.05) { this.corrections++; this.mispredMax = Math.max(this.mispredMax, err); }
      // smooth small corrections on the view (Q3 does not, but it avoids visible pops at higher ping)
      if (err > 0.5 && err < 64) { this.errorOffset = [predictedBefore[0] - p.ps.origin[0], predictedBefore[1] - p.ps.origin[1], predictedBefore[2] - p.ps.origin[2]]; this.errorTime = now; }
    } else if (reset) { this.errorOffset = null; this.misprediction = 0; }
    this.predicted = p;
  }

  // Observed snapshot rate (Hz) over the last ~60 snapshots, and RTT/jitter as measured by pings.
  netStats() {
    const gaps = this.snapGaps;
    const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    const t = this.transport;
    return {
      snapHz: mean ? 1000 / mean : 0, snaps: this.stats.snapsReceived, cmds: this.stats.cmdsSent, acked: this.stats.acked || 0, extrapolated: this.stats.extrapolated || 0,
      rtt: this.clock.rtt, jitter: this.clock.jitter, misprediction: this.misprediction, mispredMax: this.mispredMax, corrections: this.corrections,
      bytesIn: t.bytesIn || 0, bytesOut: t.bytesOut || 0,
    };
  }

  dispatchEvent(e) {
    // suppress our own predicted fire events (already played locally)
    if (e.type === EV.FIRE && e.id === this.localId) {
      const i = this.pendingLocalEvents.findIndex((x) => x.seq === e.seq);
      if (i >= 0) { this.pendingLocalEvents.splice(i, 1); return; }
    }
    if ((e.type === EV.JUMP || e.type === EV.LAND || e.type === EV.FOOTSTEP || e.type === EV.JUMPPAD || e.type === EV.WEAPON_CHANGE || e.type === EV.NOAMMO || e.type === EV.TELEPORT) && e.id === this.localId) return; // predicted locally
    this.onEvent(e, false);
  }

  // Called at a fixed 60 Hz by the client loop with a fresh input sample.
  runCommand(input) {
    if (!this.localId || !this.predicted) return null;
    const p = this.predicted;
    this.seq++;
    // vt: the server time whose remote positions we are showing right now (see renderTime); the server rewinds hitscan to it
    const cmd = { seq: this.seq, forward: input.forward, right: input.right, up: input.up, buttons: input.buttons, angles: [input.pitch, input.yaw, 0], weapon: input.weapon, vt: Math.round(this.renderTime()) };
    const events = this.game.runPlayerCommand(p, cmd, true);
    if (p.ps.stepTime) {
      const now = performance.now();
      const t = this.stepAt ? (now - this.stepAt) / STEP_TIME : 1;
      const oldStep = t < 1 ? this.stepSmooth * (1 - t) : 0;
      this.stepSmooth = Math.max(-MAX_STEP_CHANGE, Math.min(MAX_STEP_CHANGE, oldStep + p.ps.stepTime));
      this.stepAt = now; p.ps.stepTime = 0;
    }
    for (const e of events) { if (e.type === EV.FIRE) this.pendingLocalEvents.push({ seq: e.seq, t: performance.now() }); this.onEvent(e, true); }
    this.pendingLocalEvents = this.pendingLocalEvents.filter((x) => performance.now() - x.t < 2000);
    this.pending.push(cmd);
    if (this.pending.length > 90) this.pending.shift(); // ~1.5 s of input; beyond this we're effectively disconnected
    // send the last 3 commands redundantly (loss tolerance for unreliable transports)
    const batch = this.pending.slice(-3);
    this.transport.send({ t: MSG.CMD, c: batch });
    this.stats.cmdsSent++;
    return cmd;
  }

  // Interpolated view of remote entities at render time.
  interpolate() {
    const renderTime = this.renderTime();
    this.lastRenderTime = renderTime;
    const snaps = this.snapshots;
    if (snaps.length === 0) return;
    let a = null, b = null;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].t <= renderTime) { a = snaps[i]; b = snaps[i + 1] || null; break; }
    }
    if (!a) { a = snaps[0]; b = snaps[1] || null; }
    let f = 0;
    if (b && b.t > a.t) f = Math.max(0, Math.min(1, (renderTime - a.t) / (b.t - a.t)));
    if (!b) { // extrapolate a little (max 50 ms) from velocity
      this.stats.extrapolated = (this.stats.extrapolated || 0) + 1;
      const dt = Math.min(0.05, Math.max(0, (renderTime - a.t) / 1000));
      for (const pa of a.players) {
        if (pa.id === this.localId) continue;
        this.remote.set(pa.id, { ...pa, origin: [pa.o[0] + pa.v[0] * dt, pa.o[1] + pa.v[1] * dt, pa.o[2] + pa.v[2] * dt], angles: pa.a, snap: pa });
      }
      this.remoteProjectiles = a.projectiles.map((pr) => ({ ...pr, origin: [pr.o[0] + pr.v[0] * dt, pr.o[1] + pr.v[1] * dt, pr.o[2] + pr.v[2] * dt] }));
      this.latestSnap = a;
      return;
    }
    for (const pa of a.players) {
      if (pa.id === this.localId) continue;
      const pb = b.players.find((x) => x.id === pa.id) || pa;
      // teleport: don't interpolate across
      const tele = pb.ts !== pa.ts || dist(pa.o, pb.o) > 400;
      const origin = tele ? pb.o : lerp(pa.o, pb.o, f);
      const angles = tele ? pb.a : [lerpAngle(pa.a[0], pb.a[0], f), lerpAngle(pa.a[1], pb.a[1], f)];
      this.remote.set(pa.id, { ...pb, origin, angles, snap: pb });
    }
    for (const id of [...this.remote.keys()]) if (!b.players.find((x) => x.id === id)) this.remote.delete(id);
    this.remoteProjectiles = b.projectiles.map((pb) => {
      const pa = a.projectiles.find((x) => x.id === pb.id);
      return { ...pb, origin: pa ? lerp(pa.o, pb.o, f) : pb.o };
    });
    this.latestSnap = b;
  }

  // Local player's render origin: predicted state with error smoothing and step smoothing.
  localView(now) {
    const p = this.predicted;
    if (!p) return null;
    const o = copy(p.ps.origin);
    if (this.errorOffset) {
      const t = (now - this.errorTime) / 100; // decay over 100 ms
      if (t >= 1) this.errorOffset = null;
      else { const k = 1 - t; o[0] += this.errorOffset[0] * k; o[1] += this.errorOffset[1] * k; o[2] += this.errorOffset[2] * k; }
    }
    // Q3 step smoothing (CG_StepOffset): the view lags the origin by the remaining step offset over STEP_TIME
    if (this.stepSmooth) { const t = (now - this.stepAt) / STEP_TIME; if (t >= 1) this.stepSmooth = 0; else o[2] -= this.stepSmooth * (1 - t); }
    return { origin: o, viewHeight: p.ps.viewHeight, angles: p.ps.viewangles, velocity: p.ps.velocity, ducked: (p.ps.pmFlags & PMF.DUCKED) !== 0, ground: p.ps.groundEntity, dead: p.dead, player: p };
  }
}
