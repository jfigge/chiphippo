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

// meter.js — the multimeter brick: a bench DMM modelled on the Brymen BM235
// (BM231/233/235 user's manual, P/N 7M1C-1501-0000; where the manual is
// silent, the unit lygte-info.dk measured — "DMM Brymen BM235"). Pure data
// and pure functions, as the rest of the catalog is.
//
// The meter is NOT an ideal instrument: whatever its dial and its red lead's
// jack select is an element between its two probes (`meterSetup`), solved
// with the circuit under Spice Lite (spice/bench-parts.js, the "x" device of
// spice/analog-devices.js) — so its loading, its burden voltage and its
// blown fuses fall out of the solve. The logic engine has no voltages: there
// a current shunt is a wire between the probes (sim/netlist.js) and the
// meter shows nothing. Its probes are no terminals and claim no hole — a
// probe touches whatever is in the hole it is on (`params.red`/`black`).

import { keepRunLatches } from "./run-latches.js";

/** The dial's positions, in order round it (the lygte-info.dk review's). */
export const METER_POSITIONS = Object.freeze(["autov", "off", "v", "ohm", "mv", "diode", "ma", "ua"]); // prettier-ignore

/** What SELECT cycles at each position, its default first. The V position's
    VFD and the mV position's temperature are left out (no VFD, no
    thermocouple on the bench); a DC desk reads DC first (the BM235 starts
    its V position on AC). */
export const METER_SELECT = Object.freeze({
  v: Object.freeze(["dc", "ac"]),
  ohm: Object.freeze(["ohm", "cont"]),
  diode: Object.freeze(["diode", "cap"]),
  mv: Object.freeze(["dc", "ac"]),
  ma: Object.freeze(["dc", "ac"]),
  ua: Object.freeze(["dc", "ac"]),
});

/** The four jacks, left to right on the body: 10A, µA mA, COM, VΩ. The
    black lead is always in COM; the red one in any of the other three. */
export const METER_JACKS = Object.freeze(["a", "ma", "com", "v"]);
export const RED_JACKS = Object.freeze(["a", "ma", "v"]);

/** How the meter is drawn (components/meter-view.js), the default first:
    "volthippo" — the BM235's body in the app's orange under its own name,
    VoltHippo; or "bm235" — the EEVblog edition of the Brymen BM235 as its
    manual pictures it (the EEVBlog look), drawn as a mock-up while its maker
    is asked whether the app may show it. A look only: the meter is the same
    every way. The last one picked is what the next meter taken out wears
    (settings `meterLook`, DeskController `setDefaultMeterLook`). */
export const METER_LOOKS = Object.freeze(["volthippo", "bm235"]);

/** How many multimeters a desk may have out at once (the toolbar's Add
    stops there). */
export const MAX_METERS = 3;

/** The two probes. */
export const PROBES = Object.freeze(["red", "black"]);

/** The fuses: F1 0.4 A on the µA mA input, F2 11 A on the 10A input (the
    manual's "Fuses use"). The run latches that say one has blown. */
export const METER_FUSES = Object.freeze({
  f1: Object.freeze({ amps: 0.4, latch: "fuseF1" }),
  f2: Object.freeze({ amps: 11, latch: "fuseF2" }),
});

/** A fuse blows past its rating held this long, simulated seconds, or at
    once past `FUSE_INSTANT` times it (an assumption: both are fast "F"
    fuses, whose curves the manual does not give). */
export const FUSE_HOLD_S = 0.01;
export const FUSE_INSTANT = 10;

