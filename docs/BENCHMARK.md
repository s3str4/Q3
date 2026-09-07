# Benchmark: Quake 3 Arena feel targets

These are the reference values the simulation is held to. Every value marked
`[test]` is asserted by `tests/benchmark.test.mjs` against `shared/constants.js`
and the live simulation, so the benchmark is verifiable in this repo rather
than believed.

## Movement (id Software bg_pmove.c, vanilla Q3 1.32)
| Parameter | Q3 value | Ours | Test |
|---|---|---|---|
| Ground speed (`g_speed`) | 320 ups | 320 | [test] |
| Ground acceleration (`pm_accelerate`) | 10 | 10 | [test] |
| Air acceleration (`pm_airaccelerate`) | 1 | 1 | [test] |
| Ground friction (`pm_friction`) | 6 | 6 | [test] |
| Stop speed (`pm_stopspeed`) | 100 | 100 | [test] |
| Jump velocity | 270 ups | 270 | [test] |
| Gravity (`g_gravity`) | 800 | 800 | [test] |
| Step height | 18 | 18 | [test] |
| Player bbox | 30x30x56 (-24..+32) | same | [test] |
| View height / crouched | 26 / 12 | same | [test] |
| Duck speed scale | 0.25 | 0.25 | [test] |
| Overclip | 1.001 | 1.001 | [test] |
| Walkable normal (MIN_WALK_NORMAL) | 0.7 | 0.7 | [test] |
| Jump apex height from 270 ups @ 800 gravity | ~45.6 units | measured in sim | [test] |
| Strafe-jump: air accel yields > 320 ups after repeated jumps | yes | measured in sim | [test] |
| Knockback: `damage * g_knockback(1000) / mass(200)`, cap 200 | yes | same | [test] |
| Knockback loss of control (`PMF_TIME_KNOCKBACK`) | 50..200 ms | same | [test] |

## Weapons (g_weapon.c / g_missile.c)
| Weapon | Damage | Refire | Speed | Splash | Test |
|---|---|---|---|---|---|
| Machinegun | 7 | 100 ms | hitscan, spread 200 | - | [test] |
| Shotgun | 11 pellets x 10 | 1000 ms | hitscan, spread 700 | - | [test] |
| Rocket launcher | 100 direct | 800 ms | 900 ups | 100 @ radius 120 | [test] |
| Lightning gun | 8 | 50 ms | hitscan, range 768 | - | [test] |
| Railgun | 100 | 1500 ms | hitscan | - | [test] |
| Plasma gun | 20 | 100 ms | 2000 ups | 15 @ radius 20 | [test] |
| Self damage | x0.5 | same | | | [test] |
| Armor absorption | 2/3, armor cap 200 | same | | | [test] |
| Weapon switch | 200 ms drop + 250 ms raise | same | | | [test] |

## Items (g_items.c, item list bg_misc.c)
| Item | Effect | Respawn | Test |
|---|---|---|---|
| Spawn health | 125 decaying to 100 at 1/s | - | [test] |
| Mega health | +100 to max 200, decays | 35 s | [test] |
| Health 25 / 50 | +25 / +50 to 100 | 35 s | [test] |
| Health bubble 5 | +5 to 200 | 35 s | [test] |
| Yellow armor | +50 to 200 | 25 s | [test] |
| Red armor | +100 to 200 | 25 s | [test] |
| Weapons | 5 s | 5 s | [test] |
| Ammo | 40 s | 40 s | [test] |

## Netcode (competitive 1v1 target: better than vanilla Q3)
| Parameter | Q3 default | Ours | Evidence |
|---|---|---|---|
| Server tick | 20 Hz (`sv_fps 20`), CPMA 30-40 | 60 Hz | `tools/netbench.mjs` |
| Snapshot rate | 20 Hz | 60 Hz (configurable 20-60) | netbench |
| Client command rate | up to 125 Hz | 60 Hz fixed step | netbench |
| Client prediction + reconciliation | yes | yes, misprediction < 0.01 units at 0 loss | `tests/netcode.test.mjs` |
| Remote interpolation buffer | 1 snapshot | 2 snapshots (33 ms @ 60 Hz) | netbench |
| Hitscan lag compensation | no (unlagged is a mod) | yes, rewind capped at 250 ms | tests |
| Playable ping tolerance | ~100-150 ms | duel stays consistent at 150 ms + 30 ms jitter + 2% loss | netbench |

## Maps (competitive duel readability targets)
- Corridors >= 96 units wide, ceilings >= 128 (jump clearance 45 + head), stairs <= 16 rise (step 18).
- Two atria linked by >= 3 routes; mega health and red armor on opposite sides (Q3 pro-q3dm6/ztn-style item control).
- Item spacing: no two majors within 512 units; ammo/health bubbles along transit routes.
- Every walkway is reachable without trick jumps; upper level reachable by jump pad AND stairs.
- Asserted by `tests/map.test.mjs` (reachability by bot navigation, clearance sweeps, item distances).

## Audio
- Every weapon fire, impact, pickup, pain, death, jump/land and footstep has a distinct synthesized cue.
- Loudness: per-category peak/RMS measured by offline render (`tools/audio_measure.mjs`), enemy cues never quieter than own cues at equal distance.
- Spatial: inverse-distance attenuation with reference distance 320 and max 3000 (audible across the map), HRTF panning.
- Hit confirmation: CPMA-style pitched hit tones scaled by damage.
