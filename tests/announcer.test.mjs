// Announcer events emitted by the simulation: medals (EXCELLENT / IMPRESSIVE / HUMILIATION / PERFECT), lead changes,
// frags-left and time warnings. The client only voices and draws what the server decided, so both players agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEAPONS, EV, AWARDS, CARNAGE_REWARD_TIME, TICK_MS } from '../shared/constants.js';
import { roomMap, stepGame, Game } from './helpers.mjs';

// Game.step() starts every tick with an empty event list: archive the pending events before each step so a test can
// look at everything the match emitted.
function logged(g) { g.log = []; const step = g.step.bind(g); g.step = (...a) => { g.log.push(...g.events); return step(...a); }; return g; }
function playing(rules = {}, mode = 'duel') {
  const g = logged(new Game(roomMap(), { mode, rules: { warmup: 0, ...rules } }));
  const a = g.addPlayer(1, 'a'), b = g.addPlayer(2, 'b');
  stepGame(g, 3);
  assert.equal(g.match.state, 'playing');
  return { g, a, b };
}
const events = (g, type) => [...(g.log || []), ...g.events].filter((e) => e.type === type);
const frag = (g, victim, killer, mod = WEAPONS.ROCKET) => { victim.health = 1; g.damage(victim, killer, 100, [0, 1, 0], victim.ps.origin, mod, 0); };
const respawn = (g, p) => { p.dead = false; p.health = 100; p.maxs = [15, 15, 32]; };

test('EXCELLENT: two frags within 3 s, not when the second frag comes later', () => {
  const { g, a, b } = playing();
  frag(g, b, a); respawn(g, b);
  assert.equal(events(g, EV.AWARD).length, 0, 'first frag is no award');
  g.time += CARNAGE_REWARD_TIME - 100;
  frag(g, b, a); respawn(g, b);
  const aw = events(g, EV.AWARD);
  assert.equal(aw.length, 1); assert.equal(aw[0].award, AWARDS.EXCELLENT); assert.equal(aw[0].id, a.id); assert.equal(aw[0].count, 1);
  assert.equal(a.awards.excellent, 1);
  g.time += CARNAGE_REWARD_TIME + 1;
  frag(g, b, a);
  assert.equal(events(g, EV.AWARD).length, 1, 'a frag 3 s after the previous one is not excellent');
});

test('HUMILIATION: a gauntlet frag, carried with the victim id; suicides award nothing', () => {
  const { g, a, b } = playing();
  frag(g, b, a, WEAPONS.GAUNTLET);
  const aw = events(g, EV.AWARD);
  assert.equal(aw.length, 1); assert.equal(aw[0].award, AWARDS.HUMILIATION); assert.equal(aw[0].id, a.id); assert.equal(aw[0].target, b.id);
  respawn(g, b);
  frag(g, b, b, WEAPONS.ROCKET);
  assert.equal(events(g, EV.AWARD).length, 1);
});

test('IMPRESSIVE: two consecutive rail hits; a miss resets the streak', () => {
  const { g, a } = playing();
  g.railAccuracy(a, true); g.railAccuracy(a, false); g.railAccuracy(a, true);
  assert.equal(events(g, EV.AWARD).length, 0);
  g.railAccuracy(a, true);
  const aw = events(g, EV.AWARD);
  assert.equal(aw.length, 1); assert.equal(aw[0].award, AWARDS.IMPRESSIVE);
  assert.equal(a.railStreak, 0, 'the streak restarts after the medal');
  g.railAccuracy(a, true); g.railAccuracy(a, true);
  assert.equal(events(g, EV.AWARD).length, 2, 'four hits in a row = two medals');
});

