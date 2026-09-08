# Arena Duel

A Quake III Arena-style 1v1 duel that runs in the browser: Three.js renderer, synthesized Web Audio, and a headless
Node authoritative server, all sharing one deterministic simulation (`shared/`) that ports Q3's `bg_pmove.c` movement,
brush tracing, weapons, items and match rules. The feel targets are written down in `docs/BENCHMARK.md` and asserted
by the test suite; the netcode design is in `docs/NETWORKING.md`.

- 60 Hz server tick and 60 Hz snapshots (Q3 default is 20 Hz), client-side prediction with reconciliation,
  2-snapshot interpolation for remote players, lag-compensated hitscan (rewind capped at 250 ms).
- Duel mode (10 min, sudden-death overtime) and Arena mode (rounds, full loadout).
- Bots with skill-scaled reaction, aim and movement (strafe jumping, dodging, item timing) for practice.
- Direct browser-to-browser play over WebRTC with a copy/paste invite code: no server at all.
- No build step: plain ES modules served straight from the repo.

## Requirements

- Node.js 24 (uses the built-in `WebSocket` client for tests and `node --test`). Node 22 also works.
- A current Chromium, Firefox or Safari with WebGL2 and pointer lock. Edge/Chrome are used for the evidence captures.
- No accounts, no paid services. The only npm dependencies are `three`, `ws` and (dev) `puppeteer-core`.

## Install

```sh
git clone <this repo>
cd ccode
npm install
```

## Run a server and play

```sh
node server/index.mjs                     # http://localhost:27960, map arena_duel, duel mode
node server/index.mjs --bots 1            # with one bot waiting
node server/index.mjs --port 27960 --map arena_duel --mode duel --timelimit 10
```

Open `http://localhost:27960/` in a browser. Enter a name, leave the server field as is, click **CONNECT**.
The match starts (3 s countdown) as soon as two players are in. Click **PRACTICE VS BOT** to play against a bot
on the same server; the bot leaves automatically when a second human joins.

URL parameters for automation: `?auto=1&bot=1&nolock=1&name=Me` joins a practice match without pointer lock.

### Server flags

```
--port N          TCP port for HTTP + WebSocket (default 27960)
--host ADDR       bind address (default 0.0.0.0; use 127.0.0.1 to keep it local)
--map NAME        map module in maps/ (default arena_duel; testbox is the small test map)
--mode duel|arena
--bots N          add N bots (0-2)      --bot-skill 0..1 (default 0.7)
--snap-rate N     snapshots per second 20..60 (default 60)
--timelimit MIN   duel time limit in minutes (default 10)
--no-lagcomp      disable hitscan lag compensation
--latency MS --jitter MS --loss PCT   simulate network conditions for every client (testing only)
--netsim-query    let each client pick its own simulated conditions via ws://host:port/?latency=&jitter=&loss= (testing only)
--seed N          simulation seed (bots, spread)
--quiet           no periodic tick statistics
```

`GET /info` returns JSON (map, mode, players, protocol version, tick and snapshot rate, match state) and is what the
client uses to learn which map the server runs.

## LAN play

Start the server on one machine and give the others its LAN address: `http://192.168.1.20:27960/`. The client
connects its WebSocket to the same host and port it was served from, so nothing else needs to be configured.
Windows may ask to allow Node through the firewall on the first start; TCP 27960 must be allowed.

## Internet play

The server needs one reachable TCP port (default 27960). Options, all free:

- **Port forwarding**: forward TCP 27960 on your router to the machine running the server, then share your public IP
  (`http://<public-ip>:27960/`). The connection is plain HTTP/WS; do not expose anything else on that machine.
- **Tailscale** (free personal plan, requires creating a Tailscale account): both players install Tailscale, then the
  guest opens `http://<tailnet-ip>:27960/`. No port forwarding, traffic is encrypted, works behind CGNAT.
