// First-person weapon viewmodel. Lives in its own scene + camera (fixed 90-degree horizontal FOV like Q3's
// weapon rendering, independent of the player's FOV) rendered after the world with the depth buffer cleared, so
// the gun never clips into walls. Position is low-right, barrel forward, with Q3-style bob, sway, idle drift,
// per-weapon recoil (rail: hard kick + slow slide back, RL: kick + climb, MG: rattle, SG: kick + pump cycle with the
// left hand riding the pump, gauntlet: lunge), a drop / raise switch animation driven by the simulation's weapon
// state, per-weapon 3-frame muzzle flash sprites (the 'muzzle' sheet), an LG core that blazes and an arc that crawls
// along the rods while the beam is on, a rail coil that charges after a shot, a plasma core that pulses and a
// gauntlet blade that spins up with a motion-blur ring. Both arms are built per weapon with a hand posed on its
// grip and, for two-handed weapons, a second hand under the fore-end. Live parts use this instance's own materials.
import * as THREE from 'three';
import { WEAPONS, WEAPON_DROP_TIME, WEAPON_RAISE_TIME, playerColorHex } from '../../shared/constants.js';
import { makeWeaponMesh, weaponColor } from './weapons.js';
import { skinMaterials, skinFor, SKIN_NAMES } from './playermodel.js';
import { getSheet, MUZZLE_ROW, MUZZLE_FRAMES } from './particles.js';
import { bladeBlur, flashFrame, switchDrop } from './anim.js';

