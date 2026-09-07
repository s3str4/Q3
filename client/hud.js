// DOM HUD: health/armor/ammo, scores, timer, weapon list, pickups, obituaries, net graph, item timers, scoreboard.
import { WEAPON_DEFS, WEAPON_ORDER, WEAPONS, ITEMS, EV } from '../shared/constants.js';

const $ = (id) => document.getElementById(id);
const KEYS = { [WEAPONS.GAUNTLET]: 1, [WEAPONS.MACHINEGUN]: 2, [WEAPONS.SHOTGUN]: 3, [WEAPONS.ROCKET]: 4, [WEAPONS.LIGHTNING]: 5, [WEAPONS.RAIL]: 6, [WEAPONS.PLASMA]: 7 };
const SHORT = { [WEAPONS.GAUNTLET]: 'GAUNTLET', [WEAPONS.MACHINEGUN]: 'MACHINEGUN', [WEAPONS.SHOTGUN]: 'SHOTGUN', [WEAPONS.ROCKET]: 'ROCKETS', [WEAPONS.LIGHTNING]: 'LIGHTNING', [WEAPONS.RAIL]: 'RAILGUN', [WEAPONS.PLASMA]: 'PLASMA' };
const MOD_TEXT = { [WEAPONS.GAUNTLET]: 'was pummeled by', [WEAPONS.MACHINEGUN]: 'was machinegunned by', [WEAPONS.SHOTGUN]: 'was gunned down by', [WEAPONS.ROCKET]: 'ate a rocket from', [WEAPONS.LIGHTNING]: 'was electrocuted by', [WEAPONS.RAIL]: 'was railed by', [WEAPONS.PLASMA]: 'was melted by', fall: 'cratered', lava: 'was burned to a crisp', telefrag: 'was telefragged by' };

