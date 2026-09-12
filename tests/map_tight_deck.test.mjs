// Tight Deck acceptance suite (docs/BENCHMARK.md "Maps" + the tight-map rules): enclosure, reachability by bot
// navigation (no direct-goal fallback), player-box clearance along every nav edge, corridor widths / ceilings, stair
// rises and runs, major spacing on different levels, items resting on floors, spawn / major sightlines, the
// teleporter (reachable, not in solid, physically delivers the player), the horizontal eye-height free-segment budget
// (<= 768 from every nav node and along every nav edge direction) and route verticality (RA <-> Mega changes level
// at least twice; every loop leg changes height).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMap, BRUSH_FLAGS } from '../shared/map.js';
import { meta } from '../maps/tight_deck.js';
import { Game } from '../shared/game.js';
import { buildNavGraph, findPath } from '../shared/bot.js';
import { traceBox, pointContents } from '../shared/trace.js';
import { PM, ITEMS, EV } from '../shared/constants.js';

const map = await loadMap('tight_deck');
const game = new Game(map, { mode: 'duel', seed: 1 });
const world = game.world;
const nav = buildNavGraph(game);
const ZERO = [0, 0, 0];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const nearest = (p) => { let bi = -1, bd = Infinity; for (const n of nav.nodes) { const d = dist(n.origin, p); if (d < bd) { bd = d; bi = n.i; } } return bi; };
const eye = (o) => [o[0], o[1], o[2] + PM.viewHeight];
const sees = (a, b) => traceBox(world, a, b, ZERO, ZERO).fraction === 1;
const item = (type) => map.items.find((i) => i.type === type);
const teleporters = map.triggers.filter((t) => t.kind === 'teleporter');
const pads = map.triggers.filter((t) => t.kind === 'jumppad');
const triggerCentre = (t) => [(t.mins[0] + t.maxs[0]) / 2, (t.mins[1] + t.maxs[1]) / 2, t.mins[2] + 24];
const isTriggerNode = (n) => [...teleporters, ...pads].some((t) => { const c = triggerCentre(t); return Math.abs(n.origin[0] - c[0]) < 1 && Math.abs(n.origin[1] - c[1]) < 1; });

// 26 axis/diagonal directions plus a deterministic fan of 40 irrational-ish directions
const DIRS = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) { const l = Math.hypot(x, y, z); DIRS.push([x / l, y / l, z / l]); }
for (let i = 0; i < 40; i++) { const t = i * 2.399963, ph = Math.acos(1 - 2 * ((i + 0.5) / 40)); DIRS.push([Math.sin(ph) * Math.cos(t), Math.sin(ph) * Math.sin(t), Math.cos(ph)]); }

test('tight deck: basic content', () => {
  assert.equal(map.title, 'Tight Deck');
  assert.ok(map.spawns.length >= 5 && map.spawns.length <= 6, 'spawns 5-6');
  const types = map.items.map((i) => i.type);
  for (const t of ['mega', 'armorRed', 'weaponRocket', 'weaponRail', 'weaponLightning', 'weaponShotgun', 'weaponPlasma', 'ammoRockets', 'ammoSlugs', 'ammoCells', 'ammoShells', 'ammoPlasma', 'ammoBullets']) assert.ok(types.includes(t), 'has ' + t);
  assert.equal(types.filter((t) => t === 'armorYellow').length, 2);
  assert.ok(types.filter((t) => t === 'health25').length >= 2, 'health25 x2+');
  assert.ok(types.filter((t) => t === 'health5').length >= 6, 'health5 clusters');
  assert.ok(types.filter((t) => t === 'armorShard').length >= 6, 'armor shard clusters');
  assert.ok(map.lights.length <= 14, 'at most 14 lights');
  assert.ok(map.ambient && map.ambient.hemi, 'ambient set');
  assert.ok(pads.length >= 1 && pads.length <= 2, 'one or two jump pads');
  assert.equal(teleporters.length, 1, 'one teleporter');
  for (const it of map.items) assert.equal(it.origin[2], it.floorZ + 20, `${it.type} origin 20 above its floor`);
  for (const l of map.lights.slice(0, 4)) assert.notEqual(l.shadow, false, 'the first four lights cast shadows');
});

