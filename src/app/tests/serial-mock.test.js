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
 * tests/serial-mock.test.js — the built-in Mock connection
 * (docs/chiphippo-mock-connection.md). The real host SerialLink is driven
 * against the MockDevice through the same byte-level port a USB cable is
 * adapted to — so every test here is also a test of the host stack: the
 * handshake, an Output acknowledged and reported once, an Input and log text
 * delivered, and each one-shot fault exercising the path it exists for. Then
 * the manager: the Mock needs no settings and no port, and its log records
 * every value that crosses it.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FRAME,
  FrameDecoder,
  encodeFrame,
  decodeHello,
} = require("../serial/protocol");
const { SerialLink } = require("../serial/link");
const { MockDevice, FAULTS } = require("../serial/mock-device");
const { SerialManager, MOCK_ID } = require("../serial/serial-manager");

const SIGNATURE = 0x0badcafe;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A MockDevice and a link over its port. `wire` sees every frame the mock
 * sends (decoded), so a test can tell a damaged one went out.
 */
function rig({ timeoutMs = 30, faults = [], drop } = {}) {
  const events = { output: [], input: [], state: [], inbound: [], logs: [] };
  const mock = new MockDevice({
    timeoutMs,
    onEvent: (kind, data) => events[kind].push(data),
  });
  for (const f of faults) mock.arm(f, true);
  const port = mock.openPort({ signature: SIGNATURE });
  if (drop) {
    // Lose what the host writes, frame by frame, when `drop(frame)` says so.
    const write = port.write;
    const hostFrames = new FrameDecoder();
    port.write = (buf) => {
      for (const f of hostFrames.push(buf)) {
        if (!drop(f)) write(encodeFrame(f));
      }
    };
  }
  const sent = []; // every frame the mock put on the wire, as the host saw it
  const decoder = new FrameDecoder();
  const onData = port.onData;
  port.onData = (cb) =>
    onData((chunk) => {
      sent.push(...decoder.push(chunk));
      cb(chunk);
    });
  const link = new SerialLink({
    port,
    timeoutMs,
    helloTimeoutMs: 200,
    helloIntervalMs: 20,
    onInbound: (d) => events.inbound.push(d),
    onLog: (t) => events.logs.push(t),
  });
  return { mock, link, events, sent };
}

async function greeted(opts) {
  const r = rig(opts);
  const hs = await r.link.handshake(SIGNATURE);
  assert.equal(hs.ok, true, JSON.stringify(hs));
  return r;
}

test("the Mock answers the handshake with protocol v1 and the design's own signature", async () => {
  const { mock, link, sent } = rig();
  const r = await link.handshake(SIGNATURE);
  assert.deepEqual(r, {
    ok: true,
    device: { version: 1, signature: SIGNATURE },
  });
  assert.equal(mock.state.connected, true);
  // Opening the port was a reset: the start was announced (session 0) first.
  assert.equal(sent[0].type, FRAME.HELLO_ACK);
  assert.deepEqual(decodeHello(sent[0].payload), {
    version: 1,
    session: 0,
    signature: SIGNATURE,
  });
  await link.close();
  assert.deepEqual(mock.state, { open: false, connected: false, faults: [] });
});

test("an Output is acknowledged at once and reported once", async () => {
  const { link, events } = await greeted();
  assert.deepEqual(await link.send(1, 9, 0x1a5), { ok: true });
  assert.deepEqual(await link.send(0, 1, 1), { ok: true });
  assert.deepEqual(events.output, [
    { index: 1, width: 9, value: 0x1a5 },
    { index: 0, width: 1, value: 1 },
  ]);
  await link.close();
});

test("an Input value reaches the host, and resolves once acknowledged", async () => {
  const { mock, link, events } = await greeted();
  assert.deepEqual(await mock.sendInput(0, 8, 0x65), { ok: true });
  assert.deepEqual(await mock.sendInput(2, 16, 0xbeef), { ok: true });
  assert.deepEqual(events.inbound, [
    { index: 0, width: 8, value: 0x65 },
    { index: 2, width: 16, value: 0xbeef },
  ]);
  assert.deepEqual(events.input, events.inbound, "each reported as sent");
  await link.close();
});

test("before a run greets it, or after it ends, the Mock sends nothing", async () => {
  const idle = new MockDevice();
  assert.deepEqual(await idle.sendInput(0, 1, 1), {
    ok: false,
    code: "offline",
  });
  assert.equal(idle.log("x"), false);
  const { mock, link } = rig();
  assert.deepEqual(await mock.sendInput(0, 1, 1), {
    ok: false,
    code: "offline",
  });
  await link.handshake(SIGNATURE);
  await link.close();
  assert.deepEqual(await mock.sendInput(0, 1, 1), {
    ok: false,
    code: "offline",
  });
});

