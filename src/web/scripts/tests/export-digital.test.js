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

// export-digital.test.js — the Digital simulator export (Feature 390).
//
// The pin tables are held to Digital's own library (digital-lib.js, extracted
// from it), so a chip Digital pins differently can never be mapped; the file
// is read back — every chip pin followed along its wire to the tunnel that
// names its net; and the translations with no Digital equivalent (resistors,
// floating inputs, open displays, the slide switch's starting throw) are
// pinned one by one. export-digital-cli.test.js then runs the result in
// Digital itself, where it is installed.

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { PALETTE_DEFS, chipDef } from "../catalog/index.js";
import { exportNetlist } from "../model/export/export-netlist.js";
import {
  DIGITAL_FILES,
  DIGITAL_OPEN_COLLECTOR,
  DIGITAL_UNSUPPORTED,
} from "../model/export/digital-parts.js";
import { DIGITAL_LIB } from "../model/export/digital-lib.js";
import { digitalMapped, exportDigital } from "../model/export/digital.js";
import { bench, demoDocs } from "./export-fixtures.js";
import { bench as timingBench } from "./timing-fixtures.js";
import { compileNetlist } from "../model/autobuild.js";
import { normalizeDocument } from "../model/desk-doc.js";

const SIZE = 20;

/** Digital's built-in elements the export may use. */
const BUILT_INS = new Set([
  "Tunnel",
  "VDD",
  "Ground",
  "PullUp",
  "PullDown",
  "Clock",
  "Button",
  "In",
  "Switch",
  "SwitchDT",
  "PolarityAwareLED",
  "Seven-Seg",
  "Text",
]);

/** Parse a `.dig`, failing on anything that is not well-formed XML. */
function parse(text) {
  const { DOMParser } = new JSDOM("").window;
  const xml = new DOMParser().parseFromString(text, "application/xml");
  assert.equal(
    xml.getElementsByTagName("parsererror").length,
    0,
    "well-formed XML",
  );
  const attr = (el, key) => {
    for (const entry of el.querySelectorAll("elementAttributes > entry")) {
      if (entry.children[0].textContent === key) return entry.children[1];
    }
    return null;
  };
  const elements = [
    ...xml.querySelectorAll("visualElements > visualElement"),
  ].map((el) => ({
    name: el.querySelector("elementName").textContent,
    x: Number(el.querySelector("pos").getAttribute("x")),
    y: Number(el.querySelector("pos").getAttribute("y")),
    attr: (key) => attr(el, key),
  }));
  const wires = [...xml.querySelectorAll("wires > wire")].map((w) => [
    Number(w.querySelector("p1").getAttribute("x")),
    Number(w.querySelector("p1").getAttribute("y")),
    Number(w.querySelector("p2").getAttribute("x")),
    Number(w.querySelector("p2").getAttribute("y")),
  ]);
  return { elements, wires };
}

/** The tunnel name each point reaches over wires (Digital joins at ends). */
function tunnelAt(circuit) {
  const parent = new Map();
  const find = (a) => {
    if (!parent.has(a)) parent.set(a, a);
    while (parent.get(a) !== a) a = parent.get(a);
    return a;
  };
  for (const [x1, y1, x2, y2] of circuit.wires) {
    parent.set(find(`${x1},${y1}`), find(`${x2},${y2}`));
  }
  const names = new Map();
  for (const el of circuit.elements) {
    if (el.name !== "Tunnel") continue;
    names.set(find(`${el.x},${el.y}`), el.attr("NetName").textContent);
  }
  return (x, y) => names.get(find(`${x},${y}`)) ?? null;
}

/** Where pin `p` of a library DIL chip placed at (x, y) is. */
function dilPin(file, x, y, p) {
  const { pins: n, width } = DIGITAL_LIB[file];
  return p <= n / 2
    ? { x, y: y + 2 * SIZE * (p - 1) }
    : { x: x + SIZE * (width + 1), y: y + 2 * SIZE * (n - p) };
}

const exportOf = (doc, name = "x") => exportDigital(doc, { tabId: "t1", name });

// ── Coverage and the pin tables ──────────────────────────────────────────────

