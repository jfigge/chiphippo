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

// The build-plan derivation (Feature 140): a fixture desk yields the expected
// BOM counts, a net-grouped human-addressed wiring list, an ordered assembly
// checklist, and the right warnings. Pure — a doc built in code, no DOM.

import test from "node:test";
import assert from "node:assert/strict";

import { DeskDoc } from "../model/desk-doc.js";
import { buildNetlist } from "../sim/netlist.js";
import { buildPlan } from "../model/build-plan.js";

/**
 * A small but representative desk: a full breadboard, a PSU, two chips, an LED,
 * a named signal net, a one-member net, a 2-bit bus, and an injected floating
 * LED lead. Returns the plain document + its netlist.
 */
function fixture() {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1 rail@0 · bb2 pins@3 · bb3 rail@16 (group g1)
  doc.addPsu(0, 40, { volts: 5 });
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb2", anchor: "e5" });
  doc.addComponent({
    kind: "chip",
    ref: "74LS04",
    board: "bb2",
    anchor: "e20",
  });
  doc.addComponent({
    kind: "discrete",
    ref: "led",
    board: "bb2",
    anchor: "f40",
    params: { color: "red" },
  });

  // Power distribution: PSU terminals → the top rail.
  doc.addWire({ from: "psu1.+", to: "bb1.+1", color: "red" });
  doc.addWire({ from: "psu1.-", to: "bb1.-1", color: "black" });

  // A named signal net joining the two chips' pin-1 columns.
  doc.addWire({ from: "bb2.a5", to: "bb2.a20", color: "blue" });
  doc.nameNet("bb2.a5", "SIG0");

  // A one-member net: 74LS00 pin 2's column (col 6) wired to a bare hole.
  doc.addWire({ from: "bb2.b6", to: "bb2.j50", color: "green" });

  // A 2-bit bus over two wires clear of every chip (rows h, cols 45–49).
  const bw0 = doc.addWire({ from: "bb2.h45", to: "bb2.h48", color: "yellow" });
  const bw1 = doc.addWire({ from: "bb2.h46", to: "bb2.h49", color: "yellow" });
  doc.addBus("D[1:0]", [bw1.id, bw0.id], { color: "yellow" }); // member 0 = msb

  // Inject a floating LED lead (a rotated LED whose far leg is over nothing).
  const json = doc.toJSON();
  json.components.push({
    id: `c${json.nextComponentId++}`,
    kind: "discrete",
    ref: "led",
    board: "bb2",
    anchor: "a60",
    params: { color: "green", flip: false, rot: 90, end: { dx: 40, dy: 0 } },
  });

  return { document: json, netlist: buildNetlist(json) };
}

const plan = () => {
  const { document, netlist } = fixture();
  return buildPlan(document, netlist);
};

const findLine = (lines, key) => lines.find((l) => l.key === key);

test("BOM counts every part by catalog identity", () => {
  const { bom } = plan();

  // Boards count by strip type (Feature 110 made a breadboard a kit of strips).
  assert.deepEqual(findLine(bom.boards, "pins-full"), {
    key: "pins-full",
    title: "Full pin-board",
    count: 1,
  });
  assert.equal(findLine(bom.boards, "rail-full").count, 2);

  assert.equal(findLine(bom.chips, "74LS00").count, 1);
  assert.equal(findLine(bom.chips, "74LS04").count, 1);
  assert.equal(findLine(bom.chips, "74LS00").title, "Quad 2-input NAND");

  // LEDs split by colour: one red, one green (the injected floating one).
  assert.equal(findLine(bom.discretes, "led:red").title, "LED (red)");
  assert.equal(findLine(bom.discretes, "led:red").count, 1);
  assert.equal(findLine(bom.discretes, "led:green").count, 1);

  // The PSU is a line item, split by voltage.
  assert.deepEqual(findLine(bom.power, "psu:5"), {
    key: "psu:5",
    title: "Power supply (5 V)",
    count: 1,
  });
});

test("the wiring list is net-centric with human, component-relative labels", () => {
  const { nets } = plan();

  // The named net leads with its name and lists both chip pins by name.
  const sig = nets.find((n) => n.name === "SIG0");
  assert.ok(sig, "expected a net named SIG0");
  assert.equal(sig.isSingleton, false);
  const sigLabels = sig.members.map((m) => m.label).sort();
  assert.deepEqual(sigLabels, ["74LS00 pin 1 (1A)", "74LS04 pin 1 (1A)"]);

  // A power net collapses its rail and names the PSU terminal.
  const plus = nets.find((n) =>
    n.members.some((m) => m.label === "Power supply +"),
  );
  assert.ok(plus, "expected a net with the PSU + terminal");
  assert.ok(
    plus.members.some((m) => m.kind === "rail" && m.label === "+ rail (bb1)"),
  );

  // The unnamed nets are never labelled by their raw net key.
  for (const n of nets) {
    for (const m of n.members) {
      assert.notEqual(
        m.label,
        n.netId,
        "a member label must never be the net id",
      );
    }
  }
});

