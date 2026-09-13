// Bot AI: navigation over map nav nodes, item timing, weapon selection by range and human-like aim/movement.
// Runs in-process on the server (or in the browser host) and drives a player through Game.queueCommand.
//
// Skill (0..1) scales reaction time, aim error, turn speed and target leading. Everything the bot does is built from
// the same commands a human sends (no direct state changes), so it obeys the same physics and weapon rules.
import { WEAPONS, WEAPON_DEFS, BUTTONS, PM, TICK_MS } from './constants.js';
import { traceBox } from './trace.js';
import { angleVectors, vectorToAngles, sub, dot, dist, normalize, length, ma, copy, makeRng, normalizeAngle } from './vec3.js';
import { BRUSH_FLAGS } from './map.js';

const W = WEAPONS;
const RANGE_CLOSE = 360, RANGE_MIDFAR = 520, RANGE_FAR = 760;
// weapon preference by engagement range (Q3 bot "fuzzy" weights, simplified)
const PREFS = {
  close: [W.LIGHTNING, W.SHOTGUN, W.PLASMA, W.ROCKET, W.MACHINEGUN],
  mid: [W.ROCKET, W.LIGHTNING, W.RAIL, W.PLASMA, W.SHOTGUN, W.MACHINEGUN],
  midfar: [W.RAIL, W.ROCKET, W.LIGHTNING, W.PLASMA, W.MACHINEGUN, W.SHOTGUN],
  far: [W.RAIL, W.ROCKET, W.PLASMA, W.MACHINEGUN, W.LIGHTNING, W.SHOTGUN],
};
// how well the crosshair must be on target before pulling the trigger (deg)
const FIRE_TOL = { [W.GAUNTLET]: 20, [W.MACHINEGUN]: 5, [W.SHOTGUN]: 6, [W.ROCKET]: 7, [W.LIGHTNING]: 4, [W.RAIL]: 1.6, [W.PLASMA]: 6 };

export class Bot {
  constructor(game, player, opts = {}) {
    this.game = game; this.p = player;
    const s = this.skill = Math.max(0, Math.min(1, opts.skill ?? 0.7));
    this.rng = makeRng(opts.seed ?? 1);
    this.seq = 0;
    this.yaw = player.ps.viewangles[1]; this.pitch = 0;
    // skill-derived parameters. The menu tiers are Easy 0.3 / Normal 0.6 / Hard 0.8 / Pro 0.95 (BOT_TIERS):
    //   reaction  420 / 300 / 220 / 160 ms      aim error 6.6 / 4.2 / 2.6 / 1.4 deg      rail tolerance +1.4 / +0.8 / +0.4 / +0.1 deg
    //   dodge     25 / 55 / 75 / 90 %           strafe flips every 1.2-2.4 / 0.75-1.6 / 0.55-1.25 / 0.4-1.0 s, jumps 1 / 2 / 3 / 4 %/tick
    this.reaction = 540 - 400 * s;        // ms from first sight to first shot
    this.aimError = 9 - 8 * s;            // deg amplitude of the wandering aim offset (perception + motor error)
    this.dodgeChance = 0.05 + 0.9 * s;    // chance to react to an incoming rocket at all
    this.turnRate = 0.12 + 0.4 * s;       // fraction of the remaining angle closed per tick (tracking lag on a strafing target)
    this.maxTurn = 8 + 28 * s;            // deg per tick cap (mouse speed)
    this.leadQuality = 0.4 + 0.6 * s;     // fraction of ideal projectile lead
    this.trackLag = 0.02 + 0.14 * (1 - s); // s: the crosshair trails a strafing target (the main human miss source)
    this.railSlack = 2 * (1 - s) * (1 - s); // deg added to the rail trigger tolerance (a Pro waits for a settled crosshair)
    this.strafeBase = 300 + 900 * (1 - s); this.strafeSpread = 600 + 600 * (1 - s); // ms between strafe direction changes
    this.jumpChance = 0.006 + 0.04 * s;   // per-tick chance to hop while strafing (more when hurt)
    this.favorite = [W.ROCKET, W.LIGHTNING, W.RAIL][Math.floor(this.rng() * 3)]; // personality
    // state
    this.goal = null; this.goalItem = null; this.path = []; this.pathIdx = 0; this.repathAt = 0; this.campUntil = 0;
    this.strafeDir = 1; this.strafeUntil = 0; this.jumpHeld = false; this.lastJumpAt = -1e9;
    this.lastSeen = -1e9; this.firstSeen = 0; this.enemyLastPos = null; this.enemyLastVel = [0, 0, 0];
    this.aimOff = [0, 0]; // wandering aim error (pitch, yaw)
    this.weaponChosen = 0; this.weaponChangedAt = -1e9;
    this.stuckTicks = 0; this.lastPos = copy(player.ps.origin); this.sidestepUntil = 0; this.sidestepDir = 1;
    this.sjSide = 1; this.dodgeUntil = 0; this.dodgeDir = null;
    this.nav = opts.nav || buildNavGraph(game);
    this.stats = { strafeJumps: 0, dodges: 0, camps: 0, repaths: 0, unstuck: 0, visibleTicks: 0, engagedTicks: 0, fireTicks: 0 };
  }

