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

// engine-lcd.test.js — the HD44780 LCD module driven through the PURE two-phase
// engine, proving the whole pipeline: a desk BRICK participates (brickPinAddresses),
// its VDD/VSS power-gate it like a chip, it latches a bus byte on E's falling
// edge (clock-driven), drives the bus during a read, and its sequential state
// derives a framebuffer. The circuit is built in code: rails + PSU + a manual
// clock on E + the LCD brick.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, Z } from "../sim/levels.js";
import { tick as engineTick, CHIP_STATUS } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { framebufferOf } from "../sim/hd44780.js";

const railTop = { id: "bb2", type: "rail-full", x: 0, y: 0 };
const railBottom = { id: "bb3", type: "rail-full", x: 0, y: 18 };

/**
 * Build a doc wiring an LCD brick to power rails, a manual clock on E, RS/RW as
 * requested, and (when `data` is set) the 8-bit bus driven from the rails.
 * `powered` false leaves VDD off; `volts` sets the supply (12 → magic smoke).
 */
function lcdDoc({ rs = L, rw = L, data = null, powered = true, volts = 5 }) {
  const wires = [];
  let n = 0;
  const wire = (from, to) =>
    wires.push({ id: `w${++n}`, from, to, color: "black" });
  const hi = (k) => `bb2.+${k}`;
  const lo = (k) => `bb3.-${k}`;

  wire("psu1.+", hi(1));
  wire("psu1.-", lo(1));
  if (powered) wire("lcd1.VDD", hi(2));
  wire("lcd1.VSS", lo(2));
  wire("lcd1.RS", rs === H ? hi(3) : lo(3));
  wire("lcd1.RW", rw === H ? hi(4) : lo(4));
  wire("lcd1.E", "clk1.out");
  wire("clk1.gnd", lo(5));
  if (data != null) {
    for (let i = 0; i < 8; i++) {
      wire(`lcd1.DB${i}`, (data >> i) & 1 ? hi(10 + i) : lo(10 + i));
    }
  }

  return {
    boards: [railTop, railBottom],
    components: [
      { id: "psu1", kind: "psu", ref: "psu", x: 40, y: 0, params: { volts } },
      {
        id: "clk1",
        kind: "clock",
        ref: "clock",
        x: 60,
        y: 0,
        params: { hz: "manual" },
      },
      {
        id: "lcd1",
        kind: "lcd",
        ref: "lcd",
        x: 0,
        y: 30,
        params: { size: "16x2" },
      },
    ],
    wires,
  };
}

/** A stepping harness that drives the clock phase (E) each tick. */
class LcdBench {
  constructor(doc) {
    this.doc = doc;
    this.netlist = buildNetlist(doc);
    this.warm = new Map();
    this.state = new Map();
    this.prev = new Map();
  }
  tick(clkLevel) {
    const r = engineTick({
      document: this.doc,
      netlist: this.netlist,
      warmStart: this.warm,
      state: this.state,
      prevPinLevels: this.prev,
      clockPhase: new Map([["clk1", clkLevel]]),
      images: new Map(),
    });
    this.warm = r.netLevels;
    this.state = r.state;
    this.prev = r.pinLevels;
    this.last = r;
    return r;
  }
  /** One E pulse: hold high, then drop — the write latches on the fall. */
  pulseE() {
    this.tick(H);
    return this.tick(L);
  }
  lcd() {
    return this.state.get("lcd1");
  }
  status() {
    return this.last.chipStatus.get("lcd1")?.status;
  }
  level(addr) {
    return this.warm.get(this.netlist.netOfPoint.get(addr));
  }
}

test("a powered LCD latches a bus byte on E's falling edge and renders it", () => {
  // Default state has AC=0, target=DDRAM — a data write lands at DDRAM[0].
  const bench = new LcdBench(lcdDoc({ rs: H, rw: L, data: 0x41 })); // 'A'
  bench.pulseE();
  assert.equal(bench.status(), CHIP_STATUS.OK);
  assert.equal(bench.lcd().ddram[0], 0x41);
  assert.equal(bench.lcd().ac, 1);
  const fb = framebufferOf(bench.lcd(), { size: "16x2" });
  assert.equal(fb.chars[0], 0x41);
});

test("a display-on command sets displayOn in the derived framebuffer", () => {
  const bench = new LcdBench(lcdDoc({ rs: L, rw: L, data: 0x0c })); // display on
  bench.pulseE();
  assert.equal(bench.lcd().displayOn, true);
  assert.equal(framebufferOf(bench.lcd(), { size: "16x2" }).displayOn, true);
});

test("an unpowered LCD holds — no VDD, no latch", () => {
  const bench = new LcdBench(
    lcdDoc({ rs: H, rw: L, data: 0x41, powered: false }),
  );
  bench.pulseE();
  assert.equal(bench.status(), CHIP_STATUS.UNPOWERED);
  assert.equal(bench.lcd().ddram[0], 0x20); // still a space — nothing latched
});

test("12 V smokes the LCD (damaged) and it latches nothing", () => {
  const bench = new LcdBench(lcdDoc({ rs: H, rw: L, data: 0x41, volts: 12 }));
  bench.pulseE();
  assert.equal(bench.status(), CHIP_STATUS.DAMAGED);
  assert.equal(bench.lcd().ddram[0], 0x20);
});

test("during a status read the LCD drives the bus; DB7 (busy) is always low", () => {
  // RS=0, RW=1: a status read. Leave DB unwired so the module owns the bus.
  const bench = new LcdBench(lcdDoc({ rs: L, rw: H, data: null }));
  bench.tick(H); // E high → the module drives DB0–DB7
  assert.equal(bench.level("lcd1.DB7"), L); // busy flag = 0 (ready)
  // E low → the module releases the bus (floats), so an external can drive it.
  bench.tick(L);
  assert.equal(bench.level("lcd1.DB7"), Z);
});
