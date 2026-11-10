/*
 * Copyright 2026 Jason Figge
 *
 * This file is part of Chip Hippo.
 *
 * Chip Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * Chip Hippo is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Chip Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

// A gallery entry's metadata (gallery/entry-format.js), what derive.js reads
// off a design, and the index built from entries (gallery/index-format.js).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  MAX_TAGS,
  MAX_TITLE,
  checkEntryText,
  compareVersions,
  entryIdFor,
  normalizeEntry,
  normalizeTag,
  slugify,
} from "../gallery/entry-format.js";
import { TAG_RULES, deriveEntry } from "../gallery/derive.js";
import { buildIndex, normalizeIndex } from "../gallery/index-format.js";
import { PALETTE_DEFS } from "../catalog/index.js";
import { normalizeDocument } from "../model/desk-doc.js";

const DEMOS = join(dirname(fileURLToPath(import.meta.url)), "../../demos");
const demo = (name) => JSON.parse(readFileSync(join(DEMOS, name), "utf8"));

const ENTRY = {
  schema: 1,
  id: "four-bit-counter-3fa9c1",
  kind: "design",
  title: "Four-bit counter",
  author: "Ada",
  description: "Counts.\nTo fifteen.",
  tags: ["counter"],
  created: "2026-10-31",
  source: "seed",
  featured: true,
  appVersion: "1.5.4",
  docVersion: 15,
  derived: { engine: "logic", chips: 2, parts: 9, wires: 12, families: ["74LS"], level: "beginner", autoTags: ["counter", "ttl"] }, // prettier-ignore
};

test("slugs and ids", () => {
  assert.equal(slugify("  Four-Bit Counter (v2)! "), "four-bit-counter-v2");
  assert.equal(slugify("Café Señal"), "cafe-senal");
  assert.equal(slugify("!!!"), "design");
  assert.ok(slugify("x".repeat(100)).length <= 40);
  assert.equal(entryIdFor("Four-bit counter", "sha256-3FA9C1deadbeef"), "four-bit-counter-3fa9c1"); // prettier-ignore
  assert.throws(() => entryIdFor("x", "zz"));
});

test("the sharer's four fields: cleaned, and each problem named", () => {
  const ok = checkEntryText({
    title: "  My\tcounter ",
    author: "Ada\nLovelace",
    description: "Line one\r\nLine two\u0007",
    tags: ["Counter", "seven segment", "counter", ""],
  });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.value, {
    title: "My counter",
    author: "Ada Lovelace",
    description: "Line one\nLine two",
    tags: ["counter", "seven-segment"],
  });
  const bad = checkEntryText({
    title: "x".repeat(MAX_TITLE + 1),
    tags: [...Array(MAX_TAGS + 1).keys()].map((n) => `t${n}`).concat(["é"]),
  });
  assert.deepEqual(bad.problems.map((p) => p.code), ["titleTooLong", "authorMissing", "badTag", "tooManyTags"]); // prettier-ignore
  assert.deepEqual(checkEntryText().problems.map((p) => p.code), ["titleMissing", "authorMissing"]); // prettier-ignore
  for (const junk of [null, "title", ["a"], 7]) {
    assert.deepEqual(checkEntryText(junk).problems.map((p) => p.code), ["titleMissing", "authorMissing"]); // prettier-ignore
  }
  assert.equal(normalizeTag(" Shift_Register "), "shift-register");
});

test("an entry reads back as written, and junk degrades rather than throws", () => {
  assert.deepEqual(normalizeEntry(ENTRY), ENTRY);
  assert.equal(normalizeEntry({ ...ENTRY, id: "../x" }), null);
  assert.equal(normalizeEntry({ ...ENTRY, title: " " }), null);
  assert.equal(normalizeEntry([]), null);
  const odd = normalizeEntry({ ...ENTRY, kind: "?", source: 3, appVersion: "latest", created: "yesterday", future: 1, derived: null }); // prettier-ignore
  assert.equal(odd.kind, "design");
  assert.equal(odd.source, "shared");
  assert.equal(odd.appVersion, "");
  assert.equal(odd.created, "");
  assert.equal("future" in odd, false);
  assert.equal(odd.derived.engine, "logic");
});

test("versions compare numerically", () => {
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.equal(compareVersions("1.5.4", "1.5.4"), 0);
  assert.ok(compareVersions("junk", "0.0.1") < 0);
});

test("every tag rule names catalog groups, ids and kinds that exist", () => {
  const groups = new Set(PALETTE_DEFS.map((d) => d.group));
  const ids = new Set(PALETTE_DEFS.map((d) => d.id));
  const kinds = new Set(PALETTE_DEFS.map((d) => d.kind));
  for (const rule of TAG_RULES) {
    for (const g of rule.groups ?? []) assert.ok(groups.has(g), `${rule.tag}: group ${g}`); // prettier-ignore
    for (const id of rule.ids ?? []) assert.ok(ids.has(id), `${rule.tag}: id ${id}`); // prettier-ignore
    for (const k of rule.kinds ?? []) assert.ok(kinds.has(k), `${rule.tag}: kind ${k}`); // prettier-ignore
  }
});

test("derive reads a CPU computer, a 555 and a Spice bench sensibly", () => {
  const cpu = deriveEntry(normalizeDocument(demo("W65C02.json").doc));
  assert.ok(cpu.autoTags.includes("cpu"));
  assert.ok(cpu.autoTags.includes("memory"));
  assert.equal(cpu.engine, "logic");
  assert.notEqual(cpu.level, "beginner");

  const timer = demo("NE555.json").desktops[0].doc;
  const t = deriveEntry(normalizeDocument(timer));
  assert.deepEqual([t.engine, t.level], ["logic", "beginner"]);
  assert.ok(t.autoTags.includes("timer"));

  const speaker = deriveEntry(normalizeDocument(demo("speaker.json").desktops[0].doc)); // prettier-ignore
  assert.equal(speaker.engine, "spice");
  assert.ok(speaker.autoTags.includes("audio"));
});

test("the index: one line per id, newest first, no descriptions", () => {
  const older = { ...ENTRY, id: "older-aaaaaa", created: "2026-01-01" };
  const index = buildIndex([older, ENTRY, { ...ENTRY }, { id: "bad" }], {
    generated: "2026-10-31",
  });
  assert.deepEqual(
    index.entries.map((e) => e.id),
    [ENTRY.id, older.id],
  );
  assert.equal("description" in index.entries[0], false);
  assert.equal(index.generated, "2026-10-31");
  assert.deepEqual(normalizeIndex(index), index);
  assert.deepEqual(normalizeIndex("nope").entries, []);
});
