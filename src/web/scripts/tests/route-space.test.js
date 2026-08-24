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

// Tests for the routing space (model/route-space.js) — the grid the auto-router
// searches, and the region it is allowed to search in.
//
// The load-bearing claims, each of which the router silently depends on:
// every hole is a node; no two tracks are closer than a wire's own width without
// being flagged as conflicting; a mated kit is ONE region; and a part's body
// closes the row it sits in without closing the row beside it.

import test from "node:test";
import assert from "node:assert/strict";

import { DeskDoc } from "../model/desk-doc.js";
import { holePosition, holes } from "../model/breadboard.js";
import { MM_PER_UNIT } from "../desk/desk-geometry.js";
import { ROUTE_CONFIG, makeRouteConfig } from "../model/route-config.js";
import {
  ON_BOARD,
  ON_BRIDGE,
  OUTSIDE,
  buildRouteSpace,
  exemptObstacles,
} from "../model/route-space.js";

function kit() {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0);
  return doc;
}

test("every hole on every strip is a node of the grid", () => {
  // This is WHY a route needs no transition geometry at its ends: the hole it
  // terminates on is already a place the search can stand.
  const doc = kit();
  const json = doc.toJSON();
  const space = buildRouteSpace(json, {});
  for (const board of json.boards) {
    for (const hole of holes(board.type)) {
      const p = holePosition(board.type, hole, board.rot ?? 0);
      assert.ok(
        space.nodeAt(board.x + p.x, board.y + p.y) >= 0,
        `${board.id}.${hole} is on the lattice`,
      );
    }
  }
});

test("a brick terminal is a node too, and it sits on a bridge", () => {
  const doc = kit();
  const psu = doc.addBrick("psu", 70, 8);
  const json = doc.toJSON();
  const terminal = { x: psu.x + 2, y: psu.y + 4 };
  const space = buildRouteSpace(json, { extraPoints: [terminal] });
  const n = space.nodeAt(terminal.x, terminal.y);
  assert.ok(n >= 0, "the terminal is reachable");
  assert.equal(space.nodeKind[n], ON_BRIDGE, "off the boards, but legal");
});

test("no two tracks are closer than a wire can clear without being flagged", () => {
  const doc = kit();
  const space = buildRouteSpace(doc.toJSON(), {});
  for (const axis of ["xs", "ys"]) {
    const coords = space[axis];
    const conflict = axis === "xs" ? space.xConflict : space.yConflict;
    for (let i = 1; i < coords.length; i += 1) {
      const gap = coords[i] - coords[i - 1];
      // The same slack `conflictRanges` compares with: track coordinates are
      // quantized, so a gap that IS the spacing arrives as 0.32999999999999996.
      if (gap >= ROUTE_CONFIG.minSeparation - 1e-6) continue;
      // Too close to run two wires side by side — so they MUST be in each
      // other's conflict range, which is what makes the clearance rule hold
      // even where the board geometry cannot guarantee it structurally.
      assert.ok(
        conflict.lo[i] <= i - 1 && conflict.hi[i - 1] >= i,
        `${axis} ${coords[i - 1]}..${coords[i]} are unflagged neighbours`,
      );
    }
  }
});

test("no two tracks land closer than two runs need to read as two", () => {
  // The grid is finer than the hole lattice — a wire may run BETWEEN two rows
  // of holes — but never finer than the spacing two runs need to read as two.
  assert.ok(ROUTE_CONFIG.minSeparation < 1, "lanes are finer than the lattice");
  assert.ok(
    ROUTE_CONFIG.laneSpacingMm < MM_PER_UNIT,
    "which is what the half-pitch grid depends on",
  );
  const space = buildRouteSpace(kit().toJSON(), {});
  for (const axis of ["xs", "ys"]) {
    for (let i = 1; i < space[axis].length; i += 1) {
      assert.ok(
        space[axis][i] - space[axis][i - 1] >=
          ROUTE_CONFIG.minSeparation - 1e-9,
        `${axis} gap ${space[axis][i - 1]}..${space[axis][i]}`,
      );
    }
  }
});

test("the trench and the dovetail margins come out as CORRIDOR tracks", () => {
  // Derived, not listed: a track is a corridor when no hole sits on it. That is
  // what makes a wire in the trench cheaper than one along a row of tie points,
  // without anyone typing a y coordinate anywhere.
  const space = buildRouteSpace(kit().toJSON(), {});
  const corridorYs = space.ys.filter((_, j) => space.yCorridor[j]);
  // Between rows f (5.51 + 3.5) and e (8.51 + 3.5) on the pin-board.
  assert.ok(corridorYs.some((y) => y > 9.01 && y < 12.01), "trench lanes"); // prettier-ignore
  // Between the top rail's `-` line (2.25) and row j (5.01).
  assert.ok(
    corridorYs.some((y) => y > 2.25 && y < 5.01),
    "dovetail lanes",
  );
  // A row of holes is never a corridor.
  const rowJ = space.ys.indexOf(5.01);
  assert.ok(rowJ >= 0 && !space.yCorridor[rowJ], "row j carries holes");
});

test("a mated kit is ONE region and needs no bridge", () => {
  const space = buildRouteSpace(kit().toJSON(), {});
  assert.equal(space.groups, 1);
  assert.equal(space.bridges.length, 0);
});

test("two separated kits are two regions, with a bridge between them", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0);
  doc.addKit("full", 0, 40);
  const space = buildRouteSpace(doc.toJSON(), {});
  assert.equal(space.groups, 2);
  assert.ok(space.bridges.length > 0);
  // The bridge lies BETWEEN them, not over either.
  for (const b of space.bridges) {
    assert.ok(b.y0 >= 21.02 - 1e-6 && b.y1 <= 40 + 1e-6, JSON.stringify(b));
  }
});

