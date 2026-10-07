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

// engines.js — the seam between the app and its two simulation engines
// (features/spice-lite.md §1). Pure and DOM-free.
//
// Both engines take the same options and return the same result shape;
// Spice Lite adds optional fields (spice/engine.js). The ONE caller that
// chooses is SimController, at Run — everything else that settles a circuit
// (the AI verifier, the desk review, the demo benches, the exports) imports
// sim/engine.js directly, so it is the digital engine whatever the setting
// says, by construction rather than by checking.

import * as digital from "./engine.js";
import * as spice from "./spice/engine.js";
import { normalizeSpiceConfig } from "./spice/config.js";

/** @typedef {{id: string, tick: Function, settle: Function}} Engine */

/** The engines, by id. */
export const ENGINES = Object.freeze({
  digital: Object.freeze({
    id: "digital",
    tick: digital.tick,
    settle: digital.settle,
  }),
  spice: Object.freeze({
    id: spice.ID,
    tick: spice.tick,
    settle: spice.settle,
  }),
});

/**
 * The engine a Spice Lite setting asks for.
 * @param {unknown} config - `settings.spiceLite`, raw or normalized.
 * @returns {Engine}
 */
export function engineFor(config) {
  return normalizeSpiceConfig(config).enabled ? ENGINES.spice : ENGINES.digital;
}
