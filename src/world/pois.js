// Named places: summits found on the ridge network, authored launch points,
// and the signature features. Everything the map lists and everything you can
// teleport to comes from here.

import { WORLD, LAKES, GLACIER, MESA, SCARPS, SCARP } from './field.js';
import { TRUNKS } from './ridges.js';

export const POI_KIND = {
  SUMMIT: 'summit',
  LAUNCH: 'launch',
  FEATURE: 'feature',
  WATER: 'water',
  SPAWN: 'spawn',
};

/** Finds the highest point near a world position by hill-climbing. */
function climb(field, x, z, radius = 180, steps = 40, maxDrift = 300) {
  let bx = x, bz = z, bh = field.height(x, z);
  let r = radius;
  for (let i = 0; i < steps; i++) {
    let improved = false;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      const nx = bx + Math.cos(ang) * r;
      const nz = bz + Math.sin(ang) * r;
      // stay in the neighbourhood: otherwise every launch point walks uphill
      // to the single highest summit in the range
      if (Math.hypot(nx - x, nz - z) > maxDrift) continue;
      const h = field.height(nx, nz);
      if (h > bh) { bh = h; bx = nx; bz = nz; improved = true; }
    }
    if (!improved) r *= 0.62;
    if (r < 3) break;
  }
  return { x: bx, z: bz, h: bh };
}

// What a real exit costs you.
//
// Measured from the flight model itself, not estimated: wings stowed off the
// lip at 11 m/s, arms spread at 1.2 s, no input. Each pair is
// [horizontal metres travelled, metres of altitude lost]. The shape of it is
// the whole problem with cliff exits -- 103 m of fall buys only 70 m of
// forward travel, and you are not actually flying until about 200 m down.
// Any site search using a gentler guess picks cliffs that kill you.
const DIVE_PROFILE = [
  [0, 0], [6, 3], [11, 9], [17, 16], [23, 27], [29, 39], [37, 53], [46, 68],
  [57, 85], [70, 103], [85, 122], [102, 140], [121, 159], [142, 176],
  [165, 191], [189, 205], [214, 217], [240, 228], [266, 239], [293, 248],
  [319, 257], [346, 264], [373, 271], [399, 278], [425, 284], [451, 289],
  [477, 294], [502, 300], [527, 304], [577, 314], [625, 325], [674, 336],
  [722, 348], [770, 361], [817, 374], [917, 402], [1017, 430], [1117, 458],
];

/**
 * And what a standing exit costs, measured the same way: walk off the lip at
 * 4.2 m/s with the wing already spread. It needs about 98 m of fall in the
 * first 52 m of travel, so a launch site has to have a face of around 63
 * degrees under it or you simply slide down the hill.
 */
const STEP_OFF_PROFILE = [
  [0, 0], [3, 2], [6, 8], [9, 16], [14, 28], [20, 43], [28, 60], [38, 78],
  [52, 98], [68, 117], [87, 136], [109, 152], [132, 166], [157, 177],
  [182, 187], [208, 195], [233, 202], [246, 205], [346, 242], [446, 279],
  [546, 316], [646, 353],
];

/** The steepest ground fall within `reach` metres, and which way it goes. */
function lipDrop(field, x, z, reach) {
  const h0 = field.height(x, z);
  let best = 0;
  let ang = 0;
  for (let a = 0; a < 24; a++) {
    const t = (a / 24) * Math.PI * 2;
    const d = h0 - field.height(x + Math.cos(t) * reach, z + Math.sin(t) * reach);
    if (d > best) { best = d; ang = t; }
  }
  return { drop: best, heading: ang };
}

/**
 * Clearance a real exit would have along one heading: run the profile out and
 * take the smallest gap between the flight path and the ground.
 */
