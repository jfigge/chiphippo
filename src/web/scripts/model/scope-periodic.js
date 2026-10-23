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

// scope-periodic.js — an oscillation faster than the desk can show, as the
// logic analyzer draws it: at its TRUE rate. Pure and DOM-free.
//
// Spice Lite draws a cycle faster than TIMING_CAP_HZ slowed to the cap, its
// duty kept (spice/cycles.js): every stretch of one true cycle shown `scale`
// times as long, while simulated time runs on true. Recorded as it is shown,
// a 4.8 kHz 555 read a 1 ms period between the analyzer's cursors. But while
// it is drawn it is exactly periodic, and the engine has its ONE true cycle
// on record — every node's curve, every net's level, at true moments: a
// TEMPLATE per net (spice/sample.js `cycleTemplates`), and the true wave is
// that template repeated every `period` from the cycle's start. The tracker
// keeps, per channel, the stretches (SPANS) in which that holds, and the
// view draws them repeated at true time.
//
// Which channels repeat is OBSERVED, not assumed: everything on the drawn
// island is shown slowed, but a counter on it (a 4060's slow stages) counts
// at its own pace. A channel's span is drawn only once a whole shown cycle of
// its recorded columns has stood where its template has them at their shown
// moments (`confirmed`), and it ends at the first column that does not — a
// counter output that holds still for a while is a constant span (true: it
// is constant), and ends where it moves, its columns there being its own
// moments. A channel whose net is on no drawn cycle is untouched.

/** How far a voltage may stand from its template and still be the same
    cycle, a share of the lanes' full scale: two shown cycles are read at
    different moments of it, each chord within the curve sampler's 0.2 %. */
export const SAME_SHARE = 0.02;

/** How close two moments of a template are one, true seconds as a share of
    the period (a tick's sample and its step share their moment). */
const SAME_U = 1e-9;

/**
 * A template's value at true offset `u` (0 ≤ u < period). The template is
 * one period of a wave that repeats, so it wraps: before its first point it
 * stands where its last left it. Between two points it is joined straight
 * when the later is a curve sample, else held to it (a tick's step). Returns
 * the points at `u` (within `eps`) too: a tick and the sample at its foot
 * share a moment, and either is the wave there.
 * @param {Array<{u: number, cell: *, volts: number|null, curve: boolean}>} pts
 * @param {number} u
 * @param {number} period
 * @param {number} [eps]
 * @returns {{near: object[], cell: *, volts: number|null}}
 */
export function templateAt(pts, u, period, eps = 0) {
  const n = pts.length;
  let lo = -1;
  let a = 0;
  let b = n - 1;
  while (a <= b) {
    const mid = (a + b) >> 1;
    if (pts[mid].u <= u + eps) {
      lo = mid;
      a = mid + 1;
    } else b = mid - 1;
  }
  const near = [];
  for (let i = lo; i >= 0 && pts[i].u >= u - eps; i--) near.push(pts[i]);
  const from = lo < 0 ? pts[n - 1] : pts[lo];
  const fromU = lo < 0 ? from.u - period : from.u;
  const to = pts[(lo + 1) % n];
  const toU = lo + 1 < n ? to.u : to.u + period;
  let volts = from.volts;
  if (to.curve && from.volts != null && to.volts != null && toU > fromU) {
    volts = from.volts + ((to.volts - from.volts) * (u - fromU)) / (toU - fromU); // prettier-ignore
  }
  return { near, cell: from.cell, volts };
}

/** Whether a column's value stands where the template has it at `u`. */
function fits(pts, u, period, eps, value, tolerance) {
  const at = templateAt(pts, u, period, eps);
  const same = (p) =>
    p.cell === value.cell &&
    (p.volts == null) === (value.volts == null) &&
    (value.volts == null || Math.abs(p.volts - value.volts) <= tolerance);
  if (at.near.some(same)) return true;
  if (at.cell !== value.cell) return false;
  if ((at.volts == null) !== (value.volts == null)) return false;
  return value.volts == null || Math.abs(at.volts - value.volts) <= tolerance;
}

/** Whether a template never moves: one level, its volts within `tolerance`. */
const FLAT = new WeakMap();
function flat(pts, tolerance) {
  let known = FLAT.get(pts);
  if (known == null) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      if (p.volts != null) {
        lo = Math.min(lo, p.volts);
        hi = Math.max(hi, p.volts);
      }
    }
    known = pts.every((p) => p.cell === pts[0].cell) && !(hi - lo > tolerance);
    FLAT.set(pts, known);
  }
  return known;
}

