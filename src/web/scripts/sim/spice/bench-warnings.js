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
// its current limit, hot, shut down hot, or with its GND wired to nothing; a
// load past its rating. Pure.
//
// A regulator's junction HEATS: what it dissipates is followed by its HEAT
// (the watts whose steady state its junction stands at), a first-order lag of
// `HEAT_TAU_S`. Past `REGULATOR_HEAT.shutdownW` of heat its thermal shutdown
// trips: off (spice/voltages.js `setThermal`) from `TRIP_S` on, for `COOL_S`,
// then on again — and off again if nothing changed, the cycling a real one
// does with no heatsink. A burst — charging a big output capacitor at its
// current limit — heats it hardly at all, as on the bench (an instant trip
// at 2 W shut a 7805 down the moment a 10 mF capacitor was on its output).

import { LOAD_RATED_W, REGULATOR_HEAT } from "../../catalog/bench-parts.js";

/** How long a regulator shut down hot stays off, seconds: a TO-220's own
    thermal time constant in free air is tens of seconds; a second keeps the
    cycling visible on a desk. An assumption. */
export const COOL_S = 1;

/** How soon a regulator that has just tripped goes off, seconds. */
export const TRIP_S = 1e-3;

/** A regulator's thermal time constant, seconds: a TO-220 in free air
    (RθJA ≈ 50 °C/W against roughly a fifth of a joule per kelvin of die,
    tab and plastic). A short at 15 W trips in about 1.4 s, 5 W in about
    5 s. An assumption. */
export const HEAT_TAU_S = 10;

/** The longest stretch a heating regulator's heat is read across, seconds:
    its watts are known only at ticks, so a quiet board (a regulator that has
    just finished charging its output capacitor, nothing else to wake it) is
    woken this often while it heats, rather than booked at the power of one
    instant all the way to a shutdown it never earned. */
export const HEAT_STEP_S = 0.5;

/** How soon a regulator first seen past its warning figure is read again,
    seconds: "hot" is said only at two ticks running (below), and on a desk
    nothing else ticks there was never a second — a 7805 burning 1.5 W in
    free air said nothing for good. */
export const HOT_RECHECK_S = 0.1;

/** A regulator's heat, watts, `dt` seconds on from `heat`, having
    dissipated `watts` meanwhile. */
export function heatAfter(heat, watts, dt) {
  return watts + (heat - watts) * Math.exp(-dt / HEAT_TAU_S);
}

/** How long, seconds, from `heat` dissipating `watts`, until the heat
    reaches its shutdown — Infinity if it never will. */
export function tripIn(heat, watts) {
  const at = REGULATOR_HEAT.shutdownW;
  if (!(watts > at)) return Infinity;
  if (heat >= at) return 0;
  return HEAT_TAU_S * Math.log((watts - heat) / (watts - at));
}

/**
 * Each bench device's reading and warnings, whether a regulator tripped (now
 * in `thermal`, comp → the moment it has cooled), and when the next will at
 * the power each now dissipates (`tripAt`, a wake).
 * @param {Map<string, object>|undefined} analog - comp → its report entry
 * @param {Map<string, number>} thermal - updated in place
 * @param {number} now - seconds
 * @param {Map<string, {heat: number, watts: number, at: number}>} [heats] -
 *   each regulator's heat as its last tick left it, and what it was then
 *   dissipating; updated in place
 * @returns {{readings: Map, warnings: object[], tripped: boolean, tripAt: number|null}}
 */
export function benchWarnings(analog, thermal, now, heats = new Map()) {
  const readings = new Map();
  const warnings = [];
  let tripped = false;
  let tripAt = null;
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
    readings.set(comp, { volts: a.volts, amps: a.amps, watts: a.watts, dropout: a.dropout, limited: a.limited, off, open: Boolean(a.open) }); // prettier-ignore
    // Its heat now: what it dissipated since its last tick — the mean of its
    // watts there and here — lagged.
    const was = heats.get(comp);
    // (A stretch it spent shut down is booked at nothing: back on, the mean
    // of nothing and its first watts over the whole second it cooled put it
    // straight back past its shutdown — on for a millisecond a second.)
    const mean = was?.off ? 0 : ((was?.watts ?? 0) + (off ? 0 : a.watts)) / 2;
    const heat = was ? heatAfter(was.heat, mean, Math.max(0, now - was.at)) : 0; // prettier-ignore
    heats.set(comp, { heat, watts: off ? 0 : a.watts, at: now, off });
    if (off) {
      warnings.push({ type: "regulator-shutdown", comp, watts: REGULATOR_HEAT.shutdownW }); // prettier-ignore
      continue;
    }
    // (A wake timed to the trip lands on it to the last few ulps.)
    if (heat >= REGULATOR_HEAT.shutdownW * (1 - 1e-9)) {
      // Off from here (TRIP_S is a moment): it cools from now on.
      heats.set(comp, { heat, watts: 0, at: now, off: true });
      thermal.set(comp, now + TRIP_S + COOL_S);
      tripped = true;
      warnings.push({ type: "regulator-shutdown", comp, watts: a.watts });
      continue;
    }
    // Woken at the trip — or sooner, to read its watts again (`HEAT_STEP_S`).
    const dt = tripIn(heat, a.watts);
    if (Number.isFinite(dt)) tripAt = Math.min(tripAt ?? Infinity, now + Math.min(dt, HEAT_STEP_S)); // prettier-ignore
    // Hot when it dissipates past the figure at two ticks running: a tick is
    // one instant, and read at one a regulator sits a few millivolts off its
    // target for a moment — amps through its 0.01 Ω, "15 W" for nothing it
    // carries (its heat, above, is what shuts it down).
    if (a.watts > REGULATOR_HEAT.warnW && was?.watts > REGULATOR_HEAT.warnW) {
      warnings.push({ type: "regulator-hot", comp, watts: a.watts, limit: REGULATOR_HEAT.warnW }); // prettier-ignore
    } else if (a.watts > REGULATOR_HEAT.warnW) {
      tripAt = Math.min(tripAt ?? Infinity, now + HOT_RECHECK_S);
    }
    if (a.open) {
      // Its GND wired to nothing: unregulated, OUT up near IN.
      warnings.push({ type: "regulator-open", comp, volts: a.volts });
    } else if (a.limited) {
      warnings.push({ type: "regulator-limit", comp, amps: a.amps });
    } else if (a.dropout) {
      warnings.push({ type: "regulator-dropout", comp, volts: a.volts });
    }
  }
  return { readings, warnings, tripped, tripAt };
}
