// Asserts every [test] row of docs/BENCHMARK.md against shared/constants.js AND against live simulation measurements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxBrush } from '../shared/brush.js';
import { PM, WEAPONS, WEAPON_DEFS, WEAPON_DROP_TIME, WEAPON_RAISE_TIME, SELF_DAMAGE_SCALE, ARMOR_PROTECTION, HEALTH, ARMOR, ITEMS, BUTTONS, TICK_RATE, EV, LAG_COMP_MAX_MS } from '../shared/constants.js';
import { PMF } from '../shared/pmove.js';
import { flatWorld, roomMap, cmd, runPm, standing, stepGame, ticks, speed2d, Game } from './helpers.mjs';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} not within ${tol} of ${b}`);

// ---------------- Movement constants (bg_pmove.c) ----------------
test('movement constants match vanilla Q3 1.32', () => {
  assert.equal(PM.speed, 320); assert.equal(PM.accelerate, 10); assert.equal(PM.airaccelerate, 1);
  assert.equal(PM.friction, 6); assert.equal(PM.stopspeed, 100); assert.equal(PM.jumpVelocity, 270);
  assert.equal(PM.gravity, 800); assert.equal(PM.stepSize, 18); assert.equal(PM.duckScale, 0.25);
  assert.equal(PM.overclip, 1.001); assert.equal(PM.minWalkNormal, 0.7);
  assert.deepEqual(PM.mins, [-15, -15, -24]); assert.deepEqual(PM.maxs, [15, 15, 32]); assert.deepEqual(PM.duckMaxs, [15, 15, 16]);
  assert.equal(PM.viewHeight, 26); assert.equal(PM.duckViewHeight, 12);
  assert.equal(PM.knockback, 1000); assert.equal(PM.mass, 200); assert.equal(PM.maxKnockback, 200);
  assert.equal(TICK_RATE, 60); assert.equal(LAG_COMP_MAX_MS, 250);
});

test('jump apex from 270 ups at 800 gravity is ~45.6 units (measured)', () => {
  const world = flatWorld();
  const ps = standing(world);
  const base = ps.origin[2];
  let apex = 0, landedTick = -1;
  for (let i = 0; i < 90; i++) {
    runPm(ps, world, cmd({ buttons: BUTTONS.JUMP }), 1);
    apex = Math.max(apex, ps.origin[2] - base);
    if (i > 5 && ps.groundEntity && landedTick < 0) landedTick = i;
  }
  near(apex, 45.6, 0.6, 'jump apex');
  // analytic flight time 2*270/800 = 0.675 s = 40.5 ticks
  near(landedTick, 41, 3, 'flight time in ticks');
});

test('ground speed reaches exactly 320 ups and stops within ~0.5 s (friction 6, stopspeed 100)', () => {
  const world = flatWorld();
  const ps = standing(world);
  runPm(ps, world, cmd({ forward: 127 }), 120);
  near(speed2d(ps), 320, 0.5, 'run speed');
  // diagonal: still 320 (Q3 cmdScale normalizes)
  const ps2 = standing(world);
  runPm(ps2, world, cmd({ forward: 127, right: 127 }), 120);
  near(speed2d(ps2), 320, 0.5, 'diagonal run speed');
  // release: friction brings it to rest
  let stopTicks = 0;
  while (speed2d(ps) > 0 && stopTicks < 120) { runPm(ps, world, cmd(), 1); stopTicks++; }
  assert.ok(stopTicks > 10 && stopTicks < 45, `stop ticks ${stopTicks}`);
});

test('air acceleration lets strafe jumping exceed 320 ups (measured)', () => {
  const world = flatWorld();
  const ps = standing(world);
  let yaw = 0, best = 0;
  for (let t = 0; t < 600; t++) {
    const onGround = ps.groundEntity;
    runPm(ps, world, cmd({ forward: 127, right: 127, buttons: onGround ? BUTTONS.JUMP : 0, angles: [0, yaw, 0] }), 1);
    if (!onGround) yaw -= 0.45; // smooth turn into the strafe while airborne
    best = Math.max(best, speed2d(ps));
    if (Math.abs(ps.origin[0]) > 3000 || Math.abs(ps.origin[1]) > 3000) ps.origin = [0, 0, ps.origin[2]];
  }
  assert.ok(best > 400, `strafe-jump peak speed ${best.toFixed(1)} should exceed 320 clearly`);
  // and plain forward jumping does not gain speed beyond ~320
  const ps2 = standing(world);
  let plain = 0;
  for (let t = 0; t < 300; t++) { runPm(ps2, world, cmd({ forward: 127, buttons: ps2.groundEntity ? BUTTONS.JUMP : 0 }), 1); plain = Math.max(plain, speed2d(ps2)); }
  assert.ok(plain < 330, `plain jumping speed ${plain.toFixed(1)}`);
});

test('step: 16-unit step is climbed, 40-unit block stops the player', () => {
  const world = flatWorld([boxBrush([200, -128, 0], [264, 128, 16], {}), boxBrush([400, -128, 0], [464, 128, 40], {})]);
  const ps = standing(world);
  let onStep = false;
  for (let i = 0; i < 60; i++) {
    runPm(ps, world, cmd({ forward: 127 }), 1);
    if (ps.origin[0] > 215 && ps.origin[0] < 249 && ps.groundEntity) { onStep = true; near(ps.origin[2], 24 + 16, 0.5, 'standing on the 16 step'); }
  }
  assert.ok(onStep, 'walked over the step');
  assert.ok(ps.origin[0] > 264, `x after step ${ps.origin[0].toFixed(1)}`);
  runPm(ps, world, cmd({ forward: 127 }), 60);
  near(ps.origin[0], 400 - 15, 0.5, 'blocked by the 40 block');
  assert.ok(ps.origin[2] < 30, 'did not climb the 40 block');
  // 18 (the step size) also climbs; 19 does not
  const w2 = flatWorld([boxBrush([200, -128, 0], [264, 128, 18], {})]);
  const p2 = standing(w2); runPm(p2, w2, cmd({ forward: 127 }), 60);
  assert.ok(p2.origin[0] > 264, 'climbed 18');
  const w3 = flatWorld([boxBrush([200, -128, 0], [264, 128, 19], {})]);
  const p3 = standing(w3); runPm(p3, w3, cmd({ forward: 127 }), 60);
  near(p3.origin[0], 185, 0.5, 'blocked by 19');
});

test('knockback = damage * 1000 / 200, capped at 200 damage (measured via Game.damage)', () => {
  const g = new Game(roomMap(), { rules: { warmup: 0 } });
  const a = g.addPlayer(1, 'a'), b = g.addPlayer(2, 'b');
  stepGame(g, ticks(3100)); // through countdown into 'playing'
  assert.equal(g.match.state, 'playing');
  a.armor = 200; a.health = 200;
  a.ps.velocity = [0, 0, 0];
  g.damage(a, b, 100, [0, 1, 0], a.ps.origin, WEAPONS.ROCKET, 0);
  near(a.ps.velocity[1], 500, 1e-9, 'knockback velocity for 100 damage');
  a.ps.velocity = [0, 0, 0]; a.armor = 200; a.health = 500;
  g.damage(a, b, 300, [1, 0, 0], a.ps.origin, WEAPONS.ROCKET, 0);
  near(a.ps.velocity[0], 1000, 1e-9, 'knockback capped at 200 damage -> 1000 ups');
});

test('knockback control loss: pm_time = 2*damage clamped to 50..200 ms, then friction/accel return', () => {
  const g = new Game(roomMap(), { rules: { warmup: 0 } });
  const a = g.addPlayer(1, 'a'), b = g.addPlayer(2, 'b');
  stepGame(g, ticks(3100));
  for (const [dmg, expect] of [[10, 50], [60, 120], [150, 200]]) {
    a.ps.pmTime = 0; a.ps.pmFlags &= ~PMF.TIME_KNOCKBACK; a.health = 1000; a.armor = 200;
    g.damage(a, b, dmg, [0, 1, 0], a.ps.origin, WEAPONS.ROCKET, 0);
    assert.equal(a.ps.pmTime, expect, `pm_time for ${dmg} damage`);
    assert.ok(a.ps.pmFlags & PMF.TIME_KNOCKBACK, 'TIME_KNOCKBACK set');
  }
  // while the flag is set ground friction is off and acceleration uses the air value; it clears after pm_time
  const world = flatWorld();
  const ps = standing(world); ps.velocity = [300, 0, 0]; ps.pmTime = 200; ps.pmFlags |= PMF.TIME_KNOCKBACK;
  runPm(ps, world, cmd(), 6); // 100 ms
  near(speed2d(ps), 300, 1, 'no ground friction while knocked back');
  assert.ok(ps.pmFlags & PMF.TIME_KNOCKBACK, 'still knocked back at 100 ms');
  runPm(ps, world, cmd(), 7); // past 200 ms
  assert.equal(ps.pmFlags & PMF.TIME_KNOCKBACK, 0, 'control returns after pm_time');
  runPm(ps, world, cmd(), 6);
  assert.ok(speed2d(ps) < 290, 'friction applies again');
});

// ---------------- Weapons ----------------
test('weapon table matches g_weapon.c', () => {
  const W = WEAPON_DEFS;
  assert.equal(W[WEAPONS.MACHINEGUN].damage, 7); assert.equal(W[WEAPONS.MACHINEGUN].refire, 100); assert.equal(W[WEAPONS.MACHINEGUN].spread, 200);
  assert.equal(W[WEAPONS.SHOTGUN].damage, 10); assert.equal(W[WEAPONS.SHOTGUN].pellets, 11); assert.equal(W[WEAPONS.SHOTGUN].refire, 1000); assert.equal(W[WEAPONS.SHOTGUN].spread, 700);
  assert.equal(W[WEAPONS.ROCKET].damage, 100); assert.equal(W[WEAPONS.ROCKET].refire, 800); assert.equal(W[WEAPONS.ROCKET].speed, 900); assert.equal(W[WEAPONS.ROCKET].splashDamage, 100); assert.equal(W[WEAPONS.ROCKET].splashRadius, 120);
  assert.equal(W[WEAPONS.LIGHTNING].damage, 8); assert.equal(W[WEAPONS.LIGHTNING].refire, 50); assert.equal(W[WEAPONS.LIGHTNING].range, 768);
  assert.equal(W[WEAPONS.RAIL].damage, 100); assert.equal(W[WEAPONS.RAIL].refire, 1500); assert.ok(W[WEAPONS.RAIL].hitscan);
  assert.equal(W[WEAPONS.PLASMA].damage, 20); assert.equal(W[WEAPONS.PLASMA].refire, 100); assert.equal(W[WEAPONS.PLASMA].speed, 2000); assert.equal(W[WEAPONS.PLASMA].splashDamage, 15); assert.equal(W[WEAPONS.PLASMA].splashRadius, 20);
  assert.equal(SELF_DAMAGE_SCALE, 0.5); assert.equal(ARMOR_PROTECTION, 0.66); assert.equal(ARMOR.max, 200);
  assert.equal(WEAPON_DROP_TIME, 200); assert.equal(WEAPON_RAISE_TIME, 250);
});

function playingGame(items = []) {
  const g = new Game(roomMap({ items }), { rules: { warmup: 0 } });
  const a = g.addPlayer(1, 'a'), b = g.addPlayer(2, 'b');
  stepGame(g, ticks(3100));
  assert.equal(g.match.state, 'playing');
  return { g, a, b };
}
function giveAll(p) { for (const w of [2, 3, 5, 6, 7, 8]) { p.weapons |= 1 << w; p.ammo[w] = 200; } }

test('refire rates measured live: MG ~10/s, LG ~20/s, rail 1/1.5s, rocket 1/0.8s, shotgun 1/s, plasma ~10/s', () => {
  for (const [w, perSec, tol] of [[WEAPONS.MACHINEGUN, 10, 1], [WEAPONS.LIGHTNING, 20, 1.5], [WEAPONS.PLASMA, 10, 1], [WEAPONS.SHOTGUN, 1, 0.5], [WEAPONS.ROCKET, 1.25, 0.5], [WEAPONS.RAIL, 1 / 1.5, 0.3]]) {
    const { g, a } = playingGame();
    giveAll(a); a.weapon = w; a.ps.viewangles = [0, 90, 0];
    // aim at the wall, fire held for 3 s
    const ev = stepGame(g, ticks(3000), { 1: cmd({ buttons: BUTTONS.ATTACK, angles: [0, 90, 0] }) });
    const fires = ev.filter((e) => e.type === EV.FIRE && e.id === 1).length;
    near(fires / 3, perSec, tol, `fires per second for weapon ${w}`);
  }
});

test('projectile speeds measured live: rocket 900 ups, plasma 2000 ups', () => {
  for (const [w, sp] of [[WEAPONS.ROCKET, 900], [WEAPONS.PLASMA, 2000]]) {
    const { g, a } = playingGame();
    giveAll(a); a.weapon = w; a.ps.origin = [-900, 0, 24];
    stepGame(g, 1, { 1: cmd({ buttons: BUTTONS.ATTACK, angles: [0, 0, 0] }) });
    const pr = [...g.projectiles.values()][0];
    assert.ok(pr, 'projectile spawned');
    near(Math.hypot(...pr.velocity), sp, 1e-6, 'muzzle speed');
    const x0 = pr.origin[0];
    stepGame(g, 6, { 1: cmd() });
    near(pr.origin[0] - x0, sp * 6 / TICK_RATE, 0.01, 'distance after 6 ticks');
  }
});

test('self damage is halved; armor absorbs 2/3 of damage', () => {
  const { g, a, b } = playingGame();
  a.health = 100; a.armor = 0;
  g.damage(a, a, 100, [0, 0, 1], a.ps.origin, WEAPONS.ROCKET, 1);
  assert.equal(a.health, 50, 'self rocket: 50');
  a.health = 100; a.armor = 100;
  g.damage(a, b, 100, [0, 0, 1], a.ps.origin, WEAPONS.RAIL, 0);
  assert.equal(a.armor, 34, 'armor takes ceil(66)');
  assert.equal(a.health, 66, 'health takes the rest');
  a.health = 100; a.armor = 10;
  g.damage(a, b, 100, [0, 0, 1], a.ps.origin, WEAPONS.RAIL, 0);
  assert.equal(a.armor, 0); assert.equal(a.health, 10, 'armor exhausted, remainder to health');
});

test('weapon switch: 200 ms drop + 250 ms raise, then fire', () => {
  const { g, a } = playingGame();
  giveAll(a); a.weapon = WEAPONS.MACHINEGUN;
  // hold attack and request the rocket launcher: the change event marks the end of the drop, the first rocket the end of the raise
  let tChange = -1, tFire = -1;
  for (let i = 0; i < 60; i++) {
    const e = stepGame(g, 1, { 1: cmd({ weapon: WEAPONS.ROCKET, buttons: BUTTONS.ATTACK, angles: [0, 90, 0] }) });
    if (tChange < 0 && e.some((x) => x.type === EV.WEAPON_CHANGE && x.id === 1)) tChange = i + 1;
    if (tFire < 0 && e.some((x) => x.type === EV.FIRE && x.id === 1 && x.weapon === WEAPONS.ROCKET)) { tFire = i + 1; break; }
  }
  assert.ok(tChange > 0 && tFire > tChange, 'switched and fired');
  near(tChange * 1000 / TICK_RATE, WEAPON_DROP_TIME, 20, 'drop time');
  near((tFire - tChange) * 1000 / TICK_RATE, WEAPON_RAISE_TIME, 20, 'raise time');
  assert.equal(a.weapon, WEAPONS.ROCKET);
});

// ---------------- Items ----------------
test('item table matches bg_misc.c (amounts, caps, respawn times)', () => {
  const I = ITEMS;
  assert.equal(HEALTH.spawn, 125); assert.equal(HEALTH.max, 100); assert.equal(HEALTH.megaMax, 200); assert.equal(HEALTH.decayInterval, 1000);
  assert.deepEqual([I.mega.amount, I.mega.max, I.mega.respawn], [100, 200, 35000]);
  assert.deepEqual([I.health25.amount, I.health25.max, I.health25.respawn], [25, 100, 35000]);
  assert.deepEqual([I.health50.amount, I.health50.max, I.health50.respawn], [50, 100, 35000]);
  assert.deepEqual([I.health5.amount, I.health5.max, I.health5.respawn], [5, 200, 35000]);
  assert.deepEqual([I.armorYellow.amount, I.armorYellow.max, I.armorYellow.respawn], [50, 200, 25000]);
  assert.deepEqual([I.armorRed.amount, I.armorRed.max, I.armorRed.respawn], [100, 200, 25000]);
  for (const k of ['weaponRocket', 'weaponRail', 'weaponLightning', 'weaponShotgun', 'weaponPlasma']) assert.equal(I[k].respawn, 5000, k);
  for (const k of ['ammoRockets', 'ammoSlugs', 'ammoCells', 'ammoShells', 'ammoBullets', 'ammoPlasma']) assert.equal(I[k].respawn, 40000, k);
});

test('spawn health 125 decays 1/s to 100 and stops (measured)', () => {
  const { g, a } = playingGame();
  g.spawnPlayer(a);
  assert.equal(a.health, 125);
  stepGame(g, ticks(1000) + 1); assert.equal(a.health, 124);
  stepGame(g, ticks(24000)); assert.equal(a.health, 100);
  stepGame(g, ticks(5000)); assert.equal(a.health, 100, 'does not decay below 100');
});

test('item respawn times measured live: mega 35 s, red armor 25 s, rocket launcher 5 s, rockets ammo 40 s', () => {
  const items = [{ type: 'mega', origin: [0, 0, 20] }, { type: 'armorRed', origin: [200, 0, 20] }, { type: 'weaponRocket', origin: [400, 0, 20] }, { type: 'ammoRockets', origin: [600, 0, 20] }];
  const { g, a } = playingGame(items);
  for (const [i, expectMs] of [[0, 35000], [1, 25000], [2, 5000], [3, 40000]]) {
    const it = g.items[i];
    a.ps.origin = [it.origin[0], it.origin[1], 24]; a.ps.velocity = [0, 0, 0];
    const ev = stepGame(g, 1, { 1: cmd() });
    assert.ok(ev.some((e) => e.type === EV.PICKUP && e.item === i), `picked up ${it.type}`);
    assert.equal(it.available, false);
    assert.equal(it.respawnAt - g.time, expectMs, `${it.type} respawn delay`);
    a.ps.origin = [-500, -500, 24];
    const t0 = g.time;
    let back = -1;
    for (let k = 0; k < ticks(expectMs) + 5 && back < 0; k++) { const e = stepGame(g, 1, { 1: cmd() }); if (e.some((x) => x.type === EV.ITEM_RESPAWN && x.item === i)) back = g.time - t0; }
    near(back, expectMs, 1000 / TICK_RATE + 0.01, `${it.type} respawned after`);
  }
});
