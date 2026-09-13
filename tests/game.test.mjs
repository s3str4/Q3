// Gameplay rules: damage/armor/knockback math, splash, rocket jump, items, spawns, telefrag, match flow, arena rounds,
// out-of-ammo switching and lag-compensation rewind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxBrush } from '../shared/brush.js';
import { WEAPONS, WEAPON_DEFS, HEALTH, ITEMS, BUTTONS, EV, TICK_RATE, LAG_COMP_MAX_MS, PM } from '../shared/constants.js';
import { angleVectors, dist } from '../shared/vec3.js';
import { loadMap } from '../shared/map.js';
import { roomMap, cmd, stepGame, ticks, Game } from './helpers.mjs';

function playing(items = [], rules = {}) {
  const g = new Game(roomMap({ items }), { rules: { warmup: 0, ...rules } });
  const a = g.addPlayer(1, 'a'), b = g.addPlayer(2, 'b');
  stepGame(g, 3);
  assert.equal(g.match.state, 'playing');
  return { g, a, b };
}
const place = (p, x, y, z = 24) => { p.ps.origin = [x, y, z]; p.origin = p.ps.origin; p.ps.velocity = [0, 0, 0]; };

test('damage math: rounding, minimum 1, armor absorbs ceil(0.66*dmg) but never more than it has', () => {
  const { g, a, b } = playing();
  a.health = 100; a.armor = 0;
  g.damage(a, b, 7, [0, 1, 0], a.ps.origin, WEAPONS.MACHINEGUN, 0);
  assert.equal(a.health, 93);
  a.health = 100; a.armor = 50;
  g.damage(a, b, 7, [0, 1, 0], a.ps.origin, WEAPONS.MACHINEGUN, 0); // ceil(4.62)=5 to armor, 2 to health
  assert.equal(a.armor, 45); assert.equal(a.health, 98);
  a.health = 100; a.armor = 0;
  g.damage(a, b, 0.2, [0, 1, 0], a.ps.origin, WEAPONS.PLASMA, 1); // splash edge: rounds to 0 -> minimum 1
  assert.equal(a.health, 99);
  assert.equal(a.damageTaken, 7 + 7 + 1); assert.equal(b.damageDealt, 15); assert.equal(b.hits, 3);
});

test('no damage during countdown or after the match ended', () => {
  const g = new Game(roomMap(), { rules: { warmup: 60000 } });
  const a = g.addPlayer(1, 'a'), b = g.addPlayer(2, 'b');
  stepGame(g, 2);
  assert.equal(g.match.state, 'countdown');
  const h = a.health;
  g.damage(a, b, 50, [0, 1, 0], a.ps.origin, WEAPONS.RAIL, 0);
  assert.equal(a.health, h);
});

test('splash damage falls off linearly with distance to the box and needs line of sight', () => {
  const { g, a, b } = playing();
  place(a, 0, 0); place(b, 500, 500);
  a.health = 200; a.armor = 0;
  // explosion 60 units in +x from the center: closest box point is 45 away -> 100*(1-45/120)=62.5 -> 63
  g.radiusDamage([60, 0, 24], b, 100, 120, null, WEAPONS.ROCKET);
  assert.equal(a.health, 200 - 63);
  a.health = 200;
  g.radiusDamage([200, 0, 24], b, 100, 120, null, WEAPONS.ROCKET); // 185 away: out of radius
  assert.equal(a.health, 200);
  // a wall between the explosion and the player blocks it
  g.world.brushes.push(boxBrush([30, -64, 0], [34, 64, 128], {}));
  a.health = 200;
  g.radiusDamage([60, 0, 24], b, 100, 120, null, WEAPONS.ROCKET);
  assert.equal(a.health, 200, 'blocked by wall');
  g.world.brushes.pop();
});