  think() {
    const g = this.game, p = this.p, now = g.time;
    if (p.dead) {
      // respawn: press attack once the minimum delay has passed (like a human tapping fire)
      this.queue({ forward: 0, right: 0, up: 0, buttons: now - p.deathTime >= (g.rules.respawnMin || 0) ? BUTTONS.ATTACK : 0, angles: [0, this.yaw, 0], weapon: 0 });
      this.goal = null; this.path = []; this.campUntil = 0; this.stuckTicks = 0;
      return;
    }
    const enemy = g.other(p);
    const eye = [p.ps.origin[0], p.ps.origin[1], p.ps.origin[2] + p.ps.viewHeight];
    const visible = this.perceive(enemy, eye);

    if (now >= this.repathAt || !this.goal) this.pickGoal(enemy, visible);
    const nav = this.followPath(now, visible);
    let moveDir = nav.moveDir, wantJump = nav.wantJump;

    // --- combat ---
    let wantFire = false;
    const weapon = this.chooseWeapon(enemy, visible);
    const wd = WEAPON_DEFS[p.weapon];
    const engaged = enemy && !enemy.dead && visible && now - this.firstSeen >= this.reaction;
    if (visible) this.stats.visibleTicks++;
    if (engaged) {
      this.stats.engagedTicks++;
      const d = dist(enemy.ps.origin, p.ps.origin);
      wantFire = this.aimAt(enemy, eye, wd, d);
      const cm = this.combatMove(enemy, d, wd, nav, now);
      if (cm.moveDir) moveDir = cm.moveDir;
      if (cm.wantJump) wantJump = true;
    } else if (enemy && !enemy.dead && this.enemyLastPos && now - this.lastSeen < 2500 && !visible) {
      // lost sight: keep looking where the enemy was heading while moving
      const look = ma(this.enemyLastPos, 0.3, this.enemyLastVel);
      this.turnToward(vectorToAngles(sub(look, eye)), 0.6);
    } else if (moveDir) {
      // look where we're going (a little ahead along the path)
      const n2 = this.path[this.pathIdx + 1];
      const look = n2 && dist(n2.origin, p.ps.origin) < 500 ? normalize(sub(n2.origin, p.ps.origin)) : moveDir;
      this.turnToward([0, vectorToAngles(look)[1], 0], 0.35);
    }
    // dodge incoming rockets/plasma even when not engaged
    const dodge = this.dodgeProjectiles(now);
    if (dodge) { moveDir = dodge.moveDir; if (dodge.wantJump) wantJump = true; }

    // --- stuck recovery: jump, then sidestep, then a new goal ---
    if (moveDir && dist(p.ps.origin, this.lastPos) < 1.5 && p.ps.groundEntity) this.stuckTicks++; else if (!moveDir || dist(p.ps.origin, this.lastPos) >= 1.5) this.stuckTicks = 0;
    this.lastPos = copy(p.ps.origin);
    if (this.stuckTicks > 24) wantJump = true;
    if (this.stuckTicks > 60 && now > this.sidestepUntil) { this.sidestepUntil = now + 500; this.sidestepDir = this.rng() < 0.5 ? -1 : 1; this.stats.unstuck++; }
    if (this.stuckTicks > 120) { this.repathAt = 0; this.goal = null; this.stuckTicks = 0; this.blockedGoal = this.goal; }
    if (now < this.sidestepUntil && moveDir) moveDir = normalize([-moveDir[1] * this.sidestepDir, moveDir[0] * this.sidestepDir, 0]);

    // --- convert world moveDir into forward/right relative to yaw ---
    let forward = 0, right = 0;
    if (moveDir) {
      const av = angleVectors([0, this.yaw, 0]);
      const f = dot(moveDir, [av.forward[0], av.forward[1], 0]);
      const r = dot(moveDir, [av.right[0], av.right[1], 0]);
      const m = Math.max(Math.abs(f), Math.abs(r), 1e-6);
      forward = Math.round(127 * f / m); right = Math.round(127 * r / m);
    }
    if (nav.strafeJump && !engaged) { forward = 127; right = 127 * this.sjSide; }
    let buttons = 0;
    if (wantFire) { buttons |= BUTTONS.ATTACK; this.stats.fireTicks++; }
    if (wantJump && !this.jumpHeld && p.ps.groundEntity) { buttons |= BUTTONS.JUMP; this.jumpHeld = true; this.lastJumpAt = now; } else this.jumpHeld = false;
    this.queue({ forward, right, up: 0, buttons, angles: [this.pitch, this.yaw, 0], weapon });
  }

