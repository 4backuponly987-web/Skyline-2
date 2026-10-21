// Wing fabric.
//
// Two arm wings (leading edge = the arm, trailing edge = a line from the hand
// back to the hip) and a leg wing between the legs. The mesh is rebuilt every
// frame from the rig's joint world positions, then displaced by:
//   billow   — a bulge proportional to dynamic pressure, flattened by tension
//   ripple   — travelling waves whose wavelength shortens as tension rises
//   luff     — large slow chaotic flapping when the flow separates
//   pop      — an impulse fired when the wings snap open out of a trick
// This is the wingsuit's silhouette, so it carries most of the character read.

import * as THREE from 'three';
import { clamp01, lerp, smoothstep } from '../core/math.js';

const AU = 12; // samples along the arm
const AV = 6;  // samples across the arm wing
const LU = 13; // along the legs
const LV = 8;  // across the leg wing

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();

function catmullV(out, p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  out.x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  out.y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
  out.z = 0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);
  return out;
}

function sampleChain(out, pts, t) {
  const n = pts.length - 1;
  const f = clamp01(t) * n;
  const i = Math.min(n - 1, Math.floor(f));
  const lt = f - i;
  const p0 = pts[Math.max(0, i - 1)];
  const p1 = pts[i];
  const p2 = pts[i + 1];
  const p3 = pts[Math.min(n, i + 2)];
  return catmullV(out, p0, p1, p2, p3, lt);
}

