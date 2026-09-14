// Remote player model: a Q3-style armoured humanoid built from primitives with canvas-generated skins, posed
// procedurally from the interpolated snapshot state (Q3 bbox: feet at -24, head at +32; the origin is at the hips).
//   skeleton   root (yaw) -> legs [pelvis, hips -> knees -> boots] (turn toward the movement direction)
//                         -> torso (lean / twist / pitch) [chest, pads, head] -> gunRig (aim pitch) [both arms, weapon]
//   dressing   the skeleton is the same for every skin; dress(skin) hangs that skin's parts on it and merges each
//              bone's parts into one mesh per material (~25 draw calls a player instead of ~50):
//                sarge  marine: helmet + visor slit, chest armour with the emblem light, round shoulder pads, belt
//                       with pouches, gloves, heavy boots, backpack with two lights
//                visor  cyborg: full helmet with a wide glowing visor band, angular chest / shoulder / thigh plates,
//                       glowing seams down the arms, legs and spine, a power cell on the back
//                anarki punk: bare head with goggles on the forehead and a tall hair crest, open jacket over a bare
//                       chest, small shoulders, knee pads, heavy boots
//              the identity colour (menu pick / snapshot col) is the visor glow, the seams / lights and the chest stripe
//   animation  run cycle scaled by speed with strafe / backpedal variants, torso lean into the velocity, strafe roll,
//              idle breathing, jump tuck / fall reach, landing dip, crouch pose + crouch walk, torso + head pitch aim,
//              two-bone IK keeps the hands on the held weapon (the same mesh as the first-person view): both hands
//              on the big weapons, the free arm swinging with the run for the machinegun / gauntlet; recoil per FIRE
//              event, pain flinch per PAIN event, three death falls (back / forward / side) into a corpse pose; a gib
//              death hides the body (the chunks come from effects).
//   readability  team-coloured emissive stripe + visor on every skin, blob shadow under the feet.
// Skins are chosen from the player's name (bots) unless the snapshot carries a chosen one.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WEAPONS, EV, playerColorHex } from '../../shared/constants.js';
import { makeWeaponMesh, ambientLightMap, MODEL_AMBIENT } from './weapons.js';
import { getSprite } from './particles.js';
import { runPose, bladeBlur, ease } from './anim.js';

// ---------- skins ----------
const SKINS = {
  // sRGB-ish albedo (the textures multiply by ~0.8): kept bright, Q3 player skins are lit like fullbright sprites
  sarge: { base: [0.66, 0.68, 0.44], plate: [0.84, 0.80, 0.66], suit: [0.40, 0.38, 0.33], flesh: [0.86, 0.66, 0.50], face: true },
  visor: { base: [0.80, 0.86, 0.94], plate: [0.94, 0.96, 1.0], suit: [0.34, 0.38, 0.48], flesh: [0.36, 0.40, 0.48], face: false },
  anarki: { base: [0.90, 0.28, 0.74], plate: [0.50, 0.46, 0.56], suit: [0.32, 0.26, 0.36], flesh: [0.88, 0.76, 0.72], face: true },
};
export const SKIN_NAMES = Object.keys(SKINS);
export const SKIN_PALETTE = SKINS; // read-only palette for the menu preview
export function skinFor(name, id = 0) {
  let h = id * 7; for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SKIN_NAMES[h % SKIN_NAMES.length];
}

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
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { fn(px, x, y, x / size, y / size); const i = (y * size + x) * 4; d[i] = clamp01(px[0]) * 255; d[i + 1] = clamp01(px[1]) * 255; d[i + 2] = clamp01(px[2]) * 255; d[i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
const stripe = (v) => v > 0.42 && v < 0.52; // the team stripe band on armour parts (v across each face)
const SKIN_TEX = {};
function skinTextures(name) {
  if (SKIN_TEX[name]) return SKIN_TEX[name];
  const sk = SKINS[name], seed = name.length * 3, S = 128;
  // armour: four bevelled plates with a rivet in each corner, worn edges, grime, a dark recess for the stripe
  const armor = paint(S, (px, x, y, u, v) => {
    const gx = (u * 2) % 1, gy = (v * 2) % 1, edge = Math.min(gx, 1 - gx, gy, 1 - gy);
    const bevel = edge < 0.04 ? 0.5 + edge * 8 : 1;
    const plate = (hash(Math.floor(u * 2), Math.floor(v * 2), seed) - 0.5) * 0.25;
    const rx = Math.min(gx, 1 - gx) * S / 2, ry = Math.min(gy, 1 - gy) * S / 2, rivet = Math.hypot(rx - 6, ry - 6) < 2.4 ? 1.4 : 1;
    const wear = vnoise(x * 0.4 + y, y * 0.06, 4, seed + 1) > 0.8 ? 0.3 : 0, grime = vnoise(x, y, 22, seed + 2) * 0.3;
    let k = (0.85 + plate - grime + wear) * bevel * rivet;
    if (stripe(v)) k *= 0.35; // recessed stripe: the emissive carries it
    px[0] = sk.base[0] * k; px[1] = sk.base[1] * k; px[2] = sk.base[2] * k;
  });
  const emissive = paint(S, (px, x, y, u, v) => { const k = stripe(v) ? 0.8 + vnoise(x, y, 6, seed + 5) * 0.2 : 0; px[0] = px[1] = px[2] = k; });
  // plate: brushed light metal, scratches, no stripe
  const plate = paint(S, (px, x, y, u, v) => {
    const brush = vnoise(x, y * 8, 5, seed + 3) * 0.2, scratch = vnoise(x * 0.3 + y, y * 0.05, 5, seed + 4) > 0.83 ? 0.25 : 0;
    const gx = u, gy = v, edge = Math.min(gx, 1 - gx, gy, 1 - gy), bevel = edge < 0.05 ? 0.6 : 1;
    const k = (0.75 + brush + scratch - vnoise(x, y, 30, seed + 6) * 0.2) * bevel;
    px[0] = sk.plate[0] * k; px[1] = sk.plate[1] * k; px[2] = sk.plate[2] * k;
  });
  // suit: ribbed dark undersuit
  const suit = paint(S, (px, x, y, u, v) => {
    const rib = 0.8 + Math.sin(v * Math.PI * 24) * 0.18, n = vnoise(x, y, 9, seed + 7) * 0.2;
    const k = rib + n;
    px[0] = sk.suit[0] * k; px[1] = sk.suit[1] * k; px[2] = sk.suit[2] * k;
  });
  return (SKIN_TEX[name] = { armor, emissive, plate, suit });
}
const SKIN_MATS = {};
// Materials per (skin, team colour): the same program set for every combination (map / map + emissiveMap), so a
// new skin joining mid-match never compiles a shader.
export function skinMaterials(name, color) {
  const key = name + ':' + color;
  if (SKIN_MATS[key]) return SKIN_MATS[key];
  const sk = SKINS[name], t = skinTextures(name);
  const m = {
    // metalness stays low (no environment map: metals would only go black); the constant light map is the Q3
    // light-grid ambient, so the silhouette never sinks into a dark corner
    armor: new THREE.MeshStandardMaterial({ map: t.armor, emissiveMap: t.emissive, emissive: new THREE.Color(color), emissiveIntensity: 1.0, lightMap: ambientLightMap(), lightMapIntensity: MODEL_AMBIENT, roughness: 0.5, metalness: 0.25 }),
    plate: new THREE.MeshStandardMaterial({ map: t.plate, lightMap: ambientLightMap(), lightMapIntensity: MODEL_AMBIENT, roughness: 0.4, metalness: 0.3 }),
    suit: new THREE.MeshStandardMaterial({ map: t.suit, lightMap: ambientLightMap(), lightMapIntensity: MODEL_AMBIENT, roughness: 0.85, metalness: 0.1 }),
    flesh: new THREE.MeshStandardMaterial({ color: new THREE.Color(...sk.flesh), lightMap: ambientLightMap(), lightMapIntensity: MODEL_AMBIENT, roughness: 0.75, metalness: 0.0 }),
    visor: new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.3) }),
  };
  return (SKIN_MATS[key] = m);
}