test('tight deck: enclosed (no leak): point traces from every nav node, spawn and item hit geometry within 8192', () => {
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

test('tight deck: nav graph connects every spawn to every item, every other spawn and the teleporter exit (no direct-goal fallback)', () => {
  const reach = (s) => { const seen = new Set([s]); const st = [s]; while (st.length) { const u = st.pop(); for (const e of nav.nodes[u].edges) if (!seen.has(e.to)) { seen.add(e.to); st.push(e.to); } } return seen; };
  const goals = [...map.items.map((i) => ({ what: i.type, origin: i.origin })), ...map.spawns.map((s, k) => ({ what: 'spawn' + k, origin: s.origin })), ...teleporters.map((t) => ({ what: 'teleporter exit', origin: t.dest }))];
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
  const all = reach(nearest(map.spawns[0].origin));
  const orphans = nav.nodes.filter((n) => !all.has(n.i));
  assert.equal(orphans.length, 0, 'orphan nav nodes: ' + orphans.map((n) => n.origin).join(' | '));
  // and every node can get back to spawn 0 (no one-way pockets a bot could be pathed into)
  const back = nav.nodes.map(() => []);
  for (const n of nav.nodes) for (const e of n.edges) back[e.to].push(n.i);
  const home = new Set([nearest(map.spawns[0].origin)]); const st = [...home];
  while (st.length) { const u = st.pop(); for (const v of back[u]) if (!home.has(v)) { home.add(v); st.push(v); } }
  const stranded = nav.nodes.filter((n) => !home.has(n.i));
  assert.equal(stranded.length, 0, 'nodes with no way home: ' + stranded.map((n) => n.origin).join(' | '));
  assert.ok(nav.nodes.length >= 200, 'dense nav: ' + nav.nodes.length + ' nodes');
});

test('tight deck: the upper levels are reachable by stairs (walking only) and the gallery by the jump pad', () => {
  const upper = nav.nodes.filter((n) => n.origin[2] > 150);
  assert.ok(upper.length >= 40, 'upper nav nodes: ' + upper.length);
  // walking-only reachability (no pad launch, no teleport) from the core spawn (z 0) must still reach every level
  const teleNodes = new Set(nav.nodes.filter((n) => teleporters.some((t) => { const c = triggerCentre(t); return Math.abs(n.origin[0] - c[0]) < 1 && Math.abs(n.origin[1] - c[1]) < 1; })).map((n) => n.i));
  const walkOnly = nav.nodes.map((n) => n.edges.filter((e) => nav.nodes[e.to].origin[2] - n.origin[2] < 60 && !(teleNodes.has(n.i) && e.cost === 10)).map((e) => e.to));
  const seen = new Set(); const st = [nearest(map.spawns[3].origin)]; seen.add(st[0]);
  while (st.length) { const u = st.pop(); for (const v of walkOnly[u]) if (!seen.has(v)) { seen.add(v); st.push(v); } }
  for (const [x, y, z, what] of [[0, 160, 216, 'gallery'], [-448, 640, 216, 'RA deck'], [-736, 752, 232, 'RA room'], [592, 560, 248, 'NE deck'], [40, 640, 152, 'north junction'], [736, -256, 120, 'east mid'], [-576, 32, 120, 'west mid'], [592, -736, 72, 'SE room']]) {
    const n = nearest([x, y, z]);
    assert.ok(dist(nav.nodes[n].origin, [x, y, z]) < 64 && seen.has(n), `${what} reachable by walking (stairs) from the core spawn`);
  }
  // the pad has a launch edge to a node on the gallery level
  for (const t of pads) {
    const pad = nav.nodes.find((n) => n.pad && Math.abs(n.origin[0] - (t.mins[0] + t.maxs[0]) / 2) < 1);
    assert.ok(pad, 'pad node exists');
    assert.ok(pad.edges.some((e) => nav.nodes[e.to].origin[2] > 150), 'pad launches to the upper level');
  }
});

test('tight deck: the jump pad physically lands the player on the gallery', () => {
  for (const t of pads) {
    const g = new Game(map, { mode: 'duel', seed: 3, rules: { warmup: 0 } });
    const p = g.addPlayer(1, 'pad', {});
    p.ps.origin = triggerCentre(t); p.ps.velocity = [0, 0, 0]; p.dead = false;
    let launched = false, maxZ = 0, landed = null;
    for (let i = 0; i < 180; i++) {
      g.queueCommand(1, { seq: i + 1, forward: 0, right: 0, up: 0, buttons: 0, angles: [0, 0, 0], weapon: 0, vt: 0 });
      for (const e of g.step()) if (e.type === EV.JUMPPAD) launched = true;
      maxZ = Math.max(maxZ, p.ps.origin[2]);
      if (launched && i > 20 && p.ps.groundEntity) { landed = [...p.ps.origin]; break; }
    }
    assert.ok(launched, 'pad fired');
    assert.ok(landed, 'player landed within 3 s');
    assert.ok(landed[2] >= meta.levels.upper + 20, `pad at ${t.mins} dropped the player at z=${landed[2].toFixed(1)} (max z ${maxZ.toFixed(0)})`);
    assert.ok(Math.hypot(landed[0] - t.target[0], landed[1] - t.target[1]) < 320, 'landed near the target: ' + landed);
    assert.ok(maxZ + PM.maxs[2] < 384, 'the flight stays under the core ceiling');
  }
});

test('tight deck: the teleporter exit is clear, on a nav node, and a player walking into the portal arrives there', () => {
  const t = teleporters[0];
  assert.ok(!pointContents(world, [t.dest[0], t.dest[1], t.dest[2] + 2], PM.mins, PM.maxs), 'teleporter destination is inside solid');
  const down = traceBox(world, t.dest, [t.dest[0], t.dest[1], t.dest[2] - 64], PM.mins, PM.maxs);
  assert.ok(down.fraction < 1 && down.endpos[2] > t.dest[2] - 2, 'teleporter destination stands on a floor: ' + down.endpos);
  assert.ok(dist(nav.nodes[nearest(t.dest)].origin, t.dest) < 32, 'a nav node sits on the destination');
  const c = triggerCentre(t);
  const node = nav.nodes.find((n) => Math.abs(n.origin[0] - c[0]) < 1 && Math.abs(n.origin[1] - c[1]) < 1);
  assert.ok(node && node.edges.some((e) => e.cost === 10), 'teleporter node with its exit edge');
  assert.ok(nav.nodes.filter((n) => n.edges.some((e) => e.to === node.i)).length >= 6, 'the portal is walkable from the Mega pit');
  // physically: stand 64 in front of the portal and walk into it
  const g = new Game(map, { mode: 'duel', seed: 5, rules: { warmup: 0 } });
  const p = g.addPlayer(1, 'tele', {});
  p.ps.origin = [c[0], t.maxs[1] + 64, c[2]]; p.ps.velocity = [0, 0, 0]; p.dead = false;
  let teleported = false;
  for (let i = 0; i < 120 && !teleported; i++) {
    g.queueCommand(1, { seq: i + 1, forward: 127, right: 0, up: 0, buttons: 0, angles: [0, -90, 0], weapon: 0, vt: 0 });
    for (const e of g.step()) if (e.type === EV.TELEPORT) teleported = true;
  }
  assert.ok(teleported, 'walking into the portal fires the teleporter');
  assert.ok(Math.hypot(p.ps.origin[0] - t.dest[0], p.ps.origin[1] - t.dest[1]) < 64, 'arrived at the destination: ' + p.ps.origin);
  for (let i = 0; i < 30; i++) { g.queueCommand(1, { seq: 200 + i, forward: 0, right: 0, up: 0, buttons: 0, angles: [0, t.destYaw, 0], weapon: 0, vt: 0 }); g.step(); }
  assert.ok(p.ps.groundEntity && p.ps.origin[2] > t.dest[2] - 8, 'stands on the deck after arriving: z ' + p.ps.origin[2]);
});

// Re-walk each edge the way the bot navigation does and assert the player box is never inside solid, no horizontal
// sweep is blocked and the walk arrives at the far node. Returns null or the failure reason.
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
    const head = traceBox(world, cur, [cur[0], cur[1], cur[2] + 8], PM.mins, PM.maxs);
    if (head.fraction < 1) return `no head room at sample ${s}`;
  }
  if (!(Math.abs(cur[2] - b[2]) < 40 && Math.hypot(cur[0] - b[0], cur[1] - b[1]) < 40)) return 'does not arrive';
  return null;
}

