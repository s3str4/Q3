#!/usr/bin/env node
// Builds the sample packs (client/audio/sfx/ and the announcer in client/audio/voice/) from the OpenArena sound tree.
// OpenArena (https://openarena.ws, GPLv2) ships a complete Quake 3 style sound set with the same file layout as Q3's
// baseq3; this tool picks the files the game needs, converts them to 22050 Hz mono 16-bit PCM WAV *without changing
// their level* (the set is mastered as a whole, so the relative loudness of a rocket vs a footstep is the recordings'
// own) and writes a manifest the client loads with AudioEngine.loadSamples().
// Usage: node tools/sfx_build.mjs --src DIR   where DIR holds the extracted pk3 sound trees as DIR/<pak>/sound/...
//        (later paks override earlier ones: pak0 < pak2-players < pak6-misc < pak6-patch085 < pak6-patch088)
//        [--copying FILE] copies the GPL text next to the pack.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : []).filter(Boolean));
if (!args.src) { console.error('need --src DIR (extracted OpenArena sound trees)'); process.exit(2); }
const SRC = path.resolve(args.src);
const PAKS = ['pak0', 'pak2-players', 'pak6-misc', 'pak6-patch085', 'pak6-patch088'];
const SR = 22050;
const OUT_SFX = path.join(ROOT, 'client', 'audio', 'sfx');
const OUT_VOICE = path.join(ROOT, 'client', 'audio', 'voice');

// Game cue key -> OpenArena file(s) (several = random variant, as Q3 does for the machinegun and footsteps).
// Player body cues are per OpenArena model: our three skins map to sarge / smarine (visor) / tony (anarki).
const PLAYER_MODELS = { sarge: 'sarge', visor: 'smarine', anarki: 'tony' };
const SFX = {
  // weapons (fire)
  machinegunFire: ['weapons/machinegun/machgf1b', 'weapons/machinegun/machgf2b', 'weapons/machinegun/machgf3b', 'weapons/machinegun/machgf4b'],
  shotgunFire: ['weapons/shotgun/sshotf1b'],
  rocketFire: ['weapons/rocket/rocklf1a'],
  rocketLoop: ['weapons/rocket/rockfly'],
  railFire: ['weapons/railgun/railgf1a'],
  plasmaFire: ['weapons/plasma/hyprbf1a'],
  lightningLoop: ['weapons/lightning/lg_fire'],
  gauntletFire: ['weapons/melee/fstrun'],
  weaponChange: ['weapons/change'],
  noAmmo: ['weapons/noammo'],
  // impacts
  rocketExplode: ['weapons/rocket/rocklx1a'],
  plasmaExplode: ['weapons/plasma/plasmx1a'],
  railImpact: ['weapons/plasma/plasmx1a'],           // Q3 cg_weapons.c: the rail impact plays the plasma explosion sound
  bulletImpact: ['weapons/machinegun/ric1', 'weapons/machinegun/ric2', 'weapons/machinegun/ric3'],
  gauntletImpact: ['weapons/melee/fstatck'],
  lgHit: ['weapons/lightning/lg_hit', 'weapons/lightning/lg_hit2', 'weapons/lightning/lg_hit3'],
  // body
  land: ['player/land1'],
  gib: ['player/gibsplt1'],
  gibImpact: ['player/gibimp1', 'player/gibimp2', 'player/gibimp3'],
  fallDamage: ['player/sarge/fall1'],
  footstepPlate: ['player/footsteps/clank1', 'player/footsteps/clank2', 'player/footsteps/clank3', 'player/footsteps/clank4'],
  footstepGrate: ['player/footsteps/mech1', 'player/footsteps/mech2', 'player/footsteps/mech3', 'player/footsteps/mech4'],
  footstepStone: ['player/footsteps/step1', 'player/footsteps/step2', 'player/footsteps/step3', 'player/footsteps/step4'],
  footstepTrim: ['player/footsteps/boot1', 'player/footsteps/boot2', 'player/footsteps/boot3', 'player/footsteps/boot4'],
  // items
  pickupHealthSmall: ['items/n_health'], pickupHealth: ['items/s_health'], pickupHealthLarge: ['items/l_health'], pickupMega: ['items/m_health'],
  pickupShard: ['misc/ar1_pkup'], pickupArmor: ['misc/ar2_pkup'],
  pickupWeapon: ['misc/w_pkup'], pickupAmmo: ['misc/am_pkup'],
  itemRespawn: ['items/respawn1'],
  jumppad: ['world/jumppad'],
  teleportIn: ['world/telein'], teleportOut: ['world/teleout'],
  // feedback
  hit: ['feedback/hit'],
};
for (const [skin, model] of Object.entries(PLAYER_MODELS)) {
  SFX[`${skin}.jump`] = [`player/${model}/jump1`];
  for (const h of [25, 50, 75, 100]) SFX[`${skin}.pain${h}`] = [`player/${model}/pain${h}_1`];
  SFX[`${skin}.death`] = [`player/${model}/death1`, `player/${model}/death2`, `player/${model}/death3`];
  SFX[`${skin}.fall`] = [`player/${model}/fall1`];
  SFX[`${skin}.taunt`] = [`player/${model}/taunt`];
}
// announcer (same clip names as the TTS pack from tools/voice_build.mjs, so the client code does not change)
const VOICE = {
  prepare: 'feedback/prepare', three: 'feedback/three', two: 'feedback/two', one: 'feedback/one', fight: 'feedback/fight',
  excellent: 'feedback/excellent', impressive: 'feedback/impressive', humiliation: 'feedback/humiliation', perfect: 'feedback/perfect',
  taken_lead: 'feedback/takenlead', lost_lead: 'feedback/lostlead', tied_lead: 'feedback/tiedlead',
  one_minute: 'feedback/1_minute', five_minute: 'feedback/5_minute', one_frag: 'feedback/1_frag', two_frags: 'feedback/2_frags', three_frags: 'feedback/3_frags',
  sudden_death: 'feedback/sudden_death', you_win: 'feedback/voc_youwin', you_lose: 'feedback/voc_youlose',
};

