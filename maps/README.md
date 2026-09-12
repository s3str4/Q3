# Maps

Map modules export `build(m)` (MapBuilder DSL, see `shared/map.js`) and `meta`. `maps/shell.js` holds the shared
builders: a room-shell generator (declare rooms as voids, get leak-free floor/ceiling/wall brushes with per-face
materials; touching or overlapping rooms open into each other exactly where their voids meet) and `navGrid` (bot nav
nodes on a grid, skipping any spot where the player box would intersect solid).

| Map | File | Use |
|---|---|---|
| Crossfire | `arena_duel.js` | the competitive 1v1 duel map (default) |
| Test Box | `testbox.js` | two rooms and a corridor, used by unit tests |

## Crossfire (`arena_duel`)

A Quake 3 duel map in the spirit of pro-q3dm6 / ztn3tourney1: **Red Armor** in the warm west atrium, **Mega
Health** in the cool east atrium, a **Yellow Armor** in each gallery door between them, and the player who
controls the timing of that line controls the map. The layout is point-symmetric (rotated 180 degrees about the
origin) so both players get the same movement options; items, materials and lighting break the symmetry so each
side reads differently.

Units are Quake units, Z up. Floor levels: lower **0**, mezzanine **112**, upper **192**. Footprint 2368 x 1984 x 512
(walls included).

### Layout (top view, north = +y)

```
                x: -1152      -672 -512 -288 -208 -48 0  48  208 288  512  672      1152
 y=+960   ...........................  +--------------------+  ...........................
                                       |[shelf] NORTH CHAMB.|      shelf z32 (o o o), column [C]
 y=+768   +-------------------------- |  o  [C]   SG       | --------------------------+
          | northRunA (z0, warm)  ===>|  o        (256 hi) |<=== northRunB (z0) spawn6 |
 y=+512   +-----------------+  ....   +-----+--------+-----+   ....   +-----------------+
             northStubA |  |                | north  |                       |  | northStubB
 y=+448   +-------+-----+--+------+         | corr.  |               +------+--+-----+-------+
          |[stairs] NORTH STRIP z192|         | o o o  |               | PAD  |  ATRIUM B (MH) |
          |   ^  RG* spawn1 shards |         | (z0)   |               |  o   |  cool / wall2  |
 y=+256   |   ^  ....... +--------+  WEST   +--+  +--+               +-[P2]-+  MH* [] ^^ ramp |
          |   ^          | EAST   |  GALLERY|  |h25|  |                 |         ^^         |
 y=+64    |   ^ +------+ | STRIP  |  (z0,   |==| PIER |== bridge ===| WEST | +------+ ^^      |
          |   ^ | MEZZ | | z192   |  128 hi)|  |h25 |  |  z192 over  | STRIP| | MEZZ | ^^      |
 y=-128   |   ^ | z112 | | h5 h5  |   YA*   |  +----+  |  the pier   | z192 | | z112 | ^^      |
          |   ^ +------+ |        |         |  RL*  |  |   EAST GALLERY (z0) | +------+ ^^      |
 y=-256   | [] RA*  PAD +-[P2]-+          +--+  +--+  |    YA*       | SOUTH STRIP z192 LG*|
          |   SG    o   [P1]   |                  | south  |  |          |door|  shards   spawn3   |
 y=-448   +-------+-----+--+------+         | corr.  |  +------+--+-----+-------+
             southStubA |  |                | o o o  |                       |  | southStubB
 y=-672   +-----------------+  ....   +-----+--------+-----+   ....   +-----------------+
          | spawn5  southRunA (z0) ===>|  PG    [C]      o |<=== southRunB (z0, cool)      |
 y=-928   +-------------------------- |  SOUTH CHAMBER  o | --------------------------+
                                       |  (256 hi) [shelf] |
 y=-960   ...........................  +--------------------+  ...........................

  *  major item      o health / ammo      ==>  door / opening      PAD  jump pad -> balcony strip
  ^  stairs (west, 12 x 16 rise / 32 run) or ramp (east, 26.6 degrees)     []  major-item plinth (16 high)
  MEZZ  112-high mezzanine block (224 x 192) stepped onto from the fifth stair / the ramp
  P1 / P2  floor-to-balcony columns under the inner strip (corner column, gallery-jamb pilaster)
  [C]  chamber column (floor to ceiling)     shelf  32-high chamber shelf with a 16 step in front
```

