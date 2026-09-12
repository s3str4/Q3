// World geometry: brush polygons merged into one mesh per material (one draw call each), large faces subdivided
// into a 32-unit grid so the baked per-vertex lighting (AO + shadowed direct light, see bake.worker.js) can vary
// across a wall, and faces buried inside neighbouring solid brushes culled so they neither z-fight nor cost fill.
import * as THREE from 'three';
import { clipPolygon, polygonArea } from '../../shared/brush.js';
import { pointContents } from '../../shared/trace.js';
import { getMaterial, MATERIAL_DEFS } from './materials.js';

const GRID = 32;          // subdivision cell size (world units)
const MIN_SUBDIV = 48;    // faces smaller than this in both directions stay as single polygons
const FACE_LIFT = 0.5;    // hidden-face test: the face is examined this far outside its own brush
const COVER_AREA_EPS = 1; // fragments below this area (units^2) are clipping residue, not visible surface

// Does a brush hide the faces buried in it? Only drawn solid brushes do: a trigger, a player clip or an invisible
// (nodraw / clip material) brush leaves whatever sits behind it in full view.
export function brushCovers(b) {
  if (b.nonsolid || (b.flags & 6 /* NODRAW | PLAYERCLIP */)) return false;
  const def = MATERIAL_DEFS[b.mat || 'wall'];
  return !(def && def.invisible);
}
// Exact hidden-face test. The face polygon, lifted FACE_LIFT off its plane, has every covering brush subtracted from
// it (convex clipping: the part outside each brush plane is kept, the part inside all of them is dropped); the face
// is hidden only when nothing with a visible area remains. Sampling points (the old centre + corners heuristic)
// culled a 224-high wall whose centre and corners happened to sit inside flush glow strips while the rest showed.
export function faceCovered(brushes, own, poly, lift = FACE_LIFT) {
  const n = poly.plane.n;
  let frags = [poly.verts.map((p) => [p[0] + n[0] * lift, p[1] + n[1] * lift, p[2] + n[2] * lift])];
  const mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity];
  for (const p of frags[0]) for (let i = 0; i < 3; i++) { mins[i] = Math.min(mins[i], p[i]); maxs[i] = Math.max(maxs[i], p[i]); }
  for (const b of brushes) {
    if (b === own || !brushCovers(b)) continue;
    if (b.mins[0] > maxs[0] || b.maxs[0] < mins[0] || b.mins[1] > maxs[1] || b.maxs[1] < mins[1] || b.mins[2] > maxs[2] || b.maxs[2] < mins[2]) continue;
    const next = [];
    for (const f of frags) {
      let inside = f;
      for (const pl of b.planes) {
        const out = clipPolygon(inside, { n: [-pl.n[0], -pl.n[1], -pl.n[2]], d: -pl.d }); // the part beyond this plane stays visible
        if (out.length >= 3 && polygonArea(out) > COVER_AREA_EPS) next.push(out);
        inside = clipPolygon(inside, pl);
        if (inside.length < 3) break;
      }
      // whatever is left in `inside` lies within the brush: covered
    }
    frags = next;
    if (!frags.length) return true;
  }
  return false;
}

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
      // hidden-face cull: a face buried in neighbouring drawn solid brushes can never be seen (exact test, see faceCovered)
      if (!b.nonsolid && faceCovered(map.brushes, b, poly)) { culled++; continue; }
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

