// Browser-hosted authoritative session for direct P2P play (host is also a player via a loopback link).
import { GameSession, loopbackPair } from '../../shared/session.js';
import { RtcTransport } from './transport.js';

export class BrowserHost {
  constructor(map, opts = {}) {
    this.session = new GameSession(map, { mode: opts.mode || 'duel', snapRate: opts.snapRate || 60, lagComp: true, log: opts.log || (() => {}) });
    this.timer = setInterval(() => this.session.frame(performance.now()), 4);
    this.peers = [];
  }
  // Returns a link the local ClientGame can use as its transport.
  localLink() {
    const [a, b] = loopbackPair();
    this.session.attach(b, { local: true, addr: 'host' });
    return a;
  }
  // Create an invite code for a remote guest; resolves with the code. Call acceptAnswer with the guest's reply.
  async invite() {
    const rtc = new RtcTransport();
    const link = { onmessage: null, onclose: null, send: (o) => rtc.send(o), close: () => rtc.close() };
    rtc.onmessage = (m) => link.onmessage && link.onmessage(m);
    rtc.onclose = () => link.onclose && link.onclose();
    rtc.onopen = () => this.session.attach(link, { addr: 'p2p' });
    this.pendingRtc = rtc;
    return rtc.createOffer();
  }
  async acceptAnswer(code) { await this.pendingRtc.acceptAnswer(code); }
  addBot(skill) { return this.session.addBot(undefined, skill); }
  close() { clearInterval(this.timer); for (const c of this.session.clients.values()) c.link.close(); }
}
