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

// Integrity + contract tests for the discrete/PSU catalog (catalog/parts.js).

import test from "node:test";
import assert from "node:assert/strict";

import {
  LED_COLORS,
  PART_DEFS,
  PSU_VOLTS,
  LCD_SIZES,
  lcdGeometry,
} from "../catalog/parts.js";
import { partDef, chipDef, PALETTE_DEFS } from "../catalog/index.js";
import { packageSpec } from "../model/footprints.js";

test("the part catalog carries the Feature 60 inventory", () => {
  assert.deepEqual(PART_DEFS.map((d) => d.id).sort(), [
    "bar8",
    "bar8iso",
    "clock",
    "lcd",
    "led",
    "psu",
    "resistor",
    "rnet9",
    "seg8",
    "seg8ca",
    "sw-push",
    "sw-slide",
  ]);
  // partDef resolves everything; chipDef stays chips-only.
  assert.ok(partDef("sw-slide"));
  assert.ok(partDef("74LS00"));
  assert.ok(partDef("clock"));
  assert.ok(partDef("lcd"));
  assert.equal(chipDef("sw-slide"), null);
  assert.equal(PALETTE_DEFS.length, 69); // 57 chips (24 + 24 LS + 6 memory + 3 io) + 12 parts
});

for (const def of PART_DEFS.filter((d) => d.kind === "discrete")) {
  test(`part def ${def.id} is internally consistent`, () => {
    assert.ok(def.title.length > 0 && def.blurb.length > 0 && def.group);
    // Geometry: a discrete either lies along ONE grid row (footprint offsets,
    // one per pin, strictly ascending from 0) or straddles the trench in a DIP
    // package (the isolated bar array) — never both.
    if (def.package) {
      assert.ok(!def.footprint, "a DIP-footprint discrete carries no offsets");
      assert.equal(packageSpec(def.package).pins, def.pins.length);
    } else {
      assert.equal(def.footprint.offsets.length, def.pins.length);
      assert.equal(def.footprint.offsets[0], 0);
      for (let i = 1; i < def.footprint.offsets.length; i++) {
        assert.ok(def.footprint.offsets[i] > def.footprint.offsets[i - 1]);
      }
    }
    // Pin numbers unique and 1-based.
    assert.deepEqual(
      def.pins.map((p) => p.n),
      Array.from({ length: def.pins.length }, (_, i) => i + 1),
    );
    // Every bridge references existing pins.
    const pinNumbers = new Set(def.pins.map((p) => p.n));
    for (const state of [undefined, { pressed: true }, { pressed: false }]) {
      for (const params of [
        def.normalizeParams({}),
        def.normalizeParams({ pos: "2" }),
      ]) {
        for (const [a, b] of def.internalBridges(params, state)) {
          assert.ok(pinNumbers.has(a) && pinNumbers.has(b), `${a}-${b}`);
        }
      }
    }
  });
}

test("sw-slide: pos bridges common↔1 or common↔3; params coerce", () => {
  const def = partDef("sw-slide");
  assert.deepEqual(def.internalBridges({ pos: "1" }), [[2, 1]]);
  assert.deepEqual(def.internalBridges({ pos: "2" }), [[2, 3]]);
  assert.deepEqual(def.normalizeParams({ pos: "junk" }), { pos: "1" });
  assert.deepEqual(def.normalizeParams({ pos: "2" }), { pos: "2" });
});

test("sw-push: bridges only while pressed; nothing durable in params", () => {
  const def = partDef("sw-push");
  assert.deepEqual(def.internalBridges({}, { pressed: true }), [[1, 2]]);
  assert.deepEqual(def.internalBridges({}, { pressed: false }), []);
  assert.deepEqual(def.internalBridges({}), []);
  assert.deepEqual(def.normalizeParams({ pressed: true }), {});
});

