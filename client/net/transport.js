// Transports: WebSocket client, and a WebRTC DataChannel pair for direct P2P (host/guest) with manual signaling.
import { encode, decode } from '../../shared/protocol.js';

// Works unchanged in browsers and in Node >= 22 (global WebSocket); bytesIn/bytesOut count wire text bytes for netbench.
export class WsTransport {
  constructor(url) { this.url = url; this.onmessage = null; this.onclose = null; this.onopen = null; this.ws = null; this.bytesIn = 0; this.bytesOut = 0; this.msgsIn = 0; }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => { this.onopen && this.onopen(); resolve(); };
      ws.onerror = () => reject(new Error('websocket error'));
      ws.onclose = () => this.onclose && this.onclose();
      ws.onmessage = (ev) => { if (typeof ev.data !== 'string') return; this.bytesIn += ev.data.length; this.msgsIn++; const m = decode(ev.data); if (m && this.onmessage) this.onmessage(m); };
    });
  }
  send(obj) { if (this.ws && this.ws.readyState === 1) { const s = encode(obj); this.bytesOut += s.length; this.ws.send(s); } }
  close() { this.ws && this.ws.close(); }
  get open() { return !!this.ws && this.ws.readyState === 1; }
}

// ---- WebRTC P2P with a short room code ----
// Signaling goes through the public PeerJS server (free, no account): the host registers the room id, the guest
// looks it up. Game data still flows directly between the two browsers over the DataChannel (reliable+ordered,
// same semantics as the WebSocket path). ROOM_PREFIX namespaces our ids on the shared server.
const ROOM_PREFIX = 'arena-duel-';
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
export function makeRoomCode(n = 5) { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map((v) => ROOM_ALPHABET[v % ROOM_ALPHABET.length]).join(''); }
export function normalizeRoomCode(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^ARENADUEL/, '').replace(/^ARENA/, ''); }

export class PeerTransport {
  constructor() { this.onmessage = null; this.onclose = null; this.onopen = null; this.peer = null; this.conn = null; }
  static available() { return typeof Peer !== 'undefined'; }
  _wire(conn) {
    this.conn = conn;
    conn.on('open', () => this.onopen && this.onopen());
    conn.on('data', (m) => { if (m && typeof m === 'object' && this.onmessage) this.onmessage(m); });
    conn.on('close', () => this.onclose && this.onclose());
    conn.on('error', () => this.onclose && this.onclose());
  }
  // Host: register the room on the signaling server; resolves once the room is live (guest may arrive later).
  host(code) {
    return new Promise((resolve, reject) => {
      const peer = new Peer(ROOM_PREFIX + code.toLowerCase(), { config: RTC_CONFIG, debug: 0 });
      this.peer = peer;
      peer.on('open', () => resolve(code));
      peer.on('error', (e) => reject(e));
      peer.on('connection', (conn) => { if (this.conn) { conn.close(); return; } this._wire(conn); });
    });
  }
  // Guest: connect to the host's room; resolves when the data channel is open.
  join(code, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      const peer = new Peer({ config: RTC_CONFIG, debug: 0 });
      this.peer = peer;
      let opened = false, conn = null;
      const iceState = () => { const pc = conn && conn.peerConnection; return pc ? pc.iceConnectionState + '/' + pc.iceGatheringState : 'no-pc'; };
      onProgress('contacting the signaling server...');
      peer.on('error', (e) => { if (!opened) { e.iceState = iceState(); reject(e); } else this.onclose && this.onclose(); });
      peer.on('open', () => {
        onProgress('looking up room ' + code + '...');
        conn = peer.connect(ROOM_PREFIX + code.toLowerCase(), { reliable: true, serialization: 'json' });
        this._wire(conn);
        const watch = setInterval(() => { if (opened) return clearInterval(watch); const pc = conn.peerConnection; if (pc) onProgress('host found, negotiating a path (' + pc.iceConnectionState + ')...'); }, 1000);
        conn.on('open', () => { opened = true; clearInterval(watch); resolve(); });
      });
      setTimeout(() => { if (!opened) { const e = new Error('timeout'); e.type = 'timeout'; e.iceState = iceState(); reject(e); } }, 30000);
    });
  }
  send(obj) { if (this.conn && this.conn.open) { try { this.conn.send(obj); } catch {} } }
  close() { try { this.conn && this.conn.close(); } catch {} try { this.peer && this.peer.destroy(); } catch {} }
  get open() { return !!(this.conn && this.conn.open); }
}

// ---- WebRTC P2P with copy/paste signaling (no server at all) ----
// STUN for address discovery plus free public TURN relays (Open Relay by Metered: no account, shared public credentials)
// as a fallback when a direct path is impossible (symmetric NATs, strict firewalls). Relayed traffic adds latency, so
// ICE still prefers a direct candidate pair whenever one works.
const RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:openrelay.metered.ca:80'] },
    { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp', 'turns:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
  ],
  iceCandidatePoolSize: 2,
};

// Wait for ICE gathering. The code we exchange must carry a public (server-reflexive) candidate or two peers behind
// different NATs can never connect, so keep waiting (up to 8 s) until STUN has answered or gathering completes.
function waitIce(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    let haveSrflx = false;
    const done = () => { clearTimeout(hard); clearTimeout(soft); resolve(); };
    const hard = setTimeout(done, 8000);
    let soft = null;
    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate && /typ srflx/.test(e.candidate.candidate) && !haveSrflx) { haveSrflx = true; soft = setTimeout(done, 400); } // a little grace for more candidates
    });
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') done(); };
  });
}
const b64 = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const unb64 = (s) => JSON.parse(decodeURIComponent(escape(atob(s.trim()))));

export class RtcTransport {
  constructor() { this.pc = new RTCPeerConnection(RTC_CONFIG); this.dc = null; this.onmessage = null; this.onclose = null; this.onopen = null; }
  _wire(dc) {
    this.dc = dc;
    dc.onopen = () => this.onopen && this.onopen();
    dc.onclose = () => this.onclose && this.onclose();
    dc.onmessage = (ev) => { const m = decode(ev.data); if (m && this.onmessage) this.onmessage(m); };
  }
  // Host: create an offer code to share
  async createOffer() {
    const dc = this.pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 });
    this._wire(dc);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await waitIce(this.pc);
    return b64({ sdp: this.pc.localDescription });
  }
  // Host: accept the guest's answer code
  async acceptAnswer(code) { const { sdp } = unb64(code); await this.pc.setRemoteDescription(sdp); }
  // Guest: consume the offer code and produce an answer code
  async answer(code) {
    const { sdp } = unb64(code);
    this.pc.ondatachannel = (ev) => this._wire(ev.channel);
    await this.pc.setRemoteDescription(sdp);
    const ans = await this.pc.createAnswer();
    await this.pc.setLocalDescription(ans);
    await waitIce(this.pc);
    return b64({ sdp: this.pc.localDescription });
  }
  send(obj) { if (this.dc && this.dc.readyState === 'open') { try { this.dc.send(encode(obj)); } catch {} } }
  close() { this.dc && this.dc.close(); this.pc.close(); }
  get open() { return this.dc && this.dc.readyState === 'open'; }
}
