// Fixed-size effect pools, all allocated once: a CPU particle system (one Points draw), zombie state markers
// ('?' / '!' as two screen-sized Points draws), horde eye glow (one additive Points draw), blob shadows (one
// InstancedMesh), the melee swing arc, and the muzzle flash sprite. No object is ever added to or removed from
// the scene at runtime.
import * as THREE from 'three';

const MAX_PARTICLES = 900, MAX_ENTITIES = 96;

function softCircle(size = 64, hard = 0.35) {
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2); grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(hard, 'rgba(255,255,255,0.9)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, size, size); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function glyph(text, color) {
  const c = document.createElement('canvas'); c.width = c.height = 96; const g = c.getContext('2d');
  g.font = 'bold 76px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 12; g.strokeStyle = 'rgba(0,0,0,0.9)'; g.strokeText(text, 48, 52); g.fillStyle = color; g.fillText(text, 48, 52);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function pointsSet(n, material) {
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); geo.setDrawRange(0, 0);
  const p = new THREE.Points(geo, material); p.frustumCulled = false; p.renderOrder = 5; return p;
}

export class Effects {
  constructor(scene) {
    this.scene = scene; this.tex = softCircle();
    // ---- particles: position/colour/size/alpha attributes, simple gravity + drag on the CPU ----
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX_PARTICLES * 3); this.col = new Float32Array(MAX_PARTICLES * 3); this.size = new Float32Array(MAX_PARTICLES); this.alpha = new Float32Array(MAX_PARTICLES);
    this.vel = new Float32Array(MAX_PARTICLES * 3); this.life = new Float32Array(MAX_PARTICLES); this.maxLife = new Float32Array(MAX_PARTICLES); this.grav = new Float32Array(MAX_PARTICLES); this.baseSize = new Float32Array(MAX_PARTICLES);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3)); geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1)); geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setDrawRange(0, 0);
    this.pmat = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.tex }, scale: { value: 540 } }, transparent: true, depthWrite: false, vertexColors: true,
      vertexShader: 'attribute float size; attribute float alpha; varying vec3 vC; varying float vA; uniform float scale; void main(){ vC = color; vA = alpha; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform sampler2D map; varying vec3 vC; varying float vA; void main(){ vec4 t = texture2D(map, gl_PointCoord); if (t.a < 0.05) discard; gl_FragColor = vec4(vC, t.a * vA); }',
    });
    this.points = new THREE.Points(geo, this.pmat); this.points.frustumCulled = false; this.points.renderOrder = 6; scene.add(this.points);
    this.count = 0; this.next = 0;
    // ---- markers + eyes ----
    // fog: false on all three: they are UI-like overlays that must stay readable at night when the scene fogs to near-black
    this.markQ = pointsSet(MAX_ENTITIES, new THREE.PointsMaterial({ map: glyph('?', '#ffd23a'), size: 46, sizeAttenuation: false, transparent: true, depthTest: false, depthWrite: false, alphaTest: 0.05, fog: false }));
    this.markX = pointsSet(MAX_ENTITIES, new THREE.PointsMaterial({ map: glyph('!', '#ff3b2e'), size: 50, sizeAttenuation: false, transparent: true, depthTest: false, depthWrite: false, alphaTest: 0.05, fog: false }));
    this.eyes = pointsSet(MAX_ENTITIES * 2, new THREE.PointsMaterial({ map: this.tex, color: 0xff6a30, size: 16, sizeAttenuation: false, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, fog: false }));
    scene.add(this.markQ, this.markX, this.eyes);
    // ---- blob shadows ----
    this.shadows = new THREE.InstancedMesh(new THREE.CircleGeometry(0.42, 14).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }), MAX_ENTITIES);
    this.shadows.frustumCulled = false; this.shadows.renderOrder = 1; this.shadows.position.y = 0.015; scene.add(this.shadows);
    // ---- swing arc + muzzle flash ----
    this.arc = new THREE.Mesh(new THREE.RingGeometry(0.55, 1.35, 18, 1, 0, 1.5).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    this.arc.visible = false; this.arc.renderOrder = 4; scene.add(this.arc); this.arcT = 0;
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, color: 0xffd080, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
    this.flash.scale.setScalar(1.7); this.flash.visible = false; this.flash.renderOrder = 7; scene.add(this.flash); this.flashT = 0;
    this.flashLight = new THREE.PointLight(0xffc070, 0, 7, 2); scene.add(this.flashLight);   // fixed pool member: intensity 0 when idle
    this._m = new THREE.Matrix4(); this._c = new THREE.Color();
  }
  setViewport(h) { this.pmat.uniforms.scale.value = h * 0.5; }
  // Spawn n particles at (x, yUp, z). opts: color, spread, up, size, life, grav, dir [dx, dz] bias.
  burst(n, x, y, z, o) {
    const c = this._c.set(o.color);
    for (let k = 0; k < n; k++) {
      const i = this.next; this.next = (this.next + 1) % MAX_PARTICLES; if (this.count < MAX_PARTICLES) this.count++;
      const a = Math.random() * Math.PI * 2, r = Math.random() * (o.spread ?? 2);
      this.pos.set([x + (Math.random() - 0.5) * 0.2, y + (Math.random() - 0.5) * 0.2, z + (Math.random() - 0.5) * 0.2], i * 3);
      this.vel.set([Math.cos(a) * r + (o.dir ? o.dir[0] * (o.push ?? 1.5) : 0), (o.up ?? 2) * (0.4 + Math.random() * 0.8), Math.sin(a) * r + (o.dir ? o.dir[1] * (o.push ?? 1.5) : 0)], i * 3);
      const cc = c.clone().offsetHSL(0, 0, (Math.random() - 0.5) * 0.15); this.col.set([cc.r, cc.g, cc.b], i * 3);
      this.baseSize[i] = (o.size ?? 0.12) * (0.7 + Math.random() * 0.6); this.life[i] = this.maxLife[i] = (o.life ?? 0.6) * (0.7 + Math.random() * 0.6); this.grav[i] = o.grav ?? 9;
    }
  }
  update(dt) {
    const g = this.points.geometry; let hi = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; this.size[i] = 0; continue; }
      this.life[i] -= dt; const u = Math.max(0, this.life[i] / this.maxLife[i]);
      this.vel[i * 3 + 1] -= this.grav[i] * dt; const drag = 1 - Math.min(1, dt * 2.5);
      this.vel[i * 3] *= drag; this.vel[i * 3 + 2] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.03) { this.pos[i * 3 + 1] = 0.03; this.vel[i * 3 + 1] = 0; this.vel[i * 3] *= 0.5; this.vel[i * 3 + 2] *= 0.5; }
      this.alpha[i] = Math.min(1, u * 2); this.size[i] = this.baseSize[i] * (0.6 + 0.4 * u); hi = i + 1;
    }
    g.setDrawRange(0, hi); g.attributes.position.needsUpdate = g.attributes.color.needsUpdate = g.attributes.size.needsUpdate = g.attributes.alpha.needsUpdate = true;
    if (this.arcT > 0) { this.arcT -= dt; this.arc.material.opacity = Math.max(0, this.arcT / 0.18) * 0.55; this.arc.visible = this.arcT > 0; }
    if (this.flashT > 0) { this.flashT -= dt; const u = Math.max(0, this.flashT / 0.1); this.flash.material.opacity = u; this.flashLight.intensity = 60 * u; this.flash.visible = this.flashT > 0; if (!this.flash.visible) this.flashLight.intensity = 0; }
  }
  swing(x, z, facing) { this.arc.position.set(x, 1.05, z); this.arc.rotation.set(-Math.PI / 2, 0, 0); this.arc.rotation.z = -facing - 0.75; this.arcT = 0.18; this.arc.visible = true; }
  muzzle(x, y, z) { this.flash.position.set(x, y, z); this.flashLight.position.set(x, y + 0.2, z); this.flashT = 0.1; this.flash.visible = true; this.flash.material.opacity = 1; this.flashLight.intensity = 60; }
  // Per-frame marker / eye / shadow buffers. items: [{ x, y, z, mark: '?'|'!'|null, eyes: [v3, v3]|null, r }]
  writeEntities(items, dark) {
    let q = 0, xm = 0, e = 0, s = 0; const pq = this.markQ.geometry.attributes.position, px = this.markX.geometry.attributes.position, pe = this.eyes.geometry.attributes.position;
    for (const it of items) {
      if (s < MAX_ENTITIES) { this._m.makeScale(it.r, 1, it.r).setPosition(it.x, 0, it.z); this.shadows.setMatrixAt(s++, this._m); }
      if (it.mark === '?' && q < MAX_ENTITIES) pq.set([it.x, it.y, it.z], (q++) * 3);
      if (it.mark === '!' && xm < MAX_ENTITIES) px.set([it.x, it.y, it.z], (xm++) * 3);
      if (it.eyes && e < MAX_ENTITIES * 2) { pe.set([it.eyes[0].x, it.eyes[0].y, it.eyes[0].z, it.eyes[1].x, it.eyes[1].y, it.eyes[1].z], e * 3); e += 2; }
    }
    this.shadows.count = s; this.shadows.instanceMatrix.needsUpdate = true;
    this.markQ.geometry.setDrawRange(0, q); this.markX.geometry.setDrawRange(0, xm); this.eyes.geometry.setDrawRange(0, e);
    pq.needsUpdate = px.needsUpdate = pe.needsUpdate = true;
    this.eyes.material.opacity = Math.max(0, dark - 0.25) * 1.3; this.eyes.visible = e > 0 && this.eyes.material.opacity > 0.02;
  }
}
