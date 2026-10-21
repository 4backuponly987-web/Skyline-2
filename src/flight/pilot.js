// The wingsuit flight model.
//
// Rigid body with a real (if simplified) aerodynamic model: lift and drag from
// angle of attack and pose-dependent wing area, a stall with separated flow,
// sideslip side-force, and a weathervane stability term that is what makes the
// suit forgiving to fly. Control is rate-based on top of that physics, which
// gives a responsive feel without throwing away the weight.
//
// Calibration targets (verified by tests/flight.html):
//   neutral glide ratio   2.5 : 1 at ~49 m/s
//   tracking glide ratio   3.1 : 1
//   full tuck terminal    ~83 m/s (300 km/h)
//   flare converts ~20 m/s of speed into ~14 m of climb

import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, damp, DEG } from '../core/math.js';

export const AERO = {
  mass: 86,
  gravity: 9.81,
  area: 1.62,            // reference wing area (m^2), neutral pose
  // Lift slope per radian. At 3.15 the suit only held its own weight at about
  // 93 mph, so every exit had to buy 110 m of altitude before it started
  // flying and no slope on the mountain was steep enough to allow that. A
  // real wingsuit flies nearer 70 mph; 4.4 puts the trim speed there.
  clAlpha: 4.4,
  clFlat: 1.15,          // post-stall flat-plate lift
  alphaStall: 17.5 * DEG,
  sepWidth: 13.0 * DEG,  // how fast flow separates past the stall
  kInduced: 0.22,
  cdA0: 0.207,           // parasite drag AREA (m^2), neutral pose
  cdFlat: 1.22,          // post-stall form drag coefficient
  sideArea: 0.62,
  cySlope: 1.35,
  rhoSea: 1.225,
  scaleHeight: 8400,

  // Wings stowed: arms in, no wing to speak of, so no lift and a head-down
  // fall. mg = 0.5*rho*V^2*cdA0 puts terminal at about 86 m/s (193 mph).
  stowedArea: 0.08,
  stowedCdA0: 0.205,
  stowedAuth: 0.5,
  deployRate: 6.5,
  landSpeed: 16.0,       // 36 mph, so 30 mph always lands with room to spare
  landImpact: 12.0,      // how hard you may arrive and still stand it up

  walkSpeed: 4.2,
  runSpeed: 7.4,
  standHeight: 0.95,
  jumpUp: 3.2,
  jumpFwd: 5.5,

  // pose modifiers: [areaScale, cdA0Scale]
  tuckArea: 0.34, tuckDrag: 0.95,
  trackArea: 0.86, trackDrag: 0.62,
  flareArea: 1.42, flareDrag: 2.55,

  // control
  pitchRate: 2.05,       // rad/s at full authority
  rollRate: 2.35,
  yawRate: 0.95,
  response: 8.0,         // how fast omega chases the demand
  qRef: 950,             // dynamic pressure at which authority is 1.0
  // Pitch stability holds the body at a TRIM angle of attack, not at zero:
  // a wingsuit flies because it sits nose-down relative to its flight path.
  // Aligning the nose with the airflow instead (a plain weathervane) drives
  // alpha to 0, kills the lift and the suit simply falls.
  // Trim angle of attack sets the speed the suit flies at, and that speed is
  // what an exit has to buy with altitude. At 8.2 deg the suit trimmed at
  // 126 mph and needed 200 m of fall to get there, so a cliff with "only"
  // 150 m under it killed you. At 10.5 it trims near 93 mph for about 80 m,
  // which is what a real wingsuit exit costs, and the glide is still ~2.9:1.
  alphaTrim: 10.5 * DEG,
  trimRange: 15.0 * DEG, // how far pitch input moves the trim point
  trimTuck: -6.5 * DEG,
  trimFlare: 11.0 * DEG,
  trimTrack: -0.8 * DEG,
  stabPitch: 5.0,        // 1/s, how hard the body returns to trim
  stabYaw: 2.6,
  stabMax: 2.6,          // rad/s cap on the stabiliser
  maxBank: 1.30,         // rad, the bank a full roll input settles at
  bankGain: 3.4,         // how hard roll input seeks that bank angle
  levelGain: 1.5,        // returns to level when roll input is released
  coordYaw: 0.85,        // yaw into the turn with bank
  yawDamp: 0.9,          // damps the yaw rate so turns settle instead of weaving

  bodyRadius: 1.15,
  wingSpan: 1.45,

};

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();

export const FLIGHT_STATE = {
  GROUND: 'ground',
  FLYING: 'flying',
  TUMBLE: 'tumble',
  CANOPY: 'canopy',
  CRASHED: 'crashed',
  LANDED: 'landed',
};