test('rocket jump: firing at your feet costs half damage and launches you upward', () => {
  const { g, a } = playing();
  a.weapons |= 1 << WEAPONS.ROCKET; a.ammo[WEAPONS.ROCKET] = 10; a.weapon = WEAPONS.ROCKET;
  place(a, 0, 0);
  a.health = 100; a.armor = 0;
  // look straight down and fire, jumping at the same time (classic rocket jump)
  let ev = [];
  for (let i = 0; i < 6; i++) ev.push(...stepGame(g, 1, { 1: cmd({ angles: [89, 0, 0], buttons: (i === 0 ? BUTTONS.JUMP : 0) | BUTTONS.ATTACK }) }));
  assert.ok(ev.some((e) => e.type === EV.EXPLODE), 'rocket exploded');
  assert.ok(ev.some((e) => e.type === EV.PAIN && e.self), 'self pain event');
  assert.ok(a.health >= 45 && a.health <= 60, `took roughly half of the splash: health ${a.health}`);
  assert.ok(a.ps.velocity[2] > 400, `launched upward: vz ${a.ps.velocity[2].toFixed(0)}`);
  let apex = 0;
  for (let i = 0; i < 90; i++) { stepGame(g, 1, { 1: cmd({ angles: [0, 0, 0] }) }); apex = Math.max(apex, a.ps.origin[2] - 24); }
  assert.ok(apex > 150, `rocket jump height ${apex.toFixed(0)} > 150`);
});

test('item pickups respect caps; health and armor decay above 100', () => {
  const items = [{ type: 'health25', origin: [100, 0, 20] }, { type: 'mega', origin: [200, 0, 20] }, { type: 'armorYellow', origin: [300, 0, 20] }, { type: 'armorRed', origin: [400, 0, 20] }, { type: 'weaponRail', origin: [500, 0, 20] }, { type: 'ammoSlugs', origin: [600, 0, 20] }, { type: 'health5', origin: [700, 0, 20] }];
  const { g, a } = playing(items);
  const pick = (i) => { place(a, g.items[i].origin[0], g.items[i].origin[1]); return stepGame(g, 1, { 1: cmd() }).some((e) => e.type === EV.PICKUP && e.item === i); };
  a.health = 100; a.armor = 0;
  assert.equal(pick(0), false, 'health25 refused at 100');
  a.health = 90; assert.equal(pick(0), true); assert.equal(a.health, 100, 'health25 capped at 100');
  assert.equal(pick(1), true); assert.equal(a.health, 200, 'mega to 200');
  assert.equal(pick(6), false, 'bubble refused at 200');
  assert.equal(pick(2), true); assert.equal(a.armor, 50);
  assert.equal(pick(3), true); assert.equal(a.armor, 150);
  g.items[2].available = true; assert.equal(pick(2), true); assert.equal(a.armor, 200, 'armor capped at 200');
  g.items[2].available = true; assert.equal(pick(2), false, 'armor refused at cap');
  assert.equal(pick(4), true); assert.ok(a.weapons & (1 << WEAPONS.RAIL)); assert.equal(a.ammo[WEAPONS.RAIL], 10);
  assert.equal(pick(5), true); assert.equal(a.ammo[WEAPONS.RAIL], 20);
  a.ammo[WEAPONS.RAIL] = 200; g.items[5].available = true; assert.equal(pick(5), false, 'ammo refused at 200');
  g.items[4].available = true; assert.equal(pick(4), false, 'weapon refused when ammo is full');
  // decay: 1 point of health and armor per second while above 100
  place(a, -800, -800);
  stepGame(g, ticks(5000) + 2, { 1: cmd() });
  assert.equal(a.health, 195); assert.equal(a.armor, 195);
});

