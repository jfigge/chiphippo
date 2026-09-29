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
 * tests/serial-protocol.test.js — the serial protocol v1's bytes
 * (src/web/docs/serial-protocol.md): the two CRCs' check values, byte
 * stuffing in every field (CRC bytes included), the size limits, the
 * streaming decoder's resync and its three ways a frame is damaged, and the
 * data and HELLO payloads. The protocol page's own worked examples are held
 * to the encoder by serial-protocol-doc.test.js; the generated C++ header
 * transcribes the same rules, which serial-arduino-header.test.js proves
 * against a real compiler.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  START,
  ESC,
  FRAME,
  PROTOCOL_VERSION,
  crc16,
  crc32,
  encodeFrame,
  FrameDecoder,
  encodeData,
  decodeData,
  encodeHello,
  decodeHello,
  owesNak,
  MAX_PAYLOAD,
  MAX_FRAME_BODY,
  MAX_WIRE_FRAME,
} = require("../serial/protocol");

const hex = (buf) =>
  [...buf].map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

test('CRC-16/CCITT-FALSE check value: "123456789" → 0x29B1', () => {
  assert.equal(crc16(Buffer.from("123456789", "ascii")), 0x29b1);
  assert.equal(crc16([]), 0xffff);
});

test('CRC-32 (IEEE 802.3) check value: "123456789" → 0xCBF43926, "" → 0', () => {
  assert.equal(crc32(Buffer.from("123456789", "ascii")), 0xcbf43926);
  assert.equal(crc32([]), 0);
});

test("the constants come from the one shared module, and no type needs escaping", () => {
  assert.equal(PROTOCOL_VERSION, 1);
  const types = Object.values(FRAME);
  assert.equal(new Set(types).size, types.length, "every type is distinct");
  for (const t of types) {
    assert.ok(
      ![0x00, ESC, START, 0xff].includes(t),
      `type 0x${t.toString(16)}`,
    );
  }
});

test("the worked example: OUTPUT 0, width 8, value 0x7E, SEQ 1 — and its ACK", () => {
  const out = encodeFrame({
    type: FRAME.OUTPUT,
    seq: 1,
    payload: encodeData(0, 8, 0x7e),
  });
  assert.equal(hex(out), "7E 10 01 04 00 08 7D 5E 00 E4 88");
  assert.equal(
    hex(encodeFrame({ type: FRAME.ACK, seq: 1 })),
    "7E 06 01 00 0D 4D",
  );
});

test("HELLO and HELLO_ACK carry the session in the payload, SEQ 0, at every width", () => {
  const signature = crc32(Buffer.from("O0:8,O1:1,I0:16", "ascii"));
  assert.equal(signature, 0xf8acb506);
  for (const session of [0, 1, 255, 256, 0x7d7e, 65535]) {
    const payload = encodeHello({ version: 1, session, signature });
    assert.deepEqual(payload.slice(0, 3), [1, session & 0xff, session >> 8]);
    for (const type of [FRAME.HELLO, FRAME.HELLO_ACK]) {
      const [got] = new FrameDecoder().push(encodeFrame({ type, payload }));
      assert.equal(got.ok, true);
      assert.equal(got.seq, 0);
      assert.deepEqual(decodeHello(got.payload), {
        version: 1,
        session,
        signature,
      });
    }
  }
});

test("an INBOUND, a LOG and a NAK", () => {
  assert.equal(
    hex(
      encodeFrame({
        type: FRAME.INBOUND,
        seq: 1,
        payload: encodeData(0, 16, 0xbeef),
      }),
    ),
    "7E 11 01 04 00 10 EF BE 88 B7",
  );
  assert.equal(
    hex(encodeFrame({ type: FRAME.LOG, payload: Buffer.from("ok\n") })),
    "7E 20 00 03 6F 6B 0A 04 61",
  );
  assert.equal(hex(encodeFrame({ type: FRAME.NAK })), "7E 15 00 00 0F 64");
});

test("escaping reaches the CRC bytes too, and round-trips", () => {
  // ACK 16's CRC is 0x7D4F (CRC_HI is ESC); ACK 17's is 0x4E7E (CRC_LO is START).
  const a16 = encodeFrame({ type: FRAME.ACK, seq: 16 });
  const a17 = encodeFrame({ type: FRAME.ACK, seq: 17 });
  assert.equal(hex(a16), "7E 06 10 00 4F 7D 5D");
  assert.equal(hex(a17), "7E 06 11 00 7D 5E 4E");
  const d = new FrameDecoder();
  const got = d.push(Buffer.concat([a16, a17]));
  assert.deepEqual(
    got.map((f) => [f.ok, f.type, f.seq]),
    [
      [true, FRAME.ACK, 16],
      [true, FRAME.ACK, 17],
    ],
  );
});

test("a payload full of markers never puts a raw START after the first byte", () => {
  const payload = [START, ESC, 0x20, START, START, ESC];
  const frame = encodeFrame({ type: FRAME.LOG, seq: START, payload });
  assert.equal(
    frame.indexOf(START, 1),
    -1,
    "no unescaped START after the first",
  );
  const [decoded] = new FrameDecoder().push(frame);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.seq, START);
  assert.deepEqual([...decoded.payload], payload);
});

