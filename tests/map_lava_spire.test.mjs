// Acceptance suite for maps/lava_spire.js (docs/BENCHMARK.md "Maps" plus the lava rules): enclosure, reachability
// by bot navigation, clearance along every nav edge, corridor widths / ceilings, stair rises, major spacing, items
// on their floors, spawn sightlines, lava never on a route (no nav edge crosses a lava trigger with the player box,
// no nav node near lava beyond the 12% budget), and route verticality between the majors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMap, BRUSH_FLAGS } from '../shared/map.js';
import { meta } from '../maps/lava_spire.js';
import { Game } from '../shared/game.js';
import { buildNavGraph, findPath } from '../shared/bot.js';
import { traceBox, pointContents } from '../shared/trace.js';
import { PM, ITEMS } from '../shared/constants.js';

const map = await loadMap('lava_spire');
const game = new Game(map, { mode: 'duel', seed: 1 });
const world = game.world;
const nav = buildNavGraph(game);
const ZERO = [0, 0, 0];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const nearest = (p) => { let bi = -1, bd = Infinity; for (const n of nav.nodes) { const d = dist(n.origin, p); if (d < bd) { bd = d; bi = n.i; } } return bi; };
const lavaBoxes = map.triggers.filter((t) => t.kind === 'lava');
const inLavaXY = (x, y, r) => lavaBoxes.some((b) => x + r > b.mins[0] && x - r < b.maxs[0] && y + r > b.mins[1] && y - r < b.maxs[1]);
const boxInLava = (o) => lavaBoxes.some((b) => o[0] + PM.maxs[0] > b.mins[0] && o[0] + PM.mins[0] < b.maxs[0] && o[1] + PM.maxs[1] > b.mins[1] && o[1] + PM.mins[1] < b.maxs[1] && o[2] + PM.maxs[2] > b.mins[2] && o[2] + PM.mins[2] < b.maxs[2]);
const padCentre = (t) => [(t.mins[0] + t.maxs[0]) / 2, (t.mins[1] + t.maxs[1]) / 2];
const isPadNode = (n) => map.triggers.some((t) => t.kind === 'jumppad' && Math.abs(n.origin[0] - padCentre(t)[0]) < 1 && Math.abs(n.origin[1] - padCentre(t)[1]) < 1);

const DIRS = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) { const l = Math.hypot(x, y, z); DIRS.push([x / l, y / l, z / l]); }
for (let i = 0; i < 40; i++) { const t = i * 2.399963, ph = Math.acos(1 - 2 * ((i + 0.5) / 40)); DIRS.push([Math.sin(ph) * Math.cos(t), Math.sin(ph) * Math.sin(t), Math.cos(ph)]); }

test('lava_spire: basic content', () => {
  assert.equal(map.title, 'Lava Spire');
  assert.ok(map.spawns.length >= 5 && map.spawns.length <= 6, 'spawns 5-6');
  const types = map.items.map((i) => i.type);
  for (const t of ['mega', 'armorRed', 'weaponRocket', 'weaponRail', 'weaponLightning', 'weaponShotgun', 'weaponPlasma', 'ammoRockets', 'ammoSlugs', 'ammoCells', 'ammoShells', 'ammoPlasma', 'ammoBullets', 'health25', 'health5', 'armorShard']) assert.ok(types.includes(t), 'has ' + t);
  assert.equal(types.filter((t) => t === 'armorYellow').length, 2);
  assert.ok(types.filter((t) => t === 'health5').length >= 6, 'health bubble clusters');
  assert.ok(types.filter((t) => t === 'armorShard').length >= 6, 'shard clusters');
  assert.ok(map.lights.length <= 14, 'at most 14 lights: ' + map.lights.length);
  assert.ok(map.lights.filter((l) => l.shadow !== false).length <= 4, 'at most 4 shadow lights');
  assert.ok(map.triggers.filter((t) => t.kind === 'jumppad').length >= 3, 'jump pads');
  assert.ok(lavaBoxes.length >= 1, 'has lava');
  for (const it of map.items) assert.equal(it.origin[2], it.floorZ + 20, `${it.type} origin 20 above its floor`);
});

