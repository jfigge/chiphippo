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

// The discretes (catalog/discretes.js): diodes, inductors and
// transistors, and the capacitors that moved in beside them — what each does
// in a LOGIC simulator, through the whole engine.
//
//   · an inductor is a WIRE: its two leads are one net, both ways;
//   · a diode is ONE-WAY: a HIGH on the anode passes on at the strength it
//     arrived with, a LOW or undriven anode drives nothing, nothing passes
//     back — so two diodes and a pull-down are an OR; a Zener is the same;
//   · a transistor is a SWITCH (the analog-switch channel): NPN / N-channel
//     on while the control is HIGH, PNP / P-channel while it is LOW; a BJT
//     with a floating or undefined base is off, a MOSFET HOLDS its last
//     defined state — off until the first;
//   · a pin whose only company is one of them is CONNECTED, conducting or not.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, Z, X } from "../sim/levels.js";
import { settle } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { junctionState, isLit } from "../sim/junction.js";
import { PALETTE_DEFS, footprintOffsets, partDef } from "../catalog/index.js";
import {
  MOSFET_CASES,
  PART_NUMBER_FIELD,
  partNumberOf,
  transistorCase,
} from "../catalog/discretes.js";
import { floatsUnknown } from "../catalog/families.js";
import { symbolFor } from "../catalog/symbols.js";
import { BUILDABLE_DEFS } from "../ai/catalog-brief.js";
import { formatHenries } from "../model/henry-format.js";
import { formatVolts } from "../model/volt-format.js";
import { VALUE_RANGES, parseComponentValue } from "../model/component-value.js";
import { buildPlan } from "../model/build-plan.js";
import { reviewDesk } from "../model/desk-review.js";
import { exportDigital } from "../model/export/digital.js";
import { partPinHoles } from "../model/occupancy.js";
import { partSeatAt } from "../model/seating.js";
import { DeskDoc } from "../model/desk-doc.js";
import { ghostOrient } from "../components/desk-placement.js";
import { bench, runner } from "./timing-fixtures.js";

const SHELF = ["cap-ceramic", "cap-electrolytic", "diode", "zener", "inductor", "npn", "pnp", "nmos", "pmos"]; // prettier-ignore
const TRANSISTORS = ["npn", "pnp", "nmos", "pmos"];

/** Settle a document once, with signal levels; read a hole's level. */
function settleDoc(doc, signals = {}) {
  const netlist = buildNetlist(doc);
  const result = settle({
    document: doc,
    netlist,
    signalLevels: new Map(Object.entries(signals)),
  });
  const net = (hole) => netlist.netOfPoint.get(`bb1.${hole}`);
  return {
    result,
    netlist,
    net,
    level: (hole) => result.netLevels.get(net(hole)),
    strong: (hole) => result.strongLevels.get(net(hole)),
    warnings: (type) => result.warnings.filter((w) => w.type === type),
  };
}

// ── The catalog ─────────────────────────────────────────────────────────────

test("the discretes: every part counts as a connection and carries a Part number", () => {
  for (const id of SHELF) {
    const def = partDef(id);
    assert.ok(def, id);
    assert.equal(def.countsAsConnection, true, id);
    // The shared text field — or, on a transistor, a combo of its type's
    // common parts under the same key.
    const field = def.properties.find((f) => f.key === "partNumber");
    assert.ok(
      def.transistor ? field?.type === "combo" : field === PART_NUMBER_FIELD,
      `${id}: part number`,
    );
    assert.ok(
      ["Capacitors", "Diodes", "Inductors", "Transistors"].includes(def.group),
      `${id}: ${def.group}`,
    );
  }
  // …and nothing else claims to.
  const claimed = PALETTE_DEFS.filter((d) => d.countsAsConnection).map(
    (d) => d.id,
  );
  assert.deepEqual(claimed.sort(), [...SHELF].sort());
});

test("a part number is trimmed, capped, and stored only when there is one", () => {
  const def = partDef("diode");
  assert.equal(def.normalizeParams({ partNumber: " 1N4148 " }).partNumber, "1N4148"); // prettier-ignore
  for (const blank of [undefined, "", "   ", 42, null]) {
    assert.ok(
      !("partNumber" in def.normalizeParams({ partNumber: blank })),
      JSON.stringify(blank),
    );
  }
  assert.equal(partNumberOf({ partNumber: "x".repeat(80) }).length, 32);
  // A part that never had one round-trips to the shape it always had — the
  // capacitors' included.
  assert.deepEqual(partDef("cap-ceramic").normalizeParams({}), {
    farads: 100e-9,
    rot: 0,
    end: null,
  });
  assert.deepEqual(partDef("npn").normalizeParams({}), {});
  assert.deepEqual(partDef("npn").normalizeParams({ rot: 180, partNumber: "2N3904" }), { rot: 180, partNumber: "2N3904" }); // prettier-ignore
});

