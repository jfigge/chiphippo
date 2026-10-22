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

// Tests for the DATA bus — the third element kind: eight pin tags the user
// sets by hand, Z / 0 / 1, from its card. The model (the kind, its levels,
// its own cap, the serial line it never crosses), the document (minting,
// the levels, unplugging back to Z, the loader) and the engine driving its
// planted pins exactly as an Input's.

import test from "node:test";
import assert from "node:assert/strict";

import { DeskDoc, normalizeDocument } from "../model/desk-doc.js";
import {
  DATA_LEVELS,
  MAX_DATA,
  MAX_ELEMENTS,
  connectionsUsed,
  dataPinLevel,
  drivesPins,
  elementKindOf,
  elementsFull,
  freeDataColors,
  isSerialElement,
  nextDataColor,
  nextDataLevel,
  normalizeDrive,
  normalizeElementFields,
  runElements,
  serialElements,
  tagKeys,
} from "../model/integration.js";
import { SIGNAL_COLORS } from "../model/signals.js";
import { buildNetlist } from "../sim/netlist.js";
import { settle } from "../sim/engine.js";
import { H, L, X, Z } from "../sim/levels.js";
import { partPinHoles } from "../model/occupancy.js";

const board = { id: "bb1", type: "pins-full", x: 0, y: 0, rot: 0, group: null };

function withBoard() {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  return doc;
}

// ── The model ──────────────────────────────────────────────────────────────

test("a data bus is its own kind, read off its id", () => {
  assert.equal(elementKindOf("data3"), "data");
  assert.equal(elementKindOf("data0"), null);
  assert.equal(elementKindOf("dat3"), null);
});

test("a click steps Z → 0 → 1 → Z, and junk steps to the start", () => {
  assert.deepEqual(DATA_LEVELS, ["z", "0", "1"]);
  assert.equal(nextDataLevel("z"), "0");
  assert.equal(nextDataLevel("0"), "1");
  assert.equal(nextDataLevel("1"), "z");
  assert.equal(nextDataLevel("banana"), "z");
});

test("normalizeDrive: always eight, junk read as Z", () => {
  assert.deepEqual(normalizeDrive(undefined), Array(8).fill("z"));
  assert.deepEqual(normalizeDrive(["1", "0", "x", 1, null, "z"]), [
    "1",
    "0",
    "z",
    "z",
    "z",
    "z",
    "z",
    "z",
  ]);
  assert.equal(normalizeDrive(Array(12).fill("1")).length, 8);
});

test("a data bus is always a byte on Auto, with no connection, whatever it says", () => {
  const fields = normalizeElementFields({
    id: "data1",
    color: "black",
    connection: "conn-a",
    triggerEdge: "rising",
    fields: [{ type: "word", name: "w" }],
    drive: ["1"],
  });
  assert.equal(fields.connection, null);
  assert.equal(fields.triggerEdge, "auto");
  assert.deepEqual(fields.fields, [{ type: "byte", name: "value" }]);
  assert.notEqual(fields.color, "black", "repaired like a signal's");
  assert.deepEqual(fields.drive, ["1", "z", "z", "z", "z", "z", "z", "z"]);
  assert.deepEqual(
    tagKeys({ ...fields, kind: "data" }),
    ["1", "2", "3", "4", "5", "6", "7", "8"],
    "eight pin tags and no trigger",
  );
});

test("the engine level of a pin: 1 → H, 0 → L, anything else Z", () => {
  const e = { drive: ["1", "0", "z"] };
  assert.equal(dataPinLevel(e, "1"), "H");
  assert.equal(dataPinLevel(e, "2"), "L");
  assert.equal(dataPinLevel(e, "3"), "Z");
  assert.equal(dataPinLevel(e, "9"), "Z");
});

test("a data bus drives its pins but is never serial", () => {
  const data = { id: "data1", kind: "data", connection: null };
  const inp = { id: "in1", kind: "input", connection: "a" };
  const out = { id: "out1", kind: "output", connection: "a" };
  assert.ok(drivesPins(data) && drivesPins(inp) && !drivesPins(out));
  assert.ok(!isSerialElement(data) && isSerialElement(inp));
  assert.deepEqual(serialElements([data, inp, out]), [inp, out]);
});

