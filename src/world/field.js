// The terrain field.
//
//   height(x,z) = baseAnalytic (authored ridge network + warped ridged noise,
//                               wavelengths >= ~64 m)
//               + erosionDelta  (bicubic sample of the baked displacement)
//               + detail        (64 m -> 4 m band, shaped by the range mask)
//               + sharp carves  (slot canyon, lake basins)
//
// It is the single source of truth for the heightfield: meshing, collision,
// scatter and the map all call it, so the visible surface and the collidable
// surface cannot drift apart.

import { Noise } from '../core/noise.js';
import { RELIEF, lift } from './relief.js';
import { Rng } from '../core/rng.js';
import {
  clamp, clamp01, lerp, smoothstep, smax, smin, catmull, sampleGrid, remapClamped, distPointSeg2,
} from '../core/math.js';
import { hydraulic, thermal, skyOcclusion, blurGrid } from './erosion.js';
import { buildRidgeNetwork, cellOf } from './ridges.js';

export const WORLD = {
  // 12.3 km square, so 151 km of mountain rather than 67. Everything that
  // cares about scale derives from these two and the three resolutions
  // below, which are sized to keep the same 8 m per erosion cell.
  size: 12288,
  half: 6144,
  valleyFloor: 620,
  maxHeight: 5000,
  lakeLevel: lift(878),
  tarnLevel: lift(2042),
  treeLine: lift(1640),
  snowLine: lift(1830),
};

const EROSION_RES = 1536;          // 8 m/px — erosion + shadow texture
const BASE_RES = 768;              // 16 m/px — analytic field evaluation
const AO_RES = 384;                // 32 m/px — sky occlusion
const CELL = WORLD.size / EROSION_RES;

// Winding slot canyon incised into the Mesa plateau. Applied after erosion so
// the walls stay knife-sharp.
const SLOT = [
  [1690, 2210], [1900, 2430], [1810, 2690], [2050, 2880],
  [2350, 2950], [2620, 2820], [2790, 2580], [2690, 2340], [2410, 2210], [2090, 2160],
];

// Valley river draining the glacier south-west down the big valley.
const RIVER = [
  [-820, -260], [-1120, 420], [-1380, 1120], [-1520, 1840],
  [-1420, 2560], [-1700, 3180], [-2020, 3860],
];

export const LAKES = [
  { name: 'Lac Blanc', x: -1460, z: 2140, r: 330, level: WORLD.lakeLevel },
  { name: 'Cirque Tarn', x: -180, z: -520, r: 145, level: WORLD.tarnLevel },
  { name: 'Mirror Pool', x: -2760, z: 2420, r: 170, level: lift(1128) },
];

const GLACIER = { x: -430, z: -900, r: 680, level: lift(2095) };
const MESA = { x: 2300, z: 2560, rx: 820, rz: 610, level: lift(1530) };

// Headwalls at the launch sites.
//
// Erosion settles everything towards the talus angle, so the natural field
// tops out around 58 degrees: steep, but a ramp. A wingsuit exit on foot
// needs roughly 100 m of fall in the first 50 m of travel, which is 63
// degrees, so on the raw terrain every standing exit was a slide down the
// hill at 45 mph. These cut a real face under each launch -- a flat shelf
// to stand on and a 69 degree wall below it -- which is also what the
// launch notes have always promised. Carved analytically in postCarve
// rather than baked, so the lip is sharp at any resolution and collision
// is exactly what you see.
const SCARPS = [
  { x: 40, z: 60, dir: -2.2 },        // Skyline Summit
  { x: 2240, z: 1960, dir: 2.5 },     // The Anvil
  { x: -180, z: -2300, dir: -1.1 },   // Teeth Col
  { x: -1240, z: -1900, dir: 2.1 },   // Citadel Spire
  { x: -430, z: -900, dir: 2.0 },     // Glacier Bench
  { x: 2320, z: 2320, dir: -1.35 },   // Mesa Rim
  { x: -2320, z: 1620, dir: 0.75 },   // Lac Blanc Shoulder
  { x: -3060, z: 1680, dir: 0.9 },    // West Shoulder
  { x: 260, z: 460, dir: 1.5 },       // Chapel Rib
  { x: 3040, z: -2480, dir: 2.8 },    // Raven Hills
  { x: 300, z: -4960, dir: 1.57 },    // Northwall
  { x: 4120, z: -900, dir: 3.14 },    // East Rampart
  { x: 4350, z: 3160, dir: 2.2 },     // Cirque Blanche
  { x: -3700, z: -4520, dir: 0.9 },   // Gendarme
  { x: -4260, z: 380, dir: 0.0 },     // Westwatch
];
// slope is metres of fall per metre out: 4.0 is about 76 degrees, held for
// 90 m out and so 360 m down. Measured against STEP_OFF_PROFILE that leaves
// 37 m of air twenty metres off the lip and 110 m at fifty, where a 69
// degree wall left nine -- which is survivable but no fun at all.
const SCARP = { width: 110, rim: 85, slope: 4.0, face: 90, fade: 180, shelfDrop: 9 };
const SCARP_REACH = SCARP.face + SCARP.fade + SCARP.rim;