test('tight deck: player-box clearance along every nav edge', () => {
  let checked = 0, jumps = 0, sweeps = 0;
  for (const n of nav.nodes) for (const e of n.edges) {
    if (n.pad && nav.nodes[e.to].origin[2] - n.origin[2] > 60) continue;   // pad launch edge (covered above)
    if (isTriggerNode(n) && e.cost === 10) continue;                       // teleporter exit edge (covered above)
    const a = n.origin, b = nav.nodes[e.to].origin;
    assert.ok(!pointContents(world, [a[0], a[1], a[2] + 1], PM.mins, PM.maxs), `node ${a} is inside solid`);
    assert.ok(!pointContents(world, [b[0], b[1], b[2] + 1], PM.mins, PM.maxs), `node ${b} is inside solid`);
    const why = walkEdge(a, b);
    if (e.jump) {
      jumps++;
      if (why) {
        const z = Math.max(a[2], b[2]) + 44;
        const tr = traceBox(world, [a[0], a[1], z], [b[0], b[1], z], PM.mins, PM.maxs);
        assert.ok(tr.fraction === 1 && !tr.startsolid, `jump edge ${a} -> ${b} ${why} and passes through solid at jump height`);
        sweeps++;
      }
    } else assert.equal(why, null, `edge ${a} -> ${b} ${why}`);
    checked++;
  }
  assert.ok(checked > 1000, 'checked ' + checked + ' edges (' + jumps + ' jump edges, ' + sweeps + ' by sweep)');
});

