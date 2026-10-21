// Volumetric features: arches, natural bridges, tunnels, caves, overhangs
// and spire clusters.
//
// A heightfield cannot express anything you can fly *under*, so these are
// authored as signed distance fields composed from primitives and blended
// with the local terrain, then meshed once at load with surface nets.
//
// The visual/collision contract: the mesher and the collision query call the
// same `sd()` closure. Inside a feature's footprint the heightfield chunks
// punch a hole and the feature mesh — which includes the terrain as part of
// its own field — covers that footprint completely, with a skirt around the
// border to hide the sub-metre difference between the isosurface and the
// heightfield's bilinear mesh. So there is exactly one surface, and it is the
// one you collide with.

import * as THREE from 'three';
import { surfaceNets } from './mesher.js';
import { WORLD } from './field.js';
import {
  sdEllipsoid, sdRoundBox, sdCapsule, sdCone, opSmoothUnion, opSmoothSub,
} from './sdf.js';
import { clamp, clamp01, lerp, smoothstep } from '../core/math.js';

// Metres: beyond this the meshes hide and the holes in the heightfield
// close up.
//
// It cannot go much higher. A feature footprint forces its chunks to the
// finest LOD -- a hole punched in a chunk drawn without its feature would
// show daylight through the mountain -- so the range is a direct multiplier
// on triangle count: 2500 took the test scene from 117k triangles at 60 fps
// to 536k at 30. Being able to find an arch is solved by pointing at it
// (see the feature cue on the HUD), not by drawing it from further away.
export const FEATURE_RANGE = 1700;

// ---------------------------------------------------------------- authoring

const AUTHORED = [
  { name: 'Hollow Arch', kind: 'arch', hint: [-1250, -420], searchR: 520, span: 165, thick: 46, open: [74, 58], note: 'Fly the big one' },
  { name: "Needle's Eye", kind: 'arch', hint: [-540, -2280], searchR: 620, span: 86, thick: 26, open: [19, 23], note: 'Tight. Very tight' },
  { name: 'Chapel Arch', kind: 'arch', hint: [520, 1180], searchR: 460, span: 120, thick: 36, open: [44, 40] },
  { name: 'Raven Arch', kind: 'arch', hint: [2980, -2420], searchR: 500, span: 100, thick: 32, open: [36, 33] },
  { name: 'The Keyhole', kind: 'arch', hint: [2420, 1980], searchR: 620, span: 96, thick: 30, open: [28, 34] },
  { name: "Devil's Bridge", kind: 'bridge', hint: [2180, 2640], searchR: 300, span: 150, thick: 40, open: [62, 44] },
  { name: 'The Throat', kind: 'tunnel', hint: [-1230, -1880], searchR: 480, length: 150, radius: 15 },
  { name: 'Teeth Tunnel', kind: 'tunnel', hint: [1100, -1500], searchR: 680, length: 145, radius: 13 },
  { name: 'The Gullet', kind: 'cave', hint: [-3060, 1500], searchR: 520, length: 165, radius: 14 },
  { name: 'Lantern Cave', kind: 'cave', hint: [-760, -1320], searchR: 660, length: 160, radius: 12 },
  { name: 'Anvil Roof', kind: 'overhang', hint: [2240, 1870], searchR: 620, size: 70 },
  { name: 'The Needles', kind: 'spires', hint: [2560, 2280], searchR: 560, count: 9, size: 90 },
  { name: 'Lac Blanc Arch', kind: 'arch', hint: [-1900, 1760], searchR: 620, span: 104, thick: 32, open: [31, 35] },
  { name: 'Glacier Tunnel', kind: 'tunnel', hint: [-520, -700], searchR: 620, length: 140, radius: 13 },
  { name: 'West Spires', kind: 'spires', hint: [-3220, 980], searchR: 560, count: 7, size: 78 },

  // Jutting platforms: roofs you can fly under and stand on top of. The
  // range is twice as tall as it was and the outer ridges are new ground
  // entirely, so there was a lot of big face with nothing on it.
  { name: 'Skyline Roof', kind: 'overhang', hint: [-180, 300], searchR: 700, size: 82 },
  { name: 'The Pulpit', kind: 'overhang', hint: [-3620, -4420], searchR: 700, size: 74 },
  { name: 'Northwall Shelf', kind: 'overhang', hint: [380, -4880], searchR: 760, size: 90 },
  { name: 'Rampart Ledge', kind: 'overhang', hint: [4060, -860], searchR: 700, size: 78 },
  { name: 'Citadel Roof', kind: 'overhang', hint: [-1320, -1980], searchR: 640, size: 68 },
  { name: 'Teeth Shelf', kind: 'overhang', hint: [820, -2420], searchR: 680, size: 72 },
  { name: 'Blanche Ledge', kind: 'overhang', hint: [4280, 3220], searchR: 700, size: 76 },
  { name: 'Westwatch Roof', kind: 'overhang', hint: [-4200, 440], searchR: 700, size: 80 },
  { name: 'Gendarme Arch', kind: 'arch', hint: [-3640, -4480], searchR: 640, span: 112, thick: 34, open: [36, 38] },
  { name: 'Rampart Arch', kind: 'arch', hint: [4040, -1680], searchR: 640, span: 98, thick: 30, open: [30, 32] },
  { name: 'North Spires', kind: 'spires', hint: [160, -4700], searchR: 620, count: 8, size: 92 },
  { name: 'Blanche Spires', kind: 'spires', hint: [4180, 3560], searchR: 600, count: 7, size: 84 },
];

