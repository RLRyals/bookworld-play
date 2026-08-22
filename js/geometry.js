// BookWorld — geometry-as-data engine.
//
// Renders any conformant pack's `geometry` block (materials + elements + lights) with
// zero location-specific code. The vocabulary is deliberately small: `box` (a collidable
// mass by default), `plane` (ground), `emissiveQuad` (a glowing/lit plane — signage,
// light pools, streaks, shopfront glass). Every element takes an optional `id`, which is
// how triggers anchor to geometry (see walk.js `resolveTriggerPosition`) instead of a
// bare coordinate.
//
// Collision is derived automatically: every `box` element is a collider unless the pack
// sets `collider: false` (used for thin/overhead set dressing — sidewalks, curbs, awnings,
// fire escapes). `plane` and `emissiveQuad` are never colliders in this slice.
//
// What stays engine, not data (per the spec's vanilla/pack boundary): the procedural
// texture generators (facade windows, neon glyphs, wet streaks, shopfront glass), the
// fog/sky grading pipeline, and the one-shot cube-camera reflection capture used by
// `reflective` materials. A material's `kind` selects one of these engine capabilities;
// the pack only supplies the parameters (colors, text, litChance, opacity).
//
// STYLE-PACK LAYER (slice 5a, specs/2026-08-08-style-pack-layer.md): four OPTIONAL
// blocks let a pack restyle this same engine into a different-looking world with zero
// engine edits. All four default to exactly today's behaviour, so a pack that declares
// none of them (world-a, deliberately) renders byte-identically to before:
//   * material `texture` + `tileScale` — a procedural generator name or a pack-local
//     image path, tiled in world units (js/textures.js)
//   * `atmosphere` — fog / bloom / colour-grade / ambient+key light, read by the post
//     and lighting rigs instead of the hardcoded noir night rig
//   * `sky` — gradient or equirect skybox image from the pack folder
//   * `props` — glTF models placed by the pack, with AABB collision
import * as THREE from 'three';
import { GLTFLoader } from './lib/GLTFLoader.js';
import { resolveTexture, applyWorldUVs, isSharedTexture } from './textures.js';

