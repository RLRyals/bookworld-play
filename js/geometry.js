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
import * as THREE from 'three';

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

function buildMaterial(def, sizeHint, ctx) {
  const kind = def.kind || 'flat';
  switch (kind) {
    case 'flat': {
      const params = {
        color: def.color || '#808080',
        roughness: def.roughness == null ? 0.8 : def.roughness,
        metalness: def.metalness == null ? 0.1 : def.metalness
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

// ---------- the pack ----------
export function buildWorld(scene, world, reduceMotion) {
  const geo = world.geometry || { materials: {}, elements: [], lights: [] };
  const palette = {
    primary: new THREE.Color(world.palette && world.palette.primary || '#2fe6a4'),
    accent: new THREE.Color(world.palette && world.palette.accent || '#ff2f6d')
  };
  const fogColor = new THREE.Color(world.palette && world.palette.fogColor || '#050b0d');
  const fogDensity = world.palette && world.palette.fogDensity != null ? world.palette.fogDensity : 0.021;
  const rand = mulberry32(geo.seed == null ? 20260806 : geo.seed);

  // Fog is the noir workhorse: it has to be LIGHTER than the buildings, or gray boxes
  // silhouette against nothing and the frame reads as black voids.
  const haze = fogColor.clone().lerp(new THREE.Color(0x1d4a4a), 0.72);
  scene.fog = new THREE.FogExp2(haze.getHex(), fogDensity);

  // sky: a vertical gradient so rooflines have something to cut against
  {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 256;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 256);
    const zenith = fogColor.clone().multiplyScalar(0.5);
    grd.addColorStop(0.0, '#' + zenith.getHexString());
    grd.addColorStop(0.55, '#' + fogColor.clone().lerp(haze, 0.5).getHexString());
    grd.addColorStop(0.72, '#' + haze.getHexString());
    grd.addColorStop(1.0, '#' + haze.clone().multiplyScalar(0.7).getHexString());
    g.fillStyle = grd;
    g.fillRect(0, 0, 8, 256);
    const t = new THREE.CanvasTexture(c);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.colorSpace = THREE.SRGBColorSpace;
    scene.background = t;
  }

  const colliders = [];
  const glowSprites = [];
  const flickers = [];
  const groundMeshes = [];
  const reflectiveMaterials = [];
  const meshesById = Object.create(null);
  const elementsById = Object.create(null);
  const materialCache = new Map();

  const ctx = {
    rand, palette, glowTex: radialGlowTexture(), streakTex: streakTexture(), reflectiveMaterials
  };

  function getMaterial(matId, sizeHint) {
    if (materialCache.has(matId)) return materialCache.get(matId);
    const def = geo.materials[matId];
    if (!def) throw new Error(`world.json geometry references unknown material "${matId}"`);
    const mat = buildMaterial(def, sizeHint || [1, 1], ctx);
    materialCache.set(matId, mat);
    return mat;
  }

  function addCollider(minX, maxX, minZ, maxZ, label) {
    colliders.push({ minX, maxX, minZ, maxZ, label });
  }

  for (const el of geo.elements) {
    elementsById[el.id] = el;
    const size = el.size || [1, 1, 1];
    const material = getMaterial(el.material, size);
    let mesh;

    if (el.type === 'box') {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
      mesh.position.set(el.position[0], el.position[1], el.position[2]);
      mesh.rotation.y = el.yaw || 0;
      scene.add(mesh);
      if (el.collider !== false) {
        const hw = size[0] / 2, hd = size[2] / 2;
        addCollider(el.position[0] - hw, el.position[0] + hw, el.position[2] - hd, el.position[2] + hd, el.id);
      }
    } else if (el.type === 'plane' || el.type === 'emissiveQuad') {
      mesh = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), material);
      mesh.position.set(el.position[0], el.position[1], el.position[2]);
      if (el.orientation === 'horizontal') {
        mesh.rotation.set(-Math.PI / 2, 0, el.yaw || 0);
      } else {
        mesh.rotation.y = el.yaw || 0;
      }
      scene.add(mesh);
      if (el.collider === true) {
        const hw = size[0] / 2, hd = size[1] / 2;
        addCollider(el.position[0] - hw, el.position[0] + hw, el.position[2] - hd, el.position[2] + hd, el.id);
      }
      const matDef = geo.materials[el.material];
      if (matDef && matDef.kind === 'glow' && el.orientation === 'vertical') glowSprites.push(mesh);
      if (el.ground) groundMeshes.push(mesh);
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

  // ----- reflection env for reflective materials (one capture, at init) -----
  const capturePos = (geo.envCapture && geo.envCapture.position) || [0, 2, 0];
  const cubeRT = new THREE.WebGLCubeRenderTarget(128, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const cubeCam = new THREE.CubeCamera(0.4, 90, cubeRT);
  cubeCam.position.set(capturePos[0], capturePos[1], capturePos[2]);
  scene.add(cubeCam);
  for (const r of reflectiveMaterials) {
    r.material.envMap = cubeRT.texture;
    r.material.envMapIntensity = r.envMapIntensity;
    r.material.needsUpdate = true;
  }

  const bounds = world.bounds || { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };

  let capturedEnv = false;
  function update(t, camera, renderer) {
    if (!capturedEnv && renderer) {
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

  return { colliders, bounds, update, elementsById };
}
