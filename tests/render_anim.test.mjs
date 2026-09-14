// Pure animation helpers (client/render/anim.js): the run cycle keeps the legs half a cycle apart and the arms
// swinging against them, the air / crouch poses blend in fully, the gauntlet blur and the muzzle flash frames
// follow their curves, and the switch lowering mirrors the simulation's drop / raise timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPose, bladeBlur, flashFrame, switchDrop, ease } from '../client/render/anim.js';
import { WEAPON_DROP_TIME, WEAPON_RAISE_TIME } from '../shared/constants.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('run cycle: standing still is the rest pose, legs alternate half a cycle apart, arms swing against the legs', () => {
  const rest = runPose(1.3, 0, 0, 0);
  for (const k of ['hipL', 'hipR', 'kneeL', 'kneeR', 'armL', 'armR', 'bob']) close(rest[k], 0);
  for (const c of [0, 0.7, 2.1, 4.4]) {
    const a = runPose(c, 1, 0, 0), b = runPose(c + Math.PI, 1, 0, 0);
    close(a.hipL, b.hipR); close(a.kneeL, b.kneeR); close(a.armL, b.armR);
    // the arm on one side swings with the opposite leg: same sign as that leg's hip swing (forward = negative hip)
    if (Math.abs(a.hipR) > 1e-6) assert.equal(Math.sign(a.armL), Math.sign(-a.hipR));
    assert.ok(a.kneeL >= 0 && a.kneeR >= 0, 'knees only bend one way');
  }
  assert.ok(runPose(Math.PI / 2, 1, 0, 0).bob > 1, 'the body bobs at full run');
});

test('air and crouch poses replace the run pose and blend', () => {
  const air = runPose(1, 1, 1, 0, 0);
  assert.ok(air.kneeL > 1 && air.kneeR > 0.9, 'legs tucked in the air');
  close(air.armL, 0); close(air.armR, 0);
  const falling = runPose(1, 1, 1, 0, 1);
  assert.ok(falling.kneeL < air.kneeL && falling.hipL > air.hipL, 'legs reach down while falling');
  const duck = runPose(1, 0, 0, 1);
  close(duck.hipL, -1.35); close(duck.kneeL, 2.3);
  const half = runPose(1, 0, 0, 0.5);
  close(half.hipL, -1.35 / 2);
});

test('blade blur: none at low spin, smooth ramp to full at 16 rad/s, monotonic', () => {
  close(bladeBlur(0), 0); close(bladeBlur(3), 0); close(bladeBlur(16), 1); close(bladeBlur(40), 1);
  let last = -1;
  for (let s = 0; s <= 16; s += 0.5) { const v = bladeBlur(s); assert.ok(v >= last, 'monotonic'); assert.ok(v >= 0 && v <= 1); last = v; }
  assert.ok(bladeBlur(10) > 0.2 && bladeBlur(10) < 0.8);
});

test('muzzle flash frames cover the flash life in order and end', () => {
  assert.equal(flashFrame(-1, 80, 3), -1);
  assert.equal(flashFrame(0, 80, 3), 0);
  assert.equal(flashFrame(30, 80, 3), 1);
  assert.equal(flashFrame(79, 80, 3), 2);
  assert.equal(flashFrame(80, 80, 3), -1);
  assert.equal(flashFrame(500, 80, 3), -1);
});

test('switch lowering follows the drop then raise timers', () => {
  close(switchDrop('ready', 0, WEAPON_DROP_TIME, WEAPON_RAISE_TIME), 0);
  close(switchDrop('dropping', WEAPON_DROP_TIME, WEAPON_DROP_TIME, WEAPON_RAISE_TIME), 0);
  close(switchDrop('dropping', 0, WEAPON_DROP_TIME, WEAPON_RAISE_TIME), 1);
  close(switchDrop('raising', WEAPON_RAISE_TIME, WEAPON_DROP_TIME, WEAPON_RAISE_TIME), 1);
  close(switchDrop('raising', 0, WEAPON_DROP_TIME, WEAPON_RAISE_TIME), 0);
  close(switchDrop('dropping', WEAPON_DROP_TIME / 2, WEAPON_DROP_TIME, WEAPON_RAISE_TIME), 0.5);
  assert.ok(switchDrop('raising', -5, WEAPON_DROP_TIME, WEAPON_RAISE_TIME) === 0, 'negative timers clamp');
});

test('ease is a clamped smooth step', () => {
  close(ease(-1), 0); close(ease(0), 0); close(ease(0.5), 0.5); close(ease(1), 1); close(ease(2), 1);
  assert.ok(ease(0.25) < 0.25 && ease(0.75) > 0.75);
});
