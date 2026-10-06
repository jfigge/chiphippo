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

// kicad-parts.js — what each catalog part BECOMES in KiCad: its footprint in
// KiCad's stock libraries, how its pins map onto that footprint's pads, the
// symbol shape it is drawn as, and the Value printed beside it.
//
// HAND-WRITTEN, NEVER GUESSED, like the datasheet download table: a footprint
// name that does not exist in KiCad's libraries is a PCB update that fails
// part by part. Every name below was checked against KiCad's own
// kicad-footprints repository, and so was every pad map that is not the
// identity — the LED's (KiCad numbers the CATHODE pad 1, the square one) and
// the oscillator cans' (a DIP-14 can's four legs are pins 1, 7, 8 and 14).
//
// A part with no honest footprint (our 9-pin 7-segment digit is an idealized
// part no manufacturer makes) gets a pin header of the right pitch and count,
// flagged `generic`, and the export report says so: the netlist is right and
// the PCB still needs the real part's footprint chosen.
//
// Every palette part must be covered, and tests/export-kicad.test.js holds the
// table to the catalog, so a new part fails a test instead of exporting
// without a footprint.

import { packageSpec } from "../footprints.js";
import { chipMarking } from "../../catalog/index.js";
import { formatComponentValueAscii } from "../component-value.js";
import { partNumberOf, transistorCase } from "../../catalog/discretes.js";
import { switchableOutputs } from "../spec-lint.js";
import { isAnalogSwitch } from "../../sim/chip-eval.js";

const HEADER = (n) =>
  `Connector_PinHeader_2.54mm:PinHeader_1x${String(n).padStart(2, "0")}_P2.54mm_Vertical`;

const DIP_SWITCH = {
  1: "SW_DIP_SPSTx01_Slide_9.78x4.72mm_W7.62mm_P2.54mm",
  2: "SW_DIP_SPSTx02_Slide_9.78x7.26mm_W7.62mm_P2.54mm",
  4: "SW_DIP_SPSTx04_Slide_9.78x12.34mm_W7.62mm_P2.54mm",
  8: "SW_DIP_SPSTx08_Slide_9.78x22.5mm_W7.62mm_P2.54mm",
};

const colour = (comp) => comp.params?.color ?? "";

/**
 * A component's value as its Value field says it: what the Properties combo
 * box shows (model/component-value.js), to the precision it was set to, in
 * plain ASCII — "4.7k", "100nF", "4.7uF", "10uH", "5.1V" — or "" with no
 * value to state.
 */
const valueOf = (comp, key, unit) =>
  formatComponentValueAscii(Number(comp.params?.[key]), unit);

/** A transistor's footprint by its package (catalog/discretes.js
    `transistorCase`): a TO-92 on 0.1 in — the pitch a breadboard bends its
    legs to — or a TO-220 standing up, whose legs already are. */
const TRANSISTOR_FOOTPRINTS = Object.freeze({
  "TO-92": "Package_TO_SOT_THT:TO-92_Inline_Wide",
  "TO-220": "Package_TO_SOT_THT:TO-220-3_Vertical",
});
const transistorFootprint = (comp, def) =>
  TRANSISTOR_FOOTPRINTS[transistorCase(def, comp?.params)];

/**
 * An inductor's footprint by which it is (catalog/discretes.js
 * `INDUCTOR_STYLES`) and the holes between its leads — 0.3 in (7.62 mm) or
 * 0.4 in (10.16 mm). A standing toroid has a footprint on exactly each pitch.
 * A radial drum does NOT: KiCad's round radial inductors are on metric
 * pitches, so it gets the nearest (7.00 and 10.00 mm), and the report says to
 * check it (`nearest`).
 */
const INDUCTOR_FOOTPRINTS = Object.freeze({
  coil: Object.freeze({
    2: "Inductor_THT:L_Toroid_Vertical_L16.0mm_W8.0mm_P7.62mm",
    3: "Inductor_THT:L_Toroid_Vertical_L26.7mm_W14.0mm_P10.16mm_Pulse_D",
  }),
  can: Object.freeze({
    2: "Inductor_THT:L_Radial_D12.5mm_P7.00mm_Fastron_09HCP",
    3: "Inductor_THT:L_Radial_D12.0mm_P10.00mm_Neosid_SD12_style1",
  }),
});
const isCan = (comp) => comp?.params?.style === "can";

