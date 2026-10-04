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
// FAMILY-LESS, and it is shelved under COMPONENTS ▸ Oscillators beside the
// crystal cans rather than under CHIPS: it is the part a bench reaches for to
// make a clock, which is where someone looking for one will look. Its
// behaviour — how it reads its configuration off the wiring, and the
// datasheet formulas — is sim/timer-555.js.

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
    group: "Oscillators",
    package: "DIP-8",
    // SLFS022K: VCC 4.5 V to 16 V for the NA/NE/SA555 (the SE555's 18 V is
    // the military grade). Not a logic family's envelope, so the part states
    // its own (catalog/families.js `supplyRange`).
    supply: Object.freeze({ min: 4.5, max: 16 }),
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
