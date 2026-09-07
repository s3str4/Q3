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
Health** in the cool east atrium, and the player who controls the timing between them controls the map. The layout
is point-symmetric (rotated 180 degrees about the origin) so both players get the same movement options; items,
materials and lighting break the symmetry so each side reads differently.

Units are Quake units, Z up. Floor levels: lower **0**, upper **192**. Footprint 2368 x 1984 x 512 (walls included).

### Layout (top view, north = +y)

```
                x: -1152     -800 -640 -512 -288      0      288  512  640  800      1152
 y=+960  ..................................  +---------+  ..................................
                                             |  NORTH  |
 y=+768   +-------------------------------- | CHAMBER | ---------------------------------+
          | northRunA (z0, warm)       ===> |   YA    | <=== northRunB (z0, cool) spawn6 |
 y=+512   +----------------------+  ....    +---------+   ....   +----------------------+
              northStubA |  |                                          |  | northStubB
 y=+448   +-------------+--+-----+                              +----+--+---------------+
          |[stairs] NORTH STRIP z192|                              |PAD |  ATRIUM B (MH)  |
          |   ^  RG* spawn1 shards |                              | o  |  cool / wall2   |
 y=+256   |   ^  ........+--------+   WEST GALLERY  +-----------+ +----+     ^^ ramp     |
          |   ^          | EAST   |   (z0, open,    |   hub     |  |         ^^          |
          |   ^  [====]  | STRIP  |==== bridge ====== PG  RL* =====| WEST |  ^^   MH*     |
 y=0      |   ^  cover   | z192   |    over it)     |  ||   ||  |  | STRIP|  ^^ [====]   |
          |   ^          | h5 h5  |                 |  h25 ammo |  | z192 |  ^^  cover   |
 y=-256   |   RA*        +--------+                 +-----------+  EAST GALLERY (z0)     |
          |   SG         |  PAD   |                                 | SOUTH STRIP z192 LG*|
 y=-448   |      o       |   o    |door|                        |door|  shards  spawn3    |
          +-------------+--+-----+                              +----+--+---------------+
              southStubA |  |                                          |  | southStubB
 y=-672   +----------------------+  ....    +---------+   ....   +----------------------+
          | spawn5  southRunA (z0) ===> |  SOUTH  | <=== southRunB (z0, cool)            |
 y=-928   +------------------------------ | CHAMBER | ---------------------------------+
                                          | o o o YA|
 y=-960  ..................................  +---------+  ..................................

  *  major item      o health / ammo      ==>  door / opening      PAD  jump pad -> balcony strip
  ^  stairs (west, 12 x 16 rise / 32 run) or ramp (east, 26.6 degrees)
```

Each atrium (640 x 896, ceiling 448) has an L-shaped balcony: the west atrium's **north strip** (rail gun, spawn 1)
and **east strip** (the bridge lands here; the jump pad delivers you to its south end). Both strips are overhanging
slabs, so the lower floor runs underneath them (the loop doors are under the strips, 160 clearance). The east atrium
is the same shape rotated: south strip (lightning gun) and west strip, with a ramp instead of stairs.

The atria open onto the hub through two full-height **galleries** (224 long, 288 wide): the west gallery on the
*north* half of the hub's west side, the east gallery on the *south* half of its east side. The bridge (192 wide,
z 192) crosses both galleries and the hub in the open, so floor players and bridge players see each other.

### Routes between the atria (4 distinct)

| # | Route | Level | Notes |
|---|---|---|---|
| 1 | **Bridge**: east strip -> over the west gallery -> bridge over the hub -> over the east gallery -> west strip | 192 | plasma gun mid-bridge, plasma ammo at both ends; open on both sides (rocket-able from the RL nook) |
| 2 | **Hub floor**: west gallery (north half) -> hub -> east gallery (south half) | 0 | the galleries are offset, so there is no straight lane from atrium to atrium; rocket launcher between the bridge pillars |
| 3 | **South loop**: west south door -> stub -> run A -> south chamber (YA) -> run B -> stub -> east south door | 0 | run B sits 96 below run A, so no end-to-end sightline through the chamber |
| 4 | **North loop**: the 180-degree twin of the south loop (YA in the north chamber) | 0 | |

Within each atrium the upper level is reached by the stairs/ramp on the outer wall **and** by a jump pad in the
corner opposite the stairs. Every walkway is reachable by walking (no trick jumps); the highest drop is 192 (no fall
damage, which starts at ~264).

### Items (Q3 respawn times from `shared/constants.js`)