export class Pilot {
  constructor(field, collision, wind) {
    this.field = field;
    this.collision = collision;
    this.wind = wind;

    this.pos = new THREE.Vector3(0, 2000, 0);
    this.vel = new THREE.Vector3(0, 0, -40);
    this.quat = new THREE.Quaternion();
    this.omega = new THREE.Vector3();

    this.prevPos = this.pos.clone();
    this.prevQuat = this.quat.clone();

    this.fwd = new THREE.Vector3(0, 0, -1);
    this.up = new THREE.Vector3(0, 1, 0);
    this.right = new THREE.Vector3(1, 0, 0);
    this.airVel = new THREE.Vector3();
    this.windVec = { x: 0, y: 0, z: 0 };

    this.state = FLIGHT_STATE.FLYING;
    this.wings = 1;          // 0 = stowed (freefall dive), 1 = flying
    this.wingsTarget = 1;
    this.groundHeading = 0;
    this.sinceGround = 0;
    this.pose = { tuck: 0, track: 0, flare: 0 };
    this.poseTarget = { tuck: 0, track: 0, flare: 0 };

    this.speed = 0;
    this.alpha = 0;
    this.beta = 0;
    this.sep = 0;
    this.gForce = 1;
    this.glide = 0;
    this.agl = 0;
    this.lift = 0;
    this.drag = 0;
    this.wingLoad = 0;
    this.bank = 0;
    this.pitchAngle = 0;
    this.vario = 0;
    this.tumbleTimer = 0;
    this.canopy = 0;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.sinceLaunch = 0;
    this.distance = 0;
    this.impact = 0;
    this.lastImpactSpeed = 0;
    this.contact = false;
    this.fabricTension = 0;
    this.trickOmega = new THREE.Vector3();
    this.trickAero = { area: 1, drag: 1, lift: 1 };
    this.controlScale = 1;
    this.crashKind = null;

    this._hit = { t: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0, depth: 0, kind: 'rock' };
  }

  reset(pos, vel, quat, wings = 1) {
    this.wings = wings;
    this.wingsTarget = wings;
    this.pos.copy(pos);
    this.vel.copy(vel || new THREE.Vector3(0, -1, -30));
    if (quat) this.quat.copy(quat);
    else {
      const dir = this.vel.clone().normalize();
      this.lookAlong(dir);
    }
    this.omega.set(0, 0, 0);
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this.state = FLIGHT_STATE.FLYING;
    this.pose.tuck = this.pose.track = this.pose.flare = 0;
    this.canopy = 0;
    this.tumbleTimer = 0;
    this.sinceLaunch = 0;
    this.distance = 0;
    this.impact = 0;
    this.contact = false;
    this.crashKind = null;
    this.updateAxes();
  }

  /**
   * Point the body along `dir`, wings level.
   *
   * The basis must be right-handed with forward on -Z, so up is r x f, NOT
   * f x r: getting that backwards rolls the body 180 degrees, and since every
   * launch and respawn comes through here it started you inverted, with two
   * and a half seconds of useless upside-down lift while the dive steepened.
   */
  lookAlong(dir) {
    const f = _v1.copy(dir).normalize();
    const up = Math.abs(f.y) > 0.98 ? _v2.set(0, 0, 1) : _v2.set(0, 1, 0);
    const r = _v3.crossVectors(up, f).normalize().negate();
    const u = new THREE.Vector3().crossVectors(r, f).normalize();
    _m1.makeBasis(r, u, f.clone().negate());
    this.quat.setFromRotationMatrix(_m1);
  }

  updateAxes() {
    this.fwd.set(0, 0, -1).applyQuaternion(this.quat);
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    this.right.set(1, 0, 0).applyQuaternion(this.quat);
  }

  density() {
    return AERO.rhoSea * Math.exp(-Math.max(0, this.pos.y) / AERO.scaleHeight);
  }

  /** Blended pose scalars -> effective area and parasite drag area. */
  poseAero() {
    const p = this.pose;
    const w = this.wings;
    const area =
      AERO.area *
      lerp(AERO.stowedArea, 1, w) *
      lerp(1, AERO.tuckArea, p.tuck) *
      lerp(1, AERO.trackArea, p.track) *
      lerp(1, AERO.flareArea, p.flare);
    const cdA0 = lerp(
      AERO.stowedCdA0,
      AERO.cdA0 *
        lerp(1, AERO.tuckDrag, p.tuck) *
        lerp(1, AERO.trackDrag, p.track) *
        lerp(1, AERO.flareDrag, p.flare),
      w,
    );
    return { area: area * this.trickAero.area, cdA0: cdA0 * this.trickAero.drag };
  }

