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

// Tests for how long a wire is (model/wire-length.js). Pure — a doc built in
// code, no DOM.
//
// TWO numbers, and the difference is the whole point: the RUN is hole to hole as
// the desk draws it, and the CUT adds a stripped end at each end, because a lead
// reaches INTO both holes. Both the wire's own dimensioned drawing and the BOM's
// cutting list read from here, which is what stops them disagreeing.

import test from "node:test";
import assert from "node:assert/strict";

import { DeskDoc } from "../model/desk-doc.js";
import {
  STRIP_MM,
  wireCutMm,
  wireLengthLabel,
  wireRunMm,
  wireTotalMm,
} from "../model/wire-length.js";

/** A full pin-board with one wire on it, `pitch` columns apart. */
function deskWithHop(pitch, extra = {}) {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1
  const wire = doc.addWire({
    from: "bb1.a1",
    to: `bb1.a${1 + pitch}`,
    ...extra,
  });
  return { doc, wire };
}

test("the CUT is the run plus a strip at each end — 1 hole is ~13 mm of wire", () => {
  // The figures a bench asks for. One 2.54 mm pitch of run is 2.54 + 2 × 5 mm of
  // wire; the drawn run sags a hair past the straight span, so it lands at 12.7.
  const one = deskWithHop(1);
  assert.ok(Math.abs(wireRunMm(one.doc, one.wire.id) - 2.54) < 0.2);
  assert.ok(Math.abs(wireCutMm(one.doc, one.wire.id) - 12.7) < 0.2);
  assert.equal(wireLengthLabel(wireCutMm(one.doc, one.wire.id)), "1.3 cm");

  const two = deskWithHop(2);
  assert.ok(Math.abs(wireCutMm(two.doc, two.wire.id) - 15.2) < 0.2);
  assert.equal(wireLengthLabel(wireCutMm(two.doc, two.wire.id)), "1.5 cm");

  // The cut is always exactly the run plus both strips, at any length.
  const long = deskWithHop(40);
  const run = wireRunMm(long.doc, long.wire.id);
  assert.equal(wireCutMm(long.doc, long.wire.id), run + 2 * STRIP_MM);
  assert.equal(wireTotalMm(run), run + 2 * STRIP_MM);
});

test("a wire that isn't there has no length, and neither has a dangling one", () => {
  const { doc } = deskWithHop(5);
  assert.equal(wireRunMm(doc, "w99"), null);
  assert.equal(wireCutMm(doc, "w99"), null, "the cut is null exactly when the run is"); // prettier-ignore
  // An endpoint on a board that has gone: the address no longer resolves.
  const orphan = doc.addWire({ from: "bb1.j1", to: "bb1.j5" });
  doc.removeBoard("bb1");
  assert.equal(wireRunMm(doc, orphan.id), null);
});

test("the RUN is the drawn curve, sag and all — not the chord between the holes", () => {
  const { doc, wire } = deskWithHop(20);
  const run = wireRunMm(doc, wire.id);
  const chord = 20 * 2.54;
  assert.ok(run > chord, `${run} > ${chord}: a lead spans more than the gap`);
  assert.ok(run < chord * 1.05, `${run} is a sag, not a detour`);
});

test("a ROUTED wire measures the run through its bends", () => {
  const { doc, wire } = deskWithHop(20);
  doc.setWireLayout(wire.id, "routed");
  const straight = wireRunMm(doc, wire.id);

  // A bend 30 pitch below the run has to be gone out to and come back from.
  doc.addWirePoint(wire.id, 0, { x: 10, y: 30 });
  const bent = wireRunMm(doc, wire.id);
  assert.ok(bent > straight * 2, `${bent} vs ${straight}: the detour counts`);
});

test("a BUS MEMBER is its two leads PLUS the ribbon it runs inside", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    ids.push(doc.addWire({ from: `bb1.a${10 + i}`, to: `bb1.j${10 + i}` }).id);
  }
  const loose = wireRunMm(doc, ids[0]);

  doc.addBus("D[3:0]", ids, { color: "blue" });
  const bundled = wireRunMm(doc, ids[0]);
  // The conductor is as long as the cable, however short its own leads are — so
  // bundling can only ever lengthen a member, never shorten it.
  assert.ok(bundled >= loose, `${bundled} >= ${loose}`);
  // Every member runs the same ribbon, so their lengths land within a lead's
  // worth of each other rather than being unrelated.
  const spread = ids.map((id) => wireRunMm(doc, id));
  const range = Math.max(...spread) - Math.min(...spread);
  assert.ok(range < bundled / 2, `members agree to within ${range}`);
});

test("wireTotalMm floors a nonsense run rather than signing it", () => {
  assert.equal(
    wireTotalMm(0),
    2 * STRIP_MM,
    "a wire is never shorter than this",
  );
  assert.equal(wireTotalMm(-40), 2 * STRIP_MM);
  assert.equal(wireLengthLabel(-40), "0.0 cm");
});

test("wireLengthLabel: cm to a tenth, so a column of them lines up", () => {
  assert.equal(wireLengthLabel(127), "12.7 cm");
  assert.equal(wireLengthLabel(100), "10.0 cm");
  assert.equal(wireLengthLabel(61.28), "6.1 cm", "rounded, not truncated");
  assert.equal(wireLengthLabel(61.5), "6.2 cm");
});
