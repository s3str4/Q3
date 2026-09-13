// Input: pointer lock mouse look (Q3 m_yaw 0.022 deg/count * sensitivity), keyboard movement, weapon selection.
// Every action goes through a bindings map (action -> [codes]) that the menu's Keys panel edits and localStorage
// keeps: keyboard codes are KeyboardEvent.code ('KeyW', 'Space'), mouse buttons 'Mouse0'/'Mouse1'/'Mouse2'...,
// the wheel 'WheelUp'/'WheelDown'. Held actions (move, jump, crouch, attack, zoom) are read in sample(); one-shot
// actions (weapon slots, next/prev weapon, scoreboard) fire on the press.
import { BUTTONS, WEAPONS } from '../shared/constants.js';

export const ACTIONS = [
  ['forward', 'Move forward'], ['back', 'Move back'], ['left', 'Strafe left'], ['right', 'Strafe right'],
  ['jump', 'Jump'], ['crouch', 'Crouch'], ['attack', 'Fire'], ['zoom', 'Zoom'],
  ['weapon1', 'Gauntlet'], ['weapon2', 'Machinegun'], ['weapon3', 'Shotgun'], ['weapon4', 'Rocket launcher'],
  ['weapon5', 'Lightning gun'], ['weapon6', 'Railgun'], ['weapon7', 'Plasma gun'],
  ['nextweapon', 'Next weapon'], ['prevweapon', 'Previous weapon'], ['scoreboard', 'Scoreboard (hold)'],
];
export const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  jump: ['Space'], crouch: ['ControlLeft', 'KeyC', 'ShiftLeft'], attack: ['Mouse0'], zoom: ['Mouse2'],
  weapon1: ['Digit1'], weapon2: ['Digit2'], weapon3: ['Digit3'], weapon4: ['Digit4'], weapon5: ['Digit5'], weapon6: ['Digit6'], weapon7: ['Digit7'],
  nextweapon: ['WheelDown', 'KeyE'], prevweapon: ['WheelUp', 'KeyQ'], scoreboard: ['Tab'],
};
const WEAPON_ACTION = { weapon1: WEAPONS.GAUNTLET, weapon2: WEAPONS.MACHINEGUN, weapon3: WEAPONS.SHOTGUN, weapon4: WEAPONS.ROCKET, weapon5: WEAPONS.LIGHTNING, weapon6: WEAPONS.RAIL, weapon7: WEAPONS.PLASMA };
const HELD = new Set(['forward', 'back', 'left', 'right', 'jump', 'crouch', 'attack', 'zoom']);
const WHEEL_ORDER = [WEAPONS.GAUNTLET, WEAPONS.MACHINEGUN, WEAPONS.SHOTGUN, WEAPONS.ROCKET, WEAPONS.LIGHTNING, WEAPONS.RAIL, WEAPONS.PLASMA];

