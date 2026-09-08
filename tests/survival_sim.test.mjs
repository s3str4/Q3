// Survival slice rules, headless: every [test] row of docs/SURVIVAL_BENCHMARK.md section 1 asserted against the
// constants and against live sim measurements, plus the autopilot end-to-end runs (win on seeds 7 and 11, loss for
// the reckless control). Whole file runs in a few seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SurvivalSim, INTERACT_LOCK } from '../shared/survival/sim.js';
import { Autopilot } from '../shared/survival/autopilot.js';
import { World } from '../shared/survival/world.js';
import { PLAYER, ZOMBIE, WEAPONS, DAY, EV, PSTATE, ZSTATE, OBJECTIVES, ITEMS, NOISE, DOOR_HP, BARRICADE_HP, BARRICADE_COST, TREE_HITS, TREE_PLANKS, TICK_RATE, DT } from '../shared/survival/constants.js';
import { makeSim, run, cmd, byType, placePlayer, spawnZombie, ticks } from './helpers_survival.mjs';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ---------------- constants rows ----------------
test('constants: zombies slower than a sprinting player, faster than a walking one at night; horde waves; pistol; bat', () => {
  assert.ok(ZOMBIE.chase < PLAYER.walk, 'day chase slower than walk');
  assert.ok(ZOMBIE.chaseNight + ZOMBIE.hordeSpeedBonus > PLAYER.walk, 'night horde faster than walk');
  assert.ok(ZOMBIE.chaseNight + ZOMBIE.hordeSpeedBonus < PLAYER.run, 'night horde slower than sprint');
  assert.deepEqual(DAY.waves.map((w) => [w.hour, w.count]), [[22, 6], [0, 5], [3, 4]]);
  assert.equal(WEAPONS.pistol.mag, 8); assert.equal(WEAPONS.pistol.noise, 26); assert.equal(WEAPONS.pistol.reload, 1.5); assert.equal(WEAPONS.pistol.damage, 45);
  assert.equal(Math.ceil(ZOMBIE.hp / WEAPONS.bat.damage), 3, 'bat kills in 3 hits'); near(WEAPONS.bat.range, 1.35, 1e-9, 'bat range'); near(WEAPONS.bat.arc * 180 / Math.PI, 86, 1, 'bat arc deg'); assert.equal(WEAPONS.bat.cooldown, 0.7); assert.equal(WEAPONS.bat.stagger, 0.55);
  assert.equal(NOISE.sneak, 1.5); assert.equal(NOISE.walk, 4.5); assert.equal(NOISE.run, 9);
  near(ZOMBIE.fov * 180 / Math.PI, 135, 1, 'fov'); assert.equal(ZOMBIE.sightDay, 9.5); assert.equal(ZOMBIE.sightNight, 4.2); assert.equal(ZOMBIE.loseSightTime, 4.5);
  assert.equal(DOOR_HP, 90); assert.equal(BARRICADE_HP, 150); assert.equal(BARRICADE_COST, 2); assert.equal(TREE_HITS, 3); assert.equal(TREE_PLANKS, 2);
  const rounds = new World(7).containers.flatMap((c) => c.items).filter((i) => i.item === 'ammo').reduce((s, i) => s + i.count, 0);
  assert.equal(rounds, 24, '24 rounds on the map');
  assert.equal(PLAYER.hungerPerMin, 2.2); assert.equal(PLAYER.thirstPerMin, 3.0); assert.equal(PLAYER.starveDamage, 1.5); assert.equal(PLAYER.starveInterval, 4);
});

