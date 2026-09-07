// First-person weapon viewmodel. Lives in its own scene + camera (fixed 90-degree horizontal FOV like Q3's
// weapon rendering, independent of the player's FOV) rendered after the world with the depth buffer cleared, so
// the gun never clips into walls. Position is low-right, barrel forward, with Q3-style bob, sway, idle drift,
// recoil and drop/raise switch animation. Muzzle flash = additive sprite + a small light inside this scene.
import * as THREE from 'three';
import { WEAPONS, WEAPON_DROP_TIME, WEAPON_RAISE_TIME } from '../../shared/constants.js';
import { makeWeaponMesh, weaponColor } from './weapons.js';
import { getSprite } from './particles.js';

const SCALE = 0.4;
// per-weapon scale on top of SCALE: the fat RL tube and the tall LG (rings + rods) would otherwise exceed the 25%
// screen-height budget that keeps the gun out of the way (measured at 1.0: RL 27.7%, LG 25.3%, RG 23.1%)
const WEAPON_SCALE = { [WEAPONS.ROCKET]: 0.8, [WEAPONS.LIGHTNING]: 0.9, [WEAPONS.RAIL]: 0.95, [WEAPONS.PLASMA]: 0.92 };
// rest pose in camera space (+X right, +Y up, -Z forward): low-right, ~20% of screen height at the 90-degree weapon FOV
const REST = new THREE.Vector3(9.5, -10.5, -40);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _f = new THREE.Vector3();