  // ---------- perception ----------
  perceive(enemy, eye) {
    const g = this.game, now = g.time;
    if (!enemy || enemy.dead) return false;
    const target = [enemy.ps.origin[0], enemy.ps.origin[1], enemy.ps.origin[2] + 8];
    const tr = traceBox(g.world, eye, target, [0, 0, 0], [0, 0, 0], null, { skipFlags: BRUSH_FLAGS.PLAYERCLIP });
    const visible = tr.fraction === 1;
    if (visible) {
      if (now - this.lastSeen > 600) { this.firstSeen = now; this.aimOff = [(this.rng() * 2 - 1) * this.aimError, (this.rng() * 2 - 1) * this.aimError]; }
      this.lastSeen = now; this.enemyLastPos = copy(enemy.ps.origin); this.enemyLastVel = copy(enemy.ps.velocity);
    } else if (dist(enemy.ps.origin, eye) < 1300 && (Math.hypot(enemy.ps.velocity[0], enemy.ps.velocity[1]) > 150 || now - enemy.lastPain < 300)) {
      // hearing: footsteps / weapon noise nearby give away a rough position (Q3 bots react to sounds too)
      this.enemyLastPos = [enemy.ps.origin[0] + (this.rng() - 0.5) * 120, enemy.ps.origin[1] + (this.rng() - 0.5) * 120, enemy.ps.origin[2]];
      this.enemyLastVel = copy(enemy.ps.velocity);
      this.lastHeard = now;
    }
    return visible;
  }

  // ---------- aiming ----------
  turnToward(desired, rate = this.turnRate) {
    const dy = normalizeAngle(desired[1] - this.yaw), dp = desired[0] - this.pitch;
    const k = Math.min(1, rate);
    const stepY = Math.max(-this.maxTurn, Math.min(this.maxTurn, dy * k));
    const stepP = Math.max(-this.maxTurn, Math.min(this.maxTurn, dp * k));
    this.yaw = normalizeAngle(this.yaw + stepY);
    this.pitch = Math.max(-85, Math.min(85, this.pitch + stepP));
    return [dp - stepP, dy - stepY];
  }
  aimAt(enemy, eye, wd, d) {
    const p = this.p, now = this.game.time;
    // aim point: chest for hitscan; for rockets the feet when the enemy is grounded (splash), leading by flight time
    let aimAt = ma([enemy.ps.origin[0], enemy.ps.origin[1], enemy.ps.origin[2] + 4], -this.trackLag, enemy.ps.velocity);
    if (wd.projectile) {
      const t = d / wd.speed;
      aimAt = ma(aimAt, t * this.leadQuality, enemy.ps.velocity);
      if (p.weapon === W.ROCKET && enemy.ps.groundEntity && d < 700) aimAt[2] = enemy.ps.origin[2] - 20;
    }
    // wandering aim error: a random walk with restoring force, amplitude shrinks the longer the target is tracked
    const settle = 1 - 0.5 * Math.min(1, (now - this.firstSeen) / 1200);
    for (let i = 0; i < 2; i++) { this.aimOff[i] += (this.rng() * 2 - 1) * this.aimError * 0.35; this.aimOff[i] *= 0.9; }
    const desired = vectorToAngles(sub(aimAt, eye));
    const target = [desired[0] + this.aimOff[0] * settle * 0.6, desired[1] + this.aimOff[1] * settle, 0];
    this.turnToward(target);
    // Trigger discipline (human model): the bot fires when its crosshair is within tolerance of where it BELIEVES the
    // target is (the perceived point, wander included), not of the true position. Misses therefore come from the
    // perception error, the tracking lag and the turn-rate cap, which is what makes its accuracy human-like.
    const errY = Math.abs(normalizeAngle(target[1] - this.yaw)), errP = Math.abs(target[0] - this.pitch);
    const err = Math.hypot(errY, errP);
    const tol = FIRE_TOL[p.weapon] || 5;
    const inRange = wd.melee ? d < 64 : (!wd.range || wd.range > 4000 || d < wd.range - 32);
    if (!inRange) return false;
    // rockets at long range against a moving target are wasted ammo (0.8 s flight): hold fire unless close or the target is slow
    if (p.weapon === W.ROCKET && d > 620 && Math.hypot(enemy.ps.velocity[0], enemy.ps.velocity[1]) > 120) return false;
    if (p.weapon === W.RAIL) return err < tol + this.railSlack; // the rail needs a settled aim
    // hitscan sprayers / plasma: keep the trigger down while roughly on target (humans track while firing)
    return err < tol + 4 * (1 - this.skill);
  }

