// The lighting bake (client/render/bake.worker.js) reads its candidate brushes off a uniform grid instead of scanning
// every brush per ray. The sweep is the shared traceThroughBrush, so the grid must change nothing: this bakes the
// first vertices of every shipped map both ways (grid and brute-force traceBox) and asserts the irradiance matches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMap } from '../shared/map.js';
import { MAPS } from '../maps/index.js';

const { bake } = await import('../client/render/bake.worker.js');
const { buildWorldGeometry, surfaceLights } = await import('../client/render/world.js');

function run(map, positions, normals, grid) {
  const brushes = map.brushes.map((b) => ({ planes: b.planes.map((p) => ({ n: p.n, d: p.d, signbits: p.signbits })), mins: b.mins, maxs: b.maxs, nonsolid: !!b.nonsolid, flags: b.flags | 0, sky: b.mat === 'sky' }));
  const out = new Float32Array(positions.length);
  bake({ brushes, lights: map.lights, surfaceLights: surfaceLights(map), ambient: map.ambient, positions: positions.slice(), normals: normals.slice(), chunk: 4096, params: { grid } }, (m) => { if (!m.done) out.set(m.data, m.from * 3); });
  return out;
}

for (const { id } of MAPS) {
  test(`bake_grid: ${id} grid tracer bakes the same irradiance as the brute-force tracer`, async () => {
    const map = await loadMap(id);
    const { groups } = buildWorldGeometry(map);
    // a slice of vertices from several materials (walls, floors, trims) so every ray kind (AO, light shadow, surface light) runs
    const pos = [], nrm = [];
    for (const g of groups.values()) { const n = Math.min(g.positions.length / 3, 400); for (let i = 0; i < n; i += 4) { pos.push(g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]); nrm.push(g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]); } }
    const positions = new Float32Array(pos), normals = new Float32Array(nrm);
    const a = run(map, positions, normals, true), b = run(map, positions, normals, false);
    let maxDiff = 0, sum = 0;
    for (let i = 0; i < a.length; i++) { maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i])); sum += a[i]; }
    assert.ok(sum > 0, 'the bake produced light');
    assert.ok(maxDiff < 1e-5, `grid and brute-force bakes differ by ${maxDiff} over ${a.length / 3} vertices`);
  });
}
