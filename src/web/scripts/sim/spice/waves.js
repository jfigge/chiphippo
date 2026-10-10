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

// spice/waves.js — a clock brick's WAVE under Spice Lite: a triangle, a
// trapezoid, a sawtooth either way, or a sine, from 0 V to the clock's
// supply. Pure and DOM-free. (A square and a PWM are LEVELS — the clock's
// edges themselves, catalog/parts.js `LEVEL_WAVES` — and never come here.)
//
// The clock keeps its square: SimController still flips its level every half
// period, and the digital engine still drives that level. What a wave adds is
// where the voltage is BETWEEN two edges — the LOW half is the first half of a
// cycle, the HIGH half the second, and the time since the last edge says how
// far into it the wave is (`cyclePhase`). So Step, a clock's own pause, a
// rate change and a skipped edge mean for a wave what they mean for its
// square, with no second clock to keep in step.
//
// A wave moves between events, so spice/engine.js runs it as a STATE of the
// linear systems its network's capacitors already are (spice/dynamics.js,
// `runGroup`): a straight piece (triangle, sawtooth) is one state rising at
// its slope, v' = slope; a sine is two in quadrature, v' = ω·u, u' = −ω·(v −
// mid), whose modes are ±iω — so a filter fed a sine is solved exactly, never
// stepped, and an input crossing a threshold on it is timed off the curve.
// Every piece ends at the next edge (`end`), where the next half's begins:
// the triangle's corners and the sine's peaks are its edges, and a sawtooth
// drops back at its HIGH → LOW edge. A trapezoid's corners are not all
// edges: each half is flat, then ramps to the edge, so its flat piece ends
// part-way through the half, at the foot of the ramp — and the engine, which
// ends a wave's piece wherever `end` says, asks again there.

import { H } from "../levels.js";

/** A trapezoid's two ramps, each this share of its period: flat at 0 V for
    the first 30 % of the cycle, up to the supply over the next 20 % — there
    at the LOW → HIGH edge, as a triangle's peak is — flat for 30 %, and back
    down over the last 20 %, at 0 V again by the HIGH → LOW edge. */
export const TRAPEZOID_RAMP = 0.2;

/** A moment this close before a trapezoid's corner (a share of its half)
    is the corner: a piece starting there is the ramp, not a flat of no
    length. */
const CORNER_EPS = 1e-9;

/**
 * Where a clock stands in its cycle at `t`, 0 to 1: its LOW half runs from 0
 * to ½, its HIGH half from ½ to 1 (the square the digital engine runs), each
 * as far in as the time since its last edge says. A clock held by its own
 * pause stands at `frac` of its half; an edge overdue (a batch that ran out of
 * time) stands at the end of the half until it comes.
 * @param {string} level - H or L, the clock's level now
 * @param {{half: number, since?: number, frac?: number}|undefined} timing
 * @param {number} t - seconds
 */
export function cyclePhase(level, timing, t) {
  return (level === H ? 0.5 : 0) + halfFraction(timing, t) / 2;
}

/** How far into its present half a clock is, 0 to 1. */
function halfFraction(timing, t) {
  if (!timing) return 0;
  if (timing.frac != null) return clamp01(timing.frac);
  if (!(timing.half > 0) || timing.since == null) return 0;
  return clamp01((t - timing.since) / timing.half);
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** A wave's voltage at cycle phase `phase` (0–1), swinging 0 to `high`. */
export function waveVolts(wave, phase, high) {
  switch (wave) {
    case "triangle":
      return high * (phase < 0.5 ? 2 * phase : 2 - 2 * phase);
    case "trapezoid": {
      const r = TRAPEZOID_RAMP;
      if (phase < 0.5 - r) return 0;
      if (phase < 0.5) return (high * (phase - (0.5 - r))) / r;
      if (phase < 1 - r) return high;
      return (high * (1 - phase)) / r;
    }
    case "ramp-up":
      return high * phase;
    case "ramp-down":
      return high * (1 - phase);
    case "sine":
      return (high / 2) * (1 - Math.cos(2 * Math.PI * phase));
    default:
      return phase < 0.5 ? 0 : high;
  }
}

/**
 * What a wave runs along from `t` until its next edge (a trapezoid's, its
 * next corner): `{value, end, running}` and how it moves — `slope` (V/s)
 * for a straight piece; for a
 * sine its quadrature `aux` (V), `omega` (rad/s) and `mid` (V), v' = ω·aux,
 * aux' = −ω·(v − mid). `period` is the clock's (seconds). A held clock, or
 * one past its half's end, stands still (`running` false, slope and omega 0).
 * @param {string} wave
 * @param {string} level - H or L
 * @param {{half: number, since?: number, frac?: number}|undefined} timing
 * @param {number} high - the clock's supply, volts
 * @param {number} t - seconds
 */
export function waveGenerator(wave, level, timing, high, t) {
  const phase = cyclePhase(level, timing, t);
  const value = waveVolts(wave, phase, high);
  const half = timing?.half ?? 0;
  const period = 2 * half;
  const end =
    timing?.frac == null && half > 0 && timing?.since != null
      ? timing.since + half
      : Number.POSITIVE_INFINITY;
  const running = Number.isFinite(end) && t < end;
  const gen = { wave, value, end: running ? end : Number.POSITIVE_INFINITY, running, period }; // prettier-ignore
  if (wave === "trapezoid" && running) {
    // Flat to the foot of the ramp, then the ramp to the edge.
    const corner = timing.since + (1 - 2 * TRAPEZOID_RAMP) * half;
    if (t < corner - CORNER_EPS * half) return { ...gen, end: corner, slope: 0 }; // prettier-ignore
    const ramp = high / (TRAPEZOID_RAMP * period);
    return { ...gen, slope: level === H ? -ramp : ramp };
  }
  if (wave === "sine") {
    const amp = high / 2;
    return {
      ...gen,
      mid: amp,
      aux: amp * Math.sin(2 * Math.PI * phase),
      omega: running ? (2 * Math.PI) / period : 0,
      slope: 0,
    };
  }
  let slope = 0;
  if (running) {
    if (wave === "triangle") slope = ((level === H ? -2 : 2) * high) / period;
    else if (wave === "ramp-up") slope = high / period;
    else if (wave === "ramp-down") slope = -high / period;
  }
  return { ...gen, slope };
}

/** Which way a wave is heading as its generator starts: +1, −1 or 0. */
export function waveHeading(gen) {
  if (!gen.running) return 0;
  return Math.sign(gen.wave === "sine" ? gen.aux : gen.slope);
}
