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

// spice/bench-warnings.js — what the regulators and the electronic loads say
// as a tick ends (spice/voltages.js `report().analog`): each one's reading
// for its brick or its hover, and the warnings — a regulator in dropout, at
// its current limit, hot, or shut down hot; a load past its rating. Pure.
//
// A regulator past `REGULATOR_HEAT.shutdownW` trips its thermal shutdown:
// off (spice/voltages.js `setThermal`) from `TRIP_S` on, for `COOL_S`, then
// on again — and off again if nothing changed, the cycling a real one does
// with no heatsink.

import { LOAD_RATED_W, REGULATOR_HEAT } from "../../catalog/bench-parts.js";

/** How long a regulator shut down hot stays off, seconds: a TO-220's own
    thermal time constant in free air is tens of seconds; a second keeps the
    cycling visible on a desk. An assumption. */
export const COOL_S = 1;

/** How soon a regulator that has just tripped goes off, seconds. */
export const TRIP_S = 1e-3;

/**
 * Each bench device's reading and warnings, and whether a regulator tripped
 * (now in `thermal`, comp → the moment it has cooled).
 * @param {Map<string, object>|undefined} analog - comp → its report entry
 * @param {Map<string, number>} thermal - updated in place
 * @param {number} now - seconds
 * @returns {{readings: Map, warnings: object[], tripped: boolean}}
 */
export function benchWarnings(analog, thermal, now) {
  const readings = new Map();
  const warnings = [];
  let tripped = false;
  for (const [comp, a] of analog ?? []) {
    if (a.kind === "load") {
      readings.set(comp, { volts: a.volts, amps: a.amps, watts: a.watts, unreg: a.unreg }); // prettier-ignore
      if (a.watts > LOAD_RATED_W) {
        warnings.push({ type: "load-power", comp, watts: a.watts, limit: LOAD_RATED_W }); // prettier-ignore
      }
      continue;
    }
    if (a.kind !== "regulator") continue;
    const off = a.off || thermal.has(comp);
    readings.set(comp, { volts: a.volts, amps: a.amps, watts: a.watts, dropout: a.dropout, limited: a.limited, off }); // prettier-ignore
    if (off) {
      warnings.push({ type: "regulator-shutdown", comp, watts: REGULATOR_HEAT.shutdownW }); // prettier-ignore
      continue;
    }
    if (a.watts > REGULATOR_HEAT.shutdownW) {
      thermal.set(comp, now + TRIP_S + COOL_S);
      tripped = true;
      warnings.push({ type: "regulator-shutdown", comp, watts: a.watts });
      continue;
    }
    if (a.watts > REGULATOR_HEAT.warnW) {
      warnings.push({ type: "regulator-hot", comp, watts: a.watts, limit: REGULATOR_HEAT.warnW }); // prettier-ignore
    }
    if (a.limited) {
      warnings.push({ type: "regulator-limit", comp, amps: a.amps });
    } else if (a.dropout) {
      warnings.push({ type: "regulator-dropout", comp, volts: a.volts });
    }
  }
  return { readings, warnings, tripped };
}
