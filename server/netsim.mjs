// Network condition simulator for testing: delays (latency ± jitter) and drops (loss %) messages in both directions.
// Delivery is a strict FIFO per direction (like TCP / an ordered channel): a message never overtakes an earlier one,
// so jitter shows up as bunching rather than reordering, which is what a WebSocket client actually experiences.
// (Relying on setTimeout ordering is not enough: Node does not guarantee firing order for equal expiries.)
export class NetSim {
  constructor({ latency = 0, jitter = 0, loss = 0 } = {}) {
    this.latency = Math.max(0, +latency || 0); this.jitter = Math.max(0, +jitter || 0); this.loss = Math.max(0, Math.min(100, +loss || 0));
    this.enabled = this.latency > 0 || this.jitter > 0 || this.loss > 0;
    this.out = { q: [], last: 0, timer: null }; // server -> client
    this.in = { q: [], last: 0, timer: null };  // client -> server
  }
  delay() { return Math.max(0, this.latency / 2 + (Math.random() * 2 - 1) * this.jitter / 2); }
  schedule(dir, data, deliver) {
    if (!this.enabled) return deliver(data);
    if (this.loss && Math.random() * 100 < this.loss) return;
    const now = performance.now();
    const at = Math.max(now + this.delay(), dir.last); // never earlier than the previous message
    dir.last = at;
    dir.q.push({ at, data, deliver });
    if (!dir.timer) this.arm(dir, at - now);
  }
  arm(dir, ms) {
    dir.timer = setTimeout(() => {
      dir.timer = null;
      const now = performance.now();
      while (dir.q.length && dir.q[0].at <= now + 0.25) { const m = dir.q.shift(); m.deliver(m.data); }
      if (dir.q.length) this.arm(dir, dir.q[0].at - now);
    }, Math.max(0, ms));
  }
  send(data, deliver) { this.schedule(this.out, data, deliver); }
  recv(data, deliver) { this.schedule(this.in, data, deliver); }
}
