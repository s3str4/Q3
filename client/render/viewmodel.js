// First-person weapon viewmodel. Lives in its own scene + camera (fixed 90-degree horizontal FOV like Q3's
// weapon rendering, independent of the player's FOV) rendered after the world with the depth buffer cleared, so
// the gun never clips into walls. Position is low-right, barrel forward, with Q3-style bob, sway, idle drift,
// per-weapon recoil (rail: hard kick + slow slide back, RL: kick + climb, MG: rattle, SG: kick + pump cycle),
// drop/raise switch animation, muzzle flashes from a 4-variant sprite sheet, an LG core that glows while firing
// and a rail coil that charges after a shot. Live parts use this instance's own materials (see weapons.js).
import * as THREE from 'three';
import { WEAPONS, WEAPON_DROP_TIME, WEAPON_RAISE_TIME } from '../../shared/constants.js';
import { makeWeaponMesh, weaponColor } from './weapons.js';
import { skinMaterials, skinFor } from './playermodel.js';
import { getSheet } from './particles.js';

const SCALE = 0.46;
// per-weapon scale on top of SCALE: the fat RL tube and the tall LG (rings + rods) would otherwise exceed the 25%
// screen-height budget that keeps the gun out of the way
const WEAPON_SCALE = { [WEAPONS.ROCKET]: 0.78, [WEAPONS.LIGHTNING]: 0.88, [WEAPONS.RAIL]: 0.92, [WEAPONS.PLASMA]: 0.9, [WEAPONS.GAUNTLET]: 1.1 };
// rest pose in camera space (+X right, +Y up, -Z forward): low-right, ~20% of screen height at the 90-degree weapon FOV
// Q3 cg_gun placement: the weapon sits low-right and close enough that its stock exits the frame at the bottom-right
// corner, held by a forearm that also runs off-screen, so it never reads as a gun floating in mid-air.
const REST = new THREE.Vector3(11.5, -12.5, -33);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _f = new THREE.Vector3(), _c = new THREE.Color();
const KICK = { [WEAPONS.RAIL]: 2.6, [WEAPONS.ROCKET]: 2.0, [WEAPONS.SHOTGUN]: 1.8, [WEAPONS.PLASMA]: 0.5, [WEAPONS.MACHINEGUN]: 0.45, [WEAPONS.LIGHTNING]: 0.15, [WEAPONS.GAUNTLET]: 0.3 };
const FLASH_MS = { [WEAPONS.LIGHTNING]: 60, [WEAPONS.RAIL]: 150, [WEAPONS.ROCKET]: 80, [WEAPONS.SHOTGUN]: 80, [WEAPONS.PLASMA]: 50, [WEAPONS.MACHINEGUN]: 45 };
const FLASH_SIZE = { [WEAPONS.ROCKET]: 8, [WEAPONS.RAIL]: 6.5, [WEAPONS.SHOTGUN]: 7.5, [WEAPONS.LIGHTNING]: 2.2, [WEAPONS.PLASMA]: 4, [WEAPONS.MACHINEGUN]: 4.5 };

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
    // muzzle flash: one sprite per sheet variant (each a cloned texture window), one of them shown per shot
    const sh = getSheet('flash');
    this.flashMats = [];
    for (let i = 0; i < 4; i++) {
      const t = sh.tex.clone(); t.repeat.set(1 / sh.cols, 1 / sh.rows); t.offset.set((i % sh.cols) / sh.cols, (sh.rows - 1 - Math.floor(i / sh.cols)) / sh.rows); t.needsUpdate = true;
      this.flashMats.push(new THREE.SpriteMaterial({ color: 0xffffff, map: t, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
    }
    this.flashSprite = new THREE.Sprite(this.flashMats[0]); this.flashSprite.renderOrder = 30; this.rig.add(this.flashSprite);
    this.meshes = {};
    this.current = 0; this.recoil = 0; this.slide = 0; this.climb = 0; this.sway = [0, 0]; this.lastYaw = 0; this.lastPitch = 0; this.flashUntil = 0; this.flashColor = 0xffffff; this.hidden = false;
    this.firingUntil = 0; this.lastFireAt = -1e9; this.lastFireWeapon = 0; this.railCharge = 0; this.bladeSpin = 0; this.bladeAngle = 0; this.pumpAt = -1e9;
    this.muzzle = new THREE.Object3D(); this.rig.add(this.muzzle);
    this.armMats = skinMaterials('sarge', 0x4ab3ff); this.armSkin = 'sarge';
  }
  // called with the local player's name so the arms wear the same skin as the third-person model
  setSkin(name, id) {
    const skin = skinFor(name, id);
    if (skin === this.armSkin) return;
    this.armSkin = skin; this.armMats = skinMaterials(skin, 0x4ab3ff);
    for (const k in this.meshes) { this.rig.remove(this.meshes[k]); delete this.meshes[k]; }
  }
  ensure(w) {
    if (!this.meshes[w]) {
      const m = makeWeaponMesh(w, SCALE * (WEAPON_SCALE[w] || 1), { live: true });
      // weapon local +X forward -> camera -Z forward; +Z up -> +Y up; +Y left -> -X (mirror keeps it right-handed)
      const holder = new THREE.Group(); holder.add(m);
      m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)));
      holder.userData.muzzle = new THREE.Vector3(...m.userData.muzzle).applyQuaternion(m.quaternion);
      holder.userData.model = m;
      // first-person arms in holder space (+X right, +Y up, -Z forward): a right forearm from the grip toward the
      // bottom-right corner (off-screen), a hand on the grip, and for two-handed weapons a left hand under the fore-end
      const arms = new THREE.Group(); holder.add(arms); holder.userData.arms = arms;
      const K = SCALE / 0.4;
      const gripPos = new THREE.Vector3(0.3, -5.2 * K, 1.5);
      const toCorner = new THREE.Vector3(10, -11, 12);
      const fore = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 2.2, toCorner.length(), 10), this.armMats.suit);
      fore.position.copy(gripPos).addScaledVector(toCorner, 0.5); fore.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), toCorner.clone().normalize()); arms.add(fore);
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 2.2, 10), this.armMats.armor);
      cuff.position.copy(gripPos).addScaledVector(toCorner, 0.28); cuff.quaternion.copy(fore.quaternion); arms.add(cuff);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(3.2, 4.6, 3.4), this.armMats.flesh); hand.position.copy(gripPos).add(new THREE.Vector3(0.6, 0.4, 0.4)); hand.rotation.set(0.2, 0, -0.3); arms.add(hand);
      for (let i = 0; i < 3; i++) { const f = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 2.6), this.armMats.flesh); f.position.copy(hand.position).add(new THREE.Vector3(-1.2 + i * 1.1, -0.6, -1.9)); f.rotation.x = -0.5; arms.add(f); }
      if (w !== WEAPONS.GAUNTLET) {
        const lh = new THREE.Vector3(-0.6, -4.6 * K, -7.8 * K);
        const lhand = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.2, 4.6), this.armMats.flesh); lhand.position.copy(lh); lhand.rotation.set(0.15, 0.25, 0.1); arms.add(lhand);
        const lTo = new THREE.Vector3(-3.5, -13, 7);
        const lfore = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 2.0, lTo.length(), 10), this.armMats.suit);
        lfore.position.copy(lh).addScaledVector(lTo, 0.5); lfore.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), lTo.clone().normalize()); arms.add(lfore);
        const lcuff = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.1, 2, 10), this.armMats.armor); lcuff.position.copy(lh).addScaledVector(lTo, 0.3); lcuff.quaternion.copy(lfore.quaternion); arms.add(lcuff);
      }
      holder.visible = false; this.rig.add(holder); this.meshes[w] = holder;
    }
    return this.meshes[w];
  }
  setWeapon(w) { this.current = w; }
  fire(w) {
    const now = performance.now();
    this.recoil = 1; this.lastFireAt = now; this.lastFireWeapon = w;
    if (w === WEAPONS.RAIL) { this.slide = 1; this.railCharge = 1; }
    if (w === WEAPONS.ROCKET) this.climb = 1;
    if (w === WEAPONS.SHOTGUN) this.pumpAt = now + 180;
    this.firingUntil = now + (w === WEAPONS.LIGHTNING ? 90 : w === WEAPONS.MACHINEGUN ? 130 : 60);
    const c = weaponColor(w);
    this.flashColor = c;
    this.flashUntil = now + (FLASH_MS[w] || 0);
    this.flashSize = FLASH_SIZE[w] || 4;
    this.flashSprite.material = this.flashMats[w === WEAPONS.ROCKET || w === WEAPONS.SHOTGUN ? Math.floor(Math.random() * 3) : Math.random() < 0.5 ? 3 : Math.floor(Math.random() * 3)];
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
    for (const m of this.flashMats) m.opacity = 0;
    if (view.dead || this.hidden) { this.muzzleLight.intensity = 0; return; }
    const w = p.weapon;
    if (p.name) this.setSkin(p.name, p.id);
    const holder = this.ensure(w);
    holder.visible = true;
    const model = holder.userData.model, live = model.userData.live;
    const firing = now < this.firingUntil;
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
    // recoil springs: the sharp kick decays fast; the rail slide and the RL climb come back slowly
    this.recoil *= Math.pow(0.0008, dt); this.slide *= Math.pow(0.03, dt); this.climb *= Math.pow(0.01, dt); this.railCharge *= Math.pow(0.15, dt);
    // Q3 bob: figure-8 (x at half frequency of y) scaled by ground speed; idle drift when still
    const bx = Math.sin(bobTime * 0.5) * 0.55 * bobAmt, by = -Math.abs(Math.cos(bobTime * 0.5)) * 0.45 * bobAmt;
    const ix = Math.sin(now * 0.0011) * 0.12 + Math.sin(now * 0.0023) * 0.05, iy = Math.sin(now * 0.0017) * 0.1 + Math.cos(now * 0.0031) * 0.04;
    const kick = this.recoil * (KICK[w] || 0.5) + this.slide * 2.2;
    // machinegun rattle: a small random shake while the burst lasts
    const rattle = w === WEAPONS.MACHINEGUN && firing ? 0.25 : 0;
    const rx = (Math.random() - 0.5) * rattle, ry = (Math.random() - 0.5) * rattle;
    // landing / stairs dip
    const land = view.landDip || 0;
    holder.position.set(REST.x + this.sway[0] + bx + ix + rx, REST.y - drop * 6 + this.sway[1] + by + iy - land * 0.3 + this.climb * 0.6 + ry, REST.z + kick);
    // barrel converges slightly toward the crosshair (+yaw turns the muzzle left, toward the screen centre); recoil pitches it up
    holder.rotation.set(this.recoil * 0.12 + this.climb * 0.1 + this.slide * 0.05 - drop * 0.9 + this.sway[1] * 0.02, 0.07 + this.sway[0] * 0.03 + this.recoil * 0.03, this.sway[0] * 0.02 - this.recoil * 0.04);
    // --- per-weapon live parts ---
    if (model.userData.blade) { // gauntlet: the blade spins up while the trigger is held, freewheels down after
      const want = p.attackHeld ? 40 : 0;
      this.bladeSpin += (want - this.bladeSpin) * Math.min(1, dt * (p.attackHeld ? 6 : 1.5));
      this.bladeAngle += this.bladeSpin * dt; model.userData.blade.rotation.y = this.bladeAngle;
    }
    if (model.userData.pump) { // shotgun: pump cycles back and forward ~180 ms after the shot
      const t = (now - this.pumpAt) / 320; const s = t > 0 && t < 1 ? Math.sin(t * Math.PI) : 0;
      model.userData.pump.position.x = 13 - s * 5;
    }
    if (live) {
      if (w === WEAPONS.LIGHTNING) { // core pulses at rest, blazes while the beam is on
        const pulse = 0.55 + 0.25 * Math.sin(now * 0.012), hot = firing ? 1 : 0;
        live.core.color.setHex(0xbfe8ff).lerp(_c.setHex(0xffffff), hot * 0.8).multiplyScalar(pulse + hot * 1.2);
        live.coil.emissiveIntensity = 0.6 + hot * 1.6 + (firing ? Math.random() * 0.5 : 0);
      } else if (w === WEAPONS.RAIL) { // coil charge glow after a shot, sinking back over ~1 s
        live.coil.emissiveIntensity = 0.6 + this.railCharge * 2.6;
        live.core.color.setHex(0x5cff9d).multiplyScalar(0.8 + this.railCharge * 2);
      } else if (w === WEAPONS.PLASMA) { live.core.color.setHex(0xe8d0ff).multiplyScalar(0.9 + 0.2 * Math.sin(now * 0.02) + (firing ? 0.8 : 0)); live.coil.emissiveIntensity = 0.6 + (firing ? 0.8 : 0); }
      else if (w === WEAPONS.GAUNTLET) { live.core.color.setHex(0xff9a5c).multiplyScalar(0.8 + this.bladeSpin / 40 * 1.2); }
    }
    // muzzle point follows the active weapon
    const mz = holder.userData.muzzle;
    this.muzzle.position.copy(holder.position).add(_v.copy(mz).applyEuler(holder.rotation));
    this.muzzleLight.position.copy(this.muzzle.position);
    this.flashSprite.position.copy(this.muzzle.position);
    // muzzle flash: flicker while active
    if (now < this.flashUntil) {
      const m = this.flashSprite.material;
      m.color.setHex(this.flashColor).lerp(_c.setHex(0xffffff), 0.35);
      m.opacity = 0.75 + Math.random() * 0.25;
      const s = this.flashSize * (0.8 + Math.random() * 0.5); this.flashSprite.scale.set(s, s, 1);
      m.rotation = Math.random() * 6.28;
    }
    this.muzzleLight.intensity *= Math.pow(0.0002, dt);
  }
}
