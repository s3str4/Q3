// Transport-agnostic authoritative session: used by the Node headless server and by the browser P2P host.
// A "link" is { send(obj), close(), onmessage, onclose } - WebSocket, DataChannel or an in-memory loopback.
//
// Match flow across matches: when the Game ends a match the session opens an intermission. Each joined client may
// VOTE a map/mode for the next match and toggle REMATCH (ready); bots are always ready. When every human is ready,
// or after rules.intermission ms, the next match starts: same map -> Game.resetMatch(); a different map or mode ->
// the Game is rebuilt (loadMap) with the same players, MAPCHANGE tells the clients to rebuild theirs, and the
// countdown is held until every client answered LOADED (or 30 s pass).
import { Game, MAX_CMD_QUEUE as GAME_MAX_CMD_QUEUE } from './game.js';
import { Bot } from './bot.js';
import { TICK_MS, TICK_RATE } from './constants.js';
import { PROTOCOL_VERSION, MSG, compactSnapshot } from './protocol.js';
import { loadMap as defaultLoadMap } from './map.js';
import { MAPS } from '../maps/index.js';

const MODES = ['duel', 'arena'];
const LOAD_TIMEOUT_MS = 30000; // a client that never reports LOADED after a map change does not block the others forever

export class GameSession {
  constructor(map, opts = {}) {
    this.map = map;
    this.opts = { mode: 'duel', snapRate: 60, lagComp: true, maxClients: 2, seed: 1337, rules: {}, log: () => {}, loadMap: defaultLoadMap, maps: MAPS.map((m) => m.id), ...opts };
    if (!MODES.includes(this.opts.mode)) this.opts.mode = 'duel';
    this.game = this.newGame(map, this.opts.mode);
    this.clients = new Map();
    this.bots = new Map();
    this.nextId = 1;
    this.snapEvery = Math.max(1, Math.round(TICK_RATE / Math.min(60, Math.max(20, this.opts.snapRate))));
    this.acc = 0; this.last = null; this.tickTimes = [];
    this.botNames = ['Sarge', 'Visor', 'Anarki', 'Xaero'];
    this.inter = null;          // intermission: { autoAt } (votes and ready flags live on the clients)
    this.pendingLoads = new Set(); this.holdUntil = 0; this.changing = false;
    this.matches = 0;           // matches started by the session (map changes + rematches), for tests / logs
  }
  log(...m) { this.opts.log(...m); }
  newGame(map, mode) { return new Game(map, { mode, seed: this.opts.seed, lagComp: this.opts.lagComp, rules: this.opts.rules }); }

  attach(link, meta = {}) {
    const id = this.nextId++;
    const c = { id, link, name: null, joined: false, snapEvents: [], bytesOut: 0, addr: meta.addr || 'local', local: !!meta.local, cmdWindow: [], cmdsDropped: 0, cmdsReceived: 0, msgs: 0, vote: null, ready: false };
    this.clients.set(id, c);
    link.onmessage = (msg) => this.handle(c, msg);
    link.onclose = () => this.detach(c);
    this.log(`client ${id} connected (${c.addr})`);
    return c;
  }
  detach(c) {
    if (!this.clients.has(c.id)) return;
    this.clients.delete(c.id);
    if (c.joined) this.game.removePlayer(c.id);
    this.pendingLoads.delete(c.id);
    if (this.pendingLoads.size === 0 && this.game.match.hold) this.game.setHold(false);
    // Q3 tourney semantics: when no human is left, the match is over; reset so the next player gets a fresh warmup
    if (c.joined && ![...this.game.players.values()].some((p) => !p.isBot)) this.game.resetMatch();
    this.log(`client ${c.id} disconnected`);
    this.broadcastInfo();
    if (this.inter) { this.broadcastVotes(); this.checkAllReady(); }
  }
  send(c, obj) { try { c.link.send(obj); } catch {} }

  info() {
    return { name: 'arena-duel', version: PROTOCOL_VERSION, map: this.map.name, mode: this.opts.mode, players: [...this.game.players.values()].map((p) => ({ name: p.name, bot: p.isBot, frags: p.frags })), tick: TICK_RATE, snapRate: TICK_RATE / this.snapEvery, match: this.game.match.state };
  }
  sendWelcome(c) { this.send(c, { t: MSG.WELCOME, id: c.id, map: this.map.name, mode: this.opts.mode, tick: this.game.tick, time: this.game.time, snapRate: TICK_RATE / this.snapEvery, rules: this.game.rules, lagComp: this.opts.lagComp, maps: this.opts.maps }); }
  broadcastInfo() { const info = this.info(); for (const c of this.clients.values()) this.send(c, { t: MSG.INFO, info }); }

