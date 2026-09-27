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
 * tests/serial-arduino-header.test.js — the GENERATED Arduino header, compiled
 * and run. The header (web/scripts/model/integration-codegen.js) is the DEVICE
 * side of the serial protocol v1 and link.js the host side, and two
 * implementations of one wire format agree only if something makes them: this
 * compiles the real output with the host's C++ compiler against a stub Arduino
 * core (Serial over stdin/stdout, millis() off the clock), runs it as a child
 * process, and drives it with the real main-process SerialLink — the
 * handshake (and its version and signature refusals), an Output reaching its
 * handler with its fields unpacked, an Input answering inside that handler,
 * log text never split inside a UTF-8 character, a damaged frame NAKed and
 * resent, a lost ACK not firing a handler twice, a resend that arrives
 * WHILE its handler runs not being acknowledged early, `onConnect` firing at
 * the start of EVERY run on a board that never resets, an Output and an Input
 * of the same name — and the generated EXAMPLE sketch, built and run against
 * its own header.
 *
 * Skipped when there is no C++ compiler on the PATH (a stock Windows runner).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { SerialLink } = require("../serial/link");
const { FRAME, encodeFrame } = require("../serial/protocol");
const { board, lastingBoard } = require("./serial-board");

const CXX = ["c++", "clang++", "g++"].find(
  (cc) => spawnSync(cc, ["--version"], { stdio: "ignore" }).status === 0,
);

/** Runs a sketch's setup() and loop() as a host program, until stdin closes. */
const HOST_MAIN = String.raw`
int main() {
  setup();
  while (!Serial.eof) {
    loop();
    usleep(200);
  }
  return 0;
}
`;

/** Just enough of the Arduino core for the generated header and a sketch. */
const ARDUINO_H = String.raw`
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>

typedef bool boolean;
typedef uint8_t byte;

static inline unsigned long millis() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (unsigned long)(ts.tv_sec * 1000UL + ts.tv_nsec / 1000000UL);
}

#define SERIAL_8N1 0x06
#define SERIAL_7E1 0x24

class Print {
 public:
  virtual ~Print() {}
  virtual size_t write(uint8_t) = 0;
  size_t write(const uint8_t* b, size_t n) {
    size_t k = 0;
    while (n--) k += write(*b++);
    return k;
  }
  size_t write(const char* s) { return write((const uint8_t*)s, strlen(s)); }
  size_t print(const char* s) { return write(s); }
  size_t print(long v) {
    char buf[24];
    snprintf(buf, sizeof buf, "%ld", v);
    return write(buf);
  }
  size_t print(int v) { return print((long)v); }
  size_t print(unsigned v) { return print((long)v); }
  size_t print(unsigned char v) { return print((long)v); }
  size_t println() { return write("\r\n"); }
  template <typename T> size_t println(T v) { size_t n = print(v); return n + println(); }
};

class Stream : public Print {
 public:
  virtual int available() = 0;
  virtual int read() = 0;
};

class HostSerial : public Stream {
 public:
  void begin(unsigned long) { fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK); }
  void begin(unsigned long b, int) { begin(b); }
  int available() {
    if (pos_ < len_) return (int)(len_ - pos_);
    ssize_t n = ::read(0, buf_, sizeof buf_);
    if (n == 0) eof = true;
    if (n <= 0) return 0;
    len_ = (size_t)n;
    pos_ = 0;
    return (int)len_;
  }
  int read() { return available() ? buf_[pos_++] : -1; }
  size_t write(uint8_t b) { return ::write(1, &b, 1) == 1 ? 1 : 0; }
  using Print::write;
  bool eof = false;
 private:
  uint8_t buf_[256];
  size_t len_ = 0, pos_ = 0;
};

extern HostSerial Serial;
`;

