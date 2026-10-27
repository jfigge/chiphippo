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

// sim/meter-fuse.js — a multimeter fuse's heat (SimController #checkFuses
// and #sampleMeters feed it the current through each fused meter, in time
// order). Pure and DOM-free.
//
// The element heats as I² through one lag (FUSE_TAU_S), each current held
// to the next sample; the fuse blows FUSE_HOLD_S after that heat passes the
// rating², or at once past FUSE_INSTANT times the rating for FUSE_SURGE_S.
// An AC current's I² ripples at twice its frequency, and through a 10 ms
// lag at 50/60 Hz the heat swings ±13 % — so judged on the heat alone, a
// 0.41 A RMS sine dipped under F1's 0.4 A every half cycle, its timer
// started again each time, and it never blew while 0.41 A DC blew in
// 40 ms (the regrade, 2026-10-27). The heat's MEAN — a second, slower lag
// on it (FUSE_MEAN_S) — rides out that ripple: the timer starts when the
// heat passes the rating and stops only when the heat AND its mean are
// back under it. A DC current's heat never dips, so its timing is the
// heat's alone, as before.

import { FUSE_HOLD_S, FUSE_INSTANT } from "../catalog/meter.js";

/** How long a meter fuse carries FUSE_INSTANT times its rating before it
    blows "at once", simulated seconds — a surge under it (a capacitor
    emptying through the shunt) is far below a fast fuse's I²t (an
    assumption: the manual gives no curve). */
export const FUSE_SURGE_S = 1e-3;

/** A meter fuse's element heats as I² through one lag of this time
    constant, simulated seconds (an assumption, as the curves are): what is
    held to the rating is the current that heat stands for — an RMS over
    the last few periods. */
export const FUSE_TAU_S = 0.01;

/** The second lag, on the heat, simulated seconds: its mean over some
    periods of 50/60 Hz (the heat's 100/120 Hz ripple through both lags is
    under 0.5 %). */
export const FUSE_MEAN_S = 0.05;

/** A fuse's heat, cold, from `t`. */
export function coldFuse(t) {
  return { heat: 0, mean: 0, amps: 0, at: t, over: null, surge: null, from: null, i2dt: 0, rising: false, dip: t, pre: 0, closed: null, fresh: true }; // prettier-ignore
}

/**
 * A fuse's heat carried on to `t` (the current it last carried held up to
 * then), and `amps` from there — in place: when the heat came past the
 * rating (`over`), since when the instant's current has been past
 * FUSE_INSTANT times it (`surge`), and the I² it has carried since it last
 * came past the rating from cool (`from`, `i2dt` — what `fuseAmps` quotes),
 * that stretch starting where the current last stopped falling before it
 * (`dip`, `pre`) and closed at each low point since (`closed`): whole
 * half-cycles of an AC current, never a window opening on its peak.
 * @param {{heat: number, mean: number, amps: number, at: number,
 *   over: number|null, surge: number|null, from: number|null,
 *   i2dt: number, rising?: boolean, dip?: number, pre?: number,
 *   closed?: {at: number, i2dt: number, first: object}|null,
 *   fresh?: boolean}} f
 * @param {{amps: number}} fuse - its rating
 * @param {number} t - simulated seconds, never before `f.at`
 * @param {number} amps - the current from `t` on, signed (or a magnitude:
 *   a ramp of magnitudes cannot say it passed through zero between them)
 * @param {boolean} [ramp] - the current went from the last sample's to
 *   `amps` in a straight line (a sample along a curve between ticks), not
 *   held and stepped (a tick): held, a sine's few samples across its zero
 *   crossings — the curves are straight there — booked the I² of their
 *   start, and 0.399 A RMS heated as 0.41
 * @returns {object} `f`
 */
