// Demo core (Quake 3 style demos): the recording format, the recorder and a playback cursor. Pure module: no DOM,
// no storage, usable from Node (tests/demo.test.mjs) and from the browser (client/demoplayer.js adds IndexedDB,
// download / import and the playback UI; client/main.js wires the recorder into the live client).
//
// A demo is everything one client received during one match, on the server's timeline:
//   header   map / mode / rules / the WELCOME, the local player's id, the player table (id, name, skin, colour, bot)
//   snaps    every snapshot as a compact integer row: [t, tick, recvAt, players[], projectiles[], itemsRef, matchRef, ev]
//            players / projectiles are numeric rows in a fixed field order (positions 1/128 unit, velocities 1/16,
//            angles 1/100 degree, the same quantisation as the wire, so remote entities decode to the exact values the
//            live client interpolated); the item array and the match object are stored once per distinct value and
//            referenced by index (they change a few times per minute, not per snapshot); events travel as-is
//   views    the recorder's first-person view, sampled at up to 60 Hz from the render loop: [renderTime (0.1 ms,
//            relative to the first snapshot), origin (1/128), pitch / yaw (1/100 deg), viewHeight, flags]
//   end      the MATCH_END summary (the end screen data) when the match ended while recording
// In memory a 10-minute 60 Hz duel is ~36k snapshot rows of ~45 small integers per player (packed SMI arrays in V8):
// tens of MB at most; serialised it is ~1.4 MB per minute of JSON and ~10x less gzipped (numbers in tests/demo.test.mjs).
//
// The demo clock is server time relative to the first recorded snapshot (ms). Remote entities at demo time D are the
// snapshot pair around t0 + D interpolated exactly as ClientGame.interpolate does; the view at D is the sample whose
// render time was D (so what the recorder saw on screen at that render time is what plays back); a snapshot's events
// fire when D passes t - interpolation delay, which is when a live client received them relative to what it rendered.
import { EV, TICK_MS } from '../shared/constants.js';
import { PROTOCOL_VERSION } from '../shared/protocol.js';
import { lerp, lerpAngle, dist } from '../shared/vec3.js';

export const DEMO_FORMAT = 1;
export const DEMO_MIN_MS = 2000;          // shorter recordings (left during the countdown) are discarded
export const DEMO_MAX_SNAPS = 20 * 60 * 60; // hard memory cap: 20 minutes at 60 Hz (a duel is 10 min + overtime)
const VIEW_MIN_GAP = 1000 / 60 - 1;      // views are sampled per frame but kept at most ~60 Hz (144 Hz screens)

// player row: id, origin x3, velocity x3, angles x2, then these scalars, then weaponState (string table index),
// spawn yaw (1/100 deg) and the ammo counts of weapons 1..8 (a missing key is 0 for every reader)
const PNUM = ['h', 'ar', 'w', 'pw', 'wt', 'd', 'f', 'dt', 'pf', 'pt', 'g', 'vh', 'wp', 'ack', 'ah', 'bot', 'ping', 'ts', 'dd', 'hits', 'shots', 'jt', 'jp', 'hd', 'dth', 'st'];
const PNUM_AT = 9, WS_AT = PNUM_AT + PNUM.length, SY_AT = WS_AT + 1, AM_AT = SY_AT + 1, AM_N = 8;
const Q_ORIGIN = 128, Q_VEL = 16, Q_ANG = 100, Q_RT = 10;
const ri = (v) => (Number.isFinite(v) ? Math.round(v) : 0);
const rq = (v, s) => (Number.isFinite(v) ? Math.round(v * s) : 0);

