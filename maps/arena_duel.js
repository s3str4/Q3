// Arena Duel: "Crossfire" - the competitive 1v1 map.
//
// Two atria (west = Red Armor, warm; east = Mega Health, cool) joined by four distinct routes:
//   1. the bridge (z 192): east strip -> upper throat -> over the hub -> upper throat -> west strip,
//   2. the hub floor (z 0) through the offset galleries (west door on the north half of the hub, east door on the
//      south half) around the central pier that carries the bridge,
//   3. the south loop (stub -> run -> plasma-gun chamber -> run -> stub), and
//   4. the north loop (its 180-degree twin, shotgun chamber).
// Each chamber also opens onto the hub through a short corridor, so a loop is a junction room one turn off the main
// RA -> hub -> MH cycle instead of a dead-end detour.
// Interior structure (each atrium; the chambers have a floor-to-ceiling column and a raised shelf):
//   - a 112-high MEZZANINE block beside the stairs / ramp (224 x 192), stepped onto from the fifth stair (z 96) or
//     the ramp, whose top is a third level between the floor and the balconies and whose south face walls off the
//     major-item pocket (RA / Mega on a 16-high plinth between the block, the pad and the outer wall),
//   - two floor-to-balcony COLUMNS under the inner strip: the corner column at the strip's outer end and the gallery
//     jamb pilaster, offset so the loop-door-to-loop-door lane under the strip is a 96-wide chicane instead of a
//     1500-unit corridor (tests/map.test.mjs asserts the LOS budget these give: <= 60% floor-to-floor eye LOS inside
//     an atrium, the major visible from <= 45% of its atrium's floor nodes, < 50% of the stub-to-stub pairs). The yellow armors sit in the gallery doors on that cycle (as
// on pro-q3dm6), so RA / YA / YA / MH timing all belong to whoever holds the hub. Each atrium has an L-shaped upper
// balcony reached by stairs (west) / a ramp (east) AND by a jump pad beside the major item.
//
// Sightline budget (asserted by tests/map.test.mjs): no spawn sees another spawn, the rail and lightning balconies
// do not see each other, and no two nav nodes are in line of sight over more than 1600 units. The geometry that
// guarantees it: the galleries are 128 high (so no line from an atrium floor can climb through them into the far
// upper throat, and the upper level only crosses the hub along the |y| <= 96 bridge line), the pier under the bridge
// (x +-128, y +-96) blocks every gallery-to-gallery and corridor-to-corridor line (see the proof in maps/README.md),
// the throat thresholds stop the stairs / ramp from seeing along the whole bridge, and the loop runs are offset by
// 96 so no lane runs a whole loop.
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
  // sightline budget checked by the tests (eye-to-eye, units)
  maxLane: 1600,
};

const L0 = 0, L1 = 192;       // floor levels
const SLAB = 32;               // balcony / bridge slab thickness (walk surface at L1, underside at L1 - SLAB)
// key dimensions (west side; the east side is the 180-degree rotation)
const AX0 = 512, AX1 = 1152;   // atrium inner / outer x (640 wide)
const AY = 448;                // atrium half length (896 long)
const HUB = 288;               // hub half size (576 square); galleries and throats run from HUB to AX0 (224 long)
const STRIP = 192;             // balcony strip width
const HALL = 160;              // hall height (loops, corridors)
const GALLERY = 128;           // gallery height: low enough that no line from the atrium floor can climb into the far upper throat
const PIER = [128, 96];        // half extents of the pier under the bridge
const DOOR = [-672, -512];     // x range of the west atrium's loop doors (the east doors are the mirror: 512..672)
const CH = 224;                // chamber half width (x), the loop runs end at +-CH
const COR = [-208, -48];       // x range of the south hub->chamber corridor (north corridor: 48..208)

