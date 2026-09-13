// Demo playback and the demo library (browser side of client/demo.js).
//   DemoStore    the last N demos in IndexedDB, gzip-packed (CompressionStream) when the browser has it
//   packDemo / unpackDemo / downloadDemo / demoTitle   files: <name>.json.gz (or .json without CompressionStream)
//   DemoPlayer   plays a demo through the live renderer / HUD / audio: a ClientGame-compatible object (cg) whose
//                remote players, projectiles, items and events come from the recorded snapshots on the recorded
//                timeline (no network, no prediction); the recorder's first-person view drives the camera, or a
//                third-person chase of either player, or a free camera (WASD + mouse, no clipping). DOM overlay:
//                play / pause, timeline with frag marks, speed, camera, frag list; Space / arrows / [ ] / C / F / Esc.
import { Game } from '../shared/game.js';
import { EV } from '../shared/constants.js';
import { PMF } from '../shared/pmove.js';
import { angleVectors } from '../shared/vec3.js';
import { traceBox } from '../shared/trace.js';
import { MAPS } from '../maps/index.js';
import { DemoCursor, demoSummary, demoFrags, validateDemo } from './demo.js';

const $ = (id) => document.getElementById(id);
const MODE_TITLE = { duel: 'Duel', arena: 'Arena' };
const mapTitle = (id) => (MAPS.find((m) => m.id === id) || {}).title || id;
export const SPEEDS = [0.25, 0.5, 1, 2, 4];
const CHASE_BACK = 90, CHASE_UP = 18, FREE_SPEED = 480, SEEK_STEP = 5000;