// --------------------------------------------------------------- site search

/**
 * Arch sites want a notch: two abutments of comparable height with a dip
 * between them, and the ground falling away across the span so there is air
 * under the opening.
 */
function findArchSite(field, hx, hz, R, span) {
  let best = null;
  const step = Math.max(36, R / 8);
  for (let dz = -R; dz <= R; dz += step) {
    for (let dx = -R; dx <= R; dx += step) {
      if (dx * dx + dz * dz > R * R) continue;
      const x = hx + dx;
      const z = hz + dz;
      const hc = field.height(x, z);
      for (let a = 0; a < 10; a++) {
        const ang = (a / 10) * Math.PI;
        const ax = Math.cos(ang);
        const az = Math.sin(ang);
        const h1 = field.height(x + ax * span * 0.5, z + az * span * 0.5);
        const h2 = field.height(x - ax * span * 0.5, z - az * span * 0.5);
        const ends = Math.min(h1, h2);
        const rise = ends - hc;
        // a notch, not a hillside: the two abutments must be comparable and
        // the dip between them has to be deep enough to put a hole in
        if (rise < 22 || rise > 190) continue;
        if (Math.abs(h1 - h2) > rise * 1.3 + 25) continue;
        // air across the span on at least one side
        const c1 = field.height(x - az * span * 0.6, z + ax * span * 0.6);
        const c2 = field.height(x + az * span * 0.6, z - ax * span * 0.6);
        const across = Math.max(hc - c1, hc - c2);
        if (across < 10) continue;
        // The footprint has to be a notch, not a piece of cliff: if the
        // terrain inside it spans hundreds of metres the feature box swells
        // to match and the arch disappears inside a slab of hillside.
        let lo = Infinity;
        let hi = -Infinity;
        for (let s2 = -1; s2 <= 1; s2 += 1) {
          for (let t2 = -1; t2 <= 1; t2 += 1) {
            const hh = field.height(
              x + ax * span * 0.5 * s2 - az * span * 0.3 * t2,
              z + az * span * 0.5 * s2 + ax * span * 0.3 * t2,
            );
            if (hh < lo) lo = hh;
            if (hh > hi) hi = hh;
          }
        }
        if (hi - lo > span * 1.25) continue;
        const score = Math.min(rise, 110) * 2.0 + Math.min(across, 150) * 1.3
          - Math.abs(h1 - h2) * 0.5 - (hi - lo) * 0.45 - Math.hypot(dx, dz) * 0.07;
        if (!best || score > best.score) {
          best = { x, z, y: hc, ang, rise, across, ends, score };
        }
      }
    }
  }
  return best;
}

/** Tunnels want a ridge: high in the middle, lower at both ends of the bore. */
function findTunnelSite(field, hx, hz, R, length) {
  let best = null;
  const step = Math.max(40, R / 7);
  for (let dz = -R; dz <= R; dz += step) {
    for (let dx = -R; dx <= R; dx += step) {
      if (dx * dx + dz * dz > R * R) continue;
      const x = hx + dx;
      const z = hz + dz;
      const hc = field.height(x, z);
      for (let a = 0; a < 10; a++) {
        const ang = (a / 10) * Math.PI;
        const ax = Math.cos(ang);
        const az = Math.sin(ang);
        const h1 = field.height(x + ax * length * 0.5, z + az * length * 0.5);
        const h2 = field.height(x - ax * length * 0.5, z - az * length * 0.5);
        // both mouths must be well below the crest
        const drop = Math.min(hc - h1, hc - h2);
        if (drop < 32 || drop > 150) continue;
        // and the crest must be a ridge, not a dome: check it stays high along
        let sag = 0;
        for (let t = -0.3; t <= 0.3; t += 0.15) {
          sag = Math.max(sag, hc - field.height(x + ax * length * t, z + az * length * t));
        }
        const score = drop * 2.0 - sag * 1.6 - Math.hypot(dx, dz) * 0.1;
        if (!best || score > best.score) {
          best = { x, z, y: hc, ang, drop, score, mouthY: Math.max(h1, h2) };
        }
      }
    }
  }
  return best;
}

