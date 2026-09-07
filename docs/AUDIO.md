# Audio: synthesized competitive sound design

Everything the client plays is generated at runtime with the Web Audio API (`client/audio/audio.js`). There are no
sample files and no third-party assets. The design target is the Quake 3 / CPMA standard: every cue is identifiable
blind, enemy information is never quieter than your own feedback, the whole map is audible, and nothing ever clips.

All numbers below are measured, not estimated: `node tools/audio_measure.mjs` renders every cue through the real engine
(HRTF panner, buses, limiter) in an `OfflineAudioContext` inside headless Edge and asserts the rules. The latest report
is `.evidence/audio/measure.json`; `.evidence/audio/palette.png` is a waveform + spectrogram sheet of the palette and
`.evidence/audio/*.wav` are the rendered cues. `node tools/audio_measure.mjs --live 25` plays a real practice match
against a bot (arena mode: full loadout; the local player aims at the bot) and samples the live engine, including a
per-frame / per-tick audit of the damage coalescing (`.evidence/audio/live.json`).

## Signal chain

```
source(s) -> voice gain -> [low shelf -3 dB @250 | peak +4 dB @1k -> HRTF panner]  (world sounds only)
          -> category bus -> master gain -> limiter (-3 dBFS, 20:1, 1 ms / 100 ms) -> soft clipper (knee 0.6, ceiling 0.95) -> out
```

- Buses: `weapons`, `impacts`, `player` (own body cues), `enemy` (other players' body cues), `items`, `ui`, `ambient`.
  All bus gains are 1.0; loudness lives in the per-cue trims (`CUE_TRIM`) so the calibration is one table.
- Every cue is a *voice*: one gain node, an optional panner chain, and N scheduled sources. A voice records when its last
  source stops; `update()` disconnects voices past that time and `onended` does the same eagerly. `stats()` reports live
  voice/loop counts, the age of the oldest one-shot voice and created/killed counters; the measurement tool asserts the
  count returns to zero after every cue and the live run asserts no voice ever lives longer than 3 s.
- Loops (lightning beam per shooter, rocket flight per projectile, ambient bed) are voices flagged `loop`; they are
  stopped explicitly with a 30-60 ms fade. The lightning loop dies 150 ms after the last FIRE event for that player.
- Limiter: Chrome's `DynamicsCompressor` at threshold -3 dBFS, ratio 20, plus a tanh soft clipper (identity below
  -4.4 dBFS, never above -1 dBFS). Cues are trimmed so a single cue never reaches the threshold: the measured gain
  reduction on a point-blank rocket explosion is **0.07 dB** (rule: <= 4 dB, i.e. no pumping). The "stress mix"
  (explosion + shotgun + rail + heavy pain + hit tone + lightning + a second rocket fired at once) peaks at
  **-1.27 dBFS** with 4.1 dB of reduction.
- Randomness (footstep pitch, crackle timing, ring detune) uses a seedable generator so measurements are reproducible.
- Damage is voiced per tick, not per event. `shared/game.js` emits one `EV.HIT` (attacker) and one `EV.PAIN` (target)
  per shotgun pellet and per splash victim, so a point-blank shotgun blast arrives as 11 + 11 events in the same tick.
  `event()` queues HITs per attacker and PAINs per target (summing damage, keeping the final health); `update()` flushes
  the queues once per frame (or `event()` flushes an entry older than `COALESCE_WINDOW` = 16.7 ms if a frame is late),
  playing **one** `hitTone(total damage)` and **one** pain grunt, exactly like Q3/CPMA (cost: at most one frame, 8 ms at
  120 fps, of added latency on damage feedback). See "Damage coalescing" below.

## Spatialization and attenuation

- `PannerNode`, `panningModel = 'HRTF'`, `distanceModel = 'inverse'`, `refDistance = 320`, `maxDistance = 3000`,
  `rolloffFactor = 1` for every world sound (gain = 320 / (320 + (d - 320)) beyond 320 units):
  0 dB up to 320 units, **-5.5 dB at 600**, **-13.4 dB at 1500**, -19.4 dB at 3000. Measured rail fire: -5.5 dB at
  600 and -13.4 dB at 1500 relative to 300 (rule: within +-3 dB of the model).
