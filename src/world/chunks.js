// Chunked terrain with quadtree LOD.
//
// One shared index buffer for every node (identical topology), vertical skirts
// to hide LOD cracks, a min/max height pyramid for tight frustum culling, and
// a time-budgeted generation queue. The visible set is swapped atomically:
// a node is never drawn on top of its own children, so there are no overlaps
// or holes even while new chunks are still being built.

import * as THREE from 'three';
import { WORLD } from './field.js';
import { clamp, clamp01 } from '../core/math.js';

const N = 32;                 // quads per node edge
const VERTS = N + 1;
const LEAF = 64;              // metres
const MAX_DEPTH = Math.round(Math.log2(WORLD.size / LEAF));

function buildSharedIndex() {
  const gridTris = N * N * 2;
  const skirtTris = 4 * N * 2;
  const idx = new Uint16Array((gridTris + skirtTris) * 3);
  let o = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * VERTS + i;
      const b = a + 1;
      const c = a + VERTS;
      const d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
  }
  // skirt vertices live after the grid, 4 runs of VERTS
  const S = VERTS * VERTS;
  const runs = [
    { base: S + 0 * VERTS, get: (i) => i },                         // north (j=0)
    { base: S + 1 * VERTS, get: (i) => (N) * VERTS + i },           // south (j=N)
    { base: S + 2 * VERTS, get: (i) => i * VERTS },                 // west  (i=0)
    { base: S + 3 * VERTS, get: (i) => i * VERTS + N },             // east  (i=N)
  ];
  for (let r = 0; r < 4; r++) {
    const run = runs[r];
    for (let i = 0; i < N; i++) {
      const g0 = run.get(i);
      const g1 = run.get(i + 1);
      const s0 = run.base + i;
      const s1 = run.base + i + 1;
      if (r === 0 || r === 3) {
        idx[o++] = g0; idx[o++] = s0; idx[o++] = g1;
        idx[o++] = g1; idx[o++] = s0; idx[o++] = s1;
      } else {
        idx[o++] = g0; idx[o++] = g1; idx[o++] = s0;
        idx[o++] = g1; idx[o++] = s1; idx[o++] = s0;
      }
    }
  }
  return idx;
}

export class TerrainChunks {
  constructor(field, material, opts = {}) {
    this.field = field;
    this.material = material;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.splitK = opts.splitK ?? 2.5;
    this.maxCached = opts.maxCached ?? 420;
    this.fineRadius = opts.fineRadius ?? 420;
    this.holeRange = opts.holeRange ?? 1700;
    this.holes = [];
    this.holeMask = null;   // optional (x,z) -> bool, set by the feature set

    this.indexAttr = new THREE.BufferAttribute(buildSharedIndex(), 1);
    this.cache = new Map();
    this.pending = [];
    this.visible = [];
    this.frame = 0;
    this.stalls = 0;
    this.stats = { nodes: 0, tris: 0, built: 0, queued: 0 };

    this._buildPyramid();
    this._scratchH = new Float32Array((N + 3) * (N + 3));
    this._box = new THREE.Box3();
  }

  _buildPyramid() {
    const f = this.field;
    const levels = [];
    let res = f.res;
    let min = new Float32Array(res * res);
    let max = new Float32Array(res * res);
    min.set(f.eroded);
    max.set(f.eroded);
    levels.push({ res, min, max, cell: WORLD.size / res });
    while (res > 4) {
      const nr = res >> 1;
      const nmin = new Float32Array(nr * nr);
      const nmax = new Float32Array(nr * nr);
      for (let y = 0; y < nr; y++) {
        for (let x = 0; x < nr; x++) {
          const i0 = (y * 2) * res + x * 2;
          const i1 = i0 + 1;
          const i2 = i0 + res;
          const i3 = i2 + 1;
          nmin[y * nr + x] = Math.min(min[i0], min[i1], min[i2], min[i3]);
          nmax[y * nr + x] = Math.max(max[i0], max[i1], max[i2], max[i3]);
        }
      }
      min = nmin;
      max = nmax;
      res = nr;
      levels.push({ res, min, max, cell: WORLD.size / res });
    }
    this.pyramid = levels;
  }

