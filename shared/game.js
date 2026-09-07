// Authoritative match simulation (shared by server, client prediction and bots).
import {
  PM, WEAPONS, WEAPON_DEFS, WEAPON_ORDER, WEAPON_DROP_TIME, WEAPON_RAISE_TIME, SELF_DAMAGE_SCALE, ARMOR_PROTECTION,
  HEALTH, ARMOR, ITEMS, ITEM_HALF, MATCH, BUTTONS, TICK_MS, FRAMETIME, EV, LAG_COMP_MAX_MS, HISTORY_TICKS,
} from './constants.js';
import { pmove, newPlayerState, PMF } from './pmove.js';
import { traceBox } from './trace.js';
import { angleVectors, add, sub, scale, ma, dot, length, normalize, dist, copy, makeRng, cross, vectorToAngles } from './vec3.js';
import { BRUSH_FLAGS, jumppadVelocity } from './map.js';

const EYE = (p) => [p.ps.origin[0], p.ps.origin[1], p.ps.origin[2] + p.ps.viewHeight];

export class Game {
  constructor(map, opts = {}) {
    this.map = map;
    this.world = { brushes: map.brushes };
    this.mode = opts.mode || 'duel';
    this.rules = { ...MATCH[this.mode], ...(opts.rules || {}) };
    this.seed = opts.seed ?? 1337;
    this.rng = makeRng(this.seed);
    this.isServer = opts.isServer !== false;
    this.lagComp = opts.lagComp !== false;
    this.players = new Map();
    this.projectiles = new Map();
    this.nextEntityId = 1;
    this.tick = 0;
    this.time = 0; // ms
    this.events = [];
    this.items = map.items.map((it, i) => ({ index: i, type: it.type, def: ITEMS[it.type], origin: it.origin, available: true, respawnAt: 0 }));
    this.match = { state: this.mode === 'arena' ? 'waiting' : 'warmup', startTime: 0, endTime: 0, winner: null, overtime: false, round: 0, roundState: 'idle', roundEndAt: 0, roundWins: {}, countdownAt: 0 };
    this.log = opts.log || (() => {});
    this.maxCmdsPerTick = opts.maxCmdsPerTick || 4;
  }

  // ---------- players ----------
  addPlayer(id, name, opts = {}) {
    const p = {
      id, name: name || `player${id}`, ps: newPlayerState(), health: 0, armor: 0, dead: true, deathTime: -1e9, spawnTime: 0,
      weapon: WEAPONS.MACHINEGUN, pendingWeapon: 0, weaponState: 'ready', weaponTime: 0, ammo: {}, weapons: 0,
      frags: 0, deaths: 0, damageDealt: 0, damageTaken: 0, hits: 0, shots: 0, lastCmdSeq: 0, cmdQueue: [], lastCmd: null,
      attackHeld: false, history: [], mins: PM.mins, maxs: PM.maxs, origin: [0, 0, 0], isBot: !!opts.isBot, ready: false,
      viewTime: 0, respawnPending: false, lastPain: 0, healthDecayAt: 0, lastFootstep: 0, killer: null, ping: 0, connectedAt: this.time, meansOfDeath: 0,
    };
    this.players.set(id, p);
    if (this.match.state !== 'playing' || this.mode === 'duel') this.spawnPlayer(p, true);
    return p;
  }
  removePlayer(id) { this.players.delete(id); }
  other(p) { for (const q of this.players.values()) if (q !== p) return q; return null; }

  spawnPlayer(p, initial = false) {
    const spot = this.selectSpawnPoint(p);
    p.ps = newPlayerState();
    p.ps.origin = copy(spot.origin);
    p.ps.velocity = [0, 0, 0];
    p.ps.viewangles = [0, spot.yaw, 0];
    p.ps.pmFlags = PMF.RESPAWNED;
    p.dead = false;
    p.spawnTime = this.time;
    p.respawnPending = false;
    p.killer = null;
    p.origin = p.ps.origin;
    p.mins = PM.mins; p.maxs = PM.maxs;
    p.spawnAngles = [0, spot.yaw, 0];
    if (this.mode === 'arena') {
      p.health = 100; p.armor = 100;
      p.weapons = 0; p.ammo = {};
      for (const w of WEAPON_ORDER) { p.weapons |= (1 << w); p.ammo[w] = WEAPON_DEFS[w].ammoStart < 0 ? -1 : Math.max(WEAPON_DEFS[w].ammoStart, 25); }
      p.ammo[WEAPONS.ROCKET] = 25; p.ammo[WEAPONS.RAIL] = 15; p.ammo[WEAPONS.LIGHTNING] = 150; p.ammo[WEAPONS.PLASMA] = 100; p.ammo[WEAPONS.SHOTGUN] = 25; p.ammo[WEAPONS.MACHINEGUN] = 150;
      p.weapon = WEAPONS.ROCKET;
    } else {
      p.health = HEALTH.spawn; p.armor = 0;
      p.weapons = (1 << WEAPONS.GAUNTLET) | (1 << WEAPONS.MACHINEGUN);
      p.ammo = { [WEAPONS.GAUNTLET]: -1, [WEAPONS.MACHINEGUN]: WEAPON_DEFS[WEAPONS.MACHINEGUN].ammoStart };
      p.weapon = WEAPONS.MACHINEGUN;
    }
    p.pendingWeapon = 0; p.weaponState = 'ready'; p.weaponTime = 0; p.attackHeld = true; // require release before firing
    p.healthDecayAt = this.time + HEALTH.decayInterval;
    p.history = [];
    // telefrag anyone standing there
    for (const q of this.players.values()) {
      if (q === p || q.dead) continue;
      if (boxesOverlap(p.ps.origin, PM.mins, PM.maxs, q.ps.origin, q.mins, q.maxs)) this.killPlayer(q, p, 'telefrag');
    }
    this.events.push({ type: EV.RESPAWN, id: p.id, origin: copy(p.ps.origin), initial });
  }

