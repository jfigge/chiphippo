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

// engine-io.test.js — the W65C21 PIA and W65C22 VIA driven through the PURE
// two-phase engine on a real breadboard doc: a DIP-40 seated on a pin-board,
// powered from rails, PHI2 from a manual clock. Proves the whole pipeline —
// power-gating a 40-pin chip, resolving its bidirectional data bus + I/O ports
// through the netlist, latching a write on PHI2's falling edge, and driving the
// bus during a read. The state machines themselves are covered exhaustively in
// w65c21.test.js / w65c22.test.js; this is the wiring + engine-integration check.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, Z } from "../sim/levels.js";
import { tick as engineTick, CHIP_STATUS } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";
import { chipDef } from "../catalog/index.js";

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
/** A free wiring hole on the strip carrying `pin`. */
const at = (holes, pin) => `bb1.${mates(holes.get(pin))[0]}`;
const HI = (k) => `bb2.+${k}`;
const LO = (k) => `bb3.-${k}`;

/**
 * A single-chip bench: place `ref` at `e10`, wire power (unless `powered` is
 * false / `volts` set), the control pins per `ctl` (pin → "H"/"L"/"clk"), and
 * `bus` (a byte the external side drives on D0–D7, or null to leave the bus for
 * the chip). Auto-allocates distinct rail holes (all + holes share the + rail
 * net; the index only keeps two wires off the same hole).
 */
function bench(ref, { ctl, bus = null, powered = true, volts = 5, seed }) {
  const P = PINS[ref];
  const h = holesOf(ref, "e10");
  let hi = 1;
  let lo = 1;
  const wires = [];
  const push = (from, to) => wires.push({ id: `w${wires.length}`, from, to });
  push("psu1.+", HI(hi++));
  push("psu1.-", LO(lo++));
  if (powered) push(at(h, P.VCC), HI(hi++));
  push(at(h, P.GND), LO(lo++));
  push("clk1.gnd", LO(lo++));

  for (const [name, level] of Object.entries(ctl)) {
    const pin = P[name];
    if (level === "clk") push(at(h, pin), "clk1.out");
    else if (level === "H") push(at(h, pin), HI(hi++));
    else push(at(h, pin), LO(lo++));
  }
  if (bus != null) {
    P.D.forEach((pin, i) =>
      push(at(h, pin), (bus >> i) & 1 ? HI(hi++) : LO(lo++)),
    );
  }

  const doc = {
    boards,
    components: [
      psu("psu1", 80, volts),
      clock("clk1", 90),
      chip("c1", ref, "e10"),
    ],
    wires,
  };
  return new Bench(doc, h, ref, seed);
}

class Bench {
  constructor(doc, holes, ref, seed) {
    this.doc = doc;
    this.holes = holes;
    this.pins = PINS[ref];
    this.netlist = buildNetlist(doc);
    this.warm = new Map();
    this.state = new Map();
    if (seed) this.state.set("c1", { ...chipDef(ref).logic.state0(), ...seed });
    this.prev = new Map();
  }
  tick(clk = L) {
    const r = engineTick({
      document: this.doc,
      netlist: this.netlist,
      warmStart: this.warm,
      state: this.state,
      prevPinLevels: this.prev,
      clockPhase: new Map([["clk1", clk]]),
      images: new Map(),
    });
    this.warm = r.netLevels;
    this.state = r.state;
    this.prev = r.pinLevels;
    this.last = r;
    return r;
  }
  status() {
    return this.last.chipStatus.get("c1")?.status;
  }
  chipState() {
    return this.state.get("c1");
  }
  level(pin) {
    return this.warm.get(
      this.netlist.netOfPoint.get(`bb1.${this.holes.get(pin)}`),
    );
  }
  busWord() {
    return this.pins.D.reduce(
      (n, pin, i) => n + (this.level(pin) === H ? 1 << i : 0),
      0,
    );
  }
}