/**
 * A steep but not vertical face, with the downhill direction. `maxRelief`
 * keeps the site off kilometre-high walls, where the feature's box would
 * have to contain the whole cliff.
 */
function findFaceSite(field, hx, hz, R, extent = 120, maxRelief = 260) {
  let best = null;
  const step = Math.max(35, R / 8);
  for (let dz = -R; dz <= R; dz += step) {
    for (let dx = -R; dx <= R; dx += step) {
      if (dx * dx + dz * dz > R * R) continue;
      const x = hx + dx;
      const z = hz + dz;
      const n = field.normal(x, z, null, 12);
      const steep = 1 - n.y;
      if (steep < 0.42 || steep > 0.88) continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (let b = 0; b < 8; b++) {
        const a2 = (b / 8) * Math.PI * 2;
        const hh = field.height(x + Math.cos(a2) * extent, z + Math.sin(a2) * extent);
        if (hh < lo) lo = hh;
        if (hh > hi) hi = hh;
      }
      if (hi - lo > maxRelief) continue;
      const score = steep * 100 - (hi - lo) * 0.25 - Math.hypot(dx, dz) * 0.06;
      if (!best || score > best.score) {
        const hl = Math.hypot(n.x, n.z) || 1;
        best = { x, z, y: field.height(x, z), dx: n.x / hl, dz: n.z / hl, steep, score };
      }
    }
  }
  return best;
}

// ------------------------------------------------------------------ builders

/** 2D ellipse distance, used for arch openings extruded across the thickness. */
function ellipse2(u, v, ru, rv) {
  const a = u / ru;
  const b = v / rv;
  const k0 = Math.hypot(a, b);
  if (k0 < 1e-6) return -Math.min(ru, rv);
  const k1 = Math.hypot(a / ru, b / rv);
  return (k0 * (k0 - 1)) / k1;
}

function buildArch(field, def, site, flatTop) {
  const ax = Math.cos(site.ang);
  const az = Math.sin(site.ang);
  const span = def.span;
  const thick = def.thick;

  // the floor of the notch under the span
  let floor = Infinity;
  for (let t = -0.42; t <= 0.42; t += 0.07) {
    floor = Math.min(floor, field.height(site.x + ax * span * t, site.z + az * span * t));
  }
  const ends = site.ends;
  const notch = Math.max(14, ends - floor);

  // The opening has to fit inside the notch, and the roof has to sit ABOVE
  // the abutments - otherwise the whole block is buried in the hillside and
  // all you get is a cave-shaped scoop.
  // The opening is at most a third of the span: at 80 % the legs came out
  // paper-thin and the whole thing read as a torn sheet rather than rock.
  const ow = Math.min(def.open[0], span * 0.31);
  const oh = Math.max(def.open[1], ow * 0.8);
  const openCy = floor + oh + 3;
  const roofY = Math.max(openCy + oh * 0.5 + thick * 0.6, ends + thick * 0.4);
  const baseY = floor - 30;
  const blockCy = (baseY + roofY) * 0.5;
  const blockHy = (roofY - baseY) * 0.5;

  const noise = field.noise;
  const rough = (x, y, z, amp) =>
    (noise.noise3(x * 0.055, y * 0.055, z * 0.055) * 0.68 +
      noise.noise3(x * 0.17, y * 0.17, z * 0.17) * 0.32) * amp;

  const uLim = span * 0.5 + 26;
  const wLim = thick * 0.5 + 26;
  const sd = (x, y, z, h) => {
    const px = x - site.x;
    const pz = z - site.z;
    const u = px * ax + pz * az;
    const w = -px * az + pz * ax;
    const terrain = y - h;
    // Outside the block's reach the field is just the terrain. Most samples
    // in a feature's box are here, so this early-out is what keeps the bake
    // affordable once the box is tall enough to contain the hillside.
    if (u < -uLim || u > uLim || w < -wLim || w > wLim ||
        y < baseY - 26 || y > roofY + 26) return terrain;

    // A rounded block, not an ellipsoid: an ellipsoid tapers to nothing at
    // the ends, which is exactly where an arch needs its legs.
    let block = sdRoundBox(
      u, y, w, 0, blockCy, 0,
      span * 0.5, blockHy, thick * 0.5,
      flatTop ? 9 : 15,
    );
    block += rough(x, y, z, 5.2);

    let hole = ellipse2(u, y - openCy, ow, oh);
    hole += rough(x + 91, y - 37, z + 13, 2.0);

    let d = opSmoothUnion(terrain, block, 15);
    d = opSmoothSub(hole, d, 7);
    return d;
  };

  const pad = 30;
  const halfU = span * 0.5 + pad;
  const halfW = thick * 0.5 + pad;
  const ex = Math.abs(ax) * halfU + Math.abs(az) * halfW;
  const ez = Math.abs(az) * halfU + Math.abs(ax) * halfW;
  return {
    sd,
    bounds: {
      x0: site.x - ex, x1: site.x + ex,
      z0: site.z - ez, z1: site.z + ez,
      y0: floor - 46, y1: roofY + 22,
    },
    // the portal faces ACROSS the span: that is the direction you fly through
    portal: {
      x: site.x, y: openCy, z: site.z,
      nx: -az, ny: 0, nz: ax,
      r: Math.min(ow, oh) * 1.15,
    },
    anchor: { x: site.x, y: openCy, z: site.z },
    tight: Math.min(ow, oh) * 2,
  };
}