test('lava_spire: enclosed (no leak)', () => {
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

test('lava_spire: nav graph connects every spawn to every item and spawn (no direct-goal fallback), no orphans', () => {
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
      if (from !== to) assert.ok(path.length >= 2 && path.slice(0, -1).every((n) => typeof n.i === 'number'), `findPath fell back to the direct-goal stub for spawn ${k} -> ${g.what}`);
    }
  }
  // every nav node is reachable from spawn 0 (no orphan islands the bots could be pathed onto)
  const all = reach(nearest(map.spawns[0].origin));
  const orphans = nav.nodes.filter((n) => !all.has(n.i));
  assert.equal(orphans.length, 0, 'orphan nav nodes: ' + orphans.map((n) => n.origin).join(' | '));
  assert.ok(nav.nodes.length >= 200, 'dense nav: ' + nav.nodes.length + ' nodes');
});

test('lava_spire: every level is reachable by walking (stairs / ramps) and the pads launch to their level', () => {
  const walkOnly = nav.nodes.map((n) => n.edges.filter((e) => nav.nodes[e.to].origin[2] - n.origin[2] < 60).map((e) => e.to));
  const seen = new Set(); const st = [nearest(map.spawns[0].origin)]; seen.add(st[0]);
  while (st.length) { const u = st.pop(); for (const v of walkOnly[u]) if (!seen.has(v)) { seen.add(v); st.push(v); } }
  const spots = [['spire top', [0, 0, 344]], ['deck', [-400, 480, 280]], ['bridge', [0, 350, 280]], ['gallery', [-480, -100, 184]], ['mezzanine', [-400, -480, 184]], ['terrace', [480, -200, 184]], ['vault upper', [900, 440, 280]], ['east floor', [300, -450, 88]], ['tower mezzanine', [-1000, 260, 184]]];
  for (const [name, p] of spots) {
    const n = nearest(p);
    assert.ok(dist(nav.nodes[n].origin, p) < 64 && seen.has(n), `${name} reachable by walking from spawn 0`);
  }
  for (const t of map.triggers.filter((t) => t.kind === 'jumppad')) {
    const pad = nav.nodes.find((n) => isPadNode(n) && Math.abs(n.origin[0] - padCentre(t)[0]) < 1 && Math.abs(n.origin[1] - padCentre(t)[1]) < 1);
    assert.ok(pad, 'pad node exists');
    const spec = meta.pads.find((p) => Math.abs(p.at[0] - padCentre(t)[0]) < 1 && Math.abs(p.at[1] - padCentre(t)[1]) < 1);
    assert.ok(spec, 'pad has a meta.pads entry');
    assert.ok(pad.edges.some((e) => { const z = nav.nodes[e.to].origin[2] - 24; return z >= spec.landZ[0] - 1 && z <= spec.landZ[1] + 1; }), `pad at ${spec.at} has a launch edge to a node on its landing level`);
  }
});

test('lava_spire: jump pads physically deliver the player to their landing level', () => {
  for (const t of map.triggers.filter((t) => t.kind === 'jumppad')) {
    const spec = meta.pads.find((p) => Math.abs(p.at[0] - padCentre(t)[0]) < 1 && Math.abs(p.at[1] - padCentre(t)[1]) < 1);
    const g = new Game(map, { mode: 'duel', seed: 3, rules: { warmup: 0 } });
    const p = g.addPlayer(1, 'pad', {});
    p.ps.origin = [padCentre(t)[0], padCentre(t)[1], t.mins[2] + 24]; p.ps.velocity = [0, 0, 0]; p.dead = false; p.health = 1000; p.armor = 0;
    let launched = false, maxZ = -1e9, landed = null;
    for (let i = 0; i < 180; i++) {
      g.queueCommand(1, { seq: i + 1, forward: 0, right: 0, up: 0, buttons: 0, angles: [0, 0, 0], weapon: 0, vt: 0 });
      for (const e of g.step()) if (e.type === 14 /* EV.JUMPPAD */) launched = true;
      maxZ = Math.max(maxZ, p.ps.origin[2]);
      if (launched && i > 20 && p.ps.groundEntity) { landed = [...p.ps.origin]; break; }
    }
    assert.ok(launched, 'pad fired');
    assert.ok(landed, 'player landed within 3 s');
    const z = landed[2] - 24;
    assert.ok(z >= spec.landZ[0] - 2 && z <= spec.landZ[1] + 2, `pad at ${spec.at} dropped the player at floor z=${z.toFixed(1)} (want ${spec.landZ}, max z ${maxZ.toFixed(0)})`);
    assert.ok(!boxInLava(landed), `pad at ${spec.at} landed the player in lava at ${landed}`);
    assert.ok(Math.hypot(landed[0] - t.target[0], landed[1] - t.target[1]) < 320, 'landed near the target: ' + landed);
  }
});