/**
 * The non-chip parts. `footprint` is a library name — or a function of the
 * component and its def, for a part whose params choose it; `nearest`, where
 * present, says (of a component) that the footprint is only the closest the
 * library has, to be checked; `shape` picks the symbol drawing
 * (kicad-symbols.js); `pads` maps a port key onto a footprint pad where they
 * differ (absent = the pin number IS the pad); `value` is the text printed on
 * the sheet.
 */
export const KICAD_PARTS = Object.freeze({
  resistor: {
    footprint: "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal",
    shape: "resistor",
    value: (comp) => valueOf(comp, "ohms", "ohm") || "R",
  },
  // A Bourns 3296W: three pads in a row at 2.54 mm, the wiper in the middle,
  // numbered as ours are (1 · 2 wiper · 3) — so no pad map.
  pot: {
    footprint: "Potentiometer_THT:Potentiometer_Bourns_3296W_Vertical",
    shape: "potentiometer",
    value: (comp) => valueOf(comp, "ohms", "ohm") || "RV",
  },
  rnet9: {
    footprint: "Resistor_THT:R_Array_SIP9",
    shape: "box",
    value: (comp) => `${valueOf(comp, "ohms", "ohm")} ×8`.trim(),
  },
  // Capacitors carry their VALUE across — the reason a capacitor may sit
  // anywhere on the desk at all. Both sit in adjacent holes, so both take a
  // 2.50 mm-pitch footprint: a ceramic is KiCad's plain C on a 5 mm disc; an
  // electrolytic is C_Polarized on a 5 mm radial can, whose pad 1 — KiCad's
  // square one — is +, as our pin 1 is.
  "cap-ceramic": {
    footprint: "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P2.50mm",
    shape: "capacitor",
    value: (comp) => valueOf(comp, "farads", "farad") || "C",
  },
  "cap-electrolytic": {
    footprint: "Capacitor_THT:CP_Radial_D5.0mm_P2.50mm",
    shape: "capacitor-polarized",
    value: (comp) => valueOf(comp, "farads", "farad") || "C",
  },
  // The discretes. A semiconductor's Value is its part number (the
  // generic name until it has one); a passive's is its value. Any part
  // number also rides along as an MPN field (`kicadPart`'s `fields`), the
  // name KiCad's BOM tools read.
  //
  // A diode is a DO-35 on 0.3 in (7.62 mm), as the desk seats it, and KiCad
  // numbers its CATHODE 1 — symbol and footprint alike (the square pad, which
  // the footprint silkscreens K) — so our pin 2 is pad 1.
  diode: {
    footprint: "Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal",
    shape: "diode",
    pads: { 1: "2", 2: "1" },
    value: (comp) => partNumberOf(comp.params) ?? "D",
  },
  zener: {
    footprint: "Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal",
    shape: "zener",
    pads: { 1: "2", 2: "1" },
    value: (comp) =>
      [partNumberOf(comp.params), valueOf(comp, "zenerVolts", "volt")]
        .filter(Boolean)
        .join(" ") || "D_Zener",
  },
  // A toroid or a drum, on the pitch its leads were set to (above).
  inductor: {
    footprint: (comp) =>
      INDUCTOR_FOOTPRINTS[isCan(comp) ? "can" : "coil"][
        comp?.params?.bodyHoles === 3 ? 3 : 2
      ],
    nearest: isCan,
    shape: "inductor",
    value: (comp) =>
      valueOf(comp, "henries", "henry") || (partNumberOf(comp.params) ?? "L"),
  },
  // A TO-92 (or, for a MOSFET set to it, a TO-220) on 2.54 mm, its pads
  // numbered in the order the desk draws the pins (E·B·C, S·G·D). That is no
  // one maker's pinout — a 2N2222 is E·B·C, a BC547 C·B·E, an IRLZ44N G·D·S
  // — so the export does not pretend to know which this is: `pinOrder`
  // reports every one as a footprint to check.
  npn: {
    footprint: transistorFootprint,
    shape: "npn",
    pinOrder: true,
    value: (comp) => partNumberOf(comp.params) ?? "NPN",
  },
  pnp: {
    footprint: transistorFootprint,
    shape: "pnp",
    pinOrder: true,
    value: (comp) => partNumberOf(comp.params) ?? "PNP",
  },
  nmos: {
    footprint: transistorFootprint,
    shape: "nmos",
    pinOrder: true,
    value: (comp) => partNumberOf(comp.params) ?? "NMOS",
  },
  pmos: {
    footprint: transistorFootprint,
    shape: "pmos",
    pinOrder: true,
    value: (comp) => partNumberOf(comp.params) ?? "PMOS",
  },
  led: {
    footprint: "LED_THT:LED_D5.0mm",
    shape: "led",
    // KiCad's LED symbol and footprint both number the CATHODE 1. Which of our
    // two pins is the anode depends on the part's polarity (`flip`), so the
    // map is per part, resolved by `padsOf` below.
    value: (comp) => `LED ${colour(comp)}`.trim(),
  },
  "sw-slide": {
    footprint: "Button_Switch_THT:SW_Slide_SPDT_Straight_CK_OS102011MS2Q",
    shape: "spdt",
    value: () => "SPDT",
  },
  "sw-push": {
    footprint: "Button_Switch_THT:SW_PUSH_6mm",
    shape: "spst",
    value: () => "Push",
  },
  "sw-toggle": {
    footprint: "Button_Switch_THT:SW_PUSH_6mm",
    shape: "spst",
    generic: true, // a LATCHING button; the tactile footprint is only its size
    value: () => "Push (latching)",
  },
  "sw-dip1": {
    footprint: `Button_Switch_THT:${DIP_SWITCH[1]}`,
    shape: "box",
    value: () => "DIP switch ×1",
  },
  "sw-dip2": {
    footprint: `Button_Switch_THT:${DIP_SWITCH[2]}`,
    shape: "box",
    value: () => "DIP switch ×2",
  },
  "sw-dip4": {
    footprint: `Button_Switch_THT:${DIP_SWITCH[4]}`,
    shape: "box",
    value: () => "DIP switch ×4",
  },
  "sw-dip8": {
    footprint: `Button_Switch_THT:${DIP_SWITCH[8]}`,
    shape: "box",
    value: () => "DIP switch ×8",
  },
  seg8cc: {
    footprint: HEADER(9),
    shape: "box",
    generic: true,
    value: (comp) => `7-segment CC ${colour(comp)}`.trim(),
  },
  seg8ca: {
    footprint: HEADER(9),
    shape: "box",
    generic: true,
    value: (comp) => `7-segment CA ${colour(comp)}`.trim(),
  },
  bar8: {
    footprint: HEADER(9),
    shape: "box",
    generic: true,
    value: (comp) => `LED bar ×8 ${colour(comp)}`.trim(),
  },
  bar8iso: {
    footprint: "Package_DIP:DIP-16_W7.62mm",
    shape: "box",
    value: (comp) => `LED bar ×8 ${colour(comp)}`.trim(),
  },
  lcd16x2: {
    footprint: "Display:WC1602A",
    shape: "box",
    value: () => "LCD 16x2 (HD44780)",
  },
  lcd20x4: {
    footprint: HEADER(16),
    shape: "box",
    generic: true,
    value: () => "LCD 20x4 (HD44780)",
  },
  "osc-full": {
    footprint: "Oscillator:Oscillator_DIP-14",
    shape: "box",
    pads: { 1: "1", 2: "7", 3: "8", 4: "14" },
    value: (comp) => `${comp.params?.hz ?? ""} Hz`.trim(),
  },
  "osc-half": {
    footprint: "Oscillator:Oscillator_DIP-8",
    shape: "box",
    pads: { 1: "1", 2: "4", 3: "5", 4: "8" },
    value: (comp) => `${comp.params?.hz ?? ""} Hz`.trim(),
  },
  // The bench supply and the clock brick have no PART on a real board — they
  // are where power and a clock come IN. So each is a two-pin header.
  psu: {
    footprint: HEADER(2),
    shape: "box",
    pads: { "+": "1", "-": "2" },
    value: (comp) => `POWER ${comp.params?.volts ?? 5}V`,
  },
  clock: {
    footprint: HEADER(2),
    shape: "box",
    pads: { out: "1", gnd: "2" },
    value: () => "CLOCK IN",
  },
});