function buildTunnel(field, def, site, curved) {
  const ax = Math.cos(site.ang);
  const az = Math.sin(site.ang);
  const len = def.length;
  const r = def.radius;
  const boreY = site.mouthY - r * 0.35;

  // a slight dog-leg makes a cave read as a cave rather than a pipe
  const bend = curved ? r * 2.6 : 0;
  const bx = -az * bend;
  const bz = ax * bend;

  const a = { x: site.x - ax * len * 0.5, y: boreY - 4, z: site.z - az * len * 0.5 };
  const m = { x: site.x + bx, y: boreY + (curved ? r * 0.5 : 0), z: site.z + bz };
  const b = { x: site.x + ax * len * 0.5, y: boreY - 4, z: site.z + az * len * 0.5 };

  const noise = field.noise;
  const rough = (x, y, z, amp) =>
    (noise.noise3(x * 0.06, y * 0.06, z * 0.06) * 0.7 +
      noise.noise3(x * 0.19, y * 0.19, z * 0.19) * 0.3) * amp;

  const bx0 = Math.min(a.x, m.x, b.x) - r * 2.6;
  const bx1 = Math.max(a.x, m.x, b.x) + r * 2.6;
  const bz0 = Math.min(a.z, m.z, b.z) - r * 2.6;
  const bz1 = Math.max(a.z, m.z, b.z) + r * 2.6;
  const by0 = Math.min(a.y, m.y, b.y) - r * 2.6;
  const by1 = Math.max(a.y, m.y, b.y) + r * 2.6;
  const sd = (x, y, z, h) => {
    const terrain = y - h;
    if (x < bx0 || x > bx1 || z < bz0 || z > bz1 || y < by0 || y > by1) return terrain;
    let bore = Math.min(
      sdCapsule(x, y, z, a.x, a.y, a.z, m.x, m.y, m.z, r),
      sdCapsule(x, y, z, m.x, m.y, m.z, b.x, b.y, b.z, r),
    );
    // a wider chamber in the middle of the caves
    if (curved) {
      bore = Math.min(bore, sdEllipsoid(x, y, z, m.x, m.y + r * 0.3, m.z, r * 1.9, r * 1.5, r * 1.9));
    }
    bore += rough(x, y, z, r * 0.16);
    return opSmoothSub(bore, terrain, 5);
  };

  const pad = r + 26;
  const halfU = len * 0.5 + pad;
  const halfW = Math.abs(bend) + pad;
  const ex = Math.abs(ax) * halfU + Math.abs(az) * halfW;
  const ez = Math.abs(az) * halfU + Math.abs(ax) * halfW;
  return {
    sd,
    bounds: {
      x0: site.x - ex, x1: site.x + ex,
      z0: site.z - ez, z1: site.z + ez,
      y0: Math.min(a.y, m.y, b.y) - r * 2.8,
      y1: Math.max(a.y, m.y, b.y) + r * 2.8,
    },
    // on the bore itself, not the site centre: a curved cave's midpoint is
    // offset sideways and the site centre is solid rock
    portal: { x: m.x, y: m.y, z: m.z, nx: ax, ny: 0, nz: az, r: r * 1.1 },
    anchor: { x: site.x, y: boreY, z: site.z },
    tight: r * 2,
  };
}

