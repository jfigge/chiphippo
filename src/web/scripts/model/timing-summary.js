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

// timing-summary.js — what a timed part's reading of its own R and C (its
// `timing` analysis — sim/timing.js) SAYS, in the three places it is said: the
// short readout printed on the chip while it runs (numbers and units only,
// nothing to translate), the sentences of its Properties card's Timing row,
// and the sentence a wiring problem is reported with — on the desk, in a toast
// and in the AI review. One module, so the three can never describe one part
// three ways. Pure; its words go through `tf`, so it reads under `node --test`.

import { tf } from "../i18n.js";
import { formatWithPrefix } from "./si-value.js";
import { MIN_SHOWN_S, TIMING_CAP_HZ } from "../sim/timing.js";

/** Frequency prefixes, largest first. */
const HZ_STEPS = Object.freeze([
  ["M", 1e6],
  ["k", 1e3],
  ["", 1],
]);

/** Time prefixes, largest first. */
const S_STEPS = Object.freeze([
  ["", 1],
  ["m", 1e-3],
  ["µ", 1e-6],
  ["n", 1e-9],
]);

/** A formatted value and its unit, a space between: "1.44" "k" "Hz". */
function withUnit(formatted, unit) {
  if (!formatted) return "";
  const m = /^([\d.]+)(\D*)$/.exec(formatted);
  return m ? `${m[1]} ${m[2]}${unit}` : `${formatted}${unit}`;
}

/** "1.44 kHz", "437 Hz", "0.5 Hz" — three significant figures. */
export function formatHz(hz) {
  return withUnit(formatWithPrefix(hz, HZ_STEPS), "Hz");
}

/** "1.1 s", "220 µs", "4.7 ms" — three significant figures. */
export function formatSeconds(s) {
  return withUnit(formatWithPrefix(s, S_STEPS), "s");
}

/** Is one section's oscillation faster than the desk shows? (sim/timing.js) */
function oscillationCapped(section) {
  const period =
    section.mode === "multivibrator" ? section.oscPeriod : section.period;
  return Number.isFinite(period) && period < 1 / TIMING_CAP_HZ;
}

/** Is one section's one-shot pulse shorter than the desk shows? */
function pulseStretched(section) {
  return Number.isFinite(section.width) && section.width < MIN_SHOWN_S;
}

/**
 * The readout a running timed chip prints on its body: each section's rate or
 * pulse, numbers and units only. "" when there is nothing to state — a
 * bistable 555 times nothing, so it prints nothing.
 * @param {{sections?: object[]}|null} analysis
 * @returns {string}
 */
export function timingReadout(analysis) {
  const parts = [];
  for (const s of analysis?.sections ?? []) {
    if (s.mode === "astable" || s.mode === "oscillator") {
      parts.push(formatHz(s.frequency));
    } else if (s.mode === "monostable") {
      parts.push(formatSeconds(s.width));
    } else if (s.mode === "multivibrator") {
      parts.push(`${formatHz(s.frequency)} · ${formatSeconds(s.width)}`);
    }
  }
  return parts.join(" · ");
}

/** Whether any part of the readout is shown slower (or longer) than true. */
export function timingCapped(analysis) {
  return (analysis?.sections ?? []).some((s) =>
    s.mode === "monostable"
      ? pulseStretched(s)
      : s.mode === "multivibrator"
        ? oscillationCapped(s) || pulseStretched(s)
        : oscillationCapped(s),
  );
}

/** English for each problem code — the fallback `tf` falls back on. */
const PROBLEM_EN = Object.freeze({
  noCapacitor: "no timing capacitor from {from} to {to}",
  noResistor: "no timing resistor from {from} to {to}",
  notConnected: "{pin} is not connected",
  ne555Unrecognised:
    "TRIG (2), THRES (6) and DISCH (7) are wired neither astable (TRIG and " +
    "THRES joined, DISCH between RA and RB), monostable (THRES and DISCH " +
    "joined, TRIG driven from outside) nor bistable (THRES on GND, TRIG " +
    "driven from outside)",
  cd4060Incomplete:
    "the RC oscillator needs Cx from φO (9), Rx from φ̄O (10) and Rs from φI " +
    "(11), all meeting at one junction",
});