- Major item respawns use `refDistance = 1200` / `maxDistance = 8000` so they carry across the whole map
  (-9.6 dBFS at 1500 units, -15.6 dBFS at 3000). Minor respawns use `refDistance = 200`, `rolloffFactor = 1.5`
  (-38 dBFS at 1500: local only).
- Own cues (`local`) bypass the panner and play at full level. Spatial voices get `REMOTE_GAIN = 1.35` plus an EQ that
  flattens Chrome's frontal HRTF, which was measured with `OfflineAudioContext` probes (front / right / back, RMS
  relative to a direct connection):

  | Hz | front | right ear L / R | ILD right | back |
  |---|---|---|---|---|
  | 150 | +3.8 | +1.9 / +4.0 | 2.1 | +1.5 |
  | 300 | +2.6 | +0.9 / +3.7 | 2.8 | +0.3 |
  | 600 | -2.0 | -2.0 / +4.0 | 5.9 | -0.9 |
  | 1000 | -5.3 | -4.9 / +1.7 | 6.6 | -1.5 |
  | 2000 | +0.1 | -7.9 / -2.2 | 5.7 | -3.5 |
  | 3000 | -3.6 | -12.7 / -0.6 | 12.0 | -5.4 |
  | 4000 | -0.3 | -19.2 / -1.5 | 17.7 | -6.8 |
  | 8000 | -11.9 | -23.7 / -3.2 | 20.4 | -14.0 |

  Consequences baked into the design: a -3 dB low shelf at 250 Hz and a +4 dB peak at 1 kHz on spatial voices (so
  enemy rockets are not 6 dB louder than yours while enemy plasma is quieter), and footsteps carry their locating
  energy at 3-4.5 kHz where the interaural difference is 12-18 dB. Measured enemy footstep at 600 units to the
  right: L -25.7 / R -17.0 dBFS (8.6 dB ILD; rule >= 6 dB), peak -19.2 dBFS straight ahead (rule >= -30 dBFS).
- Rocket flight loops are pitch-shifted by radial velocity (`SPEED_OF_SOUND = 3000` ups, factor clamped 0.6-1.6):
  a 900 ups rocket coming at you plays ~1.3x, going away ~0.77x.

## Palette

| Cue | Recipe | Identity |
|---|---|---|
| Machinegun | 12 ms highpass crack + 50 ms 1.5 kHz body + 220->80 Hz thump through tanh drive | tight tick, < 80 ms so 10 Hz fire stays crisp |
| Shotgun | 3.8 kHz->140 Hz lowpass noise blast (drive 3) + 130->42 Hz boom, two-click pump at +380/+500 ms | wide blast, then the pump |
| Rocket fire | 95->36 Hz sine + 62 Hz triangle through drive, ignition crack, 450->2400 Hz whoosh with 50 ms attack | deep thump then rising whoosh |
| Rocket flight | bandpass 420 Hz noise wobbled at 17 Hz + 58 Hz sawtooth, spatialized, doppler | rumbling hiss following the missile |
| Rocket explosion | 66->28 Hz sine + 44 Hz triangle (drive 3), 2.5 kHz crack, 3 kHz->90 Hz body, 10 random crackle bursts, 1.5 s 350->70 Hz tail | sub impact, crackle, tail |
| Rail | 320->2800 Hz sawtooth charge whine (90 ms), crack, 1.3 kHz->250 Hz body, 130->48 Hz thump, 4 inharmonic ring partials (1180/1770/2650/3540 Hz, 0.55-0.9 s) | whine, crack, long ring |
| Lightning | 62 Hz sawtooth through a 9 Hz swept bandpass + 1350 Hz square with noise FM + highpass crackle gated at 41 Hz; hit: 4.5 kHz sizzle + 3200->1400 Hz chirp | continuous buzz with crackle |
| Plasma | 1150->320 Hz sine bloop (80 ms) + 580->200 Hz square + 4.5 kHz tick | rapid bloops |
| Gauntlet | 110->170 Hz sawtooth with 38 Hz vibrato + 440->660 Hz square + 3.2 kHz whir; world hit: 1400/2130 Hz clank | motor spin-up |
| Jump | formant grunt "hup" (200->150 Hz through 650/1150/2500 Hz -> 500/900/2300 Hz) | vocal, short |
| Land | soft: 60 ms 900->90 Hz thud + 120->45 Hz sine; hard: 160 ms thud + "oof" grunt (150->95 Hz) | soft vs hard clearly different |
| Footstep | 18 ms 3.2-4.5 kHz tap + 1.8 kHz click + quiet 500 Hz heel thud + 150-200->70 Hz sine, pitch randomized | bright tap, located |
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

