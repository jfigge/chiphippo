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

// engine-z80.test.js — a Z80A + 8K RAM computer driven through the PURE
// two-phase engine on a real breadboard doc. The instruction set itself is
// covered in z80.test.js; this is the wiring + engine-integration check, and it
// exercises the things a Z80 bench does that the 65xx one cannot:
//
//   • /MREQ drives the RAM's chip select and /RD//WR its output-enable and
//     write, where the 65xx fixture ties CE/OE low and hangs WE off RWB. That
//     matters, because it means a REFRESH cycle must not read as a memory
//     access: /MREQ pulses low again in T3/T4 while /RD stays high, so /OE is
//     high and the RAM does not drive. If that were wrong the bus would fight
//     the CPU's own refresh address every single fetch.
//   • The transport ticks once per clock EDGE, which is what gives sim/z80.js
//     its half-T resolution — so this fixture clocks whole cycles as an H then
//     an L tick, exactly as SimController does.
//
// Only A0-A12 are wired, so the RAM mirrors across the 64K space and a program
// at $0000 is simply what the CPU boots into — a Z80 has no reset vector.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, Z } from "../sim/levels.js";
import { tick as engineTick, CHIP_STATUS } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";

const boards = [
  { id: "bb1", type: "pins-full", x: 0, y: 4 },
  { id: "bb2", type: "rail-full", x: 0, y: 0 },
  { id: "bb3", type: "rail-full", x: 0, y: 18 },
];
const psu = (id, x, volts = 5) => ({
  id,
  kind: "psu",
  ref: "psu",
  x,
  y: 0,
  params: { volts },
});
const clock = (id, x) => ({
  id,
  kind: "clock",
  ref: "clock",
  x,
  y: 0,
  params: { hz: "manual" },
});
const chip = (id, ref, anchor) => ({
  id,
  kind: "chip",
  ref,
  board: "bb1",
  anchor,
  params: {},
});

function holesOf(ref, anchor) {
  const m = new Map();
  for (const { pin, hole } of partPinHoles(ref, anchor)) m.set(pin, hole);
  return m;
}
const mates = (hole) =>
  holesOfNode("pins-full", nodeOf("pins-full", hole)).filter((h) => h !== hole);
const HI = (k) => `bb2.+${k}`;
const LO = (k) => `bb3.-${k}`;

// Address-line pin lists, LSB→A12. The Z80's A0-A10 sit on pins 30-40 and its
// A11-A15 wrap round to pins 1-5, so this run crosses the package.
const CPU_A = [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 1, 2];
const RAM_A = [1, 2, 3, 4, 5, 6, 7, 8, 21, 22, 23, 24, 25];
const CPU_D = [14, 15, 12, 8, 7, 9, 10, 13]; // D0…D7 — the scrambled bus
const RAM_D = [9, 10, 11, 12, 13, 17, 18, 19];

// Z80 control pins.
const CLK = 6;
const MREQ = 19;
const RD = 21;
const WR = 22;
const M1 = 27;
const RFSH = 28;
const BUSACK = 23;
const IDLE_HIGH = [16, 17, 24, 25, 26]; // /INT /NMI /WAIT /BUSRQ /RESET

