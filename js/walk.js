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
  const built = buildWorld(scene, world, reduce);
  const colliders = built.colliders;
  const bounds = built.bounds;

  const post = createPost(renderer, scene, camera);
  post.params.enabled = postEnabled;
  post.setSize(innerWidth, innerHeight, pixelRatio);

  // ---------- player state (spawn is manifest data) ----------
  const spawn = world.spawn || {};
  const playerCfg = world.player || {};
  const EYE = playerCfg.eyeHeight == null ? 1.65 : playerCfg.eyeHeight;
  const SPEED = playerCfg.walkSpeed == null ? 2.8 : playerCfg.walkSpeed;
  const RADIUS = playerCfg.radius == null ? 0.45 : playerCfg.radius;
  const TURN = 1.9; // rad/s for keyboard turning

  const pos = new THREE.Vector3(
    (spawn.position && spawn.position[0]) || 0,
    EYE,
    (spawn.position && spawn.position[2]) || 0
  );
  let yaw = spawn.yaw || 0;
  let pitch = spawn.pitch || 0;
  let smoothYaw = yaw, smoothPitch = pitch;
  let bobPhase = 0, bobY = 0, bobRoll = 0;

  // ---------- collision: circle vs axis-aligned rectangles, then hard bounds ----------
  function resolve(p) {
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < colliders.length; i++) {
        const c = colliders[i];
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
    p.y = EYE;
  }
  resolve(pos);

  // ---------- input ----------
  const keys = Object.create(null);
  let inputLocked = false;
  const helpPanel = document.getElementById('walk-help');

  const MOVE_KEYS = {
    KeyW: 1, KeyS: 1, KeyA: 1, KeyD: 1,
    ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1,
    KeyR: 1, KeyF: 1
  };

  function clearKeys() { for (const k in keys) keys[k] = false; }

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
  addEventListener('blur', clearKeys);
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== canvas) clearKeys();
  });

  // mouse-look via pointer lock (optional — the keyboard path is complete without it)
  canvas.addEventListener('click', () => {
    if (inputLocked) return;
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
    resumeState = { x: pos.x, z: pos.z, yaw, pitch };
    inputLocked = true;
    clearKeys();
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  }
  function resumeWalk() {
    if (resumeState) {
      pos.x = resumeState.x; pos.z = resumeState.z; pos.y = EYE;
      yaw = resumeState.yaw; pitch = resumeState.pitch;
      smoothYaw = yaw; smoothPitch = pitch;
      resumeState = null;
    }
    inputLocked = false;
    canvas.focus();
    announce('Back on the street. You are where you left off.');
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
    fps: 0,
    get state() {
      return {
        x: +pos.x.toFixed(3), z: +pos.z.toFixed(3), yaw: +yaw.toFixed(4), pitch: +pitch.toFixed(4),
        // the RENDERED camera, so the reduced-motion branch is measurable and not
        // merely asserted: with reduce, cameraY === eyeHeight and cameraYaw === yaw
        eyeHeight: EYE,
        cameraY: +camera.position.y.toFixed(5),
        cameraYaw: +(-camera.rotation.y).toFixed(5),
        cameraRoll: +camera.rotation.z.toFixed(5),
        promptVisible: !promptEl.classList.contains('hidden'),
        promptText: promptEl.textContent,
        activeZone: activeZone ? activeZone.def.id : null,
        cutsceneOpen: !cutsceneOverlay.classList.contains('hidden'),
        cutsceneSrc: cutsceneVideo.getAttribute('src'),
        proseOpen: !proseOverlay.classList.contains('hidden'),
        inputLocked,
        zones: zones.map((z) => ({ id: z.def.id, inside: z.inside, fired: z.fired }))
      };
    },
    // screenshot/debug aid only — moves the camera, changes nothing else
    debugTeleport(x, z, y, p) {
      pos.set(x, EYE, z);
      resolve(pos);
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

      if (fwd || strafe) {
        forward.set(Math.sin(yaw), 0, -Math.cos(yaw));
        right.set(Math.cos(yaw), 0, Math.sin(yaw));
        step.set(0, 0, 0).addScaledVector(forward, fwd).addScaledVector(right, strafe);
        if (step.lengthSq() > 0) step.normalize();
        const slow = keys.ShiftLeft || keys.ShiftRight ? 0.45 : 1;
        const dist = SPEED * slow * dt;
        pos.addScaledVector(step, dist);
        resolve(pos);
        if (!reduce) bobPhase += dist * 2.6;
      } else if (!reduce) {
        bobPhase += dt * 0.6;
      }
      updateZones();
    }

    // camera damping + head-bob: both are motion effects, both off under
    // prefers-reduced-motion (the view then tracks input exactly)
    if (reduce) {
      smoothYaw = yaw; smoothPitch = pitch; bobY = 0; bobRoll = 0;
    } else {
      const k = 1 - Math.exp(-dt / 0.035); // frame-rate independent, ~35ms time constant
      smoothYaw += (yaw - smoothYaw) * k;
      smoothPitch += (pitch - smoothPitch) * k;
      const moving = !inputLocked && (keys.KeyW || keys.KeyS || keys.KeyA || keys.KeyD || keys.ArrowUp || keys.ArrowDown);
      const targetBob = moving ? Math.sin(bobPhase) * 0.042 : 0;
      const targetRoll = moving ? Math.sin(bobPhase * 0.5) * 0.007 : 0;
      bobY += (targetBob - bobY) * Math.min(1, dt * 9);
      bobRoll += (targetRoll - bobRoll) * Math.min(1, dt * 9);
    }

    camera.position.set(pos.x, pos.y + bobY, pos.z);
    camera.rotation.set(smoothPitch, -smoothYaw, bobRoll);

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
