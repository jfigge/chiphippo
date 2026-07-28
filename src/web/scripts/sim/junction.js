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

// junction.js — the one rule every light-emitting junction on the desk obeys:
// does it conduct, and is anything limiting the current when it does?
//
// This is NOT a logic-world requirement. Nothing about AND gates or netlists
// says a diode needs a resistor; the levels alone would happily light an LED
// wired straight across the rails. It is a PHYSICAL requirement of building
// the thing on a real breadboard, and Chip Hippo models real breadboards — so
// it lives here, in the model, rather than in the view that happens to draw
// the smoke. A part's catalog entry declares its geometry and its electrical
// contract; this declares what physics does to it.
//
// The rule, in the terms the resolver already gives us:
//
//   conducting  the anode's net is H and the cathode's net is L
//   unlimited   …and BOTH of those are STRONG — driven by a supply rail or a
//               chip output rather than pulled through a resistor
//
// `unlimited` is the burn case. A junction across two strongly driven nets has
// nothing to drop the voltage across, which on a bench is how you let the smoke
// out of an LED. Put a resistor anywhere in the loop and the pulled side is no
// longer strong (resolve.js reports pulls separately from drives), so
// `unlimited` goes false and the part simply lights.
//
// The consequence worth stating plainly, because the catalog blurbs used to
// claim the opposite: an LED whose cathode reaches a supply rail DOES need a
// series resistor. "Idealized" only ever held for a junction that wasn't
// strongly driven on both sides.

import { H, L } from "./levels.js";

/**
 * The lit / over-driven state of ONE junction.
 *
 * Levels are the H/L/Z/X vocabulary; `null`/`undefined` means the leg resolved
 * to nothing (a floating lead, or a pin with no address), which conducts
 * nothing — exactly as a real one does when you pull its rail away.
 *
 * @param {object}  levels
 * @param {string?} levels.anode          resolved level of the anode's net
 * @param {string?} levels.cathode        resolved level of the cathode's net
 * @param {string?} levels.anodeStrong    anode level from supplies/outputs ALONE
 * @param {string?} levels.cathodeStrong  cathode level from supplies/outputs ALONE
 * @returns {{ conducting: boolean, unlimited: boolean }}
 */
export function junctionState({
  anode,
  cathode,
  anodeStrong,
  cathodeStrong,
} = {}) {
  const conducting = anode === H && cathode === L;
  const unlimited = conducting && anodeStrong === H && cathodeStrong === L;
  return { conducting, unlimited };
}

/**
 * Whether a junction in this state should be drawn glowing. A burnt junction
 * never glows however the levels read — the one place `conducting` alone is
 * the wrong question to ask.
 */
export function isLit(state) {
  return Boolean(state?.conducting && !state.unlimited);
}
