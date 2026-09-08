// Low-poly skinned characters: one SkinnedMesh (one draw call) per character, 10 bones, boxes welded to bones with
// hard weights. The model faces local +X; sim facing theta (0 = east, PI/2 = south) maps to rotation.y = -theta.
// Procedural animation only: gait bob + arm swing from speed, sneak crouch, melee swing arc (~0.18 s), pistol aim
// + recoil, stagger recoil, death fall (stays down), zombie hunch / chase lunge / attack windup.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const BONE = { ROOT: 0, TORSO: 1, HEAD: 2, ARM_L: 3, ARM_R: 4, LEG_L: 5, LEG_R: 6, BAT: 7, PISTOL: 8, LANTERN: 9 };
const HIP = 0.88, SHOULDER = 1.38, HAND = 0.80;

function part(bone, w, h, d, x, y, z, hex) {
  const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); const n = g.attributes.position.count;
  const c = new THREE.Color(hex), col = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { col.set([c.r, c.g, c.b], i * 3); si[i * 4] = bone; sw[i * 4] = 1; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4)); g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  return g;
}
// palette: { skin, hair|null, shirt, pants, boots, hands }
function buildGeometry(p, opts = {}) {
  const parts = [
    part(BONE.TORSO, 0.30, 0.54, 0.48, 0, HIP + 0.27, 0, p.shirt),
    part(BONE.HEAD, 0.30, 0.30, 0.30, 0.01, 1.58, 0, p.skin),
    part(BONE.HEAD, 0.08, 0.06, 0.05, 0.17, 1.55, 0, p.skin),           // nose: makes facing readable from above
    part(BONE.ARM_L, 0.16, 0.60, 0.16, 0, SHOULDER - 0.30, -0.32, p.shirt), part(BONE.ARM_L, 0.15, 0.12, 0.15, 0, HAND - 0.06, -0.32, p.hands),
    part(BONE.ARM_R, 0.16, 0.60, 0.16, 0, SHOULDER - 0.30, 0.32, p.shirt), part(BONE.ARM_R, 0.15, 0.12, 0.15, 0, HAND - 0.06, 0.32, p.hands),
    part(BONE.LEG_L, 0.22, 0.86, 0.22, 0, HIP - 0.44, -0.12, p.pants), part(BONE.LEG_L, 0.27, 0.12, 0.22, 0.03, 0.06, -0.12, p.boots),
    part(BONE.LEG_R, 0.22, 0.86, 0.22, 0, HIP - 0.44, 0.12, p.pants), part(BONE.LEG_R, 0.27, 0.12, 0.22, 0.03, 0.06, 0.12, p.boots),
  ];
  if (p.hair) parts.push(part(BONE.HEAD, 0.32, 0.09, 0.32, -0.02, 1.74, 0, p.hair));
  if (opts.player) {
    parts.push(part(BONE.BAT, 0.09, 0.85, 0.09, 0, HAND - 0.30, 0.32, 0xc09050), part(BONE.BAT, 0.11, 0.25, 0.11, 0, HAND - 0.62, 0.32, 0xa87840));
    parts.push(part(BONE.PISTOL, 0.06, 0.26, 0.06, 0, HAND - 0.15, 0.32, 0x2a2a2e), part(BONE.PISTOL, 0.10, 0.06, 0.06, 0.04, HAND - 0.04, 0.32, 0x1a1a1e));
    parts.push(part(BONE.LANTERN, 0.14, 0.2, 0.14, 0, HAND - 0.18, -0.32, 0xfff0a0), part(BONE.LANTERN, 0.16, 0.04, 0.16, 0, HAND - 0.06, -0.32, 0x333333));
    parts.push(part(BONE.TORSO, 0.14, 0.4, 0.36, -0.2, HIP + 0.3, 0, 0x6a4a2a));                 // backpack
  } else {
    parts.push(part(BONE.TORSO, 0.32, 0.2, 0.2, 0, HIP + 0.1, -0.14, p.pants));                   // torn shirt / belt
  }
  return mergeGeometries(parts);
}
function makeBones() {
  const b = []; for (let i = 0; i < 10; i++) b.push(new THREE.Bone());
  b[BONE.ROOT].position.set(0, HIP, 0);
  b[BONE.TORSO].position.set(0, 0, 0); b[BONE.ROOT].add(b[BONE.TORSO]);
  b[BONE.HEAD].position.set(0, 1.42 - HIP, 0); b[BONE.TORSO].add(b[BONE.HEAD]);
  b[BONE.ARM_L].position.set(0, SHOULDER - HIP, -0.32); b[BONE.TORSO].add(b[BONE.ARM_L]);
  b[BONE.ARM_R].position.set(0, SHOULDER - HIP, 0.32); b[BONE.TORSO].add(b[BONE.ARM_R]);
  b[BONE.LEG_L].position.set(0, 0, -0.12); b[BONE.ROOT].add(b[BONE.LEG_L]);
  b[BONE.LEG_R].position.set(0, 0, 0.12); b[BONE.ROOT].add(b[BONE.LEG_R]);
  b[BONE.BAT].position.set(0, HAND - SHOULDER, 0); b[BONE.ARM_R].add(b[BONE.BAT]);
  b[BONE.PISTOL].position.set(0, HAND - SHOULDER, 0); b[BONE.ARM_R].add(b[BONE.PISTOL]);
  b[BONE.LANTERN].position.set(0, HAND - SHOULDER, 0); b[BONE.ARM_L].add(b[BONE.LANTERN]);
  return b;
}
const PLAYER_PALETTE = { skin: 0xe8b898, hair: 0x4a2e1a, shirt: 0x2f6fe8, pants: 0x2a3550, boots: 0x3a2a1a, hands: 0xe8b898 };
const ZOMBIE_PALETTES = [
  { skin: 0x9fae8c, hair: null, shirt: 0x4a5a44, pants: 0x35363a, boots: 0x222222, hands: 0x9fae8c },
  { skin: 0xa3ad95, hair: 0x2a2a2a, shirt: 0x5a4a4a, pants: 0x3a3a44, boots: 0x222222, hands: 0xa3ad95 },
  { skin: 0x98a688, hair: null, shirt: 0x3e4e46, pants: 0x2f2f33, boots: 0x1e1e1e, hands: 0x98a688 },
];
// Character material: Lambert plus a self-fill term (emissive multiplied by the vertex colour) that the renderer drives
// up at night: the hero keeps his own colours (blue jacket) under the warm lantern, and zombies beyond the lantern pool
// read as faint pale figures instead of vanishing into the near-black ambient (7DTD "emerging from darkness").
function selfLitMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0 });
  m.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;'); };
  return m;
}
let geoCache = null;
function geometries() {
  if (!geoCache) geoCache = { player: buildGeometry(PLAYER_PALETTE, { player: true }), zombies: ZOMBIE_PALETTES.map((p) => buildGeometry(p)) };
  return geoCache;
}

