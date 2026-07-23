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

// Symbol integrity (Feature 150): every catalog chip derives a logical symbol,
// and every stub of that symbol maps back onto real def pins — the symbol is
// data + this validation, exactly like the footprint and behavior layers.

import test from "node:test";
import assert from "node:assert/strict";

import { CHIP_DEFS } from "../catalog/index.js";
import { buildSymbol, symbolFor, symbolStubs } from "../catalog/symbols.js";

/** Expand a stub to the def-pin numbers it represents. */
function stubPins(stub) {
  return stub.kind === "bus" ? stub.pins : [stub.pin];
}

test("every catalog chip has a logical symbol", () => {
  for (const def of CHIP_DEFS) {
    assert.ok(symbolFor(def.id), `${def.id} symbol`);
  }
  assert.equal(symbolFor("nope"), null);
});

for (const def of CHIP_DEFS) {
  test(`symbol ${def.id} maps to real pins`, () => {
    const symbol = symbolFor(def.id);
    const realPins = new Set(def.pins.map((p) => p.n));
    const ncPins = new Set(
      def.pins.filter((p) => p.role === "nc").map((p) => p.n),
    );

    // Identity fields.
    assert.equal(symbol.id, def.id);
    assert.equal(symbol.label, def.id);
    assert.ok(symbol.title.length > 0);

    // Every stub pin is a REAL functional (non-NC) pin, claimed exactly once.
    const claimed = new Map(); // pin → times seen
    for (const stub of symbolStubs(symbol)) {
      for (const pin of stubPins(stub)) {
        assert.ok(realPins.has(pin), `${def.id} stub pin ${pin} not real`);
        assert.ok(!ncPins.has(pin), `${def.id} stub pin ${pin} is NC`);
        claimed.set(pin, (claimed.get(pin) ?? 0) + 1);
      }
    }
    for (const [pin, n] of claimed) {
      assert.equal(n, 1, `${def.id} pin ${pin} claimed ${n}×`);
    }

    // Every functional pin appears; NC pins are omitted.
    const functional = def.pins
      .filter((p) => p.role !== "nc")
      .map((p) => p.n)
      .sort((a, b) => a - b);
    assert.deepEqual(
      [...claimed.keys()].sort((a, b) => a - b),
      functional,
      `${def.id} covers every functional pin`,
    );

    // Power on the correct edges: every VCC pin top, every GND pin bottom, and
    // nowhere else (a memory part may carry the datasheet's duplicate VSS).
    const bySide = (role) =>
      def.pins
        .filter((p) => p.role === role)
        .map((p) => p.n)
        .sort((a, b) => a - b);
    assert.deepEqual(
      symbol.sides.top.map((s) => s.pin).sort((a, b) => a - b),
      bySide("vcc"),
      `${def.id} VCC on top`,
    );
    assert.deepEqual(
      symbol.sides.bottom.map((s) => s.pin).sort((a, b) => a - b),
      bySide("gnd"),
      `${def.id} GND on bottom`,
    );
  });
}

test("a pinGroups bus collapses to ONE stub on the direction's side", () => {
  const def = CHIP_DEFS.find((d) => d.id === "74LS573"); // D in (left), Q out (right)
  assert.ok(def.pinGroups?.length, "fixture has pin groups");
  const symbol = symbolFor(def.id);

  const dGroup = def.pinGroups.find((g) => g.name === "D");
  const qGroup = def.pinGroups.find((g) => g.name === "Q");

  const dStub = symbol.sides.left.find((s) => s.kind === "bus");
  const qStub = symbol.sides.right.find((s) => s.kind === "bus");
  assert.deepEqual(dStub.pins, dGroup.pins); // one stub, whole run, bit order
  assert.equal(dStub.role, "input");
  assert.deepEqual(qStub.pins, qGroup.pins);
  assert.equal(qStub.role, "output");

  // Exactly one bus stub per group — the run never expands into per-pin stubs.
  const busStubs = symbolStubs(symbol).filter((s) => s.kind === "bus");
  assert.equal(busStubs.length, def.pinGroups.length);
});

test("an io bus (transceiver) lands on the left as an io stub", () => {
  const symbol = symbolFor("74LS245");
  const ioBuses = symbolStubs(symbol).filter(
    (s) => s.kind === "bus" && s.role === "io",
  );
  assert.equal(ioBuses.length, 2); // A and B octets
  for (const b of ioBuses) assert.equal(b.side, "left");
});

test("gate chips carry a distinctive glyph; MSI/sequential parts do not", () => {
  assert.equal(symbolFor("74LS00").glyph, "NAND");
  assert.equal(symbolFor("74LS08").glyph, "AND");
  assert.equal(symbolFor("74LS32").glyph, "OR");
  assert.equal(symbolFor("74LS86").glyph, "XOR");
  assert.equal(symbolFor("74LS04").glyph, "NOT");
  assert.equal(symbolFor("74LS02").glyph, "NOR");
  assert.equal(symbolFor("74LS125").glyph, "BUFFER");
  // A decoder (COMB units) and a flip-flop (sequential) are plain boxes.
  assert.equal(symbolFor("74LS138").glyph, null);
  assert.equal(symbolFor("74LS74").glyph, null);
});

test("buildSymbol is deterministic", () => {
  const def = CHIP_DEFS.find((d) => d.id === "74LS161");
  assert.deepEqual(buildSymbol(def), buildSymbol(def));
});

test("discretes get distinctive-shape symbols with pin terminals", () => {
  const led = symbolFor("led");
  assert.equal(led.kind, "shape");
  assert.equal(led.shape, "led");
  assert.deepEqual(
    led.terminals.map((t) => t.pin),
    [1, 2],
  );

  assert.equal(symbolFor("resistor").shape, "resistor");

  const sw = symbolFor("sw-slide");
  assert.equal(sw.shape, "switch");
  assert.equal(sw.terminals.length, 3); // common + two throws
  assert.equal(symbolFor("sw-push").shape, "button");
  assert.equal(symbolFor("sw-toggle").shape, "button");
});

test("PSU and clock bricks get source symbols keyed by terminal id", () => {
  const psu = symbolFor("psu");
  assert.equal(psu.kind, "shape");
  assert.equal(psu.shape, "psu");
  assert.deepEqual(
    psu.terminals.map((t) => t.terminal),
    ["+", "-"],
  );

  const clk = symbolFor("clock");
  assert.equal(clk.shape, "clock");
  assert.deepEqual(
    clk.terminals.map((t) => t.terminal),
    ["out", "gnd"],
  );
});

test("a many-pinned display renders as a labelled box", () => {
  const seg = symbolFor("seg8");
  assert.equal(seg.kind, "box");
  assert.equal(seg.sides.left.length, 8, "eight segment anodes on the left");
  assert.ok(
    seg.sides.right.some((s) => s.name === "K"),
    "the common cathode on the right",
  );
});
