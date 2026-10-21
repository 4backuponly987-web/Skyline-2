// The wingsuiter: a procedural skeleton, a procedurally generated body mesh
// and CPU skinning.
//
// CPU skinning rather than THREE.SkinnedMesh because the wing fabric has to be
// rebuilt from bone world positions every frame anyway, and doing both on the
// CPU keeps one source of truth for where the body actually is (wingtip
// effects, contact tests and camera mounts all read the same joint matrices).
// The body is ~1400 vertices, so the cost is well under 0.2 ms.

import * as THREE from 'three';
import { lerp, clamp01 } from '../core/math.js';

// Bind pose, given as WORLD positions in character space: prone, head toward
// -Z, back toward +Y, arms and legs spread. 'L'/'R' are the pilot's own left
// (-X) and right (+X) while lying face down looking along -Z.
export const JOINTS = [
  ['hips', null, 0, 0, 0],
  ['spine', 'hips', 0, 0.012, -0.17],
  ['chest', 'spine', 0, 0.028, -0.34],
  ['neck', 'chest', 0, 0.050, -0.48],
  ['head', 'neck', 0, 0.080, -0.60],
  ['shoulderL', 'chest', -0.168, 0.036, -0.395],
  ['elbowL', 'shoulderL', -0.44, 0.016, -0.262],
  ['wristL', 'elbowL', -0.675, -0.002, -0.100],
  ['handL', 'wristL', -0.775, -0.012, -0.028],
  ['shoulderR', 'chest', 0.168, 0.036, -0.395],
  ['elbowR', 'shoulderR', 0.44, 0.016, -0.262],
  ['wristR', 'elbowR', 0.675, -0.002, -0.100],
  ['handR', 'wristR', 0.775, -0.012, -0.028],
  ['thighL', 'hips', -0.105, 0, 0.035],
  ['kneeL', 'thighL', -0.172, -0.006, 0.445],
  ['ankleL', 'kneeL', -0.238, -0.012, 0.865],
  ['footL', 'ankleL', -0.250, -0.026, 0.985],
  // The container on their back. Prone, "up" is the back, so it sits at +Y.
  ['packLo', 'spine', 0, 0.150, -0.055],
  ['packHi', 'chest', 0, 0.150, -0.330],
  ['thighR', 'hips', 0.105, 0, 0.035],
  ['kneeR', 'thighR', 0.172, -0.006, 0.445],
  ['ankleR', 'kneeR', 0.238, -0.012, 0.865],
  ['footR', 'ankleR', 0.250, -0.026, 0.985],
];

// Limb tubes: [jointA, jointB, radiusA, radiusB, flattenX, flattenY, matId]
const LIMBS = [
  ['hips', 'spine', 0.150, 0.168, 1.45, 0.70, 0],
  ['spine', 'chest', 0.168, 0.158, 1.42, 0.72, 0],
  ['chest', 'neck', 0.150, 0.092, 1.20, 0.82, 0],
  ['neck', 'head', 0.086, 0.100, 1.0, 1.0, 1],
  ['shoulderL', 'elbowL', 0.070, 0.054, 1.0, 0.9, 0],
  ['elbowL', 'wristL', 0.052, 0.042, 1.0, 0.9, 0],
  ['wristL', 'handL', 0.042, 0.032, 1.1, 0.7, 2],
  ['shoulderR', 'elbowR', 0.070, 0.054, 1.0, 0.9, 0],
  ['elbowR', 'wristR', 0.052, 0.042, 1.0, 0.9, 0],
  ['wristR', 'handR', 0.042, 0.032, 1.1, 0.7, 2],
  ['thighL', 'kneeL', 0.098, 0.074, 1.0, 0.95, 0],
  ['kneeL', 'ankleL', 0.072, 0.050, 1.0, 0.95, 0],
  ['ankleL', 'footL', 0.056, 0.044, 1.0, 0.8, 2],
  ['packLo', 'packHi', 0.112, 0.104, 1.55, 0.62, 4],
  ['thighR', 'kneeR', 0.098, 0.074, 1.0, 0.95, 0],
  ['kneeR', 'ankleR', 0.072, 0.050, 1.0, 0.95, 0],
  ['ankleR', 'footR', 0.056, 0.044, 1.0, 0.8, 2],
];

