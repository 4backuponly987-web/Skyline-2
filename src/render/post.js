// Post-processing: a small hand-written chain rather than EffectComposer, so
// there is exactly one full-screen composite doing tone mapping, bloom,
// speed vignette, radial smear and grading in a single pass.

import * as THREE from 'three';
import { clamp, clamp01, lerp, damp } from '../core/math.js';

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const BRIGHT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float uThreshold;
uniform float uSoft;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = smoothstep(uThreshold, uThreshold + uSoft, l);
  gl_FragColor = vec4(c * k, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uDir;
void main() {
  vec3 s = texture2D(tDiffuse, vUv).rgb * 0.227027;
  s += texture2D(tDiffuse, vUv + uDir * 1.3846).rgb * 0.316216;
  s += texture2D(tDiffuse, vUv - uDir * 1.3846).rgb * 0.316216;
  s += texture2D(tDiffuse, vUv + uDir * 3.2308).rgb * 0.070270;
  s += texture2D(tDiffuse, vUv - uDir * 3.2308).rgb * 0.070270;
  gl_FragColor = vec4(s, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform sampler2D tBloom2;
uniform float uBloom;
uniform float uExposure;
uniform float uVignette;
uniform float uCA;
uniform float uSmear;
uniform float uGrain;
uniform float uTime;
uniform float uFlow;
uniform float uSat;
uniform vec3 uTint;
uniform float uDesat;
uniform float uFlash;
uniform float uFrost;
uniform float uMist;
uniform int uSmearTaps;

// ACES filmic approximation
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);

  // Radial smear toward the edges: reads as speed without a velocity
  // buffer. Both this and the aberration are radial rescalings of the same
  // image, so they are done together, one pass, three channels at slightly
  // different radii. Doing the aberration afterwards as a separate step
  // overwrote red and blue with UNsmeared samples while green kept the
  // smeared one, which split the whole picture into magenta and green --
  // invisible while the smear only ran above 85 mph, obvious once it ran
  // in normal flight.
  float amt = uCA * r2;
  vec3 col;
  if (uSmear > 0.001) {
    vec3 acc = vec3(0.0);
    float w = 0.0;
    for (int i = 0; i < 8; i++) {
      if (i >= uSmearTaps) break;
      float t = float(i) / float(uSmearTaps);
      float k = 1.0 - t * uSmear * r2 * 2.2;
      float wt = 1.0 - t * 0.55;
      acc.r += texture2D(tDiffuse, 0.5 + c * (k + amt)).r * wt;
      acc.g += texture2D(tDiffuse, 0.5 + c * k).g * wt;
      acc.b += texture2D(tDiffuse, 0.5 + c * (k - amt)).b * wt;
      w += wt;
    }
    col = acc / w;
  } else if (amt > 0.0001) {
    col.r = texture2D(tDiffuse, 0.5 + c * (1.0 + amt)).r;
    col.g = texture2D(tDiffuse, uv).g;
    col.b = texture2D(tDiffuse, 0.5 + c * (1.0 - amt)).b;
  } else {
    col = texture2D(tDiffuse, uv).rgb;
  }

  vec3 bloom = texture2D(tBloom, uv).rgb + texture2D(tBloom2, uv).rgb * 0.7;
  col += bloom * uBloom;

  col *= uExposure;
  col *= uTint;

  // flow state: lifts the image a touch and warms it
  col = mix(col, col * vec3(1.06, 1.02, 0.96) + vec3(0.012, 0.010, 0.004), uFlow);

  col = aces(col);

  // grade
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, uSat);
  col = mix(col, vec3(lum), uDesat);

  // goggle frost in the helmet cam
  if (uFrost > 0.001) {
    float f = smoothstep(0.12, 0.5, r2) * uFrost;
    float n = hash12(floor(uv * 180.0));
    col = mix(col, col * (0.82 + n * 0.5) + vec3(0.06, 0.07, 0.09) * n, f);
  }

  // waterfall mist: the world goes bright, flat and cold
  if (uMist > 0.001) {
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    vec3 veil = mix(col, vec3(l), 0.65) * 1.12 + vec3(0.10, 0.12, 0.13);
    col = mix(col, veil, clamp(uMist, 0.0, 1.0) * 0.85);
  }

  // vignette
  float v = 1.0 - uVignette * smoothstep(0.08, 0.72, r2);
  col *= v;

  col += uFlash;

  // grain
  if (uGrain > 0.0) {
    float g = hash12(uv * 1024.0 + fract(uTime) * 91.7) - 0.5;
    col += g * uGrain;
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

class Pass {
  constructor(frag, uniforms) {
    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: QUAD_VERT,
      fragmentShader: frag,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
  }
}

export class PostChain {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.enabled = opts.bloom !== false;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const type = THREE.HalfFloatType;
    const make = (w, h) => new THREE.WebGLRenderTarget(w, h, {
      type, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: true, stencilBuffer: false,
    });

    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    this.rtScene = make(size.x, size.y);
    this.rtA = make(Math.max(2, size.x >> 1), Math.max(2, size.y >> 1));
    this.rtB = make(Math.max(2, size.x >> 1), Math.max(2, size.y >> 1));
    this.rtC = make(Math.max(2, size.x >> 2), Math.max(2, size.y >> 2));
    this.rtD = make(Math.max(2, size.x >> 2), Math.max(2, size.y >> 2));
    this.rtA.depthBuffer = false;
    this.rtB.depthBuffer = false;
    this.rtC.depthBuffer = false;
    this.rtD.depthBuffer = false;

    this.bright = new Pass(BRIGHT_FRAG, {
      tDiffuse: { value: null },
      uThreshold: { value: 1.12 },
      uSoft: { value: 0.65 },
    });
    this.blur = new Pass(BLUR_FRAG, {
      tDiffuse: { value: null },
      uDir: { value: new THREE.Vector2() },
    });
    this.composite = new Pass(COMPOSITE_FRAG, {
      tDiffuse: { value: null },
      tBloom: { value: null },
      tBloom2: { value: null },
      uBloom: { value: 0.5 },
      uExposure: { value: 1.0 },
      uVignette: { value: 0.3 },
      uCA: { value: 0 },
      uSmear: { value: 0 },
      uGrain: { value: 0.012 },
      uTime: { value: 0 },
      uFlow: { value: 0 },
      uSat: { value: 1.06 },
      uDesat: { value: 0 },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uFlash: { value: 0 },
      uFrost: { value: 0 },
      uMist: { value: 0 },
      uSmearTaps: { value: opts.smearTaps ?? 6 },
    });
    this.u = this.composite.material.uniforms;
    this.smooth = { ca: 0, smear: 0, vig: 0.3 };
  }

  setSize(w, h) {
    this.rtScene.setSize(w, h);
    this.rtA.setSize(Math.max(2, w >> 1), Math.max(2, h >> 1));
    this.rtB.setSize(Math.max(2, w >> 1), Math.max(2, h >> 1));
    this.rtC.setSize(Math.max(2, w >> 2), Math.max(2, h >> 2));
    this.rtD.setSize(Math.max(2, w >> 2), Math.max(2, h >> 2));
  }

  /** @param {object} s {speed, flow, prox, frost, flash, night, exposure} */
  tune(dt, s) {
    // The ramp used to start at 38 m/s (85 mph), which is above the speed
    // the suit actually cruises at -- so in normal flight there was no
    // smear, no aberration and no vignette, and 80 mph felt like 20.
    const sp = clamp01((s.speed - 17) / 48);
    // Aberration reads as a broken renderer long before it reads as speed;
    // the smear is what actually sells it.
    this.smooth.ca = damp(this.smooth.ca, sp * 0.0022, 4, dt);
    this.smooth.smear = damp(this.smooth.smear, sp * sp * 0.78, 3.5, dt);
    this.smooth.vig = damp(this.smooth.vig, 0.24 + sp * 0.44 + clamp01(1 - s.prox / 18) * 0.18, 4, dt);
    this.u.uCA.value = this.smooth.ca;
    this.u.uSmear.value = s.allowSmear === false ? 0 : this.smooth.smear;
    this.u.uVignette.value = this.smooth.vig;
    this.u.uFlow.value = s.flow || 0;
    this.u.uSat.value = 1.14 + (s.flow || 0) * 0.12;
    this.u.uFrost.value = s.frost || 0;
    this.u.uMist.value = s.mist || 0;
    this.u.uFlash.value = s.flash || 0;
    this.u.uExposure.value = s.exposure ?? 1.0;
    this.u.uBloom.value = s.bloom ?? 0.42;
    this.u.uTime.value = (this.u.uTime.value + dt) % 100;
  }

  render(scene, camera) {
    const r = this.renderer;
    if (!this.enabled) {
      r.setRenderTarget(null);
      r.render(scene, camera);
      return;
    }
    const prevTone = r.toneMapping;
    r.toneMapping = THREE.NoToneMapping;

    r.setRenderTarget(this.rtScene);
    r.clear();
    r.render(scene, camera);

    // bright pass
    this.bright.material.uniforms.tDiffuse.value = this.rtScene.texture;
    r.setRenderTarget(this.rtA);
    r.render(this.bright.scene, this.camera);

    // blur half res
    const bu = this.blur.material.uniforms;
    bu.tDiffuse.value = this.rtA.texture;
    bu.uDir.value.set(1 / this.rtA.width, 0);
    r.setRenderTarget(this.rtB);
    r.render(this.blur.scene, this.camera);
    bu.tDiffuse.value = this.rtB.texture;
    bu.uDir.value.set(0, 1 / this.rtA.height);
    r.setRenderTarget(this.rtA);
    r.render(this.blur.scene, this.camera);

    // blur quarter res for the wide halo
    bu.tDiffuse.value = this.rtA.texture;
    bu.uDir.value.set(1 / this.rtC.width, 0);
    r.setRenderTarget(this.rtD);
    r.render(this.blur.scene, this.camera);
    bu.tDiffuse.value = this.rtD.texture;
    bu.uDir.value.set(0, 1 / this.rtC.height);
    r.setRenderTarget(this.rtC);
    r.render(this.blur.scene, this.camera);

    this.u.tDiffuse.value = this.rtScene.texture;
    this.u.tBloom.value = this.rtA.texture;
    this.u.tBloom2.value = this.rtC.texture;
    r.setRenderTarget(null);
    r.render(this.composite.scene, this.camera);

    r.toneMapping = prevTone;
  }

  dispose() {
    for (const rt of [this.rtScene, this.rtA, this.rtB, this.rtC, this.rtD]) rt.dispose();
  }
}
