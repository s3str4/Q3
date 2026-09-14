// Weapon meshes built from primitives with canvas-generated textures, shared by the viewmodel, the player model
// (third person) and item pickups: the gun in the enemy's hands is exactly the gun in ours.
// Local frame: +X forward (barrel), +Z up, +Y left. Sizes are in Quake units (a weapon is ~45 units long).
// Detail is geometry, not paint: bevelled plates (extruded rectangles with a chamfer), recessed panel lines, bolts,
// vents and cooling holes, a loaded rocket in the RL bell, an ammo belt on the MG, ringed energy coils on the RG / LG.
// Static parts are merged into one mesh per material (5-8 draw calls a weapon); animated parts (the gauntlet's saw
// blade + its motion-blur ring, the shotgun's pump, the LG's crawling arc) stay separate children, and `live: true`
// gives the instance its own copies of the glow materials so a viewmodel can pulse its LG core / charge its rail
// coil without touching every other copy.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WEAPONS } from '../../shared/constants.js';
import { getSprite } from './particles.js';

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
  } else if (kind === 'brass') { // cartridge brass: bright with a vertical brushing and a dark crimp band
    t = paint(s, (px, x, y) => {
      const v = 0.8 + vnoise(x * 6, y, 5, 8) * 0.2 - (y / s > 0.78 && y / s < 0.86 ? 0.35 : 0);
      px[0] = v; px[1] = v * 0.82; px[2] = v * 0.45;
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
const brass = () => mat('brass', () => new THREE.MeshStandardMaterial({ map: weaponTexture('brass'), color: 0xf0c060, lightMap: ambientLightMap(), lightMapIntensity: MODEL_AMBIENT, roughness: 0.35, metalness: 0.5 }));
const accent = (c) => mat('acc' + c, () => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.5 }));
const glow = (c) => mat('glow' + c, () => new THREE.MeshBasicMaterial({ color: c }));
const line = () => glow(0x0c0e12);   // recessed panel lines, vent slots, bores, cooling holes: unlit near-black
const blurMat = () => mat('blur', () => new THREE.MeshBasicMaterial({ color: 0xdfe6ee, map: getSprite('blur'), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));

// Geometry cache: identical primitives are shared across all instances.
const GEOS = {};
function geo(key, make) { return GEOS[key] || (GEOS[key] = make()); }
const cyl = (r1, r2, h, n = 12) => geo(`c${r1},${r2},${h},${n}`, () => new THREE.CylinderGeometry(r1, r2, h, n));
const box = (w, d, h) => geo(`b${w},${d},${h}`, () => new THREE.BoxGeometry(w, d, h));
const sph = (r, n = 12) => geo(`s${r},${n}`, () => new THREE.SphereGeometry(r, n, Math.max(6, n - 4)));
const tor = (r, t, n = 14) => geo(`t${r},${t},${n}`, () => new THREE.TorusGeometry(r, t, 6, n));
// Bevelled box: a rectangle inset by the chamfer, extruded with a one-segment bevel so every edge is a chamfer that
// catches the light (a plain BoxGeometry reads as a flat-shaded slab). Extrude UVs are in units: scaled so the
// texture spans the largest dimension once, like a BoxGeometry face.
const bev = (w, d, h, b = 0.6) => geo(`v${w},${d},${h},${b}`, () => {
  const s = new THREE.Shape(), x = w / 2 - b, y = d / 2 - b;
  s.moveTo(-x, -y); s.lineTo(x, -y); s.lineTo(x, y); s.lineTo(-x, y); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: h - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 1, steps: 1 });
  g.center();
  const uv = g.attributes.uv, k = 1 / Math.max(w, d, h); for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * k, uv.getY(i) * k);
  return g;
});
// Saw blade: a disc with `teeth` hooked teeth around the rim (one shape, extruded thin), lying in the XZ plane
// (spin axis Y). UVs are the disc's own polar layout so the radial brushing of the 'blade' texture lines up.
const sawGeo = (r, teeth, th) => geo(`saw${r},${teeth},${th}`, () => {
  const s = new THREE.Shape(); const rt = r + 2.4, n = teeth;
  for (let i = 0; i < n; i++) {
    const a0 = i / n * Math.PI * 2, a1 = (i + 0.45) / n * Math.PI * 2, a2 = (i + 0.8) / n * Math.PI * 2;
    const p = (a, rr) => [Math.cos(a) * rr, Math.sin(a) * rr];
    if (i === 0) s.moveTo(...p(a0, r)); else s.lineTo(...p(a0, r));
    s.lineTo(...p(a1, rt)); s.lineTo(...p(a2, r * 0.97));       // hooked tooth: long leading edge, steep trailing edge
  }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: th, bevelEnabled: false });
  g.center();
  const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / (rt * 2) + 0.5, uv.getY(i) / (rt * 2) + 0.5);
  g.rotateX(Math.PI / 2); // extrude axis Z -> -Y: the blade stands in the XZ plane
  return g;
});
const discGeo = (r) => geo(`disc${r}`, () => new THREE.CircleGeometry(r, 32).rotateX(Math.PI / 2));

