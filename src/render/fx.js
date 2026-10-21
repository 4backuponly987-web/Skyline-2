// Wingtip trails and pooled particles.
//
// The trails do a lot of work: they make a barrel roll legible from the chase
// camera, they show the shape of a turn, and they are the light-painting the
// replay mode draws with. Intensity rises with speed and with how close the
// wingtip is to rock.

import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep } from '../core/math.js';

const TRAIL_VERT = /* glsl */ `
attribute float alpha;
attribute vec3 tint;
varying float vA;
varying vec3 vT;
void main() {
  vA = alpha;
  vT = tint;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const TRAIL_FRAG = /* glsl */ `
precision highp float;
varying float vA;
varying vec3 vT;
uniform float uOpacity;
void main() {
  if (vA <= 0.002) discard;
  gl_FragColor = vec4(vT * vA, vA * uOpacity);
}
`;

export function makeTrailMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0.55 } },
    vertexShader: TRAIL_VERT,
    fragmentShader: TRAIL_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

export class TrailRibbon {
  constructor(material, segments = 72, width = 0.06) {
    this.n = segments;
    this.width = width;
    this.head = 0;
    this.count = 0;
    this.minStep = 0.35;

    const verts = segments * 2;
    this.pos = new Float32Array(verts * 3);
    this.alpha = new Float32Array(verts);
    this.tint = new Float32Array(verts * 3);
    this.age = new Float32Array(segments);
    this.life = 0.85;

    const idx = [];
    for (let i = 0; i < segments - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setAttribute('tint', new THREE.BufferAttribute(this.tint, 3));
    geo.setIndex(idx);
    geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
    geo.attributes.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this._last = new THREE.Vector3(1e9, 1e9, 1e9);
    this._side = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  reset() {
    this.count = 0;
    this.head = 0;
    this.alpha.fill(0);
    this.geometry.attributes.alpha.needsUpdate = true;
    this._last.set(1e9, 1e9, 1e9);
  }

  /** Appends a point. `up` orients the ribbon; `strength` 0..1 and `color`. */
  push(p, up, strength, color) {
    const d = this._dir.copy(p).sub(this._last);
    const dist = d.length();
    if (dist < this.minStep) return;
    if (dist > 400) { this.reset(); }
    d.multiplyScalar(1 / Math.max(dist, 1e-5));
    this._side.crossVectors(d, up).normalize().multiplyScalar(this.width * (0.7 + strength * 0.6));
    this._last.copy(p);

    const i = this.head;
    const a = i * 2;
    this.pos[a * 3] = p.x - this._side.x;
    this.pos[a * 3 + 1] = p.y - this._side.y;
    this.pos[a * 3 + 2] = p.z - this._side.z;
    this.pos[(a + 1) * 3] = p.x + this._side.x;
    this.pos[(a + 1) * 3 + 1] = p.y + this._side.y;
    this.pos[(a + 1) * 3 + 2] = p.z + this._side.z;
    this.age[i] = 0;
    const c = color || WHITE;
    for (let k = 0; k < 2; k++) {
      this.tint[(a + k) * 3] = c[0];
      this.tint[(a + k) * 3 + 1] = c[1];
      this.tint[(a + k) * 3 + 2] = c[2];
      this.alpha[a + k] = strength * 0.34;
    }
    this.head = (i + 1) % this.n;
    this.count = Math.min(this.count + 1, this.n);
    this._dirty = true;
  }

  update(dt) {
    let any = false;
    for (let i = 0; i < this.n; i++) {
      if (this.alpha[i * 2] <= 0.001) continue;
      this.age[i] += dt;
      const f = clamp01(1 - this.age[i] / this.life);
      const v = f * f;
      this.alpha[i * 2] = v;
      this.alpha[i * 2 + 1] = v;
      any = true;
    }
    // break the ribbon at the write head so the oldest and newest do not join
    const h = this.head * 2;
    this.alpha[h] = 0;
    this.alpha[h + 1] = 0;
    const h2 = ((this.head + 1) % this.n) * 2;
    this.alpha[h2] = 0;
    this.alpha[h2 + 1] = 0;
    if (any || this._dirty) {
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.alpha.needsUpdate = true;
      this.geometry.attributes.tint.needsUpdate = true;
      this._dirty = false;
    }
  }
}

const WHITE = [1, 1, 1];

/** Pooled camera-facing particles for spray, mist and impacts. */
export class Particles {
  constructor(max = 900) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.col = new Float32Array(max * 3);
    this.cursor = 0;
    this.live = 0;

    const geo = new THREE.BufferGeometry();
    this.aPos = new Float32Array(max * 3);
    this.aAlpha = new Float32Array(max);
    this.aSize = new Float32Array(max);
    this.aCol = new Float32Array(max * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.aPos, 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.aAlpha, 1));
    geo.setAttribute('psize', new THREE.BufferAttribute(this.aSize, 1));
    geo.setAttribute('tint', new THREE.BufferAttribute(this.aCol, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    geo.setDrawRange(0, 0);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute float alpha;
        attribute float psize;
        attribute vec3 tint;
        varying float vA;
        varying vec3 vT;
        uniform float uScale;
        void main() {
          vA = alpha; vT = tint;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(1.0, psize * uScale / max(-mv.z, 1.0));
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying float vA;
        varying vec3 vT;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d);
          if (r > 0.25) discard;
          float a = vA * (1.0 - r * 4.0);
          gl_FragColor = vec4(vT * a, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
  }

  spawn(x, y, z, vx, vy, vz, life, size, r, g, b) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
  }

  update(dt, drag = 1.6, gravity = -1.2) {
    let n = 0;
    const k = Math.max(0, 1 - drag * dt);
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k + gravity * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const f = this.life[i] / this.maxLife[i];
      this.aPos[n * 3] = this.pos[i * 3];
      this.aPos[n * 3 + 1] = this.pos[i * 3 + 1];
      this.aPos[n * 3 + 2] = this.pos[i * 3 + 2];
      this.aAlpha[n] = f * f * 0.85;
      this.aSize[n] = this.size[i] * (1.4 - f * 0.4);
      this.aCol[n * 3] = this.col[i * 3];
      this.aCol[n * 3 + 1] = this.col[i * 3 + 1];
      this.aCol[n * 3 + 2] = this.col[i * 3 + 2];
      n++;
    }
    this.live = n;
    this.geometry.setDrawRange(0, n);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.alpha.needsUpdate = true;
    this.geometry.attributes.psize.needsUpdate = true;
    this.geometry.attributes.tint.needsUpdate = true;
  }
}
