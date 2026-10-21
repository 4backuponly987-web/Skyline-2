// Water: lake surfaces, river ribbons, waterfalls and the mist at their feet.
//
// None of it is in the heightfield. The terrain already dishes out a basin
// under each lake and a trench along the river, so the collidable ground is
// the bed; the water is a separate surface drawn on top. That is what makes
// skimming work — you are flying a couple of metres above the bed, and the
// only thing the water does is decide whether that counts as a graze, a
// splash or a crash.

import * as THREE from 'three';
import { ATMOS_GLSL } from '../render/sky.js';
import { NOISE_GLSL } from './terrainMaterial.js';
import { WORLD } from './field.js';
import { clamp, clamp01, lerp, smoothstep } from '../core/math.js';

const WATER_VERT = /* glsl */ `
precision highp float;
attribute float depth;
attribute vec2 flow;
varying vec3 vWorld;
varying float vDepth;
varying vec2 vFlow;
uniform float uTime;
void main() {
  vDepth = depth;
  vFlow = flow;
  vec3 p = position;
  // a slow swell so still water is never dead flat
  float s = sin(p.x * 0.061 + uTime * 0.9) * cos(p.z * 0.053 - uTime * 0.7);
  p.y += s * 0.12 * clamp(depth * 0.5, 0.0, 1.0);
  vWorld = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const WATER_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying float vDepth;
varying vec2 vFlow;
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform float uFoam;
uniform float uChop;

${ATMOS_GLSL}
${NOISE_GLSL}

// Ripple normal from two scrolling noise layers, advected along the flow.
vec3 rippleNormal(vec3 p, vec2 flow, float t) {
  vec2 d1 = flow * t * 0.55;
  vec2 d2 = flow * t * 0.31;
  float e = 0.7;
  vec3 a = vec3(p.x - d1.x, t * 0.35, p.z - d1.y) * 0.22;
  vec3 b = vec3(p.x - d2.x, t * 0.21, p.z - d2.y) * 0.075;
  float h = vnoise(a) * 0.5 + vnoise(b) * 0.85;
  float hx = vnoise(a + vec3(e * 0.22, 0.0, 0.0)) * 0.5 + vnoise(b + vec3(e * 0.075, 0.0, 0.0)) * 0.85;
  float hz = vnoise(a + vec3(0.0, 0.0, e * 0.22)) * 0.5 + vnoise(b + vec3(0.0, 0.0, e * 0.075)) * 0.85;
  return normalize(vec3((h - hx) * uChop, 0.09, (h - hz) * uChop));
}

void main() {
  if (vDepth <= 0.01) discard;
  vec3 V = normalize(uCamPos - vWorld);
  vec3 N = rippleNormal(vWorld, vFlow, uTime);

  // depth: clear and warm in the shallows, dark and blue out deep
  float d = clamp(vDepth / 7.0, 0.0, 1.0);
  vec3 body = mix(uShallow, uDeep, d);

  // sky in the surface
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) * 0.75 + 0.04;
  vec3 sky = atmosSky(R);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  fres = mix(0.03, 0.92, fres);

  vec3 col = mix(body, sky, fres);

  // sun glint
  vec3 H = normalize(V + uSunDir);
  col += uSunColor * pow(max(dot(N, H), 0.0), 220.0) * 1.9;
  col += uSunColor * pow(max(dot(N, H), 0.0), 26.0) * 0.08;

  // foam at the shoreline and wherever the water is moving fast
  float speed = length(vFlow);
  float shore = smoothstep(1.4, 0.0, vDepth);
  float churn = smoothstep(0.35, 1.6, speed);
  float fn = vnoise(vWorld * 0.55 + vec3(0.0, uTime * 1.4, 0.0));
  float fn2 = vnoise(vWorld * 1.7 - vec3(vFlow.x, 0.0, vFlow.y) * uTime * 0.9);
  float foam = clamp((shore * 0.9 + churn) * (fn * 0.6 + fn2 * 0.7) * uFoam, 0.0, 1.0);
  col = mix(col, vec3(0.86, 0.90, 0.93), foam * 0.85);

  col = atmosApply(col, vWorld);
  float alpha = clamp(vDepth * 1.6, 0.0, 1.0);
  gl_FragColor = vec4(col, mix(0.72, 0.97, clamp(vDepth / 3.0, 0.0, 1.0)) * alpha);
}
`;

