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

// spice/rc-curve.js — the one curve Spice Light knows: a first-order
// exponential, V(t) = V∞ + (V0 − V∞)·e^(−(t − t0)/τ). Pure and DOM-free.
//
// An RC node charges along it, a 555's capacitor runs along it between its
// thresholds, and an LR current ramps along it. It is solved in CLOSED FORM —
// never stepped — so the time a node reaches a voltage is a logarithm, and a
// 10 s time constant costs exactly what a 1 µs one does
// (features/spice-light.md §0).

/**
 * The value at `t` of a curve anchored at (`t0`, `v0`) heading for `vInf`
 * with time constant `tau` (seconds; Infinity holds, 0 is already there).
 */
export function valueAt({ t0, v0, vInf, tau }, t) {
  if (!(tau > 0)) return vInf;
  if (!Number.isFinite(tau)) return v0;
  const dt = Math.max(0, t - t0);
  return vInf + (v0 - vInf) * Math.exp(-dt / tau);
}

/**
 * How long after its anchor a curve from `v0` toward `vInf` takes to reach
 * `v` — Infinity when it never will (`v` is not strictly between them).
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

/**
 * Whether a curve is "there" by the fallback rule: the gap still left to its
 * asymptote is under `gapPercent` of the step it is taking (1 % ≈ 4.6 τ;
 * scale-invariant, so a 1 µs and a 10 s RC are judged alike). A step of
 * nothing has arrived.
 */
export function hasArrived(curve, t, gapPercent) {
  const step = Math.abs(curve.v0 - curve.vInf);
  if (step === 0 || !Number.isFinite(curve.tau)) return true;
  return Math.abs(valueAt(curve, t) - curve.vInf) <= (gapPercent / 100) * step;
}
