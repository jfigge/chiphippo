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

// Tests for the auto-router (Feature 360) — model/autoroute.js and the two
// modules under it. Pure: documents built in code, no DOM, no view layer.
//
// The scenarios are the ones the feature plan names, and they are written as
// PROPERTIES of the returned route rather than as expected coordinate lists. A
// pinned path would fail every time a cost is tuned, which is the opposite of
// what these should do: the router's job is stated as "inside the boards, around
// the parts, few bends, short" and that is what each test asks about.
//
// The bodies here come from PIN EXTENTS, since `bodyBox` is the view layer's to
// inject — which makes these tests honest about the fallback path too.

import test from "node:test";
import assert from "node:assert/strict";

import { DeskDoc } from "../model/desk-doc.js";
import { addressWorld } from "../model/part-geometry.js";
import { partPinAddresses } from "../model/occupancy.js";
import { nodeOf, parseAddress } from "../model/breadboard.js";
import { ROUTE_CONFIG, makeRouteConfig } from "../model/route-config.js";
import {
  SKIP_BUS_MEMBER,
  SKIP_NO_PATH,
  routeDesk,
  routePlan,
} from "../model/autoroute.js";
import {
  ON_BOARD,
  ON_BRIDGE,
  OUTSIDE,
  buildRouteSpace,
} from "../model/route-space.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A full 830 kit at the origin, plus whatever the caller builds on it. */
function bench() {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0);
  const pins = doc.boards.find((b) => b.type === "pins-full");
  const rails = doc.boards.filter((b) => b.type === "rail-full");
  return { doc, pins: pins.id, railTop: rails[0].id, railBottom: rails[1].id };
}

/**
 * Route with the ENDPOINTS PINNED.
 *
 * The eighteen scenarios below all ask the same kind of question — given these
 * two holes, what path does it choose — so they run with `swapNodeEnds` off.
 * With it on the router may answer a better question instead (scenario 2's
 * one-corner geometry becomes a dead straight run once one end is allowed to
 * slide a row), and a test that cannot tell "wrong" from "improved" is no test.
 * The end chooser has its own section at the bottom of this file, and the
 * shipped configuration is exercised end to end by `autoroute-corpus.test.js`.
 */
const FIXED_ENDS = makeRouteConfig({ swapNodeEnds: false });
const run = (doc, opts = {}) =>
  routeDesk(doc.toJSON(), { config: FIXED_ENDS, ...opts });

/** A route's full point list in world units, ends included. */
function shape(doc, result, wireId) {
  const json = doc.toJSON();
  const wire = json.wires.find((w) => w.id === wireId);
  const a = addressWorld(json.boards, json.components, wire.from);
  const b = addressWorld(json.boards, json.components, wire.to);
  return [a, ...result.routes.get(wireId).points, b];
}

const segments = (pts) => {
  const out = [];
  for (let i = 1; i < pts.length; i += 1) out.push([pts[i - 1], pts[i]]);
  return out;
};

/**
 * Every segment is axis-aligned, with ONE sanctioned exception at each end: a
 * run fanned off a shared lane still terminates exactly on its hole, so the
 * first and last segments carry the short angled lead-in a real lead has leaving
 * its hole. The skew is bounded, so a lead-in can never become a diagonal route.
 */
function assertOrthogonal(pts, what) {
  const segs = segments(pts);
  segs.forEach(([p, q], i) => {
    const dx = Math.abs(p.x - q.x);
    const dy = Math.abs(p.y - q.y);
    if (dx < 1e-9 || dy < 1e-9) return;
    assert.ok(
      i === 0 || i === segs.length - 1,
      `${what}: (${p.x},${p.y})→(${q.x},${q.y}) is a diagonal mid-run`,
    );
    assert.ok(Math.min(dx, dy) <= ROUTE_CONFIG.laneOffsetMax + 1e-9, what);
  });
}

const orient = (a, b, c) =>
  Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));

/** A PROPER crossing — touching or sharing an endpoint does not count. */
function crosses(a, b, c, d) {
  const o = [
    orient(a, b, c),
    orient(a, b, d),
    orient(c, d, a),
    orient(c, d, b),
  ];
  return o[0] !== o[1] && o[2] !== o[3] && o.every((v) => v !== 0);
}

function crossingCount(p, q) {
  let n = 0;
  for (const [a, b] of segments(p)) {
    for (const [c, d] of segments(q)) if (crosses(a, b, c, d)) n += 1;
  }
  return n;
}

/** Does any segment enter a rect? */
function entersRect(pts, r) {
  const inside = (p) => p.x > r.x0 && p.x < r.x1 && p.y > r.y0 && p.y < r.y1;
  for (const [a, b] of segments(pts)) {
    if (inside(a) || inside(b)) return true;
    // Axis-aligned segments only: sample the span against the rect's slab.
    if (Math.abs(a.y - b.y) < 1e-9 && a.y > r.y0 && a.y < r.y1) {
      if (Math.min(a.x, b.x) < r.x1 && Math.max(a.x, b.x) > r.x0) return true;
    }
    if (Math.abs(a.x - b.x) < 1e-9 && a.x > r.x0 && a.x < r.x1) {
      if (Math.min(a.y, b.y) < r.y1 && Math.max(a.y, b.y) > r.y0) return true;
    }
  }
  return false;
}

