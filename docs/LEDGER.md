# Progress ledger (Gauntlet protocol)

## Stack (locked 2026-09-07)
Browser client (Three.js + Web Audio synthesis) · Node 24 headless authoritative server (WebSocket, TCP 27960) · shared deterministic Q3 simulation (pmove/brush trace/weapons/items/match) · P2P fallback: browser-hosted session over WebRTC DataChannel with manual invite codes · tests: node:test; evidence: puppeteer-core driving Edge (tools/evidence.mjs), headless bot duels (tools/bot_duel.mjs).

## Benchmark
docs/BENCHMARK.md (Q3 reference values; asserted by tests).

## Current target
Round 1: parallel builders (map, audio, visuals, netcode/tests/bots) then fresh critics.

## Completed parts
- Core sim: pmove port verified (jump apex 45.7u, 320ups, 16u steps, strafe-jump accel), brush tracing, weapons (MG/SG/RL/LG/RG/PG), armor/knockback/self-damage, items with Q3 respawn times, duel + arena match rules.
- Server: 60Hz tick, 60Hz snapshots, lag compensation (250ms cap), netsim (latency/jitter/loss), static hosting, bots.
- Client: 60Hz prediction+reconciliation (sub-unit error at LAN), 2-snapshot interpolation, HUD, baseline renderer (procedural PBR materials, bloom, shadows, effects), baseline synthesized audio, evidence tool (120fps headless capture).

## Failed approaches
- Per-effect PointLight add/remove: forced shader recompiles (500ms frames). Replaced by a fixed light pool (client/render/lightpool.js).
- Zero-size resize while hidden poisoned the camera FOV (NaN). Guarded.

## Next correction / owner
- Map (builder A), audio (B), visuals (C), netcode+tests+bots+docs (D). Then critics.

## Remaining boundaries
- <= 12 builder/critic rounds total, 3 max per unresolved gap; zero spend; no public deploy; no credentials.
