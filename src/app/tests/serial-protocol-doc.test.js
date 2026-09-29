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

/**
 * tests/serial-protocol-doc.test.js — the protocol PAGE held to the code
 * (src/web/docs/serial-protocol.md, which is normative, and which an
 * implementer reads instead of the source). Everything the page states as a
 * number is read back out of it and checked:
 *
 *   · every frame it writes out in hex is a valid frame — escaping and CRC
 *     included — and the worked examples are exactly what the encoder makes;
 *   · every "CRC 0x…" it quotes is the CRC of the frame that follows;
 *   · its Constants table is serial-wire.js's exports, name for name;
 *   · its frame-type table is FRAME;
 *   · its layout signatures are the CRC-32 of their strings, and those
 *     strings are what `layoutString` writes for the designs they describe.
 *
 * So the page and the implementation cannot drift apart silently: editing
 * either without the other fails here.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const wire = require("../serial/protocol");
const {
  FRAME,
  crc16,
  crc32,
  encodeFrame,
  FrameDecoder,
  encodeData,
  encodeHello,
} = wire;

const DOC = fs.readFileSync(
  path.join(__dirname, "../../web/docs/serial-protocol.md"),
  "utf8",
);

const hex = (buf) =>
  [...buf].map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
const squash = (s) => s.trim().split(/\s+/).join(" ");

/** Every frame the page writes out — a fenced line or an inline code span of
    hex bytes starting with START, at least a frame's six — with where it
    is. */
function framesInDoc() {
  const found = [];
  const re = /(?:^|`)(7E(?:[ \t]+[0-9A-F]{2}){5,})[ \t]*(?:$|`)/gm;
  for (let m; (m = re.exec(DOC));) {
    found.push({ text: squash(m[1]), at: m.index });
  }
  return found;
}

const SIGNATURE = crc32(Buffer.from("O0:8,O1:1,I0:16", "ascii"));
const SESSION = 0x1234;

/** The worked examples (§12), as the encoder makes them. */
const VECTORS = [
  ["HELLO", { type: FRAME.HELLO, payload: encodeHello({ version: 1, session: SESSION, signature: SIGNATURE }) }], // prettier-ignore
  ["HELLO_ACK", { type: FRAME.HELLO_ACK, payload: encodeHello({ version: 1, session: SESSION, signature: SIGNATURE }) }], // prettier-ignore
  ["the start-up announcement", { type: FRAME.HELLO_ACK, payload: encodeHello({ version: 1, session: 0, signature: SIGNATURE }) }], // prettier-ignore
  ["HELLO for session 0x7D7E", { type: FRAME.HELLO, payload: encodeHello({ version: 1, session: 0x7d7e, signature: SIGNATURE }) }], // prettier-ignore
  ["OUTPUT 1: element 0, width 8, 0x7E", { type: FRAME.OUTPUT, seq: 1, payload: encodeData(0, 8, 0x7e) }], // prettier-ignore
  ["ACK 1", { type: FRAME.ACK, seq: 1 }],
  ["ACK 16", { type: FRAME.ACK, seq: 16 }],
  ["ACK 17", { type: FRAME.ACK, seq: 17 }],
  ["INBOUND 1: element 0, width 16, 0xBEEF", { type: FRAME.INBOUND, seq: 1, payload: encodeData(0, 16, 0xbeef) }], // prettier-ignore
  ["LOG ok", { type: FRAME.LOG, payload: [...Buffer.from("ok\n")] }],
  ["NAK", { type: FRAME.NAK }],
  ["OUTPUT 2: element 1, width 1, 1", { type: FRAME.OUTPUT, seq: 2, payload: encodeData(1, 1, 1) }], // prettier-ignore
  ["ACK 2", { type: FRAME.ACK, seq: 2 }],
];

test("every frame the page writes out is a valid frame, escaping and CRC included", () => {
  const frames = framesInDoc();
  assert.ok(frames.length >= 15, `found ${frames.length}`);
  for (const { text } of frames) {
    const bytes = Buffer.from(text.split(" ").map((b) => parseInt(b, 16)));
    const decoded = new FrameDecoder().push(bytes);
    assert.equal(decoded.length, 1, `one frame: ${text}`);
    assert.equal(decoded[0].ok, true, `intact: ${text}`);
    assert.equal(hex(encodeFrame(decoded[0])), text, `canonical: ${text}`);
  }
});

test("the worked examples are exactly what the encoder makes", () => {
  const written = new Set(framesInDoc().map((f) => f.text));
  for (const [name, frame] of VECTORS) {
    const bytes = hex(encodeFrame(frame));
    assert.ok(written.has(bytes), `${name}: the page has ${bytes}`);
  }
});

test("every CRC the page quotes is the CRC of the frame that follows it", () => {
  const frames = framesInDoc();
  const re = /CRC\s+`0x([0-9A-F]{4})`/g;
  let checked = 0;
  for (let m; (m = re.exec(DOC));) {
    const next = frames.find((f) => f.at > m.index);
    assert.ok(next, `a frame follows CRC 0x${m[1]}`);
    const [frame] = new FrameDecoder().push(
      Buffer.from(next.text.split(" ").map((b) => parseInt(b, 16))),
    );
    const body = [
      frame.type,
      frame.seq,
      frame.payload.length,
      ...frame.payload,
    ];
    assert.equal(
      crc16(body).toString(16).toUpperCase().padStart(4, "0"),
      m[1],
      `CRC 0x${m[1]} before ${next.text}`,
    );
    checked++;
  }
  assert.ok(checked >= 9, `checked ${checked}`);
});