export class Hud {
  constructor() {
    this.el = $('hud'); this.msgTimer = 0; this.obits = []; this.fps = 0; this.frameTimes = []; this.lastFrame = 0;
    this.weaponsEl = $('weapons');
    this.weaponRows = {};
    for (const w of WEAPON_ORDER) { const d = document.createElement('div'); d.className = 'w'; d.innerHTML = `<span class="k">${KEYS[w]}</span><span class="n">${SHORT[w]}</span> <span class="a"></span>`; this.weaponsEl.appendChild(d); this.weaponRows[w] = d; }
    this.pickupTimer = null; this.centerTimer = null;
    this.itemTimersEl = $('item-timers');
    this.majorItems = [];
  }
  show() { this.el.classList.remove('hidden'); }
  hide() { this.el.classList.add('hidden'); }
  setMap(map) {
    this.majorItems = map.items.map((it, i) => ({ i, type: it.type, def: ITEMS[it.type] })).filter((x) => x.def.major && x.def.kind !== 'weapon');
  }
  frame(now) {
    if (this.lastFrame) { this.frameTimes.push(now - this.lastFrame); if (this.frameTimes.length > 120) this.frameTimes.shift(); }
    this.lastFrame = now;
  }
  update(cg, view, now) {
    const p = view && view.player;
    if (!p) return;
    const hp = $('hp'), ar = $('ar');
    hp.textContent = Math.max(0, p.health); ar.textContent = Math.max(0, p.armor);
    hp.parentElement.classList.toggle('low', p.health <= 30);
    const wd = WEAPON_DEFS[p.weapon];
    $('wname').textContent = wd ? SHORT[p.weapon] : '';
    const ammo = p.ammo[p.weapon];
    $('ammo').textContent = ammo === -1 ? '∞' : (ammo ?? 0);
    for (const w of WEAPON_ORDER) {
      const row = this.weaponRows[w];
      const have = (p.weapons & (1 << w)) !== 0;
      row.classList.toggle('have', have); row.classList.toggle('active', p.weapon === w);
      row.querySelector('.a').textContent = have ? (p.ammo[w] === -1 ? '' : (p.ammo[w] ?? 0)) : '';
      row.style.display = have ? '' : 'none';
    }
    // scores & timer
    const snap = cg.latestSnap;
    const me = snap && snap.players.find((x) => x.id === cg.localId);
    const them = snap && snap.players.find((x) => x.id !== cg.localId);
    $('score-me').textContent = me ? me.f : 0; $('score-them').textContent = them ? them.f : '-';
    $('name-me').textContent = me ? me.n : ''; $('name-them').textContent = them ? them.n : 'waiting for opponent';
    const m = cg.game.match;
    let timerText = '';
    if (m.state === 'playing' && cg.game.mode === 'duel') {
      const limit = cg.rules ? cg.rules.timelimit : 600000;
      const left = m.overtime ? 0 : Math.max(0, limit - (cg.serverTime() - m.startTime));
      timerText = m.overtime ? 'OVERTIME' : fmt(left);
      $('timer').classList.toggle('late', left < 60000 && !m.overtime);
    } else if (m.state === 'countdown') timerText = 'READY';
    else if (m.state === 'warmup') timerText = 'WARMUP';
    else if (m.state === 'ended') timerText = 'FINAL';
    else if (cg.game.mode === 'arena') { const w = m.roundWins || {}; timerText = `ROUND ${m.round || 0}  ${w[cg.localId] || 0}-${them ? (w[them.id] || 0) : 0}`; }
    $('timer').textContent = timerText;
    // speed & net
    const v = view.velocity; $('speedometer').textContent = Math.round(Math.hypot(v[0], v[1])) + ' ups';
    if (now - (this.netAt || 0) > 250) {
      this.netAt = now;
      const ft = this.frameTimes; const avg = ft.length ? ft.reduce((a, b) => a + b, 0) / ft.length : 0;
      const p99 = ft.length ? [...ft].sort((a, b) => a - b)[Math.floor(ft.length * 0.99)] : 0;
      $('ng-ping').textContent = `${Math.round(cg.clock.rtt)} ms ±${cg.clock.jitter.toFixed(0)}`;
      $('ng-fps').textContent = `${avg ? Math.round(1000 / avg) : 0} fps`;
      $('ng-frame').textContent = `${avg.toFixed(1)}/${p99.toFixed(1)} ms`;
      const gaps = cg.snapGaps; const ga = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
      $('ng-snap').textContent = `snap ${ga ? Math.round(1000 / ga) : 0}Hz err ${cg.misprediction.toFixed(2)}`;
    }
    // item timers (duel: show respawn countdown for majors, like a pro's mental clock; competitive-legal since Q3 shows pickups)
    if (cg.game.mode === 'duel' && now - (this.itAt || 0) > 200) {
      this.itAt = now;
      const rows = [];
      for (const mi of this.majorItems) {
        const it = cg.game.items[mi.i];
        if (!it) continue;
        const left = it.available ? 0 : Math.max(0, it.respawnAt - cg.serverTime());
        rows.push(`<div>${mi.def.label.toUpperCase().padEnd(12)} ${it.available ? 'UP' : (left / 1000).toFixed(0) + 's'}</div>`);
      }
      this.itemTimersEl.innerHTML = rows.join('');
    }
  }
  event(e, cg) {
    switch (e.type) {
      case EV.PICKUP: if (e.id === cg.localId) this.pickup(ITEMS[e.itemType].label); break;
      case EV.HIT: if (e.id === cg.localId) this.hit(e.damage); break;
      case EV.PAIN: if (e.id === cg.localId) this.damageFlash(e.damage); break;
      case EV.DEATH: { const s = cg.latestSnap; const nm = (id) => { const p = s && s.players.find((x) => x.id === id); return p ? p.n : (cg.game.players.get(id)?.name || 'world'); };
        const text = e.attacker && e.attacker !== e.id ? `${nm(e.id)} ${MOD_TEXT[e.mod] || 'was killed by'} ${nm(e.attacker)}` : `${nm(e.id)} ${e.mod === 'fall' ? 'cratered' : e.mod === 'lava' ? 'was burned to a crisp' : 'blew themselves up'}`;
        this.obituary(text); if (e.id === cg.localId) this.center('YOU DIED', 1500); else if (e.attacker === cg.localId) this.center('FRAG', 700); break; }
      case EV.COUNTDOWN: this.center(e.seconds > 0 ? String(e.seconds) : 'FIGHT', 900); break;
      case EV.MATCH_START: this.center('FIGHT!', 1200); break;
      case EV.MATCH_END: { const win = e.winner === cg.localId; this.center(e.winner == null ? 'DRAW' : win ? 'YOU WIN' : 'YOU LOSE', 6000); break; }
      case EV.ROUND_START: this.center(`ROUND ${e.round}`, 1000); break;
      case EV.ROUND_END: this.center(e.winner === cg.localId ? 'ROUND WON' : e.winner == null ? 'ROUND DRAW' : 'ROUND LOST', 1800); break;
      case EV.MAJOR_WARN: this.center(e.text, 2500); break;
    }
  }
  pickup(text) { const el = $('pickup-msg'); el.textContent = text.toUpperCase(); el.style.opacity = 1; clearTimeout(this.pickupTimer); this.pickupTimer = setTimeout(() => (el.style.opacity = 0), 900); }
  center(text, ms) { const el = $('center-msg'); el.textContent = text; el.style.opacity = 1; clearTimeout(this.centerTimer); this.centerTimer = setTimeout(() => (el.style.opacity = 0), ms); }
  hit(dmg) { const hm = $('hitmarker'); hm.classList.remove('show'); void hm.offsetWidth; hm.classList.add('show'); const ch = $('crosshair'); ch.classList.add('hit'); setTimeout(() => ch.classList.remove('hit'), 150); }
  damageFlash(dmg) { const el = $('damage-flash'); el.style.opacity = Math.min(1, 0.3 + dmg / 100); setTimeout(() => (el.style.opacity = 0), 90); }
  obituary(text) { const el = $('obituary'); const d = document.createElement('div'); d.textContent = text; el.appendChild(d); setTimeout(() => d.remove(), 5000); }
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