export class Fabric {
  constructor(rig, color = [0.300, 0.322, 0.372], accent = [0.86, 0.32, 0.12]) {
    this.rig = rig;
    this.time = 0;
    this.pressure = 0.5;
    this.tension = 0.4;
    this.luff = 0;
    this.pop = 0;
    this.color = color;
    this.accent = accent;

    const panels = [
      { u: AU, v: AV, side: 1 },
      { u: AU, v: AV, side: -1 },
      { u: LU, v: LV, side: 0 },
    ];
    this.panels = panels;

    let vcount = 0;
    let icount = 0;
    for (const p of panels) {
      vcount += (p.u + 1) * (p.v + 1);
      icount += p.u * p.v * 6;
    }
    this.vcount = vcount;

    const pos = new Float32Array(vcount * 3);
    const nor = new Float32Array(vcount * 3);
    const col = new Float32Array(vcount * 3);
    const idx = new Uint16Array(icount);

    const leadFlags = new Uint8Array(col.length / 3);
    let vo = 0;
    let io = 0;
    for (const p of panels) {
      p.offset = vo;
      for (let j = 0; j <= p.v; j++) {
        for (let i = 0; i <= p.u; i++) {
          const k = vo + j * (p.u + 1) + i;
          // accent stripe along the leading edge
          const lead = j / p.v < 0.22 ? 1 : 0;
          leadFlags[k] = lead;
          const c = lead ? accent : color;
          col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2];
        }
      }
      for (let j = 0; j < p.v; j++) {
        for (let i = 0; i < p.u; i++) {
          const a0 = vo + j * (p.u + 1) + i;
          const a1 = a0 + 1;
          const b0 = a0 + (p.u + 1);
          const b1 = b0 + 1;
          idx[io++] = a0; idx[io++] = b0; idx[io++] = a1;
          idx[io++] = a1; idx[io++] = b0; idx[io++] = b1;
        }
      }
      vo += (p.u + 1) * (p.v + 1);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
    geo.attributes.normal.setUsage(THREE.DynamicDrawUsage);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0.3), 1.8);
    this.geometry = geo;
    this.colBuf = col;
    this.leadFlags = leadFlags;
    this._tmpPts = [];
  }

  /**
   * @param {object} s {pressure 0..1, tension 0..1, luff 0..1, dt}
   */
  update(s, dt) {
    this.time += dt;
    this.pressure = s.pressure;
    this.tension = s.tension;
    this.luff = s.luff;
    this.pop = Math.max(0, this.pop - dt * 3.4);

    const rig = this.rig;
    const pos = this.geometry.attributes.position.array;
    const nor = this.geometry.attributes.normal.array;

    this.buildArm(pos, this.panels[0], 'L');
    this.buildArm(pos, this.panels[1], 'R');
    this.buildLeg(pos, this.panels[2]);
    this.recomputeNormals(pos, nor);

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
  }

  snap(strength = 1) {
    this.pop = Math.min(1.6, this.pop + strength);
  }

  _noise(x, y) {
    // cheap smooth pseudo-noise for ripple phase variation
    return Math.sin(x * 1.7 + Math.sin(y * 2.3) * 1.1) * 0.5 + Math.sin(x * 0.7 - y * 1.3) * 0.5;
  }

  buildArm(pos, panel, side) {
    const rig = this.rig;
    const S = side === 'L' ? 'L' : 'R';
    const sh = rig.get('shoulder' + S).worldPos;
    const el = rig.get('elbow' + S).worldPos;
    const wr = rig.get('wrist' + S).worldPos;
    const hd = rig.get('hand' + S).worldPos;
    const hip = rig.get('thigh' + S).worldPos;
    const chest = rig.get('chest').worldPos;
    const hips = rig.get('hips').worldPos;

    const lead = [sh, el, wr, hd];
    const trailA = _a.copy(sh).lerp(chest, 0.25);
    const trail = [trailA.clone(), hips.clone(), hip.clone()];

    const billowAmt = (0.075 + 0.145 * this.pressure) * (1 - this.tension * 0.62);
    const rippleAmt = (0.004 + 0.021 * this.pressure) * (1 - this.tension * 0.5) + this.luff * 0.065;
    const rippleFreq = lerp(9.0, 22.0, this.tension);
    const popAmt = this.pop * 0.07;

    const U = panel.u;
    const V = panel.v;
    const o = panel.offset;
    const P = _b;
    const T = _c;
    for (let i = 0; i <= U; i++) {
      const u = i / U;
      sampleChain(P, lead, u);
      sampleChain(T, trail, Math.pow(u, 0.86));
      for (let j = 0; j <= V; j++) {
        const v = j / V;
        // v = 0 at the leading edge (the arm), 1 at the trailing edge
        let x = lerp(P.x, T.x, v);
        let y = lerp(P.y, T.y, v);
        let z = lerp(P.z, T.z, v);

        // the wing bulges away from the airflow, i.e. toward the pilot's back
        const up = rig.get('chest').worldQuat;
        _n.set(0, 1, 0).applyQuaternion(up);
        const shape = Math.sin(Math.PI * v) * Math.pow(u, 0.55);
        const t = this.time;
        const wave =
          Math.sin(u * rippleFreq - t * (9.0 + 11.0 * this.pressure) + (S === 'L' ? 0 : 1.9)) *
          Math.sin(v * 3.1);
        const luffw = this.luff * Math.sin(u * 3.3 + t * 3.1) * Math.sin(v * 2.0 + t * 2.3);
        const disp = billowAmt * shape + rippleAmt * wave * v + popAmt * Math.sin(u * 7.0 - t * 26.0) * v + luffw * 0.06;
        x += _n.x * disp;
        y += _n.y * disp;
        z += _n.z * disp;

        const k = (o + j * (U + 1) + i) * 3;
        pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
      }
    }
  }

  buildLeg(pos, panel) {
    const rig = this.rig;
    const hL = rig.get('thighL').worldPos;
    const kL = rig.get('kneeL').worldPos;
    const aL = rig.get('ankleL').worldPos;
    const fL = rig.get('footL').worldPos;
    const hR = rig.get('thighR').worldPos;
    const kR = rig.get('kneeR').worldPos;
    const aR = rig.get('ankleR').worldPos;
    const fR = rig.get('footR').worldPos;
    const hips = rig.get('hips').worldPos;

    const legL = [hips, hL, kL, aL, fL];
    const legR = [hips, hR, kR, aR, fR];

    const billowAmt = (0.065 + 0.155 * this.pressure) * (1 - this.tension * 0.6);
    const rippleAmt = (0.003 + 0.019 * this.pressure) * (1 - this.tension * 0.5) + this.luff * 0.06;
    const rippleFreq = lerp(8.0, 19.0, this.tension);
    const popAmt = this.pop * 0.06;

    const U = panel.u;
    const V = panel.v;
    const o = panel.offset;
    const L = _b;
    const R = _c;
    for (let i = 0; i <= U; i++) {
      const u = i / U;
      sampleChain(L, legL, u);
      sampleChain(R, legR, u);
      for (let j = 0; j <= V; j++) {
        const v = j / V;
        let x = lerp(L.x, R.x, v);
        let y = lerp(L.y, R.y, v);
        let z = lerp(L.z, R.z, v);

        _n.set(0, 1, 0).applyQuaternion(rig.get('hips').worldQuat);
        const shape = Math.sin(Math.PI * v) * Math.pow(u, 0.5);
        const t = this.time;
        const wave = Math.sin(u * rippleFreq - t * (8.0 + 10.0 * this.pressure)) * Math.sin(v * Math.PI);
        const luffw = this.luff * Math.sin(u * 2.8 - t * 2.7) * Math.sin(v * Math.PI);
        const disp = billowAmt * shape + rippleAmt * wave + popAmt * Math.sin(u * 6.0 - t * 24.0) + luffw * 0.07;
        x += _n.x * disp;
        y += _n.y * disp;
        z += _n.z * disp;

        const k = (o + j * (U + 1) + i) * 3;
        pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
      }
    }
  }

  recomputeNormals(pos, nor) {
    for (const p of this.panels) {
      const U = p.u;
      const V = p.v;
      const o = p.offset;
      for (let j = 0; j <= V; j++) {
        for (let i = 0; i <= U; i++) {
          const i0 = Math.max(0, i - 1);
          const i1 = Math.min(U, i + 1);
          const j0 = Math.max(0, j - 1);
          const j1 = Math.min(V, j + 1);
          const ka = (o + j * (U + 1) + i0) * 3;
          const kb = (o + j * (U + 1) + i1) * 3;
          const kc = (o + j0 * (U + 1) + i) * 3;
          const kd = (o + j1 * (U + 1) + i) * 3;
          const ux = pos[kb] - pos[ka], uy = pos[kb + 1] - pos[ka + 1], uz = pos[kb + 2] - pos[ka + 2];
          const vx = pos[kd] - pos[kc], vy = pos[kd + 1] - pos[kc + 1], vz = pos[kd + 2] - pos[kc + 2];
          let nx = uy * vz - uz * vy;
          let ny = uz * vx - ux * vz;
          let nz = ux * vy - uy * vx;
          const il = 1 / (Math.hypot(nx, ny, nz) || 1);
          const k = (o + j * (U + 1) + i) * 3;
          nor[k] = nx * il;
          nor[k + 1] = ny * il;
          nor[k + 2] = nz * il;
        }
      }
    }
  }

  /** World position of a wingtip, for trails and spray. */
  wingtip(side, out) {
    return out.copy(this.rig.get('hand' + side).worldPos);
  }
  /** Repaint the wing: body colour plus the leading-edge accent. */
  recolour(color, accent) {
    this.color = color;
    const f = this.leadFlags;
    const col = this.colBuf;
    for (let i = 0; i < f.length; i++) {
      const c = f[i] ? accent : color;
      col[i * 3] = c[0];
      col[i * 3 + 1] = c[1];
      col[i * 3 + 2] = c[2];
    }
    this.geometry.attributes.color.needsUpdate = true;
  }

}