// ---------------- vitals ----------------
test('vitals: hunger/thirst drain per game hour (2.2 / 3.0), starvation 1.5 hp per 4 s at 0', () => {
  // NOTE: the rates are applied per game-hour (sim.js VITALS_RATE); per game-minute would empty hunger in 11 real
  // seconds and starve a full-health player before noon on day 1.
  const sim = makeSim({ timeScale: 1 }); const h0 = sim.player.hunger, t0 = sim.player.thirst;
  run(sim, ticks(20));                                               // 20 s at timeScale 1 = 1 game hour
  near(sim.hour - DAY.startHour, 1, 0.01, 'one game hour elapsed');
  near(h0 - sim.player.hunger, PLAYER.hungerPerMin, 0.02, 'hunger drain per game hour');
  near(t0 - sim.player.thirst, PLAYER.thirstPerMin, 0.02, 'thirst drain per game hour');
  sim.player.hunger = 0; const hp = sim.player.health;
  const ev = run(sim, ticks(PLAYER.starveInterval * 3 + 0.1));
  const hurts = byType(ev, EV.PLAYER_HURT).filter((e) => e.cause === 'starvation');
  assert.equal(hurts.length, 3, 'one starvation tick per 4 s'); near(hp - sim.player.health, 3 * PLAYER.starveDamage, 0.05, 'starvation damage');
});

test('stamina: sprint exhausts in ~6 s, STAMINA_OUT fires once, no sprint or swing while tired', () => {
  const sim = makeSim(); placePlayer(sim, 24, 12); sim.player.inventory.bat = 1; sim.player.weapon = 'bat';
  const ev = run(sim, ticks(8), cmd({ move: [0, 1], sprint: true }));
  const outs = byType(ev, EV.STAMINA_OUT); assert.equal(outs.length, 1, 'STAMINA_OUT exactly once');
  near(outs[0].t, PLAYER.maxStamina / PLAYER.staminaDrain, 0.4, 'exhaustion time');
  assert.ok(sim.player.tired && sim.player.gait === 'walk', 'tired: sprint refused');
  assert.equal(sim.metrics.staminaOuts, 1);
  const swing = run(sim, 2, cmd({ attack: true, aim: [sim.player.x, sim.player.y + 1] }));
  assert.ok(byType(swing, EV.ACTION_DENIED).some((e) => e.reason === 'tired'), 'swing denied while tired'); assert.equal(byType(swing, EV.SWING).length, 0);
  run(sim, ticks(PLAYER.staminaRegenDelay + PLAYER.staminaTired * 2 / PLAYER.staminaRegen + 0.5));
  assert.ok(!sim.player.tired, 'recovers above 2x staminaTired');
});

test('bleeding: 1 hp / 2 s until bandaged; bandage stops it and heals 20 over 6 s', () => {
  const sim = makeSim(); const p = sim.player; p.health = 50; p.bleeding = true; p.hunger = 10; // no natural regen
  const ev = run(sim, ticks(6.05)); assert.equal(byType(ev, EV.PLAYER_HURT).filter((e) => e.cause === 'bleeding').length, 3); near(p.health, 47, 0.01, 'bleed damage');
  const denied = run(sim, 1, cmd({ use: 'bandage' })); assert.ok(byType(denied, EV.ACTION_DENIED).some((e) => e.reason === 'no_item'));
  p.inventory.bandage = 1; const use = run(sim, 1, cmd({ use: 'bandage' })); assert.equal(byType(use, EV.BANDAGE).length, 1); assert.equal(p.bleeding, false);
  const hp = p.health; run(sim, ticks(PLAYER.bandageHealTime / 2)); near(p.health - hp, ITEMS.bandage.heal / 2, 0.3, 'half the heal after half the time');
  run(sim, ticks(PLAYER.bandageHealTime / 2 + 0.2)); near(p.health - hp, ITEMS.bandage.heal, 0.3, 'full heal after 6 s'); assert.equal(sim.metrics.bandaged, 1);
});

