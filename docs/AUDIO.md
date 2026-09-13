# Audio: synthesized competitive sound design

Everything the client plays is generated at runtime with the Web Audio API (`client/audio/audio.js`). There are no
sample files and no third-party assets. The design target is the Quake 3 / CPMA standard: every cue is identifiable
blind, enemy information is never quieter than your own feedback **from any direction**, the whole map is audible, and
nothing ever clips.

All numbers below are measured, not estimated: `node tools/audio_measure.mjs` renders every cue through the real engine
(HRTF panner, buses, limiter) in an `OfflineAudioContext` inside headless Edge and asserts the rules (2252 checks). The
latest report is `.evidence/audio/measure.json`; `.evidence/audio/palette.png` is a waveform + spectrogram sheet of the
palette, `.evidence/audio/*.wav` are the rendered cues and `.evidence/audio/hrtf.json` the raw HRTF response table.
`node tools/audio_measure.mjs --live 25` plays a real practice match against a bot (arena mode: full loadout; the local
player aims at the bot) and samples the live engine, including a per-frame / per-tick audit of the damage coalescing, a
per-player audit of the pain debounce and of dropped cues (`.evidence/audio/live.json`).

## Signal chain

```
source(s) -> voice gain -> [low shelf @250 -> peaks @700 / 1.2k / 2.2k / 3.5k / 5.5k -> HRTF panner]  (world sounds only; gains by direction)
          -> category bus -> master gain -> limiter (-3 dBFS, 20:1, 1 ms / 100 ms) -> soft clipper (knee 0.6, ceiling 0.95) -> out
```

- Buses: `weapons`, `impacts`, `player` (own body cues), `enemy` (other players' body cues), `items`, `ui`, `ambient`.
  All bus gains are 1.0; loudness lives in the per-cue trims (`CUE_TRIM`) so the calibration is one table.
- Every cue is a *voice*: one gain node, an optional panner chain, and N scheduled sources. A voice records when its last
  source stops; `update()` disconnects voices past that time and `onended` does the same eagerly. `stats()` reports live
  voice/loop counts, the age of the oldest one-shot voice and created/killed/spatial/dropped counters; the measurement tool
  asserts the count returns to zero after every cue and the live run asserts no voice ever lives longer than 3 s.
- Loops (lightning beam per shooter, rocket flight per projectile, ambient bed) are voices flagged `loop`; they are
  stopped explicitly with a 30-60 ms fade. The lightning loop dies 150 ms after the last FIRE event for that player.
- Limiter: Chrome's `DynamicsCompressor` at threshold -3 dBFS, ratio 20, plus a tanh soft clipper (identity below
  -4.4 dBFS, never above -1 dBFS). Cues are trimmed so a single cue never reaches the threshold: the measured gain
  reduction on a point-blank rocket explosion is **0.05 dB** (rule: <= 4 dB, i.e. no pumping). The "stress mix"
  (explosion + shotgun + rail + heavy pain + hit tone + lightning + a second rocket fired at once) peaks at
  **-0.99 dBFS** with 4.8 dB of reduction.
- Randomness (footstep pitch, crackle timing, ring detune) uses a seedable generator so measurements are reproducible.
- Damage is voiced per tick, not per event. `shared/game.js` emits one `EV.HIT` (attacker) and one `EV.PAIN` (target)
  per shotgun pellet and per splash victim, so a point-blank shotgun blast arrives as 11 + 11 events in the same tick.
  `event()` queues HITs per attacker and PAINs per target (summing damage, keeping the final health); `update()` flushes
  the queues once per frame (or `event()` flushes an entry older than `COALESCE_WINDOW` = 16.7 ms if a frame is late),
  playing **one** `hitTone(total damage)` and **one** pain grunt, exactly like Q3/CPMA (cost: at most one frame, 8 ms at
  120 fps, of added latency on damage feedback). See "Damage coalescing" below.
- Pain grunts are additionally debounced per target like Q3 (`g_active.c P_DamageFeedback`: `pain_debounce_time =
  level.time + 700`): `PAIN_DEBOUNCE` = 700 ms. The first PAIN in a window is voiced at once; later PAINs inside the window
  are silent and only lower the health the next grunt is voiced with, so the tier still escalates (light -> heavy) on the
  next grunt. Hit tones are **not** debounced (CPMA: one per damage tick), so a lightning beam ticks 20 times a second in
  the attacker's ears while the victim grunts at most every 700 ms. A lethal PAIN arrives in the same tick as the DEATH:
  the pending grunt is cancelled (the death cry replaces it, as in Q3) and DEATH / RESPAWN reset the window so a freshly
  spawned player grunts immediately when hit. See "Pain debounce" below.

## Spatialization and attenuation

- `PannerNode`, `panningModel = 'HRTF'`, `distanceModel = 'inverse'`, `refDistance = 320`, `maxDistance = 3000`,
  `rolloffFactor = 1` for every world sound (gain = 320 / (320 + (d - 320)) beyond 320 units):
  0 dB up to 320 units, **-5.5 dB at 600**, **-13.4 dB at 1500**, -19.4 dB at 3000. Measured rail fire: -5.5 dB at
  600 and -13.4 dB at 1500 relative to 300 (rule: within +-3 dB of the model).
- Major item respawns use `refDistance = 1200` / `maxDistance = 8000` so they carry across the whole map
  (-9.9 dBFS at 1500 units, -15.9 dBFS at 3000). Minor respawns use `refDistance = 200`, `rolloffFactor = 1.5`
  (-38.6 dBFS at 1500: local only).
