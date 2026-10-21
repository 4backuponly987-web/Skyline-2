// Camera rigs.
//
// Chase is the one that matters: a spring follow that lags under acceleration
// and catches up, framed along the flight path rather than the body axis (so
// a barrel roll spins the suit, not the world), with speed-mapped FOV, a
// look-ahead that puts the gap you are aiming for in frame, proximity shake,
// and a hard guarantee that it never ends up inside rock.

import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, damp, remapClamped, DEG } from '../core/math.js';

export const CAM_MODES = ['chase', 'helmet', 'wingtip', 'cinematic', 'free'];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _hit = { t: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0 };

export class CameraRig {
  constructor(camera, collision) {
    this.camera = camera;
    this.collision = collision;
    this.mode = 'chase';
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.upTarget = new THREE.Vector3(0, 1, 0);
    this.worldUp = new THREE.Vector3(0, 1, 0);
    this.vel = new THREE.Vector3();
    this.fov = 62;
    this.targetFov = 62;
    this.roll = 0;
    this.shake = 0;
    this.shakeSeed = Math.random() * 100;
    this.proximity = 1;
    this.distance = 7.6;
    this.height = 1.7;
    this.freePos = new THREE.Vector3();
    this.freeYaw = 0;
    this.freePitch = 0;
    this.cineTimer = 0;
    this.cineFrom = new THREE.Vector3();
    this.cineTo = new THREE.Vector3();
    this.cineT = 0;
    this.initialised = false;
    this.time = 0;
    this.buffet = new THREE.Vector3();
    this.fovBoost = 0;
    this.impulse = new THREE.Vector3();
  }

  setMode(m) {
    this.mode = m;
    if (m === 'free') {
      this.freePos.copy(this.pos);
      const dir = _v.copy(this.look).sub(this.pos).normalize();
      this.freeYaw = Math.atan2(dir.x, dir.z);
      this.freePitch = Math.asin(clamp(dir.y, -1, 1));
    }
  }

  cycle() {
    const i = CAM_MODES.indexOf(this.mode);
    this.setMode(CAM_MODES[(i + 1) % CAM_MODES.length]);
    return this.mode;
  }

  kick(strength, dirx = 0, diry = 0, dirz = 0) {
    this.shake = Math.min(2.4, this.shake + strength);
    this.impulse.x += dirx;
    this.impulse.y += diry;
    this.impulse.z += dirz;
  }

