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

// A listener (spice/listeners.js) whose net nothing holds — no RC node, no
// voltage solved — has no reading: its pin reads its level, as from Run
// (spice/engine.js `restate`). Kept, the reading it had before an edit left
// it open stood for good: a 74LS04 off the rails (its ground behind 1.9 Ω,
// a capacitor on that ground, so every input of it listens against it) whose
// clock wire was taken off read the clock's last LOW, and its LED stayed lit
// at 4.6 mA (the light meter regrade's rc2 repro, 2026-10-28).

import test from "node:test";
import assert from "node:assert/strict";

import { bench } from "./timing-fixtures.js";
import { partDef } from "../catalog/index.js";
import { driveSpice } from "../bench/drive-spice.js";

/** A 74LS04, input 1 on a 100 Hz clock brick (`clocked`), output 2 into a
    red LED through 330 Ω; its ground (`ground` "resistor": through 1.9 Ω,
    else straight on the − rail) with a 1 nF capacitor from a 10 kΩ pull-up
    down to it (`cap` "ground"), to the − rail ("rail"), or none. */
function desk({ ground, cap, clocked = true }) {
  const b = bench({ volts: 5 });
  if (ground === "resistor") {
    const r = b.seat("rm", "resistor", "a56", { ohms: 1.9 });
    b.gnd(r.get(1));
    b.link(r.get(2).replace(/^a/, "b"), "h58");
  }
  const G = (h) => (ground === "resistor" ? b.link(h, "i58") : b.gnd(h));
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: partDef("clock").normalizeParams({ hz: 100 }) }); // prettier-ignore
  b.doc.wires.push({ id: "wk1", from: "psu1.+", to: "clk1.vcc", color: "red" }, { id: "wk2", from: "psu1.-", to: "clk1.gnd", color: "black" }); // prettier-ignore
  const u = b.seat("u0", "74LS04", "e2");
  b.vcc(u.get(14).replace(/^f/, "j"));
  G(u.get(7).replace(/^e/, "a"));
  for (const p of [3, 5]) b.gnd(u.get(p).replace(/^e/, "a"));
  for (const p of [9, 11, 13]) b.gnd(u.get(p).replace(/^f/, "j"));
  if (clocked) b.doc.wires.push({ id: "wk0", from: "clk1.out", to: b.at(u.get(1).replace(/^e/, "a")), color: "blue" }); // prettier-ignore
  const r = b.seat("rl0", "resistor", "a40", { ohms: 330 });
  b.link(u.get(2).replace(/^e/, "c"), r.get(1));
  const d = b.seat("d0", "led", "f40", { color: "red" });
  b.link(r.get(2), d.get(1).replace(/^f/, "g"));
  G(d.get(2).replace(/^f/, "h"));
  if (cap) {
    const rc = b.seat("rc", "resistor", "a20", { ohms: 10000 });
    b.vcc(rc.get(1));
    const c = b.seat("cc", "cap-electrolytic", "f20", { farads: 1e-9 });
    b.link(rc.get(2).replace(/^a/, "b"), c.get(1).replace(/^f/, "g"));
    if (cap === "ground" && ground === "resistor")
      b.link(c.get(2).replace(/^f/, "h"), "i58"); // prettier-ignore
    else b.gnd(c.get(2).replace(/^f/, "h"));
  }
  return b;
}

/** Input 1's level and the LED's current as 60 ms end: the desk run from
    Run with its clock wire taken off at 12 ms (`edited`), or run so. */
function ending(doc, edit) {
  const { result } = driveSpice(structuredClone(doc), {
    seconds: 0.06,
    end: true,
    edits: edit ? [{ at: 0.012, doc: structuredClone(edit) }] : [],
  });
  return { pin1: result.netLevels.get("bb1.a2") ?? "Z", led: result.lamps.get("d0")?.amps ?? 0 }; // prettier-ignore
}

test("an input an edit leaves open reads as it would from Run, whatever listens beside it", () => {
  for (const ground of ["resistor", "rail"]) {
    for (const cap of ["ground", "rail", null]) {
      const b = desk({ ground, cap });
      const open = desk({ ground, cap, clocked: false }).doc;
      const edited = ending(b.doc, open);
      const fresh = ending(open, null);
      const name = `${ground} ground, capacitor ${cap ?? "none"}`;
      // At 12 ms the clock is LOW, the input LOW, the LED lit; open, the
      // input floats HIGH and the LED goes dark.
      assert.equal(fresh.led, 0, `${name}: fresh`);
      assert.equal(edited.led, 0, `${name}: edited, LED at ${edited.led} A`);
      assert.equal(edited.pin1, fresh.pin1, `${name}: input 1`);
    }
  }
});