// The wall round the world.
//
// An invisible boundary is worse than no boundary: you fly at what looks
// like open country and watch the terrain tear itself apart at the edge of
// the loaded area. So the range is ringed by a real one, five kilometres of
// rock that you can see from the middle of the map and that simply ends the
// question of what is out there. It starts rising 1.5 km from the edge and
// is sheer by the last 400 m.
const RIM = {
  start: 2300,   // where the ground begins to rise towards it
  full: 500,     // by here it is at full height
  base: 4250,    // mean crest altitude
  vary: 1250,    // how far the crest rises and falls along its length
  rough: 520,    // relief across the face itself
};

function prepPath(pts, pad) {
  const seg = [];
  let total = 0;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg.push({ len, cum: total });
    total += len;
  }
  return { pts, seg, total, minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
}

function nearestOnPath(path, px, pz, out) {
  if (px < path.minX || px > path.maxX || pz < path.minZ || pz > path.maxZ) return false;
  let best = Infinity, bi = 0, bt = 0;
  const pts = path.pts;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const r = distPointSeg2(px, pz, a[0], a[1], b[0], b[1]);
    if (r.d < best) { best = r.d; bi = i; bt = r.t; }
  }
  out.d = best;
  out.s = (path.seg[bi].cum + bt * path.seg[bi].len) / path.total;
  return true;
}

function bicubicUpsample(src, srcRes, dstRes) {
  const dst = new Float32Array(dstRes * dstRes);
  const scale = (srcRes - 1) / (dstRes - 1);
  const row = (g, yy, ix, tx) => {
    const o = yy * srcRes + ix;
    return catmull(g[o - 1], g[o], g[o + 1], g[o + 2], tx);
  };
  for (let y = 0; y < dstRes; y++) {
    const fy = clamp(y * scale, 1, srcRes - 3);
    const iy = fy | 0;
    const ty = fy - iy;
    for (let x = 0; x < dstRes; x++) {
      const fx = clamp(x * scale, 1, srcRes - 3);
      const ix = fx | 0;
      const tx = fx - ix;
      dst[y * dstRes + x] = catmull(
        row(src, iy - 1, ix, tx), row(src, iy, ix, tx),
        row(src, iy + 1, ix, tx), row(src, iy + 2, ix, tx), ty,
      );
    }
  }
  return dst;
}

const _p = { d: 0, s: 0 };

export class TerrainField {
  constructor(seed = 'skyline') {
    this.seedStr = String(seed);
    const rng = new Rng(this.seedStr);
    this.seed = rng.seed;
    this.noise = new Noise(this.seed);
    this.noiseB = new Noise(this.seed ^ 0x9e3779b9);
    this.net = buildRidgeNetwork(this.seed, this.noiseB, WORLD.size);
    this.slot = prepPath(SLOT, 180);
    this.scarps = SCARPS.map((S) => ({
      ax: S.x, az: S.z,              // the authored spot, which POIs match on
      x: S.x, z: S.z,                // where it actually ends up after the bake
      dir0: S.dir,                   // the authored intent, kept as a tie-break
      dir: S.dir,
      cx: Math.cos(S.dir), cz: Math.sin(S.dir),
      h: null,                       // pinned to the eroded ground after the bake
    }));
    this.river = prepPath(RIVER, 620);
    this.lakes = LAKES;
    this.glacier = GLACIER;
    this.mesa = MESA;

    this.res = EROSION_RES;
    this.baseRes = BASE_RES;
    this.aoRes = AO_RES;
    this.cell = CELL;
    this.baked = false;
    this.eroded = null;
    this.delta = null;
    this.flow = null;
    this.ao = null;
    this.maskGrid = null;

    this._ids = new Int32Array(48);
    this._pmax = new Float64Array(48);
    this._hnum = new Float64Array(48);
    this._hden = new Float64Array(48);
    this._sorted = new Float64Array(49);
    this._sortedId = new Int32Array(49);
    this._sortedK = new Float64Array(49);
  }

