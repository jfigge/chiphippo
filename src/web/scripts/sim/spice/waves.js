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
// supply — or its Amplitude about its Offset, clipped at the supply's rails
// (`waveSwing`). Pure and DOM-free. (A square and a PWM are LEVELS — the clock's
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
//
// A clock powered from its supply cannot put out more than its rails, so a
// swing set past one (an Amplitude too large for its Offset) is CLIPPED
// there: the piece that would cross a rail ends where it reaches it, and the
// wave stands flat on the rail (a `"flat"` piece) until it would come back —
// a sine's crossings found on its own angle, a straight piece's on its line.

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

/**
 * Where a wave runs between, at its clock's supply: `lo` to `hi` — its
 * Amplitude (peak to peak) about its Offset (its centre), each the whole
 * supply and half of it while unset — and the rails it is clipped to,
 * `floor` 0 V and `ceil` the supply.
 * @param {{amplitude?: number, offset?: number}|null} params - the clock's
 * @param {number} supply - volts
 */
export function waveSwing(params, supply) {
  const ceil = Math.max(0, supply);
  const amp = params?.amplitude > 0 ? params.amplitude : ceil;
  const mid = params?.offset > 0 ? params.offset : ceil / 2;
  return { lo: mid - amp / 2, hi: mid + amp / 2, floor: 0, ceil };
}

/**
 * Where an AC SUPPLY's sine runs (catalog/parts.js `ac-supply`): from its
 * negative peak `trough` to its positive `peak`, about their middle — and
 * nothing clips it, since an AC supply is no instrument powered from a
 * desk's rails (its rails are ±∞). It is a quarter cycle on from a clock's
 * sine (`shift`), so it starts at its centre on its way UP — V = mid +
 * amp·sin(2πft) — and crosses its centre at each of its square's edges:
 * rising at Run and at every HIGH → LOW edge, falling at every LOW → HIGH
 * one (so its positive half is the square's LOW half).
 * @param {{peak?: number, trough?: number}|null} params - the supply's
 */
export function acSwing(params) {
  const hi = Number.isFinite(params?.peak) ? params.peak : 0;
  const lo = Number.isFinite(params?.trough) ? params.trough : 0;
  return {
    lo: Math.min(lo, hi),
    hi: Math.max(lo, hi),
    floor: Number.NEGATIVE_INFINITY,
    ceil: Number.POSITIVE_INFINITY,
    shift: 0.25,
  };
}

/** A swing as `waveSwing` states it; a bare number is the whole supply. */
const asSwing = (swing) =>
  typeof swing === "number"
    ? { lo: 0, hi: swing, floor: 0, ceil: swing }
    : swing;

/** A voltage held to a swing's rails. */
const clip = (v, s) => Math.min(s.ceil, Math.max(s.floor, v));

/** How far a swing turns its wave on, cycles (an AC supply's quarter). */
const shiftOf = (s) => (Number.isFinite(s.shift) ? s.shift : 0);

/** A wave's shape at cycle phase `phase` (0–1), from 0 to 1. */
function waveShape(wave, phase) {
  switch (wave) {
    case "triangle":
      return phase < 0.5 ? 2 * phase : 2 - 2 * phase;
    case "trapezoid": {
      const r = TRAPEZOID_RAMP;
      if (phase < 0.5 - r) return 0;
      if (phase < 0.5) return (phase - (0.5 - r)) / r;
      if (phase < 1 - r) return 1;
      return (1 - phase) / r;
    }
    case "ramp-up":
      return phase;
    case "ramp-down":
      return 1 - phase;
    case "sine":
      return (1 - Math.cos(2 * Math.PI * phase)) / 2;
    default:
      return phase < 0.5 ? 0 : 1;
  }
}

/**
 * A wave's voltage at cycle phase `phase` (0–1): from `swing.lo` to
 * `swing.hi`, clipped at its rails (`waveSwing`) — or, a number, from 0 V to
 * that.
 * @param {string} wave
 * @param {number} phase
 * @param {number|{lo: number, hi: number, floor: number, ceil: number}} swing
 */
export function waveVolts(wave, phase, swing) {
  const s = asSwing(swing);
  return clip(s.lo + (s.hi - s.lo) * waveShape(wave, phase + shiftOf(s)), s);
}

/** How near a rail counts as on it, volts. */
const RAIL_EPS = 1e-12;