test('lead: taken / lost / tied announced to the player concerned, in duel only, once per change', () => {
  const { g, a, b } = playing();
  frag(g, b, a); respawn(g, b);
  let lead = events(g, EV.LEAD);
  assert.deepEqual(lead.map((e) => [e.id, e.status]), [[a.id, 'taken'], [b.id, 'lost']]);
  frag(g, b, a); respawn(g, b);
  assert.equal(events(g, EV.LEAD).length, 2, 'extending a lead is silent');
  frag(g, a, b); respawn(g, a); frag(g, a, b); respawn(g, a);
  lead = events(g, EV.LEAD);
  assert.deepEqual(lead.slice(2).map((e) => [e.id, e.status]), [[a.id, 'tied'], [b.id, 'tied']]);
  frag(g, a, b);
  lead = events(g, EV.LEAD);
  assert.deepEqual(lead.slice(4).map((e) => [e.id, e.status]), [[a.id, 'lost'], [b.id, 'taken']]);
  // arena: no lead calls
  const ar = playing({ rounds: 3 }, 'arena');
  stepGame(ar.g, Math.ceil(3200 / TICK_MS));
  frag(ar.g, ar.b, ar.a);
  assert.equal(events(ar.g, EV.LEAD).length, 0);
});

test('frags left: three / two / one before a fraglimit, each once, none when the limit is hit', () => {
  const { g, a, b } = playing({ fraglimit: 5 });
  const left = () => events(g, EV.FRAGS_LEFT).map((e) => e.left);
  frag(g, b, a); respawn(g, b); assert.deepEqual(left(), []);
  frag(g, b, a); respawn(g, b); assert.deepEqual(left(), [3]);
  frag(g, a, b); respawn(g, a); assert.deepEqual(left(), [3], 'the other player at 4 left does not repeat');
  frag(g, b, a); respawn(g, b); assert.deepEqual(left(), [3, 2]);
  frag(g, b, a); respawn(g, b); assert.deepEqual(left(), [3, 2, 1]);
  frag(g, b, a);
  assert.deepEqual(left(), [3, 2, 1]); assert.equal(g.match.state, 'ended'); assert.equal(g.match.winner, a.id);
});

test('time warnings: five and one minute before the timelimit, once each, before the match ends', () => {
  const { g } = playing({ timelimit: 7 * 60 * 1000 });
  const warned = () => events(g, EV.TIME_WARN).map((e) => e.minutes);
  const jumpTo = (ms) => { g.tick = Math.round((g.match.startTime + ms) / TICK_MS) - 1; stepGame(g, 1); }; // step() derives time from tick
  jumpTo(2 * 60 * 1000 - 50); assert.deepEqual(warned(), []);
  jumpTo(2 * 60 * 1000); stepGame(g, 1); assert.deepEqual(warned(), [5]);
  jumpTo(6 * 60 * 1000); stepGame(g, 1); assert.deepEqual(warned(), [5, 1]);
  jumpTo(7 * 60 * 1000); stepGame(g, 1); assert.deepEqual(warned(), [5, 1]);
  assert.equal(g.match.overtime, true, '0-0 at the limit goes to sudden death'); assert.equal(events(g, EV.MAJOR_WARN).length, 1);
});

test('PERFECT: an arena round won without taking damage; not when the winner was hit', () => {
  const g = logged(new Game(roomMap(), { mode: 'arena', rules: { warmup: 0, rounds: 5, roundCountdown: 0, roundRest: 0 } }));
  const a = g.addPlayer(1, 'a'), b = g.addPlayer(2, 'b');
  stepGame(g, 3);
  assert.equal(g.match.roundState, 'live');
  frag(g, b, a);
  let aw = events(g, EV.AWARD).filter((e) => e.award === AWARDS.PERFECT);
  assert.equal(aw.length, 1); assert.equal(aw[0].id, a.id);
  stepGame(g, 3); // rest + countdown (0 ms) -> next round live
  assert.equal(g.match.roundState, 'live');
  g.damage(a, b, 10, [0, 1, 0], a.ps.origin, WEAPONS.MACHINEGUN, 0);
  frag(g, b, a);
  aw = events(g, EV.AWARD).filter((e) => e.award === AWARDS.PERFECT);
  assert.equal(aw.length, 1, 'a round won after taking damage is not perfect');
  const summary = g.matchSummary();
  assert.equal(summary.scores[a.id].awards.perfect, 1);
});
