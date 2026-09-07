#!/usr/bin/env node
// Headless scripted 1v1: two bots duel in-process for N simulated seconds. Reports frags, damage, per-weapon accuracy,
// movement liveliness (speed, jumps, strafe jumps, dodges, item timing) and sim speed. Exit code 1 when the duel is dead
// (no frags) so it can gate CI.
// usage: node tools/bot_duel.mjs [--map arena_duel] [--seconds 120] [--mode duel] [--seed 7] [--skill 0.8] [--json out.json] [--quiet]
import fs from 'node:fs';
import { Game } from '../shared/game.js';
import { loadMap } from '../shared/map.js';
import { Bot, buildNavGraph } from '../shared/bot.js';
import { EV, TICK_RATE, WEAPON_NAMES } from '../shared/constants.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const mapName = args.map || 'arena_duel';
const seconds = +(args.seconds || 120);
const mode = args.mode || 'duel';
const seed = +(args.seed || 7);
const skill = +(args.skill || 0.8);

const map = await loadMap(mapName);
const game = new Game(map, { mode, seed, rules: { warmup: 1000 } });
const a = game.addPlayer(1, 'Sarge', { isBot: true });
const b = game.addPlayer(2, 'Visor', { isBot: true });
const nav = buildNavGraph(game);
const bots = [new Bot(game, a, { skill, seed: seed + 1, nav }), new Bot(game, b, { skill, seed: seed + 2, nav })];
const counts = {}; const byWeapon = {}; const pickupsByType = {}; let pickups = 0; let jumppads = 0;
let maxRunSpeed = 0, movingTicks = 0, fastTicks = 0, totalTicks = 0, stuckTicks = 0;
const lastPos = new Map(); const still = new Map();
const t0 = performance.now();
const ticks = seconds * TICK_RATE;
for (let i = 0; i < ticks; i++) {
  for (const bt of bots) bt.think();
  const ev = game.step();
  for (const e of ev) {
    counts[e.type] = (counts[e.type] || 0) + 1;
    if (e.type === EV.DEATH) byWeapon[e.mod] = (byWeapon[e.mod] || 0) + 1;
    if (e.type === EV.PICKUP) { pickups++; pickupsByType[e.itemType] = (pickupsByType[e.itemType] || 0) + 1; }
    if (e.type === EV.JUMPPAD) jumppads++;
  }
  for (const p of game.players.values()) {
    if (p.dead) continue;
    totalTicks++;
    const sp = Math.hypot(p.ps.velocity[0], p.ps.velocity[1]);
    if (game.time - p.ps.jumpPadTime > 1500) maxRunSpeed = Math.max(maxRunSpeed, sp); // exclude pad launches
    if (sp > 50) movingTicks++;
    if (sp > 330 && game.time - p.ps.jumpPadTime > 1500) fastTicks++;
    const lp = lastPos.get(p.id);
    if (lp && Math.hypot(p.ps.origin[0] - lp[0], p.ps.origin[1] - lp[1], p.ps.origin[2] - lp[2]) < 1) { still.set(p.id, (still.get(p.id) || 0) + 1); if (still.get(p.id) > 120) stuckTicks++; } else still.set(p.id, 0);
    lastPos.set(p.id, [...p.ps.origin]);
  }
}
const wall = (performance.now() - t0) / 1000;
const names = Object.fromEntries(Object.entries(EV).map(([k, v]) => [v, k]));
const accBy = (p) => Object.fromEntries(Object.keys(p.shotsBy).map((w) => [WEAPON_NAMES[w], { shots: p.shotsBy[w], hits: p.hitsBy[w] || 0, acc: +((p.hitsBy[w] || 0) / p.shotsBy[w]).toFixed(2) }]));
const report = {
  map: mapName, mode, skill, seed, simSeconds: seconds, wallSeconds: +wall.toFixed(2), simSpeedX: +(seconds / wall).toFixed(1), match: game.match.state,
  players: [...game.players.values()].map((p, i) => ({ name: p.name, frags: p.frags, deaths: p.deaths, dmg: p.damageDealt, acc: p.shots ? +(p.hits / p.shots).toFixed(2) : 0, health: p.health, armor: p.armor, byWeapon: accBy(p), ai: bots[i].stats })),
  events: Object.fromEntries(Object.entries(counts).map(([k, v]) => [names[k] || k, v])),
  killsByWeapon: Object.fromEntries(Object.entries(byWeapon).map(([k, v]) => [WEAPON_NAMES[k] || k, v])),
  pickups, pickupsByType, jumppads, maxRunSpeed: +maxRunSpeed.toFixed(0),
  movingPct: +(100 * movingTicks / Math.max(1, totalTicks)).toFixed(1), above320Pct: +(100 * fastTicks / Math.max(1, totalTicks)).toFixed(1), stuckSeconds: +(stuckTicks / TICK_RATE).toFixed(1),
  navNodes: nav.nodes.length, navEdges: nav.nodes.reduce((s, n) => s + n.edges.length, 0),
};
// combined rail accuracy across both bots (the benchmark target is 30-60%)
const rail = report.players.reduce((s, p) => { const r = p.byWeapon.rail; if (r) { s.shots += r.shots; s.hits += r.hits; } return s; }, { shots: 0, hits: 0 });
report.railAccuracy = rail.shots ? +(rail.hits / rail.shots).toFixed(2) : null;
report.totalFrags = report.players.reduce((s, p) => s + Math.max(0, p.frags), 0);
report.weaponsWithKills = Object.keys(report.killsByWeapon).length;
if (args.json) fs.writeFileSync(String(args.json), JSON.stringify(report, null, 2));
if (!args.quiet) console.log(JSON.stringify(report, null, 2));
else console.log(JSON.stringify({ map: mapName, frags: report.totalFrags, kills: report.killsByWeapon, rail: report.railAccuracy, maxRunSpeed: report.maxRunSpeed, above320Pct: report.above320Pct, stuckSeconds: report.stuckSeconds, simSpeedX: report.simSpeedX }));
if (report.totalFrags === 0 && seconds >= 60) { console.error('FAIL: no frags in a ' + seconds + 's bot duel'); process.exit(1); }
