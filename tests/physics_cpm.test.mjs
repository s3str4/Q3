// The `physics` match rule: vq3 (default, unchanged) vs cpm (Challenge ProMode air control, shared/pmove.js airMove).
// Measured on the flat test world: a cpm player holding forward in the air steers its velocity toward the view, a
// sideways-only strafe gains speed much faster than vq3, diagonal strafes and the ground are identical to vq3, and the
// rule travels Game -> pmove ctx and GameSession -> WELCOME rules. Also the JOIN skin / colour validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pmove } from '../shared/pmove.js';
import { angleVectors } from '../shared/vec3.js';
import { GameSession } from '../shared/session.js';
import { loadMap } from '../shared/map.js';
import { PROTOCOL_VERSION, MSG } from '../shared/protocol.js';
import { MATCH, CPM, PM, PLAYER_SKINS, PLAYER_COLORS } from '../shared/constants.js';
import { flatWorld, roomMap, cmd, standing, speed2d, Game } from './helpers.mjs';

const RAD = 180 / Math.PI;
const heading = (ps) => Math.atan2(ps.velocity[1], ps.velocity[0]) * RAD;
// run n ticks under a physics rule; c is a command or (tick, ps) -> command
function run(ps, world, physics, c, n) {
  for (let i = 0; i < n; i++) pmove(ps, typeof c === 'function' ? c(i, ps) : c, { world, entities: [], events: [], physics });
  return ps;
}
// a player 600 units up (airborne for the whole measurement: 1 s of fall is 400 units) moving +X at 320 ups
function airborne(world, speed = 320) { const ps = standing(world); ps.origin = [0, 0, 600]; ps.velocity = [speed, 0, 0]; ps.groundEntity = false; return ps; }

test('physics: vq3 is the default rule and an unset ctx.physics is bit-identical to vq3', () => {
  assert.equal(MATCH.duel.physics, 'vq3'); assert.equal(MATCH.arena.physics, 'vq3');
  assert.equal(PM.airaccelerate, 1);
  const world = flatWorld();
  const a = standing(world), b = standing(world);
  let yaw = 0;
  const strafe = (i, ps) => { if (!ps.groundEntity) yaw -= 0.45; return cmd({ forward: 127, right: 127, buttons: ps.groundEntity ? 2 : 0, angles: [0, yaw, 0] }); };
  run(a, world, undefined, strafe, 300); yaw = 0; run(b, world, 'vq3', strafe, 300);
  assert.deepEqual(a.velocity, b.velocity); assert.deepEqual(a.origin, b.origin);
  // an unknown rule value falls back to vq3 in the Game
  assert.equal(new Game(roomMap(), { rules: { physics: 'bogus' } }).rules.physics, 'vq3');
  assert.equal(new Game(roomMap(), { rules: { physics: 'cpm' } }).rules.physics, 'cpm');
});

test('cpm: holding forward in the air turns the velocity toward the view (measured heading change)', () => {
  const world = flatWorld();
  const VIEW = 60; // view yaw 60 degrees off the +X velocity
  const fwd = cmd({ forward: 127, angles: [0, VIEW, 0] });
  const vq3 = run(airborne(world), world, 'vq3', fwd, 40);
  const cpm = run(airborne(world), world, 'cpm', fwd, 40);
  const hV = heading(vq3), hC = heading(cpm);
  console.log(`air control after 40 ticks (view ${VIEW} deg): vq3 heading ${hV.toFixed(1)} deg @ ${speed2d(vq3).toFixed(1)} ups, cpm heading ${hC.toFixed(1)} deg @ ${speed2d(cpm).toFixed(1)} ups`);
  assert.ok(Math.abs(hC - VIEW) < 5, `cpm heading ${hC.toFixed(1)} should reach the view direction ${VIEW}`);
  assert.ok(hC - hV > 20, `cpm turns much more than vq3 (${hC.toFixed(1)} vs ${hV.toFixed(1)})`);
  // air control rotates (no speed of its own); airaccelerate 1 still adds 5.33 ups/tick along the wish direction,
  // which under vq3 stacks sideways into a larger off-axis speed
  assert.ok(speed2d(cpm) > 320 && speed2d(cpm) < speed2d(vq3), `cpm ${speed2d(cpm).toFixed(1)} vs vq3 ${speed2d(vq3).toFixed(1)}`);
  assert.equal(CPM.aircontrol, 150);
  // air control never acts while slowing down (view straight behind the velocity, dot < 0): the heading stays put,
  // only airstopaccelerate brakes
  const back = run(airborne(world), world, 'cpm', cmd({ forward: 127, angles: [0, 180, 0] }), 10);
  assert.ok(Math.abs(heading(back)) < 1e-6 && speed2d(back) < 320, `braking only: heading ${heading(back).toFixed(1)}, speed ${speed2d(back).toFixed(1)}`);
  // diagonal strafes are vq3 (airaccelerate 1, no control): identical under both rules
  const diag = cmd({ forward: 127, right: 127, angles: [0, 20, 0] });
  assert.deepEqual(run(airborne(world), world, 'cpm', diag, 40).velocity, run(airborne(world), world, 'vq3', diag, 40).velocity);
});

