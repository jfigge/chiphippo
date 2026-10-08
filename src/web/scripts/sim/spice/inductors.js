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

// spice/inductors.js — every inductor on a desk as Spice Lite carries it
// (features/done/spice-lite-3-plan.md, Phase 3). Pure and DOM-free.
//
// The capacitor's dual: its STATE is a current, which no event can change in
// an instant. In the voltage solve an inductor is a current source of that
// current, from its pin 1 to its pin 2 (spice/network.js "l"); between
// events it runs along L·di/dt = V(1) − V(2) − R·i, R its winding's
// resistance (catalog/discretes.js `inductorOhms`), solved with every
// capacitor and inductor it sees as one linear system (spice/dynamics.js).
//
// Only an inductor with an INDUCTANCE is one, and only on a netlist built
// with `inductors: "branch"` (sim/netlist.js) — Spice Lite's. Everywhere else
// (the digital engine, the exports, the schematic) it is the wire it is at
// DC, so nothing outside Spice Lite changed.

import { partDef } from "../../catalog/index.js";
import { inductorOhms } from "../../catalog/discretes.js";
import { partPinAddresses } from "../../model/occupancy.js";
import { isInductorBranch } from "../netlist.js";

/** Each netlist's inductors (`inductorTopology`), and the ones its wiring
    shorts (`shortedInductors`). */
const TOPOLOGY = new WeakMap();
const SHORTED = new WeakMap();

/**
 * Every inductor that is a branch on this netlist: `[{id, a, b, aAt, bAt,
 * henries, ohms}]` — `a`/`b` its pin 1 and pin 2 nets (two different ones:
 * on a netlist that joined them it is a wire, and no branch), `aAt`/`bAt`
 * the holes its leads are in.
 * @param {object} doc
 * @param {{netOfPoint: Map}} netlist
 */
export function inductorTopology(doc, netlist) {
  const cached = TOPOLOGY.get(netlist);
  if (cached) return cached;
  const out = [];
  for (const comp of doc.components ?? []) {
    const def = partDef(comp.ref);
    if (comp.board == null || !isInductorBranch(def, comp.params)) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const at = (pin) => pins.find((p) => p.pin === pin)?.address ?? null;
    const aAt = at(1);
    const bAt = at(2);
    const a = aAt ? (netlist.netOfPoint.get(aAt) ?? null) : null;
    const b = bAt ? (netlist.netOfPoint.get(bAt) ?? null) : null;
    if (!a || !b || a === b) continue;
    out.push({ id: comp.id, a, b, aAt, bAt, henries: Number(comp.params.henries), ohms: inductorOhms(comp.params) }); // prettier-ignore
  }
  TOPOLOGY.set(netlist, out);
  return out;
}

/**
 * The inductors a netlist joins both ends of — a switch across a coil, closed
 * — by id: no branch (`inductorTopology`), but a loop its current still runs
 * round, through its own winding.
 * @param {object} doc
 * @param {{netOfPoint: Map}} netlist
 * @returns {Set<string>}
 */
export function shortedInductors(doc, netlist) {
  const cached = SHORTED.get(netlist);
  if (cached) return cached;
  const out = new Set();
  for (const comp of doc.components ?? []) {
    const def = partDef(comp.ref);
    if (comp.board == null || !isInductorBranch(def, comp.params)) continue;
    const pins = partPinAddresses(doc, comp);
    const at = (pin) => pins?.find((p) => p.pin === pin)?.address ?? null;
    const a = at(1) ? netlist.netOfPoint.get(at(1)) : null;
    if (a && a === (at(2) ? netlist.netOfPoint.get(at(2)) : null))
      out.add(comp.id);
  }
  SHORTED.set(netlist, out);
  return out;
}

/**
 * What an inductor that is no branch any more (`away`: `{at, amps, tau}`, its
 * current and the moment it left) carries at `t`, amps: shorted, its current
 * dies away round the loop through its winding (tau = L/R; Infinity with
 * none); opened, it is gone at once.
 */
export function awayAmps(away, t) {
  if (!(away.tau > 0)) return 0;
  if (!Number.isFinite(away.tau)) return away.amps;
  return away.amps * Math.exp(-Math.max(0, t - away.at) / away.tau);
}