  // ------------------------------------------------------------- macro field

  /** Everything with a wavelength above ~64 m. Baked, never called per-vertex. */
  baseAnalytic(x, z, info) {
    const n = this.noise;
    const nb = this.noiseB;

    // Lowlands: rolling foothills and moraine so valley floors are never dead
    // flat, with the secondary band itself modulated so it never reads as a
    // uniform dimple field.
    const lowVar = 0.45 + 0.55 * (n.noise2(x * 0.00019 + 3.1, z * 0.00019 - 8.6) * 0.5 + 0.5);
    let h =
      WORLD.valleyFloor +
      n.fbm2(x * 0.000163, z * 0.000163, 4) * 250 +
      nb.fbm2(x * 0.00052 + 5.1, z * 0.00052 - 3.3, 3) * 88 * lowVar -
      48;

    // Domain warp for the ridge noise.
    const wx = n.fbm2(x * 0.00029 + 11.3, z * 0.00029 - 4.7, 2);
    const wz = n.fbm2(x * 0.00029 - 27.1, z * 0.00029 + 18.9, 2);
    const rx = x + wx * 620;
    const rz = z + wz * 620;

    // --- ridge network ------------------------------------------------------
    // Every segment in range contributes a weight; crest height, along-ridge
    // distance and across-ridge offset are weighted blends, which keeps the
    // whole field continuous (no medial-axis cliff-steps).
    const hMod =
      1 +
      nb.noise2(x * 0.00082 + 4.2, z * 0.00082 - 1.7) * 0.14 +
      nb.noise2(x * 0.0026 - 9.1, z * 0.0026 + 3.3) * 0.055;
    const wMod = 1 + nb.noise2(x * 0.0011 + 21.3, z * 0.0011 + 7.7) * 0.18;
    const band = nb.fbm2(x * 0.00075 - 13.0, z * 0.00075 + 6.5, 3) * 0.5 + 0.5;

    const list = cellOf(this.net, x, z);
    const ids = this._ids;
    const pmax = this._pmax;
    const hnum = this._hnum;
    const hden = this._hden;
    let slots = 0;
    let wsum = 0;
    let mask = 0;
    let cliffness = 0;
    let bestSharp = 1;
    let bestCrest = 0;
    let sharpNum = 0;
    let cliffNum = 0;

    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) continue;
      const r = distPointSeg2(x, z, s.ax, s.az, s.bx, s.bz);
      const W = lerp(s.wa, s.wb, r.t) * wMod;
      const u = r.d / W;
      if (u >= 1) continue;

      const base = 1 - u * u;
      let prof = Math.pow(base, 0.6 + s.sharp * 0.6) * (0.5 + 0.5 * base);

      const cross = (s.bx - s.ax) * (z - s.az) - (s.bz - s.az) * (x - s.ax);
      const sd = (cross >= 0 ? r.d : -r.d) * s.cliffSide;
      const sideFac = 0.15 + 0.85 * smoothstep(-W * 0.2, W * 0.2, sd);
      const cl = clamp01(band * 1.65 - 0.5) * s.cliffAmount * sideFac;
      if (cl > 0.002) prof = lerp(prof, smoothstep(0.86, 0.46, u), cl);
      if (prof <= 0) continue;

      const H = lerp(s.ha, s.hb, r.t);
      const w = prof * prof + 1e-7;

      let slot = -1;
      for (let k = 0; k < slots; k++) if (ids[k] === s.poly) { slot = k; break; }
      if (slot < 0) {
        if (slots >= 48) continue;
        slot = slots++;
        ids[slot] = s.poly;
        pmax[slot] = 0;
        hnum[slot] = 0;
        hden[slot] = 0;
      }
      hnum[slot] += w * H;
      hden[slot] += w;
      if (prof > pmax[slot]) pmax[slot] = prof;

      wsum += w;
      sharpNum += w * s.sharp;
      cliffNum += w * cl;

