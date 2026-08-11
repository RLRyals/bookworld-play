// BookWorld — walkable slice, geometry-as-data, linked worlds, performance tiers.
//
// Story-agnostic first-person walk engine. Everything about a location — geometry,
// materials, light placement, spawn, trigger zones, cutscene clips, screen-reader
// description, world-texture rules — comes from a world.json manifest at runtime
// (js/geometry.js renders any conformant `geometry` block); this file contains no
// world-specific data or geometry.
//
// Reused from BookWorld-17c (js/engine.js): the manifest load/base-path handling,
// the cutscene video-overlay pattern (open / Escape / backdrop-click / ended ->
// close, camera untouched so the view resumes where it was armed), the prose modal,
// the prefers-reduced-motion branch, and the screen-reader description element.
//
// WORLD LINKS + PERF TIERS (slice 5b, specs/2026-08-08-world-links-and-perf.md):
//   * a `link` trigger action fades out, loads another pack, and spawns the player at
//     one of its named `spawns` — the door/portal answer to "how do you move between
//     scenes", with one scene resident at a time (small scenes are the resource model)
//   * link-adjacent preload warms the next pack's manifest and assets on approach
//   * a boot fps probe picks high/medium/low; a watchdog demotes (never promotes)
//   * input is sampled per frame and applied the SAME frame, with every damping term
//     framerate-independent and the physics substepped so a slow machine walks at the
//     same speed as a fast one — the "W and then, eventually, walking" bug
//
//   walk.html                            -> worlds/world-a/world.json (default)
//   walk.html?world=worlds/world-b/world.json  -> a differently-shaped pack
//   walk.html?spawn=from-world-a         -> start at a named spawn instead of `spawn`
//   walk.html?tier=low|medium|high       -> lock a performance tier (no probe/watchdog)
//   walk.html?preload=0                  -> disable link-adjacent preload (A/B measuring)
//   walk.html?fps=1                      -> on-screen fps readout
//   walk.html?post=0                     -> bypass the post stack (debugging)
import * as THREE from 'three';
import { buildWorld } from './geometry.js';
import { createPost } from './post.js';
import { GLTFLoader } from './lib/GLTFLoader.js';
import { resolveLang, loadChromeStrings, applyWorldLocale, t } from './i18n.js';

// three's loader cache is what makes preload pay off: a FileLoader/ImageLoader fetch
// primed on approach is served from memory when GLTFLoader/TextureLoader asks for the
// same URL after the link fires, whatever the HTTP cache headers say.
THREE.Cache.enabled = true;

const params = new URLSearchParams(location.search);
const startWorldPath = params.get('world') || 'worlds/world-a/world.json';
const startSpawnId = params.get('spawn') || null;
const postEnabled = params.get('post') !== '0';
const showFps = params.get('fps') === '1';
const preloadEnabled = params.get('preload') !== '0';
const tierParam = params.get('tier');
const lang = resolveLang('en');

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- localization (specs/2026-08-09-localization-language-packs.md) ----------
// Static chrome text that exists before any world is loaded (help panel, skip link,
// overlay buttons). Dynamic chrome (sr-only announcements, the quality toggle label,
// per-world zone hints) is localized inline via t() at the point each is produced.
function localizeStaticChrome() {
  const setText = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
  const setHtml = (id, key) => { const el = document.getElementById(id); if (el) el.innerHTML = t(key); };
  setText('skip-link', 'skipToControls');
  document.getElementById('bg')?.setAttribute('aria-label', t('canvasAriaLabel'));
  document.getElementById('zone-list')?.setAttribute('aria-label', t('zoneListAriaLabel'));
  setText('help-title', 'controlsTitle');
  setHtml('help-wasd', 'controlsWasd');
  setHtml('help-arrows', 'controlsArrows');
  setHtml('help-jump', 'controlsJump');
  setHtml('help-sprint', 'controlsSprint');
  setHtml('help-interact', 'controlsInteract');
  setHtml('help-hide', 'controlsHidePanel');
  document.getElementById('help-close')?.setAttribute('aria-label', t('helpClose'));
  document.getElementById('help-open')?.setAttribute('aria-label', t('helpOpen'));
  setText('jump-btn', 'jump');
  setText('prose-title', 'passage');
  setText('prose-close', 'close');
  document.getElementById('cutscene-overlay')?.setAttribute('aria-label', t('cutscene'));
  setText('cutscene-close', 'closeCutscene');
}

