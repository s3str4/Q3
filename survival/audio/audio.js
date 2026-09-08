// STUB (replaced by the audio builder).
export class AudioEngine {
  constructor() { this.triggerLog = []; this.ctx = null; }
  init() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } resume() { this.ctx && this.ctx.resume && this.ctx.resume(); } setVolume() {}
  event() {} update() {} stats() { return { state: this.ctx ? this.ctx.state : 'none', voices: 0, loops: 0 }; }
}