// ── 1–3: the shapes ─────────────────────────────────────────────────────────

test("1. two nearby pins on one row route dead straight, no bends", () => {
  const { doc, pins } = bench();
  const w = doc.addWire({ from: `${pins}.a5`, to: `${pins}.a9` });
  const result = run(doc);
  const route = result.routes.get(w.id);
  assert.equal(route.bends, 0);
  assert.deepEqual(route.points, [], "a straight run needs no waypoints");
  assertOrthogonal(shape(doc, result, w.id), "straight hop");
});

test("2. a one-corner connection gets exactly one waypoint", () => {
  const { doc, pins } = bench();
  // Same column-side, different row and column: one 90° turn reaches it.
  const w = doc.addWire({ from: `${pins}.a5`, to: `${pins}.d12` });
  const result = run(doc);
  const route = result.routes.get(w.id);
  assert.equal(route.bends, 1, "one turn");
  assert.equal(route.points.length, 1, "one waypoint per bend");
  assertOrthogonal(shape(doc, result, w.id), "L");
});

test("3. a connection round an obstacle takes more bends, all orthogonal", () => {
  const { doc, pins } = bench();
  doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: "e5" });
  // From above the chip to below it: it has to get round the body.
  const w = doc.addWire({ from: `${pins}.g6`, to: `${pins}.c6` });
  const result = run(doc);
  const route = result.routes.get(w.id);
  assert.ok(route.bends >= 2, `${route.bends} bends to get round`);
  assertOrthogonal(shape(doc, result, w.id), "detour");
});

// ── 4–5, 12, 16: obstacles ──────────────────────────────────────────────────

test("4. a component between two points is routed AROUND, not through", () => {
  const { doc, pins } = bench();
  const chip = doc.addComponent({
    kind: "chip",
    ref: "74LS00", // DIP-14: rows e/f, columns 10..16
    board: pins,
    anchor: "e10",
  });
  const w = doc.addWire({ from: `${pins}.g13`, to: `${pins}.c13` });
  const result = run(doc);
  const pts = shape(doc, result, w.id);
  const space = result.space;
  const box = space.inflated.find((o) => o.id === chip.id);
  assert.ok(box, "the chip is an obstacle");
  assert.ok(!entersRect(pts, box.rect), "the route clears the chip body");
  // And the straight chord it replaced would NOT have.
  assert.ok(entersRect([pts[0], pts[pts.length - 1]], box.rect));
});

test("5. a narrow corridor between two components is used, and cleared", () => {
  const { doc, pins } = bench();
  // Two DIP-14s with exactly one free column between them (16 and 20 ends at
  // 22, so column 17..19 is the gap; a wire has to thread it).
  const a = doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: "e10" }); // prettier-ignore
  const b = doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: "e18" }); // prettier-ignore
  const w = doc.addWire({ from: `${pins}.g14`, to: `${pins}.c22` });
  const result = run(doc);
  const pts = shape(doc, result, w.id);
  const space = result.space;
  for (const id of [a.id, b.id]) {
    const box = space.inflated.find((o) => o.id === id);
    assert.ok(!entersRect(pts, box.rect), `clears ${id}`);
  }
  assertOrthogonal(pts, "corridor");
});

test("12. a longer route wins when the short one crosses a part", () => {
  const { doc, pins } = bench();
  const chip = doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: "e10" }); // prettier-ignore
  const w = doc.addWire({ from: `${pins}.j13`, to: `${pins}.a13` });
  const result = run(doc);
  const pts = shape(doc, result, w.id);
  const box = result.space.inflated.find((o) => o.id === chip.id);
  assert.ok(!entersRect(pts, box.rect));
  // It is genuinely longer than the straight drop it gave up.
  const straight = Math.abs(pts[0].y - pts[pts.length - 1].y);
  assert.ok(
    result.routes.get(w.id).lengthUnits > straight,
    "the detour costs length, and is taken anyway",
  );
});

test("16. two parts a whisker apart do not become a routing corridor", () => {
  const { doc, pins } = bench();
  // Adjacent DIP-14s with NO free column between them: 10..16 then 17..23.
  doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: "e10" });
  doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: "e17" });
  const w = doc.addWire({ from: `${pins}.g13`, to: `${pins}.c20` });
  const result = run(doc);
  const pts = shape(doc, result, w.id);
  for (const o of result.space.inflated) {
    assert.ok(!entersRect(pts, o.rect), "no body is clipped");
  }
  // The only ways across are round the ends of the pair.
  const xs = pts.map((p) => p.x);
  assert.ok(
    Math.min(...xs) < 10 || Math.max(...xs) > 23,
    `${JSON.stringify(pts)}: it went round, not between`,
  );
});

// ── 6–8, 13–15: wire against wire ───────────────────────────────────────────

