// Collision and proximity queries.
//
// Everything here is computed from the same functions that build the visible
// mesh: `field.height` for the heightfield and the feature SDFs for arches,
// caves and spires. There is no separate collision geometry that can drift out
// of sync with what you can see.

import { clamp, clamp01 } from '../core/math.js';

const _p = { x: 0, y: 0, z: 0 };

export class Collision {
  constructor(field) {
    this.field = field;
    this.features = null;      // set by FeatureSet once built
    this.trees = null;         // set by Scatter
    this.lastHit = { hit: false, t: 0, nx: 0, ny: 1, nz: 0, px: 0, py: 0, pz: 0, kind: 'rock' };
  }

  /**
   * Signed clearance (negative = inside rock).
   *
   * Inside a feature footprint the feature's field REPLACES the heightfield
   * rather than being min'd with it: a tunnel has to be able to say "open
   * air" exactly where the heightfield says solid rock.
   */
  clearance(x, y, z) {
    if (this.features) {
      const f = this.features.sdfAt(x, y, z);
      if (f !== null) return f;
    }
    return y - this.field.height(x, z);
  }

  /**
   * Conservative distance estimate used as a marching step. Vertical clearance
   * over-estimates true distance on steep ground, so it is scaled down.
   */
  _step(c) {
    return clamp(c * 0.42, 0.8, 16);
  }

  /**
   * Marches a ray against the world. Returns hit distance or -1.
   * `out` receives the hit point and surface normal.
   */
  ray(ox, oy, oz, dx, dy, dz, maxT, out) {
    let t = 0;
    let prevT = 0;
    let prevC = this.clearance(ox, oy, oz);
    if (prevC <= 0) {
      if (out) {
        out.t = 0;
        out.px = ox; out.py = oy; out.pz = oz;
        this.normalAt(ox, oy, oz, out);
      }
      return 0;
    }
    let guard = 0;
    while (t < maxT && guard++ < 96) {
      t += this._step(prevC);
      if (t > maxT) t = maxT;
      const x = ox + dx * t;
      const y = oy + dy * t;
      const z = oz + dz * t;
      const c = this.clearance(x, y, z);
      if (c <= 0) {
        // bisect
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 8; i++) {
          const m = (lo + hi) * 0.5;
          const cm = this.clearance(ox + dx * m, oy + dy * m, oz + dz * m);
          if (cm <= 0) hi = m; else lo = m;
        }
        if (out) {
          out.t = hi;
          out.px = ox + dx * hi;
          out.py = oy + dy * hi;
          out.pz = oz + dz * hi;
          this.normalAt(out.px, out.py, out.pz, out);
        }
        return hi;
      }
      prevT = t;
      prevC = c;
      if (t >= maxT) break;
    }
    return -1;
  }

  /** Surface normal near a point (heightfield or feature, whichever is closer). */
  normalAt(x, y, z, out) {
    if (this.features && this.features.contains(x, z)) {
      this.features.normal(x, y, z, out);
      out.kind = 'rock';
      return out;
    }
    const fh = this.field.height(x, z);
    const n = this.field.normal(x, z, null, 1.4);
    out.nx = n.x;
    out.ny = n.y;
    out.nz = n.z;
    out.kind = fh > this.field.snowLineFor(x, z) && n.y > 0.45 ? 'snow' : 'rock';
    return out;
  }

  /**
   * Swept sphere from a->b. Returns the fraction of the sweep at first contact
   * or -1. Used for the pilot body.
   */
  sweep(ax, ay, az, bx, by, bz, radius, out) {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) {
      const c = this.clearance(ax, ay, az);
      if (c < radius) {
        if (out) {
          out.t = 0;
          out.px = ax; out.py = ay; out.pz = az;
          this.normalAt(ax, ay, az, out);
          out.depth = radius - c;
        }
        return 0;
      }
      return -1;
    }
    const steps = Math.max(1, Math.ceil(len / 2.2));
    let prev = this.clearance(ax, ay, az) - radius;
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const x = ax + dx * f;
      const y = ay + dy * f;
      const z = az + dz * f;
      const c = this.clearance(x, y, z) - radius;
      if (c <= 0) {
        let lo = (i - 1) / steps;
        let hi = f;
        for (let k = 0; k < 7; k++) {
          const m = (lo + hi) * 0.5;
          const cm = this.clearance(ax + dx * m, ay + dy * m, az + dz * m) - radius;
          if (cm <= 0) hi = m; else lo = m;
        }
        if (out) {
          out.t = lo;
          out.px = ax + dx * lo;
          out.py = ay + dy * lo;
          out.pz = az + dz * lo;
          this.normalAt(out.px, out.py, out.pz, out);
          out.depth = -c;
        }
        return lo;
      }
      prev = c;
    }
    return -1;
  }

  /**
   * Nearest surface distance around a point, sampled along a direction set.
   * This is what drives the close-shave meter, camera shake and audio.
   * `dirs` is a flat array of unit vectors.
   */
  nearest(x, y, z, dirs, maxT, hitInfo) {
    let best = maxT;
    let bi = -1;
    const o = this._rayOut || (this._rayOut = {});
    for (let i = 0; i < dirs.length; i += 3) {
      const t = this.ray(x, y, z, dirs[i], dirs[i + 1], dirs[i + 2], best, o);
      if (t >= 0 && t < best) {
        best = t;
        bi = i;
        if (hitInfo) {
          hitInfo.px = o.px; hitInfo.py = o.py; hitInfo.pz = o.pz;
          hitInfo.nx = o.nx; hitInfo.ny = o.ny; hitInfo.nz = o.nz;
          hitInfo.dx = dirs[i]; hitInfo.dy = dirs[i + 1]; hitInfo.dz = dirs[i + 2];
        }
      }
    }
    if (hitInfo) hitInfo.index = bi / 3;
    return best;
  }

  /** Ground info for landing/takeoff. */
  ground(x, z) {
    const h = this.field.height(x, z);
    const n = this.field.normal(x, z, null, 1.6);
    const slope = 1 - n.y;
    return { h, nx: n.x, ny: n.y, nz: n.z, slope };
  }
}

/**
 * A fixed probe direction set in body space: dense forward and downward,
 * sparse behind. 18 rays.
 */
export function buildProbeDirs() {
  const dirs = [];
  const add = (x, y, z) => {
    const l = Math.hypot(x, y, z);
    dirs.push(x / l, y / l, z / l);
  };
  add(0, -1, 0);
  add(0, 1, 0);
  add(1, 0, 0); add(-1, 0, 0);
  add(0, 0, 1); add(0, 0, -1);
  add(1, -1, 0); add(-1, -1, 0); add(0, -1, 1); add(0, -1, -1);
  add(1, -0.4, 1); add(-1, -0.4, 1); add(1, -0.4, -1); add(-1, -0.4, -1);
  add(1, 0.6, 0); add(-1, 0.6, 0); add(0, 0.6, 1); add(0, 0.6, -1);
  return new Float32Array(dirs);
}

export { clamp01 };
