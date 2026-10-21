// Signed distance primitives and operators for the volumetric features.
// Arches, tunnels, caves and overhangs cannot be expressed in a heightfield,
// so they are authored as SDFs, meshed with surface nets, and collided
// against with the same function that produced the mesh.

import { clamp, clamp01, lerp } from '../core/math.js';

export function sdSphere(px, py, pz, cx, cy, cz, r) {
  return Math.hypot(px - cx, py - cy, pz - cz) - r;
}

export function sdEllipsoid(px, py, pz, cx, cy, cz, rx, ry, rz) {
  const x = (px - cx) / rx;
  const y = (py - cy) / ry;
  const z = (pz - cz) / rz;
  const k0 = Math.hypot(x, y, z);
  if (k0 === 0) return -Math.min(rx, ry, rz);
  const k1 = Math.hypot(x / rx, y / ry, z / rz);
  return (k0 * (k0 - 1)) / k1;
}

export function sdRoundBox(px, py, pz, cx, cy, cz, hx, hy, hz, r) {
  const qx = Math.abs(px - cx) - hx + r;
  const qy = Math.abs(py - cy) - hy + r;
  const qz = Math.abs(pz - cz) - hz + r;
  const mx = Math.max(qx, 0);
  const my = Math.max(qy, 0);
  const mz = Math.max(qz, 0);
  return Math.hypot(mx, my, mz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - r;
}

/** Capsule between two points. */
export function sdCapsule(px, py, pz, ax, ay, az, bx, by, bz, r) {
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const bb = bax * bax + bay * bay + baz * baz;
  let h = bb > 1e-9 ? (pax * bax + pay * bay + paz * baz) / bb : 0;
  h = clamp01(h);
  return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - r;
}

/** Capsule with different radii at each end. */
export function sdCone(px, py, pz, ax, ay, az, bx, by, bz, ra, rb) {
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const bb = bax * bax + bay * bay + baz * baz;
  let h = bb > 1e-9 ? (pax * bax + pay * bay + paz * baz) / bb : 0;
  h = clamp01(h);
  const r = lerp(ra, rb, h);
  return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - r;
}

/** Torus in the XZ plane around a centre, with the hole facing +Y. */
export function sdTorus(px, py, pz, cx, cy, cz, R, r) {
  const q = Math.hypot(px - cx, pz - cz) - R;
  return Math.hypot(q, py - cy) - r;
}

export const opUnion = (a, b) => (a < b ? a : b);
export const opSub = (a, b) => (-a > b ? -a : b);   // subtract a from b
export const opInter = (a, b) => (a > b ? a : b);

export function opSmoothUnion(a, b, k) {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return lerp(b, a, h) - k * h * (1 - h);
}

export function opSmoothSub(a, b, k) {
  const h = clamp01(0.5 - (0.5 * (b + a)) / k);
  return lerp(b, -a, h) + k * h * (1 - h);
}

/** Rotates a point about Y into a local frame. */
export function rotY(px, pz, cx, cz, cos, sin, out) {
  const dx = px - cx;
  const dz = pz - cz;
  out[0] = dx * cos + dz * sin;
  out[1] = -dx * sin + dz * cos;
  return out;
}