test("every palette part is either exported or named as not, with a reason", () => {
  for (const def of PALETTE_DEFS) {
    const mapped = digitalMapped(def);
    const refused = def.id in DIGITAL_UNSUPPORTED;
    assert.ok(mapped !== refused, `${def.id}: exactly one of the two`);
  }
  for (const id of Object.keys(DIGITAL_UNSUPPORTED)) {
    assert.ok(
      PALETTE_DEFS.some((d) => d.id === id),
      `${id} is a catalog part`,
    );
  }
});

test("every mapped chip is pinned in Digital exactly as it is here", () => {
  for (const [id, file] of Object.entries(DIGITAL_FILES)) {
    const def = chipDef(id);
    const lib = DIGITAL_LIB[file];
    assert.ok(def, `${id} is a catalog chip`);
    assert.ok(lib, `${file} is in the extracted library table`);
    const pkgPins = Number(def.package.replace("DIP-", ""));
    assert.equal(lib.pins, pkgPins, `${id}: pin count`);
    const outputs = new Set(lib.outputs);
    for (const pin of def.pins) {
      const theirs = lib.names[pin.n];
      if (pin.role === "nc") {
        assert.equal(theirs, undefined, `${id} pin ${pin.n} is NC in both`);
        continue;
      }
      assert.ok(theirs != null, `${id} pin ${pin.n} exists in Digital`);
      if (pin.role === "vcc") assert.match(theirs, /VCC|VDD/, `${id} VCC`);
      if (pin.role === "gnd") assert.match(theirs, /GND|VSS/, `${id} GND`);
      if (pin.role === "output") {
        assert.ok(outputs.has(pin.n), `${id} pin ${pin.n} is an output there`);
      }
      if (pin.role === "input" || pin.role === "vcc" || pin.role === "gnd") {
        assert.ok(!outputs.has(pin.n), `${id} pin ${pin.n} is an input there`);
      }
    }
  }
});

// ── The file reads back as the model ─────────────────────────────────────────

test("every demo exports well-formed Digital, each chip pin on its net's tunnel", () => {
  for (const { ref, doc } of demoDocs()) {
    const res = exportOf(doc, ref);
    assert.equal(res.files.length, 1);
    assert.equal(res.files[0].name, `${ref}.dig`);
    const circuit = parse(res.files[0].text);
    for (const el of circuit.elements) {
      assert.ok(
        BUILT_INS.has(el.name) || el.name in DIGITAL_LIB,
        `${ref}: ${el.name} is something Digital has`,
      );
    }
    if (res.report.some((e) => e.code === "resistorMerged")) continue;
    const model = exportNetlist(doc);
    const reach = tunnelAt(circuit);
    for (const part of model.parts) {
      const file = DIGITAL_FILES[part.def.id];
      if (!file) continue;
      const chip = circuit.elements.find(
        (el) =>
          el.name === file && el.attr("Label")?.textContent === part.designator,
      );
      assert.ok(chip, `${ref}: ${part.designator} is placed`);
      for (const port of part.ports) {
        if (!port.net) continue;
        const at = dilPin(file, chip.x, chip.y, port.pin);
        assert.equal(
          reach(at.x, at.y),
          model.nets.get(port.net).name,
          `${ref}: ${part.designator} pin ${port.pin}`,
        );
      }
    }
  }
});

test("a character XML forbids is dropped, so Digital can open the file", () => {
  const res = exportDigital(bench(), {
    tabId: "t1",
    name: "Bench\u000bOne",
    description: "a\u0001b\uD800c\uFFFEd \uD83D\uDE00",
  });
  const text = res.files[0].text;
  assert.doesNotMatch(
    text,
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/,
  );
  parse(text); // well-formed — it was not, with the \u000b in it
  assert.match(text, /BenchOne/);
  // A whole surrogate PAIR is a real character and stays.
  assert.match(text, /abcd \u{1F600}/u);
});

test("the same desk exports the same bytes", () => {
  const doc = bench();
  assert.deepEqual(exportOf(doc).files, exportOf(doc).files);
});

// ── The translations ─────────────────────────────────────────────────────────

