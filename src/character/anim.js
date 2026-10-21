// Pose library and the animator that drives the rig from physics.
//
// Poses are per-joint Euler deltas from the bind pose (which is itself the
// neutral glide). They are blended by weights derived from the flight state,
// then each joint angle runs through a spring so transitions have weight,
// a little overshoot and a settle. Tricks add a layer on top that leads with
// the head and shoulders and lags through the hips and legs.

import * as THREE from 'three';
import { Rig } from './rig.js';
import { Fabric } from './fabric.js';
import { clamp, clamp01, lerp, smoothstep, damp, DEG } from '../core/math.js';

const P = (o) => o;

export const POSES = {
  neutral: P({}),

  // maximum glide: arms swept in, legs together, head low
  track: P({
    shoulderL: [0, 0.34, 0.10], elbowL: [0, 0.26, 0.04], wristL: [0, 0.12, 0],
    shoulderR: [0, -0.34, -0.10], elbowR: [0, -0.26, -0.04], wristR: [0, -0.12, 0],
    thighL: [0, 0.13, 0], thighR: [0, -0.13, 0],
    kneeL: [0, 0.06, 0], kneeR: [0, -0.06, 0],
    spine: [-0.04, 0, 0], chest: [-0.05, 0, 0], neck: [-0.12, 0, 0], head: [-0.06, 0, 0],
  }),

  // arms in, wings stowed: freefall, head down, nothing to fly with
  dive: P({
    shoulderL: [0, 1.52, 0.44], elbowL: [0.5, 0.88, 0.16], wristL: [0, 0.34, 0],
    shoulderR: [0, -1.52, -0.44], elbowR: [0.5, -0.88, -0.16], wristR: [0, -0.34, 0],
    thighL: [0, 0.24, 0], thighR: [0, -0.24, 0],
    kneeL: [0.1, 0.07, 0], kneeR: [0.1, -0.07, 0],
    spine: [0.16, 0, 0], chest: [0.18, 0, 0], neck: [-0.32, 0, 0], head: [-0.22, 0, 0],
  }),

  // wings folded for the dive
  tuck: P({
    shoulderL: [0, 1.02, 0.30], elbowL: [0.25, 0.62, 0.10], wristL: [0, 0.26, 0],
    shoulderR: [0, -1.02, -0.30], elbowR: [0.25, -0.62, -0.10], wristR: [0, -0.26, 0],
    thighL: [0, 0.18, 0], thighR: [0, -0.18, 0],
    kneeL: [0.14, 0.05, 0], kneeR: [0.14, -0.05, 0],
    spine: [0.09, 0, 0], chest: [0.12, 0, 0], neck: [-0.22, 0, 0], head: [-0.12, 0, 0],
  }),

  // flare: arched back, wings presented to the airflow, legs dropped
  flare: P({
    shoulderL: [0, -0.22, -0.34], elbowL: [-0.10, -0.12, -0.26],
    shoulderR: [0, 0.22, 0.34], elbowR: [-0.10, 0.12, 0.26],
    spine: [-0.24, 0, 0], chest: [-0.28, 0, 0], neck: [-0.18, 0, 0], head: [-0.14, 0, 0],
    thighL: [0.34, -0.05, 0], thighR: [0.34, 0.05, 0],
    kneeL: [0.42, 0, 0], kneeR: [0.42, 0, 0],
    ankleL: [0.2, 0, 0], ankleR: [0.2, 0, 0],
  }),

  // leaning into a right-hand turn (mirrored for left)
  bankR: P({
    neck: [0, -0.20, 0.24], head: [0, -0.14, 0.20],
    chest: [0, -0.06, -0.12], spine: [0, -0.04, -0.08],
    shoulderL: [0, 0, -0.14], shoulderR: [0, 0, 0.10],
    thighL: [0, 0, -0.10], thighR: [0, 0, 0.08],
  }),

  // knife edge: everything aligned, legs locked together
  knife: P({
    thighL: [0, 0.2, 0], thighR: [0, -0.2, 0],
    kneeL: [0, 0.08, 0], kneeR: [0, -0.08, 0],
    shoulderL: [0, 0.2, 0.05], shoulderR: [0, -0.2, -0.05],
    neck: [-0.1, 0, 0],
  }),

  // high angle of attack / mushing
  highAoa: P({
    spine: [-0.14, 0, 0], chest: [-0.16, 0, 0], neck: [-0.08, 0, 0],
    thighL: [0.2, 0, 0], thighR: [0.2, 0, 0],
    shoulderL: [0, -0.1, -0.16], shoulderR: [0, 0.1, 0.16],
  }),

  inverted: P({
    spine: [0.18, 0, 0], chest: [0.2, 0, 0], neck: [0.26, 0, 0], head: [0.18, 0, 0],
    thighL: [-0.18, 0, 0], thighR: [-0.18, 0, 0],
    shoulderL: [0, 0, 0.1], shoulderR: [0, 0, -0.1],
  }),

  // deliberate flat spin: arms straight out, body flat
  heli: P({
    shoulderL: [0, -0.34, -0.16], elbowL: [0, -0.18, -0.06],
    shoulderR: [0, 0.34, 0.16], elbowR: [0, 0.18, 0.06],
    thighL: [0, -0.1, 0], thighR: [0, 0.1, 0],
    spine: [-0.08, 0, 0], chest: [-0.06, 0, 0],
  }),

  tumble: P({
    spine: [0.3, 0.1, 0.2], chest: [0.25, -0.1, -0.2],
    shoulderL: [0.5, -0.5, -0.6], shoulderR: [-0.4, 0.5, 0.6],
    elbowL: [0.7, 0, 0], elbowR: [0.5, 0, 0],
    thighL: [0.5, 0.2, 0], thighR: [-0.3, -0.2, 0],
    kneeL: [0.8, 0, 0], kneeR: [0.5, 0, 0],
    neck: [0.2, 0.3, 0],
  }),

  // ground states
  // Upright on your feet.
  //
  // The whole body is turned upright by the container (see updateFlightView)
  // rather than by bending the spine 85 degrees. Bending the spine left the
  // pelvis lying flat with the torso stuck up out of it, which read as
  // somebody abseiling rather than standing. With the body already upright
  // the base pose is most of the way there -- legs trailing becomes legs
  // down -- so this only has to bring the arms in and soften the knees.
  stand: P({
    // Head level and looking where you are going, not tipped back at the
    // sky, and the weight slightly forward over the feet.
    chest: [-0.10, 0, 0], neck: [-0.14, 0, 0], head: [-0.20, 0, 0],
    shoulderL: [0, 0.62, 0.10], shoulderR: [0, -0.62, -0.10],
    elbowL: [0.22, 0.18, 0], elbowR: [0.22, -0.18, 0],
    thighL: [0.05, 0.02, 0], thighR: [0.05, -0.02, 0],
    kneeL: [-0.14, 0, 0], kneeR: [-0.14, 0, 0],
    ankleL: [0.26, 0, 0], ankleR: [0.26, 0, 0],
  }),

  crouch: P({
    chest: [0.30, 0, 0], neck: [-0.12, 0, 0], head: [-0.05, 0, 0],
    shoulderL: [0, 0.5, 0.12], shoulderR: [0, -0.5, -0.12],
    elbowL: [0.85, 0.2, 0], elbowR: [0.85, -0.2, 0],
    thighL: [-0.85, 0.08, 0], thighR: [-0.85, -0.08, 0],
    kneeL: [1.05, 0, 0], kneeR: [1.05, 0, 0],
    ankleL: [-0.4, 0, 0], ankleR: [-0.4, 0, 0],
  }),

  canopy: P({
    spine: [1.40, 0, 0], chest: [0.05, 0, 0], neck: [-0.15, 0, 0],
    shoulderL: [2.2, 0.35, 0.1], shoulderR: [2.2, -0.35, -0.1],
    elbowL: [0.9, 0, 0], elbowR: [0.9, 0, 0],
    thighL: [1.25, 0.08, 0], thighR: [1.25, -0.08, 0],
    kneeL: [-0.55, 0, 0], kneeR: [-0.55, 0, 0],
  }),
};

