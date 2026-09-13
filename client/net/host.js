// Browser-hosted authoritative session for direct P2P play (host is also a player via a loopback link).
import { GameSession, loopbackPair } from '../../shared/session.js';
import { RtcTransport, PeerTransport } from './transport.js';

export class BrowserHost {
  // opts: mode 'duel' | 'arena', rules (match rule overrides, e.g. shorter rounds for automation), snapRate, log
  constructor(map, opts = {}) {
    this.session = new GameSession(map, { mode: opts.mode || 'duel', snapRate: opts.snapRate || 60, lagComp: true, rules: opts.rules || {}, log: opts.log || (() => {}) });
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
  // Register a room on the PeerJS signaling server; the guest joins with the short code. Resolves with the code.
  async inviteRoom(code) {
    const pt = new PeerTransport();
    const link = { onmessage: null, onclose: null, send: (o) => pt.send(o), close: () => pt.close() };
    pt.onmessage = (m) => link.onmessage && link.onmessage(m);
    pt.onclose = () => link.onclose && link.onclose();
    pt.onopen = () => this.session.attach(link, { addr: 'p2p-room' });
    await pt.host(code);
    this.pendingPeer = pt;
    return code;
  }
  addBot(skill) { return this.session.addBot(undefined, skill); }
  close() { clearInterval(this.timer); for (const c of this.session.clients.values()) c.link.close(); }
}
