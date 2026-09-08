// Visual effects: explosions, rail trails, lightning beams, impacts, blood, gibs, projectiles (server + predicted),
// jump pads, teleporters, muzzle flashes. Particles go through instanced pools (one draw call per pool), lights
// through the fixed LightPool, so the scene's object/light churn stays tiny at any fire rate.
import * as THREE from 'three';
import { WEAPONS, WEAPON_DEFS, EV, PM } from '../../shared/constants.js';
import { ma, normalize, sub, dist } from '../../shared/vec3.js';
import { traceBox } from '../../shared/trace.js';
import { clipPolygon } from '../../shared/brush.js';
import { LightPool } from './lightpool.js';
import { ParticlePool, getSprite } from './particles.js';
import { Beam } from './beam.js';
import { weaponColor } from './weapons.js';

const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
const rnd = (a, b) => a + Math.random() * (b - a);
const LG_RANGE = WEAPON_DEFS[WEAPONS.LIGHTNING].range;

export class Effects {
  constructor(scene) {
    this.scene = scene; this.list = []; this.fakes = [];
    this.pool = new LightPool(scene, 12);
    // screen-size caps (px) and near-camera fades (units) stop point-blank effects from turning into full-screen discs
    this.sparks = new ParticlePool(scene, 1024, { additive: true, texture: 'hard', maxPx: 36, nearFade: 12 });
    this.glow = new ParticlePool(scene, 512, { additive: true, texture: 'soft', nearFade: 10 });
    this.fire = new ParticlePool(scene, 256, { additive: true, texture: 'fire', nearFade: 8 });
    this.smoke = new ParticlePool(scene, 768, { additive: false, texture: 'smoke', nearFade: 40, maxPx: 380 });
    this.blood = new ParticlePool(scene, 384, { additive: false, texture: 'hard', maxPx: 48, nearFade: 8 });
    this.beams = new Map(); // player id -> { beam, until, dir, light, own }
    this.mats = {
      flash: new THREE.MeshBasicMaterial({ color: 0xffd8a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
      ring: new THREE.MeshBasicMaterial({ color: 0xffb070, map: getSprite('ring'), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      scorch: new THREE.MeshBasicMaterial({ color: 0x000000, map: getSprite('scorch'), transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
      railCore: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }),
      railHalo: new THREE.MeshBasicMaterial({ color: 0x5cff9d, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      gib: new THREE.MeshStandardMaterial({ color: 0x7a0f0f, emissive: 0x3a0505, roughness: 0.85, metalness: 0.05 }),
      rocketBody: new THREE.MeshStandardMaterial({ color: 0x555b66, metalness: 0.85, roughness: 0.35 }),
      rocketTip: new THREE.MeshStandardMaterial({ color: 0xff3a1a, emissive: 0xff3a1a, emissiveIntensity: 1.2 }),
      rocketFlame: new THREE.SpriteMaterial({ color: 0xffb060, map: getSprite('soft'), transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }),
      plasmaBall: new THREE.MeshBasicMaterial({ color: 0xe8d0ff }),
      plasmaGlow: new THREE.SpriteMaterial({ color: 0xb26cff, map: getSprite('soft'), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
      portal: new THREE.MeshBasicMaterial({ color: 0xa070ff, map: getSprite('soft'), transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    };
    this.geos = {
      sphere: new THREE.SphereGeometry(1, 16, 12), ring: new THREE.RingGeometry(0.7, 1, 40), disc: new THREE.CircleGeometry(1, 24),
      gib: [0, 1, 2, 3].map((i) => new THREE.DodecahedronGeometry(3 + i * 1.5, 0)),
      rocketBody: new THREE.CylinderGeometry(3, 3, 18, 10), rocketTip: new THREE.ConeGeometry(3, 7, 10), fin: new THREE.BoxGeometry(6, 1, 5), plasma: new THREE.SphereGeometry(5, 12, 10),
      railCore: new THREE.CylinderGeometry(1, 0.35, 1, 8, 1, true), railHalo: new THREE.CylinderGeometry(1, 0.12, 1, 10, 1, true), // radiusBottom (-y) sits at the muzzle: both taper toward the shooter, so our own trail is never a wedge across the screen
    };
    this.decalCount = 0;
    this.map = null; // set by the renderer on loadMap: decals clip against map.brushes
    this.localMuzzle = null; // set by the renderer: () => [x,y,z]
    this.remoteMuzzle = null; // set by the renderer: (id) => [x,y,z] | null
  }
  add(fx) { fx.t0 = performance.now(); this.list.push(fx); return fx; }
  // Pooled light flash: borrows a light for `life` ms with a decay curve. Intensities are candela with inverse-square
  // falloff, so a light must never sit a few units off a surface: irradiance = I / d^2 (the map's own lights deliver
  // ~1-4 at their brightest); every caller here keeps the peak at or below ~10 for a few frames at most.
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
      case EV.LG_HIT: this.lgHit(e.origin, e.world, e.normal); break;
      case EV.BULLET_IMPACT: this.impact(e.origin, e.normal, e.weapon); break;
      case EV.PAIN: if (e.id !== cg.localId) this.bloodSpray(e.origin, e.damage); break;
      case EV.DEATH: if (e.gib) this.gibs(e.origin); break;
      case EV.FIRE: if (e.id === cg.localId) this.localFire(e, cg); else this.remoteFire(e, cg); break;
      case EV.JUMPPAD: this.padBurst(e.origin); break;
      case EV.TELEPORT: this.teleFlash(e.origin, e.id === cg.localId); break;
      case EV.RESPAWN: this.teleFlash(e.origin, e.id === cg.localId); break;
      case EV.PICKUP: this.pickupFlash(e.origin); break;
      case EV.ITEM_RESPAWN: this.pickupFlash(e.origin, 0xffffff, 0.5); break;
    }
  }

  // ---------- firing ----------
  // Local fire: instant fake projectile so rockets appear with zero latency; replaced by the server's when it arrives.
  localFire(e, cg) {
    const wd = WEAPON_DEFS[e.weapon];
    if (wd.projectile) {
      const origin = ma(e.origin, 14, e.dir);
      const m = this.makeProjectile(e.weapon, true, { seq: e.seq });
      this.fakes.push({ seq: e.seq, mesh: m, origin, velocity: [e.dir[0] * wd.speed, e.dir[1] * wd.speed, e.dir[2] * wd.speed], t0: performance.now() });
    }
    if (e.weapon === WEAPONS.LIGHTNING) this.beamFire(cg.localId, true, e.origin, e.dir, cg);
    else if (e.weapon !== WEAPONS.GAUNTLET) {
      // light the world around the muzzle (the viewmodel's own flash lives in the viewmodel scene); the light is
      // kept clear of any wall right in front of us so a point-blank shot does not paint it white
      const m = this.lightSpot(cg, e.origin, e.dir, 40);
      this.flash(m, weaponColor(e.weapon), e.weapon === WEAPONS.MACHINEGUN ? 500 : 1400, 300, e.weapon === WEAPONS.RAIL ? 200 : 90, (k) => (1 - k) * (1 - k));
    }
  }
  remoteFire(e, cg) {
    if (e.weapon === WEAPONS.LIGHTNING) { this.beamFire(e.id, false, e.origin, e.dir, cg); return; }
    if (e.weapon === WEAPONS.GAUNTLET) return;
    const m = (this.remoteMuzzle && this.remoteMuzzle(e.id)) || ma(e.origin, 24, e.dir);
    const c = weaponColor(e.weapon);
    this.flash(this.lightSpot(cg, e.origin, e.dir, 36), c, 1000, 280, 90, (k) => (1 - k) * (1 - k));
    this.glow.spawn({ pos: m, life: 70, size: 14, grow: 0.6, color: rgb(c).map((x) => x * 1.2), alpha: 0.85, fade: 1, px: 90 });
    this.glow.spawn({ pos: m, life: 60, size: 6, color: [1.2, 1.15, 1.05], alpha: 0.9, fade: 1, px: 40 });
  }
  // A point `want` units along `dir` from `from`, pulled back to the midpoint if a wall is closer: where effect
  // lights go so their inverse-square falloff never lands a few units off a surface.
  lightSpot(cg, from, dir, want) {
    if (!cg || !cg.game) return ma(from, want, dir);
    const tr = traceBox(cg.game.world, from, ma(from, want + 12, dir), [0, 0, 0], [0, 0, 0], null, { skipFlags: 4 });
    const d = tr.fraction * (want + 12);
    return ma(from, Math.min(want, d * 0.5), dir);
  }
  // Lightning: the beam persists while FIRE events keep arriving (every 50 ms); it is re-traced every frame from the
  // current muzzle so it tracks the shooter's aim with no latency.
  beamFire(id, own, origin, dir, cg) {
    let b = this.beams.get(id);
    if (!b) { b = { beam: new Beam(this.scene), light: this.pool.acquire(0x9fd8ff, 1000, 220), own, id }; this.beams.set(id, b); }
    b.until = performance.now() + 95; b.dir = dir; b.origin = origin; b.cg = cg;
  }
  traceBeam(cg, start, dir, skipId) {
    const end = ma(start, LG_RANGE, dir);
    const ents = [];
    for (const [id, r] of cg.remote) if (id !== skipId && !r.d) ents.push({ id, origin: r.origin, mins: PM.mins, maxs: (r.pf & 1) ? PM.duckMaxs : PM.maxs });
    if (skipId !== cg.localId && cg.predicted && !cg.predicted.dead) ents.push({ id: cg.localId, origin: cg.predicted.ps.origin, mins: PM.mins, maxs: PM.maxs });
    const tr = traceBox(cg.game.world, start, end, [0, 0, 0], [0, 0, 0], ents, { skipFlags: 4 });
    return tr;
  }
  updateBeams(now, dt, camera, viewDir) {
    for (const [id, b] of this.beams) {
      if (now > b.until) { b.beam.dispose(); this.pool.release(b.light); this.beams.delete(id); continue; }
      const cg = b.cg;
      let start, dir = b.dir;
      if (b.own) { start = this.localMuzzle ? this.localMuzzle() : b.origin; dir = viewDir || dir; b.origin = cg.predicted ? [cg.predicted.ps.origin[0], cg.predicted.ps.origin[1], cg.predicted.ps.origin[2] + cg.predicted.ps.viewHeight] : b.origin; }
      else { const r = cg.remote.get(id); if (r) b.origin = [r.origin[0], r.origin[1], r.origin[2] + (r.vh || PM.viewHeight)]; start = (this.remoteMuzzle && this.remoteMuzzle(id)) || ma(b.origin, 20, dir); }
      const tr = this.traceBeam(cg, b.origin, dir, id);
      const end = tr.endpos;
      b.beam.set(start, end); b.beam.update(now, camera);
      // end light: a modest blue pool on the surface (~2 irradiance at the hit point, flickering), parked 24 units
      // off the surface along its normal so its inverse-square falloff cannot blow the wall out
      const n = tr.fraction < 1 && tr.plane ? tr.plane.n : [-dir[0], -dir[1], -dir[2]];
      b.light.position.set(end[0] + n[0] * 24, end[1] + n[1] * 24, end[2] + n[2] * 24); b.light.intensity = 900 + Math.random() * 400;
      // continuous impact sparks at the end point (world or flesh); all screen-size capped, so at point blank they
      // stay small dots instead of covering the view
      if (tr.fraction < 1 && Math.random() < dt * 30) {
        this.sparks.spawn({ pos: end, vel: [(n[0] + rnd(-0.8, 0.8)) * rnd(80, 220), (n[1] + rnd(-0.8, 0.8)) * rnd(80, 220), (n[2] + rnd(-0.5, 1)) * rnd(80, 220)], life: rnd(150, 350), size: 1.8, color: [0.85, 0.95, 1.15], gravity: 600, fade: 3, px: 28 });
        this.glow.spawn({ pos: ma(end, 2, n), life: 60, size: 5, color: [0.5, 0.7, 1.0], alpha: 0.7, fade: 1, px: 36 });
      }
    }
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

  // ---------- projectiles ----------
  makeProjectile(type, own, pr) {
    const scene = this.scene, self = this;
    const g = new THREE.Group();
    if (type === WEAPONS.ROCKET) {
      const body = new THREE.Mesh(this.geos.rocketBody, this.mats.rocketBody); body.rotation.z = Math.PI / 2; g.add(body);
      const tip = new THREE.Mesh(this.geos.rocketTip, this.mats.rocketTip); tip.rotation.z = -Math.PI / 2; tip.position.x = 12.5; g.add(tip);
      for (let i = 0; i < 4; i++) { const fin = new THREE.Mesh(this.geos.fin, this.mats.rocketBody); fin.position.x = -7; fin.rotation.x = i * Math.PI / 2; fin.position.y = Math.cos(i * Math.PI / 2) * 3.5; fin.position.z = Math.sin(i * Math.PI / 2) * 3.5; g.add(fin); }
      const flame = new THREE.Sprite(this.mats.rocketFlame.clone()); flame.scale.set(16, 16, 1); flame.position.x = -11; g.add(flame);
      g.userData.flame = flame; g.userData.light = this.pool.acquire(0xff7a3a, 2600, 420);
    } else if (type === WEAPONS.PLASMA) {
      g.add(new THREE.Mesh(this.geos.plasma, this.mats.plasmaBall));
      const glow = new THREE.Sprite(this.mats.plasmaGlow); glow.scale.set(22, 22, 1); g.add(glow);
      g.userData.light = this.pool.acquire(0xb26cff, 1400, 280);
    }
    scene.add(g);
    let lastSmoke = 0, lastGlow = 0;
    return {
      group: g,
      update(origin, v, now, dt) {
        g.position.set(origin[0], origin[1], origin[2]);
        if (g.userData.light) g.userData.light.position.set(origin[0], origin[1], origin[2]);
        const d = normalize(v); const yaw = Math.atan2(d[1], d[0]); const pitch = -Math.asin(Math.max(-1, Math.min(1, d[2])));
        g.rotation.set(0, pitch, yaw, 'ZYX');
        if (type === WEAPONS.ROCKET) {
          g.userData.flame.material.opacity = 0.7 + Math.random() * 0.3; g.userData.flame.scale.setScalar(14 + Math.random() * 8);
          g.userData.light.intensity = 2200 + Math.random() * 1000;
          // smoke trail, Q3 CG_RocketTrail style: a discrete grey puff every 36 ms of flight (~32 units apart at
          // rocket speed) that lingers ~1.5 s, drifting up; plus a short-lived exhaust glow behind the nozzle
          if (!lastSmoke) lastSmoke = now - 36;
          for (let k = 0; now - lastSmoke >= 36 && k < 4; k++) {
            lastSmoke += 36;
            const back = (now - lastSmoke) / 1000; // place the puff where the rocket was at that instant
            const p = [origin[0] - d[0] * 14 - v[0] * back, origin[1] - d[1] * 14 - v[1] * back, origin[2] - d[2] * 14 - v[2] * back];
            const shade = rnd(0.26, 0.36);
            self.smoke.spawn({ pos: p, vel: [rnd(-8, 8), rnd(-8, 8), rnd(10, 22)], life: rnd(1300, 1700), size: 11, grow: 1.1, color: [shade, shade * 0.98, shade * 0.95], alpha: 0.6, fade: 4, rot: rnd(0, 6.3), spin: rnd(-1, 1) });
          }
          if (now - lastGlow > 30) { lastGlow = now; self.glow.spawn({ pos: [origin[0] - d[0] * 12, origin[1] - d[1] * 12, origin[2] - d[2] * 12], life: 110, size: 10, color: [1, 0.55, 0.2], alpha: 0.9, fade: 1, shrink: 0.5, px: 120 }); }
          if (now - lastSmoke > 100) lastSmoke = now;
        } else if (type === WEAPONS.PLASMA && now - lastGlow > 16) { lastGlow = now; self.glow.spawn({ pos: origin, life: 160, size: 12, color: [0.7, 0.42, 1], alpha: 0.7, fade: 1, shrink: 0.8, px: 120 }); }
      },
      dispose() { scene.remove(g); if (g.userData.light) self.pool.release(g.userData.light); if (g.userData.flame) g.userData.flame.material.dispose(); },
    };
  }

  // ---------- impacts ----------
  explosion(origin, normal, weapon) {
    const big = weapon === WEAPONS.ROCKET;
    const o = ma(origin, big ? 8 : 3, normal);
    const life = big ? 420 : 200;
    // Fireball: a cluster of ragged fire puffs (noisy sprite texture, random spin, drifting apart) in a yellow ->
    // orange -> dark red ramp. Colours stay near 1.0 so ACES keeps their hue: a hotter core would just tone-map to
    // a flat white disc.
    if (big) {
      this.fire.spawn({ pos: o, life: 200, size: 30, grow: 1.6, color: [1.5, 1.15, 0.55], alpha: 1, fade: 3, rot: rnd(0, 6.3), spin: rnd(-3, 3) }); // hot core
      for (let i = 0; i < 9; i++) {
        const off = [rnd(-10, 10), rnd(-10, 10), rnd(-6, 12)];
        const spd = rnd(30, 110), dir = normalize([off[0] + normal[0] * 8, off[1] + normal[1] * 8, off[2] + normal[2] * 8 + 4]);
        const hot = Math.random();
        this.fire.spawn({ pos: [o[0] + off[0], o[1] + off[1], o[2] + off[2]], vel: [dir[0] * spd, dir[1] * spd, dir[2] * spd + 20], life: rnd(320, 620), size: rnd(18, 30), grow: 1.5, color: [1.25, 0.45 + hot * 0.45, 0.08 + hot * 0.2], alpha: 0.9, fade: 3, rot: rnd(0, 6.3), spin: rnd(-4, 4), drag: 2 });
      }
      for (let i = 0; i < 4; i++) this.fire.spawn({ pos: ma(o, rnd(2, 10), normal), vel: [rnd(-30, 30), rnd(-30, 30), rnd(20, 70)], life: rnd(600, 900), size: rnd(22, 30), grow: 1.4, color: [0.6, 0.16, 0.04], alpha: 0.85, fade: 3, rot: rnd(0, 6.3), spin: rnd(-2, 2) }); // dark late flame
    } else {
      this.fire.spawn({ pos: o, life: 140, size: 16, grow: 1.4, color: [1.2, 0.85, 1.4], alpha: 1, fade: 3, rot: rnd(0, 6.3), spin: rnd(-3, 3) });
      for (let i = 0; i < 4; i++) this.fire.spawn({ pos: ma(o, rnd(0, 6), normal), vel: [rnd(-40, 40), rnd(-40, 40), rnd(0, 50)], life: rnd(160, 260), size: rnd(10, 16), grow: 1.4, color: [0.7, 0.4, 1.1], alpha: 0.85, fade: 3, rot: rnd(0, 6.3), spin: rnd(-4, 4) });
    }
    // shockwave ring on the surface
    if (big) {
      const ring = new THREE.Mesh(this.geos.disc, this.mats.ring.clone()); ring.position.set(...ma(origin, 2, normal)); ring.lookAt(ring.position.x + normal[0], ring.position.y + normal[1], ring.position.z + normal[2]); ring.scale.setScalar(10); this.scene.add(ring);
      this.add({ life: 340, obj: ring, upd: (k) => { ring.scale.setScalar(12 + k * 150); ring.material.opacity = 0.75 * (1 - k) * (1 - k); } });
    }
    // light: strong but short, held 26 units off the surface (peak irradiance ~7 right under it for a few frames)
    this.flash(ma(o, 26, normal), big ? 0xff8a40 : 0xd8a0ff, big ? 5000 : 1600, big ? 700 : 300, life, (k) => Math.pow(1 - k, 1.6));
    // sparks (fast, orange-white, screen-size capped) + embers (slower, glowing, gravity)
    const n = big ? 30 : 10;
    for (let i = 0; i < n; i++) {
      const dir = normalize([rnd(-1, 1) + normal[0] * 0.7, rnd(-1, 1) + normal[1] * 0.7, rnd(-1, 1) + normal[2] * 0.7]);
      const spd = (big ? 320 : 140) + Math.random() * (big ? 520 : 200);
      this.sparks.spawn({ pos: o, vel: [dir[0] * spd, dir[1] * spd, dir[2] * spd], life: rnd(350, 750), size: big ? 2.2 : 1.6, color: big ? [1.35, 0.95, 0.45] : [1.1, 0.85, 1.35], gravity: 700, drag: 1.2, fade: 3, shrink: 0.6, px: 24 });
    }
    if (big) for (let i = 0; i < 14; i++) {
      const dir = normalize([rnd(-1, 1), rnd(-1, 1), rnd(-0.2, 1) + normal[2] * 0.5]);
      const spd = rnd(60, 220);
      this.glow.spawn({ pos: o, vel: [dir[0] * spd, dir[1] * spd, dir[2] * spd], life: rnd(500, 1000), size: rnd(3, 6), color: [1.3, 0.6, 0.15], alpha: 0.9, gravity: 400, drag: 1.5, fade: 3, px: 40 });
    }
    // Smoke column: dense dark-grey puffs (linear ~0.1-0.2, i.e. mid-dark after ACES: darker than a lit wall, lighter
    // than a shadowed corner) that rise and spread for ~2 s after the fireball is gone. Fade mode 4 brings each puff
    // in over its first 12% so the column appears as the flames die instead of competing with them.
    const puffs = big ? 14 : 3;
    for (let i = 0; i < puffs; i++) {
      const dir = normalize([rnd(-1, 1), rnd(-1, 1), rnd(-0.2, 1) + normal[2] * 0.8]);
      const spd = rnd(20, big ? 90 : 50), shade = rnd(0.09, 0.2);
      this.smoke.spawn({ pos: ma(o, rnd(2, 14), normal), vel: [dir[0] * spd, dir[1] * spd, dir[2] * spd + 34], life: big ? rnd(1400, 2200) : rnd(500, 800), size: big ? rnd(14, 24) : 8, grow: 2.2, color: [shade, shade * 0.97, shade * 0.94], alpha: big ? 0.72 : 0.5, fade: 4, rot: rnd(0, 6.3), spin: rnd(-1.2, 1.2), drag: 1.4 });
    }
    // scorch decal
    this.decal(origin, normal, big ? 70 : 16, big ? 0.92 : 0.8, 25000);
  }
  // Scorch / bullet mark. Like Q3's R_MarkFragments the mark is projected along the hit normal onto every nearby
  // brush face that roughly faces it and clipped to that face's edges, so a mark on a pillar or ledge never
  // overhangs into empty space; the pieces are one mesh with the mark texture mapped through the decal basis.
  decal(origin, normal, size, opacity, life) {
    if (this.decalCount > 40) return; // keep the number of long-lived transparent meshes bounded
    const geo = buildDecalGeometry(this.map, origin, normal, size);
    if (!geo) return;
    this.decalCount++;
    const m = new THREE.Mesh(geo, this.mats.scorch.clone()); m.material.opacity = opacity; m.frustumCulled = false; this.scene.add(m);
    this.add({ life, obj: m, upd: (k) => { m.material.opacity = opacity * (1 - Math.max(0, (k - 0.7) / 0.3)); }, done: () => { this.decalCount--; geo.dispose(); } });
  }
  railTrail(start, end, own) {
    const d = sub(end, start); const len = Math.max(1, dist(start, end)); const dir = normalize(d);
    const mid = ma(start, len / 2, dir);
    const core = new THREE.Mesh(this.geos.railCore, this.mats.railCore.clone()); core.scale.set(1.3, len, 1.3); core.material.color.setRGB(1.05, 1.3, 1.15); // just over the bloom threshold: a glowing thread, not a bloom slab near the eye
    // the halo is a cone that starts almost closed at the muzzle: seen from the shooter (or just beside the line
    // after a sidestep) a uniform 8-unit tube starting at the gun is a wedge across half the screen
    const haloLen = len;
    const halo = new THREE.Mesh(this.geos.railHalo, this.mats.railHalo.clone()); halo.scale.set(3, haloLen, 3); halo.material.opacity = 0.3;
    const g = new THREE.Group(); g.add(core, halo); g.position.set(...mid);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...dir)); this.scene.add(g);
    // spiral (Q3 rail rings): additive particles on a helix that drift outward as the trail fades
    const up = Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const p1 = normalize([dir[1] * up[2] - dir[2] * up[1], dir[2] * up[0] - dir[0] * up[2], dir[0] * up[1] - dir[1] * up[0]]);
    const p2 = [dir[1] * p1[2] - dir[2] * p1[1], dir[2] * p1[0] - dir[0] * p1[2], dir[0] * p1[1] - dir[1] * p1[0]];
    const step = 6, n = Math.min(400, Math.floor(len / step));
    for (let i = 0; i < n; i++) {
      const a = i * 0.55, r = 6;
      const ox = p1[0] * Math.cos(a) * r + p2[0] * Math.sin(a) * r, oy = p1[1] * Math.cos(a) * r + p2[1] * Math.sin(a) * r, oz = p1[2] * Math.cos(a) * r + p2[2] * Math.sin(a) * r;
      const p = ma(start, i * step, dir);
      this.glow.spawn({ pos: [p[0] + ox, p[1] + oy, p[2] + oz], vel: [ox * 1.2, oy * 1.2, oz * 1.2], life: 900, size: 2.6, color: [0.55, 1.35, 0.85], alpha: 0.95, fade: 3, grow: 0.5, px: 30 });
    }
    this.add({ life: 800, obj: g, upd: (k) => { core.material.opacity = 1 - k; halo.material.opacity = 0.3 * (1 - k); halo.scale.set(3 + k * 4, haloLen, 3 + k * 4); core.material.color.setRGB(1.05 - k * 0.45, 1.3 - k * 0.6, 1.15 - k * 0.5); } });
    this.flash(ma(start, 40, dir), 0x5cff9d, 2000, 360, 250, (k) => 1 - k);
    this.impact(end, normalize(sub(start, end)), WEAPONS.RAIL);
  }
  lgHit(origin, world, normal) {
    if (!world) { this.bloodSpray(origin, 8); return; }
    const n = normal || [0, 0, 1];
    for (let i = 0; i < 4; i++) this.sparks.spawn({ pos: origin, vel: [(n[0] + rnd(-1, 1)) * rnd(100, 260), (n[1] + rnd(-1, 1)) * rnd(100, 260), (n[2] + rnd(-0.3, 1)) * rnd(100, 260)], life: rnd(200, 400), size: 1.8, color: [0.8, 0.92, 1.1], gravity: 600, fade: 3, px: 28 });
    if (Math.random() < 0.15) this.decal(origin, n, 8, 0.5, 8000);
  }
  impact(origin, normal, weapon) {
    const color = weaponColor(weapon);
    const rail = weapon === WEAPONS.RAIL;
    this.flash(ma(origin, rail ? 22 : 16, normal), color, rail ? 2400 : 450, rail ? 300 : 160, rail ? 300 : 120);
    this.glow.spawn({ pos: ma(origin, 2, normal), life: rail ? 260 : 90, size: rail ? 18 : 5, grow: 0.8, color: rgb(color).map((c) => c * 1.25), alpha: 0.85, fade: 1, px: rail ? 160 : 48 });
    const n = rail ? 16 : 5;
    for (let i = 0; i < n; i++) {
      const dir = normalize([normal[0] + rnd(-0.7, 0.7), normal[1] + rnd(-0.7, 0.7), normal[2] + rnd(-0.7, 0.7)]);
      const spd = rnd(100, 320);
      this.sparks.spawn({ pos: origin, vel: [dir[0] * spd, dir[1] * spd, dir[2] * spd], life: rnd(250, 600), size: rail ? 1.6 : 1.2, color: rail ? [0.7, 1.4, 0.95] : [1.4, 1.1, 0.6], gravity: 700, drag: 0.8, fade: 3, shrink: 0.7, px: 24 });
    }
    // dust puff
    this.smoke.spawn({ pos: ma(origin, 3, normal), vel: [normal[0] * 20, normal[1] * 20, normal[2] * 20 + 10], life: rnd(400, 700), size: rail ? 12 : 6, grow: 2.5, color: [0.35, 0.33, 0.3], alpha: 0.45, fade: 3 });
    this.decal(origin, normal, rail ? 18 : 6, 0.7, 15000);
  }
  bloodSpray(origin, damage) {
    const n = Math.min(18, 3 + Math.floor(damage / 6));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, s = rnd(60, 220);
      this.blood.spawn({ pos: [origin[0], origin[1], origin[2] + rnd(-6, 14)], vel: [Math.cos(a) * s, Math.sin(a) * s, rnd(20, 180)], life: rnd(350, 650), size: rnd(3, 6), grow: 0.6, color: [0.55, 0.04, 0.04], alpha: 0.9, gravity: 800, fade: 3 });
    }
    this.smoke.spawn({ pos: [origin[0], origin[1], origin[2] + 6], life: 300, size: 14, grow: 1.5, color: [0.45, 0.05, 0.05], alpha: 0.5, fade: 1 });
  }
  gibs(origin) {
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(this.geos.gib[i % 4], this.mats.gib); m.position.set(origin[0], origin[1], origin[2] + 10); this.scene.add(m);
      const v = [rnd(-260, 260), rnd(-260, 260), rnd(150, 480)]; const r = [rnd(-8, 8), rnd(-8, 8), 0];
      let lastDrip = 0;
      this.add({ life: 3000, obj: m, upd: (k, dt, now) => {
        v[2] -= 800 * dt; m.position.x += v[0] * dt; m.position.y += v[1] * dt; m.position.z += v[2] * dt; m.rotation.x += r[0] * dt; m.rotation.y += r[1] * dt;
        if (m.position.z < origin[2] - 22) { m.position.z = origin[2] - 22; v[0] *= 0.6; v[1] *= 0.6; v[2] = -v[2] * 0.3; r[0] *= 0.5; r[1] *= 0.5; }
        if (k < 0.5 && now - lastDrip > 40) { lastDrip = now; this.blood.spawn({ pos: [m.position.x, m.position.y, m.position.z], life: 500, size: 3, color: [0.5, 0.03, 0.03], alpha: 0.85, gravity: 800, fade: 3 }); }
        if (k > 0.8) m.scale.setScalar(1 - (k - 0.8) / 0.2);
      } });
    }
    this.bloodSpray(origin, 120);
    this.flash([origin[0], origin[1], origin[2] + 24], 0xff2020, 1400, 220, 200);
  }
  padBurst(origin) {
    const ring = new THREE.Mesh(this.geos.disc, this.mats.ring.clone()); ring.material.color.setHex(0x4ab3ff); ring.position.set(origin[0], origin[1], origin[2] - 22); ring.scale.setScalar(12); this.scene.add(ring);
    this.add({ life: 380, obj: ring, upd: (k) => { ring.scale.setScalar(12 + k * 50); ring.material.opacity = 0.8 * (1 - k); } });
    for (let i = 0; i < 14; i++) { const a = Math.random() * 6.28, r = rnd(8, 22); this.glow.spawn({ pos: [origin[0] + Math.cos(a) * r, origin[1] + Math.sin(a) * r, origin[2] - 20], vel: [0, 0, rnd(120, 260)], life: rnd(300, 500), size: rnd(4, 7), color: [0.35, 0.7, 1], alpha: 0.9, fade: 3 }); }
    this.flash([origin[0], origin[1], origin[2] + 8], 0x4ab3ff, 1500, 300, 250);
  }
  // Teleport / spawn fog. For the local player only the light remains: the particles would sit right in front of
  // the camera as huge blurry discs (Q3 gives the local player a screen flash instead, see hud.js).
  teleFlash(origin, local = false) {
    this.flash([origin[0], origin[1], origin[2] + 16], 0xbfa0ff, 4500, 420, 420, (k) => Math.pow(1 - k, 1.5));
    if (local) return;
    this.glow.spawn({ pos: [origin[0], origin[1], origin[2] + 4], life: 420, size: 56, grow: 0.8, color: [0.8, 0.65, 1], alpha: 0.9, fade: 1 });
    for (let i = 0; i < 40; i++) { const a = Math.random() * 6.28, r = rnd(4, 18); this.glow.spawn({ pos: [origin[0] + Math.cos(a) * r, origin[1] + Math.sin(a) * r, origin[2] + rnd(-24, 30)], vel: [Math.cos(a) * rnd(10, 60), Math.sin(a) * rnd(10, 60), rnd(-40, 90)], life: rnd(400, 800), size: rnd(3, 6), color: [0.7, 0.5, 1], alpha: 0.9, fade: 3, drag: 1 }); }
  }
  pickupFlash(origin, color = 0xffffff, scale = 1) {
    this.glow.spawn({ pos: origin, life: 260, size: 28 * scale, grow: 1.8, color: rgb(color), alpha: 0.8, fade: 1 });
    for (let i = 0; i < 8 * scale; i++) { const a = Math.random() * 6.28; this.glow.spawn({ pos: origin, vel: [Math.cos(a) * rnd(30, 90), Math.sin(a) * rnd(30, 90), rnd(20, 120)], life: rnd(300, 500), size: 4, color: [1, 1, 1], alpha: 0.9, fade: 3 }); }
  }
  // Persistent teleporter portal: two counter-rotating soft discs + a slow particle drizzle.
  makePortal(center, w, h, scene) {
    const g = new THREE.Group(); g.position.set(...center);
    const a = new THREE.Mesh(this.geos.disc, this.mats.portal); a.scale.set(w * 0.5, h * 0.5, 1); a.rotation.x = Math.PI / 2;
    const b = new THREE.Mesh(this.geos.ring, this.mats.portal.clone()); b.material.color.setHex(0xd8b0ff); b.scale.set(w * 0.55, h * 0.55, 1); b.rotation.x = Math.PI / 2;
    g.add(a, b); scene.add(g); g.userData.world = true;
    this.add({ life: Infinity, obj: g, upd: (k, dt, now) => { a.rotation.y = now * 0.0012; b.rotation.y = -now * 0.002; a.material.opacity = 0.55 + Math.sin(now * 0.004) * 0.15; if (Math.random() < dt * 12) this.glow.spawn({ pos: [center[0] + rnd(-w * 0.4, w * 0.4), center[1] + rnd(-6, 6), center[2] + rnd(-h * 0.45, h * 0.45)], vel: [0, 0, rnd(10, 30)], life: rnd(600, 1200), size: rnd(2, 4), color: [0.75, 0.55, 1], alpha: 0.8, fade: 2 }); } });
  }

  // Spawn one of everything far away so every effect shader/program exists before the match starts.
  // `o` must be inside the warm-up camera's frustum: frustum-culled objects are never drawn, and it is the first
  // real draw that pays for buffer/texture uploads and (with parallel shader compile) waits for the program.
  warmup(o = [0, 0, 0], camera = null) {
    const n = [0, 0, 1];
    this.explosion(o, n, WEAPONS.ROCKET); this.explosion(o, n, WEAPONS.PLASMA); this.railTrail(o, ma(o, 100, [1, 0, 0]), true); this.impact(o, n, WEAPONS.MACHINEGUN);
    this.bloodSpray(o, 40); this.gibs(o); this.padBurst(o); this.teleFlash(o); this.pickupFlash(o);
    this.warmProj = [this.makeProjectile(WEAPONS.ROCKET, true, {}), this.makeProjectile(WEAPONS.PLASMA, true, {})];
    for (const p of this.warmProj) p.update(o, [1, 0, 0], performance.now(), 0.016);
    this.warmBeam = new Beam(this.scene); this.warmBeam.set(o, ma(o, 200, [1, 0, 0]));
    if (camera) this.warmBeam.update(performance.now(), camera);
    for (const p of [this.sparks, this.glow, this.fire, this.smoke, this.blood]) p.update(0.001);
  }
  // Drop every effect (map change): persistent ones too, so portals of the previous map stop spawning particles.
  reset() {
    for (const fx of this.list) fx.life = 0;
    for (const b of this.beams.values()) { b.beam.dispose(); this.pool.release(b.light); }
    this.beams.clear();
    for (const f of this.fakes) f.mesh.dispose(); this.fakes.length = 0;
    this.purge();
    this.decalCount = 0;
  }
  purge() {
    for (const fx of this.list) if (fx.life !== Infinity) { if (fx.light) { fx.light.userData.release = null; this.pool.release(fx.light); fx.light = null; } fx.dead = true; }
    for (const p of this.warmProj || []) p.dispose(); this.warmProj = null;
    if (this.warmBeam) { this.warmBeam.dispose(); this.warmBeam = null; }
    for (const p of [this.sparks, this.glow, this.fire, this.smoke, this.blood]) { p.p.length = 0; p.update(0); }
    this.update(performance.now(), 0);
  }
  update(now, dt, camera, viewDir) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const fx = this.list[i];
      const k = (now - fx.t0) / fx.life;
      if (k >= 1 || fx.dead) {
        if (fx.obj) { this.scene.remove(fx.obj); if (fx.obj.material && fx.obj.material !== this.mats.gib && fx.obj.material.dispose) fx.obj.material.dispose(); }
        if (fx.light && !fx.dead) this.pool.release(fx.light);
        if (fx.done) fx.done();
        this.list.splice(i, 1); continue;
      }
      fx.upd(k, dt, now);
    }
    if (camera) this.updateBeams(now, dt, camera, viewDir);
    this.sparks.update(dt); this.glow.update(dt); this.fire.update(dt); this.smoke.update(dt); this.blood.update(dt);
  }
  get particleCount() { return this.sparks.active + this.glow.active + this.fire.active + this.smoke.active + this.blood.active; }
}

// ---------- decal projection ----------
const DECAL_FACE_DOT = 0.55;   // faces tilted more than ~57 degrees from the hit normal do not receive the mark
const DECAL_PLANE_DIST = 6;    // how far (units) the hit point may sit off a face's plane and still mark it
// Project a size x size square centred on `origin` (facing `normal`) onto the brush faces around it and clip it to
// each face. Returns a BufferGeometry (positions + uvs) or null when nothing was hit (e.g. no map yet).
function buildDecalGeometry(map, origin, normal, size) {
  if (!map || !map.brushes) return null;
  const n = normalize(normal);
  // decal basis, rotated by a random angle so repeated marks do not line up
  const up = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const t0 = normalize([n[1] * up[2] - n[2] * up[1], n[2] * up[0] - n[0] * up[2], n[0] * up[1] - n[1] * up[0]]);
  const b0 = [n[1] * t0[2] - n[2] * t0[1], n[2] * t0[0] - n[0] * t0[2], n[0] * t0[1] - n[1] * t0[0]];
  const a = Math.random() * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
  const t = [t0[0] * ca + b0[0] * sa, t0[1] * ca + b0[1] * sa, t0[2] * ca + b0[2] * sa];
  const b = [b0[0] * ca - t0[0] * sa, b0[1] * ca - t0[1] * sa, b0[2] * ca - t0[2] * sa];
  const h = size / 2;
  const square = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([u, v]) => [origin[0] + t[0] * u + b[0] * v, origin[1] + t[1] * u + b[1] * v, origin[2] + t[2] * u + b[2] * v]);
  const positions = [], uvs = [];
  const reach = h * 1.5 + DECAL_PLANE_DIST;
  for (const br of map.brushes) {
    if (br.nonsolid || (br.flags & 6) || !br.polys) continue; // triggers, NODRAW and PLAYERCLIP carry no marks
    if (br.mins[0] > origin[0] + reach || br.maxs[0] < origin[0] - reach || br.mins[1] > origin[1] + reach || br.maxs[1] < origin[1] - reach || br.mins[2] > origin[2] + reach || br.maxs[2] < origin[2] - reach) continue;
    for (const poly of br.polys) {
      const pn = poly.plane.n, pd = poly.plane.d;
      const facing = pn[0] * n[0] + pn[1] * n[1] + pn[2] * n[2];
      if (facing < DECAL_FACE_DOT) continue;
      const dist = pn[0] * origin[0] + pn[1] * origin[1] + pn[2] * origin[2] - pd;
      if (dist < -DECAL_PLANE_DIST || dist > DECAL_PLANE_DIST) continue;
      // project the square onto this face's plane along the decal normal
      let frag = square.map((p) => { const k = (pd - (pn[0] * p[0] + pn[1] * p[1] + pn[2] * p[2])) / facing; return [p[0] + n[0] * k, p[1] + n[1] * k, p[2] + n[2] * k]; });
      // clip to the face's edges (edge planes point outward whichever way the polygon is wound)
      const v = poly.verts;
      const e0 = sub(v[1], v[0]), e1 = sub(v[2], v[0]);
      const wind = (e0[1] * e1[2] - e0[2] * e1[1]) * pn[0] + (e0[2] * e1[0] - e0[0] * e1[2]) * pn[1] + (e0[0] * e1[1] - e0[1] * e1[0]) * pn[2] < 0 ? -1 : 1;
      for (let i = 0; i < v.length && frag.length >= 3; i++) {
        const p0 = v[i], p1 = v[(i + 1) % v.length], e = sub(p1, p0);
        const en = normalize([(e[1] * pn[2] - e[2] * pn[1]) * wind, (e[2] * pn[0] - e[0] * pn[2]) * wind, (e[0] * pn[1] - e[1] * pn[0]) * wind]);
        frag = clipPolygon(frag, { n: en, d: en[0] * p0[0] + en[1] * p0[1] + en[2] * p0[2] });
      }
      if (frag.length < 3) continue;
      // fan-triangulate; uv = position in the decal basis; lift 0.4 units off the face (plus polygon offset)
      const uv = (p) => [((p[0] - origin[0]) * t[0] + (p[1] - origin[1]) * t[1] + (p[2] - origin[2]) * t[2]) / size + 0.5, ((p[0] - origin[0]) * b[0] + (p[1] - origin[1]) * b[1] + (p[2] - origin[2]) * b[2]) / size + 0.5];
      const lift = (p) => [p[0] + pn[0] * 0.4, p[1] + pn[1] * 0.4, p[2] + pn[2] * 0.4];
      // the square is wound counter-clockwise around n, and the projection keeps that around pn (facing > 0)
      for (let i = 1; i + 1 < frag.length; i++) for (const j of [0, i, i + 1]) { positions.push(...lift(frag[j])); uvs.push(...uv(frag[j])); }
    }
  }
  if (!positions.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geo;
}
