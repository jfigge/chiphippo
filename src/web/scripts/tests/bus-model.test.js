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

// Buses in the desk document (Feature 130): metadata over wires. Add / update /
// remove, member-pruning as wires vanish, and the atomic whole-bus move — the
// netlist/occupancy/engine never see any of this.

import test from "node:test";
import assert from "node:assert/strict";

import { DeskDoc } from "../model/desk-doc.js";

/** A board with four independent jumper wires laid across it. */
function docWithFourWires() {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1 rail · bb2 pins · bb3 rail
  const w = [];
  for (let i = 1; i <= 4; i += 1) {
    w.push(doc.addWire({ from: `bb2.a${i}`, to: `bb2.j${i}`, color: "blue" }));
  }
  return { doc, wireIds: w.map((x) => x.id) };
}

test("addBus bundles existing wires into a bus<n> in bit order", () => {
  const { doc, wireIds } = docWithFourWires();
  const bus = doc.addBus("D[3:0]", wireIds, { color: "green" });
  assert.equal(bus.id, "bus1");
  assert.equal(bus.name, "D[3:0]");
  assert.equal(bus.width, 4);
  assert.equal(bus.color, "green");
  assert.deepEqual(bus.members, wireIds);
  assert.deepEqual(doc.busOfWire(wireIds[0]).id, "bus1");
  assert.equal(doc.busOfWire("w999"), null);
});

test("addBus drops unknown / duplicate member ids", () => {
  const { doc, wireIds } = docWithFourWires();
  const bus = doc.addBus("D[3:0]", [
    wireIds[0],
    "w999",
    wireIds[0],
    wireIds[1],
  ]);
  assert.deepEqual(bus.members, [wireIds[0], wireIds[1]]);
});

test("addBus rejects an unparseable name", () => {
  const { doc, wireIds } = docWithFourWires();
  assert.throws(() => doc.addBus("", wireIds), { code: "INVALID_ARG" });
});

test("bus ids are never reused across serialize + reload", () => {
  const { doc, wireIds } = docWithFourWires();
  doc.addBus("D[1:0]", wireIds.slice(0, 2));
  const reloaded = new DeskDoc(doc.toJSON());
  const next = reloaded.addBus("A[1:0]", wireIds.slice(2, 4));
  assert.equal(next.id, "bus2");
});

test("updateBus renames (re-deriving width), recolors, and re-members", () => {
  const { doc, wireIds } = docWithFourWires();
  const bus = doc.addBus("D[3:0]", wireIds);
  const renamed = doc.updateBus(bus.id, { name: "A[0:7]" });
  assert.equal(renamed.name, "A[0:7]");
  assert.equal(renamed.width, 8); // width follows the new name
  const recolored = doc.updateBus(bus.id, { color: "red" });
  assert.equal(recolored.color, "red");
  const shrunk = doc.updateBus(bus.id, { members: wireIds.slice(0, 2) });
  assert.deepEqual(shrunk.members, wireIds.slice(0, 2));
  assert.throws(() => doc.updateBus("bus9", { color: "red" }), {
    code: "NOT_FOUND",
  });
  assert.throws(() => doc.updateBus(bus.id, { name: "" }), {
    code: "INVALID_ARG",
  });
});

test("deleting a member wire shrinks the bus, never corrupts it", () => {
  const { doc, wireIds } = docWithFourWires();
  doc.addBus("D[3:0]", wireIds);
  doc.removeWire(wireIds[1]);
  assert.deepEqual(doc.getBus("bus1").members, [
    wireIds[0],
    wireIds[2],
    wireIds[3],
  ]);
  // Width stays declared — the name still says four bits even with three left.
  assert.equal(doc.getBus("bus1").width, 4);
});

test("removeBus with keep-wires un-bundles; with cascade deletes the wires", () => {
  const { doc, wireIds } = docWithFourWires();
  doc.addBus("D[3:0]", wireIds);
  doc.removeBus("bus1"); // keep wires (default)
  assert.equal(doc.getBus("bus1"), null);
  assert.equal(doc.wires.length, 4); // wires survive, just un-bundled

  const bus2 = doc.addBus("D[3:0]", doc.wires.map((w) => w.id)); // prettier-ignore
  doc.removeBus(bus2.id, { cascadeWires: true });
  assert.equal(doc.wires.length, 0); // wires went with the bus
  assert.throws(() => doc.removeBus("bus9"), { code: "NOT_FOUND" });
});

test("deleting the board a bus rides shrinks the bus to nothing", () => {
  const { doc, wireIds } = docWithFourWires();
  doc.addBus("D[3:0]", wireIds);
  doc.removeBoard("bb2"); // every wire had an endpoint here
  assert.deepEqual(doc.getBus("bus1").members, []);
  assert.equal(doc.wires.length, 0);
});

test("moveWiresBatch shifts a whole bus atomically, shuffles allowed", () => {
  const { doc, wireIds } = docWithFourWires();
  doc.addBus("D[3:0]", wireIds);
  // Shift every member one column right: w_i's a-end a1→a2 etc. Member 2's new
  // hole (a2) is member 1's OLD hole — legal only because both are lifted.
  const moves = wireIds.map((id, i) => ({
    id,
    from: `bb2.a${i + 2}`,
    to: `bb2.j${i + 2}`,
  }));
  assert.equal(doc.canMoveWiresBatch(moves), true);
  doc.moveWiresBatch(moves);
  assert.equal(doc.getWire(wireIds[0]).from, "bb2.a2");
  assert.equal(doc.getWire(wireIds[3]).to, "bb2.j5");
});

test("moveWiresBatch rejects a collision with a non-moving lead", () => {
  const { doc, wireIds } = docWithFourWires();
  doc.addWire({ from: "bb2.a9", to: "bb2.j9", color: "red" }); // an outsider
  const moves = [{ id: wireIds[0], from: "bb2.a9", to: "bb2.b9" }]; // a9 taken
  assert.equal(doc.canMoveWiresBatch(moves), false);
  assert.throws(() => doc.moveWiresBatch(moves), { code: "ILLEGAL_PLACEMENT" });
});

test("normalizeDocument repairs buses: drops danglers, coerces color/width", () => {
  const { doc, wireIds } = docWithFourWires();
  const raw = doc.toJSON();
  raw.buses = [
    {
      id: "bus1",
      name: "D[3:0]",
      width: 1, // understated → repaired up to the member count
      color: "chartreuse", // not a palette color → first palette entry
      members: [wireIds[0], "w999", wireIds[1]], // dangler dropped
    },
    { id: "bad", name: "D[1:0]", members: [] }, // bad id → dropped
    { id: "bus2", name: "", members: [] }, // junk name → dropped
  ];
  const reloaded = new DeskDoc(raw);
  const buses = reloaded.buses;
  assert.equal(buses.length, 1);
  assert.deepEqual(buses[0].members, [wireIds[0], wireIds[1]]);
  assert.equal(buses[0].color, "red");
  assert.equal(buses[0].width, 4); // max(declared 1, members 2, name width 4)
  assert.equal(reloaded.toJSON().nextBusId, 2);
});
