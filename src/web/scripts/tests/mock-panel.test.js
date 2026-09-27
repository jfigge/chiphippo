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

// Tests for components/mock-panel.js — the send panel under the built-in
// Mock connection's window. Pinned: one row per Input in wire order, each
// field a line of its own under its name, a bit field as one toggle and a
// byte or word as bit toggles (grouped by byte) plus a hex field that stay in
// step, a value kept while the layout stays the same and sent WHOLE
// through the bridge, Send all in order, log text sent as a line, the faults
// armed and shown armed, and every control that needs a run disabled without
// one.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { MockPanel } = await import("../components/mock-panel.js");

const LAYOUT = {
  outputs: [{ name: "Bus", fields: [{ type: "byte", name: "addr" }] }],
  inputs: [
    {
      name: "Echo",
      fields: [
        { type: "byte", name: "data" },
        { type: "bit", name: "ready" },
      ],
    },
    { name: "Status", fields: [{ type: "bit", name: "a" }, { type: "bit", name: "b" }] }, // prettier-ignore
  ],
};

const settle = () => new Promise((r) => setTimeout(r, 0));

function mount(state = {}) {
  const win = resetDom();
  const calls = { send: [], log: [], fault: [] };
  let reply = { ok: true };
  const bridge = {
    serial: {
      mock: {
        send: async (...args) => {
          calls.send.push(args);
          return reply;
        },
        log: async (text) => {
          calls.log.push(text);
          return true;
        },
        fault: async (...args) => calls.fault.push(args),
      },
    },
  };
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const panel = new MockPanel(host, { bridge, state });
  const q = (sel) => host.querySelector(sel);
  const qa = (sel) => [...host.querySelectorAll(sel)];
  const row = (i) => q(`.mock-input[data-index="${i}"]`);
  const set = (node, value) => {
    node.value = value;
    node.dispatchEvent(new win.Event("change", { bubbles: true }));
  };
  return {
    win, host, panel, calls, q, qa, row, set,
    reply: (r) => (reply = r),
  }; // prettier-ignore
}

const running = { open: true, connected: true, faults: [], layout: LAYOUT };

test("before any run it says so, and nothing that needs one is enabled", () => {
  const { q, qa } = mount();
  assert.equal(
    q(".mock-status").textContent,
    "Not running. The Mock connects when you press Run.",
  );
  assert.equal(
    q(".mock-inputs").textContent,
    "Run the circuit to see the Mock's Inputs here.",
  );
  assert.equal(qa(".mock-input").length, 0);
  assert.equal(q(".mock-send-all").disabled, true, "Send all");
  assert.equal(q(".mock-log-input").disabled, true);
  assert.equal(q(".mock-log-row button").disabled, true);
});

test("one row per Input, in wire order, its fields drawn by type", () => {
  const { qa, row } = mount(running);
  assert.deepEqual(
    qa(".mock-input-name").map((n) => n.textContent),
    ["Echo", "Status"],
  );
  // Echo: a byte (eight toggles, MSB first, and a hex field) then a bit.
  const echo = row(0);
  assert.equal(echo.querySelectorAll(".mock-field--byte .mock-bit").length, 8);
  assert.equal(echo.querySelector(".mock-hex").value, "0x00");
  assert.equal(echo.querySelectorAll(".mock-field--byte .mock-byte").length, 1);
  assert.equal(
    echo.querySelector(".mock-field--bit .mock-field-name").textContent,
    "ready",
  );
  assert.equal(
    echo.querySelector(".mock-field--bit .mock-bit").textContent,
    "0",
  );
  // One line per field, each under its own name.
  assert.deepEqual(
    [...row(1).querySelectorAll(".mock-field > .mock-field-name")].map(
      (n) => n.textContent,
    ),
    ["a", "b"],
  );
  assert.equal(row(1).querySelectorAll(".mock-field--bit .mock-bit").length, 2);
  // The result sits before Send, so Send keeps the right edge.
  const send = echo.querySelector(".mock-send");
  assert.equal(send.previousElementSibling.className, "mock-result");
  assert.equal(send.nextElementSibling, null);
});

test("a word's bits come in two bytes, MSB first", () => {
  const { row } = mount({
    ...running,
    layout: { outputs: [], inputs: [{ name: "W", fields: [{ type: "word", name: "w" }] }] }, // prettier-ignore
  });
  const bytes = [...row(0).querySelectorAll(".mock-byte")];
  assert.deepEqual(
    bytes.map((b) => b.querySelectorAll(".mock-bit").length),
    [8, 8],
  );
  assert.equal(bytes[0].firstElementChild.title, "w, bit 15");
  assert.equal(bytes[1].lastElementChild.title, "w, bit 0");
});

test("a caret folds an Input down to its name and Send, and it stays folded", async () => {
  const { panel, calls, row } = mount(running);
  const toggle = () => row(0).querySelector(".mock-input-toggle");
  const fields = () => row(0).querySelector(".mock-fields");
  assert.equal(toggle().getAttribute("aria-expanded"), "true");
  assert.equal(fields().hidden, false);
  toggle().click();
  assert.equal(toggle().getAttribute("aria-expanded"), "false");
  assert.equal(fields().hidden, true);
  assert.equal(row(1).querySelector(".mock-fields").hidden, false, "only it");
  row(0).querySelector(".mock-send").click(); // still sends what it holds
  await settle();
  assert.deepEqual(calls.send, [[0, 9, 0]]);
  // A new layout redraws the rows; the same Input comes back folded.
  panel.setState({ ...running, layout: { outputs: [], inputs: [LAYOUT.inputs[0]] } }); // prettier-ignore
  assert.equal(fields().hidden, true);
  toggle().click();
  assert.equal(fields().hidden, false);
});

