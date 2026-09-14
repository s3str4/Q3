// Lava Spire: the second competitive 1v1 map. A vertical crater built around a cross-shaped lava pit with a stone
// spire in its middle; four walk levels stacked around it:
//   floor  z 0 (west half) / 64 (east half; two 4-step stairs north and south of the pit join the halves),
//   mid    z 160: the south-west mezzanine + west gallery (overhanging slabs), the solid east terrace, the vault,
//   upper  z 256: the north deck (overhanging), the bridge over the north lava arm,
//   spire  z 320: the 384-square platform on the spire (Red Armor), four steps up from the bridge.
// The pit is a plus of lava arms (320 wide: no gap jump crosses one; the west one is a slot under the platform, with
// the pad bay in front of it) around the spire column, with a 416-tall
// stone tower in each concave corner (they stand on the pit floor, cut every corner-to-corner floor lane, and are
// higher than any walk level plus a jump, so nothing can hop between them). The pit floor is solid at -96 with the
// lava 40 deep on it; the four arm ends carry 48 parapets and the bridge / platform 48 rails, so the lava is entered
// by knockback (rocket fights on the rims, the bridge and the spire top), never by a strafe or a misjudged drop.
// Routes (walking, no trick jumps), one big loop: west floor -> stairs -> east floor -> SE ramp -> terrace -> vault
// -> vault stairs -> deck -> bridge -> spire steps -> Red Armor; and deck -> NW stairs -> gallery -> mezzanine / the
// tower's upper door -> tower mezzanine (Mega Health) -> tower stairs -> tower floor -> lower door -> west floor.
// Jump pads shortcut it: west bay -> spire top (over the west arm), south strip -> SW mezzanine, terrace -> deck.
// Asserted by tests/map_lava_spire.test.mjs: corridors >= 96 (128 preferred), halls >= 128 / rooms >= 192 high,
// stairs 16 x 32, majors >= 512 apart, no spawn sees both majors, no nav edge crosses lava, the RA <-> Mega path
// changes level twice or more, at most 12% of the walkable nav nodes within 96 of lava.
import { Shell, subtractBox } from './shell.js';
import { pointContents } from '../shared/trace.js';
import { PM } from '../shared/constants.js';
import { BRUSH_FLAGS } from '../shared/map.js';

export const meta = {
  title: 'Lava Spire', author: 'builder-map',
  rooms: [],              // { name, mins, maxs, cls: 'room' | 'hall', axis? } (axis: travel axis of a doorway)
  corridorSamples: [],    // { at, axis } width samples across `axis`
  levels: { lower: 0, mid: 160, upper: 256, spire: 320 },
  pads: [],               // { at: [x, y], landZ: [min, max] } expected landing floor for the physical pad test
  lavaBoxes: [],          // lava trigger boxes (also on map.triggers)
  maxLane: 1800,
};

const F0 = 0, FE = 64, L1 = 160, L2 = 256, L3 = 320;   // floor west / floor east / mid / upper / spire top
const PIT = -96;                           // pit floor
const LAVA_TOP = PIT + 40;
const CR = 576;                            // crater half size (1152 square)
const SP = 96;                             // spire column half size
const ARM = 160;                           // lava arm half width (320: wider than any gap jump)
const ARML = 288;                          // arm outer end (the west arm is a slot under the platform, ending at -ARM)
const PIL = [128, 352];                    // corner towers span 128..352 in |x| and |y| (32 into the arms: their corners sit deep in the lava, so no floor lane grazes one)
const TOWER_TOP = 416;                     // corner tower height: above the spire platform (320) plus a jump-and-step (63.6)
const RAIL = 32, CLIP = 72;                // visible rail height (waist high: the eye at 50 looks down over it) / invisible player-clip height above the takeoff floor
const CH = 64;                             // bridge / stair strip half width (128 wide)
const SLAB = 32;