  clCurve(a) {
    const abs = Math.abs(a);
    const attached = AERO.clAlpha * a;
    const flat = AERO.clFlat * Math.sin(2 * a);
    // A hard pull briefly holds the flow attached past the static stall.
    // Real wings do this -- a fast pitch-up carries a vortex that keeps the
    // lift up for a moment -- and it is what makes a snap pull-up feel like
    // one. It runs out after about a second, so it is a move, not an upgrade.
    const stall = AERO.alphaStall * (1 + 0.30 * (this.stallBoost || 0));
    const sep = smoothstep(stall, stall + AERO.sepWidth, abs);
    this.sep = sep;
    return lerp(attached, flat, sep);
  }

  /**
   * One fixed physics step.
   * @param {number} dt seconds (1/90)
   * @param {object} input {pitch, roll, yaw, tuck, track, flare, canopy}
   */
  step(dt, input) {
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this.sinceLaunch += dt;

    if (this.state === FLIGHT_STATE.CRASHED) {
      this.stepCrashed(dt);
      return;
    }
    if (this.state === FLIGHT_STATE.GROUND) {
      this.stepGround(dt, input);
      return;
    }

    this.wings = damp(this.wings, this.wingsTarget, AERO.deployRate, dt);
    this.updateAxes();

    // ---- pose blending --------------------------------------------------
    const pt = this.poseTarget;
    pt.tuck = input.tuck || 0;
    pt.track = (input.track || 0) * (1 - pt.tuck);
    pt.flare = (input.flare || 0) * (1 - pt.tuck);
    const poseLambda = 7.5;
    this.pose.tuck = damp(this.pose.tuck, pt.tuck, poseLambda, dt);
    this.pose.track = damp(this.pose.track, pt.track, poseLambda, dt);
    this.pose.flare = damp(this.pose.flare, pt.flare, poseLambda * 1.6, dt);

    // ---- air ------------------------------------------------------------
    const terrainH = this.field.height(this.pos.x, this.pos.z);
    this.agl = this.pos.y - terrainH;
    this.wind.sample(this.pos.x, this.pos.y, this.pos.z, this.windVec, terrainH);
    this.airVel.set(
      this.vel.x - this.windVec.x,
      this.vel.y - this.windVec.y,
      this.vel.z - this.windVec.z,
    );
    const V = this.airVel.length();
    this.speed = this.vel.length();
    const rho = this.density();
    const qdyn = 0.5 * rho * V * V;

    const force = _v1.set(0, -AERO.mass * AERO.gravity, 0);

    if (V > 0.35) {
      const vah = _v2.copy(this.airVel).multiplyScalar(1 / V);
      const vf = vah.dot(this.fwd);
      const vu = vah.dot(this.up);
      const vr = vah.dot(this.right);
      this.alpha = Math.atan2(-vu, Math.abs(vf) < 1e-4 ? 1e-4 : vf);
      if (vf < 0) this.alpha = Math.sign(this.alpha) * (Math.PI - Math.abs(this.alpha));
      this.beta = Math.atan2(vr, Math.abs(vf) < 1e-4 ? 1e-4 : Math.abs(vf));

      const { area, cdA0 } = this.poseAero();
      let CL = this.clCurve(this.alpha);
      // folding the wings also kills the lift they could make
      CL *= lerp(1, 0.45, this.pose.tuck) * this.trickAero.lift;
      if (this.state === FLIGHT_STATE.CANOPY) CL = 0;

      const sepDrag = this.sep * AERO.cdFlat * (1 - Math.cos(2 * this.alpha)) * 0.5;
      const CD = AERO.kInduced * CL * CL + sepDrag;

      let L = qdyn * area * CL;
      let D = qdyn * (cdA0 + CD * area);
      const Y = -qdyn * AERO.sideArea * AERO.cySlope * Math.sin(this.beta);

      if (this.state === FLIGHT_STATE.CANOPY) {
        // A seven-cell ram-air: about a 1.2:1 glide, 5.5 m/s down and 6.5
        // forward once it is open. Pulling both brakes (the flare) nearly
        // doubles the lift for a second, which is how you put it down on
        // anything, anywhere.
        const c = this.canopy;
        const brake = this.pose.flare;
        D += qdyn * (16.0 + brake * 13.0) * c;
        L += qdyn * (19.0 + brake * 15.0) * c;
      }

      this.lift = L;
      this.drag = D;

      // lift acts perpendicular to the relative wind, in the body's up plane
      const liftDir = _v3.copy(this.up).addScaledVector(vah, -this.up.dot(vah));
      const ll = liftDir.length();
      if (ll > 1e-4) {
        liftDir.multiplyScalar(1 / ll);
        force.addScaledVector(liftDir, L);
      }
      force.addScaledVector(vah, -D);

      const sideDir = _v2.copy(this.right).addScaledVector(vah, -this.right.dot(vah));
      const sl = sideDir.length();
      if (sl > 1e-4) force.addScaledVector(sideDir.multiplyScalar(1 / sl), Y);
    } else {
      this.alpha = 0;
      this.beta = 0;
      this.lift = 0;
      this.drag = 0;
    }

    this.gForce = force.length() / (AERO.mass * AERO.gravity);
    this.wingLoad = this.lift / (AERO.mass * AERO.gravity);

    // ---- integrate linear ----------------------------------------------
    this.vel.addScaledVector(force, dt / AERO.mass);
    const stepLen = this.vel.length() * dt;
    this.distance += stepLen;

    // ---- angular ---------------------------------------------------------
    this.stepAngular(dt, input, qdyn, V);

    // ---- move and collide -------------------------------------------------
    this.integrateAndCollide(dt);

    this.vario = this.vel.y;
    const horiz = Math.hypot(this.vel.x, this.vel.z);
    this.glide = this.vel.y < -0.25 ? horiz / -this.vel.y : (horiz > 1 ? 99 : 0);
    this.pitchAngle = Math.asin(clamp(this.fwd.y, -1, 1));
    this.fabricTension = clamp01(
      (qdyn / 1800) * lerp(1, 0.35, this.pose.tuck) * lerp(1, 1.5, this.pose.flare),
    );
  }

