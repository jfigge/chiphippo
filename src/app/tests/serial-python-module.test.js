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
 * tests/serial-python-module.test.js — the GENERATED PYTHON MODULE
 * (web/scripts/model/integration-codegen-python.js), run and talked to. It is
 * the C++ header's protocol said again in Python, and this is
 * serial-arduino-header.test.js said again for it: the module and a program
 * using it run as a child process under an interpreter, and the real
 * main-process SerialLink drives them — the handshake and its refusals, an
 * Output reaching its handler and answered by an Input before its ACK, log
 * text never split inside a UTF-8 character, a damaged frame NAKed, a lost
 * ACK not firing a handler twice, a resend arriving mid-handler not ACKed
 * early, a repeated HELLO not rewinding the SEQs, going offline after an
 * unacknowledged send, on_connect at the start of EVERY run, a handler that
 * raises reported and got past, and the generated example program itself.
 *
 * EVERY TEST RUNS UNDER EVERY INTERPRETER PRESENT: `python3` (desktop
 * Python, where the module finds stdin/stdout through its desktop port) and
 * `micropython` (the unix port of the real MicroPython, where it takes the
 * same stdin/stdout path it takes on a board — select.poll, sys.stdin.buffer,
 * kbd_intr). An interpreter that is not installed skips its half.
 * CircuitPython's usb_cdc port needs a board; its part is a class the
 * module picks by `sys.implementation.name`.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { SerialLink } = require("../serial/link");
const {
  FRAME,
  encodeFrame,
  encodeHello,
  decodeHello,
} = require("../serial/protocol");
const { board, lastingBoard } = require("./serial-board");

const INTERPRETERS = ["python3", "micropython"].map((cmd) => ({
  cmd,
  present:
    spawnSync(cmd, ["-c", "import sys"], { stdio: "ignore" }).status === 0,
}));

/** The program: Outputs whose handlers log, answer with an Input, and
    raise; an on_connect registered only when a test asks (ON_CONNECT). */
const PROGRAM = String.raw`
import os
import time

from chiphippo import link

calls = 0


@link.output_1_in
def output_1(data, strobe):
    global calls
    calls += 1
    link.print("got", data, "strobe" if strobe else "quiet", "call", calls)
    link.input_1_out.set_value((data + 1) & 0xFF)
    link.input_1_out.set_ready(strobe)
    link.input_1_out.send()


# Two-byte characters, starting one byte in, so a naive cut at the log
# buffer's edge would land inside one.
@link.output_2_in
def output_2(go):
    if go:
        link.print("a" + "é" * 40)


@link.output_3_in
def output_3(x):
    raise ValueError("boom")


if os.getenv("ON_CONNECT"):

    @link.on_connect
    def greet():
        link.input_1_out.set_value(99)
        link.input_1_out.set_ready(False)
        link.input_1_out.send()


link.begin()
try:
    while True:
        link.poll()
        time.sleep(0.0002)
except EOFError:
    pass
`;

const connection = {
  id: "nano",
  name: "Pico",
  baud: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  language: "python",
};

const elements = [
  {
    id: "out1",
    kind: "output",
    name: "Output 1",
    connection: "nano",
    fields: [
      { type: "byte", name: "data" },
      { type: "bit", name: "strobe" },
    ],
  },
  {
    id: "out2",
    kind: "output",
    name: "Output 2",
    connection: "nano",
    fields: [{ type: "bit", name: "go" }],
  },
  {
    id: "out3",
    kind: "output",
    name: "Output 3",
    connection: "nano",
    fields: [{ type: "bit", name: "x" }],
  },
  {
    id: "in1",
    kind: "input",
    name: "Input 1",
    connection: "nano",
    fields: [
      { type: "byte", name: "value" },
      { type: "bit", name: "ready" },
    ],
  },
];

/**
 * Write the module (patched, if a test needs a case the generator never
 * emits) and a program into a fresh directory.
 */
