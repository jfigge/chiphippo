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
 * tests/no-hardcoded-strings.test.js
 *
 * The guard `i18n-catalogs.test.js` cannot be. That one proves every key IN the
 * catalog is translated in every language — but it is blind to a user-facing
 * string that never entered the catalog at all. This is the complement: it scans
 * renderer source for display literals that bypass the `t()` seam, so a fresh
 * leak fails the suite instead of shipping English to all six other languages.
 *
 * WHAT IT LOOKS FOR — the literal forms a component uses to put text on screen:
 *   • `el.textContent = "…"` / `.innerText = "…"`
 *   • `el.title = "…"` / `.placeholder = "…"` / `.ariaLabel = "…"`
 *   • `setAttribute("aria-label" | "title" | "placeholder", "…")`
 *   • `aria-label="…"` / `title="…"` / `placeholder="…"` in an HTML template
 *   • UI-bearing object properties — `label:`/`text:`/`title:`/`message:`/
 *     `placeholder:`/`ariaLabel:`/`hint:`/`detail:`/`confirmLabel:`/… — which is
 *     how `el()` and every dialog helper in this app RECEIVE display text, and
 *     the single highest-value rule here (a `PopupManager.confirm({title, …})`
 *     is invisible to the assignment rules above).
 * A line ending in an open `=` or `(` is joined onto the next before scanning, so
 * a label wrapped for line length is not a blind spot. A literal counts only when
 * it starts with a CAPITAL letter: `${t("…")}` interpolations and lowercase
 * technical tokens (`text/plain`, `nowrap`, enum values) are not prose.
 *
 * WHAT IS DELIBERATELY NOT UI TEXT, each with its reason (`INTENTIONAL`, below):
 * product and format names, and the one legal notice. Whole modules are excluded
 * in `SKIP_FILES`, again each for a stated reason — never as a hiding place.
 *
 * RATCHET, NOT A WALL. Real remaining debt is enumerated in
 * `no-hardcoded-strings.baseline.json`, keyed `relPath::literal`. The test fails
 * when:
 *   • a literal appears that is NOT in the baseline → a NEW leak; route it
 *     through `t()`;
 *   • a baseline entry no longer appears → it was localized; drop it, so the
 *     baseline can only ever SHRINK.
 * After an intentional change, regenerate with:
 *     UPDATE_HARDCODED_BASELINE=1 node --test web/scripts/tests/no-hardcoded-strings.test.js
 *
 * Run with:   node --test web/scripts/tests/no-hardcoded-strings.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.dirname(TESTS_DIR);
const BASELINE_FILE = path.join(
  TESTS_DIR,
  "no-hardcoded-strings.baseline.json",
);

// A literal value is `"…"` or `'…'` whose first character is in `first` — which
// excludes `${t(…)}` interpolations (they start with `$`) and numeric values.
const makeRe = (prefix, first = "A-Za-z") =>
  new RegExp(prefix + `(?:"([${first}][^"]*)"|'([${first}][^']*)')`, "g");

const RULES = [
  // ── Direct assignment / attribute forms ──────────────────────────────────
  makeRe(`\\.(?:textContent|innerText)\\s*=\\s*`),
  makeRe(`\\.(?:title|placeholder|ariaLabel)\\s*=\\s*`),
  makeRe(
    `setAttribute\\(\\s*["'](?:aria-label|title|placeholder)["']\\s*,\\s*`,
  ),
  makeRe(`(?:aria-label|title|placeholder)=`),
  // ── The helper-built form ────────────────────────────────────────────────
  // A UI-bearing property handed to `el()`, to a PopupManager dialog, or to a
  // catalog `properties` field — which the receiver then assigns with
  // `el.textContent = label`, invisible to the rules above. The curated property
  // list is the precision mechanism: `value:`/`key:`/`class:`/`id:`/`ref:` carry
  // DATA, not display text, and are deliberately absent.
  //
  // A capital start is required here (unlike the assignment rules) so the data
  // values that ride these same property names — `text/plain`, lowercase enum
  // tokens, `true`/`false` — do not register; genuine UI prose is capital-start.
  makeRe(
    `\\b(?:label|text|title|hint|placeholder|ariaLabel|desc|description|message|detail|tooltip|caption|summary|note|actionLabel|confirmLabel|cancelLabel|closeAriaLabel|emptyLabel|removeLabel)\\s*:\\s*`,
    "A-Z",
  ),
  // A static text node or <option> label inside an HTML template literal
  // (`>Cancel</button>`). Anchored on the closing `</` so a JS comparison
  // (`a > B && c < D`) never matches.
  />\s*([A-Z][^<>{}$]*?)\s*<\//g,
];

// Shown verbatim in every language, and each for a reason:
//   • the product's own name, and the legal notice under it;
//   • interchange-FORMAT names, which are what the file actually is;
//   • "ASCII", a standard's name rather than a word;
//   • "ON", the SILKSCREEN on a DIP switch bank's body. It is a marking on the
//     physical object, like the "1" beside pin 1 and the part number printed
//     across a chip — every DIP switch in the world carries those two letters,
//     whoever made it and wherever it is sold, so translating it would print
//     something no real part says.
const INTENTIONAL = new Set([
  "Chip Hippo",
  "Copyright © 2026 Jason Figge",
  "SVG",
  "PNG",
  "ASCII",
  "Intel HEX",
  "ON",
]);

