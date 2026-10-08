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

// timing.js — the shared rules for parts that keep TIME: the 555 and the
// RC-timed CD4000 parts (the 4047, 4060, 4098 and 4538). Pure and DOM-free.
//
// The engine is timerless, and stays so. A timed part never measures time; it
// is TOLD it. SimController keeps a simulated clock (seconds since Run, frozen
// while paused or stalled, scaled by the speed multiplier) and hands every
// tick its reading as `now`; the part's `step` sees `env.now` and writes into
// its state WHEN its next change is due, and the engine reports the earliest
// such moment across the desk (`wakeAt`) so the controller can tick again
// exactly then. So a timed part's state is a function of `now` and its own
// start time, which is what keeps `step` idempotent within a tick and every
// test a plain call with a chosen `now`.
//
// THE CAP. A timed part is run no faster than the fastest clock the app
// offers (CLOCK_HZ's top, 1 kHz): every edge is a tick, and a 48 kHz 555 run
// edge by edge would be all the board ever did. An oscillation computed faster
// than that is SHOWN at the cap, its duty cycle kept, and its TRUE rate is
// what the part reports; a one-shot pulse shorter than half the cap's period
// is shown that long, so a 10 µs pulse still lands one edge on a counter
// rather than none.

import { CLOCK_HZ } from "../catalog/parts.js";

/** The fastest a timed output is animated, Hz — the top of CLOCK_HZ. */
export const TIMING_CAP_HZ = Math.max(
  ...CLOCK_HZ.filter((hz) => typeof hz === "number"),
);

/** The shortest stretch any timed output is shown at one level, seconds. */
export const MIN_SHOWN_S = 1 / (2 * TIMING_CAP_HZ);

/** A boundary this close to `now` counts as reached: the controller ticks AT a
    deadline, and float arithmetic must not leave it a hair short (which would
    ask for a second tick at the same instant). */
export const EPS = 1e-9;

/**
 * A run of timed SEGMENTS scaled so the cycle is no faster than the cap:
 * `cycle` is the repeating part, `lead` an optional one-off prefix (a 4047's
 * longer first half-cycle). Each is a list of seconds. Returns the shown
 * segments and whether they were slowed.
 * @param {number[]} cycle
 * @param {number[]} [lead]
 * @returns {{cycle: number[], lead: number[], capped: boolean, scale: number}}
 */
export function capSchedule(cycle, lead = []) {
  const period = cycle.reduce((a, b) => a + b, 0);
  const floor = 1 / TIMING_CAP_HZ;
  if (!(period > 0) || period >= floor) {
    return { cycle, lead, capped: false, scale: 1 };
  }
  const scale = floor / period;
  return {
    cycle: cycle.map((s) => s * scale),
    lead: lead.map((s) => s * scale),
    capped: true,
    scale,
  };
}

/**
 * Where a schedule started at `t0` stands at `now`: the index of the segment
 * it is in (counted from the first lead segment, continuing through every
 * repetition of the cycle) and when the NEXT boundary falls.
 * @param {{cycle: number[], lead: number[]}} schedule - from capSchedule.
 * @param {number} t0
 * @param {number} now
 * @returns {{index: number, next: number}}
 */
export function scheduleAt({ cycle, lead }, t0, now) {
  let t = t0;
  for (let i = 0; i < lead.length; i++) {
    if (now < t + lead[i] - EPS) return { index: i, next: t + lead[i] };
    t += lead[i];
  }
  const period = cycle.reduce((a, b) => a + b, 0);
  const elapsed = Math.max(0, now - t);
  let n = Math.floor((elapsed + EPS) / period);
  let start = t + n * period;
  for (;;) {
    for (let j = 0; j < cycle.length; j++) {
      const end = start + cycle[j];
      if (now < end - EPS) {
        return { index: lead.length + n * cycle.length + j, next: end };
      }
      start = end;
    }
    n += 1;
  }
}

/**
 * Carry a running schedule across a change of its timing — a resistor or
 * capacitor edited, a potentiometer turned, while the circuit runs. A part's
 * state is a function of `now` and the moment its cycle began (`t0`), so a new
 * period read against the old `t0` would rewrite the whole history: the output
 * would jump to wherever the new rate would have put it by now. Instead the
 * oscillation goes on from where it IS — the same segment, the same fraction of
 * the way through it — at the new rate: returns the `t0` that puts `next`
 * there at `now`.
 * @param {{cycle: number[], lead: number[]}} prev - the schedule it ran on.
 * @param {{cycle: number[], lead: number[]}} next - the one it runs on now.
 * @param {number} t0
 * @param {number} now
 * @returns {number}
 */
export function rebase(prev, next, t0, now) {
  const segment = (s, i) =>
    i < s.lead.length
      ? s.lead[i]
      : s.cycle[(i - s.lead.length) % s.cycle.length];
  const { index, next: end } = scheduleAt(prev, t0, now);
  const length = segment(prev, index);
  const through = length > 0 ? Math.min(1, Math.max(0, 1 - (end - now) / length)) : 0; // prettier-ignore
  // Where segment `index` starts on the NEW schedule, counted from its t0.
  let start = 0;
  for (let i = 0; i < Math.min(index, next.lead.length); i++) {
    start += next.lead[i];
  }
  if (index > next.lead.length) {
    const into = index - next.lead.length;
    const period = next.cycle.reduce((a, b) => a + b, 0);
    start += Math.floor(into / next.cycle.length) * period;
    for (let j = 0; j < into % next.cycle.length; j++) start += next.cycle[j];
  }
  return now - (start + through * segment(next, index));
}

/**
 * The same for a part that keeps a COUNT of its oscillator's periods (the
 * CD4060B, the CD4541B): the count, and how far into the current period it
 * is, carry over — so the stages a counter has reached stay reached. Returns
 * the new `t0`.
 */
export function rebaseCount(prevPeriod, nextPeriod, t0, now) {
  return now - ((now - t0) / prevPeriod) * nextPeriod;
}

/**
 * How long a one-shot pulse of `width` seconds is SHOWN: never under
 * MIN_SHOWN_S. Returns the shown width and whether it was stretched.
 * @param {number} width
 */
export function shownPulse(width) {
  return width >= MIN_SHOWN_S
    ? { width, capped: false }
    : { width: MIN_SHOWN_S, capped: true };
}

/** The earliest of several optional deadlines, or null. */
export function earliest(...times) {
  let best = null;
  for (const t of times) {
    if (typeof t === "number" && Number.isFinite(t)) {
      best = best == null ? t : Math.min(best, t);
    }
  }
  return best;
}