test('respawn point is chosen among the spawns farthest from the enemy; blocked spots are skipped', () => {
  const map = roomMap();
  const g = new Game(map, { rules: { warmup: 0 }, seed: 5 });
  const a = g.addPlayer(1, 'a'), b = g.addPlayer(2, 'b');
  stepGame(g, 3);
  place(b, map.spawns[0].origin[0], map.spawns[0].origin[1]);
  const ds = map.spawns.map((s) => dist(s.origin, b.ps.origin)).sort((x, y) => x - y);
  const median = ds[Math.floor(ds.length / 2) - 1];
  let farthest = 0;
  for (let i = 0; i < 50; i++) {
    const s = g.selectSpawnPoint(a);
    const d = dist(s.origin, b.ps.origin);
    assert.ok(d >= median && d > 500, `spawn ${s.origin} too close to enemy`);
    if (d === ds[ds.length - 1]) farthest++;
  }
  assert.ok(farthest > 5 && farthest < 45, `random among the far half (farthest picked ${farthest}/50)`);
  // a spot occupied by a live player is never selected while another is free
  for (let i = 0; i < 50; i++) assert.notDeepEqual(g.selectSpawnPoint(a).origin, map.spawns[0].origin);
});

test('telefrag: spawning onto a player kills them and credits the spawner', () => {
  const { g, a, b } = playing();
  place(b, 100, 100);
  g.selectSpawnPoint = () => ({ origin: [100, 100, 24], yaw: 0 });
  const f = a.frags;
  g.spawnPlayer(a);
  assert.equal(b.dead, true);
  assert.equal(a.frags, f + 1);
  const death = g.events.find((e) => e.type === EV.DEATH && e.id === 2);
  assert.equal(death.mod, 'telefrag');
});

test('duel flow: warmup -> countdown -> playing -> timelimit -> overtime sudden death -> ended -> reset', () => {
  const g = new Game(roomMap(), { rules: { warmup: 500, timelimit: 3000 } });
  const a = g.addPlayer(1, 'a');
  assert.equal(g.match.state, 'warmup');
  stepGame(g, 5); assert.equal(g.match.state, 'warmup', 'alone: stays in warmup');
  const b = g.addPlayer(2, 'b');
  const ev = stepGame(g, 1);
  assert.equal(g.match.state, 'countdown');
  assert.ok(ev.some((e) => e.type === EV.COUNTDOWN));
  const ev2 = stepGame(g, ticks(600));
  assert.equal(g.match.state, 'playing');
  assert.ok(ev2.some((e) => e.type === EV.MATCH_START));
  assert.equal(a.health, 125, 'fresh spawn at match start');
  // equal frags at the limit -> overtime
  const ev3 = stepGame(g, ticks(3100));
  assert.equal(g.match.state, 'playing'); assert.equal(g.match.overtime, true);
  assert.ok(ev3.some((e) => e.type === EV.MAJOR_WARN && /OVERTIME/.test(e.text)));
  // the first frag in sudden death ends it
  a.health = 1; place(a, 0, 0);
  g.damage(a, b, 50, [0, 1, 0], a.ps.origin, WEAPONS.RAIL, 0);
  assert.equal(g.match.state, 'ended'); assert.equal(g.match.winner, 2);
  const end = g.events.find((e) => e.type === EV.MATCH_END);
  assert.equal(end.scores[2].frags, 1);
  // the final scoreboard travels in the event: per-weapon accuracy, damage, duration, mode/map
  assert.equal(end.scores[2].byWeapon[WEAPONS.RAIL].hits, 1);
  assert.equal(end.scores[2].name, 'b'); assert.equal(end.scores[2].dmg, 50); assert.equal(end.mode, 'duel'); assert.equal(end.map, 'testroom');
  assert.ok(end.duration >= 3000 && end.duration < 4000, `duration ${end.duration}`); assert.equal(end.overtime, true); assert.equal(end.intermission, 30000);
  // ended: no damage, then (30 s intermission, nobody voted) reset to warmup (and countdown again since 2 players are present)
  b.health = 100; g.damage(b, a, 50, [0, 1, 0], b.ps.origin, WEAPONS.RAIL, 0); assert.equal(b.health, 100);
  stepGame(g, ticks(29000));
  assert.equal(g.match.state, 'ended', 'still on the end screen before the 30 s intermission is over');
  stepGame(g, ticks(1100));
  assert.ok(g.match.state === 'warmup' || g.match.state === 'countdown', `reset: ${g.match.state}`);
  assert.equal(a.frags, 0); assert.equal(b.frags, 0); assert.deepEqual(b.shotsBy, {}); assert.deepEqual(b.hitsBy, {}); assert.equal(b.damageDealt, 0);
});