test("an escaped LEN: 125- and 126-byte payloads say 0x7D and 0x7E, escaped", () => {
  for (const n of [0x7d, 0x7e]) {
    const payload = Array.from({ length: n }, (_, i) => (i * 7) & 0xff);
    const frame = encodeFrame({ type: FRAME.LOG, payload });
    assert.deepEqual([...frame.subarray(3, 5)], [ESC, n ^ 0x20], `LEN ${n}`);
    const [got] = new FrameDecoder().push(frame);
    assert.equal(got.ok, true);
    assert.deepEqual([...got.payload], payload);
  }
});

test("the size limits: 255-byte payload, 260-byte body, 521 bytes on the wire at worst", () => {
  assert.equal(MAX_PAYLOAD, 255);
  assert.equal(MAX_FRAME_BODY, 260);
  assert.equal(MAX_WIRE_FRAME, 521);
  const worst = encodeFrame({
    type: FRAME.LOG,
    seq: ESC,
    payload: new Array(255).fill(START),
  });
  assert.ok(worst.length <= MAX_WIRE_FRAME, `${worst.length} bytes`);
  assert.equal(new FrameDecoder().push(worst)[0].ok, true);
});

test("a payload limit must be 0–255", () => {
  assert.throws(() => new FrameDecoder({ maxPayload: 256 }), RangeError);
  assert.throws(() => new FrameDecoder({ maxPayload: -1 }), RangeError);
  assert.doesNotThrow(() => new FrameDecoder({ maxPayload: 7 }));
});

test("a frame never grows past its LEN: bytes after it are hunted through, not held", () => {
  // A START, a LOG header claiming 3 bytes, then far more than that with no
  // START: the frame ends — damaged — at its own length, and the rest is
  // discarded until a START. One report, however long the garbage.
  const d = new FrameDecoder({ maxPayload: 7 });
  const garbage = Array.from({ length: 1000 }, (_, i) => (i % 0x7c) + 1);
  const out = d.push([START, FRAME.LOG, 0, 3, ...garbage]);
  assert.deepEqual(out, [{ ok: false, error: "crc", type: FRAME.LOG, seq: 0 }]);
  const [next] = d.push(encodeFrame({ type: FRAME.ACK, seq: 3 }));
  assert.equal(next.ok, true, "and the next START is found");
});

test("a START inside a frame tears it: dropped without a report, and the new frame read", () => {
  const whole = encodeFrame({ type: FRAME.ACK, seq: 4 });
  const torn = encodeFrame({
    type: FRAME.OUTPUT,
    seq: 2,
    payload: encodeData(0, 8, 9),
  });
  for (let cut = 1; cut < torn.length; cut++) {
    const out = new FrameDecoder().push(
      Buffer.concat([torn.subarray(0, cut), whole]),
    );
    assert.deepEqual(
      out.map((f) => [f.ok, f.type, f.seq]),
      [[true, FRAME.ACK, 4]],
      `torn after ${cut} bytes`,
    );
  }
});

test("a 255-byte payload round-trips; 256 is refused", () => {
  const payload = Array.from({ length: 255 }, (_, i) => i);
  const [got] = new FrameDecoder().push(
    encodeFrame({ type: FRAME.LOG, seq: 3, payload }),
  );
  assert.equal(got.ok, true);
  assert.deepEqual([...got.payload], payload);
  assert.throws(
    () => encodeFrame({ type: FRAME.LOG, payload: new Array(256).fill(65) }),
    RangeError,
  );
});

test("a frame split across chunks is reassembled — at every split point", () => {
  const frame = encodeFrame({
    type: FRAME.LOG,
    seq: 0x7d,
    payload: [...Buffer.from("hello~}world")],
  });
  for (let cut = 1; cut < frame.length; cut++) {
    const d = new FrameDecoder();
    const a = d.push(frame.subarray(0, cut));
    const b = d.push(frame.subarray(cut));
    assert.equal(a.length + b.length, 1, `split at ${cut}`);
    const got = [...a, ...b][0];
    assert.equal(got.ok, true);
    assert.equal(got.payload.toString(), "hello~}world");
  }
});

test("resync: garbage, then a truncated frame, then a good one", () => {
  const good = encodeFrame({ type: FRAME.ACK, seq: 9 });
  const torn = encodeFrame({
    type: FRAME.INBOUND,
    seq: 1,
    payload: encodeData(0, 8, 1),
  }).subarray(0, 5);
  const out = new FrameDecoder().push(
    Buffer.concat([Buffer.from("bootloader junk \x7d\x7d"), torn, good]),
  );
  assert.equal(out.length, 1, "the torn frame is dropped, not reported");
  assert.deepEqual([out[0].ok, out[0].type, out[0].seq], [true, FRAME.ACK, 9]);
});