/** The element each function puts between the probes, `{volts, ohms}`: a
    Thévenin source (`volts` 0 for a plain resistance).
    - V and mV: the 10 MΩ input (the manual's DCV/ACV input impedance).
    - AutoV: its LoZ, 2.1 kΩ (the manual's figure "at low voltage"; its rise
      to a few hundred kΩ above 50 V is not modelled — the lygte-info.dk unit
      measured differently, the manual is followed).
    - Ω and continuity: a floating 1.6 V source (the manual's open-circuit
      voltage) behind 8 kΩ — an assumption DERIVED from the manual's 0.2 µA
      into 8 MΩ on the 6 MΩ range, scaled to the bottom ranges, against the
      0.16 mA the measured unit shorted. One reference serves every range:
      for a linear network the reading is its resistance whatever the
      reference; only a nonlinear part above 6 kΩ reads otherwise than the
      real meter's higher-range test currents would make it.
    - Diode: 3.2 V (the manual's "< 3.2 VDC") behind 3.2 V ÷ the measured
      unit's 0.33 mA short — 0.27 mA at 0.6 V, against the manual's 0.3 mA.
    - The shunts (each its burden voltage per amp, the manual's): µA
      0.1 mV/µA = 100 Ω (the measured unit's R33 too), mA 1.9 mV/mA = 1.9 Ω,
      A 0.04 V/A = 0.04 Ω. */
export const METER_ELEMENTS = Object.freeze({
  volts: Object.freeze({ volts: 0, ohms: 10e6 }),
  autov: Object.freeze({ volts: 0, ohms: 2100 }),
  ohms: Object.freeze({ volts: 1.6, ohms: 8000 }),
  diode: Object.freeze({ volts: 3.2, ohms: 3.2 / 0.33e-3 }),
  ua: Object.freeze({ volts: 0, ohms: 100, fuse: "f1" }),
  ma: Object.freeze({ volts: 0, ohms: 1.9, fuse: "f1" }),
  a: Object.freeze({ volts: 0, ohms: 0.04, fuse: "f2" }),
});

/**
 * The capacitance test (the manual's ranges, 20.00 nF to 10.00 mF): the
 * meter charges what is between its probes from a source behind a range's
 * resistance, one way and then the other between −`threshold` and
 * +`threshold` volts — non-polarized, as the measured unit's waveform is —
 * and times each swing: C = Δt / (R · ln((V + Vt) / (V − Vt))), exact for a
 * capacitor on its own and thrown off by whatever else is across it, as a
 * real meter is (sim/meter-offline.js `measureCapacitance`). The source,
 * the threshold and the resistances are ASSUMPTIONS (the manual gives none):
 * the ohms test's 1.6 V; a range's resistance swings its full scale in
 * `halfS`, and no less than `minOhms` — fitted to the measured unit's first
 * estimate of 1000 µF in about 3 seconds.
 */
export const CAP_TEST = Object.freeze({
  volts: 1.6,
  threshold: 0.5,
  halfS: 0.1,
  minOhms: 2900,
});

/** The capacitance ranges' full scales, farads (the manual's). */
export const CAP_FULL = Object.freeze([20e-9, 200e-9, 2000e-9, 20e-6, 200e-6, 2000e-6, 10e-3]); // prettier-ignore

/** ln((V + Vt) / (V − Vt)): a swing's time over its R·C. */
export const CAP_LOG = Math.log(
  (CAP_TEST.volts + CAP_TEST.threshold) / (CAP_TEST.volts - CAP_TEST.threshold),
);

/** The resistance a capacitance range charges through, Ω. */
export function capOhms(range) {
  const full = CAP_FULL[Math.min(CAP_FULL.length - 1, Math.max(0, range))];
  return Math.max(CAP_TEST.minOhms, CAP_TEST.halfS / (full * CAP_LOG));
}

/** How long a capacitance range takes to swing its full scale, seconds. */
export function capSwingS(range) {
  return capOhms(range) * CAP_FULL[range] * CAP_LOG;
}

/** The capacitance test's element: its source one way or the other (`sign`)
    behind a range's resistance. */
export function capElement(range = 0, sign = 1) {
  return { volts: (sign < 0 ? -1 : 1) * CAP_TEST.volts, ohms: capOhms(range) };
}

/**
 * The Hz function's trigger sensitivity, sine RMS in the function's own unit
 * — per trigger range on the V position (6 V, 60 V, 600 V, 1000 V), one each
 * for mV and the current scales. The manual's table (5 V on 6 V, 10 V,
 * 50 V, 500 V; 50 mV; 500 µA, 50 mA, 8 A) is its GUARANTEE, a 5 V logic
 * signal short of it on every range; the measured unit triggered from
 * 0.1 V RMS on the 6 V range. So these are the manual's in its own
 * proportion, scaled to the measured 0.1 V (an assumption).
 */