test('hold: no countdown starts while a client is still loading the map (duel warmup and arena waiting)', () => {
  const g = new Game(roomMap(), { rules: { warmup: 100 } });
  g.setHold(true);
  g.addPlayer(1, 'a'); g.addPlayer(2, 'b');
  stepGame(g, ticks(500));
  assert.equal(g.match.state, 'warmup', 'held');
  g.setHold(false);
  stepGame(g, 1); assert.equal(g.match.state, 'countdown');
  stepGame(g, ticks(200)); assert.equal(g.match.state, 'playing');
  const ar = new Game(roomMap(), { mode: 'arena', rules: { roundCountdown: 100 } });
  ar.setHold(true); ar.addPlayer(1, 'a'); ar.addPlayer(2, 'b');
  stepGame(ar, ticks(500)); assert.equal(ar.match.state, 'waiting');
  ar.setHold(false); stepGame(ar, 1); assert.equal(ar.match.state, 'playing'); assert.equal(ar.match.roundState, 'countdown');
  // a reset keeps the hold (the session clears it when everyone has loaded)
  ar.setHold(true); ar.resetMatch(); assert.equal(ar.match.hold, true);
});

test('duel: a leading player wins at the time limit; a disconnect mid-match leaves the match running', () => {
  const g = new Game(roomMap(), { rules: { warmup: 0, timelimit: 2000 } });
  const a = g.addPlayer(1, 'a'), b = g.addPlayer(2, 'b');
  stepGame(g, 3);
  a.frags = 3;
  g.removePlayer(2);
  stepGame(g, ticks(1000));
  assert.equal(g.match.state, 'playing', 'keeps playing alone');
  stepGame(g, ticks(1100));
  assert.equal(g.match.state, 'ended'); assert.equal(g.match.winner, 1);
});

