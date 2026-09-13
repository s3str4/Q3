// Demos: record a short duel from a real client over a real WebSocket (server in-process, two headless clients as in
// netcode.test.mjs), then check the recording (map / mode / rules, 60 Hz snapshots, the match events, the summary),
// that the playback cursor reproduces exactly what a live ClientGame interpolates at any time, that the recorded
// first-person view comes back within its quantisation, that events replay exactly once in order at speed 1 and 4,
// that seeking is deterministic in both directions, and how big a minute of demo is (JSON and gzip).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createServer } from '../server/index.mjs';
import { connectHeadless, sleep } from '../client/net/headless.js';
import { ClientGame } from '../client/net/clientgame.js';
import { loadMap } from '../shared/map.js';
import { BUTTONS, WEAPONS, EV, TICK_MS } from '../shared/constants.js';
import { vectorToAngles, sub, dist } from '../shared/vec3.js';
import { DemoRecorder, DemoCursor, expandSnapshot, demoSummary, demoFrags, validateDemo, DEMO_FORMAT } from '../client/demo.js';

const map = await loadMap('testbox');
const TIMELIMIT = 8000;

// One recorded duel shared by every check below: A machineguns B (kept fragile so several deaths happen) until the
// time limit ends the match. A's client records; every raw snapshot and every sampled view is kept for reference.
async function recordDuel() {
  const server = await createServer({ port: 0, map: 'testbox', quiet: true, rules: { warmup: 500, timelimit: TIMELIMIT } });
  const url = `ws://127.0.0.1:${server.port}/`;
  const raw = [], rawViews = [], demos = [];
  const rec = new DemoRecorder({ onDemo: (d) => demos.push(d) });
  const recB = new DemoRecorder({ onDemo: (d) => demos.push(d) });
  let fighting = true;
  const scriptA = (t, cg, ys) => {
    const other = [...cg.remote.values()][0];
    if (other && cg.predicted) { const eye = [cg.predicted.ps.origin[0], cg.predicted.ps.origin[1], cg.predicted.ps.origin[2] + cg.predicted.ps.viewHeight]; const a = vectorToAngles(sub([other.origin[0], other.origin[1], other.origin[2] + 4], eye)); ys.pitch = a[0]; ys.yaw = a[1]; }
    return { buttons: fighting ? BUTTONS.ATTACK : 0, weapon: WEAPONS.MACHINEGUN, right: Math.sin(t * 1.5) > 0 ? 60 : -60 };
  };
  const scriptB = (t, cg, ys) => { ys.yaw = 90 + Math.sin(t) * 30; return { right: Math.sin(t * 2) > 0 ? 127 : -127, buttons: cg.predicted && cg.predicted.dead ? BUTTONS.ATTACK : 0 }; };
  let A = null, B = null, viewTimer = null;
  try {
    A = await connectHeadless({ url, map, name: 'Recorder', script: scriptA });
    await A.waitFor((cg) => cg.localId > 0, 5000);
    A.cg.onSnap = (snap) => { raw.push(structuredClone(snap)); rec.snapshot(snap, snap.recvAt); };
    // the browser samples the view every rendered frame and the recorder keeps ~60 Hz of them; here a fast timer offers
    // samples (a 16 ms Node timer starves next to the sim timers of two clients and the server in one process)
    viewTimer = setInterval(() => { const now = performance.now(); const v = A.cg.localView(now); if (!v) return; const rt = A.cg.renderTime(now); const row = rec.view(rt, v); if (row) rawViews.push({ row, rt, origin: [...v.origin], angles: [...v.angles], viewHeight: v.viewHeight }); }, 2);
    rec.arm(DemoRecorder.headerFrom(A.cg));
    assert.ok(rec.armed);
    B = await connectHeadless({ url, map, name: 'Victim', script: scriptB });
    await B.waitFor((cg) => cg.localId > 0, 5000);
    B.cg.onSnap = (snap) => recB.snapshot(snap, snap.recvAt);
    recB.arm(DemoRecorder.headerFrom(B.cg));
    await A.waitFor((cg) => cg.predicted && cg.game.match.state === 'playing', 15000);
    assert.ok(rec.recording, 'recording started on the countdown');
    const sa = server.game.players.get(A.id), sb = server.game.players.get(B.id);
    sa.ps.origin = [-400, 0, 24]; sb.ps.origin = [-100, 0, 24]; sa.ammo[WEAPONS.MACHINEGUN] = 9999;
    const t0 = performance.now();
    while (performance.now() - t0 < TIMELIMIT - 1500 && server.game.match.state === 'playing') {
      await sleep(30);
      sb.armor = 0; if (!sb.dead && sb.health > 30) sb.health = 30;
      if (!sb.dead && Math.hypot(sb.ps.origin[0] + 100, sb.ps.origin[1]) > 350) { sb.ps.origin = [-100, 0, 24]; sb.ps.velocity = [0, 0, 0]; sb.teleportSeq = (sb.teleportSeq || 0) + 1; }
    }
    fighting = false;
    if (sa.frags <= sb.frags) sa.frags = sb.frags + 1; // the time limit only ends a duel with a leader
    recB.stop(); // B leaves early: a partial demo
    await A.waitFor((cg) => cg.game.match.state === 'ended', TIMELIMIT + 5000);
    await sleep(300);
  } finally {
    clearInterval(viewTimer);
    if (A) A.stop(); if (B) B.stop();
    await server.close();
  }
  return { raw, rawViews, demos, rec, idA: A.id, idB: B.id, serverFrags: null };
}

