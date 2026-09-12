// Lightning beam: camera-facing jagged ribbons from a muzzle to a hit point. Three layers: a wide soft blue glow,
// a bright core carrying a scrolling lightning-bolt texture (procedural sheet, so the bolt crawls along the beam),
// and a thinner forked bolt with its own jitter. The jitter is re-rolled at ~25 Hz (time-based, so it looks the
// same at 60 and 240 fps) and peaks mid-beam. Beams are pooled by Effects (never created mid-match).
import * as THREE from 'three';
import { getSprite, getSheet } from './particles.js';

const SEGS = 22;
const BOLT_TILE = 96; // world units per repeat of the bolt texture along the beam
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _side = new THREE.Vector3(), _toCam = new THREE.Vector3();
const _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3(), _up = new THREE.Vector3();

export class Beam {
  constructor(scene) {
    this.scene = scene;
    const bolt = getSheet('bolt').tex; bolt.wrapS = THREE.RepeatWrapping; bolt.needsUpdate = true; // tiles along the beam
    // core just above the bloom threshold (a thin bright thread that glows a little, never a white slab);
    // the glow ribbon is narrow and clearly blue so the wall behind the beam stays readable
    this.glow = this.ribbon(new THREE.MeshBasicMaterial({ color: 0x5aa8ff, map: getSprite('soft'), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }), 9, [0, 1]);
    this.core = this.ribbon(new THREE.MeshBasicMaterial({ color: 0xffffff, map: bolt, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }), 4, [0.5, 1]); this.core.material.color.setRGB(1.25, 1.4, 1.55);
    this.fork = this.ribbon(new THREE.MeshBasicMaterial({ color: 0x9fd0ff, map: bolt, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }), 2.4, [0, 0.5]);
    this.group = new THREE.Group(); this.group.add(this.glow, this.core, this.fork); this.group.visible = false; this.group.frustumCulled = false;
    scene.add(this.group);
    this.jitter = new Float32Array((SEGS + 1) * 2); this.jitter2 = new Float32Array((SEGS + 1) * 2); this.jitterAt = 0; this.scroll = 0;
    this.start = [0, 0, 0]; this.end = [0, 0, 0]; this.active = false;
  }
  ribbon(mat, width, vRange) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array((SEGS + 1) * 2 * 3), uv = new Float32Array((SEGS + 1) * 2 * 2);
    const idx = [];
    for (let i = 0; i < SEGS; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    for (let i = 0; i <= SEGS; i++) { uv[i * 4] = i / SEGS; uv[i * 4 + 1] = vRange[0]; uv[i * 4 + 2] = i / SEGS; uv[i * 4 + 3] = vRange[1]; }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.userData.width = width; m.renderOrder = 25;
    return m;
  }
  set(start, end) { this.start = start; this.end = end; this.active = true; this.group.visible = true; }
  hide() { this.active = false; this.group.visible = false; }
  update(now, camera, dt = 0.016) {
    if (!this.active) return;
    _a.set(...this.start); _b.set(...this.end); _d.subVectors(_b, _a);
    const len = _d.length(); if (len < 1) return; _d.divideScalar(len);
    if (now - this.jitterAt > 40) {
      this.jitterAt = now;
      const scale = Math.min(1, len / 300); // short beams (point blank) stay tight
      for (let i = 0; i <= SEGS; i++) {
        const k = i / SEGS, amp = (Math.sin(k * Math.PI) * 9 + 1.5) * scale;
        this.jitter[i * 2] = (Math.random() - 0.5) * amp; this.jitter[i * 2 + 1] = (Math.random() - 0.5) * amp;
        this.jitter2[i * 2] = (Math.random() - 0.5) * amp * 1.6; this.jitter2[i * 2 + 1] = (Math.random() - 0.5) * amp * 1.6;
      }
      this.jitter[0] = this.jitter[1] = 0; this.jitter[SEGS * 2] = this.jitter[SEGS * 2 + 1] = 0;
      this.jitter2[0] = this.jitter2[1] = 0; this.jitter2[SEGS * 2] = this.jitter2[SEGS * 2 + 1] = 0;
    }
    this.scroll -= dt * 4; // bolt texture crawls toward the shooter
    // two perpendicular axes for the jitter, and a camera-facing side vector for the ribbon width
    _up.set(0, 0, 1); if (Math.abs(_d.z) >= 0.9) _up.set(1, 0, 0);
    _p1.crossVectors(_d, _up).normalize(); _p2.crossVectors(_d, _p1).normalize();
    const tiles = len / BOLT_TILE;
    for (const m of [this.glow, this.core, this.fork]) {
      const w = m.userData.width, arr = m.geometry.attributes.position.array, uvs = m.geometry.attributes.uv.array;
      const jit = m === this.fork ? this.jitter2 : this.jitter;
      for (let i = 0; i <= SEGS; i++) {
        const k = i / SEGS;
        const px = _a.x + _d.x * len * k + _p1.x * jit[i * 2] + _p2.x * jit[i * 2 + 1];
        const py = _a.y + _d.y * len * k + _p1.y * jit[i * 2] + _p2.y * jit[i * 2 + 1];
        const pz = _a.z + _d.z * len * k + _p1.z * jit[i * 2] + _p2.z * jit[i * 2 + 1];
        _toCam.set(camera.position.x - px, camera.position.y - py, camera.position.z - pz);
        // segments close to the camera (the first few units out of our own muzzle) are thinned so the ribbon
        // never covers a big patch of the screen at point-blank range
        const near = Math.min(1, Math.max(0.3, _toCam.length() / 90));
        _side.crossVectors(_d, _toCam).normalize().multiplyScalar(w * 0.5 * near);
        arr[i * 6] = px - _side.x; arr[i * 6 + 1] = py - _side.y; arr[i * 6 + 2] = pz - _side.z;
        arr[i * 6 + 3] = px + _side.x; arr[i * 6 + 4] = py + _side.y; arr[i * 6 + 5] = pz + _side.z;
        if (m !== this.glow) { const u = k * tiles + this.scroll; uvs[i * 4] = u; uvs[i * 4 + 2] = u; }
      }
      m.geometry.attributes.position.needsUpdate = true;
      if (m !== this.glow) m.geometry.attributes.uv.needsUpdate = true;
    }
    this.core.material.opacity = 0.8 + Math.random() * 0.2;
    this.fork.material.opacity = 0.3 + Math.random() * 0.5;
  }
  dispose() { this.scene.remove(this.group); }
}
