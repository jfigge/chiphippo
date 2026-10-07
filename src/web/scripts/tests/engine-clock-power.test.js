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

// engine-clock-power.test.js — a clock brick runs from a supply like any
// instrument on the bench (Jason, 2026-10-07): its `vcc` on a PSU `+`, its
// `gnd` on a `−`. Unpowered it drives nothing — in BOTH engines — and one
// wired into the circuit says so; under Spice Lite its HIGH is its own
// supply's voltage, and a signal flag's the lowest supply it feeds.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, Z } from "../sim/levels.js";
import { ENGINES } from "../sim/engines.js";
import { buildNetlist } from "../sim/netlist.js";
import { bench, runner } from "./timing-fixtures.js";

const close = (actual, expected, rel, what) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * rel,
    `${what}: ${actual} vs ${expected}`,
  );

/** A clock driving a 74LS04's 1A; `power` wires its vcc/gnd to the rails. */
function clocked({ power = true, wireOut = true } = {}) {
  const b = bench();
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 40, y: 30, params: { hz: "manual" } }); // prettier-ignore
  const u = b.seat("u1", "74LS04", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  if (wireOut) b.doc.wires.push({ id: "wc", from: "clk1.out", to: b.at(u.get(1).replace(/^e/, "a")), color: "orange" }); // prettier-ignore
  if (power) {
    b.vcc(u.get(14));
    b.doc.wires.at(-1).from = "clk1.vcc";
    b.gnd(u.get(7));
    b.doc.wires.at(-1).from = "clk1.gnd";
  }
  return { b, u };
}

const tickAt = (doc, engine, level) =>
  ENGINES[engine].tick({
    document: doc,
    netlist: buildNetlist(doc),
    clockPhase: new Map([["clk1", level]]),
  });

for (const engine of ["digital", "spice"]) {
  test(`${engine}: a powered clock drives its out net`, () => {
    const { b, u } = clocked();
    const net = (r) => r.netLevels.get(buildNetlist(b.doc).netOfPoint.get(b.at(u.get(1)))); // prettier-ignore
    assert.equal(net(tickAt(b.doc, engine, H)), H);
    assert.equal(net(tickAt(b.doc, engine, L)), L);
    const r = tickAt(b.doc, engine, H);
    assert.equal(r.clockSupply.get("clk1"), 5);
    assert.equal(
      r.warnings.some((w) => w.type === "clock-unpowered"),
      false,
    );
  });

  test(`${engine}: an unpowered clock drives nothing, and says so once wired`, () => {
    const { b, u } = clocked({ power: false });
    const r = tickAt(b.doc, engine, H);
    const at = buildNetlist(b.doc).netOfPoint.get(b.at(u.get(1)));
    assert.equal(r.netLevels.get(at), Z, "out floats");
    assert.equal(r.clockSupply.get("clk1"), null);
    const w = r.warnings.filter((x) => x.type === "clock-unpowered");
    assert.deepEqual(w, [{ type: "clock-unpowered", chip: "clk1" }]);
    const idle = clocked({ power: false, wireOut: false });
    assert.equal(
      tickAt(idle.b.doc, engine, H).warnings.some(
        (x) => x.type === "clock-unpowered",
      ),
      false,
      "a clock wired to nothing is no fault",
    );
  });
}

test("spice: a clock's HIGH is its own supply, a flag's the lowest it feeds", () => {
  // A 5 V and a 12 V supply on one desk (one ground). Before, both bench
  // sources sat at the desk's highest — a 12 V source on a 5 V circuit.
  const b = bench();
  b.doc.components.push({ id: "psu2", kind: "psu", ref: "psu", x: 20, y: 30, params: { volts: 12 } }); // prettier-ignore
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 40, y: 30, params: { hz: "manual" } }); // prettier-ignore
  const u = b.seat("u1", "74LS04", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  // The clock runs from the 5 V rail: vcc beside the chip's VCC.
  b.vcc(u.get(14));
  b.doc.wires.at(-1).from = "clk1.vcc";
  b.gnd(u.get(7));
  b.doc.wires.at(-1).from = "clk1.gnd";
  b.gnd(u.get(7));
  b.doc.wires.at(-1).from = "psu2.-";
  // clock → 1A, and an LED off the same net through 330 Ω.
  b.doc.wires.push({ id: "wc", from: "clk1.out", to: b.at(u.get(1).replace(/^e/, "a")), color: "orange" }); // prettier-ignore
  const led = b.seat("l1", "led", "a30", { color: "red" });
  const r = b.seat("r1", "resistor", "a40", { ohms: 330 });
  b.link(u.get(1), r.get(1));
  b.link(r.get(2), led.get(1));
  b.gnd(led.get(2));
  // A flag on 3A (pin 5), with its own LED.
  b.signal("s1", u.get(5), "high");
  const led2 = b.seat("l2", "led", "a50", { color: "red" });
  const r2 = b.seat("r2", "resistor", "a56", { ohms: 330 });
  b.link(u.get(5), r2.get(1));
  b.link(r2.get(2), led2.get(1));
  b.gnd(led2.get(2));
  const res = ENGINES.spice.tick({
    document: b.doc,
    netlist: buildNetlist(b.doc),
    clockPhase: new Map([["clk1", H]]),
    signalLevels: new Map([["s1", H]]),
    spice: { config: null, analog: null },
  });
  // (5 − 1.8) / (330 + 10)
  close(res.lamps.get("l1").amps, 3.2 / 340, 1e-3, "the clock's LED, at 5 V");
  close(res.lamps.get("l2").amps, 3.2 / 340, 1e-3, "the flag's LED, at 5 V");
});

test("the runner fixture's own engine agrees: clocks need power", () => {
  const { b, u } = clocked({ power: false });
  const r = runner(b.doc).run(0);
  assert.equal(r.level(u.get(2)), L, "a floating TTL input reads HIGH, so 1Y is LOW"); // prettier-ignore
});