const R = await recordDuel();
const demo = R.demos.find((d) => d.localId === R.idA && !d.aborted);

test('recording: one demo per match with the map, mode, rules, both players, 60 Hz snapshots and the match events', () => {
  assert.ok(demo, 'the recorder handed over a demo at MATCH_END');
  assert.equal(validateDemo(demo), null);
  assert.equal(demo.format, DEMO_FORMAT);
  assert.equal(demo.map, 'testbox'); assert.equal(demo.mode, 'duel'); assert.equal(demo.rules.timelimit, TIMELIMIT);
  assert.equal(demo.localId, R.idA); assert.equal(demo.localName, 'Recorder');
  assert.deepEqual(demo.players.map((p) => p.n).sort(), ['Recorder', 'Victim']);
  // 60 Hz: every snapshot is one tick apart (integer ms clock: 16 / 17 ms steps) and the count matches the duration
  const times = demo.snaps.map((r) => r[0]);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 16 && times[i] - times[i - 1] <= 17, `gap ${times[i] - times[i - 1]} at ${i}`);
  const rate = (demo.snaps.length - 1) / (demo.duration / 1000);
  assert.ok(Math.abs(rate - 60) < 0.5, `snapshot rate ${rate.toFixed(2)} Hz`);
  assert.ok(demo.duration >= TIMELIMIT && demo.duration < TIMELIMIT + 1500, `duration ${demo.duration} ms covers the countdown and the match`);
  // arrival times were recorded and are monotonic
  const recv = demo.snaps.map((r) => r[2]); assert.equal(recv[0], 0); for (let i = 1; i < recv.length; i++) assert.ok(recv[i] >= recv[i - 1]);
  // events: starts on the countdown, MATCH_START, deaths, MATCH_END last
  const ev = demo.snaps.flatMap((r) => r[7] || []);
  assert.ok((demo.snaps[0][7] || []).some((e) => e.type === EV.COUNTDOWN), 'first recorded snapshot carries the countdown');
  assert.equal(ev.filter((e) => e.type === EV.MATCH_START).length, 1);
  assert.equal(ev.filter((e) => e.type === EV.MATCH_END).length, 1);
  assert.equal(ev[ev.length - 1].type, EV.MATCH_END, 'the demo ends with MATCH_END');
  const deaths = ev.filter((e) => e.type === EV.DEATH && e.id === R.idB);
  assert.ok(deaths.length >= 2, `${deaths.length} deaths recorded`);
  assert.ok(ev.some((e) => e.type === EV.FIRE && e.id === R.idA), 'the recorder\'s own shots are in the demo (server events)');
  // summary
  assert.equal(demo.end.winner, R.idA); assert.ok(demo.end.scores[R.idA] && demo.end.scores[R.idB]);
  const s = demoSummary(demo);
  assert.equal(s.map, 'testbox'); assert.equal(s.players[0].name, 'Recorder'); assert.ok(s.players[0].local);
  assert.ok(s.players[0].frags >= deaths.length, `summary frags ${s.players[0].frags}`);
  const frags = demoFrags(demo);
  assert.equal(frags.length, ev.filter((e) => e.type === EV.DEATH).length);
  assert.ok(frags.every((f) => f.t >= 0 && f.t <= demo.duration && f.victimName));
  // views cover the whole demo at up to 60 Hz (here ~40 Hz: a 2 ms Node timer next to two client sims and the server in
  // one process fires every ~25 ms; the browser samples from requestAnimationFrame, its rate is measured in the evidence run)
  const views = demo.views;
  assert.ok(views.length > demo.duration / 1000 * 30 && views.length <= demo.duration / 1000 * 61, `${views.length} view samples for ${demo.duration} ms`);
  for (let i = 1; i < views.length; i++) assert.ok(views[i][0] > views[i - 1][0], 'view render times are strictly increasing');
  // B's recorder was stopped before the end: a partial demo, marked as such
  const partial = R.demos.find((d) => d.localId === R.idB);
  assert.ok(partial && partial.aborted && !partial.end, 'the client that left mid-match keeps a partial demo');
  assert.ok(partial.duration >= 2000);
  console.log(`demo: ${demo.snaps.length} snapshots, ${views.length} views, ${ev.length} events, ${frags.length} frags, ${demo.duration} ms`);
});

