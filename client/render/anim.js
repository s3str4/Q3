// Pure animation helpers shared by the viewmodel and the player model (no three.js, no DOM: unit-testable).
// Angles are radians; blend amounts are 0..1.

// Leg pose for the humanoid run cycle. `cycle` advances with distance run (left leg phase; the right leg is half a
// cycle behind), `run` / `air` / `duck` are the blend amounts, `fall` 0..1 is how fast the body is dropping (the legs
// reach down for the landing), `dip` is the landing knee flex in units. Returns hip / knee pitch per side plus the
// arm swing (the free arm swings opposite to the leg on its own side, like a walk).
export function runPose(cycle, run, air, duck, fall = 0, dip = 0) {
  const phaseL = cycle, phaseR = cycle + Math.PI;
  const swingL = -Math.sin(phaseL) * 0.85 * run, swingR = -Math.sin(phaseR) * 0.85 * run;
  const flexL = Math.max(0, Math.cos(phaseL)) * 1.25 * run, flexR = Math.max(0, Math.cos(phaseR)) * 1.25 * run;
  // air: tucked while rising, reaching down while falling
  const airHipL = -0.55 + fall * 0.4, airHipR = -0.3 + fall * 0.2, airKneeL = 1.3 - fall * 0.7, airKneeR = 1.0 - fall * 0.5;
  const duckHip = -1.35, duckKnee = 2.3, kneeDip = dip * 0.06;
  const ground = (1 - air) * (1 - duck);
  return {
    hipL: swingL * ground + airHipL * air + duckHip * duck,
    hipR: swingR * ground + airHipR * air + duckHip * duck,
    kneeL: (flexL + kneeDip) * ground + airKneeL * air + (duckKnee + Math.max(0, Math.cos(phaseL)) * 0.3 * run) * duck,
    kneeR: (flexR + kneeDip) * ground + airKneeR * air + (duckKnee + Math.max(0, Math.cos(phaseR)) * 0.3 * run) * duck,
    // arm swing amplitude (units of hand travel, forward positive) for the left / right free arm
    armL: Math.sin(phaseR) * 7 * run * (1 - air), armR: Math.sin(phaseL) * 7 * run * (1 - air),
    bob: Math.abs(Math.sin(cycle)) * 1.4 * run,
  };
}

// Motion-blur ring opacity for the gauntlet blade: nothing below a quarter of full speed (the teeth still read one
// by one), then a smooth ramp to 1 at full spin.
export function bladeBlur(spin, max = 16) {
  const k = Math.min(1, Math.max(0, (spin / max - 0.25) / 0.75));
  return k * k * (3 - 2 * k);
}

// Frame of an N-frame muzzle flash `elapsed` ms after the shot, over a `life` ms flash (-1 once it is over).
export function flashFrame(elapsed, life, frames) {
  if (elapsed < 0 || elapsed >= life) return -1;
  return Math.min(frames - 1, Math.floor(elapsed / life * frames));
}

// Weapon switch lowering amount (0 = in the ready pose, 1 = fully lowered off-screen) from the simulation's
// weaponState / weaponTime (dropping counts down WEAPON_DROP_TIME, raising counts down WEAPON_RAISE_TIME).
export function switchDrop(state, time, dropTime, raiseTime) {
  if (state === 'dropping') return 1 - Math.max(0, time) / dropTime;
  if (state === 'raising') return Math.max(0, time) / raiseTime;
  return 0;
}

// Smooth-step ease used by the death falls and the shimmer curves.
export const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
