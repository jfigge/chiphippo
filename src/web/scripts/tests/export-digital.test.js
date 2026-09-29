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

test("an unconnected chip input is tied HIGH right on its pin", () => {
  const doc = bench();
  const circuit = parse(exportOf(doc).files[0].text);
  const chip = circuit.elements.find((el) => el.name === "7400.dig");
  const ups = new Set(
    circuit.elements
      .filter((el) => el.name === "PullUp")
      .map((el) => `${el.x},${el.y}`),
  );
  // Gates 2–4 are unwired: their six inputs float, and read HIGH.
  for (const pin of [4, 5, 9, 10, 12, 13]) {
    const at = dilPin("7400.dig", chip.x, chip.y, pin);
    assert.ok(ups.has(`${at.x},${at.y}`), `pin ${pin} is pulled up`);
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