test("6. two wires that need not cross, do not", () => {
  const { doc, pins } = bench();
  const w1 = doc.addWire({ from: `${pins}.a5`, to: `${pins}.a20` });
  const w2 = doc.addWire({ from: `${pins}.c5`, to: `${pins}.c20` });
  const result = run(doc);
  assert.equal(
    crossingCount(shape(doc, result, w1.id), shape(doc, result, w2.id)),
    0,
  );
});

test("8. parallel wires run on their own tracks, never on top of each other", () => {
  const { doc, pins } = bench();
  const ids = [];
  for (const row of ["a", "b", "c", "d"]) {
    ids.push(doc.addWire({ from: `${pins}.${row}5`, to: `${pins}.${row}25` }).id); // prettier-ignore
  }
  const result = run(doc);
  assert.equal(result.diagnostics.overlapUnits, 0, "no doubled-up wire");
  // Each stayed on its own row: four straight runs, no bends between them.
  for (const id of ids) assert.equal(result.routes.get(id).bends, 0);
});

test("13. a slightly longer route is preferred to crossing a wire", () => {
  const { doc, pins } = bench();
  // A short run across a row, and a wire that would cross it if it took the
  // direct drop from b10 to d10 straight through c10.
  const w1 = doc.addWire({ from: `${pins}.c5`, to: `${pins}.c14` });
  const w2 = doc.addWire({ from: `${pins}.b10`, to: `${pins}.d10` });
  const result = run(doc);
  const s1 = shape(doc, result, w1.id);
  const s2 = shape(doc, result, w2.id);
  assert.equal(crossingCount(s1, s2), 0, "the crossing was routed away");
  // And it cost something to do it: one of the two is longer than its own
  // straight run, which is the trade the requirement asks for.
  const direct = 2; // b10 → d10 is two pitches straight down
  assert.ok(
    result.routes.get(w2.id).lengthUnits > direct ||
      result.routes.get(w1.id).lengthUnits > 9,
    "somebody went the long way round to keep them apart",
  );
});

test("14. crossing IS taken when avoiding it would be a ridiculous detour", () => {
  const { doc, pins } = bench();
  // A wire spanning almost the whole board, held FIXED (it is not in the
  // selection, so the router may not move it), and one that has to get past it.
  const w1 = doc.addWire({ from: `${pins}.c2`, to: `${pins}.c62` });
  const w2 = doc.addWire({ from: `${pins}.a30`, to: `${pins}.e30` });
  const result = routeDesk(doc.toJSON(), { config: FIXED_ENDS, only: new Set([w2.id]) }); // prettier-ignore
  assert.ok(!result.routes.has(w1.id), "the long wire was left alone");

  const route = result.routes.get(w2.id);
  // Going round the end of a 60-column wire costs ~60 pitch; crossing costs 12.
  // The router takes the crossing rather than the absurdity.
  assert.ok(
    route.lengthUnits < 20,
    `${route.lengthUnits}: it crossed rather than detoured`,
  );
  assert.ok(route.cost.crossings > 0, "and the crossing is priced, not hidden");
  const s1 = [
    { x: 2, y: 14.01 },
    { x: 62, y: 14.01 },
  ];
  assert.ok(crossingCount(s1, shape(doc, result, w2.id)) >= 1);
});

test("a wire outside the selection is TERRAIN, not empty space", () => {
  const { doc, pins } = bench();
  // Without the terrain rule the second wire would lie straight along row c,
  // exactly on top of the first, and nothing would notice.
  const w1 = doc.addWire({ from: `${pins}.c5`, to: `${pins}.c30` });
  const w2 = doc.addWire({ from: `${pins}.c31`, to: `${pins}.c40` });
  const only = routeDesk(doc.toJSON(), { config: FIXED_ENDS, only: new Set([w2.id]) }); // prettier-ignore
  assert.ok(only.routes.has(w2.id));
  assert.equal(only.diagnostics.overlapUnits, 0, "it kept off the other wire");
  void w1;
});

test("15. routing order cannot starve a wire — every one is placed", () => {
  const { doc, pins } = bench();
  // Eight wires competing for the same span of rows.
  const ids = [];
  for (let i = 0; i < 8; i += 1) {
    ids.push(
      doc.addWire({ from: `${pins}.a${2 + i}`, to: `${pins}.j${40 + i}` }).id,
    );
  }
  const result = run(doc);
  for (const id of ids) {
    assert.ok(result.routes.has(id), `${id} was routed`);
  }
  assert.equal(result.skipped.length, 0);
  // And the ORDER of the wires in the document does not decide the outcome.
  const permuted = doc.toJSON();
  permuted.wires = [...permuted.wires].reverse();
  const other = routeDesk(permuted, { config: FIXED_ENDS });
  for (const id of ids) {
    assert.deepEqual(
      other.routes.get(id).points,
      result.routes.get(id).points,
      `${id} routes the same whichever order it is offered in`,
    );
  }
});

// ── 9–11: boards, edges and gaps ────────────────────────────────────────────

