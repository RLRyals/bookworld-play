// BookWorld engine — story-agnostic explorable-location loader.
// Renders any conformant scene.json manifest. Contains zero location-specific
// data or strings; all content comes from the manifest at runtime.
//
// Camera/panorama/hotspot-projection technique lifted from
// AuthorWebsite/src/_includes/layouts/partials/vindictive.njk (lines 37-193).
import * as THREE from 'three';

const params = new URLSearchParams(location.search);
const manifestPath = params.get('scene') || 'scenes/manifest-a/scene.json';

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
  const text = document.getElementById('load-error-text');
  text.textContent = message;
  el.classList.remove('hidden');
}

function init(scene_, base) {
  document.title = scene_.title || 'BookWorld';
  document.getElementById('scene-description').textContent = scene_.description || '';

  // ---------- renderer / scene / camera (you stand inside the panorama) ----------
  const canvas = document.getElementById('bg');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const three_scene = new THREE.Scene();
  three_scene.background = new THREE.Color(0x05060a);
  const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(0, 1.6, 0);

  const BASE_YAW = (scene_.panorama && scene_.panorama.baseYaw) || 0;
  const INITIAL_PITCH = (scene_.panorama && scene_.panorama.initialPitch) || 0;

  // ---------- panorama = the world ----------
  function buildEquirect(img) {
    const W = 4096, H = 2048;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const ih = Math.round(W * img.height / img.width), y0 = Math.round((H - ih) / 2);
    g.fillStyle = '#05060a'; g.fillRect(0, 0, W, H);
    g.drawImage(img, 0, y0, W, ih);
    if (y0 > 1) {
      const fade = Math.round(H * 0.06);
      let gt = g.createLinearGradient(0, 0, 0, y0 + fade);
      gt.addColorStop(0, 'rgba(5,6,10,1)'); gt.addColorStop(1, 'rgba(5,6,10,0)');
      g.fillStyle = gt; g.fillRect(0, 0, W, y0 + fade);
      let gb = g.createLinearGradient(0, H, 0, y0 + ih - fade);
      gb.addColorStop(0, 'rgba(5,6,10,1)'); gb.addColorStop(1, 'rgba(5,6,10,0)');
      g.fillStyle = gb; g.fillRect(0, y0 + ih - fade, W, H - (y0 + ih) + fade);
    }
    const t = new THREE.CanvasTexture(c);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  }

  const panoImg = new Image();
  panoImg.onload = () => { three_scene.background = buildEquirect(panoImg); };
  panoImg.onerror = () => showLoadError(`Failed to load panorama image: ${scene_.panorama.src}`);
  panoImg.src = base + scene_.panorama.src;

  // ---------- clickable/focusable hotspots ----------
  const _v = new THREE.Vector3();
  const hotLayer = document.getElementById('hotspots');
  hotLayer.innerHTML = '';

  const proseOverlay = document.getElementById('prose-overlay');
  const proseText = document.getElementById('prose-text');
  const proseClose = document.getElementById('prose-close');
  const cutsceneOverlay = document.getElementById('cutscene-overlay');
  const cutsceneVideo = document.getElementById('cutscene-video');

  function openProse(text) {
    proseText.textContent = text;
    proseOverlay.classList.remove('hidden');
    proseClose.focus();
  }
  function closeProse() {
    proseOverlay.classList.add('hidden');
  }
  proseClose.addEventListener('click', closeProse);
  proseOverlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeProse(); });

  const cutscenesById = {};
  (scene_.cutscenes || []).forEach((c) => { cutscenesById[c.id] = c; });

  let resumeYaw = null;
  function playCutscene(cutsceneId) {
    const c = cutscenesById[cutsceneId];
    if (!c) return;
    cutsceneVideo.src = base + c.video;
    if (c.poster) cutsceneVideo.poster = base + c.poster;
    cutsceneOverlay.classList.remove('hidden');
    cutsceneVideo.currentTime = 0;
    cutsceneVideo.play().catch(() => {});
    cutsceneVideo.focus();
  }
  function closeCutscene() {
    cutsceneVideo.pause();
    cutsceneOverlay.classList.add('hidden');
    // camera stays pointed where the cutscene left off (lookYaw/lookPitch untouched)
  }
  cutsceneVideo.addEventListener('ended', closeCutscene);
  cutsceneOverlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCutscene(); });
  cutsceneOverlay.addEventListener('click', (e) => { if (e.target === cutsceneOverlay) closeCutscene(); });

  function fireTrigger(trigger) {
    if (!trigger) return;
    if (trigger.type === 'prose') openProse(trigger.text);
    else if (trigger.type === 'cutscene') playCutscene(trigger.cutsceneId);
  }

  let lookYaw = 0, lookPitch = INITIAL_PITCH;

  const hotspots = (scene_.hotspots || []).map((d) => {
    const yaw = BASE_YAW + d.yaw, cc = Math.cos(d.elevation);
    const anchor = new THREE.Vector3(Math.sin(yaw) * cc * 30, Math.sin(d.elevation) * 30, -Math.cos(yaw) * cc * 30);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'hotspot';
    el.setAttribute('aria-label', d.label);
    el.innerHTML = `<span class="pin" aria-hidden="true"></span><span class="htext">${d.label}</span>`;
    el.addEventListener('focus', () => { lookYaw = d.yaw; });
    el.addEventListener('click', () => fireTrigger(d.trigger));
    hotLayer.appendChild(el);
    return { anchor, el, yaw: d.yaw };
  });

  // ---------- interaction: click + drag ANYWHERE to look around ----------
  let dragging = false, lastX = 0, lastY = 0;
  let tpx = 0, tpy = 0;
  const isUI = (el) => !!(el && el.closest && el.closest('button,a,input,nav,.overlay-panel'));
  function down(e) { if (isUI(e.target)) return; dragging = true; lastX = e.clientX; lastY = e.clientY; document.body.classList.add('grabbing'); }
  function move(e) {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    lookYaw -= dx * 0.004;
    lookPitch = Math.max(-0.6, Math.min(0.3, lookPitch - dy * 0.003));
  }
  function up() { dragging = false; document.body.classList.remove('grabbing'); }
  addEventListener('mousedown', down);
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
  if (!reduce) {
    addEventListener('mousemove', (e) => {
      if (!dragging) { tpx = (e.clientX / innerWidth - 0.5); tpy = (e.clientY / innerHeight - 0.5); }
    });
  }

  // ---------- keyboard-only look-around (arrow keys), independent of hotspot focus ----------
  const KEY_STEP = 0.06;
  addEventListener('keydown', (e) => {
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.overlay')) return;
    if (e.key === 'ArrowLeft') { lookYaw -= KEY_STEP; e.preventDefault(); }
    else if (e.key === 'ArrowRight') { lookYaw += KEY_STEP; e.preventDefault(); }
    else if (e.key === 'ArrowUp') { lookPitch = Math.min(0.3, lookPitch + KEY_STEP); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { lookPitch = Math.max(-0.6, lookPitch - KEY_STEP); e.preventDefault(); }
  });

  // ---------- render loop ----------
  let curYaw = BASE_YAW + lookYaw, curPit = lookPitch;
  function loop() {
    requestAnimationFrame(loop);
    const tgtYaw = BASE_YAW + lookYaw + (reduce ? 0 : tpx * 0.18);
    const tgtPit = lookPitch + (reduce ? 0 : tpy * 0.08);
    curYaw += (tgtYaw - curYaw) * 0.08;
    curPit += (tgtPit - curPit) * 0.08;
    const cc = Math.cos(curPit);
    camera.lookAt(
      camera.position.x + Math.sin(curYaw) * cc,
      camera.position.y + Math.sin(curPit),
      camera.position.z - Math.cos(curYaw) * cc
    );
    hotspots.forEach((h) => {
      _v.copy(h.anchor).project(camera);
      const on = _v.z < 1 && Math.abs(_v.x) < 1 && Math.abs(_v.y) < 1.1;
      if (on) {
        h.el.style.left = ((_v.x * 0.5 + 0.5) * innerWidth) + 'px';
        h.el.style.top = ((-_v.y * 0.5 + 0.5) * innerHeight) + 'px';
      }
      h.el.style.opacity = on ? '1' : '0';
      h.el.style.pointerEvents = on ? 'auto' : 'none';
    });
    renderer.render(three_scene, camera);
  }
  loop();

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

loadManifest(manifestPath)
  .then((scene_) => init(scene_, manifestBase(manifestPath)))
  .catch((err) => showLoadError(err.message));