test("transistors and diodes keep out of the AI builder; the review sees them", () => {
  for (const id of SHELF) {
    assert.ok(!BUILDABLE_DEFS.some((d) => d.id === id), id);
  }
});

test("a MOSFET is a TO-220 by default and a TO-92 on request; a BJT is a TO-92", () => {
  assert.deepEqual(MOSFET_CASES, ["TO-220", "TO-92"]);
  for (const ref of ["nmos", "pmos"]) {
    const def = partDef(ref);
    assert.deepEqual(
      def.properties.map((f) => f.key),
      ["ref", "case", "partNumber"],
    );
    const field = def.properties[1];
    assert.equal(field.type, "segmented");
    assert.deepEqual(
      field.options.map((o) => o.value),
      MOSFET_CASES,
    );
    assert.deepEqual(def.normalizeParams({}), { case: "TO-220" });
    assert.deepEqual(def.normalizeParams({ case: "TO-92", rot: 180 }), {
      rot: 180,
      case: "TO-92",
    });
    assert.equal(def.normalizeParams({ case: "TO-3" }).case, "TO-220");
    assert.equal(transistorCase(def, {}), "TO-220");
    assert.equal(transistorCase(def, { case: "TO-92" }), "TO-92");
    // The same three holes either way: the package is a drawing.
    assert.deepEqual(
      partPinHoles(ref, "a10", { case: "TO-92" }),
      partPinHoles(ref, "a10", { case: "TO-220" }),
    );
  }
  for (const ref of ["npn", "pnp"]) {
    const def = partDef(ref);
    assert.deepEqual(
      def.properties.map((f) => f.key),
      ["ref", "partNumber"],
    );
    assert.deepEqual(def.normalizeParams({ case: "TO-220" }), {});
    assert.equal(transistorCase(def, { case: "TO-220" }), "TO-92");
  }
});

test("a transistor's base or gate reads a floating pin as UNDEFINED", () => {
  for (const id of TRANSISTORS) assert.equal(floatsUnknown(partDef(id)), true);
  // …which a family-less part otherwise never does (a Z80's bus reads $FF).
  assert.equal(floatsUnknown(partDef("Z80A")), false);
});

test("every new part has a schematic symbol of its own shape", () => {
  for (const [id, shape] of Object.entries({
    diode: "diode",
    zener: "zener",
    inductor: "inductor",
    npn: "npn",
    pnp: "pnp",
    nmos: "nmos",
    pmos: "pmos",
  })) {
    const sym = symbolFor(id);
    assert.equal(sym.kind, "shape", id);
    assert.equal(sym.shape, shape, id);
  }
  // A transistor's three terminals are its three pins, the control on the left.
  const npn = symbolFor("npn");
  assert.deepEqual(
    npn.terminals.map((t) => [t.name, t.side, t.pin]),
    [
      ["B", "left", 2],
      ["C", "top", 3],
      ["E", "bottom", 1],
    ],
  );
});

// ── Values ──────────────────────────────────────────────────────────────────

test("every inductance form a bench writes reads as henries", () => {
  const henries = (text) =>
    parseComponentValue(text, "henry", VALUE_RANGES.inductor).value;
  const forms = {
    "10µH": 10e-6,
    "10uH": 10e-6,
    "4.7u": 4.7e-6,
    "4u7": 4.7e-6,
    "100mH": 0.1,
    "1H": 1,
    "100n": 100e-9,
    "10 μH": 10e-6,
    "2m2": 2.2e-3,
    "1 millihenry": 1e-3,
  };
  for (const [text, value] of Object.entries(forms)) {
    assert.equal(henries(text), value, text);
  }
  // Out of 1 nH–10 H, a wrong unit, or no inductance at all: refused.
  for (const text of [
    "",
    "abc",
    "11", // a plain number is henries: past 10 H
    "1MH",
    "-1u",
    "0u",
    "20H",
    "0.1n",
    "4u7u",
    "10uF",
  ]) {
    assert.equal(henries(text), undefined, JSON.stringify(text));
  }
});

test("an inductance prints on the desk at three figures", () => {
  assert.equal(formatHenries(10e-6), "10µ");
  assert.equal(formatHenries(0.1), "100m");
});

test("an inductor's value is OPTIONAL: blank places a bare inductor", () => {
  const def = partDef("inductor");
  assert.deepEqual(def.normalizeParams({}), {
    style: "coil",
    bodyHoles: 2,
    rot: 0,
    end: null,
  });
  assert.equal(def.normalizeParams({ henries: 1e-5 }).henries, 1e-5);
  // Kept out of range (its card says so); read from text; dropped when there
  // is nothing there.
  assert.equal(def.normalizeParams({ henries: 1e6 }).henries, 1e6);
  assert.equal(def.normalizeParams({ henries: "10u" }).henries, 1e-5);
  for (const bad of [null, "", -1, 0]) {
    assert.ok(!("henries" in def.normalizeParams({ henries: bad })), bad);
  }
  const field = def.properties.find((f) => f.key === "henries");
  assert.equal(field.type, "combo");
  assert.equal(field.optional, true);
  assert.equal(field.show({ henries: 1e-5 }).text, "10µH");
});

