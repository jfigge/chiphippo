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
// split-rail.test.js — the split power rail (`rail-split`): a full-length
// rail strip whose two rails are cut in the middle, so each half is its own
// node, its own net, its own net name and its own supply — and two supplies
// at different voltages meeting on one `+` net is now a reported fault.

import test from "node:test";
import assert from "node:assert/strict";

import {
  holesOfNode,
  nodeOf,
  railSegments,
  spec,
} from "../model/breadboard.js";
import { BOARD_TYPES, BREADBOARD_KITS } from "../model/board-types.js";
import { DeskDoc } from "../model/desk-doc.js";
import { buildPlan } from "../model/build-plan.js";
import { reviewDesk } from "../model/desk-review.js";
import { railLineOf } from "../model/rail-reseat.js";
import { railStripes } from "../desk/rail-stripes.js";
import { buildBoard } from "../scene3d/board-model.js";
import { buildNetlist } from "../sim/netlist.js";
import { ENGINES } from "../sim/engines.js";
import { CHIP_STATUS } from "../sim/engine.js";

// ── The strip ────────────────────────────────────────────────────────────────

test("a split rail is a full rail's holes, cut after hole 25", () => {
  const split = spec("rail-split");
  const full = spec("rail-full");
  for (const k of [
    "width",
    "height",
    "railHoles",
    "railGroup",
    "railStartX",
    "tiePoints",
  ]) {
    assert.equal(split[k], full[k], k);
  }
  assert.equal(split.kind, "rail");
  assert.equal(split.railSplit, 25);
  assert.equal(BREADBOARD_KITS["rail-split"].strips[0].type, "rail-split");
});

test("railSegments: one per rail on a continuous strip, two on a split one", () => {
  assert.deepEqual(
    railSegments("rail-full").map((g) => [g.node, g.first, g.last]),
    [
      ["+", 1, 50],
      ["-", 1, 50],
    ],
  );
  assert.deepEqual(
    railSegments("rail-split").map((g) => [g.node, g.railId, g.first, g.last]),
    [
      ["L+", "+", 1, 25],
      ["R+", "+", 26, 50],
      ["L-", "-", 1, 25],
      ["R-", "-", 26, 50],
    ],
  );
  assert.deepEqual(railSegments("pins-full"), []);
  // The polarity is every node id's last character (netPolarity reads it).
  for (const type of Object.keys(BOARD_TYPES)) {
    for (const g of railSegments(type)) assert.equal(g.node.at(-1), g.polarity);
  }
});

test("each half of a split rail is its own node", () => {
  assert.equal(nodeOf("rail-split", "+1"), "L+");
  assert.equal(nodeOf("rail-split", "+25"), "L+");
  assert.equal(nodeOf("rail-split", "+26"), "R+");
  assert.equal(nodeOf("rail-split", "-50"), "R-");
  assert.equal(holesOfNode("rail-split", "L+").length, 25);
  assert.deepEqual(holesOfNode("rail-split", "R-").slice(0, 2), ["-26", "-27"]);
  assert.equal(holesOfNode("rail-split", "+"), null); // no whole-rail node
  assert.equal(holesOfNode("rail-full", "L+"), null);
});

test("the printed stripe breaks where the rail does — in the desk and 3D alike", () => {
  assert.equal(railStripes("rail-full").length, 2);
  const stripes = railStripes("rail-split");
  assert.equal(stripes.length, 4);
  const [left, right] = stripes.filter((s) => s.polarity === "+");
  assert.ok(right.x0 - left.x1 >= 1, "a gap of bare plastic at the cut");
  // Both halves together span exactly what the full rail's stripe does.
  const [whole] = railStripes("rail-full").filter((s) => s.polarity === "+");
  assert.equal(left.x0, whole.x0);
  assert.equal(right.x1, whole.x1);
});

test("the 3D model prints the same broken stripe", () => {
  const stripeQuads = (type, rot = 0) => {
    const colours = [];
    const sb = {
      palette: new Proxy({}, { get: (_, key) => key }), // each colour its name
      mesh: { extrude() {}, quad: (...args) => colours.push(args[4]) },
    };
    buildBoard(sb, { id: "bb1", type, x: 0, y: 0, rot });
    return colours.filter((c) => c === "railPlus" || c === "railMinus");
  };
  assert.equal(stripeQuads("rail-full").length, 2);
  assert.deepEqual(stripeQuads("rail-split"), ["railPlus", "railPlus", "railMinus", "railMinus"]); // prettier-ignore
  assert.equal(stripeQuads("rail-split", 90).length, 4);
});

// ── A bench: a split rail over a pin-board, two supplies ─────────────────────

/**
 * bb1 a split rail along the top, bb2 a full pin-board under it; a 74LS04 on
 * the left fed from the L half, a CD4069UB on the right fed from the R half.
 * psu1 (5 V) feeds L+, psu2 (`rightVolts`) feeds R+, both grounds on their
 * own − half, with the − halves jumpered together.
 */
