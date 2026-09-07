// Procedural PBR-ish materials (canvas-generated textures: albedo + roughness + normal-ish detail). No external assets.
import * as THREE from 'three';

const cache = new Map();

function canvas(size) { const c = document.createElement('canvas'); c.width = c.height = size; return c; }
function noise2(x, y, seed = 0) { const s = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453; return s - Math.floor(s); }
function smoothNoise(x, y, scale, seed) {
  const xs = x / scale, ys = y / scale, x0 = Math.floor(xs), y0 = Math.floor(ys), fx = xs - x0, fy = ys - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = noise2(x0, y0, seed), b = noise2(x0 + 1, y0, seed), c = noise2(x0, y0 + 1, seed), d = noise2(x0 + 1, y0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm(x, y, seed, oct = 4, scale = 32) { let v = 0, amp = 0.5, s = scale; for (let i = 0; i < oct; i++) { v += smoothNoise(x, y, s, seed + i) * amp; amp *= 0.5; s /= 2; } return v; }

function makeTexture(size, painter, opts = {}) {
  const c = canvas(size); const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  painter(img.data, size);
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = opts.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
// Height map -> normal map
function normalFromHeight(size, heightFn, strength = 2) {
  return makeTexture(size, (d, s) => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const l = heightFn((x - 1 + s) % s, y), r = heightFn((x + 1) % s, y), u = heightFn(x, (y - 1 + s) % s), dn = heightFn(x, (y + 1) % s);
      let nx = (l - r) * strength, ny = (u - dn) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
      const i = (y * s + x) * 4; d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
  }, { linear: true });
}

const DEFS = {
  floor: { base: [0.32, 0.31, 0.30], kind: 'plates', rough: 0.75, metal: 0.15, scale: 128 },
  floor2: { base: [0.26, 0.27, 0.30], kind: 'grate', rough: 0.6, metal: 0.4, scale: 64 },
  wall: { base: [0.36, 0.30, 0.25], kind: 'blocks', rough: 0.85, metal: 0.05, scale: 128 },
  wall2: { base: [0.28, 0.30, 0.34], kind: 'panels', rough: 0.55, metal: 0.55, scale: 128 },
  trim: { base: [0.55, 0.42, 0.25], kind: 'panels', rough: 0.4, metal: 0.8, scale: 64 },
  ceiling: { base: [0.22, 0.22, 0.24], kind: 'panels', rough: 0.8, metal: 0.2, scale: 128 },
  jumppad: { base: [0.2, 0.5, 0.9], kind: 'pad', rough: 0.3, metal: 0.6, scale: 64, emissive: [0.15, 0.5, 1.0], emissiveIntensity: 1.8 },
  teleporter: { base: [0.6, 0.2, 0.9], kind: 'pad', rough: 0.3, metal: 0.4, scale: 64, emissive: [0.6, 0.2, 1.0], emissiveIntensity: 1.5 },
  lava: { base: [1, 0.35, 0.05], kind: 'lava', rough: 0.9, metal: 0, scale: 128, emissive: [1.0, 0.3, 0.05], emissiveIntensity: 2.2 },
  glow_warm: { base: [1, 0.8, 0.5], kind: 'flat', rough: 0.5, metal: 0, scale: 64, emissive: [1.0, 0.75, 0.45], emissiveIntensity: 2.5 },
  glow_cool: { base: [0.5, 0.8, 1], kind: 'flat', rough: 0.5, metal: 0, scale: 64, emissive: [0.45, 0.75, 1.0], emissiveIntensity: 2.5 },
  glow_red: { base: [1, 0.3, 0.3], kind: 'flat', rough: 0.5, metal: 0, scale: 64, emissive: [1.0, 0.25, 0.2], emissiveIntensity: 2.5 },
  glow_green: { base: [0.4, 1, 0.5], kind: 'flat', rough: 0.5, metal: 0, scale: 64, emissive: [0.3, 1.0, 0.45], emissiveIntensity: 2.5 },
  clip: { invisible: true },
  sky: { base: [0.03, 0.04, 0.08], kind: 'flat', rough: 1, metal: 0, scale: 64, emissive: [0.02, 0.03, 0.06], emissiveIntensity: 1 },
};

function heightFor(kind, seed) {
  switch (kind) {
    case 'plates': return (x, y, s) => { const gx = (x % (s / 2)) / (s / 2), gy = (y % (s / 2)) / (s / 2); const edge = Math.min(gx, 1 - gx, gy, 1 - gy); const bevel = Math.min(1, edge * 14); return bevel * 0.8 + fbm(x, y, seed, 3, 24) * 0.25; };
    case 'grate': return (x, y, s) => { const gx = (x % 16) / 16, gy = (y % 16) / 16; const hole = (gx > 0.25 && gx < 0.75 && gy > 0.25 && gy < 0.75) ? 0 : 1; return hole * 0.9 + fbm(x, y, seed, 2, 8) * 0.1; };
    case 'blocks': return (x, y, s) => { const row = Math.floor(y / (s / 4)); const off = (row % 2) * (s / 4); const gx = ((x + off) % (s / 2)) / (s / 2), gy = (y % (s / 4)) / (s / 4); const edge = Math.min(gx, 1 - gx, gy * 2, (1 - gy) * 2); return Math.min(1, edge * 10) * 0.7 + fbm(x, y, seed, 4, 20) * 0.35; };
    case 'panels': return (x, y, s) => { const gx = (x % s) / s, gy = (y % (s / 2)) / (s / 2); const edge = Math.min(gx, 1 - gx, gy, 1 - gy); const rivet = ((x % 32 === 8 || x % 32 === 9) && (y % 32 === 8 || y % 32 === 9)) ? -0.3 : 0; return Math.min(1, edge * 20) * 0.6 + rivet + fbm(x, y, seed, 3, 40) * 0.15; };
    case 'pad': return (x, y, s) => { const cx = x - s / 2, cy = y - s / 2; const r = Math.hypot(cx, cy) / (s / 2); return (Math.sin(r * 18) * 0.5 + 0.5) * 0.5 + (r < 0.9 ? 0.5 : 0); };
    case 'lava': return (x, y, s) => fbm(x, y, seed, 5, 48);
    default: return (x, y) => fbm(x, y, seed, 2, 32) * 0.2;
  }
}

export function getMaterial(name) {
  if (cache.has(name)) return cache.get(name);
  const def = DEFS[name] || DEFS.wall;
  if (def.invisible) { const m = new THREE.MeshBasicMaterial({ visible: false }); cache.set(name, m); return m; }
  const size = 256, seed = name.length * 7 + name.charCodeAt(0);
  const h = heightFor(def.kind, seed);
  const map = makeTexture(size, (d, s) => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const hv = h(x, y, s);
      const grime = fbm(x, y, seed + 9, 4, 64);
      let shade = 0.65 + hv * 0.45 - grime * 0.25;
      if (def.kind === 'lava') shade = 0.6 + hv * 1.2;
      const i = (y * s + x) * 4;
      d[i] = Math.min(255, def.base[0] * 255 * shade); d[i + 1] = Math.min(255, def.base[1] * 255 * shade); d[i + 2] = Math.min(255, def.base[2] * 255 * shade); d[i + 3] = 255;
    }
  });
  const normalMap = normalFromHeight(size, (x, y) => h(x, y, size), def.kind === 'lava' ? 1.5 : 3);
  const roughnessMap = makeTexture(size, (d, s) => {
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { const g = fbm(x, y, seed + 3, 3, 40); const v = Math.min(1, Math.max(0, def.rough + (g - 0.5) * 0.5)); const i = (y * s + x) * 4; d[i] = d[i + 1] = d[i + 2] = v * 255; d[i + 3] = 255; }
  }, { linear: true });
  const m = new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap, roughness: 1, metalness: def.metal, normalScale: new THREE.Vector2(0.8, 0.8) });
  if (def.emissive) { m.emissive = new THREE.Color(...def.emissive); m.emissiveIntensity = def.emissiveIntensity; m.emissiveMap = map; }
  m.userData.scale = def.scale;
  cache.set(name, m);
  return m;
}
export const MATERIAL_DEFS = DEFS;
