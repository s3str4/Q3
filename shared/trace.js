// Quake 3 style box/point sweeps through convex brushes (cm_trace.c: CM_TraceThroughBrush).
import { PM } from './constants.js';
import { dot } from './vec3.js';

const EPS = PM.surfaceClipEpsilon;

export function makeTrace(start, end) {
  return { fraction: 1, endpos: [end[0], end[1], end[2]], plane: null, allsolid: false, startsolid: false, brush: null, entity: null, surfaceFlags: 0 };
}

// Trace a box (mins/maxs relative to start/end) through world brushes and optional entity boxes.
// entities: [{ id, origin, mins, maxs, ...}]; opts.skip: entity id to skip; opts.mask: brush contents mask (default solid)
export function traceBox(world, start, end, mins = ZERO, maxs = ZERO, entities = null, opts = {}) {
  const tw = makeTrace(start, end);
  // sweep bounds for culling
  const bmin = [0, 0, 0], bmax = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    bmin[i] = Math.min(start[i], end[i]) + mins[i] - 1;
    bmax[i] = Math.max(start[i], end[i]) + maxs[i] + 1;
  }
  const offsets = makeOffsets(mins, maxs);
  const brushes = world.brushes;
  const skipFlags = opts.skipFlags || 0;
  for (let bi = 0; bi < brushes.length; bi++) {
    const b = brushes[bi];
    if (b.nonsolid) continue;
    if (skipFlags && (b.flags & skipFlags)) continue;
    if (b.maxs[0] < bmin[0] || b.mins[0] > bmax[0] || b.maxs[1] < bmin[1] || b.mins[1] > bmax[1] || b.maxs[2] < bmin[2] || b.mins[2] > bmax[2]) continue;
    traceThroughBrush(tw, b, start, end, offsets, b, null);
    if (tw.allsolid) break;
  }
  if (entities && !tw.allsolid) {
    for (const e of entities) {
      if (!e || e.id === opts.skip || e.dead || e.noclip) continue;
      const eb = entityBrush(e);
      if (eb.maxs[0] < bmin[0] || eb.mins[0] > bmax[0] || eb.maxs[1] < bmin[1] || eb.mins[1] > bmax[1] || eb.maxs[2] < bmin[2] || eb.mins[2] > bmax[2]) continue;
      traceThroughBrush(tw, eb, start, end, offsets, null, e);
      if (tw.allsolid) break;
    }
  }
  if (tw.fraction < 1) {
    for (let i = 0; i < 3; i++) tw.endpos[i] = start[i] + tw.fraction * (end[i] - start[i]);
  }
  return tw;
}

const ZERO = [0, 0, 0];

function makeOffsets(mins, maxs) {
  const offs = new Array(8);
  for (let s = 0; s < 8; s++) {
    offs[s] = [(s & 1) ? maxs[0] : mins[0], (s & 2) ? maxs[1] : mins[1], (s & 4) ? maxs[2] : mins[2]];
  }
  return offs;
}

// A temporary 6-plane brush for an entity AABB.
export function entityBrush(e) {
  const o = e.origin, mn = e.mins, mx = e.maxs;
  return {
    planes: [
      { n: [1, 0, 0], d: o[0] + mx[0], signbits: 0 }, { n: [-1, 0, 0], d: -(o[0] + mn[0]), signbits: 1 },
      { n: [0, 1, 0], d: o[1] + mx[1], signbits: 0 }, { n: [0, -1, 0], d: -(o[1] + mn[1]), signbits: 2 },
      { n: [0, 0, 1], d: o[2] + mx[2], signbits: 0 }, { n: [0, 0, -1], d: -(o[2] + mn[2]), signbits: 4 },
    ],
    mins: [o[0] + mn[0], o[1] + mn[1], o[2] + mn[2]], maxs: [o[0] + mx[0], o[1] + mx[1], o[2] + mx[2]],
  };
}

function traceThroughBrush(tw, brush, start, end, offsets, hitBrush, hitEntity) {
  let enterFrac = -1, leaveFrac = 1;
  let clipplane = null;
  let getout = false, startout = false;
  const planes = brush.planes;
  for (let i = 0; i < planes.length; i++) {
    const p = planes[i];
    const off = offsets[p.signbits];
    const dist = p.d - dot(off, p.n);
    const d1 = dot(start, p.n) - dist;
    const d2 = dot(end, p.n) - dist;
    if (d2 > 0) getout = true;
    if (d1 > 0) startout = true;
    if (d1 > 0 && (d2 >= EPS || d2 >= d1)) return; // completely in front of face, no intersection
    if (d1 <= 0 && d2 <= 0) continue; // behind this plane
    if (d1 > d2) { // entering
      let f = (d1 - EPS) / (d1 - d2);
      if (f < 0) f = 0;
      if (f > enterFrac) { enterFrac = f; clipplane = p; }
    } else { // leaving
      let f = (d1 + EPS) / (d1 - d2);
      if (f > 1) f = 1;
      if (f < leaveFrac) leaveFrac = f;
    }
  }
  if (!startout) {
    tw.startsolid = true;
    if (!getout) { tw.allsolid = true; tw.fraction = 0; tw.brush = hitBrush; tw.entity = hitEntity; }
    return;
  }
  if (enterFrac < leaveFrac && enterFrac > -1 && enterFrac < tw.fraction) {
    if (enterFrac < 0) enterFrac = 0;
    tw.fraction = enterFrac;
    tw.plane = clipplane;
    tw.brush = hitBrush;
    tw.entity = hitEntity;
    tw.surfaceFlags = hitBrush ? (hitBrush.flags | 0) : 0;
  }
}

// Point-in-solid test for spawn validation / telefrag checks.
export function pointContents(world, p, mins = ZERO, maxs = ZERO) {
  const offsets = makeOffsets(mins, maxs);
  for (const b of world.brushes) {
    if (b.nonsolid) continue;
    if (p[0] + maxs[0] < b.mins[0] || p[0] + mins[0] > b.maxs[0] || p[1] + maxs[1] < b.mins[1] || p[1] + mins[1] > b.maxs[1] || p[2] + maxs[2] < b.mins[2] || p[2] + mins[2] > b.maxs[2]) continue;
    let inside = true;
    for (const pl of b.planes) {
      const dist = pl.d - dot(offsets[pl.signbits], pl.n);
      if (dot(p, pl.n) - dist > 0) { inside = false; break; }
    }
    if (inside) return true;
  }
  return false;
}
