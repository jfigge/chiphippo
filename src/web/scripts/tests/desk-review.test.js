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

// desk-review.test.js — the engine-backed review of a hand-built desk (Feature
// 320). One fixture per finding, built in code as the engine fixtures are, plus
// the two cases that decide whether the list is usable at all: a circuit the
// app itself certifies must come back with NO faults, and an unpowered desk
// must report the missing supply rather than every input underneath it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DeskDoc, normalizeDocument } from "../model/desk-doc.js";
import { buildNetlist } from "../sim/netlist.js";
import { partDef } from "../catalog/index.js";
import { partPinAddresses } from "../model/occupancy.js";
import { compileNetlist } from "../model/autobuild.js";
import {
  reviewDesk,
  isEmptyDesk,
  FAULT,
  WARNING,
} from "../model/desk-review.js";

/** Review a plain document through a freshly derived netlist. */
const review = (json) => reviewDesk(json, buildNetlist(json));

/** Every finding code in a review, deduped. */
const codes = (r) => [...new Set(r.findings.map((f) => f.code))].sort();

/** The pin addresses of the last-added component, by pin number. */
function pinAddresses(json, compId) {
  const comp = json.components.find((c) => c.id === compId);
  return new Map(
    (partPinAddresses(json, comp) ?? []).map((p) => [p.pin, p.address]),
  );
}

/**
 * A free hole on the same 5-hole node as `address` — the hole a wire would use
 * to reach that pin. Rows a–e and f–j are the two halves; picking a row the pin
 * is not already in keeps it free for a part seated anywhere in the group (a
 * DIP sits in e/f, a discrete in whichever row it was dropped on).
 */
function nodeHole(address) {
  const [board, hole] = address.split(".");
  const row = hole[0];
  const col = hole.slice(1);
  const half = "abcde".includes(row) ? "abcde" : "fghij";
  return `${board}.${[...half].find((r) => r !== row)}${col}`;
}

/** A full kit + a 5 V PSU, with the PSU wired to the top rail. */
function powered({ volts = 5 } = {}) {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1 rail · bb2 pins · bb3 rail
  doc.addPsu(0, 40, { volts });
  doc.addWire({ from: "psu1.+", to: "bb1.+1", color: "red" });
  doc.addWire({ from: "psu1.-", to: "bb1.-1", color: "black" });
  return doc;
}

/** Seat a chip and return its id + resolved pin addresses. */
function seatChip(doc, ref, anchor) {
  const comp = doc.addComponent({ kind: "chip", ref, board: "bb2", anchor });
  return { id: comp.id, pins: pinAddresses(doc.toJSON(), comp.id) };
}

/**
 * Wire a chip's power pins to the rails. Which pins those are comes from the
 * CATALOG, never a literal here, so a part with non-standard power pins (the
 * '73, the '76) works without a special case.
 */
function wirePower(doc, ref, pins, col = 2) {
  const def = partDef(ref);
  const vcc = def.pins.find((p) => p.role === "vcc").n;
  const gnd = def.pins.find((p) => p.role === "gnd").n;
  doc.addWire({
    from: nodeHole(pins.get(vcc)),
    to: `bb1.+${col}`,
    color: "red",
  });
  doc.addWire({
    from: nodeHole(pins.get(gnd)),
    to: `bb1.-${col}`,
    color: "black",
  });
}

