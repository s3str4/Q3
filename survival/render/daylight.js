// Time-of-day lighting curve: sim.hour -> sun/sky/fog/lantern targets, smoothed in real time so a phase change
// (or a big time-scale jump) always lerps over ~2 s instead of snapping. Every colour is a THREE.Color so the
// renderer can copy straight into lights, background and fog.
import * as THREE from 'three';

// Keyframes by hour (wrapping at 24). sun: colour + intensity (physical units, Lambert + ACES), hemi: sky/ground/
// intensity, sky: background + fog colour, fog: [near, far] as OFFSETS beyond the camera-to-target distance (three.js
// fog is camera distance and the fixed 3/4 camera already sits ~20 tiles from everything on screen, so absolute
// near/far values below that fog out the whole frame at night), el: sun elevation (deg), lantern: 0..1.
const KEYS = [
  { h: 0,    sky: 0x070b1a, sun: 0x3a4a8a, sunI: 0.16, hSky: 0x1c2a58, hGround: 0x0a0c14, hemiI: 0.42, fog: [22, 70], el: 55, lantern: 1 },
  { h: 5,    sky: 0x0a1024, sun: 0x3f4f90, sunI: 0.18, hSky: 0x1e2c5c, hGround: 0x0a0c14, hemiI: 0.42, fog: [22, 72], el: 45, lantern: 1 },
  { h: 6,    sky: 0x5b6d8f, sun: 0xa8bcd8, sunI: 0.55, hSky: 0x6e7f9e, hGround: 0x2a2c30, hemiI: 0.42, fog: [18, 76], el: 8,  lantern: 0.7 },
  { h: 7,    sky: 0x9ab2cf, sun: 0xffd9b0, sunI: 1.1,  hSky: 0xa8c0de, hGround: 0x4a4a3a, hemiI: 0.55, fog: [14, 80], el: 16, lantern: 0.15 },
  { h: 9,    sky: 0x8ec2f5, sun: 0xfff0d6, sunI: 1.7,  hSky: 0xbfe0ff, hGround: 0x66644a, hemiI: 0.62, fog: [12, 85], el: 38, lantern: 0 },
  { h: 12,   sky: 0x86bdf2, sun: 0xfff4e0, sunI: 1.9,  hSky: 0xc4e2ff, hGround: 0x6a6a4e, hemiI: 0.65, fog: [12, 88], el: 64, lantern: 0 },
  // Dusk (7DTD red-sky warning window): 16:00-19:30 stays lit (sun elevation >= 42 deg, sunI >= 1.5 through 18:00)
  // with a warm ground tint; the fall to night happens only between 19:30 and 21:00 (21:00 onward is unchanged).
  { h: 16,   sky: 0x8cb8e6, sun: 0xffe8c4, sunI: 1.7,  hSky: 0xb8d6f4, hGround: 0x6a6048, hemiI: 0.62, fog: [12, 85], el: 46, lantern: 0 },
  { h: 18,   sky: 0xe8ac6c, sun: 0xffc88a, sunI: 1.7,  hSky: 0xdeac7c, hGround: 0x866440, hemiI: 0.95, fog: [14, 82], el: 46, lantern: 0.1 },
  { h: 19.5, sky: 0xc4623a, sun: 0xff9048, sunI: 1.5,  hSky: 0xbc6e48, hGround: 0x704a34, hemiI: 0.85, fog: [16, 78], el: 36, lantern: 0.4 },
  { h: 21,   sky: 0x101a3a, sun: 0x4a5aa0, sunI: 0.22, hSky: 0x243468, hGround: 0x0a0c14, hemiI: 0.4,  fog: [20, 72], el: 30, lantern: 1 },
  { h: 22.5, sky: 0x080d20, sun: 0x3a4a8a, sunI: 0.16, hSky: 0x1c2a58, hGround: 0x0a0c14, hemiI: 0.42, fog: [22, 70], el: 50, lantern: 1 },
  { h: 24,   sky: 0x070b1a, sun: 0x3a4a8a, sunI: 0.16, hSky: 0x1c2a58, hGround: 0x0a0c14, hemiI: 0.42, fog: [22, 70], el: 55, lantern: 1 },
];
const SCALAR_KEYS = ['sunI', 'hemiI', 'el', 'lantern'];
const COLOR_KEYS = ['sky', 'sun', 'hSky', 'hGround'];

export class Daylight {
  constructor() {
    this.camDist = 20; // camera-to-target distance the fog offsets are added to; the renderer passes its own each frame
    this.target = this.sample(12); this.state = this.sample(12);
    this.sunDir = new THREE.Vector3(0.4, 1, 0.3).normalize();
    this.tau = 0.6; // seconds; a step settles within ~2 s (3 tau)
    this.first = true;
  }
  // Interpolated keyframe at hour h.
  sample(h) {
    h = ((h % 24) + 24) % 24;
    let i = 0; while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++;
    const a = KEYS[i], b = KEYS[i + 1]; const t = Math.min(1, Math.max(0, (h - a.h) / (b.h - a.h)));
    const out = { fogNear: this.camDist + a.fog[0] + (b.fog[0] - a.fog[0]) * t, fogFar: this.camDist + a.fog[1] + (b.fog[1] - a.fog[1]) * t };
    for (const k of SCALAR_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
    for (const k of COLOR_KEYS) out[k] = new THREE.Color(a[k]).lerp(new THREE.Color(b[k]), t);
    // sun azimuth sweeps east->west across the day; at night the "moon" sits high to the north-east
    const day = h >= 6 && h <= 19.5; const az = day ? ((h - 6) / 13.5) * Math.PI : Math.PI * 1.25;
    out.az = az;
    return out;
  }
  // Smooth the live state towards the curve value for `hour`; dt in real seconds.
  update(hour, dt, camDist) {
    if (camDist) this.camDist = camDist;
    const tgt = this.sample(hour); const s = this.state;
    const k = this.first ? 1 : 1 - Math.exp(-dt / this.tau); this.first = false;
    for (const key of [...SCALAR_KEYS, 'fogNear', 'fogFar', 'az']) s[key] += (tgt[key] - s[key]) * k;
    for (const key of COLOR_KEYS) s[key].lerp(tgt[key], k);
    const el = s.el * Math.PI / 180;
    this.sunDir.set(Math.cos(s.az) * Math.cos(el), Math.sin(el), Math.sin(s.az) * Math.cos(el)).normalize();
    // darkness 0 (noon) .. 1 (deep night): drives lantern, eye glow, marker brightness
    s.dark = Math.min(1, Math.max(0, s.lantern));
    return s;
  }
}
