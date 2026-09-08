# Survival slice benchmark: 7 Days to Die moment-to-moment loop, Zomboid presentation

The prototype (`/survival`) is held to the reference below. Every row marked `[test]` is asserted by
`tests/survival_sim.test.mjs` (sim rules, headless) or `tests/survival_client.test.mjs` (real browser, events, audio
triggers, frame times); rows marked `[evidence]` are produced by `node tools/survival_evidence.mjs` as screenshots,
state/audio logs and metrics in `.evidence/survival/`. Reference values are public-knowledge design facts about
7 Days to Die (7DTD, Alpha 21 defaults) and Project Zomboid (PZ, build 41); where the prototype deliberately deviates
the reason is given.

## 1. Gameplay: the survival loop

| Criterion | 7DTD / PZ reference | Ours | Test |
|---|---|---|---|
| Loop is closed: spawn -> loot -> threat -> fight/flee/stealth -> objective -> feedback | 7DTD day 1: loot, craft, fortify, horde night | five-step objective chain ending in a win at 06:00 day 2 or death | [test] autopilot completes the slice (`tests/survival_sim.test.mjs`) |
| Player state machine is explicit and logged | n/a (internal) | idle/walk/run/sneak/attack/interact/stagger/dead, every transition in `sim.log` | [test] no transition to an unknown state; attack/interact/stagger expire back to locomotion |
| Vitals: hunger and thirst drain, starvation damages | 7DTD: food/water drain, 0 = health loss | hunger -2.2/min, thirst -3.0/min game time; 1.5 hp per 4 s at 0 | [test] |
| Stamina gates sprint and melee | 7DTD stamina; PZ endurance | sprint 16/s drain, 11/s regen after 0.9 s; below 15 no sprint/swing | [test] sprint exhausts in ~6 s and STAMINA_OUT fires once |
| Bleeding is a status needing a bandage | 7DTD bleeding, bandage stops it | 30% per zombie hit, 1 hp / 2 s until bandaged; bandage heals 20 over 6 s | [test] |
| Melee has range, arc, cooldown, knockback, stagger | 7DTD club: ~2.4 m, stagger on hit | bat 1.35 tiles, 86 deg arc, 0.7 s, stagger 0.55 s; 3 bat hits kill | [test] |
| Ranged is loud and scarce | 7DTD pistol: 8-round mag, gunshots draw zombies | pistol 8-round mag, 45 dmg, noise radius 26 tiles, 24 rounds on the map | [test] gunshot alerts every zombie within 26 tiles |
| Stealth: crouching reduces detection, noise attracts | 7DTD stealth meter; PZ sneaking | sneak halves sight range and makes 1.5-tile noise vs 4.5 walk / 9 run | [test] sneaking past a zombie at 6 tiles is not detected, walking is |
| Zombie senses: sight cone + LOS, hearing with radius, day vs night | 7DTD: zombies run at night, hear gunshots far | FOV 135 deg, sight 9.5 day / 4.2 night, walls block LOS, windows do not | [test] LOS through a wall is false, through a window true |
| Zombie state machine: idle/wander/investigate/chase/attack/bash/stagger/dead | 7DTD: wander, investigate noise, chase, attack blocks | same, transitions logged with cause (sight/sound/hit/horde/lost) | [test] chase -> investigate after 4.5 s without LOS |
| Zombies breach obstacles rather than stop at them | 7DTD zombies destroy blocks on their path | flow field costs openings by hp; zombies bash doors (90), windows (45), barricades (150) | [test] barricaded door is bashed down in ~11 hits |
| Fortification is a real decision | 7DTD: build/upgrade before 22:00 | planks (harvest 3 hits per tree, loot shelves), barricade = 2 planks, 150 hp | [test] |
| Horde night: waves that know where you are | 7DTD blood moon at 22:00, waves until 04:00 | waves of 6/5/4 at 22:00, 00:00, 03:00 from the map edge, +0.35 speed, always chase | [test] wave timing |
| Zombies slower than a sprinting player, faster than a walking one at night | 7DTD: night run ~ player jog | chase 2.0 (2.7 night + 0.35 horde) vs walk 2.7 / run 4.8 | [test] constants |
| Day length lets a session fit a sitting | 7DTD default 60 min day; PZ 1 h | 8 real minutes per 24 h (start 08:00, win 06:00: ~7.3 min), `?fast=N` for evidence | [test] clock |
| Readable outcomes | hit markers, damage flash, screen effects | every hit/hurt/pickup/denied action has a HUD reaction and a cue (below) | [evidence] |

## 2. Visuals: legibility and consistency