## Loudness rules (asserted by `tools/audio_measure.mjs`, 462 checks, all passing)

1. No clipping: every render peaks <= -0.5 dBFS; stress mix <= -0.3 dBFS.
2. Limiter never pumps: rocket explosion gain reduction <= 4 dB (measured 0.07 dB).
3. Weapon fire consistency: the seven weapon fire cues peak within +-3 dB of their median, for own cues and for enemy
   cues at each distance (own: -5.9 to -8.2 dBFS; enemy at 0: -3.5 to -5.8 dBFS).
4. Enemy >= own: for every cue with both variants the enemy version at point blank is never more than 0.5 dB below the
   own version (measured minimum delta +0.2 dB, most are +1 to +5 dB).
5. Enemy footsteps: >= -30 dBFS at 600 units (measured -19.2) and >= 6 dB interaural difference from the side (8.6).
6. Major respawns map-wide (>= -24 dBFS at 1500, >= -30 at 3000; measured -9.6 / -15.6); minors >= 10 dB under majors
   at 1500 (measured 28.7 dB under).
7. Ambient <= -36 dBFS RMS and >= 12 dB under the quietest weapon at 1500 units (measured -40.1 vs -19.2).
8. Inverse distance model holds (+-3 dB) at 600 and 1500 units.
9. No zombie nodes: after every cue voices == 0, loops == 0 and created == killed; live run: no one-shot voice older
   than 3 s, `created == killed + live`.
10. Durations per cue within their budget (machinegun <= 120 ms, footstep <= 100 ms, hit tone <= 100 ms, explosion <= 2 s...).
11. Damage coalescing (raw game events through `event()` + the per-frame `update()`): 11 HIT(10) in one frame -> exactly
    1 voice; 11 HIT + 11 PAIN -> exactly 2 voices; the same 11 HIT in two frames 50 ms apart -> 2 voices; the coalesced
    tone is tier 4 (dominant 1300 Hz, and its 1300 Hz partial sits at the same level under the grunt as alone, >= 6 dB over
    the tier-0 620 Hz band); pre-limiter peak <= -8 dBFS; post-limiter peak within +-1 dB of a single hitTone4 (tone
    alone) or of the louder single cue (tone + grunt).

## Damage coalescing (measured)

What the client hears for one full point-blank shotgun blast (11 pellets, 110 damage), offline through the real engine:

| render | voices | dominant Hz | 1300 Hz band | pre-limiter peak | post-limiter peak |
|---|---|---|---|---|---|
| 11 x HIT(10) per-event (old behaviour, 11 stacked tier-0 tones) | 11 | 620 | - | **+7.04 dBFS** (clipper engaged, whole mix pumped) | -1.05 |
| 11 x HIT(10) coalesced -> hitTone(110) | 1 | 1300 | -30.66 dB | -13.90 | **-12.19** (single hitTone4: -12.19) |
| 11 x HIT + 11 x PAIN coalesced -> tone + one light grunt at 100 u | 2 | 725 (grunt formant) | -30.28 dB | -9.78 | -8.07 (louder single cue, enemy painLight: -8.93) |
| 11 x HIT in frame A + 11 x HIT in frame B (+50 ms) | 2 | | | | |