test("log text arrives whole, never split inside a character", async () => {
  const { mock, link, events, sent } = await greeted();
  const line = `a${"é".repeat(40)}\n`;
  assert.equal(mock.log(line), true);
  await sleep(10);
  assert.equal(events.logs.join(""), line);
  const logs = sent.filter((f) => f.type === FRAME.LOG);
  assert.ok(logs.length >= 2, "it really was cut");
  for (const f of logs) {
    assert.deepEqual(
      Buffer.from(f.payload.toString("utf8"), "utf8"),
      f.payload,
    );
  }
  await link.close();
});

test("drop-ack: the host times out, resends, and the Output is still reported once", async () => {
  const { mock, link, events } = await greeted({ faults: ["drop-ack"] });
  assert.deepEqual(mock.state.faults, ["drop-ack"]);
  assert.deepEqual(await link.send(0, 8, 7), { ok: true });
  assert.equal(events.output.length, 1);
  assert.deepEqual(mock.state.faults, [], "one-shot: spent");
  await link.close();
});

test("corrupt: a damaged Input is NAKed by the host and resent", async () => {
  const { mock, link, events, sent } = await greeted({
    faults: ["corrupt"],
    timeoutMs: 5000,
  });
  const started = Date.now();
  assert.deepEqual(await mock.sendInput(0, 8, 0x42), { ok: true });
  assert.ok(Date.now() - started < 1000, "the NAK, not the timeout");
  assert.deepEqual(events.inbound, [{ index: 0, width: 8, value: 0x42 }]);
  assert.ok(
    sent.some((f) => !f.ok),
    "a damaged frame really went out",
  );
  await link.close();
});

test("corrupt: a damaged ACK is covered by the host's resend", async () => {
  const { link, events, sent } = await greeted({ faults: ["corrupt"] });
  assert.deepEqual(await link.send(0, 1, 1), { ok: true });
  assert.equal(events.output.length, 1);
  assert.ok(sent.some((f) => !f.ok && f.type === FRAME.ACK));
  await link.close();
});

test("ignore-hello: the next run's handshake goes unanswered — once", async () => {
  const { mock, link } = rig({ faults: ["ignore-hello"] });
  assert.deepEqual(await link.handshake(SIGNATURE), {
    ok: false,
    code: "no-response",
  });
  assert.deepEqual(mock.state.faults, [], "spent by that run");
  await link.close();
});

test("wrong-signature: the next HELLO is answered for another layout, and not joined", async () => {
  const { mock, link } = rig({ faults: ["wrong-signature"] });
  const r = await link.handshake(SIGNATURE);
  assert.equal(r.ok, false);
  assert.equal(r.code, "signature");
  assert.notEqual(r.device.signature, SIGNATURE);
  assert.equal(mock.state.connected, false, "the mock stays out of it too");
  await link.close();
});

test("a run for another layout is answered with the mock's own, and never joined", async () => {
  const { mock, link } = rig();
  const r = await link.handshake(0x12345678);
  assert.equal(r.code, "signature");
  assert.equal(r.device.signature, SIGNATURE, "its own layout, not the host's");
  assert.equal(mock.state.connected, false);
  assert.deepEqual(await mock.sendInput(0, 1, 1), {
    ok: false,
    code: "offline",
  });
  await link.close();
});

test("an Input nobody acknowledges takes the Mock out of the session — it says so — until the next one", async () => {
  let deaf = false;
  const { mock, link, sent } = await greeted({
    drop: (f) => deaf && f.type === FRAME.ACK,
  });
  deaf = true; // the host stops acknowledging, without a word
  assert.deepEqual(await mock.sendInput(0, 1, 1), {
    ok: false,
    code: "delivery",
  });
  assert.equal(mock.state.connected, false, "offline");
  await sleep(5);
  const last = sent.at(-1);
  assert.equal(last.type, FRAME.HELLO_ACK);
  assert.equal(decodeHello(last.payload).session, 0, "announced, as at start");
  assert.deepEqual(
    await link.send(0, 1, 1),
    { ok: false, code: "restart" },
    "so the host has stopped too",
  );
  const started = Date.now();
  assert.deepEqual(await mock.sendInput(0, 1, 1), {
    ok: false,
    code: "offline",
  });
  assert.ok(Date.now() - started < 20, "and fails at once, not after 3 sends");
  // A new session greets it again.
  deaf = false;
  assert.equal((await link.handshake(SIGNATURE)).ok, true);
  assert.deepEqual(await mock.sendInput(0, 1, 1), { ok: true });
  await link.close();
});