export function build(m) {
  m.title = meta.title; m.author = meta.author;
  meta.rooms.length = 0; meta.corridorSamples.length = 0; meta.pads.length = 0; meta.lavaBoxes.length = 0;
  m.ambient = { sky: '#090302', fog: ['#160804', 1600, 6000], hemi: ['#a06a48', '#2a0c04', 0.22], sun: null, music: 'arena',
    skyDome: { zenith: '#180608', horizon: '#4a1a0c', cloud: '#52240f', stars: 0.35, clouds: 0.9, speed: 0.02 } }; // smoke-lit volcanic sky over the crater

  // ---------------- rooms (voids) ----------------
  const sh = new Shell(m, 32);
  const R = (name, mins, maxs, cls, mats, axis) => { sh.room(name, mins, maxs, mats); meta.rooms.push({ name, mins, maxs, cls, axis }); };
  R('crater', [-CR, -CR, PIT], [CR, CR, 704], 'room', { wall: 'wall', floor: 'stone', ceil: 'sky' });
  R('towerLowerDoor', [-640, -128, F0], [-CR, 128, 128], 'hall', { wall: 'wall', floor: 'floor', ceil: 'trim' }, 0);
  R('towerUpperDoor', [-640, -128, L1], [-CR, 128, 320], 'hall', { wall: 'wall', floor: 'floor2', ceil: 'trim' }, 0);
  R('tower', [-1152, -320, F0], [-640, 320, 400], 'room', { wall: 'stone', floor: 'floor', ceil: 'ceiling' });
  R('vaultDoor', [CR, -128, L1], [640, 128, 352], 'hall', { wall: 'wall2', floor: 'floor2', ceil: 'trim' }, 0);
  R('deckDoor', [CR, 384, L2], [640, 576, 448], 'hall', { wall: 'wall2', floor: 'floor2', ceil: 'trim' }, 0);
  R('vault', [640, -256, L1], [1152, 576, 480], 'room', { wall: 'wall2', floor: 'floor', ceil: 'ceiling' });
  sh.build();
  m.rooms = meta.rooms.map((r) => ({ name: r.name, mins: r.mins, maxs: r.maxs, cls: r.cls })); // for the renderer's detail pass

  // ---------------- the pit: a plus of lava arms around the spire, pillars in the concave corners ----------------
  // lava region = ({|x| < ARM, |y| < ARML} U {-ARM < x < ARML, |y| < ARM}) minus the spire column: five disjoint boxes.
  // The west arm stops at x -160, under the spire platform's overhang: the west bay in front of it is the pad's
  // launch floor, and a pad flight that falls short (air control) lands in the bay, not in lava.
  const lavaRegion = [
    [[-ARM, SP], [ARM, ARML]], [[-ARM, -ARML], [ARM, -SP]],           // north / south arms (incl. the inner corners)
    [[ARM, -ARM], [ARML, ARM]], [[SP, -SP], [ARM, SP]],               // east arm, and its inner part beside the spire
    [[-ARM, -SP], [-SP, SP]],                                         // west slot (under the platform)
  ];
  for (const [a, b] of lavaRegion) { m.lava([a[0], a[1], PIT], [b[0], b[1], LAVA_TOP]); meta.lavaBoxes.push({ mins: [a[0], a[1], PIT], maxs: [b[0], b[1], LAVA_TOP] }); }
  // floor slabs (from the pit floor up to the walk level) are the crater halves minus the two lava-arm rectangles
  const cut = (box, mat) => {
    let pieces = [box];
    for (const [a, b] of [[[-ARM, -ARML], [ARM, ARML]], [[-ARM, -ARM], [ARML, ARM]]]) pieces = pieces.flatMap((p) => subtractBox(p, { mins: [a[0], a[1], PIT - 1], maxs: [b[0], b[1], 512] }));
    for (const p of pieces) m.box(p.mins, p.maxs, mat);
  };
  cut({ mins: [-CR, -CR, PIT], maxs: [-CH, CR, F0] }, 'floor');       // west half at 0 (up to the stair strips)
  cut({ mins: [CH, -CR, PIT], maxs: [CR, CR, FE] }, 'floor');         // east half at 64
  // stair strips (x -64..64) between the arm ends and the walls: a 0-level base, 4 x 16 stairs rising east at
  // y 400..528 / -528..-400
  for (const s of [1, -1]) {
    const y0 = s > 0 ? ARML : -CR, y1 = s > 0 ? CR : -ARML;
    m.box([-CH, y0, PIT], [CH, y1, F0], 'floor');
    m.stairs(-CH, s > 0 ? 400 : -528, F0, 'x+', 4, 16, 32, 128, 'floor');
  }
  // parapets (48 high, red trim) across the four arm ends - the only floor edges that face lava (the arm sides are
  // the tower faces). 48 is above a jump (45.6) and above the 44-unit hop the bot graph allows, so the lava is entered
  // by knockback only: the pit is a hazard around which the fight happens, not a pit you slide into while strafing.
  // The north / south ends face both floor levels (the stair strip at 0 beside the 64 east floor): 48 above the higher
  // one, i.e. a 112 wall from the strip. The bays are single-level: 48 above the bay floor.
  // Every rail carries an invisible player clip to CLIP (72) above its floor: a jump (45.6) plus the 18-unit step that
  // still applies on the way down climbs a 63-unit ledge, so the visible 32 rail is only a marker (and blocks the bot
  // graph's 18-unit steps); the clip is what keeps players out of the lava. Weapons fire through the clip.
  const rail = (mins, maxs, floorZ, clipTop = floorZ + CLIP) => { m.box([mins[0], mins[1], floorZ], [maxs[0], maxs[1], floorZ + RAIL], 'trim_red'); m.clip([mins[0], mins[1], floorZ + RAIL], [maxs[0], maxs[1], clipTop]); };
  for (const s of [1, -1]) {
    const y0 = s > 0 ? ARML : -ARML - 16, y1 = s > 0 ? ARML + 16 : -ARML;
    // north / south arm ends: a 48 rail at each floor level, clipped to 72 above the 64 east floor on both sides (a
    // strafe jump from the east floor reaches over the strip's rail otherwise)
    rail([-PIL[0], y0], [CH, y1], F0, FE + CLIP); rail([CH, y0], [PIL[0], y1], FE);
  }
  rail([ARML, -PIL[0]], [ARML + 16, PIL[0]], FE);                                       // east arm end (east bay, 64)
  rail([-ARM - 16, -PIL[0]], [-ARM, PIL[0]], F0);                                       // west slot end (west bay, 0; under the platform's overhang)
  // spire: column from the pit floor to 288, a 384-square platform on top (walk surface 320; its corners are braced
  // into the four towers) with a 48 rail (+ clip) round its rim, open only at the steps: the platform is left by the
  // steps (or by knockback), the west-bay pad lands in its middle, and neither a player nor the bot graph walks off it
  // into the lava (with a mere curb the graph's gap scan could graze a tower corner from up here and accept a walk off).
  const PLAT = 192;
  m.box([-SP, -SP, PIT], [SP, SP, L3 - SLAB], 'wall2');
  m.box([-PLAT, -PLAT, L3 - SLAB], [PLAT, PLAT, L3], 'floor2');
  m.box([-PLAT, -PLAT, L3 - SLAB - 8], [PLAT, PLAT, L3 - SLAB], 'glow_red');   // flush glow band under the platform lip
  for (const [a, b] of [[[-PLAT, -PLAT], [PLAT, -PLAT + 16]], [[-PLAT, PLAT - 16], [-CH - 8, PLAT]], [[CH + 8, PLAT - 16], [PLAT, PLAT]], [[-PLAT, -PLAT + 16], [-PLAT + 16, PLAT - 16]], [[PLAT - 16, -PLAT + 16], [PLAT, PLAT - 16]]]) rail(a, b, L3);
  // corner towers on the pit floor (they straddle the rim by 64 and reach 32 into the arms): stone, banded, 384 tall -
  // higher than the spire platform plus a jump, so no walk level can get onto them and no hop between them crosses an arm
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const x0 = Math.min(sx * PIL[0], sx * PIL[1]), x1 = Math.max(sx * PIL[0], sx * PIL[1]), y0 = Math.min(sy * PIL[0], sy * PIL[1]), y1 = Math.max(sy * PIL[0], sy * PIL[1]);
    m.box([x0, y0, PIT], [x1, y1, 104], 'stone');
    m.box([x0, y0, 104], [x1, y1, 112], 'glow_red');
    m.box([x0, y0, 112], [x1, y1, 240], 'stone');
    m.box([x0, y0, 240], [x1, y1, 248], 'glow_red');
    m.box([x0, y0, 248], [x1, y1, TOWER_TOP - 16], 'stone');
    m.box([x0, y0, TOWER_TOP - 16], [x1, y1, TOWER_TOP], 'trim');
  }

  // ---------------- mid level (160): SW mezzanine + west gallery (overhanging), east terrace (solid) + ramp ----------------
  m.box([-CR, -CR, L1 - SLAB], [-192, -384, L1], 'floor2');          // SW mezzanine
  m.box([-CR, -384, L1 - SLAB], [-384, 192, L1], 'floor2');          // west gallery (lands the tower's upper door)
  m.stairs(-CR, 192, L1, 'y+', 6, 16, 32, 128, 'floor');             // NW stairs: gallery -> deck (z 160 -> 256 at y 384)
  m.box([-448, 192, L1 - SLAB], [-384, 384, L1], 'floor2');          // gallery strip beside the NW stairs (so the stair foot is 192 wide)
  m.box([384, -384, FE], [CR, 384, L1], 'wall');                     // east terrace (solid block from the east floor)
  m.box([384, -384, 104], [CR, 384, 112], 'trim_warm');               // flush band on the terrace face
  m.ramp([192, -CR, FE], [384, -448, L1], 'x+', 'floor');            // SE ramp: z 64 at x 192 -> 160 at x 384, 26.6 degrees
  m.box([192, -448, FE], [384, -440, FE + 16], 'trim');               // low curb along the ramp's open (north) side foot - a step
  // ---------------- upper level (256): north deck (overhanging), bridge over the north arm, steps up to the spire ----------------
  m.box([-CR, 384, L2 - SLAB], [CR, CR, L2], 'floor2');              // north deck
  m.box([-CH, 320, L2 - SLAB], [CH, 384, L2], 'floor2');             // bridge (deck edge to the spire steps)
  m.stairs(-CH, 320, L2, 'y-', 4, 16, 32, 128, 'floor');             // spire steps: z 256 at y 320 -> 320 at y 192 (the platform edge)
  m.box([-CH, 192, L2 - SLAB], [CH, 320, L2], 'floor2');             // slab under the steps (so the bridge reads as one span)
  // bridge rails: 48 above the bridge, then a wedge that climbs with the steps (the same 26.6-degree slope), clip 24 more
  const CLIPX = { flags: BRUSH_FLAGS.PLAYERCLIP | BRUSH_FLAGS.NODRAW };
  for (const [x0, x1] of [[-CH - 8, -CH], [CH, CH + 8]]) {
    m.box([x0, 192, L2], [x1, 384, L2 + RAIL], 'trim_red'); m.clip([x0, 320, L2 + RAIL], [x1, 384, L2 + CLIP]);
    m.ramp([x0, 192, L2 + RAIL], [x1, 320, L3 + RAIL], 'y-', 'trim_red');
    m.ramp([x0, 192, L2 + CLIP], [x1, 320, L3 + CLIP], 'y-', 'clip', CLIPX); m.box([x0, 192, L2 + RAIL], [x1, 320, L2 + CLIP], 'clip', CLIPX);
  }
  // rails on the edges that overlook a lava bay: the deck's south edge (open at the NW stairs and the bridge), the
  // gallery's east edge and the terrace's west edge - a player running off any of them would fly over the bay parapet
  rail([-448, 384], [-CH - 8, 392], L2); rail([CH + 8, 384], [CR, 392], L2);
  rail([-392, -384], [-384, 384], L1);
  rail([384, -384], [392, 384], L1);
  m.box([-CR, 384 - 4, L2 - SLAB - 6], [CR, 384, L2 - SLAB], 'glow_red');   // deck lip (lit from below so the level reads)
  m.box([-384, 192 - 4, L1 - SLAB - 6], [-192, 192, L1 - SLAB], 'glow_warm'); // gallery lip (east edge where it faces the floor)
  m.box([-384 - 4, -384, L1 - SLAB - 6], [-384, 192, L1 - SLAB], 'glow_warm');
  m.box([-192 - 4, -CR, L1 - SLAB - 6], [-192, -384, L1 - SLAB], 'glow_warm'); // mezzanine lip
  // columns under the overhangs (cover on the floor, and the slabs read as carried): banded trim / stone
  const column = ([x0, y0], [x1, y1], z0, top, mat) => { m.box([x0, y0, z0], [x1, y1, z0 + 16], 'trim'); m.box([x0, y0, z0 + 16], [x1, y1, top - 16], mat); m.box([x0, y0, top - 16], [x1, y1, top], 'trim'); };
  column([-232, -424], [-192, -384], F0, L1 - SLAB, 'stone');        // mezzanine outer corner
  column([-424, 152], [-384, 192], F0, L1 - SLAB, 'stone');          // gallery north-east corner
  column([-424, -424], [-384, -384], F0, L1 - SLAB, 'stone');        // gallery / mezzanine inner corner
  column([-ARM - 40, 384], [-ARM, 424], F0, L2 - SLAB, 'stone');     // deck: west of the north stair strip (on the 0 floor)
  column([ARM, 384], [ARM + 40, 424], FE, L2 - SLAB, 'stone');       // deck: east of the strip (on the 64 floor)
  // ---------------- west tower (Mega Health): stairs along the west wall up to an L-shaped mezzanine at 160 ----------------
  m.stairs(-1152, -256, F0, 'y+', 10, 16, 32, 128, 'floor');          // z 0 at y -256 -> 160 at y 64
  m.box([-1152, 64, L1 - SLAB], [-640, 320, L1], 'floor2');           // north strip of the tower mezzanine
  m.box([-768, -128, L1 - SLAB], [-640, 64, L1], 'floor2');           // east strip to the upper door
  m.box([-1152, 64 - 4, L1 - SLAB - 6], [-768, 64, L1 - SLAB], 'glow_warm');   // mezzanine lips
  m.box([-768 - 4, -128, L1 - SLAB - 6], [-768, 64, L1 - SLAB], 'glow_warm');
  column([-808, 24], [-768, 64], F0, L1 - SLAB, 'stone');            // under the mezzanine's inner corner
  m.box([-1000, -180, F0], [-904, -84, 16], 'trim');                 // plinth in the tower's open floor (Yellow Armor)
  m.box([-1064, 164, L1], [-968, 260, L1 + 16], 'trim');             // Mega plinth on the mezzanine's north strip
  // ---------------- east vault (Lightning Gun): lower part at 160, stairs to the upper part at 256 (deck door) ----------------
  m.box([640, 288, L1], [1152, 576, L2], 'wall2');                    // upper part (solid, walk surface 256)
  m.box([640, 288 - 4, L2 - 8], [1152, 288, L2], 'trim_warm');        // its edge band
  m.stairs(1024, 96, L1, 'y+', 6, 16, 32, 128, 'floor');              // 160 -> 256 at y 288
  m.box([840, -60, L1], [920, 20, L1 + 16], 'trim');                  // LG plinth
  // jamb pillars on the terrace flanking the vault door (y -128..-40 and 40..128): a mid-level line from the tower's
  // upper door into the vault door has to pass the door's middle 80 units and so crosses the spire column (|y| < 96)
  column([448, -128], [512, -40], L1, 352, 'wall2'); column([448, 40], [512, 128], L1, 352, 'wall2');
  column([760, -256], [824, -192], L1, 480, 'wall');                  // a floor-to-ceiling pier in the vault's south-west (breaks the door -> stairs line)

  // ---------------- readability: emissive strips (red = crater / spire, warm = tower, warm trim = vault) ----------------
  const strip = (mins, maxs, mat) => m.box(mins, maxs, mat);
  strip([-CR, -CR, 112], [-CR + 4, -128, 120], 'glow_red'); strip([-CR, 128, 112], [-CR + 4, CR, 120], 'glow_red'); // west wall (skips the lower door)
  strip([-CR, -CR, 112], [192, -CR + 4, 120], 'glow_red');            // south wall up to the ramp
  strip([-CR, CR - 4, 112], [CR, CR, 120], 'glow_red');               // north wall
  strip([CR - 4, 384, 112], [CR, CR, 120], 'glow_red');               // east wall north of the terrace
  strip([CR - 4, -CR, 112], [CR, -384, 120], 'glow_red');             // east wall south of the terrace
  strip([-1152, -320, 112], [-1152 + 4, -256, 120], 'glow_warm'); strip([-1152, 64, 240], [-1152 + 4, 320, 248], 'glow_warm');
  strip([-1152, 320 - 4, 240], [-640, 320, 248], 'glow_warm'); strip([-1152, -320, 112], [-640, -320 + 4, 120], 'glow_warm');
  strip([-640 - 4, -320, 112], [-640, -128, 120], 'glow_warm'); strip([-640 - 4, 128, 240], [-640, 320, 248], 'glow_warm');
  strip([1152 - 4, -256, 272], [1152, 96, 280], 'glow_warm'); strip([640, -256, 272], [640 + 4, 288, 280], 'glow_warm');
  strip([640, -256, 272], [1152, -256 + 4, 280], 'glow_warm'); strip([640, 576 - 4, 368], [1152, 576, 376], 'glow_warm');
  // major markers: a tall red bar beside Mega (tower north wall) and red bars on the spire column's four faces
  strip([-1064, 320 - 4, 184], [-968, 320, 344], 'glow_red');
  for (const [a, b] of [[[-SP - 4, -24], [-SP, 24]], [[SP, -24], [SP + 4, 24]], [[-24, -SP - 4], [24, -SP]], [[-24, SP], [24, SP + 4]]]) strip([a[0], a[1], F0 + 16], [b[0], b[1], L3 - SLAB - 8], 'glow_red');
  // door lintels (the lower tower door is exactly 128 high: no lintel there)
  m.box([-640, -128, 312], [-CR, 128, 320], 'trim_warm');
  m.box([CR, -128, 344], [640, 128, 352], 'trim_warm'); m.box([CR, 384, 440], [640, 576, 448], 'trim_warm');

  // ---------------- jump pads ----------------
  m.jumppad([-378, -48, F0 + 4], [-282, 48, F0 + 40], [-120, 0, L3 + 240]); meta.pads.push({ at: [-330, 0], landZ: [L3, L3] });       // west bay -> spire top (a high arc: the box has to clear the platform rail 123 units out)
  m.jumppad([-176, -468, F0 + 4], [-80, -372, F0 + 40], [-260, -430, L1 + 176]); meta.pads.push({ at: [-128, -420], landZ: [L1, L1] }); // south strip (by the SW pillar) -> SW mezzanine: a steep, short arc so the box is above the slab (160) before it reaches the slab's east edge (x -192)
  m.jumppad([432, 240, L1 + 4], [528, 336, L1 + 40], [480, 420, L2 + 176]); meta.pads.push({ at: [480, 288], landZ: [L2, L2] });       // terrace -> deck (over the deck's south rail and its clip)

  // ---------------- corridor samples ----------------
  meta.corridorSamples.push(
    { at: [-608, 0, 40], axis: 1 }, { at: [-608, 0, 200], axis: 1 },                 // tower doors
    { at: [608, 0, 200], axis: 1 }, { at: [608, 480, 300], axis: 1 },                // vault doors
    { at: [0, 350, 300], axis: 0 }, { at: [0, 250, 340], axis: 0 },                  // bridge, spire steps
    { at: [-480, -100, 200], axis: 0 }, { at: [-400, -480, 200], axis: 1 },          // gallery, mezzanine
    { at: [0, 480, 300], axis: 1 }, { at: [480, 0, 200], axis: 0 },                  // deck, terrace (between the door pillars)
    { at: [-700, 200, 200], axis: 1 }, { at: [-700, -60, 200], axis: 0 },            // tower mezzanine strips
    { at: [-1088, -128, 130], axis: 0 }, { at: [-512, 300, 250], axis: 0 },          // tower stairs, NW stairs
    { at: [1088, 200, 250], axis: 0 }, { at: [288, -512, 140], axis: 1 },            // vault stairs, SE ramp
    { at: [0, 464, 60], axis: 1 }, { at: [0, -464, 60], axis: 1 },                   // floor stairs
    { at: [-460, 300, 40], axis: 0 }, { at: [200, -450, 100], axis: 1 },             // west floor band, east south strip
  );

  // ---------------- items ----------------
  const I = (type, x, y, floorZ) => m.item(type, [x, y, floorZ + 20], { floorZ });
  I('armorRed', 0, 0, L3);                // spire top
  I('mega', -1016, 212, L1 + 16);         // tower mezzanine, north strip, on its plinth (the red bar on the wall marks it)
  I('weaponRail', -400, 480, L2);         // deck, west end
  I('weaponLightning', 880, -20, L1 + 16); // vault lower part, on its plinth
  I('weaponRocket', -300, -470, F0);      // under the SW mezzanine's east end (a pocket off the south strip)
  I('armorYellow', 480, -200, L1);        // terrace, south half
  I('armorYellow', -952, -132, 16);       // tower floor plinth (under the Mega holder's feet)
  I('weaponPlasma', 200, 470, FE);        // north strip east of the stairs, under the deck
  I('weaponShotgun', -480, -100, L1);     // gallery
  I('health25', -400, -480, L1);          // SW mezzanine (pad landing)
  I('health25', 900, 440, L2);            // vault upper part
  I('health25', 120, -420, FE);           // east south strip, between the stairs top and the ramp
  for (const y of [340, 372, 404]) I('health5', 0, y, L2);           // bridge mouth, on the way to the spire steps
  for (const x of [-1000, -940, -880]) I('health5', x, 280, L1);      // tower mezzanine north strip
  for (const y of [420, 470, 520]) I('health5', -500, y, F0);         // west floor under the deck's west end
  for (const y of [40, 90, 140]) I('armorShard', 416, y, L1);         // terrace, north half (towards the pad)
  for (const x of [-980, -930, -880]) I('armorShard', x, -290, F0);   // tower floor, along the south wall by the stairs foot
  I('ammoRockets', 300, 470, FE); I('ammoRockets', -200, 470, F0);
  I('ammoSlugs', 300, 480, L2); I('ammoSlugs', 1000, 100, L1);
  I('ammoCells', 720, -180, L1); I('ammoCells', 440, -300, L1);
  I('ammoShells', -720, -260, F0); I('ammoShells', -300, 470, F0);
  I('ammoPlasma', -480, 100, L1); I('ammoPlasma', -100, 480, L2);
  I('ammoBullets', -700, -60, L1); I('ammoBullets', -300, -500, L1);

  // ---------------- spawns (6) ----------------
  m.spawn([-720, -240, F0 + 24], 135);    // tower floor, south-east corner (sees Mega, not the spire)
  m.spawn([-700, 250, L1 + 24], 180);     // tower mezzanine, north strip east end (looks along the strip at Mega)
  m.spawn([-480, 500, L2 + 24], 0);       // deck, west end (Rail)
  m.spawn([900, 100, L1 + 24], 180);      // vault lower part
  m.spawn([300, -400, FE + 24], 180);     // east floor, south strip by the ramp foot
  m.spawn([-480, -240, F0 + 24], 90);     // west floor under the gallery

  // ---------------- lights (14; the first 4 cast shadows) ----------------
  m.light([0, 0, 560], '#ffb27a', 1.6, 1400);                        // crater key above the spire   [shadow]
  m.light([-896, -40, 320], '#ffb878', 1.4, 1100);                    // tower key                   [shadow]
  m.light([896, 120, 400], '#ffc890', 1.3, 1000);                     // vault key                   [shadow]
  m.light([0, 470, 400], '#ffcfa0', 1.2, 1000);                       // deck                        [shadow]
  for (const [x, y] of [[0, 200], [0, -200], [220, 0], [-130, 0]]) m.light([x, y, 24], '#ff6a2a', 1.3, 560, { shadow: false }); // lava glow in each arm / the west slot
  m.light([-480, -60, 100], '#ffb98a', 1.0, 760, { shadow: false });  // under the gallery + lower tower door
  m.light([-400, -480, 300], '#ffc9a0', 1.0, 760, { shadow: false }); // SW mezzanine
  m.light([0, 470, 150], '#ffc0a0', 0.9, 700, { shadow: false });     // under the deck (stair strip, PG)
  m.light([-1016, 212, 290], '#ff9a6a', 1.0, 620, { shadow: false }); // Mega on the tower mezzanine
  m.light([480, -450, 300], '#ffd0a8', 0.9, 700, { shadow: false });  // ramp + terrace south end
  m.light([900, -150, 300], '#ffdcb8', 0.9, 700, { shadow: false });  // vault lower part

  // ---------------- nav nodes ----------------
  const pads = meta.pads.map((p) => p.at);
  const G = (mins, maxs, z, o = {}) => grid(m, mins, maxs, z, { lava: meta.lavaBoxes, avoid: pads, ...o });
  // floor west (0): band west of the pillars, north / south strips, the west bay
  G([-CR, -PIL[1]], [-PIL[1], PIL[1]], F0, { spacing: 112 });
  G([-PIL[1], PIL[1]], [-CH, CR], F0, { spacing: 112 });
  G([-PIL[1], -CR], [-CH, -PIL[1]], F0, { spacing: 112 });
  G([-CR, -ARM], [-ARM, ARM], F0, { spacing: 96, inset: 36 });
  // floor east (64): strips north / south of the pillars, the east bay, and the 0-level landings at the arm ends
  G([CH, PIL[1]], [384, CR], FE, { spacing: 112 });
  G([CH, -CR], [384, -PIL[1]], FE, { spacing: 112 });
  G([ARML, -ARM], [384, ARM], FE, { spacing: 96, inset: 30 });
  m.nav([0, 368, F0 + 24]); m.nav([0, -368, F0 + 24]);
  // floor stairs (0 -> 64 rising east at y 400..528 / -528..-400): foot, mid, top
  for (const y of [464, -500]) { m.nav([-96, y, F0 + 24]); m.nav([-16, y, 32 + 24]); m.nav([96, y, FE + 24]); }
  // mid level
  G([-CR, -CR], [-192, -384], L1, { spacing: 112 });                  // SW mezzanine
  G([-CR, -384], [-384, 192], L1, { spacing: 112 });                  // gallery
  G([384, -384], [CR, 384], L1, { spacing: 96, inset: 36 });          // terrace (the grid skips the door pillars)
  for (const x of [232, 288, 344]) m.nav([x, -512, FE + (x + 15 - 192) / 2 + 24]); // SE ramp (26.6 degrees: the box rests on its uphill edge, x + 15; z = 64 + (x - 192)/2)
  m.nav([160, -512, FE + 24]);                                        // ramp foot
  // NW stairs (160 -> 256 at y 192..384): foot, mid, top
  m.nav([-512, 176, L1 + 24]); m.nav([-512, 256, L1 + 48 + 24]); m.nav([-512, 336, L1 + 80 + 24]); m.nav([-512, 400, L2 + 24]);
  // upper level: deck, bridge, spire steps (z 256 at y 288 -> 320 at y 160), spire top
  G([-CR, 384], [CR, CR], L2, { spacing: 112 });
  m.nav([0, 350, L2 + 24]);
  m.nav([0, 272, L2 + 32 + 24]); m.nav([0, 208, L3 + 24]);
  G([-PLAT, -PLAT], [PLAT, PLAT], L3, { spacing: 96, inset: 40 });
  // tower
  G([-1152, -320], [-640, 320], F0, { spacing: 112, inset: 40 });     // tower floor (the grid skips the stairs)
  for (const y of [-290, -176, -80, 16, 88]) m.nav([-1088, y, Math.min(L1, Math.max(0, 16 * (Math.floor((y + 256) / 32) + 1))) + 24]); // tower stairs (foot, steps, top)
  G([-1152, 64], [-640, 320], L1, { spacing: 112 });                  // tower mezzanine north strip
  G([-768, -128], [-640, 64], L1, { spacing: 96, inset: 30 });        // east strip
  m.nav([-608, 0, F0 + 24]); m.nav([-608, 0, L1 + 24]);               // tower doors
  // vault
  G([640, -256], [1152, 288], L1, { spacing: 112 });                  // lower part (skips the stairs / pier)
  for (const y of [80, 176, 272]) m.nav([1088, y, Math.min(L2, Math.max(L1, L1 + 16 * (Math.floor((y - 96) / 32) + 1))) + 24]); // vault stairs
  G([640, 288], [1152, 576], L2, { spacing: 112 });                   // upper part
  m.nav([608, 0, L1 + 24]); m.nav([608, 480, L2 + 24]);               // vault doors
  // a node on every item spot (unless the grid already put one within 32)
  for (const it of m.items) {
    const o = [it.origin[0], it.origin[1], it.floorZ + 24];
    if (!m.navNodes.some((n) => Math.hypot(n.origin[0] - o[0], n.origin[1] - o[1], n.origin[2] - o[2]) < 32)) m.nav(o);
  }
}

