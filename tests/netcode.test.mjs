// End-to-end netcode: the real server (server/index.mjs) in-process, real WebSockets, two headless clients built on
// client/net/clientgame.js driving scripted input at 60 Hz, under simulated latency / jitter / loss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.mjs';
import { connectHeadless, sleep } from '../client/net/headless.js';
import { loadMap } from '../shared/map.js';
import { BUTTONS, WEAPONS, EV } from '../shared/constants.js';
import { PROTOCOL_VERSION, MSG } from '../shared/protocol.js';
import { vectorToAngles, sub, dist } from '../shared/vec3.js';
import { GameSession } from '../shared/session.js';

// Servers listen on an ephemeral port (0) so concurrent test runs never collide.

const nextPort = () => 0;
const map = await loadMap('testbox');

// scripted movement: run, strafe, turn, jump (covers ground accel, friction, air control, jumping, wall sliding)
const mover = (phase) => (t, cg, ys) => {
  ys.yaw = phase + Math.sin(t * 1.3 + phase) * 70;
  return { forward: Math.sin(t * 0.9 + phase) > -0.3 ? 127 : -127, right: Math.sin(t * 2.1 + phase) > 0 ? 127 : -127, buttons: (Math.floor(t * 4 + phase) % 3 === 0) ? BUTTONS.JUMP : 0 };
};

// Every resource is released even when the join handshake fails (a leaked listening server would keep the test
// runner alive forever).
async function startPair(netsim, opts = {}) {
  const server = await createServer({ port: nextPort(), map: 'testbox', quiet: true, netsimQuery: true, ...netsim, rules: { warmup: 500 }, ...opts });
  const port = server.port;
  const q = (n) => `ws://127.0.0.1:${port}/?latency=${n.latency ?? netsim.latency ?? 0}&jitter=${n.jitter ?? netsim.jitter ?? 0}&loss=${n.loss ?? netsim.loss ?? 0}`;
  let A = null, B = null;
  const stop = async () => { if (A) A.stop(); if (B) B.stop(); await server.close(); };
  try {
    A = await connectHeadless({ url: q(opts.simA || {}), map, name: 'A', script: opts.scriptA || mover(0) });
    B = await connectHeadless({ url: q(opts.simB || {}), map, name: 'B', script: opts.scriptB || mover(90) });
    await A.waitFor((cg) => cg.predicted && cg.game.match.state === 'playing', 15000);
    await B.waitFor((cg) => cg.predicted && cg.game.match.state === 'playing', 15000);
  } catch (e) { await stop(); throw e; }
  return { server, A, B, port, stop };
}

async function measure(pair, seconds) {
  const { A, B } = pair;
  await sleep(300);
  for (const c of [A, B]) { c.cg.mispredMax = 0; c.cg.corrections = 0; }
  const s0 = [A.stats(), B.stats()];
  const t0 = performance.now();
  let maxErr = 0, negHealth = false;
  while (performance.now() - t0 < seconds * 1000) {
    await sleep(25);
    maxErr = Math.max(maxErr, A.cg.misprediction, B.cg.misprediction);
    for (const c of [A, B]) for (const p of c.cg.game.players.values()) if (p.health < 0 && !p.dead) negHealth = true;
    for (const p of pair.server.game.players.values()) if (p.health < 0 && !p.dead) negHealth = true;
  }
  const dt = (performance.now() - t0) / 1000;
  const s1 = [A.stats(), B.stats()];
  return [0, 1].map((i) => ({
    ...s1[i], maxErrSampled: maxErr, negHealth,
    cmdRate: (s1[i].cmds - s0[i].cmds) / dt, snapRate: (s1[i].snaps - s0[i].snaps) / dt,
    kbIn: (s1[i].bytesIn - s0[i].bytesIn) / dt / 1024, kbOut: (s1[i].bytesOut - s0[i].bytesOut) / dt / 1024,
  }));
}