test("9. a route near the board edge stays on the board", () => {
  const { doc, pins } = bench();
  const w = doc.addWire({ from: `${pins}.a1`, to: `${pins}.j2` });
  const result = run(doc);
  const space = result.space;
  for (const n of result.routes.get(w.id).nodes) {
    assert.equal(space.nodeKind[n], ON_BOARD, "never leaves the boards");
  }
});

test("10. two mated strips are ONE region — no bridge is needed or used", () => {
  const { doc, pins, railTop } = bench();
  const w = doc.addWire({ from: `${pins}.j10`, to: `${railTop}.-9` });
  const result = run(doc);
  assert.equal(result.space.groups, 1, "the kit is one connected region");
  assert.equal(result.space.bridges.length, 0, "nothing to bridge");
  assert.equal(result.routes.get(w.id).cost.gap, 0, "no gap was crossed");
  for (const n of result.routes.get(w.id).nodes) {
    assert.equal(result.space.nodeKind[n], ON_BOARD);
  }
});

test("11. a wire to an off-board brick crosses a bridge, and is charged for it", () => {
  const { doc, railBottom } = bench();
  const psu = doc.addBrick("psu", 70, 8);
  const w = doc.addWire({ from: `${railBottom}.+1`, to: `${psu.id}.+` });
  const result = run(doc);
  assert.ok(result.space.bridges.length > 0, "a corridor was opened");
  assert.ok(result.routes.has(w.id), "and the wire reaches the terminal");
  assert.ok(
    result.routes.get(w.id).cost.gap > 0,
    "leaving the boards is charged once",
  );
  // It still ENDS exactly on the terminal, not near it.
  const pts = shape(doc, result, w.id);
  assert.deepEqual(pts[pts.length - 1], { x: 72, y: 12 });
});

test("two separate board groups get a bridge between them", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0);
  doc.addKit("full", 0, 40); // a clear gap below the first
  const space = buildRouteSpace(doc.toJSON(), {});
  assert.equal(space.groups, 2);
  assert.ok(space.bridges.length > 0, "the gap is bridgeable");
});

// ── 17–18: endpoints and determinism ────────────────────────────────────────

test("17. a route terminates ON its connection point, with no transition", () => {
  const { doc, pins } = bench();
  const w = doc.addWire({ from: `${pins}.a5`, to: `${pins}.h30` });
  const result = run(doc);
  const json = doc.toJSON();
  const a = addressWorld(json.boards, json.components, w.from);
  const b = addressWorld(json.boards, json.components, w.to);
  const route = result.routes.get(w.id);
  // On the 0.01 grid every stored coordinate uses — a hole's y is a board
  // offset plus a row constant, so it arrives with float dust on it, and the
  // track it lands on is the rounded value. That IS the coordinate a waypoint
  // would be stored as, so the comparison is made on the same grid.
  const near = (p, q, what) => {
    assert.ok(Math.abs(p.x - q.x) < 0.005 && Math.abs(p.y - q.y) < 0.005, what);
  };
  near(route.ends[0], a, "starts exactly on the hole");
  near(route.ends[1], b, "ends exactly on the hole");
  // Every hole is already a node of the grid, which is WHY no transition
  // geometry is needed — assert that rather than trusting it.
  assert.ok(result.space.nodeAt(a.x, a.y) >= 0);
  assert.ok(result.space.nodeAt(b.x, b.y) >= 0);
});

test("18. equally valid routes resolve the same way every time", () => {
  const { doc, pins } = bench();
  // A symmetric problem: the L can go either way round.
  doc.addWire({ from: `${pins}.a10`, to: `${pins}.e20` });
  doc.addWire({ from: `${pins}.j10`, to: `${pins}.f20` });
  const first = run(doc);
  for (let i = 0; i < 4; i += 1) {
    const again = run(doc);
    for (const [id, route] of first.routes) {
      assert.deepEqual(again.routes.get(id).points, route.points, `${id} run ${i}`); // prettier-ignore
    }
  }
});

// ── Contracts the desk depends on ───────────────────────────────────────────

test("a bus member is never routed — its shape belongs to the ribbon", () => {
  const { doc, pins } = bench();
  const a = doc.addWire({ from: `${pins}.a5`, to: `${pins}.a20` });
  const b = doc.addWire({ from: `${pins}.b5`, to: `${pins}.b20` });
  doc.addBus("D[0:1]", [a.id, b.id]);
  const result = run(doc);
  assert.equal(result.routes.size, 0);
  assert.deepEqual(
    result.skipped.map((s) => s.reason),
    [SKIP_BUS_MEMBER, SKIP_BUS_MEMBER],
  );
});

test("a wire with an unresolvable endpoint is left alone, and said so", () => {
  const { doc, pins } = bench();
  const w = doc.addWire({ from: `${pins}.a5`, to: `${pins}.a20` });
  const json = doc.toJSON();
  json.wires[0].to = "bbX.a1"; // a board that is not there
  const result = routeDesk(json, { config: FIXED_ENDS });
  assert.equal(result.routes.size, 0);
  assert.equal(result.skipped[0].wireId, w.id);
});

