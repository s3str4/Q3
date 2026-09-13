# Arena Duel

A Quake III Arena-style 1v1 duel that runs in the browser: Three.js renderer, synthesized Web Audio, and a headless
Node authoritative server, all sharing one deterministic simulation (`shared/`) that ports Q3's `bg_pmove.c` movement,
brush tracing, weapons, items and match rules. The feel targets are written down in `docs/BENCHMARK.md` and asserted
by the test suite; the netcode design is in `docs/NETWORKING.md`.

- 60 Hz server tick and 60 Hz snapshots (Q3 default is 20 Hz), client-side prediction with reconciliation,
  2-snapshot interpolation for remote players, lag-compensated hitscan (rewind capped at 250 ms).
- Duel mode (10 min, item control, sudden-death overtime) and Arena mode (rounds with a 3-2-1 countdown, full loadout,
  100/100, no pickups, first to 6 of 10), both selectable in the menu.
- End-of-match screen (frags, deaths, damage, accuracy overall and per weapon) with REMATCH and a live map/mode vote;
  the next match starts when both players are ready (bots always are) or by itself after 30 s.
- Bots in four difficulty tiers (Easy / Normal / Hard / Pro) with skill-scaled reaction, aim, dodging and movement
  (strafe jumping, item timing) for practice.
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

### Menu options

- **Map**: the arena for sessions you host (practice, P2P host). On a dedicated server the map comes from the server.
- **Mode**: *Duel* (10 minutes, item control, overtime) or *Arena* (rounds: everyone spawns with every weapon and
  100 health / 100 armor, no pickups, a 3-2-1 countdown before each round, a round ends at the first kill or after
  90 s in favour of the healthier player, first to 6 rounds wins). Applies to practice and to P2P hosting; the guest
  receives the host's mode and map in the handshake. A dedicated server keeps its `--mode`.
- **Physics**: *VQ3* (vanilla Quake 3 movement, the default) or *CPM* (Challenge ProMode air control). A match
  rule like the mode: the host picks it, the guest receives it in the WELCOME / MAPCHANGE `rules.physics` and both
  the server and the client prediction run the same code (`shared/pmove.js`, `ctx.physics`). CPM keeps vq3 ground
  acceleration and friction and `pm_airaccelerate 1` for diagonal strafes, and adds the CPMA air rules: a pure
  forward/back input steers the horizontal velocity toward the view (`PM_Aircontrol`, `cpm_aircontrol 150`), a
  sideways-only strafe is capped at `cpm_airwishspeed 30` with `pm_strafeaccelerate 70` (the A/D air strafe), and
  reversing direction uses `cpm_airstopaccelerate 2.5`. Measured in `tests/physics_cpm.test.mjs`: holding forward
  in the air with the view 60 degrees off the velocity turns the heading to 60.0 degrees in 40 ticks under CPM
  (19.1 under vq3); a perpendicular side strafe reaches 395.5 ups after 60 ticks (322.7 under vq3). Bots run the same
  pmove, so they adapt by themselves. A dedicated server keeps its own rules (`createServer({ rules: { physics } })`).
- **Bot**: practice difficulty. Easy / Normal / Hard / Pro map to bot skill 0.3 / 0.6 / 0.8 / 0.95 (reaction 420 to
  160 ms, aim noise 6.6 to 1.4 degrees, dodge chance 25 to 90 %, more frequent strafe changes and hops, a stricter
  rail trigger at the top). In 180 s headless duels a Pro bot beats a Normal one about 3:1 and an Easy one loses to
  Normal about 1:2 (`node tools/scratch/bot_tiers.mjs --a 0.95 --b 0.6`).

### End of a match

When a match ends (duel time limit / overtime frag, arena majority) the end screen comes up over the HUD: winner,
a table per player (frags, deaths, damage, accuracy overall and per weapon) and the match duration. Underneath, the
next match: pick a **map** and a **mode** (every player's pick is shown live; both the same means that map, otherwise
the host's / first player's pick wins) and click **REMATCH**. The next match starts with the usual countdown as soon
as both players are ready (a bot is always ready); without any click it restarts by itself after 30 s. A map change
reloads the arena on every client first: the countdown waits until everyone has loaded.

URL parameters for automation: `?auto=1&bot=1&nolock=1&name=Me` joins a practice match without pointer lock;
`?auto=1&local=1` runs a browser-hosted practice match instead; `mode=arena`, `skill=pro`, `map=lava_spire`,
`physics=cpm`, `skin=visor`, `color=2` pre-select the menu; `rules={"rounds":3,"roundTimelimit":6000}` overrides the
match rules of a browser-hosted session and `map=testbox` may name any map module (both only honoured when the page
is served from localhost).

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

