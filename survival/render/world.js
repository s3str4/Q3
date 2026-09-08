// Static + semi-static town geometry. Everything that never changes is merged into a handful of vertex-coloured
// meshes (ground, per-structure walls, props); everything that does change (doors, glass, barricade planks,
// container lids, trees/stumps) is an InstancedMesh whose instance matrices are rewritten from the sim world each
// frame, so the whole town costs ~20 draw calls regardless of what the player breaks or builds.
// Coordinates: sim x -> X, sim y -> Z, up = +Y. Tile (x, y) covers X in [x, x+1], Z in [y, y+1].
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TILE } from '../../shared/survival/constants.js';

export const WALL_H = 2.6, CUTAWAY_H = 0.9;
const GROUND_COLOR = { [TILE.GRASS]: 0x5f9440, [TILE.STUMP]: 0x5f9440, [TILE.TREE]: 0x4f7f36, [TILE.ROAD]: 0x45464b, [TILE.SIDEWALK]: 0xa9a59a, [TILE.FLOOR]: 0x9a7650, [TILE.DOOR]: 0x8a6a48, [TILE.WINDOW]: 0x8a6a48, [TILE.WALL]: 0x6a6a6a, [TILE.WRECK]: 0x45464b, [TILE.PUMP]: 0xa9a59a };
const WALL_COLOR = { 'Start house': 0xd9cfb4, 'Blue house': 0x6b8fbd, 'Gas station': 0xb9b3a4, 'Red house': 0xa64d3a };
const CONTAINERS = {
  fridge:  { w: 0.8, h: 1.8, d: 0.7, color: 0xe6eaec, lid: 0xd6dadd, lidKind: 'door' },
  closet:  { w: 0.9, h: 2.0, d: 0.6, color: 0x5a3d26, lid: 0x6a4a30, lidKind: 'door' },
  cabinet: { w: 0.9, h: 0.9, d: 0.6, color: 0x8a5a32, lid: 0x9a6a3c, lidKind: 'door' },
  shelf:   { w: 1.0, h: 1.8, d: 0.4, color: 0xa07848, lid: 0xc24a3a, lidKind: 'goods' },
  locker:  { w: 0.7, h: 1.9, d: 0.5, color: 0x777c84, lid: 0x8a9098, lidKind: 'door' },
  wreck:   { w: 0.9, h: 0.9, d: 0.0, color: 0x6b4a34, lid: 0x6b4a34, lidKind: 'trunk' },
};
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler();
const Y = new THREE.Vector3(0, 1, 0);

function colorAttr(geo, hex, topHex) {
  // vertex colours; optional lighter top faces (normal.y > 0.5) give the blocky look a cap highlight
  const n = geo.attributes.position.count, c = new THREE.Color(hex), t = new THREE.Color(topHex ?? hex); const arr = new Float32Array(n * 3);
  const nrm = geo.attributes.normal;
  for (let i = 0; i < n; i++) { const cc = nrm && nrm.getY(i) > 0.5 ? t : c; arr[i * 3] = cc.r; arr[i * 3 + 1] = cc.g; arr[i * 3 + 2] = cc.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3)); return geo;
}
function box(w, h, d, x, y, z, hex, topHex) { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return colorAttr(g, hex, topHex); }
const isWallish = (t) => t === TILE.WALL || t === TILE.DOOR || t === TILE.WINDOW;