test("a boxed-in wire escalates rather than failing outright", () => {
  const { doc, pins } = bench();
  // Fill the trench across the whole board so there is no way between the
  // halves except round the ends — then block those too by routing from a hole
  // that has no legal exit at all is impossible, so assert the LADDER instead:
  // with bodies hard, a wire under a chip has to go round; with the board
  // packed, it is allowed over.
  for (let col = 1; col <= 56; col += 7) {
    doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: `e${col}` }); // prettier-ignore
  }
  const w = doc.addWire({ from: `${pins}.g4`, to: `${pins}.c4` });
  const result = run(doc);
  const route = result.routes.get(w.id);
  assert.ok(route, "a route was produced");
  // Either it found the way round the end of the row of chips, or it reported
  // going over one — never silence.
  if (route.via !== "direct") {
    assert.ok(route.cost.overPart > 0, "and it says it went over a part");
  }
});

test("the plan is a whole-document edit: one call, every wire, ONE undo step", () => {
  const { doc, pins } = bench();
  doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: "e10" });
  doc.addWire({ from: `${pins}.g13`, to: `${pins}.c13` });
  doc.addWire({ from: `${pins}.a5`, to: `${pins}.a20` });
  const before = doc.snapshot();

  const result = run(doc);
  const applied = doc.applyRoutes(routePlan(result));
  assert.equal(applied, 2);
  for (const wire of doc.wires) assert.equal(wire.layout, "routed");

  // Nothing electrical moved: the addresses are untouched, which is what makes
  // this safe to offer as one click.
  assert.deepEqual(
    doc.wires.map((w) => [w.from, w.to]),
    before.wires.map((w) => [w.from, w.to]),
  );
  doc.restore(before);
  assert.deepEqual(doc.toJSON(), before, "one restore puts it all back");
});

test("a refused plan changes nothing at all", () => {
  const { doc, pins } = bench();
  doc.addWire({ from: `${pins}.a5`, to: `${pins}.a20` });
  const before = doc.snapshot();
  assert.throws(
    () =>
      doc.applyRoutes([
        { id: "w1", points: [{ x: 1, y: 1 }] },
        { id: "w999", points: [] }, // no such wire
      ]),
    /NOT_FOUND|no wire/,
  );
  assert.deepEqual(doc.toJSON(), before, "rolled back whole");
});

test("routes never exceed the file format's waypoint cap", () => {
  const { doc, pins } = bench();
  for (let col = 1; col <= 56; col += 7) {
    doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: `e${col}` }); // prettier-ignore
  }
  for (let i = 0; i < 6; i += 1) {
    doc.addWire({ from: `${pins}.a${2 + i}`, to: `${pins}.j${50 + i}` });
  }
  const result = run(doc);
  for (const [id, route] of result.routes) {
    assert.ok(route.points.length <= 20, `${id}: ${route.points.length}`);
  }
});

test("every waypoint lands inside the legal region", () => {
  const { doc, pins, railTop } = bench();
  doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: "e10" });
  doc.addWire({ from: `${pins}.g13`, to: `${railTop}.-20` });
  doc.addWire({ from: `${pins}.a2`, to: `${pins}.j40` });
  const result = run(doc);
  for (const [id, route] of result.routes) {
    for (const n of route.nodes) {
      assert.notEqual(result.space.nodeKind[n], OUTSIDE, `${id} left the desk`);
    }
  }
});

test("`only` routes just the wires it names", () => {
  const { doc, pins } = bench();
  const a = doc.addWire({ from: `${pins}.a5`, to: `${pins}.a20` });
  doc.addWire({ from: `${pins}.c5`, to: `${pins}.c20` });
  const result = routeDesk(doc.toJSON(), { config: FIXED_ENDS, only: new Set([a.id]) }); // prettier-ignore
  assert.deepEqual([...result.routes.keys()], [a.id]);
});

test("the config is the one place the priorities live", () => {
  const { doc, pins } = bench();
  doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: "e10" });
  const w = doc.addWire({ from: `${pins}.j13`, to: `${pins}.a13` });

  // Bends free: the router should be happy to zig-zag.
  const loose = run(doc, { config: makeRouteConfig({ bendCost: 0 }) });
  // Bends expensive: it should take the straightest way round it can.
  const tight = run(doc, { config: makeRouteConfig({ bendCost: 40 }) });
  assert.ok(
    tight.routes.get(w.id).bends <= loose.routes.get(w.id).bends,
    "raising the bend cost cannot increase the bend count",
  );
});

test("the report breaks a route's cost down", () => {
  const { doc, pins } = bench();
  doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: "e10" });
  const w = doc.addWire({ from: `${pins}.g13`, to: `${pins}.c13` });
  const route = run(doc).routes.get(w.id);
  for (const key of [
    "total",
    "length",
    "bends",
    "crossings",
    "overlap",
    "corridor",
    "gap",
    "overPart",
  ]) {
    assert.equal(typeof route.cost[key], "number", `cost.${key} is reported`);
  }
  assert.ok(route.cost.length > 0);
  assert.ok(route.cost.bends > 0, "it turned, and the report says what that cost"); // prettier-ignore
  assert.equal(route.via, "direct");
});