// makeWeaponMesh(weapon, scale, { live }) -> Group with userData { muzzle:[x,y,z], blade, blur, pump, arc, live:{...} }
export function makeWeaponMesh(w, scale = 1, opts = {}) {
  const g = new THREE.Group();
  const c = weaponColor(w);
  // instance-owned glow materials (viewmodel animation) or the shared ones
  const live = opts.live ? { core: glow(c).clone(), coil: accent(c).clone() } : null;
  const coreMat = live ? live.core : glow(c), coilMat = live ? live.coil : accent(c);
  const add = (gm, m, x, y, z, rx = 0, ry = 0, rz = 0) => { const mesh = new THREE.Mesh(gm, m); mesh.position.set(x, y, z); mesh.rotation.set(rx, ry, rz); g.add(mesh); return mesh; };
  const tube = (r, len, x, y, z, m = body(), n = 12) => add(cyl(r, r, len, n), m, x, y, z, 0, 0, Math.PI / 2); // along +X
  const cone = (r1, r2, len, x, y, z, m = body(), n = 12) => add(cyl(r2, r1, len, n), m, x, y, z, 0, 0, Math.PI / 2); // r1 at the back, r2 at the front
  const ring = (r, t, x, y = 0, z = 0, m = accent(c), n = 14) => add(tor(r, t, n), m, x, y, z, 0, Math.PI / 2, 0);
  const disc = (r, x, y = 0, z = 0, m = line()) => add(cyl(r, r, 0.4, 16), m, x, y, z, 0, 0, Math.PI / 2); // a bore / cap facing +X
  // pistol grip (bevelled, raked back) + trigger guard + trigger
  const grip = (x, z, m = dark()) => { add(bev(4.6, 3.8, 9.5, 0.5), m, x, 0, z, 0, -0.28, 0); add(box(6, 1.1, 1.1), dark(), x + 3.6, 0, z + 4.4); add(box(0.7, 1.4, 2.4), line(), x + 2.6, 0, z + 5.2, 0, 0.3, 0); };
  // recessed panel line along an axis ('x' | 'z') on a surface; sits 0.15 proud of the surface so it never z-fights
  const seam = (len, x, y, z, axis = 'x') => add(axis === 'x' ? box(len, 0.5, 0.5) : axis === 'y' ? box(0.5, len, 0.5) : box(0.5, 0.5, len), line(), x, y, z);
  // hex bolt head
  const bolt = (x, y, z, r = 0.7, rx = 0, rz = Math.PI / 2) => add(cyl(r, r, 0.6, 6), dark(), x, y, z, rx, 0, rz);
  let muzzle = [30, 0, 0], anim = null;
  switch (w) {
    case WEAPONS.ROCKET: { // fat tube with panel rings, flared bell with a red rim and a loaded rocket showing its nose, rear exhaust with vents
      tube(6, 40, 8, 0, 0); for (const x of [-7, 5, 17]) ring(6.05, 0.35, x, 0, 0, line(), 18);   // tube + recessed panel rings
      cone(6, 8, 7, 31.5, 0, 0, dark()); ring(8.1, 0.9, 35, 0, 0, accent(0xff3020));           // bell + red rim
      disc(6.6, 34.6); tube(3.2, 8, 31, 0, 0, dark(), 10); cone(3.2, 0.4, 5, 37.5, 0, 0, accent(0xff3020), 10); // dark bore, rocket body, red nose
      cone(6, 4.2, 6, -15, 0, 0, dark()); disc(3.6, -18.2); for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; add(box(3, 0.6, 1.4), line(), -13.5, Math.cos(a) * 5.4, Math.sin(a) * 5.4, a, 0, 0); } // exhaust cone, bore, vents
      for (let i = 0; i < 4; i++) add(box(2.2, 13.6, 1), line(), 11 + i * 3.2, 0, 6.2);        // top vents
      add(bev(24, 1.6, 1.8, 0.4), dark(), 6, 6.9, 0); add(bev(24, 1.6, 1.8, 0.4), dark(), 6, -6.9, 0);   // side rails
      for (const x of [-4, 6, 16]) { bolt(x, 7.9, 0, 0.6, 0, 0); bolt(x, -7.9, 0, 0.6, 0, 0); }
      add(bev(18, 9, 9.5, 0.9), body(), -2, 0, -8); seam(14, -2, 4.65, -8); seam(14, -2, -4.65, -8); add(bev(8, 6, 3.5, 0.5), dark(), -12, 0, -14.4); // receiver + panel lines + magazine
      add(bev(14, 2.6, 2.4, 0.5), dark(), -4, 0, 10.4); add(box(2, 2.6, 4), dark(), -10, 0, 8); add(box(2, 2.6, 4), dark(), 2, 0, 8); // carry handle
      add(box(1.2, 1.2, 3), dark(), 24, 0, 7.2); add(box(0.6, 3, 0.8), dark(), 24, 0, 8.8);                  // front sight
      add(box(4, 1, 2.2), glow(c), 4, -4.7, -10); grip(2, -17.5);
      muzzle = [38, 0, 0]; break;
    }
    case WEAPONS.RAIL: { // long twin rails around a thin barrel over a stack of glowing energy coils, scope, heavy stock
      add(bev(54, 1.8, 2.4, 0.4), body(), 15, 3.6, 2); add(bev(54, 1.8, 2.4, 0.4), body(), 15, -3.6, 2);
      for (const x of [-6, 4, 14, 24, 34]) { bolt(x, 4.5, 2, 0.5, 0, 0); bolt(x, -4.5, 2, 0.5, 0, 0); }
      tube(1.3, 52, 15, 0, 2, dark(), 8); tube(3.6, 26, 12, 0, 2, dark(), 12);                    // barrel + coil housing
      for (let i = 0; i < 8; i++) ring(4.7, 0.75, 0 + i * 3.6, 0, 2, coilMat, 16);               // energy coils
      for (const x of [-1.8, 12.6, 27]) ring(4.6, 0.5, x, 0, 2, dark(), 12);                       // coil clamps
      add(bev(4, 1.8, 3.2, 0.4), accent(c), 42, 3.6, 2); add(bev(4, 1.8, 3.2, 0.4), accent(c), 42, -3.6, 2); add(sph(1.4, 8), coreMat, 42, 0, 2); // muzzle fork + emitter
      add(bev(16, 7, 10, 0.9), body(), -8, 0, -3); seam(12, -8, 3.65, -1); seam(12, -8, -3.65, -1); seam(12, -8, 3.65, -5); seam(12, -8, -3.65, -5); // receiver + panel lines
      add(bev(12, 5, 7, 0.7), dark(), -22, 0, -4); add(bev(4, 5.4, 7.4, 0.5), accent(c), -18, 0, -4); add(box(1.2, 5.6, 7.6), dark(), -28, 0, -4); // stock, band, butt plate
      tube(2.2, 14, -2, 0, 8.5, dark(), 10); add(box(2, 2, 3), dark(), -6, 0, 6); add(box(2, 2, 3), dark(), 2, 0, 6); add(cyl(2.4, 2.4, 0.6, 10), glow(0x7fc8ff), 5.3, 0, 8.5, 0, 0, Math.PI / 2); ring(2.3, 0.35, -9.2, 0, 8.5, dark(), 10); // scope + lens + eyepiece
      add(bev(10, 0.8, 4, 0.3), accent(c), -8, 4.1, -2); add(bev(10, 0.8, 4, 0.3), accent(c), -8, -4.1, -2); grip(-4, -12.5);
      muzzle = [43, 0, 2]; break;
    }
    case WEAPONS.LIGHTNING: { // barrel wrapped by three coil rods, a crawling arc ring, front emitter ring with a pulsing core, coil pack behind
      tube(3.4, 30, 8, 0, 0); for (let i = 0; i < 3; i++) { const a = i * 2.094 + 0.5; add(bev(28, 1.5, 1.5, 0.35), coilMat, 9, Math.cos(a) * 5.3, Math.sin(a) * 5.3); add(sph(1.1, 8), coreMat, 24.5, Math.cos(a) * 5.3, Math.sin(a) * 5.3); }
      for (const x of [-2, 6, 14]) ring(5.4, 0.6, x, 0, 0, dark(), 12);                           // rod clamps
      ring(5.8, 1, 22); ring(5.8, 1, -4); add(sph(2.9, 12), coreMat, 25, 0, 0);                     // emitter rings + core
      tube(5, 10, -13, 0, 0, dark()); for (let i = 0; i < 3; i++) ring(5.2, 0.6, -16 + i * 3, 0, 0, coilMat);  // coil pack
      add(bev(14, 8, 9, 0.9), body(), -6, 0, -5); seam(10, -6, 4.15, -3); seam(10, -6, -4.15, -3); add(bev(12, 2.6, 2.4, 0.5), dark(), -4, 0, 8.2); add(box(2, 2.6, 3), dark(), -9, 0, 6); add(box(2, 2.6, 3), dark(), 1, 0, 6);
      add(cyl(0.8, 0.8, 12, 6), dark(), -10, 4.5, -2, 0, 0, Math.PI / 2); add(cyl(0.8, 0.8, 8, 6), dark(), -14, 3.5, -6, 0.6, 0, Math.PI / 2); add(box(3, 1, 1.6), glow(c), -2, -4.3, -6); grip(-2, -14.5); // cables, lamp
      // crawling arc: a thin bright ring around the rods that spins and slides while the beam is on (viewmodel + model)
      const arc = new THREE.Mesh(tor(5.3, 0.3, 10), coreMat); arc.rotation.y = Math.PI / 2; arc.position.set(10, 0, 0); arc.visible = false;
      anim = { arc };
      muzzle = [28, 0, 0]; break;
    }
    case WEAPONS.SHOTGUN: { // side-by-side barrels with a top rib and bands over a grooved wooden pump, wooden stock, receiver with an ejection port
      tube(2.3, 40, 10, 2.6, 2); tube(2.3, 40, 10, -2.6, 2); disc(1.7, 30.2, 2.6, 2); disc(1.7, 30.2, -2.6, 2);
      add(bev(2.4, 10, 6, 0.4), dark(), 3, 0, 2); add(bev(2.4, 10, 6, 0.4), dark(), 27, 0, 2); add(bev(2, 10, 6, 0.4), dark(), 15, 0, 2);   // barrel bands
      add(box(38, 1.2, 0.8), body(), 10, 0, 4.7); add(box(1.2, 1.2, 1.4), accent(c), 29.2, 0, 5.4);     // top rib + front bead
      add(bev(14, 7, 8.5, 0.8), dark(), -6, 0, -0.5); add(box(5, 0.5, 3.2), line(), -5, -3.65, 1); seam(10, -6, 3.65, 2.5); add(bev(3, 5, 1.2, 0.3), accent(c), -1, 0, 4.2); // receiver, ejection port, panel line, top plate
      add(bev(16, 5.5, 7, 0.8), wood(), -21, 0, -3, 0, 0.06, 0); add(bev(4.5, 3.8, 8.5, 0.5), wood(), -8.5, 0, -8, 0, -0.32, 0); add(box(1.4, 5.8, 7.4), dark(), -29, 0, -3.5, 0, 0.06, 0); // stock, grip, butt pad
      add(box(6, 1.1, 1.1), dark(), -4, 0, -4.5); add(box(0.7, 1.4, 2.2), line(), -5, 0, -3.6, 0, 0.3, 0);   // trigger guard + trigger
      const pump = new THREE.Group(); pump.position.set(13, 0, -3.6); pump.add(new THREE.Mesh(bev(10, 7.6, 5.2, 0.7), wood()));
      for (let i = 0; i < 4; i++) { const groove = new THREE.Mesh(box(0.7, 7.8, 5.4), line()); groove.position.x = -3.6 + i * 2.4; pump.add(groove); }
      mergeByMaterial(pump); anim = { pump };
      muzzle = [31, 0, 2]; break;
    }
    case WEAPONS.PLASMA: { // bulbous emitter behind three coil rings, finned bevelled body with panel lines, rear tank
      add(bev(26, 8, 9, 1), body(), 2, 0, 0); seam(18, 2, 4.15, 2); seam(18, 2, -4.15, 2); seam(18, 2, 4.15, -2); seam(18, 2, -4.15, -2);
      tube(3, 14, 18, 0, 0, dark()); for (let i = 0; i < 3; i++) ring(5, 1.2, 12 + i * 5, 0, 0, coilMat, 16);
      add(sph(6, 16), accent(c), 26, 0, 0); add(sph(3.7, 12), coreMat, 29.6, 0, 0);
      for (let i = 0; i < 4; i++) add(bev(1.4, 9, 3.6, 0.3), dark(), -4 + i * 4, 0, 6.2);           // cooling fins
      tube(3.5, 10, -16, 0, 3, dark()); add(cyl(3.7, 3.7, 1.2, 12), accent(c), -21.5, 0, 3, 0, 0, Math.PI / 2); ring(3.6, 0.3, -12, 0, 3, line(), 12); // tank + cap + seam
      add(bev(12, 2, 1.6, 0.3), dark(), -4, 0, 5.6); add(box(3, 1, 1.6), glow(c), -4, -4.3, -2); for (const x of [-8, 0, 8]) { bolt(x, 4.3, -3.4, 0.5, 0, 0); bolt(x, -4.3, -3.4, 0.5, 0, 0); } grip(0, -12.5);
      muzzle = [33, 0, 0]; break;
    }
    case WEAPONS.MACHINEGUN: { // slim barrel in a perforated cooling jacket, flash hider, ammo box feeding a brass belt into the receiver, carry handle
      add(bev(20, 6.5, 8.5, 0.8), body(), -4, 0, 0); seam(14, -4, 3.4, 2); seam(14, -4, -3.4, 2); seam(14, -4, 3.4, -2); seam(14, -4, -3.4, -2);
      tube(1.8, 30, 16, 0, 0.5, body(), 8); tube(3.4, 14, 11, 0, 0.5, dark(), 12);
      for (let i = 0; i < 4; i++) for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + (i % 2) * 0.52; add(cyl(0.85, 0.85, 0.6, 8), line(), 6.5 + i * 3, Math.cos(a) * 3.45, 0.5 + Math.sin(a) * 3.45, a, 0, 0); } // cooling holes
      cone(2.4, 3.2, 4, 31, 0, 0.5, dark()); disc(1.4, 33.2, 0, 0.5); for (let i = 0; i < 4; i++) add(box(3, 0.5, 1.2), line(), 31, Math.cos(i * Math.PI / 2) * 2.9, 0.5 + Math.sin(i * Math.PI / 2) * 2.9, i * Math.PI / 2, 0, 0); // flash hider + slots
      add(bev(9, 5, 8, 0.6), dark(), -3, 5.6, -1.5); add(box(9.4, 5.4, 1.6), accent(c), -3, 5.6, -0.6); seam(7, -3, 8.15, -3);   // ammo box + band + line
      for (let i = 0; i < 6; i++) { const x = -6.5 + i * 1.9, z = 3.2 + Math.sin(i / 5 * Math.PI) * 1.1; add(cyl(0.55, 0.55, 3.4, 6), brass(), x, 3.6, z); add(box(1.9, 0.7, 1.0), dark(), x + 0.95, 3.6, z + 0.3); } // belt: cartridges + links
      add(bev(10, 4, 5.5, 0.6), dark(), -18, 0, -2); add(box(1.2, 4.2, 5.8), dark(), -23.5, 0, -2); add(bev(10, 2, 2.4, 0.4), dark(), -2, 0, 7.2); add(box(2, 2, 3), dark(), -6, 0, 5.5); add(box(2, 2, 3), dark(), 2, 0, 5.5); // stock, butt, carry handle
      add(box(1.5, 1.5, 3), dark(), 26, 0, 4); add(box(1.5, 4, 2), dark(), -10, 0, 5); for (const x of [-9, -1]) { bolt(x, 3.6, 0, 0.5, 0, 0); bolt(x, -3.6, 0, 0.5, 0, 0); } grip(-6, -11.5);
      muzzle = [33.5, 0, 0.5]; break;
    }
    default: { // gauntlet: armoured forearm with plates, pistons and panel lines, a knuckle housing and a big hooked saw blade with a motion-blur ring
      add(bev(20, 8.5, 8.5, 0.9), body(), -4, 0, 0); add(bev(14, 9.6, 2, 0.5), dark(), -5, 0, 4.9); add(bev(14, 9.6, 2, 0.5), dark(), -5, 0, -4.9);
      add(bev(14, 2, 9.6, 0.5), dark(), -5, 5, 0); add(bev(14, 2, 9.6, 0.5), dark(), -5, -5, 0);   // side plates
      for (const x of [-10, -6, -2]) seam(10.2, x, 0, 6.1, 'y'); add(box(12, 1.4, 0.6), accent(c), -5, 0, 6.2); // panel lines + top strip
      for (const y of [3.4, -3.4]) add(cyl(0.8, 0.8, 8, 8), steel(), 7, y, 3.2, 0, 0, Math.PI / 2);   // pistons to the fist
      add(bev(8, 7, 8, 0.9), dark(), 8, 0, 0); add(bev(6, 7.2, 1.6, 0.4), accent(c), 8, 0, 4.6); for (const y of [2.2, -2.2]) bolt(12.1, y, 2.5, 0.6);   // knuckle housing
      add(cyl(1.4, 1.4, 6, 8), dark(), 14.5, 0, 1, 0, 0, Math.PI / 2);                                // blade axle
      // the blade stands on edge in front of the fist, tilted (face up-left) and yawed a little back toward the
      // first-person camera so its face reads instead of its edge; it still reads from the side in third person.
      // The blur ring lies in the same plane and fades in with the spin.
      const mount = new THREE.Group(); mount.position.set(18, 0, 1.5); mount.rotation.set(0.75, 0, 0.35, 'ZYX');
      const blade = new THREE.Group();
      blade.add(new THREE.Mesh(sawGeo(8.5, 14, 1.2), steel()));
      const hub = new THREE.Mesh(cyl(3, 3, 2.2, 12), coreMat); blade.add(hub);
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.4; const b = new THREE.Mesh(cyl(0.7, 0.7, 2.8, 6), dark()); b.position.set(Math.cos(a) * 4.6, 0, Math.sin(a) * 4.6); blade.add(b); } // hub bolts
      const mark = new THREE.Mesh(box(2.6, 1.6, 1.2), accent(c)); mark.position.set(6.6, 0, 0); blade.add(mark);          // one marked spoke so a slow spin reads
      mergeByMaterial(blade); // saw + hub + bolts + mark: one mesh per material
      // blur: one translucent streaked disc on each face of the blade (0.9 off the mid-plane, so the near one is
      // never buried inside the opaque blade whichever side the camera is on); both share one live material
      const blur = new THREE.Group(); const bm = blurMat().clone();
      for (const y of [0.95, -0.95]) { const d = new THREE.Mesh(discGeo(13.2), bm); d.position.y = y; d.renderOrder = 3; blur.add(d); }
      blur.material = bm;
      mount.add(blade, blur);
      anim = { mount, blade, blur };
      muzzle = [26, 0, 1.5]; break;
    }
  }
  mergeByMaterial(g);
  if (anim) { if (anim.mount) g.add(anim.mount); else for (const k in anim) g.add(anim[k]); }
  g.scale.setScalar(scale);
  g.userData.muzzle = muzzle.map((v) => v * scale);
  g.userData.blade = anim && anim.blade || null; g.userData.blur = anim && anim.blur || null; g.userData.pump = anim && anim.pump || null; g.userData.arc = anim && anim.arc || null; g.userData.live = live;
  return g;
}

// Collapse the ~40-80 primitive parts of a weapon into one mesh per material (5-8 draw calls instead of dozens):
// with dozens of pickups plus the enemy's and our own weapon in view, this is most of the item draw-call budget.
function mergeByMaterial(g) {
  const byMat = new Map();
  for (const m of [...g.children]) {
    if (!m.isMesh) continue; // child groups (blade mount, pump) are merged on their own
    m.updateMatrix();
    // extruded (bevelled) parts are non-indexed while the primitives are indexed: merge everything non-indexed
    const geo = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrix);
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