test('tight deck: corridors >= 96 wide and ceilings >= 128 (halls) / >= 192 (rooms)', () => {
  assert.ok(meta.rooms.length >= 20, 'rooms declared: ' + meta.rooms.length);
  for (const r of meta.rooms) {
    const w = Math.min(r.maxs[0] - r.mins[0], r.maxs[1] - r.mins[1]), h = r.maxs[2] - r.mins[2];
    assert.ok(w >= 96, `${r.name} width ${w}`);
    assert.ok(h >= (r.cls === 'room' ? 192 : 128), `${r.name} height ${h}`);
  }
  assert.ok(meta.corridorSamples.length >= 20);
  for (const s of meta.corridorSamples) {
    assert.ok(!pointContents(world, s.at), `corridor sample ${s.at} is inside solid`);
    const d = [0, 0, 0]; d[s.axis] = 1;
    const a = traceBox(world, s.at, [s.at[0] + d[0] * 4096, s.at[1] + d[1] * 4096, s.at[2]], ZERO, ZERO);
    const b = traceBox(world, s.at, [s.at[0] - d[0] * 4096, s.at[1] - d[1] * 4096, s.at[2]], ZERO, ZERO);
    const width = dist(a.endpos, b.endpos);
    // the trace stops 0.125 short of each face, so an exactly-96 void measures 95.75
    assert.ok(width >= 96 - 0.5, `corridor at ${s.at} is ${width} wide`);
    const up = traceBox(world, s.at, [s.at[0], s.at[1], s.at[2] + 4096], ZERO, ZERO);
    const dn = traceBox(world, s.at, [s.at[0], s.at[1], s.at[2] - 4096], ZERO, ZERO);
    assert.ok(up.endpos[2] - dn.endpos[2] >= 128 - 0.5, `corridor at ${s.at} ceiling ${up.endpos[2] - dn.endpos[2]}`);
  }
});

// Every flight: probe the floor along its centreline every 8 units; each rise must be <= 16 and the run between
// two rises >= 24 (Q3 step 18). The flights are named by their hall in maps/tight_deck.js (wsB starts at the west wall,
// so its first riser is in the wall and the probe sees two).
test('tight deck: every stair flight rises <= 16 per step with runs >= 24', () => {
  const flights = [
    ['wsA', [-736, -376], [-736, -232], 3, 0], ['wsB', [-776, -144], [-664, -144], 2, 64], ['wlB', [-336, 40], [-336, 280], 6, 0],
    ['wsC1', [-736, 328], [-736, 472], 3, 96], ['wsC2', [-696, 528], [-552, 528], 3, 144], ['nA', [-200, 656], [-376, 656], 4, 128],
    ['nC', [72, 528], [248, 528], 4, 128], ['nT1', [288, 552], [288, 664], 2, 192], ['nLink', [-80, 408], [-80, 232], 4, 128],
    ['esA', [736, 200], [736, 504], 8, 96], ['elB', [336, -40], [336, -280], 6, 0], ['sB', [-272, -424], [-272, -568], 3, 0], ['seRoom', [736, -472], [736, -328], 3, 48],
  ];
  for (const [name, from, to, steps, base] of flights) {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    let prev = null, rises = 0, lastRiseAt = -Infinity, minRun = Infinity, maxRise = 0;
    for (let s = 0; s <= len; s += 8) {
      const x = from[0] + (to[0] - from[0]) * s / len, y = from[1] + (to[1] - from[1]) * s / len;
      const z = traceBox(world, [x, y, base + 16 * steps + 40], [x, y, base - 40], ZERO, ZERO).endpos[2];   // start under the hall's ceiling
      if (prev !== null && z !== prev) {
        const rise = z - prev;
        assert.ok(rise > 0 && rise <= 16 + 1e-6, `${name}: rise ${rise} at ${x},${y}`);
        maxRise = Math.max(maxRise, rise);
        if (lastRiseAt > -Infinity) minRun = Math.min(minRun, s - lastRiseAt);
        lastRiseAt = s; rises++;
      }
      prev = z;
    }
    assert.equal(rises, steps, `${name}: ${rises} rises (expected ${steps})`);
    if (steps > 1) assert.ok(minRun >= 24, `${name}: run ${minRun} < 24`);
    assert.ok(maxRise <= 16, `${name}: max rise ${maxRise}`);
  }
});

