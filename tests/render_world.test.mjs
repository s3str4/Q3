// Hidden-face culling of the world builder (client/render/world.js): a face may be dropped only when it is entirely
// buried in drawn solid brushes. Pure geometry: the exact convex-subtraction test is checked against a brute-force
// grid of point samples on every face of every shipped map, plus the synthetic room that broke the old heuristic
// (a 224-high wall behind three flush glow strips, whose centre and pulled-in corners all sat inside the strips).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MapBuilder, loadMap } from '../shared/map.js';
import { pointContents } from '../shared/trace.js';
import { polygonArea } from '../shared/brush.js';
import { faceCovered, brushCovers } from '../client/render/world.js';
import { MAPS } from '../maps/index.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };

// Brute force: sample the face on a `spacing` grid (points strictly inside the polygon, lifted 0.5 off the plane)
// and count the samples that lie outside every covering brush. > 0 means the face shows somewhere.
function freeSamples(brushes, own, poly, spacing = 4) {
  const world = { brushes: brushes.filter((b) => b !== own && brushCovers(b)) };
  const n = poly.plane.n, v = poly.verts;
  const u = norm([v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]]), w = norm(cross(n, u));
  let umin = Infinity, umax = -Infinity, wmin = Infinity, wmax = -Infinity;
  for (const p of v) { umin = Math.min(umin, dot(p, u)); umax = Math.max(umax, dot(p, u)); wmin = Math.min(wmin, dot(p, w)); wmax = Math.max(wmax, dot(p, w)); }
  const wind = dot(cross([v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]], [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]]), n) < 0 ? -1 : 1;
  const o = [v[0][0] - u[0] * dot(v[0], u) - w[0] * dot(v[0], w), v[0][1] - u[1] * dot(v[0], u) - w[1] * dot(v[0], w), v[0][2] - u[2] * dot(v[0], u) - w[2] * dot(v[0], w)];
  let free = 0, total = 0;
  for (let a = umin + spacing / 2; a < umax; a += spacing) for (let b = wmin + spacing / 2; b < wmax; b += spacing) {
    const p = [o[0] + u[0] * a + w[0] * b, o[1] + u[1] * a + w[1] * b, o[2] + u[2] * a + w[2] * b];
    let inside = true;
    for (let i = 0; i < v.length && inside; i++) {
      const p0 = v[i], p1 = v[(i + 1) % v.length];
      const e = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], q = [p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]];
      if (dot(cross(e, q), n) * wind < 1e-6) inside = false; // strictly inside: on-edge samples belong to a neighbour
    }
    if (!inside) continue;
    total++;
    if (!pointContents(world, [p[0] + n[0] * 0.5, p[1] + n[1] * 0.5, p[2] + n[2] * 0.5])) free++;
  }
  return { free, total };
}
const faceAt = (b, axis, sign) => b.polys.find((p) => Math.abs(p.plane.n[axis] - sign) < 1e-6);

test('render_world: a wall behind flush glow strips is kept (the 224-high room that vanished)', () => {
  const m = new MapBuilder('strips');
  m.box([-512, -512, -64], [512, 512, 0], 'floor'); m.box([-512, -512, 224], [512, 512, 288], 'ceiling');
  const wall = m.box([-64, -512, 0], [0, 512, 224], 'wall');
  m.box([0, -512, 0], [4, 512, 8], 'trim_warm');      // bottom strip, flush with the wall
  m.box([0, -512, 216], [4, 512, 224], 'trim_warm');  // top strip
  m.box([0, -512, 108], [4, 512, 116], 'glow_warm');  // centre strip: the old centre sample sat inside it
  const map = m.finish();
  const face = faceAt(wall, 0, 1);
  // the old heuristic's samples (centre and 2%-pulled-in corners, lifted 0.5) were indeed all in solid...
  const world = { brushes: map.brushes };
  const c = [0.5, 0, 112];
  assert.ok(pointContents(world, c), 'centre sample is inside the centre strip');
  for (const p of face.verts) assert.ok(pointContents(world, [p[0] * 0.98 + c[0] * 0.02, p[1] * 0.98 + c[1] * 0.02, p[2] * 0.98 + c[2] * 0.02]), 'pulled-in corner is inside a strip');
  // ...yet most of the wall is in plain view
  assert.equal(faceCovered(map.brushes, wall, face), false, 'wall face must not be culled');
  assert.ok(freeSamples(map.brushes, wall, face).free > 0);
});

