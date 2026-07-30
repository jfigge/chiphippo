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
 * tests/i18n-catalogs.test.js
 *
 * THE UNTRANSLATED-STRING GUARD. `en.json` is the reference catalog, and this
 * holds every shipped locale to it in the four ways a translation silently goes
 * wrong:
 *
 *   1. A MISSING KEY. `t()` falls back to English rather than blanking, which is
 *      exactly why a gap is invisible: a German user sees one English label
 *      among two hundred German ones and reasonably assumes it is a proper noun.
 *      So a locale must cover en.json's leaf keys EXACTLY — no fewer, and no
 *      extras either (an extra is a key that was renamed in en.json and left
 *      behind here, i.e. a translation nothing will ever read).
 *   2. A LOST PLACEHOLDER. `{name}`/`{count}` are filled at render time; drop
 *      one in translation and the sentence renders with a hole where the file
 *      name, the chip, or the count should be. Every locale must carry the same
 *      SET of placeholders as English, per key.
 *   3. A BROKEN PLURAL. A plural leaf is an object of CLDR categories; if English
 *      has one and a locale spells it as a flat string (or the reverse), the
 *      count either never substitutes or the whole lookup returns the key.
 *   4. AN EMPTY STRING. A blank value passes a "does the key exist" check and
 *      renders as nothing at all — a button with no label.
 *
 * And the two ways the CODE goes out of step with the catalog:
 *
 *   5. A KEY THE SOURCE ASKS FOR THAT DOES NOT EXIST. `t("zoom.out")` with no
 *      such key renders the literal text `zoom.out` on screen. This scans every
 *      renderer module for `t("…")` and requires each key to be in en.json —
 *      which is a real bug this test caught the first time it was run.
 *   6. A CATALOG PART WITH NO TRANSLATION KEY. A part's `title` reaches the UI
 *      through `tf("parts.<id>.title", def.title)` (see catalog/labels.js), so a
 *      part added without a catalog entry reads correctly but is never
 *      translated — silently, in every language.
 *
 * Run with:   node --test web/scripts/tests/i18n-catalogs.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PALETTE_DEFS } from "../catalog/index.js";
import {
  BREADBOARD_KITS,
  KIT_KEYS,
  STRIP_KIT_KEYS,
} from "../model/board-types.js";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.dirname(TESTS_DIR);
const LOCALES_DIR = path.join(SCRIPTS_DIR, "..", "locales");

/** Every language a catalog ships for, English first (mirrors app/i18n.js's
    LOCALES — which its own test holds against these same files). */
const LOCALES = ["en", "de", "es", "fr", "it", "ja", "zh"];
const TRANSLATIONS = LOCALES.filter((l) => l !== "en");

