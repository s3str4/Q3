// Deterministic survival simulation (fixed 30 Hz). Owns the player, vitals, zombies (senses + state machine),
// openings (doors/windows/barricades), loot, harvesting, the day/night clock, the horde waves and the objective chain.
// Everything observable happens through `events` (per tick) and `log` (state transitions, append-only), so a critic
// can verify behaviour without reading the renderer.
import { TILE, SOLID, SURFACE, ITEMS, WEAPONS, WEAPON_SLOTS, PLAYER, NOISE, FOOTSTEP_INTERVAL, ZOMBIE, ZSTATE, PSTATE, DAY, DT, TICK_RATE, BARRICADE_HP, BARRICADE_COST, TREE_HITS, TREE_PLANKS, HARVEST_COOLDOWN, OBJECTIVES, EV } from './constants.js';
import { World, mulberry32 } from './world.js';

const TAU = Math.PI * 2;
const wrap = (a) => { a %= TAU; if (a > Math.PI) a -= TAU; if (a < -Math.PI) a += TAU; return a; };
const len = (x, y) => Math.hypot(x, y);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

// Vitals balance: PLAYER.hungerPerMin / thirstPerMin are applied per game-HOUR (gameDt is scaled real seconds, so
// gameDt * DAY.hoursPerSecond is elapsed game hours). The literal per-game-minute rate would empty 75 hunger in 34
// game minutes (11 real seconds) and starve a full-health player before noon; the per-real-minute reading (what
// '/ 60' did) drains 16 hunger over the whole slice and vitals never matter. Per game-hour the slice costs ~48
// hunger / ~66 thirst: eat once and drink twice to keep regen, the 7DTD pace.
const VITALS_RATE = DAY.hoursPerSecond;
export const INTERACT_LOCK = 0.18;   // seconds the player is held after an interaction (was 0.25); a hit cancels it
export function emptyCmd() { return { move: [0, 0], aim: [0, 0], attack: false, interact: false, sprint: false, sneak: false, reload: false, build: false, slot: 0, use: null }; }