test('tight deck: majors >= 512 apart, RA and Mega on different levels, no item inside solid, every item rests on its floor', () => {
  const majors = map.items.filter((i) => ITEMS[i.type].major);
  assert.ok(majors.length >= 5);
  for (let i = 0; i < majors.length; i++) for (let j = i + 1; j < majors.length; j++) {
    const d = dist(majors[i].origin, majors[j].origin);
    assert.ok(d >= 512, `${majors[i].type} and ${majors[j].type} are ${d.toFixed(0)} apart`);
  }
  const ra = item('armorRed'), mh = item('mega');
  assert.ok(Math.abs(ra.floorZ - mh.floorZ) >= 96, `RA (z ${ra.floorZ}) and Mega (z ${mh.floorZ}) share a height level`);
  assert.ok(dist(ra.origin, mh.origin) >= 1000, 'RA and Mega are on opposite sides of the deck');
  const H = [-15, -15, -15], Hx = [15, 15, 15];
  for (const it of map.items) {
    assert.ok(!pointContents(world, it.origin, H, Hx), `${it.type} at ${it.origin} intersects solid`);
    const down = traceBox(world, it.origin, [it.origin[0], it.origin[1], it.origin[2] - 64], ZERO, ZERO);
    assert.ok(down.fraction < 1 && Math.abs(down.endpos[2] - it.floorZ) < 1, `${it.type} floats above its floor (${down.endpos[2]} vs ${it.floorZ})`);
    assert.ok(!pointContents(world, [it.origin[0], it.origin[1], it.floorZ + 26], PM.mins, PM.maxs), `${it.type}: player box does not fit`);
  }
  for (const s of map.spawns) assert.ok(!pointContents(world, [s.origin[0], s.origin[1], s.origin[2] + 2], PM.mins, PM.maxs), 'spawn in solid');
});

test('tight deck: no spawn sees both majors, no spawn sees another spawn, rail does not see lightning, RA does not see Mega', () => {
  const ra = item('armorRed').origin, mh = item('mega').origin;
  let seesOne = 0;
  for (const s of map.spawns) {
    const e = eye(s.origin);
    const a = sees(e, ra), b = sees(e, mh);
    assert.ok(!(a && b), `spawn ${s.origin} sees both majors`);
    if (a || b) seesOne++;
  }
  assert.ok(seesOne < map.spawns.length, 'at least one spawn sees neither major');
  assert.ok(!sees([ra[0], ra[1], ra[2] + 30], mh), 'red armor has line of sight to mega');
  for (let i = 0; i < map.spawns.length; i++) for (let j = i + 1; j < map.spawns.length; j++) {
    assert.ok(!sees(eye(map.spawns[i].origin), eye(map.spawns[j].origin)), `spawn ${i} sees spawn ${j}`);
  }
  const stand = (it) => eye([it.origin[0], it.origin[1], it.floorZ + 24]);
  assert.ok(!sees(stand(item('weaponRail')), stand(item('weaponLightning'))), 'a player on the rail gun sees a player on the lightning gun');
});

