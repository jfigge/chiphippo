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

// spice/cycles.js — an oscillation faster than the desk can show, recognised
// and handed to a schedule (features/done/spice-lite-2-plan.md §6). Pure and
// DOM-free.
//
// Between two crossings nothing on the desk's analog side changes but the
// curves it runs along, so the moment after each crossing says everything
// about what comes next: every node's voltage and curve, every listener's
// reading, and what the outputs on the nodes' networks drive (a SIGNATURE).
// When the signature after a crossing is one already seen this tick, the
// analog side has come round: everything from that moment to this one is a
// CYCLE, and it will repeat for as long as nothing outside it changes. A
// cycle shorter than TIMING_CAP_HZ's period is then no longer run crossing by
// crossing — it is DRAWN at the cap, every stretch of it slowed alike (its
// duty kept), as sim/timing.js `capSchedule` draws a timed part's: each
// listener reads, and each node stands at, what the cycle says for the
// moment the shown wave has reached. Time itself is not slowed: in `t`
// seconds `t / period` true cycles pass, and a part counting the oscillation
// is told so (`trueCycles` — a 4060's slow stages keep their true count).
//
// The whole analog side is the cycle: a desk with a second, unrelated
// oscillation never repeats as a whole, and runs crossing by crossing as
// before (to the event cap and its `oscillation` warning). A schedule holds
// only while each moment it shows still DRIVES what it recorded — a reset
// raised, a supply moved, a value edited (a new document) ends it, and the
// nodes run on from where the schedule stood.

/** How close two signatures' voltages must be to be one, as a fraction of
    the desk's highest supply. */
const SAME_VOLTS = 1e-6;

/** How close two time constants or rates must be to be one, relatively. */
const SAME_REL = 1e-6;

/** The most moments one tick remembers while looking for a cycle. */
export const MAX_TIMELINE = 96;

const near = (a, b, tol) =>
  a === b || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol); // prettier-ignore
const nearRel = (a, b) =>
  a === b || Math.abs(a - b) <= SAME_REL * Math.max(Math.abs(a), Math.abs(b));

/**
 * The analog side's signature at a moment: `nodes` (net → `{driven, curve}`)
 * with `voltsAt(node)` their voltages now, `listen` (key → bool) and `drive`
 * (what the outputs on the nodes' networks drive, and the voltages read from
 * outside them — `sameDrive`).
 */