async function prepare({
  patch = (text) => text,
  program = PROGRAM,
  els = elements,
} = {}) {
  const codegen =
    await import("../../web/scripts/model/integration-codegen-python.js");
  const module = codegen.generatePythonModule({
    connection,
    elements: els,
    projectName: "Test",
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-py-"));
  fs.writeFileSync(path.join(dir, "chiphippo.py"), patch(module.text));
  fs.writeFileSync(
    path.join(dir, "prog.py"),
    typeof program === "function" ? program(codegen, dir) : program,
  );
  return { dir, module };
}

/** Wait for something the board does in its own time (its loop's timer). */
async function until(done, ms = 5000) {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out waiting for the board");
    await new Promise((r) => setTimeout(r, 5));
  }
}

for (const { cmd, present } of INTERPRETERS) {
  const skip = !present && `no ${cmd}`;
  const run = (dir, opts = {}) =>
    board(cmd, { args: ["prog.py"], cwd: dir, ...opts });
  const named = (title) => `${cmd}: ${title}`;

  test(
    named("the handshake: the version and the layout signature"),
    { skip },
    async () => {
      const { dir, module } = await prepare();
      const { child, port, frames } = run(dir);
      const link = new SerialLink({ port });
      try {
        const r = await link.handshake(module.signature);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(r.device, { version: 1, signature: module.signature });
        // begin() announced itself with session 0 before it was asked.
        assert.equal(frames[0].type, FRAME.HELLO_ACK);
        assert.equal(decodeHello(frames[0].payload).session, 0);
      } finally {
        await link.close();
        child.kill();
      }
    },
  );

  test(
    named("another layout, or another protocol version, is refused"),
    { skip },
    async () => {
      const { dir, module } = await prepare();
      const one = run(dir);
      const link = new SerialLink({ port: one.port });
      try {
        const r = await link.handshake((module.signature + 1) >>> 0);
        assert.equal(r.ok, false);
        assert.equal(r.code, "signature");
      } finally {
        await link.close();
        one.child.kill();
      }
      const v2 = await prepare({
        patch: (text) =>
          text.replace("PROTOCOL_VERSION = 1", "PROTOCOL_VERSION = 2"),
      });
      const two = run(v2.dir);
      const link2 = new SerialLink({ port: two.port });
      try {
        const r = await link2.handshake(v2.module.signature);
        assert.equal(r.ok, false);
        assert.equal(r.code, "version");
        assert.equal(r.device.version, 2);
      } finally {
        await link2.close();
        two.child.kill();
      }
    },
  );

  test(
    named(
      "an Output reaches its handler, which logs and answers with an Input before the ACK",
    ),
    { skip },
    async () => {
      const { dir, module } = await prepare();
      const { child, port } = run(dir);
      const inbound = [];
      let log = "";
      const link = new SerialLink({
        port,
        onInbound: (d) => inbound.push(d),
        onLog: (t) => (log += t),
      });
      try {
        assert.equal((await link.handshake(module.signature)).ok, true);
        // data = 41, strobe = 1 → value bits 0-7 = 41, bit 8 = 1.
        assert.deepEqual(await link.send(0, 9, 41 | (1 << 8)), { ok: true });
        assert.deepEqual(inbound, [
          { index: 0, width: 9, value: 42 | (1 << 8) },
        ]);
        assert.equal(log, "got 41 strobe call 1\n");
      } finally {
        await link.close();
        child.kill();
      }
    },
  );

  test(
    named("log text is never split inside a UTF-8 character"),
    { skip },
    async () => {
      const { dir, module } = await prepare();
      const { child, port, frames } = run(dir);
      let log = "";
      const link = new SerialLink({ port, onLog: (t) => (log += t) });
      try {
        assert.equal((await link.handshake(module.signature)).ok, true);
        assert.deepEqual(await link.send(1, 1, 1), { ok: true });
        assert.equal(log, `a${"é".repeat(40)}\n`);
        const logs = frames.filter((f) => f.type === FRAME.LOG);
        assert.ok(logs.length >= 2, "the line really was cut");
        for (const f of logs) {
          const text = f.payload.toString("utf8");
          assert.ok(!text.includes("�"), `a frame split a character: ${text}`);
        }
      } finally {
        await link.close();
        child.kill();
      }
    },
  );

  test(
    named(
      "a handler that raises is told to the log, and its Output still acknowledged",
    ),
    { skip },
    async () => {
      const { dir, module } = await prepare();
      const { child, port } = run(dir);
      let log = "";
      const link = new SerialLink({ port, onLog: (t) => (log += t) });
      try {
        assert.equal((await link.handshake(module.signature)).ok, true);
        assert.deepEqual(await link.send(2, 1, 1), { ok: true });
        assert.match(
          log,
          /chiphippo: output_3_in raised ValueError\('boom',?\)\n/,
        );
        // …and the link carries on.
        assert.deepEqual(await link.send(0, 9, 7), { ok: true });
        assert.match(log, /got 7 quiet call 1\n/);
      } finally {
        await link.close();
        child.kill();
      }
    },
  );

  test(
    named("a damaged frame is NAKed and resent; the handler still runs once"),
    { skip },
    async () => {
      const { dir, module } = await prepare();
      let damaged = false;
      const { child, port } = run(dir, {
        mangle: (buf) => {
          if (!damaged && buf[1] === FRAME.OUTPUT) {
            damaged = true;
            buf[6] ^= 0x04;
          }
          return buf;
        },
      });
      let log = "";
      const link = new SerialLink({
        port,
        timeoutMs: 1000,
        onLog: (t) => (log += t),
      });
      try {
        assert.equal((await link.handshake(module.signature)).ok, true);
        const started = Date.now();
        assert.deepEqual(await link.send(0, 9, 7), { ok: true });
        assert.ok(damaged, "the frame really was damaged");
        assert.ok(Date.now() - started < 900, "the NAK beat the timeout");
        assert.equal((log.match(/got 7/g) ?? []).length, 1);
      } finally {
        await link.close();
        child.kill();
      }
    },
  );

  test(
    named("a lost ACK is resent for, and the board does not act twice"),
    { skip },
    async () => {
      const { dir, module } = await prepare();
      let dropped = 0;
      const { child, port } = run(dir, {
        filter: (f) => !(f.type === FRAME.ACK && dropped++ === 0),
      });
      let log = "";
      const link = new SerialLink({
        port,
        timeoutMs: 150,
        onLog: (t) => (log += t),
      });
      try {
        assert.equal((await link.handshake(module.signature)).ok, true);
        assert.deepEqual(await link.send(0, 9, 5), { ok: true });
        assert.ok(dropped >= 2, "an ACK really was lost, and another came");
        assert.equal((log.match(/got 5/g) ?? []).length, 1);
      } finally {
        await link.close();
        child.kill();
      }
    },
  );

  test(
    named(
      "a resend arriving while its handler still runs is not acknowledged early",
    ),
    { skip },
    async () => {
      const { dir, module } = await prepare();
      const HOLD = 250;
      let outputs = 0;
      const { child, port, frames } = run(dir, {
        mangle: (buf) => {
          if (buf[1] === FRAME.OUTPUT) outputs++;
          if (buf[1] !== FRAME.ACK) return buf;
          setTimeout(() => child.stdin.write(buf), HOLD);
          return null;
        },
      });
      const link = new SerialLink({ port, timeoutMs: 120 });
      try {
        assert.equal((await link.handshake(module.signature)).ok, true);
        const started = Date.now();
        assert.deepEqual(await link.send(0, 9, 3 | (1 << 8)), { ok: true });
        assert.ok(
          Date.now() - started >= HOLD - 20,
          "the ACK waited for the handler",
        );
        assert.ok(outputs >= 2, "the host really did resend mid-handler");
        const acks = frames.filter((f) => f.type === FRAME.ACK);
        assert.equal(
          acks.length,
          1,
          "one ACK, after the handler — never early",
        );
      } finally {
        await link.close();
        child.kill();
      }
    },
  );

  test(
    named("a repeated HELLO of the same session does not rewind the SEQs"),
    { skip },
    async () => {
      const { dir, module } = await prepare();
      const { child, port, frames } = run(dir);
      const inbound = [];
      const link = new SerialLink({ port, onInbound: (d) => inbound.push(d) });
      try {
        assert.equal((await link.handshake(module.signature)).ok, true);
        const { session } = frames
          .filter((f) => f.type === FRAME.HELLO_ACK)
          .map((f) => decodeHello(f.payload))
          .find((h) => h.session !== 0);
        assert.deepEqual(await link.send(0, 9, 1), { ok: true });
        child.stdin.write(
          encodeFrame({
            type: FRAME.HELLO,
            payload: encodeHello({
              version: 1,
              session,
              signature: module.signature,
            }),
          }),
        );
        assert.deepEqual(await link.send(0, 9, 2), { ok: true });
        assert.deepEqual(
          inbound.map((d) => d.value),
          [2, 3],
        );
        assert.deepEqual(
          frames.filter((f) => f.type === FRAME.INBOUND).map((f) => f.seq),
          [1, 2],
        );
      } finally {
        await link.close();
        child.kill();
      }
    },
  );

  test(
    named(
      "a send nobody acknowledges takes the program out of the session, and it says so: the run stops",
    ),
    { skip },
    async () => {
      const { dir, module } = await prepare({
        patch: (text) =>
          text.replace("ACK_TIMEOUT_MS = 500", "ACK_TIMEOUT_MS = 40"),
      });
      const { child, port, frames } = run(dir, {
        mangle: (buf) => (buf[1] === FRAME.ACK ? null : buf),
      });
      let log = "";
      let restarts = 0;
      const link = new SerialLink({
        port,
        timeoutMs: 200,
        onLog: (t) => (log += t),
        onRestart: () => restarts++,
      });
      try {
        assert.equal((await link.handshake(module.signature)).ok, true);
        assert.deepEqual(await link.send(0, 9, 1), {
          ok: false,
          code: "restart",
        });
        assert.equal(restarts, 1);
        assert.equal(frames.filter((f) => f.type === FRAME.INBOUND).length, 3);
        const last = frames.filter((f) => f.type === FRAME.HELLO_ACK).at(-1);
        assert.equal(decodeHello(last.payload).session, 0, "the announcement");
        assert.equal(frames.filter((f) => f.type === FRAME.ACK).length, 0);
        assert.deepEqual(await link.send(0, 9, 2), {
          ok: false,
          code: "restart",
        });
        assert.equal((log.match(/call/g) ?? []).length, 1);
      } finally {
        await link.close();
        child.kill();
      }
    },
  );

  test(
    named(
      "on_connect runs at the start of EVERY run, even on a board that never resets",
    ),
    { skip },
    async () => {
      const { dir, module } = await prepare();
      const { child, port } = lastingBoard(cmd, {
        args: ["prog.py"],
        cwd: dir,
        env: { ON_CONNECT: "1" },
      });
      try {
        for (const run of [1, 2, 3]) {
          const inbound = [];
          const link = new SerialLink({
            port: port(),
            onInbound: (d) => inbound.push(d.value),
          });
          assert.equal((await link.handshake(module.signature)).ok, true);
          // An Output round trip: by its ACK, anything on_connect sent is in.
          assert.deepEqual(await link.send(1, 1, 0), { ok: true });
          assert.deepEqual(inbound, [99], `run ${run}: greeted once`);
          await link.close();
        }
      } finally {
        child.kill();
      }
    },
  );

  test(
    named("an Output and an Input may share a name: status_in and status_out"),
    { skip },
    async () => {
      const els = [
        {
          id: "out1",
          kind: "output",
          name: "Status",
          connection: "nano",
          fields: [{ type: "byte", name: "code" }],
        },
        {
          id: "in1",
          kind: "input",
          name: "Status",
          connection: "nano",
          fields: [{ type: "byte", name: "code" }],
        },
      ];
      const program = String.raw`
import time
from chiphippo import link


@link.status_in
def status(code):
    link.status_out.set_code(code * 2)
    link.status_out.send()


link.begin()
try:
    while True:
        link.poll()
        time.sleep(0.0002)
except EOFError:
    pass
`;
      const { dir, module } = await prepare({ els, program });
      assert.deepEqual(module.warnings, [], "nothing to rename");
      const { child, port } = run(dir);
      const inbound = [];
      const link = new SerialLink({ port, onInbound: (d) => inbound.push(d) });
      try {
        assert.equal((await link.handshake(module.signature)).ok, true);
        assert.deepEqual(await link.send(0, 8, 21), { ok: true });
        assert.deepEqual(inbound, [{ index: 0, width: 8, value: 42 }]);
      } finally {
        await link.close();
        child.kill();
      }
    },
  );

  test(
    named(
      "the generated example runs: it logs the run's start, sends the Inputs' starting values, logs each Output that arrives, and sends a value counting up",
    ),
    { skip },
    async () => {
      const { dir, module } = await prepare({
        program: (codegen) => {
          const [main] = codegen.generatePythonExamples({
            connection,
            elements,
          });
          // A second is a long time in a test: count every 30 ms instead.
          const text = main.text.replace(
            "SEND_EVERY_MS = 1000",
            "SEND_EVERY_MS = 30",
          );
          assert.notEqual(text, main.text, "the period is where it was");
          // A board runs main.py forever; off a board, stdin closing ends it.
          const loop = text.slice(text.indexOf("while True:"));
          return text.replace(
            loop,
            `try:\n${loop.replace(/^(?=.)/gm, "    ")}except EOFError:\n    pass\n`,
          );
        },
      });
      const { child, port } = run(dir);
      const inbound = [];
      let log = "";
      const link = new SerialLink({
        port,
        onInbound: (d) => inbound.push(d),
        onLog: (t) => (log += t),
      });
      try {
        assert.equal((await link.handshake(module.signature)).ok, true);
        // RECEIVE: data = 41, strobe = 1.
        assert.deepEqual(await link.send(0, 9, 41 | (1 << 8)), { ok: true });
        // SEND: the starting value first, then value counting up (ready low).
        await until(() => inbound.length >= 3);
        assert.deepEqual(inbound[0], { index: 0, width: 9, value: 0 });
        assert.deepEqual(
          inbound.slice(1, 3).map((d) => d.value),
          [1, 2],
        );
        // LOG: all three kinds of line.
        await until(() => log.includes("Sent Input 1: value=2\n"));
        assert.ok(log.startsWith("Run started\n"), log);
        assert.ok(log.includes("Output 1: data=41 strobe=True\n"), log);
        assert.ok(log.includes("Sent Input 1: value=1\n"), log);
      } finally {
        await link.close();
        child.kill();
      }
    },
  );
}

test(
  "python3: begin(stream) runs the link over any stream shaped like pyserial's",
  { skip: !INTERPRETERS[0].present && "no python3" },
  async () => {
    const program = String.raw`
import os
import time
from chiphippo import link


class Pipe:
    # in_waiting / read / write, as pyserial's Serial has them.
    def __init__(self):
        os.set_blocking(0, False)
        self._buf = b""
        self.closed = False

    @property
    def in_waiting(self):
        try:
            data = os.read(0, 256)
            if not data:
                self.closed = True
            self._buf += data
        except BlockingIOError:
            pass
        return len(self._buf)

    def read(self, n):
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def write(self, data):
        os.write(1, bytes(data))


@link.output_1_in
def output_1(data, strobe):
    link.print("via stream", data)


pipe = Pipe()
link.begin(pipe)
while not pipe.closed:
    link.poll()
    time.sleep(0.0002)
`;
    const { dir, module } = await prepare({ program });
    const { child, port } = board("python3", { args: ["prog.py"], cwd: dir });
    let log = "";
    const link = new SerialLink({ port, onLog: (t) => (log += t) });
    try {
      assert.equal((await link.handshake(module.signature)).ok, true);
      assert.deepEqual(await link.send(0, 9, 12), { ok: true });
      assert.equal(log, "via stream 12\n");
    } finally {
      await link.close();
      child.kill();
    }
  },
);

test(
  "micropython: a 0x03 inside a damaged frame is the frame's own — only one between frames is a Ctrl-C",
  { skip: !INTERPRETERS[1].present && "no micropython" },
  async () => {
    const { dir, module } = await prepare();
    const { child, port } = board("micropython", {
      args: ["prog.py"],
      cwd: dir,
      stderr: "pipe",
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    let exited = false;
    child.once("exit", () => (exited = true));
    const inbound = [];
    const link = new SerialLink({ port, onInbound: (d) => inbound.push(d) });
    try {
      assert.equal((await link.handshake(module.signature)).ok, true);
      // Three damaged frames whose remaining bytes are full of 0x03:
      // a LEN past the payload limit (damaged as soon as it is read)…
      child.stdin.write(
        encodeFrame({ type: FRAME.OUTPUT, seq: 7, payload: [0, 8, 3, 3, 3, 3, 3, 3, 3, 3] }), // prettier-ignore
      );
      // …a bad escape before the LEN, the frame's bytes still to come…
      child.stdin.write(Buffer.from([0x7e, FRAME.OUTPUT, 0x7d, 0x41, 4, 3, 3, 3, 3, 3, 3])); // prettier-ignore
      // …and a later protocol version's HELLO, longer than this one's.
      child.stdin.write(
        encodeFrame({ type: FRAME.HELLO, payload: [2, 1, 2, 3, 3, 3, 3, 3, 3, 3, 3] }), // prettier-ignore
      );
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(exited, false, `the program is still running: ${stderr}`);
      assert.deepEqual(await link.send(0, 9, 2), { ok: true });
      assert.deepEqual(
        inbound.map((d) => d.value),
        [3],
      );
    } finally {
      await link.close();
      child.kill();
    }
  },
);

test(
  "micropython: a Ctrl-C between frames stops the program — so Thonny and mpremote can get in — while a 0x03 inside one is data",
  { skip: !INTERPRETERS[1].present && "no micropython" },
  async () => {
    const { dir, module } = await prepare();
    const { child, port } = board("micropython", {
      args: ["prog.py"],
      cwd: dir,
      stderr: "pipe",
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const exited = new Promise((r) => child.once("exit", (code) => r(code)));
    const inbound = [];
    const link = new SerialLink({ port, onInbound: (d) => inbound.push(d) });
    try {
      assert.equal((await link.handshake(module.signature)).ok, true);
      // data = 3: a 0x03 byte in the OUTPUT frame's payload — and in the
      // INBOUND the handler answers with (4 is not 3, but its SEQ may be).
      assert.deepEqual(await link.send(0, 9, 3), { ok: true });
      assert.deepEqual(await link.send(0, 9, 2), { ok: true });
      assert.deepEqual(
        inbound.map((d) => d.value),
        [4, 3],
        "both handled: a 0x03 inside a frame never interrupts",
      );
      // What a tool sends to stop a running program: CR, then Ctrl-C.
      child.stdin.write(Buffer.from([0x0d, 0x03]));
      const code = await exited;
      assert.notEqual(code, 0, "the program stopped");
      assert.match(stderr, /KeyboardInterrupt/);
    } finally {
      await link.close();
      child.kill();
    }
  },
);