test('round trip: expanded snapshots equal the live ones (remote exact, local player within 1/256 unit)', () => {
  const byT = new Map(R.raw.map((s) => [s.t, s]));
  let checked = 0;
  for (let i = 0; i < demo.snaps.length; i++) {
    const x = expandSnapshot(demo, i), live = byT.get(x.t);
    assert.ok(live, 'every recorded snapshot was received');
    assert.equal(x.tick, live.tick); assert.deepEqual(x.items, live.items); assert.deepEqual(x.match, live.match); assert.deepEqual(x.ev, live.ev);
    assert.deepEqual(x.projectiles, live.projectiles);
    for (const lp of live.players) {
      const xp = x.players.find((p) => p.id === lp.id);
      assert.ok(xp); assert.equal(xp.n, lp.n);
      if (lp.id === R.idA) { assert.ok(dist(xp.o, lp.o) <= 1 / 256 * Math.sqrt(3) + 1e-9, 'local origin quantised to 1/128'); }
      else { assert.deepEqual(xp.o, lp.o); assert.deepEqual(xp.v, lp.v); assert.deepEqual(xp.a, lp.a); }
      for (const k of ['h', 'ar', 'w', 'd', 'f', 'dt', 'pf', 'g', 'vh', 'wp', 'ts', 'st', 'dth', 'ws']) assert.equal(xp[k], lp[k], `${k} of ${lp.n} in snapshot ${i}`);
      for (const w in lp.am) assert.equal(xp.am[w], lp.am[w]);
    }
    checked++;
  }
  assert.ok(checked > 400);
});

test('cursor: seeking to arbitrary times returns exactly what a live ClientGame interpolates; views come back within quantisation', () => {
  // a real ClientGame fed the raw snapshots, its render clock pinned to the time under test: the reference
  const ref = new ClientGame(map, { onmessage: null, send() {}, close() {} }, { name: 'ref' });
  ref.localId = R.idA; ref.snapshots = R.raw.filter((s) => s.t <= demo.t0 + demo.duration); // what the client held while the match ran
  const cur = new DemoCursor(demo);
  assert.equal(cur.duration, demo.duration);
  let rnd = 12345; const rand = () => { rnd = (rnd * 1664525 + 1013904223) >>> 0; return rnd / 4294967296; };
  let maxErr = 0, checked = 0;
  for (let k = 0; k < 400; k++) {
    const D = k < 4 ? [0, demo.duration, 1, demo.duration - 1][k] : rand() * demo.duration;
    cur.seek(D);
    ref.renderTime = () => demo.t0 + D; ref.interpolate();
    const live = ref.remote.get(R.idB), mine = cur.players.get(R.idB);
    assert.ok(live && mine, 'the opponent is present at ' + D);
    const err = dist(live.origin, mine.origin); maxErr = Math.max(maxErr, err);
    assert.ok(err < 1e-9, `remote origin at ${D.toFixed(1)} ms: ${err}`);
    assert.ok(Math.abs(live.angles[0] - mine.angles[0]) < 1e-9 && Math.abs(live.angles[1] - mine.angles[1]) < 1e-9, 'angles');
    assert.equal(mine.h, live.h); assert.equal(mine.d, live.d); assert.equal(mine.w, live.w);
    assert.deepEqual(cur.projectiles.map((p) => p.origin), ref.remoteProjectiles.map((p) => p.origin));
    assert.equal(cur.latest.t, ref.latestSnap.t);
    checked++;
  }
  // the recorded view: at a kept sample's stored time the origin is within the 1/128 quantisation, angles within 0.01 deg
  // (the recorder keeps ~60 Hz of the offered samples; between kept samples the view is blended)
  let maxV = 0, nV = 0;
  for (const rv of R.rawViews) {
    const D = rv.row[0] / 10; if (D < 0 || D > demo.duration) continue;
    const v = cur.viewAt(D); if (!v) continue;
    const e = dist(v.origin, rv.origin); maxV = Math.max(maxV, e); nV++;
    assert.ok(e <= 1 / 256 * Math.sqrt(3) + 0.02, `view origin at ${D.toFixed(1)}: ${e}`);
    assert.ok(Math.abs(v.angles[1] - rv.angles[1]) < 0.02 || Math.abs(Math.abs(v.angles[1] - rv.angles[1]) - 360) < 0.02, `view yaw at ${D.toFixed(1)}`);
  }
  assert.ok(nV > 200, `${nV} view samples compared`);
  // seeking is deterministic: the same time gives the same state whichever way we got there
  const stateAt = (D) => { cur.seek(D); return JSON.stringify([...cur.players.values()].map((p) => [p.id, p.origin, p.angles, p.h]), cur.projectiles, cur.latest.t); };
  const D1 = demo.duration * 0.6, D2 = demo.duration * 0.2;
  const s1 = stateAt(D1); stateAt(D2); assert.equal(stateAt(D1), s1); cur.seek(demo.duration); assert.equal(stateAt(D1), s1);
  console.log(`seek accuracy: remote max error ${maxErr.toExponential(2)} units over ${checked} seeks; view max error ${maxV.toFixed(4)} units over ${nV} samples`);
});

