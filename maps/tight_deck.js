// Tight Deck: a compact, fast, multi-level tech deck in the spirit of Aerowalk (hub3aeroq3).
//
// One outer loop of small rooms joined by short L-shaped stair halls (every hall turns, so no straight eye-height
// line runs longer than 768), a central core crossed by an overhanging gallery, a teleporter that shortcuts the loop
// from the bottom of the map (Mega pit, SW, z 0) to the north junction under the RA deck (z 128, lightning gun), and a jump pad in the core
// that throws the player up onto the gallery (z 192).
//
//   levels: 0 (Mega pit, core floor) / 48 (south corridor, SE room) / 96 (west + east mid rooms) / 128 (north
//   junction, LG) / 144 (stair landing) / 192 (RA deck, core gallery, north corridors) / 224 (NE deck, YA)
//
//   loop (clockwise): Mega pit (0) -> L stairs -> west mid, rail (96) -> L link, stairs down -> core (0)
//                     core -> L link, stairs up -> east mid, slugs (96) -> bay + 8 stairs -> NE deck, YA (224)
//                     NE deck -> 2 steps down -> 4 steps down into the junction (128, column, LG) -> 4 steps up
//                     -> RA deck (192) -> L stairs down -> west mid (96) -> L stairs down -> Mega pit (0)
//   plus the south corridor (Mega pit -> Z-shaped run climbing 3 steps to 48 -> SE room, shotgun -> chicane + 3 steps
//   -> east mid), the core's south door onto that corridor, the core gallery (pad up from the core floor / 4 steps
//   down into the junction) and the teleporter (Mega pit south wall -> north junction).
import { Shell, navGrid } from './shell.js';

export const meta = {
  title: 'Tight Deck', author: 'builder-map',
  rooms: [],              // { name, mins, maxs, cls } for the clearance test (cls: 'room' >= 192 high, 'hall' >= 128)
  corridorSamples: [],    // { at, axis } width samples across the narrow axis
  levels: { lower: 0, upper: 192 },
  maxLane: 1100,          // eye-to-eye nav-node lane budget (the tight map: shorter than Crossfire's 1600)
  maxFree: 768,           // longest horizontal eye-height free segment from any nav node
};

// ---- levels ----
const Z0 = 0, ZS = 48, Z1 = 96, ZJ = 128, ZL = 144, Z2 = 192, Z3 = 224;

