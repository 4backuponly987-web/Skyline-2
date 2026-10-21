// Forests, boulders and the rocky treeline transition.
//
// Placement is deterministic from the world seed: a baked density map decides
// where forest can grow, a spatial hash decides which cells actually hold a
// tree, and 256 m scatter chunks are cached so moving back and forth costs
// nothing. Two instanced LODs (full pine near, simplified cone far) plus
// instanced boulders.

import * as THREE from 'three';
import { WORLD } from './field.js';
import { hash2 } from '../core/rng.js';
import { clamp, clamp01, lerp, smoothstep, sampleGrid } from '../core/math.js';

const CHUNK = 256;
const CELL = 23;
const DENS_RES = 256;

function pineGeometry(detail) {
  const parts = [];
  const push = (geo, color, x, y, z, sx, sy, sz, rot) => {
    geo.rotateY(rot || 0);
    geo.scale(sx, sy, sz);
    geo.translate(x, y, z);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = 0.86 + ((i * 37) % 11) / 38;
      col[i * 3] = color[0] * v;
      col[i * 3 + 1] = color[1] * v;
      col[i * 3 + 2] = color[2] * v;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(geo);
  };

  const trunk = [0.088, 0.070, 0.056];
  const needle = [0.052, 0.088, 0.046];
  const needleHi = [0.078, 0.120, 0.058];

  if (detail === 'near') {
    push(new THREE.CylinderGeometry(0.09, 0.17, 2.4, 6, 1), trunk, 0, 1.2, 0, 1, 1, 1);
    push(new THREE.ConeGeometry(1.5, 3.2, 9, 1), needle, 0, 3.0, 0, 1, 1, 1);
    push(new THREE.ConeGeometry(1.18, 2.9, 9, 1), needle, 0, 4.7, 0, 1, 1, 1, 0.5);
    push(new THREE.ConeGeometry(0.82, 2.5, 8, 1), needleHi, 0, 6.4, 0, 1, 1, 1, 1.1);
    push(new THREE.ConeGeometry(0.44, 1.9, 7, 1), needleHi, 0, 8.0, 0, 1, 1, 1, 1.7);
  } else {
    push(new THREE.CylinderGeometry(0.1, 0.18, 2.2, 4, 1), trunk, 0, 1.1, 0, 1, 1, 1);
    push(new THREE.ConeGeometry(1.45, 6.4, 6, 1), needle, 0, 4.6, 0, 1, 1, 1);
    push(new THREE.ConeGeometry(0.72, 3.0, 5, 1), needleHi, 0, 7.6, 0, 1, 1, 1, 0.8);
  }
  return mergeGeometries(parts);
}

function boulderGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 0.72 + 0.5 * Math.abs(Math.sin(x * 3.1 + y * 2.3) * Math.cos(z * 2.7));
    p.setXYZ(i, x * n, y * n * 0.72, z * n);
  }
  g.computeVertexNormals();
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const v = 0.8 + ((i * 29) % 13) / 46;
    col[i * 3] = 0.19 * v;
    col[i * 3 + 1] = 0.18 * v;
    col[i * 3 + 2] = 0.17 * v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function mergeGeometries(list) {
  let vcount = 0;
  let icount = 0;
  for (const g of list) {
    vcount += g.attributes.position.count;
    icount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vcount * 3);
  const nor = new Float32Array(vcount * 3);
  const col = new Float32Array(vcount * 3);
  const idx = new Uint16Array(icount);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    const c = g.attributes.color.array;
    pos.set(p, vo * 3);
    nor.set(n, vo * 3);
    col.set(c, vo * 3);
    const gi = g.index ? g.index.array : null;
    const count = g.attributes.position.count;
    if (gi) for (let i = 0; i < gi.length; i++) idx[io++] = gi[i] + vo;
    else for (let i = 0; i < count; i++) idx[io++] = i + vo;
    vo += count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

export class Scatter {
  constructor(field, material, opts = {}) {
    this.field = field;
    this.group = new THREE.Group();
    this.nearDist = opts.nearDist ?? 420;
    this.farDist = opts.farDist ?? 1650;
    this.maxNear = opts.maxNear ?? 3000;
    this.maxFar = opts.maxFar ?? 11000;
    this.maxRocks = opts.maxRocks ?? 1200;
    this.density = opts.density ?? 1;

    this.nearMesh = new THREE.InstancedMesh(pineGeometry('near'), material, this.maxNear);
    this.farMesh = new THREE.InstancedMesh(pineGeometry('far'), material, this.maxFar);
    this.rockMesh = new THREE.InstancedMesh(boulderGeometry(), material, this.maxRocks);
    for (const m of [this.nearMesh, this.farMesh, this.rockMesh]) {
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      this.group.add(m);
    }

    this.cache = new Map();
    this.lastX = 1e9;
    this.lastZ = 1e9;
    this.timer = 0;
    this.stats = { near: 0, far: 0, rocks: 0, chunks: 0 };
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this.activeChunks = [];
  }

  /** Baked forest density, 32 m/px. Done once at load. */
  bakeDensity() {
    const res = DENS_RES;
    const d = new Float32Array(res * res);
    const f = this.field;
    for (let y = 0; y < res; y++) {
      const wz = (y / (res - 1)) * WORLD.size - WORLD.half;
      for (let x = 0; x < res; x++) {
        const wx = (x / (res - 1)) * WORLD.size - WORLD.half;
        const h = f.height(wx, wz);
        if (h > WORLD.treeLine + 160 || h < WORLD.valleyFloor - 120) continue;
        const n = f.normal(wx, wz, null, 14);
        const steep = 1 - n.y;
        let v = smoothstep(WORLD.treeLine + 120, WORLD.treeLine - 420, h);
        v *= smoothstep(0.72, 0.26, steep);
        // forest patches and clearings
        const patch = f.noiseB.fbm2(wx * 0.00085 + 19.0, wz * 0.00085 - 7.0, 4) * 0.5 + 0.5;
        v *= smoothstep(0.34, 0.62, patch);
        // nothing grows in the lakes or in the river bed
        if (f.isWater(wx, wz)) v = 0;
        if (f.sampleFlow(wx, wz) > 0.72) v *= 0.25;
        d[y * res + x] = clamp01(v);
      }
    }
    this.densityMap = d;
    return d;
  }

  densityAt(x, z) {
    if (!this.densityMap) return 0;
    return sampleGrid(
      this.densityMap, DENS_RES,
      ((x + WORLD.half) / WORLD.size) * (DENS_RES - 1),
      ((z + WORLD.half) / WORLD.size) * (DENS_RES - 1),
    );
  }

  _chunk(cx, cz) {
    const key = cx * 8192 + cz;
    let c = this.cache.get(key);
    if (c) return c;
    const trees = [];
    const rocks = [];
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    const n = Math.round(CHUNK / CELL);
    const f = this.field;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const gx = cx * n + i;
        const gz = cz * n + j;
        const r = hash2(gx, gz, 7717);
        const px = x0 + (i + 0.5) * CELL + (hash2(gx, gz, 101) - 0.5) * CELL * 0.92;
        const pz = z0 + (j + 0.5) * CELL + (hash2(gx, gz, 211) - 0.5) * CELL * 0.92;
        const dens = this.densityAt(px, pz) * this.density;
        if (r < dens * 0.92) {
          const y = f.height(px, pz);
          const sc = 0.65 + hash2(gx, gz, 313) * 0.95 * (0.65 + dens * 0.5);
          trees.push(px, y - 0.4, pz, sc, hash2(gx, gz, 419) * Math.PI * 2);
        } else if (r > 0.986) {
          // boulders: on scree and above the treeline
          const y = f.height(px, pz);
          const nn = f.normal(px, pz, null, 6);
          if (1 - nn.y < 0.62 && !f.isWater(px, pz)) {
            const sc = 0.6 + hash2(gx, gz, 523) * 2.4;
            rocks.push(px, y + sc * 0.2, pz, sc, hash2(gx, gz, 631) * Math.PI * 2);
          }
        }
      }
    }
    c = { trees: new Float32Array(trees), rocks: new Float32Array(rocks), cx, cz };
    this.cache.set(key, c);
    if (this.cache.size > 900) {
      // drop the oldest quarter
      let k = 0;
      for (const kk of this.cache.keys()) {
        this.cache.delete(kk);
        if (++k > 220) break;
      }
    }
    return c;
  }

  update(camPos, dt) {
    this.timer -= dt;
    const moved = Math.hypot(camPos.x - this.lastX, camPos.z - this.lastZ);
    if (moved < 48 && this.timer > 0) return;
    this.timer = 0.2;
    this.lastX = camPos.x;
    this.lastZ = camPos.z;

    const r = Math.ceil(this.farDist / CHUNK);
    const ccx = Math.floor(camPos.x / CHUNK);
    const ccz = Math.floor(camPos.z / CHUNK);

    let nNear = 0;
    let nFar = 0;
    let nRock = 0;
    const m = this._m;
    const q = this._q;
    const v = this._v;
    const s = this._s;
    const near2 = this.nearDist * this.nearDist;
    const far2 = this.farDist * this.farDist;
    let chunks = 0;

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = ccx + dx;
        const cz = ccz + dz;
        const bx = cx * CHUNK + CHUNK / 2 - camPos.x;
        const bz = cz * CHUNK + CHUNK / 2 - camPos.z;
        const d2 = bx * bx + bz * bz;
        if (d2 > (this.farDist + CHUNK) * (this.farDist + CHUNK)) continue;
        const c = this._chunk(cx, cz);
        chunks++;
        const t = c.trees;
        for (let i = 0; i < t.length; i += 5) {
          const ddx = t[i] - camPos.x;
          const ddz = t[i + 2] - camPos.z;
          const dd = ddx * ddx + ddz * ddz;
          if (dd > far2) continue;
          q.setFromAxisAngle(UP, t[i + 4]);
          v.set(t[i], t[i + 1], t[i + 2]);
          const sc = t[i + 3];
          s.set(sc, sc * (0.85 + (t[i + 4] % 1) * 0.4), sc);
          m.compose(v, q, s);
          if (dd < near2) {
            if (nNear < this.maxNear) this.nearMesh.setMatrixAt(nNear++, m);
          } else if (nFar < this.maxFar) {
            this.farMesh.setMatrixAt(nFar++, m);
          }
        }
        if (d2 < near2 * 4) {
          const rk = c.rocks;
          for (let i = 0; i < rk.length; i += 5) {
            if (nRock >= this.maxRocks) break;
            q.setFromAxisAngle(UP, rk[i + 4]);
            v.set(rk[i], rk[i + 1], rk[i + 2]);
            const sc = rk[i + 3];
            s.set(sc, sc * 0.78, sc * (0.8 + (rk[i + 4] % 1) * 0.5));
            m.compose(v, q, s);
            this.rockMesh.setMatrixAt(nRock++, m);
          }
        }
      }
    }

    this.nearMesh.count = nNear;
    this.farMesh.count = nFar;
    this.rockMesh.count = nRock;
    this.nearMesh.instanceMatrix.needsUpdate = true;
    this.farMesh.instanceMatrix.needsUpdate = true;
    this.rockMesh.instanceMatrix.needsUpdate = true;
    this.stats.near = nNear;
    this.stats.far = nFar;
    this.stats.rocks = nRock;
    this.stats.chunks = chunks;
  }

  /**
   * Nearest tree trunk distance to a point (for proximity scoring and tree
   * strikes). Only scans the chunks the point could be in.
   */
  nearestTree(x, y, z, maxDist = 30, out) {
    let best = maxDist;
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = (cx + dx) * 8192 + (cz + dz);
        const c = this.cache.get(key);
        if (!c) continue;
        const t = c.trees;
        for (let i = 0; i < t.length; i += 5) {
          const tx = t[i];
          const ty = t[i + 1];
          const tz = t[i + 2];
          const sc = t[i + 3];
          const top = ty + 9.6 * sc;
          if (y > top + 2 || y < ty - 2) continue;
          const d = Math.hypot(x - tx, z - tz) - 0.9 * sc;
          if (d < best) {
            best = d;
            if (out) { out.x = tx; out.y = ty; out.z = tz; out.scale = sc; }
          }
        }
      }
    }
    return best;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
