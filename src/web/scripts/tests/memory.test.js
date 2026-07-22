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

// Feature 170: the pure `memUnit` vocabulary (sim/sequential.js) — the
// address-indexed ROM/SRAM/EEPROM primitive. Combinational read (addressed word
// onto the data pins, or Z when deselected / mid-write), level-latched write
// REPORTED (never applied here — the engine stays pure), address masking, the
// active-high second chip-enable, and a 16-bit-wide word.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, Z } from "../sim/levels.js";
import { memUnit } from "../sim/sequential.js";
import { memoryConfig } from "../sim/chip-eval.js";

/** Build a pin→level input Map from a plain object keyed by pin number. */
const ins = (obj) =>
  new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));

// A 4-byte read-only ROM and a 4-byte writable RAM sharing one pin layout:
//   addr A0=1 A1=2 · data DQ0..7 = 3..10 · CE̅=11 · OE̅=12 · (RAM) WE̅=13
const ROM = {
  size: 4,
  width: 8,
  addr: [1, 2],
  data: [3, 4, 5, 6, 7, 8, 9, 10],
};
const rom = memUnit({ ...ROM, ceN: 11, oeN: 12 });
const ram = memUnit({ ...ROM, ceN: 11, oeN: 12, weN: 13 });

/** Read a data-pin Map back into an integer (LSB first). */
const dataWord = (map, pins = ROM.data) =>
  pins.reduce((n, pin, i) => n + (map.get(pin) === H ? 1 << i : 0), 0);

test("memUnit exposes its config for seeding and validation", () => {
  const cfg = memoryConfig({ logic: ram });
  assert.equal(cfg.size, 4);
  assert.equal(cfg.width, 8);
  assert.deepEqual(cfg.addr, [1, 2]);
  assert.equal(cfg.weN, 13);
  assert.equal(cfg.ce2, null);
});

test("read: the addressed byte drives the data pins while selected & OE low", () => {
  const image = [0x00, 0x11, 0x1e, 0xff];
  // addr = 2 (A0=L, A1=H); CE̅ low, OE̅ low → present image[2] = 0x1E.
  const out = rom.read(ins({ 1: L, 2: H, 11: L, 12: L }), image);
  assert.deepEqual(
    [...out.keys()].sort((a, b) => a - b),
    ROM.data,
    "drives exactly the data bus",
  );
  assert.equal(dataWord(out), 0x1e);
});

test("read: deselected (CE̅ high) floats the whole data bus", () => {
  const out = rom.read(ins({ 1: L, 2: L, 11: H, 12: L }), [0xaa, 0, 0, 0]);
  for (const lv of out.values()) assert.equal(lv, Z);
});

test("read: output-disabled (OE̅ high) floats the bus even when selected", () => {
  const out = rom.read(ins({ 1: L, 2: L, 11: L, 12: H }), [0xaa, 0, 0, 0]);
  for (const lv of out.values()) assert.equal(lv, Z);
});

test("read: a RAM releases the bus (Z) while WE̅ is low so the writer wins", () => {
  const out = ram.read(
    ins({ 1: L, 2: L, 11: L, 12: L, 13: L }),
    [0x5a, 0, 0, 0],
  );
  for (const lv of out.values()) assert.equal(lv, Z);
});

test("read: a missing image reads as zeros, never throws", () => {
  const out = rom.read(ins({ 1: L, 2: L, 11: L, 12: L }), undefined);
  assert.equal(dataWord(out), 0);
});

test("write: a RAM reports {addr,value} from the bus while CE̅·WE̅ low", () => {
  // addr = 1 (A0=H, A1=L); data bus = 0x4D = 0b01001101.
  const bus = { 3: H, 4: L, 5: H, 6: H, 7: L, 8: L, 9: H, 10: L };
  const op = ram.write(ins({ 1: H, 2: L, 11: L, 13: L, ...bus }));
  assert.deepEqual(op, { addr: 1, value: 0x4d });
});

test("write: idle (WE̅ high) or deselected (CE̅ high) reports nothing", () => {
  const bus = { 3: H, 4: H, 5: H, 6: H, 7: H, 8: H, 9: H, 10: H };
  assert.equal(ram.write(ins({ 1: L, 2: L, 11: L, 13: H, ...bus })), null);
  assert.equal(ram.write(ins({ 1: L, 2: L, 11: H, 13: L, ...bus })), null);
});

test("write: a read-only ROM (no WE) never reports a write", () => {
  const bus = { 3: H, 4: H, 5: H, 6: H, 7: H, 8: H, 9: H, 10: H };
  assert.equal(rom.write(ins({ 1: L, 2: L, 11: L, ...bus })), null);
});

test("a second active-HIGH chip-enable (CE2) gates the part", () => {
  const dual = memUnit({ ...ROM, ceN: 11, oeN: 12, ce2: 14 });
  const image = [0x00, 0x00, 0x00, 0x3c];
  const sel = { 1: H, 2: H, 11: L, 12: L }; // addr 3, CE̅ low
  // CE2 low → still deselected → Z; CE2 high → drives image[3] = 0x3C.
  for (const lv of dual.read(ins({ ...sel, 14: L }), image).values()) {
    assert.equal(lv, Z);
  }
  assert.equal(dataWord(dual.read(ins({ ...sel, 14: H }), image)), 0x3c);
});

test("a 16-bit-wide word reads and writes across sixteen data pins", () => {
  const data16 = Array.from({ length: 16 }, (_, i) => i + 3); // pins 3..18
  const wide = memUnit({
    size: 2,
    width: 16,
    addr: [1],
    data: data16,
    ceN: 19,
    oeN: 20,
    weN: 21,
  });
  const image = new Uint16Array([0xabcd, 0x1234]);
  const out = wide.read(ins({ 1: L, 19: L, 20: L, 21: H }), image);
  assert.equal(dataWord(out, data16), 0xabcd);

  // Drive the 16 data pins to 0xF00F and write to addr 1.
  const bus = {};
  data16.forEach((pin, i) => (bus[pin] = (0xf00f >> i) & 1 ? H : L));
  const op = wide.write(ins({ 1: H, 19: L, 21: L, ...bus }));
  assert.deepEqual(op, { addr: 1, value: 0xf00f });
});

test("address decode wraps within the array (masked to size)", () => {
  // A one-location memory (size 1) collapses every address to 0.
  const tiny = memUnit({
    size: 1,
    width: 8,
    addr: [1],
    data: [3],
    ceN: 4,
    oeN: 5,
  });
  const out = tiny.read(ins({ 1: H, 4: L, 5: L }), [1]); // image[0] = 1
  assert.equal(out.get(3), H); // addr H → &(size-1)=&0 → 0 → image[0] bit0 = 1
});
