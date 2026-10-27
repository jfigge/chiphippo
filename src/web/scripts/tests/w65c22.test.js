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

// w65c22.test.js — the W65C22 VIA state machine through its catalog def. The
// bench mirrors one engine tick and drives real bus transactions; a whole-cycle
// PHI2 pulse (rise + fall) both advances the interval timers (they decrement on
// the rising edge) and commits a selected bus transfer (on the falling edge).
// Registers are addressed by their 4-bit RS index (Table 2-1).

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, X, Z } from "../sim/levels.js";
import { chipDef } from "../catalog/index.js";

// Datasheet pin numbers (W65C22 40-pin DIP, Figure 3-1).
const PA = [2, 3, 4, 5, 6, 7, 8, 9];
const PB = [10, 11, 12, 13, 14, 15, 16, 17];
const D = [33, 32, 31, 30, 29, 28, 27, 26]; // D0…D7
const CA1 = 40;
const CB1 = 18;
const CB2 = 19;
const RS = [38, 37, 36, 35]; // RS0…RS3
const CS1 = 24;
const CS2B = 23;
const RWB = 22;
const PHI2 = 25;
const RESB = 34;
const IRQB = 21;

// Register indices.
const ORB = 0x0;
const ORA = 0x1;
const DDRB = 0x2;
const DDRA = 0x3;
const T1CL = 0x4;
const T1CH = 0x5;
const T2CL = 0x8;
const T2CH = 0x9;
const SR = 0xa;
const ACR = 0xb;
const PCR = 0xc;
const IFR = 0xd;
const IER = 0xe;

