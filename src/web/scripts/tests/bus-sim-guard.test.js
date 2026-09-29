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
