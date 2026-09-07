// Visual effects: explosions, rail trails, lightning beams, impacts, blood, gibs, projectiles (server + predicted).
import * as THREE from 'three';
import { WEAPONS, WEAPON_DEFS, EV } from '../../shared/constants.js';
import { ma, normalize, sub, dist } from '../../shared/vec3.js';
import { LightPool } from './lightpool.js';

const C = { [WEAPONS.ROCKET]: 0xff6a3a, [WEAPONS.RAIL]: 0x5cff9d, [WEAPONS.LIGHTNING]: 0xbfe8ff, [WEAPONS.SHOTGUN]: 0xffc86a, [WEAPONS.PLASMA]: 0xb26cff, [WEAPONS.MACHINEGUN]: 0xffe680 };

export class Effects {
  constructor(scene) {
    this.scene = scene; this.list = []; this.fakes = [];
    this.pool = new LightPool(scene, 14);
    this.smokeMat = new THREE.SpriteMaterial({ color: 0x333333, transparent: true, opacity: 0.5, depthWrite: false });
    this.fireMat = new THREE.SpriteMaterial({ color: 0xffa040, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    this.sparkGeo = new THREE.BoxGeometry(2, 2, 2);
    this.decals = [];
  }
  add(fx) { fx.t0 = performance.now(); this.list.push(fx); return fx; }
  // Pooled light flash: borrows a light for `life` ms with a decay curve.
  flash(origin, color, intensity, distance, life, curve = (k) => 1 - k) {
    const l = this.pool.acquire(color, intensity, distance);
    l.position.set(origin[0], origin[1], origin[2]);
    const fx = { life, obj: null, light: l, upd: (k) => { l.intensity = intensity * curve(k); } };
    l.userData.release = () => { fx.dead = true; };
    return this.add(fx);
  }

  event(e, cg, r) {
    switch (e.type) {
      case EV.EXPLODE: this.explosion(e.origin, e.normal, e.weapon); break;
      case EV.RAIL_TRAIL: this.railTrail(e.start, e.end, e.id === cg.localId); break;
      case EV.LG_HIT: this.lgHit(e.origin, e.world); break;
      case EV.BULLET_IMPACT: this.impact(e.origin, e.normal, e.weapon); break;
      case EV.PAIN: if (e.id !== cg.localId || true) this.blood(e.origin, e.damage); break;
      case EV.DEATH: if (e.gib) this.gibs(e.origin); break;
      case EV.FIRE: if (e.id === cg.localId) this.localFire(e, cg); else this.remoteMuzzle(e); break;
      case EV.JUMPPAD: this.padBurst(e.origin); break;
      case EV.TELEPORT: this.teleFlash(e.origin); break;
      case EV.RESPAWN: this.teleFlash(e.origin); break;
      case EV.PICKUP: this.pickupFlash(e.origin); break;
    }
  }

  // Local fire: instant fake projectile so rockets appear with zero latency; replaced by the server's when it arrives.
  localFire(e, cg) {
    const wd = WEAPON_DEFS[e.weapon];
    if (wd.projectile) {
      const origin = ma(e.origin, 14, e.dir);
      const m = this.makeProjectile(e.weapon, true, { seq: e.seq });
      this.fakes.push({ seq: e.seq, mesh: m, origin, velocity: [e.dir[0] * wd.speed, e.dir[1] * wd.speed, e.dir[2] * wd.speed], t0: performance.now() });
    }
  }
  remoteMuzzle(e) {
    this.flash(e.origin, C[e.weapon] || 0xffffff, 3000, 300, 80);
  }
  updateFakeProjectiles(cg, seenPr, projectiles, now, dt) {
    // if the server projectile with the same owner+seq is present, drop the fake
    const serverSeqs = new Set((cg.remoteProjectiles || []).filter((p) => p.ow === cg.localId).map((p) => p.sq));
    for (const f of [...this.fakes]) {
      if (serverSeqs.has(f.seq) || now - f.t0 > 1500) { f.mesh.dispose(); this.fakes.splice(this.fakes.indexOf(f), 1); continue; }
      f.origin = ma(f.origin, dt, f.velocity);
      f.mesh.update(f.origin, f.velocity, now, dt);
    }
  }

  makeProjectile(type, own, pr) {
    const scene = this.scene;
    const g = new THREE.Group();
    const color = C[type] || 0xffffff;
    if (type === WEAPONS.ROCKET) {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 18, 10), new THREE.MeshStandardMaterial({ color: 0x444a55, metalness: 0.8, roughness: 0.4 })); body.rotation.z = Math.PI / 2; g.add(body);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(3, 6, 10), new THREE.MeshStandardMaterial({ color: 0xff3a1a, emissive: 0xff3a1a, emissiveIntensity: 1 })); tip.rotation.z = -Math.PI / 2; tip.position.x = 12; g.add(tip);
      const flame = new THREE.Sprite(this.fireMat.clone()); flame.scale.set(14, 14, 1); flame.position.x = -12; g.add(flame);
      g.userData.flame = flame; g.userData.light = this.pool.acquire(0xff7a3a, 8000, 500);
    } else if (type === WEAPONS.PLASMA) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(6, 12, 10), new THREE.MeshBasicMaterial({ color: 0xd8b0ff })); g.add(ball);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xb26cff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })); glow.scale.set(22, 22, 1); g.add(glow);
      g.userData.light = this.pool.acquire(0xb26cff, 3000, 300);
    }
    scene.add(g);
    let lastSmoke = 0;
    const self = this;
    return {
      group: g,
      update(origin, v, now, dt) {
        g.position.set(origin[0], origin[1], origin[2]);
        if (g.userData.light) g.userData.light.position.set(origin[0], origin[1], origin[2]);
        const d = normalize(v); const yaw = Math.atan2(d[1], d[0]); const pitch = -Math.asin(Math.max(-1, Math.min(1, d[2])));
        g.rotation.set(0, pitch, yaw, 'ZYX');
        if (type === WEAPONS.ROCKET) {
          g.userData.flame.material.opacity = 0.7 + Math.random() * 0.3; g.userData.flame.scale.setScalar(12 + Math.random() * 6);
          if (now - lastSmoke > 22) { lastSmoke = now; self.smoke(origin, 6, 700, 0.35); }
        }
      },
      dispose() { scene.remove(g); if (g.userData.light) self.pool.release(g.userData.light); },
    };
  }

  smoke(origin, size, life, opacity, vel = null) {
    const s = new THREE.Sprite(this.smokeMat.clone()); s.material.opacity = opacity; s.position.set(...origin); s.scale.setScalar(size); this.scene.add(s);
    const v = vel || [(Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, 20 + Math.random() * 20];
    this.add({ life, obj: s, upd: (k, dt) => { s.position.x += v[0] * dt; s.position.y += v[1] * dt; s.position.z += v[2] * dt; s.scale.setScalar(size * (1 + k * 3)); s.material.opacity = opacity * (1 - k); } });
  }
  explosion(origin, normal, weapon) {
    const big = weapon === WEAPONS.ROCKET;
    const o = ma(origin, big ? 6 : 2, normal);
    // flash sprite
    const flash = new THREE.Sprite(this.fireMat.clone()); flash.position.set(...o); flash.scale.setScalar(big ? 40 : 14); this.scene.add(flash);
    this.add({ life: big ? 420 : 200, obj: flash, upd: (k) => { flash.scale.setScalar((big ? 40 : 14) * (1 + k * 3.2)); flash.material.opacity = 1 - k; flash.material.color.setHSL(0.08 - k * 0.06, 1, 0.6 - k * 0.3); } });
    // core sphere
    const core = new THREE.Mesh(new THREE.SphereGeometry(big ? 28 : 8, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffd090, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })); core.position.set(...o); this.scene.add(core);
    this.add({ life: big ? 260 : 120, obj: core, upd: (k) => { core.scale.setScalar(1 + k * 2.2); core.material.opacity = 0.9 * (1 - k); } });
    // light
    this.flash(ma(o, 8, normal), big ? 0xff8a40 : 0xd8a0ff, big ? 60000 : 12000, big ? 900 : 300, big ? 380 : 160, (k) => Math.pow(1 - k, 1.5));
    // sparks
    const n = big ? 26 : 8;
    for (let i = 0; i < n; i++) {
      const sp = new THREE.Mesh(this.sparkGeo, new THREE.MeshBasicMaterial({ color: big ? 0xffb060 : 0xd8b0ff })); sp.position.set(...o); this.scene.add(sp);
      const dir = normalize([(Math.random() - 0.5) + normal[0] * 0.6, (Math.random() - 0.5) + normal[1] * 0.6, (Math.random() - 0.5) + normal[2] * 0.6]);
      const spd = (big ? 250 : 120) + Math.random() * (big ? 400 : 150);
      const v = [dir[0] * spd, dir[1] * spd, dir[2] * spd];
      this.add({ life: 500 + Math.random() * 500, obj: sp, upd: (k, dt) => { v[2] -= 800 * dt; sp.position.x += v[0] * dt; sp.position.y += v[1] * dt; sp.position.z += v[2] * dt; sp.scale.setScalar(1 - k); } });
    }
    if (big) { for (let i = 0; i < 6; i++) this.smoke(ma(o, Math.random() * 12, normal), 26 + Math.random() * 14, 1300 + Math.random() * 600, 0.45); }
    // scorch decal
    if (big) this.decal(o, normal, 60, 0x000000, 0.7, 20000);
  }
  decal(origin, normal, size, color, opacity, life) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(size / 2, 20), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.position.set(...ma(origin, 0.5, normal)); m.lookAt(m.position.x + normal[0], m.position.y + normal[1], m.position.z + normal[2]); this.scene.add(m);
    this.add({ life, obj: m, upd: (k) => { m.material.opacity = opacity * (1 - Math.max(0, (k - 0.7) / 0.3)); } });
  }
  railTrail(start, end, own) {
    const d = sub(end, start); const len = Math.max(1, dist(start, end)); const dir = normalize(d);
    const mid = ma(start, len / 2, dir);
    const geo = new THREE.CylinderGeometry(1.4, 1.4, len, 8, 1, true);
    const core = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
    const halo = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, len, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0x5cff9d, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    const g = new THREE.Group(); g.add(core, halo); g.position.set(...mid);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...dir)); this.scene.add(g);
    // spiral (Q3 rail rings)
    const pts = []; const n = Math.floor(len / 10); for (let i = 0; i < n; i++) { const a = i * 0.9; pts.push(new THREE.Vector3(Math.cos(a) * 5, -len / 2 + i * 10, Math.sin(a) * 5)); }
    const spiral = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x8fffc4, transparent: true, opacity: 0.9 })); g.add(spiral);
    this.add({ life: 800, obj: g, upd: (k) => { core.material.opacity = 1 - k; halo.material.opacity = 0.55 * (1 - k); spiral.material.opacity = 0.9 * (1 - k); halo.scale.set(1 + k * 1.5, 1, 1 + k * 1.5); } });
    this.impact(end, normalize(sub(start, end)), WEAPONS.RAIL);
  }
  lgHit(origin, world) {
    this.flash(origin, 0xbfe8ff, 6000, 240, 70);
    for (let i = 0; i < 3; i++) {
      const sp = new THREE.Mesh(this.sparkGeo, new THREE.MeshBasicMaterial({ color: 0xdff4ff })); sp.position.set(...origin); this.scene.add(sp);
      const v = [(Math.random() - 0.5) * 300, (Math.random() - 0.5) * 300, Math.random() * 250];
      this.add({ life: 250, obj: sp, upd: (k, dt) => { v[2] -= 800 * dt; sp.position.x += v[0] * dt; sp.position.y += v[1] * dt; sp.position.z += v[2] * dt; } });
    }
  }
  impact(origin, normal, weapon) {
    const color = C[weapon] || 0xffffff;
    this.flash(ma(origin, 4, normal), color, 2500, 160, 120);
    const n = weapon === WEAPONS.RAIL ? 10 : 4;
    for (let i = 0; i < n; i++) {
      const sp = new THREE.Mesh(this.sparkGeo, new THREE.MeshBasicMaterial({ color })); sp.position.set(...origin); this.scene.add(sp);
      const dir = normalize([normal[0] + (Math.random() - 0.5) * 1.2, normal[1] + (Math.random() - 0.5) * 1.2, normal[2] + (Math.random() - 0.5) * 1.2]);
      const spd = 100 + Math.random() * 200; const v = [dir[0] * spd, dir[1] * spd, dir[2] * spd];
      this.add({ life: 300 + Math.random() * 300, obj: sp, upd: (k, dt) => { v[2] -= 800 * dt; sp.position.x += v[0] * dt; sp.position.y += v[1] * dt; sp.position.z += v[2] * dt; sp.scale.setScalar(1 - k); } });
    }
    this.decal(origin, normal, weapon === WEAPONS.RAIL ? 14 : 6, 0x000000, 0.6, 15000);
  }
  blood(origin, damage) {
    const n = Math.min(14, 3 + Math.floor(damage / 8));
    for (let i = 0; i < n; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xa01010, transparent: true, opacity: 0.85, depthWrite: false })); s.position.set(origin[0], origin[1], origin[2] + 8); s.scale.setScalar(4 + Math.random() * 6); this.scene.add(s);
      const v = [(Math.random() - 0.5) * 220, (Math.random() - 0.5) * 220, Math.random() * 180];
      this.add({ life: 450, obj: s, upd: (k, dt) => { v[2] -= 800 * dt; s.position.x += v[0] * dt; s.position.y += v[1] * dt; s.position.z += v[2] * dt; s.material.opacity = 0.85 * (1 - k); } });
    }
  }
  gibs(origin) {
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(5 + Math.random() * 5, 5 + Math.random() * 5, 5 + Math.random() * 5), new THREE.MeshStandardMaterial({ color: 0x8a1212, roughness: 0.8 })); m.position.set(origin[0], origin[1], origin[2] + 10); this.scene.add(m);
      const v = [(Math.random() - 0.5) * 500, (Math.random() - 0.5) * 500, 150 + Math.random() * 350]; const r = [(Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, 0];
      this.add({ life: 2500, obj: m, upd: (k, dt) => { v[2] -= 800 * dt; m.position.x += v[0] * dt; m.position.y += v[1] * dt; m.position.z += v[2] * dt; m.rotation.x += r[0] * dt; m.rotation.y += r[1] * dt; if (m.position.z < origin[2] - 22) { m.position.z = origin[2] - 22; v[0] *= 0.6; v[1] *= 0.6; v[2] = -v[2] * 0.3; r[0] *= 0.5; r[1] *= 0.5; } } });
    }
    this.blood(origin, 120);
  }
  padBurst(origin) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(10, 16, 24), new THREE.MeshBasicMaterial({ color: 0x4ab3ff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })); ring.position.set(origin[0], origin[1], origin[2] - 22); this.scene.add(ring);
    this.add({ life: 350, obj: ring, upd: (k) => { ring.scale.setScalar(1 + k * 3); ring.material.opacity = 0.8 * (1 - k); } });
  }
  teleFlash(origin) {
    this.flash([origin[0], origin[1], origin[2] + 10], 0xbfa0ff, 20000, 400, 400);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xd0c0ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })); s.position.set(origin[0], origin[1], origin[2] + 4); s.scale.set(40, 70, 1); this.scene.add(s);
    this.add({ life: 400, obj: s, upd: (k) => { s.material.opacity = 0.9 * (1 - k); s.scale.set(40 * (1 + k), 70 * (1 + k * 0.5), 1); } });
  }
  pickupFlash(origin) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false })); s.position.set(...origin); s.scale.setScalar(24); this.scene.add(s);
    this.add({ life: 250, obj: s, upd: (k) => { s.material.opacity = 0.8 * (1 - k); s.scale.setScalar(24 * (1 + k * 2)); } });
  }
  update(now, dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const fx = this.list[i];
      const k = (now - fx.t0) / fx.life;
      if (k >= 1 || fx.dead) { if (fx.obj) { this.scene.remove(fx.obj); if (fx.obj.geometry) fx.obj.geometry.dispose?.(); } if (fx.light && !fx.dead) this.pool.release(fx.light); this.list.splice(i, 1); continue; }
      fx.upd(k, dt);
    }
  }
}
