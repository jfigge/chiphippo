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

/**
 * tests/i18n.test.js
 *
 * The MAIN-process locale resolver (app/i18n.js), against the real bundled
 * catalogs under web/locales. The renderer can neither read files nor see the OS
 * locale, so this module alone decides which language the app speaks; an
 * off-by-one in its resolution order (persisted preference → OS locale →
 * English) would ship the wrong language with no other signal at all.
 *
 * Pins:
 *   • an explicit preference wins, and loads that catalog;
 *   • "system" / an absent preference resolves from the OS locale;
 *   • a language with no shipped catalog falls back to English — `active` says so
 *     while `system` still reports what was asked for, for diagnostics;
 *   • the English catalog always rides along as the fallback;
 *   • readCatalog refuses anything that is not a bare language subtag, which is
 *     what stops a crafted locale from escaping the locales directory;
 *   • label() follows the same active → English → literal chain, and interpolates
 *     — it is how the native menu and the dialogs get their words.
 *
 * Run with:   node --test app/tests/i18n.test.js
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadCatalog, readCatalog, label, LOCALES } = require("../i18n");

// ── loadCatalog: the resolution order ───────────────────────────────────────

test("loadCatalog: an explicit preference loads that locale's catalog", () => {
  const r = loadCatalog({ requested: "de", systemLocale: "en-US" });
  assert.equal(r.active, "de");
  assert.equal(r.lang, "de");
  assert.equal(r.requested, "de");
  assert.equal(r.messages.common.cancel, "Abbrechen");
  // English always travels alongside, so a missing key still renders.
  assert.equal(r.fallback.common.cancel, "Cancel");
});

test("loadCatalog: an English preference returns the English catalog", () => {
  const r = loadCatalog({ requested: "en", systemLocale: "de-DE" });
  assert.equal(r.active, "en");
  assert.equal(r.messages.common.cancel, "Cancel");
});

test("loadCatalog: 'system' resolves from the OS locale, region and all", () => {
  const r = loadCatalog({ requested: "system", systemLocale: "fr-CA" });
  assert.equal(r.lang, "fr");
  assert.equal(r.messages.common.cancel, "Annuler");
});

test("loadCatalog: an absent preference behaves like 'system'", () => {
  const r = loadCatalog({ systemLocale: "es-ES" });
  assert.equal(r.requested, "system");
  assert.equal(r.lang, "es");
  assert.equal(r.messages.common.cancel, "Cancelar");
});

test("loadCatalog: a language with no catalog falls back to English", () => {
  // Korean ships no catalog, so it has to come back as English.
  const r = loadCatalog({ requested: "system", systemLocale: "ko-KR" });
  assert.equal(r.active, "en");
  assert.equal(r.lang, "en");
  assert.equal(r.messages.common.cancel, "Cancel");
  // What was ASKED for is still reported, which is the diagnostic value.
  assert.equal(r.system, "ko-KR");
});

test("loadCatalog: an unknown explicit locale falls back to English", () => {
  const r = loadCatalog({ requested: "zz", systemLocale: "en-US" });
  assert.equal(r.active, "en");
  assert.equal(r.messages.common.cancel, "Cancel");
});

test("loadCatalog: tolerates a missing systemLocale", () => {
  const r = loadCatalog({});
  assert.equal(r.active, "en");
  assert.equal(r.lang, "en");
});

// ── readCatalog: path safety ────────────────────────────────────────────────

test("readCatalog: loads a bundled catalog by subtag", () => {
  assert.equal(readCatalog("en").common.cancel, "Cancel");
  assert.equal(readCatalog("ja").common.cancel, "キャンセル");
  assert.equal(readCatalog("EN").common.cancel, "Cancel", "case-insensitive");
});

test("readCatalog: refuses anything that is not a bare language subtag", () => {
  // The locale reaches this from settings.json and from app.getLocale(), so the
  // pattern is what keeps a crafted value from naming a file of its own.
  assert.equal(readCatalog("../../package"), null);
  assert.equal(readCatalog("en/../en"), null);
  assert.equal(readCatalog("en.json"), null);
  assert.equal(readCatalog(""), null);
  assert.equal(readCatalog(null), null);
  assert.equal(readCatalog("english"), null);
});

// ── label(): what main renders itself ───────────────────────────────────────

test("label: resolves from the active catalog", () => {
  const cat = loadCatalog({ requested: "de" });
  assert.equal(label(cat, "menu.file.save", "Save"), "Speichern");
});

test("label: falls back to English, then to the literal", () => {
  const cat = {
    messages: { menu: { file: {} } },
    fallback: { menu: { file: { save: "Save" } } },
  };
  assert.equal(label(cat, "menu.file.save", "XXX"), "Save");
  assert.equal(label(cat, "menu.file.nothing", "Fallback"), "Fallback");
  assert.equal(label(null, "any.key", "Fallback"), "Fallback");
});

test("label: a group node is not renderable, so the literal wins", () => {
  const cat = { messages: { menu: { file: { save: "Save" } } }, fallback: {} };
  assert.equal(label(cat, "menu.file", "Literal"), "Literal");
});

test("label: interpolates {name} placeholders", () => {
  const cat = { messages: { greet: "Hallo {name}" }, fallback: {} };
  assert.equal(label(cat, "greet", "Hi {name}", { name: "Ada" }), "Hallo Ada");
  // An unmatched placeholder stays put, so a missing param is visible.
  assert.equal(label(cat, "greet", "Hi {name}", {}), "Hallo {name}");
});

// ── The shipped-language table ──────────────────────────────────────────────

test("LOCALES: English leads, and every entry has a catalog behind it", () => {
  assert.equal(LOCALES[0].code, "en", "English is the reference catalog");
  for (const { code, nativeName } of LOCALES) {
    assert.ok(readCatalog(code), `${code}.json ships`);
    assert.ok(
      typeof nativeName === "string" && nativeName.length > 0,
      `${code} names itself`,
    );
  }
  const codes = LOCALES.map((l) => l.code);
  assert.equal(new Set(codes).size, codes.length, "no duplicate codes");
});
