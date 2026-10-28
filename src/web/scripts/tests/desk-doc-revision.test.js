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

// DeskDoc's `revision` — the count the auto-save tick trusts in place of a
// signature (ProjectWorkspace `#signature`). Every public method but
// DESK_DOC_READS bumps it; these hold the list to the class in BOTH
// directions: nothing on it that is not a method, every method off it
// counted, and every method on it a true read — called every way the desk
// can feed it, the document is unchanged.

import test from "node:test";
import assert from "node:assert/strict";

import { DeskDoc, DESK_DOC_READS } from "../model/desk-doc.js";
import { busyDocument } from "../bench/busy-circuit.js";

const proto = DeskDoc.prototype;
const methods = Object.getOwnPropertyNames(proto).filter(
  (name) =>
    name !== "constructor" &&
    typeof Object.getOwnPropertyDescriptor(proto, name).value === "function",
);

test("every name on the read list is a method of DeskDoc", () => {
  for (const name of DESK_DOC_READS) {
    assert.ok(methods.includes(name), `${name} is not a DeskDoc method`);
  }
});

test("DeskDoc has no setter — an accessor is never counted, so it must be a read", () => {
  for (const name of Object.getOwnPropertyNames(proto)) {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    assert.equal(desc.set, undefined, `${name} has a setter`);
  }
});

test("every method off the read list moves the revision, even one that throws", () => {
  for (const name of methods) {
    if (DESK_DOC_READS.has(name)) continue;
    const doc = new DeskDoc(busyDocument(1));
    const before = doc.revision;
    try {
      doc[name]();
    } catch {
      // a refused call still counts (it is only a wasted signature)
    }
    assert.ok(doc.revision > before, `${name} did not move the revision`);
  }
});

test("every method on the read list leaves the document and its revision alone", () => {
  const doc = new DeskDoc(busyDocument(2));
  const comps = doc.components;
  const wires = doc.wires;
  const boards = doc.boards;
  const chip = comps.find((c) => c.kind === "chip");
  const discrete = comps.find((c) => c.kind === "discrete" && c.board);
  const brick = comps.find((c) => c.board == null);
  const wire = wires[0];
  const ids = boards.map((b) => b.id);
  const someIds = [chip.id, discrete.id];
  // Every shape of argument the desk hands its reads, from the desk itself.
  const argSets = [
    [],
    [boards[0].id],
    [chip.id],
    [discrete.id],
    [brick?.id],
    [wire.id],
    [wire.from],
    [wire.to],
    [`${boards[0].id}.a1`],
    [ids],
    [someIds],
    [ids, 1, 0],
    [ids, 0, 3.5],
    [boards[0].id, 1, 0],
    [boards[0].type, 0, 40],
    ["full", 0, 60],
    [chip.id, { board: chip.board, anchor: chip.anchor }],
    [discrete.id, { label: "x" }],
    [wire.id, "to", `${boards[0].id}.a1`],
    [wire.id, wire.from, `${boards[0].id}.a1`],
    [`${boards[0].id}.a1`, `${boards[0].id}.a5`],
    [{ componentIds: someIds, wireIds: [wire.id] }],
    [
      { components: someIds, wires: [wire.id] },
      { dx: 1, dy: 0 },
    ],
    [[{ id: wire.id, from: wire.from, to: wire.to }]],
    [{ dx: 1, dy: 0 }, someIds, {}],
  ];
  const want = doc.snapshot();
  const revision = doc.revision;
  let answered = 0;
  for (const name of DESK_DOC_READS) {
    for (const args of argSets) {
      try {
        doc[name](...args);
        answered += 1;
      } catch {
        // a shape this read does not take
      }
      assert.deepStrictEqual(doc.snapshot(), want, `${name}(${JSON.stringify(args)}) changed the desk`); // prettier-ignore
      assert.equal(doc.revision, revision, `${name} moved the revision`);
    }
  }
  assert.ok(answered > DESK_DOC_READS.size, "the reads were really exercised");
});

test("restore and load move the revision; a copy handed out does not", () => {
  const doc = new DeskDoc(busyDocument(1));
  const snap = doc.snapshot();
  let r = doc.revision;
  doc.restore(snap);
  assert.ok(doc.revision > r, "restore");
  r = doc.revision;
  doc.load(snap);
  assert.ok(doc.revision > r, "load");
  r = doc.revision;
  doc.components[0].ref = "changed"; // a copy: the desk is untouched
  doc.toJSON().wires.length = 0;
  assert.equal(doc.revision, r);
  assert.deepStrictEqual(doc.snapshot(), doc.toJSON());
});