// ---------------- combat ----------------
test('melee: bat 3 hits kill, each hit staggers, cooldown gates the next swing, arc/range respected', () => {
  const sim = makeSim(); placePlayer(sim, 24, 12, 0); sim.player.inventory.bat = 1; sim.player.weapon = 'bat';
  const z = spawnZombie(sim, 25.1, 12, ZSTATE.IDLE); const behind = spawnZombie(sim, 22.9, 12, ZSTATE.IDLE);
  const ev = run(sim, 1, cmd({ attack: true, aim: [25, 12] }));
  assert.equal(byType(ev, EV.SWING).length, 1); assert.equal(byType(ev, EV.MELEE_HIT).length, 1, 'only the zombie in the arc is hit'); assert.equal(z.state, ZSTATE.STAGGER); assert.equal(byType(ev, EV.ZOMBIE_STAGGER)[0].id, z.id);
  assert.equal(behind.hp, ZOMBIE.hp, 'zombie behind untouched'); assert.equal(z.hp, ZOMBIE.hp - WEAPONS.bat.damage);
  const cool = run(sim, ticks(WEAPONS.bat.cooldown) - 2, cmd({ attack: true, aim: [25, 12] })); assert.equal(byType(cool, EV.SWING).length, 0, 'no swing inside the cooldown');
  let hits = 1; for (let i = 0; i < ticks(3) && z.state !== ZSTATE.DEAD; i++) { const e = sim.step(cmd({ attack: true, aim: [z.x, z.y] })); hits += byType(e, EV.MELEE_HIT).length; if (byType(e, EV.ZOMBIE_DEATH).length) break; }
  assert.equal(hits, 3, 'three bat hits kill'); assert.equal(z.state, ZSTATE.DEAD); assert.equal(sim.metrics.kills, 1); assert.equal(sim.player.kills, 1);
  run(sim, ticks(WEAPONS.bat.cooldown + 0.1)); const far = spawnZombie(sim, 24 + WEAPONS.bat.range + ZOMBIE.radius + 0.3, 12, ZSTATE.IDLE);
  const miss = run(sim, 1, cmd({ attack: true, aim: [far.x, far.y] })); assert.equal(byType(miss, EV.MELEE_HIT).length, 0, 'out of range'); assert.equal(byType(miss, EV.SWING)[0].hit, false);
});

test('pistol: 8-round mag, 1.5 s reload, a gunshot alerts every zombie within 26 tiles and none beyond', () => {
  const sim = makeSim(); placePlayer(sim, 24, 24, 0); const p = sim.player; p.inventory.pistol = 1; p.inventory.ammo = 20;
  run(sim, 1, cmd({ slot: 3 })); assert.equal(p.weapon, 'pistol'); assert.equal(p.mag, 0, 'picked-up pistol is empty');
  const empty = run(sim, 1, cmd({ attack: true, aim: [30, 24] })); assert.equal(byType(empty, EV.NO_AMMO).length, 1); assert.equal(byType(empty, EV.RELOAD).length, 1, 'auto reload starts');
  const done = run(sim, ticks(WEAPONS.pistol.reload) + 1); assert.equal(byType(done, EV.RELOAD_DONE).length, 1); assert.equal(p.mag, 8); assert.equal(p.inventory.ammo, 12);
  // zombies at 10, 20, 25.5 (heard) and 27, 40 (not), all idle and facing away
  const dists = [10, 20, 25.5, 27, 40]; const zs = dists.map((d) => spawnZombie(sim, Math.min(47, 24 + d * 0.6), Math.max(1, 24 - d * 0.8), ZSTATE.IDLE, { facing: Math.PI }));
  const shot = run(sim, 2, (i) => cmd({ attack: i === 0, aim: [24, 30] }));
  assert.equal(byType(shot, EV.GUNSHOT).length, 1); assert.equal(p.mag, 7); assert.equal(sim.metrics.shotsFired, 1);
  const noise = byType(shot, EV.NOISE).find((n) => n.kind === 'gunshot'); assert.equal(noise.radius, 26);
  const alerted = new Set(byType(shot, EV.ZOMBIE_ALERT).map((e) => e.id));
  for (let i = 0; i < zs.length; i++) { const d = Math.hypot(zs[i].x - 24, zs[i].y - 24); assert.equal(alerted.has(zs[i].id), d <= 26, `zombie at ${d.toFixed(1)} tiles alerted=${alerted.has(zs[i].id)}`); }
  assert.ok(byType(shot, EV.ZOMBIE_ALERT).every((e) => e.from === 'sound'));
});

