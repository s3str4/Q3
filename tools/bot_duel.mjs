#!/usr/bin/env node
// Headless scripted 1v1: two bots duel in-process for N simulated seconds. Reports frags, damage, accuracy, sim speed.
// usage: node tools/bot_duel.mjs [--map arena_duel] [--seconds 120] [--mode duel] [--seed 7] [--skill 0.8]
import { Game } from '../shared/game.js';
import { loadMap } from '../shared/map.js';
import { Bot } from '../shared/bot.js';
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
const bots = [new Bot(game, a, { skill, seed: seed + 1 }), new Bot(game, b, { skill, seed: seed + 2 })];
const counts = {}; const byWeapon = {}; let pickups = 0; let maxSpeed = 0; let jumppads = 0;
const t0 = performance.now();
const ticks = seconds * TICK_RATE;
for (let i = 0; i < ticks; i++) {
  for (const bt of bots) bt.think();
  const ev = game.step();
  for (const e of ev) {
    counts[e.type] = (counts[e.type] || 0) + 1;
    if (e.type === EV.DEATH) byWeapon[e.mod] = (byWeapon[e.mod] || 0) + 1;
    if (e.type === EV.PICKUP) pickups++;
    if (e.type === EV.JUMPPAD) jumppads++;
  }
  for (const p of game.players.values()) maxSpeed = Math.max(maxSpeed, Math.hypot(p.ps.velocity[0], p.ps.velocity[1]));
}
const wall = (performance.now() - t0) / 1000;
const names = Object.fromEntries(Object.entries(EV).map(([k, v]) => [v, k]));
const report = {
  map: mapName, mode, simSeconds: seconds, wallSeconds: +wall.toFixed(2), simSpeedX: +(seconds / wall).toFixed(1), match: game.match.state,
  players: [...game.players.values()].map((p) => ({ name: p.name, frags: p.frags, deaths: p.deaths, dmg: p.damageDealt, acc: p.shots ? +(p.hits / p.shots).toFixed(2) : 0, health: p.health, armor: p.armor })),
  events: Object.fromEntries(Object.entries(counts).map(([k, v]) => [names[k] || k, v])),
  killsByWeapon: Object.fromEntries(Object.entries(byWeapon).map(([k, v]) => [WEAPON_NAMES[k] || k, v])),
  pickups, jumppads, maxSpeed: +maxSpeed.toFixed(0),
};
console.log(JSON.stringify(report, null, 2));
const frags = report.players.reduce((s, p) => s + Math.max(0, p.frags), 0);
if (frags === 0 && seconds >= 60) { console.error('FAIL: no frags in a ' + seconds + 's bot duel'); process.exit(1); }