Live (`node tools/audio_measure.mjs --live 40`, arena mode so the full arsenal is available, the local player aims at the
bot and switches to the shotgun inside 900 units): 50 local shotgun HIT events arrived in 6 bursts of 2/7/8/11/11/11
pellets and exactly **6 hit tones** were voiced (one per blast that hit); 69 PAIN events in 69 ticks -> 69 grunts. The live
audit asserts `hitFrames <= hitTones <= hitBursts` (one tone per frame or per tick, never per pellet) and the same for
pain grunts.

## Measured table (peak dBFS at the listener, master volume 1.0)

`own` is the non-spatial local version; `enemy` is the HRTF-spatialized version at the given distance in units
(straight ahead). Duration is the -60 dBFS span of the own (or point-blank enemy) render.

| Cue | own @0 | enemy @0 | @300 | @600 | @1500 | dur (s) | RMS own/enemy@0 |
|---|---|---|---|---|---|---|---|
| machinegunFire | -7.8 | -3.9 | -3.9 | -9.3 | -17.3 | 0.047 | -19.9 / -16.1 |
| shotgunFire | -7.7 | -4.0 | -4.0 | -9.4 | -17.4 | 0.531 | -24.9 / -22.5 |
| rocketFire | -7.7 | -4.0 | -4.0 | -9.4 | -17.4 | 0.372 | -20.8 / -20.1 |
| railFire | -7.5 | -4.1 | -4.1 | -9.6 | -17.5 | 0.761 | -27.4 / -25.3 |
| plasmaFire | -6.0 | -5.6 | -5.6 | -11.1 | -19.0 | 0.066 | -21.1 / -20.2 |
| gauntletFire | -8.2 | -3.5 | -3.5 | -8.9 | -16.9 | 0.175 | -23.7 / -21.0 |
| lightningLoop | -5.9 | -5.8 | -5.8 | -11.2 | -19.2 | 0.639 | -19.1 / -18.8 |
| rocketLoop | - | -13.6 | -13.6 | -19.1 | -27.1 | 0.629 | - / -25.9 |
| rocketExplode | - | -2.7 | -2.7 | -8.1 | -16.1 | 0.83 | - / -21.9 |
| plasmaExplode | - | -11.7 | -11.7 | -17.1 | -25.1 | 0.048 | - / -27.5 |
| bulletImpact | - | -15.7 | -15.7 | -21.1 | -29.1 | 0.024 | - / -32.4 |
| railImpact | - | -9.6 | -9.6 | -15.1 | -23.1 | 0.22 | - / -29.6 |
| gauntletImpact | - | -13.7 | -13.7 | -19.1 | -27.1 | 0.087 | - / -29.6 |
| lgHit | - | -13.7 | -13.7 | -19.1 | -27.1 | 0.043 | - / -30.2 |
| jump | -14.8 | -12.9 | -12.9 | -18.3 | -26.3 | 0.103 | -32.5 / -30.3 |
| landSoft | -17.8 | -13.8 | -13.8 | -19.3 | -27.2 | 0.056 | -27.7 / -25.8 |
| landHard | -12.2 | -7.5 | -7.5 | -12.9 | -20.9 | 0.156 | -23.8 / -23.5 |
| footstep | -13.9 | -13.8 | -13.8 | -19.2 | -27.2 | 0.026 | -30.6 / -29.0 |
| painLight | -11.1 | -8.9 | -8.9 | -14.4 | -22.4 | 0.142 | -29.6 / -26.6 |
| painMid | -10.8 | -8.3 | -8.3 | -13.7 | -21.7 | 0.206 | -28.6 / -25.7 |
| painHeavy | -10.6 | -7.5 | -7.5 | -12.9 | -20.9 | 0.266 | -28.9 / -26.3 |
| painCritical | -9.4 | -6.7 | -6.7 | -12.1 | -20.1 | 0.378 | -29.2 / -26.9 |
| death | -8.2 | -7.5 | -7.5 | -12.9 | -20.9 | 0.678 | -26.9 / -25.4 |
| gib | -8.9 | -2.9 | -2.9 | -8.3 | -16.2 | 0.359 | -21.3 / -20.4 |
| pickupHealth | -13.0 | -10.6 | -10.6 | -16.1 | -24.0 | 0.177 | -27.4 / -25.3 |
| pickupMega | -10.9 | -8.7 | -8.7 | -14.2 | -22.1 | 0.605 | -26.1 / -23.3 |
| pickupArmor | -12.6 | -11.1 | -11.1 | -16.6 | -24.5 | 0.278 | -29.9 / -27.4 |
| pickupWeapon | -12.9 | -8.8 | -8.8 | -14.2 | -22.2 | 0.215 | -26.7 / -22.7 |
| pickupAmmo | -14.4 | -13.3 | -13.3 | -18.8 | -26.7 | 0.105 | -31.8 / -31.0 |
| respawnMajor | - | -7.7 | -7.7 | -7.7 | -9.6 / -15.6 @3000 | 0.833 | - / -22.3 |
| respawnMinor | - | -17.6 | -22.5 | -29.7 | -38.3 / -44.5 @3000 | 0.062 | - / -29.6 |
| jumppad | -10.6 | -9.0 | -9.0 | -14.5 | -22.4 | 0.265 | -26.8 / -25.4 |
| teleport | -11.5 | -8.2 | -8.2 | -13.7 | -21.6 | 0.497 | -24.4 / -21.7 |
| hitTone1..4 | -12.1 / -11.7 / -11.7 / -12.2 | - | - | - | - | 0.046 | -25.6 / - |
| weaponChange | -20.0 | - | - | - | - | 0.059 | -33.4 / - |
| noAmmo | -18.0 | - | - | - | - | 0.104 | -33.2 / - |
| countdown | -12.0 | - | - | - | - | 0.12 | -17.6 / - |
| fight | -10.0 | - | - | - | - | 0.387 | -22.4 / - |
| win | -10.0 | - | - | - | - | 1.222 | -26.4 / - |
| lose | -10.0 | - | - | - | - | 0.831 | -22.8 / - |
| alert | -12.0 | - | - | - | - | 0.288 | -17.5 / - |
| ambient bed | peak -34.2, RMS -40.1 | | | | | continuous | |