/** The sketch: an Output whose handler logs and answers with an Input. */
const SKETCH =
  String.raw`
#include <stdlib.h>
#include "ChipHippo.h"

HostSerial Serial;
int calls = 0;

void Output1In(uint8_t data, bool strobe) {
  calls++;
  ChipHippo.print("got ");
  ChipHippo.print((long)data);
  ChipHippo.print(strobe ? " strobe" : " quiet");
  ChipHippo.print(" call ");
  ChipHippo.println((long)calls);
  ChipHippo.Input1Out.setValue((uint8_t)(data + 1));
  ChipHippo.Input1Out.setReady(strobe);
  ChipHippo.Input1Out.send();
}

// Two-byte characters, starting one byte in, so a naive cut at the log
// buffer's edge would land inside one.
void Output2In(bool go) {
  if (!go) return;
  ChipHippo.print("a");
  for (int i = 0; i < 40; i++) ChipHippo.print("\xC3\xA9");
  ChipHippo.println();
}

// Sent at the start of every run — registered only when a test asks
// (ON_CONNECT set), so every other test's Inputs are the handler's alone.
void greet() {
  ChipHippo.Input1Out.setValue(99);
  ChipHippo.Input1Out.send();
}

void setup() {
  if (getenv("ON_CONNECT")) ChipHippo.onConnect(greet);
  ChipHippo.begin();
}
void loop() { ChipHippo.poll(); }

` + HOST_MAIN;

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
const connection = {
  id: "nano",
  name: "Nano",
  baud: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
};

const builds = new Map();

/**
 * Compile the header + sketch, once per variant. `patch` edits the header
 * text before compiling — how a test builds a sketch that speaks another
 * protocol version, which the real generator never would. `els` and
 * `sketch` swap in another design and the sketch written for it; a `sketch`
 * FUNCTION is handed the generator module, for one built from the design.
 */
