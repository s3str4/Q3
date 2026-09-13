// Client bootstrap: menu, connection modes (server / practice / P2P host / P2P join), fixed-step input loop, render loop.
import { loadMap } from '../shared/map.js';
import { MAPS, DEFAULT_MAP } from '../maps/index.js';
import { MSG, PROTOCOL_VERSION } from '../shared/protocol.js';
import { TICK_MS, EV, BOT_TIERS, PLAYER_SKINS, PLAYER_COLORS, PHYSICS, playerColorHex } from '../shared/constants.js';
import { WsTransport, RtcTransport, PeerTransport, makeRoomCode, normalizeRoomCode } from './net/transport.js';
import { ClientGame } from './net/clientgame.js';
import { BrowserHost } from './net/host.js';
import { Input, ACTIONS, normalizeBindings, bindingLabel, keyLabel } from './input.js';
import { Hud } from './hud.js';
import { Renderer } from './render/renderer.js';
import { SKIN_PALETTE } from './render/playermodel.js';
import { AudioEngine } from './audio/audio.js';
import { DemoRecorder } from './demo.js';
import { DemoStore, DemoPlayer, unpackDemo, downloadDemo } from './demoplayer.js';

const $ = (id) => document.getElementById(id);
const settings = load();
const canvas = $('gl');
const hud = new Hud();
const audio = new AudioEngine();
let renderer = null, cg = null, input = null, host = null, running = false, loadingMap = false, demoPlayer = null;
// demos: every match is recorded (setting "Record demos") and kept in IndexedDB; the Demos panel lists / plays / exports them
const demoStore = new DemoStore({ keep: 10 });
const recorder = new DemoRecorder({ onDemo: (d) => demoStore.add(d).then((rec) => { refreshDemos(); console.log('[demo] saved', rec.name, Math.round(rec.bytes / 1024) + ' KB'); }).catch((e) => console.warn('[demo] not saved:', e)) });
window.__arena = { get cg() { return cg; }, get renderer() { return renderer; }, get audio() { return audio; }, get input() { return input; }, get host() { return host; }, get demo() { return demoPlayer; }, demos: demoStore, recorder, hud, settings }; // for automated evidence capture

