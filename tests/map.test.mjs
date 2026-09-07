// Competitive map checks (docs/BENCHMARK.md "Maps"): enclosure, reachability by bot navigation, clearance sweeps
// along every nav edge, corridor widths, major-item spacing, items resting on floors, spawn sightlines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMap } from '../shared/map.js';
import { meta } from '../maps/arena_duel.js';
import { Game } from '../shared/game.js';
import { buildNavGraph, findPath } from '../shared/bot.js';
import { traceBox, pointContents } from '../shared/trace.js';
import { PM, ITEMS } from '../shared/constants.js';
import { BRUSH_FLAGS } from '../shared/map.js';

const map = await loadMap('arena_duel');
const game = new Game(map, { mode: 'duel', seed: 1 });
const world = game.world;
const nav = buildNavGraph(game);
const ZERO = [0, 0, 0];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const nearest = (p) => { let bi = -1, bd = Infinity; for (const n of nav.nodes) { const d = dist(n.origin, p); if (d < bd) { bd = d; bi = n.i; } } return bi; };

// 26 axis/diagonal directions plus a deterministic fan of 40 irrational-ish directions
const DIRS = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) { const l = Math.hypot(x, y, z); DIRS.push([x / l, y / l, z / l]); }
for (let i = 0; i < 40; i++) { const t = i * 2.399963, ph = Math.acos(1 - 2 * ((i + 0.5) / 40)); DIRS.push([Math.sin(ph) * Math.cos(t), Math.sin(ph) * Math.sin(t), Math.cos(ph)]); }

test('map: basic content', () => {
  assert.equal(map.title, 'Crossfire');
  assert.ok(map.spawns.length >= 5 && map.spawns.length <= 6, 'spawns 5-6');
  const types = map.items.map((i) => i.type);
  for (const t of ['mega', 'armorRed', 'weaponRocket', 'weaponRail', 'weaponLightning', 'weaponShotgun', 'weaponPlasma', 'ammoRockets', 'ammoSlugs', 'ammoCells', 'ammoShells', 'ammoPlasma', 'health5', 'armorShard']) assert.ok(types.includes(t), 'has ' + t);
  assert.equal(types.filter((t) => t === 'armorYellow').length, 2);
  const h25 = types.filter((t) => t === 'health25').length; assert.ok(h25 >= 2 && h25 <= 4, 'health25 x2-4');
  assert.ok(map.lights.length <= 14, 'at most 14 lights');
  assert.ok(map.triggers.some((t) => t.kind === 'jumppad'), 'has a jump pad');
  for (const it of map.items) assert.equal(it.origin[2], it.floorZ + 20, `${it.type} origin 20 above its floor`);
});

test('map: enclosed (no leak): point traces from every nav node and spawn hit geometry within 8192', () => {
  const origins = [...map.navNodes.map((n) => n.origin), ...map.spawns.map((s) => s.origin), ...map.items.map((i) => i.origin)];
  let rays = 0;
  for (const o of origins) for (const d of DIRS) {
    const end = [o[0] + d[0] * 8192, o[1] + d[1] * 8192, o[2] + d[2] * 8192];
    const tr = traceBox(world, o, end, ZERO, ZERO, null, { skipFlags: BRUSH_FLAGS.PLAYERCLIP });
    rays++;
    assert.ok(tr.fraction < 1, `leak: ray from ${o} toward ${d.map((x) => x.toFixed(2))} escaped`);
  }
  assert.ok(rays > 10000, 'traced ' + rays + ' rays');
});