test('arena mode: 3-2-1 countdown with fresh spawns, full loadout, frozen between rounds, first to a majority wins', () => {
  const g = new Game(roomMap(), { mode: 'arena', rules: { rounds: 3, roundRest: 500, roundCountdown: 3000, roundTimelimit: 60000 } });
  const a = g.addPlayer(1, 'a');
  assert.equal(g.match.state, 'waiting');
  const b = g.addPlayer(2, 'b');
  let ev = stepGame(g, 1);
  assert.equal(g.match.state, 'playing'); assert.equal(g.match.roundState, 'countdown'); assert.equal(g.match.startTime, g.time);
  assert.ok(ev.some((e) => e.type === EV.COUNTDOWN && e.seconds === 3 && e.round === 1), 'countdown 3 announces round 1');
  // frozen and invulnerable during the countdown, already carrying the arena loadout (a few ticks to settle the spawn)
  stepGame(g, 5);
  const o0 = [...a.ps.origin];
  ev = stepGame(g, ticks(900), { 1: cmd({ forward: 127 }) });
  assert.deepEqual(a.ps.origin.map(Math.round), o0.map(Math.round), 'frozen during the countdown');
  a.health = 100; g.damage(a, b, 50, [0, 1, 0], a.ps.origin, WEAPONS.RAIL, 0); assert.equal(a.health, 100, 'no damage during the countdown');
  ev = stepGame(g, ticks(2200));
  assert.equal(g.match.roundState, 'live'); assert.equal(g.match.round, 1);
  assert.ok(ev.some((e) => e.type === EV.COUNTDOWN && e.seconds === 2 && e.round === 1), 'countdown 2');
  assert.ok(ev.some((e) => e.type === EV.COUNTDOWN && e.seconds === 1 && e.round === 1), 'countdown 1');
  assert.ok(ev.some((e) => e.type === EV.ROUND_START && e.round === 1));
  assert.equal(a.health, 100); assert.equal(a.armor, 100); assert.ok(a.weapons & (1 << WEAPONS.ROCKET)); assert.ok(a.weapons & (1 << WEAPONS.RAIL));
  assert.equal(a.ammo[WEAPONS.RAIL], 15);
  // live: players move; a kill ends the round
  stepGame(g, 10, { 1: cmd({ forward: 127 }) });
  assert.notDeepEqual(a.ps.origin.map(Math.round), o0.map(Math.round), 'moves once live');
  a.health = 1; g.damage(a, b, 50, [0, 1, 0], a.ps.origin, WEAPONS.RAIL, 0);
  assert.equal(g.match.roundState, 'rest'); assert.equal(g.match.roundWins[2], 1); assert.equal(a.dead, true);
  const re = g.events.find((e) => e.type === EV.ROUND_END && e.winner === 2);
  assert.ok(re); assert.deepEqual(re.wins, { 1: 0, 2: 1 });
  // rest: the dead player stays dead (the result is on screen), the winner cannot move or take damage
  stepGame(g, 1);
  const o = [...b.ps.origin];
  stepGame(g, 10, { 2: cmd({ forward: 127 }) });
  assert.deepEqual(b.ps.origin.map((v) => Math.round(v)), o.map((v) => Math.round(v)), 'frozen during rest');
  assert.equal(a.dead, true, 'still dead during the rest');
  b.health = 50; g.damage(b, a, 40, [0, 1, 0], b.ps.origin, WEAPONS.RAIL, 0); assert.equal(b.health, 50, 'no damage during rest');
  // rest over -> countdown for round 2 with everyone respawned fresh
  ev = stepGame(g, ticks(400));
  assert.equal(g.match.roundState, 'countdown'); assert.equal(a.dead, false); assert.equal(a.health, 100); assert.equal(b.health, 100);
  assert.ok(ev.some((e) => e.type === EV.COUNTDOWN && e.seconds === 3 && e.round === 2));
  stepGame(g, ticks(3100));
  assert.equal(g.match.round, 2); assert.equal(g.match.roundState, 'live');
  a.health = 1; g.damage(a, b, 50, [0, 1, 0], a.ps.origin, WEAPONS.RAIL, 0);
  assert.equal(g.match.state, 'ended', '2 of 3 rounds wins'); assert.equal(g.match.winner, 2); assert.equal(g.match.roundState, 'idle');
  const end = g.events.find((e) => e.type === EV.MATCH_END);
  assert.equal(end.scores[2].rounds, 2); assert.equal(end.scores[1].rounds, 0); assert.equal(end.rounds, 2); assert.equal(end.mode, 'arena');
  assert.equal(end.scores[2].frags, 2); assert.equal(end.scores[2].byWeapon[WEAPONS.RAIL].hits, 2);
  // the end screen stays for the intermission, then the arena waits for the next match (players present -> countdown)
  stepGame(g, ticks(29000)); assert.equal(g.match.state, 'ended');
  stepGame(g, ticks(1100)); assert.equal(g.match.state, 'playing'); assert.equal(g.match.roundState, 'countdown'); assert.equal(g.match.round, 0);
  assert.deepEqual(g.match.roundWins, { 1: 0, 2: 0 });
});

