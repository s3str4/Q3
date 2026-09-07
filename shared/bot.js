// Bot AI: navigation over map nav nodes, item timing, weapon selection and human-like aim.
// Runs in-process on the server (or in the browser host) and drives a player through queueCommand.
import { WEAPONS, WEAPON_DEFS, BUTTONS, ITEMS } from './constants.js';
import { traceBox } from './trace.js';
import { angleVectors, vectorToAngles, sub, add, scale, dot, dist, normalize, length, ma, copy, makeRng, normalizeAngle } from './vec3.js';
import { PM } from './constants.js';
import { BRUSH_FLAGS } from './map.js';

export class Bot {
  constructor(game, player, opts = {}) {
    this.game = game; this.p = player;
    this.skill = opts.skill ?? 0.7; // 0..1
    this.rng = makeRng(opts.seed ?? 1);
    this.seq = 0;
    this.yaw = player.ps.viewangles[1]; this.pitch = 0;
    this.goal = null; this.path = []; this.pathIdx = 0; this.repathAt = 0;
    this.strafeDir = 1; this.strafeUntil = 0;
    this.lastSeen = -1e9; this.enemyLastPos = null;
    this.reaction = 250 - 200 * this.skill; // ms
    this.aimError = 8 - 7 * this.skill; // degrees of noise
    this.nav = buildNavGraph(game);
    this.jumpHeld = false;
    this.stuckTimer = 0; this.lastPos = copy(player.ps.origin);
    this.fireHeld = false;
  }

  think() {
    const g = this.game, p = this.p;
    if (p.dead) {
      // respawn: press attack after the minimum time
      this.queue({ forward: 0, right: 0, up: 0, buttons: (this.rng() < 0.5 ? BUTTONS.ATTACK : 0), angles: [0, this.yaw, 0], weapon: 0 });
      return;
    }
    const enemy = g.other(p);
    const eye = [p.ps.origin[0], p.ps.origin[1], p.ps.origin[2] + p.ps.viewHeight];
    let visible = false;
    if (enemy && !enemy.dead) {
      const target = [enemy.ps.origin[0], enemy.ps.origin[1], enemy.ps.origin[2] + 8];
      const tr = traceBox(g.world, eye, target, [0, 0, 0], [0, 0, 0], null, { skipFlags: BRUSH_FLAGS.PLAYERCLIP });
      visible = tr.fraction === 1;
      if (visible) { if (this.lastSeen < g.time - 500) this.firstSeen = g.time; this.lastSeen = g.time; this.enemyLastPos = copy(enemy.ps.origin); }
    }
    // --- choose goal ---
    if (g.time >= this.repathAt || !this.goal) this.pickGoal(enemy, visible);
    // --- movement along path ---
    let moveDir = null;
    let wantJump = false;
    const node = this.path[this.pathIdx];
    if (node) {
      const to = sub(node.origin, p.ps.origin);
      const flat = [to[0], to[1], 0];
      const d = length(flat);
      if (d < 24 && Math.abs(to[2]) < 48) { this.pathIdx++; }
      else {
        moveDir = normalize(flat);
        if (to[2] > 20 && d < 80 && p.ps.groundEntity) wantJump = true;
        if (node.jump && d < 100 && p.ps.groundEntity) wantJump = true;
      }
    }
    // stuck detection
    if (dist(p.ps.origin, this.lastPos) < 2) { this.stuckTimer += 1000 / 60; } else this.stuckTimer = 0;
    this.lastPos = copy(p.ps.origin);
    if (this.stuckTimer > 700) { wantJump = true; if (this.stuckTimer > 1500) { this.repathAt = 0; this.goal = null; this.stuckTimer = 0; } }
    // --- aiming ---
    let wantFire = false;
    let weapon = this.chooseWeapon(enemy, visible);
    if (enemy && !enemy.dead && visible && g.time - this.firstSeen >= this.reaction) {
      const wd = WEAPON_DEFS[p.weapon];
      let aimAt = [enemy.ps.origin[0], enemy.ps.origin[1], enemy.ps.origin[2] + (wd.projectile ? -10 : 4)];
      if (wd.projectile) {
        // lead the target
        const t = dist(aimAt, eye) / wd.speed;
        aimAt = ma(aimAt, t * (0.6 + 0.4 * this.skill), enemy.ps.velocity);
        if (!enemy.ps.groundEntity) aimAt[2] -= 8;
      }
      const desired = vectorToAngles(sub(aimAt, eye));
      const noise = this.aimError * (1 - Math.min(1, (g.time - this.firstSeen) / 800) * 0.6);
      const dy = normalizeAngle(desired[1] + (this.rng() * 2 - 1) * noise - this.yaw);
      const dp = (desired[0] + (this.rng() * 2 - 1) * noise * 0.5) - this.pitch;
      const turn = 0.25 + 0.55 * this.skill; // fraction per tick
      this.yaw = normalizeAngle(this.yaw + dy * turn);
      this.pitch = Math.max(-80, Math.min(80, this.pitch + dp * turn));
      const inRange = !wd.range || wd.range > 4000 || dist(aimAt, eye) < wd.range;
      wantFire = inRange && Math.abs(dy) < 6 + 10 * (1 - this.skill) && Math.abs(dp) < 8;
      // strafe while fighting
      if (g.time > this.strafeUntil) { this.strafeDir = this.rng() < 0.5 ? -1 : 1; this.strafeUntil = g.time + 400 + this.rng() * 900; }
      if (!moveDir) moveDir = normalize([-(Math.sin(this.yaw * Math.PI / 180)) * this.strafeDir, Math.cos(this.yaw * Math.PI / 180) * this.strafeDir, 0]);
      if (this.rng() < 0.02 && p.ps.groundEntity) wantJump = true;
    } else if (moveDir) {
      // look where we're going
      const desired = vectorToAngles(moveDir);
      const dy = normalizeAngle(desired[1] - this.yaw);
      this.yaw = normalizeAngle(this.yaw + dy * 0.3);
      this.pitch += (0 - this.pitch) * 0.2;
    }
    // convert world moveDir into forward/right relative to yaw
    let forward = 0, right = 0;
    if (moveDir) {
      const av = angleVectors([0, this.yaw, 0]);
      const f = dot(moveDir, [av.forward[0], av.forward[1], 0]);
      const r = dot(moveDir, [av.right[0], av.right[1], 0]);
      const m = Math.max(Math.abs(f), Math.abs(r), 1e-6);
      forward = Math.round(127 * f / m); right = Math.round(127 * r / m);
    }
    let buttons = 0;
    if (wantFire && !(WEAPON_DEFS[p.weapon].melee)) buttons |= BUTTONS.ATTACK;
    if (wantJump && !this.jumpHeld) { buttons |= BUTTONS.JUMP; this.jumpHeld = true; } else this.jumpHeld = false;
    this.queue({ forward, right, up: 0, buttons, angles: [this.pitch, this.yaw, 0], weapon });
  }

