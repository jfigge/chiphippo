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

// The 2026-10-28 regrade: a meter's far rail is primed from its chips' ICC
// alone (spice/voltages.js `placeHubs`), so a chip the rest of the rail's
// load holds under its floor started "ok" there, set its outputs, and the
// keep-driving rule for a sagging off-rail chip held them — where its
// resistor twin, read unpowered at its first context, never drives.

import test from "node:test";
import assert from "node:assert/strict";

import { bench, runner } from "./timing-fixtures.js";
import { partDef } from "../catalog/index.js";
import { TOLERANCE } from "./spice-golden-cases.js";

const meterOf = (id, params) => ({ id, kind: "meter", ref: "meter", x: 70, y: 0, params: partDef("meter").normalizeParams(params) }); // prettier-ignore

/** A 74LS04 fed from +5 V through a µA meter in its + lead (or the 100 Ω
    shunt it is, `twin`), `rail` ohms across its far rail to ground (0:
    none; "led": a green LED through 330 Ω — a network, no rail part), output 2 lighting a red LED through 1 kΩ — the regrade's
    repro. Its state at 0.1 s. */
function underFloor(twin, rail) {
  const b = bench({ volts: 5 });
  if (twin) {
    const r = b.seat("rf", "resistor", "a60", { ohms: 100 });
    b.vcc(r.get(1));
    b.link(r.get(2).replace(/^a/, "b"), "h60");
  } else {
    b.doc.components.push(meterOf("dmm1", { dial: "ua", jack: "ma", red: { at: "psu1.+" }, black: { at: b.at("g60") } })); // prettier-ignore
  }
  const u = b.seat("u0", "74LS04", "e2");
  b.gnd(u.get(7).replace(/^e/, "a"));
  b.link(u.get(14).replace(/^f/, "j"), "i60");
  for (const p of [1, 3, 5]) b.gnd(u.get(p).replace(/^e/, "a"));
  for (const p of [9, 11, 13]) b.gnd(u.get(p).replace(/^f/, "j"));
  const rl = b.seat("rl0", "resistor", "a40", { ohms: 1000 });
  b.link(u.get(2).replace(/^e/, "c"), rl.get(1));
  const d = b.seat("d0", "led", "f40", { color: "red" });
  b.link(rl.get(2), d.get(1).replace(/^f/, "g"));
  b.gnd(d.get(2).replace(/^f/, "h"));
  if (rail === "led") {
    const r = b.seat("rh", "resistor", "a52", { ohms: 330 });
    b.link(r.get(1).replace(/^a/, "b"), "f60");
    const dh = b.seat("dh", "led", "f50", { color: "green" });
    b.link(r.get(2).replace(/^a/, "b"), dh.get(1).replace(/^f/, "g"));
    b.gnd(dh.get(2).replace(/^f/, "g"));
  } else if (rail) {
    const r = b.seat("rload", "resistor", "f55", { ohms: rail });
    b.link(r.get(1).replace(/^f/, "g"), "f60");
    b.gnd(r.get(2).replace(/^f/, "g"));
  }
  const run = runner(b.doc, { engine: "spice" });
  for (const t of [0, 0.01, 0.1]) run.run(t);
  const { result, netlist } = run;
  const net = (hole) => netlist.netOfPoint.get(b.at(hole));
  const far = result.nodeVolts.get(net("f60"));
  return {
    status: result.chipStatus.get("u0")?.status,
    level: result.netLevels.get(net("c3")),
    out: result.nodeVolts.get(net("c3")) ?? null,
    led: result.lamps?.get("d0")?.amps ?? 0,
    far,
    amps: twin ? (5 - far) / 100 : result.bench?.get("dmm1")?.amps,
  };
}

for (const rail of [470, 220, 100, "led"]) {
  test(`a 74LS04 behind a µA meter with ${rail === "led" ? "an LED and 330 Ω" : `${rail} Ω`} across its far rail reads as its resistor twin: under its floor, driving nothing`, () => {
    const meter = underFloor(false, rail);
    const twin = underFloor(true, rail);
    assert.equal(twin.status, "underpowered");
    assert.equal(meter.status, twin.status);
    assert.equal(meter.level, twin.level);
    assert.equal(meter.out, twin.out);
    // It lit the LED at 0.87 mA (470 Ω), its output at 2.53 V.
    assert.equal(meter.led, twin.led, `${meter.led} A`);
    assert.equal(twin.led, 0);
    // …and the meter read +7.2 % over its twin (10.54 mA for 9.83; with
    // the LED, 9.91 for 8.06).
    const tol = TOLERANCE.A.rel;
    assert.ok(Math.abs(meter.amps / twin.amps - 1) < tol, `${meter.amps} A against ${twin.amps}`); // prettier-ignore
    assert.ok(Math.abs(meter.far / twin.far - 1) < tol, `${meter.far} V against ${twin.far}`); // prettier-ignore
  });
}

test("…and with nothing else on its far rail it is on, and drives, as its twin does", () => {
  const meter = underFloor(false, 0);
  const twin = underFloor(true, 0);
  assert.equal(meter.status, "ok");
  assert.equal(meter.status, twin.status);
  assert.equal(meter.level, twin.level);
  assert.ok(meter.led > 1e-3, `${meter.led} A`);
  assert.ok(Math.abs(meter.led / twin.led - 1) < TOLERANCE.A.rel, `${meter.led} A against ${twin.led}`); // prettier-ignore
  assert.ok(Math.abs(meter.amps / twin.amps - 1) < TOLERANCE.A.rel, `${meter.amps} A against ${twin.amps}`); // prettier-ignore
});
