// Non-colliding architectural detail, generated from a map's rooms, lights, items and triggers (the id Tech 3 "detail
// brush" role): cornices under the ceilings, skirting along the floors, pilasters at the corners and ribs along long
// walls, lintels (with arch brackets in the gothic style) over every doorway, ceiling beams across halls, hanging
// lamp fixtures at the map's point lights (with their cable to the ceiling), octagonal spawn pads under the items,
// rims round the jump pads, teleporter frames, ember rocks in the lava, pipes / cables / vents in the tech style,
// banners in the gothic one, and multiply-blended grime decals (under the lights, at pilaster feet, rust rings under
// the weapon pads, drips under the wall strips). Every brush carries BRUSH_FLAGS.NOCOLLIDE + nonsolid, lives only in
// the renderer (client/render/world.js merges it into the world meshes and bakes it with the same lighting) and is
// never traced by movement, weapons, bots or the map tests: the playable geometry does not change by one unit.
//
// Where things go is decided by probing the map's real solids (pointContents / traceBox): a cornice runs where a wall
// stands under a ceiling edge, a lintel hangs where an opening in a wall stops short of the ceiling, a lamp hangs from
// the ceiling found above its light. Per-map style (materials, gothic vs tech extras) comes from STYLES by map name.
import { boxBrush, brushFromPlanes, clipPolygon } from '../../shared/brush.js';
import { pointContents, traceBox } from '../../shared/trace.js';
import { ITEMS } from '../../shared/constants.js';
import { BRUSH_FLAGS } from '../../shared/map.js';
import { lampMaterial, itempadMaterial } from './materials.js';

const NOCOLLIDE = BRUSH_FLAGS.NOCOLLIDE;
const STYLES = {
  arena_duel: { theme: 'gothic', cornice: 'cornice', skirting: 'cornice_dark', rib: 'rib', beam: 'beam_wood', lintel: 'cornice', lamp: 'trim', arch: true, banners: true, ribSpacing: 256, beamSpacing: 128 },
  lava_spire: { theme: 'gothic', cornice: 'cornice_dark', skirting: 'cornice_dark', rib: 'rib', beam: 'beam_wood', lintel: 'cornice_dark', lamp: 'trim', arch: true, rocks: true, banners: true, bannerMat: 'banner_red', ribSpacing: 288, beamSpacing: 128 },
  tight_deck: { theme: 'tech', cornice: 'trim_steel', skirting: 'trim_steel', rib: 'rib_steel', beam: 'beam', lintel: 'trim_steel', lamp: 'rib_steel', arch: false, pipes: true, cables: true, vents: true, ribSpacing: 256, beamSpacing: 160 },
  default: { theme: 'tech', cornice: 'trim_steel', skirting: 'trim_steel', rib: 'rib_steel', beam: 'beam', lintel: 'trim_steel', lamp: 'rib_steel', arch: false, ribSpacing: 256, beamSpacing: 128 },
};
const ITEM_PAD_COLOR = { mega: '#3d8cff', armorRed: '#ff3d3d', armorYellow: '#ffd23a', health25: '#ffe24d', health50: '#ffa63a' };
const WEAPON_PAD_COLOR = '#b8c8e8';

