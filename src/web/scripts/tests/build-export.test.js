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

// Unit tests for the pure build-guide exporter (planToRtf): every tab head is
// present, the data lands under it, RTF specials are escaped, and the wrapper
// is well-formed.

import test from "node:test";
import assert from "node:assert/strict";

import { planToRtf } from "../model/build-export.js";

/** A representative plan touching every branch (with non-ASCII characters). */
function samplePlan() {
  return {
    bom: {
      boards: [{ key: "pins-full", title: "Full breadboard", count: 2 }],
      chips: [{ key: "74LS00", title: "74LS00", count: 1 }],
      discretes: [{ key: "led:red", title: "LED (red)", count: 3 }],
      power: [{ key: "psu:5", title: "Power supply (5 V)", count: 1 }],
      wires: [
        {
          key: "blue:61",
          title: "Jumper wire (blue, 6.1 cm)",
          count: 4,
          item: 2,
        },
      ],
    },
    steps: [
      {
        id: "step:boards:g1",
        group: "boards",
        text: "Assemble a breadboard near column 0, row 0.",
      },
      {
        id: "step:wires:bus1",
        group: "wires",
        text: "Lay the D bus (2 wires).",
        detail: ["[2] bb1.a5 → bb2.a5", "[2] bb1.a6 → bb2.a6"],
      },
    ],
    warnings: [
      { kind: "unpowered-chip", message: "74LS00 (c1) has no VCC connection." },
    ],
  };
}

test("planToRtf emits a well-formed RTF wrapper", () => {
  const rtf = planToRtf(samplePlan(), { title: "demo" });
  assert.match(rtf, /^\{\\rtf1\\ansi/);
  assert.ok(rtf.endsWith("}"), "document closes its root group");
  // Braces balance (a broken group makes the file unreadable in Word/TextEdit).
  let depth = 0;
  for (let i = 0; i < rtf.length; i++) {
    const c = rtf[i];
    if (c === "{" && rtf[i - 1] !== "\\") depth++;
    else if (c === "}" && rtf[i - 1] !== "\\") depth--;
    assert.ok(depth >= 0, "no premature close");
  }
  assert.equal(depth, 0, "every group closes");
});

test("every tab head appears, with the schema name in the title", () => {
  const rtf = planToRtf(samplePlan(), { title: "my-circuit" });
  // The em dash between name and "Build Guide" is escaped (U+2014 = 8212).
  assert.match(rtf, /my-circuit \\u8212\? Build Guide/);
  assert.match(rtf, /BOM/);
  assert.match(rtf, /Steps/);
  // The export MIRRORS the panel's tabs, and there is no Wiring tab: a numbered
  // BOM plus the steps carry the same information.
  assert.doesNotMatch(rtf, /Wiring/);
});

test("BOM data lands under the BOM head with counts", () => {
  const rtf = planToRtf(samplePlan(), { title: "demo" });
  assert.match(rtf, /Full breadboard/);
  // "×2" — the multiplication sign is a non-ASCII escape (U+00D7 = 215).
  assert.match(rtf, /Full breadboard {2}\\u215\? {0,1}2/);
  assert.match(rtf, /74LS00/);
  assert.match(rtf, /LED \(red\)/);
  assert.match(rtf, /Power supply \(5 V\)/);
  // The wires section rides in for free — both readers walk BOM_SECTION_KEYS, so
  // a new section is one catalog entry and never a second list to keep in step.
  assert.match(rtf, /Jumper wire \(blue, 6\.1 cm\)/);
});

test("a wire's BOM line carries the item number its steps call out", () => {
  const rtf = planToRtf(samplePlan(), { title: "demo" });
  // "[2] Jumper wire (blue, 6.1 cm)  ×4" — the callout leads the row, and the
  // same "[2]" appears against the wire in the steps (see the fixture).
  assert.match(rtf, /\[2\] Jumper wire \(blue, 6\.1 cm\)/);
  assert.match(rtf, /\[2\] bb1\.a5/);
  // Nothing else in the BOM is numbered.
  assert.doesNotMatch(rtf, /\[\d\] Full breadboard/);
});

test("steps data appears with detail sub-items", () => {
  const rtf = planToRtf(samplePlan(), { title: "demo" });
  assert.match(rtf, /Assemble a breadboard near column 0, row 0\./);
  assert.match(rtf, /Lay the D bus/);
  // The arrow in a detail line is escaped (U+2192 = 8594).
  assert.match(rtf, /bb1\.a5 \\u8594\? bb2\.a5/);
});

test("RTF control characters in data are escaped", () => {
  const plan = {
    bom: { boards: [], chips: [{ key: "x", title: "a{b}c\\d", count: 1 }] },
    steps: [],
    warnings: [],
  };
  const rtf = planToRtf(plan, { title: "demo" });
  assert.match(rtf, /a\\\{b\\\}c\\\\d/);
});

test("an empty plan still produces both headed sections", () => {
  const rtf = planToRtf({}, { title: "empty" });
  assert.match(rtf, /Nothing on the desk yet\./);
  assert.match(rtf, /No build steps yet\./);
});
