// Instanced billboard particles: one draw call per pool regardless of particle count. Used for sparks, embers,
// smoke, blood, glows, muzzle flashes, fireballs and trail puffs. Simulation is plain JS (velocity, gravity, drag,
// growth, fade, frame playback); the GPU only receives packed per-instance attributes (offset, size, color, alpha,
// rotation, frame) once per frame. A pool draws either a single sprite texture or a sprite SHEET (grid of frames,
// all canvas-generated here): a particle then shows one frame (a variant) or plays the frames over its life via a
// UV offset in the vertex shader, so an animated fireball costs exactly what a static puff costs.
import * as THREE from 'three';

// Two safety valves keep effects from covering the screen at point-blank range (a real problem with the LG end
// sparks and muzzle glows): `px` caps a particle's on-screen height in pixels (0 = uncapped, e.g. fireballs) and
// `nearFade` (world units) fades particles out as they pass the camera.
const VERT = `
attribute vec3 offset; attribute float size; attribute vec3 color; attribute float alpha; attribute float rot; attribute float px; attribute float frame;
uniform float halfH; uniform float nearFade; uniform vec2 sheet;
varying vec2 vUv; varying vec4 vColor;
void main() {
  float col = mod(frame, sheet.x), row = sheet.y - 1.0 - floor(frame / sheet.x);
  vUv = (uv + vec2(col, row)) / sheet;
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

// ---------- procedural sprite textures (no external assets) ----------
const hash = (x, y) => { const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return s - Math.floor(s); };
function vnoise(x, y, scale) { // smooth value noise in 0..1
  const xs = x / scale, ys = y / scale, x0 = Math.floor(xs), y0 = Math.floor(ys), fx = xs - x0, fy = ys - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0), b = hash(x0 + 1, y0), c = hash(x0, y0 + 1), d = hash(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
const fbm = (x, y, scale, oct = 3) => { let v = 0, amp = 0.5, s = scale, sum = 0; for (let i = 0; i < oct; i++) { v += vnoise(x, y, s) * amp; sum += amp; amp *= 0.5; s /= 2; } return v / sum; };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
function texFromCanvas(c) { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t; }

// Single-frame sprites (alpha only, white RGB).
function spriteTexture(kind) {
  const s = 64, c = document.createElement('canvas'); c.width = c.height = s; const ctx = c.getContext('2d');
  const img = ctx.createImageData(s, s); const d = img.data;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const dx = (x + 0.5) / s - 0.5, dy = (y + 0.5) / s - 0.5; const r = Math.hypot(dx, dy) * 2;
    let a, rgb = 1;
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
    } else if (kind === 'bullethole') { // bullet mark: small dark pit with a chipped rim
      const n = vnoise(x * 2, y * 2, 6);
      const edge = 0.55 + n * 0.3;
      a = smooth(edge + 0.25, edge - 0.05, r) * (0.55 + 0.45 * smooth(0.5, 0.1, r));
    } else if (kind === 'ring') { // shockwave / pad ring: a soft-edged annulus on a disc (RingGeometry's planar UVs gave a hard inner edge)
      const k = (r - 0.8) / 0.13; a = Math.exp(-k * k) * (r < 1 ? 1 : 0);
    } else if (kind === 'streak') { // spark streak: bright horizontal line with a hot centre
      const k = Math.abs(dy) * 2 / 0.22; a = Math.exp(-k * k) * Math.max(0, 1 - Math.pow(Math.abs(dx) * 2, 3));
    } else { // smoke: a dense ragged puff (Q3 smokePuff look): solid enough that one puff reads on its own, soft edge
      const n = Math.sin(x * 0.9 + Math.sin(y * 0.7) * 3) * 0.5 + Math.sin(y * 1.3 + x * 0.4) * 0.5;
      a = Math.max(0, 1 - r * (1.02 + n * 0.14)); a = Math.pow(a * a * (3 - 2 * a), 0.8) * 0.95;
    }
    const i = (y * s + x) * 4; d[i] = d[i + 1] = d[i + 2] = Math.round(255 * rgb); d[i + 3] = Math.round(clamp01(a) * 255);
  }
  ctx.putImageData(img, 0, 0);
  return texFromCanvas(c);
}
const TEX = {};
export function getSprite(kind) { return TEX[kind] || (TEX[kind] = spriteTexture(kind)); }

// ---------- sprite sheets: { tex, cols, rows, n } ----------
// paint(px, x, y, fx, fy, r, angle, frame): writes [r,g,b,a] into px for a pixel of one cell
// (fx, fy in -1..1 across the cell, r = radius 0..1.4 from the centre, angle in radians).
function sheet(cols, rows, cell, paint) {
  const c = document.createElement('canvas'); c.width = cols * cell; c.height = rows * cell; const ctx = c.getContext('2d');
  const img = ctx.createImageData(c.width, c.height); const d = img.data; const px = [0, 0, 0, 0];
  for (let f = 0; f < cols * rows; f++) {
    const ox = (f % cols) * cell, oy = Math.floor(f / cols) * cell;
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
      const fx = ((x + 0.5) / cell - 0.5) * 2, fy = ((y + 0.5) / cell - 0.5) * 2;
      px[0] = px[1] = px[2] = px[3] = 0;
      paint(px, x, y, fx, fy, Math.hypot(fx, fy), Math.atan2(fy, fx), f);
      const i = ((oy + y) * c.width + ox + x) * 4;
      d[i] = Math.round(clamp01(px[0]) * 255); d[i + 1] = Math.round(clamp01(px[1]) * 255); d[i + 2] = Math.round(clamp01(px[2]) * 255); d[i + 3] = Math.round(clamp01(px[3]) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return { tex: texFromCanvas(c), cols, rows, n: cols * rows };
}
// fire gradient by heat 0..1: dark ember -> red -> orange -> yellow -> white (linear values, hue kept under ACES)
function fireColor(px, heat, a) {
  let r, g, b;
  if (heat > 0.75) { const t = (heat - 0.75) / 0.25; r = 1; g = mix(0.8, 1, t); b = mix(0.35, 0.9, t); }
  else if (heat > 0.45) { const t = (heat - 0.45) / 0.3; r = 1; g = mix(0.42, 0.8, t); b = mix(0.06, 0.35, t); }
  else if (heat > 0.15) { const t = (heat - 0.15) / 0.3; r = mix(0.55, 1, t); g = mix(0.1, 0.42, t); b = mix(0.02, 0.06, t); }
  else { const t = heat / 0.15; r = mix(0.12, 0.55, t); g = mix(0.08, 0.1, t); b = mix(0.06, 0.02, t); }
  px[0] = r; px[1] = g; px[2] = b; px[3] = a;
}
function sheetTexture(kind) {
  switch (kind) {
    case 'explosion': // 16-frame fireball: a lumpy ball of fire that bursts, billows outward, cools to red and thins into soot
      return sheet(4, 4, 64, (px, x, y, fx, fy, r, ang, f) => {
        const t = f / 15;
        const R = 0.3 + 0.62 * Math.pow(t, 0.55);                         // outer radius grows fast then settles
        // lobes: several blobs pushed outward with time, each with its own angular position
        let field = 0;
        for (let k = 0; k < 5; k++) {
          const ba = k * 1.2566 + hash(k, 3) * 0.8, bd = (0.12 + 0.3 * t) * (0.6 + hash(k, 7) * 0.6), br = R * (0.45 + hash(k, 11) * 0.25) * (1 - t * 0.25);
          const bx = Math.cos(ba) * bd, by = Math.sin(ba) * bd;
          const dd = Math.hypot(fx - bx, fy - by) / br;
          field += Math.max(0, 1 - dd * dd);
        }
        field += Math.max(0, 1 - (r / (R * 0.7)) ** 2) * (1.2 - t * 0.9);  // core mass, fades out with time
        const turb = fbm(x + f * 17, y + f * 31, 6 + t * 8, 3) - 0.5;       // ragged edge, more turbulent late
        field += turb * (0.35 + 0.6 * t);
        const body = smooth(0.15, 0.6, field);
        if (body <= 0) return;
        // heat: white only in the core of the first frames, orange body, red rim; interior grain so overlapping
        // sprites (additive) stay textured instead of saturating into one flat disc
        const heat = clamp01((field - 0.25) * (1 - t * 0.85) * 0.65 + (1 - r / R) * 0.22 * Math.max(0, 1 - t * 2.5));
        const grain = 0.55 + 0.45 * clamp01(0.5 + turb * 2.4);
        const fade = t < 0.3 ? 1 : 1 - (t - 0.3) / 0.7;
        fireColor(px, heat, body * fade * grain);
        if (t > 0.55) { const s = (t - 0.55) / 0.45; px[0] = mix(px[0], 0.2, s * 0.8); px[1] = mix(px[1], 0.16, s * 0.8); px[2] = mix(px[2], 0.14, s * 0.8); }
      });
    case 'smoke4': // four puff variants, each a different ragged shape
      return sheet(2, 2, 64, (px, x, y, fx, fy, r, ang, f) => {
        const n = fbm(x + f * 53, y + f * 29, 10, 3) - 0.5;
        let a = Math.max(0, 1 - r * (1.0 + n * 0.5)); a = Math.pow(a * a * (3 - 2 * a), 0.85);
        const shade = 0.85 + 0.3 * (fbm(x + f * 7, y + f * 13, 5, 2) - 0.5); // internal mottling so overlapping puffs read as volume
        px[0] = px[1] = px[2] = shade; px[3] = a * 0.95;
      });
    case 'blood4': // splats: an irregular blob with a few droplets thrown off one side
      return sheet(2, 2, 64, (px, x, y, fx, fy, r, ang, f) => {
        const n = fbm(x + f * 41, y + f * 61, 7, 3) - 0.5;
        let a = smooth(0.85 + n * 0.5, 0.35, r);
        for (let k = 0; k < 4; k++) { const da = f * 1.9 + k * 1.3 + hash(k, f) * 0.6, dd = 0.55 + hash(k, f + 9) * 0.35, dr = 0.08 + hash(k, f + 3) * 0.1; a = Math.max(a, smooth(dr, dr * 0.3, Math.hypot(fx - Math.cos(da) * dd, fy - Math.sin(da) * dd))); }
        const dark = 0.6 + 0.4 * smooth(0, 0.7, r);
        px[0] = 0.55 * dark; px[1] = 0.05 * dark; px[2] = 0.05 * dark; px[3] = a;
      });
    case 'flash': // muzzle flashes: hot core with 6-9 radial tongues, three shapes + a round bloom
      return sheet(2, 2, 64, (px, x, y, fx, fy, r, ang, f) => {
        const tongues = 6 + f, phase = f * 0.7;
        const spikes = Math.pow(Math.max(0, Math.cos((ang + phase) * tongues / 2)), 5) * 0.6 + Math.pow(Math.max(0, Math.cos((ang - phase * 1.7) * (tongues - 1) / 2)), 9) * 0.5;
        const reach = f === 3 ? 0.55 : 0.4 + spikes * 0.55;
        const a = smooth(reach, reach * 0.35, r) * (0.7 + 0.3 * (fbm(x * 2 + f * 30, y * 2, 6, 2)));
        const core = smooth(0.35, 0.05, r);
        px[0] = 1; px[1] = mix(0.75, 1, core); px[2] = mix(0.35, 0.9, core); px[3] = a;
      });
    case 'plasma': // 4-frame swirling bolt: white core, two rotating arcs, purple halo
      return sheet(2, 2, 64, (px, x, y, fx, fy, r, ang, f) => {
        const rotA = f * 0.8;
        const arcs = Math.pow(Math.max(0, Math.sin(ang * 2 + rotA + r * 5)), 6) * smooth(0.95, 0.5, r) * smooth(0.25, 0.45, r);
        const core = smooth(0.4, 0.0, r), halo = Math.max(0, 1 - r * r) * 0.55;
        const a = clamp01(core + arcs * 0.9 + halo);
        px[0] = mix(0.7, 1, core); px[1] = mix(0.42, 0.95, core); px[2] = 1; px[3] = a;
      });
    case 'ring4': // expanding rings: thin to thick, with a hot inner edge (rail rings, shock ring)
      return sheet(2, 2, 64, (px, x, y, fx, fy, r, ang, f) => {
        const w = 0.08 + f * 0.05, k = (r - (0.86 - f * 0.04)) / w; const a = Math.exp(-k * k) * (r < 1 ? 1 : 0);
        px[0] = px[1] = px[2] = 1; px[3] = a;
      });
    case 'bolt': // 2 rows of jagged lightning, tileable along x: bright core + soft halo (scrolls along the LG beam)
      return sheet(1, 2, 128, (px, x, y, fx, fy, r, ang, f) => {
        // random-walk centre line, periodic in x so the strip tiles
        const cy = (x0) => { let v = 0; for (let k = 1; k <= 4; k++) v += Math.sin((x0 / 128) * Math.PI * 2 * k * (1 + f) + hash(k, f) * 6.28) * (0.32 / k); return v * 0.9; };
        const c = cy(x), c2 = cy(x + 40) * 0.5 + 0.35 * (f ? -1 : 1);
        const d1 = Math.abs(fy - c), d2 = Math.abs(fy - c2);
        const core = Math.exp(-(d1 * d1) / 0.006) + Math.exp(-(d2 * d2) / 0.003) * 0.5, halo = Math.exp(-(d1 * d1) / 0.12) * 0.35;
        const a = clamp01(core + halo);
        px[0] = mix(0.55, 1, core); px[1] = mix(0.75, 1, core); px[2] = 1; px[3] = a;
      });
    default: throw new Error('unknown sheet ' + kind);
  }
}
const SHEETS = {};
export function getSheet(kind) { return SHEETS[kind] || (SHEETS[kind] = sheetTexture(kind)); }

// Half the render-target height in pixels, shared by every pool's screen-size clamp (the renderer sets it on resize).
const HALF_H = { value: 540 };
export function setParticleViewport(heightPx) { HALF_H.value = Math.max(1, heightPx / 2); }

export class ParticlePool {
  // { additive, texture (single sprite) | sheet (frame grid), depthTest, maxPx, nearFade }
  constructor(scene, capacity, { additive = false, texture = 'soft', sheet = null, depthTest = true, maxPx = 0, nearFade = 0 } = {}) {
    this.capacity = capacity; this.count = 0; this.maxPx = maxPx;
    this.p = []; // active particle records
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const attr = (n) => new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n).setUsage(THREE.DynamicDrawUsage);
    this.offset = attr(3); this.size = attr(1); this.color = attr(3); this.alpha = attr(1); this.rot = attr(1); this.px = attr(1); this.frame = attr(1);
    geo.setAttribute('offset', this.offset); geo.setAttribute('size', this.size); geo.setAttribute('color', this.color); geo.setAttribute('alpha', this.alpha); geo.setAttribute('rot', this.rot); geo.setAttribute('px', this.px); geo.setAttribute('frame', this.frame);
    geo.instanceCount = 0;
    const sh = sheet ? getSheet(sheet) : null;
    this.frames = sh ? sh.n : 1;
    const mat = new THREE.ShaderMaterial({ uniforms: { map: { value: sh ? sh.tex : getSprite(texture) }, halfH: HALF_H, nearFade: { value: nearFade }, sheet: { value: new THREE.Vector2(sh ? sh.cols : 1, sh ? sh.rows : 1) } }, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    this.mesh = new THREE.Mesh(geo, mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = additive ? 20 : 10;
    scene.add(this.mesh);
    this.geo = geo;
  }
  // spawn({ pos, vel, life, size, grow, color:[r,g,b], alpha, gravity, drag, rot, spin, fade, px (max screen px, 0 = none),
  //         frame (sheet cell / variant; -1 = random variant), anim (play this many frames from `frame` over the life), delay (ms before it appears) })
  spawn(o) {
    if (this.p.length >= this.capacity) this.p.shift();
    const c = o.color || [1, 1, 1];
    let frame = o.frame || 0; if (frame < 0) frame = Math.floor(Math.random() * this.frames);
    this.p.push({ x: o.pos[0], y: o.pos[1], z: o.pos[2], vx: o.vel ? o.vel[0] : 0, vy: o.vel ? o.vel[1] : 0, vz: o.vel ? o.vel[2] : 0, t: -(o.delay || 0), life: o.life || 500, size: o.size || 4, grow: o.grow || 0, r: c[0], g: c[1], b: c[2], alpha: o.alpha ?? 1, gravity: o.gravity || 0, drag: o.drag || 0, rot: o.rot || 0, spin: o.spin || 0, fade: o.fade ?? 1, bounceZ: o.bounceZ, shrink: o.shrink || 0, px: o.px ?? this.maxPx, frame, anim: o.anim || 0 });
  }
  update(dt) {
    const p = this.p; let n = 0;
    const off = this.offset.array, sz = this.size.array, col = this.color.array, al = this.alpha.array, rt = this.rot.array, pxa = this.px.array, fr = this.frame.array;
    for (let i = 0; i < p.length; i++) {
      const q = p[i];
      q.t += dt * 1000;
      if (q.t >= q.life) { p[i] = p[p.length - 1]; p.pop(); i--; continue; }
      if (q.t < 0) continue; // delayed: not yet born
      const k = q.t / q.life;
      if (q.gravity) q.vz -= q.gravity * dt;
      if (q.drag) { const f = Math.exp(-q.drag * dt); q.vx *= f; q.vy *= f; q.vz *= f; }
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      if (q.bounceZ !== undefined && q.z < q.bounceZ && q.vz < 0) { q.z = q.bounceZ; q.vz = -q.vz * 0.35; q.vx *= 0.6; q.vy *= 0.6; }
      q.rot += q.spin * dt;
      off[n * 3] = q.x; off[n * 3 + 1] = q.y; off[n * 3 + 2] = q.z;
      sz[n] = q.size * (1 + q.grow * k) * (1 - q.shrink * k);
      col[n * 3] = q.r; col[n * 3 + 1] = q.g; col[n * 3 + 2] = q.b;
      // fade: 1 = linear fade out, 2 = fade in then out, 3 = quadratic fade out, 4 = puff (12% fade in, slow tail), 5 = hold then quick out, 0 = constant
      al[n] = q.alpha * (q.fade === 2 ? Math.sin(k * Math.PI) : q.fade === 1 ? (1 - k) : q.fade === 3 ? (1 - k) * (1 - k) : q.fade === 4 ? (k < 0.12 ? k / 0.12 : Math.pow(1 - (k - 0.12) / 0.88, 1.3)) : q.fade === 5 ? (k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3) : 1);
      rt[n] = q.rot; pxa[n] = q.px;
      fr[n] = q.anim ? q.frame + Math.min(q.anim - 1, Math.floor(k * q.anim)) : q.frame;
      n++;
    }
    this.geo.instanceCount = n;
    if (n) { this.offset.needsUpdate = true; this.size.needsUpdate = true; this.color.needsUpdate = true; this.alpha.needsUpdate = true; this.rot.needsUpdate = true; this.px.needsUpdate = true; this.frame.needsUpdate = true; }
    this.mesh.visible = n > 0;
  }
  get active() { return this.p.length; }
}
