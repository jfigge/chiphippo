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

// Tests for model/integration-codegen.js — the design hash (what changes it
// and what must not), C identifiers and their reported collisions, and the
// shape of the generated header: its protocol numbers written FROM
// serial-wire.js, its layout signature FROM integration.js's one function.
// That the header actually COMPILES and speaks the protocol is
// app/tests/serial-arduino-header.test.js's job.

import test from "node:test";
import assert from "node:assert/strict";

import {
  EXAMPLE_FILE,
  cIdentifier,
  designHash,
  elementIdentifier,
  fnv1a32,
  generateExample,
  generateHeader,
  hashHex,
  planIdentifiers,
  serialConfigConstant,
} from "../model/integration-codegen.js";
import { layoutSignature } from "../model/integration.js";
import {
  ACK_TIMEOUT_MS,
  FRAME,
  MAX_SENDS,
  PROTOCOL_VERSION,
} from "../model/serial-wire.js";

const nano = {
  id: "nano",
  name: "Nano",
  baud: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
};

const el = (id, kind, name, fields, extra = {}) => ({
  id,
  kind,
  name,
  connection: "nano",
  color: "red",
  triggerEdge: "rising",
  triggerInit: "low",
  fields,
  ...extra,
});

const design = () => [
  el("out1", "output", "Output 1", [
    { type: "byte", name: "data" },
    { type: "bit", name: "strobe" },
  ]),
  el("in1", "input", "Input 1", [{ type: "word", name: "value" }]),
  el("out2", "output", "Other", [{ type: "bit", name: "x" }], {
    connection: "uno",
  }),
];

test("FNV-1a is the standard 32-bit one", () => {
  assert.equal(fnv1a32(""), 0x811c9dc5);
  assert.equal(fnv1a32("a"), 0xe40c292c);
  assert.equal(hashHex(0x1a2b), "0x00001A2B");
});

test("the hash moves with names, fields, order and serial settings", () => {
  const base = designHash(nano, design());
  const renamed = design();
  renamed[0].name = "Bus";
  assert.notEqual(designHash(nano, renamed), base);
  const refield = design();
  refield[0].fields[1].name = "clk";
  assert.notEqual(designHash(nano, refield), base);
  const retyped = design();
  retyped[1].fields = [{ type: "byte", name: "value" }];
  assert.notEqual(designHash(nano, retyped), base);
  assert.notEqual(designHash({ ...nano, baud: 9600 }, design()), base);
  assert.notEqual(designHash({ ...nano, name: "Uno" }, design()), base);
});

test("the hash ignores what the sketch cannot see", () => {
  const base = designHash(nano, design());
  const cosmetic = design();
  cosmetic[0].color = "blue";
  cosmetic[0].triggerEdge = "falling";
  cosmetic[0].tags = { 1: { anchor: "bb1.a1", rot: 0 } };
  cosmetic[0].description = "notes";
  assert.equal(designHash(nano, cosmetic), base);
  // Another connection's elements are another header's business.
  const elsewhere = design();
  elsewhere[2].name = "Renamed";
  assert.equal(designHash(nano, elsewhere), base);
  // The port is a fact about THIS machine, not about the sketch.
  assert.equal(designHash({ ...nano, port: "/dev/x" }, design()), base);
});

test("cIdentifier keeps letters, digits and underscores, never a leading digit", () => {
  assert.equal(cIdentifier("Output 1"), "Output1");
  assert.equal(cIdentifier("7-seg"), "_7seg");
  assert.equal(cIdentifier("ça va"), "cava");
  assert.equal(cIdentifier("日本", "in1"), "in1");
  assert.equal(cIdentifier("data_bus"), "data_bus");
});

test("names read from the Arduino's side: an Output arrives as <name>In, an Input leaves as <name>Out — never doubled", () => {
  assert.equal(elementIdentifier("Digit", "out1", "output"), "DigitIn");
  assert.equal(elementIdentifier("Digit", "in1", "input"), "DigitOut");
  assert.equal(elementIdentifier("Data In", "out1", "output"), "DataIn");
  assert.equal(elementIdentifier("Pin", "out1", "output"), "PinIn");
  assert.equal(elementIdentifier("Result Out", "in1", "input"), "ResultOut");
  assert.equal(elementIdentifier("7-seg", "out1", "output"), "_7segIn");
  assert.equal(elementIdentifier("日本", "out1", "output"), "out1In");
});

