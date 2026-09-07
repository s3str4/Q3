# Networking

The goal is a 1v1 that feels like a LAN Quake III game at typical internet pings. This document describes the
architecture, what is measured, and the known limits. Everything below is asserted by `tests/netcode.test.mjs`
and measured by `tools/netbench.mjs` against the real server and real WebSockets.

## Architecture

```
browser client                                   Node server (or browser P2P host)
---------------                                  ---------------------------------
60 Hz fixed-step input sampling                  60 Hz fixed-step simulation (shared/game.js)
  -> usercmd {seq, forward, right, up, buttons,    queueCommand(): dedupe, order by seq, cap 90
     angles, weapon, vt}                          step(): run <= 4 queued cmds per player per tick,
  -> sent as the last 3 cmds per message                  projectiles, items, match
     (loss tolerance on unreliable channels)      snapshot every tick (60 Hz, configurable 20-60)
prediction: run the cmd locally at once             -> {t, tick, players[], projectiles[], items[], match, events[]}
reconciliation on every snapshot:                 ack = last executed seq per player
  apply authoritative state, replay unacked cmds  lag compensation: hitscan rewinds other players to the
interpolation of remote players between the         shooter's `vt` (render time), capped at 250 ms
  two snapshots around renderTime
```

**Simulation.** One deterministic simulation (`shared/`) runs on the server and inside the client for prediction:
a Q3 `bg_pmove.c` port on a fixed 1/60 s step, box sweeps through convex brushes, weapons, items and match rules.
Commands are the only input; a command always advances the player by exactly one 1/60 s step, on both sides.

