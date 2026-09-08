// Hand-authored town "Millbrook Crossing": a crossroads with four buildings, a forest belt and a car wreck.
// Deterministic (seeded) so tests and evidence runs are reproducible. Coordinates are tiles; the world is 48x48.
import { TILE, SOLID, OPAQUE, DOOR_HP, WINDOW_HP } from './constants.js';

export const WORLD_W = 48, WORLD_H = 48;

export function mulberry32(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export class World {
  constructor(seed = 7) {
    this.w = WORLD_W; this.h = WORLD_H;
    this.tiles = new Uint8Array(this.w * this.h).fill(TILE.GRASS);
    this.structures = [];      // { name, x0, y0, x1, y1 } (inclusive, outer wall)
    this.containers = [];      // { id, x, y, kind, items: [{item,count}], opened }
    this.openings = new Map(); // key "x,y" -> { x, y, kind: 'door'|'window', open, hp, maxHp, barricade (hp) , barricadeMax }
    this.trees = new Map();    // key -> hits remaining
    this.spawn = { x: 12, y: 12, facing: Math.PI / 2 };
    this.zombieSpawns = [];
    this.rand = mulberry32(seed);
    this.build();
  }
  idx(x, y) { return y * this.w + x; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  get(x, y) { return this.inBounds(x, y) ? this.tiles[this.idx(x, y)] : TILE.WALL; }
  set(x, y, t) { if (this.inBounds(x, y)) this.tiles[this.idx(x, y)] = t; }
  key(x, y) { return x + ',' + y; }
  opening(x, y) { return this.openings.get(this.key(x, y)) || null; }
  // Movement blocking for the player (windows always block, doors block when closed).
  blocksPlayer(x, y) {
    const t = this.get(x, y);
    if (SOLID.has(t)) return true;
    if (t === TILE.WINDOW) return true;
    if (t === TILE.DOOR) { const o = this.opening(x, y); return !o || !o.open || o.barricade > 0; }
    return false;
  }
  // Movement blocking for zombies: same, but an opening returns the object so the AI can bash it.
  blocksZombie(x, y) {
    const t = this.get(x, y);
    if (SOLID.has(t)) return true;
    if (t === TILE.WINDOW || t === TILE.DOOR) { const o = this.opening(x, y); if (!o) return true; if (o.barricade > 0) return true; if (t === TILE.WINDOW) return o.hp > 0; return !o.open; }
    return false;
  }
  blocksSight(x, y) {
    const t = this.get(x, y);
    if (OPAQUE.has(t)) return true;
    if (t === TILE.WINDOW || t === TILE.DOOR) { const o = this.opening(x, y); return !!o && o.barricade > 0; }
    return false;
  }
  // -------- authoring helpers --------
  rect(x0, y0, x1, y1, t) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, t); }
  house(name, x0, y0, x1, y1, doors, windows) {
    this.rect(x0, y0, x1, y1, TILE.WALL);
    this.rect(x0 + 1, y0 + 1, x1 - 1, y1 - 1, TILE.FLOOR);
    for (const [x, y] of doors) { this.set(x, y, TILE.DOOR); this.openings.set(this.key(x, y), { x, y, kind: 'door', open: false, hp: DOOR_HP, maxHp: DOOR_HP, barricade: 0, barricadeMax: 0, structure: name }); }
    for (const [x, y] of windows) { this.set(x, y, TILE.WINDOW); this.openings.set(this.key(x, y), { x, y, kind: 'window', open: false, hp: WINDOW_HP, maxHp: WINDOW_HP, barricade: 0, barricadeMax: 0, structure: name }); }
    this.structures.push({ name, x0, y0, x1, y1 });
  }
  container(kind, x, y, items) { this.containers.push({ id: this.containers.length, x, y, kind, items, opened: false }); }
  tree(x, y) { if (this.get(x, y) === TILE.GRASS) { this.set(x, y, TILE.TREE); this.trees.set(this.key(x, y), 3); } }
  build() {
    const r = this.rand;
    // roads: east-west rows 22..25, north-south columns 22..25, sidewalks around them
    this.rect(0, 21, 47, 26, TILE.SIDEWALK); this.rect(21, 0, 26, 47, TILE.SIDEWALK);
    this.rect(0, 22, 47, 25, TILE.ROAD); this.rect(22, 0, 25, 47, TILE.ROAD);
    // buildings
    this.house('Start house', 8, 8, 15, 14, [[12, 14]], [[8, 11], [10, 8], [15, 11]]);
    this.house('Blue house', 30, 6, 38, 14, [[34, 14], [30, 9]], [[38, 10], [33, 6], [36, 6]]);
    this.house('Gas station', 6, 30, 16, 36, [[11, 30], [16, 33]], [[8, 30], [14, 30], [6, 33]]);
    this.house('Red house', 30, 30, 40, 38, [[35, 30]], [[30, 34], [40, 33], [33, 38], [37, 38]]);
    this.rect(11, 27, 11, 27, TILE.PUMP); this.rect(14, 27, 14, 27, TILE.PUMP);
    this.set(28, 24, TILE.WRECK); this.set(29, 24, TILE.WRECK);
    // loot (fixed layout: the slice is authored, not random, so every run tells the same story)
    this.container('fridge', 9, 9, [{ item: 'water', count: 1 }, { item: 'food', count: 1 }]);
    this.container('closet', 14, 9, [{ item: 'bat', count: 1 }]);
    this.container('shelf', 14, 13, [{ item: 'plank', count: 2 }]);
    this.container('cabinet', 31, 7, [{ item: 'bandage', count: 2 }]);
    this.container('fridge', 37, 7, [{ item: 'food', count: 2 }, { item: 'water', count: 1 }]);
    this.container('shelf', 37, 13, [{ item: 'plank', count: 3 }]);
    this.container('locker', 7, 35, [{ item: 'pistol', count: 1 }, { item: 'ammo', count: 8 }]);
    this.container('cabinet', 7, 31, [{ item: 'bandage', count: 1 }, { item: 'water', count: 2 }]);
    this.container('shelf', 15, 35, [{ item: 'plank', count: 3 }, { item: 'food', count: 1 }]);
    this.container('wreck', 29, 24, [{ item: 'ammo', count: 8 }]);
    this.container('cabinet', 31, 31, [{ item: 'bandage', count: 1 }, { item: 'ammo', count: 8 }]);
    this.container('fridge', 39, 31, [{ item: 'water', count: 2 }]);
    this.container('shelf', 39, 37, [{ item: 'plank', count: 2 }]);
    // forest belt + clusters (deterministic)
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const edge = x < 4 || y < 4 || x > 43 || y > 43;
      if (edge && r() < 0.55) this.tree(x, y);
    }
    for (const [cx, cy, n] of [[5, 17, 6], [18, 5, 5], [42, 18, 5], [19, 40, 6], [42, 42, 4], [4, 42, 5]]) {
      for (let i = 0; i < n; i++) this.tree(cx + Math.floor(r() * 4) - 2, cy + Math.floor(r() * 4) - 2);
    }
    // never let a tree seal the map edge access for horde spawns: leave the road ends open (already road)
    this.spawn = { x: 12.5, y: 12.5, facing: Math.PI / 2 };
    this.zombieSpawns = [[19.5, 18.5], [27.5, 19.5], [36.5, 20.5], [17.5, 28.5], [26.5, 33.5], [40.5, 26.5], [12.5, 40.5], [33.5, 42.5]];
  }
  // Tiles on the map border where a horde zombie can appear (walkable, not inside anything).
  edgeSpawns() {
    const out = [];
    for (let x = 0; x < this.w; x++) for (const y of [0, this.h - 1]) if (!this.blocksZombie(x, y)) out.push([x + 0.5, y + 0.5]);
    for (let y = 1; y < this.h - 1; y++) for (const x of [0, this.w - 1]) if (!this.blocksZombie(x, y)) out.push([x + 0.5, y + 0.5]);
    return out;
  }
}
