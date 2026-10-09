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

// sim/regulators.js — a linear regulator to the LOGIC engine: its OUT a
// supply `+` whenever its IN is one high enough (catalog/bench-parts.js
// `def.regulator`). A 78xx gives its own voltage; an LM317 the one its two
// resistors set — R1 from OUT to ADJ, R2 from ADJ to a supply's −,
// Vout = 1.25 V × (1 + R2 / R1) + IADJ × R2 (TI SLVS044, §8.1). Under Spice
// Lite a regulator is a device in the voltage solve (spice/analog-devices.js)
// and none of this applies. Pure and DOM-free.

import { partDef } from "../catalog/index.js";
import { LM317 } from "../catalog/bench-parts.js";
import { partPinAddresses } from "../model/occupancy.js";

/**
 * Every regulator on a desk with all three leads on a net: `[{id, def, inp,
 * ref, out, resistors}]` — `resistors` every resistor touching its REF net
 * (an LM317's ADJ), `{a, b, ohms}` with `a` the REF side.
 * @param {object} doc
 * @param {{netOfPoint: Map}} netlist
 */
export function regulatorFacts(doc, netlist) {
  const components = doc.components ?? [];
  const netOf = (address) =>
    address ? (netlist.netOfPoint.get(address) ?? null) : null;
  const regs = [];
  for (const comp of components) {
    const def = partDef(comp.ref);
    if (!def?.regulator || comp.board == null) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const at = new Map(pins.map((p) => [p.pin, netOf(p.address)]));
    const { inp, ref, out } = def.regulator.pins;
    const nets = { inp: at.get(inp), ref: at.get(ref), out: at.get(out) };
    if (!nets.inp || !nets.ref || !nets.out) continue;
    regs.push({ id: comp.id, def, ...nets, resistors: [] });
  }
  if (!regs.some((r) => r.def.regulator.adjustable)) return regs;
  // The resistors an LM317's ADJ sees, with their values.
  for (const comp of components) {
    const def = partDef(comp.ref);
    if (!def?.weakBridges || comp.board == null) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const at = new Map(pins.map((p) => [p.pin, netOf(p.address)]));
    for (const [a, b, own] of def.weakBridges(comp.params)) {
      const ohms = Number(own ?? comp.params?.ohms);
      const [na, nb] = [at.get(a), at.get(b)];
      if (!(ohms > 0) || !na || !nb || na === nb) continue;
      for (const reg of regs) {
        if (na === reg.ref) reg.resistors.push({ a: na, b: nb, ohms });
        else if (nb === reg.ref) reg.resistors.push({ a: nb, b: na, ohms });
      }
    }
  }
  return regs;
}

/** Resistors in parallel, ohms (Infinity: none). */
const parallel = (list) => {
  const g = list.reduce((sum, r) => sum + 1 / r.ohms, 0);
  return g > 0 ? 1 / g : Number.POSITIVE_INFINITY;
};

/**
 * The voltage a regulator holds its OUT at, above a supply's − — or null
 * when its wiring sets none: a 78xx whose GND is not on a supply's −; an
 * LM317 with no R1, or with no path from ADJ to a −.
 * @param {{def: object, ref: string, out: string, resistors: object[]}} reg
 * @param {Set<string>} minus - the nets carrying a supply's −
 */
export function regulatorVolts(reg, minus) {
  const r = reg.def.regulator;
  if (!r.adjustable) return minus.has(reg.ref) ? r.volts : null;
  if (minus.has(reg.ref)) return LM317.vref;
  const r1 = parallel(reg.resistors.filter((x) => x.b === reg.out));
  const r2 = parallel(reg.resistors.filter((x) => minus.has(x.b)));
  if (!Number.isFinite(r1) || !Number.isFinite(r2)) return null;
  return LM317.vref * (1 + r2 / r1) + LM317.adjA * r2;
}

/**
 * Make each regulator's OUT a supply `+` (in `plusVolts`, net → [volts])
 * while its IN is one at least its dropout above what it holds — chained, so
 * a 7805 fed by a 7812 is one too. Returns the regulators that gave one.
 * @param {object[]} regs - `regulatorFacts`
 * @param {Map<string, number[]>} plusVolts
 * @param {Set<string>} minus
 */
export function regulatorSupplies(regs, plusVolts, minus) {
  const on = new Set();
  for (let round = 0; round < regs.length; round++) {
    let grew = false;
    for (const reg of regs) {
      if (on.has(reg.id)) continue;
      const fed = plusVolts.get(reg.inp);
      const volts = regulatorVolts(reg, minus);
      if (!fed?.length || volts == null) continue;
      const dropout = reg.def.regulator.model().dropoutV;
      if (Math.max(...fed) < volts + dropout) continue;
      if (!plusVolts.has(reg.out)) plusVolts.set(reg.out, []);
      plusVolts.get(reg.out).push(volts);
      on.add(reg.id);
      grew = true;
    }
    if (!grew) break;
  }
  return on;
}
