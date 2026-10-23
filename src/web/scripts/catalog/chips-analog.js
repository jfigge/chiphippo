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

// chips-analog.js — the op-amps and the comparator. A chip (a DIP, seated,
// powered and exported like one) in no logic family, shelved under CHIPS ▸
// Op-amps — the comparator beside them, since the catalog's Comparator group
// is the 74LS85's magnitude comparison, a logic part.
//
// Its units are analog: under Spice Lite each is a device of the voltage
// solve (spice/analog-devices.js "a": open-loop gain about the middle of its
// output swing, clamped to its supply less its headroom, behind its output
// resistance and short-circuit currents), so feedback does what it does on a
// bench — a follower follows, an amplifier amplifies — with nothing to
// recognise. The logic engine has no voltages: there a unit is a COMPARATOR
// on its inputs' levels — IN+ HIGH and IN− LOW drive OUT HIGH, the reverse
// LOW, anything else (equal, unknown) X. So an amplifier — its output fed
// back to IN− — reads X there, honestly: it is an analog part, and Spice
// Lite is where it works.
//
// The LM339's units are the same device with an OPEN-COLLECTOR output
// (`model.openCollector`): it sinks, to its saturation and its sink current,
// and never sources — HIGH is its transistor turned off, wherever a pull-up
// takes the pin (spice/analog-devices.js). To the logic engine its outputs are
// `openCollector` pins like a 74LS05's: a HIGH is no drive, so a pull-up
// decides it, and two tied together are a wired-AND.

import { input, output, gnd, vcc } from "./pin-builders.js";
import { H, L, X } from "../sim/levels.js";

/** A comparator on two levels: IN+ over IN−. */
const compare = ([plus, minus]) =>
  plus === H && minus === L ? H : plus === L && minus === H ? L : X;

/** One unit as the logic engine runs it. */
const unitOf = ({ out, inp, inn }) => ({
  fn: "COMB",
  inputs: [inp, inn],
  output: out,
  compute: compare,
});

/** The LM358's units (TI SLOS068): 1OUT 1, 1IN− 2, 1IN+ 3; 2IN+ 5, 2IN− 6,
    2OUT 7. */
const LM358_UNITS = Object.freeze([
  Object.freeze({ out: 1, inn: 2, inp: 3 }),
  Object.freeze({ out: 7, inn: 6, inp: 5 }),
]);

/** The LM339's units (TI SLCS006Z Figure 5-1, the N package): 1OUT 1,
    1IN− 6, 1IN+ 7; 2OUT 2, 2IN− 4, 2IN+ 5; 3OUT 14, 3IN− 8, 3IN+ 9; 4OUT 13,
    4IN− 10, 4IN+ 11. */
const LM339_UNITS = Object.freeze([
  Object.freeze({ out: 1, inn: 6, inp: 7 }),
  Object.freeze({ out: 2, inn: 4, inp: 5 }),
  Object.freeze({ out: 14, inn: 8, inp: 9 }),
  Object.freeze({ out: 13, inn: 10, inp: 11 }),
]);