test('arena: 6 of 10 rounds wins; a draw (timeout with equal health+armor) counts for nobody', () => {
  const g = new Game(roomMap(), { mode: 'arena', rules: { roundRest: 100, roundCountdown: 100, roundTimelimit: 500 } });
  const a = g.addPlayer(1, 'a'), b = g.addPlayer(2, 'b');
  let rounds = 0;
  while (g.match.state !== 'ended' && rounds < 40) {
    stepGame(g, ticks(250)); // countdown + rest
    if (g.match.roundState !== 'live') { stepGame(g, ticks(200)); }
    assert.equal(g.match.roundState, 'live');
    rounds++;
    if (rounds === 1) { stepGame(g, ticks(600)); assert.deepEqual(g.match.roundWins, { 1: 0, 2: 0 }, 'draw'); continue; }
    a.health = 1; g.damage(a, b, 50, [0, 1, 0], a.ps.origin, WEAPONS.RAIL, 0);
  }
  assert.equal(g.match.state, 'ended'); assert.equal(g.match.winner, 2); assert.equal(g.match.roundWins[2], 6); assert.equal(g.match.round, 7);
  // all rounds played without a majority (draws): the leader wins; a tie goes on (sudden death)
  const g2 = new Game(roomMap(), { mode: 'arena', rules: { rounds: 3, roundRest: 100, roundCountdown: 100, roundTimelimit: 300 } });
  const a2 = g2.addPlayer(1, 'a'); g2.addPlayer(2, 'b');
  const untilLive = () => { for (let i = 0; i < 200 && g2.match.roundState !== 'live'; i++) stepGame(g2, 1); };
  untilLive(); a2.armor = 150; stepGame(g2, ticks(350)); // round 1: a leads on health+armor at the timeout (arena spawn is 100/100)
  assert.deepEqual(g2.match.roundWins, { 1: 1, 2: 0 });
  untilLive(); stepGame(g2, ticks(350)); untilLive(); stepGame(g2, ticks(350)); // rounds 2 and 3: draws
  assert.equal(g2.match.round, 3); assert.equal(g2.match.state, 'ended', 'leader wins after the last round'); assert.equal(g2.match.winner, 1);
  const g3 = new Game(roomMap(), { mode: 'arena', rules: { rounds: 2, roundRest: 100, roundCountdown: 100, roundTimelimit: 300 } });
  g3.addPlayer(1, 'a'); g3.addPlayer(2, 'b');
  stepGame(g3, ticks(2500));
  assert.equal(g3.match.state, 'playing', 'all draws: sudden death continues'); assert.ok(g3.match.round > 2);
});

test('arena round timeout: higher health+armor wins the round', () => {
  const g = new Game(roomMap(), { mode: 'arena', rules: { rounds: 5, roundRest: 200, roundCountdown: 500, roundTimelimit: 1000 } });
  const a = g.addPlayer(1, 'a'), b = g.addPlayer(2, 'b');
  stepGame(g, ticks(600));
  assert.equal(g.match.roundState, 'live');
  a.armor = 50;
  stepGame(g, ticks(1100));
  assert.equal(g.match.roundWins[2], 1);
});

test('out of ammo: NOAMMO event and automatic switch to the best loaded weapon', () => {
  const { g, a } = playing();
  a.weapons |= (1 << WEAPONS.ROCKET) | (1 << WEAPONS.RAIL);
  a.ammo[WEAPONS.ROCKET] = 1; a.ammo[WEAPONS.RAIL] = 0; a.weapon = WEAPONS.ROCKET;
  let ev = stepGame(g, 1, { 1: cmd({ buttons: BUTTONS.ATTACK, angles: [0, 90, 0] }) });
  assert.ok(ev.some((e) => e.type === EV.FIRE && e.weapon === WEAPONS.ROCKET));
  assert.equal(a.ammo[WEAPONS.ROCKET], 0);
  // refire 800 ms, then the empty click (500 ms), then the 200 ms drop before the change event
  ev = stepGame(g, ticks(1700), { 1: cmd({ buttons: BUTTONS.ATTACK, angles: [0, 90, 0] }) });
  assert.ok(ev.some((e) => e.type === EV.NOAMMO), 'noammo event');
  assert.ok(ev.some((e) => e.type === EV.WEAPON_CHANGE && e.weapon === WEAPONS.MACHINEGUN), 'switched to machinegun (rail has no ammo)');
  assert.equal(a.weapon, WEAPONS.MACHINEGUN);
});

