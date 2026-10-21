// Racing: ten courses of rings through the range, against the clock or
// against bots.
//
// The courses are grown from the terrain rather than authored by hand, which
// is the only way to be sure every one of them is actually flyable: each ring
// is placed by walking forward from the last one along a heading that keeps
// it a sensible height above whatever ground is underneath, descending at
// roughly the glide the suit settles at. A course that asks you to climb is
// not a course, it is a wall.
//
// Bots are not pilots. They run the course line at a pace, which is honest
// about what they are -- a time to beat that you can see -- and avoids an AI
// that flies into a cliff and makes the race meaningless.

import * as THREE from 'three';
import { WORLD } from '../world/field.js';
import { clamp, clamp01 } from '../core/math.js';
import { mulberry32, hashString } from '../core/rng.js';

export const DIFFICULTIES = [
  { key: 'easy', name: 'Easy', pace: 0.70, colour: 0x66d98a },
  { key: 'medium', name: 'Medium', pace: 0.84, colour: 0x7fc4ff },
  { key: 'hard', name: 'Hard', pace: 0.95, colour: 0xffc46b },
  { key: 'extreme', name: 'Extreme', pace: 1.06, colour: 0xff7a5c },
  { key: 'pro', name: 'Pro', pace: 1.18, colour: 0xd77bff },
];

export const diffByKey = (k) => DIFFICULTIES.find((d) => d.key === k) || DIFFICULTIES[1];

// Metres. Wide enough that a course of twenty is a line you fly rather
// than twenty separate lotteries, tight enough that you have to mean it.
const RING_R = 28;

// The most the line may bend between two rings. The suit turns about
// twenty degrees a second at cruise and the rings are roughly four seconds
// apart, so 46 degrees is about 11 degrees a second -- a definite turn you
// have to commit to, with room to spare. The old uncapped search produced
// 74 degree kinks, which is a gate you cannot physically line up for.
const MAX_BEND = 0.80;
// m/s. Not the hands-off glide speed: these lines are steep and you fly
// them fast, so par is set against what you can actually hold on one.
const CRUISE = 46;

// Ten courses, each with its own character. `turn` is how far the line may
// swing between rings, `gap` how far apart they are, `clear` how high above
// the ground they sit.
const STYLES = [
  { name: 'Skyline Descent', turn: 0.22, gap: 150, clear: 70, rings: 16 },
  { name: 'The Anvil Line', turn: 0.30, gap: 135, clear: 55, rings: 18 },
  { name: 'Teeth Slalom', turn: 0.52, gap: 108, clear: 42, rings: 21 },
  { name: 'Citadel Drop', turn: 0.26, gap: 160, clear: 85, rings: 15 },
  { name: 'Glacier Run', turn: 0.34, gap: 140, clear: 60, rings: 17 },
  { name: 'Mesa Canyon', turn: 0.46, gap: 120, clear: 38, rings: 20 },
  { name: 'Lac Blanc Dash', turn: 0.38, gap: 130, clear: 48, rings: 18 },
  { name: 'West Shoulder Cruise', turn: 0.18, gap: 170, clear: 90, rings: 14 },
  { name: 'Chapel Weave', turn: 0.56, gap: 100, clear: 35, rings: 23 },
  { name: 'Raven Sprint', turn: 0.28, gap: 155, clear: 65, rings: 16 },
  // Five more, out on the ranges added with the bigger world. Same steep
  // lines as the rest -- the speed is the point.
  { name: 'Northwall Plunge', turn: 0.24, gap: 165, clear: 78, rings: 16 },
  { name: 'Rampart Run', turn: 0.44, gap: 125, clear: 45, rings: 20 },
  { name: 'Blanche Bowl', turn: 0.36, gap: 140, clear: 58, rings: 18 },
  { name: 'Gendarme Gauntlet', turn: 0.58, gap: 104, clear: 34, rings: 22 },
  { name: 'Westwatch Drop', turn: 0.20, gap: 172, clear: 88, rings: 15 },
];