test("led: color/flip coercion and polarity contract", () => {
  const def = partDef("led");
  assert.deepEqual(def.normalizeParams({}), {
    color: "red",
    flip: false,
    rot: 0,
    end: null,
  });
  assert.deepEqual(def.normalizeParams({ color: "blue", flip: true }), {
    color: "blue",
    flip: true,
    rot: 0,
    end: null,
  });
  // Rotatable like the resistor: rot 90 keeps the far lead's {dx, dy} bend.
  assert.equal(def.rotatable, true);
  assert.equal(def.minSpan, 1); // legs may sit side by side
  assert.deepEqual(def.normalizeParams({ rot: 90, end: { dx: 0, dy: -4 } }), {
    color: "red",
    flip: false,
    rot: 90,
    end: { dx: 0, dy: -4 },
  });
  // A legacy hole-id end, a non-integer bend, and a zero bend are all junk.
  assert.equal(def.normalizeParams({ rot: 90, end: "j7" }).end, null);
  // Rotating a bend negates a component; -0 must not reach the document, or
  // a saved desk stops round-tripping under deepStrictEqual.
  const negZero = def.normalizeParams({ rot: 90, end: { dx: -0, dy: 4 } }).end;
  assert.ok(Object.is(negZero.dx, 0), "dx must be +0, not -0");
  assert.ok(
    Object.is(
      def.normalizeParams({ rot: 90, end: { dx: 4, dy: -0 } }).end.dy,
      0,
    ),
  );
  assert.equal(
    def.normalizeParams({ rot: 90, end: { dx: 1.5, dy: 0 } }).end,
    null,
  );
  assert.equal(
    def.normalizeParams({ rot: 90, end: { dx: 0, dy: 0 } }).end,
    null,
  );
  assert.deepEqual(def.normalizeParams({ color: "pink", flip: "yes" }), {
    color: "red",
    flip: false,
    rot: 0,
    end: null,
  });
  assert.deepEqual(def.polarity({ flip: false }), {
    anodePin: 1,
    cathodePin: 2,
  });
  assert.deepEqual(def.polarity({ flip: true }), {
    anodePin: 2,
    cathodePin: 1,
  });
  assert.deepEqual(def.internalBridges({}), []); // a diode never bridges
  assert.deepEqual(LED_COLORS, ["red", "green", "yellow", "blue"]);
});