// material ids -> base colours (suit, helmet, trim/boots, visor)
// The body is deliberately darker than the wing fabric: from the chase
// camera what you need to read is the wing shape, with the limbs as a dark
// silhouette inside it.
export const SUIT_COLORS = [
  [0.140, 0.155, 0.190],  // suit
  [0.88, 0.33, 0.13],     // helmet
  [0.085, 0.090, 0.105],  // boots, gloves
  [0.085, 0.130, 0.200],  // visor
  [0.360, 0.380, 0.420],  // container
];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class Joint {
  constructor(name, parent, x, y, z) {
    this.name = name;
    this.parent = parent;
    this.rest = new THREE.Vector3(x, y, z);     // offset from parent
    this.local = new THREE.Quaternion();        // animated rotation
    this.scale = 1;
    this.world = new THREE.Matrix4();
    this.worldPos = new THREE.Vector3();
    this.worldQuat = new THREE.Quaternion();
    this.bindWorld = new THREE.Matrix4();
    this.bindInv = new THREE.Matrix4();
    this.bindPos = new THREE.Vector3();
  }
}

export class Rig {
  constructor() {
    this.joints = [];
    this.byName = new Map();
    const world = new Map();
    for (const [name, parent, x, y, z] of JOINTS) {
      world.set(name, [x, y, z]);
      const pw = parent ? world.get(parent) : [0, 0, 0];
      const j = new Joint(name, parent ? this.byName.get(parent) : null, x - pw[0], y - pw[1], z - pw[2]);
      this.joints.push(j);
      this.byName.set(name, j);
    }
    this.root = new THREE.Object3D();
    this.updateWorld();
    for (const j of this.joints) {
      j.bindWorld.copy(j.world);
      j.bindInv.copy(j.world).invert();
      j.bindPos.setFromMatrixPosition(j.world);
    }
    this.buildBody();
  }

  get(name) {
    return this.byName.get(name);
  }

  updateWorld() {
    for (const j of this.joints) {
      _m.compose(j.rest, j.local, _v.set(j.scale, j.scale, j.scale));
      if (j.parent) j.world.multiplyMatrices(j.parent.world, _m);
      else j.world.copy(_m);
      j.worldPos.setFromMatrixPosition(j.world);
      j.worldQuat.setFromRotationMatrix(j.world);
    }
  }

  resetPose() {
    for (const j of this.joints) j.local.identity();
  }

  // ---------------------------------------------------------------- body ---