/** A DIP chip's footprint: its pin count and body width from footprints.js. */
export function chipFootprint(def) {
  const { pins, body } = packageSpec(def.package);
  return `Package_DIP:DIP-${pins}_W${body === 600 ? "15.24" : "7.62"}mm`;
}

/** Whether a catalog id has a KiCad mapping at all. */
export function kicadMapped(def) {
  return def.kind === "chip" ? Boolean(def.package) : def.id in KICAD_PARTS;
}

/**
 * Everything the writer needs about one part. `fields` are the extra
 * (hidden) properties its symbol instance carries — an MPN, for a part with a
 * part number; `pinOrder` marks a footprint whose pad order is the desk's
 * generic one, to be checked against the real part; `nearest` one that is
 * only the library's closest match.
 * @param {object} part - an ExportPart (export-netlist.js).
 * @returns {{ footprint:string, shape:string, value:string, generic:boolean,
 *   pinOrder:boolean, nearest:boolean, fields:Array<[string,string]>,
 *   pad:(key:string) => string }}
 */
export function kicadPart(part) {
  const { def, comp } = part;
  if (def.kind === "chip") {
    return {
      footprint: chipFootprint(def),
      shape: "box",
      // What is printed on it — a custom chip's part number, not its ref.
      value: chipMarking(def),
      generic: false,
      pinOrder: false,
      nearest: false,
      fields: [],
      pad: (key) => key,
    };
  }
  const spec = KICAD_PARTS[def.id];
  const partNumber = partNumberOf(comp?.params);
  return {
    footprint:
      typeof spec.footprint === "function"
        ? spec.footprint(comp, def)
        : spec.footprint,
    shape: spec.shape,
    value: spec.value ? spec.value(comp) : def.id,
    generic: spec.generic === true,
    pinOrder: spec.pinOrder === true,
    nearest: spec.nearest?.(comp) === true,
    fields: partNumber ? [["MPN", partNumber]] : [],
    pad: padsOf(def, comp, spec),
  };
}