// --------------------------------------------------------------- waterfalls

const FALL_VERT = /* glsl */ `
precision highp float;
attribute float along;
attribute float across;
varying vec3 vWorld;
varying float vAlong;
varying float vAcross;
void main() {
  vAlong = along;
  vAcross = across;
  vWorld = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FALL_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying float vAlong;
varying float vAcross;
uniform float uTime;
${ATMOS_GLSL}
${NOISE_GLSL}

void main() {
  // streaks accelerating downward, breaking up into spray near the bottom
  float t = uTime;
  float fall = vAlong * 7.0 - t * 2.6;
  float streak = vnoise(vec3(vAcross * 22.0, fall * 2.2, 0.0));
  float streak2 = vnoise(vec3(vAcross * 54.0, fall * 5.5 + 11.0, 3.0));
  float v = streak * 0.6 + streak2 * 0.55;

  float breakup = smoothstep(0.25, 1.0, vAlong);
  float edge = smoothstep(0.0, 0.12, 0.5 - abs(vAcross - 0.5));
  float a = (0.55 + v * 0.75) * edge;
  a *= mix(1.0, 0.45 + v * 0.7, breakup);
  a *= smoothstep(0.0, 0.07, vAlong);
  if (a < 0.02) discard;

  vec3 col = mix(vec3(0.74, 0.80, 0.86), vec3(0.97, 0.99, 1.0), v * 0.8 + breakup * 0.3);
  col *= 0.55 + 0.75 * max(dot(vec3(0.0, 1.0, 0.0), uSunDir), 0.0);
  col += uSunColor * 0.18 * v;
  col = atmosApply(col, vWorld);
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * 0.92);
}
`;

const MIST_VERT = /* glsl */ `
precision highp float;
attribute float psize;
attribute float seed;
varying float vSeed;
uniform float uTime;
uniform float uScale;
void main() {
  vSeed = seed;
  vec3 p = position;
  p.x += sin(uTime * 0.5 + seed * 6.28) * 2.2;
  p.y += sin(uTime * 0.37 + seed * 11.0) * 1.6;
  p.z += cos(uTime * 0.43 + seed * 9.1) * 2.2;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(2.0, psize * uScale / max(-mv.z, 1.0));
}
`;

const MIST_FRAG = /* glsl */ `
precision highp float;
varying float vSeed;
uniform vec3 uTint;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d);
  if (r > 0.25) discard;
  float a = (1.0 - r * 4.0);
  gl_FragColor = vec4(uTint, a * a * 0.22);
}
`;

function makeWaterMaterial(skyUniforms) {
  const uniforms = Object.assign({}, skyUniforms, {
    uTime: { value: 0 },
    uShallow: { value: new THREE.Color(0.19, 0.38, 0.40) },
    uDeep: { value: new THREE.Color(0.022, 0.078, 0.125) },
    uFoam: { value: 0.8 },
    uChop: { value: 1.6 },
  });
  const m = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  m.userData.uniforms = uniforms;
  return m;
}

export class Water {
  constructor(field, skyUniforms, opts = {}) {
    this.field = field;
    this.group = new THREE.Group();
    this.material = makeWaterMaterial(skyUniforms);
    this.fallMaterial = new THREE.ShaderMaterial({
      uniforms: Object.assign({}, skyUniforms, { uTime: { value: 0 } }),
      vertexShader: FALL_VERT,
      fragmentShader: FALL_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mistMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: 760 },
        uTint: { value: new THREE.Vector3(0.88, 0.93, 0.97) },
      },
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.lakes = [];
    this.falls = [];
    this.riverPath = null;
    this.quality = opts.quality || 1;
    this.time = 0;
  }

  build(riverPts) {
    this.buildLakes();
    this.buildRiver(riverPts);
    this.buildFalls();
    return this;
  }

  // ------------------------------------------------------------------ lakes