test("an Output and an Input of one name never collide; what does is renamed AND reported", () => {
  const els = [
    el("out1", "output", "Output", [{ type: "bit", name: "delay" }]),
    el("out2", "output", "Output!", [
      { type: "bit", name: "a" },
      { type: "bit", name: "a" },
    ]),
    el("out3", "output", "loop", [{ type: "bit", name: "b" }]),
    el("in1", "input", "poll", [{ type: "bit", name: "x" }]),
    el("in2", "input", "Output", [{ type: "bit", name: "y" }]),
  ];
  const plan = planIdentifiers("nano", els);
  assert.deepEqual(
    plan.outputs.map((o) => o.id),
    ["OutputIn", "OutputIn_2", "loopIn"],
    "a keyword is no longer one once suffixed",
  );
  assert.equal(plan.outputs[0].fields[0].param, "delay_");
  assert.deepEqual(
    plan.outputs[1].fields.map((f) => f.param),
    ["a", "a_2"],
  );
  assert.deepEqual(
    plan.inputs.map((i) => i.id),
    ["pollOut", "OutputOut"],
    "the Input called Output is OutputOut — nothing to rename",
  );
  const found = plan.warnings.map((w) => `${w.code}:${w.name}→${w.identifier}`);
  assert.deepEqual(found.sort(), [
    "duplicate:Output!→OutputIn_2",
    "duplicate:a→a_2",
    "reserved:delay→delay_",
  ]);
});

test("setters are named after their field", () => {
  const plan = planIdentifiers("nano", design());
  assert.equal(plan.inputs[0].fields[0].setter, "setValue");
});

