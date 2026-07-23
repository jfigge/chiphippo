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
    },
    nets: [
      {
        netId: "n1",
        name: "clock",
        bus: null,
        members: [
          { address: "bb1.a5", label: "74LS00 pin 1 (1A)", kind: "pin" },
          { address: "clk1.out", label: "Clock out", kind: "terminal" },
        ],
        wires: ["w1"],
        isSingleton: false,
      },
      {
        netId: "n2",
        name: null,
        bus: null,
        members: [
          { address: "bb1.a9", label: "74LS00 pin 3 (1Y)", kind: "pin" },
        ],
        wires: ["w2"],
        isSingleton: true,
      },
    ],
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
        detail: ["bb1.a5 → bb2.a5", "bb1.a6 → bb2.a6"],
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
  assert.match(rtf, /Wiring/);
  assert.match(rtf, /Steps/);
});

test("BOM data lands under the BOM head with counts", () => {
  const rtf = planToRtf(samplePlan(), { title: "demo" });
  assert.match(rtf, /Full breadboard/);
  // "×2" — the multiplication sign is a non-ASCII escape (U+00D7 = 215).
  assert.match(rtf, /Full breadboard {2}\\u215\? {0,1}2/);
  assert.match(rtf, /74LS00/);
  assert.match(rtf, /LED \(red\)/);
  assert.match(rtf, /Power supply \(5 V\)/);
});

test("wiring data lists members and flags a singleton net", () => {
  const rtf = planToRtf(samplePlan(), { title: "demo" });
  assert.match(rtf, /74LS00 pin 1 \(1A\)/);
  assert.match(rtf, /Clock out/);
  assert.match(rtf, /clock/);
  assert.match(rtf, /only one connection/);
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
    nets: [],
    steps: [],
    warnings: [],
  };
  const rtf = planToRtf(plan, { title: "demo" });
  assert.match(rtf, /a\\\{b\\\}c\\\\d/);
});

test("an empty plan still produces all three headed sections", () => {
  const rtf = planToRtf({}, { title: "empty" });
  assert.match(rtf, /Nothing on the desk yet\./);
  assert.match(rtf, /No connections yet\./);
  assert.match(rtf, /No build steps yet\./);
});
