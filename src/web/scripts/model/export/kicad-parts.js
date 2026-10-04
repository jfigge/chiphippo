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
import { formatOhms } from "../ohm-format.js";
import { formatFaradsAscii } from "../farad-format.js";
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

/** A capacitor's Value: "100nF", "4.7uF" — or "" with no value to state. */
const capValue = (comp) => {
  const v = formatFaradsAscii(Number(comp.params?.farads));
  return v ? `${v}F` : "";
};

/**
 * The non-chip parts. `shape` picks the symbol drawing (kicad-symbols.js);
 * `pads` maps a port key onto a footprint pad where they differ (absent =
 * the pin number IS the pad); `value` is the text printed on the sheet.
 */
export const KICAD_PARTS = Object.freeze({
  resistor: {
    footprint: "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal",
    shape: "resistor",
    value: (comp) => formatOhms(comp.params?.ohms) || "R",
  },
  rnet9: {
    footprint: "Resistor_THT:R_Array_SIP9",
    shape: "box",
    value: (comp) => `${formatOhms(comp.params?.ohms)} ×8`.trim(),
  },
  // Capacitors carry their VALUE across — the reason a capacitor may sit
  // anywhere on the desk at all. Both sit in adjacent holes, so both take a
  // 2.50 mm-pitch footprint: a ceramic is KiCad's plain C on a 5 mm disc; an
  // electrolytic is C_Polarized on a 5 mm radial can, whose pad 1 — KiCad's
  // square one — is +, as our pin 1 is. The Value says the unit in ASCII
  // ("4.7uF"), for whatever BOM script reads it.
  "cap-ceramic": {
    footprint: "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P2.50mm",
    shape: "capacitor",
    value: (comp) => capValue(comp) || "C",
  },
  "cap-electrolytic": {
    footprint: "Capacitor_THT:CP_Radial_D5.0mm_P2.50mm",
    shape: "capacitor-polarized",
    value: (comp) => capValue(comp) || "C",
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
 * Everything the writer needs about one part.
 * @param {object} part - an ExportPart (export-netlist.js).
 * @returns {{ footprint:string, shape:string, value:string, generic:boolean,
 *   pad:(key:string) => string }}
 */
export function kicadPart(part) {
  const { def, comp } = part;
  if (def.kind === "chip") {
    return {
      footprint: chipFootprint(def),
      shape: "box",
      value: def.id,
      generic: false,
      pad: (key) => key,
    };
  }
  const spec = KICAD_PARTS[def.id];
  return {
    footprint: spec.footprint,
    shape: spec.shape,
    value: spec.value ? spec.value(comp) : def.id,
    generic: spec.generic === true,
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
