// BookWorld — hand-rolled post stack (bloom + ACES + noir colour grade).
//
// three.js is vendored as the single-file core module (js/three.module.js), which
// does NOT include the addons EffectComposer/UnrealBloomPass live in. Rather than
// vendor more files, the whole stack is three fullscreen shader passes:
//   1. bright-pass  (half res)  -> gaussian blur H/V
//   2. downsample   (quarter)   -> gaussian blur H/V   (the wide, soft halo)
//   3. composite: base + bloom, ACES tonemap, green+accent grade, vignette, grain
//
// `params` is mutable at runtime — the lighting pass tunes it live and the values
// that survived the screenshot-critic loop are the defaults below.
import * as THREE from 'three';

const QUAD_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const BRIGHT_FRAG = `
uniform sampler2D tDiffuse;
uniform float threshold;
uniform float knee;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float w = smoothstep(threshold, threshold + knee, l);
  gl_FragColor = vec4(c * w, 1.0);
}
`;

const BLUR_FRAG = `
uniform sampler2D tDiffuse;
uniform vec2 direction;   // texel-sized step
varying vec2 vUv;
void main() {
  // 9-tap gaussian
  float w0 = 0.2270270270;
  float w1 = 0.1945945946;
  float w2 = 0.1216216216;
  float w3 = 0.0540540541;
  float w4 = 0.0162162162;
  vec3 c = texture2D(tDiffuse, vUv).rgb * w0;
  c += texture2D(tDiffuse, vUv + direction * 1.0).rgb * w1;
  c += texture2D(tDiffuse, vUv - direction * 1.0).rgb * w1;
  c += texture2D(tDiffuse, vUv + direction * 2.0).rgb * w2;
  c += texture2D(tDiffuse, vUv - direction * 2.0).rgb * w2;
  c += texture2D(tDiffuse, vUv + direction * 3.0).rgb * w3;
  c += texture2D(tDiffuse, vUv - direction * 3.0).rgb * w3;
  c += texture2D(tDiffuse, vUv + direction * 4.0).rgb * w4;
  c += texture2D(tDiffuse, vUv - direction * 4.0).rgb * w4;
  gl_FragColor = vec4(c, 1.0);
}
`;

const COMPOSITE_FRAG = `
uniform sampler2D tBase;
uniform sampler2D tBloom1;
uniform sampler2D tBloom2;
uniform float bloom1;
uniform float bloom2;
uniform float exposure;
uniform float contrast;
uniform float saturation;
uniform vec3  shadowTint;
uniform float shadowLift;
uniform vec3  highlightTint;
uniform float highlightAmount;
uniform float vignette;
uniform float grain;
uniform float time;
varying vec2 vUv;

// ACES filmic approximation (Narkowicz)
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec3 col = texture2D(tBase, vUv).rgb;
  col += texture2D(tBloom1, vUv).rgb * bloom1;
  col += texture2D(tBloom2, vUv).rgb * bloom2;

  col *= exposure;
  col = aces(col);

  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));

  // shadows pushed toward deep teal-green; highlights carry the accent
  float sMask = 1.0 - smoothstep(0.0, 0.45, lum);
  col += shadowTint * shadowLift * sMask;
  float hMask = smoothstep(0.55, 1.0, lum);
  col = mix(col, col * highlightTint, hMask * highlightAmount);

  // contrast around mid grey, then saturation
  col = (col - 0.5) * contrast + 0.5;
  lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, saturation);

  // vignette
  vec2 d = vUv - 0.5;
  float v = 1.0 - dot(d, d) * vignette;
  col *= clamp(v, 0.0, 1.0);

  // film grain
  float g = hash(vUv * 1024.0 + time) - 0.5;
  col += g * grain;

  col = clamp(col, 0.0, 1.0);
  // manual linear -> sRGB (renderer.outputColorSpace is set to Linear so three
  // does not convert a second time)
  vec3 srgb = mix(col * 12.92,
                  1.055 * pow(max(col, vec3(0.0031308)), vec3(1.0 / 2.4)) - 0.055,
                  step(vec3(0.0031308), col));
  gl_FragColor = vec4(srgb, 1.0);
}
`;