function padsOf(def, comp, spec) {
  if (def.id === "led") {
    const { anodePin } = def.polarity(comp.params);
    return (key) => (Number(key) === anodePin ? "2" : "1");
  }
  if (spec.pads) return (key) => spec.pads[key] ?? key;
  return (key) => key;
}

/** A catalog pin role as a KiCad electrical pin type. */
export function pinType(def, port) {
  const role = port.role;
  if (role === "vcc" || role === "gnd") {
    // A bench supply's terminals are a connector's pins, not a power input.
    return def.kind === "psu" || def.kind === "clock" ? "passive" : "power_in";
  }
  if (def.kind === "chip" || def.id.startsWith("osc-")) {
    // (A timer's RC `timing` terminal falls through to PASSIVE below: it
    // drives nothing and reads nothing — it is where a resistor and a
    // capacitor connect.)
    if (role === "input") return "input";
    // An analog switch's terminal drives nothing — it is a conductor, which
    // is what KiCad's PASSIVE says (and it may then meet a rail without the
    // ERC calling it a fight).
    if (role === "io") return isAnalogSwitch(def) ? "passive" : "bidirectional";
    if (role === "nc") return "no_connect";
    if (role === "output") {
      return def.kind === "chip" && switchableOutputs(def).has(port.pin)
        ? "tri_state"
        : "output";
    }
  }
  if (def.id.startsWith("lcd")) {
    if (role === "input") return "input";
    if (role === "io") return "bidirectional";
  }
  return "passive";
}
