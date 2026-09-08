// DOM HUD for the survival slice (dark olive "field notebook" theme, see style.css). Builds every element inside #hud,
// touches the DOM only when a value changes (cache-compare per key), and reacts to sim events with toasts, banners,
// flashes, floating damage numbers and slot shakes. Everything time-based uses the wall clock passed to frame(now).
//
// Contract (survival/main.js): new Hud(); show(); hide(); frame(now); update(sim, dt, ctx {input, renderer, audio, paused});
// event(e, sim); toggleInventory(); setPaused(bool); frameTimes (last 120 frame ms).
import { ITEMS, WEAPON_SLOTS, WEAPONS, PLAYER, DAY, BARRICADE_COST, ZSTATE, EV } from '../shared/survival/constants.js';

const HINTS = {
  supplies: 'fridge in the start house · F eat, G drink',
  arm: 'closet in the start house: bat',
  planks: 'chop trees (E or swing) or loot shelves',
  fortify: 'stand next to a door/window, press B',
  survive: 'stay inside, fight at the barricades',
};
const PHASE_WORD = { day: 'DAY', dusk: 'DUSK', night: 'NIGHT', dawn: 'DAWN' };
const PHASE_BANNER = { dusk: ['DUSK', `fortify before ${String(DAY.nightHour).padStart(2, '0')}:00`], night: ['NIGHT', 'they run faster in the dark'], dawn: ['DAWN', 'hold on until 06:00'], day: ['DAY 2', 'you made it'] };
const CAUSE = { zombie: 'Killed by a zombie', starvation: 'Starved to death', bleeding: 'Bled out' };
const DENIED = { no_planks: (e) => `Not enough planks (need ${e.need ?? BARRICADE_COST})`, no_target: () => 'No door or window nearby', nothing_here: () => 'Nothing to interact with', tired: () => 'Too tired', no_item: (e) => `No ${e.item && ITEMS[e.item] ? ITEMS[e.item].label.toLowerCase() : 'item'}`, not_needed: () => 'Not needed right now', no_ammo: () => 'Out of ammo', busy: () => 'Busy', barricaded: () => 'Door is barricaded', broken: () => 'Door is broken', blocked: () => 'Something is in the way', already_barricaded: () => 'Already barricaded' };
// 24x24 SVG icons (currentColor); a real shape per vital so meaning is not colour-only
const ICON = {
  health: '<path d="M12 21s-7-4.6-9.3-9A5.2 5.2 0 0 1 12 6.4 5.2 5.2 0 0 1 21.3 12C19 16.4 12 21 12 21z"/>',
  stamina: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
  hunger: '<path d="M5 3h14v3H5zM6 7h12l-1 14H7zM9 10v8M12 10v8M15 10v8" fill="none" stroke="currentColor" stroke-width="2"/>',
  thirst: '<path d="M12 2s-7 8-7 13a7 7 0 0 0 14 0c0-5-7-13-7-13z"/>',
  drop: '<path d="M12 2s-7 8-7 13a7 7 0 0 0 14 0c0-5-7-13-7-13z"/>',
  skull: '<path d="M12 2a8 8 0 0 0-8 8c0 3 1.5 5 3 6v4h10v-4c1.5-1 3-3 3-6a8 8 0 0 0-8-8zm-3 8a2 2 0 1 1 0 .1zm6 0a2 2 0 1 1 0 .1zM10 16h4v3h-4z"/>',
};
const svg = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICON[name]}</svg>`;
const fmtHm = (h) => { const hh = Math.floor(h), mm = Math.floor((h - hh) * 60); return hh > 0 ? `${hh}h${String(mm).padStart(2, '0')}` : `${mm}m`; };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export class Hud {
  constructor() {
    this.el = document.getElementById('hud'); this.frameTimes = []; this.lastFrame = 0; this.inventoryOpen = false; this.paused = false;
    this.now = 0; this.sim = null; this.renderer = null; this.cache = {}; this.perfOn = true; this.perfT = 0;
    this.toasts = []; this.floaters = []; this.bannerT = 0; this.arcs = []; this.arcIdx = 0; this.ended = false; this.hitT = 0;
    this.build();
    window.addEventListener('keydown', (e) => { if (e.code === 'F3') { e.preventDefault(); this.perfOn = !this.perfOn; this.perfEl.classList.toggle('hidden', !this.perfOn); } });
  }
  // ---------------- DOM ----------------
  build() {
    const h = this.el; h.innerHTML = '';
    h.insertAdjacentHTML('beforeend', `
      <div id="vignette"></div><div id="dmg-dirs"></div>
      <div id="objective" class="panel"><div class="ptitle">OBJECTIVE</div><ol id="obj-list"></ol></div>
      <div id="topbar"><div class="panel" id="clockbox"><div id="clock">08:00</div><div id="dayphase"><span id="dayn">DAY 1</span><span id="phase" class="day">DAY</span></div></div><div id="horde" class="panel"></div><div id="threat" class="panel"><span id="threat-n">0</span><span id="threat-l">no threat</span></div></div>
      <div id="toasts"></div>
      <div id="banner"><div id="banner-main"></div><div id="banner-sub"></div></div>
      <div id="floaters"></div><div id="hitmarker"></div><div id="edge-arrows"></div>
      <div id="prompt" class="panel"><div id="prompt-e" class="prow"><kbd>E</kbd><span></span></div><div id="prompt-b" class="prow"><kbd>B</kbd><span></span></div></div>
      <div id="vitals" class="panel"><div id="threat-ring"><span id="ring-n">0</span></div>
        ${['health', 'stamina', 'hunger', 'thirst'].map((k) => `<div class="vital ${k}" id="v-${k}">${svg(k)}<div class="vcol"><div class="vhead"><span class="vlabel">${k.toUpperCase()}</span><span class="vnum" id="vn-${k}">100</span></div><div class="vbar"><div class="vfill" id="vf-${k}"></div></div></div></div>`).join('')}
        <div id="status"><span id="st-bleed" class="hidden">${svg('drop', 'blink')}BLEEDING <kbd>H</kbd> bandage</span><span id="st-tired" class="hidden">EXHAUSTED</span><span id="st-low" class="hidden">LOW HEALTH</span></div>
      </div>
      <div id="hotbar"><div id="weapons">${WEAPON_SLOTS.map((w, i) => `<div class="slot" id="slot-${w}"><kbd>${i + 1}</kbd><span class="sname">${ITEMS[w].label}</span><span class="sammo" id="ammo-${w}"></span><span class="shint" id="hint-${w}"></span></div>`).join('')}</div>
        <div id="consumables">${[['food', 'F'], ['water', 'G'], ['bandage', 'H'], ['plank', 'B']].map(([it, k]) => `<div class="chip" id="chip-${it}"><kbd>${k}</kbd><span class="cname">${ITEMS[it].label}</span><span class="ccount" id="cnt-${it}">0</span></div>`).join('')}</div></div>
      <div id="perf" class="panel"><span id="perf-fps">-- fps</span><span id="perf-p99">p99 --</span><span id="perf-draws">draws --</span><span id="perf-z">zombies --</span><span class="dim">F3</span></div>
      <div id="inventory" class="overlay hidden"><div class="panel big"><div class="ptitle">INVENTORY <span class="dim">Tab to close · click to use</span></div><div id="inv-grid"></div>
        <div class="ptitle">CONTROLS</div><div id="legend"><span><kbd>WASD</kbd> move</span><span><kbd>Shift</kbd> sprint</span><span><kbd>Ctrl</kbd> sneak</span><span><kbd>LMB</kbd> attack</span><span><kbd>E</kbd> interact</span><span><kbd>B</kbd> barricade (${BARRICADE_COST} planks)</span><span><kbd>1 2 3</kbd> weapons</span><span><kbd>R</kbd> reload</span><span><kbd>F</kbd> eat</span><span><kbd>G</kbd> drink</span><span><kbd>H</kbd> bandage</span><span><kbd>Tab</kbd> inventory</span><span><kbd>Esc</kbd> pause</span><span><kbd>F3</kbd> perf</span></div></div></div>
      <div id="pause" class="overlay hidden"><div class="panel big centre"><div class="huge">PAUSED</div><div class="dim">Esc to resume</div></div></div>
      <div id="end" class="overlay hidden"><div class="panel big centre"><div id="end-title" class="huge">YOU SURVIVED THE NIGHT</div><div id="end-cause" class="sub"></div><div id="end-metrics"></div><div class="row"><button id="btn-again" class="primary">PLAY AGAIN (same seed)</button></div></div></div>`);
    const $ = (id) => document.getElementById(id);
    this.perfEl = $('perf'); this.promptEl = $('prompt'); this.bannerEl = $('banner'); this.toastsEl = $('toasts'); this.floatEl = $('floaters'); this.vignette = $('vignette');
    this.hitEl = $('hitmarker'); this.arrowsEl = $('edge-arrows'); this.arrows = [];
    this.invGrid = $('inv-grid'); this.endEl = $('end'); this.pauseEl = $('pause'); this.invEl = $('inventory');
    $('btn-again').onclick = () => { const u = new URL(location.href); if (this.sim) u.searchParams.set('seed', this.sim.opts.seed); u.searchParams.set('auto', '1'); location.href = u.toString(); };
    // inventory click: prefer the Input latch (the use then happens inside sim.step, so renderer/audio/eventLog see the
    // event too); fall back to sim.useItem and forward the events it emitted, which the next step would otherwise clear
    this.invGrid.addEventListener('click', (ev) => {
      const cell = ev.target.closest('.inv-cell'); const item = cell && cell.dataset.item; if (!item || !this.sim) return;
      const def = ITEMS[item]; const inp = this.input;
      if (inp && def.kind === 'weapon') { inp.slot = WEAPON_SLOTS.indexOf(item) + 1; return; }
      if (inp && ['food', 'drink', 'medical'].includes(def.kind)) { inp.pendingUse = item; return; }
      const n0 = this.sim.events.length; this.sim.useItem(item); for (const e of this.sim.events.slice(n0)) this.event(e, this.sim);
    });
    this.objList = $('obj-list'); this.objRows = [];
    for (let i = 0; i < 8; i++) { const d = document.createElement('div'); d.className = 'dmg-dir'; $('dmg-dirs').appendChild(d); this.arcs.push(d); }
    for (let i = 0; i < 16; i++) { const d = document.createElement('div'); d.className = 'edge-arrow hidden'; d.innerHTML = svg('skull'); this.arrowsEl.appendChild(d); this.arrows.push({ el: d, shown: false, key: '' }); }
  }
  show() { this.el.classList.remove('hidden'); } hide() { this.el.classList.add('hidden'); }
  frame(now) { if (this.lastFrame) { this.frameTimes.push(now - this.lastFrame); if (this.frameTimes.length > 120) this.frameTimes.shift(); } this.lastFrame = now; this.now = now; }
  // set a cached value; apply(v) only runs when it changed
  set(key, v, apply) { if (this.cache[key] === v) return false; this.cache[key] = v; apply(v); return true; }
  text(id, v) { this.set('t:' + id, v, (x) => { document.getElementById(id).textContent = x; }); }
  cls(el, name, on) { const k = 'c:' + (el.id || el.className) + ':' + name; this.set(k, !!on, (x) => el.classList.toggle(name, x)); }
  toggleInventory() { this.inventoryOpen = !this.inventoryOpen; this.invEl.classList.toggle('hidden', !this.inventoryOpen); if (this.inventoryOpen && this.sim) this.renderInventory(this.sim); this.modal(); }
  setPaused(v) { this.paused = v; this.pauseEl.classList.toggle('hidden', !v); this.modal(); }
  modal() { this.el.classList.toggle('modal', this.inventoryOpen || this.paused || this.ended); }   // world-anchored bits hide under overlays
  // ---------------- per-frame ----------------
  update(sim, dt, ctx = {}) {
    if (!sim) return; this.sim = sim; this.renderer = ctx.renderer || this.renderer; this.input = ctx.input || this.input;
    const p = sim.player, now = this.now;
    // vitals: bar width in whole percent, number rounded; pulse under 25 %
    for (const [k, max] of [['health', PLAYER.maxHealth], ['stamina', PLAYER.maxStamina], ['hunger', 100], ['thirst', 100]]) {
      const v = Math.max(0, Math.min(max, p[k])); const pct = Math.round(v / max * 100);
      this.set('vf:' + k, pct, (x) => { document.getElementById('vf-' + k).style.width = x + '%'; });
      this.text('vn-' + k, String(Math.round(v)));
      this.cls(document.getElementById('v-' + k), 'low', pct < 25);
    }
    this.cls(document.getElementById('st-bleed'), 'hidden', !p.bleeding); this.cls(document.getElementById('st-tired'), 'hidden', !p.tired); this.cls(document.getElementById('st-low'), 'hidden', !p.lowHealth || !p.alive);
    // clock / day / phase / horde countdown
    this.text('clock', sim.clock()); this.text('dayn', 'DAY ' + sim.day);
    this.set('phase', sim.phase, (ph) => { const e = document.getElementById('phase'); e.textContent = PHASE_WORD[ph] || ph.toUpperCase(); e.className = ph; });
    let horde = '', hcls = '';
    if (sim.opts.noHorde) horde = '';
    else if (sim.day === 1 && sim.phase !== 'night') { horde = `HORDE ${String(DAY.hordeHour).padStart(2, '0')}:00 in ${fmtHm(DAY.hordeHour - sim.hour)}`; hcls = sim.phase === 'dusk' ? 'soon' : ''; }
    else if (sim.phase === 'night') { horde = 'HORDE NIGHT'; hcls = 'active'; }
    else if (sim.day === 2 && sim.result !== 'won') { horde = 'HORDE OVER · reach 06:00'; }
    this.text('horde', horde); this.set('hcls', hcls, (c) => { document.getElementById('horde').className = 'panel ' + c; });
    this.cls(document.getElementById('horde'), 'hidden', !horde);
    // objective tracker
    const steps = sim.objective.steps;
    if (this.objRows.length !== steps.length) { this.objList.innerHTML = ''; this.objRows = steps.map((s) => { const li = document.createElement('li'); li.id = 'obj-' + s.id; li.innerHTML = `<span class="box"></span><div><div class="olabel">${s.label}</div><div class="ohint">${HINTS[s.id] || ''}</div></div>`; this.objList.appendChild(li); return li; }); }
    steps.forEach((s, i) => { const li = this.objRows[i]; this.cls(li, 'done', s.done); this.cls(li, 'current', i === sim.objective.index && !s.done); });
    // hotbar
    const inv = p.inventory;
    for (const w of WEAPON_SLOTS) {
      const el = document.getElementById('slot-' + w); this.cls(el, 'none', !inv[w]); this.cls(el, 'active', p.weapon === w);
      if (w === 'pistol') { const res = inv.ammo || 0; this.text('ammo-pistol', inv.pistol ? `${p.mag}/${res}` : ''); this.cls(el, 'empty', !!inv.pistol && p.mag === 0);
        this.text('hint-pistol', !inv.pistol ? '' : p.reloadT > 0 ? 'RELOADING' : p.mag === 0 ? (res > 0 ? 'R  RELOAD' : 'NO AMMO') : ''); }
    }
    for (const it of ['food', 'water', 'bandage', 'plank']) { const n = inv[it] || 0; this.text('cnt-' + it, String(n)); this.cls(document.getElementById('chip-' + it), 'none', n === 0); }
    this.cls(document.getElementById('chip-plank'), 'ok', (inv.plank || 0) >= BARRICADE_COST);
    // context prompt
    this.updatePrompt(sim);
    // threat: chasing/attacking zombies
    const chasers = sim.zombies.filter((z) => z.state === ZSTATE.CHASE || z.state === ZSTATE.ATTACK);
    this.text('threat-n', String(chasers.length)); this.text('ring-n', String(chasers.length));
    this.text('threat-l', chasers.length === 0 ? 'no threat' : chasers.length === 1 ? 'zombie chasing you' : 'zombies chasing you');
    this.cls(document.getElementById('threat'), 'hot', chasers.length > 0); this.cls(document.getElementById('threat-ring'), 'hot', chasers.length > 0);
    this.cls(document.getElementById('threat-ring'), 'hidden', chasers.length === 0);   // the top-bar "0 · no threat" already says it; no lone "0"
    this.updateArrows(chasers, p);
    this.wasBleeding = p.bleeding;   // events arrive before update(), so this is the pre-event state for the bandage toast
    // timed things
    this.updateToasts(now); this.updateFloaters(); if (this.bannerT && now > this.bannerT) { this.bannerT = 0; this.bannerEl.classList.remove('show', 'horde'); }
    if (this.hitT && now > this.hitT) { this.hitT = 0; this.hitEl.classList.remove('show'); }
    if (this.inventoryOpen) this.renderInventory(sim);
    // perf 5 Hz
    if (this.perfOn && now - this.perfT > 200) {
      this.perfT = now; const ft = this.frameTimes; const avg = ft.length ? ft.reduce((a, b) => a + b, 0) / ft.length : 0;
      const p99 = ft.length ? [...ft].sort((a, b) => a - b)[Math.min(ft.length - 1, Math.floor(ft.length * 0.99))] : 0;
      this.text('perf-fps', (avg ? Math.round(1000 / avg) : 0) + ' fps'); this.text('perf-p99', 'p99 ' + p99.toFixed(1) + ' ms');
      const fs = this.renderer && this.renderer.frameStats; this.text('perf-draws', 'draws ' + (fs ? fs.draws : '--'));
      this.text('perf-z', 'zombies ' + sim.zombies.filter((z) => z.state !== ZSTATE.DEAD).length);
    }
  }
  // screen position of a world point via the renderer, with a safe fallback (viewport centre) if it returns garbage
  toScreen(x, y, z = 0) {
    try { const r = this.renderer && this.renderer.worldToScreen && this.renderer.worldToScreen(x, y, z); if (r && isFinite(r[0]) && isFinite(r[1])) return r; } catch (_) { /* fall through */ }
    return [innerWidth / 2, innerHeight / 2];
  }
  updatePrompt(sim) {
    const p = sim.player; let e = null, b = null, eOk = true, bOk = true;
    const it = p.alive && sim.findInteractable();
    if (it) {
      if (it.kind === 'container') { e = (it.c.opened ? 'Search ' : 'Open ') + it.c.kind.replace(/_/g, ' ') + (it.c.opened ? ' (empty)' : ''); eOk = !it.c.opened; }
      else if (it.kind === 'door') { const o = it.o; e = o.barricade > 0 ? 'Door barricaded' : o.hp <= 0 ? 'Door broken' : o.open ? 'Close door' : 'Open door'; eOk = o.barricade <= 0 && o.hp > 0; }
      else if (it.kind === 'tree') { const n = sim.world.trees.get(sim.world.key(it.x, it.y)) || 0; e = `Chop tree (${n} hit${n === 1 ? '' : 's'} left)`; }
    }
    let best = null, bd = 1e9; if (p.alive) for (const o of sim.world.openings.values()) { const d = Math.hypot(o.x + 0.5 - p.x, o.y + 0.5 - p.y); if (d < PLAYER.interactRange + 0.4 && d < bd) { bd = d; best = o; } }
    if (best) { const planks = p.inventory.plank || 0; b = best.barricade > 0 ? `${cap(best.kind)} barricaded (${Math.round(best.barricade)} hp)` : `Barricade ${best.kind} (${BARRICADE_COST} planks, have ${planks})`; bOk = best.barricade <= 0 && planks >= BARRICADE_COST; }
    const pe = document.getElementById('prompt-e'), pb = document.getElementById('prompt-b');
    // .no dims the row and appends "(unavailable)" unless the text already carries its own reason (.self)
    const selfExplains = (t) => /\(|barricaded|broken/.test(t || '');
    this.set('pe', e || '', (t) => { pe.lastElementChild.textContent = t; pe.classList.toggle('hidden', !t); }); this.cls(pe, 'no', !eOk); this.cls(pe, 'self', selfExplains(e));
    this.set('pb', b || '', (t) => { pb.lastElementChild.textContent = t; pb.classList.toggle('hidden', !t); }); this.cls(pb, 'no', !bOk); this.cls(pb, 'self', selfExplains(b));
    const on = !!(e || b); this.cls(this.promptEl, 'hidden', !on);
    if (on) { const [sx, sy] = this.toScreen(p.x, p.y, 0); const x = Math.round(Math.max(160, Math.min(innerWidth - 160, sx))), y = Math.round(Math.min(innerHeight - 190, sy + 64)); this.set('ppos', x + ',' + y, () => { this.promptEl.style.transform = `translate(${x}px, ${y}px) translateX(-50%)`; }); }
  }
  // off-screen chasers: skull arrows on a compass ellipse (semi-axes 0.40 W x 0.34 H) around the player's screen position
  // (7DTD-style ring), kept inside the viewport and walked inward off the HUD panels (hotbar, vitals, toasts, objective,
  // top bar, perf); arrows whose centres would sit within 40 px of each other fan out along the ring; each rotates toward
  // its zombie. Panel rects are re-measured every 300 ms (they only move on resize / show-hide).
  updateArrows(chasers, p) {
    let n = 0; const [px, py] = this.toScreen(p.x, p.y, 0); const M = 28, W = innerWidth, H = innerHeight, R = 44;   // R: rotated 60 px box + pointer tip
    if (!this.rects || this.now - (this.rectT || 0) > 300) { this.rectT = this.now; this.rects = ['hotbar', 'vitals', 'toasts', 'objective', 'topbar', 'perf'].map((id) => document.getElementById(id)).filter((el) => el && !el.classList.contains('hidden')).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0); }
    const rx = 0.40 * W, ry = 0.34 * H;
    const hits = (x, y) => this.rects.some((r) => x + R > r.left && x - R < r.right && y + R > r.top && y - R < r.bottom);
    const place = (ang) => {
      const c = Math.cos(ang), s = Math.sin(ang);
      let t = 1 / Math.sqrt((c / rx) ** 2 + (s / ry) ** 2);   // ray from the player's screen position to the ellipse
      if (c > 0) t = Math.min(t, (W - M - px) / c); if (c < 0) t = Math.min(t, (M - px) / c); if (s > 0) t = Math.min(t, (H - M - py) / s); if (s < 0) t = Math.min(t, (M - py) / s);
      for (let i = 0; i < 14 && t > 48 && hits(px + c * t, py + s * t); i++) t -= 24;   // walk inward until clear of every panel
      return [px + c * t, py + s * t];
    };
    const placed = [];
    for (const z of chasers) {
      if (n >= this.arrows.length) break; const [sx, sy] = this.toScreen(z.x, z.y, 0);
      if (sx > M && sx < W - M && sy > M && sy < H - M) continue;   // on screen: the renderer's "!" marker covers it
      const ang = Math.atan2(sy - py, sx - px); let pos = place(ang);
      for (let k = 1; k <= 10; k++) {   // fan out: alternate +/- steps of ~44 px of arc around the original bearing
        if (!placed.some((q) => Math.hypot(q[0] - pos[0], q[1] - pos[1]) < 40)) break;
        const da = 44 / Math.max(60, Math.hypot(pos[0] - px, pos[1] - py)); pos = place(ang + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * da);
      }
      placed.push(pos);
      const ax = Math.round(pos[0]), ay = Math.round(pos[1]); const a = this.arrows[n++];
      const key = ax + ',' + ay + ',' + Math.round(ang * 20); if (a.key !== key) { a.key = key; a.el.style.transform = `translate(${ax}px, ${ay}px) translate(-50%,-50%) rotate(${(ang * 180 / Math.PI).toFixed(0)}deg)`; }
      if (!a.shown) { a.shown = true; a.el.classList.remove('hidden'); }
    }
    for (let i = n; i < this.arrows.length; i++) if (this.arrows[i].shown) { this.arrows[i].shown = false; this.arrows[i].el.classList.add('hidden'); this.arrows[i].key = ''; }
  }
  // ---------------- toasts / banners / floaters ----------------
  toast(text, cls = '', item = null) {
    const last = this.toasts[this.toasts.length - 1];
    if (item && last && last.item === item && this.now < last.until) { last.count += item.count; last.el.textContent = `+${last.count} ${item.label}`; last.until = this.now + 2500; return; }
    const el = document.createElement('div'); el.className = 'toast ' + cls; el.textContent = text; this.toastsEl.appendChild(el);
    this.toasts.push({ el, until: this.now + (cls === 'dim' ? 1200 : 2500), item: item ? item.label : null, count: item ? item.count : 0, label: item ? item.label : '' });   // dim (door, equip) toasts are short-lived
    if (this.toasts.length > 7) { const t = this.toasts.shift(); t.el.remove(); }
  }
  updateToasts(now) { if (this.toasts.some((t) => now > t.until)) this.toasts = this.toasts.filter((t) => now <= t.until || (t.el.remove(), false)); }   // per-toast lifetimes, not FIFO
  banner(main, sub = '', cls = '', ms = 2400) {
    document.getElementById('banner-main').textContent = main; document.getElementById('banner-sub').textContent = sub;
    this.bannerEl.className = 'show ' + cls; void this.bannerEl.offsetWidth; this.bannerT = this.now + ms;
  }
  floater(x, y, text, cls = '') { const el = document.createElement('div'); el.className = 'floater ' + cls; el.textContent = text; this.floatEl.appendChild(el); this.floaters.push({ el, x, y, t0: this.now, dur: 900 }); }
  updateFloaters() {
    const now = this.now;
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i]; const a = (now - f.t0) / f.dur; if (a >= 1) { f.el.remove(); this.floaters.splice(i, 1); continue; }
      const [sx, sy] = this.toScreen(f.x, f.y, 1.2); f.el.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy - a * 48)}px) translate(-50%,-50%)`; f.el.style.opacity = a < 0.6 ? 1 : (1 - (a - 0.6) / 0.4).toFixed(2);
    }
  }
  shake(id) { const el = document.getElementById(id); if (!el) return; el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }
  // ---------------- events ----------------
  event(e, sim) {
    this.sim = sim; const p = sim.player;
    switch (e.type) {
      case EV.PLAYER_HURT: {
        this.vignette.classList.remove('flash'); void this.vignette.offsetWidth; this.vignette.classList.add('flash');
        if (e.from) { const [px, py] = this.toScreen(p.x, p.y, 0), [fx, fy] = this.toScreen(e.from.x, e.from.y, 0); const ang = Math.atan2(fy - py, fx - px) * 180 / Math.PI + 90; const d = this.arcs[this.arcIdx++ % this.arcs.length]; d.classList.remove('show'); void d.offsetWidth; d.style.transform = `rotate(${ang.toFixed(0)}deg)`; d.classList.add('show'); }
        if (e.cause !== 'zombie') this.floater(p.x, p.y, `-${e.damage}`, 'self'); break;
      }
      case EV.MELEE_HIT: case EV.BULLET_HIT: {
        if (e.target == null) break; this.floater(e.x, e.y, String(e.damage), e.killed ? 'kill' : '');
        const [sx, sy] = this.toScreen(e.x, e.y, 0.9); this.hitEl.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy)}px) translate(-50%,-50%) rotate(45deg)`; this.hitEl.classList.remove('show'); void this.hitEl.offsetWidth; this.hitEl.classList.add('show'); this.hitT = this.now + 220; break;
      }
      case EV.ZOMBIE_DEATH: this.floater(e.x, e.y, '+1', 'kill'); this.toast(`+1 kill (${p.kills})`, 'kill'); break;
      case EV.PICKUP: { const def = ITEMS[e.item]; this.toast(`+${e.count} ${def ? def.label : e.item}`, 'pickup', { label: def ? def.label : e.item, count: e.count }); break; }
      case EV.CONTAINER_OPEN: if (e.empty) this.toast(`${cap(e.kind)} is empty`, 'dim'); break;
      case EV.ACTION_DENIED: {
        const r = DENIED[e.reason]; this.toast(r ? r(e) : 'Cannot do that', 'deny');
        const slot = e.reason === 'no_planks' || e.reason === 'no_target' || e.reason === 'already_barricaded' ? 'chip-plank' : e.reason === 'no_ammo' ? 'slot-pistol' : e.reason === 'tired' ? 'slot-' + p.weapon
          : e.item && WEAPON_SLOTS.includes(e.item) ? 'slot-' + e.item : e.item === 'ammo' ? 'slot-pistol' : e.item ? 'chip-' + e.item : null;
        if (slot) this.shake(slot); break;
      }
      case EV.NO_AMMO: if (p.weapon === 'pistol' && !(p.inventory.ammo > 0)) this.shake('slot-pistol'); break;
      case EV.STAMINA_OUT: this.banner('EXHAUSTED', 'stop sprinting to recover', 'warn', 1500); break;
      case EV.LOW_HEALTH: if (e.on) this.banner('LOW HEALTH', 'eat, drink and bandage to recover', 'warn', 1800); break;
      case EV.EAT: this.toast(`Ate ${ITEMS[e.item].label.toLowerCase()} · hunger ${Math.round(e.hunger)}`, 'ok'); break;
      case EV.DRINK: this.toast(`Drank ${ITEMS[e.item].label.toLowerCase()} · thirst ${Math.round(e.thirst)}`, 'ok'); break;
      case EV.BANDAGE: this.toast(`Bandaged · ${this.wasBleeding ? 'bleeding stopped · ' : ''}+${ITEMS.bandage.heal} hp over ${PLAYER.bandageHealTime} s`, 'ok'); break;
      case EV.RELOAD: this.toast('Reloading...', 'dim'); break;
      case EV.RELOAD_DONE: this.toast(`Reloaded (${e.mag} rounds)`, 'ok'); break;
      case EV.WEAPON_SWITCH: this.toast(`Equipped ${ITEMS[e.weapon].label.toLowerCase()}`, 'dim'); break;
      case EV.DOOR_OPEN: this.toast('Door opened', 'dim'); break;
      case EV.DOOR_CLOSE: this.toast('Door closed', 'dim'); break;
      case EV.DOOR_BREAK: this.toast('A door was broken down!', 'deny'); break;
      case EV.WINDOW_BREAK: this.toast('A window was smashed!', 'deny'); break;
      case EV.BARRICADE_BUILT: this.toast(`${cap(e.kind)} barricaded (${sim.metrics.barricadesBuilt})`, 'ok'); break;
      case EV.BARRICADE_HIT: if (e.hp % 42 < 14 || e.hp <= 28) this.toast(`Barricade under attack (${e.hp} hp)`, 'warn'); break;
      case EV.BARRICADE_BROKEN: this.toast('Barricade destroyed!', 'deny'); break;
      case EV.HARVEST_HIT: this.floater(e.x, e.y, `${e.hitsLeft} left`, 'dim'); break;
      case EV.HARVEST_DONE: this.floater(e.x, e.y, `+${e.planks} planks`, 'pick'); break;
      case EV.PHASE: { const b = PHASE_BANNER[e.phase]; if (b && !(e.phase === 'day' && sim.day === 1)) this.banner(e.phase === 'day' ? `DAY ${sim.day}` : b[0], b[1], e.phase); break; }
      case EV.HORDE: this.banner('THEY ARE COMING', `wave ${e.wave + 1} · ${e.count} zombies`, 'horde', 3200); break;
      case EV.OBJECTIVE_STEP: { this.banner('OBJECTIVE COMPLETE', e.label, 'obj', 2200); const li = this.objRows[e.index]; if (li) { li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash'); } break; }
      case EV.WIN: this.endScreen(sim, true, null); break;
      case EV.LOSE: this.endScreen(sim, false, e.cause); break;
    }
  }
  endScreen(sim, won, cause) {
    if (this.ended) return; this.ended = true; const m = sim.metrics;
    document.getElementById('end-title').textContent = won ? 'YOU SURVIVED THE NIGHT' : 'YOU DIED';
    document.getElementById('end-cause').textContent = won ? `Dawn of day ${sim.day}, ${sim.clock()}` : `${CAUSE[cause] || cap(String(cause))} · day ${sim.day}, ${sim.clock()}`;
    // game hours come from the in-game clock (sim.t is real seconds at timeScale 1, so it is not game time); wall time from sim.t
    const startH = sim.opts.startHour ?? DAY.startHour, gameH = Math.max(0, (sim.day - 1) * 24 + sim.hour - startH), secs = Math.round(m.survivedSeconds || sim.t);
    const rows = [['Kills', m.kills], ['Damage taken', Math.round(m.damageTaken)], ['Barricades built', m.barricadesBuilt], ['Items looted', m.itemsLooted], ['Time survived', `${fmtHm(gameH)} game time (${String(startH).padStart(2, '0')}:00 day 1 to ${sim.clock()} day ${sim.day}) · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} real`]];
    document.getElementById('end-metrics').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    this.endEl.className = 'overlay ' + (won ? 'won' : 'lost'); this.modal();
  }
  renderInventory(sim) {
    const inv = sim.player.inventory; const key = Object.entries(inv).map(([k, v]) => k + v).join('|') + sim.player.weapon;
    this.set('inv', key, () => {
      const cells = Object.keys(ITEMS).filter((k) => inv[k]).map((k) => { const def = ITEMS[k]; const use = def.kind === 'weapon' ? (sim.player.weapon === k ? 'equipped' : 'click to equip') : ['food', 'drink', 'medical'].includes(def.kind) ? 'click to use' : def.kind === 'ammo' ? 'R to reload' : `B to barricade (${BARRICADE_COST})`;
        return `<div class="inv-cell ${def.kind} ${sim.player.weapon === k ? 'active' : ''}" data-item="${k}"><div class="iname">${def.label}</div><div class="icount">x${inv[k]}</div><div class="iuse">${use}</div></div>`; });
      this.invGrid.innerHTML = cells.join('') || '<div class="dim">Nothing but your fists.</div>';
    });
  }
}
void WEAPONS;