/** A straight piece (`raw` at `t`, rising at `slope`) clipped at the rails:
    flat on a rail it is past (until its line comes back), else the line,
    ending where it reaches one. */
function clipLine(gen, raw, slope, s, t) {
  const tol = RAIL_EPS * Math.max(1, s.ceil);
  const past = (rail, dir) => (dir > 0 ? raw > rail - tol && (raw > rail + tol || slope > 0) : raw < rail + tol && (raw < rail - tol || slope < 0)); // prettier-ignore
  for (const [rail, dir] of [
    [s.ceil, 1],
    [s.floor, -1],
  ]) {
    // prettier-ignore
    if (!past(rail, dir)) continue;
    const back = slope * dir < 0 ? t + (rail - raw) / slope : Number.POSITIVE_INFINITY; // prettier-ignore
    return { ...gen, wave: "flat", value: rail, slope: 0, end: endBy(gen, back) }; // prettier-ignore
  }
  let reach = Number.POSITIVE_INFINITY;
  if (slope > 0) reach = t + (s.ceil - raw) / slope;
  else if (slope < 0) reach = t + (s.floor - raw) / slope;
  return { ...gen, value: raw, slope, end: endBy(gen, reach) };
}

/** A piece's end: its own, or `at` where that comes first — but never a
    hair before its own (a full swing meets its rail AT the edge, and a
    float's worth short of it is no corner). */
function endBy(gen, at) {
  const eps = 1e-9 * (gen.period > 0 ? gen.period : 1);
  return at < gen.end - eps ? at : gen.end;
}

/** The angle past `theta` (radians, increasing) at which `target` comes
    round next, as time at `omega`. */
const nextAngle = (theta, target, omega) => {
  let d = (target - theta) % (2 * Math.PI);
  if (d < 1e-12) d += 2 * Math.PI;
  return d / omega;
};

/** A sine (`mid` − `amp`·cos θ, at angle `theta`, turning at `omega`)
    clipped at the rails: flat on a rail it is past, until it comes back;
    else the sine, ending where it next reaches one. */
function clipSine(gen, mid, amp, theta, omega, s, t) {
  const raw = mid - amp * Math.cos(theta);
  const aux = amp * Math.sin(theta);
  const sine = { ...gen, value: raw, mid, aux, omega, slope: 0 };
  if (!(amp > 0) || !(omega > 0)) return { ...sine, value: clip(raw, s), omega: 0 }; // prettier-ignore
  const tol = RAIL_EPS * Math.max(1, s.ceil);
  // Above the ceiling for θ in (acos c, 2π − acos c), c = (mid − ceil)/amp;
  // below the floor for θ in (−acos f, acos f), f = (mid − floor)/amp.
  const over = mid + amp > s.ceil ? Math.acos(Math.max(-1, Math.min(1, (mid - s.ceil) / amp))) : null; // prettier-ignore
  const under = mid - amp < s.floor ? Math.acos(Math.max(-1, Math.min(1, (mid - s.floor) / amp))) : null; // prettier-ignore
  if (over != null && (raw > s.ceil + tol || (raw > s.ceil - tol && aux > 0))) {
    const back = t + nextAngle(theta, 2 * Math.PI - over, omega);
    return { ...gen, wave: "flat", value: s.ceil, slope: 0, end: endBy(gen, back) }; // prettier-ignore
  }
  if (
    under != null &&
    (raw < s.floor - tol || (raw < s.floor + tol && aux < 0))
  ) {
    const back = t + nextAngle(theta, under, omega);
    return { ...gen, wave: "flat", value: s.floor, slope: 0, end: endBy(gen, back) }; // prettier-ignore
  }
  let reach = Number.POSITIVE_INFINITY;
  if (over != null) reach = Math.min(reach, t + nextAngle(theta, over, omega));
  if (under != null) reach = Math.min(reach, t + nextAngle(theta, 2 * Math.PI - under, omega)); // prettier-ignore
  return { ...sine, end: endBy(gen, reach) };
}

