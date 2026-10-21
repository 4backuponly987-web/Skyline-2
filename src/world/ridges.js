// The range skeleton.
//
// Real ranges are dendritic: a trunk watershed with spurs branching off it,
// each spur throwing smaller spurs, heights stepping down each generation.
// Pure noise never produces that; a handful of authored ridges produces
// parallel welts. So: author the trunks (which gives the range its designed
// shape, its valleys and its named summits), then grow the spurs procedurally.
//
// Everything here is evaluated as a *continuous* field. Naively taking the
// nearest segment of a polyline makes the along-ridge parameter jump across
// medial axes, which shows up as 40 m cliff-steps in the middle of a slope.
// Instead every segment within range contributes a weight, and crest height,
// ridge axis and along-distance are weighted blends — continuous everywhere.

import { Rng } from '../core/rng.js';
import { clamp, lerp } from '../core/math.js';
import { lift, RELIEF } from './relief.js';

// Raise the low ranges before stretching the lot.
//
// The outer and gentler ridges were authored around 1.1 to 1.6 km, so even
// after the relief stretch their launches sat at 1.6 km while the central
// summits stood at 4.1. That is the complaint about the whole range being
// one level: half of it was. Every ridge is now scaled about the valley
// floor until its highest point reaches at least MIN_TOP, which keeps each
// ridge's own profile and only changes how far it stands above the valley.
const MIN_TOP = 2520;

function lifted(trunks) {
  for (const t of trunks) {
    let top = 0;
    for (const p of t.pts) if (p[2] > top) top = p[2];
    const k = top < MIN_TOP && top > RELIEF.floor
      ? (MIN_TOP - RELIEF.floor) / (top - RELIEF.floor)
      : 1;
    for (const p of t.pts) p[2] = lift(RELIEF.floor + (p[2] - RELIEF.floor) * k);
  }
  return trunks;
}