export const HZ_SENSITIVITY = Object.freeze({
  v: Object.freeze([0.1, 0.2, 1, 10]),
  mv: Object.freeze([1e-3]),
  ua: Object.freeze([10e-6]),
  ma: Object.freeze([1e-3]),
  a: Object.freeze([0.16]),
});

/** The lowest frequency Hz shows, and the stretch it counts over (the
    measured unit's 2 Hz; the manual's 10 Hz is its guarantee). */
export const HZ_MIN = 2;
export const HZ_GATE_S = 1;

/**
 * The Hz function's trigger bands for a setup, as half-widths in VOLTS
 * across the probes — a current's through its shunt — one per trigger
 * range; [] where Hz is not offered (AutoV, Ω, diode, capacitance, or a
 * function reading nothing).
 */
export function hzBands(setup) {
  if (!setup?.reads || !setup.element) return [];
  const { fn, scale, element } = setup;
  if (fn === "dcv" || fn === "acv") return [...HZ_SENSITIVITY.v];
  if (fn === "dcmv" || fn === "acmv") return [...HZ_SENSITIVITY.mv];
  if ((fn === "dca" || fn === "aca") && HZ_SENSITIVITY[scale]) {
    return HZ_SENSITIVITY[scale].map((amps) => amps * element.ohms);
  }
  return [];
}

/** The continuity beep's threshold, Ω: the measured unit's 161 Ω, inside
    the manual's "between 30 and 480 Ω" band. Fixed, as the real meter's is. */
export const CONTINUITY_OHMS = 161;

/** Where a new meter's probes lie, from its top-left corner (pitch): beside
    its right edge, level with its jacks. */
const PROBE_REST = Object.freeze({
  red: Object.freeze({ dx: 36, dy: 52 }),
  black: Object.freeze({ dx: 36, dy: 58 }),
});

/** The body, pitch (2.54 mm): the BM235 in its holster is 161 × 80 mm, so
    31.5 × 63.4 — stood portrait at true scale. */
export const METER_SIZE = Object.freeze({ width: 32, height: 63 });

/** The meter folded down (Properties ▸ Size ▸ Compact, or a click on its
    title — `params.size`): the name band and a shorter LCD with its jacks
    in a row under them, in a boot half the width. `origin` is where that box
    sits in the full body's frame, so folding it moves the meter by `origin`
    and leaves the screen where it was. */
export const METER_COMPACT = Object.freeze({
  origin: Object.freeze({ x: 3, y: 2 }),
  width: 26,
  height: 22.3,
});

/** Whether a meter is drawn folded down. */
export function isCompact(params) {
  return params?.size === "compact";
}

/** The body's size, pitch, as drawn. */
export function meterSize(params) {
  if (!isCompact(params)) return METER_SIZE;
  return { width: METER_COMPACT.width, height: METER_COMPACT.height };
}

/** An address a probe may name (`<owner>.<point>`, model/breadboard.js's
    grammar; whether it is a REAL point is the document's to say). */
const ADDRESS_RE = /^[A-Za-z][A-Za-z0-9]*\.[^\s.]+$/;

/** A desk coordinate to the 0.01 grid boards and waypoints keep. */
const grid = (x) => Math.round(x * 100) / 100;

/**
 * A probe as stored: on a point (`{at}`), or lying on the desk at an offset
 * from the meter's top-left corner (`{dx, dy}`) — so it rides the meter when
 * it is dragged, as a probe lying beside it would.
 * @param {unknown} raw
 * @param {{dx: number, dy: number}} rest - where it lies with nothing said
 */
export function normalizeProbe(raw, rest) {
  if (typeof raw?.at === "string" && ADDRESS_RE.test(raw.at)) {
    return { at: raw.at };
  }
  const dx = Number.isFinite(raw?.dx) ? grid(raw.dx) : rest.dx;
  const dy = Number.isFinite(raw?.dy) ? grid(raw.dy) : rest.dy;
  return { dx, dy };
}

/** The probe a new meter has, lying where it rests. */
export function restingProbe(which) {
  return { ...PROBE_REST[which] };
}