// ---------------------------------------------------------------------------------------------------------------
// files
export const canGzip = () => typeof CompressionStream === 'function';
export async function packDemo(demo) {
  const json = JSON.stringify(demo);
  if (!canGzip()) return { blob: new Blob([json], { type: 'application/json' }), gz: false, ext: '.json' };
  const gz = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  return { blob: new Blob([gz], { type: 'application/gzip' }), gz: true, ext: '.json.gz' };
}
// ArrayBuffer / Blob / string -> demo object (gzip detected by its magic bytes)
export async function unpackDemo(src) {
  if (typeof src === 'string') return parseDemo(src);
  const ab = src instanceof Blob ? await src.arrayBuffer() : src;
  const u8 = new Uint8Array(ab);
  let text;
  if (u8[0] === 0x1f && u8[1] === 0x8b) {
    if (typeof DecompressionStream !== 'function') throw new Error('this browser cannot read .gz demos');
    text = await new Response(new Blob([ab]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  } else text = new TextDecoder().decode(u8);
  return parseDemo(text);
}
function parseDemo(text) {
  let d; try { d = JSON.parse(text); } catch { throw new Error('not a demo file (invalid JSON)'); }
  const err = validateDemo(d); if (err) throw new Error('not a demo file: ' + err);
  return d;
}
export function demoTitle(demo) {
  const s = demoSummary(demo), d = new Date(demo.date || Date.now()), pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${date} · ${mapTitle(demo.map)} · ${MODE_TITLE[demo.mode] || demo.mode} · ${s.players.map((p) => `${p.name} ${p.frags}`).join(' - ')}${s.aborted ? ' (partial)' : ''}`;
}
export function demoFileName(demo, ext = '.json.gz') {
  const s = demoSummary(demo), d = new Date(demo.date || Date.now()), pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const safe = (t) => String(t).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  return `${stamp}_${safe(demo.map)}_${safe(demo.mode)}_${s.players.map((p) => safe(p.name) + p.frags).join('-')}${ext}`;
}
// hands the browser a file: a packed record from the store (raw bytes) or a demo object
export async function downloadDemo(src) {
  let blob, name;
  if (src && src.data) { blob = new Blob([src.data], { type: src.gz ? 'application/gzip' : 'application/json' }); name = (src.file || 'demo') + (src.gz ? '.json.gz' : '.json'); }
  else { const p = await packDemo(src); blob = p.blob; name = demoFileName(src, p.ext); }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  return name;
}

// ---------------------------------------------------------------------------------------------------------------
// library: IndexedDB 'arena-demos', object store 'demos' (id = insertion time), the newest `keep` are retained
export class DemoStore {
  constructor(opts = {}) { this.name = opts.name || 'arena-demos'; this.keep = opts.keep || 10; this.db = null; }
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      if (typeof indexedDB === 'undefined') return rej(new Error('IndexedDB unavailable'));
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('demos')) db.createObjectStore('demos', { keyPath: 'id' }); };
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error || new Error('IndexedDB open failed'));
    });
  }
  tx(mode, fn) {
    return this.open().then((db) => new Promise((res, rej) => {
      const t = db.transaction('demos', mode), st = t.objectStore('demos'); let out;
      fn(st, (v) => { out = v; });
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted'));
    }));
  }
  // newest first, without the packed bytes
  async list() {
    const all = await this.tx('readonly', (st, set) => { const r = st.getAll(); r.onsuccess = () => set(r.result || []); });
    return all.map(({ data, ...meta }) => meta).sort((a, b) => b.id - a.id);
  }
  async add(demo) {
    const packed = await packDemo(demo), s = demoSummary(demo);
    const rec = { id: Date.now(), name: demoTitle(demo), file: demoFileName(demo, ''), date: demo.date, map: demo.map, mode: demo.mode, players: s.players, duration: demo.duration, snaps: s.snaps, bytes: packed.blob.size, gz: packed.gz, aborted: s.aborted, data: await packed.blob.arrayBuffer() };
    await this.tx('readwrite', (st) => st.put(rec));
    for (const old of (await this.list()).slice(this.keep)) await this.remove(old.id);
    return rec;
  }
  getRecord(id) { return this.tx('readonly', (st, set) => { const r = st.get(id); r.onsuccess = () => set(r.result || null); }); }
  async get(id) { const rec = await this.getRecord(id); if (!rec) throw new Error('demo not found'); return unpackDemo(rec.data); }
  remove(id) { return this.tx('readwrite', (st) => st.delete(id)); }
}

// ---------------------------------------------------------------------------------------------------------------
// player
export class DemoPlayer {
  // deps: { map (loaded map module), renderer, hud, audio, input (client/input.js, shared with the live game), canvas, settings, onExit }
  constructor(demo, deps) {
    this.demo = demo; this.deps = deps;
    const { map } = deps;
    this.cursor = new DemoCursor(demo, { onEvent: (e) => this.dispatch(e) });
    this.game = new Game(map, { mode: demo.mode || 'duel', isServer: false, lagComp: false });
    if (demo.rules) this.game.rules = { ...this.game.rules, ...demo.rules };
    this.localId = demo.localId;
    this.duration = this.cursor.duration; this.time = 0; this.speed = 1; this.playing = false; this.ended = false;
    this.camera = { mode: 'first', id: demo.localId }; // 'first' | 'chase' | 'free'
    this.free = { origin: [0, 0, 64], pitch: 0, yaw: 0 };
    this.frags = demoFrags(demo); this.summary = demoSummary(demo);
    this.players = demo.players.map((p) => ({ id: p.id, name: p.n, bot: !!p.bot }));
    const self = this, cg = {
      map, mapName: map.name, game: this.game, localId: demo.localId, remote: new Map(), remoteProjectiles: [], snapshots: [], latestSnap: null, predicted: null,
      rules: demo.rules || null, clock: { rtt: 0, jitter: 0, offset: 0 }, snapGaps: [], misprediction: 0, maps: null, votes: null, pendingLocalEvents: [], demo: true,
      serverTime() { return demo.t0 + self.time; }, renderTime() { return demo.t0 + self.time; }, interpDelayMs() { return self.cursor.interpDelay; },
      netStats() { return { snapHz: demo.snapRate, rtt: 0, jitter: 0 }; }, interpolate() {},
    };
    this.cg = cg;
    this.cgHud = Object.create(cg); this.cgHud.localId = demo.localId; // the HUD always shows the recorder
    this.applied = null; this.running = false; this.lastT = 0; this.lastUi = 0; this.fragsVisible = true; this.locked = false;
    this.frame = this.frame.bind(this); this.onKey = this.onKey.bind(this); this.onKeyUp = this.onKeyUp.bind(this);
  }

  // ---- lifecycle ----
  start() {
    const { renderer, hud, input } = this.deps;
    this.running = true;
    renderer.localId = this.localId; renderer.death = null; renderer.freeCamera = null;
    hud.el.classList.add('demo');
    this.mount();
    // the shared Input object: keys only for the free camera, pointer lock only there, Esc (lock lost) leaves nothing
    this.savedInput = { keysAllowed: input.keysAllowed, onEscape: input.onEscape, onLockChange: input.onLockChange, onScoreboard: input.onScoreboard, currentWeaponGetter: input.currentWeaponGetter, hasWeapon: input.hasWeapon };
    input.keysAllowed = () => this.running && this.camera.mode === 'free';
    input.onEscape = () => {};
    input.onLockChange = (locked) => { this.locked = locked; this.updateHint(); };
    input.onScoreboard = (s) => hud.scoreboard(s, this.cgHud);
    input.currentWeaponGetter = () => 0; input.hasWeapon = () => false;
    document.addEventListener('keydown', this.onKey, true); document.addEventListener('keyup', this.onKeyUp, true);
    this.seek(0); this.play();
    requestAnimationFrame(this.frame);
  }
  stop() {
    if (!this.running) return;
    const { renderer, hud, input } = this.deps;
    this.running = false; this.playing = false;
    document.removeEventListener('keydown', this.onKey, true); document.removeEventListener('keyup', this.onKeyUp, true);
    Object.assign(input, this.savedInput);
    if (this.locked) { try { input.unlock(); } catch {} }
    renderer.freeCamera = null; renderer.death = null; renderer.effects.purge();
    for (const m of renderer.projectiles.values()) m.dispose(); renderer.projectiles.clear();
    hud.el.classList.remove('demo', 'thirdperson'); hud.scoreboard(false, this.cgHud); hud.hideEnd();
    this.unmount();
  }
  exit() { const cb = this.deps.onExit; this.stop(); if (cb) cb(); }

  // ---- transport controls ----
  play() { if (this.time >= this.duration) this.seek(0); this.playing = true; this.updateBar(true); }
  pause() { this.playing = false; this.updateBar(true); }
  toggle() { if (this.playing) this.pause(); else this.play(); }
  setSpeed(s) { this.speed = SPEEDS.includes(s) ? s : 1; this.updateBar(true); }
  // rebuild at D: the cursor picks the snapshot pair, transient effects / camera state are dropped (both directions)
  seek(D) {
    const { renderer, hud } = this.deps;
    this.time = this.cursor.clamp(D);
    this.cursor.seek(this.time);
    renderer.effects.purge(); renderer.death = null; renderer.kick = [0, 0]; renderer.landBob = 0;
    for (const m of renderer.projectiles.values()) m.dispose(); renderer.projectiles.clear();
    hud.hideEnd();
    this.ended = false;
    this.syncGame();
    this.updateBar(true);
  }
  seekBy(ms) { this.seek(this.time + ms); }
  // mode: 'first' | 'chase' | 'free'; id: the chased player (chase)
  setCamera(mode, id = this.localId) {
    const { renderer, input, hud } = this.deps;
    if (mode === 'chase' && !this.players.some((p) => p.id === id)) id = this.localId;
    const eye = this.currentEye(); // where the camera is now: the free camera starts here
    this.camera = { mode, id: mode === 'chase' ? id : this.localId };
    if (mode === 'free') { this.free.origin = [...eye.origin]; this.free.pitch = eye.angles[0]; this.free.yaw = eye.angles[1]; input.setAngles(this.free.pitch, this.free.yaw); }
    else if (this.locked) { try { input.unlock(); } catch {} }
    renderer.localId = mode === 'first' ? this.localId : 0; renderer.death = null;
    hud.el.classList.toggle('thirdperson', mode !== 'first');
    this.syncGame(); this.updateBar(true); this.updateHint();
  }
  cycleCamera() {
    const order = [['first', this.localId], ...this.players.map((p) => ['chase', p.id]), ['free', this.localId]];
    const i = order.findIndex(([m, id]) => m === this.camera.mode && (m !== 'chase' || id === this.camera.id));
    const [m, id] = order[(i + 1) % order.length]; this.setCamera(m, id);
  }

  // ---- state ----
  // the recorded snapshots -> the client-side Game (items, players, match) and the cg facade the renderer / HUD / audio read
  syncGame() {
    const cur = this.cursor, cg = this.cg, first = this.camera.mode === 'first';
    if (cur.latest !== this.applied) { this.game.applySnapshot(cur.latest, this.localId); this.applied = cur.latest; }
    cg.latestSnap = cur.latest; cg.snapshots = cur.b ? [cur.a, cur.b] : [cur.a]; cg.remoteProjectiles = cur.projectiles;
    // everybody is a remote entity except the first-person subject; in the other modes nobody is "local" for the
    // renderer / audio: the recorder's model is drawn and every cue is spatial, like any other player
    cg.remote.clear();
    for (const [id, r] of cur.players) if (!(first && id === this.localId)) cg.remote.set(id, r);
    cg.localId = first ? this.localId : 0;
    const p = this.game.players.get(this.localId) || null;
    const v = cur.view;
    if (p && v) { // the recorder's view state stands in for the predicted player
      p.ps.origin = [...v.origin]; p.ps.viewangles = [...v.angles]; p.ps.viewHeight = v.viewHeight;
      p.ps.pmFlags = v.ducked ? (p.ps.pmFlags | PMF.DUCKED) : (p.ps.pmFlags & ~PMF.DUCKED); p.ps.groundEntity = v.ground; p.dead = v.dead;
    }
    cg.predicted = p;
  }
  // first-person view of the recorder (what the HUD shows, and the camera in 'first')
  localView() {
    const p = this.cg.predicted; if (!p) return null;
    const v = this.cursor.view, r = this.cursor.players.get(this.localId);
    if (v) return { origin: [...v.origin], viewHeight: v.viewHeight, angles: [...v.angles], velocity: p.ps.velocity, ducked: v.ducked, ground: v.ground, dead: v.dead, player: p };
    if (!r) return null; // a demo without view samples (e.g. a headless recording): the snapshot entry
    return { origin: [...r.origin], viewHeight: r.vh, angles: [r.angles[0], r.angles[1], 0], velocity: r.v, ducked: !!(r.pf & PMF.DUCKED), ground: !!r.g, dead: !!r.d, player: p };
  }
  chaseCamera(id) {
    const r = this.cursor.players.get(id); if (!r) return null;
    const useView = id === this.localId && this.cursor.view;
    const angles = useView ? this.cursor.view.angles : [r.angles[0], r.angles[1], 0];
    const eye = useView ? [this.cursor.view.origin[0], this.cursor.view.origin[1], this.cursor.view.origin[2] + this.cursor.view.viewHeight] : [r.origin[0], r.origin[1], r.origin[2] + (r.vh || 26)];
    const av = angleVectors([angles[0], angles[1], 0]);
    const want = [eye[0] - av.forward[0] * CHASE_BACK, eye[1] - av.forward[1] * CHASE_BACK, eye[2] - av.forward[2] * CHASE_BACK + CHASE_UP];
    const tr = traceBox(this.game.world, eye, want, [-6, -6, -6], [6, 6, 6], null, { skipFlags: 4 });
    return { origin: tr.endpos, angles: [angles[0], angles[1]] };
  }
  currentEye() {
    if (this.camera.mode === 'free') return { origin: [...this.free.origin], angles: [this.free.pitch, this.free.yaw] };
    if (this.camera.mode === 'chase') { const c = this.chaseCamera(this.camera.id); if (c) return c; }
    const v = this.localView(); if (v) return { origin: [v.origin[0], v.origin[1], v.origin[2] + v.viewHeight], angles: [v.angles[0], v.angles[1]] };
    const s = this.deps.map.spawns[0] || { origin: [0, 0, 64], yaw: 0 }; return { origin: [s.origin[0], s.origin[1], s.origin[2] + 26], angles: [0, s.yaw || 0] };
  }
  // events from the cursor, in recorded order: renderer + audio see the viewer identity, the HUD the recorder
  dispatch(e) {
    const { renderer, audio, hud } = this.deps;
    let ev = e;
    if (!ev.origin && ev.id === this.localId && this.cursor.view) ev = { ...e, origin: [...this.cursor.view.origin] };
    renderer.event(ev, this.cg);
    audio.event(ev, this.cg, false);
    if (ev.type === EV.MATCH_END) { this.ended = true; hud.center(ev.winner == null ? 'DRAW' : ev.winner === this.localId ? 'YOU WIN' : 'YOU LOSE', 1400); this.updateBar(true); }
    else hud.event(ev, this.cgHud);
  }

  // ---- per frame ----
  frame(now) {
    if (!this.running) return;
    requestAnimationFrame(this.frame);
    const { renderer, hud, audio, input } = this.deps;
    const dt = Math.min(0.1, this.lastT ? (now - this.lastT) / 1000 : 0.016); this.lastT = now;
    if (this.playing) {
      this.time = Math.min(this.duration, this.time + dt * 1000 * this.speed);
      if (this.time >= this.duration) { this.playing = false; this.updateBar(true); }
    }
    this.cursor.advance(this.time);
    this.syncGame();
    hud.frame(now);
    const view = this.localView();
    if (view) {
      let eye, angles;
      if (this.camera.mode === 'free') {
        const s = input.sample(); // WASD (+ shift / crouch key = fast) along the view, mouse look when locked (or no lock required)
        this.free.pitch = input.pitch; this.free.yaw = input.yaw;
        const av = angleVectors([this.free.pitch, this.free.yaw, 0]), k = FREE_SPEED * dt * (s.up < 0 ? 3 : 1) / 127;
        for (let i = 0; i < 3; i++) this.free.origin[i] += av.forward[i] * s.forward * k + av.right[i] * s.right * k;
        renderer.freeCamera = { origin: [...this.free.origin], angles: [this.free.pitch, this.free.yaw] };
        eye = this.free.origin; angles = [this.free.pitch, this.free.yaw, 0];
      } else if (this.camera.mode === 'chase') {
        const c = this.chaseCamera(this.camera.id);
        renderer.freeCamera = c ? { origin: c.origin, angles: c.angles } : null;
        eye = c ? c.origin : [view.origin[0], view.origin[1], view.origin[2] + view.viewHeight]; angles = c ? [c.angles[0], c.angles[1], 0] : view.angles;
      } else { renderer.freeCamera = null; eye = [view.origin[0], view.origin[1], view.origin[2] + view.viewHeight]; angles = view.angles; }
      renderer.update(this.cg, view, now, dt);
      audio.updateListener([eye[0], eye[1], eye[2]], angles);
      hud.update(this.cgHud, view, now);
    }
    audio.update(this.cg, now);
    if (now - this.lastUi > 100) { this.lastUi = now; this.updateBar(false); }
  }

  // ---- keys ----
  onKey(e) {
    if (!this.running) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') { if (e.code === 'Escape') e.target.blur(); return; }
    const free = this.camera.mode === 'free';
    switch (e.code) {
      case 'Escape': e.preventDefault(); this.exit(); return;
      case 'Space': e.preventDefault(); e.stopImmediatePropagation(); this.toggle(); return;
      case 'ArrowLeft': if (free) return; e.preventDefault(); this.seekBy(-SEEK_STEP); return;
      case 'ArrowRight': if (free) return; e.preventDefault(); this.seekBy(SEEK_STEP); return;
      case 'Comma': e.preventDefault(); this.seekBy(-SEEK_STEP); return;
      case 'Period': e.preventDefault(); this.seekBy(SEEK_STEP); return;
      case 'BracketLeft': e.preventDefault(); this.setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(this.speed) - 1)]); return;
      case 'BracketRight': e.preventDefault(); this.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(this.speed) + 1)]); return;
      case 'KeyC': if (free) return; e.preventDefault(); this.cycleCamera(); return;
      case 'KeyF': if (free) return; e.preventDefault(); this.toggleFrags(); return;
      case 'Tab': e.preventDefault(); if (!e.repeat) this.deps.hud.scoreboard(true, this.cgHud); return;
    }
  }
  onKeyUp(e) { if (this.running && e.code === 'Tab') this.deps.hud.scoreboard(false, this.cgHud); }

  // ---- DOM overlay ----
  mount() {
    const root = $('demo-ui'); this.ui = root; root.innerHTML = '';
    const camOpts = [`<option value="first">First person · ${esc(this.nameOf(this.localId))}</option>`, ...this.players.map((p) => `<option value="chase:${p.id}">Chase · ${esc(p.name)}</option>`), '<option value="free">Free camera</option>'].join('');
    root.innerHTML = `
      <div id="demo-frags"><div class="h">FRAGS <span class="n">${this.frags.length}</span></div><div class="list">${this.frags.map((f, i) => `<button class="frag" data-i="${i}"><span class="t">${fmt(f.t)}</span><span class="who">${f.attackerName ? `<b class="${f.attacker === this.localId ? 'me' : 'them'}">${esc(f.attackerName)}</b> <span class="mod">${esc(modShort(f.mod))}</span> <b class="${f.victim === this.localId ? 'me' : 'them'}">${esc(f.victimName)}</b>` : `<b class="${f.victim === this.localId ? 'me' : 'them'}">${esc(f.victimName)}</b> <span class="mod">${esc(modShort(f.mod))}</span>`}</span></button>`).join('') || '<div class="none">no frags</div>'}</div></div>
      <div id="demo-bar">
        <button id="demo-play" title="play / pause (Space)">&#9654;</button>
        <span id="demo-time">0:00 / ${fmt(this.duration)}</span>
        <div id="demo-track"><input id="demo-seek" type="range" min="0" max="${Math.round(this.duration)}" step="10" value="0"><div class="marks">${this.frags.map((f) => `<i style="left:${(100 * f.t / this.duration).toFixed(2)}%" class="${f.attacker === this.localId ? 'me' : f.victim === this.localId ? 'them' : ''}"></i>`).join('')}</div></div>
        <div id="demo-speeds">${SPEEDS.map((s) => `<button data-s="${s}">${s < 1 ? s.toString().replace('0.', '.') : s}×</button>`).join('')}</div>
        <select id="demo-cam" title="camera (C cycles)">${camOpts}</select>
        <button id="demo-menu" title="back to the menu (Esc)">MENU</button>
      </div>
      <div id="demo-hint"></div>`;
    root.classList.remove('hidden');
    root.querySelector('#demo-play').onclick = (e) => { this.toggle(); e.target.blur(); };
    root.querySelector('#demo-menu').onclick = () => this.exit();
    const seek = root.querySelector('#demo-seek');
    seek.oninput = () => this.seek(+seek.value); seek.onchange = () => seek.blur();
    for (const b of root.querySelectorAll('#demo-speeds button')) b.onclick = () => { this.setSpeed(+b.dataset.s); b.blur(); };
    const cam = root.querySelector('#demo-cam');
    cam.onchange = () => { const [m, id] = cam.value.split(':'); this.setCamera(m, id ? +id : this.localId); cam.blur(); };
    for (const b of root.querySelectorAll('.frag')) b.onclick = () => { const f = this.frags[+b.dataset.i]; this.seek(Math.max(0, f.t - 2500)); this.play(); b.blur(); };
    this.updateBar(true); this.updateHint();
  }
  unmount() { if (this.ui) { this.ui.classList.add('hidden'); this.ui.innerHTML = ''; } }
  toggleFrags(show = !this.fragsVisible) { this.fragsVisible = show; const el = this.ui && this.ui.querySelector('#demo-frags'); if (el) el.classList.toggle('hidden', !show); }
  updateBar(force) {
    const ui = this.ui; if (!ui) return;
    const play = ui.querySelector('#demo-play'); if (play) { const t = this.playing ? '&#10074;&#10074;' : '&#9654;'; if (force || play.dataset.t !== t) { play.innerHTML = t; play.dataset.t = t; } }
    const time = ui.querySelector('#demo-time'); if (time) { const t = `${fmt(this.time)} / ${fmt(this.duration)}`; if (time.textContent !== t) time.textContent = t; }
    const seek = ui.querySelector('#demo-seek'); if (seek && document.activeElement !== seek) seek.value = Math.round(this.time);
    if (force) {
      for (const b of ui.querySelectorAll('#demo-speeds button')) b.classList.toggle('on', +b.dataset.s === this.speed);
      const cam = ui.querySelector('#demo-cam'); if (cam) cam.value = this.camera.mode === 'chase' ? `chase:${this.camera.id}` : this.camera.mode;
      const cur = this.frags.filter((f) => f.t <= this.time).length;
      ui.querySelectorAll('.frag').forEach((b, i) => b.classList.toggle('past', i < cur));
    }
  }
  updateHint() {
    const el = this.ui && this.ui.querySelector('#demo-hint'); if (!el) return;
    const free = this.camera.mode === 'free';
    el.textContent = free ? (this.locked || !this.deps.input.requireLock ? 'FREE CAMERA · WASD fly · shift fast · Esc releases the mouse' : 'FREE CAMERA · click the arena to look around · WASD fly') : 'SPACE play / pause · ← → ±5 s · [ ] speed · C camera · F frag list · TAB scores · ESC menu';
  }
  nameOf(id) { const p = this.players.find((x) => x.id === id); return p ? p.name : 'player ' + id; }
}

function fmt(ms) { const s = Math.floor(Math.max(0, ms) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
const MOD_SHORT = { 1: 'GA', 2: 'MG', 3: 'SG', 5: 'RL', 6: 'LG', 7: 'RG', 8: 'PG', fall: 'fell', lava: 'lava', telefrag: 'telefrag' };
function modShort(mod) { return MOD_SHORT[mod] || (typeof mod === 'string' ? mod : 'killed'); }
