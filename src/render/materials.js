// Shared lit materials for everything that is not terrain: the suit, the wing
// fabric, trees, rocks, props and the canopy. They all use the same sun,
// ambient and aerial-perspective terms as the terrain shader so nothing looks
// pasted on.

import * as THREE from 'three';
import { ATMOS_GLSL } from './sky.js';

const VERT = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
#ifdef USE_INSTANCING_EXT
#endif
void main() {
  vColor = color;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  #ifdef USE_INSTANCING
    wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  #else
    vNormal = normalize(mat3(modelMatrix) * normal);
  #endif
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
uniform float uTranslucency;
uniform float uSpecular;
uniform float uShininess;
uniform float uAmbientBoost;
uniform float uEmissive;
uniform float uTwoTone;
uniform vec3 uUnderTint;
${ATMOS_GLSL}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  if (dot(N, V) < 0.0 && uTranslucency > 0.0) N = -N;
  // Two-tone fabric: a bright top surface and a dark underside makes the
  // suit's roll angle readable at a glance from the chase camera.
  vec3 base = vColor;
  if (uTwoTone > 0.5 && !gl_FrontFacing) base *= uUnderTint;

  float ndl = dot(N, uSunDir);
  float diff = max(ndl, 0.0);
  // fabric and foliage let light through from behind
  float back = max(-ndl, 0.0) * uTranslucency;

  vec3 skyAmb = mix(uGroundTint, uZenith, clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
  skyAmb = mix(skyAmb, uHorizon, 0.4);
  vec3 ambient = skyAmb * (1.1 + uAmbientBoost);

  vec3 col = base * (uSunColor * (diff + back * 0.55) + ambient);

  vec3 H = normalize(V + uSunDir);
  col += uSunColor * pow(max(dot(N, H), 0.0), uShininess) * uSpecular;
  col += base * uEmissive;

  col = atmosApply(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function makeLitMaterial(skyUniforms, opts = {}) {
  const uniforms = Object.assign({}, skyUniforms, {
    uTranslucency: { value: opts.translucency ?? 0 },
    uSpecular: { value: opts.specular ?? 0.08 },
    uShininess: { value: opts.shininess ?? 24 },
    uAmbientBoost: { value: opts.ambientBoost ?? 0 },
    uEmissive: { value: opts.emissive ?? 0 },
    uTwoTone: { value: opts.twoTone ? 1 : 0 },
    uUnderTint: { value: new THREE.Vector3(...(opts.underTint || [0.34, 0.36, 0.42])) },
  });
  const m = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    vertexColors: true,
    side: opts.side ?? THREE.FrontSide,
    transparent: !!opts.transparent,
    depthWrite: opts.depthWrite !== false,
  });
  m.userData.uniforms = uniforms;
  return m;
}

/** Unlit additive material for trails, glows, gates and particles. */
export function makeGlowMaterial(opts = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(opts.color ?? 0x8fd4ff) },
      uOpacity: { value: opts.opacity ?? 1 },
    },
    vertexShader: /* glsl */ `
      attribute float alpha;
      varying float vAlpha;
      varying vec3 vCol;
      void main() {
        vAlpha = alpha;
        vCol = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying float vAlpha;
      varying vec3 vCol;
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        gl_FragColor = vec4(uColor * vCol, vAlpha * uOpacity);
      }
    `,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}