  buildBody() {
    const SIDES = 12;
    const positions = [];
    const normals = [];
    const colors = [];
    const slots = [];
    const indices = [];
    const bindPos = [];
    const skinA = [];
    const skinB = [];
    const skinW = [];

    const ringsOf = (a, b, rA, rB, fx, fy, matId, segs) => {
      const A = this.get(a).bindPos;
      const B = this.get(b).bindPos;
      const dir = _v.copy(B).sub(A);
      const len = dir.length();
      if (len < 1e-5) return;
      dir.multiplyScalar(1 / len);
      // frame
      const up = Math.abs(dir.y) > 0.9 ? _v2.set(0, 0, 1) : _v2.set(0, 1, 0);
      const side = new THREE.Vector3().crossVectors(up, dir).normalize();
      const nrm = new THREE.Vector3().crossVectors(dir, side).normalize();
      const start = positions.length / 3;
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const cx = A.x + (B.x - A.x) * t;
        const cy = A.y + (B.y - A.y) * t;
        const cz = A.z + (B.z - A.z) * t;
        const r = lerp(rA, rB, t);
        for (let k = 0; k < SIDES; k++) {
          const ang = (k / SIDES) * Math.PI * 2;
          const ca = Math.cos(ang) * r * fx;
          const sa = Math.sin(ang) * r * fy;
          const px = cx + side.x * ca + nrm.x * sa;
          const py = cy + side.y * ca + nrm.y * sa;
          const pz = cz + side.z * ca + nrm.z * sa;
          positions.push(px, py, pz);
          const nx = side.x * Math.cos(ang) + nrm.x * Math.sin(ang);
          const ny = side.y * Math.cos(ang) + nrm.y * Math.sin(ang);
          const nz = side.z * Math.cos(ang) + nrm.z * Math.sin(ang);
          const il = 1 / (Math.hypot(nx, ny, nz) || 1);
          normals.push(nx * il, ny * il, nz * il);
          const c = SUIT_COLORS[matId];
          colors.push(c[0], c[1], c[2]);
          slots.push(matId);
          bindPos.push(px, py, pz);
        }
      }
      for (let s = 0; s < segs; s++) {
        for (let k = 0; k < SIDES; k++) {
          const k2 = (k + 1) % SIDES;
          const a0 = start + s * SIDES + k;
          const a1 = start + s * SIDES + k2;
          const b0 = start + (s + 1) * SIDES + k;
          const b1 = start + (s + 1) * SIDES + k2;
          indices.push(a0, b0, a1, a1, b0, b1);
        }
      }
    };

    for (const [a, b, rA, rB, fx, fy, matId] of LIMBS) {
      ringsOf(a, b, rA, rB, fx, fy, matId, 5);
    }

    // head + helmet: an ellipsoid around the head joint with a visor band
    {
      const H = this.get('head').bindPos;
      const rows = 9;
      const cols = 12;
      const start = positions.length / 3;
      for (let i = 0; i <= rows; i++) {
        const v = (i / rows) * Math.PI;
        for (let k = 0; k <= cols; k++) {
          const u = (k / cols) * Math.PI * 2;
          const sx = Math.sin(v) * Math.cos(u);
          const sy = Math.cos(v);
          const sz = Math.sin(v) * Math.sin(u);
          const px = H.x + sx * 0.113;
          const py = H.y + sy * 0.108;
          const pz = H.z + sz * 0.128;
          positions.push(px, py, pz);
          normals.push(sx, sy, sz);
          bindPos.push(px, py, pz);
          // visor wraps around the front and sides; dark shell underneath
          const visor = sz < 0.18 && sy < 0.34 && sy > -0.60;
          const under = sy < -0.55;
          const slot = visor ? 3 : (under ? 2 : 1);
          slots.push(slot);
          const c = SUIT_COLORS[slot];
          colors.push(c[0], c[1], c[2]);
        }
      }
      for (let i = 0; i < rows; i++) {
        for (let k = 0; k < cols; k++) {
          const a0 = start + i * (cols + 1) + k;
          const a1 = a0 + 1;
          const b0 = a0 + (cols + 1);
          const b1 = b0 + 1;
          indices.push(a0, b0, a1, a1, b0, b1);
        }
      }
    }

    // Parachute container on the back: a big part of a wingsuiter's
    // silhouette, and it gives the torso something to read against. A
    // rounded shell rather than a brick.
    {
      const C = this.get('chest').bindPos;
      const S = this.get('spine').bindPos;
      const cx = (C.x + S.x) * 0.5;
      const cy = (C.y + S.y) * 0.5 + 0.082;
      const cz = (C.z + S.z) * 0.5 + 0.01;
      const rows = 7;
      const cols = 10;
      const start = positions.length / 3;
      for (let i = 0; i <= rows; i++) {
        const v = (i / rows) * Math.PI;
        for (let k = 0; k <= cols; k++) {
          const u = (k / cols) * Math.PI * 2;
          const sx = Math.sin(v) * Math.cos(u);
          const sy = Math.cos(v);
          const sz = Math.sin(v) * Math.sin(u);
          positions.push(cx + sx * 0.112, cy + sy * 0.052, cz + sz * 0.168);
          normals.push(sx, sy * 1.6, sz * 0.7);
          bindPos.push(cx + sx * 0.112, cy + sy * 0.052, cz + sz * 0.168);
          const slot2 = sy > 0.25 ? 4 : 2;
          slots.push(slot2);
          const c = SUIT_COLORS[slot2];
          colors.push(c[0], c[1], c[2]);
        }
      }
      for (let i = 0; i < rows; i++) {
        for (let k = 0; k < cols; k++) {
          const a0 = start + i * (cols + 1) + k;
          const a1 = a0 + 1;
          const b0 = a0 + (cols + 1);
          const b1 = b0 + 1;
          indices.push(a0, b0, a1, a1, b0, b1);
        }
      }
    }

