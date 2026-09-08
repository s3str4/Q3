// Scripted "competent player" for the survival slice. Produces one command per tick from public sim state only
// (sim.player, sim.zombies, sim.world, sim.hour, metrics) so it can drive both the headless tests and the browser
// evidence runs (survival/main.js: ?autopilot=win|reckless). Deterministic: no Math.random, no wall clock.
//
// mode 'win'      loot the start house (fridge, closet -> bat, shelf), go to the gas station for the pistol, loot its
//                 shelves, chop a tree until 6 planks, walk home before 21:00, close + barricade the door and both
//                 side windows, then hold at bat range from the last open window until 06:00. Sneaks near idle
//                 zombies, fights chasers with the bat (backing off between swings), shoots only with 2+ chasers,
//                 bandages when bleeding, eats/drinks under 45 (regen needs 40).
// mode 'reckless' walks the road, sprints when it can, never fights or fortifies: a control run that must die.
//
// Navigation: Dijkstra over walkable tiles (closed doors count as walkable and are opened with `interact` when the
// next waypoint is a door; windows never), tiles near zombies cost extra, string-pulled so open ground is crossed
// diagonally. Every button the sim edge-triggers (interact, build, reload, pistol attack, use) is pulsed: true for one
// tick, then false for at least one tick.
import { emptyCmd } from './sim.js';
import { TILE, PLAYER, WEAPONS, ZOMBIE, ZSTATE, DAY, BARRICADE_COST } from './constants.js';

const len = (x, y) => Math.hypot(x, y);
const key = (x, y) => x + ',' + y;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BAT_REACH = WEAPONS.bat.range + ZOMBIE.radius - 0.05;     // swing when a zombie centre is inside this
const HOME_HOUR = 18.5;                                           // abandon errands and walk home after this hour
const HOLD_PLANKS = 6;                                            // door + 2 windows

