// Lighting bake worker: per-vertex ambient occlusion, shadowed direct light from the map's point lights and one
// bounce of indirect light, computed with the shared brush tracer so it matches the collision world exactly.
// This bake IS the world's diffuse lighting (id Tech 3 lightmap role): the renderer's real-time copies of the map
// lights only add specular / normal-map response on the world (see world.js bakedMaterial). Runs off the main
// thread; results stream back in chunks so the world lights up progressively without ever stalling a frame.
import { traceBox, pointContents, makeTrace, traceThroughBrush } from '../../shared/trace.js';

const SKIP = 2 | 4; // NODRAW | PLAYERCLIP never occlude light

// Cosine-weighted hemisphere directions (deterministic, low-discrepancy) in a local frame (z = normal).
function hemisphere(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n, v = ((i * 0.618033988749895) % 1);
    const r = Math.sqrt(u), phi = 2 * Math.PI * v;
    const z = Math.sqrt(Math.max(0.03, 1 - u)); // keep rays >= ~10 degrees off the surface
    out.push([r * Math.cos(phi), r * Math.sin(phi), z]);
  }
  return out;
}
const RAYS = hemisphere(20);
const AO_DIST = 256;
// Direct light scale (map intensities are ~1-1.6). The bake is irradiance and the shader divides it by pi, so a
// pool needs ~5 to clip to white. With the q3map-style falloff below, the floor pool under a key light (300 units
// away) reaches ~6 (clipped, like an overbright lightmap), walls 600-900 units away get ~1-1.5 and the corners only
// the AO-darkened ambient: the tonal range of an id Tech 3 lightmap. The old 4.2 with a broad (1 - d/r)^1.25
// falloff pushed whole rooms to 2-4 where ACES flattens everything to one tone. Every tunable below was chosen by
// measuring screenshots (tools/screenshots.mjs tone vantages) and can be overridden per bake via params.
let DIRECT = 9.0;
let POOL_R = 200;        // distance at which a light delivers its full intensity (q3map: photons / d^2)
let AMBIENT = 3.2;       // hemisphere ambient scale: the map's hemi intensity x its (dark) sky colour lands at ~0.2-0.3 irradiance, a readable but clearly unlit corner
let BOUNCE = 0.35;       // single-bounce strength (q3map -bounce look: lit floors/walls bleed their colour into shadow)
const BOUNCE_ALBEDO = 0.38;
// Saturated light / ambient colours are pulled toward their luminance: q3map's overbright clipping does the same
// in the bright pools, and it keeps a blue-lit steel room from reading as a single hue.
let LIGHT_DESAT = 0.15;
// ...while the hemisphere ambient, the colour of every shadow, is pushed the other way: id Tech 3 lightmaps keep their
// hue in the dark (a blue room has deep blue corners, not grey ones)
let AMBIENT_SAT = 0.7;
// Skylight (q3map_skylight): hemisphere rays that reach a 'sky' face within AO_DIST bring light of the ambient sky
// colour, nearer sky brighter. Rooms open to the sky get a bright band under it (the atria's upper walls and
// balconies) while corridors under solid ceilings get none: lit atria, dark corridors.
let SKY = 10.0, SKY_DESAT = 0.3; // skylight strength and how far its colour is pulled toward white
// Surface lights (emissive faces sampled by world.js): SURFACE x (area / one 48 x 8 strip segment) each, placed
// SL_OFF units in front of the face like the light entity a Q3 mapper puts beside a fixture (a strip flush on a
// wall cannot light that wall from inside its plane), with a soft emission lobe, inverse square from SL_R0 out to
// SL_RADIUS. The wall behind a strip clips like an overbright lightmap and the band 150 units above it sits at ~0.3.
let SURFACE = 7.0, AO_POW = 1.8;
const SL_OFF = 24, SL_R0 = 40, SL_RADIUS = 380;

function frame(n) { // tangent basis for a normal
  const up = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const t = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
  const l = Math.hypot(t[0], t[1], t[2]) || 1; t[0] /= l; t[1] /= l; t[2] /= l;
  const b = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
  return [t, b];
}
function hex(c) { const v = parseInt(String(c).replace('#', ''), 16); return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; }
// approximate sRGB -> linear for light colors
const lin = (c) => c.map((x) => Math.pow(x, 2.2));
// q3map falloff: inverse square (full intensity inside POOL_R) windowed to zero at the light's radius, so a key
// light makes a pool on the floor under it and the far walls of its room fall back to the ambient
const falloff = (d, r) => { const q = Math.min(1, (POOL_R * POOL_R) / (d * d)); const w = d / r; return q * Math.max(0, 1 - w * w); };
const satur = (c) => { const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; return c.map((x) => Math.max(0, x + (x - l) * AMBIENT_SAT)); };
const desat = (c) => { const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; return c.map((x) => x + (l - x) * LIGHT_DESAT); };

