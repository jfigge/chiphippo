/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// resolve.js — resolve ONE net's level from its drivers, by strength
// precedence (Feature 90). Pure and DOM-free.
//
//   SUPPLY  a PSU terminal on the net: `+` drives H, `−` drives L. Both on
//           one net is a SHORT → X. Supplies beat chip outputs.
//   CHIP    totem-pole chip outputs. All-agreeing → that level; disagreeing →
//           X + a CONFLICT (two outputs fighting). `Z` (a disabled 74125,
//           an undriven pin) contributes nothing.
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
 * @returns {{ level: string, warning?: "short"|"conflict" }}
 */
export function resolveNet({
  supplyPlus = false,
  supplyMinus = false,
  chipLevels = [],
} = {}) {
  // Supply strength dominates.
  if (supplyPlus && supplyMinus) return { level: X, warning: "short" };
  if (supplyPlus) return { level: H };
  if (supplyMinus) return { level: L };

  // Chip outputs: Z contributes nothing; disagreement is a conflict.
  const driven = chipLevels.filter((l) => l !== Z);
  if (driven.length === 0) return { level: Z };
  const distinct = new Set(driven);
  if (distinct.size === 1) return { level: driven[0] };
  return { level: X, warning: "conflict" };
}
