// Minimal Vec3 helpers on plain arrays [x,y,z] (Z-up, Quake units).
export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const copy = (a) => [a[0], a[1], a[2]];
export const set = (o, a) => { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; };
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const ma = (a, s, b) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
export const lengthSq = (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
export const dist = (a, b) => length(sub(a, b));
export const normalize = (a) => { const l = length(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const equals = (a, b, eps = 1e-6) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps && Math.abs(a[2] - b[2]) < eps;

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
// Quake angles: [pitch, yaw, roll] in degrees. Yaw 0 = +X, yaw 90 = +Y. Pitch positive = looking down.
export function angleVectors(angles) {
  const p = angles[0] * DEG2RAD, y = angles[1] * DEG2RAD, r = (angles[2] || 0) * DEG2RAD;
  const sp = Math.sin(p), cp = Math.cos(p), sy = Math.sin(y), cy = Math.cos(y), sr = Math.sin(r), cr = Math.cos(r);
  const forward = [cp * cy, cp * sy, -sp];
  const right = [-sr * sp * cy + cr * sy, -sr * sp * sy - cr * cy, -sr * cp];
  const up = [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp];
  return { forward, right, up };
}
export function vectorToAngles(v) {
  const yaw = Math.atan2(v[1], v[0]) * RAD2DEG;
  const f = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
  const pitch = -Math.atan2(v[2], f) * RAD2DEG;
  return [pitch, yaw, 0];
}
export function normalizeAngle(a) { a = a % 360; if (a > 180) a -= 360; if (a < -180) a += 360; return a; }
export function lerpAngle(a, b, t) { return a + normalizeAngle(b - a) * t; }

// Deterministic PRNG (mulberry32) so bots and spread are reproducible in tests.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