test("a circuit the compiler itself certifies reviews with no faults", () => {
  const built = compileNetlist({
    title: "NAND with switches and a lamp",
    parts: [
      { id: "U1", ref: "74LS00" },
      { id: "SW", ref: "sw-dip8" },
      { id: "D1", ref: "led" },
    ],
    nets: [
      { name: "A", members: ["U1.1A", "SW.1A"] },
      { name: "A_SRC", members: ["SW.1B", "VCC"] },
      { name: "B", members: ["U1.1B", "SW.2A"] },
      { name: "B_SRC", members: ["SW.2B", "VCC"] },
      { name: "Y", members: ["U1.1Y", "D1.A"] },
      { name: "LAMP", members: ["D1.K", "GND"] },
    ],
  });
  assert.ok(built.ok, JSON.stringify(built.errors));

  const r = review(normalizeDocument(built.document));
  const faults = r.findings.filter((f) => f.severity === FAULT);
  assert.deepEqual(
    faults.map((f) => f.code),
    [],
    faults.map((f) => f.message).join("\n"),
  );
  assert.ok(!codes(r).includes("INPUT_FLOATING"), "no input reported floating");
});

test("no power supply on the desk is reported once, not per chip", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0);
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb2", anchor: "e5" });
  const r = review(doc.toJSON());
  assert.equal(r.findings.filter((f) => f.code === "NO_SUPPLY").length, 1);
});

test("an empty desk has nothing to review", () => {
  const doc = new DeskDoc(null);
  assert.equal(isEmptyDesk(doc.toJSON()), true);
  assert.deepEqual(review(doc.toJSON()).findings, []);
  assert.equal(isEmptyDesk(powered().toJSON()), false);
});

test("a chip with no power wiring is reported as unpowered, once", () => {
  const doc = powered();
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb2", anchor: "e5" });
  const r = review(doc.toJSON());
  const unpowered = r.findings.filter((f) => f.code === "UNPOWERED_CHIP");
  assert.equal(unpowered.length, 1, "one finding, not one per power pin");
  // …and its inputs are NOT then listed underneath it.
  assert.ok(!codes(r).includes("INPUT_FLOATING"));
});

test("a used gate's undriven inputs are reported, once per part", () => {
  const doc = powered();
  const chip = seatChip(doc, "74LS00", "e5");
  wirePower(doc, "74LS00", chip.pins);
  // Gate 1 is IN USE — its output goes somewhere — while gates 2-4 are idle.
  const out = partDef("74LS00").logic.units[0].output;
  doc.addWire({
    from: nodeHole(chip.pins.get(out)),
    to: "bb2.a40",
    color: "blue",
  });

  const r = review(doc.toJSON());
  const floating = r.findings.filter((f) => f.code === "INPUT_FLOATING");
  assert.equal(floating.length, 1, "one finding for the whole chip");
  assert.equal(floating[0].componentId, chip.id);
  assert.match(floating[0].message, /1A/, "names the pins by silkscreen name");
  assert.doesNotMatch(floating[0].message, /4A/, "idle gates are not reported");
  assert.equal(floating[0].severity, WARNING);
});

test("a chip whose outputs go nowhere reports no floating inputs", () => {
  const doc = powered();
  const chip = seatChip(doc, "74LS00", "e5");
  wirePower(doc, "74LS00", chip.pins);
  const r = review(doc.toJSON());
  assert.ok(!codes(r).includes("INPUT_FLOATING"), "nothing depends on them");
});

test("a tri-state part with its enable unwired names the pin to tie LOW", () => {
  const doc = powered();
  const chip = seatChip(doc, "74LS244", "e5");
  wirePower(doc, "74LS244", chip.pins);
  const r = review(doc.toJSON());
  const disabled = r.findings.filter((f) => f.code === "OUTPUTS_DISABLED");
  assert.equal(disabled.length, 1);
  assert.match(disabled[0].message, /GND/);
  // The enable pins are NOT also listed as floating inputs — same fault twice.
  const floating = r.findings.find((f) => f.code === "INPUT_FLOATING");
  if (floating) assert.doesNotMatch(floating.message, /1G|2G/);
});

