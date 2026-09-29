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

// Tests for model/serial-wire.js — the serial protocol's constants and CRCs,
// stated once — and for the ONE layout signature (integration.js's
// `layoutSignature`) that both the generator and a run's handshake call:
// what changes it, what must not, and the wire order it lists elements in.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { FRAME, PROTOCOL_VERSION, crc16, crc32 } from "../model/serial-wire.js";
import {
  elementIndex,
  elementsFor,
  layoutSignature,
  layoutString,
} from "../model/integration.js";

const ascii = (s) => new TextEncoder().encode(s);

const el = (id, kind, fields, extra = {}) => ({
  id,
  kind,
  name: id,
  connection: "nano",
  fields,
  ...extra,
});
const bits = (n) => Array.from({ length: n }, () => ({ type: "bit" }));
const byte = { type: "byte" };
const word = { type: "word" };

/** The protocol document's example layout: two Outputs and a word Input. */
const example = () => [
  el("out1", "output", [byte]),
  el("out2", "output", bits(1)),
  el("in1", "input", [word]),
];

test("the CRCs' check values", () => {
  assert.equal(crc16(ascii("123456789")), 0x29b1);
  assert.equal(crc32(ascii("123456789")), 0xcbf43926);
  assert.equal(crc32(ascii("")), 0);
});

test("main reads the very same module — one copy of every constant", () => {
  const require = createRequire(import.meta.url);
  const protocol = require("../../../app/serial/protocol.js");
  assert.equal(protocol.PROTOCOL_VERSION, PROTOCOL_VERSION);
  assert.equal(protocol.FRAME, FRAME, "the same object, not a copy");
});

test("the layout string and signature match the protocol document's example", () => {
  assert.equal(layoutString(example(), "nano"), "O0:8,O1:1,I0:16");
  assert.equal(layoutSignature(example(), "nano"), 0xf8acb506);
  assert.equal(layoutString([], "nano"), "");
  assert.equal(layoutSignature([], "nano"), 0);
});

test("a multi-field element lists its field widths in order", () => {
  const els = [
    el("out1", "output", [byte, ...bits(3)]),
    el("in1", "input", bits(2)),
  ];
  assert.equal(layoutString(els, "nano"), "O0:8+1+1+1,I0:1+1");
});

test("the signature ignores names, colours, triggers and tags", () => {
  const base = layoutSignature(example(), "nano");
  const cosmetic = example().map((e, i) => ({
    ...e,
    name: `Renamed ${i}`,
    color: "blue",
    description: "notes",
    triggerEdge: "falling",
    tags: { 1: { anchor: "bb1.a1", rot: 0 } },
    fields: e.fields.map((f) => ({ ...f, name: `f${i}` })),
  }));
  assert.equal(layoutSignature(cosmetic, "nano"), base);
});

test("the signature changes when an element is added or removed, or a width or field order changes", () => {
  const base = layoutSignature(example(), "nano");
  const added = [...example(), el("in2", "input", bits(1))];
  assert.notEqual(layoutSignature(added, "nano"), base);
  const removed = example().slice(1);
  assert.notEqual(layoutSignature(removed, "nano"), base);
  const wider = example();
  wider[1].fields = bits(2);
  assert.notEqual(layoutSignature(wider, "nano"), base);
  // Same total width, different field boundaries: every value would land in
  // the wrong parameter, so the sketch must be refused.
  const a = [el("out1", "output", [...bits(1), byte])];
  const b = [el("out1", "output", [byte, ...bits(1)])];
  assert.notEqual(layoutSignature(a, "nano"), layoutSignature(b, "nano"));
});

test("only the connection's own elements are in it", () => {
  const els = [
    ...example(),
    el("out3", "output", [word], { connection: "uno" }),
  ];
  assert.equal(layoutString(els, "nano"), "O0:8,O1:1,I0:16");
  assert.equal(layoutString(els, "uno"), "O0:16");
});

test("wire order is by the number in the id — numerically, not as text", () => {
  const els = [
    el("out10", "output", bits(1)),
    el("out2", "output", [byte]),
    el("in3", "input", bits(1)),
    el("out9", "output", [word]),
  ];
  assert.deepEqual(
    elementsFor(els, "nano", "output").map((e) => e.id),
    ["out2", "out9", "out10"],
  );
  assert.equal(elementIndex(els, els[0]), 2);
  assert.equal(layoutString(els, "nano"), "O0:8,O1:16,O2:1,I0:1");
});
