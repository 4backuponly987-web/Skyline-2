// Small scalar/vector helpers used everywhere. Kept dependency-free so the
// world generator can run before Three is touched.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const mix = lerp;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
};
export const smootherstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export const saturate = clamp01;
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);
export const fract = (v) => v - Math.floor(v);
export const remap = (v, a, b, c, d) => c + ((v - a) / (b - a || 1e-9)) * (d - c);
export const remapClamped = (v, a, b, c, d) => c + clamp01((v - a) / (b - a || 1e-9)) * (d - c);

/** Exponential smoothing that is correct for variable dt. */
export const damp = (current, target, lambda, dt) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt));

/** Critically-damped spring step. Returns [value, velocity]. */
export function spring(value, velocity, target, stiffness, damping, dt) {
  const a = (target - value) * stiffness - velocity * damping;
  const v = velocity + a * dt;
  return [value + v * dt, v];
}

/** Smooth min (polynomial) — the SDF workhorse. */
export function smin(a, b, k) {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return lerp(b, a, h) - k * h * (1 - h);
}
export function smax(a, b, k) {
  const h = clamp01(0.5 - (0.5 * (b - a)) / k);
  return lerp(b, a, h) + k * h * (1 - h);
}

export const length2 = (x, y) => Math.sqrt(x * x + y * y);
export const length3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);

/** Shortest signed angular difference, radians. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Bilinear sample of a Float32Array grid (res x res) at fractional coords. */
export function sampleGrid(grid, res, fx, fy) {
  if (fx < 0) fx = 0;
  else if (fx > res - 1.001) fx = res - 1.001;
  if (fy < 0) fy = 0;
  else if (fy > res - 1.001) fy = res - 1.001;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const tx = fx - x0;
  const ty = fy - y0;
  const i = y0 * res + x0;
  const a = grid[i];
  const b = grid[i + 1];
  const c = grid[i + res];
  const d = grid[i + res + 1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** Catmull-Rom through 4 scalars. */
export function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/** Distance from point to segment in 2D, plus the parametric position. */
export function distPointSeg2(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp01(t);
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return { d: Math.hypot(px - cx, py - cy), t, cx, cy };
}

export function formatNumber(n) {
  return Math.round(n).toLocaleString('en-US');
}

export function formatTime(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
}


// ---------------------------------------------------------------- units

// Everything inside the simulation is metres and metres per second. This is
// display only, set once from settings.
const UNIT_SETS = {
  // Speed is the only thing the toggle changes. Altitude reads in kilometres
  // and anything you measure against rock reads in metres, in both sets:
  // thousands of feet is a number you have to convert in your head mid-flight,
  // and a clearance in feet reads as noise next to a km altitude.
  imperial: { speed: 2.2369363, speedLabel: 'MPH', long: 0.000621371, longLabel: 'mi' },
  metric: { speed: 3.6, speedLabel: 'KM/H', long: 0.001, longLabel: 'km' },
};
let units = UNIT_SETS.imperial;
export function setUnits(name) { units = UNIT_SETS[name] || UNIT_SETS.imperial; return units; }
export const unitName = () => (units === UNIT_SETS.metric ? 'metric' : 'imperial');
export const toSpeed = (ms) => ms * units.speed;
export const speedLabel = () => units.speedLabel;
export const fmtSpeed = (ms) => Math.round(ms * units.speed) + ' ' + units.speedLabel.toLowerCase();

/** Altitude above sea level, in km to two decimals. */
export const toAlt = (m) => m * 0.001;
export const altLabel = () => 'km';
export const fmtAlt = (m) => (m * 0.001).toFixed(2) + ' km';

/** Anything measured against the rock: metres. */
export const toSmall = (m) => m;
export const smallLabel = () => 'm';
export const fmtShort = (m, d) => (m).toFixed(d === undefined ? 1 : d) + ' m';

export const fmtLong = (m) => (m * units.long).toFixed(2) + ' ' + units.longLabel;