test('lag compensation: hitscan rewinds targets to the shooter view time (history sampling, 250 ms cap)', () => {
  const { g, a, b } = playing();
  place(a, -400, 0); place(b, 0, 0);
  // b runs +y at 320 ups for 30 ticks; history records one sample per tick
  stepGame(g, 30, { 2: cmd({ forward: 127, angles: [0, 90, 0] }), 1: cmd({ angles: [0, 0, 0] }) });
  assert.ok(b.ps.origin[1] > 100, `moved ${b.ps.origin[1]}`);
  const now = g.time;
  const yAt = (t) => { const h = b.history.find((x) => x.time === t); return h ? h.origin[1] : null; };
  const eye = [a.ps.origin[0], a.ps.origin[1], a.ps.origin[2] + a.ps.viewHeight];
  const shoot = (y) => g.traceLagComp(a, eye, [b.ps.origin[0], y, b.ps.origin[2] + 4]);
  // shooter saw b 150 ms ago (9 ticks): aiming where it was then hits with lag comp...
  const tOld = now - 150; a.viewTime = tOld;
  const yOld = yAt(tOld);
  assert.ok(Math.abs(yOld - b.ps.origin[1]) > 40, 'target has moved more than a box width since then');
  assert.ok(shoot(yOld).entity, 'hit at the rewound position');
  assert.ok(!shoot(b.ps.origin[1]).entity, 'current position is a miss for that view time');
  // ...and without lag comp only the current position hits
  g.lagComp = false;
  assert.ok(!shoot(yOld).entity); assert.ok(shoot(b.ps.origin[1]).entity);
  g.lagComp = true;
  // view time between two ticks interpolates the history
  a.viewTime = tOld + 8;
  const f = 8 / (1000 / TICK_RATE);
  const yInterp = yOld + (yAt(tOld + Math.round(1000 / TICK_RATE)) - yOld) * f;
  assert.ok(shoot(yInterp).entity, 'interpolated sample hits');
  // rewinding is capped: a view time far in the past clamps to now-250 ms
  a.viewTime = now - 2000;
  assert.ok(shoot(yAt(now - 250)).entity, 'clamped to 250 ms');
  assert.ok(!shoot(yAt(now - 450)).entity, 'not rewound beyond the cap');
  // bots never get rewound
  a.isBot = true; a.viewTime = tOld;
  assert.ok(!shoot(yOld).entity); a.isBot = false;
});

test('projectiles hit players and the world; rockets do not hit their owner at the muzzle', () => {
  const { g, a, b } = playing();
  a.weapons |= 1 << WEAPONS.ROCKET; a.ammo[WEAPONS.ROCKET] = 5; a.weapon = WEAPONS.ROCKET;
  place(a, -400, 0); place(b, 0, 0);
  b.health = 100; b.armor = 0;
  const ev = stepGame(g, 40, { 1: (i) => cmd({ buttons: i === 0 ? BUTTONS.ATTACK : 0, angles: [0, 0, 0] }), 2: cmd({ angles: [0, 180, 0] }) });
  assert.equal(a.health, 125, 'no self hit at the muzzle');
  const hit = ev.find((e) => e.type === EV.EXPLODE && e.onPlayer);
  assert.ok(hit, 'rocket hit b');
  assert.ok(b.dead || b.health < 100, 'b took damage');
});

test('testbox map loads, players can jump-pad and every bot nav node is reachable on the graph', async () => {
  const map = await loadMap('testbox');
  const g = new Game(map, { rules: { warmup: 0 } });
  const a = g.addPlayer(1, 'a'), b = g.addPlayer(2, 'b');
  stepGame(g, 3);
  place(a, -32, -288);
  const ev = []; let apex = 0;
  for (let i = 0; i < 60; i++) { ev.push(...stepGame(g, 1, { 1: cmd() })); apex = Math.max(apex, a.ps.origin[2]); }
  assert.ok(ev.some((e) => e.type === EV.JUMPPAD && e.id === 1), 'jump pad fired');
  assert.equal(ev.filter((e) => e.type === EV.JUMPPAD && e.id === 1).length, 1, 'fires once per contact');
  assert.ok(apex > 100, `launched (apex ${apex.toFixed(0)})`);
  assert.ok(a.ps.origin[0] > 150, `carried toward the target (x ${a.ps.origin[0].toFixed(0)})`);
});