  selectSpawnPoint(p) {
    const spawns = this.map.spawns;
    if (!spawns.length) return { origin: [0, 0, 64], yaw: 0 };
    // Q3 SelectRandomFurthestSpawnPoint: choose randomly among the spawns farthest from the enemy (and away from the death spot).
    const enemy = this.other(p);
    const avoid = enemy && !enemy.dead ? enemy.ps.origin : (p.lastDeathOrigin || null);
    const candidates = spawns.filter((s) => !this.spawnBlocked(s));
    const list = candidates.length ? candidates : spawns;
    if (!avoid) return list[Math.floor(this.rng() * list.length)];
    const scored = list.map((s) => ({ s, d: dist(s.origin, avoid) })).sort((a, b) => b.d - a.d);
    const top = scored.slice(0, Math.max(1, Math.ceil(scored.length / 2)));
    return top[Math.floor(this.rng() * top.length)].s;
  }
  spawnBlocked(s) {
    for (const q of this.players.values()) if (!q.dead && boxesOverlap(s.origin, PM.mins, PM.maxs, q.ps.origin, q.mins, q.maxs)) return true;
    return false;
  }

  // ---------- commands ----------
  queueCommand(id, cmd) {
    const p = this.players.get(id);
    if (!p) return;
    if (cmd.seq <= p.lastCmdSeq) return; // duplicate / out of order
    p.cmdQueue.push(cmd);
    if (p.cmdQueue.length > 64) p.cmdQueue.splice(0, p.cmdQueue.length - 64);
  }

  // Server tick: consume queued commands, advance projectiles, items, match state.
  step() {
    this.tick++;
    this.time = Math.round(this.tick * TICK_MS);
    this.events = [];
    for (const p of this.players.values()) {
      let n = 0;
      if (p.cmdQueue.length === 0) {
        // no input this tick: keep physics running with the last command (buttons cleared) so the player still falls/slides
        if (p.lastCmd) this.runPlayerCommand(p, { ...p.lastCmd, seq: p.lastCmdSeq, buttons: 0, forward: 0, right: 0, up: 0, repeat: true });
      } else {
        while (p.cmdQueue.length && n < this.maxCmdsPerTick) {
          const cmd = p.cmdQueue.shift();
          this.runPlayerCommand(p, cmd);
          n++;
        }
      }
      this.recordHistory(p);
    }
    this.runProjectiles();
    this.runItems();
    this.runMatch();
    return this.events;
  }

  // Run one player command (one fixed 1/60 s step). predict=true on the client: no damage, no projectile spawning.
  runPlayerCommand(p, cmd, predict = false) {
    if (!cmd.repeat) p.lastCmdSeq = cmd.seq; p.lastCmd = cmd;
    p.viewTime = cmd.vt || 0;
    const events = [];
    const entities = [];
    for (const q of this.players.values()) if (q !== p && !q.dead) entities.push({ id: q.id, origin: q.ps.origin, mins: q.mins, maxs: q.maxs });
    // frozen during countdown / between rounds
    const frozen = (this.match.state === 'countdown') || (this.mode === 'arena' && this.match.roundState !== 'live' && this.match.state === 'playing');
    const moveCmd = frozen ? { ...cmd, forward: 0, right: 0, up: 0, buttons: 0 } : cmd;
    if (p.dead) {
      pmove(p.ps, { ...cmd, forward: 0, right: 0, up: 0, buttons: 0 }, { world: this.world, entities: [], skipId: p.id, events, skipFlags: BRUSH_FLAGS.PLAYERCLIP });
      p.ps.dead = true;
      this.checkRespawn(p, cmd, predict);
      return events;
    }
    p.ps.dead = false;
    pmove(p.ps, moveCmd, { world: this.world, entities, skipId: p.id, events, skipFlags: 0 });
    p.origin = p.ps.origin;
    p.mins = PM.mins; p.maxs = (p.ps.pmFlags & PMF.DUCKED) ? PM.duckMaxs : PM.maxs;
    this.touchTriggers(p, events, predict);
    if (!predict) this.touchItems(p);
    this.weaponLogic(p, moveCmd, events, predict);
    for (const e of events) {
      e.id = p.id;
      if (e.type === EV.FALL_DAMAGE && !predict && this.mode === 'duel') this.damage(p, null, e.damage, [0, 0, 0], p.ps.origin, 'fall', 0);
    }
    if (predict) return events;
    this.events.push(...events);
    return events;
  }

