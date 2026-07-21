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

// Feature 130 invariant: a bus is metadata over wires — the netlist and the
// engine never learn buses exist. Settling a document is byte-identical whether
// its wires are bare or bundled into a bus.

import test from "node:test";
import assert from "node:assert/strict";

import { settle } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";

const boards = [
  { id: "bb1", type: "pins-full", x: 0, y: 4 },
  { id: "bb2", type: "rail-full", x: 0, y: 0 },
  { id: "bb3", type: "rail-full", x: 0, y: 18 },
];

const mate = (hole) =>
  holesOfNode("pins-full", nodeOf("pins-full", hole)).filter(
    (h) => h !== hole,
  )[0];

/** A powered 74LS04 inverter with a pull-down on its input. */
function inverterDoc() {
  const holes = new Map(
    partPinHoles("74LS04", "e10").map((p) => [p.pin, p.hole]),
  );
  return {
    boards,
    components: [
      {
        id: "psu1",
        kind: "psu",
        ref: "psu",
        x: 80,
        y: 0,
        params: { volts: 5 },
      },
      { id: "c1", kind: "chip", ref: "74LS04", board: "bb1", anchor: "e10" },
    ],
    wires: [
      { id: "w1", from: "psu1.+", to: `bb1.${mate(holes.get(14))}`, color: "red" }, // prettier-ignore
      { id: "w2", from: "psu1.-", to: `bb1.${mate(holes.get(7))}`, color: "black" }, // prettier-ignore
      { id: "w3", from: `bb1.${mate(holes.get(1))}`, to: `bb1.${mate(holes.get(7))}`, color: "blue" }, // prettier-ignore
    ],
  };
}

test("settling is identical whether wires are bare or bundled into a bus", () => {
  const bare = inverterDoc();
  const bundled = {
    ...bare,
    buses: [
      {
        id: "bus1",
        name: "D[1:0]",
        width: 2,
        color: "green",
        members: ["w2", "w3"],
      },
    ],
  };

  const bareNet = buildNetlist(bare);
  const bundledNet = buildNetlist(bundled);
  // The partition itself is unchanged — same points, same net ids.
  assert.deepEqual(
    [...bundledNet.netOfPoint.entries()].sort(),
    [...bareNet.netOfPoint.entries()].sort(),
  );

  const a = settle({ document: bare, netlist: bareNet });
  const b = settle({ document: bundled, netlist: bundledNet });
  assert.deepEqual(
    [...b.netLevels.entries()].sort(),
    [...a.netLevels.entries()].sort(),
  );
  assert.equal(b.settled, a.settled);
});