  chooseWeapon(enemy, visible) {
    const p = this.p, now = this.game.time;
    const has = (w) => (p.weapons & (1 << w)) && (p.ammo[w] === -1 || (p.ammo[w] || 0) > 0);
    const d = enemy && !enemy.dead ? dist(enemy.ps.origin, p.ps.origin) : 600;
    const prefs = [...(d < RANGE_CLOSE ? PREFS.close : d < RANGE_MIDFAR ? PREFS.mid : d < RANGE_FAR ? PREFS.midfar : PREFS.far)];
    // personality: a favorite weapon moves up one rank
    const fi = prefs.indexOf(this.favorite); if (fi > 0) { prefs.splice(fi, 1); prefs.splice(fi - 1, 0, this.favorite); }
    let best = W.GAUNTLET;
    for (const w of prefs) if (has(w)) { best = w; break; }
    // hysteresis: keep the current weapon for a moment (switching costs 450 ms) unless it is empty
    if (this.weaponChosen && has(this.weaponChosen) && now - this.weaponChangedAt < 1500 && best !== this.weaponChosen) return this.weaponChosen;
    if (best !== this.weaponChosen) { this.weaponChosen = best; this.weaponChangedAt = now; }
    return best;
  }

  // ---------- combat movement ----------
  combatMove(enemy, d, wd, nav, now) {
    const p = this.p;
    const toEnemy = normalize([enemy.ps.origin[0] - p.ps.origin[0], enemy.ps.origin[1] - p.ps.origin[1], 0]);
    const perp = [-toEnemy[1], toEnemy[0], 0];
    // strafe direction changes at human-ish intervals, and flips early when the way is blocked
    if (now > this.strafeUntil) { this.strafeDir = this.rng() < 0.5 ? -1 : 1; this.strafeUntil = now + this.strafeBase + this.rng() * this.strafeSpread; }
    const probe = ma(p.ps.origin, 56 * this.strafeDir, perp);
    const tr = traceBox(this.game.world, p.ps.origin, probe, PM.mins, PM.maxs, null, { skipFlags: 0 });
    if (tr.fraction < 1) { this.strafeDir *= -1; this.strafeUntil = now + 400 + this.rng() * 600; }
    // range control by weapon
    let toward = 0;
    if (p.weapon === W.LIGHTNING || p.weapon === W.SHOTGUN || wd.melee) toward = d > 260 ? 1 : (d < 120 ? -0.4 : 0);
    else if (p.weapon === W.RAIL) toward = d < 380 ? -1 : (d > 1100 ? 0.6 : 0);
    else if (p.weapon === W.ROCKET) toward = d < 240 ? -0.8 : (d > 700 ? 0.7 : 0);
    else toward = d > 600 ? 0.5 : 0;
    // an urgent item goal (a major about to spawn) keeps the bot moving along its path while fighting
    let moveDir;
    if (nav.moveDir && this.goalUrgent && !wd.melee) moveDir = normalize(ma(nav.moveDir, 0.7 * this.strafeDir, perp));
    else moveDir = normalize(ma([perp[0] * this.strafeDir, perp[1] * this.strafeDir, 0], toward, toEnemy));
    // jump now and then while strafing (harder to hit, rocket-jump-like unpredictability), more when hurt
    const hurtRecently = now - p.lastPain < 400;
    const wantJump = p.ps.groundEntity && (this.rng() < this.jumpChance * (hurtRecently ? 2.5 : 1));
    return { moveDir, wantJump };
  }

