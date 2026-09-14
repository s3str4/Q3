// Procedural PBR materials (canvas-generated albedo / normal / roughness / emissive). No external assets.
// Every material is described by a "kind" (the procedural pattern) plus a palette; the map picks materials by name.
// Textures are generated lazily on first use so a map only pays for the materials it references.
//
// Texel density is PX_PER_UNIT (4 texels per world unit: a 128-unit block tile is 512 px, a 64-unit trim tile 256 px),
// so a wall seen from arm's length shows chipped block edges, mortar, bolts and scratches instead of blur. The noise
// fields every pattern is built from are tileable value-noise lattices evaluated once per texture size (field cache),
// which keeps a 512 px material at ~30-60 ms of CPU. materialStats() reports the generated count, bytes and time.
//
// Besides the world materials there are: `sky` (a view-direction shader: gradient + stars + drifting nebula, the
// id Tech 3 sky shader role: the sky faces of open rooms are portals onto it), animated emissives (lava, pads,
// item pads: a uTime uniform patched into the world shader, advanced by updateMaterials()), fitted UVs (uvFit: one
// texture stretched over a face, for pads / lamps / banners), and a decal atlas for the multiply-blended grime.
import * as THREE from 'three';

const cache = new Map();
const stats = { count: 0, bytes: 0, ms: 0, textures: 0 };
export function materialStats() { return { ...stats, mb: +(stats.bytes / 1048576).toFixed(1) }; }

const PX_PER_UNIT = 4;
const sizeFor = (def) => def.size || Math.max(256, Math.min(512, (def.scale || 128) * PX_PER_UNIT));