test("a Zener voltage reads every way a bench writes it", () => {
  const volts = (text) =>
    parseComponentValue(text, "volt", VALUE_RANGES.zener).value;
  const forms = { "5.1V": 5.1, "5V1": 5.1, "3.3": 3.3, "3V3": 3.3, "12": 12, "5.1 v": 5.1 }; // prettier-ignore
  for (const [text, value] of Object.entries(forms)) {
    assert.equal(volts(text), value, text);
  }
  for (const text of ["", "abc", "1.5", "201", "-5", "5V1V1", "V"]) {
    assert.equal(volts(text), undefined, JSON.stringify(text));
  }
  assert.equal(formatVolts(5.1), "5.1");
  const def = partDef("zener");
  const field = def.properties.find((f) => f.key === "zenerVolts");
  assert.equal(field.optional, true);
  assert.equal(def.normalizeParams({ zenerVolts: 5.1 }).zenerVolts, 5.1);
  assert.ok(!("zenerVolts" in def.normalizeParams({ zenerVolts: 0 })));
  // A plain diode has no voltage to keep.
  assert.ok(!("zenerVolts" in partDef("diode").normalizeParams({ zenerVolts: 5.1 }))); // prettier-ignore
});

// ── The inductor: a wire ────────────────────────────────────────────────────

test("an inductor joins the nets on its leads, and passes H and L both ways", () => {
  const b = bench();
  const l = b.seat("l1", "inductor", "a10", { henries: 1e-5 });
  b.signal("s1", l.get(1));
  const { net, level } = settleDoc(b.doc, { s1: H });
  assert.equal(net(l.get(1)), net(l.get(2)), "one net");
  assert.equal(level(l.get(2)), H);
  assert.equal(settleDoc(b.doc, { s1: L }).level(l.get(2)), L);
  // The other way round.
  const b2 = bench();
  const l2 = b2.seat("l1", "inductor", "a10");
  b2.signal("s1", l2.get(2));
  assert.equal(settleDoc(b2.doc, { s1: H }).level(l2.get(1)), H);
  assert.equal(settleDoc(b2.doc, { s1: L }).level(l2.get(1)), L);
});

test("an inductor across the rails is a short, as a wire is", () => {
  const b = bench();
  const l = b.seat("l1", "inductor", "a10");
  b.vcc(l.get(1));
  b.gnd(l.get(2));
  assert.equal(settleDoc(b.doc).warnings("short").length, 1);
});

// ── The inductor's look and size ────────────────────────────────────────────

test("an inductor is a coil over two holes by default; its style and size are Properties", () => {
  const def = partDef("inductor");
  const keys = def.properties.map((f) => f.key);
  assert.deepEqual(keys, ["henries", "style", "bodyHoles", "partNumber"]);
  const style = def.properties.find((f) => f.key === "style");
  const holes = def.properties.find((f) => f.key === "bodyHoles");
  assert.equal(style.type, "segmented");
  assert.deepEqual(
    style.options.map((o) => o.value),
    ["coil", "can"],
  );
  assert.equal(holes.type, "segmented");
  assert.deepEqual(
    holes.options.map((o) => o.value),
    [2, 3],
  );
  // It can move a pin, so it is a topology edit with a reason to refuse.
  assert.equal(holes.movesPins, true);
  assert.ok(holes.refused);
  assert.equal(def.normalizeParams({ style: "can" }).style, "can");
  assert.equal(def.normalizeParams({ style: "toroid" }).style, "coil");
  assert.equal(def.normalizeParams({ bodyHoles: 3 }).bodyHoles, 3);
  for (const bad of [4, "3", 1, null]) {
    assert.equal(def.normalizeParams({ bodyHoles: bad }).bodyHoles, 2, bad);
  }
});

