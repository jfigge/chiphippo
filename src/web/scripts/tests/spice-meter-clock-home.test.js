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

// Regrade 6 (2026-10-28): a chip on a meter's far rail keeps the pins it has
// on a rail in its HOME cluster — its first pin's. With pin 1 on a clock
// brick alone that cluster is a lone net, and the lone solve booked only its
// own net's stages into the rail's balance (spice/voltages.js
// `homeRailFlows`): a 74LS04 behind a meter in its − lead lost its other
// inputs' bias out of its ground (to the supply's −, past the meter), and
// the shunt read ICC whole — 1.55 mA where its resistor twin carries 0.45,
// an LED it drives 3.67 mA for 3.85.

import test from "node:test";
import assert from "node:assert/strict";

import { bench } from "./timing-fixtures.js";
import { partDef } from "../catalog/index.js";
import { meterSetup } from "../catalog/meter.js";
import { driveSpice } from "../bench/drive-spice.js";

const meterOf = (id, params) => ({ id, kind: "meter", ref: "meter", x: 70, y: 0, params: partDef("meter").normalizeParams(params) }); // prettier-ignore
const shunt = (dial) => meterSetup(partDef("meter").normalizeParams({ dial, jack: "ma" })).element.ohms; // prettier-ignore

/** A 74LS04 whose `lead` ("+" or "-") runs through a meter on `dial` (or
    its shunt as a resistor, `twin`) to the 5 V supply; input 1 on a 100 Hz
    clock brick powered from the supply itself, its other inputs on the
    supply's −; output 2 lighting a red LED through 330 Ω back to the chip's
    own ground. Each tick's chip volts, LED and meter amps over 30 ms. */
function clocked(lead, dial, twin) {
  const ohms = shunt(dial);
  const b = bench({ volts: 5 });
  const far = lead === "+" ? b.vcc : b.gnd;
  if (twin) {
    const r = b.seat("rf", "resistor", "a60", { ohms });
    far.call(b, r.get(1));
    b.link(r.get(2).replace(/^a/, "b"), "h60");
  } else {
    const [red, black] = lead === "+" ? [{ at: "psu1.+" }, { at: b.at("g60") }] : [{ at: b.at("g60") }, { at: "psu1.-" }]; // prettier-ignore
    b.doc.components.push(meterOf("dmm1", { dial, jack: "ma", red, black })); // prettier-ignore
  }
  const u = b.seat("u0", "74LS04", "e2");
  if (lead === "+") {
    b.gnd(u.get(7).replace(/^e/, "a"));
    b.link(u.get(14).replace(/^f/, "j"), "i60");
  } else {
    b.vcc(u.get(14).replace(/^f/, "j"));
    b.link(u.get(7).replace(/^e/, "a"), "h60");
  }
  for (const p of [3, 5]) b.gnd(u.get(p).replace(/^e/, "a"));
  for (const p of [9, 11, 13]) b.gnd(u.get(p).replace(/^f/, "j"));
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: partDef("clock").normalizeParams({ hz: 100 }) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wk0", from: "clk1.out", to: b.at(u.get(1).replace(/^e/, "a")), color: "blue" }, // prettier-ignore
    { id: "wk1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wk2", from: "psu1.-", to: "clk1.gnd", color: "black" },
  );
  const r = b.seat("rl0", "resistor", "a40", { ohms: 330 });
  b.link(u.get(2).replace(/^e/, "c"), r.get(1));
  const d = b.seat("d0", "led", "f40", { color: "red" });
  b.link(r.get(2), d.get(1).replace(/^f/, "g"));
  if (lead === "+") b.gnd(d.get(2).replace(/^f/, "h"));
  else b.link(d.get(2).replace(/^f/, "h"), "j60");
  const rows = [];
  driveSpice(b.doc, {
    seconds: 0.03,
    onTick(now, res) {
      const volts = res.chipStatus.get("u0").volts;
      // The twin's current: the drop across its shunt (the chip's supply
      // is the rest of the 5 V).
      const amps = twin ? (5 - volts) / ohms : res.bench.get("dmm1").amps;
      rows.push({ now, volts, led: res.lamps.get("d0").amps, amps });
    },
  });
  return rows;
}

/** The last row with input 1 HIGH (its LED dark) and the last with it LOW. */
function phases(rows) {
  const dark = rows.findLast((r) => r.led < 1e-4);
  const lit = rows.findLast((r) => r.led > 1e-3);
  assert.ok(dark && lit, "both halves of the clock were ticked");
  return { dark, lit };
}

// (In the + lead a µA shunt's drop holds the chip under its floor.)
for (const [lead, dial] of [
  ["-", "ua"],
  ["-", "ma"],
  ["+", "ma"],
]) {
  test(`a meter (${dial}) in a clocked 74LS04's ${lead} lead reads its resistor twin`, () => {
    const meter = phases(clocked(lead, dial, false));
    const twin = phases(clocked(lead, dial, true));
    for (const half of ["dark", "lit"]) {
      const [m, t] = [meter[half], twin[half]];
      // The meter's far rail is held within HUB_EPS (5 mV); its shunt reads
      // the balance.
      assert.ok(Math.abs(m.volts - t.volts) < 5e-3, `${half}: chip at ${m.volts} V, its twin ${t.volts} V`); // prettier-ignore
      assert.ok(Math.abs(m.amps - t.amps) < 0.01 * t.amps, `${half}: meter ${m.amps * 1e3} mA, its twin ${t.amps * 1e3} mA`); // prettier-ignore
      if (half === "lit") assert.ok(Math.abs(m.led - t.led) < 0.005 * t.led, `LED ${m.led * 1e3} mA, its twin's ${t.led * 1e3} mA`); // prettier-ignore
    }
  });
}