test('LAN (0 ms): prediction is exact, commands are acked, snapshots arrive at the server rate', async () => {
  const pair = await startPair({ latency: 0, jitter: 0, loss: 0 });
  try {
    const [a, b] = await measure(pair, 6);
    for (const s of [a, b]) {
      assert.ok(s.mispredMax < 0.01, `misprediction max ${s.mispredMax}`);
      assert.equal(s.corrections, 0, 'no corrections');
      assert.ok(s.cmds - s.acked <= 3, `acked ${s.acked} of ${s.cmds} commands`);
      assert.ok(Math.abs(s.snapRate - 60) < 6, `snapshot rate ${s.snapRate.toFixed(1)} Hz`);
      assert.ok(Math.abs(s.snapHz - 60) < 6, `observed snapshot spacing ${s.snapHz.toFixed(1)} Hz`);
      assert.ok(Math.abs(s.cmdRate - 60) < 4, `command rate ${s.cmdRate.toFixed(1)} Hz`);
      assert.ok(s.rtt < 20, `rtt ${s.rtt}`);
    }
    const tick = pair.server.session.tickStats();
    assert.ok(tick.avg < 2, `server tick avg ${tick.avg} ms`);
    // the server saw the player move (the scripted input really drives the authoritative sim)
    const sp = pair.server.game.players.get(pair.A.id);
    assert.ok(dist(sp.ps.origin, pair.server.game.map.spawns[0].origin) > 0 && sp.lastCmdSeq > 300, `server executed ${sp.lastCmdSeq} commands`);
    assert.equal(pair.server.session.clients.get(pair.A.id).cmdsDropped, 0);
  } finally { await pair.stop(); }
});

for (const netsim of [{ latency: 100, jitter: 20, loss: 2 }, { latency: 150, jitter: 30, loss: 2 }]) {
  test(`${netsim.latency}±${netsim.jitter} ms, ${netsim.loss}% loss: misprediction stays < 0.5 units, state consistent`, async () => {
    const pair = await startPair(netsim);
    try {
      const [a, b] = await measure(pair, 6);
      for (const s of [a, b]) {
        assert.ok(s.mispredMax < 0.5, `misprediction max ${s.mispredMax}`);
        assert.ok(s.rtt > netsim.latency - 30 && s.rtt < netsim.latency + 80, `rtt ${s.rtt.toFixed(0)} ms`);
        assert.ok(s.snapRate > 60 * (1 - netsim.loss / 100) - 8, `snapshot rate ${s.snapRate.toFixed(1)} Hz`);
        assert.ok(s.cmds - s.acked < 30, `acked ${s.acked} of ${s.cmds}`);
        assert.equal(s.negHealth, false);
      }
      // both clients agree with the server on frags/deaths/health after settling
      await sleep(500);
      for (const c of [pair.A, pair.B]) for (const sp of pair.server.game.players.values()) {
        const cp = c.cg.game.players.get(sp.id);
        assert.equal(cp.frags, sp.frags); assert.equal(cp.deaths, sp.deaths);
        assert.ok(cp.health >= 0 && cp.health <= 200, `health ${cp.health}`);
      }
    } finally { await pair.stop(); }
  });
}

