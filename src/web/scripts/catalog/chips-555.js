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

// chips-555.js — the 555 timer. A chip (an IC on a DIP-8, seated, powered and
// exported like one) but neither a 74LS nor a CD4000 part, so it is
// FAMILY-LESS, and it is shelved under CHIPS ▸ Timer — the group the CD4000
// RC timers use, so a CD4000 tray lists all four timers together, while a
// 74LS or Combined tray shows the 555's Timer straight under CHIPS beside the
// other family-less groups. Its behaviour — how it reads its configuration
// off the wiring, and the datasheet formulas — is sim/timer-555.js.

import { input, output, timing, gnd, vcc } from "./pin-builders.js";
import { ne555Logic } from "../sim/timer-555.js";

export const CHIPS_555 = Object.freeze([
  {
    // SLFS022K (NA555/NE555/SA555/SE555), Table 4-1 pin functions (P package).
    id: "NE555",
    title: "555 timer",
    blurb:
      "The 555 precision timer. It works out what it is from its wiring, " +
      "exactly as the real part does — there is no mode to set. ASTABLE: tie " +
      "TRIG (2) to THRES (6), a capacitor from there to GND, RB from DISCH " +
      "(7) to that capacitor and RA from DISCH to VCC; it oscillates at " +
      "1.44 / ((RA + 2·RB)·C). MONOSTABLE: tie THRES to DISCH, a capacitor " +
      "from there to GND and RA to VCC; a LOW on TRIG starts a 1.1·RA·C " +
      "pulse. BISTABLE: tie THRES to GND; a LOW on TRIG latches OUT HIGH " +
      "until RESET (4) goes LOW. Anything else it reports rather than " +
      "guesses. RESET LOW forces OUT LOW in every mode — tie it to VCC when " +
      "unused. CONT (5) is not modelled; a capacitor from it to GND is the " +
      "usual thing. Runs from 4.5–16 V.",
    group: "Timer",
    package: "DIP-8",
    // SLFS022K: VCC 4.5 V to 16 V for the NA/NE/SA555 (the SE555's 18 V is
    // the military grade). Not a logic family's envelope, so the part states
    // its own (catalog/families.js `supplyRange`).
    supply: Object.freeze({ min: 4.5, max: 16 }),
    // Its OUT is a bipolar totem pole good for 200 mA, which Spice Lite's
    // LED currents read (sim/spice/output-stage.js). SLFS022K Fig. 5-4: the
    // HIGH drops 1.3 V at 1 mA and ~1.6 V at 100 mA below VCC (§5.5: 13.3 V
    // typ at VCC 15 V, IOH −100 mA) — 1.35 V behind 3.5 Ω. Figs. 5-1/5-3:
    // the LOW is ~7.5 Ω (§5.5: 0.1 V at 10 mA, 0.4 V at 50 mA, VCC 15 V) and
    // saturates near 55 mA at VCC 5 V (Fig. 5-1's knee) and past 100 mA at
    // 15 V.
    outputStage: Object.freeze({
      high: Object.freeze({ volts: (vcc) => vcc - 1.35, ohms: 3.5 }),
      low: Object.freeze({
        volts: 0,
        ohms: 7.5,
        limitMa: Object.freeze([
          Object.freeze([5, 55]),
          Object.freeze([15, 110]),
        ]),
      }),
    }),
    pins: [
      gnd(1, "GND"),
      input(2, "TRIG"),
      output(3, "OUT"),
      input(4, "RESET"),
      timing(5, "CONT"),
      timing(6, "THRES"),
      timing(7, "DISCH"),
      vcc(8, "VCC"),
    ],
    logic: ne555Logic(),
  },
]);
