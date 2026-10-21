// The HUD. Minimal, fades when you are not doing anything with it, and every
// number is one the player can act on.

import {
  clamp, clamp01, lerp, smoothstep, damp, formatNumber,
  toSpeed, speedLabel, fmtAlt, fmtShort,
} from '../core/math.js';
import { Attitude } from './attitude.js';

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

export class Hud {
  constructor(root, save) {
    this.root = root;
    this.save = save;
    this.visible = true;
    this.idle = 0;
    this.shownScore = 0;
    this.build();
    this.hintTimer = 0;
    this.hintText = '';
    this.toastHost = document.getElementById('toasts');
  }

  build() {
    const r = this.root;
    r.innerHTML = '';

    this.feat = el('div', 'featcue');
    this.feat.innerHTML = '<b class="arrow">&#8593;</b><span class="t"></span>';
    r.appendChild(this.feat);
    this.featArrow = this.feat.querySelector('.arrow');
    this.featText = this.feat.querySelector('.t');

    this.lessonBox = el('div', 'lesson');
    this.lessonBox.innerHTML =
      '<div class="lstep"></div><div class="ltitle"></div>'
      + '<div class="lbody"></div><div class="lhint"></div>';
    r.appendChild(this.lessonBox);
    this.lStep = this.lessonBox.querySelector('.lstep');
    this.lTitle = this.lessonBox.querySelector('.ltitle');
    this.lBody = this.lessonBox.querySelector('.lbody');
    this.lHint = this.lessonBox.querySelector('.lhint');

    this.race = el('div', 'racehud');
    this.race.innerHTML =
      '<div class="rname"></div>'
      + '<div class="rtime"></div>'
      + '<div class="rring"></div>'
      + '<div class="rgap"></div>';
    r.appendChild(this.race);
    this.raceName = this.race.querySelector('.rname');
    this.raceTime = this.race.querySelector('.rtime');
    this.raceRing = this.race.querySelector('.rring');
    this.raceGap = this.race.querySelector('.rgap');

    this.edge = el('div', 'edgecue');
    this.edge.innerHTML = '<b class="arrow">&#8593;</b><span class="t"></span>';
    r.appendChild(this.edge);
    this.edgeArrow = this.edge.querySelector('.arrow');
    this.edgeText = this.edge.querySelector('.t');

    this.flow = el('div', '', '<i></i>');
    this.flow.id = 'flowbar';
    r.appendChild(this.flow);
    this.flowFill = this.flow.firstChild;

    this.bl = el('div', 'corner bl');
    this.bl.innerHTML = `
      <div class="readout"><span class="speed v">0</span><span class="unit">MPH</span></div>
      <div class="row">
        <div><span class="lbl">ALTITUDE</span><span class="num alt">0</span></div>
        <div><span class="lbl">GROUND</span><span class="num agl">0</span></div>
      </div>`;
    r.appendChild(this.bl);
    this.elSpeed = this.bl.querySelector('.speed');
    this.elSpeedUnit = this.bl.querySelector('.unit');
    this.elAlt = this.bl.querySelector('.alt');
    this.elAgl = this.bl.querySelector('.agl');

    this.br = el('div', 'corner br');
    this.br.innerHTML = `
      <div><span class="lbl">GLIDE RATIO</span><span class="num glide">0.0</span></div>
      <div class="stack">
        <div><span class="lbl">VERT</span><span class="num vario">0</span></div>
        <div><span class="lbl">AoA</span><span class="num aoa">0</span></div>
      </div>`;
    r.appendChild(this.br);
    this.elGlide = this.br.querySelector('.glide');
    this.elVario = this.br.querySelector('.vario');
    this.elAoa = this.br.querySelector('.aoa');

    this.tr = el('div', 'corner tr');
    this.tr.innerHTML = `
      <div class="score">0</div>
      <div class="mult">x1.0</div>
      <div class="chain"></div>`;
    r.appendChild(this.tr);
    this.elScore = this.tr.querySelector('.score');
    this.elMult = this.tr.querySelector('.mult');
    this.elChain = this.tr.querySelector('.chain');

    this.shave = el('div');
    this.shave.id = 'shaveWrap';
    this.shave.innerHTML = `
      <div class="track"><i></i></div>
      <div class="cap"><span>CLOSE SHAVE</span><span class="prox">—</span></div>`;
    r.appendChild(this.shave);
    this.shaveFill = this.shave.querySelector('i');
    this.elProx = this.shave.querySelector('.prox');

    this.trickNow = el('div');
    this.trickNow.id = 'trickNow';
    r.appendChild(this.trickNow);

    this.feed = el('div');
    this.feed.id = 'feed';
    r.appendChild(this.feed);

    this.hints = el('div');
    this.hints.id = 'hints';
    r.appendChild(this.hints);

    this.vario = el('div', '', '<div class="zero"></div><i></i>');
    this.vario.id = 'vario';
    r.appendChild(this.vario);
    this.varioFill = this.vario.querySelector('i');

    this.fps = el('div');
    this.fps.id = 'fps';
    r.appendChild(this.fps);

    this.attitude = new Attitude(r);
  }

  setVisible(v) {
    this.visible = v;
    this.root.style.display = v ? '' : 'none';
  }

  setAttitudeVisible(v) {
    this.attitude.setVisible(v);
  }

  /** Show a tutorial step. It stays up until the next one replaces it. */
  lesson(n, total, step) {
    if (!step) { this.lessonBox.classList.remove('up'); return; }
    this.lStep.textContent = `Step ${n} of ${total}`;
    this.lTitle.textContent = step.title;
    this.lBody.innerHTML = step.body;
    this.lHint.innerHTML = step.hint;
    this.lessonBox.classList.add('up');
  }

