// BookWorld — engine + world-pack localization (specs/2026-08-09-localization-language-packs.md).
//
// Language selection order, identical for engine chrome and world packs: `?lang=` query
// override -> browser locale (navigator.language, base subtag only) -> pack/engine
// default. A missing translation file is never an error — it just means "not translated
// yet," and the request quietly falls back to the default-language text that is already
// loaded (js/i18n/strings.json for chrome, the world.json fields themselves for a pack).
//
// Engine chrome: js/i18n/strings.json is the canonical English table; js/i18n/strings.
// <lang>.json overlays translated values onto the same keys (a partial translation is
// still usable — untranslated keys keep the English value).
//
// World packs: world.json fields ARE the pack's own default-language text layer, so
// there is no separate "base" file to keep in sync. A translation pack adds
// worlds/<pack>/text.<lang>.json, id-keyed so a translator only ever touches prose —
// never geometry, ids, or trigger wiring.

let chromeDict = {};

export function resolveLang(defaultLang) {
  const qLang = new URLSearchParams(location.search).get('lang');
  if (qLang) return qLang.toLowerCase();
  const nav = (navigator.language || '').split('-')[0].toLowerCase();
  if (nav) return nav;
  return (defaultLang || 'en').toLowerCase();
}

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Loads engine UI chrome strings for `lang`. Untranslated keys fall back to the English
// base, so a partial js/i18n/strings.<lang>.json is still usable.
export async function loadChromeStrings(lang) {
  const base = (await fetchJson('js/i18n/strings.json')) || {};
  let overrides = {};
  if (lang && lang !== 'en') {
    overrides = (await fetchJson(`js/i18n/strings.${lang}.json`)) || {};
  }
  chromeDict = { ...base, ...overrides };
  return chromeDict;
}

export function t(key, vars) {
  let s = chromeDict[key] ?? key;
  if (vars) {
    for (const k in vars) s = s.replaceAll(`{${k}}`, vars[k]);
  }
  return s;
}

// Overlays worlds/<pack>/text.<lang>.json (if present) onto an already-loaded world
// manifest, in place. Only ever replaces label/prompt/srHint/prose/title strings —
// geometry, ids, and trigger wiring are untouched, so a translation pack can never
// change what the world DOES, only what it SAYS.
export async function applyWorldLocale(world, base, lang) {
  if (!lang || lang === (world.defaultLang || 'en')) return world;
  const locale = await fetchJson(`${base}text.${lang}.json`);
  if (!locale) return world;

  if (locale.world) {
    if (locale.world.title) world.title = locale.world.title;
    if (locale.world.description) world.description = locale.world.description;
  }
  if (locale.triggers) {
    for (const trig of world.triggers || []) {
      const ov = locale.triggers[trig.id];
      if (!ov) continue;
      if (ov.label) trig.label = ov.label;
      if (ov.prompt) trig.prompt = ov.prompt;
      if (ov.srHint) trig.srHint = ov.srHint;
      if (ov.text && trig.trigger && trig.trigger.type === 'prose') trig.trigger.text = ov.text;
    }
  }
  if (locale.cutscenes) {
    for (const cut of world.cutscenes || []) {
      const ov = locale.cutscenes[cut.id];
      if (ov && ov.title) cut.title = ov.title;
    }
  }
  return world;
}
