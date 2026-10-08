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

// clock-power.js — a test fixture's clock bricks, powered. A clock source
// runs from a supply like any instrument (sim/engine.js `buildContext`): its
// `vcc` on a PSU `+`, its `gnd` on a `−`, or it stops. A fixture that is
// about something else gives each clock whose terminals it left unwired a
// bench supply of its own, wired straight to them (terminal to terminal), so
// no rail hole the fixture uses is touched.

let seq = 0;

/**
 * Power every clock brick in `doc` whose `vcc` is not wired yet. Mutates and
 * returns the document.
 * @param {{components: Array, wires: Array}} doc
 * @param {number} [volts]
 */
export function powerClocks(doc, volts = 5) {
  const wired = new Set((doc.wires ?? []).flatMap((w) => [w.from, w.to]));
  for (const clk of [...(doc.components ?? [])]) {
    if (clk.kind !== "clock" || wired.has(`${clk.id}.vcc`)) continue;
    const psu = `psu_${clk.id}`;
    doc.components.push({ id: psu, kind: "psu", ref: "psu", x: clk.x, y: (clk.y ?? 0) + 20, params: { volts } }); // prettier-ignore
    doc.wires.push({ id: `wclk${++seq}`, from: `${psu}.+`, to: `${clk.id}.vcc`, color: "red" }); // prettier-ignore
    if (!wired.has(`${clk.id}.gnd`)) {
      doc.wires.push({ id: `wclk${++seq}`, from: `${psu}.-`, to: `${clk.id}.gnd`, color: "black" }); // prettier-ignore
    } else {
      // Its ground is already on the circuit's: the two supplies share it.
      const theirs = doc.wires.find((w) => w.from === `${clk.id}.gnd` || w.to === `${clk.id}.gnd`); // prettier-ignore
      const far = theirs.from === `${clk.id}.gnd` ? theirs.to : theirs.from;
      doc.wires.push({ id: `wclk${++seq}`, from: `${psu}.-`, to: far, color: "black" }); // prettier-ignore
    }
  }
  return doc;
}
