// Arena Duel: "Crossfire" - the competitive 1v1 map.
//
// Two atria (west = Red Armor, warm; east = Mega Health, cool) joined by four distinct routes:
//   1. the upper bridge (z 192) through the upper throats, crossing the central hub in the open,
//   2. the lower hub (z 0) through the offset lower throats (west door on the north half, east door on the
//      south half, so there is no straight rail lane from atrium to atrium),
//   3. the south loop (stub -> run -> yellow-armor chamber -> run -> stub), and
//   4. the north loop (its 180-degree twin).
// Each atrium has an L-shaped upper balcony reached by stairs (west) / a ramp (east) AND by a jump pad.
// The layout is point-symmetric (180 degrees about the origin) so both players get the same movement options;
// items, materials and lighting break the symmetry so each side reads differently. See maps/README.md.
import { Shell, rot180, navGrid } from './shell.js';

export const meta = {
  title: 'Crossfire', author: 'builder-map',
  // rooms with their clearance class, used by tests/map.test.mjs: corridors must be >= 96 wide and >= 128 tall,
  // rooms >= 192 tall. Filled in by build().
  rooms: [],
  // points where the test measures corridor width across `axis` (the corridor's narrow direction)
  corridorSamples: [],
  levels: { lower: 0, upper: 192 },
};

const L0 = 0, L1 = 192;       // floor levels
const SLAB = 32;               // balcony / bridge slab thickness (walk surface at L1, underside at L1 - SLAB)
// key dimensions (west side; the east side is the 180-degree rotation)
const AX0 = 512, AX1 = 1152;   // atrium inner / outer x (640 wide)
const AY = 448;                // atrium half length (896 long)
const HUB = 288;               // hub half size (576 square); throats run from HUB to AX0 (224 long)
const STRIP = 192;             // balcony strip width

