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

// w65c21.test.js — the W65C21 PIA state machine, exercised through its catalog
// def's `logic` block (so the pin wiring is validated too). The bench mimics one
// engine tick: it holds the sequential state + the previous tick's pin levels,
// pulses PHI2 (rise then fall), and drives a bus transaction the way the engine
// would — writes latch on PHI2's falling edge, reads present data while high.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, Z } from "../sim/levels.js";
import { chipDef } from "../catalog/index.js";

// Datasheet pin numbers (W65C21 40-pin DIP, Figure 2).
const PA = [2, 3, 4, 5, 6, 7, 8, 9];
const PB = [10, 11, 12, 13, 14, 15, 16, 17];
const D = [33, 32, 31, 30, 29, 28, 27, 26]; // D0…D7
const CA1 = 40;
const CA2 = 39;
const RS0 = 36;
const RS1 = 35;
const CS0 = 22;
const CS1 = 24;
const CS2B = 23;
const RWB = 21;
const PHI2 = 25;
const RESB = 34;
const IRQAB = 38;

class Pia {
  constructor() {
    this.u = chipDef("w65c21").logic;
    this.state = this.u.state0();
    this.prev = null;
    // Baseline: everything floats HIGH (asInput of an unconnected pin), PHI2
    // low, chip DESELECTED (CS2B high), not in reset.
    this.pins = new Map();
    for (let n = 1; n <= 40; n++) this.pins.set(n, H);
    this.pins.set(PHI2, L);
  }
  set(pin, lv) {
    this.pins.set(pin, lv);
    return this;
  }
  drive(value) {
    D.forEach((pin, i) => this.set(pin, (value >> i) & 1 ? H : L));
    return this;
  }
  select(read) {
    return this.set(CS0, H)
      .set(CS1, H)
      .set(CS2B, L)
      .set(RWB, read ? H : L);
  }
  deselect() {
    return this.set(CS2B, H);
  }
  addr(rs1, rs0) {
    return this.set(RS1, rs1 ? H : L).set(RS0, rs0 ? H : L);
  }
  tick() {
    const ins = new Map(this.pins);
    this.state = this.u.step(this.state, ins, this.prev);
    this.prev = ins;
    return this;
  }
  out() {
    return this.u.outputs(this.state, this.pins);
  }
  /** Write `value` into the register at (rs1,rs0): latches on the PHI2 fall. */
  write(rs1, rs0, value) {
    this.select(false).addr(rs1, rs0).drive(value);
    this.set(PHI2, H).tick();
    this.set(PHI2, L).tick();
    return this;
  }
  /** Read the register at (rs1,rs0): the bus value driven while PHI2 is high. */
  read(rs1, rs0) {
    this.select(true).addr(rs1, rs0);
    this.set(PHI2, H).tick();
    const o = this.out();
    const v = D.reduce((n, pin, i) => n | (o.get(pin) === H ? 1 << i : 0), 0);
    this.set(PHI2, L).tick();
    return v;
  }
  port(pin) {
    return this.out().get(pin);
  }
}

test("reset floats every peripheral line and releases the interrupts", () => {
  const pia = new Pia();
  pia.set(RESB, L).tick(); // async reset
  const o = pia.out();
  for (const pin of [...PA, ...PB]) assert.equal(o.get(pin), Z, `pin ${pin}`);
  assert.equal(o.get(IRQAB), Z); // open-drain, released
  // All registers zero: reading DDRA (RS=00, CRA bit2=0 after reset) gives 0.
  pia.set(RESB, H);
  assert.equal(pia.read(0, 0), 0x00);
});

test("DDRA + ORA drive Port A; a 0 in the DDR floats that line for input", () => {
  const pia = new Pia();
  pia.write(0, 1, 0x04); // CRA bit2 = 1 → RS=00 now addresses the peripheral reg
  pia.write(0, 0, 0x0f); // …but bit2=1 selects PRA/ORA, not DDRA — see below
  // Set direction: to reach DDRA we need CRA bit2 = 0.
  pia.write(0, 1, 0x00); // CRA = 0 → RS=00 addresses DDRA
  pia.write(0, 0, 0x0f); // DDRA = low nibble output
  pia.write(0, 1, 0x04); // CRA bit2 = 1 → RS=00 addresses ORA
  pia.write(0, 0, 0x55); // ORA = 0101_0101
  const o = pia.out();
  // Low nibble (outputs) drives ORA bits; high nibble floats.
  assert.equal(o.get(PA[0]), H); // ORA bit0 = 1
  assert.equal(o.get(PA[1]), L); // ORA bit1 = 0
  assert.equal(o.get(PA[2]), H);
  assert.equal(o.get(PA[3]), L);
  for (let i = 4; i < 8; i++) assert.equal(o.get(PA[i]), Z, `PA${i} input`);
});

