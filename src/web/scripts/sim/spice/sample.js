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

// spice/sample.js — what Spice Lite's carried analog state says BETWEEN two
// ticks (features/01-display-wakes.md). Pure and DOM-free: no settle, no
// solve, nothing mutated.
//
// Between two events nothing on the desk changes but the curves the analog
// side runs along: every RC node's (one closed-form curve, or its dynamic
// group's modes — spice/dynamics.js), every inductor's current, a running
// wave's piece, a drawn cycle's schedule (spice/cycles.js). Each is exact
// until its next corner or crossing, and each of those is a tick of its own
// (the engine's `wakeAt`). So a view that wants the desk at some moment
// between ticks reads the curves there — `sampleAnalog` — with the very
// evaluators the engine itself reads them with, rather than asking the
// engine to tick for nothing but a redraw.
//
// `nextDisplayFrame` is the cadence a moving desk is REDRAWN at: the frames
// the engine used to wake for (a node still on its way every ANALOG_FRAME_S,
// a running wave WAVE_FRAMES times a period while the analyzer records it, a
// coil still moving). They are no wakes any more — nothing electrical happens
// at one — but the views still want a picture that often, and the analyzer
// still wants a column that often (components/sim-controller.js samples them).

import { ARRIVED_STEP_A, finalValue, hasArrived, valueAt } from "./rc-curve.js";
import { awayAmps } from "./inductors.js";
import { scheduleAt } from "./cycles.js";

/** An inductor's current among a statement's terms (spice/voltages.js
    `affine`: `coil:<id>`). */
const COIL_TERM = "coil:";

/** How often a node still on its way is redrawn, simulated seconds. */
export const ANALOG_FRAME_S = 1 / 30;

/** A running wave is redrawn this many times a period (so the analyzer draws
    its shape), never more often than WAVE_FRAME_MIN_S nor less than
    ANALOG_FRAME_S. */
export const WAVE_FRAMES = 16;
export const WAVE_FRAME_MIN_S = 2e-3;

/** While nothing records it, a running wave is redrawn an ODD number of
    sixteenths of its period apart, at least this far (`walkingFrame`). */
export const WALK_FRAME_MIN_S = 4e-3;

/**
 * An unrecorded running wave's frame, seconds: an odd number of sixteenths
 * of its `period`, so frame by frame the moments it is read at walk every
 * sixteenth of it — at least WALK_FRAME_MIN_S, at most ANALOG_FRAME_S. A
 * wave is read only at its frames (an LED on it lit, heated and judged by
 * the moment a tick lands on), and redrawn every ANALOG_FRAME_S — two
 * periods of 60 Hz, three of 50 Hz with a third left over — an LED on a
 * 60 Hz adapter was read at the zero crossing every frame: dark, cool, no
 * warning; at 50 Hz three phases stood for its glow (the regrade,
 * 2026-10-23). A frame's lamps average the ticks it covers (sim/
 * lamp-average.js): five or six here, spread over the period.
 * @param {number} period
 * @returns {number}
 */
export function walkingFrame(period) {
  if (!(period > 0)) return ANALOG_FRAME_S;
  const step = period / WAVE_FRAMES;
  let n = Math.max(1, Math.ceil(WALK_FRAME_MIN_S / step - 1e-9));
  if (n % 2 === 0) n++;
  return Math.min(ANALOG_FRAME_S, n * step);
}

/**
 * The analog side at `t` (simulated seconds, at or after the tick that
 * returned `analog` and before the next one): every RC node's voltage
 * (`volts`, net → V) and every inductor's current (`coils`, id → A). Each
 * drawn cycle's island stands where its schedule has it at `t`, as the engine
 * stands it there (`applySeg`); everything else on its curve.
 *
 * With `arrived` (the gap setting, percent), a node or coil the gap setting
 * says has arrived reads where it comes to rest (`finalValue`): a desk at
 * rest is redrawn no more (`nextDisplayFrame`), so its last frame is what
 * the views keep showing — read on its curve, 1 % short for good (1 kΩ
 * charging 1000 µF from 5 V stood at 4.95 V from 4.6 s on).
 * @param {object|null} analog - a Spice Lite result's `analog`
 * @param {number} t
 * @param {{arrived?: number|null}} [opts]
 * @returns {{volts: Map<string, number>, coils: Map<string, number>}}
 */
