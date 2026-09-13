// Port of Quake 3 bg_pmove.c (walk/air/friction/step-slide/jump/duck) on a fixed 60 Hz step.
import { PM, CPM, BUTTONS, FRAMETIME, EV } from './constants.js';
import { angleVectors, dot, length, normalize, copy, cross } from './vec3.js';
import { traceBox } from './trace.js';

export const PMF = { DUCKED: 1, JUMP_HELD: 2, TIME_KNOCKBACK: 4, TIME_LAND: 8, RESPAWNED: 16 };

export function newPlayerState() {
  return {
    origin: [0, 0, 0], velocity: [0, 0, 0], viewangles: [0, 0, 0],
    pmFlags: 0, pmTime: 0, groundEntity: false, viewHeight: PM.viewHeight,
    jumpPadTime: 0, padIndex: -1, bobCycle: 0, stepTime: 0,
  };
}

export function clipVelocity(inv, normal, overbounce) {
  let backoff = dot(inv, normal);
  if (backoff < 0) backoff *= overbounce; else backoff /= overbounce;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const change = normal[i] * backoff;
    out[i] = inv[i] - change;
  }
  return out;
}

// cmd: { forward: -127..127, right: -127..127, up: -127..127, buttons, angles:[p,y,r] }
// ctx: { world, entities (other players for collision), skipId, events: [] (optional), frametime,
//        physics: 'vq3' (default) | 'cpm' (the match rule; the Game passes rules.physics) }
export function pmove(ps, cmd, ctx) {
  const frametime = ctx.frametime ?? FRAMETIME;
  const pml = { frametime, groundPlane: false, walking: false, groundTrace: null, previousOrigin: copy(ps.origin), previousVelocity: copy(ps.velocity), cpm: ctx.physics === 'cpm' };
  const events = ctx.events || null;
  const trace = (start, end, mins, maxs) => traceBox(ctx.world, start, end, mins, maxs, ctx.entities, { skip: ctx.skipId, skipFlags: ctx.skipFlags || 0 });
  pml.trace = trace;

  // clamp angles
  ps.viewangles = [Math.max(-89.9, Math.min(89.9, cmd.angles[0])), cmd.angles[1], 0];
  const av = angleVectors(ps.viewangles);
  pml.forward = av.forward; pml.right = av.right; pml.up = av.up;

  // pm_time countdown
  if (ps.pmTime > 0) {
    const msec = Math.round(frametime * 1000);
    if (msec >= ps.pmTime) { ps.pmFlags &= ~(PMF.TIME_KNOCKBACK | PMF.TIME_LAND); ps.pmTime = 0; }
    else ps.pmTime -= msec;
  }

  if (ps.dead) {
    // dead body: only gravity + friction
    pmDeadMove(ps, pml);
    groundTrace(ps, pml, events);
    return;
  }

  checkDuck(ps, cmd, pml);
  groundTrace(ps, pml, events);

  if (checkJump(ps, cmd, pml, events)) {
    // jumped away
  }

  if (pml.walking) walkMove(ps, cmd, pml, events);
  else airMove(ps, cmd, pml);

  groundTrace(ps, pml, events);
  ps.groundEntity = pml.walking;
  footsteps(ps, pml, events);
}

function pmDeadMove(ps, pml) {
  if (!pml.walking) {
    // gravity
    ps.velocity[2] -= PM.gravity * pml.frametime;
  }
  friction(ps, pml, true);
  stepSlideMove(ps, pml, !pml.walking, [PM.mins[0], PM.mins[1], PM.mins[2]], [PM.maxs[0], PM.maxs[1], 8]);
}

function cmdScale(cmd, speed) {
  let max = Math.abs(cmd.forward);
  if (Math.abs(cmd.right) > max) max = Math.abs(cmd.right);
  if (Math.abs(cmd.up) > max) max = Math.abs(cmd.up);
  if (!max) return 0;
  const total = Math.sqrt(cmd.forward * cmd.forward + cmd.right * cmd.right + cmd.up * cmd.up);
  return (speed * max) / (127 * total);
}

function playerMaxs(ps) { return (ps.pmFlags & PMF.DUCKED) ? PM.duckMaxs : PM.maxs; }

