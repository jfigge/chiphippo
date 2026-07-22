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

// hd44780.test.js — the HD44780 controller state machine (sim/hd44780.js),
// driven directly: build state0, pulse E over a Map<pin, level>, assert the
// DDRAM/CGRAM/AC and the derived framebuffer. This is the risky core, so it is
// exercised without the engine or DOM.

import test from "node:test";
import assert from "node:assert/strict";

import { hd44780Unit, framebufferOf } from "../sim/hd44780.js";
import { H, L, Z } from "../sim/levels.js";
import { partDef } from "../catalog/index.js";

const RS = 4;
const RW = 5;
const E = 6;
const DB = [7, 8, 9, 10, 11, 12, 13, 14];

const unit = () => hd44780Unit({ rs: RS, rw: RW, e: E, db: DB });

/** A pin→level Map for the control lines + an 8-bit data value on DB0–DB7. */
function ins({ rs = L, rw = L, e = L, data = 0 }) {
  const m = new Map();
  m.set(RS, rs);
  m.set(RW, rw);
  m.set(E, e);
  for (let i = 0; i < 8; i++) m.set(DB[i], (data >> i) & 1 ? H : L);
  return m;
}

/** One 8-bit transfer: present data with E high, then drop E (the latch edge). */
function xfer(u, state, { rs = L, rw = L, data = 0 }) {
  const hi = ins({ rs, rw, e: H, data });
  const lo = ins({ rs, rw, e: L, data });
  return u.step(state, lo, hi); // prev E = H, now L → falling edge
}

const cmd = (u, state, data) => xfer(u, state, { rs: L, data });
const writeChar = (u, state, data) => xfer(u, state, { rs: H, data });

/** Init a display: 8-bit / 2-line, entry increment, display on (no cursor). */
function initDisplay(u) {
  let s = u.state0();
  s = cmd(u, s, 0x38); // function set: 8-bit, 2-line
  s = cmd(u, s, 0x06); // entry mode: increment, no shift
  s = cmd(u, s, 0x0c); // display on, cursor off, blink off
  return s;
}

test("writes land in DDRAM, advance the address counter, and render", () => {
  const u = unit();
  let s = initDisplay(u);
  s = writeChar(u, s, 0x48); // 'H'
  s = writeChar(u, s, 0x49); // 'I'
  assert.equal(s.ddram[0], 0x48);
  assert.equal(s.ddram[1], 0x49);
  assert.equal(s.ac, 2);
  assert.equal(s.displayOn, true);

  const fb = framebufferOf(s, { size: "16x2" });
  assert.equal(fb.cols, 16);
  assert.equal(fb.rows, 2);
  assert.equal(fb.chars[0], 0x48);
  assert.equal(fb.chars[1], 0x49);
  assert.equal(fb.chars[2], 0x20); // rest are spaces
  assert.equal(fb.displayOn, true);
  assert.deepEqual(
    { row: fb.cursor.row, col: fb.cursor.col },
    { row: 0, col: 2 }, // AC = 2
  );
});

test("clear fills DDRAM with spaces, homes AC, sets increment", () => {
  const u = unit();
  let s = initDisplay(u);
  s = writeChar(u, s, 0x41);
  s = cmd(u, s, 0x04); // entry mode: decrement (id = false)
  assert.equal(s.id, false);
  s = cmd(u, s, 0x01); // clear
  assert.equal(s.ac, 0);
  assert.equal(s.id, true); // clear restores increment (per datasheet)
  assert.ok([...s.ddram].every((b) => b === 0x20));
});

test("Set DDRAM address selects the second line (0x40)", () => {
  const u = unit();
  let s = initDisplay(u);
  s = cmd(u, s, 0x80 | 0x40); // move AC to 0x40 (line 2 start)
  assert.equal(s.ac, 0x40);
  s = writeChar(u, s, 0x58); // 'X'
  assert.equal(s.ddram[0x40], 0x58);
  const fb = framebufferOf(s, { size: "16x2" });
  assert.equal(fb.chars[16], 0x58); // row 1, col 0
});

test("return home un-shifts and re-homes without clearing DDRAM", () => {
  const u = unit();
  let s = initDisplay(u);
  s = writeChar(u, s, 0x5a); // 'Z' at 0
  s = cmd(u, s, 0x18); // display shift left
  assert.notEqual(s.shiftOffset, 0);
  s = cmd(u, s, 0x02); // home
  assert.equal(s.ac, 0);
  assert.equal(s.shiftOffset, 0);
  assert.equal(s.ddram[0], 0x5a); // DDRAM preserved
});

test("cursor/blink flags flow into the framebuffer", () => {
  const u = unit();
  let s = initDisplay(u);
  s = cmd(u, s, 0x0f); // display on, cursor on, blink on
  const fb = framebufferOf(s, { size: "16x2" });
  assert.equal(fb.cursor.on, true);
  assert.equal(fb.cursor.blink, true);
  // Display off blanks the panel (view checks displayOn).
  s = cmd(u, s, 0x08);
  assert.equal(framebufferOf(s, { size: "16x2" }).displayOn, false);
});

