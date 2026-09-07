// Q3-style item models: health spheres with a cross, armor shields, rotating weapon pickups, ammo boxes.
// Each item is a group with a bobbing/rotating model, a floor ring marker and (majors only) a fixed point light
// whose intensity is animated (never added/removed, so the scene's light count stays constant).
import * as THREE from 'three';
import { ITEMS } from '../../shared/constants.js';
import { makeWeaponMesh, weaponColor } from './weapons.js';

export const ITEM_COLORS = { health5: 0x7dff8f, health25: 0xffe24d, health50: 0xffa63a, mega: 0x3d8cff, armorShard: 0x9dffb0, armorYellow: 0xffd23a, armorRed: 0xff3d3d };

const MATS = {};
function shared(key, make) { return MATS[key] || (MATS[key] = make()); }

// Shield outline (Q3 armor icon silhouette), extruded.
function shieldGeometry(size) {
  const s = new THREE.Shape();
  const w = size, h = size * 1.15;
  s.moveTo(-w * 0.5, h * 0.45); s.lineTo(w * 0.5, h * 0.45); s.lineTo(w * 0.5, -h * 0.05);
  s.quadraticCurveTo(w * 0.5, -h * 0.4, 0, -h * 0.55); s.quadraticCurveTo(-w * 0.5, -h * 0.4, -w * 0.5, -h * 0.05); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: size * 0.25, bevelEnabled: true, bevelThickness: size * 0.05, bevelSize: size * 0.05, bevelSegments: 2 });
  g.center();
  return g;
}

export function makeItemModel(type) {
  const def = ITEMS[type];
  const color = ITEM_COLORS[type] || (def.weapon ? weaponColor(def.weapon) : 0xffffff);
  const model = new THREE.Group();
  if (def.kind === 'health') {
    const r = type === 'mega' ? 20 : type === 'health5' ? 8 : 13;
    const shell = shared('hshell' + type, () => new THREE.MeshPhysicalMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.45, transmission: 0, side: THREE.FrontSide, depthWrite: false }));
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), shell); sphere.renderOrder = 5;
    model.add(sphere);
    if (type !== 'health5') { // white cross inside the sphere
      const cm = shared('cross', () => new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.4 }));
      const t = r * 0.42, l = r * 1.3;
      const c1 = new THREE.Mesh(new THREE.BoxGeometry(t, l, t), cm), c2 = new THREE.Mesh(new THREE.BoxGeometry(t, t, l), cm);
      model.add(c1, c2);
    } else { model.add(new THREE.Mesh(new THREE.SphereGeometry(r * 0.45, 12, 8), shared('bubblecore', () => new THREE.MeshBasicMaterial({ color: 0xd0ffd8 })))); }
  } else if (def.kind === 'armor') {
    const s = type === 'armorShard' ? 7 : 18;
    const m = shared('armor' + color, () => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.45, roughness: 0.28, metalness: 0.85 }));
    if (type === 'armorShard') { const sh = new THREE.Mesh(new THREE.OctahedronGeometry(s, 0), m); sh.scale.set(0.6, 0.6, 1.4); model.add(sh); }
    else {
      const sh = new THREE.Mesh(shieldGeometry(s), m); sh.rotation.x = Math.PI / 2; model.add(sh);
      const rim = new THREE.Mesh(shieldGeometry(s * 1.12), shared('armorRim', () => new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.4, metalness: 0.9 }))); rim.rotation.x = Math.PI / 2; rim.position.y = 0; rim.scale.z = 0.6; model.add(rim);
      const boss = new THREE.Mesh(new THREE.SphereGeometry(s * 0.22, 12, 8), shared('armorBoss', () => new THREE.MeshBasicMaterial({ color: 0xffffff }))); boss.position.y = -s * 0.2; model.add(boss);
    }
  } else if (def.kind === 'weapon') {
    const wm = makeWeaponMesh(def.weapon, 1.0);
    wm.position.x = -8; // centre the barrel over the item origin
    model.add(wm);
  } else { // ammo: dark box with a coloured band and end caps
    const boxm = shared('ammoBox', () => new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.5, metalness: 0.7 }));
    const band = shared('ammoBand' + color, () => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.8, roughness: 0.4, metalness: 0.3 }));
    model.add(new THREE.Mesh(new THREE.BoxGeometry(16, 12, 12), boxm));
    const b = new THREE.Mesh(new THREE.BoxGeometry(16.6, 12.6, 4), band); model.add(b);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(2, 10, 10), band); cap.position.x = 8.5; model.add(cap);
  }
  return { model, color };
}

export class ItemView {
  constructor(scene, it, index) {
    this.def = ITEMS[it.type]; this.index = index; this.type = it.type;
    const { model, color } = makeItemModel(it.type);
    this.color = color; this.model = model;
    this.group = new THREE.Group(); this.group.position.set(it.origin[0], it.origin[1], it.origin[2]);
    this.group.add(model);
    // floor ring marker (item spots read from afar, like Q3's simple-item bases)
    const ringMat = shared('ring' + color, () => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.ring = new THREE.Mesh(shared('ringGeo', () => new THREE.RingGeometry(14, 19, 32)), ringMat);
    this.ring.position.z = (it.floorZ ?? (it.origin[2] - 20)) - it.origin[2] + 0.6;
    this.group.add(this.ring);
    this.light = null;
    if (this.def.major) { this.light = new THREE.PointLight(color, 3200, 300, 2); this.light.position.set(0, 0, 14); this.group.add(this.light); }
    this.group.userData.world = true;
    scene.add(this.group);
    this.available = true; this.respawnFlash = 0;
  }
  update(avail, t, now) {
    if (avail !== this.available) { this.available = avail; if (avail) this.respawnFlash = now; }
    this.model.visible = avail; this.ring.visible = avail;
    if (this.light) this.light.intensity = avail ? 3200 * (0.8 + 0.2 * Math.sin(t * 3 + this.index)) : 0;
    if (!avail) return;
    // Q3 autoAngles: one revolution every ~2 s, 4-unit bob
    this.model.rotation.z = (now % 2048) / 2048 * Math.PI * 2 + this.index;
    this.model.position.z = 4 + Math.sin(t * 2.5 + this.index) * 4;
    const k = Math.min(1, (now - this.respawnFlash) / 350);
    this.ring.scale.setScalar(1 + (1 - k) * 2.5);
    this.model.scale.setScalar(0.4 + 0.6 * k);
  }
}
