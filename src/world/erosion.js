// Hydraulic + thermal erosion approximations on a coarse grid.
//
// This is the single biggest contributor to the terrain not looking like noise:
// droplet erosion produces dendritic drainage networks, V-notch gullies and
// alluvial fans, and the thermal pass produces talus/scree slopes under cliffs.
//
// Everything is written as generators so the bake can be spread across frames
// behind a loading bar.

import { Rng } from '../core/rng.js';
import { clamp, sampleGrid } from '../core/math.js';

/** Precomputed radial brush used to spread erosion/deposition smoothly. */
function makeBrush(radius) {
  const offsets = [];
  const weights = [];
  let sum = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > radius * radius) continue;
      const w = 1 - Math.sqrt(d2) / (radius + 1);
      offsets.push(dx, dy);
      weights.push(w);
      sum += w;
    }
  }
  for (let i = 0; i < weights.length; i++) weights[i] /= sum;
  return { offsets: new Int16Array(offsets), weights: new Float32Array(weights), count: weights.length };
}

/**
 * Hydraulic erosion.
 * @param {Float32Array} h   heightmap, res*res, modified in place
 * @param {number} res
 * @param {object} opts
 * @yields {number} progress 0..1
 */
export function* hydraulic(h, res, opts = {}) {
  const {
    droplets = 220000,
    maxSteps = 72,
    inertia = 0.055,
    capacityFactor = 3.4,
    minSlope = 0.0012,
    erodeSpeed = 0.32,
    depositSpeed = 0.28,
    evaporate = 0.016,
    gravity = 10,
    initialWater = 1,
    initialSpeed = 1,
    brushRadius = 3,
    hardness = 0,        // how much steep rock resists being cut
    cellSize = 8,
    seed = 9001,
    flow = null, // optional Float32Array to accumulate water throughput
  } = opts;

  const rng = new Rng(seed);
  const brush = makeBrush(brushRadius);
  const bo = brush.offsets;
  const bw = brush.weights;
  const bc = brush.count;
  const batch = Math.max(1, Math.floor(droplets / 180));

  for (let n = 0; n < droplets; n++) {
    let px = rng.range(brushRadius + 1, res - brushRadius - 2);
    let py = rng.range(brushRadius + 1, res - brushRadius - 2);
    let dx = 0;
    let dy = 0;
    let speed = initialSpeed;
    let water = initialWater;
    let sediment = 0;

    for (let step = 0; step < maxSteps; step++) {
      const nx = px | 0;
      const ny = py | 0;
      const cellOfsX = px - nx;
      const cellOfsY = py - ny;
      const i = ny * res + nx;

      // bilinear height and gradient
      const hNW = h[i];
      const hNE = h[i + 1];
      const hSW = h[i + res];
      const hSE = h[i + res + 1];
      const gx = (hNE - hNW) * (1 - cellOfsY) + (hSE - hSW) * cellOfsY;
      const gy = (hSW - hNW) * (1 - cellOfsX) + (hSE - hNE) * cellOfsX;
      const height =
        hNW * (1 - cellOfsX) * (1 - cellOfsY) +
        hNE * cellOfsX * (1 - cellOfsY) +
        hSW * (1 - cellOfsX) * cellOfsY +
        hSE * cellOfsX * cellOfsY;

      dx = dx * inertia - gx * (1 - inertia);
      dy = dy * inertia - gy * (1 - inertia);
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) break;
      dx /= len;
      dy /= len;
      px += dx;
      py += dy;

      if (px < brushRadius + 1 || px >= res - brushRadius - 2 || py < brushRadius + 1 || py >= res - brushRadius - 2)
        break;

      const newHeight = sampleGrid(h, res, px, py);
      const dh = newHeight - height;

      if (flow) flow[i] += water;

      const capacity = Math.max(-dh * speed * water * capacityFactor, minSlope * capacityFactor);

      if (sediment > capacity || dh > 0) {
        // deposit: either fill the pit we just climbed into, or drop the excess
        const amount = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * depositSpeed;
        sediment -= amount;
        // bilinear deposit into the 4 cells we came from
        h[i] += amount * (1 - cellOfsX) * (1 - cellOfsY);
        h[i + 1] += amount * cellOfsX * (1 - cellOfsY);
        h[i + res] += amount * (1 - cellOfsX) * cellOfsY;
        h[i + res + 1] += amount * cellOfsX * cellOfsY;
      } else {
        // Steep rock resists: without this, droplets carve uniformly spaced
        // parallel gullies straight down every face, which reads as fluting.
        const steep = Math.hypot(gx, gy) / cellSize;
        const resist = 1 / (1 + hardness * steep);
        const amount = Math.min((capacity - sediment) * erodeSpeed * resist, -dh);
        for (let b = 0; b < bc; b++) {
          const ox = nx + bo[b * 2];
          const oy = ny + bo[b * 2 + 1];
          const oi = oy * res + ox;
          const w = amount * bw[b];
          const taken = h[oi] < w ? h[oi] : w;
          h[oi] -= taken;
          sediment += taken;
        }
      }

      speed = Math.sqrt(Math.max(0, speed * speed + -dh * gravity));
      water *= 1 - evaporate;
      if (water < 0.012) break;
    }

    if (n % batch === 0) yield n / droplets;
  }
  yield 1;
}