class Computer {
  constructor(image, { volts = 5 } = {}) {
    const cpu = holesOf("Z80A", "e10");
    const ram = holesOf("ram-8k", "e35");
    const cAt = (pin) => `bb1.${mates(cpu.get(pin))[0]}`;
    const rAt = (pin) => `bb1.${mates(ram.get(pin))[0]}`;
    const w = [];
    const push = (from, to) => w.push({ id: `w${w.length}`, from, to });
    let hi = 1;
    let lo = 1;

    push("psu1.+", HI(hi++));
    push("psu1.-", LO(lo++));
    push("clk1.gnd", LO(lo++));
    push(cAt(11), HI(hi++)); // CPU +5V
    push(cAt(29), LO(lo++)); // CPU GND
    push(rAt(28), HI(hi++)); // RAM VCC
    push(rAt(14), LO(lo++)); // RAM GND

    for (let i = 0; i < 13; i++) push(cAt(CPU_A[i]), rAt(RAM_A[i]));
    for (let i = 0; i < 8; i++) push(cAt(CPU_D[i]), rAt(RAM_D[i]));

    // The Z80 gives real chip-select and strobe lines, so wire them as such.
    push(cAt(MREQ), rAt(26)); // /MREQ → RAM /CE
    push(cAt(RD), rAt(27)); // /RD   → RAM /OE
    push(cAt(WR), rAt(20)); // /WR   → RAM /WE

    push(cAt(CLK), "clk1.out");
    for (const p of IDLE_HIGH) push(cAt(p), HI(hi++));

    this.doc = {
      boards,
      components: [
        psu("psu1", 80, volts),
        clock("clk1", 90),
        chip("c1", "Z80A", "e10"),
        chip("c2", "ram-8k", "e35"),
      ],
      wires: w,
    };
    this.cpuHole = cAt;
    this.netlist = buildNetlist(this.doc);
    this.warm = new Map();
    this.state = new Map();
    this.prev = new Map();
    this.images = new Map([["c2", image]]);
    this.last = null;
  }
  tick(clk) {
    const r = engineTick({
      document: this.doc,
      netlist: this.netlist,
      warmStart: this.warm,
      state: this.state,
      prevPinLevels: this.prev,
      clockPhase: new Map([["clk1", clk]]),
      images: this.images,
    });
    this.warm = r.netLevels;
    this.state = r.state;
    this.prev = r.pinLevels;
    this.last = r;
    for (const { compId, addr, value } of r.memWrites) {
      const img = this.images.get(compId);
      if (img && addr < img.length) img[addr] = value;
    }
    return r;
  }
  /** One whole clock CYCLE — two engine ticks, as the transport drives it. */
  clock(n = 1) {
    for (let i = 0; i < n; i++) {
      this.tick(H);
      this.tick(L);
    }
  }
  cpu() {
    return this.state.get("c1");
  }
  /**
   * The level on the NET a CPU pin sits on — i.e. what the rest of the circuit
   * actually sees. Deliberately not `pinLevels`, which carries only `input`
   * and `io` pins (chip-eval.js `inputLevels`) and so can never answer a
   * question about an OUTPUT. An unwired output still owns its own one-node
   * net, so this reads those too.
   */
  pin(n) {
    const net = this.netlist.netOfPoint.get(this.cpuHole(n));
    return this.last.netLevels.get(net) ?? Z;
  }
}

test("a Z80A + RAM computer boots at $0000 and runs a program", () => {
  const image = new Uint8Array(8192);
  // LD A,$42 ; LD ($0600),A ; LD B,$07 ; HALT
  image.set([0x3e, 0x42, 0x32, 0x00, 0x06, 0x06, 0x07, 0x76], 0);

  const c = new Computer(image);
  c.clock(60);

  assert.equal(c.cpu().a, 0x42, "A loaded");
  assert.equal(image[0x0600], 0x42, "and written back to RAM through the bus");
  assert.equal(c.cpu().b, 0x07, "execution carried on past the store");
  assert.equal(c.cpu().halted, true, "and reached the HALT");
});

test("/HALT asserts on the pin, not just in the state", () => {
  const image = new Uint8Array(8192);
  image.set([0x76], 0); // HALT
  const c = new Computer(image);
  c.clock(20);
  assert.equal(c.cpu().halted, true);
  assert.equal(c.pin(18), L, "/HALT is driven low");
});

