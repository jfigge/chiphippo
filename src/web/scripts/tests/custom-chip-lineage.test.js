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

// A custom chip's gallery lineage (the gallery work, Part 2b of
// features/chiphippo-gallery-plan.md): `origin`/`forkedFrom` kept through
// normalization, content compared without id or lineage, the package test,
// the fork, and an Import matching a gallery chip by its gallery id.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  chipContent,
  forkCustomChip,
  mergeCustomChips,
  newCustomChip,
  normalizeCustomChip,
  packageCompatible,
  sameCustomChip,
} from "../model/custom-chip.js";

const require = createRequire(import.meta.url);
const { sanitizeCustomChips } = require("../../../app/store/custom-chips.js");

const HASH = (n) => `sha256-${String(n).padStart(2, "0").repeat(32)}`;
const GCID = "gc-0123456789ab";

/** A NAND chip, as revision `rev` of gallery chip GCID when `rev` is given. */
function chip({ id = "custom-0000000a", rev = null, code, gcid = GCID } = {}) {
  const c = { ...newCustomChip(), id };
  if (code) c.code = code;
  if (rev != null) c.origin = { gcid, rev, hash: HASH(rev) };
  return normalizeCustomChip(c);
}

/** A desk document placing the chip `ref` once. */
const docPlacing = (ref) => ({
  components: [{ id: "c1", kind: "chip", ref, board: "bb2", anchor: "e10" }],
});

test("lineage survives normalization, and a chip without one has no key", () => {
  const c = chip({ rev: 2 });
  assert.deepEqual(c.origin, { gcid: GCID, rev: 2, hash: HASH(2) });
  const plain = chip();
  assert.equal("origin" in plain, false);
  assert.equal("forkedFrom" in plain, false);
});

test("a malformed lineage is dropped, not repaired", () => {
  for (const origin of [
    { gcid: "gc-xyz", rev: 1, hash: HASH(1) },
    { gcid: GCID, rev: 0, hash: HASH(1) },
    { gcid: GCID, rev: 1.5, hash: HASH(1) },
    { gcid: GCID, rev: 1, hash: "md5-00" },
    "gc-0123456789ab",
  ]) {
    const c = normalizeCustomChip({ ...newCustomChip(), origin });
    assert.equal("origin" in c, false, JSON.stringify(origin));
  }
});

test("main's sanitizer keeps exactly what the renderer's normalizer keeps", () => {
  const raw = {
    ...newCustomChip(),
    origin: { gcid: GCID, rev: 4, hash: HASH(4) },
    forkedFrom: { gcid: "gc-ba9876543210", rev: 2 },
  };
  const [main] = sanitizeCustomChips([raw]);
  const renderer = normalizeCustomChip(raw);
  assert.deepEqual(main.origin, renderer.origin);
  assert.deepEqual(main.forkedFrom, renderer.forkedFrom);
});

test("content ignores the local id and the lineage", () => {
  const a = chip({ id: "custom-0000000a", rev: 1 });
  const b = chip({ id: "custom-0000000b" });
  assert.equal(chipContent(a), chipContent(b));
  assert.ok(sameCustomChip(a, b));
  const c = chip({ code: "assign Y = A & B;\n" });
  assert.ok(!sameCustomChip(a, c));
});

test("the package test: only the code may differ", () => {
  const a = chip();
  assert.ok(packageCompatible(a, chip({ code: "assign Y = A | B;\n" })));
  const wider = normalizeCustomChip({ ...a, pinsPerSide: 8 });
  assert.ok(!packageCompatible(a, wider));
  const moved = normalizeCustomChip({ ...a, units: [{ A: [4], B: [5], Y: [6] }] }); // prettier-ignore
  assert.ok(!packageCompatible(a, moved));
  assert.ok(!packageCompatible(null, a));
});

test("a fork drops the origin and remembers it as its parent", () => {
  const forked = forkCustomChip(chip({ rev: 3 }));
  assert.equal("origin" in forked, false);
  assert.deepEqual(forked.forkedFrom, { gcid: GCID, rev: 3 });
  const plain = chip();
  assert.equal(forkCustomChip(plain), plain);
});

