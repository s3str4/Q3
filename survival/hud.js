// STUB (replaced by the HUD builder).
export class Hud {
  constructor() { this.el = document.getElementById('hud'); this.frameTimes = []; this.lastFrame = 0; this.inventoryOpen = false; }
  show() { this.el.classList.remove('hidden'); } hide() { this.el.classList.add('hidden'); }
  frame(now) { if (this.lastFrame) { this.frameTimes.push(now - this.lastFrame); if (this.frameTimes.length > 120) this.frameTimes.shift(); } this.lastFrame = now; }
  update() {} event() {} toggleInventory() { this.inventoryOpen = !this.inventoryOpen; } setPaused() {}
}
