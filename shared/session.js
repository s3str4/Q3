// Transport-agnostic authoritative session: used by the Node headless server and by the browser P2P host.
// A "link" is { send(obj), close(), onmessage, onclose } - WebSocket, DataChannel or an in-memory loopback.
import { Game } from './game.js';
import { Bot } from './bot.js';
import { TICK_MS, TICK_RATE } from './constants.js';
import { PROTOCOL_VERSION, MSG, compactSnapshot } from './protocol.js';

export class GameSession {
  constructor(map, opts = {}) {
    this.map = map;
    this.opts = { mode: 'duel', snapRate: 60, lagComp: true, maxClients: 2, seed: 1337, rules: {}, log: () => {}, ...opts };
    this.game = new Game(map, { mode: this.opts.mode, seed: this.opts.seed, lagComp: this.opts.lagComp, rules: this.opts.rules });
    this.clients = new Map();
    this.bots = new Map();
    this.nextId = 1;
    this.snapEvery = Math.max(1, Math.round(TICK_RATE / Math.min(60, Math.max(20, this.opts.snapRate))));
    this.acc = 0; this.last = null; this.tickTimes = [];
    this.botNames = ['Sarge', 'Visor', 'Anarki', 'Xaero'];
  }
  log(...m) { this.opts.log(...m); }

  attach(link, meta = {}) {
    const id = this.nextId++;
    const c = { id, link, name: null, joined: false, snapEvents: [], bytesOut: 0, addr: meta.addr || 'local', local: !!meta.local };
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
    this.log(`client ${c.id} disconnected`);
    this.broadcastInfo();
  }
  send(c, obj) { try { c.link.send(obj); } catch {} }

  info() {
    return { name: 'arena-duel', version: PROTOCOL_VERSION, map: this.map.name, mode: this.opts.mode, players: [...this.game.players.values()].map((p) => ({ name: p.name, bot: p.isBot, frags: p.frags })), tick: TICK_RATE, snapRate: TICK_RATE / this.snapEvery, match: this.game.match.state };
  }
  broadcastInfo() { const info = this.info(); for (const c of this.clients.values()) this.send(c, { t: MSG.INFO, info }); }

  handle(c, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case MSG.JOIN: {
        if (msg.v !== PROTOCOL_VERSION) { this.send(c, { t: MSG.KICK, reason: `protocol mismatch (server ${PROTOCOL_VERSION}, client ${msg.v})` }); c.link.close(); return; }
        if (c.joined) return;
        const humans = [...this.game.players.values()].filter((p) => !p.isBot).length;
        if (humans + this.bots.size >= this.opts.maxClients) {
          const b = [...this.bots.keys()][0];
          if (b !== undefined) this.removeBot(b); else { this.send(c, { t: MSG.KICK, reason: 'server full' }); c.link.close(); return; }
        }
        c.name = String(msg.name || `player${c.id}`).slice(0, 24);
        c.joined = true;
        this.game.addPlayer(c.id, c.name);
        this.send(c, { t: MSG.WELCOME, id: c.id, map: this.map.name, mode: this.opts.mode, tick: this.game.tick, time: this.game.time, snapRate: TICK_RATE / this.snapEvery, rules: this.game.rules, lagComp: this.opts.lagComp });
        this.log(`player ${c.id} "${c.name}" joined`);
        if (msg.bot && this.game.players.size < 2 && this.bots.size === 0) this.addBot(undefined, msg.botSkill);
        this.broadcastInfo();
        break;
      }
      case MSG.CMD: if (c.joined && Array.isArray(msg.c)) for (const cmd of msg.c) if (validCmd(cmd)) this.game.queueCommand(c.id, cmd); break;
      case MSG.PING: this.send(c, { t: MSG.PONG, c: msg.c, s: this.game.time }); if (msg.rtt != null) { const p = this.game.players.get(c.id); if (p) p.ping = Math.round(msg.rtt); } break;
      case MSG.CHAT: { const text = String(msg.text || '').slice(0, 120); for (const o of this.clients.values()) this.send(o, { t: MSG.CHAT, from: c.name, text }); break; }
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

  // Advance simulation by wall-clock time; call frequently (every few ms). Returns steps run.
  frame(now) {
    if (this.last == null) this.last = now;
    this.acc += now - this.last; this.last = now;
    let steps = 0;
    while (this.acc >= TICK_MS && steps < 8) {
      const t0 = now;
      this.step();
      this.acc -= TICK_MS; steps++;
      const dt = (typeof performance !== 'undefined' ? performance.now() : now) - t0;
      this.tickTimes.push(dt); if (this.tickTimes.length > 600) this.tickTimes.shift();
    }
    if (this.acc > TICK_MS * 8) this.acc = 0;
    return steps;
  }
  step() {
    for (const b of this.bots.values()) b.think();
    const events = this.game.step();
    for (const c of this.clients.values()) c.snapEvents.push(...events);
    if (this.game.tick % this.snapEvery === 0) {
      const base = this.game.snapshot();
      for (const c of this.clients.values()) {
        if (!c.joined) continue;
        const snap = compactSnapshot({ ...base, ev: c.snapEvents }, c.id);
        c.snapEvents = [];
        this.send(c, { t: MSG.SNAP, s: snap });
      }
    }
  }
  tickStats() { const t = this.tickTimes; return { avg: t.reduce((a, b) => a + b, 0) / (t.length || 1), max: Math.max(0, ...t) }; }
}

function validCmd(c) {
  return c && Number.isFinite(c.seq) && Number.isFinite(c.forward) && Number.isFinite(c.right) && Number.isFinite(c.up) && Array.isArray(c.angles) && c.angles.length >= 2 && Number.isFinite(c.angles[0]) && Number.isFinite(c.angles[1])
    && Math.abs(c.forward) <= 127 && Math.abs(c.right) <= 127 && Math.abs(c.up) <= 127;
}

// In-memory link pair for a host that is also a player.
export function loopbackPair() {
  const a = { onmessage: null, onclose: null, send: (o) => queueMicrotask(() => b.onmessage && b.onmessage(clone(o))), close: () => { a.onclose && a.onclose(); b.onclose && b.onclose(); } };
  const b = { onmessage: null, onclose: null, send: (o) => queueMicrotask(() => a.onmessage && a.onmessage(clone(o))), close: () => { b.onclose && b.onclose(); a.onclose && a.onclose(); } };
  return [a, b];
}
const clone = (o) => JSON.parse(JSON.stringify(o));
