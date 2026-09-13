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
// physics: 'vq3' (vanilla bg_pmove) or 'cpm' (Challenge ProMode air control, see PHYSICS / CPM below); a match rule
// chosen by the host, sent in WELCOME/MAPCHANGE rules and honoured identically by the server and by client prediction.
export const MATCH = {
  duel: { timelimit: 10 * 60 * 1000, fraglimit: 0, respawnMin: 1700, respawnForce: 5000, warmup: 3000, intermission: 30000, physics: 'vq3' },
  arena: { rounds: 10, roundTimelimit: 90 * 1000, respawnMin: 0, respawnForce: 0, roundRest: 2000, roundCountdown: 3000, warmup: 3000, intermission: 30000, physics: 'vq3' },
};
export const PHYSICS = ['vq3', 'cpm'];
// CPM (Challenge ProMode Arena) air movement: pm_airaccelerate stays 1 for diagonal strafes, reversing direction uses
// cpm_airstopaccelerate, a sideways-only strafe caps the wish speed at cpm_airwishspeed with pm_strafeaccelerate, and a
// pure forward/back input steers the horizontal velocity toward the view (PM_Aircontrol, cpm_aircontrol). Ground
// acceleration and friction stay vq3.
export const CPM = { airstopaccelerate: 2.5, aircontrol: 150, airwishspeed: 30, strafeaccelerate: 70 };

// Player identity (menu Settings): a skin (the models live in client/render/playermodel.js; this list is what the
// session accepts in JOIN) and a colour from a Q3-like palette (color1): the model's stripe / visor emissive, the
// rail trail and the HUD name use it, so the opponent recognises you. Bots keep their name-derived skin and no colour.
export const PLAYER_SKINS = ['sarge', 'visor', 'anarki'];
export const PLAYER_COLORS = [
  { name: 'red', hex: 0xff3b3b }, { name: 'orange', hex: 0xff8a2a }, { name: 'yellow', hex: 0xffd23a }, { name: 'green', hex: 0x5cff6a },
  { name: 'cyan', hex: 0x3cf2ff }, { name: 'blue', hex: 0x4ab3ff }, { name: 'purple', hex: 0x9d5cff }, { name: 'magenta', hex: 0xff4ae0 }, { name: 'white', hex: 0xf4f6ff },
];
export const playerColorHex = (i, fallback) => (Number.isInteger(i) && PLAYER_COLORS[i] ? PLAYER_COLORS[i].hex : fallback);
// Practice bot difficulty tiers (menu labels -> Bot skill)
export const BOT_TIERS = { easy: 0.3, normal: 0.6, hard: 0.8, pro: 0.95 };

export const BUTTONS = { ATTACK: 1, JUMP: 2, CROUCH: 4, ZOOM: 8 };

export const LAG_COMP_MAX_MS = 250;
export const HISTORY_TICKS = 64;

export const EV = {
  FIRE: 1, HIT: 2, EXPLODE: 3, PICKUP: 4, PAIN: 5, DEATH: 6, RESPAWN: 7, JUMP: 8, LAND: 9, FOOTSTEP: 10,
  ITEM_RESPAWN: 11, RAIL_TRAIL: 12, BULLET_IMPACT: 13, JUMPPAD: 14, TELEPORT: 15, WEAPON_CHANGE: 16, NOAMMO: 17,
  MATCH_START: 18, MATCH_END: 19, ROUND_START: 20, ROUND_END: 21, GIB: 22, LG_HIT: 23, COUNTDOWN: 24, MAJOR_WARN: 25, FALL_DAMAGE: 26, STEP: 27,
  AWARD: 28, LEAD: 29, FRAGS_LEFT: 30, TIME_WARN: 31,   // announcer: medals (award: AWARDS), lead changes (status: taken/lost/tied), N frags left, N-minute warning
};

// Announcer medals (Q3 rewards): EXCELLENT two frags within CARNAGE_REWARD_TIME, IMPRESSIVE two consecutive rail hits,
// HUMILIATION a gauntlet frag, PERFECT an arena round won without taking damage.
export const AWARDS = { EXCELLENT: 'excellent', IMPRESSIVE: 'impressive', HUMILIATION: 'humiliation', PERFECT: 'perfect' };
export const CARNAGE_REWARD_TIME = 3000;   // ms, Q3 g_combat.c
export const TIME_WARNINGS = [5, 1];       // minutes left at which the announcer warns (timelimit modes)