async function loadManifest(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load manifest ${path}: ${res.status}`);
  return res.json();
}

function manifestBase(path) {
  return path.slice(0, path.lastIndexOf('/') + 1);
}

function showLoadError(message) {
  const el = document.getElementById('load-error');
  document.getElementById('load-error-text').textContent = message;
  el.classList.remove('hidden');
}

// ============================================================================
// Performance tiers
// ============================================================================
// Rebecca's question was "what happens if someone has low vram or an older computer".
// The answer is three named rigs, chosen by measurement rather than by user-agent
// sniffing, with the geometry and textures identical in all three — a low-tier machine
// sees the same world, just without the expensive screen-space luxuries.
const TIER_ORDER = ['low', 'medium', 'high'];

function tierSettings(tier) {
  if (tier === 'low') {
    return { pixelRatio: 1, bloom: false, samples: 0, reflections: false, fog: 'linear', cubeSize: 64 };
  }
  if (tier === 'medium') {
    return { pixelRatio: Math.min(devicePixelRatio || 1, 1.25), bloom: true, samples: 2, reflections: true, fog: 'exp2', cubeSize: 64 };
  }
  return { pixelRatio: Math.min(devicePixelRatio || 1, 2), bloom: true, samples: 4, reflections: true, fog: 'exp2', cubeSize: 128 };
}

const perf = {
  // 'medium' is the deliberate starting point for the probe: high enough to be worth
  // measuring, cheap enough that a weak machine is not punished for the first second
  tier: 'medium',
  mode: 'auto',            // 'auto' = probe + watchdog, 'manual' = user/query locked
  probeDone: false,
  probeSamples: [],
  probeStart: 0,
  window: [],              // rolling frame times for the watchdog
  lastChange: 0,
  lastCheck: 0,
  history: [],             // every tier decision, for FINDINGS/verification
  frameMs: 0
};

if (tierParam && TIER_ORDER.indexOf(tierParam) >= 0) {
  perf.tier = tierParam;
  perf.mode = 'manual';
  perf.probeDone = true;
  perf.history.push({ tier: tierParam, why: 'query-override', t: 0 });
}

// Probe classification. Frame time, not fps: a mean fps on a loaded machine is dominated
// by scheduler hitches, and the median frame time is what the hand actually feels.
const PROBE_MS = 1000;
const PROBE_WARMUP_FRAMES = 10;   // shader compile + the one-shot env capture land here
const PROBE_WARMUP_MS = 250;

function median(values) {
  if (!values.length) return 0;
  const a = values.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function classify(medianMs) {
  if (medianMs <= 20) return 'high';     // >= 50 fps
  if (medianMs <= 34) return 'medium';   // >= ~29 fps
  return 'low';
}

let applyTierToSession = () => {};

function setTier(tier, why) {
  if (tier === perf.tier) return;
  perf.tier = tier;
  perf.lastChange = performance.now();
  perf.window.length = 0;
  perf.history.push({ tier, why, t: Math.round(performance.now()) });
  applyTierToSession();
  updateTierButton();
  announceGlobal(t('quality.changed', { tier }));
}

// The watchdog only ever steps DOWN. Promotion mid-session is what makes a marginal
// machine oscillate — it speeds up because the rig got cheaper, gets promoted back into
// the rig that was too slow, and thrashes. Coming back up is a deliberate user action.
const GRACE_MS = 2000;
const CHECK_MS = 1500;
const DEMOTE_MS = { high: 30, medium: 42 };

function notePerfFrame(frameMs) {
  perf.frameMs = frameMs;
  const now = performance.now();

  // Discard stalls, not slow machines. The first cut of this used 500 ms and was wrong in
  // the worst possible direction: a machine genuinely running at 1.9 fps had every sample
  // thrown away, the probe median came out 0, and it classified as HIGH. 2 s is "the tab
  // was asleep", and the hidden-document check catches the honest case directly.
  if (frameMs > 2000 || document.visibilityState === 'hidden') return;

  if (perf.mode === 'auto' && !perf.probeDone) {
    if (!perf.probeStart) perf.probeStart = now;
    const elapsed = now - perf.probeStart;
    if (elapsed > PROBE_WARMUP_MS) perf.probeSamples.push(frameMs);
    if (elapsed >= PROBE_MS + PROBE_WARMUP_MS) {
      const samples = perf.probeSamples.slice(PROBE_WARMUP_FRAMES);
      const med = median(samples.length ? samples : perf.probeSamples);
      perf.probeDone = true;
      perf.probeMedianMs = +med.toFixed(2);
      perf.lastChange = now;
      const picked = classify(med);
      perf.history.push({ tier: picked, why: `probe median ${med.toFixed(1)}ms`, t: Math.round(now) });
      if (picked !== perf.tier) {
        perf.tier = picked;
        applyTierToSession();
      }
      updateTierButton();
    }
    return;
  }

  if (perf.mode !== 'auto') return;

  perf.window.push(frameMs);
  if (perf.window.length > 120) perf.window.shift();
  if (now - perf.lastChange < GRACE_MS) return;
  if (now - perf.lastCheck < CHECK_MS) return;
  perf.lastCheck = now;
  // 20 samples, not 45: the machines this watchdog exists for are the ones where 45 frames
  // is nine seconds of the player suffering before anything happens. At 60 fps 20 frames is
  // a third of a second and the 2 s grace still stops it from twitching.
  if (perf.window.length < 20) return;

  const med = median(perf.window);
  const limit = DEMOTE_MS[perf.tier];
  if (limit && med > limit) {
    const next = TIER_ORDER[Math.max(0, TIER_ORDER.indexOf(perf.tier) - 1)];
    setTier(next, `watchdog median ${med.toFixed(1)}ms > ${limit}ms`);
  }
}

// ---------- the on-screen toggle (a11y: a real focusable button) ----------
const tierButton = document.getElementById('tier-toggle');

function tierButtonLabel() {
  return perf.mode === 'auto' ? t('quality.autoTier', { tier: perf.tier }) : t('quality.tier', { tier: perf.tier });
}
function updateTierButton() {
  if (!tierButton) return;
  tierButton.textContent = tierButtonLabel();
  tierButton.setAttribute('aria-label', perf.mode === 'auto'
    ? t('quality.ariaAutomatic', { tier: perf.tier })
    : t('quality.ariaManual', { tier: perf.tier }));
}
if (tierButton) {
  // auto -> high -> medium -> low -> auto
  tierButton.addEventListener('click', (ev) => {
    const cycle = ['auto', 'high', 'medium', 'low'];
    const cur = perf.mode === 'auto' ? 'auto' : perf.tier;
    const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length];
    if (next === 'auto') {
      perf.mode = 'auto';
      perf.probeDone = false;
      perf.probeSamples = [];
      perf.probeStart = 0;
      perf.window.length = 0;
      perf.lastChange = performance.now();
      perf.history.push({ tier: perf.tier, why: 'user: auto (re-probe)', t: Math.round(performance.now()) });
      updateTierButton();
      announceGlobal(t('quality.autoMeasuring'));
    } else {
      perf.mode = 'manual';
      if (next === perf.tier) {
        perf.history.push({ tier: next, why: 'user', t: Math.round(performance.now()) });
        updateTierButton();
      } else {
        setTier(next, 'user');
      }
    }
    // A mouse click leaves focus on the button, and a focused button owns the keyboard —
    // the player would tap "Quality" and then find W dead. A pointer activation therefore
    // hands focus back to the view; a keyboard activation (detail 0) keeps it, because a
    // keyboard user is still tabbing and must not be thrown out of the control.
    if (ev && ev.detail > 0) { tierButton.blur(); if (canvas) canvas.focus(); }
  });
  // Not called here: chrome strings aren't loaded yet at module-init time. boot()
  // calls updateTierButton() once loadChromeStrings() resolves.
}

// ============================================================================
// Session-level plumbing shared across linked worlds
// ============================================================================
// One WebGL context for the whole session. Worlds come and go; the renderer, the canvas,
// the overlays and the tier decision outlive them.
const canvas = document.getElementById('bg');
let renderer = null;

function getRenderer() {
  if (renderer) return renderer;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: !postEnabled, powerPreference: 'high-performance' });
  if (postEnabled) {
    // the composite pass does ACES + sRGB encode itself
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  } else {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  return renderer;
}

const statusEl = document.getElementById('walk-status');
function announceGlobal(msg) { if (statusEl) statusEl.textContent = msg; }

// ---------- help panel show/hide (session-level: the panel outlives worlds) ----------
// The H key was the only way to dismiss the legend, which on a phone means no way at
// all. The x closes it, the ? brings it back, H still toggles from the keyboard.
const helpPanelEl = document.getElementById('walk-help');
const helpOpenBtn = document.getElementById('help-open');
const helpCloseBtn = document.getElementById('help-close');
function setHelpVisible(show) {
  if (helpPanelEl) helpPanelEl.classList.toggle('hidden', !show);
  if (helpOpenBtn) helpOpenBtn.classList.toggle('hidden', show);
}
if (helpCloseBtn) helpCloseBtn.addEventListener('click', () => { setHelpVisible(false); if (canvas) canvas.focus(); });
if (helpOpenBtn) helpOpenBtn.addEventListener('click', () => setHelpVisible(true));

// ---------- fullscreen + keyboard lock (the Ctrl+W answer) ----------
// A tester with Minecraft muscle memory holds Ctrl+W to sprint — outside fullscreen
// that is the browser's "close tab" and nothing a page listener can prevent. In
// fullscreen, Chromium's Keyboard Lock API delivers even system shortcuts to the game;
// holding Esc exits per the browser's own UX. The button is best-effort everywhere else.
const fsButton = document.getElementById('fullscreen-toggle');
function updateFsButton() {
  if (!fsButton) return;
  const on = !!document.fullscreenElement;
  fsButton.textContent = t(on ? 'fullscreen.exit' : 'fullscreen.enter');
  fsButton.setAttribute('aria-label', t(on ? 'fullscreen.ariaExit' : 'fullscreen.ariaEnter'));
}
if (fsButton) {
  fsButton.addEventListener('click', async (ev) => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        if (navigator.keyboard && navigator.keyboard.lock) await navigator.keyboard.lock();
      } else {
        await document.exitFullscreen();
      }
    } catch { /* fullscreen/lock can be denied; nothing to do */ }
    // same focus rule as the quality toggle: a pointer activation must not leave the
    // button owning the keyboard
    if (ev && ev.detail > 0) { fsButton.blur(); if (canvas) canvas.focus(); }
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
    updateFsButton();
  });
}

// Outside fullscreen the best available net is the leave-confirmation dialog: an
// accidental Ctrl+W becomes a prompt instead of a silently lost session. Armed only
// after real input so a drive-by visitor is never nagged.
let playerHasInput = false;
addEventListener('keydown', () => { playerHasInput = true; }, { once: true });
addEventListener('touchstart', () => { playerHasInput = true; }, { once: true });
addEventListener('beforeunload', (e) => {
  if (!playerHasInput) return;
  e.preventDefault();
  e.returnValue = '';
});

const fadeEl = document.getElementById('fade');
const FADE_MS = reduce ? 0 : 240;
function fadeTo(opaque) {
  if (!fadeEl) return Promise.resolve();
  fadeEl.style.transitionDuration = FADE_MS + 'ms';
  fadeEl.classList.toggle('on', opaque);
  return new Promise((r) => setTimeout(r, FADE_MS));
}

// ---------- link-adjacent preload ----------
// "Small scenes, one load" is the deliberate resource model; the cost of that model is a
// stall at the door. Preload pays it early: when the player gets near a link zone the
// next pack's manifest is fetched and parsed, and its heavy assets (skybox image, image
// textures, glTF props) are pulled into three's loader cache.
const manifestCache = new Map();     // path -> parsed world.json
const preloadState = new Map();      // path -> 'loading' | 'done'
const preloadTimings = [];

function isImagePathSpec(spec) {
  return typeof spec === 'string' && (/[\\/]/.test(spec) || /\.(png|jpe?g|webp|avif|ktx2?|bmp|gif)$/i.test(spec));
}

function packAssetUrls(world, base) {
  const urls = [];
  if (world.sky && world.sky.type === 'skybox' && world.sky.src) urls.push({ url: base + world.sky.src, kind: 'image' });
  const mats = (world.geometry && world.geometry.materials) || {};
  for (const key in mats) {
    const spec = mats[key] && mats[key].texture;
    if (isImagePathSpec(spec)) urls.push({ url: base + spec, kind: 'image' });
  }
  for (const p of world.props || []) {
    if (p.src) urls.push({ url: base + p.src, kind: 'binary' });
  }
  return urls;
}

function preloadWorld(path) {
  if (!preloadEnabled || preloadState.has(path)) return;
  preloadState.set(path, 'loading');
  const t0 = performance.now();
  // a pack already visited this session is in the manifest cache; only its assets (which
  // three may have evicted nothing of, but which cost nothing to re-request) need warming
  const cached = manifestCache.get(path);
  (cached ? Promise.resolve(cached) : loadManifest(path))
    .then((world) => {
      manifestCache.set(path, world);
      const base = manifestBase(path);
      const assets = packAssetUrls(world, base);
      let pending = assets.length;
      const done = () => {
        if (--pending > 0) return;
        preloadState.set(path, 'done');
        preloadTimings.push({ path, ms: +(performance.now() - t0).toFixed(1), assets: assets.length });
      };
      if (!assets.length) {
        preloadState.set(path, 'done');
        preloadTimings.push({ path, ms: +(performance.now() - t0).toFixed(1), assets: 0 });
        return;
      }
      for (const a of assets) {
        if (a.kind === 'image') new THREE.ImageLoader().load(a.url, done, undefined, done);
        else new THREE.FileLoader().setResponseType('arraybuffer').load(a.url, done, undefined, done);
      }
    })
    .catch(() => { preloadState.set(path, 'done'); });
}

// `toWorld` follows the same convention as ?world= — a path from the page — unless it is
// written relatively ("./" or "../"), in which case it resolves against the pack folder,
// the way cutscene `video` paths already do.
function resolveWorldPath(spec, base) {
  if (/^(https?:)?\/\//.test(spec) || spec.startsWith('/')) return spec;
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const pageDir = new URL('.', location.href);
    const abs = new URL(base + spec, pageDir).href;
    return abs.startsWith(pageDir.href) ? abs.slice(pageDir.href.length) : abs;
  }
  return spec;
}

const travel = {
  busy: false,
  transitions: []   // every link traversal, with timings — the preload evidence
};

let session = null;

async function loadWorld(path, spawnId, why) {
  const t0 = performance.now();
  const preloaded = preloadState.get(path) === 'done' || manifestCache.has(path);
  let world = manifestCache.get(path);
  const tManifest0 = performance.now();
  if (!world) {
    world = await loadManifest(path);
    await applyWorldLocale(world, manifestBase(path), lang);
    manifestCache.set(path, world);
  }
  const manifestMs = performance.now() - tManifest0;

  if (session) session.destroy();
  session = init(world, manifestBase(path), spawnId, path);
  await session.firstFrame;
  const readyMs = performance.now() - t0;

  const record = {
    to: path, spawn: spawnId || null, why: why || 'load',
    preloaded, manifestMs: +manifestMs.toFixed(1), readyMs: +readyMs.toFixed(1),
    propsMs: null
  };
  travel.transitions.push(record);
  session.propsReady.then(() => { record.propsMs = +(performance.now() - t0).toFixed(1); });
  return record;
}

async function travelTo(spec, spawnId, base) {
  if (travel.busy) return;
  travel.busy = true;
  const path = resolveWorldPath(spec, base);
  try {
    if (session) session.suspend();
    announceGlobal(t('travelling'));
    await fadeTo(true);
    await loadWorld(path, spawnId, 'link');
    await fadeTo(false);
  } catch (err) {
    await fadeTo(false);
    showLoadError(err.message);
  } finally {
    travel.busy = false;
  }
}

window.__bookworldSession = {
  perf,
  travel,
  preloadTimings,
  get tier() { return perf.tier; },
  get tierMode() { return perf.mode; },
  preloadState,
  setTier(t) { perf.mode = 'manual'; setTier(t, 'api'); },
  goTo(path, spawn) { return travelTo(path, spawn, ''); }
};

// ============================================================================
// One world
// ============================================================================
function init(world, base, spawnId, worldPath) {
  document.title = world.title || 'BookWorld';
  const loadWarnings = []; // non-fatal pack-asset failures (a texture/prop/sky that 404s)
  const listeners = new AbortController();   // every listener below dies with the world
  const signal = listeners.signal;
  let destroyed = false;

  // ---------- a11y: description + zone inventory, both manifest-driven ----------
  document.getElementById('scene-description').textContent = world.description || '';
  const zoneList = document.getElementById('zone-list');
  zoneList.innerHTML = '';
  (world.triggers || []).forEach((trig) => {
    const li = document.createElement('li');
    const how = trig.mode === 'auto' ? t('zoneHintAuto') : t('zoneHintPrompted');
    li.textContent = `${trig.label}: ${trig.srHint || ''} (${how})`.replace(/\s+/g, ' ').trim();
    zoneList.appendChild(li);
  });
  const status = statusEl;
  function announce(msg) { status.textContent = msg; }

  // touch is additive to keyboard+mouse (feature-detect, never a mode switch), but a
  // first-time phone visitor still needs to be told the gestures exist
  const helpList = document.querySelector('#walk-help ul');
  let touchHelpLi = null;
  if (matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0) {
    touchHelpLi = document.createElement('li');
    touchHelpLi.innerHTML = t('controlsTouch');
    helpList.appendChild(touchHelpLi);
  }
  let rideHelpLi = null;
  if ((world.mounts || []).length) {
    rideHelpLi = document.createElement('li');
    rideHelpLi.innerHTML = t('controlsRiding');
    helpList.appendChild(rideHelpLi);
  }

  // on-screen jump button — the touch equivalent of Space (jump on land, rise in water)
  const jumpBtn = document.getElementById('jump-btn');
  if (jumpBtn && (matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0)) {
    jumpBtn.classList.remove('hidden');
    jumpBtn.textContent = t('jump');
    jumpBtn.addEventListener('touchstart', (e) => { e.preventDefault(); if (!inputLocked) touchJumpHeld = true; }, { passive: false, signal });
    const endJump = (e) => { e.preventDefault(); touchJumpHeld = false; };
    jumpBtn.addEventListener('touchend', endJump, { passive: false, signal });
    jumpBtn.addEventListener('touchcancel', endJump, { passive: false, signal });
  }

  // ---------- renderer (shared across worlds) ----------
  const rend = getRenderer();
  let tierNow = tierSettings(perf.tier);
  rend.setPixelRatio(tierNow.pixelRatio);
  rend.setSize(innerWidth, innerHeight);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.08, 220);
  camera.rotation.order = 'YXZ';

  // ---------- the block ----------
  // `base` is the pack folder — every style-pack file reference (texture images, skybox
  // panorama, glTF props) resolves against it, so a pack stays self-contained.
  const built = buildWorld(scene, world, reduce, {
    base,
    quality: { reflections: tierNow.reflections, cubeSize: tierNow.cubeSize, fog: tierNow.fog },
    warn: (msg) => { console.warn('[bookworld] ' + msg); loadWarnings.push(msg); }
  });
  const colliders = built.colliders;
  const bounds = built.bounds;
  const waterVolumes = built.waterVolumes || [];
  const baseFogColor = built.atmosphere.fog.color.clone();
  const baseFogDensity = built.atmosphere.fog.density;

  const post = createPost(rend, scene, camera, built.atmosphere);
  post.params.enabled = postEnabled;
  post.setQuality({ bloom: tierNow.bloom, samples: tierNow.samples });
  post.setSize(innerWidth, innerHeight, tierNow.pixelRatio);

  function applyTier() {
    if (destroyed) return;
    tierNow = tierSettings(perf.tier);
    rend.setPixelRatio(tierNow.pixelRatio);
    rend.setSize(innerWidth, innerHeight);
    post.setQuality({ bloom: tierNow.bloom, samples: tierNow.samples });
    post.setSize(innerWidth, innerHeight, tierNow.pixelRatio);
    built.setReflections(tierNow.reflections);
    built.setFogMode(tierNow.fog);
    fogNeedsReset = true;
  }
  applyTierToSession = applyTier;

  // ---------- player state (spawn is manifest data) ----------
  // A pack may declare named `spawns` alongside its default `spawn`, so a return door can
  // put the player back at the doorway they came through rather than at the world's front
  // gate. An unknown/absent spawn id falls back to `spawn` — a pack with neither block is
  // unchanged.
  const namedSpawns = world.spawns || {};
  const requestedSpawn = spawnId && namedSpawns[spawnId] ? namedSpawns[spawnId] : null;
  if (spawnId && !requestedSpawn) console.warn(`[bookworld] unknown spawn "${spawnId}" in ${world.id || base} — using the default spawn`);
  const spawn = requestedSpawn || world.spawn || {};
  const activeSpawnId = requestedSpawn ? spawnId : null;

  const playerCfg = world.player || {};
  const EYE = playerCfg.eyeHeight == null ? 1.65 : playerCfg.eyeHeight;
  const SPEED = playerCfg.walkSpeed == null ? 2.8 : playerCfg.walkSpeed;
  const RUN_SPEED = playerCfg.runSpeed == null ? SPEED * 1.8 : playerCfg.runSpeed;
  const RADIUS = playerCfg.radius == null ? 0.45 : playerCfg.radius;
  const JUMP_HEIGHT = playerCfg.jumpHeight == null ? 1.1 : playerCfg.jumpHeight;
  const STEP_HEIGHT = playerCfg.stepHeight == null ? 0.45 : playerCfg.stepHeight;
  const SWIM_SPEED = playerCfg.swimSpeed == null ? 1.6 : playerCfg.swimSpeed;
  const TURN = 1.9; // rad/s for keyboard turning

  // body height used for vertical collision (step/ceiling checks) — a little taller
  // than eye height so a ceiling actually caps the head, not just the eye point
  const BODY_HEIGHT = EYE + 0.2;
  const GRAVITY = 16; // m/s^2, tuned for a Minecraft-ish short arc, not real-world 9.8
  const MAX_FALL_SPEED = 22;
  const JUMP_VELOCITY = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT);
  const SWIM_RISE_SPEED = SWIM_SPEED * 0.8;
  const SWIM_SINK_SPEED = SWIM_SPEED * 0.6;
  const SWIM_DAMPING = 0.9; // per-second-normalised velocity decay while swimming, no input
  const respawnCfg = world.respawn || {};
  const RESPAWN_Y = respawnCfg.fallY == null ? -25 : respawnCfg.fallY;

  // Per-mode body values (BookWorld-898 FINDINGS: a mount has a different radius and a
  // different — usually smaller — step allowance than feet, so the collision helpers read
  // these, not the walk constants; mounting/dismounting swaps them).
  let CUR_RADIUS = RADIUS;
  let CUR_STEP = STEP_HEIGHT;

  const spawnPos = (spawn.position || [0, 0, 0]);
  const pos = new THREE.Vector3(spawnPos[0], 0, spawnPos[2]);
  let feetY = 0; // ground-relative height of the player's feet; camera = feetY + EYE + bob
  let vy = 0; // vertical velocity, m/s
  let grounded = true;
  let swimming = false;
  let currentWater = null; // the water volume the player is currently swimming in
  let yaw = spawn.yaw || 0;
  let pitch = spawn.pitch || 0;
  let smoothYaw = yaw, smoothPitch = pitch;
  let bobPhase = 0, bobY = 0, bobRoll = 0;

  // ---------- vertical helpers ----------
  function findWaterAt(x, z) {
    for (let i = 0; i < waterVolumes.length; i++) {
      const w = waterVolumes[i];
      if (x > w.minX && x < w.maxX && z > w.minZ && z < w.maxZ) return w;
    }
    return null;
  }

  // ground/step support at (x,z): the higher of "open ground" (0, or a water
  // volume's floor if the point is over a dry-below pit) and any collider top
  // whose footprint contains the point AND whose top is within step reach of
  // refFeetY (the player's height going into this check). That gate matters for
  // colliders whose underside floats above the ground (a beam, an overhang): without
  // it, its top would count as "the support here" even while the player is standing
  // or falling well below it, which would teleport them through their own ceiling.
  // A step/ledge the player has already reached (refFeetY at/above the top, e.g. after
  // jumping onto it) or open ground below still resolves correctly either way.
  function supportHeight(x, z, refFeetY) {
    const ref = refFeetY == null ? Infinity : refFeetY;
    let h = 0;
    const w = findWaterAt(x, z);
    if (w) h = w.floorY;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && c.maxY <= ref + CUR_STEP + 1e-6) {
        h = Math.max(h, c.maxY);
      }
    }
    return h;
  }

  // true if collider c should block horizontal movement given the player's CURRENT
  // feet height: a wall unless it's low enough to step onto, or the player is
  // already standing/airborne above its top (jumped clear, or landed on it).
  function isWall(c, currentFeetY) {
    const feetTop = currentFeetY + BODY_HEIGHT;
    if (!(c.minY < feetTop && c.maxY > currentFeetY)) return false; // no vertical overlap
    const delta = c.maxY - currentFeetY;
    if (delta <= CUR_STEP + 1e-6) return false; // step-up, not a wall
    if (currentFeetY >= c.maxY - 1e-6) return false; // already above the top
    return true;
  }

  // ---------- collision: circle vs axis-aligned rectangles, then hard bounds ----------
  function resolveHorizontal(p, currentFeetY) {
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < colliders.length; i++) {
        const c = colliders[i];
        if (!isWall(c, currentFeetY)) continue;
        const minX = c.minX - CUR_RADIUS, maxX = c.maxX + CUR_RADIUS;
        const minZ = c.minZ - CUR_RADIUS, maxZ = c.maxZ + CUR_RADIUS;
        if (p.x > minX && p.x < maxX && p.z > minZ && p.z < maxZ) {
          const dl = p.x - minX, dr = maxX - p.x, db = p.z - minZ, dt = maxZ - p.z;
          const m = Math.min(dl, dr, db, dt);
          if (m === dl) p.x = minX;
          else if (m === dr) p.x = maxX;
          else if (m === db) p.z = minZ;
          else p.z = maxZ;
        }
      }
    }
    // hard world envelope — belt and braces, the player can never be outside it
    p.x = Math.max(bounds.minX, Math.min(bounds.maxX, p.x));
    p.z = Math.max(bounds.minZ, Math.min(bounds.maxZ, p.z));
  }

  // caps a rising feetY against the underside of any collider whose footprint the
  // player currently occupies — "no head-through-ceiling"
  function capCeiling(newFeetY) {
    if (newFeetY <= feetY) return newFeetY;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (!(pos.x > c.minX && pos.x < c.maxX && pos.z > c.minZ && pos.z < c.maxZ)) continue;
      if (c.minY > feetY && c.minY < newFeetY + BODY_HEIGHT) {
        const capped = c.minY - BODY_HEIGHT;
        if (capped < newFeetY) { newFeetY = Math.max(feetY, capped); vy = Math.min(vy, 0); }
      }
    }
    return newFeetY;
  }

  function respawn() {
    pos.x = spawnPos[0]; pos.z = spawnPos[2];
    feetY = 0; vy = 0; grounded = true; swimming = false; currentWater = null;
    announce(t('fellOutOfWorld'));
  }

  resolveHorizontal(pos, feetY);

  // ---------- input ----------
  // Two rules make the "press W, wait, walk" bug impossible:
  //   1. the key state is read at the top of the frame and the resulting translation is
  //      applied in the SAME frame, before that frame's camera update and render;
  //   2. a key that goes down and back up BETWEEN two frames still counts as held for
  //      the next frame (`edge`). On a laptop running at 12 fps the gap between frames is
  //      83 ms — comfortably long enough to swallow a real tap otherwise, which reads as
  //      "the key did nothing" rather than as latency.
  const keys = Object.create(null);
  const edge = Object.create(null);
  function down(code) { return !!keys[code] || !!edge[code]; }
  let inputLocked = false;
  const helpPanel = document.getElementById('walk-help');

  // Sprint carries three activations because testers arrive with Minecraft muscle
  // memory: hold Ctrl (safe only under fullscreen keyboard-lock — Ctrl+W otherwise
  // belongs to the browser and closes the tab, which is why double-tap exists), or
  // double-tap-and-hold W, or on touch just drag the move finger farther.
  let sprintLatch = false;
  let lastWDown = 0;
  let touchSprint = false;
  let touchJumpHeld = false;
  let sprinting = false;

  const MOVE_KEYS = {
    KeyW: 1, KeyS: 1, KeyA: 1, KeyD: 1,
    ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1,
    KeyR: 1, KeyF: 1,
    Space: 1, KeyJ: 1 // jump (grounded) / rise (swimming) — Space is primary, J the keyboard-only alternative
  };
  // the subset that must produce VISIBLE TRANSLATION, which is what the latency criterion
  // is about — turning and pitching are measured by the same loop but are not the claim
  const TRANSLATE_KEYS = {
    KeyW: 1, KeyS: 1, KeyA: 1, KeyD: 1, ArrowUp: 1, ArrowDown: 1, Space: 1, KeyJ: 1
  };

  function clearKeys() {
    for (const k in keys) keys[k] = false;
    for (const k in edge) edge[k] = false;
    sprintLatch = false;
  }

  // the on-screen controls (quality toggle, overlay buttons) are real focusable elements;
  // while one of them has focus the walk keys must belong to IT, not to the player
  function isFormTarget(el) {
    return !!el && el !== document.body && el !== canvas &&
      /^(button|a|input|select|textarea)$/i.test(el.tagName || '');
  }

  // ---------- touch: left-half drag = move, right-half drag = look, coexists with
  // keyboard+mouse (feature-detect only, never a mode switch — both paths stay live
  // and just add together in the frame loop below). No pinch/zoom handling: touch-action
  // none on the canvas (css/walk.css) already suppresses that gesture entirely.
  const isCoarsePointer = matchMedia('(pointer: coarse)').matches;
  let moveTouch = null; // { id, startX, startY, curX, curY }
  let lookTouch = null; // { id, lastX, lastY }
  const TOUCH_LOOK_SENSITIVITY = 0.0035;
  const TOUCH_MOVE_DEADZONE = 10; // px, before a left-half drag counts as a direction

  function clearTouches() { moveTouch = null; lookTouch = null; touchSprint = false; touchJumpHeld = false; }

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (inputLocked) return;
    for (const touch of e.changedTouches) {
      const isLeftHalf = touch.clientX < innerWidth / 2;
      if (isLeftHalf && !moveTouch) {
        moveTouch = { id: touch.identifier, startX: touch.clientX, startY: touch.clientY, curX: touch.clientX, curY: touch.clientY };
      } else if (!isLeftHalf && !lookTouch) {
        lookTouch = { id: touch.identifier, lastX: touch.clientX, lastY: touch.clientY };
      }
    }
  }, { passive: false, signal });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (inputLocked) return;
    for (const touch of e.changedTouches) {
      if (moveTouch && touch.identifier === moveTouch.id) {
        moveTouch.curX = touch.clientX;
        moveTouch.curY = touch.clientY;
      } else if (lookTouch && touch.identifier === lookTouch.id) {
        const dx = touch.clientX - lookTouch.lastX;
        const dy = touch.clientY - lookTouch.lastY;
        lookTouch.lastX = touch.clientX;
        lookTouch.lastY = touch.clientY;
        yaw += dx * TOUCH_LOOK_SENSITIVITY;
        pitch = Math.max(-1.1, Math.min(1.1, pitch - dy * TOUCH_LOOK_SENSITIVITY));
      }
    }
  }, { passive: false, signal });

  function releaseTouches(e) {
    for (const touch of e.changedTouches) {
      if (moveTouch && touch.identifier === moveTouch.id) moveTouch = null;
      if (lookTouch && touch.identifier === lookTouch.id) lookTouch = null;
    }
  }
  canvas.addEventListener('touchend', releaseTouches, { signal });
  canvas.addEventListener('touchcancel', releaseTouches, { signal });

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return; // handled by the overlays / pointer lock
    if (isFormTarget(e.target)) return;
    if (inputLocked) return;
    if (e.code === 'KeyH') { setHelpVisible(helpPanel.classList.contains('hidden')); e.preventDefault(); return; }
    if (e.code === 'Home') { pitch = 0; e.preventDefault(); return; }
    if (e.code === 'KeyE') { interact(); e.preventDefault(); return; }
    if (e.code in MOVE_KEYS || e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'ControlLeft' || e.code === 'ControlRight') e.preventDefault();
    if (e.code === 'KeyW' && !keys.KeyW) {
      const now = performance.now();
      if (now - lastWDown < 350) sprintLatch = true;
      lastWDown = now;
    }
    if (!keys[e.code] && e.code in TRANSLATE_KEYS) noteKeyPress();
    keys[e.code] = true;
    edge[e.code] = true;
  }, { signal });
  addEventListener('keyup', (e) => {
    keys[e.code] = false;
    if (e.code === 'KeyW') sprintLatch = false;
  }, { signal });
  addEventListener('blur', () => { clearKeys(); clearTouches(); }, { signal });
  // coming back to a backgrounded tab must not simulate the minutes it was away: throw
  // the accumulated delta out (and drop any key the browser never sent a keyup for)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { clock.getDelta(); clearKeys(); clearTouches(); }
  }, { signal });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== canvas) clearKeys();
  }, { signal });

  // mouse-look via pointer lock (optional — the keyboard/touch paths are complete without
  // it; skipped on coarse pointers, where pointer lock is either unsupported or meaningless)
  canvas.addEventListener('click', () => {
    if (inputLocked || isCoarsePointer) return;
    if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
  }, { signal });
  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas || inputLocked) return;
    yaw += e.movementX * 0.0022;
    pitch = Math.max(-1.1, Math.min(1.1, pitch - e.movementY * 0.0022));
  }, { signal });

  // ---------- keypress -> motion instrumentation ----------
  // Not a debug aid bolted on afterwards: the spec's acceptance criterion is a NUMBER
  // ("<= 2 frames at any tier"), so the engine measures it on real presses.
  const latency = { samples: [], worstFrames: 0, worstMs: 0 };
  let pendingPress = null;
  let frameCount = 0;
  function noteKeyPress() {
    const now = performance.now();
    // a press that never produced motion (walked into a wall, jumped while airborne)
    // must not be charged to the NEXT press, so a stale probe simply expires
    if (pendingPress && now - pendingPress.t < 1000) return;
    pendingPress = { t: now, frame: frameCount };
  }
  function noteMotion() {
    if (!pendingPress) return;
    const s = {
      frames: frameCount - pendingPress.frame,
      ms: +(performance.now() - pendingPress.t).toFixed(2),
      tier: perf.tier
    };
    pendingPress = null;
    latency.samples.push(s);
    if (latency.samples.length > 60) latency.samples.shift();
    if (s.frames > latency.worstFrames) latency.worstFrames = s.frames;
    if (s.ms > latency.worstMs) latency.worstMs = s.ms;
  }

  // ---------- overlays (pattern reused from js/engine.js) ----------
  const proseOverlay = document.getElementById('prose-overlay');
  const proseText = document.getElementById('prose-text');
  const proseClose = document.getElementById('prose-close');
  const cutsceneOverlay = document.getElementById('cutscene-overlay');
  const cutsceneVideo = document.getElementById('cutscene-video');
  const cutsceneClose = document.getElementById('cutscene-close');

  let resumeState = null;
  function suspendWalk() {
    resumeState = { x: pos.x, z: pos.z, yaw, pitch, feetY, vy };
    inputLocked = true;
    clearKeys();
    clearTouches();
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  }
  function resumeWalk() {
    if (resumeState) {
      pos.x = resumeState.x; pos.z = resumeState.z;
      feetY = resumeState.feetY; vy = resumeState.vy;
      yaw = resumeState.yaw; pitch = resumeState.pitch;
      smoothYaw = yaw; smoothPitch = pitch;
      resumeState = null;
    }
    inputLocked = false;
    canvas.focus();
    announce(t('backWhereLeftOff'));
  }

  function openProse(text) {
    suspendWalk();
    proseText.textContent = text;
    proseOverlay.classList.remove('hidden');
    proseClose.focus();
  }
  function closeProse() {
    if (proseOverlay.classList.contains('hidden')) return;
    proseOverlay.classList.add('hidden');
    resumeWalk();
  }
  proseClose.addEventListener('click', closeProse, { signal });

  const cutscenesById = {};
  (world.cutscenes || []).forEach((c) => { cutscenesById[c.id] = c; });

  function playCutscene(cutsceneId) {
    const c = cutscenesById[cutsceneId];
    if (!c) { announce(t('cutsceneMissing')); return; }
    suspendWalk();
    cutsceneVideo.src = base + c.video;
    if (c.poster) cutsceneVideo.poster = base + c.poster;
    cutsceneOverlay.classList.remove('hidden');
    cutsceneOverlay.setAttribute('aria-label', c.title ? t('cutsceneWithTitle', { title: c.title }) : t('cutscene'));
    try { cutsceneVideo.currentTime = 0; } catch (_) { /* not seekable yet */ }
    cutsceneVideo.play().catch(() => {});
    cutsceneClose.focus();
    announce(t('cutscenePlaying', { title: c.title || c.id }));
  }
  function closeCutscene() {
    if (cutsceneOverlay.classList.contains('hidden')) return;
    cutsceneVideo.pause();
    cutsceneOverlay.classList.add('hidden');
    resumeWalk();
  }
  cutsceneVideo.addEventListener('ended', closeCutscene, { signal });
  cutsceneVideo.addEventListener('error', () => {
    announce(t('cutsceneFailed'));
    closeCutscene();
  }, { signal });
  cutsceneClose.addEventListener('click', closeCutscene, { signal });
  cutsceneOverlay.addEventListener('click', (e) => { if (e.target === cutsceneOverlay) closeCutscene(); }, { signal });

  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!cutsceneOverlay.classList.contains('hidden')) { closeCutscene(); e.preventDefault(); }
    else if (!proseOverlay.classList.contains('hidden')) { closeProse(); e.preventDefault(); }
  }, { signal });

  // ---------- trigger zones (all manifest data) ----------
  // A zone anchors to a geometry element id (closing the FINDINGS gap from BookWorld-5jx:
  // "nothing ties alley-door to the door mesh") instead of, or in addition to, a bare
  // world coordinate. `anchor` + optional `offset` resolves to the element's own position;
  // a bare `position` stays legal for zones with no natural geometry (open street).
  function resolveTriggerPosition(trig) {
    if (trig.anchor) {
      const el = built.elementsById[trig.anchor];
      if (!el) throw new Error(`Trigger "${trig.id}" anchors to unknown geometry id "${trig.anchor}"`);
      const off = trig.offset || [0, 0, 0];
      return [el.position[0] + off[0], el.position[1] + off[1], el.position[2] + off[2]];
    }
    return trig.position || [0, 0, 0];
  }

  const promptEl = document.getElementById('prompt');
  const zones = (world.triggers || []).map((trig) => ({
    def: trig,
    pos: resolveTriggerPosition(trig),
    inside: false,
    armed: true,
    fired: false,
    spawnSuppressed: false,
    preloadStarted: false
  }));
  let activeZone = null;

  function zoneContains(z, x, zz) {
    const p = z.pos;
    if (z.def.shape === 'box') {
      const b = z.def.bounds || [2, 2, 2];
      return Math.abs(x - p[0]) <= b[0] / 2 && Math.abs(zz - p[2]) <= b[2] / 2;
    }
    const r = z.def.radius == null ? 2 : z.def.radius;
    const dx = x - p[0], dz = zz - p[2];
    return dx * dx + dz * dz <= r * r;
  }

  // ---------- the spawn-inside-an-auto-zone fix ----------
  // Flagged in FINDINGS by the style slice: both restyled packs spawn INSIDE their own
  // "arrival" zone, so the arrival cutscene was already on screen before the player had
  // seen a single frame of the world. An auto zone the player is standing in at spawn is
  // therefore born disarmed and only arms once they have fully left it — you cannot
  // "arrive" somewhere you started. This also makes a return door safe: linking back into
  // a doorway that is itself an auto link zone must not bounce you straight out again.
  for (const z of zones) {
    z.inside = zoneContains(z, pos.x, pos.z);
    if (z.inside && z.def.mode === 'auto') {
      z.armed = false;
      z.spawnSuppressed = true;
    }
  }

  // ============================================================================
  // Mounts, companions, patrol routes (slice 6) — all pack data, zero story canon
  // ============================================================================
  const gltfLoader = new GLTFLoader();

  // Load a pack glb scaled so its longest horizontal dimension equals `targetLength`.
  // Image-to-3D exports arrive at arbitrary units; the pack states the vehicle's real
  // length once ("a motorcycle is 2.2 m") instead of hand-tuning a magic scale factor.
  // Base-aligned like props: the model's lowest point sits on the stated Y.
  function loadScaledModel(def, onReady) {
    gltfLoader.load(base + def.src, (gltf) => {
      if (destroyed) return;
      const root = gltf.scene;
      const rawBox = new THREE.Box3().setFromObject(root);
      const rawSize = rawBox.getSize(new THREE.Vector3());
      let scale = def.scale == null ? 1 : def.scale;
      if (def.targetLength && Math.max(rawSize.x, rawSize.z) > 1e-6) {
        scale = def.targetLength / Math.max(rawSize.x, rawSize.z);
      }
      root.scale.setScalar(scale);
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      scene.add(root);
      onReady({ root, baseLift: -box.min.y, box, rawBox, scaleApplied: scale });
    }, undefined, (err) => {
      const msg = `${def.id || def.src}: model failed to load (${err && err.message ? err.message : err})`;
      console.warn('[bookworld] ' + msg);
      loadWarnings.push(msg);
    });
  }

  // ---------- mounts: park, ride, dismount ----------
  const mounts = (world.mounts || []).map((def) => {
    const p = def.position || [0, 0, 0];
    return { def, object: null, baseLift: 0, ready: false, x: p[0], y: p[1], z: p[2], yaw: def.yaw || 0, collider: null };
  });
  let mounted = null;
  let nearMount = null;
  let rideSpeed = 0;
  let rideLean = 0, rideLeanSm = 0;

  // Soft elliptical falloff for ground-glow quads (headlight pool). One shared texture,
  // built lazily, disposed with the world's scene traversal like any other map.
  let sharedGlowTexture = null;
  function glowPoolTexture() {
    if (sharedGlowTexture) return sharedGlowTexture;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.30)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    sharedGlowTexture = new THREE.CanvasTexture(c);
    return sharedGlowTexture;
  }

  // A night world makes an unlit vehicle invisible, including the one you are sitting
  // on. Every mount (and rider companion) gets a headlight rig: a forward spot that is
  // the riding light, plus a soft under-glow that keeps the parked machine findable.
  // Colors are pack data (headlightColor / underglow, defaulting to the palette accent).
  function addVehicleLights(entry, def) {
    // r155+ physical units: a spotlight is candela — hundreds light nothing at street
    // range (the same two-orders-of-magnitude trap the first lighting pass hit)
    const headColor = new THREE.Color(def.headlightColor || '#dff2ff');
    const head = new THREE.SpotLight(headColor.getHex(), 3000, 48, 0.55, 0.7, 1.5);
    head.visible = false;
    head.target = new THREE.Object3D();
    scene.add(head, head.target);
    const glowColor = new THREE.Color(def.underglow || (world.palette && world.palette.accent) || '#35d0ff').getHex();
    const glow = new THREE.PointLight(glowColor, 36, 5.5, 2.0);
    scene.add(glow);
    // small cockpit fill so the machine itself reads from the saddle at night
    const cockpit = new THREE.PointLight(headColor.getHex(), 30, 3.2, 2.0);
    scene.add(cockpit);
    // the wet-road trick from the packs: a highly metallic road answers emissive quads,
    // not diffuse light, so the headlight carries its own moving pool. The quad wears a
    // radial-gradient texture — a plain plane at any opacity reads as a bright square
    // FLOOR attached to the bike (first playtest report), not as light on asphalt.
    const poolMat = new THREE.MeshBasicMaterial({ color: headColor.getHex(), map: glowPoolTexture(), transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false });
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 9), poolMat);
    pool.rotation.order = 'YXZ';
    pool.visible = false;
    scene.add(pool);
    entry.headlight = head;
    entry.underglow = glow;
    entry.cockpit = cockpit;
    entry.headPool = pool;
  }
  function placeVehicleLights(entry, x, z, yaw2, feet, headOn) {
    const fx = Math.sin(yaw2), fz = -Math.cos(yaw2);
    if (entry.headlight) {
      // the emitter sits AHEAD of the vehicle's nose: a spot inside the model nukes the
      // nearest fairing surface into a bloom disc that fills the whole frame
      entry.headlight.visible = !!headOn;
      entry.headlight.position.set(x + fx * 2.1, feet + 0.85, z + fz * 2.1);
      entry.headlight.target.position.set(x + fx * 17, feet + 0.1, z + fz * 17);
    }
    if (entry.underglow) entry.underglow.position.set(x, feet + 0.35, z);
    if (entry.cockpit) {
      entry.cockpit.visible = !!headOn;
      entry.cockpit.position.set(x + fx * 0.7, feet + 1.25, z + fz * 0.7);
    }
    if (entry.headPool) {
      entry.headPool.visible = !!headOn;
      entry.headPool.position.set(x + fx * 5.6, feet + 0.03, z + fz * 5.6);
      entry.headPool.rotation.set(-Math.PI / 2, -yaw2, 0);
    }
  }

  function placeMountObject(m) {
    if (!m.object) return;
    m.object.position.set(m.x, m.y + m.baseLift, m.z);
    m.object.rotation.set(0, -m.yaw + (m.def.modelYaw || 0), 0);
    m.object.updateMatrixWorld(true);
    placeVehicleLights(m, m.x, m.z, m.yaw, m.y, false);
  }
  function parkCollider(m) {
    if (!m.object) return;
    const b = new THREE.Box3().setFromObject(m.object);
    m.collider = { minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z, minY: b.min.y, maxY: b.max.y, label: m.def.id || 'mount' };
    colliders.push(m.collider);
  }
  function unparkCollider(m) {
    if (!m.collider) return;
    const i = colliders.indexOf(m.collider);
    if (i >= 0) colliders.splice(i, 1);
    m.collider = null;
  }

  for (const m of mounts) {
    loadScaledModel(m.def, ({ root, baseLift }) => {
      m.object = root;
      m.baseLift = baseLift;
      m.ready = true;
      if (m.def.headlight !== false) addVehicleLights(m, m.def);
      placeMountObject(m);
      parkCollider(m);
    });
  }

  function mountUp(m) {
    if (!m || !m.ready || mounted) return;
    mounted = m;
    unparkCollider(m);
    pos.x = m.x; pos.z = m.z;
    yaw = m.yaw; smoothYaw = yaw;
    feetY = supportHeight(m.x, m.z, feetY + 1);
    vy = 0; grounded = true; swimming = false; currentWater = null;
    rideSpeed = 0; rideLean = 0; rideLeanSm = 0;
    CUR_RADIUS = m.def.bodyRadius == null ? 0.6 : m.def.bodyRadius;
    CUR_STEP = m.def.stepHeight == null ? 0.35 : m.def.stepHeight;
    announce(m.def.mountedHint || t('ride.mountedHint', { label: m.def.label || m.def.id }));
  }

  function dismount() {
    const m = mounted;
    if (!m) return;
    mounted = null;
    rideSpeed = 0; rideLean = 0;
    CUR_RADIUS = RADIUS; CUR_STEP = STEP_HEIGHT;
    m.x = pos.x; m.z = pos.z; m.yaw = yaw; m.y = feetY;
    placeMountObject(m);
    parkCollider(m);
    // step off beside the saddle; the collider push-out settles any overlap
    pos.x += Math.cos(yaw) * 1.2;
    pos.z += Math.sin(yaw) * 1.2;
    resolveHorizontal(pos, feetY);
    feetY = supportHeight(pos.x, pos.z, feetY + CUR_STEP);
    announce(m.def.dismountedHint || t('ride.dismounted'));
  }

  // The ride model: throttle/brake along the facing direction with speed-scaled
  // steering — deliberately arcade-simple (a heading + a scalar speed), not a physics
  // sim. Same collision helpers as walking, so a wall stops a bike the same way it
  // stops a person; hitting one scrubs speed instead of letting the bike wall-surf.
  function stepRide(dt) {
    const def = mounted.def;
    const maxF = def.rideSpeed == null ? 11 : def.rideSpeed;
    const maxR = 3;
    const accel = def.accel == null ? 7 : def.accel;
    const brake = def.brake == null ? 14 : def.brake;
    const turnRate = def.turnRate == null ? 1.7 : def.turnRate;

    let steer = 0, throttle = 0;
    if (down('KeyA') || down('ArrowLeft')) steer -= 1;
    if (down('KeyD') || down('ArrowRight')) steer += 1;
    if (down('KeyW') || down('ArrowUp')) throttle += 1;
    if (down('KeyS') || down('ArrowDown')) throttle -= 1;
    if (moveTouch) {
      const dx = moveTouch.curX - moveTouch.startX;
      const dy = moveTouch.curY - moveTouch.startY;
      const dist = Math.hypot(dx, dy);
      if (dist > TOUCH_MOVE_DEADZONE) { throttle += -dy / dist; steer += dx / dist; }
    }
    steer = Math.max(-1, Math.min(1, steer));
    throttle = Math.max(-1, Math.min(1, throttle));

    if (throttle > 0) {
      rideSpeed = Math.min(maxF, rideSpeed + accel * throttle * dt);
    } else if (throttle < 0) {
      if (rideSpeed > 0.05) rideSpeed = Math.max(0, rideSpeed - brake * dt);
      else rideSpeed = Math.max(-maxR, rideSpeed + accel * 0.5 * throttle * dt);
    } else {
      rideSpeed *= Math.exp(-dt / 1.4); // coast
      if (Math.abs(rideSpeed) < 0.02) rideSpeed = 0;
    }
    if (down('ShiftLeft') || down('ShiftRight')) rideSpeed *= Math.exp(-dt / 0.25);

    const sf = Math.min(1, Math.abs(rideSpeed) / (0.22 * maxF));
    if (rideSpeed !== 0 && steer !== 0) yaw += steer * turnRate * sf * dt * (rideSpeed < 0 ? -1 : 1);
    rideLean = reduce ? 0 : -steer * sf * 0.1;

    if (rideSpeed !== 0) {
      forward.set(Math.sin(yaw), 0, -Math.cos(yaw));
      const x0 = pos.x, z0 = pos.z;
      const intended = Math.abs(rideSpeed) * dt;
      pos.addScaledVector(forward, rideSpeed * dt);
      // a bike does not swim: a water volume is a hard edge while mounted
      const w = findWaterAt(pos.x, pos.z);
      if (w && feetY <= w.surfaceY + 0.5) { pos.x = x0; pos.z = z0; rideSpeed *= 0.2; }
      resolveHorizontal(pos, feetY);
      const moved = Math.hypot(pos.x - x0, pos.z - z0);
      if (moved > 1e-6) noteMotion();
      if (moved < intended * 0.5) rideSpeed *= 0.35;
    }

    // vertical: gravity and ground support as on foot, but there is no jump from the saddle
    vy -= GRAVITY * dt;
    if (vy < -MAX_FALL_SPEED) vy = -MAX_FALL_SPEED;
    let newFeetY = feetY + vy * dt;
    newFeetY = capCeiling(newFeetY);
    if (newFeetY < RESPAWN_Y) {
      respawn();
    } else {
      const support = supportHeight(pos.x, pos.z, feetY);
      if (newFeetY <= support) { newFeetY = support; vy = 0; grounded = true; }
      else grounded = false;
      feetY = newFeetY;
    }

    const m = mounted;
    m.x = pos.x; m.z = pos.z; m.yaw = yaw; m.y = feetY;
    if (m.object) {
      // nose ahead of the camera so the front of the bike reads in first person
      const setback = def.cameraSetback == null ? 0.5 : def.cameraSetback;
      m.object.position.set(pos.x + Math.sin(yaw) * setback, feetY + m.baseLift, pos.z - Math.cos(yaw) * setback);
      m.object.rotation.set(0, -yaw + (def.modelYaw || 0), reduce ? 0 : rideLeanSm * 0.7);
      placeVehicleLights(m, pos.x, pos.z, yaw, feetY, true);
    }
  }

  // ---------- companions: a scripted fellow rider on a waypoint route ----------
  // The minimal NPC primitive (stylized/distant per the standing ruling): follows its
  // route, waits when the player falls behind (`leadDistance` rubber-band), no player
  // collision. `rider: true` adds a crude helmeted silhouette — enough to read as a
  // person at night speed, deliberately nothing more.
  const companions = (world.companions || []).map((def) => {
    const route = def.route || [];
    const start = def.position || (route.length ? [route[0][0], 0, route[0][1]] : [0, 0, 0]);
    return { def, object: null, baseLift: 0, ready: false, x: start[0], z: start[2] == null ? start[1] : start[2], yaw: def.yaw || 0, speed: 0, wpIndex: 0 };
  });

  function addRiderSilhouette(root, rawBox, scaleApplied, def) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: 0.7, metalness: 0.2 });
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.62, 0.46), mat);
    torso.position.y = 0.32;
    torso.rotation.x = 0.45; // forward lean over the tank
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), mat);
    helmet.position.set(0, 0.66, -0.16);
    g.add(torso, helmet);
    // children inherit the root's unit-fixing scale; invert it so the rider is sized in
    // metres, and seat them at the model's own centre, ~62% of its height
    g.scale.setScalar(1 / scaleApplied);
    const c = rawBox.getCenter(new THREE.Vector3());
    g.position.set(c.x, rawBox.min.y + (rawBox.max.y - rawBox.min.y) * 0.62, c.z);
    g.rotation.y = def.riderYaw || 0;
    root.add(g);
  }

  for (const c of companions) {
    loadScaledModel(c.def, ({ root, baseLift, rawBox, scaleApplied }) => {
      if (c.def.rider) addRiderSilhouette(root, rawBox, scaleApplied, c.def);
      c.object = root;
      c.baseLift = baseLift;
      c.ready = true;
      if (c.def.headlight !== false) addVehicleLights(c, c.def);
      root.position.set(c.x, supportHeight(c.x, c.z, 1) + baseLift, c.z);
      root.rotation.y = -c.yaw + (c.def.modelYaw || 0);
      placeVehicleLights(c, c.x, c.z, c.yaw, supportHeight(c.x, c.z, 1), true);
    });
  }

  function updateCompanions(dt) {
    for (const c of companions) {
      if (!c.ready) continue;
      const route = c.def.route || [];
      if (!route.length) continue;
      const wp = route[c.wpIndex % route.length];
      const dx = wp[0] - c.x, dz = wp[1] - c.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.5) {
        if (c.wpIndex + 1 >= route.length && c.def.loop === false) { c.speed = 0; continue; }
        c.wpIndex = (c.wpIndex + 1) % route.length;
        continue;
      }
      const toPlayer = Math.hypot(pos.x - c.x, pos.z - c.z);
      const lead = c.def.leadDistance == null ? 25 : c.def.leadDistance;
      const maxV = c.def.speed == null ? 9 : c.def.speed;
      const want = toPlayer > lead ? 0 : maxV;
      c.speed += (want - c.speed) * (1 - Math.exp(-dt / 0.7));
      if (c.speed > 0.01) {
        const targetYaw = Math.atan2(dx, -dz);
        let dyaw = targetYaw - c.yaw;
        while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
        while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
        c.yaw += dyaw * Math.min(1, dt * 3.2);
        c.x += Math.sin(c.yaw) * c.speed * dt;
        c.z += -Math.cos(c.yaw) * c.speed * dt;
        if (c.object) {
          const feet = supportHeight(c.x, c.z, 1);
          c.object.position.set(c.x, feet + c.baseLift, c.z);
          c.object.rotation.set(0, -c.yaw + (c.def.modelYaw || 0), reduce ? 0 : -dyaw * 0.35);
          placeVehicleLights(c, c.x, c.z, c.yaw, feet, true);
        }
      }
    }
  }

  // ---------- patrol route: ordered checkpoints, a beacon, non-blocking radio text ----------
  // Unlike trigger zones (unordered, modal), a route is a sequence: only the CURRENT
  // checkpoint is live, a beacon marks it, reaching it plays its text as a passing
  // radio line (never an input-locking overlay — the player is riding), and finishing
  // the list fires the same trigger union zones use (prose/cutscene/link).
  const routeDef = world.route || null;
  const routeState = { idx: 0, done: false, total: routeDef ? (routeDef.checkpoints || []).length : 0 };
  const routeHud = document.getElementById('route-hud');
  const radioEl = document.getElementById('radio');
  let radioTimer = 0;
  let beacon = null, beaconMat = null;

  function radioToast(text) {
    if (!radioEl || !text) return;
    radioEl.textContent = text;
    radioEl.classList.remove('hidden');
    clearTimeout(radioTimer);
    radioTimer = setTimeout(() => radioEl.classList.add('hidden'), 7000);
  }

  function makeBeacon() {
    beaconMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const plane = new THREE.PlaneGeometry(1.7, 7);
    const g = new THREE.Group();
    const a = new THREE.Mesh(plane, beaconMat); a.position.y = 3.5;
    const b = new THREE.Mesh(plane, beaconMat); b.position.y = 3.5; b.rotation.y = Math.PI / 2;
    g.add(a, b);
    scene.add(g);
    return g;
  }

  function updateRouteHud() {
    if (!routeHud) return;
    if (!routeDef) { routeHud.classList.add('hidden'); return; }
    routeHud.classList.remove('hidden');
    if (routeState.done) {
      routeHud.textContent = routeDef.completeHud || t('route.complete', { label: routeDef.label || t('route.route') });
      return;
    }
    const cp = routeDef.checkpoints[routeState.idx];
    routeHud.textContent = t('route.hud', { label: routeDef.label || t('route.route'), n: routeState.idx + 1, total: routeState.total, cp: cp.label || '' }).trim();
  }

  function placeBeacon() {
    if (!routeDef) return;
    updateRouteHud();
    if (routeState.done || routeState.idx >= routeState.total) { if (beacon) beacon.visible = false; return; }
    if (!beacon) beacon = makeBeacon();
    const cp = routeDef.checkpoints[routeState.idx];
    const p = resolveTriggerPosition(cp);
    // a checkpoint may restyle its own marker — a DESTINATION wants to read differently
    // from a waypoint (bigger, its own color) without the engine knowing what it means
    beaconMat.color.set(cp.beaconColor || routeDef.beaconColor || (world.palette && world.palette.accent) || '#66d9ff');
    const s = cp.beaconScale == null ? 1 : cp.beaconScale;
    beacon.scale.set(s, s, s);
    beacon.position.set(p[0], p[1] || 0, p[2]);
    beacon.visible = true;
  }

  function updateRoute() {
    if (!routeDef || routeState.done) return;
    const cp = routeDef.checkpoints[routeState.idx];
    const p = resolveTriggerPosition(cp);
    const r = cp.radius == null ? 6 : cp.radius;
    const dx = pos.x - p[0], dz = pos.z - p[2];
    if (dx * dx + dz * dz > r * r) return;
    announce(`${cp.label || t('route.checkpoint')}. ${cp.srHint || ''}`.trim());
    if (cp.text) radioToast(cp.text);
    routeState.idx++;
    if (routeState.idx >= routeState.total) {
      routeState.done = true;
      const t = routeDef.onComplete;
      if (t) {
        if (t.type === 'prose') openProse(t.text || '');
        else if (t.type === 'cutscene') playCutscene(t.cutsceneId);
        else if (t.type === 'link') travelTo(t.toWorld, t.spawn, base);
      }
    }
    placeBeacon();
  }

  function fire(z) {
    const trig = z.def.trigger || {};
    z.fired = true;
    z.armed = false; // auto zones re-arm only when the player leaves (and not if `once`)
    if (trig.type === 'prose') openProse(trig.text || '');
    else if (trig.type === 'cutscene') playCutscene(trig.cutsceneId);
    else if (trig.type === 'link') {
      if (!trig.toWorld) { announce(t('linkMissingDestination', { label: z.def.label })); return; }
      travelTo(trig.toWorld, trig.spawn, base);
    } else announce(t('nothingWired', { label: z.def.label }));
  }

  // tap-to-activate: the prompt pill IS the touch equivalent of "press E" (css/walk.css
  // gives it pointer-events + a touch-friendly hit target; it stays aria-hidden since the
  // sr-only live-region announcement above already carries this to assistive tech)
  promptEl.addEventListener('click', () => interact(), { signal });

  function interact() {
    if (mounted) { dismount(); return; }
    if (nearMount) { mountUp(nearMount); return; }
    if (!activeZone) return;
    if (activeZone.def.once && activeZone.fired) {
      announce(t('nothingMoreHere', { label: activeZone.def.label }));
      return;
    }
    fire(activeZone);
  }

  const PRELOAD_MARGIN = 10; // metres of approach outside the zone itself

  function updateZones() {
    let prompted = null;
    for (const z of zones) {
      const now = zoneContains(z, pos.x, pos.z);
      if (now && !z.inside) {
        z.inside = true;
        announce(`${z.def.label}. ${z.def.srHint || ''}`.trim());
        if (z.def.mode === 'auto' && z.armed) fire(z);
      } else if (!now && z.inside) {
        z.inside = false;
        // a zone re-arms on exit unless it is a spent `once` zone. Written this way (and
        // not "if (!once) armed = true") so a zone disarmed purely because the player
        // spawned inside it still comes back to life the first time they walk out.
        if (!(z.def.once && z.fired)) z.armed = true;
        z.spawnSuppressed = false;
      }
      if (z.inside && z.def.mode !== 'auto') prompted = z;

      // link-adjacent preload: warm the target pack while the player is still walking up
      const trig = z.def.trigger;
      if (trig && trig.type === 'link' && trig.toWorld && !z.preloadStarted) {
        const p = z.pos;
        const reach = (z.def.shape === 'box' ? Math.max(...(z.def.bounds || [2, 2, 2])) / 2 : (z.def.radius == null ? 2 : z.def.radius)) + PRELOAD_MARGIN;
        const dx = pos.x - p[0], dz = pos.z - p[2];
        if (dx * dx + dz * dz <= reach * reach) {
          z.preloadStarted = true;
          preloadWorld(resolveWorldPath(trig.toWorld, base));
        }
      }
    }
    activeZone = prompted;
    // the ride prompt outranks zone prompts; while mounted the only prompt is the
    // dismount hint, and only once the bike is close to stopped
    nearMount = null;
    if (!mounted) {
      for (const m of mounts) {
        if (!m.ready) continue;
        const reach = m.def.reach == null ? 2.4 : m.def.reach;
        const dx = pos.x - m.x, dz = pos.z - m.z;
        if (dx * dx + dz * dz <= reach * reach) { nearMount = m; break; }
      }
    }

    if (mounted) {
      if (Math.abs(rideSpeed) < 1.2) {
        promptEl.textContent = mounted.def.dismountPrompt || t('ride.dismountPrompt');
        promptEl.classList.remove('hidden');
      } else {
        promptEl.classList.add('hidden');
        promptEl.textContent = '';
      }
    } else if (nearMount) {
      promptEl.textContent = nearMount.def.prompt || t('ride.prompt');
      promptEl.classList.remove('hidden');
    } else if (prompted && !(prompted.def.once && prompted.fired)) {
      promptEl.textContent = prompted.def.prompt || t('pressE');
      promptEl.classList.remove('hidden');
    } else {
      promptEl.classList.add('hidden');
      promptEl.textContent = '';
    }
  }

  // ---------- debug/verification handle (no gameplay effect) ----------
  const api = {
    scene, // headless verification: lets a harness inspect/toggle scene objects
    manifest: world,
    worldPath,
    spawnId: activeSpawnId,
    // carried, never interpreted — same contract as scene.json's worldTexture
    worldTexture: world.worldTexture || [],
    reduceMotion: reduce,
    post: post.params,
    colliders,
    bounds,
    waterVolumes,
    fps: 0,
    latency,
    // style-pack surface, for verification: which optional blocks this pack used, and
    // whether its glTF props actually landed
    atmosphere: built.atmosphere,
    props: built.props,
    propsReady: built.propsReady,
    get propsPending() { return built.propsPending; },
    loadWarnings,
    get tier() { return perf.tier; },
    get tierMode() { return perf.mode; },
    get quality() {
      return {
        tier: perf.tier,
        pixelRatio: rend.getPixelRatio(),
        bloom: post.params.bloom,
        samples: post.params.samples,
        reflections: built.reflectionsOn,
        fog: built.fogMode,
        postEnabled: post.params.enabled
      };
    },
    get state() {
      return {
        x: +pos.x.toFixed(3), z: +pos.z.toFixed(3), yaw: +yaw.toFixed(4), pitch: +pitch.toFixed(4),
        // the RENDERED camera, so the reduced-motion branch is measurable and not
        // merely asserted: with reduce, cameraY === eyeHeight and cameraYaw === yaw
        eyeHeight: EYE,
        feetY: +feetY.toFixed(4),
        vy: +vy.toFixed(4),
        grounded,
        swimming,
        currentWaterId: currentWater ? currentWater.id : null,
        cameraY: +camera.position.y.toFixed(5),
        cameraYaw: +(-camera.rotation.y).toFixed(5),
        cameraRoll: +camera.rotation.z.toFixed(5),
        propsLoaded: built.props.length,
        colliderCount: colliders.length,
        frameCount,
        promptVisible: !promptEl.classList.contains('hidden'),
        promptText: promptEl.textContent,
        activeZone: activeZone ? activeZone.def.id : null,
        mounted: mounted ? mounted.def.id : null,
        nearMount: nearMount ? nearMount.def.id : null,
        rideSpeed: +rideSpeed.toFixed(3),
        sprinting,
        touchJumpHeld,
        mountsLoaded: mounts.filter((m) => m.ready).length,
        companionsLoaded: companions.filter((c) => c.ready).length,
        companions: companions.map((c) => ({ id: c.def.id, x: +c.x.toFixed(2), z: +c.z.toFixed(2), speed: +c.speed.toFixed(2), wpIndex: c.wpIndex })),
        routeIndex: routeState.idx,
        routeDone: routeState.done,
        routeHudText: routeHud ? routeHud.textContent : '',
        radioVisible: !!(radioEl && !radioEl.classList.contains('hidden')),
        radioText: radioEl ? radioEl.textContent : '',
        cutsceneOpen: !cutsceneOverlay.classList.contains('hidden'),
        cutsceneSrc: cutsceneVideo.getAttribute('src'),
        proseOpen: !proseOverlay.classList.contains('hidden'),
        inputLocked,
        moveTouchActive: !!moveTouch,
        lookTouchActive: !!lookTouch,
        zones: zones.map((z) => ({ id: z.def.id, inside: z.inside, fired: z.fired, armed: z.armed, spawnSuppressed: z.spawnSuppressed }))
      };
    },
    // verification aids for the mount slice — same contract as debugTeleport
    debugMount(id) {
      const m = mounts.find((mm) => mm.def.id === id) || mounts[0];
      if (mounted) dismount();
      mountUp(m);
      return !!mounted;
    },
    debugDismount() { dismount(); },
    debugSetRideSpeed(v) { if (mounted) rideSpeed = v; },
    // screenshot/debug aid only — moves the camera, changes nothing else
    debugTeleport(x, z, y, p, y0) {
      pos.set(x, 0, z);
      feetY = y0 == null ? supportHeight(x, z) : y0;
      vy = 0; grounded = true;
      const w = findWaterAt(pos.x, pos.z);
      swimming = !!(w && feetY < w.surfaceY);
      currentWater = swimming ? w : null;
      resolveHorizontal(pos, feetY);
      if (y != null) { yaw = y; smoothYaw = y; }
      if (p != null) { pitch = p; smoothPitch = p; }
      for (const zn of zones) zn.inside = zoneContains(zn, pos.x, pos.z);
    }
  };
  window.__bookworld = api;

  // ---------- fps ----------
  const fpsEl = document.getElementById('fps-readout');
  if (showFps) fpsEl.classList.remove('hidden');
  let fpsFrames = 0, fpsSince = performance.now(), fps = 0;

  // ---------- loop ----------
  const clock = new THREE.Clock();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const step = new THREE.Vector3();
  let swimBobPhase = 0, swimBobY = 0;

  // Physics runs in fixed-ceiling substeps. The old single step was clamped to 50 ms,
  // which silently HALVED walking speed at 10 fps — the player pressed W, the world
  // crawled, and it read as input lag. Substepping keeps the distance travelled per
  // second identical at every framerate while still bounding the per-step displacement
  // so nothing tunnels through a thin door panel.
  //
  // The substep BUDGET (16 x 33 ms = 0.53 s) is the real framerate floor: below ~2 fps
  // the world starts moving in slow motion again. It is set that low deliberately —
  // a software-rasteriser run here walks at 2.8 fps, and picking 8 substeps first cost a
  // measurable 25% of walking speed at exactly that framerate. The clamp's actual job is
  // the backgrounded tab, and that case is handled properly below by discarding the
  // accumulated delta on visibilitychange rather than by starving normal frames.
  const MAX_SUBSTEP = 1 / 30;
  const MAX_SUBSTEPS = 16;

  let rafId = 0;
  let fogIsWater = false;
  let fogNeedsReset = true; // a tier change rebuilds the fog object; re-push the values
  let resolveFirstFrame;
  const firstFrame = new Promise((r) => { resolveFirstFrame = r; });

  function stepPlayer(dt) {
    // mounted is a third movement mode beside walking and swimming: it swaps what the
    // keys mean, keeps gravity, and redefines what the body is (radius/step) — the seam
    // the locomotion slice left for exactly this (BookWorld-898 FINDINGS)
    if (mounted) { stepRide(dt); return; }

    // keyboard turning / pitching — the mouse-free path
    if (down('ArrowLeft')) yaw -= TURN * dt;
    if (down('ArrowRight')) yaw += TURN * dt;
    if (down('KeyR')) pitch = Math.min(1.1, pitch + TURN * 0.55 * dt);
    if (down('KeyF')) pitch = Math.max(-1.1, pitch - TURN * 0.55 * dt);

    let fwd = 0, strafe = 0;
    if (down('KeyW') || down('ArrowUp')) fwd += 1;
    if (down('KeyS') || down('ArrowDown')) fwd -= 1;
    if (down('KeyA')) strafe -= 1;
    if (down('KeyD')) strafe += 1;

    // left-half touch drag: a direction vector from the drag origin, same shape as the
    // keyboard's fwd/strafe (added together, then clamped — either input alone or both
    // at once behave the same as keyboard-only did)
    if (moveTouch) {
      const dx = moveTouch.curX - moveTouch.startX;
      const dy = moveTouch.curY - moveTouch.startY;
      const dist = Math.hypot(dx, dy);
      if (dist > TOUCH_MOVE_DEADZONE) {
        fwd += -dy / dist;
        strafe += dx / dist;
      }
      // Minecraft-PE-style touch sprint: push the move finger well past walking range,
      // forward-dominant. Releasing the drag drops back to a walk.
      touchSprint = dist > 130 && -dy > Math.abs(dx);
    } else {
      touchSprint = false;
    }
    fwd = Math.max(-1, Math.min(1, fwd));
    strafe = Math.max(-1, Math.min(1, strafe));

    const jumpKey = down('Space') || down('KeyJ') || touchJumpHeld;
    const sinkKey = down('ShiftLeft') || down('ShiftRight');
    const sprintKey = down('ControlLeft') || down('ControlRight') || sprintLatch || touchSprint;
    sprinting = !swimming && sprintKey && fwd > 0.1;

    // ---------- horizontal movement ----------
    if (fwd || strafe) {
      forward.set(Math.sin(yaw), 0, -Math.cos(yaw));
      right.set(Math.cos(yaw), 0, Math.sin(yaw));
      step.set(0, 0, 0).addScaledVector(forward, fwd).addScaledVector(right, strafe);
      if (step.lengthSq() > 0) step.normalize();
      // Shift slows walking on land; underwater it's repurposed as "sink" instead
      const slow = !swimming && sinkKey ? 0.45 : 1;
      const baseSpeed = swimming ? SWIM_SPEED : (sprinting ? RUN_SPEED : SPEED);
      const dist = baseSpeed * slow * dt;
      const x0 = pos.x, z0 = pos.z;
      pos.addScaledVector(step, dist);
      resolveHorizontal(pos, feetY);
      if (pos.x !== x0 || pos.z !== z0) noteMotion();
      if (!reduce && !swimming) bobPhase += dist * 2.6;
    } else if (!reduce && !swimming) {
      bobPhase += dt * 0.6;
    }

    // ---------- vertical physics ----------
    const waterHere = findWaterAt(pos.x, pos.z);
    if (swimming) {
      // still swimming only while inside the same volume's XZ footprint and below its surface
      if (!waterHere || feetY >= waterHere.surfaceY + 0.05) {
        swimming = false; currentWater = null; vy = Math.min(vy, 0);
      }
    } else if (waterHere && feetY < waterHere.surfaceY && !grounded) {
      // falling into a water volume from above transitions to swim mode
      swimming = true; currentWater = waterHere; vy = Math.min(vy, -0.5);
    }

    if (swimming) {
      if (jumpKey) vy = SWIM_RISE_SPEED;
      else if (sinkKey) vy = -SWIM_SINK_SPEED;
      else vy *= Math.pow(SWIM_DAMPING, dt * 60);
      let newFeetY = feetY + vy * dt;
      newFeetY = Math.max(currentWater.floorY, Math.min(currentWater.surfaceY, newFeetY));
      if (newFeetY !== feetY) noteMotion();
      feetY = newFeetY;
      grounded = feetY <= currentWater.floorY + 1e-6;
      if (!reduce) { swimBobPhase += dt * 1.6; swimBobY = Math.sin(swimBobPhase) * 0.03; }
      else swimBobY = 0;
    } else {
      vy -= GRAVITY * dt;
      if (vy < -MAX_FALL_SPEED) vy = -MAX_FALL_SPEED;
      if (jumpKey && grounded) { vy = JUMP_VELOCITY; noteMotion(); }
      let newFeetY = feetY + vy * dt;
      newFeetY = capCeiling(newFeetY);
      // the kill-floor check runs on the RAW integrated height, before the ground/step
      // snap below — open ground is unconditionally supported at 0, so once a landing
      // clamp has run there is no longer a "how far below the map" signal left to catch
      if (newFeetY < RESPAWN_Y) {
        respawn();
      } else {
        const support = supportHeight(pos.x, pos.z, feetY);
        if (newFeetY <= support) { newFeetY = support; vy = 0; grounded = true; }
        else { grounded = false; }
        feetY = newFeetY;
      }
      swimBobY = 0;
    }
  }

  function frame() {
    rafId = requestAnimationFrame(frame);
    frameCount++;
    // dt is NOT clamped down to a movement-eating ceiling any more; it is split into
    // substeps instead (see MAX_SUBSTEP). The 0.26 s outer clamp is the "the tab was
    // backgrounded / the machine froze" guard, where standing still is the right answer.
    const raw = clock.getDelta();
    const dt = Math.min(raw, MAX_SUBSTEP * MAX_SUBSTEPS);
    const t = clock.elapsedTime;
    // the tier decision uses the WALL-CLOCK frame interval, not this callback's CPU time:
    // a GPU-bound machine has a cheap callback and a slow screen, and it is the screen the
    // hand feels
    if (frameCount > 1) notePerfFrame(raw * 1000);

    if (!inputLocked) {
      const steps = Math.max(1, Math.min(MAX_SUBSTEPS, Math.ceil(dt / MAX_SUBSTEP)));
      const sub = dt / steps;
      for (let i = 0; i < steps; i++) stepPlayer(sub);
      updateZones();
      updateRoute();
      updateCompanions(dt);
    }
    for (const k in edge) edge[k] = false;

    // camera damping + head-bob: both are motion effects, both off under
    // prefers-reduced-motion (the view then tracks input exactly). Swim bob follows
    // the same reduced-motion gate (see swimBobY above — it's forced to 0 there).
    // Every smoothing term below is an exponential with a time CONSTANT in seconds, so
    // the feel is identical at 12 fps and 144 fps; a naive `x += (target-x) * dt * k`
    // lerp is framerate-dependent and was the second half of the old-laptop lag.
    if (reduce) {
      smoothYaw = yaw; smoothPitch = pitch; bobY = 0; bobRoll = 0; rideLeanSm = 0;
    } else {
      const k = 1 - Math.exp(-dt / 0.035); // frame-rate independent, ~35ms time constant
      smoothYaw += (yaw - smoothYaw) * k;
      smoothPitch += (pitch - smoothPitch) * k;
      const moving = !inputLocked && !swimming && !mounted && (down('KeyW') || down('KeyS') || down('KeyA') || down('KeyD') || down('ArrowUp') || down('ArrowDown'));
      const targetBob = moving ? Math.sin(bobPhase) * 0.042 : 0;
      const targetRoll = moving ? Math.sin(bobPhase * 0.5) * 0.007 : 0;
      const kb = 1 - Math.exp(-dt / 0.11); // ~110ms time constant, was a dt*9 lerp
      bobY += (targetBob - bobY) * kb;
      bobRoll += (targetRoll - bobRoll) * kb;
      rideLeanSm += (rideLean - rideLeanSm) * kb;
    }

    const eyeNow = mounted ? (mounted.def.eyeHeight == null ? 1.45 : mounted.def.eyeHeight) : EYE;
    camera.position.set(pos.x, feetY + eyeNow + (mounted ? 0 : bobY + swimBobY), pos.z);
    camera.rotation.set(smoothPitch, -smoothYaw, mounted ? rideLeanSm : bobRoll);

    if (beaconMat && !reduce && beacon && beacon.visible) beaconMat.opacity = 0.24 + 0.1 * Math.sin(t * 2.2);

    // underwater tint/fog: swap the scene fog toward the water volume's tint while the
    // camera itself is below the surface, restore vanilla fog once it surfaces. Routed
    // through the pack builder because the LOW tier swaps FogExp2 for linear Fog and the
    // controller must not care which one is live.
    const wantWaterFog = !!(swimming && currentWater && camera.position.y < currentWater.surfaceY);
    if (wantWaterFog) {
      built.setFog(currentWater.tint, currentWater.fogDensity);
      fogIsWater = true;
    } else if (fogIsWater || fogNeedsReset) {
      built.setFog(baseFogColor, baseFogDensity);
      fogIsWater = false;
      fogNeedsReset = false;
    }

    built.update(t, camera, rend);
    post.render(t);

    if (frameCount === 1 && resolveFirstFrame) { resolveFirstFrame(); resolveFirstFrame = null; }

    fpsFrames++;
    const now = performance.now();
    if (now - fpsSince >= 500) {
      fps = (fpsFrames * 1000) / (now - fpsSince);
      fpsFrames = 0; fpsSince = now;
      if (showFps) fpsEl.textContent = `${fps.toFixed(1)} fps · ${perf.tier}`;
      api.fps = fps;
    }
  }
  placeBeacon();
  frame();

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    rend.setSize(innerWidth, innerHeight);
    post.setSize(innerWidth, innerHeight, tierNow.pixelRatio);
  }, { signal });

  announce(t('ready', { description: world.description || '' }));

  // ---------- teardown ----------
  // A world link is a full unload: the loop stops, every listener this world installed is
  // revoked in one shot (AbortController), the overlays are reset, and the GPU resources
  // this build owns are released. The renderer, canvas and tier state survive — creating a
  // second WebGL context per door would run a browser out of contexts in about six rooms.
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(rafId);
    listeners.abort();
    if (touchHelpLi && touchHelpLi.parentNode) touchHelpLi.parentNode.removeChild(touchHelpLi);
    if (rideHelpLi && rideHelpLi.parentNode) rideHelpLi.parentNode.removeChild(rideHelpLi);
    cutsceneVideo.pause();
    cutsceneVideo.removeAttribute('src');
    cutsceneOverlay.classList.add('hidden');
    proseOverlay.classList.add('hidden');
    promptEl.classList.add('hidden');
    promptEl.textContent = '';
    clearTimeout(radioTimer);
    if (radioEl) { radioEl.classList.add('hidden'); radioEl.textContent = ''; }
    if (routeHud) { routeHud.classList.add('hidden'); routeHud.textContent = ''; }
    inputLocked = false;
    post.dispose();
    built.dispose();
    if (window.__bookworld === api) window.__bookworld = null;
  }

  return {
    api,
    destroy,
    firstFrame,
    propsReady: built.propsReady,
    applyTier,
    suspend: suspendWalk
  };
}

async function boot() {
  await loadChromeStrings(lang);
  localizeStaticChrome();
  updateFsButton();
  updateTierButton();
  try {
    await loadWorld(startWorldPath, startSpawnId, 'boot');
  } catch (err) {
    showLoadError(err.message);
  }
}
boot();