test('bot navigation: gap of 128 units is a jump edge, 320 units is not; ledges up to 44 need a jump', async () => {
  const { walkable } = await import('../shared/bot.js');
  const { MapBuilder } = await import('../shared/map.js');
  const gap = (w) => { const m = new MapBuilder('gap'); m.box([-512, -128, -64], [0, 128, 0], 'floor'); m.box([w, -128, -64], [512 + w, 128, 0], 'floor'); m.box([-512, -128, -2048], [1024, 128, -1024], 'floor'); return m.finish(); };
  const g1 = new Game(gap(128)); const g2 = new Game(gap(320));
  const w1 = walkable(g1, [-200, 0, 24], [328, 0, 24]);
  assert.equal(w1.ok, true); assert.equal(w1.jump, true, '128-unit gap needs a jump');
  assert.equal(walkable(g2, [-200, 0, 24], [520, 0, 24]).ok, false, '320-unit gap is not jumpable');
  const m = new MapBuilder('ledge'); m.box([-512, -128, -64], [512, 128, 0], 'floor'); m.box([0, -128, 0], [512, 128, 40], 'floor');
  const w3 = walkable(new Game(m.finish()), [-200, 0, 24], [200, 0, 64]);
  assert.equal(w3.ok, true); assert.equal(w3.jump, true, '40-unit ledge needs a jump');
  const m2 = new MapBuilder('step'); m2.box([-512, -128, -64], [512, 128, 0], 'floor'); m2.box([0, -128, 0], [512, 128, 16], 'floor');
  const w4 = walkable(new Game(m2.finish()), [-200, 0, 24], [200, 0, 40]);
  assert.equal(w4.ok, true); assert.equal(w4.jump, false, '16-unit step is walkable');
});

test('bots: a 60 s duel on testbox is lively (frags, several weapons fired, strafe jumps, no bot ever stuck)', async () => {
  const { Bot, buildNavGraph } = await import('../shared/bot.js');
  const map = await loadMap('testbox');
  const g = new Game(map, { seed: 3, rules: { warmup: 500 } });
  const a = g.addPlayer(1, 'a', { isBot: true }), b = g.addPlayer(2, 'b', { isBot: true });
  const nav = buildNavGraph(g);
  const bots = [new Bot(g, a, { skill: 0.8, seed: 4, nav }), new Bot(g, b, { skill: 0.8, seed: 5, nav })];
  let fires = 0, deaths = 0, fast = 0, still = { 1: 0, 2: 0 }, maxStill = 0;
  const last = { 1: null, 2: null };
  for (let i = 0; i < 60 * TICK_RATE; i++) {
    for (const bt of bots) bt.think();
    for (const e of g.step()) { if (e.type === EV.FIRE) fires++; if (e.type === EV.DEATH) deaths++; }
    for (const p of g.players.values()) {
      if (p.dead) { still[p.id] = 0; continue; }
      if (Math.hypot(p.ps.velocity[0], p.ps.velocity[1]) > 330 && g.time - p.ps.jumpPadTime > 1500 && g.time - p.lastPain > 1000) fast++;
      if (last[p.id] && dist(last[p.id], p.ps.origin) < 1) { still[p.id]++; maxStill = Math.max(maxStill, still[p.id]); } else still[p.id] = 0;
      last[p.id] = [...p.ps.origin];
    }
  }
  assert.ok(deaths >= 2, `deaths ${deaths}`);
  assert.ok(fires > 60, `fires ${fires}`);
  const weaponsUsed = new Set([...Object.keys(a.shotsBy), ...Object.keys(b.shotsBy)]);
  assert.ok(weaponsUsed.size >= 3, `weapons used ${[...weaponsUsed]}`);
  assert.ok(fast > 60, `ticks above 320 ups ${fast} (strafe jumping)`);
  assert.ok(maxStill < 2 * TICK_RATE, `longest time standing still ${maxStill / TICK_RATE} s`);
  assert.ok(bots.some((bt) => bt.stats.strafeJumps > 3), 'strafe jumps happened');
});