test('cursor: events replay exactly once, in order, at speed 1 and speed 4; a seek skips the past and replays the rest', () => {
  const all = demo.snaps.flatMap((r) => r[7] || []);
  for (const speed of [1, 4]) {
    const got = [];
    const cur = new DemoCursor(demo, { onEvent: (e) => got.push(e) });
    const step = TICK_MS * speed;
    for (let D = 0; D < demo.duration + step; D += step) cur.advance(Math.min(D, demo.duration));
    assert.equal(cur.time, demo.duration);
    assert.deepEqual(got, all, `speed ${speed}: every event once, in order`);
    // fire times: an event fires when the demo clock passes its snapshot time minus the interpolation delay
    const delay = (1000 / demo.snapRate) * demo.interpSnaps;
    assert.equal(cur.interpDelay, delay);
    const endEv = cur.events[cur.events.length - 1]; assert.equal(endEv.e.type, EV.MATCH_END); assert.equal(endEv.at, demo.duration - delay);
  }
  // seek to the middle: nothing from before fires, everything after fires once; seeking back replays
  const got = [];
  const cur = new DemoCursor(demo, { onEvent: (e) => got.push(e) });
  const mid = demo.duration / 2;
  cur.seek(mid);
  for (let D = mid; D <= demo.duration; D += 50) cur.advance(D); cur.advance(demo.duration);
  const expected = cur.events.filter((x) => x.at >= mid).map((x) => x.e);
  assert.deepEqual(got, expected);
  assert.ok(got.length > 0 && got.length < all.length);
  got.length = 0; cur.seek(0); cur.advance(demo.duration); assert.deepEqual(got, all, 'after seeking back to 0 the whole timeline replays once');
  got.length = 0; cur.advance(mid); assert.deepEqual(got, [], 'advancing backwards is a seek: no replay');
});

test('size: a minute of demo (JSON and gzip) and the in-memory row count stay small', () => {
  const json = JSON.stringify(demo);
  const gz = gzipSync(json).length;
  const perMin = (b) => b / (demo.duration / 60000);
  const snapBytes = JSON.stringify(demo.snaps).length / demo.snaps.length, viewBytes = JSON.stringify(demo.views).length / Math.max(1, demo.views.length);
  console.log(`size: ${(json.length / 1024).toFixed(0)} KB JSON (${(gz / 1024).toFixed(0)} KB gzip) for ${(demo.duration / 1000).toFixed(1)} s = ${(perMin(json.length) / 1024).toFixed(0)} KB/min JSON, ${(perMin(gz) / 1024).toFixed(0)} KB/min gzip; ${snapBytes.toFixed(0)} B per snapshot row, ${viewBytes.toFixed(0)} B per view sample; 10 min = ${(perMin(json.length) * 10 / 1024 / 1024).toFixed(1)} MB JSON`);
  assert.ok(perMin(json.length) < 3 * 1024 * 1024, `JSON per minute ${(perMin(json.length) / 1024).toFixed(0)} KB`);
  assert.ok(perMin(gz) < 400 * 1024, `gzip per minute ${(perMin(gz) / 1024).toFixed(0)} KB`);
  assert.equal(demo.items.length < demo.snaps.length / 10, true, 'item arrays are stored only when they change');
  assert.equal(demo.matches.length < 20, true, 'match states are stored only when they change');
  // the JSON survives a round trip through text (what IndexedDB / a downloaded file holds)
  const back = JSON.parse(json);
  assert.equal(validateDemo(back), null);
  const c = new DemoCursor(back); c.seek(1000); assert.ok(c.players.size === 2);
});
