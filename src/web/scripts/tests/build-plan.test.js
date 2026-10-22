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

// The build-plan derivation (Feature 140): a fixture desk yields the expected
// BOM counts, a net-grouped human-addressed wiring list, an ordered assembly
// checklist, and the right warnings. Pure — a doc built in code, no DOM.

import test from "node:test";
import assert from "node:assert/strict";

import { DeskDoc } from "../model/desk-doc.js";
import { buildNetlist } from "../sim/netlist.js";
import { buildPlan } from "../model/build-plan.js";
import { setCustomChips } from "../catalog/index.js";
import { newCustomChip } from "../model/custom-chip.js";
import { wireCutMm, wireLengthLabel } from "../model/wire-length.js";

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
  // A chip's line leads with its part number: "Quad 2-input NAND" alone is a
  // 74LS00 and a CD4011B both.
  assert.equal(findLine(bom.chips, "74LS00").title, "74LS00 — Quad 2-input NAND"); // prettier-ignore

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

// As a desk brick the LCD had NEITHER: no placement step at all, and one
// un-split BOM line. Seating it puts it through the ordinary discrete path, so
// both come for free — which is worth pinning, because "for free" is exactly
// what a later refactor removes without noticing.
test("an LCD module gets a discrete build step and a colour-split BOM line", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1
  doc.addComponent({
    kind: "discrete",
    ref: "lcd16x2",
    board: "bb1",
    anchor: "j1",
    params: { color: "blue" },
  });
  doc.addComponent({
    kind: "discrete",
    ref: "lcd20x4",
    board: "bb1",
    anchor: "a1",
    params: { color: "green" },
  });
  const json = doc.toJSON();
  const { bom, steps } = buildPlan(json, buildNetlist(json));

  assert.equal(findLine(bom.discretes, "lcd16x2:blue").count, 1);
  assert.match(findLine(bom.discretes, "lcd16x2:blue").title, /16×2.*\(blue\)/);
  assert.equal(findLine(bom.discretes, "lcd20x4:green").count, 1);

  const seated = steps.filter((s) => s.group === "discretes");
  assert.equal(seated.length, 2, "one placement step per module");
  assert.match(seated[0].text, /bb1\.j1/);
});

test("the wires are a NUMBERED cutting list: one line per colour AND length", () => {
  const { bom } = plan();

  // Colour and CUT length together, in the app's own colour order then shortest
  // first — the same order the swatch pickers offer, so a row only moves when
  // the desk changes. The item numbers follow that order, 1..n.
  assert.deepEqual(
    bom.wires.map((l) => [l.item, l.title]),
    [
      [1, "Jumper wire (red, 11.9 cm)"],
      [2, "Jumper wire (black, 11.6 cm)"],
      [3, "Jumper wire (blue, 4.8 cm)"],
      [4, "Jumper wire (green, 12.5 cm)"],
      [5, "Jumper wire (yellow, 1.9 cm)"],
    ],
  );

  // The fixture's two bus members span the same three columns, so they are the
  // same lead twice — one line, ×2, ONE number. That is the whole point of a
  // cutting list: cut two, label both [5].
  assert.deepEqual(findLine(bom.wires, "yellow:19"), {
    key: "yellow:19",
    title: "Jumper wire (yellow, 1.9 cm)",
    count: 2,
    item: 5,
  });
  // The KEY carries the stored colour token and whole millimetres, never a
  // translated word: a language change must not split or merge a BOM row, and
  // two wires that DISPLAY the same length have to land on the same line.
  assert.deepEqual(
    bom.wires.map((l) => l.key),
    ["red:119", "black:116", "blue:48", "green:125", "yellow:19"],
  );
});

test("a wire's BOM length is the same number its own drawing dimensions", () => {
  // One measurement in the app (model/wire-length.js): the Properties dialog's
  // dimension line and this row cannot disagree.
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const wire = doc.addWire({ from: "bb1.a1", to: "bb1.a2", color: "blue" });
  const json = doc.toJSON();
  const { bom } = buildPlan(json, buildNetlist(json));

  assert.equal(
    wireLengthLabel(wireCutMm(json, wire.id)),
    "1.3 cm",
    "one hole apart: 2.54 mm of run plus 5 mm of strip at each end",
  );
  assert.deepEqual(bom.wires, [
    { key: "blue:13", title: "Jumper wire (blue, 1.3 cm)", count: 1, item: 1 },
  ]);
});

