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
// Tests for model/integration-codegen-python.js and model/integration-files.js
// — the Python module a connection gets when its language is Python, and the
// one place the language is read. Pinned here: the snake_case names from the
// shared identifier plan, what the module is written FROM (serial-wire.js,
// the layout signature), the example programs, and the design hash moving
// with the language. That the module RUNS and speaks the protocol is
// app/tests/serial-python-module.test.js's job, under python3 and the real
// MicroPython.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CIRCUITPYTHON_BOOT,
  CIRCUITPYTHON_MAIN,
  MICROPYTHON_MAIN,
  PYTHON_MODULE_FILE,
  PY_NAMING,
  generatePythonExamples,
  generatePythonModule,
  pyElementIdentifier,
  pyIdentifier,
} from "../model/integration-codegen-python.js";
import {
  EXAMPLE_FILE,
  HEADER_FILE,
  designHash,
  hashHex,
  planIdentifiers,
} from "../model/integration-codegen.js";
import { connectionFiles } from "../model/integration-files.js";
import { layoutSignature } from "../model/integration.js";
import {
  ACK_TIMEOUT_MS,
  MAX_SENDS,
  PROTOCOL_VERSION,
} from "../model/serial-wire.js";

const pico = {
  id: "pico",
  name: "Pico",
  baud: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  language: "python",
};

const el = (id, kind, name, fields) => ({
  id,
  kind,
  name,
  connection: "pico",
  fields,
});

const design = () => [
  el("out1", "output", "Digit", [
    { type: "byte", name: "value" },
    { type: "bit", name: "blank" },
  ]),
  el("in1", "input", "Segments", [{ type: "byte", name: "pattern" }]),
  el("in2", "input", "Buttons", [
    { type: "bit", name: "step" },
    { type: "bit", name: "reset" },
  ]),
];

test("pyIdentifier: snake_case, never a leading digit, idempotent", () => {
  assert.equal(pyIdentifier("Output 1"), "output_1");
  assert.equal(pyIdentifier("DataIn"), "data_in");
  assert.equal(pyIdentifier("LEDStrip"), "led_strip");
  assert.equal(pyIdentifier("7-seg"), "_7_seg");
  assert.equal(pyIdentifier("data_bus"), "data_bus");
  assert.equal(pyIdentifier("ça va"), "ca_va");
  assert.equal(pyIdentifier("日本", "out1"), "out1");
  for (const id of ["output_1", "data_in", "_7_seg"]) {
    assert.equal(pyIdentifier(id), id);
  }
});

test("names read from the board's side, as C++'s do: an Output arrives as _in, an Input leaves as _out", () => {
  assert.equal(pyElementIdentifier("Digit", "out1", "output"), "digit_in");
  assert.equal(pyElementIdentifier("Digit", "in1", "input"), "digit_out");
  assert.equal(pyElementIdentifier("Data In", "out1", "output"), "data_in");
  assert.equal(pyElementIdentifier("Result Out", "in1", "input"), "result_out");
});

test("the shared plan, in Python's spelling: keywords and duplicates are renamed AND reported", () => {
  const plan = planIdentifiers(
    "pico",
    [
      el("out1", "output", "Status", [{ type: "bit", name: "pass" }]),
      el("out2", "output", "status", [
        { type: "bit", name: "a" },
        { type: "bit", name: "a" },
      ]),
      el("in1", "input", "Status", [{ type: "byte", name: "link" }]),
    ],
    PY_NAMING,
  );
  assert.deepEqual(
    plan.outputs.map((o) => o.id),
    ["status_in", "status_in_2"],
  );
  assert.equal(plan.inputs[0].id, "status_out", "never the Output's name");
  assert.equal(plan.outputs[0].fields[0].param, "pass_");
  assert.equal(plan.inputs[0].fields[0].param, "link_");
  assert.equal(plan.inputs[0].fields[0].setter, "set_link");
  const found = plan.warnings.map((w) => `${w.code}:${w.name}→${w.identifier}`);
  assert.deepEqual(found.sort(), [
    "duplicate:a→a_2",
    "duplicate:status→status_in_2",
    "reserved:link→link_",
    "reserved:pass→pass_",
  ]);
});

test("a field named str is renamed — the example's handlers call str() on their parameters", () => {
  const els = [el("out1", "output", "Show", [{ type: "byte", name: "str" }])];
  const plan = planIdentifiers("pico", els, PY_NAMING);
  assert.equal(plan.outputs[0].fields[0].param, "str_");
  assert.deepEqual(
    plan.warnings.map((w) => `${w.code}:${w.name}→${w.identifier}`),
    ["reserved:str→str_"],
  );
  const [main] = generatePythonExamples({ connection: pico, elements: els });
  assert.ok(main.text.includes('link.print("Show:", "str_=" + str(str_))'));
});