/** The sub-function SELECT has chosen at `position`, its default when none. */
export function selectionAt(params, position) {
  const list = METER_SELECT[position];
  if (!list) return null;
  const chosen = params?.sel?.[position];
  return list.includes(chosen) ? chosen : list[0];
}

/** Whether a dial position measures a current. */
const isCurrentPosition = (position) => position === "ma" || position === "ua";

/**
 * What a meter's settings make of it: the function its display shows, the
 * scale it reads in, the element between its probes, and whether the
 * Beep-Jack warning stands.
 * - `fn` — `off`, `autov`, `dcv`, `acv`, `dcmv`, `acmv`, `ohm`, `cont`,
 *   `diode`, `cap`, `dca`, `aca`.
 * - `scale` — the ranges a current function reads on: `ua`, `ma` or `a`
 *   (null for any other function).
 * - `element` — `{volts, ohms, fuse}` between the probes, or null (nothing:
 *   the input is open). The 10A input's shunt is HARD-WIRED from its jack to
 *   COM (an assumption, as on practically every DMM), so a red lead in 10A
 *   is that shunt whatever the dial says — the trap Beep-Jack warns about.
 *   The µA mA input's shunt is switched in at the µA and mA A positions only
 *   (an assumption). A blown fuse opens its element.
 * - `reads` — the function's own input is where the red lead is (a current
 *   position with the lead in VΩ reads 0, as the real meter does).
 * - `inErr` — a red lead in a current jack with the dial on anything else
 *   (Beep-Jack™: "InEr" and a beep).
 * @param {object} params - the meter's (normalized)
 */
export function meterSetup(params) {
  const position = METER_POSITIONS.includes(params?.dial) ? params.dial : "v";
  const jack = RED_JACKS.includes(params?.jack) ? params.jack : "v";
  const sel = selectionAt(params, position);
  const blown = (fuse) =>
    Boolean(fuse) && params?.[METER_FUSES[fuse].latch] === true;
  const fused = (element) => (element && blown(element.fuse) ? null : element);
  const shuntA = fused(METER_ELEMENTS.a);
  const current = isCurrentPosition(position);
  const inErr = position !== "off" && !current && jack !== "v";
  if (position === "off") {
    return { fn: "off", position, scale: null, element: jack === "a" ? shuntA : null, reads: false, inErr: false }; // prettier-ignore
  }
  if (current) {
    const fn = sel === "ac" ? "aca" : "dca";
    if (jack === "a") {
      // The 10A shunt. At µA its input is the µA mA jack, so it reads 0.
      return { fn, position, scale: position === "ma" ? "a" : "ua", element: shuntA, reads: position === "ma", inErr: false }; // prettier-ignore
    }
    if (jack === "ma") {
      const element = fused(position === "ma" ? METER_ELEMENTS.ma : METER_ELEMENTS.ua); // prettier-ignore
      return { fn, position, scale: position, element, reads: true, inErr: false }; // prettier-ignore
    }
    return { fn, position, scale: position === "ma" ? "ma" : "ua", element: null, reads: false, inErr: false }; // prettier-ignore
  }
  const fn =
    position === "autov"
      ? "autov"
      : position === "v"
        ? sel === "ac" ? "acv" : "dcv" // prettier-ignore
        : position === "mv"
          ? sel === "ac" ? "acmv" : "dcmv" // prettier-ignore
          : position === "ohm"
            ? sel === "cont" ? "cont" : "ohm" // prettier-ignore
            : sel === "cap" ? "cap" : "diode"; // prettier-ignore
  if (jack === "a") return { fn, position, scale: null, element: shuntA, reads: false, inErr }; // prettier-ignore
  if (jack === "ma") return { fn, position, scale: null, element: null, reads: false, inErr }; // prettier-ignore
  // The capacitance test's drive is its measurement's to set
  // (sim/meter-offline.js, `capDrive` on its own copy of the desk — never
  // the document's); with none it charges one way on its first range.
  const drive = params?.capDrive;
  const element =
    position === "autov"
      ? METER_ELEMENTS.autov
      : position === "ohm"
        ? METER_ELEMENTS.ohms
        : fn === "cap"
          ? capElement(drive?.range ?? 0, drive?.sign ?? 1)
          : position === "diode"
            ? METER_ELEMENTS.diode
            : METER_ELEMENTS.volts;
  return { fn, position, scale: null, element, reads: true, inErr };
}