export class TownView {
  constructor(world) {
    this.world = world; this.group = new THREE.Group();
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.buildGround(); this.buildStructures(); this.buildProps(); this.buildTrees(); this.buildContainers();
    this.treeCount = world.trees.size; this.cut = new Map(); // structure name -> current cutaway factor 0..1
  }
  // ---- ground: one quad per tile, vertex coloured, plus dashed road centre lines and a big apron beyond the map ----
  buildGround() {
    const w = this.world, geos = [];
    const rnd = (x, y) => { const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return s - Math.floor(s); };
    for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) {
      const t = w.get(x, y); let c = new THREE.Color(GROUND_COLOR[t] ?? 0x5f9440);
      if (t === TILE.GRASS || t === TILE.TREE || t === TILE.STUMP) c.offsetHSL(0, 0, (rnd(x, y) - 0.5) * 0.06);
      if (t === TILE.FLOOR && ((x + y) & 1)) c.offsetHSL(0, 0, -0.025);
      if (t === TILE.SIDEWALK && (x % 2 === 0) !== (y % 2 === 0)) c.offsetHSL(0, 0, -0.02);
      const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2); g.translate(x + 0.5, 0, y + 0.5); geos.push(colorAttr(g, c.getHex()));
      // road markings: dashed centre line on both roads, none in the crossing
      const onX = t === TILE.ROAD && y === 23 && (x < 22 || x > 25) && (x & 1) === 0, onZ = t === TILE.ROAD && x === 23 && (y < 22 || y > 25) && (y & 1) === 0;
      if (onX || onZ) { const d = new THREE.PlaneGeometry(onX ? 0.7 : 0.12, onX ? 0.12 : 0.7); d.rotateX(-Math.PI / 2); d.translate(onX ? x + 0.5 : x + 1, 0.005, onX ? y + 1 : y + 0.5); geos.push(colorAttr(d, 0xd8c04a)); }
    }
    const ground = new THREE.Mesh(mergeGeometries(geos), this.mat); ground.name = 'ground'; this.group.add(ground);
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2).translate(w.w / 2, -0.02, w.h / 2), new THREE.MeshLambertMaterial({ color: 0x3f6a2c })); apron.name = 'apron';
    this.group.add(apron);
  }
  // ---- per structure: merged wall mesh (with frames around openings) + instanced doors / glass / planks ----
  buildStructures() {
    const w = this.world; this.structures = [];
    for (const s of w.structures) {
      const col = WALL_COLOR[s.name] ?? 0xbbbbbb, top = new THREE.Color(col).offsetHSL(0, 0, -0.12).getHex();
      const geos = [], openings = [];
      for (let y = s.y0; y <= s.y1; y++) for (let x = s.x0; x <= s.x1; x++) {
        const t = w.get(x, y); if (!isWallish(t)) continue;
        const cx = x + 0.5, cz = y + 0.5;
        if (t === TILE.WALL) { geos.push(box(1, WALL_H, 1, cx, WALL_H / 2, cz, col, top)); continue; }
        const alongX = isWallish(w.get(x - 1, y)) || isWallish(w.get(x + 1, y));
        const o = w.opening(x, y); openings.push({ o, alongX, x, y, inward: alongX ? Math.sign((s.y0 + s.y1) / 2 + 0.5 - cz) || 1 : Math.sign((s.x0 + s.x1) / 2 + 0.5 - cx) || 1 });
        const post = (off) => alongX ? box(0.1, WALL_H, 1, cx + off, WALL_H / 2, cz, col, top) : box(1, WALL_H, 0.1, cx, WALL_H / 2, cz + off, col, top);
        geos.push(post(-0.45), post(0.45));
        if (t === TILE.DOOR) geos.push(box(1, 0.5, 1, cx, WALL_H - 0.25, cz, col, top));
        else { geos.push(box(1, 1.0, 1, cx, 0.5, cz, col, top)); geos.push(box(1, 0.6, 1, cx, WALL_H - 0.3, cz, col, top)); }
      }
      const g = new THREE.Group(); g.name = s.name;
      const wall = new THREE.Mesh(mergeGeometries(geos), this.mat); g.add(wall);
      const fittings = new THREE.Group(); g.add(fittings);   // doors / glass / planks: lowered less than the walls so barricades stay readable
      // door slabs: hinge edge at the origin, slab extends +X (0.84 wide), 2.1 high, 0.1 thick
      const doorGeo = colorAttr(new THREE.BoxGeometry(0.84, 2.1, 0.1).translate(0.42, 1.05, 0), 0x7a4e2a, 0x8a5e3a);
      const doors = new THREE.InstancedMesh(doorGeo, this.mat, Math.max(1, openings.filter((e) => e.o.kind === 'door').length));
      // glass: 2 instances per window (intact pane, or two jagged shards once broken); planks: 3 per opening on BOTH faces
      // (the closed door slab would otherwise hide interior-only planks from the outside where the horde attacks)
      const glass = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.8, 1.0), new THREE.MeshBasicMaterial({ color: 0xa8e0f0, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }), Math.max(1, openings.filter((e) => e.o.kind === 'window').length * 2));
      const planks = new THREE.InstancedMesh(colorAttr(new THREE.BoxGeometry(1.1, 0.16, 0.08), 0xb8894a, 0xc89a5a), this.mat, Math.max(1, openings.length * 6));
      for (const im of [doors, glass, planks]) { im.frustumCulled = false; fittings.add(im); }
      this.group.add(g);
      this.structures.push({ def: s, group: g, wall, fittings, doors, glass, planks, openings, doorAngle: new Map() });
    }
  }
  // ---- car wreck + gas pumps (static, merged into one mesh) ----
  buildProps() {
    const w = this.world, geos = [];
    const wreck = []; for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) { const t = w.get(x, y); if (t === TILE.WRECK) wreck.push([x, y]); if (t === TILE.PUMP) { geos.push(box(0.5, 1.5, 0.34, x + 0.5, 0.75, y + 0.5, 0xc8392b, 0xe0e0e0)); geos.push(box(0.6, 0.12, 0.44, x + 0.5, 0.06, y + 0.5, 0x777777)); geos.push(box(0.36, 0.3, 0.06, x + 0.5, 1.1, y + 0.5 + 0.18, 0xe8e8e8)); } }
    if (wreck.length) {
      const x0 = Math.min(...wreck.map((p) => p[0])), x1 = Math.max(...wreck.map((p) => p[0])) + 1, y0 = wreck[0][1];
      const cx = (x0 + x1) / 2, cz = y0 + 0.5, L = x1 - x0;
      geos.push(box(L - 0.1, 0.55, 0.9, cx, 0.45, cz, 0x6b4a34, 0x7a5a3e));                      // body
      geos.push(box(L * 0.5, 0.5, 0.8, cx - 0.1, 0.95, cz, 0x4a3a30, 0x5a4a3c));                  // cabin
      for (const [dx, dz] of [[-0.6, -0.42], [0.6, -0.42], [-0.6, 0.42], [0.6, 0.42]]) geos.push(box(0.4, 0.4, 0.2, cx + dx, 0.22, cz + dz, 0x1a1a1a));
      this.wreck = { x: x0, z: y0, L };
    }
    if (geos.length) this.group.add(new THREE.Mesh(mergeGeometries(geos), this.mat));
  }
  // ---- trees: instanced trunk / canopy / stump, with per-instance canopy tint ----
  buildTrees() {
    const w = this.world; const keys = [...w.trees.keys()]; this.treeIndex = new Map(keys.map((k, i) => [k, i])); const n = Math.max(1, keys.length);
    const trunk = new THREE.InstancedMesh(colorAttr(new THREE.BoxGeometry(0.3, 1.3, 0.3).translate(0, 0.65, 0), 0x5a3d22), this.mat, n);
    const canopyGeo = mergeGeometries([colorAttr(new THREE.BoxGeometry(1.4, 1.2, 1.4).translate(0, 1.8, 0), 0x2f7a2a, 0x3f8f34), colorAttr(new THREE.BoxGeometry(0.9, 0.8, 0.9).translate(0, 2.8, 0), 0x2f7a2a, 0x3f8f34)]);
    const canopy = new THREE.InstancedMesh(canopyGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), n);
    const stump = new THREE.InstancedMesh(colorAttr(new THREE.BoxGeometry(0.5, 0.35, 0.5).translate(0, 0.17, 0), 0x6a4a2a, 0x9a7a4a), this.mat, n);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0); const col = new THREE.Color();
    keys.forEach((k, i) => {
      const [x, y] = k.split(',').map(Number); const r = ((x * 7 + y * 13) % 11) / 11;
      _m.makeRotationY(r * 1.4).setPosition(x + 0.5, 0, y + 0.5); _s.setScalar(0.85 + r * 0.3); _m.scale(_s);
      trunk.setMatrixAt(i, _m); canopy.setMatrixAt(i, _m); stump.setMatrixAt(i, zero);
      canopy.setColorAt(i, col.setHSL(0.28 + r * 0.06, 0.45, 0.42 + r * 0.14));
    });
    for (const im of [trunk, canopy, stump]) { im.frustumCulled = false; this.group.add(im); }
    this.trees = { trunk, canopy, stump, keys };
  }
  // ---- containers: bodies merged, lids/goods instanced (hinge at origin, extends +Z, height +Y, normal +X) ----
  buildContainers() {
    const w = this.world, geos = [], list = [];
    for (const c of w.containers) {
      const def = CONTAINERS[c.kind] || CONTAINERS.cabinet; const cx = c.x + 0.5, cz = c.y + 0.5;
      // face the open side of the room: pick the walkable 4-neighbour that points most towards the structure centre
      let facing = 0;
      if (def.lidKind !== 'trunk') {
        const st = w.structures.find((s) => c.x >= s.x0 && c.x <= s.x1 && c.y >= s.y0 && c.y <= s.y1);
        const mx = st ? (st.x0 + st.x1) / 2 + 0.5 : cx, mz = st ? (st.y0 + st.y1) / 2 + 0.5 : cz;
        let best = -1e9;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const t = w.get(c.x + dx, c.y + dz); if (t !== TILE.FLOOR && t !== TILE.GRASS && t !== TILE.ROAD && t !== TILE.SIDEWALK) continue; const score = dx * (mx - cx) + dz * (mz - cz); if (score > best) { best = score; facing = Math.atan2(dz, dx); } }
        // body: local +X is the front; rotate the box footprint (d along X, w along Z)
        const g = new THREE.BoxGeometry(def.d, def.h, def.w).translate(0, def.h / 2, 0); g.rotateY(-facing); g.translate(cx, 0, cz); geos.push(colorAttr(g, def.color, new THREE.Color(def.color).offsetHSL(0, 0, -0.08).getHex()));
        if (c.kind === 'shelf') for (const hy of [0.6, 1.2]) { const p = new THREE.BoxGeometry(def.d + 0.02, 0.05, def.w).translate(0, hy, 0); p.rotateY(-facing); p.translate(cx, 0, cz); geos.push(colorAttr(p, 0x8a6538)); }
      }
      list.push({ c, def, facing, cx, cz, angle: 0 });
    }
    if (geos.length) this.group.add(new THREE.Mesh(mergeGeometries(geos), this.mat));
    const lidGeo = colorAttr(new THREE.BoxGeometry(0.06, 1, 1).translate(0, 0.5, 0.5), 0xffffff);
    this.lids = new THREE.InstancedMesh(lidGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), Math.max(1, list.length)); this.lids.frustumCulled = false;
    list.forEach((e, i) => this.lids.setColorAt(i, new THREE.Color(e.def.lid)));
    this.group.add(this.lids); this.containers = list;
  }
  // Structure the player is inside (walls included), or null.
  structureAt(x, y) { return this.world.structures.find((s) => x >= s.x0 && x < s.x1 + 1 && y >= s.y0 && y < s.y1 + 1) || null; }
  // Per-frame: cutaway lerp, door swing, glass/plank/lid/tree instance matrices from the sim world.
  update(dt, playerX, playerY) {
    const inside = this.structureAt(playerX, playerY);
    for (const st of this.structures) {
      const want = inside === st.def ? 1 : 0; const cur = this.cut.get(st.def.name) ?? want; const k = 1 - Math.exp(-dt * 7);
      const f = cur + (want - cur) * k; this.cut.set(st.def.name, f);
      st.wall.scale.y = 1 + (CUTAWAY_H / WALL_H - 1) * f; st.fittings.scale.y = 1 - 0.4 * f;
      let di = 0, gi = 0, pi = 0;
      for (const e of st.openings) {
        const o = e.o, cx = e.x + 0.5, cz = e.y + 0.5, base = e.alongX ? 0 : -Math.PI / 2;
        if (o.kind === 'door') {
          const target = o.hp <= 0 ? 0 : o.open ? Math.PI * 0.5 * e.inward : 0; const prev = st.doorAngle.get(o) ?? target; const a = prev + (target - prev) * Math.min(1, dt * 9); st.doorAngle.set(o, a);
          // hinge sits on the -X (or -Z) post; a broken door lies flat on the floor inside
          _v.set(e.alongX ? cx - 0.42 : cx, 0, e.alongX ? cz : cz - 0.42);
          _e.set(o.hp <= 0 ? Math.PI / 2 * e.inward : 0, base - a, 0, 'YXZ'); _q.setFromEuler(_e); _s.setScalar(1); _m.compose(_v, _q, _s); st.doors.setMatrixAt(di++, _m);
        } else if (o.hp > 0) {
          _v.set(cx, 1.5, cz); _e.set(0, base, 0); _q.setFromEuler(_e); _s.setScalar(1); _m.compose(_v, _q, _s); st.glass.setMatrixAt(gi++, _m);
          _s.setScalar(0); _m.compose(_v, _q, _s); st.glass.setMatrixAt(gi++, _m);
        } else {
          // broken: two jagged shards left in the sill corners (bottom-left tall sliver, top-right stub) read as smashed, not open
          const ax = e.alongX ? 1 : 0, az = 1 - ax;
          _v.set(cx - 0.28 * ax, 1.18, cz - 0.28 * az); _e.set(0, base, 0.35); _q.setFromEuler(_e); _s.set(0.3, 0.4, 1); _m.compose(_v, _q, _s); st.glass.setMatrixAt(gi++, _m);
          _v.set(cx + 0.3 * ax, 1.86, cz + 0.3 * az); _e.set(0, base, -0.5); _q.setFromEuler(_e); _s.set(0.25, 0.28, 1); _m.compose(_v, _q, _s); st.glass.setMatrixAt(gi++, _m);
        }
        const n = o.barricade > 0 ? Math.ceil(3 * o.barricade / (o.barricadeMax || 1)) : 0;
        for (let side = 0; side < 2; side++) for (let i = 0; i < 3; i++) {
          if (i < n) { const off = 0.3 * e.inward * (side ? -1 : 1); _v.set(e.alongX ? cx : cx + off, 0.7 + i * 0.6, e.alongX ? cz + off : cz); _e.set(0, base, (i & 1 ? -1 : 1) * 0.1 + i * 0.03); _q.setFromEuler(_e); _s.setScalar(1); }
          else { _v.set(cx, 0, cz); _q.identity(); _s.setScalar(0); }
          _m.compose(_v, _q, _s); st.planks.setMatrixAt(pi++, _m);
        }
      }
      st.doors.instanceMatrix.needsUpdate = true; st.glass.instanceMatrix.needsUpdate = true; st.planks.instanceMatrix.needsUpdate = true;
    }
    // container lids swing open once looted (trunk lifts, shelf goods vanish)
    this.containers.forEach((e, i) => {
      const target = e.c.opened ? 1 : 0; e.angle += (target - e.angle) * Math.min(1, dt * 6); const d = e.def;
      if (d.lidKind === 'trunk') {
        const wr = this.wreck; if (!wr) return; _m.makeTranslation(wr.x + 0.15, 0.73, wr.z + 0.1); _m2.makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)); _m.multiply(_m2);
        _m.multiply(_m2.makeRotationY(-e.angle * 1.3)); _m.multiply(_m2.makeScale(1, 0.8, 0.8)); this.lids.setMatrixAt(i, _m); return;
      }
      const sc = d.lidKind === 'goods' ? 1 - e.angle : 1, swing = d.lidKind === 'goods' ? 0 : e.angle * 1.7;
      _v.set(d.d / 2 + 0.03, 0, -d.w / 2 + 0.02).applyAxisAngle(Y, -e.facing).add(_s.set(e.cx, 0, e.cz)); if (d.lidKind === 'goods') _v.y = 0.65;
      _m.makeTranslation(_v.x, _v.y, _v.z); _m.multiply(_m2.makeRotationY(-e.facing + swing)); _m.multiply(_m2.makeScale(sc, d.lidKind === 'goods' ? 0.5 : d.h * 0.96, sc * (d.w - 0.04))); this.lids.setMatrixAt(i, _m);
    });
    this.lids.instanceMatrix.needsUpdate = true;
    // trees: a harvested tree becomes a stump (tile flips to STUMP)
    if (this.world.trees.size !== this.treeCount) {
      this.treeCount = this.world.trees.size; const zero = _m2.makeScale(0, 0, 0);
      this.trees.keys.forEach((k, i) => { if (!this.world.trees.has(k)) { const [x, y] = k.split(',').map(Number); this.trees.trunk.setMatrixAt(i, zero); this.trees.canopy.setMatrixAt(i, zero); this.trees.stump.setMatrixAt(i, _m.makeTranslation(x + 0.5, 0, y + 0.5)); } });
      this.trees.trunk.instanceMatrix.needsUpdate = this.trees.canopy.instanceMatrix.needsUpdate = this.trees.stump.instanceMatrix.needsUpdate = true;
    }
  }
}
