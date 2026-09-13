#!/usr/bin/env node
// Headless authoritative game server: HTTP static files + WebSocket game transport on one port.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadMap } from '../shared/map.js';
import { TICK_RATE } from '../shared/constants.js';
import { PORT, encode, decode } from '../shared/protocol.js';
import { GameSession } from '../shared/session.js';
import { NetSim } from './netsim.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export function parseArgs(argv) {
  const a = { port: PORT, map: 'arena_duel', mode: 'duel', bots: 0, snapRate: 60, latency: 0, jitter: 0, loss: 0, lagComp: true, host: '0.0.0.0', quiet: false, timelimit: null, maxClients: 2, seed: 1337, botSkill: 0.7, netsimQuery: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    switch (k) {
      case '--port': a.port = +v; i++; break;
      case '--map': a.map = v; i++; break;
      case '--mode': a.mode = v === 'arena' ? 'arena' : 'duel'; i++; break;
      case '--bots': a.bots = +v; i++; break;
      case '--bot-skill': a.botSkill = +v; i++; break;
      case '--snap-rate': a.snapRate = +v; i++; break;
      case '--latency': a.latency = +v; i++; break;
      case '--jitter': a.jitter = +v; i++; break;
      case '--loss': a.loss = +v; i++; break;
      case '--no-lagcomp': a.lagComp = false; break;
      case '--netsim-query': a.netsimQuery = true; break;
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
  --bots N         add N bots (0-2)   --bot-skill 0..1
  --snap-rate N    snapshots per second 20..60 (default 60)
  --latency MS --jitter MS --loss PCT   simulate network conditions for every client (testing only)
  --netsim-query   let each client pick its own simulated conditions via ws://host:port/?latency=&jitter=&loss= (testing only)
  --no-lagcomp     disable hitscan lag compensation
  --timelimit MIN  duel time limit in minutes (default 10)
  --host ADDR      bind address (default 0.0.0.0)`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };

export async function createServer(opts) {
  const args = { ...parseArgs([]), ...opts };
  const map = await loadMap(args.map);
  const rules = { ...(opts.rules || {}) }; // programmatic callers (tests, netbench) may override match rules
  if (args.timelimit != null) rules.timelimit = args.timelimit * 60 * 1000;
  const log = (...m) => { if (!args.quiet) console.log(new Date().toISOString().slice(11, 19), ...m); };
  const session = new GameSession(map, { mode: args.mode, snapRate: args.snapRate, lagComp: args.lagComp, maxClients: args.maxClients, seed: args.seed, rules, log });

  const httpServer = http.createServer((req, res) => {
    let url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/') url = '/client/index.html';
    if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (url === '/info') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify({ ...session.info(), uptime: Math.round(performance.now() / 1000), lagComp: args.lagComp, clients: session.clients.size })); return; }
    let file;
    if (url.startsWith('/vendor/three/')) file = path.join(ROOT, 'node_modules/three', url.slice('/vendor/three/'.length));
    else if (url.startsWith('/vendor/peerjs/')) file = path.join(ROOT, 'node_modules/peerjs/dist', url.slice('/vendor/peerjs/'.length));
    else file = path.join(ROOT, url);
    if (!file.startsWith(ROOT) || url.includes('/.') ) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    });
  });
  // maxPayload: a command batch is < 1 KB; anything bigger is garbage and closes the socket.
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 16 * 1024 });
  const sockets = new Set();
  wss.on('connection', (ws, req) => {
    sockets.add(ws);
    let sim = { latency: args.latency, jitter: args.jitter, loss: args.loss };
    if (args.netsimQuery) { // per-client conditions for tests (e.g. one laggy shooter vs one LAN target)
      const q = new URL(req.url || '/', 'http://x').searchParams;
      sim = { latency: +(q.get('latency') ?? sim.latency), jitter: +(q.get('jitter') ?? sim.jitter), loss: +(q.get('loss') ?? sim.loss) };
    }
    const netsim = new NetSim(sim);
    let closed = false;
    const link = {
      onmessage: null, onclose: null,
      send: (obj) => { const s = encode(obj); client.bytesOut += s.length; netsim.send(s, (d) => { if (ws.readyState === 1) ws.send(d); }); },
      close: () => ws.close(),
    };
    const client = session.attach(link, { addr: req.socket.remoteAddress, netsim: sim });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      client.bytesIn = (client.bytesIn || 0) + data.length;
      netsim.recv(data.toString(), (str) => { if (closed) return; const m = decode(str); if (m && link.onmessage) link.onmessage(m); });
    });
    ws.on('close', () => { closed = true; sockets.delete(ws); link.onclose && link.onclose(); });
    ws.on('error', () => {});
  });
  for (let i = 0; i < args.bots; i++) session.addBot(undefined, args.botSkill);

  const timer = setInterval(() => session.frame(performance.now()), 4);
  const statsTimer = setInterval(() => {
    if (args.quiet) return;
    const s = session.tickStats();
    log(`tick ${session.game.tick} match=${session.game.match.state} players=${session.game.players.size} tickms avg=${s.avg.toFixed(3)} max=${s.max.toFixed(2)}`);
  }, 10000);

  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(args.port, args.host, resolve); });
  const addr = httpServer.address();
  log(`arena-duel server listening on http://${args.host === '0.0.0.0' ? 'localhost' : args.host}:${addr.port}  map=${args.map} mode=${args.mode} tick=${TICK_RATE}Hz snap=${TICK_RATE / session.snapEvery}Hz lagcomp=${args.lagComp}${args.latency || args.loss ? ` netsim=${args.latency}±${args.jitter}ms loss=${args.loss}%` : ''}`);

  return {
    session, get game() { return session.game; }, args, port: addr.port, httpServer, // game: a getter, the session rebuilds it on a map change
    // closeAllConnections: an idle HTTP keep-alive connection (e.g. from a /info fetch) would otherwise keep close() pending forever
    close: () => new Promise((r) => { clearInterval(timer); clearInterval(statsTimer); for (const ws of sockets) ws.terminate(); wss.close(); httpServer.close(() => r()); httpServer.closeAllConnections?.(); }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer(parseArgs(process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
}