  /**
   * @param {number} dt
   * @param {object} p  {pos, quat, vel, speed, nearest, state}
   * @param {object} opts {freeInput}
   */
  update(dt, p, opts = {}) {
    this.time += dt;
    const speed = p.vel.length();

    if (!this.initialised) {
      // A standing start has no velocity to aim along, and normalising a zero
      // vector gave (0,0,0): the camera was placed exactly on the pilot, with
      // an undefined yaw that the ground controls then steered by.
      // `p` here is the interpolated view state, which carries an
      // orientation but no forward vector, so take the nose from the
      // quaternion.
      if (speed > 1) _v.copy(p.vel).multiplyScalar(1 / speed);
      else _v.set(0, 0, -1).applyQuaternion(p.quat).setY(0);
      if (_v.lengthSq() < 1e-6) _v.set(0, 0, -1);
      _v.normalize();
      this.pos.copy(p.pos).addScaledVector(_v, -this.distance);
      this.pos.y += this.height;
      this.look.copy(p.pos);
      this.initialised = true;
    }

    switch (this.mode) {
      case 'helmet': this.updateHelmet(dt, p); break;
      case 'wingtip': this.updateWingtip(dt, p); break;
      case 'cinematic': this.updateCinematic(dt, p); break;
      case 'free': this.updateFree(dt, p, opts.freeInput); break;
      default: this.updateChase(dt, p); break;
    }

    // --- shake, FOV and roll ------------------------------------------------
    this.shake = Math.max(0, this.shake - dt * 2.6);
    this.impulse.multiplyScalar(Math.max(0, 1 - dt * 6));

    const prox = p.nearest !== undefined ? p.nearest : 999;
    const proxShake = smoothstep(26, 4, prox) * clamp01(speed / 55) * 0.55;
    // Past about 115 mph the airframe starts to buffet. It builds from
    // nothing so there is no line you cross, just a growing sense that the
    // suit is working hard.
    const fastShake = smoothstep(51.4, 78, speed) * 0.62;
    const total = this.mode === 'free' || this.mode === 'cinematic'
      ? 0 : this.shake + proxShake + fastShake;

    if (total > 0.001) {
      const t = this.time * 26;
      const s = this.shakeSeed;
      _v.set(
        Math.sin(t * 1.17 + s) * 0.6 + Math.sin(t * 2.93 + s * 2) * 0.4,
        Math.sin(t * 1.61 + s * 3) * 0.6 + Math.sin(t * 3.31 + s) * 0.4,
        Math.sin(t * 1.37 + s * 5) * 0.5,
      ).multiplyScalar(total * 0.14);
      this.pos.add(_v);
      this.look.addScaledVector(_v, 0.35);
    }
    this.pos.add(this.impulse);

    this.proximity = prox;

    this.camera.position.copy(this.pos);
    if (this.mode === 'helmet') {
      this.camera.quaternion.copy(this._helmetQuat);
    } else {
      // The camera's bank comes from blending its up vector toward the
      // pilot's, not from a roll angle. A roll angle has a sign that is easy
      // to get backwards, and getting it backwards makes a right-hand bank
      // read as a left-hand one.
      this.up.lerp(this.upTarget, 1 - Math.exp(-7 * dt));
      if (this.up.lengthSq() < 1e-5) this.up.set(0, 1, 0);
      this.up.normalize();
      _m.lookAt(this.pos, this.look, this.up);
      this.camera.quaternion.setFromRotationMatrix(_m);
    }

    // A much wider swing, starting from the speed you actually fly at.
    const fovTarget = this.mode === 'free' || this.mode === 'photo'
      ? 58
      : remapClamped(speed, 16, 78, 62, 100) + this.fovBoost;
    this.targetFov = fovTarget;
    this.fov = damp(this.fov, fovTarget, 3.2, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  updateChase(dt, p) {
    const speed = p.vel.length();

    // On your feet this is a third-person shot, not a chase: the flying
    // framing sits low and behind and lets terrain avoidance pull it in,
    // and on a rim that ray grazes your own ground and collapses the
    // camera into the back of your head.
    //
    // The two framings are blended rather than switched. Cutting between
    // them the instant you step off a lip threw the camera across the
    // scene at exactly the moment you needed to see where you were going.
    const onFoot = p.agl !== undefined && p.agl < 1.6 ? 1 : 0;
    this.groundMix = damp(this.groundMix || 0, onFoot, 2.6, dt);
    if (this.groundMix > 0.002) {
      const f = _v.set(0, 0, -1).applyQuaternion(p.quat);
      f.y = 0;
      if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
      f.normalize();
      const want = _v2.copy(p.pos).addScaledVector(f, -4.4);
      // Clear the ground, but do not ride up the hill behind you: capped,
      // or on a summit the camera climbs the slope and the character ends
      // up a speck at the bottom of the frame.
      const gh = this.collision.field.height(want.x, want.z) + 1.3;
      want.y = Math.min(Math.max(p.pos.y + 1.9, gh), p.pos.y + 3.2);
      const m = this.groundMix;
      const lam = lerp(5.5, 7, m);
      // where the ground shot wants to be, mixed with where we are
      this._gWant = this._gWant || new THREE.Vector3();
      this._gWant.copy(want);
      this._gLook = this._gLook || new THREE.Vector3();
      this._gLook.copy(p.pos).addScaledVector(f, 3.5).setY(p.pos.y + 0.75);
      if (m > 0.985) {
        this.pos.x = damp(this.pos.x, want.x, lam, dt);
        this.pos.y = damp(this.pos.y, want.y, lam, dt);
        this.pos.z = damp(this.pos.z, want.z, lam, dt);
        this.look.lerp(this._gLook, 1 - Math.exp(-8 * dt));
        this.upTarget.copy(this.worldUp);
        return;
      }
    }

    // Frame along the flight path, blended slightly toward the body axis so a
    // deliberate knife-edge still reads.
    const flight = _v.copy(p.vel);
    if (flight.lengthSq() < 1) flight.set(0, 0, -1).applyQuaternion(p.quat);
    flight.normalize();
    const bodyF = _v2.set(0, 0, -1).applyQuaternion(p.quat);
    const dir = flight.lerp(bodyF, 0.22).normalize();
    // Keep the horizon in frame: a steep dive would otherwise park the camera
    // directly overhead looking straight down, which reads as falling, not
    // flying.
    if (dir.y < -0.55) {
      dir.y = lerp(dir.y, -0.55, 0.72);
      dir.normalize();
    }

    // Draw in at speed rather than backing off: close is fast.
    const dist = this.distance * lerp(1.04, 0.84, clamp01((speed - 20) / 60));
    let rise = this.height + clamp01((speed - 30) / 70) * 0.9;
    // Under canopy there is seven metres of parachute above the pilot, so
    // stand off and look up or the whole thing hangs out of frame.
    const chute = clamp01(p.canopy || 0);
    const back = dist * (1 + chute * 1.5);
    rise += chute * 3.4;

    const desired = _v2.copy(p.pos)
      .addScaledVector(dir, -back)
      .addScaledVector(this.up, rise);
    if (this.groundMix > 0.002 && this._gWant) desired.lerp(this._gWant, this.groundMix);
    // bias the camera above the terrain so you can see what you are flying at
    const groundClear = p.agl !== undefined ? p.agl : 100;
    if (groundClear < 30) desired.y += (30 - groundClear) * 0.22;

    // spring: lags under acceleration and catches up
    const lambda = lerp(5.5, 9.0, clamp01(speed / 80));
    this.pos.x = damp(this.pos.x, desired.x, lambda, dt);
    this.pos.y = damp(this.pos.y, desired.y, lambda * 1.15, dt);
    this.pos.z = damp(this.pos.z, desired.z, lambda, dt);

    // look-ahead frames the gap you are flying at
    const ahead = lerp(6, 34, clamp01((speed - 25) / 70));
    const lookTarget = _v3.copy(p.pos)
      .addScaledVector(dir, ahead * 0.55)
      .addScaledVector(this.up, 0.6 + chute * 2.6);
    if (this.groundMix > 0.002 && this._gLook) lookTarget.lerp(this._gLook, this.groundMix);
    this.look.lerp(lookTarget, 1 - Math.exp(-11 * dt));

    // Partial bank follow: enough to feel the turn, not enough to disorient,
    // and switched off during a trick so the suit visibly spins against a
    // steady horizon instead of the whole world tumbling.
    const bodyUp = _v.set(0, 1, 0).applyQuaternion(p.quat);
    const follow = 0.42 * (1 - clamp01(p.trickBlend || 0));
    this.upTarget.copy(this.worldUp).lerp(bodyUp, follow);
    if (this.upTarget.y < 0.25) this.upTarget.y = 0.25;

    this.avoidTerrain(p.pos, 1.4);
  }

  updateHelmet(dt, p) {
    const head = p.headPos || p.pos;
    const q = p.headQuat || p.quat;
    this.pos.copy(head).addScaledVector(_v.set(0, 0, -1).applyQuaternion(q), 0.14);
    this.pos.addScaledVector(_v.set(0, 1, 0).applyQuaternion(q), 0.02);

    // wind buffeting grows with speed
    const sp = clamp01(p.vel.length() / 85);
    const t = this.time;
    const bx = (Math.sin(t * 23.3) * 0.6 + Math.sin(t * 41.7) * 0.4) * 0.011 * sp;
    const by = (Math.sin(t * 19.1) * 0.6 + Math.sin(t * 37.3) * 0.4) * 0.011 * sp;
    _q.setFromEuler(new THREE.Euler(by, bx, bx * 0.5, 'XYZ'));
    this._helmetQuat = (this._helmetQuat || new THREE.Quaternion()).copy(q).multiply(_q);
    this.look.copy(this.pos).addScaledVector(_v.set(0, 0, -1).applyQuaternion(this._helmetQuat), 10);
    this.roll = 0;
  }

  updateWingtip(dt, p) {
    const tip = p.tipPos || p.pos;
    const back = _v.set(0, 0, 1).applyQuaternion(p.quat).multiplyScalar(0.55);
    const out = _v2.set(1, 0, 0).applyQuaternion(p.quat).multiplyScalar(0.3);
    const desired = _v3.copy(tip).add(back).add(out);
    this.pos.lerp(desired, 1 - Math.exp(-22 * dt));
    const lookAt = _v.copy(p.pos).addScaledVector(_v2.set(0, 0, -1).applyQuaternion(p.quat), 3.5);
    this.look.lerp(lookAt, 1 - Math.exp(-14 * dt));
    this.upTarget.set(0, 1, 0).applyQuaternion(p.quat);
    this.avoidTerrain(p.pos, 0.9);
  }

  updateCinematic(dt, p) {
    this.cineTimer -= dt;
    if (this.cineTimer <= 0) this.pickCinematic(p);
    this.cineT += dt;
    const k = clamp01(this.cineT / 6.0);
    this.pos.lerpVectors(this.cineFrom, this.cineTo, k * k * (3 - 2 * k));
    this.look.lerp(p.pos, 1 - Math.exp(-6 * dt));
    this.upTarget.set(0, 1, 0);
  }

  pickCinematic(p) {
    const speed = Math.max(12, p.vel.length());
    const dir = _v.copy(p.vel).normalize();
    const side = _v2.crossVectors(dir, this.up).normalize();
    const s = Math.random() < 0.5 ? 1 : -1;
    const lead = 2.0 + Math.random() * 2.5;
    this.cineFrom.copy(p.pos)
      .addScaledVector(dir, speed * lead)
      .addScaledVector(side, s * (16 + Math.random() * 26))
      .addScaledVector(this.up, -4 + Math.random() * 26);
    this.cineTo.copy(this.cineFrom).addScaledVector(side, -s * 10).addScaledVector(dir, -8);
    // keep the shot out of the ground
    const h = this.collision.field.height(this.cineFrom.x, this.cineFrom.z) + 12;
    if (this.cineFrom.y < h) this.cineFrom.y = h;
    if (this.cineTo.y < h) this.cineTo.y = h;
    this.cineTimer = 5.0 + Math.random() * 2.5;
    this.cineT = 0;
    this.pos.copy(this.cineFrom);
  }

  updateFree(dt, p, inp) {
    const i = inp || { f: 0, s: 0, u: 0, dx: 0, dy: 0, boost: 1 };
    this.freeYaw -= i.dx;
    this.freePitch = clamp(this.freePitch - i.dy, -1.5, 1.5);
    const dir = _v.set(
      Math.sin(this.freeYaw) * Math.cos(this.freePitch),
      Math.sin(this.freePitch),
      Math.cos(this.freeYaw) * Math.cos(this.freePitch),
    );
    const right = _v2.set(Math.cos(this.freeYaw), 0, -Math.sin(this.freeYaw));
    const sp = 40 * (i.boost || 1);
    this.freePos.addScaledVector(dir, i.f * sp * dt);
    this.freePos.addScaledVector(right, i.s * sp * dt);
    this.freePos.y += i.u * sp * dt;
    this.pos.copy(this.freePos);
    this.look.copy(this.pos).add(dir);
    this.upTarget.set(0, 1, 0);
  }

  /** Pull the camera in if rock gets between it and the pilot. */
  avoidTerrain(pilotPos, margin) {
    // Cast from chest height, not from the pilot's origin. Standing on the
    // ground the origin is only 0.95 m up, so the ray grazed the pilot's own
    // hillside immediately and yanked the camera in to its 1.2 m minimum --
    // which put it inside the character's head on every standing start.
    const oy = pilotPos.y + 1.1;
    const d = _v.copy(this.pos).sub(pilotPos);
    d.y -= 1.1;
    const len = d.length();
    if (len < 0.2) return;
    d.multiplyScalar(1 / len);
    const t = this.collision.ray(pilotPos.x, oy, pilotPos.z, d.x, d.y, d.z, len + margin, _hit);
    if (t >= 0) {
      const safe = Math.max(1.2, t - margin);
      this.pos.set(pilotPos.x, oy, pilotPos.z).addScaledVector(d, safe);
    }
    // never below the surface
    const h = this.collision.field.height(this.pos.x, this.pos.z) + 1.4;
    if (this.pos.y < h) this.pos.y = h;
  }
}