const ZERO = [0, 0, 0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const hash = (x, y, s = 0) => { const v = Math.sin(x * 12.9898 + y * 78.233 + s * 37.719) * 43758.5453; return v - Math.floor(v); };

export function buildDetail(map) {
  const style = STYLES[map.name] || STYLES.default;
  const solids = map.brushes.filter((b) => !b.nonsolid && !(b.flags & 6 /* NODRAW | PLAYERCLIP */) && b.mat !== 'clip');
  const world = { brushes: solids };
  const solid = (p) => pointContents(world, p);
  const trace = (a, b) => traceBox(world, a, b, ZERO, ZERO, null, {});
  const out = [], decals = [];
  const seen = new Set();
  const D = (mins, maxs, mat, extra = {}) => {
    const key = mat + '|' + mins.map((v) => v.toFixed(1)).join(',') + '|' + maxs.map((v) => v.toFixed(1)).join(',');
    if (seen.has(key)) return null; seen.add(key);   // two overlapping rooms emit the same trim on a shared wall run: once
    const b = boxBrush(mins, maxs, { mat, flags: NOCOLLIDE, nonsolid: true, grid: 64, ...extra }); out.push(b); return b;
  };
  const P = (planes, mat, extra = {}) => { const b = brushFromPlanes(planes, { mat, flags: NOCOLLIDE, nonsolid: true, grid: 64, ...extra }); out.push(b); return b; };
  const rooms = map.rooms || [];

  // ---- probes ----
  // A side of a room (0 west, 1 east, 2 south, 3 north): the axis the wall runs along, the perpendicular axis, the
  // wall's coordinate on it and the outward sign.
  const sideGeom = (r, side) => ({ axis: side < 2 ? 1 : 0, perp: side < 2 ? 0 : 1, pos: side === 0 ? r.mins[0] : side === 1 ? r.maxs[0] : side === 2 ? r.mins[1] : r.maxs[1], sign: (side === 0 || side === 2) ? -1 : 1 });
  // solid just outside / inside a side at (a along the wall, z)
  const outside = (r, side, a, z, dist = 2) => { const { axis, perp, pos, sign } = sideGeom(r, side); const p = [0, 0, z]; p[axis] = a; p[perp] = pos + sign * dist; return solid(p); };
  const inside = (r, side, a, z, dist = 2) => { const { axis, perp, pos, sign } = sideGeom(r, side); const p = [0, 0, z]; p[axis] = a; p[perp] = pos - sign * dist; return solid(p); };
  // Runs of wall along one side of a room at height z: spans along the wall axis where the wall is solid just outside
  // the room and the room is air just inside. `open` inverts: air on both sides (a doorway or a room overlap).
  const wallRuns = (r, side, z, open = false, step = 16) => {
    const { axis } = sideGeom(r, side);
    const a0 = r.mins[axis], a1 = r.maxs[axis];
    const runs = []; let cur = null;
    for (let a = a0; a < a1; a += step) {
      const c = a + step / 2;
      const o = outside(r, side, c, z), i = inside(r, side, c, z);
      const hit = open ? (!o && !i) : (o && !i);
      if (hit) { if (cur) cur[1] = Math.min(a1, a + step); else cur = [a, Math.min(a1, a + step)]; }
      else if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    return runs;
  };
  // a box against a side of a room: [a0, a1] along the wall, z0..z1, `depth` proud of the wall into the room, `off` further in
  const sideBox = (r, side, a0, a1, z0, z1, depth, off = 0) => {
    switch (side) {
      case 0: return [[r.mins[0] + off, a0, z0], [r.mins[0] + off + depth, a1, z1]];
      case 1: return [[r.maxs[0] - off - depth, a0, z0], [r.maxs[0] - off, a1, z1]];
      case 2: return [[a0, r.mins[1] + off, z0], [a1, r.mins[1] + off + depth, z1]];
      default: return [[a0, r.maxs[1] - off - depth, z0], [a1, r.maxs[1] - off, z1]];
    }
  };
  // is the wall solid (outside) and the room open (inside) at `a` along the side, for every z in zs
  const wallAt = (r, side, a, zs) => zs.every((z) => outside(r, side, a, z) && !inside(r, side, a, z));
  // what closes a room above: 'sky', 'solid' or 'open' (sampled at a few spots in case a pillar stands under one)
  const ceilingKind = (r) => {
    const [x0, y0, z0] = r.mins, [x1, y1, z1] = r.maxs;
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.75], [0.25, 0.75], [0.75, 0.25]]) {
      const p = [x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy, z1 - 4];
      if (solid(p)) continue;
      const tr = trace(p, [p[0], p[1], z1 + 12]);
      if (tr.fraction >= 1) return 'open';
      return tr.brush && tr.brush.mat === 'sky' ? 'sky' : 'solid';
    }
    return 'open';
  };
  // octagonal prism: axis 'x' | 'y' | 'z', centre c (the other two coordinates), apothem r, extent a0..a1 along the axis
  const prism = (axis, c, r, a0, a1, mat, extra) => {
    const ai = axis === 'x' ? 0 : axis === 'y' ? 1 : 2, u = (ai + 1) % 3, v = (ai + 2) % 3;
    const planes = [];
    for (let k = 0; k < 8; k++) { const t = (k + 0.5) * Math.PI / 4; const n = [0, 0, 0]; n[u] = Math.cos(t); n[v] = Math.sin(t); planes.push({ n, d: n[u] * c[u] + n[v] * c[v] + r }); }
    const na = [0, 0, 0]; na[ai] = 1; planes.push({ n: na, d: a1 }); const nb = [0, 0, 0]; nb[ai] = -1; planes.push({ n: nb, d: -a0 });
    return P(planes, mat, extra);
  };

  // ---- rooms: cornices, skirting, pilasters, ribs, lintels / arches, beams, banners, pipes / cables / vents ----
  rooms.forEach((r, ri) => {
    const [x0, y0, z0] = r.mins, [x1, y1, z1] = r.maxs, h = z1 - z0, w = x1 - x0, d = y1 - y0;
    if (h < 96) return;
    const ceil = ceilingKind(r);
    const zm = z0 + h / 2;
    for (let side = 0; side < 4; side++) {
      // cornice (16 high under the ceiling edge, 10 proud) and skirting (20 high along the floor, 6 proud)
      const trimEnds = ([a0, a1], depth) => { const { axis } = sideGeom(r, side); if (side >= 2) { if (a0 <= r.mins[axis]) a0 += depth; if (a1 >= r.maxs[axis]) a1 -= depth; } return [a0, a1]; };
      for (const run of wallRuns(r, side, z1 - 8)) { const [a0, a1] = trimEnds(run, 10); if (a1 - a0 >= 32) D(...sideBox(r, side, a0, a1, z1 - 16, z1, 10), style.cornice, { grid: 96 }); }
      for (const run of wallRuns(r, side, z0 + 10)) { const [a0, a1] = trimEnds(run, 6); if (a1 - a0 >= 32) D(...sideBox(r, side, a0, a1, z0, z0 + 20, 6), style.skirting, { grid: 96 }); }
      // ribs every ribSpacing along full-height wall runs (between skirting and cornice)
      if (h >= 160) for (const [a0, a1] of wallRuns(r, side, zm)) {
        const n = Math.floor((a1 - a0) / style.ribSpacing);
        for (let k = 0; k < n; k++) {
          const a = a0 + (a1 - a0) * (k + 0.5) / n;
          if (!wallAt(r, side, a, [z0 + 24, zm, z1 - 24])) continue;
          D(...sideBox(r, side, a - 8, a + 8, z0 + 21, z1 - 17, 8), style.rib);
          D(...sideBox(r, side, a - 12, a + 12, z0 + 21, z0 + 32, 10), style.skirting);   // rib foot
          D(...sideBox(r, side, a - 12, a + 12, z1 - 28, z1 - 17, 10), style.cornice);    // rib capital
        }
      }
      // lintels over openings that stop short of the ceiling (probed in tiers so a stacked doorway gets its own)
      for (let tier = z0 + 64; tier < z1 - 32; tier += 160) {
        for (const [a0, a1] of wallRuns(r, side, tier, true)) {
          if (a1 - a0 < 48) continue;
          const mid = (a0 + a1) / 2;
          const probe = (z) => outside(r, side, mid, z);
          let top = tier; while (top < z1 && !probe(top + 4)) top += 8;
          let bottom = tier; while (bottom > z0 && !probe(bottom - 4)) bottom -= 8;
          if (tier > z0 + 64 && bottom <= tier - 160) continue;  // this opening already got its lintel from the tier below
          if (top >= z1 - 8) continue;                           // open up to the ceiling: no header to hang a lintel from
          D(...sideBox(r, side, a0, a1, top - 12, top, 8), style.lintel);
          if (style.arch && top - bottom >= 96) { // arch brackets: a 28 x 28 wedge in each top corner of the opening
            const axis = side < 2 ? 1 : 0;
            for (const [a, s] of [[a0, 1], [a1, -1]]) {
              const [mn, mx] = sideBox(r, side, Math.min(a, a + s * 28), Math.max(a, a + s * 28), top - 28, top, 8);
              const n = [0, 0, -1 / Math.SQRT2]; n[axis] = s / Math.SQRT2;
              P([{ n: [1, 0, 0], d: mx[0] }, { n: [-1, 0, 0], d: -mn[0] }, { n: [0, 1, 0], d: mx[1] }, { n: [0, -1, 0], d: -mn[1] }, { n: [0, 0, 1], d: mx[2] }, { n: [0, 0, -1], d: -mn[2] }, { n, d: (s * a - top + 28) / Math.SQRT2 }], style.lintel);
            }
          }
        }
      }
      // banners (gothic): hung at the middle of long wall runs of tall rooms
      if (style.banners && r.cls === 'room' && h >= 256) for (const [a0, a1] of wallRuns(r, side, zm)) {
        if (a1 - a0 < 192) continue;
        const a = (a0 + a1) / 2, top = Math.min(z1 - 24, z0 + 300);
        if (!wallAt(r, side, a, [top - 120, top - 60, top])) continue;
        const mat = style.bannerMat || (Math.abs((x0 + x1) / 2) < 320 ? 'banner_green' : (x0 + x1) / 2 < 0 ? 'banner_red' : 'banner_blue');
        D(...sideBox(r, side, a - 32, a + 32, top - 128, top, 2, 6), mat, { grid: 32 });
        D(...sideBox(r, side, a - 40, a + 40, top - 2, top + 3, 4, 4), 'trim');   // the rod it hangs from
      }
      // tech: pipes under the ceiling, cables along its edge, a vent on the long walls
      if (style.pipes && ceil === 'solid') for (const [a0, a1] of wallRuns(r, side, z1 - 40)) {
        if (a1 - a0 < 128) continue;
        const axis = side < 2 ? 'y' : 'x', pm = ((ri + side) & 1) ? 'pipe_rust' : 'pipe';
        const [mn, mx] = sideBox(r, side, a0, a1, z1 - 34, z1 - 22, 2, 10);
        const c = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, z1 - 28];
        prism(axis, c, 6.5, a0 + 4, a1 - 4, pm, { grid: 96 });
        for (let a = a0 + 64; a < a1 - 32; a += 128) D(...sideBox(r, side, a - 2, a + 2, z1 - 30, z1 - 26, 12), 'rib_steel');   // brackets
        if (style.cables) D(...sideBox(r, side, a0 + 8, a1 - 8, z1 - 9, z1 - 5, 3, 26), 'cable', { grid: 192 });
      }
      if (style.vents && r.cls === 'room') for (const [a0, a1] of wallRuns(r, side, z0 + 56)) {
        if (a1 - a0 < 192) continue;
        const a = (a0 + a1) / 2;
        if (wallAt(r, side, a, [z0 + 40, z0 + 72])) D(...sideBox(r, side, a - 32, a + 32, z0 + 40, z0 + 72, 2), 'vent', { grid: 64 });
      }
    }
    // corner pilasters (rooms and wide halls): where two solid walls meet, floor to cornice
    if (h >= 160 && Math.min(w, d) >= 128) for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
      const ok = [z0 + 24, zm, z1 - 24].every((z) => solid([cx - sx * 2, cy + sy * 10, z]) && solid([cx + sx * 10, cy - sy * 2, z]) && !solid([cx + sx * 10, cy + sy * 10, z]));
      if (!ok) continue;
      const box = (s, zA, zB) => D([Math.min(cx, cx + sx * s), Math.min(cy, cy + sy * s), zA], [Math.max(cx, cx + sx * s), Math.max(cy, cy + sy * s), zB], style.rib);
      box(24, z0 + 22, z1 - 18);
      D([Math.min(cx, cx + sx * 30), Math.min(cy, cy + sy * 30), z0], [Math.max(cx, cx + sx * 30), Math.max(cy, cy + sy * 30), z0 + 22], style.skirting);
      D([Math.min(cx, cx + sx * 30), Math.min(cy, cy + sy * 30), z1 - 18], [Math.max(cx, cx + sx * 30), Math.max(cy, cy + sy * 30), z1], style.cornice);
      // grime at the foot
      const tr = trace([cx + sx * 24, cy + sy * 24, z0 + 8], [cx + sx * 24, cy + sy * 24, z0 - 8]);
      if (tr.fraction < 1 && tr.plane && tr.plane.n[2] > 0.9) decal(decals, tr.endpos, [0, 0, 1], 30, 30, hash(cx, cy) * 6.28, 1, tr.brush, tr.plane);
    }
    // ceiling beams across the narrow axis of halls and roofed rooms
    if (ceil === 'solid' && h >= 128) {
      const long = w >= d ? 0 : 1, span0 = long ? x0 : y0, span1 = long ? x1 : y1, len = long ? d : w;
      const spacing = r.cls === 'hall' ? style.beamSpacing : style.beamSpacing * 1.5;
      const n = Math.floor(len / spacing);
      for (let k = 0; k < n; k++) {
        const a = (long ? y0 : x0) + len * (k + 0.5) / n;
        let ok = true;
        for (let s = span0 + 8; s < span1 && ok; s += 32) { const p = long ? [s, a, 0] : [a, s, 0]; ok = solid([p[0], p[1], z1 + 2]) && !solid([p[0], p[1], z1 - 2]); }
        if (!ok) continue;
        if (long) D([span0, a - 6, z1 - 12], [span1, a + 6, z1], style.beam); else D([a - 6, span0, z1 - 12], [a + 6, span1, z1], style.beam);
      }
    }
  });

  // ---- lamp fixtures at the map's point lights (hung from the ceiling above them) ----
  for (const l of map.lights) {
    const o = l.origin;
    if (solid(o)) continue;
    const up = trace(o, [o[0], o[1], o[2] + 480]);
    if (up.fraction >= 1 || !up.brush || up.brush.mat === 'sky') continue;
    const down = trace(o, [o[0], o[1], o[2] - 600]);
    if (down.fraction < 1 && o[2] - down.endpos[2] < 48) continue;   // a glow entity sitting on a floor / in the lava: nothing to hang
    const ceilZ = up.endpos[2], lampMat = lampMaterial(l.color);
    const z = Math.min(o[2], ceilZ - 24);
    prism('z', o, 11, z - 5, z + 6, style.lamp);                        // housing
    prism('z', o, 12, z - 2, z + 2, lampMat);                           // side windows (the fitted lens texture wraps each facet)
    prism('z', o, 8, z - 8, z - 4.5, lampMat);                          // lens
    prism('z', o, 5, z + 5.5, z + 10, style.lamp);                      // cap
    D([o[0] - 1.5, o[1] - 1.5, z + 9.5], [o[0] + 1.5, o[1] + 1.5, ceilZ], 'cable', { grid: 128 });
    if (up.plane && up.plane.n[2] < -0.9) decal(decals, up.endpos, [0, 0, -1], 44, 44, hash(o[0], o[1]) * 6.28, 0, up.brush, up.plane);   // soot on the ceiling
  }
  // grime pools on the floor under every light
  for (const l of map.lights) {
    const o = l.origin;
    const tr = trace(o, [o[0], o[1], o[2] - 1200]);
    if (tr.fraction >= 1 || !tr.plane || tr.plane.n[2] < 0.9 || o[2] - tr.endpos[2] > 520) continue;
    if (['lava', 'jumppad', 'teleporter', 'sky'].includes(tr.brush.mat)) continue;
    const rr = Math.max(36, Math.min(100, l.radius * 0.16));
    decal(decals, tr.endpos, [0, 0, 1], rr, rr, hash(o[0], o[1], 3) * 6.28, 1, tr.brush, tr.plane);
  }

  // ---- item spawn pads (octagonal, 3 high, emissive rim) and rust rings under the weapons ----
  for (const it of map.items) {
    const def = ITEMS[it.type]; if (!def) continue;
    if (!(def.kind === 'weapon' || def.kind === 'armor' || def.kind === 'health') || it.type === 'health5' || it.type === 'armorShard') continue;
    const fz = it.floorZ ?? (it.origin[2] - 20), c = [it.origin[0], it.origin[1], fz];
    const major = !!def.major, R = major ? 38 : 30;
    const mat = itempadMaterial(ITEM_PAD_COLOR[it.type] || (def.kind === 'weapon' ? WEAPON_PAD_COLOR : '#d8e0f0'));
    prism('z', c, R, fz - 0.5, fz + 3, mat, { grid: 32 });
    if (def.kind === 'weapon' || major) {
      const tr = trace([c[0], c[1], fz + 4], [c[0], c[1], fz - 8]);
      if (tr.fraction < 1 && tr.plane && tr.plane.n[2] > 0.9) decal(decals, tr.endpos, [0, 0, 1], R + 20, R + 20, hash(c[0], c[1], 5) * 6.28, 3, tr.brush, tr.plane);
    }
  }
  // ---- jump pad rims (eight ring segments, emissive chase) ----
  for (const t of map.triggers) {
    if (t.kind !== 'jumppad') continue;
    const cx = (t.mins[0] + t.maxs[0]) / 2, cy = (t.mins[1] + t.maxs[1]) / 2, half = Math.max(t.maxs[0] - t.mins[0], t.maxs[1] - t.mins[1]) / 2;
    ring([cx, cy], half + 4, half + 16, t.mins[2] - 4, t.mins[2] + 6, 'padrim');
  }
  // ---- teleporter frames: two posts, an emissive lintel and a floor plate against the wall the portal stands on ----
  for (const dcr of map.decor || []) {
    if (dcr.kind !== 'teleporter') continue;
    const { mins, maxs } = dcr, cx = (mins[0] + maxs[0]) / 2, cz = (mins[2] + maxs[2]) / 2;
    const southWall = solid([cx, mins[1] - 4, cz]), northWall = solid([cx, maxs[1] + 4, cz]);
    const wy = southWall ? mins[1] : northWall ? maxs[1] : mins[1], dir = southWall ? 1 : northWall ? -1 : 1;
    const ya = Math.min(wy, wy + dir * 24), yb = Math.max(wy, wy + dir * 24);
    D([mins[0] - 16, ya, mins[2]], [mins[0], yb, maxs[2] + 16], 'rib_steel'); D([maxs[0], ya, mins[2]], [maxs[0] + 16, yb, maxs[2] + 16], 'rib_steel');
    D([mins[0] - 16, ya, maxs[2] + 16], [maxs[0] + 16, yb, maxs[2] + 28], 'telerim');
    D([mins[0] - 16, Math.min(wy, wy + dir * 40), mins[2] - 0.5], [maxs[0] + 16, Math.max(wy, wy + dir * 40), mins[2] + 2], 'tech', { grid: 64 });
  }
  // ---- lava: ember rocks breaking the surface ----
  if (style.rocks) map.triggers.forEach((t, ti) => {
    if (t.kind !== 'lava') return;
    const w = t.maxs[0] - t.mins[0], d = t.maxs[1] - t.mins[1];
    const n = Math.max(1, Math.round(w * d / 36000));
    for (let k = 0; k < n; k++) {
      const rr = 22 + hash(ti, k, 1) * 22;
      const x = t.mins[0] + rr + hash(ti, k, 2) * Math.max(0, w - 2 * rr), y = t.mins[1] + rr + hash(ti, k, 3) * Math.max(0, d - 2 * rr);
      rock([x, y, t.maxs[2] - rr * 0.45], rr, ti * 31 + k, 'ember');
    }
  });
  // ---- drips under the wall strips (a third of the flush glow strips, hashed) ----
  for (const b of solids) {
    if (!/^glow_/.test(b.mat || '')) continue;
    const sz = [b.maxs[0] - b.mins[0], b.maxs[1] - b.mins[1], b.maxs[2] - b.mins[2]];
    const thin = sz.indexOf(Math.min(...sz));
    if (thin === 2 || sz[thin] > 6 || sz[2] > 16) continue;
    const along = thin === 0 ? 1 : 0, len = sz[along];
    for (let a = b.mins[along] + 96; a < b.maxs[along] - 32; a += 192) {
      if (hash(a, b.mins[2], 7) > 0.4) continue;
      const c = [(b.mins[0] + b.maxs[0]) / 2, (b.mins[1] + b.maxs[1]) / 2, b.mins[2] - 4]; c[along] = a;
      for (const s of [1, -1]) {
        const dir = [0, 0, 0]; dir[thin] = s;
        const tr = trace(c, [c[0] + dir[0] * 10, c[1] + dir[1] * 10, c[2]]);
        if (tr.fraction >= 1 || !tr.plane || Math.abs(tr.plane.n[thin]) < 0.9) continue;
        decal(decals, tr.endpos, tr.plane.n, 40, 72, 0, 2, tr.brush, tr.plane, true);
        break;
      }
    }
  }
  return { brushes: out, decals };

  // ring of eight convex segments between apothems rIn and rOut
  function ring(c, rIn, rOut, z0, z1, mat) {
    for (let k = 0; k < 8; k++) {
      const t0 = k * Math.PI / 4, t1 = (k + 1) * Math.PI / 4, tm = (t0 + t1) / 2;
      const nm = [Math.cos(tm), Math.sin(tm), 0];
      P([{ n: nm, d: nm[0] * c[0] + nm[1] * c[1] + rOut }, { n: [-nm[0], -nm[1], 0], d: -(nm[0] * c[0] + nm[1] * c[1]) - rIn },
        { n: [Math.sin(t0), -Math.cos(t0), 0], d: Math.sin(t0) * c[0] - Math.cos(t0) * c[1] }, { n: [-Math.sin(t1), Math.cos(t1), 0], d: -Math.sin(t1) * c[0] + Math.cos(t1) * c[1] },
        { n: [0, 0, 1], d: z1 }, { n: [0, 0, -1], d: -z0 }], mat, { grid: 32 });
    }
  }
  // a boulder: a convex hull of jittered planes round `c`
  function rock(c, r, seed, mat) {
    const planes = [], n = 14;
    for (let i = 0; i < n; i++) {
      const y = 1 - (i + 0.5) / n * 2, rad = Math.sqrt(1 - y * y), phi = i * 2.399963 + hash(seed, i, 1) * 0.6;
      const v = [Math.cos(phi) * rad, y, Math.sin(phi) * rad];
      const nn = [v[0], v[2], v[1] * 0.7];   // squashed: a boulder lying flat
      const l = Math.hypot(...nn); nn[0] /= l; nn[1] /= l; nn[2] /= l;
      planes.push({ n: nn, d: dot(nn, c) + r * (0.7 + hash(seed, i, 2) * 0.3) });
    }
    P(planes, mat, { grid: 48 });
  }
}

