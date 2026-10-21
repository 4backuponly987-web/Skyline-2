// Artificial horizon, pitch ladder and flight-path marker.
//
// A wingsuit has a large difference between where the body points and where
// it is actually going, so the important symbol is the flight-path marker:
// the dot sits exactly where you will arrive. The horizon and ladder are
// projected from the real camera, so bank and pitch are always honest.

import * as THREE from 'three';
import { clamp, clamp01, DEG, RAD } from '../core/math.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FAR = 8000;

function mk(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

export class Attitude {
  constructor(root) {
    this.svg = mk('svg', { id: 'attitude', width: '100%', height: '100%' });
    this.svg.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:visible';
    root.appendChild(this.svg);

    // The ladder should read like streaks of wind rather than instrument
    // lines: every stroke runs through a gradient that is transparent at
    // both ends, and the whole group is softened, so the rungs dissolve
    // outwards instead of ending at a hard point.
    const defs = mk('defs', {});
    const grad = mk('linearGradient', {
      id: 'attFade', x1: '0', y1: '0', x2: '1', y2: '0',
    });
    const stops = [
      ['0%', 0], ['14%', 0.22], ['34%', 1], ['66%', 1], ['86%', 0.22], ['100%', 0],
    ];
    for (const [off, o] of stops) {
      grad.appendChild(mk('stop', {
        offset: off, 'stop-color': '#dce9f6', 'stop-opacity': String(o),
      }));
    }
    defs.appendChild(grad);
    const blur = mk('filter', {
      id: 'attSoft', x: '-20%', y: '-200%', width: '140%', height: '500%',
    });
    blur.appendChild(mk('feGaussianBlur', { stdDeviation: '0.65' }));
    defs.appendChild(blur);
    this.svg.appendChild(defs);

    this.horizon = mk('path', { class: 'att-horizon', d: '' });
    this.svg.appendChild(this.horizon);

    this.ladder = mk('g', { class: 'att-ladder', filter: 'url(#attSoft)' });
    this.svg.appendChild(this.ladder);
    this.rungs = [];
    for (let a = -60; a <= 60; a += 10) {
      if (a === 0) continue;
      const g = mk('g', {});
      const l = mk('path', { d: '' });
      const t1 = mk('text', { x: 0, y: 0, 'text-anchor': 'end' });
      const t2 = mk('text', { x: 0, y: 0, 'text-anchor': 'start' });
      t1.textContent = String(Math.abs(a));
      t2.textContent = String(Math.abs(a));
      g.appendChild(l); g.appendChild(t1); g.appendChild(t2);
      this.ladder.appendChild(g);
      this.rungs.push({ angle: a, g, l, t1, t2 });
    }

    this.fpv = mk('g', { class: 'att-fpv' });
    this.fpv.appendChild(mk('circle', { cx: 0, cy: 0, r: 7 }));
    this.fpv.appendChild(mk('path', { d: 'M -7 0 L -16 0 M 7 0 L 16 0 M 0 -7 L 0 -14' }));
    this.svg.appendChild(this.fpv);

    this.climbText = mk('text', { class: 'att-climb', x: 0, y: 0, 'text-anchor': 'start' });
    this.svg.appendChild(this.climbText);

    this.nose = mk('path', { class: 'att-nose', d: '' });
    this.svg.appendChild(this.nose);

    this._v = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this.visible = true;
  }

  setVisible(v) {
    this.svg.style.display = v ? '' : 'none';
    this.visible = v;
  }

  project(camera, v, out) {
    out.copy(v).project(camera);
    const x = (out.x * 0.5 + 0.5) * this.w;
    const y = (-out.y * 0.5 + 0.5) * this.h;
    const ok = Number.isFinite(x) && Number.isFinite(y);
    return { x, y, behind: out.z > 1 || !ok };
  }

  hide() {
    this.horizon.style.display = 'none';
    for (const r of this.rungs) r.g.style.display = 'none';
    this.fpv.style.display = 'none';
    this.climbText.style.display = 'none';
    this.nose.style.display = 'none';
  }

  /**
   * @param {THREE.Camera} camera
   * @param {THREE.Vector3} camPos
   * @param {THREE.Vector3} vel
   * @param {THREE.Vector3} noseDir body forward
   */
  update(camera, camPos, vel, noseDir) {
    if (!this.visible) return;
    const rect = this.svg.getBoundingClientRect();
    this.w = rect.width || window.innerWidth;
    this.h = rect.height || window.innerHeight;
    if (!(this.w > 1) || !(this.h > 1)) return;

    // view azimuth on the horizontal plane
    const f = this._v.set(0, 0, -1).applyQuaternion(camera.quaternion);
    let hx = f.x;
    let hz = f.z;
    const hl = Math.hypot(hx, hz);
    // Looking straight up or straight down leaves no horizontal direction to
    // build the horizon from, and every projected point collapses onto the
    // camera itself (w = 0, so NDC comes back NaN).
    if (!(hl > 1e-3)) {
      this.hide();
      return;
    }
    hx /= hl; hz /= hl;
    const rx = -hz;  // horizontal right of the view direction
    const rz = hx;

    const pt = this._a;
    const scratch = this._b;

    // --- horizon line: two distant points at the camera's altitude --------
    const spread = 0.62;
    const aDir = { x: hx - rx * spread, z: hz - rz * spread };
    const bDir = { x: hx + rx * spread, z: hz + rz * spread };
    const pa = this.project(camera, pt.set(camPos.x + aDir.x * FAR, camPos.y, camPos.z + aDir.z * FAR), scratch);
    const pb = this.project(camera, pt.set(camPos.x + bDir.x * FAR, camPos.y, camPos.z + bDir.z * FAR), scratch);
    if (!pa.behind && !pb.behind) {
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const mxp = (pa.x + pb.x) / 2;
      const myp = (pa.y + pb.y) / 2;
      const half = this.w * 0.26;
      const gap = 26;
      this.horizon.setAttribute('d',
        `M ${mxp - ux * half} ${myp - uy * half} L ${mxp - ux * gap} ${myp - uy * gap}` +
        ` M ${mxp + ux * gap} ${myp + uy * gap} L ${mxp + ux * half} ${myp + uy * half}`);
      this.horizon.style.display = '';

      // --- pitch ladder -------------------------------------------------
      for (const r of this.rungs) {
        const ca = Math.cos(r.angle * DEG);
        const sa = Math.sin(r.angle * DEG);
        const p1 = this.project(camera, pt.set(
          camPos.x + aDir.x * FAR * ca, camPos.y + FAR * sa, camPos.z + aDir.z * FAR * ca), scratch);
        const p2 = this.project(camera, pt.set(
          camPos.x + bDir.x * FAR * ca, camPos.y + FAR * sa, camPos.z + bDir.z * FAR * ca), scratch);
        if (p1.behind || p2.behind) { r.g.style.display = 'none'; continue; }
        const mx2 = (p1.x + p2.x) / 2;
        const my2 = (p1.y + p2.y) / 2;
        if (my2 < -60 || my2 > this.h + 60) { r.g.style.display = 'none'; continue; }
        r.g.style.display = '';
        const ddx = p2.x - p1.x;
        const ddy = p2.y - p1.y;
        const dl = Math.hypot(ddx, ddy) || 1;
        const ex = ddx / dl;
        const ey = ddy / dl;
        const halfR = this.w * 0.085;
        const gapR = 24;
        const dash = r.angle < 0 ? ' ' : '';
        r.l.setAttribute('d',
          `M ${mx2 - ex * halfR} ${my2 - ey * halfR} L ${mx2 - ex * gapR} ${my2 - ey * gapR}` +
          ` M ${mx2 + ex * gapR} ${my2 + ey * gapR} L ${mx2 + ex * halfR} ${my2 + ey * halfR}`);
        r.l.setAttribute('stroke-dasharray', r.angle < 0 ? '7 5' : 'none');
        r.t1.setAttribute('x', mx2 - ex * (halfR + 7));
        r.t1.setAttribute('y', my2 - ey * (halfR + 7) + 4);
        r.t2.setAttribute('x', mx2 + ex * (halfR + 7));
        r.t2.setAttribute('y', my2 + ey * (halfR + 7) + 4);
      }
    } else {
      this.horizon.style.display = 'none';
      for (const r of this.rungs) r.g.style.display = 'none';
    }

    // --- flight path marker ------------------------------------------------
    const speed = vel.length();
    if (speed > 1.5) {
      const d = this._v.copy(vel).multiplyScalar(1 / speed);
      const p = this.project(camera, pt.copy(camPos).addScaledVector(d, 900), scratch);
      if (!p.behind) {
        this.fpv.style.display = '';
        this.fpv.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
        const climb = Math.asin(clamp(vel.y / speed, -1, 1)) * RAD;
        this.climbText.style.display = '';
        this.climbText.setAttribute('x', (p.x + 22).toFixed(1));
        this.climbText.setAttribute('y', (p.y + 4).toFixed(1));
        this.climbText.textContent = `${climb >= 0 ? '+' : ''}${climb.toFixed(0)}°`;
        this.climbText.setAttribute('fill', climb >= -1 ? '#7ee8a8' : (climb < -35 ? '#ff9f6b' : '#cfe0ee'));
      } else {
        this.fpv.style.display = 'none';
        this.climbText.style.display = 'none';
      }
    }

    // --- where the body is pointing (differs from the path at high AoA) ---
    if (noseDir) {
      const p = this.project(camera, pt.copy(camPos).addScaledVector(noseDir, 900), scratch);
      if (!p.behind) {
        this.nose.style.display = '';
        this.nose.setAttribute('d',
          `M ${p.x - 11} ${p.y + 6} L ${p.x} ${p.y - 4} L ${p.x + 11} ${p.y + 6}`);
      } else this.nose.style.display = 'none';
    }
  }
}