  dodgeProjectiles(now) {
    const p = this.p;
    if (now < this.dodgeUntil && this.dodgeDir) return { moveDir: this.dodgeDir, wantJump: false };
    for (const pr of this.game.projectiles.values()) {
      if (pr.owner === p.id) continue;
      const rel = sub(p.ps.origin, pr.origin);
      const v = pr.velocity; const vv = dot(v, v); if (!vv) continue;
      const t = dot(rel, v) / vv; // time to closest approach
      if (t < 0 || t > 0.55) continue; // humans react late: only when the rocket is about half a second out
      const closest = sub(rel, [v[0] * t, v[1] * t, v[2] * t]);
      if (length(closest) > 170) continue;
      // decide once per projectile whether we notice it at all (skill)
      if (this.seenProjectile !== pr.id) { this.seenProjectile = pr.id; this.noticed = this.rng() < this.dodgeChance; }
      if (!this.noticed) continue;
      // move away from the closest-approach point, perpendicular to the flight path
      let away = [closest[0], closest[1], 0];
      if (length(away) < 8) away = [-v[1], v[0], 0];
      this.dodgeDir = normalize(away); this.dodgeUntil = now + 300; this.stats.dodges++;
      return { moveDir: this.dodgeDir, wantJump: t < 0.45 && p.ps.groundEntity };
    }
    return null;
  }

  // ---------- goals ----------
  pickGoal(enemy, visible) {
    const g = this.game, p = this.p, now = g.time;
    this.repathAt = now + 1200 + this.rng() * 1300;
    this.stats.repaths++;
    const hp = p.health + p.armor;
    const weak = hp < 70;
    let best = null, bestScore = -Infinity, bestItem = null, bestUrgent = false;
    for (const it of g.items) {
      const def = it.def;
      let want = 0;
      if (def.kind === 'health') want = def.max > 100 ? Math.max(0, (200 - p.health) / 100) * 1.3 : Math.max(0, (100 - p.health) / 100) * (def.amount / 40);
      else if (def.kind === 'armor') want = Math.max(0, (200 - p.armor) / 200) * (def.amount / 45);
      else if (def.kind === 'weapon') want = (p.weapons & (1 << def.weapon)) ? ((p.ammo[def.weapon] || 0) < 5 ? 0.6 : 0.08) : (def.major ? 1.6 : 1.1);
      else if (def.kind === 'ammo') want = (p.weapons & (1 << def.weapon)) ? Math.max(0, 1 - (p.ammo[def.weapon] || 0) / 25) * 0.7 : 0;
      if (def.major) want += 0.45;
      if (weak && (def.kind === 'health' || def.kind === 'armor')) want *= 1.6;
      const d = dist(it.origin, p.ps.origin);
      const travel = d / 300 * 1000;
      let urgent = false;
      if (!it.available) {
        const wait = it.respawnAt - now;
        if (wait > travel + 3500) continue; // too early: something else first
        if (def.major) { want *= 1.1; urgent = wait < travel + 1500; } else want *= 0.5;
      }
      if (it === this.blockedGoal) want *= 0.2;
      const score = want / (1 + d / 900) + this.rng() * 0.12;
      if (score > bestScore) { bestScore = score; best = it.origin; bestItem = it; bestUrgent = urgent; }
    }
    // hunting: chase a visible enemy when strong or when nothing is worth more; go to the last known position otherwise
    if (enemy && !enemy.dead) {
      const strong = hp > (enemy.health + enemy.armor) + 40 || hp > 220;
      if (visible && !weak && !(bestUrgent && !strong) && bestScore < 2.2) { best = copy(enemy.ps.origin); bestItem = null; bestUrgent = false; this.repathAt = now + 500 + this.rng() * 500; }
      else if (!visible && this.enemyLastPos && now - Math.max(this.lastSeen, this.lastHeard || -1e9) < 5000 && !bestUrgent && !weak && bestScore < 1.9) { best = copy(this.enemyLastPos); bestItem = null; bestUrgent = false; }
    }
    if (!best) { const n = this.nav.nodes; best = n.length ? n[Math.floor(this.rng() * n.length)].origin : p.ps.origin; bestItem = null; }
    this.goal = best; this.goalItem = bestItem; this.goalUrgent = bestUrgent;
    this.path = findPath(this.nav, p.ps.origin, best);
    this.pathIdx = 0;
    this.smoothPath();
  }

