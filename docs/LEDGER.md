# Progress ledger (Gauntlet protocol)

## Stack (locked 2026-09-07)
Browser client (Three.js + Web Audio synthesis) · Node 24 headless authoritative server (WebSocket, TCP 27960) · shared deterministic Q3 simulation (pmove/brush trace/weapons/items/match) · P2P fallback: browser-hosted session over WebRTC DataChannel with manual invite codes · tests: node:test; evidence: puppeteer-core driving Edge (tools/evidence.mjs), headless bot duels (tools/bot_duel.mjs).

## Benchmark
docs/BENCHMARK.md (Q3 reference values; asserted by tests).

## Current target
Budget exhausted (12 builder-critic rounds). Final state committed; remaining gaps escalated to the user (see "Open gaps").

## Round-2/3 and integration verdicts
| Part | Round 3 | vs Q3 bar | Largest remaining gap |
|---|---|---|---|
| map | 7.5 fail | reference | lower level is one flat plane; RA and Mega pockets mirror at the same height |
| audio | 7.5 fail | reference | per-pellet shotgun impact voices (fixed post-round: one BULLET_IMPACT per blast) |
| visuals | 6.5 fail | reference | east/cool atrium desaturated; near-wall frames blew out (fixed post-round: overbright clamp 3.2) |
| netcode | 8 pass | ours | 2% loss claim is TCP-level (WebSocket never loses frames); documented |
| integration | 7 fail | reference | visuals tone + black unbaked first frames (fixed: bake gate) + stale practice match (fixed: reset on last human leaving) + docs (fixed) |

## Post-round integration fixes (orchestrator, verified by npm test 52/52 and .evidence/final)
- client/render/world.js: BAKE_CLAMP 3.2 on baked irradiance (id Tech 3 overbright clip) - near-wall frames keep texture.
- client/main.js: join waits for renderer.bakePromise ("baking lighting..."); P2P host keeps the menu with the invite code until the guest joins.
- shared/game.js: one EV.BULLET_IMPACT per shotgun blast. shared/session.js: match reset when the last human leaves.
- tools/evidence.mjs: uncapped fps flags (measured 1042 fps avg, p99 6.3 ms at 1080p). server: /favicon.ico -> 204.

## Open gaps (need another strategy/round; not attempted within budget)
- Map: add height variation along the lower routes (pits, ramps, split-level runs) so RA/Mega sides differ; loop spawns view a flat hallway.
- Visuals: east atrium saturation/contrast targets (tools/screenshots.mjs tone.pass) still false; a colour-grading pass or warmer accent lights in the east atrium are the next materially different strategies.
- Audio: HRTF back/above response uncompensated; footsteps/land cues still sub-300 Hz heavy.
- Player model is primitive-built; no skinned mesh/animations.

## Round-1 critic verdicts (fresh critics, real artifact)
| Part | Score | vs Q3 bar | Largest gap |
|---|---|---|---|
| map | 6.5 fail | reference | N/S loops are blind 960u tubes with no LOS into atria; bots spend 4-7% there |
| audio | 6.5 -> 7 fail | reference | per-pellet hit tones stacked (fixed in revise #1); weapon fires differ ~27 dB A-weighted, sub-bass dominated |
| visuals | 5.5 fail | reference | LG/explosion/emissive panels blow out the frame; LG/RG viewmodel > 25% height |
| netcode | 6 fail | ours | npm test script broken on Node 24; lost WELCOME never resent; combat test racy; bot frags seed-dependent |

## Completed parts
- 52 tests green (benchmark, game, map, netcode); lag comp 96.9% vs 5.6% without; netbench 0 corrections at 0-150 ms.
- Core sim: pmove port verified (jump apex 45.7u, 320ups, 16u steps, strafe-jump accel), brush tracing, weapons (MG/SG/RL/LG/RG/PG), armor/knockback/self-damage, items with Q3 respawn times, duel + arena match rules.
- Server: 60Hz tick, 60Hz snapshots, lag compensation (250ms cap), netsim (latency/jitter/loss), static hosting, bots.
- Client: 60Hz prediction+reconciliation (sub-unit error at LAN), 2-snapshot interpolation, HUD, baseline renderer (procedural PBR materials, bloom, shadows, effects), baseline synthesized audio, evidence tool (120fps headless capture).

- Round 1 builders: Crossfire duel map (maps/arena_duel.js + maps/shell.js + tests/map.test.mjs + maps/README.md); audio engine rewrite (voices, buses, limiter, HRTF, coalesced hit tones, tools/audio_measure.mjs, docs/AUDIO.md); renderer rewrite (world.js merged geometry, per-vertex baked lighting/AO in a worker, beam.js LG/rail, particles.js, items.js, weapons.js, separate viewmodel pass, FXAA + quarter-res bloom, tools/screenshots.mjs); netcode fixes (command dedupe/ordering, no phantom steps, arrival-based render clock, WELCOME resend), 49 passing tests (benchmark/game/map/netcode), tools/netbench.mjs, README.md, docs/NETWORKING.md, bot rewrite.

## Failed approaches
- Per-effect PointLight add/remove: forced shader recompiles (500ms frames). Replaced by a fixed light pool (client/render/lightpool.js).
- Zero-size resize while hidden poisoned the camera FOV (NaN). Guarded.
- Real-time point-light shadow maps + 4x MSAA + full-res bloom: 2.5 ms GPU/frame; replaced by per-vertex baked lighting + FXAA + quarter-res bloom.
- Ping-clock-based interpolation always extrapolated; replaced by arrival-based render clock. setTimeout-ordered netsim reordered messages; fixed to keep order.
- Peak-normalised audio calibration let sub-bass dominate every weapon; round 2 moves to A-weighted momentary loudness.

## Next correction / owner
- Map (builder A), audio (B), visuals (C), netcode+tests+bots+docs (D). Then critics.

## Remaining boundaries
- <= 12 builder/critic rounds total, 3 max per unresolved gap; zero spend; no public deploy; no credentials.
