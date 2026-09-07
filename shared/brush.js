// Convex brush geometry: construction, polygon extraction (for rendering) and bounds.
import { dot, cross, sub, add, scale, normalize, length } from './vec3.js';

const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export function planeFromPoints(a, b, c) {
  const n = normalize(cross(sub(b, a), sub(c, a)));
  return { n, d: dot(n, a) };
}

// Axis-aligned box brush. props: { mat, flags, ... }
export function boxBrush(mins, maxs, props = {}) {
  const planes = [
    { n: [1, 0, 0], d: maxs[0] }, { n: [-1, 0, 0], d: -mins[0] },
    { n: [0, 1, 0], d: maxs[1] }, { n: [0, -1, 0], d: -mins[1] },
    { n: [0, 0, 1], d: maxs[2] }, { n: [0, 0, -1], d: -mins[2] },
  ];
  return finalizeBrush({ planes, ...props });
}

// A brush from arbitrary planes (each { n, d } with n pointing outward, dot(n,p) <= d inside).
export function brushFromPlanes(planes, props = {}) {
  return finalizeBrush({ planes: planes.map((p) => ({ n: normalize(p.n), d: p.d })), ...props });
}

// Wedge/ramp: a box cut by a slanted plane. dir 'x+' means the ramp rises toward +x, etc.
// lowZ is the ramp floor at the low end, highZ at the high end; the wedge sits on top of lowZ base (solid below).
export function rampBrush(mins, maxs, dir, props = {}) {
  const b = boxBrush(mins, maxs, props);
  const [lo, hi] = [mins[2], maxs[2]];
  let a, c, d;
  // three points on the slanted top plane
  switch (dir) {
    case 'x+': a = [mins[0], mins[1], lo]; c = [mins[0], maxs[1], lo]; d = [maxs[0], mins[1], hi]; break;
    case 'x-': a = [maxs[0], mins[1], lo]; c = [mins[0], mins[1], hi]; d = [maxs[0], maxs[1], lo]; break;
    case 'y+': a = [mins[0], mins[1], lo]; c = [mins[0], maxs[1], hi]; d = [maxs[0], mins[1], lo]; break;
    case 'y-': a = [mins[0], maxs[1], lo]; c = [mins[0], mins[1], hi]; d = [maxs[0], maxs[1], lo]; break;
    default: throw new Error('rampBrush dir must be x+, x-, y+ or y-');
  }
  let p = planeFromPoints(a, c, d);
  if (p.n[2] < 0) p = { n: scale(p.n, -1), d: -p.d };
  // replace the top plane with the slanted plane
  b.planes = b.planes.filter((pl) => !(pl.n[2] === 1));
  b.planes.push(p);
  return finalizeBrush(b);
}

export function finalizeBrush(b) {
  const polys = polygonsFromPlanes(b.planes);
  const mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity];
  for (const poly of polys) for (const v of poly.verts) for (let i = 0; i < 3; i++) { mins[i] = Math.min(mins[i], v[i]); maxs[i] = Math.max(maxs[i], v[i]); }
  b.mins = mins; b.maxs = maxs; b.polys = polys;
  for (const p of b.planes) {
    // precompute signbits and type
    p.signbits = (p.n[0] < 0 ? 1 : 0) | (p.n[1] < 0 ? 2 : 0) | (p.n[2] < 0 ? 4 : 0);
  }
  return b;
}

// Build the polygon for each plane by clipping a huge quad against every other plane.
export function polygonsFromPlanes(planes, size = 65536) {
  const out = [];
  for (let i = 0; i < planes.length; i++) {
    const p = planes[i];
    let poly = baseQuad(p, size);
    for (let j = 0; j < planes.length && poly.length; j++) {
      if (j === i) continue;
      poly = clipPolygon(poly, planes[j]);
    }
    if (poly.length >= 3) out.push({ plane: p, verts: poly });
  }
  return out;
}

function baseQuad(plane, size) {
  const n = plane.n;
  // pick major axis
  let ax = 0; let best = 0;
  for (let i = 0; i < 3; i++) if (Math.abs(n[i]) > best) { best = Math.abs(n[i]); ax = i; }
  let up = ax === 2 ? [1, 0, 0] : [0, 0, 1];
  const v = dot(up, n);
  up = normalize(sub(up, scale(n, v)));
  const right = cross(up, n);
  const org = scale(n, plane.d);
  const u = scale(up, size), r = scale(right, size);
  return [add(add(org, u), r), sub(add(org, u), r), sub(sub(org, u), r), add(sub(org, u), r)];
}

// Keep the part of poly on the inside (dot(n,p) <= d) of plane.
export function clipPolygon(poly, plane) {
  const out = [];
  const n = poly.length;
  const EPS = 1e-5;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const da = dot(plane.n, a) - plane.d, db = dot(plane.n, b) - plane.d;
    const ain = da <= EPS, bin = db <= EPS;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  // remove duplicates
  const res = [];
  for (const v of out) {
    const last = res[res.length - 1];
    if (!last || length(sub(last, v)) > 1e-4) res.push(v);
  }
  if (res.length > 1 && length(sub(res[0], res[res.length - 1])) <= 1e-4) res.pop();
  return res;
}

export function polygonArea(verts) {
  let s = [0, 0, 0];
  for (let i = 1; i + 1 < verts.length; i++) s = add(s, cross(sub(verts[i], verts[0]), sub(verts[i + 1], verts[0])));
  return length(s) / 2;
}