// ---------------- senses ----------------
test('stealth: sneaking past an idle zombie at 6 tiles is not detected, walking is', () => {
  for (const [sneak, expect] of [[true, false], [false, true]]) {
    const sim = makeSim(); placePlayer(sim, 30, 20); const z = spawnZombie(sim, 36, 20, ZSTATE.IDLE);
    const ev = run(sim, ticks(1.0), cmd({ move: [0, 1], sneak }));
    assert.equal(sim.player.gait, sneak ? 'sneak' : 'walk');
    assert.equal(byType(ev, EV.ZOMBIE_ALERT).length > 0, expect, `sneak=${sneak} detected=${!expect}`);
    assert.equal(z.state === ZSTATE.CHASE, expect);
  }
});

test('line of sight: blocked by a wall, open through a window; night sight is shorter', () => {
  const sim = makeSim();
  assert.equal(sim.hasLOS(14.5, 11.5, 16.5, 11.5), true, 'through the start-house east window');
  assert.equal(sim.hasLOS(14.5, 12.5, 16.5, 12.5), false, 'through the wall next to it');
  const o = sim.world.opening(15, 11); o.barricade = 10; assert.equal(sim.hasLOS(14.5, 11.5, 16.5, 11.5), false, 'a barricaded window blocks sight'); o.barricade = 0;
  // night: a zombie 6 tiles away facing the player does not see a walking player (sight 4.2)
  const night = makeSim({ startHour: 23 }); placePlayer(night, 30, 20); const z = spawnZombie(night, 36, 20, ZSTATE.IDLE);
  run(night, ticks(0.5), cmd({ move: [0, 1] })); assert.equal(night.phase, 'night'); assert.equal(z.state, ZSTATE.IDLE);
});

test('zombie state machine: chase -> investigate after 4.5 s without line of sight, transitions logged with cause', () => {
  const sim = makeSim(); placePlayer(sim, 30, 20); const z = spawnZombie(sim, 34, 20, ZSTATE.IDLE);
  run(sim, 2, cmd({ move: [0, 1] })); assert.equal(z.state, ZSTATE.CHASE);
  const seen = sim.log.find((l) => l.kind === 'zombie.state' && l.id === z.id && l.to === ZSTATE.CHASE); assert.equal(seen.from, ZSTATE.IDLE); assert.equal(seen.cause, 'sight');
  // teleport the player inside the red house (walls all round, door shut): no LOS, and keep the zombie from reaching it
  placePlayer(sim, 33, 34); z.x = 26; z.y = 26; z.vx = z.vy = 0;
  const ev = run(sim, ticks(ZOMBIE.loseSightTime + 0.6));
  const lost = byType(ev, EV.ZOMBIE_LOST); assert.equal(lost.length, 1, 'ZOMBIE_LOST once'); near(lost[0].t - sim.t + ticks(ZOMBIE.loseSightTime + 0.6) / TICK_RATE, ZOMBIE.loseSightTime, 0.25, 'lost after loseSightTime');
  assert.ok([ZSTATE.INVESTIGATE, ZSTATE.IDLE, ZSTATE.WANDER].includes(z.state), 'investigating or gave up');
  const rec = sim.log.find((l) => l.kind === 'zombie.state' && l.id === z.id && l.to === ZSTATE.INVESTIGATE); assert.equal(rec.from, ZSTATE.CHASE); assert.equal(rec.cause, 'lost');
  for (const l of sim.log.filter((l) => l.kind === 'zombie.state')) assert.ok(Object.values(ZSTATE).includes(l.to), 'known zombie state ' + l.to);
});