  hideLesson() {
    this.lessonBox.classList.remove('up');
  }

  toast(text, ms = 1900) {
    if (!this.toastHost) return;
    const t = el('div', 'toast', text);
    this.toastHost.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity 320ms';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 340);
    }, ms);
  }

  hint(text, seconds = 4) {
    this.hintText = text;
    this.hintTimer = seconds;
    this.hints.innerHTML = text;
  }

  pushFeed(item) {
    const e = el('div', 'item ' + (item.kind || ''));
    e.innerHTML =
      `<div class="t">${item.text}${item.value ? `<span class="v">+${formatNumber(item.value)}</span>` : ''}</div>` +
      (item.sub ? `<div class="s">${item.sub}</div>` : '');
    this.feed.insertBefore(e, this.feed.firstChild);
    while (this.feed.children.length > 7) this.feed.lastChild.remove();
    e._born = performance.now();
  }

  update(dt, s) {
    // s: {kmh, alt, agl, glide, vario, aoa, score, mult, chain, meter, prox,
    //     trick, flow, fpsText, active}
    this.shownScore = damp(this.shownScore, s.score, 9, dt);

    this.elSpeed.textContent = Math.round(toSpeed(s.speed));
    this.elSpeedUnit.textContent = speedLabel();
    this.elAlt.textContent = fmtAlt(s.alt);
    this.elAgl.textContent = s.agl > 9999 ? '—' : Math.round(s.agl) + ' m';
    this.elGlide.textContent = s.glide > 20 ? '—' : s.glide.toFixed(2);
    this.elVario.textContent = (s.vario >= 0 ? '+' : '') + s.vario.toFixed(0) + ' m/s';
    this.elVario.style.color = s.vario > 0.6 ? 'var(--good)' : (s.vario < -18 ? 'var(--bad)' : '');
    this.elAoa.textContent = s.aoa.toFixed(0) + '°';
    this.elScore.textContent = formatNumber(this.shownScore);
    this.elMult.textContent = 'x' + s.mult.toFixed(1);
    this.elMult.style.opacity = s.mult > 1.05 ? 1 : 0.35;
    this.elChain.textContent = s.chain > 0 ? `FLOW CHAIN  x${s.chain}` : '';

    this.shaveFill.style.right = `${(1 - clamp01(s.meter)) * 100}%`;
    this.elProx.textContent = s.prox < 60 ? fmtShort(s.prox, 0) : '—';
    this.elProx.style.opacity = s.prox < 60 ? 1 : 0.35;

    const vn = clamp(s.vario / 22, -1, 1);
    const h = Math.abs(vn) * 88;
    this.varioFill.style.height = h + 'px';
    this.varioFill.style.top = vn > 0 ? `${90 - h}px` : '90px';
    this.varioFill.style.background = vn > 0 ? 'var(--good)' : 'var(--accent)';

    if (s.trick) {
      this.trickNow.textContent = s.trick;
      this.trickNow.style.opacity = 1;
    } else {
      this.trickNow.style.opacity = 0;
    }

    if (s.feature) {
      this.feat.style.opacity = s.feature.dist < 2400 ? '1' : '0.55';
      this.featArrow.style.transform = `rotate(${s.feature.rel}deg)`;
      this.featText.textContent = `${s.feature.name}  ·  ${Math.round(s.feature.dist)} m`;
    } else this.feat.style.opacity = '0';

    if (s.race) {
      this.race.style.opacity = '1';
      this.raceName.textContent = s.race.name;
      this.raceTime.textContent = s.race.time.toFixed(2);
      this.raceRing.textContent = `RING ${s.race.ring} / ${s.race.of}`
        + (s.race.dist >= 0 ? `  ·  ${Math.round(s.race.dist)} m` : '');
      if (s.race.gap === null || s.race.gap === undefined) {
        this.raceGap.textContent = '';
      } else {
        const g = s.race.gap;
        this.raceGap.textContent = (g >= 0 ? '+' : '') + g.toFixed(1) + ' s';
        this.raceGap.style.color = g >= 0 ? 'var(--good)' : 'var(--bad)';
      }
    } else this.race.style.opacity = '0';

    // On your feet: point at the drop. A summit all looks the same from
    // standing height and the edge is often behind you.
    if (s.edge) {
      this.edge.style.opacity = '1';
      this.edgeArrow.style.transform = `rotate(${s.edge.rel}deg)`;
      this.edgeText.textContent =
        s.edge.dist < 0
          ? 'no big drop nearby — walk on'
          : (s.edge.dist < 9
              ? 'THE EDGE — step off'
              : `edge ${Math.round(s.edge.dist)} m  ·  ${Math.round(s.edge.drop)} m drop`);
      this.edge.classList.toggle('near', s.edge.dist >= 0 && s.edge.dist < 9);
    } else this.edge.style.opacity = '0';

    this.flowFill.style.width = `${clamp01(s.flow) * 100}%`;

    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      this.hints.style.opacity = clamp01(this.hintTimer / 0.6);
    } else this.hints.style.opacity = 0;

    // fade the whole HUD when nothing is happening
    const busy = s.speed > 3.5 || s.mult > 1.05 || s.chain > 0;
    this.idle = busy ? 0 : this.idle + dt;
    this.root.classList.toggle('dim', this.idle > 4);

    if (this.save.settings.showFps && s.fpsText) {
      this.fps.textContent = s.fpsText;
      this.fps.style.display = '';
    } else this.fps.style.display = 'none';

    // age out feed items
    const now = performance.now();
    for (const c of [...this.feed.children]) {
      const age = (now - (c._born || now)) / 1000;
      if (age > 6) c.remove();
      else if (age > 4.4) c.style.opacity = String(1 - (age - 4.4) / 1.6);
    }
  }
}
