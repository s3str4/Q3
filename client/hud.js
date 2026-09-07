// DOM HUD (Q3 style): big tabular health/armor/ammo, weapon bar, frag counters + timer, pickup text, obituaries
// with weapon colour chips, item timers, net graph (frame-time bars + ping), damage-direction arcs, screen flashes,
// scoreboard. Cheap by design: text nodes are only touched when a value changes.
import { WEAPON_DEFS, WEAPON_ORDER, WEAPONS, ITEMS, EV } from '../shared/constants.js';

const $ = (id) => document.getElementById(id);
const KEYS = { [WEAPONS.GAUNTLET]: 1, [WEAPONS.MACHINEGUN]: 2, [WEAPONS.SHOTGUN]: 3, [WEAPONS.ROCKET]: 4, [WEAPONS.LIGHTNING]: 5, [WEAPONS.RAIL]: 6, [WEAPONS.PLASMA]: 7 };
const SHORT = { [WEAPONS.GAUNTLET]: 'GAUNTLET', [WEAPONS.MACHINEGUN]: 'MACHINEGUN', [WEAPONS.SHOTGUN]: 'SHOTGUN', [WEAPONS.ROCKET]: 'ROCKETS', [WEAPONS.LIGHTNING]: 'LIGHTNING', [WEAPONS.RAIL]: 'RAILGUN', [WEAPONS.PLASMA]: 'PLASMA' };
const WCOL = { [WEAPONS.ROCKET]: '#ff6a3a', [WEAPONS.RAIL]: '#5cff9d', [WEAPONS.LIGHTNING]: '#bfe8ff', [WEAPONS.SHOTGUN]: '#ffc86a', [WEAPONS.PLASMA]: '#b26cff', [WEAPONS.MACHINEGUN]: '#ffe680', [WEAPONS.GAUNTLET]: '#ff9a5c' };
const ICOL = { mega: '#3d8cff', armorRed: '#ff3d3d', armorYellow: '#ffd23a', weaponRocket: WCOL[WEAPONS.ROCKET], weaponRail: WCOL[WEAPONS.RAIL], weaponLightning: WCOL[WEAPONS.LIGHTNING] };
const MOD_TEXT = { [WEAPONS.GAUNTLET]: 'was pummeled by', [WEAPONS.MACHINEGUN]: 'was machinegunned by', [WEAPONS.SHOTGUN]: 'was gunned down by', [WEAPONS.ROCKET]: 'ate a rocket from', [WEAPONS.LIGHTNING]: 'was electrocuted by', [WEAPONS.RAIL]: 'was railed by', [WEAPONS.PLASMA]: 'was melted by', fall: 'cratered', lava: 'was burned to a crisp', telefrag: 'was telefragged by' };
// ammo icon shapes per weapon (SVG paths in a 32x32 box)
const AMMO_ICON = { [WEAPONS.ROCKET]: 'M16 2l5 8v14l-3 6h-4l-3-6V10z', [WEAPONS.RAIL]: 'M14 2h4v28h-4z M10 8h12v3H10z M10 21h12v3H10z', [WEAPONS.LIGHTNING]: 'M18 2L8 18h7l-3 12 12-17h-7z', [WEAPONS.SHOTGUN]: 'M11 3h10v8h-2v18h-6V11h-2z', [WEAPONS.PLASMA]: 'M16 4a12 12 0 1 0 0 24 12 12 0 0 0 0-24zm0 6a6 6 0 1 1 0 12 6 6 0 0 1 0-12z', [WEAPONS.MACHINEGUN]: 'M12 4h8v6l2 2v16H10V12l2-2z', [WEAPONS.GAUNTLET]: 'M8 12h16v14H8z M10 6h4v6h-4z M18 6h4v6h-4z' };

