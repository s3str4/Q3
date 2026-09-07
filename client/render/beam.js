// Lightning beam: a camera-facing jagged ribbon (bright core + wide soft glow) from a muzzle to a hit point.
// The jitter is re-rolled at ~25 Hz (time-based, so it looks the same at 60 and 240 fps) and peaks mid-beam.
import * as THREE from 'three';
import { getSprite } from './particles.js';

const SEGS = 22;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _side = new THREE.Vector3(), _toCam = new THREE.Vector3();

export class Beam {
  constructor(scene) {
    this.scene = scene;
    // core just above the bloom threshold (a thin bright thread that glows a little, never a white slab);
    // the glow ribbon is narrow and clearly blue so the wall behind the beam stays readable
    this.core = this.ribbon(0xffffff, 2.0, 0.9); this.core.material.color.setRGB(1.3, 1.45, 1.6);
    this.glow = this.ribbon(0x5aa8ff, 5, 0.42);
    this.group = new THREE.Group(); this.group.add(this.glow, this.core); this.group.visible = false; this.group.frustumCulled = false;
    scene.add(this.group);
    this.jitter = new Float32Array((SEGS + 1) * 2); this.jitterAt = 0;
    this.start = [0, 0, 0]; this.end = [0, 0, 0]; this.active = false;
  }
  ribbon(color, width, opacity) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array((SEGS + 1) * 2 * 3), uv = new Float32Array((SEGS + 1) * 2 * 2);
    const idx = [];
    for (let i = 0; i < SEGS; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    for (let i = 0; i <= SEGS; i++) { uv[i * 4] = i / SEGS; uv[i * 4 + 1] = 0; uv[i * 4 + 2] = i / SEGS; uv[i * 4 + 3] = 1; }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    // the sprite texture's vertical profile (soft falloff across the ribbon) gives the beam its glow edge
    const mat = new THREE.MeshBasicMaterial({ color, map: getSprite('soft'), transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.userData.width = width; m.renderOrder = 25;
    return m;
  }
  set(start, end) { this.start = start; this.end = end; this.active = true; this.group.visible = true; }
  hide() { this.active = false; this.group.visible = false; }
  update(now, camera) {
    if (!this.active) return;
    _a.set(...this.start); _b.set(...this.end); _d.subVectors(_b, _a);
    const len = _d.length(); if (len < 1) return; _d.divideScalar(len);
    if (now - this.jitterAt > 40) {
      this.jitterAt = now;
      const scale = Math.min(1, len / 300); // short beams (point blank) stay tight
      for (let i = 0; i <= SEGS; i++) { const k = i / SEGS; const amp = (Math.sin(k * Math.PI) * 9 + 1.5) * scale; this.jitter[i * 2] = (Math.random() - 0.5) * amp; this.jitter[i * 2 + 1] = (Math.random() - 0.5) * amp; }
      this.jitter[0] = this.jitter[1] = 0; this.jitter[SEGS * 2] = this.jitter[SEGS * 2 + 1] = 0;
    }
    // two perpendicular axes for the jitter, and a camera-facing side vector for the ribbon width
    const up = Math.abs(_d.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const p1 = new THREE.Vector3().crossVectors(_d, up).normalize(), p2 = new THREE.Vector3().crossVectors(_d, p1).normalize();
    for (const m of [this.core, this.glow]) {
      const w = m.userData.width, arr = m.geometry.attributes.position.array;
      for (let i = 0; i <= SEGS; i++) {
        const k = i / SEGS;
        const px = _a.x + _d.x * len * k + p1.x * this.jitter[i * 2] + p2.x * this.jitter[i * 2 + 1];
        const py = _a.y + _d.y * len * k + p1.y * this.jitter[i * 2] + p2.y * this.jitter[i * 2 + 1];
        const pz = _a.z + _d.z * len * k + p1.z * this.jitter[i * 2] + p2.z * this.jitter[i * 2 + 1];
        _toCam.set(camera.position.x - px, camera.position.y - py, camera.position.z - pz);
        // segments close to the camera (the first few units out of our own muzzle) are thinned so the ribbon
        // never covers a big patch of the screen at point-blank range
        const near = Math.min(1, Math.max(0.3, _toCam.length() / 90));
        _side.crossVectors(_d, _toCam).normalize().multiplyScalar(w * 0.5 * near);
        arr[i * 6] = px - _side.x; arr[i * 6 + 1] = py - _side.y; arr[i * 6 + 2] = pz - _side.z;
        arr[i * 6 + 3] = px + _side.x; arr[i * 6 + 4] = py + _side.y; arr[i * 6 + 5] = pz + _side.z;
      }
      m.geometry.attributes.position.needsUpdate = true;
    }
    this.core.material.opacity = 0.75 + Math.random() * 0.15;
  }
  dispose() { this.scene.remove(this.group); }
}
