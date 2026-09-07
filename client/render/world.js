// World geometry: brush polygons merged into one mesh per material (one draw call each), large faces subdivided
// into a 32-unit grid so the baked per-vertex lighting (AO + shadowed direct light, see bake.worker.js) can vary
// across a wall, and faces buried inside neighbouring solid brushes culled so they neither z-fight nor cost fill.
import * as THREE from 'three';
import { clipPolygon } from '../../shared/brush.js';
import { pointContents } from '../../shared/trace.js';
import { getMaterial } from './materials.js';

const GRID = 32;          // subdivision cell size (world units)
const MIN_SUBDIV = 48;    // faces smaller than this in both directions stay as single polygons

// UV projection axes for a face normal: the two world axes not dominated by the normal (Q3 "world" mapping).
function axesFor(n) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  if (az >= ax && az >= ay) return [[1, 0, 0], [0, 1, 0]];
  if (ax >= ay) return [[0, 1, 0], [0, 0, 1]];
  return [[1, 0, 0], [0, 0, 1]];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Split a convex polygon by a GRID-aligned lattice along (u, v) axes. Returns a list of convex sub-polygons.
function subdivide(verts, u, v) {
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (const p of verts) { const a = dot(p, u), b = dot(p, v); umin = Math.min(umin, a); umax = Math.max(umax, a); vmin = Math.min(vmin, b); vmax = Math.max(vmax, b); }
  if (umax - umin < MIN_SUBDIV && vmax - vmin < MIN_SUBDIV) return [verts];
  const out = [];
  const u0 = Math.floor(umin / GRID) * GRID, v0 = Math.floor(vmin / GRID) * GRID;
  // strips along u, then cells along v (clipPolygon keeps the inside: dot(n,p) <= d)
  for (let a = u0; a < umax; a += GRID) {
    let strip = clipPolygon(verts, { n: [-u[0], -u[1], -u[2]], d: -a });          // p.u >= a
    if (strip.length < 3) continue;
    strip = clipPolygon(strip, { n: u, d: a + GRID });                              // p.u <= a + GRID
    if (strip.length < 3) continue;
    for (let b = v0; b < vmax; b += GRID) {
      let cell = clipPolygon(strip, { n: [-v[0], -v[1], -v[2]], d: -b });
      if (cell.length < 3) continue;
      cell = clipPolygon(cell, { n: v, d: b + GRID });
      if (cell.length >= 3) out.push(cell);
    }
  }
  return out.length ? out : [verts];
}

// Build merged geometry groups: Map(materialName -> { positions, normals, uvs, indices }).
export function buildWorldGeometry(map) {
  const world = { brushes: map.brushes };
  const groups = new Map();
  let culled = 0;
  for (const b of map.brushes) {
    if (b.flags & 2 /* NODRAW */) continue;
    const matName = b.mat || 'wall';
    const material = getMaterial(matName);
    if (material.visible === false) continue;
    if (!groups.has(matName)) groups.set(matName, { positions: [], normals: [], uvs: [], indices: [], keys: new Map() });
    const g = groups.get(matName);
    const scale = material.userData.scale || 128;
    for (const poly of b.polys) {
      const n = poly.plane.n;
      // hidden-face cull: a face buried in neighbouring solid brushes can never be seen. Centre AND every vertex
      // (pushed just outside the face's own brush) must be inside solid: brushes overlap in real maps, and a face
      // whose centre alone is covered may still show at its edges.
      if (!b.nonsolid) {
        const c = [0, 0, 0]; for (const p of poly.verts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
        c[0] = c[0] / poly.verts.length + n[0] * 0.5; c[1] = c[1] / poly.verts.length + n[1] * 0.5; c[2] = c[2] / poly.verts.length + n[2] * 0.5;
        let hidden = pointContents(world, c);
        for (let i = 0; hidden && i < poly.verts.length; i++) {
          const p = poly.verts[i];
          // pull the test point slightly toward the centre so shared edges of adjacent brushes still count as covered
          hidden = pointContents(world, [p[0] * 0.98 + c[0] * 0.02 + n[0] * 0.5, p[1] * 0.98 + c[1] * 0.02 + n[1] * 0.5, p[2] * 0.98 + c[2] * 0.02 + n[2] * 0.5]);
        }
        if (hidden) { culled++; continue; }
      }
      const [u, v] = axesFor(n);
      // winding: polygons from plane clipping may be either orientation; flip so triangles face along the normal
      const a = poly.verts[0], b2 = poly.verts[1], c2 = poly.verts[2];
      const cx = (b2[1] - a[1]) * (c2[2] - a[2]) - (b2[2] - a[2]) * (c2[1] - a[1]);
      const cy = (b2[2] - a[2]) * (c2[0] - a[0]) - (b2[0] - a[0]) * (c2[2] - a[2]);
      const cz = (b2[0] - a[0]) * (c2[1] - a[1]) - (b2[1] - a[1]) * (c2[0] - a[0]);
      const flip = (cx * n[0] + cy * n[1] + cz * n[2]) < 0;
      for (const cell of subdivide(poly.verts, u, v)) {
        const idx = [];
        for (const p of cell) {
          // share vertices between neighbouring cells of the same face (same position + normal)
          const key = `${Math.round(p[0] * 8)},${Math.round(p[1] * 8)},${Math.round(p[2] * 8)},${n[0].toFixed(2)},${n[1].toFixed(2)},${n[2].toFixed(2)}`;
          let i = g.keys.get(key);
          if (i === undefined) {
            i = g.positions.length / 3; g.keys.set(key, i);
            g.positions.push(p[0], p[1], p[2]); g.normals.push(n[0], n[1], n[2]);
            g.uvs.push(dot(p, u) / scale, dot(p, v) / scale);
          }
          idx.push(i);
        }
        for (let i = 1; i + 1 < idx.length; i++) {
          if (flip) g.indices.push(idx[0], idx[i + 1], idx[i]); else g.indices.push(idx[0], idx[i], idx[i + 1]);
        }
      }
    }
  }
  for (const g of groups.values()) delete g.keys;
  return { groups, culled };
}

// Shader injection: the `baked` vertex attribute (RGB irradiance from the bake) is added as indirect diffuse light.
export function bakedMaterial(base) {
  const m = base.clone();
  m.userData = { ...base.userData };
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 baked;\nvarying vec3 vBaked;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBaked = baked;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBaked;')
      // baked irradiance feeds the diffuse term and (there is no environment map) a share of it stands in for the
      // ambient specular metals would otherwise lack, so worn metal panels still catch the room's light
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.indirectDiffuse += vBaked * BRDF_Lambert( diffuseColor.rgb );\nreflectedLight.indirectSpecular += vBaked * material.specularColor * ( 1.0 - 0.75 * material.roughness );');
  };
  m.customProgramCacheKey = () => 'baked';
  return m;
}