test("a lamp resistor to a rail becomes a pull on the lamp's side", () => {
  // The compiler puts a series resistor in the LED's cathode leg to GND.
  const doc = bench();
  const model = exportNetlist(doc);
  const led = model.parts.find((p) => p.def.id === "led");
  const cathode = model.nets.get(led.ports.find((p) => p.key === "2").net).name;
  const circuit = parse(exportOf(doc).files[0].text);
  const reach = tunnelAt(circuit);
  const downs = circuit.elements.filter((el) => el.name === "PullDown");
  assert.ok(
    downs.some((el) => reach(el.x, el.y) === cathode),
    "the cathode net is pulled down, as the resistor to GND pulls it here",
  );
  assert.equal(
    circuit.elements.filter((el) => el.name === "Resistor").length,
    0,
  );
});

test("a potentiometer is its sides: a pull, or at the end of its track a wire", () => {
  // The wiper on GND, pin 1 on a NAND input, pin 3 open.
  const circuitAt = (position) => {
    const b = timingBench();
    const u = b.seat("u1", "74LS00", "e10");
    b.vcc(u.get(14));
    b.gnd(u.get(7));
    const rv = b.seat("rv1", "pot", "a30", { ohms: 1e4, position });
    b.gnd(rv.get(2));
    b.link(rv.get(1), u.get(1));
    const res = exportOf(b.doc);
    const circuit = parse(res.files[0].text);
    const reach = tunnelAt(circuit);
    const chip = circuit.elements.find((el) => el.name === "7400.dig");
    const pin = dilPin("7400.dig", chip.x, chip.y, 1);
    const input = reach(pin.x, pin.y);
    const pulledDown = circuit.elements.some(
      (el) => el.name === "PullDown" && reach(el.x, el.y) === input,
    );
    return { report: res.report, input, pulledDown };
  };
  const mid = circuitAt(50);
  assert.equal(mid.pulledDown, true, "a side with track left pulls");
  assert.notEqual(mid.input, "GND");
  assert.ok(!mid.report.some((e) => e.code === "unmapped"), "it comes across");
  const end = circuitAt(0);
  assert.equal(end.input, "GND", "a side with none left is a wire to it");
  assert.equal(end.pulledDown, false);
});

/** Where a pull's far end is: two grid units the way its rotation points. */
function pullTip(el) {
  const r = Number(el.attr("rotation")?.getAttribute("rotation") ?? 0);
  const dirs =
    el.name === "PullUp"
      ? [[0, -1], [-1, 0], [0, 1], [1, 0]] // prettier-ignore
      : [[0, 1], [1, 0], [0, -1], [-1, 0]]; // prettier-ignore
  const [dx, dy] = dirs[r];
  return { x: el.x + 2 * SIZE * dx, y: el.y + 2 * SIZE * dy };
}

/** Every pin of every library chip placed in a circuit, as "x,y". */
function chipPins(circuit) {
  const pins = new Set();
  for (const el of circuit.elements) {
    const lib = DIGITAL_LIB[el.name];
    if (!lib) continue;
    for (let p = 1; p <= lib.pins; p++) {
      const at = dilPin(el.name, el.x, el.y, p);
      pins.add(`${at.x},${at.y}`);
    }
  }
  return pins;
}

test("an unconnected chip input is tied HIGH right on its pin, pointing away from the chip", () => {
  const doc = bench();
  const circuit = parse(exportOf(doc).files[0].text);
  const chip = circuit.elements.find((el) => el.name === "7400.dig");
  const ups = new Map(
    circuit.elements
      .filter((el) => el.name === "PullUp")
      .map((el) => [`${el.x},${el.y}`, el]),
  );
  // Gates 2–4 are unwired: their six inputs float, and read HIGH.
  for (const pin of [4, 5, 9, 10, 12, 13]) {
    const at = dilPin("7400.dig", chip.x, chip.y, pin);
    const up = ups.get(`${at.x},${at.y}`);
    assert.ok(up, `pin ${pin} is pulled up`);
    // Out along its own row — left of a left-hand pin, right of a right-hand
    // one — never up the column onto the next pin's lead (2A's onto 1Y).
    const tip = pullTip(up);
    assert.equal(tip.y, at.y, `pin ${pin}'s pull-up lies along its row`);
    assert.equal(
      Math.sign(tip.x - at.x),
      pin <= 7 ? -1 : 1,
      `pin ${pin}'s pull-up points away from the chip`,
    );
  }
});

