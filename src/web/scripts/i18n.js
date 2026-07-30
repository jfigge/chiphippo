/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

"use strict";

/**
 * i18n.js — the renderer's internationalization seam.
 *
 * The ONE place every user-facing string passes through. A component calls
 * `t("toolbar.wire.title")` instead of writing English into the DOM; the active
 * locale's catalog is resolved once at startup and held in module state, so `t()`
 * is a synchronous lookup from then on.
 *
 * Loading model
 * -------------
 * Every Chip Hippo window is served from `file://` under a CSP of
 * `default-src 'self'` with no `connect-src`, so a renderer cannot fetch its own
 * catalog — there is no http dev-server path to fall back to the way Rest Hippo
 * has. The main process owns filesystem I/O and the OS locale, so it resolves the
 * active locale and returns the ready-to-use catalog over `window.chiphippo
 * .i18n.load()`. `init()` awaits that ONCE, before anything renders. Every
 * window does this — index.html, pinout.html, memory.html — because each is its
 * own sandboxed renderer with its own module state.
 *
 * Catalog shape
 * -------------
 * Catalogs are bundled JSON grouped by area; keys are dotted paths resolved
 * against the nested object (`t("settings.nav.appearance")` → catalog.settings
 * .nav.appearance). A missing key falls back to the English catalog, then to the
 * key itself, so an un-migrated or un-translated string never throws or blanks.
 *
 * Conventions
 * -----------
 *   • Key convention: `area.component.label` (lowerCamel leaf).
 *   • Interpolation: `{name}` placeholders, filled from the params object.
 *   • Plurals: a leaf may be an object of CLDR categories ({ one, other, … });
 *     pass a numeric `count` param and the right form is selected via
 *     Intl.PluralRules for the active locale.
 *   • NEVER call t() at module top-level — the catalog is not loaded until
 *     init() runs, so a top-level call would freeze the English key into a
 *     module constant. Call it inside render methods / functions only. This is
 *     exactly why the parts CATALOG keeps its English `title`/`desc` as data
 *     and the views translate them through `tf()` (see below).
 *
 * Usage:
 *   import { t, tf, formatNumber } from "./i18n.js";
 *   btn.textContent = t("common.cancel");
 *   label.textContent = t("guide.wireCount", { count: n });   // "5 wires"
 *   title.textContent = tf(`parts.${def.id}.title`, def.title);
 */

// ── Module state ──────────────────────────────────────────────────────────────

/** @type {string} active locale tag (e.g. "en", "de", "en-US") */
let _active = "en";
/** @type {string} primary language subtag, mirrored to <html lang> */
let _lang = "en";
/** @type {object} active locale catalog (nested by area) */
let _messages = {};
/** @type {object} English catalog — always the fallback for missing keys */
let _fallback = {};
/** @type {Intl.PluralRules|null} lazily built for the active locale */
let _pluralRules = null;
/** @type {Array<{code: string, nativeName: string}>} languages a catalog ships for */
let _locales = [];

// ── Lookup + interpolation ──────────────────────────────────────────────────

/**
 * Resolve a dotted key against a nested catalog object.
 * @param {object} catalog
 * @param {string} key
 * @returns {string|object|undefined}
 */
function _lookup(catalog, key) {
  if (!catalog) return undefined;
  // Fast path: a key stored verbatim (a leaf sitting at the top level).
  if (Object.prototype.hasOwnProperty.call(catalog, key)) return catalog[key];
  let node = catalog;
  for (const part of key.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Replace `{name}` placeholders with values from params. An unmatched
 * placeholder is left intact so a missing param is VISIBLE rather than silently
 * dropped — a gap in a sentence reads as a bug, which is what it is.
 * @param {string} str
 * @param {object} [params]
 * @returns {string}
 */
function _interpolate(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name)
      ? String(params[name])
      : match,
  );
}

/**
 * CLDR plural category for a count under the active locale.
 * @param {number} count
 * @returns {string} "zero"|"one"|"two"|"few"|"many"|"other"
 */
function _pluralCategory(count) {
  try {
    if (!_pluralRules) _pluralRules = new Intl.PluralRules(_active);
    return _pluralRules.select(count);
  } catch {
    return count === 1 ? "one" : "other";
  }
}

/**
 * The shared resolve: active catalog → English fallback → undefined. Plural
 * objects collapse to the form the count selects.
 * @param {string} key
 * @param {object} [params]
 * @returns {string|undefined}
 */