// Re-walk each edge the way the bot navigation does; additionally: the box must never overlap a lava trigger.
function walkEdge(a, b) {
  const steps = Math.max(2, Math.ceil(dist(a, b) / 32));
  let cur = [...a];
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const target = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    let tr = traceBox(world, cur, [cur[0], cur[1], cur[2] + PM.stepSize], PM.mins, PM.maxs);
    const from = [...tr.endpos];
    tr = traceBox(world, from, [target[0], target[1], from[2]], PM.mins, PM.maxs);
    if (tr.fraction < 0.98) {
      const up = traceBox(world, cur, [cur[0], cur[1], cur[2] + 44], PM.mins, PM.maxs);
      tr = traceBox(world, up.endpos, [target[0], target[1], up.endpos[2]], PM.mins, PM.maxs);
      if (tr.fraction < 0.98) return `blocked at sample ${s}/${steps}`;
    }
    if (tr.startsolid || tr.allsolid) return `starts in solid at sample ${s}`;
    const down = traceBox(world, tr.endpos, [tr.endpos[0], tr.endpos[1], tr.endpos[2] - 320], PM.mins, PM.maxs);
    if (down.fraction === 1) return 'falls out of the world';
    cur = [...down.endpos];
    if (pointContents(world, [cur[0], cur[1], cur[2] + 1], PM.mins, PM.maxs)) return `box in solid at sample ${s}`;
    if (boxInLava(cur)) return `walks through lava at sample ${s} (${cur.map((v) => v.toFixed(0))})`;
    const head = traceBox(world, cur, [cur[0], cur[1], cur[2] + 8], PM.mins, PM.maxs);
    if (head.fraction < 1) return `no head room at sample ${s}`;
  }
  if (!(Math.abs(cur[2] - b[2]) < 40 && Math.hypot(cur[0] - b[0], cur[1] - b[1]) < 40)) return 'does not arrive';
  return null;
}

test('lava_spire: player-box clearance along every nav edge, and no edge walks through lava', () => {
  let checked = 0, jumps = 0, sweeps = 0;
  for (const n of nav.nodes) for (const e of n.edges) {
    if (isPadNode(n) && nav.nodes[e.to].origin[2] - n.origin[2] > 60) continue; // launch edge
    const a = n.origin, b = nav.nodes[e.to].origin;
    assert.ok(!pointContents(world, [a[0], a[1], a[2] + 1], PM.mins, PM.maxs), `node ${a} is inside solid`);
    assert.ok(!pointContents(world, [b[0], b[1], b[2] + 1], PM.mins, PM.maxs), `node ${b} is inside solid`);
    const why = walkEdge(a, b);
    if (e.jump) {
      jumps++;
      if (why) {
        assert.ok(!/lava/.test(why), `jump edge ${a} -> ${b} ${why}`);
        const z = Math.max(a[2], b[2]) + 44;
        const tr = traceBox(world, [a[0], a[1], z], [b[0], b[1], z], PM.mins, PM.maxs);
        assert.ok(tr.fraction === 1 && !tr.startsolid, `jump edge ${a} -> ${b} ${why} and passes through solid at jump height`);
        sweeps++;
      }
    } else assert.equal(why, null, `edge ${a} -> ${b} ${why}`);
    checked++;
  }
  assert.ok(checked > 800, 'checked ' + checked + ' edges (' + jumps + ' jump edges, ' + sweeps + ' by sweep)');
});