test("a refresh cycle is NOT a memory read — /MREQ pulses but /RD does not", () => {
  // The whole reason this bench wires /MREQ to /CE and /RD to /OE. If the RAM
  // saw the refresh as a read it would drive the bus against the CPU's own
  // refresh address on every fetch.
  const image = new Uint8Array(8192);
  image.set([0x00, 0x00, 0x00, 0x00], 0); // NOPs
  const c = new Computer(image);

  let sawRefresh = false;
  for (let i = 0; i < 40 && !sawRefresh; i++) {
    c.tick(H);
    const s = c.cpu();
    if (s.mk === "M1" && s.t >= 3) {
      sawRefresh = true;
      assert.equal(c.pin(RFSH), L, "/RFSH asserted during the refresh");
      assert.equal(c.pin(RD), H, "/RD released — the RAM must not drive");
      assert.equal(c.pin(M1), H, "/M1 released too");
    }
    c.tick(L);
  }
  assert.ok(sawRefresh, "a refresh half-cycle was observed");
});

test("/M1 marks an opcode fetch and is high on a data read", () => {
  const image = new Uint8Array(8192);
  image.set([0x3e, 0x42, 0x00], 0); // LD A,$42 — a fetch then an operand read
  const c = new Computer(image);

  let sawFetch = false;
  let sawRead = false;
  for (let i = 0; i < 40; i++) {
    c.tick(H);
    const s = c.cpu();
    if (s.mk === "M1" && s.t <= 2 && !sawFetch) {
      sawFetch = true;
      assert.equal(c.pin(M1), L, "/M1 low during the fetch");
    }
    // From T2 on — /MREQ and /RD assert at T1's FALLING edge, so at (T1, high)
    // they are still correctly released.
    if (s.mk === "READ" && s.t >= 2 && !sawRead) {
      sawRead = true;
      assert.equal(c.pin(M1), H, "/M1 high on the operand read");
      assert.equal(c.pin(RD), L, "but /RD is asserted");
      assert.equal(c.pin(RFSH), H, "and a data read has no refresh");
    }
    c.tick(L);
  }
  assert.ok(sawFetch && sawRead, "both cycle kinds were observed");
});

test("/BUSRQ hands the buses over and asserts /BUSACK", () => {
  const image = new Uint8Array(8192);
  image.set([0x00, 0x00, 0x00, 0x00], 0);
  const c = new Computer(image);
  c.clock(6);

  // Re-wire /BUSRQ (pin 25) to the ground rail and rebuild the netlist — the
  // simplest way to assert it in a document-level fixture.
  const busrq = c.cpuHole(25);
  const wire = c.doc.wires.find((x) => x.from === busrq);
  wire.to = LO(9);
  c.netlist = buildNetlist(c.doc);
  c.clock(8);

  assert.equal(c.cpu().mk, "BUSACK", "the CPU gave up the bus");
  assert.equal(c.pin(BUSACK), L, "/BUSACK asserted");
  assert.equal(c.pin(30), Z, "A0 floating");
  assert.equal(c.pin(MREQ), Z, "/MREQ floating — a hand-over, not an enable");
  assert.equal(c.pin(RD), Z, "/RD floating");
});

test("an unpowered CPU is inert and drives nothing", () => {
  const image = new Uint8Array(8192);
  image.set([0x3e, 0x42, 0x32, 0x00, 0x06], 0);
  const c = new Computer(image, { volts: 3 });
  c.clock(40);

  assert.equal(c.last.chipStatus.get("c1")?.status, CHIP_STATUS.UNDERPOWERED);
  assert.equal(image[0x0600], 0, "nothing was written");
});

test("a 12 V CPU is reported damaged and stops driving the bus", () => {
  const image = new Uint8Array(8192);
  image.set([0x3e, 0x42, 0x32, 0x00, 0x06], 0);
  const c = new Computer(image, { volts: 12 });
  c.clock(40);

  assert.equal(c.last.chipStatus.get("c1")?.status, CHIP_STATUS.DAMAGED);
  assert.equal(image[0x0600], 0, "nothing was written");
});