test("CGRAM: custom glyph bytes store and pass through to the framebuffer", () => {
  const u = unit();
  let s = initDisplay(u);
  s = cmd(u, s, 0x40); // set CGRAM address 0
  const glyph = [0x1f, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1f, 0x00];
  for (const row of glyph) s = writeChar(u, s, row);
  for (let i = 0; i < 8; i++) assert.equal(s.cgram[i], glyph[i]);
  // Put custom code 0 on screen; the framebuffer carries the cgram for the view.
  s = cmd(u, s, 0x80); // DDRAM address 0
  s = writeChar(u, s, 0x00);
  const fb = framebufferOf(s, { size: "16x2" });
  assert.equal(fb.chars[0], 0x00);
  for (let i = 0; i < 8; i++) assert.equal(fb.cgram[i], glyph[i]);
});

test("reads drive the bus while E & RW are high, float otherwise", () => {
  const u = unit();
  let s = initDisplay(u);
  s = writeChar(u, s, 0x53); // 'S' at 0
  s = cmd(u, s, 0x80); // AC back to 0

  // Status read (RS=0): DB7 is the busy flag — ALWAYS 0 (ready).
  const status = u.outputs(s, ins({ rs: L, rw: H, e: H }));
  assert.equal(status.get(DB[7]), L); // DB7 = busy = 0
  assert.equal(status.get(DB[0]), s.ac & 1 ? H : L);

  // Data read (RS=1): the addressed byte appears on the bus.
  const dataOut = u.outputs(s, ins({ rs: H, rw: H, e: H }));
  let v = 0;
  for (let i = 0; i < 8; i++) v |= (dataOut.get(DB[i]) === H ? 1 : 0) << i;
  assert.equal(v, 0x53);

  // E low → the module releases the bus (all DB float) so an external can drive.
  const idle = u.outputs(s, ins({ rs: H, rw: H, e: L }));
  for (const pin of DB) assert.equal(idle.get(pin), Z);
});

test("a data read auto-increments the address counter", () => {
  const u = unit();
  let s = initDisplay(u);
  s = cmd(u, s, 0x80); // AC = 0
  // A read transaction: value presented while E high (outputs), AC advances on
  // the falling edge.
  s = xfer(u, s, { rs: H, rw: H });
  assert.equal(s.ac, 1);
  // A status read (RS=0) does NOT move the AC.
  s = xfer(u, s, { rs: L, rw: H });
  assert.equal(s.ac, 1);
});

test("no E edge is a no-op (identity for warm-starting)", () => {
  const u = unit();
  const s = initDisplay(u);
  // E held low across the tick (prev L, now L) → same state reference.
  const held = u.step(s, ins({ e: L }), ins({ e: L }));
  assert.equal(held, s);
  // First tick (prev = null) → no edge.
  assert.equal(u.step(s, ins({ e: L }), null), s);
});

test("4-bit mode: a byte assembles over two nibble transfers", () => {
  const u = unit();
  // A 4-bit byte is two E pulses: the HIGH nibble (bits 7–4) then the LOW nibble
  // (bits 3–0), each presented on DB4–DB7.
  const hiNib = (byte) => byte & 0xf0;
  const loNib = (byte) => (byte & 0x0f) << 4;

  let s = u.state0();
  // Function set to 4-bit, 2-line (sent as one 8-bit write while still 8-bit).
  s = cmd(u, s, 0x28);
  assert.equal(s.dataLen8, false);
  // Display on — now a two-nibble command.
  s = xfer(u, s, { rs: L, data: hiNib(0x0c) });
  s = xfer(u, s, { rs: L, data: loNib(0x0c) });
  assert.equal(s.displayOn, true);

  // Write 'A' (0x41): high nibble then low nibble.
  s = xfer(u, s, { rs: H, data: hiNib(0x41) });
  assert.equal(s.nibblePhase, 1); // mid-byte
  s = xfer(u, s, { rs: H, data: loNib(0x41) });
  assert.equal(s.nibblePhase, 0);
  assert.equal(s.ddram[0], 0x41);
  assert.equal(s.ac, 1);
});

test("20x4: the four visible lines map to the classic DDRAM starts", () => {
  const u = unit();
  const starts = [0x00, 0x40, 0x14, 0x54];
  let s = u.state0();
  s = cmd(u, s, 0x38);
  s = cmd(u, s, 0x0c);
  for (let r = 0; r < 4; r++) {
    s = cmd(u, s, 0x80 | starts[r]);
    s = writeChar(u, s, 0x31 + r); // '1','2','3','4'
  }
  const fb = framebufferOf(s, { size: "20x4" });
  assert.equal(fb.cols, 20);
  assert.equal(fb.rows, 4);
  for (let r = 0; r < 4; r++) {
    assert.equal(fb.chars[r * 20], 0x31 + r); // first cell of each row
  }
});

test("the catalog def wires the builder to the datasheet pins", () => {
  const def = partDef("lcd");
  assert.equal(typeof def.logic.step, "function");
  assert.equal(typeof def.logic.outputs, "function");
  // Drive it through the def's own logic block: a command then a char.
  let s = def.logic.state0();
  s = def.logic.step(
    s,
    ins({ rs: L, rw: L, e: L, data: 0x38 }),
    ins({ rs: L, rw: L, e: H, data: 0x38 }),
  );
  s = def.logic.step(
    s,
    ins({ rs: L, rw: L, e: L, data: 0x0c }),
    ins({ rs: L, rw: L, e: H, data: 0x0c }),
  );
  s = def.logic.step(
    s,
    ins({ rs: H, rw: L, e: L, data: 0x42 }),
    ins({ rs: H, rw: L, e: H, data: 0x42 }),
  );
  assert.equal(s.ddram[0], 0x42); // 'B'
});