  checkRespawn(p, cmd, predict) {
    if (predict) return;
    if (this.mode === 'arena') return; // rounds handle it
    const since = this.time - p.deathTime;
    const pressed = (cmd.buttons & (BUTTONS.ATTACK | BUTTONS.JUMP)) !== 0;
    if (since >= this.rules.respawnForce || (since >= this.rules.respawnMin && pressed && !cmd.repeat)) this.spawnPlayer(p);
  }

  touchTriggers(p, events, predict) {
    for (const t of this.map.triggers) {
      if (!boxesOverlapAbs(p.ps.origin, p.mins, p.maxs, t.mins, t.maxs)) continue;
      if (t.kind === 'jumppad') {
        if (this.time - p.ps.jumpPadTime < 100 && p.ps.lastPad === t) continue;
        p.ps.velocity = jumppadVelocity([(t.mins[0] + t.maxs[0]) / 2, (t.mins[1] + t.maxs[1]) / 2, t.maxs[2]], t.target, PM.gravity);
        p.ps.groundEntity = false;
        p.ps.jumpPadTime = this.time; p.ps.lastPad = t;
        events.push({ type: EV.JUMPPAD, origin: copy(p.ps.origin) });
      } else if (t.kind === 'teleporter') {
        p.ps.origin = copy(t.dest);
        p.ps.velocity = [0, 0, 0];
        p.ps.viewangles = [0, t.destYaw, 0];
        p.teleportYaw = t.destYaw; p.teleportSeq = (p.teleportSeq || 0) + 1;
        events.push({ type: EV.TELEPORT, origin: copy(t.dest) });
      } else if (t.kind === 'lava' && !predict && this.isServer) {
        if (this.time - (p.lastLava || 0) >= 200) { p.lastLava = this.time; this.damage(p, null, 30, [0, 0, 0], p.ps.origin, 'lava', 0); }
      }
    }
  }

  touchItems(p) {
    if (this.mode === 'arena') return;
    for (const it of this.items) {
      if (!it.available) continue;
      const o = it.origin;
      if (!boxesOverlapAbs(p.ps.origin, p.mins, p.maxs, [o[0] - ITEM_HALF, o[1] - ITEM_HALF, o[2] - ITEM_HALF], [o[0] + ITEM_HALF, o[1] + ITEM_HALF, o[2] + ITEM_HALF])) continue;
      if (this.pickup(p, it)) {
        it.available = false; it.respawnAt = this.time + it.def.respawn;
        this.events.push({ type: EV.PICKUP, id: p.id, item: it.index, itemType: it.type, origin: copy(o) });
      }
    }
  }

  pickup(p, it) {
    const d = it.def;
    switch (d.kind) {
      case 'health': if (p.health >= d.max) return false; p.health = Math.min(d.max, p.health + d.amount); return true;
      case 'armor': if (p.armor >= d.max) return false; p.armor = Math.min(d.max, p.armor + d.amount); return true;
      case 'weapon': {
        const w = d.weapon, wd = WEAPON_DEFS[w];
        const had = (p.weapons & (1 << w)) !== 0;
        if (had && (p.ammo[w] || 0) >= wd.ammoMax) return false;
        p.weapons |= (1 << w);
        // Q3: picking up a weapon you have gives quantity ammo (weapon's count), capped
        p.ammo[w] = Math.min(wd.ammoMax, (p.ammo[w] || 0) + (had ? wd.ammoPickup : wd.ammoStart));
        if (!had && this.rules.autoswitch !== false && p.weapon !== WEAPONS.ROCKET && p.weapon !== WEAPONS.RAIL && p.weapon !== WEAPONS.LIGHTNING) { /* Q3 cg_autoswitch default 1; competitive players disable it. Keep off for majors. */ }
        return true;
      }
      case 'ammo': {
        const w = d.weapon, wd = WEAPON_DEFS[w];
        if ((p.ammo[w] || 0) >= wd.ammoMax) return false;
        p.ammo[w] = Math.min(wd.ammoMax, (p.ammo[w] || 0) + d.amount);
        return true;
      }
    }
    return false;
  }

