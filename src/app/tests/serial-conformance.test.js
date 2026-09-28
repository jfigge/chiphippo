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
 * tests/serial-conformance.test.js — every DEVICE implementation of the
 * serial protocol v1 fed the SAME bytes, and held to the SAME answers
 * (src/web/docs/serial-protocol.md). The Mock (mock-device.js), the generated
 * C++ header (compiled with the host's compiler and run) and the generated
 * Python module (under python3 and the real MicroPython) each take one script
 * of host frames, byte for byte, and must put exactly the same frames back on
 * the wire — and, where a program has handlers, run exactly the same ones.
 *
 * The other device tests drive each implementation with the real host link,
 * which only ever sends what a correct host sends. This one sends what a
 * host might not: frames before any HELLO, a HELLO for session 0 or too short
 * to name one, another layout's or another version's, every width of
 * session, noise and torn frames, damage of every kind (a bad escape, a CRC
 * in the wrong byte order, a LEN damaged either way) with the next frame
 * right behind it, frames the device cannot use, and a new
 * session arriving while a handler waits on its own Input. So it is where
 * the implementations are shown to agree on the corners of §3–§6, not only
 * on the paths the host exercises.
 *
 * The C++ half skips with no compiler on the PATH; each Python half skips
 * without its interpreter.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  START,
  ESC,
  ESC_XOR,
  FRAME,
  crc16,
  encodeFrame,
  FrameDecoder,
  encodeData,
  encodeHello,
} = require("../serial/protocol");
const { MockDevice } = require("../serial/mock-device");
const { board, ARDUINO_H, HOST_MAIN } = require("./serial-board");

const CXX = ["c++", "clang++", "g++"].find(
  (cc) => spawnSync(cc, ["--version"], { stdio: "ignore" }).status === 0,
);
const has = (cmd) =>
  spawnSync(cmd, ["-c", "import sys"], { stdio: "ignore" }).status === 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (buf) =>
  [...buf].map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

// ── The design every device is built for ────────────────────────────────────

const connection = {
  id: "c",
  name: "Conformance",
  baud: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
};
const elements = [
  { id: "out1", kind: "output", name: "A", connection: "c", fields: [{ type: "byte", name: "v" }] }, // prettier-ignore
  { id: "out2", kind: "output", name: "B", connection: "c", fields: [{ type: "bit", name: "on" }] }, // prettier-ignore
  { id: "in1", kind: "input", name: "R", connection: "c", fields: [{ type: "byte", name: "v" }] }, // prettier-ignore
];

/** Output A logs its value and, for 0x55, answers with Input R — twice, so
    a test can hold a handler inside send() and see what its NEXT send does
    once the session has ended under it; Output B logs its bit. */
const CPP_SKETCH =
  String.raw`
#include "ChipHippo.h"
HostSerial Serial;
void AIn(uint8_t v) {
  ChipHippo.print("A=");
  ChipHippo.println((long)v);
  if (v == 0x55) {
    ChipHippo.ROut.setV(v);
    ChipHippo.ROut.send();
    ChipHippo.ROut.setV((uint8_t)(v + 1));
    ChipHippo.ROut.send();
  }
}
void BIn(bool on) {
  ChipHippo.print("B=");
  ChipHippo.println((long)on);
}
void setup() { ChipHippo.begin(); }
void loop() { ChipHippo.poll(); }
` + HOST_MAIN;

const PY_PROGRAM = String.raw`
import time
from chiphippo import link


@link.a_in
def a(v):
    link.print("A=" + str(v))
    if v == 0x55:
        link.r_out.set_v(v)
        link.r_out.send()
        link.r_out.set_v(v + 1)
        link.r_out.send()


@link.b_in
def b(on):
    link.print("B=" + str(int(on)))


link.begin()
try:
    while True:
        link.poll()
        time.sleep(0.0002)
except EOFError:
    pass
`;

// ── The frames ──────────────────────────────────────────────────────────────

let SIG = 0; // the design's layout signature, once the generator is loaded

const hello = (session, { version = 1, signature = SIG, len = 7 } = {}) =>
  encodeFrame({
    type: FRAME.HELLO,
    payload: encodeHello({ version, session, signature }).slice(0, len),
  });
const helloAck = (session) =>
  encodeFrame({
    type: FRAME.HELLO_ACK,
    payload: encodeHello({ version: 1, session, signature: SIG }),
  });