// Nav grid over an XY rectangle at floor `z`: nodes are skipped inside solid, near a pad centre, wherever the player
// box plus `margin` would overlap a lava box in XY (so no node sits on a lava rim), and where the floor under the
// spot is not `z` (a hole, the pit, or the open air beside an overhang).
function grid(m, mins, maxs, z, { spacing = 128, inset = 40, lava = [], margin = 64, avoid = [], avoidRadius = 80 } = {}) {
  const world = { brushes: m.brushes };
  const x0 = mins[0] + inset, x1 = maxs[0] - inset, y0 = mins[1] + inset, y1 = maxs[1] - inset;
  const nx = Math.max(1, Math.ceil((x1 - x0) / spacing)), ny = Math.max(1, Math.ceil((y1 - y0) / spacing));
  let placed = 0;
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) {
    const x = x0 + (x1 - x0) * i / nx, y = y0 + (y1 - y0) * j / ny;
    if (avoid.some((a) => Math.hypot(a[0] - x, a[1] - y) < avoidRadius)) continue;
    const r = 15 + margin;
    if (lava.some((b) => x + r > b.mins[0] && x - r < b.maxs[0] && y + r > b.mins[1] && y - r < b.maxs[1])) continue;
    if (pointContents(world, [x, y, z + 26], PM.mins, PM.maxs)) continue;
    if (!pointContents(world, [x, y, z - 2])) continue;               // must stand on this floor, not float over a hole
    m.nav([x, y, z + 24]); placed++;
  }
  return placed;
}
