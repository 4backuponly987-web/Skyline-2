// The air.
//
// Three components the player can learn to read:
//   prevailing wind   — slow direction/strength drift, set by weather
//   ridge lift        — air pushed up windward slopes; the thing that lets you
//                       soar a ridge and regain height
//   thermals          — columns over sun-warmed low-albedo rock, strongest in
//                       the afternoon
// plus mechanical turbulence close to the ground at speed.

import { clamp, clamp01, lerp, smoothstep } from '../core/math.js';
import { WORLD } from './field.js';

export class Wind {
  constructor(field, noise) {
    this.field = field;
    this.noise = noise;
    this.baseDir = 2.35;          // radians, from the south-west
    this.baseSpeed = 9;
    this.thermalStrength = 1;
    this.time = 0;
    this.gust = 0;
    this.out = { x: 0, y: 0, z: 0 };
    this.dirX = 0;
    this.dirZ = 0;
    this.speed = 0;
    this.lastLift = 0;
  }

  setWeather(w) {
    this.baseSpeed = w.wind;
  }

  /** Advances the slow gust/direction LFOs. */
  update(dt, timeOfDay) {
    this.time += dt;
    const n = this.noise;
    const drift = n.noise2(this.time * 0.013, 11.7) * 0.5;
    const ang = this.baseDir + drift;
    this.gust = 1 + n.noise2(this.time * 0.09, 4.2) * 0.3 + n.noise2(this.time * 0.31, 9.9) * 0.12;
    this.speed = this.baseSpeed * this.gust;
    this.dirX = Math.cos(ang);
    this.dirZ = Math.sin(ang);
    // thermals build through the day and die off in the evening
    const t = clamp01((timeOfDay - 9) / 5);
    this.thermalStrength = Math.sin(Math.PI * clamp01((timeOfDay - 8.5) / 9)) * 1.25;
  }

  /**
   * Wind vector at a world point. `terrainH` and `normal` can be supplied by
   * the caller if already known (the pilot has them from its collision probes).
   */
  sample(x, y, z, out, terrainH, nx, ny, nz) {
    out = out || this.out;
    const f = this.field;
    const h = terrainH === undefined ? f.height(x, z) : terrainH;
    let Nx = nx, Ny = ny, Nz = nz;
    if (Nx === undefined) {
      const n = f.normal(x, z, null, 6);
      Nx = n.x; Ny = n.y; Nz = n.z;
    }
    const above = Math.max(0, y - h);

    let wx = this.dirX * this.speed;
    let wz = this.dirZ * this.speed;
    let wy = 0;

    // --- ridge lift -------------------------------------------------------
    const nh = Math.hypot(Nx, Nz);
    if (nh > 0.02) {
      const windward = clamp01(-(this.dirX * (Nx / nh) + this.dirZ * (Nz / nh)));
      const steep = clamp01((1 - Ny) * 2.1);
      const decay = Math.exp(-above / 115);
      // Air deflected up a slope cannot climb faster than the wind that drives
      // it. The old 2.75x gain put 22 m/s (49 mph) of updraft on a cliff lip
      // in fair weather, which threw you off your feet at the exit and made
      // the first seconds of every jump unflyable.
      const lift = Math.min(this.speed * 0.85, this.speed * windward * steep * decay * 0.62);
      wy += lift;
      this.lastLift = lift;
    } else {
      this.lastLift = 0;
    }

    // --- thermals ---------------------------------------------------------
    if (this.thermalStrength > 0.02 && above < 1500) {
      const n = this.noise;
      const c = n.noise2(x * 0.00115 + 17.3, z * 0.00115 - 5.1);
      const col = clamp01((c - 0.18) * 2.6);
      if (col > 0.001) {
        // stronger over dark rock low down, capped by an inversion
        const warm = smoothstep(WORLD.snowLine + 180, WORLD.snowLine - 700, h);
        const prof = smoothstep(0, 180, above) * smoothstep(1500, 500, above);
        const wob = 0.75 + 0.25 * n.noise2(x * 0.004 + this.time * 0.05, z * 0.004);
        wy += col * warm * prof * this.thermalStrength * 4.6 * wob;
      }
    }

    // --- mechanical turbulence near the ground ----------------------------
    if (above < 90) {
      const t = this.time;
      const k = (1 - above / 90) * this.speed * 0.17;
      const n = this.noise;
      wx += n.noise2(x * 0.02 + t * 1.7, z * 0.02) * k;
      wy += n.noise2(x * 0.02 + 31.0, z * 0.02 + t * 1.9) * k;
      wz += n.noise2(x * 0.02 - 11.0, z * 0.02 - t * 1.5) * k;
    }

    out.x = wx;
    out.y = wy;
    out.z = wz;
    return out;
  }

  /** Vertical air speed only — used by the vario and the lift visualisation. */
  verticalAt(x, y, z) {
    const o = this.sample(x, y, z, this._v || (this._v = { x: 0, y: 0, z: 0 }));
    return o.y;
  }
}
