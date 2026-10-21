// Terrain shading: procedural rock with strata and cracks, snow accumulation,
// scree, moss, glacier ice and wet rock, lit by a sun whose shadows come from
// raymarching the coarse height texture (kilometre-scale ridge shadows for the
// cost of one loop, where a shadow cascade would struggle at this range).

import * as THREE from 'three';
import { ATMOS_GLSL } from '../render/sky.js';
import { WORLD } from './field.js';

/** Float32 -> IEEE half, for the height texture. */
function toHalf(val) {
  const f = new Float32Array(1);
  const i = new Int32Array(f.buffer);
  f[0] = val;
  const x = i[0];
  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;
  if (e < 103) return bits;
  if (e > 142) {
    bits |= 0x7c00;
    bits |= (e === 255 ? 0 : 1) && x & 0x007fffff;
    return bits;
  }
  if (e < 113) {
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;
  return bits;
}

export function makeHeightTexture(field) {
  const res = field.res;
  const data = new Uint16Array(res * res);
  const inv = 1 / 4096;
  for (let i = 0; i < data.length; i++) data[i] = toHalf(field.eroded[i] * inv);
  const tex = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export const NOISE_GLSL = /* glsl */ `
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.17, 0.13));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float fbm3(vec3 p, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= oct) break;
    s += a * vnoise(p);
    n += a;
    a *= 0.5;
    p *= 2.03;
  }
  return s / n;
}
`;

const VERT = /* glsl */ `
precision highp float;
attribute vec4 surf;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec4 vSurf;
void main() {
  vWorld = position;
  vNormal = normal;
  vSurf = surf;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec4 vSurf;

uniform sampler2D uHeightTex;
uniform float uWorldSize;
uniform float uWorldHalf;
uniform float uTime;
uniform float uSnowLine;
uniform float uTreeLine;
uniform float uLakeLevel;
uniform int uShadowSteps;
uniform int uRockOct;
uniform float uDetailFade;
uniform float uSnowFall;

${ATMOS_GLSL}
${NOISE_GLSL}

float sampleH(vec2 xz) {
  vec2 uv = (xz + uWorldHalf) / uWorldSize;
  return texture2D(uHeightTex, uv).r * 4096.0;
}

// Long soft ridge shadows by marching the coarse height field toward the sun.
// The tolerance grows with march distance (a cheap penumbra) and starts wide
// enough that a vertex's own slope cannot shadow itself: the height texture is
// the 8 m coarse field, so it does not agree with the fine mesh up close.
float sunShadow(vec3 p, float steps) {
  if (uSunDir.y <= 0.015) return 0.0;
  float s = 1.0;
  float t = 26.0;
  for (int i = 0; i < 28; i++) {
    if (float(i) >= steps) break;
    vec3 q = p + uSunDir * t;
    if (abs(q.x) > uWorldHalf || abs(q.z) > uWorldHalf) break;
    float h = sampleH(q.xz);
    float tol = 5.0 + t * 0.026;
    s = min(s, smoothstep(-tol, tol, q.y - h));
    if (s < 0.015) break;
    t *= 1.48;
    if (t > 5000.0) break;
  }
  return s;
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 wp = vWorld;
  float slope = 1.0 - N.y;
  float alt = wp.y;
  float wet = vSurf.x;
  float ao = vSurf.y;
  float glacier = vSurf.z;
  float fade = vSurf.w;

  // Noise budget: the fragment shader is the frame's biggest cost, so the
  // layers share samples and the expensive ones are skipped where they
  // cannot contribute.
  float nBig = fbm3(wp * 0.0092, uRockOct);
  float nMid = fbm3(wp * 0.058, 3);
  float nFine = vnoise(wp * 0.42);
  float region = fbm3(wp * 0.0021 + 53.0, 2);

  // --- rock: strata are a gentle albedo band, not corrugation ---
  //
  // One sine on altitude bands every 114 m, which is fine on ordinary
  // ground where the surface is nowhere near vertical -- and reads as
  // corduroy on a sheer face, where forty of them stack up the screen.
  // Two frequencies and a much wider warp make them wander like bedding
  // planes, and they ease off as the ground stands up.
  float strataWarp = nBig * 125.0 + nMid * 26.0 + fbm3(wp * 0.0031 + 19.0, 2) * 190.0;
  float s1 = sin((wp.y + strataWarp) * 0.055);
  float s2 = sin((wp.y + strataWarp * 0.62) * 0.0205 + 1.7);
  float strata = (s1 * 0.58 + s2 * 0.42) * 0.5 + 0.5;
  strata = smoothstep(0.18, 0.86, strata);
  strata = mix(strata, 0.5, smoothstep(0.60, 0.90, slope) * 0.8);
  vec3 rockDark = vec3(0.126, 0.120, 0.116);
  vec3 rockLite = vec3(0.318, 0.305, 0.288);
  vec3 rockWarm = vec3(0.286, 0.252, 0.219);
  vec3 rockCool = vec3(0.206, 0.215, 0.228);
  vec3 rock = mix(rockDark, rockLite, 0.32 + strata * 0.20 + nMid * 0.46);
  rock = mix(rock, rockWarm, smoothstep(0.42, 0.80, region) * 0.32);
  rock = mix(rock, rockCool, smoothstep(0.44, 0.14, region) * 0.45);
  float crackF = abs(fbm3(wp * 0.145, 2) * 2.0 - 1.0);
  rock *= mix(0.80, 1.0, smoothstep(0.0, 0.11, crackF));
  rock *= 0.88 + 0.24 * nFine;

  // --- scree: loose rubble on moderate slopes, speckled ---
  float screeM = smoothstep(0.14, 0.34, slope) * smoothstep(0.70, 0.40, slope);
  vec3 albedo = rock;
  if (screeM > 0.01) {
    screeM *= smoothstep(0.34, 0.62, region + nMid * 0.2);
    vec3 scree = vec3(0.300, 0.276, 0.244) * (0.78 + 0.5 * vnoise(wp * 1.25));
    albedo = mix(rock, scree, screeM * 0.8);
  }

  // --- moss / alpine grass low down on gentle ground ---
  float green = smoothstep(uTreeLine + 200.0, uTreeLine - 620.0, alt);
  if (green > 0.004) {
    green *= smoothstep(0.44, 0.12, slope);
    green *= smoothstep(0.30, 0.64, region * 0.55 + nBig * 0.45 + 0.08);
    vec3 grass = mix(vec3(0.085, 0.113, 0.052), vec3(0.152, 0.178, 0.079), nMid);
    albedo = mix(albedo, grass, green * 0.92);
  }

  // --- snow: alpine faces hold snow on surprisingly steep ground ---
  // Snow starts lower and holds on steeper ground: these are big alpine
  // faces now, and bare rock from 2.6 km to 4.6 km read as a quarry.
  float snow = smoothstep(uSnowLine - 620.0, uSnowLine + 180.0, alt + nBig * 240.0 - 110.0);
  snow *= smoothstep(0.86, 0.20, slope + nBig * 0.22 + nMid * 0.06 - 0.16);
  snow = clamp(snow * mix(0.80, 1.16, ao) + uSnowFall * smoothstep(0.55, 0.12, slope) * 0.6, 0.0, 1.0);
  snow *= 1.0 - glacier * 0.3;
  vec3 snowCol = vec3(0.80, 0.835, 0.90) * (0.92 + 0.16 * nMid);

  // --- glacier ice ---
  if (glacier > 0.01) {
    vec3 iceCol = vec3(0.62, 0.74, 0.80);
    float crevasse = smoothstep(0.16, 0.0, abs(fbm3(wp * 0.0062 + 11.0, 2) * 2.0 - 1.0) - 0.02);
    iceCol *= mix(1.0, 0.22, crevasse * smoothstep(0.35, 0.8, glacier));
    albedo = mix(albedo, iceCol, glacier * 0.85);
  }
  albedo = mix(albedo, snowCol, snow);

  // --- wet rock near water and in drainage lines ---
  float wetM = wet * smoothstep(0.06, 0.45, slope) * (1.0 - snow);
  albedo *= mix(1.0, 0.56, wetM);

  // --- lighting ---
  // Shadow detail is a per-pixel ray march, and it is the most expensive
  // thing in this shader. Far terrain is a few pixels across and buried in
  // haze, so it gets four steps instead of fourteen; nothing visible
  // changes and most of the screen stops paying for it.
  float camDist = length(wp - uCamPos);
  float shadowSteps = mix(float(uShadowSteps), 4.0, clamp(camDist / 4200.0, 0.0, 1.0));
  float shadow = sunShadow(wp + N * 3.0, shadowSteps);
  // The march reads the 8 m coarse grid, which cannot describe a near
  // vertical face at all: on a wall it returns the texel grid as blocks of
  // shadow. Fade it out as the ground stands up. Jittering the march start
  // hid the blocks but replaced them with per-pixel salt and pepper, which
  // is worse -- it crawls as you move.
  shadow = mix(shadow, 1.0, smoothstep(0.60, 0.88, slope));
  float wrap = mix(0.05, 0.5, snow + glacier * 0.6);
  float diff = max((dot(N, uSunDir) + wrap) / (1.0 + wrap), 0.0);

  vec3 skyAmb = mix(uGroundTint, uZenith, clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
  skyAmb = mix(skyAmb, uHorizon, 0.42);
  vec3 ambient = skyAmb * (0.42 + 0.86 * ao) * 1.26;
  // warm bounce from the sunlit ground below
  ambient += uSunColor * vec3(0.26, 0.22, 0.17) * 0.3 * (1.0 - N.y * 0.45) * ao;

  vec3 col = albedo * (uSunColor * diff * shadow + ambient);

  // specular: wet rock, ice, and a crisp sparkle on snow
  vec3 V = normalize(uCamPos - wp);
  vec3 H = normalize(V + uSunDir);
  float specP = mix(28.0, 180.0, glacier);
  float specK = wetM * 0.5 + glacier * 0.45;
  col += uSunColor * shadow * pow(max(dot(N, H), 0.0), specP) * specK;
  if (snow > 0.05) {
    float sp = pow(vnoise(wp * 9.5), 18.0) * 26.0;
    col += uSunColor * shadow * snow * sp * pow(max(dot(N, H), 0.0), 8.0) * 0.7;
  }

  col = atmosApply(col, wp);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function makeTerrainMaterial(field, skyUniforms, quality = {}) {
  const uniforms = Object.assign({}, skyUniforms, {
    uHeightTex: { value: makeHeightTexture(field) },
    uWorldSize: { value: WORLD.size },
    uWorldHalf: { value: WORLD.half },
    uTime: { value: 0 },
    uSnowLine: { value: WORLD.snowLine },
    uTreeLine: { value: WORLD.treeLine },
    uLakeLevel: { value: WORLD.lakeLevel },
    uShadowSteps: { value: quality.shadowSteps ?? 14 },
    uRockOct: { value: quality.rockOctaves ?? 4 },
    uDetailFade: { value: 1 },
    uSnowFall: { value: 0 },
  });

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.FrontSide,
  });
  mat.userData.uniforms = uniforms;
  return mat;
}
