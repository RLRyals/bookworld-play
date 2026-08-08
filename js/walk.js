// BookWorld — walkable slice, geometry-as-data.
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
//   walk.html                            -> worlds/world-a/world.json (default)
//   walk.html?world=worlds/world-b/world.json  -> a differently-shaped pack
//   walk.html?fps=1                      -> on-screen fps readout
//   walk.html?post=0                     -> bypass the post stack (debugging)
import * as THREE from 'three';
import { buildWorld } from './geometry.js';
import { createPost } from './post.js';

const params = new URLSearchParams(location.search);
const manifestPath = params.get('world') || 'worlds/world-a/world.json';
const postEnabled = params.get('post') !== '0';
const showFps = params.get('fps') === '1';

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

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

function init(world, base) {
  document.title = world.title || 'BookWorld';
  const loadWarnings = []; // non-fatal pack-asset failures (a texture/prop/sky that 404s)

  // ---------- a11y: description + zone inventory, both manifest-driven ----------
  document.getElementById('scene-description').textContent = world.description || '';
  const zoneList = document.getElementById('zone-list');
  zoneList.innerHTML = '';
  (world.triggers || []).forEach((t) => {
    const li = document.createElement('li');
    const how = t.mode === 'auto' ? 'happens on its own when you walk in' : 'press E when you are inside it';
    li.textContent = `${t.label}: ${t.srHint || ''} (${how})`.replace(/\s+/g, ' ').trim();
    zoneList.appendChild(li);
  });
  const status = document.getElementById('walk-status');
  function announce(msg) { status.textContent = msg; }

  // touch is additive to keyboard+mouse (feature-detect, never a mode switch), but a
  // first-time phone visitor still needs to be told the gestures exist
  if (matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0) {
    const li = document.createElement('li');
    li.innerHTML = '<b>Touch</b>: drag the left half to walk &middot; drag the right half to look &middot; tap the glowing prompt to interact';
    document.querySelector('#walk-help ul').appendChild(li);
  }

  // ---------- renderer ----------
  const canvas = document.getElementById('bg');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !postEnabled, powerPreference: 'high-performance' });
  const pixelRatio = Math.min(devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  if (postEnabled) {
    // the composite pass does ACES + sRGB encode itself
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  } else {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.08, 220);
  camera.rotation.order = 'YXZ';

  // ---------- the block ----------
  // `base` is the pack folder — every style-pack file reference (texture images, skybox
  // panorama, glTF props) resolves against it, so a pack stays self-contained.
  const built = buildWorld(scene, world, reduce, {
    base,
    warn: (msg) => { console.warn('[bookworld] ' + msg); loadWarnings.push(msg); }
  });
  const colliders = built.colliders;
  const bounds = built.bounds;
  const waterVolumes = built.waterVolumes || [];
  const baseFogColor = scene.fog ? scene.fog.color.clone() : null;
  const baseFogDensity = scene.fog ? scene.fog.density : 0;

  const post = createPost(renderer, scene, camera, built.atmosphere);
  post.params.enabled = postEnabled;
  post.setSize(innerWidth, innerHeight, pixelRatio);

  // ---------- player state (spawn is manifest data) ----------
  const spawn = world.spawn || {};
  const playerCfg = world.player || {};
  const EYE = playerCfg.eyeHeight == null ? 1.65 : playerCfg.eyeHeight;
  const SPEED = playerCfg.walkSpeed == null ? 2.8 : playerCfg.walkSpeed;
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
  const SWIM_DAMPING = 0.9; // per-frame-independent velocity decay while swimming, no input
  const respawnCfg = world.respawn || {};
  const RESPAWN_Y = respawnCfg.fallY == null ? -25 : respawnCfg.fallY;

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
      if (x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && c.maxY <= ref + STEP_HEIGHT + 1e-6) {
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
    if (delta <= STEP_HEIGHT + 1e-6) return false; // step-up, not a wall
    if (currentFeetY >= c.maxY - 1e-6) return false; // already above the top
    return true;
  }

  // ---------- collision: circle vs axis-aligned rectangles, then hard bounds ----------
  function resolveHorizontal(p, currentFeetY) {
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < colliders.length; i++) {
        const c = colliders[i];
        if (!isWall(c, currentFeetY)) continue;
        const minX = c.minX - RADIUS, maxX = c.maxX + RADIUS;
        const minZ = c.minZ - RADIUS, maxZ = c.maxZ + RADIUS;
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
    announce('You fell out of the world. Back at the start.');
  }

  resolveHorizontal(pos, feetY);

  // ---------- input ----------
  const keys = Object.create(null);
  let inputLocked = false;
  const helpPanel = document.getElementById('walk-help');

  const MOVE_KEYS = {
    KeyW: 1, KeyS: 1, KeyA: 1, KeyD: 1,
    ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1,
    KeyR: 1, KeyF: 1,
    Space: 1, KeyJ: 1 // jump (grounded) / rise (swimming) — Space is primary, J the keyboard-only alternative
  };

  function clearKeys() { for (const k in keys) keys[k] = false; }

  // ---------- touch: left-half drag = move, right-half drag = look, coexists with
  // keyboard+mouse (feature-detect only, never a mode switch — both paths stay live
  // and just add together in the frame loop below). No pinch/zoom handling: touch-action
  // none on the canvas (css/walk.css) already suppresses that gesture entirely.
  const isCoarsePointer = matchMedia('(pointer: coarse)').matches;
  let moveTouch = null; // { id, startX, startY, curX, curY }
  let lookTouch = null; // { id, lastX, lastY }
  const TOUCH_LOOK_SENSITIVITY = 0.0035;
  const TOUCH_MOVE_DEADZONE = 10; // px, before a left-half drag counts as a direction

  function clearTouches() { moveTouch = null; lookTouch = null; }

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
  }, { passive: false });

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
  }, { passive: false });

  function releaseTouches(e) {
    for (const touch of e.changedTouches) {
      if (moveTouch && touch.identifier === moveTouch.id) moveTouch = null;
      if (lookTouch && touch.identifier === lookTouch.id) lookTouch = null;
    }
  }
  canvas.addEventListener('touchend', releaseTouches);
  canvas.addEventListener('touchcancel', releaseTouches);

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return; // handled by the overlays / pointer lock
    if (inputLocked) return;
    if (e.code === 'KeyH') { helpPanel.classList.toggle('hidden'); e.preventDefault(); return; }
    if (e.code === 'Home') { pitch = 0; e.preventDefault(); return; }
    if (e.code === 'KeyE') { interact(); e.preventDefault(); return; }
    if (e.code in MOVE_KEYS || e.code === 'ShiftLeft' || e.code === 'ShiftRight') e.preventDefault();
    keys[e.code] = true;
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  addEventListener('blur', () => { clearKeys(); clearTouches(); });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== canvas) clearKeys();
  });

  // mouse-look via pointer lock (optional — the keyboard/touch paths are complete without
  // it; skipped on coarse pointers, where pointer lock is either unsupported or meaningless)
  canvas.addEventListener('click', () => {
    if (inputLocked || isCoarsePointer) return;
    if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
  });
  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas || inputLocked) return;
    yaw += e.movementX * 0.0022;
    pitch = Math.max(-1.1, Math.min(1.1, pitch - e.movementY * 0.0022));
  });

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
    announce('Back where you left off.');
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
  proseClose.addEventListener('click', closeProse);

  const cutscenesById = {};
  (world.cutscenes || []).forEach((c) => { cutscenesById[c.id] = c; });

  function playCutscene(cutsceneId) {
    const c = cutscenesById[cutsceneId];
    if (!c) { announce('That cutscene is missing from the manifest.'); return; }
    suspendWalk();
    cutsceneVideo.src = base + c.video;
    if (c.poster) cutsceneVideo.poster = base + c.poster;
    cutsceneOverlay.classList.remove('hidden');
    cutsceneOverlay.setAttribute('aria-label', c.title ? `Cutscene: ${c.title}` : 'Cutscene');
    try { cutsceneVideo.currentTime = 0; } catch (_) { /* not seekable yet */ }
    cutsceneVideo.play().catch(() => {});
    cutsceneClose.focus();
    announce(`Cutscene playing: ${c.title || c.id}. Press Escape to return.`);
  }
  function closeCutscene() {
    if (cutsceneOverlay.classList.contains('hidden')) return;
    cutsceneVideo.pause();
    cutsceneOverlay.classList.add('hidden');
    resumeWalk();
  }
  cutsceneVideo.addEventListener('ended', closeCutscene);
  cutsceneVideo.addEventListener('error', () => {
    announce('The cutscene video failed to load. Returning to the street.');
    closeCutscene();
  });
  cutsceneClose.addEventListener('click', closeCutscene);
  cutsceneOverlay.addEventListener('click', (e) => { if (e.target === cutsceneOverlay) closeCutscene(); });

  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!cutsceneOverlay.classList.contains('hidden')) { closeCutscene(); e.preventDefault(); }
    else if (!proseOverlay.classList.contains('hidden')) { closeProse(); e.preventDefault(); }
  });

  // ---------- trigger zones (all manifest data) ----------
  // A zone anchors to a geometry element id (closing the FINDINGS gap from BookWorld-5jx:
  // "nothing ties alley-door to the door mesh") instead of, or in addition to, a bare
  // world coordinate. `anchor` + optional `offset` resolves to the element's own position;
  // a bare `position` stays legal for zones with no natural geometry (open street).
  function resolveTriggerPosition(t) {
    if (t.anchor) {
      const el = built.elementsById[t.anchor];
      if (!el) throw new Error(`Trigger "${t.id}" anchors to unknown geometry id "${t.anchor}"`);
      const off = t.offset || [0, 0, 0];
      return [el.position[0] + off[0], el.position[1] + off[1], el.position[2] + off[2]];
    }
    return t.position || [0, 0, 0];
  }

  const promptEl = document.getElementById('prompt');
  const zones = (world.triggers || []).map((t) => ({
    def: t,
    pos: resolveTriggerPosition(t),
    inside: false,
    armed: true,
    fired: false
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

  function fire(z) {
    const t = z.def.trigger || {};
    z.fired = true;
    z.armed = false; // auto zones re-arm only when the player leaves (and not if `once`)
    if (t.type === 'prose') openProse(t.text || '');
    else if (t.type === 'cutscene') playCutscene(t.cutsceneId);
    else announce(`Nothing is wired to ${z.def.label}.`);
  }

  // tap-to-activate: the prompt pill IS the touch equivalent of "press E" (css/walk.css
  // gives it pointer-events + a touch-friendly hit target; it stays aria-hidden since the
  // sr-only live-region announcement above already carries this to assistive tech)
  promptEl.addEventListener('click', () => interact());

  function interact() {
    if (!activeZone) return;
    if (activeZone.def.once && activeZone.fired) {
      announce(`${activeZone.def.label}: nothing more here.`);
      return;
    }
    fire(activeZone);
  }

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
        if (!z.def.once) z.armed = true; // repeatable zones re-arm on exit
      }
      if (z.inside && z.def.mode !== 'auto') prompted = z;
    }
    activeZone = prompted;
    if (prompted && !(prompted.def.once && prompted.fired)) {
      promptEl.textContent = prompted.def.prompt || 'Press E';
      promptEl.classList.remove('hidden');
    } else {
      promptEl.classList.add('hidden');
      promptEl.textContent = '';
    }
  }

  // ---------- debug/verification handle (no gameplay effect) ----------
  const api = {
    manifest: world,
    // carried, never interpreted — same contract as scene.json's worldTexture
    worldTexture: world.worldTexture || [],
    reduceMotion: reduce,
    post: post.params,
    colliders,
    bounds,
    waterVolumes,
    fps: 0,
    // style-pack surface, for verification: which optional blocks this pack used, and
    // whether its glTF props actually landed
    atmosphere: built.atmosphere,
    props: built.props,
    propsReady: built.propsReady,
    get propsPending() { return built.propsPending; },
    loadWarnings,
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
        promptVisible: !promptEl.classList.contains('hidden'),
        promptText: promptEl.textContent,
        activeZone: activeZone ? activeZone.def.id : null,
        cutsceneOpen: !cutsceneOverlay.classList.contains('hidden'),
        cutsceneSrc: cutsceneVideo.getAttribute('src'),
        proseOpen: !proseOverlay.classList.contains('hidden'),
        inputLocked,
        moveTouchActive: !!moveTouch,
        lookTouchActive: !!lookTouch,
        zones: zones.map((z) => ({ id: z.def.id, inside: z.inside, fired: z.fired }))
      };
    },
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

  function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;

    if (!inputLocked) {
      // keyboard turning / pitching — the mouse-free path
      if (keys.ArrowLeft) yaw -= TURN * dt;
      if (keys.ArrowRight) yaw += TURN * dt;
      if (keys.KeyR) pitch = Math.min(1.1, pitch + TURN * 0.55 * dt);
      if (keys.KeyF) pitch = Math.max(-1.1, pitch - TURN * 0.55 * dt);

      let fwd = 0, strafe = 0;
      if (keys.KeyW || keys.ArrowUp) fwd += 1;
      if (keys.KeyS || keys.ArrowDown) fwd -= 1;
      if (keys.KeyA) strafe -= 1;
      if (keys.KeyD) strafe += 1;

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
      }
      fwd = Math.max(-1, Math.min(1, fwd));
      strafe = Math.max(-1, Math.min(1, strafe));

      const jumpKey = !!(keys.Space || keys.KeyJ);
      const sinkKey = !!(keys.ShiftLeft || keys.ShiftRight);

      // ---------- horizontal movement ----------
      if (fwd || strafe) {
        forward.set(Math.sin(yaw), 0, -Math.cos(yaw));
        right.set(Math.cos(yaw), 0, Math.sin(yaw));
        step.set(0, 0, 0).addScaledVector(forward, fwd).addScaledVector(right, strafe);
        if (step.lengthSq() > 0) step.normalize();
        // Shift slows walking on land; underwater it's repurposed as "sink" instead
        const slow = !swimming && sinkKey ? 0.45 : 1;
        const baseSpeed = swimming ? SWIM_SPEED : SPEED;
        const dist = baseSpeed * slow * dt;
        pos.addScaledVector(step, dist);
        resolveHorizontal(pos, feetY);
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
        feetY = newFeetY;
        grounded = feetY <= currentWater.floorY + 1e-6;
        if (!reduce) { swimBobPhase += dt * 1.6; swimBobY = Math.sin(swimBobPhase) * 0.03; }
        else swimBobY = 0;
      } else {
        vy -= GRAVITY * dt;
        if (vy < -MAX_FALL_SPEED) vy = -MAX_FALL_SPEED;
        if (jumpKey && grounded) vy = JUMP_VELOCITY;
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

      updateZones();
    }

    // camera damping + head-bob: both are motion effects, both off under
    // prefers-reduced-motion (the view then tracks input exactly). Swim bob follows
    // the same reduced-motion gate (see swimBobY above — it's forced to 0 there).
    if (reduce) {
      smoothYaw = yaw; smoothPitch = pitch; bobY = 0; bobRoll = 0;
    } else {
      const k = 1 - Math.exp(-dt / 0.035); // frame-rate independent, ~35ms time constant
      smoothYaw += (yaw - smoothYaw) * k;
      smoothPitch += (pitch - smoothPitch) * k;
      const moving = !inputLocked && !swimming && (keys.KeyW || keys.KeyS || keys.KeyA || keys.KeyD || keys.ArrowUp || keys.ArrowDown);
      const targetBob = moving ? Math.sin(bobPhase) * 0.042 : 0;
      const targetRoll = moving ? Math.sin(bobPhase * 0.5) * 0.007 : 0;
      bobY += (targetBob - bobY) * Math.min(1, dt * 9);
      bobRoll += (targetRoll - bobRoll) * Math.min(1, dt * 9);
    }

    camera.position.set(pos.x, feetY + EYE + bobY + swimBobY, pos.z);
    camera.rotation.set(smoothPitch, -smoothYaw, bobRoll);

    // underwater tint/fog: swap the scene fog toward the water volume's tint while the
    // camera itself is below the surface, restore vanilla fog once it surfaces
    if (scene.fog && baseFogColor) {
      if (swimming && currentWater && camera.position.y < currentWater.surfaceY) {
        scene.fog.color.set(currentWater.tint);
        scene.fog.density = currentWater.fogDensity;
      } else {
        scene.fog.color.copy(baseFogColor);
        scene.fog.density = baseFogDensity;
      }
    }

    built.update(t, camera, renderer);
    post.render(t);

    fpsFrames++;
    const now = performance.now();
    if (now - fpsSince >= 500) {
      fps = (fpsFrames * 1000) / (now - fpsSince);
      fpsFrames = 0; fpsSince = now;
      if (showFps) fpsEl.textContent = fps.toFixed(1) + ' fps';
      api.fps = fps;
    }
  }
  frame();

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    post.setSize(innerWidth, innerHeight, pixelRatio);
  });

  announce('Ready. ' + (world.description || ''));
}

loadManifest(manifestPath)
  .then((world) => init(world, manifestBase(manifestPath)))
  .catch((err) => showLoadError(err.message));