test("buses render as a grouped block, sorted before plain nets", () => {
  const { nets } = plan();
  const busNets = nets.filter((n) => n.bus);
  assert.equal(busNets.length, 2, "a 2-bit bus yields two bit nets");
  assert.ok(busNets.every((n) => n.bus.name === "D[1:0]"));
  // MSB (bit 1) sorts before LSB (bit 0), and both precede every non-bus net.
  assert.deepEqual(
    busNets.map((n) => n.bus.bit),
    [1, 0],
  );
  const firstNonBus = nets.findIndex((n) => !n.bus);
  const lastBus = nets.map((n) => Boolean(n.bus)).lastIndexOf(true);
  assert.ok(lastBus < firstNonBus, "all bus nets come first");
});

test("a one-member net is flagged", () => {
  const { nets } = plan();
  const lonely = nets.find(
    (n) => n.members.length === 1 && n.members[0].label === "74LS00 pin 2 (1B)",
  );
  assert.ok(lonely, "expected the one-member net on 74LS00 pin 2");
  assert.equal(lonely.isSingleton, true);
});

test("steps are ordered boards → power → chips → discretes → wires", () => {
  const { steps } = plan();
  const rank = { boards: 0, power: 1, chips: 2, discretes: 3, wires: 4 };
  let last = -1;
  for (const s of steps) {
    assert.ok(rank[s.group] >= last, `group ${s.group} is out of order`);
    last = rank[s.group];
  }
  // Every group is present.
  assert.deepEqual(
    [...new Set(steps.map((s) => s.group))],
    ["boards", "power", "chips", "discretes", "wires"],
  );
});

test("board / chip / discrete steps read like bench instructions", () => {
  const { steps } = plan();

  // The whole kit is one 'assemble' step (stable group id).
  const boards = steps.filter((s) => s.group === "boards");
  assert.equal(boards.length, 1);
  assert.match(boards[0].text, /Assemble a breadboard/);
  assert.equal(boards[0].id, "step:boards:g1");

  // A chip step spells out orientation + straddle rows + pin 1.
  const chip = steps.find((s) => s.id === "step:chips:c1");
  assert.match(chip.text, /74LS00 straddling e5–f11, pin 1 at bb2\.e5/);

  // The power step runs the PSU into the rail, by friendly labels.
  const power = steps.find((s) => s.id === "step:power:w1");
  assert.match(power.text, /Power supply \+ → \+ rail \(bb1\)/);
});

test("the bus is laid before the plain signal nets, as one step", () => {
  const { steps } = plan();
  const wireSteps = steps.filter((s) => s.group === "wires");
  assert.equal(wireSteps[0].id, "step:wires:bus1");
  assert.match(wireSteps[0].text, /Lay the D\[1:0\] bus/);
  assert.equal(wireSteps[0].detail.length, 2, "one sub-item per bit wire");

  // The named signal net is a later step in the same group.
  assert.ok(wireSteps.some((s) => /Wire the SIG0 net/.test(s.text)));
});

test("warnings call out floating leads, unpowered chips, and lone nets", () => {
  const { warnings } = plan();
  const kinds = warnings.map((w) => w.kind);

  // The injected floating LED lead.
  const floating = warnings.find((w) => w.kind === "floating-lead");
  assert.ok(floating, "expected a floating-lead warning");
  assert.match(floating.message, /LED .* is floating/);

  // Both chips are unpowered (no VCC/GND wiring in the fixture).
  assert.equal(kinds.filter((k) => k === "unpowered-chip").length, 2);

  // The one-member net is called out.
  assert.ok(
    warnings.some(
      (w) => w.kind === "single-member-net" && /74LS00 pin 2/.test(w.message),
    ),
  );
});

test("an empty document yields an empty, well-formed plan", () => {
  const doc = new DeskDoc(null).toJSON();
  const p = buildPlan(doc, buildNetlist(doc));
  assert.deepEqual(p.bom, { boards: [], chips: [], discretes: [], power: [] });
  assert.deepEqual(p.nets, []);
  assert.deepEqual(p.steps, []);
  assert.deepEqual(p.warnings, []);
});
