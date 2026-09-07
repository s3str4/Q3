# Progress ledger (Gauntlet protocol)

## Stack decision (locked 2026-09-07)
- Client: browser (Chromium/Edge/Chrome), Three.js renderer, Web Audio API synthesized sound (no third-party audio assets).
- Server: Node.js LTS headless authoritative server, WebSocket transport on TCP 27960.
- Shared: deterministic simulation module (Quake 3 pmove/weapons port) used by server, client prediction, and bots.
- Internet path A (primary): host forwards TCP 27960 (or uses a tunnel); clients connect by URL.
- Internet path B (fallback, zero infra): browser-hosted authoritative sim over WebRTC DataChannel, manual invite/answer codes, public STUN.
- Tests: node:test unit + scripted bot duels; puppeteer-core driving installed Edge for render/audio evidence.

## Benchmark (Quake 3 reference values, verified in tests/benchmark.test.mjs)
See docs/BENCHMARK.md.

## Current target
Milestone 0: skeleton (shared sim, server, client) runnable.

## Completed parts
- (none)

## Failed approaches
- (none)

## Next correction / owner
- Build skeleton (main agent)

## Remaining boundaries
- 12 builder/critic rounds or 90 min autonomous; zero spend; no public deploy; no credentials.
