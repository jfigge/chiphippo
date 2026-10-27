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

// meter-average.js — what each multimeter reads over its update window: the
// voltage across its probes, averaged over the simulated time the window
// covers. Pure and DOM-free; SimController records every tick (and the
// curves between ticks, spice/sample.js) and takes the window each time the
// meter's display updates.
//
// A DMM does not show the instant: a 50 % PWM on a DC range reads half its
// swing, and a sine on an AC range its RMS — the eye could not read a
// display that changed with every edge anyway. So the window keeps the
// integral of v and of v² along the samples (each stretch between two of
// them a straight line — the curves are sampled until their chords are
// within a tolerance), and its extremes: DC is the mean, AC the true RMS
// with the mean taken out (AC-coupled — an assumption: the manual does not
// say), and AutoV picks between them by the larger peak.
//
// After a window's last sample the last value is HELD up to the moment the
// window is taken: a desk at rest records nothing between ticks.
//
// The Hz function counts along the same samples: each trigger band
// (catalog/meter.js `hzBands`) is a Schmitt trigger round the last window's
// mean — AC-coupled, so a logic level's swing triggers it wherever it sits —
// and a window says the frequency of the rising crossings over the last
// `HZ_GATE_S`, each crossing timed where the stretch reaching it crosses.
//
// Once a band has locked on a frequency, DC is the mean over WHOLE periods
// — rising crossing to rising crossing, the integral booked at each — inside
// the window (or the last one before it, where the window holds less than
// one): a window's ragged ends left part of a cycle in a sine's mean, and a
// 12 V~ read ±0.37 V DC by turns.

import { HZ_GATE_S, HZ_MIN } from "../catalog/meter.js";

/** A template's straight pieces, `[u0, u1, v0, v1]` — a point not on a
    curve is a step to it, held to the next (spice/sample.js
    `cycleTemplates`). */
function piecesOf(pts) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!(b.u > a.u)) continue;
    out.push([a.u, b.u, a.volts ?? 0, b.curve ? (b.volts ?? 0) : (a.volts ?? 0)]); // prettier-ignore
  }
  return out;
}

/** A piecewise line's value at `u`, from the right (`left` false) or the
    left of a step there. */
function valueOn(pieces, u, left) {
  for (const [u0, u1, v0, v1] of pieces) {
    if (left ? u > u0 && u <= u1 : u >= u0 && u < u1) {
      return v0 + ((v1 - v0) * (u - u0)) / (u1 - u0);
    }
  }
  const last = pieces.at(-1);
  return last ? last[3] : 0;
}

/**
 * A meter's figures over one TRUE cycle of an island Spice Lite draws
 * slowed (spice/cycles.js — past TIMING_CAP_HZ, drawn at the cap with its
 * duty kept): what its window would read of the real wave, which repeats
 * exactly — its mean, AC RMS, extremes, and on each Hz trigger band the
 * rising crossings a period over the period. Off the cycle's templates
 * (spice/sample.js `cycleTemplates`) of the probes' two nets — or a net's
 * steady voltage where it has none.
 * @param {object} opts
 * @param {Array|null} opts.pos - the red probe's net's template, or null
 * @param {Array|null} opts.neg - the black probe's, or null
 * @param {number} [opts.posV] - the red net's voltage without a template
 * @param {number} [opts.negV] - the black net's
 * @param {number} opts.period - the true period, seconds
 * @param {number[]} [opts.bands] - the Hz trigger bands (half-widths, V)
 * @returns {{mean: number, rms: number, min: number, max: number,
 *   last: number, span: number, hz: number[]}}
 */
export function cycleWindow({
  pos,
  neg,
  posV = 0,
  negV = 0,
  period,
  bands = [],
}) {
  // prettier-ignore
  const P = pos ? piecesOf(pos) : null;
  const N = neg ? piecesOf(neg) : null;
  const at = (u, left) => (P ? valueOn(P, u, left) : posV) - (N ? valueOn(N, u, left) : negV); // prettier-ignore
  const grid = new Set([0, period]);
  for (const list of [P, N]) for (const [u0, u1] of list ?? []) grid.add(u0).add(u1); // prettier-ignore
  const us = [...grid].filter((u) => u >= 0 && u <= period).sort((a, b) => a - b); // prettier-ignore
  let sum = 0;
  let sum2 = 0;
  let min = Infinity;
  let max = -Infinity;
  const path = []; // [v at the start, v at the end] of each stretch
  for (let k = 0; k + 1 < us.length; k++) {
    const a = at(us[k], false);
    const b = at(us[k + 1], true);
    const dt = us[k + 1] - us[k];
    sum += ((a + b) / 2) * dt;
    sum2 += ((a * a + a * b + b * b) / 3) * dt;
    min = Math.min(min, a, b);
    max = Math.max(max, a, b);
    path.push([a, b]);
  }
  const mean = period > 0 ? sum / period : at(0, false);
  const rms = period > 0 ? Math.sqrt(Math.max(0, sum2 / period - mean * mean)) : 0; // prettier-ignore
  // Each band's rises a period: its trigger run round twice, the second
  // time counted (the first settles which side it starts on).
  const hz = bands.map((band) => {
    let state = 0;
    let rises = 0;
    for (let round = 0; round < 2; round++) {
      for (const [a, b] of path) {
        for (const v of [a, b]) {
          if (v > mean + band && state <= 0) {
            if (state < 0 && round === 1) rises++;
            state = 1;
          } else if (v < mean - band && state >= 0) {
            state = -1;
          }
        }
      }
    }
    return period > 0 ? rises / period : 0;
  });
  return { mean, rms, min: Number.isFinite(min) ? min : mean, max: Number.isFinite(max) ? max : mean, last: at(period, true), span: period, hz }; // prettier-ignore
}

