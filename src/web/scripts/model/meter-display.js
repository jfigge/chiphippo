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

// meter-display.js — what a multimeter's LCD shows. Pure and DOM-free.
//
// The BM235's display is 3⅚ digits, 6000 counts (5999 the most a range
// shows), updated five times a second; it ranges itself, up past a range's
// counts and down again only well inside the next one, and RANGE holds the
// range it is on (the manual's "Manual or Auto-ranging"). The ranges are
// the manual's, per function. Readings are exact: the meter's ±(0.3 % + 2 d)
// and its kin are not modelled.
//
// A reading arrives as the run's raw figures over the update's window
// (sim/meter-average.js: the voltage across the probes — its mean, its AC
// RMS, its extremes) and is turned into what the function shows here:
// volts, the current through the element (the voltage over its ohms), or
// the resistance its test source reads (`ohmsRead`).

import { CONTINUITY_OHMS, METER_ELEMENTS } from "../catalog/meter.js";

/** A range: `full` its full scale in base units, `dp` its decimals, `unit`
    the symbol shown and `factor` base units → shown; `limit` the most it
    shows, counts (5999 unless the range says otherwise). */
const range = (full, dp, unit, factor, limit = 5999) =>
  Object.freeze({ full, dp, unit, factor, limit });

/** Each function's ranges, smallest first (the manual's tables). */
export const METER_RANGES = Object.freeze({
  dcv: [range(6, 3, "V", 1), range(60, 2, "V", 1), range(600, 1, "V", 1), range(1000, 0, "V", 1, 1000)], // prettier-ignore
  acv: [range(6, 3, "V", 1), range(60, 2, "V", 1), range(600, 1, "V", 1), range(1000, 0, "V", 1, 1000)], // prettier-ignore
  dcmv: [range(0.06, 2, "mV", 1e3), range(0.6, 1, "mV", 1e3)],
  acmv: [range(0.06, 2, "mV", 1e3), range(0.6, 1, "mV", 1e3)],
  autov: [range(600, 1, "V", 1), range(1000, 0, "V", 1, 1000)],
  ohm: [range(600, 1, "Ω", 1), range(6e3, 3, "kΩ", 1e-3), range(60e3, 2, "kΩ", 1e-3), range(600e3, 1, "kΩ", 1e-3), range(6e6, 3, "MΩ", 1e-6), range(60e6, 2, "MΩ", 1e-6)], // prettier-ignore
  cont: [range(600, 1, "Ω", 1)],
  diode: [range(3, 3, "V", 1, 3000)],
  ua: [range(600e-6, 1, "µA", 1e6), range(6000e-6, 0, "µA", 1e6)],
  ma: [range(0.06, 2, "mA", 1e3), range(0.6, 1, "mA", 1e3)],
  // The 10 A range shows past 10 A: the manual's 20 A for 30 s.
  a: [range(6, 3, "A", 1), range(10, 2, "A", 1, 2000)],
  // The manual's capacitance ranges, 2000 counts each; 10.00 mF its last.
  cap: [range(20e-9, 2, "nF", 1e9, 1999), range(200e-9, 1, "nF", 1e9, 1999), range(2000e-9, 0, "nF", 1e9, 1999), range(20e-6, 2, "µF", 1e6, 1999), range(200e-6, 1, "µF", 1e6, 1999), range(2000e-6, 0, "µF", 1e6, 1999), range(10e-3, 2, "mF", 1e3, 1000)], // prettier-ignore
  // Hz at 6000 counts (an assumption: the manual gives only its accuracy).
  hz: [range(60, 2, "Hz", 1), range(600, 1, "Hz", 1), range(6e3, 3, "kHz", 1e-3), range(60e3, 2, "kHz", 1e-3), range(600e3, 1, "kHz", 1e-3)], // prettier-ignore
});

/** A range moves DOWN once a reading is under this many of its counts — the
    next range's 5000: an assumption; the manual says only that it ranges. */
export const DOWN_COUNTS = 500;

/** AutoV shows nothing below this, volts (the manual's "threshold > 1 V"). */
export const AUTOV_THRESHOLD_V = 1;

/** The ranges a function reads on (a current function by its scale; any
    function in Hz on Hz's). */
export function rangesFor(fn, scale, hz = false) {
  if (hz) return METER_RANGES.hz;
  if (fn === "dca" || fn === "aca") return METER_RANGES[scale] ?? null;
  return METER_RANGES[fn] ?? null;
}

/** Whether a function's range is the user's to hold (the manual: not on
    AutoV, capacitance or Hz — whose RANGE picks the trigger instead). */
export function manualRanging(fn, hz = false) {
  return !hz && fn !== "autov" && fn !== "cap" && fn !== "off";
}

/** A value's counts on a range. */
const countsOn = (r, value) => Math.round(Math.abs(value) * r.factor * 10 ** r.dp); // prettier-ignore

/** Whether a value is past what a range shows. */
const over = (r, value) => !Number.isFinite(value) || countsOn(r, value) > r.limit; // prettier-ignore

/**
 * The range a reading is shown on: auto-ranged from where it was (`from`,
 * an index — up past a range's limit, down once under `DOWN_COUNTS` of it),
 * or held there while `manual`.
 * @param {Array} ranges
 * @param {number} value - base units
 * @param {number|null} from
 * @param {boolean} [manual]
 */