test("three holes between its leads puts pin 2 one hole further, everywhere", () => {
  const def = partDef("inductor");
  assert.deepEqual([...footprintOffsets(def, {})], [0, 3]);
  assert.deepEqual([...footprintOffsets(def, { bodyHoles: 3 })], [0, 4]);
  // A part with no size of its own answers its footprint.
  assert.deepEqual([...footprintOffsets(partDef("diode"), { bodyHoles: 3 })], [0, 3]); // prettier-ignore
  const holes = (params) =>
    partPinHoles("inductor", "a10", params).map((p) => p.hole);
  assert.deepEqual(holes({}), ["a10", "a13"]);
  assert.deepEqual(holes({ bodyHoles: 3 }), ["a10", "a14"]);
  // The seat search keeps the longer part on the board: on a 63-column
  // strip the last anchor is 60 for three holes along, 59 for four.
  const boards = [{ id: "bb1", type: "pins-full", x: 0, y: 0 }];
  const far = { x: 63, y: 12.51 }; // over a63
  assert.equal(partSeatAt(boards, "inductor", far, 0, {})?.anchor, "a60");
  assert.equal(
    partSeatAt(boards, "inductor", far, 0, { bodyHoles: 3 })?.anchor,
    "a59",
  );
  // The ghost turned with R reaches as far as the leads do.
  assert.deepEqual(ghostOrient("inductor", 1, { bodyHoles: 3 }), { dx: 0, dy: 4 }); // prettier-ignore
  assert.deepEqual(ghostOrient("inductor", 1), { dx: 0, dy: 3 });
  // And the engine joins the holes it now sits in.
  const b = bench();
  const l = b.seat("l1", "inductor", "a10", { bodyHoles: 3 });
  assert.equal(l.get(2), "a14");
  b.signal("s1", l.get(1));
  assert.equal(settleDoc(b.doc, { s1: H }).level(l.get(2)), H);
});

test("a size change that moves a lead is asked about first, and only then", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const l = doc.addComponent({
    kind: "discrete",
    ref: "inductor",
    board: "bb1",
    anchor: "a10",
  });
  assert.equal(doc.canSetComponentParams(l.id, { bodyHoles: 3 }), true);
  // Something in the hole pin 2 would move to: refused…
  doc.addComponent({ kind: "discrete", ref: "led", board: "bb1", anchor: "a14" }); // prettier-ignore
  assert.equal(doc.canSetComponentParams(l.id, { bodyHoles: 3 }), false);
  // …while a change that moves nothing is not, whatever is next to it.
  assert.equal(doc.canSetComponentParams(l.id, { style: "can" }), true);
  assert.equal(doc.canSetComponentParams(l.id, { bodyHoles: 2 }), true);
  // Off the end of the board, refused too.
  const end = doc.addComponent({
    kind: "discrete",
    ref: "inductor",
    board: "bb1",
    anchor: "j60",
  });
  assert.equal(doc.canSetComponentParams(end.id, { bodyHoles: 3 }), false);
  // Stood up on two free ends, the size is the body's alone: no lead moves.
  const up = doc.addComponent({
    kind: "discrete",
    ref: "inductor",
    board: "bb1",
    anchor: "j20",
    params: { rot: 90, end: { dx: 0, dy: 3 } },
  });
  doc.addComponent({ kind: "discrete", ref: "led", board: "bb1", anchor: "j24" }); // prettier-ignore
  assert.equal(doc.canSetComponentParams(up.id, { bodyHoles: 3 }), true);
});

// ── Diodes: one way ─────────────────────────────────────────────────────────

for (const ref of ["diode", "zener"]) {
  test(`${ref}: a HIGH anode passes to the cathode; LOW or undriven passes nothing`, () => {
    const b = bench();
    const d = b.seat("d1", ref, "a10");
    b.signal("s1", d.get(1));
    assert.equal(settleDoc(b.doc, { s1: H }).level(d.get(2)), H);
    assert.equal(
      settleDoc(b.doc, { s1: L }).level(d.get(2)),
      Z,
      "LOW: nothing",
    );
    assert.equal(settleDoc(b.doc).level(d.get(2)), Z, "undriven: nothing");
  });

  test(`${ref}: reversed, it passes nothing back`, () => {
    const b = bench();
    const d = b.seat("d1", ref, "a10");
    b.signal("s1", d.get(2)); // drive the CATHODE
    assert.equal(settleDoc(b.doc, { s1: H }).level(d.get(1)), Z);
    assert.equal(settleDoc(b.doc, { s1: L }).level(d.get(1)), Z);
  });

  test(`${ref}: it never drives its cathode LOW — a pull-up there holds`, () => {
    const b = bench();
    const d = b.seat("d1", ref, "a10");
    const r = b.seat("r1", "resistor", "a20");
    b.link(r.get(1), d.get(2));
    b.vcc(r.get(2));
    b.signal("s1", d.get(1));
    const { level, warnings } = settleDoc(b.doc, { s1: L });
    assert.equal(level(d.get(2)), H, "the pull-up wins, untouched");
    assert.deepEqual(warnings("conflict"), []);
  });
}

test("two diodes and a pull-down are an OR", () => {
  const b = bench();
  const d1 = b.seat("d1", "diode", "a10");
  const d2 = b.seat("d2", "diode", "a20");
  const r = b.seat("r1", "resistor", "a30");
  b.link(d1.get(2), d2.get(2));
  b.link(d1.get(2), r.get(1));
  b.gnd(r.get(2));
  b.signal("a", d1.get(1));
  b.signal("b", d2.get(1));
  for (const [a, bb, want] of [
    [L, L, L],
    [H, L, H],
    [L, H, H],
    [H, H, H],
  ]) {
    const { level, warnings } = settleDoc(b.doc, { a, b: bb });
    assert.equal(level(d1.get(2)), want, `${a} OR ${bb}`);
    assert.deepEqual(warnings("conflict"), [], "two HIGHs agree");
  }
  // An unknown input that cannot change the answer does not spoil it.
  assert.equal(settleDoc(b.doc, { a: X, b: H }).level(d1.get(2)), H);
  assert.equal(settleDoc(b.doc, { a: X, b: L }).level(d1.get(2)), X);
});

