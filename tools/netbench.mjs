#!/usr/bin/env node
// Netcode benchmark: for each simulated network condition, run the real server in-process with two headless clients
// (client/net/clientgame.js over real WebSockets) driving scripted movement at 60 Hz, and report prediction error,
// snapshot/command rates, bandwidth and server tick cost as a markdown table (paste into docs/NETWORKING.md).
// usage: node tools/netbench.mjs [--seconds 8] [--port 27995] [--map testbox] [--rows "0/0/0,100/20/2"] [--json out.json]
import fs from 'node:fs';
import { createServer } from '../server/index.mjs';
import { connectHeadless, sleep } from '../client/net/headless.js';
import { loadMap } from '../shared/map.js';
import { BUTTONS } from '../shared/constants.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const seconds = +(args.seconds || 8);
const port = +(args.port || 27995);
const mapName = args.map || 'testbox';
const rows = String(args.rows || '0/0/0,50/10/0,100/20/2,150/30/2,250/50/5').split(',').map((r) => { const [latency, jitter, loss] = r.split('/').map(Number); return { latency, jitter, loss }; });
const map = await loadMap(mapName);

// scripted movement: run, strafe, turn and jump (exercises ground/air physics, wall sliding and the jump pad)
const mover = (phase) => (t, cg, ys) => {
  ys.yaw = phase + Math.sin(t * 1.3 + phase) * 70;
  return { forward: Math.sin(t * 0.9 + phase) > -0.3 ? 127 : -127, right: Math.sin(t * 2.1 + phase) > 0 ? 127 : -127, buttons: (Math.floor(t * 4 + phase) % 3 === 0) ? BUTTONS.JUMP : 0 };
};

const results = [];
for (const row of rows) {
  const server = await createServer({ port, map: mapName, quiet: true, ...row, rules: { warmup: 500 } });
  const url = `ws://127.0.0.1:${port}/`;
  const A = await connectHeadless({ url, map, name: 'A', script: mover(0) });
  const B = await connectHeadless({ url, map, name: 'B', script: mover(90) });
  await A.waitFor((cg) => cg.predicted && cg.game.match.state === 'playing', 20000);
  await B.waitFor((cg) => cg.predicted && cg.game.match.state === 'playing', 20000);
  await sleep(500);
  for (const c of [A, B]) { c.cg.mispredMax = 0; c.cg.corrections = 0; c.cg.stats.extrapolated = 0; }
  server.session.tickTimes.length = 0;
  const s0 = [A.stats(), B.stats()];
  const t0 = performance.now();
  while (performance.now() - t0 < seconds * 1000) await sleep(50);
  const dt = (performance.now() - t0) / 1000;
  const s1 = [A.stats(), B.stats()];
  const tick = server.session.tickStats();
  const per = [0, 1].map((i) => ({
    mispredMax: s1[i].mispredMax, corrections: s1[i].corrections, extrapolated: s1[i].extrapolated,
    snapHz: (s1[i].snaps - s0[i].snaps) / dt, cmdHz: (s1[i].cmds - s0[i].cmds) / dt, rtt: s1[i].rtt, jitter: s1[i].jitter,
    kbIn: (s1[i].bytesIn - s0[i].bytesIn) / dt / 1024, kbOut: (s1[i].bytesOut - s0[i].bytesOut) / dt / 1024,
  }));
  const avg = (k) => (per[0][k] + per[1][k]) / 2;
  results.push({
    ...row, rtt: avg('rtt'), rttJitter: avg('jitter'), mispredMax: Math.max(per[0].mispredMax, per[1].mispredMax), corrections: per[0].corrections + per[1].corrections,
    extrapolated: per[0].extrapolated + per[1].extrapolated, snapHz: avg('snapHz'), cmdHz: avg('cmdHz'), kbIn: avg('kbIn'), kbOut: avg('kbOut'), tickAvg: tick.avg, tickMax: tick.max,
  });
  A.stop(); B.stop(); await server.close();
  await sleep(200);
}

const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-');
const lines = [
  `| latency ± jitter / loss | measured RTT | mispred. max (units) | corrections | snapshot Hz | cmd Hz | in KB/s per client | out KB/s per client | server tick ms avg / max |`,
  `|---|---|---|---|---|---|---|---|---|`,
  ...results.map((r) => `| ${r.latency} ± ${r.jitter} ms / ${r.loss}% | ${f(r.rtt, 0)} ms | ${f(r.mispredMax, 3)} | ${r.corrections} | ${f(r.snapHz)} | ${f(r.cmdHz)} | ${f(r.kbIn)} | ${f(r.kbOut)} | ${f(r.tickAvg, 3)} / ${f(r.tickMax, 2)} |`),
];
console.log(`netbench: map=${mapName}, ${seconds} s per row, 2 scripted clients (movement only), server tick 60 Hz, snapshots 60 Hz, Node ${process.version}`);
console.log(lines.join('\n'));
if (args.json) fs.writeFileSync(String(args.json), JSON.stringify({ map: mapName, seconds, node: process.version, date: new Date().toISOString(), results }, null, 2));
process.exit(0);