const JOINT_SPRING = {
  head: [95, 15], neck: [80, 14], chest: [55, 13], spine: [50, 13], hips: [50, 13],
  shoulderL: [70, 14], shoulderR: [70, 14],
  elbowL: [85, 15], elbowR: [85, 15],
  wristL: [110, 17], wristR: [110, 17],
  handL: [120, 18], handR: [120, 18],
  thighL: [45, 12], thighR: [45, 12],
  kneeL: [60, 13], kneeR: [60, 13],
  ankleL: [80, 15], ankleR: [80, 15],
  footL: [90, 16], footR: [90, 16],
};

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

export class Animator {
  constructor(rig, fabric) {
    this.rig = rig;
    this.fabric = fabric;
    this.n = rig.joints.length;
    this.target = new Float32Array(this.n * 3);
    this.value = new Float32Array(this.n * 3);
    this.veloc = new Float32Array(this.n * 3);
    this.index = new Map();
    rig.joints.forEach((j, i) => this.index.set(j.name, i));
    this.weights = {};
    this.lastTrickSpin = 0;
  }

  addPose(pose, w) {
    if (w <= 0.0005) return;
    for (const name in pose) {
      const i = this.index.get(name);
      if (i === undefined) continue;
      const a = pose[name];
      this.target[i * 3] += a[0] * w;
      this.target[i * 3 + 1] += a[1] * w;
      this.target[i * 3 + 2] += a[2] * w;
    }
  }