function buildOverhang(field, def, site) {
  const s = def.size;
  const ox = site.dx;
  const oz = site.dz;
  const cx = site.x + ox * s * 0.42;
  const cz = site.z + oz * s * 0.42;
  const cy = site.y + s * 0.12;
  const noise = field.noise;

  const lim = s * 0.95;
  const sd = (x, y, z, h) => {
    const terrain = y - h;
    if (Math.abs(x - cx) > lim || Math.abs(z - cz) > lim ||
        y < cy - s * 0.9 || y > cy + s * 0.45) return terrain;
    let roof = sdEllipsoid(x, y, z, cx, cy, cz, s * 0.72, s * 0.17, s * 0.62);
    roof += (noise.noise3(x * 0.05, y * 0.05, z * 0.05) * 0.7 +
      noise.noise3(x * 0.16, y * 0.16, z * 0.16) * 0.3) * s * 0.07;
    let d = opSmoothUnion(terrain, roof, 14);
    // scoop out under the lip so it is a roof, not a lump
    const scoop = sdEllipsoid(x, y, z, cx + ox * s * 0.1, cy - s * 0.38, cz + oz * s * 0.1,
      s * 0.62, s * 0.3, s * 0.54);
    d = opSmoothSub(scoop, d, 9);
    return d;
  };

  const pad = s * 0.95 + 30;
  return {
    sd,
    bounds: {
      x0: cx - pad, x1: cx + pad, z0: cz - pad, z1: cz + pad,
      y0: cy - s * 0.95, y1: cy + s * 0.5,
    },
    portal: null,
    anchor: { x: cx, y: cy - s * 0.25, z: cz },
    tight: s * 0.5,
  };
}

function buildSpires(field, def, site, rng) {
  const s = def.size;
  const n = def.count;
  const towers = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const rad = s * (0.22 + rng.float() * 0.78);
    const x = site.x + Math.cos(a) * rad;
    const z = site.z + Math.sin(a) * rad;
    const base = field.height(x, z);
    const hgt = s * rng.range(0.42, 1.05);
    towers.push({ x, z, base, hgt, r0: s * rng.range(0.055, 0.1), r1: s * rng.range(0.02, 0.05) });
  }
  const noise = field.noise;

  const sd = (x, y, z, h) => {
    let d = y - h;
    for (let i = 0; i < towers.length; i++) {
      const t = towers[i];
      if (Math.abs(x - t.x) > t.r0 * 3.2 + 14 || Math.abs(z - t.z) > t.r0 * 3.2 + 14) continue;
      if (y < t.base - 16 || y > t.base + t.hgt + 14) continue;
      let c = sdCone(x, y, z, t.x, t.base - 10, t.z, t.x, t.base + t.hgt, t.z, t.r0, t.r1);
      c += (noise.noise3(x * 0.07, y * 0.045, z * 0.07) * 0.72 +
        noise.noise3(x * 0.22, y * 0.15, z * 0.22) * 0.28) * t.r0 * 0.6;
      d = opSmoothUnion(d, c, 7);
    }
    return d;
  };

  let maxTop = -Infinity;
  for (const t of towers) maxTop = Math.max(maxTop, t.base + t.hgt);
  const pad = s + 34;
  return {
    sd,
    bounds: {
      x0: site.x - pad, x1: site.x + pad, z0: site.z - pad, z1: site.z + pad,
      y0: site.y - 80, y1: maxTop + 24,
    },
    portal: null,
    anchor: { x: site.x, y: site.y + s * 0.4, z: site.z },
    tight: s * 0.2,
  };
}


/**
 * A curtain around the footprint border, dropped below the terrain.
 *
 * The feature mesh ends at its bounding box on an isosurface; the heightfield
 * chunks outside it end on a bilinear mesh. Those two agree to within a metre
 * or so, which is a visible crack when you are flying three metres off the
 * rock. The curtain hides it from every angle and costs a few hundred
 * triangles.
 */