test("a chip closes the rows it occupies and leaves the next one open", () => {
  // The clearance arithmetic in miniature: a DIP's slab stops 0.45 pitch short
  // of rows e and f, so inflated it closes those rows and still leaves row d —
  // one pitch further out — free to route along. Both halves matter: closing
  // row d would make a chip unwireable, and leaving row e open would let a wire
  // run straight under the part.
  const doc = kit();
  const pins = doc.boards.find((b) => b.type === "pins-full").id;
  const chip = doc.addComponent({
    kind: "chip",
    ref: "74LS00",
    board: pins,
    anchor: "e10",
  });
  // chip-view.js's chipBodyBox for a DIP-14: the SLAB, not the footprint box —
  // the legs stand in their own pins' holes and need no clearance of their own.
  const space = buildRouteSpace(doc.toJSON(), {
    bodyBox: () => ({ minX: -0.6, minY: -2.55, width: 7.2, height: 2.1 }),
  });
  const at = (x, y) => space.nodeAt(x, y);

  const blocked = space.nodeBlockers.get(at(13, 3.5 + 8.51)); // row e
  assert.ok(blocked?.includes(chip.id), "row e is inside the body");
  assert.ok(!space.nodeBlockers.has(at(13, 3.5 + 9.51)), "row d is clear");
  assert.ok(!space.nodeBlockers.has(at(13, 3.5 + 4.51)), "row g is clear");
});

test("a wire's own terminal part is exempt — but only that one", () => {
  const doc = kit();
  const pins = doc.boards.find((b) => b.type === "pins-full").id;
  const net = doc.addComponent({
    kind: "discrete",
    ref: "rnet9", // body stands over the rows beside its own pins
    board: pins,
    anchor: "a10",
  });
  const chip = doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: "e30" }); // prettier-ignore
  // discrete-view.js's BOXES entry for an rnet9 — the block stands over the rows
  // beside its own pin row, which is exactly why the exemption has to exist.
  const space = buildRouteSpace(doc.toJSON(), {
    bodyBox: (c) =>
      c.ref === "rnet9"
        ? { minX: -0.7, minY: -2.9, width: 9.4, height: 3.5 }
        : { minX: -0.6, minY: -2.55, width: 7.2, height: 2.1 },
  });
  // A point inside the network's body is exempt for a wire that ends there…
  const inside = { x: 11, y: 3.5 + 11.51 }; // row b, under the rnet9
  const exempt = exemptObstacles(space, [inside]);
  assert.ok(exempt.has(net.id), "the part it is plugged into stands aside");
  assert.ok(!exempt.has(chip.id), "…and nothing else does");
  // …but a wire on a CHIP's node is not inside the chip, so the chip is never
  // exempted — which is what stops a lead flying over the part it just left.
  const beside = { x: 32, y: 3.5 + 4.51 }; // row g, beside the chip
  assert.equal(exemptObstacles(space, [beside]).size, 0);
});

test("a rotated rail's fractional hole columns become tracks of their own", () => {
  // The case a uniform lattice cannot express: turned 90°, a rail's two lines
  // land on fractional x. Reading the tracks off the real hole positions handles
  // it without anyone special-casing rotation.
  const doc = new DeskDoc(null);
  doc.addBoard("rail-full", 4, 0, 90);
  const board = doc.boards[0];
  const space = buildRouteSpace(doc.toJSON(), {});
  for (const hole of holes(board.type)) {
    const p = holePosition(board.type, hole, 90);
    assert.ok(space.nodeAt(board.x + p.x, board.y + p.y) >= 0, hole);
  }
  assert.ok(
    space.xs.some((x) => !Number.isInteger(x)),
    "fractional tracks exist",
  );
});

test("outside the region there is simply no node", () => {
  const space = buildRouteSpace(kit().toJSON(), {});
  // Far off the board: not a track at all, so not a node.
  assert.equal(space.nodeAt(500, 500), -1);
  // And every node the grid does hold is in the region.
  for (let n = 0; n < space.nx * space.ny; n += 1) {
    if (space.nodeKind[n] === OUTSIDE) continue;
    assert.ok([ON_BOARD, ON_BRIDGE].includes(space.nodeKind[n]));
  }
});

test("the cost floor is DERIVED from the bonuses, not typed beside them", () => {
  // If this drifts, A* stops being admissible and quietly returns worse routes.
  const c = makeRouteConfig({ bundleBonus: 0.3, corridorBonus: 0.2 });
  assert.ok(Math.abs(c.minEdgeCostPerUnit - 0.5) < 1e-9);
  const d = makeRouteConfig({ bundleBonus: 0, corridorBonus: 0 });
  assert.ok(Math.abs(d.minEdgeCostPerUnit - d.lengthCost) < 1e-9);
});

test("the grid is finer than the hole lattice — a wire can run between rows", () => {
  // The hole lattice gives one lane per pitch, which on a dense board is fewer
  // lanes than there are wires; the surplus then has nowhere to go but on top
  // of another wire. Half-pitch tracks double them.
  const space = buildRouteSpace(kit().toJSON(), {});
  const rowJ = 5.01;
  const rowI = 6.01;
  assert.ok(
    space.ys.some((y) => y > rowJ + 1e-6 && y < rowI - 1e-6),
    "there is a lane between rows j and i",
  );
  // And it is a CORRIDOR — no holes on it — so a wire there covers no tie
  // points, which is the whole reason it is worth having.
  const between = space.ys.findIndex((y) => y > rowJ + 1e-6 && y < rowI - 1e-6);
  assert.ok(space.yCorridor[between]);
});