function exitClearance(field, sx, sz, ang, profile) {
  const prof = profile || DIVE_PROFILE;
  const sh = field.height(sx, sz);
  const dx = Math.cos(ang);
  const dz = Math.sin(ang);
  let minClear = Infinity;
  let drop = 0;
  for (let i = 1; i < prof.length; i++) {
    const d = prof[i][0];
    const loss = prof[i][1];
    const h = field.height(sx + dx * d, sz + dz * d);
    const clear = (sh - loss) - h;
    if (clear < minClear) minClear = clear;
    if (sh - h > drop) drop = sh - h;
  }
  return { clear: minClear, drop };
}

/** Best heading off a point, preferring the authored one when competitive. */
function bestExit(field, sx, sz, preferDir, dirs, profile) {
  const n = dirs || 48;
  let best = null;
  for (let a = 0; a < n; a++) {
    const ang = (a / n) * Math.PI * 2;
    const e = exitClearance(field, sx, sz, ang, profile);
    let score = Math.min(e.clear, 300) * 3 + e.drop * 0.5;
    if (preferDir !== undefined) {
      const dd = Math.abs(((ang - preferDir + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      score += Math.max(0, 1 - dd / 1.1) * 180;
    }
    if (!best || score > best.score) {
      best = { heading: ang, drop: e.drop, clear: e.clear, score };
    }
  }
  return best;
}

/** Could you stand here without sliding off? */
function standable(field, x, z) {
  return field.normal(x, z, null, 5).y > 0.90;
}

/**
 * Can you walk from (ax,az) to (bx,bz)? Samples the straight line and
 * rejects anything that climbs faster than you could scramble.
 */
function walkable(field, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < 0.001) return true;
  const steps = Math.max(2, Math.ceil(len / 1.5));
  let prev = field.height(ax, az);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const h = field.height(ax + dx * t, az + dz * t);
    if (h - prev > (len / steps) * 1.45) return false;
    prev = h;
  }
  return true;
}

/**
 * Walk out along the fall line and find where the ground actually goes over.
 * This is the same test the pilot's feet use, so the lip the search picks is
 * exactly the point at which walking turns into falling.
 */
function findLip(field, x, z, heading, reach) {
  const dx = Math.cos(heading);
  const dz = Math.sin(heading);
  const max = reach || 80;
  for (let d = 0; d <= max; d += 2) {
    const px = x + dx * d;
    const pz = z + dz * d;
    const h = field.height(px, pz);
    const ahead = field.height(px + dx * 1.5, pz + dz * 1.5);
    if (h - ahead > 2.25) return { x: px, z: pz, dist: d, h };
  }
  return null;
}

/**
 * Finds somewhere you could actually jump from, on your feet.
 *
 * This is built around the standing exit rather than the geometry of the
 * drop. The candidate has to be ground you can stand on, with a walkable
 * fall line to a real lip, and free air under that lip for the whole
 * step-off profile. Searching for the steepest lip alone put every exit on
 * a 78 degree crest you could not stand on, and the gentler sites on ramps
 * that you simply slid down at 47 mph.
 */
function findLaunch(field, cx, cz, preferDir, radius) {
  const R = radius || 760;
  let best = null;
  let fallback = null;
  let loose = null;
  const step = 45;
  for (let dz = -R; dz <= R; dz += step) {
    for (let dx = -R; dx <= R; dx += step) {
      if (dx * dx + dz * dz > R * R) continue;
      const x = cx + dx;
      const z = cz + dz;
      if (!standable(field, x, z)) continue;
      const fall = lipDrop(field, x, z, 70);
      const h0 = field.height(x, z);
      if (!loose || fall.drop > loose.lip) {
        loose = {
          x, z, h: h0, stand: { x, z, h: h0, dist: 0 },
          heading: fall.heading, clear: 0, drop: fall.drop, lip: fall.drop, score: 0,
        };
      }
      if (fall.drop < 110) continue;
      const lip = findLip(field, x, z, fall.heading);
      if (!lip || !walkable(field, x, z, lip.x, lip.z)) continue;
      const e = bestExit(field, lip.x, lip.z, fall.heading, 24, STEP_OFF_PROFILE);
      const h = field.height(x, z);
      const far = Math.hypot(dx, dz);
      const score = Math.min(e.clear, 200) * 4 + fall.drop * 2.2 + h * 0.3
        - far * 0.12 - lip.dist * 1.2;
      const cand = {
        x: lip.x, z: lip.z, h: lip.h,
        stand: { x, z, h, dist: lip.dist },
        heading: e.heading, clear: e.clear, drop: e.drop, lip: fall.drop, score,
      };
      if (!fallback || score > fallback.score) fallback = cand;
      if (e.clear < 25) continue;
      if (!best || score > best.score) best = cand;
    }
  }
  if (best || fallback || loose) return best || fallback || loose;
  // Nothing here is standable at all: hand back the centre so the site is
  // still listed, and launch() will start it in the air instead.
  const h = field.height(cx, cz);
  const fall = lipDrop(field, cx, cz, 70);
  return {
    x: cx, z: cz, h, stand: null,
    heading: fall.heading, clear: 0, drop: fall.drop, lip: fall.drop, score: 0,
  };
}

export function buildPOIs(field) {
  const list = [];
  const seen = [];

  const push = (p) => {
    for (const s of seen) {
      if (Math.hypot(s.x - p.x, s.z - p.z) < 260) return null;
    }
    seen.push(p);
    list.push(p);
    return p;
  };

  // --- summits from the authored trunks -----------------------------------
  for (const t of TRUNKS) {
    const pts = t.pts;
    for (let i = 1; i < pts.length - 1; i++) {
      const h = pts[i][2];
      if (h < pts[i - 1][2] || h < pts[i + 1][2]) continue;
      const top = climb(field, pts[i][0], pts[i][1], 160, 40, 320);
      const named = t.summits && t.summits[i];
      push({
        kind: POI_KIND.SUMMIT,
        name: named || `${t.name} ${Math.round(top.h)} m`,
        x: top.x, z: top.z, y: top.h,
        range: t.name,
      });
    }
  }

  // --- authored launch points ---------------------------------------------
  const LAUNCHES = [
    { name: 'Skyline Summit', x: 40, z: 60, heading: -2.2, note: 'The high point. Everything is downhill.' },
    { name: 'The Anvil', x: 2240, z: 1960, heading: 2.5, note: 'Big north face, long committed line.' },
    { name: 'Teeth Col', x: -180, z: -2300, heading: -1.1, note: 'Knife ridge both sides. Precision.' },
    { name: 'Citadel Spire', x: -1240, z: -1900, heading: 2.1, note: 'Steep drop into the cirque.' },
    { name: 'Glacier Bench', x: -430, z: -900, heading: 2.0, note: 'Ice, crevasses, then the valley.' },
    { name: 'Mesa Rim', x: 2320, z: 2320, heading: -1.35, note: 'Plateau edge above the slot canyon.' },
    { name: 'Lac Blanc Shoulder', x: -2320, z: 1620, heading: 0.75, note: 'Forest run down to the lake.' },
    { name: 'West Shoulder', x: -3060, z: 1680, heading: 0.9, note: 'Mellow. Good for learning.' },
    { name: 'Chapel Rib', x: 260, z: 460, heading: 1.5, note: 'Long rib all the way to the valley floor.' },
    { name: 'Raven Hills', x: 3040, z: -2480, heading: 2.8, note: 'Rolling, forested, easy air.' },
    { name: 'Northwall', x: 300, z: -4960, heading: 1.57, note: 'The big north face. Cold, shaded, enormous.' },
    { name: 'East Rampart', x: 4120, z: -900, heading: 3.14, note: 'A mile of knife ridge and a long way down.' },
    { name: 'Cirque Blanche', x: 4350, z: 3160, heading: 2.2, note: 'Hanging bowl above the south basin.' },
    { name: 'Gendarme', x: -3700, z: -4520, heading: 0.9, note: 'Out past the Teeth. Committing.' },
    { name: 'Westwatch', x: -4260, z: 380, heading: 0.0, note: 'Far west rim, open country below.' },
  ];
  for (const L of LAUNCHES) {
    // Each authored launch has a headwall carved under it at exactly these
    // coordinates, so there is nothing to search for: the lip is the scarp
    // centre and the shelf behind it is where you stand. Searching for the
    // best-looking spot nearby kept wandering off the wall and onto the
    // rounded ground beside it.
    // field.scarps carries the direction chosen from the baked terrain; the
    // SCARPS constant only has the authored guess.
    const sc = (field.scarps || SCARPS).find(
      (q) => (q.ax === undefined ? q.x : q.ax) === L.x
        && (q.az === undefined ? q.z : q.az) === L.z,
    );
    let spot;
    let exit;
    if (sc) {
      const cx = Math.cos(sc.dir);
      const cz = Math.sin(sc.dir);
      const e = exitClearance(field, sc.x, sc.z, sc.dir, STEP_OFF_PROFILE);
      // Right on the lip, not a walk back from it. "Stand on the edge and
      // go" should put you on the edge: a long walk across a summit to find
      // it was the thing that did not work, and every metre of that walk is
      // another chance to wander off the wall onto ground that just slides.
      const bx = sc.x - cx * 7;
      const bz = sc.z - cz * 7;
      spot = {
        x: sc.x, z: sc.z, h: field.height(sc.x, sc.z),
        stand: { x: bx, z: bz, h: field.height(bx, bz), dist: Math.round(SCARP.rim * 0.5) },
        heading: sc.dir, clear: e.clear, drop: e.drop, lip: e.drop,
      };
      exit = { heading: sc.dir, clear: e.clear, drop: e.drop };
    } else {
      spot = findLaunch(field, L.x, L.z, L.heading, 300);
      exit = bestExit(field, spot.x, spot.z, spot.heading, 64, STEP_OFF_PROFILE);
    }
    const top = { x: spot.x, z: spot.z, h: spot.h };
    // If even the best line clips the mountain, start the jump in the air:
    // a drop-in rather than a cliff exit. Every listed launch is flyable.
    const lift = exit.clear < 30 ? Math.min(400, 30 - exit.clear) : 0;
    list.push({
      kind: POI_KIND.LAUNCH,
      stand: spot.stand,
      name: L.name,
      note: L.note,
      x: top.x,
      z: top.z,
      y: top.h,
      summitY: top.h,
      heading: exit.heading,
      drop: exit.drop,
      clear: exit.clear,
      lip: spot.lip,
      airStart: lift,
    });
  }

  // --- water ---------------------------------------------------------------
  for (const L of LAKES) {
    list.push({ kind: POI_KIND.WATER, name: L.name, x: L.x, z: L.z, y: L.level, radius: L.r });
  }

  list.push({ kind: POI_KIND.FEATURE, name: 'Serpent Gorge', x: 2240, z: 2560, y: 1320, note: 'Slot canyon' });
  list.push({ kind: POI_KIND.FEATURE, name: 'Blanc Glacier', x: GLACIER.x, z: GLACIER.z, y: GLACIER.level, note: 'Crevasse field' });
  list.push({ kind: POI_KIND.FEATURE, name: 'The Mesa', x: MESA.x, z: MESA.z, y: MESA.level, note: 'Plateau' });

  return list;
}

/** Nearest POI of a kind to a point. */
export function nearestPOI(pois, x, z, kind) {
  let best = null;
  let bd = Infinity;
  for (const p of pois) {
    if (kind && p.kind !== kind) continue;
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < bd) { bd = d; best = p; }
  }
  return { poi: best, dist: bd };
}