const read = (lang) =>
  JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${lang}.json`), "utf8"));

// ── Catalog shape helpers ───────────────────────────────────────────────────

const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];

/** A plural leaf: an object whose keys are ALL CLDR categories. */
const isPluralLeaf = (v) =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length > 0 &&
  Object.keys(v).every((k) => PLURAL_CATEGORIES.includes(k));

/** Flatten to [dottedKey, value] pairs. `_meta` is documentation, not a key, and
    a plural object counts as ONE leaf — so a language with fewer plural forms
    than English is still complete. */
function flatten(obj, prefix = "") {
  return Object.entries(obj).flatMap(([k, v]) => {
    if (!prefix && k === "_meta") return [];
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPluralLeaf(v)) return [[key, v]];
    if (v !== null && typeof v === "object") return flatten(v, key);
    return [[key, v]];
  });
}

/** The `{placeholder}` names in a leaf (string or plural object), sorted. */
function placeholders(value) {
  const texts =
    typeof value === "string" ? [value] : Object.values(value ?? {});
  const found = new Set();
  for (const s of texts) {
    for (const m of String(s).matchAll(/\{(\w+)\}/g)) found.add(m[1]);
  }
  return [...found].sort();
}

const EN = read("en");
const EN_FLAT = flatten(EN);
const EN_MAP = new Map(EN_FLAT);

// ── 1. Every locale parses, and covers en.json exactly ──────────────────────

test("every shipped catalog parses and declares its own language", () => {
  for (const lang of LOCALES) {
    const cat = read(lang);
    assert.ok(cat && typeof cat === "object", `${lang}.json is an object`);
    assert.ok(
      typeof cat._meta?.language === "string" && cat._meta.language,
      `${lang}.json names its language in _meta`,
    );
  }
});

test("every locale covers en.json's keys exactly — none missing, none stale", () => {
  const enKeys = new Set(EN_MAP.keys());
  for (const lang of TRANSLATIONS) {
    const have = new Set(flatten(read(lang)).map(([k]) => k));
    const missing = [...enKeys].filter((k) => !have.has(k)).sort();
    const stale = [...have].filter((k) => !enKeys.has(k)).sort();
    assert.deepEqual(
      missing,
      [],
      `${lang}.json is missing ${missing.length} key(s) — they would silently ` +
        `render in English:\n  ${missing.join("\n  ")}`,
    );
    assert.deepEqual(
      stale,
      [],
      `${lang}.json has ${stale.length} key(s) that en.json does not — a rename ` +
        `left them behind, so nothing will ever read them:\n  ${stale.join("\n  ")}`,
    );
  }
});

// ── 2/3/4. Placeholders, plural shape, and non-emptiness ────────────────────

test("every translation preserves its key's {placeholders}", () => {
  for (const lang of TRANSLATIONS) {
    const cat = new Map(flatten(read(lang)));
    const wrong = [];
    for (const [key, enValue] of EN_FLAT) {
      const want = placeholders(enValue);
      const got = placeholders(cat.get(key));
      if (want.join(",") !== got.join(",")) {
        wrong.push(`${key}: expected {${want}}, got {${got}}`);
      }
    }
    assert.deepEqual(
      wrong,
      [],
      `${lang}.json changes the placeholders of ${wrong.length} key(s) — the ` +
        `value would render as a gap:\n  ${wrong.join("\n  ")}`,
    );
  }
});

test("a plural key is a plural object in every locale, with valid categories", () => {
  for (const lang of TRANSLATIONS) {
    const cat = new Map(flatten(read(lang)));
    const wrong = [];
    for (const [key, enValue] of EN_FLAT) {
      const value = cat.get(key);
      const enPlural = isPluralLeaf(enValue);
      const trPlural = isPluralLeaf(value);
      if (enPlural && !trPlural) wrong.push(`${key}: not a plural object`);
      if (!enPlural && trPlural) wrong.push(`${key}: unexpectedly a plural object`); // prettier-ignore
      // "other" is the only category every language has, so it is the one that
      // must always be there — it is what a count with no matching form uses.
      if (enPlural && trPlural && !value.other) {
        wrong.push(`${key}: a plural object with no "other" form`);
      }
    }
    assert.deepEqual(wrong, [], `${lang}.json: ${wrong.join("; ")}`);
  }
});

test("no catalog carries an empty or non-string value", () => {
  for (const lang of LOCALES) {
    const bad = [];
    for (const [key, value] of flatten(read(lang))) {
      const texts = isPluralLeaf(value) ? Object.values(value) : [value];
      for (const s of texts) {
        if (typeof s !== "string")
          bad.push(`${key}: ${typeof s}, not a string`);
        else if (s.trim() === "") bad.push(`${key}: empty`);
      }
    }
    assert.deepEqual(bad, [], `${lang}.json: ${bad.join("; ")}`);
  }
});

// ── 5. Every key the source asks for exists ─────────────────────────────────

// The renderer's own modules, minus what is not product UI. `vendor/` is a
// generated bundle; `docs-viewer.js` is the English-only user guide's viewer
// (see CLAUDE.md → "Language support").
const SKIP_DIRS = new Set(["tests", "vendor"]);
const SKIP_FILES = new Set(["docs-viewer.js"]);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...walk(p));
    } else if (e.name.endsWith(".js") && !SKIP_FILES.has(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Every LITERAL key passed to `t()` / `tf()`, as `key → [files]`.
 *
 * Literal only, deliberately: a computed key (`t(`guide.tab.${id}`)`) cannot be
 * resolved by reading the source, and guessing at one would either miss real
 * gaps or invent false ones. The template-literal forms are covered instead by
 * the component tests that render those elements — with the real en.json loaded
 * (see jsdom-setup.js), so a missing key shows up there as a raw dotted key in
 * an assertion.
 */
function usedKeys() {
  const found = new Map();
  // The string has to be the WHOLE first argument — hence the trailing `[,)]`,
  // and the key's last character being a word character rather than a dot. Both
  // guard against `t("area.thing." + n)`, where the literal is only a PREFIX and
  // flagging it would be a false report of a missing key (Rest Hippo's settings
  // popup builds a key exactly that way, which is where this was noticed).
  const re = /\bt[f]?\(\s*"([a-z][A-Za-z0-9.\-_]*[A-Za-z0-9])"\s*[,)]/g;
  for (const file of walk(SCRIPTS_DIR)) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(SCRIPTS_DIR, file);
    for (const line of src.split("\n")) {
      const trimmed = line.trim();
      // Skip comments so a JSDoc example is not read as a call site.
      if (
        trimmed.startsWith("*") ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*")
      ) {
        continue;
      }
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        if (!found.has(m[1])) found.set(m[1], new Set());
        found.get(m[1]).add(rel);
      }
    }
  }
  return found;
}

test("every t()/tf() key in the source exists in en.json", () => {
  // A key with no entry renders as the KEY — `zoom.out` in a tooltip, which is
  // how this test earned its place.
  const used = usedKeys();
  assert.ok(used.size > 100, `expected many call sites, found ${used.size}`);
  const unknown = [...used.entries()]
    .filter(([key]) => !EN_MAP.has(key))
    .map(([key, files]) => `${key}  (${[...files].sort().join(", ")})`)
    .sort();
  assert.deepEqual(
    unknown,
    [],
    `${unknown.length} key(s) are asked for but not in en.json — each would ` +
      `render as its own dotted key on screen:\n  ${unknown.join("\n  ")}`,
  );
});

// ── 6. The parts catalog ────────────────────────────────────────────────────

test("every palette part has a parts.<id>.title in every locale", () => {
  // `tf()` falls back to the def's own English, so a missing entry is invisible
  // at runtime — this is the only thing that says so.
  const missing = PALETTE_DEFS.filter(
    (def) => !EN_MAP.has(`parts.${def.id}.title`),
  ).map((def) => def.id);
  assert.deepEqual(
    missing,
    [],
    `${missing.length} catalog part(s) have no parts.<id>.title in en.json — ` +
      `they will never be translated: ${missing.join(", ")}`,
  );
  // The exact-coverage test above then guarantees every other locale has them.
});

test("every board kit has a boards.<key> in en.json", () => {
  const missing = [...KIT_KEYS, ...STRIP_KIT_KEYS].filter(
    (key) => !EN_MAP.has(`boards.${key}`),
  );
  assert.deepEqual(
    missing,
    [],
    `board kit(s) with no boards.<key>: ${missing.join(", ")}`,
  );
  // And the English text has to still MATCH the catalog, or the two disagree
  // about what a kit is called with no language change involved.
  for (const key of [...KIT_KEYS, ...STRIP_KIT_KEYS]) {
    assert.equal(
      EN_MAP.get(`boards.${key}`),
      BREADBOARD_KITS[key].label,
      `boards.${key} must match the catalog's own label`,
    );
  }
});

test("every catalog GROUP has a palette.group.<slug> in en.json", () => {
  // palette-panel.js derives the leaf from the English name, so a new group
  // needs one entry — and nothing else — to be translated.
  const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const groups = [...new Set(PALETTE_DEFS.map((d) => d.group))];
  const missing = groups.filter((g) => !EN_MAP.has(`palette.group.${slug(g)}`));
  assert.deepEqual(
    missing,
    [],
    `catalog group(s) with no palette.group entry: ${missing.join(", ")}`,
  );
});

test("every wire/LED colour token has a colors.<token> in en.json", async () => {
  const { WIRE_COLORS } = await import("../model/desk-doc.js");
  const { LED_COLOR_OPTIONS } = await import("../catalog/parts.js");
  const tokens = [...new Set([...WIRE_COLORS, ...LED_COLOR_OPTIONS])];
  const missing = tokens.filter((c) => !EN_MAP.has(`colors.${c}`));
  assert.deepEqual(
    missing,
    [],
    `colour token(s) with no colors.<token> entry: ${missing.join(", ")}`,
  );
});