function buildSkirt(field, b, step, depth = 22) {
  const pts = [];
  const push = (x, z) => pts.push(x, z);
  for (let x = b.x0; x < b.x1; x += step) push(x, b.z0);
  for (let z = b.z0; z < b.z1; z += step) push(b.x1, z);
  for (let x = b.x1; x > b.x0; x -= step) push(x, b.z1);
  for (let z = b.z1; z > b.z0; z -= step) push(b.x0, z);
  const n = pts.length / 2;
  const positions = new Float32Array(n * 2 * 3);
  const normals = new Float32Array(n * 2 * 3);
  const surf = new Float32Array(n * 2 * 4);
  const idx = [];
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2];
    const z = pts[i * 2 + 1];
    const h = field.height(x, z);
    const cx = (b.x0 + b.x1) * 0.5;
    const cz = (b.z0 + b.z1) * 0.5;
    let nx = x - cx;
    let nz = z - cz;
    const l = Math.hypot(nx, nz) || 1;
    nx /= l; nz /= l;
    for (let k = 0; k < 2; k++) {
      const o = (i * 2 + k) * 3;
      positions[o] = x;
      positions[o + 1] = k === 0 ? h + 1.2 : h - depth;
      positions[o + 2] = z;
      normals[o] = nx;
      normals[o + 1] = 0.12;
      normals[o + 2] = nz;
      const q = (i * 2 + k) * 4;
      surf[q] = field.sampleFlow(x, z);
      surf[q + 1] = field.sampleAO(x, z) * 0.7;
      surf[q + 2] = 0;
      surf[q + 3] = 1;
    }
    const a = i * 2;
    const bb = ((i + 1) % n) * 2;
    idx.push(a, a + 1, bb, bb, a + 1, bb + 1);
  }
  return { positions, normals, surf, indices: idx, count: n * 2 };
}

// --------------------------------------------------------------- the feature set

export class FeatureSet {
  constructor(field, material, rng, opts = {}) {
    this.field = field;
    this.material = material;
    this.rng = rng;
    this.group = new THREE.Group();
    this.list = [];
    this.holes = [];
    this.cellSize = opts.cellSize ?? 3.6;
    this.maxCells = opts.maxCells ?? 74;
    this._q = { x: 0, y: 0, z: 0 };
  }

  /** Generator so the loading screen can show progress. */
  *build() {
    const field = this.field;
    for (let i = 0; i < AUTHORED.length; i++) {
      const def = AUTHORED[i];
      yield { progress: i / AUTHORED.length, label: `Carving ${def.name}` };
      let built = null;
      try {
        built = this.place(def);
      } catch (e) {
        console.warn('feature failed', def.name, e);
      }
      if (!built) continue;
      if (this.overlaps(built.bounds)) continue;
      // Every feature's box has to contain the terrain surface inside its
      // footprint, tunnels included: a box that only hugs the bore gets its
      // terrain surface clipped at the mask boundary, which tears.
      this.fitBounds(built.bounds);
      // A box whose vertical extent dwarfs its footprint means the site was
      // a cliff, not the landform this feature wants. Skip it rather than
      // mesh a slab of hillside with a detail buried in it.
      const bb = built.bounds;
      const wide = Math.max(bb.x1 - bb.x0, bb.z1 - bb.z0);
      if (bb.y1 - bb.y0 > wide * 3.2) continue;
      const mesh = this.mesh(built, def);
      if (!mesh) continue;
      const mask = this.buildMask(built.bounds);
      const entry = {
        name: def.name,
        kind: def.kind,
        note: def.note,
        bounds: built.bounds,
        sd: built.sd,
        portal: built.portal,
        tight: built.tight,
        x: built.anchor.x,
        y: built.anchor.y,
        z: built.anchor.z,
        mesh,
        mask,
        tris: mesh.geometry.index.count / 3,
      };
      this.list.push(entry);
      this.holes.push({
        x0: built.bounds.x0, z0: built.bounds.z0,
        x1: built.bounds.x1, z1: built.bounds.z1,
      });
      this.group.add(mesh);
    }
    yield { progress: 1, label: 'Features ready' };
  }

  place(def) {
    const f = this.field;
    const [hx, hz] = def.hint;
    switch (def.kind) {
      case 'arch': {
        const site = findArchSite(f, hx, hz, def.searchR, def.span);
        return site ? buildArch(f, def, site, false) : null;
      }
      case 'bridge': {
        const site = findArchSite(f, hx, hz, def.searchR, def.span);
        return site ? buildArch(f, def, site, true) : null;
      }
      case 'tunnel': {
        const site = findTunnelSite(f, hx, hz, def.searchR, def.length);
        return site ? buildTunnel(f, def, site, false) : null;
      }
      case 'cave': {
        const site = findTunnelSite(f, hx, hz, def.searchR, def.length);
        return site ? buildTunnel(f, def, site, true) : null;
      }
      case 'overhang': {
        const site = findFaceSite(f, hx, hz, def.searchR, def.size, def.size * 2.2);
        return site ? buildOverhang(f, def, site) : null;
      }
      case 'spires': {
        const site = findFaceSite(f, hx, hz, def.searchR, def.size, def.size * 1.5);
        if (!site) return null;
        return buildSpires(f, def, { ...site, y: f.height(site.x, site.z) }, this.rng);
      }
      default: return null;
    }
  }

