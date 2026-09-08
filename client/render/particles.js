// Instanced billboard particles: one draw call per pool regardless of particle count. Used for sparks, embers,
// smoke, blood, glows and trail puffs. Simulation is plain JS (velocity, gravity, drag, growth, fade); the GPU
// only receives packed per-instance attributes (offset, size, color, alpha, rotation) once per frame.
import * as THREE from 'three';

// Two safety valves keep effects from covering the screen at point-blank range (a real problem with the LG end
// sparks and muzzle glows): `px` caps a particle's on-screen height in pixels (0 = uncapped, e.g. fireballs) and
// `nearFade` (world units) fades particles out as they pass the camera.
const VERT = `
attribute vec3 offset; attribute float size; attribute vec3 color; attribute float alpha; attribute float rot; attribute float px;
uniform float halfH; uniform float nearFade;
varying vec2 vUv; varying vec4 vColor;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(offset, 1.0);
  float depth = max(0.01, -mv.z);
  float sz = size;
  if (px > 0.0) sz = min(sz, px * depth / (projectionMatrix[1][1] * halfH));
  float a = alpha * (nearFade > 0.0 ? smoothstep(nearFade * 0.4, nearFade, depth) : 1.0);
  vColor = vec4(color, a);
  float c = cos(rot), s = sin(rot);
  vec2 corner = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * sz;
  mv.xy += corner;
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
uniform sampler2D map; varying vec2 vUv; varying vec4 vColor;
void main() {
  vec4 t = texture2D(map, vUv);
  gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
  if (gl_FragColor.a < 0.004) discard;
}`;