// Authored at the old 3.1 km scale and stretched to the new one by `lift`,
// so the shape of the range is unchanged and only its relief grows.
export const TRUNKS = lifted([
  {
    name: 'Skyline Ridge',
    kind: 'trunk',
    width: 860,
    sharp: 1.0,
    cliffSide: 1,
    cliffAmount: 0.85,
    branchEvery: 760,
    summits: { 6: 'Skyline Summit', 10: 'The Anvil', 2: 'Kestrel Horn' },
    pts: [
      [-3520, -3160, 1480],
      [-2860, -2520, 2010],
      [-2360, -2060, 2360],
      [-1680, -1420, 2020],
      [-1020, -820, 2430],
      [-380, -220, 2720],
      [40, 60, 3010],
      [600, 620, 2380],
      [1180, 1060, 2140],
      [1760, 1520, 2440],
      [2240, 1960, 2780],
      [2720, 2420, 2010],
      [3180, 2960, 1520],
    ],
  },
  {
    name: 'The Teeth',
    kind: 'knife',
    width: 470,
    sharp: 1.8,
    cliffSide: -1,
    cliffAmount: 1.0,
    branchEvery: 560,
    summits: { 4: 'Molar', 7: 'The Fang' },
    pts: [
      [-2560, -3980, 1300],
      [-1800, -3500, 1900],
      [-1120, -3080, 2120],
      [-460, -2660, 2300],
      [220, -2200, 1980],
      [900, -1740, 2210],
      [1600, -1280, 2380],
      [2300, -760, 1960],
      [2960, -240, 2060],
      [3520, 220, 1480],
    ],
  },
  {
    name: 'West Shoulder',
    kind: 'rounded',
    width: 1020,
    sharp: 0.7,
    cliffSide: -1,
    cliffAmount: 0.28,
    branchEvery: 900,
    pts: [
      [-3900, -1200, 1080],
      [-3700, -200, 1250],
      [-3380, 760, 1460],
      [-3060, 1680, 1560],
      [-2680, 2540, 1380],
      [-2220, 3340, 1200],
    ],
  },
  {
    name: 'Mesa Rim',
    kind: 'mesa',
    width: 760,
    sharp: 0.5,
    cliffSide: 1,
    cliffAmount: 0.75,
    branchEvery: 1500,
    pts: [
      [1060, 2200, 1400],
      [1820, 2800, 1470],
      [2680, 2980, 1490],
      [3340, 2520, 1440],
      [3720, 1780, 1350],
    ],
  },
  {
    name: 'North Buttress',
    kind: 'knife',
    width: 560,
    sharp: 1.5,
    cliffSide: 1,
    cliffAmount: 0.9,
    branchEvery: 480,
    summits: { 1: 'The Citadel' },
    pts: [
      [-1680, -1400, 2080],
      [-1240, -1900, 2290],
      [-760, -2420, 2240],
    ],
  },
  {
    name: 'Chapel Rib',
    kind: 'trunk',
    width: 600,
    sharp: 1.2,
    cliffSide: -1,
    cliffAmount: 0.65,
    branchEvery: 540,
    pts: [
      [260, 460, 2540],
      [520, 1080, 2060],
      [640, 1740, 1680],
      [520, 2360, 1380],
      [300, 2920, 1140],
    ],
  },
  {
    name: 'South Gate',
    kind: 'rounded',
    width: 700,
    sharp: 0.9,
    cliffSide: 1,
    cliffAmount: 0.5,
    branchEvery: 780,
    pts: [
      [-800, 2900, 1240],
      [-80, 3360, 1400],
      [760, 3560, 1300],
      [1640, 3380, 1150],
    ],
  },
  {
    name: 'Raven Hills',
    kind: 'rounded',
    width: 820,
    sharp: 0.68,
    cliffSide: -1,
    cliffAmount: 0.3,
    branchEvery: 820,
    pts: [
      [1500, -3760, 1120],
      [2300, -3200, 1380],
      [3040, -2480, 1560],
      [3560, -1600, 1420],
      [3800, -700, 1260],
    ],
  },
  // ---- the outer ranges -------------------------------------------------
  // Added when the world went from 8.2 to 12.3 km square. They run out from
  // the ends of the inner ridges rather than standing apart from them, so
  // the range reads as one piece of country; the biggest summits stay in
  // the middle, and the outer ground is a mix of big north faces, a long
  // rampart and some rolling forested country to glide out into.
  {
    name: 'Gendarme Chain',
    kind: 'knife',
    width: 520,
    sharp: 1.7,
    cliffSide: -1,
    cliffAmount: 0.95,
    branchEvery: 540,
    summits: { 1: 'First Gendarme', 2: 'The Pulpit' },
    pts: [
      [-2900, -4180, 1620],
      [-3700, -4520, 2180],
      [-4420, -4760, 1960],
      [-5020, -4840, 1480],
    ],
  },
  {
    name: 'The Northwall',
    kind: 'trunk',
    width: 900,
    sharp: 1.1,
    cliffSide: 1,
    cliffAmount: 0.92,
    branchEvery: 700,
    summits: { 2: 'Northwall Summit', 4: 'Cold Horn' },
    pts: [
      [-2000, -4620, 1680],
      [-900, -4860, 2260],
      [300, -4960, 2520],
      [1500, -4840, 2240],
      [2600, -4520, 1700],
    ],
  },
  {
    name: 'East Rampart',
    kind: 'knife',
    width: 600,
    sharp: 1.45,
    cliffSide: -1,
    cliffAmount: 0.88,
    branchEvery: 620,
    summits: { 2: 'The Rampart' },
    pts: [
      [3980, -3200, 1500],
      [4480, -2100, 2050],
      [4760, -900, 2310],
      [4800, 420, 2080],
      [4600, 1700, 1620],
    ],
  },
  {
    name: 'Cirque Blanche',
    kind: 'trunk',
    width: 780,
    sharp: 1.0,
    cliffSide: 1,
    cliffAmount: 0.8,
    branchEvery: 660,
    summits: { 1: 'Blanche' },
    pts: [
      [3800, 2500, 1560],
      [4350, 3160, 1980],
      [4580, 3920, 1820],
      [4260, 4620, 1340],
    ],
  },
  {
    name: 'Long Meadow',
    kind: 'rounded',
    width: 1100,
    sharp: 0.6,
    cliffSide: -1,
    cliffAmount: 0.22,
    branchEvery: 980,
    pts: [
      [-1800, 4300, 1060],
      [-500, 4720, 1240],
      [900, 4880, 1180],
      [2300, 4620, 1020],
    ],
  },
  {
    name: 'Far West Spur',
    kind: 'rounded',
    width: 900,
    sharp: 0.8,
    cliffSide: 1,
    cliffAmount: 0.42,
    branchEvery: 860,
    summits: { 2: 'Westwatch' },
    pts: [
      [-4820, -2100, 1280],
      [-4980, -880, 1620],
      [-4900, 380, 1780],
      [-4560, 1620, 1480],
      [-4040, 2760, 1180],
    ],
  },
  {
    name: 'Larch Spur',
    kind: 'rounded',
    width: 700,
    sharp: 0.75,
    cliffSide: 1,
    cliffAmount: 0.35,
    branchEvery: 760,
    pts: [
      [-3500, 2500, 1120],
      [-3060, 3200, 1240],
      [-2500, 3760, 1080],
    ],
  },
]);