  /**
   * Grows a feature's vertical bounds to contain the terrain inside its
   * footprint. Without this the surface-nets box misses the hillside in the
   * corners, the mesh simply is not generated there, and since the
   * heightfield has already been removed you can see sky through the
   * mountain.
   */
  fitBounds(b) {
    const f = this.field;
    let lo = Infinity;
    let hi = -Infinity;
    const n = 9;
    for (let k = 0; k <= n; k++) {
      const z = b.z0 + ((b.z1 - b.z0) * k) / n;
      for (let i = 0; i <= n; i++) {
        const h = f.height(b.x0 + ((b.x1 - b.x0) * i) / n, z);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    b.y0 = Math.min(b.y0, lo - 26);
    b.y1 = Math.max(b.y1, hi + 22);
  }

  /**
   * Which parts of the heightfield this feature actually replaces.
   *
   * A hole the size of the whole bounding box is wrong for a tunnel: the
   * terrain surface over the middle of the ridge is still correct, and
   * removing it would leave a gap the feature mesh never fills. The mask
   * marks only the cells where the terrain surface passes through the
   * feature's mesh box, which for a tunnel is just the two mouths and for
   * an arch is the whole footprint.
   */
  buildMask(b, cell = 4) {
    const f = this.field;
    const nx = Math.max(2, Math.ceil((b.x1 - b.x0) / cell));
    const nz = Math.max(2, Math.ceil((b.z1 - b.z0) / cell));
    const data = new Uint8Array(nx * nz);
    const sx = (b.x1 - b.x0) / nx;
    const sz = (b.z1 - b.z0) / nz;
    let any = false;
    for (let k = 0; k < nz; k++) {
      const z = b.z0 + (k + 0.5) * sz;
      for (let i = 0; i < nx; i++) {
        const h = f.height(b.x0 + (i + 0.5) * sx, z);
        if (h >= b.y0 && h <= b.y1) { data[k * nx + i] = 1; any = true; }
      }
    }
    // grow by one cell so the feature mesh always overlaps rather than
    // leaving a hairline of heightfield standing inside it
    const grown = new Uint8Array(data);
    for (let k = 0; k < nz; k++) {
      for (let i = 0; i < nx; i++) {
        if (!data[k * nx + i]) continue;
        for (let dk = -1; dk <= 1; dk++) {
          for (let di = -1; di <= 1; di++) {
            const kk = k + dk;
            const ii = i + di;
            if (kk < 0 || ii < 0 || kk >= nz || ii >= nx) continue;
            grown[kk * nx + ii] = 1;
          }
        }
      }
    }
    return { data: grown, nx, nz, x0: b.x0, z0: b.z0, sx, sz, any };
  }

  /** True where the heightfield must give way to a feature mesh. */
  hidesQuad(x, z) {
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const b = list[i].bounds;
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      const m = list[i].mask;
      if (!m || !m.any) continue;
      const ix = Math.min(m.nx - 1, Math.max(0, ((x - m.x0) / m.sx) | 0));
      const iz = Math.min(m.nz - 1, Math.max(0, ((z - m.z0) / m.sz) | 0));
      if (m.data[iz * m.nx + ix]) return true;
    }
    return false;
  }

  overlaps(b) {
    for (const h of this.holes) {
      if (b.x0 < h.x1 && b.x1 > h.x0 && b.z0 < h.z1 && b.z1 > h.z0) return true;
    }
    return false;
  }

  mesh(built, def) {
    const field = this.field;
    const b = built.bounds;
    const cell = this.cellSize;
    const nx = clamp(Math.round((b.x1 - b.x0) / cell), 8, this.maxCells);
    const ny = clamp(Math.round((b.y1 - b.y0) / cell), 8, this.maxCells * 2);
    const nz = clamp(Math.round((b.z1 - b.z0) / cell), 8, this.maxCells);

    // terrain heights on the XZ lattice, reused for every Y layer
    const gx = nx + 1;
    const gz = nz + 1;
    const hg = new Float32Array(gx * gz);
    const sx = (b.x1 - b.x0) / nx;
    const sz = (b.z1 - b.z0) / nz;
    for (let k = 0; k < gz; k++) {
      const wz = b.z0 + k * sz;
      for (let i = 0; i < gx; i++) hg[k * gx + i] = field.height(b.x0 + i * sx, wz);
    }

    const sd = built.sd;
    const sample = (x, y, z, i, j, k) => sd(x, y, z, hg[k * gx + i]);
    const fieldFn = (x, y, z) => sd(x, y, z, field.height(x, z));

    const r = surfaceNets({
      bounds: b,
      res: [nx, ny, nz],
      sample,
      field: fieldFn,
    });
    if (!r.count) return null;

    const skirt = buildSkirt(field, b, Math.max(sx, sz));
    const total = r.count + skirt.count;
    const positions = new Float32Array(total * 3);
    const normals = new Float32Array(total * 3);
    const surf = new Float32Array(total * 4);
    positions.set(r.positions, 0);
    normals.set(r.normals, 0);
    positions.set(skirt.positions, r.count * 3);
    normals.set(skirt.normals, r.count * 3);
    surf.set(skirt.surf, r.count * 4);

    for (let i = 0; i < r.count; i++) {
      const x = r.positions[i * 3];
      const z = r.positions[i * 3 + 2];
      surf[i * 4] = field.sampleFlow(x, z);
      surf[i * 4 + 1] = field.sampleAO(x, z);
      surf[i * 4 + 2] = 0;
      surf[i * 4 + 3] = 1;
    }

    const indices = new Uint32Array(r.indices.length + skirt.indices.length);
    indices.set(r.indices, 0);
    for (let i = 0; i < skirt.indices.length; i++) {
      indices[r.indices.length + i] = skirt.indices[i] + r.count;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('surf', new THREE.BufferAttribute(surf, 4));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.userData.feature = def.name;
    return mesh;
  }

  // ------------------------------------------------------------- collision

  /**
   * Signed distance inside a feature footprint, or null outside every one.
   * Returning null (rather than +inf) matters: inside a footprint the
   * feature's field REPLACES the heightfield, because a tunnel has to be able
   * to say "this is open air" where the heightfield says solid rock.
   */
  sdfAt(x, y, z) {
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const b = list[i].bounds;
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      if (y < b.y0 - 200 || y > b.y1 + 200) continue;
      return list[i].sd(x, y, z, this.field.height(x, z));
    }
    return null;
  }

  /** True if the point is inside any footprint (cheap pre-check). */
  contains(x, z) {
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const b = list[i].bounds;
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return list[i];
    }
    return null;
  }

