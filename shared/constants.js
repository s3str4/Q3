// Quake 3 Arena reference constants (bg_public.h / bg_pmove.c / g_local.h).
export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;
export const FRAMETIME = 1 / TICK_RATE;

export const PM = {
  speed: 320,
  accelerate: 10,
  airaccelerate: 1,
  friction: 6,
  stopspeed: 100,
  duckScale: 0.25,
  jumpVelocity: 270,
  gravity: 800,
  stepSize: 18,
  overclip: 1.001,
  minWalkNormal: 0.7,
  surfaceClipEpsilon: 0.125,
  maxClipPlanes: 5,
  mins: [-15, -15, -24],
  maxs: [15, 15, 32],
  duckMaxs: [15, 15, 16],
  viewHeight: 26,
  duckViewHeight: 12,
  knockback: 1000,
  mass: 200,
  maxKnockback: 200,
};

export const WEAPONS = {
  NONE: 0, GAUNTLET: 1, MACHINEGUN: 2, SHOTGUN: 3, GRENADE: 4, ROCKET: 5, LIGHTNING: 6, RAIL: 7, PLASMA: 8,
};
export const WEAPON_NAMES = ['none', 'gauntlet', 'machinegun', 'shotgun', 'grenade', 'rocket', 'lightning', 'rail', 'plasma'];
export const WEAPON_ORDER = [WEAPONS.GAUNTLET, WEAPONS.MACHINEGUN, WEAPONS.SHOTGUN, WEAPONS.ROCKET, WEAPONS.LIGHTNING, WEAPONS.RAIL, WEAPONS.PLASMA];

export const WEAPON_DEFS = {
  [WEAPONS.GAUNTLET]: { name: 'Gauntlet', key: 'gauntlet', damage: 50, refire: 400, range: 32, hitscan: true, melee: true, ammoStart: -1 },
  [WEAPONS.MACHINEGUN]: { name: 'Machinegun', key: 'machinegun', damage: 7, refire: 100, hitscan: true, spread: 200, range: 8192, ammoStart: 100, ammoPickup: 50, ammoMax: 200 },
  [WEAPONS.SHOTGUN]: { name: 'Shotgun', key: 'shotgun', damage: 10, pellets: 11, refire: 1000, hitscan: true, spread: 700, range: 8192, ammoStart: 10, ammoPickup: 10, ammoMax: 200 },
  [WEAPONS.ROCKET]: { name: 'Rocket Launcher', key: 'rocket', damage: 100, refire: 800, speed: 900, splashDamage: 100, splashRadius: 120, ammoStart: 10, ammoPickup: 5, ammoMax: 200, projectile: true },
  [WEAPONS.LIGHTNING]: { name: 'Lightning Gun', key: 'lightning', damage: 8, refire: 50, hitscan: true, range: 768, ammoStart: 60, ammoPickup: 60, ammoMax: 200 },
  [WEAPONS.RAIL]: { name: 'Railgun', key: 'rail', damage: 100, refire: 1500, hitscan: true, range: 8192, ammoStart: 10, ammoPickup: 10, ammoMax: 200 },
  [WEAPONS.PLASMA]: { name: 'Plasma Gun', key: 'plasma', damage: 20, refire: 100, speed: 2000, splashDamage: 15, splashRadius: 20, ammoStart: 50, ammoPickup: 30, ammoMax: 200, projectile: true },
};

export const WEAPON_DROP_TIME = 200;
export const WEAPON_RAISE_TIME = 250;
export const SELF_DAMAGE_SCALE = 0.5;
export const ARMOR_PROTECTION = 0.66;

export const HEALTH = { spawn: 125, max: 100, megaMax: 200, decayInterval: 1000 };
export const ARMOR = { max: 200, yellow: 50, red: 100 };

