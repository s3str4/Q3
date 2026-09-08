// Client bootstrap: menu, connection modes (server / practice / P2P host / P2P join), fixed-step input loop, render loop.
import { loadMap } from '../shared/map.js';
import { TICK_MS, EV } from '../shared/constants.js';
import { WsTransport, RtcTransport } from './net/transport.js';
import { ClientGame } from './net/clientgame.js';
import { BrowserHost } from './net/host.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Renderer } from './render/renderer.js';
import { AudioEngine } from './audio/audio.js';

const $ = (id) => document.getElementById(id);
const settings = load();
const canvas = $('gl');
const hud = new Hud();
const audio = new AudioEngine();
let renderer = null, cg = null, input = null, host = null, running = false;
window.__arena = { get cg() { return cg; }, get renderer() { return renderer; }, get audio() { return audio; }, get input() { return input; }, hud, settings }; // for automated evidence capture

// ---- menu ----
$('name').value = settings.name; $('server').value = settings.server || defaultServer();
$('sens').value = settings.sens; $('sens-v').textContent = settings.sens; $('fov').value = settings.fov; $('fov-v').textContent = settings.fov; $('vol').value = settings.vol; $('opt-cshair').checked = !!settings.bigCrosshair; $('opt-interp').value = settings.interp;
$('sens').oninput = (e) => { settings.sens = +e.target.value; $('sens-v').textContent = settings.sens; if (input) input.sensitivity = settings.sens; save(); };
$('fov').oninput = (e) => { settings.fov = +e.target.value; $('fov-v').textContent = settings.fov; if (renderer) renderer.setFov(settings.fov); save(); };
$('vol').oninput = (e) => { settings.vol = +e.target.value; audio.setVolume(settings.vol); save(); };
$('opt-cshair').onchange = (e) => { settings.bigCrosshair = e.target.checked; $('crosshair').classList.toggle('large', settings.bigCrosshair); save(); };
$('opt-interp').onchange = (e) => { settings.interp = +e.target.value; if (cg) cg.interpSnaps = settings.interp; save(); };
$('btn-connect').onclick = () => start({ kind: 'ws', url: $('server').value.trim() });
$('btn-practice').onclick = () => start({ kind: 'ws', url: $('server').value.trim(), bot: true });
$('btn-host').onclick = () => start({ kind: 'host' });
$('btn-join').onclick = () => start({ kind: 'join', code: $('p2p-code').value });
const params = new URLSearchParams(location.search);
if (params.get('auto')) setTimeout(() => start({ kind: 'ws', url: params.get('server') || defaultServer(), bot: params.get('bot') === '1', name: params.get('name') }), 100);