  normal(x, y, z, out) {
    const h = 0.6;
    const f = (a, b, c) => {
      const v = this.sdfAt(a, b, c);
      return v === null ? b - this.field.height(a, c) : v;
    };
    const nx = f(x + h, y, z) - f(x - h, y, z);
    const ny = f(x, y + h, z) - f(x, y - h, z);
    const nz = f(x, y, z + h) - f(x, y, z - h);
    const l = Math.hypot(nx, ny, nz) || 1;
    out.nx = nx / l;
    out.ny = ny / l;
    out.nz = nz / l;
    return out;
  }

  /**
   * Did the segment prev->now pass through a feature's portal? Returns the
   * feature, once per crossing.
   */
  portalTest(px, py, pz, x, y, z) {
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const p = f.portal;
      if (!p) continue;
      const d0 = (px - p.x) * p.nx + (py - p.y) * p.ny + (pz - p.z) * p.nz;
      const d1 = (x - p.x) * p.nx + (y - p.y) * p.ny + (z - p.z) * p.nz;
      if ((d0 < 0) === (d1 < 0)) continue;
      const t = d0 / (d0 - d1);
      const cx = px + (x - px) * t;
      const cy = py + (y - py) * t;
      const cz = pz + (z - pz) * t;
      if (Math.hypot(cx - p.x, cy - p.y, cz - p.z) <= p.r) return f;
    }
    return null;
  }

  /** Hide distant feature meshes; the heightfield closes over them anyway. */
  updateVisibility(camPos) {
    const r2 = FEATURE_RANGE * FEATURE_RANGE;
    for (const f of this.list) {
      const dx = f.x - camPos.x;
      const dz = f.z - camPos.z;
      f.mesh.visible = dx * dx + dz * dz < r2;
    }
  }

  stats() {
    return {
      count: this.list.length,
      tris: this.list.reduce((a, f) => a + f.tris, 0),
    };
  }
}