export function pickRange(ranges, value, from, manual = false) {
  const top = ranges.length - 1;
  let i = Math.min(top, Math.max(0, Number.isInteger(from) ? from : 0));
  if (manual) return i;
  if (!Number.isFinite(value)) return top;
  while (i < top && over(ranges[i], value)) i++;
  while (i > 0 && countsOn(ranges[i], value) < DOWN_COUNTS && !over(ranges[i - 1], value)) i--; // prettier-ignore
  return i;
}

/**
 * The resistance an ohms test source reads from the voltage across its
 * probes: `V · R / (Vsource − V)` — Infinity open (the source's whole
 * voltage across them), negative where the circuit drives them past it (a
 * live circuit's false reading).
 * @param {number} volts
 */
export function ohmsRead(volts) {
  const { volts: source, ohms } = METER_ELEMENTS.ohms;
  const left = source - volts;
  if (Math.abs(left) < source * 1e-6) return Infinity;
  return (volts * ohms) / left;
}

/**
 * What a reading is in the function's own quantity: volts, amps (the
 * voltage across the element over its ohms), or ohms.
 * @param {string} fn
 * @param {{mean: number, rms: number}} reading - the window's figures, volts
 * @param {{ohms: number}|null} element
 * @returns {number}
 */
export function quantityOf(fn, reading, element) {
  const { mean = 0, rms = 0 } = reading ?? {};
  switch (fn) {
    case "acv":
    case "acmv":
      return rms;
    case "dca":
      return element ? mean / element.ohms : 0;
    case "aca":
      return element ? rms / element.ohms : 0;
    case "ohm":
    case "cont":
      return ohmsRead(mean);
    default:
      return mean;
  }
}

/**
 * The LCD for one reading.
 * @param {object} opts
 * @param {string} opts.fn - catalog/meter.js `meterSetup`'s
 * @param {string|null} opts.scale - a current function's
 * @param {boolean} opts.inErr - Beep-Jack
 * @param {{ohms: number}|null} opts.element
 * @param {{mean: number, rms: number, min?: number, max?: number}|null} opts.reading
 *   - null: the input reads nothing (0)
 * @param {number|null} [opts.range] - the range it was on
 * @param {boolean} [opts.manual] - RANGE has held it there
 * @param {boolean} [opts.hz] - the Hz function: `reading.hz` is shown
 * @param {number} [opts.value] - a value to show in the function's own
 *   quantity in place of the reading's (REC's MAX, MIN or AVG)
 * @param {number|null} [opts.relative] - Relative Zero's reference: shown
 *   is the value less it
 * @returns {{text: string, unit: string, mode: "dc"|"ac"|null,
 *   range: number|null, ol: boolean, beep: boolean, blank: boolean,
 *   value: number|null}} — `value` the quantity read (before any
 *   reference is taken off), what REC and Relative Zero record
 */
export function meterDisplay({
  fn,
  scale,
  inErr,
  element,
  reading,
  range: from = null,
  manual = false,
  hz = false,
  value: given,
  relative = null,
}) {
  // prettier-ignore
  const blank = { text: "", unit: "", mode: null, range: null, ol: false, beep: false, blank: true, value: null }; // prettier-ignore
  if (fn === "off") return blank;
  if (inErr) return { ...blank, text: "InEr", blank: false, beep: true };
  let mode = fn === "acv" || fn === "acmv" || fn === "aca" ? "ac" : "dc";
  if (fn === "ohm" || fn === "cont" || fn === "diode" || fn === "cap") mode = null; // prettier-ignore
  let value;
  if (Number.isFinite(given) || given === Infinity) {
    value = given;
  } else if (hz) {
    value = reading?.hz ?? 0;
  } else if (fn === "cap") {
    // A capacitance is what the test measured (sim/meter-offline.js), in
    // farads: Infinity past its last range, null still measuring.
    if (reading?.farads == null) return { ...blank, text: "----", unit: "nF", blank: false }; // prettier-ignore
    value = reading.farads;
  } else if (fn === "autov") {
    // DC or AC, whichever is the larger in peak; nothing under its threshold.
    const r = reading ?? { mean: 0, rms: 0, min: 0, max: 0 };
    const dc = Math.abs(r.mean ?? 0);
    const acPeak = Math.max(Math.abs((r.max ?? r.mean ?? 0) - (r.mean ?? 0)), Math.abs((r.min ?? r.mean ?? 0) - (r.mean ?? 0))); // prettier-ignore
    if (Math.max(dc, acPeak) < AUTOV_THRESHOLD_V) {
      return { ...blank, text: "----", unit: "V", blank: false };
    }
    mode = acPeak > dc ? "ac" : "dc";
    value = mode === "ac" ? (r.rms ?? 0) : (r.mean ?? 0);
  } else {
    value = quantityOf(fn, reading, element);
  }
  if (hz) mode = null;
  const ranges = rangesFor(fn, scale, hz);
  if (!ranges) return blank;
  const beep = !hz && fn === "cont" && Number.isFinite(value) && value >= 0 && value < CONTINUITY_OHMS; // prettier-ignore
  const shown = relative != null && Number.isFinite(value) ? value - relative : value; // prettier-ignore
  const i = pickRange(ranges, shown, from, manual);
  const r = ranges[i];
  const ol = over(r, shown);
  if (ol) return { text: "OL", unit: r.unit, mode, range: i, ol: true, beep, blank: false, value }; // prettier-ignore
  const counts = countsOn(r, shown);
  const digits = (counts / 10 ** r.dp).toFixed(r.dp);
  const sign = shown < 0 && counts > 0 ? "-" : "";
  return { text: `${sign}${digits}`, unit: r.unit, mode, range: i, ol: false, beep, blank: false, value }; // prettier-ignore
}
