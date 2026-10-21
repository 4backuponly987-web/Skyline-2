// The reserve: a seven-cell ram-air canopy.
//
// Built the same way as everything else here, out of nothing but numbers. The
// shape is a cambered sheet swept round a shallow anhedral arc, which is what
// a square parachute actually is, plus a line set down to the pilot's
// shoulders. It inflates from a bundle over about a second, breathes while it
// flies, and banks when you steer.

import * as THREE from 'three';

const SPAN = 14;          // segments across
const CHORD = 8;          // segments fore and aft
const WIDTH = 7.4;        // metres, tip to tip
const DEPTH = 2.8;        // metres, leading to trailing edge
const ARC = 0.52;         // radians of anhedral at the tips
const RISER = 6.4;        // line length

export class Canopy {
  constructor(fabricMaterial, lineMaterial) {
    this.group = new THREE.Group();
    this.group.visible = false;

    // --- the wing -------------------------------------------------------
    const verts = SPAN * CHORD;
    this.pos = new Float32Array(verts * 3);
    this.nrm = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const idx = [];
    for (let j = 0; j < CHORD - 1; j++) {
      for (let i = 0; i < SPAN - 1; i++) {
        const a = j * SPAN + i;
        idx.push(a, a + SPAN, a + 1, a + 1, a + SPAN, a + SPAN + 1);
      }
    }
    for (let j = 0; j < CHORD; j++) {
      for (let i = 0; i < SPAN; i++) {
        const k = (j * SPAN + i) * 2;
        uv[k] = i / (SPAN - 1);
        uv[k + 1] = j / (CHORD - 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, fabricMaterial);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    // --- the lines ------------------------------------------------------
    // Four cascades a side, each running from the canopy down to a riser.
    this.lineCount = 10;
    this.linePos = new Float32Array(this.lineCount * 2 * 3);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3));
    this.lineGeo = lg;
    this.lines = new THREE.LineSegments(lg, lineMaterial);
    this.lines.frustumCulled = false;
    this.group.add(this.lines);

    this.time = 0;
    this.inflation = 0;
    this.bank = 0;
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} pilotPos
   * @param {number} heading   where the pilot is pointing, radians
   * @param {number} inflation 0 packed, 1 flying
   * @param {number} bank      -1..1 steering
   * @param {number} flare     0..1, both brakes down
   */
  update(dt, pilotPos, heading, inflation, bank, flare) {
    this.time += dt;
    this.inflation = inflation;
    this.bank += (bank - this.bank) * Math.min(1, dt * 4);

    const vis = inflation > 0.01;
    this.group.visible = vis;
    if (!vis) return;

    // The canopy flies level and the pilot swings under it, so it takes the
    // heading but not the body's pitch or roll.
    this._e.set(0, heading, this.bank * 0.38, 'YXZ');
    this._q.setFromEuler(this._e);
    this.group.quaternion.copy(this._q);
    this.group.position.copy(pilotPos);

    // Inflation: the cells fill from the middle outwards, and the whole
    // thing climbs away from the pilot as the lines come taut.
    const f = inflation;
    const open = f * f * (3 - 2 * f);
    const rise = RISER * (0.18 + 0.82 * open);
    const span = WIDTH * (0.22 + 0.78 * open);
    const depth = DEPTH * (0.45 + 0.55 * open);
    const breathe = 1 + Math.sin(this.time * 2.3) * 0.016 * open;

    const p = this.pos;
    const n = this.nrm;
    for (let j = 0; j < CHORD; j++) {
      const v = j / (CHORD - 1);
      // a cambered section: thickest a third of the way back
      const camber = Math.sin(Math.PI * Math.min(1, v * 1.08)) * 0.16;
      // brakes pull the tail down
      const brake = flare * Math.max(0, v - 0.55) * 1.4;
      for (let i = 0; i < SPAN; i++) {
        const u = i / (SPAN - 1);
        const a = (u - 0.5) * 2 * ARC;
        const r = span * 0.5 / Math.sin(ARC);
        // tips droop along the arc; the cells ripple while it breathes
        const ripple = Math.sin(u * Math.PI * 7 + this.time * 3.1) * 0.012 * open;
        const x = Math.sin(a) * r;
        const y = (Math.cos(a) - Math.cos(ARC)) * r + (camber + ripple) * depth;
        const z = (v - 0.42) * depth + brake * 0.5;
        const k = (j * SPAN + i) * 3;
        p[k] = x * breathe;
        p[k + 1] = rise + y - brake * depth * 0.5;
        p[k + 2] = z;
        // good enough normals for a thin sheet: straight out of the arc
        n[k] = -Math.sin(a) * 0.35;
        n[k + 1] = 1;
        n[k + 2] = 0;
        const l = Math.hypot(n[k], n[k + 1], n[k + 2]);
        n[k] /= l; n[k + 1] /= l; n[k + 2] /= l;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
    this.geometry.computeBoundingSphere();

    // lines: from evenly spaced points on the canopy down to the shoulders
    const lp = this.linePos;
    for (let i = 0; i < this.lineCount; i++) {
      const side = i < this.lineCount / 2 ? -1 : 1;
      const t = (i % (this.lineCount / 2)) / (this.lineCount / 2 - 1);
      const si = Math.round((0.5 + side * (0.12 + t * 0.36)) * (SPAN - 1));
      const sj = Math.round(t * (CHORD - 1));
      const k = (sj * SPAN + si) * 3;
      const o = i * 6;
      lp[o] = p[k];
      lp[o + 1] = p[k + 1];
      lp[o + 2] = p[k + 2];
      lp[o + 3] = side * 0.22;
      lp[o + 4] = 0.35;
      lp[o + 5] = 0;
    }
    this.lineGeo.attributes.position.needsUpdate = true;
    this.lineGeo.computeBoundingSphere();
  }
}
