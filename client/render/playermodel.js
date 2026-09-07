// Remote player model: a stylized humanoid built from primitives (torso, head, legs, weapon), animated by velocity.
import * as THREE from 'three';
import { WEAPONS } from '../../shared/constants.js';
import { weaponColor } from './renderer.js';

export class PlayerModel {
  constructor(scene, color) {
    this.scene = scene;
    this.group = new THREE.Group();
    const armor = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.5, emissive: color, emissiveIntensity: 0.25 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1d24, roughness: 0.7, metalness: 0.3 });
    this.torso = new THREE.Mesh(new THREE.BoxGeometry(18, 26, 26), armor); this.torso.position.z = 6; this.torso.castShadow = true;
    this.head = new THREE.Mesh(new THREE.SphereGeometry(8, 16, 12), new THREE.MeshStandardMaterial({ color: 0xe8d8c0, roughness: 0.6, emissive: color, emissiveIntensity: 0.1 })); this.head.position.z = 26; this.head.castShadow = true;
    this.visor = new THREE.Mesh(new THREE.BoxGeometry(6, 12, 3), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: 2.5 })); this.visor.position.set(6, 0, 27);
    this.legL = new THREE.Mesh(new THREE.BoxGeometry(9, 9, 24), dark); this.legL.position.set(0, -6, -12);
    this.legR = new THREE.Mesh(new THREE.BoxGeometry(9, 9, 24), dark); this.legR.position.set(0, 6, -12);
    this.armL = new THREE.Mesh(new THREE.BoxGeometry(7, 7, 22), dark); this.armL.position.set(4, -16, 8);
    this.armR = new THREE.Mesh(new THREE.BoxGeometry(7, 7, 22), dark); this.armR.position.set(4, 16, 8);
    this.weapon = new THREE.Mesh(new THREE.BoxGeometry(26, 6, 6), new THREE.MeshStandardMaterial({ color: 0x777777, metalness: 0.8, roughness: 0.3 })); this.weapon.position.set(16, 10, 10);
    this.weaponGlow = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 4), new THREE.MeshBasicMaterial({ color: 0xffffff })); this.weaponGlow.position.set(28, 10, 10);
    this.upper = new THREE.Group(); this.upper.add(this.torso, this.head, this.visor, this.armL, this.armR, this.weapon, this.weaponGlow);
    this.group.add(this.upper, this.legL, this.legR);
    this.light = { intensity: 0 }; // no dynamic light: emissive visor/armor carry the read
    scene.add(this.group);
    this.cycle = 0; this.dead = false; this.deadAt = 0; this.color = color;
  }
  update(origin, angles, r, now, dt) {
    this.group.position.set(origin[0], origin[1], origin[2]);
    const yaw = angles[1] * Math.PI / 180;
    const dead = !!r.d;
    if (dead && !this.dead) { this.deadAt = now; }
    this.dead = dead;
    if (dead) {
      // fall over
      const t = Math.min(1, (now - this.deadAt) / 250);
      this.group.rotation.set(0, (Math.PI / 2) * t, yaw);
      this.group.position.z = origin[2] - 16 * t;
      this.light.intensity = 0;
      return;
    }
    this.group.rotation.set(0, 0, yaw);
    this.upper.rotation.y = angles[0] * Math.PI / 180 * 0.5; // slight torso pitch
    const v = r.v || [0, 0, 0];
    const speed = Math.hypot(v[0], v[1]);
    const ground = !!r.g;
    if (ground && speed > 30) this.cycle += dt * speed * 0.03; else if (!ground) this.cycle += dt * 3;
    const swing = ground ? Math.sin(this.cycle) * Math.min(1, speed / 320) * 0.7 : 0.35;
    this.legL.rotation.y = swing; this.legR.rotation.y = -swing;
    const ducked = (r.pf & 1) !== 0;
    this.upper.position.z = ducked ? -12 : 0;
    this.weaponGlow.material.color.setHex(weaponColor(r.w));
    this.light.intensity = 1200;
  }
  dispose() { this.scene.remove(this.group); }
}