const output = (seq, index, width, value) =>
  encodeFrame({ type: FRAME.OUTPUT, seq, payload: encodeData(index, width, value) }); // prettier-ignore
const inbound = (seq, index, width, value) =>
  encodeFrame({ type: FRAME.INBOUND, seq, payload: encodeData(index, width, value) }); // prettier-ignore
const ack = (seq) => encodeFrame({ type: FRAME.ACK, seq });
const NAK = encodeFrame({ type: FRAME.NAK });

/** A frame with a bit of its last byte flipped — the CRC fails, the TYPE
    still reads — never into a START or an ESC, which would tear it. */
function damaged(buf) {
  const out = Buffer.from(buf);
  const i = out.length - 1;
  for (const mask of [0x01, 0x02, 0x04]) {
    if (![START, ESC].includes(out[i] ^ mask)) {
      out[i] ^= mask;
      return out;
    }
  }
  throw new Error("cannot damage");
}

/** An OUTPUT's body as the encoder makes it — unescaped, CRC last — for the
    frames below that the encoder never would. */
function outputBody(seq, index, width, value) {
  const payload = encodeData(index, width, value);
  const head = [FRAME.OUTPUT, seq, payload.length, ...payload];
  const crc = crc16(head);
  return [...head, crc & 0xff, crc >> 8];
}
/** A body escaped and framed as §3.4 says, whatever it holds. */
const framed = (body) =>
  Buffer.from([
    START,
    ...body.flatMap((b) => (b === START || b === ESC ? [ESC, b ^ ESC_XOR] : [b])), // prettier-ignore
  ]);
/** OUTPUT `seq` for B = `on` with its CRC sent big-endian: the wrong order. */
function crcSwapped(seq, on) {
  const body = outputBody(seq, 1, 1, on);
  const [lo, hi] = body.splice(-2);
  assert.notEqual(lo, hi, "a swap that changes something");
  return framed([...body, hi, lo]);
}
/** OUTPUT `seq` for B = `on` with its LEN damaged into `len`. */
function lenDamaged(seq, on, len) {
  const body = outputBody(seq, 1, 1, on);
  body[2] = len;
  return framed(body);
}
/** OUTPUT `seq` for A, with the first value whose CRC must be escaped. */
function crcEscaped(seq) {
  for (let v = 0; v < 256; v++) {
    const crc = outputBody(seq, 0, 8, v).slice(-2);
    if (v !== 0x55 && crc.some((b) => b === START || b === ESC)) return v;
  }
  throw new Error("no value escapes the CRC");
}

/**
 * The script. Each step writes its frames (one write), then the device must
 * answer with exactly `expect` — and nothing else, within a quiet period —
 * and run exactly `handled` (programs with handlers only). An `input` step
 * first makes the device send Input R the value 0x55 and hold it,
 * unacknowledged, before writing — a program by being sent Output A = 0x55
 * as that SEQ.
 */