test('map: nav graph connects every spawn to every item and every other spawn (no direct-goal fallback)', () => {
  // full reachability over the graph's own edges (jump pads included), independent of findPath's fallback stub
  const reach = (s) => { const seen = new Set([s]); const st = [s]; while (st.length) { const u = st.pop(); for (const e of nav.nodes[u].edges) if (!seen.has(e.to)) { seen.add(e.to); st.push(e.to); } } return seen; };
  const goals = [...map.items.map((i) => ({ what: i.type, origin: i.origin })), ...map.spawns.map((s, k) => ({ what: 'spawn' + k, origin: s.origin }))];
  for (const [k, s] of map.spawns.entries()) {
    const from = nearest(s.origin);
    assert.ok(dist(nav.nodes[from].origin, s.origin) < 48, 'spawn ' + k + ' sits on a nav node');
    const seen = reach(from);
    for (const g of goals) {
      const to = nearest(g.origin);
      assert.ok(dist(nav.nodes[to].origin, g.origin) < 64, `${g.what} has a nav node within 64`);
      assert.ok(seen.has(to), `spawn ${k} cannot reach ${g.what} over the nav graph`);
      const path = findPath(nav, s.origin, g.origin);
      // the fallback stub is [{origin: goal}] with no nav node; a real path lists graph nodes (which carry `i`) unless start==goal node
      if (from !== to) assert.ok(path.length >= 2 && path.slice(0, -1).every((n) => typeof n.i === 'number'), `findPath fell back to the direct-goal stub for spawn ${k} -> ${g.what}`);
    }
  }
  // every nav node is reachable from spawn 0 (no orphan islands the bots could get pathed onto)
  const all = reach(nearest(map.spawns[0].origin));
  const orphans = nav.nodes.filter((n) => !all.has(n.i));
  assert.equal(orphans.length, 0, 'orphan nav nodes: ' + orphans.map((n) => n.origin).join(' | '));
  assert.ok(nav.nodes.length >= 250, 'dense nav: ' + nav.nodes.length + ' nodes');
});

test('map: upper level is reachable by stairs/ramp and by jump pad', () => {
  const upper = nav.nodes.filter((n) => n.origin[2] > 150);
  assert.ok(upper.length >= 40, 'upper nav nodes: ' + upper.length);
  // walking-only reachability (drop the jump pad edges) from the lowest spawn must still reach the balconies
  const walkOnly = nav.nodes.map((n) => n.edges.filter((e) => nav.nodes[e.to].origin[2] - n.origin[2] < 60).map((e) => e.to));
  const seen = new Set(); const st = [nearest(map.spawns[4].origin)]; seen.add(st[0]);
  while (st.length) { const u = st.pop(); for (const v of walkOnly[u]) if (!seen.has(v)) { seen.add(v); st.push(v); } }
  for (const [x, y] of [[-960, 352], [960, -352], [0, 0]]) {
    const n = nearest([x, y, 216]);
    assert.ok(nav.nodes[n].origin[2] > 150 && seen.has(n), `upper spot ${x},${y} reachable by walking (stairs/ramp/bridge)`);
  }
  // each pad has a launch edge to a node on the upper level
  for (const t of map.triggers.filter((t) => t.kind === 'jumppad')) {
    const pad = nav.nodes.find((n) => Math.abs(n.origin[0] - (t.mins[0] + t.maxs[0]) / 2) < 1 && Math.abs(n.origin[1] - (t.mins[1] + t.maxs[1]) / 2) < 1);
    assert.ok(pad, 'pad node exists');
    assert.ok(pad.edges.some((e) => nav.nodes[e.to].origin[2] > 150), 'pad launches to the upper level');
  }
});

// Physical check: a player standing still on each pad is delivered onto the upper level (not into a lip).
test('map: jump pads physically land the player on the upper level', () => {
  for (const t of map.triggers.filter((t) => t.kind === 'jumppad')) {
    const g = new Game(map, { mode: 'duel', seed: 3, rules: { warmup: 0 } });
    const p = g.addPlayer(1, 'pad', {});
    p.ps.origin = [(t.mins[0] + t.maxs[0]) / 2, (t.mins[1] + t.maxs[1]) / 2, t.mins[2] + 24]; p.ps.velocity = [0, 0, 0]; p.dead = false;
    let launched = false, maxZ = 0, landed = null;
    for (let i = 0; i < 180; i++) {
      g.queueCommand(1, { seq: i + 1, forward: 0, right: 0, up: 0, buttons: 0, angles: [0, 0, 0], weapon: 0, vt: 0 });
      for (const e of g.step()) if (e.type === 14 /* EV.JUMPPAD */) launched = true;
      maxZ = Math.max(maxZ, p.ps.origin[2]);
      if (launched && i > 20 && p.ps.groundEntity) { landed = [...p.ps.origin]; break; }
    }
    assert.ok(launched, 'pad fired');
    assert.ok(landed, 'player landed within 3 s');
    assert.ok(landed[2] >= meta.levels.upper + 20, `pad at ${t.mins} dropped the player at z=${landed[2].toFixed(1)} (max z ${maxZ.toFixed(0)})`);
    assert.ok(Math.hypot(landed[0] - t.target[0], landed[1] - t.target[1]) < 320, 'landed near the target: ' + landed);
  }
});