export class SurvivalSim {
  // opts: { seed, world, timeScale (game-time multiplier, 1 = 8 real minutes per day), startHour, zombies (initial count), noHorde }
  constructor(opts = {}) {
    this.opts = { seed: 7, timeScale: 1, ...opts };
    this.rand = mulberry32(this.opts.seed * 7919 + 13);
    this.world = this.opts.world || new World(this.opts.seed);
    this.tick = 0; this.t = 0;                                   // t: real seconds simulated
    this.hour = this.opts.startHour ?? DAY.startHour; this.day = 1;
    this.phase = this.phaseFor(this.hour);
    this.events = []; this.log = []; this.noises = [];
    this.metrics = { kills: 0, damageTaken: 0, damageDealt: 0, itemsLooted: 0, containersOpened: 0, planksHarvested: 0, barricadesBuilt: 0, shotsFired: 0, meleeSwings: 0, meleeHits: 0, distance: 0, detections: 0, maxChasers: 0, staminaOuts: 0, doorsBroken: 0, barricadesBroken: 0, hordeSpawned: 0, ate: 0, drank: 0, bandaged: 0 };
    this.player = this.makePlayer();
    this.zombies = []; this.nextZombieId = 1;
    const spawns = this.world.zombieSpawns.slice(0, this.opts.zombies ?? this.world.zombieSpawns.length);
    for (const [x, y] of spawns) this.spawnZombie(x, y, ZSTATE.WANDER, false);
    this.objective = { index: 0, steps: OBJECTIVES.map((o) => ({ ...o, done: false, doneAt: null })), state: 'active' };
    this.result = null;                                          // 'won' | 'lost'
    this.wavesDone = new Set(); this.field = null; this.fieldTick = -999; this.prevAttack = false; this.prevInteract = false; this.prevBuild = false; this.prevReload = false; this.prevSlot = 0;
    this.record('phase', { phase: this.phase, hour: this.hour });
    this.record('objective', { id: OBJECTIVES[0].id, index: 0 });
  }
  makePlayer() {
    const s = this.world.spawn;
    return { x: s.x, y: s.y, vx: 0, vy: 0, facing: s.facing, state: PSTATE.IDLE, health: PLAYER.maxHealth, stamina: PLAYER.maxStamina, hunger: 75, thirst: 65,
      bleeding: false, inventory: { fists: 1 }, weapon: 'fists', mag: 0, reloadT: 0, cooldown: 0, stateT: 0, stepT: 0, staminaDelay: 0, bandageHeal: 0, bandageT: 0,
      starveT: 0, bleedT: 0, harvestT: 0, lowHealth: false, tired: false, gait: 'walk', lastNoise: 0, alive: true, moving: false, kills: 0 };
  }
  // ---------------- helpers ----------------
  emit(type, data) { const e = { type, t: +this.t.toFixed(3), tick: this.tick, ...data }; this.events.push(e); return e; }
  record(kind, data) { this.log.push({ tick: this.tick, t: +this.t.toFixed(3), hour: +this.hour.toFixed(2), kind, ...data }); if (this.log.length > 20000) this.log.splice(0, 5000); }
  clock() { const h = Math.floor(this.hour), m = Math.floor((this.hour - h) * 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; }
  phaseFor(h) { if (h >= DAY.morningHour && h < DAY.duskHour) return 'day'; if (h >= DAY.duskHour && h < DAY.nightHour) return 'dusk'; if (h >= DAY.dawnHour && h < DAY.morningHour) return 'dawn'; return 'night'; }
  isNight() { return this.phase === 'night'; }
  count(item) { return this.player.inventory[item] || 0; }
  give(item, n, container) {
    const inv = this.player.inventory; inv[item] = (inv[item] || 0) + n; this.metrics.itemsLooted += n;
    this.emit(EV.PICKUP, { item, count: n, x: this.player.x, y: this.player.y, container: container ? container.id : null });
    if (item === 'pistol' && this.player.mag === 0 && this.count('ammo') > 0) { /* stays empty until reloaded: reload is a deliberate action */ }
  }
  take(item, n = 1) { const inv = this.player.inventory; if ((inv[item] || 0) < n) return false; inv[item] -= n; if (inv[item] <= 0) delete inv[item]; return true; }
  noise(x, y, radius, kind) { if (radius <= 0) return; this.noises.push({ x, y, r: radius, kind, t: this.t }); this.emit(EV.NOISE, { x, y, radius, kind }); }
  hasLOS(x0, y0, x1, y1) {
    // grid DDA between two points; opaque tiles block
    let dx = x1 - x0, dy = y1 - y0; const d = len(dx, dy); if (d < 1e-6) return true;
    const steps = Math.ceil(d * 4); dx /= steps; dy /= steps;
    let lx = Math.floor(x0), ly = Math.floor(y0);
    for (let i = 1; i <= steps; i++) { const tx = Math.floor(x0 + dx * i), ty = Math.floor(y0 + dy * i); if ((tx !== lx || ty !== ly) && this.world.blocksSight(tx, ty)) return false; lx = tx; ly = ty; }
    return true;
  }
  // circle vs tile grid movement with wall sliding; blockFn(x,y) -> bool
  // circles: optional hard obstacles [{ x, y, r }] (zombies block on the player and on each other, so a doorway holds
  // a queue instead of a stack and a body in the way is a body in the way)
  moveCircle(e, dx, dy, radius, blockFn, circles = null) {
    // deepest overlap of the circle at (nx, ny) with any blocking tile or circle (0 = free)
    const penetration = (nx, ny) => {
      const x0 = Math.floor(nx - radius), x1 = Math.floor(nx + radius), y0 = Math.floor(ny - radius), y1 = Math.floor(ny + radius); let pen = 0;
      for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) if (blockFn(tx, ty)) {
        // closest point on tile to circle centre
        const cx = clamp(nx, tx, tx + 1), cy = clamp(ny, ty, ty + 1); const p = radius - len(nx - cx, ny - cy); if (p > pen) pen = p;
      }
      if (circles) for (const c of circles) { if (c.e === e) continue; const ox = c.e ? c.e.x : c.x, oy = c.e ? c.e.y : c.y; const p = radius + c.r - len(nx - ox, ny - oy); if (p > pen) pen = p; }
      return pen;
    };
    // a step is accepted when it ends free, or when it reduces an existing overlap (a body spawned or pushed a few
    // centimetres into a tile must be able to walk out instead of being wedged for good)
    const tryAxis = (nx, ny) => { const after = penetration(nx, ny); return after <= 1e-9 || after < penetration(e.x, e.y) - 1e-9; };
    let moved = false, blockedX = false, blockedY = false;
    if (dx) { if (tryAxis(e.x + dx, e.y)) { e.x += dx; moved = true; } else blockedX = true; }
    if (dy) { if (tryAxis(e.x, e.y + dy)) { e.y += dy; moved = true; } else blockedY = true; }
    // wall slide: the dominant axis is blocked by a jamb or a corner while the row/column ahead has a passable tile
    // within reach. Nudge perpendicular (<= SLIDE per tick, deterministic) toward that tile's centre and retry the
    // step, so a body walking at a 1-tile doorway up to ~0.45 off-centre funnels through instead of stopping dead
    // on the jamb (radius 0.34 leaves only 0.32 of a door tile for the centre; nobody hits that by hand).
    const ady = Math.abs(dy), adx = Math.abs(dx);
    if (blockedY && ady >= adx) { if (this.slideToward(e, 'x', dy, radius, blockFn, tryAxis) && tryAxis(e.x, e.y + dy)) { e.y += dy; moved = true; } }
    else if (blockedX && adx >= ady) { if (this.slideToward(e, 'y', dx, radius, blockFn, tryAxis) && tryAxis(e.x + dx, e.y)) { e.x += dx; moved = true; } }
    e.x = clamp(e.x, radius, this.world.w - radius); e.y = clamp(e.y, radius, this.world.h - radius);
    return moved;
  }
  // Lateral correction for moveCircle: `axis` is the perpendicular axis to nudge along, `step` the blocked step on
  // the other axis. Looks at the three tiles in the row/column the body is about to enter, picks the nearest
  // passable one (by centre distance along `axis`, at most 1 tile away) and nudges up to SLIDE toward its centre.
  // Returns true when the body moved. Pure function of the grid + position: deterministic, shared by zombies.
  slideToward(e, axis, step, radius, blockFn, tryAxis) {
    const SLIDE = 0.08; const w = this.world;
    const along = axis === 'x' ? e.x : e.y, across = axis === 'x' ? e.y : e.x;
    const aheadLine = Math.floor(across + Math.sign(step) * (radius + Math.abs(step)));
    const base = Math.floor(along); let best = null, bd = 1.0 + 1e-9;
    for (const t of [base - 1, base, base + 1]) {
      const tx = axis === 'x' ? t : aheadLine, ty = axis === 'x' ? aheadLine : t;
      if (!w.inBounds(tx, ty) || blockFn(tx, ty)) continue;
      const d = Math.abs(t + 0.5 - along); if (d < bd) { bd = d; best = t + 0.5; }
    }
    if (best == null || bd < 1e-6) return false;
    const n = clamp(best - along, -SLIDE, SLIDE);
    if (axis === 'x') { if (!tryAxis(e.x + n, e.y)) return false; e.x += n; } else { if (!tryAxis(e.x, e.y + n)) return false; e.y += n; }
    return true;
  }
  // displace e by (dx, dy) only if the destination circle is free of blocking tiles (per axis, like moveCircle)
  nudge(e, dx, dy, radius, blockFn) {
    const free = (nx, ny) => { for (let ty = Math.floor(ny - radius); ty <= Math.floor(ny + radius); ty++) for (let tx = Math.floor(nx - radius); tx <= Math.floor(nx + radius); tx++) if (blockFn(tx, ty)) { const cx = clamp(nx, tx, tx + 1), cy = clamp(ny, ty, ty + 1); if (len(nx - cx, ny - cy) < radius) return false; } return true; };
    if (dx && free(e.x + dx, e.y)) e.x += dx;
    if (dy && free(e.x, e.y + dy)) e.y += dy;
  }
  // ---------------- main step ----------------
  step(cmd = emptyCmd()) {
    this.events = []; this.tick++; this.t += DT;
    const gameDt = DT * this.opts.timeScale;
    this.advanceClock(gameDt);
    this.noises = this.noises.filter((n) => this.t - n.t < 0.5);
    if (this.player.alive && this.result !== 'won') this.stepPlayer(cmd, gameDt);
    this.stepZombies();
    this.stepObjective();
    this.metrics.maxChasers = Math.max(this.metrics.maxChasers, this.zombies.filter((z) => z.state === ZSTATE.CHASE || z.state === ZSTATE.ATTACK).length);
    return this.events;
  }
  advanceClock(gameDt) {
    const prevHour = this.hour;
    this.hour += gameDt * DAY.hoursPerSecond;
    if (this.hour >= 24) { this.hour -= 24; this.day++; }
    const ph = this.phaseFor(this.hour);
    if (ph !== this.phase) { this.phase = ph; this.emit(EV.PHASE, { phase: ph, hour: +this.hour.toFixed(2), x: this.player.x, y: this.player.y }); this.record('phase', { phase: ph, hour: this.hour }); }
    // horde waves (7DTD blood-moon style: they know where you are)
    if (!this.opts.noHorde) for (let i = 0; i < DAY.waves.length; i++) {
      const w = DAY.waves[i]; if (this.wavesDone.has(i)) continue;
      const crossed = w.hour >= DAY.hordeHour ? (this.day === 1 && this.hour >= w.hour) : (this.day === 2 && this.hour >= w.hour);
      if (crossed) { this.wavesDone.add(i); this.spawnHorde(w.count, i); }
    }
    if (this.result === null && this.day === 2 && this.hour >= DAY.winHour && this.player.alive) this.win();
    void prevHour;
  }
  spawnHorde(count, wave) {
    // only border tiles the flow field can reach: the forest belt leaves pockets that are not 4-connected to the town,
    // and a zombie born there has no field step and would jam into the trees for the whole night
    const field = this.flowField(); const w = this.world;
    let edges = w.edgeSpawns().filter(([x, y]) => field[w.idx(Math.floor(x), Math.floor(y))] < 1e9); if (!edges.length) edges = w.edgeSpawns(); if (!edges.length) return;
    const p = this.player; const picked = [];
    // spawn from spots spread around the border, biased to be at least 14 tiles away
    for (let i = 0; i < count; i++) {
      let best = null, bd = -1;
      for (let k = 0; k < 6; k++) { const c = edges[Math.floor(this.rand() * edges.length)]; const d = len(c[0] - p.x, c[1] - p.y); if (d > bd) { bd = d; best = c; } }
      const z = this.spawnZombie(best[0] + (this.rand() - 0.5) * 0.4, best[1] + (this.rand() - 0.5) * 0.4, ZSTATE.CHASE, true); picked.push(z.id);
    }
    this.metrics.hordeSpawned += count;
    this.emit(EV.HORDE, { count, wave, x: p.x, y: p.y, hour: +this.hour.toFixed(2) });
    this.record('horde', { wave, count, ids: picked });
  }
  spawnZombie(x, y, state, horde) {
    const z = { id: this.nextZombieId++, x, y, vx: 0, vy: 0, facing: this.rand() * TAU, state, hp: ZOMBIE.hp, horde, target: null, wanderT: this.rand() * 3, lastSeenT: -99, lastSeen: null, seesPlayer: false,
      attackT: 0, attackWind: 0, bashT: 0, staggerT: 0, groanT: 2 + this.rand() * 6, stepT: this.rand() * 0.5, investigateT: 0, alertLevel: horde ? 1 : 0, stuckT: 0, prevX: x, prevY: y, deadT: 0 };
    this.zombies.push(z); this.record('zombie.state', { id: z.id, from: null, to: state });
    return z;
  }
  // extra: { cause: 'sight'|'sound'|'hit'|'horde'|'lost', by, kind } is merged into the log record next to from/to
  setZState(z, s, extra) {
    if (z.state === s) return; const from = z.state; z.state = s; z.stateT = 0;
    this.record('zombie.state', { id: z.id, from, to: s, ...(extra || {}) });
  }
  setPState(s) {
    const p = this.player; if (p.state === s) return; const from = p.state; p.state = s; p.stateT = 0;
    this.record('player.state', { from, to: s });
  }
  // ---------------- player ----------------
  stepPlayer(cmd, gameDt) {
    const p = this.player, w = this.world;
    p.cooldown = Math.max(0, p.cooldown - DT); p.harvestT = Math.max(0, p.harvestT - DT); p.stateT += DT;
    // vitals
    p.hunger = clamp(p.hunger - PLAYER.hungerPerMin * gameDt * VITALS_RATE, 0, 100); p.thirst = clamp(p.thirst - PLAYER.thirstPerMin * gameDt * VITALS_RATE, 0, 100);
    if (p.hunger <= 0 || p.thirst <= 0) { p.starveT += DT; if (p.starveT >= PLAYER.starveInterval) { p.starveT = 0; this.hurtPlayer(PLAYER.starveDamage, null, 'starvation'); } } else p.starveT = 0;
    if (p.bleeding) { p.bleedT += DT; if (p.bleedT >= PLAYER.bleedInterval) { p.bleedT = 0; this.hurtPlayer(PLAYER.bleedDamage, null, 'bleeding'); } }
    if (p.bandageHeal > 0) { const h = Math.min(p.bandageHeal, ITEMS.bandage.heal / PLAYER.bandageHealTime * DT); p.bandageHeal -= h; p.health = Math.min(PLAYER.maxHealth, p.health + h); }
    else if (p.hunger >= PLAYER.regenMinFood && p.thirst >= PLAYER.regenMinFood && !p.bleeding) p.health = Math.min(PLAYER.maxHealth, p.health + PLAYER.regenPerSec * DT);
    if (!p.alive) return;
    const low = p.health <= PLAYER.lowHealth;
    if (low !== p.lowHealth) { p.lowHealth = low; this.emit(EV.LOW_HEALTH, { on: low, health: p.health, x: p.x, y: p.y }); this.record('player.lowHealth', { on: low }); }
    // weapon slot + reload + consumables (edge-triggered where needed)
    if (cmd.slot && cmd.slot !== this.prevSlot) { const wpn = WEAPON_SLOTS[cmd.slot - 1]; if (wpn && p.inventory[wpn] && p.weapon !== wpn) { p.weapon = wpn; this.emit(EV.WEAPON_SWITCH, { weapon: wpn, x: p.x, y: p.y }); } else if (wpn && !p.inventory[wpn]) this.emit(EV.ACTION_DENIED, { reason: 'no_item', item: wpn }); }
    this.prevSlot = cmd.slot || 0;
    if (cmd.use) this.useItem(cmd.use);
    if (p.reloadT > 0) { p.reloadT -= DT; if (p.reloadT <= 0) { const need = WEAPONS.pistol.mag - p.mag; const n = Math.min(need, this.count('ammo')); this.take('ammo', n); p.mag += n; this.emit(EV.RELOAD_DONE, { mag: p.mag, x: p.x, y: p.y }); } }
    if (cmd.reload && !this.prevReload) this.reload();
    this.prevReload = !!cmd.reload;
    // stagger / attack / interact lock movement briefly (interact 0.18 s: long enough to read as an action, short
    // enough that a chop or a barricade never pins the player under a zombie; a hit also cancels it, see hurtPlayer)
    const busy = (p.state === PSTATE.STAGGER && p.stateT < PLAYER.hurtStagger) || (p.state === PSTATE.ATTACK && p.stateT < 0.18) || (p.state === PSTATE.INTERACT && p.stateT < INTERACT_LOCK);
    // movement
    let mx = cmd.move[0], my = cmd.move[1]; const ml = len(mx, my); if (ml > 1) { mx /= ml; my /= ml; }
    const wantSprint = cmd.sprint && ml > 0 && !cmd.sneak;
    if (p.stamina <= 0 && !p.tired) { p.tired = true; this.metrics.staminaOuts++; this.emit(EV.STAMINA_OUT, { x: p.x, y: p.y }); }
    if (p.tired && p.stamina >= PLAYER.staminaTired * 2) p.tired = false;
    const sprinting = wantSprint && !p.tired && !busy;
    const gait = busy ? 'walk' : sprinting ? 'run' : (cmd.sneak ? 'sneak' : 'walk');
    const speed = busy ? 0 : gait === 'run' ? PLAYER.run : gait === 'sneak' ? PLAYER.sneak : PLAYER.walk;
    const tvx = mx * speed, tvy = my * speed; const a = PLAYER.accel * DT;
    p.vx += clamp(tvx - p.vx, -a, a); p.vy += clamp(tvy - p.vy, -a, a);
    const ox = p.x, oy = p.y;
    this.moveCircle(p, p.vx * DT, p.vy * DT, PLAYER.radius, (x, y) => w.blocksPlayer(x, y));
    const moved = len(p.x - ox, p.y - oy); this.metrics.distance += moved; p.moving = moved > 0.001 && ml > 0;
    p.gait = gait;
    // facing: aim direction when attacking/aiming, else movement direction
    if (cmd.aim && (cmd.attack || p.weapon === 'pistol' || !p.moving)) { const ax = cmd.aim[0] - p.x, ay = cmd.aim[1] - p.y; if (len(ax, ay) > 0.15) p.facing = Math.atan2(ay, ax); }
    else if (p.moving) p.facing = Math.atan2(p.vy, p.vx);
    // stamina
    if (sprinting && p.moving) { p.stamina = Math.max(0, p.stamina - PLAYER.staminaDrain * DT); p.staminaDelay = PLAYER.staminaRegenDelay; }
    else { p.staminaDelay -= DT; if (p.staminaDelay <= 0) p.stamina = Math.min(PLAYER.maxStamina, p.stamina + PLAYER.staminaRegen * DT); }
    // footsteps + movement noise
    if (p.moving) { p.stepT += DT * (gait === 'run' ? 1 : 1); if (p.stepT >= FOOTSTEP_INTERVAL[gait]) { p.stepT = 0; const surf = SURFACE[w.get(Math.floor(p.x), Math.floor(p.y))] || 'grass'; this.emit(EV.FOOTSTEP, { who: 'player', surface: surf, gait, x: p.x, y: p.y }); this.noise(p.x, p.y, NOISE[gait], 'footstep'); } }
    else p.stepT = FOOTSTEP_INTERVAL.walk * 0.7;
    // state machine for locomotion (attack/interact/stagger states expire back to locomotion)
    if (!busy) this.setPState(!p.moving ? PSTATE.IDLE : gait === 'run' ? PSTATE.RUN : gait === 'sneak' ? PSTATE.SNEAK : PSTATE.WALK);
    // actions (edge-triggered)
    if (cmd.attack && !this.prevAttack) this.attack(cmd);
    else if (cmd.attack && p.weapon !== 'pistol' && p.cooldown <= 0) this.attack(cmd); // hold to keep swinging
    this.prevAttack = !!cmd.attack;
    if (cmd.interact && !this.prevInteract) this.interact();
    this.prevInteract = !!cmd.interact;
    if (cmd.build && !this.prevBuild) this.build();
    this.prevBuild = !!cmd.build;
  }
  useItem(item) {
    const p = this.player; const def = ITEMS[item]; if (!def) return;
    if (!this.count(item)) { this.emit(EV.ACTION_DENIED, { reason: 'no_item', item, x: p.x, y: p.y }); return; }
    if (def.kind === 'food') { if (p.hunger >= 98) { this.emit(EV.ACTION_DENIED, { reason: 'not_needed', item }); return; } this.take(item); p.hunger = Math.min(100, p.hunger + def.hunger); this.metrics.ate++; this.emit(EV.EAT, { item, hunger: p.hunger, x: p.x, y: p.y }); this.record('use', { item }); }
    else if (def.kind === 'drink') { if (p.thirst >= 98) { this.emit(EV.ACTION_DENIED, { reason: 'not_needed', item }); return; } this.take(item); p.thirst = Math.min(100, p.thirst + def.thirst); this.metrics.drank++; this.emit(EV.DRINK, { item, thirst: p.thirst, x: p.x, y: p.y }); this.record('use', { item }); }
    else if (def.kind === 'medical') { if (!p.bleeding && p.health >= PLAYER.maxHealth - 1) { this.emit(EV.ACTION_DENIED, { reason: 'not_needed', item }); return; } this.take(item); p.bleeding = false; p.bandageHeal += def.heal; this.metrics.bandaged++; this.emit(EV.BANDAGE, { item, health: p.health, x: p.x, y: p.y }); this.record('use', { item }); }
    else if (def.kind === 'weapon') { if (p.weapon !== item) { p.weapon = item; this.emit(EV.WEAPON_SWITCH, { weapon: item, x: p.x, y: p.y }); } }
  }
  reload() {
    const p = this.player; if (p.weapon !== 'pistol') return;
    if (p.reloadT > 0 || p.mag >= WEAPONS.pistol.mag) { this.emit(EV.ACTION_DENIED, { reason: 'not_needed', item: 'ammo' }); return; }
    if (!this.count('ammo')) { this.emit(EV.NO_AMMO, { x: p.x, y: p.y }); this.emit(EV.ACTION_DENIED, { reason: 'no_ammo' }); return; }
    p.reloadT = WEAPONS.pistol.reload; this.emit(EV.RELOAD, { x: p.x, y: p.y, duration: WEAPONS.pistol.reload });
  }
  attack(cmd) {
    const p = this.player, wdef = WEAPONS[p.weapon]; if (p.cooldown > 0 || p.reloadT > 0) return;
    if (p.state === PSTATE.STAGGER && p.stateT < PLAYER.hurtStagger) return;
    const ax = cmd.aim[0] - p.x, ay = cmd.aim[1] - p.y; if (len(ax, ay) > 0.05) p.facing = Math.atan2(ay, ax);
    if (p.weapon === 'pistol') {
      if (p.mag <= 0) { p.cooldown = 0.25; this.emit(EV.NO_AMMO, { x: p.x, y: p.y }); if (this.count('ammo')) this.reload(); return; }
      p.mag--; p.cooldown = wdef.cooldown; this.metrics.shotsFired++; this.setPState(PSTATE.ATTACK);
      this.emit(EV.GUNSHOT, { x: p.x, y: p.y, dir: p.facing, mag: p.mag }); this.noise(p.x, p.y, wdef.noise, 'gunshot');
      // ray vs zombies (closest along the ray within range, radius), blocked by opaque tiles
      const dx = Math.cos(p.facing), dy = Math.sin(p.facing); let best = null, bt = wdef.range;
      for (const z of this.zombies) { if (z.state === ZSTATE.DEAD) continue; const rx = z.x - p.x, ry = z.y - p.y; const tt = rx * dx + ry * dy; if (tt < 0 || tt > bt) continue; const perp = Math.abs(rx * dy - ry * dx); if (perp <= ZOMBIE.radius + 0.12 && this.hasLOS(p.x, p.y, z.x, z.y)) { best = z; bt = tt; } }
      if (best) { this.damageZombie(best, wdef.damage, 'pistol', wdef); this.emit(EV.BULLET_HIT, { target: best.id, damage: wdef.damage, killed: best.state === ZSTATE.DEAD, x: best.x, y: best.y }); }
      else { const hx = p.x + dx * bt, hy = p.y + dy * bt; this.emit(EV.BULLET_HIT, { target: null, damage: 0, killed: false, x: hx, y: hy }); }
      return;
    }
    // melee
    if (p.stamina < wdef.stamina) { p.cooldown = 0.3; this.emit(EV.ACTION_DENIED, { reason: 'tired', x: p.x, y: p.y }); return; }
    // a swing costs stamina but does not pause regen (only sprinting does): sustained melee nets -7.6/s with the bat,
    // so a fortified player can keep swinging at a chokepoint for ~13 s before tiring instead of 7 swings flat
    p.stamina -= wdef.stamina; p.cooldown = wdef.cooldown; this.metrics.meleeSwings++; this.setPState(PSTATE.ATTACK);
    let hit = false;
    for (const z of this.zombies) {
      if (z.state === ZSTATE.DEAD) continue; const rx = z.x - p.x, ry = z.y - p.y; const d = len(rx, ry);
      if (d > wdef.range + ZOMBIE.radius) continue; if (Math.abs(wrap(Math.atan2(ry, rx) - p.facing)) > wdef.arc / 2) continue;
      hit = true; this.metrics.meleeHits++; this.damageZombie(z, wdef.damage, p.weapon, wdef);
      this.emit(EV.MELEE_HIT, { target: z.id, damage: wdef.damage, killed: z.state === ZSTATE.DEAD, weapon: p.weapon, x: z.x, y: z.y });
    }
    // harvesting with a swing: trees in front
    if (!hit) hit = this.harvestInFront(true);
    this.emit(EV.SWING, { weapon: p.weapon, hit, x: p.x, y: p.y, dir: p.facing }); this.noise(p.x, p.y, wdef.noise, 'melee');
  }
  damageZombie(z, dmg, by, wdef) {
    z.hp -= dmg; this.metrics.damageDealt += dmg;
    const kx = z.x - this.player.x, ky = z.y - this.player.y; const kl = len(kx, ky) || 1;
    z.vx += kx / kl * wdef.knockback * 3; z.vy += ky / kl * wdef.knockback * 3;
    if (z.hp <= 0) { this.setZState(z, ZSTATE.DEAD, { by }); z.deadT = 0; this.metrics.kills++; this.player.kills++; this.emit(EV.ZOMBIE_DEATH, { id: z.id, by, x: z.x, y: z.y }); return; }
    // hitting a zombie always tells it where you are
    if (z.state !== ZSTATE.CHASE && z.state !== ZSTATE.ATTACK) this.alert(z, 'hit');
    z.staggerT = wdef.stagger; this.setZState(z, ZSTATE.STAGGER); this.emit(EV.ZOMBIE_STAGGER, { id: z.id, x: z.x, y: z.y, hp: z.hp });
  }
  frontTile(range) { const p = this.player; return [Math.floor(p.x + Math.cos(p.facing) * range), Math.floor(p.y + Math.sin(p.facing) * range)]; }
  // nearest interactable within reach and roughly in front
  findInteractable() {
    const p = this.player, w = this.world; let best = null, bd = 1e9;
    const consider = (x, y, obj) => { const cx = x + 0.5, cy = y + 0.5; const d = len(cx - p.x, cy - p.y); if (d > PLAYER.interactRange + 0.5) return; const ang = Math.abs(wrap(Math.atan2(cy - p.y, cx - p.x) - p.facing)); if (d > 0.9 && ang > PLAYER.interactArc / 2) return; const score = d + ang * 0.3; if (score < bd) { bd = score; best = obj; } };
    for (const c of w.containers) consider(c.x, c.y, { kind: 'container', c, x: c.x, y: c.y });
    for (const o of w.openings.values()) if (o.kind === 'door') consider(o.x, o.y, { kind: 'door', o, x: o.x, y: o.y });
    for (const k of w.trees.keys()) { const [x, y] = k.split(',').map(Number); consider(x, y, { kind: 'tree', x, y }); }
    return best;
  }
  interact() {
    const p = this.player, w = this.world; const target = this.findInteractable();
    if (!target) { this.emit(EV.ACTION_DENIED, { reason: 'nothing_here', x: p.x, y: p.y }); return; }
    if (target.kind === 'container') {
      const c = target.c; const empty = c.items.length === 0; c.opened = true; this.metrics.containersOpened++;
      this.setPState(PSTATE.INTERACT); this.emit(EV.CONTAINER_OPEN, { container: c.id, kind: c.kind, empty, x: c.x + 0.5, y: c.y + 0.5 });
      for (const it of c.items.splice(0)) this.give(it.item, it.count, c);
      this.record('loot', { container: c.id, kind: c.kind });
    } else if (target.kind === 'door') {
      const o = target.o; if (o.barricade > 0) { this.emit(EV.ACTION_DENIED, { reason: 'barricaded', x: o.x + 0.5, y: o.y + 0.5 }); return; }
      if (o.hp <= 0) { this.emit(EV.ACTION_DENIED, { reason: 'broken', x: o.x + 0.5, y: o.y + 0.5 }); return; }
      // cannot close a door on someone standing in it
      if (o.open) { const inDoor = this.zombies.some((z) => z.state !== ZSTATE.DEAD && Math.floor(z.x) === o.x && Math.floor(z.y) === o.y) || (Math.floor(p.x) === o.x && Math.floor(p.y) === o.y); if (inDoor) { this.emit(EV.ACTION_DENIED, { reason: 'blocked' }); return; } }
      o.open = !o.open; this.setPState(PSTATE.INTERACT); this.emit(o.open ? EV.DOOR_OPEN : EV.DOOR_CLOSE, { x: o.x + 0.5, y: o.y + 0.5, tile: [o.x, o.y] }); this.noise(o.x + 0.5, o.y + 0.5, NOISE.door, 'door'); this.record('door', { x: o.x, y: o.y, open: o.open });
    } else if (target.kind === 'tree') this.harvestInFront(false, target);
  }
  harvestInFront(fromSwing, target) {
    const p = this.player, w = this.world; if (p.harvestT > 0) return false;
    const tr = target || (() => { const it = this.findInteractable(); return it && it.kind === 'tree' ? it : null; })();
    if (!tr) return false;
    const k = w.key(tr.x, tr.y); let hits = w.trees.get(k); if (hits == null) return false;
    hits--; p.harvestT = HARVEST_COOLDOWN; if (!fromSwing) { this.setPState(PSTATE.INTERACT); this.noise(p.x, p.y, NOISE.harvest, 'harvest'); }
    else this.noise(p.x, p.y, NOISE.harvest, 'harvest');
    if (hits <= 0) { w.trees.delete(k); w.set(tr.x, tr.y, TILE.STUMP); this.give('plank', TREE_PLANKS, null); this.metrics.planksHarvested += TREE_PLANKS; this.emit(EV.HARVEST_DONE, { planks: TREE_PLANKS, tile: [tr.x, tr.y], x: tr.x + 0.5, y: tr.y + 0.5 }); this.record('harvest', { x: tr.x, y: tr.y }); }
    else { w.trees.set(k, hits); this.emit(EV.HARVEST_HIT, { tile: [tr.x, tr.y], hitsLeft: hits, x: tr.x + 0.5, y: tr.y + 0.5 }); }
    return true;
  }
  build() {
    const p = this.player, w = this.world;
    // nearest door/window within reach
    let best = null, bd = 1e9;
    for (const o of w.openings.values()) { const d = len(o.x + 0.5 - p.x, o.y + 0.5 - p.y); if (d < PLAYER.interactRange + 0.4 && d < bd) { bd = d; best = o; } }
    if (!best) { this.emit(EV.ACTION_DENIED, { reason: 'no_target', x: p.x, y: p.y }); return; }
    if (best.barricade > 0) { this.emit(EV.ACTION_DENIED, { reason: 'already_barricaded', x: p.x, y: p.y }); return; }
    if (this.count('plank') < BARRICADE_COST) { this.emit(EV.ACTION_DENIED, { reason: 'no_planks', need: BARRICADE_COST, have: this.count('plank'), x: p.x, y: p.y }); return; }
    const occupied = this.zombies.some((z) => z.state !== ZSTATE.DEAD && Math.floor(z.x) === best.x && Math.floor(z.y) === best.y) || (Math.floor(p.x) === best.x && Math.floor(p.y) === best.y);
    if (occupied) { this.emit(EV.ACTION_DENIED, { reason: 'blocked', x: p.x, y: p.y }); return; }
    this.take('plank', BARRICADE_COST); best.barricade = BARRICADE_HP; best.barricadeMax = BARRICADE_HP; if (best.kind === 'door') best.open = false;
    this.metrics.barricadesBuilt++; this.setPState(PSTATE.INTERACT);
    this.emit(EV.BARRICADE_BUILT, { x: best.x + 0.5, y: best.y + 0.5, tile: [best.x, best.y], kind: best.kind }); this.noise(p.x, p.y, NOISE.build, 'build'); this.record('barricade', { x: best.x, y: best.y });
  }
  hurtPlayer(dmg, from, cause) {
    const p = this.player; if (!p.alive) return;
    p.health -= dmg; this.metrics.damageTaken += dmg;
    if (cause === 'zombie' && this.rand() < ZOMBIE.bleedChance) p.bleeding = true;
    this.emit(EV.PLAYER_HURT, { damage: dmg, from: from ? { x: from.x, y: from.y } : null, cause, health: Math.max(0, p.health), bleeding: p.bleeding, x: p.x, y: p.y });
    // being hurt interrupts an interact lock (harvest/barricade/container): a zombie hit staggers (one stagger window,
    // no added lock), any other cause drops straight back to locomotion so the player can move at once
    if (cause === 'zombie') { this.setPState(PSTATE.STAGGER); this.noise(p.x, p.y, NOISE.hurt, 'hurt'); }
    else if (p.state === PSTATE.INTERACT) this.setPState(PSTATE.IDLE);
    if (p.health <= 0) { p.health = 0; p.alive = false; this.setPState(PSTATE.DEAD); this.emit(EV.PLAYER_DEATH, { cause, x: p.x, y: p.y }); this.lose(cause); }
  }
  // ---------------- zombies ----------------
  alert(z, from) {
    const prev = z.state; const p = this.player;
    z.lastSeen = { x: p.x, y: p.y }; z.lastSeenT = this.t; z.alertLevel = 1;
    this.setZState(z, ZSTATE.CHASE, { cause: from }); this.metrics.detections++;
    this.emit(EV.ZOMBIE_ALERT, { id: z.id, from, prev, x: z.x, y: z.y });
  }
  flowField() {
    // Dijkstra from the player's tile over zombie-walkable tiles; openings cost extra (they must be bashed).
    // Dial's algorithm: integer costs (1 per tile, +ceil(hp/10) per obstacle) in a bucket queue, O(N + maxCost).
    const w = this.world, N = w.w * w.h; const dist = new Int32Array(N).fill(1e9);
    const px = Math.floor(this.player.x), py = Math.floor(this.player.y); const start = w.idx(px, py); dist[start] = 0;
    const buckets = [[start]]; const NB = [1, -1, w.w, -w.w];
    for (let d = 0; d < buckets.length; d++) {
      const b = buckets[d]; if (!b) continue;
      for (let k = 0; k < b.length; k++) {
        const i = b[k]; if (dist[i] !== d) continue; const x = i % w.w, y = (i / w.w) | 0;
        for (let n = 0; n < 4; n++) {
          const nx = x + (n === 0 ? 1 : n === 1 ? -1 : 0), ny = y + (n === 2 ? 1 : n === 3 ? -1 : 0); if (nx < 0 || ny < 0 || nx >= w.w || ny >= w.h) continue;
          const ni = i + NB[n]; const t = w.tiles[ni]; if (SOLID.has(t)) continue;
          let c = 1; if (t === TILE.DOOR || t === TILE.WINDOW) { const o = w.opening(nx, ny); if (o) c += Math.ceil(((o.barricade > 0 ? o.barricade : 0) + (t === TILE.WINDOW && o.hp > 0 ? o.hp : 0) + (t === TILE.DOOR && !o.open && o.hp > 0 ? o.hp : 0)) / 10); }
          const nd = d + c; if (nd < dist[ni]) { dist[ni] = nd; (buckets[nd] || (buckets[nd] = [])).push(ni); }
        }
      }
    }
    return dist;
  }
  stepZombies() {
    const p = this.player, w = this.world, night = this.isNight();
    if (this.tick - this.fieldTick >= 6) { this.field = this.flowField(); this.fieldTick = this.tick; }
    const sight = night ? ZOMBIE.sightNight : ZOMBIE.sightDay;
    // hard bodies for zombie locomotion: the living player and every live zombie (each skips itself)
    const bodies = this.zombies.filter((o) => o.state !== ZSTATE.DEAD).map((o) => ({ e: o, r: ZOMBIE.radius }));
    if (p.alive) bodies.push({ e: null, x: p.x, y: p.y, r: PLAYER.radius });
    for (const z of this.zombies) {
      z.stateT = (z.stateT || 0) + DT;
      if (z.state === ZSTATE.DEAD) { z.deadT += DT; continue; }
      z.attackT = Math.max(0, z.attackT - DT); z.bashT = Math.max(0, z.bashT - DT); z.groanT -= DT;
      if (z.groanT <= 0) { z.groanT = ZOMBIE.groanInterval[0] + this.rand() * (ZOMBIE.groanInterval[1] - ZOMBIE.groanInterval[0]); if (z.state === ZSTATE.CHASE || z.state === ZSTATE.ATTACK) z.groanT *= 0.5; this.emit(EV.ZOMBIE_GROAN, { id: z.id, state: z.state, x: z.x, y: z.y }); }
      // ---- senses ----
      const dx = p.x - z.x, dy = p.y - z.y, d = len(dx, dy);
      let sees = false;
      if (p.alive && d < sight) { const ang = Math.abs(wrap(Math.atan2(dy, dx) - z.facing)); const eff = p.gait === 'sneak' ? sight * 0.55 : sight; if (d < eff && (ang < ZOMBIE.fov / 2 || d < 1.6) && this.hasLOS(z.x, z.y, p.x, p.y)) sees = true; }
      z.seesPlayer = sees;
      if (sees) { z.lastSeen = { x: p.x, y: p.y }; z.lastSeenT = this.t; if (z.state !== ZSTATE.CHASE && z.state !== ZSTATE.ATTACK && z.state !== ZSTATE.STAGGER && z.state !== ZSTATE.BASH) this.alert(z, 'sight'); }
      else if (z.state !== ZSTATE.CHASE && z.state !== ZSTATE.ATTACK && z.state !== ZSTATE.STAGGER && z.state !== ZSTATE.BASH) {
        for (const n of this.noises) { const nd = len(n.x - z.x, n.y - z.y); if (nd <= n.r * ZOMBIE.hearingScale) { if (n.kind === 'gunshot' || n.kind === 'hurt' || nd < n.r * 0.35) { this.alert(z, 'sound'); z.lastSeen = { x: n.x, y: n.y }; } else if (z.state !== ZSTATE.INVESTIGATE || this.rand() < 0.3) { z.target = { x: n.x, y: n.y }; z.investigateT = 0; this.setZState(z, ZSTATE.INVESTIGATE, { cause: 'sound', kind: n.kind }); } break; } }
      }
      // ---- state machine ----
      let speed = 0, tx = null, ty = null;
      switch (z.state) {
        case ZSTATE.STAGGER: z.staggerT -= DT; if (z.staggerT <= 0) this.setZState(z, z.lastSeen ? ZSTATE.CHASE : ZSTATE.WANDER); break;
        case ZSTATE.IDLE: case ZSTATE.WANDER: {
          z.wanderT -= DT;
          if (z.state === ZSTATE.IDLE) { if (z.wanderT <= 0) { const a = this.rand() * TAU, r = 1 + this.rand() * ZOMBIE.wanderRadius; z.target = { x: clamp(z.x + Math.cos(a) * r, 1, w.w - 1), y: clamp(z.y + Math.sin(a) * r, 1, w.h - 1) }; this.setZState(z, ZSTATE.WANDER); z.wanderT = 6 + this.rand() * 4; } }
          else { if (!z.target) { this.setZState(z, ZSTATE.IDLE); z.wanderT = 0; break; } const wd = len(z.target.x - z.x, z.target.y - z.y); if (wd < 0.4 || z.wanderT <= 0 || z.stuckT > 1.2) { z.target = null; z.stuckT = 0; this.setZState(z, ZSTATE.IDLE); z.wanderT = ZOMBIE.wanderPause[0] + this.rand() * (ZOMBIE.wanderPause[1] - ZOMBIE.wanderPause[0]); } else { speed = ZOMBIE.walk; tx = z.target.x; ty = z.target.y; } }
          break;
        }
        case ZSTATE.INVESTIGATE: {
          z.investigateT += DT; const wd = z.target ? len(z.target.x - z.x, z.target.y - z.y) : 0;
          if (!z.target || wd < 0.5 || z.investigateT > ZOMBIE.investigateGiveUp || z.stuckT > 1.5) { z.target = null; z.stuckT = 0; this.setZState(z, ZSTATE.IDLE); z.wanderT = 1 + this.rand() * 2; }
          else { speed = ZOMBIE.investigate; tx = z.target.x; ty = z.target.y; }
          break;
        }
        case ZSTATE.CHASE: {
          if (!p.alive) { this.setZState(z, ZSTATE.IDLE); z.lastSeen = null; break; }
          if (z.horde || sees) { z.lastSeen = { x: p.x, y: p.y }; z.lastSeenT = this.t; }
          if (!z.horde && !sees && this.t - z.lastSeenT > ZOMBIE.loseSightTime) { z.target = { ...z.lastSeen }; z.investigateT = 0; z.lastSeen = null; this.setZState(z, ZSTATE.INVESTIGATE, { cause: 'lost' }); this.emit(EV.ZOMBIE_LOST, { id: z.id, x: z.x, y: z.y }); break; }
          if (d <= ZOMBIE.attackRange + PLAYER.radius && z.attackT <= 0 && this.hasLOS(z.x, z.y, p.x, p.y)) { this.setZState(z, ZSTATE.ATTACK); z.attackWind = ZOMBIE.attackWindup; z.facing = Math.atan2(dy, dx); this.emit(EV.ZOMBIE_ATTACK, { id: z.id, x: z.x, y: z.y }); break; }
          speed = (night ? ZOMBIE.chaseNight : ZOMBIE.chase) + (z.horde ? ZOMBIE.hordeSpeedBonus : 0);
          // follow the flow field when the player is known (horde or recent sight); it routes through openings which are then bashed
          const useField = z.horde || (sees && d > 1.5) || (z.lastSeen && this.t - z.lastSeenT < 1.5);
          if (useField && this.field) { const step = this.fieldStep(z); if (step) { tx = step[0]; ty = step[1]; if (step[2]) { const o = step[2]; if (len(o.x + 0.5 - z.x, o.y + 0.5 - z.y) < 1.15) { this.setZState(z, ZSTATE.BASH); z.target = o; speed = 0; tx = null; } } } else { tx = z.lastSeen ? z.lastSeen.x : p.x; ty = z.lastSeen ? z.lastSeen.y : p.y; } }
          else { tx = z.lastSeen ? z.lastSeen.x : p.x; ty = z.lastSeen ? z.lastSeen.y : p.y; }
          break;
        }
        case ZSTATE.ATTACK: {
          z.attackWind -= DT; z.facing = Math.atan2(dy, dx);
          if (z.attackWind <= 0) { z.attackT = ZOMBIE.attackCooldown; if (p.alive && d <= ZOMBIE.attackRange + PLAYER.radius + 0.15 && this.hasLOS(z.x, z.y, p.x, p.y)) { this.hurtPlayer(ZOMBIE.attackDamage, z, 'zombie'); const kl = d || 1; p.vx += dx / kl * 2.5; p.vy += dy / kl * 2.5; } this.setZState(z, ZSTATE.CHASE); }
          break;
        }
        case ZSTATE.BASH: {
          const o = z.target; const gone = !o || (o.barricade <= 0 && (o.kind === 'door' ? (o.open || o.hp <= 0) : o.hp <= 0));
          if (gone) { z.target = null; this.setZState(z, ZSTATE.CHASE); break; }
          const od = len(o.x + 0.5 - z.x, o.y + 0.5 - z.y); z.facing = Math.atan2(o.y + 0.5 - z.y, o.x + 0.5 - z.x);
          if (od > 1.3) { speed = ZOMBIE.walk; tx = o.x + 0.5; ty = o.y + 0.5; }
          else if (z.bashT <= 0) { z.bashT = ZOMBIE.bashCooldown * (0.8 + this.rand() * 0.4); this.bashOpening(z, o); }
          if (sees && d < ZOMBIE.attackRange + PLAYER.radius) this.setZState(z, ZSTATE.CHASE);
          break;
        }
      }
      // ---- locomotion ----
      if (tx != null) { const mx = tx - z.x, my = ty - z.y; const ml = len(mx, my) || 1; const a = ZOMBIE.accel * DT; z.vx += clamp(mx / ml * speed - z.vx, -a, a); z.vy += clamp(my / ml * speed - z.vy, -a, a); z.facing = Math.atan2(z.vy, z.vx); }
      else { z.vx *= 0.8; z.vy *= 0.8; }
      // separation from other zombies (soft) and from the player (hard). Both are direct displacements, so they are
      // only applied when the pushed position is free: a zombie shoved into a wall could never move again
      // (moveCircle rejects every step that still overlaps).
      const zblock = (x, y) => w.blocksZombie(x, y);
      for (const o of this.zombies) { if (o === z || o.state === ZSTATE.DEAD) continue; const sx = z.x - o.x, sy = z.y - o.y; const sd = len(sx, sy); if (sd < ZOMBIE.separation && sd > 1e-4) { const push = (ZOMBIE.separation - sd) * 4 * DT; this.nudge(z, sx / sd * push, sy / sd * push, ZOMBIE.radius, zblock); } }
      { const sx = z.x - p.x, sy = z.y - p.y; const sd = len(sx, sy); const min = ZOMBIE.radius + PLAYER.radius; if (p.alive && sd < min && sd > 1e-4) this.nudge(z, sx / sd * (min - sd), sy / sd * (min - sd), ZOMBIE.radius, zblock); }
      const bx = z.x, by = z.y;
      this.moveCircle(z, z.vx * DT, z.vy * DT, ZOMBIE.radius, (x, y) => w.blocksZombie(x, y), bodies);
      const moved = len(z.x - bx, z.y - by);
      if (tx != null && speed > 0) { z.stuckT = moved < speed * DT * 0.25 ? z.stuckT + DT : 0; } else z.stuckT = 0;
      if (moved > 0.002) { z.stepT += DT; const gait = z.state === ZSTATE.CHASE ? 'chase' : 'shamble'; const iv = gait === 'chase' ? 0.38 : 0.7; if (z.stepT >= iv) { z.stepT = 0; this.emit(EV.FOOTSTEP, { who: z.id, surface: SURFACE[w.get(Math.floor(z.x), Math.floor(z.y))] || 'grass', gait, x: z.x, y: z.y }); } }
    }
    // cull long-dead bodies (keep for 40 s so the scene shows the fight)
    this.zombies = this.zombies.filter((z) => z.state !== ZSTATE.DEAD || z.deadT < 40);
  }
  // next tile centre to move to along the flow field; returns [x, y, openingOrNull]
  fieldStep(z) {
    const w = this.world, f = this.field; const x = Math.floor(z.x), y = Math.floor(z.y); const here = f[w.idx(x, y)];
    let best = null, bd = here;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (!w.inBounds(nx, ny)) continue; const v = f[w.idx(nx, ny)]; if (v < bd) { bd = v; best = [nx, ny]; } }
    if (!best) return null;
    const t = w.get(best[0], best[1]); let o = null;
    if ((t === TILE.DOOR || t === TILE.WINDOW) && w.blocksZombie(best[0], best[1])) o = w.opening(best[0], best[1]);
    return [best[0] + 0.5, best[1] + 0.5, o];
  }
  bashOpening(z, o) {
    const dmg = ZOMBIE.bashDamage;
    if (o.barricade > 0) { o.barricade = Math.max(0, o.barricade - dmg); this.emit(EV.BARRICADE_HIT, { id: z.id, x: o.x + 0.5, y: o.y + 0.5, tile: [o.x, o.y], hp: o.barricade }); if (o.barricade <= 0) { this.metrics.barricadesBroken++; this.emit(EV.BARRICADE_BROKEN, { id: z.id, x: o.x + 0.5, y: o.y + 0.5, tile: [o.x, o.y] }); this.noise(o.x + 0.5, o.y + 0.5, NOISE.break, 'break'); this.record('barricade.broken', { x: o.x, y: o.y }); } }
    else { o.hp = Math.max(0, o.hp - dmg); this.emit(EV.ZOMBIE_BASH, { id: z.id, x: o.x + 0.5, y: o.y + 0.5, tile: [o.x, o.y], kind: o.kind, hp: o.hp }); if (o.hp <= 0) { if (o.kind === 'door') { o.open = true; this.metrics.doorsBroken++; this.emit(EV.DOOR_BREAK, { x: o.x + 0.5, y: o.y + 0.5, tile: [o.x, o.y] }); } else this.emit(EV.WINDOW_BREAK, { x: o.x + 0.5, y: o.y + 0.5, tile: [o.x, o.y] }); this.noise(o.x + 0.5, o.y + 0.5, NOISE.break, 'break'); this.record('opening.broken', { x: o.x, y: o.y, kind: o.kind }); } }
    this.noise(o.x + 0.5, o.y + 0.5, NOISE.bash, 'bash');
  }
  // ---------------- objective ----------------
  stepObjective() {
    if (this.objective.state !== 'active') return;
    const st = this.objective.steps, i = this.objective.index; if (i >= st.length) return;
    const p = this.player; let done = false;
    switch (st[i].id) {
      case 'supplies': done = this.count('water') > 0 && this.count('food') > 0 || (this.metrics.drank > 0 && this.metrics.ate > 0); break;
      case 'arm': done = this.count('bat') > 0 || this.count('pistol') > 0; break;
      case 'planks': done = this.count('plank') >= 4 || this.metrics.barricadesBuilt >= 2; break;
      case 'fortify': done = this.metrics.barricadesBuilt >= 2; break;
      case 'survive': done = this.result === 'won'; break;
    }
    if (done) {
      st[i].done = true; st[i].doneAt = this.t; this.objective.index = i + 1;
      this.emit(EV.OBJECTIVE_STEP, { id: st[i].id, label: st[i].label, index: i, x: p.x, y: p.y }); this.record('objective', { id: st[i].id, done: true, next: st[i + 1] ? st[i + 1].id : null, index: i + 1 });
      if (i + 1 >= st.length) { this.objective.state = 'complete'; this.emit(EV.OBJECTIVE_COMPLETE, { x: p.x, y: p.y }); }
    }
  }
  win() { if (this.result) return; this.result = 'won'; this.metrics.survivedSeconds = this.t; this.stepObjective(); this.emit(EV.WIN, { x: this.player.x, y: this.player.y, day: this.day, hour: +this.hour.toFixed(2) }); this.record('result', { result: 'won' }); }
  lose(cause) { if (this.result) return; this.result = 'lost'; this.metrics.survivedSeconds = this.t; this.objective.state = 'failed'; this.emit(EV.LOSE, { cause, x: this.player.x, y: this.player.y, day: this.day, hour: +this.hour.toFixed(2) }); this.record('result', { result: 'lost', cause }); }
  // compact snapshot for HUD/tests/evidence
  summary() {
    const p = this.player;
    return { tick: this.tick, t: +this.t.toFixed(2), day: this.day, hour: +this.hour.toFixed(2), clock: this.clock(), phase: this.phase, result: this.result,
      player: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), state: p.state, health: +p.health.toFixed(1), stamina: +p.stamina.toFixed(1), hunger: +p.hunger.toFixed(1), thirst: +p.thirst.toFixed(1), bleeding: p.bleeding, weapon: p.weapon, mag: p.mag, inventory: { ...p.inventory }, alive: p.alive, kills: p.kills },
      zombies: this.zombies.filter((z) => z.state !== ZSTATE.DEAD).length, chasing: this.zombies.filter((z) => z.state === ZSTATE.CHASE || z.state === ZSTATE.ATTACK).length,
      objective: { index: this.objective.index, state: this.objective.state, current: this.objective.steps[this.objective.index] ? this.objective.steps[this.objective.index].id : null },
      barricades: [...this.world.openings.values()].filter((o) => o.barricade > 0).length, metrics: { ...this.metrics } };
  }
}