function script() {
  return [
    { name: "before any HELLO an OUTPUT is ignored", send: [output(1, 0, 8, 1)], expect: [] }, // prettier-ignore
    { name: "…and damage is not NAKed", send: [damaged(output(1, 0, 8, 1))], expect: [] }, // prettier-ignore
    { name: "a HELLO for session 0 is ignored, not answered", send: [hello(0)], expect: [] }, // prettier-ignore
    { name: "a HELLO too short to name a session is ignored", send: [hello(0x1234, { len: 2 })], expect: [] }, // prettier-ignore
    { name: "a HELLO for session 0x7D7E is answered, and joined", send: [hello(0x7d7e)], expect: [helloAck(0x7d7e)] }, // prettier-ignore
    { name: "OUTPUT 1 runs its handler, then is ACKed", send: [output(1, 0, 8, 0x7e)], expect: [ack(1)], handled: ["A=126"] }, // prettier-ignore
    { name: "its resend is ACKed again, not run again", send: [output(1, 0, 8, 0x7e)], expect: [ack(1)], handled: [] }, // prettier-ignore
    { name: "a late copy of the HELLO is answered and resets nothing", send: [hello(0x7d7e), output(1, 0, 8, 0x7e)], expect: [helloAck(0x7d7e), ack(1)], handled: [] }, // prettier-ignore
    { name: "OUTPUT 2, a bit", send: [output(2, 1, 1, 1)], expect: [ack(2)], handled: ["B=1"] }, // prettier-ignore
    { name: "a damaged OUTPUT is NAKed", send: [damaged(output(3, 0, 8, 1))], expect: [NAK] }, // prettier-ignore
    { name: "damage to a frame never resent is not NAKed", send: [damaged(ack(9)), damaged(NAK), damaged(hello(0x7d7e)), damaged(helloAck(5)), damaged(encodeFrame({ type: FRAME.LOG, payload: [0x61] }))], expect: [] }, // prettier-ignore
    { name: "damage before the TYPE is NAKed", send: [Buffer.from([START, ESC, 0x41])], expect: [NAK] }, // prettier-ignore
    { name: "a LEN past the device's payload limit is damage, NAKed", send: [encodeFrame({ type: FRAME.OUTPUT, seq: 3, payload: [0, 8, 1, 0, 0, 0, 0, 0] })], expect: [NAK] }, // prettier-ignore
    // The receiver, §3.5: hunting, tearing, damage — and the frame after it.
    { name: "noise between frames is hunted through — an escaped SEQ", send: [Buffer.from([0x00, 0x41, ESC, ESC, 0x5e, 0xff, 0x20]), output(0x7d, 1, 1, 0)], expect: [ack(0x7d)], handled: ["B=0"] }, // prettier-ignore
    { name: "a START tears a frame — mid-payload, or right after an ESC — with no NAK", send: [output(9, 1, 1, 0).subarray(0, 6), output(0x7e, 1, 1, 1).subarray(0, 3), output(0x7e, 1, 1, 1)], expect: [ack(0x7e)], handled: ["B=1"] }, // prettier-ignore
    { name: "an invalid escape in the payload is damage, NAKed", send: [Buffer.from([START, FRAME.OUTPUT, 10, 4, 0x01, ESC, 0x41, 0x00, 0x00, 0x11, 0x22])], expect: [NAK] }, // prettier-ignore
    { name: "…and a START right behind it begins the next frame", send: [Buffer.from([START, FRAME.OUTPUT, 10, 4, 0x01, ESC, 0x41]), output(15, 1, 1, 0)], expect: [NAK, ack(15)], handled: ["B=0"] }, // prettier-ignore
    { name: "the CRC is little-endian: sent big-endian it is damage, NAKed, and the resend is taken", send: [crcSwapped(16, 1), output(16, 1, 1, 1)], expect: [NAK, ack(16)], handled: ["B=1"] }, // prettier-ignore
    { name: "a LEN damaged larger, within the limit, waits — and the resend's START tears it, no NAK", send: [lenDamaged(18, 0, 6), output(18, 1, 1, 0)], expect: [ack(18)], handled: ["B=0"] }, // prettier-ignore
    { name: "a LEN damaged smaller fails the CRC, NAKed", send: [lenDamaged(19, 1, 2), output(19, 1, 1, 1)], expect: [NAK, ack(19)], handled: ["B=1"] }, // prettier-ignore
    { name: "a LEN far past the limit is damage at once, and the next START is read", send: [Buffer.from([START, FRAME.OUTPUT, 20, 200, 0x01, 0x01]), output(20, 1, 1, 0)], expect: [NAK, ack(20)], handled: ["B=0"] }, // prettier-ignore
    { name: "a CRC with an escaped byte", send: [output(21, 0, 8, crcEscaped(21))], expect: [ack(21)], handled: [`A=${crcEscaped(21)}`] }, // prettier-ignore
    { name: "an OUTPUT for no element is ACKed and not run", send: [output(3, 5, 8, 1)], expect: [ack(3)], handled: [] }, // prettier-ignore
    { name: "…nor one of the wrong width", send: [output(4, 0, 9, 1)], expect: [ack(4)], handled: [] }, // prettier-ignore
    { name: "…nor one of the wrong length — and it counts as acknowledged", send: [encodeFrame({ type: FRAME.OUTPUT, seq: 5, payload: [0, 8, 1] }), output(5, 0, 8, 2)], expect: [ack(5), ack(5)], handled: [] }, // prettier-ignore
    { name: "a stray ACK, a stray NAK, an unknown type: nothing", send: [ack(77), NAK, encodeFrame({ type: 0x33, payload: [1] })], expect: [] }, // prettier-ignore
    { name: "a new session for another layout is answered with the device's own, and not joined", send: [hello(0x0101, { signature: (SIG ^ 1) >>> 0 }), output(1, 0, 8, 3), damaged(output(2, 0, 8, 3))], expect: [helloAck(0x0101)], handled: [] }, // prettier-ignore
    { name: "…and a HELLO for that session again changes nothing, whatever it says", send: [hello(0x0101), output(1, 0, 8, 3)], expect: [helloAck(0x0101)], handled: [] }, // prettier-ignore
    { name: "a new session of another version is answered as version 1, and not joined", send: [hello(0x0102, { version: 2 }), output(1, 0, 8, 3)], expect: [helloAck(0x0102)], handled: [] }, // prettier-ignore
    { name: "session 65535 is joined, its SEQs from 1", send: [hello(0xffff), output(1, 1, 1, 0)], expect: [helloAck(0xffff), ack(1)], handled: ["B=0"] }, // prettier-ignore
    { name: "session 256", send: [hello(256), output(1, 1, 1, 1)], expect: [helloAck(256), ack(1)], handled: ["B=1"] }, // prettier-ignore
    { name: "session 255", send: [hello(255), output(1, 1, 1, 0)], expect: [helloAck(255), ack(1)], handled: ["B=0"] }, // prettier-ignore
    { name: "session 1", send: [hello(1), output(1, 1, 1, 1)], expect: [helloAck(1), ack(1)], handled: ["B=1"] }, // prettier-ignore
    // The device is waiting for the ACK of its Input (SEQ 1 of session 1)
    // when a new session's HELLO arrives, and a NAK right behind it. The
    // Input belongs to the run that has gone: it is given up, never resent
    // into the new session; the handler's NEXT send is refused too (it is
    // still the old run's handler); and the Output whose handler sent them
    // is never acknowledged.
    { name: "a new session while an Input waits: answered, and the old run's Inputs given up", input: 2, send: [Buffer.concat([hello(0x2222), NAK])], expect: [helloAck(0x2222)], handled: [] }, // prettier-ignore
    { name: "…and the new session starts clean", send: [output(1, 1, 1, 1)], expect: [ack(1)], handled: ["B=1"] }, // prettier-ignore
    { name: "a data frame with SEQ 0 is no data frame: ignored", send: [output(0, 1, 1, 0)], expect: [], handled: [] }, // prettier-ignore
    // Nobody acknowledges the Input: three sends, 500 ms apart, then the
    // device leaves the session — dropping the handler's ACK — and says so
    // with its start-up announcement, so a host still listening stops too.
    { name: "an Input never acknowledged: three sends, then the device leaves the session and says so", input: 2, send: [], expect: [inbound(1, 0, 8, 0x55), inbound(1, 0, 8, 0x55), helloAck(0)], handled: [] }, // prettier-ignore
    { name: "offline, an OUTPUT is ignored", send: [output(3, 1, 1, 1)], expect: [], handled: [] }, // prettier-ignore
    { name: "…and a HELLO for the session it left is answered, but brings it no nearer", send: [hello(0x2222), output(3, 1, 1, 1)], expect: [helloAck(0x2222)], handled: [] }, // prettier-ignore
    { name: "the next session does — and SEQ 0 at a session's start is still no data frame", send: [hello(0x3333), output(0, 1, 1, 0), output(1, 1, 1, 1)], expect: [helloAck(0x3333), ack(1)], handled: ["B=1"] }, // prettier-ignore
  ];
}