test('150 ms combat: hits, deaths and respawns stay consistent across server and both clients; respawn is not a correction', async () => {
  const netsim = { latency: 150, jitter: 30, loss: 2 };
  // A stands and machineguns B; B strafes in front of A with 0 armor and low health so several deaths happen.
  // `fighting` is cleared before the consistency asserts so A releases the trigger (no live fight while comparing).
  let fighting = true;
  const scriptA = (t, cg, ys) => {
    const other = [...cg.remote.values()][0];
    if (other) { const eye = [cg.predicted.ps.origin[0], cg.predicted.ps.origin[1], cg.predicted.ps.origin[2] + cg.predicted.ps.viewHeight]; const a = vectorToAngles(sub([other.origin[0], other.origin[1], other.origin[2] + 4], eye)); ys.pitch = a[0]; ys.yaw = a[1]; }
    return { buttons: fighting ? BUTTONS.ATTACK : 0, weapon: WEAPONS.MACHINEGUN };
  };
  const scriptB = (t, cg, ys) => { ys.yaw = 90; return { right: Math.sin(t * 2) > 0 ? 127 : -127, buttons: cg.predicted && cg.predicted.dead ? BUTTONS.ATTACK : 0 }; };
  const pair = await startPair(netsim, { scriptA, scriptB });
  try {
    const { server, A, B } = pair;
    const sa = server.game.players.get(A.id), sb = server.game.players.get(B.id);
    sa.ps.origin = [-400, 0, 24]; sb.ps.origin = [-100, 0, 24]; sa.ammo[WEAPONS.MACHINEGUN] = 9999;
    await sleep(600);
    B.cg.corrections = 0; B.cg.mispredMax = 0;
    const t0 = performance.now();
    let negHealth = false, deathsSeen = 0;
    while (performance.now() - t0 < 12000) {
      await sleep(30);
      sb.armor = 0; if (!sb.dead && sb.health > 30) sb.health = 30; // keep the kills coming
      // after a respawn (far from A by design) bring B back into A's view the way a teleporter would
      if (!sb.dead && Math.hypot(sb.ps.origin[0] + 100, sb.ps.origin[1]) > 350) { sb.ps.origin = [-100, 0, 24]; sb.ps.velocity = [0, 0, 0]; sb.teleportSeq = (sb.teleportSeq || 0) + 1; }
      for (const c of [A, B]) for (const p of c.cg.game.players.values()) if (p.health < 0 && !p.dead) negHealth = true;
      deathsSeen = Math.max(deathsSeen, sb.deaths);
    }
    assert.equal(negHealth, false, 'no live player with negative health on any client');
    assert.ok(sb.deaths >= 2, `B died ${sb.deaths} times`);
    assert.ok(sa.hits >= 15, `A landed ${sa.hits} hits`);
    assert.equal(sa.frags, sb.deaths, 'every death of B is a frag for A (no suicides possible here)');
    // end the fight: A releases the trigger and its ammo is removed (in-flight commands cannot fire), then wait for
    // the last snapshots / events to reach both clients before comparing state
    fighting = false; sa.ammo[WEAPONS.MACHINEGUN] = 0;
    await sleep(1200);
    assert.equal(sa.frags, sb.deaths);
    for (const p of server.game.players.values()) assert.ok(!p.dead || server.game.time - p.deathTime < 900, `${p.name} settled`);
    for (const c of [A, B]) {
      for (const sp of server.game.players.values()) {
        const cp = c.cg.game.players.get(sp.id);
        assert.equal(cp.frags, sp.frags, `frags on client ${c.cg.name}`); assert.equal(cp.deaths, sp.deaths, `deaths on client ${c.cg.name}`);
      }
      const deaths = c.events.filter((e) => e.type === EV.DEATH && e.id === B.id).length;
      assert.ok(deaths >= 2, `client ${c.cg.name} saw ${deaths} death events`);
    }
    // B was respawned several times (server-chosen spot): those jumps must not count as prediction corrections,
    // and B's own movement corrections (knockback from MG is not predictable) must stay bounded
    assert.ok(B.cg.mispredMax < 64, `B misprediction max ${B.cg.mispredMax.toFixed(1)} (knockback only)`);
  } finally { await pair.stop(); }
});

