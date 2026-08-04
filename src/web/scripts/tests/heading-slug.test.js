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

// heading-slug.test.js — the user guide's ONE heading id rule (heading-slug.js).
//
// Two jobs, and the second is the one that earns its keep. The first pins
// GitHub's slugger, so the app, the website, the PDF and GitHub itself keep
// agreeing on the id a heading gets. The second sweeps every `#fragment` an
// author has written across src/web/docs/*.md and resolves it against the real
// headings — a dead anchor renders as an ordinary link that silently goes
// nowhere, which no amount of reading the diff catches.
//
// The rule used to live in TWO copies that disagreed about collapsing hyphen
// runs, so the last test here is a ratchet against a third one appearing.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { slugifyHeading, slugifyHeadingHtml } from "../heading-slug.js";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.dirname(TESTS_DIR); // src/web/scripts
const ROOT = path.resolve(SCRIPTS_DIR, "../../.."); // repo root
const DOCS_DIR = path.join(SCRIPTS_DIR, "../docs");

// ── The rule ────────────────────────────────────────────────────────────────

test("slugifyHeading matches GitHub, punctuation runs and all", () => {
  const cases = [
    ["Selecting things", "selecting-things"],
    ["Pan, zoom & fit to screen", "pan-zoom--fit-to-screen"],
    ["  Trimmed  ", "trimmed"],
    ["Rows & Columns", "rows--columns"],
    ["What's next?", "whats-next"],
    ["Cmd+F", "cmdf"],
    ["one-hole, one-lead", "one-hole-one-lead"],
  ];
  for (const [text, want] of cases) {
    assert.equal(slugifyHeading(text), want, `slug for "${text}"`);
  }
});

test("consecutive hyphens are NEVER collapsed — the divergence that was", () => {
  // The em dash is dropped as punctuation and leaves the spaces either side of
  // it behind, so this heading is TWO hyphens in every output. Collapsing them
  // (as the in-app viewer used to) makes an author-written link resolve in one
  // renderer and 404 in the others.
  assert.equal(
    slugifyHeading("Moving a seated part — with or without its wiring"),
    "moving-a-seated-part--with-or-without-its-wiring",
  );
  assert.equal(slugifyHeading("A — B — C"), "a--b--c");
});

test("slugifyHeading is null-safe", () => {
  assert.equal(slugifyHeading(undefined), "");
  assert.equal(slugifyHeading(null), "");
});

test("the HTML form strips tags and decodes entities to the SAME id", () => {
  // The website slugs from marked's output, the viewer from the DOM's
  // textContent. Both must land on one id or the guide's own links split.
  assert.equal(
    slugifyHeadingHtml("Power &amp; Clock Sources"),
    slugifyHeading("Power & Clock Sources"),
  );
  assert.equal(
    slugifyHeadingHtml("The <code>desk</code> padlock"),
    slugifyHeading("The desk padlock"),
  );
  assert.equal(
    slugifyHeadingHtml("Wires &lt;-&gt; nets &#39;n&#39; buses"),
    slugifyHeading("Wires <-> nets 'n' buses"),
  );
});

// ── The corpus ──────────────────────────────────────────────────────────────

/** Every guide page's headings, keyed by page slug (the .md basename). */
function guideHeadings() {
  const byPage = new Map();
  for (const file of fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".md"))) {
    const md = fs.readFileSync(path.join(DOCS_DIR, file), "utf8");
    const ids = new Set();
    // Headings only outside fenced code blocks — a `# comment` in a shell
    // sample is not a heading and gets no id.
    let fenced = false;
    for (const line of md.split("\n")) {
      if (/^\s*```/.test(line)) fenced = !fenced;
      else if (!fenced) {
        const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
        if (m) ids.add(slugifyHeading(m[1].replace(/[`*_]/g, "")));
      }
    }
    byPage.set(file.replace(/\.md$/, ""), ids);
  }
  return byPage;
}

test("every #fragment in the user guide resolves to a real heading", () => {
  const byPage = guideHeadings();
  const dead = [];
  for (const page of byPage.keys()) {
    const md = fs.readFileSync(path.join(DOCS_DIR, `${page}.md`), "utf8");
    // [text](page.md#fragment) and the same-page [text](#fragment)
    for (const m of md.matchAll(/\]\(([A-Za-z0-9._-]*\.md)?#([^)\s]+)\)/g)) {
      const target = (m[1] ?? `${page}.md`).replace(/\.md$/, "");
      const ids = byPage.get(target);
      if (!ids) dead.push(`${page}.md → ${m[1]} (no such page)`);
      else if (!ids.has(m[2])) dead.push(`${page}.md → ${target}#${m[2]}`);
    }
  }
  assert.deepEqual(dead, [], `dead anchors:\n  ${dead.join("\n  ")}`);
});

// ── The ratchet ─────────────────────────────────────────────────────────────

test("nothing keeps a slugger of its own — there is one rule, imported", () => {
  const consumers = [
    path.join(SCRIPTS_DIR, "components/docs-viewer.js"),
    path.join(ROOT, "scripts/build-docs.mjs"),
  ];
  for (const file of consumers) {
    const src = fs.readFileSync(file, "utf8");
    assert.match(
      src,
      /import \{[^}]*slugifyHeading/,
      `${path.basename(file)} must import the shared rule`,
    );
    assert.doesNotMatch(
      src,
      /function\s+slugifyHeading/,
      `${path.basename(file)} has grown a slugger of its own again — the two ` +
        `copies disagreed about collapsing hyphen runs; see heading-slug.js`,
    );
  }
});
