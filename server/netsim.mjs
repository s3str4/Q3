// Network condition simulator for testing: delays (latency ± jitter) and drops (loss %) messages in both directions.
export class NetSim {
  constructor({ latency = 0, jitter = 0, loss = 0 } = {}) {
    this.latency = latency; this.jitter = jitter; this.loss = loss;
    this.enabled = latency > 0 || jitter > 0 || loss > 0;
  }
  delay() { return Math.max(0, this.latency / 2 + (Math.random() * 2 - 1) * this.jitter / 2); }
  send(data, deliver) {
    if (!this.enabled) return deliver(data);
    if (this.loss && Math.random() * 100 < this.loss) return;
    setTimeout(() => deliver(data), this.delay());
  }
  recv(data, deliver) {
    if (!this.enabled) return deliver(data);
    if (this.loss && Math.random() * 100 < this.loss) return;
    setTimeout(() => deliver(data), this.delay());
  }
}