test("no demo's pulls reach a chip pin other than their own", () => {
  for (const { ref, doc } of demoDocs()) {
    const circuit = parse(exportOf(doc, ref).files[0].text);
    const pins = chipPins(circuit);
    for (const el of circuit.elements) {
      if (el.name !== "PullUp" && el.name !== "PullDown") continue;
      const tip = pullTip(el);
      // The body runs from its pin to its tip; a chip pin anywhere along it
      // past the pin itself is a lead drawn over.
      for (let k = 1; k <= 2; k++) {
        const x = el.x + ((tip.x - el.x) * k) / 2;
        const y = el.y + ((tip.y - el.y) * k) / 2;
        assert.ok(
          !pins.has(`${x},${y}`),
          `${ref}: the ${el.name} at ${el.x},${el.y} lies over a pin at ${x},${y}`,
        );
      }
    }
  }
});

test("a slide switch starts on the throw the desk has it on", () => {
  const doc = bench();
  const comp = doc.components.find((c) => c.ref === "sw-slide");
  const model = exportNetlist(doc);
  const part = model.parts.find((p) => p.id === comp.id);
  const netName = (key) =>
    model.nets.get(part.ports.find((p) => p.key === key).net).name;
  for (const pos of ["1", "2"]) {
    comp.params = { ...comp.params, pos };
    const circuit = parse(exportOf(doc).files[0].text);
    const reach = tunnelAt(circuit);
    const sw = circuit.elements.find(
      (el) =>
        el.name === "SwitchDT" &&
        el.attr("Label")?.textContent === part.designator,
    );
    // Digital's SwitchDT always starts common-to-C, C at (40, 20).
    assert.equal(
      reach(sw.x + 2 * SIZE, sw.y + SIZE),
      netName(pos === "2" ? "3" : "1"),
      `position ${pos} is the throw wired to C`,
    );
  }
});

test("parts Digital cannot model are reported and left as a note", () => {
  const { ref, doc } = demoDocs().find((d) => d.ref === "74LS240");
  const res = exportOf(doc, ref);
  const entry = res.report.find((e) => e.kind === "dropped");
  assert.equal(entry.code, "noDigitalModel");
  assert.deepEqual(entry.designators, ["U1"]);
  const circuit = parse(res.files[0].text);
  assert.ok(
    circuit.elements.some(
      (el) =>
        el.name === "Text" &&
        /U1 74LS240/.test(el.attr("Description").textContent),
    ),
  );
});

test("an open-collector part is reported, and its outputs pulled up", () => {
  const id = DIGITAL_OPEN_COLLECTOR[0];
  const found = demoDocs().find((d) => d.ref === id);
  const res = exportOf(found.doc, id);
  assert.ok(res.report.some((e) => e.code === "openCollector" && e.ref === id));
  const model = exportNetlist(found.doc);
  const circuit = parse(res.files[0].text);
  const reach = tunnelAt(circuit);
  const pulledUp = new Set(
    circuit.elements
      .filter((el) => el.name === "PullUp")
      .map((el) => reach(el.x, el.y)),
  );
  const chip = model.parts.find((p) => p.def.id === id);
  const driven = chip.ports.filter((p) => p.role === "output" && p.net);
  assert.ok(driven.length > 0);
  for (const port of driven) {
    assert.ok(
      pulledUp.has(model.nets.get(port.net).name),
      `output pin ${port.pin} is pulled up`,
    );
  }
});

// ── CMOS parts (Feature 400) ─────────────────────────────────────────────────

/**
 * A CD4002B bench with one gate's inputs left undriven three ways: a switch
 * on A, a net of nothing but inputs on B and C, and D on no net at all.
 */
function cmosBench() {
  const built = compileNetlist({
    title: "NOR bench",
    parts: [
      { id: "U1", ref: "CD4002B" },
      { id: "S1", ref: "sw-slide" },
      { id: "D1", ref: "led" },
    ],
    nets: [
      { name: "A", members: ["U1.A", "S1.C"] },
      { name: "A_HI", members: ["S1.#1", "VCC"] },
      { name: "A_LO", members: ["S1.#3", "GND"] },
      { name: "FLOAT", members: ["U1.B", "U1.C"] },
      { name: "Y", members: ["U1.J", "D1.A"] },
      { name: "LAMP", members: ["D1.K", "GND"] },
    ],
  });
  assert.ok(built.ok, JSON.stringify(built.errors));
  return normalizeDocument(built.document);
}

