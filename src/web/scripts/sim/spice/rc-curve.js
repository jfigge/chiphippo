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

// spice/rc-curve.js — the one curve Spice Lite knows: a first-order
// exponential, V(t) = V∞ + (V0 − V∞)·e^(−(t − t0)/τ). Pure and DOM-free.
//
// An RC node charges along it, a 555's capacitor runs along it between its
// thresholds, and an LR current ramps along it. It is solved in CLOSED FORM —
// never stepped — so the time a node reaches a voltage is a logarithm, and a
// 10 s time constant costs exactly what a 1 µs one does
// (features/done/spice-lite.md §0).
//
// Nodes that move TOGETHER (spice/dynamics.js — a ladder, a capacitor alone
// between two gates) run along a COUPLED curve instead: `kind` "modal" (a sum
// of exponentials, closed form) or "system" (read through e^A). Every reader
// here takes either; a coupled curve ends at its group's next corner in TIME
// (`tEnd`), where all of the group's nodes are linearized again together.

import { coupledFinal, coupledSlope, coupledValue } from "./dynamics.js";

/** Whether a curve is one of a group of coupled nodes' (spice/dynamics.js). */
export const isCoupled = (curve) => curve.kind != null;

/**
 * The value at `t` of a curve anchored at (`t0`, `v0`) heading for `vInf`
 * with time constant `tau` (seconds; Infinity holds, 0 is already there). A
 * curve with a `rate` (volts per second) is a straight RAMP instead — a
 * capacitor charged by a current that does not change as it charges (an
 * output saturated at its limit); spice/engine.js ends it at its next corner.
 *
 * A curve with a corner (`until`) is only TRUE up to it — past it the
 * network it was linearized from is a different one — so it is never read
 * past it: it stands at its corner until spice/engine.js linearizes it again
 * there. A tick that skips history (a late one past its catch-up budget, one
 * after an oscillation) reads its nodes far ahead of their anchors, and a
 * ramp read straight on from a saturated output ran tens of volts past the
 * rails — and smoked the chip for it.
 */
export function valueAt(curve, t) {
  if (isCoupled(curve)) {
    const end = curve.tEnd ?? Number.POSITIVE_INFINITY;
    return coupledValue(curve, Math.max(0, Math.min(t, end) - curve.t0));
  }
  const v = rawValueAt(curve, t);
  const { until } = curve;
  if (until == null) return v;
  const dir = heading(curve);
  return (v - until) * dir > 0 ? until : v;
}

/** The curve's own formula, corner or none. */
function rawValueAt({ t0, v0, vInf, tau, rate }, t) {
  if (rate) return v0 + rate * Math.max(0, t - t0);
  if (!(tau > 0)) return vInf;
  if (!Number.isFinite(tau)) return v0;
  const dt = Math.max(0, t - t0);
  return vInf + (v0 - vInf) * Math.exp(-dt / tau);
}

/**
 * How long after its anchor a curve from `v0` toward `vInf` takes to reach
 * `v` — Infinity when it never will (`v` is not strictly between them). For
 * a ramp, `crossingTime`.
 */
export function timeToReach(v0, vInf, tau, v) {
  if (!Number.isFinite(tau) || !(tau > 0)) return Number.POSITIVE_INFINITY;
  const from = v0 - vInf;
  const to = v - vInf;
  if (from === 0 || to === 0 || Math.sign(from) !== Math.sign(to)) {
    return Number.POSITIVE_INFINITY;
  }
  if (Math.abs(to) >= Math.abs(from)) return Number.POSITIVE_INFINITY;
  return tau * Math.log(from / to);
}

/** A step smaller than this is nothing — volts for a node, and for an
    inductor's current, amps (`ARRIVED_STEP_A`): a settled coupled group is
    re-anchored at every settle, and what is left of its step is rounding
    (~1e-15 V) — judged against 1 % of that, it never arrived, and the desk
    asked for frames forever. */
export const ARRIVED_STEP_V = 1e-9;
export const ARRIVED_STEP_A = 1e-15;

/**
 * Whether a curve is "there" by the fallback rule: the gap still left to its
 * asymptote is under `gapPercent` of the step it is taking (1 % ≈ 4.6 τ;
 * scale-invariant, so a 1 µs and a 10 s RC are judged alike). A step of
 * nothing (under `floor`) has arrived.
 * @param {object} curve
 * @param {number} t
 * @param {number} gapPercent
 * @param {number} [floor] - the least step that is one (a coil's: amps)
 */
export function hasArrived(curve, t, gapPercent, floor = ARRIVED_STEP_V) {
  if (isCoupled(curve)) {
    const end = coupledFinal(curve);
    if (end == null) return false;
    const step = Math.abs(coupledValue(curve, 0) - end);
    if (step <= floor) return true;
    return Math.abs(valueAt(curve, t) - end) <= (gapPercent / 100) * step;
  }
  if (curve.rate) return false;
  const step = Math.abs(curve.v0 - curve.vInf);
  if (step <= floor || !Number.isFinite(curve.tau)) return true;
  return Math.abs(valueAt(curve, t) - curve.vInf) <= (gapPercent / 100) * step;
}