/**
 * What a wave runs along from `t` until its next edge (a trapezoid's, its
 * next corner, or where it meets a rail): `{value, end, running}` and how it
 * moves — `slope` (V/s) for a straight piece (and a `"flat"` one, standing
 * on a rail); for a sine its quadrature `aux` (V), `omega` (rad/s) and
 * `mid` (V), v' = ω·aux, aux' = −ω·(v − mid). `period` is the clock's
 * (seconds). A held clock, or one past its half's end, stands still
 * (`running` false, slope and omega 0).
 * @param {string} wave
 * @param {string} level - H or L
 * @param {{half: number, since?: number, frac?: number}|undefined} timing
 * @param {number|object} swing - `waveSwing`'s; a number, 0 V to it
 * @param {number} t - seconds
 */
export function waveGenerator(wave, level, timing, swing, t) {
  const s = asSwing(swing);
  const span = s.hi - s.lo;
  const phase = cyclePhase(level, timing, t);
  const turned = phase + shiftOf(s);
  const raw = s.lo + span * waveShape(wave, turned);
  const value = clip(raw, s);
  const half = timing?.half ?? 0;
  const period = 2 * half;
  const end =
    timing?.frac == null && half > 0 && timing?.since != null
      ? timing.since + half
      : Number.POSITIVE_INFINITY;
  const running = Number.isFinite(end) && t < end;
  const gen = { wave, value, end: running ? end : Number.POSITIVE_INFINITY, running, period }; // prettier-ignore
  if (!running) {
    return wave === "sine"
      ? { ...gen, mid: (s.lo + s.hi) / 2, aux: 0, omega: 0, slope: 0 }
      : { ...gen, slope: 0 };
  }
  if (wave === "trapezoid") {
    // Flat to the foot of the ramp, then the ramp to the edge.
    const corner = timing.since + (1 - 2 * TRAPEZOID_RAMP) * half;
    if (t < corner - CORNER_EPS * half) return clipLine({ ...gen, end: corner }, raw, 0, s, t); // prettier-ignore
    const ramp = span / (TRAPEZOID_RAMP * period);
    return clipLine(gen, raw, level === H ? -ramp : ramp, s, t);
  }
  if (wave === "sine") {
    return clipSine(gen, (s.lo + s.hi) / 2, span / 2, 2 * Math.PI * turned, (2 * Math.PI) / period, s, t); // prettier-ignore
  }
  let slope = 0;
  if (wave === "triangle") slope = ((level === H ? -2 : 2) * span) / period;
  else if (wave === "ramp-up") slope = span / period;
  else if (wave === "ramp-down") slope = -span / period;
  return clipLine(gen, raw, slope, s, t);
}

/** How long an AC supply's piece runs before it is stated again, seconds:
    a sine in quadrature runs on for ever, so this only bounds how far ahead
    a corner is searched for — a quarter second, four wakes a second. */
export const AC_PIECE_S = 0.25;

/**
 * An AC supply's sine at `t` (spice/ac-supplies.js), as `waveGenerator`
 * states a clock's sine: `{value, mid, aux, omega, end, running}`. It is a
 * function of the simulated time alone — `t`, seconds since Run — where a
 * clock's wave is told its phase by its square's edges: an AC supply has no
 * square for a logic engine to drive, so nothing ticks it at its half-cycles
 * (a 60 Hz supply's 120 edges a second were each a tick of the whole desk).
 * V = mid + amp·sin(2π·hz·t): its centre, rising, at Run.
 * @param {{lo: number, hi: number}} swing - `acSwing`'s
 * @param {number} hz
 * @param {number} t - seconds
 */
export function acGenerator(swing, hz, t) {
  const mid = (swing.lo + swing.hi) / 2;
  const amp = (swing.hi - swing.lo) / 2;
  const omega = 2 * Math.PI * hz;
  // The angle of `mid − amp·cos θ` (the quadrature form), a quarter on.
  const turns = hz * t + 0.25;
  const theta = 2 * Math.PI * (turns - Math.floor(turns));
  const end = (Math.floor(t / AC_PIECE_S + 1e-9) + 1) * AC_PIECE_S;
  return {
    wave: "sine",
    value: mid - amp * Math.cos(theta),
    mid,
    aux: amp * Math.sin(theta),
    omega,
    slope: 0,
    end,
    running: hz > 0,
    period: hz > 0 ? 1 / hz : 0,
  };
}

/** Which way a wave is heading as its generator starts: +1, −1 or 0. */
export function waveHeading(gen) {
  if (!gen.running) return 0;
  return Math.sign(gen.wave === "sine" ? gen.aux : gen.slope);
}