      if (prof > mask) {
        mask = prof;
        bestCrest = H;
      }
    }

    // smax is not associative, so the fold order must be a property of the
    // world, not of whichever spatial-index cell we happened to land in —
    // otherwise the index grid shows up as straight-line steps in the terrain.
    // Insertion-sort the contributing ridges by their (global) polyline id.
    // Ridge mass is measured from the LOCAL ground, and the smoothing width
    // fades to zero with the profile. Both matter: measuring from a global
    // datum made terrain below that datum snap upwards the instant a ridge
    // came into range, and a fixed smoothing width inflated flat ground by
    // k/4 at the edge of every ridge's influence.
    const hBase = h;
    for (let a = 0; a < slots; a++) {
      const id = ids[a];
      const pr = pmax[a];
      let b = a - 1;
      while (b >= 0 && this._sortedId[b] > id) {
        this._sortedId[b + 1] = this._sortedId[b];
        this._sorted[b + 1] = this._sorted[b];
        this._sortedK[b + 1] = this._sortedK[b];
        b--;
      }
      this._sortedId[b + 1] = id;
      this._sorted[b + 1] = hBase + (hnum[a] / hden[a] - hBase) * pr;
      this._sortedK[b + 1] = 1e-5 + 170 * Math.min(1, pr * 4);
    }
    for (let k = 0; k < slots; k++) h = smax(h, this._sorted[k], this._sortedK[k]);

    if (wsum > 0) {
      bestSharp = sharpNum / wsum;
      cliffness = cliffNum / wsum;
    }
    const mountain = clamp01(mask * 1.25);

    // --- ridged multifractal ------------------------------------------------
    if (mountain > 0.004) {
      const ridge = n.ridged2(rx * 0.00049, rz * 0.00049, 6, 2.11, 0.52, 1.0);
      const amp = 320 * mountain * (0.86 + 0.2 * bestSharp);
      h += (ridge - 0.44) * amp;
      h += (nb.billow2(rx * 0.00085, rz * 0.00085, 3) - 0.44) * 92 * mountain * (1 - mountain * 0.55);

      // Flank structure: a second, finer ridged band on the faces. (An
      // explicit "ribs in along/across-ridge space" term was tried and
      // removed: blending the along-ridge arc length across segments has an
      // unbounded spatial derivative, which aliased into 4 m-period spikes.
      // The erosion pass produces better spurs anyway.)
      const flank = clamp01(4 * mask * (1 - mask));
      if (flank > 0.02) {
        const fine = n.ridged2(rx * 0.0016 + 9.3, rz * 0.0016 - 4.1, 3, 2.17, 0.52, 1.0);
        h += (fine - 0.45) * 74 * flank * mountain;
      }
    }

    // --- Mesa plateau -------------------------------------------------------
    const mesaM = this.mesaMask(x, z);
    if (mesaM > 0.001) {
      const plateauH =
        MESA.level +
        nb.fbm2(x * 0.0009, z * 0.0009, 3) * 46 +
        n.fbm2(x * 0.0031 + 7.2, z * 0.0031 - 2.6, 3) * 13;
      h = lerp(h, plateauH, mesaM);
    }

    // --- Glacier cirque -----------------------------------------------------
    const gd = Math.hypot(x - GLACIER.x, z - GLACIER.z) / GLACIER.r;
    if (gd < 1.5) {
      const gm = smoothstep(1.32, 0.5, gd);
      const bench = GLACIER.level + nb.fbm2(x * 0.0017, z * 0.0017, 2) * 26 - clamp01(1 - gd) * 34;
      h = lerp(h, smin(h, Math.max(bench, WORLD.valleyFloor), 60), gm * 0.85);
    }

    // --- River trench -------------------------------------------------------
    if (nearestOnPath(this.river, x, z, _p)) {
      const rw = 460;
      const ru = _p.d / rw;
      if (ru < 1.4) {
        const prof = Math.max(0, 1 - ru * ru);
        const floor = WORLD.valleyFloor + 92 + _p.s * 24 + _p.d * 0.3;
        h = lerp(h, smin(h, floor, 70), prof * prof * 0.9);
      }
    }

    if (info) {
      info.mask = mask;
      info.mountain = mountain;
      info.cliffness = cliffness;
      info.crest = bestCrest;
      info.mesa = mesaM;
    }
    return h;
  }

  mesaMask(x, z) {
    const dx = (x - MESA.x) / MESA.rx;
    const dz = (z - MESA.z) / MESA.rz;
    const d2 = dx * dx, d3 = dz * dz;
    const d = Math.sqrt(Math.sqrt(d2 * d2 + d3 * d3));
    const wob = this.noiseB.fbm2(x * 0.00072, z * 0.00072, 3) * 0.2;
    return smoothstep(0.012, 0.105, 1 - (d + wob));
  }

  /** The 64 m -> 4 m band. Cheap: five noise lookups. */
  detail(x, z, amp, mountain) {
    if (amp <= 0.002) return 0;
    const nb = this.noiseB;
    const m = mountain === undefined ? this.sampleMask(x, z) : mountain;
    const n1 = nb.noise2(x * 0.0156, z * 0.0156);
    const n2 = nb.noise2(x * 0.0371, z * 0.0371);
    const n3 = nb.noise2(x * 0.0912, z * 0.0912);
    const n4 = nb.noise2(x * 0.233, z * 0.233);
    // ridged flavour on steep rock, rounded on the flats
    const ridged = (1 - Math.abs(n1)) * 2 - 1;
    const d =
      lerp(n1, ridged, 0.34 * m) * (3.8 + 7.4 * m) +
      n2 * (1.9 + 3.6 * m) +
      n3 * (0.9 + 1.5 * m) +
      n4 * (0.34 + 0.5 * m);
    return d * amp;
  }

  // ------------------------------------------------------------------ carves

  /**
   * The launch headwalls. Only ever lowers ground, and the cut fades to
   * nothing at its edges, so it cannot introduce a step anywhere.
   */
  scarpCarve(x, z, h) {
    const R2 = SCARP_REACH * SCARP_REACH;
    for (let i = 0; i < this.scarps.length; i++) {
      const S = this.scarps[i];
      if (S.h === null) continue;
      const dx = x - S.x;
      const dz = z - S.z;
      if (dx * dx + dz * dz > R2) continue;
      const v = -dx * S.cz + dz * S.cx;
      const av = Math.abs(v);
      if (av > SCARP.width) continue;
      const across = smoothstep(SCARP.width, SCARP.width * 0.55, av);
      if (across <= 0.001) continue;
      const u = dx * S.cx + dz * S.cz;
      if (u < -SCARP.rim) continue;
      // Behind the lip: a shelf to stand on. In front: the wall, which is a
      // fixed 234 m tall and then fades back into the natural slope. Letting
      // the wall run on at its own angle instead cut a kilometre-deep wedge
      // out of the mountain, because the hill never caught up with it.
      if (u < 0) {
        // The rim is levelled, not just shaved: behind a lip the natural
        // ground usually keeps falling, so shaving alone left a knife edge
        // with nowhere to stand and nothing to walk off.
        // Not perfectly flat: keeping a tenth of the natural ground stops
        // the rim reading as a grey table laid on the mountain, and it is
        // still far inside what you can walk on.
        const w = across * smoothstep(-SCARP.rim, -SCARP.rim * 0.42, u) * 0.9;
        h = lerp(h, S.h, w);
      } else {
        const uc = Math.min(u, SCARP.face);
        const target = S.h - uc * SCARP.slope;
        const w = across * smoothstep(SCARP.face + SCARP.fade, SCARP.face, u);
        h = lerp(h, Math.min(h, target), w);
      }
    }
    return h;
  }

  /**
   * The range around the edge of the world.
   *
   * Not a rampart: a uniform wall of constant height reads as exactly what
   * it is. The crest rises and falls along its length into summits and
   * cols, the face has its own relief, and the foot comes up gently enough
   * that trees grow on it and snow sits on the shoulders -- so it looks
   * like the far side of the range rather than the end of the level.
   */
  rimWall(x, z, h) {
    const edge = Math.max(Math.abs(x), Math.abs(z));
    const from = WORLD.half - RIM.start;
    if (edge < from) return h;
    const to = WORLD.half - RIM.full;
    const t = clamp01((edge - from) / Math.max(1, to - from));
    const e = t * t * (3 - 2 * t);

    // Distance along the wall, so the crest line is continuous as it turns
    // the corners rather than restarting on each side.
    const along = Math.abs(x) > Math.abs(z) ? z + Math.sign(x) * 20000 : x;
    const n = this.noiseB;
    const crest = RIM.base
      + n.fbm2(along * 0.00042, 71.3, 3) * RIM.vary
      + n.fbm2(along * 0.0019, 12.7, 2) * RIM.vary * 0.3;

    // relief across the face: buttresses and gullies, strongest high up
    const face = n.fbm2(x * 0.00125 + 7.7, z * 0.00125 - 3.1, 4) * RIM.rough
      + n.fbm2(x * 0.0052 - 2.3, z * 0.0052 + 9.4, 3) * RIM.rough * 0.28;

    const target = crest + face * (0.3 + 0.7 * e);
    return lerp(h, Math.max(h, target), e);
  }

  postCarve(x, z, h) {
    h = this.rimWall(x, z, h);
    h = this.scarpCarve(x, z, h);
    if (!nearestOnPath(this.slot, x, z, _p)) return h;
    const wob = this.noiseB.fbm2(_p.s * 11.0, 3.7, 2);
    const w = 33 + wob * 15;
    const u = _p.d / w;
    if (u > 3.0) return h;
    const rim = smoothstep(2.6, 1.05, u);
    const inner = smoothstep(1.12, 0.6, u);
    const floorH = lerp(lift(1346), lift(1286), _p.s) + this.noiseB.fbm2(_p.s * 26, 9.1, 2) * 8;
    h = lerp(h, Math.min(h, floorH + 58 * (1 - inner)), rim * 0.62);
    h = lerp(h, floorH, inner);
    return h;
  }

  lakeShape(x, z, h) {
    for (let i = 0; i < this.lakes.length; i++) {
      const L = this.lakes[i];
      const dx = x - L.x;
      const dz = z - L.z;
      const d2 = dx * dx + dz * dz;
      const rr = L.r * 2.3;
      if (d2 > rr * rr) continue;
      const d = Math.sqrt(d2);
      // Perturb the radius by angle so the shoreline is a shape rather than
      // a circle. Sampling the noise on a ring keeps it continuous all the
      // way round.
      const inv = d > 1e-3 ? 1 / d : 0;
      const ca = dx * inv;
      const sa = dz * inv;
      const wob =
        this.noiseB.noise2(ca * 1.9 + L.x * 0.0013, sa * 1.9 + L.z * 0.0013) * 0.26 +
        this.noiseB.noise2(ca * 4.3 - 7.1, sa * 4.3 + 3.3) * 0.11;
      const R = L.r * (1 + wob);
      const m = smoothstep(R * 1.55, R * 0.72, d);
      const floor = L.level - 6 - 18 * smoothstep(R, 0, d);
      h = lerp(h, Math.min(h, floor), m);
    }
    return h;
  }

  // -------------------------------------------------------------------- bake

  *bake() {
    const bres = BASE_RES;
    const info = { mask: 0, mountain: 0, cliffness: 0, crest: 0, mesa: 0 };
    const baseLo = new Float32Array(bres * bres);
    const maskLo = new Float32Array(bres * bres);

    yield { phase: 'field', progress: 0, label: 'Raising the range' };
    for (let y = 0; y < bres; y++) {
      const wz = (y / (bres - 1)) * WORLD.size - WORLD.half;
      for (let x = 0; x < bres; x++) {
        const wx = (x / (bres - 1)) * WORLD.size - WORLD.half;
        baseLo[y * bres + x] = this.baseAnalytic(wx, wz, info);
        maskLo[y * bres + x] = info.mountain;
      }
      if ((y & 7) === 0) yield { phase: 'field', progress: y / bres, label: 'Raising the range' };
    }
    this.maskGrid = maskLo;

    const res = EROSION_RES;
    const base = bicubicUpsample(baseLo, bres, res);
    const eroded = base.slice();
    const flow = new Float32Array(res * res);

    yield { phase: 'hydraulic', progress: 0, label: 'Cutting valleys' };
    for (const p of hydraulic(eroded, res, {
      // scaled with the area so the valleys cut as deep as they did at 8 km
      droplets: 585000,
      maxSteps: 58,
      seed: this.seed ^ 0x51ed,
      flow,
      capacityFactor: 2.6,
      erodeSpeed: 0.3,
      depositSpeed: 0.28,
      brushRadius: 2,
      hardness: 10.5,
      cellSize: CELL,
    })) {
      yield { phase: 'hydraulic', progress: p, label: 'Cutting valleys' };
    }

    yield { phase: 'thermal', progress: 0, label: 'Settling scree' };
    for (const p of thermal(eroded, res, { passes: 9, talus: 1.3, cellSize: CELL, rate: 0.4 })) {
      yield { phase: 'thermal', progress: p, label: 'Settling scree' };
    }

    const delta = new Float32Array(res * res);
    for (let i = 0; i < delta.length; i++) delta[i] = eroded[i] - base[i];
    blurGrid(delta, res, 1, 1);
    for (let i = 0; i < delta.length; i++) eroded[i] = base[i] + delta[i];

    let maxFlow = 0;
    for (let i = 0; i < flow.length; i++) if (flow[i] > maxFlow) maxFlow = flow[i];
    const inv = maxFlow > 0 ? 1 / maxFlow : 0;
    for (let i = 0; i < flow.length; i++) flow[i] = Math.pow(flow[i] * inv, 0.3);
    blurGrid(flow, res, 1, 1);

    yield { phase: 'ao', progress: 0, label: 'Casting light' };
    const ao = new Float32Array(AO_RES * AO_RES);
    for (const p of skyOcclusion(eroded, res, ao, AO_RES, CELL, { dirs: 8, steps: 11, maxDist: 1600 })) {
      yield { phase: 'ao', progress: p, label: 'Casting light' };
    }
    blurGrid(ao, AO_RES, 1, 1);

    // Lake levels are authored as a hint, then pinned to the ground the
    // erosion actually left behind. A hand-written level can end up hundreds
    // of metres above its valley floor, which puts a sheet of water in
    // mid-air.
    this.base = base;
    this.eroded = eroded;
    for (const L of this.lakes) {
      const h = this.bicubic(eroded, L.x, L.z);
      L.level = h + 3.5;
    }
    this.delta = delta;
    this.flow = flow;
    this.ao = ao;
    this.baked = true;

    let min = Infinity, max = -Infinity;
    // Place each headwall: pin it to the eroded ground, nudge it onto the
    // best bit of ground near its authored spot, and point it down the hill.
    // The authored points and headings were picked by eye on an earlier
    // version of the terrain, and several of them sit in bowls or aim at
    // ground that climbs again a few hundred metres out.
    for (const S of this.scarps) {
      let best = null;
      for (let oz = -400; oz <= 400; oz += 200) {
        for (let ox = -400; ox <= 400; ox += 200) {
          const sx = S.ax + ox;
          const sz = S.az + oz;
          const sh = this.bicubic(eroded, sx, sz) - SCARP.shelfDrop;
          for (let a = 0; a < 32; a++) {
            const ang = (a / 32) * Math.PI * 2;
            const cx = Math.cos(ang);
            const cz = Math.sin(ang);
            // Score the heading by the clearance a jumper would actually
            // have: down the wall for its first 90 m, then the 2.6:1 glide
            // the suit settles at.
            let worst = Infinity;
            let descent = 0;
            let leaves = false;
            for (let d = 60; d <= 1400; d += 60) {
              const qx = sx + cx * d;
              const qz = sz + cz * d;
              if (Math.abs(qx) > WORLD.half - 400 || Math.abs(qz) > WORLD.half - 400) {
                leaves = true;
              }
              const h = this.bicubic(eroded, qx, qz);
              const path = d < SCARP.face
                ? sh - d * SCARP.slope
                : sh - SCARP.face * SCARP.slope - (d - SCARP.face) / 2.6;
              worst = Math.min(worst, path - h);
              descent += sh - h;
            }
            // A clean line first; among clean lines, the longest run-out.
            // Clearance alone happily picks a heading that is fine for a
            // kilometre and then walls up.
            let score = Math.min(worst, 260) + descent * 0.012 + sh * 0.05;
            const dd = Math.abs(((ang - S.dir0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
            score += Math.max(0, 1 - dd / 1.4) * 30;
            score -= Math.hypot(ox, oz) * 0.04;
            // An exit that flies you off the edge of the world inside
            // fifteen seconds is no exit at all.
            if (leaves) score -= 600;
            if (!best || score > best.score) {
              best = { score, x: sx, z: sz, h: sh, dir: ang, cx, cz };
            }
          }
        }
      }
      S.x = best.x;
      S.z = best.z;
      S.h = best.h;
      S.dir = best.dir;
      S.cx = best.cx;
      S.cz = best.cz;
    }

    for (let i = 0; i < eroded.length; i++) {
      if (eroded[i] < min) min = eroded[i];
      if (eroded[i] > max) max = eroded[i];
    }
    this.minHeight = min;
    this.maxHeight = max;
    yield { phase: 'done', progress: 1, label: 'Ready' };
  }

  // ---------------------------------------------------------------- sampling

  /** Bicubic sample of an EROSION_RES grid — no bilinear facets up close. */
  bicubic(g, x, z) {
    if (!g) return 0;
    const res = this.res;
    const fx = clamp(((x + WORLD.half) / WORLD.size) * (res - 1), 1, res - 3);
    const fy = clamp(((z + WORLD.half) / WORLD.size) * (res - 1), 1, res - 3);
    const ix = fx | 0;
    const iy = fy | 0;
    const tx = fx - ix;
    const ty = fy - iy;
    const o0 = (iy - 1) * res + ix;
    const o1 = o0 + res;
    const o2 = o1 + res;
    const o3 = o2 + res;
    return catmull(
      catmull(g[o0 - 1], g[o0], g[o0 + 1], g[o0 + 2], tx),
      catmull(g[o1 - 1], g[o1], g[o1 + 1], g[o1 + 2], tx),
      catmull(g[o2 - 1], g[o2], g[o2 + 1], g[o2 + 2], tx),
      catmull(g[o3 - 1], g[o3], g[o3 + 1], g[o3 + 2], tx),
      ty,
    );
  }

  sampleMask(x, z) {
    if (!this.maskGrid) return 0.5;
    const r = this.baseRes;
    return sampleGrid(
      this.maskGrid, r,
      ((x + WORLD.half) / WORLD.size) * (r - 1),
      ((z + WORLD.half) / WORLD.size) * (r - 1),
    );
  }

  sampleFlow(x, z) {
    if (!this.flow) return 0;
    const r = this.res;
    return sampleGrid(
      this.flow, r,
      ((x + WORLD.half) / WORLD.size) * (r - 1),
      ((z + WORLD.half) / WORLD.size) * (r - 1),
    );
  }

  sampleAO(x, z) {
    if (!this.ao) return 1;
    const r = this.aoRes;
    return sampleGrid(
      this.ao, r,
      ((x + WORLD.half) / WORLD.size) * (r - 1),
      ((z + WORLD.half) / WORLD.size) * (r - 1),
    );
  }

  /** Eroded macro height (no fine detail). Used by the map and shadow texture. */
  coarseHeight(x, z) {
    if (!this.eroded) return WORLD.valleyFloor;
    return this.bicubic(this.eroded, x, z);
  }

  /** THE height function. */
  height(x, z, detailAmp = 1) {
    let h = this.eroded ? this.bicubic(this.eroded, x, z) : this.baseAnalytic(x, z);
    h += this.detail(x, z, detailAmp);
    h = this.postCarve(x, z, h);
    h = this.lakeShape(x, z, h);
    const out = Math.max(Math.abs(x), Math.abs(z)) - (WORLD.half - 200);
    if (out > 0) h -= out * 1.9;
    return h;
  }

  normal(x, z, out, eps = 1.3) {
    const hL = this.height(x - eps, z);
    const hR = this.height(x + eps, z);
    const hD = this.height(x, z - eps);
    const hU = this.height(x, z + eps);
    let nx = hL - hR;
    const ny = 2 * eps;
    let nz = hD - hU;
    const l = Math.hypot(nx, ny, nz) || 1;
    if (out) {
      out.x = nx / l; out.y = ny / l; out.z = nz / l;
      return out;
    }
    return { x: nx / l, y: ny / l, z: nz / l };
  }

  slope(x, z, eps = 2.2) {
    return clamp01(1 - this.normal(x, z, null, eps).y);
  }

  surfaceInfo(x, z) {
    const h = this.height(x, z);
    const n = this.normal(x, z, null, 2.2);
    const steep = 1 - n.y;
    const wet = this.sampleFlow(x, z);
    const ao = this.sampleAO(x, z);
    const snow = clamp01(
      remapClamped(h, WORLD.snowLine - 280, WORLD.snowLine + 320, 0, 1) * (1 - clamp01(steep * 1.7)),
    );
    return { h, n, steep, wet, ao, snow };
  }

  /** 0..1 glacier ice coverage. `ny` is the surface normal's Y, if known. */
  glacierMask(x, z, h, ny) {
    const d = Math.hypot(x - GLACIER.x, z - GLACIER.z) / GLACIER.r;
    if (d > 1.25) return 0;
    const hh = h === undefined ? this.height(x, z) : h;
    const up = ny === undefined ? this.normal(x, z, null, 6).y : ny;
    let m = smoothstep(1.2, 0.45, d);
    m *= smoothstep(GLACIER.level - 280, GLACIER.level - 70, hh);
    m *= clamp01((up - 0.55) * 3.2);
    return clamp01(m);
  }

  /** Local snow line, varied so it is not a contour ring. */
  snowLineFor(x, z) {
    return WORLD.snowLine + this.noiseB.fbm2(x * 0.0009, z * 0.0009, 3) * 190;
  }

  isWater(x, z) {
    for (let i = 0; i < this.lakes.length; i++) {
      const L = this.lakes[i];
      if (Math.hypot(x - L.x, z - L.z) < L.r) return L;
    }
    return null;
  }
}

export { GLACIER, MESA, SLOT, RIVER, SCARPS, SCARP, RELIEF, lift };