test("faults are named, armed and disarmed, and survive between runs", () => {
  const mock = new MockDevice();
  assert.deepEqual(FAULTS, [
    "drop-ack",
    "corrupt",
    "ignore-hello",
    "wrong-signature",
  ]);
  assert.equal(mock.arm("nonsense", true), false);
  mock.arm("corrupt", true);
  mock.arm("wrong-signature", true);
  mock.arm("corrupt", false);
  assert.deepEqual(mock.state.faults, ["wrong-signature"]);
  mock.openPort().close();
  assert.deepEqual(mock.state.faults, ["wrong-signature"]);
});

// ── The manager ─────────────────────────────────────────────────────────────

function manager(connections = []) {
  const events = [];
  const m = new SerialManager({
    connections: () => connections,
    listPorts: async () => {
      throw new Error("the Mock must not need a port scan");
    },
    openPort: async () => {
      throw new Error("the Mock must not open a real port");
    },
    emit: (event, payload) => events.push({ event, ...payload }),
    mockTimeoutMs: 30,
  });
  return { m, events };
}

const LAYOUT = {
  outputs: [
    {
      name: "Bus",
      fields: [
        { type: "byte", name: "addr" },
        { type: "bit", name: "rw" },
      ],
    },
  ],
  inputs: [{ name: "Echo", fields: [{ type: "byte", name: "data" }] }],
};

test("the manager opens the Mock with no settings entry and no port", async () => {
  const { m } = manager();
  assert.equal(m.connection(MOCK_ID).name, "Mock");
  const r = await m.open([{ id: MOCK_ID, signature: 7, layout: LAYOUT }]);
  assert.deepEqual(r, { ok: true });
  assert.equal(m.mockState().open, true);
  assert.equal(m.mockState().connected, true);
  assert.deepEqual(m.mockState().layout, LAYOUT);
  await m.close();
  assert.equal(m.mockState().open, false);
});

test("a settings entry can never stand in for the Mock", () => {
  const { m } = manager([{ id: MOCK_ID, name: "Impostor", port: "/dev/x" }]);
  assert.equal(m.connection(MOCK_ID).name, "Mock");
  assert.equal(m.connection(MOCK_ID).mock, true);
});

test("every value crossing the Mock is a DATA line in its stream, element named", async () => {
  const { m, events } = manager();
  await m.open([{ id: MOCK_ID, signature: 7, layout: LAYOUT }]);
  assert.deepEqual(await m.send(MOCK_ID, 0, 9, 0x13f), { ok: true });
  assert.deepEqual(await m.mockSend(0, 8, 0x65), { ok: true });
  await sleep(10);
  const data = m.logRead(MOCK_ID).entries.filter((e) => e.kind === "data");
  assert.deepEqual(
    data.map(({ dir, index, width, value, element }) => ({ dir, index, width, value, element })), // prettier-ignore
    [
      { dir: "out", index: 0, width: 9, value: 0x13f, element: LAYOUT.outputs[0] }, // prettier-ignore
      { dir: "in", index: 0, width: 8, value: 0x65, element: LAYOUT.inputs[0] }, // prettier-ignore
    ],
  );
  assert.ok(
    events.some((e) => e.event === "inbound" && e.id === MOCK_ID),
    "and the Input reached the run like a board's",
  );
  assert.ok(events.some((e) => e.event === "mock" && e.connected));
  await m.close();
});

test("a fault shows in the Mock's stream as the error it causes", async () => {
  const { m } = manager();
  m.mockFault("drop-ack", true);
  await m.open([{ id: MOCK_ID, signature: 7, layout: LAYOUT }]);
  assert.deepEqual(await m.send(MOCK_ID, 0, 9, 1), { ok: true });
  const entries = m.logRead(MOCK_ID).entries;
  const resend = entries.find((e) => e.event === "resend");
  assert.deepEqual(
    { cause: resend.cause, seq: resend.seq, attempt: resend.attempt },
    { cause: "timeout", seq: 1, attempt: 2 },
  );
  assert.equal(
    entries.filter((e) => e.kind === "data").length,
    1,
    "a resend is an error line, never a second data line",
  );
  await m.close();
});

test("the layout a run brings is trimmed to what a window may show", async () => {
  const { m } = manager();
  await m.open([
    {
      id: MOCK_ID,
      signature: 0,
      layout: {
        outputs: [
          {
            name: "x".repeat(200),
            fields: [
              { type: "word", name: "a" },
              { type: "bit", name: "over" }, // past sixteen pins
              { type: "nibble", name: "junk" },
            ],
          },
        ],
        inputs: "not a list",
      },
    },
  ]);
  const { layout } = m.mockState();
  assert.equal(layout.outputs[0].name.length, 64);
  assert.deepEqual(layout.outputs[0].fields, [{ type: "word", name: "a" }]);
  assert.deepEqual(layout.inputs, []);
  await m.close();
});
