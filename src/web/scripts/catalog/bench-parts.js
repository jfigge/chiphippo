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

// bench-parts.js — the bench parts beside the chips: the linear regulators
// (a 78xx's fixed output, an LM317's set by two resistors), the 5 V / 12 V
// relay, and the electronic load brick. Pure data and pure functions, as the
// rest of the catalog is; what each does under Spice Lite is spice/analog-
// devices.js (a regulator, a load) and the relay's coil an inductor
// (spice/inductors.js) with its contacts a switch its coil's CURRENT closes
// (spice/engine.js `syncRelays`).

import { H, L } from "../sim/levels.js";
import { valueField } from "./value-fields.js";
import { storedValue } from "./value-fields.js";
import { formatComponentValue } from "../model/component-value.js";

/** A regulator's figures, one common set for the 78xx line and one for the
    LM317 (TI SNOSBT0 LM340/LM7805, SLVS044 LM317): dropout 2 V and 1.7 V;
    the current limit both are good for, 1.5 A; load regulation a few mV over
    an amp (0.01 Ω); a 78xx's 5 mA quiescent current to GND, an LM317's
    50 µA out of ADJ. */
const FIXED = Object.freeze({ dropoutV: 2, limitA: 1.5, rOut: 0.01, quiescentA: 0.005 }); // prettier-ignore
const ADJUSTABLE = Object.freeze({ vref: 1.25, dropoutV: 1.7, limitA: 1.5, rOut: 0.01, quiescentA: 50e-6 }); // prettier-ignore

/** What a linear regulator dissipates before it warns, and before it shuts
    down, standing in free air with no heatsink (a TO-220 at RθJA ≈ 50 °C/W:
    about 2 W lifts its junction past 125 °C, where its thermal shutdown
    trips), watts. */
export const REGULATOR_HEAT = Object.freeze({ warnW: 1, shutdownW: 2 });

/** The LM317's reference, volts, and ADJ current, amps — what its two
    resistors set its output from (sim/regulators.js `regulatorVolts`). */
export const LM317 = Object.freeze({ vref: ADJUSTABLE.vref, adjA: ADJUSTABLE.quiescentA }); // prettier-ignore

/** What every regulator's blurb says about its two engines. */
const REGULATOR_NOTE =
  "Under Spice Lite it holds its output until its input comes within its " +
  "dropout, gives up to 1.5 A and droops past it, and burns the difference " +
  "between input and output as heat: past 1 W it is hot, past 2 W (no " +
  "heatsink) it shuts down until it cools. The logic engine makes its " +
  "output a supply whenever its input is one high enough.";

/** A fixed 78xx regulator: TO-220, IN · GND · OUT (pins 1–3, front view,
    leads down). */
const fixedRegulator = (volts) => ({
  id: `LM78${String(volts).padStart(2, "0")}`,
  kind: "discrete",
  title: `${volts} V regulator`,
  blurb:
    `A ${volts} V linear regulator (78${String(volts).padStart(2, "0")}) in ` +
    "a TO-220, its legs IN · GND · OUT from the left with the printed face " +
    `toward you. Feed IN at least ${volts + FIXED.dropoutV} V, tie GND to the ` +
    `supply's −, and OUT is a ${volts} V rail. ` +
    REGULATOR_NOTE,
  group: "Regulators",
  footprint: Object.freeze({ offsets: Object.freeze([0, 1, 2]) }),
  reversible: true,
  pins: [
    { n: 1, name: "IN", role: "lead" },
    { n: 2, name: "GND", role: "lead" },
    { n: 3, name: "OUT", role: "lead" },
  ],
  regulator: Object.freeze({
    adjustable: false,
    volts,
    pins: Object.freeze({ inp: 1, ref: 2, out: 3 }),
    model: () => ({ ...FIXED, vref: volts }),
  }),
  normalizeParams(raw) {
    return raw?.rot === 180 ? { rot: 180 } : {};
  },
  internalBridges() {
    return [];
  },
});

/** The LM317: TO-220, ADJ · OUT · IN. Its output is 1.25 V above ADJ: two
    resistors set it — R1 from OUT to ADJ, R2 from ADJ to GND, Vout =
    1.25 V × (1 + R2 / R1). */
