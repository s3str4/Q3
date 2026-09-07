// First-person weapon viewmodel: primitive-built weapons with bob, sway, recoil and switch animation.
import * as THREE from 'three';
import { WEAPONS, WEAPON_DEFS, WEAPON_DROP_TIME, WEAPON_RAISE_TIME } from '../../shared/constants.js';

const COLORS = { [WEAPONS.ROCKET]: 0xff6a3a, [WEAPONS.RAIL]: 0x5cff9d, [WEAPONS.LIGHTNING]: 0xbfe8ff, [WEAPONS.SHOTGUN]: 0xffc86a, [WEAPONS.PLASMA]: 0xb26cff, [WEAPONS.MACHINEGUN]: 0xffe680, [WEAPONS.GAUNTLET]: 0xff9a5c };

export class ViewModel {
  constructor(scene, camera) {
    this.scene = scene; this.camera = camera;
    this.rig = new THREE.Group();
    camera.add(this.rig);
    scene.add(camera);
    this.meshes = {};
    this.current = 0; this.recoil = 0; this.switchT = 0; this.sway = [0, 0]; this.lastYaw = 0; this.lastPitch = 0;
    this.muzzleLight = new THREE.PointLight(0xffffff, 0, 300, 2); this.rig.add(this.muzzleLight);
    this.hidden = false;
  }
  metal(color, extra = {}) { return new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.85, ...extra }); }
  // Weapon meshes are built in a local frame: +X forward (barrel), +Z up, +Y left.
  makeWeaponMesh(w, scale = 1) {
    const g = new THREE.Group();
    const c = COLORS[w] || 0xffffff;
    const body = this.metal(0x3a3f4a), accent = this.metal(c, { emissive: c, emissiveIntensity: 0.6 });
    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.castShadow = true; g.add(m); return m; };
    switch (w) {
      case WEAPONS.ROCKET: add(new THREE.CylinderGeometry(5, 5, 34, 14), body, 8, 0, 0, 0, 0, Math.PI / 2); add(new THREE.CylinderGeometry(6.5, 5.5, 6, 14), accent, 26, 0, 0, 0, 0, Math.PI / 2); add(new THREE.BoxGeometry(14, 8, 10), body, -6, 0, -6); add(new THREE.BoxGeometry(6, 3, 8), accent, 0, 0, 7); break;
      case WEAPONS.RAIL: add(new THREE.BoxGeometry(40, 5, 5), body, 10, 0, 0); add(new THREE.CylinderGeometry(1.5, 1.5, 44, 8), accent, 10, 0, 3.5, 0, 0, Math.PI / 2); add(new THREE.CylinderGeometry(1.5, 1.5, 44, 8), accent, 10, 0, -3.5, 0, 0, Math.PI / 2); add(new THREE.BoxGeometry(10, 7, 9), body, -8, 0, -3); break;
      case WEAPONS.LIGHTNING: add(new THREE.CylinderGeometry(3.5, 3.5, 30, 10), body, 8, 0, 0, 0, 0, Math.PI / 2); for (let i = 0; i < 3; i++) add(new THREE.BoxGeometry(24, 1.5, 1.5), accent, 12, Math.cos(i * 2.1) * 4.5, Math.sin(i * 2.1) * 4.5); add(new THREE.BoxGeometry(12, 8, 10), body, -8, 0, -4); break;
      case WEAPONS.SHOTGUN: add(new THREE.CylinderGeometry(2.6, 2.6, 36, 10), body, 8, -2.6, 1, 0, 0, Math.PI / 2); add(new THREE.CylinderGeometry(2.6, 2.6, 36, 10), body, 8, 2.6, 1, 0, 0, Math.PI / 2); add(new THREE.BoxGeometry(16, 7, 7), this.metal(0x5a3a22, { metalness: 0.2, roughness: 0.7 }), -8, 0, -3); add(new THREE.BoxGeometry(4, 6, 2), accent, 4, 0, 4); break;
      case WEAPONS.PLASMA: add(new THREE.BoxGeometry(26, 8, 8), body, 6, 0, 0); add(new THREE.SphereGeometry(5, 12, 10), accent, 22, 0, 0); add(new THREE.BoxGeometry(10, 8, 10), body, -8, 0, -5); add(new THREE.TorusGeometry(5, 1, 8, 16), accent, 12, 0, 0, 0, Math.PI / 2, 0); break;
      case WEAPONS.MACHINEGUN: add(new THREE.CylinderGeometry(2, 2, 30, 8), body, 10, 0, 0, 0, 0, Math.PI / 2); add(new THREE.BoxGeometry(16, 6, 9), body, -4, 0, -3); add(new THREE.BoxGeometry(6, 5, 8), accent, -2, 0, -9); break;
      default: add(new THREE.BoxGeometry(12, 6, 6), body, 0, 0, 0); add(new THREE.CylinderGeometry(4, 4, 3, 12), accent, 9, 0, 0, 0, Math.PI / 2, 0); break;
    }
    g.scale.setScalar(scale);
    return g;
  }
  ensure(w) {
    if (!this.meshes[w]) {
      const m = this.makeWeaponMesh(w, 0.55);
      // camera space: -Z forward, +Y up, +X right. Weapon local +X forward => rotate so +X maps to -Z.
      const holder = new THREE.Group(); holder.add(m);
      m.rotation.y = -Math.PI / 2; // +X -> -Z
      holder.position.set(7, -6, -14); holder.rotation.y = -0.08;
      holder.visible = false; this.rig.add(holder); this.meshes[w] = holder;
    }
    return this.meshes[w];
  }
  setWeapon(w) { this.current = w; }
  fire(w) { this.recoil = 1; this.muzzleLight.color.setHex(COLORS[w] || 0xffffff); this.muzzleLight.intensity = w === WEAPONS.LIGHTNING ? 900 : 2200; this.muzzleLight.position.set(6, -4, -30); }
  update(p, view, now, dt, bobTime, bobAmt, camera) {
    for (const k in this.meshes) this.meshes[k].visible = false;
    if (view.dead || this.hidden) { this.muzzleLight.intensity = 0; return; }
    const w = p.weapon;
    const holder = this.ensure(w);
    holder.visible = true;
    // switching: drop / raise
    let drop = 0;
    if (p.weaponState === 'dropping') drop = 1 - Math.max(0, p.weaponTime) / WEAPON_DROP_TIME;
    else if (p.weaponState === 'raising') drop = Math.max(0, p.weaponTime) / WEAPON_RAISE_TIME;
    // sway from view angle deltas
    const yaw = view.angles[1], pitch = view.angles[0];
    let dy = yaw - this.lastYaw; if (dy > 180) dy -= 360; if (dy < -180) dy += 360;
    const dp = pitch - this.lastPitch; this.lastYaw = yaw; this.lastPitch = pitch;
    this.sway[0] += (-dy * 0.06 - this.sway[0]) * Math.min(1, dt * 12);
    this.sway[1] += (-dp * 0.06 - this.sway[1]) * Math.min(1, dt * 12);
    this.recoil *= Math.pow(0.0005, dt);
    const bx = Math.sin(bobTime) * 0.9 * bobAmt, by = Math.abs(Math.cos(bobTime)) * 0.5 * bobAmt;
    holder.position.set(7 + this.sway[0] + bx, -6 - drop * 12 + this.sway[1] - by, -14 + this.recoil * (w === WEAPONS.RAIL ? 5 : 3));
    holder.rotation.set(this.recoil * 0.25 - drop * 0.6, -0.08 + this.sway[0] * 0.02, 0);
    this.muzzleLight.intensity *= Math.pow(0.0001, dt);
  }
}