- Own cues (`local`) bypass the panner and play at full level. Spatial voices get `REMOTE_GAIN = 1.43` plus a
  **direction-aware EQ** that flattens Chrome's HRTF. The raw panner response was measured with sine tones at 100 units
  (`node tools/audio_measure.mjs --hrtf`, L / R RMS in dB relative to a direct connection, listener looking down +X):

  | Hz | front | back | left (L / R) | above | below |
  |---|---|---|---|---|---|
  | 125 | +3.2 | +0.6 | +3.2 / +1.2 | +2.5 | +1.9 |
  | 250 | +3.4 | +1.4 | +4.2 / +1.7 | +2.4 | +0.2 |
  | 500 | -1.8 | +0.2 | +4.0 / -1.3 | -2.2 | -0.2 |
  | 700 | -1.5 | -1.3 | +3.3 / -2.3 | -6.4 | -1.2 |
  | 1000 | -5.3 | -1.5 | +1.7 / -4.9 | -5.2 | -1.3 |
  | 1400 | -4.9 | -3.7 | -0.6 / -6.9 | -3.2 | -1.5 |
  | 2000 | +0.1 | -3.5 | -2.2 / -7.8 | -5.9 | -3.3 |
  | 2500 | -1.8 | -4.7 | -1.3 / -11.4 | -5.5 | -3.7 |
  | 3000 | -3.6 | -5.4 | -0.6 / -12.7 | -5.3 | -4.0 |
  | 3500 | -1.4 | -6.0 | -0.9 / -15.3 | -5.4 | -4.3 |
  | 4000 | -0.3 | -6.8 | -1.5 / -19.2 | -4.9 | -5.1 |
  | 5000 | -2.7 | -8.8 | +1.4 / -25.5 | -6.4 | -9.7 |
  | 6000 | -7.6 | -10.2 | +2.3 / -25.1 | -4.7 | -17.5 |
  | 8000 | -11.9 | -14.0 | -3.2 / -23.7 | -4.3 | -3.0 |

  Relative to the front, a source behind / above / below the listener loses another **4-6 dB in the 2-5 kHz band**, which
  is exactly where the locating cues live (footstep tap 3.2-4.5 kHz, machinegun crack, rail ring). Uncompensated, an enemy
  footstep 100 units behind you measured -17.4 dBFS against -14.1 for your own step (3.3 dB quieter); from the side the
  near ear is flat and the far ear gives 12-25 dB of interaural difference at 3-8 kHz.
- `HRTF_COMP` therefore holds one EQ setting per hemisphere on a shared cascade of six biquads, `bands` = low shelf @250 Hz,
  peaks @700 (Q 1.5) / 1200 (Q 1.0) / 2200 (Q 1.5) / 3500 (Q 1.0) / 5500 Hz (Q 1.5), plus a broadband gain. The gains are
  the **least-squares fit of the cascade to the inverse of the measured response** (binaural power mean of L and R, 125-6000 Hz,
  the 1-5 kHz locating band weighted 1.5x; `node tools/scratch/fit_comp.mjs` on `hrtf.json`), so the compensation follows
  the notches the earlier three-band, hand-set table straddled: 700 Hz and 2 kHz from above, 6 kHz from below, the 1 kHz dip
  in front. Fit residual (weighted rms): front 1.5 dB, back 0.55, side 0.53, above 0.44, below 1.4 (the front and the
  underside are jagged at 3-6 kHz; the front's 1.2 kHz band was then eased from the fitted +6.0 to +5.2 so the mid-heavy
  fires stay under the pre-limiter ceiling at point blank).

  | direction | shelf 250 | 700 | 1.2k | 2.2k | 3.5k | 5.5k | broadband | what it undoes |
  |---|---|---|---|---|---|---|---|---|
  | front | -4.9 | -0.5 | +5.2 | -1.7 | +0.3 | +3.9 | 0 | +3 dB bass hump, -5 dB dip at 1-1.4 kHz, -7.6 at 6 kHz |
  | back | -1.6 | -0.3 | +2.1 | +1.3 | +2.6 | +8.4 | 0 | broad 1.4-6 kHz loss (-3.7 .. -10 dB) |
  | side | -1.8 | -1.8 | +2.9 | +2.4 | +4.3 | +0.4 | -1.6 | near ear flat below 1 kHz, -3 .. -4.4 dB at 1.4-4 kHz |
  | above | -2.5 | +6.4 | +2.1 | +4.1 | +3.0 | +5.2 | -1.2 | -6.4 dB notch at 700 Hz, -5.9 at 2 kHz, -5 at 3-5 kHz |
  | below | -8.4 | -3.1 | -2.8 | +0.8 | -3.4 | +9.0 | +4.9 | bass hump, -1 .. -5 dB mids, -17.5 dB notch at 6 kHz (capped) |

  `dirComp(origin)` blends the five entries by the source direction in the listener's frame (front/back by the forward
  component, side by |right|, above/below by the up component, normalized so an axis-aligned source gets exactly its
  entry; diagonals get the mix). One-shot voices are set at creation; loops (lightning, rocket flight) are re-placed every
  frame, so a rocket passing overhead keeps its loudness. `REMOTE_GAIN` (1.43) sits on top as the margin that keeps every
  enemy cue >= the own cue in every direction. The measured result is the directional table below: every dual cue within
  +-2 dB(A) of its own front rendering from behind, left, right, above and below, at 100 and 600 units.
- Enemy footstep at 600 units to the right: L -25.6 / R -15.7 dBFS (9.9 dB ILD; rule >= 6 dB), peak -18.7 dBFS straight
  ahead (rule >= -30 dBFS); grating / stone / trim steps -17.9 / -19.0 / -18.5 with 8.5 / 7.8 / 7.4 dB of ILD. Footstep
  100 u behind **-13.4 dBFS** (rule >= -14.6), machinegun 100 u behind **-5.8 dBFS** (rule >= -7.8).
- Rocket flight loops are pitch-shifted by radial velocity (`SPEED_OF_SOUND = 3000` ups, factor clamped 0.6-1.6):
  a 900 ups rocket coming at you plays ~1.3x, going away ~0.77x.

## Origin resolution for body cues