test("seg8 / bar8: common-cathode displays, colour + segment contract", () => {
  for (const id of ["seg8", "bar8"]) {
    const def = partDef(id);
    // Nine holes on one row: eight anodes then the shared cathode.
    assert.deepEqual(def.footprint.offsets, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(def.pins.length, 9);
    assert.equal(def.pins[8].role, "cathode"); // pin 9 = common cathode K
    for (let i = 0; i < 8; i++) {
      assert.equal(def.pins[i].role, "anode", `${id} pin ${i + 1}`);
    }
    // Colour coerces to LED_COLORS (default red); junk → red.
    assert.deepEqual(def.normalizeParams({}), { color: "red" });
    assert.deepEqual(def.normalizeParams({ color: "blue" }), { color: "blue" });
    assert.deepEqual(def.normalizeParams({ color: "mauve" }), { color: "red" });
    assert.deepEqual(def.colors, LED_COLORS);
    // Eight segments, each an LED to the shared cathode (pin 9); every anode
    // pin referenced exactly once and every referenced pin exists.
    assert.equal(def.segments.length, 8);
    assert.deepEqual(
      def.segments.map((s) => s.anodePin).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    const pinNumbers = new Set(def.pins.map((p) => p.n));
    for (const seg of def.segments) {
      assert.equal(seg.cathodePin, 9, `${id} ${seg.id} shares the cathode`);
      assert.ok(pinNumbers.has(seg.anodePin) && pinNumbers.has(seg.cathodePin));
    }
    // A display's diodes never hard-bridge (like the LED).
    assert.deepEqual(def.internalBridges(def.normalizeParams({})), []);
  }
});

test("bar8iso: 16-pin DIP, eight isolated bars (own anode + cathode)", () => {
  const def = partDef("bar8iso");
  assert.equal(def.kind, "discrete"); // electrically LEDs, not a chip…
  assert.equal(def.package, "DIP-16"); // …but seats across the trench.
  assert.ok(!def.footprint, "seats by DIP package, not a row footprint");
  assert.equal(def.pins.length, 16);
  // Pins 1–8 are anodes (row e), 9–16 cathodes (row f).
  for (let i = 0; i < 8; i++) assert.equal(def.pins[i].role, "anode");
  for (let i = 8; i < 16; i++) assert.equal(def.pins[i].role, "cathode");
  // Eight bars, each an LED between its OWN anode and cathode — no shared pin.
  // Bar i sits at anode pin i, cathode pin 17-i (directly across the trench).
  assert.equal(def.segments.length, 8);
  const anodes = new Set();
  const cathodes = new Set();
  for (const seg of def.segments) {
    assert.equal(seg.anodePin + seg.cathodePin, 17, `${seg.id} across trench`);
    assert.notEqual(seg.anodePin, seg.cathodePin);
    anodes.add(seg.anodePin);
    cathodes.add(seg.cathodePin);
  }
  assert.equal(anodes.size, 8, "every bar has a distinct anode");
  assert.equal(cathodes.size, 8, "every bar has a distinct cathode");
  // No pin is shared between anode and cathode duty (the point of "isolated").
  for (const a of anodes) assert.ok(!cathodes.has(a));
  // Colour coercion like the other displays; diodes never hard-bridge.
  assert.deepEqual(def.normalizeParams({}), { color: "red" });
  assert.deepEqual(def.normalizeParams({ color: "green" }), { color: "green" });
  assert.deepEqual(def.normalizeParams({ color: "mauve" }), { color: "red" });
  assert.deepEqual(def.colors, LED_COLORS);
  assert.deepEqual(def.internalBridges(def.normalizeParams({})), []);
});

test("resistor: weakly bridges 1↔2, never a hard bridge; ohms coerce", () => {
  const def = partDef("resistor");
  // A resistor is a WEAK coupler: no hard internal bridge (stays two nets)…
  assert.deepEqual(def.internalBridges({ ohms: 220 }), []);
  // …but declares its weakly-coupled pin pair for the simulator's PULL tier.
  assert.deepEqual(def.weakBridges({ ohms: 220 }), [[1, 2]]);
  // Ohms are cosmetic but coerced to a positive number (default 10k); a
  // horizontal resistor carries rot 0 and no far end.
  assert.deepEqual(def.normalizeParams({}), { ohms: 10000, rot: 0, end: null });
  assert.deepEqual(def.normalizeParams({ ohms: 330 }), {
    ohms: 330,
    rot: 0,
    end: null,
  });
  assert.deepEqual(def.normalizeParams({ ohms: -5 }), {
    ohms: 10000,
    rot: 0,
    end: null,
  });
  assert.deepEqual(def.normalizeParams({ ohms: "junk" }), {
    ohms: 10000,
    rot: 0,
    end: null,
  });
  // Rotatable: rot 90 keeps the far lead's {dx, dy} bend; a stray `end`
  // without rot is dropped, and a malformed bend normalizes end→null.
  assert.equal(def.rotatable, true);
  assert.deepEqual(def.normalizeParams({ rot: 90, end: { dx: -5, dy: 4 } }), {
    ohms: 10000,
    rot: 90,
    end: { dx: -5, dy: 4 },
  });
  assert.deepEqual(def.normalizeParams({ end: { dx: -5, dy: 4 } }), {
    ohms: 10000,
    rot: 0,
    end: null,
  });
  // A v1 hole-id end is junk now; the migration converts it before load.
  assert.equal(def.normalizeParams({ rot: 90, end: "j7" }).end, null);
  assert.deepEqual(def.normalizeParams({ rot: 90 }), {
    ohms: 10000,
    rot: 90,
    end: null,
  });
  // Two leads on a 4-hole span (offsets 0 and 3) for the horizontal form.
  assert.deepEqual(def.footprint.offsets, [0, 3]);
});

test("rnet9: bussed array — 8 weak pulls to the common pin, no hard bridge", () => {
  const def = partDef("rnet9");
  assert.equal(def.kind, "discrete");
  // Nine holes on one row; pins 1–8 leads, pin 9 the common bus.
  assert.deepEqual(def.footprint.offsets, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(def.pins.length, 9);
  for (let i = 0; i < 8; i++) assert.equal(def.pins[i].role, "lead");
  assert.equal(def.pins[8].role, "common");
  assert.equal(def.pins[8].name, "COM");
  // Never a hard connection (like the single resistor): the coupling is weak.
  assert.deepEqual(def.internalBridges({ ohms: 220 }), []);
  // Each of pins 1–8 weakly couples to the common bus (pin 9) — eight pulls.
  assert.deepEqual(def.weakBridges({ ohms: 220 }), [
    [1, 9],
    [2, 9],
    [3, 9],
    [4, 9],
    [5, 9],
    [6, 9],
    [7, 9],
    [8, 9],
  ]);
  // Ohms are cosmetic but coerced to a positive number (default 10k).
  assert.deepEqual(def.normalizeParams({}), { ohms: 10000 });
  assert.deepEqual(def.normalizeParams({ ohms: 470 }), { ohms: 470 });
  assert.deepEqual(def.normalizeParams({ ohms: -5 }), { ohms: 10000 });
  assert.deepEqual(def.normalizeParams({ ohms: "junk" }), { ohms: 10000 });
});

test("psu: volts enum, source contract, integer terminal offsets", () => {
  const def = partDef("psu");
  assert.deepEqual(PSU_VOLTS, [3, 5, 12]);
  assert.deepEqual(def.normalizeParams({}), { volts: 5 });
  assert.deepEqual(def.normalizeParams({ volts: 12 }), { volts: 12 });
  assert.deepEqual(def.normalizeParams({ volts: 9 }), { volts: 5 });
  assert.deepEqual(def.source({ volts: 3 }), { plus: 3, minus: 0 });
  assert.deepEqual(
    def.terminals.map((t) => t.id),
    ["+", "-"],
  );
  for (const t of def.terminals) {
    assert.ok(Number.isInteger(t.dx) && Number.isInteger(t.dy), t.id);
    assert.ok(t.dx > 0 && t.dx < def.size.width);
    assert.ok(t.dy > 0 && t.dy < def.size.height);
  }
});

test("lcd: 16-pin brick, size coercion, pins↔terminals in sync", () => {
  const def = partDef("lcd");
  assert.equal(def.kind, "lcd");
  assert.ok(!def.package && !def.footprint); // a brick, not a board part
  // Size coerces to the enum (default 16×2); geometry maps each size.
  assert.deepEqual(LCD_SIZES, ["16x2", "20x4"]);
  assert.deepEqual(def.normalizeParams({}), { size: "16x2" });
  assert.deepEqual(def.normalizeParams({ size: "20x4" }), { size: "20x4" });
  assert.deepEqual(def.normalizeParams({ size: "99x9" }), { size: "16x2" });
  // Magic-smoke persists like a chip.
  assert.deepEqual(def.normalizeParams({ size: "20x4", damaged: true }), {
    size: "20x4",
    damaged: true,
  });
  assert.deepEqual(lcdGeometry("16x2"), { cols: 16, rows: 2 });
  assert.deepEqual(lcdGeometry("20x4"), { cols: 20, rows: 4 });
  // 16 pins and 16 terminals, one terminal per pin, integer offsets inside body.
  assert.equal(def.pins.length, 16);
  assert.equal(def.terminals.length, 16);
  assert.deepEqual(
    def.pins.map((p) => p.n),
    Array.from({ length: 16 }, (_, i) => i + 1),
  );
  const pinNums = new Set(def.pins.map((p) => p.n));
  const termPins = new Set();
  for (const t of def.terminals) {
    assert.ok(pinNums.has(t.pin), `terminal ${t.id} → pin ${t.pin}`);
    termPins.add(t.pin);
    assert.ok(Number.isInteger(t.dx) && Number.isInteger(t.dy), t.id);
    assert.ok(t.dx > 0 && t.dx < def.size.width);
    assert.ok(t.dy > 0 && t.dy < def.size.height);
  }
  assert.equal(termPins.size, 16, "every pin has exactly one terminal");
  // Power roles wire into the sim's power-gating; DB0–7 are the bidirectional
  // bus (io); RS/RW/E are control inputs; V0/A/K are inert.
  const role = (name) => def.pins.find((p) => p.name === name)?.role;
  assert.equal(role("VDD"), "vcc");
  assert.equal(role("VSS"), "gnd");
  assert.equal(role("RS"), "input");
  assert.equal(role("E"), "input");
  assert.equal(role("DB0"), "io");
  assert.equal(role("DB7"), "io");
  assert.equal(role("V0"), "nc");
});
