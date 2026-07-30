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
 * tests/no-hardcoded-native-strings.test.js
 *
 * The main-process half of the leak guard. The renderer's scanner only reads
 * `web/scripts`, so it is blind to the strings MAIN renders itself — the
 * application menu, each auxiliary window's TITLE BAR, and the native dialogs'
 * file-type filters. None of those can reach the renderer's `t()`, so they resolve
 * through main's own seam instead (`activeCatalog()` → `m(key, fallback)`), and
 * this is what keeps them there.
 *
 * WHAT IT LOOKS FOR — the option keys a `Menu` template, a `BrowserWindow`, or a
 * `dialog.show*` call puts on screen:
 *   • `label:  "…"`               — a menu item
 *   • `title:  "…"`               — a window or dialog title
 *   • `message:"…"` / `detail:"…"`— a message-box body
 *   • `name:   "…"`               — a file-type filter's shown name
 *   • `buttonLabel:"…"`, `buttons: ["…", …]` — dialog buttons
 *
 * A localized call reads `label: m("menu.file.new", "New Project")`, so its
 * English sits as the FALLBACK ARGUMENT to `m()` — after a comma, invisible to
 * these rules. Drop the `m()` wrapper and the literal lands right after the key
 * again, and this fails. That is the whole mechanism.
 *
 * The one escape hatch is `INTENTIONAL`, and it holds exactly the things that are
 * the same in every language: the product's own name, and the file EXTENSIONS
 * beside the filter names that are localized.
 *
 * Run with:   node --test app/tests/no-hardcoded-native-strings.test.js
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Everything main draws with lives in main.js; the store/ and ai/ modules it
// delegates to render nothing. Add a file here if that changes.
const MAIN_FILES = [path.join(__dirname, "..", "main.js")];

/** Native-UI option keys whose value, as a bare literal, is on-screen text. */
const KEY_RE =
  /\b(?:label|title|message|detail|name|buttonLabel)\s*:\s*"([^"]+)"/g;
/** `buttons: ["OK", …]` — flag the first literal in the array. */
const BUTTONS_RE = /\bbuttons\s*:\s*\[\s*"([^"]+)"/g;

// The same in every language:
//   • the product's own name (and the appId / bundle strings built from it);
//   • a file EXTENSION — `chiphippo`, `bin`, `hex` — which is what the file IS.
//     The filter NAME beside it is localized; this is the `extensions` array's
//     own `name:`-adjacent noise, plus the two window kinds Electron names.
const INTENTIONAL = new Set(["Chip Hippo"]);

/** Scan the main-process files and return the sorted set of flagged literals. */
function findViolations() {
  const found = new Set();
  for (const file of MAIN_FILES) {
    const src = fs.readFileSync(file, "utf8");
    for (const rawLine of src.split("\n")) {
      const line = rawLine.trim();
      // Skip comment lines, so a JSDoc example is not read as a call site.
      if (
        line.startsWith("*") ||
        line.startsWith("//") ||
        line.startsWith("/*")
      ) {
        continue;
      }
      for (const re of [KEY_RE, BUTTONS_RE]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(rawLine))) {
          const value = m[1].trim();
          if (value && !INTENTIONAL.has(value)) found.add(value);
        }
      }
    }
  }
  return [...found].sort();
}

test("every native menu / window / dialog string resolves through the catalog", () => {
  const current = findViolations();
  assert.deepEqual(
    current,
    [],
    `${current.length} hardcoded native-UI string(s) in main.js — route each ` +
      `through m("area.key", "English fallback"), which reads the active ` +
      `catalog:\n  ${current.join("\n  ")}`,
  );
});

test("the menu really is built from the catalog, not from literals", () => {
  // The complement of the scan above: it proves the ABSENCE of literals, which
  // an empty menu would also satisfy. This proves the presence of the seam.
  const src = fs.readFileSync(MAIN_FILES[0], "utf8");
  const calls = [...src.matchAll(/\bm\("([a-z][A-Za-z0-9.]*)",\s*"/g)].map(
    (x) => x[1],
  );
  assert.ok(
    calls.length >= 25,
    `expected the menu + dialogs to read many keys, found ${calls.length}`,
  );
  // Every one of them has to actually exist, or the fallback silently becomes
  // the only thing anybody ever sees — English, in every language.
  const en = require("../i18n").readCatalog("en");
  const pick = (key) =>
    key
      .split(".")
      .reduce((node, part) => (node == null ? node : node[part]), en);
  const unknown = [...new Set(calls)].filter(
    (k) => typeof pick(k) !== "string",
  );
  assert.deepEqual(
    unknown,
    [],
    `${unknown.length} m() key(s) are absent from en.json, so only their ` +
      `English fallback can ever show:\n  ${unknown.join("\n  ")}`,
  );
});