Each atrium (640 x 896, ceiling 448) has an L-shaped balcony: the west atrium's **north strip** (rail gun, spawn 1)
and **east strip** (the bridge lands here; the jump pad beside Red Armor delivers you to it). Both strips are
overhanging slabs, so the lower floor runs underneath them (the loop doors are under the strips, 160 clearance). The
east atrium is the same shape rotated: south strip (lightning gun) and west strip, with a ramp instead of stairs.

The atria open onto the hub through two stacked doors each: a low, wide **gallery** at floor level (288 wide, 128
high; the west one on the *north* half of the hub's west side, the east one on the *south* half of its east side)
and, directly above it, the **upper throat** (192 wide, 160 high) that becomes the bridge. The bridge crosses the
hub (576 square, 448 high) on a central **pier** (256 x 192, floor to bridge) which carries the plasma ammo /
health bubble spot on top and hides the rocket launcher in its lee below.

### Interior structure (round 3)

The atria and chambers are no longer open boxes. Each atrium holds three solids, each chamber two; the bounds they
give are asserted by `tests/map.test.mjs` ("atria have interior cover", "chambers have a tall interior solid").

| Element | Where (west atrium; the east is the 180-degree twin) | Size | What it does |
|---|---|---|---|
| **Mezzanine block** | x -1024..-800, y -128..64, flush with the stairs' east edge | 224 x 192 x 112, trim plinth + cap | A third level: stepped onto from the fifth stair (z 96, one 16 step) - in the east from the ramp where it passes 96. Its top (machinegun ammo) overlooks the RA pocket and the whole floor, is rocketable from both balconies, and its south face walls the RA pocket off from the hub-side two thirds of the atrium. |
| **Major plinth** | x -1008..-912, y -272..-176 | 96 x 96 x 16 | RA (Mega in the east) rests on it 96 south of the block, between the block, the stairs foot, the pad and the wall marker bar. |
| **Corner column P1** | x -704..-616, y -192..-128, floor to balcony underside (160) | 88 x 64 x 160 | Under the inner strip's outer end. |
| **Jamb pilaster P2** | x -608..-512, y -96..0, floor to balcony underside | 96 x 96 x 160 | The gallery door's south jamb, thickened. P1 and P2 overlap by 8 in x, so the south-door -> north-door lane under the strip is a chicane of two passages (104 wide east of P1, 192 wide west of P2) instead of a 1522-unit corridor. |
| **Chamber column** | x 0..64, y -768..-704 (south chamber), floor to ceiling | 64 x 64 x 256, banded, green glow collar | Offset east of centre so it sits on the run-A-door -> run-B-door line. |
| **Chamber shelf** | x -224..-136, y -960..-704, along the far wall | 88 x 256 x 32, 32-wide 16 step in front | Two-level chamber; the three health bubbles sit on it. Its open north edge is a 32 ledge (a jump). |

Measured (eye-to-eye traces between bot nav nodes, `tests/map.test.mjs` + `.evidence/map_r3/metrics.json`):

| Metric | Round 2 | Round 3 | Bound asserted |
|---|---|---|---|
| Floor-to-floor LOS inside atrium A / B (nodes with z <= 150, mezzanine included) | 81.7% / 82.8% | **52.6% / 52.7%** (1128 / 1035 pairs) | <= 60% |
| RA / Mega visible from its atrium's floor nodes | 66% / 64% | **40% / 37%** (19 of 48, 17 of 46) | <= 45% |
| South stub <-> north stub pairs in LOS (loop door to loop door) | 48 / 48 (1522 u) | **0 / 48** both sides | < 50% |
| Chamber floor LOS (all pairs) | 100% | 85% (300 pairs) | <= 90% |
| Longest nav-node lane | 1525 (stub to stub) | **1417** (west floor to the east strip landing, over the bridge line) | <= 1600 |
| RA / Mega visible from all 374 nav nodes | 15.9% / 15.6% | 7.2% / 6.7% | |

### Routes between the atria (4 distinct)

| # | Route | Level | Walk RA -> MH | Notes |
|---|---|---|---|---|
| 1 | **Bridge**: pad or stairs -> east strip -> upper throat -> over the hub -> upper throat -> west strip -> Mega | 192 | 2241 u, 7.0 s | health +25 mid-bridge, plasma ammo at both ends; open over the hub (rocket-able from the floor) |
| 2 | **Hub floor**: west gallery (YA) -> around the pier -> east gallery (YA) | 0 | 2241 u (equal) | the galleries are offset and the pier blocks every gallery-to-gallery line; rocket launcher behind the pier |
| 3 | **South loop**: west south door -> chicane under the strip -> stub -> run A -> south chamber (PG, column, shelf) -> run B -> stub -> east south door | 0 | 3011 u, 9.4 s | run B sits 96 further out than run A, so no lane runs the whole loop; the chamber also opens onto the hub through the south corridor |
| 4 | **North loop**: the 180-degree twin of the south loop (shotgun chamber, north corridor) | 0 | | |

(RA -> MH with the bridge banned: 2449 u; the majors moved one bay outward this round, which is the 200 u added to
every route.) The two **corridors** (160 wide, 224 long, health bubbles) make each chamber a three-door junction:
hub -> chamber -> either atrium is a 30% detour instead of a 9 s commitment, which is what puts traffic through the
loops. Within each atrium the upper level is reached by the stairs/ramp on the outer wall **and** by the jump pad
beside the major item; the mezzanine is reached from the stairs / ramp only (its 112 face is not jumpable from the
floor, so it is a position you commit to). Every walkway is reachable by walking (no trick jumps); the highest drop
is 192 (no fall damage, which starts at ~264). The 16-unit throat thresholds, the plinths and the shelf step are
ordinary steps; the shelf's north edge is the map's only 32 ledge.

### Items (Q3 respawn times from `shared/constants.js`)

| Item | Where | z | Respawn |
|---|---|---|---|
| Red Armor (+100) | west atrium, on the plinth in the pocket between the mezzanine block, the stairs foot and the pad; the red wall bar marks it | 16 | 25 s |
| Mega Health (+100) | east atrium, the twin pocket (block, ramp foot, pad; cool wall bar) | 16 | 35 s |
| Yellow Armor x2 | west gallery door, east gallery door | 0 | 25 s |
| Rail Gun | west north strip (upper) | 192 | 5 s |
| Lightning Gun | east south strip (upper) | 192 | 5 s |
| Rocket Launcher | hub, south lee of the pier, by the south corridor door | 0 | 5 s |
| Plasma Gun | south chamber, at its corridor mouth | 0 | 5 s |
| Shotgun | north chamber, at its corridor mouth | 0 | 5 s |
| Health +25 x4 | west under the north strip (north door), east under the south strip (south door), mid-bridge, hub north lee of the pier | 0 / 192 | 35 s |
| Health +5 x18 | 3 on each inner strip (pad landing lanes), 3 in each corridor, 3 on each chamber shelf | 192 / 0 / 32 | 35 s |
| Armor shards x6 | 3 under the west north strip's dead end, 3 under the east south strip's dead end | 0 | 25 s |
| Rockets x2 | hub NE quadrant, south run A | 0 | 40 s |
| Slugs x2 | west north strip, north run B | 192 / 0 | 40 s |
| Cells x2 | east south strip, north run A | 192 / 0 | 40 s |
| Shells x2 | west floor at the stairs foot, south run B | 0 | 40 s |
| Plasma x2 | both bridge ends (upper throat mouths) | 192 | 40 s |
| Bullets x2 | on the two mezzanine tops (the reward for climbing) | 112 | 40 s |

Majors are >= 602 units apart (RA-RG 602, MH-LG 602, RA-RL 961, RA-MH 1972; the YAs are 670 from their atrium's
major and 522 from the RL). Item origins are 20 above their floor and carry `floorZ` for the ring marker; every
item spot has a nav node (49 items, 319 map nav nodes / 376 in the bot graph, 14 lights, 265 brushes).

### Spawns (6)

1. west north strip, west end (upper), facing east along the strip  2. west lower, under the north strip, facing south
(at the mezzanine block)  3. east south strip, east end (upper), facing west along the strip  4. east lower, under the
south strip, facing north  5. south run A (facing west)  6. north run B (facing east)

No spawn sees any other spawn; the loop spawns see neither major; the atrium spawns see at most their own
atrium's major. Red Armor and Mega have no line of sight to each other (all asserted by `tests/map.test.mjs`).

### Sightline budget (asserted)

`tests/map.test.mjs` traces eye-to-eye (a standing player at each end) between every pair of spawns, between the
rail and lightning pickups, and between every pair of nav nodes, and asserts: no spawn sees another spawn, the two
balconies do not see each other, and the longest visible nav-node lane is <= `meta.maxLane` (1600). Measured:
longest lane **1417**; the bridge view strip-to-strip is ~1330. The geometry behind it:

- **Galleries 128 high.** Any line from an atrium floor into the far upper throat must be below 128 at the
  gallery's hub mouth (x = +-288) and above 192 at x = -+288; from the farthest floor nodes (x = +-968 and beyond)
  that slope puts it at z >= 133 at the gallery mouth, so it hits the gallery ceiling. Nearer nodes get through but
  the lane is then under 1600.
- **Pier 256 x 192 under the bridge.** A line from the west gallery mouth (x -288, y in 0..288) to the east gallery
  mouth (x 288, y in -288..0) has y(-128) >= -80 and y(128) <= 80, so somewhere in x -128..128 it is inside |y| <= 96
  and below the bridge: blocked. A line from the north corridor door (y 288, x in 48..208) to the south corridor
  door has |x| <= 80 at y = 0: blocked. The bridge slab (z 160..192) closes the gap above the pier.
- **Throat thresholds (16 high).** A player halfway up the stairs (eye z 178) looks through the west throat along
  the whole bridge to the far strip (1706 u); the line crosses the throat mouth at z 200 and the doorstep at
  z 192..208 catches it. The same at the ramp.
- **Chicane columns.** The stub nodes sit at x = -632 and -552 (and their mirrors); P1 (x -704..-616) catches every
  line that starts or ends at -632 in y -192..-128, P2 (x -608..-512) catches every line through -552 and every
  diagonal between them in y -96..0 (a -552 -> -632 diagonal crosses y -64 at x -582..-593, inside P2). Result:
  0 of 48 stub pairs on each side.
- **Mezzanine block.** From the north-east two thirds of the atrium, every line to the RA plinth crosses y = -128
  at x < -800 (inside the block) or passes the 96-wide gate between the block and P1 - only the five floor nodes on
  the x = -696 / -560 columns nearest the gate keep the view.
- **Loop runs offset by 96** so no lane runs a whole loop; **galleries offset** (north half / south half) so the
  only atrium-to-atrium floor line has to pass the pier.

### Design rationale

- **Item control line.** RA (25 s) -> YA (25 s) -> RL -> YA -> MH (35 s) is one 2240-unit line (7.0 s over the
  bridge or along the floor). A player holding RA and MH passes both YAs every cycle and must cross the hub
  twice; the out-of-control player takes the loops (9.4 s end to end, or hub -> corridor -> chamber -> atrium) to
  reach a YA door or the far major from behind, picking up PG / SG and health on the way.
- **Sightlines and cover.** The major pockets are now recesses: RA is seen from 19 of the 48 west floor nodes (the
  pocket, the stairs foot, the five nodes looking through the gate, the mezzanine top) instead of 27 of 41, so a
  player timing RA cannot be railed from the north door, the gallery or the far side of the block, and the
  approach to RA is a choice between the gate (from the hub side), the stairs foot (from the north) and the pad
  lane (from the south door). The east strip's south end (where the pad lands) still overlooks RA; the rail gun on
  the north strip does not, so the rail spawn no longer covers the armor. Inside an atrium, floor-to-floor LOS is
  52% of node pairs: the block, the plinths and the two columns give every floor position a piece of cover within
  ~200 units.
- **Vertical play.** Three levels per atrium: floor, the 112 mezzanine (a perch over the pocket that is itself
  exposed to both balconies and the bridge landing), and the 192 balconies. The bridge is open over the hub, so
  bridge runners are visible (and rocket-able) from the floor; the pier top is the mid-bridge health stop. Health
  bubbles on the pad landing lanes reward taking the fast way up; the machinegun ammo on the mezzanine rewards the
  climb.
- **Chambers.** The column sits on the door-to-door line so a player entering from run A cannot be shot from the
  run B door across the room; the shelf along the far wall gives the room a high side (the health bubbles) and a
  low side, and a 32 ledge to hop for anyone circling the column.
- **Readability.** Warm brick + amber strips = west / RA; cool panels + blue strips = east / MH; green strips = the
  neutral hub, bridge, pier, corridors and chamber columns; each gallery carries its atrium's colour; the loop runs
  carry the colour of the atrium they are nearest; a tall red bar marks the RA wall and a tall cool bar the MH wall.
  New this round: sloped light strips climb the west wall with the stairs and the east wall with the ramp; the
  columns, pilasters and mezzanine blocks carry trim bands (plinth / cap) and a flush 8-unit glow collar at strip height (a stacked segment, so it changes
  no collision - a proud collar cost the mezzanine its walk-off edges) so the faces no light reaches (the pilaster's south face seen from the chicane, the block's ramp side) still read;
  the chamber columns have the same collar in green. Balcony lips are lit from below so the upper level reads from
  the floor. 14 point lights: warm/cool keys 300 above each atrium floor, a hub key, low spots off the block corners
  (they wash the block faces and the major plinths), one fill per hall (under each strip + its gallery, the RL nook,
  both chambers on the column's far diagonal, all four loop runs). Hemisphere ambient 0.4.
- **Movement.** Corridors are 160-288 wide, the chicane passages 104 and 192, halls 160 high (galleries 128), rooms
  256-448; stairs are 16 x 32 (step height 18), the ramp is 26.6 degrees (walkable normal 0.89 > 0.7). Every drop is
  < 264 (no fall damage). Jump pad targets sit 96 above the landing strip because the Q3 pad solve puts the flight
  apex at the target (asserted physically); the pad flight clears the corner column by 80+ units.
- **Why the YAs are in the doors, not the chambers.** In the bots' 180 s duels a YA at the far end of a loop was
  picked up once in two matches; on the gallery line it is picked up 3-7 times per match, the RL 5-11, and the loop
  weapons 0-4. That matches the reference maps, where the yellow armors sit on the RA -> MH line and the side rooms
  hold the secondary weapons.

### Verification

`node --test tests/map.test.mjs` (13 tests) asserts: enclosure (no leaks, >20k point rays), reachability of every
item and spawn from every spawn over the bot nav graph (and no `findPath` fallback), player-box clearance re-walked
along every nav edge (jump edges re-walked with the 44-unit jump allowance, gap jumps swept at jump height), corridor
widths/ceilings (including the chicane passages and the shelf-to-column gap), stair rises, major spacing, items
resting on their floors, jump pads physically delivering the player to the upper level, the spawn/major sightline
rules, the sightline budget above, the interior-cover bounds (floor LOS <= 60%, majors from <= 45% of floor nodes,
loop doors < 50% mutually visible) and the chamber structure (an interior solid >= 96 high, a raised nav level,
chamber LOS <= 90%).
`node tools/bot_duel.mjs --map arena_duel --seconds 180 --skill 0.8 --seed 7|23|99` is the roaming check (frags,
pickups of every major, jump pad use, no stalls; round 3: 14-16 frags, 86-88 pickups, RA and Mega taken every seed,
13-22 pad launches, stuckSeconds 0). Bots spend 0.8-3.3% of their time on the mezzanines and 1.7-5% on the chamber
shelves (`.evidence/map_r3/occupancy.json`).

## Map pack

Three duel maps ship; the host picks one in the menu and the guest receives it in the WELCOME handshake.

| Map | Module | Character | Notes |
|---|---|---|---|
| Crossfire | `arena_duel.js` | two atria, item control | Mega and Red Armor on opposite sides, upper L-balconies, jump pads |
| Lava Spire | `lava_spire.js` | vertical, warm | a lava crater with four towers and a railed spire holding Red Armor (320 high); Mega on the tower mezzanine; three jump pads; lava never on a walking route (bots: 0 lava deaths in 180 s duels) |
| Tight Deck | `tight_deck.js` | compact, cool/tech | aerowalk-style deck on seven height levels (0..224), corridors 96-128 wide, a teleporter from the Mega pit to the junction, no free eye line longer than 731 |

Each map has its own acceptance suite (`tests/map*.test.mjs`): enclosure, bot reachability of every item and spawn, player-box clearance on every nav edge, corridor/ceiling/stair limits, major-item spacing and spawn sightlines, plus map-specific rules (lava crossings, teleporter exit, sightline caps, route verticality).