test("a run and its connections never include a data bus, planted or not", () => {
  const tags = { 1: { anchor: "bb1.a1", rot: 0 } };
  const data = { id: "data1", kind: "data", connection: "a", tags }; // a lie
  const out = { id: "out1", kind: "output", connection: "a", tags };
  assert.deepEqual(runElements([data, out]), [out]);
  assert.deepEqual(connectionsUsed([data]), []);
});

test("each kind counts only its own cap", () => {
  const data = Array.from({ length: MAX_DATA }, (_, i) => ({
    id: `data${i + 1}`,
    kind: "data",
  }));
  assert.equal(elementsFull(data, "data"), true);
  assert.equal(elementsFull(data, "output"), false);
  const serial = Array.from({ length: MAX_ELEMENTS }, (_, i) => ({
    id: `in${i + 1}`,
    kind: "input",
  }));
  assert.equal(elementsFull(serial, "input"), true);
  assert.equal(elementsFull(serial, "data"), false);
});

// ── The document ───────────────────────────────────────────────────────────

test("addIntegration mints a data bus: data<n>, a byte, every pin Z", () => {
  const doc = withBoard();
  const a = doc.addIntegration({ kind: "data", width: 2, connection: "x" });
  const b = doc.addIntegration({ kind: "data" });
  assert.equal(a.id, "data1");
  assert.equal(b.id, "data2");
  assert.equal(a.connection, null);
  assert.deepEqual(a.fields, [{ type: "byte", name: "value" }]);
  assert.deepEqual(a.drive, Array(8).fill("z"));
  assert.equal(doc.toJSON().nextDataId, 3);
  assert.equal(
    doc.toJSON().nextOutputId,
    1,
    "the other counters are untouched",
  );
});

test("seven data buses beside sixteen Outputs/Inputs — each cap is its own", () => {
  const doc = withBoard();
  for (let i = 0; i < MAX_ELEMENTS; i++) doc.addIntegration({ kind: "input" });
  for (let i = 0; i < MAX_DATA; i++) doc.addIntegration({ kind: "data" });
  assert.throws(() => doc.addIntegration({ kind: "data" }), {
    code: "INTEGRATIONS_FULL",
  });
  assert.throws(() => doc.addIntegration({ kind: "output" }), {
    code: "INTEGRATIONS_FULL",
  });
  assert.equal(doc.integrations.length, MAX_ELEMENTS + MAX_DATA);
});

test("setDataPin sets a planted pin's level, and only a planted pin's", () => {
  const doc = withBoard();
  const d = doc.addIntegration({ kind: "data" });
  assert.throws(() => doc.setDataPin(d.id, "1", "1"), { code: "NOT_FOUND" });
  doc.plantIntegrationTag(d.id, "1", "bb1.a5");
  doc.setDataPin(d.id, "1", "1");
  assert.equal(doc.getIntegration(d.id).drive[0], "1");
  assert.throws(() => doc.setDataPin(d.id, "1", "H"), { code: "INVALID_ARG" });
  assert.throws(() => doc.setDataPin(d.id, "9", "1"), { code: "NOT_FOUND" });
  assert.throws(() => doc.setDataPin(d.id, "T", "1"), { code: "NOT_FOUND" });
  const out = doc.addIntegration({ kind: "output" });
  doc.plantIntegrationTag(out.id, "1", "bb1.a6");
  assert.throws(() => doc.setDataPin(out.id, "1", "1"), { code: "NOT_FOUND" });
});

test("a pin's level rides a move, and goes back to Z when it is unplugged", () => {
  const doc = withBoard();
  const d = doc.addIntegration({ kind: "data" });
  doc.plantIntegrationTag(d.id, "1", "bb1.a5");
  doc.plantIntegrationTag(d.id, "2", "bb1.a6");
  doc.setDataPin(d.id, "1", "1");
  doc.setDataPin(d.id, "2", "0");
  doc.plantIntegrationTag(d.id, "1", "bb1.a9"); // moved, hole to hole
  assert.equal(doc.getIntegration(d.id).drive[0], "1");
  doc.unplantIntegrationTag(d.id, "1");
  assert.deepEqual(doc.getIntegration(d.id).drive.slice(0, 2), ["z", "0"]);
  doc.unplantIntegrationTags(d.id);
  assert.deepEqual(doc.getIntegration(d.id).drive, Array(8).fill("z"));
});

