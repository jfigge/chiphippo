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

import { LED_COLORS, PART_DEFS, PSU_VOLTS } from "../catalog/parts.js";
import { partDef, chipDef, PALETTE_DEFS } from "../catalog/index.js";

test("the part catalog carries the Feature 60 inventory", () => {
  assert.deepEqual(PART_DEFS.map((d) => d.id).sort(), [
    "clock",
    "led",
    "psu",
    "resistor",
    "sw-push",
    "sw-slide",
  ]);
  // partDef resolves everything; chipDef stays chips-only.
  assert.ok(partDef("sw-slide"));
  assert.ok(partDef("7400"));
  assert.ok(partDef("clock"));
  assert.equal(chipDef("sw-slide"), null);
  assert.equal(PALETTE_DEFS.length, 32); // 26 chips + 6 parts
});

for (const def of PART_DEFS.filter((d) => d.kind === "discrete")) {
  test(`part def ${def.id} is internally consistent`, () => {
    assert.ok(def.title.length > 0 && def.blurb.length > 0 && def.group);
    // One footprint offset per pin, strictly ascending from 0.
    assert.equal(def.footprint.offsets.length, def.pins.length);
    assert.equal(def.footprint.offsets[0], 0);
    for (let i = 1; i < def.footprint.offsets.length; i++) {
      assert.ok(def.footprint.offsets[i] > def.footprint.offsets[i - 1]);
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
  // Rotatable like the resistor: rot 90 keeps the far-end hole.
  assert.equal(def.rotatable, true);
  assert.equal(def.minSpan, 1); // legs may sit side by side
  assert.deepEqual(def.normalizeParams({ rot: 90, end: "j7" }), {
    color: "red",
    flip: false,
    rot: 90,
    end: "j7",
  });
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
  // Rotatable: rot 90 keeps the far-end hole; a stray `end` without rot is
  // dropped, and a rotated part with a non-string end normalizes end→null.
  assert.equal(def.rotatable, true);
  assert.deepEqual(def.normalizeParams({ rot: 90, end: "j7" }), {
    ohms: 10000,
    rot: 90,
    end: "j7",
  });
  assert.deepEqual(def.normalizeParams({ end: "j7" }), {
    ohms: 10000,
    rot: 0,
    end: null,
  });
  assert.deepEqual(def.normalizeParams({ rot: 90 }), {
    ohms: 10000,
    rot: 90,
    end: null,
  });
  // Two leads on a 4-hole span (offsets 0 and 3) for the horizontal form.
  assert.deepEqual(def.footprint.offsets, [0, 3]);
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