test("every wire step calls out the BOM item number of the wire it runs", () => {
  const { bom, steps } = plan();
  const itemOf = new Map(bom.wires.map((l) => [l.key, l.item]));

  // A power wire is one wire, so its callout sits in the step's own sentence.
  const red = steps.find((s) => s.id === "step:power:w1");
  assert.equal(
    red.text,
    `Run a red wire [${itemOf.get("red:119")}]: Power supply + → + rail (bb1).`,
  );

  // A bus or net step is several wires, so each callout LEADS its own run line.
  const bus = steps.find((s) => s.group === "wires" && s.detail?.length === 2);
  const yellow = itemOf.get("yellow:19");
  assert.ok(
    bus.detail.every((d) => d.startsWith(`[${yellow}] `)),
    `both members are item ${yellow}: ${JSON.stringify(bus.detail)}`,
  );

  // Nothing that is not a wire quotes a number.
  for (const step of steps.filter((s) => s.group === "chips")) {
    assert.doesNotMatch(step.text, /\[\d+\]/, step.text);
  }
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
  assert.deepEqual(p.bom, {
    boards: [],
    chips: [],
    discretes: [],
    power: [],
    wires: [],
  });
  assert.deepEqual(p.nets, []);
  assert.deepEqual(p.steps, []);
  assert.deepEqual(p.warnings, []);
});

// A typed value is part of what you buy: two capacitors of one value are one
// line, two values are two, and a resistor says its value the same way.
test("BOM splits resistors and capacitors by their typed value", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0);
  const seat = (ref, anchor, params) =>
    doc.addComponent({ kind: "discrete", ref, board: "bb2", anchor, params });
  seat("cap-ceramic", "a5", { farads: 100e-9 });
  seat("cap-ceramic", "a10", { farads: 100e-9 });
  seat("cap-ceramic", "a15", { farads: 10e-9 });
  seat("cap-electrolytic", "a20", { farads: 4.7e-6 });
  seat("resistor", "a30", { ohms: 4700 });
  const json = doc.toJSON();
  const { bom } = buildPlan(json, buildNetlist(json));
  assert.deepEqual(
    bom.discretes.map((l) => [l.title, l.count]),
    [
      ["Capacitor (ceramic) — 100nF", 2],
      ["Capacitor (ceramic) — 10nF", 1],
      ["Capacitor (electrolytic) — 4.7µF", 1],
      ["Resistor — 4.7kΩ", 1],
    ].sort(),
  );
});

test("a designed chip is named by its part number, never its internal id", () => {
  const chip = { ...newCustomChip([]), name: "MYCHIP" };
  setCustomChips([chip]);
  try {
    const doc = new DeskDoc(null);
    doc.addBoard("pins-full", 0, 0);
    doc.addComponent({
      kind: "chip",
      ref: chip.id,
      board: "bb1",
      anchor: "e5",
    });
    const json = doc.toJSON();
    const { steps, warnings } = buildPlan(json, buildNetlist(json));
    const seat = steps.find((s) => s.group === "chips");
    assert.match(seat.text, /MYCHIP/);
    assert.doesNotMatch(seat.text, /custom-/);
    const unpowered = warnings.find((w) => w.kind === "unpowered-chip");
    assert.match(unpowered.message, /^MYCHIP/);
  } finally {
    setCustomChips([]);
  }
});