// `tests/` is not product code; `vendor/` is a generated bundle (and is exempt
// from the license-header guard and ESLint for the same reason).
const SKIP_DIRS = new Set(["tests", "vendor"]);

// Modules excluded by design, each for a declared reason — an exclusion is a
// stated decision, not somewhere to put an inconvenience:
//   • i18n.js         — its JSDoc and its own fallbacks quote English by nature.
//   • docs-viewer.js  — the in-app User Guide is English-only (ONE Markdown
//                       source drives the viewer, the website and the PDF), so
//                       its chrome stays English to match the pages it lists.
//                       See CLAUDE.md → "Language support".
//   • docs-window.js  — that window's host, same reason.
//   • board-types.js  — the same thing as `catalog/` under another directory: a
//                       table of board SPECS whose `label` is the English source
//                       `catalog/labels.js`'s `kitLabel()` translates through. It
//                       is read under Node by the demo builder too, and
//                       `i18n-catalogs.test.js` holds every `boards.<key>` to
//                       exactly this label, so the two cannot drift.
//   • generate.js     — the same as the two below: `parseNetlist`'s faults, which
//                       are the model's repair instructions before they are UI.
//                       This module is the DOM-free compile → verify → clip seam
//                       and has no chrome of its own; its one progress label is
//                       localized (`ai.gate.compile`).
//   • autobuild-verify.js / autobuild.js — the AI ladder's FAULT messages. They
//                       are protocol text before they are UI: `buildRepairMessage`
//                       sends them back to the model as the repair instruction,
//                       and the system prompt and catalog card they answer are
//                       English by construction. Translating them would degrade
//                       the repair round; the panel shows them beside a fault
//                       CODE, which is what the user acts on. The ladder's own
//                       progress labels ARE localized (`ai.gate.*`).
//   • catalog/*.js    — pure DATA evaluated at import time, so it cannot call
//                       t() at all; its `title`/`label` fields are the English
//                       SOURCE that `catalog/labels.js` translates through, and
//                       `i18n-catalogs.test.js` requires a key for each. A part
//                       `blurb` is datasheet prose and stays English by decision.
const SKIP_FILES = new Set([
  "i18n.js",
  "docs-viewer.js",
  "docs-window.js",
  "board-types.js",
  "generate.js",
  "autobuild-verify.js",
  "autobuild.js",
]);
const SKIP_PATHS = new Set(["catalog"]);

/** Every product `.js` under scripts/, minus what is not translatable UI. */
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || SKIP_PATHS.has(e.name)) continue;
      out.push(...walk(p));
    } else if (e.name.endsWith(".js") && !SKIP_FILES.has(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Scan every product module and return a sorted, de-duplicated set of
 * `relPath::literal` violations. De-duped by (file, value) so it survives a line
 * move, and a value repeated in one file collapses to a single entry.
 * @returns {string[]}
 */
function findViolations() {
  const violations = new Set();
  for (const file of walk(SCRIPTS_DIR)) {
    const rel = path.relative(SCRIPTS_DIR, file);
    const src = fs
      .readFileSync(file, "utf8")
      // Join a line ending in an open `=` or `(` onto the next, so a label
      // wrapped for length — `hint.textContent =\n  "…"` — is still seen. This
      // only adds matches the rules would make if the string sat on the prefix's
      // own line; the comment skip below still fires, because the merged line
      // keeps the prefix's leading `*` / `//`.
      .replace(/([=(])[ \t]*\n[ \t]*/g, "$1 ");
    for (const rawLine of src.split("\n")) {
      // Skip comment lines, so a JSDoc example is not read as a call site.
      const line = rawLine.trim();
      if (
        line.startsWith("*") ||
        line.startsWith("//") ||
        line.startsWith("/*")
      ) {
        continue;
      }
      for (const re of RULES) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(rawLine))) {
          const value = (m[1] ?? m[2]).trim();
          if (value && !INTENTIONAL.has(value)) {
            violations.add(`${rel}::${value}`);
          }
        }
      }
    }
  }
  return [...violations].sort();
}

test("no new hardcoded user-facing strings bypass the t() seam", () => {
  const current = findViolations();

  if (process.env.UPDATE_HARDCODED_BASELINE) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(current, null, 2) + "\n");
    return;
  }

  const baseline = new Set(JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")));
  const currentSet = new Set(current);

  const unexpected = current.filter((v) => !baseline.has(v));
  const stale = [...baseline].filter((v) => !currentSet.has(v)).sort();

  assert.deepEqual(
    unexpected,
    [],
    `${unexpected.length} new hardcoded user-facing string(s) — route each ` +
      `through t() (or, if it is genuinely not translatable, add it to ` +
      `INTENTIONAL with a reason):\n  ${unexpected.join("\n  ")}`,
  );
  assert.deepEqual(
    stale,
    [],
    `${stale.length} baseline entr(ies) no longer found — these were ` +
      `localized. Drop them (UPDATE_HARDCODED_BASELINE=1) so the baseline ` +
      `can't grow back:\n  ${stale.join("\n  ")}`,
  );
});