function encodePlayer(p, ws) {
  const row = [p.id, rq(p.o[0], Q_ORIGIN), rq(p.o[1], Q_ORIGIN), rq(p.o[2], Q_ORIGIN), rq(p.v[0], Q_VEL), rq(p.v[1], Q_VEL), rq(p.v[2], Q_VEL), rq(p.a[0], Q_ANG), rq(p.a[1], Q_ANG)];
  for (const k of PNUM) row.push(k === 'jp' ? ri(p.jp ?? -1) : ri(p[k]));
  let wi = ws.indexOf(p.ws); if (wi < 0) { wi = ws.length; ws.push(String(p.ws)); }
  row.push(wi, rq(p.sy, Q_ANG));
  for (let w = 1; w <= AM_N; w++) row.push(ri(p.am ? p.am[w] : 0));
  return row;
}
function decodePlayer(row, demo, ident) {
  const p = { id: row[0], o: [row[1] / Q_ORIGIN, row[2] / Q_ORIGIN, row[3] / Q_ORIGIN], v: [row[4] / Q_VEL, row[5] / Q_VEL, row[6] / Q_VEL], a: [row[7] / Q_ANG, row[8] / Q_ANG] };
  for (let i = 0; i < PNUM.length; i++) p[PNUM[i]] = row[PNUM_AT + i];
  p.ws = demo.ws[row[WS_AT]] || 'ready'; p.sy = row[SY_AT] / Q_ANG;
  p.am = {}; for (let w = 1; w <= AM_N; w++) p.am[w] = row[AM_AT + w - 1];
  const id = ident || demo.players.find((x) => x.id === p.id);
  p.n = id ? id.n : 'player ' + p.id; if (id && id.sk) p.sk = id.sk; if (id && id.col != null) p.col = id.col;
  return p;
}
const encodeProj = (pr) => [pr.id, pr.t, rq(pr.o[0], Q_ORIGIN), rq(pr.o[1], Q_ORIGIN), rq(pr.o[2], Q_ORIGIN), rq(pr.v[0], Q_VEL), rq(pr.v[1], Q_VEL), rq(pr.v[2], Q_VEL), pr.ow, ri(pr.sq)];
const decodeProj = (r) => ({ id: r[0], t: r[1], o: [r[2] / Q_ORIGIN, r[3] / Q_ORIGIN, r[4] / Q_ORIGIN], v: [r[5] / Q_VEL, r[6] / Q_VEL, r[7] / Q_VEL], ow: r[8], sq: r[9] });

