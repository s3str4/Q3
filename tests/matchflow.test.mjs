// Match flow across matches: end screen data, the map/mode vote and ready protocol (VOTE / REMATCH / VOTES /
// MAPCHANGE / LOADED), the session rebuilding its Game for a new map with the same players, the countdown hold
// until every client has loaded, and the 30 s auto restart. First against an in-memory GameSession with fake links,
// then end to end: the real server over real WebSockets with two headless clients (client/net/headless.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameSession } from '../shared/session.js';
import { loadMap } from '../shared/map.js';
import { PROTOCOL_VERSION, MSG } from '../shared/protocol.js';
import { EV, WEAPONS, TICK_RATE } from '../shared/constants.js';
import { createServer } from '../server/index.mjs';
import { connectHeadless, sleep } from '../client/net/headless.js';

const testbox = await loadMap('testbox');

// A fake link records what the session sends; messages "from the client" go through link.onmessage like a transport would.
function fakeLink() {
  const out = [];
  const link = { out, onmessage: null, onclose: null, close() { link.closed = true; }, send(o) { out.push(JSON.parse(JSON.stringify(o))); } };
  link.last = (t) => { for (let i = out.length - 1; i >= 0; i--) if (out[i].t === t) return out[i]; return null; };
  link.count = (t) => out.filter((m) => m.t === t).length;
  return link;
}
function joinTwo(session, rules) {
  const A = fakeLink(), B = fakeLink();
  session.attach(A); session.attach(B);
  A.onmessage({ t: MSG.JOIN, name: 'A', v: PROTOCOL_VERSION }); B.onmessage({ t: MSG.JOIN, name: 'B', v: PROTOCOL_VERSION });
  return { A, B };
}
const steps = (session, n) => { for (let i = 0; i < n; i++) session.step(); };
const secs = (s) => Math.round(s * TICK_RATE);
// end the running duel: A leads, the time limit expires
function finishDuel(session, winnerId) {
  const g = session.game;
  for (let i = 0; i < 600 && g.match.state !== 'playing'; i++) session.step();
  assert.equal(g.match.state, 'playing');
  g.players.get(winnerId).frags = 3;
  steps(session, secs(g.rules.timelimit / 1000 + 0.2));
  assert.equal(g.match.state, 'ended');
}

test('session: match end opens the intermission with the scoreboard in the event and a VOTES message', () => {
  const s = new GameSession(testbox, { rules: { warmup: 0, timelimit: 1000 } });
  const { A, B } = joinTwo(s);
  steps(s, 3); assert.equal(s.game.match.state, 'playing');
  const pa = s.game.players.get(1), pb = s.game.players.get(2);
  pa.shotsBy = { [WEAPONS.RAIL]: 4 }; pa.hitsBy = { [WEAPONS.RAIL]: 2 }; pa.shots = 4; pa.hits = 2; pa.damageDealt = 200;
  finishDuel(s, 1);
  const snapEnd = B.out.find((m) => m.t === MSG.SNAP && m.s.ev.some((e) => e.type === EV.MATCH_END));
  assert.ok(snapEnd, 'MATCH_END reached the clients');
  const end = snapEnd.s.ev.find((e) => e.type === EV.MATCH_END);
  assert.equal(end.winner, 1); assert.equal(end.scores[1].byWeapon[WEAPONS.RAIL].hits, 2); assert.equal(end.scores[1].acc, 0.5); assert.equal(end.scores[1].dmg, 200);
  assert.equal(end.scores[2].name, 'B'); assert.ok(end.duration >= 1000);
  const v = A.last(MSG.VOTES);
  assert.ok(v && v.open, 'intermission open');
  assert.deepEqual(v.next, { map: 'testbox', mode: 'duel' });
  assert.equal(v.players[1].ready, false); assert.equal(v.players[2].ready, false);
  assert.ok(v.left > 29000 && v.left <= 30000, `auto restart in ${v.left} ms`);
  assert.equal(pb.frags, 0);
});

