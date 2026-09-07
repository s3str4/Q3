// Weapon meshes built from primitives, shared by the viewmodel, the enemy player model and item pickups.
// Local frame: +X forward (barrel), +Z up, +Y left. Sizes are in Quake units (a weapon is ~40 units long).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WEAPONS } from '../../shared/constants.js';

export const WEAPON_COLORS = { [WEAPONS.ROCKET]: 0xff6a3a, [WEAPONS.RAIL]: 0x5cff9d, [WEAPONS.LIGHTNING]: 0xbfe8ff, [WEAPONS.SHOTGUN]: 0xffc86a, [WEAPONS.PLASMA]: 0xb26cff, [WEAPONS.MACHINEGUN]: 0xffe680, [WEAPONS.GAUNTLET]: 0xff9a5c };
export function weaponColor(w) { return WEAPON_COLORS[w] || 0xffffff; }

const MATS = {};
function mat(key, make) { return MATS[key] || (MATS[key] = make()); }
// no environment map in the scene, so keep metalness moderate or the parts go black under hemisphere light
const body = () => mat('body', () => new THREE.MeshStandardMaterial({ color: 0x7a8290, roughness: 0.42, metalness: 0.45 }));
const dark = () => mat('dark', () => new THREE.MeshStandardMaterial({ color: 0x262a33, roughness: 0.55, metalness: 0.3 }));
const wood = () => mat('wood', () => new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.75, metalness: 0.1 }));
const accent = (c) => mat('acc' + c, () => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.55, roughness: 0.3, metalness: 0.5 }));
const glow = (c) => mat('glow' + c, () => new THREE.MeshBasicMaterial({ color: c }));

// Geometry cache: identical primitives are shared across all instances.
const GEOS = {};
function geo(key, make) { return GEOS[key] || (GEOS[key] = make()); }
const cyl = (r1, r2, h, n = 12) => geo(`c${r1},${r2},${h},${n}`, () => new THREE.CylinderGeometry(r1, r2, h, n));
const box = (w, d, h) => geo(`b${w},${d},${h}`, () => new THREE.BoxGeometry(w, d, h));
const sph = (r, n = 12) => geo(`s${r},${n}`, () => new THREE.SphereGeometry(r, n, Math.max(6, n - 4)));
const tor = (r, t) => geo(`t${r},${t}`, () => new THREE.TorusGeometry(r, t, 8, 18));