function checkDuck(ps, cmd, pml) {
  if (cmd.up < 0 || (cmd.buttons & BUTTONS.CROUCH)) {
    ps.pmFlags |= PMF.DUCKED;
  } else if (ps.pmFlags & PMF.DUCKED) {
    // try to stand up
    const tr = pml.trace(ps.origin, ps.origin, PM.mins, PM.maxs);
    if (!tr.allsolid) ps.pmFlags &= ~PMF.DUCKED;
  }
  ps.viewHeight = (ps.pmFlags & PMF.DUCKED) ? PM.duckViewHeight : PM.viewHeight;
}

function groundTrace(ps, pml, events) {
  const point = [ps.origin[0], ps.origin[1], ps.origin[2] - 0.25];
  const tr = pml.trace(ps.origin, point, PM.mins, playerMaxs(ps));
  pml.groundTrace = tr;
  // do something corrective if the trace starts in a solid...
  if (tr.allsolid) {
    if (!correctAllSolid(ps, pml)) { pml.groundPlane = false; pml.walking = false; return; }
    return;
  }
  if (tr.fraction === 1) {
    // in the air
    if (ps.groundEntity && ps.velocity[2] <= 0 && events) {
      // walked off a ledge: no event
    }
    ps.groundEntity = false;
    pml.groundPlane = false;
    pml.walking = false;
    return;
  }
  // check if getting thrown off the ground
  if (ps.velocity[2] > 0 && dot(ps.velocity, tr.plane.n) > 10) {
    ps.groundEntity = false; pml.groundPlane = false; pml.walking = false;
    return;
  }
  // slopes that are too steep will not be considered onground
  if (tr.plane.n[2] < PM.minWalkNormal) {
    ps.groundEntity = false; pml.groundPlane = true; pml.walking = false;
    return;
  }
  pml.groundPlane = true;
  pml.walking = true;
  // hitting solid ground will end a waterjump/knockback and produce a land event
  if (!ps.groundEntity) {
    crashLand(ps, pml, events);
  }
  ps.groundEntity = true;
  ps.groundNormal = tr.plane.n;
}

function correctAllSolid(ps, pml) {
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
    const p = [ps.origin[0] + i, ps.origin[1] + j, ps.origin[2] + k];
    const tr = pml.trace(p, p, PM.mins, playerMaxs(ps));
    if (!tr.allsolid) {
      ps.origin = p;
      const down = [p[0], p[1], p[2] - 0.25];
      pml.groundTrace = pml.trace(p, down, PM.mins, playerMaxs(ps));
      return true;
    }
  }
  ps.groundEntity = false; pml.groundPlane = false; pml.walking = false;
  return false;
}

function crashLand(ps, pml, events) {
  // decide which landing sound to play (Q3 computes fall delta from previous velocity)
  const delta = -pml.previousVelocity[2];
  // Q3: delta = vel*vel*0.0001 with vel derived from fall height; we use velocity directly.
  if (delta > 200 && events) events.push({ type: EV.LAND, hard: delta > 500 });
  else if (delta > 120 && events) events.push({ type: EV.LAND, hard: false, soft: true });
  // Q3 has no fall damage in most competitive rulesets (CPMA off); vanilla does 5/10 for high falls.
  if (delta > 650 && events) events.push({ type: EV.FALL_DAMAGE, damage: delta > 900 ? 10 : 5 });
  ps.pmFlags |= PMF.TIME_LAND;
  ps.pmTime = 100; // small land time (Q3: 250 for hard falls, but we keep 100 for responsiveness)
  ps.pmFlags &= ~PMF.TIME_LAND; // Q3 land time only affects view bob; not movement. Clear immediately.
  ps.pmTime = 0;
}

function checkJump(ps, cmd, pml, events) {
  const wantsJump = cmd.up >= 10 || (cmd.buttons & BUTTONS.JUMP);
  if (!wantsJump) { ps.pmFlags &= ~PMF.JUMP_HELD; return false; }
  if (ps.pmFlags & PMF.JUMP_HELD) return false; // must wait for jump to be released
  if (!pml.walking) return false;
  pml.groundPlane = false;
  pml.walking = false;
  ps.groundEntity = false;
  ps.pmFlags |= PMF.JUMP_HELD;
  ps.velocity[2] = PM.jumpVelocity;
  if (events) events.push({ type: EV.JUMP });
  return true;
}

