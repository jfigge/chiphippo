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

// spice/coupling.js — a step on a capacitor's far side, carried through it
// (features/done/spice-lite-2-plan.md §5). Pure and DOM-free.
//
// A capacitor's charge cannot change in an instant: a resistor can only pass
// a finite current, so over the moment an output switches nothing reaches an
// RC node but what its capacitors carry. When the far side of one steps by δ,
// the node steps too — by δ·C over all the capacitance on the node, its
// charge conserved — and its curve starts again from there. That is what an
// AC-coupled trigger is (a button through a capacitor into a 555's TRIG), and
// what the two-inverter oscillators are: a 4060's junction stepping past its
// rail when φO switches, and coming back through Rx.
//
// A capacitor between two nodes is one charge between them: their steps are
// solved together, one small linear system, every node's charge conserved.
// What a node does BETWEEN steps is spice/engine.js's — and where a far side
// is another node free to move, the two run as one linear system
// (spice/dynamics.js, engine.js `runGroup`), its continuous motion carried
// exactly, a lone capacitor's plates as one charge and an algebraic common
// voltage. What comes through here is a step: a held far side (an output, a
// bench source) jumping.

import { gaussSolve } from "./network.js";

/**
 * How far each node steps, volts, from what its capacitors' far sides did
 * since it was last looked at. `nodes` is the nodes that can step (each with
 * its capacitors: `{id, far, value}`); `step(cap, net)` the far side's step
 * since then for a far side that is NOT one of them (null: no step known);
 * a far side that is one of them steps by its own answer.
 * @param {Map<string, {caps: Array<{id: string, far: string, value: number}>}>} nodes
 * @param {(cap: object, net: string) => number|null} step
 * @returns {Map<string, number>} net → its step (only the nodes that move)
 */
export function couplingSteps(nodes, step) {
  const nets = [...nodes.keys()];
  const index = new Map(nets.map((net, i) => [net, i]));
  const n = nets.length;
  const a = nets.map(() => new Float64Array(n));
  const b = new Array(n).fill(0);
  let any = false;
  nets.forEach((net, i) => {
    // An attofarad to ground on every node: a group of nodes joined to one
    // another by nothing but capacitors has no single answer without it.
    a[i][i] += 1e-18;
    for (const cap of nodes.get(net).caps) {
      a[i][i] += cap.value;
      const j = index.get(cap.far);
      if (j != null) {
        a[i][j] -= cap.value;
        continue;
      }
      const d = step(cap, net);
      if (d) {
        b[i] += cap.value * d;
        any = true;
      }
    }
  });
  const out = new Map();
  if (!any) return out;
  const x = gaussSolve(a, b);
  if (!x) return out;
  nets.forEach((net, i) => {
    if (Math.abs(x[i]) > 1e-12) out.set(net, x[i]);
  });
  return out;
}