**Server tick and snapshots.** 60 Hz tick, snapshots every tick by default (`--snap-rate 20..60`). Q3 defaults to
`sv_fps 20`; CPMA servers run 30-40. Snapshots are JSON (`shared/protocol.js` quantizes remote positions to 1/128
unit and velocities to 1/16 to keep them small; the local player's own state is sent exactly so replay is bit-exact).

**Prediction and reconciliation.** The client runs every command immediately through the shared `Game`
(`runPlayerCommand(p, cmd, predict=true)`: movement, triggers, weapon timers and ammo, but no damage and no
projectile spawning). On each snapshot it applies the authoritative state and replays the commands the server has
not acknowledged (`ack`). The difference between the previously predicted position and the replayed one is the
misprediction; corrections above 0.5 units are smoothed on the view over 100 ms. Respawns and teleports move the
player by design and are not counted as corrections.

Two server-side rules keep prediction exact under jitter: (1) commands are executed only when they arrive (Q3 does
the same; there is no "guess" step for a tick with no command), so timer phase differences between client and server
never desync the state, and the server "coasts" a player with empty commands only after 500 ms of silence (a frozen
tab or a real stall); (2) redundant or reordered commands are deduplicated and ordered by `seq` before execution.

**Interpolation.** Remote players and projectiles are rendered at `renderTime = arrivalClock - 2 snapshots (33 ms)`.
The render clock is derived from snapshot *arrival* (a low percentile of `snap.t - recvAt` over the last 1.5 s), like
Q3's `cl.serverTime`, so the client always has a snapshot on both sides of the render time and interpolates. It
extrapolates at most 50 ms from velocity when a snapshot is late or lost. The interpolation buffer is a client setting
(1-4 snapshots); 2 is the default.

**Lag compensation.** Every command carries `vt`, the render time of the remote positions the player was looking at.
For hitscan weapons (machinegun, shotgun, lightning gun, railgun, gauntlet) the server rewinds the other player to
`vt` using a per-tick position history (64 ticks, linear interpolation between ticks), capped at 250 ms in the past.
Projectiles are not compensated (as in Q3). Bots are never rewound. `--no-lagcomp` disables it.

Measured in `tests/netcode.test.mjs`: a client with 150 ms simulated ping firing the lightning gun at the position it
renders for a target strafing at 320 ups (reversing every second) registers **154-160 of 160 hits (96-100 %)** with
lag compensation and **8-9 of 160 (5-6 %)** with `--no-lagcomp`. The rewind amount at 150 ms ping is
RTT + interpolation delay ~ 185-220 ms, inside the 250 ms cap.

**Transport.** WebSocket over TCP for client/server. TCP is reliable and ordered: no packet loss to handle, but a
lost segment stalls everything behind it until it is retransmitted (head-of-line blocking), which shows up as a burst
of late snapshots and a burst of commands executed together on the server. The design tolerates that (prediction is
exact after a burst; interpolation buffers 33 ms). WebRTC DataChannels (unordered, `maxRetransmits: 0`) are used for
direct P2P play; there, the 3-command redundancy and the JOIN retry (every 500 ms until WELCOME) provide loss
tolerance, and out-of-order commands are reordered in the queue when they arrive before their tick.

**Server robustness** (`shared/session.js`, `server/index.mjs`): every command field is validated (finite numbers in
range, integer seq, buttons/weapon ranges) and invalid commands are dropped; per-client rate limiting (max 120 new
commands per second, max 8 commands per message, queue capped at 90 = 1.5 s); 16 KB WebSocket payload cap; protocol
version check on JOIN (mismatch -> KICK with reason); a player leaving mid-match leaves the other playing until the
time limit (they win); `GET /info`; `--host` bind address.

## Ports and NAT

- Server: one TCP port, default **27960**, for both the static client and the WebSocket. Forward it on the router
  or use Tailscale / a cloudflared quick tunnel / ngrok (see README).
- P2P: WebRTC uses UDP ports chosen by the browser; STUN (`stun.l.google.com:19302`) discovers the public address.
  Works through most home NATs; fails behind two symmetric NATs (no TURN server is configured, to stay free).
- The client always connects to the host and port the page was served from (`ws://` or `wss://` matching the page).

## Testing with simulated conditions

```sh
node server/index.mjs --latency 100 --jitter 20 --loss 2      # every client gets these conditions
node server/index.mjs --netsim-query                          # clients choose: ws://host:port/?latency=150&jitter=30&loss=2
node tools/evidence.mjs --name lag --port 27970 --latency 150 --jitter 30 --loss 2   # real browser + screenshots + stats
node tools/netbench.mjs                                       # the table below
node --test tests/netcode.test.mjs
```

`server/netsim.mjs` delays each message by latency/2 ± jitter/2 per direction and drops `loss` % of messages, keeping
delivery order per direction (like TCP) so jitter shows up as bunching, not reordering.

## Netbench

`node tools/netbench.mjs` (testbox, 8 s per row, two scripted clients running/strafing/jumping, Node v24.19.0,
Windows 11, in-process server):

| latency ± jitter / loss | measured RTT | mispred. max (units) | corrections | snapshot Hz | cmd Hz | in KB/s per client | out KB/s per client | server tick ms avg / max |
|---|---|---|---|---|---|---|---|---|
| 0 ± 0 ms / 0% | 0 ms | 0.000 | 0 | 60.0 | 60.0 | 61.0 | 14.2 | 0.161 / 0.75 |
| 50 ± 10 ms / 0% | 63 ms | 0.000 | 0 | 60.1 | 59.9 | 61.2 | 20.8 | 0.100 / 0.48 |
| 100 ± 20 ms / 2% | 120 ms | 0.000 | 0 | 58.5 | 60.1 | 59.9 | 20.8 | 0.097 / 0.30 |
| 150 ± 30 ms / 2% | 163 ms | 0.000 | 0 | 58.7 | 60.1 | 59.9 | 20.9 | 0.127 / 0.58 |
| 250 ± 50 ms / 5% | 278 ms | 0.000 | 0 | 57.0 | 60.0 | 58.5 | 20.9 | 0.094 / 0.61 |

Movement-only prediction error is zero at every setting (the replayed state is bit-identical to the predicted one).
Corrections in real play come from things the client cannot know in advance: knockback from being hit, collisions
with the other player, and match-state changes; `tests/netcode.test.mjs` bounds those at 150 ms combat to < 64 units
and verifies frags/deaths/health stay consistent across server and both clients.

Real browser (`tools/evidence.mjs`, headless Edge, 1920x1080, practice vs bot): at 0 ms RTT 4 ms, 120 fps, 60 Hz
snapshots, misprediction max 0.53 units / 14 corrections in 20 s (all from bot hits); at 150 ± 30 ms / 2 %
RTT 169 ms, misprediction 0 / 0 corrections, 120 fps.

Bandwidth: about 60 KB/s down and 21 KB/s up per client at 60 Hz (JSON, no delta compression) — about 0.5 Mbit/s
down, fine for broadband; `--snap-rate 30` halves it.

## Known limits

- JSON snapshots without delta compression: ~1 KB per snapshot. A binary/delta protocol would cut bandwidth ~5x.
- The rewind cap of 250 ms means players above ~200 ms ping get partially compensated hitscan (Q3 unlagged has the
  same kind of cap). Projectiles are never compensated.
- TCP head-of-line blocking: a lost segment on a bad link delays everything behind it; there is no UDP path for the
  client/server mode (browsers cannot open raw UDP; WebTransport would be the upgrade path).
- P2P without TURN fails behind symmetric NATs; the host has a 0 ms advantage (the simulation runs in its tab).
- Prediction covers movement, triggers and weapon timing; damage, pickups and projectile spawns are server-only, so
  a rocket appears after one RTT (the fire sound and muzzle flash are immediate).
- `node --test tests/` (the `npm test` script) does not run on Node 24 (a directory argument is treated as a file);
  use `node --test "tests/*.test.mjs"`.