// Shader injection for world meshes. The `baked` vertex attribute (RGB irradiance from the bake: AO x hemisphere,
// shadowed direct light, one bounce) is the world's diffuse lighting, like a Q3 lightmap. The scene's real-time
// lights are treated per kind:
//   - map lights (decay == MAP_LIGHT_DECAY, see renderer.js): only MAP_LIGHT_DIFFUSE of their diffuse and
//     MAP_LIGHT_SPECULAR of their specular, so the baked shadows and AO are not filled back in and an unshadowed
//     key light cannot glaze a whole room's panels with one broad highlight (that glaze is what flattened the cool
//     atrium of arena_duel into a monochrome wash); enough specular is kept for the normal maps to catch the light;
//   - the effect LightPool, item glow lights and portal lights (decay 2 / 1.8): full contribution (explosions and
//     muzzle flashes must light the world);
//   - the hemisphere light: ignored (the bake already carries it, occluded); it only lights players and items.
export const MAP_LIGHT_DECAY = 1.5;
const MAP_LIGHT_DIFFUSE = 0.1;
const MAP_LIGHT_SPECULAR = 0.3;
// No environment map exists, so metalness above this only deletes the baked diffuse (a Q3 lightmap look wants the
// bake on every surface); world materials are clamped here whatever materials.js says.
const WORLD_MAX_METALNESS = 0.35;
function patchBlock(src, startMarker, fn) {
  const i = src.indexOf(startMarker); if (i < 0) return src;
  const j = src.indexOf('#pragma unroll_loop_end', i);
  return src.slice(0, i) + fn(src.slice(i, j)) + src.slice(j);
}
const RE_DIRECT = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
const MIX = (d, s) => `reflectedLight.directDiffuse = mix( ${d}, reflectedLight.directDiffuse, ${MAP_LIGHT_DIFFUSE.toFixed(2)} ); reflectedLight.directSpecular = mix( ${s}, reflectedLight.directSpecular, ${MAP_LIGHT_SPECULAR.toFixed(2)} );`;
let worldLightsChunk = THREE.ShaderChunk.lights_fragment_begin;
worldLightsChunk = patchBlock(worldLightsChunk, '#if ( NUM_POINT_LIGHTS > 0 )', (b) => b
  .replace('PointLight pointLight;', 'PointLight pointLight;\n\tvec3 prevDiffuse, prevSpecular;')
  .replace(RE_DIRECT, `prevDiffuse = reflectedLight.directDiffuse; prevSpecular = reflectedLight.directSpecular;\n\t\t${RE_DIRECT}\n\t\tif ( pointLight.decay < ${(MAP_LIGHT_DECAY + 0.25).toFixed(2)} ) { ${MIX('prevDiffuse', 'prevSpecular')} }`));
worldLightsChunk = patchBlock(worldLightsChunk, '#if ( NUM_DIR_LIGHTS > 0 )', (b) => b
  .replace('DirectionalLight directionalLight;', 'DirectionalLight directionalLight;\n\tvec3 prevDiffuseD, prevSpecularD;')
  .replace(RE_DIRECT, `prevDiffuseD = reflectedLight.directDiffuse; prevSpecularD = reflectedLight.directSpecular;\n\t\t${RE_DIRECT}\n\t\t${MIX('prevDiffuseD', 'prevSpecularD')}`));
worldLightsChunk = worldLightsChunk.replace('irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );', '');
if (!worldLightsChunk.includes('prevDiffuse =')) console.warn('world shader patch did not apply (three.js chunk changed?)');

// Overbright clamp (irradiance units; the shader divides by pi): id Tech 3 lightmaps clip at 2x overbright, so a wall
// standing inside a light pool reads as a fully lit, still textured surface instead of a white-out. Measured: at 6+ the
// near-wall frames of the evidence runs were ~80% near-white; at 3.2 the same frames keep their texture.
export const BAKE_CLAMP = 3.2;
export function bakedMaterial(base) {
  const m = base.clone();
  m.userData = { ...base.userData };
  m.metalness = Math.min(base.metalness, WORLD_MAX_METALNESS);
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 baked;\nvarying vec3 vBaked;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBaked = baked;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBaked;')
      .replace('#include <lights_fragment_begin>', worldLightsChunk)
      // baked irradiance feeds the diffuse term and (there is no environment map) a share of it stands in for the
      // ambient specular metals would otherwise lack, so worn metal panels still catch the room's light
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nvec3 bakedClamped = min( vBaked, vec3( ' + BAKE_CLAMP.toFixed(2) + ' ) );\nreflectedLight.indirectDiffuse += bakedClamped * BRDF_Lambert( diffuseColor.rgb );\nreflectedLight.indirectSpecular += bakedClamped * material.specularColor * ( 1.0 - 0.75 * material.roughness );');
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
    const hemiI = (amb.hemi ? amb.hemi[2] : 0.35) * 3.2; // same AMBIENT scale as bake.worker.js
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
  // rebake(params): run the bake again with overridden tunables (tuning tools), same geometry
  return { meshes, bake, stats, rebake: (params) => runBake(map, all, total, { ...opts, params }).catch((e) => { console.warn('bake failed', e); }) };
}