// Re-walk each walk edge the way the bot navigation does (18-unit step-ups, drops) and assert the player box is
// never inside solid at any sample, no horizontal sweep is blocked and the walk arrives at the far node. Edges the nav
// graph marks as jumps (gap jumps between ledges) are checked as a trajectory instead: a box sweep along the line at
// jump height must be clear and both ends must be free. Jump-pad launch edges are skipped (covered by the pad test).
test('map: player-box clearance along every nav edge', () => {
  let checked = 0, jumps = 0;
  const padNodes = new Set(nav.nodes.filter((n) => map.triggers.some((t) => t.kind === 'jumppad' && Math.abs(n.origin[0] - (t.mins[0] + t.maxs[0]) / 2) < 1 && Math.abs(n.origin[1] - (t.mins[1] + t.maxs[1]) / 2) < 1)).map((n) => n.i));
  for (const n of nav.nodes) for (const e of n.edges) {
    if (padNodes.has(n.i) && nav.nodes[e.to].origin[2] - n.origin[2] > 60) continue; // launch edge
    const a = n.origin, b = nav.nodes[e.to].origin;
    assert.ok(!pointContents(world, [a[0], a[1], a[2] + 1], PM.mins, PM.maxs), `node ${a} is inside solid`);
    assert.ok(!pointContents(world, [b[0], b[1], b[2] + 1], PM.mins, PM.maxs), `node ${b} is inside solid`);
    if (e.jump) {
      // a full jump lifts the box 44 units: sweep the line at that height (clears 32-unit steps and ledges up to 44)
      const z = Math.max(a[2], b[2]) + 44;
      const tr = traceBox(world, [a[0], a[1], z], [b[0], b[1], z], PM.mins, PM.maxs);
      assert.ok(tr.fraction === 1 && !tr.startsolid, `jump edge ${a} -> ${b} passes through solid at jump height`);
      jumps++; checked++; continue;
    }
    const steps = Math.max(2, Math.ceil(dist(a, b) / 32));
    let cur = [...a];
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const target = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      let tr = traceBox(world, cur, [cur[0], cur[1], cur[2] + PM.stepSize], PM.mins, PM.maxs);
      const from = [...tr.endpos];
      tr = traceBox(world, from, [target[0], target[1], from[2]], PM.mins, PM.maxs);
      if (tr.fraction < 0.98) {
        // a 44-unit jump has to clear it (walkable() allows this for a single obstacle)
        const up = traceBox(world, cur, [cur[0], cur[1], cur[2] + 44], PM.mins, PM.maxs);
        tr = traceBox(world, up.endpos, [target[0], target[1], up.endpos[2]], PM.mins, PM.maxs);
        assert.ok(tr.fraction >= 0.98, `edge ${a} -> ${b} blocked at sample ${s}/${steps}`);
      }
      assert.ok(!tr.startsolid && !tr.allsolid, `edge ${a} -> ${b} starts in solid at sample ${s}`);
      const down = traceBox(world, tr.endpos, [tr.endpos[0], tr.endpos[1], tr.endpos[2] - 320], PM.mins, PM.maxs);
      assert.ok(down.fraction < 1, `edge ${a} -> ${b} falls out of the world`);
      cur = [...down.endpos];
      assert.ok(!pointContents(world, [cur[0], cur[1], cur[2] + 1], PM.mins, PM.maxs), `edge ${a} -> ${b}: box in solid at sample ${s}`);
      // head room: a standing player needs 56 units; check 8 more for a bumpy ceiling
      const head = traceBox(world, cur, [cur[0], cur[1], cur[2] + 8], PM.mins, PM.maxs);
      assert.ok(head.fraction === 1, `edge ${a} -> ${b}: no head room at sample ${s}`);
    }
    assert.ok(Math.abs(cur[2] - b[2]) < 40 && Math.hypot(cur[0] - b[0], cur[1] - b[1]) < 40, `edge ${a} -> ${b} does not arrive`);
    checked++;
  }
  assert.ok(checked > 1000, 'checked ' + checked + ' edges (' + jumps + ' jump edges)');
});

