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

// i18n.js — Main-process locale resolver + catalog reader.
"use strict";

/**
 * The renderer is sandboxed and cannot read files, and every window is served
 * from `file://` — so the main process (which owns all filesystem I/O and the OS
 * locale) resolves the active locale and hands each renderer a ready-to-use
 * catalog over the `i18n:load` IPC channel. There is no `fetch()` fallback for
 * the renderer to fall back ON: `file://` + the app's CSP means this module is
 * the only route a catalog can arrive by.
 *
 * Resolution order for the active locale:
 *   1. the persisted preference (settings.locale), unless it is "system"
 *   2. otherwise the OS locale (app.getLocale(), e.g. "en-US")
 *   3. falling back to English when no catalog ships for the chosen language
 *
 * Catalogs are bundled JSON under src/web/locales (shipped by electron-builder's
 * existing `web/**` glob — they need no packaging change). The English catalog is
 * ALWAYS returned as the fallback alongside the active one, so the renderer can
 * fill a missing key regardless of which language is showing.
 *
 * Main renders user-facing strings itself in three places the renderer's `t()`
 * cannot reach — the application menu, the native dialogs, and each auxiliary
 * window's TITLE — so `label()` below is the same lookup for those.
 */

const fs = require("fs");
const path = require("path");

/** Bundled catalog directory — resolved relative to this file (app/ → web/). */
const LOCALES_DIR = path.join(__dirname, "..", "web", "locales");

/**
 * Every language a catalog ships for, English first. The renderer's picker is
 * built from this list over IPC (`i18n:locales`) rather than from a copy of its
 * own, so a language cannot appear in Settings with no catalog behind it.
 * `nativeName` is deliberately NOT translated: a language names itself the same
 * way whatever the UI is currently speaking, which is what makes a picker
 * usable when you cannot read the language it is showing.
 */
const LOCALES = Object.freeze([
  Object.freeze({ code: "en", nativeName: "English" }),
  Object.freeze({ code: "de", nativeName: "Deutsch" }),
  Object.freeze({ code: "es", nativeName: "Español" }),
  Object.freeze({ code: "fr", nativeName: "Français" }),
  Object.freeze({ code: "it", nativeName: "Italiano" }),
  Object.freeze({ code: "ja", nativeName: "日本語" }),
  Object.freeze({ code: "zh", nativeName: "中文（简体）" }),
]);

/**
 * Read and parse the catalog for a primary language subtag (e.g. "en", "de").
 * The subtag is validated against a strict pattern before it is used in a path,
 * so a malformed or hostile locale can never escape LOCALES_DIR.
 * @param {string} lang
 * @returns {object|null} parsed catalog, or null when absent / unreadable
 */
function readCatalog(lang) {
  if (typeof lang !== "string" || !/^[a-z]{2,3}$/i.test(lang)) return null;
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(LOCALES_DIR, `${lang.toLowerCase()}.json`),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
}

/**
 * Resolve the active locale and load its catalog plus the English fallback.
 * Always returns a usable payload, even when every read fails (empty catalogs) —
 * the renderer then shows keys, which is ugly but never blank and never throws.
 *
 * @param {{ requested?: string, systemLocale?: string }} [opts]
 *   requested     — settings.locale: "system" | a locale tag | undefined
 *   systemLocale  — app.getLocale(), e.g. "en-US"
 * @returns {{ requested: string, system: string, active: string, lang: string,
 *             messages: object, fallback: object }}
 */
function loadCatalog({ requested, systemLocale } = {}) {
  const en = readCatalog("en") || {};
  const system = String(systemLocale || "en");

  // Step 1–2: choose the desired locale tag.
  const desired =
    requested && requested !== "system" ? String(requested) : system;
  const lang = (desired.split("-")[0] || "en").toLowerCase();

  // Step 3: load it, falling back to English when no catalog ships.
  let active = desired;
  let messages = en;
  if (lang !== "en") {
    const loc = readCatalog(lang);
    if (loc) {
      messages = loc;
    } else {
      active = "en"; // no catalog for this language → English
    }
  }

  return {
    requested: requested || "system",
    system,
    active,
    lang: (active.split("-")[0] || "en").toLowerCase(),
    messages,
    fallback: en,
  };
}

/**
 * Resolve a dotted key against a loaded catalog payload (from loadCatalog),
 * following the same active → English-fallback → literal chain the renderer's
 * `t()` uses. For the user-facing strings the MAIN process renders itself — the
 * application menu, the native dialogs, and the auxiliary window titles — which
 * cannot reach the renderer's catalog.
 *
 * `{name}` placeholders are interpolated from `params`, so a dialog line can
 * name the file it is about.
 *
 * @param {{ messages: object, fallback: object }} cat
 * @param {string} key       dotted key, e.g. "menu.file.new"
 * @param {string} fallback  literal returned if the key is absent everywhere
 * @param {object} [params]  {name} interpolation values
 * @returns {string}
 */
function label(cat, key, fallback, params) {
  const pick = (obj) => {
    let node = obj;
    for (const part of key.split(".")) {
      if (node == null) return undefined;
      node = node[part];
    }
    return typeof node === "string" ? node : undefined;
  };
  const msg = pick(cat?.messages) ?? pick(cat?.fallback) ?? fallback;
  if (!params) return msg;
  return String(msg).replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(params, name)
      ? String(params[name])
      : m,
  );
}

module.exports = { loadCatalog, readCatalog, label, LOCALES_DIR, LOCALES };
