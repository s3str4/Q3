// Shared helpers for the survival test suites (not a test file itself).
import { SurvivalSim, emptyCmd } from '../shared/survival/sim.js';
import { ZSTATE, TICK_RATE } from '../shared/survival/constants.js';

export { emptyCmd };
export const ticks = (seconds) => Math.round(seconds * TICK_RATE);

// A sim with no zombies and no horde unless asked: rule tests place their own actors.
export function makeSim(opts = {}) { return new SurvivalSim({ seed: 7, zombies: 0, noHorde: true, ...opts }); }

// Step n ticks with a fixed command or a (tick, sim) -> cmd function; returns every event emitted.
export function run(sim, n, c = emptyCmd()) {
  const out = [];
  for (let i = 0; i < n; i++) { const cmd = typeof c === 'function' ? c(i, sim) : c; for (const e of sim.step(cmd)) out.push(e); }
  return out;
}
export const cmd = (o = {}) => ({ ...emptyCmd(), ...o });
export const byType = (events, type) => events.filter((e) => e.type === type);

// Put the player at (x, y) facing `facing`, at rest.
export function placePlayer(sim, x, y, facing = 0) { const p = sim.player; p.x = x; p.y = y; p.vx = 0; p.vy = 0; p.facing = facing; return p; }
// Spawn a zombie at (x, y) in `state`, facing the player unless told otherwise; wander/groan timers pushed out so
// it stays put until something happens.
export function spawnZombie(sim, x, y, state = ZSTATE.IDLE, opts = {}) {
  const z = sim.spawnZombie(x, y, state, !!opts.horde);
  z.facing = opts.facing ?? Math.atan2(sim.player.y - y, sim.player.x - x); z.wanderT = 1e6; z.groanT = 1e6; z.target = null;
  return z;
}