test("a CD4000 part with a Digital twin is placed as that chip", () => {
  const doc = cmosBench();
  const circuit = parse(exportOf(doc).files[0].text);
  assert.ok(circuit.elements.some((el) => el.name === "744002.dig"));
});

test("a floating CMOS input is pulled up in Digital, and that is reported", () => {
  const doc = cmosBench();
  const res = exportOf(doc);
  const model = exportNetlist(doc);
  const chip = model.parts.find((p) => p.def.id === "CD4002B");
  const entry = res.report.find((e) => e.code === "cmosFloating");
  assert.ok(entry, "reported");
  assert.equal(entry.kind, "changed");
  assert.deepEqual(entry.designators, [chip.designator]);
  const circuit = parse(res.files[0].text);
  const reach = tunnelAt(circuit);
  const ups = circuit.elements.filter((el) => el.name === "PullUp");
  // The net of nothing but inputs (B, C) carries a PullUp…
  const floatNet = model.nets.get(chip.ports.find((p) => p.pin === 3).net).name;
  assert.ok(
    ups.some((el) => reach(el.x, el.y) === floatNet),
    "B/C pulled up",
  );
  // …and D, on no net, has one right on its pin.
  const el = circuit.elements.find((e) => e.name === "744002.dig");
  const at = dilPin("744002.dig", el.x, el.y, 5);
  assert.ok(
    ups.some((u) => u.x === at.x && u.y === at.y),
    "D pulled up on the pin",
  );
});

test("a floating TTL input is not a CMOS report — it reads HIGH in both", () => {
  const res = exportOf(bench());
  assert.ok(!res.report.some((e) => e.code === "cmosFloating"));
});

test("a chip no supply reaches is REPORTED unpowered — Digital would run it", () => {
  const powered = exportOf(bench());
  assert.equal(
    powered.report.some((e) => e.code === "unpowered"),
    false,
  );
  // The same desk with its supply taken away: the rails are still VCC/GND
  // nets, which Digital powers, but our engine leaves the chip inert.
  const doc = structuredClone(bench());
  const psu = doc.components.find((c) => c.kind === "psu");
  doc.components = doc.components.filter((c) => c !== psu);
  doc.wires = doc.wires.filter((w) => !`${w.from} ${w.to}`.includes(`${psu.id}.`)); // prettier-ignore
  const res = exportOf(doc);
  const entry = res.report.find((e) => e.code === "unpowered");
  assert.ok(entry, JSON.stringify(res.report));
  assert.equal(entry.kind, "changed");
  assert.equal(entry.ref, "74LS00");
});

test("a 7-segment digit grounded through its pin-8 common is lit in Digital, not left open", () => {
  // seg7cc at d20 (wide): pin 8, a COM, is h22 — wired to the − rail by its
  // column (f–j node), pin 3 left bare. The commons are one inside the part,
  // and the export reads the wiring alone.
  let n = 0;
  const wire = (from, to) => ({ id: `w${++n}`, from, to, color: "black" });
  const doc = {
    boards: [
      { id: "bb1", type: "pins-full", x: 0, y: 3.5 },
      { id: "bb2", type: "rail-full", x: 0, y: 0 },
      { id: "bb3", type: "rail-full", x: 0, y: 17.52 },
    ],
    components: [
      { id: "psu1", kind: "psu", ref: "psu", x: 80, y: 0, params: { volts: 5 } }, // prettier-ignore
      { id: "c1", kind: "discrete", ref: "seg7cc", board: "bb1", anchor: "d20", params: { color: "red", wide: true } }, // prettier-ignore
    ],
    wires: [
      wire("psu1.+", "bb2.+1"),
      wire("psu1.-", "bb3.-1"),
      wire("bb1.j22", "bb3.-5"), // pin 8 (COM)
      wire("bb1.i23", "bb2.+5"), // pin 7 (a)
    ],
  };
  const circuit = parse(exportOf(doc).files[0].text);
  const reach = tunnelAt(circuit);
  const seg = circuit.elements.find((el) => el.name === "Seven-Seg");
  assert.equal(seg.attr("Label").textContent, "DS1");
  assert.equal(reach(seg.x + 4 * SIZE, seg.y + 7 * SIZE), "GND");
});
