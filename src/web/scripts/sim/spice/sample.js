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

import { ARRIVED_STEP_A, hasArrived, valueAt } from "./rc-curve.js";
import { awayAmps } from "./inductors.js";
import { scheduleAt } from "./cycles.js";

/** How often a node still on its way is redrawn, simulated seconds. */
export const ANALOG_FRAME_S = 1 / 30;

/** A running wave is redrawn this many times a period (so the analyzer draws
    its shape), never more often than WAVE_FRAME_MIN_S nor less than
    ANALOG_FRAME_S. */
export const WAVE_FRAMES = 16;
export const WAVE_FRAME_MIN_S = 2e-3;

/**
 * The analog side at `t` (simulated seconds, at or after the tick that
 * returned `analog` and before the next one): every RC node's voltage
 * (`volts`, net → V) and every inductor's current (`coils`, id → A). Each
 * drawn cycle's island stands where its schedule has it at `t`, as the engine
 * stands it there (`applySeg`); everything else on its curve.
 * @param {object|null} analog - a Spice Lite result's `analog`
 * @param {number} t
 * @returns {{volts: Map<string, number>, coils: Map<string, number>}}
 */
export function sampleAnalog(analog, t) {
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
  for (const [net, node] of analog.nodes ?? []) {
    if (!volts.has(net)) volts.set(net, node.driven ?? valueAt(node.curve, t));
  }
  for (const [id, curve] of analog.coils ?? []) coils.set(id, valueAt(curve, t)); // prettier-ignore
  for (const [id, away] of analog.coilsAway ?? []) coils.set(id, awayAmps(away, t)); // prettier-ignore
  return { volts, coils };
}

/**
 * When a desk whose last tick ran at `target` (its curves read at `t`, the
 * moment that tick's settles left it at) next wants REDRAWING, or null when
 * nothing on it moves: a node still on its way — listened to or not — until
 * the gap setting says it has arrived; a running wave, `WAVE_FRAMES` times a
 * period while the analyzer records (`waveFrames`), else like any node; a
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
  // only while the analyzer records it.
  for (const [net, id] of analog.waves ?? []) {
    if (nodes.get(net)?.driven != null) continue;
    const period = 2 * (analog.inputs?.clockTimes?.get(id)?.half ?? 0);
    const frame = waveFrames
      ? Math.min(ANALOG_FRAME_S, Math.max(WAVE_FRAME_MIN_S, period / WAVE_FRAMES)) // prettier-ignore
      : ANALOG_FRAME_S;
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