export class ViewModel {
  constructor(mainCamera) {
    this.mainCamera = mainCamera;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.5, 400);
    this.scene.add(this.camera);
    this.rig = new THREE.Group(); this.camera.add(this.rig);
    // constant light set: hemisphere fill + key light + muzzle light (intensity animated, never removed)
    this.hemi = new THREE.HemisphereLight(0xbfd0ee, 0x4a3a2a, 1.7); this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xfff0e0, 2.4); this.key.position.set(-0.6, 0.8, 0.5); this.camera.add(this.key); this.camera.add(this.key.target); this.key.target.position.set(0, 0, -1);
    this.muzzleLight = new THREE.PointLight(0xffffff, 0, 60, 2); this.rig.add(this.muzzleLight);
    this.flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffffff, map: getSprite('soft'), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
    this.flashSprite.renderOrder = 30; this.rig.add(this.flashSprite);
    this.meshes = {};
    this.current = 0; this.recoil = 0; this.sway = [0, 0]; this.lastYaw = 0; this.lastPitch = 0; this.flashUntil = 0; this.flashColor = 0xffffff; this.hidden = false;
    this.muzzle = new THREE.Object3D(); this.rig.add(this.muzzle);
    this.lgGlow = null;
  }
  ensure(w) {
    if (!this.meshes[w]) {
      const m = makeWeaponMesh(w, SCALE * (WEAPON_SCALE[w] || 1));
      // weapon local +X forward -> camera -Z forward; +Z up -> +Y up; +Y left -> -X (mirror keeps it right-handed)
      const holder = new THREE.Group(); holder.add(m);
      m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)));
      holder.userData.muzzle = new THREE.Vector3(...m.userData.muzzle).applyQuaternion(m.quaternion);
      holder.visible = false; this.rig.add(holder); this.meshes[w] = holder;
    }
    return this.meshes[w];
  }
  setWeapon(w) { this.current = w; }
  fire(w) {
    this.recoil = 1;
    const c = weaponColor(w);
    this.flashColor = c;
    this.flashUntil = performance.now() + (w === WEAPONS.LIGHTNING ? 60 : w === WEAPONS.RAIL ? 160 : 70);
    this.flashSize = w === WEAPONS.ROCKET ? 7 : w === WEAPONS.RAIL ? 6 : w === WEAPONS.SHOTGUN ? 6.5 : w === WEAPONS.LIGHTNING ? 1.6 : 4;
    this.muzzleLight.color.setHex(c); this.muzzleLight.intensity = w === WEAPONS.LIGHTNING ? 30 : w === WEAPONS.MACHINEGUN ? 50 : 90;
  }
  // World-space muzzle position for the MAIN camera: the viewmodel is drawn with its own FOV, so its screen
  // position is re-projected through the main camera at the same view depth (beams/tracers then start exactly at the barrel tip).
  muzzleWorld() {
    this.scene.updateMatrixWorld();
    this.muzzle.getWorldPosition(_w);
    const depth = -_v.copy(_w).applyMatrix4(this.camera.matrixWorldInverse).z;
    _v.copy(_w).project(this.camera); _v.z = 0.5; _v.unproject(this.mainCamera);
    _v.sub(this.mainCamera.position).normalize();
    this.mainCamera.getWorldDirection(_f);
    const t = depth / Math.max(0.05, _v.dot(_f));
    _v.multiplyScalar(t).add(this.mainCamera.position);
    return [_v.x, _v.y, _v.z];
  }
  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.fov = 2 * Math.atan(Math.tan(90 * Math.PI / 360) / aspect) * 180 / Math.PI; // 90 horizontal
    this.camera.updateProjectionMatrix();
  }
  update(p, view, now, dt, bobTime, bobAmt) {
    for (const k in this.meshes) this.meshes[k].visible = false;
    this.camera.position.copy(this.mainCamera.position); this.camera.quaternion.copy(this.mainCamera.quaternion);
    if (view.dead || this.hidden) { this.muzzleLight.intensity = 0; this.flashSprite.material.opacity = 0; return; }
    const w = p.weapon;
    const holder = this.ensure(w);
    holder.visible = true;
    // switching: drop / raise
    let drop = 0;
    if (p.weaponState === 'dropping') drop = 1 - Math.max(0, p.weaponTime) / WEAPON_DROP_TIME;
    else if (p.weaponState === 'raising') drop = Math.max(0, p.weaponTime) / WEAPON_RAISE_TIME;
    // sway from view angle deltas (lags the view a little, springs back)
    const yaw = view.angles[1], pitch = view.angles[0];
    let dy = yaw - this.lastYaw; if (dy > 180) dy -= 360; if (dy < -180) dy += 360;
    const dp = pitch - this.lastPitch; this.lastYaw = yaw; this.lastPitch = pitch;
    const k = Math.min(1, dt * 10);
    this.sway[0] += (Math.max(-1.2, Math.min(1.2, -dy * 0.05)) - this.sway[0]) * k;
    this.sway[1] += (Math.max(-1.2, Math.min(1.2, -dp * 0.05)) - this.sway[1]) * k;
    this.recoil *= Math.pow(0.0008, dt);
    // Q3 bob: figure-8 (x at half frequency of y) scaled by ground speed; idle drift when still
    const bx = Math.sin(bobTime * 0.5) * 0.55 * bobAmt, by = -Math.abs(Math.cos(bobTime * 0.5)) * 0.45 * bobAmt;
    const ix = Math.sin(now * 0.0011) * 0.12, iy = Math.sin(now * 0.0017) * 0.1;
    const kick = this.recoil * (w === WEAPONS.RAIL ? 2.2 : w === WEAPONS.ROCKET ? 1.8 : w === WEAPONS.SHOTGUN ? 1.6 : 0.6);
    // landing / stairs dip
    const land = view.landDip || 0;
    holder.position.set(REST.x + this.sway[0] + bx + ix, REST.y - drop * 6 + this.sway[1] + by + iy - land * 0.3, REST.z + kick);
    // barrel converges slightly toward the crosshair (+yaw turns the muzzle left, toward the screen centre)
    holder.rotation.set(this.recoil * 0.12 - drop * 0.9 + this.sway[1] * 0.02, 0.07 + this.sway[0] * 0.03, this.sway[0] * 0.02);
    // muzzle point follows the active weapon
    const mz = holder.userData.muzzle;
    this.muzzle.position.copy(holder.position).add(_v.copy(mz).applyEuler(holder.rotation));
    this.muzzleLight.position.copy(this.muzzle.position);
    this.flashSprite.position.copy(this.muzzle.position);
    // muzzle flash: flicker while active
    if (now < this.flashUntil) {
      this.flashSprite.material.color.setHex(this.flashColor);
      this.flashSprite.material.opacity = 0.6 + Math.random() * 0.4;
      const s = this.flashSize * (0.8 + Math.random() * 0.5); this.flashSprite.scale.set(s, s, 1);
      this.flashSprite.material.rotation = Math.random() * 6.28;
    } else this.flashSprite.material.opacity = 0;
    this.muzzleLight.intensity *= Math.pow(0.0002, dt);
  }
}