function defaultServer() { return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`; }
function status(t) { $('menu-status').textContent = t; }

async function start(mode) {
  if (running) return;
  settings.name = mode.name || $('name').value.trim() || 'player'; settings.server = $('server').value.trim(); save();
  status('loading...');
  try {
    audio.init(); audio.resume(); audio.setVolume(settings.vol);
    let transport, mapName = 'arena_duel', gameMode = 'duel';
    if (mode.kind === 'ws') {
      transport = new WsTransport(normalizeWs(mode.url));
      await transport.connect();
      // ask the server which map it runs
      const info = await fetch(mode.url.replace(/^ws/, 'http').replace(/\/$/, '') + '/info').then((r) => r.json()).catch(() => null);
      if (info) { mapName = info.map; gameMode = info.mode; }
    } else if (mode.kind === 'host') {
      const map = await loadMap(mapName);
      host = new BrowserHost(map, { mode: gameMode, log: (...m) => console.log('[host]', ...m) });
      transport = host.localLink();
      $('p2p-status').textContent = 'creating invite code...';
      const code = await host.invite();
      $('p2p-code').value = code; $('p2p-status').textContent = 'Send this invite code to your opponent, then paste their answer code here and click JOIN WITH CODE.';
      $('btn-join').onclick = async () => { try { await host.acceptAnswer($('p2p-code').value); $('p2p-status').textContent = 'connecting peer...'; } catch (e) { $('p2p-status').textContent = 'bad answer code'; } };
      transport.onmessage = null;
    } else if (mode.kind === 'join') {
      const rtc = new RtcTransport();
      $('p2p-status').textContent = 'creating answer code...';
      const ans = await rtc.answer(mode.code);
      $('p2p-code').value = ans; $('p2p-status').textContent = 'Send this answer code back to the host. Waiting for connection...';
      await new Promise((res, rej) => { rtc.onopen = res; setTimeout(() => rej(new Error('P2P connection timed out (both sides behind symmetric NAT?)')), 30000); });
      transport = rtc;
    }
    const map = await loadMap(mapName);
    renderer = renderer || new Renderer(canvas);
    renderer.loadMap(map); renderer.setFov(settings.fov);
    hud.setMap(map);
    let hostWaiting = mode.kind === 'host';
    cg = new ClientGame(map, transport, { mode: gameMode, name: settings.name, interpSnaps: settings.interp, onEvent: onEvent, onKick: (r) => stop('kicked: ' + r), onInfo: (info) => {
      // P2P host: stay on the menu (the invite code is there) until the guest has joined, then enter the arena
      if (hostWaiting && info.players && info.players.length >= 2) { hostWaiting = false; $('menu').classList.add('hidden'); $('p2p-status').textContent = 'peer connected'; if (!params.get('nolock')) input.lock(); audio.resume(); }
    } });
    transport.onclose = () => stop('disconnected');
    // Q3 shows the map only once the lightmap is loaded: wait for the vertex bake before joining so the countdown
    // never plays over unbaked black faces
    if (renderer.bakePromise) { status('baking lighting...'); await renderer.bakePromise; }
    cg.join(mode.bot ? { bot: true, botSkill: 0.6 } : {}); // ClientGame.join sends the protocol version and retries until WELCOME
    input = input || new Input(canvas, { sensitivity: settings.sens, requireLock: !params.get('nolock'), onEscape: () => { if (running) { $('menu').classList.remove('hidden'); status('paused - click CONNECT to resume or reload'); } }, onScoreboard: (s) => hud.scoreboard(s, cg), currentWeapon: () => cg.predicted ? cg.predicted.weapon : 0, hasWeapon: (w) => cg.predicted ? (cg.predicted.weapons & (1 << w)) !== 0 : true });
    input.sensitivity = settings.sens;
    running = true;
    hud.show(); $('crosshair').classList.toggle('large', settings.bigCrosshair);
    if (!hostWaiting) { $('menu').classList.add('hidden'); if (!params.get('nolock')) input.lock(); }
    else status('hosting: share the invite code below; the arena opens when your opponent connects');
    $('btn-connect').onclick = () => { if (running) { $('menu').classList.add('hidden'); input.lock(); audio.resume(); } };
    loop();
  } catch (e) { console.error(e); status('failed: ' + e.message); running = false; }
}
function normalizeWs(u) { if (!u) return defaultServer(); if (!/^wss?:\/\//.test(u)) u = 'ws://' + u; return u; }
function stop(reason) { running = false; hud.hide(); $('menu').classList.remove('hidden'); status(reason); if (cg) { cg.close(); } if (host) host.close(); cg = null; host = null; }

function onEvent(e, predicted) {
  if (!cg) return;
  if (!e.origin && e.id === cg.localId && cg.predicted) e.origin = cg.predicted.ps.origin;
  renderer.event(e, cg);
  audio.event(e, cg, predicted);
  hud.event(e, cg);
}

// ---- main loop: 60 Hz fixed-step input/prediction on a timer (keeps running when the tab is not painting), render on rAF ----
let acc = 0, lastT = 0, lastSim = 0, spawnedAngles = false, lastTeleSeq = 0, simTimer = null;
function simStep() {
  if (!running || !cg) { clearInterval(simTimer); simTimer = null; return; }
  const now = performance.now();
  acc += lastSim ? now - lastSim : TICK_MS; lastSim = now;
  let steps = 0;
  while (acc >= TICK_MS && steps < 5) { cg.runCommand(input.sample()); acc -= TICK_MS; steps++; }
  if (acc > TICK_MS * 5) acc = 0;
}
function loop() {
  if (!running) return;
  requestAnimationFrame(loop);
  if (!simTimer) simTimer = setInterval(simStep, 4);
  const now = performance.now();
  const dt = Math.min(0.1, lastT ? (now - lastT) / 1000 : 0.016); lastT = now;
  hud.frame(now);
  if (cg.predicted) {
    const p = cg.predicted;
    // adopt spawn / teleport angles
    if ((p.teleportSeq || 0) !== lastTeleSeq) { lastTeleSeq = p.teleportSeq || 0; input.setAngles(0, p.ps.viewangles[1]); }
    if (!spawnedAngles) { spawnedAngles = true; input.setAngles(0, p.ps.viewangles[1]); }
    if (p.dead && p.deathTime && cg.game.time - p.deathTime < 50) { /* keep angles */ }
    if (p.spawnTime && cg.game.time - p.spawnTime < 40 && p.spawnAngles && !p.dead) input.setAngles(0, p.spawnAngles[1]);
  }
  input.applyMouse();
  cg.interpolate();
  const view = cg.localView(now);
  if (view) {
    // render the freshest mouse angles even between sim steps (lowest possible look latency)
    view.angles = [input.pitch, input.yaw, 0];
    renderer.update(cg, view, now, dt);
    audio.updateListener([view.origin[0], view.origin[1], view.origin[2] + view.viewHeight], view.angles);
    hud.update(cg, view, now);
  }
  audio.update(cg, now);
}

function load() { try { return { name: 'player', server: '', sens: 5, fov: 100, vol: 0.8, interp: 2, bigCrosshair: false, ...JSON.parse(localStorage.getItem('arena-settings') || '{}') }; } catch { return { name: 'player', server: '', sens: 5, fov: 100, vol: 0.8, interp: 2 }; } }
function save() { try { localStorage.setItem('arena-settings', JSON.stringify(settings)); } catch {} }