export class Autopilot {
  constructor(sim, opts = {}) {
    this.sim = sim; this.mode = opts.mode || 'win'; this.seed = opts.seed ?? 7;
    this.last = emptyCmd();                 // previous command (for edge pulses)
    this.path = null; this.pathTick = -99; this.pathGoal = null;
    this.stage = null; this.stages = [];    // stage log: { stage, tick, hour } (evidence)
    this.holdSpot = null; this.treeGoal = null; this.stuckT = 0; this.lastPos = null;
    this.decisions = 0;
    this.setStage(this.mode === 'reckless' ? 'road' : 'loot_home');
  }
  setStage(s) { if (s === this.stage) return; this.stage = s; this.stages.push({ stage: s, tick: this.sim.tick, hour: +this.sim.hour.toFixed(2) }); }
  // ---------------- world queries ----------------
  home() { return this.sim.world.structures[0]; }                  // 'Start house'
  container(kind, x, y) { return this.sim.world.containers.find((c) => c.x === x && c.y === y && (!kind || c.kind === kind)) || null; }
  homeDoor() { const h = this.home(); for (const o of this.sim.world.openings.values()) if (o.kind === 'door' && o.structure === h.name) return o; return null; }
  homeOpenings() { const h = this.home(); return [...this.sim.world.openings.values()].filter((o) => o.structure === h.name); }
  insideHome(x, y) { const h = this.home(); return x > h.x0 && x < h.x1 && y > h.y0 && y < h.y1; }
  live() { return this.sim.zombies.filter((z) => z.state !== ZSTATE.DEAD); }
  chasers() { const p = this.sim.player; return this.live().filter((z) => z.state === ZSTATE.CHASE || z.state === ZSTATE.ATTACK || z.state === ZSTATE.STAGGER && z.lastSeen).map((z) => ({ z, d: len(z.x - p.x, z.y - p.y) })).sort((a, b) => a.d - b.d); }
  nearestLive() { const p = this.sim.player; let best = null, bd = 1e9; for (const z of this.live()) { const d = len(z.x - p.x, z.y - p.y); if (d < bd) { bd = d; best = z; } } return best ? { z: best, d: bd } : null; }
  // player passability for planning: closed (non-barricaded) doors are walkable, we open them on arrival
  walkable(x, y) {
    const w = this.sim.world; if (!w.inBounds(x, y)) return false; const t = w.get(x, y);
    if (t === TILE.DOOR) { const o = w.opening(x, y); return !!o && o.barricade <= 0; }
    return !w.blocksPlayer(x, y);
  }
  // circle of radius r at (x, y) does not overlap a blocking tile (doors that are still closed count as blocking)
  clear(x, y, r = PLAYER.radius + 0.04) {
    const w = this.sim.world;
    for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++) for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
      if (!w.blocksPlayer(tx, ty)) continue;
      const cx = Math.max(tx, Math.min(x, tx + 1)), cy = Math.max(ty, Math.min(y, ty + 1)); if (len(x - cx, y - cy) < r) return false;
    }
    return true;
  }
  // Dijkstra from the player's tile; returns { dist: Int32Array, prev: Int32Array }. Tiles near live zombies cost more.
  field(avoidZombies = true) {
    const w = this.sim.world, W = w.w, H = w.h, N = W * H; const p = this.sim.player;
    const dist = new Int32Array(N).fill(1e9), prev = new Int32Array(N).fill(-1);
    const danger = new Uint8Array(N);
    if (avoidZombies) for (const z of this.live()) { const zx = Math.floor(z.x), zy = Math.floor(z.y); for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = zx + dx, y = zy + dy; if (!w.inBounds(x, y)) continue; const d = len(dx, dy); const c = d <= 2.2 ? 12 : d <= 4 ? 3 : 0; const i = y * W + x; if (c > danger[i]) danger[i] = c; } }
    const sx = Math.floor(p.x), sy = Math.floor(p.y); const start = sy * W + sx; dist[start] = 0;
    const buckets = [[start]];
    for (let d = 0; d < buckets.length; d++) {
      const b = buckets[d]; if (!b) continue;
      for (let k = 0; k < b.length; k++) {
        const i = b[k]; if (dist[i] !== d) continue; const x = i % W, y = (i / W) | 0;
        for (const [dx, dy] of N4) { const nx = x + dx, ny = y + dy; if (!this.walkable(nx, ny)) continue; const ni = ny * W + nx; const nd = d + 1 + danger[ni] + (w.get(nx, ny) === TILE.DOOR ? 2 : 0); if (nd < dist[ni]) { dist[ni] = nd; prev[ni] = i; (buckets[nd] || (buckets[nd] = [])).push(ni); } }
      }
    }
    return { dist, prev };
  }
  // path of tile centres from the player to the best of `goals` ([x,y] tiles); null when unreachable
  plan(goals, avoidZombies = true) {
    const w = this.sim.world, W = w.w; const f = this.field(avoidZombies);
    let best = -1, bd = 1e9;
    for (const [x, y] of goals) { if (!w.inBounds(x, y)) continue; const i = y * W + x; if (f.dist[i] < bd) { bd = f.dist[i]; best = i; } }
    if (best < 0) return null;
    const out = []; for (let i = best; i >= 0; i = f.prev[i]) out.push([(i % W) + 0.5, ((i / W) | 0) + 0.5]);
    out.reverse(); return out;
  }
  // walkable 4-neighbours of a tile (for "stand next to" goals)
  around(x, y) { const out = []; for (const [dx, dy] of N4) if (this.walkable(x + dx, y + dy) && this.sim.world.get(x + dx, y + dy) !== TILE.DOOR) out.push([x + dx, y + dy]); return out; }
  // ---------------- movement ----------------
  // Steer along a (re)planned path to `goals`; returns 'arrived' | 'moving' | 'door' | 'lost'. Fills cmd.move/aim/interact.
  goto(cmd, goals, opts = {}) {
    const sim = this.sim, p = sim.player; const goalKey = goals.map((g) => g.join(',')).join('|');
    const inGoal = goals.some(([x, y]) => Math.floor(p.x) === x && Math.floor(p.y) === y);
    if (inGoal && (!opts.centre || len(Math.floor(p.x) + 0.5 - p.x, Math.floor(p.y) + 0.5 - p.y) < 0.12)) { this.path = null; return 'arrived'; }
    if (inGoal && opts.centre) { const cx = Math.floor(p.x) + 0.5, cy = Math.floor(p.y) + 0.5; cmd.move = [cx - p.x, cy - p.y]; cmd.aim = [cx, cy]; return 'moving'; }
    if (!this.path || this.pathGoal !== goalKey || sim.tick - this.pathTick > 12 || this.stuckT > 0.6) {
      this.path = this.plan(goals, opts.avoid !== false); this.pathGoal = goalKey; this.pathTick = sim.tick; this.stuckT = 0;
      if (!this.path) return 'lost';
    }
    // drop waypoints we have reached; string-pull up to 5 ahead when the straight segment is clear
    while (this.path.length > 1 && len(this.path[0][0] - p.x, this.path[0][1] - p.y) < 0.3) this.path.shift();
    let target = this.path[0];
    for (let k = Math.min(5, this.path.length - 1); k >= 1; k--) { const t = this.path[k]; if (this.segmentClear(p.x, p.y, t[0], t[1])) { target = t; break; } }
    const tx = Math.floor(target[0]), ty = Math.floor(target[1]);
    if (sim.world.get(tx, ty) === TILE.DOOR && sim.world.blocksPlayer(tx, ty)) {
      // a closed door on the way: stop next to it, face it, pulse E
      const d = len(target[0] - p.x, target[1] - p.y);
      if (d < 1.25) { cmd.move = [0, 0]; cmd.aim = [target[0], target[1]]; this.pulse(cmd, 'interact'); return 'door'; }
    }
    const dx = target[0] - p.x, dy = target[1] - p.y; const d = len(dx, dy) || 1;
    cmd.move = [dx / d, dy / d]; cmd.aim = [target[0], target[1]];
    return 'moving';
  }
  segmentClear(x0, y0, x1, y1) { const d = len(x1 - x0, y1 - y0); const n = Math.max(1, Math.ceil(d / 0.2)); for (let i = 1; i <= n; i++) { const t = i / n; if (!this.clear(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false; } return true; }
  // edge-triggered buttons: high for one tick, then forced low for one tick
  pulse(cmd, name) { if (!this.last[name]) cmd[name] = true; }
  faceAndUse(cmd, x, y, name) { cmd.move = [0, 0]; cmd.aim = [x, y]; this.pulse(cmd, name); }
  // ---------------- per-tick ----------------
  command(sim) {
    this.sim = sim; const cmd = emptyCmd(); const p = sim.player;
    if (!p.alive || sim.result) { this.last = cmd; return cmd; }
    if (this.mode === 'reckless') this.reckless(cmd); else this.win(cmd);
    // stuck detection (for replans)
    if (this.lastPos && (cmd.move[0] || cmd.move[1]) && len(p.x - this.lastPos[0], p.y - this.lastPos[1]) < 0.01) this.stuckT += 1 / 30; else this.stuckT = 0;
    this.lastPos = [p.x, p.y];
    this.last = cmd; return cmd;
  }
  reckless(cmd) {
    const sim = this.sim, p = sim.player;
    // patrol the east-west road; sprint whenever there is stamina; never fight, never build
    if (!this.patrolDir) this.patrolDir = 1;
    if (Math.floor(p.y) < 22 || Math.floor(p.y) > 25) { const r = this.goto(cmd, [[Math.max(2, Math.min(45, Math.floor(p.x))), 23]], { avoid: false }); if (r !== 'lost') { cmd.sprint = p.stamina > 30; return; } }
    if (p.x > 44) this.patrolDir = -1; else if (p.x < 3) this.patrolDir = 1;
    cmd.move = [this.patrolDir, (23.5 - p.y) * 0.5]; cmd.aim = [p.x + this.patrolDir * 3, 23.5]; cmd.sprint = p.stamina > 30 && !p.tired;
    this.setStage(sim.phase === 'night' ? 'road_night' : 'road');
  }
  win(cmd) {
    const sim = this.sim, p = sim.player;
    this.vitals(cmd);
    const chasers = this.chasers();
    // hold phase: stand at bat reach from the last open opening and kill what comes through
    if (this.stage === 'hold') { this.hold(cmd, chasers); return; }
    // combat interrupts navigation while a chaser is close (or several are coming)
    if (chasers.length && this.combat(cmd, chasers)) return;
    // errands, in order; each returns true while it still wants the tick
    if (!this.mustGoHome()) {
      if (this.stage === 'loot_home' && this.lootAll(cmd, [['fridge', 9, 9], ['closet', 14, 9], ['shelf', 14, 13]])) return this.arm(cmd);
      if (this.stage === 'loot_home') this.setStage('planks');
      // one tree from the cluster next to the house: 2 shelf planks + 2 = the objective's 4 (the gas station shelf adds 3)
      if (this.stage === 'planks' && (p.inventory.plank || 0) < 4 && this.chop(cmd)) return this.arm(cmd);
      if (this.stage === 'planks') this.setStage('gas_station');
      if (this.stage === 'gas_station' && this.lootAll(cmd, [['locker', 7, 35], ['cabinet', 7, 31], ['shelf', 15, 35]])) return this.arm(cmd);
      if (this.stage === 'gas_station') this.setStage('ammo_run');
      // every round on the map: the wreck on the road and the red house cabinet (24 rounds = 8 kills for no stamina)
      if (this.stage === 'ammo_run' && this.lootAll(cmd, [['wreck', 29, 24], ['cabinet', 31, 31]])) return this.arm(cmd);
      if (this.stage === 'ammo_run') this.setStage('go_home');
    } else if (this.stage !== 'go_home' && this.stage !== 'fortify') this.setStage('go_home');
    if (this.stage === 'go_home') { if (this.goHome(cmd)) return this.arm(cmd); this.setStage('fortify'); }
    if (this.stage === 'fortify') { if (this.fortify(cmd)) return this.arm(cmd); this.setStage('hold'); }
    this.hold(cmd, chasers);
  }
  // deadline: walk home when the path home (at a cautious 2 tiles/s) plus a 1.5 h margin would pass 21:00
  mustGoHome() {
    const sim = this.sim; if (sim.day !== 1 || sim.hour < 12) return false;
    if (sim.tick - (this.homeCheckTick ?? -99) >= 30) {
      const door = this.homeDoor(); const f = this.field(false); const d = f.dist[(door.y - 1) * sim.world.w + door.x];
      const hours = (d >= 1e9 ? 40 : d) / 2.0 * DAY.hoursPerSecond * sim.opts.timeScale;
      this.homeCheckTick = sim.tick; this.homeLate = sim.hour + hours + 1.5 >= DAY.nightHour || sim.hour >= HOME_HOUR;
    }
    return this.homeLate;
  }
  // keep the bat in hand outside combat; sneak near idle zombies; sprint when the coast is clear
  arm(cmd) {
    const p = this.sim.player;
    if (p.inventory.bat && p.weapon !== 'bat' && p.weapon !== 'pistol') cmd.slot = 2;
    else if (p.weapon === 'pistol' && p.mag === 0 && !p.inventory.ammo && p.inventory.bat) cmd.slot = 2;
    // top up the pistol once so it is ready for the night (RELOAD / RELOAD_DONE)
    if (p.inventory.pistol && p.mag === 0 && p.inventory.ammo && p.reloadT <= 0) { cmd.slot = 3; if (p.weapon === 'pistol') this.pulse(cmd, 'reload'); }
    else if (p.weapon === 'pistol' && p.reloadT <= 0 && p.inventory.bat) cmd.slot = 2;
    const near = this.nearestLive(); const moving = cmd.move[0] || cmd.move[1];
    if (moving && near && near.d < 6) cmd.sneak = true;
    else if (moving && (!near || near.d > 10) && p.stamina > 40 && !p.tired) cmd.sprint = true;
  }
  vitals(cmd) {
    const p = this.sim.player;
    if (p.bleeding && p.inventory.bandage) cmd.use = 'bandage';
    else if (p.hunger < 45 && p.inventory.food) cmd.use = 'food';          // keep both above regenMinFood (40)
    else if (p.thirst < 45 && p.inventory.water) cmd.use = 'water';
    else if (p.health < 50 && p.inventory.bandage && p.bandageHeal <= 0 && !this.chasers().length) cmd.use = 'bandage';
  }
  // returns true when it handled the tick
  combat(cmd, chasers) {
    const sim = this.sim, p = sim.player; const near = chasers[0];
    const inHouse = this.insideHome(p.x, p.y); const holding = this.stage === 'hold';
    const engageRange = inHouse ? 3.0 : 2.6;
    const visible = chasers.filter((c) => c.d < 8 && sim.hasLOS(p.x, p.y, c.z.x, c.z.y));
    // pistol: two or more chasers and rounds to spare -> shoot the nearest one in sight (through the open window while
    // they bash it: windows are see-through until barricaded). An empty mag with a zombie on us falls through to the
    // bat while the reload runs in the background.
    const pistolReady = p.inventory.pistol && (p.mag > 0 || (p.inventory.ammo && (near.d > 1.7 || !p.inventory.bat)));
    // by day the bat does the work (rounds are for the horde): the pistol needs 3 chasers, or 2 once we hold the house
    const minChasers = this.stage === 'hold' || p.health < 50 ? 2 : 3;
    if (chasers.length >= minChasers && visible.length >= 1 && pistolReady) {
      const t = visible[0].z; cmd.move = [0, 0]; cmd.aim = [t.x, t.y]; cmd.slot = 3;
      if (p.weapon === 'pistol') { if (p.mag === 0 && p.reloadT <= 0) this.pulse(cmd, 'reload'); else if (p.mag > 0 && p.cooldown <= 0 && p.reloadT <= 0) this.pulse(cmd, 'attack'); }
      if (near.d < 1.3 && p.cooldown > 0 && !holding) this.backAway(cmd, near.z);
      return true;
    }
    if (p.weapon === 'pistol' && p.mag === 0 && p.inventory.ammo && p.reloadT <= 0 && near.d > 2.5) { cmd.move = [0, 0]; cmd.aim = [near.z.x, near.z.y]; this.pulse(cmd, 'reload'); return true; }
    if (near.d > engageRange) return false;
    if (!p.inventory.bat) { this.flee(cmd, near.z); return true; }
    // reload in a gap (the pistol must be in hand to start it; it then completes whatever we hold, but no swing lands
    // while it runs, so never start one with a zombie in reach)
    if (p.mag === 0 && p.inventory.ammo && p.reloadT <= 0 && near.d > 2.0 && chasers.length >= 2) { cmd.slot = 3; cmd.aim = [near.z.x, near.z.y]; cmd.move = [0, 0]; if (p.weapon === 'pistol') this.pulse(cmd, 'reload'); return true; }
    if (p.weapon !== 'bat') { cmd.slot = 2; cmd.aim = [near.z.x, near.z.y]; cmd.move = [0, 0]; return true; }
    if (p.stamina < WEAPONS.bat.stamina && near.d > 1.2 && !holding) { this.flee(cmd, near.z); return true; }
    // the zombie already winding up an attack is the one to stagger; otherwise the nearest
    const inReach = chasers.filter((c) => c.d <= BAT_REACH); const target = inReach.find((c) => c.z.state === ZSTATE.ATTACK) || inReach[0] || near;
    cmd.aim = [target.z.x, target.z.y]; cmd.move = [0, 0];
    if (target.d <= BAT_REACH && p.cooldown <= 0 && p.stamina >= WEAPONS.bat.stamina && p.reloadT <= 0) cmd.attack = true;
    else if (holding) { /* stand our ground at the chokepoint: stepping back lets the next one in */ }
    else if (p.cooldown > 0 && near.d < 1.45) this.backAway(cmd, near.z);          // let the stagger play out at arm's length
    else if (near.d > BAT_REACH + 0.4 && chasers.length === 1 && !inHouse) { cmd.move = [(near.z.x - p.x) / near.d, (near.z.y - p.y) / near.d]; cmd.sneak = false; }
    return true;
  }
  backAway(cmd, z) { const p = this.sim.player; const dx = p.x - z.x, dy = p.y - z.y; const d = len(dx, dy) || 1; const mx = dx / d, my = dy / d; if (this.clear(p.x + mx * 0.5, p.y + my * 0.5)) cmd.move = [mx, my]; else if (this.clear(p.x - my * 0.5, p.y + mx * 0.5)) cmd.move = [-my, mx]; else cmd.move = [0, 0]; }
  flee(cmd, z) { const p = this.sim.player; const dx = p.x - z.x, dy = p.y - z.y; const d = len(dx, dy) || 1; cmd.move = [dx / d, dy / d]; if (!this.clear(p.x + cmd.move[0] * 0.6, p.y + cmd.move[1] * 0.6)) cmd.move = [-dy / d, dx / d]; cmd.aim = [p.x + cmd.move[0], p.y + cmd.move[1]]; cmd.sprint = !p.tired; }
  // loot a list of containers in order; true while busy
  lootAll(cmd, list) {
    for (const [kind, x, y] of list) {
      const c = this.container(kind, x, y); if (!c || c.opened) continue;
      const p = this.sim.player; const d = len(x + 0.5 - p.x, y + 0.5 - p.y);
      if (d < 1.5) { this.faceAndUse(cmd, x + 0.5, y + 0.5, 'interact'); return true; }
      const r = this.goto(cmd, this.around(x, y)); if (r === 'lost') { c.opened = true; continue; }  // unreachable: skip
      return true;
    }
    return false;
  }
  // chop the nearest reachable tree; true while busy
  chop(cmd) {
    const sim = this.sim, w = sim.world, p = sim.player;
    if (!this.treeGoal || !w.trees.has(key(this.treeGoal[0], this.treeGoal[1]))) {
      const f = this.field(true); let best = null, bd = 1e9;
      for (const k of w.trees.keys()) { const [x, y] = k.split(',').map(Number); for (const [ax, ay] of this.around(x, y)) { const d = f.dist[ay * w.w + ax]; if (d < bd) { bd = d; best = [x, y]; } } }
      if (!best) return false; this.treeGoal = best;
    }
    const [tx, ty] = this.treeGoal; const d = len(tx + 0.5 - p.x, ty + 0.5 - p.y);
    if (d < 1.4) { this.faceAndUse(cmd, tx + 0.5, ty + 0.5, 'interact'); return true; }
    const r = this.goto(cmd, this.around(tx, ty)); if (r === 'lost') { this.treeGoal = null; }
    return true;
  }
  goHome(cmd) {
    const p = this.sim.player; const door = this.homeDoor();
    if (this.insideHome(p.x, p.y)) return false;
    const r = this.goto(cmd, [[door.x, door.y - 1]]);
    return r !== 'lost';
  }
  // close the door, barricade door then windows (nearest opening within reach is the one built): true while busy
  fortify(cmd) {
    const sim = this.sim, p = sim.player; const door = this.homeDoor();
    if (door.open && door.barricade <= 0) {
      const at = this.goto(cmd, [[door.x, door.y - 1]], { centre: true }); if (at !== 'arrived') return true;
      this.faceAndUse(cmd, door.x + 0.5, door.y + 0.5, 'interact'); return true;
    }
    if (p.inventory.plank >= BARRICADE_COST) {
      const order = [door, ...this.homeOpenings().filter((o) => o.kind === 'window').sort((a, b) => a.x - b.x)];   // door, west window (8,11), north (10,8), east (15,11)
      for (const o of order) {
        if (o.barricade > 0) continue;
        if (o === door) { if (this.inventoryPlanks() < BARRICADE_COST) break; const at = this.goto(cmd, [[door.x, door.y - 1]], { centre: true }); if (at !== 'arrived') return true; this.faceAndUse(cmd, door.x + 0.5, door.y + 0.5, 'build'); return true; }
        // stand on the interior tile next to the window, the nearest opening from there is that window
        const spot = this.interiorNeighbour(o); if (!spot) continue;
        const at = this.goto(cmd, [spot], { centre: true }); if (at !== 'arrived') return true;
        this.faceAndUse(cmd, o.x + 0.5, o.y + 0.5, 'build'); return true;
      }
    }
    return false;
  }
  inventoryPlanks() { return this.sim.player.inventory.plank || 0; }
  interiorNeighbour(o) { for (const [dx, dy] of N4) { const x = o.x + dx, y = o.y + dy; if (this.insideHome(x, y) && this.walkable(x, y)) return [x, y]; } return null; }
  // Night hold. The kill-window is the one opening left unbarricaded; the player stands on the floor tile directly
  // inside it. That tile plus the wall corners leave a 0.37-tile gap, less than a zombie's width, so nothing gets past
  // and only the zombie in the window tile can ever reach us: a one-at-a-time duel where every swing lands before its
  // wind-up ends. Bashers outside are shot through the (see-through) window while rounds last; reloads happen only
  // when nothing is within 2 tiles because a running reload blocks swings.
  hold(cmd, chasers) {
    const sim = this.sim, p = sim.player;
    this.setStage('hold');
    if (!this.holdSpot) {
      const open = this.homeOpenings().filter((o) => o.barricade <= 0).sort((a, b) => a.hp - b.hp);
      const o = open[0] || this.homeDoor(); const n = this.interiorNeighbour(o) || [Math.floor(p.x), Math.floor(p.y)];
      this.holdSpot = [n[0] + 0.5, n[1] + 0.5]; this.holdOpening = o;
    }
    const spot = this.holdSpot; const displaced = len(spot[0] - p.x, spot[1] - p.y);
    const threats = this.live().map((z) => ({ z, d: len(z.x - p.x, z.y - p.y) })).filter((c) => c.d < 8 && (this.insideHome(c.z.x, c.z.y) || c.d <= BAT_REACH || sim.hasLOS(p.x, p.y, c.z.x, c.z.y))).sort((a, b) => a.d - b.d);
    const inReach = threats.filter((c) => c.d <= BAT_REACH);
    const target = inReach.find((c) => c.z.state === ZSTATE.ATTACK) || inReach[0] || threats.find((c) => sim.hasLOS(p.x, p.y, c.z.x, c.z.y)) || null;
    const near = threats[0];
    cmd.move = [0, 0]; cmd.aim = target ? [target.z.x, target.z.y] : [this.holdOpening.x + 0.5, this.holdOpening.y + 0.5];
    const canShoot = chasers.length >= 2 && p.inventory.pistol && p.mag > 0 && target && p.reloadT <= 0;
    if (canShoot) { cmd.slot = 3; if (p.weapon === 'pistol' && p.cooldown <= 0) this.pulse(cmd, 'attack'); }
    else if (p.inventory.pistol && p.mag === 0 && p.inventory.ammo && p.reloadT <= 0 && (!near || near.d > 2.0) && chasers.length >= 2) { cmd.slot = 3; if (p.weapon === 'pistol') this.pulse(cmd, 'reload'); }
    else if (inReach.length && p.inventory.bat) { cmd.slot = 2; if (p.weapon === 'bat' && p.cooldown <= 0 && p.reloadT <= 0 && p.stamina >= WEAPONS.bat.stamina) cmd.attack = true; }
    else if (p.inventory.bat && p.weapon !== 'bat' && p.reloadT <= 0) cmd.slot = 2;
    // hold the funnel: walk back onto the spot whenever we are knocked off it and no swing is due this tick
    if (displaced > 0.15 && !cmd.attack) { cmd.move = [(spot[0] - p.x) / displaced, (spot[1] - p.y) / displaced]; if (displaced < 0.5) { cmd.move[0] *= 0.6; cmd.move[1] *= 0.6; } }
  }
}