test("a diode passes a HIGH at the strength it arrived with", () => {
  // Anode PULLED high through a resistor: the cathode is only pulled too, so
  // an output driving it LOW wins without a fight.
  const b = bench();
  const r = b.seat("r1", "resistor", "a10");
  const d = b.seat("d1", "diode", "a20");
  b.vcc(r.get(1));
  b.link(r.get(2), d.get(1));
  const weak = settleDoc(b.doc);
  assert.equal(weak.level(d.get(2)), H, "pulled high through the diode");
  assert.equal(weak.strong(d.get(2)), Z, "…but not driven");
  b.signal("s1", d.get(2));
  const fought = settleDoc(b.doc, { s1: L });
  assert.equal(fought.level(d.get(2)), L);
  assert.deepEqual(fought.warnings("conflict"), []);

  // Anode DRIVEN high: the cathode is driven, so an output LOW there fights.
  const b2 = bench();
  const d2 = b2.seat("d1", "diode", "a20");
  b2.signal("a", d2.get(1));
  b2.signal("k", d2.get(2));
  const both = settleDoc(b2.doc, { a: H, k: L });
  assert.equal(both.level(d2.get(2)), X);
  assert.equal(both.warnings("conflict").length, 1);
});

test("a ring of diodes with nothing driving it holds nothing up", () => {
  const b = bench();
  const d1 = b.seat("d1", "diode", "a10");
  const d2 = b.seat("d2", "diode", "a20");
  b.link(d1.get(2), d2.get(1));
  b.link(d2.get(2), d1.get(1));
  const run = runner(b.doc);
  // Driven once, then let go: the ring must not latch the HIGH.
  b.signal("s1", d1.get(1));
  run.rebuild();
  assert.equal(run.run(0, new Map([["s1", H]])).level(d1.get(2)), H);
  assert.equal(run.run(0.1, new Map()).level(d1.get(2)), Z);
  assert.equal(run.level(d1.get(1)), Z);
});

test("a diode forward across the rails burns, as an LED does", () => {
  const b = bench();
  const d = b.seat("d1", "diode", "a10");
  b.vcc(d.get(1));
  b.gnd(d.get(2));
  const { level, strong } = settleDoc(b.doc);
  const state = junctionState({
    anode: level(d.get(1)),
    cathode: level(d.get(2)),
    anodeStrong: strong(d.get(1)),
    cathodeStrong: strong(d.get(2)),
  });
  assert.equal(state.unlimited, true);
  const review = reviewDesk(b.doc, buildNetlist(b.doc));
  assert.ok(review.findings.some((f) => f.code === "DIODE_UNLIMITED"));
  // Reversed across them it is just reverse-biased: nothing to say.
  const b2 = bench();
  const d2 = b2.seat("d1", "diode", "a10");
  b2.gnd(d2.get(1));
  b2.vcc(d2.get(2));
  const quiet = reviewDesk(b2.doc, buildNetlist(b2.doc));
  assert.ok(!quiet.findings.some((f) => f.code === "DIODE_UNLIMITED"));
});

test("a diode into a rail adds nothing that travels on through a transistor", () => {
  // A diode forward into ground (burning, and said so) must not make the
  // ground rail look fought-over to a net a transistor joins to it.
  const b = bench();
  const d = b.seat("d1", "diode", "a10");
  b.vcc(d.get(1));
  b.gnd(d.get(2));
  const q = b.seat("q1", "nmos", "a20");
  const r = b.seat("r1", "resistor", "a30");
  b.gnd(q.get(1));
  b.link(q.get(3), r.get(1));
  b.vcc(r.get(2));
  b.vcc(q.get(2));
  const { level, warnings } = settleDoc(b.doc);
  assert.equal(level(q.get(3)), L, "the drain reads the rail it is joined to");
  assert.deepEqual(warnings("conflict"), []);
});

// ── Transistors: switches ───────────────────────────────────────────────────

/**
 * A transistor as a low- or high-side switch: emitter/source on `rail`, the
 * other switched pin pulled to the OPPOSITE rail through a resistor, and the
 * base/gate on a signal. The switched pin reads the rail while it conducts.
 */