// ── The devices ─────────────────────────────────────────────────────────────

/*
 * One device behind a common face: `write` puts host bytes on its wire,
 * `frames` is every frame it has sent (LOG included), `handled` every
 * handler its program has run (one per LOG line), and `startInput` makes it
 * send Input R = 0x55 and hold, waiting for an ACK that never comes.
 */

/** The Mock: no program, so no handlers — its Input is sent from its
    window, which is what `sendInput` stands for. */
function mockDevice() {
  const mock = new MockDevice();
  const port = mock.openPort({ signature: SIG });
  const decoder = new FrameDecoder();
  const device = {
    frames: [],
    handled: [],
    handlers: false,
    write: (buf) => port.write(buf),
    close: () => port.close(),
    startInput: () => {
      mock.sendInput(0, 8, 0x55);
    },
  };
  port.onData((chunk) => device.frames.push(...decoder.push(chunk)));
  return device;
}

/** A generated program run as a child process: Output A = 0x55 makes its
    handler send Input R and wait on it. */
function nativeDevice(command, args, cwd) {
  const b = board(command, { args, cwd });
  const device = {
    frames: b.frames,
    handled: [],
    handlers: true,
    write: (buf) => b.port.write(buf),
    close: () => b.child.kill(),
    startInput: (seq) => device.write(output(seq, 0, 8, 0x55)),
  };
  let seen = 0;
  let text = "";
  const collect = () => {
    for (; seen < b.frames.length; seen++) {
      const f = b.frames[seen];
      if (f.type !== FRAME.LOG) continue;
      text += f.payload.toString("utf8").replace(/\r/g, "");
      let nl;
      while ((nl = text.indexOf("\n")) >= 0) {
        device.handled.push(text.slice(0, nl));
        text = text.slice(nl + 1);
      }
    }
  };
  b.port.onData(collect);
  return device;
}

