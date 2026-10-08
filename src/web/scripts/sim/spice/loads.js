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

// spice/loads.js — what the voltage solve says is asked of the parts that
// carry current, as warnings (features/done/spice-lite.md §4.5). Pure and
// DOM-free.
//
// There is ONE current model: the voltage solve (spice/voltages.js). Every
// input on a net draws what its own stages say (a 74LS input pushes its IIL
// out of a LOW pin and draws its IIH into a HIGH one, spice/params.js
// `inputStages`), every output pushes what its stage can (spice/
// output-stage.js), and the net settles where they balance. So what fan-out
// does to an output is not a sum of datasheet maxima against a rating — it is
// the voltage the net ends up at:
//
//   BROWNOUT  an output (or several, all driving the same way) whose load
//             holds its net where an input on it no longer reads the level
//             it is driving — though it would at the output's own unloaded
//             voltage. A warning only: an output holding too many inputs is
//             a circuit that does not work, not a part in danger. What
//             DAMAGES an output is the current through it, which the solve
//             also measures (`output-current`, spice/params.js
//             `outputLimits`) — and only that lets out the smoke.
//
//   SWITCH    an analog switch channel carrying more than its sheet's ±10 mA
//             (spice/params.js SWITCH_LIMITS): a warning, and past 25 mA
//             brown smoke (the chip is OVERLOADED, latched for the run).
//
//   TRANSISTOR  a discrete transistor past its kind's common current or
//             power limits (spice/params.js TRANSISTOR_LIMITS): a warning,
//             and past the smoke limit a warning that says a real part would
//             have failed. The part carries on: a transistor has no supply
//             to be powered from, so nothing latches it.

/**
 * The warnings in what the voltage solve reports (spice/voltages.js
 * `report`): its brownouts, its switch channels' currents and its
 * transistors' currents and power.
 * @param {{brownouts?: object[], switches?: object[], devices?: object[]}} rep
 * @returns {{loads: Map<string, object>, warnings: object[],
 *   overloaded: Set<string>}} — `loads` keyed `<compId>:<pin>`, one per
 *   output pin in a brownout: `{chip, pin, net, level, volts, inputs,
 *   misread}`; `overloaded` the chips past a smoke limit here.
 */
export function outputLoads({ brownouts = [], switches = [], devices = [] }) {
  const loads = new Map();
  const worst = new Map(); // `${kind}:${part}` → {warning, rank}
  const keep = (key, warning, rank) => {
    const was = worst.get(key);
    if (!was || rank > was.rank) worst.set(key, { warning, rank });
  };
  const overloaded = new Set();

  for (const b of brownouts) {
    loads.set(`${b.comp}:${b.pin}`, {
      chip: b.comp,
      pin: b.pin,
      net: b.net,
      level: b.level,
      volts: b.volts,
      inputs: b.inputs,
      misread: b.misread,
    });
    // One warning per chip — the output whose net is furthest from home.
    const off = b.level === "H" ? -b.volts : b.volts;
    keep(`brownout:${b.comp}`, { type: "brownout", chip: b.comp, pin: b.pin, net: b.net, level: b.level, volts: b.volts, inputs: b.inputs, misread: b.misread }, off); // prettier-ignore
  }

  for (const sw of switches) {
    const ma = sw.amps * 1000;
    if (!(ma > sw.limits.warnMa)) continue;
    const smoke = ma > sw.limits.smokeMa;
    if (smoke) overloaded.add(sw.comp);
    keep(`switch:${sw.comp}`, { type: "switch-current", chip: sw.comp, amps: sw.amps, limit: smoke ? sw.limits.smokeMa : sw.limits.warnMa, smoke }, (smoke ? 1e9 : 0) + ma); // prettier-ignore
  }

  for (const dev of devices) {
    const { limits } = dev;
    const ma = dev.amps * 1000;
    const mw = dev.watts * 1000;
    // Its worst figure against its limits: a current, or its power.
    let found = null;
    for (const [value, warnAt, smokeAt, unit] of [
      [ma, limits.warnMa, limits.smokeMa, "mA"],
      [mw, limits.warnMw, limits.smokeMw, "mW"],
    ]) {
      if (warnAt == null || !(value > warnAt)) continue;
      const smoke = value > smokeAt;
      const rank = (smoke ? 1e9 : 0) + value / warnAt;
      if (!found || rank > found.rank) {
        found = { rank, unit, smoke, limit: smoke ? smokeAt : warnAt };
      }
    }
    if (!found) continue;
    keep(`transistor:${dev.comp}`, { type: "transistor-overload", comp: dev.comp, amps: dev.amps, watts: dev.watts, unit: found.unit, limit: found.limit, smoke: found.smoke }, found.rank); // prettier-ignore
  }

  const warnings = [...worst.values()].map(({ warning }) => warning);
  return { loads, warnings, overloaded };
}