test('map: corridors >= 96 wide (128 preferred) and ceilings >= 128 (halls) / >= 192 (rooms)', () => {
  for (const r of meta.rooms) {
    const w = Math.min(r.maxs[0] - r.mins[0], r.maxs[1] - r.mins[1]), h = r.maxs[2] - r.mins[2];
    assert.ok(w >= 128, `${r.name} width ${w}`);
    assert.ok(h >= (r.cls === 'room' ? 192 : 128), `${r.name} height ${h}`);
  }
  assert.ok(meta.corridorSamples.length >= 8);
  for (const s of meta.corridorSamples) {
    const d = [0, 0, 0]; d[s.axis] = 1;
    const a = traceBox(world, s.at, [s.at[0] + d[0] * 4096, s.at[1] + d[1] * 4096, s.at[2]], ZERO, ZERO);
    const b = traceBox(world, s.at, [s.at[0] - d[0] * 4096, s.at[1] - d[1] * 4096, s.at[2]], ZERO, ZERO);
    const width = dist(a.endpos, b.endpos);
    assert.ok(width >= 96, `corridor at ${s.at} is ${width} wide`);
    const up = traceBox(world, s.at, [s.at[0], s.at[1], s.at[2] + 4096], ZERO, ZERO);
    const dn = traceBox(world, s.at, [s.at[0], s.at[1], s.at[2] - 4096], ZERO, ZERO);
    assert.ok(up.endpos[2] - dn.endpos[2] >= 128, `corridor at ${s.at} ceiling ${up.endpos[2] - dn.endpos[2]}`);
  }
});

test('map: stairs rise <= 16 per step with run >= 24 (step height 18)', () => {
  // every solid brush top between two floor levels that is narrower than 64 in one axis is a step: measure rises along the west stairs
  let prev = null; let steps = 0;
  for (let y = -144; y < 272; y += 32) {
    const tr = traceBox(world, [-1088, y, 400], [-1088, y, -100], ZERO, ZERO);
    const z = tr.endpos[2];
    if (prev !== null) { const rise = z - prev; assert.ok(rise <= 16 + 1e-6 && rise >= 0, `stair rise ${rise} at y=${y}`); if (rise > 0) steps++; }
    prev = z;
  }
  assert.equal(steps, 12);
});

test('map: majors >= 512 apart, no item inside solid, every item rests on its floor', () => {
  const majors = map.items.filter((i) => ITEMS[i.type].major);
  assert.ok(majors.length >= 5);
  for (let i = 0; i < majors.length; i++) for (let j = i + 1; j < majors.length; j++) {
    const d = dist(majors[i].origin, majors[j].origin);
    assert.ok(d >= 512, `${majors[i].type} and ${majors[j].type} are ${d.toFixed(0)} apart`);
  }
  const H = [-15, -15, -15], Hx = [15, 15, 15];
  for (const it of map.items) {
    assert.ok(!pointContents(world, it.origin, H, Hx), `${it.type} at ${it.origin} intersects solid`);
    const down = traceBox(world, it.origin, [it.origin[0], it.origin[1], it.origin[2] - 64], ZERO, ZERO);
    assert.ok(down.fraction < 1 && Math.abs(down.endpos[2] - it.floorZ) < 1, `${it.type} floats above its floor (${down.endpos[2]} vs ${it.floorZ})`);
    // a player standing on the item spot fits
    assert.ok(!pointContents(world, [it.origin[0], it.origin[1], it.floorZ + 26], PM.mins, PM.maxs), `${it.type}: player box does not fit`);
  }
  for (const s of map.spawns) assert.ok(!pointContents(world, [s.origin[0], s.origin[1], s.origin[2] + 2], PM.mins, PM.maxs), 'spawn in solid');
});

test('map: no spawn point sees both majors (mega and red armor)', () => {
  const ra = map.items.find((i) => i.type === 'armorRed').origin, mh = map.items.find((i) => i.type === 'mega').origin;
  assert.ok(dist(ra, mh) >= 1500, 'majors on opposite sides');
  const sees = (eye, p) => traceBox(world, eye, p, ZERO, ZERO).fraction === 1;
  let seesOne = 0;
  for (const s of map.spawns) {
    const eye = [s.origin[0], s.origin[1], s.origin[2] + PM.viewHeight];
    const a = sees(eye, ra), b = sees(eye, mh);
    assert.ok(!(a && b), `spawn ${s.origin} sees both majors`);
    if (a || b) seesOne++;
  }
  assert.ok(seesOne < map.spawns.length, 'at least one spawn sees neither major');
  // and the majors do not see each other
  assert.ok(!sees([ra[0], ra[1], ra[2] + 30], mh), 'red armor has line of sight to mega');
});
