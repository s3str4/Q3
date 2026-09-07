// Map-building helpers shared by the competitive maps: a room-shell generator (declare rooms as voids,
// get a leak-free set of floor/ceiling/wall brushes with per-face materials) and nav-node grids.
// Pure geometry on axis-aligned boxes; no engine dependencies except the MapBuilder passed in.
import { pointContents } from '../shared/trace.js';
import { PM } from '../shared/constants.js';

// ---------- axis-aligned box CSG ----------
export function boxesOverlap(a, b) {
  return a.mins[0] < b.maxs[0] && a.maxs[0] > b.mins[0] && a.mins[1] < b.maxs[1] && a.maxs[1] > b.mins[1] && a.mins[2] < b.maxs[2] && a.maxs[2] > b.mins[2];
}

// a - b as a list of disjoint boxes (up to 6). Boxes are { mins, maxs, mat }.
export function subtractBox(a, b) {
  if (!boxesOverlap(a, b)) return [a];
  const out = [];
  const mk = (mins, maxs) => { if (maxs[0] > mins[0] && maxs[1] > mins[1] && maxs[2] > mins[2]) out.push({ ...a, mins, maxs }); };
  const ix = [Math.max(a.mins[0], b.mins[0]), Math.min(a.maxs[0], b.maxs[0])];
  const iy = [Math.max(a.mins[1], b.mins[1]), Math.min(a.maxs[1], b.maxs[1])];
  const iz = [Math.max(a.mins[2], b.mins[2]), Math.min(a.maxs[2], b.maxs[2])];
  // x slabs on either side of the intersection (full y/z of a)
  mk([a.mins[0], a.mins[1], a.mins[2]], [ix[0], a.maxs[1], a.maxs[2]]);
  mk([ix[1], a.mins[1], a.mins[2]], [a.maxs[0], a.maxs[1], a.maxs[2]]);
  // y slabs within the x intersection
  mk([ix[0], a.mins[1], a.mins[2]], [ix[1], iy[0], a.maxs[2]]);
  mk([ix[0], iy[1], a.mins[2]], [ix[1], a.maxs[1], a.maxs[2]]);
  // z slabs within the x/y intersection
  mk([ix[0], iy[0], a.mins[2]], [ix[1], iy[1], iz[0]]);
  mk([ix[0], iy[0], iz[1]], [ix[1], iy[1], a.maxs[2]]);
  return out;
}

// Rotate a box 180 degrees about the Z axis (point symmetry through the origin): (x, y) -> (-x, -y).
export function rot180(mins, maxs) {
  return [[-maxs[0], -maxs[1], mins[2]], [-mins[0], -mins[1], maxs[2]]];
}

// ---------- room shell ----------
// Rooms are voids. Every room gets a floor slab, a ceiling slab and four wall slabs of thickness T around it;
// the slabs are then clipped against every room void (so touching rooms open into each other exactly where
// their voids meet) and unioned into disjoint boxes (so no two output brushes overlap or z-fight).
export class Shell {
  constructor(m, thickness = 32) { this.m = m; this.T = thickness; this.rooms = []; }
  room(name, mins, maxs, mats = {}) {
    const r = { name, mins: [...mins], maxs: [...maxs], floor: mats.floor || 'floor', wall: mats.wall || 'wall', ceil: mats.ceil || 'ceiling' };
    this.rooms.push(r);
    return r;
  }
  get(name) { return this.rooms.find((r) => r.name === name); }

  // Generate the brushes. Returns the list of emitted boxes (for tests/debugging).
  build() {
    const T = this.T;
    const floors = [], ceils = [], walls = [];
    for (const r of this.rooms) {
      const [x0, y0, z0] = r.mins, [x1, y1, z1] = r.maxs;
      floors.push({ mins: [x0, y0, z0 - T], maxs: [x1, y1, z0], mat: r.floor });
      ceils.push({ mins: [x0, y0, z1], maxs: [x1, y1, z1 + T], mat: r.ceil });
      walls.push({ mins: [x0 - T, y0 - T, z0 - T], maxs: [x0, y1 + T, z1 + T], mat: r.wall });
      walls.push({ mins: [x1, y0 - T, z0 - T], maxs: [x1 + T, y1 + T, z1 + T], mat: r.wall });
      walls.push({ mins: [x0, y0 - T, z0 - T], maxs: [x1, y0, z1 + T], mat: r.wall });
      walls.push({ mins: [x0, y1, z0 - T], maxs: [x1, y1 + T, z1 + T], mat: r.wall });
    }
    // floors and ceilings first so their material wins where a wall slab overlaps a neighbouring room's floor
    const accepted = [];
    for (const slab of [...floors, ...ceils, ...walls]) {
      let pieces = [slab];
      for (const r of this.rooms) pieces = pieces.flatMap((p) => subtractBox(p, r));
      for (const acc of accepted) pieces = pieces.flatMap((p) => subtractBox(p, acc));
      accepted.push(...pieces);
    }
    for (const p of accepted) this.m.box(p.mins, p.maxs, p.mat);
    return accepted;
  }
}

// ---------- nav helpers ----------
// Grid of nav nodes covering an XY rectangle at floor height `floorZ`, spaced <= `spacing`, inset from the edges.
// Nodes whose player box would intersect solid geometry (stairs, pillars, cover) or sit near an `avoid` point are skipped.
export function navGrid(m, mins, maxs, floorZ, { spacing = 160, inset = 48, avoid = [], avoidRadius = 80, extra = {} } = {}) {
  const world = { brushes: m.brushes };
  const x0 = mins[0] + inset, x1 = maxs[0] - inset, y0 = mins[1] + inset, y1 = maxs[1] - inset;
  const nx = Math.max(1, Math.ceil((x1 - x0) / spacing)), ny = Math.max(1, Math.ceil((y1 - y0) / spacing));
  let placed = 0;
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) {
    const x = nx ? x0 + (x1 - x0) * i / nx : (x0 + x1) / 2;
    const y = ny ? y0 + (y1 - y0) * j / ny : (y0 + y1) / 2;
    const o = [x, y, floorZ + 24];
    if (avoid.some((a) => Math.hypot(a[0] - x, a[1] - y) < avoidRadius)) continue;
    // contents test is inclusive at the boundary: test the box nudged 2 units up so resting on the floor is not "inside"
    if (pointContents(world, [x, y, floorZ + 26], PM.mins, PM.maxs)) continue;
    m.nav(o, extra); placed++;
  }
  return placed;
}