    // ---- auto skin weights: two nearest bone segments ----
    const segs = [];
    for (const [a, b] of LIMBS) segs.push([this.get(a), this.get(b)]);
    segs.push([this.get('neck'), this.get('head')]);

    const vcount = positions.length / 3;
    for (let i = 0; i < vcount; i++) {
      const px = positions[i * 3];
      const py = positions[i * 3 + 1];
      const pz = positions[i * 3 + 2];
      let b1 = 0, d1 = Infinity, b2 = 0, d2 = Infinity;
      for (let s = 0; s < segs.length; s++) {
        const A = segs[s][0].bindPos;
        const B = segs[s][1].bindPos;
        const abx = B.x - A.x, aby = B.y - A.y, abz = B.z - A.z;
        const l2 = abx * abx + aby * aby + abz * abz;
        let t = l2 > 1e-9 ? ((px - A.x) * abx + (py - A.y) * aby + (pz - A.z) * abz) / l2 : 0;
        t = clamp01(t);
        const cx = A.x + abx * t, cy = A.y + aby * t, cz = A.z + abz * t;
        const d = Math.hypot(px - cx, py - cy, pz - cz);
        // bind to the joint we are closer to along the segment
        const joint = t < 0.5 ? segs[s][0] : segs[s][1];
        const ji = this.joints.indexOf(joint);
        if (d < d1) { d2 = d1; b2 = b1; d1 = d; b1 = ji; }
        else if (d < d2 && ji !== b1) { d2 = d; b2 = ji; }
      }
      const w1 = 1 / Math.pow(d1 + 0.035, 3);
      const w2 = 1 / Math.pow(d2 + 0.035, 3);
      const sum = w1 + w2;
      skinA.push(b1);
      skinB.push(b2);
      skinW.push(w1 / sum);
    }

    this.body = {
      position: new Float32Array(positions),
      normal: new Float32Array(normals),
      color: new Float32Array(colors),
      slot: new Uint8Array(slots),
      index: new Uint16Array(indices),
      bind: new Float32Array(bindPos),
      skinA: new Uint8Array(skinA),
      skinB: new Uint8Array(skinB),
      skinW: new Float32Array(skinW),
      count: vcount,
    };