test("SKIP_NO_PATH is what an unroutable wire reports", () => {
  // Not reachable on a real board (the region is connected), so the constant is
  // asserted rather than provoked — it is the string a report quotes.
  assert.equal(SKIP_NO_PATH, "NO_LEGAL_PATH");
});

// ── Every wire on its own plane (lane separation) ───────────────────────────
// The routing grid is the board's hole lattice, so its lanes are one pitch
// apart. A dense board has fewer lanes than wires, which means runs MUST share
// one — and two runs on one lane land on exactly the same line, drawing as a
// single wire. Real jumpers never do that because they arch at different
// heights; this is the two-dimensional equivalent.

test("two wires forced onto one lane are drawn as two lines, not one", () => {
  const { doc, pins } = bench();
  // Both must run along row a between the same columns: there is one lane and
  // two wires for it.
  const a = doc.addWire({ from: `${pins}.a5`, to: `${pins}.a30` });
  const b = doc.addWire({ from: `${pins}.a10`, to: `${pins}.a25` });
  const result = run(doc);
  const sa = shape(doc, result, a.id);
  const sb = shape(doc, result, b.id);

  // Nowhere do the two lie on exactly the same line over a shared span.
  for (const [p, q] of segments(sa)) {
    for (const [r, s] of segments(sb)) {
      const bothH = Math.abs(p.y - q.y) < 1e-9 && Math.abs(r.y - s.y) < 1e-9;
      if (!bothH || Math.abs(p.y - r.y) > 1e-9) continue;
      const over =
        Math.min(Math.max(p.x, q.x), Math.max(r.x, s.x)) -
        Math.max(Math.min(p.x, q.x), Math.min(r.x, s.x));
      assert.ok(over <= 1e-9, `${over} pitch of one line drawn over the other`);
    }
  }
  // And both still terminate EXACTLY on their holes — the fan-out moves the
  // run, never the connection.
  const json = doc.toJSON();
  for (const [wire, s] of [
    [a, sa],
    [b, sb],
  ]) {
    const from = addressWorld(json.boards, json.components, wire.from);
    assert.ok(Math.abs(s[0].x - from.x) < 0.005);
    assert.ok(Math.abs(s[0].y - from.y) < 0.005);
  }
});

test("on a board with more wires than lanes, none is drawn over another", () => {
  // A tiny 170-point board — seventeen columns, ten rows, no rails — with more
  // wires crossing it than there are lanes to put them in. Something has to
  // share, and the fan-out is what stops the sharers becoming one line.
  const doc = new DeskDoc(null);
  doc.addKit("tiny", 0, 0);
  const pins = doc.boards[0].id;
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    ids.push(doc.addWire({ from: `${pins}.a${2 + i}`, to: `${pins}.a${16 - i}` }).id); // prettier-ignore
  }
  const result = run(doc);
  assert.equal(result.routes.size, 6);
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const si = shape(doc, result, ids[i]);
      const sj = shape(doc, result, ids[j]);
      for (const [p, q] of segments(si)) {
        for (const [r, t] of segments(sj)) {
          const bothH =
            Math.abs(p.y - q.y) < 1e-9 && Math.abs(r.y - t.y) < 1e-9;
          if (!bothH || Math.abs(p.y - r.y) > 1e-9) continue;
          const over =
            Math.min(Math.max(p.x, q.x), Math.max(r.x, t.x)) -
            Math.max(Math.min(p.x, q.x), Math.min(r.x, t.x));
          assert.ok(
            over <= 1e-9,
            `${ids[i]}/${ids[j]}: ${over} pitch collinear`,
          );
        }
      }
    }
  }
});

test("a wire with a lane to itself is left exactly on it", () => {
  const { doc, pins } = bench();
  // Nothing to share with: no fan-out, no bow, no waypoints at all.
  const w = doc.addWire({ from: `${pins}.a5`, to: `${pins}.a30` });
  const result = run(doc);
  assert.deepEqual(result.routes.get(w.id).points, []);
});

test("the fan-out is bounded, so a run never reaches the next lane", () => {
  const { doc, pins } = bench();
  for (let i = 0; i < 5; i += 1) {
    doc.addWire({ from: `${pins}.a${4 + i}`, to: `${pins}.a${40 - i}` });
  }
  const result = run(doc);
  const near = (v, tracks) => Math.min(...tracks.map((t) => Math.abs(v - t)));
  for (const [id, route] of result.routes) {
    for (const p of route.points) {
      // A nudged waypoint stays beside a real track — never adrift between two,
      // which would make the lane it claims to be on a fiction.
      assert.ok(
        near(p.y, result.space.ys) <= ROUTE_CONFIG.laneOffsetMax + 1e-9,
        `${id}: y adrift by ${near(p.y, result.space.ys)}`,
      );
      assert.ok(
        near(p.x, result.space.xs) <= ROUTE_CONFIG.laneOffsetMax + 1e-9,
        `${id}: x adrift by ${near(p.x, result.space.xs)}`,
      );
    }
  }
});

