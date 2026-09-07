// Transports: WebSocket client, and a WebRTC DataChannel pair for direct P2P (host/guest) with manual signaling.
import { encode, decode } from '../../shared/protocol.js';

export class WsTransport {
  constructor(url) { this.url = url; this.onmessage = null; this.onclose = null; this.onopen = null; this.ws = null; }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => { this.onopen && this.onopen(); resolve(); };
      ws.onerror = (e) => reject(new Error('websocket error'));
      ws.onclose = () => this.onclose && this.onclose();
      ws.onmessage = (ev) => { const m = decode(ev.data); if (m && this.onmessage) this.onmessage(m); };
    });
  }
  send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(encode(obj)); }
  close() { this.ws && this.ws.close(); }
}

// ---- WebRTC P2P with copy/paste signaling (no server at all) ----
const RTC_CONFIG = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };

function waitIce(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, 2500);
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } };
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