test("a corrupted byte is a CRC failure, carrying TYPE and SEQ as they arrived", () => {
  const frame = Buffer.from(
    encodeFrame({
      type: FRAME.INBOUND,
      seq: 5,
      payload: encodeData(2, 4, 0xa),
    }),
  );
  frame[6] ^= 0x01; // flip a bit of the value
  const d = new FrameDecoder();
  const [got] = d.push(frame);
  assert.deepEqual(got, {
    ok: false,
    error: "crc",
    type: FRAME.INBOUND,
    seq: 5,
  });
  const [next] = d.push(encodeFrame({ type: FRAME.ACK, seq: 1 }));
  assert.equal(next.ok, true, "and the decoder is hunting again");
});

test("the CRC is little-endian: the same bytes sent high byte first are damage", () => {
  const frame = encodeFrame({ type: FRAME.ACK, seq: 3 });
  const [lo, hi] = [frame.at(-2), frame.at(-1)];
  assert.notEqual(lo, hi);
  const swapped = Buffer.concat([frame.subarray(0, -2), Buffer.from([hi, lo])]);
  assert.deepEqual(new FrameDecoder().push(swapped), [
    { ok: false, error: "crc", type: FRAME.ACK, seq: 3 },
  ]);
  assert.equal(crc16([FRAME.ACK, 3, 0]), lo | (hi << 8));
});

test("an escape followed by anything but 0x5E/0x5D is a corrupt frame", () => {
  const d = new FrameDecoder();
  const [got] = d.push([START, FRAME.LOG, 7, 2, ESC, 0x41]);
  assert.deepEqual(got, {
    ok: false,
    error: "escape",
    type: FRAME.LOG,
    seq: 7,
  });
  const [next] = d.push(encodeFrame({ type: FRAME.ACK, seq: 2 }));
  assert.equal(next.ok, true);
});

test("a receiver with a small buffer refuses a longer LEN rather than waiting for it", () => {
  const d = new FrameDecoder({ maxPayload: 8 });
  const [got] = d.push([START, FRAME.LOG, 4, 9]);
  assert.deepEqual(got, {
    ok: false,
    error: "length",
    type: FRAME.LOG,
    seq: 4,
  });
  const [next] = d.push(encodeFrame({ type: FRAME.ACK, seq: 1 }));
  assert.equal(next.ok, true);
});

test("data payloads: index, width and a right-aligned little-endian value", () => {
  assert.deepEqual(encodeData(0, 1, 1), [0, 1, 1, 0]);
  assert.deepEqual(
    encodeData(3, 4, 0xff),
    [3, 4, 0x0f, 0],
    "masked to the width",
  );
  assert.deepEqual(encodeData(1, 9, 0x1a5), [1, 9, 0xa5, 0x01]);
  assert.deepEqual(encodeData(0, 16, 0xbeef), [0, 16, 0xef, 0xbe]);
  assert.throws(() => encodeData(0, 0, 0), RangeError);
  assert.throws(() => encodeData(0, 17, 0), RangeError);
  for (const width of [1, 2, 3, 8, 9, 11, 16]) {
    const value = 0xa5c3 & ((1 << width) - 1);
    assert.deepEqual(decodeData(encodeData(5, width, value)), {
      index: 5,
      width,
      value,
    });
  }
});

test("decodeData masks stray high bits and rejects a payload of the wrong shape", () => {
  assert.deepEqual(decodeData([0, 4, 0xff, 0xff]), {
    index: 0,
    width: 4,
    value: 0x0f,
  });
  assert.equal(decodeData([]), null);
  assert.equal(decodeData([0, 8, 1]), null, "always four bytes");
  assert.equal(decodeData([0, 8, 1, 0, 0]), null);
  assert.equal(decodeData([0, 0, 1, 0]), null);
  assert.equal(decodeData([0, 17, 1, 0]), null);
});

test("HELLO carries the version, a 16-bit session and the layout signature", () => {
  const hello = { version: 1, session: 0x1234, signature: 0xf8acb506 };
  assert.deepEqual(encodeHello(hello), [1, 0x34, 0x12, 0x06, 0xb5, 0xac, 0xf8]);
  assert.deepEqual(decodeHello(encodeHello(hello)), hello);
});

test("a HELLO shorter than three bytes is nothing; version and session read from any longer one", () => {
  assert.equal(decodeHello([]), null);
  assert.equal(decodeHello([1, 2]), null);
  // Three to six bytes, or eight: the shared prefix, but no v1 signature.
  for (const n of [3, 4, 6, 8, 11]) {
    const payload = [2, 0x05, 0x01, 9, 9, 9, 9, 9, 9, 9, 9].slice(0, n);
    assert.deepEqual(decodeHello(payload), {
      version: 2,
      session: 0x0105,
      signature: null,
    });
  }
});

test("a NAK is owed for damage to anything but HELLO, HELLO_ACK, ACK, NAK and LOG", () => {
  for (const t of [
    FRAME.HELLO,
    FRAME.HELLO_ACK,
    FRAME.ACK,
    FRAME.NAK,
    FRAME.LOG,
  ]) {
    assert.equal(owesNak(t), false, `0x${t.toString(16)}`);
  }
  for (const t of [FRAME.OUTPUT, FRAME.INBOUND, 0x33, null]) {
    assert.equal(owesNak(t), true, String(t));
  }
});