  // ---------- weapons ----------
  weaponLogic(p, cmd, events, predict) {
    const msec = Math.round(FRAMETIME * 1000);
    if (p.weaponTime > 0) p.weaponTime -= msec;
    // weapon selection
    if (cmd.weapon && cmd.weapon !== p.weapon && cmd.weapon !== p.pendingWeapon && (p.weapons & (1 << cmd.weapon))) {
      p.pendingWeapon = cmd.weapon;
    }
    if (p.weaponTime <= 0) {
      if (p.weaponState === 'dropping') {
        p.weaponState = 'raising'; p.weapon = p.pendingWeapon; p.pendingWeapon = 0; p.weaponTime = WEAPON_RAISE_TIME;
        events.push({ type: EV.WEAPON_CHANGE, weapon: p.weapon });
        return;
      }
      if (p.weaponState === 'raising') { p.weaponState = 'ready'; p.weaponTime = 0; }
      if (p.pendingWeapon && p.weaponState === 'ready') { p.weaponState = 'dropping'; p.weaponTime = WEAPON_DROP_TIME; return; }
    }
    if (p.weaponTime > 0) return;
    const attack = (cmd.buttons & BUTTONS.ATTACK) !== 0;
    if (!attack) { p.attackHeld = false; return; }
    if (p.attackHeld && WEAPON_DEFS[p.weapon].melee) return; // gauntlet needs re-press? Q3 gauntlet auto-repeats; keep simple: allow hold
    if (this.match.state === 'countdown' || this.match.state === 'ended') return;
    const wd = WEAPON_DEFS[p.weapon];
    const ammo = p.ammo[p.weapon] ?? 0;
    if (ammo === 0) {
      // out of ammo: Q3 plays noammo and switches to the best weapon
      p.weaponTime = 500;
      events.push({ type: EV.NOAMMO, weapon: p.weapon });
      const best = this.bestWeapon(p);
      if (best && best !== p.weapon) p.pendingWeapon = best;
      return;
    }
    if (ammo > 0) p.ammo[p.weapon] = ammo - 1;
    p.weaponTime = wd.refire;
    p.shots++;
    const eye = EYE(p);
    const av = angleVectors(p.ps.viewangles);
    const seed = (p.lastCmdSeq * 7919 + p.id * 104729) >>> 0;
    events.push({ type: EV.FIRE, weapon: p.weapon, origin: copy(eye), dir: copy(av.forward), seq: p.lastCmdSeq, seed });
    if (predict) {
      // client: rail/LG/MG feedback only; hits come from the server
      return;
    }
    this.fireWeapon(p, p.weapon, eye, av, seed);
  }

  bestWeapon(p) {
    const order = [WEAPONS.ROCKET, WEAPONS.RAIL, WEAPONS.LIGHTNING, WEAPONS.PLASMA, WEAPONS.SHOTGUN, WEAPONS.MACHINEGUN, WEAPONS.GAUNTLET];
    for (const w of order) if ((p.weapons & (1 << w)) && (p.ammo[w] === -1 || (p.ammo[w] || 0) > 0)) return w;
    return WEAPONS.GAUNTLET;
  }

  fireWeapon(p, w, eye, av, seed) {
    const wd = WEAPON_DEFS[w];
    const rng = makeRng(seed);
    if (wd.projectile) {
      // Q3: muzzle = eye + forward*14, then origin snapped; rockets fly from slightly below the eye (right 0? Q3: muzzle point uses viewheight with no offset)
      const muzzle = ma(eye, 14, av.forward);
      const dir = copy(av.forward);
      const id = this.nextEntityId++;
      const pr = { id, type: w, owner: p.id, origin: muzzle, velocity: scale(dir, wd.speed), spawnTime: this.time, seq: p.lastCmdSeq, lifetime: 10000, bounce: false };
      this.projectiles.set(id, pr);
      return;
    }
    if (wd.melee) {
      const end = ma(eye, wd.range, av.forward);
      const tr = this.traceLagComp(p, eye, end);
      if (tr.entity) { this.damage(this.players.get(tr.entity.id), p, wd.damage, av.forward, tr.endpos, w, 0); }
      return;
    }
    const pellets = wd.pellets || 1;
    for (let i = 0; i < pellets; i++) {
      let dir = av.forward;
      if (wd.spread) {
        // Q3 bullet spread: r = crandom*spread, u = crandom*spread at 8192 units
        const r = (rng() * 2 - 1) * wd.spread, u = (rng() * 2 - 1) * wd.spread;
        const end = ma(ma(ma(eye, 8192, av.forward), r, av.right), u, av.up);
        dir = normalize(sub(end, eye));
      }
      const end = ma(eye, wd.range, dir);
      const tr = this.traceLagComp(p, eye, end);
      if (w === WEAPONS.RAIL) this.events.push({ type: EV.RAIL_TRAIL, id: p.id, start: copy(eye), end: copy(tr.endpos) });
      if (tr.entity) {
        this.damage(this.players.get(tr.entity.id), p, wd.damage, dir, tr.endpos, w, 0);
        if (w === WEAPONS.LIGHTNING) this.events.push({ type: EV.LG_HIT, id: p.id, origin: copy(tr.endpos) });
      } else if (tr.fraction < 1) {
        if (w === WEAPONS.LIGHTNING) this.events.push({ type: EV.LG_HIT, id: p.id, origin: copy(tr.endpos), world: true, normal: tr.plane ? copy(tr.plane.n) : [0, 0, 1] });
        else this.events.push({ type: EV.BULLET_IMPACT, id: p.id, weapon: w, origin: copy(tr.endpos), normal: tr.plane ? copy(tr.plane.n) : [0, 0, 1] });
      }
    }
  }