// Pin numbers, keyed for the bench (see catalog/chips-io.js).
const PINS = {
  w65c21: {
    VCC: 20,
    GND: 1,
    CS0: 22,
    CS1: 24,
    CS2B: 23,
    RS0: 36,
    RS1: 35,
    RWB: 21,
    PHI2: 25,
    RESB: 34,
    D: [33, 32, 31, 30, 29, 28, 27, 26],
    PA: [2, 3, 4, 5, 6, 7, 8, 9],
  },
  w65c22: {
    VCC: 20,
    GND: 1,
    CS1: 24,
    CS2B: 23,
    RS0: 38,
    RS1: 37,
    RS2: 36,
    RS3: 35,
    RWB: 22,
    PHI2: 25,
    RESB: 34,
    D: [33, 32, 31, 30, 29, 28, 27, 26],
    PB: [10, 11, 12, 13, 14, 15, 16, 17],
  },
};

// ── PIA: a write lands in the addressed register on PHI2's falling edge ────────

/** RS=00 with CRA bit 2 = 0 (reset) selects DDRA. Write 0x2A there. */
function piaWrite(opts) {
  return bench("w65c21", {
    ctl: {
      CS0: "H",
      CS1: "H",
      CS2B: "L",
      RS0: "L",
      RS1: "L",
      RWB: "L", // write
      RESB: "H",
      PHI2: "clk",
    },
    bus: 0x2a,
    ...opts,
  });
}

test("a powered PIA latches a register write on PHI2's falling edge", () => {
  const b = piaWrite({});
  b.tick(H); // PHI2 high
  b.tick(L); // falling edge → the write commits
  assert.equal(b.status(), CHIP_STATUS.OK);
  assert.equal(b.chipState().ddra, 0x2a);
});

test("an unpowered PIA is inert — nothing latches", () => {
  const b = piaWrite({ powered: false });
  b.tick(H);
  b.tick(L);
  assert.equal(b.status(), CHIP_STATUS.UNPOWERED);
  assert.equal(b.chipState().ddra, 0x00);
});

test("12 V smokes the PIA (damaged) and it latches nothing", () => {
  const b = piaWrite({ volts: 12 });
  b.tick(H);
  b.tick(L);
  assert.equal(b.status(), CHIP_STATUS.DAMAGED);
  assert.equal(b.chipState().ddra, 0x00);
});

test("a PIA drives its Port A output lines onto the breadboard nets", () => {
  // Seed DDRA = 0xFF (all outputs), ORA = 0x5A; the chip should drive PA to 0x5A.
  const b = bench("w65c21", {
    ctl: { CS2B: "H", RESB: "H", PHI2: "clk" }, // deselected; just holding
    seed: { ddra: 0xff, ora: 0x5a },
  });
  b.tick(L);
  const P = PINS.w65c21;
  P.PA.forEach((pin, i) =>
    assert.equal(b.level(pin), (0x5a >> i) & 1 ? H : L, `PA${i}`),
  );
});

// ── VIA: read drives the data bus; power gating; a port output ────────────────

test("a powered VIA drives the data bus during a read (IER reads 0x80)", () => {
  // RS = 0xE (IER); a reset VIA reads IER as 0x80 (bit 7 forced high).
  const b = bench("w65c22", {
    ctl: {
      CS1: "H",
      CS2B: "L",
      RS0: "L",
      RS1: "H",
      RS2: "H",
      RS3: "H", // 0b1110 = 0xE
      RWB: "H", // read
      RESB: "H",
      PHI2: "clk",
    },
  });
  b.tick(H); // PHI2 high → the VIA drives D0–D7
  assert.equal(b.status(), CHIP_STATUS.OK);
  assert.equal(b.busWord(), 0x80);
  b.tick(L); // PHI2 low → the bus is released
  for (const pin of PINS.w65c22.D)
    assert.equal(b.level(pin), Z, `D pin ${pin}`);
});

test("an unpowered VIA never drives the bus", () => {
  const b = bench("w65c22", {
    ctl: {
      CS1: "H",
      CS2B: "L",
      RS0: "L",
      RS1: "H",
      RS2: "H",
      RS3: "H",
      RWB: "H",
      RESB: "H",
      PHI2: "clk",
    },
    powered: false,
  });
  b.tick(H);
  assert.equal(b.status(), CHIP_STATUS.UNPOWERED);
  for (const pin of PINS.w65c22.D) assert.equal(b.level(pin), Z);
});

