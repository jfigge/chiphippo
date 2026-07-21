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

// catalog/index.js — the assembled parts catalog. Later waves (sequential
// chips, MSI parts) concatenate their own def modules here; consumers only
// ever see the exported lists and lookups.

import { CHIPS_GATES } from "./chips-gates.js";
import { CHIPS_SEQ } from "./chips-seq.js";
import { CHIPS_74LS } from "./chips-74ls.js";
import { PART_DEFS } from "./parts.js";

/** Every chip def, in palette display order (combinational gates, then the
    sequential & MSI wave). `kind` is stamped uniformly, and a
    `normalizeParams` that preserves only the `damaged` flag (Feature 90's
    magic-smoke bookkeeping) — chips otherwise carry no params. */
export const CHIP_DEFS = Object.freeze(
  [...CHIPS_GATES, ...CHIPS_SEQ, ...CHIPS_74LS].map((def) =>
    Object.freeze({
      kind: "chip",
      // Only non-default flags are stored, so a plain chip keeps `params: {}`.
      // `rot: 180` is the flipped orientation — same holes, reversed numbering.
      normalizeParams: (raw) => {
        const params = {};
        if (raw?.damaged === true) params.damaged = true;
        if (raw?.rot === 180) params.rot = 180;
        return params;
      },
      ...def,
    }),
  ),
);

/** Chips first, then discrete parts + power — the palette's full listing. */
export const PALETTE_DEFS = Object.freeze([...CHIP_DEFS, ...PART_DEFS]);

const CHIPS_BY_ID = new Map(CHIP_DEFS.map((def) => [def.id, def]));
const ALL_BY_ID = new Map(PALETTE_DEFS.map((def) => [def.id, def]));

/** The chip def for a catalog id, or null (chips only). */
export function chipDef(ref) {
  return CHIPS_BY_ID.get(ref) ?? null;
}

/** The def for ANY catalog id — chip, discrete, or psu — or null. */
export function partDef(ref) {
  return ALL_BY_ID.get(ref) ?? null;
}
