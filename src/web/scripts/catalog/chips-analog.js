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

// chips-analog.js — the op-amps. A chip (a DIP-8, seated, powered and
// exported like one) in no logic family, shelved under CHIPS ▸ Op-amps.
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
]);
