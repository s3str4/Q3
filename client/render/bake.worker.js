// Lighting bake worker: per-vertex ambient occlusion + shadowed direct light from the map's point lights,
// computed with the shared brush tracer so it matches the collision world exactly. Runs off the main thread;
// results stream back in chunks so the world lights up progressively without ever stalling a frame.
import { traceBox } from '../../shared/trace.js';

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
const AO_DIST = 192;

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

self.onmessage = (ev) => {
  const { brushes, lights, ambient, positions, normals, chunk } = ev.data;
  const world = { brushes };
  const sky = lin(hex(ambient.hemi ? ambient.hemi[0] : '#8fa3c7')), ground = lin(hex(ambient.hemi ? ambient.hemi[1] : '#20160f'));
  const hemiI = (ambient.hemi ? ambient.hemi[2] : 0.35) * 1.5; // AO-modulated ambient; the real-time hemisphere runs at 0.6x
  const L = lights.map((l) => ({ o: l.origin, c: lin(hex(l.color)), i: l.intensity, r: l.radius }));
  const sunDir = ambient.sun ? norm(ambient.sun.dir || [0.3, 0.2, 1]) : null;
  const sunC = ambient.sun ? lin(hex(ambient.sun.color || '#fff2dd')) : null, sunI = ambient.sun ? (ambient.sun.intensity || 1.5) : 0;
  const count = positions.length / 3;
  const out = new Float32Array(count * 3);
  const start = [0, 0, 0], end = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
    const n = [normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]];
    start[0] = px + n[0] * 0.6; start[1] = py + n[1] * 0.6; start[2] = pz + n[2] * 0.6;
    // --- ambient occlusion: hemisphere rays, distance-weighted ---
    const [t, b] = frame(n);
    let open = 0;
    for (const r of RAYS) {
      const dx = t[0] * r[0] + b[0] * r[1] + n[0] * r[2], dy = t[1] * r[0] + b[1] * r[1] + n[1] * r[2], dz = t[2] * r[0] + b[2] * r[1] + n[2] * r[2];
      end[0] = start[0] + dx * AO_DIST; end[1] = start[1] + dy * AO_DIST; end[2] = start[2] + dz * AO_DIST;
      const tr = traceBox(world, start, end, undefined, undefined, null, { skipFlags: SKIP });
      open += tr.fraction >= 1 ? 1 : Math.pow(tr.fraction, 0.6); // near hits occlude strongly, far hits weakly
    }
    const ao = Math.pow(open / RAYS.length, 1.4);
    // --- hemisphere ambient (sky above, ground below) scaled by AO ---
    const k = n[2] * 0.5 + 0.5;
    let r = (sky[0] * k + ground[0] * (1 - k)) * hemiI * ao, g = (sky[1] * k + ground[1] * (1 - k)) * hemiI * ao, bl = (sky[2] * k + ground[2] * (1 - k)) * hemiI * ao;
    // --- direct light with shadow rays (4 jittered rays -> soft edges) ---
    for (const l of L) {
      const lx = l.o[0] - px, ly = l.o[1] - py, lz = l.o[2] - pz;
      const d = Math.hypot(lx, ly, lz);
      if (d >= l.r || d < 1e-3) continue;
      let ndl = (lx * n[0] + ly * n[1] + lz * n[2]) / d;
      if (ndl <= -0.2) continue;
      ndl = (ndl + 0.2) / 1.2; // wrapped lambert: a little "bounce" keeps grazing ceilings and walls from going black
      // Q3-style falloff: linear-ish in distance (no inverse square), so a light fills its radius instead of a hot spot
      const fall = Math.pow(1 - d / l.r, 1.6);
      let vis = 0;
      for (let j = 0; j < 4; j++) {
        const jx = ((j & 1) ? 10 : -10), jy = ((j & 2) ? 10 : -10);
        end[0] = l.o[0] + jx; end[1] = l.o[1] + jy; end[2] = l.o[2] + (j % 3 - 1) * 8;
        const tr = traceBox(world, start, end, undefined, undefined, null, { skipFlags: SKIP });
        if (tr.fraction >= 1) vis += 0.25;
      }
      if (vis === 0) continue;
      const e = ndl * fall * l.i * vis * 2.2;
      r += l.c[0] * e; g += l.c[1] * e; bl += l.c[2] * e;
    }
    if (sunDir) {
      const ndl = sunDir[0] * n[0] + sunDir[1] * n[1] + sunDir[2] * n[2];
      if (ndl > 0) {
        end[0] = start[0] + sunDir[0] * 8000; end[1] = start[1] + sunDir[1] * 8000; end[2] = start[2] + sunDir[2] * 8000;
        const tr = traceBox(world, start, end, undefined, undefined, null, { skipFlags: SKIP });
        if (tr.fraction >= 1) { const e = ndl * sunI * 0.6; r += sunC[0] * e; g += sunC[1] * e; bl += sunC[2] * e; }
      }
    }
    out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = bl;
    if ((i + 1) % chunk === 0 || i === count - 1) {
      const from = Math.floor(i / chunk) * chunk;
      const slice = out.slice(from * 3, (i + 1) * 3);
      self.postMessage({ from, data: slice }, [slice.buffer]);
    }
  }
  self.postMessage({ done: true });
};
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