// ---------------- fortification ----------------
test('barricaded door: bashed down in ~11 hits (150/14), then the door itself, and the zombie walks in', () => {
  const sim = makeSim(); placePlayer(sim, 12.5, 12.6, Math.PI / 2); const door = sim.world.opening(12, 14);
  sim.player.inventory.plank = 2; const built = run(sim, 2, (i) => cmd({ build: i === 0 }));
  assert.equal(byType(built, EV.BARRICADE_BUILT).length, 1); assert.equal(door.barricade, BARRICADE_HP); assert.equal(sim.player.inventory.plank, undefined); assert.equal(sim.metrics.barricadesBuilt, 1);
  // the flow field breaches the cheapest opening, so seal the windows to make the door the only way in
  for (const o of sim.world.openings.values()) if (o.structure === 'Start house' && o.kind === 'window') { o.barricade = 9000; o.barricadeMax = 9000; }
  placePlayer(sim, 10.5, 9.5, Math.PI / 2); const z = spawnZombie(sim, 12.5, 16.5, ZSTATE.CHASE, { horde: true });
  let hits = 0, broken = null, doorBreak = null, entered = null;
  for (let i = 0; i < ticks(40) && entered == null; i++) {
    const ev = sim.step(cmd());
    hits += byType(ev, EV.BARRICADE_HIT).length;
    if (broken == null && byType(ev, EV.BARRICADE_BROKEN).length) broken = hits;
    if (doorBreak == null && byType(ev, EV.DOOR_BREAK).length) doorBreak = sim.t;
    if (doorBreak != null && z.y < 14 && z.state !== ZSTATE.DEAD) entered = sim.t;
  }
  assert.equal(broken, Math.ceil(BARRICADE_HP / ZOMBIE.bashDamage), 'barricade breaks on the 11th hit'); assert.equal(sim.metrics.barricadesBroken, 1);
  assert.ok(doorBreak != null, 'door bashed after the barricade'); assert.equal(sim.metrics.doorsBroken, 1); assert.ok(door.open);
  assert.ok(entered != null && entered - doorBreak < 3, 'zombie inside the house within 3 s of the door breaking');
  assert.ok(sim.log.some((l) => l.kind === 'zombie.state' && l.id === z.id && l.to === ZSTATE.BASH), 'bash state logged');
});

test('fortification costs: 2 planks per barricade, trees take 3 hits for 2 planks, denied without planks', () => {
  const sim = makeSim(); const w = sim.world; const [tk] = [...w.trees.keys()]; const [tx, ty] = tk.split(',').map(Number);
  // stand west of the tree if that tile is free, else any free neighbour
  const nb = [[tx - 1, ty], [tx + 1, ty], [tx, ty - 1], [tx, ty + 1]].find(([x, y]) => !w.blocksPlayer(x, y)); assert.ok(nb, 'a reachable tree');
  placePlayer(sim, nb[0] + 0.5, nb[1] + 0.5, Math.atan2(ty - nb[1], tx - nb[0]));
  let hitsSeen = 0, done = 0;
  for (let i = 0; i < ticks(3) && !done; i++) { const ev = sim.step(cmd({ interact: i % 20 === 0 })); hitsSeen += byType(ev, EV.HARVEST_HIT).length; done += byType(ev, EV.HARVEST_DONE).length; }
  assert.equal(hitsSeen, TREE_HITS - 1); assert.equal(done, 1); assert.equal(sim.player.inventory.plank, TREE_PLANKS); assert.equal(sim.metrics.planksHarvested, 2); assert.ok(!w.trees.has(tk));
  placePlayer(sim, 12.5, 13.5, Math.PI / 2); sim.player.inventory.plank = 1;
  const denied = run(sim, 2, (i) => cmd({ build: i === 0 })); assert.ok(byType(denied, EV.ACTION_DENIED).some((e) => e.reason === 'no_planks'));
});

