// Three.js renderer for the survival slice: Project Zomboid fixed 3/4 camera (yaw 45 deg, pitch 50 deg) that
// follows the player, a merged low-poly town (world.js), skinned characters with procedural animation
// (characters.js), pooled effects (effects.js) and a time-of-day light curve (daylight.js).
// Light set is fixed at construction (sun, hemisphere, lantern, muzzle flash): nothing is added or removed at
// runtime so no shader recompiles happen mid-game. Entity positions are interpolated between sim ticks with alpha.
// Coordinates: sim x -> X, sim y -> Z, up = +Y; sim facing theta (0 = +x, PI/2 = +y south) -> rotation.y = -theta.
import * as THREE from 'three';
import { EV } from '../../shared/survival/constants.js';
import { TownView } from './world.js';
import { Rig } from './characters.js';
import { Effects } from './effects.js';
import { Daylight } from './daylight.js';

const CAM_YAW = Math.PI / 4, CAM_PITCH = 50 * Math.PI / 180, CAM_DIST = 20, CAM_FOV = 35; // ~22 tiles across the mid row at 16:9
// Lantern: linear falloff, modest intensity. Measured at 23:30 (headless Edge, ACES): lit lawn beside the player
// L ~95, player torso ~130 and still blue, lawn at 5 tiles ~15 so a self-lit zombie there reads ~100 (see build_render/).
// Higher intensities clip the near field to white and the player / close zombies merge with the ground.
const LANTERN_RANGE = 12, LANTERN_INTENSITY = 10, LANTERN_DECAY = 1.0;
const ZOMBIE_POOL = 40; // > max simultaneous zombies (waves 6+5+4 + 8 ambient) so no rig is ever built mid-game
const SHADOW_SIZE = 2048, SHADOW_HALF = 20; // ortho shadow frustum half-extent in tiles, follows the camera target
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2();
const TAU = Math.PI * 2;
const lerpAngle = (a, b, t) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return a + d * t; };

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.0;
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x86bdf2); this.scene.fog = new THREE.Fog(0x86bdf2, 40, 115);
    this.camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 1, 200); this.yaw = CAM_YAW;
    this.camTarget = new THREE.Vector3(); this.camGoal = new THREE.Vector3(); this.shake = 0; this.shakeV = new THREE.Vector3();
    // fixed light pool
    this.sun = new THREE.DirectionalLight(0xffffff, 1.5); this.scene.add(this.sun, this.sun.target);
    this.sun.castShadow = true; this.sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE); this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.03;
    const sc = this.sun.shadow.camera; sc.left = -SHADOW_HALF; sc.right = SHADOW_HALF; sc.top = SHADOW_HALF; sc.bottom = -SHADOW_HALF; sc.near = 1; sc.far = 140;
    this.hemi = new THREE.HemisphereLight(0xbfe0ff, 0x66644a, 0.6); this.scene.add(this.hemi);
    this.lantern = new THREE.PointLight(0xffe2b8, 0, LANTERN_RANGE, LANTERN_DECAY); this.scene.add(this.lantern); // mildly warm so the blue jacket keeps its hue
    this.daylight = new Daylight();
    this.effects = new Effects(this.scene);
    this.town = null; this.player = null; this.zombies = new Map(); this.pool = []; this.interp = new Map(); this.lastTick = -1;
    this.frameStats = { draws: 0, tris: 0, ms: 0 }; this.hour = 12; this.sim = null;
    this.resize();
  }
  setWorld(world) {
    if (this.town) this.scene.remove(this.town.group);
    this.town = new TownView(world); this.scene.add(this.town.group);
    this.town.group.traverse((o) => { if (o.isMesh) { o.receiveShadow = true; o.castShadow = o.name !== 'ground' && o.name !== 'apron' && !(o.material && o.material.transparent); } });
    if (!this.player) { this.player = new Rig('player'); this.player.mesh.castShadow = true; this.scene.add(this.player.root); }
    for (let i = 0; i < ZOMBIE_POOL; i++) this.acquireZombieRig(true);
    this.camTarget.set(world.spawn.x, 0, world.spawn.y); this.camGoal.copy(this.camTarget);
    // warm every shader before the first visible frame
    this.renderer.compile(this.scene, this.camera);
  }
  acquireZombieRig(park) {
    let rig = this.pool.pop();
    if (!rig) { rig = new Rig('zombie', this.zombies.size + this.pool.length); rig.mesh.castShadow = true; this.scene.add(rig.root); }
    if (park) { rig.root.visible = false; this.pool.push(rig); }
    return rig;
  }
  resize() {
    const w = window.innerWidth || 1280, h = window.innerHeight || 720;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.effects.setViewport(h * Math.min(window.devicePixelRatio || 1, 1.5));
    this.width = w; this.height = h;
  }
  // ---------------- events ----------------
  event(e, sim) {
    const fx = this.effects; const p = sim.player; const dir = [Math.cos(p.facing), Math.sin(p.facing)];
    switch (e.type) {
      case EV.SWING: this.player.attackT = 0.18; this.player.attackKind = e.weapon; fx.swing(p.x, p.y, p.facing); break;
      case EV.GUNSHOT: { this.player.attackT = 0.14; this.player.attackKind = 'pistol'; fx.muzzle(p.x + dir[0] * 0.9, 1.25, p.y + dir[1] * 0.9); break; }
      case EV.MELEE_HIT: fx.burst(14, e.x, 1.0, e.y, { color: 0x8a1010, spread: 1.6, up: 2.5, size: 0.14, life: 0.5, dir, push: 2 }); break;
      case EV.BULLET_HIT:
        if (e.target != null) fx.burst(12, e.x, 1.0, e.y, { color: 0x8a1010, spread: 1.4, up: 2.2, size: 0.12, life: 0.45, dir, push: 2.5 });
        else fx.burst(8, e.x, 0.3, e.y, { color: 0x9a9a8a, spread: 0.8, up: 1.2, size: 0.16, life: 0.5, grav: 3 });
        break;
      case EV.ZOMBIE_BASH: case EV.BARRICADE_HIT: case EV.BARRICADE_BROKEN: case EV.DOOR_BREAK: case EV.WINDOW_BREAK:
        fx.burst(e.type === EV.WINDOW_BREAK ? 16 : 10, e.x, 1.2, e.y, { color: e.type === EV.WINDOW_BREAK ? 0xc8f0ff : 0xb08a50, spread: 1.6, up: 2, size: 0.1, life: 0.6 }); break;
      case EV.HARVEST_HIT: case EV.HARVEST_DONE: fx.burst(e.type === EV.HARVEST_DONE ? 24 : 12, e.x, 2.0, e.y, { color: 0x4f9a3a, spread: 1.4, up: 1.0, size: 0.14, life: 0.9, grav: 2.5 }); break;
      case EV.PICKUP: case EV.CONTAINER_OPEN: fx.burst(8, e.x, 0.9, e.y, { color: 0xffe28a, spread: 0.4, up: 1.6, size: 0.1, life: 0.8, grav: -0.6 }); break;
      case EV.BARRICADE_BUILT: fx.burst(10, e.x, 1.2, e.y, { color: 0xc8a060, spread: 1.0, up: 1.5, size: 0.1, life: 0.5 }); break;
      case EV.PLAYER_HURT: this.shake = Math.min(0.5, 0.18 + e.damage * 0.012); this.player.stagger = 0.28; fx.burst(10, p.x, 1.1, p.y, { color: 0x8a1010, spread: 1.2, up: 1.8, size: 0.12, life: 0.5 }); break;
      case EV.ZOMBIE_STAGGER: { const r = this.zombies.get(e.id); if (r) r.stagger = 0.3; break; }
      case EV.ZOMBIE_DEATH: fx.burst(16, e.x, 0.9, e.y, { color: 0x6a0c0c, spread: 1.8, up: 1.5, size: 0.14, life: 0.7 }); break;
      // DOOR_OPEN/CLOSE and PHASE are handled by state-driven lerps in TownView.update / Daylight.update
    }
  }
  // ---------------- per-frame ----------------
  // Interpolated pose for an entity id: keeps prev/cur per id and lerps by alpha (positions and facing).
  interpolate(id, ent, alpha, tickChanged) {
    let s = this.interp.get(id);
    if (!s) { s = { px: ent.x, py: ent.y, pf: ent.facing, cx: ent.x, cy: ent.y, cf: ent.facing, x: ent.x, y: ent.y, f: ent.facing, seen: 0 }; this.interp.set(id, s); }
    if (tickChanged) { s.px = s.cx; s.py = s.cy; s.pf = s.cf; s.cx = ent.x; s.cy = ent.y; s.cf = ent.facing; }
    // a teleport-sized jump (spawn) should not sweep across the map
    if (Math.abs(s.cx - s.px) + Math.abs(s.cy - s.py) > 3) { s.px = s.cx; s.py = s.cy; s.pf = s.cf; }
    s.x = s.px + (s.cx - s.px) * alpha; s.y = s.py + (s.cy - s.py) * alpha; s.f = lerpAngle(s.pf, s.cf, alpha); s.seen = this.frameNo;
    s.speed = Math.hypot(s.cx - s.px, s.cy - s.py) * 30;
    return s;
  }
  frame(sim, alpha, dt, now) {
    if (!this.town || !sim) return;
    const t0 = performance.now(); this.renderer.info.reset(); this.sim = sim; this.frameNo = (this.frameNo || 0) + 1;
    const tickChanged = sim.tick !== this.lastTick; this.lastTick = sim.tick;
    const night = sim.phase === 'night';
    // ---- lighting / sky ----
    const L = this.daylight.update(sim.hour, dt, CAM_DIST);
    Rig.setNight(L.dark);
    this.sun.color.copy(L.sun); this.sun.intensity = L.sunI;
    // the shadow frustum follows the camera target, snapped to a few texels so edges do not shimmer while walking
    const texel = (SHADOW_HALF * 2) / SHADOW_SIZE * 4; const tx = Math.round(this.camTarget.x / texel) * texel, tz = Math.round(this.camTarget.z / texel) * texel;
    this.sun.target.position.set(tx, 0, tz); this.sun.position.copy(this.daylight.sunDir).multiplyScalar(70).add(this.sun.target.position);
    this.hemi.color.copy(L.hSky); this.hemi.groundColor.copy(L.hGround); this.hemi.intensity = L.hemiI;
    this.scene.background.copy(L.sky); this.scene.fog.color.copy(L.sky); this.scene.fog.near = L.fogNear; this.scene.fog.far = L.fogFar;
    // ---- player ----
    const p = sim.player; const ps = this.interpolate('player', p, alpha, tickChanged);
    this.player.root.position.set(ps.x, 0, ps.y); this.player.root.rotation.y = -ps.f;
    this.player.animatePlayer(p, p.moving ? ps.speed : 0, dt);
    // lantern hangs above and slightly camera-side of the player so the visible faces of everyone nearby are lit
    this.lantern.position.set(ps.x + Math.cos(this.yaw) * 1.3, 2.1, ps.y + Math.sin(this.yaw) * 1.3);
    this.lantern.intensity = p.alive ? LANTERN_INTENSITY * L.lantern : 0;
    const entities = [{ x: ps.x, y: 0, z: ps.y, mark: null, eyes: null, r: 1 }];
    // ---- zombies: acquire/release rigs, interpolate, animate ----
    const live = new Set();
    for (const z of sim.zombies) {
      live.add(z.id); let rig = this.zombies.get(z.id);
      if (!rig) { rig = this.acquireZombieRig(false); rig.root.visible = true; rig.dead = 0; rig.stagger = 0; rig.phase = Math.random() * 6; this.zombies.set(z.id, rig); this.interp.delete(z.id); }
      const s = this.interpolate(z.id, z, alpha, tickChanged);
      rig.root.position.set(s.x, 0, s.y); rig.root.rotation.y = -s.f;
      rig.animateZombie(z, s.speed, dt, night);
      const dead = z.state === 'dead';
      const mark = dead ? null : z.state === 'investigate' ? '?' : (z.state === 'chase' || z.state === 'attack' || z.state === 'bash') ? '!' : null;
      let eyes = null; if (z.horde && !dead) { rig.eyes(rig.eyeL, rig.eyeR); eyes = [rig.eyeL, rig.eyeR]; }
      entities.push({ x: s.x, y: dead ? 0.5 : 2.25, z: s.y, mark, eyes, r: dead ? 1.4 : 1 });
    }
    for (const [id, rig] of this.zombies) if (!live.has(id)) { rig.root.visible = false; this.pool.push(rig); this.zombies.delete(id); this.interp.delete(id); }
    // ---- town, effects, markers ----
    this.town.update(dt, p.x, p.y);
    this.effects.update(dt);
    this.effects.writeEntities(entities, L.dark);
    // ---- camera: smooth follow + hurt nudge ----
    this.camGoal.set(ps.x, 0, ps.y);
    const k = 1 - Math.exp(-dt * 7); this.camTarget.lerp(this.camGoal, k);
    if (this.shake > 0) { this.shake = Math.max(0, this.shake - dt * 1.6); this.shakeV.set((Math.random() - 0.5), (Math.random() - 0.5) * 0.6, (Math.random() - 0.5)).multiplyScalar(this.shake * 0.6); } else this.shakeV.set(0, 0, 0);
    const hd = CAM_DIST * Math.cos(CAM_PITCH);
    this.camera.position.set(this.camTarget.x + Math.cos(this.yaw) * hd, CAM_DIST * Math.sin(CAM_PITCH), this.camTarget.z + Math.sin(this.yaw) * hd).add(this.shakeV);
    _v.copy(this.camTarget).add(this.shakeV); this.camera.lookAt(_v);
    this.renderer.render(this.scene, this.camera);
    const info = this.renderer.info.render;
    this.frameStats.draws = info.calls; this.frameStats.tris = info.triangles; this.frameStats.ms = performance.now() - t0;
    void now;
  }
  // ---------------- screen <-> world ----------------
  // Ray from the pixel through the camera against the y = 0 plane -> sim [x, y] or null.
  screenToWorld(px, py) {
    _ndc.set((px / this.width) * 2 - 1, -(py / this.height) * 2 + 1); _ray.setFromCamera(_ndc, this.camera);
    const hit = _ray.ray.intersectPlane(_plane, _v); return hit ? [hit.x, hit.z] : null;
  }
  // Screen direction (dx right, dy down) -> unit sim direction, rotated by the camera yaw so W walks "up the screen".
  screenDirToWorld(dx, dy) {
    const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    // camera forward projected on the ground: from the camera towards the target
    const fx = -Math.cos(this.yaw), fz = -Math.sin(this.yaw);          // screen up
    const rx = -fz, rz = fx;                                            // screen right = forward x up
    const wx = rx * dx - fx * dy, wz = rz * dx - fz * dy; const wl = Math.hypot(wx, wz) || 1;
    return [wx / wl, wz / wl];
  }
  worldToScreen(x, y, z = 0) {
    _v2.set(x, z, y).project(this.camera);
    return [(_v2.x + 1) / 2 * this.width, (1 - _v2.y) / 2 * this.height];
  }
}