  // Lag-compensated hitscan: rewind other players to the shooter's view time.
  traceLagComp(shooter, start, end) {
    const entities = [];
    let rewindTo = null;
    if (this.lagComp && shooter.viewTime && !shooter.isBot) {
      rewindTo = Math.max(this.time - LAG_COMP_MAX_MS, Math.min(this.time, shooter.viewTime));
    }
    for (const q of this.players.values()) {
      if (q === shooter || q.dead) continue;
      let origin = q.ps.origin, mins = q.mins, maxs = q.maxs;
      if (rewindTo !== null) {
        const h = sampleHistory(q.history, rewindTo);
        if (h) { origin = h.origin; mins = h.mins; maxs = h.maxs; }
      }
      entities.push({ id: q.id, origin, mins, maxs });
    }
    return traceBox(this.world, start, end, [0, 0, 0], [0, 0, 0], entities, { skip: shooter.id, skipFlags: BRUSH_FLAGS.PLAYERCLIP });
  }

  recordHistory(p) {
    if (p.dead) return;
    p.history.push({ time: this.time, origin: copy(p.ps.origin), mins: p.mins, maxs: p.maxs });
    if (p.history.length > HISTORY_TICKS) p.history.shift();
  }

  runProjectiles() {
    for (const pr of [...this.projectiles.values()]) {
      const wd = WEAPON_DEFS[pr.type];
      const owner = this.players.get(pr.owner);
      const start = pr.origin;
      const end = ma(start, FRAMETIME, pr.velocity);
      const entities = [];
      for (const q of this.players.values()) {
        if (q.dead) continue;
        // Q3: a missile can't hit its owner for the first 1000ms? No: owner is skipped via passent until it leaves; here skip owner while overlapping at spawn only.
        if (q.id === pr.owner && this.time - pr.spawnTime < 50) continue;
        entities.push({ id: q.id, origin: q.ps.origin, mins: q.mins, maxs: q.maxs });
      }
      const tr = traceBox(this.world, start, end, [0, 0, 0], [0, 0, 0], entities, { skipFlags: BRUSH_FLAGS.PLAYERCLIP });
      pr.origin = copy(tr.endpos);
      if (tr.fraction < 1 || tr.allsolid) {
        this.explodeProjectile(pr, tr, owner);
        continue;
      }
      if (this.time - pr.spawnTime > pr.lifetime) { this.projectiles.delete(pr.id); continue; }
      // lava kills projectiles? no (Q3 rockets fly over lava). Out of bounds cleanup:
      const b = this.map.bounds;
      if (b && (pr.origin[2] < b.mins[2] - 512 || pr.origin[2] > b.maxs[2] + 2048)) this.projectiles.delete(pr.id);
    }
  }

  explodeProjectile(pr, tr, owner) {
    const wd = WEAPON_DEFS[pr.type];
    this.projectiles.delete(pr.id);
    const normal = tr.plane ? copy(tr.plane.n) : [0, 0, 1];
    const dir = normalize(pr.velocity);
    let hitPlayer = null;
    if (tr.entity) {
      hitPlayer = this.players.get(tr.entity.id);
      if (hitPlayer) this.damage(hitPlayer, owner, wd.damage, dir, tr.endpos, pr.type, 0);
    }
    // Q3: explosion origin backed off along the normal slightly to avoid being inside the wall
    const origin = ma(pr.origin, 1, normal);
    this.events.push({ type: EV.EXPLODE, weapon: pr.type, origin: copy(origin), normal, id: pr.owner, projectile: pr.id, onPlayer: !!hitPlayer });
    if (wd.splashDamage) this.radiusDamage(origin, owner, wd.splashDamage, wd.splashRadius, hitPlayer, pr.type);
  }

