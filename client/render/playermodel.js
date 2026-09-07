// Remote player model: a stylized armored humanoid built from primitives (Q3 bbox: feet at -24, head at +32),
// posed procedurally: run cycle from velocity, jump tuck, crouch, and a death fall. Bright team color + emissive
// visor/trim so it reads at distance; a blob shadow under the feet; the held weapon is the shared weapon mesh.
import * as THREE from 'three';
import { makeWeaponMesh } from './weapons.js';
import { getSprite } from './particles.js';

const _v = new THREE.Vector3();
let shadowMat = null, shadowGeo = null;

export class PlayerModel {
  constructor(scene, color) {
    this.scene = scene; this.color = color;
    this.group = new THREE.Group();
    const armor = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.55, emissive: color, emissiveIntensity: 0.32 });
    const plate = new THREE.MeshStandardMaterial({ color: 0xd8dde8, roughness: 0.35, metalness: 0.8 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1d24, roughness: 0.7, metalness: 0.3 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xcfb8a0, roughness: 0.7 });
    const visorMat = new THREE.MeshBasicMaterial({ color });
    const box = (w, d, h, m, x = 0, y = 0, z = 0) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), m); b.position.set(x, y, z); return b; };
    const sphere = (r, m, x = 0, y = 0, z = 0) => { const s = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), m); s.position.set(x, y, z); return s; };
    // upper body (pivot at the hips, z = 0)
    this.upper = new THREE.Group();
    this.upper.add(box(14, 20, 20, armor, 0, 0, 11));                 // torso
    this.upper.add(box(6, 14, 12, plate, 6, 0, 13));                  // chest plate
    this.upper.add(box(15, 22, 4, dark, 0, 0, 2));                    // belt
    this.upper.add(sphere(5.5, armor, 0, 12.5, 20), sphere(5.5, armor, 0, -12.5, 20)); // shoulder pads
    this.upper.add(box(6, 6, 4, dark, 0, 0, 22));                     // neck
    this.head = new THREE.Group(); this.head.position.z = 28;
    this.head.add(sphere(6.5, skin, 0, 0, 0));
    const helmet = sphere(7.2, armor, -0.5, 0, 1); helmet.scale.set(1, 1, 0.9); this.head.add(helmet);
    this.visor = box(3, 9, 3, visorMat, 6.2, 0, 0.5); this.head.add(this.visor);
    this.upper.add(this.head);
    // arms: pivot at the shoulders
    const arm = (side) => {
      const sh = new THREE.Group(); sh.position.set(0, side * 12.5, 19);
      sh.add(box(5.5, 5.5, 12, armor, 0, 0, -6));                    // upper arm
      const el = new THREE.Group(); el.position.z = -12; el.add(box(5, 5, 11, dark, 0, 0, -5.5)); el.add(box(5.5, 5.5, 4, plate, 0, 0, -11)); // forearm + glove
      sh.add(el); sh.userData.elbow = el;
      return sh;
    };
    this.armR = arm(-1); this.armL = arm(1); this.upper.add(this.armR, this.armL);
    // weapon in the right hand (forearm space): barrel forward
    this.weaponHolder = new THREE.Group(); this.weaponHolder.position.set(2, 0, -12); this.armR.userData.elbow.add(this.weaponHolder);
    this.weaponMeshes = {}; this.weaponId = -1;
    // legs: pivot at the hips
    const leg = (side) => {
      const hip = new THREE.Group(); hip.position.set(0, side * 5.5, -1);
      hip.add(box(7, 7, 12, dark, 0, 0, -6)); hip.add(box(7.5, 7.5, 5, armor, 0, 0, -4)); // thigh + thigh plate
      const knee = new THREE.Group(); knee.position.z = -12; knee.add(box(6, 6, 11, dark, 0, 0, -5.5)); knee.add(box(9, 7, 4, plate, 1.5, 0, -11)); // shin + boot
      hip.add(knee); hip.userData.knee = knee;
      return hip;
    };
    this.legL = leg(1); this.legR = leg(-1);
    this.group.add(this.upper, this.legL, this.legR);
    // blob shadow (Q3 cg_shadows 1)
    if (!shadowMat) { shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, map: getSprite('soft'), transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }); shadowGeo = new THREE.CircleGeometry(20, 20); }
    this.shadow = new THREE.Mesh(shadowGeo, shadowMat.clone()); this.shadow.renderOrder = 2;
    scene.add(this.group, this.shadow);
    this.cycle = 0; this.dead = false; this.deadAt = 0; this.lastGround = true;
  }
  setWeapon(w) {
    if (w === this.weaponId) return;
    this.weaponId = w;
    for (const k in this.weaponMeshes) this.weaponMeshes[k].visible = false;
    // elbow space: -Z is the forearm direction (= facing direction once the arm is raised), +X is up
    if (!this.weaponMeshes[w]) { const m = makeWeaponMesh(w, 0.7); m.rotation.y = Math.PI / 2; m.position.set(-2, 0, -4); this.weaponHolder.add(m); this.weaponMeshes[w] = m; }
    this.weaponMeshes[w].visible = true;
  }
  // world-space muzzle of the held weapon (for beams / muzzle flashes)
  muzzleWorld() {
    const m = this.weaponMeshes[this.weaponId]; if (!m) return null;
    this.group.updateMatrixWorld();
    _v.set(...m.userData.muzzle).applyMatrix4(m.matrixWorld);
    return [_v.x, _v.y, _v.z];
  }
  update(origin, angles, r, now, dt, floorZ) {
    this.group.position.set(origin[0], origin[1], origin[2]);
    const yaw = angles[1] * Math.PI / 180;
    const dead = !!r.d;
    if (dead && !this.dead) this.deadAt = now;
    this.dead = dead;
    this.setWeapon(r.w);
    // blob shadow follows the floor, fades with height
    if (floorZ !== undefined) { const h = origin[2] - 24 - floorZ; this.shadow.position.set(origin[0], origin[1], floorZ + 0.4); this.shadow.material.opacity = Math.max(0, 0.55 - h / 300); this.shadow.visible = !dead || now - this.deadAt < 400; }
    if (dead) { // fall over sideways, then sink away
      const t = Math.min(1, (now - this.deadAt) / 300), s = Math.max(0, (now - this.deadAt - 1800) / 600);
      this.group.rotation.set(0, 0, yaw); this.group.rotateX(Math.PI / 2 * t); this.group.rotateY(0.3 * t);
      this.group.position.z = origin[2] - 18 * t - s * 40;
      this.pose(0, 0, false, false, 0);
      return;
    }
    this.group.rotation.set(0, 0, yaw);
    this.upper.rotation.y = angles[0] * Math.PI / 180 * 0.35; // torso follows pitch a little
    const v = r.v || [0, 0, 0];
    const speed = Math.hypot(v[0], v[1]);
    const ground = !!r.g;
    // strafing/backpedal direction relative to facing decides the leg swing sign
    const fwd = (v[0] * Math.cos(yaw) + v[1] * Math.sin(yaw)) >= -20 ? 1 : -1;
    if (ground && speed > 30) this.cycle += dt * speed * 0.028 * fwd;
    const ducked = (r.pf & 1) !== 0;
    this.pose(ground ? Math.min(1, speed / 320) : 0, this.cycle, !ground, ducked, angles[0]);
    this.lastGround = ground;
  }
  // amt: run amount 0..1, c: cycle phase, air: jumping/falling, duck: crouched
  pose(amt, c, air, duck, pitch) {
    const swing = Math.sin(c) * 0.75 * amt, lift = Math.max(0, Math.sin(c)) * 0.9 * amt, lift2 = Math.max(0, -Math.sin(c)) * 0.9 * amt;
    const lHip = this.legL, rHip = this.legR;
    if (air) { // tuck
      lHip.rotation.y = -0.6; rHip.rotation.y = -0.3; lHip.userData.knee.rotation.y = 1.3; rHip.userData.knee.rotation.y = 1.0;
    } else if (duck) {
      lHip.rotation.y = -1.3; rHip.rotation.y = -1.3; lHip.userData.knee.rotation.y = 1.9; rHip.userData.knee.rotation.y = 1.9;
    } else {
      lHip.rotation.y = swing; rHip.rotation.y = -swing;
      lHip.userData.knee.rotation.y = lift; rHip.userData.knee.rotation.y = lift2;
    }
    // hips drop when crouched (the bbox top drops from +32 to +16) and bob with the run cycle
    this.upper.position.z = duck ? -14 : Math.abs(Math.sin(c)) * 1.2 * amt;
    lHip.position.z = rHip.position.z = duck ? -6 : -1;
    // arms: right arm aims the weapon forward at the view pitch; left arm swings / supports
    const aim = -(pitch || 0) * Math.PI / 180;
    this.armR.rotation.set(0, -Math.PI / 2 + aim, 0); this.armR.userData.elbow.rotation.set(0, 0, 0);
    this.armL.rotation.set(0, air ? -1.2 : -0.5 - Math.sin(c) * 0.5 * amt - (duck ? 0.6 : 0), duck ? 0.3 : 0.1); this.armL.userData.elbow.rotation.set(0, -0.9, 0);
    this.head.rotation.y = aim * 0.4;
  }
  dispose() { this.scene.remove(this.group); this.scene.remove(this.shadow); this.shadow.material.dispose(); }
}
