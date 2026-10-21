// Home screen, pause, settings, map, results and challenge panels.

import { WorldMap } from './map.js';
import { POI_KIND } from '../world/pois.js';
import { WEATHER } from '../render/sky.js';
import { ACTIONS, keyLabel } from '../core/input.js';
import { CHALLENGES, TIERS, evaluateRun, progressOf } from '../flight/challenges.js';
import { SHOP, CATEGORIES, FREE_IDS, byId, defaultEquipped } from '../game/shop.js';
import { DIFFICULTIES, diffByKey } from '../game/race.js';
import {
  formatNumber, formatTime, clamp, fmtSpeed, fmtLong, fmtShort, setUnits,
} from '../core/math.js';

const clockLabel = (v) => {
  const h = Math.floor(v);
  const m = Math.floor((v - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const host = () => document.getElementById('overlayHost');

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export class UI {
  constructor(game) {
    this.game = game;
    this.stack = [];
    this.map = null;
    this.launchMode = 'cliff';
    game.ui = this;

    document.querySelectorAll('#title .menu button').forEach((b) => {
      b.addEventListener('click', () => this.titleAction(b.dataset.act));
    });

    window.addEventListener('keydown', (e) => this.onKey(e));
    document.getElementById('view').addEventListener('click', () => {
      if (this.game.mode === 'fly' && !this.stack.length && !this.game.paused) {
        this.game.input.requestLock(document.getElementById('view'));
      }
    });
  }

  onKey(e) {
    const g = this.game;
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (g.input.capture) return;

    // Escape comes before everything else, including the title screen's own
    // shortcuts. It used to sit after them, so on the title screen -- which
    // is exactly where you open the shop and the challenge list from -- the
    // key did nothing and the only way out of a long panel was to scroll to
    // the bottom of it.
    if (e.code === 'Escape' || e.code === 'Tab') {
      e.preventDefault();
      if (this.stack.length) this.close();
      else if (g.mode === 'fly') this.openPause();
      return;
    }

    // While a panel is up it owns the keyboard: a letter is not a shortcut.
    if (this.stack.length) return;

    if (g.mode === 'title') {
      if (e.code === 'Enter') { e.preventDefault(); this.titleAction('fly'); }
      if (e.code === 'KeyM') this.titleAction('map');
      if (e.code === 'KeyS') this.titleAction('settings');
      if (e.code === 'KeyC') this.titleAction('challenges');
      if (e.code === 'KeyT') this.titleAction('tutorial');
      if (e.code === 'KeyR') this.titleAction('race');
      if (e.code === 'KeyB') this.titleAction('shop');
      if (e.code === 'KeyX') this.titleAction('stats');
      return;
    }

    if (e.code === 'KeyM' && !this.stack.length) {
      e.preventDefault();
      this.openMap();
    }
  }

  titleAction(act) {
    const g = this.game;
    switch (act) {
      case 'fly': {
        document.getElementById('title').classList.add('hidden');
        g.launch(g.startPoi, 'cliff');
        setTimeout(() => g.input.requestLock(document.getElementById('view')), 60);
        break;
      }
      case 'tutorial':
        document.getElementById('title').classList.add('hidden');
        g.startTutorial?.();
        if (!g.startTutorial) g.launch(g.pois.find((p) => p.name === 'West Shoulder') || g.startPoi, 'cliff');
        break;
      case 'map': this.openMap(true); break;
      case 'settings': this.openSettings(); break;
      case 'challenges': this.openChallenges(); break;
      case 'shop': this.openShop(); break;
      case 'stats': this.openStats(); break;
      case 'race': this.openRaces(); break;
    }
  }

  // --------------------------------------------------------------- overlays

  /** The title screen is a backdrop, not something to read a panel through. */
  syncTitle() {
    const t = document.getElementById('title');
    if (!t) return;
    if (this.stack.length) {
      if (!t.classList.contains('hidden')) {
        this._titleWasUp = true;
        t.classList.add('hidden');
      }
    } else if (this._titleWasUp) {
      this._titleWasUp = false;
      if (this.game.mode === 'title') t.classList.remove('hidden');
    }
  }

  open(node, id) {
    const o = el('div', 'overlay');
    o.id = id || '';
    o.appendChild(node);
    // A close control pinned to the corner. Panels can be long, and having
    // to scroll to the bottom of the shop to get out of it is daft.
    const x = el('button', 'overlay-x', '×');
    x.title = 'Close (Esc)';
    x.onclick = (e) => { e.stopPropagation(); this.close(); };
    o.appendChild(x);
    o.addEventListener('mousedown', (e) => { if (e.target === o) this.close(); });
    host().appendChild(o);
    this.stack.push(o);
    this.syncTitle();
    this.game.setPaused(true);
    return o;
  }

  close() {
    const o = this.stack.pop();
    if (o) o.remove();
    this.syncTitle();
    if (!this.stack.length) {
      this.game.setPaused(false);
      if (this.game.mode === 'fly') {
        this.game.input.requestLock(document.getElementById('view'));
      }
    }
  }

  closeAll() {
    while (this.stack.length) this.stack.pop().remove();
    this.syncTitle();
    this.game.setPaused(false);
  }

  // ------------------------------------------------------------------ pause

  openPause() {
    const g = this.game;
    const p = el('div', 'panel');
    p.appendChild(el('h2', '', 'Paused'));
    const s = g.scoring;
    p.appendChild(el('div', 'kv', `
      <div class="k">Score</div><div class="v">${formatNumber(s.score)}</div>
      <div class="k">Air time</div><div class="v">${formatTime(s.runTime)}</div>
      <div class="k">Distance</div><div class="v">${fmtLong(s.distance)}</div>
      <div class="k">Closest pass</div><div class="v">${s.closest < 99 ? fmtShort(s.closest) : '—'}</div>
      <div class="k">Top speed</div><div class="v">${fmtSpeed(s.topSpeed)}</div>`));

    // --- world controls, right here: this is what people open the menu for
    p.appendChild(el('h3', '', 'World'));
    const todRow = el('div', 'row');
    todRow.appendChild(el('label', '', 'Time of day'));
    const tod = document.createElement('input');
    tod.type = 'range'; tod.min = 0; tod.max = 24; tod.step = 0.1; tod.value = g.time;
    const todVal = el('span', 'val', clockLabel(g.time));
    tod.oninput = () => {
      g.time = Number(tod.value);
      g.save.settings.timeOfDay = g.time;
      g.save.touch();
      todVal.textContent = clockLabel(g.time);
      g.renderOnce();
    };
    todRow.appendChild(tod); todRow.appendChild(todVal);
    p.appendChild(todRow);

    const autoRow = el('div', 'row');
    autoRow.appendChild(el('label', '', 'Time advances'));
    let auto = g.save.settings.autoTime;
    const autoBtn = el('button', 'btn', auto ? 'On' : 'Off');
    autoBtn.onclick = () => {
      auto = !auto;
      autoBtn.textContent = auto ? 'On' : 'Off';
      g.save.settings.autoTime = auto;
      g.save.touch();
    };
    autoRow.appendChild(autoBtn);
    p.appendChild(autoRow);

    const wRow = el('div', 'row');
    wRow.appendChild(el('label', '', 'Weather'));
    const wSel = document.createElement('select');
    for (const k of Object.keys(WEATHER)) {
      const o = document.createElement('option');
      o.value = k; o.textContent = WEATHER[k].name;
      if (k === g.weatherKey) o.selected = true;
      wSel.appendChild(o);
    }
    wSel.onchange = () => {
      g.weatherKey = wSel.value;
      g.save.settings.weather = wSel.value;
      g.save.touch();
      g.renderOnce();
    };
    wRow.appendChild(wSel);
    p.appendChild(wRow);

    const presets = el('div', 'btnrow');
    for (const [name, t] of [['Dawn', 6.4], ['Morning', 9.0], ['Noon', 12.5], ['Golden', 17.2], ['Dusk', 18.6], ['Night', 22.0]]) {
      const b = el('button', 'btn', name);
      b.onclick = () => {
        g.time = t;
        g.save.settings.timeOfDay = t;
        g.save.touch();
        tod.value = t;
        todVal.textContent = clockLabel(t);
        g.renderOnce();
      };
      presets.appendChild(b);
    }
    p.appendChild(presets);

    const row = el('div', 'btnrow');
    const btn = (label, fn, cls) => {
      const b = el('button', 'btn ' + (cls || ''), label);
      b.onclick = fn;
      row.appendChild(b);
      return b;
    };
    btn('Resume', () => this.close(), 'primary');
    btn('Retry line', () => { this.closeAll(); g.retry(); });
    btn('Home', () => {
      this.closeAll();
      g.toTitle();
    });
    btn('World map', () => this.openMap());
    btn('Challenges', () => this.openChallenges());
    btn('Settings', () => this.openSettings());
    btn('Bank run', () => {
      const r = g.scoring.bankRun();
      if (r) g.hud.toast('BANKED ' + formatNumber(r.score));
    });
    p.appendChild(row);
    p.appendChild(el('div', 'muted', 'Esc or Tab closes this. M opens the map in flight.'));
    this.open(p, 'pause');
  }

  // -------------------------------------------------------------------- map

  openMap(fromTitle = false) {
    const g = this.game;
    if (!this.map) {
      this.map = new WorldMap(g);
      this.map.onSelect = () => this.refreshMapSide();
    }
    this.map.draw();

    const p = el('div', 'panel');
    p.appendChild(el('h2', '', 'World map'));
    const wrap = el('div');
    wrap.id = 'mapWrap';
    wrap.appendChild(this.map.canvas);
    const side = el('div');
    side.id = 'mapSide';
    wrap.appendChild(side);
    p.appendChild(wrap);
    this.mapSide = side;
    this.mapFromTitle = fromTitle;
    this.refreshMapSide();

    const row = el('div', 'btnrow');
    const close = el('button', 'btn', fromTitle ? 'Back' : 'Close');
    close.onclick = () => this.close();
    row.appendChild(close);
    p.appendChild(row);
    this.open(p, 'map');
    this._mapTimer = setInterval(() => { if (this.map) this.map.draw(); }, 250);
    const o = this.stack[this.stack.length - 1];
    o.addEventListener('DOMNodeRemoved', () => clearInterval(this._mapTimer));
  }

  refreshMapSide() {
    const g = this.game;
    const side = this.mapSide;
    if (!side) return;
    side.innerHTML = '';
    const sel = this.map.selected;

    side.appendChild(el('h3', '', 'Selection'));
    if (!sel) {
      side.appendChild(el('div', 'muted', 'Click the map or a marker to pick a place to launch from.'));
    } else {
      side.appendChild(el('div', 'kv', `
        <div class="k">${sel.name}</div><div class="v">${Math.round(sel.y)} m</div>
        ${sel.note ? `<div class="k" style="grid-column:1/3">${sel.note}</div>` : ''}
        ${sel.drop ? `<div class="k">Face drop</div><div class="v">${Math.round(sel.drop)} m</div>` : ''}`));

      side.appendChild(el('h3', '', 'Launch'));
      const modes = [
        ['cliff', 'Cliff jump', 'Stand on the edge and go'],
        ['hot', 'Hot start', 'Already at 190 km/h'],
        ['heli', 'Helicopter drop', '600 m above the ground'],
      ];
      for (const [k, label, note] of modes) {
        const b = el('button', 'pill' + (this.launchMode === k ? ' on' : ''), `${label}<small>${note}</small>`);
        b.onclick = () => { this.launchMode = k; this.refreshMapSide(); };
        side.appendChild(b);
      }
      const go = el('button', 'btn primary', 'Teleport and fly');
      go.style.marginTop = '10px';
      go.onclick = () => {
        this.closeAll();
        document.getElementById('title').classList.add('hidden');
        g.launch(sel, this.launchMode);
        setTimeout(() => g.input.requestLock(document.getElementById('view')), 60);
      };
      side.appendChild(go);
    }

    side.appendChild(el('h3', '', `Respawn points (${g.save.data.spawns.length})`));
    if (!g.save.data.spawns.length) {
      side.appendChild(el('div', 'muted', 'Press B in flight to drop one.'));
    }
    g.save.data.spawns.forEach((sp, i) => {
      const b = el('button', 'pill' + (g.save.data.activeSpawn === i ? ' on' : ''),
        `${sp.name}<small>${Math.round(sp.y)} m</small>`);
      b.onclick = () => { g.save.data.activeSpawn = i; g.save.touch(); this.refreshMapSide(); this.map.draw(); };
      const del = el('span', '', ' ✕');
      del.style.cssText = 'float:right;color:#ff6b6b;cursor:pointer';
      del.onclick = (e) => { e.stopPropagation(); g.save.removeSpawn(i); this.refreshMapSide(); this.map.draw(); };
      b.appendChild(del);
      side.appendChild(b);
    });
  }

  // --------------------------------------------------------------- settings

  openSettings() {
    const g = this.game;
    const st = g.save.settings;
    const p = el('div', 'panel');
    p.appendChild(el('h2', '', 'Settings'));

    const tabs = el('div', 'tabs');
    const body = el('div');
    const pages = {};
    const mk = (name) => {
      const b = el('button', '', name);
      const page = el('div');
      pages[name] = page;
      b.onclick = () => {
        tabs.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        body.innerHTML = '';
        body.appendChild(page);
      };
      tabs.appendChild(b);
      return page;
    };

    const gfx = mk('Graphics');
    const aud = mk('Audio');
    const ctl = mk('Controls');
    const wld = mk('World');
    const dat = mk('Data');

    const slider = (parent, label, value, min, max, step, fn, fmt) => {
      const r = el('div', 'row');
      r.appendChild(el('label', '', label));
      const i = document.createElement('input');
      i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = value;
      const v = el('span', 'val', fmt ? fmt(value) : value);
      i.oninput = () => { const n = Number(i.value); v.textContent = fmt ? fmt(n) : n; fn(n); };
      r.appendChild(i); r.appendChild(v);
      parent.appendChild(r);
    };
    const toggle = (parent, label, value, fn) => {
      const r = el('div', 'row');
      r.appendChild(el('label', '', label));
      const b = el('button', 'btn', value ? 'On' : 'Off');
      b.onclick = () => { value = !value; b.textContent = value ? 'On' : 'Off'; fn(value); };
      r.appendChild(b);
      parent.appendChild(r);
    };
    const choice = (parent, label, options, value, fn) => {
      const r = el('div', 'row');
      r.appendChild(el('label', '', label));
      const s = document.createElement('select');
      for (const o of options) {
        const op = document.createElement('option');
        op.value = o; op.textContent = o;
        if (o === value) op.selected = true;
        s.appendChild(op);
      }
      s.onchange = () => fn(s.value);
      r.appendChild(s);
      parent.appendChild(r);
    };

    choice(gfx, 'Quality preset', ['low', 'medium', 'high', 'ultra'], st.quality, (v) => {
      st.quality = v; g.save.touch();
      g.hud.toast('Quality: ' + v + ' — reload to apply fully');
      g.applyQuality?.(v);
    });
    slider(gfx, 'Render scale', st.renderScale, 0.5, 1.3, 0.05, (v) => {
      st.renderScale = v; g.save.touch(); g.onResize();
    }, (v) => v.toFixed(2) + 'x');
    choice(gfx, 'Units', ['imperial', 'metric'], st.units, (v) => {
      st.units = v; setUnits(v); g.save.touch();
    });
    toggle(gfx, 'FPS counter', st.showFps, (v) => { st.showFps = v; g.save.touch(); });
    toggle(gfx, 'HUD', st.showHud, (v) => { st.showHud = v; g.hud.setVisible(v); g.save.touch(); });
    toggle(gfx, 'Airflow visualisation', st.showAirflow, (v) => { st.showAirflow = v; g.save.touch(); });

    slider(aud, 'Master', st.masterVolume, 0, 1, 0.02, (v) => { st.masterVolume = v; g.audio?.setVolumes(st); g.save.touch(); }, (v) => Math.round(v * 100) + '%');
    slider(aud, 'Music', st.musicVolume, 0, 1, 0.02, (v) => { st.musicVolume = v; g.audio?.setVolumes(st); g.save.touch(); }, (v) => Math.round(v * 100) + '%');
    slider(aud, 'Effects', st.sfxVolume, 0, 1, 0.02, (v) => { st.sfxVolume = v; g.audio?.setVolumes(st); g.save.touch(); }, (v) => Math.round(v * 100) + '%');

    slider(ctl, 'Mouse sensitivity', st.mouseSensitivity, 0, 3, 0.05, (v) => { st.mouseSensitivity = v; g.save.touch(); }, (v) => v.toFixed(2));
    toggle(ctl, 'Invert mouse Y', st.invertY, (v) => { st.invertY = v; g.input.mouse.invertY = v; g.save.touch(); });
    ctl.appendChild(el('h3', '', 'Key bindings'));
    const groups = {};
    for (const a in ACTIONS) {
      const grp = ACTIONS[a].group;
      if (!groups[grp]) {
        groups[grp] = el('div');
        ctl.appendChild(el('h3', '', grp));
        ctl.appendChild(groups[grp]);
      }
      const r = el('div', 'row');
      r.appendChild(el('label', '', ACTIONS[a].label));
      const b = el('button', 'btn', keyLabel(g.input.binds[a] && g.input.binds[a][0]));
      b.onclick = () => {
        b.textContent = 'press a key…';
        g.input.capture = (code) => {
          g.input.setBind(a, 0, code);
          b.textContent = keyLabel(code);
          g.save.data.binds = g.input.binds;
          g.save.touch();
        };
      };
      r.appendChild(b);
      groups[grp].appendChild(r);
    }
    const reset = el('button', 'btn', 'Reset bindings');
    reset.onclick = () => {
      g.input.resetBinds();
      g.save.data.binds = null;
      g.save.touch();
      this.close();
      this.openSettings();
    };
    ctl.appendChild(reset);

    slider(wld, 'Time of day', g.time, 0, 24, 0.1, (v) => { g.time = v; st.timeOfDay = v; g.save.touch(); }, (v) => {
      const h = Math.floor(v); const m = Math.floor((v - h) * 60);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    });
    toggle(wld, 'Time advances', st.autoTime, (v) => { st.autoTime = v; g.save.touch(); });
    choice(wld, 'Weather', Object.keys(WEATHER), g.weatherKey, (v) => {
      g.weatherKey = v; st.weather = v; g.save.touch();
    });
    const seedRow = el('div', 'row');
    seedRow.appendChild(el('label', '', 'World seed'));
    const seedIn = document.createElement('input');
    seedIn.type = 'text';
    seedIn.value = g.save.data.seed;
    seedRow.appendChild(seedIn);
    wld.appendChild(seedRow);
    const seedBtn = el('button', 'btn', 'Generate new world');
    seedBtn.onclick = () => {
      g.save.data.seed = seedIn.value || 'skyline';
      g.save.flush();
      location.reload();
    };
    wld.appendChild(seedBtn);

    dat.appendChild(el('div', 'muted', 'Respawn points, records and settings live in this browser. Copy the string below to move them, or paste one in and import.'));
    const ta = document.createElement('textarea');
    ta.style.cssText = 'width:100%;height:110px;background:rgba(255,255,255,0.05);color:#cfe;border:1px solid rgba(255,255,255,0.1);font-family:var(--mono);font-size:10px;margin-top:10px';
    ta.value = g.save.exportString();
    dat.appendChild(ta);
    const drow = el('div', 'btnrow');
    const imp = el('button', 'btn', 'Import');
    imp.onclick = () => {
      try { g.save.importString(ta.value); g.hud.toast('Imported — reloading'); setTimeout(() => location.reload(), 600); }
      catch (e) { g.hud.toast('Import failed'); }
    };
    const wipe = el('button', 'btn', 'Erase everything');
    wipe.onclick = () => { if (confirm('Erase all saved data?')) { g.save.wipe(); location.reload(); } };
    drow.appendChild(imp); drow.appendChild(wipe);
    dat.appendChild(drow);

    p.appendChild(tabs);
    p.appendChild(body);
    const row = el('div', 'btnrow');
    const close = el('button', 'btn primary', 'Done');
    close.onclick = () => { g.save.flush(); this.close(); };
    row.appendChild(close);
    p.appendChild(row);
    tabs.firstChild.click();
    this.open(p, 'settings');
  }

  // ------------------------------------------------------------- challenges

  /**
   * The shop. Everything in it is cosmetic on purpose: a wingsuit that flew
   * better than another one would make every challenge mean something
   * different depending on what you had bought.
   */
  openShop() {
    const g = this.game;
    const d = g.save.data;
    if (!d.equipped) d.equipped = defaultEquipped();
    const owned = new Set([...FREE_IDS, ...(d.owned || [])]);

    const p = el('div', 'panel shop');
    p.appendChild(el('h2', '', 'Shop'));
    const bal = el('div', 'credits', `${Math.round(d.credits || 0).toLocaleString('en-US')} credits`);
    p.appendChild(bal);
    p.appendChild(el('div', 'muted', 'Credits come from challenges and from racing.'));

    const redraw = () => { this.close(); this.openShop(); };

    for (const cat of CATEGORIES) {
      const items = SHOP.filter((it) => it.cat === cat.key);
      const sec = el('div', 'tier');
      sec.appendChild(el('h3', '', cat.name));
      sec.appendChild(el('div', 'muted', cat.note));
      const grid = el('div', 'shopgrid');
      for (const it of items) {
        const have = owned.has(it.id);
        const on = d.equipped[cat.key] === it.id;
        const card = el('div', 'shopitem' + (on ? ' on' : '') + (have ? '' : ' locked'));

        const sw = el('div', 'swatch');
        const a = it.fabric || it.suit || it.helmet || it.trail || [0.5, 0.5, 0.5];
        const b = it.accent || it.boots || it.visor || it.shift || a;
        const rgb = (c) => `rgb(${Math.round(Math.sqrt(c[0]) * 255)},${Math.round(Math.sqrt(c[1]) * 255)},${Math.round(Math.sqrt(c[2]) * 255)})`;
        sw.style.background = `linear-gradient(135deg, ${rgb(a)} 0 62%, ${rgb(b)} 62% 100%)`;
        card.appendChild(sw);

        card.appendChild(el('div', 'iname', it.name));
        card.appendChild(el('div', 'inote', it.note));
        const btn = el('button', 'btn small' + (on ? '' : ' primary'));
        if (on) { btn.textContent = 'Worn'; btn.disabled = true; }
        else if (have) {
          btn.textContent = 'Wear';
          btn.onclick = () => {
            d.equipped[cat.key] = it.id;
            g.save.touch();
            g.save.flush();
            g.applyCosmetics();
            redraw();
          };
        } else {
          btn.textContent = `${it.price.toLocaleString('en-US')} cr`;
          const afford = (d.credits || 0) >= it.price;
          btn.disabled = !afford;
          if (!afford) btn.classList.remove('primary');
          btn.onclick = () => {
            if ((d.credits || 0) < it.price) return;
            d.credits -= it.price;
            d.owned = [...(d.owned || []), it.id];
            d.equipped[cat.key] = it.id;
            g.save.touch();
            g.save.flush();
            g.applyCosmetics();
            redraw();
          };
        }
        card.appendChild(btn);
        grid.appendChild(card);
      }
      sec.appendChild(grid);
      p.appendChild(sec);
    }

    const row = el('div', 'btnrow');
    const close = el('button', 'btn primary', 'Close');
    close.onclick = () => this.close();
    row.appendChild(close);
    p.appendChild(row);
    this.open(p, 'shop');
  }

  /**
   * Racing. Pick a line, then either fly it against the clock or put bots
   * on it. The bots run the course line at a pace rather than flying it,
   * which is what makes them a time you can see rather than an AI that
   * crashes into the hill and spoils the race.
   */
  openRaces() {
    const g = this.game;
    const p = el('div', 'panel races');
    p.appendChild(el('h2', '', 'Racing'));
    p.appendChild(el('div', 'muted',
      'Fifteen lines through the range, all of them steep. Beat the clock, or pick who to beat.'));

    const courses = g.courses || [];
    if (!courses.length) {
      p.appendChild(el('div', 'muted', 'No courses were built for this seed.'));
    }

    const best = g.save.data.raceBest || {};
    for (const c of courses) {
      const row = el('div', 'racerow');
      const left = el('div', 'rinfo');
      left.appendChild(el('div', 'rtitle', c.name));
      const b = best[c.id];
      left.appendChild(el('div', 'muted',
        `${c.rings.length} rings  ·  ${(c.length / 1000).toFixed(2)} km  ·  par ${c.par.toFixed(1)} s`
        + (b !== undefined ? `  ·  best ${b.toFixed(2)} s` : '')));
      row.appendChild(left);

      const btns = el('div', 'rbtns');
      const tt = el('button', 'btn small primary', 'Time trial');
      tt.onclick = () => { this.closeAll(); g.startRace(c, []); };
      btns.appendChild(tt);
      for (const d of DIFFICULTIES) {
        const bt = el('button', 'btn small', d.name);
        bt.title = `Bot time ${(c.par / d.pace).toFixed(1)} s`;
        bt.onclick = () => { this.closeAll(); g.startRace(c, [d.key]); };
        btns.appendChild(bt);
      }
      const all = el('button', 'btn small', 'Full field');
      all.onclick = () => {
        this.closeAll();
        g.startRace(c, DIFFICULTIES.map((d) => d.key));
      };
      btns.appendChild(all);
      row.appendChild(btns);
      p.appendChild(row);
    }

    const row = el('div', 'btnrow');
    const close = el('button', 'btn primary', 'Close');
    close.onclick = () => this.close();
    row.appendChild(close);
    p.appendChild(row);
    this.open(p, 'races');
  }

  /** Everything you have done, since the first run. */
  openStats() {
    const g = this.game;
    const L = g.save.data.lifetime;
    const d = g.save.data;
    const p = el('div', 'panel');
    p.appendChild(el('h2', '', 'Stats'));

    const owned = (d.owned || []).length;
    const chal = Object.keys(d.challenges || {}).filter((k) => d.challenges[k]).length;
    const hrs = (L.time || 0) / 3600;

    const block = (title, rows) => {
      p.appendChild(el('h3', '', title));
      p.appendChild(el('div', 'kv', rows.map(
        ([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`,
      ).join('')));
    };

    block('Flying', [
      ['Runs', formatNumber(L.runs || 0)],
      ['Time in the air', hrs >= 1 ? `${hrs.toFixed(1)} h` : formatTime(L.time || 0)],
      ['Distance flown', fmtLong(L.distance || 0)],
      ['Vertical descended', `${Math.round((L.descended || 0)).toLocaleString('en-US')} m`],
      ['Top speed', fmtSpeed(L.topSpeed || 0)],
      ['Highest point', `${((L.maxAltitude || 0) / 1000).toFixed(2)} km`],
      ['Best glide held', (L.bestGlide || 0) > 0 ? `${L.bestGlide.toFixed(2)} : 1` : '—'],
      ['Closest pass', (L.closest || 999) < 99 ? fmtShort(L.closest) : '—'],
    ]);

    block('Tricks', [
      ['Tricks landed', formatNumber(L.tricks || 0)],
      ['Barrel rolls', formatNumber(L.rolls || 0)],
      ['Flips', formatNumber(L.flips || 0)],
      ['Helicopters', formatNumber(L.helis || 0)],
      ['Corkscrews', formatNumber(L.corks || 0)],
      ['Most rotations in one trick', formatNumber(L.maxRevs || 0)],
    ]);

    block('The mountain', [
      ['Gaps threaded', formatNumber(L.gaps || 0)],
      ['Arches flown', formatNumber(L.arches || 0)],
      ['Caves run', formatNumber(L.caves || 0)],
      ['Water skims', formatNumber(L.skims || 0)],
      ['Longest skim', `${(L.longestSkim || 0).toFixed(1)} s`],
      ['Flown through mist', formatNumber(L.mists || 0)],
    ]);

    block('Endings', [
      ['Landings', formatNumber(L.landings || 0)],
      ['Perfect landings', formatNumber(L.perfectLandings || 0)],
      ['Crashes', formatNumber(L.crashes || 0)],
    ]);

    block('Scoring', [
      ['Lifetime score', formatNumber(L.score || 0)],
      ['Best single run', formatNumber(L.best || 0)],
      ['Challenges complete', `${chal} / ${CHALLENGES.length}`],
      ['Credits', formatNumber(d.credits || 0)],
      ['Shop items owned', `${owned} / ${SHOP.filter((i) => i.price > 0).length}`],
    ]);

    const row = el('div', 'btnrow');
    const close = el('button', 'btn primary', 'Close');
    close.onclick = () => this.close();
    row.appendChild(close);
    p.appendChild(row);
    this.open(p, 'stats');
  }

  openChallenges() {
    const g = this.game;
    const p = el('div', 'panel');
    p.appendChild(el('h2', '', 'Challenges'));
    const done = Object.keys(g.save.data.challenges).filter((k) => g.save.data.challenges[k]).length;
    p.appendChild(el('div', 'muted', `${done} of ${CHALLENGES.length} complete`));

    for (const tier of TIERS) {
      const list = CHALLENGES.filter((c) => c.tier === tier.key);
      if (!list.length) continue;
      const sec = el('div', 'tier');
      sec.appendChild(el('h3', '', `${tier.name} — ${list.filter((c) => g.save.data.challenges[c.id]).length}/${list.length}`));
      const grid = el('div', 'chal');
      for (const c of list) {
        const okd = !!g.save.data.challenges[c.id];
        const best = g.save.data.records[c.id];
        grid.appendChild(el('div', 'name' + (okd ? ' done' : ''), (okd ? '✓ ' : '· ') + c.name));
        grid.appendChild(el('div', 'tgt', c.targetLabel));
        grid.appendChild(el('div', 'bestv', best !== undefined ? c.fmt(best) : '—'));
      }
      sec.appendChild(grid);
      p.appendChild(sec);
    }
    const row = el('div', 'btnrow');
    const close = el('button', 'btn primary', 'Close');
    close.onclick = () => this.close();
    row.appendChild(close);
    p.appendChild(row);
    this.open(p, 'challenges');
  }

  // ---------------------------------------------------------------- results

  showResults(s) {
    if (!s) return;
    const g = this.game;
    const newly = evaluateRun(s, g.save);
    const p = el('div', 'panel');
    p.appendChild(el('h2', '', 'Run complete'));
    p.appendChild(el('div', 'grade', s.landingGrade || 'NO LANDING'));
    p.appendChild(el('div', 'big', formatNumber(s.score)));
    p.appendChild(el('div', 'kv', `
      <div class="k">Air time</div><div class="v">${formatTime(s.time)}</div>
      <div class="k">Distance</div><div class="v">${fmtLong(s.distance)}</div>
      <div class="k">Top speed</div><div class="v">${fmtSpeed(s.topSpeed)}</div>
      <div class="k">Closest pass</div><div class="v">${s.closest < 99 ? fmtShort(s.closest) : '—'}</div>
      <div class="k">Tricks</div><div class="v">${s.tricks}</div>
      <div class="k">Peak multiplier</div><div class="v">x${s.peakMultiplier.toFixed(1)}</div>
      <div class="k">Proximity time</div><div class="v">${s.proximityTime.toFixed(1)} s</div>`));

    if (newly.length) {
      const earned = newly.reduce((t, c) => t + (c.purse || 0), 0);
      p.appendChild(el('h3', '', `Challenges completed  ·  +${earned.toLocaleString('en-US')} credits`));
      for (const c of newly) {
        p.appendChild(el('div', 'muted', `✓ ${c.name}   +${(c.purse || 0).toLocaleString('en-US')} cr`));
      }
    }

    const row = el('div', 'btnrow');
    const again = el('button', 'btn primary', 'Retry this line');
    again.onclick = () => { this.closeAll(); g.retry(); };
    const map = el('button', 'btn', 'World map');
    map.onclick = () => { this.closeAll(); this.openMap(); };
    const title = el('button', 'btn', 'Home');
    title.onclick = () => { this.closeAll(); g.toTitle(); };
    row.appendChild(again); row.appendChild(map); row.appendChild(title);
    p.appendChild(row);
    this.open(p, 'results');
  }
}

export function attachUI(game) {
  return new UI(game);
}
