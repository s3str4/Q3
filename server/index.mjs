#!/usr/bin/env node
// Headless authoritative game server: HTTP static files + WebSocket game transport on one port.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game } from '../shared/game.js';
import { loadMap } from '../shared/map.js';
import { TICK_MS, TICK_RATE } from '../shared/constants.js';
import { PROTOCOL_VERSION, PORT, MSG, encode, decode, compactSnapshot } from '../shared/protocol.js';
import { Bot } from '../shared/bot.js';
import { NetSim } from './netsim.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export function parseArgs(argv) {
  const a = { port: PORT, map: 'arena_duel', mode: 'duel', bots: 0, snapRate: 60, latency: 0, jitter: 0, loss: 0, lagComp: true, host: '0.0.0.0', quiet: false, timelimit: null, maxClients: 2, seed: 1337 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--port': a.port = +v; i++; break;
      case '--map': a.map = v; i++; break;
      case '--mode': a.mode = v; i++; break;
      case '--bots': a.bots = +v; i++; break;
      case '--snap-rate': a.snapRate = +v; i++; break;
      case '--latency': a.latency = +v; i++; break;
      case '--jitter': a.jitter = +v; i++; break;
      case '--loss': a.loss = +v; i++; break;
      case '--no-lagcomp': a.lagComp = false; break;
      case '--host': a.host = v; i++; break;
      case '--quiet': a.quiet = true; break;
      case '--timelimit': a.timelimit = +v; i++; break;
      case '--seed': a.seed = +v; i++; break;
      case '--help': console.log(HELP); process.exit(0);
    }
  }
  return a;
}
const HELP = `arena-duel server
  --port N         TCP port for HTTP + WebSocket (default 27960)
  --map NAME       map module in maps/ (default arena_duel)
  --mode duel|arena
  --bots N         add N bots (0-2)
  --snap-rate N    snapshots per second 20..60 (default 60)
  --latency MS --jitter MS --loss PCT   simulate network conditions for every client (testing)
  --no-lagcomp     disable hitscan lag compensation
  --timelimit MIN  duel time limit in minutes (default 10)
  --host ADDR      bind address (default 0.0.0.0)`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };

export async function createServer(opts) {
  const args = { ...parseArgs([]), ...opts };
  const map = await loadMap(args.map);
  const rules = {};
  if (args.timelimit != null) rules.timelimit = args.timelimit * 60 * 1000;
  const game = new Game(map, { mode: args.mode, seed: args.seed, lagComp: args.lagComp, rules });
  const log = (...m) => { if (!args.quiet) console.log(new Date().toISOString().slice(11, 19), ...m); };
  const clients = new Map();
  let nextId = 1;
  const bots = new Map();

  const httpServer = http.createServer((req, res) => {
    let url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/') url = '/client/index.html';
    if (url === '/info') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(serverInfo())); return; }
    let file;
    if (url.startsWith('/vendor/three/')) file = path.join(ROOT, 'node_modules/three', url.slice('/vendor/three/'.length));
    else file = path.join(ROOT, url);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    });
  });
  const wss = new WebSocketServer({ server: httpServer });

  function serverInfo() {
    return { name: 'arena-duel', version: PROTOCOL_VERSION, map: args.map, mode: args.mode, players: [...game.players.values()].map((p) => ({ name: p.name, bot: p.isBot, frags: p.frags })), tick: TICK_RATE, snapRate: args.snapRate, match: game.match.state };
  }

  wss.on('connection', (ws, req) => {
    const id = nextId++;
    const netsim = new NetSim({ latency: args.latency, jitter: args.jitter, loss: args.loss });
    const c = { id, ws, name: null, joined: false, netsim, addr: req.socket.remoteAddress, lastPong: Date.now(), snapEvents: [], snapCounter: 0, bytesOut: 0, bytesIn: 0 };
    clients.set(id, c);
    log(`client ${id} connected from ${c.addr}`);
    const send = (obj) => { const s = encode(obj); c.bytesOut += s.length; netsim.send(s, (data) => { if (ws.readyState === 1) ws.send(data); }); };
    c.send = send;
    ws.on('message', (data) => {
      c.bytesIn += data.length;
      netsim.recv(data.toString(), (str) => {
        const msg = decode(str);
        if (!msg) return;
        handle(c, msg);
      });
    });
    ws.on('close', () => {
      log(`client ${id} disconnected`);
      clients.delete(id);
      if (c.joined) game.removePlayer(id);
      broadcastInfo();
    });
    ws.on('error', () => {});
  });

  function handle(c, msg) {
    switch (msg.t) {
      case MSG.JOIN: {
        if (msg.v !== PROTOCOL_VERSION) { c.send({ t: MSG.KICK, reason: `protocol mismatch (server ${PROTOCOL_VERSION}, client ${msg.v})` }); c.ws.close(); return; }
        const humans = [...game.players.values()].filter((p) => !p.isBot).length;
        if (humans + bots.size >= args.maxClients) {
          // kick a bot to make room for a human
          const b = [...bots.keys()][0];
          if (b !== undefined) { game.removePlayer(b); bots.delete(b); } else { c.send({ t: MSG.KICK, reason: 'server full' }); c.ws.close(); return; }
        }
        c.name = String(msg.name || `player${c.id}`).slice(0, 24);
        c.joined = true;
        game.addPlayer(c.id, c.name);
        c.send({ t: MSG.WELCOME, id: c.id, map: args.map, mode: args.mode, tick: game.tick, time: game.time, snapRate: args.snapRate, rules: game.rules, lagComp: args.lagComp });
        log(`player ${c.id} "${c.name}" joined`);
        broadcastInfo();
        break;
      }
      case MSG.CMD: {
        if (!c.joined) return;
        for (const cmd of msg.c) game.queueCommand(c.id, cmd);
        break;
      }
      case MSG.PING: c.send({ t: MSG.PONG, c: msg.c, s: game.time }); if (msg.rtt != null) { const p = game.players.get(c.id); if (p) p.ping = msg.rtt; } break;
      case MSG.CHAT: { const text = String(msg.text || '').slice(0, 120); for (const o of clients.values()) o.send({ t: MSG.CHAT, from: c.name, text }); break; }
    }
  }
  function broadcastInfo() { const info = serverInfo(); for (const o of clients.values()) o.send({ t: MSG.INFO, info }); }

  function addBot(name, skill) {
    const id = nextId++;
    const p = game.addPlayer(id, name || `bot${id}`, { isBot: true });
    bots.set(id, new Bot(game, p, { skill: skill ?? 0.7, seed: args.seed + id }));
    return id;
  }
  for (let i = 0; i < args.bots; i++) addBot(['Sarge', 'Visor'][i] || `bot${i}`);

  // fixed 60 Hz tick with drift correction
  let acc = 0, last = performance.now();
  let tickTimes = [];
  const snapEvery = Math.max(1, Math.round(TICK_RATE / Math.min(60, Math.max(20, args.snapRate))));
  function frame() {
    const now = performance.now();
    acc += now - last; last = now;
    let steps = 0;
    while (acc >= TICK_MS && steps < 8) {
      const t0 = performance.now();
      for (const b of bots.values()) b.think();
      const events = game.step();
      for (const c of clients.values()) c.snapEvents.push(...events);
      if (game.tick % snapEvery === 0) {
        const base = game.snapshot();
        for (const c of clients.values()) {
          if (!c.joined) continue;
          const snap = compactSnapshot({ ...base, ev: c.snapEvents }, c.id);
          c.snapEvents = [];
          c.send({ t: MSG.SNAP, s: snap });
        }
      }
      acc -= TICK_MS; steps++;
      tickTimes.push(performance.now() - t0);
      if (tickTimes.length > 600) tickTimes.shift();
    }
    if (acc > TICK_MS * 8) acc = 0; // fell behind badly: drop time instead of spiraling
  }
  const timer = setInterval(frame, 4);
  const statsTimer = setInterval(() => {
    if (args.quiet) return;
    const avg = tickTimes.reduce((a, b) => a + b, 0) / (tickTimes.length || 1);
    const max = Math.max(0, ...tickTimes);
    const out = [...clients.values()].reduce((a, c) => a + c.bytesOut, 0);
    log(`tick ${game.tick} match=${game.match.state} players=${game.players.size} tickms avg=${avg.toFixed(3)} max=${max.toFixed(2)} out=${(out / 1024).toFixed(0)}KB`);
  }, 10000);

  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(args.port, args.host, resolve); });
  const addr = httpServer.address();
  log(`arena-duel server listening on http://localhost:${addr.port}  map=${args.map} mode=${args.mode} tick=${TICK_RATE}Hz snap=${TICK_RATE / snapEvery}Hz lagcomp=${args.lagComp}${args.latency ? ` netsim=${args.latency}±${args.jitter}ms loss=${args.loss}%` : ''}`);

  return {
    game, args, clients, bots, addBot, port: addr.port, httpServer,
    tickStats: () => ({ avg: tickTimes.reduce((a, b) => a + b, 0) / (tickTimes.length || 1), max: Math.max(0, ...tickTimes) }),
    close: () => new Promise((r) => { clearInterval(timer); clearInterval(statsTimer); for (const c of clients.values()) c.ws.close(); wss.close(); httpServer.close(() => r()); }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer(parseArgs(process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
}
