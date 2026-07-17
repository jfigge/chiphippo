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

// footprints.js — pure pin→hole derivation for DIP packages. A DIP-2n seats
// across the trench with the standard counterclockwise numbering, notch LEFT
// (no rotation in v1):
//
//     f:  2n … n+1        ← pins n+1…2n run right→left along row f
//         ┌─────────┐
//       ◖ │  74xx   │      ← notch at the left end
//         └─────────┘
//     e:  1  2  …  n       ← pins 1…n run left→right along row e
//
// Pin 1 sits at the component's ANCHOR hole (always row e); every other pin
// position is DERIVED from the package + anchor column — never stored. All
// DIPs here are 0.3-in row spacing, which the board geometry fixes as rows
// e/f (exactly 3 pitches apart, straddling the single trench).

/** The DIP packages the catalog may reference. */
export const DIP_PACKAGES = Object.freeze({
  "DIP-14": Object.freeze({ pins: 14 }),
  "DIP-16": Object.freeze({ pins: 16 }),
  "DIP-20": Object.freeze({ pins: 20 }),
});

/**
 * The package table entry (throws code INVALID_PACKAGE on junk).
 * @returns {{ pins: number, halfPins: number }}
 */
export function packageSpec(pkg) {
  const p = DIP_PACKAGES[pkg];
  if (!p) {
    const err = new Error(`unknown package: ${pkg}`);
    err.code = "INVALID_PACKAGE";
    throw err;
  }
  return { pins: p.pins, halfPins: p.pins / 2 };
}

/**
 * Row + column offset of one pin relative to the anchor column (pin 1's
 * column). Returns null for a pin number outside the package.
 * @returns {{ row: "e"|"f", dcol: number }|null}
 */
export function pinOffset(pkg, pin) {
  const { pins, halfPins } = packageSpec(pkg);
  if (!Number.isInteger(pin) || pin < 1 || pin > pins) return null;
  return pin <= halfPins
    ? { row: "e", dcol: pin - 1 } // 1…n left→right along e
    : { row: "f", dcol: pins - pin }; // n+1…2n right→left along f
}

/**
 * Every pin's seated hole for a package anchored at `anchorCol` (pin 1's
 * column, row e).
 * @returns {Array<{ pin: number, row: "e"|"f", col: number }>}
 */
export function allPinHoles(pkg, anchorCol) {
  const { pins } = packageSpec(pkg);
  const out = [];
  for (let pin = 1; pin <= pins; pin++) {
    const { row, dcol } = pinOffset(pkg, pin);
    out.push({ pin, row, col: anchorCol + dcol });
  }
  return out;
}