  stepAngular(dt, input, qdyn, V) {
    if (this.sep > (this.maxSep || 0)) this.maxSep = this.sep;
    if (Math.abs(this.alpha) > (this.maxAlpha || 0)) this.maxAlpha = Math.abs(this.alpha);
    // Authority scales with dynamic pressure: no air, no steering.
    let auth = clamp(qdyn / AERO.qRef, 0.22, 1.35);
    if (this.state === FLIGHT_STATE.TUMBLE) auth *= 0.3;
    if (this.state === FLIGHT_STATE.CANOPY) auth = 0.62;
    auth *= this.controlScale * lerp(AERO.stowedAuth, 1, this.wings);

    const pitchIn = clamp(input.pitch || 0, -1, 1);
    const rollIn = clamp(input.roll || 0, -1, 1);
    const yawIn = clamp(input.yaw || 0, -1, 1);

    const bank = Math.atan2(-this.right.y, this.up.y); // +ve = right wing down
    this.bank = bank;

    // demanded body rates (right-hand rule: +fwd rolls right-wing-down,
    // +right pitches the nose up, +up yaws left)
    // Roll is bank-angle seeking, not rate commanding. Commanding a rate
    // means holding D rolls you over and over instead of settling into a
    // turn, which is the single thing that made turning feel wrong.
    // Hold the hard-manoeuvre button and the suit will do things it will
    // not do on its own: bank past ninety degrees, roll into it twice as
    // fast, and pull right up to the edge of the stall.
    const hardTurn = input.hardTurn ? 1 : 0;
    const hardPull = input.hardPull ? 1 : 0;
    this.hardG = hardTurn || hardPull;
    // the boost is spent while held and comes back when you let go
    this.hardFuel = clamp01(
      (this.hardFuel === undefined ? 1 : this.hardFuel)
      + (hardPull ? -dt / 1.25 : dt / 2.2),
    );
    this.stallBoost = hardPull * this.hardFuel;

    let pRoll;
    if (this.state === FLIGHT_STATE.TUMBLE || this.invertedHold) {
      pRoll = rollIn * AERO.rollRate * auth;
    } else {
      // Up to about 85 degrees, not past it: past ninety the lift vector
      // points downwards and the turn rate actually falls. What makes a
      // hard turn sharp is the pull that goes with it, not more bank.
      const targetBank = rollIn * AERO.maxBank * (1 + hardTurn * 0.15);
      const err = targetBank - bank;
      const gain = (Math.abs(rollIn) > 0.05 ? AERO.bankGain : AERO.levelGain)
        * (1 + hardTurn * 1.5);
      const cap = AERO.rollRate * (1 + hardTurn * 1.3);
      pRoll = clamp(err * gain, -cap, cap) * auth;
    }
    let qPitch = pitchIn * AERO.pitchRate * auth * 0.8 * (1 + hardPull * 1.9);
    // Angle-of-attack limiter. The trim point is already capped below the
    // stall, but a raw nose-up rate still overshoots it, which is why
    // pulling up used to end in a tumble every time. Nose-up authority
    // fades out as the stall is approached unless the flare is held.
    if (qPitch > 0 && this.pose.flare < 0.25 && this.state === FLIGHT_STATE.FLYING) {
      // A hard pull is allowed to ride the edge of the stall. That is the
      // whole point of it, and it is recoverable because the limiter only
      // relaxes while the button is held.
      const ceiling = AERO.alphaStall * (1.02 + 0.34 * this.stallBoost);
      const fade = (7.0 + 5.5 * this.stallBoost) * DEG;
      qPitch *= clamp01((ceiling - this.alpha) / fade);
    }
    let rYaw = -yawIn * AERO.yawRate * auth;
    rYaw += -Math.sin(bank) * AERO.coordYaw * clamp01(V / 45);

    const demand = _v1.set(0, 0, 0)
      .addScaledVector(this.fwd, pRoll)
      .addScaledVector(this.right, qPitch)
      .addScaledVector(this.up, rYaw);

    // --- trim stability ---------------------------------------------------
    if (V > 3 && this.state !== FLIGHT_STATE.CANOPY) {
      const p = this.pose;
      // Stowed, the body simply follows the airflow: no wing, no trim point,
      // no lift, straight down.
      let trim =
        AERO.alphaTrim * this.wings +
        pitchIn * AERO.trimRange +
        AERO.trimTuck * p.tuck +
        AERO.trimFlare * p.flare +
        AERO.trimTrack * p.track;
      // Pulling back alone takes you to maximum lift, never past it: you zoom
      // climb and bleed speed instead of flipping into a stall the instant
      // you ask the suit to go up. Stalling is something you choose, with the
      // flare, or fall into when you run out of airspeed.
      if (p.flare < 0.25) trim = Math.min(trim, AERO.alphaStall * 0.96);
      if (this.wings < 0.6) trim *= this.wings / 0.6;
      // Pull-out instinct: in a steep descent the pilot arches and the suit
      // flies at a higher angle of attack, which is what gets a wingsuit back
      // onto its glide in a few seconds instead of a 40 s phugoid. Holding
      // the dive key, or folding the wings, suppresses it.
      if (this.up.y > 0 && this.state === FLIGHT_STATE.FLYING && this.wings > 0.7) {
        const path = Math.asin(clamp(this.vel.y / Math.max(V, 1), -1, 1));
        let recover = clamp(-path - 0.44, 0, 0.75) * 0.62;
        recover *= clamp01(1 + pitchIn) * (1 - this.pose.tuck);
        // the pull-out never stalls you by itself, but your own input still can
        trim = Math.min(trim + recover, Math.max(trim, AERO.alphaStall * 0.95));
      }
      if (this.state === FLIGHT_STATE.TUMBLE) trim = AERO.alphaTrim;
      this.alphaTrim = trim;
      // A falling human can set their body attitude with no airspeed at all,
      // so the floor here is deliberately well above what pure aerodynamics
      // would give: without it the suit exits a cliff belly-flat, stalls and
      // tumbles every single time.
      const qScale = clamp(qdyn / AERO.qRef, 0.38, 1.5) * (1 - this.sep * 0.5) * this.controlScale;
      const pitchErr = this.alpha - trim;
      let pitchFix = clamp(-pitchErr * AERO.stabPitch * qScale, -AERO.stabMax, AERO.stabMax);
      // the limiter applies to the stabiliser too, or recovering from a tuck
      // dive swings the body straight through the stall
      if (pitchFix > 0 && p.flare < 0.25 && this.state === FLIGHT_STATE.FLYING) {
        pitchFix *= clamp01((AERO.alphaStall * 1.05 - this.alpha) / (6.0 * DEG));
      }
      const yawFix = clamp(-this.beta * AERO.stabYaw * qScale, -AERO.stabMax, AERO.stabMax);
      demand.addScaledVector(this.right, pitchFix);
      demand.addScaledVector(this.up, yawFix);
      // damp any residual yaw so a turn settles rather than weaving
      const yawRate = this.omega.dot(this.up);
      demand.addScaledVector(this.up, -yawRate * AERO.yawDamp * clamp01(qdyn / AERO.qRef));
    }

    demand.add(this.trickOmega);

    const k = 1 - Math.exp(-AERO.response * dt);
    this.omega.lerp(demand, k);

    // integrate the quaternion
    const w = this.omega;
    _q1.set(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0);
    _q1.multiply(this.quat);
    this.quat.x += _q1.x;
    this.quat.y += _q1.y;
    this.quat.z += _q1.z;
    this.quat.w += _q1.w;
    this.quat.normalize();
    this.updateAxes();

    // stall -> tumble
    this.tumbleGrace = Math.max(0, (this.tumbleGrace || 0) - dt);
    if (this.state === FLIGHT_STATE.FLYING && this.sep > 0.88 && V > 19 &&
        this.wings > 0.7 && this.sinceLaunch > 2.0 && this.tumbleGrace <= 0) {
      this.tumbleTimer += dt;
      if (this.tumbleTimer > 0.5) this.enterTumble();
    } else if (this.state === FLIGHT_STATE.FLYING) {
      this.tumbleTimer = Math.max(0, this.tumbleTimer - dt * 1.6);
    }
    if (this.state === FLIGHT_STATE.TUMBLE) {
      if (this.sep < 0.3 && Math.abs(this.alpha) < 0.3) {
        this.tumbleTimer -= dt;
        if (this.tumbleTimer <= 0) {
          this.state = FLIGHT_STATE.FLYING;
          this.tumbleRecovered = true;
          this.onEvent?.('tumbleRecover');
        }
      } else {
        this.tumbleTimer = Math.min(1.4, this.tumbleTimer + dt * 0.4);
      }
    }
  }