export function heatFuse(f, fuse, t, amps, ramp = false) {
  const rated = fuse.amps * fuse.amps;
  const a = f.amps;
  const dt = Math.max(0, t - f.at);
  // A ramp through zero (the sign turned): two ramps, each to or from
  // nothing, the crossing between them its low point.
  const cross = ramp && a * amps < 0 && dt > 0 ? f.at + (dt * Math.abs(a)) / (Math.abs(a) + Math.abs(amps)) : null; // prettier-ignore
  const i2 = !ramp ? a * a : cross != null ? (a * a * (cross - f.at) + amps * amps * (t - cross)) / 3 / dt : (a * a + a * amps + amps * amps) / 3; // prettier-ignore
  const mag = Math.abs(amps);
  // A fuse first seen on a current already flowing (a cool one is
  // forgotten, and begun again at the first sample with a current through
  // it): its first ramp away from zero taken back to where it began — else
  // a sine's overload opened a millisecond past its zero crossing, and
  // 0.92 A RMS was quoted 4 % high.
  if (f.fresh && dt > 0) {
    f.fresh = false;
    const up = mag - Math.abs(a);
    if (ramp && a * amps > 0 && up > 0 && (f.from == null || f.from === f.at)) {
      const back = Math.min((dt * Math.abs(a)) / up, 4 * dt);
      if (f.from == null) {
        f.dip = f.at - back;
        f.pre = (a * a * back) / 3;
      } else {
        // (…past the rating at once: its overload opens there too.)
        f.from = f.at - back;
        f.i2dt = (f.i2dt ?? 0) + (a * a * back) / 3;
      }
    }
  }
  // Both lags exact for I² held across `dt`.
  const e1 = Math.exp(-dt / FUSE_TAU_S);
  const e2 = Math.exp(-dt / FUSE_MEAN_S);
  const k = FUSE_TAU_S / (FUSE_TAU_S - FUSE_MEAN_S);
  const heat = i2 + (f.heat - i2) * e1;
  const mean = i2 + (f.heat - i2) * k * e1 + ((f.mean ?? 0) - i2 - (f.heat - i2) * k) * e2; // prettier-ignore
  // Where the current last stopped falling — a low point: a step up is
  // one at its own moment, a ramp up from a sample that was not itself
  // rising one at that sample, a ramp through zero one at the crossing.
  const rising = cross != null ? mag > 0 : mag > Math.abs(a);
  const low = cross ?? (rising ? (ramp ? (f.rising ? null : f.at) : t) : null); // prettier-ignore
  // (The I² of the stretch from the last sample up to the low point.)
  const before = cross != null ? (a * a * (cross - f.at)) / 3 : 0;
  if (f.from != null) {
    const close = (at, i2dt) => {
      f.closed = { at, i2dt, first: f.closed?.first ?? { at, i2dt } };
    };
    if (low != null && low < t) close(low, (f.i2dt ?? 0) + before);
    f.i2dt = (f.i2dt ?? 0) + i2 * dt;
    if (low === t) close(t, f.i2dt);
  } else if (!rising || !ramp) {
    f.dip = t;
    f.pre = 0;
  } else {
    if (low != null) f.dip = low;
    f.pre = (low != null ? -before : (f.pre ?? 0)) + i2 * dt;
  }
  f.rising = rising;
  if (heat <= rated && !(mean > rated)) f.over = null;
  else if (f.over == null && heat > rated) f.over = f.heat > rated ? f.at : f.at + FUSE_TAU_S * Math.log((i2 - f.heat) / (i2 - rated)); // prettier-ignore
  f.heat = heat;
  f.mean = mean;
  f.amps = amps;
  f.at = Math.max(f.at, t);
  // (Past FUSE_INSTANT times it, "at once" is a surge that lasts
  // FUSE_SURGE_S: a supply's own 470 µF emptying through the 10 A
  // shunt at Run — 125 A for some 20 µs, far under a fast fuse's I²t —
  // blew F2 the moment Spice Lite started its supplies charged, as
  // ngspice does; the 2026-10-26 review.)
  f.surge = mag >= fuse.amps * FUSE_INSTANT ? (f.surge ?? t) : null;
  // The overload's own stretch: from where the current last stopped
  // falling before it first passed the rating (an AC current's zero
  // crossing; a DC step's own moment), until it is cool again (its mean a
  // quarter of the rating's).
  if (f.from == null && mag > fuse.amps) {
    f.from = f.dip ?? f.at;
    f.i2dt = f.pre ?? 0;
    f.closed = null;
  } else if (
    f.from != null &&
    mag <= fuse.amps &&
    heat <= rated &&
    mean <= rated / 4
  ) {
    f.from = null;
    f.closed = null;
    f.dip = f.at;
    f.pre = 0;
  }
  return f;
}

/** Whether a fuse's heat blows it at `t`. */
export function fuseBlown(f, t) {
  return (
    (f.over != null && t - f.over >= FUSE_HOLD_S * (1 - 1e-9)) ||
    (f.surge != null && t - f.surge >= FUSE_SURGE_S)
  );
}

/** The current a blown fuse is said to have carried, amps: the RMS over
    its overload (`from` on) — a DC current's own value, an AC one's RMS
    over the whole half-cycles it ran (`closed`; a window ending wherever
    the blow fell read 0.6 A RMS as 0.653), never the instant's (a sine's
    peak, or its zero) — else the heat's. */
export function fuseAmps(f, t) {
  const from = f.from ?? t;
  // (Between the first low point inside it and the last where there are
  // two — a current switched on mid-wave opened its window on a peak — else
  // from where it began to the last.)
  const c = f.closed;
  if (c && c.at > c.first.at) return Math.sqrt((c.i2dt - c.first.i2dt) / (c.at - c.first.at)); // prettier-ignore
  if (c && c.at > from) return Math.sqrt(c.i2dt / (c.at - from));
  const span = t - from;
  if (span > 0) return Math.sqrt(f.i2dt / span);
  return Math.max(Math.abs(f.amps), Math.sqrt(f.heat));
}