/**
 * Grows one course from a launch point. Returns the ring list and the par
 * time, or null if the ground here cannot carry a course.
 */
function growCourse(field, start, heading, style, rand) {
  // Lowest clearance anywhere along a straight line, not just at its end.
  // Checking only the ring positions produced courses where every ring was
  // comfortably in the air and the line between two of them went straight
  // through a spur -- five of the ten, when I measured them.
  const segClear = (x0, y0, z0, x1, y1, z1) => {
    let m = Infinity;
    for (let t = 0.08; t <= 1.0001; t += 0.08) {
      const px = x0 + (x1 - x0) * t;
      const py = y0 + (y1 - y0) * t;
      const pz = z0 + (z1 - z0) * t;
      const c = py - field.height(px, pz);
      if (c < m) m = c;
    }
    return m;
  };

  const pts = [];
  let x = start.x;
  let z = start.z;
  let h = heading;
  let y = field.height(x, z) + style.clear;

  // A little noise so two courses from the same launch differ, but the
  // search itself is a deterministic fan: sampling headings at random
  // missed gaps that were there and ended courses after eight rings.
  const bias = (rand() - 0.5) * style.turn;

  for (let i = 0; i < style.rings; i++) {
    // The height of the next ring is not a choice: it is however much
    // altitude the suit loses covering that distance, and a touch more so
    // the line always comes to you rather than sinking away from you.
    // Steering is the only free variable, and when nothing in the fan is
    // clear, try a shorter step before giving up -- that is what lets a
    // course squeeze between two spurs instead of ending at them.
    // Two free variables: which way to steer, and how fast to drop. The
    // line may never be flatter than the glide -- you would sink out of it
    // -- but it may be steeper, because diving is always available to you.
    // Trying the steeper options is what lets a line fall past a ridge
    // instead of ending at it.
    let best = null;
    const gaps = [style.gap, style.gap * 0.72, style.gap * 1.3];
    // Steep first. A course that descends at the glide holds one gradient
    // the whole way down, which is slow, flat and uses almost none of the
    // mountain. Diving is always available to the player, so the line can
    // fall much faster than the suit does on its own -- and that is where
    // the speed comes from. Flatter options are only a fallback for when
    // the terrain leaves nowhere steep to go.
    const glides = [1.45, 1.8, 2.2, 2.6];
    const FAN = 29;
    const spread = Math.min(Math.max(style.turn * 2.4, 0.9), MAX_BEND);
    for (let di = 0; di < glides.length && !best; di++) {
      for (let gi = 0; gi < gaps.length && !best; gi++) {
        const gap = gaps[gi];
        const ny = y - gap / glides[di];
        for (let a = 0; a < FAN; a++) {
          const dh = ((a / (FAN - 1)) * 2 - 1) * spread + bias * 0.35;
          const nh = h + dh;
          const nx = x + Math.sin(nh) * gap;
          const nz = z + Math.cos(nh) * gap;
          if (Math.abs(nx) > WORLD.half - 350 || Math.abs(nz) > WORLD.half - 350) continue;
          const clearance = ny - field.height(nx, nz);
          if (clearance < 20) continue;
          const seg = segClear(x, y, z, nx, ny, nz);
          if (seg < 20) continue;
          // Prefer the clearance this course means to fly at, prefer not to
          // swing far, and prefer room. Flying high over a valley costs
          // almost nothing -- it beats the course ending.
          const err = Math.min(Math.abs(clearance - style.clear), 160);
          const score = -err * 0.5 - Math.abs(dh) * 45 + Math.min(seg, 90) * 0.35;
          if (!best || score > best.score) best = { score, x: nx, z: nz, y: ny, h: nh };
        }
      }
    }
    if (!best) break;
    x = best.x; z = best.z; y = best.y; h = best.h;
    pts.push({ x, y, z, h });
  }

  if (pts.length < 8) return null;

  let length = 0;
  for (let i = 1; i < pts.length; i++) {
    length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z);
  }
  return { rings: pts, length, par: length / CRUISE };
}