  // Skip path nodes that are directly reachable (line sweep at player height, no big height change).
  smoothPath() {
    const p = this.p;
    while (this.pathIdx + 1 < this.path.length) {
      const n = this.path[this.pathIdx + 1];
      if (Math.abs(n.origin[2] - p.ps.origin[2]) > 32 || dist(n.origin, p.ps.origin) > 700 || this.path[this.pathIdx].jump) break;
      const tr = traceBox(this.game.world, p.ps.origin, [n.origin[0], n.origin[1], p.ps.origin[2]], PM.mins, PM.maxs, null, { skipFlags: 0 });
      if (tr.fraction < 1) break;
      // make sure there is floor along the way (no pit): sample midpoint
      const mid = [(p.ps.origin[0] + n.origin[0]) / 2, (p.ps.origin[1] + n.origin[1]) / 2, p.ps.origin[2]];
      const down = traceBox(this.game.world, mid, [mid[0], mid[1], mid[2] - 64], PM.mins, PM.maxs, null, { skipFlags: 0 });
      if (down.fraction === 1) break;
      this.pathIdx++;
    }
  }

  followPath(now, visible) {
    const p = this.p;
    const node = this.path[this.pathIdx];
    const out = { moveDir: null, wantJump: false, strafeJump: false };
    if (!node) {
      // arrived. Waiting for an item that is about to respawn: hover around it (camp) until it appears
      const it = this.goalItem;
      if (it && !it.available && it.respawnAt - now < 4000 && now - this.lastSeen > 800) {
        if (!this.campUntil) { this.campUntil = it.respawnAt + 200; this.stats.camps++; }
        this.repathAt = Math.min(this.repathAt, it.respawnAt + 100);
        const ang = now / 400 + this.p.id;
        const around = [it.origin[0] + Math.cos(ang) * 70 - p.ps.origin[0], it.origin[1] + Math.sin(ang) * 70 - p.ps.origin[1], 0];
        if (length(around) > 24) out.moveDir = normalize(around);
        return out;
      }
      this.campUntil = 0;
      this.repathAt = Math.min(this.repathAt, now + 200);
      return out;
    }
    const to = sub(node.origin, p.ps.origin);
    const flat = [to[0], to[1], 0];
    const d = length(flat);
    const last = this.pathIdx === this.path.length - 1;
    if (d < (last ? 24 : 40) && to[2] < 48 && to[2] > -80) { this.pathIdx++; this.smoothPath(); return this.followPath(now, visible); }
    out.moveDir = normalize(flat);
    if (p.ps.groundEntity) {
      if (node.jump && d < 90) out.wantJump = true;                 // edge marked as needing a jump (ledge or gap)
      if (to[2] > 20 && d < 90) out.wantJump = true;                 // step up onto something higher than a step
      // strafe jumping on long, open, straight segments (keeps speed above 320 like a human would)
      if (d > 280 && !visible && this.skill > 0.25 && !node.jump && Math.abs(to[2]) < 40 && now - this.lastJumpAt > 120) {
        const av = angleVectors([0, this.yaw, 0]);
        const yawErr = Math.abs(normalizeAngle(vectorToAngles(out.moveDir)[1] - this.yaw));
        if (yawErr < 12 && this.clearSides(av.right)) {
          out.strafeJump = true; out.wantJump = true;
          if (this.game.time - this.lastJumpAt > 200) { this.sjSide *= -1; this.stats.strafeJumps++; }
        }
      }
    } else if (this.sjActive && !visible) {
      // keep the strafe pattern while airborne; the view drifts slightly against the strafe so the heading stays true
      out.strafeJump = true;
    }
    this.sjActive = out.strafeJump;
    if (out.strafeJump) {
      const dir = vectorToAngles(out.moveDir)[1];
      this.yaw = normalizeAngle(this.yaw + normalizeAngle(dir - this.sjSide * 14 - this.yaw) * 0.25);
    }
    return out;
  }
  clearSides(right) {
    const p = this.p;
    for (const s of [-1, 1]) {
      const tr = traceBox(this.game.world, p.ps.origin, ma(p.ps.origin, 110 * s, [right[0], right[1], 0]), PM.mins, PM.maxs, null, { skipFlags: 0 });
      if (tr.fraction < 1) return false;
    }
    return true;
  }

