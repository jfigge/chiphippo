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
// (features/spice-lite-2-plan.md §5). Pure and DOM-free.
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
// What a node's curve does between steps is spice/engine.js's; a far side's
// CONTINUOUS motion (another node running along its curve) is not carried —
// only steps are.
//
// But a capacitor that is the ONLY one on both its nets (`pairStep` — a gate
// output's coupling capacitor to the junction it drives through a resistor:
// the two-inverter oscillators' Cx, an output into a differentiator) is no
// step on either: neither plate is held, its VOLTAGE is the one thing that
// cannot jump, and each plate stands where its own network and the current
// through the capacitor put it. Both then run along one curve, the
// capacitor's — its time constant C times both sides' resistance.

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

/** A network giving way slower than this, siemens, is a current source to
    its plate (a saturated output), not a resistance. */
const MIN_S = 1e-8;

/**
 * Where the plates of a capacitor that is the only one on both its nets
 * stand at an instant: the voltage across it (`u0`, plate a less plate b)
 * cannot change, and the current each side's network drives into its plate
 * must be the one current through the capacitor — `currentA(v)`/`currentB(v)`
 * the current a side's network (capacitor open) pushes into its plate at
 * `v`, each falling as `v` rises. Solved for plate a by bisection, from
 * `guess`; returns `{va, vb}`.
 */
export function pairStand(u0, currentA, currentB, guess, span) {
  const f = (va) => currentA(va) + currentB(va - u0);
  let lo = guess;
  let hi = guess;
  let flo = f(lo);
  if (flo === 0) return { va: guess, vb: guess - u0 };
  // f falls as plate a rises: step out until it changes sign.
  let step = Math.max(1, span / 8);
  let fhi = flo;
  for (let k = 0; k < 40 && Math.sign(fhi) === Math.sign(flo); k++) {
    if (flo > 0) {
      lo = hi;
      hi += step;
    } else {
      hi = lo;
      lo -= step;
    }
    fhi = f(flo > 0 ? hi : lo);
    step *= 2;
  }
  if (flo > 0) {
    flo = f(lo);
  } else {
    fhi = f(hi);
  }
  for (let k = 0; k < 100 && hi - lo > 1e-12; k++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (fm > 0) lo = mid;
    else hi = mid;
  }
  const va = (lo + hi) / 2;
  return { va, vb: va - u0 };
}

/**
 * The curves a lone capacitor's two plates run along from where they stand
 * (`pairStand`): each side's network linearized there (`la`, `lb` —
 * spice/voltages.js `linearize`'s `{amps, siemens}`, the current into its
 * plate and how fast it falls). Two resistances: one exponential, the
 * capacitor's C times both, each plate toward where its own network would
 * hold it with no current flowing. One side a current source (a saturated
 * output): the capacitor's voltage ramps at that current, that plate with
 * it, and the other plate holds. Null where both are current sources.
 */
export function pairCurves(t, va, vb, la, lb, farads) {
  const hold = (v) => ({ t0: t, v0: v, vInf: v, tau: Number.POSITIVE_INFINITY }); // prettier-ignore
  const ga = la.siemens > MIN_S;
  const gb = lb.siemens > MIN_S;
  if (ga && gb) {
    const tau = farads * (1 / la.siemens + 1 / lb.siemens);
    return {
      a: { t0: t, v0: va, vInf: va + la.amps / la.siemens, tau },
      b: { t0: t, v0: vb, vInf: vb + lb.amps / lb.siemens, tau },
    };
  }
  if (!ga && gb) {
    return {
      a: { ...hold(va), rate: la.amps / farads },
      b: hold(vb),
    };
  }
  if (ga && !gb) {
    return {
      a: hold(va),
      b: { ...hold(vb), rate: lb.amps / farads },
    };
  }
  return null;
}