    // precompute bind-local positions per influencing joint
    this.localA = new Float32Array(vcount * 3);
    this.localB = new Float32Array(vcount * 3);
    this.localNA = new Float32Array(vcount * 3);
    this.localNB = new Float32Array(vcount * 3);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < vcount; i++) {
      const ja = this.joints[skinA[i]];
      const jb = this.joints[skinB[i]];
      tmp.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).applyMatrix4(ja.bindInv);
      this.localA[i * 3] = tmp.x; this.localA[i * 3 + 1] = tmp.y; this.localA[i * 3 + 2] = tmp.z;
      tmp.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).applyMatrix4(jb.bindInv);
      this.localB[i * 3] = tmp.x; this.localB[i * 3 + 1] = tmp.y; this.localB[i * 3 + 2] = tmp.z;
      // normals: rotation-only part of bindInv (bind rotations are identity,
      // so bind-local normals equal the bind normals)
      this.localNA[i * 3] = normals[i * 3];
      this.localNA[i * 3 + 1] = normals[i * 3 + 1];
      this.localNA[i * 3 + 2] = normals[i * 3 + 2];
      this.localNB[i * 3] = normals[i * 3];
      this.localNB[i * 3 + 1] = normals[i * 3 + 1];
      this.localNB[i * 3 + 2] = normals[i * 3 + 2];
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.body.position.slice(), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.body.normal.slice(), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.body.color, 3));
    geo.setIndex(new THREE.BufferAttribute(this.body.index, 1));
    geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
    geo.attributes.normal.setUsage(THREE.DynamicDrawUsage);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0.2), 1.6);
    this.geometry = geo;
  }

  /** Applies the current joint world matrices to the body vertices. */
  skin() {
    const b = this.body;
    const pos = this.geometry.attributes.position.array;
    const nor = this.geometry.attributes.normal.array;
    const joints = this.joints;
    const n = b.count;
    for (let i = 0; i < n; i++) {
      const ja = joints[b.skinA[i]];
      const jb = joints[b.skinB[i]];
      const w = b.skinW[i];
      const iw = 1 - w;
      const ma = ja.world.elements;
      const mb = jb.world.elements;
      const ax = this.localA[i * 3], ay = this.localA[i * 3 + 1], az = this.localA[i * 3 + 2];
      const bx = this.localB[i * 3], by = this.localB[i * 3 + 1], bz = this.localB[i * 3 + 2];
      const pax = ma[0] * ax + ma[4] * ay + ma[8] * az + ma[12];
      const pay = ma[1] * ax + ma[5] * ay + ma[9] * az + ma[13];
      const paz = ma[2] * ax + ma[6] * ay + ma[10] * az + ma[14];
      const pbx = mb[0] * bx + mb[4] * by + mb[8] * bz + mb[12];
      const pby = mb[1] * bx + mb[5] * by + mb[9] * bz + mb[13];
      const pbz = mb[2] * bx + mb[6] * by + mb[10] * bz + mb[14];
      pos[i * 3] = pax * w + pbx * iw;
      pos[i * 3 + 1] = pay * w + pby * iw;
      pos[i * 3 + 2] = paz * w + pbz * iw;

      const nx = this.localNA[i * 3], ny = this.localNA[i * 3 + 1], nz = this.localNA[i * 3 + 2];
      const nax = ma[0] * nx + ma[4] * ny + ma[8] * nz;
      const nay = ma[1] * nx + ma[5] * ny + ma[9] * nz;
      const naz = ma[2] * nx + ma[6] * ny + ma[10] * nz;
      const nbx = mb[0] * nx + mb[4] * ny + mb[8] * nz;
      const nby = mb[1] * nx + mb[5] * ny + mb[9] * nz;
      const nbz = mb[2] * nx + mb[6] * ny + mb[10] * nz;
      let fx = nax * w + nbx * iw;
      let fy = nay * w + nby * iw;
      let fz = naz * w + nbz * iw;
      const il = 1 / (Math.hypot(fx, fy, fz) || 1);
      nor[i * 3] = fx * il;
      nor[i * 3 + 1] = fy * il;
      nor[i * 3 + 2] = fz * il;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
  }
  /**
   * Repaint the body from a palette of [suit, helmet, boots, visor, pack].
   * Every vertex remembers which slot it was built from, so this rewrites
   * the colour attribute rather than rebuilding the mesh.
   */
  recolour(palette) {
    const slot = this.body.slot;
    const col = this.body.color;
    for (let i = 0; i < slot.length; i++) {
      const c = palette[slot[i]] || SUIT_COLORS[slot[i]];
      col[i * 3] = c[0];
      col[i * 3 + 1] = c[1];
      col[i * 3 + 2] = c[2];
    }
    if (this.geometry) this.geometry.attributes.color.needsUpdate = true;
  }

}