// ---- brush grid: every trace here is a point sweep, so the candidate brushes are read off a uniform grid over the
// map (cell GRID_CELL) instead of scanning the whole list per ray; the sweep itself is the shared traceThroughBrush,
// so a hit is the same hit the collision tracer would report (tests/bake_grid.test.mjs asserts the bake is identical
// to the brute-force traceBox one). ~100 rays per vertex x 40-60k vertices: this is what keeps the bake in seconds. ----
const GRID_CELL = 128;
function buildGrid(brushes) {
  if (!brushes.length) return null;
  const mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity];
  for (const b of brushes) for (let i = 0; i < 3; i++) { mins[i] = Math.min(mins[i], b.mins[i]); maxs[i] = Math.max(maxs[i], b.maxs[i]); }
  const n = [0, 1, 2].map((i) => Math.max(1, Math.ceil((maxs[i] - mins[i]) / GRID_CELL) + 1));
  const cells = new Array(n[0] * n[1] * n[2]);
  const idx = (x, y, z) => (z * n[1] + y) * n[0] + x;
  const cellOf = (v, i) => Math.max(0, Math.min(n[i] - 1, Math.floor((v - mins[i]) / GRID_CELL)));
  brushes.forEach((b, bi) => {
    const x0 = cellOf(b.mins[0], 0), x1 = cellOf(b.maxs[0], 0), y0 = cellOf(b.mins[1], 1), y1 = cellOf(b.maxs[1], 1), z0 = cellOf(b.mins[2], 2), z1 = cellOf(b.maxs[2], 2);
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const k = idx(x, y, z); (cells[k] || (cells[k] = [])).push(bi); }
  });
  return { n, cells, idx, cellOf, stamp: new Int32Array(brushes.length), tick: 0, cand: new Int32Array(brushes.length) };
}
const ZERO_OFFS = new Array(8).fill([0, 0, 0]);
function gridTrace(grid, brushes, start, end, skipFlags) {
  const tw = makeTrace(start, end);
  const bmin = [Math.min(start[0], end[0]) - 1, Math.min(start[1], end[1]) - 1, Math.min(start[2], end[2]) - 1];
  const bmax = [Math.max(start[0], end[0]) + 1, Math.max(start[1], end[1]) + 1, Math.max(start[2], end[2]) + 1];
  const x0 = grid.cellOf(bmin[0], 0), x1 = grid.cellOf(bmax[0], 0), y0 = grid.cellOf(bmin[1], 1), y1 = grid.cellOf(bmax[1], 1), z0 = grid.cellOf(bmin[2], 2), z1 = grid.cellOf(bmax[2], 2);
  // gather the candidates (deduplicated by stamp), then sweep them in brush-array order: an exact tie at a seam
  // (a ray entering a floor and the wall standing on it at the same fraction) resolves to the same brush as traceBox
  const tick = ++grid.tick, stamp = grid.stamp, cand = grid.cand; let k = 0;
  for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const list = grid.cells[grid.idx(x, y, z)]; if (!list) continue;
    for (let i = 0; i < list.length; i++) { const bi = list[i]; if (stamp[bi] !== tick) { stamp[bi] = tick; cand[k++] = bi; } }
  }
  const sorted = cand.subarray(0, k).sort();
  for (let i = 0; i < k; i++) {
    const b = brushes[sorted[i]];
    if (b.nonsolid || (b.flags & skipFlags)) continue;
    if (b.maxs[0] < bmin[0] || b.mins[0] > bmax[0] || b.maxs[1] < bmin[1] || b.mins[1] > bmax[1] || b.maxs[2] < bmin[2] || b.mins[2] > bmax[2]) continue;
    traceThroughBrush(tw, b, start, end, ZERO_OFFS, b, null);
    if (tw.allsolid) break;
  }
  if (tw.fraction < 1) for (let i = 0; i < 3; i++) tw.endpos[i] = start[i] + tw.fraction * (end[i] - start[i]);
  return tw;
}