// Create the meshes and kick off the bake. Returns { meshes, bake: Promise } — the promise resolves when the bake
// finished (or failed; the world then keeps its flat ambient estimate).
export function buildWorld(scene, map, opts = {}) {
  const { groups, culled } = buildWorldGeometry(map);
  const meshes = [];
  const all = []; // per group: geometry + offset into the combined bake arrays
  let total = 0;
  for (const [name, g] of groups) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uvs, 2));
    geo.setIndex(g.indices);
    geo.computeTangents?.();
    const count = g.positions.length / 3;
    // initial estimate: hemisphere ambient (no AO/shadows yet) so the first frames are lit, not black
    const baked = new Float32Array(count * 3);
    const amb = map.ambient || {}; const [sky, ground] = hemiColors(amb);
    const hemiI = amb.hemi ? amb.hemi[2] : 0.35;
    for (let i = 0; i < count; i++) { const k = g.normals[i * 3 + 2] * 0.5 + 0.5; for (let c = 0; c < 3; c++) baked[i * 3 + c] = (sky[c] * k + ground[c] * (1 - k)) * hemiI; }
    geo.setAttribute('baked', new THREE.BufferAttribute(baked, 3));
    const base = getMaterial(name);
    const mesh = new THREE.Mesh(geo, base.userData.unlit ? base : bakedMaterial(base));
    mesh.userData.world = true; mesh.matrixAutoUpdate = false; mesh.frustumCulled = true;
    scene.add(mesh); meshes.push(mesh);
    all.push({ geo, offset: total, count }); total += count;
  }
  const stats = { vertices: total, triangles: [...groups.values()].reduce((s, g) => s + g.indices.length / 3, 0), drawCalls: groups.size, culledFaces: culled };
  const bake = runBake(map, all, total, opts).catch((e) => { console.warn('bake failed', e); });
  return { meshes, bake, stats };
}

function hemiColors(amb) {
  const hex = (c) => { const v = parseInt(String(c).replace('#', ''), 16); return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255].map((x) => Math.pow(x, 2.2)); };
  return [hex(amb.hemi ? amb.hemi[0] : '#8fa3c7'), hex(amb.hemi ? amb.hemi[1] : '#20160f')];
}

function runBake(map, groups, total, opts) {
  return new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined') return reject(new Error('no Worker'));
    const positions = new Float32Array(total * 3), normals = new Float32Array(total * 3);
    for (const g of groups) { positions.set(g.geo.attributes.position.array, g.offset * 3); normals.set(g.geo.attributes.normal.array, g.offset * 3); }
    // only what the tracer needs (polys are dropped to keep the structured clone small)
    const brushes = map.brushes.map((b) => ({ planes: b.planes.map((p) => ({ n: p.n, d: p.d, signbits: p.signbits })), mins: b.mins, maxs: b.maxs, nonsolid: !!b.nonsolid, flags: b.flags | 0 }));
    let worker;
    try { worker = new Worker(new URL('./bake.worker.js', import.meta.url), { type: 'module' }); } catch (e) { return reject(e); }
    const t0 = performance.now();
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'worker error')); };
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.done) { worker.terminate(); if (opts.onProgress) opts.onProgress(1); resolve({ ms: performance.now() - t0 }); return; }
      // scatter the chunk into the geometries it spans
      const from = m.from, data = m.data, n = data.length / 3;
      for (const g of groups) {
        const gStart = Math.max(from, g.offset), gEnd = Math.min(from + n, g.offset + g.count);
        if (gStart >= gEnd) continue;
        const attr = g.geo.attributes.baked;
        attr.array.set(data.subarray((gStart - from) * 3, (gEnd - from) * 3), (gStart - g.offset) * 3);
        attr.needsUpdate = true;
      }
      if (opts.onProgress) opts.onProgress((from + n) / total);
    };
    worker.postMessage({ brushes, lights: map.lights, ambient: map.ambient || {}, positions, normals, chunk: 2048 }, [positions.buffer, normals.buffer]);
  });
}