test('cpm: a sideways-only air strafe (wishspeed 30, accel 70) gains speed far faster than vq3', () => {
  const world = flatWorld();
  // each tick aim the right vector 90 degrees off the current velocity (the wish direction of a pure A/D strafe)
  const side = (i, ps) => {
    const h = heading(ps);
    let yaw = h + 180; // right = (sin yaw, -cos yaw) points at yaw - 90 = h + 90
    const r = angleVectors([0, yaw, 0]).right;
    assert.ok(Math.abs(r[0] * ps.velocity[0] + r[1] * ps.velocity[1]) < 1e-6 * speed2d(ps) + 1e-6, 'wishdir perpendicular to the velocity');
    return cmd({ right: 127, angles: [0, yaw, 0] });
  };
  const vq3 = run(airborne(world), world, 'vq3', side, 60);
  const cpm = run(airborne(world), world, 'cpm', side, 60);
  console.log(`side strafe after 60 ticks: vq3 ${speed2d(vq3).toFixed(1)} ups, cpm ${speed2d(cpm).toFixed(1)} ups`);
  // analytic: cpm adds 30 ups perpendicular per tick (sqrt(320^2 + 60*30^2) = 395.5), vq3 adds 5.33 (322.7)
  assert.ok(Math.abs(speed2d(cpm) - 395.5) < 2, `cpm ${speed2d(cpm).toFixed(1)} ~ 395.5`);
  assert.ok(Math.abs(speed2d(vq3) - 322.7) < 2, `vq3 ${speed2d(vq3).toFixed(1)} ~ 322.7`);
  assert.ok(speed2d(cpm) - speed2d(vq3) > 40, 'cpm strafes gain speed faster');
  // reversing direction in the air uses airstopaccelerate 2.5 (vq3: 1)
  const stopV = run(airborne(world), world, 'vq3', cmd({ forward: 127, angles: [0, 180, 0] }), 30);
  const stopC = run(airborne(world), world, 'cpm', cmd({ forward: 127, angles: [0, 180, 0] }), 30);
  assert.ok(stopC.velocity[0] < stopV.velocity[0] - 50, `cpm brakes faster: ${stopC.velocity[0].toFixed(1)} vs ${stopV.velocity[0].toFixed(1)}`);
  // ground movement stays vq3 under cpm (accelerate 10, friction 6): identical run-up and stop
  const g1 = standing(world), g2 = standing(world);
  run(g1, world, 'vq3', cmd({ forward: 127 }), 120); run(g2, world, 'cpm', cmd({ forward: 127 }), 120);
  assert.deepEqual(g1.velocity, g2.velocity); assert.ok(Math.abs(speed2d(g2) - 320) < 0.5);
});

test('the physics rule reaches pmove through the Game and the session sends it in WELCOME / MAPCHANGE rules', async () => {
  const world = flatWorld();
  // Game.runPlayerCommand passes rules.physics: the same forward-in-air command steers under cpm and not under vq3
  const steer = (physics) => {
    const g = new Game(roomMap(), { rules: { warmup: 0, physics } });
    const p = g.addPlayer(1, 'a'); g.addPlayer(2, 'b');
    for (let i = 0; i < 200 && g.match.state !== 'playing'; i++) g.step();
    p.ps.origin = [0, 0, 200]; p.ps.velocity = [320, 0, 0]; p.ps.groundEntity = false;
    for (let i = 0; i < 20; i++) g.runPlayerCommand(p, cmd({ seq: i + 1, forward: 127, angles: [0, 60, 0] }));
    return heading(p.ps);
  };
  const hC = steer('cpm'), hV = steer('vq3');
  assert.ok(hC - hV > 20, `game-level steering cpm ${hC.toFixed(1)} vs vq3 ${hV.toFixed(1)}`);
  const testbox = await loadMap('testbox');
  const s = new GameSession(testbox, { rules: { warmup: 0, physics: 'cpm' } });
  const out = []; const link = { onmessage: null, onclose: null, close() {}, send: (o) => out.push(o) };
  s.attach(link);
  link.onmessage({ t: MSG.JOIN, name: 'A', v: PROTOCOL_VERSION, skin: 'visor', color: 3 });
  const welcome = out.find((m) => m.t === MSG.WELCOME);
  assert.equal(welcome.rules.physics, 'cpm');
  assert.equal(s.game.rules.physics, 'cpm');
  // identity: echoed in the snapshot for everyone; invalid values mean the defaults (no sk / col fields)
  let snap = s.game.snapshot().players.find((p) => p.id === welcome.id);
  assert.equal(snap.sk, 'visor'); assert.equal(snap.col, 3);
  const out2 = []; const link2 = { onmessage: null, onclose: null, close() {}, send: (o) => out2.push(o) };
  s.attach(link2);
  link2.onmessage({ t: MSG.JOIN, name: 'B', v: PROTOCOL_VERSION, skin: 'bogus', color: 99 });
  const w2 = out2.find((m) => m.t === MSG.WELCOME);
  snap = s.game.snapshot().players.find((p) => p.id === w2.id);
  assert.equal(snap.sk, undefined); assert.equal(snap.col, undefined);
  assert.ok(PLAYER_SKINS.length === 3 && PLAYER_COLORS.length === 9);
  // the identity survives a map change (the session rebuilds its Game with the same players)
  await s.changeMap('tight_deck', 'arena');
  snap = s.game.snapshot().players.find((p) => p.id === welcome.id);
  assert.equal(snap.sk, 'visor'); assert.equal(snap.col, 3);
  assert.equal(s.game.rules.physics, 'cpm');
});