export function makeWeaponMesh(w, scale = 1) {
  const g = new THREE.Group();
  const c = weaponColor(w);
  const add = (gm, m, x, y, z, rx = 0, ry = 0, rz = 0) => { const mesh = new THREE.Mesh(gm, m); mesh.position.set(x, y, z); mesh.rotation.set(rx, ry, rz); g.add(mesh); return mesh; };
  const tube = (r, len, x, y, z, m = body(), n = 12) => add(cyl(r, r, len, n), m, x, y, z, 0, 0, Math.PI / 2); // along +X
  const ring = (r, t, x, y = 0, z = 0) => add(tor(r, t), accent(c), x, y, z, 0, Math.PI / 2, 0);
  let muzzle = [30, 0, 0];
  switch (w) {
    case WEAPONS.ROCKET:
      tube(5.5, 36, 8, 0, 0); tube(6.5, 5, 27, 0, 0, dark()); ring(6.8, 0.8, 24); ring(6.8, 0.8, -6);
      add(box(16, 9, 11), body(), -8, 0, -7); add(box(6, 3, 9), dark(), 2, 0, -12); // receiver + grip
      add(box(8, 2.5, 4), accent(c), 6, 0, 7.5); add(box(14, 3, 3), dark(), -2, 0, 7); // sight rail
      muzzle = [30, 0, 0]; break;
    case WEAPONS.RAIL:
      add(box(44, 5, 6), body(), 8, 0, 0); tube(1.6, 46, 10, 0, 4.2, accent(c), 8); tube(1.6, 46, 10, 0, -4.2, accent(c), 8);
      ring(4.5, 0.9, 20); ring(4.5, 0.9, 8); ring(4.5, 0.9, -4);
      add(box(12, 7, 9), dark(), -10, 0, -4); add(box(5, 3, 8), dark(), 0, 0, -9); add(cyl(2.5, 2.5, 10, 10), dark(), -4, 0, 6, 0, 0, Math.PI / 2); // stock, grip, scope
      muzzle = [33, 0, 0]; break;
    case WEAPONS.LIGHTNING:
      tube(3.8, 32, 6, 0, 0); for (let i = 0; i < 3; i++) { const a = i * 2.094; add(box(26, 1.6, 1.6), accent(c), 14, Math.cos(a) * 5.2, Math.sin(a) * 5.2); }
      ring(5.5, 1, 4); ring(5.5, 1, -4); add(sph(3, 10), glow(c), 27, 0, 0);
      add(box(14, 9, 11), body(), -10, 0, -5); add(box(6, 3, 9), dark(), -2, 0, -12);
      muzzle = [28, 0, 0]; break;
    case WEAPONS.SHOTGUN:
      tube(2.7, 38, 8, -2.8, 1); tube(2.7, 38, 8, 2.8, 1); add(box(10, 7, 4), dark(), 12, 0, -2); // barrels + pump
      add(box(16, 7, 8), wood(), -12, 0, -3); add(box(6, 3, 8), wood(), -2, 0, -10); add(box(3, 6, 2), accent(c), 8, 0, 4.5);
      muzzle = [27, 0, 1]; break;
    case WEAPONS.PLASMA:
      add(box(28, 8, 8), body(), 4, 0, 0); add(sph(5.5), accent(c), 22, 0, 0); ring(6, 1.2, 12); ring(6, 1.2, 2);
      add(box(10, 8, 10), dark(), -10, 0, -5); add(box(5, 3, 8), dark(), 0, 0, -10); add(cyl(2, 2, 12, 8), accent(c), 4, 0, 6, 0, 0, Math.PI / 2);
      muzzle = [28, 0, 0]; break;
    case WEAPONS.MACHINEGUN:
      tube(2.2, 32, 12, 0, 0, body(), 8); tube(3.2, 10, 6, 0, 0, dark(), 10); add(box(16, 6, 9), body(), -6, 0, -3);
      add(box(6, 5, 8), dark(), -4, 0, -10); add(box(6, 7, 6), accent(c), -2, 0, -2); add(box(4, 1.5, 3), accent(c), 14, 0, 3.5); // ammo box, front sight
      muzzle = [28, 0, 0]; break;
    default: // gauntlet: forearm + spinning blade
      add(box(18, 8, 8), body(), -2, 0, 0); add(cyl(6, 6, 2, 16), accent(c), 10, 0, 0, 0, 0, Math.PI / 2); add(cyl(3, 3, 3, 10), dark(), 10, 0, 0, 0, 0, Math.PI / 2);
      muzzle = [13, 0, 0]; break;
  }
  mergeByMaterial(g);
  g.scale.setScalar(scale);
  g.userData.muzzle = muzzle.map((v) => v * scale);
  return g;
}

// Collapse the ~10 primitive parts of a weapon into one mesh per material (3 draw calls instead of ~10): with
// dozens of pickups plus the enemy's and our own weapon in view, this is most of the item draw-call budget.
function mergeByMaterial(g) {
  const byMat = new Map();
  for (const m of [...g.children]) {
    m.updateMatrix();
    const geo = m.geometry.clone().applyMatrix4(m.matrix);
    if (!byMat.has(m.material)) byMat.set(m.material, []);
    byMat.get(m.material).push(geo);
    g.remove(m);
  }
  for (const [material, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    for (const gg of geos) gg.dispose();
    if (merged) g.add(new THREE.Mesh(merged, material));
  }
}