// ---------- geometry (shared, z-up) ----------
const GEO = {};
const geo = (k, make) => GEO[k] || (GEO[k] = make());
const zcyl = (rt, rb, h, n = 10) => geo(`c${rt},${rb},${h},${n}`, () => new THREE.CylinderGeometry(rt, rb, h, n).rotateX(Math.PI / 2)); // axis +z, rt at the top
const zsph = (r, n = 10, m = 7) => geo(`s${r},${n},${m}`, () => new THREE.SphereGeometry(r, n, m).rotateX(Math.PI / 2));
const bx = (w, d, h) => geo(`b${w},${d},${h}`, () => new THREE.BoxGeometry(w, d, h));
// helmet: a cap over the top (down to the brow) plus a skirt around the back and sides, open at the face (+x)
const helmetCap = (r) => geo(`hc${r}`, () => new THREE.SphereGeometry(r, 14, 6, 0, Math.PI * 2, 0, Math.PI * 0.5).rotateX(Math.PI / 2));
const helmetSkirt = (r) => geo(`hs${r}`, () => new THREE.SphereGeometry(r, 14, 4, Math.PI * 4 / 3, Math.PI * 4 / 3, Math.PI * 0.5, Math.PI * 0.32).rotateX(Math.PI / 2));
// bevelled plate (armour panels): a rectangle extruded with a chamfer, like the weapon plates
const plateGeo = (w, d, h, b = 0.5) => geo(`p${w},${d},${h},${b}`, () => {
  const s = new THREE.Shape(), x = w / 2 - b, y = d / 2 - b;
  s.moveTo(-x, -y); s.lineTo(x, -y); s.lineTo(x, y); s.lineTo(-x, y); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: h - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 1, steps: 1 });
  g.center(); const uv = g.attributes.uv, k = 1 / Math.max(w, d, h); for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * k, uv.getY(i) * k);
  return g;
});