// Procedural sprite textures (no external assets).
const hash = (x, y) => { const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return s - Math.floor(s); };
function vnoise(x, y, scale) { // smooth value noise in 0..1
  const xs = x / scale, ys = y / scale, x0 = Math.floor(xs), y0 = Math.floor(ys), fx = xs - x0, fy = ys - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0), b = hash(x0 + 1, y0), c = hash(x0, y0 + 1), d = hash(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function spriteTexture(kind) {
  const s = 64, c = document.createElement('canvas'); c.width = c.height = s; const ctx = c.getContext('2d');
  const img = ctx.createImageData(s, s); const d = img.data;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const dx = (x + 0.5) / s - 0.5, dy = (y + 0.5) / s - 0.5; const r = Math.hypot(dx, dy) * 2;
    let a;
    if (kind === 'soft') a = Math.max(0, 1 - r * r);                                   // gaussian-ish glow
    else if (kind === 'hard') a = r < 0.85 ? 1 : Math.max(0, 1 - (r - 0.85) / 0.15);   // solid disc, soft rim
    else if (kind === 'fire') { // fireball puff: ragged noisy edge, dense centre (several overlap into a textured ball)
      const n = Math.sin(x * 0.55 + Math.sin(y * 0.43) * 2.7) * 0.5 + Math.sin(y * 0.71 + Math.cos(x * 0.33) * 2.1) * 0.5 + Math.sin((x + y) * 0.23) * 0.4;
      const edge = 0.72 + n * 0.16;
      a = Math.max(0, 1 - Math.pow(r / edge, 2.2)); a = a * a * (3 - 2 * a) * (0.75 + 0.25 * Math.max(0, 1 - r * 2.2));
    } else if (kind === 'scorch') { // burn mark: dense dark core, ragged sooty edge (Q3 burnmark style)
      const n = Math.sin(x * 0.7 + Math.sin(y * 0.5) * 2.5) * 0.5 + Math.sin(y * 0.9 + Math.cos(x * 0.4) * 2.2) * 0.5;
      const edge = 0.8 + n * 0.18;
      const k = Math.min(1, r / edge); a = 1 - k * k * k;
      a *= 0.78 + 0.22 * vnoise(x, y, 5); // soot mottling (value noise, no visible pattern)
    } else if (kind === 'ring') { // shockwave / pad ring: a soft-edged annulus on a disc (RingGeometry's planar UVs gave a hard inner edge)
      const k = (r - 0.8) / 0.13; a = Math.exp(-k * k) * (r < 1 ? 1 : 0);
    } else { // smoke: a dense ragged puff (Q3 smokePuff look): solid enough that one puff reads on its own, soft edge
      const n = Math.sin(x * 0.9 + Math.sin(y * 0.7) * 3) * 0.5 + Math.sin(y * 1.3 + x * 0.4) * 0.5;
      a = Math.max(0, 1 - r * (1.02 + n * 0.14)); a = Math.pow(a * a * (3 - 2 * a), 0.8) * 0.95;
    }
    const i = (y * s + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = Math.round(a * 255);
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; return t;
}
const TEX = {};
export function getSprite(kind) { return TEX[kind] || (TEX[kind] = spriteTexture(kind)); }
// Half the render-target height in pixels, shared by every pool's screen-size clamp (the renderer sets it on resize).
const HALF_H = { value: 540 };
export function setParticleViewport(heightPx) { HALF_H.value = Math.max(1, heightPx / 2); }

export class ParticlePool {
  constructor(scene, capacity, { additive = false, texture = 'soft', depthTest = true, maxPx = 0, nearFade = 0 } = {}) {
    this.capacity = capacity; this.count = 0; this.maxPx = maxPx;
    this.p = []; // active particle records
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.offset = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.size = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    this.rot = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    this.px = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('offset', this.offset); geo.setAttribute('size', this.size); geo.setAttribute('color', this.color); geo.setAttribute('alpha', this.alpha); geo.setAttribute('rot', this.rot); geo.setAttribute('px', this.px);
    geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({ uniforms: { map: { value: getSprite(texture) }, halfH: HALF_H, nearFade: { value: nearFade } }, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    this.mesh = new THREE.Mesh(geo, mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = additive ? 20 : 10;
    scene.add(this.mesh);
    this.geo = geo;
  }
  // spawn({ pos, vel, life, size, grow, color:[r,g,b], alpha, gravity, drag, rot, spin, fade, px (max screen px, 0 = none) })
  spawn(o) {
    if (this.p.length >= this.capacity) this.p.shift();
    const c = o.color || [1, 1, 1];
    this.p.push({ x: o.pos[0], y: o.pos[1], z: o.pos[2], vx: o.vel ? o.vel[0] : 0, vy: o.vel ? o.vel[1] : 0, vz: o.vel ? o.vel[2] : 0, t: 0, life: o.life || 500, size: o.size || 4, grow: o.grow || 0, r: c[0], g: c[1], b: c[2], alpha: o.alpha ?? 1, gravity: o.gravity || 0, drag: o.drag || 0, rot: o.rot || 0, spin: o.spin || 0, fade: o.fade ?? 1, bounceZ: o.bounceZ, shrink: o.shrink || 0, px: o.px ?? this.maxPx });
  }
  update(dt) {
    const p = this.p; let n = 0;
    const off = this.offset.array, sz = this.size.array, col = this.color.array, al = this.alpha.array, rt = this.rot.array, pxa = this.px.array;
    for (let i = 0; i < p.length; i++) {
      const q = p[i];
      q.t += dt * 1000;
      if (q.t >= q.life) { p[i] = p[p.length - 1]; p.pop(); i--; continue; }
      const k = q.t / q.life;
      if (q.gravity) q.vz -= q.gravity * dt;
      if (q.drag) { const f = Math.exp(-q.drag * dt); q.vx *= f; q.vy *= f; q.vz *= f; }
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      if (q.bounceZ !== undefined && q.z < q.bounceZ && q.vz < 0) { q.z = q.bounceZ; q.vz = -q.vz * 0.35; q.vx *= 0.6; q.vy *= 0.6; }
      q.rot += q.spin * dt;
      off[n * 3] = q.x; off[n * 3 + 1] = q.y; off[n * 3 + 2] = q.z;
      sz[n] = q.size * (1 + q.grow * k) * (1 - q.shrink * k);
      col[n * 3] = q.r; col[n * 3 + 1] = q.g; col[n * 3 + 2] = q.b;
      // fade: 1 = linear fade out, 2 = fade in then out, 3 = quadratic fade out, 4 = puff (12% fade in, slow tail), 0 = constant
      al[n] = q.alpha * (q.fade === 2 ? Math.sin(k * Math.PI) : q.fade === 1 ? (1 - k) : q.fade === 3 ? (1 - k) * (1 - k) : q.fade === 4 ? (k < 0.12 ? k / 0.12 : Math.pow(1 - (k - 0.12) / 0.88, 1.3)) : 1);
      rt[n] = q.rot; pxa[n] = q.px;
      n++;
    }
    this.geo.instanceCount = n;
    if (n) { this.offset.needsUpdate = true; this.size.needsUpdate = true; this.color.needsUpdate = true; this.alpha.needsUpdate = true; this.rot.needsUpdate = true; this.px.needsUpdate = true; }
    this.mesh.visible = n > 0;
  }
  get active() { return this.p.length; }
}
