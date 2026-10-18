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

// spice/ac-supplies.js — the AC supplies on a desk (catalog/parts.js
// `ac-supply`), as Spice Lite reads them. Pure and DOM-free.
//
// An AC supply is a sine between a negative peak and a positive one on its
// L terminal, about its N terminal — which is a GROUND, a − rail at 0 V like
// every PSU's −, so the sine is a voltage the rest of the desk can be held
// against (sim/engine.js puts N among the supply minus nets, under Spice Lite
// only). L is a wave node of the solve (spice/engine.js `analyze`, the waves
// of spice/waves.js), its edges SimController's, as a clock brick's are.
//
// The logic engine has no voltages below 0 V and nothing that alternates, so
// there an AC supply is nothing at all: it drives no net and grounds none.

import { formatAddress } from "../../model/breadboard.js";

/** The supply's two terminals. */
export const AC_LINE = "L";
export const AC_NEUTRAL = "N";

/** Each netlist's AC supplies. */
const TOPOLOGY = new WeakMap();

/**
 * Every AC supply on a desk: `[{id, line, neutral, lineAt, neutralAt,
 * params}]` — `line`/`neutral` its L and N nets (null while unwired).
 * @param {object} doc
 * @param {{netOfPoint: Map}} netlist
 */
export function acSupplies(doc, netlist) {
  const cached = TOPOLOGY.get(netlist);
  if (cached) return cached;
  const netOf = (address) => netlist.netOfPoint.get(address) ?? null;
  const out = [];
  for (const comp of doc.components ?? []) {
    if (comp.kind !== "ac") continue;
    const lineAt = formatAddress(comp.id, AC_LINE);
    const neutralAt = formatAddress(comp.id, AC_NEUTRAL);
    out.push({
      id: comp.id,
      line: netOf(lineAt),
      neutral: netOf(neutralAt),
      lineAt,
      neutralAt,
      params: comp.params ?? {},
    });
  }
  TOPOLOGY.set(netlist, out);
  return out;
}
