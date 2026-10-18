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

// uart.test.js — the serial frame (sim/uart.js): what a byte looks like on
// the wire, and what a recorded stretch of wire decodes to.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DATA_BITS,
  PARITIES,
  STOP_BITS,
  bitTime,
  decodeFrame,
  formatName,
  frameAt,
  frameBits,
  frameLength,
  levelAt,
  lineFormat,
  parityBit,
  sampleEnd,
} from "../sim/uart.js";

/** Every change a transmitter makes for `byte` from `t0`: what a receiver
    would record, walked through frameAt exactly as the adapter is woken. */
function transmit(byte, f, t0, bt) {
  const fmt = lineFormat(f);
  const bits = frameBits(byte, fmt);
  const changes = [];
  let now = t0;
  let last = 1;
  for (;;) {
    const at = frameAt(bits, t0, bt, now, fmt.stopBits);
    if (at.level !== last) changes.push([now, at.level]);
    last = at.level;
    if (at.done) break;
    now = at.nextChange ?? at.end;
  }
  return changes;
}

const FORMATS = DATA_BITS.flatMap((dataBits) =>
  PARITIES.flatMap((parity) =>
    STOP_BITS.map((stopBits) => ({ dataBits, parity, stopBits })),
  ),
);

test("a format defaults to 8N1 and names itself the way a terminal does", () => {
  assert.deepEqual(lineFormat(), { dataBits: 8, parity: "none", stopBits: 1 });
  assert.equal(formatName({}), "8N1");
  assert.equal(formatName({ dataBits: 7, parity: "even", stopBits: 2 }), "7E2");
  assert.equal(formatName({ dataBits: 5, parity: "odd", stopBits: 1.5 }), "5O1.5"); // prettier-ignore
  assert.deepEqual(lineFormat({ dataBits: 9, parity: "mark", stopBits: 3 }), lineFormat()); // prettier-ignore
});

test("a frame is a LOW start bit, the data LSB first, then parity", () => {
  // 'A' = 0x41 = 0100 0001 → on the wire 1,0,0,0,0,0,1,0.
  assert.deepEqual(frameBits(0x41, {}), [0, 1, 0, 0, 0, 0, 0, 1, 0]);
  // Even parity of 0x41 (two ones) is 0; odd is 1.
  assert.equal(parityBit(0x41, { parity: "even" }), 0);
  assert.equal(parityBit(0x41, { parity: "odd" }), 1);
  assert.equal(parityBit(0x41, {}), null);
  // 7 data bits drop bit 7 of the byte.
  assert.deepEqual(frameBits(0xff, { dataBits: 7 }), [0, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(frameLength({}), 10);
  assert.equal(frameLength({ dataBits: 7, parity: "even", stopBits: 2 }), 11);
  assert.equal(frameLength({ dataBits: 5, stopBits: 1.5 }), 7.5);
});

test("the transmitter is woken only where the line changes, and at the end", () => {
  const bt = bitTime(1000);
  // 0x00: start + eight 0 bits is ONE low run, then the stop bit.
  const zero = frameAt(frameBits(0x00, {}), 0, bt, 0, 1);
  assert.equal(zero.level, 0);
  assert.equal(zero.nextChange, 9 * bt);
  // 0xFF: the start bit alone is low.
  const ff = frameAt(frameBits(0xff, {}), 0, bt, 0, 1);
  assert.equal(ff.nextChange, bt);
  const high = frameAt(frameBits(0xff, {}), 0, bt, bt, 1);
  assert.equal(high.level, 1);
  assert.equal(high.nextChange, null, "nothing changes again in this frame");
  assert.equal(high.end, 10 * bt);
  assert.equal(frameAt(frameBits(0xff, {}), 0, bt, 10 * bt, 1).done, true);
});

test("a ticked edge a hair short of its moment still counts as reached", () => {
  const bt = bitTime(115200);
  const t0 = 1234.5678;
  const bits = frameBits(0x55, {});
  // 0x55 alternates, so every bit is an edge.
  for (let j = 1; j < bits.length; j++) {
    const at = frameAt(bits, t0, bt, t0 + j * bt, 1);
    assert.equal(at.level, bits[j], `bit ${j}`);
  }
});

test("every byte round-trips in every format, at 50 baud and at 115 200", () => {
  for (const baud of [50, 115200]) {
    const bt = bitTime(baud);
    for (const fmt of FORMATS) {
      for (let byte = 0; byte < 1 << fmt.dataBits; byte += 7) {
        const t0 = 3.25;
        const changes = transmit(byte, fmt, t0, bt);
        const got = decodeFrame((t) => levelAt(changes, 1, t), t0, bt, fmt);
        assert.deepEqual(
          got,
          { byte, framingError: false, parityError: false, brk: false },
          `${formatName(fmt)} @ ${baud}: ${byte}`,
        );
      }
    }
  }
});

test("a receiver's record answers the level AT a change with the new level", () => {
  const changes = [
    [1, 0],
    [2, 1],
  ];
  assert.equal(levelAt(changes, 1, 0.5), 1);
  assert.equal(levelAt(changes, 1, 1), 0);
  assert.equal(levelAt(changes, 1, 1.5), 0);
  assert.equal(levelAt(changes, 1, 2), 1);
});

test("a mismatched rate, a flipped bit, a held line and a glitch are each said", () => {
  const fmt = { parity: "even" };
  const bt = bitTime(1200);
  // Sent at 2400, read at 1200: every sample lands two bits on, so 0x55's
  // alternation reads as one level — not the byte that was sent.
  const fast = transmit(0x55, {}, 0, bitTime(2400));
  const misread = decodeFrame((t) => levelAt(fast, 1, t), 0, bt, {});
  assert.notEqual(misread.byte, 0x55, "the wrong rate reads the wrong byte");
  // A parity bit flipped in flight.
  const sent = transmit(0x41, fmt, 0, bt).map(([t, lv]) => [t, lv]);
  const flipAt = 9.5 * bt; // the parity bit's middle (start + 8 data)
  const flipped = (t) => (Math.abs(t - flipAt) < bt / 4 ? 1 - levelAt(sent, 1, t) : levelAt(sent, 1, t)); // prettier-ignore
  assert.equal(decodeFrame(flipped, 0, bt, fmt).parityError, true);
  // The line held LOW: a break.
  const held = decodeFrame(() => 0, 0, bt, {});
  assert.deepEqual(held, { byte: 0, framingError: true, parityError: false, brk: true }); // prettier-ignore
  // A dip shorter than half a bit: no frame.
  const dip = [
    [0, 0],
    [bt / 4, 1],
  ];
  assert.deepEqual(decodeFrame((t) => levelAt(dip, 1, t), 0, bt, {}), { glitch: true }); // prettier-ignore
});

test("the frame is complete at the middle of its first stop bit", () => {
  const bt = bitTime(9600);
  assert.equal(sampleEnd(0, bt, {}), 9.5 * bt);
  assert.equal(sampleEnd(1, bt, { dataBits: 7, parity: "odd" }), 1 + 9.5 * bt);
});