function switchBench(ref, rail) {
  const b = bench();
  const q = b.seat("q1", ref, "a10");
  const r = b.seat("r1", "resistor", "a20");
  (rail === "-" ? b.gnd : b.vcc)(q.get(1));
  b.link(q.get(3), r.get(1));
  (rail === "-" ? b.vcc : b.gnd)(r.get(2));
  b.signal("s1", q.get(2));
  return { b, q };
}

for (const [ref, rail, onLevel] of [
  ["npn", "-", H],
  ["nmos", "-", H],
  ["pnp", "+", L],
  ["pmos", "+", L],
]) {
  const offLevel = onLevel === H ? L : H;
  const pulled = rail === "-" ? H : L; // the switched pin when off
  const railLevel = rail === "-" ? L : H;
  test(`${ref}: on while the control is ${onLevel}, off while it is ${offLevel}`, () => {
    const { b, q } = switchBench(ref, rail);
    const on = settleDoc(b.doc, { s1: onLevel });
    assert.equal(on.level(q.get(3)), railLevel, "on: joined to the rail");
    assert.equal(on.result.channels.get("q1")[0].on, H);
    const off = settleDoc(b.doc, { s1: offLevel });
    assert.equal(off.level(q.get(3)), pulled, "off: left to its pull");
    assert.equal(off.result.channels.get("q1")[0].on, L);
    // A transistor is no chip: it has no power status to report.
    assert.equal(on.result.chipStatus.has("q1"), false);
  });
}

for (const ref of ["npn", "pnp"]) {
  test(`${ref}: a floating or undefined base is OFF, and it remembers nothing`, () => {
    const rail = ref === "npn" ? "-" : "+";
    const { b, q } = switchBench(ref, rail);
    const pulled = rail === "-" ? H : L;
    assert.equal(settleDoc(b.doc).level(q.get(3)), pulled, "floating");
    assert.equal(settleDoc(b.doc, { s1: X }).level(q.get(3)), pulled, "X");
    // Turned on, then let go: off again at once.
    const run = runner(b.doc);
    const on = ref === "npn" ? H : L;
    run.run(0, new Map([["s1", on]]));
    assert.notEqual(run.level(q.get(3)), pulled);
    run.run(0.1, new Map());
    assert.equal(run.level(q.get(3)), pulled);
    assert.equal(run.result.channels.get("q1")[0].held, false);
  });
}

for (const [ref, rail, onLevel] of [
  ["nmos", "-", H],
  ["pmos", "+", L],
]) {
  test(`${ref}: OFF before the gate is first driven, then HOLDS its last state`, () => {
    const { b, q } = switchBench(ref, rail);
    const offLevel = onLevel === H ? L : H;
    const pulled = rail === "-" ? H : L;
    const railLevel = rail === "-" ? L : H;
    const run = runner(b.doc);
    const step = (now, level) => {
      run.run(now, level ? new Map([["s1", level]]) : new Map());
      return { at: run.level(q.get(3)), ch: run.result.channels.get("q1")[0] };
    };
    let s = step(0, null);
    assert.equal(s.at, pulled, "never driven: off");
    assert.equal(s.ch.held, true, "…and that is the gate's memory talking");
    s = step(0.1, onLevel);
    assert.equal(s.at, railLevel, "driven on");
    assert.equal(s.ch.held, false);
    s = step(0.2, null);
    assert.equal(s.at, railLevel, "floated: STAYS on");
    assert.deepEqual([s.ch.on, s.ch.held], [H, true]);
    s = step(0.3, X);
    assert.equal(s.at, railLevel, "undefined: still on");
    s = step(0.4, offLevel);
    assert.equal(s.at, pulled, "driven off");
    s = step(0.5, null);
    assert.equal(s.at, pulled, "floated: STAYS off");
    assert.deepEqual([s.ch.on, s.ch.held], [L, true]);
  });
}

test("a MOSFET whose gate a floating CMOS output drives holds its last state", () => {
  // A CD4069UB inverter on the gate: input LOW → output HIGH → on; input left
  // floating → a CMOS input reads unknown → the output is X — and the gate
  // stops it there, holding the channel on.
  const b = bench();
  const u = b.seat("u1", "CD4069UB", "e40");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  b.signal("s1", u.get(1));
  const q = b.seat("q1", "nmos", "a10");
  const r = b.seat("r1", "resistor", "a20");
  b.gnd(q.get(1));
  b.link(q.get(3), r.get(1));
  b.vcc(r.get(2));
  b.link(u.get(2), q.get(2));
  const run = runner(b.doc);
  run.run(0, new Map([["s1", L]]));
  assert.equal(run.level(u.get(2)), H);
  assert.equal(run.level(q.get(3)), L, "on");
  run.run(0.1, new Map());
  assert.equal(run.level(u.get(2)), X, "the CMOS output is undefined");
  assert.equal(run.level(q.get(3)), L, "…and the MOSFET holds ON");
  assert.equal(run.result.channels.get("q1")[0].held, true);
  // The same through an NPN: its base reads X, and it is OFF.
  const b2 = bench();
  const u2 = b2.seat("u1", "CD4069UB", "e40");
  b2.vcc(u2.get(14));
  b2.gnd(u2.get(7));
  b2.signal("s1", u2.get(1));
  const q2 = b2.seat("q1", "npn", "a10");
  const r2 = b2.seat("r1", "resistor", "a20");
  b2.gnd(q2.get(1));
  b2.link(q2.get(3), r2.get(1));
  b2.vcc(r2.get(2));
  b2.link(u2.get(2), q2.get(2));
  const run2 = runner(b2.doc);
  run2.run(0, new Map([["s1", L]]));
  assert.equal(run2.level(q2.get(3)), L, "on");
  run2.run(0.1, new Map());
  assert.equal(run2.level(q2.get(3)), H, "a BJT forgets: off");
});