export function build(m) {
  m.title = meta.title; m.author = meta.author;
  meta.rooms.length = 0; meta.corridorSamples.length = 0;
  m.ambient = { sky: '#06080f', fog: ['#06080f', 1800, 6500], hemi: ['#5f6f93', '#26180e', 0.32], sun: null, music: 'arena' };

  // ---------------- rooms (voids) ----------------
  const sh = new Shell(m, 32);
  const R = (name, mins, maxs, cls, mats) => { sh.room(name, mins, maxs, mats); meta.rooms.push({ name, mins, maxs, cls }); };
  // west side (warm, Red Armor). Every west room is mirrored to the east with rot180.
  const west = [
    ['atriumA', [-AX1, -AY, L0], [-AX0, AY, 448], 'room', { wall: 'wall', floor: 'floor', ceil: 'sky' }],
    ['throatA_lo', [-AX0, 0, L0], [-HUB, HUB, 448], 'room', { wall: 'wall', floor: 'floor', ceil: 'sky' }],   // gallery: full height, open to the hub and under the bridge
    ['throatA_up', [-AX0, -96, L1], [-HUB, 96, 352], 'hall', { wall: 'wall', floor: 'floor2' }],           // its north half overlaps the gallery: a bridge segment with a drop on one side
    ['southStubA', [-800, -672, L0], [-640, -AY, 160], 'hall', { wall: 'wall', floor: 'floor' }],     // overlaps the run (voids may overlap)
    ['southRunA', [-800, -672, L0], [-160, -512, 160], 'hall', { wall: 'wall', floor: 'floor' }],
    ['southChamber', [-160, -960, L0], [160, -512, 256], 'room', { wall: 'wall2', floor: 'floor', ceil: 'ceiling' }],
    ['southRunB', [160, -928, L0], [800, -768, 160], 'hall', { wall: 'wall2', floor: 'floor' }],       // 96 below run A: no end-to-end sightline
    ['southStubB', [640, -768, L0], [800, -AY, 160], 'hall', { wall: 'wall2', floor: 'floor' }],
  ];
  // swap the trailing A/B letter and south->north: southRunA -> northRunB, southRunB -> northRunA, atriumA -> atriumB
  const eastName = (n) => n.replace(/([AB])(_|$)/, (s, l, t) => (l === 'A' ? 'B' : 'A') + t).replace(/^south/, 'north');
  // the east twins swap materials so the half of each loop nearest an atrium carries that atrium's wall style
  const eastMats = { atriumA: { wall: 'wall2', floor: 'floor', ceil: 'sky' }, throatA_lo: { wall: 'wall2', floor: 'floor', ceil: 'sky' }, throatA_up: { wall: 'wall2', floor: 'floor2' },
    southStubA: { wall: 'wall2', floor: 'floor' }, southRunA: { wall: 'wall2', floor: 'floor' }, southChamber: { wall: 'wall', floor: 'floor', ceil: 'ceiling' }, southRunB: { wall: 'wall', floor: 'floor' }, southStubB: { wall: 'wall', floor: 'floor' } };
  for (const [name, mins, maxs, cls, mats] of west) {
    R(name, mins, maxs, cls, mats);
    const [rm, rx] = rot180(mins, maxs);
    R(eastName(name), rm, rx, cls, eastMats[name]);
  }
  R('hub', [-HUB, -HUB, L0], [HUB, HUB, 448], 'room', { wall: 'wall2', floor: 'floor', ceil: 'sky' });
  sh.build();

  // corridor width samples (point, narrow axis)
  meta.corridorSamples.push(
    { at: [-400, 144, 40], axis: 1 }, { at: [400, -144, 40], axis: 1 }, { at: [-400, -48, 232], axis: 1 }, { at: [400, 48, 232], axis: 1 },
    { at: [-720, -480, 40], axis: 0 }, { at: [720, 480, 40], axis: 0 }, { at: [-500, -592, 40], axis: 1 }, { at: [500, 592, 40], axis: 1 },
    { at: [500, -848, 40], axis: 1 }, { at: [-500, 848, 40], axis: 1 }, { at: [720, -608, 40], axis: 0 }, { at: [-720, 608, 40], axis: 0 },
    { at: [0, 0, 232], axis: 1 }, // the bridge
  );

  // ---------------- platforms, stairs, ramps, pads (solids inside the voids) ----------------
  // Atrium A: L-shaped balcony (north strip + east strip) as an overhanging slab; the lower floor runs underneath.
  m.box([-AX1, AY - STRIP, L1 - SLAB], [-AX0, AY, L1], 'floor2');            // north strip
  m.box([-AX0 - STRIP, -192, L1 - SLAB], [-AX0, AY - STRIP, L1], 'floor2');  // east strip (the bridge lands here)
  m.stairs(-AX1, -128, L0, 'y+', 12, 16, 32, 128, 'floor');                   // west wall stairs: 12 x 16 rise, 32 run -> z 192 at y 256
  m.box([-728, 232, L0], [-680, 280, L1 - SLAB], 'trim');                     // pillar at the balcony's inner corner
  m.box([-896, -64, L0], [-768, 64, 48], 'trim');                             // low cover block mid-floor
  // Pad targets sit 96 above the landing surface: the Q3 solve puts the flight apex at the target and launches from
  // the trigger top, so the player's box clears the balcony lip with ~40 units to spare and lands ~150 units further on.
  m.jumppad([-656, -408, 4], [-560, -312, 40], [-608, -96, L1 + 96]);        // SE corner pad -> east strip
  // Atrium B: point-symmetric twin, with a ramp instead of stairs.
  m.box([AX0, -AY, L1 - SLAB], [AX1, -AY + STRIP, L1], 'floor2');            // south strip
  m.box([AX0, -AY + STRIP, L1 - SLAB], [AX0 + STRIP, 192, L1], 'floor2');    // west strip
  m.ramp([AX1 - 128, -256, L0], [AX1, 128, L1], 'y-', 'floor');              // east wall ramp: z 0 at y 128 -> z 192 at y -256
  m.box([680, -280, L0], [728, -232, L1 - SLAB], 'trim');
  m.box([768, -64, L0], [896, 64, 48], 'trim');
  m.jumppad([560, 312, 4], [656, 408, 40], [608, 96, L1 + 96]);              // NW corner pad -> west strip
  // Hub: the bridge slab (with its segments over both galleries) and two support pillars (the rocket launcher sits between them).
  m.box([-HUB, -96, L1 - SLAB], [HUB, 96, L1], 'floor2');
  m.box([-AX0, 0, L1 - SLAB], [-HUB, 96, L1], 'floor2'); m.box([HUB, -96, L1 - SLAB], [AX0, 0, L1], 'floor2');
  m.box([-152, -40, L0], [-104, 40, L1 - SLAB], 'trim');
  m.box([104, -40, L0], [152, 40, L1 - SLAB], 'trim');

  // ---------------- readability: emissive zone strips and door trims ----------------
  // 4-unit-thick strips flush against the walls at z 112..120 (below eye level), split around doors, stairs and
  // the major-item markers so no two strips overlap. Warm in the west, cool in the east, green in the hub.
  const strip = (mins, maxs, mat) => m.box(mins, maxs, mat);
  for (const [y0, y1] of [[-AY, -288], [-160, -128], [256, AY]]) strip([-AX1, y0, 112], [-AX1 + 4, y1, 120], 'glow_warm'); // A west wall (skips marker + stairs)
  for (const [x0, x1] of [[-AX1, -800], [-640, -AX0]]) { strip([x0, -AY, 112], [x1, -AY + 4, 120], 'glow_warm'); strip([x0, AY - 4, 112], [x1, AY, 120], 'glow_warm'); } // A south/north walls (skip doors)
  for (const [y0, y1] of [[-AY, -256], [128, 160], [288, AY]]) strip([AX1 - 4, y0, 112], [AX1, y1, 120], 'glow_cool'); // B east wall (skips ramp + marker)
  for (const [x0, x1] of [[AX0, 640], [800, AX1]]) { strip([x0, -AY, 112], [x1, -AY + 4, 120], 'glow_cool'); strip([x0, AY - 4, 112], [x1, AY, 120], 'glow_cool'); }
  strip([-HUB, HUB - 4, 112], [HUB, HUB, 120], 'glow_green'); strip([-HUB, -HUB, 112], [HUB, -HUB + 4, 120], 'glow_green'); // hub north/south walls
  // balcony lips (underside front edge) so the upper level reads from below
  strip([-AX1, AY - STRIP - 4, L1 - SLAB - 6], [-AX0, AY - STRIP, L1 - SLAB], 'glow_warm');
  strip([-AX0 - STRIP, -192, L1 - SLAB - 6], [-AX0 - STRIP + 4, AY - STRIP - 4, L1 - SLAB], 'glow_warm');
  strip([AX0, -AY + STRIP, L1 - SLAB - 6], [AX1, -AY + STRIP + 4, L1 - SLAB], 'glow_cool');
  strip([AX0 + STRIP - 4, -AY + STRIP + 4, L1 - SLAB - 6], [AX0 + STRIP, 192, L1 - SLAB], 'glow_cool');
  // bridge edges: neutral green (the hub belongs to nobody)
  strip([-AX0, 96, L1 - 8], [HUB, 100, L1], 'glow_green'); strip([-HUB, -100, L1 - 8], [HUB, -96, L1], 'glow_green');
  strip([HUB, -100, L1 - 8], [AX0, -96, L1], 'glow_green'); strip([-HUB, 96, L1 - 8], [HUB, 100, L1], 'glow_green');
  // major item markers: a tall red bar on the wall beside Red Armor, a tall cool bar beside Mega
  strip([-AX1, -288, 40], [-AX1 + 4, -160, 200], 'glow_red');
  strip([AX1 - 4, 160, 40], [AX1, 288, 200], 'glow_cool');
  // corridor strips along the loops: warm on the west halves, cool on the east halves
  strip([-800, -672, 112], [-160, -668, 120], 'glow_warm'); strip([160, -772, 112], [800, -768, 120], 'glow_cool');
  strip([160, 668, 112], [800, 672, 120], 'glow_cool'); strip([-800, 768, 112], [-160, 772, 120], 'glow_warm');
  // door lintels (trim) just inside the lower throats and the loop doors
  m.box([-800, -AY - 8, 152], [-640, -AY, 160], 'trim'); m.box([640, AY, 152], [800, AY + 8, 160], 'trim');
  m.box([-800, AY, 152], [-640, AY + 8, 160], 'trim'); m.box([640, -AY - 8, 152], [800, -AY, 160], 'trim');

  // ---------------- items ----------------
  const I = (type, x, y, floorZ) => m.item(type, [x, y, floorZ + 20], { floorZ });
  // majors: Red Armor west lower, Mega east lower, Rail on the west balcony, LG on the east balcony, RL in the hub
  I('armorRed', -832, -224, L0);          // south-centre of the west floor, overlooked by the rail balcony
  I('mega', 832, 224, L0);
  I('weaponRail', -960, 352, L1);
  I('weaponLightning', 960, -352, L1);
  I('weaponRocket', 0, 0, L0);
  I('weaponPlasma', 0, 0, L1);            // on the bridge, directly above the RL
  I('weaponShotgun', -1088, -320, L0);    // west lower, SW corner at the stairs foot
  I('armorYellow', 0, -736, L0);          // south chamber
  I('armorYellow', 0, 736, L0);           // north chamber
  I('health25', -576, 352, L0);           // west, under the north strip by the north door
  I('health25', 576, -352, L0);           // east, under the south strip by the south door
  I('health25', -160, -160, L0);          // hub, south-west quadrant
  for (const y of [-64, 0, 64]) I('health5', -608, y, L1);   // west east-strip bubbles (pad landing lane)
  for (const y of [-64, 0, 64]) I('health5', 608, y, L1);    // east west-strip bubbles
  for (const x of [-80, 0, 80]) I('health5', x, -600, L0);   // south chamber entry
  for (const x of [-80, 0, 80]) I('health5', x, 600, L0);    // north chamber entry
  for (const x of [-1104, -1056, -1008]) I('armorShard', x, 352, L0);  // under the west north-strip (dead-end reward)
  for (const x of [1104, 1056, 1008]) I('armorShard', x, -352, L0);    // under the east south-strip
  // ammo along the transit routes
  I('ammoRockets', 160, 160, L0); I('ammoRockets', -480, -592, L0);
  I('ammoSlugs', -704, 384, L1); I('ammoSlugs', 480, 592, L0);
  I('ammoCells', 704, -384, L1); I('ammoCells', -480, 848, L0);
  I('ammoShells', 1088, 320, L0); I('ammoShells', 480, -848, L0);
  I('ammoPlasma', -400, 0, L1); I('ammoPlasma', 400, 0, L1);
  I('ammoBullets', -960, -64, L0); I('ammoBullets', 960, 64, L0);

  // ---------------- spawns (6): none sees both majors; loop spawns see neither ----------------
  m.spawn([-1088, 352, L1 + 24], -90);  // west balcony, west end, looking south
  m.spawn([-880, 400, L0 + 24], -90);   // west lower, under the north strip
  m.spawn([1088, -352, L1 + 24], 90);   // east balcony, east end, looking north
  m.spawn([880, -400, L0 + 24], 90);    // east lower, under the south strip
  m.spawn([-320, -592, L0 + 24], 180);  // south loop, west run
  m.spawn([320, 592, L0 + 24], 0);      // north loop, east run

  // ---------------- lights (14 max; the first 4 cast shadows) ----------------
  // Keys hang 300 above the atrium floors (clear of a jumping player on the balconies at 192 + 56 + 45) so the floors
  // get real irradiance; the major-item spots sit low (140) so the metallic floor plates pick up their highlight.
  m.light([-832, 0, 300], '#ffc88a', 1.6, 1400);                      // west key (warm)   [shadow]
  m.light([832, 0, 300], '#8ec4ff', 1.6, 1400);                       // east key (cool)   [shadow]
  m.light([0, 0, 380], '#f4f1ea', 1.4, 1100);                         // hub key           [shadow]
  m.light([-832, -224, 140], '#ff8a5a', 1.2, 700);                    // Red Armor spot    [shadow]
  m.light([832, 224, 140], '#7ad0ff', 1.2, 700, { shadow: false });    // Mega spot
  m.light([-880, 352, 100], '#ffd9a8', 0.9, 600, { shadow: false });   // under the west north strip (shards, north door); the key lights the rail above
  m.light([880, -352, 100], '#a8d8ff', 0.9, 600, { shadow: false });   // under the east south strip (shards, south door)
  m.light([0, -180, 120], '#ffe2c0', 0.8, 520, { shadow: false });     // under the bridge (RL)
  m.light([0, -736, 180], '#ffd0a0', 1.0, 800, { shadow: false });     // south chamber (YA)
  m.light([0, 736, 180], '#a8d4ff', 1.0, 800, { shadow: false });      // north chamber (YA)
  m.light([-480, -592, 120], '#ffcf9a', 0.8, 600, { shadow: false });  // south run west
  m.light([480, 592, 120], '#9cc8ff', 0.8, 600, { shadow: false });    // north run east
  m.light([-400, 176, 140], '#ffcf9a', 0.9, 620, { shadow: false });   // west gallery
  m.light([400, -176, 140], '#9cc8ff', 0.9, 620, { shadow: false });   // east gallery

  // ---------------- nav nodes ----------------
  const padsA = [[-608, -360]], padsB = [[608, 360]];
  // lower floors
  navGrid(m, [-AX1, -AY], [-AX0, AY], L0, { avoid: padsA });
  navGrid(m, [AX0, -AY], [AX1, AY], L0, { avoid: padsB });
  navGrid(m, [-HUB, -HUB], [HUB, HUB], L0, { spacing: 144 });
  navGrid(m, [-AX0, 0], [-HUB, HUB], L0, { spacing: 112 });
  navGrid(m, [HUB, -HUB], [AX0, 0], L0, { spacing: 112 });
  for (const r of meta.rooms) if (/^(south|north)/.test(r.name)) navGrid(m, r.mins, r.maxs, L0, { spacing: 144, inset: 40 });
  // upper level: balconies, upper throats, bridge
  navGrid(m, [-AX1, AY - STRIP], [-AX0, AY], L1, { spacing: 144 });
  navGrid(m, [-AX0 - STRIP, -192], [-AX0, AY - STRIP], L1, { spacing: 112 });
  navGrid(m, [AX0, -AY], [AX1, -AY + STRIP], L1, { spacing: 144 });
  navGrid(m, [AX0, -AY + STRIP], [AX0 + STRIP, 192], L1, { spacing: 112 });
  navGrid(m, [-AX0, -96], [-HUB, 96], L1, { spacing: 112 });
  navGrid(m, [HUB, -96], [AX0, 96], L1, { spacing: 112 });
  navGrid(m, [-HUB, -96], [HUB, 96], L1, { spacing: 128 });
  // stairs (west): foot, every third step, top; the step under y is floor((y + 128) / 32), 16 units each
  for (const y of [-176, -80, 16, 112, 208, 304]) m.nav([-1088, y, Math.min(L1, Math.max(0, 16 * (Math.floor((y + 128) / 32) + 1))) + 24]);
  // ramp (east): on the 26.6-degree slope the player box rests on its uphill edge (15 units toward -y), so the
  // origin sits at rampZ(y - 15) + 24 where rampZ(y) = (128 - y) / 2
  const rampZ = (y) => Math.min(L1, Math.max(0, (128 - (y - 15)) / 2));
  for (const y of [176, 80, -16, -112, -208, -304]) m.nav([1088, y, rampZ(y) + 24]);
  // jump pad landings
  m.nav([-608, -96, L1 + 24]); m.nav([608, 96, L1 + 24]);
}