/** Builds every course once, at load. */
export function buildCourses(field, launches) {
  const out = [];
  for (let i = 0; i < STYLES.length; i++) {
    const style = STYLES[i];
    const rand = mulberry32(hashString('race.' + style.name));
    // Try this style's own launch first, then any other. A line that will
    // not grow where it was meant to -- the outer launches sit close to
    // the boundary range and run out of room -- is better moved than
    // dropped, or the list is short and nobody knows why.
    let course = null;
    let l = null;
    for (let k = 0; k < launches.length && !course; k++) {
      l = launches[(i + k) % launches.length];
      if (!l) continue;
      for (let t = 0; t < 24 && !course; t++) {
        course = growCourse(field, l, (l.heading || 0) + ((t % 12) - 6) * 0.16, style, rand);
      }
    }
    if (!course || !l) continue;
    out.push({
      id: 'race' + i,
      name: style.name,
      from: l.name,
      start: { x: l.x, y: l.y, z: l.z },
      heading: l.heading || 0,
      rings: course.rings,
      length: course.length,
      par: course.par,
    });
  }
  return out;
}

// --------------------------------------------------------------- rendering

function ringMaterial(colour, emissive) {
  return new THREE.MeshBasicMaterial({
    color: colour, transparent: true, opacity: emissive ? 0.95 : 0.5,
    depthWrite: false,
  });
}

/**
 * The live race: the rings in the world, the bots, the clock and the rules.
 */
export class Race {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    this.ringGeo = new THREE.TorusGeometry(RING_R, 0.95, 8, 40);
    this.nextGeo = new THREE.TorusGeometry(RING_R, 1.45, 8, 40);
    this.wideGeo = new THREE.TorusGeometry(RING_R * 1.5, 1.2, 8, 44);
    this.openGeo = new THREE.TorusGeometry(RING_R * 1.5, 1.7, 8, 44);
    this.matDone = ringMaterial(0x2f3a46, false);
    this.matTodo = ringMaterial(0x9fd7ff, false);
    this.matNext = ringMaterial(0xffc46b, true);

    // A flattened dart rather than a traffic cone: it reads as something
    // flying when you are chasing it, and does not fill the screen when it
    // is next to you.
    this.botGeo = new THREE.ConeGeometry(2.2, 7.0, 5);
    this.botGeo.rotateX(Math.PI * 0.5);
    this.botGeo.scale(1.5, 0.34, 1);
    // ...and a marker drawn on top of everything, because the thing you
    // need to know in a race is where the others are, and for most of a
    // race they are a speck against a mountain or behind you entirely.
    this.pipGeo = new THREE.OctahedronGeometry(1, 0);

