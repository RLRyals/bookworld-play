// BookWorld — pack-facing procedural surface textures + world-unit UV tiling.
//
// The style-pack layer (specs/2026-08-08-style-pack-layer.md) lets a pack say
//
//   "wall": { "kind": "flat", "color": "#e6d3af", "texture": "plaster", "tileScale": 2.5 }
//
// and get a tiling surface with zero binary assets in the pack folder. `texture` is
// EITHER one of the generator names below OR a path to an image file inside the pack
// folder (anything containing a "/" or a file extension is treated as a path) — the
// format is identical either way, so an AI-painted texture set drops in later with no
// schema change.
//
// The generators are the chalkTex technique from the original vindictive scene
// (AuthorWebsite/src/_includes/layouts/partials/vindictive.njk lines 68-82): draw on a
// 2D canvas in code, wrap it in a THREE.CanvasTexture. Every generator draws a SEAMLESS
// tile (anything crossing an edge is redrawn on the opposite edge) because the whole
// point of `tileScale` is that the texture repeats across a surface.
//
// `tileScale` is world-units-per-repeat, and it is honoured by rewriting the MESH's UVs
// (see applyWorldUVs) rather than by setting texture.repeat — a shared material can then
// tile correctly on a 3x3 crate and a 30x30 ground plane at the same time, and each of a
// box's six faces gets the tiling its own two dimensions imply instead of the stretched
// 0..1-per-face UVs BoxGeometry ships with.
import * as THREE from 'three';

