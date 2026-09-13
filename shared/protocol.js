// Wire protocol: JSON messages over WebSocket / DataChannel. Small, explicit, versioned.
export const PROTOCOL_VERSION = 4;
export const PORT = 27960;

// Client -> server: JOIN, CMD, PING, CHAT, VOTE (next map/mode pick during the intermission), REMATCH (ready toggle),
// LOADED (the client finished loading the map named in MAPCHANGE / WELCOME and can take part in the countdown).
// Server -> client: WELCOME, SNAP, PONG, CHAT, KICK, INFO, VOTES (live intermission state: everyone's pick, who is
// ready, the resolved next map/mode and the auto-restart time), MAPCHANGE (rebuild the client game for map/mode X).
export const MSG = {
  JOIN: 'join', WELCOME: 'welcome', CMD: 'cmd', SNAP: 'snap', PING: 'ping', PONG: 'pong', CHAT: 'chat', KICK: 'kick', INFO: 'info',
  VOTE: 'vote', REMATCH: 'rematch', LOADED: 'loaded', VOTES: 'votes', MAPCHANGE: 'mapchange',
};

export function encode(msg) { return JSON.stringify(msg); }
export function decode(str) { try { return JSON.parse(str); } catch { return null; } }

// Round numbers for the wire (positions to 1/128 unit, angles to 1/100 deg) - keeps JSON compact without breaking prediction.
export function q(n, s = 128) { return Math.round(n * s) / s; }
export function qv(v, s = 128) { return [q(v[0], s), q(v[1], s), q(v[2], s)]; }

export function compactSnapshot(snap, forId) {
  return {
    t: snap.t, tick: snap.tick,
    players: snap.players.map((p) => ({ ...p, o: p.id === forId ? p.o : qv(p.o), v: p.id === forId ? p.v : qv(p.v, 16), a: [q(p.a[0], 100), q(p.a[1], 100)] })),
    projectiles: snap.projectiles.map((pr) => ({ ...pr, o: qv(pr.o), v: qv(pr.v, 16) })),
    items: snap.items, match: snap.match, ev: snap.ev,
  };
}