function canvas(size) { const c = document.createElement('canvas'); c.width = c.height = size; return c; }
function hash(x, y, seed = 0) { const s = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453; return s - Math.floor(s); }
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// ---- tileable fbm value noise as a cached field over an s x s texture ----
// cell = lattice cell size in px at the first octave (halved per octave), tileable because the lattice wraps at s.
const fieldCache = new Map();
function field(s, seed, cell, oct = 4, gain = 0.5) {
  const key = `${s}|${seed}|${cell}|${oct}|${gain}`;
  let f = fieldCache.get(key); if (f) return f;
  f = new Float32Array(s * s);
  let amp = 1, sum = 0, c = cell;
  const wx = new Float32Array(s), ix0 = new Int32Array(s), ix1 = new Int32Array(s);
  for (let o = 0; o < oct; o++) {
    const n = Math.max(1, Math.round(s / c)), step = s / n;
    const lat = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) lat[j * n + i] = hash(i, j, seed * 7.13 + o * 101.7);
    for (let x = 0; x < s; x++) { const u = x / step, i0 = Math.floor(u), t = u - i0; wx[x] = t * t * (3 - 2 * t); ix0[x] = i0 % n; ix1[x] = (i0 + 1) % n; }
    for (let y = 0; y < s; y++) {
      const v = y / step, j0 = Math.floor(v), tv = v - j0, sy = tv * tv * (3 - 2 * tv);
      const r0 = (j0 % n) * n, r1 = ((j0 + 1) % n) * n, row = y * s;
      for (let x = 0; x < s; x++) {
        const a = lat[r0 + ix0[x]], b = lat[r0 + ix1[x]], cc = lat[r1 + ix0[x]], d = lat[r1 + ix1[x]], sx = wx[x];
        f[row + x] += (a + (b - a) * sx + (cc - a) * sy + (a - b - cc + d) * sx * sy) * amp;
      }
    }
    sum += amp; amp *= gain; c = Math.max(2, c / 2);
  }
  const inv = 1 / sum; for (let i = 0; i < f.length; i++) f[i] *= inv;
  fieldCache.set(key, f);
  return f;
}
// a field sampled with a coordinate transform (stretched streaks etc.), cached by name
function fieldT(s, key, fn) {
  const k = `${s}|T|${key}`;
  let f = fieldCache.get(k); if (f) return f;
  f = new Float32Array(s * s);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) f[y * s + x] = fn(x, y);
  fieldCache.set(k, f);
  return f;
}
// point-sampled tileable value noise (for transformed lookups)
function vnoise(x, y, cell, seed, period) {
  const xs = x / cell, ys = y / cell, x0 = Math.floor(xs), y0 = Math.floor(ys), fx = xs - x0, fy = ys - y0;
  const p = Math.max(1, Math.round(period / cell));
  const w = (i) => ((i % p) + p) % p;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(w(x0), w(y0), seed), b = hash(w(x0 + 1), w(y0), seed), c = hash(w(x0), w(y0 + 1), seed), d = hash(w(x0 + 1), w(y0 + 1), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbmAt(x, y, seed, oct, cell, period) { let v = 0, amp = 0.5, c = cell, sum = 0; for (let i = 0; i < oct; i++) { v += vnoise(x, y, c, seed + i, period) * amp; sum += amp; amp *= 0.5; c = Math.max(1, c / 2); } return v / sum; }

function makeTexture(size, painter, opts = {}) {
  const c = canvas(size); const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  painter(img.data, size);
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = opts.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping; t.colorSpace = opts.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace; t.anisotropy = 8;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  stats.textures++; stats.bytes += size * size * 4 * 4 / 3; // RGBA8 + the mip chain
  return t;
}
// Height map -> tangent-space normal map (central differences, wrapping).
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
// uvFit: 'both' stretches one texture over each face (pads, lamps, banners), 'v' fits the v axis only (cornices:
// the moulding profile spans the band's height while the dentils repeat along it). anim: the time-driven emissive.
const DEFS = {
  // floors
  // Metalness stays <= 0.35 on world surfaces (there is no environment map: higher values only delete the baked
  // diffuse, see world.js). Steel is warm grey rather than blue-grey so a cool-lit room keeps some red in its mean.
  floor: { base: [0.47, 0.44, 0.40], kind: 'plates', rough: 0.62, metal: 0.3, scale: 128 },
  floor2: { base: [0.36, 0.36, 0.37], kind: 'grate', rough: 0.55, metal: 0.35, scale: 64 },
  grate: { base: [0.36, 0.36, 0.37], kind: 'grate', rough: 0.55, metal: 0.35, scale: 64 },
  concrete: { base: [0.50, 0.48, 0.45], kind: 'concrete', rough: 0.92, metal: 0.0, scale: 128 },
  stone: { base: [0.40, 0.37, 0.34], kind: 'blocks', rough: 0.9, metal: 0.0, scale: 128, blocks: 'rubble' },
  // walls
  wall: { base: [0.46, 0.40, 0.34], kind: 'blocks', rough: 0.85, metal: 0.05, scale: 128 },
  wall2: { base: [0.50, 0.46, 0.41], kind: 'panels', rough: 0.55, metal: 0.3, scale: 128 },
  metal: { base: [0.44, 0.44, 0.45], kind: 'panels', rough: 0.45, metal: 0.35, scale: 128 },
  tech: { base: [0.44, 0.45, 0.48], kind: 'tech', rough: 0.45, metal: 0.35, scale: 128, emissive: [0.95, 0.55, 0.18], emissiveIntensity: 1.25 },
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
  jumppad: { base: [0.25, 0.45, 0.75], kind: 'pad', rough: 0.3, metal: 0.35, scale: 64, size: 512, uvFit: 'both', anim: 'pad', emissive: [0.18, 0.5, 1.0], emissiveIntensity: 1.3 },
  teleporter: { base: [0.55, 0.25, 0.85], kind: 'pad', rough: 0.3, metal: 0.35, scale: 64, size: 512, uvFit: 'both', anim: 'pad', emissive: [0.6, 0.22, 1.0], emissiveIntensity: 1.2 },
  lava: { base: [1, 0.35, 0.05], kind: 'lava', rough: 0.9, metal: 0, scale: 128, anim: 'lava', emissive: [1.0, 0.3, 0.04], emissiveIntensity: 1.5 },
  // light panels: dark albedo (the room's lights must not add white on top of the emissive), saturated emissive
  glow_warm: { base: [0.22, 0.16, 0.09], kind: 'flat', rough: 0.6, metal: 0, scale: 64, emissive: [1.0, 0.68, 0.32], emissiveIntensity: 1.1 },
  glow_cool: { base: [0.09, 0.15, 0.22], kind: 'flat', rough: 0.6, metal: 0, scale: 64, emissive: [0.2, 0.52, 1.0], emissiveIntensity: 1.0 },
  glow_red: { base: [0.22, 0.07, 0.06], kind: 'flat', rough: 0.6, metal: 0, scale: 64, emissive: [1.0, 0.2, 0.14], emissiveIntensity: 1.1 },
  glow_green: { base: [0.08, 0.2, 0.1], kind: 'flat', rough: 0.6, metal: 0, scale: 64, emissive: [0.28, 1.0, 0.4], emissiveIntensity: 1.1 },
  clip: { invisible: true },
  sky: { sky: true, unlit: true, scale: 64 },
  // ---- detail materials (client/render/detail.js: non-colliding architecture) ----
  cornice: { base: [0.44, 0.40, 0.35], kind: 'cornice', rough: 0.85, metal: 0.05, scale: 64, uvFit: 'v' },          // gothic stone moulding (dentils, cove, bead)
  cornice_dark: { base: [0.30, 0.28, 0.27], kind: 'cornice', rough: 0.85, metal: 0.05, scale: 64, uvFit: 'v' },
  trim_steel: { base: [0.40, 0.41, 0.43], kind: 'bolts', rough: 0.4, metal: 0.35, scale: 64, uvFit: 'v' },          // bolted steel band (tech cornice / lintel)
  rib: { base: [0.42, 0.38, 0.33], kind: 'blocks', rough: 0.85, metal: 0.05, scale: 64, blocks: 'ashlar' },           // gothic pilaster / rib stone
  rib_steel: { base: [0.38, 0.39, 0.42], kind: 'panels', rough: 0.45, metal: 0.35, scale: 64 },                      // tech pilaster
  beam: { base: [0.30, 0.29, 0.30], kind: 'bolts', rough: 0.5, metal: 0.35, scale: 32, uvFit: 'v' },                 // ceiling beam (dark bolted steel)
  beam_wood: { base: [0.36, 0.26, 0.17], kind: 'wood', rough: 0.85, metal: 0, scale: 64 },                           // gothic ceiling beam
  pipe: { base: [0.38, 0.37, 0.36], kind: 'pipe', rough: 0.5, metal: 0.35, scale: 32 },                              // steel pipe (8-sided prisms)
  pipe_rust: { base: [0.40, 0.30, 0.22], kind: 'pipe', rough: 0.7, metal: 0.3, scale: 32 },
  cable: { base: [0.12, 0.12, 0.13], kind: 'cable', rough: 0.8, metal: 0.1, scale: 8 },
  vent: { base: [0.30, 0.30, 0.32], kind: 'ventgrille', rough: 0.6, metal: 0.35, scale: 64, uvFit: 'both', size: 256 },
  rock: { base: [0.28, 0.25, 0.23], kind: 'rock', rough: 0.95, metal: 0, scale: 96 },
  ember: { base: [0.26, 0.20, 0.17], kind: 'rock', rough: 0.9, metal: 0, scale: 96, emissive: [1.0, 0.36, 0.06], emissiveIntensity: 1.3, anim: 'lava', crackGlow: true },
  banner_red: { base: [0.55, 0.12, 0.10], kind: 'banner', rough: 0.9, metal: 0, scale: 64, size: 512, uvFit: 'both', emblem: [0.85, 0.65, 0.25] },
  banner_blue: { base: [0.10, 0.22, 0.55], kind: 'banner', rough: 0.9, metal: 0, scale: 64, size: 512, uvFit: 'both', emblem: [0.8, 0.8, 0.85] },
  banner_green: { base: [0.10, 0.40, 0.18], kind: 'banner', rough: 0.9, metal: 0, scale: 64, size: 512, uvFit: 'both', emblem: [0.85, 0.75, 0.35] },
  // item spawn pads (octagonal prisms under the pickups), emissive rim pulsing: colour variants registered on demand
  itempad: { base: [0.22, 0.22, 0.24], kind: 'itempad', rough: 0.4, metal: 0.35, scale: 64, size: 256, uvFit: 'both', anim: 'itempad', emissive: [0.9, 0.9, 1.0], emissiveIntensity: 1.0 },
  padrim: { base: [0.22, 0.26, 0.32], kind: 'trim', rough: 0.4, metal: 0.35, scale: 24, anim: 'itempad', emissive: [0.3, 0.6, 1.0], emissiveIntensity: 1.2 },
  telerim: { base: [0.28, 0.20, 0.34], kind: 'trim', rough: 0.4, metal: 0.35, scale: 24, anim: 'itempad', emissive: [0.7, 0.3, 1.0], emissiveIntensity: 1.2 },
};
// Register a material definition at runtime (detail.js registers lamp / pad colour variants); returns the name.
export function registerMaterial(name, def) { if (!DEFS[name]) DEFS[name] = def; return name; }
// A lamp fixture variant for a map light colour: dark housing, the light's colour as a saturated emissive lens.
export function lampMaterial(hex) {
  const name = 'lamp:' + hex;
  if (!DEFS[name]) { const c = hexToRgb(hex); const m = Math.max(c[0], c[1], c[2]) || 1; DEFS[name] = { base: [0.16, 0.15, 0.14], kind: 'lamp', rough: 0.45, metal: 0.35, scale: 16, size: 256, uvFit: 'both', emissive: c.map((x) => x / m), emissiveIntensity: 1.25, anim: 'lamp' }; }
  return name;
}
export function itempadMaterial(hex) {
  const name = 'itempad:' + hex;
  if (!DEFS[name]) { const c = hexToRgb(hex); const m = Math.max(c[0], c[1], c[2]) || 1; DEFS[name] = { ...DEFS.itempad, emissive: c.map((x) => 0.35 + 0.65 * x / m) }; }
  return name;
}
function hexToRgb(hex) { const v = parseInt(String(hex).replace('#', ''), 16); return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; }

// ---- pattern generators ----
// Each returns { h(x,y) height 0..1, tint(x,y,h) albedo multiplier, wear(x,y,h) exposed-metal mask, rust(x,y,h) rust
// mask, glow(x,y) emissive mask, colour(x,y) optional RGB override } over an s x s tile, built from cached fields.
function pattern(kind, seed, s, def) {
  const px = s / 256; // px per 256-texture pixel: shape constants below are written for a 256 tile and scaled
  const N = (cell, oct = 4, k = 0, gain = 0.5) => field(s, seed + k, cell * px, oct, gain);
  const grimeF = N(64, 4, 9), fineF = N(6, 3, 61), medF = N(40, 2, 63), scratchF = fieldT(s, `scr${seed}`, (x, y) => fbmAt(x * 0.35 + y, y * 0.05, seed + 21, 2, 6 * px, s));
  const scratchMask = N(16, 2, 31);
  const grime = (x, y) => grimeF[y * s + x];
  // Rust speckle: fine-grained (no big blotches: those read as paint splashes) plus medium patches on the more worn
  // plates. ~25% coverage on steel, the warm accent of a Q3 base texture.
  const speckle = (x, y, worn = 0) => smooth(0.65 - worn * 0.1, 0.78 - worn * 0.1, fineF[y * s + x]) * (0.4 + 0.6 * smooth(0.4, 0.7, medF[y * s + x]));
  const scratches = (x, y) => smooth(0.78, 0.84, scratchF[y * s + x]) * 0.12 * smooth(0.55, 0.75, scratchMask[y * s + x]); // sparse thin diagonal streaks of exposed metal
  const none = () => 0;
  switch (kind) {
    case 'plates': { // 2x2 bevelled steel plates with corner rivets, wear patches, scratches and grime in the seams
      const cell = s / 2, bev = 0.035, rivR = 3.2 * px;
      const bump = N(24, 3, 0), wearF = N(48, 3, 71), dentF = N(10, 3, 73);
      const plate = (x, y) => (hash(Math.floor(x / cell), Math.floor(y / cell), seed + 41) - 0.5) * 0.3; // per-plate tone: a Q3 floor is never one flat tone
      const worn = (x, y) => smooth(-0.15, 0.15, plate(x, y));
      const h = (x, y) => {
        const gx = (x % cell) / cell, gy = (y % cell) / cell;
        const edge = Math.min(gx, 1 - gx, gy, 1 - gy);
        const bevel = smooth(0, bev, edge);
        const rx = Math.min(gx, 1 - gx) * cell, ry = Math.min(gy, 1 - gy) * cell;
        const rd = Math.hypot(rx - 12 * px, ry - 12 * px);
        const rivet = rd < rivR ? 0.85 + 0.15 * Math.sqrt(Math.max(0, 1 - (rd / rivR) ** 2)) : 1;
        const dent = smooth(0.72, 0.85, dentF[y * s + x]) * 0.12;
        return bevel * 0.85 * rivet + bump[y * s + x] * 0.12 - scratches(x, y) * 0.1 - dent;
      };
      return { h, tint: (x, y, hv) => 0.45 + hv * 0.6 + plate(x, y) - grime(x, y) * 0.35 + smooth(0.6, 0.8, wearF[y * s + x]) * 0.12, wear: (x, y) => scratches(x, y) + smooth(0.7, 0.85, wearF[y * s + x]) * 0.25, glow: none,
        rust: (x, y, hv) => Math.min(1, smooth(0.55, 0.85, grime(x, y)) * (1 - hv * 0.5) * 0.5 + speckle(x, y, worn(x, y)) * 0.5) };
    }
    case 'grate': { // steel grating: a frame with bolts round the tile, bars with rounded holes, a dark deck below
      const P = 32 * px, barW = 0.3, frame = 10 * px, bump = N(8, 2, 0);
      const hole = (x, y) => { // 1 inside a hole (rounded square), 0 on a bar
        const fx = x % s, fy = y % s;
        if (fx < frame || fx > s - frame || fy < frame || fy > s - frame) return 0;
        const gx = ((x % P) / P) * 2 - 1, gy = ((y % P) / P) * 2 - 1; // -1..1 inside the cell
        const r = Math.max(Math.abs(gx), Math.abs(gy)) * 0.7 + Math.hypot(gx, gy) * 0.3; // rounded square
        return smooth(1 - barW - 0.06, 1 - barW + 0.02, 1 - r);
      };
      const bolt = (x, y) => { const fx = x % s, fy = y % s; const onFrame = fx < frame || fx > s - frame || fy < frame || fy > s - frame; if (!onFrame) return 0; const bx = ((x + s / 16) % (s / 8)) - s / 16, by = ((y + s / 16) % (s / 8)) - s / 16; const d = Math.min(Math.hypot(bx, fy < frame ? fy - frame / 2 : fy - (s - frame / 2)), Math.hypot(fx < frame ? fx - frame / 2 : fx - (s - frame / 2), by)); return d < 2.6 * px ? 1 : 0; };
      const h = (x, y) => { const ho = hole(x, y); return (1 - ho) * (0.85 + bump[y * s + x] * 0.1) + bolt(x, y) * 0.15 + ho * 0.05; };
      return { h, tint: (x, y, hv) => { const ho = hole(x, y); return lerp(0.55 + hv * 0.45 - grime(x, y) * 0.3 + bolt(x, y) * 0.2, 0.12 + grime(x, y) * 0.06, ho); }, wear: (x, y) => (hole(x, y) < 0.5 ? scratches(x, y) * 1.5 + smooth(0.62, 0.8, medF[y * s + x]) * 0.18 : 0), glow: none,
        rust: (x, y) => (hole(x, y) < 0.5 ? speckle(x, y, 0.3) * 0.3 : 0) };
    }
    case 'concrete': { // poured concrete panels with form seams, pits, cracks and stains
      const cell = s / 2, pitF = N(6, 3, 3), baseF = N(40, 4, 0), stainF = fieldT(s, `stn${seed}`, (x, y) => fbmAt(x, y * 3, seed + 12, 3, 20 * px, s)), crackF = N(48, 3, 77);
      const crack = (x, y) => smooth(0.012, 0.0, Math.abs(crackF[y * s + x] - 0.5)) * smooth(0.45, 0.6, medF[y * s + x]);
      const h = (x, y) => {
        const gx = (x % cell) / cell, gy = (y % cell) / cell;
        const edge = Math.min(gx, 1 - gx, gy, 1 - gy);
        const seam = smooth(0, 0.025, edge);
        const pits = smooth(0.62, 0.72, pitF[y * s + x]);
        const tie = (Math.hypot((gx - 0.12) * cell, (gy - 0.12) * cell) < 4 * px || Math.hypot((gx - 0.88) * cell, (gy - 0.88) * cell) < 4 * px) ? -0.2 : 0; // form tie holes
        return seam * 0.8 - pits * 0.25 + baseF[y * s + x] * 0.2 - crack(x, y) * 0.3 + tie;
      };
      return { h, tint: (x, y, hv) => 0.7 + hv * 0.3 - grime(x, y) * 0.35 - smooth(0.55, 0.9, stainF[y * s + x]) * 0.2 - crack(x, y) * 0.3, wear: none, glow: none };
    }
    case 'blocks': { // staggered stone blocks with mortar, chipped edges, cracks and per-block tone (Q3 gothic block walls)
      const rubble = def.blocks === 'rubble', ashlar = def.blocks === 'ashlar';
      const bh = ashlar ? s / 2 : rubble ? s / 6 : s / 4, bw = ashlar ? s : rubble ? s / 3 : s / 2;
      const chipF = N(10, 3, 4), faceF = N(20, 4, 0), crackF = N(64, 3, 78), pitF = N(4, 2, 79), streakF = fieldT(s, `stk${seed}`, (x, y) => fbmAt(x * 2, y * 0.25, seed + 83, 3, 24 * px, s));
      const mortarW = 0.05, chipAmp = 0.035;
      const cellOf = (x, y) => { const row = Math.floor(y / bh); const off = (row % 2) * (bw / 2); return [row, Math.floor((x + off) / bw), ((x + off) % bw) / bw, (y % bh) / bh]; };
      const h = (x, y) => {
        const [row, col, gx, gy] = cellOf(x, y);
        const ex = Math.min(gx, 1 - gx) * (bw / bh), ey = Math.min(gy, 1 - gy);
        const edge = Math.min(ex, ey) - chipF[y * s + x] * chipAmp;        // chipped, uneven block edges
        const face = smooth(mortarW * 0.6, mortarW * 1.4, edge);
        const tone = 0.72 + faceF[((y + row * 37) % s) * s + ((x + col * 53) % s)] * 0.28;
        const crack = smooth(0.014, 0.0, Math.abs(crackF[y * s + x] - 0.5)) * smooth(0.55, 0.7, medF[((y + 91) % s) * s + x]);
        const pit = smooth(0.8, 0.9, pitF[y * s + x]) * 0.15;
        return face * tone - crack * 0.25 - pit + (1 - face) * fineF[y * s + x] * 0.15;
      };
      return { h, tint: (x, y, hv) => { const [row, col] = cellOf(x, y); return 0.62 + hv * 0.42 - grime(x, y) * 0.28 - streakF[y * s + x] * 0.12 + (hash(row, col, seed) - 0.5) * 0.16; }, wear: none, glow: none };
    }
    case 'panels': { // riveted steel panels (2 x 2) with recessed borders, rivet rows, a centre groove, scratches and rust runs
      const pw = s / 2, ph = s / 2, border = 0.07, bumpF = N(40, 3, 0), runF = fieldT(s, `run${seed}`, (x, y) => fbmAt(x * 0.6, y * 0.15, seed + 7, 2, 10 * px, s)), patchF = N(24, 2, 17);
      const rivet = (x, y) => { const gx = (x % pw) / pw, gy = (y % ph) / ph; const inBorder = (gx < border || gx > 1 - border || gy < border || gy > 1 - border); if (!inBorder) return 0; const bx = ((x % pw) + pw / 16) % (pw / 8) - pw / 16, by = ((y % ph) + ph / 16) % (ph / 8) - ph / 16; const c = border * 0.5; const dx = Math.min(Math.abs(gx - c), Math.abs(gx - 1 + c)) * pw, dy = Math.min(Math.abs(gy - c), Math.abs(gy - 1 + c)) * ph; const d = Math.min(Math.hypot(bx, dy), Math.hypot(dx, by)); return d < 2.8 * px ? 1 : 0; };
      const h = (x, y) => {
        const gx = (x % pw) / pw, gy = (y % ph) / ph;
        const edge = Math.min(gx, 1 - gx, gy, 1 - gy);
        const seam = smooth(0, 0.015, edge) * 0.35 + smooth(border - 0.01, border + 0.01, edge) * 0.35; // outer seam + inner step
        const groove = Math.abs(gy - 0.5) < 0.012 && gx > border && gx < 1 - border ? -0.2 : 0;
        return 0.3 + seam + groove + rivet(x, y) * 0.18 + bumpF[y * s + x] * 0.12 - scratches(x, y) * 0.08;
      };
      const panel = (x, y) => (hash(Math.floor(x / pw), Math.floor(y / ph), seed + 43) - 0.5) * 0.3;
      const worn = (x, y) => smooth(-0.15, 0.15, panel(x, y));
      return { h, tint: (x, y, hv) => 0.42 + hv * 0.62 + panel(x, y) - grime(x, y) * 0.28 - smooth(0.6, 0.88, runF[y * s + x]) * 0.15, wear: (x, y) => scratches(x, y) + rivet(x, y) * 0.1, glow: none,
        rust: (x, y) => Math.min(1, smooth(0.6, 0.88, runF[y * s + x]) * 0.6 * smooth(0.4, 0.65, patchF[y * s + x]) + speckle(x, y, worn(x, y)) * 0.45) };
    }
    case 'tech': { // machinery: 2 x 2 sub-panels (indicator strip, vent slots, a dial with bolts, a display of dots), a conduit
      const c = s / 2, bumpF = N(30, 3, 0);
      const sub = (x, y) => [Math.floor(x / c) % 2, Math.floor(y / c) % 2, (x % c) / c, (y % c) / c];
      const h = (x, y) => {
        const [i, j, gx, gy] = sub(x, y);
        const edge = Math.min(gx, 1 - gx, gy, 1 - gy);
        let v = smooth(0, 0.04, edge) * 0.7 + bumpF[y * s + x] * 0.08;
        if (i === 0 && j === 0) { if (gx > 0.15 && gx < 0.85 && gy > 0.6 && gy < 0.72) v -= 0.3; if (gx > 0.15 && gx < 0.85 && gy > 0.25 && gy < 0.45 && Math.floor(gx * 14) % 2 === 0) v -= 0.2; }  // strip + slots
        else if (i === 1 && j === 0) { if (gx > 0.12 && gx < 0.88 && gy > 0.2 && gy < 0.8 && Math.floor(gy * 12) % 2 === 0) v -= 0.25; }                                                     // vent slots
        else if (i === 0 && j === 1) { const d = Math.hypot(gx - 0.5, gy - 0.5); if (d < 0.22) v += 0.15; if (Math.abs(d - 0.3) < 0.02) v -= 0.15; for (const [bx, by] of [[0.12, 0.12], [0.88, 0.12], [0.12, 0.88], [0.88, 0.88]]) if (Math.hypot(gx - bx, gy - by) < 0.035) v += 0.2; } // dial + bolts
        else { if (gx > 0.1 && gx < 0.9 && gy > 0.15 && gy < 0.4) v -= 0.25; if (gy > 0.55 && gy < 0.65) v -= 0.15; }                                                                        // display recess + conduit groove
        return v;
      };
      const glow = (x, y) => { const [i, j, gx, gy] = sub(x, y); if (i === 0 && j === 0) return (gx > 0.2 && gx < 0.8 && gy > 0.62 && gy < 0.7) ? 1 : 0; if (i === 1 && j === 1) { if (gx > 0.14 && gx < 0.86 && gy > 0.19 && gy < 0.36) { const k = Math.floor(gx * 9); return hash(k, 3, seed) > 0.4 ? 0.9 : 0.15; } } return 0; };
      return { h, tint: (x, y, hv) => 0.68 + hv * 0.35 - grime(x, y) * 0.15, wear: (x, y) => scratches(x, y), glow, rust: (x, y) => speckle(x, y, 0.2) * 0.3 };
    }
    case 'vents': { // dark ceiling panels: a cross-beam grid, slotted vents, bolts at the crossings
      const c = s / 2, bumpF = N(30, 3, 0), beam = 0.06;
      const h = (x, y) => {
        const gx = (x % c) / c, gy = (y % c) / c;
        const edge = Math.min(gx, 1 - gx, gy, 1 - gy);
        const onBeam = edge < beam ? 0.35 : 0;
        const slot = (gx > 0.25 && gx < 0.75 && gy > 0.3 && gy < 0.7 && ((y % (8 * px)) < 4 * px)) ? -0.4 : 0;
        const bolt = (Math.hypot(Math.min(gx, 1 - gx), Math.min(gy, 1 - gy)) < beam * 0.5) ? 0.2 : 0;
        return 0.4 + onBeam + smooth(beam, beam + 0.02, edge) * 0.15 + slot + bolt + bumpF[y * s + x] * 0.1;
      };
      return { h, tint: (x, y, hv) => 0.5 + hv * 0.45 - grime(x, y) * 0.3, wear: none, glow: none, rust: (x, y) => speckle(x, y, 0.1) * 0.35 };
    }
    case 'trim': { // horizontal trim band: bolts along the upper and lower bands, two grooves, a recessed strip in the middle
      const bumpF = N(20, 2, 0);
      const bolt = (x, y) => { const gy = (y % s) / s; const bx = ((x + s / 16) % (s / 8)) - s / 16; const d = Math.min(Math.hypot(bx, (gy - 0.1) * s), Math.hypot(bx, (gy - 0.9) * s)); return d < 3 * px ? 1 : 0; };
      const h = (x, y) => {
        const gy = (y % s) / s;
        const strip = (gy > 0.42 && gy < 0.58) ? -0.35 : 0;
        const groove = (Math.abs(gy - 0.25) < 0.025 || Math.abs(gy - 0.75) < 0.025) ? -0.25 : 0;
        const seg = ((x % (s / 2)) / (s / 2)); const segEdge = smooth(0, 0.04, Math.min(seg, 1 - seg));
        return 0.7 * segEdge + strip + groove + bolt(x, y) * 0.2 + bumpF[y * s + x] * 0.08;
      };
      const glowF = N(12, 2, 2);
      const glow = (x, y) => { const gy = (y % s) / s; return (gy > 0.44 && gy < 0.56) ? 0.85 + glowF[y * s + x] * 0.15 : 0; };
      return { h, tint: (x, y, hv) => 0.55 + hv * 0.45 - grime(x, y) * 0.15 + bolt(x, y) * 0.15, wear: (x, y) => scratches(x, y) * 0.5 + bolt(x, y) * 0.15, glow, rust: (x, y) => speckle(x, y, 0) * 0.3 };
    }
    case 'bolts': { // bolted steel band: hex bolts every s/4, two grooves, a raised centre plate
      const bumpF = N(20, 2, 0);
      const hex = (dx, dy, r) => { const a = Math.abs(dx), b = Math.abs(dy); return Math.max(b, a * 0.866 + b * 0.5) < r ? 1 : 0; };
      const bolt = (x, y) => { const gy = (y % s) / s; const bx = ((x + s / 8) % (s / 4)) - s / 8; return hex(bx, (gy - 0.5) * s, 6 * px); };
      const h = (x, y) => {
        const gy = (y % s) / s;
        const plate = (gy > 0.28 && gy < 0.72) ? 0.2 : 0;
        const groove = (Math.abs(gy - 0.14) < 0.03 || Math.abs(gy - 0.86) < 0.03) ? -0.25 : 0;
        return 0.55 + plate + groove + bolt(x, y) * 0.25 + bumpF[y * s + x] * 0.08 - scratches(x, y) * 0.08;
      };
      return { h, tint: (x, y, hv) => 0.5 + hv * 0.45 - grime(x, y) * 0.2 + bolt(x, y) * 0.1, wear: (x, y) => scratches(x, y) + bolt(x, y) * 0.2, glow: none, rust: (x, y) => speckle(x, y, 0.2) * 0.5 };
    }
    case 'cornice': { // stone moulding profile over v (top fillet, cove, dentils, bead, ovolo); the dentils repeat along u
      const bumpF = N(16, 3, 0);
      const profile = (v, x) => {
        if (v < 0.14) return 1.0;                                        // top fillet
        if (v < 0.30) return 1.0 - smooth(0.14, 0.30, v) * 0.45;         // cove
        if (v < 0.50) { const t = (x % (s / 8)) / (s / 8); return (t > 0.15 && t < 0.85) ? 0.85 : 0.35; } // dentils
        if (v < 0.58) return 0.7;                                        // fillet
        if (v < 0.82) return 0.55 + 0.4 * Math.sin((v - 0.58) / 0.24 * Math.PI); // ovolo bead
        return 0.45;                                                     // bottom
      };
      const h = (x, y) => { const v = (y % s) / s; return profile(v, x) * (0.9 + bumpF[y * s + x] * 0.1) - smooth(0.8, 0.9, fineF[y * s + x]) * 0.1; };
      return { h, tint: (x, y, hv) => 0.45 + hv * 0.6 - grime(x, y) * 0.25, wear: none, glow: none };
    }
    case 'wood': { // dark timber beam: grain streaks, knots, a chamfered edge
      const grainF = fieldT(s, `grn${seed}`, (x, y) => fbmAt(x * 0.12, y * 2.5, seed + 5, 4, 24 * px, s)), knotF = N(48, 2, 8);
      const h = (x, y) => { const gy = (y % s) / s; const edge = Math.min(gy, 1 - gy); return smooth(0, 0.08, edge) * 0.5 + grainF[y * s + x] * 0.3 - smooth(0.8, 0.9, knotF[y * s + x]) * 0.2; };
      return { h, tint: (x, y, hv) => 0.55 + hv * 0.5 - grime(x, y) * 0.2 + (grainF[y * s + x] - 0.5) * 0.3, wear: none, glow: none };
    }
    case 'pipe': { // steel pipe skin: flange rings every tile along u, weld seams, grime
      const bumpF = N(16, 3, 0);
      const h = (x, y) => { const gx = (x % s) / s; const ring = (gx < 0.08 || gx > 0.92) ? 0.3 : 0; const weld = Math.abs(gx - 0.5) < 0.012 ? 0.12 : 0; return 0.55 + ring + weld + bumpF[y * s + x] * 0.12 - scratches(x, y) * 0.1; };
      return { h, tint: (x, y, hv) => 0.5 + hv * 0.5 - grime(x, y) * 0.3, wear: (x, y) => scratches(x, y), glow: none, rust: (x, y) => speckle(x, y, 0.3) * 0.45 + smooth(0.6, 0.85, grime(x, y)) * 0.35 };
    }
    case 'cable': { // rubber cable: a twisted-pair pattern along u, matte
      const h = (x, y) => { const gx = (x % s) / s, gy = (y % s) / s; return 0.5 + 0.3 * Math.sin((gx * 2 + gy) * Math.PI * 2); };
      return { h, tint: (x, y, hv) => 0.6 + hv * 0.4, wear: none, glow: none };
    }
    case 'ventgrille': { // wall vent: a frame with louvre slats and four screws (fitted to its panel)
      const h = (x, y) => { const gx = x / s, gy = y / s; const edge = Math.min(gx, 1 - gx, gy, 1 - gy); if (edge < 0.08) return 0.9; const slat = ((gy * 10) % 1); return 0.3 + smooth(0.0, 0.4, slat) * 0.5 - smooth(0.7, 1, slat) * 0.3; };
      const screw = (x, y) => { const gx = x / s, gy = y / s; for (const [bx, by] of [[0.04, 0.04], [0.96, 0.04], [0.04, 0.96], [0.96, 0.96]]) if (Math.hypot(gx - bx, gy - by) < 0.025) return 1; return 0; };
      return { h: (x, y) => h(x, y) + screw(x, y) * 0.15, tint: (x, y, hv) => 0.45 + hv * 0.55 - grime(x, y) * 0.3, wear: (x, y) => screw(x, y) * 0.2, glow: none, rust: (x, y) => speckle(x, y, 0.2) * 0.4 };
    }
    case 'rock': { // basalt: heavy fbm lumps, dark cracks (glowing on the ember variant), pits
      const lumpF = N(48, 5, 0, 0.55), crackF = N(40, 3, 88), pitF = N(5, 2, 89);
      const crack = (x, y) => smooth(0.03, 0.0, Math.abs(crackF[y * s + x] - 0.5));
      const h = (x, y) => lumpF[y * s + x] * 0.85 - crack(x, y) * 0.35 - smooth(0.78, 0.9, pitF[y * s + x]) * 0.15;
      return { h, tint: (x, y, hv) => 0.45 + hv * 0.7 - grime(x, y) * 0.2, wear: none, glow: def.crackGlow ? (x, y) => crack(x, y) * (0.6 + 0.4 * smooth(0.4, 0.7, medF[y * s + x])) : none, colour: def.crackGlow ? (x, y) => { const c = crack(x, y); return c > 0.2 ? [0.9, 0.35, 0.08] : null; } : null };
    }
    case 'banner': { // hanging cloth: vertical folds, a pole band at the top, an emblem in the middle, a tattered dark hem
      const foldF = fieldT(s, `fld${seed}`, (x, y) => fbmAt(x * 1.5, y * 0.15, seed + 3, 3, 20 * px, s)), hemF = N(12, 2, 4), weaveF = N(3, 1, 6);
      const em = def.emblem || [0.9, 0.8, 0.4];
      const emblem = (x, y) => { const gx = x / s - 0.5, gy = y / s - 0.45; const d = Math.hypot(gx, gy * 1.1); const ring = Math.abs(d - 0.16) < 0.018 ? 1 : 0; const cross = (Math.abs(gx) < 0.02 && Math.abs(gy) < 0.13) || (Math.abs(gy) < 0.02 && Math.abs(gx) < 0.13) ? 1 : 0; const dots = [[0, -0.23], [0, 0.23]].some(([ax, ay]) => Math.hypot(gx - ax, gy - ay) < 0.025) ? 1 : 0; return Math.max(ring, cross, dots); };
      const hem = (x, y) => y / s > 0.9 + (hemF[y * s + x] - 0.5) * 0.1 ? 1 : 0;
      const h = (x, y) => { const gy = y / s; return 0.5 + Math.sin(x / s * Math.PI * 7 + foldF[y * s + x] * 3) * 0.12 * smooth(0, 0.1, gy) + (gy < 0.06 ? 0.3 : 0) + weaveF[y * s + x] * 0.06 - hem(x, y) * 0.3 + emblem(x, y) * 0.08; };
      return { h, tint: (x, y, hv) => (0.55 + hv * 0.6 - grime(x, y) * 0.2) * (1 - hem(x, y) * 0.6), wear: none, glow: none, colour: (x, y) => (y / s < 0.06 ? [0.35, 0.28, 0.2] : emblem(x, y) ? em : null) };
    }
    case 'lamp': { // fixture lens (fitted): an emissive disc in a dark housing with four screws
      const h = (x, y) => { const gx = x / s - 0.5, gy = y / s - 0.5; const d = Math.hypot(gx, gy); return d < 0.36 ? 0.6 + Math.sqrt(Math.max(0, 1 - (d / 0.36) ** 2)) * 0.3 : Math.abs(d - 0.42) < 0.03 ? 0.9 : 0.5; };
      const glow = (x, y) => { const d = Math.hypot(x / s - 0.5, y / s - 0.5); return smooth(0.36, 0.3, d) * (0.85 + 0.15 * smooth(0.2, 0, d)); };
      return { h, tint: (x, y, hv) => 0.5 + hv * 0.5, wear: (x, y) => { const gx = x / s, gy = y / s; for (const [bx, by] of [[0.08, 0.08], [0.92, 0.08], [0.08, 0.92], [0.92, 0.92]]) if (Math.hypot(gx - bx, gy - by) < 0.035) return 0.5; return 0; }, glow, colour: (x, y) => (glow(x, y) > 0.5 ? [0.9, 0.9, 0.85] : null) };
    }
    case 'itempad': { // item spawn pad (fitted): dark plate, an emissive ring near the rim with eight notches, an inner glyph
      const bumpF = N(16, 2, 0);
      const ring = (x, y) => { const gx = x / s - 0.5, gy = y / s - 0.5; const d = Math.hypot(gx, gy), a = Math.atan2(gy, gx); const r = Math.abs(d - 0.36) < 0.025 ? 1 : 0; const notch = Math.abs(d - 0.43) < 0.03 && ((a / Math.PI * 4 + 8) % 1) < 0.25 ? 1 : 0; const inner = Math.abs(d - 0.12) < 0.015 ? 0.7 : 0; return Math.max(r, notch, inner); };
      const h = (x, y) => { const d = Math.hypot(x / s - 0.5, y / s - 0.5); return (d < 0.47 ? 0.7 : 0.4) - ring(x, y) * 0.25 + bumpF[y * s + x] * 0.08; };
      return { h, tint: (x, y, hv) => 0.45 + hv * 0.5 - grime(x, y) * 0.2, wear: (x, y) => scratches(x, y), glow: ring, rust: (x, y) => speckle(x, y, 0) * 0.25 };
    }
    case 'padrim': { // jump pad / teleporter rim ring (fitted): chevrons chasing round an emissive ring
      const ring = (x, y) => { const gx = x / s - 0.5, gy = y / s - 0.5; const d = Math.hypot(gx, gy), a = (Math.atan2(gy, gx) / Math.PI + 1) * 6; const band = d > 0.3 && d < 0.44 ? 1 : 0; const chev = band && ((a + (d - 0.3) * 8) % 1) < 0.5 ? 1 : 0; return chev; };
      const h = (x, y) => { const d = Math.hypot(x / s - 0.5, y / s - 0.5); return (d < 0.48 && d > 0.26 ? 0.75 : 0.4) - ring(x, y) * 0.2; };
      return { h, tint: (x, y, hv) => 0.5 + hv * 0.5, wear: (x, y) => scratches(x, y) * 0.5, glow: ring };
    }
    case 'pad': { // jump pad / teleporter surface (fitted): concentric rings, a centre disc and four chevrons pointing in
      const h = (x, y) => { const cx = x / s - 0.5, cy = y / s - 0.5; const r = Math.hypot(cx, cy) * 2; const rings = (Math.sin(r * 22) * 0.5 + 0.5) * 0.35; const disc = r < 0.22 ? 0.4 : 0; const chev = chevron(cx, cy) ? -0.2 : 0; return rings + disc + chev + (r < 0.95 ? 0.3 : 0); };
      function chevron(cx, cy) { for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; const u = cx * Math.cos(a) + cy * Math.sin(a), v = -cx * Math.sin(a) + cy * Math.cos(a); if (u > 0.28 && u < 0.4 && Math.abs(v) < (0.4 - u) * 0.8) return true; } return false; }
      const glow = (x, y) => { const cx = x / s - 0.5, cy = y / s - 0.5; const r = Math.hypot(cx, cy) * 2; if (r > 0.95) return 0; if (chevron(cx, cy)) return 1; if (r < 0.2) return 0.9; return 0.25 + smooth(0.55, 0.95, Math.sin(r * 22) * 0.5 + 0.5) * 0.7; };
      return { h, tint: (x, y, hv) => 0.5 + hv * 0.5, wear: none, glow };
    }
    case 'lava': { // molten rock: dark crust plates (fbm lumps) split by bright crack networks, hot pools where the crust is thin
      const crustF = N(48, 5, 0, 0.55), crackF = N(56, 3, 90), poolF = N(96, 2, 91);
      const crack = (x, y) => smooth(0.06, 0.0, Math.abs(crackF[y * s + x] - 0.5)) * 0.8 + smooth(0.02, 0.0, Math.abs(crackF[y * s + x] - 0.5)) * 0.2;
      const pool = (x, y) => smooth(0.6, 0.85, poolF[y * s + x]);
      const h = (x, y) => crustF[y * s + x] * 0.8 * (1 - pool(x, y) * 0.7) - crack(x, y) * 0.4;
      const glow = (x, y) => Math.min(1, crack(x, y) * (0.7 + 0.3 * crustF[y * s + x]) + pool(x, y) * 0.9 + 0.08);
      return { h, tint: (x, y, hv) => 0.25 + hv * 0.5 + glow(x, y) * 0.9, wear: none, glow, colour: (x, y) => { const g = glow(x, y); return g > 0.5 ? [1, 0.55 + 0.4 * (g - 0.5), 0.15] : g > 0.2 ? [0.7, 0.2, 0.05] : [0.2, 0.12, 0.1]; } };
    }
    default: { // light panel: a diffuser with a faint cell grid, a dim 3-px frame and screws so the panel reads as a fixture
      const mottleF = N(32, 2, 0), glowF = N(24, 3, 4);
      const h = (x, y) => mottleF[y * s + x] * 0.2 + (((x % (s / 4)) < 1.5 * px || (y % (s / 4)) < 1.5 * px) ? -0.05 : 0);
      const frame = (x, y) => { const gx = x % s, gy = y % s; return Math.min(gx, s - 1 - gx, gy, s - 1 - gy) < 3 * px ? 0.45 : 1; };
      return { h, tint: (x, y) => frame(x, y), wear: none, glow: (x, y) => (0.88 + glowF[y * s + x] * 0.12) * frame(x, y) * (((x % (s / 4)) < 1.5 * px || (y % (s / 4)) < 1.5 * px) ? 0.85 : 1) };
    }
  }
}

// ---- animated emissive + uTime: shared uniform object patched into every world material that declares `anim` ----
const timeUniform = { value: 0 };
export function updateMaterials(nowMs) { timeUniform.value = (nowMs / 1000) % 3600; }
const ANIM_GLSL = {
  // lava: the crack glow breathes and the hot pools drift (a second emissive lookup slides slowly)
  lava: 'vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv ); vec4 e2 = texture2D( emissiveMap, vEmissiveMapUv + vec2( uTime * 0.012, uTime * 0.007 ) ); emissiveColor.rgb = mix( emissiveColor.rgb, e2.rgb, 0.35 ) * ( 0.85 + 0.25 * sin( uTime * 1.7 + ( vEmissiveMapUv.x + vEmissiveMapUv.y ) * 6.2832 ) ); totalEmissiveRadiance *= emissiveColor.rgb;',
  // pads: rings pulse outward from the centre (fitted UVs: the tile centre is the pad centre)
  pad: 'vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv ); float pr = length( vEmissiveMapUv - 0.5 ) * 2.0; emissiveColor.rgb *= 0.55 + 0.45 * ( 0.5 + 0.5 * sin( uTime * 4.0 - pr * 14.0 ) ); totalEmissiveRadiance *= emissiveColor.rgb;',
  padrim: 'vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv ); float pa = atan( vEmissiveMapUv.y - 0.5, vEmissiveMapUv.x - 0.5 ); emissiveColor.rgb *= 0.5 + 0.5 * ( 0.5 + 0.5 * sin( uTime * 5.0 - pa * 3.0 ) ); totalEmissiveRadiance *= emissiveColor.rgb;',
  itempad: 'vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv ); emissiveColor.rgb *= 0.7 + 0.3 * sin( uTime * 2.5 ); totalEmissiveRadiance *= emissiveColor.rgb;',
  lamp: 'vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv ); emissiveColor.rgb *= 0.94 + 0.06 * sin( uTime * 11.0 ) * sin( uTime * 3.1 ); totalEmissiveRadiance *= emissiveColor.rgb;',
};
// Patch a material's shader for the animated emissive (called from world.js bakedMaterial's onBeforeCompile).
export function patchAnim(shader, anim) {
  const glsl = ANIM_GLSL[anim]; if (!glsl) return;
  shader.uniforms.uTime = timeUniform;
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace('#include <emissivemap_fragment>', glsl);
}

export function getMaterial(name) {
  if (cache.has(name)) return cache.get(name);
  const def = DEFS[name] || DEFS.wall;
  if (def.invisible) { const m = new THREE.MeshBasicMaterial({ visible: false }); m.userData.name = name; cache.set(name, m); return m; }
  if (def.sky) { const m = skyMaterial(); m.userData.scale = 64; m.userData.unlit = true; m.userData.name = name; cache.set(name, m); return m; }
  const t0 = performance.now();
  const size = sizeFor(def), seed = name.length * 7 + name.charCodeAt(0) + (name.charCodeAt(name.length - 1) % 13);
  const P = pattern(def.kind, seed, size, def);
  // height field once (shared by albedo, normal, roughness)
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) H[y * size + x] = P.h(x, y);
  const map = makeTexture(size, (d, s) => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const hv = H[y * s + x];
      const shade = P.tint(x, y, hv);
      const wear = P.wear(x, y, hv), rust = P.rust ? clamp01(P.rust(x, y, hv)) : 0;
      const i = (y * s + x) * 4;
      const over = P.colour ? P.colour(x, y) : null;
      const base = over || def.base;
      // worn spots expose bare, brighter, desaturated metal; rust runs are matte orange-brown (the warm accents a
      // cool-lit steel room needs so it does not read as one flat blue)
      let r = base[0] * shade * (1 - wear) + 0.62 * wear, g = base[1] * shade * (1 - wear) + 0.62 * wear, b = base[2] * shade * (1 - wear) + 0.64 * wear;
      r += (0.42 * shade - r) * rust; g += (0.2 * shade - g) * rust; b += (0.09 * shade - b) * rust;
      d[i] = Math.min(255, r * 255); d[i + 1] = Math.min(255, g * 255); d[i + 2] = Math.min(255, b * 255); d[i + 3] = 255;
    }
  }, { clamp: def.uvFit === 'both' });
  const normalMap = normalFromHeight(size, H, def.kind === 'lava' ? 1.5 : def.kind === 'concrete' ? 2.2 : def.kind === 'rock' ? 2.5 : 3);
  if (def.uvFit === 'both') normalMap.wrapS = normalMap.wrapT = THREE.ClampToEdgeWrapping;
  // roughness at half resolution (its detail is the pattern's wear / rust masks, already carried by the albedo)
  const rs = Math.max(128, size / 2), k = size / rs;
  const rough = new Float32Array(rs * rs);
  for (let y = 0; y < rs; y++) for (let x = 0; x < rs; x++) { const sx = Math.floor(x * k), sy = Math.floor(y * k); const hv = H[sy * size + sx]; const wear = P.wear(sx, sy, hv), rust = P.rust ? clamp01(P.rust(sx, sy, hv)) : 0; rough[y * rs + x] = clamp01(def.rough + (hv - 0.5) * 0.25 - wear * 0.35 + rust * 0.4); }
  const roughnessMap = makeTexture(rs, (d, s) => { for (let i = 0; i < s * s; i++) { const v = rough[i] * 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; } }, { linear: true, clamp: def.uvFit === 'both' });
  const m = new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap, roughness: 1, metalness: def.metal, normalScale: new THREE.Vector2(0.9, 0.9) });
  if (def.emissive) {
    m.emissive = new THREE.Color(...def.emissive); m.emissiveIntensity = def.emissiveIntensity;
    m.emissiveMap = makeTexture(size, (d, s) => {
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { const v = clamp01(P.glow(x, y)); const i = (y * s + x) * 4; d[i] = d[i + 1] = d[i + 2] = v * 255; d[i + 3] = 255; }
    }, { clamp: def.uvFit === 'both' });
  }
  m.userData.scale = def.scale; m.userData.unlit = !!def.unlit; m.userData.name = name; m.userData.uvFit = def.uvFit || null; m.userData.anim = def.anim || null;
  stats.count++; stats.ms += performance.now() - t0;
  cache.set(name, m);
  return m;
}
export const MATERIAL_DEFS = DEFS;