    this.meshes = [];
    this.bots = [];
    this.active = null;
    this.running = false;
    this.finished = false;
    this.time = 0;
    this.next = 0;
    this.splits = [];
    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
  }

  /** Lay out a course and its bots. `opponents` is a list of difficulty keys. */
  /**
   * @param {object} course
   * @param {string[]} opponents difficulty keys
   * @param {{x:number,y:number,z:number}} [startPos] where the player
   *   starts, so the bots fly the same run-in instead of appearing at the
   *   first ring with a head start you never see them take.
   */
  begin(course, opponents, startPos) {
    this.clear();
    this.active = course;
    this.running = true;
    this.finished = false;
    this.time = 0;
    this.next = 0;
    this.missed = 0;
    this.splits = [];
    this.group.visible = true;
    this.path = startPos
      ? [{ x: startPos.x, y: startPos.y, z: startPos.z }, ...course.rings]
      : course.rings.slice();

    // The plane each ring is tested against is the direction the line
    // actually passes through it -- previous point to next, in 3D -- which
    // is the same vector the mesh is oriented by, so the test and the
    // picture agree.
    //
    // It used to use the ring's own growth heading, flat. For the first
    // ring that heading points from the launch the course grew out of, not
    // from where the race actually starts you, so on a course where those
    // differ by much you began on the far side of the plane and the gate
    // could never register. And being flat, a steep dive crossed it at an
    // angle, which is why holding Shift through a gate dropped you under
    // the test.
    this.norms = course.rings.map((r, i) => {
      const prev = i > 0 ? course.rings[i - 1] : this.path[0];
      const nxt = course.rings[i + 1] || r;
      let dx = nxt.x - prev.x;
      let dy = nxt.y - prev.y;
      let dz = nxt.z - prev.z;
      let l = Math.hypot(dx, dy, dz);
      if (l < 1e-6) {
        dx = Math.sin(r.h); dy = 0; dz = Math.cos(r.h);
        l = 1;
      }
      return { x: dx / l, y: dy / l, z: dz / l };
    });

    for (let i = 0; i < course.rings.length; i++) {
      const r = course.rings[i];
      // The first two gates are half again as wide. You arrive at them cold,
      // from a start you did not choose, with the line still settling --
      // that is not the moment to be asking for precision.
      const geo = i === 0 ? this.openGeo : (i === 1 ? this.wideGeo : this.ringGeo);
      const m = new THREE.Mesh(geo, this.matTodo);
      m.position.set(r.x, r.y, r.z);
      // Face the ring along the line through it, pitch included. These
      // courses drop at about 1:1.4, so a ring standing bolt upright is
      // one you fly past the top of rather than through.
      // Exactly the vector the ring is tested against, so what you aim at
      // and what counts are the same thing.
      const nv = this.norms[i];
      this._v.set(nv.x, nv.y, nv.z);
      m.lookAt(this._v.add(m.position));
      m.frustumCulled = false;
      this.group.add(m);
      this.meshes.push(m);
    }
    this.restyle();

    for (const key of opponents || []) {
      const d = diffByKey(key);
      const mesh = new THREE.Mesh(this.botGeo, new THREE.MeshBasicMaterial({ color: d.colour }));
      mesh.frustumCulled = false;
      this.group.add(mesh);
      const pip = new THREE.Mesh(this.pipGeo, new THREE.MeshBasicMaterial({
        color: d.colour, transparent: true, opacity: 0.9,
        depthTest: false, depthWrite: false,
      }));
      pip.frustumCulled = false;
      pip.renderOrder = 900;
      this.group.add(pip);
      this.bots.push({ d, mesh, pip, t: 0, finish: course.par / d.pace, done: false });
    }
  }

  clear() {
    for (const m of this.meshes) this.group.remove(m);
    for (const b of this.bots) {
      this.group.remove(b.mesh);
      b.mesh.material.dispose();
      this.group.remove(b.pip);
      b.pip.material.dispose();
    }
    this.meshes.length = 0;
    this.bots.length = 0;
    this.active = null;
    this.running = false;
    this.group.visible = false;
  }

  restyle() {
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      m.material = i < this.next ? this.matDone : (i === this.next ? this.matNext : this.matTodo);
      const wide = i < 2;
      m.geometry = i === this.next
        ? (wide ? this.openGeo : this.nextGeo)
        : (wide ? this.wideGeo : this.ringGeo);
    }
  }

  /**
   * @returns {null|{ring:number}|{finished:true, time:number, placing:number}}
   */
  update(dt, pilotPos, prevPos, camPos) {
    if (!this.running || !this.active) return null;
    this.time += dt;

    for (const b of this.bots) {
      b.t += dt;
      if (b.t >= b.finish) b.done = true;
      const u = clamp01(b.t / b.finish);
      this.sampleCourse(u, this._v);
      b.mesh.position.copy(this._v);
      this.sampleCourse(clamp01(u + 0.01), this._w);
      b.mesh.lookAt(this._w);
      // At the start every bot is sitting where you are; drawn there it
      // fills the screen and hides the first gate.
      const near = camPos ? b.mesh.position.distanceTo(camPos) : 999;
      b.mesh.visible = !b.done && near > 26;
      // The marker is drawn through the mountain and holds a constant size
      // on screen, so a bot is always something you can see and chase.
      b.pip.visible = !b.done && near > 26;
      b.pip.position.copy(b.mesh.position);
      const k = Math.max(3, Math.min(90, near * 0.028));
      b.pip.scale.setScalar(k);
    }

    const r = this.active.rings[this.next];
    if (!r) return null;
    // Miss a gate and the race is over. A time penalty makes a missed gate
    // something you shrug at; ending it is what makes every ring matter.
    const n = this.norms[this.next];
    const radius = this.next < 2 ? RING_R * 1.5 : RING_R;
    const toRing = Math.hypot(pilotPos.x - r.x, pilotPos.y - r.y, pilotPos.z - r.z);
    const past = (pilotPos.x - r.x) * n.x + (pilotPos.y - r.y) * n.y
      + (pilotPos.z - r.z) * n.z;
    if (past > 90 && toRing > radius) {
      this.running = false;
      this.finished = true;
      return { dnf: true, ring: this.next + 1, of: this.active.rings.length };
    }
    // Crossing test: the plane of the ring, inside its radius. Checking the
    // segment rather than the point means you cannot tunnel through it at
    // 150 mph between two frames.
    const d0 = (prevPos.x - r.x) * n.x + (prevPos.y - r.y) * n.y
      + (prevPos.z - r.z) * n.z;
    const d1 = past;
    if (d0 < 0 && d1 >= 0) {
      const t = d1 === d0 ? 0 : -d0 / (d1 - d0);
      const cx = prevPos.x + (pilotPos.x - prevPos.x) * t;
      const cy = prevPos.y + (pilotPos.y - prevPos.y) * t;
      const cz = prevPos.z + (pilotPos.z - prevPos.z) * t;
      const dist = Math.hypot(cx - r.x, cy - r.y, cz - r.z);
      if (dist <= radius) {
        this.splits.push(this.time);
        this.next++;
        if (this.next >= this.active.rings.length) {
          this.running = false;
          this.finished = true;
          let placing = 1;
          for (const b of this.bots) if (b.finish < this.time) placing++;
          return {
            finished: true, time: this.time, placing,
            field: this.bots.length + 1, missed: this.missed,
          };
        }
        this.restyle();
        return { ring: this.next, of: this.active.rings.length };
      }
    }
    return null;
  }

  /** Position along the flown path, u in 0..1. */
  sampleCourse(u, out) {
    const r = this.path || this.active.rings;
    const f = u * (r.length - 1);
    const i = Math.min(r.length - 2, Math.floor(f));
    const t = f - i;
    out.set(
      r[i].x + (r[i + 1].x - r[i].x) * t,
      r[i].y + (r[i + 1].y - r[i].y) * t,
      r[i].z + (r[i + 1].z - r[i].z) * t,
    );
    return out;
  }

  /** Metres to the next ring, for the HUD. */
  distanceToNext(pos) {
    if (!this.active) return -1;
    const r = this.active.rings[this.next];
    if (!r) return -1;
    return Math.hypot(pos.x - r.x, pos.y - r.y, pos.z - r.z);
  }

  /** Seconds ahead (+) or behind (-) the best bot, for the HUD. */
  gap() {
    if (!this.bots.length || !this.active) return null;
    let best = Infinity;
    for (const b of this.bots) best = Math.min(best, b.finish);
    const myPace = this.next > 0 ? this.time / this.next * this.active.rings.length : null;
    if (myPace === null) return null;
    return best - myPace;
  }
}