function friction(ps, pml, walkingOverride) {
  const vel = ps.velocity;
  const vec = copy(vel);
  if (pml.walking || walkingOverride) vec[2] = 0;
  const speed = length(vec);
  if (speed < 1) { vel[0] = 0; vel[1] = 0; return; }
  let drop = 0;
  if ((pml.walking || walkingOverride) && !(ps.pmFlags & PMF.TIME_KNOCKBACK)) {
    const control = speed < PM.stopspeed ? PM.stopspeed : speed;
    drop += control * PM.friction * pml.frametime;
  }
  let newspeed = speed - drop;
  if (newspeed < 0) newspeed = 0;
  newspeed /= speed;
  vel[0] *= newspeed; vel[1] *= newspeed; vel[2] *= newspeed;
}

function accelerate(ps, wishdir, wishspeed, accel, frametime) {
  const currentspeed = dot(ps.velocity, wishdir);
  const addspeed = wishspeed - currentspeed;
  if (addspeed <= 0) return;
  let accelspeed = accel * frametime * wishspeed;
  if (accelspeed > addspeed) accelspeed = addspeed;
  for (let i = 0; i < 3; i++) ps.velocity[i] += accelspeed * wishdir[i];
}

function airMove(ps, cmd, pml) {
  friction(ps, pml, false);
  const fmove = cmd.forward, smove = cmd.right;
  const scale = cmdScale(cmd, PM.speed);
  const fwd = [pml.forward[0], pml.forward[1], 0];
  const rgt = [pml.right[0], pml.right[1], 0];
  const f = normalize(fwd), r = normalize(rgt);
  const wishvel = [f[0] * fmove + r[0] * smove, f[1] * fmove + r[1] * smove, 0];
  const wishdir = normalize(wishvel);
  let wishspeed = length(wishvel) * scale;
  if (pml.cpm) {
    // CPM air physics (CPMA / Warsow PM_AirMove): reversing direction is quicker (airstopaccelerate); a sideways-only
    // strafe is a short strong push (wish speed capped at 30 with strafeaccelerate 70: the CPM A/D air strafe); a pure
    // forward/back input steers the velocity toward the view (PM_Aircontrol); a diagonal strafe is plain vq3.
    const wishspeed2 = wishspeed;
    let accel = dot(ps.velocity, wishdir) < 0 ? CPM.airstopaccelerate : PM.airaccelerate;
    if (fmove === 0 && smove !== 0) { if (wishspeed > CPM.airwishspeed) wishspeed = CPM.airwishspeed; accel = CPM.strafeaccelerate; }
    accelerate(ps, wishdir, wishspeed, accel, pml.frametime);
    if (smove === 0 && fmove !== 0) airControl(ps, wishdir, wishspeed2, pml.frametime);
  } else accelerate(ps, wishdir, wishspeed, PM.airaccelerate, pml.frametime);
  // we may have a ground plane that is very steep, even though we don't have a groundentity
  if (pml.groundPlane) ps.velocity = clipVelocity(ps.velocity, pml.groundTrace.plane.n, PM.overclip);
  stepSlideMove(ps, pml, true, PM.mins, playerMaxs(ps));
}

// CPM_Aircontrol: with only forward/back held, rotate the horizontal velocity toward wishdir by
// 32 * aircontrol * dot^2 * frametime (never while slowing down: dot <= 0), keeping the speed and the vertical velocity.
function airControl(ps, wishdir, wishspeed, frametime) {
  if (wishspeed === 0) return;
  const zspeed = ps.velocity[2];
  const horiz = [ps.velocity[0], ps.velocity[1], 0];
  const speed = length(horiz);
  let dir = normalize(horiz);
  const d = dot(dir, wishdir);
  const k = 32 * CPM.aircontrol * d * d * frametime;
  if (d > 0) dir = normalize([dir[0] * speed + wishdir[0] * k, dir[1] * speed + wishdir[1] * k, 0]);
  ps.velocity = [dir[0] * speed, dir[1] * speed, zspeed];
}