test('session: votes resolve (unanimous -> that map; split -> the first player wins), both ready -> map change with a countdown hold', async () => {
  const s = new GameSession(testbox, { rules: { warmup: 200, timelimit: 1000 } });
  const { A, B } = joinTwo(s);
  steps(s, 3);
  finishDuel(s, 2);
  // a vote before the match ended is ignored; during the intermission it is broadcast live
  B.onmessage({ t: MSG.VOTE, map: 'lava_spire' });
  assert.equal(A.last(MSG.VOTES).players[2].map, 'lava_spire');
  assert.equal(A.last(MSG.VOTES).next.map, 'lava_spire', 'the only vote wins');
  A.onmessage({ t: MSG.VOTE, map: 'tight_deck', mode: 'arena' });
  assert.deepEqual(A.last(MSG.VOTES).next, { map: 'tight_deck', mode: 'arena' }, 'split vote: the first player (host) wins');
  B.onmessage({ t: MSG.VOTE, map: 'tight_deck' });
  assert.equal(B.last(MSG.VOTES).next.map, 'tight_deck', 'unanimous');
  // bogus picks are dropped
  B.onmessage({ t: MSG.VOTE, map: '../../etc/passwd', mode: 'ctf' });
  assert.equal(B.last(MSG.VOTES).players[2].map, null); assert.equal(B.last(MSG.VOTES).players[2].mode, null);
  // ready: one is not enough
  A.onmessage({ t: MSG.REMATCH, ready: true });
  assert.equal(A.last(MSG.VOTES).players[1].ready, true); assert.equal(s.game.match.state, 'ended');
  B.onmessage({ t: MSG.REMATCH, ready: true });
  await sleep(50); // the map module loads asynchronously
  assert.equal(s.game.map.name, 'tight_deck'); assert.equal(s.game.mode, 'arena'); assert.equal(s.opts.mode, 'arena'); assert.equal(s.info().map, 'tight_deck');
  assert.equal(s.game.players.size, 2, 'players carried over'); assert.equal(s.game.players.get(1).name, 'A');
  const mc = A.last(MSG.MAPCHANGE);
  assert.ok(mc && mc.map === 'tight_deck' && mc.mode === 'arena' && mc.rules.rounds === 10, 'MAPCHANGE with the new rules');
  assert.ok(B.last(MSG.MAPCHANGE));
  assert.equal(A.last(MSG.VOTES).open, false, 'intermission closed');
  // the countdown waits for both LOADED
  steps(s, secs(2));
  assert.equal(s.game.match.state, 'waiting'); assert.equal(s.game.match.hold, true);
  A.onmessage({ t: MSG.LOADED, map: 'tight_deck' });
  B.onmessage({ t: MSG.LOADED, map: 'testbox' }); // stale (previous map): does not count
  steps(s, 5); assert.equal(s.game.match.state, 'waiting');
  B.onmessage({ t: MSG.LOADED, map: 'tight_deck' });
  steps(s, 1);
  assert.equal(s.game.match.hold, false); assert.equal(s.game.match.state, 'playing'); assert.equal(s.game.match.roundState, 'countdown');
  assert.ok(A.last(MSG.SNAP).s.ev.some((e) => e.type === EV.COUNTDOWN && e.round === 1), 'arena countdown reaches the clients');
  assert.equal(s.matches, 1);
});

