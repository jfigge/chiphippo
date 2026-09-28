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

/**
 * tests/serial-manager.test.js — main's half of a run's serial link: opening
 * only connections SETTINGS know (never a path the renderer names), the
 * all-or-nothing open, the reasons a run is refused (the handshake's among
 * them), per-connection logs cut into lines with run dividers, and a device
 * dropped — or restarted — mid-run.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FRAME,
  PROTOCOL_VERSION,
  encodeFrame,
  FrameDecoder,
  encodeHello,
  decodeHello,
} = require("../serial/protocol");
const { SerialManager, MAX_LOG_ENTRIES } = require("../serial/serial-manager");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIGNATURE = 0x0badf00d;

/** A fake device that answers HELLO (unless told to stay silent) with its
    own version and signature, and ACKs every Output. */
function fakeDevice({
  silent = false,
  version = PROTOCOL_VERSION,
  signature = SIGNATURE,
} = {}) {
  const decoder = new FrameDecoder();
  let dataCb = null;
  let closeCb = null;
  const device = {
    closed: false,
    send(frame) {
      setImmediate(() => dataCb?.(encodeFrame(frame)));
    },
    log(text) {
      device.send({ type: FRAME.LOG, payload: [...Buffer.from(text)] });
    },
    announce() {
      device.send({
        type: FRAME.HELLO_ACK,
        payload: encodeHello({ version, session: 0, signature }),
      });
    },
    unplug() {
      closeCb?.(new Error("gone"));
    },
    port: {
      write(buf) {
        for (const f of decoder.push(buf)) {
          if (silent || !f.ok) continue;
          if (f.type === FRAME.HELLO) {
            const { session } = decodeHello(f.payload);
            device.send({
              type: FRAME.HELLO_ACK,
              payload: encodeHello({ version, session, signature }),
            });
          } else if (f.type === FRAME.OUTPUT) {
            device.send({ type: FRAME.ACK, seq: f.seq });
          }
        }
      },
      onData: (cb) => (dataCb = cb),
      onClose: (cb) => (closeCb = cb),
      close() {
        device.closed = true;
      },
    },
  };
  return device;
}

function setup({ connections, present, devices = {}, openError } = {}) {
  const events = [];
  const opened = [];
  const manager = new SerialManager({
    connections: () => connections,
    listPorts: async () => present.map((p) => ({ path: p })),
    openPort: async (config) => {
      if (openError) throw new Error(openError);
      opened.push(config.port);
      const d = devices[config.port] ?? (devices[config.port] = fakeDevice());
      return d.port;
    },
    emit: (event, payload) => events.push({ event, ...payload }),
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 60)),
      clearTimeout,
      setInterval: (fn, ms) => setInterval(fn, Math.min(ms, 20)),
      clearInterval,
    },
  });
  return { manager, events, opened, devices };
}

const nano = {
  id: "conn-nano",
  name: "Nano",
  port: "/dev/cu.nano",
  baud: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  flowControl: "none",
};

/** What a run asks for: each connection with the signature it expects. */
const ask = (...ids) => ids.map((id) => ({ id, signature: SIGNATURE }));

test("a run opens its connections, greets each device, and is ready", async () => {
  const { manager, opened } = setup({
    connections: [nano],
    present: ["/dev/cu.nano"],
  });
  const r = await manager.open(ask("conn-nano"));
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(opened, ["/dev/cu.nano"]);
  assert.equal(manager.active, true);
  await manager.close();
  assert.equal(manager.active, false);
});

test("the renderer names ids; an id settings do not know is refused", async () => {
  const { manager, opened } = setup({ connections: [nano], present: [] });
  assert.deepEqual(await manager.open(ask("/dev/cu.nano")), {
    ok: false,
    id: "/dev/cu.nano",
    code: "unknown",
  });
  assert.deepEqual(opened, []);
});