test("two outputs on one net are a bus fight whatever they are driving", () => {
  const doc = powered();
  const a = seatChip(doc, "74LS04", "e5");
  wirePower(doc, "74LS04", a.pins);
  const b = seatChip(doc, "74LS04", "e20");
  wirePower(doc, "74LS04", b.pins, 6);
  const def = partDef("74LS04");
  const out = def.pins.find((p) => p.role === "output").n;
  doc.addWire({
    from: nodeHole(a.pins.get(out)),
    to: nodeHole(b.pins.get(out)),
    color: "blue",
  });
  const r = review(doc.toJSON());
  const fight = r.findings.filter((f) => f.code === "BUS_FIGHT");
  assert.equal(fight.length, 1);
  assert.equal(fight[0].severity, FAULT);
  assert.match(fight[0].message, /74LS04/);
});

test("an LED straight across the rails is reported as burning", () => {
  const doc = powered();
  const led = doc.addComponent({
    kind: "discrete",
    ref: "led",
    board: "bb2",
    anchor: "a5",
    params: { color: "red" },
  });
  const pins = pinAddresses(doc.toJSON(), led.id);
  doc.addWire({ from: nodeHole(pins.get(1)), to: "bb1.+3", color: "red" });
  doc.addWire({ from: nodeHole(pins.get(2)), to: "bb1.-3", color: "black" });
  const r = review(doc.toJSON());
  const burnt = r.findings.filter((f) => f.code === "LED_UNLIMITED");
  assert.equal(burnt.length, 1);
  assert.equal(burnt[0].componentId, led.id);
});

test("a 12 V chip reports the engine's own damage wording", () => {
  const doc = powered({ volts: 12 });
  const chip = seatChip(doc, "74LS00", "e5");
  wirePower(doc, "74LS00", chip.pins);
  const r = review(doc.toJSON());
  assert.ok(codes(r).includes("DAMAGED"));
  const damaged = r.findings.find((f) => f.code === "DAMAGED");
  assert.match(damaged.message, /12 V/);
  assert.equal(damaged.componentId, chip.id);
});

test("faults sort ahead of warnings", () => {
  const doc = powered();
  const chip = seatChip(doc, "74LS244", "e5");
  wirePower(doc, "74LS244", chip.pins);
  const r = review(doc.toJSON());
  const ranks = r.findings.map((f) => (f.severity === FAULT ? 0 : 1));
  assert.deepEqual(ranks, [...ranks].sort(), "findings are severity-ordered");
});

test("the stats describe the desk", () => {
  const doc = powered();
  const chip = seatChip(doc, "74LS00", "e5");
  wirePower(doc, "74LS00", chip.pins);
  const r = review(doc.toJSON());
  assert.equal(r.stats.boards, 3, "a full kit is three strips");
  assert.equal(r.stats.parts, 2, "the PSU counts as a part");
  assert.equal(r.stats.chips, 1);
  assert.equal(r.stats.poweredChips, 1);
  assert.ok(r.stats.nets > 0);
});

test("no shipped example bench reports a fault", () => {
  // The ratchet that decides whether this list is worth showing anyone. These
  // are 52 real circuits the engine already validates against a datasheet truth
  // table (make demos), so any FAULT here is a false positive by definition —
  // and a false positive is worse than a missed finding, because it teaches the
  // user to skim the list. Warnings are allowed and two benches legitimately
  // carry one: the '125's enable rests on an open switch, and the '193's
  // count-down clock is deliberately left to float HIGH.
  const dir = fileURLToPath(new URL("../../demos/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length > 40, "the demo corpus is present");

  const offenders = [];
  for (const f of files) {
    const { doc } = JSON.parse(readFileSync(`${dir}${f}`, "utf8"));
    const json = normalizeDocument(doc);
    for (const found of review(json).findings) {
      if (found.severity === FAULT) offenders.push(`${f}: ${found.message}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("reviewing does not mutate the document it is given", () => {
  const doc = powered();
  const chip = seatChip(doc, "74LS00", "e5");
  wirePower(doc, "74LS00", chip.pins);
  const json = doc.toJSON();
  const before = JSON.stringify(json);
  review(json);
  assert.equal(JSON.stringify(json), before);
});
