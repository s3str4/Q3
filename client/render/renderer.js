// Three.js renderer for the arena: world brushes, lights, items, players, projectiles, effects, viewmodel, camera.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { getMaterial } from './materials.js';
import { WEAPONS, WEAPON_DEFS, ITEMS, EV, PM } from '../../shared/constants.js';
import { angleVectors } from '../../shared/vec3.js';
import { Effects } from './effects.js';
import { ViewModel } from './viewmodel.js';
import { PlayerModel } from './playermodel.js';

const ITEM_COLORS = { health: 0x4dff6a, mega: 0x4da6ff, armor: 0xffd24d, armorRed: 0xff4d4d, weapon: 0xffffff, ammo: 0xd0d0d0 };

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.0;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070c);
    this.camera = new THREE.PerspectiveCamera(100, 1, 4, 12000);
    this.camera.up.set(0, 0, 1);
    this.fov = 100;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.6, 0.85);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.items = []; this.players = new Map(); this.projectiles = new Map();
    this.effects = new Effects(this.scene);
    this.viewmodel = new ViewModel(this.scene, this.camera);
    this.localId = 0;
    this.kick = [0, 0]; this.bobTime = 0; this.landBob = 0; this.landAt = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.frameStats = { draws: 0, tris: 0 };
  }
  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    if (!(w > 0 && h > 0)) return; // hidden/minimized: keep the last valid size (a 0x0 resize would poison the projection with NaN)
    this.renderer.setSize(w, h, false); this.composer.setSize(w, h);
    this.camera.aspect = w / h; this.camera.fov = fovY(this.fov, this.camera.aspect); this.camera.updateProjectionMatrix();
  }
  setFov(f) { this.fov = f; this.camera.fov = fovY(f, this.camera.aspect); this.camera.updateProjectionMatrix(); }

  loadMap(map) {
    this.map = map;
    // clear
    for (const o of [...this.scene.children]) if (o.userData.world) this.scene.remove(o);
    const groups = new Map();
    for (const b of map.brushes) {
      if (b.flags & 2 /* NODRAW */) continue;
      const mat = b.mat || 'wall';
      if (!groups.has(mat)) groups.set(mat, { positions: [], normals: [], uvs: [], indices: [] });
      const g = groups.get(mat);
      const scale = (getMaterial(mat).userData.scale || 128);
      for (const poly of b.polys) {
        const n = poly.plane.n;
        const base = g.positions.length / 3;
        for (const v of poly.verts) {
          g.positions.push(v[0], v[1], v[2]); g.normals.push(n[0], n[1], n[2]);
          // world-projected UVs on the dominant axis
          const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
          let u, w;
          if (az >= ax && az >= ay) { u = v[0]; w = v[1]; } else if (ax >= ay) { u = v[1]; w = v[2]; } else { u = v[0]; w = v[2]; }
          g.uvs.push(u / scale, w / scale);
        }
        // polygons from plane clipping are convex; winding must face outward: check normal vs computed
        const a = poly.verts[0], b2 = poly.verts[1], c = poly.verts[2];
        const cx = (b2[1] - a[1]) * (c[2] - a[2]) - (b2[2] - a[2]) * (c[1] - a[1]);
        const cy = (b2[2] - a[2]) * (c[0] - a[0]) - (b2[0] - a[0]) * (c[2] - a[2]);
        const cz = (b2[0] - a[0]) * (c[1] - a[1]) - (b2[1] - a[1]) * (c[0] - a[0]);
        const flip = (cx * n[0] + cy * n[1] + cz * n[2]) < 0;
        for (let i = 1; i + 1 < poly.verts.length; i++) {
          if (flip) g.indices.push(base, base + i + 1, base + i); else g.indices.push(base, base + i, base + i + 1);
        }
      }
    }
    for (const [mat, g] of groups) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(g.positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.normals, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uvs, 2));
      geo.setIndex(g.indices);
      geo.computeTangents?.();
      const mesh = new THREE.Mesh(geo, getMaterial(mat));
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.world = true;
      this.scene.add(mesh);
    }
    // lights
    const amb = map.ambient || {};
    const hemi = new THREE.HemisphereLight(new THREE.Color(amb.hemi ? amb.hemi[0] : '#8fa3c7'), new THREE.Color(amb.hemi ? amb.hemi[1] : '#20160f'), amb.hemi ? amb.hemi[2] : 0.35);
    hemi.userData.world = true; this.scene.add(hemi);
    if (amb.sky) this.scene.background = new THREE.Color(amb.sky);
    if (amb.fog) { this.scene.fog = new THREE.Fog(new THREE.Color(amb.fog[0]), amb.fog[1], amb.fog[2]); }
    let shadowBudget = 4;
    for (const l of map.lights) {
      const pl = new THREE.PointLight(new THREE.Color(l.color), l.intensity * 40000, l.radius, 1.6);
      pl.position.set(l.origin[0], l.origin[1], l.origin[2]);
      if (l.shadow !== false && shadowBudget > 0) { pl.castShadow = true; pl.shadow.mapSize.set(1024, 1024); pl.shadow.bias = -0.002; pl.shadow.radius = 3; pl.shadow.camera.near = 8; pl.shadow.camera.far = l.radius; shadowBudget--; }
      pl.userData.world = true; this.scene.add(pl);
    }
    if (amb.sun) {
      const sun = new THREE.DirectionalLight(new THREE.Color(amb.sun.color || '#fff2dd'), amb.sun.intensity || 1.5);
      sun.position.set(...(amb.sun.dir || [0.3, 0.2, 1])); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
      const b = map.bounds; const s = Math.max(b.maxs[0] - b.mins[0], b.maxs[1] - b.mins[1]) * 0.6;
      sun.shadow.camera.left = -s; sun.shadow.camera.right = s; sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s; sun.shadow.camera.near = 10; sun.shadow.camera.far = 6000; sun.shadow.bias = -0.0015;
      sun.target.position.set((b.mins[0] + b.maxs[0]) / 2, (b.mins[1] + b.maxs[1]) / 2, 0); this.scene.add(sun.target);
      sun.userData.world = true; this.scene.add(sun);
    }
    // items
    this.items = map.items.map((it, i) => this.makeItem(it, i));
    // decor (teleporter portals)
    for (const d of map.decor || []) {
      if (d.kind === 'teleporter') {
        const w = d.maxs[0] - d.mins[0], hgt = d.maxs[2] - d.mins[2];
        const geo = new THREE.PlaneGeometry(w, hgt);
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x9d5cff, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
        m.position.set((d.mins[0] + d.maxs[0]) / 2, (d.mins[1] + d.maxs[1]) / 2, (d.mins[2] + d.maxs[2]) / 2); m.rotation.x = Math.PI / 2;
        m.userData.world = true; this.scene.add(m);
        const l = new THREE.PointLight(0x9d5cff, 20000, 400, 1.8); l.position.copy(m.position); l.userData.world = true; this.scene.add(l);
      }
    }
  }

  makeItem(it, index) {
    const def = ITEMS[it.type];
    const group = new THREE.Group();
    group.position.set(it.origin[0], it.origin[1], it.origin[2]);
    let color = ITEM_COLORS[def.kind] || 0xffffff;
    if (it.type === 'mega') color = ITEM_COLORS.mega; if (it.type === 'armorRed') color = ITEM_COLORS.armorRed;
    let mesh;
    if (def.kind === 'health') { const s = it.type === 'mega' ? 18 : it.type === 'health5' ? 8 : 12; mesh = new THREE.Mesh(new THREE.SphereGeometry(s, 20, 14), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.2, transparent: true, opacity: 0.85 })); }
    else if (def.kind === 'armor') { const s = it.type === 'armorShard' ? 6 : 16; mesh = new THREE.Mesh(new THREE.OctahedronGeometry(s, 0), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6, roughness: 0.25, metalness: 0.8 })); }
    else if (def.kind === 'weapon') { mesh = this.viewmodel.makeWeaponMesh(def.weapon, 1.0); mesh.rotation.x = Math.PI / 2; }
    else { mesh = new THREE.Mesh(new THREE.BoxGeometry(14, 10, 10), new THREE.MeshStandardMaterial({ color: weaponColor(def.weapon), emissive: weaponColor(def.weapon), emissiveIntensity: 0.35, roughness: 0.5, metalness: 0.6 })); }
    mesh.castShadow = true;
    group.add(mesh);
    // only major items carry a real light (light count must stay constant: never toggle light visibility)
    let light = null;
    if (def.major) { light = new THREE.PointLight(color, 6000, 260, 2); light.position.set(0, 0, 10); group.add(light); }
    // base ring marker so item spots read from afar
    const ring = new THREE.Mesh(new THREE.RingGeometry(14, 18, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
    ring.position.z = -it.origin[2] + (it.floorZ ?? (it.origin[2] - 20)) + 0.5; group.add(ring);
    group.userData.world = true;
    this.scene.add(group);
    return { group, mesh, light, ring, def, index, available: true, color };
  }

  ensurePlayer(id, name) {
    let pm = this.players.get(id);
    if (!pm) { pm = new PlayerModel(this.scene, id === this.localId ? 0x4ab3ff : 0xff5a4a); this.players.set(id, pm); }
    return pm;
  }

  event(e, cg) {
    this.effects.event(e, cg, this);
    if (e.type === EV.FIRE && e.id === this.localId) this.viewmodel.fire(e.weapon);
    if (e.type === EV.PAIN && e.id === this.localId) { this.kick[0] += (Math.random() - 0.5) * 3; this.kick[1] += Math.min(6, e.damage / 12); }
    if (e.type === EV.LAND && e.id === this.localId) { this.landBob = e.hard ? 8 : 4; this.landAt = performance.now(); }
    if (e.type === EV.WEAPON_CHANGE && e.id === this.localId) this.viewmodel.setWeapon(e.weapon);
  }

  update(cg, view, now, dt) {
    const p = view && view.player;
    if (!p) return;
    this.localId = cg.localId;
    // --- camera ---
    const eye = [view.origin[0], view.origin[1], view.origin[2] + view.viewHeight];
    let pitch = view.angles[0], yaw = view.angles[1];
    // view bob (Q3 cg_bobup/bobpitch/bobroll), scaled by speed on the ground
    const speed = Math.hypot(view.velocity[0], view.velocity[1]);
    if (view.ground && speed > 40) this.bobTime += dt * speed * 0.02; else this.bobTime += dt * 0.5;
    const bobAmt = view.ground ? Math.min(1, speed / 320) : 0;
    const bobUp = Math.abs(Math.sin(this.bobTime)) * 1.6 * bobAmt;
    const bobRoll = Math.sin(this.bobTime) * 0.35 * bobAmt;
    if (this.landBob) { const t = (now - this.landAt) / 220; if (t >= 1) this.landBob = 0; else eye[2] -= this.landBob * Math.sin(t * Math.PI); }
    eye[2] += bobUp;
    // damage kicks decay
    pitch += this.kick[1]; yaw += this.kick[0];
    this.kick[0] *= Math.pow(0.001, dt); this.kick[1] *= Math.pow(0.001, dt);
    if (view.dead) { pitch = Math.max(pitch, -10); eye[2] = view.origin[2] - 8; }
    const av = angleVectors([pitch, yaw, 0]);
    this.camera.position.set(eye[0], eye[1], eye[2]);
    this.camera.lookAt(eye[0] + av.forward[0], eye[1] + av.forward[1], eye[2] + av.forward[2]);
    this.camera.rotateZ(bobRoll * Math.PI / 180);
    // zoom
    const targetFov = fovY(this.fov, this.camera.aspect);
    if (!(Math.abs(this.camera.fov - targetFov) <= 0.01) && Number.isFinite(targetFov)) { this.camera.fov = targetFov; this.camera.updateProjectionMatrix(); }
    // --- items ---
    const t = now / 1000;
    for (const it of this.items) {
      const gi = cg.game.items[it.index];
      const avail = gi ? gi.available : true;
      it.mesh.visible = avail; it.ring.visible = avail;
      if (it.light) it.light.intensity = avail ? 6000 * (0.85 + 0.15 * Math.sin(t * 4 + it.index)) : 0;
      if (avail) { it.mesh.rotation.z = t * 1.5; it.mesh.position.z = 4 + Math.sin(t * 2.5 + it.index) * 3; }
    }
    // --- remote players ---
    const seen = new Set();
    for (const [id, r] of cg.remote) {
      seen.add(id);
      const pm = this.ensurePlayer(id, r.n);
      pm.update(r.origin, r.angles, r, now, dt);
    }
    for (const [id, pm] of this.players) if (!seen.has(id)) { pm.dispose(); this.players.delete(id); }
    // --- projectiles ---
    const seenPr = new Set();
    for (const pr of cg.remoteProjectiles || []) {
      seenPr.add(pr.id);
      let m = this.projectiles.get(pr.id);
      if (!m) { m = this.effects.makeProjectile(pr.t, pr.ow === this.localId, pr); this.projectiles.set(pr.id, m); }
      m.update(pr.origin, pr.v, now, dt);
    }
    // predicted local rockets (fired but not yet in a snapshot) are handled by effects.fakeProjectiles
    this.effects.updateFakeProjectiles(cg, seenPr, this.projectiles, now, dt);
    for (const [id, m] of this.projectiles) if (!seenPr.has(id)) { m.dispose(); this.projectiles.delete(id); }
    // --- effects & viewmodel ---
    this.effects.update(now, dt, this.camera);
    this.viewmodel.update(p, view, now, dt, this.bobTime, bobAmt, this.camera);
    this.composer.render();
    const info = this.renderer.info; this.frameStats.draws = info.render.calls; this.frameStats.tris = info.render.triangles;
  }
}

function fovY(fovX, aspect) { return 2 * Math.atan(Math.tan(fovX * Math.PI / 360) / aspect) * 180 / Math.PI; }
export function weaponColor(w) { return { [WEAPONS.ROCKET]: 0xff6a3a, [WEAPONS.RAIL]: 0x5cff9d, [WEAPONS.LIGHTNING]: 0xbfe8ff, [WEAPONS.SHOTGUN]: 0xffc86a, [WEAPONS.PLASMA]: 0xb26cff, [WEAPONS.MACHINEGUN]: 0xffe680, [WEAPONS.GAUNTLET]: 0xff9a5c }[w] || 0xffffff; }