test("the module registers Outputs by decorator, builds Inputs, and is written from serial-wire.js", () => {
  const { name, text, hash, signature, outputs, inputs } = generatePythonModule(
    {
      connection: pico,
      elements: design(),
      projectName: "Bench",
    },
  );
  assert.equal(name, PYTHON_MODULE_FILE);
  assert.equal(outputs, 1);
  assert.equal(inputs, 2);
  assert.equal(signature, layoutSignature(design(), "pico"));
  assert.ok(text.includes(`#   Design:   ${hashHex(hash)}`));
  assert.ok(text.includes(`LAYOUT_SIGNATURE = ${hashHex(signature)}`));
  assert.ok(text.includes(`PROTOCOL_VERSION = ${PROTOCOL_VERSION}`));
  assert.ok(text.includes(`ACK_TIMEOUT_MS = ${ACK_TIMEOUT_MS}`));
  assert.ok(text.includes(`MAX_SENDS = ${MAX_SENDS}`));
  assert.match(text, /^_START = 0x7E$/m);
  // The Output: a decorator, and its fields unpacked from the wire value.
  assert.match(text, /^ {4}def digit_in\(self, fn\):$/m);
  assert.ok(
    text.includes(
      '(9, "digit_in", lambda v: (v & 0xFF, ((v >> 8) & 1) != 0)),',
    ),
  );
  // The Inputs: a member each, a setter per field.
  assert.match(text, /self\.segments_out = _Input_segments_out\(self\)/);
  assert.match(text, /def set_pattern\(self, value\):/);
  assert.match(text, /def set_step\(self, on\):/);
  assert.match(text, /^link = _Link\(\)$/m);
  // The comment points at the example programs.
  for (const file of [
    MICROPYTHON_MAIN,
    CIRCUITPYTHON_MAIN,
    CIRCUITPYTHON_BOOT,
  ]) {
    assert.ok(text.includes(file), file);
  }
});

test("a user's text can never break out of a comment or a string", () => {
  const { text } = generatePythonModule({
    connection: { ...pico, name: "Evil\nimport os" },
    elements: [
      el("out1", "output", 'Say "hi"\\\nx', [{ type: "bit", name: "on" }]),
    ],
    projectName: "Line one\nos.remove('x')",
  });
  for (const line of text.split("\n")) {
    assert.ok(!/^import os/.test(line), line);
    assert.ok(!/^os\.remove/.test(line), line);
    assert.ok(!/^x/.test(line), line);
  }
  const [main] = generatePythonExamples({
    connection: pico,
    elements: [
      el("out1", "output", 'Say "hi"\\\nx', [{ type: "bit", name: "on" }]),
    ],
  });
  assert.ok(
    main.text.includes('link.print("Say \\"hi\\"\\\\ x:", "on=" + str(on))'),
    main.text,
  );
});

test("the examples: main.py and code.py are one program that RECEIVES, SENDS and LOGS; boot.py turns on CircuitPython's data port", () => {
  const files = generatePythonExamples({
    connection: pico,
    elements: design(),
  });
  assert.deepEqual(
    files.map((f) => f.name),
    [MICROPYTHON_MAIN, CIRCUITPYTHON_MAIN, CIRCUITPYTHON_BOOT],
  );
  const [main, code, boot] = files;
  const body = (t) => t.slice(t.indexOf("from chiphippo import"));
  assert.equal(body(main.text), body(code.text));
  assert.match(main.text, /an example MicroPython program/);
  assert.match(code.text, /an example CircuitPython program/);
  for (const label of ["RECEIVE", "SEND", "LOG"]) {
    assert.match(main.text, new RegExp(`^#   ${label} `, "m"), label);
  }
  assert.match(
    main.text,
    /^from chiphippo import link, ticks_diff, ticks_ms$/m,
  );

  // RECEIVE, logged.
  assert.match(
    main.text,
    /^@link\.digit_in {2}# the Output "Digit" arrives here$/m,
  );
  assert.match(main.text, /^def digit_in\(value, blank\):$/m);
  assert.ok(
    main.text.includes(
      'link.print("Digit:", "value=" + str(value), "blank=" + str(blank))',
    ),
  );

  // Every run starts with a log line and the Inputs' starting values.
  assert.match(
    main.text,
    /^@link\.on_connect\ndef run_started\(\):\n {4}global last_send, counter\n {4}link\.print\("Run started"\)/m,
  );
  assert.match(
    main.text,
    /link\.segments_out\.set_pattern\(0\)\n\s+link\.segments_out\.send\(\)/,
  );
  assert.match(main.text, /link\.buttons_out\.set_step\(False\)/);

  // SEND from the loop: the first Input's first field, a byte, counting.
  assert.match(main.text, /^SEND_EVERY_MS = 1000$/m);
  assert.match(
    main.text,
    /def send_next\(\):\n {4}global counter\n {4}counter = \(counter \+ 1\) % 256\n {4}link\.segments_out\.set_pattern\(counter\)\n {4}if link\.segments_out\.send\(\):\n {8}link\.print\("Sent Segments:", "pattern=" \+ str\(counter\)\)/,
  );
  assert.match(
    main.text,
    /link\.begin\(\)\nwhile True:\n {4}link\.poll\(\).*\n {4}if link\.connected\(\) and ticks_diff\(ticks_ms\(\), last_send\) >= SEND_EVERY_MS:\n {8}last_send = ticks_ms\(\)\n {8}send_next\(\)\n$/,
  );
  assert.match(boot.text, /usb_cdc\.enable\(console=True, data=True\)/);

  // main.py switches Ctrl-C off BEFORE importing the module (compiling it
  // takes a while on a board, and a HELLO may hold a 0x03); code.py talks over
  // CircuitPython's second port, which has no Ctrl-C to switch off.
  const off = main.text.indexOf("micropython.kbd_intr(-1)");
  assert.ok(off > 0 && off < main.text.indexOf("from chiphippo import"));
  assert.ok(!code.text.includes("kbd_intr"));
});