const ADJUSTABLE_REGULATOR = {
  id: "LM317",
  kind: "discrete",
  title: "Adjustable regulator",
  blurb:
    "The LM317 adjustable linear regulator in a TO-220, its legs ADJ · OUT " +
    "· IN from the left with the printed face toward you. It holds OUT " +
    "1.25 V above ADJ: put R1 (240 Ω is usual) from OUT to ADJ and R2 from " +
    "ADJ to GND, and OUT is 1.25 V × (1 + R2 / R1) — 3.3 V with 240 Ω and " +
    "390 Ω. Feed IN at least " +
    `${ADJUSTABLE.dropoutV} V above that. ` +
    REGULATOR_NOTE,
  group: "Regulators",
  footprint: Object.freeze({ offsets: Object.freeze([0, 1, 2]) }),
  reversible: true,
  pins: [
    { n: 1, name: "ADJ", role: "lead" },
    { n: 2, name: "OUT", role: "lead" },
    { n: 3, name: "IN", role: "lead" },
  ],
  regulator: Object.freeze({
    adjustable: true,
    pins: Object.freeze({ inp: 3, ref: 1, out: 2 }),
    model: () => ADJUSTABLE,
  }),
  normalizeParams(raw) {
    return raw?.rot === 180 ? { rot: 180 } : {};
  },
  internalBridges() {
    return [];
  },
};

export const REGULATOR_DEFS = Object.freeze(
  [...[5, 9, 12, 15].map(fixedRegulator), ADJUSTABLE_REGULATOR].map(
    Object.freeze,
  ),
);

/** The relay's coil voltages: each its Songle SRD-xxVDC-SL-C coil's
    resistance (70 Ω at 5 V, 400 Ω at 12 V) and an inductance putting its
    L/R near 2 ms (an assumption: the sheet states none). */
export const RELAY_COILS = Object.freeze({
  5: Object.freeze({ ohms: 70, henries: 0.14 }),
  12: Object.freeze({ ohms: 400, henries: 0.8 }),
});

/** A relay's contacts: the sheet's 100 mΩ max contact resistance, rated 10 A
    — warned past it, never smoke (contacts pit and weld; a part with no
    supply has no status to latch, as a transistor has none). Under Spice
    Lite they move with the COIL'S CURRENT: pulled in at 75 % of its rated
    current, let go below 10 % (the sheet's must-operate and must-release
    voltages, across the coil's own resistance — spice/engine.js). */
export const RELAY_CONTACTS = Object.freeze({
  ohms: 0.1,
  limits: Object.freeze({ warnMa: 10000, smokeMa: Number.POSITIVE_INFINITY }),
  pullIn: 0.75,
  dropOut: 0.1,
});

const RELAY_PIN = Object.freeze({ COIL1: 1, COIL2: 2, COM: 3, NO: 4, NC: 5 });

/** The coil's voltage as the relay's contacts read it: energized while one
    coil pin reads HIGH and the other LOW, either way round (a coil has no
    polarity); a coil nothing drives is not. */
const energized = ([a, b]) => (a === H && b === L) || (a === L && b === H);

/** A relay's coil voltage, volts, from its params. */
export const relayCoilVolts = (params) => (Number(params?.coilVolts) === 12 ? 12 : 5); // prettier-ignore