const L1 = 10, L2 = 10; // upper arm / forearm lengths
const WEAPON_SCALE = 0.78;
// where the hands go on each weapon (weapon-local, unscaled): [grip, foregrip | null (one-handed: the other arm swings free)]
const HANDS = {
  [WEAPONS.ROCKET]: [[2, 0, -15], [15, 0, -7]], [WEAPONS.RAIL]: [[-4, 0, -10], [12, 0, -2]], [WEAPONS.LIGHTNING]: [[-2, 0, -12], [8, 0, -5]],
  [WEAPONS.SHOTGUN]: [[-8, 0, -7], [13, 0, -5]], [WEAPONS.PLASMA]: [[0, 0, -10], [12, 0, -5]], [WEAPONS.MACHINEGUN]: [[-6, 0, -9], null], [WEAPONS.GAUNTLET]: [[-12, 0, -1], null],
};
const WEAPON_POS = new THREE.Vector3(7, -4.5, -1); // gunRig space (pivot on the shoulder line)
const NEG_Z = new THREE.Vector3(0, 0, -1);
const _v = new THREE.Vector3(), _S = new THREE.Vector3(), _d = new THREE.Vector3(), _E = new THREE.Vector3(), _p = new THREE.Vector3(), _t = new THREE.Vector3(), _q = new THREE.Quaternion();
const HINT_R = new THREE.Vector3(-0.3, -1, -0.7), HINT_L = new THREE.Vector3(-0.2, 1, -0.9);
// Two-bone IK: aim `shoulder` and `elbow` (children of the same space as `target`) so the hand reaches the target,
// the elbow bending toward `hint`.
function solveArm(shoulder, elbow, target, hint) {
  _S.copy(shoulder.position); _d.subVectors(target, _S);
  let dist = _d.length(); const max = (L1 + L2) * 0.995;
  if (dist > max) dist = max; if (dist < 1) dist = 1;
  _d.normalize();
  const a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  _p.copy(hint).addScaledVector(_d, -hint.dot(_d));
  if (_p.lengthSq() < 1e-6) _p.set(0, 0, -1).addScaledVector(_d, -_d.z);
  _p.normalize();
  _E.copy(_S).addScaledVector(_d, a).addScaledVector(_p, h);
  _t.copy(_S).addScaledVector(_d, dist);
  shoulder.quaternion.setFromUnitVectors(NEG_Z, _v.subVectors(_E, _S).normalize());
  _q.setFromUnitVectors(NEG_Z, _v.subVectors(_t, _E).normalize());
  elbow.quaternion.copy(shoulder.quaternion).invert().multiply(_q);
}
const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

// Merge a bone's dressing (direct child meshes tagged deco) into one mesh per material; child bones are untouched.
function mergeBone(g) {
  const byMat = new Map();
  for (const m of [...g.children]) {
    if (!m.isMesh || !m.userData.deco) continue;
    m.updateMatrix();
    const geo = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrix);
    if (!byMat.has(m.material)) byMat.set(m.material, { role: m.userData.role, geos: [] });
    byMat.get(m.material).geos.push(geo); g.remove(m);
  }
  for (const [material, { role, geos }] of byMat) {
    const merged = mergeGeometries(geos, false); for (const gg of geos) gg.dispose();
    if (merged) { const mm = new THREE.Mesh(merged, material); mm.userData.role = role; mm.userData.deco = true; g.add(mm); }
  }
}

let shadowMat = null, shadowGeo = null;

