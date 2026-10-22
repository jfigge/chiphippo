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

// spice/ac-supplies.js — the AC sources on a desk (catalog/ac-parts.js), as
// Spice Lite reads them: each mains brick and each AC adapter. Pure and
// DOM-free.
//
// Mains is a sine between a negative peak and a positive one on its L
// terminal, about its N terminal (`EARTHED_AC`) — which is a GROUND, a − rail at 0 V like
// every PSU's −, so the sine is a voltage the rest of the desk can be held
// against (sim/engine.js puts N among the supply minus nets, under Spice Lite
// only). L is a wave node of the solve (spice/engine.js `analyze`, the waves
// of spice/waves.js) — but where a clock brick's wave is told its phase by
// the square SimController flips, the mains' is a function of the time alone
// (`acGenerator`): nothing ticks the desk at its half-cycles.
//
// An AC ADAPTER is an ISOLATED source: nothing joins its output to earth, so
// it floats with whatever the circuit ties it to (sim/floating-grounds.js
// says where that circuit's ground is). It is plugged into the wall, not
// into a mains brick: its sine — its rating, at its frequency
// (`adapterSineOf`) — runs on a net inside it (`source`), and its S1 is held
// at S2 plus that by spice/analog-devices.js's "v" device, behind its own
// resistance (`ohms`, `adapterOhms`).
//
// The logic engine has no voltages below 0 V and nothing that alternates, so
// there an AC source is nothing at all: it drives no net and grounds none.

import { formatAddress } from "../../model/breadboard.js";
import {
  EARTHED_AC,
  adapterOhms,
  adapterSineOf,
  mainsSineOf,
} from "../../catalog/ac-parts.js";
import { internalNet } from "./silicon.js";

/** An earthed source's sine, by kind. */
const SINE_OF = Object.freeze({ ac: mainsSineOf });

/** Each netlist's AC sources. */
const TOPOLOGY = new WeakMap();

/**
 * Every AC source on a desk: `[{id, line, neutral, lineAt, neutralAt,
 * params, isolated, source, ohms}]` — `line`/`neutral` its L and N nets (an
 * adapter's S1 and S2; null while
 * unwired: a terminal alone on its net); `params` its sine, `{hz, peak,
 * trough}`;
 * `source` the net inside an adapter its sine runs on, `ohms` its
 * resistance.
 * @param {object} doc
 * @param {{netOfPoint: Map}} netlist
 */
export function acSupplies(doc, netlist) {
  const cached = TOPOLOGY.get(netlist);
  if (cached) return cached;
  const netOf = (address) => {
    const net = netlist.netOfPoint.get(address) ?? null;
    return (netlist.nets?.get(net)?.points?.length ?? 2) > 1 ? net : null;
  };
  const out = [];
  for (const comp of doc.components ?? []) {
    const ends = EARTHED_AC[comp.kind];
    if (!ends) continue;
    const lineAt = formatAddress(comp.id, ends.line);
    const neutralAt = formatAddress(comp.id, ends.neutral);
    out.push({
      id: comp.id,
      line: netOf(lineAt),
      neutral: netOf(neutralAt),
      lineAt,
      neutralAt,
      params: SINE_OF[comp.kind](comp.params),
      isolated: false,
      source: null,
      ohms: null,
    });
  }
  for (const comp of doc.components ?? []) {
    if (comp.kind !== "adapter") continue;
    const lineAt = formatAddress(comp.id, "S1");
    const neutralAt = formatAddress(comp.id, "S2");
    out.push({
      id: comp.id,
      line: netOf(lineAt),
      neutral: netOf(neutralAt),
      lineAt,
      neutralAt,
      params: adapterSineOf(comp.params),
      isolated: true,
      source: internalNet(comp.id, "sine"),
      ohms: adapterOhms(comp.params),
    });
  }
  TOPOLOGY.set(netlist, out);
  return out;
}
