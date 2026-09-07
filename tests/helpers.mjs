// Shared helpers for the node:test suites (not a test file itself).
import { boxBrush } from '../shared/brush.js';
import { MapBuilder } from '../shared/map.js';
import { Game } from '../shared/game.js';
import { pmove, newPlayerState } from '../shared/pmove.js';
import { BUTTONS, TICK_RATE } from '../shared/constants.js';

// A big flat floor at z=0 (top) with optional extra brushes.
export function flatWorld(extra = []) {
  return { brushes: [boxBrush([-4096, -4096, -64], [4096, 4096, 0], { mat: 'floor', flags: 0 }), ...extra] };
}

// A minimal playable map: one big room with 4 spawns and a few items, built with the real MapBuilder.
export function roomMap(opts = {}) {
  const m = new MapBuilder('testroom');
  const S = opts.size || 1024, H = 256;
  m.box([-S, -S, -64], [S, S, 0], 'floor');
  m.box([-S, -S, H], [S, S, H + 64], 'ceiling');
  m.box([-S - 64, -S, 0], [-S, S, H], 'wall'); m.box([S, -S, 0], [S + 64, S, H], 'wall');
  m.box([-S, -S - 64, 0], [S, -S, H], 'wall'); m.box([-S, S, 0], [S, S + 64, H], 'wall');
  m.spawn([-S + 128, 0, 24], 0); m.spawn([S - 128, 0, 24], 180); m.spawn([0, -S + 128, 24], 90); m.spawn([0, S - 128, 24], -90);
  for (const it of (opts.items || [])) m.item(it.type, it.origin);
  for (const n of (opts.nav || [])) m.nav(n);
  return m.finish();
}

export const cmd = (o = {}) => ({ seq: 0, forward: 0, right: 0, up: 0, buttons: 0, angles: [0, 0, 0], weapon: 0, vt: 0, ...o });

// Run pmove for n ticks with a fixed command (or a function tick -> cmd). Returns collected events.
export function runPm(ps, world, c, n) {
  const events = [];
  for (let i = 0; i < n; i++) {
    const cc = typeof c === 'function' ? c(i, ps) : c;
    pmove(ps, cc, { world, entities: [], events });
  }
  return events;
}

// A player state standing on the flat world at (x, y).
export function standing(world, x = 0, y = 0) {
  const ps = newPlayerState();
  ps.origin = [x, y, 24.5];
  runPm(ps, world, cmd(), 10);
  return ps;
}

// Step a Game n ticks, feeding each player a command from cmds[id] (object or function(tick, player)).
export function stepGame(game, n, cmds = {}) {
  const all = [];
  for (let i = 0; i < n; i++) {
    for (const p of game.players.values()) {
      const c = cmds[p.id];
      const cc = typeof c === 'function' ? c(i, p) : (c || cmd());
      p._seq = (p._seq || 0) + 1;
      game.queueCommand(p.id, { ...cmd(cc), seq: p._seq });
    }
    all.push(...game.step());
  }
  return all;
}

export const ticks = (ms) => Math.round(ms / 1000 * TICK_RATE);
export const speed2d = (ps) => Math.hypot(ps.velocity[0], ps.velocity[1]);
export { Game, BUTTONS };