export function sampleAnalog(analog, t, { arrived = null } = {}) {
  const volts = new Map();
  const coils = new Map();
  if (!analog) return { volts, coils };
  // Each island drawn by its schedule (spice/islands.js) stands where it has
  // it; every other node on its curve.
  for (const { cycle } of analog.cycles?.values() ?? []) {
    const p = scheduleAt(cycle, t);
    for (const [net, node] of p.seg.nodes) {
      volts.set(net, node.driven ?? valueAt(node.curve, p.at));
    }
  }
  const at = (curve, floor) => {
    if (arrived == null || !hasArrived(curve, t, arrived, floor)) return valueAt(curve, t); // prettier-ignore
    return finalValue(curve) ?? valueAt(curve, t);
  };
  for (const [net, node] of analog.nodes ?? []) {
    if (!volts.has(net)) volts.set(net, node.driven ?? at(node.curve));
  }
  for (const [id, curve] of analog.coils ?? []) coils.set(id, at(curve, ARRIVED_STEP_A)); // prettier-ignore
  for (const [id, away] of analog.coilsAway ?? []) coils.set(id, awayAmps(away, t)); // prettier-ignore
  // A net that is no node — what the analyzer reads of an adapter's S1, an
  // op-amp's output — as the nodes make it (spice/engine.js `statements`):
  // read at the frame, not held at the last tick's value.
  for (const [net, st] of analog.statements ?? []) {
    if (volts.has(net)) continue;
    let v = st.c0;
    for (const [key, coef] of st.terms) {
      const x = key.startsWith(COIL_TERM) ? coils.get(key.slice(COIL_TERM.length)) : volts.get(key); // prettier-ignore
      if (x == null) {
        v = null;
        break;
      }
      v += coef * x;
    }
    if (v != null) volts.set(net, v);
  }
  return { volts, coils };
}

/**
 * When a desk whose last tick ran at `target` (its curves read at `t`, the
 * moment that tick's settles left it at) next wants REDRAWING, or null when
 * nothing on it moves: a node still on its way — listened to or not — until
 * the gap setting says it has arrived; a running wave, `WAVE_FRAMES` times a
 * period while the analyzer records (`waveFrames`), else walking its phases
 * (`walkingFrame`); a
 * coil still moving. Never while the circuit is stuck chattering (its
 * back-off is the only thing that may wake it).
 * @param {{nodes: Map, coils?: Map, waves?: Map, chatter?: object|null,
 *   inputs?: {clockTimes?: Map}}} analog - `waves`: wave net → clock id
 * @param {number} target
 * @param {number} t
 * @param {{gapPercent: number, waveFrames?: boolean}} opts
 * @returns {number|null}
 */
export function nextDisplayFrame(
  analog,
  target,
  t,
  { gapPercent, waveFrames = true },
) {
  if (!analog || analog.chatter) return null;
  let at = null;
  const later = (x) => {
    at = at == null ? x : Math.min(at, x);
  };
  const nodes = analog.nodes ?? new Map();
  for (const node of nodes.values()) {
    if (node.driven == null && !hasArrived(node.curve, t, gapPercent)) {
      later(target + ANALOG_FRAME_S);
      break;
    }
  }
  // A running wave never arrives: it is drawn often enough to show its shape
  // only while the analyzer records it, and else at moments that walk it.
  for (const [net, id] of analog.waves ?? []) {
    if (nodes.get(net)?.driven != null) continue;
    // An AC supply's period is its own frequency's; a clock's, its square's.
    const kind = analog.waveKinds?.get(net);
    const period = kind?.ac
      ? 1 / kind.hz
      : 2 * (analog.inputs?.clockTimes?.get(id)?.half ?? 0);
    if (!waveFrames) {
      // On a lattice of its own from the run's start: a wake between two
      // (a corner of what it drives, once a period) must not pull the
      // next one back into step with the wave.
      const frame = walkingFrame(period);
      later((Math.floor(target / frame + 1e-6) + 1) * frame);
      continue;
    }
    const frame = Math.min(ANALOG_FRAME_S, Math.max(WAVE_FRAME_MIN_S, period / WAVE_FRAMES)); // prettier-ignore
    later(target + frame);
  }
  for (const curve of analog.coils?.values() ?? []) {
    if (!hasArrived(curve, t, gapPercent, ARRIVED_STEP_A)) {
      later(target + ANALOG_FRAME_S);
      break;
    }
  }
  return at;
}