class Via {
  constructor() {
    this.u = chipDef("W65C22").logic;
    this.state = this.u.state0();
    this.prev = null;
    this.pins = new Map();
    for (let n = 1; n <= 40; n++) this.pins.set(n, H);
    this.pins.set(PHI2, L);
  }
  set(pin, lv) {
    this.pins.set(pin, lv);
    return this;
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
  addr(a) {
    RS.forEach((pin, i) => this.set(pin, (a >> i) & 1 ? H : L));
    return this;
  }
  reset() {
    this.set(RESB, L).tick();
    this.set(RESB, H);
    return this;
  }
  write(a, value) {
    this.set(CS1, H).set(CS2B, L).set(RWB, L).addr(a);
    D.forEach((pin, i) => this.set(pin, (value >> i) & 1 ? H : L));
    this.set(PHI2, H).tick();
    this.set(PHI2, L).tick();
    return this;
  }
  read(a) {
    this.set(CS1, H).set(CS2B, L).set(RWB, H).addr(a);
    this.set(PHI2, H).tick();
    const o = this.out();
    const v = D.reduce((n, pin, i) => n | (o.get(pin) === H ? 1 << i : 0), 0);
    this.set(PHI2, L).tick();
    return v;
  }
  /** Advance `n` PHI2 cycles with the chip deselected (timers only). */
  clockPhi(n) {
    this.set(CS2B, H);
    for (let i = 0; i < n; i++) {
      this.set(PHI2, H).tick();
      this.set(PHI2, L).tick();
    }
    return this;
  }
  port(pin) {
    return this.out().get(pin);
  }
  ifr() {
    return this.read(IFR);
  }
}

test("reset floats the ports, clears the registers, releases IRQB", () => {
  const via = new Via().reset();
  const o = via.out();
  for (const pin of [...PA, ...PB]) assert.equal(o.get(pin), Z, `pin ${pin}`);
  assert.equal(o.get(IRQB), Z);
  assert.equal(via.read(DDRB), 0x00);
  assert.equal(via.read(ACR), 0x00);
});

test("DDR + OR drive a port; input lines float", () => {
  const via = new Via().reset();
  via.write(DDRB, 0xff).write(ORB, 0x3c);
  const o = via.out();
  PB.forEach((pin, i) => assert.equal(o.get(pin), (0x3c >> i) & 1 ? H : L));
  // Port A left as inputs → floats; read reflects external pins.
  const ext = 0x99;
  PA.forEach((pin, i) => via.set(pin, (ext >> i) & 1 ? H : L));
  assert.equal(via.read(ORA), ext);
});

test("register round-trips: ACR / PCR / DDRA read back what was written", () => {
  const via = new Via().reset();
  via.write(ACR, 0xa5).write(PCR, 0x5a).write(DDRA, 0x0f);
  assert.equal(via.read(ACR), 0xa5);
  assert.equal(via.read(PCR), 0x5a);
  assert.equal(via.read(DDRA), 0x0f);
});

test("IER: bit 7 sets/clears the marked enables; a read always shows bit 7", () => {
  const via = new Via().reset();
  via.write(IER, 0xc0); // bit7=1 → set the T1 enable (bit6)
  assert.equal(via.read(IER), 0xc0); // read: bit7 forced high + enable bit
  via.write(IER, 0x40); // bit7=0 → clear the T1 enable
  assert.equal(via.read(IER), 0x80);
});

// A bus access is itself a PHI2 cycle, so a `read` advances the timers by one
// before it returns its value. To count cycles unambiguously these tests inspect
// the sequential state directly (via.state) and reserve `read`/`write` for the
// bus-behaviour they are testing (e.g. that reading T1C-L clears the flag).
test("T1 one-shot counts N, N-1 … 0, then $FFFF — where IFR6 sets, N+1.5 cycles after the load", () => {
  // Figure 2-3: the count holds N for the cycle after the T1C-H write, and the
  // flag sets with $FFFF, after which T1 takes its latch again.
  const via = new Via().reset();
  via.write(IER, 0xc0); // enable T1 interrupt
  via.write(T1CL, 3).write(T1CH, 0); // load T1 = 0x0003
  const counts = [];
  for (let i = 0; i < 7; i++) {
    via.clockPhi(1);
    counts.push(via.state.t1c);
  }
  assert.deepEqual(counts, [3, 2, 1, 0, 0xffff, 3, 2]);
  assert.equal(via.state.ifr & 0x40, 0x40, "T1 timed out");
  assert.equal(via.port(IRQB), L); // enabled flag → IRQB asserted
  via.read(T1CL); // reading T1 low-order counter clears the flag
  assert.equal(via.state.ifr & 0x40, 0x00);
  assert.equal(via.port(IRQB), Z);
});

test("T1 free-run times out every N+2 cycles, reloading from the latch", () => {
  // Figure 2-4: N+1.5 cycles from the T1C-H write to the first timeout, then
  // N+2 a period — the $FFFF cycle and the reload one each count.
  const via = new Via().reset();
  via.write(ACR, 0x40); // bit6 = 1 → continuous (free-run)
  via.write(T1CL, 5).write(T1CH, 0); // load T1 = 5
  const fired = [];
  for (let cycle = 1; cycle <= 30; cycle++) {
    via.clockPhi(1);
    if (via.state.ifr & 0x40) {
      fired.push(cycle);
      via.state = { ...via.state, ifr: via.state.ifr & ~0x40 };
    }
  }
  assert.deepEqual(fired, [7, 14, 21, 28], "every N+2 = 7 cycles");
  via.write(IFR, 0x40); // and the flag still clears by writing a 1
  assert.equal(via.state.ifr & 0x40, 0x00);
});

test("T1 PB7 output: low on the load in either mode; high at a one-shot's timeout, toggled by a free run's", () => {
  {
    const via = new Via().reset();
    via.write(ACR, 0x80); // bit7 = 1 (PB7 output), bit6 = 0 (one-shot)
    via.write(T1CL, 2).write(T1CH, 0); // load → PB7 goes low
    assert.equal(via.port(PB[7]), L);
    via.clockPhi(3);
    assert.equal(via.port(PB[7]), L, "still counting");
    via.clockPhi(1); // timeout → PB7 goes high
    assert.equal(via.port(PB[7]), H);
  }
  {
    const via = new Via().reset();
    via.write(ACR, 0xc0); // PB7 output, free run
    via.write(T1CL, 2).write(T1CH, 0);
    assert.equal(via.port(PB[7]), L, "Figure 2-4: low from the write");
    const levels = [];
    for (let i = 0; i < 9; i++) {
      via.clockPhi(1);
      levels.push(via.port(PB[7]) === H ? 1 : 0);
    }
    assert.deepEqual(
      levels,
      [0, 0, 0, 1, 1, 1, 1, 0, 0],
      "a half period of N+2",
    );
  }
});

test("T2 one-shot times out and sets IFR5", () => {
  const via = new Via().reset();
  via.write(IER, 0xa0); // enable T2 (bit5)
  via.write(T2CL, 2).write(T2CH, 0); // load T2 = 2
  // Figure 2-3: N held the cycle after the load, then N-1 … 0, $FFFF (the
  // timeout) — and T2, unlike T1, runs on from there.
  const counts = [];
  for (let i = 0; i < 5; i++) {
    via.clockPhi(1);
    counts.push(via.state.t2c);
    if (i === 2) {
      assert.equal(via.state.ifr & 0x20, 0x00, "no timeout yet");
    }
  }
  assert.deepEqual(counts, [2, 1, 0, 0xffff, 0xfffe]);
  assert.equal(via.state.ifr & 0x20, 0x20, "T2 timed out");
  assert.equal(via.port(IRQB), L);
});

test("IFR flags clear by writing a 1; IRQB is gated by the IER", () => {
  const via = new Via().reset();
  // A CA1 negative edge (PCR default) sets IFR1, but IRQB stays released until
  // the CA1 enable is set in the IER.
  via.set(CA1, H).tick();
  via.set(CA1, L).tick(); // active (negative) edge
  assert.equal(via.read(IFR) & 0x02, 0x02, "CA1 flag set");
  assert.equal(via.port(IRQB), Z, "not enabled → released");
  via.write(IER, 0x82); // enable CA1 (bit1)
  assert.equal(via.port(IRQB), L, "now asserted");
  via.write(IFR, 0x02); // clear CA1 flag
  assert.equal(via.read(IFR) & 0x02, 0x00);
  assert.equal(via.port(IRQB), Z);
});

test("input latching (ACR0) captures Port A at the CA1 active edge", () => {
  const via = new Via().reset();
  via.write(ACR, 0x01); // enable PA input latching
  // Present 0x5A, then trigger the CA1 (negative) edge to latch it.
  PA.forEach((pin, i) => via.set(pin, (0x5a >> i) & 1 ? H : L));
  via.set(CA1, H).tick();
  via.set(CA1, L).tick(); // latch IRA = 0x5A
  // Change the live pins; the read must still return the latched byte.
  PA.forEach((pin) => via.set(pin, H)); // now 0xFF
  assert.equal(via.read(ORA), 0x5a);
});

test("shift register: external CB1 clock shifts eight bits in and sets IFR2", () => {
  const via = new Via().reset();
  via.write(ACR, 0x0c); // SR mode 011 → shift in under external CB1 clock
  via.read(SR); // reading SR arms the shift-in counter (clears IFR2)
  via.set(CS2B, H).set(CB1, L).tick(); // idle the clock low, deselected

  // Clock in 1,0,1,0,1,0,1,0 (LSB-first into bit 0, marching toward bit 7).
  const bits = [1, 0, 1, 0, 1, 0, 1, 0];
  for (const bitv of bits) {
    via.set(CB2, bitv ? H : L);
    via.set(CB1, H).tick(); // rising edge shifts
    via.set(CB1, L).tick();
  }
  assert.equal(via.read(IFR) & 0x04, 0x04, "SR flag set after 8 shifts");
  assert.equal(via.read(SR), 0xaa); // first bit shifted ends at bit 7
});

/** CB1 and CB2 as the VIA drives them after each tick of `run`. */
function traceCb(via, run) {
  const log = [];
  const tick = via.tick.bind(via);
  via.tick = () => {
    tick();
    const o = via.out();
    log.push({ cb1: o.get(CB1), cb2: o.get(CB2) });
    return via;
  };
  run();
  via.tick = tick;
  return log;
}

test("shift register, internal clock: EIGHT CB1 pulses a byte, the bit steady at each rise", () => {
  // "Eight shift pulses are placed on the CB1 line" — CB1 low for one PHI2
  // cycle, high for the next (Figures 2-7, 2-11); a shift-out mode's bit goes
  // onto CB2 as CB1 falls, so a receiver latching on the rise takes it whole.
  for (const acr of [0x18 /* 110 PHI2 */, 0x14 /* 101 T2 */]) {
    const via = new Via().reset();
    via.write(ACR, acr);
    const log = traceCb(via, () => via.write(SR, 0xa5).clockPhi(20));
    let rises = 0;
    const taken = [];
    log.forEach((e, i) => {
      if (i > 0 && log[i - 1].cb1 === L && e.cb1 === H) {
        rises++;
        taken.push(log[i - 1].cb2 === H ? 1 : 0);
      }
    });
    assert.equal(rises, 8, `ACR ${acr.toString(16)}: eight pulses`);
    assert.equal(taken.join(""), "10100101", "MSB first, every bit");
    assert.equal(via.read(IFR) & 0x04, 0x04, "IFR2 after the eighth");
    assert.equal(via.out().get(CB1), H, "and the clock stops high");
  }
  // Shift IN under PHI2 (010): eight pulses, a bit taken at each rise.
  const via = new Via().reset();
  via.write(ACR, 0x08);
  via.read(SR); // starts the eight
  const bits = [1, 1, 0, 1, 0, 0, 1, 0];
  let rises = 0;
  let last = via.out().get(CB1);
  via.set(CS2B, H);
  for (let i = 0; i < 20; i++) {
    via.set(CB2, bits[rises] ? H : L);
    via.set(PHI2, H).tick().set(PHI2, L).tick();
    const now = via.out().get(CB1);
    if (last === L && now === H) rises++;
    last = now;
  }
  assert.equal(rises, 8);
  assert.equal(via.state.sr, 0b11010010, "first bit in ends at bit 7");
  assert.equal(via.state.ifr & 0x04, 0x04);
});

test("shift register, external clock OUT (111): CB2 changes as CB1 falls, ready for the rise", () => {
  // Figure 2-12. Shifted on the rise, CB2 changed on the very edge a receiver
  // latches on, and it got 11010010 for $A5.
  const via = new Via().reset();
  via.write(ACR, 0x1c);
  via.write(SR, 0xa5);
  via.set(CS2B, H).set(CB1, H).tick();
  const taken = [];
  for (let i = 0; i < 8; i++) {
    via.set(CB1, L).tick();
    taken.push(via.out().get(CB2) === H ? 1 : 0); // what the rise will latch
    via.set(CB1, H).tick();
  }
  assert.equal(taken.join(""), "10100101");
  assert.equal(via.state.ifr & 0x04, 0x04, "IFR2 at the eighth rise");
});

test("CA2 pulse mode: low for the cycle after an ORA write, then high — selected or not", () => {
  const CA2 = 39;
  const via = new Via().reset();
  via.write(PCR, 0x0a); // CA2 = 101, pulse output
  via.write(ORA, 0x55);
  assert.equal(via.out().get(CA2), L, "the pulse");
  via.clockPhi(1); // a cycle that touches some other chip
  assert.equal(via.out().get(CA2), H, "restored on the next PHI2 fall");
  via.clockPhi(3);
  assert.equal(via.out().get(CA2), H);
});

test("an unknown chip select or PHI2 during a read puts X on the bus, not a deselected float (the regrade, 2026-10-26)", () => {
  const via = new Via();
  via.set(CS1, H).set(CS2B, L).set(RWB, H).addr(ORA).set(PHI2, H);
  for (const [pin, lv] of [
    [CS1, X],
    [CS2B, X],
    [PHI2, X],
    [RWB, X],
  ]) {
    const was = via.pins.get(pin);
    via.set(pin, lv);
    const o = via.out();
    for (const d of D)
      assert.equal(o.get(d), X, `pin ${pin} unknown: D${D.indexOf(d)}`);
    via.set(pin, was);
  }
  // …and one select definitely off still floats it, whatever else is unknown.
  via.set(PHI2, X).set(CS1, L);
  for (const d of D) assert.equal(via.out().get(d), Z);
});