test("a flagged or port-less connection is 'unconfigured'", async () => {
  for (const conn of [
    { ...nano, needsConfig: true },
    { ...nano, port: "" },
  ]) {
    const { manager } = setup({
      connections: [conn],
      present: ["/dev/cu.nano"],
    });
    const r = await manager.open(ask(conn.id));
    assert.equal(r.code, "unconfigured");
  }
});

test("a port that is not plugged in is 'port-missing' — and nothing opens", async () => {
  const uno = { ...nano, id: "conn-uno", port: "/dev/cu.uno" };
  const { manager, opened } = setup({
    connections: [nano, uno],
    present: ["/dev/cu.nano"],
  });
  const r = await manager.open(ask("conn-nano", "conn-uno"));
  assert.deepEqual(r, { ok: false, id: "conn-uno", code: "port-missing" });
  assert.deepEqual(opened, []);
});

test("a driver refusal is 'open-failed' with its reason", async () => {
  const { manager } = setup({
    connections: [nano],
    present: ["/dev/cu.nano"],
    openError: "Resource busy",
  });
  const r = await manager.open(ask("conn-nano"));
  assert.equal(r.code, "open-failed");
  assert.equal(r.detail, "Resource busy");
});

test("no answer is 'no-response', and every port the run opened is closed again", async () => {
  const silent = fakeDevice({ silent: true });
  const good = fakeDevice();
  const uno = { ...nano, id: "conn-uno", port: "/dev/cu.uno" };
  const { manager } = setup({
    connections: [nano, uno],
    present: ["/dev/cu.nano", "/dev/cu.uno"],
    devices: { "/dev/cu.nano": good, "/dev/cu.uno": silent },
  });
  // The HELLO wait is the protocol's own (5 s) — shortened by the timers.
  const r = await manager.open(ask("conn-nano", "conn-uno"));
  assert.deepEqual(r, { ok: false, id: "conn-uno", code: "no-response" });
  assert.equal(good.closed, true);
  assert.equal(silent.closed, true);
  assert.equal(manager.active, false);
});

test("another protocol version is 'version', naming it; another layout is 'signature'", async () => {
  for (const [device, expected] of [
    [fakeDevice({ version: 3 }), { code: "version", version: 3 }],
    [fakeDevice({ signature: 1 }), { code: "signature" }],
  ]) {
    const { manager } = setup({
      connections: [nano],
      present: ["/dev/cu.nano"],
      devices: { "/dev/cu.nano": device },
    });
    const r = await manager.open(ask("conn-nano"));
    assert.deepEqual(r, { ok: false, id: "conn-nano", ...expected });
    assert.equal(device.closed, true, "and the port is let go");
    assert.equal(manager.active, false);
  }
});

test("send goes to the named connection; an unopened one answers 'closed'", async () => {
  const { manager } = setup({ connections: [nano], present: ["/dev/cu.nano"] });
  assert.deepEqual(await manager.send("conn-nano", 0, 1, 1), {
    ok: false,
    code: "closed",
  });
  await manager.open(ask("conn-nano"));
  assert.deepEqual(await manager.send("conn-nano", 0, 8, 42), { ok: true });
  await manager.close();
});

test("a run's stream: it starts afresh, cuts log text into lines, records the traffic, and survives Stop", async () => {
  const { manager, devices, events } = setup({
    connections: [nano],
    present: ["/dev/cu.nano"],
  });
  await manager.open(ask("conn-nano"));
  const dev = devices["/dev/cu.nano"];
  dev.log("temp=2");
  dev.log("1\r\nhum");
  await sleep(20);
  let log = manager.logRead("conn-nano");
  assert.ok(Number.isFinite(log.t0), "the run's clock");
  const events1 = log.entries.map((e) => e.event ?? e.kind);
  assert.deepEqual(events1.slice(0, 4), ["open", "hello", "hello-ack", "handshake"]); // prettier-ignore
  assert.equal(log.entries[0].port, "/dev/cu.nano");
  assert.deepEqual(
    log.entries.filter((e) => e.kind === "text").map((e) => e.text),
    ["temp=21"],
  );
  assert.equal(log.partial, "hum");
  // The app window hears only of log TEXT (for its LG lamp).
  assert.ok(events.some((e) => e.event === "log" && e.text));
  await manager.close();
  log = manager.logRead("conn-nano");
  assert.equal(log.entries.at(-2).text, "hum", "Stop ends the partial line…");
  assert.equal(log.entries.at(-1).event, "close", "…and says the port closed");
  // The next run starts it afresh.
  await manager.open(ask("conn-nano"));
  log = manager.logRead("conn-nano");
  assert.equal(log.entries[0].event, "open");
  assert.equal(
    log.entries.some((e) => e.kind === "text"),
    false,
  );
  const reset = events.filter((e) => e.event === "log" && e.reset);
  assert.ok(reset.length >= 1, "a window is told to start over");
  manager.logClear("conn-nano");
  assert.deepEqual(manager.logRead("conn-nano").entries, []);
  await manager.close();
});

