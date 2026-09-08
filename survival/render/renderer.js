// STUB (replaced by the render builder). Keeps the page loading before the real renderer lands.
import * as THREE from 'three';
export class Renderer {
  constructor(canvas) { this.canvas = canvas; this.renderer = new THREE.WebGLRenderer({ canvas }); this.frameStats = { draws: 0, tris: 0, ms: 0 }; this.yaw = Math.PI / 4; this.scale = 40; }
  setWorld(world) { this.world = world; }
  resize() {}
  event() {}
  frame(sim) { this.sim = sim; }
  screenDirToWorld(dx, dy) { const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; }
  screenToWorld(px, py) { const p = this.sim ? this.sim.player : { x: 0, y: 0 }; return [p.x + (px - innerWidth / 2) / this.scale, p.y + (py - innerHeight / 2) / this.scale]; }
  worldToScreen(x, y) { const p = this.sim ? this.sim.player : { x: 0, y: 0 }; return [innerWidth / 2 + (x - p.x) * this.scale, innerHeight / 2 + (y - p.y) * this.scale]; }
}
