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

// Tests for net names (Feature 120): the netlist resolves each `{address,name}`
// binding to its current net, holds a name through a net-key change, reports
// merge conflicts, and never perturbs the electrical partition.

import test from "node:test";
import assert from "node:assert/strict";

import { DeskDoc } from "../model/desk-doc.js";
import { buildNetlist } from "../sim/netlist.js";

function fullKit() {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1 rail · bb2 pins · bb3 rail
  return doc;
}

test("a name binds by address and shows up on that net", () => {
  const doc = fullKit();
  doc.nameNet("bb1.+1", "VCC");
  const nl = buildNetlist(doc.toJSON());
  const railNet = nl.netOfPoint.get("bb1.+25");
  assert.equal(nl.names.get(railNet), "VCC"); // whole rail inherits the name
  assert.equal(nl.nameConflicts.length, 0);
});

test("a name survives a net-key change (delete the smallest-address wire)", () => {
  const doc = fullKit();
  // Span three columns; b6 shares a6's 5-hole node, so each endpoint is its
  // own free hole (one hole, one lead).
  const w1 = doc.addWire({ from: "bb2.a5", to: "bb2.a6" });
  doc.addWire({ from: "bb2.b6", to: "bb2.a7" });
  // Name by pointing at a7 — a member that stays in the net we care about.
  doc.nameNet("bb2.a7", "DATA");

  let nl = buildNetlist(doc.toJSON());
  const net1 = nl.netOfPoint.get("bb2.a7");
  assert.equal(net1, "bb2.a5"); // key = smallest member address
  assert.equal(nl.names.get(net1), "DATA");

  // Delete the wire on the smallest address: a5's column splits off, so the
  // key of the remaining net changes — but a7 is still in it.
  doc.removeWire(w1.id);
  nl = buildNetlist(doc.toJSON());
  const net2 = nl.netOfPoint.get("bb2.a7");
  assert.notEqual(net2, net1); // the key changed
  assert.equal(nl.names.get(net2), "DATA"); // the name held
  // a5 is now its own, unnamed net.
  assert.equal(nl.names.get(nl.netOfPoint.get("bb2.a5")), undefined);
});

test("a merge conflict is REPORTED, never silently dropped", () => {
  const doc = fullKit();
  doc.nameNet("bb2.a5", "VCC");
  doc.nameNet("bb2.a10", "GND");
  let nl = buildNetlist(doc.toJSON());
  assert.equal(nl.nameConflicts.length, 0); // two separate nets, no conflict

  // A wire merges the two named nets into one.
  doc.addWire({ from: "bb2.a5", to: "bb2.a10" });
  nl = buildNetlist(doc.toJSON());
  const net = nl.netOfPoint.get("bb2.a5");
  // Deterministic winner: the name that sorts first ("GND" < "VCC").
  assert.equal(nl.names.get(net), "GND");
  assert.equal(nl.nameConflicts.length, 1);
  assert.equal(nl.nameConflicts[0].winner, "GND");
  assert.equal(nl.nameConflicts[0].name, "VCC"); // the loser is named
  assert.equal(nl.nameConflicts[0].netId, net);
});

test("naming is inert: the electrical partition is byte-identical", () => {
  const doc = fullKit();
  doc.addWire({ from: "bb2.a5", to: "bb1.+1" });
  const before = buildNetlist(doc.toJSON());

  doc.nameNet("bb2.a5", "VCC");
  doc.nameNet("bb1.+1", "VCC"); // same net, redundant name — still inert
  const after = buildNetlist(doc.toJSON());

  // The partition (which point is on which net) is untouched by naming.
  assert.deepEqual(
    [...after.netOfPoint.entries()].sort(),
    [...before.netOfPoint.entries()].sort(),
  );
  // Every NetInfo is identical — names live in a separate map, not on the net.
  for (const [id, net] of after.nets) {
    assert.deepEqual(net, before.nets.get(id));
  }
});

test("a binding on a deleted board is ignored, not applied", () => {
  const doc = fullKit();
  doc.nameNet("bb2.a5", "DATA");
  doc.removeBoard("bb2");
  const nl = buildNetlist(doc.toJSON());
  // No net contains bb2.a5 anymore, so the name simply resolves to nothing.
  assert.equal([...nl.names.values()].includes("DATA"), false);
  assert.equal(nl.nameConflicts.length, 0);
});