// ---------- deterministic RNG so screenshots are reproducible across runs ----------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- procedural textures (no external assets) — engine capabilities ----------
function radialGlowTexture(size = 128, hardness = 0.0) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, size * hardness, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.42)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function streakTexture(w = 64, h = 256) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  for (let y = 0; y < h; y++) {
    const t = y / h;
    const fade = Math.pow(1 - t, 1.7);
    const spread = 0.10 + t * 0.42;
    const grd = g.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(Math.max(0.001, 0.5 - spread), 'rgba(255,255,255,0)');
    grd.addColorStop(0.5, `rgba(255,255,255,${(fade * 0.95).toFixed(3)})`);
    grd.addColorStop(Math.min(0.999, 0.5 + spread), 'rgba(255,255,255,0)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, y, w, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function facadeTextures(rand, wMeters, hMeters, opts) {
  const px = 8;
  const W = Math.max(64, Math.round(wMeters * px));
  const H = Math.max(64, Math.round(hMeters * px));
  const dc = document.createElement('canvas'); dc.width = W; dc.height = H;
  const ec = document.createElement('canvas'); ec.width = W; ec.height = H;
  const d = dc.getContext('2d'), e = ec.getContext('2d');

  d.fillStyle = opts.base; d.fillRect(0, 0, W, H);
  e.fillStyle = '#000'; e.fillRect(0, 0, W, H);

  for (let i = 0; i < 260; i++) {
    const x = rand() * W, y = rand() * H, r = 6 + rand() * 40;
    d.fillStyle = `rgba(0,0,0,${(0.02 + rand() * 0.05).toFixed(3)})`;
    d.beginPath(); d.arc(x, y, r, 0, Math.PI * 2); d.fill();
  }

  const cellW = 2.05 * px, cellH = 2.45 * px;
  const cols = Math.max(1, Math.floor((W - 1.2 * px) / cellW));
  const rows = Math.max(1, Math.floor((H - 2.6 * px) / cellH));
  const ox = (W - cols * cellW) / 2;
  const oy = H - 2.2 * px - rows * cellH;
  const wW = cellW * 0.5, wH = cellH * 0.52;
  for (let r = 0; r < rows; r++) {
    for (let c2 = 0; c2 < cols; c2++) {
      const x = ox + c2 * cellW + (cellW - wW) / 2;
      const y = oy + r * cellH + (cellH - wH) / 2;
      d.fillStyle = 'rgba(0,0,0,0.55)';
      d.fillRect(x, y, wW, wH);
      d.strokeStyle = 'rgba(255,255,255,0.05)';
      d.lineWidth = 1;
      d.strokeRect(x + 0.5, y + 0.5, wW - 1, wH - 1);
      const roll = rand();
      if (roll < opts.litChance) {
        const warm = rand() < 0.22;
        const col = warm ? opts.accentLit : opts.primaryLit;
        const a = 0.35 + rand() * 0.65;
        e.fillStyle = col;
        e.globalAlpha = a;
        e.fillRect(x, y, wW, wH);
        if (rand() < 0.4) {
          e.globalAlpha = a * 0.9;
          e.fillStyle = '#000';
          e.fillRect(x, y, wW, wH * (0.15 + rand() * 0.5));
        }
        e.globalAlpha = 1;
      }
    }
  }
  d.fillStyle = 'rgba(0,0,0,0.45)';
  d.fillRect(0, H - 2.2 * px, W, 2.2 * px);

  const dt = new THREE.CanvasTexture(dc);
  const et = new THREE.CanvasTexture(ec);
  dt.colorSpace = THREE.SRGBColorSpace;
  et.colorSpace = THREE.SRGBColorSpace;
  dt.anisotropy = et.anisotropy = 4;
  return { map: dt, emissiveMap: et };
}

function shopfrontTexture(colorHex, widthMeters) {
  const W = Math.max(128, Math.round(widthMeters * 48)), H = 256;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(10,14,16,1)';
  g.fillRect(0, 0, W, H);
  const panes = Math.max(2, Math.round(widthMeters / 1.5));
  const pw = (W - 14) / panes;
  for (let i = 0; i < panes; i++) {
    const x = 7 + i * pw + 3, y = 22, w = pw - 6, h = H - 52;
    const grd = g.createLinearGradient(0, y, 0, y + h);
    grd.addColorStop(0, colorHex);
    grd.addColorStop(0.55, colorHex);
    grd.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalAlpha = 0.30;
    g.fillStyle = grd;
    g.fillRect(x, y, w, h);
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(4,7,8,0.85)';
    g.fillRect(x + w * 0.2, y + h * 0.55, w * 0.28, h * 0.45);
    g.fillRect(x + w * 0.62, y + h * 0.7, w * 0.2, h * 0.3);
    g.strokeStyle = 'rgba(6,9,11,1)';
    g.lineWidth = 5;
    g.strokeRect(x, y, w, h);
  }
  g.fillStyle = colorHex;
  g.globalAlpha = 0.5;
  g.fillRect(6, H - 34, W - 12, 5);
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function neonSignTexture(text, colorHex, opts = {}) {
  const px = 44;
  const W = 512, H = opts.vertical ? 512 : 160;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  g.translate(W / 2, H / 2);
  g.font = `700 ${px}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = colorHex;
  g.shadowBlur = 26;
  g.fillStyle = colorHex;
  if (opts.vertical) {
    const chars = text.split('');
    const step = Math.min(px * 1.5, (H - 40) / chars.length);
    chars.forEach((ch, i) => {
      g.fillText(ch, 0, (i - (chars.length - 1) / 2) * step);
    });
  } else {
    g.fillText(text, 0, 0);
    g.strokeStyle = colorHex;
    g.lineWidth = 4;
    g.shadowBlur = 18;
    g.strokeRect(-W / 2 + 16, -H / 2 + 16, W - 32, H - 32);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------- material resolution ----------
function resolveColor(def, palette) {
  if (def.color) return new THREE.Color(def.color);
  const srcKey = def.colorFrom || def.tintFrom;
  const base = (srcKey && palette[srcKey] ? palette[srcKey] : new THREE.Color('#ffffff')).clone();
  if (def.tintMix) return base.lerp(new THREE.Color(def.tintToward || '#ffffff'), def.tintMix);
  return base;
}

// A textured material's `color` describes the SURFACE (it becomes the procedural
// generator's base colour, or is simply the fallback while an image loads); the optional
// `tint` is the multiplier applied on top. Without `tint` a textured material multiplies
// by white, so what you see is what the generator drew — otherwise every pack would have
// to remember to null out `color` and the double-darkening would look like a bug.
function applyTexture(mat, def, ctx) {
  if (!def.texture) return mat;
  if (!('map' in mat)) return mat;
  const opts = Object.assign(
    { base: def.color || '#8a8a8a', seed: def.textureSeed == null ? ctx.textureSeed : def.textureSeed },
    def.textureOptions || {}
  );
  mat.map = resolveTexture(def.texture, opts, ctx.base, ctx.warn);
  if (mat.color) mat.color.set(def.tint || '#ffffff');
  mat.needsUpdate = true;
  return mat;
}

function buildMaterial(def, sizeHint, ctx) {
  return applyTexture(buildMaterialInner(def, sizeHint, ctx), def, ctx);
}

function buildMaterialInner(def, sizeHint, ctx) {
  const kind = def.kind || 'flat';
  switch (kind) {
    case 'flat': {
      const params = {
        color: def.color || '#808080',
        roughness: def.roughness == null ? 0.8 : def.roughness,
        metalness: def.metalness == null ? 0.1 : def.metalness,
        // Blockout packs routinely butt geometry flush against itself — a countertop
        // overhang resting exactly on its cabinet's top face, walls overlapping a few cm
        // at a corner seam (BookWorld-zsx FINDINGS: ch1-apartment's counter-north/
        // countertop-north share the identical y=0.92 plane). Those coincident faces
        // z-fight under WebGL's finite depth-buffer precision — a flickering seam that
        // reads as "the level glitches a bit". Polygon offset is the standard, near-free
        // GPU-side fix; applied to every flat (blockout) material rather than editing
        // pack geometry the engine may not own (a story repo's world.json is read-only).
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1
      };
      if (def.emissive) { params.emissive = new THREE.Color(def.emissive); params.emissiveIntensity = def.emissiveIntensity == null ? 1 : def.emissiveIntensity; }
      const mat = new THREE.MeshStandardMaterial(params);
      if (def.reflective) ctx.reflectiveMaterials.push({ material: mat, envMapIntensity: def.envMapIntensity == null ? 1 : def.envMapIntensity });
      return mat;
    }
    case 'facade': {
      const white = new THREE.Color('#ffffff');
      const tex = facadeTextures(ctx.rand, sizeHint[0], sizeHint[1], {
        base: def.base,
        primaryLit: '#' + ctx.palette.primary.clone().lerp(white, 0.25).getHexString(),
        accentLit: '#' + ctx.palette.accent.clone().lerp(white, 0.2).getHexString(),
        litChance: def.litChance
      });
      return new THREE.MeshStandardMaterial({
        map: tex.map, emissiveMap: tex.emissiveMap, emissive: 0xffffff,
        emissiveIntensity: 0.85, roughness: 0.9, metalness: 0.02
      });
    }
    case 'glow': {
      const color = resolveColor(def, ctx.palette);
      return new THREE.MeshBasicMaterial({
        map: ctx.glowTex, color, transparent: true, opacity: def.opacity == null ? 1 : def.opacity,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
    }
    case 'streak': {
      const color = resolveColor(def, ctx.palette);
      return new THREE.MeshBasicMaterial({
        map: ctx.streakTex, color, transparent: true, opacity: def.opacity == null ? 0.5 : def.opacity,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
    }
    case 'neonSign': {
      const color = resolveColor(def, ctx.palette);
      const tex = neonSignTexture(def.text, '#' + color.getHexString(), { vertical: !!def.vertical });
      return new THREE.MeshBasicMaterial({
        map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: 0xffffff
      });
    }
    case 'shopfront': {
      const color = resolveColor(def, ctx.palette);
      const tex = shopfrontTexture('#' + color.getHexString(), sizeHint[0]);
      return new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
    }
    case 'tint': {
      const color = resolveColor(def, ctx.palette);
      return new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    }
    case 'puddle': {
      const mat = new THREE.MeshStandardMaterial({
        color: def.color || '#000000', roughness: def.roughness == null ? 0.04 : def.roughness,
        metalness: def.metalness == null ? 1 : def.metalness,
        transparent: true, alphaMap: ctx.glowTex, opacity: 1.0, depthWrite: false
      });
      ctx.reflectiveMaterials.push({ material: mat, envMapIntensity: def.envMapIntensity == null ? 1 : def.envMapIntensity });
      return mat;
    }
    default:
      return new THREE.MeshStandardMaterial({ color: def.color || '#ff00ff' });
  }
}

// ---------- lights ----------
function buildLight(def, ctx) {
  const type = def.type || 'point';
  let light;
  if (type === 'point') {
    const color = resolveColor(def, ctx.palette);
    light = new THREE.PointLight(color.getHex(), def.intensity == null ? 100 : def.intensity, def.distance || 20, def.decay == null ? 2.0 : def.decay);
    light.position.set(def.position[0], def.position[1], def.position[2]);
  } else if (type === 'directional') {
    const color = resolveColor(def, ctx.palette);
    light = new THREE.DirectionalLight(color.getHex(), def.intensity == null ? 1 : def.intensity);
    light.position.set(def.position[0], def.position[1], def.position[2]);
  } else if (type === 'hemisphere') {
    light = new THREE.HemisphereLight(new THREE.Color(def.skyColor).getHex(), new THREE.Color(def.groundColor).getHex(), def.intensity == null ? 1 : def.intensity);
  } else if (type === 'ambient') {
    light = new THREE.AmbientLight(new THREE.Color(def.color).getHex(), def.intensity == null ? 1 : def.intensity);
  } else {
    throw new Error(`Unknown light type "${type}" (id ${def.id})`);
  }
  return light;
}

// ---------- atmosphere: the shader-pack analogue ----------
// Everything here has a default equal to the noir night rig this engine shipped with,
// so `atmosphere` being absent is not a special case — it just means every value is a
// default. `resolveAtmosphere` returns the merged block; the post stack (js/post.js)
// reads `bloom` + `grade`, this module reads `fog` + `ambient` + `key`.
function resolveAtmosphere(world) {
  const a = world.atmosphere || {};
  const pal = world.palette || {};
  const fogColor = new THREE.Color(pal.fogColor || '#050b0d');
  // legacy fog derivation: the noir rig lifts the pack's fogColor toward a teal haze so
  // gray masses silhouette instead of vanishing into black. A pack that states an
  // atmosphere fog colour means it literally — no lift.
  const legacyHaze = fogColor.clone().lerp(new THREE.Color(0x1d4a4a), 0.72);
  const fog = a.fog || {};
  return {
    fog: {
      color: fog.color ? new THREE.Color(fog.color) : legacyHaze,
      density: fog.density != null ? fog.density : (pal.fogDensity != null ? pal.fogDensity : 0.021)
    },
    // horizon colour used by the default gradient sky when the pack states no `sky`
    baseFogColor: fogColor,
    ambient: a.ambient || null,
    key: a.key || null,
    bloom: a.bloom || null,
    grade: a.grade || null
  };
}

// perceptual (sRGB byte-space) mix — see the note in buildSky's gradient branch
function mixSrgb(a, b, t) {
  const ha = parseInt(a.getHexString(), 16), hb = parseInt(b.getHexString(), 16);
  const ch = (shift) => Math.round((((ha >> shift) & 255) * (1 - t)) + (((hb >> shift) & 255) * t));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

function buildSky(scene, world, atmo, base, warn) {
  const sky = world.sky || {};
  if (sky.type === 'skybox' && sky.src) {
    const t = new THREE.TextureLoader().load(
      base + sky.src,
      (tex) => { tex.mapping = THREE.EquirectangularReflectionMapping; scene.background = tex; },
      undefined,
      () => { if (warn) warn(`sky image failed to load: ${base + sky.src}`); }
    );
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.colorSpace = THREE.SRGBColorSpace;
    scene.background = t;
    return;
  }

  const c = document.createElement('canvas');
  c.width = 8; c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 256);
  if (sky.type === 'gradient') {
    // pack-stated sky: top -> horizon, plus an optional below-horizon ground band
    const top = new THREE.Color(sky.top || '#1a2a3a');
    const horizon = new THREE.Color(sky.horizon || '#c9a06a');
    const ground = new THREE.Color(sky.ground || '#' + horizon.clone().multiplyScalar(0.45).getHexString());
    // Two things bite here and both were caught by looking at rendered frames:
    // (1) eye level is v = 0.5 in an equirect map and a 70-degree vertical FOV only sees
    //     ~35 degrees above it, so the `top` colour has to be reached FAR below the
    //     zenith or a "deep blue sky" renders as a flat band of horizon colour;
    // (2) THREE.Color.lerp mixes in LINEAR space, where a bright horizon colour swamps a
    //     dark zenith at tiny mix values (12% of a bright orange already reads as red at
    //     the top of the frame). Sky stops therefore mix in sRGB byte space, which is
    //     also how the canvas gradient interpolates between them.
    const h = sky.horizonAt == null ? 0.5 : sky.horizonAt;
    grd.addColorStop(0.0, '#' + top.getHexString());
    grd.addColorStop(Math.max(0.01, h - 0.16), mixSrgb(top, horizon, 0.15));
    grd.addColorStop(Math.max(0.02, h - 0.06), mixSrgb(top, horizon, 0.55));
    grd.addColorStop(h, '#' + horizon.getHexString());
    grd.addColorStop(Math.min(0.999, h + 0.02), mixSrgb(horizon, ground, 0.5));
    grd.addColorStop(1.0, '#' + ground.getHexString());
  } else {
    // default (styleless packs): exactly the original noir gradient, derived from fog
    const fogColor = atmo.baseFogColor;
    const haze = fogColor.clone().lerp(new THREE.Color(0x1d4a4a), 0.72);
    const zenith = fogColor.clone().multiplyScalar(0.5);
    grd.addColorStop(0.0, '#' + zenith.getHexString());
    grd.addColorStop(0.55, '#' + fogColor.clone().lerp(haze, 0.5).getHexString());
    grd.addColorStop(0.72, '#' + haze.getHexString());
    grd.addColorStop(1.0, '#' + haze.clone().multiplyScalar(0.7).getHexString());
  }
  g.fillStyle = grd;
  g.fillRect(0, 0, 8, 256);
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  scene.background = t;
}

// ---------- the pack ----------
export function buildWorld(scene, world, reduceMotion, options) {
  const opts = options || {};
  const base = opts.base || '';
  const warn = opts.warn || ((m) => console.warn('[bookworld] ' + m));
  // performance tier settings (specs/2026-08-08-world-links-and-perf.md). Defaults are
  // the full rig, so a caller that passes nothing gets exactly the pre-tier behaviour.
  const quality = Object.assign({ reflections: true, cubeSize: 128, fog: 'exp2' }, opts.quality || {});
  const geo = world.geometry || { materials: {}, elements: [], lights: [] };
  const palette = {
    primary: new THREE.Color(world.palette && world.palette.primary || '#2fe6a4'),
    accent: new THREE.Color(world.palette && world.palette.accent || '#ff2f6d')
  };
  const rand = mulberry32(geo.seed == null ? 20260806 : geo.seed);

  const atmosphere = resolveAtmosphere(world);

  // ----- fog, tier-switchable -----
  // The pack always states exponential fog; the LOW tier swaps the same colour/visibility
  // onto three.js's linear `Fog` ("simple fog" in the spec), which is one fewer exp() per
  // fragment. `setFog` is what walk.js drives for the underwater tint, so it has to be
  // cheap (mutate in place) and mode-agnostic.
  const fogState = { color: atmosphere.fog.color.clone(), density: atmosphere.fog.density };
  let fogMode = quality.fog === 'linear' ? 'linear' : 'exp2';
  function linearFar(density) { return Math.max(8, 3 / Math.max(density, 1e-4)); }
  function buildFog() {
    scene.fog = fogMode === 'linear'
      ? new THREE.Fog(fogState.color.getHex(), 1, linearFar(fogState.density))
      : new THREE.FogExp2(fogState.color.getHex(), fogState.density);
  }
  function setFog(color, density) {
    fogState.color.set(color);
    fogState.density = density;
    if (!scene.fog) return;
    scene.fog.color.set(color);
    if (scene.fog.isFogExp2) scene.fog.density = density;
    else scene.fog.far = linearFar(density);
  }
  function setFogMode(mode) {
    const next = mode === 'linear' ? 'linear' : 'exp2';
    if (next === fogMode) return;
    fogMode = next;
    buildFog();
  }
  buildFog();

  buildSky(scene, world, atmosphere, base, warn);

  const colliders = [];
  // Superset of `colliders`: EVERY box element's AABB, including ones the pack marked
  // `collider: false` for thin/overhead set dressing (sidewalks, curbs, awnings — and,
  // as ch1-apartment's grayboxing convention turned out to use it, the ceiling itself).
  // `colliders` alone answers "does this block me sideways"; a pack author reasonably
  // wants "no" for an overhead ceiling slab. But walk.js's capCeiling (BookWorld-zsx:
  // ceiling jump-through fix) needs the OPPOSITE question — "is there a low ceiling
  // above my head" — which must stay true regardless of that horizontal-collision
  // opt-out. Keeping the two lists separate lets a ceiling be "walk under freely,
  // never lets your HEAD through" without the pack declaring anything extra.
  const overheadSolids = [];
  const glowSprites = [];
  const flickers = [];
  const groundMeshes = [];
  const reflectiveMaterials = [];
  const meshesById = Object.create(null);
  const elementsById = Object.create(null);
  const materialCache = new Map();

  const ctx = {
    rand, palette, glowTex: radialGlowTexture(), streakTex: streakTexture(), reflectiveMaterials,
    base, warn, textureSeed: geo.seed == null ? 20260806 : geo.seed
  };

  function getMaterial(matId, sizeHint) {
    if (materialCache.has(matId)) return materialCache.get(matId);
    const def = geo.materials[matId];
    if (!def) throw new Error(`world.json geometry references unknown material "${matId}"`);
    const mat = buildMaterial(def, sizeHint || [1, 1], ctx);
    materialCache.set(matId, mat);
    return mat;
  }

  // minY/maxY let the controller do vertical-aware collision (step-up, jump-clear,
  // ceiling caps) instead of the old XZ-only push-out. Every collider carries a height
  // band even though most existing colliders (buildings, poles) sit on the ground with
  // minY 0 — that's what makes them permanent walls (their band always overlaps the
  // player's body and their top is never within jump/step reach).
  function addCollider(minX, maxX, minZ, maxZ, minY, maxY, label) {
    colliders.push({ minX, maxX, minZ, maxZ, minY, maxY, label });
  }

  const waterVolumes = [];

  // world-units-per-texture-repeat: stated on the material, overridable per element
  // (the same plaster at a different scale on a cottage and on a garden wall)
  function tileScaleOf(el) {
    if (el.tileScale != null) return el.tileScale;
    const def = geo.materials[el.material];
    return def && def.tileScale != null ? def.tileScale : 0;
  }

  for (const el of geo.elements) {
    elementsById[el.id] = el;
    const size = el.size || [1, 1, 1];
    let mesh;

    if (el.type === 'box') {
      const material = getMaterial(el.material, size);
      const boxGeo = new THREE.BoxGeometry(size[0], size[1], size[2]);
      // world-unit tiling is a per-MESH concern (a shared material has to tile correctly
      // on a 1 m crate and a 30 m wall at once), so it rewrites this geometry's UVs
      applyWorldUVs(boxGeo, size, tileScaleOf(el));
      mesh = new THREE.Mesh(boxGeo, material);
      mesh.position.set(el.position[0], el.position[1], el.position[2]);
      mesh.rotation.y = el.yaw || 0;
      scene.add(mesh);
      {
        const hw = size[0] / 2, hd = size[2] / 2, hh = size[1] / 2;
        const band = {
          minX: el.position[0] - hw, maxX: el.position[0] + hw,
          minZ: el.position[2] - hd, maxZ: el.position[2] + hd,
          minY: el.position[1] - hh, maxY: el.position[1] + hh,
          label: el.id
        };
        overheadSolids.push(band);
        if (el.collider !== false) colliders.push(band);
      }
    } else if (el.type === 'plane' || el.type === 'emissiveQuad') {
      const material = getMaterial(el.material, size);
      const planeGeo = new THREE.PlaneGeometry(size[0], size[1]);
      applyWorldUVs(planeGeo, [size[0], size[1], size[0]], tileScaleOf(el));
      mesh = new THREE.Mesh(planeGeo, material);
      mesh.position.set(el.position[0], el.position[1], el.position[2]);
      if (el.orientation === 'horizontal') {
        mesh.rotation.set(-Math.PI / 2, 0, el.yaw || 0);
      } else {
        mesh.rotation.y = el.yaw || 0;
      }
      scene.add(mesh);
      if (el.collider === true) {
        const hw = size[0] / 2, hd = size[1] / 2, hh = size[1] / 2;
        addCollider(
          el.position[0] - hw, el.position[0] + hw,
          el.position[2] - hd, el.position[2] + hd,
          el.position[1] - hh, el.position[1] + hh,
          el.id
        );
      }
      const matDef = geo.materials[el.material];
      if (matDef && matDef.kind === 'glow' && el.orientation === 'vertical') glowSprites.push(mesh);
      if (el.ground) groundMeshes.push(mesh);
    } else if (el.type === 'water') {
      // A water volume is data only: XZ bounds + a surface level + an optional floor
      // level, tint and fog density. The controller (walk.js) owns swim-mode physics;
      // this just renders a translucent surface (and a dim floor plane, if the volume
      // is deeper than the surrounding ground) so the pit reads as water, not a void.
      const b = el.bounds;
      const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
      const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      const tint = el.tint || '#123241';
      const surfaceMat = new THREE.MeshPhysicalMaterial({
        color: tint, transparent: true, opacity: 0.72, roughness: 0.15, metalness: 0,
        transmission: 0.35, side: THREE.DoubleSide, depthWrite: false
      });
      mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), surfaceMat);
      mesh.position.set(cx, el.surfaceY, cz);
      mesh.rotation.set(-Math.PI / 2, 0, 0);
      scene.add(mesh);
      if (el.floorY != null && el.floorY < el.surfaceY) {
        const floorMat = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.95, metalness: 0.02 });
        const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), floorMat);
        floorMesh.position.set(cx, el.floorY, cz);
        floorMesh.rotation.set(-Math.PI / 2, 0, 0);
        scene.add(floorMesh);
        groundMeshes.push(floorMesh);
      }
      waterVolumes.push({
        id: el.id,
        minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ,
        surfaceY: el.surfaceY,
        floorY: el.floorY == null ? el.surfaceY - 1 : el.floorY,
        tint,
        fogDensity: el.fogDensity == null ? 0.08 : el.fogDensity
      });
    } else {
      throw new Error(`Unknown geometry element type "${el.type}" (id ${el.id})`);
    }
    meshesById[el.id] = mesh;
  }

  for (const l of geo.lights || []) {
    const light = buildLight(l, ctx);
    scene.add(light);
    if (l.flicker) {
      flickers.push({
        light, base: l.intensity == null ? 100 : l.intensity,
        speed: l.flicker.speed, depth: l.flicker.depth,
        mesh: l.linkedElementId ? meshesById[l.linkedElementId] : null
      });
    }
  }

  // ----- atmosphere's own ambient + key light -----
  // A pack can keep declaring these in `geometry.lights` (world-a does); stating them in
  // `atmosphere` instead puts the whole "what time of day is this" decision in one block.
  if (atmosphere.ambient) {
    const a = atmosphere.ambient;
    scene.add(new THREE.AmbientLight(new THREE.Color(a.color || '#ffffff').getHex(), a.intensity == null ? 0.4 : a.intensity));
  }
  if (atmosphere.key) {
    const k = atmosphere.key;
    const light = new THREE.DirectionalLight(new THREE.Color(k.color || '#ffffff').getHex(), k.intensity == null ? 1 : k.intensity);
    const dir = k.direction || [10, 20, 10];
    light.position.set(dir[0], dir[1], dir[2]);
    scene.add(light);
    if (k.skyColor || k.groundColor) {
      scene.add(new THREE.HemisphereLight(
        new THREE.Color(k.skyColor || '#ffffff').getHex(),
        new THREE.Color(k.groundColor || '#000000').getHex(),
        k.hemisphereIntensity == null ? 0.8 : k.hemisphereIntensity
      ));
    }
  }

  // ----- props: glTF models placed by the pack -----
  // Loading is async and deliberately non-blocking: the world is walkable before the
  // models land, each prop appends its own AABB to the live `colliders` array when it
  // arrives, and a prop that fails to load is a console warning, not a dead world.
  const props = [];
  const propDefs = world.props || [];
  let propsPending = propDefs.length;
  const propsReady = new Promise((resolve) => {
    if (!propDefs.length) { resolve([]); return; }
    const loader = new GLTFLoader();
    for (const def of propDefs) {
      loader.load(
        base + def.src,
        (gltf) => {
          // a link can tear this world down while its props are still in flight; the
          // late callback must not resurrect geometry into a disposed scene
          if (disposed) { if (--propsPending === 0) resolve(props); return; }
          const root = gltf.scene;
          const scale = def.scale == null ? 1 : def.scale;
          root.scale.setScalar(scale);
          root.rotation.y = def.yaw || 0;
          root.updateMatrixWorld(true);

          // "stands correctly": by default the model's own bounding box is dropped so its
          // FEET sit on position[1], because an exported model's origin is wherever the
          // artist left it (this slice's test asset is origin-centred, so a naive placement
          // buries half the model in the ground). `align: "origin"` opts out.
          const box = new THREE.Box3().setFromObject(root);
          const pos = def.position || [0, 0, 0];
          const yOffset = def.align === 'origin' ? 0 : -box.min.y;
          root.position.set(pos[0], pos[1] + yOffset, pos[2]);
          root.updateMatrixWorld(true);

          const world_ = new THREE.Box3().setFromObject(root);
          scene.add(root);

          const rec = { id: def.id, object: root, box: world_ };
          props.push(rec);
          if (def.collider !== false) {
            const pad = def.colliderPadding == null ? 0 : def.colliderPadding;
            addCollider(
              world_.min.x - pad, world_.max.x + pad,
              world_.min.z - pad, world_.max.z + pad,
              world_.min.y, world_.max.y,
              def.id || 'prop'
            );
          }
          if (--propsPending === 0) resolve(props);
        },
        undefined,
        (err) => {
          warn(`prop failed to load: ${base + def.src} (${err && err.message ? err.message : err})`);
          if (--propsPending === 0) resolve(props);
        }
      );
    }
  });

  // ----- reflection env for reflective materials (one capture, at init) -----
  // Tier-aware: HIGH captures at 128, MEDIUM at 64 ("cheaper reflections" — a quarter of
  // the texels through the same six render passes), LOW captures nothing at all and the
  // reflective materials fall back to their own colour/roughness. The toggle can turn
  // them back on mid-session, which is why the capture is lazy rather than done here.
  const capturePos = (geo.envCapture && geo.envCapture.position) || [0, 2, 0];
  let cubeRT = null;
  let cubeCam = null;
  let capturedEnv = false;
  let reflections = quality.reflections !== false && reflectiveMaterials.length > 0;
  let cubeSize = quality.cubeSize || 128;

  function attachEnv() {
    if (!cubeRT) {
      cubeRT = new THREE.WebGLCubeRenderTarget(cubeSize, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
      cubeCam = new THREE.CubeCamera(0.4, 90, cubeRT);
      cubeCam.position.set(capturePos[0], capturePos[1], capturePos[2]);
      scene.add(cubeCam);
      capturedEnv = false;
    }
    for (const r of reflectiveMaterials) {
      r.material.envMap = cubeRT.texture;
      r.material.envMapIntensity = r.envMapIntensity;
      r.material.needsUpdate = true;
    }
  }
  function detachEnv() {
    for (const r of reflectiveMaterials) {
      r.material.envMap = null;
      r.material.needsUpdate = true;
    }
  }
  if (reflections) attachEnv();

  function setReflections(on) {
    const want = !!on && reflectiveMaterials.length > 0;
    if (want === reflections) return;
    reflections = want;
    if (want) attachEnv(); else detachEnv();
  }

  const bounds = world.bounds || { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };

  let disposed = false;
  function update(t, camera, renderer) {
    if (disposed) return;
    if (reflections && !capturedEnv && renderer) {
      for (const m of groundMeshes) m.visible = false;
      cubeCam.update(renderer, scene);
      for (const m of groundMeshes) m.visible = true;
      capturedEnv = true;
    }
    for (const g of glowSprites) {
      if (camera) g.quaternion.copy(camera.quaternion);
    }
    if (!reduceMotion) {
      for (const f of flickers) {
        const n = Math.sin(t * f.speed) * 0.5 + Math.sin(t * f.speed * 2.7 + 1.3) * 0.3 + Math.sin(t * f.speed * 6.1) * 0.2;
        const k = 1 + n * f.depth;
        f.light.intensity = f.base * k;
        if (f.mesh && f.mesh.material) f.mesh.material.opacity = Math.min(1, 0.8 + n * 0.2);
      }
    }
  }

  // ----- teardown (world links: one scene = one load, so leaving frees it) -----
  // Only what THIS build owns is released. Textures handed out by textures.js are shared
  // page-wide and cached on purpose (walking back through a door must not re-upload the
  // whole pack), so `isSharedTexture` guards them; canvas textures generated inside this
  // module — facade, neon, shopfront, glow, streak, sky — belong to the build and go.
  function disposeTexture(tex) {
    if (tex && tex.isTexture && !isSharedTexture(tex)) tex.dispose();
  }
  function disposeMaterial(mat) {
    if (!mat) return;
    if (Array.isArray(mat)) { mat.forEach(disposeMaterial); return; }
    for (const key of ['map', 'emissiveMap', 'alphaMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'lightMap', 'bumpMap', 'specularMap']) {
      disposeTexture(mat[key]);
    }
    mat.dispose();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    scene.traverse((obj) => {
      if (obj.isMesh || obj.isPoints || obj.isLine) {
        if (obj.geometry) obj.geometry.dispose();
        disposeMaterial(obj.material);
      }
    });
    while (scene.children.length) scene.remove(scene.children[0]);
    if (cubeRT) { cubeRT.dispose(); cubeRT = null; cubeCam = null; }
    disposeTexture(scene.background);
    scene.background = null;
    scene.environment = null;
    scene.fog = null;
  }

  return {
    colliders, overheadSolids, bounds, update, elementsById, meshesById, waterVolumes,
    atmosphere, props, propsReady,
    setFog, setFogMode, setReflections, dispose,
    get reflectionsOn() { return reflections; },
    get fogMode() { return fogMode; },
    get disposed() { return disposed; },
    get propsPending() { return propsPending; }
  };
}