  buildLakes() {
    const f = this.field;
    for (const L of f.lakes) {
      const r = L.r * 1.42;
      const step = clamp(L.r / 30, 5, 13);
      const n = Math.ceil((r * 2) / step);
      const pos = [];
      const dep = [];
      const flw = [];
      const idx = [];
      const grid = new Int32Array((n + 1) * (n + 1)).fill(-1);
      let maxDepth = 0;
      for (let j = 0; j <= n; j++) {
        const z = L.z - r + (j / n) * r * 2;
        for (let i = 0; i <= n; i++) {
          const x = L.x - r + (i / n) * r * 2;
          // Stay inside the basin. Without the radius and depth limits the
          // sheet runs out over the rim and hangs down the valley, because
          // plenty of ground beyond the shore is also below the water line.
          if (Math.hypot(x - L.x, z - L.z) > L.r * 1.34) continue;
          const h = f.height(x, z);
          const d = L.level - h;
          if (d <= 0.05 || d > 30) continue;
          grid[j * (n + 1) + i] = pos.length / 3;
          pos.push(x, L.level, z);
          dep.push(d);
          flw.push(0.035, 0.02);  // barely moving
          if (d > maxDepth) maxDepth = d;
        }
      }
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const a = grid[j * (n + 1) + i];
          const b = grid[j * (n + 1) + i + 1];
          const c = grid[(j + 1) * (n + 1) + i];
          const d2 = grid[(j + 1) * (n + 1) + i + 1];
          if (a < 0 || b < 0 || c < 0 || d2 < 0) continue;
          idx.push(a, c, b, b, c, d2);
        }
      }
      if (!idx.length) continue;
      const mesh = this.makeMesh(pos, dep, flw, idx, this.material);
      this.group.add(mesh);
      this.lakes.push({ ...L, mesh, maxDepth });
    }
  }

  // ------------------------------------------------------------------ river

  /**
   * A ribbon down the valley floor. For each station the surface sits just
   * above the lowest ground across the channel, forced to descend, and the
   * banks are found by walking out until the ground rises above it.
   */
  buildRiver(pts) {
    if (!pts || pts.length < 2) return;
    const f = this.field;
    const stations = [];
    const SPACING = 16;

    // resample the authored path
    const path = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.round(len / SPACING));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        path.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t)]);
      }
    }
    path.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);

    for (let i = 0; i < path.length; i++) {
      const [x, z] = path[i];
      const nx = path[Math.min(path.length - 1, i + 1)][0] - path[Math.max(0, i - 1)][0];
      const nz = path[Math.min(path.length - 1, i + 1)][1] - path[Math.max(0, i - 1)][1];
      const tl = Math.hypot(nx, nz) || 1;
      const dx = nx / tl;
      const dz = nz / tl;
      const px = -dz;
      const pz = dx;

      // lowest ground across the channel, and where it is
      let lo = Infinity;
      let loOff = 0;
      for (let o = -40; o <= 40; o += 4) {
        const h = f.height(x + px * o, z + pz * o);
        if (h < lo) { lo = h; loOff = o; }
      }
      const cx = x + px * loOff;
      const cz = z + pz * loOff;
      // The surface sits just above the channel floor at every station.
      // Forcing it monotonically downhill from the first station instead
      // left the ribbon hanging hundreds of metres in the air wherever the
      // authored path crossed higher ground.
      const surf = lo + 0.8;

      // banks
      let left = 0;
      let right = 0;
      for (let o = 0; o <= 46; o += 2) {
        if (f.height(cx + px * o, cz + pz * o) < surf) left = o; else break;
      }
      for (let o = 0; o <= 46; o += 2) {
        if (f.height(cx - px * o, cz - pz * o) < surf) right = o; else break;
      }
      if (left + right < 3) {
        // no channel here: break the ribbon rather than stretching a quad
        // across the gap to the next place the river reappears
        stations.push(null);
        continue;
      }
      const half = Math.max(3.5, Math.min(26, (left + right) * 0.5));
      stations.push({ x: cx, z: cz, y: surf, px, pz, dx, dz, half });
    }

    const pos = [];
    const dep = [];
    const flw = [];
    const idx = [];
    const COLS = 4;

    // emit one continuous strip per unbroken run of stations
    let run = [];
    const flush = () => {
      if (run.length < 2) { run = []; return; }
      const base = pos.length / 3;
      for (let i = 0; i < run.length; i++) {
        const st = run[i];
        const grad = i > 0 ? Math.max(0, run[i - 1].y - st.y) : 0;
        const speed = clamp(0.5 + grad * 7, 0.4, 3.2);
        for (let c = 0; c <= COLS; c++) {
          const u = (c / COLS) * 2 - 1;
          const x = st.x + st.px * u * st.half;
          const z = st.z + st.pz * u * st.half;
          const bed = f.height(x, z);
          pos.push(x, st.y, z);
          dep.push(Math.max(0, st.y - bed));
          flw.push(st.dx * speed, st.dz * speed);
        }
      }
      for (let i = 0; i < run.length - 1; i++) {
        for (let c = 0; c < COLS; c++) {
          const a = base + i * (COLS + 1) + c;
          const b = a + 1;
          const d = base + (i + 1) * (COLS + 1) + c;
          const e = d + 1;
          idx.push(a, d, b, b, d, e);
        }
      }
      run = [];
    };
    for (const st of stations) {
      if (!st) { flush(); continue; }
      // a big jump in plan also means a break
      if (run.length && Math.hypot(st.x - run[run.length - 1].x, st.z - run[run.length - 1].z) > 70) flush();
      run.push(st);
    }
    flush();

    if (!idx.length) return;
    const mesh = this.makeMesh(pos, dep, flw, idx, this.material);
    this.group.add(mesh);
    this.riverStations = stations.filter(Boolean);
    this.riverMesh = mesh;
  }

  // -------------------------------------------------------------- waterfalls

  /** Looks along the river for places the channel falls off a step. */
  /**
   * Waterfalls everywhere water would actually fall.
   *
   * The river gives four, which in 151 km of mountain is nothing. The
   * erosion bake already knows where water runs -- that is the flow map it
   * cut the valleys with -- so this walks it for places with a real
   * catchment above a steep drop and hangs a fall there. They land on the
   * same fall-line trace the river ones use, so none of them is buried in
   * the hillside either.
   */
  buildFlowFalls(used, max) {
    const f = this.field;
    const step = 150;
    const cands = [];
    const lim = WORLD.half - 1800;   // not out in the boundary range
    for (let z = -lim; z <= lim; z += step) {
      for (let x = -lim; x <= lim; x += step) {
        const flow = f.sampleFlow(x, z);
        if (flow < 0.40) continue;
        const h = f.height(x, z);
        if (h < WORLD.valleyFloor + 260) continue;
        const n = f.normal(x, z, null, 8);
        if (1 - n.y < 0.52) continue;
        // how far does the fall line actually drop in the next 150 m?
        let px = x;
        let pz = z;
        let drop = 0;
        for (let k = 0; k < 30; k++) {
          const nn = f.normal(px, pz, null, 5);
          const hl = Math.hypot(nn.x, nn.z);
          if (hl < 1e-4) break;
          px += (nn.x / hl) * 5;
          pz += (nn.z / hl) * 5;
          drop = h - f.height(px, pz);
        }
        if (drop < 48) continue;
        // carry a half-width: addFall sizes the ribbon from it, and a
        // bigger catchment earns a wider fall.
        cands.push({ x, z, y: h, drop, score: flow * drop, half: 5.5 + flow * 9 });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    for (const c of cands) {
      if (used.length >= max) break;
      if (used.some((u) => Math.hypot(u.x - c.x, u.z - c.z) < 520)) continue;
      used.push(c);
      // Cap the trace: a fall that keeps going is not a waterfall, it is a
      // white stripe painted down the whole mountainside.
      const h = Math.min(c.drop, 190);
      this.addFall(c, { x: c.x, y: c.y - h, z: c.z }, h);
    }
  }

  buildFalls() {
    const st = this.riverStations;
    const used = [];
    if (!st) { this.buildFlowFalls(used, 30); return; }
    for (let i = 3; i < st.length - 3; i++) {
      const drop = st[i - 2].y - st[i + 2].y;
      if (drop < 18) continue;
      // the drop has to be steep in plan too, or it is just a fast reach
      const run = Math.hypot(st[i + 2].x - st[i - 2].x, st[i + 2].z - st[i - 2].z);
      if (run > drop * 2.2) continue;
      const near = used.some((u) => Math.hypot(u.x - st[i].x, u.z - st[i].z) < 420);
      if (near) continue;
      // how far does it actually fall?
      const lipY = st[i - 2].y;
      let baseY = lipY;
      for (let k = i; k < Math.min(st.length, i + 10); k++) baseY = Math.min(baseY, st[k].y);
      const h = lipY - baseY;
      if (h < 16) continue;
      used.push(st[i]);
      this.addFall(st[i - 2], st[Math.min(st.length - 1, i + 3)], h);
      if (used.length >= 4) break;
    }
    this.buildFlowFalls(used, 30);
  }

  /**
   * Traces the fall line down the rock rather than dropping a flat sheet
   * through it. The ribbon sits a metre above the ground at every step, so
   * where the rock is vertical it reads as a free fall and where it is steep
   * it reads as a chute — and it is never buried in the hillside.
   */
  addFall(lip, base, height) {
    const f = this.field;
    const STEP = 5;
    const centre = [];
    let x = lip.x;
    let z = lip.z;
    let flat = 0;
    const startY = f.height(x, z);
    for (let i = 0; i < 90; i++) {
      const n = f.normal(x, z, null, 4);
      const hl = Math.hypot(n.x, n.z);
      const grad = 1 - n.y;
      const gy = f.height(x, z);
      centre.push({ x, y: gy + 1.1, z, grad });
      if (startY - gy > height + 30) break;
      if (grad < 0.22) { if (++flat > 4) break; } else flat = 0;
      if (hl < 1e-4) break;
      x += (n.x / hl) * STEP;
      z += (n.z / hl) * STEP;
    }
    if (centre.length < 4) return;

    const top = centre[0];
    const foot = centre[centre.length - 1];
    const realDrop = top.y - foot.y;
    if (realDrop < 14) return;

    // Only river stations carry a half-width. Anything else gets a
    // default rather than a NaN that silently deletes the whole fall.
    const half = Number.isFinite(lip.half) ? lip.half : 7;
    const width = Math.max(11, Math.min(34, half * 2.0));
    const cols = 5;
    const pos = [];
    const along = [];
    const across = [];
    const idx = [];
    const rows = centre.length - 1;

    for (let r = 0; r < centre.length; r++) {
      const c = centre[r];
      const nxt = centre[Math.min(centre.length - 1, r + 1)];
      const prv = centre[Math.max(0, r - 1)];
      let dx = nxt.x - prv.x;
      let dz = nxt.z - prv.z;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const px = -dz;
      const pz = dx;
      const t = r / rows;
      const w = width * (0.8 + t * 0.7);
      for (let k = 0; k <= cols; k++) {
        const u = k / cols;
        const vx = c.x + px * (u - 0.5) * w;
        const vz = c.z + pz * (u - 0.5) * w;
        // every vertex sits on its own piece of ground, pushed out along the
        // surface normal. Holding one height across the ribbon buried the
        // uphill edge on anything steep.
        const vn = f.normal(vx, vz, null, 3);
        const vy = f.height(vx, vz);
        pos.push(vx + vn.x * 1.5, vy + vn.y * 1.5 + 0.4, vz + vn.z * 1.5);
        along.push(t);
        across.push(u);
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < cols; k++) {
        const a = r * (cols + 1) + k;
        const b = a + 1;
        const d = (r + 1) * (cols + 1) + k;
        const e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('along', new THREE.BufferAttribute(new Float32Array(along), 1));
    geo.setAttribute('across', new THREE.BufferAttribute(new Float32Array(across), 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.fallMaterial);
    mesh.renderOrder = 3;
    this.group.add(mesh);

    // mist at the foot, plus a thinner veil climbing the lower half
    const count = Math.round(200 * this.quality);
    const radius = width * 1.6 + 16;
    const mistH = Math.min(realDrop * 0.6, 90) + 22;
    const mpos = [];
    const msize = [];
    const mseed = [];
    for (let i = 0; i < count; i++) {
      const up = Math.pow(Math.random(), 1.7);
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * radius * (0.4 + up * 0.8);
      // drift the cloud up the fall line as it rises
      const src = centre[Math.max(0, centre.length - 1 - Math.floor(up * centre.length * 0.5))];
      mpos.push(src.x + Math.cos(a) * rr, foot.y + up * mistH - 5, src.z + Math.sin(a) * rr);
      msize.push(5 + Math.random() * 13);
      mseed.push(Math.random());
    }
    const mgeo = new THREE.BufferGeometry();
    mgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mpos), 3));
    mgeo.setAttribute('psize', new THREE.BufferAttribute(new Float32Array(msize), 1));
    mgeo.setAttribute('seed', new THREE.BufferAttribute(new Float32Array(mseed), 1));
    mgeo.computeBoundingSphere();
    const points = new THREE.Points(mgeo, this.mistMaterial);
    points.renderOrder = 4;
    this.group.add(points);

    this.falls.push({
      x: foot.x, y: foot.y, z: foot.z,
      height: realDrop, width,
      top: top.y,
      mistR: radius + 16,
      mistH,
      mesh, points,
    });
  }

  // ---------------------------------------------------------------- helpers

  makeMesh(pos, dep, flw, idx, material) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('depth', new THREE.BufferAttribute(new Float32Array(dep), 1));
    geo.setAttribute('flow', new THREE.BufferAttribute(new Float32Array(flw), 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.renderOrder = 2;
    return mesh;
  }

  update(dt) {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    this.fallMaterial.uniforms.uTime.value = this.time;
    this.mistMaterial.uniforms.uTime.value = this.time;
  }

  /** Water surface height at a point, or null if there is none. */
  surfaceAt(x, z) {
    for (let i = 0; i < this.lakes.length; i++) {
      const L = this.lakes[i];
      const dx = x - L.x;
      const dz = z - L.z;
      const rr = L.r * 1.34;
      if (dx * dx + dz * dz > rr * rr) continue;
      // Exactly the test the mesh was built from, depth window included.
      // Without the depth bound a point hundreds of metres BELOW a high
      // tarn still counts as "under water", and the skim code then teleports
      // the pilot up to the tarn's surface and drowns them.
      const d = L.level - this.field.height(x, z);
      if (d > 0.05 && d <= 30) return L.level;
    }
    const st = this.riverStations;
    if (st) {
      // the river is long and thin, so check only the nearby stations
      for (let i = 0; i < st.length; i++) {
        const s = st[i];
        const dx = x - s.x;
        const dz = z - s.z;
        if (Math.abs(dx) > 60 || Math.abs(dz) > 60) continue;
        const across = Math.abs(dx * s.px + dz * s.pz);
        const downStream = Math.abs(dx * s.dx + dz * s.dz);
        if (across < s.half && downStream < 14) return s.y;
      }
    }
    return null;
  }

  /** 0..1 how deep inside a waterfall's mist a point is. */
  mistAt(x, y, z) {
    let m = 0;
    for (let i = 0; i < this.falls.length; i++) {
      const f = this.falls[i];
      const dx = x - f.x;
      const dz = z - f.z;
      const dy = y - f.y;
      if (dy < -30 || dy > f.mistH) continue;
      const d = Math.hypot(dx, dz);
      if (d > f.mistR) continue;
      const v = smoothstep(f.mistR, f.mistR * 0.3, d) *
        smoothstep(f.mistH, f.mistH * 0.45, Math.max(0, dy));
      if (v > m) m = v;
    }
    return clamp01(m);
  }

  /** Distance to the nearest waterfall, for audio. */
  nearestFall(x, y, z) {
    let best = Infinity;
    for (let i = 0; i < this.falls.length; i++) {
      const f = this.falls[i];
      const d = Math.hypot(x - f.x, y - (f.y + f.height * 0.5), z - f.z);
      if (d < best) best = d;
    }
    return best;
  }

  setVisible(camPos, range = 2600) {
    const r2 = range * range;
    for (const f of this.falls) {
      const dx = f.x - camPos.x;
      const dz = f.z - camPos.z;
      const on = dx * dx + dz * dz < r2;
      f.mesh.visible = on;
      f.points.visible = on;
    }
  }

  stats() {
    return { lakes: this.lakes.length, falls: this.falls.length };
  }
}