  /**
   * @param {object} s flight state:
   *   {tuck, track, flare, bank, alpha, speed, sep, inverted, heli, tumble,
   *    grounded, crouch, canopy, trickSpin, trickAxis, knife}
   */
  update(dt, s) {
    this.target.fill(0);

    const ground = s.grounded || 0;
    const air = 1 - ground;

    const stow = clamp01(1 - (s.wings === undefined ? 1 : s.wings));
    this.addPose(POSES.dive, stow * air);
    this.addPose(POSES.track, s.track * air * (1 - stow));
    this.addPose(POSES.tuck, s.tuck * air * (1 - stow));
    this.addPose(POSES.flare, s.flare * air * (1 - stow));
    this.addPose(POSES.heli, (s.heli || 0) * air);
    this.addPose(POSES.inverted, (s.inverted || 0) * air);
    this.addPose(POSES.knife, (s.knife || 0) * air);
    this.addPose(POSES.tumble, (s.tumble || 0) * air);
    this.addPose(POSES.highAoa, clamp01((s.alpha - 9 * DEG) / (14 * DEG)) * air * (1 - s.tuck));

    // banking: mirror the lean
    const bankW = clamp(s.bank / 0.95, -1, 1);
    if (bankW > 0) this.addPose(POSES.bankR, bankW * air);
    else this.mirrorPose(POSES.bankR, -bankW * air);

    this.addPose(POSES.stand, ground * (1 - (s.crouch || 0)));
    this.addPose(POSES.crouch, ground * (s.crouch || 0));
    this.addPose(POSES.canopy, (s.canopy || 0));

    // trick lead/lag: head and shoulders anticipate, hips and legs follow
    const spin = s.trickSpin || 0;
    const lead = clamp(spin * 0.16, -0.5, 0.5);
    this.bias('head', 0, -lead * 1.3, lead * 0.9);
    this.bias('neck', 0, -lead * 0.9, lead * 0.7);
    this.bias('chest', 0, -lead * 0.35, lead * 0.3);
    this.bias('thighL', 0, lead * 0.4, -lead * 0.25);
    this.bias('thighR', 0, lead * 0.4, -lead * 0.25);

    // Standing still: breathe, and shift your weight about. A figure frozen
    // mid-pose on a summit reads as a prop rather than a person.
    const walk = clamp01(s.walk || 0);
    this.clock = (this.clock || 0) + dt;
    if (ground > 0.02 && walk < 0.02) {
      const t = this.clock;
      const sway = Math.sin(t * 0.83) * 0.6 + Math.sin(t * 0.31 + 1.7) * 0.4;
      const breath = Math.sin(t * 1.15);
      this.bias('chest', breath * 0.016 * ground, sway * 0.03 * ground, 0);
      this.bias('spine', breath * 0.010 * ground, sway * 0.022 * ground, 0);
      this.bias('head', Math.sin(t * 0.47) * 0.055 * ground, sway * 0.11 * ground, 0);
      this.bias('shoulderL', 0, breath * 0.02 * ground, 0);
      this.bias('shoulderR', 0, -breath * 0.02 * ground, 0);
    }

    // a simple walk cycle on the ground
    if (ground > 0.02 && walk > 0.01) {
      this.walkPhase = (this.walkPhase || 0) + dt * (4.2 + walk * 4.5);
      const sw = Math.sin(this.walkPhase) * walk * ground;
      this.bias('thighL', sw * 0.52, 0, 0);
      this.bias('thighR', -sw * 0.52, 0, 0);
      // Knees bend the way knees bend. The stand pose's thigh and knee
      // signs were flipped when the body was stood upright by its
      // container; the walk cycle kept the old ones, so the legs swung
      // against the direction of travel and the knees folded forwards.
      this.bias('kneeL', Math.max(0, -sw) * -0.75, 0, 0);
      this.bias('kneeR', Math.max(0, sw) * -0.75, 0, 0);
      this.bias('shoulderL', 0, -sw * 0.34, 0);
      this.bias('shoulderR', 0, -sw * 0.34, 0);
      this.bias('spine', 0, sw * 0.06, 0);
    }

    // speed-driven micro tension: arms pull straighter the faster you go
    const fast = clamp01((s.speed - 40) / 50);
    this.bias('elbowL', -0.05 * fast, 0, 0);
    this.bias('elbowR', -0.05 * fast, 0, 0);

    // spring every angle toward the blended target
    const rig = this.rig;
    for (let i = 0; i < this.n; i++) {
      const name = rig.joints[i].name;
      const sp = JOINT_SPRING[name] || [60, 13];
      for (let a = 0; a < 3; a++) {
        const k = i * 3 + a;
        const acc = (this.target[k] - this.value[k]) * sp[0] - this.veloc[k] * sp[1];
        this.veloc[k] += acc * dt;
        this.value[k] += this.veloc[k] * dt;
      }
      _e.set(this.value[i * 3], this.value[i * 3 + 1], this.value[i * 3 + 2], 'XYZ');
      rig.joints[i].local.setFromEuler(_e);
    }
    rig.updateWorld();
    rig.skin();

    // stowed wings have no air in them
    const wingOut = s.wings === undefined ? 1 : clamp01(s.wings);
    this.fabric.update(
      {
        pressure: clamp01(s.pressure ?? 0.5) * wingOut,
        tension: clamp01(s.tension ?? 0.4),
        luff: clamp01(s.sep ?? 0) * wingOut,
      },
      dt,
    );
  }