test("bit toggles and the hex field stay in step, and make the whole value", () => {
  const { panel, row, set } = mount(running);
  const bits = () => [
    ...row(0).querySelectorAll(".mock-field--byte .mock-bit"),
  ];
  set(row(0).querySelector(".mock-hex"), "0x65");
  assert.equal(panel.value(0), 0x65);
  assert.deepEqual(
    bits()
      .map((b) => b.textContent)
      .join(""),
    "01100101",
    "the toggles follow the hex",
  );
  bits()[0].click(); // bit 7
  assert.equal(panel.value(0), 0xe5);
  assert.equal(row(0).querySelector(".mock-hex").value, "0xE5");
  row(0).querySelector(".mock-field--bit .mock-bit").click(); // ready = bit 8
  assert.equal(panel.value(0), 0x1e5);
  set(row(0).querySelector(".mock-hex"), "nonsense");
  assert.equal(row(0).querySelector(".mock-hex").value, "0xE5", "put back");
  assert.equal(panel.value(0), 0x1e5);
});

test("Send sends the Input's whole value with its index and width", async () => {
  const { calls, row, set, reply } = mount(running);
  set(row(0).querySelector(".mock-hex"), "0x2A");
  row(0).querySelector(".mock-send").click();
  await settle();
  assert.deepEqual(calls.send, [[0, 9, 0x2a]]);
  assert.equal(row(0).querySelector(".mock-result").textContent, "Sent");
  reply({ ok: false, code: "delivery" });
  row(1).querySelector(".mock-send").click();
  await settle();
  assert.equal(
    row(1).querySelector(".mock-result").textContent,
    "Not acknowledged",
  );
});

test("'Sent' clears itself after a second; a failure stays", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = () => new Promise((r) => setImmediate(r));
  const { row, reply } = mount(running);
  const send = () => row(0).querySelector(".mock-send").click();
  const result = () => row(0).querySelector(".mock-result").textContent;
  send();
  await flush();
  assert.equal(result(), "Sent");
  t.mock.timers.tick(999);
  assert.equal(result(), "Sent");
  t.mock.timers.tick(1);
  assert.equal(result(), "");
  // A failure inside the second is not wiped by the earlier "Sent"'s timer.
  send();
  await flush();
  t.mock.timers.tick(500);
  reply({ ok: false, code: "delivery" });
  send();
  await flush();
  t.mock.timers.tick(5000);
  assert.equal(result(), "Not acknowledged");
});

test("Send all sends every row, in order", async () => {
  const { calls, q, row } = mount(running);
  row(1).querySelectorAll(".mock-field--bit .mock-bit")[1].click(); // b = bit 1
  q(".mock-send-all").click();
  await settle();
  await settle();
  assert.deepEqual(calls.send, [
    [0, 9, 0],
    [1, 2, 2],
  ]);
});

test("Send all shows only with two or more Inputs", () => {
  const { panel, q } = mount(running);
  assert.equal(q(".mock-send-all").hidden, false);
  panel.setState({ ...running, layout: { outputs: [], inputs: [LAYOUT.inputs[0]] } }); // prettier-ignore
  assert.equal(q(".mock-send-all").hidden, true);
  panel.setState({ ...running, layout: { outputs: [], inputs: [] } });
  assert.equal(q(".mock-send-all").hidden, true);
});

test("values survive a new state with the same layout, and not a new layout", () => {
  const { panel, row, set } = mount(running);
  set(row(0).querySelector(".mock-hex"), "0x11");
  panel.setState({ ...running, connected: false });
  assert.equal(panel.value(0), 0x11);
  assert.equal(row(0).querySelector(".mock-send").disabled, true);
  panel.setState({
    ...running,
    layout: { outputs: [], inputs: [LAYOUT.inputs[1]] },
  });
  assert.equal(panel.value(0), 0);
});

test("with no Inputs on the Mock it says so", () => {
  const { q } = mount({ ...running, layout: { outputs: [], inputs: [] } });
  assert.equal(
    q(".mock-inputs").textContent,
    "The Mock has no Inputs on this desktop.",
  );
  assert.equal(q(".mock-send-all").disabled, true);
});

test("log text goes as a line, and the field clears", async () => {
  const { calls, q, win } = mount({ ...running, connected: false });
  const input = q(".mock-log-input");
  input.value = "hello";
  input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter" }));
  await settle();
  assert.deepEqual(calls.log, ["hello\n"]);
  assert.equal(input.value, "");
});

test("the log field hides with the Log filter, and comes back with it", () => {
  const { panel, q } = mount(running);
  assert.equal(q(".mock-log-row").hidden, false);
  panel.setLogShown(false);
  assert.equal(q(".mock-log-row").hidden, true);
  assert.ok(q(".mock-faults"), "the faults stay");
  panel.setLogShown(true);
  assert.equal(q(".mock-log-row").hidden, false);
});

test("a fault is armed through the bridge and shown armed until spent", async () => {
  const { panel, calls, qa } = mount(running);
  const button = (name) =>
    qa(".mock-fault").find((b) => b.dataset.fault === name);
  assert.deepEqual(
    qa(".mock-fault").map((b) => b.textContent),
    [
      "Drop next ACK",
      "Corrupt next frame",
      "Ignore handshake",
      "Wrong signature",
    ],
  );
  button("corrupt").click();
  await settle();
  assert.deepEqual(calls.fault, [["corrupt", true]]);
  panel.setState({ ...running, faults: ["corrupt"] });
  assert.equal(button("corrupt").getAttribute("aria-pressed"), "true");
  button("corrupt").click();
  await settle();
  assert.deepEqual(calls.fault.at(-1), ["corrupt", false]);
  panel.setState({ ...running, faults: [] });
  assert.equal(button("corrupt").getAttribute("aria-pressed"), "false");
});