// Lava rules: (1) no nav node's player box (plus a 48 margin) sits over lava, except the escape pads; (2) the XY sweep
// of the player box along every non-pad edge never crosses a lava footprint unless the edge is a bridge crossing
// (every sample at least 128 above the lava top with solid floor under it); (3) at most 12% of the walkable nav nodes
// are within 96 of lava; (4) every lava pool has a solid floor directly under it (a pit you burn in, not a fall).
test('lava_spire: lava is never on a route (nodes, edges, near-lava budget, solid pit floor)', () => {
  const walkNodes = nav.nodes.filter((n) => !isPadNode(n));
  const lavaTop = Math.max(...lavaBoxes.map((b) => b.maxs[2]));
  for (const n of walkNodes) assert.ok(!inLavaXY(n.origin[0], n.origin[1], 15 + 48) || n.origin[2] - 24 >= lavaTop + 128, `nav node ${n.origin} is on a lava rim`);
  for (const n of nav.nodes) assert.ok(!boxInLava(n.origin), `nav node ${n.origin} sits in lava`);
  let crossings = 0, bridged = 0, edges = 0;
  for (const n of nav.nodes) for (const e of n.edges) {
    if (isPadNode(n)) continue;
    const a = n.origin, b = nav.nodes[e.to].origin;
    edges++;
    const steps = Math.max(2, Math.ceil(dist(a, b) / 16));
    let crosses = false, bridge = true;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
      const over = lavaBoxes.filter((lb) => x + 15 > lb.mins[0] && x - 15 < lb.maxs[0] && y + 15 > lb.mins[1] && y - 15 < lb.maxs[1]);
      if (!over.length) continue;
      crosses = true;
      const floor = traceBox(world, [x, y, z], [x, y, z - 48], PM.mins, PM.maxs);
      if (floor.fraction === 1 || z - 24 < Math.max(...over.map((lb) => lb.maxs[2])) + 128) bridge = false;
    }
    if (crosses) { if (bridge) bridged++; else { crossings++; assert.fail(`nav edge ${a} -> ${b} crosses lava`); } }
  }
  assert.ok(bridged > 0, 'the bridge over the north channel carries nav edges: ' + bridged);
  const near = walkNodes.filter((n) => inLavaXY(n.origin[0], n.origin[1], 96));
  const pct = 100 * near.length / walkNodes.length;
  assert.ok(pct <= 12, `${near.length}/${walkNodes.length} nav nodes (${pct.toFixed(1)}%) within 96 of lava (max 12%)`);
  for (const lb of lavaBoxes) {
    for (const [fx, fy] of [[0.1, 0.1], [0.5, 0.5], [0.9, 0.9], [0.1, 0.9], [0.9, 0.1]]) {
      const x = lb.mins[0] + (lb.maxs[0] - lb.mins[0]) * fx, y = lb.mins[1] + (lb.maxs[1] - lb.mins[1]) * fy;
      const tr = traceBox(world, [x, y, lb.maxs[2] - 1], [x, y, lb.mins[2] - 64], ZERO, ZERO);
      assert.ok(tr.fraction < 1 && tr.endpos[2] >= lb.mins[2] - 0.5, `lava at ${[x, y]} has no floor under it`);
    }
  }
  console.log(`lava: ${edges} edges checked, ${bridged} bridge edges over lava, ${near.length}/${walkNodes.length} nodes (${pct.toFixed(1)}%) within 96 of lava`);
});

test('lava_spire: corridors >= 96 wide (128 preferred) and ceilings >= 128 (halls) / >= 192 (rooms)', () => {
  for (const r of meta.rooms) {
    const ext = [r.maxs[0] - r.mins[0], r.maxs[1] - r.mins[1]];
    const w = r.axis === undefined ? Math.min(...ext) : ext[1 - r.axis];
    const h = r.maxs[2] - r.mins[2];
    assert.ok(w >= 128, `${r.name} width ${w}`);
    assert.ok(h >= (r.cls === 'room' ? 192 : 128), `${r.name} height ${h}`);
  }
  assert.ok(meta.corridorSamples.length >= 12);
  for (const s of meta.corridorSamples) {
    const d = [0, 0, 0]; d[s.axis] = 1;
    assert.ok(!pointContents(world, s.at), `sample ${s.at} is inside solid`);
    const a = traceBox(world, s.at, [s.at[0] + d[0] * 4096, s.at[1] + d[1] * 4096, s.at[2]], ZERO, ZERO);
    const b = traceBox(world, s.at, [s.at[0] - d[0] * 4096, s.at[1] - d[1] * 4096, s.at[2]], ZERO, ZERO);
    const width = dist(a.endpos, b.endpos);
    assert.ok(width >= 96, `corridor at ${s.at} is ${width} wide`);
    const up = traceBox(world, s.at, [s.at[0], s.at[1], s.at[2] + 4096], ZERO, ZERO);
    const dn = traceBox(world, s.at, [s.at[0], s.at[1], s.at[2] - 4096], ZERO, ZERO);
    assert.ok(up.endpos[2] - dn.endpos[2] >= 128 - 0.5, `corridor at ${s.at} ceiling ${up.endpos[2] - dn.endpos[2]}`);
  }
});