export const GRID_CELL = 192;

function pointAt(pts, cum, total, s) {
  s = clamp(s, 0, total - 1e-3);
  let i = 0;
  while (i < pts.length - 2 && cum[i + 1] < s) i++;
  const segLen = cum[i + 1] - cum[i];
  const t = segLen > 0 ? (s - cum[i]) / segLen : 0;
  const a = pts[i];
  const b = pts[i + 1];
  return {
    x: lerp(a[0], b[0], t),
    z: lerp(a[1], b[1], t),
    h: lerp(a[2], b[2], t),
    dx: (b[0] - a[0]) / (segLen || 1),
    dz: (b[1] - a[1]) / (segLen || 1),
  };
}

function cumulative(pts) {
  const cum = [0];
  for (let i = 0; i < pts.length - 1; i++) {
    cum.push(cum[i] + Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
  }
  return cum;
}

function growBranches(parentPts, parentMeta, rng, noise, depth, out) {
  const cum = cumulative(parentPts);
  const total = cum[cum.length - 1];
  const every = parentMeta.branchEvery;
  const count = Math.max(1, Math.floor(total / every));
  for (let b = 0; b < count; b++) {
    const s = ((b + 0.5) / count) * total + rng.range(-every * 0.3, every * 0.3);
    const at = pointAt(parentPts, cum, total, s);
    const side = rng.float() < 0.5 ? 1 : -1;
    const baseAng = Math.atan2(at.dz, at.dx) + side * (Math.PI / 2) + rng.range(-0.45, 0.45);
    const lengthScale = depth === 0 ? rng.range(0.6, 1.35) : rng.range(0.42, 0.85);
    const length = clamp(parentMeta.width * 2.4 * lengthScale, 420, 2700);
    const steps = Math.max(3, Math.round(length / 240));
    const pts = [];
    let px = at.x;
    let pz = at.z;
    let ang = baseAng;
    const h0 = at.h * rng.range(0.9, 1.0);
    const hEnd = at.h * rng.range(0.36, 0.58);
    const curl = rng.range(-0.35, 0.35);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const hh =
        lerp(h0, hEnd, Math.pow(t, 0.8)) +
        noise.noise2(px * 0.0021 + 31.7, pz * 0.0021 - 12.4) * 105 * (1 - t * 0.45);
      pts.push([px, pz, Math.max(600, hh)]);
      ang += curl / steps + noise.noise2(px * 0.0013, pz * 0.0013) * 0.34;
      const stepLen = length / steps;
      px += Math.cos(ang) * stepLen;
      pz += Math.sin(ang) * stepLen;
    }
    const w0 = parentMeta.width * rng.range(0.33, 0.5);
    const meta = {
      name: `${parentMeta.name} spur ${b}`,
      kind: parentMeta.kind === 'knife' ? 'knife' : 'spur',
      width: w0,
      widthEnd: w0 * rng.range(0.3, 0.55),
      sharp: parentMeta.sharp * rng.range(0.85, 1.2),
      cliffSide: rng.float() < 0.62 ? parentMeta.cliffSide : -parentMeta.cliffSide,
      cliffAmount: (parentMeta.cliffAmount || 0.5) * rng.range(0.5, 1.05),
      branchEvery: every * 0.6,
      depth: depth + 1,
    };
    out.push({ pts, meta });
    if (depth < 1 && length > 760 && rng.float() < 0.72) {
      growBranches(pts, meta, rng, noise, depth + 1, out);
    }
  }
}