// ---- menu ----
const MODE_BLURB = { duel: '10 min, item control, sudden-death overtime', arena: 'rounds, full loadout, 100/100, no pickups, first to 6' };
$('name').value = settings.name; $('server').value = settings.server || defaultServer();
$('sens').value = settings.sens; $('sens-v').textContent = settings.sens; $('fov').value = settings.fov; $('fov-v').textContent = settings.fov; $('vol').value = settings.vol; $('opt-cshair').checked = !!settings.bigCrosshair; $('opt-interp').value = settings.interp;
$('sens').oninput = (e) => { settings.sens = +e.target.value; $('sens-v').textContent = settings.sens; if (input) input.sensitivity = settings.sens; save(); };
$('fov').oninput = (e) => { settings.fov = +e.target.value; $('fov-v').textContent = settings.fov; if (renderer) renderer.setFov(settings.fov); save(); };
$('vol').oninput = (e) => { settings.vol = +e.target.value; audio.setVolume(settings.vol); save(); };
$('opt-cshair').onchange = (e) => { settings.bigCrosshair = e.target.checked; $('crosshair').classList.toggle('large', settings.bigCrosshair); save(); };
$('opt-announcer').checked = settings.announcer !== false;
$('opt-announcer').onchange = (e) => { settings.announcer = e.target.checked; audio.announcerEnabled = settings.announcer; if (!settings.announcer) audio.stopAnnounce(); save(); };
$('opt-demos').checked = settings.recordDemos !== false;
$('opt-demos').onchange = (e) => { settings.recordDemos = e.target.checked; save(); if (!settings.recordDemos) recorder.disarm(); else if (cg && cg.localId) recorder.arm(DemoRecorder.headerFrom(cg)); };
// map / mode selectors (host side; the guest learns both from the WELCOME handshake), bot difficulty for practice
for (const mp of MAPS) { const o = document.createElement('option'); o.value = mp.id; o.textContent = mp.title; $('map').appendChild(o); }
if (!MAPS.some((mp) => mp.id === settings.map)) settings.map = DEFAULT_MAP;
if (!['duel', 'arena'].includes(settings.mode)) settings.mode = 'duel';
if (!BOT_TIERS[settings.botSkill]) settings.botSkill = 'normal';
$('map').value = settings.map; $('map-blurb').textContent = (MAPS.find((mp) => mp.id === settings.map) || {}).blurb || '';
$('map').onchange = (e) => { settings.map = e.target.value; $('map-blurb').textContent = (MAPS.find((mp) => mp.id === settings.map) || {}).blurb || ''; save(); };
$('mode').value = settings.mode; $('mode-blurb').textContent = MODE_BLURB[settings.mode];
$('mode').onchange = (e) => { settings.mode = e.target.value; $('mode-blurb').textContent = MODE_BLURB[settings.mode]; save(); };
$('bot-skill').value = settings.botSkill;
$('bot-skill').onchange = (e) => { settings.botSkill = e.target.value; save(); };
$('opt-interp').onchange = (e) => { settings.interp = +e.target.value; if (cg) cg.interpSnaps = settings.interp; save(); };
// physics rule (host side, like map / mode): vq3 or CPM air control; a dedicated server keeps its own rules
const PHYSICS_BLURB = { vq3: 'vanilla Quake 3 movement', cpm: 'ProMode air control: forward steers in the air, A/D air strafes snap' };
if (!PHYSICS.includes(settings.physics)) settings.physics = 'vq3';
$('physics').value = settings.physics; $('physics-blurb').textContent = PHYSICS_BLURB[settings.physics];
$('physics').onchange = (e) => { settings.physics = e.target.value; $('physics-blurb').textContent = PHYSICS_BLURB[settings.physics]; save(); };
// ---- identity: skin + colour (sent in JOIN, echoed in snapshots so the opponent sees them) ----
const SKIN_BLURB = { sarge: 'olive armour, the classic marine', visor: 'blue-white armour, mirrored visor', anarki: 'magenta punk, exposed face' };
if (!PLAYER_SKINS.includes(settings.skin)) settings.skin = 'sarge';
if (!Number.isInteger(settings.color) || !PLAYER_COLORS[settings.color]) settings.color = 5;
for (const s of PLAYER_SKINS) { const o = document.createElement('option'); o.value = s; o.textContent = s[0].toUpperCase() + s.slice(1); $('skin').appendChild(o); }
PLAYER_COLORS.forEach((c, i) => { const d = document.createElement('span'); d.className = 'sw'; d.title = c.name; d.style.setProperty('--c', hexCss(c.hex)); d.onclick = () => { settings.color = i; save(); refreshIdentity(); }; $('colors').appendChild(d); });
$('skin').onchange = (e) => { settings.skin = e.target.value; save(); refreshIdentity(); };
function refreshIdentity() {
  $('skin').value = settings.skin; $('skin-blurb').textContent = SKIN_BLURB[settings.skin] || '';
  [...$('colors').children].forEach((d, i) => d.classList.toggle('on', i === settings.color));
  $('color-name').textContent = PLAYER_COLORS[settings.color].name;
  drawSkinPreview($('skin-preview'), settings.skin, PLAYER_COLORS[settings.color].hex);
}
// Menu preview: a small 2D figure in the skin's palette (armour / plate / undersuit / flesh) with the chosen colour
// on the visor and the chest stripe, the same parts the third-person model lights up.
function drawSkinPreview(canvas, skin, colorHex) {
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height, pal = SKIN_PALETTE[skin] || SKIN_PALETTE.sarge;
  const rgb = (c, k = 1) => `rgb(${c.map((v) => Math.round(Math.min(1, v * k) * 255)).join(',')})`;
  const col = hexCss(colorHex);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.beginPath(); ctx.ellipse(W / 2, H - 8, 26, 6, 0, 0, Math.PI * 2); ctx.fill(); // blob shadow
  const rect = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
  rect(34, 84, 11, 30, rgb(pal.suit)); rect(51, 84, 11, 30, rgb(pal.suit));                       // legs
  rect(31, 110, 15, 8, rgb(pal.plate, 0.9)); rect(50, 110, 15, 8, rgb(pal.plate, 0.9));           // boots
  rect(36, 92, 8, 12, rgb(pal.base, 0.9)); rect(52, 92, 8, 12, rgb(pal.base, 0.9));               // thigh plates
  rect(30, 76, 36, 10, rgb(pal.suit)); rect(30, 74, 36, 3, rgb(pal.plate));                       // pelvis + belt
  rect(28, 44, 40, 32, rgb(pal.base)); rect(18, 44, 10, 26, rgb(pal.suit)); rect(68, 44, 10, 26, rgb(pal.suit)); // chest + arms
  rect(16, 40, 14, 10, rgb(pal.base, 1.05)); rect(66, 40, 14, 10, rgb(pal.base, 1.05));         // shoulder pads
  rect(38, 50, 20, 14, rgb(pal.plate)); ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 8; ctx.fillRect(28, 66, 40, 4); ctx.fillRect(44, 54, 8, 5); ctx.shadowBlur = 0; // breastplate, stripe, emblem
  rect(19, 70, 8, 10, rgb(pal.plate, 0.9)); rect(69, 70, 8, 10, rgb(pal.plate, 0.9));           // hands
  ctx.fillStyle = pal.face ? rgb(pal.flesh) : rgb(pal.suit); ctx.beginPath(); ctx.ellipse(48, 30, 11, 12, 0, 0, Math.PI * 2); ctx.fill(); // head
  ctx.fillStyle = rgb(pal.base, 1.05); ctx.beginPath(); ctx.ellipse(48, 27, 12.5, 12, 0, Math.PI, Math.PI * 2); ctx.fill(); // helmet cap
  ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 10; ctx.fillRect(39, 27, 18, 5); ctx.shadowBlur = 0;   // visor
}
function hexCss(h) { return '#' + (h >>> 0).toString(16).padStart(6, '0'); }
refreshIdentity();
// ---- keys: the bindings table (click a binding, press a key / mouse button / wheel; Esc cancels) ----
settings.keys = normalizeBindings(settings.keys);
let listening = null; // { action, btn } while a rebind waits for a key
function buildKeys() {
  const t = $('keys'); t.innerHTML = '';
  for (const [a, label] of ACTIONS) {
    const tr = document.createElement('tr'); tr.innerHTML = `<td class="a">${label}</td><td class="b"></td>`;
    const b = document.createElement('button'); b.className = 'kb'; b.dataset.action = a; b.textContent = bindingLabel(settings.keys[a]);
    b.onclick = () => startRebind(a, b);
    tr.lastChild.appendChild(b); t.appendChild(tr);
  }
  updateHelp();
}
function startRebind(action, btn) {
  cancelRebind();
  listening = { action, btn }; btn.classList.add('listening'); btn.textContent = 'PRESS A KEY...';
  $('keys-hint').textContent = `binding "${ACTIONS.find((x) => x[0] === action)[1]}": press a key, a mouse button or turn the wheel (Esc cancels)`;
}
function cancelRebind() { if (!listening) return; listening.btn.classList.remove('listening'); listening.btn.textContent = bindingLabel(settings.keys[listening.action]); listening = null; $('keys-hint').textContent = 'click a binding, then press a key or mouse button (Esc cancels)'; }
function finishRebind(code) {
  const { action, btn } = listening; listening = null;
  settings.keys[action] = [code]; // one key per action after a rebind (defaults may list alternates)
  const stolen = [];
  for (const a in settings.keys) if (a !== action && settings.keys[a].includes(code)) { settings.keys[a] = settings.keys[a].filter((c) => c !== code); if (!settings.keys[a].length) stolen.push(ACTIONS.find((x) => x[0] === a)[1]); } // a key binds one action
  btn.classList.remove('listening'); save(); applyKeys();
  $('keys-hint').textContent = `${ACTIONS.find((x) => x[0] === action)[1]} = ${keyLabel(code)}` + (stolen.length ? ` (${stolen.join(', ')} now unbound)` : '');
}
function applyKeys() { for (const b of $('keys').querySelectorAll('.kb')) b.textContent = bindingLabel(settings.keys[b.dataset.action]); if (input) input.setBindings(settings.keys); updateHelp(); }
function updateHelp() {
  const k = settings.keys, one = (a) => (k[a].length ? keyLabel(k[a][0]) : '-');
  const move = ['forward', 'left', 'back', 'right'].map(one); const moveTxt = move.every((m) => m.length === 1) ? move.join('') : move.join('/');
  const w1 = one('weapon1'), w7 = one('weapon7'), wheel = k.nextweapon.some((c) => c.startsWith('Wheel')) ? ' / wheel' : '';
  $('help').textContent = `${moveTxt} move · ${one('jump')} jump · ${one('crouch')} crouch · ${one('attack')} fire · ${w1}-${w7}${wheel} weapons · ${one('scoreboard')} scoreboard · Esc menu`;
}
// capture-phase listeners so a rebind press never reaches the game (and Esc in the middle of one only cancels it)
document.addEventListener('keydown', (e) => { if (!listening) return; e.preventDefault(); e.stopImmediatePropagation(); if (e.code === 'Escape') cancelRebind(); else if (e.code) finishRebind(e.code); }, true);
document.addEventListener('mousedown', (e) => { if (!listening || e.target === listening.btn) return; e.preventDefault(); e.stopImmediatePropagation(); finishRebind('Mouse' + e.button); }, true);
document.addEventListener('contextmenu', (e) => { if (listening) e.preventDefault(); }, true);
document.addEventListener('wheel', (e) => { if (!listening) return; e.preventDefault(); e.stopImmediatePropagation(); finishRebind(e.deltaY > 0 ? 'WheelDown' : 'WheelUp'); }, { capture: true, passive: false });
$('keys-reset').onclick = () => { cancelRebind(); settings.keys = normalizeBindings({}); save(); applyKeys(); $('keys-hint').textContent = 'defaults restored'; };
buildKeys();
window.__arena.rebind = (action, code) => { settings.keys[action] = [code]; save(); applyKeys(); }; // automation hook
let staticPage = false; // true when the page is not served by a game server (GitHub Pages etc.)
const NO_SERVER_MSG = 'This page has no game server behind it. To play someone: HOST GAME and send the room code (or JOIN with theirs). To join a dedicated server, enter its address (ws://host:27960) above.';
$('btn-connect').onclick = () => { const url = $('server').value.trim(); if (staticPage && !url) { status(NO_SERVER_MSG); $('p2p-panel').open = true; return; } start({ kind: 'ws', url }); };
// practice: server bot when a game server serves the page, otherwise an in-browser session with a bot (no network at all)
$('btn-practice').onclick = () => { const url = $('server').value.trim(); if (staticPage && !url) start({ kind: 'local' }); else start({ kind: 'ws', url, bot: true }); };
$('btn-host').onclick = () => start({ kind: 'host-room' });
$('btn-join').onclick = () => start({ kind: 'join-room', room: $('room').value });
$('room').addEventListener('keydown', (e) => { if (e.key === 'Enter') start({ kind: 'join-room', room: $('room').value }); });
$('btn-host-manual').onclick = () => start({ kind: 'host' });
$('btn-join-manual').onclick = () => start({ kind: 'join', code: $('p2p-code').value });
$('btn-copy-room').onclick = () => copyText($('room-code').textContent, $('btn-copy-room'));
$('btn-copy-room-link').onclick = () => copyText(location.origin + location.pathname + '?room=' + $('room-code').textContent, $('btn-copy-room-link'));
const params = new URLSearchParams(location.search);
// Automation parameters: ?mode=arena&skill=pro&map=lava_spire pre-select the menu; ?rules={"rounds":3} overrides the
// match rules of a browser-hosted session (practice / P2P host) and is honoured only when the page is served from
// localhost (test hook, never on a public deployment).
const LOCAL_PAGE = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
// on localhost any map module (e.g. testbox) may be named for automation; a public page only offers the menu maps
if (params.get('map') && (MAPS.some((mp) => mp.id === params.get('map')) || (LOCAL_PAGE && /^[a-z0-9_]+$/.test(params.get('map'))))) { settings.map = params.get('map'); $('map').value = settings.map; }
if (params.get('mode') && MODE_BLURB[params.get('mode')]) { settings.mode = params.get('mode'); $('mode').value = settings.mode; $('mode-blurb').textContent = MODE_BLURB[settings.mode]; }
if (params.get('skill') && BOT_TIERS[params.get('skill')]) { settings.botSkill = params.get('skill'); $('bot-skill').value = settings.botSkill; }
if (params.get('name')) $('name').value = params.get('name').slice(0, 24);
if (params.get('physics') && PHYSICS.includes(params.get('physics'))) { settings.physics = params.get('physics'); $('physics').value = settings.physics; $('physics-blurb').textContent = PHYSICS_BLURB[settings.physics]; }
if (params.get('skin') && PLAYER_SKINS.includes(params.get('skin'))) settings.skin = params.get('skin');
if (params.get('color') && PLAYER_COLORS[+params.get('color')]) settings.color = +params.get('color');
if (params.get('skin') || params.get('color')) refreshIdentity();
let rulesOverride = null;
if (params.get('rules') && LOCAL_PAGE) { try { rulesOverride = JSON.parse(params.get('rules')); } catch { rulesOverride = null; } }
// Static hosting (e.g. GitHub Pages): no game server behind the page. Detect it once and put the P2P flow forward.
const servedByGameServer = fetch('info', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
servedByGameServer.then((info) => {
  if (info) return;
  staticPage = true;
  $('btn-connect').title = NO_SERVER_MSG; $('btn-practice').textContent = 'PRACTICE VS BOT (LOCAL)';
  $('p2p-panel').open = true;
  $('server').placeholder = 'ws://host:27960 (needs a running server)';
  if (!settings.server) $('server').value = '';
  status('No server behind this page: play with a room code (HOST GAME / JOIN) or practice locally.');
});
// Invite links: ?join=<invite code> pre-fills the code and starts the guest flow automatically.
const roomParam = params.get('room');
if (roomParam) { $('p2p-panel').open = true; $('room').value = normalizeRoomCode(roomParam); setTimeout(() => start({ kind: 'join-room', room: roomParam }), 100); }
const joinCode = params.get('join');
if (joinCode) { $('p2p-panel').open = true; $('p2p-panel').querySelector('details').open = true; $('p2p-code').value = joinCode; setTimeout(() => start({ kind: 'join', code: joinCode }), 100); }
const copyText = async (text, btn) => {
  try { await navigator.clipboard.writeText(text); const t = btn.textContent; btn.textContent = 'COPIED'; setTimeout(() => (btn.textContent = t), 1200); }
  catch { $('p2p-code').select(); document.execCommand && document.execCommand('copy'); }
};
$('btn-copy-code').onclick = () => copyText($('p2p-code').value, $('btn-copy-code'));
$('btn-copy-link').onclick = () => copyText(location.origin + location.pathname + '?join=' + encodeURIComponent($('p2p-code').value), $('btn-copy-link'));
// ---- demos panel: the library (newest first) with Play / Download / Delete, and Load file to import one ----
async function refreshDemos() {
  const list = $('demos-list');
  let demos = [];
  try { demos = await demoStore.list(); } catch (e) { list.innerHTML = '<div class="none">demo storage unavailable (' + esc(e.message) + ')</div>'; return; }
  if (!demos.length) { list.innerHTML = '<div class="none">no demos yet: every match is recorded while "Record demos" is on</div>'; return; }
  list.innerHTML = demos.map((d) => `<div class="demo" data-id="${d.id}"><div class="n">${esc(d.name)}</div><div class="m">${fmtDur(d.duration)} · ${d.snaps || '?'} snapshots · ${Math.round(d.bytes / 1024)} KB${d.gz ? ' gzip' : ''}</div><div class="b"><button class="play primary">PLAY</button><button class="dl">DOWNLOAD</button><button class="del">DELETE</button></div></div>`).join('');
  for (const row of list.querySelectorAll('.demo')) {
    const id = +row.dataset.id;
    row.querySelector('.play').onclick = async () => { try { $('demos-status').textContent = 'loading demo...'; const demo = await demoStore.get(id); $('demos-status').textContent = ''; start({ kind: 'demo', demo }); } catch (e) { $('demos-status').textContent = 'cannot play: ' + e.message; } };
    row.querySelector('.dl').onclick = async () => { try { const rec = await demoStore.getRecord(id); const name = await downloadDemo(rec); $('demos-status').textContent = 'saved ' + name; } catch (e) { $('demos-status').textContent = 'download failed: ' + e.message; } };
    row.querySelector('.del').onclick = async () => { await demoStore.remove(id); refreshDemos(); };
  }
}
$('btn-demo-load').onclick = () => $('demo-file').click();
$('demo-file').onchange = async (e) => {
  const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
  try { $('demos-status').textContent = 'reading ' + f.name + '...'; const demo = await unpackDemo(f); const rec = await demoStore.add(demo); await refreshDemos(); $('demos-status').textContent = 'imported: ' + rec.name; }
  catch (err) { $('demos-status').textContent = 'import failed: ' + err.message; }
};
$('demos-panel').addEventListener('toggle', () => { if ($('demos-panel').open) refreshDemos(); });
refreshDemos();
function fmtDur(ms) { const s = Math.round((ms || 0) / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function esc(t) { return String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
// ?auto=1 joins the server (bot=1: practice); ?auto=1&local=1 runs a browser-hosted practice match (no server needed)
if (params.get('auto')) setTimeout(() => start(params.get('local') ? { kind: 'local', name: params.get('name') } : { kind: 'ws', url: params.get('server') || defaultServer(), bot: params.get('bot') === '1', name: params.get('name') }), 100);

function defaultServer() { return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`; }
function status(t) { $('menu-status').textContent = t; }
const botSkill = () => BOT_TIERS[settings.botSkill] ?? BOT_TIERS.normal;

// Load a map into the renderer and the HUD (first start and every server-driven map change). Q3 shows the map only
// once the lightmap is loaded: wait for the vertex bake so the countdown never plays over unbaked black faces.
async function loadArena(mapName) {
  const map = await loadMap(mapName);
  renderer = renderer || new Renderer(canvas);
  renderer.loadMap(map); renderer.setFov(settings.fov);
  hud.setMap(map);
  if (renderer.bakePromise) { status('baking lighting...'); await renderer.bakePromise; status(''); }
  return map;
}

async function start(mode) {
  if (running) return;
  if (mode.kind === 'demo') return startDemo(mode.demo);
  settings.name = mode.name || $('name').value.trim() || 'player'; settings.server = $('server').value.trim(); save();
  status('loading...');
  try {
    audio.init(); audio.resume(); audio.setVolume(settings.vol); audio.announcerEnabled = settings.announcer !== false; audio.loadVoices().catch((err) => console.warn('[audio] voice pack', err)); audio.loadSamples().catch((err) => console.warn('[audio] sample pack', err));
    let transport, mapName = settings.map || DEFAULT_MAP, gameMode = settings.mode || 'duel';
    const ident = { skin: settings.skin, color: settings.color };
    const hostOpts = () => ({ mode: gameMode, rules: { physics: settings.physics, ...(rulesOverride || {}) }, log: (...m) => console.log('[host]', ...m) });
    if (mode.kind === 'ws') {
      if (!mode.url) throw new Error('no server address: enter ws://host:27960, or use HOST GAME / JOIN with a room code');
      transport = new WsTransport(normalizeWs(mode.url));
      try { await transport.connect(); } catch { throw new Error('could not reach the server at ' + normalizeWs(mode.url) + ' (is it running and reachable?). For play without a server use HOST GAME / JOIN.'); }
      // ask the server which map and mode it runs
      const info = await fetch(mode.url.replace(/^ws/, 'http').replace(/\/$/, '') + '/info').then((r) => r.json()).catch(() => null);
      if (info) { mapName = info.map; gameMode = info.mode; }
    } else if (mode.kind === 'local') {
      // practice without any server: the browser hosts the session and a bot fills the other slot
      const map = await loadMap(mapName);
      host = new BrowserHost(map, hostOpts());
      transport = host.localLink();
      host.addBot(botSkill());
      transport.onmessage = null;
    } else if (mode.kind === 'host-room') {
      if (!PeerTransport.available()) throw new Error('signaling library not loaded; use the manual exchange below');
      const map = await loadMap(mapName);
      host = new BrowserHost(map, hostOpts());
      transport = host.localLink();
      $('p2p-status').textContent = 'registering room...';
      let code = makeRoomCode();
      for (let attempt = 0; ; attempt++) {
        try { await host.inviteRoom(code); break; }
        catch (e) { if (e && e.type === 'unavailable-id' && attempt < 3) { code = makeRoomCode(); continue; } throw new Error('signaling service unreachable (' + (e && e.type || e.message) + '); use the manual exchange below'); }
      }
      $('room-code').textContent = code; $('room-box').classList.remove('hidden');
      $('p2p-status').textContent = 'Give this room code (or the link) to your opponent. The arena opens when they join.';
      transport.onmessage = null;
    } else if (mode.kind === 'join-room') {
      if (!PeerTransport.available()) throw new Error('signaling library not loaded; use the manual exchange below');
      const code = normalizeRoomCode(mode.room);
      if (code.length < 4) throw new Error('enter the room code the host gave you');
      const pt = new PeerTransport();
      $('p2p-status').textContent = 'joining room ' + code + '...';
      try { await pt.join(code, (msg) => { $('p2p-status').textContent = msg; }); $('p2p-status').textContent = 'connected to the host, loading the arena...'; }
      catch (e) { const t = e && e.type; throw new Error(t === 'peer-unavailable' ? 'no host found for room ' + code + ' (check the code; the host must have clicked HOST GAME and keep the page open)' : t === 'timeout' ? 'the host was found but no network path opened in 30 s (ICE ' + e.iceState + '). Retry once; if it persists, one side is behind a NAT/firewall that blocks direct UDP: use a dedicated server (port forward or tunnel, see README) instead' : t === 'network' || t === 'server-error' || t === 'socket-error' ? 'cannot reach the signaling server (' + t + '): a firewall or proxy blocks wss://0.peerjs.com; use the manual exchange below or a server' : 'could not connect (' + (t || e.message) + ', ICE ' + (e.iceState || '?') + '); try again or use a server'); }
      transport = pt;
      ({ map: mapName, mode: gameMode } = await handshake(transport, settings.name, ident));
    } else if (mode.kind === 'host') {
      const map = await loadMap(mapName);
      host = new BrowserHost(map, hostOpts());
      transport = host.localLink();
      $('p2p-status').textContent = 'creating invite code...';
      const code = await host.invite();
      $('p2p-code').value = code; $('btn-copy-link').classList.remove('hidden'); $('btn-copy-code').classList.remove('hidden');
      $('p2p-status').textContent = 'Send the invite LINK (or the code) to your opponent, then paste their answer code here and click JOIN WITH CODE.';
      $('btn-join-manual').onclick = async () => { try { await host.acceptAnswer($('p2p-code').value); $('p2p-status').textContent = 'connecting peer...'; } catch (e) { $('p2p-status').textContent = 'bad answer code'; } };
      transport.onmessage = null;
    } else if (mode.kind === 'join') {
      const rtc = new RtcTransport();
      $('p2p-status').textContent = 'creating answer code...';
      const ans = await rtc.answer(mode.code);
      $('p2p-code').value = ans; $('btn-copy-code').classList.remove('hidden'); $('btn-copy-link').classList.add('hidden'); $('p2p-status').textContent = 'Send this answer code back to the host. Waiting for connection...';
      await new Promise((res, rej) => { rtc.onopen = res; setTimeout(() => rej(new Error('P2P connection timed out after 5 minutes (host did not accept the answer, or both sides are behind symmetric NAT)')), 300000); });
      transport = rtc;
      ({ map: mapName, mode: gameMode } = await handshake(transport, settings.name, ident));
    }
    const map = await loadArena(mapName);
    let hostWaiting = mode.kind === 'host' || mode.kind === 'host-room';
    const game = cg = new ClientGame(map, transport, { mode: gameMode, name: settings.name, skin: ident.skin, color: ident.color, interpSnaps: settings.interp, onEvent: onEvent, onKick: (r) => stop('kicked: ' + r),
      // demo recording: armed on WELCOME (map / mode / rules known), every snapshot on arrival, the view per frame in loop()
      onWelcome: (m) => { if (settings.recordDemos !== false) recorder.arm(DemoRecorder.headerFrom(game, m)); if (!game.welcomed) { game.welcomed = true; audio.loadVoices().then(() => audio.announce('welcome')).catch(() => {}); } },
      onSnap: (snap) => recorder.snapshot(snap, snap.recvAt),
      onInfo: (info) => {
        // P2P host: stay on the menu (the invite code is there) until the guest has joined, then enter the arena
        if (hostWaiting && info.players && info.players.length >= 2) { hostWaiting = false; $('menu').classList.add('hidden'); $('p2p-status').textContent = 'peer connected'; if (!params.get('nolock')) input.lock(); audio.resume(); }
      },
      onVotes: (v) => hud.votes(v, game),
      onMapChange: (m) => changeMap(game, m),
    });
    transport.onclose = () => stop('disconnected');
    cg.join(mode.bot ? { bot: true, botSkill: botSkill() } : {}); // ClientGame.join sends the protocol version and retries until WELCOME
    ensureInput();
    // end screen controls -> intermission protocol
    hud.onVote = (v) => { if (cg) cg.sendVote(v); };
    hud.onReady = (r) => { if (cg) cg.sendReady(r); };
    hud.onLeave = () => stop('left the match');
    running = true;
    hud.show(); $('crosshair').classList.toggle('large', settings.bigCrosshair);
    if (!hostWaiting) { $('menu').classList.add('hidden'); if (!params.get('nolock')) { input.lock(); input.onLockChange(input.locked); } }
    else status('hosting: share the invite code below; the arena opens when your opponent connects');
    $('btn-connect').onclick = resumeHandler;
    $('click-to-play').onclick = () => { input.lock(); audio.resume(); };
    loop();
  } catch (e) { console.error(e); status('failed: ' + e.message); running = false; }
}
// The Input object is created once (its document listeners live for the page) and shared by the live game and the demo player.
function ensureInput() {
  input = input || new Input(canvas, { sensitivity: settings.sens, bindings: settings.keys, requireLock: !params.get('nolock'), keysAllowed: () => running && $('menu').classList.contains('hidden') && !hud.endVisible, onLockChange: (locked) => { $('click-to-play').classList.toggle('hidden', locked || !running || !!params.get('nolock') || !$('menu').classList.contains('hidden') || hud.endVisible); }, onEscape: () => { if (running && !hud.endVisible) { $('menu').classList.remove('hidden'); $('click-to-play').classList.add('hidden'); status('paused - click CONNECT to resume'); } }, onScoreboard: (s) => hud.scoreboard(s, cg), currentWeapon: () => cg && cg.predicted ? cg.predicted.weapon : 0, hasWeapon: (w) => cg && cg.predicted ? (cg.predicted.weapons & (1 << w)) !== 0 : true });
  input.sensitivity = settings.sens;
  return input;
}
const connectHandler = $('btn-connect').onclick; // CONNECT starts a session; during one it resumes (menu closed, mouse captured)
const resumeHandler = () => { if (running && cg) { $('menu').classList.add('hidden'); input.lock(); input.onLockChange(input.locked); audio.resume(); } };
// ---- demo playback: the recorded match through the same renderer / HUD / audio, no network (client/demoplayer.js) ----
async function startDemo(demo) {
  if (running) return;
  status('loading demo...');
  try {
    audio.init(); audio.resume(); audio.setVolume(settings.vol); audio.announcerEnabled = settings.announcer !== false; audio.loadVoices().catch((err) => console.warn('[audio] voice pack', err)); audio.loadSamples().catch((err) => console.warn('[audio] sample pack', err));
    const map = await loadArena(demo.map);
    ensureInput();
    running = true;
    demoPlayer = new DemoPlayer(demo, { map, renderer, hud, audio, input, canvas, settings, onExit: () => stopDemo('demo closed') });
    hud.show(); $('crosshair').classList.toggle('large', settings.bigCrosshair); $('menu').classList.add('hidden'); $('click-to-play').classList.add('hidden');
    demoPlayer.start();
    status('');
  } catch (e) { console.error(e); status('demo failed: ' + e.message); running = false; if (demoPlayer) { demoPlayer.stop(); demoPlayer = null; } }
}
function stopDemo(reason) { running = false; if (demoPlayer) demoPlayer.stop(); demoPlayer = null; hud.hide(); $('menu').classList.remove('hidden'); $('btn-connect').onclick = connectHandler; status(reason); }
// Server-driven map / mode change (after a map vote): reload the renderer and HUD for the new map, rebuild the client
// game, then report LOADED so the server can release the countdown. Snapshots that arrive meanwhile belong to the
// new server game and are only applied once the client game matches it (setMap), which is why this is sequential.
async function changeMap(game, m) {
  if (cg !== game) return;
  loadingMap = true;
  hud.hideEnd();
  hud.center('LOADING', 1500, (MAPS.find((mp) => mp.id === m.map) || {}).title || m.map);
  try {
    const sameMap = game.mapName === m.map;
    const map = sameMap ? game.map : await loadArena(m.map);
    if (cg !== game) return; // the session ended while the map was loading
    game.setMap(map, m.mode, m.rules);
    game.sendLoaded();
    recorder.stop(); if (settings.recordDemos !== false) recorder.arm(DemoRecorder.headerFrom(game)); // a new match on the new map: a new demo
    spawnedAngles = false;
    if (input) input.onLockChange(input.locked); // the click-to-play overlay comes back if the end screen released the mouse
  } catch (e) { console.error('map change failed', e); stop('map change failed: ' + e.message); }
  finally { loadingMap = false; }
}
// One-shot JOIN -> WELCOME exchange to learn which map/mode the host runs (the session resends WELCOME on the
// client's later JOIN, so this costs nothing). This first JOIN is the one that creates the player, so it carries
// the identity (skin / colour) too. Falls back to the default map if the host never answers.
function handshake(transport, name, ident = {}) {
  return new Promise((resolve) => {
    const prev = transport.onmessage;
    const done = (v) => { transport.onmessage = prev; clearTimeout(t); resolve(v); };
    const t = setTimeout(() => done({ map: DEFAULT_MAP, mode: 'duel' }), 8000);
    transport.onmessage = (msg) => { if (msg && msg.t === MSG.WELCOME) done({ map: msg.map || DEFAULT_MAP, mode: msg.mode || 'duel' }); else if (msg && msg.t === MSG.KICK) done({ map: DEFAULT_MAP, mode: 'duel' }); };
    transport.send({ t: MSG.JOIN, name, v: PROTOCOL_VERSION, ...(ident.skin ? { skin: ident.skin } : {}), ...(Number.isInteger(ident.color) ? { color: ident.color } : {}) });
  });
}
function normalizeWs(u) { if (!u) return defaultServer(); if (!/^wss?:\/\//.test(u)) u = 'ws://' + u; return u; }
// Re-entrant: closing a browser-hosted session fires the local link's onclose synchronously, which lands here again.
function stop(reason) { if (!running && !cg && !host) return; running = false; recorder.stop(); hud.hide(); $('menu').classList.remove('hidden'); $('click-to-play').classList.add('hidden'); $('btn-connect').onclick = connectHandler; status(reason); const c = cg, h = host; cg = null; host = null; if (c) c.close(); if (h) h.close(); }

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
  const view = loadingMap ? null : cg.localView(now);
  if (view) {
    // render the freshest mouse angles even between sim steps (lowest possible look latency)
    view.angles = [input.pitch, input.yaw, 0];
    if (recorder.recording) recorder.view(cg.lastRenderTime ?? cg.renderTime(now), view, now); // the demo keeps what this frame shows
    renderer.update(cg, view, now, dt);
    audio.updateListener([view.origin[0], view.origin[1], view.origin[2] + view.viewHeight], view.angles);
    hud.update(cg, view, now);
  }
  audio.update(cg, now);
}

function DEFAULT_SETTINGS() { return { name: 'player', server: '', sens: 5, fov: 100, vol: 0.8, interp: 2, bigCrosshair: false, recordDemos: true, map: 'arena_duel', mode: 'duel', botSkill: 'normal', physics: 'vq3', skin: 'sarge', color: 5, keys: {} }; }
function load() { try { return { ...DEFAULT_SETTINGS(), ...JSON.parse(localStorage.getItem('arena-settings') || '{}') }; } catch { return DEFAULT_SETTINGS(); } }
function save() { try { localStorage.setItem('arena-settings', JSON.stringify(settings)); } catch {} }