// Merge a stored bindings object with the defaults; anything malformed falls back to the default for that action.
// An empty list is a deliberate "unbound" (its key was given to another action) and stays empty.
export function normalizeBindings(b) {
  const out = {};
  for (const [a] of ACTIONS) {
    const v = b && b[a];
    const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : null;
    out[a] = list && list.every((c) => typeof c === 'string' && c.length > 0 && c.length < 32) ? [...list] : [...DEFAULT_BINDINGS[a]];
  }
  return out;
}
// Short display label for a code ('KeyW' -> 'W', 'Mouse0' -> 'LMB', 'WheelUp' -> 'WHEEL UP').
const LABELS = { Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Mouse3: 'M4', Mouse4: 'M5', WheelUp: 'WHEEL UP', WheelDown: 'WHEEL DOWN', Space: 'SPACE', ControlLeft: 'L-CTRL', ControlRight: 'R-CTRL', ShiftLeft: 'L-SHIFT', ShiftRight: 'R-SHIFT', AltLeft: 'L-ALT', AltRight: 'R-ALT', Tab: 'TAB', Enter: 'ENTER', Backspace: 'BACKSPACE', CapsLock: 'CAPS', ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\' };
export function keyLabel(code) {
  if (LABELS[code]) return LABELS[code];
  if (/^Key[A-Z]$/.test(code)) return code[3];
  if (/^Digit\d$/.test(code)) return code[5];
  if (/^Numpad/.test(code)) return 'NUM ' + code.slice(6).toUpperCase();
  return code.toUpperCase();
}
export const bindingLabel = (codes) => (codes && codes.length ? codes.map(keyLabel).join(' / ') : 'UNBOUND');

export class Input {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.sensitivity = opts.sensitivity ?? 5;
    this.yaw = 0; this.pitch = 0;
    this.keys = new Set();      // raw codes currently down (diagnostics)
    this.held = new Set();      // held actions from the keyboard
    this.pulse = new Set();     // one-sample actions (a held action bound to the wheel)
    this.mouseButtons = 0;      // raw button bitmask (bit n = 'Mouse'+n); resolved through the bindings in sample()
    this.weapon = 0; // requested weapon (0 = no change)
    this.locked = false; this.requireLock = opts.requireLock !== false;
    this.keysAllowed = opts.keysAllowed || (() => true); // keyboard does not need the pointer lock (only mouse look does)
    this.onLockChange = opts.onLockChange || (() => {});
    this.onEscape = opts.onEscape || (() => {});
    this.onScoreboard = opts.onScoreboard || (() => {});
    this.currentWeaponGetter = opts.currentWeapon || (() => 0); this.hasWeapon = opts.hasWeapon || (() => true);
    this.dx = 0; this.dy = 0; // accumulated mouse motion since the last sample (applied per frame)
    this.setBindings(opts.bindings);
    document.addEventListener('pointerlockchange', () => { const was = this.locked; this.locked = document.pointerLockElement === canvas; this.onLockChange(this.locked); if (was && !this.locked) { this.keys.clear(); this.held.clear(); this.mouseButtons = 0; this.onEscape(); } });
    document.addEventListener('pointerlockerror', () => { this.onLockChange(false); });
    // clicking the arena (re)captures the mouse: this is a real user gesture, so the browser always allows it
    canvas.addEventListener('mousedown', () => { if (!this.locked && this.requireLock && this.keysAllowed()) this.lock(); });
    document.addEventListener('mousemove', (e) => { if (!this.locked && this.requireLock) return; this.dx += e.movementX; this.dy += e.movementY; });
    document.addEventListener('mousedown', (e) => { if (!this.locked && this.requireLock) return; e.preventDefault(); this.mouseButtons |= (1 << e.button); this.press('Mouse' + e.button, true); });
    document.addEventListener('mouseup', (e) => { this.mouseButtons &= ~(1 << e.button); this.release('Mouse' + e.button, true); });
    document.addEventListener('contextmenu', (e) => { if (this.locked) e.preventDefault(); });
    document.addEventListener('wheel', (e) => { if (!this.locked && this.requireLock) return; e.preventDefault(); this.press(e.deltaY > 0 ? 'WheelDown' : 'WheelUp', false, true); }, { passive: false });
    document.addEventListener('keydown', (e) => {
      if (!this.keysAllowed()) return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      this.keys.add(e.code);
      if (this.byCode.has(e.code)) { e.preventDefault(); if (!e.repeat) this.press(e.code); }
    });
    document.addEventListener('keyup', (e) => { this.keys.delete(e.code); this.release(e.code); });
  }
  // Replace the bindings (action -> [codes]); rebuilds the code -> actions index and drops any stale held state.
  setBindings(b) {
    this.bindings = normalizeBindings(b);
    this.byCode = new Map();
    for (const a in this.bindings) for (const c of this.bindings[a]) { if (!this.byCode.has(c)) this.byCode.set(c, []); this.byCode.get(c).push(a); }
    this.held.clear(); this.pulse.clear();
  }
  // A code went down: one-shot actions fire now; held actions are recorded (mouse-held ones are read from the
  // bitmask instead, so evidence scripts can drive mouseButtons directly). oneShot (wheel): held actions last one sample.
  press(code, mouse = false, oneShot = false) {
    const actions = this.byCode.get(code); if (!actions) return;
    for (const a of actions) {
      if (WEAPON_ACTION[a]) this.weapon = WEAPON_ACTION[a];
      else if (a === 'nextweapon') this.cycleWeapon(1);
      else if (a === 'prevweapon') this.cycleWeapon(-1);
      else if (a === 'scoreboard') { this.onScoreboard(true); if (oneShot) setTimeout(() => this.onScoreboard(false), 800); }
      else if (HELD.has(a)) { if (oneShot) this.pulse.add(a); else if (!mouse) this.held.add(a); }
    }
  }
  release(code, mouse = false) {
    const actions = this.byCode.get(code); if (!actions) return;
    for (const a of actions) { if (a === 'scoreboard') this.onScoreboard(false); else if (!mouse) this.held.delete(a); }
  }
  // Is a held action active (keyboard, mouse bitmask through the bindings, or a wheel pulse)?
  active(a) {
    if (this.held.has(a) || this.pulse.has(a)) return true;
    if (this.mouseButtons) for (let b = 0; b < 8; b++) if ((this.mouseButtons >> b) & 1) { const acts = this.byCode.get('Mouse' + b); if (acts && acts.includes(a)) return true; }
    return false;
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
    if (this.active('forward')) forward += 127;
    if (this.active('back')) forward -= 127;
    if (this.active('right')) right += 127;
    if (this.active('left')) right -= 127;
    if (this.active('jump')) { up = 127; buttons |= BUTTONS.JUMP; }
    if (this.active('crouch')) { up = -127; buttons |= BUTTONS.CROUCH; }
    if (this.active('attack')) buttons |= BUTTONS.ATTACK;
    if (this.active('zoom')) buttons |= BUTTONS.ZOOM;
    this.pulse.clear();
    const weapon = this.weapon; this.weapon = 0;
    return { forward, right, up, buttons, pitch: this.pitch, yaw: this.yaw, weapon };
  }
  setAngles(pitch, yaw) { this.pitch = pitch; this.yaw = yaw; }
}