  /** Conservative height bounds for a node footprint. */
  _bounds(x0, z0, size) {
    // pick the pyramid level whose cell is <= size, then scan the few texels
    let L = 0;
    while (L + 1 < this.pyramid.length && this.pyramid[L + 1].cell <= size) L++;
    const lv = this.pyramid[L];
    const c = lv.cell;
    const i0 = clamp(Math.floor((x0 + WORLD.half) / c), 0, lv.res - 1);
    const i1 = clamp(Math.ceil((x0 + size + WORLD.half) / c), 0, lv.res - 1);
    const j0 = clamp(Math.floor((z0 + WORLD.half) / c), 0, lv.res - 1);
    const j1 = clamp(Math.ceil((z0 + size + WORLD.half) / c), 0, lv.res - 1);
    let mn = Infinity;
    let mx = -Infinity;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * lv.res + i;
        if (lv.min[k] < mn) mn = lv.min[k];
        if (lv.max[k] > mx) mx = lv.max[k];
      }
    }
    // margin for runtime detail, slot-canyon carve and lake basins
    return [mn - 240, mx + 26];
  }

  addHole(x0, z0, x1, z1) {
    this.holes.push({ x0, z0, x1, z1 });
  }

  _hitsHole(x0, z0, size) {
    for (let i = 0; i < this.holes.length; i++) {
      const h = this.holes[i];
      if (x0 < h.x1 && x0 + size > h.x0 && z0 < h.z1 && z0 + size > h.z0) return true;
    }
    return false;
  }

  _key(d, ix, iz) {
    return d * 1048576 + ix * 1024 + iz;
  }

  _build(node) {
    const f = this.field;
    const size = node.size;
    const step = size / N;
    const x0 = node.x0;
    const z0 = node.z0;
    const detailAmp = clamp(2.1 / step, 0.1, 1);
    const S = N + 3;
    const H = this._scratchH;

    for (let j = 0; j < S; j++) {
      const wz = z0 + (j - 1) * step;
      for (let i = 0; i < S; i++) {
        H[j * S + i] = f.height(x0 + (i - 1) * step, wz, detailAmp);
      }
    }

    const vcount = VERTS * VERTS + 4 * VERTS;
    const pos = new Float32Array(vcount * 3);
    const nor = new Float32Array(vcount * 3);
    const srf = new Float32Array(vcount * 4);
    let mnY = Infinity;
    let mxY = -Infinity;

    for (let j = 0; j < VERTS; j++) {
      const wz = z0 + j * step;
      for (let i = 0; i < VERTS; i++) {
        const wx = x0 + i * step;
        const si = (j + 1) * S + (i + 1);
        const h = H[si];
        const k = (j * VERTS + i) * 3;
        pos[k] = wx; pos[k + 1] = h; pos[k + 2] = wz;
        let nx = H[si - 1] - H[si + 1];
        let ny = 2 * step;
        let nz = H[si - S] - H[si + S];
        const il = 1 / (Math.hypot(nx, ny, nz) || 1);
        nor[k] = nx * il; nor[k + 1] = ny * il; nor[k + 2] = nz * il;
        const q = (j * VERTS + i) * 4;
        srf[q] = f.sampleFlow(wx, wz);
        srf[q + 1] = f.sampleAO(wx, wz);
        srf[q + 2] = f.glacierMask(wx, wz, h, ny * il);
        srf[q + 3] = detailAmp;
        if (h < mnY) mnY = h;
        if (h > mxY) mxY = h;
      }
    }

    // Just deep enough to cover an LOD seam. At step*5 the coarse nodes
    // grew 300 m curtains that hang in open air below every ridge.
    const drop = step * 1.5 + 3;
    const base = VERTS * VERTS;
    const runs = [
      (i) => i,
      (i) => N * VERTS + i,
      (i) => i * VERTS,
      (i) => i * VERTS + N,
    ];
    for (let r = 0; r < 4; r++) {
      for (let i = 0; i < VERTS; i++) {
        const g = runs[r](i);
        const dst = base + r * VERTS + i;
        pos[dst * 3] = pos[g * 3];
        pos[dst * 3 + 1] = pos[g * 3 + 1] - drop;
        pos[dst * 3 + 2] = pos[g * 3 + 2];
        nor[dst * 3] = nor[g * 3];
        nor[dst * 3 + 1] = nor[g * 3 + 1];
        nor[dst * 3 + 2] = nor[g * 3 + 2];
        srf[dst * 4] = srf[g * 4];
        srf[dst * 4 + 1] = srf[g * 4 + 1];
        srf[dst * 4 + 2] = srf[g * 4 + 2];
        srf[dst * 4 + 3] = srf[g * 4 + 3];
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('surf', new THREE.BufferAttribute(srf, 4));

    if (size <= 192 && this._hitsHole(x0, z0, size)) {
      geo.setIndex(this._holeIndex(x0, z0, step));
    } else {
      geo.setIndex(this.indexAttr);
    }
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(x0 + size / 2, (mnY + mxY) / 2, z0 + size / 2),
      Math.hypot(size * 0.708, (mxY - mnY) / 2 + drop),
    );

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    node.geo = geo;
    node.mesh = mesh;
    node.minY = mnY - drop;
    node.maxY = mxY;
    node.ready = true;
    this.stats.built++;
  }

  /**
   * Index buffer with quads inside feature footprints removed.
   *
   * The skirt is dropped entirely for these nodes: once you can see through
   * the hole, the downward skirt ring becomes a curtain of rock hanging in
   * mid-air. Every node inside a footprint is forced to the same (finest)
   * LOD, so there is no crack for the skirt to hide anyway, and the feature
   * mesh carries its own border curtain.
   */
  _holeIndex(x0, z0, step) {
    const src = this.indexAttr.array;
    const out = [];
    const gridEnd = N * N * 6;
    for (let t = 0; t < gridEnd; t += 6) {
      const q = t / 6;
      const i = q % N;
      const j = (q / N) | 0;
      const cx = x0 + (i + 0.5) * step;
      const cz = z0 + (j + 0.5) * step;
      let inside = false;
      for (let k = 0; k < this.holes.length; k++) {
        const h = this.holes[k];
        if (cx > h.x0 && cx < h.x1 && cz > h.z0 && cz < h.z1) { inside = true; break; }
      }
      if (inside && this.holeMask) inside = this.holeMask(cx, cz);
      if (inside) continue;
      for (let m = 0; m < 6; m++) out.push(src[t + m]);
    }
    return new THREE.BufferAttribute(new Uint16Array(out), 1);
  }

  _node(d, ix, iz) {
    const key = this._key(d, ix, iz);
    let n = this.cache.get(key);
    if (!n) {
      const size = WORLD.size / (1 << d);
      const x0 = -WORLD.half + ix * size;
      const z0 = -WORLD.half + iz * size;
      const [mn, mx] = this._bounds(x0, z0, size);
      n = { key, d, ix, iz, size, x0, z0, bMin: mn, bMax: mx, ready: false, used: 0 };
      this.cache.set(key, n);
    }
    n.used = this.frame;
    return n;
  }

  /**
   * Picks the desired node set, builds what is missing inside the time budget
   * and swaps the visible set when it is complete.
   */
  update(camPos, pilotPos, frustum, budgetMs = 6, force = false) {
    this.frame++;
    const want = [];
    const missing = [];
    const px = pilotPos ? pilotPos.x : camPos.x;
    const py = pilotPos ? pilotPos.y : camPos.y;
    const pz = pilotPos ? pilotPos.z : camPos.z;
    const fine2 = this.fineRadius * this.fineRadius;

    const visit = (d, ix, iz) => {
      const node = this._node(d, ix, iz);
      const size = node.size;
      const x0 = node.x0;
      const z0 = node.z0;
      this._box.min.set(x0, node.bMin, z0);
      this._box.max.set(x0 + size, node.bMax, z0 + size);
      if (frustum && !frustum.intersectsBox(this._box)) return;

      if (d < MAX_DEPTH) {
        const cx = clamp(camPos.x, x0, x0 + size);
        const cz = clamp(camPos.z, z0, z0 + size);
        const cy = clamp(camPos.y, node.bMin, node.bMax);
        const dist = Math.hypot(camPos.x - cx, camPos.y - cy, camPos.z - cz);
        // Always keep the finest LOD around the pilot so the mesh the player
        // can actually hit is the mesh collision is computed from.
        const ddx = Math.max(0, Math.max(x0 - px, px - (x0 + size)));
        const ddz = Math.max(0, Math.max(z0 - pz, pz - (z0 + size)));
        const nearPilot = ddx * ddx + ddz * ddz < fine2 && py < node.bMax + 1200;
        // Feature footprints are forced to the finest LOD, but only inside
        // the range where the feature mesh is actually drawn. Punching a hole
        // in a chunk that will be rendered without its feature would show
        // daylight through the mountain.
        const nearHole = dist < this.holeRange && this._hitsHole(x0, z0, size);
        if (dist < size * this.splitK || nearPilot || nearHole) {
          visit(d + 1, ix * 2, iz * 2);
          visit(d + 1, ix * 2 + 1, iz * 2);
          visit(d + 1, ix * 2, iz * 2 + 1);
          visit(d + 1, ix * 2 + 1, iz * 2 + 1);
          return;
        }
      }
      want.push(node);
      if (!node.ready) missing.push(node);
    };

    visit(0, 0, 0);

    if (missing.length) {
      missing.sort((a, b) => {
        const da = Math.hypot(a.x0 + a.size / 2 - camPos.x, a.z0 + a.size / 2 - camPos.z);
        const db = Math.hypot(b.x0 + b.size / 2 - camPos.x, b.z0 + b.size / 2 - camPos.z);
        return da - db;
      });
      const t0 = performance.now();
      const hardBudget = force ? 1e9 : (this.stalls > 6 ? budgetMs * 4 : budgetMs);
      for (const node of missing) {
        this._build(node);
        if (performance.now() - t0 > hardBudget) break;
      }
    }

    let allReady = true;
    for (let i = 0; i < want.length; i++) if (!want[i].ready) { allReady = false; break; }

    if (allReady) {
      this.stalls = 0;
      // swap the visible set
      const grp = this.group;
      for (let i = grp.children.length - 1; i >= 0; i--) grp.remove(grp.children[i]);
      let tris = 0;
      for (let i = 0; i < want.length; i++) {
        grp.add(want[i].mesh);
        tris += want[i].geo.index.count / 3;
      }
      this.visible = want;
      this.stats.nodes = want.length;
      this.stats.tris = tris;
    } else {
      this.stalls++;
    }
    this.stats.queued = missing.length;

    if (this.cache.size > this.maxCached) this._evict();
  }

  _evict() {
    const arr = [...this.cache.values()];
    arr.sort((a, b) => a.used - b.used);
    const live = new Set(this.visible.map((n) => n.key));
    let removed = 0;
    for (const n of arr) {
      if (this.cache.size - removed <= this.maxCached * 0.8) break;
      if (live.has(n.key)) continue;
      if (n.geo) n.geo.dispose();
      this.cache.delete(n.key);
      removed++;
    }
  }

  /** Pre-build everything visible from a position (used during loading). */
  prime(camPos, frustum) {
    this.update(camPos, camPos, frustum, 1e9, true);
  }

  dispose() {
    for (const n of this.cache.values()) if (n.geo) n.geo.dispose();
    this.cache.clear();
  }
}

export { MAX_DEPTH, LEAF, N as CHUNK_QUADS };