const SCALE = 0.46;
// per-weapon scale on top of SCALE: the fat RL tube and the tall LG (rings + rods) would otherwise exceed the 25%
// screen-height budget that keeps the gun out of the way
const WEAPON_SCALE = { [WEAPONS.ROCKET]: 0.76, [WEAPONS.LIGHTNING]: 0.88, [WEAPONS.RAIL]: 0.9, [WEAPONS.PLASMA]: 0.9, [WEAPONS.GAUNTLET]: 1.1 };
// rest pose in camera space (+X right, +Y up, -Z forward): low-right, ~20% of screen height at the 90-degree weapon FOV
// Q3 cg_gun placement: the weapon sits low-right and close enough that its stock exits the frame at the bottom-right
// corner, held by a forearm that also runs off-screen, so it never reads as a gun floating in mid-air.
const REST = new THREE.Vector3(11.5, -12.5, -33);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _f = new THREE.Vector3(), _c = new THREE.Color();
const KICK = { [WEAPONS.RAIL]: 2.6, [WEAPONS.ROCKET]: 2.0, [WEAPONS.SHOTGUN]: 1.8, [WEAPONS.PLASMA]: 0.5, [WEAPONS.MACHINEGUN]: 0.45, [WEAPONS.LIGHTNING]: 0.15, [WEAPONS.GAUNTLET]: -3.5 };
const FLASH_MS = { [WEAPONS.LIGHTNING]: 70, [WEAPONS.RAIL]: 150, [WEAPONS.ROCKET]: 90, [WEAPONS.SHOTGUN]: 90, [WEAPONS.PLASMA]: 60, [WEAPONS.MACHINEGUN]: 55 };
const FLASH_SIZE = { [WEAPONS.ROCKET]: 9, [WEAPONS.RAIL]: 7, [WEAPONS.SHOTGUN]: 8.5, [WEAPONS.LIGHTNING]: 3.2, [WEAPONS.PLASMA]: 4.5, [WEAPONS.MACHINEGUN]: 4.8 };
// hand positions in weapon-local units (+X forward, +Z up, +Y left): [right hand on the grip, left hand under the fore-end | null]
const GRIPS = {
  [WEAPONS.ROCKET]: [[2.5, 0, -18], [16, 0, -7.5]], [WEAPONS.RAIL]: [[-3.5, 0, -13], [10, 0, -3.5]], [WEAPONS.LIGHTNING]: [[-1.5, 0, -15], [8, 0, -6.5]],
  [WEAPONS.SHOTGUN]: [[-8, 0, -9.5], [13, 0, -7.6]], [WEAPONS.PLASMA]: [[0.5, 0, -13], [12, 0, -6]], [WEAPONS.MACHINEGUN]: [[-5.5, 0, -12], [10, 0, -4.8]], [WEAPONS.GAUNTLET]: [[-13.5, 0, 0], null],
};

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
    // muzzle flash: one sprite material per weapon, each a window onto that weapon's row of the 'muzzle' sheet
    // (3 frames, played over FLASH_MS by sliding the texture offset); one sprite shows the active weapon's material
    const sh = getSheet('muzzle');
    this.flashMats = {};
    for (const w in MUZZLE_ROW) {
      const t = sh.tex.clone(); t.repeat.set(1 / sh.cols, 1 / sh.rows); t.offset.set(0, (sh.rows - 1 - MUZZLE_ROW[w]) / sh.rows); t.needsUpdate = true;
      this.flashMats[w] = new THREE.SpriteMaterial({ color: 0xffffff, map: t, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
    }
    this.flashSprite = new THREE.Sprite(this.flashMats[WEAPONS.MACHINEGUN]); this.flashSprite.renderOrder = 30; this.rig.add(this.flashSprite);
    this.meshes = {};
    this.current = 0; this.recoil = 0; this.slide = 0; this.climb = 0; this.sway = [0, 0]; this.lastYaw = 0; this.lastPitch = 0; this.flashUntil = 0; this.flashAt = -1e9; this.flashLife = 0; this.hidden = false;
    this.firingUntil = 0; this.lastFireAt = -1e9; this.lastFireWeapon = 0; this.railCharge = 0; this.bladeSpin = 0; this.bladeAngle = 0; this.pumpAt = -1e9; this.arcPhase = 0;
    this.muzzle = new THREE.Object3D(); this.rig.add(this.muzzle);
    this.armMats = skinMaterials('sarge', 0x4ab3ff); this.armSkin = 'sarge'; this.armColor = 0x4ab3ff;
  }
  // The arms wear the local player's skin and colour (the chosen ones from the snapshot, else the name-derived skin
  // and the default blue), the same materials as the third-person model.
  setSkin(skin, color) {
    if (skin === this.armSkin && color === this.armColor) return;
    this.armSkin = skin; this.armColor = color; this.armMats = skinMaterials(skin, color);
    for (const k in this.meshes) { this.rig.remove(this.meshes[k]); delete this.meshes[k]; }
  }
  ensure(w) {
    if (!this.meshes[w]) {
      const s = SCALE * (WEAPON_SCALE[w] || 1);
      const m = makeWeaponMesh(w, s, { live: true });
      // weapon local +X forward -> camera -Z forward; +Z up -> +Y up; +Y left -> -X (mirror keeps it right-handed)
      const holder = new THREE.Group(); holder.add(m);
      m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)));
      holder.userData.muzzle = new THREE.Vector3(...m.userData.muzzle).applyQuaternion(m.quaternion);
      holder.userData.model = m; holder.userData.scale = s;
      // first-person arms in holder space (+X right, +Y up, -Z forward): the right forearm runs from the grip toward
      // the bottom-right corner (off-screen) with a gloved hand closed on the grip; two-handed weapons get a left hand
      // under the fore-end with its forearm leaving the frame bottom-left. The gauntlet is the forearm itself.
      const arms = new THREE.Group(); holder.add(arms); holder.userData.arms = arms;
      const local = (p) => new THREE.Vector3(-p[1] * s, p[2] * s, -p[0] * s); // weapon-local -> holder
      const grips = GRIPS[w] || GRIPS[WEAPONS.MACHINEGUN];
      const M = this.armMats;
      const mesh = (g, mat, pos, rot = [0, 0, 0]) => { const o = new THREE.Mesh(g, mat); o.position.copy(pos); o.rotation.set(rot[0], rot[1], rot[2]); arms.add(o); return o; };
      // forearm: the skin's armour sleeve (stripe and all, like the Q3 model's arms) with a light-metal cuff at the
      // wrist and a bevel plate along the outside
      const forearm = (parent, from, to, r1, r2) => {
        const dir = to.clone().normalize(), len = to.length();
        const fore = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, 10), M.armor); fore.position.copy(from).addScaledVector(to, 0.5); fore.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir); parent.add(fore);
        const cuff = new THREE.Mesh(new THREE.CylinderGeometry(r1 + 0.5, r1 + 0.6, 2.2, 10), M.plate); cuff.position.copy(from).addScaledVector(to, 0.16); cuff.quaternion.copy(fore.quaternion); parent.add(cuff);
        const plate = new THREE.Mesh(new THREE.BoxGeometry(r1 * 1.5, len * 0.4, 1.0), M.plate); plate.position.copy(from).addScaledVector(to, 0.55).add(new THREE.Vector3(0, 0, r1 * 0.8)); plate.quaternion.copy(fore.quaternion); parent.add(plate);
      };
      const gripR = local(grips[0]);
      if (w === WEAPONS.GAUNTLET) { forearm(arms, gripR, new THREE.Vector3(9, -11, 13), 2.3, 2.7); }
      else {
        // right hand: a dark glove closed on the grip - palm on the near (+X) side, four fingers across the front,
        // thumb hooked over the far side - with a light knuckle plate; the forearm leaves from the wrist to the corner
        const gm = M.suit;
        mesh(new THREE.BoxGeometry(1.7, 4.2, 3.2), gm, gripR.clone().add(new THREE.Vector3(1.45, 0.1, 0.1)), [0.1, 0, -0.1]);
        for (let i = 0; i < 4; i++) mesh(new THREE.BoxGeometry(3.6, 0.95, 1.1), gm, gripR.clone().add(new THREE.Vector3(0.35, 1.55 - i * 1.05, -1.55)), [0, 0, -0.08]);
        mesh(new THREE.BoxGeometry(1.0, 1.0, 2.6), gm, gripR.clone().add(new THREE.Vector3(-1.2, 1.9, 0.2)), [0.3, 0, 0.4]);
        mesh(new THREE.BoxGeometry(1.2, 2.6, 2.2), M.plate, gripR.clone().add(new THREE.Vector3(2.35, 0.6, 0.1)), [0.1, 0, -0.1]);
        forearm(arms, gripR.clone().add(new THREE.Vector3(1.6, -1.4, 1.2)), new THREE.Vector3(9.5, -11, 12), 1.9, 2.4);
        if (grips[1]) { // left hand cupped under the fore-end: palm below, fingers curling up the far side, thumb on the near side
          const gl = local(grips[1]);
          const lhand = new THREE.Group(); lhand.position.copy(gl); arms.add(lhand); holder.userData.lhand = lhand;
          const lm = (g, mat, p, rot = [0, 0, 0]) => { const o = new THREE.Mesh(g, mat); o.position.set(p[0], p[1], p[2]); o.rotation.set(rot[0], rot[1], rot[2]); lhand.add(o); };
          lm(new THREE.BoxGeometry(4.4, 1.8, 3.8), gm, [0, -0.95, 0], [0.05, 0.2, 0.05]);
          for (let i = 0; i < 4; i++) lm(new THREE.BoxGeometry(1.0, 3.0, 0.95), gm, [-2.45, 0.6, -1.45 + i * 0.97], [0, 0, -0.25]);
          lm(new THREE.BoxGeometry(1.0, 2.4, 1.0), gm, [2.3, 0.3, 0.4], [0, 0, 0.35]);
          lm(new THREE.BoxGeometry(2.4, 1.0, 2.2), M.plate, [0, -1.95, 0.2], [0.05, 0.2, 0.05]);
          forearm(lhand, new THREE.Vector3(0.4, -1.6, 0.6), new THREE.Vector3(-3.5, -13, 7.5), 1.7, 2.2);
        }
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
    this.flashAt = now; this.flashLife = FLASH_MS[w] || 0; this.flashUntil = now + this.flashLife;
    this.flashSize = FLASH_SIZE[w] || 4;
    if (this.flashMats[w]) { this.flashSprite.material = this.flashMats[w]; this.flashMats[w].rotation = w === WEAPONS.RAIL || w === WEAPONS.PLASMA ? 0 : Math.random() * 6.28; }
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
    for (const k in this.flashMats) this.flashMats[k].opacity = 0;
    if (view.dead || this.hidden) { this.muzzleLight.intensity = 0; return; }
    const w = p.weapon;
    if (p.name) this.setSkin(p.skin && SKIN_NAMES.includes(p.skin) ? p.skin : skinFor(p.name, p.id), playerColorHex(p.color, 0x4ab3ff));
    const holder = this.ensure(w);
    holder.visible = true;
    const model = holder.userData.model, live = model.userData.live;
    const firing = now < this.firingUntil;
    // switching: the gun swings down and to the right out of the frame (drop), then back up (raise)
    const drop = switchDrop(p.weaponState, p.weaponTime, WEAPON_DROP_TIME, WEAPON_RAISE_TIME);
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
    holder.position.set(REST.x + drop * 3 + this.sway[0] + bx + ix + rx, REST.y - drop * 11 + this.sway[1] + by + iy - land * 0.3 + this.climb * 0.6 + ry, REST.z + kick + drop * 2);
    // barrel converges slightly toward the crosshair (+yaw turns the muzzle left, toward the screen centre); recoil pitches it up
    holder.rotation.set(this.recoil * 0.12 + this.climb * 0.1 + this.slide * 0.05 - drop * 1.1 + this.sway[1] * 0.02, 0.07 + this.sway[0] * 0.03 + this.recoil * 0.03 - drop * 0.25, this.sway[0] * 0.02 - this.recoil * 0.04 - drop * 0.3);
    // --- per-weapon live parts ---
    if (model.userData.blade) { // gauntlet: the blade spins up while the trigger is held, freewheels down after; the blur ring fades in with the spin
      const want = p.attackHeld ? 16 : 0; // 16 rad/s: 2.5 turns a second reads as a spin at 60 fps (40 strobed against the 14 teeth)
      this.bladeSpin += (want - this.bladeSpin) * Math.min(1, dt * (p.attackHeld ? 6 : 1.5));
      this.bladeAngle += this.bladeSpin * dt; model.userData.blade.rotation.y = this.bladeAngle;
      const blur = model.userData.blur; blur.material.opacity = bladeBlur(this.bladeSpin) * 0.62; blur.rotation.y = this.bladeAngle * 0.31; blur.visible = blur.material.opacity > 0.01;
    }
    if (model.userData.pump) { // shotgun: pump cycles back and forward ~180 ms after the shot, the left hand rides it
      const t = (now - this.pumpAt) / 320; const s = t > 0 && t < 1 ? Math.sin(t * Math.PI) : 0;
      model.userData.pump.position.x = 13 - s * 5;
      if (holder.userData.lhand) holder.userData.lhand.position.z = -GRIPS[w][1][0] * holder.userData.scale + s * 5 * holder.userData.scale;
    }
    if (model.userData.arc) { // lightning: a bright arc ring crawls along the rods (with jitter) while the beam is on
      const arc = model.userData.arc; arc.visible = firing;
      if (firing) { this.arcPhase = (this.arcPhase + dt * 5.5) % 1; arc.position.set(-2 + this.arcPhase * 24, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2); const sc = 0.85 + Math.random() * 0.35; arc.scale.set(sc, sc, 1); }
    }
    if (live) {
      if (w === WEAPONS.LIGHTNING) { // core pulses at rest, blazes while the beam is on
        const pulse = 0.55 + 0.25 * Math.sin(now * 0.012), hot = firing ? 1 : 0;
        live.core.color.setHex(0xbfe8ff).lerp(_c.setHex(0xffffff), hot * 0.8).multiplyScalar(pulse + hot * 1.2);
        live.coil.emissiveIntensity = 0.6 + hot * 1.6 + (firing ? Math.random() * 0.5 : 0);
      } else if (w === WEAPONS.RAIL) { // coil charge glow after a shot, sinking back over ~1 s
        live.coil.emissiveIntensity = 0.6 + this.railCharge * 2.6;
        live.core.color.setHex(0x5cff9d).multiplyScalar(0.8 + this.railCharge * 2);
      } else if (w === WEAPONS.PLASMA) { live.core.color.setHex(0xe8d0ff).multiplyScalar(0.9 + 0.2 * Math.sin(now * 0.02) + (firing ? 0.8 : 0)); live.coil.emissiveIntensity = 0.6 + (firing ? 0.8 : 0) + 0.15 * Math.sin(now * 0.02); }
      else if (w === WEAPONS.GAUNTLET) { live.core.color.setHex(0xff9a5c).multiplyScalar(0.8 + this.bladeSpin / 16 * 1.2); live.coil.emissiveIntensity = 0.6 + this.bladeSpin / 16 * 0.8; }
    }
    // muzzle point follows the active weapon
    const mz = holder.userData.muzzle;
    this.muzzle.position.copy(holder.position).add(_v.copy(mz).applyEuler(holder.rotation));
    this.muzzleLight.position.copy(this.muzzle.position);
    this.flashSprite.position.copy(this.muzzle.position);
    // muzzle flash: 3 frames over the flash life, flickering
    const frame = flashFrame(now - this.flashAt, this.flashLife, MUZZLE_FRAMES);
    if (frame >= 0 && this.flashMats[this.lastFireWeapon]) {
      const m = this.flashMats[this.lastFireWeapon];
      m.map.offset.x = frame / MUZZLE_FRAMES;
      m.color.setHex(weaponColor(this.lastFireWeapon)).lerp(_c.setHex(0xffffff), 0.7);
      m.opacity = 0.85 + Math.random() * 0.15;
      const s = this.flashSize * (0.9 + Math.random() * 0.25); this.flashSprite.scale.set(s, s, 1);
    }
    this.muzzleLight.intensity *= Math.pow(0.0002, dt);
  }
}
