// Procedural PBR materials (canvas-generated albedo / normal / roughness / emissive). No external assets.
// Every material is described by a "kind" (the procedural pattern) plus a palette; the map picks materials by name.
// Textures are generated lazily on first use so a map only pays for the materials it references.
import * as THREE from 'three';

const cache = new Map();

function canvas(size) { const c = document.createElement('canvas'); c.width = c.height = size; return c; }
function hash(x, y, seed = 0) { const s = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453; return s - Math.floor(s); }
// Tileable value noise: lattice coordinates wrap at `period` so the texture repeats seamlessly.
function vnoise(x, y, scale, seed, period) {
  const xs = x / scale, ys = y / scale, x0 = Math.floor(xs), y0 = Math.floor(ys), fx = xs - x0, fy = ys - y0;
  const p = Math.max(1, Math.round(period / scale));
  const w = (i) => ((i % p) + p) % p;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(w(x0), w(y0), seed), b = hash(w(x0 + 1), w(y0), seed), c = hash(w(x0), w(y0 + 1), seed), d = hash(w(x0 + 1), w(y0 + 1), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm(x, y, seed, oct = 4, scale = 32, period = 256) { let v = 0, amp = 0.5, s = scale, sum = 0; for (let i = 0; i < oct; i++) { v += vnoise(x, y, s, seed + i, period) * amp; sum += amp; amp *= 0.5; s = Math.max(1, s / 2); } return v / sum; }
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

function makeTexture(size, painter, opts = {}) {
  const c = canvas(size); const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  painter(img.data, size);
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = opts.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace; t.anisotropy = 8;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
// Height map -> tangent-space normal map (Sobel-ish central differences, wrapping).
function normalFromHeight(size, H, strength = 2) {
  return makeTexture(size, (d, s) => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const i = (y * s + x);
      const l = H[y * s + ((x - 1 + s) % s)], r = H[y * s + ((x + 1) % s)], u = H[((y - 1 + s) % s) * s + x], dn = H[((y + 1) % s) * s + x];
      let nx = (l - r) * strength, ny = (u - dn) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
      d[i * 4] = (nx * 0.5 + 0.5) * 255; d[i * 4 + 1] = (ny * 0.5 + 0.5) * 255; d[i * 4 + 2] = (nz * 0.5 + 0.5) * 255; d[i * 4 + 3] = 255;
    }
  }, { linear: true });
}

// Material definitions. base = albedo tint (linear-ish 0..1), kind = pattern, scale = world units per texture repeat.
const DEFS = {
  // floors
  // Metalness stays <= 0.35 on world surfaces (there is no environment map: higher values only delete the baked
  // diffuse, see world.js). Steel is warm grey rather than blue-grey so a cool-lit room keeps some red in its mean.
  floor: { base: [0.47, 0.44, 0.40], kind: 'plates', rough: 0.62, metal: 0.3, scale: 128 },
  floor2: { base: [0.32, 0.32, 0.34], kind: 'grate', rough: 0.55, metal: 0.35, scale: 64 },
  grate: { base: [0.32, 0.32, 0.34], kind: 'grate', rough: 0.55, metal: 0.35, scale: 64 },
  concrete: { base: [0.50, 0.48, 0.45], kind: 'concrete', rough: 0.92, metal: 0.0, scale: 128 },
  stone: { base: [0.40, 0.37, 0.34], kind: 'blocks', rough: 0.9, metal: 0.0, scale: 128 },
  // walls
  wall: { base: [0.46, 0.40, 0.34], kind: 'blocks', rough: 0.85, metal: 0.05, scale: 128 },
  wall2: { base: [0.50, 0.46, 0.41], kind: 'panels', rough: 0.55, metal: 0.3, scale: 128 },
  metal: { base: [0.44, 0.44, 0.45], kind: 'panels', rough: 0.45, metal: 0.35, scale: 128 },
  tech: { base: [0.34, 0.35, 0.38], kind: 'tech', rough: 0.45, metal: 0.35, scale: 128, emissive: [0.95, 0.55, 0.18], emissiveIntensity: 1.25 },
  ceiling: { base: [0.28, 0.28, 0.30], kind: 'vents', rough: 0.75, metal: 0.25, scale: 128 },
  // Trims (thin bands): metallic with a recessed emissive strip in the middle. Emissive values sit at ~1.0-1.2 in
  // their strongest channel: ACES desaturates anything much brighter into white, and id Tech 3's look is saturated
  // coloured light, so the hue is carried by the ratio between channels, not by intensity.
  trim: { base: [0.62, 0.48, 0.28], kind: 'trim', rough: 0.35, metal: 0.35, scale: 64 },
  trim_warm: { base: [0.55, 0.45, 0.32], kind: 'trim', rough: 0.35, metal: 0.35, scale: 64, emissive: [1.0, 0.55, 0.18], emissiveIntensity: 1.2 },
  trim_cool: { base: [0.36, 0.42, 0.50], kind: 'trim', rough: 0.35, metal: 0.35, scale: 64, emissive: [0.22, 0.55, 1.0], emissiveIntensity: 1.1 },
  trim_red: { base: [0.45, 0.32, 0.30], kind: 'trim', rough: 0.35, metal: 0.35, scale: 64, emissive: [1.0, 0.18, 0.1], emissiveIntensity: 1.2 },
  trim_green: { base: [0.32, 0.45, 0.34], kind: 'trim', rough: 0.35, metal: 0.35, scale: 64, emissive: [0.3, 1.0, 0.38], emissiveIntensity: 1.2 },
  // special surfaces
  jumppad: { base: [0.25, 0.45, 0.75], kind: 'pad', rough: 0.3, metal: 0.35, scale: 64, emissive: [0.18, 0.5, 1.0], emissiveIntensity: 1.3 },
  teleporter: { base: [0.55, 0.25, 0.85], kind: 'pad', rough: 0.3, metal: 0.35, scale: 64, emissive: [0.6, 0.22, 1.0], emissiveIntensity: 1.2 },
  lava: { base: [1, 0.35, 0.05], kind: 'lava', rough: 0.9, metal: 0, scale: 128, emissive: [1.0, 0.3, 0.04], emissiveIntensity: 1.5 },
  // light panels: dark albedo (the room's lights must not add white on top of the emissive), saturated emissive
  glow_warm: { base: [0.22, 0.16, 0.09], kind: 'flat', rough: 0.6, metal: 0, scale: 64, emissive: [1.0, 0.68, 0.32], emissiveIntensity: 1.1 },
  glow_cool: { base: [0.09, 0.15, 0.22], kind: 'flat', rough: 0.6, metal: 0, scale: 64, emissive: [0.2, 0.52, 1.0], emissiveIntensity: 1.0 },
  glow_red: { base: [0.22, 0.07, 0.06], kind: 'flat', rough: 0.6, metal: 0, scale: 64, emissive: [1.0, 0.2, 0.14], emissiveIntensity: 1.1 },
  glow_green: { base: [0.08, 0.2, 0.1], kind: 'flat', rough: 0.6, metal: 0, scale: 64, emissive: [0.28, 1.0, 0.4], emissiveIntensity: 1.1 },
  clip: { invisible: true },
  sky: { base: [0.03, 0.04, 0.08], kind: 'flat', rough: 1, metal: 0, scale: 64, emissive: [0.02, 0.03, 0.06], emissiveIntensity: 1, unlit: true },
};

// Pattern generators. Each returns { h(x,y) height 0..1, tint(x,y,h) albedo multiplier, wear(x,y,h) 0..1 exposed-metal mask, glow(x,y) 0..1 emissive mask }.
function pattern(kind, seed, s) {
  const grime = (x, y, sc = 64) => fbm(x, y, seed + 9, 4, sc, s);
  // Rust speckle: fine-grained (no big blotches: those read as paint splashes) plus medium patches on the more worn
  // plates. ~25% coverage on steel, the warm accent of a Q3 base texture.
  const speckle = (x, y, worn = 0) => smooth(0.65 - worn * 0.1, 0.78 - worn * 0.1, fbm(x, y, seed + 61, 3, 6, s)) * (0.4 + 0.6 * smooth(0.4, 0.7, fbm(x, y, seed + 63, 2, 40, s)));
  const scratches = (x, y) => { // sparse thin diagonal streaks of exposed metal
    const a = fbm(x * 0.35 + y, y * 0.05, seed + 21, 2, 6, s);
    return smooth(0.78, 0.84, a) * 0.12 * smooth(0.55, 0.75, fbm(x, y, seed + 31, 2, 16, s));
  };
  switch (kind) {
    case 'plates': { // 2x2 bevelled steel plates with corner rivets, scratches and grime in the seams
      const cell = s / 2;
      const h = (x, y) => {
        const gx = (x % cell) / cell, gy = (y % cell) / cell;
        const edge = Math.min(gx, 1 - gx, gy, 1 - gy);
        const bevel = smooth(0, 0.03, edge);
        const rx = Math.min(gx, 1 - gx) * cell, ry = Math.min(gy, 1 - gy) * cell;
        const rivet = Math.hypot(rx - 10, ry - 10) < 3.5 ? 0.85 : 1;
        return bevel * 0.85 * rivet + fbm(x, y, seed, 3, 24, s) * 0.15 - scratches(x, y) * 0.1;
      };
      // per-plate brightness (hash of the plate index): worn plates differ, a Q3 floor is never one flat tone
      const plate = (x, y) => (hash(Math.floor(x / cell), Math.floor(y / cell), seed + 41) - 0.5) * 0.3;
      // rust: blotches on the worn plates plus pooling in the seams (~20% of the surface, like a Q3 base floor); it is
      // the warm accent that keeps a cool-lit steel room from reading as one blue wash
      const worn = (x, y) => smooth(-0.15, 0.15, plate(x, y));
      return { h, tint: (x, y, hv) => 0.45 + hv * 0.6 + plate(x, y) - grime(x, y) * 0.35, wear: (x, y) => scratches(x, y), glow: () => 0, rust: (x, y, hv) => Math.min(1, smooth(0.55, 0.85, grime(x, y)) * (1 - hv * 0.5) * 0.7 + speckle(x, y, worn(x, y)) * 0.85) };
    }
    case 'grate': { // metal grating: bars with dark square holes
      const h = (x, y) => {
        const gx = (x % 16) / 16, gy = (y % 16) / 16;
        const hole = (gx > 0.22 && gx < 0.78 && gy > 0.22 && gy < 0.78) ? 0 : 1;
        return hole * 0.9 + fbm(x, y, seed, 2, 8, s) * 0.1;
      };
      return { h, tint: (x, y, hv) => (hv > 0.5 ? 0.6 + hv * 0.4 - grime(x, y) * 0.3 : 0.08), wear: (x, y, hv) => (hv > 0.5 ? fbm(x, y, seed + 5, 2, 12, s) * 0.5 : 0), glow: () => 0 };
    }
    case 'concrete': { // poured concrete panels with form seams, pits and stains
      const cell = s / 2;
      const h = (x, y) => {
        const gx = (x % cell) / cell, gy = (y % cell) / cell;
        const edge = Math.min(gx, 1 - gx, gy, 1 - gy);
        const seam = smooth(0, 0.025, edge);
        const pits = smooth(0.62, 0.72, fbm(x, y, seed + 3, 3, 6, s));
        return seam * 0.8 - pits * 0.25 + fbm(x, y, seed, 4, 40, s) * 0.2;
      };
      return { h, tint: (x, y, hv) => 0.7 + hv * 0.3 - grime(x, y, 96) * 0.35 - smooth(0.55, 0.9, fbm(x, y * 3, seed + 12, 3, 20, s)) * 0.2, wear: () => 0, glow: () => 0 };
    }
    case 'blocks': { // staggered stone/concrete blocks with mortar
      const bh = s / 4, bw = s / 2;
      const h = (x, y) => {
        const row = Math.floor(y / bh); const off = (row % 2) * (bw / 2);
        const gx = ((x + off) % bw) / bw, gy = (y % bh) / bh;
        const edge = Math.min(gx * (bw / bh), (1 - gx) * (bw / bh), gy, 1 - gy);
        const face = smooth(0, 0.09, edge);
        const chip = fbm(x, y, seed + 4, 3, 10, s);
        return face * (0.7 + fbm(x + row * 13, y, seed, 4, 20, s) * 0.3) - smooth(0.7, 0.85, chip) * 0.2;
      };
      return { h, tint: (x, y, hv) => 0.5 + hv * 0.55 - grime(x, y, 80) * 0.3 + (hash(Math.floor(y / bh), Math.floor((x + (Math.floor(y / bh) % 2) * (bw / 2)) / bw), seed) - 0.5) * 0.12, wear: () => 0, glow: () => 0 };
    }
    case 'panels': { // riveted steel panels (1 wide x 2 tall) with scratches and rust streaks
      const h = (x, y) => {
        const gx = (x % s) / s, gy = (y % (s / 2)) / (s / 2);
        const edge = Math.min(gx, 1 - gx, gy, 1 - gy);
        const px = Math.min(gx, 1 - gx) * s, py = Math.min(gy, 1 - gy) * (s / 2);
        const rivet = ((px > 6 && px < 12) || (py > 6 && py < 12)) && (((x + 8) % 32) < 6) && (((y + 8) % 32) < 6) ? -0.25 : 0;
        return smooth(0, 0.05, edge) * 0.6 + rivet + fbm(x, y, seed, 3, 40, s) * 0.12 - scratches(x, y) * 0.08;
      };
      // vertical rust runs below the rivet rows and per-panel tone (hash of the panel index): the steel reads as
      // individual worn plates with dark seams, not one flat sheet
      const runs = (x, y) => smooth(0.6, 0.88, fbm(x * 0.6, y * 0.15, seed + 7, 2, 10, s));
      const panel = (x, y) => (hash(Math.floor(x / s), Math.floor(y / (s / 2)), seed + 43) - 0.5) * 0.3;
      const worn = (x, y) => smooth(-0.15, 0.15, panel(x, y)); // the more worn panels rust over
      return { h, tint: (x, y, hv) => 0.42 + hv * 0.62 + panel(x, y) - grime(x, y, 96) * 0.28 - runs(x, y) * 0.15, wear: (x, y) => scratches(x, y), glow: () => 0, rust: (x, y) => Math.min(1, runs(x, y) * 0.8 * smooth(0.4, 0.65, fbm(x, y, seed + 17, 2, 24, s)) + speckle(x, y, worn(x, y)) * 0.85) };
    }
    case 'tech': { // machinery panels with small emissive indicator strips
      const h = (x, y) => {
        const gx = (x % (s / 2)) / (s / 2), gy = (y % (s / 2)) / (s / 2);
        const edge = Math.min(gx, 1 - gx, gy, 1 - gy);
        const inset = (gx > 0.15 && gx < 0.85 && gy > 0.6 && gy < 0.7) ? -0.3 : 0;
        return smooth(0, 0.05, edge) * 0.7 + inset + fbm(x, y, seed, 3, 30, s) * 0.12;
      };
      const glow = (x, y) => { const gx = (x % (s / 2)) / (s / 2), gy = (y % (s / 2)) / (s / 2); return (gx > 0.2 && gx < 0.8 && gy > 0.62 && gy < 0.68) ? 1 : 0; };
      return { h, tint: (x, y, hv) => 0.6 + hv * 0.4 - grime(x, y) * 0.25, wear: (x, y) => scratches(x, y), glow };
    }
    case 'vents': { // dark ceiling panels with slotted vents
      const h = (x, y) => {
        const gx = (x % (s / 2)) / (s / 2), gy = (y % (s / 2)) / (s / 2);
        const edge = Math.min(gx, 1 - gx, gy, 1 - gy);
        const slot = (gx > 0.3 && gx < 0.7 && gy > 0.3 && gy < 0.7 && ((y % 8) < 4)) ? -0.4 : 0;
        return smooth(0, 0.05, edge) * 0.7 + slot + fbm(x, y, seed, 3, 30, s) * 0.1;
      };
      return { h, tint: (x, y, hv) => 0.55 + hv * 0.45 - grime(x, y) * 0.3, wear: () => 0, glow: () => 0 };
    }
    case 'trim': { // horizontal trim band: two grooves and a recessed strip in the middle (emissive when the def says so)
      const h = (x, y) => {
        const gy = (y % s) / s;
        const strip = (gy > 0.42 && gy < 0.58) ? -0.35 : 0;
        const groove = (Math.abs(gy - 0.2) < 0.03 || Math.abs(gy - 0.8) < 0.03) ? -0.25 : 0;
        const seg = ((x % (s / 2)) / (s / 2)); const segEdge = smooth(0, 0.04, Math.min(seg, 1 - seg));
        return 0.7 * segEdge + strip + groove + fbm(x, y, seed, 2, 20, s) * 0.08;
      };
      const glow = (x, y) => { const gy = (y % s) / s; return (gy > 0.44 && gy < 0.56) ? 0.85 + fbm(x, y, seed + 2, 2, 12, s) * 0.15 : 0; };
      return { h, tint: (x, y, hv) => 0.55 + hv * 0.45 - grime(x, y) * 0.15, wear: (x, y) => scratches(x, y) * 0.5, glow };
    }
    case 'pad': { // concentric rings, glowing center
      const h = (x, y) => { const cx = x - s / 2, cy = y - s / 2; const r = Math.hypot(cx, cy) / (s / 2); return (Math.sin(r * 18) * 0.5 + 0.5) * 0.4 + (r < 0.9 ? 0.6 : 0); };
      return { h, tint: (x, y, hv) => 0.5 + hv * 0.5, wear: () => 0, glow: (x, y) => { const r = Math.hypot(x - s / 2, y - s / 2) / (s / 2); return r < 0.85 ? 0.35 + (Math.sin(r * 18) * 0.5 + 0.5) * 0.65 : 0; } };
    }
    case 'lava': { const h = (x, y) => fbm(x, y, seed, 5, 48, s); return { h, tint: (x, y, hv) => 0.6 + hv * 1.2, wear: () => 0, glow: (x, y) => 0.5 + smooth(0.4, 0.8, h(x, y)) * 0.5 }; }
    default: { // light panel: faint diffuser mottling and a dim 3-px frame so the panel reads as a fixture, not a flat fill
      const h = (x, y) => fbm(x, y, seed, 2, 32, s) * 0.2;
      const frame = (x, y) => { const gx = x % s, gy = y % s; return Math.min(gx, s - 1 - gx, gy, s - 1 - gy) < 3 ? 0.45 : 1; };
      return { h, tint: (x, y) => frame(x, y), wear: () => 0, glow: (x, y) => (0.88 + fbm(x, y, seed + 4, 3, 24, s) * 0.12) * frame(x, y) };
    }
  }
}

export function getMaterial(name) {
  if (cache.has(name)) return cache.get(name);
  const def = DEFS[name] || DEFS.wall;
  if (def.invisible) { const m = new THREE.MeshBasicMaterial({ visible: false }); cache.set(name, m); return m; }
  const size = 256, seed = name.length * 7 + name.charCodeAt(0);
  const P = pattern(def.kind, seed, size);
  // height field once (shared by albedo, normal, roughness)
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) H[y * size + x] = P.h(x, y);
  const map = makeTexture(size, (d, s) => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const hv = H[y * s + x];
      const shade = P.tint(x, y, hv);
      const wear = P.wear(x, y, hv), rust = P.rust ? clamp01(P.rust(x, y, hv)) : 0;
      const i = (y * s + x) * 4;
      // worn spots expose bare, brighter, desaturated metal; rust runs are matte orange-brown (the warm accents a
      // cool-lit steel room needs so it does not read as one flat blue)
      let r = def.base[0] * shade * (1 - wear) + 0.62 * wear, g = def.base[1] * shade * (1 - wear) + 0.62 * wear, b = def.base[2] * shade * (1 - wear) + 0.64 * wear;
      r += (0.42 * shade - r) * rust; g += (0.2 * shade - g) * rust; b += (0.09 * shade - b) * rust;
      d[i] = Math.min(255, r * 255); d[i + 1] = Math.min(255, g * 255); d[i + 2] = Math.min(255, b * 255); d[i + 3] = 255;
    }
  });
  const normalMap = normalFromHeight(size, H, def.kind === 'lava' ? 1.5 : def.kind === 'concrete' ? 2.2 : 3);
  const roughnessMap = makeTexture(size, (d, s) => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const g = fbm(x, y, seed + 3, 3, 40, s), wear = P.wear(x, y, H[y * s + x]), rust = P.rust ? clamp01(P.rust(x, y, H[y * s + x])) : 0;
      const v = clamp01(def.rough + (g - 0.5) * 0.45 - wear * 0.35 + rust * 0.4);
      const i = (y * s + x) * 4; d[i] = d[i + 1] = d[i + 2] = v * 255; d[i + 3] = 255;
    }
  }, { linear: true });
  const m = new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap, roughness: 1, metalness: def.metal, normalScale: new THREE.Vector2(0.9, 0.9) });
  if (def.emissive) {
    m.emissive = new THREE.Color(...def.emissive); m.emissiveIntensity = def.emissiveIntensity;
    m.emissiveMap = makeTexture(size, (d, s) => {
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { const v = clamp01(P.glow(x, y)); const i = (y * s + x) * 4; d[i] = d[i + 1] = d[i + 2] = v * 255; d[i + 3] = 255; }
    });
  }
  m.userData.scale = def.scale; m.userData.unlit = !!def.unlit; m.userData.name = name;
  cache.set(name, m);
  return m;
}
export const MATERIAL_DEFS = DEFS;