## Direct P2P play (no server): room codes

The browser can host the match itself over a WebRTC DataChannel. Finding each other uses a short room code:

1. Host: open **Direct P2P**, click **HOST GAME**. A 5-letter room code appears (e.g. `XDQVH`) with **COPY CODE** /
   **COPY LINK** buttons. Send either to your opponent. The menu stays open until they join.
2. Guest: type the code in the ROOM CODE box and press **JOIN** (or just open the link, which joins automatically).
3. Both arenas open with the countdown. The host runs the authoritative simulation (zero ping for the host, the
   direct peer-to-peer round trip for the guest).

The room lookup goes through the public PeerJS signaling server (free, no account, only used to exchange the
connection descriptions); the game traffic itself flows directly between the two browsers. If that service is
unreachable, the **Manual exchange** fallback under the same panel works with no third party at all: HOST (MANUAL)
produces an invite code/link, the guest's page answers with a code, the host pastes it (5-minute window).

Both sides use Google's public STUN servers to find their public addresses; with two symmetric NATs the direct
connection can fail, in which case use one of the server options above.

## Static hosting (GitHub Pages): play from a link, no server

The client can be hosted as plain static files, so your opponent only needs a link:

```bash
npm run build:static      # writes dist/ (client + shared sim + maps + the three.js files it uses, ~2 MB)
npm run serve:static      # optional local preview of dist/ on http://localhost:8080 (no game server behind it)
```

GitHub Pages: push this repository to GitHub, then in the repository open Settings > Pages and set Source to
"GitHub Actions". The workflow in `.github/workflows/pages.yml` builds `dist/` and deploys it on every push to
`main`; the page is served at `https://<user>.github.io/<repo>/`.

On a static page there is no game server, so the page opens the **Direct P2P** panel by itself: HOST GAME, send
the room code or link, done (see "Direct P2P play" above). Any static host works the same way (Netlify, Cloudflare
Pages, a plain web server) as long as it serves `dist/` over HTTPS.

## Controls

Default bindings (every one of them can be changed, see **Keys** below):

| Action | Keys |
|---|---|
| Move | W A S D (arrow keys also work) |
| Jump | Space |
| Crouch | Ctrl, C or Shift |
| Fire | Left mouse button |
| Zoom | Right mouse button |
| Weapons | 1 gauntlet, 2 machinegun, 3 shotgun, 4 rocket launcher, 5 lightning gun, 6 railgun, 7 plasma gun; mouse wheel / Q / E cycle |
| Scoreboard | Tab (hold) |
| Menu / release mouse | Esc |

Mouse look uses Q3's `m_yaw 0.022` degrees per count times the sensitivity setting.

## Settings

In the menu under **Settings** (stored in `localStorage`): sensitivity (1-20), field of view (80-130), master volume,
large crosshair, and interpolation buffer in snapshots (1-4; 2 = 33 ms is the default and what the lag compensation
is tuned for; raise it on very jittery connections).

**Skin and colour**: pick one of the three player models (Sarge, Visor, Anarki) and a colour from a Q3-like palette
(red, orange, yellow, green, cyan, blue, purple, magenta, white); the preview shows the figure with the colour on the
visor and the chest stripe. The choice is sent in JOIN (`skin`, `color`) and echoed in every snapshot player entry
(`sk`, `col`), so the opponent sees your model in your colour (the emissive stripe and visor), your rail trail and rail
impact are drawn in your colour on both screens (Q3 `color1`), the first-person arms wear your skin, and the HUD
score boxes, obituaries and the scoreboard show names in their colours. The session validates both (an unknown skin
or colour index means the defaults); bots keep their name-derived skins and the default colours. The protocol
version stays 4: the new fields are optional on both sides.

**Keys**: the panel lists every action (move, jump, crouch, fire, zoom, weapons 1-7, next / previous weapon,
scoreboard) with its current binding. Click a binding, then press a key, a mouse button or turn the wheel to rebind
it (Esc cancels); a key can only drive one action, so binding it elsewhere unbinds it there. Mouse buttons appear as
LMB / MMB / RMB, the wheel as WHEEL UP / WHEEL DOWN. **Reset defaults** restores the table above. Bindings live in
`localStorage` with the other settings; `client/input.js` resolves everything through the bindings map, and the help
line under the menu shows the current summary.