async function lagCompTrial(lagComp) {
  const netsim = { latency: 0, jitter: 0, loss: 0 };
  // shooter at 150 ms ping fires the lightning gun at the target's interpolated (rendered) position; the target is a
  // LAN client strafing across the shooter's view at 320 ups, reversing every second.
  const scriptA = (t, cg, ys) => {
    const other = [...cg.remote.values()][0];
    if (!other || !cg.predicted) return {};
    const eye = [cg.predicted.ps.origin[0], cg.predicted.ps.origin[1], cg.predicted.ps.origin[2] + cg.predicted.ps.viewHeight];
    const a = vectorToAngles(sub([other.origin[0], other.origin[1], other.origin[2] + 4], eye));
    ys.pitch = a[0]; ys.yaw = a[1];
    return { buttons: t > 1 ? BUTTONS.ATTACK : 0, weapon: WEAPONS.LIGHTNING };
  };
  const scriptB = (t, cg, ys) => { ys.yaw = 0; return { right: Math.sin(t * Math.PI) > 0 ? 127 : -127 }; };
  const pair = await startPair(netsim, { lagComp, simA: { latency: 150 }, simB: { latency: 0 }, scriptA, scriptB });
  try {
    const { server, A, B } = pair;
    const sa = server.game.players.get(A.id), sb = server.game.players.get(B.id);
    // the target must survive ~160 LG hits without being pushed out of range: huge health, Q3 FL_NO_KNOCKBACK
    sa.weapons |= 1 << WEAPONS.LIGHTNING; sa.ammo[WEAPONS.LIGHTNING] = 99999; sb.health = 100000; sb.armor = 0; sb.noKnockback = true;
    sa.ps.origin = [-450, 0, 24]; sb.ps.origin = [0, 0, 24];
    await sleep(1500); // let the shooter switch weapons and the clock sync settle
    sa.shotsBy = {}; sa.hitsBy = {}; sa.lastHitTick = {};
    await sleep(8000);
    const shots = sa.shotsBy[WEAPONS.LIGHTNING] || 0, hits = sa.hitsBy[WEAPONS.LIGHTNING] || 0;
    assert.ok(shots > 100, `fired ${shots} LG shots`);
    assert.ok(Math.abs(A.stats().rtt - 150) < 40, `shooter rtt ${A.stats().rtt.toFixed(0)}`);
    assert.ok(sb.deaths === 0 && sb.health > 90000, 'target survived the trial');
    return { shots, hits, rate: hits / shots };
  } finally { await pair.stop(); }
}

test('lag compensation: a 150 ms shooter aiming at the interpolated target hits >= 85%; far fewer with --no-lagcomp', async () => {
  const on = await lagCompTrial(true);
  const off = await lagCompTrial(false);
  console.log(`lagcomp on: ${on.hits}/${on.shots} = ${(on.rate * 100).toFixed(1)}%   off: ${off.hits}/${off.shots} = ${(off.rate * 100).toFixed(1)}%`);
  assert.ok(on.rate >= 0.85, `hit rate with lag compensation ${(on.rate * 100).toFixed(1)}%`);
  assert.ok(off.rate <= on.rate - 0.3 && off.rate < 0.6, `hit rate without lag compensation ${(off.rate * 100).toFixed(1)}% should be markedly lower`);
});

test('join handshake: a lost WELCOME is recovered by the JOIN retry without adding a ghost player', () => {
  const s = new GameSession(map, { rules: { warmup: 500 } });
  let welcomes = 0, infos = 0, dropped = 0;
  const link = { onmessage: null, onclose: null, close() {}, send(o) { if (o.t === MSG.WELCOME) { if (dropped === 0) { dropped++; return; } welcomes++; } if (o.t === MSG.INFO) infos++; } };
  s.attach(link, {});
  for (let i = 0; i < 4; i++) link.onmessage({ t: MSG.JOIN, name: 'A', v: PROTOCOL_VERSION }); // 1 original + 3 retries (500 ms apart in ClientGame.join)
  assert.equal(dropped, 1);
  assert.equal(welcomes, 3, 'every retry gets a WELCOME');
  assert.ok(infos >= 3);
  assert.equal(s.game.players.size, 1, 'no duplicate player');
  assert.equal([...s.game.players.values()][0].name, 'A');
});