// A decal polygon on a face: a quad of half sizes ru x rv at `p` (normal n, rotated by `rot`) clipped to the face's brush,
// lifted 0.4 off it, with UVs into the atlas cell `kind`. Wall decals (`wall`) hang downward from p.
function decal(decals, p, n, ru, rv, rot, kind, brush, plane, wall = false) {
  let u, v;
  if (wall) { u = [n[1], -n[0], 0]; const l = Math.hypot(u[0], u[1]) || 1; u = [u[0] / l, u[1] / l, 0]; v = [0, 0, -1]; p = [p[0], p[1], p[2] - rv + 2]; }
  else { u = [Math.cos(rot), Math.sin(rot), 0]; v = [-Math.sin(rot) * n[2], Math.cos(rot) * n[2], 0]; }
  let poly = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [p[0] + u[0] * a * ru + v[0] * b * rv, p[1] + u[1] * a * ru + v[1] * b * rv, p[2] + u[2] * a * ru + v[2] * b * rv]);
  for (const pl of brush.planes) {
    if (pl === plane || Math.abs(dot(pl.n, n)) > 0.99) continue;
    poly = clipPolygon(poly, pl);
    if (poly.length < 3) return;
  }
  const cx0 = (kind & 1) * 0.5, vTop = 1 - (kind >> 1) * 0.5;
  const verts = poly.map((q) => [q[0] + n[0] * 0.4, q[1] + n[1] * 0.4, q[2] + n[2] * 0.4]);
  const uvs = poly.map((q) => { const dq = [q[0] - p[0], q[1] - p[1], q[2] - p[2]]; return [cx0 + 0.5 * (0.5 + dot(dq, u) / (2 * ru)), vTop - 0.5 * (0.5 + dot(dq, v) / (2 * rv))]; });
  decals.push({ verts, uvs });
}