/** A section's sentence, prefixed with its number when the part has two. */
function inSection(section, text) {
  return section
    ? tf("timing.section", "Section {section}: {text}", { section, text })
    : text;
}

/**
 * Each wiring problem as a sentence.
 * @param {{problems?: object[]}|null} analysis
 * @returns {string[]}
 */
export function timingProblemSentences(analysis) {
  return (analysis?.problems ?? []).map((p) =>
    inSection(
      p.section,
      tf(`timing.problem.${p.code}`, PROBLEM_EN[p.code] ?? p.code, {
        from: p.from ?? "",
        to: p.to ?? "",
        pin: p.pin ?? "",
      }),
    ),
  );
}

/** One section's description (no section prefix). */
function sectionSentence(s) {
  const lines = [];
  if (s.mode === "astable") {
    lines.push(
      tf("timing.astable", "Astable — {frequency}, {duty}% duty cycle", {
        frequency: formatHz(s.frequency),
        duty: Math.round(s.duty * 100),
      }),
    );
  } else if (s.mode === "monostable") {
    lines.push(
      tf("timing.monostable", "Monostable — {width} pulse", {
        width: formatSeconds(s.width),
      }),
    );
  } else if (s.mode === "bistable") {
    lines.push(
      tf(
        "timing.bistable",
        "Bistable — TRIG LOW sets the output HIGH, RESET LOW clears it",
      ),
    );
  } else if (s.mode === "multivibrator") {
    lines.push(
      tf(
        "timing.multivibrator",
        "Astable: Q at {frequency}; one-shot: a {width} pulse",
        { frequency: formatHz(s.frequency), width: formatSeconds(s.width) },
      ),
    );
  } else if (s.mode === "oscillator") {
    lines.push(
      tf("timing.oscillator", "RC oscillator — {frequency}", {
        frequency: formatHz(s.frequency),
      }),
    );
  } else if (s.mode === "external") {
    lines.push(tf("timing.external", "Counting an external clock on φI"));
  } else if (s.mode === "unused") {
    lines.push(tf("timing.unused", "Not used"));
  } else {
    return null;
  }
  if (s.mode !== "monostable" && oscillationCapped(s)) {
    lines.push(
      tf("timing.capped", "Faster than the desk can show: drawn at {cap}.", {
        cap: formatHz(TIMING_CAP_HZ),
      }),
    );
  }
  if (
    (s.mode === "monostable" || s.mode === "multivibrator") &&
    pulseStretched(s)
  ) {
    lines.push(
      tf(
        "timing.stretched",
        "Shorter than the desk can show: drawn {shown} long.",
        { shown: formatSeconds(MIN_SHOWN_S) },
      ),
    );
  }
  return lines;
}

/**
 * The Properties card's Timing row: what the part reads its wiring as, one
 * line per fact — or, when it cannot read it, why not.
 * @param {{sections?: object[], problems?: object[]}|null} analysis
 * @returns {string}
 */
export function timingDescription(analysis) {
  const sections = analysis?.sections ?? [];
  const many = sections.length > 1;
  const lines = [];
  sections.forEach((s, i) => {
    const said = sectionSentence(s);
    if (!said) return;
    said.forEach((line, j) =>
      lines.push(j === 0 && many ? inSection(s.section ?? i + 1, line) : line),
    );
  });
  const problems = timingProblemSentences(analysis);
  if (problems.length) {
    lines.push(
      tf("timing.notRecognised", "Wiring not recognised: {problems}.", {
        problems: problems.join("; "),
      }),
    );
  }
  return lines.join("\n");
}