// deterministic per-texture RNG — screenshots have to be reproducible run to run
function rng(seed) {
  let s = seed | 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function shade(hex, amount) {
  const col = new THREE.Color(hex);
  if (amount >= 0) col.lerp(new THREE.Color('#ffffff'), amount);
  else col.lerp(new THREE.Color('#000000'), -amount);
  return '#' + col.getHexString();
}

// THREE.Color stores linear-working-space components, so round-trip through
// getHexString (which re-encodes to sRGB) before handing bytes to the 2D canvas
function rgba(hex, alpha) {
  const n = parseInt(new THREE.Color(hex).getHexString(), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// speckle/grain wash used by most generators — cheap, and it's what stops a flat fill
// from reading as "untextured gray box" at walking distance
function speckle(g, S, rand, count, alpha, radius) {
  for (let i = 0; i < count; i++) {
    const x = rand() * S, y = rand() * S, r = radius * (0.3 + rand());
    const dark = rand() < 0.5;
    g.fillStyle = dark
      ? `rgba(0,0,0,${(alpha * rand()).toFixed(3)})`
      : `rgba(255,255,255,${(alpha * 0.7 * rand()).toFixed(3)})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
}

// draws a rect and its wrap-around copies so the tile is seamless
function wrapRect(g, S, x, y, w, h) {
  for (let ox = -S; ox <= S; ox += S) {
    for (let oy = -S; oy <= S; oy += S) {
      if (x + ox > S || x + ox + w < 0 || y + oy > S || y + oy + h < 0) continue;
      g.fillRect(x + ox, y + oy, w, h);
    }
  }
}

// ---------- the generators ----------
// Every one takes ({ base, line, accent, seed, size }) and returns a canvas.
// `base` is the dominant colour (defaults come from the material's own `color`).
const GENERATORS = {
  // running-bond brick: mortar bed, offset courses, per-brick tonal variation
  brick(o) {
    const S = o.size, c = canvas(S), g = c.getContext('2d'), rand = rng(o.seed);
    const rows = o.rows || 8, cols = o.cols || 4;
    const bh = S / rows, bw = S / cols, m = Math.max(1, S / 128);
    g.fillStyle = o.line || shade(o.base, -0.45);
    g.fillRect(0, 0, S, S);
    for (let r = 0; r < rows; r++) {
      const offset = (r % 2) * bw * 0.5;
      for (let cIdx = -1; cIdx <= cols; cIdx++) {
        const x = cIdx * bw + offset, y = r * bh;
        g.fillStyle = shade(o.base, (rand() - 0.5) * 0.22);
        wrapRect(g, S, x + m, y + m, bw - m * 2, bh - m * 2);
      }
    }
    speckle(g, S, rand, S * 1.6, 0.16, S / 90);
    return c;
  },

  // troweled lime plaster / stucco: soft blotches, a few hairline cracks
  plaster(o) {
    const S = o.size, c = canvas(S), g = c.getContext('2d'), rand = rng(o.seed);
    g.fillStyle = o.base; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 70; i++) {
      const x = rand() * S, y = rand() * S, r = S * (0.04 + rand() * 0.13);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      const tone = shade(o.base, (rand() - 0.45) * 0.3);
      grd.addColorStop(0, rgba(tone, 1));
      grd.addColorStop(1, rgba(tone, 0));
      g.fillStyle = grd; g.globalAlpha = 0.5;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
    }
    g.strokeStyle = shade(o.base, -0.3);
    g.lineWidth = Math.max(1, S / 400);
    for (let i = 0; i < 5; i++) {
      let x = rand() * S, y = rand() * S;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 6; k++) { x += (rand() - 0.5) * S * 0.2; y += rand() * S * 0.12; g.lineTo(x, y); }
      g.globalAlpha = 0.35; g.stroke(); g.globalAlpha = 1;
    }
    speckle(g, S, rand, S * 2.2, 0.1, S / 110);
    return c;
  },

  // sawn timber / plank: vertical grain lines + knots, tiles along its length
  timber(o) {
    const S = o.size, c = canvas(S), g = c.getContext('2d'), rand = rng(o.seed);
    g.fillStyle = o.base; g.fillRect(0, 0, S, S);
    const planks = o.planks || 4, pw = S / planks;
    for (let p = 0; p < planks; p++) {
      g.fillStyle = shade(o.base, (rand() - 0.5) * 0.24);
      g.fillRect(p * pw, 0, pw, S);
      // grain
      for (let i = 0; i < 26; i++) {
        const x = p * pw + rand() * pw;
        g.strokeStyle = shade(o.base, rand() < 0.5 ? -0.25 : 0.16);
        g.globalAlpha = 0.25 + rand() * 0.35;
        g.lineWidth = Math.max(1, S / 380);
        g.beginPath(); g.moveTo(x, 0);
        let xx = x;
        for (let y = 0; y <= S; y += S / 10) { xx += (rand() - 0.5) * pw * 0.10; g.lineTo(xx, y); }
        g.stroke(); g.globalAlpha = 1;
      }
      // knot
      if (rand() < 0.55) {
        const kx = p * pw + pw * (0.25 + rand() * 0.5), ky = rand() * S;
        for (let r = S * 0.035; r > 0; r -= S * 0.006) {
          g.strokeStyle = shade(o.base, -0.32); g.globalAlpha = 0.5; g.lineWidth = 1;
          g.beginPath(); g.ellipse(kx, ky, r, r * 0.6, 0, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
        }
      }
      // seam between planks
      g.fillStyle = shade(o.base, -0.5);
      g.fillRect(p * pw, 0, Math.max(1, S / 200), S);
    }
    speckle(g, S, rand, S * 1.2, 0.12, S / 120);
    return c;
  },

  // clay roof tile: overlapping scalloped courses
  roofTile(o) {
    const S = o.size, c = canvas(S), g = c.getContext('2d'), rand = rng(o.seed);
    g.fillStyle = shade(o.base, -0.4); g.fillRect(0, 0, S, S);
    const rows = o.rows || 6, cols = o.cols || 6;
    const rh = S / rows, cw = S / cols;
    for (let r = 0; r < rows; r++) {
      const offset = (r % 2) * cw * 0.5;
      for (let i = -1; i <= cols; i++) {
        const x = i * cw + offset, y = r * rh;
        for (let ox = -S; ox <= S; ox += S) {
          const xx = x + ox;
          if (xx > S || xx + cw < 0) continue;
          g.fillStyle = shade(o.base, (rand() - 0.5) * 0.26);
          g.beginPath();
          g.moveTo(xx, y + rh);
          g.lineTo(xx, y + rh * 0.45);
          g.quadraticCurveTo(xx + cw / 2, y - rh * 0.28, xx + cw, y + rh * 0.45);
          g.lineTo(xx + cw, y + rh);
          g.closePath(); g.fill();
          g.strokeStyle = shade(o.base, -0.42);
          g.lineWidth = Math.max(1, S / 200);
          g.stroke();
        }
      }
    }
    speckle(g, S, rand, S * 1.4, 0.14, S / 100);
    return c;
  },

  // thatch / straw: dense directional strokes, banded courses
  thatch(o) {
    const S = o.size, c = canvas(S), g = c.getContext('2d'), rand = rng(o.seed);
    g.fillStyle = shade(o.base, -0.3); g.fillRect(0, 0, S, S);
    const courses = o.rows || 5, ch = S / courses;
    for (let r = 0; r < courses; r++) {
      for (let i = 0; i < S * 1.6; i++) {
        const x = rand() * S, y = r * ch + rand() * ch;
        const len = ch * (0.5 + rand() * 0.7);
        g.strokeStyle = shade(o.base, (rand() - 0.35) * 0.5);
        g.globalAlpha = 0.4 + rand() * 0.5;
        g.lineWidth = Math.max(1, S / 300);
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + (rand() - 0.5) * S * 0.03, y + len);
        g.stroke();
        g.globalAlpha = 1;
      }
      // shadow line under each course
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.fillRect(0, (r + 1) * ch - Math.max(1, S / 128), S, Math.max(1, S / 128));
    }
    return c;
  },

  // worn asphalt: coarse aggregate speckle over a dark bed
  asphalt(o) {
    const S = o.size, c = canvas(S), g = c.getContext('2d'), rand = rng(o.seed);
    g.fillStyle = o.base; g.fillRect(0, 0, S, S);
    speckle(g, S, rand, S * 9, 0.3, S / 150);
    for (let i = 0; i < 16; i++) {
      const x = rand() * S, y = rand() * S, r = S * (0.05 + rand() * 0.12);
      g.fillStyle = shade(o.base, (rand() - 0.5) * 0.14);
      g.globalAlpha = 0.4; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
    }
    return c;
  },

  // rounded cobbles set in mortar
  cobble(o) {
    const S = o.size, c = canvas(S), g = c.getContext('2d'), rand = rng(o.seed);
    g.fillStyle = shade(o.base, -0.28); g.fillRect(0, 0, S, S);
    const n = o.rows || 7, step = S / n;
    for (let r = 0; r < n; r++) {
      for (let i = -1; i <= n; i++) {
        const cx = i * step + (r % 2) * step * 0.5 + step * 0.5 + (rand() - 0.5) * step * 0.18;
        const cy = r * step + step * 0.5 + (rand() - 0.5) * step * 0.18;
        const rx = step * (0.46 + rand() * 0.12), ry = step * (0.44 + rand() * 0.12);
        for (let ox = -S; ox <= S; ox += S) {
          for (let oy = -S; oy <= S; oy += S) {
            const x = cx + ox, y = cy + oy;
            if (x < -step || x > S + step || y < -step || y > S + step) continue;
            const grd = g.createRadialGradient(x - rx * 0.3, y - ry * 0.3, rx * 0.1, x, y, rx);
            grd.addColorStop(0, shade(o.base, 0.07 + rand() * 0.07));
            grd.addColorStop(1, shade(o.base, -0.26 + (rand() - 0.5) * 0.22));
            g.fillStyle = grd;
            g.beginPath(); g.ellipse(x, y, rx, ry, rand() * 3, 0, Math.PI * 2); g.fill();
          }
        }
      }
    }
    speckle(g, S, rand, S * 1.5, 0.12, S / 130);
    return c;
  },

  // cut flagstone / ashlar paving: irregular rectangles, wide joints
  flagstone(o) {
    const S = o.size, c = canvas(S), g = c.getContext('2d'), rand = rng(o.seed);
    g.fillStyle = o.line || shade(o.base, -0.5); g.fillRect(0, 0, S, S);
    const rows = o.rows || 4, joint = Math.max(1, S / 90);
    for (let r = 0; r < rows; r++) {
      const y = r * (S / rows);
      let x = -((rand() * S) / rows);
      while (x < S) {
        const w = (S / rows) * (0.7 + rand() * 0.9);
        g.fillStyle = shade(o.base, (rand() - 0.5) * 0.26);
        wrapRect(g, S, x + joint, y + joint, w - joint * 2, S / rows - joint * 2);
        x += w;
      }
    }
    speckle(g, S, rand, S * 2, 0.13, S / 110);
    return c;
  },

  // coursed sandstone blocks — bigger, flatter, more sun-bleached than `brick`
  sandstone(o) {
    const S = o.size, c = canvas(S), g = c.getContext('2d'), rand = rng(o.seed);
    g.fillStyle = o.line || shade(o.base, -0.35); g.fillRect(0, 0, S, S);
    const rows = o.rows || 5, cols = o.cols || 3;
    const bh = S / rows, bw = S / cols, m = Math.max(1, S / 150);
    for (let r = 0; r < rows; r++) {
      const offset = (r % 2) * bw * 0.35;
      for (let i = -1; i <= cols; i++) {
        const x = i * bw + offset, y = r * bh;
        g.fillStyle = shade(o.base, (rand() - 0.5) * 0.16);
        wrapRect(g, S, x + m, y + m, bw - m * 2, bh - m * 2);
      }
    }
    // weathering streaks down the face
    for (let i = 0; i < 22; i++) {
      const x = rand() * S;
      g.fillStyle = `rgba(0,0,0,${(0.03 + rand() * 0.06).toFixed(3)})`;
      g.fillRect(x, 0, S * (0.01 + rand() * 0.03), S);
    }
    speckle(g, S, rand, S * 2.4, 0.1, S / 120);
    return c;
  },

  // awning/canopy canvas: woven weft plus wide colour stripes
  stripe(o) {
    const S = o.size, c = canvas(S), g = c.getContext('2d'), rand = rng(o.seed);
    const bands = o.rows || 6, bw = S / bands;
    for (let i = 0; i < bands; i++) {
      g.fillStyle = i % 2 ? (o.accent || shade(o.base, 0.45)) : o.base;
      g.fillRect(i * bw, 0, bw, S);
    }
    g.globalAlpha = 0.12;
    for (let y = 0; y < S; y += 3) { g.fillStyle = '#000'; g.fillRect(0, y, S, 1); }
    g.globalAlpha = 1;
    speckle(g, S, rand, S * 1.2, 0.1, S / 140);
    return c;
  }
};

export const GENERATOR_NAMES = Object.keys(GENERATORS);

const cache = new Map();

function isImagePath(spec) {
  return /[\\/]/.test(spec) || /\.(png|jpe?g|webp|avif|ktx2?|bmp|gif)$/i.test(spec);
}

// Returns a THREE.Texture for a material's `texture` field. `spec` is either a
// generator name or a pack-relative image path; `base` is the pack folder URL.
// Never throws for a bad path — an image that fails to load leaves the material on its
// `color` fallback and logs, because one missing texture must not blank a whole world.
export function resolveTexture(spec, opts, base, onError) {
  const key = JSON.stringify([spec, opts, base]);
  if (cache.has(key)) return cache.get(key);

  let tex;
  if (isImagePath(spec)) {
    tex = new THREE.TextureLoader().load(
      base + spec,
      undefined,
      undefined,
      () => { if (onError) onError(`texture image failed to load: ${base + spec}`); }
    );
  } else {
    const gen = GENERATORS[spec];
    if (!gen) throw new Error(`Unknown procedural texture "${spec}" — known: ${GENERATOR_NAMES.join(', ')}`);
    const o = Object.assign({ size: 256, seed: 20260808, base: '#8a8a8a' }, opts || {});
    tex = new THREE.CanvasTexture(gen(o));
  }
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  cache.set(key, tex);
  return tex;
}

// ---------- world-unit UV tiling ----------
// Rewrites a geometry's uv attribute so one texture repeat covers `tileScale` world
// units on every face, whatever the element's dimensions are. BoxGeometry lays out its
// 24 verts as six 4-vert faces in the order +X, -X, +Y, -Y, +Z, -Z, each with 0..1 UVs;
// each face's two in-plane dimensions decide its scale factor. PlaneGeometry is the
// simple single-face case.
export function applyWorldUVs(geometry, size, tileScale) {
  if (!tileScale) return;
  const uv = geometry.attributes.uv;
  if (!uv) return;
  const [w, h, d] = size;

  if (geometry.type === 'BoxGeometry' || uv.count === 24) {
    const faceDims = [
      [d, h], [d, h], // +X, -X
      [w, d], [w, d], // +Y, -Y
      [w, h], [w, h]  // +Z, -Z
    ];
    for (let f = 0; f < 6; f++) {
      const su = faceDims[f][0] / tileScale, sv = faceDims[f][1] / tileScale;
      for (let i = 0; i < 4; i++) {
        const idx = f * 4 + i;
        uv.setXY(idx, uv.getX(idx) * su, uv.getY(idx) * sv);
      }
    }
  } else {
    const su = w / tileScale, sv = (h == null ? w : h) / tileScale;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  uv.needsUpdate = true;
}
