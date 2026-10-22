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

// resolve.js — resolve ONE net's level from its drivers, by strength
// precedence (Feature 90). Pure and DOM-free.
//
//   SUPPLY  a PSU terminal on the net: `+` drives H, `−` drives L. Both on
//           one net is a SHORT → X. Supplies beat chip outputs (an output
//           driving the other way is a CONFLICT all the same).
//   CHIP    totem-pole chip outputs. All-agreeing → that level; disagreeing →
//           X + a CONFLICT (two outputs fighting). `Z` (a disabled 74125,
//           an undriven pin) contributes nothing; an open-collector output
//           at X (`OC_X`) loses to a LOW and makes anything else X.
//   PULL    resistors, the WEAKEST tier — a pull-up/pull-down conducts a
//           level onto an otherwise-floating net. Any supply or chip driver
//           overrides it; a Z pulls nothing, an X pulls X where no H or L
//           pulls beside it (2026-10-22: it was nothing, and the net read
//           floating; counted against an H it latched a resistor feedback
//           loop at X for good). Opposing pulls (a divider across VCC↔GND)
//           → weak indeterminate X.
//   else    no driver → the net floats: `Z`.
//
// No analog voltages here — voltage matters only at the PSU power checks in
// engine.js. This is the digital abstraction with drive strengths.

import { H, L, Z, X, OC_X } from "./levels.js";

/**
 * @param {object} drivers
 * @param {boolean} [drivers.supplyPlus]  a PSU `+` terminal is on this net
 * @param {boolean} [drivers.supplyMinus] a PSU `−` terminal is on this net
 * @param {string[]} [drivers.chipLevels] chip-output levels driven onto it
 * @param {string[]} [drivers.pullLevels] resistor-conducted levels (weakest);
 *   engine.js fills these from each resistor's OTHER end's strong level.
 * @returns {{ level: string, warning?: "short"|"conflict" }}
 */
export function resolveNet({
  supplyPlus = false,
  supplyMinus = false,
  chipLevels = [],
  pullLevels = [],
} = {}) {
  // Supply strength dominates — but an output driving the other way on it
  // is fighting the supply, and says so (a 74LS04's LOW wired to the + rail,
  // or fed it through a diode, smokes its output; it was silent).
  if (supplyPlus && supplyMinus) return { level: X, warning: "short" };
  if (supplyPlus) return chipLevels.includes(L) ? { level: H, warning: "conflict" } : { level: H }; // prettier-ignore
  if (supplyMinus) return chipLevels.includes(H) ? { level: L, warning: "conflict" } : { level: L }; // prettier-ignore

  // Chip outputs: Z contributes nothing; disagreement is a conflict. An
  // open-collector output that may sink (`OC_X`) loses to a LOW beside it —
  // any LOW pulls a wired-AND down — and leaves anything else unknown.
  const maybe = chipLevels.includes(OC_X);
  const driven = chipLevels.filter((l) => l !== Z && l !== OC_X);
  if (driven.length > 0) {
    const distinct = new Set(driven);
    if (distinct.size > 1) return { level: X, warning: "conflict" };
    return { level: maybe && driven[0] !== L ? X : driven[0] };
  }
  if (maybe) return { level: X };

  // Weakest tier: resistor pulls decide an otherwise-floating net. Agreeing
  // pulls settle the net; opposing pulls (a divider) leave it weakly
  // indeterminate (X, but not a driver "conflict"); and an unknown level
  // through a resistor is unknown here too — read as nothing pulling, a 74LS
  // input behind it read a clean HIGH and a CD4000 one was told it floated.
  // But only where nothing definite pulls beside it: an X against an H is
  // the net's own feedback more often than not (a Schmitt trigger's 100 k
  // from its output, against 10 k from its input), and counted, the X it
  // made pulled itself X for good — no input ever cleared it. Weighed so,
  // it reads as it did before an X pulled at all. A Z pull is nothing.
  const definite = pullLevels.filter((l) => l === H || l === L);
  if (definite.length > 0) {
    return new Set(definite).size === 1 ? { level: definite[0] } : { level: X }; // prettier-ignore
  }
  if (pullLevels.includes(X)) return { level: X };
  return { level: Z };
}
