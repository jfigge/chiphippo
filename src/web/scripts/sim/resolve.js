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
//           one net is a SHORT → X. Supplies beat chip outputs.
//   CHIP    totem-pole chip outputs. All-agreeing → that level; disagreeing →
//           X + a CONFLICT (two outputs fighting). `Z` (a disabled 74125,
//           an undriven pin) contributes nothing.
//   PULL    resistors, the WEAKEST tier — a pull-up/pull-down conducts a rail
//           level onto an otherwise-floating net. Any supply or chip driver
//           overrides it; only a clean H/L pulls (Z/X contribute nothing).
//           Opposing pulls (a divider across VCC↔GND) → weak indeterminate X.
//   else    no driver → the net floats: `Z`.
//
// No analog voltages here — voltage matters only at the PSU power checks in
// engine.js. This is the digital abstraction with drive strengths.

import { H, L, Z, X } from "./levels.js";

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
  // Supply strength dominates.
  if (supplyPlus && supplyMinus) return { level: X, warning: "short" };
  if (supplyPlus) return { level: H };
  if (supplyMinus) return { level: L };

  // Chip outputs: Z contributes nothing; disagreement is a conflict.
  const driven = chipLevels.filter((l) => l !== Z);
  if (driven.length > 0) {
    const distinct = new Set(driven);
    if (distinct.size === 1) return { level: driven[0] };
    return { level: X, warning: "conflict" };
  }

  // Weakest tier: resistor pulls decide an otherwise-floating net. Only a
  // clean H/L pulls; agreeing pulls settle the net, opposing pulls (a divider)
  // leave it weakly indeterminate (X, but not a driver "conflict").
  const pulls = pullLevels.filter((l) => l === H || l === L);
  if (pulls.length > 0) {
    return new Set(pulls).size === 1 ? { level: pulls[0] } : { level: X };
  }
  return { level: Z };
}