test("the module offers the example's clock: ticks_ms and ticks_diff", () => {
  const { text } = generatePythonModule({
    connection: pico,
    elements: design(),
  });
  assert.match(text, /^ticks_ms = _ticks_ms$/m);
  assert.match(text, /^ticks_diff = _ticks_diff$/m);
});

test("an example with no Inputs sends nothing but still logs a run's start", () => {
  const [main] = generatePythonExamples({
    connection: pico,
    elements: [design()[0]],
  });
  assert.match(main.text, /^from chiphippo import link$/m);
  assert.match(main.text, /@link\.on_connect\ndef run_started\(\):\n {4}link\.print\("Run started"\)/); // prettier-ignore
  for (const absent of ["send_next", "SEND_EVERY_MS", "ticks_ms", ".send()"]) {
    assert.ok(!main.text.includes(absent), absent);
  }
  assert.match(main.text, /this connection has no Inputs/);
});

test("a bit is toggled rather than counted, and an example without Outputs says where they would go", () => {
  const [main] = generatePythonExamples({
    connection: pico,
    elements: [design()[2]],
  });
  assert.match(main.text, /^level = False$/m);
  assert.match(main.text, /^ {4}level = not level$/m);
  assert.match(main.text, /this connection has no Outputs/);
  assert.ok(!/^@link\.\w+_in\b/m.test(main.text), "no Output to decorate");
});

test("the design hash moves with the language, and a C++ connection's is what it always was", () => {
  const cpp = { ...pico, language: "cpp" };
  const { language: _, ...unset } = pico;
  assert.notEqual(designHash(pico, design()), designHash(cpp, design()));
  assert.equal(designHash(cpp, design()), designHash(unset, design()));
});

test("connectionFiles: the language picks the files — C++ a header and a sketch, Python a module and three programs", () => {
  const cpp = connectionFiles({
    connection: { ...pico, language: "cpp" },
    elements: design(),
  });
  assert.equal(cpp.language, "cpp");
  assert.equal(cpp.main.name, HEADER_FILE);
  assert.deepEqual(
    cpp.files.map((f) => f.name),
    [HEADER_FILE, EXAMPLE_FILE],
  );
  assert.match(cpp.main.text, /void DigitIn\(uint8_t value, bool blank\);/);

  const py = connectionFiles({ connection: pico, elements: design() });
  assert.equal(py.language, "python");
  assert.equal(py.main.name, PYTHON_MODULE_FILE);
  assert.deepEqual(
    py.files.map((f) => f.name),
    [
      PYTHON_MODULE_FILE,
      MICROPYTHON_MAIN,
      CIRCUITPYTHON_MAIN,
      CIRCUITPYTHON_BOOT,
    ],
  );
  assert.equal(py.hash, designHash(pico, design()));
  assert.deepEqual(py.warnings, []);
});

test("a Python connection off 115200 baud, 8N1 is warned about — a USB-serial-chip board runs its REPL at exactly that", () => {
  const plain = generatePythonModule({ connection: pico, elements: design() });
  assert.deepEqual(plain.warnings, []);
  const slow = generatePythonModule({
    connection: { ...pico, baud: 9600 },
    elements: design(),
  });
  assert.deepEqual(slow.warnings, [
    { code: "python-framing", baud: 9600, format: "8N1" },
  ]);
  const odd = generatePythonModule({
    connection: { ...pico, parity: "even" },
    elements: design(),
  });
  assert.deepEqual(odd.warnings, [
    { code: "python-framing", baud: 115200, format: "8E1" },
  ]);
});
