// Client bootstrap for the survival slice: menu -> fixed 30 Hz sim loop + render loop. Wires the sim's per-tick
// events to renderer / HUD / audio and exposes everything on window.__survival for automated evidence capture.
//
// Contracts (implemented by the builders):
//   Renderer (survival/render/renderer.js): new Renderer(canvas); setWorld(world); frame(sim, alpha, dt, now);
//     event(e, sim); screenToWorld(px, py) -> [x, y] | null; screenDirToWorld(dx, dy) -> [x, y] (unit);
//     worldToScreen(x, y, z) -> [px, py]; frameStats { draws, tris, ms }; resize()
//   Hud (survival/hud.js): new Hud(); show(); hide(); frame(now); update(sim, dt, ctx); event(e, sim); toggleInventory();
//     setPaused(bool); frameTimes (array of ms)
//   AudioEngine (survival/audio/audio.js): new AudioEngine(); init(); resume(); setVolume(v); event(e, sim);
//     update(sim, dt); triggerLog (array of { cue, t, ctxTime, event, tick }); stats()
import { SurvivalSim, emptyCmd } from '../shared/survival/sim.js';
import { TICK_MS, EV } from '../shared/survival/constants.js';
import { Input } from './input.js';
import { Renderer } from './render/renderer.js';
import { Hud } from './hud.js';
import { AudioEngine } from './audio/audio.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const canvas = $('gl');
const hud = new Hud();
const audio = new AudioEngine();
const input = new Input(canvas);
let renderer = null, sim = null, running = false, paused = false, autopilot = null;
const eventLog = [];        // every sim event with wall time, for the evidence tool
const MAX_EVENT_LOG = 20000;

window.__survival = { get sim() { return sim; }, get autopilot() { return autopilot; }, get renderer() { return renderer; }, get audio() { return audio; }, get hud() { return hud; }, get input() { return input; }, eventLog, get paused() { return paused; }, start, setPaused, params };

$('vol').value = localStorage.getItem('surv.vol') ?? 0.8;
$('vol').oninput = (e) => { audio.setVolume(+e.target.value); localStorage.setItem('surv.vol', e.target.value); };
if (params.get('seed')) $('seed').value = params.get('seed');
$('btn-start').onclick = () => start();
if (params.get('auto')) setTimeout(() => start(), 50);

function status(t) { $('menu-status').textContent = t; }

async function start() {
  if (running) return;
  running = true; status('loading...');
  try {
    audio.init(); audio.resume(); audio.setVolume(+$('vol').value);
    const seed = +($('seed').value || 7);
    const timeScale = +(params.get('fast') || 1);
    sim = new SurvivalSim({ seed, timeScale, noHorde: params.get('nohorde') === '1' });
    renderer = new Renderer(canvas);
    renderer.setWorld(sim.world);
    if (renderer.ready) await renderer.ready;
    audio.setCameraYaw(renderer.yaw); // listener forward = screen-up so a zombie above you on screen pans centre
    if (params.get('autopilot')) { const m = await import('../shared/survival/autopilot.js'); autopilot = new m.Autopilot(sim, { seed, mode: params.get('autopilot') }); }
    input.enabled = true; input.onToggle = (name) => { if (name === 'inventory') hud.toggleInventory(); else if (name === 'pause') setPaused(!paused); };
    $('menu').classList.add('hidden'); hud.show();
    hud.update(sim, 0, { input, renderer, audio });
    loop();
  } catch (e) { console.error(e); status('failed: ' + e.message); running = false; }
}

function setPaused(v) { paused = v; hud.setPaused(v); if (v) audio.setVolume(+$('vol').value * 0.35); else { audio.resume(); audio.setVolume(+$('vol').value); } }

let acc = 0, last = 0;
function loop() {
  requestAnimationFrame(loop);
  const now = performance.now(); if (!last) last = now;
  let dt = (now - last) / 1000; last = now; if (dt > 0.25) dt = 0.25;
  hud.frame(now);
  if (!paused) {
    acc += dt * 1000;
    let steps = 0;
    while (acc >= TICK_MS && steps < 8) {
      const cmd = autopilot ? autopilot.command(sim) : input.command(renderer, sim);
      const events = sim.step(cmd);
      for (const e of events) {
        if (eventLog.length < MAX_EVENT_LOG) eventLog.push({ ...e, wall: +(now).toFixed(1) });
        renderer.event(e, sim); hud.event(e, sim); audio.event(e, sim);
      }
      acc -= TICK_MS; steps++;
    }
    if (steps === 8) acc = 0; // spiral-of-death guard after a stall
  }
  const alpha = paused ? 1 : Math.min(1, acc / TICK_MS);
  renderer.frame(sim, alpha, dt, now);
  audio.update(sim, dt);
  hud.update(sim, dt, { input, renderer, audio, paused });
}

window.addEventListener('resize', () => renderer && renderer.resize());
void EV; void emptyCmd;