export function createPost(renderer, scene, camera) {
  const params = {
    threshold: 0.88,
    knee: 0.28,
    bloom1: 0.46,
    bloom2: 0.38,
    exposure: 1.12,
    contrast: 1.14,
    saturation: 1.04,
    shadowTint: new THREE.Color(0x0c3036),
    shadowLift: 0.115,
    highlightTint: new THREE.Color(0xdaffef),
    highlightAmount: 0.35,
    vignette: 1.10,
    grain: 0.035,
    enabled: true
  };

  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  quadGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(quadGeo, null);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);

  const rtOpts = {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false
  };

  let sceneRT = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    samples: 4
  });
  let brightRT = new THREE.WebGLRenderTarget(1, 1, rtOpts);
  let blurRTa = new THREE.WebGLRenderTarget(1, 1, rtOpts);
  let downRT = new THREE.WebGLRenderTarget(1, 1, rtOpts);
  let blurRTb = new THREE.WebGLRenderTarget(1, 1, rtOpts);

  const brightMat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, threshold: { value: params.threshold }, knee: { value: params.knee } },
    vertexShader: QUAD_VERT, fragmentShader: BRIGHT_FRAG, depthTest: false, depthWrite: false
  });
  const blurMat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, direction: { value: new THREE.Vector2() } },
    vertexShader: QUAD_VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false
  });
  const compMat = new THREE.ShaderMaterial({
    uniforms: {
      tBase: { value: null }, tBloom1: { value: null }, tBloom2: { value: null },
      bloom1: { value: params.bloom1 }, bloom2: { value: params.bloom2 },
      exposure: { value: params.exposure }, contrast: { value: params.contrast },
      saturation: { value: params.saturation },
      shadowTint: { value: params.shadowTint.clone() }, shadowLift: { value: params.shadowLift },
      highlightTint: { value: params.highlightTint.clone() }, highlightAmount: { value: params.highlightAmount },
      vignette: { value: params.vignette }, grain: { value: params.grain }, time: { value: 0 }
    },
    vertexShader: QUAD_VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false
  });

  let W = 1, H = 1;
  function setSize(w, h, pixelRatio) {
    W = Math.max(1, Math.floor(w * pixelRatio));
    H = Math.max(1, Math.floor(h * pixelRatio));
    sceneRT.setSize(W, H);
    const hw = Math.max(1, W >> 1), hh = Math.max(1, H >> 1);
    const qw = Math.max(1, W >> 2), qh = Math.max(1, H >> 2);
    brightRT.setSize(hw, hh);
    blurRTa.setSize(hw, hh);
    downRT.setSize(qw, qh);
    blurRTb.setSize(qw, qh);
  }

  function blit(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(quadScene, quadCam);
  }

  function render(time) {
    if (!params.enabled) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }
    renderer.setRenderTarget(sceneRT);
    renderer.clear();
    renderer.render(scene, camera);

    brightMat.uniforms.tDiffuse.value = sceneRT.texture;
    brightMat.uniforms.threshold.value = params.threshold;
    brightMat.uniforms.knee.value = params.knee;
    blit(brightMat, brightRT);

    const hw = Math.max(1, W >> 1), hh = Math.max(1, H >> 1);
    blurMat.uniforms.tDiffuse.value = brightRT.texture;
    blurMat.uniforms.direction.value.set(1 / hw, 0);
    blit(blurMat, blurRTa);
    blurMat.uniforms.tDiffuse.value = blurRTa.texture;
    blurMat.uniforms.direction.value.set(0, 1 / hh);
    blit(blurMat, brightRT); // brightRT now holds bloom level 1

    const qw = Math.max(1, W >> 2), qh = Math.max(1, H >> 2);
    blurMat.uniforms.tDiffuse.value = brightRT.texture;
    blurMat.uniforms.direction.value.set(1.6 / qw, 0);
    blit(blurMat, downRT);
    blurMat.uniforms.tDiffuse.value = downRT.texture;
    blurMat.uniforms.direction.value.set(0, 1.6 / qh);
    blit(blurMat, blurRTb); // blurRTb now holds bloom level 2

    const u = compMat.uniforms;
    u.tBase.value = sceneRT.texture;
    u.tBloom1.value = brightRT.texture;
    u.tBloom2.value = blurRTb.texture;
    u.bloom1.value = params.bloom1;
    u.bloom2.value = params.bloom2;
    u.exposure.value = params.exposure;
    u.contrast.value = params.contrast;
    u.saturation.value = params.saturation;
    u.shadowTint.value.copy(params.shadowTint);
    u.shadowLift.value = params.shadowLift;
    u.highlightTint.value.copy(params.highlightTint);
    u.highlightAmount.value = params.highlightAmount;
    u.vignette.value = params.vignette;
    u.grain.value = params.grain;
    u.time.value = time;

    quad.material = compMat;
    renderer.setRenderTarget(null);
    renderer.render(quadScene, quadCam);
  }

  return { params, setSize, render };
}
