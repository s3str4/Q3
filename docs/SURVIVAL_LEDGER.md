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
BUDGET FIRED at 12:07 (108 min; 3 builder-critic rounds used: build, critique+revise, integration). Final state committed
(c3ca3c8). Remaining gaps escalated to the user below; next round needs an explicit extension.

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
- 12:10 full slice committed: renderer (5 modules: daylight, world, characters, effects, renderer), synthesized audio (~50 cues, offline measure tool), HUD (objective tracker, vitals, hotbar, prompts, toasts, banners, inventory, end screens), autopilot (win/reckless), 20 tests (19 sim + 1 client) green, arena suite 72/72 green (no regression), evidence tool: 11/12 benchmark checks pass on the integration run (.evidence/survival/int1).
- Post-critic glue fixes by the lead: audio listener forward aligned to the camera screen-up vector (45 deg panning error found by the audio critic), autopilot exposed on window.__survival, reload typo.

## Failed approaches
- Linear-scan heap in the zombie flow field (Dijkstra): 6000 ticks did not finish in 2 minutes. Replaced by Dial's
  bucket queue with integer costs (0.1 ms per tick for the whole sim).

## Verdicts
| Part | Round 1 (fresh critic) | Round 2 | Largest remaining gap |
|---|---|---|---|
| render | 6 fail (night fogged out: fog keyed in absolute tiles vs camera distance) | 7 fail after revision (night fixed: markers/eyes/contrast pass) | dusk 18:00-21:00 renders as dark as night (mean luminance dusk 0.122 == night 0.122; benchmark wants day > dusk > night) |
| audio | 8 pass | - | panning rotated 45 deg from the screen (fixed by the lead post-round: listener forward = screen-up); hard equal-power pan silences the far ear; no ducking after WIN/LOSE |
| hud | 8 pass | - | off-screen chaser skull arrows clamp onto the bottom hotbar/vitals panels (need a safe-area clamp) |
| evidence/autopilot | 8 pass | - | autopilot arrived-but-out-of-reach stall (4/40 runs idle 14-17 s); reckless control dies by day not night |
| integration | 7.5 pass, non-blocking | - | same dusk luminance row (only failing evidence check); door jamb catch when entering a 1-tile door off-centre (no wall slide); night foliage reads as neon slabs |

## Next correction / owner (if extended)
1. render: retune survival/render/daylight.js keys h=16/18/19.5 (keep sun elevation >= 42 deg and sunI >= 1.5 through 18:00, warm ground tint, fall only 19:30-21:00); acceptance: evidence row "tone per phase" passes with dusk ~0.2.
2. hud: clamp edge arrows to a safe area (ellipse around the player or margins above #hotbar/#vitals) and fan out overlaps.
3. sim: wall-slide in moveCircle so a 1-tile doorway is entered off-centre; cancel interact-locked actions when hurt.
4. audio: soften the equal-power pan (keep the far ear >= -12 dB), duck world/zombie buses after WIN/LOSE, distinct concrete vs asphalt steps.
5. evidence: delay beat screenshots ~400 ms so banners are captured settled; autopilot reach gate d <= interactRange - 0.05.