test("a chip with no lineage merges exactly as before", () => {
  const here = chip();
  const changed = chip({ code: "assign Y = A ^ B;\n" });
  const merged = mergeCustomChips([here], [changed], docPlacing(here.id));
  assert.equal(merged.added, 1);
  assert.notEqual(merged.doc.components[0].ref, here.id);
  assert.deepEqual(merged.asks, []);
  assert.deepEqual(merged.updated, []);
});

test("the same gallery chip under another local id is the one already here", () => {
  const here = chip({ id: "custom-0000000a", rev: 2 });
  const arriving = chip({ id: "custom-0000000b", rev: 2 });
  const merged = mergeCustomChips([here], [arriving], docPlacing(arriving.id));
  assert.equal(merged.added, 0);
  assert.equal(merged.chips.length, 1);
  assert.equal(merged.doc.components[0].ref, here.id);
});

test("an older revision uses the newer one here when the package allows", () => {
  const here = chip({ rev: 3, code: "assign Y = ~(A & B) ;\n" });
  const older = chip({ id: "custom-0000000b", rev: 1 });
  const merged = mergeCustomChips([here], [older], docPlacing(older.id));
  assert.equal(merged.added, 0);
  assert.equal(merged.doc.components[0].ref, here.id);
});

test("a newer revision unanswered is kept beside it and asked about", () => {
  const here = chip({ rev: 1 });
  const newer = chip({ rev: 2, code: "assign Y = ~(A | B);\n" });
  const merged = mergeCustomChips([here], [newer], docPlacing(newer.id));
  assert.equal(merged.added, 1);
  assert.deepEqual(merged.asks, [
    { gcid: GCID, id: here.id, name: newer.name, from: 1, to: 2 },
  ]);
  assert.notEqual(merged.doc.components[0].ref, here.id);
});

test("'keep' brings it in without asking", () => {
  const here = chip({ rev: 1 });
  const newer = chip({ rev: 2, code: "assign Y = ~(A | B);\n" });
  const merged = mergeCustomChips([here], [newer], docPlacing(newer.id), {
    revisions: { [GCID]: "keep" },
  });
  assert.equal(merged.added, 1);
  assert.deepEqual(merged.asks, []);
});

test("'update' replaces the one here under its own id", () => {
  const here = chip({ rev: 1 });
  const newer = chip({ id: "custom-0000000b", rev: 2, code: "assign Y = ~(A | B);\n" }); // prettier-ignore
  const merged = mergeCustomChips([here], [newer], docPlacing(newer.id), {
    revisions: { [GCID]: "update" },
  });
  assert.equal(merged.added, 0);
  assert.equal(merged.chips.length, 1);
  assert.equal(merged.chips[0].id, here.id);
  assert.equal(merged.chips[0].origin.rev, 2);
  assert.equal(merged.chips[0].code, newer.code);
  assert.deepEqual(merged.updated, [here.id]);
  assert.equal(merged.doc.components[0].ref, here.id);
});

test("a newer revision with a changed package is kept beside it, never asked", () => {
  const here = chip({ rev: 1 });
  const newer = normalizeCustomChip({ ...chip({ rev: 2 }), pinsPerSide: 8 });
  const merged = mergeCustomChips([here], [newer], docPlacing(newer.id), {
    revisions: { [GCID]: "update" },
  });
  assert.equal(merged.added, 1);
  assert.deepEqual(merged.updated, []);
  assert.deepEqual(merged.asks, []);
});

test("a fork is not matched by its parent's gallery id", () => {
  const forked = forkCustomChip(chip({ rev: 1, code: "assign Y = 1'b0;\n" }));
  const arriving = chip({ id: "custom-0000000b", rev: 1 });
  const merged = mergeCustomChips([forked], [arriving], docPlacing(arriving.id)); // prettier-ignore
  assert.equal(merged.added, 1);
  assert.equal(merged.doc.components[0].ref, arriving.id);
});