  queue(c) {
    this.seq++;
    this.game.queueCommand(this.p.id, { seq: this.seq, forward: c.forward, right: c.right, up: c.up, buttons: c.buttons, angles: c.angles, weapon: c.weapon, vt: 0 });
  }
}

// ---------- navigation ----------
export function buildNavGraph(game) {
  const map = game.map;
  const pts = [];
  for (const n of map.navNodes) pts.push({ origin: copy(n.origin), jump: !!n.jump });
  for (const it of map.items) pts.push({ origin: [it.origin[0], it.origin[1], it.origin[2] + 4] });
  for (const s of map.spawns) pts.push({ origin: copy(s.origin) });
  const nodes = pts.map((p, i) => ({ ...p, i, edges: [] }));
  // connect nodes that a player can walk (or jump) between along a straight line
  for (let i = 0; i < nodes.length; i++) for (let j = 0; j < nodes.length; j++) {
    if (i === j) continue;
    const a = nodes[i].origin, b = nodes[j].origin;
    const d = dist(a, b);
    if (d > 900) continue;
    const w = walkable(game, a, b);
    if (w.ok) nodes[i].edges.push({ to: j, cost: d * (w.jump ? 1.3 : 1), jump: w.jump });
  }
  // jump pads: edge from pad to its target
  for (const t of map.triggers) {
    if (t.kind !== 'jumppad') continue;
    const padC = [(t.mins[0] + t.maxs[0]) / 2, (t.mins[1] + t.maxs[1]) / 2, t.mins[2] + 24];
    const ni = nodes.length; nodes.push({ origin: padC, i: ni, edges: [], jump: false, pad: true });
    const tj = nearestNode(nodes.slice(0, ni), t.target);
    if (tj >= 0) nodes[ni].edges.push({ to: tj, cost: dist(padC, t.target) * 0.5 });
    for (let k = 0; k < ni; k++) { const w = walkable(game, nodes[k].origin, padC); if (w.ok) nodes[k].edges.push({ to: ni, cost: dist(nodes[k].origin, padC), jump: w.jump }); }
  }
  for (const t of map.triggers) {
    if (t.kind !== 'teleporter') continue;
    const c = [(t.mins[0] + t.maxs[0]) / 2, (t.mins[1] + t.maxs[1]) / 2, t.mins[2] + 24];
    const ni = nodes.length; nodes.push({ origin: c, i: ni, edges: [] });
    const tj = nearestNode(nodes.slice(0, ni), t.dest);
    if (tj >= 0) nodes[ni].edges.push({ to: tj, cost: 10 });
    for (let k = 0; k < ni; k++) { const w = walkable(game, nodes[k].origin, c); if (w.ok) nodes[k].edges.push({ to: ni, cost: dist(nodes[k].origin, c), jump: w.jump }); }
  }
  return { nodes };
}