  enterTumble() {
    if (this.state !== FLIGHT_STATE.FLYING) return;
    this.state = FLIGHT_STATE.TUMBLE;
    this.tumbleTimer = 0.8;
    this.tumbleRecovered = false;
    const s = 2.6;
    this.omega.x += (Math.random() - 0.5) * s;
    this.omega.y += (Math.random() - 0.5) * s * 0.6;
    this.omega.z += (Math.random() - 0.5) * s;
    this.onEvent?.('stall');
  }

  integrateAndCollide(dt) {
    const from = _v1.copy(this.pos);
    const to = _v2.copy(this.pos).addScaledVector(this.vel, dt);
    const hit = this._hit;
    const r = AERO.bodyRadius;
    const t = this.collision.sweep(from.x, from.y, from.z, to.x, to.y, to.z, r, hit);
    this.contact = false;

    if (t < 0) {
      this.pos.copy(to);
      return;
    }

    // contact
    const n = _v3.set(hit.nx, hit.ny, hit.nz);
    const vn = this.vel.dot(n);
    const impactSpeed = -vn;
    this.lastImpactSpeed = impactSpeed;
    this.contact = true;

    this.pos.set(hit.px, hit.py, hit.pz).addScaledVector(n, 0.05);

    const slope = 1 - n.y;
    const alignment = this.fwd.dot(n);

    if (this.state === FLIGHT_STATE.CANOPY) {
      // Under canopy you can put down almost anywhere, which is the whole
      // point of carrying one: any slope you could stand on, at any speed
      // the canopy can reach on its own.
      if (impactSpeed < 16 && slope < 0.82) return this.touchdown(n, impactSpeed, 'canopy');
      if (impactSpeed < 9) {
        // Brushing a wall at walking pace under an open canopy is not a
        // crash, it is a scrape: slide down the face and keep flying until
        // there is something underneath you worth standing on.
        this.vel.addScaledVector(n, -vn * 1.04);
        this.vel.multiplyScalar(0.95);
        this.onEvent?.('skim', { speed: this.speed, normal: n });
        return;
      }
      return this.crash(impactSpeed, n, 'canopy');
    }

    // Two ways down. Arrive slowly enough and you simply land on your feet,
    // which is what makes summits and ledges real places you can stop at.
    // Arrive faster and you need the flare.
    const flaring = this.pose.flare > 0.45;
    const slow = this.speed < AERO.landSpeed && impactSpeed < AERO.landImpact && slope < 0.62;
    if (slow) return this.touchdown(n, impactSpeed, 'stand');
    const flared = slope < 0.46 && impactSpeed < 11 && this.speed < 26 && flaring && alignment > -0.45;
    if (flared) return this.touchdown(n, impactSpeed, 'flare');

    if (impactSpeed < 3.2 && slope < 0.55) {
      // skim: slide along the surface, keep flying
      this.vel.addScaledVector(n, -vn * 1.05);
      this.vel.multiplyScalar(0.992);
      this.onEvent?.('skim', { speed: this.speed, normal: n });
      return;
    }

    this.crash(impactSpeed, n, this.agl < 3 && slope < 0.5 ? 'ground' : 'rock');
  }