  handle(c, msg) {
    if (!msg || typeof msg !== 'object') return;
    c.msgs++;
    switch (msg.t) {
      case MSG.JOIN: {
        if (msg.v !== PROTOCOL_VERSION) { this.send(c, { t: MSG.KICK, reason: `protocol mismatch (server ${PROTOCOL_VERSION}, client ${msg.v})` }); c.link.close(); return; }
        // Already joined: the client did not get our WELCOME (lost packet on an unreliable P2P channel, or the JOIN retry
        // raced the reply). Resend WELCOME and INFO so it can complete the handshake; never add a second player.
        if (c.joined) { this.sendWelcome(c); this.send(c, { t: MSG.INFO, info: this.info() }); return; }
        if (typeof msg.name !== 'string' && msg.name != null) return;
        const humans = [...this.game.players.values()].filter((p) => !p.isBot).length;
        if (humans + this.bots.size >= this.opts.maxClients) {
          const b = [...this.bots.keys()][0];
          if (b !== undefined) this.removeBot(b); else { this.send(c, { t: MSG.KICK, reason: 'server full' }); c.link.close(); return; }
        }
        c.name = String(msg.name || `player${c.id}`).slice(0, 24);
        c.joined = true;
        this.game.addPlayer(c.id, c.name);
        this.sendWelcome(c);
        this.log(`player ${c.id} "${c.name}" joined`);
        if (msg.bot && this.game.players.size < 2 && this.bots.size === 0) this.addBot(undefined, Number.isFinite(msg.botSkill) ? msg.botSkill : undefined);
        this.broadcastInfo();
        if (this.inter) this.broadcastVotes();
        break;
      }
      case MSG.CMD: {
        if (!c.joined || !Array.isArray(msg.c) || msg.c.length > MAX_CMDS_PER_MSG) return;
        const p = this.game.players.get(c.id);
        if (!p) return;
        for (const cmd of msg.c) {
          if (!validCmd(cmd)) { c.cmdsDropped++; continue; }
          if (cmd.seq <= p.lastCmdSeq) continue; // redundant resend of an executed command: not counted against the rate
          if (p.cmdQueue.length && cmd.seq <= p.cmdQueue[p.cmdQueue.length - 1].seq) continue; // already queued
          // rate limit: a 60 Hz client sends 60 new commands per second; allow bursts (catch-up after a stall) but
          // never more than MAX_CMD_RATE per second, and never let the queue grow past MAX_CMD_QUEUE.
          if (p.cmdQueue.length >= MAX_CMD_QUEUE) { c.cmdsDropped++; continue; }
          const now = this.game.time;
          while (c.cmdWindow.length && c.cmdWindow[0] <= now - 1000) c.cmdWindow.shift();
          if (c.cmdWindow.length >= MAX_CMD_RATE) { c.cmdsDropped++; continue; }
          c.cmdWindow.push(now);
          c.cmdsReceived++;
          this.game.queueCommand(c.id, cmd);
        }
        break;
      }
      case MSG.PING: {
        if (!Number.isFinite(msg.c)) return;
        this.send(c, { t: MSG.PONG, c: msg.c, s: this.game.time });
        if (Number.isFinite(msg.rtt)) { const p = this.game.players.get(c.id); if (p) p.ping = Math.max(0, Math.min(9999, Math.round(msg.rtt))); }
        break;
      }
      case MSG.CHAT: { if (!c.joined) return; const text = String(msg.text || '').slice(0, 120); for (const o of this.clients.values()) this.send(o, { t: MSG.CHAT, from: c.name, text }); break; }
      // ---- intermission: next map / mode vote and ready toggle (only while a match has ended) ----
      case MSG.VOTE: {
        if (!c.joined || !this.inter) return;
        const v = c.vote || { map: null, mode: null };
        if (msg.map != null) v.map = this.opts.maps.includes(msg.map) ? msg.map : null;
        if (msg.mode != null) v.mode = MODES.includes(msg.mode) ? msg.mode : null;
        c.vote = v;
        this.broadcastVotes();
        break;
      }
      case MSG.REMATCH: {
        if (!c.joined || !this.inter) return;
        c.ready = msg.ready !== false;
        this.broadcastVotes();
        this.checkAllReady();
        break;
      }
      case MSG.LOADED: {
        if (!c.joined) return;
        if (msg.map != null && msg.map !== this.map.name) return; // a stale LOADED for the previous map does not count
        this.pendingLoads.delete(c.id);
        if (this.pendingLoads.size === 0 && this.game.match.hold) { this.game.setHold(false); this.log('all clients loaded ' + this.map.name); }
        break;
      }
    }
  }