test("an electronic load is a BOM line and a set-up step, like the other bricks", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addBrick("load", 80, 0, { mode: "cr", ohms: 47 });
  const json = doc.toJSON();
  const { bom, steps } = buildPlan(json, buildNetlist(json));
  const lines = Object.values(bom).flat().filter((l) => l && typeof l === "object" && "title" in l); // prettier-ignore
  assert.ok(lines.some((l) => /Electronic load \(CR 47/.test(l.title)), JSON.stringify(lines.map((l) => l.title))); // prettier-ignore
  assert.ok(steps.some((s) => s.group === "power" && /Electronic load \(CR 47/.test(s.text))); // prettier-ignore
});

test("the AC bricks are BOM lines stating every figure set: two adapters a volt apart, or transformers a henry apart, are two", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addBrick("adapter", 80, 0, { hz: 60, rms: 13.5 });
  doc.addBrick("adapter", 100, 0, { hz: 60, rms: 12.5 });
  doc.addBrick("ac", 120, 0, { hz: 50, rms: 230 });
  doc.addBrick("transformer", 80, 20, { turns: 10, primaryHenries: 7, primaryOhms: 40, secondaryOhms: 0.6, coupling: 0.99 }); // prettier-ignore
  doc.addBrick("transformer", 100, 20, { turns: 10, primaryHenries: 5, primaryOhms: 40, secondaryOhms: 0.6, coupling: 0.99 }); // prettier-ignore
  const json = doc.toJSON();
  const { bom, steps } = buildPlan(json, buildNetlist(json));
  const titles = Object.values(bom).flat().filter((l) => l && typeof l === "object" && "title" in l).map((l) => l.title); // prettier-ignore
  const adapters = titles.filter((t) => /^AC adapter/.test(t));
  assert.deepEqual(adapters.length, 2, JSON.stringify(titles));
  assert.ok(adapters.some((t) => t.includes("13.5 V~, 60 Hz")), JSON.stringify(adapters)); // prettier-ignore
  assert.ok(steps.some((s) => s.group === "power" && s.text.includes("12.5 V~"))); // prettier-ignore
  assert.ok(titles.some((t) => t.includes("230 V~, 50 Hz")), JSON.stringify(titles)); // prettier-ignore
  const xfmr = titles.filter((t) => /10:1/.test(t));
  assert.equal(xfmr.length, 2, JSON.stringify(titles));
  assert.ok(xfmr.some((t) => t.includes("10:1, 7H, 40Ω/0.6Ω, k 0.99")), JSON.stringify(xfmr)); // prettier-ignore
});

// ── The 2026-10-14 review ───────────────────────────────────────────────────

/** A plan for a desk built by `build(doc)` on a bare full kit. */
function planOf(build) {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1 rail · bb2 pins · bb3 rail
  build(doc);
  const json = doc.toJSON();
  return buildPlan(json, buildNetlist(json));
}
const allLines = (bom) => Object.values(bom).flat();

test("a part turned end for end names the hole its pin 1 is really in", () => {
  const { steps } = planOf((doc) => {
    doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb2", anchor: "e5", params: { rot: 180 } }); // prettier-ignore
    doc.addComponent({ kind: "discrete", ref: "seg7cc", board: "bb2", anchor: "e40", params: { rot: 180 } }); // prettier-ignore
  });
  const text = steps.map((s) => s.text).join("\n");
  assert.match(
    text,
    /74LS00 straddling e5–f11, pin 1 at bb2\.f11 \(flipped 180°\)/,
  );
  assert.match(text, /pin 1 at bb2\.i44 \(flipped 180°\)/);
});

test("every named lead is named in its placement step, a flipped LED's the right way round", () => {
  const { steps } = planOf((doc) => {
    doc.addComponent({ kind: "discrete", ref: "led", board: "bb2", anchor: "a10", params: { color: "red", flip: true } }); // prettier-ignore
    doc.addComponent({ kind: "discrete", ref: "speaker", board: "bb2", anchor: "a30" }); // prettier-ignore
    doc.addComponent({ kind: "discrete", ref: "resistor", board: "bb2", anchor: "a50", params: { ohms: 330 } }); // prettier-ignore
  });
  const text = steps.map((s) => s.text).join("\n");
  assert.match(text, /LED \(red\) with leads at K bb2\.a10, A bb2\.a11/);
  assert.match(text, /Speaker \(8Ω\) with leads at \+ bb2\.a30, - bb2\.a33/);
  // A resistor's leads have no names to give, and its value says which one.
  assert.match(text, /Resistor \(330Ω\) with leads at bb2\.a50, bb2\.a53/);
});

