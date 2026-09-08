// Keyboard + mouse -> sim command. No pointer lock: the camera is fixed, the mouse is a world cursor.
// WASD is screen-relative; the renderer converts a screen direction into a world direction (camera yaw).
import { emptyCmd } from '../shared/survival/sim.js';

export class Input {
  constructor(canvas) {
    this.canvas = canvas; this.keys = new Set(); this.mouse = { x: 0, y: 0, down: false, right: false };
    this.enabled = false; this.pendingUse = null; this.slot = 0; this.toggles = { inventory: false, pause: false };
    this.onToggle = null;   // (name) => void, wired by main.js for Tab/Esc
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.repeat) return;
      const c = e.code;
      if (['Tab', 'Escape', 'KeyF', 'KeyG', 'KeyH', 'Digit1', 'Digit2', 'Digit3', 'KeyI'].includes(c)) e.preventDefault();
      if (c === 'Tab' || c === 'KeyI') { this.onToggle && this.onToggle('inventory'); return; }
      if (c === 'Escape') { this.onToggle && this.onToggle('pause'); return; }
      if (c === 'KeyF') this.pendingUse = 'food'; else if (c === 'KeyG') this.pendingUse = 'water'; else if (c === 'KeyH') this.pendingUse = 'bandage';
      else if (c === 'Digit1') this.slot = 1; else if (c === 'Digit2') this.slot = 2; else if (c === 'Digit3') this.slot = 3;
      this.keys.add(c);
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.down = false; });
    canvas.addEventListener('mousemove', (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
    canvas.addEventListener('mousedown', (e) => { if (e.button === 0) this.mouse.down = true; if (e.button === 2) this.mouse.right = true; });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.mouse.down = false; if (e.button === 2) this.mouse.right = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => { if (!this.enabled) return; this.slot = ((this.slot || 1) - 1 + (e.deltaY > 0 ? 1 : 2)) % 3 + 1; }, { passive: true });
  }
  has(...codes) { for (const c of codes) if (this.keys.has(c)) return true; return false; }
  // renderer: { screenDirToWorld(dx, dy) -> [x, y], screenToWorld(px, py) -> [x, y] | null }
  command(renderer, sim) {
    const cmd = emptyCmd();
    if (!this.enabled) return cmd;
    let sx = 0, sy = 0;
    if (this.has('KeyW', 'ArrowUp')) sy -= 1; if (this.has('KeyS', 'ArrowDown')) sy += 1; if (this.has('KeyA', 'ArrowLeft')) sx -= 1; if (this.has('KeyD', 'ArrowRight')) sx += 1;
    cmd.move = (sx || sy) ? renderer.screenDirToWorld(sx, sy) : [0, 0];
    const aim = renderer.screenToWorld(this.mouse.x, this.mouse.y); cmd.aim = aim || [sim.player.x + Math.cos(sim.player.facing), sim.player.y + Math.sin(sim.player.facing)];
    cmd.attack = this.mouse.down || this.has('Space');
    cmd.interact = this.has('KeyE'); cmd.build = this.has('KeyB'); cmd.reload = this.has('KeyR');
    cmd.sprint = this.has('ShiftLeft', 'ShiftRight'); cmd.sneak = this.has('ControlLeft', 'ControlRight', 'KeyC');
    cmd.slot = this.slot; cmd.use = this.pendingUse; this.pendingUse = null;
    return cmd;
  }
}
