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

// autoroute-corpus.test.js — auto-route every SHIPPED example circuit and hold
// the results to the rules (Feature 360).
//
// The scenario tests in autoroute.test.js each build one situation and check one
// property. This is the opposite: fifty-two real, densely-wired boards that
// nobody wrote for the router, run through it end to end. It is the same trick
// `autobuild-corpus.test.js` plays on the compiler, and for the same reason —
// the demos are a free corpus of circuits with no API key, no network and no
// hand-maintained fixtures behind them.
//
// What it holds:
//   · no route leaves the legal region, ever;
//   · no route enters a part it does not end on;
//   · no route exceeds the file format's twenty waypoints;
//   · THE NETLIST IS UNCHANGED — the claim that makes a one-click rewrite of
//     every wire on the desk a safe thing to offer at all;
//   · the routes survive a save/load round trip byte for byte;
//   · and it is deterministic, including against the order the wires arrive in.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DeskDoc } from "../model/desk-doc.js";
import { buildNetlist } from "../sim/netlist.js";
import { buildOccupancy } from "../model/occupancy.js";
import { addressWorld } from "../model/part-geometry.js";
import { MAX_WIRE_POINTS } from "../model/desk-doc.js";
import { OUTSIDE } from "../model/route-space.js";
import { SKIP_BUS_MEMBER, routeDesk, routePlan } from "../model/autoroute.js";
import { ROUTE_CONFIG } from "../model/route-config.js";

const DIR = fileURLToPath(new URL("../../demos/", import.meta.url));
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".json"));

/** A stable fingerprint of the electrical partition — every point, and which
    net it landed in. Two documents with the same one are the same circuit. */
const netSignature = (doc) =>
  [...buildNetlist(doc).netOfPoint.entries()]
    .map(([point, net]) => `${point}=${net}`)
    .sort()
    .join("|");

const load = (file) => {
  const raw = JSON.parse(readFileSync(`${DIR}${file}`, "utf8"));
  return new DeskDoc(raw.doc ?? raw);
};

/** Everything the router DECIDED — the paths and, since the router may now also
    move an end, the addresses it moved them to. Determinism has to cover both:
    a swap that came out differently run to run would be a document that differs
    while every drawn line matched. */
const shapeOf = (result) =>
  [
    ...[...result.routes.entries()]
      .map(
        ([id, r]) => `${id}:${r.points.map((p) => `${p.x},${p.y}`).join(";")}`,
      ) // prettier-ignore
      .sort(),
    ...[...result.reseats, ...result.swaps]
      .map((m) => `${m.wireId}.${m.end}:${m.from}>${m.to}`)
      .sort(),
  ].join("|");

/**
 * A route is orthogonal, with ONE sanctioned exception at each end.
 *
 * Runs sharing a lane are fanned off it so each wire is its own line, but a wire
 * still terminates EXACTLY on its hole — so the first and last segments pick up
 * the short angled lead-in a real lead has leaving its hole. Everything between
 * two corners is strictly axis-aligned, and the skew is bounded by how far a run
 * may be nudged, so a "lead-in" can never quietly become a diagonal route.
 */
function assertRunShape(route, id) {
  const pts = [route.ends[0], ...route.points, route.ends[1]];
  for (let i = 1; i < pts.length; i += 1) {
    const dx = Math.abs(pts[i - 1].x - pts[i].x);
    const dy = Math.abs(pts[i - 1].y - pts[i].y);
    if (dx < 1e-9 || dy < 1e-9) continue; // axis-aligned
    assert.ok(
      i === 1 || i === pts.length - 1,
      `${id}: a diagonal segment in the middle of the run`,
    );
    assert.ok(
      Math.min(dx, dy) <= ROUTE_CONFIG.laneOffsetMax + 1e-9,
      `${id}: the lead-in skews by ${Math.min(dx, dy)}`,
    );
  }
}

test("the corpus is actually there", () => {
  assert.ok(FILES.length > 40, `${FILES.length} shipped examples`);
});

