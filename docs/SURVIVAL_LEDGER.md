# Survival slice: progress ledger (Gauntlet protocol)

## Stack (inspected 2026-09-08 10:20, preserved)
Existing repo `arena-duel`: plain ES modules, no build step, three.js 0.169 via import map, Node 24 static + WebSocket
server on one port, synthesized Web Audio, puppeteer-core driving Edge for evidence, `node --test`. The survival slice
is a sibling game in the same repo: `shared/survival/` (deterministic 30 Hz sim, town, autopilot), `survival/`
(page, input, renderer, HUD, audio), `tests/survival_*.test.mjs`, `tools/survival_evidence.mjs`. Served at `/survival`.
Reason: the stack already proves 60+ fps three.js rendering, measured synthesized audio and headless-browser evidence
capture on this machine; a Zomboid-style fixed camera needs no pointer lock, so headless evidence is exact.

## Benchmark
`docs/SURVIVAL_BENCHMARK.md`: 7 Days to Die / Project Zomboid reference rows -> testable criteria (sim tests, client
tests, evidence tool), blind comparison protocol (screenshots at story beats, state log, event log, audio trigger log,
metrics), acceptance checklist.

## Boundaries
<= 12 builder-critic rounds or 90 minutes (started 10:19, hard stop 11:49), 3 rounds max on one unresolved gap; zero
spend; no deploy; no credentials; no contacting people; reversible changes only (git commits, nothing destructive).

## Current target
Round 1: builders (render, audio, hud, evidence+tests+autopilot, each owning disjoint files; sim balance owned by the
evidence builder this round) -> fresh critics per part -> revise the largest gap -> critic round 2 -> integration critic.

## Decomposition and owners
| Part | Owner | Deliverable |
|---|---|---|
| sim + world + contract | lead | `shared/survival/{constants,world,sim}.js` (done, smoke-tested: 0.1 ms/tick, loop closes) |
| renderer | builder render | `survival/render/**` |
| audio | builder audio | `survival/audio/**`, `tools/survival_audio_measure.mjs` |
| hud/ui | builder hud | `survival/hud.js`, `survival/style.css` |
| autopilot, tests, evidence | builder evidence | `shared/survival/autopilot.js`, `tests/survival_*.test.mjs`, `tools/survival_evidence.mjs` |
| glue, docs, ledger | lead | `survival/{index.html,main.js,input.js}`, `docs/SURVIVAL_*.md`, README |

## Evidence
- `.evidence/survival/<name>/` from `node tools/survival_evidence.mjs`.
- `.evidence/critic*_<part>/` from the critics.

## Completed parts
- 10:33 foundation committed (contract, sim, town, page skeleton, benchmark doc).

## Failed approaches
- Linear-scan heap in the zombie flow field (Dijkstra): 6000 ticks did not finish in 2 minutes. Replaced by Dial's
  bucket queue with integer costs (0.1 ms per tick for the whole sim).

## Verdicts
(filled per round)

## Next correction / owner
(filled per round)