// Sightline budget for the tight map: (1) from every nav node, a horizontal eye-height ray in each of 48 yaws is
// free for at most meta.maxFree (768) units; (2) the same along the direction of every nav edge; (3) the longest
// eye-to-eye lane between any two nav nodes (any pitch) is within meta.maxLane (1100).
test('tight deck: no horizontal eye-height free segment longer than 768; longest nav lane within meta.maxLane', () => {
  const nodes = nav.nodes.filter((n) => !n.pad);
  const YAWS = 48;
  let worst = 0, worstAt = null;
  for (const n of nodes) {
    const e = eye(n.origin);
    for (let k = 0; k < YAWS; k++) {
      const a = k / YAWS * Math.PI * 2;
      const tr = traceBox(world, e, [e[0] + Math.cos(a) * 4096, e[1] + Math.sin(a) * 4096, e[2]], ZERO, ZERO);
      const d = tr.fraction * 4096;
      if (d > worst) { worst = d; worstAt = [n.origin, Math.round(a * 180 / Math.PI)]; }
    }
  }
  assert.ok(worst <= meta.maxFree, `free segment ${worst.toFixed(0)} from ${worstAt && worstAt[0]} at yaw ${worstAt && worstAt[1]} exceeds ${meta.maxFree}`);
  assert.ok(worst >= 500, 'the rooms are not closets: longest free segment ' + worst.toFixed(0));
  let worstE = 0, worstEdge = null;
  for (const n of nodes) for (const ed of n.edges) {
    const b = nav.nodes[ed.to].origin; const dx = b[0] - n.origin[0], dy = b[1] - n.origin[1]; const l = Math.hypot(dx, dy); if (l < 1) continue;
    const e = eye(n.origin); const tr = traceBox(world, e, [e[0] + dx / l * 4096, e[1] + dy / l * 4096, e[2]], ZERO, ZERO);
    if (tr.fraction * 4096 > worstE) { worstE = tr.fraction * 4096; worstEdge = [n.origin, b]; }
  }
  assert.ok(worstE <= meta.maxFree, `free segment ${worstE.toFixed(0)} along edge ${worstEdge && worstEdge.map((p) => p.join(','))} exceeds ${meta.maxFree}`);
  let longest = 0, pair = null, checked = 0;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = eye(nodes[i].origin), b = eye(nodes[j].origin);
    const d = dist(a, b);
    if (d <= longest) continue;
    checked++;
    if (sees(a, b)) { longest = d; pair = [nodes[i].origin, nodes[j].origin]; }
  }
  assert.ok(checked > 1000, 'traced ' + checked + ' candidate lanes');
  assert.ok(longest <= meta.maxLane, `longest nav-node lane ${longest.toFixed(0)} > ${meta.maxLane} between ${pair && pair.map((p) => p.map((v) => v.toFixed(0)).join(','))}`);
});

// Route verticality: the shortest nav path between RA and Mega (both directions) changes level (>= 64) at least
// twice, and every leg of the outer loop changes height (no flat plane anywhere on the main routes).
test('tight deck: RA <-> Mega routes change level at least twice; every loop leg changes height', () => {
  const ra = item('armorRed').origin, mh = item('mega').origin;
  const lift = (o) => [o[0], o[1], o[2] + 4];
  for (const [from, to, label] of [[ra, mh, 'RA -> Mega'], [mh, ra, 'Mega -> RA']]) {
    const path = findPath(nav, lift(from), lift(to));
    assert.ok(path.length >= 4 && path.slice(0, -1).every((n) => typeof n.i === 'number'), label + ': real nav path');
    let changes = 0, ref = path[0].origin[2];
    for (const n of path) if (Math.abs(n.origin[2] - ref) >= 64) { changes++; ref = n.origin[2]; }
    assert.ok(changes >= 2, `${label}: z profile changes by >= 64 only ${changes} time(s): ${path.map((n) => n.origin[2].toFixed(0)).join(' ')}`);
  }
  const legs = [
    ['Mega pit', [-576, -576, 24], 'west mid', [-640, 144, 120]], ['west mid', [-640, 144, 120], 'RA deck', [-448, 500, 216]],
    ['RA deck', [-448, 500, 216], 'NE deck', [592, 640, 248]], ['NE deck', [592, 640, 248], 'east mid', [640, -128, 120]],
    ['east mid', [640, -128, 120], 'SE room', [592, -576, 72]], ['SE room', [592, -576, 72], 'Mega pit', [-576, -576, 24]],
    ['west mid', [-640, 144, 120], 'core', [-160, 160, 24]], ['east mid', [640, -128, 120], 'core', [160, -160, 24]], ['core', [160, -160, 24], 'north junction', [40, 640, 152]],
  ];
  for (const [a, from, b, to] of legs) {
    const path = findPath(nav, from, to);
    assert.ok(path.length >= 2 && path.slice(0, -1).every((n) => typeof n.i === 'number'), `${a} -> ${b}: real nav path`);
    const zs = path.map((n) => n.origin[2]);
    assert.ok(Math.max(...zs) - Math.min(...zs) >= 48, `${a} -> ${b} is flat: z ${zs.map((z) => z.toFixed(0)).join(' ')}`);
  }
});
