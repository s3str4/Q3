// Input: pointer lock mouse look (Q3 m_yaw 0.022 deg/count * sensitivity), keyboard movement, weapon selection.
import { BUTTONS, WEAPONS } from '../shared/constants.js';

const KEY_WEAPON = { Digit1: WEAPONS.GAUNTLET, Digit2: WEAPONS.MACHINEGUN, Digit3: WEAPONS.SHOTGUN, Digit4: WEAPONS.ROCKET, Digit5: WEAPONS.LIGHTNING, Digit6: WEAPONS.RAIL, Digit7: WEAPONS.PLASMA };
const WHEEL_ORDER = [WEAPONS.GAUNTLET, WEAPONS.MACHINEGUN, WEAPONS.SHOTGUN, WEAPONS.ROCKET, WEAPONS.LIGHTNING, WEAPONS.RAIL, WEAPONS.PLASMA];

export class Input {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.sensitivity = opts.sensitivity ?? 5;
    this.yaw = 0; this.pitch = 0;
    this.keys = new Set();
    this.mouseButtons = 0;
    this.weapon = 0; // requested weapon (0 = no change)
    this.locked = false; this.requireLock = opts.requireLock !== false;
    this.keysAllowed = opts.keysAllowed || (() => true); // keyboard does not need the pointer lock (only mouse look does)
    this.onLockChange = opts.onLockChange || (() => {});
    this.onEscape = opts.onEscape || (() => {});
    this.onScoreboard = opts.onScoreboard || (() => {});
    this.wheelDelta = 0; this.currentWeaponGetter = opts.currentWeapon || (() => 0); this.hasWeapon = opts.hasWeapon || (() => true);
    this.dx = 0; this.dy = 0; // accumulated mouse motion since the last sample (applied per frame)
    document.addEventListener('pointerlockchange', () => { const was = this.locked; this.locked = document.pointerLockElement === canvas; this.onLockChange(this.locked); if (was && !this.locked) { this.keys.clear(); this.mouseButtons = 0; this.onEscape(); } });
    document.addEventListener('pointerlockerror', () => { this.onLockChange(false); });
    // clicking the arena (re)captures the mouse: this is a real user gesture, so the browser always allows it
    canvas.addEventListener('mousedown', () => { if (!this.locked && this.requireLock && this.keysAllowed()) this.lock(); });
    document.addEventListener('mousemove', (e) => { if (!this.locked && this.requireLock) return; this.dx += e.movementX; this.dy += e.movementY; });
    document.addEventListener('mousedown', (e) => { if (!this.locked && this.requireLock) return; e.preventDefault(); this.mouseButtons |= (1 << e.button); });
    document.addEventListener('mouseup', (e) => { this.mouseButtons &= ~(1 << e.button); });
    document.addEventListener('contextmenu', (e) => { if (this.locked) e.preventDefault(); });
    document.addEventListener('wheel', (e) => { if (!this.locked && this.requireLock) return; e.preventDefault(); this.cycleWeapon(e.deltaY > 0 ? 1 : -1); }, { passive: false });
    document.addEventListener('keydown', (e) => {
      if (!this.keysAllowed()) return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.code === 'Tab') { e.preventDefault(); this.onScoreboard(true); return; }
      if (KEY_WEAPON[e.code]) { this.weapon = KEY_WEAPON[e.code]; }
      if (e.code === 'KeyQ') this.cycleWeapon(-1);
      if (e.code === 'KeyE') this.cycleWeapon(1);
      this.keys.add(e.code);
      if (['Space', 'ControlLeft', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) e.preventDefault();
    });
    document.addEventListener('keyup', (e) => { if (e.code === 'Tab') { this.onScoreboard(false); } this.keys.delete(e.code); });
  }
  cycleWeapon(dir) {
    const cur = this.weapon || this.currentWeaponGetter();
    let i = WHEEL_ORDER.indexOf(cur);
    for (let n = 0; n < WHEEL_ORDER.length; n++) {
      i = (i + dir + WHEEL_ORDER.length) % WHEEL_ORDER.length;
      if (this.hasWeapon(WHEEL_ORDER[i])) { this.weapon = WHEEL_ORDER[i]; return; }
    }
  }
  lock() {
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => { try { const q = this.canvas.requestPointerLock(); if (q && q.catch) q.catch(() => this.onLockChange(false)); } catch { this.onLockChange(false); } });
    } catch { try { this.canvas.requestPointerLock(); } catch { this.onLockChange(false); } }
  }
  unlock() { document.exitPointerLock(); }
  // Apply accumulated mouse motion to view angles (called every render frame for lowest latency).
  applyMouse() {
    const k = 0.022 * this.sensitivity;
    this.yaw -= this.dx * k; this.pitch += this.dy * k;
    this.dx = 0; this.dy = 0;
    this.pitch = Math.max(-89, Math.min(89, this.pitch));
    if (this.yaw > 180) this.yaw -= 360; if (this.yaw < -180) this.yaw += 360;
  }
  sample() {
    this.applyMouse();
    let forward = 0, right = 0, up = 0, buttons = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) forward += 127;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) forward -= 127;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) right += 127;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) right -= 127;
    if (this.keys.has('Space')) { up = 127; buttons |= BUTTONS.JUMP; }
    if (this.keys.has('ControlLeft') || this.keys.has('KeyC') || this.keys.has('ShiftLeft')) { up = -127; buttons |= BUTTONS.CROUCH; }
    if (this.mouseButtons & 1) buttons |= BUTTONS.ATTACK;
    if (this.mouseButtons & 4) buttons |= BUTTONS.ZOOM;
    const weapon = this.weapon; this.weapon = 0;
    return { forward, right, up, buttons, pitch: this.pitch, yaw: this.yaw, weapon };
  }
  setAngles(pitch, yaw) { this.pitch = pitch; this.yaw = yaw; }
}