test("a VIA drives its Port B output lines onto the breadboard nets", () => {
  const b = bench("w65c22", {
    ctl: { CS2B: "H", RESB: "H", PHI2: "clk" },
    seed: { ddrb: 0xff, orb: 0x3c },
  });
  b.tick(L);
  PINS.w65c22.PB.forEach((pin, i) =>
    assert.equal(b.level(pin), (0x3c >> i) & 1 ? H : L, `PB${i}`),
  );
});

// ── A minimal computer: W65C02 CPU + one 8K RAM holding program + vectors ──────
// The whole 65xx pipeline end-to-end — the CPU boots from the reset vector,
// fetches/executes through the shared address + data buses (resolved by the
// netlist), and writes back to RAM. Only A0–A12 are wired, so the high address
// bits are ignored and the RAM mirrors across the 64K space (the reset vector at
// $FFFC lands at image[$1FFC]); CE/OE are tied low and WE follows the CPU's RWB.

// Address-line pin lists, LSB→A12.
const CPU_A = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22];
const RAM_A = [1, 2, 3, 4, 5, 6, 7, 8, 21, 22, 23, 24, 25];
const CPU_D = [33, 32, 31, 30, 29, 28, 27, 26];
const RAM_D = [9, 10, 11, 12, 13, 17, 18, 19];

class Computer {
  constructor(image) {
    const cpu = holesOf("w65c02", "e10");
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
    push(cAt(8), HI(hi++)); // CPU VDD
    push(cAt(21), LO(lo++)); // CPU VSS
    push(rAt(28), HI(hi++)); // RAM VCC
    push(rAt(14), LO(lo++)); // RAM GND

    for (let i = 0; i < 13; i++) push(cAt(CPU_A[i]), rAt(RAM_A[i])); // address bus
    for (let i = 0; i < 8; i++) push(cAt(CPU_D[i]), rAt(RAM_D[i])); // data bus
    push(cAt(34), rAt(20)); // CPU RWB → RAM WE
    push(rAt(26), LO(lo++)); // RAM CE low (always selected)
    push(rAt(27), LO(lo++)); // RAM OE low (output enabled on reads)

    push(cAt(37), "clk1.out"); // PHI2 ← clock
    for (const p of [40, 36, 2, 4, 6]) push(cAt(p), HI(hi++)); // RESB/BE/RDY/IRQB/NMIB high

    this.doc = {
      boards,
      components: [
        psu("psu1", 80),
        clock("clk1", 90),
        chip("c1", "w65c02", "e10"),
        chip("c2", "ram-8k", "e35"),
      ],
      wires: w,
    };
    this.netlist = buildNetlist(this.doc);
    this.warm = new Map();
    this.state = new Map();
    this.prev = new Map();
    this.images = new Map([["c2", image]]);
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
    for (const { compId, addr, value } of r.memWrites) {
      const img = this.images.get(compId);
      if (img && addr < img.length) img[addr] = value;
    }
  }
  clock(n = 1) {
    for (let i = 0; i < n; i++) {
      this.tick(H);
      this.tick(L);
    }
  }
  cpu() {
    return this.state.get("c1");
  }
}

test("a W65C02 + RAM computer boots the reset vector and runs a program", () => {
  const image = new Uint8Array(8192);
  // $0200: LDA #$42 ; STA $0600 ; JMP $0205 (self-loop)
  image.set([0xa9, 0x42, 0x8d, 0x00, 0x06, 0x4c, 0x05, 0x02], 0x0200);
  image[0x1ffc] = 0x00; // reset vector low  → $0200
  image[0x1ffd] = 0x02; // reset vector high

  const pc = new Computer(image);
  pc.clock(24); // reset (2) + LDA (2) + STA (4) + settle into the loop, with margin

  assert.equal(pc.cpu().a, 0x42, "A loaded the immediate");
  assert.equal(image[0x0600], 0x42, "STA wrote through the bus into RAM");
  // PC has reached the self-loop at $0205.
  assert.equal(pc.cpu().pc, 0x0205, "executing the JMP self-loop");
});