test("a board taken away sends a data pin home at Z", () => {
  const doc = withBoard();
  const d = doc.addIntegration({ kind: "data" });
  doc.plantIntegrationTag(d.id, "3", "bb1.a5");
  doc.setDataPin(d.id, "3", "1");
  doc.removeBoard("bb1");
  assert.equal(doc.getIntegration(d.id).tags, undefined);
  assert.equal(doc.getIntegration(d.id).drive[2], "z");
});

test("a data bus is always a byte: its fields cannot be re-shaped", () => {
  const doc = withBoard();
  const d = doc.addIntegration({ kind: "data" });
  assert.throws(
    () => doc.setIntegrationFields(d.id, [{ type: "bit", name: "a" }]),
    { code: "INVALID_ARG" },
  );
});

test("a copy's levels are its own", () => {
  const doc = withBoard();
  const d = doc.addIntegration({ kind: "data" });
  doc.getIntegration(d.id).drive[0] = "1";
  assert.equal(doc.getIntegration(d.id).drive[0], "z");
});

test("the loader: levels kept for planted pins only, its own cap, its own counter", () => {
  const raw = {
    boards: [board],
    components: [],
    wires: [],
    signals: [],
    integrations: [
      {
        id: "data4",
        kind: "data",
        color: "red",
        drive: ["1", "0", "1", "junk"],
        tags: {
          1: { anchor: "bb1.a5", rot: 0 },
          3: { anchor: "bb1.a7", rot: 90 },
          4: { anchor: "bb1.a8", rot: 0 },
        },
      },
      ...Array.from({ length: MAX_ELEMENTS }, (_, i) => ({ id: `in${i + 1}` })),
    ],
  };
  const doc = normalizeDocument(raw);
  const [d] = doc.integrations;
  assert.equal(d.id, "data4");
  assert.deepEqual(d.drive, ["1", "z", "1", "z", "z", "z", "z", "z"]);
  assert.equal(doc.integrations.length, 1 + MAX_ELEMENTS, "a full serial rail does not crowd it out"); // prettier-ignore
  assert.equal(doc.nextDataId, 5);
  // And it round-trips.
  assert.deepEqual(normalizeDocument(doc).integrations, doc.integrations);
});

// ── Colours: one each ──────────────────────────────────────────────────────

test("one data bus per signal colour: the cap IS the palette", () => {
  assert.equal(MAX_DATA, SIGNAL_COLORS.length);
  assert.equal(MAX_DATA, 7);
});

test("a new data bus never takes another's colour, and keeps clear of the rest while it can", () => {
  const doc = withBoard();
  doc.addSignal({}); // red, the first in the cycle
  const colors = [];
  for (let i = 0; i < MAX_DATA; i++) {
    colors.push(doc.addIntegration({ kind: "data" }).color);
  }
  assert.equal(new Set(colors).size, MAX_DATA, "seven buses, seven colours");
  assert.notEqual(colors[0], "red", "the signal's colour is the last chosen");
  assert.equal(colors.at(-1), "red");
  assert.equal(nextDataColor([...doc.signals, ...doc.integrations]), null);
  // A deleted bus's colour is the next one handed out.
  const gone = doc.integrations[2];
  doc.removeIntegration(gone.id);
  assert.equal(doc.addIntegration({ kind: "data" }).color, gone.color);
});

test("a data bus may be recoloured only to a colour no other data bus holds", () => {
  const doc = withBoard();
  const a = doc.addIntegration({ kind: "data" });
  const b = doc.addIntegration({ kind: "data" });
  assert.throws(() => doc.updateIntegration(b.id, { color: a.color }), {
    code: "INVALID_ARG",
  });
  assert.ok(!freeDataColors(doc.integrations, b.id).includes(a.color));
  assert.ok(freeDataColors(doc.integrations, b.id).includes(b.color));
  const spare = freeDataColors(doc.integrations, b.id).find(
    (c) => c !== b.color,
  );
  assert.equal(doc.updateIntegration(b.id, { color: spare }).color, spare);
  // An Output may share a data bus's colour — only data buses are unique.
  const out = doc.addIntegration({ kind: "output" });
  assert.equal(
    doc.updateIntegration(out.id, { color: a.color }).color,
    a.color,
  );
});

