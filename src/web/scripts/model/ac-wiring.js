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

// ac-wiring.js — the logic inputs an AC source is wired STRAIGHT into: a net
// an AC supply's L, or a transformer's winding, is on (catalog/ac-parts.js),
// holding a logic chip's input. Pure and DOM-free.
//
// An AC source swings below 0 V for half of every cycle, and no logic input
// survives that wired straight on: a 74LS input's clamp diode, a CD4000's
// protection diode, carries whatever the source can push (spice/params.js
// TTL_CLAMP, CMOS_CLAMP) and burns — which is what Spice Lite shows when the
// circuit runs. This is the same fact said at the moment the WIRE is placed,
// before anything runs (components/ac-wiring-monitor.js): the bench rule that
// an AC signal reaches logic through a resistor and a clamp, or a rectifier.
//
// "Straight" is one net: a resistor, a diode or a capacitor in the way is
// the circuit the warning asks for, and none is followed. An AC supply's N is
// a ground and no source; a transformer's terminal on a supply rail is held
// there and swings nothing. An op-amp's inputs are an amplifier's, not a
// logic input's, and an analog switch's channel terminals pass a signal
// rather than read one — neither is warned of.

import { formatAddress } from "./breadboard.js";
import { partDef } from "../catalog/index.js";

/** A transformer's four terminals. */
const WINDING_ENDS = Object.freeze(["P1", "P2", "S1", "S2"]);

/** Pin roles that read a logic level. */
const LOGIC_INPUTS = new Set(["input", "io", "clock"]);

/** Whether a desk holds anything that puts out AC — the cheap test that lets
    a monitor skip a netlist on every other desk. */
export function hasAcSource(doc) {
  return (doc?.components ?? []).some(
    (c) => c.kind === "ac" || c.kind === "transformer",
  );
}

/**
 * Every logic input an AC source is wired straight into: `[{source,
 * terminal, chip, pin, net}]`, one per (source net, pin), in desk order.
 * @param {object} doc
 * @param {{netOfPoint: Map, nets: Map}} netlist
 */
export function acIntoLogicInputs(doc, netlist) {
  if (!hasAcSource(doc)) return [];
  const netOf = (address) => netlist.netOfPoint.get(address) ?? null;
  // The supply rails: every PSU terminal's net and every AC supply's N.
  const rails = new Set();
  for (const comp of doc.components ?? []) {
    if (comp.kind === "psu") {
      for (const id of ["+", "-"]) rails.add(netOf(formatAddress(comp.id, id))); // prettier-ignore
    } else if (comp.kind === "ac") {
      rails.add(netOf(formatAddress(comp.id, "N")));
    }
  }
  // Each net an AC source drives, and what drives it.
  const sources = new Map(); // net → {source, terminal}
  for (const comp of doc.components ?? []) {
    const ends =
      comp.kind === "ac"
        ? ["L"]
        : comp.kind === "transformer"
          ? WINDING_ENDS
          : [];
    for (const terminal of ends) {
      const net = netOf(formatAddress(comp.id, terminal));
      if (!net || rails.has(net) || sources.has(net)) continue;
      sources.set(net, { source: comp.id, terminal });
    }
  }
  if (!sources.size) return [];
  const out = [];
  for (const [net, from] of sources) {
    for (const pt of netlist.nets.get(net)?.pins ?? []) {
      if (!readsLogic(partDef(pt.ref), pt.role)) continue;
      out.push({ ...from, chip: pt.componentId, pin: pt.pin, net });
    }
  }
  return out;
}

/** Whether a pin of `role` on a part reads a logic level: a chip's input
    (an analog switch's control included), not an op-amp's, a regulator's or
    an analog switch's channel terminal. */
function readsLogic(def, role) {
  if (def?.kind !== "chip" || !def.logic) return false;
  if (def.opAmps || def.regulator || def.optocoupler) return false;
  if (!LOGIC_INPUTS.has(role)) return false;
  return !(role === "io" && Array.isArray(def.logic.channels));
}