/** One meter's window. */
function blankWindow() {
  return { from: null, at: null, v: null, sum: 0, sum2: 0, min: Infinity, max: -Infinity }; // prettier-ignore
}

/** Each meter's reading, time-averaged between display updates. */
export class MeterAverage {
  #windows = new Map(); // meter id → window
  // meter id → its Hz counter: {bands, ref, sum, from, at, v, states,
  // rises, sums} — `states` per band (-1 below, +1 above, 0 not yet known),
  // `rises` per band the crossing times within the gate, `sums` the
  // integral `sum` at each.
  #hz = new Map();

  /** Forget everything (a Run, a Stop, an edit that moved what it reads). */
  reset() {
    this.#windows = new Map();
    this.#hz = new Map();
  }

  /** Forget one meter (its probes moved, its function changed). */
  forget(id) {
    this.#windows.delete(id);
    this.#hz.delete(id);
  }

  /** The Hz trigger bands a meter counts on (`bands(id)` reads them). */
  bandsOf(id) {
    return this.#hz.get(id)?.bands ?? [];
  }

  /** The Hz trigger bands a meter counts on (half-widths, volts) — none
      where its function offers no Hz. */
  bands(id, bands) {
    if (!bands?.length) {
      this.#hz.delete(id);
      return;
    }
    const kept = this.#hz.get(id);
    if (kept && kept.bands.join() === bands.join()) return;
    this.#hz.set(id, { bands: [...bands], ref: null, sum: 0, from: null, at: null, v: null, states: bands.map(() => 0), rises: bands.map(() => []), sums: bands.map(() => []) }); // prettier-ignore
  }

  /** The meters with a window open. */
  get ids() {
    return [...this.#windows.keys()];
  }

  /** The windows so far as plain data (a run handed to another thread). */
  export() {
    const hz = [...this.#hz].map(([id, h]) => [id, { ...h, bands: [...h.bands], states: [...h.states], rises: h.rises.map((r) => [...r]), sums: h.rises.map((r, i) => [...(h.sums?.[i] ?? r.map(() => 0))]) }]); // prettier-ignore
    return { windows: [...this.#windows].map(([id, w]) => [id, { ...w }]), hz }; // prettier-ignore
  }

  /** Windows exactly as `export` gave them. */
  import(data) {
    const windows = Array.isArray(data) ? data : (data?.windows ?? []);
    this.#windows = new Map(windows.map(([id, w]) => [id, { ...w }]));
    this.#hz = new Map((data?.hz ?? []).map(([id, h]) => [id, { ...h, bands: [...h.bands], states: [...h.states], rises: h.rises.map((r) => [...r]), sums: h.rises.map((r, i) => [...(h.sums?.[i] ?? r.map(() => 0))]) }])); // prettier-ignore
  }

  /** Count one sample on a meter's Hz triggers. */
  #count(id, t, v) {
    const h = this.#hz.get(id);
    if (!h) return;
    const before = h.sum; // the integral at the last sample
    if (h.at != null && h.v != null && t > h.at) h.sum += ((h.v + v) / 2) * (t - h.at); // prettier-ignore
    if (h.from == null) h.from = t;
    // Until a window has given a mean, the mean so far.
    const ref = h.ref ?? (t > h.from ? h.sum / (t - h.from) : v);
    for (let i = 0; i < h.bands.length; i++) {
      const hi = ref + h.bands[i];
      const lo = ref - h.bands[i];
      if (v > hi && h.states[i] <= 0) {
        if (h.states[i] < 0) {
          // Timed where the stretch from the last sample crosses `hi`.
          const k = h.v != null && v !== h.v && h.at != null ? (hi - h.v) / (v - h.v) : 1; // prettier-ignore
          const f = Math.min(1, Math.max(0, k));
          const at = h.at != null ? h.at + f * (t - h.at) : t;
          h.rises[i].push(at);
          // …and the integral there: the stretch's trapezoid up to it.
          const dt = h.at != null && h.v != null && t > h.at ? at - h.at : 0;
          h.sums[i].push(before + (dt > 0 ? (h.v + (h.v + f * (v - h.v))) / 2 * dt : 0)); // prettier-ignore
        }
        h.states[i] = 1;
      } else if (v < lo && h.states[i] >= 0) {
        h.states[i] = -1;
      }
    }
    h.at = t;
    h.v = v;
  }

  /** Each band's frequency at `until` (0 under `HZ_MIN`), and the gate
      moved on. */
  #frequencies(h, until) {
    return h.rises.map((rises, i) => {
      while (rises.length && rises[0] < until - HZ_GATE_S) {
        rises.shift();
        h.sums[i].shift();
      }
      if (rises.length < 2) return 0;
      const first = rises[0];
      const last = rises.at(-1);
      const hz = (rises.length - 1) / (last - first);
      // A signal that has stopped: its last crossing two periods back.
      if (!(hz >= HZ_MIN) || until - last > 2 / hz) return 0;
      return hz;
    });
  }

  /** The mean over the whole periods a locked band (the first with a
      frequency in `hz`) has rising crossings for: those from `from` on, or
      the last period where there are fewer — else null. */
  #wholeMean(h, hz, from) {
    const i = hz.findIndex((f) => f > 0);
    if (i < 0) return null;
    const rises = h.rises[i];
    const sums = h.sums[i];
    const n = rises.length - 1;
    if (n < 1) return null;
    let k = rises.findIndex((r) => r >= from);
    if (k < 0 || k >= n) k = n - 1;
    const span = rises[n] - rises[k];
    return span > 0 ? (sums[n] - sums[k]) / span : null;
  }

  /** Book the straight stretch from the last sample to (`t`, `v`). */
  #stretch(w, t, v) {
    if (w.at == null || w.v == null) return;
    const dt = t - w.at;
    if (!(dt > 0)) return;
    const a = w.v;
    w.sum += ((a + v) / 2) * dt;
    w.sum2 += ((a * a + a * v + v * v) / 3) * dt;
  }