test('lava_spire: stairs rise <= 16 per step with run >= 24', () => {
  // (probe line, from, to, axis, expected steps): floor stairs x2, tower stairs, NW stairs, vault stairs
  const runs = [
    { fixed: [null, 464], from: -80, to: 80, axis: 0, steps: 4, top: 200 }, { fixed: [null, -500], from: -80, to: 80, axis: 0, steps: 4, top: 200 },
    { fixed: [-1088, null], from: -272, to: 80, axis: 1, steps: 10, top: 300 }, { fixed: [-512, null], from: 176, to: 400, axis: 1, steps: 6, top: 300 },
    { fixed: [1088, null], from: 80, to: 304, axis: 1, steps: 6, top: 300 },
  ];
  for (const r of runs) {
    let prev = null, steps = 0;
    for (let v = r.from; v <= r.to; v += 8) {
      const p = r.axis === 0 ? [v, r.fixed[1]] : [r.fixed[0], v];
      const tr = traceBox(world, [p[0], p[1], r.top], [p[0], p[1], -200], ZERO, ZERO);
      const z = tr.endpos[2];
      if (prev !== null) { const rise = z - prev; assert.ok(rise <= 16 + 1e-6 && rise >= 0, `stair rise ${rise} at ${p}`); if (rise > 0) steps++; }
      prev = z;
    }
    assert.equal(steps, r.steps, `stairs at ${r.fixed}: ${steps} steps`);
  }
  // the SE ramp is walkable (normal z >= 0.7)
  const tr = traceBox(world, [288, -512, 300], [288, -512, 0], ZERO, ZERO);
  assert.ok(tr.plane && tr.plane.n[2] >= PM.minWalkNormal, 'ramp slope walkable: ' + (tr.plane && tr.plane.n[2]));
});

test('lava_spire: majors >= 512 apart, no item inside solid, every item rests on its floor, no item near lava', () => {
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
    assert.ok(!pointContents(world, [it.origin[0], it.origin[1], it.floorZ + 26], PM.mins, PM.maxs), `${it.type}: player box does not fit`);
    assert.ok(!inLavaXY(it.origin[0], it.origin[1], 15 + 48) || it.floorZ >= Math.max(...lavaBoxes.map((b) => b.maxs[2])) + 128, `${it.type} at ${it.origin} sits on a lava rim`);
  }
  for (const s of map.spawns) {
    assert.ok(!pointContents(world, [s.origin[0], s.origin[1], s.origin[2] + 2], PM.mins, PM.maxs), 'spawn in solid');
    assert.ok(!inLavaXY(s.origin[0], s.origin[1], 15 + 96), `spawn ${s.origin} near lava`);
  }
});

