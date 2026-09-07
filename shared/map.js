// Map format + DSL. A map module exports `build(m)` and calls helpers on the MapBuilder.
// Units are Quake units, Z up. Brush materials are string keys the renderer resolves.
import { boxBrush, rampBrush, brushFromPlanes } from './brush.js';
import { ITEMS } from './constants.js';

export const BRUSH_FLAGS = { SLICK: 1, NODRAW: 2, PLAYERCLIP: 4, LAVA: 8, JUMPPAD: 16, TELEPORTER: 32, NOCOLLIDE: 64 };

export class MapBuilder {
  constructor(name) {
    this.name = name;
    this.title = name;
    this.author = '';
    this.brushes = [];
    this.items = [];
    this.spawns = [];
    this.lights = [];
    this.triggers = [];
    this.navNodes = [];
    this.decor = [];
    this.ambient = { sky: '#0b0f1a', fog: null, hemi: ['#8fa3c7', '#20160f', 0.35], sun: null, music: 'arena' };
    this.zones = [];
  }
  box(mins, maxs, mat = 'wall', extra = {}) { const b = boxBrush(mins, maxs, { mat, flags: 0, ...extra }); this.brushes.push(b); return b; }
  // convenience: a box given by origin corner and size
  block(x, y, z, w, d, h, mat = 'wall', extra = {}) { return this.box([x, y, z], [x + w, y + d, z + h], mat, extra); }
  ramp(mins, maxs, dir, mat = 'floor', extra = {}) { const b = rampBrush(mins, maxs, dir, { mat, flags: 0, ...extra }); this.brushes.push(b); return b; }
  planes(planes, mat = 'wall', extra = {}) { const b = brushFromPlanes(planes, { mat, flags: 0, ...extra }); this.brushes.push(b); return b; }
  // stairs from (x,y,z) climbing along dir over `steps` steps of `rise` height and `run` depth, width w
  stairs(x, y, z, dir, steps, rise, run, w, mat = 'floor') {
    for (let i = 0; i < steps; i++) {
      const h = rise * (i + 1);
      switch (dir) {
        case 'x+': this.box([x + run * i, y, z], [x + run * (i + 1), y + w, z + h], mat); break;
        case 'x-': this.box([x - run * (i + 1), y, z], [x - run * i, y + w, z + h], mat); break;
        case 'y+': this.box([x, y + run * i, z], [x + w, y + run * (i + 1), z + h], mat); break;
        case 'y-': this.box([x, y - run * (i + 1), z], [x + w, y - run * i, z + h], mat); break;
      }
    }
  }
  // Item at origin (origin is item center; items rest 15 units above floor typically -> pass floor z + 20)
  item(type, origin, extra = {}) {
    if (!ITEMS[type]) throw new Error('unknown item ' + type);
    this.items.push({ type, origin, ...extra });
  }
  spawn(origin, yaw = 0) { this.spawns.push({ origin, yaw }); }
  light(origin, color = '#ffffff', intensity = 1, radius = 600, extra = {}) { this.lights.push({ origin, color, intensity, radius, ...extra }); }
  // Jump pad: trigger volume (mins/maxs) that launches the player toward `target` (a world point) with Q3 trajectory solve.
  jumppad(mins, maxs, target, mat = 'jumppad') {
    const b = boxBrush(mins, maxs, { mat, flags: BRUSH_FLAGS.JUMPPAD, nonsolid: true, target });
    this.triggers.push({ kind: 'jumppad', mins, maxs, target, brush: b });
    // visible pad surface: thin solid box under the trigger
    this.box([mins[0], mins[1], mins[2] - 4], [maxs[0], maxs[1], mins[2]], mat, { emissive: true });
    return b;
  }
  teleporter(mins, maxs, dest, destYaw = 0, mat = 'teleporter') {
    this.triggers.push({ kind: 'teleporter', mins, maxs, dest, destYaw });
    this.decor.push({ kind: 'teleporter', mins, maxs });
  }
  nav(origin, extra = {}) { this.navNodes.push({ origin, ...extra }); }
  zone(name, mins, maxs, color) { this.zones.push({ name, mins, maxs, color }); }
  lava(mins, maxs) { const b = boxBrush(mins, maxs, { mat: 'lava', flags: BRUSH_FLAGS.LAVA, nonsolid: true, emissive: true }); this.brushes.push(b); this.triggers.push({ kind: 'lava', mins, maxs }); return b; }
  clip(mins, maxs) { return this.box(mins, maxs, 'clip', { flags: BRUSH_FLAGS.PLAYERCLIP | BRUSH_FLAGS.NODRAW }); }

  finish() {
    const mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity];
    for (const b of this.brushes) for (let i = 0; i < 3; i++) { mins[i] = Math.min(mins[i], b.mins[i]); maxs[i] = Math.max(maxs[i], b.maxs[i]); }
    this.bounds = { mins, maxs };
    return this;
  }
}

export async function loadMap(name) {
  const mod = await import(`../maps/${name}.js`);
  const m = new MapBuilder(name);
  mod.build(m);
  return m.finish();
}

export function loadMapSync(mod, name) {
  const m = new MapBuilder(name);
  mod.build(m);
  return m.finish();
}

// Solve a Q3 jump pad launch velocity: reach `target` from `origin` under gravity with a fixed flight time.
export function jumppadVelocity(origin, target, gravity) {
  const dx = target[0] - origin[0], dy = target[1] - origin[1], dz = target[2] - origin[2];
  const dist = Math.hypot(dx, dy);
  // Q3 AimAtTarget: height = target.z - origin.z; time = sqrt(height / (0.5*gravity)); dist/time for xy
  let height = dz;
  if (height < 100) height = 100; // ensure a visible arc
  const time = Math.sqrt(height / (0.5 * gravity));
  const vz = time * gravity;
  const vxy = dist / time;
  const l = dist || 1;
  return [dx / l * vxy, dy / l * vxy, vz];
}
