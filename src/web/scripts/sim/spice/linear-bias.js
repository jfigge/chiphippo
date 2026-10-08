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

// spice/linear-bias.js — a gate biased into its LINEAR region by its own
// feedback resistor (features/done/spice-lite-3-plan.md, Phase 5). Pure and
// DOM-free.
//
// An inverting gate whose output feeds its own input through a resistor — a
// CD4069UB amplifier, the bias network of a crystal oscillator — settles on a
// bench where its input equals its output, half way up its transfer curve:
// an AMPLIFIER, not a logic gate. Spice Lite models a gate as logic with an
// output stage, so it has no answer there: the input reads undefined, or
// the loop chatters, or (a CMOS output that drives X driving nothing) the
// input reads floating. Each of those would be misleading, so the one thing
// it says is specific: this gate is biased into its linear region, which is
// out of scope (Jason, 2026-10-08, question 10). A Schmitt-trigger input has
// no linear region — its hysteresis makes the same loop an oscillator — so
// it is not one.

import { partDef } from "../../catalog/index.js";
import { partPinAddresses } from "../../model/occupancy.js";

/** The inverting gate units — a NAND or a NOR with its inputs on one net is
    an inverter too. */
const INVERTING = new Set(["INV", "NAND", "NOR"]);

/** Each netlist's self-biased gates (`selfBiasedGates`). */
const CACHE = new WeakMap();

/**
 * Every inverting gate on the desk whose output a resistor ties straight to
 * one of its own inputs: `[{chip, input, output, inNet, outNet}]`, pins and
 * nets. A Schmitt part is none.
 * @param {object} doc
 * @param {{netOfPoint: Map}} netlist
 */
export function selfBiasedGates(doc, netlist) {
  const cached = CACHE.get(netlist);
  if (cached) return cached;
  const netOf = (address) => (address ? (netlist.netOfPoint.get(address) ?? null) : null); // prettier-ignore
  // Every resistor's two nets, as one key each way.
  const joined = new Set();
  for (const comp of doc.components ?? []) {
    if (comp.ref !== "resistor") continue;
    const pins = partPinAddresses(doc, comp) ?? [];
    const [a, b] = [1, 2].map((n) => netOf(pins.find((p) => p.pin === n)?.address)); // prettier-ignore
    if (!a || !b || a === b) continue;
    joined.add(`${a}|${b}`);
    joined.add(`${b}|${a}`);
  }
  const out = [];
  if (joined.size) {
    for (const comp of doc.components ?? []) {
      if (comp.kind !== "chip") continue;
      const def = partDef(comp.ref);
      if (!def?.logic?.units || def.schmitt) continue;
      const pins = new Map((partPinAddresses(doc, comp) ?? []).map((p) => [p.pin, netOf(p.address)])); // prettier-ignore
      for (const unit of def.logic.units) {
        if (!INVERTING.has(unit.fn)) continue;
        const outNet = pins.get(unit.output);
        if (!outNet) continue;
        const input = unit.inputs.find((pin) => {
          const inNet = pins.get(pin);
          return inNet && joined.has(`${outNet}|${inNet}`);
        });
        if (input == null) continue;
        out.push({ chip: comp.id, input, output: unit.output, inNet: pins.get(input), outNet }); // prettier-ignore
      }
    }
  }
  CACHE.set(netlist, out);
  return out;
}

/**
 * The tick's warnings with each self-biased gate whose input is left
 * undefined (X, or Z — nothing holds it) said as a `linear-bias` warning,
 * `{type, chip, pin}` (its output), in place of what its loop otherwise
 * raises: an `oscillation` on its own nets, a `floating-input` on its own
 * input pin.
 * @param {Array<object>} warnings
 * @param {Array<object>} gates - `selfBiasedGates`
 * @param {Map<string, string>} levels - the tick's shown net levels
 * @param {(chip: string) => boolean} powered
 */
export function linearBiasWarnings(warnings, gates, levels, powered) {
  if (!gates.length) return warnings;
  const biased = gates.filter((g) => {
    if (!powered(g.chip)) return false;
    const level = levels.get(g.inNet);
    return level == null || level === "X" || level === "Z";
  });
  if (!biased.length) return warnings;
  const nets = new Set(biased.flatMap((g) => [g.inNet, g.outNet]));
  const inputs = new Map();
  for (const g of biased) {
    if (!inputs.has(g.chip)) inputs.set(g.chip, new Set());
    inputs.get(g.chip).add(g.input);
  }
  const out = [];
  for (const w of warnings) {
    if (w.type === "oscillation" && w.nets.every((n) => nets.has(n))) continue;
    if (w.type === "floating-input" && inputs.has(w.chip)) {
      const pins = w.pins.filter((p) => !inputs.get(w.chip).has(p));
      if (pins.length) out.push({ ...w, pins });
      continue;
    }
    out.push(w);
  }
  for (const g of biased) out.push({ type: "linear-bias", chip: g.chip, pin: g.output }); // prettier-ignore
  return out;
}
