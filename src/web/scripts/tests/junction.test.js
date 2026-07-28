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

// The LED junction rule (sim/junction.js). This encodes a PHYSICAL requirement
// rather than a logical one — nothing about the level vocabulary says a diode
// needs a resistor — so it is worth stating in tests exactly where the line
// falls. The catalog blurbs and the user guide both used to claim the opposite
// ("idealized — no series resistor required"), which is how a design could be
// built to the documentation and still burn.

import test from "node:test";
import assert from "node:assert/strict";

import { junctionState, isLit } from "../sim/junction.js";
import { H, L, Z, X } from "../sim/levels.js";

/** The common shape: same levels for drive and strength unless stated. */
const at = (anode, cathode, anodeStrong = anode, cathodeStrong = cathode) =>
  junctionState({ anode, cathode, anodeStrong, cathodeStrong });

test("conducts only on anode H over cathode L", () => {
  assert.equal(at(H, L).conducting, true);
  assert.equal(at(L, L).conducting, false, "no forward voltage");
  assert.equal(at(H, H).conducting, false, "no drop across it");
  assert.equal(at(L, H).conducting, false, "reverse biased");
  assert.equal(at(Z, L).conducting, false, "undriven anode");
  assert.equal(at(H, Z).conducting, false, "undriven cathode");
  assert.equal(at(X, L).conducting, false, "contested anode");
});

test("a leg that resolves to nothing conducts nothing", () => {
  // A floating lead is a legal state — a rail moved out from under it.
  assert.deepEqual(at(null, L), { conducting: false, unlimited: false });
  assert.deepEqual(at(H, undefined), { conducting: false, unlimited: false });
  assert.deepEqual(junctionState(), { conducting: false, unlimited: false });
});

test("strongly driven on BOTH sides is the burn case", () => {
  // Straight across the rails: supply on the anode, ground on the cathode,
  // nothing in between. This is the wiring the docs used to recommend.
  const state = at(H, L);
  assert.equal(state.conducting, true);
  assert.equal(state.unlimited, true, "nothing limits the current");
  assert.equal(isLit(state), false, "a burnt junction never glows");
});

test("a resistor anywhere in the loop makes it safe", () => {
  // A net reached through a resistor is only weakly pulled, so resolve.js
  // reports no STRONG level for it even though the net still settles to L.
  const viaResistor = junctionState({
    anode: H,
    cathode: L,
    anodeStrong: H,
    cathodeStrong: Z, // pulled, not driven
  });
  assert.equal(viaResistor.conducting, true);
  assert.equal(viaResistor.unlimited, false, "the pull is the current limit");
  assert.equal(isLit(viaResistor), true);

  // Symmetric: limiting the anode side works just as well.
  const anodeSide = junctionState({
    anode: H,
    cathode: L,
    anodeStrong: Z,
    cathodeStrong: L,
  });
  assert.equal(anodeSide.unlimited, false);
  assert.equal(isLit(anodeSide), true);
});

test("a junction that isn't conducting is never burnt", () => {
  // `unlimited` is gated on conduction: two strong nets at the SAME level have
  // nothing across the junction, so there is nothing to burn.
  for (const [a, c] of [
    [L, L],
    [H, H],
    [L, H],
  ]) {
    assert.equal(at(a, c).unlimited, false, `${a}/${c} is not a burn case`);
  }
});

test("isLit is the only correct question for a view to ask", () => {
  // Guard against the tempting `state.conducting` shortcut in a renderer: the
  // burn case conducts, and drawing it lit would hide the failure.
  assert.equal(isLit({ conducting: true, unlimited: false }), true);
  assert.equal(isLit({ conducting: true, unlimited: true }), false);
  assert.equal(isLit({ conducting: false, unlimited: false }), false);
  assert.equal(isLit(null), false);
});