// Emissive faces as area lights (q3map_surfacelight): every visible face of a glow / trim / pad material is
// sampled on a SL_SPACING grid and each sample becomes a small lambert emitter in the bake, weighted by the area it
// stands for. This is what gives walls their local gradients (bright along a strip, dark toward the ceiling) and
// corridors their pools, exactly as id Tech 3 lit its trims.
const SL_SPACING = 48, SL_MAX = 6000;
// emissive fraction of the face for each pattern kind (the trim's glowing strip is 12% of its height, the pad's rings ~45%)
const SL_COVERAGE = { flat: 0.9, trim: 0.14, pad: 0.45, lava: 0.7, tech: 0.03 };
export function surfaceLights(map) {
  const world = { brushes: map.brushes }, out = [];
  for (const b of map.brushes) {
    if (b.flags & 2 || b.nonsolid) continue;
    const def = MATERIAL_DEFS[b.mat || 'wall'];
    if (!def || !def.emissive || def.unlit) continue;
    const cov = SL_COVERAGE[def.kind] || 0; if (!cov) continue;
    const c = def.emissive.map((x) => x * (def.emissiveIntensity || 1) * cov);
    for (const poly of b.polys) {
      const n = poly.plane.n, v = poly.verts;
      if (poly.wind === undefined) { const e0 = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]], e1 = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]]; poly.wind = dot([e0[1] * e1[2] - e0[2] * e1[1], e0[2] * e1[0] - e0[0] * e1[2], e0[0] * e1[1] - e0[1] * e1[0]], n) < 0 ? -1 : 1; }
      const [u, w] = axesFor(n);
      let umin = Infinity, umax = -Infinity, wmin = Infinity, wmax = -Infinity, cx = 0, cy = 0, cz = 0;
      for (const p of v) { const a = dot(p, u), d = dot(p, w); umin = Math.min(umin, a); umax = Math.max(umax, a); wmin = Math.min(wmin, d); wmax = Math.max(wmax, d); cx += p[0]; cy += p[1]; cz += p[2]; }
      cx /= v.length; cy /= v.length; cz /= v.length;
      if (pointContents(world, [cx + n[0] * 0.5, cy + n[1] * 0.5, cz + n[2] * 0.5])) continue; // buried face
      // polygon area (fan) -> weight per sample
      let area = 0;
      for (let i = 1; i + 1 < v.length; i++) { const e0 = [v[i][0] - v[0][0], v[i][1] - v[0][1], v[i][2] - v[0][2]], e1 = [v[i + 1][0] - v[0][0], v[i + 1][1] - v[0][1], v[i + 1][2] - v[0][2]]; area += Math.hypot(e0[1] * e1[2] - e0[2] * e1[1], e0[2] * e1[0] - e0[0] * e1[2], e0[0] * e1[1] - e0[1] * e1[0]) / 2; }
      if (area < 4) continue;
      const nu = Math.max(1, Math.round((umax - umin) / SL_SPACING)), nw = Math.max(1, Math.round((wmax - wmin) / SL_SPACING));
      // 1.0 = one 48 x 8 strip segment; capped so a big light panel (the marker bars) is a soft glow, not a floodlight
      const a = Math.min(1.5, area / (nu * nw) / (SL_SPACING * 8));
      for (let i = 0; i < nu; i++) for (let j = 0; j < nw; j++) {
        const pu = umin + (i + 0.5) * (umax - umin) / nu, pw = wmin + (j + 0.5) * (wmax - wmin) / nw;
        // point on the face plane at (pu, pw): start from the centre and move along the projection axes
        const p = [cx + u[0] * (pu - dot([cx, cy, cz], u)) + w[0] * (pw - dot([cx, cy, cz], w)), cy + u[1] * (pu - dot([cx, cy, cz], u)) + w[1] * (pw - dot([cx, cy, cz], w)), cz + u[2] * (pu - dot([cx, cy, cz], u)) + w[2] * (pw - dot([cx, cy, cz], w))];
        // keep the sample on the polygon (inside every edge; the grid can overhang a non-rectangular face)
        let inside = true;
        for (let k = 0; k < v.length && inside; k++) {
          const p0 = v[k], p1 = v[(k + 1) % v.length], e = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], q = [p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]];
          const cr = [e[1] * q[2] - e[2] * q[1], e[2] * q[0] - e[0] * q[2], e[0] * q[1] - e[1] * q[0]];
          if (dot(cr, n) * poly.wind < -1e-3) inside = false;
        }
        if (!inside) continue;
        out.push({ o: [p[0] + n[0] * 1.5, p[1] + n[1] * 1.5, p[2] + n[2] * 1.5], n, c, a });
        if (out.length >= SL_MAX) return out;
      }
    }
  }
  return out;
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
    const brushes = map.brushes.map((b) => ({ planes: b.planes.map((p) => ({ n: p.n, d: p.d, signbits: p.signbits })), mins: b.mins, maxs: b.maxs, nonsolid: !!b.nonsolid, flags: b.flags | 0, sky: b.mat === 'sky' }));
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
    worker.postMessage({ brushes, lights: map.lights, surfaceLights: surfaceLights(map), ambient: map.ambient || {}, positions, normals, chunk: 2048, params: opts.params || null }, [positions.buffer, normals.buffer]);
  });
}
