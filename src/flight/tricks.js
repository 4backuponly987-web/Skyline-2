// Trick state machine.
//
// One primary driver at a time plus modifiers. Tricks complete on rotation
// accumulated, never on a timer, so what you see is what you scored. Each
// driver also reports how it changes the aerodynamics (a flat spin really does
// sink; a corkscrew really does accelerate) and what the rig should do.

import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, TAU } from '../core/math.js';

export const TRICK = {
  NONE: 'none',
  ROLL: 'roll',
  FLIP: 'flip',
  HELI: 'heli',
  CORK: 'cork',
  INVERT: 'invert',
  TUMBLE: 'tumble',
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Tricks {
  constructor() {
    this.state = TRICK.NONE;
    this.dir = 1;
    this.accum = 0;         // radians rotated in the current trick
    this.target = TAU;
    this.stack = 1;         // how many rotations this trick is going for
    this.prewind = 0;
    this.prewindHeld = 0;
    this.inverted = false;
    this.invertBlend = 0;
    this.omega = new THREE.Vector3();
    this.controlScale = 1;
    this.aero = { area: 1, drag: 1, lift: 1 };
    this.rig = { heli: 0, inverted: 0, knife: 0, trickSpin: 0, tumble: 0 };
    this.onEvent = null;
    this.sinceTrick = 99;
    this.holdTimer = 0;
    this.lastName = '';
    this.settle = 0;
  }

  reset() {
    this.state = TRICK.NONE;
    this.accum = 0;
    this.prewind = 0;
    this.inverted = false;
    this.invertBlend = 0;
    this.omega.set(0, 0, 0);
    this.controlScale = 1;
    this.rig.heli = this.rig.inverted = this.rig.knife = this.rig.trickSpin = 0;
  }

  /**
   * @param {number} dt
   * @param {object} inp  {rollTrickL, rollTrickR, flipMod, heliMod, corkscrew,
   *                       invert, rollLeft, rollRight, pitchUp, pitchDown}
   *                      plus `pressed` edges in `ed`
   * @param {object} pilot
   */
  update(dt, inp, ed, pilot) {
    this.sinceTrick += dt;
    const fwd = pilot.fwd;
    const right = pilot.right;
    const up = pilot.up;

    // ---- prewind: both bank keys held, no trick running -------------------
    const bothBank = inp.rollLeft && inp.rollRight;
    if (bothBank && this.state === TRICK.NONE) {
      this.prewindHeld += dt;
      this.prewind = clamp01(this.prewindHeld / 1.15);
    } else if (this.state === TRICK.NONE) {
      this.prewindHeld = 0;
      this.prewind = damp(this.prewind, 0, 1.4, dt);
    }

    // ---- start a trick ----------------------------------------------------
    if (this.state === TRICK.NONE || this.state === TRICK.INVERT) {
      if (ed.flipMod && (inp.pitchDown || inp.pitchUp)) {
        this.begin(TRICK.FLIP, inp.pitchDown ? 1 : -1);
      } else if (ed.heliMod && (inp.rollLeft || inp.rollRight)) {
        this.begin(TRICK.HELI, inp.rollRight ? 1 : -1);
      } else if (inp.flipMod && (ed.pitchDown || ed.pitchUp)) {
        this.begin(TRICK.FLIP, ed.pitchDown ? 1 : -1);
      } else if (inp.heliMod && (ed.rollLeft || ed.rollRight)) {
        this.begin(TRICK.HELI, ed.rollRight ? 1 : -1);
      } else if (ed.frontFlip) {
        this.begin(TRICK.FLIP, 1);
      } else if (ed.backFlip) {
        this.begin(TRICK.FLIP, -1);
      } else if (ed.rollTrickL || ed.rollTrickR) {
        this.begin(TRICK.ROLL, ed.rollTrickR ? 1 : -1);
      } else if (inp.corkscrew) {
        this.begin(TRICK.CORK, 1);
      }
    } else if (this.state === TRICK.ROLL) {
      // stacking: tap again mid-roll for a double, triple, ...
      if ((ed.rollTrickR && this.dir > 0) || (ed.rollTrickL && this.dir < 0)) {
        this.stack++;
        this.target += TAU;
        this.emit('stack');
      }
    } else if (this.state === TRICK.FLIP) {
      if ((ed.frontFlip && this.dir > 0) || (ed.backFlip && this.dir < 0)) {
        this.stack++;
        this.target += TAU;
        this.emit('stack');
      }
    }

    // Keep going only while the key is STILL down as the rotation runs out.
    // Extending on a hold timer instead meant any press longer than about a
    // fifth of a second bought a second rotation, so a tap that was meant to
    // be one barrel roll spun on and on.
    if (this.state === TRICK.ROLL || this.state === TRICK.FLIP) {
      const held = this.state === TRICK.ROLL
        ? (this.dir > 0 ? inp.rollTrickR : inp.rollTrickL)
        : (this.dir > 0 ? inp.frontFlip : inp.backFlip);
      if (held && this.target - this.accum < TAU * 0.22) {
        this.target += TAU;
        this.stack++;
      }
    }

    // inverted toggle
    if (ed.invert && (this.state === TRICK.NONE || this.state === TRICK.INVERT)) {
      this.inverted = !this.inverted;
      this.state = this.inverted ? TRICK.INVERT : TRICK.NONE;
      this.emit(this.inverted ? 'invertOn' : 'invertOff');
    }

    // ---- drive -----------------------------------------------------------
    this.omega.set(0, 0, 0);
    this.controlScale = 1;
    this.aero.area = 1;
    this.aero.drag = 1;
    this.aero.lift = 1;
    const prewindBoost = 1 + this.prewind * 0.85;

    switch (this.state) {
      case TRICK.ROLL: {
        const rate = 8.4 * prewindBoost;
        const remain = this.target - this.accum;
        const ease = clamp01(remain / 1.3);
        const w = rate * this.dir * lerp(0.35, 1, ease);
        this.omega.addScaledVector(fwd, w);
        this.accum += Math.abs(w) * dt;
        this.controlScale = 0.22;
        this.aero.drag = 1.22;
        this.aero.lift = 0.62;
        this.rig.trickSpin = w * 0.1;
        if (this.accum >= this.target - 0.05) this.finish('roll');
        break;
      }
      case TRICK.FLIP: {
        const rate = 7.6 * prewindBoost;
        const remain = this.target - this.accum;
        const ease = clamp01(remain / 1.5);
        const w = rate * this.dir * lerp(0.4, 1, ease);
        this.omega.addScaledVector(right, w);
        this.accum += Math.abs(w) * dt;
        this.controlScale = 0.14;
        this.aero.area = 0.42;      // tucked through the flip
        this.aero.drag = 1.05;
        this.aero.lift = 0.3;
        this.rig.trickSpin = w * 0.09;
        if (this.accum >= this.target - 0.05) this.finish(this.dir > 0 ? 'frontflip' : 'backflip');
        break;
      }
      case TRICK.HELI: {
        const rate = 6.2 * prewindBoost;
        const remain = this.target - this.accum;
        const ease = clamp01(remain / 1.8);
        const w = rate * this.dir * lerp(0.35, 1, ease);
        this.omega.addScaledVector(UP, w);
        // flatten the body into the spin: rotate the pilot's up toward world up
        _v2.crossVectors(up, UP);
        this.omega.addScaledVector(_v2, 2.1);
        this.accum += Math.abs(w) * dt;
        this.controlScale = 0.1;
        this.aero.area = 1.35;
        this.aero.drag = 2.2;       // a flat spin sinks
        this.aero.lift = 0.45;
        this.rig.heli = damp(this.rig.heli, 1, 8, dt);
        this.rig.trickSpin = w * 0.07;
        if (this.accum >= this.target - 0.05) this.finish('heli');
        break;
      }
      case TRICK.CORK: {
        if (!inp.corkscrew) { this.finish('corkscrew'); break; }
        const rate = 6.6 * prewindBoost;
        this.omega.addScaledVector(fwd, rate * this.dir);
        this.omega.addScaledVector(right, -0.75);   // spiral the nose down
        this.accum += rate * dt;
        this.controlScale = 0.3;
        this.aero.area = 0.72;
        this.aero.drag = 1.1;
        this.rig.trickSpin = rate * this.dir * 0.08;
        break;
      }
      case TRICK.INVERT: {
        // hold the body upside down; the aero model does the rest
        const want = -1;
        const rollErr = up.y - want;
        if (Math.abs(up.y - want) > 0.08) {
          this.omega.addScaledVector(fwd, clamp(rollErr * 2.2, -3.4, 3.4));
        }
        this.controlScale = 0.85;
        this.rig.inverted = damp(this.rig.inverted, 1, 6, dt);
        break;
      }
      default:
        this.rig.heli = damp(this.rig.heli, 0, 5, dt);
        this.rig.inverted = damp(this.rig.inverted, 0, 4, dt);
        this.rig.trickSpin = damp(this.rig.trickSpin, 0, 7, dt);
        this.settle = Math.max(0, this.settle - dt);
        break;
    }

    if (!this.inverted && this.state !== TRICK.INVERT) {
      this.rig.inverted = damp(this.rig.inverted, 0, 4, dt);
    }
    this.invertBlend = this.rig.inverted;

    // knife-edge read: strong bank held without a trick
    if (this.state === TRICK.NONE) {
      const bank = Math.abs(pilot.bank);
      this.rig.knife = clamp01((bank - 1.0) / 0.5);
    } else this.rig.knife = 0;
  }

  begin(state, dir) {
    this.state = state;
    this.dir = dir;
    this.accum = 0;
    this.stack = 1;
    this.target = state === TRICK.CORK ? 1e9 : TAU;
    this.holdTimer = 0;
    this.emit('start');
  }

  finish(name) {
    const revs = Math.max(1, Math.round(this.accum / TAU));
    const info = {
      name,
      revs,
      prewind: this.prewind,
      stack: this.stack,
    };
    this.lastName = name;
    this.sinceTrick = 0;
    this.settle = 0.45;
    this.state = this.inverted ? TRICK.INVERT : TRICK.NONE;
    this.accum = 0;
    this.stack = 1;
    this.prewind = 0;
    this.prewindHeld = 0;
    this.onEvent?.('trick', info);
  }

  emit(kind) {
    this.onEvent?.(kind, { state: this.state, dir: this.dir, prewind: this.prewind });
  }

  get active() {
    return this.state !== TRICK.NONE && this.state !== TRICK.INVERT;
  }

  /** Human-readable label for the HUD while a trick is running. */
  label() {
    switch (this.state) {
      case TRICK.ROLL: return `${['', '', 'DOUBLE ', 'TRIPLE ', 'QUAD ', 'x5 ', 'x6 '][Math.min(6, this.stack)]}BARREL ROLL`;
      case TRICK.FLIP: return this.dir > 0 ? 'FRONT FLIP' : 'BACK FLIP';
      case TRICK.HELI: return `HELICOPTER ${Math.round((this.accum / TAU) * 360)}°`;
      case TRICK.CORK: return 'CORKSCREW';
      case TRICK.INVERT: return 'INVERTED';
      default: return '';
    }
  }
}