function bench({ rightVolts = 9, joinPlus = false, joinMinus = true } = {}) {
  const doc = new DeskDoc(null);
  doc.addBoard("rail-split", 0, 0); // bb1
  doc.addBoard("pins-full", 0, 3.5); // bb2
  doc.addPsu(-20, 0, { volts: 5 }); // psu1
  doc.addPsu(80, 0, { volts: rightVolts }); // psu2
  doc.addComponent({ kind: "chip", ref: "74LS04", board: "bb2", anchor: "e5" });
  doc.addComponent({
    kind: "chip",
    ref: "CD4069UB",
    board: "bb2",
    anchor: "e40",
  });
  const wire = (from, to) => doc.addWire({ from, to, color: "red" });
  wire("psu1.+", "bb1.+2");
  wire("psu1.-", "bb1.-2");
  wire("psu2.+", "bb1.+49");
  wire("psu2.-", "bb1.-49");
  wire("bb1.+5", "bb2.j5"); // '04 pin 14 (f5)
  wire("bb1.-11", "bb2.a11"); // '04 pin 7 (e11)
  wire("bb1.+40", "bb2.j40"); // 4069 VDD, pin 14 (f40)
  wire("bb1.-46", "bb2.a46"); // 4069 VSS, pin 7 (e46)
  if (joinMinus) wire("bb1.-25", "bb1.-26");
  if (joinPlus) wire("bb1.+25", "bb1.+26");
  return doc;
}

test("the two halves are two nets, and the rail list says which", () => {
  const nl = buildNetlist(bench({ joinMinus: false }).toJSON());
  const left = nl.netOfPoint.get("bb1.+1");
  const right = nl.netOfPoint.get("bb1.+50");
  assert.notEqual(left, right);
  assert.equal(left, nl.netOfPoint.get("bb1.+25"));
  assert.equal(right, nl.netOfPoint.get("bb1.+26"));
  assert.deepEqual(nl.nets.get(left).rails, ["bb1.L+"]);
  assert.deepEqual(nl.nets.get(right).rails, ["bb1.R+"]);
  assert.notEqual(nl.netOfPoint.get("bb1.-1"), nl.netOfPoint.get("bb1.-50"));
});

test("a jumper across the cut makes one net of both halves", () => {
  const nl = buildNetlist(bench({ joinPlus: true }).toJSON());
  const net = nl.nets.get(nl.netOfPoint.get("bb1.+1"));
  assert.equal(nl.netOfPoint.get("bb1.+50"), net.id);
  assert.deepEqual(net.rails, ["bb1.L+", "bb1.R+"]);
  // And the grounds the bench jumpered are one net.
  assert.equal(nl.netOfPoint.get("bb1.-1"), nl.netOfPoint.get("bb1.-50"));
});

test("each half takes its own net name, with no conflict", () => {
  const doc = bench();
  doc.nameNet("bb1.+3", "VCC5");
  doc.nameNet("bb1.+48", "VDD9");
  const nl = buildNetlist(doc.toJSON());
  assert.equal(nl.names.get(nl.netOfPoint.get("bb1.+1")), "VCC5");
  assert.equal(nl.names.get(nl.netOfPoint.get("bb1.+50")), "VDD9");
  assert.equal(nl.nameConflicts.length, 0);
});

test("the build guide names a half by its holes", () => {
  const plan = buildPlan(bench().toJSON(), buildNetlist(bench().toJSON(), null, { bridges: false })); // prettier-ignore
  const labels = plan.nets.flatMap((n) => n.members.map((m) => m.label));
  assert.ok(labels.includes("+ rail, holes 1–25 (bb1)"), labels.join(" | "));
  assert.ok(labels.includes("+ rail, holes 26–50 (bb1)"));
});

test("the rail reseat treats each half as its own line", () => {
  const boards = bench().toJSON().boards;
  assert.equal(railLineOf(boards, "bb1.+3"), "bb1.L+");
  assert.equal(railLineOf(boards, "bb1.+30"), "bb1.R+");
});

// ── Two supplies, both engines ───────────────────────────────────────────────

const settleIn = (engine, doc) => {
  const json = doc.toJSON();
  return ENGINES[engine].settle({
    document: json,
    netlist: buildNetlist(json),
  });
};
const meets = (r) => r.warnings.filter((w) => w.type === "supplies-meet");

for (const engine of ["digital", "spice"]) {
  test(`${engine}: each half powers its own chip at its own voltage`, () => {
    const r = settleIn(engine, bench());
    const status = (id) => r.chipStatus.get(id);
    assert.equal(status("c1").status, CHIP_STATUS.OK, "74LS04 on the 5 V half");
    assert.equal(
      status("c2").status,
      CHIP_STATUS.OK,
      "CD4069UB on the 9 V half",
    );
    assert.ok(Math.abs(status("c1").volts - 5) < 0.3, `${status("c1").volts}`);
    assert.ok(Math.abs(status("c2").volts - 9) < 0.5, `${status("c2").volts}`);
    assert.deepEqual(meets(r), []);
    assert.equal(
      r.warnings.some((w) => w.type === "short"),
      false,
    );
  });

  test(`${engine}: jumpering the + halves together is a supplies-meet fault`, () => {
    const r = settleIn(engine, bench({ joinPlus: true }));
    const found = meets(r);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].volts, [5, 9]);
    assert.deepEqual([...found[0].psus].sort(), ["psu1", "psu2"]);
  });

  test(`${engine}: two supplies at the same voltage on one net do not clash`, () => {
    const r = settleIn(engine, bench({ rightVolts: 5, joinPlus: true }));
    assert.deepEqual(meets(r), []);
  });
}

test("the desk review calls jumpered + halves a fault, and shared grounds nothing", () => {
  const review = (doc) => {
    const json = doc.toJSON();
    return reviewDesk(json, buildNetlist(json)).findings;
  };
  const clash = review(bench({ joinPlus: true })).filter((f) => f.code === "SUPPLIES_MEET"); // prettier-ignore
  assert.equal(clash.length, 1);
  assert.equal(clash[0].severity, "fault");
  assert.match(clash[0].message, /5 V \/ 9 V/);
  assert.equal(
    review(bench()).some((f) => f.code === "SUPPLIES_MEET"),
    false,
  );
});