function _resolve(key, params) {
  let msg = _lookup(_messages, key);
  if (msg === undefined) msg = _lookup(_fallback, key);
  if (msg === undefined) return undefined;

  if (msg && typeof msg === "object") {
    if (params && typeof params.count === "number") {
      const cat = _pluralCategory(params.count);
      msg = msg[cat] ?? msg.other ?? msg.one;
      if (msg === undefined) return undefined;
    } else {
      // A group node, not a leaf string — nothing renderable.
      return undefined;
    }
  }
  return _interpolate(String(msg), params);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Translate a key, with optional interpolation / pluralization.
 *
 * Resolution order: active catalog → English fallback → the key itself. If the
 * resolved value is an object of CLDR plural categories and a numeric `count`
 * param is supplied, the matching form is selected and then interpolated.
 *
 * @param {string} key       dotted catalog key (e.g. "common.cancel")
 * @param {object} [params]  interpolation values; a numeric `count` enables plurals
 * @returns {string}
 */
export function t(key, params) {
  return _resolve(key, params) ?? key;
}

/**
 * Translate a key whose English source lives somewhere ELSE — falling back to
 * that literal instead of to the key.
 *
 * The parts catalog is why this exists. `catalog/*.js` is pure data evaluated at
 * import time, long before `init()` has a catalog, so its `title`/`desc` cannot
 * be `t()` calls; and they are not only UI text either (the BOM export and the
 * catalog's own integrity tests read them). So the English stays there as the
 * DATA, the translations live under `parts.<id>.*`, and a view resolves through
 * this — which degrades to the catalog's own English rather than to a raw key if
 * a newly added part has no catalog entry yet. `tests/i18n-catalog.test.js` is
 * what stops that from going unnoticed.
 *
 * @param {string} key       dotted catalog key
 * @param {string} fallback  the English literal to use when the key is absent
 * @param {object} [params]  interpolation values
 * @returns {string}
 */
export function tf(key, fallback, params) {
  return _resolve(key, params) ?? _interpolate(String(fallback ?? ""), params);
}

/**
 * Locale-aware number formatting (a thin Intl.NumberFormat wrapper).
 * @param {number} value
 * @param {Intl.NumberFormatOptions} [opts]
 * @returns {string}
 */
export function formatNumber(value, opts) {
  try {
    return new Intl.NumberFormat(_active, opts).format(value);
  } catch {
    return String(value);
  }
}

/**
 * Locale-aware date/time formatting (a thin Intl.DateTimeFormat wrapper).
 * @param {Date|number|string} value
 * @param {Intl.DateTimeFormatOptions} [opts]
 * @returns {string} "" for an invalid date
 */
export function formatDate(
  value,
  opts = { dateStyle: "medium", timeStyle: "short" },
) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(_active, opts).format(d);
  } catch {
    return d.toLocaleString();
  }
}

/** @returns {string} active locale tag */
export function getLocale() {
  return _active;
}

/** @returns {string} active primary language subtag */
export function getLang() {
  return _lang;
}

/**
 * The languages a catalog actually ships for, as `{ code, nativeName }` — the
 * Settings ▸ Appearance ▸ Language picker's list. It rides in on the catalog
 * payload, from the same table main resolves a catalog against, so the picker
 * can never offer a language with nothing behind it.
 *
 * `nativeName` is deliberately NOT translated: a language names itself the same
 * way whatever the UI happens to be speaking, and that is exactly what makes
 * this picker usable when the current language is one you cannot read.
 * @returns {Array<{code: string, nativeName: string}>}
 */
export function getLocales() {
  return _locales;
}

/**
 * Apply a resolved catalog payload to module state. Exposed for `init()` and for
 * tests; also reflects the active language onto `<html lang>` when a document is
 * present, which is what the CSS `:lang()` hooks and a screen reader read.
 * @param {{ active?: string, lang?: string, messages?: object, fallback?: object,
 *           locales?: Array }} [payload]
 */
export function applyCatalog({
  active,
  lang,
  messages,
  fallback,
  locales,
} = {}) {
  _active = active || "en";
  _lang = lang || _active.split("-")[0] || "en";
  _messages = messages || {};
  _fallback = fallback || _messages || {};
  _pluralRules = null;
  if (Array.isArray(locales)) _locales = locales;
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = _lang;
  }
}

/**
 * Resolve and apply the active catalog. Call ONCE, before anything renders.
 *
 * There is no fallback transport: under `file://` with this app's CSP the bridge
 * is the only way a catalog can arrive, so a failure here leaves the empty
 * catalogs in place and `t()` returns keys — visible, and never a crash on the
 * launch path.
 * @returns {Promise<string>} the active locale tag
 */
export async function init() {
  let payload = null;
  try {
    payload = (await window.chiphippo?.i18n?.load()) ?? null;
  } catch (err) {
    console.error("[i18n] catalog load failed:", err);
  }
  applyCatalog(payload ?? {});
  return _active;
}