/** What a curve sample may stray from the straight line the analyzer draws
    between two, as a share of its lanes' full scale — under a pixel of a
    lane. */
export const SCOPE_TOLERANCE = 0.002;

/** The closest two curve samples come, simulated seconds: a jump between
    two ticks (a drawn cycle's segment) is pinned down no finer. */
export const SCOPE_MIN_STEP_S = 1e-7;

/** The most curve samples one stretch between two ticks is read at. */
export const SCOPE_MAX_SAMPLES = 2048;

/**
 * The longest stretch a stretch's first look may span without a chord
 * hiding what the curves do inside it: an eighth of every oscillation on the
 * desk — a running wave's period, a ringing group's, a drawn cycle's shown
 * one. A curve that does not oscillate needs no guard (bisection finds its
 * bend), so Infinity when nothing does.
 * @param {object} analog
 * @returns {number}
 */
function guardStep(analog) {
  let period = Number.POSITIVE_INFINITY;
  const take = (p) => {
    if (p > 0 && p < period) period = p;
  };
  for (const [net, id] of analog.waves ?? []) {
    const kind = analog.waveKinds?.get(net);
    take(kind?.ac ? 1 / kind.hz : 2 * (analog.inputs?.clockTimes?.get(id)?.half ?? 0)); // prettier-ignore
  }
  for (const node of analog.nodes?.values() ?? []) {
    const osc = node.curve?.scale?.oscs ?? node.curve?.scale?.osc;
    for (const w of Array.isArray(osc) ? osc : [osc]) if (w > 0) take((2 * Math.PI) / w); // prettier-ignore
  }
  for (const { cycle } of analog.cycles?.values() ?? []) take(cycle?.shown);
  return period / 8;
}

/**
 * The analyzer's samples of `nets` between two ticks (Spice Lite; the
 * logic analyzer's voltage lanes): the carried curves read at moments in
 * (`from`, `to`], as finely as they BEND — each stretch split until the
 * curve at its quarter and three-quarter points and its middle lies within
 * `tolerance` volts of the chord the analyzer draws, so the chords are the
 * curve to under a pixel: a 1 ms RC charging after a clock edge is a score
 * of samples over its 5 ms, a sine some 32 a period, a node at rest none.
 * `to` itself is always a sample unless nothing moved past `tolerance` from
 * `from` at all (a desk at rest adds no columns). Read with the engine's own
 * evaluators (`sampleAnalog`), exact up to the next wake, so `to` must not
 * be past it. Each sample is `{at, volts}` (net → V, the nets that read
 * one).
 * @param {object|null} analog - the last tick's `analog`
 * @param {Iterable<string>} nets
 * @param {number} from
 * @param {number} to
 * @param {{tolerance: number, minStep?: number, maxSamples?: number}} opts
 * @returns {Array<{at: number, volts: Map<string, number>}>}
 */