Enemy JUMP / LAND / FOOTSTEP events carry no origin (they come from pmove); PAIN / DEATH / PICKUP / RESPAWN / JUMPPAD /
TELEPORT / FIRE carry one. For a remote player `originOf(id, cg)` tries, in order: the interpolated entity in
`cg.remote`, the local game state, the newest snapshot's player entry (a snapshot's events are dispatched before its
players are interpolated into `cg.remote`, so the join sequence lands here), and the last origin seen for that id in any
event. A remote body cue whose position still cannot be resolved is **dropped** (`counters.dropped`) instead of being voiced
non-spatially at own-cue level, which is what used to happen (a phantom step on top of you). Measured through the real
`event()` path: `EV.FOOTSTEP id 2` with an empty `cg.remote` -> 0 voices, dropped 1; with the player in `cg.remote` at
600 u -> 1 spatial voice at -19.4 dBFS (identical to the enemy@600 render); after a PAIN with an origin and the player gone
from `cg.remote` -> spatial at that last origin. In the live run 0 of 369 voices were dropped (the join used to drop 7
before the snapshot fallback existed); the live audit fails if any cue is dropped for a player present in `cg.remote`.

## Footsteps and landings by surface

FOOTSTEP / LAND events carry no surface (they come from pmove), so the engine resolves it at cue time: `surfaceAt(origin, cg)`
traces a 16-unit-wide box straight down from the player's feet (`PM.mins[2]` below the origin, up to 48 units further) through
`cg.game.world` with the player clip skipped, reads the hit brush's `mat` and maps it through `SURFACE_OF` (the material keys of
`client/render/materials.js`) to one of four families: **plate** (steel plates: `floor`, `metal`, `wall2`, `tech`, `ceiling`),
**grate** (`floor2`, `grate`), **stone** (`stone`, `concrete`, `wall`), **trim** (`trim*`, `jumppad`, `teleporter`, `glow_*`).
Nonsolid brushes (pads, lava, triggers) are invisible to the tracer, so the drawn floor under a pad decides; no world (menu,
offline tools) or no floor within reach (mid-air) falls back to plate. Own and enemy steps both use the floor under the
respective player (the enemy's interpolated origin). Each family has its own recipe (table below) and its own `CUE_TRIM`
so an enemy step is equally audible on every floor (all four calibrated to the same peak, asserted within +-1.5 dB), and
each land keeps its soft / hard tier. Measured through the real `event()` path on one-brush worlds (rule set "surface
resolution" in the tool): 11 materials -> the expected family, a jump pad over stone -> stone, a player clip over grating ->
grate, mid-air -> plate, no world -> plate, a remote hard LAND with an origin -> remote hard land on the grating.

## Palette

| Cue | Recipe | Identity |
|---|---|---|
| Machinegun | 12 ms highpass crack + 65 ms saturated 1.7 kHz body + 900 Hz layer + 200->90 Hz thump | tight tick, < 90 ms so 10 Hz fire stays crisp |
| Shotgun | saturated 1.3 kHz->350 Hz bandpass blast (drive 3) + 120->42 Hz boom + 900->200 Hz lowpass, two-click pump at +240/+310 ms | wide blast, then the pump |
| Rocket fire | ignition crack, saturated 500->2600 Hz rising whoosh (the identity), 95->36 Hz sine + 62 Hz triangle thump underneath | deep thump then rising whoosh |
| Rocket flight | bandpass 420 Hz noise wobbled at 17 Hz + 58 Hz sawtooth, spatialized, doppler | rumbling hiss following the missile |
| Rocket explosion | 66->28 Hz sine + 44 Hz triangle (drive 3), 2.5 kHz crack, 3 kHz->90 Hz body, 10 random crackle bursts, 1.5 s 350->70 Hz tail | sub impact, crackle, tail |
| Rail | 320->2800 Hz sawtooth charge whine (90 ms), crack, 1.8 kHz->500 Hz body, 130->48 Hz thump, 4 inharmonic ring partials (1180/1770/2650/3540 Hz, 0.5-0.8 s) | whine, crack, long ring |
| Lightning | 62 Hz sawtooth through a 9 Hz swept bandpass + 1350 Hz square with noise FM + highpass crackle gated at 41 Hz; hit: 4.5 kHz sizzle + 3200->1400 Hz chirp | continuous buzz with crackle |
| Plasma | 1150->330 Hz sine bloop (85 ms) + 580->220 Hz square + 4.5 kHz tick | rapid bloops |
| Gauntlet | saturated 550->800 Hz sawtooth whine with 38 Hz vibrato + 140 Hz sawtooth body + 3.2 kHz whir; world hit: 1400/2130 Hz clank | motor spin-up |
| Jump | formant grunt "hup" (200->150 Hz through 650/1150/2500 Hz -> 500/900/2300 Hz) | vocal, short |
| Land | soft: 70 ms 900->90 Hz thud + 120->45 Hz sine; hard: 160 ms thud + "oof" grunt (150->95 Hz) | soft vs hard clearly different |
| Footstep, steel plates (`floor`, `metal`, `wall2`, `tech`, `ceiling`) | 18 ms 3.2-4.5 kHz tap + 1.8 kHz click + quiet 500 Hz heel thud + 150-200->70 Hz sine + faint 1.1 / 2.4 kHz clank partials, pitch randomized | bright tap, located |
| Footstep, grating (`floor2`, `grate`) | 16 ms 3.6-4.9 kHz tap + 1350 / 2700 / 4100 Hz ring partials (50-90 ms, detuned per step), hardly any thud | ringing bars |
| Footstep, stone / concrete (`stone`, `concrete`, `wall`) | duller 2.4-3.3 kHz tap + 1.2 kHz grit + 900->200 Hz lowpass thud + 120-160->55 Hz sine | dull thud with grit |
| Footstep, trims / pads / light panels (`trim*`, `jumppad`, `teleporter`, `glow_*`) | 2.8-3.4 kHz tick at -7 dB + 1500->400 Hz muffled tap + 600->150 Hz thud | soft, muffled |
| Land per surface | the soft / hard body thud above plus the surface layer: plate = 1.1 / 2.4 kHz clank; grate = 1350 / 2700 / 4100 Hz ring (up to 210 ms) + 3-5 rattle bursts; stone = 1.3 kHz grit + 2.6 kHz crack + debris crackle; trim = muffled 1500->300 Hz slap | which floor you landed on |
| Pain x4 (Q3 pain100/75/50/25) | light (health >= 75): 180 ms, 250->190 Hz; mid (50-74): 260 ms, 228->165 Hz; heavy (25-49): 340 ms, 205->130 Hz with 16 Hz tremolo; critical (< 25): 480 ms, 165->95 Hz with 22 Hz tremolo | lower, longer and shakier as health drops |
| Death / gib | death: 750 ms groan 190->65 Hz with 12 Hz vibrato + body thud at 550 ms; gib: bubbling 1.1 kHz->180 Hz lowpass noise (drive), 90->40 Hz sine, 8 wet pops, short grunt | groan vs splat |
| Pickup health / mega | 880 then 1175 Hz sine "tink-tink"; mega: 660/880/1320 Hz triangle arpeggio + detuned 2640 Hz shimmer | rising two/three notes |
| Pickup armor | 3.5 kHz clink + 1500/2250/3700 Hz partials (x0.8 for red) + 440->660 Hz (yellow) or 330->495 Hz (red) triangle; shard: clink only | metallic |
| Pickup weapon | 900 Hz clack, 190->120 Hz square, 2.4 kHz clack, 260/390 Hz square "ka-chunk" | mechanical |
| Pickup ammo | two 1.9 kHz clicks 75 ms apart with 1400 Hz sine | "tk-tk" |
| Item respawn major | 220->1100 Hz sine bloom (0.5 s), 1650 Hz triangle, detuned 2200 Hz shimmer; armor adds 1500/2250 Hz partials, weapon adds the ka-chunk | bloom, map-wide |
| Item respawn minor | 90 ms 700->1000 Hz pip | local pip |
| Jump pad | 90->650 Hz sawtooth sweep + 600->3000 Hz noise sweep + 70 Hz sub | rising boing |
| Teleporter / spawn | six stacked detuned sines 300-1600 Hz staggered by 35 ms + 3000->300 Hz noise sweep | shimmer |
| Hit tones | CPMA style, 60 ms square + octave sine: 620 / 800 / 1000 / 1300 Hz for < 25 / 25-49 / 50-74 / >= 75 damage | pitch = damage |
| Weapon change / no ammo | 15 ms 2.5 kHz click + 160 Hz blip; no ammo: two 330 Hz square clicks 90 ms apart | dry clicks |
| Countdown / fight | 660 Hz beep per second; fight: 660/880/1320 Hz chord + noise hit | |
| Win / lose / overtime | rising C-E-G-C triangle arpeggio + chord / falling G-F-Eb-C detuned; overtime alert: two 520 Hz squares | |
| Ambient | lowpass 160 Hz noise + 48 Hz drone with 0.08 Hz LFO, **-40.1 dBFS RMS** | bed only |

## Announcer (voice pack)

`client/audio/voice/*.wav` + `manifest.json`, built by `tools/voice_build.mjs` (see the README section "Announcer and
voices" for the treatment). `AudioEngine.loadVoices()` fetches the manifest and decodes every clip once (relative to the
module, so the dev server and the static build both work); `announce(name, { delay, interrupt })` queues a line on the
`ui` bus at `ANNOUNCER_GAIN` (0.5: the clips are peak-normalized to -1 dBFS by the build, so that is -7 dBFS into the
limiter, about a nearby rocket explosion). Lines play one after another with `ANNOUNCER_GAP` (120 ms) between them, the
way Q3 stacks reward sounds; the countdown numbers and "fight" cut whatever is playing (`ANNOUNCER_INTERRUPT`). When a
clip is missing (fetch failed, voice pack not built) the synthesized cue plays instead: countdown beep, fight chord. The
pack is not part of the measured cue table because it is not synthesized. Body cues (jump, pain, death grunts) are
pitched per skin by `SKIN_VOICE_PITCH` (Sarge 0.88, Visor 1.0, Anarki 1.14; formants move by the square root of that).

## Loudness rules (asserted by `tools/audio_measure.mjs`, 2252 checks, all passing)

1. No clipping: every render (including all directional variants) peaks <= -0.5 dBFS; stress mix <= -0.3 dBFS
   (measured -1.07, 4.3 dB of reduction).
2. Limiter never pumps: rocket explosion gain reduction <= 4 dB (measured 0.1 dB).
3. Weapon fire consistency: the seven weapon fire cues peak within +-3 dB of their median, for own cues and for enemy
   cues at each distance (own: -7.4 to -9.4 dBFS; enemy at 0: -4.6 to -5.4 dBFS), and their A-weighted momentary levels
   agree within +-3 dB (own -15.3 to -18.9 dB(A)); MG/RG/SG/PG carry < 50 % of their energy below 300 Hz.
4. Pre-limiter headroom: every weapon fire peaks <= -6 dBFS before the limiter, own and point blank (enemy at 0:
   -6.3 to -7.1; the flattened front EQ lifts the mid-heavy LG and gauntlet 3-4 dB over their own versions, so their
   trims sit lower than the calibration mean).
5. Enemy >= own, every direction: for every cue with both variants the enemy version is never more than 0.5 dB below
   the own version at point blank straight ahead **and** at 100 units in the six directions front / back / left / right /
   above / below; at 600 units in the same six directions it is >= own + model (-5.46 dB) - 0.5. Measured minimum
   delta over all 396 directional renders: -0.2 dB (death from behind; last column of the directional table).
6. Directional overshoot: no direction is more than 4 dB louder (peak) than the same cue straight ahead (max measured
   +3.5 dB, grating step from below: the side and underside entries lift 2-4 kHz, where a tap's peak lives).
7. Enemy footsteps: >= -30 dBFS at 600 units (measured -18.7 / -17.9 / -19.0 / -18.5 for plate / grate / stone / trim)
   and >= 6 dB interaural difference from the side (9.9 / 8.5 / 7.8 / 7.4).
8. Major respawns map-wide (>= -24 dBFS at 1500, >= -30 at 3000; measured -9.9 / -15.9); minors >= 10 dB under majors
   at 1500 (measured 28.7 dB under).
9. Ambient <= -36 dBFS RMS and >= 12 dB under the quietest weapon at 1500 units (measured -40.1 vs -19.3).
10. Inverse distance model holds (+-3 dB) at 600 and 1500 units.
11. No zombie nodes: after every cue voices == 0, loops == 0 and created == killed; live run: no one-shot voice older
    than 3 s, `created == killed + live`.
12. Durations per cue within their budget (machinegun <= 120 ms, footstep <= 100 ms, hit tone <= 100 ms, explosion <= 2 s...).
13. Damage coalescing (raw game events through `event()` + the per-frame `update()`): 11 HIT(10) in one frame -> exactly
    1 voice; 11 HIT + 11 PAIN -> exactly 2 voices; the same 11 HIT in two frames 50 ms apart -> 2 voices; the coalesced
    tone is tier 4 (dominant 1300 Hz, and its 1300 Hz partial sits at the same level under the grunt as alone, >= 6 dB over
    the tier-0 620 Hz band); pre-limiter peak <= -8 dBFS; post-limiter peak within +-1 dB of a single hitTone4 (tone
    alone) or of the louder single cue (tone + grunt).
14. Origin resolution: an unresolvable remote footstep creates 0 voices (dropped 1); a resolvable one creates exactly one
    spatial voice at the enemy@600 level; a player known only from an earlier event is voiced at that last origin.
15. Pain debounce (raw events through `event()` + a 120 fps `update()` clock): 20 x PAIN(8) on enemy id 2 (100 u ahead) at
    50 ms spacing over 1 s -> exactly 2 grunts, the second 0.70 s (+-0.02) after the first, never more than one grunt alive
    at once, post-limiter peak within +-1 dB of a single enemy painLight at 100 u; the same stream for the local player
    (id 1) -> 2 grunts at own painLight level; health 95 -> 0 by 5 per tick -> the second grunt carries the lowest pending
    health (25, heavy tier); lethal PAIN + DEATH in one tick -> 1 voice (death cry), 0 grunts; PAIN, DEATH, RESPAWN + PAIN
    within 0.5 s -> 2 grunts (window reset); the full LG exchange (FIRE + PAIN + HIT + LG_HIT x 20) -> 20 hit tones and 2
    grunts for the attacker, 2 grunts for the victim. Live: per player `grunts <= ceil(span / 0.7) + 1` and within +-1 of
    what a 700 ms debounce on the PAIN arrival times predicts.
16. Directional loudness: for every dual cue the **binaural A-weighted momentary level** (`aMomB`: per-ear FFT, A-weighting,
    power mean of the two ears, max over 50 ms windows; the mono (L+R)/2 level under-reads a lateral source by 3-6 dB
    because the far ear is 7-25 dB down and the interaural delay comb-filters the sum) from behind, left, right, above and
    below is within **+-2 dB(A)** of the same cue straight ahead, at 100 u and at 600 u (33 cues x 10 = 330 checks; table
    below, worst deviation 1.7 dB; before the fitted compensation: rail +3.3 behind / +3.6 below, ammo +3.8 above, LG +3.3
    above, machinegun / mega -2.1 / -2.2 from the side).
17. Surface resolution: FOOTSTEP / LAND through `event()` on one-brush worlds voice the family of the floor under the player
    (11 materials, pad over stone, player clip over grating, mid-air, no world, remote hard LAND).
18. Surface families keep one loudness: `footstepGrate` / `Stone` / `Trim` own peaks within +-1.5 dB of `footstep`, each
    land family within +-1.5 dB of its plate tier, hard >= soft + 3 dB on every floor, and every family's enemy step is
    >= -30 dBFS at 600 u with >= 6 dB of interaural difference from the side.

## Damage coalescing (measured)

What the client hears for one full point-blank shotgun blast (11 pellets, 110 damage), offline through the real engine:

| render | voices | dominant Hz | 1300 Hz band | pre-limiter peak | post-limiter peak |
|---|---|---|---|---|---|
| 11 x HIT(10) per-event (old behaviour, 11 stacked tier-0 tones) | 11 | 620 | - | **+7.04 dBFS** (clipper engaged, whole mix pumped) | -1.05 |
| 11 x HIT(10) coalesced -> hitTone(110) | 1 | 1300 | -30.66 dB | -13.90 | **-12.19** (single hitTone4: -12.19) |
| 11 x HIT + 11 x PAIN coalesced -> tone + one light grunt at 100 u | 2 | 725 (grunt formant) | -30.28 dB | -9.78 | -8.07 (louder single cue, enemy painLight: -8.93) |
| 11 x HIT in frame A + 11 x HIT in frame B (+50 ms) | 2 | | | | |

## Pain debounce (measured)

What the listener hears during 1 s of lightning on one player (20 damage ticks 50 ms apart), offline through the real
engine with `update()` on a 120 fps clock (`.evidence/audio/pain_lg_debounced.wav`, `lg_exchange.wav`):

| stream (20 ticks in 1 s) | grunts | grunt times (s) | max grunts alive | pre-limiter peak | post-limiter peak |
|---|---|---|---|---|---|
| 20 x PAIN(8) on enemy at 100 u, per-event voicing (old behaviour) | 20 | every 0.05 | 11 | **+13.83 dBFS** (20 stacked grunts) | -4.33 |
| 20 x PAIN(8) on enemy at 100 u, debounced | **2** | 0.00, 0.70 | **1** | -10.64 | **-8.93** (single enemy painLight at 100 u: -8.93) |
| 20 x PAIN(8) on the local player, debounced | 2 | 0.00, 0.70 | 1 | | -11.06 (single own painLight: -11.06) |
| 20 x PAIN(5) health 95 -> 0 (tier escalation) | 2 | 0.00 (health 95, light), 0.70 (health 25, heavy) | 1 | | |
| lethal PAIN + DEATH in one tick | 0 (+ 1 death cry) | | | | |
| PAIN, DEATH at 0.3 s, RESPAWN + PAIN at 0.5 s | 2 | 0.00, 0.50 (window reset by the death) | 1 | | |
| LG exchange, attacker: own FIRE + PAIN + HIT + LG_HIT x 20 | 2 | 0.00, 0.70 | 1 | | -3.22 with **20 hit tones** (one per tick), 6 voices at most (was 61 voices, 16 at once, -2.35) |
| LG exchange, victim: enemy FIRE + own PAIN + LG_HIT x 20 | 2 | 0.00, 0.70 | 1 | | -3.83, 4 voices at most (was 41 voices, 14 at once, -2.26) |

Live (`node tools/audio_measure.mjs --live 25 --port 27983`, arena mode, the local player aims at the bot and switches
to the shotgun inside 900 units): context `running` at 48 kHz (base latency 10 ms), 19 voices at most, oldest one-shot
voice 1.27 s, final created 362 = killed 357 + 5 live (262 of them spatial), 1 loop (the bot's lightning beam during the
idle window), dropped 0; 40 local shotgun HIT events in 5 bursts (up to 11 per frame) -> exactly **5 hit tones**; PAIN
per player: bot 52 events over 18.75 s -> **7 grunts** (a 700 ms debounce on the arrival times predicts 7; cap 28), local
player 40 events over 11.62 s -> **3 grunts** (predicted 4, +-1; cap 18); events heard: FIRE 117, HIT 92, PAIN 92,
FOOTSTEP 89, JUMP 10, LAND 12, LG_HIT 103, BULLET_IMPACT 82, WEAPON_CHANGE 23, DEATH 2, RESPAWN 6, EXPLODE 2.

## Measured table (peak dBFS at the listener, master volume 1.0)

`own` is the non-spatial local version; `enemy` is the HRTF-spatialized version at the given distance in units
(straight ahead). Duration is the -60 dBFS span of the own (or point-blank enemy) render.

| Cue | own @0 | enemy @0 | @300 | @600 | @1500 | dur (s) | RMS own/enemy@0 |
|---|---|---|---|---|---|---|---|
| machinegunFire | -7.3 | -5.7 | -5.7 | -11.2 | -19.1 | 0.062 | -18.1 / -16.4 |
| shotgunFire | -8.1 | -4.9 | -4.9 | -10.4 | -18.3 | 0.342 | -20.8 / -18.9 |
| rocketFire | -7.9 | -5.1 | -5.1 | -10.6 | -18.5 | 0.38 | -19.9 / -18.0 |
| railFire | -7.1 | -5.9 | -5.9 | -11.4 | -19.3 | 0.756 | -19.5 / -18.8 |
| plasmaFire | -8.1 | -4.9 | -4.9 | -10.3 | -18.3 | 0.078 | -17.5 / -14.1 |
| gauntletFire | -6.9 | -4.5 | -4.5 | -10.0 | -18.0 | 0.19 | -17.1 / -14.4 |
| lightningLoop | -7.2 | -5.3 | -5.3 | -10.8 | -18.7 | 0.64 | -16.2 / -17.0 |
| rocketLoop | - | -14.0 | -14.0 | -19.4 | -27.4 | 0.629 | - / -26.3 |
| rocketExplode | - | -3.0 | -3.0 | -8.4 | -16.4 | 0.83 | - / -22.2 |
| plasmaExplode | - | -12.0 | -12.0 | -17.5 | -25.4 | 0.048 | - / -27.8 |
| bulletImpact | - | -16.0 | -16.0 | -21.4 | -29.4 | 0.024 | - / -32.7 |
| railImpact | - | -10.0 | -10.0 | -15.5 | -23.4 | 0.218 | - / -29.9 |
| gauntletImpact | - | -14.0 | -14.0 | -19.5 | -27.4 | 0.085 | - / -29.8 |
| lgHit | - | -14.0 | -14.0 | -19.5 | -27.4 | 0.043 | - / -30.5 |
| jump | -15.0 | -13.0 | -13.0 | -18.5 | -26.4 | 0.103 | -32.7 / -30.4 |
| landSoft (plate) | -16.9 | -14.7 | -14.7 | -20.1 | -28.1 | 0.059 | -28.0 / -26.1 |
| landHard (plate) | -11.1 | -8.4 | -8.4 | -13.9 | -21.8 | 0.153 | -24.3 / -25.1 |
| landSoftGrate / landHardGrate | -17.5 / -11.2 | -14.0 / -8.4 | | -19.4 / -13.8 | -27.4 / -21.8 | 0.079 / 0.159 | |
| landSoftStone / landHardStone | -17.0 / -11.1 | -14.4 / -8.4 | | -19.9 / -13.8 | -27.8 / -21.8 | 0.067 / 0.159 | |
| landSoftTrim / landHardTrim | -17.0 / -11.5 | -14.5 / -8.0 | | -20.0 / -13.5 | -27.9 / -21.4 | 0.059 / 0.155 | |
| footstep (plate) | -14.3 | -13.3 | -13.3 | -18.7 | -26.7 | 0.027 | -31.5 / -29.6 |
| footstepGrate | -15.0 | -12.4 | -12.4 | -17.9 | -25.8 | 0.06 | -32.7 / -30.7 |
| footstepStone | -13.9 | -13.6 | -13.6 | -19.0 | -27.0 | 0.028 | -29.3 / -28.3 |
| footstepTrim | -14.5 | -13.0 | -13.0 | -18.5 | -26.4 | 0.028 | -31.7 / -29.3 |
| painLight | -11.1 | -8.9 | -8.9 | -14.4 | -22.4 | 0.142 | -29.6 / -26.6 |
| painMid | -10.8 | -8.3 | -8.3 | -13.7 | -21.7 | 0.206 | -28.6 / -25.7 |
| painHeavy | -10.6 | -7.5 | -7.5 | -12.9 | -20.9 | 0.266 | -28.9 / -26.3 |
| painCritical | -9.3 | -6.6 | -6.6 | -12.1 | -20.1 | 0.378 | -29.2 / -26.8 |
| death | -8.3 | -7.7 | -7.7 | -13.1 | -21.1 | 0.678 | -27.0 / -25.5 |
| gib | -9.0 | -3.0 | -3.0 | -8.4 | -16.4 | 0.359 | -21.5 / -20.5 |
| pickupHealth | -13.2 | -10.8 | -10.8 | -16.3 | -24.2 | 0.177 | -27.6 / -25.5 |
| pickupMega | -11.1 | -8.9 | -8.9 | -14.3 | -22.3 | 0.604 | -26.3 / -23.4 |
| pickupArmor | -12.7 | -11.3 | -11.3 | -16.7 | -24.7 | 0.278 | -30.1 / -27.5 |
| pickupWeapon | -13.1 | -8.9 | -8.9 | -14.4 | -22.4 | 0.215 | -26.9 / -22.9 |
| pickupAmmo | -14.5 | -13.4 | -13.4 | -18.9 | -26.9 | 0.105 | -31.9 / -31.2 |
| respawnMajor | - | -8.0 | -8.0 | -8.0 | -9.9 / -15.9 @3000 | 0.832 | - / -22.6 |
| respawnMinor | - | -18.0 | -22.8 | -30.0 | -38.6 / -44.8 @3000 | 0.062 | - / -29.9 |
| jumppad | -10.8 | -9.2 | -9.2 | -14.7 | -22.6 | 0.261 | -26.9 / -25.6 |
| teleport | -11.6 | -8.4 | -8.4 | -13.8 | -21.8 | 0.497 | -24.6 / -21.9 |
| hitTone1..4 | -12.1 / -11.7 / -11.7 / -12.2 | - | - | - | - | 0.046 | -25.6 / - |
| weaponChange | -20.0 | - | - | - | - | 0.059 | -33.4 / - |
| noAmmo | -18.0 | - | - | - | - | 0.104 | -33.2 / - |
| countdown | -12.0 | - | - | - | - | 0.12 | -17.6 / - |
| fight | -10.0 | - | - | - | - | 0.387 | -22.4 / - |
| win | -10.0 | - | - | - | - | 1.222 | -26.4 / - |
| lose | -10.0 | - | - | - | - | 0.831 | -22.8 / - |
| alert | -12.0 | - | - | - | - | 0.288 | -17.5 / - |
| ambient bed | peak -34.2, RMS -40.1 | | | | | continuous | |

## Measured directional table (binaural dB(A), 100 units; deltas vs the same cue straight ahead)

Rule 16: every delta within +-2 dB(A) at 100 u and at 600 u (the 600 u deltas equal these within 0.1 dB, so only the 600 u front level is listed). `own` is the peak of the non-spatial version, `front` the binaural A-weighted momentary level of the enemy version straight ahead; the last column is the peak margin rule 5 asserts, min over the six directions of enemy peak minus own peak (>= -0.5).

| Cue | own (dBFS) | front @100 (dB(A)) | back | left | right | above | below | front @600 | min peak margin |
|---|---|---|---|---|---|---|---|---|---|
| machinegunFire | -7.38 | -12.56 | -0.5 | -0.3 | -0.3 | -0.5 | +0.4 | -18.02 | +1.6 |
| shotgunFire | -7.68 | -12.91 | -0.3 | -0.1 | -0.1 | -0.2 | +0.5 | -18.37 | +2.9 |
| rocketFire | -7.67 | -13 | -0.3 | -0.3 | -0.3 | -0.3 | +0.2 | -18.46 | +2.8 |
| railFire | -7.59 | -13.02 | +0.5 | +0.8 | +0.8 | +0.0 | +0.9 | -18.48 | +2.7 |
| plasmaFire | -7.95 | -11.06 | -0.6 | -1.1 | -1.1 | -1.4 | -1.1 | -16.52 | +2.3 |
| gauntletFire | -8.56 | -14.69 | -0.1 | +0.2 | +0.2 | +0.5 | +0.6 | -20.15 | +3.2 |
| lightningLoop | -9.35 | -16.26 | -0.3 | -0.3 | -0.3 | +0.4 | +1.1 | -21.71 | +1.5 |
| jump | -14.89 | -25.53 | +0.4 | +0.6 | +0.6 | +0.9 | +1.1 | -30.99 | +2.3 |
| landSoft | -16.91 | -33.87 | +1.1 | +0.9 | +0.9 | +0.8 | +0.8 | -39.3 | +2.3 |
| landHard | -11.09 | -25.58 | +1.6 | +1.3 | +1.3 | +1.2 | +1.1 | -31.04 | +2.5 |
| footstep | -14.29 | -28.64 | +0.1 | +0.2 | +0.2 | +0.1 | +0.8 | -34.11 | +0.9 |
| footstepGrate | -15.04 | -25.21 | +0.4 | +0.5 | +0.5 | +0.7 | +0.8 | -30.67 | +1.6 |
| footstepStone | -13.88 | -31.07 | -0.4 | -0.1 | -0.1 | -0.2 | +0.8 | -36.56 | -0.1 |
| footstepTrim | -14.51 | -31.64 | -0.0 | +0.2 | +0.2 | -0.0 | +0.6 | -37.11 | +1.2 |
| landSoftGrate | -17.48 | -31.58 | +0.3 | +0.3 | +0.3 | +0.5 | +0.4 | -37 | +3.4 |
| landHardGrate | -11.15 | -22.41 | +0.3 | +0.3 | +0.3 | +0.7 | +0.5 | -27.87 | +2.8 |
| landSoftStone | -17.03 | -35.52 | +0.2 | +0.1 | +0.1 | +0.1 | +0.3 | -40.94 | +2.6 |
| landHardStone | -11.12 | -29.55 | -0.1 | -0.1 | -0.1 | -0.1 | +0.4 | -34.99 | +2.6 |
| landSoftTrim | -17.02 | -35.96 | +0.2 | +0.1 | +0.1 | +0.1 | +0.1 | -41.36 | +2.5 |
| landHardTrim | -11.54 | -30.73 | -0.3 | -0.2 | -0.2 | -0.1 | -0.1 | -36.22 | +3.4 |
| painLight | -11.12 | -20.52 | -0.2 | -0.2 | -0.2 | -0.1 | -0.0 | -25.99 | +2.7 |
| painMid | -10.66 | -19.11 | -0.1 | +0.0 | +0.0 | +0.4 | +0.0 | -24.54 | +2.6 |
| painHeavy | -10.18 | -18.84 | +0.2 | +0.6 | +0.6 | +0.9 | +0.7 | -24.33 | +2.8 |
| painCritical | -9.21 | -18.96 | +0.1 | +0.3 | +0.3 | +0.2 | +0.7 | -24.41 | +2.6 |
| death | -8.13 | -19.68 | +0.2 | +0.4 | +0.4 | +0.6 | +0.9 | -25.15 | -0.2 |
| gib | -8.31 | -21.3 | -0.3 | -0.4 | -0.4 | -0.3 | -0.2 | -26.76 | +4.9 |
| pickupHealth | -13.19 | -18.14 | +0.5 | +0.7 | +0.7 | +0.2 | +0.5 | -23.6 | +2.7 |
| pickupMega | -11.54 | -15.5 | -1.0 | -1.2 | -1.2 | -0.6 | -1.0 | -20.96 | +2.4 |
| pickupArmor | -12.96 | -22.34 | +0.4 | +0.6 | +0.6 | +0.2 | +0.8 | -27.8 | +2.4 |
| pickupWeapon | -12.42 | -21.98 | -0.5 | -0.6 | -0.6 | -0.4 | -0.3 | -27.42 | +3.3 |
| pickupAmmo | -15.21 | -24.73 | -0.4 | -0.1 | -0.1 | +0.5 | +0.3 | -30.2 | +2.9 |
| jumppad | -10.12 | -25.07 | -0.2 | -0.1 | -0.1 | -0.1 | +0.2 | -30.53 | +0.7 |
| teleport | -11.36 | -16.73 | +0.4 | +0.0 | +0.0 | +0.7 | +0.3 | -22.18 | +3.2 |

## Recalibrating

Change a recipe, then run `node tools/audio_measure.mjs --calibrate`: it prints a `CUE_TRIM` table that moves every
cue to its target peak (weapons -6.5, explosion -3, pain -8..-10, hit tones -12, UI clicks -18..-20, ambient -40 RMS)
and a `REMOTE_GAIN` suggestion. Paste, rerun without `--calibrate`; the run exits non-zero if a rule breaks. Use
`--only rail,footstep` while iterating on a cue (add `--dirs` to include the six-direction renders and the per-direction
"vs own" and "dB(A) vs front" summary lines) and `--limiter off` to see pre-limiter levels. `HRTF_COMP` is not hand-tuned:
if Chrome's HRTF changes, `--hrtf` re-measures the raw panner, `node tools/scratch/fit_comp.mjs` refits the band gains to
it, and `--comp '{"back":[...]}'` tries a table for one run without editing the engine. The front entry is part of the trim
calibration (pre-limiter headroom is measured straight ahead), so a refit is followed by `--calibrate`; the other four only
have to keep every cue inside [own - 0.5, front + 4] on peak and within +-2 dB(A) of the front binaurally.

Two Chrome quirks the tool works around: `DynamicsCompressor` starts a fresh context with its gain ramped down (about
12 dB loss on a burst at t = 0, settled by 200 ms), so cues are triggered at 0.25 s; and its automatic makeup gain
(+1.7 dB at this threshold/ratio) is measured with a probe tone and subtracted when computing gain reduction.

## Runtime API (used by `client/main.js`)

`new AudioEngine({ context?, ambient?, limiter?, seed? })`, `init(opts?)`, `resume()`, `setVolume(v)`,
`updateListener(eye, angles)`, `event(e, cg, predicted)`, `update(cg, now)`, `close()`, `stats()`,
`cue(name, { origin, local, id, velocity })` (the named cue table used by the measurement tool), `flushDamage()` (voices
the queued HIT/PAIN cues through the per-target pain debounce; called by `update()` every frame), `pain(origin, local,
health, id)` (id is only there for the live audit's per-player instrumentation), `footstep(origin, local, surface)` /
`land(origin, local, hard, surface)` with `surface` one of `SURFACES` (`plate`, `grate`, `stone`, `trim`), and
`surfaceAt(origin, cg)` (the down-trace through `cg.game.world`, `SURFACE_OF` maps material names to families). Events come
straight from `shared/game.js`; the engine reads `cg.localId`, `cg.remote`, `cg.game` (players and `world.brushes`),
`cg.snapshots` and `cg.remoteProjectiles` (all read-only) to place cues that carry no origin, to name the floor under a step
and to follow rockets in flight.
