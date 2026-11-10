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

// The gallery's submission validator (gallery/validate.js): every shipped
// example passes, and each way a file can lie to the loader is refused by
// name (features/chiphippo-gallery-plan.md → Phase 1, 1.4).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  MAX_ROM_BYTES,
  MAX_SNAPSHOT_BYTES,
  validateSubmission,
} from "../gallery/validate.js";
import { customChipDefs, setCustomChips } from "../catalog/index.js";
import { newCustomChip } from "../model/custom-chip.js";

const require = createRequire(import.meta.url);
const { migrateDeskDocument } = require("../../../app/store/migrations.js");
const DEMOS = join(dirname(fileURLToPath(import.meta.url)), "../../demos");

const migrate = migrateDeskDocument;
const check = (snapshot) =>
  validateSubmission(typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot), { migrate }); // prettier-ignore
const codes = (r) => r.problems.map((p) => p.code);

/** Every desktop of every shipped example, as a snapshot. */
function* shippedSnapshots() {
  for (const file of readdirSync(DEMOS).filter((f) => f.endsWith(".json"))) {
    const demo = JSON.parse(readFileSync(join(DEMOS, file), "utf8"));
    for (const desk of demo.desktops ?? [{ name: demo.title, doc: demo.doc }]) {
      yield {
        file,
        snapshot: {
          version: 5,
          kind: "desktop",
          name: desk.name,
          doc: desk.doc,
          ...(demo.images ? { images: demo.images } : {}),
        },
      };
    }
  }
}

/** The 74LS00 bench, a fresh copy. */
function nandBench() {
  const demo = JSON.parse(readFileSync(join(DEMOS, "74LS00.json"), "utf8"));
  return { version: 5, kind: "desktop", name: "NAND", doc: demo.doc };
}

test("every shipped example desktop validates clean", () => {
  let n = 0;
  for (const { file, snapshot } of shippedSnapshots()) {
    const r = check(snapshot);
    assert.deepEqual(r.problems, [], `${file} ${snapshot.name}`);
    assert.ok(r.derived, file);
    n += 1;
  }
  assert.ok(n > 100, `only ${n} desktops`);
});

test("too big, not JSON, not a desktop", () => {
  assert.deepEqual(codes(check("x".repeat(MAX_SNAPSHOT_BYTES + 1))), [
    "tooBig",
  ]);
  assert.deepEqual(codes(check("{nope")), ["notJson"]);
  assert.deepEqual(codes(validateSubmission(null, { migrate })), ["notJson"]);
  assert.deepEqual(codes(check({ version: 5, tabs: [] })), ["notDesktop"]);
  assert.deepEqual(codes(check({ kind: "desktop", doc: [] })), ["notDesktop"]);
  assert.throws(() => validateSubmission("{}"), /migrate/);
});

test("a document from a newer app is refused, not judged", () => {
  const snap = nandBench();
  snap.doc.version = 999;
  const r = check(snap);
  assert.deepEqual(codes(r), ["newerDocument"]);
  assert.equal(r.docVersion, 999);
});

test("an empty desk has nothing to share", () => {
  assert.deepEqual(codes(check({ kind: "desktop", doc: { version: 15 } })), ["empty"]); // prettier-ignore
});

test("an overlapping strip the loader would drop is named", () => {
  const snap = nandBench();
  snap.doc.boards.push({ ...snap.doc.boards[1], id: "bb9", group: null });
  const r = check(snap);
  assert.deepEqual(r.problems, [{ code: "dropped", list: "boards", ids: ["bb9"] }]); // prettier-ignore
});

test("two parts in the same holes: the loser is named", () => {
  const snap = nandBench();
  const chip = snap.doc.components.find((c) => c.ref === "74LS00");
  snap.doc.components.push({ ...chip, id: "c99" });
  const r = check(snap);
  assert.deepEqual(r.problems, [{ code: "dropped", list: "components", ids: ["c99"] }]); // prettier-ignore
});

test("a wire to nowhere is named", () => {
  const snap = nandBench();
  snap.doc.wires.push({
    id: "w999",
    from: "bb2.a1",
    to: "bb7.a2",
    color: "red",
  });
  assert.deepEqual(check(snap).problems, [
    { code: "dropped", list: "wires", ids: ["w999"] },
  ]);
});

test("an unknown part is named once, not also as dropped", () => {
  const snap = nandBench();
  snap.doc.components.find((c) => c.ref === "74LS00").ref = "74LS9999";
  assert.deepEqual(check(snap).problems, [{ code: "unknownPart", ref: "74LS9999", count: 1 }]); // prettier-ignore
});

/** The NAND bench with its 74LS00 swapped for a designed NAND of the same DIP-14. */
function customBench(chipOverrides = {}) {
  const snap = nandBench();
  const chip = { ...newCustomChip(), id: "custom-0badc0de", name: "MYNAND", ...chipOverrides }; // prettier-ignore
  snap.doc.components.find((c) => c.ref === "74LS00").ref = chip.id;
  return { snap, chip };
}

test("a designed chip the snapshot carries validates, and is tagged", () => {
  const { snap, chip } = customBench();
  snap.customChips = [chip];
  const r = check(snap);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(
    r.snapshot.customChips.map((c) => c.id),
    [chip.id],
  );
  assert.ok(r.derived.autoTags.includes("custom-chip"));
});

test("a designed chip it does not carry is missing — the library is never asked", () => {
  const { snap, chip } = customBench();
  const before = customChipDefs();
  setCustomChips([chip]); // this machine's library holds it…
  try {
    const r = check(snap); // …but the submission does not
    assert.deepEqual(r.problems, [
      { code: "missingChip", ref: chip.id, count: 1 },
    ]);
    // and the catalog is left exactly as it was found
    assert.deepEqual(
      customChipDefs().map((d) => d.id),
      [chip.id],
    );
  } finally {
    setCustomChips(before.map((d) => d.customChip));
  }
});

test("a designed chip that cannot run is refused", () => {
  const { snap, chip } = customBench({ code: "assign Y = ;" });
  snap.customChips = [chip];
  assert.deepEqual(check(snap).problems, [
    { code: "brokenChip", name: "MYNAND" },
  ]);
});

test("ROM bytes are counted, and junk in them refused", () => {
  const snap = nandBench();
  snap.images = { g1: "not base64!" };
  assert.deepEqual(codes(check(snap)), ["badRom"]);
  // One base64 quantum (4 characters) is 3 bytes: just past the cap.
  const big = "AAAA".repeat(Math.ceil((MAX_ROM_BYTES + 1) / 3));
  snap.images = { g1: { blob: "sha256-x" } };
  snap.blobs = { "sha256-x": big };
  assert.deepEqual(codes(check(snap)), ["romTooBig"]);
  // A guid named __proto__ is a ROM like any other (JSON makes it an own key).
  delete snap.blobs;
  const hostile = JSON.parse(`{"images": {"__proto__": "not base64!"}}`);
  snap.images = hostile.images;
  assert.deepEqual(codes(check(snap)), ["badRom"]);
});