- **cloudflared quick tunnel** (free, no account for the quick-tunnel mode): `cloudflared tunnel --url http://localhost:27960`
  prints a `https://<random>.trycloudflare.com` URL; share it. WebSockets are supported; the client automatically uses
  `wss://` when the page is served over HTTPS. Adds some latency (traffic goes through Cloudflare's edge).
- **ngrok** (free tier requires an ngrok account): `ngrok http 27960`, share the `https://…ngrok-free.app` URL.
  The free tier shows an interstitial page on first visit and has bandwidth limits.

For a competitive game, port forwarding or Tailscale keep the round-trip time lowest. Ping 100-150 ms is still
playable thanks to lag compensation; see `docs/NETWORKING.md` for measurements.

## Direct P2P play (no server)

The browser can host the match itself over a WebRTC DataChannel; signaling is done by copying two short codes:

1. Host: open the client page (any copy of it, e.g. a local `node server/index.mjs` on your own machine or a static
   file host), open **Direct P2P**, click **HOST GAME**. The menu stays open with the invite code in the box; send it
   to your opponent (chat, email). The arena opens automatically once the guest connects.
2. Guest: paste the invite code into the box and click **JOIN WITH CODE**. An answer code appears; send it back.
3. Host: paste the answer code and click **JOIN WITH CODE**. The connection opens and the match starts.

The host runs the authoritative simulation in its browser tab (same code as the server), so the host has zero ping
and the guest has the peer-to-peer round-trip. Both sides use Google's public STUN servers to find their addresses;
with two symmetric NATs the direct connection can fail (30 s timeout), in which case use one of the server options.

## Controls

| Action | Keys |
|---|---|
| Move | W A S D (arrow keys also work) |
| Jump | Space |
| Crouch | Ctrl, C or Shift |
| Fire | Left mouse button |
| Weapons | 1 gauntlet, 2 machinegun, 3 shotgun, 4 rocket launcher, 5 lightning gun, 6 railgun, 7 plasma gun; mouse wheel / Q / E cycle |
| Scoreboard | Tab (hold) |
| Menu / release mouse | Esc |

Mouse look uses Q3's `m_yaw 0.022` degrees per count times the sensitivity setting.

## Settings

In the menu under **Settings** (stored in `localStorage`): sensitivity (1-20), field of view (80-130), master volume,
large crosshair, and interpolation buffer in snapshots (1-4; 2 = 33 ms is the default and what the lag compensation
is tuned for; raise it on very jittery connections).

## Tests and evidence

```sh
node --test "tests/*.test.mjs"                 # benchmark, gameplay rules, netcode end-to-end (about 70 s)
node tools/bot_duel.mjs --map arena_duel --seconds 180 --quiet    # headless bot-vs-bot duel report (frags, accuracy, liveliness)
node tools/netbench.mjs                        # latency/jitter/loss table (prediction error, rates, bandwidth, tick cost)
node tools/evidence.mjs --name run1 --port 27970 --seconds 20 [--latency 150 --jitter 30 --loss 2] [--headed]
node tools/screenshots.mjs --map arena_duel --port 27973   # vantage/effect screenshots + tone and performance metrics into .evidence/screens/
node tools/audio_measure.mjs --port 27974                  # offline render of every cue, loudness/attenuation rules, .evidence/audio/measure.json
```

`tools/evidence.mjs` starts a server with a bot, drives a real headless Edge/Chrome through puppeteer-core with
scripted input and writes screenshots plus fps/frame-time/netcode statistics to `.evidence/<name>/stats.json`.

The test files: `tests/benchmark.test.mjs` asserts every `[test]` row of `docs/BENCHMARK.md` against the constants and
against live simulation measurements; `tests/game.test.mjs` covers damage/armor/knockback, splash, rocket jumps,
items, spawns, telefrag, duel and arena match flow, out-of-ammo switching, lag-compensation rewind and the bots;
`tests/netcode.test.mjs` runs the real server with two headless clients at 0 ms, 100 ± 20 ms / 2 % and
150 ± 30 ms / 2 % loss and checks prediction error, acks, snapshot rate, consistency, lag compensation hit rates
(with and without `--no-lagcomp`) and server robustness (protocol check, malformed/flooded commands, disconnects).

## Layout

```
shared/     constants.js (Q3 values), vec3, brush, trace (box sweeps), pmove (bg_pmove port), map (builder DSL),
            game.js (players, weapons, projectiles, damage, items, match), bot.js, session.js (transport-agnostic
            authoritative session), protocol.js
server/     index.mjs (HTTP static + WebSocket server, flags), netsim.mjs (latency/jitter/loss simulator)
client/     main.js, input.js, hud.js, net/ (clientgame.js prediction+interpolation, transport.js WebSocket/WebRTC,
            host.js browser P2P host, headless.js Node driver for tests), render/, audio/
maps/       map modules (build(m) with the MapBuilder DSL); arena_duel.js is the competitive map
tools/      bot_duel.mjs, netbench.mjs, evidence.mjs, screenshots.mjs, audio_measure.mjs
tests/      node:test suites
docs/       BENCHMARK.md (reference targets), NETWORKING.md, LEDGER.md (progress), AUDIO.md
```

## Survival slice: Millbrook, Survive the Night (`/survival`)

A Project Zomboid-style survival prototype (fixed 3/4 camera, one deterministic 30 Hz simulation) whose
moment-to-moment loop follows 7 Days to Die: loot a small town, manage hunger/thirst/stamina/bleeding, sneak past or
fight zombies that see and hear you, chop trees for planks, barricade a house before 21:00, and survive the blood-moon
horde waves (22:00, 00:00, 03:00) until 06:00. The benchmark mapping and acceptance tests are in
`docs/SURVIVAL_BENCHMARK.md`; progress and verdicts in `docs/SURVIVAL_LEDGER.md`.

```sh
node server/index.mjs --quiet            # same server as the arena
# open http://localhost:27960/survival
```

| Action | Keys |
|---|---|
| Move / sprint / sneak | W A S D / Shift / Ctrl (or C) |
| Attack (aim with the mouse) | Left mouse button (or Space) |
| Interact: loot, doors, chop trees | E |
| Barricade the nearest door or window (2 planks) | B |
| Weapons | 1 fists · 2 bat · 3 pistol · mouse wheel · R reload |
| Eat / drink / bandage | F / G / H |
| Inventory / pause | Tab (or I) / Esc |

URL parameters: `?auto=1` starts immediately, `fast=N` multiplies game time (evidence runs use 4-8), `seed=N`,
`nohorde=1`, `autopilot=win|reckless` lets `shared/survival/autopilot.js` play.

```sh
node --test tests/survival_sim.test.mjs        # rules + autopilot completes the slice (headless, seconds)
node --test tests/survival_client.test.mjs     # real headless Edge: no errors, frame p99, cue/event alignment
node tools/survival_evidence.mjs --name run1 --port 27995 --fast 4    # screenshots + state/event/audio logs + metrics into .evidence/survival/run1/
node tools/survival_audio_measure.mjs          # offline render of every cue: peak/duration table, clipping check
```