// ── The air between two boards is not a short cut ───────────────────────────

test("a wire with both ends on one board never leaves it", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0);
  doc.addKit("full", 0, 30); // a second board, with a clear gap between
  const [b1] = doc.boards
    .filter((b) => b.type === "pins-full")
    .map((b) => b.id);
  // Pack the first board so its own lanes are contested and the empty gap
  // below it looks tempting: no holes, no parts, nothing in the way.
  for (let col = 2; col <= 44; col += 7) {
    doc.addComponent({ kind: "chip", ref: "74LS00", board: b1, anchor: `e${col}` }); // prettier-ignore
  }
  const ids = [];
  for (let i = 0; i < 8; i += 1) {
    ids.push(doc.addWire({ from: `${b1}.a${3 + i * 5}`, to: `${b1}.j${50 - i * 2}` }).id); // prettier-ignore
  }
  const result = run(doc);
  assert.ok(result.space.bridges.length > 0, "a bridge does exist");
  for (const id of ids) {
    for (const n of result.routes.get(id).nodes) {
      assert.equal(
        result.space.nodeKind[n],
        ON_BOARD,
        `${id} took a short cut through the gap`,
      );
    }
  }
});

test("a wire that genuinely spans two boards may cross the gap", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0);
  doc.addKit("full", 0, 30);
  const [b1, b2] = doc.boards
    .filter((b) => b.type === "pins-full")
    .map((b) => b.id);
  const w = doc.addWire({ from: `${b1}.a20`, to: `${b2}.j20` });
  const result = run(doc);
  const route = result.routes.get(w.id);
  assert.ok(route, "it is routed");
  assert.ok(
    route.nodes.some((n) => result.space.nodeKind[n] === ON_BRIDGE),
    "and it does use the bridge, because there is no other way across",
  );
  assert.ok(route.cost.gap > 0, "charged for leaving the boards");
});

test("a wire never runs through a hole with a lead already in it", () => {
  // The most obviously impossible thing the router used to do: a run straight
  // down a row of end caps. On a real bench the lead standing in that tie point
  // is physically in the way.
  const { doc, pins } = bench();
  // A line of wire ends along row h, and one wire that would like to run
  // straight along it.
  for (let col = 13; col <= 21; col += 2) {
    doc.addWire({ from: `${pins}.h${col}`, to: `${pins}.j${col}` });
  }
  const w = doc.addWire({ from: `${pins}.h11`, to: `${pins}.h23` });
  const result = run(doc);

  const occupied = new Set();
  for (const wire of doc.toJSON().wires) {
    for (const address of [wire.from, wire.to]) {
      if (address === w.from || address === w.to) continue;
      const p = addressWorld(doc.toJSON().boards, [], address);
      if (p) occupied.add(result.space.nodeAt(p.x, p.y));
    }
  }
  for (const [id, route] of result.routes) {
    for (const n of route.nodes) {
      // A wire may of course stand in its OWN holes.
      const ends = new Set([
        route.nodes[0],
        route.nodes[route.nodes.length - 1],
      ]);
      if (ends.has(n)) continue;
      assert.ok(!occupied.has(n), `${id} ran through an occupied tie point`);
    }
  }
  // And the wire that wanted the row still got somewhere.
  assert.ok(result.routes.has(w.id));
});

test("a part's own pins are not free space either", () => {
  const { doc, pins } = bench();
  const chip = doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: "e10" }); // prettier-ignore
  const w = doc.addWire({ from: `${pins}.e5`, to: `${pins}.e30` });
  const result = run(doc);
  const json = doc.toJSON();
  const pinAddresses = new Set(
    (
      partPinAddresses(
        json,
        json.components.find((c) => c.id === chip.id),
      ) ?? []
    )
      .map((p) => p.address)
      .filter(Boolean),
  );
  for (const n of result.routes.get(w.id).nodes) {
    const p = result.space.pointOf(n);
    for (const address of pinAddresses) {
      const q = addressWorld(json.boards, json.components, address);
      assert.ok(
        !q || Math.abs(q.x - p.x) > 1e-9 || Math.abs(q.y - p.y) > 1e-9,
        `ran through the chip's pin at ${address}`,
      );
    }
  }
});

// ── End swaps (`swapNodeEnds`) ──────────────────────────────────────────────
// The one pass that questions where a wire ENDS. Everything above pins the
// endpoints, because a test that cannot tell "wrong" from "improved" is no
// test; these ask about the improvement itself, and about the two ways it could
// be got wrong — a lead landing where it cannot go, and a plan that cannot be
// written to the document.

/** Which node (`c12U`) a wire's end sits in, which is what may NOT change. */
const nodeKey = (doc, address) => {
  const { boardId, hole } = parseAddress(address);
  const board = doc.toJSON().boards.find((b) => b.id === boardId);
  return `${boardId}.${nodeOf(board.type, hole)}`;
};

