// Sky, sun, moon, stars and the shared aerial-perspective GLSL.
//
// The sky is a single inverted sphere with an analytic gradient driven by sun
// elevation; terrain and features import the same `ATMOS_GLSL` so the fog they
// fade into is exactly the sky behind them. That consistency is most of what
// makes distant ridges read at the right scale.

import * as THREE from 'three';
import { clamp01, lerp, smoothstep } from '../core/math.js';

export const ATMOS_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGroundTint;
uniform float uFogDensity;
uniform float uFogHeight;
uniform float uSunDisc;
uniform float uMoonMix;
uniform vec3 uCamPos;

vec3 atmosSky(vec3 dir) {
  float up = clamp(dir.y, -1.0, 1.0);
  float t = pow(1.0 - clamp(up, 0.0, 1.0), 3.4);
  vec3 col = mix(uZenith, uHorizon, t);
  // below the horizon fades to the ground tint (keeps valleys from glowing)
  col = mix(col, uGroundTint, smoothstep(0.0, -0.22, up));
  float mu = max(dot(dir, uSunDir), 0.0);
  col += uSunColor * pow(mu, 5.0) * 0.30;
  col += uSunColor * pow(mu, 90.0) * 0.55;
  col += uSunColor * pow(mu, 2600.0) * 14.0;   // the disc, for the bloom to find
  return col;
}