/**
 * Thermal erosion / talus relaxation: wherever the slope between neighbours
 * exceeds the talus angle, move material downhill. Produces scree slopes.
 */
export function* thermal(h, res, opts = {}) {
  const { passes = 28, talus = 0.62, cellSize = 8, rate = 0.42 } = opts;
  const maxDelta = talus * cellSize;
  const delta = new Float32Array(res * res);
  for (let p = 0; p < passes; p++) {
    delta.fill(0);
    for (let y = 1; y < res - 1; y++) {
      for (let x = 1; x < res - 1; x++) {
        const i = y * res + x;
        const hi = h[i];
        let total = 0;
        let d0 = 0, d1 = 0, d2 = 0, d3 = 0;
        let t = hi - h[i - 1]; if (t > maxDelta) { d0 = t - maxDelta; total += d0; }
        t = hi - h[i + 1]; if (t > maxDelta) { d1 = t - maxDelta; total += d1; }
        t = hi - h[i - res]; if (t > maxDelta) { d2 = t - maxDelta; total += d2; }
        t = hi - h[i + res]; if (t > maxDelta) { d3 = t - maxDelta; total += d3; }
        if (total <= 0) continue;
        const move = Math.min(total, (hi - h[i - 1] + hi - h[i + 1]) * 0.25 + maxDelta) * rate;
        const scale = move / total;
        if (d0 > 0) delta[i - 1] += d0 * scale;
        if (d1 > 0) delta[i + 1] += d1 * scale;
        if (d2 > 0) delta[i - res] += d2 * scale;
        if (d3 > 0) delta[i + res] += d3 * scale;
        delta[i] -= move;
      }
    }
    for (let i = 0; i < h.length; i++) h[i] += delta[i];
    yield (p + 1) / passes;
  }
}

/**
 * Sky occlusion (ambient occlusion) by horizon marching in N directions.
 * Low frequency by nature, so it runs on a decimated grid.
 */
export function* skyOcclusion(h, res, out, outRes, cellSize, opts = {}) {
  const { dirs = 10, steps = 14, maxDist = 1400 } = opts;
  const ratio = res / outRes;
  const angles = [];
  for (let d = 0; d < dirs; d++) angles.push((d / dirs) * Math.PI * 2);
  for (let y = 0; y < outRes; y++) {
    for (let x = 0; x < outRes; x++) {
      const sx = x * ratio;
      const sy = y * ratio;
      const h0 = sampleGrid(h, res, sx, sy);
      let occ = 0;
      for (let d = 0; d < dirs; d++) {
        const ca = Math.cos(angles[d]);
        const sa = Math.sin(angles[d]);
        let maxTan = 0;
        for (let s = 1; s <= steps; s++) {
          const dist = (s / steps) * (s / steps) * maxDist;
          const px = sx + (ca * dist) / cellSize;
          const py = sy + (sa * dist) / cellSize;
          if (px < 0 || py < 0 || px > res - 1 || py > res - 1) break;
          const hh = sampleGrid(h, res, px, py);
          const tan = (hh - h0) / dist;
          if (tan > maxTan) maxTan = tan;
        }
        occ += Math.atan(maxTan) / (Math.PI * 0.5);
      }
      out[y * outRes + x] = clamp(1 - occ / dirs, 0, 1);
    }
    if ((y & 15) === 0) yield y / outRes;
  }
  yield 1;
}

/** Gaussian-ish blur (separable box x3) used to smooth flow and AO maps. */
export function blurGrid(grid, res, radius = 2, passes = 2) {
  const tmp = new Float32Array(grid.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        let sum = 0, n = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = x + k;
          if (xx < 0 || xx >= res) continue;
          sum += grid[y * res + xx];
          n++;
        }
        tmp[y * res + x] = sum / n;
      }
    }
    for (let x = 0; x < res; x++) {
      for (let y = 0; y < res; y++) {
        let sum = 0, n = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = y + k;
          if (yy < 0 || yy >= res) continue;
          sum += tmp[yy * res + x];
          n++;
        }
        grid[y * res + x] = sum / n;
      }
    }
  }
  return grid;
}