test("a value that crosses is a DATA line naming its element, as the run described it", async () => {
  const { manager } = setup({
    connections: [nano],
    present: ["/dev/cu.nano"],
  });
  const layout = {
    outputs: [{ name: "Lamp", fields: [{ type: "bit", name: "on" }] }],
    inputs: [],
  };
  await manager.open([{ id: "conn-nano", signature: SIGNATURE, layout }]);
  await manager.send("conn-nano", 0, 1, 1);
  const data = manager
    .logRead("conn-nano")
    .entries.filter((e) => e.kind === "data");
  assert.equal(data.length, 1);
  assert.equal(data[0].dir, "out");
  assert.equal(data[0].seq, 1);
  assert.deepEqual(data[0].element, layout.outputs[0]);
  assert.equal(data[0].raw[0], 0x7e, "the bytes as they went");
  assert.ok(
    manager
      .logRead("conn-nano")
      .entries.some((e) => e.event === "ack-in" && e.seq === 1),
  );
  await manager.close();
});

test("a stream keeps its last MAX_LOG_ENTRIES entries", async () => {
  const { manager, devices } = setup({
    connections: [nano],
    present: ["/dev/cu.nano"],
  });
  await manager.open(ask("conn-nano"));
  const dev = devices["/dev/cu.nano"];
  for (let i = 0; i < MAX_LOG_ENTRIES + 10; i += 20) {
    dev.log(
      Array.from({ length: 20 }, (_, k) => `${i + k}\n`)
        .join("")
        .slice(0, 60),
    );
  }
  await sleep(50);
  assert.ok(manager.logRead("conn-nano").entries.length <= MAX_LOG_ENTRIES);
  await manager.close();
});

test("a board dropped mid-run is reported once, and logged", async () => {
  const { manager, devices, events } = setup({
    connections: [nano],
    present: ["/dev/cu.nano"],
  });
  await manager.open(ask("conn-nano"));
  devices["/dev/cu.nano"].unplug();
  const dropped = events.filter((e) => e.event === "dropped");
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].id, "conn-nano");
  assert.equal(manager.active, false);
  assert.ok(
    manager.logRead("conn-nano").entries.some((e) => e.event === "dropped"),
  );
});

test("a device announcing a restart mid-run is reported, and logged", async () => {
  const { manager, devices, events } = setup({
    connections: [nano],
    present: ["/dev/cu.nano"],
  });
  await manager.open(ask("conn-nano"));
  devices["/dev/cu.nano"].announce();
  await sleep(10);
  assert.deepEqual(
    events.filter((e) => e.event === "restart"),
    [{ event: "restart", id: "conn-nano" }],
  );
  assert.ok(
    manager
      .logRead("conn-nano")
      .entries.some((e) => e.kind === "error" && e.event === "restart"),
  );
  await manager.close();
});

test("closing is not a drop", async () => {
  const { manager, devices, events } = setup({
    connections: [nano],
    present: ["/dev/cu.nano"],
  });
  await manager.open(ask("conn-nano"));
  await manager.close();
  devices["/dev/cu.nano"].unplug();
  assert.equal(events.filter((e) => e.event === "dropped").length, 0);
});