  touchdown(n, impactSpeed, how) {
    this.state = FLIGHT_STATE.GROUND;
    this.sinceGround = 0;
    this.wings = 0;
    this.wingsTarget = 0;
    this.landing = {
      how,
      impactSpeed,
      slope: 1 - n.y,
      speed: this.speed,
      quality: clamp01(1 - impactSpeed / AERO.landImpact) * clamp01(1 - (1 - n.y) / 0.6),
    };
    this.groundHeading = Math.atan2(this.vel.x, this.vel.z);
    this.vel.set(0, 0, 0);
    this.omega.set(0, 0, 0);
    this.pos.y = this.field.height(this.pos.x, this.pos.z) + AERO.standHeight;
    this.onEvent?.('land', this.landing);
  }

  /** Spread the arms: the wing inflates and you stop falling and start flying. */
  deployWings() {
    if (this.wingsTarget > 0.5) return false;
    this.wingsTarget = 1;
    this.onEvent?.('deploy', { speed: this.speed });
    return true;
  }

  stowWings() {
    if (this.wingsTarget < 0.5) return false;
    this.wingsTarget = 0;
    this.onEvent?.('stow', {});
    return true;
  }

  toggleWings() {
    return this.wingsTarget > 0.5 ? this.stowWings() : this.deployWings();
  }

