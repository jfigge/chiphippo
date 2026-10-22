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

import { H, L } from "../levels.js";

/** Numbers a section of the digital reading states, replaced by what was
    measured (or dropped, where nothing has been yet). */
const FIGURES = ["frequency", "period", "duty", "high", "low", "width", "oscPeriod"]; // prettier-ignore

/** The digital reading's problems that are facts about the wiring, not
    about what it recognises — said under Spice Lite too. */
export const STRUCTURAL = new Set([
  "notConnected",
  "notGrounded",
  "cxTooLarge",
]);

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

/** A swing across a speaker smaller than this, volts peak to peak, is
    silence (the solve's own settling, a node still charging). */
export const TONE_MIN_VPP = 0.02;

/** How long, shown seconds, a speaker's swing is taken over while it has no
    period: what it did longer ago than this is forgotten. Two periods of the
    lowest tone heard (20 Hz). Without it a coupling capacitor's charge at
    Run — 2.5 V across the coil for a few milliseconds, a 555 straight into
    100 µF and 8 Ω — set the middle of the swing so high that the ±0.4 V
    tone after it never crossed it, and the speaker was silent for good. */
export const TONE_WINDOW_S = 0.1;

/** How far past the middle of its swing the voltage must go to count as the
    other half of a cycle, as a share of the swing — the hysteresis that
    keeps a node's slow sag inside one half from reading as a cycle. */
const TONE_BAND = 0.2;

/**
 * Note the voltage across a speaker at `t` (seconds, shown), into `tones`
 * (key → `{lo, hi, spanLo, spanHi, level, rise, prevRise, period, scale,
 * lost}`, times in true seconds as noteLevel's). The voltage reads HIGH past
 * the middle of the swing it makes (`lo`–`hi`: its last whole cycle's
 * extremes, widened by anything past them since) by TONE_BAND of it, LOW as
 * far below, and keeps its last reading between; a rise is timed as a
 * readout's is. Until it has a period — and once it has made no cycle in
 * STALE_PERIODS of it — the swing is what it has done since (`spanLo`–
 * `spanHi`, from `spanAt`), so a quieter tone is heard again — and over no
 * more than TONE_WINDOW_S, so a surge before the tone is forgotten.
 */
export function noteTone(tones, key, volts, t, scale = 1) {
  if (!Number.isFinite(volts)) return;
  const was = tones.get(key);
  const m = was
    ? { ...was, spanLo: Math.min(was.spanLo, volts), spanHi: Math.max(was.spanHi, volts) } // prettier-ignore
    : { lo: volts, hi: volts, spanLo: volts, spanHi: volts, spanAt: t, level: null, lost: false }; // prettier-ignore
  const timed = m.period > 0 && m.rise != null;
  if ((!timed || m.lost) && t - (m.spanAt ?? t) > TONE_WINDOW_S) {
    // No period yet, and the swing taken too long ago to be this tone's.
    m.spanLo = volts;
    m.spanHi = volts;
    m.spanAt = t;
  }
  if (
    timed &&
    !m.lost &&
    t - m.rise > STALE_PERIODS * m.period * (m.scale ?? 1)
  ) {
    // It stopped: measured afresh from here.
    m.lost = true;
    m.spanLo = volts;
    m.spanHi = volts;
    m.spanAt = t;
  }
  if (!timed || m.lost) {
    m.lo = m.spanLo;
    m.hi = m.spanHi;
  } else {
    m.lo = Math.min(m.lo, volts);
    m.hi = Math.max(m.hi, volts);
  }
  const swing = m.hi - m.lo;
  let level = m.level;
  if (swing >= TONE_MIN_VPP) {
    const mid = (m.lo + m.hi) / 2;
    if (volts >= mid + TONE_BAND * swing) level = H;
    else if (volts <= mid - TONE_BAND * swing) level = L;
  }
  if (level === H && m.level === L) {
    m.prevRise = m.rise ?? null;
    m.rise = t;
    m.period = m.prevRise != null && !m.lost ? (t - m.prevRise) / scale : null; // prettier-ignore
    m.scale = scale;
    m.lost = false;
    // The cycle just ended is the swing from here on.
    if (m.period > 0) {
      m.lo = m.spanLo;
      m.hi = m.spanHi;
    }
    m.spanLo = volts;
    m.spanHi = volts;
    m.spanAt = t;
  }
  m.level = level;
  tones.set(key, m);
}

/**
 * What a speaker is playing at `now` (shown seconds), from its `noteTone`
 * marks: `{hz, vpp}` — the pitch in true time and the swing that last whole
 * cycle made, volts peak to peak — or null (silent: no cycle lately, or too
 * small a swing to hear).
 */
export function toneOf(m, now) {
  if (!m || !(m.period > 0) || m.rise == null) return null;
  if (now - m.rise > STALE_PERIODS * m.period * (m.scale ?? 1)) return null;
  const vpp = m.hi - m.lo;
  if (!(vpp >= TONE_MIN_VPP)) return null;
  return { hz: 1 / m.period, vpp };
}