export class Rig {
  constructor(kind, variant = 0) {
    const g = geometries(); this.kind = kind;
    this.mat = kind === 'player' ? Rig.playerMat || (Rig.playerMat = selfLitMaterial()) : Rig.zombieMat || (Rig.zombieMat = selfLitMaterial());
    this.mesh = new THREE.SkinnedMesh(kind === 'player' ? g.player : g.zombies[variant % g.zombies.length], this.mat);
    this.bones = makeBones(); this.mesh.add(this.bones[BONE.ROOT]); this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(this.bones)); this.mesh.frustumCulled = false;
    this.root = new THREE.Group(); this.root.add(this.mesh);
    this.phase = 0; this.attackT = 0; this.attackKind = null; this.stagger = 0; this.dead = 0; this.headTurn = 0; this.t = Math.random() * 10;
    this.eyeL = new THREE.Vector3(); this.eyeR = new THREE.Vector3();
  }
  // Night self-fill for both shared materials: dark 0 (noon) .. 1 (deep night). Player fill is strong (hero read),
  // zombie fill is faint (pale shape + glowing eyes, still clearly darker than the lantern pool).
  static setNight(dark) {
    const d = Math.max(0, dark - 0.2);
    if (Rig.playerMat) Rig.playerMat.emissiveIntensity = d * 0.5;
    if (Rig.zombieMat) Rig.zombieMat.emissiveIntensity = d * 0.35;
  }
  // Common: reset pose then apply per-kind. speed = tiles/s (interpolated), dt real seconds.
  pose() { for (const b of this.bones) { b.rotation.set(0, 0, 0); b.scale.set(1, 1, 1); } this.bones[BONE.ROOT].position.set(0, HIP, 0); this.mesh.rotation.set(0, 0, 0); this.mesh.position.set(0, 0, 0); }
  animatePlayer(p, speed, dt) {
    this.pose(); const b = this.bones; this.t += dt;
    const gait = p.gait, run = gait === 'run', sneak = gait === 'sneak';
    // weapon in hand: unused weapons collapse onto their bone (scale 0)
    b[BONE.BAT].scale.setScalar(p.weapon === 'bat' ? 1 : 0); b[BONE.PISTOL].scale.setScalar(p.weapon === 'pistol' ? 1 : 0);
    if (p.state === 'dead') { this.dead = Math.min(1, this.dead + dt * 2.5); this.fall(this.dead); return; }
    this.dead = 0;
    const moving = speed > 0.15; const freq = run ? 11 : sneak ? 5 : 7.5;
    if (moving) this.phase += dt * freq; const sw = moving ? Math.sin(this.phase) : 0, amp = run ? 0.9 : sneak ? 0.45 : 0.6;
    b[BONE.LEG_L].rotation.z = sw * amp; b[BONE.LEG_R].rotation.z = -sw * amp;
    b[BONE.ARM_L].rotation.z = -sw * amp * 0.8; b[BONE.ARM_R].rotation.z = sw * amp * 0.8;
    b[BONE.ROOT].position.y = HIP + (moving ? Math.abs(Math.cos(this.phase)) * (run ? 0.07 : 0.035) : Math.sin(this.t * 2) * 0.01);
    if (run) b[BONE.TORSO].rotation.z = -0.22;
    if (sneak) { b[BONE.ROOT].position.y -= 0.28; b[BONE.TORSO].rotation.z = -0.55; b[BONE.LEG_L].rotation.z += 0.5; b[BONE.LEG_R].rotation.z += 0.5; b[BONE.HEAD].rotation.z = 0.35; }
    // lantern arm held slightly forward
    b[BONE.ARM_L].rotation.z -= 0.35;
    if (p.weapon === 'pistol') { b[BONE.ARM_R].rotation.z = -1.45; b[BONE.ARM_R].rotation.y = 0; b[BONE.ARM_R].rotation.x = 0; b[BONE.PISTOL].rotation.x = 0; b[BONE.PISTOL].rotation.z = 0; }
    else if (p.weapon === 'bat') { b[BONE.ARM_R].rotation.z -= 0.5; b[BONE.BAT].rotation.z = -0.4; }
    // melee swing: overhead windup -> forward arc over 0.18 s, torso twist follows
    if (this.attackT > 0) {
      this.attackT = Math.max(0, this.attackT - dt); const u = 1 - this.attackT / 0.18;
      if (this.attackKind === 'pistol') { b[BONE.ARM_R].rotation.z = -1.45 - (1 - u) * 0.45; }
      else { b[BONE.ARM_R].rotation.z = -2.6 + u * 2.3; b[BONE.TORSO].rotation.y = 0.6 - u * 1.1; b[BONE.BAT].rotation.z = 0; }
    }
    if (this.stagger > 0) { this.stagger = Math.max(0, this.stagger - dt); const s = this.stagger / 0.28; b[BONE.TORSO].rotation.z = 0.5 * s; b[BONE.HEAD].rotation.z = 0.3 * s; b[BONE.ROOT].position.x = -0.15 * s; }
  }
  animateZombie(z, speed, dt, night) {
    this.pose(); const b = this.bones; this.t += dt;
    b[BONE.BAT].scale.setScalar(0); b[BONE.PISTOL].scale.setScalar(0); b[BONE.LANTERN].scale.setScalar(0);
    if (z.state === 'dead') { this.dead = Math.min(1, this.dead + dt * 2.2); this.fall(this.dead); return; }
    this.dead = 0;
    const chase = z.state === 'chase' || z.state === 'attack' || z.state === 'bash', investigate = z.state === 'investigate';
    const moving = speed > 0.1; const freq = chase ? 9 : 4.5;
    if (moving) this.phase += dt * freq; const sw = moving ? Math.sin(this.phase) : 0;
    const amp = chase ? 0.8 : 0.45;
    b[BONE.LEG_L].rotation.z = sw * amp; b[BONE.LEG_R].rotation.z = -sw * amp;
    // hunched: torso and head forward, arms hanging forward with a limp sway; chase = lunge with arms out
    // lean forward, hips pushed back so the torso stays above the feet (silhouette + markers + samples line up with x,y)
    b[BONE.TORSO].rotation.z = chase ? -0.42 : -0.32; b[BONE.HEAD].rotation.z = chase ? 0.3 : 0.18; b[BONE.ROOT].position.x = chase ? -0.14 : -0.1;
    const armBase = chase ? -1.35 : -0.75, sway = Math.sin(this.t * 3 + this.phase) * 0.15;
    b[BONE.ARM_L].rotation.z = armBase + sway - sw * 0.2; b[BONE.ARM_R].rotation.z = armBase - sway + sw * 0.2;
    b[BONE.ARM_L].rotation.x = -0.2; b[BONE.ARM_R].rotation.x = 0.2;
    b[BONE.ROOT].position.y = HIP - 0.05 + (moving ? Math.abs(Math.cos(this.phase)) * (chase ? 0.06 : 0.03) : 0);
    if (investigate) { this.headTurn = Math.sin(this.t * 2.2) * 0.7; b[BONE.HEAD].rotation.y = this.headTurn; }
    if (z.state === 'attack') { const u = 1 - Math.min(1, Math.max(0, z.attackWind / 0.35)); b[BONE.ARM_L].rotation.z = -2.4 + u * 0.4; b[BONE.ARM_R].rotation.z = -2.4 + u * 0.4; b[BONE.TORSO].rotation.z = -0.3 - u * 0.5; }
    if (z.state === 'bash') { const u = (Math.sin(this.t * 6) + 1) / 2; b[BONE.ARM_L].rotation.z = -2.2 + u * 1.2; b[BONE.ARM_R].rotation.z = -2.2 + u * 1.2; }
    if (z.state === 'stagger' || this.stagger > 0) { this.stagger = Math.max(0, this.stagger - dt); const s = z.state === 'stagger' ? 1 : this.stagger / 0.3; b[BONE.TORSO].rotation.z = 0.45 * s; b[BONE.ROOT].position.x = -0.2 * s; b[BONE.ARM_L].rotation.z = -0.3; b[BONE.ARM_R].rotation.z = -0.3; }
    void night;
  }
  // Death: topple forward about the feet and settle on the ground (u 0..1), then hold.
  fall(u) {
    const b = this.bones; const e = 1 - (1 - u) * (1 - u);
    this.mesh.rotation.z = -Math.PI / 2 * e; this.mesh.position.y = 0.12 * e; this.mesh.position.x = 0.1 * e;
    b[BONE.ARM_L].rotation.z = -1.2 * e; b[BONE.ARM_R].rotation.z = -1.4 * e; b[BONE.HEAD].rotation.z = 0.3 * e; b[BONE.LEG_L].rotation.z = 0.2 * e;
  }
  // World positions of the eyes (for the horde glow points): just in front of the head bone.
  eyes(outL, outR) {
    const h = this.bones[BONE.HEAD]; outL.set(0.2, 0.22, -0.07); outR.set(0.2, 0.22, 0.07);
    h.localToWorld(outL); h.localToWorld(outR);
  }
}
