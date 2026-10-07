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

// spice/loads.js — what each output is asked to drive (features/
// spice-light.md §4.5). Pure and DOM-free.
//
// Every input on a net draws a little from the output holding it: its I_IH
// while the net is HIGH, its I_IL while LOW (a 74LS input SOURCES 0.4 mA into
// a LOW output, which must sink it). Summed over the net, that is the output's
// LOAD; its BUDGET is what its datasheet lets it source (HIGH) or sink (LOW)
// — its family's representative gate unless the part states its own (a bus
// driver's 24 mA, a CMOS buffer's 3.3 mA: spice/params.js `outputDrive`).
// Past the budget it is a BROWNOUT (a warning);
// past OVERLOAD_RATIO times it, BROWN SMOKE: the chip is overloaded, which
// SimController latches for the rest of the run exactly as it latches 12 V
// damage.
//
// Only INPUT loads count, as the spec states the rule: an LED and its resistor
// hung on an output draw from the supply (spice/supply.js) — they are not
// fan-out, and a 74LS output lighting an LED through a resistor is ordinary
// bench practice, not a part let down.
//
// A DRIVER is a pin the chip is driving HIGH or LOW right now — what the
// engine let through its outputs (`driven`), so a tri-state output switched
// off is no driver (it adds nothing to the budget) and a bus pin (`io`, the
// '245's, a RAM's data) is a driver while it drives and an input load while
// it does not. A family-less part's inputs are MOS ones (spice/params.js
// `inputLoadUa`).
//
// Stated, not modelled: a CD4000 part's currents are its 5 V figures at any
// supply (conservative: they rise with the supply).

import { H, L } from "../levels.js";
import { CHIP_STATUS } from "../engine.js";
import { inputLoadUa, outputDrive } from "./params.js";

/** Load past this many times the budget lets out the brown smoke (Jason,
    2026-10-07). */
export const OVERLOAD_RATIO = 2;

/**
 * Every driven net's load against its drivers' budget.
 * @param {object} ctx - sim/engine.js's context for the settle
 * @param {Map<string,string>} netLevels - the settled levels
 * @param {object} config - normalized spice config
 * @param {Map<string, Map<number,string>>} driven - each chip's outputs as
 *   it drove them (spice/engine.js's `outputs` hook)
 * @returns {{loads: Map<string, object>, warnings: object[],
 *   overloaded: Set<string>}} — `loads` keyed `<compId>:<pin>` per driving
 *   output pin: `{chip, pin, net, level, inputs, loadMa, budgetMa, ratio}`.
 */
export function outputLoads(ctx, netLevels, config, driven) {
  const byNet = new Map(); // net → {drivers: [{c, pin}], inputs: [c]}
  const entry = (net) => {
    if (!byNet.has(net)) byNet.set(net, { drivers: [], inputs: [] });
    return byNet.get(net);
  };
  for (const c of ctx.chips) {
    if (c.status !== CHIP_STATUS.OK || c.analogSwitch || c.passive) continue;
    const outs = driven.get(c.comp.id);
    for (const p of c.def.pins) {
      const net = c.pinNet.get(p.n);
      if (!net || ctx.trace.rail(net)) continue;
      const level = outs?.get(p.n);
      if (level === H || level === L) entry(net).drivers.push({ c, pin: p.n });
      else if (p.role === "input" || p.role === "io") entry(net).inputs.push(c);
    }
  }

  const loads = new Map();
  const worst = new Map(); // chip → its worst output's warning
  const overloaded = new Set();
  for (const [net, { drivers, inputs }] of byNet) {
    const level = netLevels.get(net);
    if ((level !== H && level !== L) || !drivers.length || !inputs.length) {
      continue;
    }
    const high = level === H;
    let loadMa = 0;
    for (const c of inputs) loadMa += inputLoadUa(config, c.def, high) / 1000;
    let budgetMa = 0;
    for (const { c, pin } of drivers) {
      const drive = outputDrive(config, c.def, pin);
      budgetMa += high ? drive.sourceMa : drive.sinkMa;
    }
    const ratio = budgetMa > 0 ? loadMa / budgetMa : 0;
    for (const { c, pin } of drivers) {
      loads.set(`${c.comp.id}:${pin}`, {
        chip: c.comp.id,
        pin,
        net,
        level,
        inputs: inputs.length,
        loadMa,
        budgetMa,
        ratio,
      });
    }
    if (ratio <= 1) continue;
    const smoke = ratio >= OVERLOAD_RATIO;
    for (const chip of new Set(drivers.map(({ c }) => c.comp.id))) {
      // One warning per chip — its worst output — so a chip browning out on
      // one pin and smoking on another is reported as smoking, whatever
      // order its nets come in.
      const was = worst.get(chip);
      if (!was || ratio > was.ratio) {
        worst.set(chip, { type: "brownout", chip, net, inputs: inputs.length, loadMa, budgetMa, ratio, smoke }); // prettier-ignore
      }
      if (smoke) overloaded.add(chip);
    }
  }
  const warnings = [...worst.values()];
  return { loads, warnings, overloaded };
}
