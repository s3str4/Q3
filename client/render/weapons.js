// Weapon meshes built from primitives with canvas-generated textures, shared by the viewmodel, the player model
// (third person) and item pickups: the gun in the enemy's hands is exactly the gun in ours.
// Local frame: +X forward (barrel), +Z up, +Y left. Sizes are in Quake units (a weapon is ~45 units long).
// Static parts are merged into one mesh per material (3-5 draw calls a weapon); animated parts (the gauntlet's saw
// blade, the shotgun's pump) stay separate children, and `live: true` gives the instance its own copies of the
// glow materials so a viewmodel can pulse its LG core / charge its rail coil without touching every other copy.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WEAPONS } from '../../shared/constants.js';

export const WEAPON_COLORS = { [WEAPONS.ROCKET]: 0xff6a3a, [WEAPONS.RAIL]: 0x5cff9d, [WEAPONS.LIGHTNING]: 0xbfe8ff, [WEAPONS.SHOTGUN]: 0xffc86a, [WEAPONS.PLASMA]: 0xb26cff, [WEAPONS.MACHINEGUN]: 0xffe680, [WEAPONS.GAUNTLET]: 0xff9a5c };
export function weaponColor(w) { return WEAPON_COLORS[w] || 0xffffff; }

// ---------- procedural textures ----------
const hash = (x, y, s = 0) => { const v = Math.sin(x * 12.9898 + y * 78.233 + s * 37.719) * 43758.5453; return v - Math.floor(v); };
function vnoise(x, y, scale, seed = 0) {
  const xs = x / scale, ys = y / scale, x0 = Math.floor(xs), y0 = Math.floor(ys), fx = xs - x0, fy = ys - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, seed), b = hash(x0 + 1, y0, seed), c = hash(x0, y0 + 1, seed), d = hash(x0 + 1, y0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function paint(size, fn, linear = false) {
  const c = document.createElement('canvas'); c.width = c.height = size; const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size); const d = img.data; const px = [0, 0, 0];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { fn(px, x, y); const i = (y * size + x) * 4; d[i] = clamp01(px[0]) * 255; d[i + 1] = clamp01(px[1]) * 255; d[i + 2] = clamp01(px[2]) * 255; d[i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
const TEX = {};
export function weaponTexture(kind) {
  if (TEX[kind]) return TEX[kind];
  const s = 128;
  let t;
  if (kind === 'gunmetal') { // brushed blue-grey steel: horizontal brushing, panel seams, a rivet in each corner, scratches and grime
    t = paint(s, (px, x, y) => {
      const brush = vnoise(x, y * 9, 6, 1) * 0.16;
      const gx = x / s, gy = y / s, edge = Math.min(gx, 1 - gx, gy, 1 - gy);
      const seam = edge < 0.035 ? 0.55 : edge < 0.05 ? 0.85 : 1;
      const rx = Math.min(gx, 1 - gx) * s, ry = Math.min(gy, 1 - gy) * s, rivet = Math.hypot(rx - 9, ry - 9) < 3 ? 1.35 : 1;
      const scratch = vnoise(x * 0.3 + y, y * 0.05, 5, 4) > 0.82 ? 0.25 : 0;
      const grime = vnoise(x, y, 28, 7) * 0.22;
      const v = (0.72 + brush - grime + scratch) * seam * rivet;
      px[0] = v * 0.88; px[1] = v * 0.91; px[2] = v;
    });
  } else if (kind === 'wood') { // dark walnut: grain streaks with knots
    t = paint(s, (px, x, y) => {
      const g = vnoise(x * 0.25, y * 3 + Math.sin(x * 0.12) * 6, 4, 2), k = vnoise(x, y, 20, 3);
      const v = 0.55 + g * 0.5 - k * 0.25;
      px[0] = v * 0.95; px[1] = v * 0.62; px[2] = v * 0.36;
    });
  } else if (kind === 'blade') { // saw blade: radial brushing and a scorched ring
    t = paint(s, (px, x, y) => {
      const dx = x - s / 2, dy = y - s / 2, r = Math.hypot(dx, dy) / (s / 2), a = Math.atan2(dy, dx);
      const v = 0.7 + Math.sin(a * 40 + r * 8) * 0.06 + vnoise(a * 30, r * 60, 3, 5) * 0.15 - (r > 0.6 && r < 0.72 ? 0.25 : 0);
      px[0] = v * 0.95; px[1] = v * 0.95; px[2] = v;
    });
  }
  return (TEX[kind] = t);
}

// Constant white light map = the Q3 light-grid ambient for models: lifts the albedo uniformly whatever the room's
// lights do (a dark corner never swallows a player or a gun), one shared 1x1 texture, no extra draw cost.
let ambientMap = null;
export function ambientLightMap() {
  if (!ambientMap) { ambientMap = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); ambientMap.needsUpdate = true; }
  return ambientMap;
}
export const MODEL_AMBIENT = 0.7;

// ---------- shared materials (one program each; no runtime creation) ----------
const MATS = {};
function mat(key, make) { return MATS[key] || (MATS[key] = make()); }
// no environment map in the scene, so keep metalness moderate or the parts go black under hemisphere light
const body = () => mat('body', () => new THREE.MeshStandardMaterial({ map: weaponTexture('gunmetal'), color: 0xdde4ee, lightMap: ambientLightMap(), lightMapIntensity: MODEL_AMBIENT, roughness: 0.42, metalness: 0.3 }));
const dark = () => mat('dark', () => new THREE.MeshStandardMaterial({ map: weaponTexture('gunmetal'), color: 0x6a707c, lightMap: ambientLightMap(), lightMapIntensity: MODEL_AMBIENT, roughness: 0.6, metalness: 0.25 }));
const wood = () => mat('wood', () => new THREE.MeshStandardMaterial({ map: weaponTexture('wood'), color: 0xc08a5a, lightMap: ambientLightMap(), lightMapIntensity: MODEL_AMBIENT, roughness: 0.78, metalness: 0.05 }));
const steel = () => mat('steel', () => new THREE.MeshStandardMaterial({ map: weaponTexture('blade'), color: 0xe8ecf2, lightMap: ambientLightMap(), lightMapIntensity: MODEL_AMBIENT, roughness: 0.3, metalness: 0.35 }));
const accent = (c) => mat('acc' + c, () => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.5 }));
const glow = (c) => mat('glow' + c, () => new THREE.MeshBasicMaterial({ color: c }));