  addBot(name, skill) {
    const id = this.nextId++;
    const p = this.game.addPlayer(id, name || this.botNames[this.bots.size % this.botNames.length], { isBot: true });
    this.bots.set(id, new Bot(this.game, p, { skill: skill ?? 0.7, seed: this.opts.seed + id }));
    this.broadcastInfo();
    return id;
  }
  removeBot(id) { this.game.removePlayer(id); this.bots.delete(id); }

  // ---- intermission ----
  humans() { return [...this.clients.values()].filter((c) => c.joined); }
  onMatchEnd() {
    this.inter = { autoAt: this.game.match.endTime + this.game.rules.intermission };
    for (const c of this.clients.values()) { c.vote = null; c.ready = false; }
    this.broadcastVotes();
  }
  // Next map/mode: unanimous vote wins, otherwise the first voter's (lowest id: the P2P host / first to join); no vote = current.
  resolveVote() {
    const voters = this.humans().filter((c) => c.vote).sort((a, b) => a.id - b.id);
    const pick = (key, current) => {
      const vs = voters.map((c) => c.vote[key]).filter((v) => v != null);
      return vs.length ? vs[0] : current; // unanimous or not, the first voter's pick is the answer
    };
    return { map: pick('map', this.map.name), mode: pick('mode', this.opts.mode) };
  }
  votesMsg() {
    const players = {};
    for (const c of this.humans()) players[c.id] = { name: c.name, bot: false, map: c.vote ? c.vote.map : null, mode: c.vote ? c.vote.mode : null, ready: !!c.ready };
    for (const [id, b] of this.bots) players[id] = { name: b.p.name, bot: true, map: null, mode: null, ready: true };
    return { t: MSG.VOTES, players, next: this.resolveVote(), left: this.inter ? Math.max(0, this.inter.autoAt - this.game.time) : 0, open: !!this.inter };
  }
  broadcastVotes() { const m = this.votesMsg(); for (const c of this.clients.values()) if (c.joined) this.send(c, m); }
  checkAllReady() {
    if (!this.inter) return;
    const hs = this.humans();
    if (hs.length && hs.every((c) => c.ready)) this.startNext();
  }
  // Start the next match now: same map -> reset in place; new map or mode -> rebuild the game (async map load).
  startNext() {
    if (!this.inter || this.changing) return;
    const { map, mode } = this.resolveVote();
    this.inter = null;
    for (const c of this.clients.values()) { c.vote = null; c.ready = false; }
    this.matches++;
    if (map === this.map.name && mode === this.opts.mode) { this.game.resetMatch(); this.broadcastVotes(); return Promise.resolve(); }
    return this.changeMap(map, mode);
  }
  async changeMap(name, mode = this.opts.mode) {
    if (this.changing) return;
    this.changing = true;
    let map;
    try { map = await this.opts.loadMap(name); }
    catch (e) { this.log(`map ${name} failed to load (${e && e.message}); staying on ${this.map.name}`); this.changing = false; this.game.resetMatch(); this.broadcastVotes(); return; }
    this.map = map; this.opts.mode = MODES.includes(mode) ? mode : this.opts.mode;
    const old = this.game;
    const game = this.newGame(map, this.opts.mode);
    for (const c of this.clients.values()) if (c.joined) { const p = game.addPlayer(c.id, c.name); const op = old.players.get(c.id); if (op) p.ping = op.ping; }
    for (const [id, b] of this.bots) { const p = game.addPlayer(id, b.p.name, { isBot: true }); this.bots.set(id, new Bot(game, p, { skill: b.skill, seed: this.opts.seed + id })); }
    this.game = game;
    // hold the countdown until every client has rebuilt its game for this map
    this.pendingLoads = new Set(this.humans().map((c) => c.id));
    if (this.pendingLoads.size) { game.setHold(true); this.holdUntil = game.time + LOAD_TIMEOUT_MS; }
    for (const c of this.clients.values()) { c.snapEvents = []; if (c.joined) this.send(c, { t: MSG.MAPCHANGE, map: map.name, mode: this.opts.mode, rules: game.rules, tick: game.tick, time: game.time }); }
    this.changing = false;
    this.log(`map changed to ${map.name} (${this.opts.mode})`);
    this.broadcastInfo();
    this.broadcastVotes();
  }