test("reading the peripheral port returns the live pin levels (PIBA)", () => {
  const pia = new Pia();
  pia.write(0, 1, 0x04); // CRA bit2 = 1 → RS=00 = peripheral register
  // DDRA stays 0 (all inputs). Drive the PA pins externally to 0xA5 and read.
  const ext = 0xa5;
  PA.forEach((pin, i) => pia.set(pin, (ext >> i) & 1 ? H : L));
  assert.equal(pia.read(0, 0), ext);
});

test("the control register is written low-6 only; flags (b6/b7) stay read-only", () => {
  const pia = new Pia();
  pia.write(0, 1, 0xff); // try to write CRA = 0xFF
  assert.equal(pia.read(0, 1), 0x3f); // bits 6,7 (flags) remain 0
});

test("a CA1 active edge sets the flag and pulls IRQAB low; a port read clears it", () => {
  const pia = new Pia();
  // CRA: bit0=1 (IRQ enable), bit1=1 (positive edge), bit2=1 (peripheral reg).
  pia.write(0, 1, 0x07);
  assert.equal(pia.port(IRQAB), Z); // idle: released

  // Drive a rising edge on CA1 (needs a prior tick establishing the low level).
  pia.set(CA1, L).tick();
  pia.set(CA1, H).tick();
  assert.equal(pia.read(0, 1) & 0x80, 0x80); // IRQA1 flag (bit 7) set
  assert.equal(pia.port(IRQAB), L); // open-drain asserted

  // Reading the peripheral register (RS=00, CRA bit2=1) clears the flags.
  pia.read(0, 0);
  assert.equal(pia.port(IRQAB), Z);
  assert.equal(pia.read(0, 1) & 0xc0, 0x00);
});

test("a disabled CA1 interrupt still sets the flag but never asserts IRQAB", () => {
  const pia = new Pia();
  pia.write(0, 1, 0x06); // bit0=0 (disabled), bit1=1 (positive edge), bit2=1
  pia.set(CA1, L).tick();
  pia.set(CA1, H).tick();
  assert.equal(pia.read(0, 1) & 0x80, 0x80); // flag set…
  assert.equal(pia.port(IRQAB), Z); // …but IRQ stays released
});

test("CA2 manual output mode drives CA2 from control-register bit 3", () => {
  const pia = new Pia();
  // b5=1 (output), b4=1 (manual), b3=1 → CA2 high; b3=0 → CA2 low.
  pia.write(0, 1, 0x38); // 0011_1000
  assert.equal(pia.port(CA2), H);
  pia.write(0, 1, 0x30); // 0011_0000
  assert.equal(pia.port(CA2), L);
});

test("a deselected PIA leaves the data bus high-impedance", () => {
  const pia = new Pia();
  pia.deselect().set(RWB, H).set(PHI2, H);
  const o = pia.out();
  for (const pin of D) assert.equal(o.get(pin), Z);
});

test("Port B reads ORB for output lines and the pin for input lines", () => {
  const pia = new Pia();
  // DDRB: bit2 = 0 → CRB addresses DDRB.
  pia.write(1, 1, 0x00); // CRB = 0
  pia.write(1, 0, 0xf0); // DDRB = high nibble output
  pia.write(1, 1, 0x04); // CRB bit2 = 1 → peripheral register
  pia.write(1, 0, 0xa0); // ORB = 1010_0000 (only high nibble drives)
  // Drive the low-nibble input pins externally.
  PB.forEach((pin, i) => {
    if (i < 4) pia.set(pin, (0x0c >> i) & 1 ? H : L); // ext low nibble = 1100
  });
  const v = pia.read(1, 0);
  assert.equal(v & 0xf0, 0xa0); // output lines read back ORB
  assert.equal(v & 0x0f, 0x0c); // input lines read the pins
});