## Announcer and voices

The Q3 announcer is back: **3, 2, 1, Fight!** on every countdown, medals as they happen, lead changes, frag and time
warnings, and **You win / You lose** after the fanfare. Every call is decided by the server (or the P2P host) in
`shared/game.js` and sent as an event, so both players hear the same thing at the same moment and demos replay them:

| Call | When |
|---|---|
| EXCELLENT | two frags within 3 s (Q3 `CARNAGE_REWARD_TIME`) |
| IMPRESSIVE | two consecutive rail hits; a miss resets the streak |
| HUMILIATION | a gauntlet frag (the victim hears it too) |
| PERFECT | an arena round won without taking any damage |
| You have taken / lost the lead, tied for the lead | duel score changes, to the player concerned |
| Three / two / one frag(s) left | fraglimit games, as the leader closes in |
| Five / one minute warning | timelimit games |
| Sudden death | overtime |

Medals pop above the crosshair as a badge with a counter, the other calls appear as a short line so they read with the
voice off, and the end-of-match table gets a MEDALS column. The clips live in `client/audio/voice/` (21 WAVs, 1.1 MB,
22 kHz mono) and are generated by `tools/voice_build.mjs`: Windows speech synthesis at the lowest pitch, then trimmed,
slowed and pitched down 38% (about 8 semitones, formants included), a +7 dB low shelf, saturated, given a short arena slap-back and a 4 kHz roll-off (the Q3 register, without
Q3's files). Re-run the tool to change a line or the treatment; `--no-tts` re-processes the previous takes. Settings >
**Announcer voice** turns the voice off (the beeps and the fight chord come back). Player bodies are pitched per skin
too (Sarge lower, Anarki higher) so the two throats in a duel are told apart.

## Demos

Every match is recorded (Settings > **Record demos**, on by default) the way Quake 3 records a demo: from the
countdown to MATCH_END the client keeps everything it received (the WELCOME with map / mode / rules, every snapshot
with its arrival time and the events it carried, the final MATCH_END summary) plus its own first-person view sampled
per rendered frame (the predicted origin and the mouse angles at render time, ~60 Hz), so a replay shows exactly what
the recorder saw. Leaving mid-match keeps a partial demo. The last 10 demos live in IndexedDB; the menu's **Demos**
panel lists them (date, map, mode, players, score) with **PLAY**, **DOWNLOAD** (`<date>_<map>_<mode>_<players>.json.gz`
via CompressionStream, plain `.json` where the browser lacks it) and **DELETE**; **LOAD FILE** imports a demo someone
sent (`.json` or `.json.gz`).

Format (`client/demo.js`, `DEMO_FORMAT` 1): a JSON object with the header (`map`, `mode`, `rules`, `welcome`, `localId`,
`players` table with names / skins / colours), `snaps` (one integer row per snapshot: server time, tick, arrival offset,
player rows with positions to 1/128 unit, velocities to 1/16 and angles to 1/100 degree - the wire quantisation, so remote
entities decode to the exact values the live client interpolated - projectile rows, an index into the item-state table,
an index into the match-state table, the events), `views` (render time in 0.1 ms, origin, angles, view height, flags),
`end` (the MATCH_END summary). Item arrays and match objects are stored once per distinct value. Measured by
`tests/demo.test.mjs`: about 354 bytes per snapshot row and 40 bytes per view sample, 1.35 MB of JSON per minute
(13 MB for a 10-minute duel in memory as text, far less as packed integer rows), 240 KB per minute gzipped.

Playback (`client/demoplayer.js`) loads the demo's map into the same renderer / HUD / audio as live play and feeds the
recorded snapshots on the recorded timeline (server time; no network, no prediction): remote players, projectiles,
items and events come from the snapshots exactly as in live play, so effects and sounds play back; a snapshot's events
fire when the clock passes its time minus the interpolation delay, which is when a live client received them relative
to what it rendered. The recorder's recorded view drives the first-person camera. Controls (bar at the bottom, also
keys): play / pause (**Space**), timeline scrubber with elapsed / total and a mark per kill (blue: the recorder's frags,
red: deaths), **&larr;** / **&rarr;** seek 5 s, speed 0.25 / 0.5 / 1 / 2 / 4 (**[** / **]**), camera (**C** cycles):
first person of the recorder, third-person chase of either player, free camera (WASD flies along the view, Shift
fast, click the arena to capture the mouse), a frag list on the left (**F** toggles; click a kill to jump 2.5 s before
it), **Tab** scoreboard, **Esc** back to the menu. Seeking in either direction rebuilds the state from the snapshot
pair around the target time (snapshots are full-state), dropping in-flight effects and projectiles, and replays only
the events from there on. Effects and animations run at real time whatever the playback speed (the snapshot timeline
is what is scaled).