// Expand snapshot row i of a demo into the live snapshot shape (what ClientGame.onSnapshot receives).
const IDENT = new WeakMap(); // demo -> Map(id -> player table entry)
export function expandSnapshot(demo, i) {
  const r = demo.snaps[i];
  let identById = IDENT.get(demo); if (!identById) { identById = new Map(demo.players.map((p) => [p.id, p])); IDENT.set(demo, identById); }
  return {
    t: r[0], tick: r[1], recvAt: r[2],
    players: r[3].map((row) => decodePlayer(row, demo, identById.get(row[0]))),
    projectiles: r[4].map(decodeProj),
    items: demo.items[r[5]] || [], match: { ...(demo.matches[r[6]] || {}) }, ev: r[7] || [],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Recorder. Feed it every snapshot the client receives (with its arrival time) and the view of every rendered frame.
// It is armed with the match header (arm) and starts on the first COUNTDOWN / MATCH_START event, ends on MATCH_END
// (the summary is kept, the demo is handed to onDemo and the recorder re-arms for the next match) or on stop() when
// the player leaves (the partial demo is handed over if it is long enough, marked `aborted`).
export class DemoRecorder {
  constructor(opts = {}) {
    this.onDemo = opts.onDemo || (() => {});
    this.interpSnaps = opts.interpSnaps || 2;
    this.now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.header = null; this.state = 'idle'; this.d = null;
  }
  get recording() { return this.state === 'recording'; }
  get armed() { return this.state === 'armed'; }
  // header: { map, mode, rules, localId, localName, snapRate, welcome, interpSnaps } - from WELCOME / the ClientGame
  arm(header) {
    // a repeated WELCOME (JOIN retry) for the same match only refreshes the header; anything else ends what is running
    if (this.state === 'recording' && this.header && this.header.map === header.map && this.header.localId === header.localId) { this.header = { ...header }; return; }
    this.stop(); this.header = { ...header }; this.state = 'armed';
  }
  disarm() { this.stop(); this.state = 'idle'; }
  static headerFrom(cg, welcome = null) {
    return { map: cg.mapName || (cg.map && cg.map.name), mode: cg.game.mode, rules: cg.game.rules, localId: cg.localId, localName: cg.name, snapRate: cg.snapRate || 60, interpSnaps: cg.interpSnaps || 2, welcome: welcome ? stripWelcome(welcome) : null };
  }
  snapshot(snap, recvAt = this.now()) {
    if (this.state === 'armed') {
      if (!(snap.ev || []).some((e) => e.type === EV.COUNTDOWN || e.type === EV.MATCH_START || e.type === EV.ROUND_START)) return;
      this.begin(snap, recvAt);
    }
    if (this.state !== 'recording') return;
    const d = this.d;
    if (d.snaps.length >= DEMO_MAX_SNAPS) { d.truncated = true; return; }
    // a second MATCH_START without a MATCH_END in between (the match was reset): start the demo over from here
    if (d.sawStart && (snap.ev || []).some((e) => e.type === EV.MATCH_START)) this.begin(snap, recvAt);
    this.append(snap, recvAt);
    const end = (snap.ev || []).find((e) => e.type === EV.MATCH_END);
    if (end) { this.d.end = clone(end); this.finish(false); this.state = 'armed'; }
  }
  begin(snap, recvAt) {
    const h = this.header || {};
    this.d = { format: DEMO_FORMAT, version: PROTOCOL_VERSION, app: 'arena-duel', date: new Date().toISOString(), map: h.map, mode: h.mode, rules: h.rules || null, welcome: h.welcome || null,
      localId: h.localId, localName: h.localName, snapRate: h.snapRate || 60, interpSnaps: h.interpSnaps || this.interpSnaps,
      t0: snap.t, recv0: recvAt, players: [], ws: [], items: [], matches: [], snaps: [], views: [], end: null, aborted: false, sawStart: false,
      _lastItems: null, _lastMatch: null, _lastRt: -Infinity, _lastNow: -Infinity, _vclock: null };
    this.state = 'recording';
  }
  append(snap, recvAt) {
    const d = this.d;
    for (const p of snap.players) {
      const cur = d.players.find((x) => x.id === p.id);
      const ent = { id: p.id, n: p.n, ...(p.sk ? { sk: p.sk } : {}), ...(p.col != null ? { col: p.col } : {}), bot: p.bot ? 1 : 0 };
      if (!cur) d.players.push(ent); else if (cur.n !== ent.n || cur.sk !== ent.sk || cur.col !== ent.col) Object.assign(cur, ent);
    }
    const itemsKey = (snap.items || []).join(','); if (itemsKey !== d._lastItems) { d.items.push([...(snap.items || [])]); d._lastItems = itemsKey; }
    const matchKey = JSON.stringify(snap.match || {}); if (matchKey !== d._lastMatch) { d.matches.push(JSON.parse(matchKey)); d._lastMatch = matchKey; }
    const ev = snap.ev && snap.ev.length ? clone(snap.ev) : 0;
    if (ev && ev.some((e) => e.type === EV.MATCH_START)) d.sawStart = true;
    d.snaps.push([snap.t, snap.tick, Math.round(recvAt - d.recv0), snap.players.map((p) => encodePlayer(p, d.ws)), (snap.projectiles || []).map(encodeProj), d.items.length - 1, d.matches.length - 1, ev]);
  }
  // renderTime: the client's render clock (server time of the remote entities on screen); view: ClientGame.localView().
  // Kept at ~60 Hz by wall-clock spacing. The render clock jitters by a few ms whenever its offset percentile moves,
  // so the stored time is a smoothed copy of it: advanced by wall time, pulled toward the real clock, monotonic.
  // Returns the stored row (null when the sample was not kept).
  view(renderTime, view, now = this.now()) {
    if (this.state !== 'recording' || !view) return null;
    const d = this.d;
    if (now < d._lastNow + VIEW_MIN_GAP) return null;
    let clock = d._vclock == null ? renderTime : d._vclock + (now - d._lastNow);
    clock += (renderTime - clock) * 0.1;
    d._lastNow = now; d._vclock = clock;
    const rt = Math.max(d._lastRt + 1, Math.round((clock - d.t0) * Q_RT)); d._lastRt = rt;
    const flags = (view.ducked ? 1 : 0) | (view.ground ? 2 : 0) | (view.dead ? 4 : 0);
    const row = [rt, rq(view.origin[0], Q_ORIGIN), rq(view.origin[1], Q_ORIGIN), rq(view.origin[2], Q_ORIGIN), rq(view.angles[0], Q_ANG), rq(view.angles[1], Q_ANG), ri(view.viewHeight), flags];
    d.views.push(row);
    return row;
  }
  // the player left / the map changed: keep what we have when it is long enough
  stop() { if (this.state === 'recording') { this.d.aborted = true; this.finish(true); } this.state = 'idle'; }
  finish(aborted) {
    const d = this.d; this.d = null; this.state = 'idle';
    if (!d || d.snaps.length < 2) return null;
    d.duration = d.snaps[d.snaps.length - 1][0] - d.t0; d.aborted = !!aborted;
    for (const k of Object.keys(d)) if (k.startsWith('_')) delete d[k];
    if (d.duration < DEMO_MIN_MS) return null;
    this.onDemo(d);
    return d;
  }
}
function stripWelcome(w) { const { maps, ...rest } = w; return clone(rest); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }

// ---------------------------------------------------------------------------------------------------------------
// Playback cursor: state of the recorded match at any demo time, deterministic in both directions.
//   seek(D)      rebuild from the snapshot pair around D (events at or after D are pending, earlier ones are skipped)
//   advance(D)   move forward to D, firing every event whose time lies in (previous, D] exactly once, in order
// After either call: a / b / f (the pair and blend), latest (b or a), players (Map id -> interpolated entry with
// origin / angles, the same fields ClientGame puts in cg.remote), projectiles, view (the recorder's first-person view
// at D or null when the demo has no view samples), local (the recorder's entry in `latest`).
export class DemoCursor {
  constructor(demo, opts = {}) {
    if (!demo || demo.format !== DEMO_FORMAT || !Array.isArray(demo.snaps) || demo.snaps.length < 2) throw new Error('not a playable demo');
    this.demo = demo; this.t0 = demo.t0; this.duration = demo.duration ?? (demo.snaps[demo.snaps.length - 1][0] - demo.t0);
    this.onEvent = opts.onEvent || (() => {});
    this.interpDelay = opts.interpDelay ?? (1000 / (demo.snapRate || 60)) * (demo.interpSnaps || 2);
    this.times = Float64Array.from(demo.snaps, (r) => r[0] - demo.t0);
    this.viewTimes = Float64Array.from(demo.views || [], (r) => r[0] / Q_RT);
    // events with their fire time (snapshot time minus the interpolation delay, never negative), in snapshot order
    this.events = [];
    demo.snaps.forEach((r, i) => { for (const e of r[7] || []) this.events.push({ at: Math.max(0, this.times[i] - this.interpDelay), snap: i, e }); });
    this.cache = new Map();
    this.time = 0; this.ai = 0; this.evIdx = 0; this.players = new Map(); this.projectiles = []; this.view = null;
    this.seek(0);
  }
  snap(i) { let s = this.cache.get(i); if (!s) { if (this.cache.size > 256) this.cache.clear(); s = expandSnapshot(this.demo, i); this.cache.set(i, s); } return s; }
  clamp(D) { return Math.max(0, Math.min(this.duration, Number.isFinite(D) ? D : 0)); }
  seek(D) {
    D = this.clamp(D); this.time = D;
    this.ai = upperBound(this.times, D) - 1; if (this.ai < 0) this.ai = 0;
    this.evIdx = lowerBoundBy(this.events, D);
    this.sync();
    return this;
  }
  advance(D) {
    D = this.clamp(D);
    if (D < this.time) return this.seek(D);
    const fired = [];
    while (this.evIdx < this.events.length && this.events[this.evIdx].at <= D) { const ev = this.events[this.evIdx++]; fired.push(ev.e); this.onEvent(ev.e, ev); }
    this.time = D;
    while (this.ai + 1 < this.times.length && this.times[this.ai + 1] <= D) this.ai++;
    this.sync();
    return fired;
  }
  // interpolate the pair around `time` exactly like ClientGame.interpolate (teleports and >400 unit jumps snap)
  sync() {
    const T = this.time, a = this.snap(this.ai), bi = this.ai + 1 < this.times.length ? this.ai + 1 : -1, b = bi >= 0 ? this.snap(bi) : null;
    const f = b && b.t > a.t ? Math.max(0, Math.min(1, (this.t0 + T - a.t) / (b.t - a.t))) : 0;
    this.a = a; this.b = b; this.f = f; this.latest = b || a;
    const cur = b || a, seen = new Set();
    for (const pa of a.players) {
      const pb = b ? (b.players.find((x) => x.id === pa.id) || pa) : pa;
      const tele = pb.ts !== pa.ts || dist(pa.o, pb.o) > 400;
      const origin = tele || !b ? [...pb.o] : lerp(pa.o, pb.o, f);
      const angles = tele || !b ? [pb.a[0], pb.a[1]] : [lerpAngle(pa.a[0], pb.a[0], f), lerpAngle(pa.a[1], pb.a[1], f)];
      this.players.set(pa.id, { ...pb, origin, angles, snap: pb }); seen.add(pa.id);
    }
    if (b) for (const pb of b.players) if (!seen.has(pb.id)) { this.players.set(pb.id, { ...pb, origin: [...pb.o], angles: [pb.a[0], pb.a[1]], snap: pb }); seen.add(pb.id); }
    for (const id of [...this.players.keys()]) if (!seen.has(id)) this.players.delete(id);
    this.projectiles = cur.projectiles.map((pb) => { const pa = b ? a.projectiles.find((x) => x.id === pb.id) : null; return { ...pb, origin: pa ? lerp(pa.o, pb.o, f) : [...pb.o] }; });
    this.local = cur.players.find((p) => p.id === this.demo.localId) || null;
    this.view = this.viewAt(T);
  }
  // the recorder's view at demo time D: the samples around render time D, blended (null without view samples)
  viewAt(D) {
    const v = this.demo.views, n = v.length; if (!n) return null;
    let i = upperBound(this.viewTimes, D) - 1; if (i < 0) i = 0;
    const a = v[i], b = i + 1 < n ? v[i + 1] : null;
    const f = b && b[0] > a[0] ? Math.max(0, Math.min(1, (D - a[0] / Q_RT) / ((b[0] - a[0]) / Q_RT))) : 0;
    const o = (r) => [r[1] / Q_ORIGIN, r[2] / Q_ORIGIN, r[3] / Q_ORIGIN];
    const origin = b && f > 0 ? lerp(o(a), o(b), f) : o(a);
    const pitch = b && f > 0 ? lerpAngle(a[4] / Q_ANG, b[4] / Q_ANG, f) : a[4] / Q_ANG, yaw = b && f > 0 ? lerpAngle(a[5] / Q_ANG, b[5] / Q_ANG, f) : a[5] / Q_ANG;
    return { origin, angles: [pitch, yaw, 0], viewHeight: a[6], ducked: !!(a[7] & 1), ground: !!(a[7] & 2), dead: !!(a[7] & 4), sample: i };
  }
}

// first index with arr[i] > x (Float64Array of sorted times)
function upperBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo; }
// first index with events[i].at >= x
function lowerBoundBy(ev, x) { let lo = 0, hi = ev.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m].at < x) lo = m + 1; else hi = m; } return lo; }