  // Advance simulation by wall-clock time; call frequently (every few ms). Returns steps run.
  frame(now) {
    if (this.last == null) this.last = now;
    this.acc += now - this.last; this.last = now;
    let steps = 0;
    const clock = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
    while (this.acc >= TICK_MS && steps < 8) {
      const t0 = clock();
      this.step();
      this.acc -= TICK_MS; steps++;
      const dt = clock() - t0;
      this.tickTimes.push(dt); if (this.tickTimes.length > 600) this.tickTimes.shift();
    }
    if (this.acc > TICK_MS * 8) this.acc = 0;
    return steps;
  }
  step() {
    if (this.changing) return; // between the old game and the new one (map module loading): nothing to simulate
    // auto restart: checked before the tick so the session (which honours the votes) pre-empts the Game's own
    // same-map fallback that fires at the same time
    if (this.inter && this.game.time + TICK_MS >= this.inter.autoAt) { this.startNext(); if (this.changing) return; }
    const game = this.game;
    const wasEnded = game.match.state === 'ended';
    for (const b of this.bots.values()) b.think();
    const events = game.step();
    for (const c of this.clients.values()) c.snapEvents.push(...events);
    if (game.tick % this.snapEvery === 0) {
      const base = game.snapshot();
      for (const c of this.clients.values()) {
        if (!c.joined) continue;
        const snap = compactSnapshot({ ...base, ev: c.snapEvents }, c.id);
        c.snapEvents = [];
        this.send(c, { t: MSG.SNAP, s: snap });
      }
    }
    if (game.match.state === 'ended' && !wasEnded) this.onMatchEnd();
    else if (this.inter && game.match.state !== 'ended') { this.inter = null; this.broadcastVotes(); } // the game reset itself (no human left)
    if (this.inter && game.time >= this.inter.autoAt) this.startNext();
    if (game.match.hold && game.time >= this.holdUntil) { this.pendingLoads.clear(); game.setHold(false); this.log('load timeout: countdown released'); }
  }
  tickStats() { const t = this.tickTimes; return { avg: t.reduce((a, b) => a + b, 0) / (t.length || 1), max: Math.max(0, ...t) }; }
}

// Input validation: every field the simulation reads must be a finite number in range. Rejected commands are dropped
// (never executed), so a hostile client can at worst freeze its own player.
export const MAX_CMDS_PER_MSG = 8;   // client sends the last 3 commands per message; 8 leaves room for catch-up bursts
export const MAX_CMD_RATE = 120;     // new commands per second per client (client runs 60 Hz; 2x allows post-stall catch-up)
export const MAX_CMD_QUEUE = GAME_MAX_CMD_QUEUE; // same bound as Game.MAX_CMD_QUEUE (~1.5 s of input)
export function validCmd(c) {
  if (!c || typeof c !== 'object') return false;
  if (!Number.isInteger(c.seq) || c.seq <= 0 || c.seq > 2 ** 31) return false;
  if (!Number.isFinite(c.forward) || !Number.isFinite(c.right) || !Number.isFinite(c.up)) return false;
  if (Math.abs(c.forward) > 127 || Math.abs(c.right) > 127 || Math.abs(c.up) > 127) return false;
  if (!Array.isArray(c.angles) || c.angles.length < 2 || !Number.isFinite(c.angles[0]) || !Number.isFinite(c.angles[1])) return false;
  if (Math.abs(c.angles[0]) > 1e6 || Math.abs(c.angles[1]) > 1e6) return false;
  if (c.buttons != null && (!Number.isInteger(c.buttons) || c.buttons < 0 || c.buttons > 0xffff)) return false;
  if (c.weapon != null && (!Number.isInteger(c.weapon) || c.weapon < 0 || c.weapon > 8)) return false;
  if (c.vt != null && !Number.isFinite(c.vt)) return false;
  return true;
}

// In-memory link pair for a host that is also a player.
export function loopbackPair() {
  const a = { onmessage: null, onclose: null, send: (o) => queueMicrotask(() => b.onmessage && b.onmessage(clone(o))), close: () => { a.onclose && a.onclose(); b.onclose && b.onclose(); } };
  const b = { onmessage: null, onclose: null, send: (o) => queueMicrotask(() => a.onmessage && a.onmessage(clone(o))), close: () => { b.onclose && b.onclose(); a.onclose && a.onclose(); } };
  return [a, b];
}
const clone = (o) => JSON.parse(JSON.stringify(o));
