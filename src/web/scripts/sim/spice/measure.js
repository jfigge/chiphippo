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

// spice/measure.js — what a timing part's readout says under Spice Lite: what
// it MEASURED (features/done/spice-lite-2-plan.md §8). Pure and DOM-free.
//
// A timing part as its silicon computes no period, so there is none to print
// but the one it ran at: each of its readout outputs (spice/silicon.js
// `readout` — a 555's OUT, a monostable section's Q) has its edges timed as
// it switches, and the readout states the rate between two rising edges, or
// the length of the last pulse — in TRUE time, where a fast oscillation is
// drawn slower than it runs (spice/cycles.js: each shown edge stands for
// `scale` real ones). Which of the two it states follows what the part's
// digital reading of its wiring calls the section (sim/rc-trace.js `timing`
// — a monostable's is its pulse, an astable's its rate); where that reading
// recognises nothing (RA as two resistors, say), a part that oscillates is
// reported by its rate. Its RECOGNITION problems are not said — a resistor
// the digital reading cannot find (RA as two in series), a configuration it
// does not know: the part does what its pins make it do. Its STRUCTURAL ones
// are (`STRUCTURAL`): a pin left unwired, a terminal that must be grounded
// and is not (a CD4528B's T1, grounded on no other part inside) — the silicon
// cannot time through a capacitor whose far plate goes nowhere either, and a
// part silent about why it never times is no help.
//
// The Properties card's Timing row is not this: it reads the catalog part,
// stopped or running, as it always has.

import { H } from "../levels.js";

/** Numbers a section of the digital reading states, replaced by what was
    measured (or dropped, where nothing has been yet). */
const FIGURES = ["frequency", "period", "duty", "high", "low", "width", "oscPeriod"]; // prettier-ignore

/** The digital reading's problems that are facts about the wiring, not
    about what it recognises — said under Spice Lite too. */
export const STRUCTURAL = new Set(["notConnected", "notGrounded"]);

/** An oscillation whose last rising edge is further back than this many of
    its periods has stopped. */
const STALE_PERIODS = 2.5;

/**
 * Note a readout output's level at `t` (seconds, shown), into `marks` (key →
 * `{level, rise, prevRise, fall, period, width}`, each time in true seconds).
 * `scale` is how many seconds of true time a shown second stands for here
 * (1/scale: a fast oscillation shown at the cap) — a period is measured in
 * shown time and divided by it.
 */
export function noteLevel(marks, key, level, t, scale = 1) {
  const was = marks.get(key);
  if (was?.level === level) return;
  const m = { ...(was ?? {}), level };
  if (level === H && was) {
    m.prevRise = was.rise ?? null;
    m.rise = t;
    if (m.prevRise != null) m.period = (t - m.prevRise) / scale;
    m.scale = scale;
  } else if (was?.level === H && was.rise != null) {
    m.fall = t;
    m.width = (t - was.rise) / scale;
  }
  marks.set(key, m);
}

/**
 * One part's timing analysis as Spice Lite reports it: its digital reading's
 * sections (`analysis` — the catalog part's `timing`), each with its figures
 * replaced by what was measured on its readout output, and only its
 * STRUCTURAL problems.
 * @param {{sections?: object[]}|null} analysis
 * @param {Array<{pin: number, section: number}>} readout
 * @param {(pin: number) => object|undefined} markOf - the pin's marks
 * @param {number} now - shown seconds
 */
export function measuredTiming(analysis, readout, markOf, now) {
  const sections = (analysis?.sections ?? [{ mode: null }]).map((s) => ({ ...s })); // prettier-ignore
  for (const { pin, section } of readout) {
    const s = sections[section];
    if (!s || s.mode === "external" || s.mode === "bistable" || s.mode === "unused") continue; // prettier-ignore
    for (const key of FIGURES) delete s[key];
    const m = markOf(pin);
    if (!m) continue;
    const running =
      m.period > 0 &&
      m.rise != null &&
      now - m.rise <= STALE_PERIODS * m.period * (m.scale ?? 1);
    const pulse = s.mode === "monostable";
    if (running && !pulse) {
      s.mode = s.mode === "oscillator" ? "oscillator" : "astable";
      s.period = m.period;
      s.frequency = 1 / m.period;
      if (m.width > 0 && m.width < m.period) s.duty = m.width / m.period;
    } else if (m.width > 0) {
      s.mode = "monostable";
      s.width = m.width;
    }
    s.measured = true;
  }
  const problems = (analysis?.problems ?? []).filter((p) => STRUCTURAL.has(p.code)); // prettier-ignore
  return { sections, problems };
}