// ---- sky dome shader: the id Tech 3 sky shader role. Sky faces are drawn with a colour computed from the world-space
// view direction: a horizon -> zenith gradient, a star field (hashed cells on the direction, twinkling), and two layers
// of slowly drifting nebula / cloud noise. Colours come from the map's ambient.skyDome (see world.js setSky). ----
let skyMat = null;
export function skyMaterial() {
  if (skyMat) return skyMat;
  skyMat = new THREE.ShaderMaterial({
    uniforms: { uTime: timeUniform, uZenith: { value: new THREE.Color(0x0a1230) }, uHorizon: { value: new THREE.Color(0x2a1f2a) }, uCloud: { value: new THREE.Color(0x3a2a44) }, uStars: { value: 1.0 }, uClouds: { value: 0.6 }, uCloudSpeed: { value: 0.01 } },
    vertexShader: 'varying vec3 vWorld; void main() { vec4 wp = modelMatrix * vec4( position, 1.0 ); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }',
    fragmentShader: `
      uniform float uTime; uniform vec3 uZenith, uHorizon, uCloud; uniform float uStars, uClouds, uCloudSpeed;
      varying vec3 vWorld;
      float hash3( vec3 p ) { p = fract( p * 0.3183099 + vec3( 0.1, 0.2, 0.3 ) ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
      float hash2( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
      float vnoise( vec2 p ) { vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f ); return mix( mix( hash2( i ), hash2( i + vec2( 1.0, 0.0 ) ), f.x ), mix( hash2( i + vec2( 0.0, 1.0 ) ), hash2( i + vec2( 1.0, 1.0 ) ), f.x ), f.y ); }
      float fbm( vec2 p ) { float v = 0.0, a = 0.5; for ( int i = 0; i < 4; i++ ) { v += vnoise( p ) * a; p = p * 2.03 + 11.3; a *= 0.5; } return v; }
      void main() {
        vec3 d = normalize( vWorld - cameraPosition );
        float up = clamp( d.z, 0.0, 1.0 );
        vec3 col = mix( uHorizon, uZenith, pow( up, 0.55 ) );
        // nebula / cloud layers in a planar projection of the direction (stretched toward the horizon like a real sky)
        vec2 pp = d.xy / ( d.z + 0.25 );
        float c1 = fbm( pp * 1.6 + vec2( uTime * uCloudSpeed, uTime * uCloudSpeed * 0.4 ) );
        float c2 = fbm( pp * 3.1 - vec2( uTime * uCloudSpeed * 0.6, 0.0 ) + 4.7 );
        float cloud = smoothstep( 0.45, 0.8, c1 * 0.65 + c2 * 0.35 ) * uClouds * ( 0.3 + 0.7 * up );
        col = mix( col, uCloud, cloud );
        // stars: a hashed cell per direction, only the brightest cells, dimmed under cloud and toward the horizon
        vec3 cell = floor( d * 90.0 );
        float sh = hash3( cell );
        vec3 cp = fract( d * 90.0 ) - 0.5;
        float star = smoothstep( 0.985, 1.0, sh ) * smoothstep( 0.22, 0.0, length( cp ) ) * ( 0.7 + 0.3 * sin( uTime * 2.0 + sh * 60.0 ) );
        col += star * uStars * ( 1.0 - cloud ) * ( 0.3 + 0.7 * up ) * 1.6;
        gl_FragColor = vec4( col, 1.0 );
      }`,
    depthWrite: true, fog: false,
  });
  return skyMat;
}
// Configure the sky from a map's ambient: skyDome { zenith, horizon, cloud, stars, clouds, speed } (hex colours).
// gain: the dome is read through the same ACES + gamma as the world, whose lit surfaces sit at irradiance 1-3, so the
// sky colours are lifted well above their sRGB reading or the openings show as black holes with a few stars.
export function setSky(ambient) {
  const m = skyMaterial(), d = (ambient && ambient.skyDome) || {}, gain = d.gain ?? 5.0;
  const linear = (hex, fallback) => new THREE.Color(hex || fallback).multiplyScalar(gain); // THREE.Color(hex) is already linear under ColorManagement
  m.uniforms.uZenith.value.copy(linear(d.zenith, ambient && ambient.sky || '#0a1230'));
  m.uniforms.uHorizon.value.copy(linear(d.horizon, '#2a1f2a'));
  m.uniforms.uCloud.value.copy(linear(d.cloud, '#3a2a44'));
  m.uniforms.uStars.value = d.stars ?? 1.0; m.uniforms.uClouds.value = d.clouds ?? 0.6; m.uniforms.uCloudSpeed.value = d.speed ?? 0.01;
}