/**
 * An LED switched by a transistor from a chip's output: the chip an inverter
 * (a 74LS04 or a CD4069UB) fed from a signal; its output on the base or gate;
 * the LED from VCC through `limit` (a resistor, or none) into the collector or
 * drain; the emitter or source on GND.
 */
function ledDriver(chip, ref, limit = true) {
  const b = bench();
  const u = b.seat("u1", chip, "e40");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  b.signal("s1", u.get(1));
  const q = b.seat("q1", ref, "a10");
  b.link(u.get(2), q.get(2));
  b.gnd(q.get(1));
  const led = b.seat("d1", "led", "a20");
  b.link(led.get(2), q.get(3));
  if (limit) {
    const r = b.seat("r1", "resistor", "a25");
    b.vcc(r.get(1));
    b.link(r.get(2), led.get(1));
  } else {
    b.vcc(led.get(1));
  }
  return { b, led };
}

const ledState = (doc, led, signals) => {
  const { level, strong } = settleDoc(doc, signals);
  return junctionState({
    anode: level(led.get(1)),
    cathode: level(led.get(2)),
    anodeStrong: strong(led.get(1)),
    cathodeStrong: strong(led.get(2)),
  });
};

for (const chip of ["74LS04", "CD4069UB"]) {
  for (const ref of ["npn", "nmos"]) {
    test(`an LED switched by an ${ref} from a ${chip} output lights, and goes dark`, () => {
      const { b, led } = ledDriver(chip, ref);
      // Input LOW → output HIGH → the transistor is on → lit.
      assert.equal(isLit(ledState(b.doc, led, { s1: L })), true);
      // Input HIGH → output LOW → off → dark.
      assert.equal(isLit(ledState(b.doc, led, { s1: H })), false);
    });
  }
}

test("…and with no resistor in its leg, the switched-on LED burns", () => {
  const { b, led } = ledDriver("74LS04", "npn", false);
  const state = ledState(b.doc, led, { s1: L });
  assert.equal(state.unlimited, true);
  assert.equal(isLit(state), false);
});

test("a transistor switched on straight across the rails is a short through it", () => {
  const b = bench();
  const q = b.seat("q1", "npn", "a10");
  b.gnd(q.get(1));
  b.vcc(q.get(3));
  b.signal("s1", q.get(2));
  const shorts = settleDoc(b.doc, { s1: H }).warnings("short");
  assert.equal(shorts.length, 1);
  assert.equal(shorts[0].via, "transistor");
  assert.deepEqual(settleDoc(b.doc, { s1: L }).warnings("short"), []);
});

test("a transistor turned end-for-end switches the same pins", () => {
  const b = bench();
  const q = b.seat("q1", "npn", "a10", { rot: 180 });
  // Turned, pin 1 (E) sits where pin 3 did.
  assert.equal(q.get(1), "a12");
  assert.equal(q.get(3), "a10");
  const r = b.seat("r1", "resistor", "a20");
  b.gnd(q.get(1));
  b.link(q.get(3), r.get(1));
  b.vcc(r.get(2));
  b.signal("s1", q.get(2));
  assert.equal(settleDoc(b.doc, { s1: H }).level(q.get(3)), L);
  assert.equal(settleDoc(b.doc, { s1: L }).level(q.get(3)), H);
});

// ── Board validation: connected, conducting or not ──────────────────────────

/** A powered CD4069UB whose input pin 1 is fed by `feed(b, inputHole)`. */
function cmosInputVia(feed) {
  const b = bench();
  const u = b.seat("u1", "CD4069UB", "e40");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  // Every other input tied, so the only floating candidate is pin 1.
  for (const pin of [3, 5, 9, 11, 13]) b.gnd(u.get(pin));
  feed(b, u.get(1));
  return { b, u };
}