test("the loader repairs a data bus's colour another one already holds, first wins", () => {
  const doc = normalizeDocument({
    boards: [board],
    components: [],
    wires: [],
    signals: [],
    integrations: [
      { id: "data1", color: "blue" },
      { id: "out1", color: "green" },
      { id: "data2", color: "blue" },
      { id: "data3", color: "green" },
    ],
  });
  const [d1, , d2, d3] = doc.integrations;
  assert.equal(d1.color, "blue");
  assert.notEqual(d2.color, "blue");
  assert.equal(d3.color, "green", "an Output's colour is no data bus's");
  assert.equal(new Set([d1.color, d2.color, d3.color]).size, 3);
});

// ── The engine ─────────────────────────────────────────────────────────────

function solve(doc, signalLevels) {
  const netlist = buildNetlist(doc);
  const result = settle({ document: doc, netlist, signalLevels });
  return {
    result,
    at: (address) => result.netLevels.get(netlist.netOfPoint.get(address)),
  };
}

test("a data bus's planted pins drive their nets, as an Input's do", () => {
  const doc = {
    boards: [board],
    components: [],
    wires: [],
    signals: [],
    integrations: [
      {
        id: "data1",
        kind: "data",
        fields: [{ type: "byte", name: "value" }],
        drive: ["1", "0", "z", "z", "z", "z", "z", "z"],
        tags: {
          1: { anchor: "bb1.a5", rot: 0 },
          2: { anchor: "bb1.a6", rot: 0 },
          3: { anchor: "bb1.a7", rot: 0 },
        },
      },
    ],
  };
  const { at } = solve(
    doc,
    new Map([
      ["data1:1", H],
      ["data1:2", L],
      ["data1:3", Z],
    ]),
  );
  assert.equal(at("bb1.e5"), H, "the whole column-half");
  assert.equal(at("bb1.a6"), L);
  assert.equal(at("bb1.a7"), Z, "Z drives nothing — the net floats");
});

test("a data pin fighting a chip output is a conflict", () => {
  // A 74LS04: pin 1 tied LOW, so its output (pin 2) drives HIGH.
  const holes = partPinHoles("74LS04", "e20", {});
  const hole = (pin) => holes.find((h) => h.pin === pin).hole;
  const below = (pin) => hole(pin).replace(/^e/, "a"); // same column-half
  const above = (pin) => hole(pin).replace(/^f/, "j");
  const doc = {
    boards: [
      board,
      { id: "bb2", type: "rail-full", x: 0, y: 20, rot: 0, group: null },
    ],
    components: [
      { id: "psu1", kind: "psu", ref: "psu", x: 80, y: 0, params: { volts: 5 } }, // prettier-ignore
      { id: "c1", kind: "chip", ref: "74LS04", board: "bb1", anchor: "e20", params: {} }, // prettier-ignore
    ],
    wires: [
      { id: "w1", from: "psu1.+", to: "bb2.+1", color: "red" },
      { id: "w2", from: "psu1.-", to: "bb2.-1", color: "black" },
      { id: "w3", from: `bb1.${above(14)}`, to: "bb2.+20", color: "red" },
      { id: "w4", from: `bb1.${below(7)}`, to: "bb2.-20", color: "black" },
      { id: "w5", from: `bb1.${below(1)}`, to: "bb2.-25", color: "black" },
    ],
    signals: [],
    integrations: [
      {
        id: "data1",
        kind: "data",
        fields: [{ type: "byte", name: "value" }],
        drive: ["0", "z", "z", "z", "z", "z", "z", "z"],
        tags: { 1: { anchor: `bb1.${below(2)}`, rot: 0 } },
      },
    ],
  };
  const quiet = solve(doc, new Map([["data1:1", H]]));
  assert.equal(quiet.at(`bb1.${hole(2)}`), H);
  assert.ok(!quiet.result.warnings.some((w) => w.type === "conflict"));
  const fight = solve(doc, new Map([["data1:1", L]]));
  assert.equal(fight.at(`bb1.${hole(2)}`), X);
  assert.ok(fight.result.warnings.some((w) => w.type === "conflict"));
});
