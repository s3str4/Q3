// Survival prototype contract: every tunable and every event name lives here so the renderer, HUD, audio and tests
// share one vocabulary. Units: 1 world unit = 1 tile (about 1 metre). x grows east, y grows south. Angles in radians,
// 0 = +x, PI/2 = +y (south). Time: the sim runs a fixed 30 Hz step; game time is in game-seconds (see DAY).
export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;
export const DT = 1 / TICK_RATE;

export const TILE = { GRASS: 0, ROAD: 1, FLOOR: 2, WALL: 3, DOOR: 4, WINDOW: 5, TREE: 6, WRECK: 7, SIDEWALK: 8, PUMP: 9, STUMP: 10 };
export const TILE_NAME = Object.fromEntries(Object.entries(TILE).map(([k, v]) => [v, k.toLowerCase()]));
// Tiles nobody can walk through, ever. DOOR (closed), WINDOW (intact) and barricaded tiles are obstacles that zombies bash.
export const SOLID = new Set([TILE.WALL, TILE.TREE, TILE.WRECK, TILE.PUMP]);
// Tiles that block sight. Windows and open doors are see-through; a barricade on a window blocks sight.
export const OPAQUE = new Set([TILE.WALL, TILE.TREE, TILE.WRECK]);
// Footstep surface per tile for audio/visual feedback.
export const SURFACE = { [TILE.GRASS]: 'grass', [TILE.STUMP]: 'grass', [TILE.ROAD]: 'asphalt', [TILE.SIDEWALK]: 'concrete', [TILE.FLOOR]: 'wood', [TILE.DOOR]: 'wood', [TILE.WINDOW]: 'wood' };

export const ITEMS = {
  fists:   { label: 'Fists',        kind: 'weapon', stack: 1 },
  bat:     { label: 'Baseball bat', kind: 'weapon', stack: 1 },
  pistol:  { label: 'Pistol',       kind: 'weapon', stack: 1 },
  ammo:    { label: '9mm rounds',   kind: 'ammo',   stack: 60 },
  food:    { label: 'Canned food',  kind: 'food',   stack: 10, hunger: 40 },
  water:   { label: 'Water bottle', kind: 'drink',  stack: 10, thirst: 45 },
  bandage: { label: 'Bandage',      kind: 'medical', stack: 10, heal: 20 },
  plank:   { label: 'Plank',        kind: 'material', stack: 40 },
};
export const WEAPON_SLOTS = ['fists', 'bat', 'pistol'];   // keys 1 2 3
export const WEAPONS = {
  fists:  { damage: 12, range: 0.95, arc: 1.3, cooldown: 0.5, stamina: 6, knockback: 0.5, stagger: 0.25, noise: 4, windup: 0.08 },
  bat:    { damage: 34, range: 1.35, arc: 1.5, cooldown: 0.7, stamina: 13, knockback: 1.1, stagger: 0.55, noise: 7, windup: 0.12 },
  pistol: { damage: 45, range: 12, cooldown: 0.32, stamina: 0, knockback: 0.35, stagger: 0.35, noise: 26, mag: 8, reload: 1.5, windup: 0 },
};

export const PLAYER = {
  radius: 0.34, walk: 2.7, run: 4.8, sneak: 1.35, accel: 22,
  maxHealth: 100, maxStamina: 100,
  staminaDrain: 16, staminaRegen: 11, staminaRegenDelay: 0.9, staminaTired: 15,     // below staminaTired: cannot sprint / swing
  hungerPerMin: 2.2, thirstPerMin: 3.0,                     // per game-minute
  starveDamage: 1.5, starveInterval: 4,                     // hp lost every starveInterval s while hunger or thirst is 0
  bleedDamage: 1, bleedInterval: 2,
  regenPerSec: 0.35, regenMinFood: 40,                      // slow regen when fed and hydrated
  bandageHealTime: 6,                                       // bandage heal is spread over this many seconds
  hurtStagger: 0.28, interactRange: 1.6, interactArc: 2.4,
  lowHealth: 30,
};
export const NOISE = { sneak: 1.5, walk: 4.5, run: 9, melee: 6, gunshot: 26, door: 6, harvest: 11, build: 9, hurt: 4, break: 13, bash: 8, land: 3 };
export const FOOTSTEP_INTERVAL = { sneak: 0.62, walk: 0.42, run: 0.29 };