| Item | Where | z | Respawn |
|---|---|---|---|
| Red Armor (+100) | west atrium floor, south-centre, under the rail balcony's sightline | 0 | 25 s |
| Mega Health (+100) | east atrium floor, north-centre | 0 | 35 s |
| Rail Gun | west north strip (upper) | 192 | 5 s |
| Lightning Gun | east south strip (upper) | 192 | 5 s |
| Rocket Launcher | hub, between the bridge pillars, under the bridge | 0 | 5 s |
| Plasma Gun | mid-bridge, directly above the RL | 192 | 5 s |
| Shotgun | west atrium, SW corner at the stairs foot | 0 | 5 s |
| Yellow Armor x2 | south chamber, north chamber | 0 | 25 s |
| Health +25 x3 | west under the north strip (by the north door), east under the south strip, hub SW quadrant | 0 | 35 s |
| Health +5 x12 | 3 on each inner strip (pad landing lanes), 3 at each chamber entry | 192 / 0 | 35 s |
| Armor shards x6 | 3 under the west north strip's dead end, 3 under the east south strip's dead end | 0 | 25 s |
| Rockets x2 | hub NE quadrant, south run A | 0 | 40 s |
| Slugs x2 | west north strip, north run B | 192 / 0 | 40 s |
| Cells x2 | east south strip, north run A | 192 / 0 | 40 s |
| Shells x2 | east NE corner, south run B | 0 | 40 s |
| Plasma x2 | both bridge ends | 192 | 40 s |
| Bullets x2 | west floor by the stairs, east floor by the ramp | 0 | 40 s |

Majors are >= 590 units apart (RA-RG 616, MH-LG 616, RA-RL 862, RA-MH 1722). Item origins are 20 above their
floor and carry `floorZ` for the ring marker.

### Spawns (6)

1. west north strip, west end (upper), facing south  2. west lower, under the north strip, facing south
3. east south strip, east end (upper), facing north  4. east lower, under the south strip, facing north
5. south run A (facing west)  6. north run B (facing east)

The loop spawns see neither major; the atrium spawns see at most their own atrium's major. Red Armor and Mega
have no line of sight to each other (asserted by `tests/map.test.mjs`).

### Design rationale

- **Item control loop.** RA (25 s) and MH (35 s) are 1722 units apart on opposite sides. RA -> hub (RL) -> MH by
  the floor is ~6 s at 320 ups, the bridge about the same but exposed, and each loop is ~9 s. A player holding both
  must commit to a 25-35 s cycle that passes through the hub twice; the out-of-control player contests the hub (RL)
  or takes a loop for YA and either RG or LG to break the cycle.
- **Sightlines.** The rail gun lives on the west balcony overlooking RA: whoever holds RG punishes RA grabs from
  above, but the balcony is exposed to the bridge and the pad landing. The galleries are offset (west on the north
  half, east on the south half) so no straight lane crosses the whole map at floor level; the long lines are the
  bridge (strip to strip, ~1400), the diagonals through the hub (broken by the RL pillars) and each loop run (640).
- **Vertical play.** Both atria have a two-storey L balcony; the bridge is open over the galleries and the hub, so
  bridge runners are visible (and rocket-able) from the floor, and the floor is visible from the bridge. Health
  bubbles on the pad landing lanes reward taking the fast way up.
- **Readability.** Warm brick + amber strips = west / RA; cool panels + blue strips = east / MH; green strips = the
  neutral hub and bridge; the loop runs carry the colour of the atrium they are nearest; a tall red bar marks the RA
  wall and a tall cool bar the MH wall. Balcony lips are lit from below so the upper level reads from the floor.
  14 point lights: warm/cool keys 300 above each atrium floor, a hub key, low spots on RA and Mega, fills under the
  strips, under the bridge, in the chambers, runs and galleries.
- **Movement.** Corridors are 160-288 wide, halls 160 high, rooms 256-448; stairs are 16 x 32 (step height 18),
  the ramp is 26.6 degrees (walkable normal 0.89 > 0.7). Every drop is < 264 (no fall damage). Jump pad targets sit
  96 above the landing strip because the Q3 pad solve puts the flight apex at the target (asserted physically).
- **Why this compact.** An earlier 2816 x 2176 version of the same topology had bots in line of sight of each other
  only 7% of the time; the galleries and the 25% smaller footprint bring that to ~20% and double the encounter rate.

### Verification

`node --test tests/map.test.mjs` asserts: enclosure (no leaks, >20k point rays), reachability of every item and
spawn from every spawn over the bot nav graph (and no `findPath` fallback), player-box clearance re-walked along every
nav edge (jump edges swept at jump height), corridor widths/ceilings, stair rises, major spacing, items resting on
their floors, jump pads physically delivering the player to the upper level, and the spawn/major sightline rules.
`node tools/bot_duel.mjs --map arena_duel --seconds 180 --skill 0.8` is the roaming check (frags, pickups of every
major, jump pad use, no stalls).