  chooseWeapon(enemy, visible) {
    const p = this.p;
    const has = (w) => (p.weapons & (1 << w)) && (p.ammo[w] === -1 || (p.ammo[w] || 0) > 0);
    const d = enemy && !enemy.dead ? dist(enemy.ps.origin, p.ps.origin) : 600;
    const prefs = d < 700 ? [WEAPONS.ROCKET, WEAPONS.LIGHTNING, WEAPONS.SHOTGUN, WEAPONS.PLASMA, WEAPONS.RAIL, WEAPONS.MACHINEGUN]
      : [WEAPONS.RAIL, WEAPONS.ROCKET, WEAPONS.PLASMA, WEAPONS.LIGHTNING, WEAPONS.MACHINEGUN, WEAPONS.SHOTGUN];
    for (const w of prefs) if (has(w)) return w;
    return WEAPONS.GAUNTLET;
  }

  pickGoal(enemy, visible) {
    const g = this.game, p = this.p;
    this.repathAt = g.time + 1500 + this.rng() * 1500;
    // score items
    let best = null, bestScore = -Infinity;
    for (const it of g.items) {
      const def = it.def;
      let want = 0;
      if (def.kind === 'health') want = (def.max - p.health) / 100 * (def.amount / 100) * 2;
      else if (def.kind === 'armor') want = (def.max - p.armor) / 100 * (def.amount / 100) * 2.2;
      else if (def.kind === 'weapon') want = (p.weapons & (1 << def.weapon)) ? 0.2 : 1.5;
      else if (def.kind === 'ammo') want = (p.weapons & (1 << def.weapon)) ? Math.max(0, 1 - (p.ammo[def.weapon] || 0) / 30) : 0;
      if (def.major) want += 0.6;
      if (!it.available) {
        const wait = it.respawnAt - g.time;
        if (wait > 6000) continue; want *= 0.5;
      }
      const d = dist(it.origin, p.ps.origin);
      const score = want / (1 + d / 900) + this.rng() * 0.15;
      if (score > bestScore) { bestScore = score; best = it.origin; }
    }
    // chase the enemy when strong, or when nothing worthwhile
    if (enemy && !enemy.dead && (bestScore < 0.35 || (visible && p.health + p.armor > 150))) best = copy(enemy.ps.origin);
    if (!best) { const n = this.nav.nodes; best = n.length ? n[Math.floor(this.rng() * n.length)].origin : p.ps.origin; }
    this.goal = best;
    this.path = findPath(this.nav, p.ps.origin, best);
    this.pathIdx = 0;
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
  // connect nodes that a player can walk between (box sweep along the line at player height, allowing step ups)
  for (let i = 0; i < nodes.length; i++) for (let j = 0; j < nodes.length; j++) {
    if (i === j) continue;
    const a = nodes[i].origin, b = nodes[j].origin;
    const d = dist(a, b);
    if (d > 900) continue;
    if (walkable(game, a, b)) nodes[i].edges.push({ to: j, cost: d });
  }
  // jump pads: edge from pad to its target
  for (const t of map.triggers) {
    if (t.kind !== 'jumppad') continue;
    const padC = [(t.mins[0] + t.maxs[0]) / 2, (t.mins[1] + t.maxs[1]) / 2, t.mins[2] + 24];
    const ni = nodes.length; nodes.push({ origin: padC, i: ni, edges: [], jump: false });
    const tj = nearestNode(nodes.slice(0, ni), t.target);
    if (tj >= 0) nodes[ni].edges.push({ to: tj, cost: dist(padC, t.target) * 0.5 });
    for (let k = 0; k < ni; k++) if (walkable(game, nodes[k].origin, padC)) nodes[k].edges.push({ to: ni, cost: dist(nodes[k].origin, padC) });
    if (t.kind === 'teleporter') {}
  }
  for (const t of map.triggers) {
    if (t.kind !== 'teleporter') continue;
    const c = [(t.mins[0] + t.maxs[0]) / 2, (t.mins[1] + t.maxs[1]) / 2, t.mins[2] + 24];
    const ni = nodes.length; nodes.push({ origin: c, i: ni, edges: [] });
    const tj = nearestNode(nodes.slice(0, ni), t.dest);
    if (tj >= 0) nodes[ni].edges.push({ to: tj, cost: 10 });
    for (let k = 0; k < ni; k++) if (walkable(game, nodes[k].origin, c)) nodes[k].edges.push({ to: ni, cost: dist(nodes[k].origin, c) });
  }
  return { nodes };
}

// Can a player walk (with steps, without falling more than 300) from a to b along a straight line?
export function walkable(game, a, b) {
  const dz = b[2] - a[2];
  if (dz > 60) return false; // needs more than a jump
  const steps = Math.max(2, Math.ceil(dist(a, b) / 32));
  let cur = copy(a);
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const target = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, cur[2]];
    // try to move horizontally, allow step up 18 (and jump-height 45 near the end)
    const up = [cur[0], cur[1], cur[2] + PM.stepSize];
    let tr = traceBox(game.world, cur, up, PM.mins, PM.maxs, null, { skipFlags: 0 });
    const from = copy(tr.endpos);
    const to = [target[0], target[1], from[2]];
    tr = traceBox(game.world, from, to, PM.mins, PM.maxs, null, { skipFlags: 0 });
    if (tr.fraction < 0.98) {
      // blocked: maybe a jump clears it
      const jumpFrom = [cur[0], cur[1], cur[2] + 44];
      const tr2 = traceBox(game.world, cur, jumpFrom, PM.mins, PM.maxs);
      const tr3 = traceBox(game.world, tr2.endpos, [target[0], target[1], tr2.endpos[2]], PM.mins, PM.maxs);
      if (tr3.fraction < 0.98) return false;
      tr = tr3;
    }
    // drop down to the floor
    const down = [tr.endpos[0], tr.endpos[1], tr.endpos[2] - 320];
    const trd = traceBox(game.world, tr.endpos, down, PM.mins, PM.maxs);
    if (trd.fraction === 1) return false; // fell off the world
    cur = copy(trd.endpos);
    if (cur[2] < Math.min(a[2], b[2]) - 80) return false; // fell too far
  }
  return Math.abs(cur[2] - b[2]) < 40 && Math.hypot(cur[0] - b[0], cur[1] - b[1]) < 40;
}

function nearestNode(nodes, p) {
  let best = -1, bd = Infinity;
  for (const n of nodes) { const d = dist(n.origin, p); if (d < bd) { bd = d; best = n.i; } }
  return best;
}

// Dijkstra from the nearest node to `from` to the nearest node to `to`; returns node list including the final target point.
export function findPath(nav, from, to) {
  const nodes = nav.nodes;
  if (!nodes.length) return [{ origin: to }];
  const s = nearestNode(nodes, from), e = nearestNode(nodes, to);
  const distv = new Array(nodes.length).fill(Infinity), prev = new Array(nodes.length).fill(-1);
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
      if (nd < distv[ed.to]) { distv[ed.to] = nd; prev[ed.to] = u; open.add(ed.to); }
    }
  }
  const path = [];
  if (distv[e] === Infinity) return [{ origin: to }];
  for (let c = e; c !== -1; c = prev[c]) path.unshift(nodes[c]);
  // skip the first node if we're already past it
  if (path.length > 1 && dist(path[0].origin, from) < 32) path.shift();
  path.push({ origin: to });
  return path;
}