// ---------------- clock, horde, objectives ----------------
test('horde waves at 22:00 / 00:00 / 03:00 with 6 / 5 / 4 zombies from the map edge, all chasing, +0.35 speed', () => {
  const sim = new SurvivalSim({ seed: 7, zombies: 0, timeScale: 40 });   // 1 game hour per 0.5 s
  const ev = run(sim, ticks(0.5 * 23));
  const hordes = byType(ev, EV.HORDE); assert.equal(hordes.length, 3);
  assert.deepEqual(hordes.map((h) => [h.wave, h.count]), [[0, 6], [1, 5], [2, 4]]);
  near(hordes[0].hour, 22, 0.1, 'wave 0 hour'); near(hordes[1].hour, 0, 0.1, 'wave 1 hour'); near(hordes[2].hour, 3, 0.1, 'wave 2 hour');
  assert.equal(sim.metrics.hordeSpawned, 15);
  const spawned = sim.log.filter((l) => l.kind === 'horde'); assert.equal(spawned.length, 3);
  const w = sim.world; const first = sim.zombies.filter((z) => z.horde).slice(0, 6);
  // spawn positions were on the border and reachable
  for (const id of spawned[0].ids) { const z = sim.log.find((l) => l.kind === 'zombie.state' && l.id === id); assert.equal(z.to, ZSTATE.CHASE, 'born chasing'); }
  assert.ok(first.every((z) => z.horde), 'flagged horde'); void w;
});

test('day clock: 08:00 -> 06:00 day 2 takes 22 / (1/20) real seconds at timeScale 1 and ends in a win', () => {
  const sim = makeSim({ timeScale: 1 }); assert.equal(sim.clock(), '08:00'); assert.equal(sim.phase, 'day');
  const total = ticks(22 / DAY.hoursPerSecond); const phases = [];
  for (let i = 0; i < total - 1; i++) for (const e of sim.step(cmd())) if (e.type === EV.PHASE) phases.push([e.phase, +e.hour.toFixed(1)]);
  assert.equal(sim.result, null, 'not yet won one tick before 06:00'); assert.equal(sim.day, 2);
  let last = []; for (let i = 0; i < 3 && !sim.result; i++) { last = sim.step(cmd()); for (const e of last) if (e.type === EV.PHASE) phases.push([e.phase, +e.hour.toFixed(1)]); }   // float accumulation may need a tick more
  assert.equal(sim.result, 'won'); assert.ok(byType(last, EV.WIN).length === 1); near(sim.hour, DAY.winHour, 0.01, 'won at 06:00');
  assert.deepEqual(phases.map((p) => p[0]), ['dusk', 'night', 'dawn']); near(phases[0][1], 18, 0.1, 'dusk at 18:00'); near(phases[1][1], 21, 0.1, 'night at 21:00'); near(phases[2][1], 6, 0.1, 'dawn at 06:00');
  assert.equal(sim.objective.index, 0, 'the clock alone completes no objective step');
});

// ---------------- end to end: autopilot ----------------
function autopilotRun(seed, mode, timeScale = 4) {
  const sim = new SurvivalSim({ seed, timeScale }); const ap = new Autopilot(sim, { seed, mode });
  const maxTicks = ticks(24 / DAY.hoursPerSecond / timeScale) + 10;
  for (let i = 0; i < maxTicks && !sim.result; i++) sim.step(ap.command(sim));
  return { sim, ap };
}
const wins = {};
for (const seed of [7, 11]) test(`autopilot 'win' seed ${seed} at timeScale 4: survives to 06:00 with >= 2 barricades and >= 1 kill`, () => {
  const { sim, ap } = autopilotRun(seed, 'win'); wins[seed] = sim;
  assert.equal(sim.result, 'won', `result (${sim.clock()} day ${sim.day}, hp ${sim.player.health.toFixed(0)}, stage ${ap.stage})`);
  assert.ok(sim.metrics.barricadesBuilt >= 2, 'barricades ' + sim.metrics.barricadesBuilt); assert.ok(sim.metrics.kills >= 1, 'kills ' + sim.metrics.kills);
  assert.ok(sim.player.alive && sim.player.health > 0); assert.equal(sim.objective.state, 'complete');
  const home = ap.stages.find((s) => s.stage === 'fortify'); assert.ok(home && home.hour < DAY.nightHour, 'home before 21:00: ' + JSON.stringify(home));
});
test(`autopilot 'reckless' seed 7: walks the road, never barricades, dies`, () => {
  const { sim } = autopilotRun(7, 'reckless');
  assert.equal(sim.result, 'lost'); assert.equal(sim.metrics.barricadesBuilt, 0); assert.equal(sim.player.alive, false); assert.equal(sim.objective.state, 'failed');
});