// ---------------------------------------------------------------------------------------------------------------
// Summaries for a library listing / file name, and the frag list (every DEATH with its demo time) for the timeline.
export function demoSummary(demo) {
  const last = demo.snaps[demo.snaps.length - 1];
  const frags = new Map(last[3].map((row) => [row[0], row[PNUM_AT + PNUM.indexOf('f')]]));
  const players = demo.players.map((p) => ({ id: p.id, name: p.n, bot: !!p.bot, frags: frags.get(p.id) ?? 0, local: p.id === demo.localId }));
  players.sort((a, b) => (a.local ? -1 : b.local ? 1 : a.id - b.id));
  return { map: demo.map, mode: demo.mode, date: demo.date, duration: demo.duration, players, localId: demo.localId, winner: demo.end ? demo.end.winner : null, aborted: !!demo.aborted, snaps: demo.snaps.length, views: (demo.views || []).length };
}
export function demoScoreLine(demo) { return demoSummary(demo).players.map((p) => `${p.name} ${p.frags}`).join(' - '); }
export function demoFrags(demo) {
  const name = (id) => { const p = demo.players.find((x) => x.id === id); return p ? p.n : id ? 'player ' + id : 'world'; };
  const out = [];
  demo.snaps.forEach((r) => { for (const e of r[7] || []) if (e.type === EV.DEATH) out.push({ t: r[0] - demo.t0, victim: e.id, attacker: e.attacker || 0, mod: e.mod, victimName: name(e.id), attackerName: e.attacker && e.attacker !== e.id ? name(e.attacker) : null, gib: !!e.gib }); });
  return out;
}
// Sanity check for imported files.
export function validateDemo(d) {
  if (!d || typeof d !== 'object') return 'not a JSON object';
  if (d.format !== DEMO_FORMAT) return 'unknown demo format ' + d.format;
  if (typeof d.map !== 'string' || !Array.isArray(d.snaps) || d.snaps.length < 2 || !Array.isArray(d.players)) return 'missing map / snapshots';
  if (!Number.isFinite(d.t0)) return 'missing timeline';
  return null;
}
export const DEMO_TICK_MS = TICK_MS;