| Criterion | Reference | Ours | Test |
|---|---|---|---|
| Camera | PZ: fixed isometric; 7DTD: first person | fixed 3/4 view (yaw 45 deg, pitch ~50 deg), player-centred, no pointer lock | [evidence] screenshots |
| Silhouettes | PZ: 1-tile characters readable from above | player and zombies contrast >= 25% luminance vs. ground in day and night (measured on screenshots) | [test] client test measures pixel contrast at the entity screen positions |
| Zombie state is readable at a glance | 7DTD: sensing/alert animation; PZ: zombie head turns | posture (shamble vs. lunge) + marker: `?` investigate, `!` chase; horde eyes glow at night | [evidence] |
| Day/night and dusk warning | 7DTD: sky turns red on horde night | sun colour/intensity by hour, dusk sting at 18:00, night ambient, player lantern radius | [evidence] tone per phase measured (mean luminance day > dusk > night) |
| UI legibility | 7DTD HUD: vitals bottom-left, hotbar, compass; PZ: moodles | vitals bars with icons and numbers, clock + day + phase, objective tracker, hotbar 1-3, prompts, inventory panel | [evidence] min text 14 px at 1080p, contrast >= 4.5:1 |
| Basic animation | 7DTD/PZ skeletal | procedural: walk bob/arm swing scaled by speed, swing wind-up, zombie lurch, hit recoil, death fall | [evidence] |
| Performance | 60 fps target in prototype | frame p99 <= 16.7 ms at 1080p in headless Edge with 20 zombies; draw calls <= 150 | [test] client test asserts frame p99 and draw calls |
| No unloaded/blank frames | | first frame after START already lit | [test] |

## 3. Sound design: event-driven, no timing glitches

| Criterion | Reference | Ours | Test |
|---|---|---|---|
| Every key interaction has a cue | 7DTD: footsteps per surface, weapon hits, UI, zombie groans, blood-moon horn | footstep x4 surfaces, swing/hit/kill, gunshot/reload/empty, groan/alert/attack/bash, hurt/heartbeat/death, pickup/eat/drink/bandage/build/harvest/door, denied, phase stings, horde horn, win/lose | [test] every EV type maps to a cue or an explicit silence |
| Cues fire on the event tick | | audio trigger log: `cue`, sim tick, ctx time; trigger within 1 frame (<= 34 ms) of the event | [test] client test compares `audio.triggerLog` against `eventLog` per tick |
| No orphan/zombie voices | | voices return to 0 after cues; loops (heartbeat, ambient) stopped explicitly | [test] `audio.stats()` |
| Ambient by phase | 7DTD day birds / night wind + wolves | day bed, night bed (crossfade over 3 s), horde adds a low drone | [test] ambient state follows `sim.phase` |
| Spatial danger cues | 7DTD: hearing zombies before seeing them | groans/steps panned + attenuated (ref 3 tiles, max 30), chase groans louder | [test] enemy groan at 20 tiles >= -30 dBFS, panned |
| Confirmations distinct from alarms | | UI confirmations short/high, denials low buzz, danger cues low/long | [test] spectral centroid ordering measured offline |
| No clipping | | limiter + ceiling as in `client/audio/audio.js` | [test] stress mix peak <= -0.5 dBFS |

## 4. Blind comparison protocol

Reproduced by `node tools/survival_evidence.mjs --name run --fast 4` and inspected by a critic who has not seen the code:

1. **Screenshots** `.evidence/survival/<name>/shot_NN.png` at fixed story beats (spawn, first loot, first zombie sighting, combat, dusk, barricading, horde, dawn/win or death). The critic scores each against the visual rubric in section 2 (silhouette, state readability, UI legibility) on a 1-10 scale; anything under 7 is a gap.
2. **State log** `state_log.json` (every player/zombie transition, phase, objective, result) and **event log** `events.json`: the critic checks the loop order spawn -> loot -> threat -> decision -> objective -> feedback appears, with times.
3. **Audio trigger log** `audio_log.json`: for each event type, the cue name and the delay between the sim tick and the audio context schedule time; max delay and any event without a cue are listed in `stats.json`.
4. **Metrics** `stats.json`: fps avg/min, frame p99, draws, kills, damage taken/dealt, detections, max simultaneous chasers, barricades built/broken, items looted, result.
5. **Recording**: a headed run (`--headed`) can be screen-captured by the user; the evidence tool itself stores a 2 fps contact sheet of the run (`sheet.png`).

## 5. Acceptance checklist (integration critic)

- [ ] `node --test tests/survival_sim.test.mjs` green (rules + autopilot completes the slice with a win on seed 7 and a loss when unarmed and unfortified)
- [ ] `node --test tests/survival_client.test.mjs` green (real Edge: no console errors, frame p99 <= 16.7 ms, cue/event alignment, silhouette contrast)
- [ ] `node tools/survival_evidence.mjs` produces the shots, logs and stats without errors; a human can play `/survival` with the documented controls
- [ ] every objective step is reachable in a normal play-through within the day (autopilot proves it), and the horde night is survivable when fortified and lost when not
- [ ] README documents install/run/controls/tests for the slice