export const ITEMS = {
  mega: { kind: 'health', amount: 100, max: 200, respawn: 35000, label: 'Mega Health', major: true },
  health25: { kind: 'health', amount: 25, max: 100, respawn: 35000, label: 'Health +25' },
  health50: { kind: 'health', amount: 50, max: 100, respawn: 35000, label: 'Health +50' },
  health5: { kind: 'health', amount: 5, max: 200, respawn: 35000, label: 'Health +5' },
  armorRed: { kind: 'armor', amount: 100, max: 200, respawn: 25000, label: 'Red Armor', major: true },
  armorYellow: { kind: 'armor', amount: 50, max: 200, respawn: 25000, label: 'Yellow Armor' },
  armorShard: { kind: 'armor', amount: 5, max: 200, respawn: 25000, label: 'Armor Shard' },
  weaponRocket: { kind: 'weapon', weapon: WEAPONS.ROCKET, respawn: 5000, label: 'Rocket Launcher', major: true },
  weaponRail: { kind: 'weapon', weapon: WEAPONS.RAIL, respawn: 5000, label: 'Railgun', major: true },
  weaponLightning: { kind: 'weapon', weapon: WEAPONS.LIGHTNING, respawn: 5000, label: 'Lightning Gun', major: true },
  weaponShotgun: { kind: 'weapon', weapon: WEAPONS.SHOTGUN, respawn: 5000, label: 'Shotgun' },
  weaponPlasma: { kind: 'weapon', weapon: WEAPONS.PLASMA, respawn: 5000, label: 'Plasma Gun' },
  ammoRockets: { kind: 'ammo', weapon: WEAPONS.ROCKET, amount: 5, respawn: 40000, label: 'Rockets' },
  ammoSlugs: { kind: 'ammo', weapon: WEAPONS.RAIL, amount: 10, respawn: 40000, label: 'Slugs' },
  ammoCells: { kind: 'ammo', weapon: WEAPONS.LIGHTNING, amount: 60, respawn: 40000, label: 'Lightning Ammo' },
  ammoShells: { kind: 'ammo', weapon: WEAPONS.SHOTGUN, amount: 10, respawn: 40000, label: 'Shells' },
  ammoBullets: { kind: 'ammo', weapon: WEAPONS.MACHINEGUN, amount: 50, respawn: 40000, label: 'Bullets' },
  ammoPlasma: { kind: 'ammo', weapon: WEAPONS.PLASMA, amount: 30, respawn: 40000, label: 'Plasma Cells' },
};

// Q3 item bbox is 30x30x30 around origin (ITEM_RADIUS 15), and picks up when the player box touches it.
export const ITEM_HALF = 15;

// intermission: how long the end screen stays up before the next match starts by itself (same map) when nobody votes.
// Arena rounds: roundRest shows the round result (players frozen), then roundCountdown (fresh spawns, 3-2-1) before live.
export const MATCH = {
  duel: { timelimit: 10 * 60 * 1000, fraglimit: 0, respawnMin: 1700, respawnForce: 5000, warmup: 3000, intermission: 30000 },
  arena: { rounds: 10, roundTimelimit: 90 * 1000, respawnMin: 0, respawnForce: 0, roundRest: 2000, roundCountdown: 3000, warmup: 3000, intermission: 30000 },
};
// Practice bot difficulty tiers (menu labels -> Bot skill)
export const BOT_TIERS = { easy: 0.3, normal: 0.6, hard: 0.8, pro: 0.95 };

export const BUTTONS = { ATTACK: 1, JUMP: 2, CROUCH: 4, ZOOM: 8 };

export const LAG_COMP_MAX_MS = 250;
export const HISTORY_TICKS = 64;

export const EV = {
  FIRE: 1, HIT: 2, EXPLODE: 3, PICKUP: 4, PAIN: 5, DEATH: 6, RESPAWN: 7, JUMP: 8, LAND: 9, FOOTSTEP: 10,
  ITEM_RESPAWN: 11, RAIL_TRAIL: 12, BULLET_IMPACT: 13, JUMPPAD: 14, TELEPORT: 15, WEAPON_CHANGE: 16, NOAMMO: 17,
  MATCH_START: 18, MATCH_END: 19, ROUND_START: 20, ROUND_END: 21, GIB: 22, LG_HIT: 23, COUNTDOWN: 24, MAJOR_WARN: 25, FALL_DAMAGE: 26, STEP: 27,
};