test("the header declares Outputs, builds Inputs, and carries the hash", () => {
  const { text, hash, signature, outputs, inputs } = generateHeader({
    connection: nano,
    elements: design(),
    projectName: "Demo",
    desktopName: "Desktop 1",
  });
  assert.equal(outputs, 1, "only this connection's elements");
  assert.equal(inputs, 1);
  assert.match(text, /void Output1In\(uint8_t data, bool strobe\);/);
  assert.match(text, /class ChipHippo_Input1Out \{/);
  assert.match(text, /void setValue\(uint16_t v\)/);
  assert.match(text, /ChipHippo_Input1Out Input1Out;/);
  assert.match(text, /void onConnect\(void \(\*fn\)\(\)\)/);
  assert.ok(text.includes(EXAMPLE_FILE), "the header points at the example");
  assert.ok(text.includes(`//   Design:   ${hashHex(hash)}`));
  assert.equal(signature, layoutSignature(design(), "nano"));
  assert.ok(
    text.includes(`#define CHIPHIPPO_LAYOUT_SIGNATURE ${hashHex(signature)}UL`),
  );
  assert.ok(text.includes(`(O0:8+1,I0:16)`), "the layout, spelled out");
  assert.match(text, /#define CHIPHIPPO_BAUD 115200UL/);
  assert.match(text, /Serial\.begin\(baud\);/);
  assert.ok(!text.includes("Other"), "another connection's Output is absent");
  // The dispatcher unpacks by field: data from bits 0-7, strobe from bit 8.
  assert.match(
    text,
    /if \(width == 9\) Output1In\(\(uint8_t\)\(v & 0xFFu\), \(\(\(v >> 8\) & 1u\) != 0\)\);/,
  );
});

test("every protocol number is written from serial-wire.js, never typed here", () => {
  const { text } = generateHeader({ connection: nano, elements: design() });
  const hex = (n) => `0x${n.toString(16).toUpperCase().padStart(2, "0")}`;
  assert.ok(
    text.includes(`#define CHIPHIPPO_PROTOCOL_VERSION ${PROTOCOL_VERSION}\n`),
  );
  assert.ok(
    text.includes(`#define CHIPHIPPO_ACK_TIMEOUT_MS ${ACK_TIMEOUT_MS}UL`),
  );
  assert.ok(text.includes(`#define CHIPHIPPO_MAX_SENDS ${MAX_SENDS}\n`));
  for (const [name, value] of Object.entries(FRAME)) {
    assert.ok(text.includes(`F_${name} = ${hex(value)}`), name);
  }
});

test("a rename moves the design hash but never the layout signature", () => {
  const renamed = design();
  renamed[0].name = "Bus";
  assert.equal(
    layoutSignature(renamed, "nano"),
    layoutSignature(design(), "nano"),
  );
  assert.notEqual(designHash(nano, renamed), designHash(nano, design()));
});

test("a user's text can never break out of a comment", () => {
  const els = [
    el("out1", "output", "evil */\nint x = 1; //", [
      { type: "bit", name: "a" },
    ]),
  ];
  const { text } = generateHeader({
    connection: { ...nano, name: "a\nb" },
    elements: els,
    projectName: "p\r\nq",
  });
  for (const line of text.split("\n")) {
    assert.ok(!/^int x/.test(line), line);
  }
});

test("non-default framing becomes a SERIAL_ constant; 1.5 stop bits is reported", () => {
  assert.equal(serialConfigConstant(nano), null);
  assert.equal(
    serialConfigConstant({ ...nano, dataBits: 7, parity: "even" }),
    "SERIAL_7E1",
  );
  assert.equal(serialConfigConstant({ ...nano, stopBits: 1.5 }), undefined);
  const r = generateHeader({
    connection: { ...nano, stopBits: 1.5 },
    elements: design(),
  });
  assert.ok(r.warnings.some((w) => w.code === "serial-config"));
  const e = generateHeader({
    connection: { ...nano, dataBits: 7, parity: "even" },
    elements: design(),
  });
  assert.match(e.text, /Serial\.begin\(baud, SERIAL_7E1\);/);
});

test("a connection with no elements still makes a valid (empty) header", () => {
  const r = generateHeader({ connection: nano, elements: [] });
  assert.equal(r.outputs, 0);
  assert.match(r.text, /this connection has no Outputs/);
  assert.match(r.text, /this connection has no Inputs/);
});

test("the example RECEIVES (a logging function per Output), SENDS (starting values, then a counter from loop()) and LOGS", () => {
  const { name, text } = generateExample({
    connection: nano,
    elements: design(),
  });
  assert.equal(name, EXAMPLE_FILE);
  assert.match(text, /#include "ChipHippo\.h"/);
  for (const label of ["RECEIVE", "SEND", "LOG"]) {
    assert.match(text, new RegExp(`^//   ${label} `, "m"), `explains ${label}`);
  }
  assert.ok(text.includes("Never use Serial"), "and what not to log with");

  // RECEIVE, logged.
  assert.match(text, /void Output1In\(uint8_t data, bool strobe\) \{/);
  assert.ok(text.includes('ChipHippo.print("Output 1: data=");'));
  assert.ok(text.includes('ChipHippo.print(" strobe=");'));

  // Every run starts with a log line and the Inputs' starting values.
  assert.match(
    text,
    /void runStarted\(\) \{\n {2}ChipHippo\.println\("Run started"\);/,
  );
  assert.match(
    text,
    /ChipHippo\.Input1Out\.setValue\(0\);\n\s*ChipHippo\.Input1Out\.send\(\);/,
  );
  assert.match(
    text,
    /ChipHippo\.onConnect\(runStarted\);\n\s*ChipHippo\.begin\(\);/,
  );

  // SEND from loop(): the first Input's first field, counting in its own type.
  assert.match(text, /^const unsigned long SEND_EVERY_MS = 1000;$/m);
  assert.match(text, /^uint16_t counter = 0;$/m, "a word counts in a word");
  assert.match(
    text,
    /void sendNext\(\) \{\n {2}counter\+\+;\n {2}ChipHippo\.Input1Out\.setValue\(counter\);\n {2}if \(ChipHippo\.Input1Out\.send\(\)\) \{\n {4}ChipHippo\.print\("Sent Input 1: value="\);/,
  );
  assert.match(
    text,
    /void loop\(\) \{\n {2}ChipHippo\.poll\(\);.*\n {2}if \(ChipHippo\.connected\(\) && millis\(\) - lastSend >= SEND_EVERY_MS\) \{\n {4}lastSend = millis\(\);\n {4}sendNext\(\);/,
  );
  assert.ok(!text.includes("Other"), "another connection's Output is absent");
});

test("a bit is toggled rather than counted, and an example without Outputs says where they would go", () => {
  const { text } = generateExample({
    connection: nano,
    elements: [
      el("in1", "input", "Dips", [
        { type: "bit", name: "dip1" },
        { type: "bit", name: "dip2" },
      ]),
    ],
  });
  assert.match(text, /^bool level = false;$/m);
  assert.match(text, /^ {2}level = !level;\n {2}ChipHippo\.DipsOut\.setDip1\(level\);$/m); // prettier-ignore
  assert.match(text, /this connection has no Outputs/);
  assert.ok(!/void \w+In\(/.test(text), "no Output function to declare");
});

test("an example with no Inputs sends nothing but still logs a run's start, and a name cannot break its code", () => {
  const { text } = generateExample({
    connection: nano,
    elements: [
      el("out1", "output", 'Say "hi"\\??=\nx', [{ type: "bit", name: "on" }]),
    ],
  });
  assert.match(text, /ChipHippo\.onConnect\(runStarted\);/);
  assert.ok(text.includes('ChipHippo.println("Run started");'));
  for (const absent of ["sendNext", "SEND_EVERY_MS", "millis", ".send()"]) {
    assert.ok(!text.includes(absent), absent);
  }
  assert.match(text, /this connection has no Inputs/);
  assert.ok(
    text.includes('ChipHippo.print("Say \\"hi\\"\\\\?\\?= x: on=");'),
    text,
  );
  for (const line of text.split("\n")) {
    assert.ok(!/^x/.test(line), `a name broke onto a line of its own: ${line}`);
  }
});