export const CHIPS_ANALOG = Object.freeze([
  {
    // TI SLOS068 (LM158/LM258/LM358/LM2904): its typicals at 25 °C — AVD
    // 100 V/mV; VOH VCC − 1.5 V; VOL 5 mV; output source 30 mA, sink 20 mA
    // (§6.5, VCC 15 V). 3–32 V single supply.
    id: "LM358",
    title: "Dual op-amp",
    blurb:
      "Two op-amps that run from one supply (3–32 V): inputs work down to " +
      "GND, and the output swings from GND to about 1.5 V below VCC. Wire " +
      "it as a follower, an amplifier or a comparator — under Spice Lite " +
      "it does what its feedback makes it, the output a voltage anywhere in " +
      "its swing, sourcing up to about 30 mA and sinking 20 mA. The logic " +
      "engine runs each unit as a comparator only (IN+ HIGH and IN− LOW → " +
      "OUT HIGH, the reverse LOW, anything else unknown), so an amplifier " +
      "needs Spice Lite.",
    group: "Op-amps",
    package: "DIP-8",
    supply: Object.freeze({ min: 3, max: 32 }),
    // A floating input is anybody's guess, never a TTL input's HIGH.
    floating: "unknown",
    opAmps: Object.freeze({
      units: LM358_UNITS,
      model: Object.freeze({
        gain: 1e5,
        rOut: 20,
        lowV: 0.005,
        headroomV: 1.5,
        sourceA: 0.03,
        sinkA: 0.02,
      }),
    }),
    pins: [
      output(1, "1OUT"),
      input(2, "1IN-"),
      input(3, "1IN+"),
      gnd(4, "GND"),
      input(5, "2IN+"),
      input(6, "2IN-"),
      output(7, "2OUT"),
      vcc(8, "VCC"),
    ],
    logic: {
      units: LM358_UNITS.map(unitOf),
      // Its inputs draw nothing worth a stage (45 nA bias), and take any
      // voltage between its rails (spice/params.js `pinInputStages`).
      inputs: Object.fromEntries(
        LM358_UNITS.flatMap((u) => [u.inp, u.inn]).map((pin) => [
          pin,
          () => [],
        ]),
      ),
    },
  },
  {
    // TI SLCS006Z (LM139…LM339, LM2901), §6.10 at 25 °C, VCC 5 V: AVD
    // 200 V/mV typ; VOL 150 mV typ at IOL 4 mA; IOL 16 mA typ at VOL 1.5 V;
    // IOH 0.1 nA (off — none here); ICC 0.8 mA typ for all four, "independent
    // of the supply voltage". 2–36 V single supply.
    id: "LM339",
    title: "Quad comparator",
    blurb:
      "Four voltage comparators that run from one supply (2–36 V), each " +
      "output an OPEN COLLECTOR: it pulls LOW (sinking up to about 16 mA) " +
      "while IN− is above IN+, and lets go otherwise — so every output " +
      "needs a pull-up resistor, to its own supply or any other up to 36 V, " +
      "and outputs tied together are a wired-AND (a window comparator). " +
      "Inputs work down to GND. Under Spice Lite each unit compares the " +
      "voltages on its inputs; the logic engine compares their levels (IN+ " +
      "HIGH and IN− LOW → released, the reverse LOW, anything else unknown).",
    group: "Op-amps",
    package: "DIP-14",
    supply: Object.freeze({ min: 2, max: 36 }),
    floating: "unknown",
    openCollector: Object.freeze(LM339_UNITS.map((u) => u.out)),
    opAmps: Object.freeze({
      units: LM339_UNITS,
      model: Object.freeze({
        gain: 2e5,
        // VOL = lowV + IOL·rOut: 50 mV at no load, 150 mV at 4 mA (the
        // sheet's typical), the sink limit reached at 0.45 V — DERIVED from
        // the sheet's two points, an assumption between them.
        rOut: 25,
        lowV: 0.05,
        // The top of the swing its gain is centred in: its supply, where a
        // pull-up to VCC takes an output it has let go. It is no clamp — an
        // open collector's HIGH is wherever its pull-up puts it.
        headroomV: 0,
        openCollector: true,
        sourceA: 0,
        sinkA: 0.016,
      }),
    }),
    pins: [
      output(1, "1OUT"),
      output(2, "2OUT"),
      vcc(3, "VCC"),
      input(4, "2IN-"),
      input(5, "2IN+"),
      input(6, "1IN-"),
      input(7, "1IN+"),
      input(8, "3IN-"),
      input(9, "3IN+"),
      input(10, "4IN-"),
      input(11, "4IN+"),
      gnd(12, "GND"),
      output(13, "4OUT"),
      output(14, "3OUT"),
    ],
    logic: {
      units: LM339_UNITS.map(unitOf),
      inputs: Object.fromEntries(
        LM339_UNITS.flatMap((u) => [u.inp, u.inn]).map((pin) => [
          pin,
          () => [],
        ]),
      ),
      // ICC 0.8 mA typ, the four comparators, whatever the supply.
      iccMa: () => 0.8,
    },
  },
]);