test('lava_spire: majors at opposite ends / heights, no spawn sees both, no spawn sees another spawn', () => {
  const ra = map.items.find((i) => i.type === 'armorRed').origin, mh = map.items.find((i) => i.type === 'mega').origin;
  assert.ok(dist(ra, mh) >= 900, 'majors far apart: ' + dist(ra, mh).toFixed(0));
  assert.ok(Math.abs(ra[2] - mh[2]) >= 64, 'majors on different levels');
  const sees = (eye, p) => traceBox(world, eye, p, ZERO, ZERO).fraction === 1;
  let seesOne = 0;
  for (const s of map.spawns) {
    const eye = [s.origin[0], s.origin[1], s.origin[2] + PM.viewHeight];
    const a = sees(eye, ra), b = sees(eye, mh);
    assert.ok(!(a && b), `spawn ${s.origin} sees both majors`);
    if (a || b) seesOne++;
  }
  assert.ok(seesOne < map.spawns.length, 'at least one spawn sees neither major');
  assert.ok(!sees([ra[0], ra[1], ra[2] + 30], mh), 'red armor has line of sight to mega');
  const eye = (o) => [o[0], o[1], o[2] + PM.viewHeight];
  for (let i = 0; i < map.spawns.length; i++) for (let j = i + 1; j < map.spawns.length; j++) {
    assert.ok(!sees(eye(map.spawns[i].origin), eye(map.spawns[j].origin)), `spawn ${i} sees spawn ${j}`);
  }
  // sightline budget over nav nodes (eye to eye)
  const nodes = nav.nodes.filter((n) => !isPadNode(n));
  let longest = 0, pair = null, checked = 0;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = eye(nodes[i].origin), b = eye(nodes[j].origin);
    const d = dist(a, b);
    if (d <= longest) continue;
    checked++;
    if (sees(a, b)) { longest = d; pair = [nodes[i].origin, nodes[j].origin]; }
  }
  assert.ok(checked > 500, 'traced ' + checked + ' candidate lanes');
  assert.ok(longest <= meta.maxLane, `longest nav-node lane ${longest.toFixed(0)} > ${meta.maxLane} between ${pair && pair.map((p) => p.map((v) => v.toFixed(0)).join(','))}`);
  console.log(`longest eye-to-eye nav lane ${longest.toFixed(0)} between ${pair && pair.map((p) => p.map((v) => v.toFixed(0)).join(',')).join(' and ')}`);
});

// Route verticality (the round-1 critique of Crossfire was a flat lower level): along the shortest nav path between
// Red Armor and Mega Health the floor height must change by >= 64 at least twice, and the walking-only route (no
// pads) between them as well. Also: the lower floor itself is not one plane (nodes at z 0 and z 64 both exist).
test('lava_spire: the RA <-> Mega route changes level at least twice (no flat main route)', () => {
  const ra = map.items.find((i) => i.type === 'armorRed').origin, mh = map.items.find((i) => i.type === 'mega').origin;
  const profile = (allow) => {
    const s = nearest(mh), e = nearest(ra);
    const N = nav.nodes.length, d = new Array(N).fill(Infinity), prev = new Array(N).fill(-1), done = new Array(N).fill(false); d[s] = 0;
    for (;;) {
      let u = -1; for (let i = 0; i < N; i++) if (!done[i] && d[i] < Infinity && (u < 0 || d[i] < d[u])) u = i;
      if (u < 0) break; done[u] = true;
      for (const ed of nav.nodes[u].edges) if (allow(nav.nodes[u], ed, nav.nodes[ed.to])) { const nd = d[u] + ed.cost; if (nd < d[ed.to]) { d[ed.to] = nd; prev[ed.to] = u; } }
    }
    assert.ok(d[e] < Infinity, 'RA reachable from Mega');
    const path = []; for (let c = e; c !== -1; c = prev[c]) path.unshift(nav.nodes[c].origin);
    return { len: d[e], z: path.map((p) => Math.round(p[2] - 24)) };
  };
  const climbs = (z) => { let n = 0, ref = z[0]; for (const v of z) { if (Math.abs(v - ref) >= 64) { n++; ref = v; } } return n; };
  const any = profile(() => true), walk = profile((u) => !isPadNode(u));
  console.log(`RA<->Mega shortest ${any.len.toFixed(0)} u (${(any.len / 320).toFixed(1)} s) z-profile ${any.z.join(' ')}`);
  console.log(`RA<->Mega walking ${walk.len.toFixed(0)} u (${(walk.len / 320).toFixed(1)} s) z-profile ${walk.z.join(' ')}`);
  assert.ok(climbs(any.z) >= 2, 'shortest route level changes: ' + climbs(any.z));
  assert.ok(climbs(walk.z) >= 2, 'walking route level changes: ' + climbs(walk.z));
  const lowZ = new Set(nav.nodes.filter((n) => n.origin[2] < 150).map((n) => Math.round(n.origin[2] - 24)));
  assert.ok(lowZ.has(0) && lowZ.has(64), 'the lower floor has two levels (0 and 64): ' + [...lowZ].join(','));
  const upper = nav.nodes.filter((n) => n.origin[2] - 24 >= 250).length, mid = nav.nodes.filter((n) => Math.abs(n.origin[2] - 24 - 160) < 40).length;
  assert.ok(upper >= 30 && mid >= 40, `nodes per level: upper ${upper}, mid ${mid}`);
});