export class PlayerModel {
  // color: the default colour for this model (the renderer's own / enemy colour); name -> default skin. A chosen
  // skin / colour arriving in the snapshot (sk / col) replaces both, see setSkin().
  constructor(scene, color, name = '', id = 0) {
    this.scene = scene; this.color = color; this.id = id;
    this.defaultSkin = this.skin = SKINS[name] ? name : skinFor(name, id); // a player named after a skin gets it
    this.defaultColor = color;
    this.mats = skinMaterials(this.skin, color);
    this.root = new THREE.Group();
    // ---- skeleton: legs + pelvis (turn toward the movement direction) ----
    this.legs = new THREE.Group(); this.root.add(this.legs);
    const leg = (side) => { const hip = new THREE.Group(); hip.position.set(0, side * 5, 1); this.legs.add(hip); const knee = new THREE.Group(); knee.position.z = -11; hip.add(knee); hip.userData.knee = knee; return hip; };
    this.hipL = leg(1); this.hipR = leg(-1);
    // ---- torso (pivot at the waist), head, gun rig (both arms + the weapon, pitched together about the shoulder line) ----
    this.torso = new THREE.Group(); this.torso.position.z = 6; this.root.add(this.torso);
    this.head = new THREE.Group(); this.head.position.z = 23.5; this.torso.add(this.head);
    this.gunRig = new THREE.Group(); this.gunRig.position.z = 16; this.torso.add(this.gunRig);
    const arm = (side) => { const sh = new THREE.Group(); sh.position.set(0, side * 8.2, 0); this.gunRig.add(sh); const el = new THREE.Group(); el.position.z = -10; sh.add(el); sh.userData.elbow = el; return sh; };
    this.armR = arm(-1); this.armL = arm(1);
    this.weaponHolder = new THREE.Group(); this.weaponHolder.position.copy(WEAPON_POS); this.gunRig.add(this.weaponHolder);
    this.weaponMeshes = {}; this.weaponId = -1;
    this.bones = [this.legs, this.hipL, this.hipR, this.hipL.userData.knee, this.hipR.userData.knee, this.torso, this.head, this.armR, this.armL, this.armR.userData.elbow, this.armL.userData.elbow];
    this.dress(this.skin);
    // blob shadow (Q3 cg_shadows 1)
    if (!shadowMat) { shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, map: getSprite('soft'), transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }); shadowGeo = new THREE.CircleGeometry(20, 20); }
    this.shadow = new THREE.Mesh(shadowGeo, shadowMat.clone()); this.shadow.renderOrder = 2;
    scene.add(this.root, this.shadow);
    this.group = this.root; // renderer hook (precompile)
    // animation state
    this.cycle = 0; this.runAmt = 0; this.legsYaw = 0; this.lean = [0, 0]; this.airAmt = 0; this.duckAmt = 0;
    this.dead = false; this.deadAt = 0; this.deathKind = 0; this.deaths = 0; this.gibbed = false;
    this.fireAt = -1e9; this.fireWeapon = 0; this.painAt = -1e9; this.painSide = 1; this.landAt = -1e9; this.landHard = false; this.jumpAt = -1e9;
    this.bladeAngle = 0; this.bladeSpin = 0; this.arcPhase = 0;
    this.gripR = new THREE.Vector3(); this.gripL = new THREE.Vector3(); this.restL = new THREE.Vector3(3, 7, -15); this.twoHanded = true;
  }
  // Hang a skin's parts on the skeleton (replacing the previous dressing) and merge each bone into one mesh per
  // material. Every part carries its material role so setSkin() can recolour without rebuilding.
  dress(skin) {
    for (const b of this.bones) for (const m of [...b.children]) if (m.isMesh && m.userData.deco) { b.remove(m); m.geometry.dispose(); }
    const M = this.mats, sk = SKINS[skin];
    const ROLE = new Map([[M.armor, 'armor'], [M.plate, 'plate'], [M.suit, 'suit'], [M.flesh, 'flesh'], [M.visor, 'visor']]);
    const mesh = (parent, g, m, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.scale.set(sx, sy, sz); o.rotation.set(rx, ry, rz); o.userData.role = ROLE.get(m); o.userData.deco = true; parent.add(o); return o; };
    const kneeL = this.hipL.userData.knee, kneeR = this.hipR.userData.knee, elR = this.armR.userData.elbow, elL = this.armL.userData.elbow;
    // ---- common: pelvis, thighs, shins, upper arms, forearms, neck ----
    mesh(this.legs, bx(10, 13, 7), M.suit, 0, 0, 2);
    for (const [hip, knee, side] of [[this.hipL, kneeL, 1], [this.hipR, kneeR, -1]]) {
      mesh(hip, zcyl(3.0, 3.4, 11), M.suit, 0, 0, -5.5);
      mesh(knee, zcyl(2.3, 2.7, 10), M.suit, 0, 0, -5);
      if (skin === 'visor') { // angular thigh / shin plates, a glowing seam down the outside of the leg
        mesh(hip, plateGeo(4, 6.6, 8, 0.6), M.plate, 2.4, 0, -5); mesh(hip, bx(0.6, 0.8, 7), M.visor, 0.8, side * 3.4, -5.5);
        mesh(knee, plateGeo(3, 5, 7, 0.5), M.plate, 2.5, 0, -5); mesh(knee, zsph(2.6), M.plate, 0.5, 0, 0);
        mesh(knee, bx(7.5, 5, 3), M.plate, 1.4, 0, -11.3); mesh(knee, bx(3, 5.4, 2), M.suit, -1, 0, -10.5); mesh(knee, bx(2.5, 5.2, 1.2), M.visor, 3.6, 0, -10.9);
      } else if (skin === 'anarki') { // bare thighs (jeans-dark suit), knee pads, big boots with a plate toe
        mesh(hip, bx(3.2, 6.6, 6.5), M.suit, 2.2, 0, -5); mesh(hip, bx(2, 4, 1.4), M.armor, 2.5, side * 1.5, -2);
        mesh(knee, zsph(3.1, 10, 7), M.plate, 0.6, 0, 0.2, 1, 1, 0.8);
        mesh(knee, bx(8.5, 5.8, 4), M.suit, 1.6, 0, -11); mesh(knee, bx(3.5, 6, 2.2), M.plate, 4.6, 0, -11.6); mesh(knee, bx(3, 6, 1.6), M.armor, -1.5, 0, -8.8);
      } else { // sarge: armoured thigh + shin guard, round knee, heavy boot with a heel
        mesh(hip, plateGeo(3.6, 6.8, 7, 0.6), M.armor, 2.2, 0, -5); mesh(hip, zsph(2.9), M.plate, 0, 0, -11);
        mesh(knee, plateGeo(2.8, 5.2, 8, 0.5), M.armor, 2.3, 0, -5.5);
        mesh(knee, bx(8.5, 5.6, 3.6), M.plate, 1.7, 0, -11.3); mesh(knee, bx(3, 6, 2.2), M.suit, -1.2, 0, -10.4); mesh(knee, bx(2, 5.8, 1.2), M.armor, 4.2, 0, -9.8);
      }
    }
    for (const [sh, el, side] of [[this.armR, elR, -1], [this.armL, elL, 1]]) {
      mesh(sh, zcyl(2.4, 2.8, 10), M.suit, 0, 0, -5);
      if (skin === 'visor') { mesh(sh, zsph(3.2, 10, 7), M.plate, 0, 0, -0.5, 1, 1, 0.7); mesh(el, zcyl(2.0, 2.4, 10), M.suit, 0, 0, -5); mesh(el, plateGeo(3, 3, 7, 0.5), M.plate, 1.6, 0, -5.5); mesh(el, bx(0.6, 0.8, 6), M.visor, 2.6, side * 1.2, -5.5); mesh(el, bx(3.2, 3.4, 3.6), M.plate, 0, 0, -11.2); }
      else if (skin === 'anarki') { mesh(sh, zsph(2.5), M.armor, 0, 0, -0.3); mesh(el, zcyl(2.0, 2.4, 10), M.flesh, 0, 0, -5); mesh(el, zcyl(2.4, 2.4, 2, 8), M.plate, 0, 0, -9.2); mesh(el, bx(3.2, 3.4, 3.6), M.suit, 0, 0, -11.2); }
      else { mesh(sh, zsph(2.5), M.suit, 0, 0, -10); mesh(el, zcyl(2.0, 2.4, 10), M.armor, 0, 0, -5); mesh(el, bx(3.4, 3.6, 3.8), M.plate, 0, 0, -11.2); mesh(el, bx(1.4, 3.8, 1.2), M.armor, 1.4, 0, -9.6); }
    }
    mesh(this.torso, zcyl(2.2, 2.4, 4), M.suit, 0, 0, 20);   // neck
    // ---- skin-specific torso / head ----
    if (skin === 'visor') {
      mesh(this.torso, zcyl(6, 5.4, 7), M.suit, 0, 0, 3.5, 0.9, 1.25, 1); mesh(this.torso, zcyl(7.2, 6.3, 12), M.armor, 0, 0, 12.5, 0.85, 1.3, 1);
      mesh(this.torso, plateGeo(3, 11, 9, 0.8), M.plate, 6, 0, 12.5, 1, 1, 1, 0, -0.15, 0); mesh(this.torso, plateGeo(2.4, 4, 3, 0.4), M.plate, 7.4, 0, 8, 1, 1, 1, 0, 0.5, 0);   // angular chest plates
      mesh(this.torso, bx(1, 3.2, 1.2), M.visor, 7.8, 0, 14); mesh(this.torso, bx(1, 0.8, 9), M.visor, -6.8, 0, 12);                             // chest light, spine seam
      mesh(this.torso, plateGeo(5, 8, 7, 0.6), M.armor, -6.2, 0, 12); mesh(this.torso, bx(1, 2, 2), M.visor, -8.9, 0, 12);                       // power cell
      for (const s of [1, -1]) { mesh(this.torso, plateGeo(6, 5, 3.6, 0.7), M.plate, 0, s * 9.8, 17.6, 1, 1, 1, s * 0.35, 0, 0); mesh(this.torso, bx(3, 0.8, 0.8), M.visor, 0, s * 12, 16.6); }  // angular shoulder pads + lights
      mesh(this.legs, bx(11, 14, 2.6), M.plate, 0, 0, 5); mesh(this.legs, bx(2, 3.4, 2), M.visor, 5.6, 0, 5); for (const s of [1, -1]) mesh(this.legs, plateGeo(3, 5, 4, 0.5), M.plate, 4.3, s * 4, 1.2);
      mesh(this.head, zsph(5.4, 14, 10), M.plate, 0, 0, 0.2, 1, 0.98, 1.1); this.headMesh = null;                                              // full helmet
      mesh(this.head, bx(2, 8.4, 2.6), M.visor, 4.3, 0, 1); for (const s of [1, -1]) mesh(this.head, bx(3.2, 1.6, 2.6), M.visor, 2.4, s * 4.6, 1, 1, 1, 1, 0, 0, s * 0.9); // wrap-around visor band
      mesh(this.head, bx(2, 6.4, 1.4), M.plate, 4.5, 0, 3); mesh(this.head, bx(2.2, 5.8, 2.6), M.suit, 3.4, 0, -3); mesh(this.head, bx(1.2, 1.2, 4), M.plate, -3, 4, 3, 1, 1, 1, 0.3, 0, 0);  // brow, jaw, antenna
    } else if (skin === 'anarki') {
      mesh(this.torso, zcyl(5.8, 5.2, 7), M.suit, 0, 0, 3.5, 0.9, 1.2, 1); mesh(this.torso, zcyl(6.6, 5.8, 12), M.flesh, 0, 0, 12.5, 0.8, 1.2, 1); // waist, bare chest
      mesh(this.torso, bx(0.8, 4, 6), M.visor, 5.2, 0, 13);                                                                                    // chest tattoo light
      for (const s of [1, -1]) { mesh(this.torso, plateGeo(2.2, 5.5, 13, 0.5), M.armor, 5.2, s * 5.2, 12, 1, 1, 1, 0, 0, s * 0.45); mesh(this.torso, bx(2, 4, 2), M.armor, 4.2, s * 6.8, 18.6, 1, 1, 1, 0, 0, s * 0.3); } // open jacket flaps + collar
      mesh(this.torso, plateGeo(3, 11, 13, 0.6), M.armor, -5.8, 0, 12); mesh(this.torso, bx(1.5, 5, 1.2), M.armor, -7.2, 0, 12);                 // jacket back
      mesh(this.legs, bx(11, 14, 2.4), M.plate, 0, 0, 5); mesh(this.legs, bx(2, 3.4, 2), M.visor, 5.6, 0, 5); mesh(this.legs, bx(3, 2, 4), M.suit, -3, 6.5, 2); // belt, buckle, pouch
      this.headMesh = mesh(this.head, zsph(5, 12, 9), M.flesh, 0, 0, 0, 1, 0.95, 1.08);
      for (let i = 0; i < 6; i++) { const h = 3 + Math.sin((i + 0.5) / 6 * Math.PI) * 3; mesh(this.head, bx(1.3, 1.5, h), M.armor, -3.6 + i * 1.45, 0, 4.6 + h / 2); } // hair crest
      mesh(this.head, bx(1.6, 7, 1.8), M.plate, 4.2, 0, 2.6); for (const s of [1, -1]) mesh(this.head, zcyl(1.1, 1.1, 1, 10), M.visor, 4.8, s * 1.9, 2.6, 1, 1, 1, 0, Math.PI / 2, 0); // goggles on the forehead
      mesh(this.head, bx(2, 5.2, 2), M.flesh, 3.8, 0, -3.2); mesh(this.head, bx(1.2, 1.2, 1.6), M.plate, 0.5, 5.1, 0.5);                       // chin, ear stud
    } else { // sarge
      mesh(this.torso, zcyl(6.2, 5.4, 7), M.suit, 0, 0, 3.5, 0.9, 1.25, 1); mesh(this.torso, zcyl(7.4, 6.4, 12), M.armor, 0, 0, 12.5, 0.85, 1.3, 1);
      mesh(this.torso, plateGeo(2.8, 10, 8, 0.7), M.plate, 6.2, 0, 12.5); mesh(this.torso, bx(1.2, 4, 3), M.visor, 7.5, 0, 14);                  // breastplate + emblem light
      mesh(this.torso, bx(4, 9, 8), M.suit, -6.4, 0, 12); mesh(this.torso, bx(1, 2, 1.4), M.visor, -8.6, 2.5, 14); mesh(this.torso, bx(1, 2, 1.4), M.visor, -8.6, -2.5, 14); mesh(this.torso, bx(1, 1, 5), M.plate, -7, -3.5, 18.5); // backpack + lights + antenna
      mesh(this.torso, zsph(4.4, 10, 7), M.armor, 0, 9.6, 17.2, 1, 1.15, 0.75); mesh(this.torso, zsph(4.4, 10, 7), M.armor, 0, -9.6, 17.2, 1, 1.15, 0.75); // shoulder pads
      mesh(this.legs, bx(11, 14, 2.6), M.plate, 0, 0, 5); mesh(this.legs, bx(2, 3.4, 2), M.visor, 5.6, 0, 5); for (const s of [1, -1]) { mesh(this.legs, bx(3, 6, 4), M.armor, 4.5, s * 4.5, 1.5); mesh(this.legs, bx(3, 2.6, 3), M.suit, 0, s * 6.8, 3.5); } // belt, buckle, groin plates, pouches
      this.headMesh = mesh(this.head, zsph(5, 12, 9), M.flesh, 0, 0, 0, 1, 0.95, 1.08);
      mesh(this.head, helmetCap(5.9), M.armor, -0.4, 0, 0.4, 1, 1, 0.9); mesh(this.head, helmetSkirt(5.9), M.armor, -0.4, 0, 0.4, 1, 1, 0.9);
      mesh(this.head, bx(1.6, 7.2, 1.6), M.visor, 4.6, 0, 1.4); mesh(this.head, bx(2, 6, 1.6), M.plate, 4.3, 0, -0.2); mesh(this.head, bx(2.2, 5.6, 2.2), M.plate, 3.6, 0, -3.4); // visor slit, brow, chin guard
    }
    for (const b of this.bones) mergeBone(b);
  }
  // Swap to another (skin, colour): a new skin re-dresses the skeleton, a new colour only swaps every part's
  // material for the one of its role from the cached set for that combination (same shader programs, no compile).
  setSkin(skin, color) {
    if (!SKINS[skin]) skin = this.defaultSkin;
    if (skin === this.skin && color === this.color) return;
    const redress = skin !== this.skin;
    this.skin = skin; this.color = color;
    const M = this.mats = skinMaterials(skin, color);
    if (redress) this.dress(skin);
    else this.root.traverse((o) => { const r = o.userData && o.userData.role; if (r && M[r]) o.material = M[r]; });
  }
  // events for this player (renderer.event forwards FIRE / PAIN / LAND / JUMP / DEATH by id)
  event(e, now) {
    if (e.type === EV.FIRE) { this.fireAt = now; this.fireWeapon = e.weapon; }
    else if (e.type === EV.PAIN) { this.painAt = now; this.painSide = Math.random() < 0.5 ? -1 : 1; }
    else if (e.type === EV.LAND) { this.landAt = now; this.landHard = !!e.hard; }
    else if (e.type === EV.JUMP) this.jumpAt = now;
    else if (e.type === EV.DEATH && e.gib) this.gibbed = true; // the body is blown apart: the chunks come from effects
  }
  setWeapon(w) {
    if (w === this.weaponId) return;
    this.weaponId = w;
    for (const k in this.weaponMeshes) this.weaponMeshes[k].visible = false;
    if (!this.weaponMeshes[w]) { const m = makeWeaponMesh(w, WEAPON_SCALE); this.weaponHolder.add(m); this.weaponMeshes[w] = m; }
    this.weaponMeshes[w].visible = true;
    const hands = HANDS[w] || HANDS[WEAPONS.MACHINEGUN];
    this.gripR.set(...hands[0]).multiplyScalar(WEAPON_SCALE).add(WEAPON_POS);
    this.twoHanded = !!hands[1];
    if (hands[1]) this.gripL.set(...hands[1]).multiplyScalar(WEAPON_SCALE).add(WEAPON_POS); else this.gripL.copy(this.restL);
  }
  // world-space muzzle of the held weapon (for beams / muzzle flashes)
  muzzleWorld() {
    const m = this.weaponMeshes[this.weaponId]; if (!m) return null;
    this.root.updateMatrixWorld();
    _v.set(...m.userData.muzzle).applyMatrix4(m.matrixWorld);
    return [_v.x, _v.y, _v.z];
  }
  update(origin, angles, r, now, dt, floorZ) {
    const yaw = angles[1] * Math.PI / 180, pitch = angles[0] * Math.PI / 180;
    const dead = !!r.d;
    if (dead && !this.dead) { this.deadAt = now; this.deathKind = (this.id + this.deaths++) % 3; }
    if (!dead) this.gibbed = false;
    this.dead = dead;
    this.setSkin(r.sk || this.defaultSkin, playerColorHex(r.col, this.defaultColor)); // the player's chosen identity (snapshot sk / col)
    this.setWeapon(r.w);
    // a gibbed body is gone until the respawn
    this.root.visible = !this.gibbed;
    // blob shadow follows the floor, fades with height
    if (floorZ !== undefined) { const h = origin[2] - 24 - floorZ; this.shadow.position.set(origin[0], origin[1], floorZ + 0.4); this.shadow.material.opacity = Math.max(0, 0.55 - h / 300); this.shadow.visible = !this.gibbed && (!dead || now - this.deadAt < 600); }
    this.root.position.set(origin[0], origin[1], origin[2]);
    if (dead) { this.deathPose(origin, yaw, now); return; }
    const v = r.v || [0, 0, 0];
    const speed = Math.hypot(v[0], v[1]), ground = !!r.g, ducked = (r.pf & 1) !== 0;
    const k = Math.min(1, dt * 12);
    // ---- movement direction relative to the facing: legs turn up to ~45 degrees toward it, and reverse for a backpedal ----
    let rel = speed > 30 ? wrap(Math.atan2(v[1], v[0]) - yaw) : 0;
    const back = Math.abs(rel) > Math.PI / 2;
    if (back) rel = wrap(rel + Math.PI);
    const legsTarget = speed > 30 ? Math.max(-0.8, Math.min(0.8, rel)) : 0;
    this.legsYaw += (legsTarget - this.legsYaw) * k;
    // ---- run cycle / blend amounts ----
    const runTarget = ground && speed > 30 ? Math.min(1, speed / 320) : 0;
    this.runAmt += (runTarget - this.runAmt) * k;
    if (ground && speed > 30) this.cycle += dt * speed * (ducked ? 0.02 : 0.03) * (back ? -1 : 1);
    this.airAmt += ((ground ? 0 : 1) - this.airAmt) * Math.min(1, dt * 14);
    this.duckAmt += ((ducked ? 1 : 0) - this.duckAmt) * Math.min(1, dt * 14);
    const run = this.runAmt, air = this.airAmt, duck = this.duckAmt;
    // ---- lean into the velocity (forward when running forward, back when backpedalling, roll into strafes) ----
    const leanF = run * 0.16 * Math.cos(rel) * (back ? -0.6 : 1), leanS = -run * 0.14 * Math.sin(rel);
    this.lean[0] += (leanF - this.lean[0]) * k; this.lean[1] += (leanS - this.lean[1]) * k;
    // ---- body ----
    this.root.rotation.set(0, 0, yaw);
    this.legs.rotation.set(0, 0, this.legsYaw);
    this.legs.position.z = -12 * duck;
    const breathe = Math.sin(now * 0.0024) * 0.35 * (1 - run);
    let dip = 0; { const t = (now - this.landAt) / 240; if (t >= 0 && t < 1) dip = Math.sin(t * Math.PI) * (this.landHard ? 5 : 3); }
    const fall = Math.min(1, Math.max(0, -v[2] / 400));
    const pose = runPose(this.cycle, run, air, duck, fall, dip);
    this.torso.position.z = 6 + pose.bob + breathe - 12 * duck - dip;
    this.torso.rotation.set(this.lean[1], this.lean[0] + pitch * 0.25 + duck * 0.35 + air * 0.08, -this.legsYaw * 0.25 + Math.sin(this.cycle) * 0.05 * run, 'ZYX');
    // pain flinch: a twist away from the hit plus a head snap, 260 ms
    { const t = (now - this.painAt) / 260; if (t >= 0 && t < 1) { const s = Math.sin(t * Math.PI); this.torso.rotation.z += s * 0.35 * this.painSide; this.torso.rotation.y -= s * 0.18; this.torso.rotation.x += s * 0.2 * this.painSide; } }
    // ---- legs ----
    this.hipL.rotation.set(0, pose.hipL, 0); this.hipR.rotation.set(0, pose.hipR, 0);
    this.hipL.userData.knee.rotation.set(0, pose.kneeL, 0); this.hipR.userData.knee.rotation.set(0, pose.kneeR, 0);
    // ---- head: follows the aim pitch, glances into turns ----
    this.head.rotation.set(0, pitch * 0.45 - duck * 0.3, -this.legsYaw * 0.2);
    // ---- gun rig: aim pitch + recoil, arms solved onto the weapon (or swinging free with the run) ----
    let kick = 0; { const t = (now - this.fireAt); if (t >= 0 && t < 260) kick = Math.exp(-t / 70) * (this.fireWeapon === WEAPONS.RAIL || this.fireWeapon === WEAPONS.ROCKET || this.fireWeapon === WEAPONS.SHOTGUN ? 1 : 0.4); }
    this.gunRig.rotation.set(0, pitch * 0.75 - kick * 0.16 + air * 0.05, 0);
    this.gunRig.position.set(-kick * 2.2, Math.sin(this.cycle) * 0.6 * run, 16 - Math.abs(Math.sin(this.cycle)) * 0.5 * run);
    const idle = (1 - run) * 0.3;
    _t.copy(this.gripR); _t.z += Math.sin(now * 0.0019) * idle; solveArm(this.armR, this.armR.userData.elbow, _t, HINT_R);
    if (this.twoHanded) { _t.copy(this.gripL); _t.z += Math.sin(now * 0.0019 + 0.4) * idle; _t.x += Math.sin(now * 0.0013) * idle; }
    else { _t.copy(this.restL); _t.x += pose.armL + Math.sin(now * 0.0013) * idle; _t.z += Math.abs(pose.armL) * 0.25 + Math.sin(now * 0.0019 + 0.4) * idle - air * 6; _t.y += air * 4; }
    solveArm(this.armL, this.armL.userData.elbow, _t, HINT_L);
    // gauntlet: the saw spins while the trigger is held (blur ring with it); lightning: the arc crawls along the rods
    const wm = this.weaponMeshes[this.weaponId];
    if (wm && wm.userData.blade) {
      this.bladeSpin += ((r.ah ? 16 : 0) - this.bladeSpin) * Math.min(1, dt * (r.ah ? 6 : 1.5)); this.bladeAngle += this.bladeSpin * dt; wm.userData.blade.rotation.y = this.bladeAngle;
      const blur = wm.userData.blur; blur.material.opacity = bladeBlur(this.bladeSpin) * 0.62; blur.rotation.y = this.bladeAngle * 0.31; blur.visible = blur.material.opacity > 0.01;
    }
    if (wm && wm.userData.arc) {
      const on = !!r.ah && now - this.fireAt < 120; wm.userData.arc.visible = on;
      if (on) { this.arcPhase = (this.arcPhase + dt * 5.5) % 1; wm.userData.arc.position.set(-2 + this.arcPhase * 24, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2); }
    }
  }
  // Death: a 480 ms fall (back / forward / side) into a corpse pose, then the body sinks away after 1.6 s.
  deathPose(origin, yaw, now) {
    const t = Math.min(1, (now - this.deadAt) / 480), e = ease(t), settle = t > 0.8 ? Math.sin((t - 0.8) / 0.2 * Math.PI) * 0.06 : 0;
    const sink = Math.max(0, (now - this.deadAt - 1600) / 700) * 40;
    const kind = this.deathKind;
    const tilt = (Math.PI / 2 - 0.05 + settle) * e;
    // root: tilt about the body's lateral (y) or forward (x) axis under the yaw ('ZYX': local tilt, then yaw)
    if (kind === 0) this.root.rotation.set(0, -tilt, yaw, 'ZYX');            // backward
    else if (kind === 1) this.root.rotation.set(0, tilt, yaw, 'ZYX');        // forward
    else this.root.rotation.set(tilt * 0.95, 0.25 * e, yaw, 'ZYX');           // side
    // the hips drop to the floor as the body goes over (the origin stays 24 above the floor)
    const lie = kind === 1 ? 6 : 7;
    this.root.position.z = origin[2] - (24 - lie) * e - sink;
    this.legs.rotation.set(0, 0, 0); this.legs.position.z = 0;
    this.torso.position.z = 6;
    // limbs: a flail in the first half, then the corpse pose
    const fl = Math.sin(Math.min(1, t * 2) * Math.PI);
    if (kind === 0) { // arms up and out, one knee drawn up, head back
      this.torso.rotation.set(0, -0.35 * e, 0.15 * e); this.head.rotation.set(0, -0.5 * e, 0.3 * e);
      this.hipL.rotation.set(0, -0.9 * e, 0.15 * e); this.hipL.userData.knee.rotation.set(0, 1.4 * e, 0); this.hipR.rotation.set(0, -0.2 * e, -0.2 * e); this.hipR.userData.knee.rotation.set(0, 0.3 * e, 0);
      _t.set(-4 + fl * 6, -16, 4 + fl * 8); solveArm(this.armR, this.armR.userData.elbow, _t, HINT_R); _t.set(2 + fl * 4, 15, -2 + fl * 10); solveArm(this.armL, this.armL.userData.elbow, _t, HINT_L);
    } else if (kind === 1) { // face down, curled: arms under the body, legs straight
      this.torso.rotation.set(0, 0.55 * e, -0.1 * e); this.head.rotation.set(0, 0.4 * e, 0);
      this.hipL.rotation.set(0, 0.2 * e, 0.1 * e); this.hipL.userData.knee.rotation.set(0, 0.5 * e, 0); this.hipR.rotation.set(0, -0.1 * e, -0.15 * e); this.hipR.userData.knee.rotation.set(0, 0.2 * e, 0);
      _t.set(8 - fl * 4, -12, -12 + fl * 10); solveArm(this.armR, this.armR.userData.elbow, _t, HINT_R); _t.set(10, 10, -12 + fl * 8); solveArm(this.armL, this.armL.userData.elbow, _t, HINT_L);
    } else { // side: crumpled, knees bent, arms down
      this.torso.rotation.set(0.2 * e, 0.3 * e, 0.4 * e); this.head.rotation.set(0.3 * e, 0.2 * e, 0);
      this.hipL.rotation.set(0.1 * e, -0.7 * e, 0); this.hipL.userData.knee.rotation.set(0, 1.5 * e, 0); this.hipR.rotation.set(0, -1.0 * e, 0); this.hipR.userData.knee.rotation.set(0, 1.9 * e, 0);
      _t.set(6 + fl * 4, -8, -14 + fl * 12); solveArm(this.armR, this.armR.userData.elbow, _t, HINT_R); _t.set(4, 12 + fl * 4, -10 + fl * 8); solveArm(this.armL, this.armL.userData.elbow, _t, HINT_L);
    }
    this.gunRig.rotation.set(0, 0.3 * e, 0); this.gunRig.position.set(0, 0, 16);
    const wm = this.weaponMeshes[this.weaponId];
    if (wm && wm.userData.blur) { this.bladeSpin = 0; wm.userData.blur.visible = false; }
    if (wm && wm.userData.arc) wm.userData.arc.visible = false;
  }
  dispose() { this.scene.remove(this.root); this.scene.remove(this.shadow); this.shadow.material.dispose(); for (const b of this.bones) for (const m of b.children) if (m.isMesh && m.userData.deco) m.geometry.dispose(); }
}