test("a CMOS input fed only through a reversed diode or an off transistor is not floating", () => {
  const floating = (doc) =>
    settleDoc(doc)
      .warnings("floating-input")
      .flatMap((w) => w.pins);
  // Control: nothing on pin 1 at all — floating, and said.
  assert.deepEqual(floating(cmosInputVia(() => {}).b.doc), [1]);
  // A reversed diode: cathode on the input, anode on GND — never conducts.
  const viaDiode = cmosInputVia((b, input) => {
    const d = b.seat("d1", "diode", "a10");
    b.link(d.get(2), input);
    b.gnd(d.get(1));
  });
  assert.deepEqual(floating(viaDiode.b.doc), []);
  // An NPN whose base is held LOW: off, its collector on the input.
  const viaNpn = cmosInputVia((b, input) => {
    const q = b.seat("q1", "npn", "a10");
    b.link(q.get(3), input);
    b.vcc(q.get(1));
    b.gnd(q.get(2));
  });
  assert.deepEqual(floating(viaNpn.b.doc), []);
  // A capacitor, as before.
  const viaCap = cmosInputVia((b, input) => {
    const c = b.seat("c1", "cap-ceramic", "a10");
    b.link(c.get(1), input);
    b.gnd(c.get(2));
  });
  assert.deepEqual(floating(viaCap.b.doc), []);
});

test("the desk review does not call a TTL input through an off transistor unconnected", () => {
  const b = bench();
  const u = b.seat("u1", "74LS04", "e40");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  const q = b.seat("q1", "pnp", "a10");
  b.link(q.get(3), u.get(1));
  b.vcc(q.get(1));
  b.vcc(q.get(2)); // a PNP with its base HIGH: off
  // The inverter's output is used, so its input counts.
  const led = b.seat("d1", "led", "a20");
  b.link(u.get(2), led.get(1));
  b.gnd(led.get(2));
  const review = reviewDesk(b.doc, buildNetlist(b.doc));
  const floating = review.findings.filter((f) => f.code === "INPUT_FLOATING");
  assert.deepEqual(floating, []);
  // The transistor is not counted as a chip, powered or not.
  assert.equal(review.stats.chips, 1);
});

// ── The BOM and the build guide ─────────────────────────────────────────────

test("the BOM tallies the shelf by value and part number", () => {
  const b = bench();
  b.seat("d1", "diode", "a10", { partNumber: "1N4148" });
  b.seat("d2", "diode", "a14", { partNumber: "1N4148" });
  b.seat("d3", "diode", "a18", { partNumber: "1N4001" });
  b.seat("z1", "zener", "a22", { zenerVolts: 5.1, partNumber: "1N4733A" });
  b.seat("l1", "inductor", "a26", { henries: 1e-5 });
  b.seat("q1", "npn", "a30", { partNumber: "2N2222" });
  b.seat("q2", "nmos", "a34");
  b.seat("q3", "nmos", "a37", { case: "TO-92", partNumber: "2N7000" });
  b.seat("c1", "cap-ceramic", "a40", { farads: 1e-7 });
  b.seat("c2", "cap-ceramic", "a44", { farads: 1e-7, partNumber: "K104" });
  const plan = buildPlan(b.doc, buildNetlist(b.doc));
  const lines = Object.fromEntries(
    plan.bom.discretes.map((l) => [l.title, l.count]),
  );
  assert.equal(lines["Diode — 1N4148"], 2);
  assert.equal(lines["Diode — 1N4001"], 1);
  assert.equal(lines["Zener diode — 5.1V, 1N4733A"], 1);
  assert.equal(lines["Inductor — 10µH"], 1);
  assert.equal(lines["NPN transistor (BJT) — 2N2222"], 1);
  // A MOSFET says its package: a TO-220 and a TO-92 are different buys.
  assert.equal(lines["N-channel MOSFET — TO-220"], 1);
  assert.equal(lines["N-channel MOSFET — TO-92, 2N7000"], 1);
  assert.equal(lines["Capacitor (ceramic) — 100nF"], 1);
  assert.equal(lines["Capacitor (ceramic) — 100nF, K104"], 1);
  // The step names which lead goes where — the whole question for a diode.
  const step = plan.steps.find((s) => s.id === "step:discretes:d1");
  assert.match(step.text, /\(1N4148\)/);
  assert.match(step.text, /A bb1\.a10, K bb1\.a13/);
  const fet = plan.steps.find((s) => s.id === "step:discretes:q3");
  assert.match(fet.text, /\(TO-92, 2N7000\)/);
});

// ── Exports ─────────────────────────────────────────────────────────────────

test("the Digital export says why each of the discretes is left out", () => {
  const b = bench();
  b.seat("d1", "diode", "a10");
  b.seat("l1", "inductor", "a20");
  b.seat("q1", "npn", "a30");
  const { report } = exportDigital(b.doc, { tabId: "t", name: "x" });
  const reason = (ref) =>
    report.find((e) => e.ref === ref && e.kind === "dropped")?.code;
  assert.equal(reason("diode"), "diode");
  assert.equal(reason("inductor"), "inductor");
  assert.equal(reason("npn"), "transistor");
});