/**
 * Flattens every polyline into independent segments with their own bounding
 * boxes, and indexes them in a uniform grid.
 */
export function buildRidgeNetwork(seed, noise, worldSize) {
  const rng = new Rng(seed ^ 0x52d9e1);
  const polylines = [];
  for (const t of TRUNKS) {
    polylines.push({ pts: t.pts, meta: { ...t, widthEnd: t.width * 0.82, depth: 0 } });
  }
  const trunkCount = polylines.length;
  for (let i = 0; i < trunkCount; i++) {
    growBranches(polylines[i].pts, polylines[i].meta, rng, noise, 0, polylines);
  }

  const segs = [];
  const polys = [];
  for (let pi = 0; pi < polylines.length; pi++) {
    const { pts, meta } = polylines[pi];
    const cum = cumulative(pts);
    const total = cum[cum.length - 1];
    polys.push({ ...meta, pts, total, index: pi });
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const len = cum[i + 1] - cum[i];
      if (len < 1e-3) continue;
      const u = (i + 0.5) / Math.max(1, pts.length - 1);
      const wa = lerp(meta.width, meta.widthEnd, i / Math.max(1, pts.length - 1));
      const wb = lerp(meta.width, meta.widthEnd, (i + 1) / Math.max(1, pts.length - 1));
      const maxW = Math.max(wa, wb);
      let dx = (b[0] - a[0]) / len;
      let dz = (b[1] - a[1]) / len;
      // canonicalise the axis direction so averaging across segments is stable
      let ax = dx, az = dz;
      if (ax < 0 || (ax === 0 && az < 0)) { ax = -ax; az = -az; }
      segs.push({
        ax: a[0], az: a[1], bx: b[0], bz: b[1],
        ha: a[2], hb: b[2], wa, wb,
        len, cum: cum[i], total,
        poly: pi,
        axisX: ax, axisZ: az,
        cliffSide: meta.cliffSide,
        cliffAmount: meta.cliffAmount || 0.5,
        sharp: meta.sharp || 1,
        minX: Math.min(a[0], b[0]) - maxW * 1.25,
        maxX: Math.max(a[0], b[0]) + maxW * 1.25,
        minZ: Math.min(a[1], b[1]) - maxW * 1.25,
        maxZ: Math.max(a[1], b[1]) + maxW * 1.25,
        u,
      });
    }
  }

  const half = worldSize / 2;
  const gn = Math.ceil(worldSize / GRID_CELL) + 2;
  const cells = new Array(gn * gn);
  for (let i = 0; i < cells.length; i++) cells[i] = EMPTY;
  for (const s of segs) {
    const x0 = clamp(Math.floor((s.minX + half) / GRID_CELL), 0, gn - 1);
    const x1 = clamp(Math.floor((s.maxX + half) / GRID_CELL), 0, gn - 1);
    const z0 = clamp(Math.floor((s.minZ + half) / GRID_CELL), 0, gn - 1);
    const z1 = clamp(Math.floor((s.maxZ + half) / GRID_CELL), 0, gn - 1);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const k = z * gn + x;
        if (cells[k] === EMPTY) cells[k] = [];
        cells[k].push(s);
      }
    }
  }

  return { segs, cells, gn, half, polys, trunkCount, polylines };
}

const EMPTY = [];

export function cellOf(net, x, z) {
  const gx = clamp(Math.floor((x + net.half) / GRID_CELL), 0, net.gn - 1);
  const gz = clamp(Math.floor((z + net.half) / GRID_CELL), 0, net.gn - 1);
  return net.cells[gz * net.gn + gx];
}
