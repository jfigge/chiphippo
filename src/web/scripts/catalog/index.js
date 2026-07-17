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
// ever see CHIP_DEFS / chipDef().

import { CHIPS_GATES } from "./chips-gates.js";

/** Every chip def, in palette display order. */
export const CHIP_DEFS = Object.freeze([...CHIPS_GATES]);

const BY_ID = new Map(CHIP_DEFS.map((def) => [def.id, def]));

/** The def for a catalog id, or null. */
export function chipDef(ref) {
  return BY_ID.get(ref) ?? null;
}
