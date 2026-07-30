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
 * The renderer's translation seam (scripts/i18n.js) — the one thing every
 * user-facing string in the app passes through. These pin the contract every
 * component and every catalog relies on:
 *   • dotted-key lookup against a nested catalog;
 *   • {name} interpolation, with an unknown placeholder left intact;
 *   • the resolution order — active catalog → English fallback → the key itself
 *     — so an un-translated or un-migrated string never throws and never blanks;
 *   • `tf()`, which falls back to a LITERAL rather than to the key (the parts
 *     catalog's own English; see catalog/labels.js);
 *   • plural selection through Intl.PluralRules from a CLDR-category object;
 *   • locale-aware number/date formatting;
 *   • applyCatalog reflecting the active language onto <html lang>.
 *
 * Driven directly through applyCatalog() with fixtures — no IPC and no Electron.
 * jsdom is imported only so applyCatalog has a document to set `lang` on.
 *
 * Run with:   node --test web/scripts/tests/i18n.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const {
  t,
  tf,
  formatNumber,
  formatDate,
  getLocale,
  getLang,
  getLocales,
  applyCatalog,
} = await import("../i18n.js");

// ── Fixtures ────────────────────────────────────────────────────────────────
// `de` is deliberately PARTIAL: it omits `items` and `only.en`, so those exercise
// the English fallback path rather than being tested only in theory.
const en = {
  common: { cancel: "Cancel" },
  greeting: "Hello {name}",
  items: { one: "{count} item", other: "{count} items" },
  group: { nested: "leaf" },
  only: { en: "English only" },
};
const de = {
  common: { cancel: "Abbrechen" },
  greeting: "Hallo {name}",
};

function useDe() {
  applyCatalog({ active: "de", lang: "de", messages: de, fallback: en });
}
function useEn() {
  applyCatalog({ active: "en", lang: "en", messages: en, fallback: en });
}

// ── Lookup + interpolation ──────────────────────────────────────────────────

test("t(): resolves a dotted key against the active nested catalog", () => {
  useDe();
  assert.equal(t("common.cancel"), "Abbrechen");
});

test("t(): interpolates {name} placeholders", () => {
  useDe();
  assert.equal(t("greeting", { name: "Ada" }), "Hallo Ada");
});

test("t(): leaves an unmatched placeholder intact", () => {
  // A missing param has to be VISIBLE — a silent gap in a sentence reads as a
  // translation problem when it is actually a call-site one.
  useEn();
  assert.equal(t("greeting"), "Hello {name}");
  assert.equal(t("greeting", { other: "x" }), "Hello {name}");
});

// ── The fallback chain ──────────────────────────────────────────────────────

test("t(): falls back to English for a key the active locale is missing", () => {
  useDe(); // de has no `only.en`
  assert.equal(t("only.en"), "English only");
});

test("t(): falls back to the key itself when it is absent from both", () => {
  useDe();
  assert.equal(t("does.not.exist"), "does.not.exist");
});

test("t(): a group node is not renderable, so the key comes back", () => {
  useEn();
  assert.equal(t("group"), "group");
});

// ── tf(): the literal fallback ──────────────────────────────────────────────

test("tf(): prefers the catalog, then the supplied literal", () => {
  useDe();
  assert.equal(tf("common.cancel", "Cancel"), "Abbrechen");
  // This is the parts-catalog case: no `parts.*` key here, so the def's own
  // English shows rather than a raw dotted key.
  assert.equal(tf("parts.74LS00.title", "Quad 2-input NAND"), "Quad 2-input NAND"); // prettier-ignore
});

test("tf(): interpolates the fallback too", () => {
  applyCatalog({}); // nothing loaded at all
  assert.equal(tf("a.b", "Pin {n}", { n: 7 }), "Pin 7");
});

test("tf(): a nullish fallback degrades to empty, never to 'undefined'", () => {
  applyCatalog({});
  assert.equal(tf("a.b", null), "");
  assert.equal(tf("a.b", undefined), "");
});

// ── Plurals ─────────────────────────────────────────────────────────────────

test("t(): selects a plural form from a numeric count", () => {
  useEn();
  assert.equal(t("items", { count: 1 }), "1 item");
  assert.equal(t("items", { count: 5 }), "5 items");
  assert.equal(t("items", { count: 0 }), "0 items");
});

test("t(): plural lookup follows the English fallback as well", () => {
  useDe(); // de omits `items` → resolved from en, then pluralized
  assert.equal(t("items", { count: 1 }), "1 item");
  assert.equal(t("items", { count: 2 }), "2 items");
});

test("t(): a plural object with no count is a group node, so the key comes back", () => {
  useEn();
  assert.equal(t("items"), "items");
});

test("t(): a locale with only `other` still resolves every count", () => {
  // Chinese and Japanese have one plural form; `other` has to serve for all.
  applyCatalog({
    active: "zh",
    lang: "zh",
    messages: { items: { other: "{count} 個" } },
    fallback: en,
  });
  assert.equal(t("items", { count: 1 }), "1 個");
  assert.equal(t("items", { count: 7 }), "7 個");
});

// ── Format helpers ──────────────────────────────────────────────────────────

test("formatNumber(): groups digits for the active locale", () => {
  useEn();
  assert.equal(formatNumber(1234.5), "1,234.5");
  useDe();
  assert.equal(formatNumber(1234.5), "1.234,5");
});

test("formatDate(): '' for an invalid date, non-empty otherwise", () => {
  useEn();
  assert.equal(formatDate("not-a-date"), "");
  assert.equal(formatDate(NaN), "");
  assert.ok(formatDate(0).length > 0, "the epoch formats to something");
});

// ── Active-locale state ─────────────────────────────────────────────────────

test("applyCatalog(): exposes the active locale + language and sets <html lang>", () => {
  resetDom();
  useDe();
  assert.equal(getLocale(), "de");
  assert.equal(getLang(), "de");
  assert.equal(document.documentElement.lang, "de");

  useEn();
  assert.equal(getLang(), "en");
  assert.equal(document.documentElement.lang, "en");
});

test("applyCatalog(): derives lang from a region-qualified tag, and defaults safely", () => {
  applyCatalog({ active: "en-GB", messages: en, fallback: en });
  assert.equal(getLang(), "en");

  applyCatalog({});
  assert.equal(getLocale(), "en");
  assert.equal(
    t("anything"),
    "anything",
    "an empty catalog passes keys through",
  );
});

test("getLocales(): carries the shipped-language list off the payload", () => {
  const locales = [
    { code: "en", nativeName: "English" },
    { code: "ja", nativeName: "日本語" },
  ];
  applyCatalog({ active: "en", messages: en, fallback: en, locales });
  assert.deepEqual(getLocales(), locales);
  // A payload with no `locales` must not WIPE the list — main sends it once, and
  // a test (or a re-apply) that omits it is not saying "there are none".
  applyCatalog({ active: "en", messages: en, fallback: en });
  assert.deepEqual(getLocales(), locales);
});