// ---- decal atlas (multiply-blended grime, 2 x 2 cells): 0 soot / scorch disc, 1 grime blotch, 2 drip streaks, 3 rust ring ----
let decalTex = null;
export function decalAtlas() {
  if (decalTex) return decalTex;
  const S = 512, C = S / 2;
  decalTex = makeTexture(S, (d, s) => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const cx = x % C, cy = y % C, kind = (x >= C ? 1 : 0) + (y >= C ? 2 : 0);
      const u = cx / C - 0.5, v = cy / C - 0.5, r = Math.hypot(u, v) * 2;
      let dark = 0;
      if (kind === 0) dark = smooth(1, 0.15, r) * (0.55 + 0.45 * fbmAt(cx, cy, 5, 3, 24, C)) * 0.75;                       // soot disc, dense centre
      else if (kind === 1) dark = smooth(1, 0.3, r + (fbmAt(cx, cy, 7, 3, 40, C) - 0.5) * 0.8) * (0.4 + 0.6 * fbmAt(cx, cy, 8, 3, 12, C)) * 0.55;  // irregular blotch
      else if (kind === 2) { const streak = smooth(0.55, 0.85, fbmAt(cx * 3, cy * 0.15, 9, 3, 16, C)); dark = streak * smooth(0, 0.15, cy / C) * smooth(1, 0.6, cy / C) * smooth(0.5, 0.35, Math.abs(u)) * 0.5; } // drips
      else dark = (smooth(0.12, 0.0, Math.abs(r - 0.72)) * 0.5 + smooth(1, 0.2, r) * 0.15) * (0.5 + 0.5 * fbmAt(cx, cy, 11, 3, 20, C)) * 0.6;   // rust ring + puddle
      const val = (1 - clamp01(dark)) * 255, i = (y * s + x) * 4;
      d[i] = val; d[i + 1] = val * (kind === 3 ? 0.9 : 1); d[i + 2] = val * (kind === 3 ? 0.8 : kind === 0 ? 0.95 : 1); d[i + 3] = 255;
    }
  }, { clamp: true });
  decalTex.generateMipmaps = true;
  return decalTex;
}
export function decalMaterial() {
  return new THREE.MeshBasicMaterial({ map: decalAtlas(), blending: THREE.MultiplyBlending, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, toneMapped: false, side: THREE.DoubleSide });
}