export function build(m) {
  m.title = meta.title; m.author = meta.author;
  meta.rooms.length = 0; meta.corridorSamples.length = 0;
  m.ambient = { sky: '#05070d', fog: ['#05070d', 1200, 5200], hemi: ['#5c7aa8', '#1c1a18', 0.24], sun: null, music: 'arena' };

  const sh = new Shell(m, 32);
  const R = (name, mins, maxs, cls, mats) => { sh.room(name, mins, maxs, mats); meta.rooms.push({ name, mins, maxs, cls }); };
  const D = (name, mins, maxs, mats) => sh.room(name, mins, maxs, mats);   // a doorway through a wall (not a room for the width test)
  const HALL = { wall: 'wall2', floor: 'floor2', ceil: 'ceiling' };
  const STAIR = { wall: 'wall2', floor: 'floor', ceil: 'ceiling' };

  // ---------------- rooms (voids) ----------------
  // SW: the Mega pit (lowest room) and the L stairs up to the west mid room
  R('megaPit', [-800, -800, Z0], [-352, -352, 224], 'room', { wall: 'metal', floor: 'floor2', ceil: 'ceiling' });
  R('wsA', [-800, -352, Z0], [-672, -192, 224], 'hall', STAIR);          // north leg: 3 steps to 48
  R('wsB', [-800, -192, ZS], [-480, -96, 304], 'hall', STAIR);           // east leg: 3 steps to 96, landing along the rest
  D('wsD', [-608, -96, Z1], [-512, -64, 256], HALL);                     // doorway from the landing's east end up into west mid
  // W: west mid room (rail gun) and the L link down into the core
  R('westMid', [-800, -64, Z1], [-480, 352, 320], 'room', { wall: 'wall2', floor: 'floor', ceil: 'ceiling' });
  R('wlA', [-480, 224, Z1], [-384, 320, 224], 'hall', HALL);             // east leg (flat, 96)
  R('wlB', [-384, 16, Z0], [-288, 336, 256], 'hall', STAIR);             // south leg: 6 steps down to the core floor
  D('wlC', [-288, 16, Z0], [-256, 112, 176], HALL);                      // doorway into the core
  // NW: L stairs up to the RA deck, the deck and the RA pocket
  R('wsC1', [-800, 352, Z1], [-672, 480, 352], 'hall', STAIR);           // north leg: 3 steps to 144, 32 landing
  R('wsC2', [-800, 480, ZL], [-544, 576, 400], 'hall', STAIR);           // east leg: corner square, 3 steps to 192, 32 landing
  R('raDeck', [-544, 384, Z2], [-352, 800, 416], 'room', { wall: 'wall', floor: 'floor', ceil: 'ceiling' });
  R('raPocket', [-800, 608, Z2], [-544, 800, 416], 'room', { wall: 'wall', floor: 'floor', ceil: 'ceiling' });   // the RA room proper
  // N: 4 steps down from the RA deck into the junction (column), 4 steps up on the east leg, the turn up to the deck
  R('nA', [-352, 608, ZJ], [-224, 704, 320], 'hall', STAIR);
  R('nJ', [-224, 448, ZJ], [96, 800, 336], 'hall', HALL);                // junction 320 x 352 with a 112 x 224 column
  R('nC', [96, 480, ZJ], [352, 576, 320], 'hall', STAIR);
  R('nT1', [224, 576, Z2], [352, 672, 352], 'hall', STAIR);              // 2 steps up to 224
  R('nT2', [224, 672, Z3], [384, 800, 352], 'hall', STAIR);
  // NE: the upper deck (yellow armor)
  R('neDeck', [384, 480, Z3], [800, 800, 448], 'room', { wall: 'wall2', floor: 'floor2', ceil: 'ceiling' });
  // E: 8 stairs down from the NE deck, the bay into east mid, east mid (slugs) and the L link down into the core
  R('esA', [672, 224, Z1], [800, 480, 384], 'hall', STAIR);              // south leg: 8 steps (224 -> 96)
  R('esB', [544, 96, Z1], [800, 224, 320], 'hall', STAIR);               // west leg: flat, health
  D('esD', [544, 64, Z1], [640, 96, 256], HALL);                         // doorway down into east mid (a baffle wall inside makes it a chicane)
  R('eastMid', [480, -320, Z1], [800, 64, 320], 'room', { wall: 'metal', floor: 'floor', ceil: 'ceiling' });
  R('elA', [384, -320, Z1], [480, -224, 224], 'hall', HALL);             // west leg (flat, 96)
  R('elB', [288, -336, Z0], [384, -16, 256], 'hall', STAIR);             // north leg: 6 steps down to the core floor
  D('elC', [256, -112, Z0], [288, -16, 176], HALL);                      // doorway into the core
  // centre: the core (rocket launcher, jump pad, overhanging gallery) and the gallery's corridor north to the junction
  R('core', [-256, -256, Z0], [256, 256, 384], 'room', { wall: 'metal', floor: 'floor2', ceil: 'ceiling' });
  R('nLink', [-128, 256, ZJ], [-32, 448, 336], 'hall', STAIR);           // 4 steps down from the gallery to the junction
  // S: the core's south door, the corridor from the Mega pit (Z-shaped, climbing 48) to the SE room
  R('coreS', [-192, -352, Z0], [-96, -256, 176], 'hall', HALL);
  R('sA', [-352, -464, Z0], [-96, -352, 176], 'hall', HALL);
  R('sB', [-320, -544, Z0], [-224, -448, 208], 'hall', STAIR);           // 3 steps south to 48
  R('sC', [-320, -640, ZS], [160, -544, 208], 'hall', HALL);
  R('sD', [64, -800, ZS], [160, -544, 208], 'hall', HALL);
  R('sE', [64, -800, ZS], [352, -704, 208], 'hall', HALL);
  // SE: the shotgun room, with a chicane wall in front of its door up to east mid (3 steps)
  R('seRoom', [352, -800, ZS], [800, -352, 272], 'room', { wall: 'concrete', floor: 'floor', ceil: 'ceiling' });
  D('seDoor', [672, -352, Z1], [800, -320, 256], HALL);                  // the doorway through the wall into east mid
  sh.build();

  // ---------------- stairs, landings, platforms ----------------
  // (each L stair hall: steps along its first leg, a solid landing at the top height for the rest of the leg)
  m.stairs(-800, -352, Z0, 'y+', 3, 16, 32, 128); m.box([-800, -256, Z0], [-672, -192, ZS], 'floor');          // wsA
  m.stairs(-800, -192, ZS, 'x+', 3, 16, 32, 128); m.box([-704, -192, ZS], [-480, -96, Z1], 'floor');           // wsB
  m.stairs(-384, 64, Z0, 'y+', 6, 16, 32, 96); m.box([-384, 256, Z0], [-288, 336, Z1], 'floor');              // wlB (down into the core)
  m.stairs(-800, 352, Z1, 'y+', 3, 16, 32, 128); m.box([-800, 448, Z1], [-672, 480, ZL], 'floor');            // wsC1
  m.stairs(-672, 480, ZL, 'x+', 3, 16, 32, 96); m.box([-576, 480, ZL], [-544, 576, Z2], 'floor');             // wsC2 (after the corner square)
  m.stairs(-224, 608, ZJ, 'x-', 4, 16, 32, 96);                                                                // nA: up west to the RA deck
  m.stairs(96, 480, ZJ, 'x+', 4, 16, 32, 96); m.box([224, 480, ZJ], [352, 576, Z2], 'floor');                 // nC: up east
  m.stairs(224, 576, Z2, 'y+', 2, 16, 32, 128); m.box([224, 640, Z2], [352, 672, Z3], 'floor');               // nT1: 2 steps to 224
  m.stairs(-128, 384, ZJ, 'y-', 4, 16, 32, 96);                                                                // nLink: down north from the gallery
  m.stairs(672, 224, Z1, 'y+', 8, 16, 32, 128);                                                                // esA (8 steps, 96 -> 224)
  m.stairs(288, -64, Z0, 'y-', 6, 16, 32, 96); m.box([288, -336, Z0], [384, -256, Z1], 'floor');              // elB (down into the core)
  m.stairs(-320, -448, Z0, 'y-', 3, 16, 32, 96);                                                                // sB (3 steps south to 48)
  m.stairs(672, -448, ZS, 'y+', 3, 16, 32, 128); m.box([672, -352, ZS], [800, -320, Z1], 'floor');            // seRoom NE: 3 steps up to the door
  // seRoom chicane: a baffle wall jutting from the east wall, 64 south of the stairs' foot
  m.box([576, -576, ZS], [800, -512, 272], 'concrete');
  // east mid chicane: a baffle wall just inside the esD doorway (the NE deck cannot look down the stairs
  // and the bay into the room); the way round is east of it
  m.box([480, -16, Z1], [640, 16, 320], 'metal');
  // banded columns: junction (floor to ceiling), east mid, the core's centre pillar
  const column = ([x0, y0], [x1, y1], z0, top, mat, glow) => {
    m.box([x0, y0, z0], [x1, y1, z0 + 16], 'trim'); m.box([x0, y0, z0 + 16], [x1, y1, z0 + 112], mat); m.box([x0, y0, z0 + 112], [x1, y1, z0 + 120], glow);
    m.box([x0, y0, z0 + 120], [x1, y1, top - 16], mat); m.box([x0, y0, top - 16], [x1, y1, top], 'trim');
  };
  column([-128, 512], [-16, 736], ZJ, 336, 'wall2', 'glow_cool');
  // west mid column: on the diagonal from the NW stair corner through the wsD doorway (no 777-unit line), and cover
  column([-688, 176], [-608, 224], Z1, 320, 'wall2', 'glow_cool');
  column([-32, -48], [32, 56], Z0, 384, 'metal', 'glow_green');
  // core: the overhanging gallery (z 192, floor at 0 runs underneath) and the 2-step podium around the pillar
  m.box([-128, -64, Z2 - 32], [128, 256, Z2], 'floor2');
  m.box([-96, -96, Z0], [96, 96, 16], 'trim'); m.box([-64, -64, 16], [64, 64, 32], 'trim');
  // jump pad on the core floor, SW, launching north onto the gallery (target 96 above the landing so the box clears
  // the gallery lip; the Q3 solve puts the apex at the target); the flight passes west of the pillar
  m.jumppad([-224, -256, 4], [-128, -160, 40], [-96, 40, Z2 + 96]);
  // Mega pit: the mega plinth (SW corner pocket) and a 40-high crate for cover mid-room
  m.box([-784, -784, Z0], [-688, -688, 16], 'trim');
  m.box([-624, -576, Z0], [-528, -480, 40], 'tech');
  // RA pocket plinth; SE room crate
  m.box([-784, 720, Z2], [-688, 784, Z2 + 16], 'trim');
  m.box([448, -640, ZS], [544, -544, ZS + 40], 'tech');
  // teleporter: Mega pit south wall -> the north junction's NE nook, facing west at the column and the RA-deck stairs
  // (the loop shortcut: bottom of the map to the top approach of the RA in one step; the bots' Mega -> RA route uses it)
  m.teleporter([-560, -800, Z0], [-464, -768, 104], [56, 768, ZJ + 24], 180);

  // ---------------- readability: glow strips (z floor+128..136, flush on walls) ----------------
  // (not at floor+112: the shell wall faces of a 224-high room span floor-32..ceiling+32, so their centre is exactly
  // floor+112, and world.js culls a face whose centre and corners are all inside solid - a strip through the centre
  // of a wall whose corners sit in the neighbouring slabs would delete the whole wall face)
  const strip = (mins, maxs, mat) => m.box(mins, maxs, mat);
  strip([-800, -800, 128], [-796, -560, 136], 'glow_cool'); strip([-800, -800, 128], [-580, -796, 136], 'glow_cool');   // mega pit W + S walls
  strip([-800, -752, 40], [-796, -720, 200], 'glow_cool');                                                              // mega marker bar (32 wide, behind the plinth)
  strip([-800, 608, Z2 + 128], [-796, 800, Z2 + 136], 'glow_warm'); strip([-752, 796, Z2 + 40], [-720, 800, Z2 + 200], 'glow_red');  // RA room + red bar (32 wide, behind the plinth)
  strip([-544, 384, Z2 + 128], [-540, 480, Z2 + 136], 'glow_warm'); strip([-356, 384, Z2 + 128], [-352, 600, Z2 + 136], 'glow_warm'); // RA deck side walls
  strip([-800, -64, Z1 + 128], [-796, 352, Z1 + 136], 'glow_cool');                                                     // west mid west wall
  strip([796, 480, Z3 + 128], [800, 800, Z3 + 136], 'glow_cool');                                                       // NE deck east wall
  strip([-256, 112, 128], [-252, 256, 136], 'glow_green'); strip([252, -256, 128], [256, -112, 136], 'glow_green');     // core west wall (north of the door), east wall (south of the door)
  strip([-128, -68, Z2 - 8], [128, -64, Z2], 'glow_green');                                                             // gallery lip
  strip([480, -224, Z1 + 128], [484, 64, Z1 + 136], 'glow_cool'); strip([796, -320, Z1 + 128], [800, 64, Z1 + 136], 'glow_cool'); // east mid
  strip([352, -704, ZS + 128], [356, -352, ZS + 136], 'glow_warm');                                                     // se room west wall (warm accent)
  strip([-320, -640, ZS + 128], [160, -636, ZS + 136], 'glow_cool');                                                    // south corridor

  // ---------------- corridor width samples ----------------
  meta.corridorSamples.push(
    { at: [-736, -300, 40], axis: 0 }, { at: [-600, -144, 136], axis: 1 }, { at: [-560, -80, 136], axis: 0 }, { at: [-432, 272, 136], axis: 1 },
    { at: [-336, 300, 136], axis: 0 }, { at: [-336, 100, 60], axis: 0 }, { at: [-736, 400, 160], axis: 0 }, { at: [-736, 528, 168], axis: 1 },
    { at: [-624, 528, 200], axis: 1 }, { at: [-300, 656, 200], axis: 1 }, { at: [-176, 640, 168], axis: 0 }, { at: [32, 640, 168], axis: 0 },
    { at: [300, 528, 232], axis: 1 }, { at: [288, 720, 264], axis: 0 }, { at: [736, 300, 200], axis: 0 }, { at: [600, 160, 136], axis: 1 },
    { at: [592, 80, 136], axis: 0 }, { at: [720, 0, 136], axis: 0 }, { at: [432, -272, 136], axis: 1 }, { at: [336, -300, 136], axis: 0 },
    { at: [-80, 420, 168], axis: 0 }, { at: [-144, -304, 40], axis: 0 }, { at: [-200, -408, 40], axis: 1 }, { at: [-272, -500, 60], axis: 0 },
    { at: [-96, -592, 88], axis: 1 }, { at: [112, -720, 88], axis: 0 }, { at: [256, -752, 88], axis: 1 }, { at: [736, -336, 136], axis: 0 },
    { at: [464, -540, 88], axis: 0 }, { at: [-272, 64, 40], axis: 1 }, { at: [272, -64, 40], axis: 1 },
  );

  // ---------------- items ----------------
  const I = (type, x, y, floorZ) => m.item(type, [x, y, floorZ + 20], { floorZ });
  I('mega', -736, -736, 16);            // Mega pit SW pocket, on its plinth (z 0 level)
  I('armorRed', -736, 752, Z2 + 16);    // RA pocket, on its plinth (z 192 level)
  I('weaponRail', -576, 32, Z1);        // west mid, centre-south
  I('weaponLightning', 40, 640, ZJ);    // north junction, east lane (the contested hub: teleporter exit, RA stairs, gallery stairs)
  I('weaponRocket', 0, -80, 16);        // core podium (lower step, south of the pillar)
  I('armorYellow', 592, 560, Z3);       // NE deck (the loop's high corner)
  I('armorYellow', 0, 160, Z2);         // core gallery (the pad's reward)
  I('weaponShotgun', 592, -736, ZS);    // SE room
  I('weaponPlasma', -96, -592, ZS);     // south corridor middle leg
  I('health25', -448, 640, Z2);         // RA deck, by the junction stairs door
  I('health25', -624, -128, Z1);        // west stairs landing (Mega pit -> west mid)
  I('health25', 672, 144, Z1);          // east bay under the stairs
  for (const y of [400, 424, 448]) I('health5', -80, y, ZJ);            // junction stairs foot (nLink)
  for (const x of [128, 192, 256]) I('health5', x, -752, ZS);           // south corridor east leg
  for (const x of [-448, -416, -384]) I('health5', x - 16, 272, Z1);    // west link
  for (const y of [544, 608, 672]) I('armorShard', 736, y, Z3);         // NE deck east wall
  for (const x of [-608, -560, -512]) I('armorShard', x, -400, Z0);     // Mega pit north wall
  I('ammoRockets', 160, -208, Z0); I('ammoRockets', 416, -400, ZS);
  I('ammoSlugs', -736, 48, Z1); I('ammoSlugs', 736, -256, Z1);
  I('ammoCells', 736, 512, Z3); I('ammoCells', -208, 208, Z0);
  I('ammoShells', 560, -400, ZS); I('ammoShells', -736, -224, ZS);
  I('ammoPlasma', -224, -592, ZS); I('ammoPlasma', 528, -96, Z1);
  I('ammoBullets', -400, 400, Z2); I('ammoBullets', 432, -272, Z1);

  // ---------------- spawns (6) ----------------
  m.spawn([-560, 32, Z1 + 24], 180);    // west mid, east side, facing west (rail)
  m.spawn([736, -736, ZS + 24], 90);    // SE room SE corner, facing north
  m.spawn([432, 520, Z3 + 24], 0);      // NE deck SW, facing east
  m.spawn([208, -208, Z0 + 24], 135);   // core SE corner, facing the podium
  m.spawn([-400, 400, Z2 + 24], 90);    // RA deck SE, facing north along the deck
  m.spawn([-272, -592, ZS + 24], 0);    // south corridor, facing east

  // ---------------- lights (14 max; the first 4 cast shadows) ----------------
  // Keys sit clear of the pillar / column (a light inside a solid lights nothing). Shadows on the four rooms with
  // interior structure (core pillar + gallery, Mega pit crate + stairs, RA room plinth, west mid column).
  m.light([0, 128, 330], '#cfe0ff', 1.6, 1100);                        // core key over the gallery (the YA pool; the floor below reads by its green strips) [shadow]
  m.light([-576, -576, 190], '#78b8ff', 1.5, 900);                     // Mega pit key      [shadow]
  m.light([-672, 704, 380], '#ffbe7a', 1.5, 900);                      // RA room key (warm) [shadow]
  m.light([-576, 200, 280], '#a8c8ff', 1.3, 900);                      // west mid key (rail) [shadow]
  m.light([592, 640, 400], '#8cc8ff', 1.5, 1000, { shadow: false });   // NE deck key
  m.light([688, -128, 280], '#9cc0ff', 1.1, 800, { shadow: false });   // east mid (east of the baffle)
  m.light([576, -640, 240], '#ffcf9c', 1.1, 800, { shadow: false });   // SE room (warm accent)
  m.light([-96, -592, 170], '#a8c8ff', 0.8, 620, { shadow: false });   // south corridor
  m.light([40, 600, 300], '#c0d8ff', 1.0, 700, { shadow: false });     // north junction (east lane, clear of the column)
  m.light([-672, -128, 220], '#a8c8ff', 0.8, 620, { shadow: false });  // west stairs (pit -> mid)
  m.light([-544, 520, 340], '#ffd0a0', 1.0, 800, { shadow: false });   // RA deck south half + the west stairs landing (warm)
  m.light([672, 144, 260], '#a8c8ff', 0.9, 700, { shadow: false });    // east bay + stairs
  m.light([-336, 176, 200], '#7ad0ff', 0.8, 560, { shadow: false });   // west link stairs
  m.light([336, -176, 200], '#7ad0ff', 0.8, 560, { shadow: false });   // east link stairs

  // ---------------- nav nodes ----------------
  const grid = (mins, maxs, z, opts = {}) => navGrid(m, mins, maxs, z, { spacing: 128, inset: 40, ...opts });
  grid([-800, -800], [-352, -352], Z0, { avoid: [[-512, -784]] });
  grid([-800, -64], [-480, 352], Z1);
  grid([-480, 224], [-384, 320], Z1);
  grid([-704, -192], [-480, -96], Z1); m.nav([-560, -80, Z1 + 24]);
  grid([-544, 384], [-352, 800], Z2); grid([-800, 608], [-544, 800], Z2); grid([-800, 480], [-672, 576], ZL);
  grid([-224, 448], [96, 800], ZJ);
  grid([224, 672], [384, 800], Z3);
  grid([384, 480], [800, 800], Z3);
  grid([544, 96], [800, 224], Z1); m.nav([592, 80, Z1 + 24]); m.nav([720, 0, Z1 + 24]);
  grid([480, -320], [800, 64], Z1);
  grid([384, -320], [480, -224], Z1);
  grid([-256, -256], [256, 256], Z0, { avoid: [[-176, -208]], avoidRadius: 72 });
  grid([-128, -64], [128, 256], Z2);
  grid([-192, -352], [-96, -256], Z0); grid([-352, -464], [-96, -352], Z0);
  grid([-320, -640], [160, -544], ZS); grid([64, -800], [160, -544], ZS); grid([64, -800], [352, -704], ZS);
  grid([352, -800], [800, -352], ZS);
  // stairs: foot (unless the stairs start at a wall), every second step, top (origin = step top + 24)
  const stairNodes = (x, y, z, dir, steps, run, w, foot = true) => {
    const c = w / 2;
    const put = (along, h) => {
      const o = dir === 'y+' ? [x + c, y + along, z + h + 24] : dir === 'y-' ? [x + c, y - along, z + h + 24] : dir === 'x+' ? [x + along, y + c, z + h + 24] : [x - along, y + c, z + h + 24];
      m.nav(o);
    };
    if (foot) put(-24, 0);
    for (let i = 1; i < steps; i += 2) put(run * (i + 0.5), 16 * (i + 1));
    put(run * steps + 24, 16 * steps);
  };
  stairNodes(-800, -352, Z0, 'y+', 3, 32, 128);
  stairNodes(-800, -192, ZS, 'x+', 3, 32, 128, false);
  stairNodes(-384, 64, Z0, 'y+', 6, 32, 96); m.nav([-336, 304, Z1 + 24]);
  stairNodes(-800, 352, Z1, 'y+', 3, 32, 128);
  stairNodes(-672, 480, ZL, 'x+', 3, 32, 96); m.nav([-480, 528, Z2 + 24]);
  stairNodes(-224, 608, ZJ, 'x-', 4, 32, 96);
  stairNodes(96, 480, ZJ, 'x+', 4, 32, 96); m.nav([304, 528, Z2 + 24]);
  stairNodes(224, 576, Z2, 'y+', 2, 32, 128);
  stairNodes(-128, 384, ZJ, 'y-', 4, 32, 96);
  stairNodes(672, 224, Z1, 'y+', 8, 32, 128);
  stairNodes(288, -64, Z0, 'y-', 6, 32, 96); m.nav([336, -304, Z1 + 24]);
  stairNodes(-320, -448, Z0, 'y-', 3, 32, 96);
  stairNodes(672, -448, ZS, 'y+', 3, 32, 128); m.nav([736, -336, Z1 + 24]);
  m.nav([-96, 40, Z2 + 24]);            // pad landing
  m.nav([56, 768, ZJ + 24]);            // teleporter exit (junction NE nook)
  m.nav([-272, 64, Z0 + 24]); m.nav([272, -64, Z0 + 24]);   // core doorways
  for (const it of m.items) {
    const o = [it.origin[0], it.origin[1], it.floorZ + 24];
    if (!m.navNodes.some((n) => Math.hypot(n.origin[0] - o[0], n.origin[1] - o[1], n.origin[2] - o[2]) < 32)) m.nav(o);
  }
}