/**
 * How long from `t` a curve takes to reach `v` — an exponential's logarithm or
 * a ramp's straight line — or Infinity when it never will.
 */
export function crossingTime(curve, t, v) {
  if (isCoupled(curve)) return coupledCrossing(curve, t, v);
  const now = valueAt(curve, t);
  if (curve.rate) {
    const dt = (v - now) / curve.rate;
    return dt > 0 ? dt : Number.POSITIVE_INFINITY;
  }
  return timeToReach(now, curve.vInf, curve.tau, v);
}

/** Which way a curve is moving: +1, −1, or 0 (holding) — at `t`, for a
    coupled one (a sum of exponentials may turn). */
export function heading(curve, t = curve.t0) {
  if (isCoupled(curve)) {
    // At (or past) its corner, the way it was going as it got there: the
    // way the node is about to enter the next piece.
    const end = curve.tEnd ?? Number.POSITIVE_INFINITY;
    return Math.sign(coupledSlope(curve, Math.max(0, Math.min(t, end) - curve.t0))); // prettier-ignore
  }
  if (curve.rate) return Math.sign(curve.rate);
  if (!Number.isFinite(curve.tau)) return 0;
  return Math.sign(curve.vInf - curve.v0);
}

/** How many points `sampleTimes` takes across a span, at the least. */
const SAMPLES = 96;

/**
 * The times a search for a coupled curve's first crossing after `t` looks
 * at, up to `end`: a cubic grid (dense near `t`, where a sum of exponentials
 * still moves fastest) and a geometric one from its fastest time constant,
 * so a mode a thousand times faster than the span is not stepped over.
 * @param {number} t
 * @param {number} end
 * @param {number} fast - the fastest time constant, seconds
 */
export function sampleTimes(t, end, fast) {
  const out = [];
  for (let i = 1; i <= SAMPLES; i++) out.push(t + (end - t) * (i / SAMPLES) ** 3); // prettier-ignore
  if (fast > 0 && Number.isFinite(fast)) {
    for (let h = fast / 8; t + h < end; h *= 2) out.push(t + h);
  }
  return out.sort((a, b) => a - b);
}

/** How far past `t` a search over a coupled curve need look: its corner, or
    fifty of its slowest time constants (a day, where it never settles). */
export function searchEnd(curve, t) {
  const end = curve.tEnd ?? Number.POSITIVE_INFINITY;
  if (Number.isFinite(end)) return end;
  const slow = curve.scale?.slow ?? Number.POSITIVE_INFINITY;
  return t + (Number.isFinite(slow) && slow > 0 ? 50 * slow : 86400);
}

/**
 * The first time after `t` the function `f` (negative now) reaches zero
 * going up, sampled at `times` and bisected — or Infinity.
 * @param {(u: number) => number} f
 * @param {number} t
 * @param {number[]} times
 */
export function firstRoot(f, t, times) {
  let prev = t;
  for (const u of times) {
    if (!(u > prev)) continue;
    if (f(u) >= 0) {
      let lo = prev;
      let hi = u;
      for (
        let k = 0;
        k < 200 && hi - lo > 1e-15 * Math.max(1, Math.abs(hi));
        k++
      ) {
        // prettier-ignore
        const mid = (lo + hi) / 2;
        if (f(mid) >= 0) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    prev = u;
  }
  return Number.POSITIVE_INFINITY;
}

/** How long from `t` a coupled curve takes to reach `v` (either way), or
    Infinity. */
function coupledCrossing(curve, t, v) {
  const now = valueAt(curve, t);
  if (now === v) return 0;
  const dir = v > now ? 1 : -1;
  const end = searchEnd(curve, t);
  const when = firstRoot((u) => (valueAt(curve, u) - v) * dir, t, sampleTimes(t, end, curve.scale?.fast)); // prettier-ignore
  return when - t;
}

/**
 * What a curve is heading for, as a cycle's signature compares it
 * (spice/cycles.js): `{vInf, tau, rate}` — a coupled node's by where it
 * settles (NaN where it never does) and its slowest mode's time constant.
 */
export function curveSummary(curve) {
  if (!isCoupled(curve)) {
    return { vInf: curve.vInf, tau: curve.tau, rate: curve.rate ?? 0 };
  }
  let tau = 0;
  for (const { k } of curve.terms ?? []) {
    tau = Math.max(tau, k < 0 ? -1 / k : Number.POSITIVE_INFINITY);
  }
  return { vInf: coupledFinal(curve) ?? Number.NaN, tau, rate: 0 };
}
