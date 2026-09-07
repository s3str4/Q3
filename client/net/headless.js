// Headless client driver for Node (tests, netbench): a real ClientGame over a real WebSocket, driven by a script
// at the same fixed 60 Hz step the browser client uses (client/main.js simStep). No rendering, no audio.
//
//   const c = await connectHeadless({ url: 'ws://localhost:27990', map, name: 'A', script: (t, cg) => ({ forward: 127 }) });
//   ... await c.waitFor((cg) => cg.predicted && !cg.predicted.dead) ...
//   c.stop();
//
// The script returns a partial input { forward, right, up, buttons, pitch, yaw, weapon } for the current sim time (s).
import { ClientGame } from './clientgame.js';
import { WsTransport } from './transport.js';
import { TICK_MS } from '../../shared/constants.js';

const EMPTY = { forward: 0, right: 0, up: 0, buttons: 0, pitch: 0, yaw: 0, weapon: 0 };

export async function connectHeadless({ url, map, name = 'headless', script = null, mode = 'duel', bot = false, botSkill = 0.6, interpSnaps = 2, onEvent = null }) {
  const transport = new WsTransport(url);
  await transport.connect();
  const events = [];
  const cg = new ClientGame(map, transport, { mode, name, interpSnaps, onEvent: (e, predicted) => { events.push({ ...e, predicted, at: cg.game.time }); if (onEvent) onEvent(e, predicted); } });
  let kicked = null; let closed = false;
  cg.onKick = (r) => { kicked = r; };
  transport.onclose = () => { closed = true; };
  cg.join({ bot, botSkill });
  const t0 = performance.now();
  let acc = 0, last = 0, steps = 0;
  const yawState = { yaw: 0, pitch: 0 };
  const inputAt = (t) => ({ ...EMPTY, yaw: yawState.yaw, pitch: yawState.pitch, ...(script ? (script(t, cg, yawState) || {}) : {}) });
  const timer = setInterval(() => {
    if (closed) return;
    const now = performance.now();
    acc += last ? now - last : TICK_MS; last = now;
    let n = 0;
    while (acc >= TICK_MS && n < 5) {
      const t = (now - t0) / 1000;
      const inp = inputAt(t);
      if (cg.runCommand(inp)) steps++;
      acc -= TICK_MS; n++;
    }
    if (acc > TICK_MS * 5) acc = 0;
    cg.interpolate();
  }, 4);
  const handle = {
    cg, transport, events, yawState,
    get id() { return cg.localId; },
    get player() { return cg.predicted; },
    get kicked() { return kicked; },
    get closed() { return closed; },
    get steps() { return steps; },
    remote(id) { return cg.remote.get(id) || null; },
    stats() { return cg.netStats(); },
    async waitFor(pred, timeoutMs = 10000, pollMs = 10) {
      const until = performance.now() + timeoutMs;
      while (performance.now() < until) { if (pred(cg, handle)) return true; await sleep(pollMs); }
      throw new Error('waitFor timed out: ' + pred.toString().slice(0, 120));
    },
    stop() { clearInterval(timer); cg.close(); },
  };
  return handle;
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