  /**
   * A sample of one meter's voltage at `t`, simulated seconds. Two at one
   * moment (a curve's foot before a tick, the tick after) are a step.
   * @param {string} id
   * @param {number} t
   * @param {number} v
   */
  record(id, t, v) {
    if (!Number.isFinite(v) || !Number.isFinite(t)) return;
    let w = this.#windows.get(id);
    if (!w) this.#windows.set(id, (w = blankWindow()));
    if (w.from == null) w.from = t;
    if (w.at != null && t < w.at) {
      // Never back in time — a sum of floats a hair short of the last
      // moment is that moment.
      if (w.at - t > 1e-9 * Math.max(1, Math.abs(t))) return;
      t = w.at;
    }
    this.#stretch(w, t, v);
    w.at = t;
    w.v = v;
    if (v < w.min) w.min = v;
    if (v > w.max) w.max = v;
    this.#count(id, t, v);
  }

  /** Hold a meter's last voltage on to `t`: what it read between two
      samples that moved nothing. Without it the next sample — a tick's
      edge — would be joined to the last by a ramp, and a 25 % PWM read
      half its swing. */
  hold(id, t) {
    const w = this.#windows.get(id);
    if (w?.v != null) this.record(id, t, w.v);
  }

  /** The last voltage booked for a meter, or null. */
  last(id) {
    return this.#windows.get(id)?.v ?? null;
  }

  /**
   * Every window's figures up to `until`, and a new window from there, each
   * starting at the value its last ended on: id → `{mean, rms, min, max,
   * last, span, hz}` (volts; `rms` the AC part; `hz` each trigger band's
   * frequency, [] with none). A window covering no time is its last value,
   * steady.
   * @param {number} until - seconds
   * @returns {Map<string, {mean: number, rms: number, min: number,
   *   max: number, last: number, span: number, hz: number[]}>}
   */
  take(until) {
    const out = new Map();
    for (const [id, w] of this.#windows) {
      if (w.v == null) continue;
      const end = Math.max(until, w.at);
      this.#stretch(w, end, w.v);
      const span = end - w.from;
      let mean = w.v;
      let rms = 0;
      if (span > 0) {
        mean = w.sum / span;
        rms = Math.sqrt(Math.max(0, w.sum2 / span - mean * mean));
      }
      const h = this.#hz.get(id);
      const hz = h ? this.#frequencies(h, end) : [];
      if (h && span > 0) h.ref = mean;
      // A periodic signal's DC: over whole periods (the trigger's reference
      // stays the window's own mean, which the crossings are timed round).
      const whole = h ? this.#wholeMean(h, hz, w.from) : null;
      if (whole != null) mean = whole;
      out.set(id, { mean, rms, min: Math.min(w.min, w.v), max: Math.max(w.max, w.v), last: w.v, span, hz }); // prettier-ignore
      this.#windows.set(id, { from: end, at: end, v: w.v, sum: 0, sum2: 0, min: w.v, max: w.v }); // prettier-ignore
    }
    return out;
  }
}