## Recalibrating

Change a recipe, then run `node tools/audio_measure.mjs --calibrate`: it prints a `CUE_TRIM` table that moves every
cue to its target peak (weapons -6, explosion -3, pain -8..-10, hit tones -12, UI clicks -18..-20, ambient -40 RMS)
and a `REMOTE_GAIN` suggestion. Paste, rerun without `--calibrate`; the run exits non-zero if a rule breaks. Use
`--only rail,footstep` while iterating on a cue and `--limiter off` to see pre-limiter levels.

Two Chrome quirks the tool works around: `DynamicsCompressor` starts a fresh context with its gain ramped down (about
12 dB loss on a burst at t = 0, settled by 200 ms), so cues are triggered at 0.25 s; and its automatic makeup gain
(+1.7 dB at this threshold/ratio) is measured with a probe tone and subtracted when computing gain reduction.

## Runtime API (used by `client/main.js`)

`new AudioEngine({ context?, ambient?, limiter?, seed? })`, `init(opts?)`, `resume()`, `setVolume(v)`,
`updateListener(eye, angles)`, `event(e, cg, predicted)`, `update(cg, now)`, `close()`, `stats()`,
`cue(name, { origin, local, id, velocity })` (the named cue table used by the measurement tool), `flushDamage()` (voices
the queued HIT/PAIN cues; called by `update()` every frame). Events come straight from `shared/game.js`; enemy JUMP / LAND / FOOTSTEP events carry no origin, so the engine resolves the player's
interpolated position from `cg.remote` (falling back to the game state).
