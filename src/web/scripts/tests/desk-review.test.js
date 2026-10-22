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

test("the CD4094B's active-HIGH enable is reported the other way up", () => {
  // Its OUTPUT ENABLE floats Q1–Q8 while LOW — the one enable in the catalog
  // whose fix is "tie it HIGH", and the review must not say "tie it to GND".
  const doc = powered();
  const chip = seatChip(doc, "CD4094B", "e5");
  wirePower(doc, "CD4094B", chip.pins);
  const unwired = review(doc.toJSON()).findings.find(
    (f) => f.code === "OUTPUTS_DISABLED",
  );
  assert.match(unwired.message, /active-high output enable OUTPUT ENABLE/);
  assert.match(unwired.message, /Tie it HIGH/);
  assert.equal(unwired.severity, FAULT);
  // Wired LOW: a warning that it is switched off, and how to switch it on.
  doc.addWire({
    from: nodeHole(chip.pins.get(15)),
    to: "bb1.-9",
    color: "black",
  });
  const low = review(doc.toJSON()).findings.find(
    (f) => f.code === "OUTPUTS_DISABLED",
  );
  assert.match(low.message, /is LOW, so its outputs float\. Drive it HIGH/);
  assert.equal(low.severity, WARNING);
});

test("an enable wired to an output that floats right now is no missing wire", () => {
  // A Z80 drives a ROM's /CE and /OE itself (A15, /RD) — the classic minimal
  // board. A static settle finds the CPU in reset, every output floating, so
  // the enables read Z: the ROM is switched off for the moment (a warning),
  // not wired to nothing (the fault that says "tie it to GND").
  const doc = powered();
  const cpu = seatChip(doc, "Z80A", "e5");
  wirePower(doc, "Z80A", cpu.pins);
  const rom = seatChip(doc, "AT28C256", "e30");
  wirePower(doc, "AT28C256", rom.pins, 6);
  doc.addWire({ from: nodeHole(cpu.pins.get(5)), to: nodeHole(rom.pins.get(20)), color: "yellow" }); // prettier-ignore
  doc.addWire({ from: nodeHole(cpu.pins.get(21)), to: nodeHole(rom.pins.get(22)), color: "orange" }); // prettier-ignore
  const disabled = review(doc.toJSON()).findings.filter(
    (f) => f.code === "OUTPUTS_DISABLED",
  );
  assert.equal(disabled.length, 1);
  assert.equal(disabled[0].severity, WARNING);
  assert.doesNotMatch(disabled[0].message, /not wired at all/);
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

test("outputs that can all let go share a net — a wired-AND, a tri-state bus — and are no fight", () => {
  // The builder's own rule lets them share (spec-lint.js `switchableOutputs`),
  // so a desk it verified was reviewed as a FAULT. One output that cannot let
  // go among them still is.
  for (const [ref, also, fights] of [
    ["74LS03", "74LS03", 0], // open-collector NANDs, a wired-AND
    ["74LS244", "74LS244", 0], // two tri-state buffers on a bus
    ["74LS03", "74LS04", 1], // …but a totem-pole output among them
  ]) {
    const doc = powered();
    const a = seatChip(doc, ref, "e5");
    wirePower(doc, ref, a.pins);
    const b = seatChip(doc, also, "e20");
    wirePower(doc, also, b.pins, 6);
    const outOf = (r) => partDef(r).pins.find((p) => p.role === "output").n;
    doc.addWire({
      from: nodeHole(a.pins.get(outOf(ref))),
      to: nodeHole(b.pins.get(outOf(also))),
      color: "blue",
    });
    const r = review(doc.toJSON());
    const fight = r.findings.filter((f) => f.code === "BUS_FIGHT");
    assert.equal(fight.length, fights, `${ref} + ${also}`);
  }
});

test("a DIP-bodied part that is not a chip is named by its title, never its id", () => {
  // A 7-segment digit has a package, and was named "seg7cc" — an internal id
  // the user never sees anywhere — where a chip is named by its marking.
  const doc = powered();
  const digit = doc.addComponent({ kind: "discrete", ref: "seg7cc", board: "bb2", anchor: "d30", params: { wide: true } }); // prettier-ignore
  const pins = pinAddresses(doc.toJSON(), digit.id);
  assert.deepEqual([pins.get(7), pins.get(3)], ["bb2.h33", "bb2.d32"]);
  // Rows f, g and e are under its body: in from j and a.
  doc.addWire({ from: "bb2.j33", to: "bb1.+30", color: "red" }); // segment a
  doc.addWire({ from: "bb2.a32", to: "bb1.-30", color: "black" }); // COM
  const burn = review(doc.toJSON()).findings.find((f) => f.code === "LED_UNLIMITED"); // prettier-ignore
  assert.ok(burn, "it burns");
  assert.match(
    burn.message,
    new RegExp(partDef("seg7cc").title.replace(/[()]/g, "\\$&")),
  );
  assert.doesNotMatch(burn.message, /seg7cc/);
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

test("a chip Spice Lite let the brown smoke out is OVERLOADED, not damaged", () => {
  // The latch rides the document mid-run, and a review may be asked for
  // then: it must name the fault the run found, not 12 V's.
  const doc = powered();
  const chip = seatChip(doc, "74LS00", "e5");
  wirePower(doc, "74LS00", chip.pins);
  const json = doc.toJSON();
  json.components.find((c) => c.id === chip.id).params.overloaded = true;
  const r = review(json);
  assert.ok(codes(r).includes("OVERLOADED"));
  assert.ok(!codes(r).includes("DAMAGED"));
  const f = r.findings.find((x) => x.code === "OVERLOADED");
  assert.match(f.message, /brown smoke/);
  assert.equal(f.componentId, chip.id);
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

test("a clock wired into the circuit with no power is reported", async () => {
  const { bench } = await import("./timing-fixtures.js");
  const b = bench();
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 40, y: 30, params: { hz: 1 } }); // prettier-ignore
  const u = b.seat("u1", "74LS04", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  b.doc.wires.push({ id: "wc", from: "clk1.out", to: b.at(u.get(1).replace(/^e/, "a")), color: "orange" }); // prettier-ignore
  const found = review(b.doc).findings.filter(
    (f) => f.code === "CLOCK_UNPOWERED",
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].componentId, "clk1");
});

test("an input a signal flag or a data bus drives is not one nothing drives", () => {
  // The review settled with no signal levels, so every planted driver read
  // as nothing (the regrade, 2026-10-22).
  for (const via of ["signal", "data"]) {
    const doc = powered();
    const chip = seatChip(doc, "74LS04", "e5");
    wirePower(doc, "74LS04", chip.pins);
    doc.addWire({ from: nodeHole(chip.pins.get(2)), to: "bb2.a40", color: "blue" }); // prettier-ignore
    const json = doc.toJSON();
    const hole = nodeHole(chip.pins.get(1));
    if (via === "signal") {
      json.signals = [{ id: "sig1", color: "red", type: "toggle", rest: "high", flag: { anchor: hole, rot: 0 } }]; // prettier-ignore
    } else {
      json.integrations = [{ id: "data1", kind: "data", color: "red", fields: [{ type: "byte", name: "v" }], drive: ["1", "z", "z", "z", "z", "z", "z", "z"], tags: { 1: { anchor: hole, rot: 0 } } }]; // prettier-ignore
    }
    const norm = normalizeDocument(json);
    assert.ok((norm.signals?.length ?? 0) + (norm.integrations?.length ?? 0) > 0, via); // prettier-ignore
    const floating = review(norm).findings.filter((f) => f.code === "INPUT_FLOATING"); // prettier-ignore
    assert.deepEqual(floating, [], via);
  }
});

test("a desk run off Mains or an AC adapter has a supply", () => {
  for (const kind of ["ac", "adapter"]) {
    const doc = new DeskDoc(null);
    doc.addKit("full", 0, 0);
    const json = doc.toJSON();
    json.components.push({ id: kind === "ac" ? "ac1" : "adp1", kind, ref: kind, x: -20, y: 30, params: partDef(kind).normalizeParams({}) }); // prettier-ignore
    json.components.push({ id: "c1", kind: "discrete", ref: "resistor", board: "bb2", anchor: "a10", params: {} }); // prettier-ignore
    const norm = normalizeDocument(json);
    assert.equal(codes(review(norm)).includes("NO_SUPPLY"), false, kind);
  }
});