// The bake itself; post(msg, transfer) receives the progress chunks and the final { done }. Exported so tests can run
// it in Node (params.grid === false selects the brute-force tracer for the equivalence check).
export function bake(data, post) {
  const { brushes, lights, surfaceLights, ambient, positions, normals, chunk, params, job } = data;
  // tunables can be overridden per bake (tools/screenshots.mjs --sweep re-bakes the loaded map with variants)
  if (params) ({ DIRECT = DIRECT, POOL_R = POOL_R, AMBIENT = AMBIENT, BOUNCE = BOUNCE, LIGHT_DESAT = LIGHT_DESAT, AMBIENT_SAT = AMBIENT_SAT, SKY = SKY, SKY_DESAT = SKY_DESAT, SURFACE = SURFACE, AO_POW = AO_POW } = params);
  const world = { brushes };
  const grid = params && params.grid === false ? null : buildGrid(brushes);
  const trace = grid ? (a, b) => gridTrace(grid, brushes, a, b, SKIP) : (a, b) => traceBox(world, a, b, undefined, undefined, null, { skipFlags: SKIP });
  const sky = satur(lin(hex(ambient.hemi ? ambient.hemi[0] : '#8fa3c7'))), ground = satur(lin(hex(ambient.hemi ? ambient.hemi[1] : '#20160f')));
  const hemiI = (ambient.hemi ? ambient.hemi[2] : 0.35) * AMBIENT; // AO-modulated ambient: the only fill light the world gets
  // skylight colour: the hue of the ambient's sky half at unit luminance (SKY sets the strength), treated like a light
  const skyC = lin(hex(ambient.hemi ? ambient.hemi[0] : '#8fa3c7')); { const l = 0.2126 * skyC[0] + 0.7152 * skyC[1] + 0.0722 * skyC[2]; for (let c = 0; c < 3; c++) skyC[c] += (l - skyC[c]) * SKY_DESAT; } { const l = 0.2126 * skyC[0] + 0.7152 * skyC[1] + 0.0722 * skyC[2] || 1; skyC[0] /= l; skyC[1] /= l; skyC[2] /= l; }
  const L = lights.map((l) => ({ o: l.origin, c: desat(lin(hex(l.color))), i: l.intensity, r: l.radius }));
  const SL = (surfaceLights || []).map((l) => ({ o: [l.o[0] + l.n[0] * SL_OFF, l.o[1] + l.n[1] * SL_OFF, l.o[2] + l.n[2] * SL_OFF], n: l.n, c: desat(l.c), i: l.a * SURFACE }));
  const sunDir = ambient.sun ? norm(ambient.sun.dir || [0.3, 0.2, 1]) : null;
  const sunC = ambient.sun ? lin(hex(ambient.sun.color || '#fff2dd')) : null, sunI = ambient.sun ? (ambient.sun.intensity || 1.5) : 0;
  const t0 = (typeof performance !== "undefined" ? performance : Date).now(), startedAt = Date.now();
  const count = positions.length / 3;
  const out = new Float32Array(count * 3);
  const start = [0, 0, 0], end = [0, 0, 0], bounce = [0, 0, 0];
  // unshadowed direct irradiance at a point (used for the bounce estimate at AO ray hits: cheap, no extra traces)
  const directAt = (p, n, acc) => {
    for (const l of L) {
      const lx = l.o[0] - p[0], ly = l.o[1] - p[1], lz = l.o[2] - p[2];
      const d = Math.hypot(lx, ly, lz);
      if (d >= l.r || d < 1e-3) continue;
      const ndl = (lx * n[0] + ly * n[1] + lz * n[2]) / d;
      if (ndl <= 0) continue;
      const e = ndl * falloff(d, l.r) * l.i * DIRECT;
      acc[0] += l.c[0] * e; acc[1] += l.c[1] * e; acc[2] += l.c[2] * e;
    }
  };
  for (let i = 0; i < count; i++) {
    const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
    const n = [normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]];
    start[0] = px + n[0] * 0.6; start[1] = py + n[1] * 0.6; start[2] = pz + n[2] * 0.6;
    // a vertex on a solid's boundary whose face leans into it (the lower faces of a detail rock sunk in a floor, the
    // underside of a cornice butting into a pillar) would start every ray inside the solid and bake black: lift it
    // clear along its face normal plus straight up before giving up (the solids are the map's real brushes only)
    if (pointContents(world, start)) { start[0] = px + n[0] * 1.2; start[1] = py + n[1] * 1.2; start[2] = pz + n[2] * 1.2 + 1.5; }
    // --- ambient occlusion: hemisphere rays, distance-weighted; ray hits also feed the bounce estimate ---
    const [t, b] = frame(n);
    let open = 0, skyHit = 0;
    bounce[0] = bounce[1] = bounce[2] = 0;
    for (const r of RAYS) {
      const dx = t[0] * r[0] + b[0] * r[1] + n[0] * r[2], dy = t[1] * r[0] + b[1] * r[1] + n[1] * r[2], dz = t[2] * r[0] + b[2] * r[1] + n[2] * r[2];
      end[0] = start[0] + dx * AO_DIST; end[1] = start[1] + dy * AO_DIST; end[2] = start[2] + dz * AO_DIST;
      const tr = trace(start, end);
      if (tr.fraction >= 1) { open += 1; continue; }
      if (tr.brush && tr.brush.sky) { open += 1; skyHit += 1 - tr.fraction * 0.5; continue; } // sky faces emit, never occlude
      open += Math.pow(tr.fraction, 0.6); // near hits occlude strongly, far hits weakly
      if (tr.plane) directAt(tr.endpos, tr.plane.n, bounce);
    }
    const ao = Math.pow(open / RAYS.length, AO_POW); // corners and the undersides of ledges go properly dark
    // --- hemisphere ambient (sky above, ground below) scaled by AO ---
    const k = n[2] * 0.5 + 0.5;
    let r = (sky[0] * k + ground[0] * (1 - k)) * hemiI * ao, g = (sky[1] * k + ground[1] * (1 - k)) * hemiI * ao, bl = (sky[2] * k + ground[2] * (1 - k)) * hemiI * ao;
    // --- skylight ---
    if (skyHit > 0) { const e = skyHit / RAYS.length * SKY; r += skyC[0] * e; g += skyC[1] * e; bl += skyC[2] * e; }
    // --- one bounce: average lit colour of what the hemisphere rays hit, times a generic albedo ---
    const bk = BOUNCE * BOUNCE_ALBEDO / RAYS.length;
    r += bounce[0] * bk; g += bounce[1] * bk; bl += bounce[2] * bk;
    // --- direct light with shadow rays (4 jittered rays -> soft edges), plain lambert: shadows and grazing
    // surfaces stay dark, which is what gives the lit pools their contrast ---
    for (const l of L) {
      const lx = l.o[0] - px, ly = l.o[1] - py, lz = l.o[2] - pz;
      const d = Math.hypot(lx, ly, lz);
      if (d >= l.r || d < 1e-3) continue;
      const ndl = (lx * n[0] + ly * n[1] + lz * n[2]) / d;
      if (ndl <= 0) continue;
      const fall = falloff(d, l.r);
      let vis = 0;
      for (let j = 0; j < 4; j++) {
        const jx = ((j & 1) ? 10 : -10), jy = ((j & 2) ? 10 : -10);
        end[0] = l.o[0] + jx; end[1] = l.o[1] + jy; end[2] = l.o[2] + (j % 3 - 1) * 8;
        const tr = trace(start, end);
        if (tr.fraction >= 1) vis += 0.25;
      }
      if (vis === 0) continue;
      const e = ndl * fall * l.i * vis * DIRECT;
      r += l.c[0] * e; g += l.c[1] * e; bl += l.c[2] * e;
    }
    // --- surface lights: one shadow ray each (they are many and local) ---
    for (const l of SL) {
      const lx = l.o[0] - px, ly = l.o[1] - py, lz = l.o[2] - pz;
      if (Math.abs(lx) > SL_RADIUS || Math.abs(ly) > SL_RADIUS || Math.abs(lz) > SL_RADIUS) continue;
      const d = Math.hypot(lx, ly, lz);
      if (d >= SL_RADIUS || d < 1e-3) continue;
      const ndl = (lx * n[0] + ly * n[1] + lz * n[2]) / d;
      if (ndl <= 0.02) continue;
      const cosE = 0.35 + 0.65 * Math.max(0, -(lx * l.n[0] + ly * l.n[1] + lz * l.n[2]) / d); // soft lobe: mostly forward, some spill along the wall
      const q = Math.min(1, (SL_R0 * SL_R0) / (d * d)), w = d / SL_RADIUS;
      const e = ndl * cosE * q * (1 - w * w) * l.i;
      if (e < 0.004) continue;
      if (d > 12) { const tr = trace(start, l.o); if (tr.fraction < 1) continue; }
      r += l.c[0] * e; g += l.c[1] * e; bl += l.c[2] * e;
    }
    if (sunDir) {
      const ndl = sunDir[0] * n[0] + sunDir[1] * n[1] + sunDir[2] * n[2];
      if (ndl > 0) {
        end[0] = start[0] + sunDir[0] * 8000; end[1] = start[1] + sunDir[1] * 8000; end[2] = start[2] + sunDir[2] * 8000;
        const tr = trace(start, end);
        if (tr.fraction >= 1) { const e = ndl * sunI * 0.6; r += sunC[0] * e; g += sunC[1] * e; bl += sunC[2] * e; }
      }
    }
    out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = bl;
    if ((i + 1) % chunk === 0 || i === count - 1) {
      const from = Math.floor(i / chunk) * chunk;
      const slice = out.slice(from * 3, (i + 1) * 3);
      post({ job, from, data: slice }, [slice.buffer]);
    }
  }
  post({ job, done: true, ms: (typeof performance !== "undefined" ? performance : Date).now() - t0, startedAt, finishedAt: Date.now() }); // the worker's own compute time (the main thread may be busy painting textures meanwhile)
}
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') self.onmessage = (ev) => bake(ev.data, (m, t) => self.postMessage(m, t));
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