async function build(
  variant = "default",
  patch = (text) => text,
  { els = elements, sketch = SKETCH } = {},
) {
  if (builds.has(variant)) return builds.get(variant);
  const codegen =
    await import("../../web/scripts/model/integration-codegen.js");
  const header = codegen.generateHeader({
    connection,
    elements: els,
    projectName: "Test",
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-hdr-"));
  fs.writeFileSync(path.join(dir, "Arduino.h"), ARDUINO_H);
  fs.writeFileSync(path.join(dir, "ChipHippo.h"), patch(header.text));
  fs.writeFileSync(
    path.join(dir, "sketch.cpp"),
    typeof sketch === "function" ? sketch(codegen, dir) : sketch,
  );
  const exe = path.join(dir, "sketch");
  const r = spawnSync(
    CXX,
    [
      "-std=gnu++11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-I",
      dir,
      "-o",
      exe,
      path.join(dir, "sketch.cpp"),
    ],
    { encoding: "utf8" },
  );
  const built = { dir, exe, header, stderr: r.stderr, status: r.status };
  builds.set(variant, built);
  return built;
}

test(
  "the generated header compiles cleanly under -Wall -Wextra -Werror",
  { skip: !CXX && "no C++ compiler" },
  async () => {
    const b = await build();
    assert.equal(b.status, 0, b.stderr);
  },
);

test(
  "the handshake: the sketch answers with the version and the layout signature",
  { skip: !CXX && "no C++ compiler" },
  async () => {
    const b = await build();
    const { child, port, frames } = board(b.exe);
    const link = new SerialLink({ port });
    try {
      const r = await link.handshake(b.header.signature);
      assert.equal(r.ok, true);
      assert.deepEqual(r.device, {
        version: 1,
        signature: b.header.signature,
      });
      // begin() announced itself with session 0 before it was asked.
      assert.equal(frames[0].type, FRAME.HELLO_ACK);
      assert.equal(frames[0].seq, 0);
    } finally {
      await link.close();
      child.kill();
    }
  },
);

test(
  "a sketch built for another layout, or another protocol version, is refused",
  { skip: !CXX && "no C++ compiler" },
  async () => {
    const b = await build();
    const one = board(b.exe);
    const link = new SerialLink({ port: one.port });
    try {
      const r = await link.handshake((b.header.signature + 1) >>> 0);
      assert.equal(r.ok, false);
      assert.equal(r.code, "signature");
    } finally {
      await link.close();
      one.child.kill();
    }
    const v2 = await build("v2", (text) =>
      text.replace(
        "#define CHIPHIPPO_PROTOCOL_VERSION 1",
        "#define CHIPHIPPO_PROTOCOL_VERSION 2",
      ),
    );
    assert.equal(v2.status, 0, v2.stderr);
    const two = board(v2.exe);
    const link2 = new SerialLink({ port: two.port });
    try {
      const r = await link2.handshake(v2.header.signature);
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
  "an Output reaches its handler, which logs and answers with an Input",
  { skip: !CXX && "no C++ compiler" },
  async () => {
    const b = await build();
    const { child, port } = board(b.exe);
    const inbound = [];
    let log = "";
    const link = new SerialLink({
      port,
      onInbound: (d) => inbound.push(d),
      onLog: (t) => (log += t),
    });
    try {
      assert.equal((await link.handshake(b.header.signature)).ok, true);
      // data = 41, strobe = 1 → value bits 0-7 = 41, bit 8 = 1.
      const r = await link.send(0, 9, 41 | (1 << 8));
      assert.deepEqual(r, { ok: true });
      // The handler's Input AND its log line went out BEFORE its ACK came
      // back: the answer lands inside the boundary that asked for it.
      assert.deepEqual(inbound, [{ index: 0, width: 9, value: 42 | (1 << 8) }]);
      assert.match(log, /got 41 strobe call 1\r?\n/);
    } finally {
      await link.close();
      child.kill();
    }
  },
);

test(
  "log text is never split inside a UTF-8 character",
  { skip: !CXX && "no C++ compiler" },
  async () => {
    const b = await build();
    const { child, port, frames } = board(b.exe);
    let log = "";
    const link = new SerialLink({ port, onLog: (t) => (log += t) });
    try {
      assert.equal((await link.handshake(b.header.signature)).ok, true);
      assert.deepEqual(await link.send(1, 1, 1), { ok: true });
      assert.equal(log, `a${"é".repeat(40)}\r\n`);
      const logs = frames.filter((f) => f.type === FRAME.LOG);
      assert.ok(logs.length >= 2, "the line really was cut");
      for (const f of logs) {
        const text = f.payload.toString("utf8");
        assert.ok(
          !text.includes("\uFFFD"),
          `a frame split a character: ${text}`,
        );
        assert.deepEqual(Buffer.from(text, "utf8"), f.payload);
      }
    } finally {
      await link.close();
      child.kill();
    }
  },
);

test(
  "a damaged frame is NAKed and resent; the handler still runs once",
  { skip: !CXX && "no C++ compiler" },
  async () => {
    const b = await build();
    // Flip a bit in the first OUTPUT frame's payload on its way to the board.
    let damaged = false;
    const { child, port } = board(b.exe, {
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
      assert.equal((await link.handshake(b.header.signature)).ok, true);
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
  "a lost ACK is resent for, and the board does not act twice",
  { skip: !CXX && "no C++ compiler" },
  async () => {
    const b = await build();
    let dropped = 0;
    const { child, port } = board(b.exe, {
      // Lose the board's first ACK of an Output (not the handshake's).
      filter: (f) => !(f.type === FRAME.ACK && dropped++ === 0),
    });
    let log = "";
    const link = new SerialLink({
      port,
      timeoutMs: 150,
      onLog: (t) => (log += t),
    });
    try {
      assert.equal((await link.handshake(b.header.signature)).ok, true);
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
  "a resend arriving while its handler still runs is not acknowledged early",
  { skip: !CXX && "no C++ compiler" },
  async () => {
    const b = await build();
    // Hold back the host's ACK of the handler's Input, so the handler sits in
    // send() — reading the port — while the host's Output timeout fires and
    // the resend arrives. The board must answer that resend with NOTHING: its
    // ACK is the one sent when the handler returns.
    const HOLD = 250;
    let outputs = 0;
    const { child, port, frames } = board(b.exe, {
      mangle: (buf) => {
        if (buf[1] === FRAME.OUTPUT) outputs++;
        if (buf[1] !== FRAME.ACK) return buf;
        setTimeout(() => child.stdin.write(buf), HOLD);
        return null;
      },
    });
    const link = new SerialLink({ port, timeoutMs: 120 });
    try {
      assert.equal((await link.handshake(b.header.signature)).ok, true);
      const started = Date.now();
      assert.deepEqual(await link.send(0, 9, 3 | (1 << 8)), { ok: true });
      assert.ok(
        Date.now() - started >= HOLD - 20,
        "the ACK waited for the handler",
      );
      assert.ok(outputs >= 2, "the host really did resend mid-handler");
      const acks = frames.filter((f) => f.type === FRAME.ACK);
      assert.equal(acks.length, 1, "one ACK, after the handler — never early");
    } finally {
      await link.close();
      child.kill();
    }
  },
);

test(
  "a repeated HELLO of the same session does not rewind the sketch's SEQs",
  { skip: !CXX && "no C++ compiler" },
  async () => {
    const b = await build();
    const { child, port, frames } = board(b.exe);
    const inbound = [];
    const link = new SerialLink({ port, onInbound: (d) => inbound.push(d) });
    try {
      assert.equal((await link.handshake(b.header.signature)).ok, true);
      const session = frames.find(
        (f) => f.type === FRAME.HELLO_ACK && f.seq !== 0,
      ).seq;
      assert.deepEqual(await link.send(0, 9, 1), { ok: true }); // Input SEQ 1
      // The host's second HELLO, late: the sketch must answer it and nothing
      // more. Were it to reset, its next Input would be SEQ 1 again — which
      // the host, rightly, drops as a resend.
      child.stdin.write(
        encodeFrame({
          type: FRAME.HELLO,
          seq: session,
          payload: [1, 0, 0, 0, 0],
        }),
      );
      assert.deepEqual(await link.send(0, 9, 2), { ok: true }); // Input SEQ 2
      assert.deepEqual(
        inbound.map((d) => d.value),
        [2, 3],
      );
      const seqs = frames
        .filter((f) => f.type === FRAME.INBOUND)
        .map((f) => f.seq);
      assert.deepEqual(seqs, [1, 2]);
    } finally {
      await link.close();
      child.kill();
    }
  },
);

test(
  "a send nobody acknowledges takes the sketch offline until the next HELLO",
  { skip: !CXX && "no C++ compiler" },
  async () => {
    // A 40 ms ACK timeout in the sketch, so its three sends fail quickly.
    const b = await build("fast", (text) =>
      text.replace(
        /#define CHIPHIPPO_ACK_TIMEOUT_MS \d+UL/,
        "#define CHIPHIPPO_ACK_TIMEOUT_MS 40UL",
      ),
    );
    assert.equal(b.status, 0, b.stderr);
    // The host never acknowledges the sketch's Inputs.
    const { child, port, frames } = board(b.exe, {
      mangle: (buf) => (buf[1] === FRAME.ACK ? null : buf),
    });
    let log = "";
    const link = new SerialLink({
      port,
      timeoutMs: 200,
      onLog: (t) => (log += t),
    });
    try {
      assert.equal((await link.handshake(b.header.signature)).ok, true);
      // The handler's Input goes unanswered three times; the handler still
      // returns, and its Output is still acknowledged.
      assert.deepEqual(await link.send(0, 9, 1), { ok: true });
      assert.equal(frames.filter((f) => f.type === FRAME.INBOUND).length, 3);
      // Offline now: the next Output is not the sketch's to answer.
      assert.deepEqual(await link.send(0, 9, 2), {
        ok: false,
        code: "delivery",
      });
      assert.equal((log.match(/call/g) ?? []).length, 1);
    } finally {
      await link.close();
      child.kill();
    }
  },
);

test(
  "every element shape compiles — none, bits, a word, many, a 7E1 link",
  { skip: !CXX && "no C++ compiler" },
  async () => {
    const b = await build();
    const { generateHeader } =
      await import("../../web/scripts/model/integration-codegen.js");
    const bits = (n) =>
      Array.from({ length: n }, (_, i) => ({ type: "bit", name: `b${i}` }));
    const shapes = {
      empty: [],
      onlyOutputs: [
        {
          id: "out1",
          kind: "output",
          name: "Clock",
          connection: "nano",
          fields: bits(1),
        },
        {
          id: "out2",
          kind: "output",
          name: "Nibble",
          connection: "nano",
          fields: bits(4),
        },
        {
          id: "out3",
          kind: "output",
          name: "Word",
          connection: "nano",
          fields: [{ type: "word", name: "value" }],
        },
      ],
      onlyInputs: [
        {
          id: "in1",
          kind: "input",
          name: "Keys",
          connection: "nano",
          fields: [{ type: "byte", name: "keys" }, ...bits(8)],
        },
        {
          id: "in2",
          kind: "input",
          name: "loop",
          connection: "nano",
          fields: bits(2),
        },
      ],
    };
    for (const [name, els] of Object.entries(shapes)) {
      for (const conn of [
        connection,
        { ...connection, dataBits: 7, parity: "even" },
      ]) {
        const { text } = generateHeader({ connection: conn, elements: els });
        const hdrDir = fs.mkdtempSync(
          path.join(os.tmpdir(), "chiphippo-shape-"),
        );
        fs.writeFileSync(path.join(hdrDir, "ChipHippo.h"), text);
        fs.writeFileSync(
          path.join(hdrDir, "use.cpp"),
          '#include "ChipHippo.h"\nHostSerial Serial;\nvoid f() { ChipHippo.begin(); ChipHippo.poll(); ChipHippo.println("x"); }\n',
        );
        const r = spawnSync(
          CXX,
          [
            "-std=gnu++11",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-fsyntax-only",
            "-I",
            hdrDir,
            "-I",
            b.dir,
            path.join(hdrDir, "use.cpp"),
          ],
          { encoding: "utf8" },
        );
        assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      }
    }
  },
);

test(
  "onConnect runs at the start of EVERY run, even on a board that never resets",
  { skip: !CXX && "no C++ compiler" },
  async () => {
    const b = await build();
    const { child, port } = lastingBoard(b.exe, { env: { ON_CONNECT: "1" } });
    try {
      for (const run of [1, 2, 3]) {
        const inbound = [];
        const link = new SerialLink({
          port: port(),
          onInbound: (d) => inbound.push(d.value),
        });
        assert.equal((await link.handshake(b.header.signature)).ok, true);
        // An Output round trip: by its ACK, anything onConnect sent is in.
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
  "an Output and an Input may share a name: StatusIn and StatusOut",
  { skip: !CXX && "no C++ compiler" },
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
    const sketch =
      String.raw`
#include "ChipHippo.h"
HostSerial Serial;
void StatusIn(uint8_t code) {
  ChipHippo.StatusOut.setCode((uint8_t)(code * 2));
  ChipHippo.StatusOut.send();
}
void setup() { ChipHippo.begin(); }
void loop() { ChipHippo.poll(); }
` + HOST_MAIN;
    const b = await build("same-name", undefined, { els, sketch });
    assert.equal(b.status, 0, b.stderr);
    assert.deepEqual(b.header.warnings, [], "nothing to rename");
    const { child, port } = board(b.exe);
    const inbound = [];
    const link = new SerialLink({ port, onInbound: (d) => inbound.push(d) });
    try {
      assert.equal((await link.handshake(b.header.signature)).ok, true);
      assert.deepEqual(await link.send(0, 8, 21), { ok: true });
      assert.deepEqual(inbound, [{ index: 0, width: 8, value: 42 }]);
    } finally {
      await link.close();
      child.kill();
    }
  },
);

test(
  "the generated example builds against its header and runs: every Input sent at the start of the run, every Output logged",
  { skip: !CXX && "no C++ compiler" },
  async () => {
    const b = await build("example", undefined, {
      sketch: (codegen, dir) => {
        const example = codegen.generateExample({ connection, elements });
        fs.writeFileSync(path.join(dir, example.name), example.text);
        return `#include "${example.name}"\nHostSerial Serial;\n${HOST_MAIN}`;
      },
    });
    assert.equal(b.status, 0, b.stderr);
    const { child, port } = board(b.exe);
    const inbound = [];
    let log = "";
    const link = new SerialLink({
      port,
      onInbound: (d) => inbound.push(d),
      onLog: (t) => (log += t),
    });
    try {
      assert.equal((await link.handshake(b.header.signature)).ok, true);
      assert.deepEqual(await link.send(0, 9, 41 | (1 << 8)), { ok: true });
      assert.deepEqual(inbound, [{ index: 0, width: 9, value: 0 }]);
      assert.equal(log, "Output 1: data=41 strobe=1\r\n");
    } finally {
      await link.close();
      child.kill();
    }
  },
);