export const RELAY_DEF = Object.freeze({
  id: "relay",
  kind: "discrete",
  title: "Relay (SPDT)",
  blurb:
    "A 5 V (or 12 V) SPDT relay, the blue-cube kind (Songle SRD-05VDC-SL-C): " +
    "its five legs in a row — COIL+, COIL−, COM, NO, NC. Current through " +
    "the coil pulls COM from NC over to NO; take it away and COM falls back to " +
    "NC. The coil has no polarity, and draws about 70 mA at 5 V (30 mA at " +
    "12 V) — more than a logic output gives, so drive it through a " +
    "transistor or a ULN2003A, with a diode across the coil to catch the " +
    "kick when it lets go. Under Spice Lite the coil is an inductor (about " +
    "2 ms to build its current): it pulls in once that current reaches 75 % " +
    "of its rating and lets go below 10 % — a little late with a diode " +
    "across it, which keeps the current going — and switched off with " +
    "nowhere for its current to go it kicks. The logic " +
    "engine closes COM–NO while one coil leg is HIGH and the other LOW.",
  group: "Relays",
  footprint: Object.freeze({ offsets: Object.freeze([0, 1, 2, 3, 4]) }),
  pins: [
    // COIL+ and COIL− as the request and the sheet's symbol name them —
    // though the coil has no polarity, and either way round works.
    { n: RELAY_PIN.COIL1, name: "COIL+", role: "input" },
    { n: RELAY_PIN.COIL2, name: "COIL-", role: "input" },
    { n: RELAY_PIN.COM, name: "COM", role: "io" },
    { n: RELAY_PIN.NO, name: "NO", role: "io" },
    { n: RELAY_PIN.NC, name: "NC", role: "io" },
  ],
  // A coil leg nothing drives reads undefined, never a TTL input's HIGH.
  floating: "unknown",
  // Its coil, under Spice Lite: an inductor between its two coil legs
  // (spice/inductors.js), its winding the coil's resistance.
  coil: Object.freeze({
    a: RELAY_PIN.COIL1,
    b: RELAY_PIN.COIL2,
    volts: relayCoilVolts,
    henries: (params) => RELAY_COILS[relayCoilVolts(params)].henries,
    ohms: (params) => RELAY_COILS[relayCoilVolts(params)].ohms,
  }),
  // Its contacts' resistance and rating, in place of an analog switch's
  // (spice/output-stage.js `channelOhms`, spice/voltages.js).
  contacts: RELAY_CONTACTS,
  properties: [
    {
      key: "coilVolts",
      label: "Coil voltage",
      type: "select",
      default: 5,
      options: [5, 12].map((v) => ({ value: v, label: `${v} V` })),
    },
  ],
  normalizeParams(raw) {
    return relayCoilVolts(raw) === 12 ? { coilVolts: 12 } : {};
  },
  internalBridges() {
    return [];
  },
  logic: {
    channels: [
      { a: RELAY_PIN.COM, b: RELAY_PIN.NO, inputs: [1, 2], on: (lv) => (energized(lv) ? H : L) }, // prettier-ignore
      { a: RELAY_PIN.COM, b: RELAY_PIN.NC, inputs: [1, 2], on: (lv) => (energized(lv) ? L : H) }, // prettier-ignore
    ],
  },
});

/** The electronic load's ranges: 1 mA–5 A constant current, 0.1 Ω–100 kΩ
    constant resistance. */
const LOAD_AMPS = Object.freeze({ min: 0.001, max: 5 });
const LOAD_OHMS = Object.freeze({ min: 0.1, max: 100e3 });
export const LOAD_DEFAULTS = Object.freeze({ mode: "cc", amps: 0.1, ohms: 100 }); // prettier-ignore

/** What a load's badge says — on the desk and in the 3D view: its mode and
    its setting, unit symbols only. */
export function loadBadge(params) {
  const { mode, amps, ohms } = LOAD_DEF.normalizeParams(params);
  return mode === "cr"
    ? `CR ${formatComponentValue(ohms, "ohm") || "?"}`
    : `CC ${formatComponentValue(amps, "amp") || "?"}`;
}

/** What an electronic load may dissipate before it warns, watts. */
export const LOAD_RATED_W = 25;

export const LOAD_DEF = Object.freeze({
  id: "load",
  kind: "load",
  title: "Electronic load",
  blurb:
    "A bench electronic load: wire its + and − across a supply, a rail or a " +
    "regulator's output to draw a current from it on purpose — and watch a " +
    "supply droop, a regulator hold or drop out, or a rail brown out. " +
    "Constant current (CC) draws its set current whatever the voltage, " +
    "until the voltage is too low to (UNREG); constant resistance (CR) is " +
    "the resistor you set. It shows the volts, amps and watts while the " +
    "circuit runs (Spice Lite) and warns past 25 W. The logic engine has no " +
    "currents: there it does nothing.",
  group: "Power",
  size: Object.freeze({ width: 8, height: 5 }),
  terminals: [
    { id: "pos", dx: 2, dy: 4 },
    { id: "neg", dx: 6, dy: 4 },
  ],
  properties: [
    {
      key: "mode",
      label: "Mode",
      type: "segmented",
      options: [
        { value: "cc", label: "CC" },
        { value: "cr", label: "CR" },
      ],
    },
    {
      ...valueField({
        key: "amps",
        label: "Current",
        unit: "amp",
        range: LOAD_AMPS,
        values: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
      }),
      disabledWhen: (values) => values?.mode === "cr",
    },
    {
      ...valueField({
        key: "ohms",
        label: "Resistance",
        unit: "ohm",
        range: LOAD_OHMS,
        values: [1, 5, 10, 47, 100, 470, 1000],
      }),
      disabledWhen: (values) => values?.mode !== "cr",
    },
  ],
  normalizeParams(raw) {
    return {
      mode: raw?.mode === "cr" ? "cr" : "cc",
      amps: storedValue(raw?.amps, "amp", LOAD_DEFAULTS.amps),
      ohms: storedValue(raw?.ohms, "ohm", LOAD_DEFAULTS.ohms),
    };
  },
});