export const ZOMBIE = {
  radius: 0.36, hp: 100, walk: 0.95, chase: 2.0, chaseNight: 2.7, investigate: 1.35, accel: 10,
  attackRange: 1.05, attackDamage: 14, attackCooldown: 1.25, attackWindup: 0.35, bleedChance: 0.3,
  bashDamage: 14, bashCooldown: 1.0,
  sightDay: 9.5, sightNight: 4.2, fov: 2.35 /* ~135 deg */, hearingScale: 1.0, loseSightTime: 4.5, investigateGiveUp: 9,
  staggerTime: 0.5, wanderPause: [1.5, 5], wanderRadius: 6, groanInterval: [4, 11], separation: 0.7,
  hordeSpeedBonus: 0.35,
};
export const ZSTATE = { IDLE: 'idle', WANDER: 'wander', INVESTIGATE: 'investigate', CHASE: 'chase', ATTACK: 'attack', BASH: 'bash', STAGGER: 'stagger', DEAD: 'dead' };
export const PSTATE = { IDLE: 'idle', WALK: 'walk', RUN: 'run', SNEAK: 'sneak', ATTACK: 'attack', INTERACT: 'interact', STAGGER: 'stagger', DEAD: 'dead' };

// Game clock: the slice starts at 08:00 on day 1 and is won at 06:00 on day 2. 1 real second = 3 game minutes
// (a full day is 8 minutes) unless the sim is created with a timeScale.
export const DAY = {
  startHour: 8, hoursPerSecond: 1 / 20,
  duskHour: 18, nightHour: 21, dawnHour: 6, morningHour: 7,
  hordeHour: 22,
  waves: [{ hour: 22, count: 6 }, { hour: 0, count: 5 }, { hour: 3, count: 4 }],
  winHour: 6,
};
export const DOOR_HP = 90, WINDOW_HP = 45, BARRICADE_HP = 150, BARRICADE_COST = 2, TREE_HITS = 3, TREE_PLANKS = 2, HARVEST_COOLDOWN = 0.6;

export const OBJECTIVES = [
  { id: 'supplies', label: 'Find water and food' },
  { id: 'arm', label: 'Arm yourself (bat or pistol)' },
  { id: 'planks', label: 'Gather 4 planks (chop trees, loot shelves)' },
  { id: 'fortify', label: 'Barricade 2 openings before 21:00' },
  { id: 'survive', label: 'Survive the night until 06:00' },
];

// Events emitted per tick in sim.events (consumed by renderer, HUD, audio and the evidence log). Each carries
// { type, t, x, y, ...payload }. `who` is 'player' or a zombie id where relevant.
export const EV = {
  FOOTSTEP: 'footstep',             // who, surface, gait ('sneak'|'walk'|'run'|'shamble'|'chase')
  SWING: 'swing',                   // weapon, hit(bool)
  MELEE_HIT: 'melee_hit',           // target (zombie id), damage, killed
  GUNSHOT: 'gunshot',               // dir
  BULLET_HIT: 'bullet_hit',         // target id | null (world hit), damage, killed
  RELOAD: 'reload',                 // start of reload
  RELOAD_DONE: 'reload_done',
  NO_AMMO: 'no_ammo',
  ZOMBIE_GROAN: 'zombie_groan',     // id, state
  ZOMBIE_ALERT: 'zombie_alert',     // id, from ('sight'|'sound'|'horde'), prev state
  ZOMBIE_LOST: 'zombie_lost',       // id (chase -> investigate)
  ZOMBIE_ATTACK: 'zombie_attack',   // id (swing begins)
  ZOMBIE_BASH: 'zombie_bash',       // id, tile x/y, hp left
  ZOMBIE_STAGGER: 'zombie_stagger', // id
  ZOMBIE_DEATH: 'zombie_death',     // id, by ('bat'|'pistol'|'fists')
  PLAYER_HURT: 'player_hurt',       // damage, from {x,y}, health, bleeding
  PLAYER_DEATH: 'player_death',
  LOW_HEALTH: 'low_health',         // on (bool): heartbeat cue starts/stops
  STAMINA_OUT: 'stamina_out',
  PICKUP: 'pickup',                 // item, count, container
  CONTAINER_OPEN: 'container_open', // container id, kind, empty(bool)
  DOOR_OPEN: 'door_open', DOOR_CLOSE: 'door_close', DOOR_BREAK: 'door_break', WINDOW_BREAK: 'window_break',
  BARRICADE_BUILT: 'barricade_built', BARRICADE_HIT: 'barricade_hit', BARRICADE_BROKEN: 'barricade_broken',
  HARVEST_HIT: 'harvest_hit',       // tile, hitsLeft
  HARVEST_DONE: 'harvest_done',     // planks
  EAT: 'eat', DRINK: 'drink', BANDAGE: 'bandage',
  WEAPON_SWITCH: 'weapon_switch',   // weapon
  ACTION_DENIED: 'action_denied',   // reason ('no_planks'|'no_target'|'tired'|'nothing_here'|'no_item'|'not_needed'|'no_ammo'|'busy')
  PHASE: 'phase',                   // phase ('day'|'dusk'|'night'|'dawn'), hour
  HORDE: 'horde',                   // count, wave
  OBJECTIVE_STEP: 'objective_step', // id, label, index
  OBJECTIVE_COMPLETE: 'objective_complete',
  WIN: 'win', LOSE: 'lose',
  NOISE: 'noise',                   // x, y, radius, kind: every audible noise the AI reacts to (diagnostics)
};