Automation: `window.__arena.demo` is the running player (`time`, `duration`, `speed`, `playing`, `seek(ms)`,
`setSpeed(s)`, `setCamera('first' | 'chase' | 'free', playerId)`, `frags`), `window.__arena.demos` the library
(`list()`, `get(id)`, `add(demo)`, `remove(id)`), `window.__arena.recorder` the live recorder.
`tests/demo.test.mjs` records a duel between two headless clients over a real WebSocket and checks the recording
(map / mode / rules, 60 Hz snapshots, the match events, the summary), that a Node-side `DemoCursor` seeking to
arbitrary times returns exactly what a live `ClientGame` interpolates (0 error over 400 seeks) and the recorded view
within its quantisation (0.006 units), that events replay exactly once in order at speed 1 and 4 and after seeks, and
the size per minute.

## Tests and evidence

```sh
node --test "tests/*.test.mjs"                 # benchmark, gameplay rules, arena/rematch match flow, netcode end-to-end, demos (about 90 s)
node tools/bot_duel.mjs --map arena_duel --seconds 180 --quiet    # headless bot-vs-bot duel report (frags, accuracy, liveliness)
node tools/netbench.mjs                        # latency/jitter/loss table (prediction error, rates, bandwidth, tick cost)
node tools/evidence.mjs --name run1 --port 27970 --seconds 20 [--latency 150 --jitter 30 --loss 2] [--headed]
node tools/screenshots.mjs --map arena_duel --port 27973   # vantage/effect screenshots + tone and performance metrics into .evidence/screens/
node tools/audio_measure.mjs --port 27974                  # offline render of every cue, loudness/attenuation rules, .evidence/audio/measure.json
```

`tools/evidence.mjs` starts a server with a bot, drives a real headless Edge/Chrome through puppeteer-core with
scripted input and writes screenshots plus fps/frame-time/netcode statistics to `.evidence/<name>/stats.json`.

The test files: `tests/benchmark.test.mjs` asserts every `[test]` row of `docs/BENCHMARK.md` against the constants and
against live simulation measurements; `tests/physics_cpm.test.mjs` measures the CPM air control against vq3 (heading
change, side-strafe speed, braking, unchanged ground movement, the rule's path through Game / session / WELCOME) and
the JOIN skin / colour validation; `tests/game.test.mjs` covers damage/armor/knockback, splash, rocket jumps,
items, spawns, telefrag, duel and arena match flow, out-of-ammo switching, lag-compensation rewind and the bots;
`tests/netcode.test.mjs` runs the real server with two headless clients at 0 ms, 100 ± 20 ms / 2 % and
150 ± 30 ms / 2 % loss and checks prediction error, acks, snapshot rate, consistency, lag compensation hit rates
(with and without `--no-lagcomp`) and server robustness (protocol check, malformed/flooded commands, disconnects);
`tests/demo.test.mjs` records a real duel and verifies the demo format, the playback cursor against a live ClientGame
and the event replay (see **Demos**).

## Layout

```
shared/     constants.js (Q3 values), vec3, brush, trace (box sweeps), pmove (bg_pmove port), map (builder DSL),
            game.js (players, weapons, projectiles, damage, items, match), bot.js, session.js (transport-agnostic
            authoritative session), protocol.js
server/     index.mjs (HTTP static + WebSocket server, flags), netsim.mjs (latency/jitter/loss simulator)
client/     main.js, input.js, hud.js, demo.js (demo format, recorder, playback cursor: pure, Node-usable),
            demoplayer.js (IndexedDB library, .json.gz files, the demo player + overlay), net/ (clientgame.js
            prediction+interpolation, transport.js WebSocket/WebRTC, host.js browser P2P host, headless.js Node
            driver for tests), render/, audio/
maps/       map modules (build(m) with the MapBuilder DSL); arena_duel.js is the competitive map
tools/      bot_duel.mjs, netbench.mjs, evidence.mjs, screenshots.mjs, audio_measure.mjs, build_static.mjs
tests/      node:test suites
docs/       BENCHMARK.md (reference targets), NETWORKING.md, LEDGER.md (progress), AUDIO.md
```