  radiusDamage(origin, attacker, damage, radius, ignore, mod) {
    for (const q of this.players.values()) {
      if (q.dead || q === ignore) continue;
      // distance from explosion to the closest point of the player's box (G_RadiusDamage)
      const v = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        const mn = q.ps.origin[i] + q.mins[i], mx = q.ps.origin[i] + q.maxs[i];
        if (origin[i] < mn) v[i] = mn - origin[i]; else if (origin[i] > mx) v[i] = origin[i] - mx; else v[i] = 0;
      }
      const d = length(v);
      if (d >= radius) continue;
      const points = damage * (1 - d / radius);
      if (!this.canDamage(q, origin)) continue;
      // push the center of mass higher than the origin so players get knocked into the air more
      const dir = sub(q.ps.origin, origin);
      dir[2] += 24;
      this.damage(q, attacker, points, dir, origin, mod, 1);
    }
  }

  // Line of sight from explosion to any corner/center of the box (G_CanDamage)
  canDamage(q, origin) {
    const o = q.ps.origin;
    const pts = [o, [o[0] + 15, o[1] + 15, o[2]], [o[0] - 15, o[1] + 15, o[2]], [o[0] + 15, o[1] - 15, o[2]], [o[0] - 15, o[1] - 15, o[2]]];
    for (const p of pts) {
      const tr = traceBox(this.world, origin, p, [0, 0, 0], [0, 0, 0], null, { skipFlags: BRUSH_FLAGS.PLAYERCLIP });
      if (tr.fraction === 1) return true;
    }
    return false;
  }

  // G_Damage port. dflags: 1 = radius
  damage(target, attacker, damage, dir, point, mod, dflags) {
    if (!target || target.dead) return;
    if (this.match.state === 'countdown' || this.match.state === 'ended') return;
    if (this.mode === 'arena' && this.match.roundState !== 'live') return;
    let knockback = damage;
    if (knockback > PM.maxKnockback) knockback = PM.maxKnockback;
    if (mod === 'fall' || mod === 'lava') knockback = 0;
    if (knockback && dir) {
      const d = normalize(dir);
      const mass = PM.mass;
      const kvel = scale(d, (PM.knockback * knockback) / mass);
      target.ps.velocity = add(target.ps.velocity, kvel);
      // set the timer so that the other client can't cancel out the movement immediately
      if (!target.ps.pmTime) {
        let t = knockback * 2;
        if (t < 50) t = 50; if (t > 200) t = 200;
        target.ps.pmTime = t;
        target.ps.pmFlags |= PMF.TIME_KNOCKBACK;
      }
    }
    if (attacker === target) damage *= SELF_DAMAGE_SCALE;
    damage = Math.round(damage);
    if (damage < 1) damage = 1;
    let take = damage;
    // armor
    let asave = Math.ceil(damage * ARMOR_PROTECTION);
    if (asave >= target.armor) asave = target.armor;
    target.armor -= asave;
    take -= asave;
    if (take <= 0 && asave <= 0) return;
    target.health -= take;
    target.damageTaken += take + asave;
    target.lastPain = this.time;
    if (attacker && attacker !== target) { attacker.damageDealt += take + asave; attacker.hits++; }
    this.events.push({ type: EV.PAIN, id: target.id, attacker: attacker ? attacker.id : 0, damage: take + asave, health: target.health, origin: copy(target.ps.origin), mod, self: attacker === target });
    if (attacker && attacker !== target) this.events.push({ type: EV.HIT, id: attacker.id, target: target.id, damage: take + asave, origin: copy(point) });
    if (target.health <= 0) this.killPlayer(target, attacker, mod, take + asave);
  }

  killPlayer(target, attacker, mod, lastDamage = 0) {
    if (target.dead) return;
    target.dead = true; target.deathTime = this.time; target.deaths++;
    target.lastDeathOrigin = copy(target.ps.origin);
    target.killer = attacker ? attacker.id : 0;
    target.maxs = [15, 15, 8];
    if (attacker && attacker !== target) attacker.frags++; else target.frags--; // suicide/world = -1 like Q3
    const gib = target.health <= -40; // Q3 GIB_HEALTH -40
    this.events.push({ type: EV.DEATH, id: target.id, attacker: attacker ? attacker.id : 0, mod, origin: copy(target.ps.origin), gib, frags: { [target.id]: target.frags, ...(attacker ? { [attacker.id]: attacker.frags } : {}) } });
    if (this.mode === 'arena') this.onArenaKill(target, attacker);
    if (this.mode === 'duel' && this.match.state === 'playing' && this.match.overtime) this.endMatch(attacker && attacker !== target ? attacker : this.other(target));
    if (this.mode === 'duel' && this.match.state === 'playing' && this.rules.fraglimit && attacker && attacker.frags >= this.rules.fraglimit) this.endMatch(attacker);
  }

  // ---------- items ----------
  runItems() {
    for (const it of this.items) {
      if (!it.available && this.time >= it.respawnAt) {
        it.available = true;
        this.events.push({ type: EV.ITEM_RESPAWN, item: it.index, itemType: it.type, origin: copy(it.origin) });
      }
    }
    // health/armor decay over max (ClientTimerActions, once per second)
    for (const p of this.players.values()) {
      if (p.dead) continue;
      if (this.time >= p.healthDecayAt) {
        p.healthDecayAt += HEALTH.decayInterval;
        if (p.health > HEALTH.max) p.health--;
        if (p.armor > HEALTH.max && this.mode === 'duel') p.armor--;
      }
    }
  }

  // ---------- match ----------
  humanCount() { let n = 0; for (const p of this.players.values()) n++; return n; }
  runMatch() {
    const m = this.match;
    const n = this.players.size;
    if (this.mode === 'duel') {
      if (m.state === 'warmup') {
        if (n >= 2) { m.state = 'countdown'; m.countdownAt = this.time + this.rules.warmup; this.events.push({ type: EV.COUNTDOWN, seconds: Math.ceil(this.rules.warmup / 1000) }); }
      } else if (m.state === 'countdown') {
        if (n < 2) { m.state = 'warmup'; return; }
        const left = m.countdownAt - this.time;
        const sec = Math.ceil(left / 1000);
        if (sec !== m.lastCountdown && sec > 0) { m.lastCountdown = sec; this.events.push({ type: EV.COUNTDOWN, seconds: sec }); }
        if (left <= 0) this.startMatch();
      } else if (m.state === 'playing') {
        if (n < 2) { /* opponent left: keep playing as practice; match ends when time runs out */ }
        const elapsed = this.time - m.startTime;
        if (!m.overtime && this.rules.timelimit && elapsed >= this.rules.timelimit) {
          const ps = [...this.players.values()];
          if (ps.length >= 2 && ps[0].frags === ps[1].frags) { m.overtime = true; this.events.push({ type: EV.MAJOR_WARN, text: 'OVERTIME: sudden death' }); }
          else this.endMatch(ps.sort((a, b) => b.frags - a.frags)[0]);
        }
        // one-minute / major-item warnings for the timer are client-side
      } else if (m.state === 'ended') {
        if (this.time >= m.endTime + 12000) this.resetMatch();
      }
    } else {
      // arena: round based
      if (m.state === 'waiting') {
        if (n >= 2) { m.state = 'playing'; m.round = 0; m.roundWins = {}; for (const p of this.players.values()) m.roundWins[p.id] = 0; this.beginRoundRest(1500); }
      } else if (m.state === 'playing') {
        if (n < 2) { m.state = 'waiting'; return; }
        if (m.roundState === 'rest' && this.time >= m.roundEndAt) this.startRound();
        else if (m.roundState === 'live') {
          if (this.time - m.roundStart >= this.rules.roundTimelimit) {
            // timeout: higher health+armor wins, else draw
            const ps = [...this.players.values()];
            const s = (p) => p.health + p.armor;
            const w = s(ps[0]) === s(ps[1]) ? null : (s(ps[0]) > s(ps[1]) ? ps[0] : ps[1]);
            this.endRound(w);
          }
        }
      } else if (m.state === 'ended') {
        if (this.time >= m.endTime + 12000) this.resetMatch();
      }
    }
  }
  startMatch() {
    const m = this.match;
    m.state = 'playing'; m.startTime = this.time; m.overtime = false; m.winner = null;
    for (const it of this.items) { it.available = true; it.respawnAt = 0; }
    for (const p of this.players.values()) { p.frags = 0; p.deaths = 0; p.damageDealt = 0; p.damageTaken = 0; p.hits = 0; p.shots = 0; this.spawnPlayer(p, true); }
    this.events.push({ type: EV.MATCH_START });
  }
  endMatch(winner) {
    const m = this.match;
    if (m.state === 'ended') return;
    m.state = 'ended'; m.endTime = this.time; m.winner = winner ? winner.id : null;
    this.events.push({ type: EV.MATCH_END, winner: m.winner, scores: Object.fromEntries([...this.players.values()].map((p) => [p.id, { frags: p.frags, deaths: p.deaths, dmg: p.damageDealt, acc: p.shots ? p.hits / p.shots : 0 }])) });
  }
  resetMatch() {
    this.match = { state: this.mode === 'arena' ? 'waiting' : 'warmup', startTime: 0, endTime: 0, winner: null, overtime: false, round: 0, roundState: 'idle', roundEndAt: 0, roundWins: {}, countdownAt: 0 };
    for (const p of this.players.values()) { p.frags = 0; p.deaths = 0; this.spawnPlayer(p, true); }
  }
  beginRoundRest(ms) { this.match.roundState = 'rest'; this.match.roundEndAt = this.time + ms; }
  startRound() {
    const m = this.match;
    m.round++; m.roundState = 'live'; m.roundStart = this.time;
    for (const p of this.players.values()) this.spawnPlayer(p, true);
    this.events.push({ type: EV.ROUND_START, round: m.round });
  }
  onArenaKill(target, attacker) {
    if (this.match.roundState !== 'live') return;
    const w = attacker && attacker !== target ? attacker : this.other(target);
    this.endRound(w);
  }
  endRound(winner) {
    const m = this.match;
    m.roundState = 'over';
    if (winner) m.roundWins[winner.id] = (m.roundWins[winner.id] || 0) + 1;
    this.events.push({ type: EV.ROUND_END, round: m.round, winner: winner ? winner.id : null, wins: { ...m.roundWins } });
    const need = Math.ceil(this.rules.rounds / 2) + 0; // first to majority (e.g. 6 of 10)
    if (winner && m.roundWins[winner.id] >= Math.max(1, Math.floor(this.rules.rounds / 2) + 1)) { this.endMatch(winner); return; }
    this.beginRoundRest(this.rules.roundRest);
  }

  // ---------- snapshots ----------
  snapshot(forId = null) {
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id, n: p.name, o: p.ps.origin, v: p.ps.velocity, a: [p.ps.viewangles[0], p.ps.viewangles[1]], h: p.health, ar: p.armor, w: p.weapon, pw: p.pendingWeapon,
        ws: p.weaponState, wt: p.weaponTime, d: p.dead ? 1 : 0, f: p.frags, dt: p.deaths, pf: p.ps.pmFlags, pt: p.ps.pmTime, g: p.ps.groundEntity ? 1 : 0,
        vh: p.ps.viewHeight, wp: p.weapons, am: p.ammo, ack: p.lastCmdSeq, ah: p.attackHeld ? 1 : 0, bot: p.isBot ? 1 : 0, ping: p.ping, ts: p.teleportSeq || 0,
        dd: p.damageDealt, hits: p.hits, shots: p.shots, jt: p.ps.jumpPadTime, hd: p.healthDecayAt, dth: p.deathTime,
      });
    }
    const projectiles = [];
    for (const pr of this.projectiles.values()) projectiles.push({ id: pr.id, t: pr.type, o: pr.origin, v: pr.velocity, ow: pr.owner, sq: pr.seq });
    const items = this.items.map((it) => (it.available ? 1 : it.respawnAt));
    return { t: this.time, tick: this.tick, players, projectiles, items, match: this.match, ev: this.events };
  }

  // Apply an authoritative snapshot to this (client-side) game so prediction can replay from it.
  applySnapshot(snap, localId) {
    this.time = snap.t; this.tick = snap.tick;
    const seen = new Set();
    for (const sp of snap.players) {
      seen.add(sp.id);
      let p = this.players.get(sp.id);
      if (!p) { p = this.addPlayer(sp.id, sp.n); p.dead = true; }
      p.name = sp.n;
      p.ps.origin = copy(sp.o); p.ps.velocity = copy(sp.v); p.ps.viewangles = [sp.a[0], sp.a[1], 0];
      p.health = sp.h; p.armor = sp.ar; p.weapon = sp.w; p.pendingWeapon = sp.pw; p.weaponState = sp.ws; p.weaponTime = sp.wt;
      p.dead = !!sp.d; p.frags = sp.f; p.deaths = sp.dt; p.ps.pmFlags = sp.pf; p.ps.pmTime = sp.pt; p.ps.groundEntity = !!sp.g; p.ps.viewHeight = sp.vh;
      p.weapons = sp.wp; p.ammo = { ...sp.am }; p.lastCmdSeq = sp.ack; p.attackHeld = !!sp.ah; p.isBot = !!sp.bot; p.ping = sp.ping; p.teleportSeq = sp.ts;
      p.damageDealt = sp.dd; p.hits = sp.hits; p.shots = sp.shots; p.ps.jumpPadTime = sp.jt; p.healthDecayAt = sp.hd; p.deathTime = sp.dth;
      p.origin = p.ps.origin; p.mins = PM.mins; p.maxs = p.dead ? [15, 15, 8] : ((p.ps.pmFlags & PMF.DUCKED) ? PM.duckMaxs : PM.maxs);
    }
    for (const id of [...this.players.keys()]) if (!seen.has(id)) this.players.delete(id);
    this.projectiles.clear();
    for (const sp of snap.projectiles) this.projectiles.set(sp.id, { id: sp.id, type: sp.t, owner: sp.ow, origin: copy(sp.o), velocity: copy(sp.v), seq: sp.sq, spawnTime: 0 });
    for (let i = 0; i < this.items.length; i++) { const v = snap.items[i]; this.items[i].available = v === 1; this.items[i].respawnAt = v === 1 ? 0 : v; }
    this.match = snap.match;
  }
}

export function boxesOverlap(o1, mn1, mx1, o2, mn2, mx2) {
  for (let i = 0; i < 3; i++) if (o1[i] + mx1[i] < o2[i] + mn2[i] || o1[i] + mn1[i] > o2[i] + mx2[i]) return false;
  return true;
}
export function boxesOverlapAbs(o, mn, mx, amin, amax) {
  for (let i = 0; i < 3; i++) if (o[i] + mx[i] < amin[i] || o[i] + mn[i] > amax[i]) return false;
  return true;
}
function sampleHistory(history, t) {
  if (!history.length) return null;
  if (t <= history[0].time) return history[0];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].time <= t) {
      const a = history[i], b = history[i + 1];
      if (!b) return a;
      const f = (t - a.time) / (b.time - a.time || 1);
      return { origin: [a.origin[0] + (b.origin[0] - a.origin[0]) * f, a.origin[1] + (b.origin[1] - a.origin[1]) * f, a.origin[2] + (b.origin[2] - a.origin[2]) * f], mins: a.mins, maxs: a.maxs };
    }
  }
  return history[history.length - 1];
}