  /**
   * On your feet. You can walk to an edge and step off; nothing opens until
   * you spread your arms.
   */
  stepGround(dt, input) {
    this.sinceGround += dt;
    const f = this.field;
    const sp = input.run ? AERO.runSpeed : AERO.walkSpeed;
    const fwdIn = input.walkF || 0;
    const sideIn = input.walkS || 0;
    const mag = Math.hypot(fwdIn, sideIn);

    if (mag > 0.01) {
      const want = input.heading !== undefined ? input.heading : this.groundHeading;
      const moveAng = want + Math.atan2(sideIn, fwdIn);
      this.groundHeading = moveAng;
      const step = sp * Math.min(1, mag) * dt;
      const nx = this.pos.x + Math.sin(moveAng) * step;
      const nz = this.pos.z + Math.cos(moveAng) * step;
      // Both the wall test and the lip test look a fixed 1.5 m ahead. A
      // physics substep is about 5 cm, and judging a slope over 5 cm of
      // smooth terrain is meaningless: it reported gentle ground as a wall
      // (so W did nothing on a summit) and a cliff edge as walkable (so you
      // strolled down the face standing up and never found the edge).
      const here = this.pos.y - AERO.standHeight;
      const probe = 1.5;
      const ph = f.height(
        this.pos.x + Math.sin(moveAng) * probe,
        this.pos.z + Math.cos(moveAng) * probe,
      );
      const rise = ph - here;
      if (rise < -probe * 1.5) {
        // steeper than you could walk down: that is the lip, and you are off
        this.pos.x = nx;
        this.pos.z = nz;
        this.groundHeading = moveAng;
        this.stepOff();
        return;
      }
      if (rise < probe * 1.45) {
        this.pos.x = nx;
        this.pos.z = nz;
      }
    }
    this.walkSpeedNow = mag > 0.01 ? sp * Math.min(1, mag) : 0;
    this.pos.y = f.height(this.pos.x, this.pos.z) + AERO.standHeight;
    this.speed = this.walkSpeedNow;
    this.agl = AERO.standHeight;
    this.vel.set(0, 0, 0);
    this.alpha = 0;
    this.glide = 0;
    this.vario = 0;

    // stand upright, facing the way you are walking
    _q1.setFromAxisAngle(_v1.set(0, 1, 0), this.groundHeading + Math.PI);
    this.quat.slerp(_q1, 1 - Math.exp(-9 * dt));
    this.updateAxes();

    this.edgeTimer = (this.edgeTimer || 0) - dt;
    if (this.edgeTimer <= 0) {
      this.edgeTimer = 0.1;
      this.scanEdge();
    }

    if (input.jump && this.sinceGround > 0.25) this.jump();
  }