test('session: same map + same mode -> in-place reset (no MAPCHANGE); no click -> auto restart after the intermission', async () => {
  const s = new GameSession(testbox, { rules: { warmup: 100, timelimit: 1000, intermission: 3000 } });
  const { A, B } = joinTwo(s);
  steps(s, 3); finishDuel(s, 1);
  A.onmessage({ t: MSG.REMATCH, ready: true }); B.onmessage({ t: MSG.REMATCH, ready: true });
  assert.equal(A.count(MSG.MAPCHANGE), 0);
  assert.equal(s.game.match.state, 'warmup'); assert.equal(s.game.players.get(1).frags, 0);
  steps(s, 2); assert.equal(s.game.match.state, 'countdown');
  steps(s, secs(0.3)); assert.equal(s.game.match.state, 'playing');
  // second match: nobody clicks; one vote for another mode still applies at the auto restart
  finishDuel(s, 2);
  B.onmessage({ t: MSG.VOTE, mode: 'arena' });
  steps(s, secs(2.5)); assert.equal(s.game.match.state, 'ended', 'still on the end screen');
  steps(s, secs(0.6));
  await sleep(50); // the game is rebuilt once the map module has (re)loaded
  assert.equal(s.game.mode, 'arena', 'the lone vote decided the mode');
  assert.equal(s.game.map.name, 'testbox'); assert.equal(A.count(MSG.MAPCHANGE), 1, 'mode change rebuilds the game too');
  assert.equal(s.matches, 2);
});

test('session: bots are always ready; a leaving player does not block the rematch; a load timeout releases the hold', async () => {
  const s = new GameSession(testbox, { rules: { warmup: 100, timelimit: 1000 } });
  const A = fakeLink(); s.attach(A);
  A.onmessage({ t: MSG.JOIN, name: 'A', v: PROTOCOL_VERSION, bot: true, botSkill: 0.95 });
  assert.equal(s.bots.size, 1); assert.equal([...s.bots.values()][0].skill, 0.95);
  steps(s, 3); finishDuel(s, 1);
  const v = A.last(MSG.VOTES);
  assert.equal(Object.values(v.players).find((p) => p.bot).ready, true);
  A.onmessage({ t: MSG.VOTE, map: 'lava_spire' });
  A.onmessage({ t: MSG.REMATCH, ready: true });
  await sleep(80);
  assert.equal(s.game.map.name, 'lava_spire');
  assert.equal(s.game.players.size, 2); assert.ok([...s.game.players.values()].some((p) => p.isBot), 'the bot followed');
  assert.equal([...s.bots.values()][0].game, s.game, 'bot rebuilt on the new game');
  // A never sends LOADED: after the timeout the countdown is released anyway
  steps(s, secs(29)); assert.equal(s.game.match.state, 'warmup');
  steps(s, secs(1.5)); assert.equal(s.game.match.hold, false); assert.notEqual(s.game.match.state, 'warmup');
  // two humans, one leaves during the intermission: the remaining ready player starts the next match alone with the bot slot free
  const s2 = new GameSession(testbox, { rules: { warmup: 100, timelimit: 1000 } });
  const { A: A2, B: B2 } = joinTwo(s2);
  steps(s2, 3); finishDuel(s2, 1);
  A2.onmessage({ t: MSG.REMATCH, ready: true });
  B2.onclose();
  assert.equal(s2.game.match.state, 'warmup', 'A was ready: the next match starts as soon as B is gone');
});

// ---- end to end: real server, real WebSockets, two headless clients ----
async function endToEnd(rules, fn) {
  const server = await createServer({ port: 0, map: 'testbox', quiet: true, rules });
  const url = `ws://127.0.0.1:${server.port}/`;
  let A = null, B = null;
  try {
    A = await connectHeadless({ url, map: testbox, name: 'A' });
    B = await connectHeadless({ url, map: testbox, name: 'B', autoLoad: false });
    await A.waitFor((cg) => cg.predicted && cg.game.match.state === 'playing', 15000);
    await fn({ server, A, B });
  } finally { if (A) A.stop(); if (B) B.stop(); await server.close(); }
}