// ── Running the script ──────────────────────────────────────────────────────

const protocolFrames = (d, from) =>
  d.frames.slice(from).filter((f) => f.type !== FRAME.LOG);

/** Wait until `n` protocol frames have arrived since `from`, then for quiet:
    anything more that arrives is an answer the step did not expect. */
async function settle(d, from, n, quiet = 80) {
  const end = Date.now() + 5000;
  while (protocolFrames(d, from).length < n) {
    if (Date.now() > end) break;
    await sleep(2);
  }
  let count = d.frames.length;
  for (;;) {
    await sleep(quiet);
    if (d.frames.length === count) break;
    count = d.frames.length;
  }
  return protocolFrames(d, from).map((f) => hex(encodeFrame(f)));
}

async function conform(d) {
  // It announced its start: a HELLO_ACK for session 0.
  assert.deepEqual(await settle(d, 0, 1), [hex(helloAck(0))], "announcement");
  for (const step of script()) {
    if (step.input) {
      const from = d.frames.length;
      d.startInput(step.input);
      const [first] = await settle(d, from, 1, 40);
      assert.equal(first, hex(inbound(1, 0, 8, 0x55)), `${step.name}: Input R sent`); // prettier-ignore
    }
    const from = d.frames.length;
    const handledFrom = d.handled.length;
    d.write(Buffer.concat(step.send));
    const got = await settle(d, from, step.expect.length);
    assert.deepEqual(got, step.expect.map(hex), step.name);
    if (d.handlers && step.handled) {
      await sleep(5);
      const ran = d.handled.slice(handledFrom).filter((l) => l !== "A=85");
      assert.deepEqual(ran, step.handled, `${step.name}: handlers`);
    }
  }
}

test.before(async () => {
  const { layoutSignature } =
    await import("../../web/scripts/model/integration.js");
  SIG = layoutSignature(elements, "c");
});

test("conformance: the Mock", async () => {
  const d = mockDevice();
  try {
    await conform(d);
  } finally {
    d.close();
  }
});

test(
  "conformance: the generated C++ header",
  { skip: !CXX && "no C++ compiler" },
  async () => {
    const codegen =
      await import("../../web/scripts/model/integration-codegen.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-conf-"));
    fs.writeFileSync(path.join(dir, "Arduino.h"), ARDUINO_H);
    fs.writeFileSync(
      path.join(dir, "ChipHippo.h"),
      codegen.generateHeader({ connection, elements }).text,
    );
    fs.writeFileSync(path.join(dir, "sketch.cpp"), CPP_SKETCH);
    const exe = path.join(dir, "sketch");
    const r = spawnSync(
      CXX,
      ["-std=gnu++11", "-Wall", "-Wextra", "-Werror", "-I", dir, "-o", exe, path.join(dir, "sketch.cpp")], // prettier-ignore
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const d = nativeDevice(exe, [], dir);
    try {
      await conform(d);
    } finally {
      d.close();
    }
  },
);

for (const cmd of ["python3", "micropython"]) {
  test(
    `conformance: the generated Python module under ${cmd}`,
    { skip: !has(cmd) && `no ${cmd}` },
    async () => {
      const codegen =
        await import("../../web/scripts/model/integration-codegen-python.js");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-conf-py-"));
      fs.writeFileSync(
        path.join(dir, "chiphippo.py"),
        codegen.generatePythonModule({
          connection: { ...connection, language: "python" },
          elements,
        }).text,
      );
      fs.writeFileSync(path.join(dir, "prog.py"), PY_PROGRAM);
      const d = nativeDevice(cmd, ["prog.py"], dir);
      try {
        await conform(d);
      } finally {
        d.close();
      }
    },
  );
}
