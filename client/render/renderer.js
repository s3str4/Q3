// Three.js renderer for the arena: merged world geometry with baked vertex lighting, a constant light set
// (map lights + item lights + the effect LightPool: nothing is ever added/removed at runtime, so no shader
// recompiles mid-match), items, players, projectiles, effects, the viewmodel pass, camera (bob / kicks / death cam)
// and post (MSAA -> bloom -> ACES). Shaders are precompiled and warmed at load.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { WEAPONS, EV } from '../../shared/constants.js';
import { angleVectors } from '../../shared/vec3.js';
import { traceBox } from '../../shared/trace.js';
import { buildWorld } from './world.js';
import { ItemView } from './items.js';
import { Effects } from './effects.js';
import { setParticleViewport } from './particles.js';
import { ViewModel } from './viewmodel.js';
import { PlayerModel } from './playermodel.js';
export { weaponColor } from './weapons.js';

const ENEMY_COLOR = 0xff3b3b, OWN_COLOR = 0x4ab3ff;
const _dir = new THREE.Vector3();

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, stencil: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = false; // shadows are baked per vertex (bake.worker.js); players use blob shadows
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.05;
    this.renderer.info.autoReset = false; // reset once per frame so the stats cover every composer pass
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070c);
    this.camera = new THREE.PerspectiveCamera(100, 1, 4, 12000);
    this.camera.up.set(0, 0, 1);
    this.fov = 100;
    this.viewmodel = new ViewModel(this.camera);
    // post: HDR target -> world pass -> viewmodel pass (depth cleared) -> bloom (quarter res) -> ACES/output -> FXAA.
    // Measured on the RTX 5090 laptop at 1080p: 4x MSAA cost ~1.4 ms and full-res bloom ~1.1 ms of GPU time per
    // frame; FXAA + quarter-res bloom deliver the same look for ~0.3 ms, which is what keeps the frame under 2 ms.
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 0 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.vmPass = new RenderPass(this.viewmodel.scene, this.viewmodel.camera); this.vmPass.clear = false; this.vmPass.clearDepth = true;
    this.composer.addPass(this.vmPass);
    // bloom threshold just under 1.0: emissive trims/panels (kept at ~1.0-1.2 so ACES preserves their hue) get a
    // soft coloured halo, while the strength stays low enough that no effect can wash the frame out
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.34, 0.55, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    // FXAA's -100 LOD bias is meaningless on a mip-less render target and makes ANGLE/D3D print a warning: drop it
    this.fxaa = new ShaderPass({ ...FXAAShader, fragmentShader: FXAAShader.fragmentShader.replace(/, -100\.0\)/g, ')') });
    this.composer.addPass(this.fxaa);
    this.items = []; this.players = new Map(); this.projectiles = new Map();
    this.effects = new Effects(this.scene);
    this.effects.localMuzzle = () => this.viewmodel.muzzleWorld();
    this.effects.remoteMuzzle = (id) => { const pm = this.players.get(id); return pm ? pm.muzzleWorld() : null; };
    this.localId = 0;
    this.kick = [0, 0]; this.bobTime = 0; this.landBob = 0; this.landAt = 0;
    this.death = null; // death camera state
    this.frameStats = { draws: 0, tris: 0, programs: 0, particles: 0, bake: 0, worldVerts: 0, worldTris: 0, gpuMs: 0 };
    // GPU frame time (EXT_disjoint_timer_query_webgl2) so CPU stalls and real GPU cost can be told apart
    const gl = this.renderer.getContext();
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2'); this.gpuQueries = [];
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }
  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    if (!(w > 0 && h > 0)) return; // hidden/minimized: keep the last valid size (a 0x0 resize would poison the projection with NaN)
    this.renderer.setSize(w, h, false); this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.bloom.setSize(Math.round(w * pr / 2), Math.round(h * pr / 2)); // quarter-res mips: soft glow, 1/4 the fill
    this.fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
    setParticleViewport(h * pr); // particle screen-size caps are in render-target pixels
    this.camera.aspect = w / h; this.camera.fov = fovY(this.fov, this.camera.aspect); this.camera.updateProjectionMatrix();
    this.viewmodel.resize(w / h);
  }
  setFov(f) { this.fov = f; this.camera.fov = fovY(f, this.camera.aspect); this.camera.updateProjectionMatrix(); }

  loadMap(map) {
    this.map = map;
    // (re)load: drop everything from the previous map, including persistent effects and in-flight projectiles
    this.effects.reset();
    for (const m of this.projectiles.values()) m.dispose(); this.projectiles.clear();
    for (const o of [...this.scene.children]) if (o.userData.world) this.scene.remove(o);
    for (const it of this.items) this.scene.remove(it.group);
    for (const pm of this.players.values()) pm.dispose(); this.players.clear();
    this.death = null;
    // --- world geometry + bake ---
    const world = buildWorld(this.scene, map, { onProgress: (k) => { this.frameStats.bake = k; } });
    for (const m of world.meshes) m.frustumCulled = false; // a handful of big meshes: culling would only ever hide the one behind us
    this.frameStats.worldVerts = world.stats.vertices; this.frameStats.worldTris = world.stats.triangles;
    this.bakePromise = world.bake;
    // --- lights (constant set) ---
    const amb = map.ambient || {};
    const hemi = new THREE.HemisphereLight(new THREE.Color(amb.hemi ? amb.hemi[0] : '#8fa3c7'), new THREE.Color(amb.hemi ? amb.hemi[1] : '#20160f'), (amb.hemi ? amb.hemi[2] : 0.35) * 0.6);
    hemi.userData.world = true; this.scene.add(hemi);
    this.scene.background = new THREE.Color(amb.sky || 0x05070c);
    this.scene.fog = amb.fog ? new THREE.Fog(new THREE.Color(amb.fog[0]), amb.fog[1], amb.fog[2]) : null;
    for (const l of map.lights) {
      // real-time copy of each map light (no shadows) for specular/normal-map response; the bake carries the diffuse pools and shadows
      const pl = new THREE.PointLight(new THREE.Color(l.color), l.intensity * 1400, l.radius, 1.5);
      pl.position.set(l.origin[0], l.origin[1], l.origin[2]); pl.userData.world = true; this.scene.add(pl);
    }
    if (amb.sun) {
      const sun = new THREE.DirectionalLight(new THREE.Color(amb.sun.color || '#fff2dd'), (amb.sun.intensity || 1.5) * 0.5);
      sun.position.set(...(amb.sun.dir || [0.3, 0.2, 1])); sun.userData.world = true; this.scene.add(sun); this.scene.add(sun.target); sun.target.userData.world = true;
    }
    // --- items ---
    this.items = map.items.map((it, i) => new ItemView(this.scene, it, i));
    // --- decor (teleporter portals) ---
    for (const d of map.decor || []) {
      if (d.kind === 'teleporter') {
        const c = [(d.mins[0] + d.maxs[0]) / 2, (d.mins[1] + d.maxs[1]) / 2, (d.mins[2] + d.maxs[2]) / 2];
        this.effects.makePortal(c, d.maxs[0] - d.mins[0], d.maxs[2] - d.mins[2], this.scene);
        const l = new THREE.PointLight(0x9d5cff, 9000, 420, 1.8); l.position.set(c[0], c[1], c[2]); l.userData.world = true; this.scene.add(l);
      }
    }
    this.precompile(map);
  }
  // Compile every program the match can need (world, items, player, all weapons, every effect) and run one warm
  // frame so texture uploads and bloom targets exist before the first real frame: no hitches when the fight starts.
  precompile(map) {
    // camera at the first spawn; every warm-up object sits 120 units in front of it so it is actually drawn
    const spawn = map.spawns[0] || { origin: [0, 0, 0], yaw: 0 };
    const yaw = (spawn.yaw || 0) * Math.PI / 180, fwd = [Math.cos(yaw), Math.sin(yaw), 0];
    const eye = [spawn.origin[0], spawn.origin[1], spawn.origin[2] + 26];
    const o = [eye[0] + fwd[0] * 120, eye[1] + fwd[1] * 120, eye[2]];
    this.camera.position.set(eye[0], eye[1], eye[2]); this.camera.lookAt(o[0], o[1], o[2]); this.camera.updateMatrixWorld();
    this.viewmodel.camera.position.copy(this.camera.position); this.viewmodel.camera.quaternion.copy(this.camera.quaternion);
    if (!this.warmPlayer) this.warmPlayer = new PlayerModel(this.scene, ENEMY_COLOR);
    this.warmPlayer.group.visible = true; this.warmPlayer.shadow.visible = true;
    this.warmPlayer.update(o, [0, 0], { v: [100, 0, 0], g: 1, w: WEAPONS.ROCKET, pf: 0 }, performance.now(), 0.016, o[2] - 24);
    this.effects.warmup(o, this.camera);
    const vmHolders = Object.values(WEAPONS).filter((w) => w > 0).map((w) => this.viewmodel.ensure(w));
    for (const h of vmHolders) h.visible = true;
    this.viewmodel.flashSprite.material.opacity = 0.5;
    this.renderer.compile(this.scene, this.camera);
    this.renderer.compile(this.viewmodel.scene, this.viewmodel.camera);
    this.composer.render(); // real draws: buffer/texture uploads + program readiness happen here, not mid-fight
    this.composer.render();
    for (const h of vmHolders) h.visible = false;
    this.viewmodel.flashSprite.material.opacity = 0;
    this.effects.purge();
    this.warmPlayer.group.visible = false; this.warmPlayer.shadow.visible = false;
  }

  ensurePlayer(id) {
    let pm = this.players.get(id);
    if (!pm) { pm = new PlayerModel(this.scene, id === this.localId ? OWN_COLOR : ENEMY_COLOR); this.players.set(id, pm); }
    return pm;
  }

  event(e, cg) {
    this.effects.event(e, cg, this);
    if (e.type === EV.FIRE && e.id === this.localId) this.viewmodel.fire(e.weapon);
    if (e.type === EV.PAIN && e.id === this.localId) { this.kick[0] += (Math.random() - 0.5) * 3; this.kick[1] += Math.min(6, e.damage / 12); }
    if (e.type === EV.LAND && e.id === this.localId) { this.landBob = e.hard ? 8 : 4; this.landAt = performance.now(); }
    if (e.type === EV.WEAPON_CHANGE && e.id === this.localId) this.viewmodel.setWeapon(e.weapon);
    if (e.type === EV.DEATH && e.id === this.localId) this.death = { at: performance.now(), attacker: e.attacker, yaw: null, pitch: 0 };
    if (e.type === EV.RESPAWN && e.id === this.localId) this.death = null;
  }

  update(cg, view, now, dt) {
    const p = view && view.player;
    if (!p) return;
    this.localId = cg.localId;
    // --- camera ---
    const eye = [view.origin[0], view.origin[1], view.origin[2] + view.viewHeight];
    let pitch = view.angles[0], yaw = view.angles[1], roll = 0;
    // view bob (Q3 cg_bobup/bobpitch/bobroll), scaled by speed on the ground
    const speed = Math.hypot(view.velocity[0], view.velocity[1]);
    if (view.ground && speed > 40) this.bobTime += dt * speed * 0.02; else this.bobTime += dt * 0.5;
    const bobAmt = view.ground ? Math.min(1, speed / 320) : 0;
    const bobUp = Math.abs(Math.sin(this.bobTime)) * 1.6 * bobAmt;
    const bobRoll = Math.sin(this.bobTime) * 0.35 * bobAmt;
    let landDip = 0;
    if (this.landBob) { const t = (now - this.landAt) / 220; if (t >= 1) this.landBob = 0; else { landDip = this.landBob * Math.sin(t * Math.PI); eye[2] -= landDip; } }
    view.landDip = landDip;
    eye[2] += bobUp;
    // damage kicks decay
    pitch += this.kick[1]; yaw += this.kick[0];
    this.kick[0] *= Math.pow(0.001, dt); this.kick[1] *= Math.pow(0.001, dt);
    if (view.dead) {
      // death camera: drop to the body, pull back and up, and turn toward the killer
      const d = this.death || (this.death = { at: now, attacker: 0, yaw: null, pitch: 0 });
      const t = Math.min(1, (now - d.at) / 700), ease = t * t * (3 - 2 * t);
      const body = [view.origin[0], view.origin[1], view.origin[2] - 16];
      const killer = d.attacker && d.attacker !== this.localId ? cg.remote.get(d.attacker) : null;
      let targetYaw = yaw;
      if (killer) targetYaw = Math.atan2(killer.origin[1] - body[1], killer.origin[0] - body[0]) * 180 / Math.PI;
      if (d.yaw === null) d.yaw = yaw;
      let dy = targetYaw - d.yaw; dy = ((dy + 540) % 360) - 180; d.yaw += dy * Math.min(1, dt * 3);
      yaw = d.yaw; pitch = 12 * ease; roll = 6 * ease;
      const av = angleVectors([pitch, yaw, 0]);
      const want = [body[0] - av.forward[0] * 90 * ease, body[1] - av.forward[1] * 90 * ease, body[2] + 8 + 44 * ease];
      const tr = traceBox(cg.game.world, [body[0], body[1], body[2] + 8], want, [-6, -6, -6], [6, 6, 6], null, { skipFlags: 4 });
      eye[0] = tr.endpos[0]; eye[1] = tr.endpos[1]; eye[2] = tr.endpos[2];
    }
    const av = angleVectors([pitch, yaw, 0]);
    this.camera.position.set(eye[0], eye[1], eye[2]);
    this.camera.lookAt(eye[0] + av.forward[0], eye[1] + av.forward[1], eye[2] + av.forward[2]);
    this.camera.rotateZ((bobRoll + roll) * Math.PI / 180);
    // zoom / fov changes
    const targetFov = fovY(this.fov, this.camera.aspect);
    if (!(Math.abs(this.camera.fov - targetFov) <= 0.01) && Number.isFinite(targetFov)) { this.camera.fov = targetFov; this.camera.updateProjectionMatrix(); }
    this.camera.updateMatrixWorld();
    // --- items ---
    const t = now / 1000;
    for (const it of this.items) {
      const gi = cg.game.items[it.index];
      it.update(gi ? gi.available : true, t, now);
    }
    // --- remote players ---
    const seen = new Set();
    for (const [id, r] of cg.remote) {
      seen.add(id);
      const pm = this.ensurePlayer(id);
      const down = traceBox(cg.game.world, r.origin, [r.origin[0], r.origin[1], r.origin[2] - 1024], [-8, -8, -24], [8, 8, 0], null, { skipFlags: 4 });
      pm.update(r.origin, r.angles, r, now, dt, down.fraction < 1 ? down.endpos[2] - 24 : undefined);
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
    // --- viewmodel first (beams start at its muzzle), then effects ---
    this.viewmodel.update(p, view, now, dt, this.bobTime, bobAmt);
    this.effects.update(now, dt, this.camera, view.dead ? null : av.forward);
    // --- render ---
    this.renderer.info.reset();
    const gl = this.renderer.getContext(), ext = this.timerExt;
    let q = null;
    if (ext && this.gpuQueries.length < 4) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
    this.composer.render();
    if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); this.gpuQueries.push(q); }
    if (ext && this.gpuQueries.length && gl.getQueryParameter(this.gpuQueries[0], gl.QUERY_RESULT_AVAILABLE)) {
      const done = this.gpuQueries.shift();
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) this.frameStats.gpuMs = gl.getQueryParameter(done, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(done);
    }
    const info = this.renderer.info;
    this.frameStats.draws = info.render.calls; this.frameStats.tris = info.render.triangles; this.frameStats.programs = info.programs.length; this.frameStats.particles = this.effects.particleCount;
  }
}

function fovY(fovX, aspect) { return 2 * Math.atan(Math.tan(fovX * Math.PI / 360) / aspect) * 180 / Math.PI; }