  /**
   * Where the nearest big drop is, so the HUD can point at it. Walking a
   * summit looking for the edge with no cue at all is miserable, and the
   * drop you want is often behind you.
   */
  scanEdge() {
    const f = this.field;
    const g0 = this.pos.y - AERO.standHeight;
    let bestDist = Infinity;
    let bestHeading = this.groundHeading;
    let bestDrop = 0;
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const sx = Math.sin(ang);
      const sz = Math.cos(ang);
      for (let d = 5; d <= 220; d += 5) {
        const drop = g0 - f.height(this.pos.x + sx * d, this.pos.z + sz * d);
        if (drop > 40) {
          if (d < bestDist || (d === bestDist && drop > bestDrop)) {
            bestDist = d;
            bestHeading = ang;
            bestDrop = drop;
          }
          break;
        }
      }
    }
    this.edgeDist = bestDist === Infinity ? -1 : bestDist;
    this.edgeHeading = bestHeading;
    this.edgeDrop = bestDrop;
  }

  /**
   * Get clear of the ground before the first sweep runs.
   *
   * standHeight is 0.95 and bodyRadius is 1.15, so anyone who has just been
   * standing is already inside their own collision sphere. The first sweep
   * after leaving the ground therefore always reported a contact: on gentle
   * ground that passed the `slow` test and landed you again the instant you
   * stepped off, and on a steep wall it failed every test and crashed you.
   */
  leaveGround(ahead) {
    const h = this.groundHeading;
    this.pos.x += Math.sin(h) * ahead;
    this.pos.z += Math.cos(h) * ahead;
    const g = this.field.height(this.pos.x, this.pos.z);
    this.pos.y = Math.max(this.pos.y, g + AERO.bodyRadius + 0.25);
  }

  /**
   * Walking off the lip. Unlike a jump there is no push, just the ground
   * ending: you tip forward into the fall.
   */
  stepOff() {
    if (this.state !== FLIGHT_STATE.GROUND) return false;
    this.state = FLIGHT_STATE.FLYING;
    this.sinceLaunch = 0;
    this.leaveGround(1.6);
    // Keep whatever the arms were doing. You walk to a lip with the wing
    // already spread -- that is what the exit is -- and folding them is a
    // deliberate choice you make with H, not something stepping off does
    // to you.
    // Push out off the edge. Nobody steps off a cliff straight down, and
    // the few metres of separation this buys in the first second are what
    // keeps you off the wall while the wing is still coming up to speed.
    const h = this.groundHeading;
    const sp = Math.max(2.2, this.walkSpeedNow || 0) + 3.4;
    this.vel.set(Math.sin(h) * sp, 0.9, Math.cos(h) * sp);
    this.lookAlong(_v1.set(Math.sin(h) * 0.9, -0.44, Math.cos(h) * 0.9).normalize());
    this.onEvent?.('stepoff', {});
    return true;
  }

  /** Step off. Wings stay stowed, so this is a dive until you spread. */
  jump() {
    if (this.state !== FLIGHT_STATE.GROUND) return false;
    this.state = FLIGHT_STATE.FLYING;
    this.sinceLaunch = 0;
    this.leaveGround(0.9);
    this.wings = 0;
    this.wingsTarget = 0;
    const h = this.groundHeading;
    this.vel.set(
      Math.sin(h) * AERO.jumpFwd,
      AERO.jumpUp,
      Math.cos(h) * AERO.jumpFwd,
    );
    this.lookAlong(_v1.set(Math.sin(h), -0.2, Math.cos(h)).normalize());
    this.onEvent?.('jump', {});
    return true;
  }

  crash(impactSpeed, n, kind) {
    if (this.state === FLIGHT_STATE.CRASHED) return;
    this.state = FLIGHT_STATE.CRASHED;
    this.crashKind = kind;
    this.impact = impactSpeed;
    this.crashTimer = 0;
    // scatter the body along the surface
    const tangent = _v1.copy(this.vel).addScaledVector(n, -this.vel.dot(n));
    this.vel.copy(tangent).multiplyScalar(0.42).addScaledVector(n, Math.min(8, impactSpeed * 0.3));
    this.omega.set(
      (Math.random() - 0.5) * 9,
      (Math.random() - 0.5) * 7,
      (Math.random() - 0.5) * 9,
    );
    this.onEvent?.('crash', { kind, impactSpeed });
  }

  stepCrashed(dt) {
    this.crashTimer += dt;
    this.vel.y -= AERO.gravity * dt;
    this.vel.multiplyScalar(1 - 1.6 * dt);
    const to = _v2.copy(this.pos).addScaledVector(this.vel, dt);
    const hit = this._hit;
    const t = this.collision.sweep(this.pos.x, this.pos.y, this.pos.z, to.x, to.y, to.z, AERO.bodyRadius, hit);
    if (t < 0) this.pos.copy(to);
    else {
      const n = _v3.set(hit.nx, hit.ny, hit.nz);
      this.pos.set(hit.px, hit.py, hit.pz).addScaledVector(n, 0.05);
      this.vel.addScaledVector(n, -this.vel.dot(n) * 1.3);
      this.vel.multiplyScalar(0.55);
    }
    const w = this.omega.multiplyScalar(1 - 2.2 * dt);
    _q1.set(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0).multiply(this.quat);
    this.quat.x += _q1.x; this.quat.y += _q1.y; this.quat.z += _q1.z; this.quat.w += _q1.w;
    this.quat.normalize();
    this.updateAxes();
  }

  deployCanopy() {
    if (this.state === FLIGHT_STATE.CANOPY || this.state === FLIGHT_STATE.CRASHED) return;
    this.state = FLIGHT_STATE.CANOPY;
    this.canopy = 0;
    this.onEvent?.('canopy');
  }

  cutCanopy() {
    if (this.state !== FLIGHT_STATE.CANOPY) return;
    this.state = FLIGHT_STATE.FLYING;
    this.canopy = 0;
  }

  /** Called every step from the game to grow the canopy. */
  updateCanopy(dt) {
    if (this.state === FLIGHT_STATE.CANOPY) this.canopy = Math.min(1, this.canopy + dt * 1.4);
  }

  /** Interpolated transform for rendering. */
  sample(alpha, outPos, outQuat) {
    outPos.lerpVectors(this.prevPos, this.pos, alpha);
    outQuat.copy(this.prevQuat).slerp(this.quat, alpha);
  }

  telemetry() {
    return {
      speed: this.speed,
      kmh: this.speed * 3.6,
      alt: this.pos.y,
      agl: this.agl,
      glide: this.glide,
      alpha: this.alpha / DEG,
      beta: this.beta / DEG,
      g: this.gForce,
      vario: this.vario,
      sep: this.sep,
      state: this.state,
      bank: this.bank / DEG,
      pitch: this.pitchAngle / DEG,
      lift: this.lift,
      drag: this.drag,
    };
  }
}
