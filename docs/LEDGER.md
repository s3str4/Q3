# Progress ledger (Gauntlet protocol)

## Stack (locked 2026-09-07)
Browser client (Three.js + Web Audio synthesis) · Node 24 headless authoritative server (WebSocket, TCP 27960) · shared deterministic Q3 simulation (pmove/brush trace/weapons/items/match) · P2P fallback: browser-hosted session over WebRTC DataChannel with manual invite codes · tests: node:test; evidence: puppeteer-core driving Edge (tools/evidence.mjs), headless bot duels (tools/bot_duel.mjs).

## Benchmark
docs/BENCHMARK.md (Q3 reference values; asserted by tests).

## Current target
Round 2: revisions against the round-1 critic correction targets (map: loops must be contested routes with LOS into atria; audio: A-weighted loudness consistency and mid/high-forward weapon identity; visuals: LG/explosion/emissive blow-out and viewmodel height; netcode: deterministic test suite, WELCOME resend on JOIN retry, bot seed variance/accuracy). Then critic #2, then integration critic.

## Round-1 critic verdicts (fresh critics, real artifact)
| Part | Score | vs Q3 bar | Largest gap |
|---|---|---|---|
| map | 6.5 fail | reference | N/S loops are blind 960u tubes with no LOS into atria; bots spend 4-7% there |
| audio | 6.5 -> 7 fail | reference | per-pellet hit tones stacked (fixed in revise #1); weapon fires differ ~27 dB A-weighted, sub-bass dominated |
| visuals | 5.5 fail | reference | LG/explosion/emissive panels blow out the frame; LG/RG viewmodel > 25% height |
| netcode | 6 fail | ours | npm test script broken on Node 24; lost WELCOME never resent; combat test racy; bot frags seed-dependent |

## Completed parts
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