export function build(m) {
  m.title = meta.title; m.author = meta.author;
  meta.rooms.length = 0; meta.corridorSamples.length = 0;
  m.ambient = { sky: '#06080f', fog: ['#06080f', 1800, 6500], hemi: ['#5f6f93', '#26180e', 0.4], sun: null, music: 'arena',
    // sky dome seen through the atria's and the hub's open ceilings (client/render/materials.js skyMaterial): a deep
    // violet night with a faint nebula band and stars, the gothic-arena sky
    skyDome: { zenith: '#101a44', horizon: '#3a2240', cloud: '#3c2a4c', stars: 1.0, clouds: 0.6, speed: 0.008 } };

  // ---------------- rooms (voids) ----------------
  const sh = new Shell(m, 32);
  const R = (name, mins, maxs, cls, mats) => { sh.room(name, mins, maxs, mats); meta.rooms.push({ name, mins, maxs, cls }); };
  // west side (warm, Red Armor) plus the whole south loop. Everything here is mirrored to the east with rot180.
  const west = [
    ['atriumA', [-AX1, -AY, L0], [-AX0, AY, 448], 'room', { wall: 'wall', floor: 'floor', ceil: 'sky' }],
    ['galleryA', [-AX0, 0, L0], [-HUB, HUB, GALLERY], 'hall', { wall: 'wall', floor: 'floor', ceil: 'ceiling' }],     // lower door to the hub, under the upper throat
    ['throatA_up', [-AX0, -96, L1], [-HUB, 96, 352], 'hall', { wall: 'wall', floor: 'floor2' }],                 // upper door: a closed corridor that becomes the bridge
    ['southStubA', [DOOR[0], -672, L0], [DOOR[1], -AY, HALL], 'hall', { wall: 'wall', floor: 'floor' }],         // overlaps the run (voids may overlap)
    ['southRunA', [DOOR[0], -672, L0], [-CH, -512, HALL], 'hall', { wall: 'wall', floor: 'floor' }],
    ['southChamber', [-CH, -960, L0], [CH, -512, 256], 'room', { wall: 'wall2', floor: 'floor', ceil: 'ceiling' }],
    ['southRunB', [CH, -928, L0], [-DOOR[0], -768, HALL], 'hall', { wall: 'wall2', floor: 'floor' }],           // 96 below run A: no lane along the whole loop
    ['southStubB', [-DOOR[1], -768, L0], [-DOOR[0], -AY, HALL], 'hall', { wall: 'wall2', floor: 'floor' }],
    ['southCorridor', [COR[0], -512, L0], [COR[1], -HUB, HALL], 'hall', { wall: 'wall2', floor: 'floor2' }],     // chamber -> hub (west of centre)
  ];
  // swap the trailing A/B letter and south->north: southRunA -> northRunB, southRunB -> northRunA, atriumA -> atriumB
  const eastName = (n) => n.replace(/([AB])(_|$)/, (s, l, t) => (l === 'A' ? 'B' : 'A') + t).replace(/^south/, 'north');
  // the east twins swap materials so the half of each loop nearest an atrium carries that atrium's wall style
  const eastMats = { atriumA: { wall: 'wall2', floor: 'floor', ceil: 'sky' }, galleryA: { wall: 'wall2', floor: 'floor', ceil: 'ceiling' }, throatA_up: { wall: 'wall2', floor: 'floor2' },
    southStubA: { wall: 'wall2', floor: 'floor' }, southRunA: { wall: 'wall2', floor: 'floor' }, southChamber: { wall: 'wall', floor: 'floor', ceil: 'ceiling' }, southRunB: { wall: 'wall', floor: 'floor' }, southStubB: { wall: 'wall', floor: 'floor' },
    southCorridor: { wall: 'wall', floor: 'floor2' } };
  for (const [name, mins, maxs, cls, mats] of west) {
    R(name, mins, maxs, cls, mats);
    const [rm, rx] = rot180(mins, maxs);
    R(eastName(name), rm, rx, cls, eastMats[name]);
  }
  R('hub', [-HUB, -HUB, L0], [HUB, HUB, 448], 'room', { wall: 'wall2', floor: 'floor', ceil: 'sky' });
  sh.build();
  m.rooms = meta.rooms.map((r) => ({ name: r.name, mins: r.mins, maxs: r.maxs, cls: r.cls })); // for the renderer's detail pass (cornices, lintels, beams...)

  // corridor width samples (point, narrow axis)
  meta.corridorSamples.push(
    { at: [-400, 144, 40], axis: 1 }, { at: [400, -144, 40], axis: 1 }, { at: [-400, -48, 232], axis: 1 }, { at: [400, 48, 232], axis: 1 },
    { at: [-592, -560, 40], axis: 0 }, { at: [592, 560, 40], axis: 0 }, { at: [-448, -592, 40], axis: 1 }, { at: [448, 592, 40], axis: 1 },
    { at: [448, -848, 40], axis: 1 }, { at: [-448, 848, 40], axis: 1 }, { at: [592, -608, 40], axis: 0 }, { at: [-592, 608, 40], axis: 0 },
    { at: [-128, -400, 40], axis: 0 }, { at: [128, 400, 40], axis: 0 },
    { at: [0, 0, 232], axis: 1 }, // the bridge
    { at: [-560, -160, 40], axis: 0 }, { at: [560, 160, 40], axis: 0 }, { at: [-656, -48, 40], axis: 0 }, { at: [656, 48, 40], axis: 0 }, // chicane under the strips
    { at: [-80, -736, 40], axis: 0 }, { at: [80, 736, 40], axis: 0 }, // chamber: shelf step to column
  );

  // ---------------- platforms, stairs, ramps, pads (solids inside the voids) ----------------
  // Atrium A: L-shaped balcony (north strip + east strip) as an overhanging slab; the lower floor runs underneath.
  m.box([-AX1, AY - STRIP, L1 - SLAB], [-AX0, AY, L1], 'floor2');            // north strip
  m.box([-AX0 - STRIP, -192, L1 - SLAB], [-AX0, AY - STRIP, L1], 'floor2');  // east strip (the bridge lands here)
  m.stairs(-AX1, -128, L0, 'y+', 12, 16, 32, 128, 'floor');                   // west wall stairs: 12 x 16 rise, 32 run -> z 192 at y 256
  m.box([-728, 232, L0], [-680, 280, L1 - SLAB], 'trim');                     // pillar at the balcony's inner corner
  // Pad targets sit 96 above the landing surface: the Q3 solve puts the flight apex at the target and launches from
  // the trigger top, so the player's box clears the balcony lip with ~40 units to spare and lands ~180 units further
  // on (at about (-570, 70), mid east strip). The pad sits beside Red Armor: grab, pad, bridge.
  m.jumppad([-800, -408, 4], [-704, -312, 40], [-640, -96, L1 + 96]);        // south pad -> east strip
  // Atrium B: point-symmetric twin, with a ramp instead of stairs.
  m.box([AX0, -AY, L1 - SLAB], [AX1, -AY + STRIP, L1], 'floor2');            // south strip
  m.box([AX0, -AY + STRIP, L1 - SLAB], [AX0 + STRIP, 192, L1], 'floor2');    // west strip
  m.ramp([AX1 - 128, -256, L0], [AX1, 128, L1], 'y-', 'floor');              // east wall ramp: z 0 at y 128 -> z 192 at y -256
  m.box([680, -280, L0], [728, -232, L1 - SLAB], 'trim');
  m.jumppad([704, 312, 4], [800, 408, 40], [640, 96, L1 + 96]);              // north pad -> west strip
  // Hub: the bridge slab on its central pier. The pier is what breaks the floor-level cross-map lanes: any line from
  // the west gallery mouth (x -288, y 0..288) to the east gallery mouth (x 288, y -288..0) passes |y| <= 80 somewhere
  // in x -128..128, and any line from the north corridor (y 288, x 48..208) to the south corridor passes |x| <= 80
  // at y 0. The rocket launcher sits in the pier's lee on the south side.
  m.box([-HUB, -96, L1 - SLAB], [HUB, 96, L1], 'floor2');
  m.box([-PIER[0], -PIER[1], L0], [PIER[0], PIER[1], L1 - SLAB], 'wall2');
  m.box([-PIER[0] - 8, -PIER[1] - 8, L0], [PIER[0] + 8, PIER[1] + 8, 16], 'trim');   // plinth
  m.box([-PIER[0] - 8, -PIER[1] - 8, L1 - SLAB - 16], [PIER[0] + 8, PIER[1] + 8, L1 - SLAB], 'trim');   // capital
  // Thresholds (16 high, a step) at the atrium mouth of each upper throat: a player halfway up the stairs / ramp
  // (eye ~178) would otherwise look through the throat along the whole bridge to the far strip (1700 units); the
  // line crosses the mouth at z ~200 and the doorstep catches it.
  m.box([-AX0, -96, L1], [-AX0 + 16, 96, L1 + 16], 'trim'); m.box([AX0 - 16, -96, L1], [AX0, 96, L1 + 16], 'trim');

  // ---------------- interior structure (west side; the east side is the 180-degree twin with swapped materials) -------
  // Every entry is [mins, maxs, westMat, eastMat]; rot180 places the twin.
  const MEZZ = 112;               // mezzanine block top: fifth stair (96) + one 16 step; the ramp passes 96 at y -64
  // a banded column: trim plinth (0..16), body, a flush glow collar at strip height (112..120, so the faces no light
  // reaches still read), body, trim capital (top 16). Flush segments: no collision change, no z-fighting.
  const column = ([x0, y0], [x1, y1], top, wm, em, wg, eg) => [
    [[x0, y0, L0], [x1, y1, 16], 'trim', 'trim'], [[x0, y0, 16], [x1, y1, 112], wm, em], [[x0, y0, 112], [x1, y1, 120], wg, eg],
    [[x0, y0, 120], [x1, y1, top - 16], wm, em], [[x0, y0, top - 16], [x1, y1, top], 'trim', 'trim']];
  const interior = [
    // mezzanine block beside the stairs: x -1024..-800 (flush with the stairs' east edge), y -128..64
    [[-1024, -128, L0], [-800, 64, 16], 'trim', 'trim'],                     // plinth band
    [[-1024, -128, 16], [-800, 64, MEZZ - 24], 'wall2', 'wall'],             // body
    [[-1024, -128, MEZZ - 24], [-800, 64, MEZZ - 16], 'glow_warm', 'glow_cool'],  // flush glow band under the cap
    [[-1024, -128, MEZZ - 16], [-800, 64, MEZZ], 'trim', 'trim'],            // cap (walk surface)
    // major-item plinth (16 high, a step): RA / Mega rest on it, 96 south of the block face
    [[-1008, -272, L0], [-912, -176, 16], 'trim', 'trim'],
    // corner column under the inner strip's outer end (x -704..-616, y -192..-128) and the gallery-jamb pilaster
    // (x -608..-512, y -96..0): banded floor-to-balcony piers that overlap by 8 in x, so the lane under the strip is
    // a chicane of two 104 / 192 wide passages instead of a straight 1500-unit corridor
    ...column([-704, -192], [-616, -128], L1 - SLAB, 'wall2', 'wall', 'glow_warm', 'glow_cool'),
    ...column([-608, -96], [-512, 0], L1 - SLAB, 'wall2', 'wall', 'glow_warm', 'glow_cool'),
  ];
  for (const [mins, maxs, wm, em] of interior) { m.box(mins, maxs, wm); const [rm, rx] = rot180(mins, maxs); m.box(rm, rx, em); }
  // chambers: a floor-to-ceiling banded column east of centre (breaks the run-door-to-run-door line) and a 32-high shelf
  // along the far wall with a 32-wide 16 step in front (health bubbles on the shelf; the shelf's open north edge is
  // a 32 ledge, a jump); south chamber, then its twin
  const chamber = [
    ...column([0, -768], [64, -704], 256, 'wall', 'wall2', 'glow_green', 'glow_green'),
    [[-CH, -960, L0], [-136, -704, 32], 'floor2', 'floor2'], [[-136, -960, L0], [-104, -704, 16], 'trim', 'trim'],
  ];
  for (const [mins, maxs, wm, em] of chamber) { m.box(mins, maxs, wm); const [rm, rx] = rot180(mins, maxs); m.box(rm, rx, em); }

  // ---------------- readability: emissive zone strips and door trims ----------------
  // 4-unit-thick strips flush against the walls at z 112..120 (below eye level), split around doors, stairs and
  // the major-item markers so no two strips overlap. Warm in the west, cool in the east, green in the hub.
  const strip = (mins, maxs, mat) => m.box(mins, maxs, mat);
  for (const [y0, y1] of [[-AY, -288], [-160, -128], [256, AY]]) strip([-AX1, y0, 112], [-AX1 + 4, y1, 120], 'glow_warm'); // A west wall (skips marker + stairs)
  strip([-AX1, -AY, 112], [DOOR[0], -AY + 4, 120], 'glow_warm'); strip([-AX1, AY - 4, 112], [DOOR[0], AY, 120], 'glow_warm'); // A south/north walls (stop at the doors)
  for (const [y0, y1] of [[-AY, -256], [128, 160], [288, AY]]) strip([AX1 - 4, y0, 112], [AX1, y1, 120], 'glow_cool'); // B east wall (skips ramp + marker)
  strip([-DOOR[0], -AY, 112], [AX1, -AY + 4, 120], 'glow_cool'); strip([-DOOR[0], AY - 4, 112], [AX1, AY, 120], 'glow_cool');
  // hub north/south walls (split around the corridor doors)
  strip([-HUB, -HUB, 112], [COR[0], -HUB + 4, 120], 'glow_green'); strip([COR[1], -HUB, 112], [HUB, -HUB + 4, 120], 'glow_green');
  strip([-HUB, HUB - 4, 112], [-COR[1], HUB, 120], 'glow_green'); strip([-COR[0], HUB - 4, 112], [HUB, HUB, 120], 'glow_green');
  // gallery walls: the atrium's colour continues into its gallery
  strip([-AX0, HUB - 4, 112], [-HUB, HUB, 120], 'glow_warm'); strip([HUB, -HUB, 112], [AX0, -HUB + 4, 120], 'glow_cool');
  // corridors: green (they belong to the hub)
  strip([COR[0], -512, 112], [COR[0] + 4, -HUB, 120], 'glow_green'); strip([-COR[0] - 4, HUB, 112], [-COR[0], 512, 120], 'glow_green');
  // balcony lips (underside front edge) so the upper level reads from below
  strip([-AX1, AY - STRIP - 4, L1 - SLAB - 6], [-AX0, AY - STRIP, L1 - SLAB], 'glow_warm');
  strip([-AX0 - STRIP, -192, L1 - SLAB - 6], [-AX0 - STRIP + 4, AY - STRIP - 4, L1 - SLAB], 'glow_warm');
  strip([AX0, -AY + STRIP, L1 - SLAB - 6], [AX1, -AY + STRIP + 4, L1 - SLAB], 'glow_cool');
  strip([AX0 + STRIP - 4, -AY + STRIP + 4, L1 - SLAB - 6], [AX0 + STRIP, 192, L1 - SLAB], 'glow_cool');
  // bridge edges and pier: neutral green (the hub belongs to nobody)
  strip([-HUB, 96, L1 - 8], [HUB, 100, L1], 'glow_green'); strip([-HUB, -100, L1 - 8], [HUB, -96, L1], 'glow_green');
  strip([-PIER[0] - 4, -PIER[1] - 4, 112], [PIER[0] + 4, -PIER[1], 120], 'glow_green'); strip([-PIER[0] - 4, PIER[1], 112], [PIER[0] + 4, PIER[1] + 4, 120], 'glow_green');
  // sloped strips that climb with the stairs (west wall, y -128 -> 256) and the ramp (east wall, y 128 -> -256):
  // the band between two parallel slanted planes z = 112 + rise(y) and z = 120 + rise(y), rise = 16 per 32 of run
  const sloped = (x0, x1, y0, y1, sign, mat) => {
    const l = Math.sqrt(1.25);  // |[0, 0.5, 1]|: brushFromPlanes normalises n, so d is pre-divided to match
    m.planes([{ n: [1, 0, 0], d: x1 }, { n: [-1, 0, 0], d: -x0 }, { n: [0, 1, 0], d: y1 }, { n: [0, -1, 0], d: -y0 },
      { n: [0, sign * 0.5 / l, 1 / l], d: (120 + 64) / l }, { n: [0, -sign * 0.5 / l, -1 / l], d: -(112 + 64) / l }], mat);
  };
  sloped(-AX1, -AX1 + 4, -128, 256, -1, 'glow_warm');  // z = 112 + (y + 128) / 2 over the stairs
  sloped(AX1 - 4, AX1, -256, 128, 1, 'glow_cool');     // z = 112 + (128 - y) / 2 over the ramp
  // major item markers: a tall red bar on the wall beside Red Armor, a tall cool bar beside Mega
  strip([-AX1, -288, 40], [-AX1 + 4, -160, 200], 'glow_red');
  strip([AX1 - 4, 160, 40], [AX1, 288, 200], 'glow_cool');
  // corridor strips along the loops: warm on the west halves, cool on the east halves
  strip([DOOR[0], -672, 112], [-CH, -668, 120], 'glow_warm'); strip([CH, -772, 112], [-DOOR[0], -768, 120], 'glow_cool');
  strip([CH, 668, 112], [-DOOR[0], 672, 120], 'glow_cool'); strip([DOOR[0], 768, 112], [-CH, 772, 120], 'glow_warm');
  // door lintels (trim) just inside the loop doors and the corridor doors
  m.box([DOOR[0], -AY - 8, 152], [DOOR[1], -AY, 160], 'trim'); m.box([-DOOR[1], AY, 152], [-DOOR[0], AY + 8, 160], 'trim');
  m.box([DOOR[0], AY, 152], [DOOR[1], AY + 8, 160], 'trim'); m.box([-DOOR[1], -AY - 8, 152], [-DOOR[0], -AY, 160], 'trim');
  m.box([COR[0], -HUB - 8, 152], [COR[1], -HUB, 160], 'trim'); m.box([-COR[1], HUB, 152], [-COR[0], HUB + 8, 160], 'trim');

  // ---------------- items ----------------
  const I = (type, x, y, floorZ) => m.item(type, [x, y, floorZ + 20], { floorZ });
  // majors: Red Armor west lower, Mega east lower, Rail on the west balcony, LG on the east balcony, RL in the hub
  I('armorRed', -960, -224, 16);          // on its plinth in the pocket between the mezzanine block, the stairs foot and the pad; the marker bar is on the wall beside it
  I('mega', 960, 224, 16);
  I('weaponRail', -960, 352, L1);
  I('weaponLightning', 960, -352, L1);
  I('weaponRocket', 0, -192, L0);         // hub, in the lee of the pier (south side, by the corridor door)
  // Yellow armors on the main line, in the gallery doors (568 from their atrium's major): whoever runs the
  // RA -> hub -> MH cycle passes both, and each is contestable from the hub floor and from the atrium.
  I('armorYellow', -400, 144, L0);        // west gallery
  I('armorYellow', 400, -144, L0);        // east gallery
  // the loop chambers hold the secondary weapons at their corridor mouths (on the loop-spawn -> hub line), so each
  // loop has a reason after a spawn and the chamber is worth a look from the hub
  I('weaponPlasma', -128, -560, L0);      // south chamber, corridor mouth
  I('weaponShotgun', 128, 560, L0);       // north chamber, corridor mouth
  I('health25', -576, 352, L0);           // west, under the north strip by the north door
  I('health25', 576, -352, L0);           // east, under the south strip by the south door
  I('health25', 0, 0, L1);                // mid-bridge, on top of the pier
  I('health25', 0, 192, L0);              // hub, in the pier's lee (north side, opposite the RL)
  for (const y of [-64, 0, 64]) I('health5', -608, y, L1);   // west east-strip bubbles (pad landing lane)
  for (const y of [-64, 0, 64]) I('health5', 608, y, L1);    // east west-strip bubbles
  for (const y of [-464, -400, -336]) I('health5', -128, y, L0);  // south corridor
  for (const y of [336, 400, 464]) I('health5', 128, y, L0);      // north corridor
  for (const y of [-896, -832, -768]) I('health5', -180, y, 32);   // south chamber shelf
  for (const y of [896, 832, 768]) I('health5', 180, y, 32);       // north chamber shelf
  for (const x of [-1104, -1056, -1008]) I('armorShard', x, 352, L0);  // under the west north-strip (dead-end reward)
  for (const x of [1104, 1056, 1008]) I('armorShard', x, -352, L0);    // under the east south-strip
  // ammo along the transit routes
  I('ammoRockets', 200, 200, L0); I('ammoRockets', -448, -592, L0);
  I('ammoSlugs', -704, 384, L1); I('ammoSlugs', 448, 592, L0);
  I('ammoCells', 704, -384, L1); I('ammoCells', -448, 848, L0);
  I('ammoShells', -1088, -320, L0); I('ammoShells', 448, -848, L0);
  I('ammoPlasma', -400, 0, L1); I('ammoPlasma', 400, 0, L1);
  I('ammoBullets', -912, -32, 112); I('ammoBullets', 912, 32, 112);   // on the mezzanine tops

  // ---------------- spawns (6): no spawn sees another spawn or both majors; loop spawns see neither ----------------
  m.spawn([-1088, 352, L1 + 24], 0);    // west balcony, west end, looking east along the strip (at the rail gun)
  m.spawn([-880, 400, L0 + 24], -90);   // west lower, under the north strip
  m.spawn([1088, -352, L1 + 24], 180);  // east balcony, east end, looking west along the strip (at the lightning gun)
  m.spawn([880, -400, L0 + 24], 90);    // east lower, under the south strip
  m.spawn([-320, -592, L0 + 24], 180);  // south loop, run A
  m.spawn([320, 592, L0 + 24], 0);      // north loop, run B

  // ---------------- lights (14 max; the first 4 cast shadows) ----------------
  // Keys hang 300 above the atrium floors (clear of a jumping player on the balconies at 192 + 56 + 45) so the floors
  // get real irradiance; the major-item spots sit low (140) so the metallic floor plates pick up their highlight.
  // Fills are unshadowed, so one fill per hall lights it through its walls' worth of distance.
  m.light([-832, 0, 300], '#ffc88a', 1.6, 1400);                      // west key (warm)   [shadow]
  m.light([832, 0, 300], '#8ec4ff', 1.6, 1400);                       // east key (cool)   [shadow]
  m.light([0, 0, 380], '#f4f1ea', 1.4, 1100);                         // hub key           [shadow]
  m.light([-1056, -184, 140], '#ff8a5a', 1.2, 700);                   // Red Armor spot, off the block's SW corner so it washes the block's south face and the stair slot   [shadow]
  m.light([1056, 184, 140], '#7ad0ff', 1.2, 700, { shadow: false });   // Mega spot, off the block's NE corner (north face + ramp side)
  m.light([-720, 280, 110], '#ffd9a8', 1.0, 820, { shadow: false });   // under the west north strip + west gallery
  m.light([720, -280, 110], '#a8d8ff', 1.0, 820, { shadow: false });   // under the east south strip + east gallery
  m.light([0, -192, 120], '#ffe2c0', 0.8, 560, { shadow: false });     // RL nook under the bridge + south corridor door
  // chamber lights sit on the column's far diagonal (SE / NW): the faces toward the run-A door and the corridor are
  // lit by the run-A and hub fills, the faces toward the run-B door by this one
  m.light([128, -864, 200], '#ffd0a0', 1.0, 800, { shadow: false });   // south chamber (PG, shelf, column) + run B's near end
  m.light([-128, 864, 200], '#a8d4ff', 1.0, 800, { shadow: false });   // north chamber (SG)
  m.light([-448, -592, 120], '#ffcf9a', 0.8, 600, { shadow: false });  // south run A
  m.light([448, 592, 120], '#9cc8ff', 0.8, 600, { shadow: false });    // north run B
  m.light([448, -848, 120], '#9cc8ff', 0.8, 600, { shadow: false });   // south run B
  m.light([-448, 848, 120], '#ffcf9a', 0.8, 600, { shadow: false });   // north run A

  // ---------------- nav nodes ----------------
  const padsA = [[-752, -360]], padsB = [[752, 360]];
  // lower floors
  navGrid(m, [-AX1, -AY], [-AX0, AY], L0, { avoid: padsA });
  navGrid(m, [AX0, -AY], [AX1, AY], L0, { avoid: padsB });
  navGrid(m, [-HUB, -HUB], [HUB, HUB], L0, { spacing: 144 });
  navGrid(m, [-AX0, 0], [-HUB, HUB], L0, { spacing: 112 });
  navGrid(m, [HUB, -HUB], [AX0, 0], L0, { spacing: 112 });
  for (const r of meta.rooms) if (/^(south|north)/.test(r.name)) navGrid(m, r.mins, r.maxs, L0, { spacing: /Corridor/.test(r.name) ? 112 : 144, inset: 40 });
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
  // mezzanine tops (entered from the fifth stair / the ramp at z 96), plus a node on that stair and on the ramp
  navGrid(m, [-1024, -128], [-800, 64], MEZZ, { spacing: 112, inset: 40 });
  navGrid(m, [800, -64], [1024, 128], MEZZ, { spacing: 112, inset: 40 });
  m.nav([-1088, 48, 96 + 24]); m.nav([1088, -48, rampZ(-48) + 24]);
  // chicane under the inner strips: east of the corner column, then west of the jamb pilaster
  m.nav([-560, -160, L0 + 24]); m.nav([-656, -48, L0 + 24]); m.nav([560, 160, L0 + 24]); m.nav([656, 48, L0 + 24]);
  // chamber shelves
  navGrid(m, [-CH, -960], [-136, -704], 32, { spacing: 144, inset: 40 });
  navGrid(m, [136, 704], [CH, 960], 32, { spacing: 144, inset: 40 });
  // a node on every item spot (unless the grid already put one within 32) so every pickup is a path goal
  for (const it of m.items) {
    const o = [it.origin[0], it.origin[1], it.floorZ + 24];
    if (!m.navNodes.some((n) => Math.hypot(n.origin[0] - o[0], n.origin[1] - o[1], n.origin[2] - o[2]) < 32)) m.nav(o);
  }
}