export class Hud {
  constructor() {
    this.el = $('hud'); this.msgTimer = 0; this.fps = 0; this.frameTimes = []; this.lastFrame = 0;
    this.weaponsEl = $('weapons');
    this.weaponRows = {};
    for (const w of WEAPON_ORDER) {
      const d = document.createElement('div'); d.className = 'w'; d.style.setProperty('--c', WCOL[w]);
      d.innerHTML = `<span class="k">${KEYS[w]}</span><span class="sw"></span><span class="n">${SHORT[w]}</span><span class="a"></span>`;
      this.weaponsEl.appendChild(d); this.weaponRows[w] = { el: d, a: d.querySelector('.a'), have: null, active: null, ammo: null };
    }
    this.pickupTimer = null; this.centerTimer = null;
    this.itemTimersEl = $('item-timers');
    this.majorItems = []; this.itemRows = [];
    this.ng = $('ng-canvas').getContext('2d');
    this.cache = {}; this.dirIdx = 0; this.viewYaw = 0;
  }
  show() { this.el.classList.remove('hidden'); }
  hide() { this.el.classList.add('hidden'); }
  setMap(map) {
    this.majorItems = map.items.map((it, i) => ({ i, type: it.type, def: ITEMS[it.type] })).filter((x) => x.def.major && x.def.kind !== 'weapon');
    this.itemTimersEl.innerHTML = '';
    this.itemRows = this.majorItems.map((mi) => {
      const d = document.createElement('div'); d.style.setProperty('--c', ICOL[mi.type] || '#fff');
      d.innerHTML = `<span class="sw"></span><span class="n">${mi.def.label.toUpperCase()}</span><span class="t"></span>`;
      this.itemTimersEl.appendChild(d); return { el: d, t: d.querySelector('.t'), last: null, cls: null };
    });
  }
  frame(now) {
    if (this.lastFrame) { this.frameTimes.push(now - this.lastFrame); if (this.frameTimes.length > 120) this.frameTimes.shift(); }
    this.lastFrame = now;
  }
  set(id, text) { if (this.cache[id] !== text) { this.cache[id] = text; $(id).textContent = text; } }
  update(cg, view, now) {
    const p = view && view.player;
    if (!p) return;
    this.viewYaw = view.angles[1];
    const hp = Math.max(0, p.health), ar = Math.max(0, p.armor);
    this.set('hp', hp); this.set('ar', ar);
    const hs = $('hp').parentElement.parentElement, as = $('ar').parentElement.parentElement;
    hs.classList.toggle('low', hp <= 30); hs.classList.toggle('mega', hp > 100);
    as.classList.toggle('red', ar > 100);
    const wd = WEAPON_DEFS[p.weapon];
    this.set('wname', wd ? SHORT[p.weapon] : '');
    const ammo = p.ammo[p.weapon];
    this.set('ammo', ammo === -1 ? '∞' : (ammo ?? 0));
    const ammoStat = $('ammo').parentElement.parentElement;
    ammoStat.classList.toggle('low', ammo !== -1 && (ammo ?? 0) <= 5);
    if (this.cache.wcol !== p.weapon) { this.cache.wcol = p.weapon; ammoStat.style.color = WCOL[p.weapon] || '#cfe4ff'; $('ammo-icon').setAttribute('d', AMMO_ICON[p.weapon] || AMMO_ICON[WEAPONS.MACHINEGUN]); }
    for (const w of WEAPON_ORDER) {
      const row = this.weaponRows[w];
      const have = (p.weapons & (1 << w)) !== 0, active = p.weapon === w, a = have ? (p.ammo[w] === -1 ? '' : (p.ammo[w] ?? 0)) : '';
      if (row.have !== have) { row.have = have; row.el.classList.toggle('have', have); row.el.style.display = have ? '' : 'none'; }
      if (row.active !== active) { row.active = active; row.el.classList.toggle('active', active); }
      if (row.ammo !== a) { row.ammo = a; row.a.textContent = a; row.el.classList.toggle('empty', a === 0); }
    }
    // scores & timer
    const snap = cg.latestSnap;
    const me = snap && snap.players.find((x) => x.id === cg.localId);
    const them = snap && snap.players.find((x) => x.id !== cg.localId);
    this.set('score-me', me ? me.f : 0); this.set('score-them', them ? them.f : '-');
    this.set('name-me', me ? me.n : ''); this.set('name-them', them ? them.n : 'waiting...');
    const m = cg.game.match;
    let timerText = '';
    if (m.state === 'playing' && cg.game.mode === 'duel') {
      const limit = cg.rules ? cg.rules.timelimit : 600000;
      const left = m.overtime ? 0 : Math.max(0, limit - (cg.serverTime() - m.startTime));
      timerText = m.overtime ? 'OT' : fmt(left);
      $('timer').classList.toggle('late', left < 60000 && !m.overtime);
    } else if (m.state === 'countdown') timerText = 'READY';
    else if (m.state === 'warmup') timerText = 'WARMUP';
    else if (m.state === 'ended') timerText = 'FINAL';
    else if (cg.game.mode === 'arena') { const w = m.roundWins || {}; timerText = `R${m.round || 0} ${w[cg.localId] || 0}-${them ? (w[them.id] || 0) : 0}`; }
    this.set('timer', timerText);
    // speed & net graph
    const v = view.velocity; this.set('speedometer', Math.round(Math.hypot(v[0], v[1])) + ' ups');
    this.drawNetGraph(cg, now);
    // item timers (duel: show respawn countdown for majors, like a pro's mental clock; competitive-legal since Q3 shows pickups)
    if (cg.game.mode === 'duel' && now - (this.itAt || 0) > 150) {
      this.itAt = now;
      for (let i = 0; i < this.majorItems.length; i++) {
        const it = cg.game.items[this.majorItems[i].i], row = this.itemRows[i];
        if (!it) continue;
        const left = it.available ? 0 : Math.max(0, it.respawnAt - cg.serverTime());
        const text = it.available ? 'UP' : Math.ceil(left / 1000) + 's', cls = it.available ? 'up' : left < 5000 ? 'soon' : '';
        if (row.last !== text) { row.last = text; row.t.textContent = text; }
        if (row.cls !== cls) { row.cls = cls; row.el.className = cls; }
      }
    }
  }
  drawNetGraph(cg, now) {
    const ctx = this.ng, W = 180, H = 44, ft = this.frameTimes;
    if (now - (this.ngAt || 0) < 33) return; // 30 Hz is plenty for a graph
    this.ngAt = now;
    ctx.clearRect(0, 0, W, H);
    // frame time bars: 8 ms = half height; colour by budget (green < 8, yellow < 16, red beyond)
    const n = Math.min(ft.length, 120);
    for (let i = 0; i < n; i++) {
      const t = ft[ft.length - n + i], h = Math.min(H, t / 16 * H);
      ctx.fillStyle = t < 8 ? 'rgba(90,255,120,0.85)' : t < 16.7 ? 'rgba(255,210,60,0.9)' : 'rgba(255,60,60,0.95)';
      ctx.fillRect(i * 1.5, H - h, 1.2, h);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(0, H / 2, W, 1); // 8 ms line
    if (now - (this.netAt || 0) > 250) {
      this.netAt = now;
      const avg = ft.length ? ft.reduce((a, b) => a + b, 0) / ft.length : 0;
      const p99 = ft.length ? [...ft].sort((a, b) => a - b)[Math.floor(ft.length * 0.99)] : 0;
      this.set('ng-ping', `${Math.round(cg.clock.rtt)}ms ±${cg.clock.jitter.toFixed(0)}`);
      this.set('ng-fps', `${avg ? Math.round(1000 / avg) : 0}fps`);
      this.set('ng-frame', `${avg.toFixed(1)}/${p99.toFixed(1)}ms`);
      const gaps = cg.snapGaps; const ga = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
      this.set('ng-snap', `${ga ? Math.round(1000 / ga) : 0}Hz e${cg.misprediction.toFixed(1)}`);
    }
  }
  event(e, cg) {
    switch (e.type) {
      case EV.PICKUP: if (e.id === cg.localId) { this.pickup(ITEMS[e.itemType].label); this.flash('pickup-flash', 1, 120); } break;
      case EV.HIT: if (e.id === cg.localId) this.hit(e.damage); break;
      case EV.PAIN: if (e.id === cg.localId) { this.damageFlash(e.damage); this.damageDir(e, cg); } break;
      case EV.DEATH: { const s = cg.latestSnap; const nm = (id) => { const p = s && s.players.find((x) => x.id === id); return p ? p.n : (cg.game.players.get(id)?.name || 'world'); };
        const mine = (id) => id === cg.localId;
        const victim = `<span class="${mine(e.id) ? 'me' : 'them'}">${esc(nm(e.id))}</span>`;
        const html = e.attacker && e.attacker !== e.id ? `<span class="wi"></span>${victim} ${MOD_TEXT[e.mod] || 'was killed by'} <span class="${mine(e.attacker) ? 'me' : 'them'}">${esc(nm(e.attacker))}</span>` : `${victim} ${e.mod === 'fall' ? 'cratered' : e.mod === 'lava' ? 'was burned to a crisp' : 'blew themselves up'}`;
        this.obituary(html, WCOL[e.mod] || '#ff4a4a');
        if (e.id === cg.localId) this.center('YOU DIED', 1600, e.attacker && e.attacker !== e.id ? `killed by ${nm(e.attacker)}` : ''); else if (e.attacker === cg.localId) this.center('FRAG', 700, nm(e.id)); break; }
      case EV.COUNTDOWN: this.center(e.seconds > 0 ? String(e.seconds) : 'FIGHT', 900); break;
      case EV.MATCH_START: this.center('FIGHT!', 1200); break;
      case EV.MATCH_END: { const win = e.winner === cg.localId; this.center(e.winner == null ? 'DRAW' : win ? 'YOU WIN' : 'YOU LOSE', 6000); break; }
      case EV.ROUND_START: this.center(`ROUND ${e.round}`, 1000); break;
      case EV.ROUND_END: this.center(e.winner === cg.localId ? 'ROUND WON' : e.winner == null ? 'ROUND DRAW' : 'ROUND LOST', 1800); break;
      case EV.MAJOR_WARN: this.center(e.text, 2500); break;
    }
  }
  pickup(text) { const el = $('pickup-msg'); el.textContent = text.toUpperCase(); el.style.opacity = 1; clearTimeout(this.pickupTimer); this.pickupTimer = setTimeout(() => (el.style.opacity = 0), 900); }
  center(text, ms, sub = '') { const el = $('center-msg'); el.innerHTML = esc(text) + (sub ? `<span class="sub">${esc(sub)}</span>` : ''); el.style.opacity = 1; clearTimeout(this.centerTimer); this.centerTimer = setTimeout(() => (el.style.opacity = 0), ms); }
  hit(dmg) { const hm = $('hitmarker'); hm.classList.remove('show'); void hm.offsetWidth; hm.classList.add('show'); const ch = $('crosshair'); ch.classList.add('hit'); setTimeout(() => ch.classList.remove('hit'), 150); }
  damageFlash(dmg) { this.flash('damage-flash', Math.min(1, 0.3 + dmg / 90), 100); }
  flash(id, opacity, ms) { const el = $(id); el.style.opacity = opacity; clearTimeout(this['ft_' + id]); this['ft_' + id] = setTimeout(() => (el.style.opacity = 0), ms); }
  // Damage direction arc: rotated so the arc sits toward the attacker relative to the current view yaw.
  damageDir(e, cg) {
    if (!e.attacker || e.attacker === cg.localId || !cg.predicted) return;
    const a = cg.remote.get(e.attacker); if (!a) return;
    const o = cg.predicted.ps.origin;
    const ang = Math.atan2(a.origin[1] - o[1], a.origin[0] - o[0]) * 180 / Math.PI;
    const rel = ang - this.viewYaw; // 0 = ahead, +90 = left (Q3 yaw is CCW)
    const el = $('dmg-dirs').children[this.dirIdx++ % 4];
    el.classList.remove('show'); void el.offsetWidth;
    el.style.transform = `rotate(${-rel}deg)`; el.classList.add('show');
  }
  obituary(html, color) { const el = $('obituary'); const d = document.createElement('div'); d.innerHTML = html; d.style.setProperty('--c', color); el.appendChild(d); while (el.children.length > 5) el.firstChild.remove(); setTimeout(() => d.remove(), 5000); }
  scoreboard(show, cg) {
    const sb = $('scoreboard');
    if (!show) { sb.classList.add('hidden'); return; }
    const s = cg.latestSnap; if (!s) return;
    const rows = [...s.players].sort((a, b) => b.f - a.f).map((p) => `<tr><td>${esc(p.n)}${p.bot ? ' (bot)' : ''}</td><td>${p.f}</td><td>${p.dt}</td><td>${p.dd}</td><td>${p.shots ? Math.round(100 * p.hits / p.shots) : 0}%</td><td>${p.ping}</td></tr>`).join('');
    sb.innerHTML = `<h2>${cg.game.mode.toUpperCase()} · ${esc(cg.map.title || cg.map.name)}</h2><table><tr><th>PLAYER</th><th>FRAGS</th><th>DEATHS</th><th>DMG</th><th>ACC</th><th>PING</th></tr>${rows}</table>`;
    sb.classList.remove('hidden');
  }
}
function fmt(ms) { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