function walkMove(ps, cmd, pml, events) {
  if (checkJump(ps, cmd, pml, events)) { airMove(ps, cmd, pml); return; }
  friction(ps, pml, false);
  const fmove = cmd.forward, smove = cmd.right;
  const scale = cmdScale(cmd, PM.speed);
  // project moves down to flat plane
  const fwd = [pml.forward[0], pml.forward[1], 0];
  const rgt = [pml.right[0], pml.right[1], 0];
  // project the forward and right directions onto the ground plane
  const f = normalize(clipVelocity(fwd, pml.groundTrace.plane.n, PM.overclip));
  const r = normalize(clipVelocity(rgt, pml.groundTrace.plane.n, PM.overclip));
  const wishvel = [f[0] * fmove + r[0] * smove, f[1] * fmove + r[1] * smove, f[2] * fmove + r[2] * smove];
  const wishdir = normalize(wishvel);
  let wishspeed = length(wishvel) * scale;
  if (ps.pmFlags & PMF.DUCKED) { if (wishspeed > PM.speed * PM.duckScale) wishspeed = PM.speed * PM.duckScale; }
  // when a player gets hit, they temporarily lose full control
  const accel = (ps.pmFlags & PMF.TIME_KNOCKBACK) || (pml.groundTrace.surfaceFlags & SURF_SLICK) ? PM.airaccelerate : PM.accelerate;
  accelerate(ps, wishdir, wishspeed, accel, pml.frametime);
  const vel = length(ps.velocity);
  // slide along the ground plane
  ps.velocity = clipVelocity(ps.velocity, pml.groundTrace.plane.n, PM.overclip);
  // don't decrease velocity when going up or down a slope
  const nv = normalize(ps.velocity);
  ps.velocity = [nv[0] * vel, nv[1] * vel, nv[2] * vel];
  // don't do anything if standing still
  if (!ps.velocity[0] && !ps.velocity[1]) return;
  stepSlideMove(ps, pml, false, PM.mins, playerMaxs(ps));
}

export const SURF_SLICK = 1;

function slideMove(ps, pml, gravity, mins, maxs) {
  const numbumps = 4;
  const planes = [];
  const primal = copy(ps.velocity);
  let endVelocity = copy(ps.velocity);
  if (gravity) {
    endVelocity[2] -= PM.gravity * pml.frametime;
    ps.velocity[2] = (ps.velocity[2] + endVelocity[2]) * 0.5;
    primal[2] = endVelocity[2];
    if (pml.groundPlane) ps.velocity = clipVelocity(ps.velocity, pml.groundTrace.plane.n, PM.overclip);
  }
  let timeLeft = pml.frametime;
  if (pml.groundPlane) planes.push(copy(pml.groundTrace.plane.n));
  planes.push(normalize(ps.velocity));
  let bumpcount;
  for (bumpcount = 0; bumpcount < numbumps; bumpcount++) {
    const end = [ps.origin[0] + timeLeft * ps.velocity[0], ps.origin[1] + timeLeft * ps.velocity[1], ps.origin[2] + timeLeft * ps.velocity[2]];
    const tr = pml.trace(ps.origin, end, mins, maxs);
    if (tr.allsolid) { ps.velocity[2] = 0; return true; }
    if (tr.fraction > 0) ps.origin = copy(tr.endpos);
    if (tr.fraction === 1) break;
    if (tr.entity && pml.touched) pml.touched.push(tr.entity);
    timeLeft -= timeLeft * tr.fraction;
    if (planes.length >= PM.maxClipPlanes) { ps.velocity = [0, 0, 0]; return true; }
    // if this is the same plane we hit before, nudge velocity out along it
    let i;
    for (i = 0; i < planes.length; i++) {
      if (dot(tr.plane.n, planes[i]) > 0.99) { ps.velocity = [ps.velocity[0] + tr.plane.n[0], ps.velocity[1] + tr.plane.n[1], ps.velocity[2] + tr.plane.n[2]]; break; }
    }
    if (i < planes.length) continue;
    planes.push(copy(tr.plane.n));
    // modify velocity so it parallels all of the clip planes
    for (i = 0; i < planes.length; i++) {
      const into = dot(ps.velocity, planes[i]);
      if (into >= 0.1) continue;
      if (-into > (pml.impactSpeed || 0)) pml.impactSpeed = -into;
      let clipV = clipVelocity(ps.velocity, planes[i], PM.overclip);
      let endClipV = clipVelocity(endVelocity, planes[i], PM.overclip);
      let j;
      for (j = 0; j < planes.length; j++) {
        if (j === i) continue;
        if (dot(clipV, planes[j]) >= 0.1) continue;
        clipV = clipVelocity(clipV, planes[j], PM.overclip);
        endClipV = clipVelocity(endClipV, planes[j], PM.overclip);
        if (dot(clipV, planes[i]) >= 0) continue;
        const dir = normalize(cross(planes[i], planes[j]));
        let d = dot(dir, ps.velocity); clipV = [dir[0] * d, dir[1] * d, dir[2] * d];
        d = dot(dir, endVelocity); endClipV = [dir[0] * d, dir[1] * d, dir[2] * d];
        for (let k = 0; k < planes.length; k++) {
          if (k === i || k === j) continue;
          if (dot(clipV, planes[k]) >= 0.1) continue;
          ps.velocity = [0, 0, 0];
          return true;
        }
      }
      ps.velocity = clipV; endVelocity = endClipV;
      break;
    }
  }
  if (gravity) ps.velocity = endVelocity;
  return bumpcount !== 0;
}