/** Whether an element is a current shunt — what the logic engine, which has
    no voltages, joins the probes' nets through as a wire. */
export function isShunt(element) {
  return Boolean(element?.fuse);
}

/** Whether a function reads with its own test source (Ω, continuity,
    diode, capacitance): the ones a STOPPED bench still answers
    (sim/meter-offline.js). */
export function isSourceFunction(fn) {
  return fn === "ohm" || fn === "cont" || fn === "diode" || fn === "cap";
}

export const METER_DEF = Object.freeze({
  id: "meter",
  kind: "meter",
  title: "Multimeter",
  blurb:
    "A bench digital multimeter, modelled on the Brymen BM235: turn its " +
    "dial to volts, millivolts, AutoV, ohms (and continuity), diode test " +
    "(and capacitance) or a current range — Hz on any voltage or current — " +
    "and touch its two probes to any holes — on a lead or " +
    "beside it. It is a real meter, not an ideal one: on volts it puts " +
    "10 MΩ across what it measures, on AutoV 2.1 kΩ, on ohms a 1.6 V test " +
    "source. To measure a current, break the circuit, move the red lead to " +
    "the µA mA or 10A jack and put the probes in series — and never across " +
    "a supply: the mA input's 0.4 A fuse blows. A red lead in a current " +
    "jack with the dial on anything else shows InEr. Under Spice Lite only; " +
    "while stopped the bench is switched off, so ohms, continuity, diode " +
    "test and capacitance still read.",
  group: "Meters",
  // Not in the tray: the toolbar's multimeter segment takes one out onto the
  // desk, up to MAX_METERS (DeskController `addMeter`), and its own menu puts
  // it away (`putMeterAway`).
  trayless: true,
  // The logic engine has no voltages to read: the toolbar offers it only
  // while Spice Lite is on.
  spiceOnly: true,
  size: METER_SIZE,
  // No terminal takes a wire: the probes are the meter's connections.
  terminals: Object.freeze([]),
  properties: [
    {
      key: "skin",
      label: "Look",
      type: "segmented",
      default: "volthippo",
      options: [
        { value: "volthippo", label: "VoltHippo" },
        { value: "bm235", label: "EEVBlog" },
      ],
    },
    {
      key: "size",
      label: "Size",
      type: "segmented",
      default: "full",
      options: [
        { value: "full", label: "Full" },
        { value: "compact", label: "Compact" },
      ],
      // The other way to it, said where the choice is.
      note: "Click the title at the top of the meter to switch between Compact and Full.",
    },
    {
      key: "sound",
      label: "Sound",
      type: "segmented",
      options: [
        { value: "off", label: "Off" },
        { value: "on", label: "On" },
      ],
    },
  ],
  normalizeParams(raw) {
    const params = {
      dial: METER_POSITIONS.includes(raw?.dial) ? raw.dial : "v",
    };
    // SELECT's choice at each position, kept only where it is not the
    // position's first.
    const sel = {};
    for (const [position, list] of Object.entries(METER_SELECT)) {
      const chosen = raw?.sel?.[position];
      if (list.includes(chosen) && chosen !== list[0]) sel[position] = chosen;
    }
    if (Object.keys(sel).length) params.sel = sel;
    if (RED_JACKS.includes(raw?.jack) && raw.jack !== "v") params.jack = raw.jack; // prettier-ignore
    params.red = normalizeProbe(raw?.red, PROBE_REST.red);
    params.black = normalizeProbe(raw?.black, PROBE_REST.black);
    params.sound = raw?.sound === "on" ? "on" : "off";
    // The look, kept only when it is not the default.
    if (raw?.skin === "bm235") params.skin = "bm235";
    // Folded down, kept only when it is (the desk's, for the session: a
    // project file never holds it — model/meter-probes.js `meterForFile`).
    if (raw?.size === "compact") params.size = "compact";
    // A blown fuse is a run latch (catalog/run-latches.js): kept here, so the
    // run's write holds, and dropped on every road into a desk.
    return keepRunLatches(raw, params);
  },
});
