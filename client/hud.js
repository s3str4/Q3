// DOM HUD (Q3 style): big tabular health/armor/ammo, weapon bar, frag counters + timer, pickup text, obituaries
// with weapon colour chips, item timers, net graph (frame-time bars + ping), damage-direction arcs, screen flashes,
// scoreboard. Cheap by design: text nodes are only touched when a value changes.
import { WEAPON_DEFS, WEAPON_ORDER, WEAPONS, ITEMS, EV, playerColorHex } from '../shared/constants.js';
import { MAPS } from '../maps/index.js';

const $ = (id) => document.getElementById(id);
const MODE_TITLE = { duel: 'Duel', arena: 'Arena' };
const mapTitle = (id) => (MAPS.find((m) => m.id === id) || {}).title || id;
const WSHORT = { [WEAPONS.GAUNTLET]: 'GA', [WEAPONS.MACHINEGUN]: 'MG', [WEAPONS.SHOTGUN]: 'SG', [WEAPONS.ROCKET]: 'RL', [WEAPONS.LIGHTNING]: 'LG', [WEAPONS.RAIL]: 'RG', [WEAPONS.PLASMA]: 'PG' };
const KEYS = { [WEAPONS.GAUNTLET]: 1, [WEAPONS.MACHINEGUN]: 2, [WEAPONS.SHOTGUN]: 3, [WEAPONS.ROCKET]: 4, [WEAPONS.LIGHTNING]: 5, [WEAPONS.RAIL]: 6, [WEAPONS.PLASMA]: 7 };
const SHORT = { [WEAPONS.GAUNTLET]: 'GAUNTLET', [WEAPONS.MACHINEGUN]: 'MACHINEGUN', [WEAPONS.SHOTGUN]: 'SHOTGUN', [WEAPONS.ROCKET]: 'ROCKETS', [WEAPONS.LIGHTNING]: 'LIGHTNING', [WEAPONS.RAIL]: 'RAILGUN', [WEAPONS.PLASMA]: 'PLASMA' };
const WCOL = { [WEAPONS.ROCKET]: '#ff6a3a', [WEAPONS.RAIL]: '#5cff9d', [WEAPONS.LIGHTNING]: '#bfe8ff', [WEAPONS.SHOTGUN]: '#ffc86a', [WEAPONS.PLASMA]: '#b26cff', [WEAPONS.MACHINEGUN]: '#ffe680', [WEAPONS.GAUNTLET]: '#ff9a5c' };
// Announcer medals (Q3 rewards): colour + glyph, drawn in the #medal badge and as mini badges on the end screen.
const MEDAL_SVG = {
  excellent: '<svg viewBox="0 0 32 32"><path d="M16 2l4.1 8.6 9.4 1.2-6.9 6.5 1.8 9.3L16 23l-8.4 4.6 1.8-9.3-6.9-6.5 9.4-1.2z"/></svg>',
  impressive: '<svg viewBox="0 0 32 32"><path d="M16 3a13 13 0 1 0 0 26 13 13 0 0 0 0-26zm0 4a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/></svg>',
  humiliation: '<svg viewBox="0 0 32 32"><path d="M8 13h4V6h3v7h2V5h3v8h2V7h3v12c0 5-3.5 8-8 8s-9-3-9-9v-5z"/></svg>',
  perfect: '<svg viewBox="0 0 32 32"><path d="M13 24L5 16l3-3 5 5L24 7l3 3z"/></svg>',
};
const MEDAL_COLOR = { excellent: '#ffd23a', impressive: '#5cd6ff', humiliation: '#ff4a4a', perfect: '#7dff7d' };
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
    // end screen: callbacks are set by main.js (they talk to the ClientGame)
    this.onVote = () => {}; this.onReady = () => {}; this.onLeave = () => {};
    this.es = $('endscreen'); this.esReady = false; this.esVotes = null; this.esVotesAt = 0; this.endTimer = null;
    for (const mp of MAPS) { const o = document.createElement('option'); o.value = mp.id; o.textContent = mp.title; $('es-map').appendChild(o); }
    $('es-map').onchange = (e) => this.onVote({ map: e.target.value });
    $('es-mode').onchange = (e) => this.onVote({ mode: e.target.value });
    $('es-rematch').onclick = () => this.setReady(!this.esReady);
    $('es-leave').onclick = () => this.onLeave();
  }
  show() { this.el.classList.remove('hidden'); }
  hide() { this.el.classList.add('hidden'); this.hideEnd(); }
  setMap(map) {
    this.mapName = map.name;
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
  // colour a name element with the player's chosen colour ('' = the stylesheet's own / enemy colour)
  tint(id, sp) { const c = sp ? playerColorHex(sp.col, null) : null; const v = c != null ? css(c) : ''; if (this.cache['tint:' + id] !== v) { this.cache['tint:' + id] = v; $(id).style.color = v; } }
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
    this.tint('name-me', me); this.tint('name-them', them); // names in the players' chosen colours
    const m = cg.game.match;
    const arena = cg.game.mode === 'arena';
    if (this.cache.arena !== arena) { this.cache.arena = arena; this.el.classList.toggle('arena', arena); }
    let timerText = '', sub = '';
    if (m.hold) timerText = 'LOADING';
    else if (m.state === 'playing' && !arena) {
      const limit = cg.rules ? cg.rules.timelimit : 600000;
      const left = m.overtime ? 0 : Math.max(0, limit - (cg.serverTime() - m.startTime));
      timerText = m.overtime ? 'OT' : fmt(left); sub = m.overtime ? 'SUDDEN DEATH' : '';
      $('timer').classList.toggle('late', left < 60000 && !m.overtime);
    } else if (m.state === 'playing' && arena) {
      // arena: the running round score lives in the timer slot, the round clock underneath
      const w = m.roundWins || {};
      timerText = `${w[cg.localId] || 0} - ${them ? (w[them.id] || 0) : 0}`;
      const need = Math.floor((cg.rules ? cg.rules.rounds : 10) / 2) + 1;
      if (m.roundState === 'countdown') sub = `ROUND ${(m.round || 0) + 1} · FIRST TO ${need}`;
      else if (m.roundState === 'live') { const left = Math.max(0, (cg.rules ? cg.rules.roundTimelimit : 90000) - (cg.serverTime() - m.roundStart)); sub = `ROUND ${m.round} · ${fmt(left)}`; $('timer').classList.toggle('late', left < 10000); }
      else sub = `ROUND ${m.round || 0} · FIRST TO ${need}`;
    } else if (m.state === 'countdown') timerText = 'READY';
    else if (m.state === 'warmup' || m.state === 'waiting') { timerText = 'WARMUP'; sub = them ? '' : 'WAITING FOR OPPONENT'; }
    else if (m.state === 'ended') { timerText = 'FINAL'; if (arena) { const w = m.roundWins || {}; sub = `${w[cg.localId] || 0} - ${them ? (w[them.id] || 0) : 0}`; } }
    this.set('timer', timerText); this.set('timer-sub', sub);
    if (!this.es.classList.contains('hidden')) this.updateEndCountdown();
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
      case EV.DEATH: { const s = cg.latestSnap; const sp = (id) => (s && s.players.find((x) => x.id === id)) || null; const nm = (id) => { const p = sp(id); return p ? p.n : (cg.game.players.get(id)?.name || 'world'); };
        const mine = (id) => id === cg.localId;
        const span = (id) => { const p = sp(id), c = p ? playerColorHex(p.col, null) : null; return `<span class="${mine(id) ? 'me' : 'them'}"${c != null ? ` style="color:${css(c)}"` : ''}>${esc(nm(id))}</span>`; };
        const victim = span(e.id);
        const html = e.attacker && e.attacker !== e.id ? `<span class="wi"></span>${victim} ${MOD_TEXT[e.mod] || 'was killed by'} ${span(e.attacker)}` : `${victim} ${e.mod === 'fall' ? 'cratered' : e.mod === 'lava' ? 'was burned to a crisp' : 'blew themselves up'}`;
        this.obituary(html, WCOL[e.mod] || '#ff4a4a');
        if (e.id === cg.localId) this.center('YOU DIED', 1600, e.attacker && e.attacker !== e.id ? `killed by ${nm(e.attacker)}` : ''); else if (e.attacker === cg.localId) this.center('FRAG', 700, nm(e.id)); break; }
      case EV.COUNTDOWN: this.hideEnd(); this.center(e.seconds > 0 ? String(e.seconds) : 'FIGHT', 900, e.round ? `ROUND ${e.round}` : ''); break;
      case EV.MATCH_START: this.hideEnd(); this.center('FIGHT!', 1200); break;
      case EV.MATCH_END: {
        const win = e.winner === cg.localId;
        this.center(e.winner == null ? 'DRAW' : win ? 'YOU WIN' : 'YOU LOSE', 1400);
        clearTimeout(this.endTimer); this.endTimer = setTimeout(() => this.showEnd(e, cg), 1200); // let the last frag / fanfare land first
        break;
      }
      case EV.ROUND_START: this.center('FIGHT!', 1000, `ROUND ${e.round}`); break;
      case EV.ROUND_END: { const w = e.wins || {}; const mine = w[cg.localId] || 0; const theirs = Object.entries(w).filter(([id]) => +id !== cg.localId).reduce((s, [, n]) => s + n, 0);
        this.center(e.winner === cg.localId ? 'ROUND WON' : e.winner == null ? 'ROUND DRAW' : 'ROUND LOST', 1800, `${mine} - ${theirs}`); break; }
      case EV.MAJOR_WARN: this.center(e.text, 2500); break;
      // announcer: the medal badge for the player who earned it (the victim of a gauntlet frag sees it too), lead / frag /
      // time calls as a short sub-line so they read even with the voice off
      case EV.AWARD: if (e.id === cg.localId || (e.award === 'humiliation' && e.target === cg.localId)) this.medal(e.award, e.id === cg.localId ? e.count : 0); break;
      case EV.LEAD: if (e.id === cg.localId) this.later(700, () => this.center('', 1500, { taken: 'YOU HAVE TAKEN THE LEAD', lost: 'YOU HAVE LOST THE LEAD', tied: 'TIED FOR THE LEAD' }[e.status])); break;
      case EV.FRAGS_LEFT: this.later(700, () => this.center('', 1500, e.left === 1 ? '1 FRAG LEFT' : `${e.left} FRAGS LEFT`)); break;
      case EV.TIME_WARN: this.center('', 2000, `${e.minutes} MINUTE WARNING`); break;
    }
  }
  // ---- end of match screen ----
  showEnd(e, cg) {
    const es = this.es;
    const me = cg.localId;
    const banner = $('es-banner');
    banner.textContent = e.winner == null ? 'DRAW' : e.winner === me ? 'YOU WIN' : 'YOU LOSE';
    banner.className = e.winner == null ? '' : e.winner === me ? 'win' : 'lose';
    const dur = fmt(e.duration || 0);
    $('es-sub').textContent = `${mapTitle(e.map || this.mapName).toUpperCase()} · ${(MODE_TITLE[e.mode] || e.mode || '').toUpperCase()} · ${dur}${e.overtime ? ' (OT)' : ''}${e.mode === 'arena' ? ` · ${e.rounds} ROUNDS` : ''}`;
    const ids = Object.keys(e.scores || {}).map(Number).sort((a, b) => (e.scores[b].frags - e.scores[a].frags) || (e.scores[b].rounds - e.scores[a].rounds));
    const usedW = WEAPON_ORDER.filter((w) => ids.some((id) => (e.scores[id].byWeapon || {})[w]));
    const pct = (h, s) => (s ? Math.round(100 * h / s) : 0);
    const anyAwards = ids.some((id) => Object.values(e.scores[id].awards || {}).some((n) => n > 0));
    const medals = (s) => Object.entries(s.awards || {}).filter(([, n]) => n > 0).map(([a, n]) => `<span class="mini-medal" style="--mc:${MEDAL_COLOR[a] || '#fff'}" title="${esc(a)}">${MEDAL_SVG[a] || ''}${n}</span>`).join('');
    const head = `<tr><th>PLAYER</th>${e.mode === 'arena' ? '<th>ROUNDS</th>' : ''}<th>FRAGS</th><th>DEATHS</th><th>DMG</th><th>ACC</th>${usedW.map((w) => `<th title="${WEAPON_DEFS[w].name}">${WSHORT[w]}</th>`).join('')}${anyAwards ? '<th>MEDALS</th>' : ''}</tr>`;
    const rows = ids.map((id) => { const s = e.scores[id]; const cls = [id === e.winner ? 'winner' : '', id === me ? 'me' : ''].join(' ').trim();
      const wcells = usedW.map((w) => { const b = (s.byWeapon || {})[w]; return b ? `<td class="w">${pct(b.hits, b.shots)}%<small>${b.hits}/${b.shots}</small></td>` : '<td class="w">-</td>'; }).join('');
      return `<tr class="${cls}"><td>${esc(s.name)}${s.bot ? ' (bot)' : ''}</td>${e.mode === 'arena' ? `<td>${s.rounds}</td>` : ''}<td>${s.frags}</td><td>${s.deaths}</td><td>${s.dmg}</td><td>${pct(s.hits, s.shots)}%</td>${wcells}${anyAwards ? `<td>${medals(s)}</td>` : ''}</tr>`; }).join('');
    $('es-table').innerHTML = head + rows;
    // next match controls start from the current map / mode; the selects only send a vote when the player changes them
    const allowed = cg.maps || MAPS.map((m) => m.id);
    for (const o of $('es-map').options) o.disabled = !allowed.includes(o.value);
    $('es-map').value = e.map || this.mapName; $('es-mode').value = e.mode || cg.game.mode;
    this.setReady(false, false);
    this.esVotes = cg.votes || null; this.esVotesAt = performance.now();
    this.renderVotes(cg);
    es.classList.remove('hidden');
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch {}
  }
  hideEnd() { clearTimeout(this.endTimer); if (!this.es.classList.contains('hidden')) { this.es.classList.add('hidden'); this.esVotes = null; } }
  get endVisible() { return !this.es.classList.contains('hidden'); }
  setReady(ready, send = true) {
    this.esReady = ready;
    const b = $('es-rematch'); b.classList.toggle('ready', ready); b.textContent = ready ? 'READY - CLICK TO CANCEL' : 'REMATCH';
    if (send) this.onReady(ready);
  }
  // live vote state from the server (VOTES message)
  votes(v, cg) {
    this.esVotes = v; this.esVotesAt = performance.now();
    if (v && v.players && v.players[cg.localId]) { const mine = v.players[cg.localId]; if (mine.ready !== this.esReady) this.setReady(!!mine.ready, false); }
    if (this.endVisible) this.renderVotes(cg);
  }
  renderVotes(cg) {
    const v = this.esVotes;
    const el = $('es-votes');
    if (!v || !v.players) { el.innerHTML = ''; $('es-auto').textContent = ''; return; }
    const rows = Object.entries(v.players).map(([id, p]) => {
      const pick = p.bot ? 'any map' : (p.map || p.mode) ? `${p.map ? mapTitle(p.map) : 'same map'} · ${p.mode ? MODE_TITLE[p.mode] : 'same mode'}` : 'no vote';
      return `<div class="v${p.ready ? ' ready' : ''}"><span class="n">${esc(p.name)}${+id === cg.localId ? ' (you)' : p.bot ? ' (bot)' : ''}</span><span class="p">${esc(pick)}</span><span class="r">${p.ready ? 'READY' : 'NOT READY'}</span></div>`;
    }).join('');
    const next = v.next || {};
    el.innerHTML = rows + `<div class="next">NEXT: ${esc(mapTitle(next.map || this.mapName))} · ${esc((MODE_TITLE[next.mode] || next.mode || '').toUpperCase())}${(next.map && next.map !== this.mapName) ? ' (map change)' : ''}</div>`;
    this.updateEndCountdown(true);
  }
  updateEndCountdown(force = false) {
    const v = this.esVotes; if (!v) return;
    const left = Math.max(0, (v.left || 0) - (performance.now() - this.esVotesAt));
    const s = Math.ceil(left / 1000);
    if (force || s !== this.cache.esAuto) { this.cache.esAuto = s; $('es-auto').textContent = v.open ? `both players ready starts the next match now · otherwise it starts in ${s} s` : 'starting...'; }
  }
  pickup(text) { const el = $('pickup-msg'); el.textContent = text.toUpperCase(); el.style.opacity = 1; clearTimeout(this.pickupTimer); this.pickupTimer = setTimeout(() => (el.style.opacity = 0), 900); }
  later(ms, fn) { setTimeout(fn, ms); }
  medal(award, count = 0) {
    const el = $('medal'); el.style.setProperty('--mc', MEDAL_COLOR[award] || '#fff');
    el.querySelector('.medal-icon').innerHTML = MEDAL_SVG[award] || '';
    el.querySelector('.medal-text').innerHTML = esc(award.toUpperCase()) + (count > 1 ? `<small>x${count}</small>` : '');
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    clearTimeout(this.medalTimer); this.medalTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }
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
    const rows = [...s.players].sort((a, b) => b.f - a.f).map((p) => { const c = playerColorHex(p.col, null); return `<tr><td${c != null ? ` style="color:${css(c)}"` : ''}>${esc(p.n)}${p.bot ? ' (bot)' : ''}${p.sk ? ` <small style="opacity:.55">${esc(p.sk)}</small>` : ''}</td><td>${p.f}</td><td>${p.dt}</td><td>${p.dd}</td><td>${p.shots ? Math.round(100 * p.hits / p.shots) : 0}%</td><td>${p.ping}</td></tr>`; }).join('');
    sb.innerHTML = `<h2>${cg.game.mode.toUpperCase()} · ${esc(cg.map.title || cg.map.name)}</h2><table><tr><th>PLAYER</th><th>FRAGS</th><th>DEATHS</th><th>DMG</th><th>ACC</th><th>PING</th></tr>${rows}</table>`;
    sb.classList.remove('hidden');
  }
}
function fmt(ms) { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function css(hex) { return '#' + (hex >>> 0).toString(16).padStart(6, '0'); }