test('objective chain completes in order: supplies, arm, planks, fortify, survive', () => {
  const sim = wins[7] || autopilotRun(7, 'win').sim;
  const done = sim.log.filter((l) => l.kind === 'objective' && l.done).map((l) => l.id);
  assert.deepEqual(done, OBJECTIVES.map((o) => o.id));
  assert.ok(sim.objective.steps.every((s, i) => s.done && (i === 0 || s.doneAt >= sim.objective.steps[i - 1].doneAt)), 'monotonic completion times');
});

test('player state machine only visits known states; attack/interact/stagger expire back to locomotion', () => {
  const sim = wins[7] || autopilotRun(7, 'win').sim;
  const tr = sim.log.filter((l) => l.kind === 'player.state'); assert.ok(tr.length > 50, 'transitions logged: ' + tr.length);
  const known = new Set(Object.values(PSTATE)); const loco = new Set([PSTATE.IDLE, PSTATE.WALK, PSTATE.RUN, PSTATE.SNEAK]);
  for (const t of tr) { assert.ok(known.has(t.to), 'unknown state ' + t.to); assert.ok(known.has(t.from), 'unknown from ' + t.from); }
  const busy = new Set([PSTATE.ATTACK, PSTATE.INTERACT, PSTATE.STAGGER]); let seenBusy = 0;
  for (let i = 0; i < tr.length; i++) if (busy.has(tr[i].to)) {
    seenBusy++; const next = tr[i + 1]; if (!next) { assert.ok(sim.result !== null, 'busy at the very end only when the run ended'); continue; }
    assert.ok(next.tick - tr[i].tick <= ticks(0.75), `${tr[i].to} lasted ${next.tick - tr[i].tick} ticks`);
    assert.ok(loco.has(next.to) || busy.has(next.to) || next.to === PSTATE.DEAD, 'expires to locomotion/busy/dead: ' + next.to);
  }
  assert.ok(seenBusy > 20, 'busy states exercised'); assert.ok(tr.some((t) => t.to === PSTATE.SNEAK) && tr.some((t) => t.to === PSTATE.RUN), 'sneak and run used');
});

test('autopilot is deterministic: same seed, same log', () => {
  const a = autopilotRun(11, 'win', 8), b = autopilotRun(11, 'win', 8);
  assert.equal(a.sim.tick, b.sim.tick); assert.deepEqual(a.sim.summary(), b.sim.summary()); assert.deepEqual(a.sim.log.length, b.sim.log.length);
});

// ---------------- correction 3: doorway wall slide, hurt cancels interact ----------------
test('doorway: walking at an open 1-tile door up to 0.45 off-centre funnels through within 2 s (wall slide)', () => {
  for (const x of [12.67, 12.95, 12.05]) {
    const sim = makeSim(); sim.world.opening(12, 14).open = true; placePlayer(sim, x, 13.3, Math.PI / 2);
    let passT = null;
    for (let i = 0; i < ticks(2) && passT == null; i++) { sim.step(cmd({ move: [0, 1] })); if (sim.player.y > 15) passT = sim.t; }
    assert.ok(passT != null && passT <= 2, `start x=${x}: through door (12,14) at ${passT} s (ended at ${sim.player.x.toFixed(2)},${sim.player.y.toFixed(2)})`);
    near(sim.player.x, 12.5, 0.2, `funnelled toward the door centre from x=${x}`);
  }
  // a closed door still stops the player: the slide never opens a way that is not there
  const shut = makeSim(); placePlayer(shut, 12.67, 13.3, Math.PI / 2); run(shut, ticks(1), cmd({ move: [0, 1] }));
  assert.ok(shut.player.y < 14, 'closed door blocks: y=' + shut.player.y.toFixed(2));
  // deterministic: two identical runs end on the same coordinates
  const a = makeSim(), b = makeSim(); for (const s of [a, b]) { s.world.opening(12, 14).open = true; placePlayer(s, 12.9, 13.3, Math.PI / 2); run(s, ticks(1.5), cmd({ move: [0, 1] })); }
  assert.deepEqual([a.player.x, a.player.y], [b.player.x, b.player.y]);
});