/**
 * Per channel, the stretches in which it is a drawn cycle's slowed picture,
 * each with the cycle's true template (SimController `#scopeCycles` → spice/
 * sample.js `cycleTemplates`). Fed every recorded column, in order.
 */
export class PeriodicTracker {
  /** channel id → {open, spans, wait} */
  #channels = new Map();

  reset() {
    this.#channels.clear();
  }

  /**
   * One recorded column. `values` is channel id → `{cell, volts, cycle,
   * template}`: `cycle` the drawn cycle its net is on (`{id, start, shown,
   * period}`, the sim-tick's `cycles`) or null, `template` its net's true
   * cycle there.
   * @param {number} at - the column's moment, simulated seconds
   * @param {Map<string, object>} values
   * @param {{tolerance: number}} opts - volts two readings may differ by
   */
  observe(at, values, { tolerance }) {
    for (const [id, value] of values) {
      let ch = this.#channels.get(id);
      if (!ch) this.#channels.set(id, (ch = { open: null, spans: [], wait: null })); // prettier-ignore
      this.#step(ch, at, value, tolerance);
    }
    // A channel no longer recorded closes its stretch.
    for (const [id, ch] of this.#channels) {
      if (!values.has(id)) this.#close(ch);
    }
  }

  #step(ch, at, value, tolerance) {
    const { cycle, template } = value;
    // A flat template is no oscillation (a counter's slow stage on the
    // island, still between counts): its columns already say it truly.
    if (
      !cycle ||
      !template?.length ||
      !(cycle.shown > cycle.period) ||
      flat(template, tolerance)
    ) {
      // prettier-ignore
      this.#close(ch);
      ch.wait = null;
      return;
    }
    if (ch.open && (ch.open.id !== cycle.id || ch.open.template !== template)) {
      this.#close(ch);
    }
    if (ch.wait && ch.wait.id !== cycle.id) ch.wait = null;
    if (ch.wait && at < ch.wait.at) return;
    if (!ch.open) {
      ch.wait = null;
      ch.open = {
        id: cycle.id,
        start: cycle.start,
        period: cycle.period,
        shown: cycle.shown,
        from: at,
        to: at,
        template,
        confirmed: false,
      };
    }
    const span = ch.open;
    const P = span.period;
    const u = (((at - span.start) % span.shown) + span.shown) % span.shown / (span.shown / P); // prettier-ignore
    const point = { cell: value.cell ?? null, volts: value.volts ?? null };
    if (!fits(template, u, P, SAME_U * P + 1e-15, point, tolerance)) {
      // It stopped being the cycle's picture (a counter on the island moves
      // at its own pace): what was drawn up to here stands, and the picture
      // is looked at again from the next shown cycle.
      this.#close(ch);
      const n = Math.floor((at - cycle.start) / cycle.shown) + 1;
      ch.wait = { id: cycle.id, at: cycle.start + n * cycle.shown };
      return;
    }
    span.to = at;
    if (at - span.from >= span.shown - 1e-12) span.confirmed = true;
  }

  /** End a channel's open stretch where its last fitting column was. */
  #close(ch) {
    if (ch.open?.confirmed) ch.spans.push(ch.open);
    ch.open = null;
  }

  /**
   * A channel's confirmed stretches, oldest first — the open one included
   * once confirmed (a whole shown cycle has fitted). Each `{id, start,
   * period, shown, from, to, template}`.
   * @param {string} id
   * @returns {object[]}
   */
  spansOf(id) {
    const ch = this.#channels.get(id);
    if (!ch) return [];
    return ch.open?.confirmed ? [...ch.spans, ch.open] : ch.spans;
  }

  /** Forget the stretches that ended before `at` (the recording's first
      column now). */
  evictBefore(at) {
    for (const ch of this.#channels.values()) {
      while (ch.spans.length && ch.spans[0].to < at) ch.spans.shift();
    }
  }
}

/** The stretch of `spans` holding moment `at`, or null. */
export function spanAt(spans, at) {
  for (const s of spans) if (at >= s.from && at <= s.to) return s;
  return null;
}