// Can a player get from a to b along a straight line with steps (18), jumps (up to ~44 high) and gap jumps
// (up to ~200 units) without falling more than 300? Returns { ok, jump } where jump means a jump is required.
export function walkable(game, a, b) {
  const dz = b[2] - a[2];
  if (dz > 60) return { ok: false };
  const stepLen = 32;
  const steps = Math.max(2, Math.ceil(dist(a, b) / stepLen));
  let cur = copy(a);
  let jump = false;
  const floorBelow = (pt, depth) => traceBox(game.world, pt, [pt[0], pt[1], pt[2] - depth], PM.mins, PM.maxs);
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const target = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, cur[2]];
    // try to move horizontally, allowing an 18-unit step up
    const up = [cur[0], cur[1], cur[2] + PM.stepSize];
    let tr = traceBox(game.world, cur, up, PM.mins, PM.maxs, null, { skipFlags: 0 });
    const from = copy(tr.endpos);
    tr = traceBox(game.world, from, [target[0], target[1], from[2]], PM.mins, PM.maxs, null, { skipFlags: 0 });
    if (tr.fraction < 0.98) {
      // blocked: maybe a jump clears it (44 units of jump height)
      const tr2 = traceBox(game.world, cur, [cur[0], cur[1], cur[2] + 44], PM.mins, PM.maxs);
      const tr3 = traceBox(game.world, tr2.endpos, [target[0], target[1], tr2.endpos[2]], PM.mins, PM.maxs);
      if (tr3.fraction < 0.98) return { ok: false };
      tr = tr3; jump = true;
    }
    // drop down to the floor
    const trd = floorBelow(tr.endpos, 320);
    let landed = copy(trd.endpos);
    if (trd.fraction === 1 || landed[2] < Math.min(a[2], b[2]) - 80) {
      // a pit or a ledge: can we jump the gap? scan ahead (max ~200 units) for floor at a reachable height with clear air between
      let found = null;
      for (let k = s + 1; k <= Math.min(steps, s + Math.ceil(200 / stepLen)); k++) {
        const tk = k / steps;
        const pt = [a[0] + (b[0] - a[0]) * tk, a[1] + (b[1] - a[1]) * tk, cur[2] + 30];
        const air = traceBox(game.world, [cur[0], cur[1], cur[2] + 30], pt, PM.mins, PM.maxs);
        if (air.fraction < 0.98) break;
        const fl = floorBelow(pt, 30 + 80);
        if (fl.fraction < 1 && fl.endpos[2] >= cur[2] - 80) { found = { s: k, pos: copy(fl.endpos) }; break; }
      }
      if (!found) return { ok: false };
      jump = true; s = found.s; landed = found.pos;
    }
    cur = landed;
    if (cur[2] < Math.min(a[2], b[2]) - 80) return { ok: false };
  }
  return { ok: Math.abs(cur[2] - b[2]) < 40 && Math.hypot(cur[0] - b[0], cur[1] - b[1]) < 40, jump };
}

function nearestNode(nodes, p) {
  let best = -1, bd = Infinity;
  for (const n of nodes) { const d = dist(n.origin, p); if (d < bd) { bd = d; best = n.i; } }
  return best;
}

// Dijkstra from the nearest node to `from` to the nearest node to `to`; returns node list including the final target point.
// Each returned node carries `jump` when the edge INTO it needs a jump.
export function findPath(nav, from, to) {
  const nodes = nav.nodes;
  if (!nodes.length) return [{ origin: to }];
  const s = nearestNode(nodes, from), e = nearestNode(nodes, to);
  if (s < 0 || e < 0) { console.warn('[bot] findPath: no nearest node (non-finite origin?)', from, to); return [{ origin: to }]; } // never index nodes[-1]
  const distv = new Array(nodes.length).fill(Infinity), prev = new Array(nodes.length).fill(-1), prevJump = new Array(nodes.length).fill(false);
  distv[s] = 0;
  const open = new Set([s]);
  const done = new Set();
  while (open.size) {
    let u = -1, ud = Infinity;
    for (const i of open) if (distv[i] < ud) { ud = distv[i]; u = i; }
    open.delete(u); done.add(u);
    if (u === e) break;
    for (const ed of nodes[u].edges) {
      if (done.has(ed.to)) continue;
      const nd = ud + ed.cost;
      if (nd < distv[ed.to]) { distv[ed.to] = nd; prev[ed.to] = u; prevJump[ed.to] = !!ed.jump; open.add(ed.to); }
    }
  }
  const path = [];
  if (distv[e] === Infinity) return [{ origin: to }];
  for (let c = e; c !== -1; c = prev[c]) path.unshift({ origin: nodes[c].origin, jump: prevJump[c], i: c });
  // skip the first node if we're already on it
  if (path.length > 1 && dist(path[0].origin, from) < 32) path.shift();
  path.push({ origin: to });
  return path;
}