test('server robustness: protocol check, /info, malformed and flooded commands, disconnect mid-match, --host bind', async () => {
  const server = await createServer({ port: nextPort(), host: '127.0.0.1', map: 'testbox', quiet: true, rules: { warmup: 300, timelimit: 4000 } });
  const port = server.port;
  try {
    // /info
    const info = await fetch(`http://127.0.0.1:${port}/info`).then((r) => r.json());
    assert.equal(info.map, 'testbox'); assert.equal(info.mode, 'duel'); assert.equal(info.version, PROTOCOL_VERSION); assert.equal(info.tick, 60);
    // wrong protocol version -> KICK and close
    const bad = new WebSocket(`ws://127.0.0.1:${port}/`);
    const kick = await new Promise((resolve) => { bad.onopen = () => bad.send(JSON.stringify({ t: MSG.JOIN, name: 'old', v: PROTOCOL_VERSION - 1 })); bad.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.t === MSG.KICK) resolve(m.reason); }; });
    assert.match(kick, /protocol mismatch/);
    // garbage frames never crash the server
    const junk = new WebSocket(`ws://127.0.0.1:${port}/`);
    await new Promise((r) => { junk.onopen = r; });
    for (const s of ['not json', '{"t":"cmd","c":"x"}', '[]', JSON.stringify({ t: MSG.JOIN, v: PROTOCOL_VERSION, name: { evil: true } }), JSON.stringify({ t: MSG.PING, c: 'nan' })]) junk.send(s);
    await sleep(100);
    junk.close();
    // two real clients
    const A = await connectHeadless({ url: `ws://127.0.0.1:${port}/`, map, name: 'A', script: mover(0) });
    const B = await connectHeadless({ url: `ws://127.0.0.1:${port}/`, map, name: 'B', script: mover(90) });
    await A.waitFor((cg) => cg.predicted && cg.game.match.state === 'playing', 10000);
    const cA = server.session.clients.get(A.id);
    const pA = server.game.players.get(A.id);
    // malformed commands are dropped (never executed), valid ones keep flowing
    const before = pA.lastCmdSeq;
    A.transport.send({ t: MSG.CMD, c: [{ seq: 1e9, forward: 9999, right: 0, up: 0, angles: [0, 0] }, { seq: 'x' }, null, { seq: 1e9 + 1, forward: 0, right: 0, up: NaN, angles: [0, 0] }, { seq: 1e9 + 2, forward: 0, right: 0, up: 0, angles: [Infinity, 0] }] });
    await sleep(200);
    assert.ok(cA.cmdsDropped >= 5, `dropped ${cA.cmdsDropped} malformed commands`);
    assert.ok(pA.lastCmdSeq > before && pA.lastCmdSeq < 1e8, 'bogus seq never executed, real commands continue');
    // flood: 400 commands in one burst are rate limited and the queue is capped
    const seqBase = A.cg.seq + 1000;
    for (let i = 0; i < 50; i++) A.transport.send({ t: MSG.CMD, c: Array.from({ length: 8 }, (_, k) => ({ seq: seqBase + i * 8 + k, forward: 127, right: 0, up: 0, buttons: 0, angles: [0, 0, 0], weapon: 0 })) });
    await sleep(50);
    assert.ok(pA.cmdQueue.length <= 90, `queue capped: ${pA.cmdQueue.length}`);
    assert.ok(cA.cmdsDropped > 200, `flood dropped ${cA.cmdsDropped}`);
    await sleep(1500);
    assert.equal(server.game.match.state, 'playing');
    // B disconnects mid-match: A keeps playing, match ends at the time limit with A as the winner
    const fragsA = server.game.players.get(A.id).frags;
    B.stop();
    await sleep(300);
    assert.equal(server.game.players.size, 1);
    assert.equal(server.game.match.state, 'playing', 'match continues without the opponent');
    await A.waitFor((cg) => cg.game.match.state === 'ended', 8000);
    assert.equal(server.game.match.winner, A.id);
    assert.equal(A.cg.game.players.get(A.id).frags, fragsA);
    A.stop();
    // --host 127.0.0.1: not reachable on other interfaces is hard to test portably; at least the bound address is right
    assert.equal(server.httpServer.address().address, '127.0.0.1');
  } finally { await server.close(); }
});