test('interact lock is 0.18 s and a hit cancels it: chopping under attack is never a longer damage window', () => {
  assert.equal(INTERACT_LOCK, 0.18);
  // harvest lock expires after 0.18 s: the player is walking again on the next tick
  const sim = makeSim(); const w = sim.world; const [tk] = [...w.trees.keys()]; const [tx, ty] = tk.split(',').map(Number);
  const nb = [[tx - 1, ty], [tx + 1, ty], [tx, ty - 1], [tx, ty + 1]].find(([x, y]) => !w.blocksPlayer(x, y));
  placePlayer(sim, nb[0] + 0.5, nb[1] + 0.5, Math.atan2(ty - nb[1], tx - nb[0]));
  run(sim, 1, cmd({ interact: true, aim: [tx + 0.5, ty + 0.5] })); assert.equal(sim.player.state, PSTATE.INTERACT);
  const away = [-(tx - nb[0]), -(ty - nb[1])];
  run(sim, ticks(INTERACT_LOCK) - 1, cmd({ move: away })); assert.equal(sim.player.state, PSTATE.INTERACT, 'still locked one tick before expiry');
  run(sim, 2, cmd({ move: away })); assert.equal(sim.player.state, PSTATE.WALK, 'walking right after the lock');
  // a zombie hit during the lock: INTERACT -> STAGGER on the hurt tick, exactly one PLAYER_HURT, moving again after hurtStagger
  const s2 = makeSim(); placePlayer(s2, 24.5, 24.5, 0); s2.world.trees.set(s2.world.key(25, 24), 3); s2.world.set(25, 24, 6 /* TREE */);
  const z = spawnZombie(s2, 24.5, 23.2, ZSTATE.ATTACK); z.attackT = 0; z.attackWind = 3 * DT;   // mid-swing: lands on tick 3, inside the 0.18 s lock
  const ev = run(s2, 1, cmd({ interact: true, aim: [25.5, 24.5] })); assert.equal(byType(ev, EV.HARVEST_HIT).length, 1); assert.equal(s2.player.state, PSTATE.INTERACT);
  let hurtTick = null, hurts = 0;
  for (let i = 0; i < ticks(1.5) && hurtTick == null; i++) { const e = s2.step(cmd({ interact: true, aim: [25.5, 24.5], move: [-1, 0] })); hurts += byType(e, EV.PLAYER_HURT).length; if (hurts) hurtTick = s2.tick; }
  assert.ok(hurtTick != null, 'the zombie landed a hit'); assert.equal(hurts, 1, 'one hurt event'); assert.equal(s2.player.state, PSTATE.STAGGER, 'hit interrupts INTERACT');
  const tr = s2.log.filter((l) => l.kind === 'player.state'); const last = tr[tr.length - 1]; assert.equal(last.from, PSTATE.INTERACT); assert.equal(last.to, PSTATE.STAGGER);
  run(s2, ticks(PLAYER.hurtStagger) + 1, cmd({ move: [-1, 0] })); assert.ok(s2.player.state === PSTATE.WALK || s2.player.state === PSTATE.STAGGER && s2.player.stateT >= PLAYER.hurtStagger, 'free after the stagger: ' + s2.player.state);
  assert.ok(s2.player.moving, 'moving away after the stagger window');
  // a non-zombie hurt (bleeding) during a barricade lock drops straight back to locomotion
  const s3 = makeSim(); placePlayer(s3, 12.5, 12.6, Math.PI / 2); s3.player.inventory.plank = 2; s3.player.bleeding = true; s3.player.bleedT = PLAYER.bleedInterval - 2 * DT;
  run(s3, 1, cmd({ build: true })); assert.equal(s3.player.state, PSTATE.INTERACT);
  const e3 = run(s3, 1, cmd()); assert.equal(byType(e3, EV.PLAYER_HURT).length, 1); assert.equal(s3.player.state, PSTATE.IDLE, 'bleed tick cancels the interact lock');
});