test("the BOM splits what is bought differently: a relay's coil, a speaker's ohms, a can's rate, a supply's limit, a clock's wave", () => {
  const { bom } = planOf((doc) => {
    doc.addComponent({ kind: "discrete", ref: "relay", board: "bb2", anchor: "a5" }); // prettier-ignore
    doc.addComponent({ kind: "discrete", ref: "relay", board: "bb2", anchor: "a20", params: { coilVolts: 12 } }); // prettier-ignore
    doc.addComponent({ kind: "discrete", ref: "speaker", board: "bb2", anchor: "a35" }); // prettier-ignore
    doc.addComponent({ kind: "discrete", ref: "speaker", board: "bb2", anchor: "a45", params: { impedance: 32 } }); // prettier-ignore
    doc.addComponent({ kind: "discrete", ref: "osc-half", board: "bb2", anchor: "a55", params: { hz: 1 } }); // prettier-ignore
    doc.addComponent({ kind: "discrete", ref: "osc-half", board: "bb2", anchor: "f55", params: { hz: 1000 } }); // prettier-ignore
    doc.addPsu(0, 40, { volts: 5 });
    doc.addPsu(20, 40, { volts: 5, currentLimit: 0.1 });
    doc.addBrick("clock", 40, 40, { hz: 10 });
    doc.addBrick("clock", 60, 40, { hz: 10, wave: "pwm", duty: 20 });
  });
  const titles = allLines(bom).map((l) => `${l.title} ×${l.count}`);
  for (const want of [
    "Relay (SPDT) — 5V ×1",
    "Relay (SPDT) — 12V ×1",
    "Speaker — 8Ω ×1",
    "Speaker — 32Ω ×1",
    "Oscillator (half can) — 1 Hz ×1",
    "Oscillator (half can) — 1 kHz ×1",
    "Power supply (5 V) ×1",
    "Power supply (5 V, 100 mA) ×1",
    "Clock source (10 Hz) ×1",
    "Clock source (10 Hz, PWM 20%) ×1",
  ]) {
    assert.ok(titles.includes(want), `${want} in ${JSON.stringify(titles)}`);
  }
});

test("a chip's BOM line says its part number: two NANDs of two families are two lines", () => {
  const { bom } = planOf((doc) => {
    doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb2", anchor: "e5" }); // prettier-ignore
    doc.addComponent({ kind: "chip", ref: "CD4011B", board: "bb2", anchor: "e20" }); // prettier-ignore
  });
  assert.deepEqual(bom.chips.map((l) => l.title).sort(), [
    "74LS00 — Quad 2-input NAND",
    "CD4011B — Quad 2-input NAND",
  ]);
});

test("a wire to a planted signal flag is no forgotten connection", () => {
  const { warnings } = planOf((doc) => {
    doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb2", anchor: "e5" }); // prettier-ignore
    const sig = doc.addSignal({ type: "toggle", rest: "low" });
    doc.plantSignalFlag(sig.id, "bb2.c30");
    doc.addWire({ from: "bb2.a5", to: "bb2.a30", color: "blue" });
  });
  assert.deepEqual(
    warnings.filter((w) => w.kind === "single-member-net"),
    [],
  );
});

test("a discrete with a package is named by its title, never its catalog id", () => {
  const { steps } = planOf((doc) => {
    doc.addComponent({ kind: "discrete", ref: "seg7cc", board: "bb2", anchor: "e10" }); // prettier-ignore
    doc.addComponent({ kind: "discrete", ref: "sw-dip4", board: "bb2", anchor: "e30" }); // prettier-ignore
    doc.addWire({ from: "bb2.c10", to: "bb2.c30", color: "blue" });
  });
  const detail = steps.flatMap((s) => s.detail ?? []).join("\n");
  assert.match(detail, /7-segment display \(common cathode\) pin 1 \(e\)/);
  assert.doesNotMatch(detail, /seg7cc|sw-dip4/);
});