export function scopeSamples(
  analog,
  nets,
  from,
  to,
  { tolerance, minStep = SCOPE_MIN_STEP_S, maxSamples = SCOPE_MAX_SAMPLES },
) {
  if (!analog || analog.chatter || !(to > from)) return [];
  const list = [...nets];
  const read = (t) => {
    const { volts } = sampleAnalog(analog, t);
    const out = new Map();
    for (const net of list) {
      const v = volts.get(net);
      if (Number.isFinite(v)) out.set(net, v);
    }
    return out;
  };
  // Whether `vm` (at fraction f of the way from a to b) strays from the chord.
  const strays = (va, vm, vb, f) => {
    for (const [net, v] of vm) {
      const a = va.get(net);
      const b = vb.get(net);
      if (a == null || b == null) continue;
      if (Math.abs(v - (a + (b - a) * f)) > tolerance) return true;
    }
    return false;
  };
  const out = [];
  const refine = (a, va, b, vb) => {
    if (out.length >= maxSamples || b - a <= 2 * minStep) return;
    const m = (a + b) / 2;
    const vm = read(m);
    const bent =
      strays(va, vm, vb, 0.5) ||
      strays(va, read(a + (b - a) / 4), vb, 0.25) ||
      strays(va, read(a + (3 * (b - a)) / 4), vb, 0.75);
    if (!bent) return;
    refine(a, va, m, vm);
    if (out.length < maxSamples) out.push({ at: m, volts: vm });
    refine(m, vm, b, vb);
  };
  const v0 = read(from);
  if (!v0.size) return [];
  const span = to - from;
  const pieces = Math.min(maxSamples >> 2, Math.max(1, Math.ceil(span / guardStep(analog) - 1e-9))); // prettier-ignore
  let a = from;
  let va = v0;
  for (let i = 1; i <= pieces; i++) {
    const b = i === pieces ? to : from + (span * i) / pieces;
    const vb = read(b);
    refine(a, va, b, vb);
    if (out.length >= maxSamples) break;
    out.push({ at: b, volts: vb });
    a = b;
    va = vb;
  }
  // Nothing bent and nothing moved: the stretch adds nothing.
  if (out.length === pieces && !out.some((s) => strays(v0, s.volts, v0, 0))) return []; // prettier-ignore
  return out;
}

/**
 * One TRUE cycle of a cycle Spice Lite draws slowed (spice/cycles.js), as
 * the analyzer draws it repeated at its true period (model/scope-periodic.js
 * — on the desk it is shown at the cap): for each of `nets` its points over
 * the cycle, `{u, cell, volts, curve}`, `u` true seconds into it. A node is
 * its segment's own curve, read as finely as it bends (the chords within
 * `tolerance`); any other net stands at what its segment's moment recorded
 * (the engine's `probe` — spice/engine.js `probeOf`), stepping at each
 * segment's start. A segment's first point is a STEP (`curve` false), its
 * curve's points joined; the last point is at `u` = the period. A net the
 * moments did not record has no template.
 * @param {object} cycle - a drawn island's `cycle` (`analog.cycles`)
 * @param {Iterable<string>} nets
 * @param {{tolerance: number, minStep?: number}} opts
 * @returns {Map<string, Array<{u: number, cell: *, volts: number|null,
 *   curve: boolean}>>}
 */
export function cycleTemplates(
  cycle,
  nets,
  { tolerance, minStep = SCOPE_MIN_STEP_S },
) {
  const out = new Map();
  const segs = cycle.segs ?? [];
  if (!segs.length || !(cycle.period > 0)) return out;
  for (const net of nets) {
    const pts = [];
    let ok = true;
    for (let i = 0; i < segs.length && ok; i++) {
      const seg = segs[i];
      const u0 = seg.at;
      const u1 = i + 1 < segs.length ? segs[i + 1].at : cycle.period;
      const probe = seg.probe?.get(net);
      const node = seg.nodes?.get(net);
      const cell = probe?.level ?? null;
      if (!node) {
        if (!probe) ok = false;
        else pts.push({ u: u0, cell, volts: probe.volts ?? null, curve: false }); // prettier-ignore
        continue;
      }
      const v = (u) => node.driven ?? valueAt(node.curve, seg.t + (u - u0));
      pts.push({ u: u0, cell, volts: v(u0), curve: false });
      if (node.driven != null || !(u1 > u0)) continue;
      // Bisected where the chord strays, as the curve samples are.
      const refine = (a, va, b, vb) => {
        if (b - a <= 2 * minStep || pts.length > SCOPE_MAX_SAMPLES) return;
        const m = (a + b) / 2;
        const vm = v(m);
        const bent = [0.25, 0.5, 0.75].some((f) => {
          const x = f === 0.5 ? vm : v(a + (b - a) * f);
          return Math.abs(x - (va + (vb - va) * f)) > tolerance;
        });
        if (!bent) return;
        refine(a, va, m, vm);
        pts.push({ u: m, cell, volts: vm, curve: true });
        refine(m, vm, b, vb);
      };
      const end = v(u1);
      refine(u0, v(u0), u1, end);
      pts.push({ u: u1, cell, volts: end, curve: true });
    }
    if (ok && pts.length) out.set(net, pts);
  }
  return out;
}