function stepSlideMove(ps, pml, gravity, mins, maxs) {
  const startO = copy(ps.origin), startV = copy(ps.velocity);
  if (slideMove(ps, pml, gravity, mins, maxs) === false) return; // got exactly where we wanted
  let down = [startO[0], startO[1], startO[2] - PM.stepSize];
  let tr = pml.trace(startO, down, mins, maxs);
  // never step up when you still have up velocity
  if (ps.velocity[2] > 0 && (tr.fraction === 1 || tr.plane.n[2] < 0.7)) return;
  const downO = copy(ps.origin), downV = copy(ps.velocity);
  const up = [startO[0], startO[1], startO[2] + PM.stepSize];
  tr = pml.trace(startO, up, mins, maxs);
  if (tr.allsolid) return; // can't step up
  const stepSize = tr.endpos[2] - startO[2];
  ps.origin = copy(tr.endpos);
  ps.velocity = copy(startV);
  slideMove(ps, pml, gravity, mins, maxs);
  // push down the final amount
  down = [ps.origin[0], ps.origin[1], ps.origin[2] - stepSize];
  tr = pml.trace(ps.origin, down, mins, maxs);
  if (!tr.allsolid) ps.origin = copy(tr.endpos);
  if (tr.fraction < 1) ps.velocity = clipVelocity(ps.velocity, tr.plane.n, PM.overclip);
  // use the step move only if it got further than the slide move
  const d1 = (ps.origin[0] - startO[0]) ** 2 + (ps.origin[1] - startO[1]) ** 2;
  const d2 = (downO[0] - startO[0]) ** 2 + (downO[1] - startO[1]) ** 2;
  if (d1 < d2 - 0.01) { ps.origin = downO; ps.velocity = downV; return; }
  const delta = ps.origin[2] - startO[2];
  if (delta > 0.5) ps.stepTime = (ps.stepTime || 0) + delta; // for view smoothing
}

function footsteps(ps, pml, events) {
  if (!events) return;
  if (!pml.walking) { ps.bobCycle = 0; return; }
  const speed = Math.hypot(ps.velocity[0], ps.velocity[1]);
  if (speed < 40) { ps.bobCycle = 0; return; }
  const bobmove = (ps.pmFlags & PMF.DUCKED) ? 0.5 : 0.4; // Q3 cycle: 0.4 running per 1/20 s in pmove units
  const old = ps.bobCycle;
  ps.bobCycle = (old + bobmove * pml.frametime * 20 * 64) & 255; // Q3: bobcycle in 0..255, step on wrap of bit 7
  if (((old ^ ps.bobCycle) & 128) && speed > 100) events.push({ type: EV.FOOTSTEP });
}