for (const file of FILES) {
  test(`${file}: routes legally, and changes nothing electrical`, () => {
    const doc = load(file);
    const before = netSignature(doc.toJSON());
    const result = routeDesk(doc.toJSON(), {});

    for (const skip of result.skipped) {
      assert.equal(skip.reason, SKIP_BUS_MEMBER, `${skip.wireId}: ${skip.reason}`); // prettier-ignore
    }

    for (const [id, route] of result.routes) {
      assert.ok(
        route.points.length <= MAX_WIRE_POINTS,
        `${id}: ${route.points.length} waypoints`,
      );
      for (const n of route.nodes) {
        assert.notEqual(
          result.space.nodeKind[n],
          OUTSIDE,
          `${id} left the legal region`,
        );
      }
      // Every rung of the escalation ladder past the first is a compromise, and
      // on a demo bench there should be no need for one.
      assert.equal(route.via, "direct", `${id} needed ${route.via}`);
      assert.equal(route.cost.overPart, 0, `${id} ran over a part`);
      assertRunShape(route, id);
    }

    const applied = doc.applyRoutes(routePlan(result));
    assert.equal(applied, result.routes.size);
    assert.equal(
      netSignature(doc.toJSON()),
      before,
      "the circuit is untouched",
    );

    // The router may MOVE an end — a power lead along its rail, a signal wire
    // within its own tie-point strip — so "the route ends on the wire's hole"
    // has to be asked of the document as it now stands. Both are same-node
    // moves, which is why the netlist above did not notice; this is the other
    // half, that the drawing and the addresses agree about where the wire is.
    const after = doc.toJSON();
    // Occupied holes as GRID NODES, resolved exactly. Going the other way — a
    // route node looked up with `addressAtWorld` — answers with whatever hole is
    // within the hit radius, and the lanes are a third of a pitch apart, so a
    // run passing tidily BESIDE a lead reads as running through it.
    const occupied = new Map();
    for (const address of buildOccupancy(after).keys()) {
      const p = addressWorld(after.boards, after.components, address);
      if (p) occupied.set(result.space.nodeAt(p.x, p.y), address);
    }
    for (const [id, route] of result.routes) {
      const wire = after.wires.find((w) => w.id === id);
      for (const [end, at] of [
        [wire.from, route.ends[0]],
        [wire.to, route.ends[1]],
      ]) {
        const p = addressWorld(after.boards, after.components, end);
        assert.ok(
          Math.abs(p.x - at.x) < 1e-9 && Math.abs(p.y - at.y) < 1e-9,
          `${id}: the route does not start where the wire does (${end})`,
        );
      }
      // And no route may run THROUGH a tie point something is standing in —
      // asked of the holes as the moves left them, not as they were found.
      const ends = new Set([route.nodes[0], route.nodes[route.nodes.length - 1]]); // prettier-ignore
      for (const n of route.nodes) {
        if (ends.has(n)) continue;
        assert.ok(
          !occupied.has(n),
          `${id} ran through ${occupied.get(n)}, which has a lead in it`,
        );
      }
    }

    // A route only counts if it survives being written to a file and read back:
    // normalizeDocument re-coerces every waypoint on load.
    const reloaded = new DeskDoc(doc.toJSON());
    assert.equal(netSignature(reloaded.toJSON()), before);
    for (const wire of reloaded.wires) {
      assert.deepEqual(
        wire.points ?? [],
        doc.getWire(wire.id).points ?? [],
        `${wire.id}: waypoints are stable across a save/load`,
      );
    }
  });
}

test("deterministic, order-independent, and tidy — one sweep, three claims", () => {
  // The property negotiated congestion exists to give: no wire's outcome may
  // depend on where it happened to sit in the document. The quality numbers ride
  // along on the same sweep rather than paying for a corpus pass of their own;
  // they are deliberately loose, here to catch a regression that makes the
  // router obviously worse rather than to pin the current tuning.
  let wires = 0;
  let bends = 0;
  let overlap = 0;
  let routed = 0;
  // Every fourth board, not all of them: this sweep routes each one three times
  // and the whole corpus at that rate is more wall-clock than a unit suite
  // should spend. The per-file tests above still cover every board once.
  for (const file of FILES.filter((_, i) => i % 8 === 0)) {
    const json = load(file).toJSON();
    const first = routeDesk(json, {});
    assert.equal(shapeOf(routeDesk(json, {})), shapeOf(first), `${file} twice`);
    const permuted = { ...json, wires: [...json.wires].reverse() };
    assert.equal(
      shapeOf(routeDesk(permuted, {})),
      shapeOf(first),
      `${file} reversed`,
    );
    for (const [, route] of first.routes) {
      wires += 1;
      bends += route.bends;
    }
    overlap += first.diagnostics.overlapUnits;
    routed += first.diagnostics.routedUnits;
  }
  assert.ok(wires > 100, `${wires} wires is a real sample`);
  assert.ok(
    bends / wires < 2.5,
    `${(bends / wires).toFixed(2)} bends per wire`,
  );
  assert.ok(
    overlap / routed < 0.02,
    `${((100 * overlap) / routed).toFixed(2)}% of run is doubled up`,
  );
});
