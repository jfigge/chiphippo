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

// uart.js — the ONE statement of an asynchronous serial frame (Feature 420).
// Pure and DOM-free.
//
// A serial line is an ordinary net carrying ordinary levels: idle (MARK) is
// HIGH; a frame is a START bit (LOW), 5–8 data bits LEAST significant first,
// an optional parity bit, and 1, 1.5 or 2 STOP bits (HIGH). Nothing here knows
// about nets, parts or the engine — every transmitter and receiver on the desk
// (the USB-serial adapter, the ACIAs to come) asks this module what a byte
// looks like on the wire and what a stretch of wire says, so no two of them can
// disagree about a frame.
//
// TIME is simulated seconds, as everywhere in the engine (sim/timing.js). A
// line changes level only at a tick, so a receiver that records the moment of
// every change it is stepped through holds the line's exact level at every
// instant: it decodes a frame by SAMPLING that history at each bit's middle
// (`decodeFrame` + `levelAt`), with no wake of its own until the frame's end.

/** The line formats the parts offer. `parity` none/even/odd; `stopBits` 1,
    1.5 or 2 (bit times). */
export const DATA_BITS = Object.freeze([5, 6, 7, 8]);
export const PARITIES = Object.freeze(["none", "even", "odd"]);
export const STOP_BITS = Object.freeze([1, 1.5, 2]);

/** The usual terminal rates, slowest first. Any rate in BAUD_RANGE is legal. */
export const BAUD_RATES = Object.freeze([
  50, 75, 110, 150, 300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 57600,
  115200,
]);
export const BAUD_RANGE = Object.freeze({ min: 1, max: 1_000_000 });

/** A boundary this close counts as reached (sim/timing.js's EPS): a part is
    ticked AT a bit edge, and float arithmetic must not leave it a hair short. */
const EPS = 1e-9;

/**
 * A format with every field defined: 8N1 unless told otherwise.
 * @param {{dataBits?: number, parity?: string, stopBits?: number}} [f]
 */
export function lineFormat(f = {}) {
  return {
    dataBits: DATA_BITS.includes(f.dataBits) ? f.dataBits : 8,
    parity: PARITIES.includes(f.parity) ? f.parity : "none",
    stopBits: STOP_BITS.includes(f.stopBits) ? f.stopBits : 1,
  };
}

/** The format as a terminal states it: `8N1`, `7E2`, `5O1.5`. */
export function formatName(f) {
  const fmt = lineFormat(f);
  return `${fmt.dataBits}${fmt.parity[0].toUpperCase()}${fmt.stopBits}`;
}

/** One bit's length at `baud`, seconds. */
export function bitTime(baud) {
  return 1 / baud;
}

/** The parity bit for `byte`'s low `dataBits` bits, or null for none. */
export function parityBit(byte, f) {
  const fmt = lineFormat(f);
  if (fmt.parity === "none") return null;
  let ones = 0;
  for (let i = 0; i < fmt.dataBits; i++) ones += (byte >> i) & 1;
  // Even parity makes the count of ones (data + parity) even.
  return fmt.parity === "even" ? ones & 1 : (ones + 1) & 1;
}

/** Bit times from the start edge to the end of the last stop bit. */
export function frameLength(f) {
  const fmt = lineFormat(f);
  return 1 + fmt.dataBits + (fmt.parity === "none" ? 0 : 1) + fmt.stopBits;
}

/**
 * The bits of one frame before its stop bits, as 0/1 in line order: the
 * start bit, the data bits LSB first, the parity bit if any. The stop bits
 * follow as `stopBits` bit times of 1.
 * @param {number} byte
 * @param {object} f
 * @returns {number[]}
 */
export function frameBits(byte, f) {
  const fmt = lineFormat(f);
  const bits = [0];
  for (let i = 0; i < fmt.dataBits; i++) bits.push((byte >> i) & 1);
  const p = parityBit(byte, fmt);
  if (p != null) bits.push(p);
  return bits;
}

/**
 * Where a frame begun at `t0` stands at `now`: the line's level and the next
 * moment it CHANGES (null once the frame has run its stop bits out — `end`).
 * A run of equal bits is one level, so a transmitter is woken only where the
 * line moves, plus once at `end` to take its next byte.
 * @param {number[]} bits  frameBits()
 * @param {number} t0      the start edge, seconds
 * @param {number} bt      one bit time, seconds
 * @param {number} now
 * @param {number} stopBits
 * @returns {{level: 0|1, nextChange: number|null, end: number, done: boolean}}
 */
export function frameAt(bits, t0, bt, now, stopBits) {
  const end = t0 + (bits.length + stopBits) * bt;
  if (now + EPS >= end) return { level: 1, nextChange: null, end, done: true };
  const idx = Math.max(0, Math.floor((now - t0 + EPS) / bt));
  const level = idx < bits.length ? bits[idx] : 1;
  // The next bit (or the stop bits' 1) that differs from this one.
  let nextChange = null;
  for (let j = idx + 1; j <= bits.length; j++) {
    const lv = j < bits.length ? bits[j] : 1;
    if (lv !== level) {
      nextChange = t0 + j * bt;
      break;
    }
  }
  return { level, nextChange, end, done: false };
}

/**
 * The line's level at time `t` from a receiver's record of it: `start` the
 * level before the first change, `changes` `[time, level]` pairs in order. A
 * change AT `t` counts (the level at an instant is the level after anything
 * that happened at it).
 */
export function levelAt(changes, start, t) {
  let level = start;
  for (const [at, lv] of changes) {
    if (at > t + EPS) break;
    level = lv;
  }
  return level;
}

/** When a receiver that saw the start edge at `t0` has the whole frame: the
    MIDDLE of the first stop bit, where it is sampled. */
export function sampleEnd(t0, bt, f) {
  const fmt = lineFormat(f);
  return t0 + (1 + fmt.dataBits + (fmt.parity === "none" ? 0 : 1) + 0.5) * bt;
}

/**
 * Decode the frame whose start edge fell at `t0`, sampling every bit at its
 * middle through `read(t)` → 0/1.
 *
 * A start bit that is no longer LOW half a bit in is a glitch, not a frame:
 * `{glitch: true}`. Otherwise the byte, and what went wrong with it — a stop
 * bit read LOW is a framing error, and a frame that is ALL low, stop bit and
 * all, is a BREAK (the line held down, which a receiver reports instead of a
 * NUL).
 * @param {(t: number) => number} read
 * @param {number} t0
 * @param {number} bt
 * @param {object} f
 * @returns {{glitch: true} | {byte: number, framingError: boolean,
 *   parityError: boolean, brk: boolean}}
 */
export function decodeFrame(read, t0, bt, f) {
  const fmt = lineFormat(f);
  const at = (k) => read(t0 + (k + 0.5) * bt);
  if (at(0) !== 0) return { glitch: true };
  let byte = 0;
  for (let i = 0; i < fmt.dataBits; i++) byte |= at(1 + i) << i;
  let k = 1 + fmt.dataBits;
  let parityError = false;
  let parity = 0;
  if (fmt.parity !== "none") {
    parity = at(k);
    parityError = parity !== parityBit(byte, fmt);
    k++;
  }
  const stop = at(k);
  const framingError = stop !== 1;
  const brk = framingError && byte === 0 && parity === 0;
  return { byte, framingError, parityError, brk };
}