export function signatureOf(nodes, voltsAt, listen, drive) {
  const node = [];
  for (const net of [...nodes.keys()].sort()) {
    const n = nodes.get(net);
    node.push(
      n.driven != null
        ? { net, driven: n.driven }
        : { net, v: voltsAt(n), vInf: n.curve.vInf, tau: n.curve.tau, rate: n.curve.rate ?? 0 }, // prettier-ignore
    );
  }
  const reads = [...listen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v ? 1 : 0}`).join(","); // prettier-ignore
  return { node, reads, drive };
}

/**
 * Whether two moments drive alike (spice/engine.js's drive signature: `key`,
 * the levels and statuses, exactly; `volts`, the nets read from outside the
 * nodes' networks, each within SAME_VOLTS of the desk's highest supply — a
 * solve's last digits are no change).
 */
export function sameDrive(a, b, vHigh) {
  if (a.key !== b.key || a.volts.length !== b.volts.length) return false;
  const tol = SAME_VOLTS * Math.max(1, vHigh);
  for (let i = 0; i < a.volts.length; i++) {
    const [na, va] = a.volts[i];
    const [nb, vb] = b.volts[i];
    if (na !== nb || (va == null) !== (vb == null)) return false;
    if (va != null && !near(va, vb, tol)) return false;
  }
  return true;
}

/** Whether two signatures are one moment of a cycle. */
export function sameSignature(a, b, vHigh) {
  if (a.reads !== b.reads || !sameDrive(a.drive, b.drive, vHigh)) return false;
  if (a.node.length !== b.node.length) return false;
  const tol = SAME_VOLTS * Math.max(1, vHigh);
  for (let i = 0; i < a.node.length; i++) {
    const x = a.node[i];
    const y = b.node[i];
    if (x.net !== y.net) return false;
    if ((x.driven != null) !== (y.driven != null)) return false;
    if (x.driven != null) {
      if (!near(x.driven, y.driven, tol)) return false;
      continue;
    }
    if (!near(x.v, y.v, tol) || !near(x.vInf, y.vInf, tol)) return false;
    if (!nearRel(x.tau, y.tau) || !nearRel(x.rate, y.rate)) return false;
  }
  return true;
}

/** The least a cycle must swing one of its nodes, as a fraction of the
    desk's highest supply. A loop that turns straight back at a single trip
    point (an RC round an ordinary inverter) chatters a hair either side of
    it, a gate delay at a time: that is no oscillation to draw but the logic
    loop it is, which the event cap reports. */
const MIN_SWING = 0.01;

/**
 * Look for a cycle ending at the timeline's last moment (`timeline`: `{t,
 * crossing, sig, …}`, in order — `crossing` true for a moment just after a
 * settle, false for a corner). Returns the index it began at, or -1: an
 * earlier settled moment with the same signature, no further back than one
 * period of the cap, with some reading changed in between (two settles of
 * one crossing are one moment, not a cycle) and some node swung.
 * @param {object[]} timeline
 * @param {number} capHz
 * @param {number} vHigh
 */
export function cycleStart(timeline, capHz, vHigh) {
  const k = timeline.length - 1;
  const last = timeline[k];
  if (!last?.crossing) return -1;
  let changed = false;
  for (let j = k - 1; j >= 0; j--) {
    const e = timeline[j];
    if (last.t - e.t >= 1 / capHz) return -1;
    if (e.sig.reads !== last.sig.reads) changed = true;
    if (!changed || !e.crossing || !(last.t - e.t > 0)) continue;
    if (!sameSignature(e.sig, last.sig, vHigh)) continue;
    return swings(timeline, j, k, vHigh) ? j : -1;
  }
  return -1;
}

/** Whether some node swings by MIN_SWING over moments `j`…`k`. */
function swings(timeline, j, k, vHigh) {
  const lo = new Map();
  const hi = new Map();
  for (let i = j; i <= k; i++) {
    for (const n of timeline[i].sig.node) {
      const v = n.driven ?? n.v;
      lo.set(n.net, Math.min(lo.get(n.net) ?? v, v));
      hi.set(n.net, Math.max(hi.get(n.net) ?? v, v));
    }
  }
  for (const [net, v] of hi) {
    if (v - lo.get(net) >= MIN_SWING * Math.max(1, vHigh)) return true;
  }
  return false;
}

/**
 * The schedule a cycle is drawn by: the timeline's moments `j` up to (not
 * including) `k`, beginning again at `start` (shown seconds). Its `period` is
 * the cycle's true one; `shown` the cap's; `scale` how many true cycles one
 * shown cycle stands for; each segment `{at, t, …moment}` — `at` true
 * seconds into the cycle, `t` when it was recorded (its curves' clock).
 */
export function scheduleOf(timeline, j, k, start, capHz) {
  const t0 = timeline[j].t;
  const period = timeline[k].t - t0;
  const shown = 1 / capHz;
  return {
    id: start,
    start,
    period,
    shown,
    scale: shown / period,
    segs: timeline.slice(j, k).map((e) => ({ ...e, at: e.t - t0 })),
  };
}

/** A shown moment this close to a segment's start has reached it, seconds. */
const REACHED_S = 1e-12;

/**
 * Where a schedule stands at shown time `t`: its segment (`seg`), counted
 * from the schedule's start (`abs` — the segments of every shown cycle so
 * far, in order), the true moment its curves are read at (`at` — the
 * segment's recorded clock plus how far into it the shown wave is), and when
 * the shown wave next reaches a segment's start (`next`).
 */
export function scheduleAt(cycle, t) {
  const n = cycle.segs.length;
  const done = Math.max(0, Math.floor((t - cycle.start + REACHED_S) / cycle.shown)); // prettier-ignore
  const base = cycle.start + done * cycle.shown;
  const u = Math.max(0, t - base) / cycle.scale; // true seconds into the cycle
  let index = 0;
  for (let i = 1; i < n; i++) {
    if (cycle.segs[i].at * cycle.scale <= t - base + REACHED_S) index = i;
  }
  const seg = cycle.segs[index];
  return {
    seg,
    abs: done * n + index,
    at: seg.t + Math.max(0, u - seg.at),
    next: segmentAt(cycle, done * n + index + 1).time,
  };
}

/** The `abs`-th segment of a schedule (scheduleAt's count) and the shown
    moment it begins. */
export function segmentAt(cycle, abs) {
  const n = cycle.segs.length;
  const seg = cycle.segs[abs % n];
  return {
    seg,
    time:
      cycle.start + Math.floor(abs / n) * cycle.shown + seg.at * cycle.scale,
  };
}

/** How many true cycles have passed by shown time `t` since a schedule
    began — time is not slowed, only the drawing. */
export const trueCycles = (cycle, t) => Math.max(0, (t - cycle.start) / cycle.period); // prettier-ignore