// Geometry cache: identical primitives are shared across all instances.
const GEOS = {};
function geo(key, make) { return GEOS[key] || (GEOS[key] = make()); }
const cyl = (r1, r2, h, n = 12) => geo(`c${r1},${r2},${h},${n}`, () => new THREE.CylinderGeometry(r1, r2, h, n));
const box = (w, d, h) => geo(`b${w},${d},${h}`, () => new THREE.BoxGeometry(w, d, h));
const sph = (r, n = 12) => geo(`s${r},${n}`, () => new THREE.SphereGeometry(r, n, Math.max(6, n - 4)));
const tor = (r, t, n = 14) => geo(`t${r},${t},${n}`, () => new THREE.TorusGeometry(r, t, 6, n));

// makeWeaponMesh(weapon, scale, { live }) -> Group with userData { muzzle:[x,y,z], blade, pump, live:{...} }
export function makeWeaponMesh(w, scale = 1, opts = {}) {
  const g = new THREE.Group();
  const c = weaponColor(w);
  // instance-owned glow materials (viewmodel animation) or the shared ones
  const live = opts.live ? { core: glow(c).clone(), coil: accent(c).clone() } : null;
  const coreMat = live ? live.core : glow(c), coilMat = live ? live.coil : accent(c);
  const add = (gm, m, x, y, z, rx = 0, ry = 0, rz = 0) => { const mesh = new THREE.Mesh(gm, m); mesh.position.set(x, y, z); mesh.rotation.set(rx, ry, rz); g.add(mesh); return mesh; };
  const tube = (r, len, x, y, z, m = body(), n = 12) => add(cyl(r, r, len, n), m, x, y, z, 0, 0, Math.PI / 2); // along +X
  const cone = (r1, r2, len, x, y, z, m = body(), n = 12) => add(cyl(r2, r1, len, n), m, x, y, z, 0, 0, Math.PI / 2); // r1 at the back, r2 at the front
  const ring = (r, t, x, y = 0, z = 0, m = accent(c)) => add(tor(r, t), m, x, y, z, 0, Math.PI / 2, 0);
  const grip = (x, z, m = dark()) => { add(box(4.5, 3.6, 9), m, x, 0, z, 0, -0.25, 0); add(box(6, 1.2, 1.2), dark(), x + 3.5, 0, z + 4.2); }; // pistol grip + trigger guard
  let muzzle = [30, 0, 0], anim = null;
  switch (w) {
    case WEAPONS.ROCKET: // fat tube, flared bell with a red tip, shoulder grip on top, vented sides
      tube(6, 40, 8, 0, 0); cone(6, 7.6, 6, 30, 0, 0, dark()); add(cyl(5.2, 5.2, 1, 14), glow(0x1a0a08), 33.4, 0, 0, 0, 0, Math.PI / 2); // bell + dark bore
      ring(7.2, 1.3, 32, 0, 0, accent(0xff3020)); ring(6.6, 0.8, 22); ring(6.6, 0.8, -8);
      cone(4.5, 6.5, 5, -14, 0, 0, dark()); // exhaust
      for (let i = 0; i < 4; i++) add(box(2, 13.4, 1.4), dark(), 12 + i * 3, 0, 6);          // top vents
      add(box(22, 1.6, 1.6), dark(), 8, 6.6, 0); add(box(22, 1.6, 1.6), dark(), 8, -6.6, 0);   // side rails
      add(box(18, 9, 10), body(), -2, 0, -8); add(box(8, 6, 3), dark(), -12, 0, -14);         // receiver, magazine
      add(box(14, 2.6, 2.4), dark(), -4, 0, 10); add(box(2, 2.6, 4), dark(), -10, 0, 8); add(box(2, 2.6, 4), dark(), 2, 0, 8); // shoulder grip / carry handle
      add(box(4, 1, 2.2), glow(c), 4, -4.6, -10); grip(2, -17);
      muzzle = [34, 0, 0]; break;
    case WEAPONS.RAIL: // long twin rails around a thin barrel, a ringed coil, scope, heavy stock
      add(box(52, 1.8, 2.2), body(), 14, 3.6, 2); add(box(52, 1.8, 2.2), body(), 14, -3.6, 2);
      tube(1.4, 50, 14, 0, 2, dark(), 8); tube(3.8, 22, 12, 0, 2, dark(), 12);
      for (let i = 0; i < 6; i++) ring(4.8, 0.8, 2 + i * 4, 0, 2, coilMat);
      add(box(3, 1.8, 3), accent(c), 40, 3.6, 2); add(box(3, 1.8, 3), accent(c), 40, -3.6, 2); add(sph(1.4, 8), coreMat, 40, 0, 2); // muzzle fork + emitter
      add(box(16, 7, 10), body(), -8, 0, -3); add(box(12, 5, 7), dark(), -22, 0, -4); add(box(4, 5.4, 7.4), accent(c), -18, 0, -4); // receiver, stock, stock band
      tube(2.2, 14, -2, 0, 8.5, dark(), 10); add(box(2, 2, 3), dark(), -6, 0, 6); add(box(2, 2, 3), dark(), 2, 0, 6); add(cyl(2.4, 2.4, 0.6, 10), glow(0x7fc8ff), 5.3, 0, 8.5, 0, 0, Math.PI / 2); // scope + lens
      add(box(10, 0.8, 4), accent(c), -8, 4, -2); add(box(10, 0.8, 4), accent(c), -8, -4, -2); grip(-4, -12);
      muzzle = [41, 0, 2]; break;
    case WEAPONS.LIGHTNING: // barrel wrapped by three rods, front emitter ring with a pulsing core, coil pack behind
      tube(3.6, 30, 8, 0, 0); for (let i = 0; i < 3; i++) { const a = i * 2.094 + 0.5; add(box(30, 1.5, 1.5), coilMat, 10, Math.cos(a) * 5.3, Math.sin(a) * 5.3); add(sph(1.1, 8), coreMat, 25.5, Math.cos(a) * 5.3, Math.sin(a) * 5.3); }
      ring(5.6, 1, 24); ring(5.6, 1, -4); add(sph(2.8, 12), coreMat, 25, 0, 0);
      tube(5, 10, -13, 0, 0, dark()); for (let i = 0; i < 3; i++) ring(5.2, 0.6, -16 + i * 3, 0, 0, coilMat);
      add(box(14, 8, 9), body(), -6, 0, -5); add(box(12, 2.6, 2.4), dark(), -4, 0, 8); add(box(2, 2.6, 3), dark(), -9, 0, 6); add(box(2, 2.6, 3), dark(), 1, 0, 6);
      add(cyl(0.8, 0.8, 12, 6), dark(), -10, 4.5, -2, 0, 0, Math.PI / 2); add(box(3, 1, 1.6), glow(c), -2, -4.2, -6); grip(-2, -14);
      muzzle = [28, 0, 0]; break;
    case WEAPONS.SHOTGUN: // side-by-side barrels over a wooden pump, wooden stock
      tube(2.4, 40, 10, 2.7, 1.5); tube(2.4, 40, 10, -2.7, 1.5); add(box(2, 10, 6), dark(), 5, 0, 1.5); add(box(2, 10, 6), dark(), 27, 0, 1.5);
      add(box(14, 7, 8), dark(), -6, 0, -1); add(box(16, 5.5, 7), wood(), -21, 0, -3, 0, 0.06, 0); add(box(4, 3.6, 8), wood(), -8, 0, -8, 0, -0.3, 0); add(box(6, 1.2, 1.2), dark(), -4, 0, -4);
      add(box(4, 0.6, 2.6), dark(), -3, 3.6, 1); add(box(1.5, 1.2, 2), accent(c), 29.5, 0, 4.6); add(box(3, 5, 1), accent(c), -1, 0, 3.5);
      anim = { pump: new THREE.Mesh(box(10, 7.5, 5), wood()) }; anim.pump.position.set(13, 0, -3.5);
      for (let i = 0; i < 3; i++) { const groove = new THREE.Mesh(box(0.8, 7.7, 5.2), dark()); groove.position.x = -3 + i * 3; anim.pump.add(groove); }
      muzzle = [31, 0, 1.5]; break;
    case WEAPONS.PLASMA: // bulbous emitter, three rings on the barrel, finned body, rear tank
      add(box(26, 8, 9), body(), 2, 0, 0); tube(3, 14, 18, 0, 0, dark());
      for (let i = 0; i < 3; i++) ring(5, 1.2, 12 + i * 5, 0, 0, coilMat);
      add(sph(6, 14), accent(c), 26, 0, 0); add(sph(3.6, 10), coreMat, 29.5, 0, 0);
      for (let i = 0; i < 4; i++) add(box(1.2, 9, 3.5), dark(), -4 + i * 4, 0, 6);
      tube(3.5, 10, -16, 0, 3, dark()); add(cyl(3.7, 3.7, 1.2, 12), accent(c), -21.5, 0, 3, 0, 0, Math.PI / 2);
      add(box(12, 2, 1.5), dark(), -4, 0, 5.5); add(box(3, 1, 1.6), glow(c), -4, -4.2, -2); grip(0, -12);
      muzzle = [32, 0, 0]; break;
    case WEAPONS.MACHINEGUN: // slim barrel with a slotted cooling jacket, ammo box on the left, carry handle
      add(box(18, 6, 8), body(), -4, 0, 0); tube(2, 28, 16, 0, 0, body(), 8); tube(3.2, 12, 10, 0, 0, dark(), 10);
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; add(box(9, 0.8, 1), glow(0x0e1014), 10, Math.cos(a) * 3.1, Math.sin(a) * 3.1, a); }
      cone(2.6, 3, 4, 31, 0, 0, dark()); add(cyl(1.4, 1.4, 1, 8), glow(0x0e1014), 33.2, 0, 0, 0, 0, Math.PI / 2);
      add(box(9, 5, 8), dark(), -4, 5.4, -2); add(box(9.4, 5.4, 2), accent(c), -4, 5.4, -1); for (let i = 0; i < 3; i++) add(box(1.4, 3, 1.2), accent(c), -2 + i * 1.8, 3.2, 3.5); // ammo box + belt
      add(box(10, 4, 6), dark(), -18, 0, -2); add(box(10, 2, 2.4), dark(), -2, 0, 7); add(box(2, 2, 3), dark(), -6, 0, 5.5); add(box(2, 2, 3), dark(), 2, 0, 5.5);
      add(box(1.5, 1.5, 3), dark(), 26, 0, 3.5); add(box(1.5, 4, 2), dark(), -10, 0, 5); grip(-6, -11);
      muzzle = [33, 0, 0]; break;
    default: { // gauntlet: armoured forearm, saw housing, spinning toothed blade
      add(box(20, 8, 8), body(), -4, 0, 0); add(box(16, 9, 1.5), dark(), -5, 0, 4.6); add(box(16, 1.5, 9), dark(), -5, 4.6, 0); add(box(16, 1.5, 9), dark(), -5, -4.6, 0);
      add(box(8, 6, 8), dark(), 8, 0, 0); add(box(6, 7, 1.5), accent(c), 8, 0, 4.4); add(cyl(1.2, 1.2, 6, 8), dark(), 15, 0, 0);
      // the blade lies flat (spins about the vertical axis) so it reads from the first-person camera above it as
      // well as from the side; it sticks out past the fist
      const blade = new THREE.Group(); blade.position.set(15, 0, 0.5);
      const disc = new THREE.Mesh(cyl(6.5, 6.5, 1.4, 16), steel()); blade.add(disc);
      for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; const tooth = new THREE.Mesh(box(2.6, 2.2, 1.4), steel()); tooth.position.set(Math.cos(a) * 6.8, Math.sin(a) * 6.8, 0); tooth.rotation.z = a + 0.4; blade.add(tooth); }
      const hub = new THREE.Mesh(cyl(2.4, 2.4, 1.8, 10), coreMat); blade.add(hub);
      anim = { blade };
      muzzle = [20, 0, 0]; break;
    }
  }
  mergeByMaterial(g);
  if (anim) for (const k in anim) g.add(anim[k]);
  g.scale.setScalar(scale);
  g.userData.muzzle = muzzle.map((v) => v * scale);
  g.userData.blade = anim && anim.blade || null; g.userData.pump = anim && anim.pump || null; g.userData.live = live;
  return g;
}

// Collapse the ~20 primitive parts of a weapon into one mesh per material (4-5 draw calls instead of ~20): with
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