  mirrorPose(pose, w) {
    if (w <= 0.0005) return;
    for (const name in pose) {
      const m = name.endsWith('L') ? name.slice(0, -1) + 'R'
        : name.endsWith('R') ? name.slice(0, -1) + 'L' : name;
      const i = this.index.get(m);
      if (i === undefined) continue;
      const a = pose[name];
      this.target[i * 3] += a[0] * w;
      this.target[i * 3 + 1] += -a[1] * w;
      this.target[i * 3 + 2] += -a[2] * w;
    }
  }

  bias(name, x, y, z) {
    const i = this.index.get(name);
    if (i === undefined) return;
    this.target[i * 3] += x;
    this.target[i * 3 + 1] += y;
    this.target[i * 3 + 2] += z;
  }
}

/** The whole character: rig, body mesh, fabric, animator and mount points. */
export class Wingsuiter {
  constructor(bodyMaterial, fabricMaterial) {
    this.rig = new Rig();
    this.fabric = new Fabric(this.rig);
    this.animator = new Animator(this.rig, this.fabric);

    this.group = new THREE.Group();
    this.bodyMesh = new THREE.Mesh(this.rig.geometry, bodyMaterial);
    this.bodyMesh.frustumCulled = false;
    this.fabricMesh = new THREE.Mesh(this.fabric.geometry, fabricMaterial);
    this.fabricMesh.frustumCulled = false;
    this.group.add(this.bodyMesh, this.fabricMesh);

    this.headPos = new THREE.Vector3();
    this.tipL = new THREE.Vector3();
    this.tipR = new THREE.Vector3();
  }

  update(dt, state) {
    this.animator.update(dt, state);
    const r = this.rig;
    this.headPos.copy(r.get('head').worldPos).applyMatrix4(this.group.matrixWorld);
    this.tipL.copy(r.get('handL').worldPos).applyMatrix4(this.group.matrixWorld);
    this.tipR.copy(r.get('handR').worldPos).applyMatrix4(this.group.matrixWorld);
  }

  snapWings(strength = 1) {
    this.fabric.snap(strength);
  }
}
