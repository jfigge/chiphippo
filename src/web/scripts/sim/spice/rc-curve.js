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
 * Where a curve comes to rest — an exponential's asymptote (or the corner it
 * stops at first), a coupled group's final value — or null for a ramp, which
 * never does, and a coupled group with no final value.
 * @param {object} curve
 * @returns {number|null}
 */
export function finalValue(curve) {
  if (isCoupled(curve)) {
    return Number.isFinite(curve.tEnd) ? valueAt(curve, curve.tEnd) : coupledFinal(curve); // prettier-ignore
  }
  if (curve.rate) return null;
  return valueAt(curve, Number.POSITIVE_INFINITY);
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

/** How fast a curve is moving at `t`, volts (or amps) a second — at (or
    past) a coupled one's corner, as it got there, as `heading` reads it. */
export function rateOf(curve, t = curve.t0) {
  if (isCoupled(curve)) {
    const end = curve.tEnd ?? Number.POSITIVE_INFINITY;
    return coupledSlope(curve, Math.max(0, Math.min(t, end) - curve.t0));
  }
  if (curve.rate) return curve.rate;
  if (!Number.isFinite(curve.tau)) return 0;
  return (curve.vInf - valueAt(curve, t)) / curve.tau;
}

/** How many points `sampleTimes` takes across a span, at the least. */
const SAMPLES = 96;

/** Where in a span the cubic grid is as dense as a doubling one: its third
    point, (3/96)³ of the way. */
const DENSE_FROM = (3 / SAMPLES) ** 3;

/** How many periods of a ringing curve `sampleTimes` steps through, at
    most. It was 50 (a Q-of-50 ring has died to a twentieth past them), but
    a DRIVEN oscillation — an AC supply or a clock's sine, a state of its
    group — never dies, and past them a crest clearing a threshold by a hair
    was looked for on the cubic grid alone: 1 kHz through 1 µF onto a
    CD40106B with 1 MΩ to VDD tripped it 17 ms (seventeen crests) late,
    ticked only at its wakes. */
const RING_PERIODS = 256;

/** …a sixteenth of a period apart. An eighth (125 µs on a 1 kHz buzz)
    stepped over an 84 µs excursion of a piece, so whether a corner was seen
    hung on where the search began — an unconnected 7 Hz clock on the Zero
    crossing example cost its '90 a count. */
const RING_STEPS = 16;

/**
 * The times a search for a coupled curve's first crossing after `t` looks
 * at, up to `end`: a cubic grid (dense near `t`, where a sum of exponentials
 * still moves fastest) and a geometric one from its fastest time constant,
 * so a mode a thousand times faster than the span is not stepped over —
 * and, where it rings (`osc`, its oscillation, radians a second — or each
 * of several), every `RING_STEPS`th of a period for `RING_PERIODS`: a
 * grid a radian or two apart stepped over a threshold cleared only near a
 * peak (a Schmitt input on an LC ring, a relay on a ringing coil).
 * @param {number} t
 * @param {number} end
 * @param {number} fast - the fastest time constant, seconds
 * @param {number|number[]} [osc] - the oscillations, radians a second
 */
export function sampleTimes(t, end, fast, osc = 0) {
  const cubic = [];
  for (let i = 1; i <= SAMPLES; i++) cubic.push(t + (end - t) * (i / SAMPLES) ** 3); // prettier-ignore
  const doubling = [];
  if (fast > 0 && Number.isFinite(fast)) {
    // Doubling from the fastest time constant up to where the cubic grid is
    // as dense (its third point: past it each step is under a third of the
    // time so far) — past there they were points the grid already had,
    // each a full read of every network at every corner.
    const until = Math.min(end, t + (end - t) * DENSE_FROM);
    for (let h = fast / 8; t + h < until; h *= 2) doubling.push(t + h);
  }
  let rings = [];
  for (const w of Array.isArray(osc) ? osc : [osc]) {
    if (!(w > 0) || !Number.isFinite(w)) continue;
    const h = (2 * Math.PI) / (RING_STEPS * w);
    const stop = Math.min(end, t + (RING_PERIODS * 2 * Math.PI) / w);
    // (Counted, not summed: `u += h` stood still once h fell under t's ulp.)
    const ring = [];
    for (let k = 1; t + k * h < stop; k++) ring.push(t + k * h);
    rings = merged(rings, ring);
  }
  // Each grid rises, so they are merged, not sorted.
  return merged(merged(cubic, doubling), rings);
}

/** Two rising lists as one. */
function merged(a, b) {
  if (!b.length) return a;
  if (!a.length) return b;
  const out = new Array(a.length + b.length);
  let i = 0;
  let j = 0;
  for (let k = 0; k < out.length; k++) {
    out[k] = j >= b.length || (i < a.length && a[i] <= b[j]) ? a[i++] : b[j++];
  }
  return out;
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
 * going up, sampled at `times` and bisected — or Infinity. Where the samples
 * rise and fall again short of zero, the peak between them (the parabola
 * through the three) is looked at too: a ring that clears a threshold only
 * near its crest clears it between two samples.
 * @param {(u: number) => number} f
 * @param {number} t
 * @param {number[]} times
 * @param {number} [rel] - bisected no finer than this share of the time from
 *   `t` (else to the last few ulps): a corner (spice/engine.js
 *   `groupCorner`) is where a curve's slope changes, and found to 1e-15 s
 *   every one cost ~30 reads of every network
 * @param {(u: number) => number} [clear] - read straight after `f(u)`: how
 *   long past `u` `f` cannot reach zero. The samples inside that stretch are
 *   stepped over unread, and a bisection's low end moves past it — a corner
 *   search (`groupCorner`) knows each element's distance to its next piece
 *   and how fast it can close it
 */
export function firstRoot(f, t, times, rel = 0, clear = null) {
  const bisect = (lo, hi, flo, fhi) => {
    const tol = Math.max(1e-15 * Math.max(1, Math.abs(hi)), rel * (hi - t));
    // With nothing to step over, closed on as a root, not halved: a
    // transistor saturated behind its base resistance is searched for by
    // its distance inside its piece, through a network solve a read — some
    // twenty-three of them a corner, bisected (the fourth regrade,
    // 2026-10-22).
    if (!clear) return closeOn(f, lo, hi, flo ?? f(lo), fhi, tol);
    for (let k = 0; k < 200 && hi - lo > tol; k++) {
      const mid = (lo + hi) / 2;
      if (f(mid) >= 0) hi = mid;
      else lo = clear ? Math.min(hi, mid + clear(mid)) : mid;
    }
    return hi;
  };
  let prev = t;
  let back = null; // the sample before `prev`, [u, f(u)]
  let fPrev = null;
  let safe = clear && f(t) < 0 ? t + clear(t) : t; // no root before it
  for (const u of times) {
    if (!(u > prev) || u < safe) continue;
    const fu = f(u);
    if (fu >= 0) return bisect(Math.max(prev, safe), u, prev >= safe ? fPrev : null, fu); // prettier-ignore
    if (clear) safe = u + clear(u);
    if (back && fPrev > back[1] && fPrev >= fu) {
      const peak = crest(back[0], back[1], prev, fPrev, u, fu);
      const fp = peak == null ? null : f(peak);
      if (fp != null && fp >= 0) return bisect(back[0], peak, back[1], fp);
    }
    back = fPrev == null ? null : [prev, fPrev];
    prev = u;
    fPrev = fu;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * The first moment `f` reaches zero going up between `lo` (f < 0 there,
 * `flo`) and `hi` (f ≥ 0, `fhi`), to `tol`: Brent's method (as
 * spice/transistors.js `solveRising`), its answer the end of its last
 * bracket where `f` is up — a bisection's, reached in a few reads where `f`
 * is smooth, and in a bisection's where it steps.
 */
function closeOn(f, lo, hi, flo, fhi, tol) {
  if (!(flo < 0)) return bisectOn(f, lo, hi, tol);
  const up = (x) => x >= 0;
  const half = tol / 2;
  let a = lo;
  let fa = flo;
  let b = hi;
  let fb = fhi;
  let c = a;
  let fc = fa;
  let d = b - a;
  let e = d;
  for (let k = 0; k < 200; k++) {
    if (up(fb) === up(fc)) {
      c = a;
      fc = fa;
      d = b - a;
      e = d;
    }
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b;
      b = c;
      c = a;
      fa = fb;
      fb = fc;
      fc = fa;
    }
    const xm = (c - b) / 2;
    if (Math.abs(xm) <= half) break;
    if (Math.abs(e) >= half && Math.abs(fa) > Math.abs(fb)) {
      const s = fb / fa;
      let p;
      let q;
      if (a === c) {
        p = 2 * xm * s;
        q = 1 - s;
      } else {
        const r = fb / fc;
        const w = fa / fc;
        p = s * (2 * xm * w * (w - r) - (b - a) * (r - 1));
        q = (w - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) q = -q;
      p = Math.abs(p);
      if (2 * p < Math.min(3 * xm * q - Math.abs(half * q), Math.abs(e * q))) {
        e = d;
        d = p / q;
      } else {
        d = xm;
        e = d;
      }
    } else {
      d = xm;
      e = d;
    }
    a = b;
    fa = fb;
    b += Math.abs(d) > half ? d : Math.sign(xm) * half;
    fb = f(b);
  }
  // Of the bracket's two ends, the one where `f` is up.
  return up(fb) ? (up(fc) ? Math.min(b, c) : b) : c;
}

/** `closeOn`'s answer by halving alone. */
function bisectOn(f, lo, hi, tol) {
  for (let k = 0; k < 200 && hi - lo > tol; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) >= 0) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Where the parabola through three samples, the middle one highest, peaks
    — strictly between the outer two — or null. Stated about the middle
    sample: the times are seconds from Run, their gaps microseconds. */
function crest(u0, f0, u1, f1, u2, f2) {
  const d0 = u0 - u1;
  const d2 = u2 - u1;
  const s0 = (f0 - f1) / d0;
  const s2 = (f2 - f1) / d2;
  const a = (s0 - s2) / (d0 - d2);
  if (!(a < 0)) return null;
  const b = s0 - a * d0;
  const at = u1 - b / (2 * a);
  return at > u0 && at < u2 ? at : null;
}

/** How long from `t` a coupled curve takes to reach `v` (either way), or
    Infinity. */
function coupledCrossing(curve, t, v) {
  const now = valueAt(curve, t);
  if (now === v) return 0;
  const dir = v > now ? 1 : -1;
  const end = searchEnd(curve, t);
  const when = firstRoot((u) => (valueAt(curve, u) - v) * dir, t, sampleTimes(t, end, curve.scale?.fast, curve.scale?.oscs ?? curve.scale?.osc)); // prettier-ignore
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