test("the check values the page quotes are the algorithms'", () => {
  assert.match(DOC, /`123456789`,\s+is\s+`0x29B1`/);
  assert.equal(crc16(Buffer.from("123456789", "ascii")), 0x29b1);
  assert.match(DOC, /`123456789`,\s+is\s+`0xCBF43926`/);
  assert.equal(crc32(Buffer.from("123456789", "ascii")), 0xcbf43926);
  assert.match(DOC, /empty\s+layout's\s+signature\s+is\s+`0x00000000`/);
  assert.equal(crc32([]), 0);
});

test("the Constants table is serial-wire.js, name for name", () => {
  const section = DOC.slice(
    DOC.indexOf("## 10. Constants"),
    DOC.indexOf("## 11. Versions"),
  );
  const rows = [
    ...section.matchAll(/^\| `([A-Z0-9_]+)` \| `?(0x[0-9A-F]+|\d+)`? \|/gm),
  ];
  assert.ok(rows.length >= 20, `found ${rows.length} rows`);
  for (const [, name, value] of rows) {
    assert.ok(Object.hasOwn(wire, name), `${name} is an export`);
    assert.equal(Number(value), wire[name], name);
  }
  // …and nothing the page names is missing a row: every numeric protocol
  // constant the device's code is written from appears.
  const named = new Set(rows.map((r) => r[1]));
  for (const name of [
    "PROTOCOL_VERSION",
    "START",
    "ESC",
    "ESC_XOR",
    "MAX_PAYLOAD",
    "HELLO_PAYLOAD",
    "DATA_PAYLOAD",
    "MAX_SESSION",
    "MAX_SEQ",
    "ACK_TIMEOUT_MS",
    "MAX_SENDS",
    "HELLO_INTERVAL_MS",
    "HELLO_WINDOW_MS",
    "CRC16_POLY",
    "CRC16_INIT",
    "MAX_FRAME_BODY",
    "MAX_WIRE_FRAME",
  ]) {
    // prettier-ignore
    assert.ok(named.has(name), `${name} has a row`);
  }
});

test("the size limits are the arithmetic the page shows", () => {
  assert.equal(wire.MAX_FRAME_BODY, 1 + 1 + 1 + 255 + 2);
  assert.equal(wire.MAX_WIRE_FRAME, 1 + 2 * 260);
  assert.equal(
    wire.MAX_HOST_PAYLOAD,
    7,
    "a HELLO is the longest the host sends",
  );
  // The worst case really is that long: a body of nothing but markers.
  const frame = encodeFrame({
    type: FRAME.LOG,
    seq: 0x7e,
    payload: new Array(255).fill(0x7d),
  });
  assert.ok(frame.length <= wire.MAX_WIRE_FRAME);
  assert.ok(
    frame.length >= wire.MAX_WIRE_FRAME - 6,
    "within the header and CRC's slack",
  );
});

test("the frame-type table is FRAME", () => {
  const rows = [...DOC.matchAll(/^\| `0x([0-9A-F]{2})` \| `([A-Z_]+)` \|/gm)];
  assert.deepEqual(
    Object.fromEntries(
      rows.map(([, value, name]) => [name, parseInt(value, 16)]),
    ),
    { ...FRAME },
  );
});

test("the layout signatures are the CRC-32 of their strings — and layoutString writes those strings", async () => {
  const { layoutString, layoutSignature } =
    await import("../../web/scripts/model/integration.js");
  const rows = [
    ...DOC.matchAll(/^\| `([OI][0-9:+,OI]*)` \| `0x([0-9A-F]{8})` \|/gm),
  ];
  assert.ok(rows.length >= 4);
  for (const [, layout, sig] of rows) {
    assert.equal(
      crc32(Buffer.from(layout, "ascii")),
      parseInt(sig, 16),
      layout,
    );
  }
  // The designs the page describes, through the real serializer.
  const el = (id, kind, types) => ({
    id,
    kind,
    connection: "c",
    fields: types.map((type) => ({ type, name: type })),
  });
  const designs = [
    ["O0:8,O1:1,I0:16", [el("out1", "output", ["byte"]), el("out2", "output", ["bit"]), el("in1", "input", ["word"])]], // prettier-ignore
    ["O0:8+1,O1:1,I0:16", [el("out1", "output", ["byte", "bit"]), el("out2", "output", ["bit"]), el("in1", "input", ["word"])]], // prettier-ignore
    ["O0:1,I0:1+1+1+1", [el("in1", "input", ["bit", "bit", "bit", "bit"]), el("out3", "output", ["bit"])]], // prettier-ignore
    ["I0:16", [el("in4", "input", ["word"])]],
    ["", []],
  ];
  for (const [expected, elements] of designs) {
    assert.equal(layoutString(elements, "c"), expected);
    assert.equal(
      layoutSignature(elements, "c"),
      crc32(Buffer.from(expected, "ascii")),
    );
  }
  // Indices are decimal with no leading zero, Outputs first, by id number.
  const many = Array.from({ length: 11 }, (_, i) =>
    el(`out${11 - i}`, "output", ["bit"]),
  );
  assert.equal(
    layoutString([el("in1", "input", ["byte"]), ...many], "c"),
    `${Array.from({ length: 11 }, (_, i) => `O${i}:1`).join(",")},I0:8`,
  );
});