test('render_world: fully buried faces are culled, gaps and invisible cover keep them', () => {
  const m = new MapBuilder('cover');
  const base = m.box([-64, -128, 0], [0, 128, 128], 'wall');
  // 1. one slab covering the whole face
  m.box([0, -128, 0], [8, 128, 128], 'metal');
  // 2. a second wall whose face is covered by two abutting slabs
  const two = m.box([200, -128, 0], [264, 128, 128], 'wall');
  m.box([264, -128, 0], [272, 128, 64], 'metal'); m.box([264, -128, 64], [272, 128, 128], 'metal');
  // 3. a third wall whose two slabs leave a 2-unit gap
  const gap = m.box([400, -128, 0], [464, 128, 128], 'wall');
  m.box([464, -128, 0], [472, 128, 63], 'metal'); m.box([464, -128, 65], [472, 128, 128], 'metal');
  // 4. a fourth wall behind a player clip brush (invisible: it hides nothing)
  const clipped = m.box([600, -128, 0], [664, 128, 128], 'wall');
  m.clip([664, -128, 0], [672, 128, 128]);
  // 5. a fifth wall behind a slab that overhangs it on every side (bigger than the face)
  const under = m.box([800, -128, 0], [864, 128, 128], 'wall');
  m.box([864, -256, -32], [872, 256, 160], 'metal');
  const map = m.finish();
  assert.equal(faceCovered(map.brushes, base, faceAt(base, 0, 1)), true, 'one slab');
  assert.equal(faceCovered(map.brushes, two, faceAt(two, 0, 1)), true, 'two abutting slabs');
  assert.equal(faceCovered(map.brushes, gap, faceAt(gap, 0, 1)), false, '2-unit gap shows');
  assert.equal(faceCovered(map.brushes, clipped, faceAt(clipped, 0, 1)), false, 'player clip is invisible');
  assert.equal(faceCovered(map.brushes, under, faceAt(under, 0, 1)), true, 'overhanging slab');
  // the base wall's other faces: the back (-x) and the sides are open air
  assert.equal(faceCovered(map.brushes, base, faceAt(base, 0, -1)), false);
  assert.equal(faceCovered(map.brushes, base, faceAt(base, 2, 1)), false);
});

for (const { id } of MAPS) {
  test(`render_world: ${id} never drops a face that has a visible sample (grid vs exact)`, async () => {
    const map = await loadMap(id);
    let faces = 0, culled = 0, wrongCull = 0, thinKeep = 0, thinArea = 0;
    for (const b of map.brushes) {
      if (b.nonsolid || (b.flags & 2)) continue;
      for (const poly of b.polys) {
        faces++;
        const hidden = faceCovered(map.brushes, b, poly);
        const g = freeSamples(map.brushes, b, poly);
        if (hidden) { culled++; if (g.free > 0) wrongCull++; }
        else if (g.total > 0 && g.free === 0) { thinKeep++; thinArea += polygonArea(poly.verts); } // visible only through slivers thinner than the 4-unit grid: kept (harmless)
      }
    }
    console.log(`${id}: ${faces} faces, ${culled} culled, ${wrongCull} culled with a free sample, ${thinKeep} kept on sub-grid slivers`);
    assert.ok(culled > 0, 'the cull does something');
    assert.equal(wrongCull, 0, 'no face with a visible sample is culled');
    assert.ok(thinKeep <= faces * 0.02, `sub-grid keeps stay rare (${thinKeep})`);
  });
}
