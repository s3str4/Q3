// Fixed pool of point lights. Lights are never added/removed at runtime (that would force three.js to
// recompile every lit shader); effects borrow a light, set its intensity, and hand it back.
import * as THREE from 'three';

export class LightPool {
  constructor(scene, count = 12) {
    this.lights = [];
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 400, 2);
      l.position.set(0, 0, -100000); l.userData.pooled = true; l.userData.busy = false;
      scene.add(l); this.lights.push(l);
    }
  }
  acquire(color, intensity, distance, decay = 2) {
    let l = this.lights.find((x) => !x.userData.busy);
    if (!l) { // steal the dimmest
      l = this.lights.reduce((a, b) => (a.intensity < b.intensity ? a : b));
      if (l.userData.release) l.userData.release();
    }
    l.userData.busy = true; l.color.setHex(color); l.intensity = intensity; l.distance = distance; l.decay = decay;
    return l;
  }
  release(l) { if (!l) return; l.userData.busy = false; l.userData.release = null; l.intensity = 0; l.position.set(0, 0, -100000); }
}
