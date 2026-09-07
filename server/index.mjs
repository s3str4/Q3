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
  const a = { port: PORT, map: 'arena_duel', mode: 'duel', bots: 0, snapRate: 60, latency: 0, jitter: 0, loss: 0, lagComp: true, host: '0.0.0.0', quiet: false, timelimit: null, maxClients: 2, seed: 1337, botSkill: 0.7 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    switch (k) {
      case '--port': a.port = +v; i++; break;
      case '--map': a.map = v; i++; break;
      case '--mode': a.mode = v; i++; break;
      case '--bots': a.bots = +v; i++; break;
      case '--bot-skill': a.botSkill = +v; i++; break;
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
  --bots N         add N bots (0-2)   --bot-skill 0..1
  --snap-rate N    snapshots per second 20..60 (default 60)
  --latency MS --jitter MS --loss PCT   simulate network conditions for every client (testing only)
  --no-lagcomp     disable hitscan lag compensation
  --timelimit MIN  duel time limit in minutes (default 10)
  --host ADDR      bind address (default 0.0.0.0)`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };

export async function createServer(opts) {
  const args = { ...parseArgs([]), ...opts };
  const map = await loadMap(args.map);
  const rules = {};
  if (args.timelimit != null) rules.timelimit = args.timelimit * 60 * 1000;
  const log = (...m) => { if (!args.quiet) console.log(new Date().toISOString().slice(11, 19), ...m); };
  const session = new GameSession(map, { mode: args.mode, snapRate: args.snapRate, lagComp: args.lagComp, maxClients: args.maxClients, seed: args.seed, rules, log });

  const httpServer = http.createServer((req, res) => {
    let url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/') url = '/client/index.html';
    if (url === '/info') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(session.info())); return; }
    let file;
    if (url.startsWith('/vendor/three/')) file = path.join(ROOT, 'node_modules/three', url.slice('/vendor/three/'.length));
    else file = path.join(ROOT, url);
    if (!file.startsWith(ROOT) || url.includes('/.') ) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    });
  });
  const wss = new WebSocketServer({ server: httpServer });
  const sockets = new Set();
  wss.on('connection', (ws, req) => {
    sockets.add(ws);
    const netsim = new NetSim({ latency: args.latency, jitter: args.jitter, loss: args.loss });
    const link = { onmessage: null, onclose: null, send: (obj) => { const s = encode(obj); netsim.send(s, (d) => { if (ws.readyState === 1) ws.send(d); }); }, close: () => ws.close() };
    session.attach(link, { addr: req.socket.remoteAddress });
    ws.on('message', (data) => netsim.recv(data.toString(), (str) => { const m = decode(str); if (m && link.onmessage) link.onmessage(m); }));
    ws.on('close', () => { sockets.delete(ws); link.onclose && link.onclose(); });
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
  log(`arena-duel server listening on http://localhost:${addr.port}  map=${args.map} mode=${args.mode} tick=${TICK_RATE}Hz snap=${TICK_RATE / session.snapEvery}Hz lagcomp=${args.lagComp}${args.latency || args.loss ? ` netsim=${args.latency}±${args.jitter}ms loss=${args.loss}%` : ''}`);

  return {
    session, game: session.game, args, port: addr.port, httpServer,
    close: () => new Promise((r) => { clearInterval(timer); clearInterval(statsTimer); for (const ws of sockets) ws.terminate(); wss.close(); httpServer.close(() => r()); }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer(parseArgs(process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
}