vec3 atmosApply(vec3 col, vec3 worldPos) {
  vec3 v = worldPos - uCamPos;
  float dist = length(v);
  vec3 dir = v / max(dist, 1e-4);
  float hc = exp(-max(uCamPos.y - 500.0, 0.0) / uFogHeight);
  float hw = exp(-max(worldPos.y - 500.0, 0.0) / uFogHeight);
  float avg = (hc + hw) * 0.5;
  float f = 1.0 - exp(-dist * uFogDensity * avg);
  vec3 fogCol = atmosSky(dir);
  // in-scattered sunlight warms the haze towards the sun
  float mu = max(dot(dir, uSunDir), 0.0);
  fogCol += uSunColor * pow(mu, 4.0) * 0.16 * f;
  return mix(col, fogCol, clamp(f, 0.0, 1.0));
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // always at the far plane
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform float uStars;
uniform vec3 uMoonDir;
uniform float uMoonBright;
${ATMOS_GLSL}

float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 col = atmosSky(dir);

  // stars: stable cells on the sphere
  if (uStars > 0.001 && dir.y > -0.05) {
    vec2 sp = vec2(atan(dir.z, dir.x) * 2.2, asin(clamp(dir.y,-1.0,1.0)) * 3.4) * 24.0;
    vec2 cell = floor(sp);
    vec2 f = fract(sp) - 0.5;
    float r = hash21(cell);
    if (r > 0.86) {
      vec2 off = vec2(hash21(cell + 7.1), hash21(cell + 3.3)) - 0.5;
      float d = length(f - off * 0.7);
      float mag = (r - 0.86) / 0.14;
      float tw = 0.75 + 0.25 * sin(uStars * 0.0 + r * 100.0);
      col += vec3(0.85, 0.9, 1.0) * smoothstep(0.09, 0.0, d) * mag * mag * 2.2 * uStars * tw;
    }
  }

  // Moon. The brightness has to scale the blend, not the colour it blends
  // to: multiplying the colour meant that in daylight, when uMoonBright is
  // zero, the disc mixed the sky towards pure black and painted a black
  // hole on it wherever the moon happened to be.
  float md = dot(dir, uMoonDir);
  if (md > 0.9985 && uMoonBright > 0.001) {
    float e = smoothstep(0.9985, 0.99935, md) * uMoonBright;
    col = mix(col, vec3(0.92, 0.93, 0.88), e);
  }
  col += vec3(0.5,0.55,0.7) * pow(max(md,0.0), 90.0) * 0.1 * uMoonBright;

  gl_FragColor = vec4(col, 1.0);
}
`;

/** Weather presets blended by the world clock / player choice. */
export const WEATHER = {
  clear: { haze: 1.0, cloudCover: 0.18, cloudHeight: 2650, snow: 0, wind: 4.5, name: 'Clear' },
  cloudy: { haze: 1.5, cloudCover: 0.62, cloudHeight: 2250, snow: 0, wind: 6.5, name: 'Cloud layer' },
  snow: { haze: 2.4, cloudCover: 0.8, cloudHeight: 2050, snow: 0.7, wind: 9, name: 'Snowfall' },
  whiteout: { haze: 5.0, cloudCover: 0.95, cloudHeight: 1500, snow: 1.0, wind: 12.5, name: 'Whiteout' },
};

export class Sky {
  constructor(scene) {
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0.4, 0.5, 0.76) },
      uSunColor: { value: new THREE.Color(1, 0.92, 0.78) },
      uZenith: { value: new THREE.Color(0.18, 0.34, 0.62) },
      uHorizon: { value: new THREE.Color(0.72, 0.78, 0.86) },
      uGroundTint: { value: new THREE.Color(0.28, 0.3, 0.32) },
      uFogDensity: { value: 0.000135 },
      uFogHeight: { value: 920 },
      uSunDisc: { value: 1 },
      uMoonMix: { value: 0 },
      uCamPos: { value: new THREE.Vector3() },
      uStars: { value: 0 },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonBright: { value: 0 },
    };

    const geo = new THREE.SphereGeometry(1, 40, 24);
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    scene.add(this.mesh);

    this.timeOfDay = 7.6; // hours
    this.weather = { ...WEATHER.clear };
    this.sunDir = new THREE.Vector3();
    this.sunColor = new THREE.Color();
    this.ambient = new THREE.Color();
  }

  /** Sets sky colours from the time of day. */
  update(timeOfDay, weather, camPos) {
    this.timeOfDay = timeOfDay;
    if (weather) this.weather = weather;
    const w = this.weather;

    // Sun path: a long alpine summer day, up at 05:30 and down at 20:00,
    // peaking at 12:45. A 06:00-18:00 day crammed the whole of dusk into the
    // half hour after 17:00 and left the evening unplayably black.
    const dayT = (timeOfDay - 5.5) / 14.5; // 0 at sunrise, 1 at sunset
    const elev = Math.sin(Math.PI * clamp01(dayT)) * 1.08 - 0.08;
    const az = Math.PI * (0.18 + dayT * 0.9);
    const ce = Math.cos(elev);
    this.sunDir.set(Math.cos(az) * ce, Math.sin(elev), Math.sin(az) * ce).normalize();

    const night = smoothstep(0.08, -0.06, this.sunDir.y);
    const golden = smoothstep(0.32, 0.03, this.sunDir.y) * (1 - night);
    const day = clamp01(this.sunDir.y * 3.0);

    // direct sun colour: white high, deep amber at the horizon
    const sc = this.sunColor;
    sc.setRGB(
      lerp(1.32, 1.5, golden),
      lerp(1.24, 0.72, golden),
      lerp(1.06, 0.36, golden),
    );
    const sunStrength = clamp01(this.sunDir.y * 4.2 + 0.08) * (1 - night * 0.97);
    sc.multiplyScalar(sunStrength * lerp(1, 0.45, w.cloudCover));

    const zen = this.uniforms.uZenith.value;
    const hor = this.uniforms.uHorizon.value;
    // Night is moonlit, not black: you still have to be able to read a ridge
    // line and judge a clearance at 02:00.
    zen.setRGB(
      lerp(0.034, lerp(0.085, 0.13, golden), day) + night * 0.030,
      lerp(0.046, lerp(0.24, 0.17, golden), day) + night * 0.040,
      lerp(0.098, lerp(0.56, 0.36, golden), day) + night * 0.075,
    );
    hor.setRGB(
      lerp(0.100, lerp(0.74, 1.28, golden), day),
      lerp(0.118, lerp(0.80, 0.49, golden), day),
      lerp(0.175, lerp(0.92, 0.30, golden), day),
    );
    // overcast washes everything towards flat grey
    const grey = w.cloudCover * 0.8;
    const gl = (0.30 + 0.28 * day) * lerp(1, 0.55, night);
    zen.lerp(new THREE.Color(gl * 0.9, gl * 0.94, gl * 1.0), grey);
    hor.lerp(new THREE.Color(gl * 1.08, gl * 1.1, gl * 1.12), grey);

    this.uniforms.uGroundTint.value.setRGB(
      lerp(0.072, 0.22, day), lerp(0.080, 0.235, day), lerp(0.105, 0.24, day),
    );

    this.uniforms.uSunDir.value.copy(this.sunDir);
    this.uniforms.uSunColor.value.copy(sc);
    this.uniforms.uFogDensity.value = 0.000135 * w.haze;
    this.uniforms.uFogHeight.value = 920;
    this.uniforms.uStars.value = night;
    this.uniforms.uMoonBright.value = night;
    this.uniforms.uMoonDir.value.set(-this.sunDir.x, -this.sunDir.y + 0.35, -this.sunDir.z).normalize();
    if (camPos) this.uniforms.uCamPos.value.copy(camPos);

    // ambient (sky light) used by non-terrain materials
    this.ambient.copy(zen).lerp(hor, 0.45).multiplyScalar(1.15);
    // a floor so nothing is ever pitch black
    this.ambient.r = Math.max(this.ambient.r, 0.075);
    this.ambient.g = Math.max(this.ambient.g, 0.085);
    this.ambient.b = Math.max(this.ambient.b, 0.115);
    this.night = night;
    this.golden = golden;
    this.day = day;
  }

  setCam(pos) {
    this.uniforms.uCamPos.value.copy(pos);
    this.mesh.position.copy(pos);
  }

  resize(far) {
    this.mesh.scale.setScalar(Math.max(100, far * 0.5));
  }
}