// ---------- WAV in (8 / 16-bit PCM, any rate / channels) ----------
function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV');
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(p + 8), channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') { data = b.subarray(p + 8, Math.min(b.length, p + 8 + size)); }
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('missing fmt/data');
  if (fmt.tag !== 1 || (fmt.bits !== 16 && fmt.bits !== 8)) throw new Error(`unsupported format tag ${fmt.tag} / ${fmt.bits}-bit`);
  const bps = fmt.bits / 8, frames = Math.floor(data.length / bps / fmt.channels); const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { let s = 0; for (let c = 0; c < fmt.channels; c++) { const o = (i * fmt.channels + c) * bps; s += fmt.bits === 16 ? data.readInt16LE(o) / 32768 : (data[o] - 128) / 128; } out[i] = s / fmt.channels; }
  return { rate: fmt.rate, samples: out };
}
function writeWav(file, samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, b);
}
const resample = (x, from, to) => {
  if (from === to) return x;
  const f = from / to, n = Math.floor(x.length / f), out = new Float32Array(n);
  if (f > 1) { // downsampling: average the source span of each output sample (a cheap anti-alias)
    for (let i = 0; i < n; i++) { const a = i * f, b = Math.min(x.length, (i + 1) * f); let s = 0, c = 0; for (let j = Math.floor(a); j < b; j++) { s += x[j]; c++; } out[i] = c ? s / c : 0; }
  } else for (let i = 0; i < n; i++) { const s = i * f, j = Math.floor(s), t = s - j; out[i] = x[j] * (1 - t) + (x[Math.min(j + 1, x.length - 1)] || 0) * t; }
  return out;
};
function find(rel) {
  for (const pak of [...PAKS].reverse()) { const f = path.join(SRC, pak, 'sound', rel + '.wav'); if (fs.existsSync(f)) return f; }
  return null;
}
function convert(rel, outFile) {
  const src = find(rel); if (!src) return null;
  const { rate, samples } = readWav(src);
  const x = resample(samples, rate, SR);
  let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v));
  writeWav(outFile, x, SR);
  return { ms: Math.round(x.length / SR * 1000), peakDb: +(20 * Math.log10(Math.max(peak, 1e-6))).toFixed(1), src: path.relative(SRC, src).replace(/\\/g, '/') };
}

fs.mkdirSync(OUT_SFX, { recursive: true }); fs.mkdirSync(OUT_VOICE, { recursive: true });
let total = 0, missing = [];
const manifest = {};
for (const [key, rels] of Object.entries(SFX)) {
  const files = [];
  rels.forEach((rel, i) => {
    const name = rels.length > 1 ? `${key}_${i + 1}.wav` : `${key}.wav`;
    const r = convert(rel, path.join(OUT_SFX, name));
    if (!r) { missing.push(rel); return; }
    files.push({ file: name, ms: r.ms, peakDb: r.peakDb, src: r.src }); total += fs.statSync(path.join(OUT_SFX, name)).size;
  });
  if (files.length) manifest[key] = files;
}
fs.writeFileSync(path.join(OUT_SFX, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
// announcer: replaces the TTS pack files in place, same manifest shape as tools/voice_build.mjs
for (const f of fs.readdirSync(OUT_VOICE)) if (f.endsWith('.wav')) fs.unlinkSync(path.join(OUT_VOICE, f));
const vman = {};
for (const [name, rel] of Object.entries(VOICE)) {
  const r = convert(rel, path.join(OUT_VOICE, `${name}.wav`));
  if (!r) { missing.push(rel); continue; }
  vman[name] = { file: `${name}.wav`, ms: r.ms, src: r.src }; total += fs.statSync(path.join(OUT_VOICE, `${name}.wav`)).size;
}
fs.writeFileSync(path.join(OUT_VOICE, 'manifest.json'), JSON.stringify(vman, null, 1) + '\n');
// license + credits next to the files
if (args.copying) fs.copyFileSync(path.resolve(args.copying), path.join(OUT_SFX, 'COPYING'));
const credits = [];
for (const pak of PAKS) for (const rel of ['sound/feedback/credits.txt', 'sound/weapons/credits', 'sound/world/CREDITS', 'sound/player/sarge/credit', 'sound/player/smarine/credit', 'sound/player/tony/credit']) {
  const f = path.join(SRC, pak, rel); if (fs.existsSync(f)) credits.push(`--- ${rel} (${pak}) ---\n${fs.readFileSync(f, 'utf8').trim()}`);
}
fs.writeFileSync(path.join(OUT_SFX, 'CREDITS.txt'), `Sounds in this directory and in ../voice/ come from OpenArena 0.8.8 (https://openarena.ws), licensed under the GNU GPL v2 (see COPYING). Converted to 22050 Hz mono 16-bit by tools/sfx_build.mjs, levels unchanged.\n\n${credits.join('\n\n')}\n`);
console.log(`sfx: ${Object.keys(manifest).length} cues, ${Object.values(manifest).reduce((s, f) => s + f.length, 0)} files; voice: ${Object.keys(vman).length} clips; ${(total / 1024 / 1024).toFixed(1)} MB`);
if (missing.length) console.log('missing:', missing.join(', '));