test('e2e: end screen data, vote + rematch over WebSockets, MAPCHANGE -> clients reload -> LOADED releases the countdown on the new map', async () => {
  await endToEnd({ warmup: 300, timelimit: 1500 }, async ({ server, A, B }) => {
    server.game.players.get(A.id).frags = 2;
    await A.waitFor((cg) => cg.game.match.state === 'ended', 5000);
    const end = A.events.find((e) => e.type === EV.MATCH_END);
    assert.ok(end, 'client got MATCH_END'); assert.equal(end.winner, A.id); assert.equal(end.scores[A.id].frags, 2); assert.equal(end.scores[B.id].name, 'B');
    await A.waitFor(() => A.lastVotes && A.lastVotes.open, 2000);
    assert.equal(A.lastVotes.left > 25000, true);
    // split vote: A (joined first) wants arena_duel, B wants lava_spire -> arena_duel
    A.vote({ map: 'arena_duel' }); B.vote({ map: 'lava_spire', mode: 'duel' });
    await B.waitFor(() => B.lastVotes && B.lastVotes.players[A.id].map === 'arena_duel' && B.lastVotes.players[B.id].map === 'lava_spire', 2000);
    assert.equal(B.lastVotes.next.map, 'arena_duel');
    A.ready(); await A.waitFor(() => A.lastVotes.players[A.id].ready, 2000);
    assert.equal(server.game.match.state, 'ended', 'one ready is not enough');
    B.ready();
    await A.waitFor(() => A.mapChanges.length === 1, 5000);
    await B.waitFor(() => B.mapChanges.length === 1, 5000);
    assert.equal(A.mapChanges[0].map, 'arena_duel');
    // A loaded automatically; B has not answered yet: the server holds the countdown
    await A.waitFor((cg) => cg.mapName === 'arena_duel' && cg.predicted, 5000);
    assert.equal(server.game.map.name, 'arena_duel'); assert.equal(server.session.info().map, 'arena_duel');
    await sleep(700);
    assert.equal(server.game.match.state, 'warmup'); assert.equal(server.game.match.hold, true);
    assert.equal(A.cg.game.match.hold, true, 'the client sees the hold (HUD shows LOADING)');
    assert.equal(B.cg.mapName, 'testbox', 'B still on the old map');
    await B.load(B.mapChanges[0]);
    await A.waitFor((cg) => cg.game.match.state === 'countdown' || cg.game.match.state === 'playing', 3000);
    assert.equal(server.game.match.hold, false);
    await A.waitFor((cg) => cg.game.match.state === 'playing', 3000);
    await B.waitFor((cg) => cg.predicted && cg.game.match.state === 'playing', 3000);
    assert.equal(B.cg.mapName, 'arena_duel');
    // both clients predict on the new map: positions agree with the server (no misprediction) after settling
    await sleep(500);
    for (const c of [A, B]) { const sp = server.game.players.get(c.id); assert.ok(sp && !sp.dead); assert.ok(c.cg.misprediction < 0.5, `${c.cg.name} misprediction ${c.cg.misprediction}`); assert.equal(c.cg.game.players.get(c.id).frags, 0); }
    assert.equal(server.session.matches, 1);
  });
});

test('e2e: nobody clicks -> the match restarts by itself after the intermission on the same map', async () => {
  await endToEnd({ warmup: 200, timelimit: 1000, intermission: 1500 }, async ({ server, A, B }) => {
    server.game.players.get(B.id).frags = 1;
    await A.waitFor((cg) => cg.game.match.state === 'ended', 5000);
    const t0 = performance.now();
    await A.waitFor((cg) => cg.game.match.state === 'playing' && cg.game.players.get(B.id).frags === 0, 6000);
    const dt = performance.now() - t0;
    assert.ok(dt > 1200 && dt < 4000, `restarted after ${dt.toFixed(0)} ms`);
    assert.equal(A.mapChanges.length, 0); assert.equal(B.cg.mapName, 'testbox');
    assert.equal(A.events.filter((e) => e.type === EV.MATCH_START).length, 2);
  });
});