test("a wire's end slides within its own strip when that routes better", () => {
  // Nothing is in the way here — the improvement is the CORNER. Row a to row d
  // two columns over needs a bend; the same connection made from row d needs
  // none, and the five holes of a column-half are one node, so it is the same
  // connection.
  const { doc, pins } = bench();
  const w = doc.addWire({ from: `${pins}.a5`, to: `${pins}.d12` });
  const pinned = run(doc).routes.get(w.id);
  assert.equal(pinned.bends, 1, "with the ends fixed it has to turn");

  const result = routeDesk(doc.toJSON(), {});
  assert.equal(
    result.routes.get(w.id).bends,
    0,
    "given the strip, it does not",
  );
  assert.equal(result.swaps.length, 1);
  const [swap] = result.swaps;
  assert.equal(swap.wireId, w.id);
  assert.equal(nodeKey(doc, swap.from), nodeKey(doc, swap.to), "same node");
  assert.notEqual(swap.from, swap.to);
});

test("a swap never moves an end off its own electrical node", () => {
  const { doc, pins } = bench();
  doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: "e10" });
  for (let i = 0; i < 6; i += 1) {
    doc.addWire({ from: `${pins}.a${3 + i}`, to: `${pins}.j${30 + i * 2}` });
  }
  const result = routeDesk(doc.toJSON(), {});
  assert.ok(result.swaps.length > 0, "the pass found something to do");
  for (const swap of result.swaps) {
    assert.equal(
      nodeKey(doc, swap.from),
      nodeKey(doc, swap.to),
      `${swap.wireId} left its node`,
    );
  }
});

test("a swap never claims a hole something is already in", () => {
  const { doc, pins } = bench();
  const chip = doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: "e10" }); // prettier-ignore
  // Column 12's upper half holds the chip's pin at f12 and two wire ends; the
  // only free holes are the two left over, and two wires want them.
  doc.addWire({ from: `${pins}.g12`, to: `${pins}.a40` });
  doc.addWire({ from: `${pins}.h12`, to: `${pins}.a45` });
  const result = routeDesk(doc.toJSON(), {});

  const json = doc.toJSON();
  const claimed = new Map(); // address → who has it now
  for (const wire of json.wires) {
    for (const end of ["from", "to"]) claimed.set(wire[end], wire.id);
  }
  for (const swap of result.swaps) {
    // The move is applied over the top of the document, so the target must have
    // been free of everything except the wire that is leaving it.
    const holder = claimed.get(swap.to);
    assert.ok(
      holder === undefined || holder === swap.wireId,
      `${swap.wireId} took ${swap.to}, which ${holder} was in`,
    );
  }
  for (const { address } of partPinAddresses(
    json,
    json.components.find((c) => c.id === chip.id),
  ) ?? []) {
    assert.ok(
      !result.swaps.some((s) => s.to === address),
      `a lead was planted in the chip's own pin at ${address}`,
    );
  }
});

test("the plan a swap produces can be applied in any order", () => {
  // The hazard the `vacated` set exists for: A frees a hole and B takes it, but
  // the document is written one endpoint at a time and B cannot move in until A
  // has moved out. Rather than order a chain of moves — and give up on a cycle —
  // a vacated hole is never offered to anyone else, so the plan holds however it
  // is applied. `applyRoutes` would throw if it did not.
  const { doc, pins } = bench();
  doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: "e10" });
  doc.addComponent({ kind: "chip", ref: "74LS04", board: pins, anchor: "e30" });
  for (let i = 0; i < 10; i += 1) {
    doc.addWire({ from: `${pins}.j${11 + i}`, to: `${pins}.a${31 + i}` });
  }
  const before = doc.toJSON();
  const result = routeDesk(before, {});
  assert.ok(result.swaps.length > 0, "there are swaps to get wrong");
  const plan = routePlan(result);
  const copy = () => new DeskDoc(JSON.parse(JSON.stringify(before)));

  const forwards = copy();
  assert.equal(forwards.applyRoutes(plan), result.routes.size, "forwards");
  const backwards = copy();
  assert.equal(backwards.applyRoutes([...plan].reverse()), plan.length, "back");
  const ends = (d) =>
    d.wires
      .map((w) => `${w.id}:${w.from}->${w.to}`)
      .sort()
      .join("|");
  assert.equal(ends(backwards), ends(forwards), "and land the same document");
});

test("the swap pass is deterministic, and so are the addresses it moves", () => {
  const { doc, pins } = bench();
  doc.addComponent({ kind: "chip", ref: "74LS00", board: pins, anchor: "e10" });
  for (let i = 0; i < 8; i += 1) {
    doc.addWire({ from: `${pins}.j${20 + i}`, to: `${pins}.a${40 + i}` });
  }
  const json = doc.toJSON();
  const first = routeDesk(json, {});
  const twice = routeDesk(json, {});
  const reversed = routeDesk({ ...json, wires: [...json.wires].reverse() }, {});
  const key = (r) => JSON.stringify(r.swaps);
  assert.equal(key(twice), key(first), "twice running");
  assert.equal(key(reversed), key(first), "and whatever order they arrive in");
});
